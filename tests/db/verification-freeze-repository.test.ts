import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import { PriorityQueueRepository } from '../../src/db/priority-queue-repository';
import { RunRepository } from '../../src/db/run-repository';
import { VerificationFreezeRepository } from '../../src/db/verification-freeze-repository';
import {
  createArtifactClaimId,
  createExecutionRequestId,
  createQueueTaskId,
  createRunId,
  createSourceClaimId,
  createVerificationHoldId
} from '../../src/reliability/identities';
import {
  AcquireArtifactClaimInputSchema,
  BoundedCandidateResultSchema,
  CanonicalCandidateResultJsonSchema,
  FreezeCandidateInputSchema,
  RecordSourceSnapshotInputSchema
} from '../../src/queue/verification-contracts';

const projectRoot = join(__dirname, '..', '..');
const startedAt = '2026-07-22T14:00:00.000Z';
const frozenAt = '2026-07-22T14:00:10.000Z';
const afterExpiry = '2026-07-22T14:01:01.000Z';
const digest = (character: string): string => character.repeat(64);
const tenantId = 'acme_corp';
const automationId = 'daily-report';
const sourceRequestId = 'request-freeze-001';
const executionRequestId = createExecutionRequestId({
  sourceKind: 'api',
  sourceId: sourceRequestId,
  tenantId,
  automationId
});
const taskId = createQueueTaskId({ executionRequestId, tenantId, automationId });
const runId = createRunId({ executionRequestId, queueTaskId: taskId });
const artifactScopeKey = 'scope:acme_corp:daily-report:report';
const claimId = createArtifactClaimId({ artifactScopeKey, executionRequestId, runId });
const sourceRegistrationId = 'source:acme_corp:daily-report:csv';
const sourceClaimId = createSourceClaimId({ artifactClaimId: claimId, sourceRegistrationId });
const candidateId = 'candidate-freeze-001';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('VerificationFreezeRepository', () => {
  let temporaryRoot: string;
  let context: GlobalDatabaseContext;
  let queue: PriorityQueueRepository;
  let freezes: VerificationFreezeRepository;
  let lease: Awaited<ReturnType<PriorityQueueRepository['claimNext']>>;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-verification-freeze-'));
    context = await createDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    await context.db
      .insertInto('client_registry')
      .values({
        id: tenantId,
        name: 'Acme Corporation',
        profile_type: 'data_processing',
        created_at: startedAt,
        status: 'active'
      })
      .execute();
    await context.db
      .insertInto('agency_execution_posture')
      .values({
        singleton_id: 'agency',
        posture: 'active',
        version: 1,
        updated_at: startedAt,
        updated_by: 'principal:web_operator',
        reason: 'verification freeze fixture',
        source_proposal_id: null,
        source_proposal_version: null,
        source_confirmation_fingerprint: null,
        source_decision_id: null
      })
      .execute();
    queue = new PriorityQueueRepository(context.db);
    await queue.enqueue({
      id: taskId,
      tenantId,
      lane: 'delivery',
      source: { kind: 'api', id: sourceRequestId, occurredAt: startedAt },
      payload: { kind: 'automation', automationId },
      policy: { band: 'P1', impact: 8, urgency: 6, effort: 3 },
      dependencies: []
    });
    lease = await queue.claimNext({
      tenantId,
      workerId: 'jarvis:automation-cycle',
      leaseToken: 'lease-freeze-001',
      now: startedAt,
      leaseDurationMs: 60_000,
      payloadKinds: ['automation']
    });
    await new RunRepository(context.db).createRunning({
      id: runId,
      clientId: tenantId,
      automation: automationId,
      workerId: 'acme_daily_report',
      startedAt
    });
    freezes = new VerificationFreezeRepository(context.db);
  });

  afterEach(async () => {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  function acquireInput(overrides: Record<string, unknown> = {}) {
    if (lease === null) throw new Error('fixture did not acquire queue lease');
    return {
      schemaVersion: 1 as const,
      claimId,
      artifactScopeKey,
      tenantId,
      automationId,
      taskId,
      executionRequestId,
      runId,
      capturedQueueVersion: lease.version,
      queueAttempt: lease.lease.attempt,
      leaseOwner: 'jarvis:automation-cycle',
      leaseToken: lease.lease.token,
      acquiredAt: startedAt,
      now: startedAt,
      ...overrides
    };
  }

  function sourceInput(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1 as const,
      sourceClaimId,
      artifactClaimId: claimId,
      taskId,
      runId,
      tenantId,
      automationId,
      sourceRegistrationId,
      snapshotRelativePath: `claims/${claimId}/source.csv`,
      size: 1_024,
      sourceSha256: digest('1'),
      createdAt: '2026-07-22T14:00:01.000Z',
      ...overrides
    };
  }

  function freezeInput(overrides: Record<string, unknown> = {}) {
    if (lease === null) throw new Error('fixture did not acquire queue lease');
    const canonicalResultJson = '{"qualifiedCount":5,"sourceRows":10}';
    const holdId = createVerificationHoldId({
      tenantId,
      queueTaskId: taskId,
      leasedVersion: lease.version,
      queueAttempt: lease.lease.attempt,
      runId
    });
    return {
      schemaVersion: 1 as const,
      holdId,
      candidateId,
      tenantId,
      taskId,
      leasedVersion: lease.version,
      queueAttempt: lease.lease.attempt,
      leaseOwner: 'jarvis:automation-cycle',
      leaseToken: lease.lease.token,
      runId,
      automationId,
      executionRequestId,
      occurrenceId: null,
      workerId: 'acme_daily_report',
      artifactClaimId: claimId,
      artifactScopeKey,
      expectedArtifactClaimVersion: 1,
      sourceClaimId,
      sourceSha256: digest('1'),
      resultSchemaVersion: 1,
      canonicalResultJson,
      resultSha256: sha256(canonicalResultJson),
      artifactSha256: digest('2'),
      journalClaimId: 'journal-freeze-001',
      journalClaimSha256: digest('3'),
      criteriaSha256: digest('4'),
      capturedPostureVersion: 1,
      verifierId: 'acme-daily-report',
      verifierRevision: 'v1',
      committedAt: '2026-07-22T14:00:09.000Z',
      now: frozenAt,
      ...overrides
    };
  }

  async function acquireAndSnapshot(): Promise<void> {
    await freezes.acquireArtifactClaim(acquireInput());
    await freezes.recordSourceSnapshot(sourceInput());
  }

  it('acquires one active scope claim and makes exact replay explicit', async () => {
    await expect(freezes.acquireArtifactClaim(acquireInput())).resolves.toEqual({
      claimId,
      state: 'executing',
      version: 1,
      acquiredAt: startedAt,
      replayed: false
    });
    await expect(freezes.acquireArtifactClaim(acquireInput())).resolves.toMatchObject({
      claimId,
      replayed: true
    });
    await expect(
      freezes.acquireArtifactClaim(acquireInput({ artifactScopeKey: 'scope:changed' }))
    ).rejects.toThrow(/claimId|conflicting artifact claim replay/i);
  });

  it('validates every generated freeze identity from its canonical bindings', () => {
    expect(
      AcquireArtifactClaimInputSchema.safeParse({ ...acquireInput(), executionRequestId }).success
    ).toBe(true);
    expect(
      AcquireArtifactClaimInputSchema.safeParse({
        ...acquireInput(),
        executionRequestId,
        claimId: digest('f')
      }).success
    ).toBe(false);
    expect(RecordSourceSnapshotInputSchema.safeParse(sourceInput()).success).toBe(true);
    expect(
      RecordSourceSnapshotInputSchema.safeParse({
        ...sourceInput(),
        sourceClaimId: digest('e')
      }).success
    ).toBe(false);
    expect(FreezeCandidateInputSchema.safeParse(freezeInput()).success).toBe(true);
    expect(
      FreezeCandidateInputSchema.safeParse({ ...freezeInput(), holdId: digest('d') }).success
    ).toBe(false);
    expect(
      FreezeCandidateInputSchema.safeParse({ ...freezeInput(), resultSha256: digest('9') }).success
    ).toBe(false);
    expect(
      BoundedCandidateResultSchema.safeParse({
        schemaVersion: 1,
        canonicalResultJson: freezeInput().canonicalResultJson,
        resultSha256: digest('9'),
        artifactSha256: digest('2'),
        journalClaimSha256: digest('3'),
        sourceClaimId,
        sourceSha256: digest('1')
      }).success
    ).toBe(false);
    expect(
      RecordSourceSnapshotInputSchema.safeParse({
        ...sourceInput(),
        snapshotRelativePath: `claims/${claimId}/unsafe\nname.csv`
      }).success
    ).toBe(false);
  });

  it('rejects duplicate-key and noncanonical candidate JSON before persistence', async () => {
    const duplicateKeyJson = '{"qualifiedCount":5,"qualifiedCount":6,"sourceRows":10}';
    const whitespaceJson = '{ "qualifiedCount":5,"sourceRows":10 }';
    expect(
      CanonicalCandidateResultJsonSchema.safeParse(freezeInput().canonicalResultJson).success
    ).toBe(true);
    expect(CanonicalCandidateResultJsonSchema.safeParse(duplicateKeyJson).success).toBe(false);
    expect(CanonicalCandidateResultJsonSchema.safeParse(whitespaceJson).success).toBe(false);

    await acquireAndSnapshot();
    await expect(
      freezes.freezeForVerification(
        freezeInput({
          canonicalResultJson: duplicateKeyJson,
          resultSha256: sha256(duplicateKeyJson)
        })
      )
    ).rejects.toThrow(/canonical|duplicate/i);
    expect(
      context.sqlite.prepare(`SELECT COUNT(*) AS count FROM run_completion_candidates`).get()
    ).toEqual({ count: 0 });
  });

  it('persists an immutable infrastructure-derived source snapshot claim', async () => {
    await freezes.acquireArtifactClaim(acquireInput());
    await expect(freezes.recordSourceSnapshot(sourceInput())).resolves.toMatchObject({
      sourceClaimId,
      sourceSha256: digest('1'),
      replayed: false
    });
    await expect(freezes.recordSourceSnapshot(sourceInput())).resolves.toMatchObject({
      replayed: true
    });
    await expect(
      freezes.recordSourceSnapshot(sourceInput({ sourceSha256: digest('9') }))
    ).rejects.toThrow(/conflicting source snapshot replay/i);
    expect(() =>
      context.sqlite
        .prepare(
          `INSERT INTO source_snapshot_claims (
             source_claim_id, artifact_claim_id, task_id, run_id, tenant_id, automation_id,
             source_registration_id, snapshot_relative_path, size, source_sha256, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          digest('7'),
          claimId,
          taskId,
          runId,
          tenantId,
          automationId,
          sourceRegistrationId,
          'claims//source.csv',
          1_024,
          digest('8'),
          '2026-07-22T14:00:02.000Z'
        )
    ).toThrow(/check constraint/i);
    expect(() =>
      context.sqlite
        .prepare(`UPDATE source_snapshot_claims SET size = size + 1 WHERE source_claim_id = ?`)
        .run(sourceClaimId)
    ).toThrow(/append-only/i);
  });

  it('collapses concurrent exact retries into one durable freeze', async () => {
    const claimReceipts = await Promise.all([
      freezes.acquireArtifactClaim(acquireInput()),
      freezes.acquireArtifactClaim(acquireInput())
    ]);
    expect(claimReceipts.map((receipt) => receipt.replayed).sort()).toEqual([false, true]);

    const sourceReceipts = await Promise.all([
      freezes.recordSourceSnapshot(sourceInput()),
      freezes.recordSourceSnapshot(sourceInput())
    ]);
    expect(sourceReceipts.map((receipt) => receipt.replayed).sort()).toEqual([false, true]);

    const freezeReceipts = await Promise.all([
      freezes.freezeForVerification(freezeInput()),
      freezes.freezeForVerification(freezeInput())
    ]);
    expect(freezeReceipts.map((receipt) => receipt.replayed).sort()).toEqual([false, true]);
    expect(
      context.sqlite.prepare(`SELECT COUNT(*) AS count FROM run_completion_candidates`).get()
    ).toEqual({ count: 1 });
    expect(
      context.sqlite.prepare(`SELECT COUNT(*) AS count FROM work_queue_verification_holds`).get()
    ).toEqual({ count: 1 });
  });

  it('freezes candidate, hold, and claim transition atomically without storing the raw token', async () => {
    await acquireAndSnapshot();

    await expect(freezes.freezeForVerification(freezeInput())).resolves.toEqual({
      holdId: freezeInput().holdId,
      candidateId,
      artifactClaimId: claimId,
      artifactClaimVersion: 2,
      createdAt: frozenAt,
      replayed: false
    });
    await expect(freezes.freezeForVerification(freezeInput({ now: afterExpiry }))).resolves.toEqual(
      {
        holdId: freezeInput().holdId,
        candidateId,
        artifactClaimId: claimId,
        artifactClaimVersion: 2,
        createdAt: frozenAt,
        replayed: true
      }
    );
    await expect(freezes.acquireArtifactClaim(acquireInput({ now: afterExpiry }))).resolves.toEqual(
      {
        claimId,
        state: 'executing',
        version: 1,
        acquiredAt: startedAt,
        replayed: true
      }
    );

    const claim = context.sqlite
      .prepare(`SELECT state, version FROM artifact_scope_claims WHERE claim_id = ?`)
      .get(claimId);
    expect(claim).toEqual({ state: 'verification_pending', version: 2 });
    const holdColumns = context.sqlite
      .prepare(`PRAGMA table_info(work_queue_verification_holds)`)
      .all()
      .map((row) => (row as { name: string }).name);
    expect(holdColumns).not.toContain('lease_token');

    await expect(
      freezes.resolveHold({ schemaVersion: 1, holdId: freezeInput().holdId })
    ).resolves.toMatchObject({
      tenantId,
      taskId,
      runId,
      candidateId,
      artifactClaimId: claimId,
      sourceClaimId,
      verifierId: 'acme-daily-report',
      verifierRevision: 'v1'
    });
    await expect(freezes.readCandidate(candidateId)).resolves.toMatchObject({
      schemaVersion: 1,
      resultSha256: freezeInput().resultSha256,
      sourceClaimId,
      sourceSha256: digest('1')
    });
  });

  it('replays the original freeze receipt after guarded settlement advances the hold and claim', async () => {
    await acquireAndSnapshot();
    const original = freezeInput();
    await freezes.freezeForVerification(original);

    context.sqlite
      .prepare(`UPDATE work_queue_verification_holds SET resolved_at = ? WHERE hold_id = ?`)
      .run(afterExpiry, original.holdId);
    context.sqlite.exec(`DROP TRIGGER artifact_scope_claims_guard_transition`);
    context.sqlite
      .prepare(
        `UPDATE artifact_scope_claims
         SET state = 'finalization_pending', version = version + 1, updated_at = ?
         WHERE claim_id = ?`
      )
      .run(afterExpiry, claimId);

    await expect(freezes.freezeForVerification({ ...original, now: afterExpiry })).resolves.toEqual(
      {
        holdId: original.holdId,
        candidateId,
        artifactClaimId: claimId,
        artifactClaimVersion: 2,
        createdAt: frozenAt,
        replayed: true
      }
    );
  });

  it('fails closed when frozen identity or result-digest bindings are inconsistent', async () => {
    await acquireAndSnapshot();
    const frozen = freezeInput();
    await freezes.freezeForVerification(frozen);

    context.sqlite.exec(`DROP TRIGGER work_queue_verification_holds_guard_update`);
    context.sqlite
      .prepare(
        `UPDATE work_queue_verification_holds
         SET leased_version = leased_version + 1
         WHERE hold_id = ?`
      )
      .run(frozen.holdId);
    await expect(freezes.resolveHold({ schemaVersion: 1, holdId: frozen.holdId })).rejects.toThrow(
      /identity/i
    );

    context.sqlite.exec(`DROP TRIGGER run_completion_candidates_no_update`);
    context.sqlite
      .prepare(`UPDATE run_completion_candidates SET result_sha256 = ? WHERE candidate_id = ?`)
      .run(digest('9'), candidateId);
    await expect(freezes.readCandidate(candidateId)).rejects.toThrow(/digest/i);
  });

  it('binds execution-request and occurrence identity to the immutable queue source', async () => {
    await acquireAndSnapshot();
    await expect(
      freezes.freezeForVerification(freezeInput({ occurrenceId: digest('a') }))
    ).rejects.toThrow(/occurrence/i);

    context.sqlite.exec(`DROP TRIGGER work_queue_task_contract_immutable`);
    context.sqlite
      .prepare(`UPDATE work_queue_tasks SET source_id = ? WHERE id = ?`)
      .run('request-freeze-tampered', taskId);
    await expect(freezes.freezeForVerification(freezeInput())).rejects.toThrow(
      /execution-request identity/i
    );
    expect(
      context.sqlite.prepare(`SELECT COUNT(*) AS count FROM run_completion_candidates`).get()
    ).toEqual({ count: 0 });
  });

  it('rejects stale lease, posture, and claim bindings without leaving a candidate or hold', async () => {
    await acquireAndSnapshot();
    await expect(
      freezes.freezeForVerification(freezeInput({ leaseToken: 'lease-wrong-token' }))
    ).rejects.toThrow(/lease or version/i);
    await expect(
      freezes.freezeForVerification(freezeInput({ capturedPostureVersion: 2 }))
    ).rejects.toThrow(/execution posture/i);
    await expect(
      freezes.freezeForVerification(freezeInput({ expectedArtifactClaimVersion: 2 }))
    ).rejects.toThrow(/artifact claim/i);

    const counts = context.sqlite
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM run_completion_candidates) AS candidates,
           (SELECT COUNT(*) FROM work_queue_verification_holds) AS holds,
           (SELECT version FROM artifact_scope_claims WHERE claim_id = ?) AS claim_version`
      )
      .get(claimId);
    expect(counts).toEqual({ candidates: 0, holds: 0, claim_version: 1 });
  });

  it('rejects freeze after lease expiry', async () => {
    await acquireAndSnapshot();
    await expect(
      freezes.freezeForVerification(freezeInput({ committedAt: afterExpiry, now: afterExpiry }))
    ).rejects.toThrow(/lease or version/i);
  });

  it('rolls back candidate insertion when hold persistence fails', async () => {
    await acquireAndSnapshot();
    context.sqlite.exec(`
      CREATE TRIGGER reject_test_verification_hold
      BEFORE INSERT ON work_queue_verification_holds
      BEGIN
        SELECT RAISE(ABORT, 'simulated hold persistence failure');
      END;
    `);

    await expect(freezes.freezeForVerification(freezeInput())).rejects.toThrow(
      /simulated hold persistence failure/i
    );
    const counts = context.sqlite
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM run_completion_candidates) AS candidates,
           (SELECT COUNT(*) FROM work_queue_verification_holds) AS holds,
           (SELECT state FROM artifact_scope_claims WHERE claim_id = ?) AS claim_state`
      )
      .get(claimId);
    expect(counts).toEqual({ candidates: 0, holds: 0, claim_state: 'executing' });
  });

  it('keeps an expired held task blocked from reclaim and direct lease mutation', async () => {
    await acquireAndSnapshot();
    await freezes.freezeForVerification(freezeInput());

    await expect(
      queue.claimNext({
        tenantId,
        workerId: 'jarvis:other-worker',
        leaseToken: 'lease-reclaim-attempt',
        now: afterExpiry,
        leaseDurationMs: 60_000,
        payloadKinds: ['automation']
      })
    ).resolves.toBeNull();
    await expect(
      queue.readTenantQueue({ tenantId, limit: 10, now: afterExpiry })
    ).resolves.toMatchObject({
      lanes: [{ blocked: [expect.objectContaining({ id: taskId, ready: false })] }]
    });
    expect(() =>
      context.sqlite
        .prepare(
          `UPDATE work_queue_tasks
           SET lease_owner = 'attacker', lease_token = 'attacker-token', version = version + 1
           WHERE id = ?`
        )
        .run(taskId)
    ).toThrow(/verification hold/i);
  });
});
