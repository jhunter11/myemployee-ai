import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import process from 'node:process';

import SQLite from 'better-sqlite3';
import { z } from 'zod';

import type { DowntimeAdmissionSnapshot } from './downtime-admission';

export const SCOUT_READINESS_URL = 'http://127.0.0.1:3000/readyz' as const;
export const SCOUT_HID_COMMAND = Object.freeze({
  executable: '/usr/sbin/ioreg',
  arguments: Object.freeze(['-c', 'IOHIDSystem', '-r', '-d', '1'] as const)
});
export const SCOUT_LIVE_ENV = Object.freeze({
  enabled: 'TASK_MARKET_SCOUT_ENABLED',
  taskMarketExecutionActive: 'TASK_MARKET_EXECUTION_ACTIVE',
  quietPeriodMs: 'TASK_MARKET_SCOUT_QUIET_PERIOD_MS',
  requestsUsed: 'TASK_MARKET_SCOUT_REQUESTS_USED',
  requestsLimit: 'TASK_MARKET_SCOUT_REQUESTS_LIMIT',
  responsesUsed: 'TASK_MARKET_SCOUT_RESPONSES_USED',
  responsesLimit: 'TASK_MARKET_SCOUT_RESPONSES_LIMIT'
});

const MAX_EVIDENCE_AGE_MS = 60_000;
const MAX_FUTURE_EVIDENCE_SKEW_MS = 5_000;
const MAX_QUIET_PERIOD_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_QUIET_PERIOD_MS = 5 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 30_000;
const READINESS_MAX_BODY_BYTES = 16 * 1_024;
const COMMAND_MAX_BUFFER_BYTES = 16 * 1_024;
const MAX_QUOTA = 1_000_000_000;
const MAX_COUNT = 1_000_000;

const QUEUE_COUNTS_SQL = `
SELECT
  COALESCE(SUM(CASE WHEN policy_band = 'P0' AND state = 'queued' THEN 1 ELSE 0 END), 0) AS p0Ready,
  COALESCE(SUM(CASE WHEN policy_band = 'P0' AND state = 'leased' THEN 1 ELSE 0 END), 0) AS p0Leased,
  COALESCE(SUM(CASE WHEN policy_band = 'P1' AND state = 'queued' THEN 1 ELSE 0 END), 0) AS p1Ready,
  COALESCE(SUM(CASE WHEN policy_band = 'P1' AND state = 'leased' THEN 1 ELSE 0 END), 0) AS p1Leased
FROM work_queue_tasks
WHERE policy_band IN ('P0', 'P1') AND state IN ('queued', 'leased')
`;
const ACTIVE_CLIENT_EXECUTIONS_SQL = `
SELECT COUNT(*) AS activeClientExecutions
FROM agent_runs
WHERE status IN ('pending', 'running')
`;

const TimestampSchema = z.iso.datetime({ offset: true });
const BoundedReadinessValueSchema = z.string().min(1).max(64);
const ReadinessBodySchema = z.strictObject({
  timestamp: TimestampSchema,
  status: z.enum(['ready', 'not_ready']),
  checks: z.strictObject({
    gateway: BoundedReadinessValueSchema,
    database: BoundedReadinessValueSchema,
    disk: BoundedReadinessValueSchema
  }),
  failures: z
    .array(z.enum(['gateway_down', 'database_down', 'disk_low', 'disk_unavailable']))
    .max(8)
});
const QueueCountsSchema = z.strictObject({
  p0Ready: z.number().int().min(0).max(MAX_COUNT),
  p0Leased: z.number().int().min(0).max(MAX_COUNT),
  p1Ready: z.number().int().min(0).max(MAX_COUNT),
  p1Leased: z.number().int().min(0).max(MAX_COUNT)
});
const ActiveExecutionsSchema = z.strictObject({
  activeClientExecutions: z.number().int().min(0).max(MAX_COUNT)
});

export interface ScoutCommandOptions {
  timeout: number;
  maxBuffer: number;
  windowsHide: true;
  shell: false;
  encoding: 'utf8';
}

export type ScoutCommandRunner = (
  executable: string,
  arguments_: string[],
  options: ScoutCommandOptions
) => Promise<{ stdout: string }>;

export interface ReadonlyScoutDatabase {
  prepare(sql: string): { get(): unknown };
  close(): void;
}

export type OpenReadonlyScoutDatabase = (
  filename: string,
  options: { readonly: true; fileMustExist: true }
) => ReadonlyScoutDatabase;

export interface ScoutStatFsResult {
  blocks: bigint;
  bavail: bigint;
}

