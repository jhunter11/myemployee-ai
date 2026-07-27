import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import SQLite from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/db/database';
import { PriorityQueueRepository } from '../../src/db/priority-queue-repository';
import { RunRepository } from '../../src/db/run-repository';
import { VerificationFreezeRepository } from '../../src/db/verification-freeze-repository';
import { MAX_CANDIDATE_RESULT_BYTES } from '../../src/queue/verification-contracts';
import {
  PRIMARY_EVIDENCE_BUSY_TIMEOUT_MS,
  SUPPORTED_PRIMARY_SCHEMA_VERSION,
  openPrimaryEvidenceReader
} from '../../src/reliability/primary-evidence-reader';
import {
  createArtifactClaimId,
  createExecutionRequestId,
  createQueueTaskId,
  createRunId,
  createSourceClaimId,
  createVerificationHoldId
} from '../../src/reliability/identities';

const projectRoot = join(__dirname, '..', '..');
const digest = (character: string): string => character.repeat(64);
const startedAt = '2026-07-22T14:00:00.000Z';
const frozenAt = '2026-07-22T14:00:10.000Z';
const tenantId = 'acme_corp';
const automationId = 'daily-report';
const sourceRequestId = 'request-001';
const sourceRegistrationId = 'daily-report-source-v1';
const executionRequestId = createExecutionRequestId({
  sourceKind: 'api',
  sourceId: sourceRequestId,
  tenantId,
  automationId
});
const taskId = createQueueTaskId({
  executionRequestId,
  tenantId,
  automationId
});
const runId = createRunId({ executionRequestId, queueTaskId: taskId });
const artifactScopeKey = 'scope:acme_corp:daily-report:report';
const artifactClaimId = createArtifactClaimId({
  artifactScopeKey,
  executionRequestId,
  runId
});
const sourceClaimId = createSourceClaimId({ artifactClaimId, sourceRegistrationId });
const leasedVersion = 2;
const queueAttempt = 1;
const holdId = createVerificationHoldId({
  tenantId,
  queueTaskId: taskId,
  leasedVersion,
  queueAttempt,
  runId
});
const candidateId = 'candidate-001';
const canonicalResultJson = '{"qualifiedCount":5,"sourceRows":10}';
const resultSha256 = createHash('sha256').update(canonicalResultJson, 'utf8').digest('hex');

