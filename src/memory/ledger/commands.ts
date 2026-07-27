import { z } from 'zod';

import {
  AccessAgentIdSchema,
  AccessSensitivitySchema,
  ControlScopeIdSchema,
  MemorySleeveIdSchema
} from '../../agents/access-control-contracts';
import { MemoryKindSchema } from '../../knowledge/retrieval-contracts';
import { sha256 } from '../system/hashing';
import { AuthorityTierSchema, type AuthorityTier } from './authority';
import { canonicalize } from './canonical';
import { MemoryApprovalStateSchema } from './lifecycle';
import {
  MemoryDerivationMethodSchema,
  MemoryEntityKeySchema,
  MemoryEvidenceRefSchema,
  MemoryIdSchema,
  MemoryPayloadCanonicalSchema,
  MemoryRetentionPolicySchema,
  MemoryRevisionIdSchema,
  MemorySourceEventIdSchema
} from './record-contracts';

/**
 * `memcmd/v1` — the ledger's command protocol.
 *
 * The report's strongest practical conclusion is that AGENTS MUST NOT MUTATE
 * CANONICAL MEMORY. They emit commands into a logged, per-sleeve stream and a
 * deterministic reducer is the only component that turns those into accepted
 * state. Everything in this file exists to make that boundary checkable before a
 * command ever reaches the reducer: what may be asked, by whom, against which
 * base revision, and under which idempotency anchor.
 *
 * Two protocol rules from the report are load-bearing and are enforced here and
 * in the reducer, never assumed:
 *
 *   1. UPDATE IS METADATA-ONLY. A change to the asserted claim must use
 *      SUPERSEDE. The command still CARRIES its payload — that is deliberate, so
 *      the reducer can compare it to the base's content hash and reject a
 *      semantic edit outright instead of silently accepting a rewrite of history.
 *   2. EVERY COMMAND PRODUCES AN AUDIT EVENT, including denials, stale-base
 *      rejections, and explicit NOOPs. A refusal that leaves no trace is
 *      indistinguishable from a dropped message.
 *
 * Every id the ledger mints is DERIVED from the command, never generated: replay
 * has to produce bit-identical revision ids, so `Math.random`, counters, and
 * clocks are all excluded by construction.
 */
export const MEMORY_COMMAND_SCHEMA_VERSION = 'memcmd/v1';

export const MemoryCommandSchemaVersionSchema = z.literal(MEMORY_COMMAND_SCHEMA_VERSION);

