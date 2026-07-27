import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { z } from 'zod';

import {
  planFacelessUploadSession,
  type FacelessUploadSessionPlan
} from './faceless-content-workflow';
import { renderUploadSessionSheet } from './upload-session-sheet';

const MAX_SUMMARY_BYTES = 8_192;

export interface FacelessSessionCliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

const DEFAULT_IO: FacelessSessionCliIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`)
};

const DEFAULT_POLICY = {
  sessionMinutes: 60,
  signInMinutes: 2,
  uploadMinutes: 6,
  verifyMinutes: 2,
  signOutMinutes: 1,
  requireSignOut: true,
  maxAccountsPerSession: 8,
  maxUploadsPerAccount: 3
} as const;

const ValueFlags = [
  '--queue',
  '--portfolio',
  '--policy',
  '--start',
  '--session-id',
  '--request-id',
  '--out'
] as const;

type ValueFlag = (typeof ValueFlags)[number];

interface ParsedArguments {
  queuePath: string;
  portfolioPath: string;
  policyPath: string | undefined;
  sessionStart: string;
  sessionId: string | undefined;
  requestId: string | undefined;
  outPath: string | undefined;
  print: boolean;
}

class CliError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'CliError';
  }
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const values = new Map<ValueFlag, string>();
  let print = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === '--print') {
      print = true;
      continue;
    }
    if (!ValueFlags.includes(argument as ValueFlag)) {
      throw new CliError('UNSUPPORTED_ARGUMENT', `Unsupported argument: ${sanitizeFlag(argument)}`);
    }
    const flag = argument as ValueFlag;
    if (values.has(flag)) throw new CliError('DUPLICATE_ARGUMENT', `Duplicate argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CliError('MISSING_VALUE', `Argument ${flag} requires a direct value`);
    }
    index += 1;
    values.set(flag, value);
  }

  const queuePath = values.get('--queue');
  const portfolioPath = values.get('--portfolio');
  const sessionStart = values.get('--start');
  if (queuePath === undefined) throw new CliError('MISSING_QUEUE', '--queue <file> is required');
  if (portfolioPath === undefined) {
    throw new CliError('MISSING_PORTFOLIO', '--portfolio <file> is required');
  }
  if (sessionStart === undefined) {
    throw new CliError('MISSING_START', '--start <iso-datetime> is required');
  }

  return {
    queuePath,
    portfolioPath,
    policyPath: values.get('--policy'),
    sessionStart,
    sessionId: values.get('--session-id'),
    requestId: values.get('--request-id'),
    outPath: values.get('--out'),
    print
  };
}

function sanitizeFlag(argument: string): string {
  const trimmed = argument.slice(0, 40);
  return /^--[a-z-]+$/u.test(trimmed) ? trimmed : 'non-flag-token';
}

async function readJson(path: string, code: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(resolve(path), 'utf8');
  } catch {
    throw new CliError(code, `Could not read ${path}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError(`${code}_JSON`, `${path} is not valid JSON`);
  }
}

function extractQueue(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw;
  if (raw !== null && typeof raw === 'object' && 'queue' in raw) {
    return raw.queue;
  }
  return raw;
}

function defaultSessionId(sessionStart: string): string {
  const day = sessionStart.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(day) ? `session-${day}` : 'session-upload';
}

function summarize(plan: FacelessUploadSessionPlan, sheetPath: string): string {
  const summary = {
    sessionId: plan.sessionId,
    requestId: plan.requestId,
    sheetPath,
    sessionState: plan.sessionState,
    totals: plan.totals,
    deferred: plan.deferred,
    rejected: plan.rejected,
    boundaries: plan.boundaries
  };
  const encoded = JSON.stringify(summary);
  if (Buffer.byteLength(encoded, 'utf8') <= MAX_SUMMARY_BYTES) return encoded;
  return JSON.stringify({
    sessionId: plan.sessionId,
    sheetPath,
    sessionState: plan.sessionState,
    totals: plan.totals,
    note: 'deferred and rejected detail omitted; read the sheet'
  });
}

function toErrorPayload(error: unknown): string {
  if (error instanceof z.ZodError) {
    return JSON.stringify({
      error: {
        code: 'INVALID_SESSION_INPUT',
        message: 'The queue, portfolio, or policy failed schema validation',
        issues: error.issues.slice(0, 20).map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      }
    });
  }
  if (error instanceof CliError) {
    return JSON.stringify({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof Error) {
    return JSON.stringify({ error: { code: 'SESSION_PLAN_FAILED', message: error.message } });
  }
  return JSON.stringify({ error: { code: 'SESSION_PLAN_FAILED', message: 'Unknown failure' } });
}

export async function runFacelessSessionCli(
  argv: readonly string[] = process.argv.slice(2),
  io: FacelessSessionCliIo = DEFAULT_IO
): Promise<number> {
  try {
    const options = parseArguments(argv);
    const queue = extractQueue(await readJson(options.queuePath, 'QUEUE_UNREADABLE'));
    const portfolio = await readJson(options.portfolioPath, 'PORTFOLIO_UNREADABLE');
    const policy =
      options.policyPath === undefined
        ? DEFAULT_POLICY
        : await readJson(options.policyPath, 'POLICY_UNREADABLE');

    const sessionId = options.sessionId ?? defaultSessionId(options.sessionStart);
    const command = {
      command: 'plan_upload_session',
      // The derived default is length-bounded so a long (but valid) --session-id
      // cannot push the prepended requestId past the 96-char slug maximum.
      requestId: options.requestId ?? `request-${sessionId}`.slice(0, 96),
      sessionId,
      sessionStart: options.sessionStart,
      portfolio,
      queue,
      policy
    };

    const plan = planFacelessUploadSession(command);
    const sheet = renderUploadSessionSheet(plan);
    const sheetPath = resolve(options.outPath ?? `${plan.sessionId}.md`);
    await writeFile(sheetPath, sheet, 'utf8');

    if (options.print) io.stdout(sheet);
    io.stdout(summarize(plan, sheetPath));
    return 0;
  } catch (error) {
    io.stderr(toErrorPayload(error));
    return 1;
  }
}

if (require.main === module) {
  void runFacelessSessionCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
