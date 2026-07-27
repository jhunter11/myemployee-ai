import { isDeepStrictEqual } from 'node:util';

import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';

import {
  QueueClaimInputSchema,
  QueueDecisionCodeSchema,
  QueueDecisionLogQuerySchema,
  QueuePayloadKindSchema,
  QueuePayloadSchema,
  QueuePolicyBandSchema,
  QueueReadQuerySchema,
  QueueSettlementInputSchema,
  QueueTaskInputSchema,
  QueueTaskStateSchema,
  type QueueClaimInput,
  type QueueDecisionCode,
  type QueueLease,
  type QueuePolicy,
  type QueueSettlementInput,
  type QueueTaskInput,
  type QueueEnqueueReceipt,
  type QueueTaskReceipt,
  type RedactedQueueDecision,
  type RedactedQueueTask,
  type TenantQueueView
} from '../queue/contracts';
import { basePolicyScore } from '../queue/priority-policy';
import type { JarvisDatabase, WorkQueueTasksTable } from './types';

interface ClaimCandidate {
  id: string;
  tenantId: string;
  lane: string;
  payloadJson: string;
  policyBand: string;
  impact: number;
  urgency: number;
  effort: number;
  state: string;
  version: number;
  attemptCount: number;
  effectiveScore: number;
  previousLaneClaimSequence: number;
}

interface RedactedTaskRow {
  id: string;
  tenantId: string;
  lane: string;
  payloadKind: string;
  payloadJson: string;
  policyBand: string;
  state: string;
  version: number;
  dependencyCount: number;
  blockedDependencyCount: number;
  createdAt: string;
  availableAt: string;
  readyFlag: number;
}

function canonicalTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function parsePayload(value: string) {
  const parsed: unknown = JSON.parse(value);
  return QueuePayloadSchema.parse(parsed);
}

function policyFromRow(
  row: Pick<Selectable<WorkQueueTasksTable>, 'policy_band' | 'impact' | 'urgency' | 'effort'>
): QueuePolicy {
  return {
    band: QueuePolicyBandSchema.parse(row.policy_band),
    impact: row.impact,
    urgency: row.urgency,
    effort: row.effort
  };
}

function receiptFromRow(row: Selectable<WorkQueueTasksTable>): QueueTaskReceipt {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    lane: row.lane,
    payloadKind: QueuePayloadKindSchema.parse(row.payload_kind),
    policy: policyFromRow(row),
    state: QueueTaskStateSchema.parse(row.state),
    version: row.version,
    dependencyCount: row.dependency_count,
    createdAt: row.created_at,
    availableAt: row.available_at
  };
}

function normalizedInput(input: QueueTaskInput): QueueTaskInput & { availableAt: string } {
  const occurredAt = canonicalTimestamp(input.source.occurredAt);
  return {
    ...input,
    source: { ...input.source, occurredAt },
    dependencies: [...input.dependencies].sort(),
    availableAt: canonicalTimestamp(input.availableAt ?? occurredAt)
  };
}

function comparableStoredTask(
  row: Selectable<WorkQueueTasksTable>,
  dependencies: string[]
): QueueTaskInput & { availableAt: string } {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    lane: row.lane,
    source: {
      kind: row.source_kind as QueueTaskInput['source']['kind'],
      id: row.source_id,
      occurredAt: row.source_occurred_at
    },
    payload: parsePayload(row.payload_json),
    policy: policyFromRow(row),
    dependencies: [...dependencies].sort(),
    availableAt: row.available_at
  };
}

function redactedTask(row: RedactedTaskRow): RedactedQueueTask {
  const payload = parsePayload(row.payloadJson);
  return {
    id: row.id,
    tenantId: row.tenantId,
    lane: row.lane,
    payloadKind: QueuePayloadKindSchema.parse(row.payloadKind),
    ...(payload.kind === 'automation' ? { automationId: payload.automationId } : {}),
    band: QueuePolicyBandSchema.parse(row.policyBand),
    state: QueueTaskStateSchema.parse(row.state),
    version: row.version,
    dependencyCount: Number(row.dependencyCount),
    blockedDependencyCount: Number(row.blockedDependencyCount),
    createdAt: row.createdAt,
    availableAt: row.availableAt,
    ready: Boolean(row.readyFlag)
  };
}

export class PriorityQueueRepository {
  private claimTail: Promise<void> = Promise.resolve();

  constructor(private readonly db: Kysely<JarvisDatabase>) {}