const commandIdPattern = /^cmd_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;
const idempotencyKeyPattern = /^idk_[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$/u;
const workflowIdPattern = /^wf_[a-z0-9][a-z0-9_]{0,63}$/u;
const runIdPattern = /^run_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;
const deleteTicketPattern = /^tkt_[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const sanitizationNotePattern = /^[a-z][a-z0-9 _-]{0,119}$/u;

export const LedgerCommandIdSchema = z.string().regex(commandIdPattern);
export const LedgerIdempotencyKeySchema = z.string().regex(idempotencyKeyPattern);

/**
 * The report's legal operations table, in its own vocabulary. Uppercase because
 * these are protocol verbs on the wire, not internal enum members — the audit
 * outcomes (`STALE_BASE`, `NOOP_DUPLICATE`) read the same way for the same reason.
 */
export const LEDGER_COMMAND_OPS = [
  'OBSERVE',
  'PROPOSE',
  'ADD',
  'UPDATE',
  'SUPERSEDE',
  'RETRACT',
  'DELETE',
  'MERGE',
  'SPLIT',
  'PROMOTE',
  'IMPORT',
  'EXPIRE',
  'REVALIDATE',
  'NOOP'
] as const;

export const LedgerCommandOpSchema = z.enum(LEDGER_COMMAND_OPS);
export type LedgerCommandOp = z.infer<typeof LedgerCommandOpSchema>;

/** Whether an op takes a compare-and-swap guard on the thread's current head. */
export type BaseRevisionRequirement = 'required' | 'optional' | 'forbidden';

export interface LedgerOperationPolicy {
  readonly op: LedgerCommandOp;
  readonly baseRevision: BaseRevisionRequirement;
  /**
   * Deny-by-default floor on the authority hierarchy. A command below this tier is
   * denied before any state is inspected, so a weak proposer cannot even attempt a
   * privileged op and learn something from the failure mode.
   */
  readonly minimumAuthorityTier: AuthorityTier;
  /**
   * Review states the AUTHORIZATION gate demands, independent of whether the
   * resulting revision would be lifecycle-coherent. `null` means the op adds no
   * demand beyond that coherence check.
   */
  readonly requiredApprovalStates: readonly z.infer<typeof MemoryApprovalStateSchema>[] | null;
  /** The report's idempotency anchor, restated as the key a caller must derive. */
  readonly idempotencyAnchor: string;
  /** The report's rollback column: how a mistake is undone without editing history. */
  readonly rollback: string;
  readonly description: string;
}

/**
 * The operations table, transcribed. It is a lookup rather than a set of
 * conditionals because the reducer must branch identically on it forever: a
 * missing entry has to be a type error, not a fall-through to a permissive
 * default.
 */
export const LEDGER_OPERATION_POLICIES: Readonly<Record<LedgerCommandOp, LedgerOperationPolicy>> = {
  OBSERVE: {
    op: 'OBSERVE',
    baseRevision: 'forbidden',
    minimumAuthorityTier: 'statistical_pattern',
    requiredApprovalStates: null,
    idempotencyAnchor: '(sleeveId, sourceEventIds, contentHash)',
    rollback: 'compensate with RETRACT or DELETE',
    description: 'Open a thread with a draft episode or artifact revision plus its provenance.'
  },
  PROPOSE: {
    op: 'PROPOSE',
    baseRevision: 'optional',
    minimumAuthorityTier: 'statistical_pattern',
    requiredApprovalStates: null,
    idempotencyAnchor: '(proposal key, contentHash)',
    rollback: 'compensate with RETRACT',
    description:
      'Raise a proposed revision, either on a fresh thread or over an existing observed draft.'
  },
  ADD: {
    op: 'ADD',
    baseRevision: 'required',
    minimumAuthorityTier: 'agent_observation',
    requiredApprovalStates: null,
    idempotencyAnchor: '(commandId, memoryId)',
    rollback: 'compensate with RETRACT or DELETE',
    description: 'Promote a proposal to the first active revision of its thread.'
  },
  UPDATE: {
    op: 'UPDATE',
    baseRevision: 'required',
    minimumAuthorityTier: 'agent_inference',
    requiredApprovalStates: null,
    idempotencyAnchor: '(memoryId, baseRevisionId, patchHash)',
    rollback: 'reapply the inverse metadata patch as a new revision',
    description:
      'Emit a metadata-only revision. Any change to the asserted claim is rejected outright.'
  },
  SUPERSEDE: {
    op: 'SUPERSEDE',
    baseRevision: 'required',
    minimumAuthorityTier: 'agent_observation',
    requiredApprovalStates: null,
    idempotencyAnchor: 'CAS on baseRevisionId',
    rollback: 'emit a compensating supersession',
    description: 'Close the current revision and activate a new claim on the same thread.'
  },
  RETRACT: {
    op: 'RETRACT',
    baseRevision: 'required',
    minimumAuthorityTier: 'agent_observation',
    requiredApprovalStates: null,
    idempotencyAnchor: '(targetRevisionId, reasonCode)',
    rollback: 'emit REVALIDATE or a later SUPERSEDE',
    description: 'Withdraw a claim whose evidence is invalid, poisoned, or disproven.'
  },
  DELETE: {
    op: 'DELETE',
    baseRevision: 'required',
    // "Operator or privacy-delete service only" — the one op that suppresses
    // retrieval and enqueues a cascade, so the floor is an operator decision.
    minimumAuthorityTier: 'operator_explicit',
    requiredApprovalStates: ['approved'],
    idempotencyAnchor: 'delete ticket id',
    rollback: 'a dedicated undelete before purge, never after',
    description: 'Suppress retrieval, write a tombstone revision, and enqueue the cascade.'
  },
  MERGE: {
    op: 'MERGE',
    baseRevision: 'required',
    minimumAuthorityTier: 'human_artifact_verified',
    requiredApprovalStates: ['approved'],
    idempotencyAnchor: 'sorted source set hash',
    rollback: 'emit SPLIT if the merge is later judged wrong',
    description: 'Collapse proven-duplicate threads onto one survivor thread.'
  },
  SPLIT: {
    op: 'SPLIT',
    baseRevision: 'required',
    minimumAuthorityTier: 'human_artifact_verified',
    requiredApprovalStates: ['approved'],
    idempotencyAnchor: '(baseRevisionId, split plan hash)',
    rollback: 'merge the parts back with MERGE',
    description: 'Separate a thread that conflates multiple claims into distinct threads.'
  },
  PROMOTE: {
    op: 'PROMOTE',
    baseRevision: 'forbidden',
    minimumAuthorityTier: 'operator_explicit',
    requiredApprovalStates: ['approved'],
    idempotencyAnchor: 'bundle manifest hash',
    rollback: 'retract the bundle or publish a corrected successor bundle',
    description: 'Publish an operator-reviewed SharedApprovedBundle into a shared sleeve.'
  },
  IMPORT: {
    op: 'IMPORT',
    baseRevision: 'forbidden',
    // The only op that materializes another sleeve's content locally, so it demands
    // the top tier: an approved bundle is the sole legal cross-sleeve carrier.
    minimumAuthorityTier: 'policy_signed_approved',
    requiredApprovalStates: ['approved'],
    idempotencyAnchor: '(bundleRevisionId, targetSleeveId)',
    rollback: 'delete or supersede the import projection',
    description: 'Materialize a local projection of an approved bundle in an authorized target.'
  },
  EXPIRE: {
    op: 'EXPIRE',
    baseRevision: 'required',
    minimumAuthorityTier: 'agent_observation',
    requiredApprovalStates: null,
    idempotencyAnchor: '(targetRevisionId, validUntil)',
    rollback: 'REVALIDATE or SUPERSEDE',
    description: 'Close a claim’s validity interval so it stops being current.'
  },
  REVALIDATE: {
    op: 'REVALIDATE',
    baseRevision: 'required',
    minimumAuthorityTier: 'agent_observation',
    requiredApprovalStates: null,
    idempotencyAnchor: '(memoryId, evidence hash)',
    rollback: 'RETRACT or EXPIRE',
    description: 'Reactivate an expired or retracted thread on fresh evidence.'
  },
  NOOP: {
    op: 'NOOP',
    baseRevision: 'forbidden',
    minimumAuthorityTier: 'statistical_pattern',
    requiredApprovalStates: null,
    idempotencyAnchor: 'original commandId',
    rollback: 'none needed',
    description: 'Record that a command was evaluated and no state change was warranted.'
  }
};

function addIssue(context: z.RefinementCtx, path: (string | number)[], message: string): void {
  context.addIssue({ code: 'custom', path, message });
}

function isSortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined) return false;
    if (previous >= current) return false;
  }
  return true;
}

