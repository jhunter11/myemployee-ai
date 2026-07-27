import { z } from 'zod';

import { sha256 } from '../system/hashing';
import type { MemoryKind } from '../system/store-classes';
import { authorityRank } from './authority';
import { canonicalize } from './canonical';
import { isLiveClaim } from './lifecycle';
import {
  MemoryRevisionSchema,
  type MemoryClaimTriplePayload,
  type MemoryRevision
} from './record-contracts';

/**
 * The two-stage conflict algorithm.
 *
 * Stage one asks a question most systems skip: are these claims actually in
 * conflict? Two memories are contradictory only when the subject, the predicate,
 * the context, and the valid interval all line up AND the values are
 * incompatible. If any of those differ meaningfully, BOTH are preserved. That is
 * the default path, not an edge case — a client-level policy and a project-level
 * instruction can both be correct, and erasing one to make the store tidy is a
 * correctness bug dressed up as hygiene.
 *
 * Stage two applies precedence, and only then. Its conservatism is deliberate:
 * an authority tie on incompatible values produces a recorded conflict, never a
 * silent pick, because a silent pick is unauditable and unrecoverable.
 */

export const CONFLICT_OUTCOMES = [
  'select_one',
  'preserve_both',
  'mark_conflict',
  'ask_operator',
  'abstain',
  'narrow_context'
] as const;

export const ConflictOutcomeSchema = z.enum(CONFLICT_OUTCOMES);
export type ConflictOutcome = z.infer<typeof ConflictOutcomeSchema>;

export interface ConflictOutcomePolicy {
  readonly outcome: ConflictOutcome;
  /** Whether canonical state is decided. Unresolved outcomes force retrieval to abstain. */
  readonly resolved: boolean;
  /** Whether the reducer must write contradiction links and flag `active_conflicted`. */
  readonly flagsConflict: boolean;
  readonly description: string;
}

export const CONFLICT_OUTCOME_POLICIES: Readonly<Record<ConflictOutcome, ConflictOutcomePolicy>> = {
  select_one: {
    outcome: 'select_one',
    resolved: true,
    flagsConflict: false,
    description: 'Same context, one claim strictly outranks the other on the authority hierarchy.'
  },
  preserve_both: {
    outcome: 'preserve_both',
    resolved: true,
    flagsConflict: false,
    description: 'Contexts differ or intervals do not overlap; both claims remain true.'
  },
  narrow_context: {
    outcome: 'narrow_context',
    resolved: true,
    flagsConflict: false,
    description: 'One claim is a strict refinement of the other and wins only inside its context.'
  },
  mark_conflict: {
    outcome: 'mark_conflict',
    resolved: false,
    flagsConflict: true,
    description: 'Authority ties on incompatible values; both stay live but flagged.'
  },
  ask_operator: {
    outcome: 'ask_operator',
    resolved: false,
    flagsConflict: true,
    description: 'A tied conflict that governs future behavior and cannot be narrowed.'
  },
  abstain: {
    outcome: 'abstain',
    resolved: false,
    flagsConflict: true,
    description: 'An unresolved conflict is already active; the system refuses to answer.'
  }
};

/** Why a pair of claims does NOT compete, or that it does. Reported in evaluation order. */
export const CLAIM_COMPARISON_REASONS = [
  'competes',
  'same_revision',
  'same_memory_thread',
  'inactive_revision',
  'different_owner_scope',
  'different_sleeve',
  'different_entity_key',
  'non_comparable_payload',
  'different_subject',
  'different_predicate',
  'disjoint_context',
  'disjoint_valid_interval',
  'compatible_values'
] as const;

export const ClaimComparisonReasonSchema = z.enum(CLAIM_COMPARISON_REASONS);
export type ClaimComparisonReason = z.infer<typeof ClaimComparisonReasonSchema>;

/**
 * How two claim contexts relate. Context is carried by the payload's
 * `qualifiers`: more qualifiers means a narrower claim, so a strict superset is
 * a refinement of the other and a set that is neither equal nor nested describes
 * a different situation entirely.
 */
export const CONTEXT_RELATIONS = [
  'identical',
  'candidate_narrower',
  'existing_narrower',
  'disjoint',
  'not_applicable'
] as const;

export const ContextRelationSchema = z.enum(CONTEXT_RELATIONS);
export type ContextRelation = z.infer<typeof ContextRelationSchema>;

export interface ClaimComparison {
  readonly existingRevisionId: string;
  readonly competes: boolean;
  readonly reason: ClaimComparisonReason;
  readonly contextRelation: ContextRelation;
  /** Sign of `candidate` versus `existing` on the authority hierarchy. */
  readonly authorityComparison: -1 | 0 | 1;
}

