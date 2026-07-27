import type { z } from 'zod';

import type {
  MemoryFragmentId,
  MemoryFragmentRecord,
  RetrievalOmissionReason
} from '../../knowledge/retrieval-contracts';
import { AppError } from '../../utils/errors';
import type { MemoryTemporalStateSchema } from './contracts';
import { sha256 } from './hashing';
import { MEMORY_STORE_POLICIES, storeClassForKind, type MemoryKind } from './store-classes';

/**
 * Version stamp for the temporal policy. Kept separate from the audited manifest's
 * `algorithm` field, which still describes how the candidates were *found*.
 */
export const TEMPORAL_RETRIEVAL_POLICY_VERSION = 'temporal_retrieval_v1' as const;

/** Raised when the temporal pass is handed input it cannot decide deterministically. */
export class TemporalRetrievalError extends AppError {
  constructor(message: string) {
    super(422, 'MEMORY_TEMPORAL_RETRIEVAL_INVALID', message);
  }
}

export type TemporalState = z.infer<typeof MemoryTemporalStateSchema>;

/**
 * `current`  — retrieve and present as true now.
 * `as_of`    — reconstruct what was valid at an arbitrary past instant. Supersession
 *              links are NOT suppressors here: the superseded revision is precisely
 *              the right answer for a time before its successor took effect.
 */
export type TemporalRetrievalMode = 'current' | 'as_of';

/**
 * Why an item was withheld. Richer than the six-value `RetrievalOmissionReason` the
 * retrieval contract exposes, because the contract has no word for the A-TMA
 * "ghost memory" case. Nothing is lost: {@link TEMPORAL_OMISSION_REASONS} maps each
 * value onto the contract vocabulary for the audited manifest, and the full reason
 * travels in the temporal plan alongside it.
 */
export type TemporalSuppressionReason =
  | 'superseded_link'
  | 'ghost_revision'
  | 'validity_ended'
  | 'not_yet_valid'
  | 'expired'
  | 'retrieval_disabled';

/**
 * Projection onto the audited manifest's closed reason set. `ghost_revision` maps to
 * `superseded` because that is what it factually is — an older revision displaced by
 * a newer one — the only difference being that no supersession link was ever recorded.
 */
export const TEMPORAL_OMISSION_REASONS: Readonly<
  Record<TemporalSuppressionReason, RetrievalOmissionReason>
> = {
  superseded_link: 'superseded',
  ghost_revision: 'superseded',
  validity_ended: 'validity_ended',
  not_yet_valid: 'not_yet_valid',
  expired: 'expired',
  retrieval_disabled: 'retrieval_disabled'
};

/**
 * The temporal facts of a fragment. A structural `Pick` of {@link MemoryFragmentRecord}
 * so a real record passes through unchanged, and so this module provably cannot read
 * content, sensitivity, or scope — a temporal decision must not depend on any of them.
 */
export type TemporalFragmentView = Pick<
  MemoryFragmentRecord,
  | 'id'
  | 'kind'
  | 'title'
  | 'validFrom'
  | 'validUntil'
  | 'recordedAt'
  | 'expiresAt'
  | 'supersedesFragmentId'
  | 'supersededByFragmentId'
  | 'retrievalEligible'
>;

export interface TemporalRetrievalInput {
  readonly mode: TemporalRetrievalMode;
  /** Always explicit. This module never reads a clock. */
  readonly queryTime: string;
  /** Candidates in the order the caller wants retained items presented. */
  readonly candidates: readonly TemporalFragmentView[];
}

export interface TemporalDecision {
  readonly fragmentId: MemoryFragmentId;
  readonly entityKey: string;
  readonly state: TemporalState;
  readonly retained: boolean;
  readonly suppressionReason: TemporalSuppressionReason | null;
  /** The revision that displaced this one, when one was identified. */
  readonly displacedByFragmentId: MemoryFragmentId | null;
}