/**
 * The content fields of a revision a proposer may author.
 *
 * Deliberately absent: `revisionId`, `revisionNo`, `createdTxTime`,
 * `recordedTxSeq`, `status`, `supersedes`, `supersededBy`, `contradicts`, and
 * both hashes. Every one of those is DERIVED by the reducer from the command and
 * the sleeve's ordered log. A proposer that could choose its own revision id or
 * transaction sequence could forge history; a proposer that could choose its own
 * status could skip review.
 */
export const LedgerRevisionDraftSchema = z
  .strictObject({
    kind: MemoryKindSchema,
    entityKey: MemoryEntityKeySchema.nullable(),
    payloadCanonical: MemoryPayloadCanonicalSchema,
    eventTime: z.iso.datetime().nullable(),
    observedAt: z.iso.datetime(),
    validFrom: z.iso.datetime(),
    validUntil: z.iso.datetime().nullable(),
    derivationMethod: MemoryDerivationMethodSchema,
    confidencePermille: z.number().int().min(0).max(1_000),
    sensitivity: AccessSensitivitySchema,
    retentionPolicy: MemoryRetentionPolicySchema,
    legalHold: z.boolean(),
    workflowId: z.string().regex(workflowIdPattern).nullable(),
    runId: z.string().regex(runIdPattern).nullable(),
    sourceEventIds: z.array(MemorySourceEventIdSchema).max(64),
    evidenceRefs: z.array(MemoryEvidenceRefSchema).max(64),
    derivedFrom: z.array(MemoryIdSchema).max(64)
  })
  .superRefine((draft, context) => {
    if (draft.validUntil !== null && Date.parse(draft.validUntil) <= Date.parse(draft.validFrom)) {
      addIssue(context, ['validUntil'], 'validUntil must be later than validFrom');
    }
    if (new Set(draft.sourceEventIds).size !== draft.sourceEventIds.length) {
      addIssue(context, ['sourceEventIds'], 'sourceEventIds must be unique');
    }
    if (new Set(draft.derivedFrom).size !== draft.derivedFrom.length) {
      addIssue(context, ['derivedFrom'], 'derivedFrom must be unique');
    }
    const evidenceKeys = draft.evidenceRefs.map((ref) => `${ref.type}:${ref.id}`);
    if (new Set(evidenceKeys).size !== evidenceKeys.length) {
      addIssue(context, ['evidenceRefs'], 'evidenceRefs must be unique');
    }
    // A redacted payload is the OUTPUT of a delete, never an input a proposer may
    // author: accepting one would let a writer manufacture a content-free record
    // that looks like the residue of an approved erasure.
    if (draft.payloadCanonical.form === 'redacted') {
      addIssue(context, ['payloadCanonical'], 'a draft may not author a redacted payload');
    }
  });

