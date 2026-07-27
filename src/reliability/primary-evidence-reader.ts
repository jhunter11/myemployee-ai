import SQLite from 'better-sqlite3';

import {
  BoundedCandidateResultSchema,
  MAX_CANDIDATE_RESULT_BYTES,
  ResolvedVerificationSubjectV1Schema,
  SettlementVerificationRequestV1Schema,
  VerificationOpaqueIdSchema,
  type BoundedCandidateResult,
  type ResolvedVerificationSubjectV1
} from '../queue/verification-contracts';
import {
  createArtifactClaimId,
  createQueueTaskId,
  createRunId,
  createSourceClaimId,
  createVerificationHoldId
} from './identities';

export const SUPPORTED_PRIMARY_SCHEMA_VERSION = 19;
export const PRIMARY_EVIDENCE_BUSY_TIMEOUT_MS = 250;

export type PrimaryEvidencePortErrorCode =
  | 'PRIMARY_EVIDENCE_BUSY'
  | 'PRIMARY_EVIDENCE_CONNECTION_GUARD_FAILED'
  | 'PRIMARY_EVIDENCE_INTEGRITY_CONFLICT'
  | 'PRIMARY_EVIDENCE_NOT_FOUND'
  | 'PRIMARY_EVIDENCE_NOT_WAL'
  | 'PRIMARY_EVIDENCE_READER_CLOSED'
  | 'PRIMARY_EVIDENCE_SCHEMA_MISMATCH';

export class PrimaryEvidencePortError extends Error {
  constructor(
    readonly code: PrimaryEvidencePortErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'PrimaryEvidencePortError';
  }
}

export interface PrimaryEvidenceReaderStatus {
  readonly: true;
  queryOnly: true;
  foreignKeys: true;
  journalMode: 'wal';
  schemaVersion: typeof SUPPORTED_PRIMARY_SCHEMA_VERSION;
  busyTimeoutMs: typeof PRIMARY_EVIDENCE_BUSY_TIMEOUT_MS;
}

export interface PrimaryEvidenceReader {
  status(): PrimaryEvidenceReaderStatus;
  resolveHold(input: unknown): Promise<ResolvedVerificationSubjectV1>;
  readCandidate(candidateId: string): Promise<BoundedCandidateResult>;
  close(): Promise<void>;
}

interface PrimarySchemaRow {
  schemaVersion: number;
  rowCount: number;
}

interface SchemaObjectRow {
  type: string;
  name: string;
  tableName: string;
}

interface TableColumnRow {
  name: string;
}

interface CandidateEvidenceRow {
  tenantId: string;
  automationId: string;
  executionRequestId: string;
  taskId: string;
  runId: string;
  artifactScopeKey: string;
  canonicalResultJson: string;
  resultSha256: string;
  artifactSha256: string;
  journalClaimSha256: string;
  sourceClaimId: string;
  sourceSha256: string;
  artifactClaimId: string;
  sourceArtifactClaimId: string;
  sourceRegistrationId: string;
}

