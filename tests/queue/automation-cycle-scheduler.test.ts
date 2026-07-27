import { describe, expect, it, vi } from 'vitest';

import type { AutomationCycleResult } from '../../src/queue/automation-cycle';
import {
  AutomationCycleScheduler,
  type AutomationSchedulerIntervalHandle
} from '../../src/queue/automation-cycle-scheduler';

const safeResult: AutomationCycleResult = {
  startedAt: '2026-07-18T23:00:00.000Z',
  completedAt: '2026-07-18T23:00:01.000Z',
  inspectedTenantCount: 1,
  claimedTaskCount: 1,
  succeededTaskCount: 1,
  failedTaskCount: 0,
  tasks: [
    {
      id: 'task-acme',
      tenantId: 'acme_corp',
      lane: 'delivery',
      outcome: 'succeeded'
    }
  ]
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error)
  };
}

function intervalHarness(): {
  scheduled: () => void;
  setIntervalFn: (callback: () => void, delay: number) => AutomationSchedulerIntervalHandle;
  clearIntervalFn: (handle: AutomationSchedulerIntervalHandle) => void;
  unref: () => void;
  handle: AutomationSchedulerIntervalHandle;
} {
  let callback: (() => void) | undefined;
  const unref = vi.fn();
  const handle: AutomationSchedulerIntervalHandle = { unref };
  const setIntervalFn = vi.fn((next: () => void, delay: number) => {
    void delay;
    callback = next;
    return handle;
  });
  const clearIntervalFn = vi.fn((intervalHandle: AutomationSchedulerIntervalHandle) => {
    void intervalHandle;
  });
  return {
    scheduled: () => callback?.(),
    setIntervalFn,
    clearIntervalFn,
    unref,
    handle
  };
}