export type LedgerRevisionDraft = z.infer<typeof LedgerRevisionDraftSchema>;

/**
 * The metadata a report-legal `UPDATE` may change: approval, confidence,
 * sensitivity, retention class, legal hold, and the evidence list. None of them
 * enters `canonicalHash`, which is exactly why an UPDATE can be applied without
 * the thread's claim digest moving.
 */
export const LedgerMetadataPatchSchema = z.strictObject({
  confidencePermille: z.number().int().min(0).max(1_000),
  sensitivity: AccessSensitivitySchema,
  retentionPolicy: MemoryRetentionPolicySchema,
  legalHold: z.boolean(),
  evidenceRefs: z.array(MemoryEvidenceRefSchema).max(64)
});

export const LedgerRetractionReasonSchema = z.enum([
  'evidence_invalid',
  'poisoned_source',
  'disproven',
  'policy_revocation',
  'operator_correction'
]);

export const LedgerDeleteTicketSchema = z.strictObject({
  reason: z.enum([
    'operator_delete',
    'privacy_erasure',
    'poisoned_source',
    'retention_expiry',
    'legal_order'
  ]),
  ticketId: z.string().regex(deleteTicketPattern)
});

const commandBaseShape = {
  schemaVersion: MemoryCommandSchemaVersionSchema,
  commandId: LedgerCommandIdSchema,
  idempotencyKey: LedgerIdempotencyKeySchema,
  ownerScopeId: ControlScopeIdSchema,
  sleeveId: MemorySleeveIdSchema,
  issuedBy: AccessAgentIdSchema,
  /** Transaction time. The reducer uses it verbatim; it never reads a clock itself. */
  issuedAt: z.iso.datetime(),
  authorityTier: AuthorityTierSchema,
  approvalState: MemoryApprovalStateSchema,
  decidedAt: z.iso.datetime().nullable()
} as const;

const ThreadSourceSchema = z.strictObject({
  memoryId: MemoryIdSchema,
  baseRevisionId: MemoryRevisionIdSchema
});

const SplitPartSchema = z.strictObject({
  memoryId: MemoryIdSchema,
  draft: LedgerRevisionDraftSchema
});

const BundleManifestSchema = z
  .strictObject({
    memoryId: MemoryIdSchema,
    eventTime: z.iso.datetime().nullable(),
    observedAt: z.iso.datetime(),
    validFrom: z.iso.datetime(),
    validUntil: z.iso.datetime().nullable(),
    sensitivity: AccessSensitivitySchema,
    retentionPolicy: MemoryRetentionPolicySchema,
    legalHold: z.boolean(),
    confidencePermille: z.number().int().min(0).max(1_000),
    approvedTargetSleeveIds: z.array(MemorySleeveIdSchema).min(1).max(16),
    sanitizationNotes: z.array(z.string().regex(sanitizationNotePattern)).max(16)
  })
  .superRefine((bundle, context) => {
    if (
      bundle.validUntil !== null &&
      Date.parse(bundle.validUntil) <= Date.parse(bundle.validFrom)
    ) {
      addIssue(context, ['validUntil'], 'validUntil must be later than validFrom');
    }
    // Sorted-and-unique, not merely unique: the target list is hashed into the
    // bundle's canonical payload, so two orderings of the same audience must not
    // produce two different bundles.
    if (!isSortedUnique(bundle.approvedTargetSleeveIds)) {
      addIssue(
        context,
        ['approvedTargetSleeveIds'],
        'approvedTargetSleeveIds must be sorted ascending and unique'
      );
    }
  });

