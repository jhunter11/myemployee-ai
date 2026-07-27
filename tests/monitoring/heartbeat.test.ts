import { describe, expect, it, vi } from 'vitest';

import type { HealthResult } from '../../src/gateway/app';
import {
  Heartbeat,
  createProductionHeartbeat,
  type CommandRunner,
  type HeartbeatFetch,
  type HeartbeatProbes,
  type StatFsReader
} from '../../src/monitoring/heartbeat';

const now = '2026-07-18T16:00:00.000Z';

function healthyProbes(overrides: Partial<HeartbeatProbes> = {}): HeartbeatProbes {
  return {
    gateway: () => Promise.resolve(),
    database: () => Promise.resolve(),
    ollama: () => Promise.resolve(),
    docker: () => Promise.resolve(),
    diskFreePercent: () => Promise.resolve(42),
    ...overrides
  };
}

describe('Heartbeat', () => {
  it('reports structured healthy state at the ten-percent disk boundary', async () => {
    const heartbeat = new Heartbeat({
      probes: healthyProbes({ diskFreePercent: () => Promise.resolve(10) }),
      now: () => now
    });

    await expect(heartbeat.check()).resolves.toEqual({
      timestamp: now,
      overall: 'healthy',
      severity: 'none',
      checks: {
        gateway: 'ok',
        database: 'ok',
        ollama: 'ok',
        docker: 'ok',
        disk: 'ok:10%_free'
      },
      failures: [],
      action: 'none'
    });
  });

  it('collects every failed probe in deterministic order without leaking errors', async () => {
    const heartbeat = new Heartbeat({
      probes: healthyProbes({
        gateway: () => Promise.reject(new Error('gateway secret')),
        database: () => Promise.reject(new Error('database secret')),
        ollama: () => Promise.reject(new Error('ollama secret')),
        docker: () => Promise.reject(new Error('docker secret')),
        diskFreePercent: () => Promise.resolve(9)
      }),
      now: () => now
    });

    const result = await heartbeat.check();

    expect(result).toEqual({
      timestamp: now,
      overall: 'degraded',
      severity: 'P1',
      checks: {
        gateway: 'down',
        database: 'down',
        ollama: 'unreachable',
        docker: 'down',
        disk: 'critical:9%_free'
      },
      failures: ['gateway_down', 'database_down', 'ollama_unreachable', 'docker_down', 'disk_low'],
      action: 'escalate_P1'
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('fails closed when disk capacity cannot be measured', async () => {
    const heartbeat = new Heartbeat({
      probes: healthyProbes({
        diskFreePercent: () => Promise.reject(new Error('mount details'))
      }),
      now: () => now
    });

    await expect(heartbeat.check()).resolves.toMatchObject({
      overall: 'degraded',
      checks: { disk: 'unavailable' },
      failures: ['disk_unavailable']
    });
  });

  it('starts independent probes together so one timeout does not serialize all checks', async () => {
    let releaseGateway: (() => void) | undefined;
    const gateway = () =>
      new Promise<void>((resolve) => {
        releaseGateway = resolve;
      });
    const database = vi.fn(() => Promise.resolve());
    const diskFreePercent = vi.fn(() => Promise.resolve(50));
    const heartbeat = new Heartbeat({
      probes: healthyProbes({ gateway, database, diskFreePercent }),
      now: () => now
    });

    const checking = heartbeat.check();
    await Promise.resolve();
    const databaseStartedBeforeGatewayFinished = database.mock.calls.length === 1;
    const diskStartedBeforeGatewayFinished = diskFreePercent.mock.calls.length === 1;
    releaseGateway?.();
    await checking;

    expect(databaseStartedBeforeGatewayFinished).toBe(true);
    expect(diskStartedBeforeGatewayFinished).toBe(true);
  });

  it('bounds a probe that never settles and converts it to its fixed failure code', async () => {
    const heartbeat = new Heartbeat({
      probes: healthyProbes({
        database: () => new Promise<void>(() => undefined)
      }),
      now: () => now,
      timeoutMs: 20
    });
    const testDeadline = new Promise<HealthResult>((_, reject) => {
      setTimeout(() => reject(new Error('Heartbeat did not honor its deadline')), 200).unref();
    });

    await expect(Promise.race([heartbeat.check(), testDeadline])).resolves.toMatchObject({
      overall: 'degraded',
      checks: { database: 'down' },
      failures: ['database_down']
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid probe deadline %s',
    (timeoutMs) => {
      expect(
        () =>
          new Heartbeat({
            probes: healthyProbes(),
            timeoutMs
          })
      ).toThrow(RangeError);
    }
  );
});

describe('createProductionHeartbeat', () => {
  it('uses bounded HTTP, shell-free Docker, and available filesystem blocks', async () => {
    const fetchImpl = vi.fn<HeartbeatFetch>(() => Promise.resolve({ ok: true }));
    const runCommand: CommandRunner = vi.fn(() => Promise.resolve());
    const readStatFs: StatFsReader = vi.fn(() => Promise.resolve({ blocks: 100n, bavail: 25n }));
    const databaseCheck = vi.fn(() => Promise.resolve());

    const heartbeat = createProductionHeartbeat({
      projectRoot: '/tmp/jarvis-project',
      databaseCheck,
      fetchImpl,
      runCommand,
      readStatFs,
      now: () => now,
      timeoutMs: 1_234
    });

    await expect(heartbeat.check()).resolves.toMatchObject({
      overall: 'healthy',
      checks: { database: 'ok', ollama: 'ok', docker: 'ok', disk: 'ok:25%_free' }
    });
    expect(databaseCheck).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const fetchCall = fetchImpl.mock.calls[0];
    expect(fetchCall?.[0]).toBe('http://127.0.0.1:11434/api/tags');
    expect(fetchCall?.[1].signal).toBeInstanceOf(AbortSignal);
    expect(runCommand).toHaveBeenCalledWith('docker', ['info', '--format', '{{.ServerVersion}}'], {
      timeout: 1_234,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      shell: false
    });
    expect(readStatFs).toHaveBeenCalledWith('/tmp/jarvis-project', { bigint: true });
  });

  it('treats non-success Ollama responses and invalid filesystem totals as unavailable', async () => {
    const heartbeat = createProductionHeartbeat({
      projectRoot: '/tmp/jarvis-project',
      databaseCheck: () => Promise.resolve(),
      fetchImpl: () => Promise.resolve({ ok: false }),
      runCommand: () => Promise.resolve(),
      readStatFs: () => Promise.resolve({ blocks: 0n, bavail: 0n }),
      now: () => now
    });

    await expect(heartbeat.check()).resolves.toMatchObject({
      overall: 'degraded',
      checks: { ollama: 'unreachable', disk: 'unavailable' },
      failures: ['ollama_unreachable', 'disk_unavailable']
    });
  });
});
