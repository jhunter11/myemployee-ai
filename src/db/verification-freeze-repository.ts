import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';

import {
  AcquireArtifactClaimInputSchema,
  BoundedCandidateResultSchema,
  FreezeCandidateInputSchema,
  RecordSourceSnapshotInputSchema,
  ResolvedVerificationSubjectV1Schema,
  SettlementVerificationRequestV1Schema,
  VerificationOpaqueIdSchema,
  type AcquireArtifactClaimInput,
  type ArtifactClaimReceipt,
  type BoundedCandidateResult,
  type FreezeCandidateInput,
  type FreezeCandidateReceipt,
  type RecordSourceSnapshotInput,
  type ResolvedVerificationSubjectV1,
  type SourceSnapshotClaimReceipt
} from '../queue/verification-contracts';
import {
  createArtifactClaimId,
  createExecutionRequestId,
  createQueueTaskId,
  createRunId,
  createSourceClaimId,
  createVerificationHoldId
} from '../reliability/identities';
import type {
  ArtifactScopeClaimsTable,
  JarvisDatabase,
  RunCompletionCandidatesTable,
  SourceSnapshotClaimsTable,
  WorkQueueVerificationHoldsTable
} from './types';

function canonicalTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizedAcquire(input: unknown): AcquireArtifactClaimInput {
  const parsed = AcquireArtifactClaimInputSchema.parse(input);
  return {
    ...parsed,
    acquiredAt: canonicalTimestamp(parsed.acquiredAt),
    now: canonicalTimestamp(parsed.now)
  };
}

function normalizedSource(input: unknown): RecordSourceSnapshotInput {
  const parsed = RecordSourceSnapshotInputSchema.parse(input);
  return { ...parsed, createdAt: canonicalTimestamp(parsed.createdAt) };
}

function normalizedFreeze(input: unknown): FreezeCandidateInput {
  const parsed = FreezeCandidateInputSchema.parse(input);
  return {
    ...parsed,
    committedAt: canonicalTimestamp(parsed.committedAt),
    now: canonicalTimestamp(parsed.now)
  };
}

function acquireComparable(row: Selectable<ArtifactScopeClaimsTable>) {
  return {
    claimId: row.claim_id,
    artifactScopeKey: row.artifact_scope_key,
    tenantId: row.tenant_id,
    automationId: row.automation_id,
    taskId: row.task_id,
    runId: row.run_id,
    capturedQueueVersion: row.captured_queue_version,
    acquiredAt: row.acquired_at
  };
}

function artifactClaimReplayReceipt(
  row: Selectable<ArtifactScopeClaimsTable>,
  claim: AcquireArtifactClaimInput
): ArtifactClaimReceipt {
  const expected = {
    claimId: claim.claimId,
    artifactScopeKey: claim.artifactScopeKey,
    tenantId: claim.tenantId,
    automationId: claim.automationId,
    taskId: claim.taskId,
    runId: claim.runId,
    capturedQueueVersion: claim.capturedQueueVersion,
    acquiredAt: claim.acquiredAt
  };
  if (!isDeepStrictEqual(acquireComparable(row), expected)) {
    throw new Error(`Conflicting artifact claim replay for ${claim.claimId}`);
  }
  return {
    claimId: row.claim_id,
    state: 'executing',
    version: 1,
    acquiredAt: row.acquired_at,
    replayed: true
  };
}

function sourceComparable(row: Selectable<SourceSnapshotClaimsTable>) {
  return {
    sourceClaimId: row.source_claim_id,
    artifactClaimId: row.artifact_claim_id,
    taskId: row.task_id,
    runId: row.run_id,
    tenantId: row.tenant_id,
    automationId: row.automation_id,
    sourceRegistrationId: row.source_registration_id,
    snapshotRelativePath: row.snapshot_relative_path,
    size: row.size,
    sourceSha256: row.source_sha256,
    createdAt: row.created_at
  };
}

