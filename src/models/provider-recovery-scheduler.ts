import type { ModelProviderId } from './contracts';

const SAFETY_RECONCILIATION_MS = 60 * 60 * 1_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface ProviderRecoveryRecord {
  provider: ModelProviderId;
  /** Epoch milliseconds after which a real request may attempt half-open verification. */
  notBefore: number;
}

/**
 * Read-only recovery schedule projection. Circuit ownership remains outside this
 * scheduler: listing a record never claims, clears, or half-opens it.
 */
export interface ProviderRecoverySource {
  listDue(): Promise<readonly ProviderRecoveryRecord[]>;
  nextNotBefore(): Promise<number | null>;
  /** Push notification for durable writes; avoids polling between exact boundaries. */
  subscribe?(listener: () => void): () => void;
}

export interface ProviderRecoveryTimerHandle {
  unref?(): void;
}

export interface ProviderRecoverySchedulerOptions {
  source: ProviderRecoverySource;
  onDue(record: ProviderRecoveryRecord): void | Promise<void>;
  clock?: () => number;
  setTimeoutFn?: (callback: () => void, delay: number) => ProviderRecoveryTimerHandle;
  clearTimeoutFn?: (handle: ProviderRecoveryTimerHandle) => void;
}

function defaultSetTimeout(callback: () => void, delay: number): ProviderRecoveryTimerHandle {
  return setTimeout(callback, delay);
}

function defaultClearTimeout(handle: ProviderRecoveryTimerHandle): void {
  clearTimeout(handle as NodeJS.Timeout);
}

/**
 * Reconciles due recovery boundaries and publishes each one to an injected callback
 * for the lazy verification path. It never mutates circuit state or treats credential
 * presence as proof of recovery.
 */
export class ProviderRecoveryScheduler {
  private readonly clock: () => number;
  private readonly setTimeoutFn: (
    callback: () => void,
    delay: number
  ) => ProviderRecoveryTimerHandle;
  private readonly clearTimeoutFn: (handle: ProviderRecoveryTimerHandle) => void;
  private readonly notified = new Set<string>();
  private safetyTimer: ProviderRecoveryTimerHandle | undefined;
  private dueTimer: ProviderRecoveryTimerHandle | undefined;
  private currentReconciliation: Promise<void> | undefined;
  private unsubscribeSource: (() => void) | undefined;
  private reconcileAgain = false;
  private started = false;
  private stopped = false;

  constructor(private readonly options: ProviderRecoverySchedulerOptions) {
    this.clock = options.clock ?? Date.now;
    this.setTimeoutFn = options.setTimeoutFn ?? defaultSetTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? defaultClearTimeout;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    try {
      this.unsubscribeSource = this.options.source.subscribe?.(() => this.requestReconciliation());
    } catch {
      // Initial reconciliation and the hourly safety timer remain available if
      // an injected change-notification source cannot subscribe.
    }
    this.scheduleSafetyReconciliation();
    this.requestReconciliation();
  }

  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.reconcileAgain = false;
      this.unsubscribeFromSource();
      this.clearSafetyTimer();
      this.clearDueTimer();
    }
    await this.settled();
  }

  async settled(): Promise<void> {
    while (this.currentReconciliation !== undefined) {
      await this.currentReconciliation;
    }
  }

  private requestReconciliation(): void {
    if (this.stopped) return;
    if (this.currentReconciliation !== undefined) {
      this.reconcileAgain = true;
      return;
    }

    const work = this.runReconciliationLoop().catch(() => undefined);
    this.currentReconciliation = work;
    void work.then(() => {
      if (this.currentReconciliation === work) {
        this.currentReconciliation = undefined;
      }
      if (this.reconcileAgain && !this.stopped) {
        this.requestReconciliation();
      }
    });
  }

  private async runReconciliationLoop(): Promise<void> {
    do {
      this.reconcileAgain = false;
      await this.reconcileOnce();
    } while (this.reconcileAgain && !this.stopped);
  }

  private async reconcileOnce(): Promise<void> {
    let due: readonly ProviderRecoveryRecord[];
    try {
      due = await this.options.source.listDue();
    } catch {
      return;
    }
    if (this.stopped) return;

    for (const record of due) {
      if (this.stopped) return;
      if (!Number.isFinite(record.notBefore)) continue;
      const key = JSON.stringify([record.provider, record.notBefore]);
      if (this.notified.has(key)) continue;
      try {
        await this.options.onDue(record);
        this.notified.add(key);
      } catch {
        // One failure must not stop later providers, and the same boundary stays
        // retryable on a later reconciliation.
      }
    }
    if (this.stopped) return;

    let nextNotBefore: number | null;
    try {
      nextNotBefore = await this.options.source.nextNotBefore();
    } catch {
      return;
    }
    if (!this.stopped) this.scheduleDueReconciliation(nextNotBefore);
  }

  private scheduleSafetyReconciliation(): void {
    if (this.stopped) return;
    const handle = this.setTimeoutFn(() => {
      if (this.stopped || this.safetyTimer !== handle) return;
      this.safetyTimer = undefined;
      this.scheduleSafetyReconciliation();
      this.requestReconciliation();
    }, SAFETY_RECONCILIATION_MS);
    this.safetyTimer = handle;
    this.unref(handle);
  }

  private scheduleDueReconciliation(notBefore: number | null): void {
    this.clearDueTimer();
    const now = this.clock();
    if (this.stopped || notBefore === null || !Number.isFinite(notBefore) || notBefore <= now) {
      return;
    }

    const delay = Math.min(Math.ceil(notBefore - now), MAX_TIMEOUT_MS);
    const handle = this.setTimeoutFn(() => {
      if (this.stopped || this.dueTimer !== handle) return;
      this.dueTimer = undefined;
      this.requestReconciliation();
    }, delay);
    this.dueTimer = handle;
    this.unref(handle);
  }

  private clearSafetyTimer(): void {
    if (this.safetyTimer === undefined) return;
    this.clearTimer(this.safetyTimer);
    this.safetyTimer = undefined;
  }

  private unsubscribeFromSource(): void {
    if (this.unsubscribeSource === undefined) return;
    const unsubscribe = this.unsubscribeSource;
    this.unsubscribeSource = undefined;
    try {
      unsubscribe();
    } catch {
      // Shutdown remains safe even when an injected unsubscribe fails.
    }
  }

  private clearDueTimer(): void {
    if (this.dueTimer === undefined) return;
    this.clearTimer(this.dueTimer);
    this.dueTimer = undefined;
  }

  private clearTimer(handle: ProviderRecoveryTimerHandle): void {
    try {
      this.clearTimeoutFn(handle);
    } catch {
      // Shutdown and rescheduling remain best-effort even with an injected timer failure.
    }
  }

  private unref(handle: ProviderRecoveryTimerHandle): void {
    try {
      handle.unref?.();
    } catch {
      // A timer implementation without a working unref still retains correct scheduling.
    }
  }
}