export interface GhostRevisionPair {
  readonly entityKey: string;
  /** The revision that is current at `queryTime` and is retained. */
  readonly currentFragmentId: MemoryFragmentId;
  /** The older revision that would otherwise have been presented as current. */
  readonly ghostFragmentId: MemoryFragmentId;
  /**
   * `supersession_link` — an explicit supersedes/superseded-by edge joins the pair.
   * `entity_revision`   — no edge exists; the pair was inferred from a shared entity key.
   */
  readonly detectedBy: 'supersession_link' | 'entity_revision';
}

export interface TemporalRetrievalPlan {
  readonly policyVersion: typeof TEMPORAL_RETRIEVAL_POLICY_VERSION;
  readonly mode: TemporalRetrievalMode;
  readonly queryTime: string;
  /** One decision per candidate, sorted by fragment id so the fingerprint is order-free. */
  readonly decisions: readonly TemporalDecision[];
  /** Survivors, in the caller's candidate order. Ranking stays the caller's concern. */
  readonly retainedFragmentIds: readonly MemoryFragmentId[];
  readonly ghostPairs: readonly GhostRevisionPair[];
  readonly fingerprint: string;
}

function instantOf(iso: string, label: string): number {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    throw new TemporalRetrievalError(`${label} is not a parsable ISO-8601 instant`);
  }
  return parsed;
}

/** Codepoint order, not `localeCompare`: collation must not drift with the host's ICU build. */
function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

const DIACRITIC_PATTERN = /\p{Diacritic}/gu;
const NON_ALPHANUMERIC_PATTERN = /[^\p{L}\p{N}]+/gu;

/**
 * Deterministic identity for "the same thing this fragment is about".
 *
 * Jarvis has no subject/predicate graph, so the strongest entity signal available on
 * a fragment record is its (kind, canonical title) pair. That is deliberately
 * conservative: renaming a fact or re-filing it under a different kind mints a NEW
 * entity, so the ghost rule under-detects rather than over-suppresses. Under-detection
 * degrades to today's flat behaviour; over-suppression would delete a valid answer.
 */
export function entityKeyForFragment(fragment: TemporalFragmentView): string {
  const canonicalTitle = fragment.title
    .normalize('NFD')
    .replace(DIACRITIC_PATTERN, '')
    .toLocaleLowerCase('en-US')
    .replace(NON_ALPHANUMERIC_PATTERN, ' ')
    .trim();
  return `${fragment.kind}:${canonicalTitle}`;
}

/**
 * Whether two live fragments sharing an entity key are revisions of one another.
 *
 * Only the supersede-based stores qualify. The episodic store is an
 * `append_only_ledger`: two episodes titled "Weekly sync" are two real events, not a
 * revision pair, and suppressing one would destroy exactly the raw evidence the
 * research says specialists must keep. Semantic (`curated_supersede`) and procedural
 * (`validated_supersede`) items, by their own write rule, are revised only by
 * supersession — so two live items with the same canonical name ARE a supersession
 * that was never recorded.
 */
export function supportsRevisionCollapse(kind: MemoryKind): boolean {
  return MEMORY_STORE_POLICIES[storeClassForKind(kind)].writeRule !== 'append_only_ledger';
}

/**
 * The temporal state of one fragment at one instant, derived only from
 * `validFrom` / `validUntil` / `supersededByFragmentId` / `expiresAt`.
 *
 *   historical   — its validity has definitively ended: superseded, past `validUntil`,
 *                  or past `expiresAt`. It describes what WAS true.
 *   transitional — not yet in force (`validFrom` in the future), or in force but with a
 *                  known end already on the calendar (`validUntil` set and still ahead).
 *                  This is the state an assistant must hedge on rather than assert.
 *   current      — in force with no scheduled end and no successor.
 *
 * Report 3's point is that this label is the thing missing from flat stores, and that
 * missing time semantics — not missing graph edges — cause most assistant failures.
 * The label is computed, never stored, so it can never go stale.
 */
export function temporalStateAt(fragment: TemporalFragmentView, queryTime: string): TemporalState {
  const now = instantOf(queryTime, 'queryTime');
  if (fragment.supersededByFragmentId !== null) return 'historical';
  if (fragment.expiresAt !== null && instantOf(fragment.expiresAt, 'expiresAt') <= now) {
    return 'historical';
  }
  if (fragment.validUntil !== null && instantOf(fragment.validUntil, 'validUntil') <= now) {
    return 'historical';
  }
  if (instantOf(fragment.validFrom, 'validFrom') > now) return 'transitional';
  if (fragment.validUntil !== null) return 'transitional';
  return 'current';
}

