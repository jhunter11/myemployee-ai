import { createHash } from 'node:crypto';

import type SQLite from 'better-sqlite3';

import type { ServerScopeBinding } from '../commands/contracts';
import { AppError } from '../utils/errors';
import {
  DelegationProjectionSchema,
  DelegationRunRecordSchema,
  DelegationSafeEventSchema,
  DelegationSpanRecordSchema,
  DelegationStatusSchema,
  type DelegationEventType,
  type DelegationProjection,
  type DelegationRunRecord,
  type DelegationSafeEvent,
  type DelegationSpanRecord,
  type DelegationStatus
} from './contracts';

interface RunRow {
  run_id: string;
  root_run_id: string;
  parent_run_id: string | null;
  retry_of_run_id: string | null;
  scope_id: string;
  trust_domain: string;
  tenant_id: string | null;
  tenant_key: string;
  policy_version: number;
  principal_id: string;
  channel: string;
  idempotency_key: string;
  request_digest: string;
  assigned_agent_id: string;
  operation_code: string;
  input_digest: string;
  depth: number;
  attempt: number;
  status: string;
  version: number;
  max_depth: number;
  max_fan_out: number;
  max_attempts: number;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

interface SpanRow {
  span_id: string;
  run_id: string;
  root_run_id: string;
  parent_span_id: string | null;
  span_kind: string;
  name_code: string;
  outcome: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  recorded_at: string;
  request_digest: string;
}

interface EventRow {
  stream_sequence: number;
  run_id: string;
  root_run_id: string;
  event_type: string;
  event_code: string;
  state_version: number;
  occurred_at: string;
}

interface ProjectionRow {
  id: string;
  parentRunId: string | null;
  retryOfRunId: string | null;
  depth: number;
  attempt: number;
  assignedAgentId: string;
  operationCode: string;
  status: string;
  version: number;
  childCount: number;
  spanCount: number;
  lastEventId: number;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

interface EventInput {
  run: DelegationRunRecord;
  type: DelegationEventType;
  code: string;
  actorPrincipalId: string;
  stateVersion: number;
  evidenceDigest?: string | null;
  occurredAt: string;
}

export interface CreateChildOptions {
  run: DelegationRunRecord;
  parentRunId: string;
  edgeKind: 'delegation' | 'retry';
  actorPrincipalId: string;
  eventType: 'run_queued' | 'run_retried';
  eventCode: string;
  expectedParentVersion?: number;
}

export class DelegationNotFoundError extends AppError {
  constructor() {
    super(404, 'DELEGATION_RUN_NOT_FOUND', 'Delegation run was not found');
    this.name = 'DelegationNotFoundError';
  }
}

export class DelegationConflictError extends AppError {
  constructor(code: string, message: string) {
    super(409, code, message);
    this.name = 'DelegationConflictError';
  }
}

function tenantKey(tenantId: string | null): string {
  return tenantId ?? '__none__';
}

function toRun(row: RunRow): DelegationRunRecord {
  return DelegationRunRecordSchema.parse({
    id: row.run_id,
    rootRunId: row.root_run_id,
    parentRunId: row.parent_run_id,
    retryOfRunId: row.retry_of_run_id,
    scopeId: row.scope_id,
    trustDomain: row.trust_domain,
    tenantId: row.tenant_id,
    policyVersion: row.policy_version,
    principalId: row.principal_id,
    channel: row.channel,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    assignedAgentId: row.assigned_agent_id,
    operationCode: row.operation_code,
    inputDigest: row.input_digest,
    depth: row.depth,
    attempt: row.attempt,
    status: row.status,
    version: row.version,
    maxDepth: row.max_depth,
    maxFanOut: row.max_fan_out,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at
  });
}

function toSpan(row: SpanRow): DelegationSpanRecord {
  return DelegationSpanRecordSchema.parse({
    id: row.span_id,
    runId: row.run_id,
    rootRunId: row.root_run_id,
    parentSpanId: row.parent_span_id,
    kind: row.span_kind,
    nameCode: row.name_code,
    outcome: row.outcome,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    recordedAt: row.recorded_at
  });
}

function toSafeEvent(row: EventRow): DelegationSafeEvent {
  return DelegationSafeEventSchema.parse({
    id: String(row.stream_sequence),
    runId: row.run_id,
    rootRunId: row.root_run_id,
    type: row.event_type,
    code: row.event_code,
    stateVersion: row.state_version,
    occurredAt: row.occurred_at
  });
}

function eventId(input: EventInput, sequence: number): string {
  return `event:${createHash('sha256')
    .update(
      [
        input.run.scopeId,
        tenantKey(input.run.tenantId),
        sequence,
        input.run.id,
        input.type,
        input.code,
        input.stateVersion,
        input.occurredAt
      ].join('\u001f')
    )
    .digest('hex')}`;
}

function insertRun(sqlite: SQLite.Database, run: DelegationRunRecord): void {
  sqlite
    .prepare(
      `INSERT INTO delegation_runs (
         run_id, root_run_id, parent_run_id, retry_of_run_id, scope_id, trust_domain,
         tenant_id, tenant_key, policy_version, principal_id, channel, idempotency_key,
         request_digest, assigned_agent_id, operation_code, input_digest, depth, attempt,
         status, version, max_depth, max_fan_out, max_attempts, created_at, updated_at,
         terminal_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )`
    )
    .run(
      run.id,
      run.rootRunId,
      run.parentRunId,
      run.retryOfRunId,
      run.scopeId,
      run.trustDomain,
      run.tenantId,
      tenantKey(run.tenantId),
      run.policyVersion,
      run.principalId,
      run.channel,
      run.idempotencyKey,
      run.requestDigest,
      run.assignedAgentId,
      run.operationCode,
      run.inputDigest,
      run.depth,
      run.attempt,
      run.status,
      run.version,
      run.maxDepth,
      run.maxFanOut,
      run.maxAttempts,
      run.createdAt,
      run.updatedAt,
      run.terminalAt
    );
}

function insertEvent(sqlite: SQLite.Database, input: EventInput): DelegationSafeEvent {
  const key = tenantKey(input.run.tenantId);
  const previous = sqlite
    .prepare(
      `SELECT COALESCE(MAX(stream_sequence), 0) AS sequence
       FROM delegation_run_events
       WHERE scope_id = ? AND tenant_key = ?`
    )
    .get(input.run.scopeId, key) as { sequence: number };
  const sequence = Number(previous.sequence) + 1;
  sqlite
    .prepare(
      `INSERT INTO delegation_run_events (
         event_id, stream_sequence, run_id, root_run_id, scope_id, tenant_key, event_type,
         event_code, actor_principal_id, state_version, evidence_digest, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      eventId(input, sequence),
      sequence,
      input.run.id,
      input.run.rootRunId,
      input.run.scopeId,
      key,
      input.type,
      input.code,
      input.actorPrincipalId,
      input.stateVersion,
      input.evidenceDigest ?? null,
      input.occurredAt
    );
  return DelegationSafeEventSchema.parse({
    id: String(sequence),
    runId: input.run.id,
    rootRunId: input.run.rootRunId,
    type: input.type,
    code: input.code,
    stateVersion: input.stateVersion,
    occurredAt: input.occurredAt
  });
}

function exactRun(
  sqlite: SQLite.Database,
  binding: ServerScopeBinding,
  runId: string
): DelegationRunRecord | null {
  const row = sqlite
    .prepare(
      `SELECT * FROM delegation_runs
       WHERE run_id = ? AND scope_id = ? AND tenant_key = ?`
    )
    .get(runId, binding.scopeId, tenantKey(binding.tenantId)) as RunRow | undefined;
  return row === undefined ? null : toRun(row);
}

function isAncestor(
  sqlite: SQLite.Database,
  binding: ServerScopeBinding,
  ancestorRunId: string,
  descendantRunId: string
): boolean {
  if (ancestorRunId === descendantRunId) return true;
  const row = sqlite
    .prepare(
      `WITH RECURSIVE ancestors(run_id) AS (
         SELECT parent_run_id
         FROM delegation_runs
         WHERE run_id = ? AND scope_id = ? AND tenant_key = ?
         UNION ALL
         SELECT runs.parent_run_id
         FROM delegation_runs AS runs
         JOIN ancestors ON runs.run_id = ancestors.run_id
         WHERE runs.scope_id = ? AND runs.tenant_key = ? AND ancestors.run_id IS NOT NULL
       )
       SELECT 1 AS found FROM ancestors WHERE run_id = ? LIMIT 1`
    )
    .get(
      descendantRunId,
      binding.scopeId,
      tenantKey(binding.tenantId),
      binding.scopeId,
      tenantKey(binding.tenantId),
      ancestorRunId
    ) as { found: number } | undefined;
  return row !== undefined;
}

function assertInheritedPolicy(parent: DelegationRunRecord, child: DelegationRunRecord): void {
  if (
    child.rootRunId !== parent.rootRunId ||
    child.scopeId !== parent.scopeId ||
    child.trustDomain !== parent.trustDomain ||
    child.tenantId !== parent.tenantId ||
    child.policyVersion !== parent.policyVersion ||
    child.depth !== parent.depth + 1 ||
    child.maxDepth !== parent.maxDepth ||
    child.maxFanOut !== parent.maxFanOut ||
    child.maxAttempts !== parent.maxAttempts
  ) {
    throw new DelegationConflictError(
      'DELEGATION_POLICY_MISMATCH',
      'Child delegation cannot alter its inherited scope or policy'
    );
  }
}

export class SqliteDelegationRepository {
  constructor(private readonly sqlite: SQLite.Database) {}

  findBySource(input: {
    binding: ServerScopeBinding;
    principalId: string;
    channel: string;
    idempotencyKey: string;
  }): DelegationRunRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM delegation_runs
         WHERE scope_id = ? AND tenant_key = ? AND principal_id = ? AND channel = ?
           AND idempotency_key = ?`
      )
      .get(
        input.binding.scopeId,
        tenantKey(input.binding.tenantId),
        input.principalId,
        input.channel,
        input.idempotencyKey
      ) as RunRow | undefined;
    return row === undefined ? null : toRun(row);
  }

