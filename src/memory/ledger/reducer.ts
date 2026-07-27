import { z } from 'zod';

import type { MemorySleeveKind } from '../../agents/access-control-contracts';
import { AppError } from '../../utils/errors';
import { sha256 } from '../system/hashing';
import {
  authorityRank,
  combineDenyOverrides,
  maySupersedeRevision,
  type PolicyEffect
} from './authority';
import { canonicalHash, canonicalize, contentHash } from './canonical';
import {
  commandMemoryId,
  deriveEdgeId,
  deriveEventId,
  deriveRevisionId,
  LedgerCommandEnvelopeSchema,
  LedgerCommandSchema,
  LEDGER_OPERATION_POLICIES,
  type LedgerCommand,
  type LedgerCommandEnvelope,
  type LedgerCommandOp,
  type LedgerRevisionDraft
} from './commands';
import { CONFLICT_OUTCOME_POLICIES, resolveConflict } from './conflict';
import {
  canReviewTransition,
  canTransition,
  isLiveClaim,
  type MemoryApprovalState,
  type MemoryLifecycleState
} from './lifecycle';
import {
  MemoryRevisionSchema,
  sleeveClassForSleeveId,
  type MemoryEvidenceRef,
  type MemoryPayloadCanonical,
  type MemoryRevision
} from './record-contracts';

/**
 * The deterministic reducer — the ONLY logical writer of canonical memory state.
 *
 * The report's argument is that authoritative memory is an authority problem
 * before it is a convergence problem, so the write path is a pure function over a
 * totally ordered per-sleeve command log rather than a set of commutative merge
 * laws. Everything the reducer needs is an explicit input: the sleeve's ordered
 * state, the command, and the command's own `issuedAt` as transaction time. It
 * never reads a clock, never draws a random number, and never consults storage.
 * That is what makes the two headline properties testable rather than aspirational:
 *
 *   * replaying the same ordered command list twice produces bit-identical
 *     projections and hashes;
 *   * duplicate delivery of any command yields the same final projection as
 *     exactly-once delivery.
 */

// --- Provenance graph -------------------------------------------------------

/**
 * W3C PROV-DM edge types. `used`, `generated`, and `associated_with` hang off an
 * ACTIVITY — here a single reducer execution, addressed by its command id — while
 * `derived_from`, `bundled_in`, and `invalidated_by` relate entities to entities.
 * Keeping the activity in the graph is what lets an operator ask "which command
 * produced this claim, from what, on whose authority" without joining the log.
 */
export const PROVENANCE_EDGE_TYPES = [
  'used',
  'generated',
  'derived_from',
  'associated_with',
  'bundled_in',
  'invalidated_by'
] as const;

export const ProvenanceEdgeTypeSchema = z.enum(PROVENANCE_EDGE_TYPES);
export type ProvenanceEdgeType = z.infer<typeof ProvenanceEdgeTypeSchema>;

export interface ProvenanceEdge {
  readonly edgeId: string;
  readonly sleeveId: string;
  readonly ownerScopeId: string;
  readonly edgeType: ProvenanceEdgeType;
  readonly fromId: string;
  readonly toId: string;
  readonly commandId: string;
  readonly recordedAt: string;
}

// --- Audit ------------------------------------------------------------------

/**
 * Every outcome the reducer can reach. The report is explicit that EVERY command
 * produces an audit event even when it fails or becomes a NOOP — a refusal that
 * leaves no trace is indistinguishable from a dropped message, and property-based
 * testing has nothing to assert against.
 */
export const LEDGER_AUDIT_OUTCOMES = [
  'OBSERVED',
  'PROPOSED',
  'APPLIED',
  'MERGED',
  'SPLIT',
  'PROMOTED',
  'IMPORTED',
  'NOOP_DUPLICATE',
  'NOOP_EXPLICIT',
  'DENIED',
  'STALE_BASE',
  'CONFLICT_REJECTED',
  'INVALID_COMMAND',
  'INVALID_REVISION',
  'PRECONDITION_FAILED',
  'LIFECYCLE_DENIED',
  'TEMPORAL_INVALID',
  'AUTHORITY_DENIED',
  'UPDATE_PAYLOAD_CHANGED'
] as const;

export const LedgerAuditOutcomeSchema = z.enum(LEDGER_AUDIT_OUTCOMES);
export type LedgerAuditOutcome = z.infer<typeof LedgerAuditOutcomeSchema>;

/** Outcomes that actually moved canonical state. Everything else is a recorded refusal. */
export const ACCEPTING_AUDIT_OUTCOMES: readonly LedgerAuditOutcome[] = [
  'OBSERVED',
  'PROPOSED',
  'APPLIED',
  'MERGED',
  'SPLIT',
  'PROMOTED',
  'IMPORTED'
];

export function isAcceptingOutcome(outcome: LedgerAuditOutcome): boolean {
  return ACCEPTING_AUDIT_OUTCOMES.includes(outcome);
}

export interface LedgerAuditEvent {
  readonly auditId: string;
  readonly commandId: string;
  readonly sleeveId: string;
  readonly ownerScopeId: string;
  readonly sleeveSeq: number;
  readonly op: LedgerCommandOp;
  readonly outcome: LedgerAuditOutcome;
  readonly stateChanged: boolean;
  readonly memoryId: string | null;
  readonly revisionIds: readonly string[];
  /** Structural facts only — ids, tiers, decision codes. Never payload content. */
  readonly reason: string;
  readonly recordedAt: string;
  readonly fingerprint: string;
}

export interface LedgerEvent {
  readonly eventId: string;
  readonly commandId: string;
  readonly sleeveId: string;
  readonly ownerScopeId: string;
  readonly sleeveSeq: number;
  readonly eventType: Extract<
    LedgerAuditOutcome,
    'OBSERVED' | 'PROPOSED' | 'APPLIED' | 'MERGED' | 'SPLIT' | 'PROMOTED' | 'IMPORTED'
  >;
  readonly memoryId: string | null;
  readonly revisionIds: readonly string[];
  readonly recordedAt: string;
  readonly eventHash: string;
}

// --- State ------------------------------------------------------------------

/**
 * One sleeve's reducer state. Arrays rather than maps: their iteration order IS
 * their content, so two states that compare equal serialize identically, which is
 * what a bit-identical replay assertion needs.
 *
 * `foreignRevisions` is the ONLY window onto another sleeve, and it is a
 * read-only, explicitly supplied input rather than an ambient capability. A
 * cross-sleeve read the caller did not hand in is simply absent, and the command
 * that needed it fails closed.
 */
export interface LedgerState {
  readonly sleeveId: string;
  readonly ownerScopeId: string;
  readonly sleeveClass: MemorySleeveKind;
  readonly maxSensitivity: MemoryRevision['sensitivity'];
  readonly nextSleeveSeq: number;
  readonly idempotencyKeys: readonly string[];
  readonly revisions: readonly MemoryRevision[];
  readonly edges: readonly ProvenanceEdge[];
  readonly foreignRevisions: readonly MemoryRevision[];
  /** Threads whose deletion cascade is outstanding, sorted and unique. */
  readonly deletionQueue: readonly string[];
}

export interface CreateLedgerStateOptions {
  readonly sleeveId: string;
  readonly ownerScopeId: string;
  readonly maxSensitivity: MemoryRevision['sensitivity'];
  readonly foreignRevisions?: readonly MemoryRevision[];
}

/** Raised when a sleeve id has no known root, so its policy ownership is undefined. */
export class LedgerSleeveRootError extends AppError {
  constructor(readonly sleeveId: string) {
    super(409, 'MEMORY_LEDGER_SLEEVE_ROOT_UNKNOWN', `Sleeve '${sleeveId}' has no known root`);
  }
}

/** Raised when a command cannot even be read well enough to audit it. */
export class LedgerCommandMalformedError extends AppError {
  constructor(message: string) {
    super(422, 'MEMORY_LEDGER_COMMAND_MALFORMED', message);
  }
}

export function createLedgerState(options: CreateLedgerStateOptions): LedgerState {
  const sleeveClass = sleeveClassForSleeveId(options.sleeveId);
  if (sleeveClass === null) throw new LedgerSleeveRootError(options.sleeveId);
  return {
    sleeveId: options.sleeveId,
    ownerScopeId: options.ownerScopeId,
    sleeveClass,
    maxSensitivity: options.maxSensitivity,
    nextSleeveSeq: 1,
    idempotencyKeys: [],
    revisions: [],
    edges: [],
    foreignRevisions: options.foreignRevisions ?? [],
    deletionQueue: []
  };
}

/** Rebind the read-only cross-sleeve window without touching accepted state. */
export function withForeignRevisions(
  state: LedgerState,
  foreignRevisions: readonly MemoryRevision[]
): LedgerState {
  return { ...state, foreignRevisions };
}

