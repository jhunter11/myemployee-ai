import { resolve } from 'node:path';
import process from 'node:process';

import { z } from 'zod';

import { createDatabase } from '../db/database';
import { ModelUsageRepository } from '../db/model-usage-repository';
import {
  ModelExecutionEnablementService,
  ModelExecutionSurfaceSchema,
  SqliteModelExecutionEnablementRepository,
  type ModelExecutionSurface
} from '../economics/model-execution-enablement';
import type { ModelRouteInput } from '../economics/contracts';
import { ClientIdSchema } from '../config/schemas';
import type { ModelGenerationRequest } from './contracts';
import { createModelTurnCoordinator } from './factory';
import { ProviderRateLimitCircuit } from './provider-rate-limit-circuit';
import {
  DEFAULT_MODEL_CLI_IO,
  ModelCliError,
  isRoutePreset,
  parseFlags,
  routeInputForPreset,
  type ModelCliIo
} from './runtime-cli-support';

const DEFAULT_SYSTEM =
  'You are a Jarvis runtime probe. Answer the operator briefly and factually. You have no tools and no live data access.';
const MAX_REPLY_CHARS = 8_000;

export interface ModelRunTurnParams {
  projectRoot: string;
  databaseFile: string;
  surface: ModelExecutionSurface;
  clientId: string | null;
  route: ModelRouteInput;
  generation: ModelGenerationRequest;
}

export interface ModelRunCliDeps {
  runTurn(params: ModelRunTurnParams): Promise<unknown>;
}