  findRun(binding: ServerScopeBinding, runId: string): DelegationRunRecord | null {
    return exactRun(this.sqlite, binding, runId);
  }

  createRoot(input: { run: DelegationRunRecord; actorPrincipalId: string }): {
    run: DelegationRunRecord;
    created: boolean;
  } {
    return this.sqlite.transaction(() => {
      const existing = this.findBySource({
        binding: input.run,
        principalId: input.run.principalId,
        channel: input.run.channel,
        idempotencyKey: input.run.idempotencyKey
      });
      if (existing !== null) return { run: existing, created: false };
      insertRun(this.sqlite, input.run);
      insertEvent(this.sqlite, {
        run: input.run,
        type: 'run_queued',
        code: input.run.operationCode,
        actorPrincipalId: input.actorPrincipalId,
        stateVersion: input.run.version,
        occurredAt: input.run.createdAt
      });
      return { run: input.run, created: true };
    })();
  }

  createChild(input: CreateChildOptions): { run: DelegationRunRecord; created: boolean } {
    return this.sqlite.transaction(() => {
      const binding: ServerScopeBinding = {
        scopeId: input.run.scopeId,
        trustDomain: input.run.trustDomain,
        tenantId: input.run.tenantId,
        policyVersion: input.run.policyVersion
      };
      const parent = exactRun(this.sqlite, binding, input.parentRunId);
      if (parent === null) throw new DelegationNotFoundError();
      const existing = this.findBySource({
        binding,
        principalId: input.run.principalId,
        channel: input.run.channel,
        idempotencyKey: input.run.idempotencyKey
      });
      if (existing !== null) {
        if (isAncestor(this.sqlite, binding, existing.id, parent.id)) {
          throw new DelegationConflictError('DELEGATION_CYCLE', 'Delegation would create a cycle');
        }
        return { run: existing, created: false };
      }

      assertInheritedPolicy(parent, input.run);
      if (input.run.depth > parent.maxDepth) {
        throw new DelegationConflictError(
          'DELEGATION_DEPTH_LIMIT',
          'Delegation depth limit was reached'
        );
      }
      const childCount = this.sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM delegation_edges
           WHERE parent_run_id = ? AND scope_id = ? AND tenant_key = ?`
        )
        .get(parent.id, parent.scopeId, tenantKey(parent.tenantId)) as { count: number };
      if (Number(childCount.count) >= parent.maxFanOut) {
        throw new DelegationConflictError(
          'DELEGATION_FAN_OUT_LIMIT',
          'Delegation fan-out limit was reached'
        );
      }

      if (input.edgeKind === 'delegation') {
        if (!['queued', 'running'].includes(parent.status)) {
          throw new DelegationConflictError(
            'DELEGATION_PARENT_STATE',
            'Delegation parent state does not accept new work'
          );
        }
        if (input.run.retryOfRunId !== null || input.run.attempt !== 1) {
          throw new DelegationConflictError(
            'DELEGATION_RETRY_BINDING',
            'Ordinary delegation cannot claim retry lineage'
          );
        }
      } else {
        if (parent.status !== 'failed' || parent.version !== input.expectedParentVersion) {
          throw new DelegationConflictError(
            'DELEGATION_RETRY_STATE',
            'Retry source state or version changed'
          );
        }
        if (
          input.run.retryOfRunId !== parent.id ||
          input.run.attempt !== parent.attempt + 1 ||
          input.run.assignedAgentId !== parent.assignedAgentId ||
          input.run.operationCode !== parent.operationCode ||
          input.run.inputDigest !== parent.inputDigest
        ) {
          throw new DelegationConflictError(
            'DELEGATION_RETRY_BINDING',
            'Retry must preserve its exact operation binding'
          );
        }
        if (input.run.attempt > parent.maxAttempts) {
          throw new DelegationConflictError(
            'DELEGATION_ATTEMPT_LIMIT',
            'Delegation retry attempt limit was reached'
          );
        }
      }

      insertRun(this.sqlite, input.run);
      this.sqlite
        .prepare(
          `INSERT INTO delegation_edges (
             child_run_id, parent_run_id, root_run_id, scope_id, tenant_key, depth,
             edge_kind, actor_principal_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.run.id,
          parent.id,
          input.run.rootRunId,
          input.run.scopeId,
          tenantKey(input.run.tenantId),
          input.run.depth,
          input.edgeKind,
          input.actorPrincipalId,
          input.run.createdAt
        );
      insertEvent(this.sqlite, {
        run: input.run,
        type: input.eventType,
        code: input.eventCode,
        actorPrincipalId: input.actorPrincipalId,
        stateVersion: input.run.version,
        occurredAt: input.run.createdAt
      });
      return { run: input.run, created: true };
    })();
  }