const REQUIRED_SCHEMA_OBJECTS = Object.freeze([
  ['table', 'agency_execution_posture', 'agency_execution_posture'],
  ['table', 'agent_runs', 'agent_runs'],
  ['table', 'artifact_scope_claims', 'artifact_scope_claims'],
  ['table', 'jarvis_primary_schema', 'jarvis_primary_schema'],
  ['table', 'run_completion_candidates', 'run_completion_candidates'],
  ['table', 'source_snapshot_claims', 'source_snapshot_claims'],
  ['table', 'work_queue_tasks', 'work_queue_tasks'],
  ['table', 'work_queue_verification_holds', 'work_queue_verification_holds'],
  ['index', 'idx_artifact_scope_claims_one_active_scope', 'artifact_scope_claims'],
  ['index', 'idx_run_completion_candidates_task', 'run_completion_candidates'],
  ['index', 'idx_source_snapshot_claims_artifact', 'source_snapshot_claims'],
  ['index', 'idx_work_queue_verification_holds_active_scope', 'work_queue_verification_holds'],
  ['trigger', 'artifact_scope_claims_guard_transition', 'artifact_scope_claims'],
  ['trigger', 'artifact_scope_claims_immutable_ownership', 'artifact_scope_claims'],
  ['trigger', 'artifact_scope_claims_no_delete', 'artifact_scope_claims'],
  ['trigger', 'artifact_scope_claims_validate_binding', 'artifact_scope_claims'],
  ['trigger', 'jarvis_primary_schema_monotonic_update', 'jarvis_primary_schema'],
  ['trigger', 'jarvis_primary_schema_no_delete', 'jarvis_primary_schema'],
  ['trigger', 'run_completion_candidates_no_delete', 'run_completion_candidates'],
  ['trigger', 'run_completion_candidates_no_update', 'run_completion_candidates'],
  ['trigger', 'run_completion_candidates_validate_binding', 'run_completion_candidates'],
  ['trigger', 'source_snapshot_claims_no_delete', 'source_snapshot_claims'],
  ['trigger', 'source_snapshot_claims_no_update', 'source_snapshot_claims'],
  ['trigger', 'source_snapshot_claims_validate_binding', 'source_snapshot_claims'],
  ['trigger', 'work_queue_tasks_hold_fence', 'work_queue_tasks'],
  ['trigger', 'work_queue_verification_holds_guard_update', 'work_queue_verification_holds'],
  ['trigger', 'work_queue_verification_holds_no_delete', 'work_queue_verification_holds'],
  ['trigger', 'work_queue_verification_holds_validate_binding', 'work_queue_verification_holds']
] as const);

const REQUIRED_TABLE_COLUMNS = Object.freeze({
  jarvis_primary_schema: ['singleton_id', 'schema_version'],
  run_completion_candidates: [
    'candidate_id',
    'occurrence_id',
    'execution_request_id',
    'task_id',
    'run_id',
    'tenant_id',
    'automation_id',
    'worker_id',
    'artifact_claim_id',
    'artifact_scope_key',
    'source_claim_id',
    'source_sha256',
    'result_schema_version',
    'canonical_result_json',
    'result_sha256',
    'artifact_sha256',
    'journal_claim_id',
    'journal_claim_sha256',
    'criteria_sha256',
    'captured_posture_version',
    'committed_at'
  ],
  source_snapshot_claims: [
    'source_claim_id',
    'artifact_claim_id',
    'task_id',
    'run_id',
    'tenant_id',
    'automation_id',
    'source_registration_id',
    'snapshot_relative_path',
    'size',
    'source_sha256',
    'created_at'
  ],
  work_queue_verification_holds: [
    'hold_id',
    'candidate_id',
    'task_id',
    'run_id',
    'tenant_id',
    'automation_id',
    'execution_request_id',
    'occurrence_id',
    'artifact_claim_id',
    'artifact_scope_key',
    'source_claim_id',
    'leased_version',
    'queue_attempt',
    'lease_owner',
    'captured_posture_version',
    'artifact_claim_version',
    'verifier_id',
    'verifier_revision',
    'criteria_sha256',
    'created_at',
    'resolved_at'
  ]
} as const);

function sqliteFailureCode(error: unknown): string | undefined {
  return error instanceof SQLite.SqliteError ? error.code : undefined;
}

function normalizePortError(error: unknown): unknown {
  if (error instanceof PrimaryEvidencePortError) return error;
  const code = sqliteFailureCode(error);
  if (code?.startsWith('SQLITE_BUSY') === true || code?.startsWith('SQLITE_LOCKED') === true) {
    return new PrimaryEvidencePortError(
      'PRIMARY_EVIDENCE_BUSY',
      'Primary evidence database remained busy beyond the fixed read deadline'
    );
  }
  return error;
}

function schemaMismatch(message: string): PrimaryEvidencePortError {
  return new PrimaryEvidencePortError('PRIMARY_EVIDENCE_SCHEMA_MISMATCH', message);
}

