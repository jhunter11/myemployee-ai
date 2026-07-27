import type SQLite from 'better-sqlite3';

import { AppError } from '../../utils/errors';
import { verifyRevisionIntegrity } from './canonical';
import {
  commandBaseRevisionId,
  commandHash,
  commandMemoryId,
  LedgerCommandEnvelopeSchema,
  LedgerCommandSchema,
  MEMORY_COMMAND_SCHEMA_VERSION,
  type LedgerCommand
} from './commands';
import { isLiveClaim, isRetrievable } from './lifecycle';
import {
  createLedgerState,
  isAcceptingOutcome,
  reduceCommand,
  type LedgerAuditEvent,
  type LedgerEvent,
  type LedgerState,
  type ProvenanceEdge
} from './reducer';
import { MemoryRevisionSchema, type MemoryRevision } from './record-contracts';

/**
 * better-sqlite3 persistence for the ledger.
 *
 * The concurrency rule is the report's: SINGLE LOGICAL WRITER PER SLEEVE, MANY
 * CONCURRENT PROPOSERS. Any caller may submit at any time; `submit` serializes
 * inside one transaction that reads the sleeve's high-water mark, hands out the
 * next `sleeve_seq`, reduces, and writes. That is a deliberate bottleneck at the
 * sleeve boundary rather than a global one, and it is what removes within-sleeve
 * race ambiguity without serializing the whole deployment.
 *
 * The repository stores state; it decides nothing. Every acceptance, refusal, and
 * projection column comes from the pure reducer, so `replay` can rebuild the same
 * projection from the log alone and be diffed against what is stored.
 */

/** Raised when a command's base revision is no longer the thread's head. */
export class LedgerStaleBaseError extends AppError {
  constructor(
    readonly commandId: string,
    readonly detail: string
  ) {
    super(409, 'MEMORY_LEDGER_STALE_BASE', detail);
  }
}

/**
 * Raised when the reducer refused a command for any other reason. The audit row is
 * ALREADY committed when this throws: the refusal is a durable fact about the log,
 * not a lost message, so it is written first and raised second.
 */
export class LedgerCommandRejectedError extends AppError {
  constructor(
    readonly commandId: string,
    readonly outcome: string,
    detail: string
  ) {
    super(409, 'MEMORY_LEDGER_COMMAND_REJECTED', detail, { outcome });
  }
}

/** Raised when the sleeve a command names is not a live registered sleeve. */
export class LedgerSleeveBindingError extends AppError {
  constructor(sleeveId: string) {
    super(
      409,
      'MEMORY_LEDGER_SLEEVE_INVALID',
      `Ledger writes require an active registered sleeve binding for '${sleeveId}'`
    );
  }
}

export interface LedgerSubmitResult {
  readonly audit: LedgerAuditEvent;
  readonly event: LedgerEvent | null;
  readonly revisions: readonly MemoryRevision[];
  /** True when this exact idempotency key had already been consumed. */
  readonly duplicate: boolean;
}

export interface LedgerReplayResult {
  readonly state: LedgerState;
  readonly audits: readonly LedgerAuditEvent[];
  readonly events: readonly LedgerEvent[];
}

interface RevisionRow {
  revision_id: string;
  schema_version: string;
  record_type: string;
  memory_id: string;
  revision_no: number;
  owner_scope_id: string;
  sleeve_id: string;
  sleeve_class: string;
  memory_kind: string;
  entity_key: string | null;
  status: string;
  approval_state: string;
  authority_tier: string;
  confidence_permille: number;
  sensitivity: string;
  retention_policy: string;
  legal_hold: number;
  event_time: string | null;
  observed_at: string;
  created_tx_time: string;
  recorded_tx_seq: number;
  valid_from: string;
  valid_until: string | null;
  decided_at: string | null;
  author_agent_id: string;
  workflow_id: string | null;
  run_id: string | null;
  derivation_method: string;
  source_event_ids_json: string;
  evidence_refs_json: string;
  derived_from_json: string;
  contradicts_json: string;
  supersedes: string | null;
  superseded_by: string | null;
  payload_json: string;
  content_hash: string;
  canonical_hash: string;
  tombstone_json: string | null;
  is_current_active: number;
  command_id: string;
}

