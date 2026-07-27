import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QueueLease } from '../../src/queue/contracts';
import { AutomationQueueCycle } from '../../src/queue/automation-cycle';

const at = '2026-07-18T22:00:00.000Z';

function noPreviousRun() {
  return Promise.resolve(undefined);
}

function executionAllowed() {
  return true;
}

function lease(id: string, tenantId: string, inputRef?: string): QueueLease {
  return {
    id,
    tenantId,
    lane: 'delivery',
    payload: {
      kind: 'automation',
      automationId: 'daily-report',
      ...(inputRef === undefined ? {} : { inputRef })
    },
    policy: { band: 'P1', impact: 8, urgency: 6, effort: 3 },
    version: 2,
    effectiveScore: 101,
    lease: { token: `lease-${id}`, expiresAt: '2026-07-18T22:05:00.000Z', attempt: 1 }
  };
}

describe('AutomationQueueCycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims one automation per sorted active tenant and settles successful work', async () => {
    const queue = {
      claim: vi
        .fn()
        .mockResolvedValueOnce(lease('task-acme', 'acme_corp'))
        .mockResolvedValueOnce(null),
      succeed: vi.fn().mockResolvedValue({}),
      fail: vi.fn().mockResolvedValue({})
    };
    const runner = { run: vi.fn().mockResolvedValue({ run: { id: 'run-one' } }) };
    const cycle = new AutomationQueueCycle({
      queue,
      runner,
      findRunById: noPreviousRun,
      listActiveTenantIds: () => Promise.resolve(['zeta_client', 'acme_corp', 'acme_corp']),
      executionAllowed,
      now: () => new Date(at),
      workerId: 'jarvis:automation-cycle',
      leaseDurationMs: 300_000
    });

    await expect(cycle.runOnce()).resolves.toEqual({
      startedAt: at,
      completedAt: at,
      inspectedTenantCount: 2,
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
    });
    expect(queue.claim).toHaveBeenNthCalledWith(1, {
      tenantId: 'acme_corp',
      workerId: 'jarvis:automation-cycle',
      leaseDurationMs: 300_000,
      payloadKinds: ['automation']
    });
    expect(queue.claim).toHaveBeenNthCalledWith(2, {
      tenantId: 'zeta_client',
      workerId: 'jarvis:automation-cycle',
      leaseDurationMs: 300_000,
      payloadKinds: ['automation']
    });
    expect(runner.run).toHaveBeenCalledWith({
      clientId: 'acme_corp',
      automation: 'daily-report',
      runId: 'queue_e995410c9252c25f97e7d06a7b488d06dff84afdf3b88f4f5ba688ad65664970'
    });
    expect(queue.succeed).toHaveBeenCalledWith({
      tenantId: 'acme_corp',
      taskId: 'task-acme',
      workerId: 'jarvis:automation-cycle',
      leaseToken: 'lease-task-acme',
      expectedVersion: 2
    });
    expect(queue.fail).not.toHaveBeenCalled();
  });

  it('fails closed on unresolved input references without invoking the automation', async () => {
    const queue = {
      claim: vi.fn().mockResolvedValue(lease('referenced-task', 'acme_corp', 'input-private')),
      succeed: vi.fn().mockResolvedValue({}),
      fail: vi.fn().mockResolvedValue({})
    };
    const runner = { run: vi.fn() };
    const cycle = new AutomationQueueCycle({
      queue,
      runner,
      findRunById: noPreviousRun,
      listActiveTenantIds: () => Promise.resolve(['acme_corp']),
      executionAllowed,
      now: () => new Date(at)
    });

    const result = await cycle.runOnce();

    expect(result.tasks).toEqual([
      {
        id: 'referenced-task',
        tenantId: 'acme_corp',
        lane: 'delivery',
        outcome: 'failed',
        reasonCode: 'policy_blocked'
      }
    ]);
    expect(runner.run).not.toHaveBeenCalled();
    expect(queue.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'referenced-task',
        reasonCode: 'policy_blocked'
      })
    );
  });

  it('records a safe worker failure and continues with the next active tenant', async () => {
    const queue = {
      claim: vi
        .fn()
        .mockResolvedValueOnce(lease('failed-task', 'acme_corp'))
        .mockResolvedValueOnce(lease('good-task', 'zeta_client')),
      succeed: vi.fn().mockResolvedValue({}),
      fail: vi.fn().mockResolvedValue({})
    };
    const runner = {
      run: vi
        .fn()
        .mockRejectedValueOnce(new Error('private worker detail'))
        .mockResolvedValueOnce({})
    };
    const cycle = new AutomationQueueCycle({
      queue,
      runner,
      findRunById: noPreviousRun,
      listActiveTenantIds: () => Promise.resolve(['acme_corp', 'zeta_client']),
      executionAllowed,
      now: () => new Date(at)
    });

    const result = await cycle.runOnce();

    expect(result).toMatchObject({
      claimedTaskCount: 2,
      succeededTaskCount: 1,
      failedTaskCount: 1
    });
    expect(JSON.stringify(result)).not.toContain('private worker detail');
    expect(queue.fail).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'failed-task', reasonCode: 'worker_error' })
    );
    expect(queue.succeed).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'good-task' }));
  });

  it('rejects unsafe or unbounded cycle configuration before claiming work', () => {
    const base = {
      queue: { claim: vi.fn(), succeed: vi.fn(), fail: vi.fn() },
      runner: { run: vi.fn() },
      findRunById: noPreviousRun,
      listActiveTenantIds: () => Promise.resolve([]),
      executionAllowed
    };

    expect(() => new AutomationQueueCycle({ ...base, maxTenantsPerCycle: 0 })).toThrow(
      'maxTenantsPerCycle'
    );
    expect(() => new AutomationQueueCycle({ ...base, leaseDurationMs: 999 })).toThrow(
      'leaseDurationMs'
    );
  });

  it('owns a real clock and bounded defaults when no tenant has automation work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at));
    const queue = { claim: vi.fn(), succeed: vi.fn(), fail: vi.fn() };
    const cycle = new AutomationQueueCycle({
      queue,
      runner: { run: vi.fn() },
      findRunById: noPreviousRun,
      listActiveTenantIds: () => Promise.resolve([]),
      executionAllowed
    });

    await expect(cycle.runOnce()).resolves.toEqual({
      startedAt: at,
      completedAt: at,
      inspectedTenantCount: 0,
      claimedTaskCount: 0,
      succeededTaskCount: 0,
      failedTaskCount: 0,
      tasks: []
    });
    expect(queue.claim).not.toHaveBeenCalled();
  });

  it('does not claim queued work while the agency kill switch is engaged', async () => {
    const queue = { claim: vi.fn(), succeed: vi.fn(), fail: vi.fn() };
    const runner = { run: vi.fn() };
    const cycle = new AutomationQueueCycle({
      queue,
      runner,
      findRunById: noPreviousRun,
      listActiveTenantIds: () => Promise.resolve(['acme_corp', 'zeta_client']),
      executionAllowed: () => false,
      now: () => new Date(at)
    });

    await expect(cycle.runOnce()).resolves.toMatchObject({
      inspectedTenantCount: 2,
      claimedTaskCount: 0,
      succeededTaskCount: 0,
      failedTaskCount: 0,
      tasks: []
    });
    expect(queue.claim).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('stops claiming additional tenants if the kill switch engages mid-cycle', async () => {
    const executionAllowed = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const queue = {
      claim: vi.fn().mockResolvedValueOnce(null),
      succeed: vi.fn(),
      fail: vi.fn()
    };
    const cycle = new AutomationQueueCycle({
      queue,
      runner: { run: vi.fn() },
      findRunById: noPreviousRun,
      listActiveTenantIds: () => Promise.resolve(['acme_corp', 'zeta_client']),
      executionAllowed,
      now: () => new Date(at)
    });

    await cycle.runOnce();

    expect(queue.claim).toHaveBeenCalledTimes(1);
    expect(queue.claim).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'acme_corp' }));
  });

  it('rejects a lease that crosses the tenant selected by the cycle', async () => {
    const queue = {
      claim: vi.fn().mockResolvedValue(lease('crossed-task', 'zeta_client')),
      succeed: vi.fn(),
      fail: vi.fn()
    };
    const runner = { run: vi.fn() };
    const cycle = new AutomationQueueCycle({
      queue,
      runner,
      findRunById: noPreviousRun,
      listActiveTenantIds: () => Promise.resolve(['acme_corp']),
      executionAllowed,
      now: () => new Date(at)
    });

    await expect(cycle.runOnce()).rejects.toThrow(/crossed tenant boundary for acme_corp/i);
    expect(runner.run).not.toHaveBeenCalled();
    expect(queue.succeed).not.toHaveBeenCalled();
    expect(queue.fail).not.toHaveBeenCalled();
  });

  it('settles a reclaimed task from its matching durable success without executing twice', async () => {
    const queue = {
      claim: vi.fn().mockResolvedValue(lease('task-acme', 'acme_corp')),
      succeed: vi.fn().mockResolvedValue({}),
      fail: vi.fn().mockResolvedValue({})
    };
    const runner = { run: vi.fn() };
    const findRunById = vi.fn().mockResolvedValue({
      id: 'queue_e995410c9252c25f97e7d06a7b488d06dff84afdf3b88f4f5ba688ad65664970',
      clientId: 'acme_corp',
      automation: 'daily-report',
      status: 'succeeded'
    });
    const cycle = new AutomationQueueCycle({
      queue,
      runner,
      findRunById,
      listActiveTenantIds: () => Promise.resolve(['acme_corp']),
      executionAllowed,
      now: () => new Date(at)
    });

    await expect(cycle.runOnce()).resolves.toMatchObject({
      claimedTaskCount: 1,
      succeededTaskCount: 1,
      failedTaskCount: 0
    });
    expect(findRunById).toHaveBeenCalledWith(
      'queue_e995410c9252c25f97e7d06a7b488d06dff84afdf3b88f4f5ba688ad65664970'
    );
    expect(runner.run).not.toHaveBeenCalled();
    expect(queue.succeed).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-acme' }));
  });

  it.each([
    ['failed', 'acme_corp', 'daily-report'],
    ['running', 'acme_corp', 'daily-report'],
    ['succeeded', 'other_client', 'daily-report'],
    ['succeeded', 'acme_corp', 'other-automation']
  ] as const)(
    'fails closed instead of replaying an existing %s or mismatched durable run',
    async (status, clientId, automation) => {
      const queue = {
        claim: vi.fn().mockResolvedValue(lease('task-acme', 'acme_corp')),
        succeed: vi.fn().mockResolvedValue({}),
        fail: vi.fn().mockResolvedValue({})
      };
      const runner = { run: vi.fn() };
      const cycle = new AutomationQueueCycle({
        queue,
        runner,
        findRunById: () =>
          Promise.resolve({
            id: 'queue_e995410c9252c25f97e7d06a7b488d06dff84afdf3b88f4f5ba688ad65664970',
            clientId,
            automation,
            status
          }),
        listActiveTenantIds: () => Promise.resolve(['acme_corp']),
        executionAllowed,
        now: () => new Date(at)
      });

      await expect(cycle.runOnce()).resolves.toMatchObject({
        claimedTaskCount: 1,
        succeededTaskCount: 0,
        failedTaskCount: 1,
        tasks: [{ id: 'task-acme', outcome: 'failed', reasonCode: 'verification_failed' }]
      });
      expect(runner.run).not.toHaveBeenCalled();
      expect(queue.fail).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task-acme', reasonCode: 'verification_failed' })
      );
    }
  );
});