function assertSchemaManifest(database: SQLite.Database): void {
  try {
    const names = REQUIRED_SCHEMA_OBJECTS.map(([, name]) => name);
    const placeholders = names.map(() => '?').join(', ');
    const rows = database
      .prepare(
        `SELECT type, name, tbl_name AS tableName
         FROM sqlite_schema
         WHERE name IN (${placeholders})
         ORDER BY type, name
         LIMIT ${REQUIRED_SCHEMA_OBJECTS.length}`
      )
      .all(...names) as SchemaObjectRow[];
    const actualObjects = rows.map((row) => [row.type, row.name, row.tableName].join(':')).sort();
    const expectedObjects = REQUIRED_SCHEMA_OBJECTS.map((row) => row.join(':')).sort();
    if (
      actualObjects.length !== expectedObjects.length ||
      actualObjects.some((value, index) => value !== expectedObjects[index])
    ) {
      throw schemaMismatch('Primary evidence schema object manifest is incomplete');
    }

    for (const [tableName, expectedColumns] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
      const columns = database
        .prepare(`PRAGMA table_xinfo('${tableName}')`)
        .all() as TableColumnRow[];
      const actualColumns = columns.map((row) => row.name);
      if (
        actualColumns.length !== expectedColumns.length ||
        actualColumns.some((value, index) => value !== expectedColumns[index])
      ) {
        throw schemaMismatch(`Primary evidence schema columns do not match ${tableName}`);
      }
    }
  } catch (error) {
    if (error instanceof PrimaryEvidencePortError) throw error;
    const normalized = normalizePortError(error);
    if (normalized instanceof PrimaryEvidencePortError) throw normalized;
    throw schemaMismatch('Primary evidence schema manifest could not be verified');
  }
}

function integerPragma(database: SQLite.Database, name: string): number {
  const value = database.pragma(name, { simple: true });
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new PrimaryEvidencePortError(
      'PRIMARY_EVIDENCE_CONNECTION_GUARD_FAILED',
      `Primary evidence connection returned an invalid ${name} value`
    );
  }
  return value;
}

function assertMutationRejected(database: SQLite.Database): void {
  try {
    database
      .prepare(
        `UPDATE jarvis_primary_schema
         SET schema_version = schema_version
         WHERE singleton_id = '__read_only_probe__'`
      )
      .run();
  } catch (error) {
    if (
      error instanceof SQLite.SqliteError &&
      ['SQLITE_READONLY', 'SQLITE_READONLY_DBMOVED', 'SQLITE_READONLY_CANTLOCK'].includes(
        error.code
      )
    ) {
      return;
    }
    throw error;
  }
  throw new PrimaryEvidencePortError(
    'PRIMARY_EVIDENCE_CONNECTION_GUARD_FAILED',
    'Primary evidence connection unexpectedly admitted a mutation'
  );
}

class SqlitePrimaryEvidenceReader implements PrimaryEvidenceReader {
  readonly #database: SQLite.Database;
  readonly #status: PrimaryEvidenceReaderStatus;
  #closed = false;

  constructor(database: SQLite.Database, status: PrimaryEvidenceReaderStatus) {
    this.#database = database;
    this.#status = status;
  }

  status(): PrimaryEvidenceReaderStatus {
    return this.#status;
  }

  resolveHold(input: unknown): Promise<ResolvedVerificationSubjectV1> {
    return Promise.resolve()
      .then(() => {
        this.assertOpen();
        const request = SettlementVerificationRequestV1Schema.parse(input);
        const row = this.#database
          .prepare(
            `SELECT
           tenant_id AS tenantId,
           task_id AS taskId,
           leased_version AS leasedVersion,
           queue_attempt AS queueAttempt,
           lease_owner AS leaseOwner,
           run_id AS runId,
           automation_id AS automationId,
           execution_request_id AS executionRequestId,
           occurrence_id AS occurrenceId,
           candidate_id AS candidateId,
           artifact_claim_id AS artifactClaimId,
           artifact_scope_key AS artifactScopeKey,
           source_claim_id AS sourceClaimId,
           captured_posture_version AS capturedPostureVersion,
           verifier_id AS verifierId,
           verifier_revision AS verifierRevision,
           criteria_sha256 AS criteriaSha256
         FROM work_queue_verification_holds
         WHERE hold_id = ? AND resolved_at IS NULL
           LIMIT 1`
          )
          .get(request.holdId);
        if (row === undefined) {
          throw new PrimaryEvidencePortError(
            'PRIMARY_EVIDENCE_NOT_FOUND',
            'Verification hold was not found or is resolved'
          );
        }
        const subject = ResolvedVerificationSubjectV1Schema.parse(row);
        const expectedHoldId = createVerificationHoldId({
          tenantId: subject.tenantId,
          queueTaskId: subject.taskId,
          leasedVersion: subject.leasedVersion,
          queueAttempt: subject.queueAttempt,
          runId: subject.runId
        });
        if (request.holdId !== expectedHoldId) {
          throw new PrimaryEvidencePortError(
            'PRIMARY_EVIDENCE_INTEGRITY_CONFLICT',
            'Verification hold identity does not match its immutable bindings'
          );
        }
        return subject;
      })
      .catch((error: unknown) => {
        throw normalizePortError(error);
      });
  }