  transition(input: {
    binding: ServerScopeBinding;
    runId: string;
    expectedVersion: number;
    from: DelegationStatus;
    to: DelegationStatus;
    eventType: DelegationEventType;
    eventCode: string;
    actorPrincipalId: string;
    evidenceDigest?: string | null;
    at: string;
  }): DelegationRunRecord {
    return this.sqlite.transaction(() => {
      const run = exactRun(this.sqlite, input.binding, input.runId);
      if (run === null) throw new DelegationNotFoundError();
      if (run.version !== input.expectedVersion || run.status !== input.from) {
        throw new DelegationConflictError(
          'DELEGATION_RUN_VERSION_CONFLICT',
          'Delegation run state or version changed'
        );
      }
      const terminal = ['succeeded', 'failed', 'cancelled'].includes(input.to);
      const result = this.sqlite
        .prepare(
          `UPDATE delegation_runs
           SET status = ?, version = version + 1, updated_at = ?, terminal_at = ?
           WHERE run_id = ? AND scope_id = ? AND tenant_key = ? AND status = ? AND version = ?`
        )
        .run(
          input.to,
          input.at,
          terminal ? input.at : null,
          input.runId,
          input.binding.scopeId,
          tenantKey(input.binding.tenantId),
          input.from,
          input.expectedVersion
        );
      if (result.changes !== 1) {
        throw new DelegationConflictError(
          'DELEGATION_RUN_VERSION_CONFLICT',
          'Delegation run state or version changed'
        );
      }
      const updated = exactRun(this.sqlite, input.binding, input.runId);
      if (updated === null) throw new DelegationNotFoundError();
      insertEvent(this.sqlite, {
        run: updated,
        type: input.eventType,
        code: input.eventCode,
        actorPrincipalId: input.actorPrincipalId,
        stateVersion: updated.version,
        evidenceDigest: input.evidenceDigest,
        occurredAt: input.at
      });
      return updated;
    })();
  }

