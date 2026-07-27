import { runWithDeadline } from '../utils/deadline';
import type { AutomationCycleResult, AutomationQueueCycle } from './automation-cycle';

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_CYCLE_TIMEOUT_MS = 30_000;
const DEADLINE_MESSAGE = 'Automation cycle exceeded its deadline';

export interface AutomationSchedulerIntervalHandle {
  unref(): void;
}

export interface AutomationCycleSchedulerOptions {
  cycle: Pick<AutomationQueueCycle, 'runOnce'>;
  intervalMs?: number;
  cycleTimeoutMs?: number;
  setIntervalFn?: (callback: () => void, delay: number) => AutomationSchedulerIntervalHandle;
  clearIntervalFn?: (handle: AutomationSchedulerIntervalHandle) => void;
  onCycle?: (result: AutomationCycleResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

interface ActiveCycleState {
  publishAllowed: boolean;
}

function defaultSetInterval(
  callback: () => void,
  delay: number
): AutomationSchedulerIntervalHandle {
  return setInterval(callback, delay);
}

function defaultClearInterval(handle: AutomationSchedulerIntervalHandle): void {
  clearInterval(handle as NodeJS.Timeout);
}

function validatedPositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
  return value;
}

/**
 * Rebuilds the public result from its allowlisted fields so publisher callbacks
 * never receive queue payloads, lease details, or accidental implementation data.
 */
function safeCycleResult(result: AutomationCycleResult): AutomationCycleResult {
  return {
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    inspectedTenantCount: result.inspectedTenantCount,
    claimedTaskCount: result.claimedTaskCount,
    succeededTaskCount: result.succeededTaskCount,
    failedTaskCount: result.failedTaskCount,
    tasks: result.tasks.map((task) => ({
      id: task.id,
      tenantId: task.tenantId,
      lane: task.lane,
      outcome: task.outcome,
      ...(task.reasonCode === undefined ? {} : { reasonCode: task.reasonCode })
    }))
  };
}

/**
 * Periodically invokes the bounded automation queue cycle. A deadline reports
 * slow work but does not pretend to cancel it: the underlying promise remains
 * the overlap guard and shutdown drain until it genuinely settles.
 */
export class AutomationCycleScheduler {
  private readonly intervalMs: number;
  private readonly cycleTimeoutMs: number;
  private readonly setIntervalFn: (
    callback: () => void,
    delay: number
  ) => AutomationSchedulerIntervalHandle;
  private readonly clearIntervalFn: (handle: AutomationSchedulerIntervalHandle) => void;
  private intervalHandle: AutomationSchedulerIntervalHandle | undefined;
  private activeWork: Promise<void> | undefined;
  private observedCycle: Promise<void> | undefined;
  private activeState: ActiveCycleState | undefined;
  private started = false;
  private stopped = false;

  constructor(private readonly options: AutomationCycleSchedulerOptions) {
    this.intervalMs = validatedPositive(options.intervalMs ?? DEFAULT_INTERVAL_MS, 'intervalMs');
    this.cycleTimeoutMs = Math.ceil(
      validatedPositive(options.cycleTimeoutMs ?? DEFAULT_CYCLE_TIMEOUT_MS, 'cycleTimeoutMs')
    );
    this.setIntervalFn = options.setIntervalFn ?? defaultSetInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? defaultClearInterval;
  }

  start(): void {
    if (this.started || this.stopped) return;

    this.started = true;
    this.intervalHandle = this.setIntervalFn(() => this.startCycle(), this.intervalMs);
    this.intervalHandle.unref();
    this.startCycle();
  }

  stop(): void {
    if (this.stopped) return;

    this.stopped = true;
    if (this.activeState !== undefined) {
      this.activeState.publishAllowed = false;
    }
    if (this.intervalHandle !== undefined) {
      this.clearIntervalFn(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  async settled(): Promise<void> {
    while (this.activeWork !== undefined || this.observedCycle !== undefined) {
      const activeWork = this.activeWork;
      const observedCycle = this.observedCycle;
      await Promise.all([
        activeWork?.catch(() => undefined) ?? Promise.resolve(),
        observedCycle ?? Promise.resolve()
      ]);
    }
  }

  private startCycle(): void {
    if (this.stopped || this.activeWork !== undefined) return;

    const state: ActiveCycleState = { publishAllowed: true };
    const activeWork = this.runAndPublish(state);
    this.activeState = state;
    this.activeWork = activeWork;
    void activeWork.then(
      () => this.completeActiveWork(activeWork, state),
      () => this.completeActiveWork(activeWork, state)
    );

    const deadline = runWithDeadline(() => activeWork, this.cycleTimeoutMs, DEADLINE_MESSAGE);
    const observedCycle: Promise<void> = deadline
      .then(
        () => undefined,
        async (error: unknown) => {
          state.publishAllowed = false;
          await this.reportError(error);
        }
      )
      .then(() => {
        this.observedCycle = undefined;
      });
    this.observedCycle = observedCycle;
  }

  private async runAndPublish(state: ActiveCycleState): Promise<void> {
    const result = await this.options.cycle.runOnce();
    if (this.stopped || !state.publishAllowed) return;
    await this.options.onCycle?.(safeCycleResult(result));
  }

  private completeActiveWork(activeWork: Promise<void>, state: ActiveCycleState): void {
    if (this.activeWork === activeWork) {
      this.activeWork = undefined;
    }
    if (this.activeState === state) {
      this.activeState = undefined;
    }
  }

  private async reportError(error: unknown): Promise<void> {
    try {
      await this.options.onError?.(error);
    } catch {
      // Error-reporting failures must not become background unhandled rejections.
    }
  }
}