  readCandidate(candidateId: string): Promise<BoundedCandidateResult> {
    return Promise.resolve()
      .then(() => {
        this.assertOpen();
        const id = VerificationOpaqueIdSchema.parse(candidateId);
        const row = this.#database
          .prepare(
            `SELECT
           candidate.tenant_id AS tenantId,
           candidate.automation_id AS automationId,
           candidate.execution_request_id AS executionRequestId,
           candidate.task_id AS taskId,
           candidate.run_id AS runId,
           candidate.artifact_scope_key AS artifactScopeKey,
           candidate.canonical_result_json AS canonicalResultJson,
           candidate.result_sha256 AS resultSha256,
           candidate.artifact_sha256 AS artifactSha256,
           candidate.journal_claim_sha256 AS journalClaimSha256,
           candidate.source_claim_id AS sourceClaimId,
           candidate.source_sha256 AS sourceSha256,
           candidate.artifact_claim_id AS artifactClaimId,
           source.artifact_claim_id AS sourceArtifactClaimId,
           source.source_registration_id AS sourceRegistrationId
         FROM run_completion_candidates AS candidate
         JOIN source_snapshot_claims AS source
           ON source.source_claim_id = candidate.source_claim_id
          AND source.source_sha256 = candidate.source_sha256
         WHERE candidate.candidate_id = ?
           AND length(CAST(candidate.canonical_result_json AS BLOB)) <= ?
         LIMIT 1`
          )
          .get(id, MAX_CANDIDATE_RESULT_BYTES) as CandidateEvidenceRow | undefined;
        if (row === undefined) {
          const candidateExists = this.#database
            .prepare(`SELECT 1 FROM run_completion_candidates WHERE candidate_id = ? LIMIT 1`)
            .get(id);
          if (candidateExists !== undefined) {
            throw new PrimaryEvidencePortError(
              'PRIMARY_EVIDENCE_INTEGRITY_CONFLICT',
              'Completion candidate failed bounded source-evidence integrity checks'
            );
          }
          throw new PrimaryEvidencePortError(
            'PRIMARY_EVIDENCE_NOT_FOUND',
            'Completion candidate was not found'
          );
        }
        const expectedSourceClaimId = createSourceClaimId({
          artifactClaimId: row.sourceArtifactClaimId,
          sourceRegistrationId: row.sourceRegistrationId
        });
        const expectedTaskId = createQueueTaskId({
          executionRequestId: row.executionRequestId,
          tenantId: row.tenantId,
          automationId: row.automationId
        });
        const expectedRunId = createRunId({
          executionRequestId: row.executionRequestId,
          queueTaskId: expectedTaskId
        });
        const expectedArtifactClaimId = createArtifactClaimId({
          artifactScopeKey: row.artifactScopeKey,
          executionRequestId: row.executionRequestId,
          runId: expectedRunId
        });
        if (
          row.taskId !== expectedTaskId ||
          row.runId !== expectedRunId ||
          row.artifactClaimId !== expectedArtifactClaimId ||
          row.artifactClaimId !== row.sourceArtifactClaimId ||
          row.sourceClaimId !== expectedSourceClaimId
        ) {
          throw new PrimaryEvidencePortError(
            'PRIMARY_EVIDENCE_INTEGRITY_CONFLICT',
            'Completion candidate source identity does not match its immutable bindings'
          );
        }
        return BoundedCandidateResultSchema.parse({
          schemaVersion: 1,
          canonicalResultJson: row.canonicalResultJson,
          resultSha256: row.resultSha256,
          artifactSha256: row.artifactSha256,
          journalClaimSha256: row.journalClaimSha256,
          sourceClaimId: row.sourceClaimId,
          sourceSha256: row.sourceSha256
        });
      })
      .catch((error: unknown) => {
        throw normalizePortError(error);
      });
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    this.#database.close();
    return Promise.resolve();
  }