const SENSITIVITY_RANK: Readonly<Record<MemoryRevision['sensitivity'], number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  private: 3,
  restricted: 4
};

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

/** Every revision of one thread, oldest first. */
export function threadRevisions(state: LedgerState, memoryId: string): readonly MemoryRevision[] {
  return state.revisions
    .filter((revision) => revision.memoryId === memoryId)
    .sort((left, right) => left.revisionNo - right.revisionNo);
}

/**
 * The thread's head: the single revision no successor has closed. It is the CAS
 * target, and it is unique because closing a revision always sets `supersededBy`.
 */
export function threadHead(state: LedgerState, memoryId: string): MemoryRevision | null {
  const revisions = threadRevisions(state, memoryId);
  return revisions.length === 0 ? null : (revisions[revisions.length - 1] ?? null);
}

/** The head, but only when it is still a live claim — what default retrieval may see. */
export function currentActiveRevision(state: LedgerState, memoryId: string): MemoryRevision | null {
  const head = threadHead(state, memoryId);
  if (head === null) return null;
  return head.supersededBy === null && isLiveClaim(head.status) ? head : null;
}

function liveRevisions(state: LedgerState): readonly MemoryRevision[] {
  return state.revisions.filter(
    (revision) => revision.supersededBy === null && isLiveClaim(revision.status)
  );
}

function findRevision(
  revisions: readonly MemoryRevision[],
  revisionId: string
): MemoryRevision | null {
  return revisions.find((revision) => revision.revisionId === revisionId) ?? null;
}

// --- Application plan -------------------------------------------------------

interface RevisionClosure {
  readonly revisionId: string;
  readonly supersededBy: string;
}

interface ConflictFlag {
  readonly revisionId: string;
  readonly contradicts: readonly string[];
}

interface ApplicationPlan {
  readonly outcome: LedgerEvent['eventType'];
  readonly newRevisions: readonly MemoryRevision[];
  readonly closures: readonly RevisionClosure[];
  readonly conflictFlags: readonly ConflictFlag[];
  readonly edges: readonly ProvenanceEdge[];
  readonly deletionMemoryIds: readonly string[];
  readonly reason: string;
}

interface Rejection {
  readonly outcome: Exclude<LedgerAuditOutcome, LedgerEvent['eventType']>;
  readonly reason: string;
  readonly revisionIds?: readonly string[];
}

type OperationResult = ApplicationPlan | Rejection;

function isRejection(result: OperationResult): result is Rejection {
  return !('newRevisions' in result);
}

export interface ReduceResult {
  readonly state: LedgerState;
  readonly audit: LedgerAuditEvent;
  /** Present only for accepted commands; refusals produce an audit row and nothing else. */
  readonly event: LedgerEvent | null;
}

function auditFingerprint(fields: {
  commandId: string;
  sleeveId: string;
  sleeveSeq: number;
  op: LedgerCommandOp;
  outcome: LedgerAuditOutcome;
  memoryId: string | null;
  revisionIds: readonly string[];
  reason: string;
  stateChanged: boolean;
}): string {
  return `sha256:${sha256(canonicalize({ ...fields, revisionIds: [...fields.revisionIds] }))}`;
}

function buildAudit(
  state: LedgerState,
  envelope: LedgerCommandEnvelope,
  outcome: LedgerAuditOutcome,
  reason: string,
  memoryId: string | null,
  revisionIds: readonly string[]
): LedgerAuditEvent {
  const stateChanged = isAcceptingOutcome(outcome);
  const fields = {
    commandId: envelope.commandId,
    sleeveId: state.sleeveId,
    sleeveSeq: state.nextSleeveSeq,
    op: envelope.op,
    outcome,
    memoryId,
    revisionIds,
    reason,
    stateChanged
  };
  return {
    auditId: `aud_${sha256(canonicalize({ commandId: envelope.commandId, kind: 'audit' })).slice(0, 40)}`,
    commandId: envelope.commandId,
    sleeveId: state.sleeveId,
    ownerScopeId: state.ownerScopeId,
    sleeveSeq: state.nextSleeveSeq,
    op: envelope.op,
    outcome,
    stateChanged,
    memoryId,
    revisionIds,
    reason,
    recordedAt: envelope.issuedAt,
    fingerprint: auditFingerprint(fields)
  };
}

// --- Revision construction --------------------------------------------------

interface RevisionSeed {
  readonly memoryId: string;
  readonly revisionNo: number;
  readonly status: MemoryLifecycleState;
  readonly approvalState: MemoryApprovalState;
  readonly decidedAt: string | null;
  readonly kind: MemoryRevision['kind'];
  readonly entityKey: string | null;
  readonly payloadCanonical: MemoryPayloadCanonical;
  readonly eventTime: string | null;
  readonly observedAt: string;
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly derivationMethod: MemoryRevision['derivationMethod'];
  readonly confidencePermille: number;
  readonly sensitivity: MemoryRevision['sensitivity'];
  readonly retentionPolicy: MemoryRevision['retentionPolicy'];
  readonly legalHold: boolean;
  readonly workflowId: string | null;
  readonly runId: string | null;
  readonly sourceEventIds: readonly string[];
  readonly evidenceRefs: readonly MemoryEvidenceRef[];
  readonly derivedFrom: readonly string[];
  readonly contradicts: readonly string[];
  readonly supersedes: string | null;
  readonly tombstone: MemoryRevision['tombstone'];
}

/**
 * Assemble a revision from a seed. Identity, transaction time, and both digests
 * are DERIVED here and nowhere else — a proposer that could choose its own
 * revision id or transaction sequence could forge the order of history.
 */
function buildRevision(
  state: LedgerState,
  command: LedgerCommand,
  seed: RevisionSeed
): MemoryRevision {
  const revisionId = deriveRevisionId(command.commandId, seed.memoryId, seed.revisionNo);
  const base = {
    schemaVersion: 'memrec/v1',
    recordType: 'MemoryRevision',
    memoryId: seed.memoryId,
    revisionId,
    revisionNo: seed.revisionNo,
    ownerScopeId: state.ownerScopeId,
    sleeveId: state.sleeveId,
    sleeveClass: state.sleeveClass,
    kind: seed.kind,
    entityKey: seed.entityKey,
    status: seed.status,
    approvalState: seed.approvalState,
    authorityTier: command.authorityTier,
    confidencePermille: seed.confidencePermille,
    sensitivity: seed.sensitivity,
    retentionPolicy: seed.retentionPolicy,
    legalHold: seed.legalHold,
    eventTime: seed.eventTime,
    observedAt: seed.observedAt,
    createdTxTime: command.issuedAt,
    recordedTxSeq: state.nextSleeveSeq,
    validFrom: seed.validFrom,
    validUntil: seed.validUntil,
    decidedAt: seed.decidedAt,
    authorAgentId: command.issuedBy,
    workflowId: seed.workflowId,
    runId: seed.runId,
    derivationMethod: seed.derivationMethod,
    sourceEventIds: [...seed.sourceEventIds],
    evidenceRefs: [...seed.evidenceRefs],
    derivedFrom: [...seed.derivedFrom],
    contradicts: sortedUnique(seed.contradicts),
    supersedes: seed.supersedes,
    supersededBy: null,
    payloadCanonical: seed.payloadCanonical,
    contentHash: contentHash(seed.payloadCanonical),
    canonicalHash: `sha256:${'0'.repeat(64)}`,
    tombstone: seed.tombstone
  } as MemoryRevision;
  return { ...base, canonicalHash: canonicalHash(base) };
}

function seedFromDraft(
  draft: LedgerRevisionDraft,
  overrides: {
    memoryId: string;
    revisionNo: number;
    status: MemoryLifecycleState;
    approvalState: MemoryApprovalState;
    decidedAt: string | null;
    supersedes: string | null;
    contradicts?: readonly string[];
  }
): RevisionSeed {
  return {
    memoryId: overrides.memoryId,
    revisionNo: overrides.revisionNo,
    status: overrides.status,
    approvalState: overrides.approvalState,
    decidedAt: overrides.decidedAt,
    kind: draft.kind,
    entityKey: draft.entityKey,
    payloadCanonical: draft.payloadCanonical,
    eventTime: draft.eventTime,
    observedAt: draft.observedAt,
    validFrom: draft.validFrom,
    validUntil: draft.validUntil,
    derivationMethod: draft.derivationMethod,
    confidencePermille: draft.confidencePermille,
    sensitivity: draft.sensitivity,
    retentionPolicy: draft.retentionPolicy,
    legalHold: draft.legalHold,
    workflowId: draft.workflowId,
    runId: draft.runId,
    sourceEventIds: draft.sourceEventIds,
    evidenceRefs: draft.evidenceRefs,
    derivedFrom: draft.derivedFrom,
    contradicts: overrides.contradicts ?? [],
    supersedes: overrides.supersedes,
    tombstone: null
  };
}