interface IntrinsicSuppression {
  readonly reason: TemporalSuppressionReason;
  readonly displacedByFragmentId: MemoryFragmentId | null;
}

/**
 * Per-item suppression, evaluated without looking at siblings.
 *
 * Reason precedence mirrors `omissionReason()` in the audited lexical retrieval
 * service exactly, so the same withheld fragment is explained the same way whichever
 * layer withheld it. In `as_of` mode the supersession checks are skipped: asking what
 * was true in March must be allowed to answer with the revision that March had.
 */
function intrinsicSuppression(
  fragment: TemporalFragmentView,
  successorInCandidateSet: MemoryFragmentId | null,
  mode: TemporalRetrievalMode,
  now: number
): IntrinsicSuppression | null {
  if (mode === 'current') {
    if (fragment.supersededByFragmentId !== null) {
      return {
        reason: 'superseded_link',
        displacedByFragmentId: fragment.supersededByFragmentId
      };
    }
    if (successorInCandidateSet !== null) {
      return { reason: 'superseded_link', displacedByFragmentId: successorInCandidateSet };
    }
  }
  if (!fragment.retrievalEligible) {
    return { reason: 'retrieval_disabled', displacedByFragmentId: null };
  }
  if (fragment.expiresAt !== null && instantOf(fragment.expiresAt, 'expiresAt') <= now) {
    return { reason: 'expired', displacedByFragmentId: null };
  }
  if (instantOf(fragment.validFrom, 'validFrom') > now) {
    return { reason: 'not_yet_valid', displacedByFragmentId: null };
  }
  if (fragment.validUntil !== null && instantOf(fragment.validUntil, 'validUntil') <= now) {
    return { reason: 'validity_ended', displacedByFragmentId: null };
  }
  return null;
}

/**
 * The temporal layer. Pure, deterministic, and suppression-only: it partitions the
 * candidates it is handed into retained and withheld, and can never add one. Every
 * withheld item carries an explicit reason, so nothing is ever silently dropped.
 *
 * Two passes:
 *   1. Intrinsic — validity window, retention expiry, operator withdrawal, and
 *      recorded supersession, each judged against `queryTime` alone.
 *   2. Ghost defense — the A-TMA failure mode. When a current revision and an older
 *      revision of the SAME entity both survive pass 1, the older one would be handed
 *      to the model as though it were still true. Within each entity group the newest
 *      revision by (validFrom desc, recordedAt desc, id asc) is kept and every other
 *      member is relabelled `historical` and withheld as `ghost_revision`, with the
 *      pair recorded so an operator can see what was collapsed and why. The group
 *      always keeps a member, so this rule can shrink a group but never empty one.
 */
