import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PriorityQueueRepository } from '../../src/db/priority-queue-repository';
import type { QueueClaimInput } from '../../src/queue/contracts';
import { PriorityQueueService } from '../../src/queue/priority-queue-service';

describe('PriorityQueueService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('owns clock and lease-token generation while delegating only typed tenant-scoped operations', async () => {
    const receipt = {
      id: 'task-one',
      tenantId: 'jarvis',
      lane: 'delivery',
      payloadKind: 'project_task' as const,
      policy: { band: 'P1' as const, impact: 1, urgency: 1, effort: 1 },
      state: 'queued' as const,
      version: 1,
      dependencyCount: 0,
      createdAt: '2026-07-18T10:00:00.000Z',
      availableAt: '2026-07-18T10:00:00.000Z'
    };
    const repository = {
      enqueue: vi.fn().mockResolvedValue(receipt),
      claimNext: vi.fn().mockResolvedValue(null),
      settle: vi.fn().mockResolvedValue(receipt),
      readTenantQueue: vi.fn().mockResolvedValue({
        tenantId: 'jarvis',
        returnedTaskCount: 0,
        truncated: false,
        lanes: []
      }),
      readDecisionLog: vi.fn().mockResolvedValue([])
    };
    const service = new PriorityQueueService(
      repository as unknown as PriorityQueueRepository,
      () => new Date('2026-07-18T10:00:00.000Z'),
      () => 'lease-generated'
    );

    const submitted = {
      id: 'task-one',
      tenantId: 'jarvis',
      lane: 'delivery',
      source: {
        kind: 'project' as const,
        id: 'source-task-one',
        occurredAt: '2026-07-18T10:00:00.000Z'
      },
      payload: {
        kind: 'project_task' as const,
        projectId: 'agency_core',
        taskType: 'build' as const
      },
      policy: { band: 'P1' as const, impact: 1, urgency: 1, effort: 1 },
      dependencies: []
    };
    await service.submit(submitted);
    await service.claim({ tenantId: 'jarvis', workerId: 'worker-one', leaseDurationMs: 30_000 });
    await service.succeed({
      tenantId: 'jarvis',
      taskId: 'task-one',
      workerId: 'worker-one',
      leaseToken: 'lease-one',
      expectedVersion: 2
    });
    await service.fail({
      tenantId: 'jarvis',
      taskId: 'task-two',
      workerId: 'worker-two',
      leaseToken: 'lease-two',
      expectedVersion: 4,
      reasonCode: 'verification_failed'
    });
    await service.readTenantQueue({ tenantId: 'jarvis', limit: 10 });
    await service.readDecisionLog({ tenantId: 'jarvis', limit: 10 });

    expect(repository.enqueue).toHaveBeenCalledWith(submitted);
    expect(repository.claimNext).toHaveBeenCalledWith({
      tenantId: 'jarvis',
      workerId: 'worker-one',
      leaseToken: 'lease-generated',
      now: '2026-07-18T10:00:00.000Z',
      leaseDurationMs: 30_000
    });
    expect(repository.settle).toHaveBeenNthCalledWith(1, {
      tenantId: 'jarvis',
      taskId: 'task-one',
      workerId: 'worker-one',
      leaseToken: 'lease-one',
      expectedVersion: 2,
      outcome: 'succeeded',
      now: '2026-07-18T10:00:00.000Z'
    });
    expect(repository.settle).toHaveBeenNthCalledWith(2, {
      tenantId: 'jarvis',
      taskId: 'task-two',
      workerId: 'worker-two',
      leaseToken: 'lease-two',
      expectedVersion: 4,
      reasonCode: 'verification_failed',
      outcome: 'failed',
      now: '2026-07-18T10:00:00.000Z'
    });
    expect(repository.readTenantQueue).toHaveBeenCalledWith({
      tenantId: 'jarvis',
      limit: 10,
      now: '2026-07-18T10:00:00.000Z'
    });
    expect(repository.readDecisionLog).toHaveBeenCalledWith({ tenantId: 'jarvis', limit: 10 });
  });

  it('owns safe clock and opaque lease-token defaults when callers do not inject them', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T10:00:00.000Z'));
    const claimNext = vi.fn<(input: QueueClaimInput) => Promise<null>>().mockResolvedValue(null);
    const repository = {
      claimNext
    };
    const service = new PriorityQueueService(repository as unknown as PriorityQueueRepository);

    await expect(
      service.claim({
        tenantId: 'jarvis',
        workerId: 'worker-one',
        leaseDurationMs: 30_000,
        payloadKinds: ['automation']
      })
    ).resolves.toBeNull();
    const claim = claimNext.mock.calls[0]?.[0];
    expect(claim).toMatchObject({
      tenantId: 'jarvis',
      workerId: 'worker-one',
      leaseDurationMs: 30_000,
      payloadKinds: ['automation'],
      now: '2026-07-18T10:00:00.000Z'
    });
    expect(claim?.leaseToken).toMatch(/^[a-f0-9-]{36}$/);
  });
});
