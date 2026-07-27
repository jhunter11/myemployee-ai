import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { Kysely, Selectable, Transaction } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';

import {
  AccessAgentIdSchema,
  AccessPurposeSchema,
  AccessSensitivitySchema,
  ControlScopeIdSchema,
  GrantVersionSetSchema,
  MemorySleeveIdSchema,
  type GrantVersionSet
} from '../../agents/access-control-contracts';
import type {
  JarvisDatabase,
  MemoryMaintenanceOutboxEventsTable,
  MemoryMaintenanceOutboxTable
} from '../../db/types';
import { AppError } from '../../utils/errors';

const IdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/u);
const LeaseTokenSchema = z
  .string()
  .min(8)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const PolicyRevisionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);
const ErrorCodeSchema = z
  .string()
  .min(3)
  .max(96)
  .regex(/^[A-Z][A-Z0-9_]*$/u);
const TimestampSchema = z.iso.datetime();
const PositiveVersionSchema = z.number().int().min(1).max(2_147_483_647);

export const MemoryMaintenanceBindingSchema = z.strictObject({
  jobKind: z.literal('terminal_episode_and_consolidation'),
  policyRevision: PolicyRevisionSchema,
  agentId: AccessAgentIdSchema,
  expectedAgentVersion: PositiveVersionSchema,
  ownerScopeId: ControlScopeIdSchema,
  expectedOwnerScopeVersion: PositiveVersionSchema,
  sleeveId: MemorySleeveIdSchema,
  expectedSleeveVersion: PositiveVersionSchema,
  purpose: AccessPurposeSchema,
  sensitivity: AccessSensitivitySchema,
  grantVersions: GrantVersionSetSchema
});

const ClaimInputSchema = z
  .strictObject({
    workerId: IdSchema,
    leaseToken: LeaseTokenSchema,
    claimedAt: TimestampSchema,
    leaseExpiresAt: TimestampSchema
  })
  .superRefine((input, context) => {
    if (Date.parse(input.leaseExpiresAt) <= Date.parse(input.claimedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['leaseExpiresAt'],
        message: 'leaseExpiresAt must follow claimedAt'
      });
    }
  });

const CompleteInputSchema = z.strictObject({
  id: z.string().regex(/^memory-job:[a-f0-9]{64}$/u),
  expectedVersion: PositiveVersionSchema,
  leaseToken: LeaseTokenSchema,
  completedAt: TimestampSchema
});

const RetryInputSchema = z.strictObject({
  id: z.string().regex(/^memory-job:[a-f0-9]{64}$/u),
  expectedVersion: PositiveVersionSchema,
  leaseToken: LeaseTokenSchema,
  errorCode: ErrorCodeSchema,
  availableAt: TimestampSchema,
  recordedAt: TimestampSchema
});

export type MemoryMaintenanceBinding = z.infer<typeof MemoryMaintenanceBindingSchema>;
export type MemoryMaintenanceJobState = 'pending' | 'leased' | 'completed' | 'dead_letter';

export interface MemoryMaintenanceJob {
  id: string;
  runId: string;
  jobKind: 'terminal_episode_and_consolidation';
  policyRevision: string;
  agentId: string;
  expectedAgentVersion: number;
  ownerScopeId: string;
  expectedOwnerScopeVersion: number;
  sleeveId: string;
  expectedSleeveVersion: number;
  purpose: string;
  sensitivity: z.infer<typeof AccessSensitivitySchema>;
  grantVersions: GrantVersionSet;
  state: MemoryMaintenanceJobState;
  version: number;
  attemptCount: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  lastErrorCode: string | null;
  queuedAt: string;
  completedAt: string | null;
}

export interface MemoryMaintenanceEvent {
  sequence: number;
  jobId: string;
  eventType: 'queued' | 'claimed' | 'retried' | 'completed' | 'dead_lettered';
  fromState: string | null;
  toState: string;
  jobVersion: number;
  attemptCount: number;
  actorId: string;
  decisionCode: string;
  occurredAt: string;
  detail: Readonly<Record<string, unknown>>;
}

function canonicalTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function jobId(runId: string, binding: MemoryMaintenanceBinding): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        runId,
        jobKind: binding.jobKind,
        policyRevision: binding.policyRevision
      }),
      'utf8'
    )
    .digest('hex');
  return `memory-job:${digest}`;
}

function parseGrantVersions(value: string): GrantVersionSet {
  try {
    return GrantVersionSetSchema.parse(JSON.parse(value) as unknown);
  } catch {
    throw new AppError(
      500,
      'MEMORY_MAINTENANCE_CORRUPT',
      'Stored memory-maintenance binding is invalid'
    );
  }
}

function toJob(row: Selectable<MemoryMaintenanceOutboxTable>): MemoryMaintenanceJob {
  return {
    id: row.job_id,
    runId: row.run_id,
    jobKind: row.job_kind,
    policyRevision: row.policy_revision,
    agentId: row.agent_id,
    expectedAgentVersion: row.expected_agent_version,
    ownerScopeId: row.owner_scope_id,
    expectedOwnerScopeVersion: row.expected_owner_scope_version,
    sleeveId: row.sleeve_id,
    expectedSleeveVersion: row.expected_sleeve_version,
    purpose: row.purpose,
    sensitivity: AccessSensitivitySchema.parse(row.sensitivity),
    grantVersions: parseGrantVersions(row.grant_versions_json),
    state: row.state,
    version: row.version,
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    lastErrorCode: row.last_error_code,
    queuedAt: row.queued_at,
    completedAt: row.completed_at
  };
}

function parseDetail(value: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    return Object.freeze(parsed as Record<string, unknown>);
  } catch {
    throw new AppError(
      500,
      'MEMORY_MAINTENANCE_CORRUPT',
      'Stored memory-maintenance event is invalid'
    );
  }
}

function toEvent(row: Selectable<MemoryMaintenanceOutboxEventsTable>): MemoryMaintenanceEvent {
  return {
    sequence: row.sequence,
    jobId: row.job_id,
    eventType: row.event_type as MemoryMaintenanceEvent['eventType'],
    fromState: row.from_state,
    toState: row.to_state,
    jobVersion: row.job_version,
    attemptCount: row.attempt_count,
    actorId: row.actor_id,
    decisionCode: row.decision_code,
    occurredAt: row.occurred_at,
    detail: parseDetail(row.detail_json)
  };
}

function comparableBinding(job: MemoryMaintenanceJob): MemoryMaintenanceBinding {
  return {
    jobKind: job.jobKind,
    policyRevision: job.policyRevision,
    agentId: job.agentId,
    expectedAgentVersion: job.expectedAgentVersion,
    ownerScopeId: job.ownerScopeId,
    expectedOwnerScopeVersion: job.expectedOwnerScopeVersion,
    sleeveId: job.sleeveId,
    expectedSleeveVersion: job.expectedSleeveVersion,
    purpose: job.purpose,
    sensitivity: job.sensitivity,
    grantVersions: job.grantVersions
  };
}

async function appendEvent(
  transaction: Transaction<JarvisDatabase>,
  input: {
    job: MemoryMaintenanceJob;
    eventType: MemoryMaintenanceEvent['eventType'];
    fromState: string | null;
    actorId: string;
    decisionCode: string;
    occurredAt: string;
    detail?: Readonly<Record<string, unknown>>;
  }
): Promise<void> {
  await transaction
    .insertInto('memory_maintenance_outbox_events')
    .values({
      job_id: input.job.id,
      event_type: input.eventType,
      from_state: input.fromState,
      to_state: input.job.state,
      job_version: input.job.version,
      attempt_count: input.job.attemptCount,
      actor_id: input.actorId,
      decision_code: input.decisionCode,
      occurred_at: input.occurredAt,
      detail_json: JSON.stringify(input.detail ?? {})
    })
    .execute();
}

/**
 * Enqueues one immutable binding inside a caller-owned transaction. This is
 * intentionally exported only for repositories that commit a terminal run: a
 * standalone pre-terminal insert is rejected again by the database trigger.
 */