const ObserveCommandSchema = z.strictObject({
  ...commandBaseShape,
  op: z.literal('OBSERVE'),
  memoryId: MemoryIdSchema,
  draft: LedgerRevisionDraftSchema
});

const ProposeCommandSchema = z.strictObject({
  ...commandBaseShape,
  op: z.literal('PROPOSE'),
  memoryId: MemoryIdSchema,
  /** Present when promoting an existing observed draft; absent when opening a thread. */
  baseRevisionId: MemoryRevisionIdSchema.nullable(),
  draft: LedgerRevisionDraftSchema
});

const AddCommandSchema = z.strictObject({
  ...commandBaseShape,
  op: z.literal('ADD'),
  memoryId: MemoryIdSchema,
  baseRevisionId: MemoryRevisionIdSchema,
  draft: LedgerRevisionDraftSchema
});

const UpdateCommandSchema = z.strictObject({
  ...commandBaseShape,
  op: z.literal('UPDATE'),
  memoryId: MemoryIdSchema,
  baseRevisionId: MemoryRevisionIdSchema,
  /**
   * Carried so the reducer can PROVE the claim is unchanged. A schema that simply
   * omitted the payload would make the rule unenforceable: the reducer would have
   * nothing to compare, and a caller intending a semantic edit would get silence
   * instead of a rejection.
   */
  payloadCanonical: MemoryPayloadCanonicalSchema,
  metadata: LedgerMetadataPatchSchema
});

const SupersedeCommandSchema = z.strictObject({
  ...commandBaseShape,
  op: z.literal('SUPERSEDE'),
  memoryId: MemoryIdSchema,
  baseRevisionId: MemoryRevisionIdSchema,
  draft: LedgerRevisionDraftSchema
});

const RetractCommandSchema = z.strictObject({
  ...commandBaseShape,
  op: z.literal('RETRACT'),
  memoryId: MemoryIdSchema,
  baseRevisionId: MemoryRevisionIdSchema,
  reasonCode: LedgerRetractionReasonSchema
});

const DeleteCommandSchema = z.strictObject({
  ...commandBaseShape,
  op: z.literal('DELETE'),
  memoryId: MemoryIdSchema,
  baseRevisionId: MemoryRevisionIdSchema,
  ticket: LedgerDeleteTicketSchema
});

const MergeCommandSchema = z
  .strictObject({
    ...commandBaseShape,
    op: z.literal('MERGE'),
    sources: z.array(ThreadSourceSchema).min(2).max(16),
    survivorMemoryId: MemoryIdSchema,
    draft: LedgerRevisionDraftSchema
  })
  .superRefine((command, context) => {
    const ids = command.sources.map((source) => source.memoryId);
    if (!isSortedUnique(ids)) {
      addIssue(context, ['sources'], 'merge sources must be sorted by memoryId and unique');
    }
    if (!ids.includes(command.survivorMemoryId)) {
      addIssue(context, ['survivorMemoryId'], 'the survivor must be one of the merged sources');
    }
  });

const SplitCommandSchema = z
  .strictObject({
    ...commandBaseShape,
    op: z.literal('SPLIT'),
    memoryId: MemoryIdSchema,
    baseRevisionId: MemoryRevisionIdSchema,
    parts: z.array(SplitPartSchema).min(2).max(16)
  })
  .superRefine((command, context) => {
    const ids = command.parts.map((part) => part.memoryId);
    if (!isSortedUnique(ids)) {
      addIssue(context, ['parts'], 'split parts must be sorted by memoryId and unique');
    }
    // An incomplete split plan is the report's stated failure mode: a part that
    // reuses the base thread's identity would leave two live heads for one claim.
    if (ids.includes(command.memoryId)) {
      addIssue(context, ['parts'], 'a split part may not reuse the base thread identity');
    }
  });

const PromoteCommandSchema = z
  .strictObject({
    ...commandBaseShape,
    op: z.literal('PROMOTE'),
    memberRevisionIds: z.array(MemoryRevisionIdSchema).min(1).max(64),
    bundle: BundleManifestSchema
  })
  .superRefine((command, context) => {
    if (!isSortedUnique(command.memberRevisionIds)) {
      addIssue(
        context,
        ['memberRevisionIds'],
        'memberRevisionIds must be sorted ascending and unique'
      );
    }
  });