describe('AutomationCycleScheduler', () => {
  it('runs immediately, installs one unrefed interval, and publishes only allowlisted result data', async () => {
    const interval = intervalHarness();
    const resultWithExtras = {
      ...safeResult,
      privatePayload: 'must-not-escape',
      tasks: safeResult.tasks.map((task) => ({
        ...task,
        leaseToken: 'private-lease-token'
      }))
    } as unknown as AutomationCycleResult;
    const runOnce = vi.fn(() => Promise.resolve(resultWithExtras));
    const onCycle = vi.fn<(result: AutomationCycleResult) => void>();
    const scheduler = new AutomationCycleScheduler({
      cycle: { runOnce },
      intervalMs: 1_234,
      cycleTimeoutMs: 5_678,
      setIntervalFn: interval.setIntervalFn,
      clearIntervalFn: interval.clearIntervalFn,
      onCycle
    });

    scheduler.start();
    scheduler.start();
    await scheduler.settled();

    expect(runOnce).toHaveBeenCalledOnce();
    expect(interval.setIntervalFn).toHaveBeenCalledOnce();
    expect(interval.setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 1_234);
    expect(interval.unref).toHaveBeenCalledOnce();
    expect(onCycle).toHaveBeenCalledWith(safeResult);
    expect(JSON.stringify(onCycle.mock.calls[0]?.[0])).not.toContain('private');
  });

  it('suppresses interval overlap and permits the next cycle only after active work settles', async () => {
    const interval = intervalHarness();
    const first = deferred<AutomationCycleResult>();
    const runOnce = vi
      .fn<() => Promise<AutomationCycleResult>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(safeResult);
    const scheduler = new AutomationCycleScheduler({
      cycle: { runOnce },
      intervalMs: 10,
      cycleTimeoutMs: 1_000,
      setIntervalFn: interval.setIntervalFn,
      clearIntervalFn: interval.clearIntervalFn
    });

    scheduler.start();
    interval.scheduled();
    interval.scheduled();
    expect(runOnce).toHaveBeenCalledOnce();

    first.resolve(safeResult);
    await scheduler.settled();
    interval.scheduled();
    await scheduler.settled();

    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it('does not overlap after a deadline and settled still drains the underlying cycle', async () => {
    const interval = intervalHarness();
    const first = deferred<AutomationCycleResult>();
    const runOnce = vi
      .fn<() => Promise<AutomationCycleResult>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(safeResult);
    const onCycle = vi.fn<(result: AutomationCycleResult) => void>();
    let resolveReported: (() => void) | undefined;
    const reported = new Promise<void>((resolve) => {
      resolveReported = resolve;
    });
    const onError = vi.fn((error: unknown) => {
      expect(error).toEqual(
        expect.objectContaining({ message: 'Automation cycle exceeded its deadline' })
      );
      resolveReported?.();
    });
    const scheduler = new AutomationCycleScheduler({
      cycle: { runOnce },
      intervalMs: 5,
      cycleTimeoutMs: 10,
      setIntervalFn: interval.setIntervalFn,
      clearIntervalFn: interval.clearIntervalFn,
      onCycle,
      onError
    });

    scheduler.start();
    await reported;
    interval.scheduled();
    expect(runOnce).toHaveBeenCalledOnce();

    let drained = false;
    const drain = scheduler.settled().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);

    first.resolve(safeResult);
    await drain;
    expect(onCycle).not.toHaveBeenCalled();

    interval.scheduled();
    await scheduler.settled();
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(onCycle).toHaveBeenCalledOnce();
  });

  it('stops idempotently, suppresses late publication, and drains work already in flight', async () => {
    const interval = intervalHarness();
    const active = deferred<AutomationCycleResult>();
    const runOnce = vi.fn(() => active.promise);
    const onCycle = vi.fn<(result: AutomationCycleResult) => void>();
    const scheduler = new AutomationCycleScheduler({
      cycle: { runOnce },
      setIntervalFn: interval.setIntervalFn,
      clearIntervalFn: interval.clearIntervalFn,
      onCycle
    });

    scheduler.start();
    scheduler.stop();
    scheduler.stop();
    scheduler.start();
    interval.scheduled();

    let drained = false;
    const drain = scheduler.settled().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    expect(runOnce).toHaveBeenCalledOnce();

    active.resolve(safeResult);
    await drain;

    expect(onCycle).not.toHaveBeenCalled();
    expect(interval.clearIntervalFn).toHaveBeenCalledOnce();
    expect(interval.clearIntervalFn).toHaveBeenCalledWith(interval.handle);
  });

  it('contains cycle and publisher failures and reports them without blocking later cycles', async () => {
    const interval = intervalHarness();
    const cycleError = new Error('cycle failed');
    const publisherError = new Error('publisher failed');
    const runOnce = vi
      .fn<() => Promise<AutomationCycleResult>>()
      .mockRejectedValueOnce(cycleError)
      .mockResolvedValueOnce(safeResult)
      .mockResolvedValueOnce(safeResult);
    const onCycle = vi
      .fn<(result: AutomationCycleResult) => Promise<void>>()
      .mockRejectedValueOnce(publisherError)
      .mockResolvedValueOnce();
    const onError = vi
      .fn<(error: unknown) => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('error reporter failed'));
    const scheduler = new AutomationCycleScheduler({
      cycle: { runOnce },
      setIntervalFn: interval.setIntervalFn,
      clearIntervalFn: interval.clearIntervalFn,
      onCycle,
      onError
    });

    scheduler.start();
    await scheduler.settled();
    interval.scheduled();
    await scheduler.settled();
    interval.scheduled();
    await scheduler.settled();

    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(onCycle).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenNthCalledWith(1, cycleError);
    expect(onError).toHaveBeenNthCalledWith(2, publisherError);
  });

  it('publishes an allowlisted failure reason without leaking extra task data', async () => {
    const interval = intervalHarness();
    const failedResult: AutomationCycleResult = {
      ...safeResult,
      succeededTaskCount: 0,
      failedTaskCount: 1,
      tasks: [
        {
          id: 'task-acme',
          tenantId: 'acme_corp',
          lane: 'delivery',
          outcome: 'failed',
          reasonCode: 'policy_blocked',
          privatePayload: 'must-not-escape'
        } as AutomationCycleResult['tasks'][number]
      ]
    };
    const onCycle = vi.fn<(result: AutomationCycleResult) => void>();
    const scheduler = new AutomationCycleScheduler({
      cycle: { runOnce: () => Promise.resolve(failedResult) },
      setIntervalFn: interval.setIntervalFn,
      clearIntervalFn: interval.clearIntervalFn,
      onCycle
    });

    scheduler.start();
    await scheduler.settled();

    expect(onCycle).toHaveBeenCalledWith({
      ...safeResult,
      succeededTaskCount: 0,
      failedTaskCount: 1,
      tasks: [
        {
          id: 'task-acme',
          tenantId: 'acme_corp',
          lane: 'delivery',
          outcome: 'failed',
          reasonCode: 'policy_blocked'
        }
      ]
    });
    expect(JSON.stringify(onCycle.mock.calls)).not.toContain('must-not-escape');
  });

  it('can be stopped before start without creating or clearing an interval', async () => {
    const interval = intervalHarness();
    const runOnce = vi.fn(() => Promise.resolve(safeResult));
    const scheduler = new AutomationCycleScheduler({
      cycle: { runOnce },
      setIntervalFn: interval.setIntervalFn,
      clearIntervalFn: interval.clearIntervalFn
    });

    scheduler.stop();
    scheduler.stop();
    scheduler.start();
    await scheduler.settled();

    expect(runOnce).not.toHaveBeenCalled();
    expect(interval.setIntervalFn).not.toHaveBeenCalled();
    expect(interval.clearIntervalFn).not.toHaveBeenCalled();
  });

  it('settled drains an asynchronous error reporter after failed work has cleared', async () => {
    const interval = intervalHarness();
    const releaseReporter = deferred<void>();
    const reporterStarted = deferred<void>();
    const scheduler = new AutomationCycleScheduler({
      cycle: { runOnce: () => Promise.reject(new Error('cycle failed')) },
      setIntervalFn: interval.setIntervalFn,
      clearIntervalFn: interval.clearIntervalFn,
      onError: async () => {
        reporterStarted.resolve();
        await releaseReporter.promise;
      }
    });

    scheduler.start();
    await reporterStarted.promise;
    await Promise.resolve();
    const drain = scheduler.settled();
    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);

    releaseReporter.resolve();
    await drain;
  });

  it('settled drains timed-out work after deadline observation has cleared', async () => {
    const interval = intervalHarness();
    const active = deferred<AutomationCycleResult>();
    const reported = deferred<void>();
    const scheduler = new AutomationCycleScheduler({
      cycle: { runOnce: () => active.promise },
      intervalMs: 5,
      cycleTimeoutMs: 5,
      setIntervalFn: interval.setIntervalFn,
      clearIntervalFn: interval.clearIntervalFn,
      onError: () => {
        reported.resolve();
      }
    });

    scheduler.start();
    await reported.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const drain = scheduler.settled();
    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);

    active.resolve(safeResult);
    await drain;
  });

  it('does not let stale completion callbacks clear newer active-cycle state', () => {
    interface SchedulerInternals {
      activeWork: Promise<void> | undefined;
      activeState: { publishAllowed: boolean } | undefined;
      completeActiveWork(activeWork: Promise<void>, state: { publishAllowed: boolean }): void;
    }

    const scheduler = new AutomationCycleScheduler({
      cycle: { runOnce: () => Promise.resolve(safeResult) }
    });
    const internals = scheduler as unknown as SchedulerInternals;
    const currentWork = Promise.resolve();
    const currentState = { publishAllowed: true };
    internals.activeWork = currentWork;
    internals.activeState = currentState;

    internals.completeActiveWork(Promise.resolve(), { publishAllowed: true });

    expect(internals.activeWork).toBe(currentWork);
    expect(internals.activeState).toBe(currentState);
    internals.activeWork = undefined;
    internals.activeState = undefined;
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid interval %s',
    (intervalMs) => {
      expect(
        () =>
          new AutomationCycleScheduler({
            cycle: { runOnce: () => Promise.resolve(safeResult) },
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
          new AutomationCycleScheduler({
            cycle: { runOnce: () => Promise.resolve(safeResult) },
            cycleTimeoutMs
          })
      ).toThrow(RangeError);
    }
  );
});
