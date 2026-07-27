import { describe, expect, it } from 'vitest';

import { evaluateLexicalRetrieval } from '../../src/knowledge/retrieval-evaluation';

const fixture = {
  id: 'jarvis_lexical_scaffold_v1',
  status: 'scaffold',
  version: 1,
  k: 2,
  cases: [
    {
      id: 'exact_close',
      category: 'exact_lookup',
      scopeId: 'client:acme_corp',
      sleeveId: 'client:acme_corp',
      query: 'cobalt close policy',
      expectedSourceIds: ['note:current_close'],
      forbiddenSourceIds: ['note:beta_private'],
      expectAbstention: false
    },
    {
      id: 'temporal_close',
      category: 'temporal_change',
      scopeId: 'client:acme_corp',
      sleeveId: 'client:acme_corp',
      query: 'current close process',
      expectedSourceIds: ['note:new_close'],
      forbiddenSourceIds: ['note:retired_close'],
      expectAbstention: false
    },
    {
      id: 'unknown_fact',
      category: 'abstention',
      scopeId: 'client:acme_corp',
      sleeveId: 'client:acme_corp',
      query: 'what is the lunar office code',
      expectedSourceIds: [],
      forbiddenSourceIds: ['note:beta_private'],
      expectAbstention: true
    }
  ]
};

describe('evaluateLexicalRetrieval', () => {
  it('reports reproducible recall, rank, citation, abstention, and leakage metrics', () => {
    const runs = [
      {
        caseId: 'exact_close',
        selected: [
          {
            sourceId: 'note:other',
            scopeId: 'client:acme_corp',
            sleeveId: 'client:acme_corp'
          },
          {
            sourceId: 'note:current_close',
            scopeId: 'client:acme_corp',
            sleeveId: 'client:acme_corp'
          }
        ]
      },
      {
        caseId: 'temporal_close',
        selected: [
          {
            sourceId: 'note:new_close',
            scopeId: 'client:acme_corp',
            sleeveId: 'client:acme_corp'
          }
        ]
      },
      { caseId: 'unknown_fact', selected: [] }
    ];

    const first = evaluateLexicalRetrieval(fixture, runs);
    const second = evaluateLexicalRetrieval(fixture, runs);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      fixtureId: 'jarvis_lexical_scaffold_v1',
      fixtureStatus: 'scaffold',
      queryCount: 3,
      k: 2,
      recallAtK: 1,
      meanReciprocalRank: 0.75,
      citationPrecisionAtK: 2 / 3,
      abstentionAccuracy: 1,
      scopeLeakageCount: 0,
      forbiddenSourceSelectionCount: 0,
      sizeEligibleForPromotion: false
    });
    expect(first.resultFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('counts cross-scope and explicitly forbidden results as leakage failures', () => {
    const result = evaluateLexicalRetrieval(fixture, [
      {
        caseId: 'exact_close',
        selected: [
          {
            sourceId: 'note:beta_private',
            scopeId: 'client:beta_labs',
            sleeveId: 'client:beta_labs'
          }
        ]
      },
      { caseId: 'temporal_close', selected: [] },
      { caseId: 'unknown_fact', selected: [] }
    ]);

    expect(result.scopeLeakageCount).toBe(1);
    expect(result.forbiddenSourceSelectionCount).toBe(1);
    expect(result.recallAtK).toBe(0);
  });

  it('requires one exact run per case and keeps frozen promotion fixtures at 120–200 cases', () => {
    expect(() => evaluateLexicalRetrieval(fixture, [])).toThrow();
    expect(() =>
      evaluateLexicalRetrieval(fixture, [
        { caseId: 'exact_close', selected: [] },
        { caseId: 'exact_close', selected: [] },
        { caseId: 'unknown', selected: [] }
      ])
    ).toThrow();
    expect(() =>
      evaluateLexicalRetrieval(fixture, [
        { caseId: 'exact_close', selected: [] },
        { caseId: 'temporal_close', selected: [] },
        { caseId: 'unknown_fact', selected: [] },
        { caseId: 'unknown_case', selected: [] }
      ])
    ).toThrow();
    expect(() => evaluateLexicalRetrieval({ ...fixture, status: 'frozen' }, [])).toThrow();
    expect(() => evaluateLexicalRetrieval({ ...fixture, extra: true }, [])).toThrow();
  });

  it('validates fixture abstention, source uniqueness, and case uniqueness', () => {
    const exact = fixture.cases[0];
    if (exact === undefined) throw new Error('Expected exact fixture case');
    expect(() =>
      evaluateLexicalRetrieval({ ...fixture, cases: [{ ...exact, expectAbstention: true }] }, [
        { caseId: exact.id, selected: [] }
      ])
    ).toThrow();
    expect(() =>
      evaluateLexicalRetrieval(
        {
          ...fixture,
          cases: [{ ...exact, expectedSourceIds: ['note:current_close', 'note:current_close'] }]
        },
        [{ caseId: exact.id, selected: [] }]
      )
    ).toThrow();
    expect(() =>
      evaluateLexicalRetrieval(
        {
          ...fixture,
          cases: [{ ...exact, forbiddenSourceIds: ['note:beta_private', 'note:beta_private'] }]
        },
        [{ caseId: exact.id, selected: [] }]
      )
    ).toThrow();
    expect(() =>
      evaluateLexicalRetrieval({ ...fixture, cases: [exact, exact] }, [
        { caseId: exact.id, selected: [] }
      ])
    ).toThrow();
  });

  it('defines empty-denominator metrics explicitly and detects failed abstention', () => {
    const abstentionFixture = {
      ...fixture,
      cases: [fixture.cases[2]]
    };
    const empty = evaluateLexicalRetrieval(abstentionFixture, [
      { caseId: 'unknown_fact', selected: [] }
    ]);
    expect(empty).toMatchObject({
      recallAtK: 1,
      meanReciprocalRank: 0,
      citationPrecisionAtK: 1,
      abstentionAccuracy: 1
    });

    const failed = evaluateLexicalRetrieval(abstentionFixture, [
      {
        caseId: 'unknown_fact',
        selected: [
          {
            sourceId: 'note:irrelevant',
            scopeId: 'client:acme_corp',
            sleeveId: 'client:acme_corp'
          }
        ]
      }
    ]);
    expect(failed.abstentionAccuracy).toBe(0);

    const noAbstentionFixture = { ...fixture, cases: fixture.cases.slice(0, 2) };
    const noAbstention = evaluateLexicalRetrieval(noAbstentionFixture, [
      { caseId: 'exact_close', selected: [] },
      { caseId: 'temporal_close', selected: [] }
    ]);
    expect(noAbstention.abstentionAccuracy).toBeNull();
  });
});