function seedFromRevision(
  source: MemoryRevision,
  overrides: {
    revisionNo: number;
    status: MemoryLifecycleState;
    approvalState: MemoryApprovalState;
    decidedAt: string | null;
    supersedes: string | null;
    validUntil?: string | null;
    derivedFrom?: readonly string[];
    evidenceRefs?: readonly MemoryEvidenceRef[];
    payloadCanonical?: MemoryPayloadCanonical;
    confidencePermille?: number;
    sensitivity?: MemoryRevision['sensitivity'];
    retentionPolicy?: MemoryRevision['retentionPolicy'];
    legalHold?: boolean;
    tombstone?: MemoryRevision['tombstone'];
  }
): RevisionSeed {
  return {
    memoryId: source.memoryId,
    revisionNo: overrides.revisionNo,
    status: overrides.status,
    approvalState: overrides.approvalState,
    decidedAt: overrides.decidedAt,
    kind: source.kind,
    entityKey: source.entityKey,
    payloadCanonical: overrides.payloadCanonical ?? source.payloadCanonical,
    eventTime: source.eventTime,
    observedAt: source.observedAt,
    validFrom: source.validFrom,
    validUntil: overrides.validUntil === undefined ? source.validUntil : overrides.validUntil,
    derivationMethod: source.derivationMethod,
    confidencePermille: overrides.confidencePermille ?? source.confidencePermille,
    sensitivity: overrides.sensitivity ?? source.sensitivity,
    retentionPolicy: overrides.retentionPolicy ?? source.retentionPolicy,
    legalHold: overrides.legalHold ?? source.legalHold,
    workflowId: source.workflowId,
    runId: source.runId,
    sourceEventIds: source.sourceEventIds,
    evidenceRefs: overrides.evidenceRefs ?? source.evidenceRefs,
    derivedFrom: overrides.derivedFrom ?? source.derivedFrom,
    contradicts: [],
    supersedes: overrides.supersedes,
    tombstone: overrides.tombstone ?? null
  };
}

function parseRevision(candidate: MemoryRevision): MemoryRevision | Rejection {
  const parsed = MemoryRevisionSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue === undefined ? '' : issue.path.join('.');
  const message = issue === undefined ? 'schema rejected the candidate revision' : issue.message;
  return {
    outcome: 'INVALID_REVISION',
    reason: `Candidate revision '${candidate.revisionId}' is invalid at '${path}': ${message}`
  };
}

// --- Provenance edge construction -------------------------------------------

function edge(
  state: LedgerState,
  command: LedgerCommand,
  edgeType: ProvenanceEdgeType,
  fromId: string,
  toId: string
): ProvenanceEdge {
  return {
    edgeId: deriveEdgeId(state.sleeveId, fromId, toId, edgeType),
    sleeveId: state.sleeveId,
    ownerScopeId: state.ownerScopeId,
    edgeType,
    fromId,
    toId,
    commandId: command.commandId,
    recordedAt: command.issuedAt
  };
}

/**
 * The PROV footprint of one accepted revision: the activity generated it, the
 * activity was associated with its author, the activity used every evidence
 * reference and source event, and the entity is derived from every upstream
 * thread. Declaring dependencies explicitly is the precondition for Skyframe-style
 * invalidation — a dependency that was never declared can never be invalidated.
 */
function revisionEdges(
  state: LedgerState,
  command: LedgerCommand,
  revision: MemoryRevision
): ProvenanceEdge[] {
  const edges: ProvenanceEdge[] = [
    edge(state, command, 'generated', command.commandId, revision.revisionId),
    edge(state, command, 'associated_with', command.commandId, command.issuedBy)
  ];
  for (const reference of revision.evidenceRefs) {
    if (reference.id !== revision.revisionId) {
      edges.push(edge(state, command, 'used', command.commandId, reference.id));
      edges.push(edge(state, command, 'derived_from', revision.revisionId, reference.id));
    }
  }
  for (const sourceEventId of revision.sourceEventIds) {
    edges.push(edge(state, command, 'used', command.commandId, sourceEventId));
  }
  for (const upstream of revision.derivedFrom) {
    edges.push(edge(state, command, 'derived_from', revision.revisionId, upstream));
  }
  if (revision.supersedes !== null) {
    edges.push(edge(state, command, 'used', command.commandId, revision.supersedes));
  }
  return edges;
}

// --- Authorization ----------------------------------------------------------

interface AuthorizationRule {
  readonly effect: PolicyEffect;
  readonly reason: string;
}

function rule(denied: boolean, reason: string): AuthorizationRule {
  return { effect: denied ? 'deny' : 'not_applicable', reason };
}

function draftOf(command: LedgerCommand): LedgerRevisionDraft | null {
  return 'draft' in command ? command.draft : null;
}

/**
 * Deny-by-default authorization, combined with `deny overrides permit`.
 *
 * Only the authority-tier floor can contribute a `permit`; every other rule can
 * stay silent or deny. An empty or wholly silent rule set therefore combines to
 * `deny`, so "no rule matched" can never mean "allowed".
 */
function authorizeCommand(state: LedgerState, command: LedgerCommand): string | null {
  const policy = LEDGER_OPERATION_POLICIES[command.op];
  const tierPermitted =
    authorityRank(command.authorityTier) >= authorityRank(policy.minimumAuthorityTier);
  const draft = draftOf(command);
  const declaredSensitivity =
    draft?.sensitivity ??
    (command.op === 'PROMOTE' ? command.bundle.sensitivity : state.maxSensitivity);

  const rules: readonly AuthorizationRule[] = [
    {
      effect: tierPermitted ? 'permit' : 'deny',
      reason:
        `Operation '${command.op}' requires authority '${policy.minimumAuthorityTier}' ` +
        `or higher; command carries '${command.authorityTier}'`
    },
    rule(
      policy.requiredApprovalStates !== null &&
        !policy.requiredApprovalStates.includes(command.approvalState),
      `Operation '${command.op}' requires approval state in ` +
        `[${(policy.requiredApprovalStates ?? []).join(', ')}]; command carries '${command.approvalState}'`
    ),
    // A rejected review may not drive canonical state at all. NOOP is exempt
    // because recording that nothing happened is always legal.
    rule(
      command.approvalState === 'rejected' && command.op !== 'NOOP',
      `A rejected command may not change canonical state`
    ),
    rule(
      SENSITIVITY_RANK[declaredSensitivity] > SENSITIVITY_RANK[state.maxSensitivity],
      `Declared sensitivity '${declaredSensitivity}' exceeds the sleeve cap ` +
        `'${state.maxSensitivity}'`
    ),
    // The one op that materializes another sleeve's content locally, and the one
    // that publishes into a shared sleeve, are both bound to a sleeve CLASS. A
    // bundle published anywhere but a shared root would be a cross-sleeve write
    // wearing a promotion's clothes.
    rule(
      command.op === 'PROMOTE' && state.sleeveClass !== 'shared_approved',
      `PROMOTE may only publish into a shared_approved sleeve; this sleeve is '${state.sleeveClass}'`
    ),
    rule(
      command.op === 'IMPORT' && state.sleeveClass === 'shared_approved',
      'IMPORT may not target a shared_approved sleeve; bundles are published there, not imported'
    )
  ];

  if (combineDenyOverrides(rules.map((entry) => entry.effect)) === 'permit') return null;
  const denial = rules.find((entry) => entry.effect === 'deny');
  return denial?.reason ?? rules[0]?.reason ?? 'Denied by default';
}

export const OP_ASSERTED_TRANSITIONS: Readonly<
  Record<LedgerCommandOp, MemoryLifecycleState | null>
> = {
  OBSERVE: null,
  PROPOSE: 'proposed',
  ADD: 'active',
  // A metadata-only revision is explicitly a NON-transition, so the lifecycle table
  // is not consulted: consulting it would forbid re-approving an active claim.
  UPDATE: null,
  // SUPERSEDE, REVALIDATE, MERGE, and SPLIT leave the thread live (or return it to
  // live). What moves is the BASE, which is closed — and `active -> active` is
  // deliberately absent from the transition table, so the base's closure is the
  // move that must be legal.
  SUPERSEDE: 'superseded',
  RETRACT: 'retracted',
  DELETE: 'deleted_logical',
  MERGE: 'superseded',
  SPLIT: 'superseded',
  PROMOTE: null,
  IMPORT: null,
  EXPIRE: 'expired',
  REVALIDATE: 'superseded',
  NOOP: null
};