function sourceSnapshotReplayReceipt(
  row: Selectable<SourceSnapshotClaimsTable>,
  source: RecordSourceSnapshotInput
): SourceSnapshotClaimReceipt {
  const expected = {
    sourceClaimId: source.sourceClaimId,
    artifactClaimId: source.artifactClaimId,
    taskId: source.taskId,
    runId: source.runId,
    tenantId: source.tenantId,
    automationId: source.automationId,
    sourceRegistrationId: source.sourceRegistrationId,
    snapshotRelativePath: source.snapshotRelativePath,
    size: source.size,
    sourceSha256: source.sourceSha256,
    createdAt: source.createdAt
  };
  if (!isDeepStrictEqual(sourceComparable(row), expected)) {
    throw new Error(`Conflicting source snapshot replay for ${source.sourceClaimId}`);
  }
  return {
    sourceClaimId: row.source_claim_id,
    artifactClaimId: row.artifact_claim_id,
    sourceSha256: row.source_sha256,
    size: row.size,
    createdAt: row.created_at,
    replayed: true
  };
}

function candidateComparable(row: Selectable<RunCompletionCandidatesTable>) {
  return {
    candidateId: row.candidate_id,
    occurrenceId: row.occurrence_id,
    executionRequestId: row.execution_request_id,
    taskId: row.task_id,
    runId: row.run_id,
    tenantId: row.tenant_id,
    automationId: row.automation_id,
    workerId: row.worker_id,
    artifactClaimId: row.artifact_claim_id,
    artifactScopeKey: row.artifact_scope_key,
    sourceClaimId: row.source_claim_id,
    sourceSha256: row.source_sha256,
    resultSchemaVersion: row.result_schema_version,
    canonicalResultJson: row.canonical_result_json,
    resultSha256: row.result_sha256,
    artifactSha256: row.artifact_sha256,
    journalClaimId: row.journal_claim_id,
    journalClaimSha256: row.journal_claim_sha256,
    criteriaSha256: row.criteria_sha256,
    capturedPostureVersion: row.captured_posture_version,
    committedAt: row.committed_at
  };
}

function holdComparable(row: Selectable<WorkQueueVerificationHoldsTable>) {
  return {
    holdId: row.hold_id,
    candidateId: row.candidate_id,
    taskId: row.task_id,
    runId: row.run_id,
    tenantId: row.tenant_id,
    automationId: row.automation_id,
    executionRequestId: row.execution_request_id,
    occurrenceId: row.occurrence_id,
    artifactClaimId: row.artifact_claim_id,
    artifactScopeKey: row.artifact_scope_key,
    sourceClaimId: row.source_claim_id,
    leasedVersion: row.leased_version,
    queueAttempt: row.queue_attempt,
    leaseOwner: row.lease_owner,
    capturedPostureVersion: row.captured_posture_version,
    artifactClaimVersion: row.artifact_claim_version,
    verifierId: row.verifier_id,
    verifierRevision: row.verifier_revision,
    criteriaSha256: row.criteria_sha256
  };
}

async function assertLease(
  transaction: Transaction<JarvisDatabase>,
  input: {
    tenantId: string;
    taskId: string;
    version: number;
    attempt: number;
    owner: string;
    token: string;
    now: string;
  }
): Promise<{ sourceKind: string; sourceId: string }> {
  // This deliberately performs a no-op UPDATE rather than a SELECT. It obtains
  // SQLite's write lock before any claim/candidate insert and makes the token,
  // version, attempt, owner, state, and expiry check part of the same transaction.
  const task = await transaction
    .updateTable('work_queue_tasks')
    .set({ updated_at: sql<string>`updated_at` })
    .where('id', '=', input.taskId)
    .where('tenant_id', '=', input.tenantId)
    .where('state', '=', 'leased')
    .where('version', '=', input.version)
    .where('attempt_count', '=', input.attempt)
    .where('lease_owner', '=', input.owner)
    .where('lease_token', '=', input.token)
    .where('lease_expires_at', '>', input.now)
    .returning(['source_kind as sourceKind', 'source_id as sourceId'])
    .executeTakeFirst();
  if (task === undefined) {
    throw new Error(`Queue task ${input.taskId} lease or version conflict`);
  }
  return task;
}

