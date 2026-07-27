import type { ToolSmith, ToolSmithProposal } from '../agents/toolsmith';
import type { HealthProvider, HealthResult } from '../gateway/app';
import { runWithDeadline } from '../utils/deadline';

const DEFAULT_INTERVAL_MS = 15 * 60 * 1_000;
const DEFAULT_CYCLE_TIMEOUT_MS = 30_000;

export interface IntervalHandle {
  unref(): void;
}

export interface MonitoringCycleResult {
  health: HealthResult;
  proposals: ToolSmithProposal[];
}

export interface MonitoringSchedulerOptions {
  heartbeat: HealthProvider;
  toolsmith: Pick<ToolSmith, 'analyze'>;
  intervalMs?: number;
  cycleTimeoutMs?: number;
  setIntervalFn?: (callback: () => void, delay: number) => IntervalHandle;
  clearIntervalFn?: (handle: IntervalHandle) => void;
  onCycle?: (result: MonitoringCycleResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

function defaultSetInterval(callback: () => void, delay: number): IntervalHandle {
  return setInterval(callback, delay);
}

function defaultClearInterval(handle: IntervalHandle): void {
  clearInterval(handle as NodeJS.Timeout);
}

export class MonitoringScheduler {
  private readonly intervalMs: number;
  private readonly cycleTimeoutMs: number;
  private readonly setIntervalFn: (callback: () => void, delay: number) => IntervalHandle;
  private readonly clearIntervalFn: (handle: IntervalHandle) => void;
  private intervalHandle: IntervalHandle | undefined;
  private currentCycle: Promise<void> | undefined;
  private activeWork: Promise<void> | undefined;
  private started = false;
  private stopped = false;

  constructor(private readonly options: MonitoringSchedulerOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new RangeError('intervalMs must be a finite positive number');
    }
    const cycleTimeoutMs = options.cycleTimeoutMs ?? DEFAULT_CYCLE_TIMEOUT_MS;
    if (!Number.isFinite(cycleTimeoutMs) || cycleTimeoutMs <= 0) {
      throw new RangeError('cycleTimeoutMs must be a finite positive number');
    }
    this.cycleTimeoutMs = Math.ceil(cycleTimeoutMs);

    this.setIntervalFn = options.setIntervalFn ?? defaultSetInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? defaultClearInterval;
  }

  start(): void {
    if (this.started || this.stopped) {
      return;
    }

    this.started = true;
    this.intervalHandle = this.setIntervalFn(() => this.startCycle(), this.intervalMs);
    this.intervalHandle.unref();
    this.startCycle();
  }

  stop(): void {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    if (this.intervalHandle !== undefined) {
      this.clearIntervalFn(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  async settled(): Promise<void> {
    while (this.currentCycle !== undefined) {
      await this.currentCycle;
    }
  }

  private startCycle(): void {
    if (this.stopped || this.currentCycle !== undefined || this.activeWork !== undefined) {
      return;
    }

    const activeWork = this.runCycle();
    this.activeWork = activeWork;
    void activeWork.then(
      () => this.completeActiveWork(activeWork),
      () => this.completeActiveWork(activeWork)
    );
    const cycle = runWithDeadline(
      () => activeWork,
      this.cycleTimeoutMs,
      'Monitoring cycle exceeded its deadline'
    );
    this.currentCycle = cycle.then(
      () => this.completeCurrentCycle(),
      (error: unknown) => {
        this.reportError(error);
        this.completeCurrentCycle();
      }
    );
  }

  private async runCycle(): Promise<void> {
    const health = await this.options.heartbeat.check();
    if (this.stopped) {
      return;
    }
    const proposals = await this.options.toolsmith.analyze();

    if (!this.stopped) {
      await this.options.onCycle?.({ health, proposals });
    }
  }

  private completeCurrentCycle(): void {
    this.currentCycle = undefined;
  }

  private completeActiveWork(activeWork: Promise<void>): void {
    if (this.activeWork === activeWork) {
      this.activeWork = undefined;
    }
  }

  private reportError(error: unknown): void {
    try {
      void Promise.resolve(this.options.onError?.(error)).catch(() => undefined);
    } catch {
      // Monitoring failures must never surface as unhandled background rejections.
    }
  }
}
