import { createHash } from 'node:crypto';

import { ClientIdSchema } from '../config/schemas';
import type { PriorityQueueService } from './priority-queue-service';
import { QueueWorkerIdSchema, type QueueFailureReason, type QueueLease } from './contracts';

const DEFAULT_WORKER_ID = 'jarvis:automation-cycle';
const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_TENANTS_PER_CYCLE = 25;
const MAX_TENANTS_PER_CYCLE = 100;

interface AutomationRunner {
  run(input: { clientId: string; automation: string; runId: string }): Promise<unknown>;
}

interface DurableAutomationRun {
  id: string;
  clientId: string;
  automation: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
}

export interface AutomationQueueCycleOptions {
  queue: Pick<PriorityQueueService, 'claim' | 'succeed' | 'fail'>;
  runner: AutomationRunner;
  findRunById(id: string): Promise<DurableAutomationRun | undefined>;
  listActiveTenantIds(): Promise<string[]>;
  now?: () => Date;
  workerId?: string;
  leaseDurationMs?: number;
  maxTenantsPerCycle?: number;
  executionAllowed: () => boolean | Promise<boolean>;
}

export interface AutomationCycleTaskResult {
  id: string;
  tenantId: string;
  lane: string;
  outcome: 'succeeded' | 'failed';
  reasonCode?: QueueFailureReason;
}

export interface AutomationCycleResult {
  startedAt: string;
  completedAt: string;
  inspectedTenantCount: number;
  claimedTaskCount: number;
  succeededTaskCount: number;
  failedTaskCount: number;
  tasks: AutomationCycleTaskResult[];
}

function validatedPositiveInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function queueRunId(tenantId: string, taskId: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([tenantId, taskId]), 'utf8')
    .digest('hex');
  return `queue_${digest}`;
}

/**
 * Executes at most one allowlisted automation per active tenant. Queue payloads
 * remain references only; this cycle deliberately has no arbitrary artifact,
 * project-task, operator-gate, command, network, or model execution capability.
 */
export class AutomationQueueCycle {
  private readonly now: () => Date;
  private readonly workerId: string;
  private readonly leaseDurationMs: number;
  private readonly maxTenantsPerCycle: number;

  constructor(private readonly options: AutomationQueueCycleOptions) {
    this.now = options.now ?? (() => new Date());
    this.workerId = QueueWorkerIdSchema.parse(options.workerId ?? DEFAULT_WORKER_ID);
    this.leaseDurationMs = validatedPositiveInteger(
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      'leaseDurationMs',
      1_000,
      86_400_000
    );
    this.maxTenantsPerCycle = validatedPositiveInteger(
      options.maxTenantsPerCycle ?? DEFAULT_MAX_TENANTS_PER_CYCLE,
      'maxTenantsPerCycle',
      1,
      MAX_TENANTS_PER_CYCLE
    );
  }

  async runOnce(): Promise<AutomationCycleResult> {
    const startedAt = this.now().toISOString();
    const tenantIds = [
      ...new Set((await this.options.listActiveTenantIds()).map((id) => ClientIdSchema.parse(id)))
    ]
      .sort()
      .slice(0, this.maxTenantsPerCycle);
    const tasks: AutomationCycleTaskResult[] = [];

    for (const tenantId of tenantIds) {
      // The same deny-first gate used by the supervisor is checked immediately
      // before every claim. Engaging the switch therefore leaves queued work
      // untouched instead of leasing it under a misleading "paused" posture.
      if (!(await this.options.executionAllowed())) break;
      const lease = await this.options.queue.claim({
        tenantId,
        workerId: this.workerId,
        leaseDurationMs: this.leaseDurationMs,
        payloadKinds: ['automation']
      });
      if (lease === null) continue;
      if (lease.tenantId !== tenantId) {
        throw new Error(`Queue claim crossed tenant boundary for ${tenantId}`);
      }
      tasks.push(await this.executeLease(lease));
    }

    const succeededTaskCount = tasks.filter(({ outcome }) => outcome === 'succeeded').length;
    return {
      startedAt,
      completedAt: this.now().toISOString(),
      inspectedTenantCount: tenantIds.length,
      claimedTaskCount: tasks.length,
      succeededTaskCount,
      failedTaskCount: tasks.length - succeededTaskCount,
      tasks
    };
  }

  private async executeLease(lease: QueueLease): Promise<AutomationCycleTaskResult> {
    if (lease.payload.kind !== 'automation' || lease.payload.inputRef !== undefined) {
      return this.failLease(lease, 'policy_blocked');
    }

    const runId = queueRunId(lease.tenantId, lease.id);
    const previousRun = await this.options.findRunById(runId);
    if (previousRun !== undefined) {
      const matchingSuccess =
        previousRun.id === runId &&
        previousRun.clientId === lease.tenantId &&
        previousRun.automation === lease.payload.automationId &&
        previousRun.status === 'succeeded';
      if (!matchingSuccess) {
        return this.failLease(lease, 'verification_failed');
      }
      return this.succeedLease(lease);
    }

    try {
      await this.options.runner.run({
        clientId: lease.tenantId,
        automation: lease.payload.automationId,
        runId
      });
    } catch {
      return this.failLease(lease, 'worker_error');
    }

    return this.succeedLease(lease);
  }

  private async succeedLease(lease: QueueLease): Promise<AutomationCycleTaskResult> {
    await this.options.queue.succeed({
      tenantId: lease.tenantId,
      taskId: lease.id,
      workerId: this.workerId,
      leaseToken: lease.lease.token,
      expectedVersion: lease.version
    });
    return {
      id: lease.id,
      tenantId: lease.tenantId,
      lane: lease.lane,
      outcome: 'succeeded'
    };
  }

  private async failLease(
    lease: QueueLease,
    reasonCode: QueueFailureReason
  ): Promise<AutomationCycleTaskResult> {
    await this.options.queue.fail({
      tenantId: lease.tenantId,
      taskId: lease.id,
      workerId: this.workerId,
      leaseToken: lease.lease.token,
      expectedVersion: lease.version,
      reasonCode
    });
    return {
      id: lease.id,
      tenantId: lease.tenantId,
      lane: lease.lane,
      outcome: 'failed',
      reasonCode
    };
  }
}