export type ScoutStatFsReader = (
  path: string,
  options: { bigint: true }
) => Promise<ScoutStatFsResult>;

export interface ScoutLiveSignalsOptions {
  projectRoot: string;
  databaseFile?: string;
  environment: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
  runCommand?: ScoutCommandRunner;
  openReadonlyDatabase?: OpenReadonlyScoutDatabase;
  readStatFs?: ScoutStatFsReader;
  clock?: () => Date;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

interface ReadinessSignal {
  coreReadiness: 'green' | 'red' | 'unknown';
  diskFreePercent: number | null;
}

interface DatabaseSignal {
  priorityWork: DowntimeAdmissionSnapshot['priorityWork'];
  clientActive: boolean;
}

interface HidSignal {
  hostCapability: 'healthy' | 'unknown';
  lastActivityAt: string | null;
}

const UNKNOWN_DATABASE_SIGNAL: DatabaseSignal = Object.freeze({
  priorityWork: Object.freeze({ p0Ready: 1, p0Leased: 1, p1Ready: 1, p1Leased: 1 }),
  clientActive: true
});

function defaultRunCommand(
  executable: string,
  arguments_: string[],
  options: ScoutCommandOptions
): Promise<{ stdout: string }> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(executable, arguments_, options, (error, stdout) => {
      if (error !== null) {
        rejectCommand(new Error('Scout command failed', { cause: error }));
        return;
      }
      resolveCommand({ stdout });
    });
  });
}

function defaultOpenReadonlyDatabase(
  filename: string,
  options: { readonly: true; fileMustExist: true }
): ReadonlyScoutDatabase {
  const database = new SQLite(filename, options);
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return { get: () => statement.get() };
    },
    close: () => database.close()
  };
}

const defaultReadStatFs: ScoutStatFsReader = async (path, options) => {
  const result = await statfs(path, options);
  return { blocks: result.blocks, bavail: result.bavail };
};

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

function safeEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined {
  try {
    return environment[name];
  } catch {
    return undefined;
  }
}

function exactUnsignedInteger(raw: string | undefined, maximum: number): number | null {
  if (raw === undefined || !/^(?:0|[1-9][0-9]{0,9})$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= maximum ? value : null;
}

function quotaState(
  environment: Readonly<Record<string, string | undefined>>,
  usedName: string,
  limitName: string
): { used: number; limit: number } {
  const used = exactUnsignedInteger(safeEnvironmentValue(environment, usedName), MAX_QUOTA);
  const limit = exactUnsignedInteger(safeEnvironmentValue(environment, limitName), MAX_QUOTA);
  if (used === null || limit === null || limit < 1) {
    return { used: 1, limit: 1 };
  }
  return { used, limit };
}

function parseDiskCheck(value: string): number | null {
  const match = /^(?:ok|critical):([0-9]{1,3}(?:\.[0-9]{1,2})?)%_free$/.exec(value);
  if (match?.[1] === undefined) {
    return null;
  }
  const percentage = Number(match[1]);
  return Number.isFinite(percentage) && percentage >= 0 && percentage <= 100 ? percentage : null;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]{0,9})$/.test(contentLength)) {
      throw new Error('Readiness content length is invalid');
    }
    if (Number(contentLength) > READINESS_MAX_BODY_BYTES) {
      throw new Error('Readiness response is too large');
    }
  }
  if (response.body === null) {
    throw new Error('Readiness response body is unavailable');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > READINESS_MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new Error('Readiness response is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}

async function fixedReadinessFetch(
  fetchImplementation: typeof globalThis.fetch,
  timeoutMs: number
): Promise<{ response: Response; body: string }> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new Error('Readiness request timed out'));
    }, timeoutMs);
  });
  const request = Promise.resolve().then(async () => {
    const response = await fetchImplementation(SCOUT_READINESS_URL, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: controller.signal
    });
    return { response, body: await readBoundedResponse(response) };
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

async function captureReadiness(
  fetchImplementation: typeof globalThis.fetch,
  timeoutMs: number,
  capturedAtMs: number
): Promise<ReadinessSignal> {
  try {
    const { response, body } = await fixedReadinessFetch(fetchImplementation, timeoutMs);
    if (response.status !== 200 && response.status !== 503) {
      return { coreReadiness: 'unknown', diskFreePercent: null };
    }
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return { coreReadiness: 'unknown', diskFreePercent: null };
    }
    const decoded = JSON.parse(body) as unknown;
    const parsed = ReadinessBodySchema.safeParse(decoded);
    if (!parsed.success) {
      return { coreReadiness: 'unknown', diskFreePercent: null };
    }
    const evidenceAgeMs = capturedAtMs - Date.parse(parsed.data.timestamp);
    if (evidenceAgeMs < -MAX_FUTURE_EVIDENCE_SKEW_MS || evidenceAgeMs > MAX_EVIDENCE_AGE_MS) {
      return { coreReadiness: 'unknown', diskFreePercent: null };
    }

    const diskFreePercent = parseDiskCheck(parsed.data.checks.disk);
    if (parsed.data.status === 'ready') {
      const isGreen =
        response.status === 200 &&
        parsed.data.failures.length === 0 &&
        parsed.data.checks.gateway === 'ok' &&
        parsed.data.checks.database === 'ok' &&
        diskFreePercent !== null;
      return {
        coreReadiness: isGreen ? 'green' : 'unknown',
        diskFreePercent: isGreen ? diskFreePercent : null
      };
    }
    return {
      coreReadiness: response.status === 503 ? 'red' : 'unknown',
      diskFreePercent
    };
  } catch {
    return { coreReadiness: 'unknown', diskFreePercent: null };
  }
}