/**
 * The status a closed revision takes. `superseded` when the lifecycle table allows
 * it, otherwise the revision keeps the status it recorded: a proposal that an ADD
 * promoted was never "superseded", it was accepted, and rewriting its status would
 * falsify the historical record.
 */
function closureStatus(previous: MemoryLifecycleState): MemoryLifecycleState {
  return canTransition(previous, 'superseded') ? 'superseded' : previous;
}

export { closureStatus as ledgerClosureStatus };

function isRejection2(value: MemoryRevision | Rejection): value is Rejection {
  return 'outcome' in value;
}

/**
 * Compare-and-swap on the thread head. "Retry by reread, never by blind
 * overwrite": a command whose base is no longer current is rejected outright, and
 * the caller must re-read the projection and submit a NEW command.
 */
function resolveBaseRevision(
  state: LedgerState,
  memoryId: string,
  baseRevisionId: string
): MemoryRevision | Rejection {
  const head = threadHead(state, memoryId);
  if (head === null) {
    return {
      outcome: 'STALE_BASE',
      reason: `Thread '${memoryId}' has no revisions, so base '${baseRevisionId}' is stale`
    };
  }
  if (head.revisionId !== baseRevisionId) {
    return {
      outcome: 'STALE_BASE',
      reason:
        `Base '${baseRevisionId}' is not the current head '${head.revisionId}' ` +
        `of thread '${memoryId}'`
    };
  }
  return head;
}

function checkTransition(op: LedgerCommandOp, base: MemoryRevision): Rejection | null {
  const target = OP_ASSERTED_TRANSITIONS[op];
  if (target === null) return null;
  if (canTransition(base.status, target)) return null;
  return {
    outcome: 'LIFECYCLE_DENIED',
    reason: `Illegal memory lifecycle transition '${base.status}' -> '${target}' for ${op}`
  };
}

/**
 * "Ensure evidence exists and is readable." A reference to a revision this sleeve
 * cannot see is not weak evidence, it is NO evidence: resolving it would require a
 * cross-sleeve read the command was never authorized for.
 */
function unreadableEvidence(state: LedgerState, draft: LedgerRevisionDraft): string | null {
  for (const reference of draft.evidenceRefs) {
    if (reference.type !== 'memory_revision' && reference.type !== 'episode_revision') continue;
    if (findRevision(state.revisions, reference.id) === null) return reference.id;
  }
  return null;
}

interface ConflictVerdict {
  readonly status: MemoryLifecycleState;
  readonly contradicts: readonly string[];
  readonly flags: readonly ConflictFlag[];
  readonly reason: string;
}

function isConflictRejection(value: ConflictVerdict | Rejection): value is Rejection {
  return 'outcome' in value;
}

/**
 * Stage-one/stage-two conflict handling, wired into the write path.
 *
 * The existing set is prefiltered to LIVE revisions sharing the candidate's entity
 * key: `compareClaims` would have returned `different_entity_key` for the rest, so
 * the prefilter changes no verdict while keeping the comparison bounded.
 *
 * When the resolution flags a conflict the candidate becomes `active_conflicted`
 * AND every competing revision is flagged back, because the report requires the
 * conflict graph to be symmetric — a one-sided flag would let retrieval answer
 * confidently from the unflagged side.
 */
function evaluateConflict(
  state: LedgerState,
  candidate: MemoryRevision,
  requirePreserveBoth: boolean
): ConflictVerdict | Rejection {
  const existing = liveRevisions(state).filter(
    (revision) =>
      revision.memoryId !== candidate.memoryId && revision.entityKey === candidate.entityKey
  );
  if (existing.length > 256) {
    return {
      outcome: 'PRECONDITION_FAILED',
      reason: `Conflict set for entity key '${String(candidate.entityKey)}' exceeds 256 live claims`
    };
  }
  const resolution = resolveConflict(candidate, existing);
  if (requirePreserveBoth && resolution.outcome !== 'preserve_both') {
    return { outcome: 'CONFLICT_REJECTED', reason: resolution.reason };
  }
  if (resolution.outcome === 'select_one' && resolution.winnerRevisionId !== candidate.revisionId) {
    return { outcome: 'CONFLICT_REJECTED', reason: resolution.reason };
  }
  const policy = CONFLICT_OUTCOME_POLICIES[resolution.outcome];
  if (!policy.flagsConflict || resolution.conflictedRevisionIds.length === 0) {
    return { status: 'active', contradicts: [], flags: [], reason: resolution.reason };
  }
  return {
    status: 'active_conflicted',
    contradicts: resolution.conflictedRevisionIds,
    flags: resolution.conflictedRevisionIds.map((revisionId) => ({
      revisionId,
      contradicts: [candidate.revisionId]
    })),
    reason: resolution.reason
  };
}

/**
 * Re-stamp a candidate with the conflict verdict. Neither `status` nor
 * `contradicts` feeds `canonicalHash` — that is the whole reason the canonical
 * form excludes acceptance metadata — so the digest survives the re-stamp intact.
 */
function withConflictVerdict(
  candidate: MemoryRevision,
  verdict: ConflictVerdict
): MemoryRevision | Rejection {
  if (verdict.status === candidate.status && verdict.contradicts.length === 0) return candidate;
  return parseRevision({
    ...candidate,
    status: verdict.status,
    contradicts: sortedUnique(verdict.contradicts)
  });
}

// --- Per-operation handlers -------------------------------------------------

function threadIsFree(state: LedgerState, memoryId: string): Rejection | null {
  if (threadHead(state, memoryId) === null) return null;
  return {
    outcome: 'PRECONDITION_FAILED',
    reason: `Thread '${memoryId}' already exists; a thread is opened exactly once`
  };
}

function acceptSingle(
  state: LedgerState,
  command: LedgerCommand,
  outcome: LedgerEvent['eventType'],
  revision: MemoryRevision,
  extras: {
    closures?: readonly RevisionClosure[];
    conflictFlags?: readonly ConflictFlag[];
    edges?: readonly ProvenanceEdge[];
    deletionMemoryIds?: readonly string[];
    reason: string;
  }
): ApplicationPlan {
  return {
    outcome,
    newRevisions: [revision],
    closures: extras.closures ?? [],
    conflictFlags: extras.conflictFlags ?? [],
    edges: [...revisionEdges(state, command, revision), ...(extras.edges ?? [])],
    deletionMemoryIds: extras.deletionMemoryIds ?? [],
    reason: extras.reason
  };
}

function handleObserve(state: LedgerState, command: LedgerCommand): OperationResult {
  if (command.op !== 'OBSERVE') throw new Error('handleObserve received the wrong op');
  const free = threadIsFree(state, command.memoryId);
  if (free !== null) return free;
  const candidate = parseRevision(
    buildRevision(
      state,
      command,
      seedFromDraft(command.draft, {
        memoryId: command.memoryId,
        revisionNo: 1,
        status: 'observed_draft',
        approvalState: command.approvalState,
        decidedAt: command.decidedAt,
        supersedes: null
      })
    )
  );
  if (isRejection2(candidate)) return candidate;
  return acceptSingle(state, command, 'OBSERVED', candidate, {
    reason: `Opened thread '${command.memoryId}' with draft revision '${candidate.revisionId}'`
  });
}

function handlePropose(state: LedgerState, command: LedgerCommand): OperationResult {
  if (command.op !== 'PROPOSE') throw new Error('handlePropose received the wrong op');
  const missing = unreadableEvidence(state, command.draft);
  if (missing !== null) {
    return {
      outcome: 'PRECONDITION_FAILED',
      reason: `Evidence reference '${missing}' is not readable in sleeve '${state.sleeveId}'`
    };
  }
  let base: MemoryRevision | null = null;
  if (command.baseRevisionId !== null) {
    const resolved = resolveBaseRevision(state, command.memoryId, command.baseRevisionId);
    if (isRejection2(resolved)) return resolved;
    const transition = checkTransition('PROPOSE', resolved);
    if (transition !== null) return transition;
    base = resolved;
  } else {
    const free = threadIsFree(state, command.memoryId);
    if (free !== null) return free;
  }
  const candidate = parseRevision(
    buildRevision(
      state,
      command,
      seedFromDraft(command.draft, {
        memoryId: command.memoryId,
        revisionNo: base === null ? 1 : base.revisionNo + 1,
        status: 'proposed',
        approvalState: command.approvalState,
        decidedAt: command.decidedAt,
        supersedes: base?.revisionId ?? null
      })
    )
  );
  if (isRejection2(candidate)) return candidate;
  return acceptSingle(state, command, 'PROPOSED', candidate, {
    closures:
      base === null ? [] : [{ revisionId: base.revisionId, supersededBy: candidate.revisionId }],
    reason: `Proposed revision '${candidate.revisionId}' on thread '${command.memoryId}'`
  });
}

