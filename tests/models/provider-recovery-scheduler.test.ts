import { describe, expect, it, vi } from 'vitest';

import {
  ProviderRecoveryScheduler,
  type ProviderRecoveryRecord,
  type ProviderRecoverySource,
  type ProviderRecoveryTimerHandle
} from '../../src/models/provider-recovery-scheduler';

const HOUR_MS = 60 * 60 * 1_000;

interface ScheduledTimer {
  callback: () => void;
  delay: number;
  handle: ProviderRecoveryTimerHandle & { id: number; unref: ReturnType<typeof vi.fn> };
  active: boolean;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function timerHarness(): {
  timers: ScheduledTimer[];
  setTimeoutFn: (callback: () => void, delay: number) => ProviderRecoveryTimerHandle;
  clearTimeoutFn: (handle: ProviderRecoveryTimerHandle) => void;
  fireNext: (delay: number) => void;
} {
  const timers: ScheduledTimer[] = [];
  let nextId = 0;
  const setTimeoutFn = vi.fn((callback: () => void, delay: number) => {
    const handle = { id: ++nextId, unref: vi.fn() };
    timers.push({ callback, delay, handle, active: true });
    return handle;
  });
  const clearTimeoutFn = vi.fn((handle: ProviderRecoveryTimerHandle) => {
    const timer = timers.find((candidate) => candidate.handle === handle);
    if (timer) timer.active = false;
  });
  const fireNext = (delay: number): void => {
    const timer = timers.find((candidate) => candidate.active && candidate.delay === delay);
    expect(timer, `expected an active ${delay}ms timer`).toBeDefined();
    if (!timer) return;
    timer.active = false;
    timer.callback();
  };
  return { timers, setTimeoutFn, clearTimeoutFn, fireNext };
}

function source(
  listDue: () => Promise<readonly ProviderRecoveryRecord[]>,
  nextNotBefore: () => Promise<number | null>,
  subscribe?: (listener: () => void) => () => void
): ProviderRecoverySource {
  return { listDue, nextNotBefore, ...(subscribe === undefined ? {} : { subscribe }) };
}

describe('ProviderRecoveryScheduler', () => {
  it('reconciles immediately and schedules hourly safety plus the earliest future recovery', async () => {
    const now = 1_000;
    const due: ProviderRecoveryRecord = { provider: 'claude', notBefore: 900 };
    const timers = timerHarness();
    const onDue = vi.fn<(record: ProviderRecoveryRecord) => void>();
    const scheduler = new ProviderRecoveryScheduler({
      source: source(
        vi.fn(() => Promise.resolve([due])),
        vi.fn(() => Promise.resolve(6_000))
      ),
      onDue,
      clock: () => now,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn
    });

    scheduler.start();
    await scheduler.settled();

    expect(onDue).toHaveBeenCalledOnce();
    expect(onDue).toHaveBeenCalledWith(due);
    expect(timers.timers.filter((timer) => timer.active).map((timer) => timer.delay)).toEqual([
      HOUR_MS,
      5_000
    ]);
    for (const timer of timers.timers) {
      expect(timer.handle.unref).toHaveBeenCalledOnce();
    }

    await scheduler.stop();
  });

  it('runs a reconciliation when the earliest future notBefore arrives', async () => {
    let now = 10_000;
    let due: readonly ProviderRecoveryRecord[] = [];
    let nextNotBefore: number | null = 10_250;
    const timers = timerHarness();
    const onDue = vi.fn<(record: ProviderRecoveryRecord) => void>();
    const recovery: ProviderRecoveryRecord = { provider: 'codex', notBefore: 10_250 };
    const scheduler = new ProviderRecoveryScheduler({
      source: source(
        () => Promise.resolve(due),
        () => Promise.resolve(nextNotBefore)
      ),
      onDue,
      clock: () => now,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn
    });

    scheduler.start();
    await scheduler.settled();
    expect(onDue).not.toHaveBeenCalled();

    now = recovery.notBefore;
    due = [recovery];
    nextNotBefore = null;
    timers.fireNext(250);
    await scheduler.settled();

    expect(onDue).toHaveBeenCalledOnce();
    expect(onDue).toHaveBeenCalledWith(recovery);

    await scheduler.stop();
  });

  it('reschedules immediately when the durable source changes after startup', async () => {
    let now = 1_000;
    let nextNotBefore: number | null = null;
    let notifyChanged: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const timers = timerHarness();
    const onDue = vi.fn<(record: ProviderRecoveryRecord) => void>();
    const scheduler = new ProviderRecoveryScheduler({
      source: source(
        () => Promise.resolve([]),
        () => Promise.resolve(nextNotBefore),
        (listener) => {
          notifyChanged = listener;
          return unsubscribe;
        }
      ),
      onDue,
      clock: () => now,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn
    });

    scheduler.start();
    await scheduler.settled();
    expect(timers.timers.filter(({ active }) => active).map(({ delay }) => delay)).toEqual([
      HOUR_MS
    ]);

    nextNotBefore = 5_000;
    notifyChanged?.();
    await scheduler.settled();
    expect(timers.timers.filter(({ active }) => active).map(({ delay }) => delay)).toEqual([
      HOUR_MS,
      4_000
    ]);

    nextNotBefore = 3_000;
    notifyChanged?.();
    await scheduler.settled();
    expect(timers.timers.filter(({ active }) => active).map(({ delay }) => delay)).toEqual([
      HOUR_MS,
      2_000
    ]);

    now = 3_000;
    nextNotBefore = null;
    timers.fireNext(2_000);
    await scheduler.settled();
    expect(onDue).not.toHaveBeenCalled();

    await scheduler.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('deduplicates provider and notBefore pairs while allowing a later recovery window', async () => {
    let due: ProviderRecoveryRecord = { provider: 'gemini', notBefore: 20_000 };
    const timers = timerHarness();
    const onDue = vi.fn<(record: ProviderRecoveryRecord) => void>();
    const scheduler = new ProviderRecoveryScheduler({
      source: source(
        () => Promise.resolve([due, due]),
        () => Promise.resolve(null)
      ),
      onDue,
      clock: () => 30_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn
    });

    scheduler.start();
    await scheduler.settled();
    timers.fireNext(HOUR_MS);
    await scheduler.settled();

    expect(onDue).toHaveBeenCalledOnce();

    due = { provider: 'gemini', notBefore: 40_000 };
    timers.fireNext(HOUR_MS);
    await scheduler.settled();

    expect(onDue).toHaveBeenCalledTimes(2);
    expect(onDue).toHaveBeenLastCalledWith(due);

    await scheduler.stop();
  });

  it('contains a rejected due callback and continues notifying other due providers', async () => {
    const due: ProviderRecoveryRecord[] = [
      { provider: 'claude', notBefore: 100 },
      { provider: 'codex', notBefore: 200 }
    ];
    const timers = timerHarness();
    const visited: string[] = [];
    const scheduler = new ProviderRecoveryScheduler({
      source: source(
        () => Promise.resolve(due),
        () => Promise.resolve(null)
      ),
      onDue: (record) => {
        visited.push(record.provider);
        return record.provider === 'claude'
          ? Promise.reject(new Error('notification failed'))
          : Promise.resolve();
      },
      clock: () => 300,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn
    });

    scheduler.start();
    await expect(scheduler.settled()).resolves.toBeUndefined();

    expect(visited).toEqual(['claude', 'codex']);

    timers.fireNext(HOUR_MS);
    await scheduler.settled();
    expect(visited).toEqual(['claude', 'codex', 'claude']);

    await scheduler.stop();
  });

  it('coalesces timer triggers while a reconciliation is active without overlapping source reads', async () => {
    const firstRead = deferred();
    const timers = timerHarness();
    let reads = 0;
    let activeReads = 0;
    let maxActiveReads = 0;
    const listDue = vi.fn(async (): Promise<readonly ProviderRecoveryRecord[]> => {
      reads += 1;
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      try {
        if (reads === 1) await firstRead.promise;
        return [];
      } finally {
        activeReads -= 1;
      }
    });
    const scheduler = new ProviderRecoveryScheduler({
      source: source(listDue, () => Promise.resolve(null)),
      onDue: () => undefined,
      clock: () => 0,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn
    });

    scheduler.start();
    await vi.waitFor(() => expect(listDue).toHaveBeenCalledOnce());

    timers.fireNext(HOUR_MS);
    timers.fireNext(HOUR_MS);
    expect(listDue).toHaveBeenCalledOnce();

    firstRead.resolve();
    await scheduler.settled();

    expect(listDue).toHaveBeenCalledTimes(2);
    expect(maxActiveReads).toBe(1);

    await scheduler.stop();
  });

  it('does not create a zero-delay loop when a notified record remains due in the source', async () => {
    const due: ProviderRecoveryRecord = { provider: 'claude', notBefore: 500 };
    const timers = timerHarness();
    const onDue = vi.fn<(record: ProviderRecoveryRecord) => void>();
    const scheduler = new ProviderRecoveryScheduler({
      source: source(
        () => Promise.resolve([due]),
        () => Promise.resolve(due.notBefore)
      ),
      onDue,
      clock: () => 1_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn
    });

    scheduler.start();
    await scheduler.settled();

    expect(onDue).toHaveBeenCalledOnce();
    expect(timers.timers.filter((timer) => timer.active).map((timer) => timer.delay)).toEqual([
      HOUR_MS
    ]);

    await scheduler.stop();
  });

  it('stops timers immediately and drains an in-flight due callback without starting more work', async () => {
    const callback = deferred();
    const timers = timerHarness();
    const due: ProviderRecoveryRecord = { provider: 'codex', notBefore: 100 };
    const listDue = vi.fn(() => Promise.resolve([due]));
    const onDue = vi.fn(() => callback.promise);
    let notifyChanged: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const scheduler = new ProviderRecoveryScheduler({
      source: source(
        listDue,
        () => Promise.resolve(null),
        (listener) => {
          notifyChanged = listener;
          return unsubscribe;
        }
      ),
      onDue,
      clock: () => 200,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn
    });

    scheduler.start();
    await vi.waitFor(() => expect(onDue).toHaveBeenCalledOnce());
    const staleTimerCallbacks = timers.timers.map((timer) => timer.callback);

    let drained = false;
    const stopping = scheduler.stop().then(() => {
      drained = true;
    });
    await Promise.resolve();

    expect(drained).toBe(false);
    expect(timers.timers.every((timer) => !timer.active)).toBe(true);
    for (const staleCallback of staleTimerCallbacks) staleCallback();
    notifyChanged?.();
    expect(listDue).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();

    callback.resolve();
    await stopping;

    expect(drained).toBe(true);
    expect(listDue).toHaveBeenCalledOnce();
  });
});