function captureDatabase(
  openReadonlyDatabase: OpenReadonlyScoutDatabase,
  databaseFile: string
): DatabaseSignal {
  let database: ReadonlyScoutDatabase | undefined;
  let outcome: DatabaseSignal = UNKNOWN_DATABASE_SIGNAL;
  try {
    database = openReadonlyDatabase(databaseFile, { readonly: true, fileMustExist: true });
    const priorityWork = QueueCountsSchema.parse(database.prepare(QUEUE_COUNTS_SQL).get());
    const active = ActiveExecutionsSchema.parse(
      database.prepare(ACTIVE_CLIENT_EXECUTIONS_SQL).get()
    );
    outcome = {
      priorityWork,
      clientActive: active.activeClientExecutions > 0
    };
  } catch {
    outcome = UNKNOWN_DATABASE_SIGNAL;
  } finally {
    if (database !== undefined) {
      try {
        database.close();
      } catch {
        outcome = UNKNOWN_DATABASE_SIGNAL;
      }
    }
  }
  return outcome;
}

async function captureHidIdle(
  runCommand: ScoutCommandRunner,
  platform: NodeJS.Platform,
  timeoutMs: number,
  capturedAtMs: number
): Promise<HidSignal> {
  if (platform !== 'darwin') {
    return { hostCapability: 'unknown', lastActivityAt: null };
  }
  try {
    const result = await runCommand(
      SCOUT_HID_COMMAND.executable,
      [...SCOUT_HID_COMMAND.arguments],
      {
        timeout: timeoutMs,
        maxBuffer: COMMAND_MAX_BUFFER_BYTES,
        windowsHide: true,
        shell: false,
        encoding: 'utf8'
      }
    );
    if (
      typeof result.stdout !== 'string' ||
      Buffer.byteLength(result.stdout, 'utf8') > COMMAND_MAX_BUFFER_BYTES
    ) {
      return { hostCapability: 'unknown', lastActivityAt: null };
    }
    const matches = [...result.stdout.matchAll(/"HIDIdleTime"\s*=\s*([0-9]{1,20})(?![0-9])/gu)];
    if (matches.length !== 1 || matches[0]?.[1] === undefined) {
      return { hostCapability: 'unknown', lastActivityAt: null };
    }
    const idleMilliseconds = BigInt(matches[0][1]) / 1_000_000n;
    if (idleMilliseconds > BigInt(capturedAtMs)) {
      return { hostCapability: 'unknown', lastActivityAt: null };
    }
    const lastActivityAtMs = capturedAtMs - Number(idleMilliseconds);
    if (!Number.isSafeInteger(lastActivityAtMs)) {
      return { hostCapability: 'unknown', lastActivityAt: null };
    }
    return {
      hostCapability: 'healthy',
      lastActivityAt: new Date(lastActivityAtMs).toISOString()
    };
  } catch {
    return { hostCapability: 'unknown', lastActivityAt: null };
  }
}

async function captureDisk(readStatFs: ScoutStatFsReader, projectRoot: string): Promise<number> {
  try {
    const result = await readStatFs(projectRoot, { bigint: true });
    if (result.blocks <= 0n || result.bavail < 0n || result.bavail > result.blocks) {
      return 0;
    }
    return Number((result.bavail * 10_000n) / result.blocks) / 100;
  } catch {
    return 0;
  }
}