  private assertOpen(): void {
    if (this.#closed) {
      throw new PrimaryEvidencePortError(
        'PRIMARY_EVIDENCE_READER_CLOSED',
        'Primary evidence reader is closed'
      );
    }
  }
}

export function openPrimaryEvidenceReader(input: { filename: string }): PrimaryEvidenceReader {
  const descriptor =
    input !== null && typeof input === 'object'
      ? Object.getOwnPropertyDescriptor(input, 'filename')
      : undefined;
  if (
    input === null ||
    typeof input !== 'object' ||
    Reflect.getPrototypeOf(input) !== Object.prototype ||
    Reflect.ownKeys(input).length !== 1 ||
    descriptor === undefined ||
    !descriptor.enumerable ||
    !('value' in descriptor) ||
    typeof input.filename !== 'string' ||
    input.filename.length === 0 ||
    input.filename === ':memory:' ||
    input.filename.includes('\0')
  ) {
    throw new TypeError(
      'Primary evidence reader input must contain only an existing database filename'
    );
  }

  const database = new SQLite(input.filename, {
    readonly: true,
    fileMustExist: true,
    timeout: PRIMARY_EVIDENCE_BUSY_TIMEOUT_MS
  });
  try {
    database.pragma('foreign_keys = ON');
    database.pragma('query_only = ON');
    database.pragma(`busy_timeout = ${PRIMARY_EVIDENCE_BUSY_TIMEOUT_MS}`);
    database.pragma('trusted_schema = OFF');

    const journalMode = database.pragma('journal_mode', { simple: true });
    if (journalMode !== 'wal') {
      throw new PrimaryEvidencePortError(
        'PRIMARY_EVIDENCE_NOT_WAL',
        'Primary evidence database must already use WAL journal mode'
      );
    }
    let schema: PrimarySchemaRow | undefined;
    try {
      schema = database
        .prepare(
          `SELECT schema_version AS schemaVersion,
                  (SELECT COUNT(*) FROM jarvis_primary_schema) AS rowCount
           FROM jarvis_primary_schema
           WHERE singleton_id = 'primary'
           LIMIT 1`
        )
        .get() as PrimarySchemaRow | undefined;
    } catch (error) {
      const normalized = normalizePortError(error);
      if (normalized instanceof PrimaryEvidencePortError) throw normalized;
      throw schemaMismatch('Primary evidence schema version marker is missing or malformed');
    }
    if (schema?.schemaVersion !== SUPPORTED_PRIMARY_SCHEMA_VERSION || schema.rowCount !== 1) {
      throw schemaMismatch(
        `Primary evidence schema version must be exactly ${SUPPORTED_PRIMARY_SCHEMA_VERSION}`
      );
    }
    assertSchemaManifest(database);
    if (
      database.readonly !== true ||
      integerPragma(database, 'query_only') !== 1 ||
      integerPragma(database, 'foreign_keys') !== 1 ||
      integerPragma(database, 'busy_timeout') !== PRIMARY_EVIDENCE_BUSY_TIMEOUT_MS
    ) {
      throw new PrimaryEvidencePortError(
        'PRIMARY_EVIDENCE_CONNECTION_GUARD_FAILED',
        'Primary evidence connection guards did not activate exactly'
      );
    }
    assertMutationRejected(database);

    return new SqlitePrimaryEvidenceReader(
      database,
      Object.freeze({
        readonly: true,
        queryOnly: true,
        foreignKeys: true,
        journalMode: 'wal',
        schemaVersion: SUPPORTED_PRIMARY_SCHEMA_VERSION,
        busyTimeoutMs: PRIMARY_EVIDENCE_BUSY_TIMEOUT_MS
      })
    );
  } catch (error) {
    database.close();
    throw normalizePortError(error);
  }
}