export async function enqueueMemoryMaintenance(
  transaction: Transaction<JarvisDatabase>,
  rawInput: unknown,
  runId: string,
  queuedAtValue: string
): Promise<MemoryMaintenanceJob> {
  const binding = MemoryMaintenanceBindingSchema.parse(rawInput);
  const queuedAt = canonicalTimestamp(TimestampSchema.parse(queuedAtValue));
  const id = jobId(runId, binding);
  const inserted = await transaction
    .insertInto('memory_maintenance_outbox')
    .values({
      job_id: id,
      run_id: runId,
      job_kind: binding.jobKind,
      policy_revision: binding.policyRevision,
      agent_id: binding.agentId,
      expected_agent_version: binding.expectedAgentVersion,
      owner_scope_id: binding.ownerScopeId,
      expected_owner_scope_version: binding.expectedOwnerScopeVersion,
      sleeve_id: binding.sleeveId,
      expected_sleeve_version: binding.expectedSleeveVersion,
      purpose: binding.purpose,
      sensitivity: binding.sensitivity,
      grant_versions_json: JSON.stringify(binding.grantVersions),
      state: 'pending',
      version: 1,
      attempt_count: 0,
      available_at: queuedAt,
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      last_error_code: null,
      queued_at: queuedAt,
      completed_at: null
    })
    .onConflict((conflict) =>
      conflict.columns(['run_id', 'job_kind', 'policy_revision']).doNothing()
    )
    .returningAll()
    .executeTakeFirst();

  if (inserted === undefined) {
    const existing = await transaction
      .selectFrom('memory_maintenance_outbox')
      .selectAll()
      .where('run_id', '=', runId)
      .where('job_kind', '=', binding.jobKind)
      .where('policy_revision', '=', binding.policyRevision)
      .executeTakeFirstOrThrow();
    const job = toJob(existing);
    if (!isDeepStrictEqual(comparableBinding(job), binding)) {
      throw new AppError(
        409,
        'MEMORY_MAINTENANCE_CONFLICT',
        'Run maintenance is already bound to a different exact capability'
      );
    }
    return job;
  }

  const job = toJob(inserted);
  await appendEvent(transaction, {
    job,
    eventType: 'queued',
    fromState: null,
    actorId: 'system:run-terminal',
    decisionCode: 'TERMINAL_RUN_COMMITTED',
    occurredAt: queuedAt,
    detail: { policyRevision: binding.policyRevision }
  });
  return job;
}

export class MemoryMaintenanceOutboxRepository {
  constructor(private readonly db: Kysely<JarvisDatabase>) {}

  async listForRun(runId: string): Promise<MemoryMaintenanceJob[]> {
    const rows = await this.db
      .selectFrom('memory_maintenance_outbox')
      .selectAll()
      .where('run_id', '=', IdSchema.parse(runId))
      .orderBy('queued_at', 'asc')
      .orderBy('job_id', 'asc')
      .execute();
    return rows.map(toJob);
  }

  async listEvents(jobIdValue: string): Promise<MemoryMaintenanceEvent[]> {
    const id = CompleteInputSchema.shape.id.parse(jobIdValue);
    const rows = await this.db
      .selectFrom('memory_maintenance_outbox_events')
      .selectAll()
      .where('job_id', '=', id)
      .orderBy('sequence', 'asc')
      .execute();
    return rows.map(toEvent);
  }