/**
 * ADD, SUPERSEDE, and REVALIDATE share a shape: CAS on the head, a fresh claim, an
 * authority-precedence gate, temporal invariants, then conflict resolution.
 */
function handleActivating(state: LedgerState, command: LedgerCommand): OperationResult {
  if (command.op !== 'ADD' && command.op !== 'SUPERSEDE' && command.op !== 'REVALIDATE') {
    throw new Error('handleActivating received the wrong op');
  }
  const resolved = resolveBaseRevision(state, command.memoryId, command.baseRevisionId);
  if (isRejection2(resolved)) return resolved;
  const base = resolved;

  const transition = checkTransition(command.op, base);
  if (transition !== null) return transition;

  const missing = unreadableEvidence(state, command.draft);
  if (missing !== null) {
    return {
      outcome: 'PRECONDITION_FAILED',
      reason: `Evidence reference '${missing}' is not readable in sleeve '${state.sleeveId}'`
    };
  }

  // "No lower-authority revision may supersede a higher-authority active revision
  // in the same context." ADD promotes a draft rather than displacing a live claim,
  // so the gate applies to the two ops that actually close a live base.
  if (command.op !== 'ADD') {
    const decision = maySupersedeRevision(
      {
        authorityTier: command.authorityTier,
        ownerScopeId: state.ownerScopeId,
        sleeveId: state.sleeveId,
        status: 'active',
        legalHold: command.draft.legalHold
      },
      base
    );
    if (!decision.allowed) {
      return { outcome: 'AUTHORITY_DENIED', reason: `${decision.code}: ${decision.reason}` };
    }
  }

  // A successor may not start before the claim it closes: an interval that opened
  // earlier than its predecessor would make the thread's bitemporal history
  // non-monotonic and `asOf` ambiguous.
  if (Date.parse(command.draft.validFrom) < Date.parse(base.validFrom)) {
    return {
      outcome: 'TEMPORAL_INVALID',
      reason:
        `Successor validFrom '${command.draft.validFrom}' precedes base validFrom ` +
        `'${base.validFrom}' on thread '${command.memoryId}'`
    };
  }

  const built = parseRevision(
    buildRevision(
      state,
      command,
      seedFromDraft(command.draft, {
        memoryId: command.memoryId,
        revisionNo: base.revisionNo + 1,
        status: 'active',
        approvalState: command.approvalState,
        decidedAt: command.decidedAt,
        supersedes: base.revisionId
      })
    )
  );
  if (isRejection2(built)) return built;

  const verdict = evaluateConflict(state, built, false);
  if (isConflictRejection(verdict)) return verdict;
  const candidate = withConflictVerdict(built, verdict);
  if (isRejection2(candidate)) return candidate;

  return acceptSingle(state, command, 'APPLIED', candidate, {
    closures: [{ revisionId: base.revisionId, supersededBy: candidate.revisionId }],
    conflictFlags: verdict.flags,
    reason: `${command.op} applied to thread '${command.memoryId}': ${verdict.reason}`
  });
}

function handleUpdate(state: LedgerState, command: LedgerCommand): OperationResult {
  if (command.op !== 'UPDATE') throw new Error('handleUpdate received the wrong op');
  const resolved = resolveBaseRevision(state, command.memoryId, command.baseRevisionId);
  if (isRejection2(resolved)) return resolved;
  const base = resolved;

  // PROTOCOL RULE 1. UPDATE exists only for administrative metadata — approval,
  // retention class, sensitivity, evidence corrections. A changed claim must go
  // through SUPERSEDE so replay stays intelligible, so a payload that does not
  // hash to the base's content hash is refused rather than quietly accepted.
  const submitted = contentHash(command.payloadCanonical);
  if (submitted !== base.contentHash) {
    return {
      outcome: 'UPDATE_PAYLOAD_CHANGED',
      reason:
        `UPDATE is metadata-only: payload hash '${submitted}' differs from base ` +
        `'${base.contentHash}'. Semantic changes must use SUPERSEDE.`
    };
  }
  if (
    command.approvalState !== base.approvalState &&
    !canReviewTransition(base.approvalState, command.approvalState)
  ) {
    return {
      outcome: 'LIFECYCLE_DENIED',
      reason: `Illegal review transition '${base.approvalState}' -> '${command.approvalState}' for UPDATE`
    };
  }

  const built = parseRevision(
    buildRevision(
      state,
      command,
      seedFromRevision(base, {
        revisionNo: base.revisionNo + 1,
        status: isLiveClaim(base.status) ? 'active' : base.status,
        approvalState: command.approvalState,
        decidedAt: command.decidedAt,
        supersedes: base.revisionId,
        evidenceRefs: command.metadata.evidenceRefs,
        confidencePermille: command.metadata.confidencePermille,
        sensitivity: command.metadata.sensitivity,
        retentionPolicy: command.metadata.retentionPolicy,
        legalHold: command.metadata.legalHold
      })
    )
  );
  if (isRejection2(built)) return built;

  if (!isLiveClaim(built.status)) {
    return acceptSingle(state, command, 'APPLIED', built, {
      closures: [{ revisionId: base.revisionId, supersededBy: built.revisionId }],
      reason: `Metadata updated on non-live thread '${command.memoryId}'`
    });
  }
  const verdict = evaluateConflict(state, built, false);
  if (isConflictRejection(verdict)) return verdict;
  const candidate = withConflictVerdict(built, verdict);
  if (isRejection2(candidate)) return candidate;
  return acceptSingle(state, command, 'APPLIED', candidate, {
    closures: [{ revisionId: base.revisionId, supersededBy: candidate.revisionId }],
    conflictFlags: verdict.flags,
    reason: `Metadata updated on thread '${command.memoryId}': ${verdict.reason}`
  });
}

function handleRetract(state: LedgerState, command: LedgerCommand): OperationResult {
  if (command.op !== 'RETRACT') throw new Error('handleRetract received the wrong op');
  const resolved = resolveBaseRevision(state, command.memoryId, command.baseRevisionId);
  if (isRejection2(resolved)) return resolved;
  const base = resolved;
  const transition = checkTransition('RETRACT', base);
  if (transition !== null) return transition;

  const candidate = parseRevision(
    buildRevision(
      state,
      command,
      seedFromRevision(base, {
        revisionNo: base.revisionNo + 1,
        status: 'retracted',
        approvalState: command.approvalState,
        decidedAt: command.decidedAt,
        supersedes: base.revisionId
      })
    )
  );
  if (isRejection2(candidate)) return candidate;
  return acceptSingle(state, command, 'APPLIED', candidate, {
    closures: [{ revisionId: base.revisionId, supersededBy: candidate.revisionId }],
    reason: `Retracted thread '${command.memoryId}' (${command.reasonCode})`
  });
}

const REDACTION_REASON_BY_TICKET: Readonly<
  Record<
    'operator_delete' | 'privacy_erasure' | 'poisoned_source' | 'retention_expiry' | 'legal_order',
    'privacy_erasure' | 'poisoned_source' | 'legal_order' | 'sensitivity'
  >
> = {
  operator_delete: 'privacy_erasure',
  privacy_erasure: 'privacy_erasure',
  poisoned_source: 'poisoned_source',
  retention_expiry: 'privacy_erasure',
  legal_order: 'legal_order'
};

function handleDelete(state: LedgerState, command: LedgerCommand): OperationResult {
  if (command.op !== 'DELETE') throw new Error('handleDelete received the wrong op');
  const resolved = resolveBaseRevision(state, command.memoryId, command.baseRevisionId);
  if (isRejection2(resolved)) return resolved;
  const base = resolved;
  if (base.legalHold) {
    return {
      outcome: 'PRECONDITION_FAILED',
      reason: `Legal hold on thread '${command.memoryId}' blocks delete`
    };
  }
  const transition = checkTransition('DELETE', base);
  if (transition !== null) return transition;

  // Logical deletion writes a TOMBSTONE: a minimal, content-free marker that keeps
  // ordering and stops the reducer resurrecting the thread. The payload is redacted
  // in the same revision, so the projection has nothing left to surface.
  const candidate = parseRevision(
    buildRevision(
      state,
      command,
      seedFromRevision(base, {
        revisionNo: base.revisionNo + 1,
        status: 'deleted_logical',
        approvalState: command.approvalState,
        decidedAt: command.decidedAt,
        supersedes: base.revisionId,
        payloadCanonical: {
          form: 'redacted',
          redactionReason: REDACTION_REASON_BY_TICKET[command.ticket.reason]
        },
        tombstone: {
          reason: command.ticket.reason,
          ticketId: command.ticket.ticketId,
          purgeState: 'pending',
          recordedAt: command.issuedAt
        }
      })
    )
  );
  if (isRejection2(candidate)) return candidate;

  // Enqueue the cascade and record it in the graph. `invalidated_by` edges are the
  // durable statement that a dependent must be re-judged; the classification itself
  // is deliberately NOT decided here (see invalidation.ts) because the reducer must
  // never silently rewrite a dependent.
  const dependents = state.revisions.filter(
    (revision) =>
      revision.supersededBy === null &&
      revision.memoryId !== command.memoryId &&
      revision.derivedFrom.includes(command.memoryId)
  );
  const cascadeEdges = dependents.map((dependent) =>
    edge(state, command, 'invalidated_by', dependent.revisionId, candidate.revisionId)
  );

  return acceptSingle(state, command, 'APPLIED', candidate, {
    closures: [{ revisionId: base.revisionId, supersededBy: candidate.revisionId }],
    edges: cascadeEdges,
    deletionMemoryIds: [command.memoryId],
    reason:
      `Logically deleted thread '${command.memoryId}' under ticket ` +
      `'${command.ticket.ticketId}'; ${dependents.length} dependent(s) enqueued`
  });
}

