import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import { PriorityQueueRepository } from '../../src/db/priority-queue-repository';
import { QueueTaskInputSchema } from '../../src/queue/contracts';

const projectRoot = join(__dirname, '..', '..');
const at = '2026-07-18T10:00:00.000Z';

function task(
  id: string,
  overrides: Partial<Parameters<PriorityQueueRepository['enqueue']>[0]> = {}
): Parameters<PriorityQueueRepository['enqueue']>[0] {
  return {
    id,
    tenantId: 'jarvis',
    lane: 'delivery',
    source: { kind: 'project', id: `source-${id}`, occurredAt: at },
    payload: {
      kind: 'project_task',
      projectId: 'agency_core',
      taskType: 'build',
      artifactRef: `artifact-${id}`
    },
    policy: { band: 'P1', impact: 7, urgency: 5, effort: 4 },
    dependencies: [],
    ...overrides
  };
}

describe('PriorityQueueRepository', () => {
  let temporaryRoot: string;
  let context: GlobalDatabaseContext;
  let queue: PriorityQueueRepository;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-priority-queue-test-'));
    context = await createDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    queue = new PriorityQueueRepository(context.db);
  });

  afterEach(async () => {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('installs constrained queue tables, indexes, and append-only event triggers', () => {
    const objects = context.sqlite
      .prepare(
        `SELECT type, name FROM sqlite_master
         WHERE name LIKE 'work_queue_%' OR name LIKE 'idx_work_queue_%'
         ORDER BY type, name`
      )
      .all() as Array<{ type: string; name: string }>;

    expect(objects.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'work_queue_tasks',
        'work_queue_dependencies',
        'work_queue_events',
        'work_queue_lanes',
        'work_queue_tenant_cursors',
        'idx_work_queue_ready',
        'work_queue_events_no_delete',
        'work_queue_events_no_update',
        'work_queue_verification_holds',
        'work_queue_tasks_hold_fence'
      ])
    );
  });

  it('accepts strict reference-only payloads and rejects arbitrary content', () => {
    expect(() =>
      QueueTaskInputSchema.parse({
        ...task('strict-task'),
        payload: {
          kind: 'project_task',
          projectId: 'agency_core',
          taskType: 'build',
          artifactRef: 'artifact-strict-task',
          prompt: 'raw tenant secret'
        }
      })
    ).toThrow();
    expect(() =>
      QueueTaskInputSchema.parse({ ...task('bad-band'), policy: { band: 'urgent' } })
    ).toThrow();
    expect(() =>
      QueueTaskInputSchema.parse({ ...task('model-priority'), modelPriority: 1 })
    ).toThrow();
    expect(() =>
      QueueTaskInputSchema.parse({
        ...task('duplicate-dependency'),
        dependencies: ['dependency', 'dependency']
      })
    ).toThrow('dependencies must be unique');
    expect(() =>
      QueueTaskInputSchema.parse({
        ...task('self-dependency'),
        dependencies: ['self-dependency']
      })
    ).toThrow('a task cannot depend on itself');
    expect(() =>
      QueueTaskInputSchema.parse({
        ...task('backwards-availability'),
        availableAt: '2026-07-18T09:59:59.000Z'
      })
    ).toThrow('availableAt must not precede source.occurredAt');
  });

  it('makes exact source retries idempotent and rejects conflicting replays', async () => {
    const input = task('source-retry');
    const first = await queue.enqueue(input);
    expect(first.inserted).toBe(true);

    // An exact retry returns the same task but must report that it created nothing, so callers
    // can tell "indexed new work" apart from "this was already here".
    const retry = await queue.enqueue(input);
    expect(retry).toEqual({ ...first, inserted: false });
    await expect(
      queue.enqueue({
        ...task('source-conflict'),
        source: input.source,
        policy: { ...input.policy, urgency: input.policy.urgency + 1 }
      })
    ).rejects.toThrow('already exists with different work');

    const counts = context.sqlite
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM work_queue_tasks) AS tasks,
           (SELECT COUNT(*) FROM work_queue_events) AS events`
      )
      .get() as { tasks: number; events: number };
    expect(counts).toEqual({ tasks: 1, events: 1 });
  });

  it('keeps dependencies tenant-local and claims only after every dependency succeeds', async () => {
    await queue.enqueue(task('dependency'));
    const dependant = task('dependant', {
      lane: 'verification',
      dependencies: ['dependency']
    });
    const dependantReceipt = await queue.enqueue(dependant);
    await expect(queue.enqueue(dependant)).resolves.toEqual({
      ...dependantReceipt,
      inserted: false
    });

    const first = await queue.claimNext({
      tenantId: 'jarvis',
      workerId: 'worker-one',
      leaseToken: 'lease-one',
      now: at,
      leaseDurationMs: 60_000
    });
    expect(first?.id).toBe('dependency');
    await queue.settle({
      tenantId: 'jarvis',
      taskId: 'dependency',
      workerId: 'worker-one',
      leaseToken: 'lease-one',
      expectedVersion: first?.version ?? 0,
      outcome: 'succeeded',
      now: '2026-07-18T10:00:30.000Z'
    });

    await expect(
      queue.claimNext({
        tenantId: 'jarvis',
        workerId: 'worker-two',
        leaseToken: 'lease-two',
        now: '2026-07-18T10:00:31.000Z',
        leaseDurationMs: 60_000
      })
    ).resolves.toMatchObject({ id: 'dependant' });

    await queue.enqueue(task('other-tenant-dependency', { tenantId: 'acme_corp' }));
    await expect(
      queue.enqueue(
        task('cross-tenant', {
          dependencies: ['other-tenant-dependency']
        })
      )
    ).rejects.toThrow('missing same-tenant dependencies');
  });

  it('keeps dependants blocked when a predecessor fails', async () => {
    await queue.enqueue(task('failed-predecessor'));
    await queue.enqueue(task('blocked-dependant', { dependencies: ['failed-predecessor'] }));
    const lease = await queue.claimNext({
      tenantId: 'jarvis',
      workerId: 'worker-one',
      leaseToken: 'lease-failure',
      now: at,
      leaseDurationMs: 60_000
    });
    await queue.settle({
      tenantId: 'jarvis',
      taskId: 'failed-predecessor',
      workerId: 'worker-one',
      leaseToken: 'lease-failure',
      expectedVersion: lease?.version ?? 0,
      outcome: 'failed',
      reasonCode: 'worker_error',
      now: '2026-07-18T10:00:30.000Z'
    });

    await expect(
      queue.claimNext({
        tenantId: 'jarvis',
        workerId: 'worker-two',
        leaseToken: 'lease-blocked',
        now: '2026-07-18T10:00:31.000Z',
        leaseDurationMs: 60_000
      })
    ).resolves.toBeNull();
    await expect(
      queue.readTenantQueue({ tenantId: 'jarvis', limit: 10, now: at })
    ).resolves.toMatchObject({
      lanes: [
        {
          blocked: [expect.objectContaining({ id: 'blocked-dependant', blockedDependencyCount: 1 })]
        }
      ]
    });
  });

  it('exposes only the bounded automation identifier needed for executor binding checks', async () => {
    await queue.enqueue(
      task('automation-binding-check', {
        payload: { kind: 'automation', automationId: 'daily-report' }
      })
    );

    const view = await queue.readTenantQueue({ tenantId: 'jarvis', limit: 10, now: at });

    expect(view.lanes[0]?.ready[0]).toMatchObject({
      id: 'automation-binding-check',
      payloadKind: 'automation',
      automationId: 'daily-report'
    });
    expect(JSON.stringify(view)).not.toContain('inputRef');
  });

  it('honors bands, aging, and least-recently-served lane-head arbitration', async () => {
    await queue.enqueue(
      task('old-aged', {
        lane: 'delivery',
        source: { kind: 'project', id: 'source-old-aged', occurredAt: '2026-07-17T00:00:00.000Z' },
        policy: { band: 'P1', impact: 1, urgency: 1, effort: 10 }
      })
    );
    await queue.enqueue(
      task('fresh-high', {
        lane: 'delivery',
        policy: { band: 'P1', impact: 7, urgency: 5, effort: 4 }
      })
    );
    await queue.enqueue(
      task('peer-lane', {
        lane: 'research',
        policy: { band: 'P1', impact: 2, urgency: 2, effort: 9 }
      })
    );
    await queue.enqueue(
      task('lower-band', {
        lane: 'security',
        policy: { band: 'P2', impact: 10, urgency: 10, effort: 1 }
      })
    );

    const first = await queue.claimNext({
      tenantId: 'jarvis',
      workerId: 'worker-one',
      leaseToken: 'lease-one',
      now: at,
      leaseDurationMs: 60_000
    });
    expect(first).toMatchObject({ id: 'old-aged', policy: { band: 'P1' } });

    const second = await queue.claimNext({
      tenantId: 'jarvis',
      workerId: 'worker-two',
      leaseToken: 'lease-two',
      now: at,
      leaseDurationMs: 60_000
    });
    expect(second).toMatchObject({ id: 'peer-lane', lane: 'research' });

    const third = await queue.claimNext({
      tenantId: 'jarvis',
      workerId: 'worker-three',
      leaseToken: 'lease-three',
      now: at,
      leaseDurationMs: 60_000
    });
    expect(third).toMatchObject({ id: 'fresh-high', lane: 'delivery' });
  });

  it('lets a worker claim only explicitly allowlisted payload kinds', async () => {
    await queue.enqueue(
      task('manual-security-gate', {
        policy: { band: 'P0', impact: 10, urgency: 10, effort: 1 },
        payload: {
          kind: 'operator_gate',
          gateType: 'security',
          subjectRef: 'review-security-boundary'
        }
      })
    );
    await queue.enqueue(
      task('daily-report-automation', {
        policy: { band: 'P3', impact: 2, urgency: 1, effort: 2 },
        payload: { kind: 'automation', automationId: 'daily-report' }
      })
    );

    const automation = await queue.claimNext({
      tenantId: 'jarvis',
      workerId: 'automation-cycle',
      leaseToken: 'lease-automation',
      now: at,
      leaseDurationMs: 60_000,
      payloadKinds: ['automation']
    });
    expect(automation).toMatchObject({
      id: 'daily-report-automation',
      payload: { kind: 'automation', automationId: 'daily-report' }
    });

    const manual = await queue.claimNext({
      tenantId: 'jarvis',
      workerId: 'operator-console',
      leaseToken: 'lease-manual',
      now: at,
      leaseDurationMs: 60_000
    });
    expect(manual).toMatchObject({
      id: 'manual-security-gate',
      payload: { kind: 'operator_gate' }
    });
  });

  it('leases a task at most once, reclaims expiry, and fences stale owners by token and version', async () => {
    await queue.enqueue(task('leased-task'));
    await expect(
      queue.claimNext({
        tenantId: 'jarvis',
        workerId: 'worker-invalid',
        leaseToken: 'lease-invalid',
        now: at,
        leaseDurationMs: 1
      })
    ).rejects.toThrow();

    const [first, contender] = await Promise.all([
      queue.claimNext({
        tenantId: 'jarvis',
        workerId: 'worker-one',
        leaseToken: 'lease-one',
        now: at,
        leaseDurationMs: 1_000
      }),
      queue.claimNext({
        tenantId: 'jarvis',
        workerId: 'worker-two',
        leaseToken: 'lease-two',
        now: at,
        leaseDurationMs: 1_000
      })
    ]);
    expect([first, contender].filter(Boolean)).toHaveLength(1);

    const reclaimed = await queue.claimNext({
      tenantId: 'jarvis',
      workerId: 'worker-two',
      leaseToken: 'lease-reclaimed',
      now: '2026-07-18T10:00:02.000Z',
      leaseDurationMs: 1_000
    });
    expect(reclaimed).toMatchObject({
      id: 'leased-task',
      version: 3,
      lease: { token: 'lease-reclaimed', attempt: 2 }
    });

    await expect(
      queue.settle({
        tenantId: 'jarvis',
        taskId: 'leased-task',
        workerId: 'worker-one',
        leaseToken: 'lease-one',
        expectedVersion: 2,
        outcome: 'succeeded',
        now: '2026-07-18T10:00:02.500Z'
      })
    ).rejects.toThrow('lease or version conflict');
  });

  it('settles transactionally and leaves an immutable decision history', async () => {
    await queue.enqueue(task('audited-task'));
    const lease = await queue.claimNext({
      tenantId: 'jarvis',
      workerId: 'worker-one',
      leaseToken: 'lease-audited',
      now: at,
      leaseDurationMs: 60_000
    });
    await queue.settle({
      tenantId: 'jarvis',
      taskId: 'audited-task',
      workerId: 'worker-one',
      leaseToken: 'lease-audited',
      expectedVersion: lease?.version ?? 0,
      outcome: 'failed',
      reasonCode: 'verification_failed',
      now: '2026-07-18T10:00:30.000Z'
    });

    const events = await queue.readDecisionLog({ tenantId: 'jarvis', limit: 10 });
    expect(events.map(({ decisionCode }) => decisionCode)).toEqual([
      'lease_failed',
      'lane_head_claimed',
      'source_accepted'
    ]);
    expect(JSON.stringify(events)).not.toContain('lease-audited');
    expect(JSON.stringify(events)).not.toContain('artifact-audited-task');

    expect(() =>
      context.sqlite.prepare(`UPDATE work_queue_events SET decision_code = 'tampered'`).run()
    ).toThrow('work_queue_events is append-only');
    expect(() => context.sqlite.prepare(`DELETE FROM work_queue_events`).run()).toThrow(
      'work_queue_events is append-only'
    );
    expect(() =>
      context.sqlite
        .prepare(`UPDATE work_queue_tasks SET policy_band = 'P0' WHERE id = 'audited-task'`)
        .run()
    ).toThrow('work_queue task contract is immutable');
  });

  it('rolls back a state transition when its audit event cannot append', async () => {
    await queue.enqueue(task('rollback-task'));
    const lease = await queue.claimNext({
      tenantId: 'jarvis',
      workerId: 'worker-one',
      leaseToken: 'lease-rollback',
      now: at,
      leaseDurationMs: 60_000
    });
    context.sqlite.exec(`
      CREATE TRIGGER reject_queue_success_event
      BEFORE INSERT ON work_queue_events
      WHEN NEW.event_type = 'succeeded'
      BEGIN
        SELECT RAISE(ABORT, 'simulated audit failure');
      END;
    `);

    await expect(
      queue.settle({
        tenantId: 'jarvis',
        taskId: 'rollback-task',
        workerId: 'worker-one',
        leaseToken: 'lease-rollback',
        expectedVersion: lease?.version ?? 0,
        outcome: 'succeeded',
        now: '2026-07-18T10:00:30.000Z'
      })
    ).rejects.toThrow('simulated audit failure');
    const stored = context.sqlite
      .prepare(
        `SELECT state, version, lease_token AS leaseToken
         FROM work_queue_tasks WHERE id = 'rollback-task'`
      )
      .get() as { state: string; version: number; leaseToken: string | null };
    expect(stored).toEqual({ state: 'leased', version: 2, leaseToken: 'lease-rollback' });
  });

  it('returns a bounded tenant->lane->ready read model without selecting private fields', async () => {
    await queue.enqueue(task('safe-one'));
    await queue.enqueue(
      task('safe-two', {
        lane: 'research',
        payload: {
          kind: 'operator_gate',
          gateType: 'security',
          subjectRef: 'private-subject-reference'
        }
      })
    );
    await queue.enqueue(task('other-tenant', { tenantId: 'acme_corp' }));

    const view = await queue.readTenantQueue({ tenantId: 'jarvis', limit: 1, now: at });

    expect(view.tenantId).toBe('jarvis');
    expect(view.returnedTaskCount).toBe(1);
    expect(view.truncated).toBe(true);
    expect(view.lanes).toHaveLength(1);
    expect(view.lanes[0]?.ready[0]).toEqual(
      expect.objectContaining({
        tenantId: 'jarvis',
        ready: true
      })
    );
    expect(['project_task', 'operator_gate']).toContain(view.lanes[0]?.ready[0]?.payloadKind);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('private-subject-reference');
    expect(serialized).not.toContain('source-safe');
    expect(serialized).not.toContain('artifact-safe');
    expect(serialized).not.toContain('acme_corp');

    await expect(
      queue.readTenantQueue({ tenantId: 'jarvis', limit: 51, now: at })
    ).rejects.toThrow();
  });
});
