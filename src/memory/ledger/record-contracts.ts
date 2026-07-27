import { z } from 'zod';

import {
  AccessAgentIdSchema,
  AccessSensitivitySchema,
  ControlScopeIdSchema,
  MemorySleeveIdSchema,
  MemorySleeveKindSchema,
  type MemorySleeveKind
} from '../../agents/access-control-contracts';
import { MemoryKindSchema } from '../../knowledge/retrieval-contracts';
import { storeClassForKind } from '../system/store-classes';
import { AuthorityTierSchema } from './authority';
import {
  isReviewCompatible,
  MemoryApprovalStateSchema,
  MemoryLifecycleStateSchema
} from './lifecycle';

/**
 * `memrec/v1` — the canonical memory record.
 *
 * A record is an immutable REVISION of a memory thread, never a mutable row.
 * Two identifiers carry that split: `memoryId` is the stable identity of the
 * conceptual memory, `revisionId` is the immutable identity of one accepted
 * revision of it. Corrections are new revisions plus supersession links, because
 * overwriting history destroys the audit trail the ledger exists to provide.
 *
 * Every schema version is pinned on the record itself so replay can pick the
 * right upcaster; retired identifiers are never reused.
 */
export const MEMORY_RECORD_SCHEMA_VERSION = 'memrec/v1';

export const MemoryRecordSchemaVersionSchema = z.literal(MEMORY_RECORD_SCHEMA_VERSION);
export const MemoryRecordTypeSchema = z.literal('MemoryRevision');

