import { resolve } from 'node:path';
import process from 'node:process';

import { z } from 'zod';

import { createDatabase } from '../db/database';
import {
  ModelExecutionEnablementService,
  ModelExecutionProviderSchema,
  ModelExecutionSurfaceSchema,
  SqliteModelExecutionEnablementRepository,
  type ModelExecutionEnablement
} from '../economics/model-execution-enablement';
import {
  DEFAULT_MODEL_CLI_IO,
  ModelCliError,
  parseFlags,
  splitList,
  type ModelCliIo
} from './runtime-cli-support';

const SUBCOMMANDS = ['status', 'enable', 'disable'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

interface EnablementRepositoryHandle {
  service: ModelExecutionEnablementService;
  destroy(): Promise<void>;
}

export interface ModelEnablementCliDeps {
  openService(options: {
    projectRoot: string;
    databaseFile: string;
  }): Promise<EnablementRepositoryHandle>;
}

const DEFAULT_DEPS: ModelEnablementCliDeps = {
  async openService({ projectRoot, databaseFile }) {
    const database = await createDatabase({ projectRoot, filename: databaseFile });
    const service = new ModelExecutionEnablementService({
      repository: new SqliteModelExecutionEnablementRepository(database.sqlite)
    });
    await service.initialize();
    return { service, destroy: () => database.destroy() };
  }
};

function present(record: ModelExecutionEnablement): Record<string, unknown> {
  return {
    enabled: record.enabled,
    version: record.version,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
    reason: record.reason,
    approver: record.approver,
    approvedAt: record.approvedAt,
    allowedTiers: record.allowedTiers,
    allowedSurfaces: record.allowedSurfaces,
    allowedProviders: record.allowedProviders
  };
}

const TierArgSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

function parseTiers(raw: string | undefined): (1 | 2 | 3)[] {
  return splitList(raw).map((entry) => {
    const parsed = TierArgSchema.safeParse(Number(entry));
    if (!parsed.success)
      throw new ModelCliError('INVALID_TIER', `Invalid tier: ${entry} (use 1, 2, or 3)`);
    return parsed.data;
  });
}

function parseEnumList<T extends string>(
  raw: string | undefined,
  schema: z.ZodType<T>,
  code: string
): T[] {
  return splitList(raw).map((entry) => {
    const parsed = schema.safeParse(entry);
    if (!parsed.success) throw new ModelCliError(code, `Invalid value: ${entry}`);
    return parsed.data;
  });
}

function requireValue(values: Map<string, string>, flag: string, code: string): string {
  const value = values.get(flag);
  if (value === undefined) throw new ModelCliError(code, `${flag} is required`);
  return value;
}

function toErrorPayload(error: unknown): string {
  if (error instanceof z.ZodError) {
    return JSON.stringify({
      error: {
        code: 'INVALID_ENABLEMENT_INPUT',
        message: 'Enablement input failed validation',
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
    return JSON.stringify({ error: { code: 'ENABLEMENT_COMMAND_FAILED', message: error.message } });
  }
  return JSON.stringify({
    error: { code: 'ENABLEMENT_COMMAND_FAILED', message: 'Unknown failure' }
  });
}

export async function runModelEnablementCli(
  argv: readonly string[] = process.argv.slice(2),
  io: ModelCliIo = DEFAULT_MODEL_CLI_IO,
  deps: ModelEnablementCliDeps = DEFAULT_DEPS
): Promise<number> {
  const parsed = parseFlags(argv, {
    value: [
      '--db',
      '--project-root',
      '--approver',
      '--updated-by',
      '--reason',
      '--tiers',
      '--surfaces',
      '--providers'
    ]
  });
  const subcommand = parsed.positional[0] ?? 'status';
  if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    io.stderr(
      JSON.stringify({
        error: { code: 'UNKNOWN_SUBCOMMAND', message: `Use one of: ${SUBCOMMANDS.join(', ')}` }
      })
    );
    return 1;
  }

  const projectRoot = resolve(parsed.values.get('--project-root') ?? process.cwd());
  const databaseFile = resolve(parsed.values.get('--db') ?? `${projectRoot}/data/jarvis.sqlite`);

  let handle: EnablementRepositoryHandle | undefined;
  try {
    handle = await deps.openService({ projectRoot, databaseFile });
    const record = await runSubcommand(subcommand as Subcommand, handle.service, parsed.values);
    io.stdout(JSON.stringify({ ...present(record), databaseFile }));
    return 0;
  } catch (error) {
    io.stderr(toErrorPayload(error));
    return 1;
  } finally {
    if (handle !== undefined) await handle.destroy();
  }
}

async function runSubcommand(
  subcommand: Subcommand,
  service: ModelExecutionEnablementService,
  values: Map<string, string>
): Promise<ModelExecutionEnablement> {
  if (subcommand === 'status') {
    return service.current();
  }
  const current = await service.current();
  if (subcommand === 'enable') {
    return service.enable({
      approver: requireValue(values, '--approver', 'MISSING_APPROVER'),
      reason: requireValue(values, '--reason', 'MISSING_REASON'),
      allowedTiers: parseTiers(values.get('--tiers')),
      allowedSurfaces: parseEnumList(
        values.get('--surfaces'),
        ModelExecutionSurfaceSchema,
        'INVALID_SURFACE'
      ),
      allowedProviders: parseEnumList(
        values.get('--providers'),
        ModelExecutionProviderSchema,
        'INVALID_PROVIDER'
      ),
      expectedVersion: current.version
    });
  }
  return service.disable({
    updatedBy: requireValue(values, '--updated-by', 'MISSING_UPDATED_BY'),
    reason: requireValue(values, '--reason', 'MISSING_REASON'),
    expectedVersion: current.version
  });
}

if (require.main === module) {
  void runModelEnablementCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
