import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatabase } from '../../src/db/database';
import { TaskFrequencyRepository } from '../../src/db/task-frequency-repository';
import type { HealthProvider, HealthResult } from '../../src/gateway/app';
import { startServer, type StartedServer } from '../../src/gateway/server';
import type { MonitoringCycleResult } from '../../src/monitoring/scheduler';

const projectRoot = join(__dirname, '..', '..');
const now = '2026-07-18T16:00:00.000Z';
const healthyResult: HealthResult = {
  timestamp: now,
  overall: 'healthy',
  severity: 'none',
  checks: {
    gateway: 'ok',
    database: 'ok',
    ollama: 'ok',
    docker: 'ok',
    disk: 'ok:50%_free'
  },
  failures: [],
  action: 'none'
};

function timeoutAfter(milliseconds: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Monitoring cycle timed out')), milliseconds).unref();
  });
}

describe('gateway monitoring lifecycle', () => {
  let temporaryRoot: string;
  let started: StartedServer | undefined;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-monitoring-test-'));
  });

  afterEach(async () => {
    await started?.stop();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('runs heartbeat and real ToolSmith analysis immediately after binding', async () => {
    let publishCycle: ((result: MonitoringCycleResult) => void) | undefined;
    const cycle = new Promise<MonitoringCycleResult>((resolve) => {
      publishCycle = resolve;
    });
    const checkHeartbeat = vi.fn(() => Promise.resolve(healthyResult));
    const heartbeat: HealthProvider = { check: checkHeartbeat };

    started = await startServer({
      projectRoot,
      databaseFile: join(temporaryRoot, 'jarvis.sqlite'),
      clientRoot: join(temporaryRoot, 'clients'),
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot: join(temporaryRoot, 'memory', 'graph'),
      heartbeat,
      monitoring: {
        intervalMs: 60_000,
        onCycle: (result) => publishCycle?.(result)
      },
      databaseFactory: async (options) => {
        const database = await createDatabase(options);
        const frequency = new TaskFrequencyRepository(database.db);
        for (let index = 0; index < 5; index += 1) {
          await frequency.recordExecution({
            taskSignature: 'acme_corp:daily-report',
            durationSeconds: 2,
            executedAt: now
          });
        }
        return database;
      },
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });

    await expect(Promise.race([cycle, timeoutAfter(2_000)])).resolves.toEqual({
      health: healthyResult,
      proposals: [
        expect.objectContaining({
          skill: '5-d-build',
          mode: 'proposal_only',
          taskSignature: 'acme_corp:daily-report',
          executionCount: 5
        })
      ]
    });
    expect(checkHeartbeat).toHaveBeenCalledOnce();
  });

  it('stops and drains a live monitoring cycle before destroying its database', async () => {
    let releaseHeartbeat: ((result: HealthResult) => void) | undefined;
    let signalHeartbeatStarted: (() => void) | undefined;
    const heartbeatStarted = new Promise<void>((resolve) => {
      signalHeartbeatStarted = resolve;
    });
    const heartbeat: HealthProvider = {
      check: () =>
        new Promise<HealthResult>((resolve) => {
          releaseHeartbeat = resolve;
          signalHeartbeatStarted?.();
        })
    };
    let databaseDestroyed = false;

    started = await startServer({
      projectRoot,
      databaseFile: join(temporaryRoot, 'jarvis.sqlite'),
      clientRoot: join(temporaryRoot, 'clients'),
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot: join(temporaryRoot, 'memory', 'graph'),
      heartbeat,
      monitoring: { intervalMs: 60_000 },
      databaseFactory: async (options) => {
        const database = await createDatabase(options);
        return {
          ...database,
          async destroy() {
            databaseDestroyed = true;
            await database.destroy();
          }
        };
      },
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });

    await heartbeatStarted;
    const activeServer = started;
    started = undefined;
    const stopping = activeServer.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(databaseDestroyed).toBe(false);

    releaseHeartbeat?.(healthyResult);
    await stopping;
    expect(databaseDestroyed).toBe(true);
  });

  it('releases the database and instance lease when an injected heartbeat never settles', async () => {
    let releaseHeartbeat: ((result: HealthResult) => void) | undefined;
    const heartbeat: HealthProvider = {
      check: () =>
        new Promise<HealthResult>((resolve) => {
          releaseHeartbeat = resolve;
        })
    };
    let databaseDestroyed = false;
    const databaseFile = join(temporaryRoot, 'jarvis.sqlite');

    started = await startServer({
      projectRoot,
      databaseFile,
      clientRoot: join(temporaryRoot, 'clients'),
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot: join(temporaryRoot, 'memory', 'graph'),
      heartbeat,
      monitoring: { intervalMs: 60_000, cycleTimeoutMs: 20 },
      databaseFactory: async (options) => {
        const database = await createDatabase(options);
        return {
          ...database,
          async destroy() {
            databaseDestroyed = true;
            await database.destroy();
          }
        };
      },
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });

    const activeServer = started;
    started = undefined;
    const stopping = activeServer.stop();
    const completedWithinDeadline = await Promise.race([
      stopping.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 200).unref();
      })
    ]);
    if (!completedWithinDeadline) {
      releaseHeartbeat?.(healthyResult);
      await stopping;
    }

    expect(completedWithinDeadline).toBe(true);
    expect(databaseDestroyed).toBe(true);

    const reacquired = await startServer({
      projectRoot,
      databaseFile,
      clientRoot: join(temporaryRoot, 'clients'),
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot: join(temporaryRoot, 'memory', 'graph'),
      heartbeat: { check: () => Promise.resolve(healthyResult) },
      monitoring: false,
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });
    await reacquired.stop();
  });
});
