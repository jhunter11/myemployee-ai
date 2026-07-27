import { describe, expect, it } from 'vitest';

import type {
  LexicalRetrievalItem,
  LexicalRetrievalResult
} from '../../../src/knowledge/retrieval-contracts';
import type { ScopedContextCompilation } from '../../../src/knowledge/context-compiler';
import {
  buildReasoningTrace,
  renderReasoningTrace
} from '../../../src/memory/demo/reasoning-trace';
import {
  ACME_SCOPE_ID,
  ACME_SLEEVE_ID,
  DEMO_NOW,
  SAMPLE_QUESTIONS,
  sampleItemById,
  type SampleQuestion
} from '../../../src/memory/demo/sample-memory';

/**
 * These tests calibrate the instrument itself. The backend comparison is only
 * meaningful if a trace would actually FAIL a backend that surfaced stale or
 * out-of-scope evidence — so here we hand the tracer synthetic retrieval results
 * standing in for a careless backend and assert it says so.
 */

function itemFor(
  fragmentId: string,
  rank: number,
  overrides: Partial<LexicalRetrievalItem> = {}
): LexicalRetrievalItem {
  const sample = sampleItemById(fragmentId);
  if (sample === undefined) throw new Error(`Unknown sample fragment: ${fragmentId}`);
  return {
    ...sample.fragment,
    supersededByFragmentId: null,
    bm25: -1.5,
    rank,
    selectionReason: 'lexical_bm25',
    ...overrides
  };
}

function retrievalWith(
  selectedIds: readonly string[],
  omitted: ReadonlyArray<{ id: string; reason: string }> = [],
  options: {
    normalizedTerms?: readonly string[];
    itemOverrides?: Readonly<Record<string, Partial<LexicalRetrievalItem>>>;
  } = {}
): LexicalRetrievalResult {
  const items = selectedIds.map((id, index) => itemFor(id, index + 1, options.itemOverrides?.[id]));
  return {
    ownerScopeId: ACME_SCOPE_ID,
    sleeveId: ACME_SLEEVE_ID,
    items,
    manifest: {
      algorithm: 'sqlite_fts5_bm25_v1',
      ownerScopeId: ACME_SCOPE_ID,
      sleeveId: ACME_SLEEVE_ID,
      evaluatedAt: DEMO_NOW,
      queryHash: 'a'.repeat(64),
      normalizedTerms: [...(options.normalizedTerms ?? ['acme', 'launch'])],
      selected: items.map((item) => ({
        fragmentId: item.id,
        sourceId: item.sourceId,
        rank: item.rank,
        reason: 'lexical_bm25' as const
      })),
      omitted: omitted.map((entry) => {
        const sample = sampleItemById(entry.id);
        if (sample === undefined) throw new Error(`Unknown sample fragment: ${entry.id}`);
        return {
          fragmentId: entry.id,
          sourceId: sample.fragment.sourceId,
          bm25: -0.5,
          reason: entry.reason as never
        };
      }),
      fingerprint: 'b'.repeat(64)
    }
  };
}

function compilationWith(selectedIds: readonly string[]): ScopedContextCompilation {
  const selected = selectedIds.map((id, index) => {
    const sample = sampleItemById(id);
    if (sample === undefined) throw new Error(`Unknown sample fragment: ${id}`);
    return {
      id,
      fragmentIds: [id],
      sourceIds: [sample.fragment.sourceId],
      sourceHash: sample.fragment.sourceHash,
      content: sample.fragment.content,
      contentHash: String(index + 1).repeat(64),
      estimatedTokens: 10,
      required: false,
      selectionUtility: 100 - index,
      selectionReason: 'utility_per_token' as const
    };
  });
  return {
    status: 'ready',
    blockReason: null,
    ownerScopeId: ACME_SCOPE_ID,
    sleeveId: ACME_SLEEVE_ID,
    estimateBasis: 'capacity_estimate_utf8_bytes_divided_by_4',
    reservations: { output: 0, policy: 0, toolSchema: 0, workingState: 0, safety: 0 },
    capacity: {
      total: 100,
      reserved: 0,
      availableEvidence: 100,
      usedEvidence: selected.length * 10,
      remainingEvidence: 100 - selected.length * 10
    },
    selected,
    manifest: {
      selected: selected.map((fragment) => ({
        id: fragment.id,
        fragmentIds: fragment.fragmentIds,
        sourceIds: fragment.sourceIds,
        contentHash: fragment.contentHash,
        estimatedTokens: fragment.estimatedTokens,
        reason: fragment.selectionReason
      })),
      omitted: [],
      fingerprint: 'c'.repeat(64)
    }
  };
}

const launchQuestion = SAMPLE_QUESTIONS.find(
  (question) => question.id === 'launch_date'
) as SampleQuestion;