  cancelSubtree(input: {
    binding: ServerScopeBinding;
    runId: string;
    expectedVersion: number;
    reasonCode: string;
    actorPrincipalId: string;
    at: string;
  }): {
    changedRunIds: string[];
    states: Partial<Record<'cancel_requested' | 'cancelled', number>>;
  } {
    return this.sqlite.transaction(() => {
      const target = exactRun(this.sqlite, input.binding, input.runId);
      if (target === null) throw new DelegationNotFoundError();
      if (target.version !== input.expectedVersion) {
        throw new DelegationConflictError(
          'DELEGATION_RUN_VERSION_CONFLICT',
          'Delegation run state or version changed'
        );
      }
      const rows = this.sqlite
        .prepare(
          `WITH RECURSIVE subtree(run_id, relative_depth) AS (
             SELECT run_id, 0 FROM delegation_runs
             WHERE run_id = ? AND scope_id = ? AND tenant_key = ?
             UNION ALL
             SELECT edges.child_run_id, subtree.relative_depth + 1
             FROM delegation_edges AS edges
             JOIN subtree ON edges.parent_run_id = subtree.run_id
             WHERE edges.scope_id = ? AND edges.tenant_key = ?
           )
           SELECT runs.*, subtree.relative_depth
           FROM delegation_runs AS runs
           JOIN subtree ON subtree.run_id = runs.run_id
           ORDER BY subtree.relative_depth ASC, runs.run_id ASC`
        )
        .all(
          input.runId,
          input.binding.scopeId,
          tenantKey(input.binding.tenantId),
          input.binding.scopeId,
          tenantKey(input.binding.tenantId)
        ) as Array<RunRow & { relative_depth: number }>;
      const changedRunIds: string[] = [];
      const states: Partial<Record<'cancel_requested' | 'cancelled', number>> = {};
      for (const row of rows) {
        const run = toRun(row);
        const next =
          run.status === 'queued'
            ? 'cancelled'
            : run.status === 'running'
              ? 'cancel_requested'
              : null;
        if (next === null) continue;
        const update = this.sqlite
          .prepare(
            `UPDATE delegation_runs
             SET status = ?, version = version + 1, updated_at = ?, terminal_at = ?
             WHERE run_id = ? AND status = ? AND version = ?`
          )
          .run(
            next,
            input.at,
            next === 'cancelled' ? input.at : null,
            run.id,
            run.status,
            run.version
          );
        if (update.changes !== 1) {
          throw new DelegationConflictError(
            'DELEGATION_RUN_VERSION_CONFLICT',
            'Delegation run state or version changed during cancellation'
          );
        }
        const updated = exactRun(this.sqlite, input.binding, run.id);
        if (updated === null) throw new DelegationNotFoundError();
        insertEvent(this.sqlite, {
          run: updated,
          type: next === 'cancelled' ? 'run_cancelled' : 'cancel_requested',
          code: input.reasonCode,
          actorPrincipalId: input.actorPrincipalId,
          stateVersion: updated.version,
          occurredAt: input.at
        });
        changedRunIds.push(updated.id);
        states[next] = (states[next] ?? 0) + 1;
      }
      return { changedRunIds, states };
    })();
  }