const memoryIdPattern = /^mem_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;
const revisionIdPattern = /^rev_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;
const sourceEventIdPattern = /^evt_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;
const runIdPattern = /^run_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;
const workflowIdPattern = /^wf_[a-z0-9][a-z0-9_]{0,63}$/u;
const entityKeyPattern = /^[a-z][a-z0-9_]*(?:\/[a-z0-9_]+)*$/u;
const evidenceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const qualifierPattern = /^[a-z][a-z0-9_]*(?::[a-z0-9_]+)*$/u;
const payloadFieldKeyPattern = /^[a-z][a-z0-9_]{0,63}$/u;
const deleteTicketPattern = /^tkt_[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

export const MemoryIdSchema = z.string().regex(memoryIdPattern);
export const MemoryRevisionIdSchema = z.string().regex(revisionIdPattern);
export const MemorySourceEventIdSchema = z.string().regex(sourceEventIdPattern);
export const MemoryEntityKeySchema = z.string().max(160).regex(entityKeyPattern);
/** `sha256:<64 lowercase hex>` — the prefix keeps the algorithm explicit for future rotation. */
export const MemoryDigestSchema = z.string().regex(digestPattern);

function addIssue(context: z.RefinementCtx, path: string[], message: string): void {
  context.addIssue({ code: 'custom', path, message });
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/**
 * The value space the canonical serializer accepts. Numbers are restricted to
 * exact integers on purpose: IEEE-754 doubles have several textual forms and
 * cross-language rounding differs, so admitting them would make canonical hashes
 * environment-dependent. Fractional quantities travel as fixed-point integers
 * (the repo's `permille` convention), exactly as `confidencePermille` does.
 *
 * Declared here rather than in `canonical.ts` so the serializer can depend on
 * the record contracts without the contracts depending back on it.
 */
export type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export const CanonicalJsonValueSchema: z.ZodType<CanonicalJsonValue> = z.lazy(() =>
  z.union([
    z.string().max(8_000),
    z.number().int(),
    z.boolean(),
    z.null(),
    z.array(CanonicalJsonValueSchema).max(256),
    z.record(z.string().regex(payloadFieldKeyPattern), CanonicalJsonValueSchema)
  ])
);

/**
 * Subject/predicate/object form. This is the only payload shape the conflict
 * engine can compare claim-for-claim, which is why it is a tagged variant rather
 * than a structural guess: "is this a triple?" must be a lookup, not a heuristic.
 *
 * `qualifiers` carries the claim's CONTEXT — audience, channel, exception scope.
 * More qualifiers means a narrower claim, which is what makes the report's
 * `narrow_context` resolution expressible instead of aspirational. They must
 * arrive sorted and unique: the ledger refuses an ambiguous encoding rather than
 * silently normalizing one, so the bytes a writer signed are the bytes that hash.
 */
export const MemoryClaimTriplePayloadSchema = z
  .strictObject({
    form: z.literal('triple'),
    subject: z.string().trim().min(1).max(240),
    predicate: z.string().trim().min(1).max(120),
    object: z.string().trim().min(1).max(2_000),
    qualifiers: z.array(z.string().regex(qualifierPattern)).max(16)
  })
  .superRefine((payload, context) => {
    if (hasDuplicates(payload.qualifiers)) {
      addIssue(context, ['qualifiers'], 'payload qualifiers must be unique');
    }
    const sorted = [...payload.qualifiers].sort();
    if (payload.qualifiers.some((qualifier, index) => qualifier !== sorted[index])) {
      addIssue(context, ['qualifiers'], 'payload qualifiers must be sorted ascending');
    }
  });

/** Structured claims (episodes, bundles, procedures) that no comparator can adjudicate. */
export const MemoryStructuredPayloadSchema = z
  .strictObject({
    form: z.literal('structured'),
    fields: z.record(z.string().regex(payloadFieldKeyPattern), CanonicalJsonValueSchema)
  })
  .superRefine((payload, context) => {
    if (Object.keys(payload.fields).length < 1) {
      addIssue(context, ['fields'], 'structured payload must carry at least one field');
    }
  });

/**
 * The payload of a record whose content has been removed. Deletion must remain
 * REPRESENTABLE in the schema — a purged record keeps ordering and tombstone
 * metadata so the reducer cannot resurrect it, and carries no content at all.
 */
export const MemoryRedactedPayloadSchema = z.strictObject({
  form: z.literal('redacted'),
  redactionReason: z.enum(['privacy_erasure', 'poisoned_source', 'legal_order', 'sensitivity'])
});

export const MemoryPayloadCanonicalSchema = z.discriminatedUnion('form', [
  MemoryClaimTriplePayloadSchema,
  MemoryStructuredPayloadSchema,
  MemoryRedactedPayloadSchema
]);

export const MemoryEvidenceRefSchema = z.strictObject({
  type: z.enum([
    'episode_revision',
    'memory_revision',
    'artifact',
    'source_event',
    'external_document'
  ]),
  id: z.string().regex(evidenceIdPattern)
});

/**
 * Derivation method is a closed enum, not free text: replay determinism depends
 * on the reducer branching identically on it forever, and an unrecognised method
 * must fail closed rather than fall through to a default.
 */
export const MemoryDerivationMethodSchema = z.enum([
  'explicit_operator_statement',
  'direct_observation',
  'tool_result',
  'episode_extraction',
  'episode_extraction_plus_operator_review',
  'human_authored_artifact_plus_operator_approval',
  'operator_reviewed_bundle_promotion',
  'statistical_aggregation',
  'agent_inference',
  'legacy_import'
]);

/** Retention CLASSES, not durations — the reducer must not parse policy from strings. */
export const MemoryRetentionPolicySchema = z.enum([
  'run_local',
  'retain_until_revoked',
  'until_superseded',
  'until_replaced',
  'until_superseded_or_revoked',
  'project_90d_then_review',
  'legal_retention'
]);

/**
 * The minimal non-content marker left behind by a logical delete. It exists so
 * the reducer keeps ordering and cannot resurrect a deleted thread, and so the
 * purge pipeline has a durable place to record which ticket authorised the
 * erasure. It never holds payload content.
 */
export const MemoryTombstoneSchema = z.strictObject({
  reason: z.enum([
    'operator_delete',
    'privacy_erasure',
    'poisoned_source',
    'retention_expiry',
    'legal_order'
  ]),
  ticketId: z.string().regex(deleteTicketPattern),
  purgeState: z.enum(['pending', 'scheduled', 'purged']),
  recordedAt: z.iso.datetime()
});

const SLEEVE_PREFIX_TO_CLASS: Readonly<Record<string, MemorySleeveKind>> = {
  personal: 'personal',
  agency: 'agency',
  task_market: 'task_market',
  company: 'company',
  client: 'client',
  project: 'project',
  shared: 'shared_approved',
  agent: 'agent_scratch'
};

/** The sleeve class implied by a sleeve id, or `null` when the id has no known root. */
export function sleeveClassForSleeveId(sleeveId: string): MemorySleeveKind | null {
  const separator = sleeveId.indexOf(':');
  if (separator < 1) return null;
  return SLEEVE_PREFIX_TO_CLASS[sleeveId.slice(0, separator)] ?? null;
}

/** Lifecycle states in which a tombstone must be present, and only those. */
const DELETION_STATES = ['deleted_logical', 'purge_scheduled', 'purged'] as const;

const PURGE_STATE_BY_LIFECYCLE: Readonly<
  Record<(typeof DELETION_STATES)[number], 'pending' | 'scheduled' | 'purged'>
> = {
  deleted_logical: 'pending',
  purge_scheduled: 'scheduled',
  purged: 'purged'
};

/** Review states that assert a human or policy decision was actually taken. */
const DECIDED_APPROVAL_STATES = ['reviewed', 'approved', 'rejected'] as const;

const MemoryRevisionBaseSchema = z.strictObject({
  // --- Identity and scope ---------------------------------------------------
  schemaVersion: MemoryRecordSchemaVersionSchema,
  recordType: MemoryRecordTypeSchema,
  memoryId: MemoryIdSchema,
  revisionId: MemoryRevisionIdSchema,
  revisionNo: z.number().int().min(1).max(2_147_483_647),
  /**
   * The owning control scope. Not in the report's JSON sketch, which writes bare
   * sleeve names; this repo's sleeves are always owned by a registered scope and
   * every fail-closed check downstream keys on that pair, so it is carried
   * explicitly rather than re-derived.
   */
  ownerScopeId: ControlScopeIdSchema,
  sleeveId: MemorySleeveIdSchema,
  sleeveClass: MemorySleeveKindSchema,
  kind: MemoryKindSchema,
  /** Deterministic dedupe anchor within a sleeve, e.g. `launch/date`. */
  entityKey: MemoryEntityKeySchema.nullable(),

  // --- Authority and acceptance ---------------------------------------------
  status: MemoryLifecycleStateSchema,
  approvalState: MemoryApprovalStateSchema,
  authorityTier: AuthorityTierSchema,
  confidencePermille: z.number().int().min(0).max(1_000),
  sensitivity: AccessSensitivitySchema,
  retentionPolicy: MemoryRetentionPolicySchema,
  legalHold: z.boolean(),

  // --- Bitemporal core ------------------------------------------------------
  /** When the real-world event happened, if known. May be in the future: plans are facts too. */
  eventTime: z.iso.datetime().nullable(),
  /** When a source or agent observed or extracted it. */
  observedAt: z.iso.datetime(),
  /** When the system ACCEPTED this revision into the ledger (transaction time). */
  createdTxTime: z.iso.datetime(),
  /** Total order within the sleeve's ledger partition. */
  recordedTxSeq: z.number().int().min(1).max(9_007_199_254_740_991),
  /** Start of the interval in which the assertion is true in modeled reality (valid time). */
  validFrom: z.iso.datetime(),
  /** End of that interval; `null` means open-ended, not "unknown". */
  validUntil: z.iso.datetime().nullable(),
  /** When an operator or policy approved, rejected, or reclassified it. */
  decidedAt: z.iso.datetime().nullable(),

  // --- Provenance -----------------------------------------------------------
  authorAgentId: AccessAgentIdSchema,
  workflowId: z.string().regex(workflowIdPattern).nullable(),
  runId: z.string().regex(runIdPattern).nullable(),
  derivationMethod: MemoryDerivationMethodSchema,
  sourceEventIds: z.array(MemorySourceEventIdSchema).max(64),
  evidenceRefs: z.array(MemoryEvidenceRefSchema).max(64),
  derivedFrom: z.array(MemoryIdSchema).max(64),
  /** Revisions this one is known to contradict. Symmetric in the conflict graph. */
  contradicts: z.array(MemoryRevisionIdSchema).max(64),
  supersedes: MemoryRevisionIdSchema.nullable(),
  supersededBy: MemoryRevisionIdSchema.nullable(),

  // --- Payload and integrity ------------------------------------------------
  payloadCanonical: MemoryPayloadCanonicalSchema,
  contentHash: MemoryDigestSchema,
  canonicalHash: MemoryDigestSchema,
  tombstone: MemoryTombstoneSchema.nullable()
});

/**
 * The canonical `memrec/v1` revision, with every cross-field invariant the
 * reducer would otherwise have to re-check by hand.
 *
 * Deliberately NOT enforced:
 *   * `eventTime` vs `createdTxTime` — retroactive corrections and proactive
 *     facts (a launch date three months out) are both legitimate, so the event
 *     axis is free relative to the transaction axis.
 *   * `validFrom` vs `createdTxTime` — same reason; backdated and future-dated
 *     validity intervals are the whole point of keeping the axes separate.
 */
export const MemoryRevisionSchema = MemoryRevisionBaseSchema.superRefine((revision, context) => {
  // --- Temporal invariants --------------------------------------------------
  if (
    revision.validUntil !== null &&
    Date.parse(revision.validUntil) <= Date.parse(revision.validFrom)
  ) {
    addIssue(context, ['validUntil'], 'validUntil must be later than validFrom');
  }
  if (Date.parse(revision.observedAt) > Date.parse(revision.createdTxTime)) {
    addIssue(context, ['observedAt'], 'observation cannot follow ledger acceptance');
  }
  if (
    revision.decidedAt !== null &&
    Date.parse(revision.decidedAt) > Date.parse(revision.createdTxTime)
  ) {
    addIssue(context, ['decidedAt'], 'decision cannot follow ledger acceptance');
  }
  // A decision timestamp and a decided review state must agree in both
  // directions, so "who vouched, and when" can never be half-recorded.
  const claimsDecision = DECIDED_APPROVAL_STATES.some((state) => state === revision.approvalState);
  if (claimsDecision && revision.decidedAt === null) {
    addIssue(
      context,
      ['decidedAt'],
      `approvalState '${revision.approvalState}' requires decidedAt`
    );
  }
  if (!claimsDecision && revision.decidedAt !== null) {
    addIssue(
      context,
      ['decidedAt'],
      `approvalState '${revision.approvalState}' must not carry decidedAt`
    );
  }

  // --- Identity and scope ---------------------------------------------------
  const impliedClass = sleeveClassForSleeveId(revision.sleeveId);
  if (impliedClass !== revision.sleeveClass) {
    addIssue(context, ['sleeveClass'], 'sleeveClass must be derived from the sleeve root');
  }
  if (revision.revisionNo === 1 && revision.supersedes !== null) {
    addIssue(context, ['supersedes'], 'the first revision of a memory thread supersedes nothing');
  }

  // --- Link hygiene ---------------------------------------------------------
  if (revision.supersedes === revision.revisionId) {
    addIssue(context, ['supersedes'], 'a revision cannot supersede itself');
  }
  if (revision.supersededBy === revision.revisionId) {
    addIssue(context, ['supersededBy'], 'a revision cannot be superseded by itself');
  }
  if (revision.contradicts.includes(revision.revisionId)) {
    addIssue(context, ['contradicts'], 'a revision cannot contradict itself');
  }
  if (revision.derivedFrom.includes(revision.memoryId)) {
    addIssue(context, ['derivedFrom'], 'a memory thread cannot be derived from itself');
  }
  if (hasDuplicates(revision.contradicts)) {
    addIssue(context, ['contradicts'], 'contradicts entries must be unique');
  }
  if (hasDuplicates(revision.derivedFrom)) {
    addIssue(context, ['derivedFrom'], 'derivedFrom entries must be unique');
  }
  if (hasDuplicates(revision.sourceEventIds)) {
    addIssue(context, ['sourceEventIds'], 'sourceEventIds entries must be unique');
  }
  if (hasDuplicates(revision.evidenceRefs.map((ref) => `${ref.type}:${ref.id}`))) {
    addIssue(context, ['evidenceRefs'], 'evidenceRefs entries must be unique');
  }

  // --- Lifecycle / review coherence -----------------------------------------
  if (!isReviewCompatible(revision.status, revision.approvalState)) {
    addIssue(
      context,
      ['approvalState'],
      `approvalState '${revision.approvalState}' is incoherent with status '${revision.status}'`
    );
  }
  // `active_conflicted` is a FLAGGED RELATION: the flag is meaningless without
  // the contradictory link it names, so the schema refuses a bare flag.
  if (revision.status === 'active_conflicted' && revision.contradicts.length === 0) {
    addIssue(
      context,
      ['contradicts'],
      'active_conflicted requires at least one contradiction link'
    );
  }
  if (
    revision.supersededBy !== null &&
    (revision.status === 'active' || revision.status === 'active_conflicted')
  ) {
    addIssue(context, ['status'], 'a superseded revision cannot remain active');
  }

  // --- Deletion, purge, and legal hold --------------------------------------
  const deletionState = DELETION_STATES.find((state) => state === revision.status);
  if (deletionState === undefined && revision.tombstone !== null) {
    addIssue(context, ['tombstone'], 'only a deleted revision may carry a tombstone');
  }
  if (deletionState !== undefined && revision.tombstone === null) {
    addIssue(context, ['tombstone'], `status '${revision.status}' requires a tombstone`);
  }
  if (
    deletionState !== undefined &&
    revision.tombstone !== null &&
    revision.tombstone.purgeState !== PURGE_STATE_BY_LIFECYCLE[deletionState]
  ) {
    addIssue(context, ['tombstone', 'purgeState'], 'tombstone purge state disagrees with status');
  }
  // Purged records may retain tombstone metadata only, never payload content.
  if (revision.status === 'purged' && revision.payloadCanonical.form !== 'redacted') {
    addIssue(context, ['payloadCanonical'], 'a purged revision must carry a redacted payload');
  }
  if (revision.payloadCanonical.form === 'redacted' && deletionState === undefined) {
    addIssue(context, ['payloadCanonical'], 'only a deleted revision may carry a redacted payload');
  }
  // Legal hold blocks purge outright — the DELETE command's documented failure mode.
  if (revision.legalHold && revision.status === 'purged') {
    addIssue(context, ['status'], 'legal hold blocks purge');
  }

  // --- Evidence obligation --------------------------------------------------
  // "Every derived semantic or procedural memory must have at least one readable
  // evidence reference unless it is operator-authored explicit policy." Without
  // this, an agent inference can assert a durable fact with nothing behind it.
  const storeClass = storeClassForKind(revision.kind);
  const operatorAuthored =
    revision.authorityTier === 'operator_explicit' ||
    revision.authorityTier === 'policy_signed_approved';
  if (
    (storeClass === 'semantic' || storeClass === 'procedural') &&
    !operatorAuthored &&
    revision.evidenceRefs.length === 0 &&
    revision.sourceEventIds.length === 0
  ) {
    addIssue(
      context,
      ['evidenceRefs'],
      `a derived ${storeClass} memory requires at least one evidence reference`
    );
  }
});

export type MemoryClaimTriplePayload = z.infer<typeof MemoryClaimTriplePayloadSchema>;
export type MemoryStructuredPayload = z.infer<typeof MemoryStructuredPayloadSchema>;
export type MemoryRedactedPayload = z.infer<typeof MemoryRedactedPayloadSchema>;
export type MemoryPayloadCanonical = z.infer<typeof MemoryPayloadCanonicalSchema>;
export type MemoryEvidenceRef = z.infer<typeof MemoryEvidenceRefSchema>;
export type MemoryDerivationMethod = z.infer<typeof MemoryDerivationMethodSchema>;
export type MemoryRetentionPolicy = z.infer<typeof MemoryRetentionPolicySchema>;
export type MemoryTombstone = z.infer<typeof MemoryTombstoneSchema>;
export type MemoryRevision = z.infer<typeof MemoryRevisionSchema>;
