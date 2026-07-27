import { describe, expect, it } from 'vitest';

import type { LexicalRetrievalItem } from '../../../src/knowledge/retrieval-contracts';
import {
  EVIDENCE_RESOLVER_THRESHOLDS,
  resolveEvidence
} from '../../../src/memory/demo/evidence-resolver';
import { sampleItemById } from '../../../src/memory/demo/sample-memory';

function retrievalItem(
  fragmentId: string,
  confidencePermille: number,
  overrides: Partial<LexicalRetrievalItem> = {}
): LexicalRetrievalItem {
  const sample = sampleItemById(fragmentId);
  if (sample === undefined) throw new Error(`Missing demo fixture: ${fragmentId}`);
  return {
    ...sample.fragment,
    confidencePermille,
    supersededByFragmentId: null,
    bm25: -1,
    rank: 1,
    selectionReason: 'lexical_bm25',
    ...overrides
  };
}

function resolveLaunch(input: {
  confidencePermille: number;
  normalizedTerms?: readonly string[];
  survivingFragmentIds?: readonly string[];
}) {
  return resolveEvidence({
    normalizedTerms: input.normalizedTerms ?? [
      'acme',
      'relaunch',
      'schedule',
      'unmatchedone',
      'unmatchedtwo'
    ],
    retrievedItems: [retrievalItem('acme-launch-date-v2', input.confidencePermille)],
    survivingFragmentIds: input.survivingFragmentIds ?? ['acme-launch-date-v2']
  });
}

describe('evidence resolver', () => {
  it('accepts evidence exactly at both independent policy thresholds', () => {
    const resolution = resolveLaunch({
      confidencePermille: EVIDENCE_RESOLVER_THRESHOLDS.minConfidencePermille
    });

    expect(resolution.reason).toBe('evidence_threshold_met');
    expect(resolution.selectedItem?.id).toBe('acme-launch-date-v2');
    expect(resolution.bestMatch).toMatchObject({
      meaningfulCoveragePermille: EVIDENCE_RESOLVER_THRESHOLDS.minMeaningfulCoveragePermille,
      confidencePermille: EVIDENCE_RESOLVER_THRESHOLDS.minConfidencePermille
    });
  });

  it('rejects evidence one point below the confidence threshold', () => {
    const resolution = resolveLaunch({
      confidencePermille: EVIDENCE_RESOLVER_THRESHOLDS.minConfidencePermille - 1
    });

    expect(resolution.reason).toBe('confidence_below_threshold');
    expect(resolution.selectedItem).toBeNull();
  });

  it('rejects evidence below the meaningful-query coverage threshold', () => {
    const resolution = resolveLaunch({
      confidencePermille: 1_000,
      normalizedTerms: ['acme', 'relaunch', 'missingone', 'missingtwo', 'missingthree']
    });

    expect(resolution.reason).toBe('insufficient_query_coverage');
    expect(resolution.selectedItem).toBeNull();
    expect(resolution.bestMatch?.meaningfulCoveragePermille).toBe(400);
  });

  it('never widens retrieval when compilation names an unknown survivor', () => {
    const resolution = resolveLaunch({
      confidencePermille: 1_000,
      survivingFragmentIds: ['not-a-retrieved-fragment']
    });

    expect(resolution).toMatchObject({
      reason: 'no_surviving_evidence',
      selectedItem: null,
      bestMatch: null
    });
  });

  it('fails closed when the query has fewer than two meaningful terms', () => {
    const resolution = resolveLaunch({
      confidencePermille: 1_000,
      normalizedTerms: ['what', 'is', 'acme']
    });

    expect(resolution.reason).toBe('insufficient_query_specificity');
    expect(resolution.selectedItem).toBeNull();
  });

  it('reports the confidence-failing candidate as the best match for that reason', () => {
    const highScoreBelowCoverage = retrievalItem('acme-launch-date-v2', 1_000, {
      title: 'Alpha beta',
      content: 'Alpha beta',
      tags: [],
      rank: 1
    });
    const coverageEligibleBelowConfidence = retrievalItem('acme-brand-palette', 599, {
      title: 'Alpha beta gamma',
      content: 'Alpha beta gamma',
      tags: [],
      rank: 2
    });
    const resolution = resolveEvidence({
      normalizedTerms: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'],
      retrievedItems: [highScoreBelowCoverage, coverageEligibleBelowConfidence],
      survivingFragmentIds: [highScoreBelowCoverage.id, coverageEligibleBelowConfidence.id]
    });

    expect(resolution.reason).toBe('confidence_below_threshold');
    expect(resolution.selectedItem).toBeNull();
    expect(resolution.bestMatch).toMatchObject({
      fragmentId: coverageEligibleBelowConfidence.id,
      meaningfulCoveragePermille: 600,
      confidencePermille: 599
    });
  });
});
