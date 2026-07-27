import { describe, expect, it } from 'vitest';

import { MemoryKindSchema } from '../../../src/knowledge/retrieval-contracts';
import { MEMORY_STORE_POLICIES, storeClassForKind } from '../../../src/memory/system/store-classes';
import {
  ftsTokens,
  ftsWeightsForKind,
  queryTokensFor,
  rerankByStorePolicy,
  STORE_RETRIEVAL_POLICY_VERSION,
  type StoreRerankCandidate
} from '../../../src/memory/system/store-retrieval-policy';

const TERMS = ['cobalt', 'reconciliation', 'checklist'];

function candidate(
  id: string,
  overrides: Partial<StoreRerankCandidate> = {}
): StoreRerankCandidate {
  return {
    id,
    kind: 'fact',
    title: 'Unrelated heading',
    content: 'Unrelated body text.',
    tags: [],
    bm25: -1,
    rank: 1,
    ...overrides
  };
}

/** Matches every query term in the title only. */
const TITLE_HIT = { title: 'Cobalt reconciliation checklist', content: 'Nothing relevant here.' };
/** Matches every query term in the body only. */
const BODY_HIT = { title: 'Weekly sync', content: 'The cobalt reconciliation checklist ran.' };

describe('per-store retrieval reweighting', () => {
  it('reads its weights from the declared store policy for every kind', () => {
    for (const kind of MemoryKindSchema.options) {
      expect(ftsWeightsForKind(kind)).toBe(
        MEMORY_STORE_POLICIES[storeClassForKind(kind)].ftsWeights
      );
    }
  });

  it('tokenizes the way the FTS index does: diacritics folded, underscores split', () => {
    expect(ftsTokens('Café Bar')).toEqual(['cafe', 'bar']);
    expect(ftsTokens('foo_bar-baz')).toEqual(['foo', 'bar', 'baz']);
    expect(queryTokensFor(['foo_bar', 'foo'])).toEqual(['foo', 'bar']);
  });

  it('matches a folded query term against an accented column value', () => {
    const result = rerankByStorePolicy({
      normalizedTerms: ['cafe'],
      candidates: [candidate('a', { title: 'Café rota', kind: 'fact' })]
    });
    expect(result.ranked[0]?.columnMatches).toEqual([1, 0, 0]);
  });

  it('weights episodic body evidence above an episodic title hit', () => {
    // Episodic policy is [4, 2, 2]: title 4 * 1 term = 4, body 2 * 3 terms = 6.
    const result = rerankByStorePolicy({
      normalizedTerms: TERMS,
      candidates: [
        candidate('ep_title', { kind: 'episode', title: 'Cobalt notes', rank: 1 }),
        candidate('ep_body', { kind: 'episode', ...BODY_HIT, rank: 2 })
      ]
    });
    expect(result.ranked.map((entry) => entry.fragmentId)).toEqual(['ep_body', 'ep_title']);
    expect(result.ranked.map((entry) => entry.storeScore)).toEqual([6, 4]);
    expect(result.ranked[0]?.rankDelta).toBe(1);
  });

  it('keeps the title premium for the semantic store on the identical text profile', () => {
    // Same two documents, filed as `fact`: semantic policy is [8, 1, 2], so the
    // title hit (8) beats three body terms (3). This is the whole point of
    // per-store weights — the ordering flips purely on store class.
    const result = rerankByStorePolicy({
      normalizedTerms: TERMS,
      candidates: [
        candidate('sem_title', { kind: 'fact', title: 'Cobalt notes', rank: 1 }),
        candidate('sem_body', { kind: 'fact', ...BODY_HIT, rank: 2 })
      ]
    });
    expect(result.ranked.map((entry) => entry.fragmentId)).toEqual(['sem_title', 'sem_body']);
    expect(result.ranked.map((entry) => entry.storeScore)).toEqual([8, 3]);
  });

  it('weights procedural tags above semantic tags on identical input', () => {
    const tagged = { title: 'Unrelated heading', tags: ['cobalt', 'checklist'] };
    const procedural = rerankByStorePolicy({
      normalizedTerms: TERMS,
      candidates: [candidate('p', { kind: 'procedure', ...tagged })]
    });
    const semantic = rerankByStorePolicy({
      normalizedTerms: TERMS,
      candidates: [candidate('s', { kind: 'fact', ...tagged })]
    });
    expect(procedural.ranked[0]?.storeScore).toBe(6);
    expect(semantic.ranked[0]?.storeScore).toBe(4);
  });

  it('breaks ties on fragment id ascending regardless of input order or base rank', () => {
    const forward = rerankByStorePolicy({
      normalizedTerms: TERMS,
      candidates: [
        candidate('zulu', { ...TITLE_HIT, bm25: -9, rank: 1 }),
        candidate('alpha', { ...TITLE_HIT, bm25: -1, rank: 2 }),
        candidate('mike', { ...TITLE_HIT, bm25: -5, rank: 3 })
      ]
    });
    const reversed = rerankByStorePolicy({
      normalizedTerms: TERMS,
      candidates: [
        candidate('mike', { ...TITLE_HIT, bm25: -5, rank: 3 }),
        candidate('alpha', { ...TITLE_HIT, bm25: -1, rank: 2 }),
        candidate('zulu', { ...TITLE_HIT, bm25: -9, rank: 1 })
      ]
    });
    expect(forward.ranked.map((entry) => entry.fragmentId)).toEqual(['alpha', 'mike', 'zulu']);
    expect(reversed.ranked.map((entry) => entry.fragmentId)).toEqual(['alpha', 'mike', 'zulu']);
    expect(reversed.fingerprint).toBe(forward.fingerprint);
  });

  it('is deterministic: the same candidate set fingerprints identically twice', () => {
    const input = {
      normalizedTerms: TERMS,
      candidates: [
        candidate('ep_body', { kind: 'episode', ...BODY_HIT, rank: 1 }),
        candidate('sem_title', { kind: 'fact', ...TITLE_HIT, rank: 2 }),
        candidate('proc_tags', { kind: 'procedure', tags: ['cobalt'], rank: 3 })
      ]
    };
    const first = rerankByStorePolicy(input);
    const second = rerankByStorePolicy(input);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.ranked).toEqual(first.ranked);
    expect(first.policyVersion).toBe(STORE_RETRIEVAL_POLICY_VERSION);
  });

  it('changes the fingerprint when the ranking actually changes', () => {
    const base = rerankByStorePolicy({
      normalizedTerms: TERMS,
      candidates: [candidate('a', { kind: 'episode', ...BODY_HIT })]
    });
    const refiled = rerankByStorePolicy({
      normalizedTerms: TERMS,
      candidates: [candidate('a', { kind: 'fact', ...BODY_HIT })]
    });
    expect(refiled.fingerprint).not.toBe(base.fingerprint);
  });

  it('reorders but never adds or drops a candidate', () => {
    const ids = ['d', 'b', 'a', 'c'];
    const result = rerankByStorePolicy({
      normalizedTerms: TERMS,
      candidates: ids.map((id, index) =>
        candidate(id, { kind: 'episode', ...BODY_HIT, rank: index + 1 })
      )
    });
    expect(result.ranked).toHaveLength(ids.length);
    expect([...result.ranked.map((entry) => entry.fragmentId)].sort()).toEqual([...ids].sort());
    expect(result.ranked.map((entry) => entry.rank)).toEqual([1, 2, 3, 4]);
    for (const entry of result.ranked) {
      expect(entry.rankDelta).toBe(entry.baseRank - entry.rank);
    }
  });

  it('fails closed when the candidate set cannot be ordered unambiguously', () => {
    expect(() =>
      rerankByStorePolicy({
        normalizedTerms: TERMS,
        candidates: [candidate('dupe'), candidate('dupe', { title: 'Cobalt' })]
      })
    ).toThrowError(expect.objectContaining({ code: 'MEMORY_STORE_RERANK_INVALID' }));
  });

  it('scores a candidate with no query evidence at zero without inventing signal', () => {
    const result = rerankByStorePolicy({
      normalizedTerms: TERMS,
      candidates: [candidate('miss', { bm25: -12, rank: 1 })]
    });
    expect(result.ranked[0]?.storeScore).toBe(0);
    expect(result.ranked[0]?.baseBm25).toBe(-12);
  });
});