class ProductionScoutLiveSignals {
  private readonly projectRoot: string;
  private readonly databaseFile: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly runCommand: ScoutCommandRunner;
  private readonly openReadonlyDatabase: OpenReadonlyScoutDatabase;
  private readonly readStatFs: ScoutStatFsReader;
  private readonly clock: () => Date;
  private readonly platform: NodeJS.Platform;
  private readonly timeoutMs: number;

  public constructor(private readonly options: ScoutLiveSignalsOptions) {
    if (!isAbsolute(options.projectRoot)) {
      throw new Error('Scout projectRoot must be absolute');
    }
    this.projectRoot = resolve(options.projectRoot);
    const projectDatabaseFile = join(this.projectRoot, 'data', 'jarvis.sqlite');
    const requestedDatabaseFile = options.databaseFile ?? projectDatabaseFile;
    const desktopDatabaseSuffix = join(
      'Library',
      'Application Support',
      'Jarvis',
      'state',
      'jarvis.sqlite'
    );
    if (
      !isAbsolute(requestedDatabaseFile) ||
      resolve(requestedDatabaseFile) !== requestedDatabaseFile ||
      (requestedDatabaseFile !== projectDatabaseFile &&
        !requestedDatabaseFile.endsWith(`${sep}${desktopDatabaseSuffix}`))
    ) {
      throw new Error('Scout databaseFile must be a fixed Jarvis database path');
    }
    this.databaseFile = requestedDatabaseFile;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.openReadonlyDatabase = options.openReadonlyDatabase ?? defaultOpenReadonlyDatabase;
    this.readStatFs = options.readStatFs ?? defaultReadStatFs;
    this.clock = options.clock ?? (() => new Date());
    this.platform = options.platform ?? process.platform;
    this.timeoutMs = boundedInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      1,
      MAX_TIMEOUT_MS,
      'timeoutMs'
    );
  }

  public async capture(): Promise<DowntimeAdmissionSnapshot> {
    const capturedAt = this.clock();
    const capturedAtMs = capturedAt.getTime();
    if (Number.isNaN(capturedAtMs)) {
      throw new Error('Scout signal clock returned an invalid date');
    }

    const [readiness, database, hid] = await Promise.all([
      captureReadiness(this.fetchImplementation, this.timeoutMs, capturedAtMs),
      Promise.resolve(captureDatabase(this.openReadonlyDatabase, this.databaseFile)),
      captureHidIdle(this.runCommand, this.platform, this.timeoutMs, capturedAtMs)
    ]);
    const diskFreePercent =
      readiness.diskFreePercent ?? (await captureDisk(this.readStatFs, this.projectRoot));
    const parsedQuietPeriodMs = exactUnsignedInteger(
      safeEnvironmentValue(this.options.environment, SCOUT_LIVE_ENV.quietPeriodMs),
      MAX_QUIET_PERIOD_MS
    );
    const quietPeriodMs =
      parsedQuietPeriodMs !== null && parsedQuietPeriodMs >= 1 ? parsedQuietPeriodMs : null;
    const taskMarketExecutionState = safeEnvironmentValue(
      this.options.environment,
      SCOUT_LIVE_ENV.taskMarketExecutionActive
    );

    return {
      schemaVersion: 1,
      capturedAt: capturedAt.toISOString(),
      maxEvidenceAgeMs: MAX_EVIDENCE_AGE_MS,
      killSwitchEnabled:
        safeEnvironmentValue(this.options.environment, SCOUT_LIVE_ENV.enabled) === 'true',
      coreReadiness: readiness.coreReadiness,
      diskFreePercent,
      priorityWork: database.priorityWork,
      execution: {
        clientActive: database.clientActive,
        taskMarketActive: taskMarketExecutionState === 'false' ? false : true
      },
      foreground: {
        lastActivityAt: quietPeriodMs === null ? null : hid.lastActivityAt,
        quietPeriodMs: quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS
      },
      hostCapability: hid.hostCapability,
      quotas: {
        requests: quotaState(
          this.options.environment,
          SCOUT_LIVE_ENV.requestsUsed,
          SCOUT_LIVE_ENV.requestsLimit
        ),
        responses: quotaState(
          this.options.environment,
          SCOUT_LIVE_ENV.responsesUsed,
          SCOUT_LIVE_ENV.responsesLimit
        )
      }
    };
  }
}

export function createProductionScoutLiveSignals(options: ScoutLiveSignalsOptions): {
  capture(): Promise<DowntimeAdmissionSnapshot>;
} {
  return new ProductionScoutLiveSignals(options);
}
