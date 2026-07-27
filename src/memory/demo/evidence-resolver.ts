import type { LexicalRetrievalItem } from '../../knowledge/retrieval-contracts';
import { ftsTokens, queryTokensFor } from '../system/store-retrieval-policy';

/**
 * Versioned independently from retrieval because this is an answer-stage policy:
 * retrieval decides what evidence is admissible; this resolver decides whether any
 * admissible evidence is strong enough to cite.
 */
export const EVIDENCE_RESOLVER_POLICY_VERSION = 'query_specificity_coverage_confidence_v1' as const;

export const EVIDENCE_RESOLVER_THRESHOLDS = Object.freeze({
  minMeaningfulQueryTerms: 2,
  minMeaningfulCoveragePermille: 600,
  minConfidencePermille: 600,
  maxMatchedTerms: 64
});

const LOW_SIGNAL_QUERY_TERMS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'did',
  'do',
  'does',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with'
]);

export type EvidenceResolutionReason =
  | 'evidence_threshold_met'
  | 'no_surviving_evidence'
  | 'insufficient_query_specificity'
  | 'insufficient_query_coverage'
  | 'confidence_below_threshold';

export interface EvidenceMatch {
  readonly fragmentId: string;
  readonly meaningfulQueryTerms: readonly string[];
  readonly matchedTerms: readonly string[];
  readonly meaningfulCoveragePermille: number;
  readonly confidencePermille: number;
  /** Coverage discounted by confidence; used for ranking, never as the only gate. */
  readonly resolutionScorePermille: number;
  readonly retrievalRank: number;
}

export interface EvidenceResolution {
  readonly policyVersion: typeof EVIDENCE_RESOLVER_POLICY_VERSION;
  readonly reason: EvidenceResolutionReason;
  readonly selectedItem: LexicalRetrievalItem | null;
  /** Best observable candidate, including when it failed the threshold. */
  readonly bestMatch: EvidenceMatch | null;
}

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareMatches(left: EvidenceMatch, right: EvidenceMatch): number {
  return (
    right.resolutionScorePermille - left.resolutionScorePermille ||
    right.meaningfulCoveragePermille - left.meaningfulCoveragePermille ||
    right.confidencePermille - left.confidencePermille ||
    left.retrievalRank - right.retrievalRank ||
    compareIds(left.fragmentId, right.fragmentId)
  );
}

function meaningfulTerms(normalizedTerms: readonly string[]): string[] {
  const allTerms = queryTokensFor(normalizedTerms);
  const filtered = allTerms
    .filter((term) => !LOW_SIGNAL_QUERY_TERMS.has(term))
    .slice(0, EVIDENCE_RESOLVER_THRESHOLDS.maxMatchedTerms);
  // A short query made entirely of ordinary words still gets a deterministic lexical
  // check; filtering must not turn a real query into an automatic abstention.
  return filtered.length > 0
    ? filtered
    : allTerms.slice(0, EVIDENCE_RESOLVER_THRESHOLDS.maxMatchedTerms);
}

function matchEvidence(
  item: LexicalRetrievalItem,
  meaningfulQueryTerms: readonly string[]
): EvidenceMatch {
  const evidenceTerms = new Set(
    ftsTokens(`${item.title}\n${item.content}\n${item.tags.join(' ')}`)
  );
  const matchedTerms = meaningfulQueryTerms.filter((term) => evidenceTerms.has(term));
  const meaningfulCoveragePermille =
    meaningfulQueryTerms.length === 0
      ? 0
      : Math.floor((matchedTerms.length * 1_000) / meaningfulQueryTerms.length);
  return {
    fragmentId: item.id,
    meaningfulQueryTerms,
    matchedTerms,
    meaningfulCoveragePermille,
    confidencePermille: item.confidencePermille,
    resolutionScorePermille: Math.floor(
      (meaningfulCoveragePermille * item.confidencePermille) / 1_000
    ),
    retrievalRank: item.rank
  };
}

/**
 * Resolves only over evidence that survived both retrieval and context compilation.
 * Unknown survivor ids are ignored, so a malformed compilation can never widen the
 * authorized candidate set.
 */
export function resolveEvidence(input: {
  readonly normalizedTerms: readonly string[];
  readonly retrievedItems: readonly LexicalRetrievalItem[];
  readonly survivingFragmentIds: readonly string[];
}): EvidenceResolution {
  const survivingIds = new Set(input.survivingFragmentIds);
  const candidates = input.retrievedItems.filter((item) => survivingIds.has(item.id));
  if (candidates.length === 0) {
    return {
      policyVersion: EVIDENCE_RESOLVER_POLICY_VERSION,
      reason: 'no_surviving_evidence',
      selectedItem: null,
      bestMatch: null
    };
  }

  const queryTerms = meaningfulTerms(input.normalizedTerms);
  const matches = candidates.map((item) => matchEvidence(item, queryTerms)).sort(compareMatches);
  if (queryTerms.length < EVIDENCE_RESOLVER_THRESHOLDS.minMeaningfulQueryTerms) {
    return {
      policyVersion: EVIDENCE_RESOLVER_POLICY_VERSION,
      reason: 'insufficient_query_specificity',
      selectedItem: null,
      bestMatch: matches[0] ?? null
    };
  }

  const coverageEligible = matches.filter(
    (match) =>
      match.matchedTerms.length >= EVIDENCE_RESOLVER_THRESHOLDS.minMeaningfulQueryTerms &&
      match.meaningfulCoveragePermille >= EVIDENCE_RESOLVER_THRESHOLDS.minMeaningfulCoveragePermille
  );
  const eligible = coverageEligible
    .filter(
      (match) => match.confidencePermille >= EVIDENCE_RESOLVER_THRESHOLDS.minConfidencePermille
    )
    .sort(compareMatches);
  const winner = eligible[0];
  if (winner === undefined) {
    const reason =
      coverageEligible.length === 0 ? 'insufficient_query_coverage' : 'confidence_below_threshold';
    return {
      policyVersion: EVIDENCE_RESOLVER_POLICY_VERSION,
      reason,
      selectedItem: null,
      bestMatch:
        reason === 'confidence_below_threshold'
          ? (coverageEligible[0] ?? null)
          : (matches[0] ?? null)
    };
  }

  const selectedItem = candidates.find((item) => item.id === winner.fragmentId) ?? null;
  return {
    policyVersion: EVIDENCE_RESOLVER_POLICY_VERSION,
    reason: selectedItem === null ? 'no_surviving_evidence' : 'evidence_threshold_met',
    selectedItem,
    bestMatch: winner
  };
}