interface AuditRow {
  audit_id: string;
  command_id: string;
  sleeve_id: string;
  owner_scope_id: string;
  sleeve_seq: number;
  op: string;
  outcome: string;
  state_changed: number;
  memory_id: string | null;
  revision_ids_json: string;
  reason: string;
  recorded_at: string;
  fingerprint: string;
}

interface EdgeRow {
  edge_id: string;
  sleeve_id: string;
  owner_scope_id: string;
  edge_type: string;
  from_id: string;
  to_id: string;
  command_id: string;
  recorded_at: string;
}

function toRevision(row: RevisionRow): MemoryRevision {
  const revision = MemoryRevisionSchema.parse({
    schemaVersion: row.schema_version,
    recordType: row.record_type,
    memoryId: row.memory_id,
    revisionId: row.revision_id,
    revisionNo: row.revision_no,
    ownerScopeId: row.owner_scope_id,
    sleeveId: row.sleeve_id,
    sleeveClass: row.sleeve_class,
    kind: row.memory_kind,
    entityKey: row.entity_key,
    status: row.status,
    approvalState: row.approval_state,
    authorityTier: row.authority_tier,
    confidencePermille: row.confidence_permille,
    sensitivity: row.sensitivity,
    retentionPolicy: row.retention_policy,
    legalHold: row.legal_hold === 1,
    eventTime: row.event_time,
    observedAt: row.observed_at,
    createdTxTime: row.created_tx_time,
    recordedTxSeq: row.recorded_tx_seq,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    decidedAt: row.decided_at,
    authorAgentId: row.author_agent_id,
    workflowId: row.workflow_id,
    runId: row.run_id,
    derivationMethod: row.derivation_method,
    sourceEventIds: JSON.parse(row.source_event_ids_json) as unknown,
    evidenceRefs: JSON.parse(row.evidence_refs_json) as unknown,
    derivedFrom: JSON.parse(row.derived_from_json) as unknown,
    contradicts: JSON.parse(row.contradicts_json) as unknown,
    supersedes: row.supersedes,
    supersededBy: row.superseded_by,
    payloadCanonical: JSON.parse(row.payload_json) as unknown,
    contentHash: row.content_hash,
    canonicalHash: row.canonical_hash,
    tombstone: row.tombstone_json === null ? null : (JSON.parse(row.tombstone_json) as unknown)
  });
  // Fail-closed integrity gate. A revision whose digests do not recompute is not a
  // revision the reducer may act on, whatever the row says.
  verifyRevisionIntegrity(revision);
  return revision;
}

function toAudit(row: AuditRow): LedgerAuditEvent {
  return {
    auditId: row.audit_id,
    commandId: row.command_id,
    sleeveId: row.sleeve_id,
    ownerScopeId: row.owner_scope_id,
    sleeveSeq: row.sleeve_seq,
    op: LedgerCommandEnvelopeSchema.shape.op.parse(row.op),
    outcome: row.outcome as LedgerAuditEvent['outcome'],
    stateChanged: row.state_changed === 1,
    memoryId: row.memory_id,
    revisionIds: JSON.parse(row.revision_ids_json) as string[],
    reason: row.reason,
    recordedAt: row.recorded_at,
    fingerprint: row.fingerprint
  };
}

/** A revision is CURRENT-ACTIVE when nothing has closed it and it is still a live claim. */
function isCurrentActive(revision: MemoryRevision): boolean {
  return revision.supersededBy === null && isLiveClaim(revision.status);
}

export class LedgerRepository {
  constructor(private readonly sqlite: SQLite.Database) {}

  // --- Reads ----------------------------------------------------------------