function assertExecutionSourceBinding(
  leaseTask: { sourceKind: string; sourceId: string },
  input: {
    taskId: string;
    tenantId: string;
    automationId: string;
    executionRequestId: string;
    occurrenceId?: string | null;
  }
): void {
  if (leaseTask.sourceKind !== 'api' && leaseTask.sourceKind !== 'schedule') {
    throw new Error(`Queue task ${input.taskId} has no canonical execution-request source`);
  }
  const expectedExecutionRequestId = createExecutionRequestId({
    sourceKind: leaseTask.sourceKind,
    sourceId: leaseTask.sourceId,
    tenantId: input.tenantId,
    automationId: input.automationId
  });
  if (input.executionRequestId !== expectedExecutionRequestId) {
    throw new Error(`Queue task ${input.taskId} execution-request identity mismatch`);
  }
  if ('occurrenceId' in input) {
    const expectedOccurrenceId = leaseTask.sourceKind === 'schedule' ? leaseTask.sourceId : null;
    if (input.occurrenceId !== expectedOccurrenceId) {
      throw new Error(`Queue task ${input.taskId} occurrence identity mismatch`);
    }
  }
}

async function assertRunningRun(
  transaction: Transaction<JarvisDatabase>,
  input: { runId: string; tenantId: string; automationId: string }
): Promise<void> {
  const run = await transaction
    .selectFrom('agent_runs')
    .select('id')
    .where('id', '=', input.runId)
    .where('client_id', '=', input.tenantId)
    .where('automation', '=', input.automationId)
    .where('status', '=', 'running')
    .executeTakeFirst();
  if (run === undefined) {
    throw new Error(`Run ${input.runId} binding is not running`);
  }
}

export class VerificationFreezeRepository {
  constructor(private readonly db: Kysely<JarvisDatabase>) {}