describe('query-only primary evidence reader', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  async function createFixture(options: { schemaVersion?: number; wal?: boolean } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-primary-evidence-reader-'));
    temporaryRoots.push(root);
    const filename = join(root, 'primary.sqlite');
    const context = await createDatabase({ projectRoot, filename });
    try {
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
          reason: 'primary evidence reader fixture',
          source_proposal_id: null,
          source_proposal_version: null,
          source_confirmation_fingerprint: null,
          source_decision_id: null
        })
        .execute();
      const queue = new PriorityQueueRepository(context.db);
      await queue.enqueue({
        id: taskId,
        tenantId,
        lane: 'delivery',
        source: { kind: 'api', id: sourceRequestId, occurredAt: startedAt },
        payload: { kind: 'automation', automationId },
        policy: { band: 'P1', impact: 8, urgency: 6, effort: 3 },
        dependencies: []
      });
      const lease = await queue.claimNext({
        tenantId,
        workerId: 'jarvis:observer',
        leaseToken: 'lease-primary-reader-001',
        now: startedAt,
        leaseDurationMs: 60_000,
        payloadKinds: ['automation']
      });
      if (
        lease === null ||
        lease.version !== leasedVersion ||
        lease.lease.attempt !== queueAttempt
      ) {
        throw new Error('primary evidence reader fixture acquired an unexpected lease');
      }
      await new RunRepository(context.db).createRunning({
        id: runId,
        clientId: tenantId,
        automation: automationId,
        workerId: 'acme_daily_report',
        startedAt
      });
      const freezes = new VerificationFreezeRepository(context.db);
      await freezes.acquireArtifactClaim({
        schemaVersion: 1,
        claimId: artifactClaimId,
        artifactScopeKey,
        tenantId,
        automationId,
        taskId,
        executionRequestId,
        runId,
        capturedQueueVersion: leasedVersion,
        queueAttempt,
        leaseOwner: 'jarvis:observer',
        leaseToken: 'lease-primary-reader-001',
        acquiredAt: startedAt,
        now: startedAt
      });
      await freezes.recordSourceSnapshot({
        schemaVersion: 1,
        sourceClaimId,
        artifactClaimId,
        taskId,
        runId,
        tenantId,
        automationId,
        sourceRegistrationId,
        snapshotRelativePath: `claims/${artifactClaimId}/source.csv`,
        size: 1_024,
        sourceSha256: digest('1'),
        createdAt: '2026-07-22T14:00:01.000Z'
      });
      await freezes.freezeForVerification({
        schemaVersion: 1,
        holdId,
        candidateId,
        tenantId,
        taskId,
        leasedVersion,
        queueAttempt,
        leaseOwner: 'jarvis:observer',
        leaseToken: 'lease-primary-reader-001',
        runId,
        automationId,
        executionRequestId,
        occurrenceId: null,
        workerId: 'acme_daily_report',
        artifactClaimId,
        artifactScopeKey,
        expectedArtifactClaimVersion: 1,
        sourceClaimId,
        sourceSha256: digest('1'),
        resultSchemaVersion: 1,
        canonicalResultJson,
        resultSha256,
        artifactSha256: digest('2'),
        journalClaimId: 'journal-primary-reader-001',
        journalClaimSha256: digest('3'),
        criteriaSha256: digest('4'),
        capturedPostureVersion: 1,
        verifierId: 'daily-report-verifier',
        verifierRevision: 'v1',
        committedAt: '2026-07-22T14:00:09.000Z',
        now: frozenAt
      });
    } finally {
      await context.destroy();
    }

    if (options.schemaVersion !== undefined) {
      const database = new SQLite(filename);
      database.exec('DROP TRIGGER jarvis_primary_schema_monotonic_update');
      database
        .prepare(
          `UPDATE jarvis_primary_schema SET schema_version = ? WHERE singleton_id = 'primary'`
        )
        .run(options.schemaVersion);
      database.close();
    }
    if (options.wal === false) {
      const database = new SQLite(filename);
      database.pragma('journal_mode = DELETE');
      database.close();
    }
    return filename;
  }

  function tamperProtectedRow(
    filename: string,
    triggerName: string,
    mutate: (database: SQLite.Database) => void
  ): void {
    const database = new SQLite(filename);
    const trigger = database
      .prepare(`SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?`)
      .get(triggerName) as { sql: string } | undefined;
    if (trigger === undefined) throw new Error(`missing fixture trigger ${triggerName}`);
    database.exec(`DROP TRIGGER ${triggerName}`);
    mutate(database);
    database.exec(trigger.sql);
    database.close();
  }

  it('opens the existing WAL database with fixed fail-closed connection guards', async () => {
    const filename = await createFixture();
    const reader = openPrimaryEvidenceReader({ filename });

    expect(reader.status()).toEqual({
      readonly: true,
      queryOnly: true,
      foreignKeys: true,
      journalMode: 'wal',
      schemaVersion: SUPPORTED_PRIMARY_SCHEMA_VERSION,
      busyTimeoutMs: PRIMARY_EVIDENCE_BUSY_TIMEOUT_MS
    });
    expect(PRIMARY_EVIDENCE_BUSY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PRIMARY_EVIDENCE_BUSY_TIMEOUT_MS).toBeLessThanOrEqual(500);
    expect(Reflect.has(reader, 'database')).toBe(false);

    await reader.close();
    await expect(reader.close()).resolves.toBeUndefined();
    await expect(reader.readCandidate(candidateId)).rejects.toMatchObject({
      code: 'PRIMARY_EVIDENCE_READER_CLOSED'
    });
  });

  it('resolves bounded hold and candidate evidence without a caller-supplied tenant', async () => {
    const reader = openPrimaryEvidenceReader({ filename: await createFixture() });

    await expect(reader.resolveHold({ schemaVersion: 1, holdId })).resolves.toEqual({
      tenantId: 'acme_corp',
      taskId,
      leasedVersion,
      queueAttempt,
      leaseOwner: 'jarvis:observer',
      runId,
      automationId: 'daily-report',
      executionRequestId,
      occurrenceId: null,
      candidateId: 'candidate-001',
      artifactClaimId,
      artifactScopeKey,
      sourceClaimId,
      capturedPostureVersion: 1,
      verifierId: 'daily-report-verifier',
      verifierRevision: 'v1',
      criteriaSha256: digest('4')
    });
    await expect(reader.readCandidate(candidateId)).resolves.toEqual({
      schemaVersion: 1,
      canonicalResultJson,
      resultSha256,
      artifactSha256: digest('2'),
      journalClaimSha256: digest('3'),
      sourceClaimId,
      sourceSha256: digest('1')
    });
    await expect(reader.readCandidate('not valid')).rejects.toThrow();
    await expect(reader.resolveHold({ schemaVersion: 1, holdId: digest('f') })).rejects.toThrow(
      /not found or is resolved/iu
    );

    await reader.close();
  });

  it('rejects corrupted hold and candidate-to-source identity joins', async () => {
    const holdFilename = await createFixture();
    tamperProtectedRow(holdFilename, 'work_queue_verification_holds_guard_update', (database) => {
      database.prepare('UPDATE work_queue_verification_holds SET leased_version = 4').run();
    });
    const holdReader = openPrimaryEvidenceReader({ filename: holdFilename });

    await expect(holdReader.resolveHold({ schemaVersion: 1, holdId })).rejects.toThrow(
      /identity/iu
    );
    await holdReader.close();

    const sourceFilename = await createFixture();
    tamperProtectedRow(sourceFilename, 'source_snapshot_claims_no_update', (database) => {
      database.prepare('UPDATE source_snapshot_claims SET source_sha256 = ?').run(digest('9'));
    });
    const sourceReader = openPrimaryEvidenceReader({ filename: sourceFilename });

    await expect(sourceReader.readCandidate(candidateId)).rejects.toThrow(/source-evidence/iu);
    await sourceReader.close();

    const candidateFilename = await createFixture();
    tamperProtectedRow(candidateFilename, 'run_completion_candidates_no_update', (database) => {
      database
        .prepare('UPDATE run_completion_candidates SET execution_request_id = ?')
        .run(digest('8'));
    });
    const candidateReader = openPrimaryEvidenceReader({ filename: candidateFilename });
    await expect(candidateReader.readCandidate(candidateId)).rejects.toThrow(/identity/iu);
    await candidateReader.close();
  });

  it('rejects an incomplete manifest and oversized candidate bytes before projection', async () => {
    const manifestFilename = await createFixture();
    const manifestWriter = new SQLite(manifestFilename);
    manifestWriter.exec('DROP TRIGGER run_completion_candidates_no_delete');
    manifestWriter.close();
    expect(() => openPrimaryEvidenceReader({ filename: manifestFilename })).toThrow(/manifest/iu);

    const oversizedFilename = await createFixture();
    tamperProtectedRow(oversizedFilename, 'run_completion_candidates_no_update', (database) => {
      const oversizedResult = JSON.stringify('x'.repeat(MAX_CANDIDATE_RESULT_BYTES));
      database.pragma('ignore_check_constraints = ON');
      database
        .prepare(
          `UPDATE run_completion_candidates
           SET canonical_result_json = ?, result_sha256 = ?
           WHERE candidate_id = ?`
        )
        .run(
          oversizedResult,
          createHash('sha256').update(oversizedResult, 'utf8').digest('hex'),
          candidateId
        );
    });
    const oversizedReader = openPrimaryEvidenceReader({ filename: oversizedFilename });
    await expect(oversizedReader.readCandidate(candidateId)).rejects.toThrow(/bounded/iu);
    await oversizedReader.close();
  });

  it('normalizes bounded lock contention and recovers after the writer releases it', async () => {
    const filename = await createFixture();
    const writer = new SQLite(filename, { timeout: PRIMARY_EVIDENCE_BUSY_TIMEOUT_MS });
    writer.pragma('locking_mode = EXCLUSIVE');
    writer.exec('BEGIN EXCLUSIVE');
    const started = Date.now();

    try {
      expect(() => openPrimaryEvidenceReader({ filename })).toThrow(
        expect.objectContaining({ code: 'PRIMARY_EVIDENCE_BUSY' })
      );
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }

    const recovered = openPrimaryEvidenceReader({ filename });
    await expect(recovered.resolveHold({ schemaVersion: 1, holdId })).resolves.toMatchObject({
      candidateId
    });
    await recovered.close();
  });

  it('normalizes a missing version marker as a schema mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-primary-evidence-partial-'));
    temporaryRoots.push(root);
    const filename = join(root, 'partial.sqlite');
    const database = new SQLite(filename);
    database.pragma('journal_mode = WAL');
    database.close();

    expect(() => openPrimaryEvidenceReader({ filename })).toThrow(
      expect.objectContaining({ code: 'PRIMARY_EVIDENCE_SCHEMA_MISMATCH' })
    );
  });

  it.each([SUPPORTED_PRIMARY_SCHEMA_VERSION - 1, SUPPORTED_PRIMARY_SCHEMA_VERSION + 1])(
    'rejects unsupported primary schema version %s',
    async (schemaVersion) => {
      const filename = await createFixture({ schemaVersion });

      expect(() => openPrimaryEvidenceReader({ filename })).toThrow(/schema version/iu);
    }
  );

  it('rejects a non-WAL database and never creates a missing database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-primary-evidence-missing-'));
    temporaryRoots.push(root);
    const nonWalFilename = await createFixture({ wal: false });

    expect(() => openPrimaryEvidenceReader({ filename: nonWalFilename })).toThrow(/WAL/iu);
    expect(() => openPrimaryEvidenceReader({ filename: join(root, 'missing.sqlite') })).toThrow();
    expect(() =>
      openPrimaryEvidenceReader({
        filename: nonWalFilename,
        busyTimeoutMs: 60_000
      } as never)
    ).toThrow(/only an existing database filename/iu);
  });
});