describe('reasoning trace', () => {
  it('passes a backend that surfaces the current fact and suppresses the stale one', () => {
    const trace = buildReasoningTrace({
      backend: 'typed_temporal',
      question: launchQuestion,
      evaluatedAt: DEMO_NOW,
      retrieval: retrievalWith(
        ['acme-launch-date-v2'],
        [{ id: 'acme-launch-date-v1', reason: 'superseded' }]
      )
    });

    expect(trace.assessment.memoryCorrect).toBe(true);
    expect(trace.assessment.leakedEvidence).toHaveLength(0);
    expect(trace.assessment.suppressedTraps).toContain('acme-launch-date-v1');
    expect(trace.resolution.outcome).toBe('answered');
    expect(trace.resolution.citedFragmentIds).toEqual(['acme-launch-date-v2']);
  });

  it('FAILS a backend that surfaces the superseded revision as current', () => {
    const trace = buildReasoningTrace({
      backend: 'flat',
      question: launchQuestion,
      evaluatedAt: DEMO_NOW,
      // A temporal-blind store returns the old date ranked first.
      retrieval: retrievalWith(['acme-launch-date-v1', 'acme-launch-date-v2'])
    });

    expect(trace.assessment.memoryCorrect).toBe(false);
    expect(trace.assessment.leakedEvidence).toContain('acme-launch-date-v1');
    expect(trace.assessment.memoryFailureSummary).toContain('forbidden evidence');
    expect(trace.assessment.answerCorrect).toBe(false);
    expect(trace.resolution.citedFragmentIds).toEqual(['acme-launch-date-v1']);
  });

  it('FAILS a backend that leaks the neighbouring client sleeve', () => {
    const trace = buildReasoningTrace({
      backend: 'flat',
      question: launchQuestion,
      evaluatedAt: DEMO_NOW,
      retrieval: retrievalWith(['northwind-launch-date', 'acme-launch-date-v2'])
    });

    expect(trace.assessment.memoryCorrect).toBe(false);
    expect(trace.assessment.leakedEvidence).toContain('northwind-launch-date');
  });

  it('FAILS a backend that drops the required evidence entirely', () => {
    const trace = buildReasoningTrace({
      backend: 'flat',
      question: launchQuestion,
      evaluatedAt: DEMO_NOW,
      retrieval: retrievalWith(['acme-brand-palette'])
    });

    expect(trace.assessment.memoryCorrect).toBe(false);
    expect(trace.assessment.missingEvidence).toContain('acme-launch-date-v2');
  });

  it('scores memory and answer independently', () => {
    // Retrieval is perfect, but nothing survives to be cited: memory passed, answer did not.
    const trace = buildReasoningTrace({
      backend: 'typed_temporal',
      question: launchQuestion,
      evaluatedAt: DEMO_NOW,
      retrieval: retrievalWith(['acme-launch-date-v2']),
      compilation: {
        status: 'ready',
        blockReason: null,
        ownerScopeId: ACME_SCOPE_ID,
        sleeveId: ACME_SLEEVE_ID,
        estimateBasis: 'capacity_estimate_utf8_bytes_divided_by_4',
        reservations: { output: 0, policy: 0, toolSchema: 0, workingState: 0, safety: 0 },
        capacity: {
          total: 10,
          reserved: 0,
          availableEvidence: 10,
          usedEvidence: 0,
          remainingEvidence: 10
        },
        selected: [],
        manifest: { selected: [], omitted: [], fingerprint: 'c'.repeat(64) }
      }
    });

    expect(trace.assessment.memoryCorrect).toBe(true);
    expect(trace.assessment.answerCorrect).toBe(false);
    expect(trace.resolution.outcome).toBe('abstained');
  });

  it('abstains, and is judged correct, when nothing survives retrieval', () => {
    const abstention = SAMPLE_QUESTIONS.find(
      (question) => question.id === 'refund_policy'
    ) as SampleQuestion;
    const trace = buildReasoningTrace({
      backend: 'flat',
      question: abstention,
      evaluatedAt: DEMO_NOW,
      retrieval: retrievalWith([])
    });

    expect(trace.resolution.outcome).toBe('abstained');
    expect(trace.assessment.abstentionCorrect).toBe(true);
    expect(trace.assessment.answerCorrect).toBe(true);
    expect(trace.assessment.memoryCorrect).toBe(true);
  });

  it('selects the strongest surviving query evidence instead of trusting compiler order', () => {
    const releaseQuestion = SAMPLE_QUESTIONS.find(
      (question) => question.id === 'release_process'
    ) as SampleQuestion;
    const trace = buildReasoningTrace({
      backend: 'flat',
      question: releaseQuestion,
      evaluatedAt: DEMO_NOW,
      retrieval: retrievalWith(['acme-release-procedure', 'acme-brand-palette'], [], {
        normalizedTerms: ['what', 'is', 'the', 'acme', 'release', 'checklist']
      }),
      // The context compiler optimizes utility per token, not answer relevance.
      compilation: compilationWith(['acme-brand-palette', 'acme-release-procedure'])
    });

    expect(trace.resolution.outcome).toBe('answered');
    expect(trace.resolution.citedFragmentIds).toEqual(['acme-release-procedure']);
    expect(trace.assessment.answerCorrect).toBe(true);
  });

  it.each(['code_freeze', 'refund_policy'])(
    'abstains from loose lexical matches for %s',
    (questionId) => {
      const question = SAMPLE_QUESTIONS.find(
        (candidate) => candidate.id === questionId
      ) as SampleQuestion;
      const trace = buildReasoningTrace({
        backend: 'flat',
        question,
        evaluatedAt: DEMO_NOW,
        retrieval: retrievalWith(['acme-release-procedure', 'acme-brand-palette'], [], {
          normalizedTerms: question.question.toLowerCase().match(/[a-z0-9]+/gu) ?? []
        }),
        compilation: compilationWith(['acme-brand-palette', 'acme-release-procedure'])
      });

      expect(trace.resolution.outcome).toBe('abstained');
      expect(trace.resolution.citedFragmentIds).toEqual([]);
      expect(trace.assessment.abstentionCorrect).toBe(true);
      expect(trace.assessment.answerCorrect).toBe(true);
    }
  );

  it('abstains when an exact lexical match is below the evidence confidence floor', () => {
    const trace = buildReasoningTrace({
      backend: 'flat',
      question: launchQuestion,
      evaluatedAt: DEMO_NOW,
      retrieval: retrievalWith(['acme-launch-date-v2'], [], {
        normalizedTerms: ['when', 'does', 'the', 'acme', 'relaunch', 'ship'],
        itemOverrides: {
          'acme-launch-date-v2': { confidencePermille: 599 }
        }
      })
    });

    expect(trace.resolution.outcome).toBe('abstained');
    expect(trace.resolution.citedFragmentIds).toEqual([]);
  });

  it('is deterministic: identical input yields an identical fingerprint', () => {
    const build = () =>
      buildReasoningTrace({
        backend: 'flat',
        question: launchQuestion,
        evaluatedAt: DEMO_NOW,
        retrieval: retrievalWith(
          ['acme-launch-date-v2'],
          [{ id: 'acme-launch-date-v1', reason: 'superseded' }]
        )
      });
    expect(build().fingerprint).toBe(build().fingerprint);
  });

  it('changes its fingerprint when the retrieved evidence changes', () => {
    const good = buildReasoningTrace({
      backend: 'flat',
      question: launchQuestion,
      evaluatedAt: DEMO_NOW,
      retrieval: retrievalWith(['acme-launch-date-v2'])
    });
    const bad = buildReasoningTrace({
      backend: 'flat',
      question: launchQuestion,
      evaluatedAt: DEMO_NOW,
      retrieval: retrievalWith(['acme-launch-date-v1'])
    });
    expect(bad.fingerprint).not.toBe(good.fingerprint);
  });

  it('changes both fingerprints when the returned answer content changes', () => {
    const build = (content: string) =>
      buildReasoningTrace({
        backend: 'flat',
        question: launchQuestion,
        evaluatedAt: DEMO_NOW,
        retrieval: retrievalWith(['acme-launch-date-v2'], [], {
          itemOverrides: {
            'acme-launch-date-v2': { content }
          }
        })
      });
    const first = build('The Acme relaunch ships on September 30, 2026.');
    const second = build('The Acme relaunch ships on October 7, 2026.');

    expect(first.resolution.answer).not.toBe(second.resolution.answer);
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(first.behaviorFingerprint).not.toBe(second.behaviorFingerprint);
  });

  it('explains every suppression in plain language', () => {
    const trace = buildReasoningTrace({
      backend: 'typed_temporal',
      question: launchQuestion,
      evaluatedAt: DEMO_NOW,
      retrieval: retrievalWith(
        ['acme-launch-date-v2'],
        [
          { id: 'acme-launch-date-v1', reason: 'superseded' },
          { id: 'acme-code-freeze-window', reason: 'validity_ended' },
          { id: 'acme-retired-vendor', reason: 'retrieval_disabled' }
        ]
      )
    });

    const rendered = renderReasoningTrace(trace);
    expect(rendered).toContain('a newer revision supersedes it');
    expect(rendered).toContain('validity window closed');
    expect(rendered).toContain('withdrawn from retrieval by an operator');
  });
});