const DEFAULT_DEPS: ModelRunCliDeps = {
  async runTurn(params) {
    const database = await createDatabase({
      projectRoot: params.projectRoot,
      filename: params.databaseFile
    });
    try {
      const enablement = new ModelExecutionEnablementService({
        repository: new SqliteModelExecutionEnablementRepository(database.sqlite)
      });
      await enablement.initialize();
      const coordinator = createModelTurnCoordinator({
        usage: new ModelUsageRepository(database.db),
        enablement,
        surface: params.surface,
        clientId: params.clientId,
        rateLimitCircuit: new ProviderRateLimitCircuit(database.sqlite)
      });
      return await coordinator.execute({ route: params.route, generation: params.generation });
    } finally {
      await database.destroy();
    }
  }
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractReply(outcome: Record<string, unknown>): string | null {
  if (outcome.status !== 'executed') return null;
  const execution = object(outcome.execution);
  if (execution === null || execution.status !== 'succeeded') return null;
  const result = object(execution.result);
  const text = result?.text;
  if (typeof text !== 'string') return null;
  return text.trim().slice(0, MAX_REPLY_CHARS);
}

function summarize(outcome: Record<string, unknown>): Record<string, unknown> {
  const execution = object(outcome.execution);
  const summary: Record<string, unknown> = {
    status: outcome.status ?? 'unknown',
    tier: outcome.tier ?? null,
    route: outcome.route ?? null,
    enablementVersion: outcome.enablementVersion ?? null,
    reasons: Array.isArray(outcome.reasons) ? outcome.reasons : []
  };
  if (execution !== null) {
    summary.execution = {
      status: execution.status ?? 'unknown',
      provider: execution.provider ?? null,
      model: object(execution.result)?.model ?? execution.model ?? null,
      usageEventId: execution.usageEventId ?? null,
      attempts: Array.isArray(execution.attempts)
        ? execution.attempts.map((attempt) => {
            const entry = object(attempt);
            return {
              provider: entry?.provider ?? null,
              status: entry?.status ?? null,
              detail: entry?.detail ?? null
            };
          })
        : []
    };
  }
  return summary;
}

const PositiveIntSchema = z.coerce.number().int().min(1);

function parseInteger(
  value: string | undefined,
  fallback: number,
  code: string,
  max: number
): number {
  if (value === undefined) return fallback;
  const parsed = PositiveIntSchema.safeParse(value);
  if (!parsed.success || parsed.data > max) {
    throw new ModelCliError(code, `Value must be an integer between 1 and ${max}`);
  }
  return parsed.data;
}

function toErrorPayload(error: unknown): string {
  if (error instanceof z.ZodError) {
    return JSON.stringify({
      error: {
        code: 'INVALID_RUN_INPUT',
        message: 'Model run input failed validation',
        issues: error.issues.slice(0, 20).map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      }
    });
  }
  if (error instanceof ModelCliError) {
    return JSON.stringify({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof Error) {
    return JSON.stringify({ error: { code: 'MODEL_RUN_FAILED', message: error.message } });
  }
  return JSON.stringify({ error: { code: 'MODEL_RUN_FAILED', message: 'Unknown failure' } });
}

export async function runModelRunCli(
  argv: readonly string[] = process.argv.slice(2),
  io: ModelCliIo = DEFAULT_MODEL_CLI_IO,
  deps: ModelRunCliDeps = DEFAULT_DEPS
): Promise<number> {
  try {
    const parsed = parseFlags(argv, {
      boolean: ['--json'],
      value: [
        '--message',
        '--route',
        '--surface',
        '--client',
        '--system',
        '--max-output-tokens',
        '--timeout-ms',
        '--db',
        '--project-root'
      ]
    });

    const message = parsed.values.get('--message');
    if (message === undefined || message.trim().length === 0) {
      throw new ModelCliError('MISSING_MESSAGE', '--message <text> is required');
    }

    const routeName = parsed.values.get('--route') ?? 'local';
    if (!isRoutePreset(routeName)) {
      throw new ModelCliError('INVALID_ROUTE', 'Use --route local | economy | frontier');
    }
    const route = routeInputForPreset(routeName);

    const surfaceParsed = ModelExecutionSurfaceSchema.safeParse(
      parsed.values.get('--surface') ?? 'automation'
    );
    if (!surfaceParsed.success) {
      throw new ModelCliError('INVALID_SURFACE', 'Use --surface web | telegram | automation');
    }

    const clientRaw = parsed.values.get('--client');
    let clientId: string | null = null;
    if (clientRaw !== undefined) {
      const clientParsed = ClientIdSchema.safeParse(clientRaw);
      if (!clientParsed.success)
        throw new ModelCliError('INVALID_CLIENT', 'Invalid --client scope');
      clientId = clientParsed.data;
    }

    const generation: ModelGenerationRequest = {
      system: parsed.values.get('--system') ?? DEFAULT_SYSTEM,
      messages: [{ role: 'user', content: message }],
      maxOutputTokens: parseInteger(
        parsed.values.get('--max-output-tokens'),
        512,
        'INVALID_MAX_OUTPUT_TOKENS',
        4_096
      ),
      timeoutMs: parseInteger(
        parsed.values.get('--timeout-ms'),
        60_000,
        'INVALID_TIMEOUT_MS',
        120_000
      )
    };

    const projectRoot = resolve(parsed.values.get('--project-root') ?? process.cwd());
    const databaseFile = resolve(parsed.values.get('--db') ?? `${projectRoot}/data/jarvis.sqlite`);

    const rawOutcome = await deps.runTurn({
      projectRoot,
      databaseFile,
      surface: surfaceParsed.data,
      clientId,
      route,
      generation
    });

    const outcome = object(rawOutcome);
    if (outcome === null)
      throw new ModelCliError('INVALID_OUTCOME', 'Coordinator returned no outcome');
    const summary = summarize(outcome);
    const reply = extractReply(outcome);

    if (parsed.booleans.has('--json')) {
      io.stdout(JSON.stringify({ ...summary, reply }));
    } else {
      io.stdout(JSON.stringify(summary));
      if (reply !== null) {
        io.stdout('');
        io.stdout(reply);
      }
    }
    return reply !== null || summary.status === 'executed' ? 0 : 2;
  } catch (error) {
    io.stderr(toErrorPayload(error));
    return 1;
  }
}

if (require.main === module) {
  void runModelRunCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