  recordSpan(input: {
    binding: ServerScopeBinding;
    runId: string;
    principalId: string;
    idempotencyKey: string;
    requestDigest: string;
    spanId: string;
    parentSpanId: string | null;
    kind: string;
    nameCode: string;
    outcome: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    evidenceDigest?: string | null;
    recordedAt: string;
  }): { span: DelegationSpanRecord; requestDigest: string; created: boolean } {
    return this.sqlite.transaction(() => {
      const run = exactRun(this.sqlite, input.binding, input.runId);
      if (run === null) throw new DelegationNotFoundError();
      const existing = this.sqlite
        .prepare(
          `SELECT * FROM delegation_run_spans
           WHERE run_id = ? AND principal_id = ? AND idempotency_key = ?`
        )
        .get(input.runId, input.principalId, input.idempotencyKey) as SpanRow | undefined;
      if (existing !== undefined) {
        return { span: toSpan(existing), requestDigest: existing.request_digest, created: false };
      }
      if (input.parentSpanId !== null) {
        const parent = this.sqlite
          .prepare(
            `SELECT span_id FROM delegation_run_spans
             WHERE span_id = ? AND run_id = ? AND scope_id = ? AND tenant_key = ?`
          )
          .get(input.parentSpanId, run.id, run.scopeId, tenantKey(run.tenantId)) as
          { span_id: string } | undefined;
        if (parent === undefined) {
          throw new DelegationConflictError(
            'DELEGATION_PARENT_SPAN_INVALID',
            'Parent span was not found in the same run'
          );
        }
      }
      this.sqlite
        .prepare(
          `INSERT INTO delegation_run_spans (
             span_id, run_id, root_run_id, parent_span_id, scope_id, tenant_key,
             principal_id, idempotency_key, request_digest, span_kind, name_code,
             outcome, started_at, ended_at, duration_ms, evidence_digest, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.spanId,
          run.id,
          run.rootRunId,
          input.parentSpanId,
          run.scopeId,
          tenantKey(run.tenantId),
          input.principalId,
          input.idempotencyKey,
          input.requestDigest,
          input.kind,
          input.nameCode,
          input.outcome,
          input.startedAt,
          input.endedAt,
          input.durationMs,
          input.evidenceDigest ?? null,
          input.recordedAt
        );
      insertEvent(this.sqlite, {
        run,
        type: 'span_recorded',
        code: input.nameCode,
        actorPrincipalId: input.principalId,
        stateVersion: run.version,
        evidenceDigest: input.evidenceDigest,
        occurredAt: input.recordedAt
      });
      const row = this.sqlite
        .prepare('SELECT * FROM delegation_run_spans WHERE span_id = ?')
        .get(input.spanId) as SpanRow;
      return { span: toSpan(row), requestDigest: input.requestDigest, created: true };
    })();
  }

  snapshot(binding: ServerScopeBinding, rootRunId: string, limit: number): DelegationProjection {
    const root = exactRun(this.sqlite, binding, rootRunId);
    if (root === null || root.rootRunId !== rootRunId) throw new DelegationNotFoundError();
    const rows = this.sqlite
      .prepare(
        `SELECT
           runs.run_id AS id,
           runs.parent_run_id AS parentRunId,
           runs.retry_of_run_id AS retryOfRunId,
           runs.depth AS depth,
           runs.attempt AS attempt,
           runs.assigned_agent_id AS assignedAgentId,
           runs.operation_code AS operationCode,
           runs.status AS status,
           runs.version AS version,
           (SELECT COUNT(*) FROM delegation_edges AS edges
             WHERE edges.parent_run_id = runs.run_id) AS childCount,
           (SELECT COUNT(*) FROM delegation_run_spans AS spans
             WHERE spans.run_id = runs.run_id) AS spanCount,
           (SELECT MAX(events.stream_sequence) FROM delegation_run_events AS events
             WHERE events.run_id = runs.run_id) AS lastEventId,
           runs.created_at AS createdAt,
           runs.updated_at AS updatedAt,
           runs.terminal_at AS terminalAt
         FROM delegation_runs AS runs
         WHERE runs.scope_id = ? AND runs.tenant_key = ? AND runs.root_run_id = ?
         ORDER BY runs.depth ASC, runs.created_at ASC, runs.run_id ASC
         LIMIT ?`
      )
      .all(binding.scopeId, tenantKey(binding.tenantId), rootRunId, limit + 1) as ProjectionRow[];
    const countRows = this.sqlite
      .prepare(
        `SELECT status, COUNT(*) AS count FROM delegation_runs
         WHERE scope_id = ? AND tenant_key = ? AND root_run_id = ?
         GROUP BY status`
      )
      .all(binding.scopeId, tenantKey(binding.tenantId), rootRunId) as Array<{
      status: string;
      count: number;
    }>;
    const statusCounts: Partial<Record<DelegationStatus, number>> = {};
    for (const row of countRows) {
      statusCounts[DelegationStatusSchema.parse(row.status)] = Number(row.count);
    }
    return DelegationProjectionSchema.parse({
      rootRunId,
      truncated: rows.length > limit,
      nodes: rows.slice(0, limit).map((row) => ({
        ...row,
        childCount: Number(row.childCount),
        spanCount: Number(row.spanCount),
        lastEventId: String(row.lastEventId)
      })),
      statusCounts
    });
  }

  listEvents(input: {
    binding: ServerScopeBinding;
    after: number;
    limit: number;
  }): DelegationSafeEvent[] {
    const rows = this.sqlite
      .prepare(
        `SELECT stream_sequence, run_id, root_run_id, event_type, event_code,
                state_version, occurred_at
         FROM delegation_run_events
         WHERE scope_id = ? AND tenant_key = ? AND stream_sequence > ?
         ORDER BY stream_sequence ASC
         LIMIT ?`
      )
      .all(
        input.binding.scopeId,
        tenantKey(input.binding.tenantId),
        input.after,
        input.limit
      ) as EventRow[];
    return rows.map(toSafeEvent);
  }
}
