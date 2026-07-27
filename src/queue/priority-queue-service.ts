import { randomUUID } from 'node:crypto';

import type { PriorityQueueRepository } from '../db/priority-queue-repository';
import type {
  QueueClaimInput,
  QueueEnqueueReceipt,
  QueueLease,
  QueueSettlementInput,
  QueueTaskInput,
  QueueTaskReceipt,
  RedactedQueueDecision,
  TenantQueueView
} from './contracts';

type Clock = () => Date;
type LeaseTokenFactory = () => string;

export class PriorityQueueService {
  constructor(
    private readonly repository: PriorityQueueRepository,
    private readonly clock: Clock = () => new Date(),
    private readonly leaseTokenFactory: LeaseTokenFactory = randomUUID
  ) {}

  submit(input: QueueTaskInput): Promise<QueueEnqueueReceipt> {
    return this.repository.enqueue(input);
  }

  claim(input: Omit<QueueClaimInput, 'leaseToken' | 'now'>): Promise<QueueLease | null> {
    return this.repository.claimNext({
      ...input,
      leaseToken: this.leaseTokenFactory(),
      now: this.clock().toISOString()
    });
  }

  succeed(
    input: Omit<Extract<QueueSettlementInput, { outcome: 'succeeded' }>, 'outcome' | 'now'>
  ): Promise<QueueTaskReceipt> {
    return this.repository.settle({
      ...input,
      outcome: 'succeeded',
      now: this.clock().toISOString()
    });
  }

  fail(
    input: Omit<Extract<QueueSettlementInput, { outcome: 'failed' }>, 'outcome' | 'now'>
  ): Promise<QueueTaskReceipt> {
    return this.repository.settle({
      ...input,
      outcome: 'failed',
      now: this.clock().toISOString()
    });
  }

  readTenantQueue(input: { tenantId: string; limit: number }): Promise<TenantQueueView> {
    return this.repository.readTenantQueue({ ...input, now: this.clock().toISOString() });
  }

  readDecisionLog(input: { tenantId: string; limit: number }): Promise<RedactedQueueDecision[]> {
    return this.repository.readDecisionLog(input);
  }
}