  async acquireArtifactClaim(input: unknown): Promise<ArtifactClaimReceipt> {
    const claim = normalizedAcquire(input);
    const existing = await this.db
      .selectFrom('artifact_scope_claims')
      .selectAll()
      .where('claim_id', '=', claim.claimId)
      .executeTakeFirst();
    if (existing !== undefined) {
      return artifactClaimReplayReceipt(existing, claim);
    }

    return this.db.transaction().execute(async (transaction) => {
      const leaseTask = await assertLease(transaction, {
        tenantId: claim.tenantId,
        taskId: claim.taskId,
        version: claim.capturedQueueVersion,
        attempt: claim.queueAttempt,
        owner: claim.leaseOwner,
        token: claim.leaseToken,
        now: claim.now
      });
      assertExecutionSourceBinding(leaseTask, claim);
      const raced = await transaction
        .selectFrom('artifact_scope_claims')
        .selectAll()
        .where('claim_id', '=', claim.claimId)
        .executeTakeFirst();
      if (raced !== undefined) {
        return artifactClaimReplayReceipt(raced, claim);
      }
      await assertRunningRun(transaction, claim);

      const activeScope = await transaction
        .selectFrom('artifact_scope_claims')
        .select('claim_id')
        .where('artifact_scope_key', '=', claim.artifactScopeKey)
        .where('state', 'in', ['executing', 'verification_pending', 'finalization_pending'])
        .executeTakeFirst();
      if (activeScope !== undefined) {
        throw new Error(
          `Artifact scope ${claim.artifactScopeKey} already has an active artifact scope claim`
        );
      }

      const row = await transaction
        .insertInto('artifact_scope_claims')
        .values({
          claim_id: claim.claimId,
          artifact_scope_key: claim.artifactScopeKey,
          tenant_id: claim.tenantId,
          automation_id: claim.automationId,
          task_id: claim.taskId,
          run_id: claim.runId,
          version: 1,
          state: 'executing',
          captured_queue_version: claim.capturedQueueVersion,
          acquired_at: claim.acquiredAt,
          updated_at: claim.acquiredAt,
          terminal_at: null,
          terminal_evidence_kind: null,
          terminal_evidence_id: null,
          terminal_evidence_sha256: null
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return {
        claimId: row.claim_id,
        state: 'executing',
        version: row.version,
        acquiredAt: row.acquired_at,
        replayed: false
      };
    });
  }

  async recordSourceSnapshot(input: unknown): Promise<SourceSnapshotClaimReceipt> {
    const source = normalizedSource(input);
    const existing = await this.db
      .selectFrom('source_snapshot_claims')
      .selectAll()
      .where('source_claim_id', '=', source.sourceClaimId)
      .executeTakeFirst();
    if (existing !== undefined) {
      return sourceSnapshotReplayReceipt(existing, source);
    }

    try {
      const row = await this.db
        .insertInto('source_snapshot_claims')
        .values({
          source_claim_id: source.sourceClaimId,
          artifact_claim_id: source.artifactClaimId,
          task_id: source.taskId,
          run_id: source.runId,
          tenant_id: source.tenantId,
          automation_id: source.automationId,
          source_registration_id: source.sourceRegistrationId,
          snapshot_relative_path: source.snapshotRelativePath,
          size: source.size,
          source_sha256: source.sourceSha256,
          created_at: source.createdAt
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return {
        sourceClaimId: row.source_claim_id,
        artifactClaimId: row.artifact_claim_id,
        sourceSha256: row.source_sha256,
        size: row.size,
        createdAt: row.created_at,
        replayed: false
      };
    } catch (error) {
      const raced = await this.db
        .selectFrom('source_snapshot_claims')
        .selectAll()
        .where('source_claim_id', '=', source.sourceClaimId)
        .executeTakeFirst();
      if (raced === undefined) throw error;
      return sourceSnapshotReplayReceipt(raced, source);
    }
  }

  async freezeForVerification(input: unknown): Promise<FreezeCandidateReceipt> {
    const freeze = normalizedFreeze(input);
    if (sha256(freeze.canonicalResultJson) !== freeze.resultSha256) {
      throw new Error('Completion candidate result digest mismatch');
    }

    const replay = await this.db
      .transaction()
      .execute((transaction) => this.resolveFreezeReplay(freeze, transaction));
    if (replay !== undefined) return replay;

    return this.db.transaction().execute(async (transaction) => {
      const leaseTask = await assertLease(transaction, {
        tenantId: freeze.tenantId,
        taskId: freeze.taskId,
        version: freeze.leasedVersion,
        attempt: freeze.queueAttempt,
        owner: freeze.leaseOwner,
        token: freeze.leaseToken,
        now: freeze.now
      });
      assertExecutionSourceBinding(leaseTask, freeze);
      const racedReplay = await this.resolveFreezeReplay(freeze, transaction);
      if (racedReplay !== undefined) return racedReplay;
      await assertRunningRun(transaction, freeze);

      const posture = await transaction
        .selectFrom('agency_execution_posture')
        .select(['posture', 'version'])
        .where('singleton_id', '=', 'agency')
        .where('posture', '=', 'active')
        .where('version', '=', freeze.capturedPostureVersion)
        .executeTakeFirst();
      if (posture === undefined) {
        throw new Error('Agency execution posture changed before verification freeze');
      }

      const claim = await transaction
        .selectFrom('artifact_scope_claims')
        .selectAll()
        .where('claim_id', '=', freeze.artifactClaimId)
        .where('artifact_scope_key', '=', freeze.artifactScopeKey)
        .where('tenant_id', '=', freeze.tenantId)
        .where('automation_id', '=', freeze.automationId)
        .where('task_id', '=', freeze.taskId)
        .where('run_id', '=', freeze.runId)
        .where('state', '=', 'executing')
        .where('version', '=', freeze.expectedArtifactClaimVersion)
        .executeTakeFirst();
      if (claim === undefined) {
        throw new Error(`Artifact claim ${freeze.artifactClaimId} binding or version conflict`);
      }

      const source = await transaction
        .selectFrom('source_snapshot_claims')
        .select(['source_claim_id', 'source_registration_id'])
        .where('source_claim_id', '=', freeze.sourceClaimId)
        .where('artifact_claim_id', '=', freeze.artifactClaimId)
        .where('task_id', '=', freeze.taskId)
        .where('run_id', '=', freeze.runId)
        .where('tenant_id', '=', freeze.tenantId)
        .where('automation_id', '=', freeze.automationId)
        .where('source_sha256', '=', freeze.sourceSha256)
        .executeTakeFirst();
      if (source === undefined) {
        throw new Error(`Source snapshot ${freeze.sourceClaimId} binding mismatch`);
      }
      const expectedSourceClaimId = createSourceClaimId({
        artifactClaimId: freeze.artifactClaimId,
        sourceRegistrationId: source.source_registration_id
      });
      if (freeze.sourceClaimId !== expectedSourceClaimId) {
        throw new Error(`Source snapshot ${freeze.sourceClaimId} identity mismatch`);
      }

      await transaction
        .insertInto('run_completion_candidates')
        .values({
          candidate_id: freeze.candidateId,
          occurrence_id: freeze.occurrenceId,
          execution_request_id: freeze.executionRequestId,
          task_id: freeze.taskId,
          run_id: freeze.runId,
          tenant_id: freeze.tenantId,
          automation_id: freeze.automationId,
          worker_id: freeze.workerId,
          artifact_claim_id: freeze.artifactClaimId,
          artifact_scope_key: freeze.artifactScopeKey,
          source_claim_id: freeze.sourceClaimId,
          source_sha256: freeze.sourceSha256,
          result_schema_version: freeze.resultSchemaVersion,
          canonical_result_json: freeze.canonicalResultJson,
          result_sha256: freeze.resultSha256,
          artifact_sha256: freeze.artifactSha256,
          journal_claim_id: freeze.journalClaimId,
          journal_claim_sha256: freeze.journalClaimSha256,
          criteria_sha256: freeze.criteriaSha256,
          captured_posture_version: freeze.capturedPostureVersion,
          committed_at: freeze.committedAt
        })
        .execute();

      await transaction
        .insertInto('work_queue_verification_holds')
        .values({
          hold_id: freeze.holdId,
          candidate_id: freeze.candidateId,
          task_id: freeze.taskId,
          run_id: freeze.runId,
          tenant_id: freeze.tenantId,
          automation_id: freeze.automationId,
          execution_request_id: freeze.executionRequestId,
          occurrence_id: freeze.occurrenceId,
          artifact_claim_id: freeze.artifactClaimId,
          artifact_scope_key: freeze.artifactScopeKey,
          source_claim_id: freeze.sourceClaimId,
          leased_version: freeze.leasedVersion,
          queue_attempt: freeze.queueAttempt,
          lease_owner: freeze.leaseOwner,
          captured_posture_version: freeze.capturedPostureVersion,
          artifact_claim_version: freeze.expectedArtifactClaimVersion,
          verifier_id: freeze.verifierId,
          verifier_revision: freeze.verifierRevision,
          criteria_sha256: freeze.criteriaSha256,
          created_at: freeze.now,
          resolved_at: null
        })
        .execute();

      const nextArtifactClaimVersion = freeze.expectedArtifactClaimVersion + 1;
      const updated = await transaction
        .updateTable('artifact_scope_claims')
        .set({
          state: 'verification_pending',
          version: nextArtifactClaimVersion,
          updated_at: freeze.now
        })
        .where('claim_id', '=', freeze.artifactClaimId)
        .where('state', '=', 'executing')
        .where('version', '=', freeze.expectedArtifactClaimVersion)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) {
        throw new Error(
          `Artifact claim ${freeze.artifactClaimId} changed during verification freeze`
        );
      }

      return {
        holdId: freeze.holdId,
        candidateId: freeze.candidateId,
        artifactClaimId: freeze.artifactClaimId,
        artifactClaimVersion: nextArtifactClaimVersion,
        createdAt: freeze.now,
        replayed: false
      };
    });
  }

  async resolveHold(input: unknown): Promise<ResolvedVerificationSubjectV1> {
    const request = SettlementVerificationRequestV1Schema.parse(input);
    const row = await this.db
      .selectFrom('work_queue_verification_holds')
      .selectAll()
      .where('hold_id', '=', request.holdId)
      .where('resolved_at', 'is', null)
      .executeTakeFirst();
    if (row === undefined) {
      throw new Error(`Verification hold ${request.holdId} was not found or is resolved`);
    }
    const subject = ResolvedVerificationSubjectV1Schema.parse({
      tenantId: row.tenant_id,
      taskId: row.task_id,
      leasedVersion: row.leased_version,
      queueAttempt: row.queue_attempt,
      leaseOwner: row.lease_owner,
      runId: row.run_id,
      automationId: row.automation_id,
      executionRequestId: row.execution_request_id,
      occurrenceId: row.occurrence_id,
      candidateId: row.candidate_id,
      artifactClaimId: row.artifact_claim_id,
      artifactScopeKey: row.artifact_scope_key,
      sourceClaimId: row.source_claim_id,
      capturedPostureVersion: row.captured_posture_version,
      verifierId: row.verifier_id,
      verifierRevision: row.verifier_revision,
      criteriaSha256: row.criteria_sha256
    });
    const expectedHoldId = createVerificationHoldId({
      tenantId: subject.tenantId,
      queueTaskId: subject.taskId,
      leasedVersion: subject.leasedVersion,
      queueAttempt: subject.queueAttempt,
      runId: subject.runId
    });
    if (request.holdId !== expectedHoldId) {
      throw new Error(`Verification hold ${request.holdId} identity mismatch`);
    }
    return subject;
  }

  async readCandidate(candidateId: string): Promise<BoundedCandidateResult> {
    const id = VerificationOpaqueIdSchema.parse(candidateId);
    const row = await this.db
      .selectFrom('run_completion_candidates')
      .selectAll()
      .where('candidate_id', '=', id)
      .executeTakeFirst();
    if (row === undefined) {
      throw new Error(`Completion candidate ${id} was not found`);
    }
    const expectedTaskId = createQueueTaskId({
      executionRequestId: row.execution_request_id,
      tenantId: row.tenant_id,
      automationId: row.automation_id
    });
    const expectedRunId = createRunId({
      executionRequestId: row.execution_request_id,
      queueTaskId: expectedTaskId
    });
    const expectedArtifactClaimId = createArtifactClaimId({
      artifactScopeKey: row.artifact_scope_key,
      executionRequestId: row.execution_request_id,
      runId: expectedRunId
    });
    if (
      row.task_id !== expectedTaskId ||
      row.run_id !== expectedRunId ||
      row.artifact_claim_id !== expectedArtifactClaimId
    ) {
      throw new Error(`Completion candidate ${id} identity mismatch`);
    }
    if (sha256(row.canonical_result_json) !== row.result_sha256) {
      throw new Error(`Completion candidate ${id} result digest mismatch`);
    }
    const source = await this.db
      .selectFrom('source_snapshot_claims')
      .select(['source_registration_id', 'source_sha256'])
      .where('source_claim_id', '=', row.source_claim_id)
      .where('artifact_claim_id', '=', row.artifact_claim_id)
      .executeTakeFirst();
    if (
      source === undefined ||
      row.source_claim_id !==
        createSourceClaimId({
          artifactClaimId: row.artifact_claim_id,
          sourceRegistrationId: source.source_registration_id
        }) ||
      row.source_sha256 !== source.source_sha256
    ) {
      throw new Error(`Completion candidate ${id} source identity or digest mismatch`);
    }
    return BoundedCandidateResultSchema.parse({
      schemaVersion: 1,
      canonicalResultJson: row.canonical_result_json,
      resultSha256: row.result_sha256,
      artifactSha256: row.artifact_sha256,
      journalClaimSha256: row.journal_claim_sha256,
      sourceClaimId: row.source_claim_id,
      sourceSha256: row.source_sha256
    });
  }

  private async resolveFreezeReplay(
    freeze: FreezeCandidateInput,
    database: Kysely<JarvisDatabase> = this.db
  ): Promise<FreezeCandidateReceipt | undefined> {
    const hold = await database
      .selectFrom('work_queue_verification_holds')
      .selectAll()
      .where('hold_id', '=', freeze.holdId)
      .executeTakeFirst();
    const candidate = await database
      .selectFrom('run_completion_candidates')
      .selectAll()
      .where('candidate_id', '=', freeze.candidateId)
      .executeTakeFirst();
    if (hold === undefined && candidate === undefined) return undefined;
    if (
      hold === undefined ||
      candidate === undefined ||
      hold.candidate_id !== candidate.candidate_id
    ) {
      throw new Error(`Conflicting verification freeze replay for ${freeze.holdId}`);
    }

    const expectedCandidate = {
      candidateId: freeze.candidateId,
      occurrenceId: freeze.occurrenceId,
      executionRequestId: freeze.executionRequestId,
      taskId: freeze.taskId,
      runId: freeze.runId,
      tenantId: freeze.tenantId,
      automationId: freeze.automationId,
      workerId: freeze.workerId,
      artifactClaimId: freeze.artifactClaimId,
      artifactScopeKey: freeze.artifactScopeKey,
      sourceClaimId: freeze.sourceClaimId,
      sourceSha256: freeze.sourceSha256,
      resultSchemaVersion: freeze.resultSchemaVersion,
      canonicalResultJson: freeze.canonicalResultJson,
      resultSha256: freeze.resultSha256,
      artifactSha256: freeze.artifactSha256,
      journalClaimId: freeze.journalClaimId,
      journalClaimSha256: freeze.journalClaimSha256,
      criteriaSha256: freeze.criteriaSha256,
      capturedPostureVersion: freeze.capturedPostureVersion,
      committedAt: freeze.committedAt
    };
    const expectedHold = {
      holdId: freeze.holdId,
      candidateId: freeze.candidateId,
      taskId: freeze.taskId,
      runId: freeze.runId,
      tenantId: freeze.tenantId,
      automationId: freeze.automationId,
      executionRequestId: freeze.executionRequestId,
      occurrenceId: freeze.occurrenceId,
      artifactClaimId: freeze.artifactClaimId,
      artifactScopeKey: freeze.artifactScopeKey,
      sourceClaimId: freeze.sourceClaimId,
      leasedVersion: freeze.leasedVersion,
      queueAttempt: freeze.queueAttempt,
      leaseOwner: freeze.leaseOwner,
      capturedPostureVersion: freeze.capturedPostureVersion,
      artifactClaimVersion: freeze.expectedArtifactClaimVersion,
      verifierId: freeze.verifierId,
      verifierRevision: freeze.verifierRevision,
      criteriaSha256: freeze.criteriaSha256
    };
    if (
      !isDeepStrictEqual(candidateComparable(candidate), expectedCandidate) ||
      !isDeepStrictEqual(holdComparable(hold), expectedHold)
    ) {
      throw new Error(`Conflicting verification freeze replay for ${freeze.holdId}`);
    }

    const claim = await database
      .selectFrom('artifact_scope_claims')
      .select(['state', 'version'])
      .where('claim_id', '=', freeze.artifactClaimId)
      .executeTakeFirst();
    const expectedVersion = freeze.expectedArtifactClaimVersion + 1;
    const stillFrozen =
      hold.resolved_at === null &&
      claim?.state === 'verification_pending' &&
      claim.version === expectedVersion;
    const advancedAfterSettlement =
      hold.resolved_at !== null &&
      (claim?.state === 'finalization_pending' || claim?.state === 'released') &&
      claim.version > expectedVersion;
    if (!stillFrozen && !advancedAfterSettlement) {
      throw new Error(`Verification freeze ${freeze.holdId} has inconsistent artifact claim state`);
    }
    return {
      holdId: hold.hold_id,
      candidateId: hold.candidate_id,
      artifactClaimId: hold.artifact_claim_id,
      artifactClaimVersion: expectedVersion,
      createdAt: hold.created_at,
      replayed: true
    };
  }
}