export interface ConflictResolution {
  readonly outcome: ConflictOutcome;
  readonly candidateRevisionId: string;
  /** Stage-one verdict for every existing revision, sorted by revision id. */
  readonly comparisons: readonly ClaimComparison[];
  readonly competingRevisionIds: readonly string[];
  /** Existing revisions that stage one cleared: they stay, untouched. */
  readonly preservedRevisionIds: readonly string[];
  /** Set only when the outcome actually decides a winner. */
  readonly winnerRevisionId: string | null;
  /** Existing revisions the reducer must link as contradictions and flag. */
  readonly conflictedRevisionIds: readonly string[];
  readonly reason: string;
  readonly fingerprint: string;
}

/** Kinds that govern future behavior, so a tie on them is worth an operator's time. */
const BEHAVIOR_GOVERNING_KINDS: readonly MemoryKind[] = ['policy', 'procedure', 'blueprint'];

const ExistingRevisionSetSchema = z.array(MemoryRevisionSchema).max(256);

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function signOf(value: number): -1 | 0 | 1 {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

/**
 * Half-open interval overlap over `[validFrom, validUntil)`, with a null
 * `validUntil` meaning open-ended.
 *
 * Half-open is the load-bearing choice: intervals that merely TOUCH — one ends
 * at exactly the instant the next begins — do not overlap, so a clean handover
 * between successive facts never manufactures a conflict.
 */
export function intervalsOverlap(
  left: { readonly validFrom: string; readonly validUntil: string | null },
  right: { readonly validFrom: string; readonly validUntil: string | null }
): boolean {
  const leftStart = Date.parse(left.validFrom);
  const rightStart = Date.parse(right.validFrom);
  const leftEnd = left.validUntil === null ? Number.POSITIVE_INFINITY : Date.parse(left.validUntil);
  const rightEnd =
    right.validUntil === null ? Number.POSITIVE_INFINITY : Date.parse(right.validUntil);
  return leftStart < rightEnd && rightStart < leftEnd;
}

function relateContexts(
  candidate: MemoryClaimTriplePayload,
  existing: MemoryClaimTriplePayload
): ContextRelation {
  const candidateSet = new Set(candidate.qualifiers);
  const existingSet = new Set(existing.qualifiers);
  const candidateCoversExisting = existing.qualifiers.every((value) => candidateSet.has(value));
  const existingCoversCandidate = candidate.qualifiers.every((value) => existingSet.has(value));
  if (candidateCoversExisting && existingCoversCandidate) return 'identical';
  if (candidateCoversExisting) return 'candidate_narrower';
  if (existingCoversCandidate) return 'existing_narrower';
  return 'disjoint';
}

function triplePayload(revision: MemoryRevision): MemoryClaimTriplePayload | null {
  return revision.payloadCanonical.form === 'triple' ? revision.payloadCanonical : null;
}

/**
 * STAGE ONE. Exported because "do these even compete?" is the question worth
 * testing in isolation — every wrong answer here corrupts memory whichever way
 * stage two then rules.
 */
export function compareClaims(
  candidate: MemoryRevision,
  existing: MemoryRevision
): ClaimComparison {
  const authorityComparison = signOf(
    authorityRank(candidate.authorityTier) - authorityRank(existing.authorityTier)
  );
  const verdict = (
    reason: ClaimComparisonReason,
    contextRelation: ContextRelation
  ): ClaimComparison => ({
    existingRevisionId: existing.revisionId,
    competes: reason === 'competes',
    reason,
    contextRelation,
    authorityComparison
  });

  if (candidate.revisionId === existing.revisionId) return verdict('same_revision', 'identical');
  // A new revision of the SAME thread is supersession, not contradiction; routing
  // it here would make every ordinary correction look like a conflict.
  if (candidate.memoryId === existing.memoryId) {
    return verdict('same_memory_thread', 'not_applicable');
  }
  if (!isLiveClaim(existing.status)) return verdict('inactive_revision', 'not_applicable');

  // Scope isolation first: claims in different scopes or sleeves are never in
  // conflict, because resolving across that boundary would widen access.
  if (candidate.ownerScopeId !== existing.ownerScopeId) {
    return verdict('different_owner_scope', 'not_applicable');
  }
  if (candidate.sleeveId !== existing.sleeveId)
    return verdict('different_sleeve', 'not_applicable');
  if (candidate.entityKey !== existing.entityKey) {
    return verdict('different_entity_key', 'not_applicable');
  }

  const candidateTriple = triplePayload(candidate);
  const existingTriple = triplePayload(existing);
  // Structured and redacted payloads have no comparable claim. Preserving both
  // is the only safe answer: an adjudicator that cannot read the claim must not
  // rule on it.
  if (candidateTriple === null || existingTriple === null) {
    return verdict('non_comparable_payload', 'not_applicable');
  }
  if (candidateTriple.subject !== existingTriple.subject) {
    return verdict('different_subject', 'not_applicable');
  }
  if (candidateTriple.predicate !== existingTriple.predicate) {
    return verdict('different_predicate', 'not_applicable');
  }

  const contextRelation = relateContexts(candidateTriple, existingTriple);
  if (contextRelation === 'disjoint') return verdict('disjoint_context', contextRelation);
  if (!intervalsOverlap(candidate, existing)) {
    return verdict('disjoint_valid_interval', contextRelation);
  }
  // Agreement is not conflict. Two sources asserting the same value reinforce
  // each other and both stay.
  if (candidateTriple.object === existingTriple.object) {
    return verdict('compatible_values', contextRelation);
  }
  return verdict('competes', contextRelation);
}

function isMaterial(revision: MemoryRevision): boolean {
  return revision.legalHold || BEHAVIOR_GOVERNING_KINDS.includes(revision.kind);
}

interface StageTwoVerdict {
  readonly outcome: ConflictOutcome;
  readonly winnerRevisionId: string | null;
  readonly conflictedRevisionIds: readonly string[];
  readonly reason: string;
}

/** STAGE TWO. Runs only over claims stage one proved to be genuinely competing. */
function applyPrecedence(
  candidate: MemoryRevision,
  competing: readonly { comparison: ClaimComparison; revision: MemoryRevision }[]
): StageTwoVerdict {
  const competingIds = competing.map((entry) => entry.revision.revisionId);
  const candidateRankValue = authorityRank(candidate.authorityTier);
  const maxRank = competing.reduce(
    (highest, entry) => Math.max(highest, authorityRank(entry.revision.authorityTier)),
    0
  );
  const top = competing.filter((entry) => authorityRank(entry.revision.authorityTier) === maxRank);
  const topIds = top.map((entry) => entry.revision.revisionId);

  // A thread that is ALREADY flagged cannot be resolved by anything that does not
  // outrank it. Retrieval abstains rather than guessing which live side is true.
  const flagged = competing.filter((entry) => entry.revision.status === 'active_conflicted');
  if (flagged.length > 0 && candidateRankValue <= maxRank) {
    return {
      outcome: 'abstain',
      winnerRevisionId: null,
      conflictedRevisionIds: competingIds,
      reason:
        `Candidate '${candidate.revisionId}' (${candidate.authorityTier}) competes with ` +
        `${flagged.length} already-flagged revision(s) [${flagged
          .map((entry) => entry.revision.revisionId)
          .join(', ')}] without outranking them; retrieval abstains until an operator resolves it.`
    };
  }

  if (candidateRankValue > maxRank) {
    return {
      outcome: 'select_one',
      winnerRevisionId: candidate.revisionId,
      conflictedRevisionIds: [],
      reason:
        `Candidate '${candidate.revisionId}' (${candidate.authorityTier}) strictly outranks ` +
        `${competingIds.length} competing revision(s) [${competingIds.join(', ')}] on identical context.`
    };
  }

  const soleTop = topIds[0];
  if (candidateRankValue < maxRank) {
    if (topIds.length === 1 && soleTop !== undefined) {
      return {
        outcome: 'select_one',
        winnerRevisionId: soleTop,
        conflictedRevisionIds: [],
        reason:
          `Candidate '${candidate.revisionId}' (${candidate.authorityTier}) is outranked by ` +
          `active revision '${soleTop}'; the candidate does not take effect.`
      };
    }
    return {
      outcome: 'mark_conflict',
      winnerRevisionId: null,
      conflictedRevisionIds: topIds,
      reason:
        `Candidate '${candidate.revisionId}' is outranked, but ${topIds.length} active revisions ` +
        `[${topIds.join(', ')}] tie above it; no winner is derivable without an operator.`
    };
  }

  // --- Authority tie --------------------------------------------------------
  const relations = new Set(top.map((entry) => entry.comparison.contextRelation));
  if (relations.size === 1 && relations.has('candidate_narrower')) {
    return {
      outcome: 'narrow_context',
      winnerRevisionId: candidate.revisionId,
      conflictedRevisionIds: [],
      reason:
        `Candidate '${candidate.revisionId}' refines the context of [${topIds.join(', ')}] at equal ` +
        `authority '${candidate.authorityTier}'; it wins inside its qualifiers and both are kept.`
    };
  }
  if (
    relations.size === 1 &&
    relations.has('existing_narrower') &&
    topIds.length === 1 &&
    soleTop !== undefined
  ) {
    return {
      outcome: 'narrow_context',
      winnerRevisionId: soleTop,
      conflictedRevisionIds: [],
      reason:
        `Active revision '${soleTop}' refines the candidate's context at equal authority ` +
        `'${candidate.authorityTier}'; it wins inside its qualifiers and both are kept.`
    };
  }

  const material = isMaterial(candidate) || top.some((entry) => isMaterial(entry.revision));
  if (material) {
    return {
      outcome: 'ask_operator',
      winnerRevisionId: null,
      conflictedRevisionIds: topIds,
      reason:
        `Authority tie at '${candidate.authorityTier}' on a behavior-governing claim that cannot be ` +
        `narrowed; candidate '${candidate.revisionId}' versus [${topIds.join(', ')}] needs an operator.`
    };
  }
  return {
    outcome: 'mark_conflict',
    winnerRevisionId: null,
    conflictedRevisionIds: topIds,
    reason:
      `Authority tie at '${candidate.authorityTier}' with incompatible values; candidate ` +
      `'${candidate.revisionId}' and [${topIds.join(', ')}] stay live but flagged.`
  };
}

/**
 * Resolve a candidate revision against the revisions already held.
 *
 * Pure and deterministic: identical input yields an identical resolution,
 * including ordering and fingerprint. Inputs are parsed rather than trusted,
 * because an unvalidated revision could smuggle a malformed interval or a
 * mismatched sleeve past both stages.
 *
 * The reason string names revision ids, tiers, and structural facts only — never
 * payload values — so a resolution can be logged and surfaced to an operator
 * without carrying memory content into the audit trail.
 */
export function resolveConflict(rawCandidate: unknown, rawExisting: unknown): ConflictResolution {
  const candidate = MemoryRevisionSchema.parse(rawCandidate);
  const existing = ExistingRevisionSetSchema.parse(rawExisting);

  const evaluated = existing
    .map((revision) => ({ revision, comparison: compareClaims(candidate, revision) }))
    .sort((left, right) =>
      compareCodeUnits(left.comparison.existingRevisionId, right.comparison.existingRevisionId)
    );
  const comparisons = evaluated.map((entry) => entry.comparison);
  const competing = evaluated.filter((entry) => entry.comparison.competes);
  const competingRevisionIds = competing.map((entry) => entry.comparison.existingRevisionId);
  const preservedRevisionIds = evaluated
    .filter((entry) => !entry.comparison.competes)
    .map((entry) => entry.comparison.existingRevisionId);

  const verdict: StageTwoVerdict =
    competing.length === 0
      ? {
          outcome: 'preserve_both',
          winnerRevisionId: null,
          conflictedRevisionIds: [],
          reason:
            `No claim competes with candidate '${candidate.revisionId}': ` +
            `${preservedRevisionIds.length} existing revision(s) preserved unchanged.`
        }
      : applyPrecedence(candidate, competing);

  const fingerprint = sha256(
    canonicalize({
      outcome: verdict.outcome,
      candidateRevisionId: candidate.revisionId,
      candidateCanonicalHash: candidate.canonicalHash,
      comparisons: comparisons.map((comparison) => ({
        existingRevisionId: comparison.existingRevisionId,
        reason: comparison.reason,
        contextRelation: comparison.contextRelation,
        authorityComparison: comparison.authorityComparison
      })),
      winnerRevisionId: verdict.winnerRevisionId,
      conflictedRevisionIds: [...verdict.conflictedRevisionIds].sort(compareCodeUnits)
    })
  );

  return {
    outcome: verdict.outcome,
    candidateRevisionId: candidate.revisionId,
    comparisons,
    competingRevisionIds,
    preservedRevisionIds,
    winnerRevisionId: verdict.winnerRevisionId,
    conflictedRevisionIds: [...verdict.conflictedRevisionIds].sort(compareCodeUnits),
    reason: verdict.reason,
    fingerprint
  };
}

/**
 * Retrieval gate. An unresolved active conflict must make the system abstain
 * rather than answer with a coin flip — the report is explicit that abstaining
 * is the correct behavior while a contradiction is still live.
 */
export function retrievalMustAbstain(resolution: ConflictResolution): boolean {
  return !CONFLICT_OUTCOME_POLICIES[resolution.outcome].resolved;
}