function handleExpire(state: LedgerState, command: LedgerCommand): OperationResult {
  if (command.op !== 'EXPIRE') throw new Error('handleExpire received the wrong op');
  const resolved = resolveBaseRevision(state, command.memoryId, command.baseRevisionId);
  if (isRejection2(resolved)) return resolved;
  const base = resolved;
  const transition = checkTransition('EXPIRE', base);
  if (transition !== null) return transition;

  if (Date.parse(command.validUntil) <= Date.parse(base.validFrom)) {
    return {
      outcome: 'TEMPORAL_INVALID',
      reason: `Expiry '${command.validUntil}' is not after validFrom '${base.validFrom}'`
    };
  }
  if (base.validUntil !== null && Date.parse(base.validUntil) <= Date.parse(command.validUntil)) {
    return {
      outcome: 'PRECONDITION_FAILED',
      reason: `Thread '${command.memoryId}' already closes at '${base.validUntil}'`
    };
  }

  const candidate = parseRevision(
    buildRevision(
      state,
      command,
      seedFromRevision(base, {
        revisionNo: base.revisionNo + 1,
        status: 'expired',
        approvalState: command.approvalState,
        decidedAt: command.decidedAt,
        supersedes: base.revisionId,
        validUntil: command.validUntil
      })
    )
  );
  if (isRejection2(candidate)) return candidate;
  return acceptSingle(state, command, 'APPLIED', candidate, {
    closures: [{ revisionId: base.revisionId, supersededBy: candidate.revisionId }],
    reason: `Thread '${command.memoryId}' expires at '${command.validUntil}'`
  });
}

function handleMerge(state: LedgerState, command: LedgerCommand): OperationResult {
  if (command.op !== 'MERGE') throw new Error('handleMerge received the wrong op');
  const bases: MemoryRevision[] = [];
  for (const source of command.sources) {
    const resolved = resolveBaseRevision(state, source.memoryId, source.baseRevisionId);
    if (isRejection2(resolved)) return resolved;
    if (!isLiveClaim(resolved.status)) {
      return {
        outcome: 'PRECONDITION_FAILED',
        reason: `Merge source '${source.memoryId}' is '${resolved.status}', not a live claim`
      };
    }
    const transition = checkTransition('MERGE', resolved);
    if (transition !== null) return transition;
    bases.push(resolved);
  }
  const survivorBase = bases.find((base) => base.memoryId === command.survivorMemoryId);
  if (survivorBase === undefined) {
    return { outcome: 'PRECONDITION_FAILED', reason: 'Survivor thread is not among the sources' };
  }
  // "Validate the merge plan": the survivor must actually claim its sources, or the
  // provenance graph would lose the fact that the collapsed threads ever existed.
  const absorbed = bases
    .filter((base) => base.memoryId !== command.survivorMemoryId)
    .map((base) => base.memoryId);
  const missing = absorbed.filter((memoryId) => !command.draft.derivedFrom.includes(memoryId));
  if (missing.length > 0) {
    return {
      outcome: 'PRECONDITION_FAILED',
      reason: `Merge plan omits derivedFrom for absorbed thread(s) [${missing.join(', ')}]`
    };
  }

  const built = parseRevision(
    buildRevision(
      state,
      command,
      seedFromDraft(command.draft, {
        memoryId: command.survivorMemoryId,
        revisionNo: survivorBase.revisionNo + 1,
        status: 'active',
        approvalState: command.approvalState,
        decidedAt: command.decidedAt,
        supersedes: survivorBase.revisionId
      })
    )
  );
  if (isRejection2(built)) return built;
  const verdict = evaluateConflict(state, built, true);
  if (isConflictRejection(verdict)) return verdict;

  const closings: MemoryRevision[] = [];
  for (const base of bases) {
    if (base.memoryId === command.survivorMemoryId) continue;
    const closing = parseRevision(
      buildRevision(
        state,
        command,
        seedFromRevision(base, {
          revisionNo: base.revisionNo + 1,
          status: 'superseded',
          approvalState: base.approvalState,
          decidedAt: base.decidedAt,
          supersedes: base.revisionId
        })
      )
    );
    if (isRejection2(closing)) return closing;
    closings.push(closing);
  }

  const newRevisions = [built, ...closings];
  return {
    outcome: 'MERGED',
    newRevisions,
    closures: bases.map((base) => ({
      revisionId: base.revisionId,
      supersededBy:
        newRevisions.find((revision) => revision.memoryId === base.memoryId)?.revisionId ??
        built.revisionId
    })),
    conflictFlags: [],
    edges: newRevisions.flatMap((revision) => revisionEdges(state, command, revision)),
    deletionMemoryIds: [],
    reason: `Merged [${absorbed.join(', ')}] into survivor '${command.survivorMemoryId}'`
  };
}

function handleSplit(state: LedgerState, command: LedgerCommand): OperationResult {
  if (command.op !== 'SPLIT') throw new Error('handleSplit received the wrong op');
  const resolved = resolveBaseRevision(state, command.memoryId, command.baseRevisionId);
  if (isRejection2(resolved)) return resolved;
  const base = resolved;
  if (!isLiveClaim(base.status)) {
    return {
      outcome: 'PRECONDITION_FAILED',
      reason: `Split base '${command.memoryId}' is '${base.status}', not a live claim`
    };
  }
  const transition = checkTransition('SPLIT', base);
  if (transition !== null) return transition;

  const parts: MemoryRevision[] = [];
  // Each part is checked against the pre-command state PLUS the siblings already
  // accepted in this same SPLIT. Checking every part against `state` alone lets one
  // command commit two mutually contradictory active claims: neither part conflicts
  // with anything that existed beforehand, and they are never compared to each
  // other, so the contradiction lands with `conflictFlags: []` and no contradiction
  // edge — invisible to the very engine built to catch it.
  let pending: LedgerState = state;
  for (const part of command.parts) {
    const free = threadIsFree(state, part.memoryId);
    if (free !== null) return free;
    // "Reject if the split mapping is incomplete": a part that does not declare the
    // thread it came from is an orphan claim with no auditable ancestry.
    if (!part.draft.derivedFrom.includes(command.memoryId)) {
      return {
        outcome: 'PRECONDITION_FAILED',
        reason: `Split part '${part.memoryId}' does not derive from base thread '${command.memoryId}'`
      };
    }
    const built = parseRevision(
      buildRevision(
        state,
        command,
        seedFromDraft(part.draft, {
          memoryId: part.memoryId,
          revisionNo: 1,
          status: 'active',
          approvalState: command.approvalState,
          decidedAt: command.decidedAt,
          supersedes: null
        })
      )
    );
    if (isRejection2(built)) return built;
    const verdict = evaluateConflict(pending, built, true);
    if (isConflictRejection(verdict)) return verdict;
    parts.push(built);
    pending = { ...pending, revisions: [...pending.revisions, built] };
  }

  const closing = parseRevision(
    buildRevision(
      state,
      command,
      seedFromRevision(base, {
        revisionNo: base.revisionNo + 1,
        status: 'superseded',
        approvalState: base.approvalState,
        decidedAt: base.decidedAt,
        supersedes: base.revisionId
      })
    )
  );
  if (isRejection2(closing)) return closing;

  const newRevisions = [...parts, closing];
  return {
    outcome: 'SPLIT',
    newRevisions,
    closures: [{ revisionId: base.revisionId, supersededBy: closing.revisionId }],
    conflictFlags: [],
    edges: newRevisions.flatMap((revision) => revisionEdges(state, command, revision)),
    deletionMemoryIds: [],
    reason: `Split thread '${command.memoryId}' into [${parts.map((p) => p.memoryId).join(', ')}]`
  };
}