  async enqueue(input: QueueTaskInput): Promise<QueueEnqueueReceipt> {
    const task = normalizedInput(QueueTaskInputSchema.parse(input));

    return this.db.transaction().execute(async (transaction) => {
      if (task.dependencies.length > 0) {
        const dependencies = await transaction
          .selectFrom('work_queue_tasks')
          .select('id')
          .where('tenant_id', '=', task.tenantId)
          .where('id', 'in', task.dependencies)
          .execute();
        if (dependencies.length !== task.dependencies.length) {
          throw new Error(`Queue task ${task.id} has missing same-tenant dependencies`);
        }
      }

      const row = await transaction
        .insertInto('work_queue_tasks')
        .values({
          id: task.id,
          tenant_id: task.tenantId,
          lane: task.lane,
          source_kind: task.source.kind,
          source_id: task.source.id,
          source_occurred_at: task.source.occurredAt,
          payload_kind: task.payload.kind,
          payload_json: JSON.stringify(task.payload),
          policy_band: task.policy.band,
          impact: task.policy.impact,
          urgency: task.policy.urgency,
          effort: task.policy.effort,
          base_score: basePolicyScore(task.policy),
          state: 'queued',
          version: 1,
          dependency_count: task.dependencies.length,
          created_at: task.source.occurredAt,
          available_at: task.availableAt,
          updated_at: task.source.occurredAt,
          lease_owner: null,
          lease_token: null,
          lease_expires_at: null,
          attempt_count: 0,
          terminal_reason_code: null
        })
        .onConflict((conflict) =>
          conflict.columns(['tenant_id', 'source_kind', 'source_id']).doNothing()
        )
        .returningAll()
        .executeTakeFirst();

      if (row === undefined) {
        const existing = await transaction
          .selectFrom('work_queue_tasks')
          .selectAll()
          .where('tenant_id', '=', task.tenantId)
          .where('source_kind', '=', task.source.kind)
          .where('source_id', '=', task.source.id)
          .executeTakeFirstOrThrow();
        const dependencies = await transaction
          .selectFrom('work_queue_dependencies')
          .select('dependency_task_id')
          .where('tenant_id', '=', existing.tenant_id)
          .where('task_id', '=', existing.id)
          .orderBy('dependency_task_id', 'asc')
          .execute();
        if (
          !isDeepStrictEqual(
            comparableStoredTask(
              existing,
              dependencies.map(({ dependency_task_id: id }) => id)
            ),
            task
          )
        ) {
          throw new Error(
            `Queue source ${task.source.kind}/${task.source.id} already exists with different work`
          );
        }
        return { ...receiptFromRow(existing), inserted: false };
      }

      if (task.dependencies.length > 0) {
        await transaction
          .insertInto('work_queue_dependencies')
          .values(
            task.dependencies.map((dependencyId) => ({
              tenant_id: task.tenantId,
              task_id: task.id,
              dependency_task_id: dependencyId
            }))
          )
          .execute();
      }
      await transaction
        .insertInto('work_queue_lanes')
        .values({ tenant_id: task.tenantId, lane: task.lane })
        .onConflict((conflict) => conflict.columns(['tenant_id', 'lane']).doNothing())
        .execute();
      await transaction
        .insertInto('work_queue_tenant_cursors')
        .values({ tenant_id: task.tenantId })
        .onConflict((conflict) => conflict.column('tenant_id').doNothing())
        .execute();
      await this.appendEvent(transaction, {
        taskId: task.id,
        tenantId: task.tenantId,
        eventAt: task.source.occurredAt,
        eventType: 'created',
        decisionCode: 'source_accepted',
        actorId: `source:${task.source.kind}`,
        fromState: null,
        toState: 'queued',
        taskVersion: 1,
        detail: {
          dependencyCount: task.dependencies.length,
          payloadKind: task.payload.kind,
          policyBand: task.policy.band,
          baseScore: basePolicyScore(task.policy)
        }
      });

      return { ...receiptFromRow(row), inserted: true };
    });
  }

