import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';

import type { HealthProvider, HealthResult } from '../gateway/app';
import { runWithDeadline } from '../utils/deadline';

const OLLAMA_TAGS_URL = 'http://127.0.0.1:11434/api/tags';
const DEFAULT_TIMEOUT_MS = 5_000;
const COMMAND_MAX_BUFFER_BYTES = 64 * 1024;

export interface HeartbeatProbes {
  gateway(): Promise<void>;
  database(): Promise<void>;
  ollama(): Promise<void>;
  docker(): Promise<void>;
  diskFreePercent(): Promise<number>;
}

export interface HeartbeatOptions {
  probes: HeartbeatProbes;
  now?: () => string;
  timeoutMs?: number;
}

export interface CommandOptions {
  timeout: number;
  maxBuffer: number;
  windowsHide: true;
  shell: false;
}

export type CommandRunner = (
  executable: string,
  arguments_: string[],
  options: CommandOptions
) => Promise<void>;

export interface StatFsResult {
  blocks: bigint;
  bavail: bigint;
}

export type StatFsReader = (path: string, options: { bigint: true }) => Promise<StatFsResult>;

export type HeartbeatFetch = (
  url: string,
  init: { signal: AbortSignal }
) => Promise<{ ok: boolean }>;

export interface ProductionHeartbeatOptions {
  projectRoot: string;
  databaseCheck(): Promise<void>;
  fetchImpl?: HeartbeatFetch;
  runCommand?: CommandRunner;
  readStatFs?: StatFsReader;
  now?: () => string;
  timeoutMs?: number;
}

interface ProbeDefinition {
  name: 'gateway' | 'database' | 'ollama' | 'docker';
  failure: string;
  failedStatus: string;
  run(): Promise<void>;
}

type DiskOutcome = { available: true; freePercent: number } | { available: false };

function defaultRunCommand(
  executable: string,
  arguments_: string[],
  options: CommandOptions
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(executable, arguments_, options, (error) => {
      if (error === null) {
        resolve();
      } else {
        reject(new Error('Command execution failed', { cause: error }));
      }
    });
  });
}

const defaultReadStatFs: StatFsReader = async (path, options) => {
  const result = await statfs(path, options);
  return { blocks: result.blocks, bavail: result.bavail };
};

function diskFreePercent(result: StatFsResult): number {
  if (result.blocks <= 0n || result.bavail < 0n || result.bavail > result.blocks) {
    throw new Error('Filesystem capacity is invalid');
  }

  return Number((result.bavail * 100n) / result.blocks);
}

function normalizeDiskFreePercent(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError('Disk free percentage must be between zero and one hundred');
  }
  return Math.floor(value);
}

export class Heartbeat implements HealthProvider {
  private readonly now: () => string;
  private readonly timeoutMs: number;

  constructor(private readonly options: HeartbeatOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be a finite positive number');
    }
    this.timeoutMs = Math.ceil(timeoutMs);
  }

  async check(): Promise<HealthResult> {
    const checks: Record<string, string> = {};
    const failures: string[] = [];
    const probes: ProbeDefinition[] = [
      {
        name: 'gateway',
        failure: 'gateway_down',
        failedStatus: 'down',
        run: () => this.options.probes.gateway()
      },
      {
        name: 'database',
        failure: 'database_down',
        failedStatus: 'down',
        run: () => this.options.probes.database()
      },
      {
        name: 'ollama',
        failure: 'ollama_unreachable',
        failedStatus: 'unreachable',
        run: () => this.options.probes.ollama()
      },
      {
        name: 'docker',
        failure: 'docker_down',
        failedStatus: 'down',
        run: () => this.options.probes.docker()
      }
    ];

    const probeOutcomes = Promise.all(
      probes.map(async (probe) => {
        try {
          await runWithDeadline(
            () => probe.run(),
            this.timeoutMs,
            'Heartbeat probe exceeded its deadline'
          );
          return false;
        } catch {
          return true;
        }
      })
    );
    const diskOutcome: Promise<DiskOutcome> = (async () => {
      try {
        return {
          available: true,
          freePercent: normalizeDiskFreePercent(
            await runWithDeadline(
              () => this.options.probes.diskFreePercent(),
              this.timeoutMs,
              'Heartbeat disk probe exceeded its deadline'
            )
          )
        };
      } catch {
        return { available: false };
      }
    })();
    const [probeFailures, disk] = await Promise.all([probeOutcomes, diskOutcome]);

    for (const [index, probe] of probes.entries()) {
      if (probeFailures[index] === false) {
        checks[probe.name] = 'ok';
      } else {
        checks[probe.name] = probe.failedStatus;
        failures.push(probe.failure);
      }
    }

    if (disk.available) {
      if (disk.freePercent < 10) {
        checks.disk = `critical:${disk.freePercent}%_free`;
        failures.push('disk_low');
      } else {
        checks.disk = `ok:${disk.freePercent}%_free`;
      }
    } else {
      checks.disk = 'unavailable';
      failures.push('disk_unavailable');
    }

    const healthy = failures.length === 0;
    return {
      timestamp: this.now(),
      overall: healthy ? 'healthy' : 'degraded',
      severity: healthy ? 'none' : 'P1',
      checks,
      failures,
      action: healthy ? 'none' : 'escalate_P1'
    };
  }
}

export function createProductionHeartbeat(options: ProductionHeartbeatOptions): Heartbeat {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a finite positive number');
  }
  const boundedTimeoutMs = Math.ceil(timeoutMs);
  const fetchImpl: HeartbeatFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const runCommand = options.runCommand ?? defaultRunCommand;
  const readStatFs = options.readStatFs ?? defaultReadStatFs;

  return new Heartbeat({
    probes: {
      gateway: () => Promise.resolve(),
      database: () => options.databaseCheck(),
      async ollama() {
        const response = await fetchImpl(OLLAMA_TAGS_URL, {
          signal: AbortSignal.timeout(boundedTimeoutMs)
        });
        if (!response.ok) {
          throw new Error('Ollama returned a non-success response');
        }
      },
      docker: () =>
        runCommand('docker', ['info', '--format', '{{.ServerVersion}}'], {
          timeout: boundedTimeoutMs,
          maxBuffer: COMMAND_MAX_BUFFER_BYTES,
          windowsHide: true,
          shell: false
        }),
      async diskFreePercent() {
        return diskFreePercent(await readStatFs(options.projectRoot, { bigint: true }));
      }
    },
    now: options.now,
    timeoutMs: boundedTimeoutMs
  });
}
