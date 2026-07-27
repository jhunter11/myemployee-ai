import { describe, expect, it, vi } from 'vitest';

import { evaluateDowntimeAdmission } from '../../src/task-market/downtime-admission';
import {
  SCOUT_HID_COMMAND,
  SCOUT_LIVE_ENV,
  SCOUT_READINESS_URL,
  createProductionScoutLiveSignals
} from '../../src/task-market/scout-live-signals';
import type {
  ReadonlyScoutDatabase,
  ScoutCommandRunner,
  ScoutLiveSignalsOptions
} from '../../src/task-market/scout-live-signals';

const PROJECT_ROOT = '/fixed/jarvis';
const NOW = '2026-07-20T15:00:00.000Z';

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    [SCOUT_LIVE_ENV.enabled]: 'true',
    [SCOUT_LIVE_ENV.taskMarketExecutionActive]: 'false',
    [SCOUT_LIVE_ENV.quietPeriodMs]: '300000',
    [SCOUT_LIVE_ENV.requestsUsed]: '2',
    [SCOUT_LIVE_ENV.requestsLimit]: '10',
    [SCOUT_LIVE_ENV.responsesUsed]: '3',
    [SCOUT_LIVE_ENV.responsesLimit]: '10',
    ...overrides
  };
}

function readyBody(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: NOW,
    status: 'ready',
    checks: { gateway: 'ok', database: 'ok', disk: 'ok:42%_free' },
    failures: [],
    ...overrides
  };
}