const ImportCommandSchema = z.strictObject({
  ...commandBaseShape,
  op: z.literal('IMPORT'),
  bundleRevisionId: MemoryRevisionIdSchema,
  memoryId: MemoryIdSchema,
  eventTime: z.iso.datetime().nullable(),
  observedAt: z.iso.datetime(),
  validFrom: z.iso.datetime(),
  validUntil: z.iso.datetime().nullable(),
  retentionPolicy: MemoryRetentionPolicySchema,
  confidencePermille: z.number().int().min(0).max(1_000)
});

const ExpireCommandSchema = z.strictObject({
  ...commandBaseShape,
  op: z.literal('EXPIRE'),
  memoryId: MemoryIdSchema,
  baseRevisionId: MemoryRevisionIdSchema,
  validUntil: z.iso.datetime()
});

const RevalidateCommandSchema = z.strictObject({
  ...commandBaseShape,
  op: z.literal('REVALIDATE'),
  memoryId: MemoryIdSchema,
  baseRevisionId: MemoryRevisionIdSchema,
  draft: LedgerRevisionDraftSchema
});

const NoopCommandSchema = z.strictObject({
  ...commandBaseShape,
  op: z.literal('NOOP'),
  reason: z.string().trim().min(1).max(500)
});

/** Review states that assert a decision was actually taken by a human or policy. */
const DECIDED_APPROVAL_STATES = ['reviewed', 'approved', 'rejected'] as const;

/**
 * The command union. Cross-field invariants that hold for EVERY op live on the
 * union so no member can forget them.
 */
export const LedgerCommandSchema = z
  .discriminatedUnion('op', [
    ObserveCommandSchema,
    ProposeCommandSchema,
    AddCommandSchema,
    UpdateCommandSchema,
    SupersedeCommandSchema,
    RetractCommandSchema,
    DeleteCommandSchema,
    MergeCommandSchema,
    SplitCommandSchema,
    PromoteCommandSchema,
    ImportCommandSchema,
    ExpireCommandSchema,
    RevalidateCommandSchema,
    NoopCommandSchema
  ])
  .superRefine((command, context) => {
    // "Who vouched, and when" can never be half-recorded: a decided review state
    // without a decision timestamp is unauditable, and a timestamp without a
    // decision is a claim nobody made.
    const claimsDecision = DECIDED_APPROVAL_STATES.some((state) => state === command.approvalState);
    if (claimsDecision && command.decidedAt === null) {
      addIssue(
        context,
        ['decidedAt'],
        `approvalState '${command.approvalState}' requires decidedAt`
      );
    }
    if (!claimsDecision && command.decidedAt !== null) {
      addIssue(
        context,
        ['decidedAt'],
        `approvalState '${command.approvalState}' must not carry decidedAt`
      );
    }
    if (
      command.decidedAt !== null &&
      Date.parse(command.decidedAt) > Date.parse(command.issuedAt)
    ) {
      addIssue(context, ['decidedAt'], 'decision cannot follow command issuance');
    }
    // The reducer stamps `createdTxTime` from `issuedAt`, and a revision may not be
    // observed after it was accepted; catching it here keeps the failure at the
    // protocol boundary where the caller can act on it.
    if ('draft' in command && Date.parse(command.draft.observedAt) > Date.parse(command.issuedAt)) {
      addIssue(context, ['draft', 'observedAt'], 'observation cannot follow command issuance');
    }
  });

export type LedgerCommand = z.infer<typeof LedgerCommandSchema>;
export type LedgerObserveCommand = z.infer<typeof ObserveCommandSchema>;
export type LedgerProposeCommand = z.infer<typeof ProposeCommandSchema>;
export type LedgerAddCommand = z.infer<typeof AddCommandSchema>;
export type LedgerUpdateCommand = z.infer<typeof UpdateCommandSchema>;
export type LedgerSupersedeCommand = z.infer<typeof SupersedeCommandSchema>;
export type LedgerRetractCommand = z.infer<typeof RetractCommandSchema>;
export type LedgerDeleteCommand = z.infer<typeof DeleteCommandSchema>;
export type LedgerMergeCommand = z.infer<typeof MergeCommandSchema>;
export type LedgerSplitCommand = z.infer<typeof SplitCommandSchema>;
export type LedgerPromoteCommand = z.infer<typeof PromoteCommandSchema>;
export type LedgerImportCommand = z.infer<typeof ImportCommandSchema>;
export type LedgerExpireCommand = z.infer<typeof ExpireCommandSchema>;
export type LedgerRevalidateCommand = z.infer<typeof RevalidateCommandSchema>;
export type LedgerNoopCommand = z.infer<typeof NoopCommandSchema>;