export function planTemporalRetrieval(input: TemporalRetrievalInput): TemporalRetrievalPlan {
  const now = instantOf(input.queryTime, 'queryTime');

  const byId = new Map<string, TemporalFragmentView>();
  for (const candidate of input.candidates) {
    if (byId.has(candidate.id)) {
      throw new TemporalRetrievalError(
        `Temporal candidate '${candidate.id}' appears twice; suppression would be ambiguous`
      );
    }
    byId.set(candidate.id, candidate);
  }

  // Forward supersession edges declared by a sibling candidate. The write path also
  // sets the back-link, but a fragment written through any other path may not have
  // one; honouring the forward edge means a recorded supersession is never missed.
  const successorOf = new Map<string, string>();
  for (const candidate of input.candidates) {
    const priorId = candidate.supersedesFragmentId;
    if (priorId === null || !byId.has(priorId)) continue;
    const known = successorOf.get(priorId);
    if (known === undefined || compareIds(candidate.id, known) < 0) {
      successorOf.set(priorId, candidate.id);
    }
  }

  const suppression = new Map<string, IntrinsicSuppression>();
  const survivors: TemporalFragmentView[] = [];
  for (const candidate of input.candidates) {
    const intrinsic = intrinsicSuppression(
      candidate,
      successorOf.get(candidate.id) ?? null,
      input.mode,
      now
    );
    if (intrinsic === null) {
      survivors.push(candidate);
    } else {
      suppression.set(candidate.id, intrinsic);
    }
  }

  // --- Pass 2: ghost-memory defense ----------------------------------------
  const groups = new Map<string, TemporalFragmentView[]>();
  for (const survivor of survivors) {
    if (!supportsRevisionCollapse(survivor.kind)) continue;
    const key = entityKeyForFragment(survivor);
    const bucket = groups.get(key) ?? [];
    bucket.push(survivor);
    groups.set(key, bucket);
  }

  const ghostPairs: GhostRevisionPair[] = [];
  for (const key of [...groups.keys()].sort(compareIds)) {
    const bucket = groups.get(key);
    if (bucket === undefined || bucket.length < 2) continue;
    const ordered = bucket
      .slice()
      .sort(
        (left, right) =>
          instantOf(right.validFrom, 'validFrom') - instantOf(left.validFrom, 'validFrom') ||
          instantOf(right.recordedAt, 'recordedAt') - instantOf(left.recordedAt, 'recordedAt') ||
          compareIds(left.id, right.id)
      );
    const head = ordered[0];
    if (head === undefined) continue;
    for (const ghost of ordered.slice(1)) {
      suppression.set(ghost.id, {
        reason: 'ghost_revision',
        displacedByFragmentId: head.id
      });
      ghostPairs.push({
        entityKey: key,
        currentFragmentId: head.id,
        ghostFragmentId: ghost.id,
        detectedBy: 'entity_revision'
      });
    }
  }

  // A recorded supersession whose successor is also retrievable is the same failure
  // mode caught one step earlier; surface it as a pair too so operators see the whole
  // set of collapsed revisions, not only the unlinked ones.
  for (const candidate of input.candidates) {
    const intrinsic = suppression.get(candidate.id);
    if (intrinsic === undefined || intrinsic.reason !== 'superseded_link') continue;
    const successorId = intrinsic.displacedByFragmentId;
    if (successorId === null || suppression.has(successorId) || !byId.has(successorId)) continue;
    ghostPairs.push({
      entityKey: entityKeyForFragment(candidate),
      currentFragmentId: successorId,
      ghostFragmentId: candidate.id,
      detectedBy: 'supersession_link'
    });
  }
  ghostPairs.sort(
    (left, right) =>
      compareIds(left.entityKey, right.entityKey) ||
      compareIds(left.ghostFragmentId, right.ghostFragmentId)
  );

  const decisions: TemporalDecision[] = input.candidates
    .map((candidate) => {
      const intrinsic = suppression.get(candidate.id) ?? null;
      const state =
        intrinsic !== null && intrinsic.reason === 'ghost_revision'
          ? 'historical'
          : temporalStateAt(candidate, input.queryTime);
      return {
        fragmentId: candidate.id,
        entityKey: entityKeyForFragment(candidate),
        state,
        retained: intrinsic === null,
        suppressionReason: intrinsic === null ? null : intrinsic.reason,
        displacedByFragmentId: intrinsic === null ? null : intrinsic.displacedByFragmentId
      };
    })
    .sort((left, right) => compareIds(left.fragmentId, right.fragmentId));

  const retainedFragmentIds = input.candidates
    .filter((candidate) => !suppression.has(candidate.id))
    .map((candidate) => candidate.id);

  const fingerprint = sha256(
    JSON.stringify({
      policyVersion: TEMPORAL_RETRIEVAL_POLICY_VERSION,
      mode: input.mode,
      queryTime: input.queryTime,
      decisions,
      ghostPairs
    })
  );

  return {
    policyVersion: TEMPORAL_RETRIEVAL_POLICY_VERSION,
    mode: input.mode,
    queryTime: input.queryTime,
    decisions,
    retainedFragmentIds,
    ghostPairs,
    fingerprint
  };
}