  private sleeveBinding(
    sleeveId: string,
    ownerScopeId: string
  ): { maxSensitivity: MemoryRevision['sensitivity'] } {
    const row = this.sqlite
      .prepare(
        `SELECT max_sensitivity FROM memory_sleeves
         WHERE sleeve_id = ? AND owner_scope_id = ? AND state = 'active'`
      )
      .get(sleeveId, ownerScopeId) as
      { max_sensitivity: MemoryRevision['sensitivity'] } | undefined;
    if (row === undefined) throw new LedgerSleeveBindingError(sleeveId);
    return { maxSensitivity: row.max_sensitivity };
  }

  private revisionsForSleeve(sleeveId: string): MemoryRevision[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM memory_revisions
         WHERE sleeve_id = ?
         ORDER BY recorded_tx_seq ASC, revision_no ASC, revision_id ASC`
      )
      .all(sleeveId) as RevisionRow[];
    return rows.map(toRevision);
  }

  private edgesForSleeve(sleeveId: string): ProvenanceEdge[] {
    const rows = this.sqlite
      .prepare(`SELECT * FROM memory_provenance_edges WHERE sleeve_id = ? ORDER BY rowid ASC`)
      .all(sleeveId) as EdgeRow[];
    return rows.map((row) => ({
      edgeId: row.edge_id,
      sleeveId: row.sleeve_id,
      ownerScopeId: row.owner_scope_id,
      edgeType: row.edge_type as ProvenanceEdge['edgeType'],
      fromId: row.from_id,
      toId: row.to_id,
      commandId: row.command_id,
      recordedAt: row.recorded_at
    }));
  }

  /**
   * The cross-sleeve window a command needs, resolved by explicit id only.
   *
   * This is the ONLY place the ledger reads outside a sleeve, and it reads exactly
   * the revisions the command named — never a scan, never a join. A PROMOTE that
   * names nothing gets nothing, and fails closed in the reducer.
   */
  private foreignRevisionsFor(command: LedgerCommand): MemoryRevision[] {
    const wanted =
      command.op === 'PROMOTE'
        ? [...command.memberRevisionIds]
        : command.op === 'IMPORT'
          ? [command.bundleRevisionId]
          : [];
    if (wanted.length === 0) return [];
    const placeholders = wanted.map(() => '?').join(', ');
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM memory_revisions
         WHERE revision_id IN (${placeholders}) AND sleeve_id <> ?
         ORDER BY revision_id ASC`
      )
      .all(...wanted, command.sleeveId) as RevisionRow[];
    return rows.map(toRevision);
  }

  /**
   * Threads logically deleted but not yet purged, in stable id order. One source of
   * truth for both `loadState` and any caller that needs to see the outstanding
   * erasure obligation.
   */
  private pendingDeletionsForSleeve(sleeveId: string): string[] {
    return [
      ...new Set(
        this.revisionsForSleeve(sleeveId)
          .filter(
            (revision) =>
              revision.supersededBy === null &&
              (revision.status === 'deleted_logical' || revision.status === 'purge_scheduled')
          )
          .map((revision) => revision.memoryId)
      )
    ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  /** The outstanding deletion cascade for a sleeve — see {@link pendingDeletionsForSleeve}. */
  pendingDeletions(sleeveId: string): Promise<readonly string[]> {
    return Promise.resolve(this.pendingDeletionsForSleeve(sleeveId));
  }

  private loadState(sleeveId: string, ownerScopeId: string, command: LedgerCommand | null) {
    const { maxSensitivity } = this.sleeveBinding(sleeveId, ownerScopeId);
    const highWater = this.sqlite
      .prepare(
        'SELECT COALESCE(MAX(sleeve_seq), 0) AS seq FROM memory_ledger_commands WHERE sleeve_id = ?'
      )
      .get(sleeveId) as { seq: number };
    const keys = this.sqlite
      .prepare(
        'SELECT idempotency_key FROM memory_ledger_commands WHERE sleeve_id = ? ORDER BY idempotency_key ASC'
      )
      .all(sleeveId) as { idempotency_key: string }[];
    const base = createLedgerState({ sleeveId, ownerScopeId, maxSensitivity });
    // The outstanding deletion cascade is DERIVED from the revisions rather than
    // stored as its own column, so it cannot drift from them. Leaving it at the
    // empty default that `createLedgerState` supplies would have silently emptied
    // the queue on every process restart: a thread deleted before the restart would
    // come back with nothing scheduled to erase it, and the erasure obligation would
    // be lost without a single failing read.
    const deletionQueue = this.pendingDeletionsForSleeve(sleeveId);

    return {
      ...base,
      nextSleeveSeq: highWater.seq + 1,
      idempotencyKeys: keys.map((row) => row.idempotency_key),
      revisions: this.revisionsForSleeve(sleeveId),
      edges: this.edgesForSleeve(sleeveId),
      deletionQueue,
      foreignRevisions: command === null ? [] : this.foreignRevisionsFor(command)
    } satisfies LedgerState;
  }

  // --- Writes ---------------------------------------------------------------

  private insertCommand(command: LedgerCommand, sleeveSeq: number, rawDocument: unknown): void {
    this.sqlite
      .prepare(
        `INSERT INTO memory_ledger_commands (
           command_id, schema_version, sleeve_id, owner_scope_id, sleeve_seq, idempotency_key,
           op, memory_id, base_revision_id, payload_json, authority_tier, approval_state,
           issued_by, issued_at, command_hash
         ) VALUES (
           @commandId, @schemaVersion, @sleeveId, @ownerScopeId, @sleeveSeq, @idempotencyKey,
           @op, @memoryId, @baseRevisionId, @payloadJson, @authorityTier, @approvalState,
           @issuedBy, @issuedAt, @commandHash
         )`
      )
      .run({
        commandId: command.commandId,
        schemaVersion: MEMORY_COMMAND_SCHEMA_VERSION,
        sleeveId: command.sleeveId,
        ownerScopeId: command.ownerScopeId,
        sleeveSeq,
        idempotencyKey: command.idempotencyKey,
        op: command.op,
        memoryId: commandMemoryId(command),
        baseRevisionId: commandBaseRevisionId(command),
        // The COMPLETE command document. The columns above are indexed projections
        // of it; replay reads this column, so an upcast lands in exactly one place.
        payloadJson: JSON.stringify(rawDocument),
        authorityTier: command.authorityTier,
        approvalState: command.approvalState,
        issuedBy: command.issuedBy,
        issuedAt: command.issuedAt,
        commandHash: commandHash(command)
      });
  }

  private insertAudit(audit: LedgerAuditEvent): void {
    this.sqlite
      .prepare(
        `INSERT INTO memory_ledger_audit (
           audit_id, command_id, sleeve_id, owner_scope_id, sleeve_seq, op, outcome,
           state_changed, memory_id, revision_ids_json, reason, recorded_at, fingerprint
         ) VALUES (
           @auditId, @commandId, @sleeveId, @ownerScopeId, @sleeveSeq, @op, @outcome,
           @stateChanged, @memoryId, @revisionIdsJson, @reason, @recordedAt, @fingerprint
         )`
      )
      .run({
        auditId: audit.auditId,
        commandId: audit.commandId,
        sleeveId: audit.sleeveId,
        ownerScopeId: audit.ownerScopeId,
        sleeveSeq: audit.sleeveSeq,
        op: audit.op,
        outcome: audit.outcome,
        stateChanged: audit.stateChanged ? 1 : 0,
        memoryId: audit.memoryId,
        revisionIdsJson: JSON.stringify(audit.revisionIds),
        reason: audit.reason,
        recordedAt: audit.recordedAt,
        fingerprint: audit.fingerprint
      });
  }

  private insertEvent(event: LedgerEvent): void {
    this.sqlite
      .prepare(
        `INSERT INTO memory_ledger_events (
           event_id, command_id, sleeve_id, owner_scope_id, sleeve_seq, event_type,
           memory_id, revision_ids_json, recorded_at, event_hash
         ) VALUES (
           @eventId, @commandId, @sleeveId, @ownerScopeId, @sleeveSeq, @eventType,
           @memoryId, @revisionIdsJson, @recordedAt, @eventHash
         )`
      )
      .run({
        eventId: event.eventId,
        commandId: event.commandId,
        sleeveId: event.sleeveId,
        ownerScopeId: event.ownerScopeId,
        sleeveSeq: event.sleeveSeq,
        eventType: event.eventType,
        memoryId: event.memoryId,
        revisionIdsJson: JSON.stringify(event.revisionIds),
        recordedAt: event.recordedAt,
        eventHash: event.eventHash
      });
  }

  private insertRevision(revision: MemoryRevision, commandId: string): void {
    this.sqlite
      .prepare(
        `INSERT INTO memory_revisions (
           revision_id, schema_version, record_type, memory_id, revision_no, owner_scope_id,
           sleeve_id, sleeve_class, memory_kind, entity_key, status, approval_state,
           authority_tier, confidence_permille, sensitivity, retention_policy, legal_hold,
           event_time, observed_at, created_tx_time, recorded_tx_seq, valid_from, valid_until,
           decided_at, author_agent_id, workflow_id, run_id, derivation_method,
           source_event_ids_json, evidence_refs_json, derived_from_json, contradicts_json,
           supersedes, superseded_by, payload_json, content_hash, canonical_hash,
           tombstone_json, is_current_active, command_id
         ) VALUES (
           @revisionId, @schemaVersion, @recordType, @memoryId, @revisionNo, @ownerScopeId,
           @sleeveId, @sleeveClass, @kind, @entityKey, @status, @approvalState,
           @authorityTier, @confidencePermille, @sensitivity, @retentionPolicy, @legalHold,
           @eventTime, @observedAt, @createdTxTime, @recordedTxSeq, @validFrom, @validUntil,
           @decidedAt, @authorAgentId, @workflowId, @runId, @derivationMethod,
           @sourceEventIdsJson, @evidenceRefsJson, @derivedFromJson, @contradictsJson,
           @supersedes, NULL, @payloadJson, @contentHash, @canonicalHash,
           @tombstoneJson, @isCurrentActive, @commandId
         )`
      )
      .run({
        revisionId: revision.revisionId,
        schemaVersion: revision.schemaVersion,
        recordType: revision.recordType,
        memoryId: revision.memoryId,
        revisionNo: revision.revisionNo,
        ownerScopeId: revision.ownerScopeId,
        sleeveId: revision.sleeveId,
        sleeveClass: revision.sleeveClass,
        kind: revision.kind,
        entityKey: revision.entityKey,
        status: revision.status,
        approvalState: revision.approvalState,
        authorityTier: revision.authorityTier,
        confidencePermille: revision.confidencePermille,
        sensitivity: revision.sensitivity,
        retentionPolicy: revision.retentionPolicy,
        legalHold: revision.legalHold ? 1 : 0,
        eventTime: revision.eventTime,
        observedAt: revision.observedAt,
        createdTxTime: revision.createdTxTime,
        recordedTxSeq: revision.recordedTxSeq,
        validFrom: revision.validFrom,
        validUntil: revision.validUntil,
        decidedAt: revision.decidedAt,
        authorAgentId: revision.authorAgentId,
        workflowId: revision.workflowId,
        runId: revision.runId,
        derivationMethod: revision.derivationMethod,
        sourceEventIdsJson: JSON.stringify(revision.sourceEventIds),
        evidenceRefsJson: JSON.stringify(revision.evidenceRefs),
        derivedFromJson: JSON.stringify(revision.derivedFrom),
        contradictsJson: JSON.stringify(revision.contradicts),
        supersedes: revision.supersedes,
        payloadJson: JSON.stringify(revision.payloadCanonical),
        contentHash: revision.contentHash,
        canonicalHash: revision.canonicalHash,
        tombstoneJson: revision.tombstone === null ? null : JSON.stringify(revision.tombstone),
        isCurrentActive: isCurrentActive(revision) ? 1 : 0,
        commandId
      });
  }

  /**
   * Submit one command.
   *
   * Everything happens in one transaction, and the transaction ALWAYS commits when
   * the reducer produced an audit: a refusal is a durable fact about the log, so it
   * is written and only then raised as a typed error. Rolling back a refusal would
   * lose the very record an operator needs to debug it.
   */
  submit(rawCommand: unknown): Promise<LedgerSubmitResult> {
    return Promise.resolve().then(() => this.submitValidated(rawCommand));
  }

  private submitValidated(rawCommand: unknown): LedgerSubmitResult {
    const envelope = LedgerCommandEnvelopeSchema.parse(rawCommand);
    const parsed = LedgerCommandSchema.safeParse(rawCommand);

    const write = this.sqlite.transaction((): LedgerSubmitResult => {
      const state = this.loadState(
        envelope.sleeveId,
        envelope.ownerScopeId,
        parsed.success ? parsed.data : null
      );

      // Idempotency, resolved against the durable log rather than memory: a
      // duplicate returns the ORIGINAL outcome so a retrying proposer sees the same
      // answer it saw the first time.
      const existing = this.sqlite
        .prepare(
          `SELECT a.* FROM memory_ledger_audit AS a
           JOIN memory_ledger_commands AS c ON c.command_id = a.command_id
           WHERE c.sleeve_id = ? AND c.idempotency_key = ?`
        )
        .get(envelope.sleeveId, envelope.idempotencyKey) as AuditRow | undefined;
      if (existing !== undefined) {
        const audit = toAudit(existing);
        return {
          audit,
          event: null,
          revisions: audit.revisionIds
            .map((revisionId) => this.revisionById(revisionId))
            .filter((revision): revision is MemoryRevision => revision !== null),
          duplicate: true
        };
      }

      const result = reduceCommand(state, rawCommand);
      const sleeveSeq = result.audit.sleeveSeq;

      // The command is logged first, whatever the verdict: the log records what was
      // ASKED, the audit records what was decided, and both survive a refusal.
      const loggable: LedgerCommand = parsed.success
        ? parsed.data
        : {
            ...envelope,
            schemaVersion: MEMORY_COMMAND_SCHEMA_VERSION,
            decidedAt: null,
            op: 'NOOP',
            reason: 'unparsable command retained for audit'
          };
      this.insertCommand(loggable, sleeveSeq, rawCommand);
      this.insertAudit(result.audit);

      if (result.event !== null) this.insertEvent(result.event);

      const written: MemoryRevision[] = [];
      if (isAcceptingOutcome(result.audit.outcome)) {
        const before = new Map(state.revisions.map((revision) => [revision.revisionId, revision]));
        // Three phases, and the order is forced by the storage invariants rather
        // than by preference:
        //   1. RELEASE the current-active flag on every revision this command
        //      closes. The unique partial index permits one current-active row per
        //      thread, so the successor cannot be inserted while the predecessor
        //      still holds the flag.
        //   2. INSERT the successors. A closure points at its successor, and both
        //      the foreign key and the guard trigger require it to already exist.
        //   3. LINK the closures and conflict flags.
        for (const revision of result.state.revisions) {
          const previous = before.get(revision.revisionId);
          if (previous === undefined) continue;
          if (previous.supersededBy === null && revision.supersededBy !== null) {
            this.sqlite
              .prepare('UPDATE memory_revisions SET is_current_active = 0 WHERE revision_id = ?')
              .run(revision.revisionId);
          }
        }
        for (const revision of result.state.revisions) {
          if (before.has(revision.revisionId)) continue;
          this.insertRevision(revision, loggable.commandId);
          written.push(revision);
        }
        for (const revision of result.state.revisions) {
          const previous = before.get(revision.revisionId);
          if (previous === undefined) continue;
          // Projection maintenance on an existing row: closure, conflict flags. The
          // storage guard trigger independently refuses anything else.
          if (
            previous.supersededBy !== revision.supersededBy ||
            previous.status !== revision.status ||
            previous.contradicts.length !== revision.contradicts.length
          ) {
            this.sqlite
              .prepare(
                `UPDATE memory_revisions
                 SET superseded_by = @supersededBy,
                     status = @status,
                     contradicts_json = @contradictsJson,
                     is_current_active = @isCurrentActive
                 WHERE revision_id = @revisionId`
              )
              .run({
                revisionId: revision.revisionId,
                supersededBy: revision.supersededBy,
                status: revision.status,
                contradictsJson: JSON.stringify(revision.contradicts),
                isCurrentActive: isCurrentActive(revision) ? 1 : 0
              });
          }
        }
        for (const edge of result.state.edges.slice(state.edges.length)) {
          this.sqlite
            .prepare(
              `INSERT OR IGNORE INTO memory_provenance_edges (
                 edge_id, sleeve_id, owner_scope_id, edge_type, from_id, to_id, command_id, recorded_at
               ) VALUES (@edgeId, @sleeveId, @ownerScopeId, @edgeType, @fromId, @toId, @commandId, @recordedAt)`
            )
            .run(edge);
        }
      }

      return { audit: result.audit, event: result.event, revisions: written, duplicate: false };
    });

    const result = write();
    if (result.duplicate) return result;
    if (result.audit.outcome === 'STALE_BASE') {
      throw new LedgerStaleBaseError(result.audit.commandId, result.audit.reason);
    }
    if (!isAcceptingOutcome(result.audit.outcome) && result.audit.outcome !== 'NOOP_EXPLICIT') {
      throw new LedgerCommandRejectedError(
        result.audit.commandId,
        result.audit.outcome,
        result.audit.reason
      );
    }
    return result;
  }

  // --- Queries --------------------------------------------------------------

  private revisionById(revisionId: string): MemoryRevision | null {
    const row = this.sqlite
      .prepare('SELECT * FROM memory_revisions WHERE revision_id = ?')
      .get(revisionId) as RevisionRow | undefined;
    return row === undefined ? null : toRevision(row);
  }

  /**
   * Rebuild a sleeve's projection from its command log alone.
   *
   * The result is deliberately NOT written back. Its purpose is verification: a
   * replay that disagrees with the stored projection is a bug worth surfacing, and
   * silently "repairing" the difference would hide it.
   */
  replay(sleeveId: string, ownerScopeId: string): Promise<LedgerReplayResult> {
    return Promise.resolve().then(() => {
      const { maxSensitivity } = this.sleeveBinding(sleeveId, ownerScopeId);
      const rows = this.sqlite
        .prepare(
          `SELECT payload_json FROM memory_ledger_commands
           WHERE sleeve_id = ? ORDER BY sleeve_seq ASC`
        )
        .all(sleeveId) as { payload_json: string }[];

      let state = createLedgerState({ sleeveId, ownerScopeId, maxSensitivity });
      const audits: LedgerAuditEvent[] = [];
      const events: LedgerEvent[] = [];
      for (const row of rows) {
        const document: unknown = JSON.parse(row.payload_json);
        const parsed = LedgerCommandSchema.safeParse(document);
        const foreign = parsed.success ? this.foreignRevisionsFor(parsed.data) : [];
        const result = reduceCommand({ ...state, foreignRevisions: foreign }, document);
        state = { ...result.state, foreignRevisions: [] };
        audits.push(result.audit);
        if (result.event !== null) events.push(result.event);
      }
      return { state, audits, events };
    });
  }

  /** The thread's head revision: the CAS target and the answer to "what does it say now". */
  currentRevision(sleeveId: string, memoryId: string): Promise<MemoryRevision | null> {
    return Promise.resolve().then(() => {
      const row = this.sqlite
        .prepare(
          `SELECT * FROM memory_revisions
           WHERE sleeve_id = ? AND memory_id = ?
           ORDER BY revision_no DESC LIMIT 1`
        )
        .get(sleeveId, memoryId) as RevisionRow | undefined;
      return row === undefined ? null : toRevision(row);
    });
  }

  /**
   * The head as DEFAULT RETRIEVAL sees it, which is narrower than "still a live
   * claim". `is_current_active = 1` admits both `active` and `active_conflicted`
   * (see the CHECK in migration 024), because the conflict engine must be able to
   * reason about a flagged record. Retrieval must not: while a contradiction is
   * unresolved, serving either side silently picks a winner the ledger never
   * decided. So this filters on {@link isRetrievable}, and a caller that genuinely
   * wants the flagged head has to ask for it through
   * {@link conflictedHeadRevision} and handle the contradiction explicitly.
   */
  currentActiveRevision(sleeveId: string, memoryId: string): Promise<MemoryRevision | null> {
    return Promise.resolve().then(() => {
      const row = this.sqlite
        .prepare(
          `SELECT * FROM memory_revisions
           WHERE sleeve_id = ? AND memory_id = ? AND is_current_active = 1`
        )
        .get(sleeveId, memoryId) as RevisionRow | undefined;
      if (row === undefined) return null;
      const revision = toRevision(row);
      return isRetrievable(revision.status) ? revision : null;
    });
  }

  /**
   * The head when it is flagged as contradicted — the explicit path
   * {@link currentActiveRevision} withholds. Returning it separately is what makes
   * "retrieval abstained" distinguishable from "the thread does not exist", which a
   * caller needs in order to escalate rather than to conclude nothing is known.
   */
  conflictedHeadRevision(sleeveId: string, memoryId: string): Promise<MemoryRevision | null> {
    return Promise.resolve().then(() => {
      const row = this.sqlite
        .prepare(
          `SELECT * FROM memory_revisions
           WHERE sleeve_id = ? AND memory_id = ? AND is_current_active = 1
             AND status = 'active_conflicted'`
        )
        .get(sleeveId, memoryId) as RevisionRow | undefined;
      return row === undefined ? null : toRevision(row);
    });
  }

  /**
   * BITEMPORAL time travel: what did this thread assert as true at `validTime`,
   * according to what the ledger knew at `txTime`?
   *
   * Keeping the axes separate is the whole point. Asking only "what was true then"
   * would silently use corrections the system had not yet received; asking only
   * "what did we know then" would return a fact whose validity window had not
   * opened. Only the pair answers the question an auditor actually asks.
   */
  asOf(
    sleeveId: string,
    memoryId: string,
    validTime: string,
    txTime: string
  ): Promise<MemoryRevision | null> {
    return Promise.resolve().then(() => {
      const row = this.sqlite
        .prepare(
          `SELECT * FROM memory_revisions
           WHERE sleeve_id = @sleeveId
             AND memory_id = @memoryId
             AND unixepoch(valid_from) <= unixepoch(@validTime)
             AND (valid_until IS NULL OR unixepoch(valid_until) > unixepoch(@validTime))
             AND unixepoch(created_tx_time) <= unixepoch(@txTime)
           ORDER BY recorded_tx_seq DESC, revision_no DESC
           LIMIT 1`
        )
        .get({ sleeveId, memoryId, validTime, txTime }) as RevisionRow | undefined;
      return row === undefined ? null : toRevision(row);
    });
  }

  /** Every audit row for a sleeve in log order — refusals included, by design. */
  auditTrail(sleeveId: string): Promise<LedgerAuditEvent[]> {
    return Promise.resolve().then(() => {
      const rows = this.sqlite
        .prepare('SELECT * FROM memory_ledger_audit WHERE sleeve_id = ? ORDER BY sleeve_seq ASC')
        .all(sleeveId) as AuditRow[];
      return rows.map(toAudit);
    });
  }

  /** The sleeve's provenance graph, for the invalidation planner. */
  provenanceEdges(sleeveId: string): Promise<ProvenanceEdge[]> {
    return Promise.resolve().then(() => this.edgesForSleeve(sleeveId));
  }

  /** Every revision in a sleeve, in log order. */
  revisions(sleeveId: string): Promise<MemoryRevision[]> {
    return Promise.resolve().then(() => this.revisionsForSleeve(sleeveId));
  }
}