/**
 * The minimum a command must supply to be AUDITABLE, even when the full schema
 * rejects it. Without this the second protocol rule would be unachievable: a
 * malformed command would fail silently and leave the operator with nothing to
 * debug. Non-strict on purpose — it reads the envelope out of a payload it has
 * already decided not to trust.
 */
export const LedgerCommandEnvelopeSchema = z.object({
  commandId: LedgerCommandIdSchema,
  idempotencyKey: LedgerIdempotencyKeySchema,
  ownerScopeId: ControlScopeIdSchema,
  sleeveId: MemorySleeveIdSchema,
  op: LedgerCommandOpSchema,
  issuedBy: AccessAgentIdSchema,
  issuedAt: z.iso.datetime(),
  authorityTier: AuthorityTierSchema,
  approvalState: MemoryApprovalStateSchema
});

export type LedgerCommandEnvelope = z.infer<typeof LedgerCommandEnvelopeSchema>;

/** The base revision a command names, if its op takes one. */
export function commandBaseRevisionId(command: LedgerCommand): string | null {
  switch (command.op) {
    case 'PROPOSE':
      return command.baseRevisionId;
    case 'ADD':
    case 'UPDATE':
    case 'SUPERSEDE':
    case 'RETRACT':
    case 'DELETE':
    case 'SPLIT':
    case 'EXPIRE':
    case 'REVALIDATE':
      return command.baseRevisionId;
    case 'MERGE':
      // The survivor's base is the CAS guard the reducer reports on; every source's
      // base is checked too, but only one can be named in a single-valued column.
      return (
        command.sources.find((source) => source.memoryId === command.survivorMemoryId)
          ?.baseRevisionId ?? null
      );
    case 'OBSERVE':
    case 'PROMOTE':
    case 'IMPORT':
    case 'NOOP':
      return null;
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

/** The thread a command primarily targets, if it targets exactly one. */
export function commandMemoryId(command: LedgerCommand): string | null {
  switch (command.op) {
    case 'OBSERVE':
    case 'PROPOSE':
    case 'ADD':
    case 'UPDATE':
    case 'SUPERSEDE':
    case 'RETRACT':
    case 'DELETE':
    case 'SPLIT':
    case 'EXPIRE':
    case 'REVALIDATE':
    case 'IMPORT':
      return command.memoryId;
    case 'MERGE':
      return command.survivorMemoryId;
    case 'PROMOTE':
      return command.bundle.memoryId;
    case 'NOOP':
      return null;
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

function digest(value: unknown): string {
  return `sha256:${sha256(canonicalize(value))}`;
}

/**
 * Tamper-evident digest of the whole command document. Two proposers submitting
 * byte-identical intent produce the same hash, which is what makes a duplicate
 * delivery recognisable as a duplicate rather than as a second request.
 */
export function commandHash(command: LedgerCommand): string {
  return digest(command);
}

/**
 * Derived ids. Every one of these is a pure function of already-ordered inputs,
 * so a replay of the same log mints the same identifiers. A random or
 * clock-derived id would make "replaying the same ordered ledger twice produces
 * bit-identical projections" false by construction.
 */
export function deriveRevisionId(commandId: string, memoryId: string, revisionNo: number): string {
  return `rev_${sha256(canonicalize({ commandId, memoryId, revisionNo })).slice(0, 40)}`;
}

export function deriveEventId(commandId: string): string {
  return `lev_${sha256(canonicalize({ commandId, kind: 'event' })).slice(0, 40)}`;
}

export function deriveAuditId(commandId: string): string {
  return `aud_${sha256(canonicalize({ commandId, kind: 'audit' })).slice(0, 40)}`;
}

export function deriveEdgeId(
  sleeveId: string,
  fromId: string,
  toId: string,
  edgeType: string
): string {
  return `pve_${sha256(canonicalize({ sleeveId, fromId, toId, edgeType })).slice(0, 40)}`;
}