  claimNext(input: QueueClaimInput): Promise<QueueLease | null> {
    const operation = this.claimTail.then(() => this.claimNextTransaction(input));
    this.claimTail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async claimNextTransaction(input: QueueClaimInput): Promise<QueueLease | null> {
    const claim = QueueClaimInputSchema.parse(input);
    const now = canonicalTimestamp(claim.now);
    const leaseExpiresAt = new Date(Date.parse(now) + claim.leaseDurationMs).toISOString();
    const payloadKindFilter =
      claim.payloadKinds === undefined
        ? sql``
        : sql`AND t.payload_kind IN (${sql.join(claim.payloadKinds)})`;

    return this.db.transaction().execute(async (transaction) => {
      const candidates = await sql<ClaimCandidate>`
        WITH eligible AS (
          SELECT
            t.id,
            t.tenant_id AS tenantId,
            t.lane,
            t.payload_json AS payloadJson,
            t.policy_band AS policyBand,
            t.impact,
            t.urgency,
            t.effort,
            t.state,
            t.version,
            t.attempt_count AS attemptCount,
            t.available_at AS availableAt,
            CASE t.policy_band
              WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3
            END AS bandRank,
            t.base_score + MIN(
              100,
              MAX(0, CAST((unixepoch(${now}) - unixepoch(t.available_at)) / 900 AS INTEGER))
            ) AS effectiveScore
          FROM work_queue_tasks AS t
          WHERE t.tenant_id = ${claim.tenantId}
            ${payloadKindFilter}
            AND t.available_at <= ${now}
            AND (
              t.state = 'queued' OR
              (t.state = 'leased' AND t.lease_expires_at <= ${now})
            )
            AND NOT EXISTS (
              SELECT 1
              FROM work_queue_verification_holds AS verification_hold
              WHERE verification_hold.task_id = t.id
                AND verification_hold.tenant_id = t.tenant_id
                AND verification_hold.resolved_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1
              FROM work_queue_dependencies AS d
              JOIN work_queue_tasks AS blocker
                ON blocker.id = d.dependency_task_id
               AND blocker.tenant_id = d.tenant_id
              WHERE d.tenant_id = t.tenant_id
                AND d.task_id = t.id
                AND blocker.state <> 'succeeded'
            )
        ),
        ranked AS (
          SELECT
            eligible.*,
            ROW_NUMBER() OVER (
              PARTITION BY lane
              ORDER BY bandRank ASC, effectiveScore DESC, availableAt ASC, id ASC
            ) AS laneRank
          FROM eligible
        )
        SELECT
          ranked.id,
          ranked.tenantId,
          ranked.lane,
          ranked.payloadJson,
          ranked.policyBand,
          ranked.impact,
          ranked.urgency,
          ranked.effort,
          ranked.state,
          ranked.version,
          ranked.attemptCount,
          ranked.effectiveScore,
          lanes.last_claim_sequence AS previousLaneClaimSequence
        FROM ranked
        JOIN work_queue_lanes AS lanes
          ON lanes.tenant_id = ranked.tenantId
         AND lanes.lane = ranked.lane
        WHERE ranked.laneRank = 1
        ORDER BY
          ranked.bandRank ASC,
          lanes.last_claim_sequence ASC,
          ranked.effectiveScore DESC,
          ranked.availableAt ASC,
          ranked.id ASC
        LIMIT 1
      `.execute(transaction);
      const candidate = candidates.rows[0];
      if (candidate === undefined) return null;

      const nextVersion = Number(candidate.version) + 1;
      const nextAttempt = Number(candidate.attemptCount) + 1;
      const updated = await transaction
        .updateTable('work_queue_tasks')
        .set({
          state: 'leased',
          version: nextVersion,
          updated_at: now,
          lease_owner: claim.workerId,
          lease_token: claim.leaseToken,
          lease_expires_at: leaseExpiresAt,
          attempt_count: nextAttempt,
          terminal_reason_code: null
        })
        .where('id', '=', candidate.id)
        .where('tenant_id', '=', claim.tenantId)
        .where('version', '=', Number(candidate.version))
        .where((expression) =>
          expression.or([
            expression('state', '=', 'queued'),
            expression.and([
              expression('state', '=', 'leased'),
              expression('lease_expires_at', '<=', now)
            ])
          ])
        )
        .where(
          sql<boolean>`NOT EXISTS (
            SELECT 1
            FROM work_queue_verification_holds AS verification_hold
            WHERE verification_hold.task_id = work_queue_tasks.id
              AND verification_hold.tenant_id = work_queue_tasks.tenant_id
              AND verification_hold.resolved_at IS NULL
          )`
        )
        .returningAll()
        .executeTakeFirst();
      if (updated === undefined) {
        throw new Error(`Queue task ${candidate.id} changed during transactional claim`);
      }

      const cursor = await transaction
        .updateTable('work_queue_tenant_cursors')
        .set({
          last_claim_sequence: sql<number>`work_queue_tenant_cursors.last_claim_sequence + 1`
        })
        .where('tenant_id', '=', claim.tenantId)
        .returning('last_claim_sequence')
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('work_queue_lanes')
        .set({
          last_claim_sequence: cursor.last_claim_sequence,
          claim_count: sql<number>`work_queue_lanes.claim_count + 1`
        })
        .where('tenant_id', '=', claim.tenantId)
        .where('lane', '=', candidate.lane)
        .executeTakeFirstOrThrow();

      const reclaimed = candidate.state === 'leased';
      await this.appendEvent(transaction, {
        taskId: candidate.id,
        tenantId: claim.tenantId,
        eventAt: now,
        eventType: reclaimed ? 'reclaimed' : 'claimed',
        decisionCode: reclaimed ? 'expired_lease_reclaimed' : 'lane_head_claimed',
        actorId: claim.workerId,
        fromState: QueueTaskStateSchema.parse(candidate.state),
        toState: 'leased',
        taskVersion: nextVersion,
        detail: {
          effectiveScore: Number(candidate.effectiveScore),
          leaseDurationMs: claim.leaseDurationMs,
          previousLaneClaimSequence: Number(candidate.previousLaneClaimSequence),
          reclaimed
        }
      });

      return {
        id: updated.id,
        tenantId: updated.tenant_id,
        lane: updated.lane,
        payload: parsePayload(candidate.payloadJson),
        policy: policyFromRow(updated),
        version: updated.version,
        effectiveScore: Number(candidate.effectiveScore),
        lease: {
          token: claim.leaseToken,
          expiresAt: leaseExpiresAt,
          attempt: updated.attempt_count
        }
      };
    });
  }

  async settle(input: QueueSettlementInput): Promise<QueueTaskReceipt> {
    const settlement = QueueSettlementInputSchema.parse(input);
    const now = canonicalTimestamp(settlement.now);

    return this.db.transaction().execute(async (transaction) => {
      const succeeded = settlement.outcome === 'succeeded';
      const row = await transaction
        .updateTable('work_queue_tasks')
        .set({
          state: succeeded ? 'succeeded' : 'failed',
          version: settlement.expectedVersion + 1,
          updated_at: now,
          lease_owner: null,
          lease_token: null,
          lease_expires_at: null,
          terminal_reason_code: succeeded ? 'completed' : settlement.reasonCode
        })
        .where('id', '=', settlement.taskId)
        .where('tenant_id', '=', settlement.tenantId)
        .where('state', '=', 'leased')
        .where('version', '=', settlement.expectedVersion)
        .where('lease_owner', '=', settlement.workerId)
        .where('lease_token', '=', settlement.leaseToken)
        .where('lease_expires_at', '>', now)
        .returningAll()
        .executeTakeFirst();
      if (row === undefined) {
        throw new Error(`Queue task ${settlement.taskId} lease or version conflict`);
      }

      await this.appendEvent(transaction, {
        taskId: row.id,
        tenantId: row.tenant_id,
        eventAt: now,
        eventType: succeeded ? 'succeeded' : 'failed',
        decisionCode: succeeded ? 'lease_succeeded' : 'lease_failed',
        actorId: settlement.workerId,
        fromState: 'leased',
        toState: succeeded ? 'succeeded' : 'failed',
        taskVersion: row.version,
        detail: succeeded
          ? { outcome: 'succeeded' }
          : { outcome: 'failed', reasonCode: settlement.reasonCode }
      });
      return receiptFromRow(row);
    });
  }

  async readTenantQueue(input: {
    tenantId: string;
    limit: number;
    now: string;
  }): Promise<TenantQueueView> {
    const query = QueueReadQuerySchema.parse(input);
    const now = canonicalTimestamp(query.now);
    const rows = await this.db
      .selectFrom('work_queue_tasks as task')
      .select([
        'task.id',
        'task.tenant_id as tenantId',
        'task.lane',
        'task.payload_kind as payloadKind',
        'task.payload_json as payloadJson',
        'task.policy_band as policyBand',
        'task.state',
        'task.version',
        'task.dependency_count as dependencyCount',
        'task.created_at as createdAt',
        'task.available_at as availableAt',
        sql<number>`(
          SELECT COUNT(*)
          FROM work_queue_dependencies AS dependency
          JOIN work_queue_tasks AS blocker
            ON blocker.id = dependency.dependency_task_id
           AND blocker.tenant_id = dependency.tenant_id
          WHERE dependency.tenant_id = task.tenant_id
            AND dependency.task_id = task.id
            AND blocker.state <> 'succeeded'
        )`.as('blockedDependencyCount'),
        sql<number>`CASE WHEN
          task.available_at <= ${now}
          AND (
            task.state = 'queued' OR
            (task.state = 'leased' AND task.lease_expires_at <= ${now})
          )
          AND NOT EXISTS (
            SELECT 1
            FROM work_queue_verification_holds AS verification_hold
            WHERE verification_hold.task_id = task.id
              AND verification_hold.tenant_id = task.tenant_id
              AND verification_hold.resolved_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1
            FROM work_queue_dependencies AS dependency
            JOIN work_queue_tasks AS blocker
              ON blocker.id = dependency.dependency_task_id
             AND blocker.tenant_id = dependency.tenant_id
            WHERE dependency.tenant_id = task.tenant_id
              AND dependency.task_id = task.id
              AND blocker.state <> 'succeeded'
          )
          THEN 1 ELSE 0 END`.as('readyFlag')
      ])
      .where('task.tenant_id', '=', query.tenantId)
      .where('task.state', 'in', ['queued', 'leased'])
      .orderBy(
        sql<number>`CASE task.policy_band
          WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END`,
        'asc'
      )
      .orderBy('task.created_at', 'asc')
      .orderBy('task.id', 'asc')
      .limit(query.limit + 1)
      .execute();
    const truncated = rows.length > query.limit;
    const tasks = rows.slice(0, query.limit).map(redactedTask);
    const lanes = new Map<string, TenantQueueView['lanes'][number]>();
    for (const task of tasks) {
      const lane = lanes.get(task.lane) ?? { lane: task.lane, ready: [], blocked: [] };
      (task.ready ? lane.ready : lane.blocked).push(task);
      lanes.set(task.lane, lane);
    }

    return {
      tenantId: query.tenantId,
      returnedTaskCount: tasks.length,
      truncated,
      lanes: [...lanes.values()]
    };
  }

  async readDecisionLog(input: {
    tenantId: string;
    limit: number;
  }): Promise<RedactedQueueDecision[]> {
    const query = QueueDecisionLogQuerySchema.parse(input);
    const rows = await this.db
      .selectFrom('work_queue_events')
      .select([
        'sequence',
        'task_id as taskId',
        'tenant_id as tenantId',
        'event_at as eventAt',
        'decision_code as decisionCode',
        'from_state as fromState',
        'to_state as toState',
        'task_version as taskVersion'
      ])
      .where('tenant_id', '=', query.tenantId)
      .orderBy('sequence', 'desc')
      .limit(query.limit)
      .execute();

    return rows.map((row) => ({
      sequence: row.sequence,
      taskId: row.taskId,
      tenantId: row.tenantId,
      eventAt: row.eventAt,
      decisionCode: QueueDecisionCodeSchema.parse(row.decisionCode),
      fromState: row.fromState === null ? null : QueueTaskStateSchema.parse(row.fromState),
      toState: QueueTaskStateSchema.parse(row.toState),
      taskVersion: row.taskVersion
    }));
  }

  private async appendEvent(
    db: Kysely<JarvisDatabase>,
    input: {
      taskId: string;
      tenantId: string;
      eventAt: string;
      eventType: 'created' | 'claimed' | 'reclaimed' | 'succeeded' | 'failed';
      decisionCode: QueueDecisionCode;
      actorId: string;
      fromState: 'queued' | 'leased' | 'succeeded' | 'failed' | null;
      toState: 'queued' | 'leased' | 'succeeded' | 'failed';
      taskVersion: number;
      detail: Record<string, boolean | number | string>;
    }
  ): Promise<void> {
    await db
      .insertInto('work_queue_events')
      .values({
        task_id: input.taskId,
        tenant_id: input.tenantId,
        event_at: input.eventAt,
        event_type: input.eventType,
        decision_code: QueueDecisionCodeSchema.parse(input.decisionCode),
        actor_id: input.actorId,
        from_state: input.fromState,
        to_state: input.toState,
        task_version: input.taskVersion,
        detail_json: JSON.stringify(input.detail)
      })
      .execute();
  }
}
