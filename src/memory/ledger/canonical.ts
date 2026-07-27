import { AppError } from '../../utils/errors';
import { sha256 } from '../system/hashing';
import type { MemoryPayloadCanonical, MemoryRevision } from './record-contracts';

/**
 * Deterministic canonical serialization, modelled on Avro's parsing canonical
 * form: strip everything that does not change meaning, fix an order for
 * everything that remains, and refuse anything whose textual form is ambiguous.
 *
 * The ledger's whole value proposition — "replaying the same ordered ledger
 * twice must produce bit-identical canonical projections and hashes" — reduces
 * to this function being total, order-stable, and environment-independent.
 */

/** Raised when a value cannot be represented in the canonical form. Fail closed, never coerce. */
export class MemoryCanonicalFormError extends AppError {
  constructor(
    readonly kind: 'unsupported_type' | 'ambiguous_number' | 'undefined_value' | 'depth_exceeded',
    message: string
  ) {
    super(422, 'MEMORY_CANONICAL_FORM_INVALID', message);
  }
}

/** Raised when a revision's stored digests disagree with its content. */
export class MemoryRevisionIntegrityError extends AppError {
  constructor(
    readonly field: 'contentHash' | 'canonicalHash',
    readonly revisionId: string
  ) {
    super(
      409,
      'MEMORY_REVISION_INTEGRITY_INVALID',
      `Revision '${revisionId}' has a stale or forged ${field}`
    );
  }
}

/**
 * Bounded recursion. An unbounded canonicalizer is a denial-of-service surface
 * on a write path that accepts agent-authored payloads, and no legitimate memory
 * claim nests this deeply.
 */
const MAX_CANONICAL_DEPTH = 32;

/**
 * UTF-16 code-unit order. `localeCompare` is locale- and ICU-version-dependent,
 * so it can reorder keys between machines and silently change a hash; `<` on
 * JavaScript strings is a fixed code-unit comparison and cannot.
 */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Only exact integers are representable. A double has several correct textual
 * forms and different runtimes round differently, so admitting `0.1` would make
 * the canonical hash depend on the machine that produced it.
 */
function writeNumber(value: number): string {
  if (!Number.isInteger(value)) {
    throw new MemoryCanonicalFormError(
      'ambiguous_number',
      'Canonical form admits only integers; use fixed-point units (e.g. permille)'
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new MemoryCanonicalFormError(
      'ambiguous_number',
      'Canonical form admits only integers within the exact-representation range'
    );
  }
  // `-0` and `0` are the same value but stringify differently; collapse to one form.
  return Object.is(value, -0) ? '0' : String(value);
}

function writeCanonical(value: unknown, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new MemoryCanonicalFormError(
      'depth_exceeded',
      `Canonical form exceeds the maximum nesting depth of ${MAX_CANONICAL_DEPTH}`
    );
  }
  // Explicit null handling: `null` is a VALUE in the canonical form (an
  // open-ended `validUntil` means something), while `undefined` is a hole. They
  // must never collapse into each other, because dropping a key and setting it
  // to null are different records that would otherwise hash alike.
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return writeNumber(value);
    case 'undefined':
      throw new MemoryCanonicalFormError(
        'undefined_value',
        'Canonical form has no encoding for undefined; use null'
      );
    case 'object':
      break;
    default:
      throw new MemoryCanonicalFormError(
        'unsupported_type',
        `Canonical form has no encoding for '${typeof value}'`
      );
  }

  if (Array.isArray(value)) {
    // Array order IS meaning (procedure steps), so arrays are never reordered.
    const items: unknown[] = value;
    return `[${items.map((item) => writeCanonical(item, depth + 1)).join(',')}]`;
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MemoryCanonicalFormError(
      'unsupported_type',
      'Canonical form accepts only plain objects; convert dates and class instances first'
    );
  }
  const record = value as Record<string, unknown>;
  if (Object.getOwnPropertySymbols(record).length > 0) {
    throw new MemoryCanonicalFormError(
      'unsupported_type',
      'Canonical form has no encoding for symbol keys'
    );
  }
  const keys = Object.keys(record).sort(compareCodeUnits);
  const members = keys.map((key) => {
    const entry = record[key];
    if (entry === undefined) {
      throw new MemoryCanonicalFormError(
        'undefined_value',
        `Canonical form has no encoding for undefined at key '${key}'`
      );
    }
    return `${JSON.stringify(key)}:${writeCanonical(entry, depth + 1)}`;
  });
  return `{${members.join(',')}}`;
}