  async claimNext(rawInput: unknown): Promise<MemoryMaintenanceJob | undefined> {
    const parsed = ClaimInputSchema.parse(rawInput);
    const input = {
      ...parsed,
      claimedAt: canonicalTimestamp(parsed.claimedAt),
      leaseExpiresAt: canonicalTimestamp(parsed.leaseExpiresAt)
    };

    return this.db.transaction().execute(async (transaction) => {
      const candidate = await transaction
        .selectFrom('memory_maintenance_outbox as job')
        .innerJoin('agent_runs as run', 'run.id', 'job.run_id')
        .select(['job.job_id as jobId', 'job.version as version', 'job.state as state'])
        .where('run.status', 'in', ['succeeded', 'failed'])
        .where((expression) =>
          expression.or([
            expression.and([
              expression('job.state', '=', 'pending'),
              expression('job.available_at', '<=', input.claimedAt)
            ]),
            expression.and([
              expression('job.state', '=', 'leased'),
              expression('job.lease_expires_at', '<=', input.claimedAt)
            ])
          ])
        )
        .orderBy('job.available_at', 'asc')
        .orderBy('job.queued_at', 'asc')
        .orderBy('job.job_id', 'asc')
        .executeTakeFirst();
      if (candidate === undefined) return undefined;

      const updated = await transaction
        .updateTable('memory_maintenance_outbox')
        .set({
          state: 'leased',
          version: candidate.version + 1,
          attempt_count: sql<number>`attempt_count + 1`,
          lease_owner: input.workerId,
          lease_token: input.leaseToken,
          lease_expires_at: input.leaseExpiresAt
        })
        .where('job_id', '=', candidate.jobId)
        .where('version', '=', candidate.version)
        .where((expression) =>
          expression.or([
            expression.and([
              expression('state', '=', 'pending'),
              expression('available_at', '<=', input.claimedAt)
            ]),
            expression.and([
              expression('state', '=', 'leased'),
              expression('lease_expires_at', '<=', input.claimedAt)
            ])
          ])
        )
        .returningAll()
        .executeTakeFirst();
      if (updated === undefined) return undefined;

      const job = toJob(updated);
      await appendEvent(transaction, {
        job,
        eventType: 'claimed',
        fromState: candidate.state,
        actorId: input.workerId,
        decisionCode:
          candidate.state === 'leased' ? 'EXPIRED_LEASE_RECLAIMED' : 'PENDING_JOB_CLAIMED',
        occurredAt: input.claimedAt
      });
      return job;
    });
  }

  async retry(rawInput: unknown): Promise<MemoryMaintenanceJob | undefined> {
    const parsed = RetryInputSchema.parse(rawInput);
    const input = {
      ...parsed,
      availableAt: canonicalTimestamp(parsed.availableAt),
      recordedAt: canonicalTimestamp(parsed.recordedAt)
    };
    return this.db.transaction().execute(async (transaction) => {
      const row = await transaction
        .updateTable('memory_maintenance_outbox')
        .set({
          state: 'pending',
          version: input.expectedVersion + 1,
          available_at: input.availableAt,
          lease_owner: null,
          lease_token: null,
          lease_expires_at: null,
          last_error_code: input.errorCode
        })
        .where('job_id', '=', input.id)
        .where('state', '=', 'leased')
        .where('version', '=', input.expectedVersion)
        .where('lease_token', '=', input.leaseToken)
        .returningAll()
        .executeTakeFirst();
      if (row === undefined) return undefined;
      const job = toJob(row);
      await appendEvent(transaction, {
        job,
        eventType: 'retried',
        fromState: 'leased',
        actorId: 'system:memory-curator',
        decisionCode: input.errorCode,
        occurredAt: input.recordedAt
      });
      return job;
    });
  }

  async complete(rawInput: unknown): Promise<MemoryMaintenanceJob | undefined> {
    const parsed = CompleteInputSchema.parse(rawInput);
    const input = { ...parsed, completedAt: canonicalTimestamp(parsed.completedAt) };
    return this.db.transaction().execute(async (transaction) => {
      const row = await transaction
        .updateTable('memory_maintenance_outbox')
        .set({
          state: 'completed',
          version: input.expectedVersion + 1,
          lease_owner: null,
          lease_token: null,
          lease_expires_at: null,
          completed_at: input.completedAt
        })
        .where('job_id', '=', input.id)
        .where('state', '=', 'leased')
        .where('version', '=', input.expectedVersion)
        .where('lease_token', '=', input.leaseToken)
        .returningAll()
        .executeTakeFirst();
      if (row === undefined) return undefined;
      const job = toJob(row);
      await appendEvent(transaction, {
        job,
        eventType: 'completed',
        fromState: 'leased',
        actorId: 'system:memory-curator',
        decisionCode: 'MAINTENANCE_COMPLETED',
        occurredAt: input.completedAt
      });
      return job;
    });
  }
}