function handlePromote(state: LedgerState, command: LedgerCommand): OperationResult {
  if (command.op !== 'PROMOTE') throw new Error('handlePromote received the wrong op');
  const free = threadIsFree(state, command.bundle.memoryId);
  if (free !== null) return free;

  const members: MemoryRevision[] = [];
  for (const revisionId of command.memberRevisionIds) {
    const member = findRevision(state.foreignRevisions, revisionId);
    if (member === null) {
      return {
        outcome: 'PRECONDITION_FAILED',
        reason: `Bundle member '${revisionId}' was not supplied as a readable source revision`
      };
    }
    members.push(member);
  }
  const sourceSleeves = sortedUnique(members.map((member) => member.sleeveId));
  const sourceSleeve = sourceSleeves[0];
  if (sourceSleeves.length !== 1 || sourceSleeve === undefined) {
    return {
      outcome: 'PRECONDITION_FAILED',
      reason: `A bundle draws from exactly one source sleeve; got [${sourceSleeves.join(', ')}]`
    };
  }
  const unapproved = members.filter(
    (member) => member.status !== 'active' || member.approvalState !== 'approved'
  );
  if (unapproved.length > 0) {
    return {
      outcome: 'PRECONDITION_FAILED',
      reason:
        `Bundle members must be active and approved; ` +
        `[${unapproved.map((member) => member.revisionId).join(', ')}] are not`
    };
  }
  // The ledger cannot verify that a payload was actually scrubbed, so it refuses to
  // LOWER a sensitivity label on promotion. Declassification has to be an explicit
  // operator act on the source records, not a side effect of publishing.
  const memberCeiling = members.reduce(
    (highest, member) => Math.max(highest, SENSITIVITY_RANK[member.sensitivity]),
    0
  );
  if (SENSITIVITY_RANK[command.bundle.sensitivity] < memberCeiling) {
    return {
      outcome: 'DENIED',
      reason:
        `Bundle sensitivity '${command.bundle.sensitivity}' is below the highest member ` +
        `sensitivity; promotion may not declassify`
    };
  }

  const memberThreads = sortedUnique(members.map((member) => member.memoryId));
  const seed: RevisionSeed = {
    memoryId: command.bundle.memoryId,
    revisionNo: 1,
    status: 'active',
    approvalState: command.approvalState,
    decidedAt: command.decidedAt,
    kind: 'artifact',
    entityKey: null,
    payloadCanonical: {
      form: 'structured',
      fields: {
        bundle_type: 'SharedApprovedBundle',
        source_sleeve: sourceSleeve,
        approved_targets: [...command.bundle.approvedTargetSleeveIds],
        members: [...command.memberRevisionIds],
        sanitization_notes: [...command.bundle.sanitizationNotes]
      }
    },
    eventTime: command.bundle.eventTime,
    observedAt: command.bundle.observedAt,
    validFrom: command.bundle.validFrom,
    validUntil: command.bundle.validUntil,
    derivationMethod: 'operator_reviewed_bundle_promotion',
    confidencePermille: command.bundle.confidencePermille,
    sensitivity: command.bundle.sensitivity,
    retentionPolicy: command.bundle.retentionPolicy,
    legalHold: command.bundle.legalHold,
    workflowId: null,
    runId: null,
    sourceEventIds: [],
    evidenceRefs: command.memberRevisionIds.map((id) => ({ type: 'memory_revision', id })),
    derivedFrom: memberThreads.filter((memoryId) => memoryId !== command.bundle.memoryId),
    contradicts: [],
    supersedes: null,
    tombstone: null
  };
  const candidate = parseRevision(buildRevision(state, command, seed));
  if (isRejection2(candidate)) return candidate;

  const bundleEdges = command.memberRevisionIds.map((id) =>
    edge(state, command, 'bundled_in', id, candidate.revisionId)
  );
  return acceptSingle(state, command, 'PROMOTED', candidate, {
    edges: bundleEdges,
    reason:
      `Promoted ${members.length} member(s) from '${sourceSleeve}' into bundle ` +
      `'${candidate.revisionId}' for [${command.bundle.approvedTargetSleeveIds.join(', ')}]`
  });
}

function bundleTargets(revision: MemoryRevision): readonly string[] {
  if (revision.payloadCanonical.form !== 'structured') return [];
  const targets = revision.payloadCanonical.fields.approved_targets;
  if (!Array.isArray(targets)) return [];
  return targets.filter((value): value is string => typeof value === 'string');
}

function handleImport(state: LedgerState, command: LedgerCommand): OperationResult {
  if (command.op !== 'IMPORT') throw new Error('handleImport received the wrong op');
  const free = threadIsFree(state, command.memoryId);
  if (free !== null) return free;

  const bundle = findRevision(state.foreignRevisions, command.bundleRevisionId);
  if (bundle === null) {
    return {
      outcome: 'PRECONDITION_FAILED',
      reason: `Bundle '${command.bundleRevisionId}' was not supplied as a readable source revision`
    };
  }
  if (bundle.sleeveClass !== 'shared_approved' || bundle.status !== 'active') {
    return {
      outcome: 'DENIED',
      reason:
        `Import requires an active bundle in a shared_approved sleeve; ` +
        `'${bundle.revisionId}' is '${bundle.status}' in a '${bundle.sleeveClass}' sleeve`
    };
  }
  // "No cross-sleeve imported projection may exist without an approved bundle
  // ancestor", and no bundle reaches a sleeve its manifest did not name.
  if (!bundleTargets(bundle).includes(state.sleeveId)) {
    return {
      outcome: 'DENIED',
      reason: `Bundle '${bundle.revisionId}' does not approve target sleeve '${state.sleeveId}'`
    };
  }
  if (SENSITIVITY_RANK[bundle.sensitivity] > SENSITIVITY_RANK[state.maxSensitivity]) {
    return {
      outcome: 'DENIED',
      reason: `Bundle sensitivity '${bundle.sensitivity}' exceeds sleeve cap '${state.maxSensitivity}'`
    };
  }

  const seed: RevisionSeed = {
    memoryId: command.memoryId,
    revisionNo: 1,
    status: 'active',
    approvalState: command.approvalState,
    decidedAt: command.decidedAt,
    kind: bundle.kind,
    entityKey: null,
    payloadCanonical: bundle.payloadCanonical,
    eventTime: command.eventTime,
    observedAt: command.observedAt,
    validFrom: command.validFrom,
    validUntil: command.validUntil,
    derivationMethod: 'operator_reviewed_bundle_promotion',
    confidencePermille: command.confidencePermille,
    // The import inherits the bundle's label verbatim; relabelling on the way in
    // would let an import launder a sensitivity classification.
    sensitivity: bundle.sensitivity,
    retentionPolicy: command.retentionPolicy,
    legalHold: bundle.legalHold,
    workflowId: null,
    runId: null,
    sourceEventIds: [],
    evidenceRefs: [{ type: 'memory_revision', id: bundle.revisionId }],
    derivedFrom: bundle.memoryId === command.memoryId ? [] : [bundle.memoryId],
    contradicts: [],
    supersedes: null,
    tombstone: null
  };
  const candidate = parseRevision(buildRevision(state, command, seed));
  if (isRejection2(candidate)) return candidate;
  return acceptSingle(state, command, 'IMPORTED', candidate, {
    reason: `Imported bundle '${bundle.revisionId}' into thread '${command.memoryId}'`
  });
}