/**
 * The canonical string for any admissible value. Key order is normalized;
 * array order, null, and every scalar value are preserved exactly.
 */
export function canonicalize(value: unknown): string {
  return writeCanonical(value, 0);
}

function digest(canonicalForm: string): string {
  return `sha256:${sha256(canonicalForm)}`;
}

/**
 * Digest of the CLAIM alone. This is the dedupe and idempotency anchor: two
 * revisions asserting the same thing share a content hash even though their
 * revision ids, timestamps, and approval history differ.
 */
export function contentHash(payload: MemoryPayloadCanonical): string {
  return digest(canonicalize(payload));
}

/**
 * The identity-bearing fields — the ones that decide WHAT this revision asserts,
 * WHERE it applies, and WHEN it is true.
 *
 * Everything else is acceptance metadata that the report's `UPDATE` command is
 * explicitly allowed to change without altering the asserted claim: `status`,
 * `approvalState`, `decidedAt`, `confidencePermille`, `sensitivity`,
 * `retentionPolicy`, `legalHold`, `contradicts`, `supersededBy`, `tombstone`,
 * and the evidence list. Including them would make the canonical hash churn on
 * every re-approval and destroy its use as a projection-rebuild check.
 */
export const CANONICAL_IDENTITY_FIELDS = [
  'schemaVersion',
  'recordType',
  'memoryId',
  'revisionId',
  'revisionNo',
  'ownerScopeId',
  'sleeveId',
  'sleeveClass',
  'kind',
  'entityKey',
  'eventTime',
  'observedAt',
  'createdTxTime',
  'recordedTxSeq',
  'validFrom',
  'validUntil',
  'authorityTier',
  'authorAgentId',
  'derivationMethod',
  'supersedes',
  'derivedFrom',
  'sourceEventIds',
  'contentHash'
] as const;

/**
 * The canonical string of a revision's identity. `derivedFrom` and
 * `sourceEventIds` are SET-valued, so they are sorted before hashing; the
 * payload enters through its own content hash, which keeps the two-level
 * structure the report describes (claim digest, then revision digest).
 */
export function canonicalRevisionForm(revision: MemoryRevision): string {
  return canonicalize({
    schemaVersion: revision.schemaVersion,
    recordType: revision.recordType,
    memoryId: revision.memoryId,
    revisionId: revision.revisionId,
    revisionNo: revision.revisionNo,
    ownerScopeId: revision.ownerScopeId,
    sleeveId: revision.sleeveId,
    sleeveClass: revision.sleeveClass,
    kind: revision.kind,
    entityKey: revision.entityKey,
    eventTime: revision.eventTime,
    observedAt: revision.observedAt,
    createdTxTime: revision.createdTxTime,
    recordedTxSeq: revision.recordedTxSeq,
    validFrom: revision.validFrom,
    validUntil: revision.validUntil,
    authorityTier: revision.authorityTier,
    authorAgentId: revision.authorAgentId,
    derivationMethod: revision.derivationMethod,
    supersedes: revision.supersedes,
    derivedFrom: [...revision.derivedFrom].sort(compareCodeUnits),
    sourceEventIds: [...revision.sourceEventIds].sort(compareCodeUnits),
    contentHash: contentHash(revision.payloadCanonical)
  });
}

/** Tamper-evident digest over the identity-bearing fields only. */
export function canonicalHash(revision: MemoryRevision): string {
  return digest(canonicalRevisionForm(revision));
}

/**
 * Fail-closed integrity gate for anything read back from storage or replayed
 * from the ledger. A revision whose digests do not recompute is not a revision
 * the reducer may act on.
 */
export function verifyRevisionIntegrity(revision: MemoryRevision): void {
  if (contentHash(revision.payloadCanonical) !== revision.contentHash) {
    throw new MemoryRevisionIntegrityError('contentHash', revision.revisionId);
  }
  if (canonicalHash(revision) !== revision.canonicalHash) {
    throw new MemoryRevisionIntegrityError('canonicalHash', revision.revisionId);
  }
}
