import { describe, expect, it, vi } from 'vitest';

import type { ToolSmithProposal } from '../../src/agents/toolsmith';
import type { HealthResult } from '../../src/gateway/app';
import {
  MonitoringScheduler,
  type IntervalHandle,
  type MonitoringCycleResult
} from '../../src/monitoring/scheduler';

const health: HealthResult = {
  timestamp: '2026-07-18T16:00:00.000Z',
  overall: 'healthy',
  severity: 'none',
  checks: { gateway: 'ok' },
  failures: [],
  action: 'none'
};

const proposal: ToolSmithProposal = {
  kind: 'autonomous_pr_simulation',
  mode: 'proposal_only',
  skill: '5-d-build',
  taskSignature: 'acme_corp:daily-report',
  executionCount: 5,
  payload: {
    objective: 'Automate repeated task: acme_corp:daily-report',
    evidence: {
      executionCount: 5,
      averageDurationSeconds: 1,
      manualInterventionCount: 0,
      lastExecutedAt: '2026-07-18T15:00:00.000Z'
    }
  }
};

describe('MonitoringScheduler', () => {
  it('runs immediately, installs one unrefed 15-minute interval, and publishes a cycle', async () => {
    let scheduled: (() => void) | undefined;
    const unref = vi.fn();
    const handle: IntervalHandle = { unref };
    const setIntervalFn = vi.fn((callback: () => void, delay: number) => {
      void delay;
      scheduled = callback;
      return handle;
    });
    const onCycle = vi.fn<(result: MonitoringCycleResult) => void>();
    const scheduler = new MonitoringScheduler({
      heartbeat: { check: () => Promise.resolve(health) },
      toolsmith: { analyze: () => Promise.resolve([proposal]) },
      setIntervalFn,
      clearIntervalFn: vi.fn(),
      onCycle
    });

    scheduler.start();
    await scheduler.settled();

    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 15 * 60 * 1_000);
    expect(unref).toHaveBeenCalledOnce();
    expect(scheduled).toEqual(expect.any(Function));
    expect(onCycle).toHaveBeenCalledWith({ health, proposals: [proposal] });
  });

  it('suppresses overlap and allows a later interval after the active cycle settles', async () => {
    let scheduled: (() => void) | undefined;
    let resolveHeartbeat: ((value: HealthResult) => void) | undefined;
    const heartbeat = vi.fn(
      () =>
        new Promise<HealthResult>((resolve) => {
          resolveHeartbeat = resolve;
        })
    );
    const analyze = vi.fn(() => Promise.resolve([]));
    const scheduler = new MonitoringScheduler({
      heartbeat: { check: heartbeat },
      toolsmith: { analyze },
      setIntervalFn: (callback) => {
        scheduled = callback;
        return { unref: () => undefined };
      },
      clearIntervalFn: () => undefined
    });

    scheduler.start();
    scheduled?.();
    scheduled?.();
    expect(heartbeat).toHaveBeenCalledOnce();

    resolveHeartbeat?.(health);
    await scheduler.settled();
    expect(analyze).toHaveBeenCalledOnce();

    scheduled?.();
    expect(heartbeat).toHaveBeenCalledTimes(2);
    resolveHeartbeat?.(health);
    await scheduler.settled();
  });

  it('reports background errors safely, stops idempotently, and drains in-flight work', async () => {
    let scheduled: (() => void) | undefined;
    const clearIntervalFn = vi.fn();
    const onError = vi.fn<(error: unknown) => void>();
    const handle: IntervalHandle = { unref: () => undefined };
    const scheduler = new MonitoringScheduler({
      heartbeat: { check: () => Promise.reject(new Error('probe failed')) },
      toolsmith: { analyze: () => Promise.resolve([]) },
      setIntervalFn: (callback) => {
        scheduled = callback;
        return handle;
      },
      clearIntervalFn,
      onError
    });

    scheduler.start();
    await scheduler.settled();
    scheduler.stop();
    scheduler.stop();
    scheduled?.();
    await scheduler.settled();

    expect(onError).toHaveBeenCalledOnce();
    expect(clearIntervalFn).toHaveBeenCalledOnce();
    expect(clearIntervalFn).toHaveBeenCalledWith(handle);
  });

  it('routes an asynchronous cycle-publisher rejection through the error callback', async () => {
    const publishError = new Error('publisher failed');
    const onError = vi.fn<(error: unknown) => void>();
    const scheduler = new MonitoringScheduler({
      heartbeat: { check: () => Promise.resolve(health) },
      toolsmith: { analyze: () => Promise.resolve([]) },
      setIntervalFn: () => ({ unref: () => undefined }),
      clearIntervalFn: () => undefined,
      onCycle: () => Promise.reject(publishError),
      onError
    });

    scheduler.start();
    await scheduler.settled();

    expect(onError).toHaveBeenCalledWith(publishError);
  });

  it('bounds a cycle whose heartbeat never settles', async () => {
    const onError = vi.fn<(error: unknown) => void>();
    const scheduler = new MonitoringScheduler({
      heartbeat: { check: () => new Promise<HealthResult>(() => undefined) },
      toolsmith: { analyze: () => Promise.resolve([]) },
      cycleTimeoutMs: 20,
      setIntervalFn: () => ({ unref: () => undefined }),
      clearIntervalFn: () => undefined,
      onError
    });
    const testDeadline = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('Scheduler did not honor its deadline')), 200).unref();
    });

    scheduler.start();
    await Promise.race([scheduler.settled(), testDeadline]);
    scheduler.stop();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Monitoring cycle exceeded its deadline' })
    );
  });

  it('does not enter ToolSmith if a timed-out heartbeat resumes after stop', async () => {
    let releaseHeartbeat: ((result: HealthResult) => void) | undefined;
    const analyze = vi.fn(() => Promise.resolve([]));
    const scheduler = new MonitoringScheduler({
      heartbeat: {
        check: () =>
          new Promise<HealthResult>((resolve) => {
            releaseHeartbeat = resolve;
          })
      },
      toolsmith: { analyze },
      cycleTimeoutMs: 20,
      setIntervalFn: () => ({ unref: () => undefined }),
      clearIntervalFn: () => undefined
    });

    scheduler.start();
    await scheduler.settled();
    scheduler.stop();
    releaseHeartbeat?.(health);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(analyze).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid interval %s',
    (intervalMs) => {
      expect(
        () =>
          new MonitoringScheduler({
            heartbeat: { check: () => Promise.resolve(health) },
            toolsmith: { analyze: () => Promise.resolve([]) },
            intervalMs
          })
      ).toThrow(RangeError);
    }
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid cycle deadline %s',
    (cycleTimeoutMs) => {
      expect(
        () =>
          new MonitoringScheduler({
            heartbeat: { check: () => Promise.resolve(health) },
            toolsmith: { analyze: () => Promise.resolve([]) },
            cycleTimeoutMs
          })
      ).toThrow(RangeError);
    }
  );
});