function readyResponse(value: unknown = readyBody(), status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function database(
  queue = { p0Ready: 0, p0Leased: 0, p1Ready: 0, p1Leased: 0 },
  activeClientExecutions = 0
) {
  const prepare = vi.fn((sql: string) => ({
    get: vi.fn(() => (sql.includes('work_queue_tasks') ? queue : { activeClientExecutions }))
  }));
  const close = vi.fn();
  return { database: { prepare, close } satisfies ReadonlyScoutDatabase, prepare, close };
}

function validDependencies(
  overrides: Partial<ScoutLiveSignalsOptions> = {}
): ScoutLiveSignalsOptions & {
  fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  runCommand: ReturnType<typeof vi.fn<ScoutCommandRunner>>;
  openReadonlyDatabase: ReturnType<typeof vi.fn>;
  readStatFs: ReturnType<typeof vi.fn>;
} {
  const db = database();
  return {
    projectRoot: PROJECT_ROOT,
    environment: environment(),
    platform: 'darwin',
    clock: () => new Date(NOW),
    timeoutMs: 1_000,
    fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(readyResponse()),
    runCommand: vi
      .fn<ScoutCommandRunner>()
      .mockResolvedValue({ stdout: '    | |     "HIDIdleTime" = 600000000000\n' }),
    openReadonlyDatabase: vi.fn().mockReturnValue(db.database),
    readStatFs: vi.fn().mockResolvedValue({ blocks: 1000n, bavail: 250n }),
    ...overrides
  } as ScoutLiveSignalsOptions & {
    fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
    runCommand: ReturnType<typeof vi.fn<ScoutCommandRunner>>;
    openReadonlyDatabase: ReturnType<typeof vi.fn>;
    readStatFs: ReturnType<typeof vi.fn>;
  };
}

describe('createProductionScoutLiveSignals fixed boundaries', () => {
  it('captures strict readiness, read-only queue state, fixed HID idle, and exact quota state', async () => {
    const db = database();
    const options = validDependencies({
      databaseFile: '/Users/test/Library/Application Support/Jarvis/state/jarvis.sqlite',
      environment: environment({
        READY_URL: 'https://evil.test/readyz',
        DB_PATH: '/tmp/evil.sqlite',
        PROJECT_ROOT: '/tmp/evil'
      }),
      openReadonlyDatabase: vi.fn().mockReturnValue(db.database)
    });

    const snapshot = await createProductionScoutLiveSignals(options).capture();

    expect(snapshot).toEqual({
      schemaVersion: 1,
      capturedAt: NOW,
      maxEvidenceAgeMs: 60_000,
      killSwitchEnabled: true,
      coreReadiness: 'green',
      diskFreePercent: 42,
      priorityWork: { p0Ready: 0, p0Leased: 0, p1Ready: 0, p1Leased: 0 },
      execution: { clientActive: false, taskMarketActive: false },
      foreground: {
        lastActivityAt: '2026-07-20T14:50:00.000Z',
        quietPeriodMs: 300_000
      },
      hostCapability: 'healthy',
      quotas: {
        requests: { used: 2, limit: 10 },
        responses: { used: 3, limit: 10 }
      }
    });
    expect(options.fetch).toHaveBeenCalledWith(
      SCOUT_READINESS_URL,
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        headers: { accept: 'application/json' }
      })
    );
    expect(options.fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(options.openReadonlyDatabase).toHaveBeenCalledWith(
      '/Users/test/Library/Application Support/Jarvis/state/jarvis.sqlite',
      {
        readonly: true,
        fileMustExist: true
      }
    );
    expect(options.runCommand).toHaveBeenCalledWith(
      SCOUT_HID_COMMAND.executable,
      [...SCOUT_HID_COMMAND.arguments],
      {
        timeout: 1_000,
        maxBuffer: 16 * 1_024,
        windowsHide: true,
        shell: false,
        encoding: 'utf8'
      }
    );
    expect(options.readStatFs).not.toHaveBeenCalled();
    expect(db.close).toHaveBeenCalledOnce();
    expect(db.prepare).toHaveBeenCalledTimes(2);
    for (const [sql] of db.prepare.mock.calls) {
      expect(sql).toMatch(/^\s*SELECT\b/iu);
      expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA)\b/iu);
    }
  });

  it('rejects a non-absolute or non-normalized operator-bound database path', () => {
    for (const databaseFile of [
      'state/jarvis.sqlite',
      '/fixed/live/../other/jarvis.sqlite',
      '/fixed/live/state/not-jarvis.db',
      '/fixed/live/state/jarvis.sqlite'
    ]) {
      expect(() => createProductionScoutLiveSignals(validDependencies({ databaseFile }))).toThrow(
        /database/i
      );
    }
  });

  it('conservatively counts every queued or leased P0/P1 item and active client execution', async () => {
    const db = database({ p0Ready: 2, p0Leased: 3, p1Ready: 4, p1Leased: 5 }, 6);
    const options = validDependencies({
      openReadonlyDatabase: vi.fn().mockReturnValue(db.database)
    });

    const snapshot = await createProductionScoutLiveSignals(options).capture();

    expect(snapshot.priorityWork).toEqual({
      p0Ready: 2,
      p0Leased: 3,
      p1Ready: 4,
      p1Leased: 5
    });
    expect(snapshot.execution.clientActive).toBe(true);
    expect(evaluateDowntimeAdmission(snapshot, NOW).reasons).toEqual([
      'P0_WORK_PENDING',
      'P1_WORK_PENDING',
      'CLIENT_EXECUTION_ACTIVE'
    ]);
  });

  it('falls back to statfs for disk while retaining a valid not-ready core denial', async () => {
    const body = readyBody({
      status: 'not_ready',
      checks: { gateway: 'ok', database: 'down', disk: 'unavailable' },
      failures: ['database_down', 'disk_unavailable']
    });
    const options = validDependencies({
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(readyResponse(body, 503)),
      readStatFs: vi.fn().mockResolvedValue({ blocks: 400n, bavail: 101n })
    });

    const snapshot = await createProductionScoutLiveSignals(options).capture();

    expect(snapshot.coreReadiness).toBe('red');
    expect(snapshot.diskFreePercent).toBe(25.25);
    expect(options.readStatFs).toHaveBeenCalledWith(PROJECT_ROOT, { bigint: true });
    expect(evaluateDowntimeAdmission(snapshot, NOW).reasons).toContain('CORE_READINESS_NOT_GREEN');
  });

  it('accepts bounded loopback response-time skew but rejects future-dated readiness', async () => {
    const withinSkew = validDependencies({
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(readyResponse(readyBody({ timestamp: '2026-07-20T15:00:00.250Z' })))
    });
    const futureDated = validDependencies({
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(readyResponse(readyBody({ timestamp: '2026-07-20T15:00:05.001Z' })))
    });

    await expect(createProductionScoutLiveSignals(withinSkew).capture()).resolves.toMatchObject({
      coreReadiness: 'green',
      diskFreePercent: 42
    });
    await expect(createProductionScoutLiveSignals(futureDated).capture()).resolves.toMatchObject({
      coreReadiness: 'unknown'
    });
  });

  it('turns malformed, missing, oversized, and unknown evidence into conservative denials', async () => {
    const oversizedReadiness = new Response('x'.repeat(20_000), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': '20000' }
    });
    const options = validDependencies({
      environment: environment({
        [SCOUT_LIVE_ENV.enabled]: 'TRUE',
        [SCOUT_LIVE_ENV.taskMarketExecutionActive]: undefined,
        [SCOUT_LIVE_ENV.quietPeriodMs]: undefined,
        [SCOUT_LIVE_ENV.requestsUsed]: '01',
        [SCOUT_LIVE_ENV.responsesLimit]: '1000000001'
      }),
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(oversizedReadiness),
      openReadonlyDatabase: vi.fn(() => {
        throw new Error('missing database');
      }),
      runCommand: vi.fn<ScoutCommandRunner>().mockResolvedValue({
        stdout: '"HIDIdleTime" = 600000000000\n"HIDIdleTime" = 1\nSECRET'
      }),
      readStatFs: vi.fn().mockRejectedValue(new Error('statfs unavailable'))
    });

    const snapshot = await createProductionScoutLiveSignals(options).capture();
    const decision = evaluateDowntimeAdmission(snapshot, NOW);

    expect(snapshot).toMatchObject({
      killSwitchEnabled: false,
      coreReadiness: 'unknown',
      diskFreePercent: 0,
      priorityWork: { p0Ready: 1, p0Leased: 1, p1Ready: 1, p1Leased: 1 },
      execution: { clientActive: true, taskMarketActive: true },
      foreground: { lastActivityAt: null },
      hostCapability: 'unknown',
      quotas: {
        requests: { used: 1, limit: 1 },
        responses: { used: 1, limit: 1 }
      }
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        'KILL_SWITCH_DISABLED',
        'CORE_READINESS_NOT_GREEN',
        'DISK_BELOW_MINIMUM',
        'P0_WORK_PENDING',
        'P1_WORK_PENDING',
        'CLIENT_EXECUTION_ACTIVE',
        'TASK_MARKET_EXECUTION_ACTIVE',
        'FOREGROUND_ACTIVITY_UNKNOWN',
        'HOST_CAPABILITY_UNHEALTHY',
        'REQUEST_QUOTA_EXHAUSTED',
        'RESPONSE_QUOTA_EXHAUSTED'
      ])
    );
    expect(JSON.stringify(snapshot)).not.toContain('SECRET');
  });

  it('fails closed when readiness times out even if the injected fetch ignores abort', async () => {
    vi.useFakeTimers();
    try {
      const options = validDependencies({
        timeoutMs: 25,
        fetch: vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => undefined))
      });
      const capture = createProductionScoutLiveSignals(options).capture();

      await vi.advanceTimersByTimeAsync(25);
      const snapshot = await capture;

      expect(snapshot.coreReadiness).toBe('unknown');
      expect(snapshot.diskFreePercent).toBe(25);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the readiness deadline active while the body stalls', async () => {
    vi.useFakeTimers();
    try {
      const stalledBody = new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined)
      });
      const options = validDependencies({
        timeoutMs: 25,
        fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
          new Response(stalledBody, {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        )
      });
      const capture = createProductionScoutLiveSignals(options).capture();

      await vi.advanceTimersByTimeAsync(25);
      const snapshot = await capture;

      expect(snapshot.coreReadiness).toBe('unknown');
      expect(snapshot.diskFreePercent).toBe(25);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not run the macOS command on an unknown host platform', async () => {
    const options = validDependencies({ platform: 'linux' });

    const snapshot = await createProductionScoutLiveSignals(options).capture();

    expect(options.runCommand).not.toHaveBeenCalled();
    expect(snapshot.hostCapability).toBe('unknown');
    expect(snapshot.foreground.lastActivityAt).toBeNull();
  });
});