function dispatch(state: LedgerState, command: LedgerCommand): OperationResult {
  switch (command.op) {
    case 'OBSERVE':
      return handleObserve(state, command);
    case 'PROPOSE':
      return handlePropose(state, command);
    case 'ADD':
    case 'SUPERSEDE':
    case 'REVALIDATE':
      return handleActivating(state, command);
    case 'UPDATE':
      return handleUpdate(state, command);
    case 'RETRACT':
      return handleRetract(state, command);
    case 'DELETE':
      return handleDelete(state, command);
    case 'EXPIRE':
      return handleExpire(state, command);
    case 'MERGE':
      return handleMerge(state, command);
    case 'SPLIT':
      return handleSplit(state, command);
    case 'PROMOTE':
      return handlePromote(state, command);
    case 'IMPORT':
      return handleImport(state, command);
    case 'NOOP':
      return { outcome: 'NOOP_EXPLICIT', reason: command.reason };
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

// --- Application ------------------------------------------------------------

/**
 * A refused command still consumed its slot. The sequence advances and the
 * idempotency key is burned, because the command IS in the log: replaying it must
 * refuse identically, and a retry has to arrive as a new command after a re-read
 * rather than as a silent second attempt at the same one.
 */
function consumeSlot(state: LedgerState, idempotencyKey: string): LedgerState {
  return {
    ...state,
    nextSleeveSeq: state.nextSleeveSeq + 1,
    idempotencyKeys: sortedUnique([...state.idempotencyKeys, idempotencyKey])
  };
}

function applyPlan(state: LedgerState, command: LedgerCommand, plan: ApplicationPlan): LedgerState {
  const closureById = new Map(plan.closures.map((closure) => [closure.revisionId, closure]));
  const flagById = new Map(plan.conflictFlags.map((flag) => [flag.revisionId, flag]));

  const rewritten = state.revisions.map((revision) => {
    const closure = closureById.get(revision.revisionId);
    const flag = flagById.get(revision.revisionId);
    if (closure === undefined && flag === undefined) return revision;
    const closed =
      closure === undefined
        ? revision
        : {
            ...revision,
            supersededBy: closure.supersededBy,
            status: closureStatus(revision.status)
          };
    if (flag === undefined) return closed;
    return {
      ...closed,
      status: isLiveClaim(closed.status) ? ('active_conflicted' as const) : closed.status,
      contradicts: sortedUnique([...closed.contradicts, ...flag.contradicts])
    };
  });

  const seenEdgeIds = new Set(state.edges.map((existing) => existing.edgeId));
  const edges = [...state.edges];
  for (const candidate of plan.edges) {
    if (seenEdgeIds.has(candidate.edgeId)) continue;
    seenEdgeIds.add(candidate.edgeId);
    edges.push(candidate);
  }

  return {
    ...consumeSlot(state, command.idempotencyKey),
    revisions: [...rewritten, ...plan.newRevisions],
    edges,
    deletionQueue: sortedUnique([...state.deletionQueue, ...plan.deletionMemoryIds])
  };
}

/**
 * Reduce one command against one sleeve's state.
 *
 * Order of operations is the report's, and each stage is fail-closed:
 *   idempotency -> partition binding -> command schema -> authorization ->
 *   compare-and-swap on the base revision -> revision schema and kind invariants ->
 *   authority precedence -> temporal invariants -> conflict resolution -> apply ->
 *   append revision -> update projection -> update provenance edges.
 *
 * Whatever happens, an audit event comes back.
 */
export function reduceCommand(state: LedgerState, rawCommand: unknown): ReduceResult {
  const envelopeResult = LedgerCommandEnvelopeSchema.safeParse(rawCommand);
  if (!envelopeResult.success) {
    // The one input the ledger cannot audit is one it cannot even address. There is
    // no sleeve, no sequence, and no command id to attach a refusal to, so it is
    // rejected at the boundary instead of being logged as if it were a command.
    throw new LedgerCommandMalformedError(
      'Ledger command envelope is unreadable; the command cannot be sequenced or audited'
    );
  }
  const envelope = envelopeResult.data;

  const refuse = (
    outcome: Rejection['outcome'],
    reason: string,
    memoryId: string | null,
    revisionIds: readonly string[],
    consume: boolean
  ): ReduceResult => ({
    state: consume ? consumeSlot(state, envelope.idempotencyKey) : state,
    audit: buildAudit(state, envelope, outcome, reason, memoryId, revisionIds),
    event: null
  });

  // 1. Idempotency. A duplicate delivery is neither re-evaluated nor re-sequenced,
  //    which is what makes duplicate delivery equivalent to exactly-once delivery.
  if (state.idempotencyKeys.includes(envelope.idempotencyKey)) {
    return refuse(
      'NOOP_DUPLICATE',
      `Idempotency key '${envelope.idempotencyKey}' was already consumed in sleeve '${state.sleeveId}'`,
      null,
      [],
      false
    );
  }

  // 2. Partition binding. A command addressed to another sleeve never reaches this
  //    reducer's state, even to fail interestingly.
  if (envelope.sleeveId !== state.sleeveId || envelope.ownerScopeId !== state.ownerScopeId) {
    return refuse(
      'DENIED',
      `Command targets '${envelope.ownerScopeId}/${envelope.sleeveId}' but this partition is ` +
        `'${state.ownerScopeId}/${state.sleeveId}'`,
      null,
      [],
      true
    );
  }

  const parsed = LedgerCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue === undefined ? '' : issue.path.join('.');
    const message = issue === undefined ? 'schema rejected the command' : issue.message;
    return refuse('INVALID_COMMAND', `Command invalid at '${path}': ${message}`, null, [], true);
  }
  const command = parsed.data;
  const memoryId = commandMemoryId(command);

  // 3. Authorization, deny-by-default.
  const denial = authorizeCommand(state, command);
  if (denial !== null) return refuse('DENIED', denial, memoryId, [], true);

  // 4-9. Preconditions, CAS, schema, precedence, temporal, conflict.
  //
  // Wrapped because the protocol rule is "every command that can be sequenced emits
  // an audit event", and dispatch reaches code that THROWS rather than returning a
  // rejection — canonicalization refuses payloads that are unrepresentable
  // (unsupported types, non-finite numbers, nesting past its depth cap). Letting
  // that escape would drop the one command most worth having a record of: the
  // ledger would refuse the write AND forget that it ever saw it.
  let result: OperationResult;
  try {
    result = dispatch(state, command);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return refuse(
      'INVALID_COMMAND',
      `Command could not be reduced: ${error.message}`,
      memoryId,
      [],
      true
    );
  }
  if (isRejection(result)) {
    return refuse(result.outcome, result.reason, memoryId, result.revisionIds ?? [], true);
  }

  // 10. Apply: append revisions, close the prior head, keep the conflict graph
  //     symmetric, extend the provenance graph, enqueue any deletion cascade.
  const revisionIds = result.newRevisions.map((revision) => revision.revisionId);
  const nextState = applyPlan(state, command, result);
  const audit = buildAudit(state, envelope, result.outcome, result.reason, memoryId, revisionIds);
  const event: LedgerEvent = {
    eventId: deriveEventId(command.commandId),
    commandId: command.commandId,
    sleeveId: state.sleeveId,
    ownerScopeId: state.ownerScopeId,
    sleeveSeq: state.nextSleeveSeq,
    eventType: result.outcome,
    memoryId,
    revisionIds,
    recordedAt: command.issuedAt,
    eventHash: `sha256:${sha256(
      canonicalize({
        commandId: command.commandId,
        sleeveId: state.sleeveId,
        sleeveSeq: state.nextSleeveSeq,
        eventType: result.outcome,
        memoryId,
        revisionIds: [...revisionIds]
      })
    )}`
  };
  return { state: nextState, audit, event };
}

export interface LedgerReplay {
  readonly state: LedgerState;
  readonly audits: readonly LedgerAuditEvent[];
  readonly events: readonly LedgerEvent[];
}

/**
 * Fold an ordered command list into a projection. This is the definition of
 * "projection rebuildability": the same list always yields the same revisions,
 * the same edges, and the same hashes, so a stored projection can be diffed
 * against a replay rather than trusted.
 */
export function replayCommands(
  initialState: LedgerState,
  rawCommands: readonly unknown[]
): LedgerReplay {
  let state = initialState;
  const audits: LedgerAuditEvent[] = [];
  const events: LedgerEvent[] = [];
  for (const rawCommand of rawCommands) {
    const result = reduceCommand(state, rawCommand);
    state = result.state;
    audits.push(result.audit);
    if (result.event !== null) events.push(result.event);
  }
  return { state, audits, events };
}

/**
 * A stable digest of the whole projection. Two replays agree only if every
 * revision, every projection column, and every provenance edge agree — which is
 * exactly the assertion the report asks for.
 */
export function projectionFingerprint(state: LedgerState): string {
  return `sha256:${sha256(
    canonicalize({
      sleeveId: state.sleeveId,
      ownerScopeId: state.ownerScopeId,
      nextSleeveSeq: state.nextSleeveSeq,
      idempotencyKeys: [...state.idempotencyKeys],
      deletionQueue: [...state.deletionQueue],
      revisions: [...state.revisions]
        .sort((left, right) => compareCodeUnits(left.revisionId, right.revisionId))
        .map((revision) => ({
          revisionId: revision.revisionId,
          memoryId: revision.memoryId,
          revisionNo: revision.revisionNo,
          status: revision.status,
          supersededBy: revision.supersededBy,
          contradicts: [...revision.contradicts],
          canonicalHash: revision.canonicalHash,
          contentHash: revision.contentHash,
          recordedTxSeq: revision.recordedTxSeq
        })),
      edges: [...state.edges]
        .sort((left, right) => compareCodeUnits(left.edgeId, right.edgeId))
        .map((entry) => ({
          edgeId: entry.edgeId,
          edgeType: entry.edgeType,
          fromId: entry.fromId,
          toId: entry.toId
        }))
    })
  )}`;
}
