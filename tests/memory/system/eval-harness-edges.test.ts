import { describe, expect, it } from 'vitest';

import {
  evaluateMemoryBackends,
  evaluatePromotionPrecision
} from '../../../src/memory/system/eval-harness';

const abstentionFixture = {
  id: 'memory-abstain-compare',
  status: 'scaffold' as const,
  version: 1,
  k: 5,
  cases: [
    {
      id: 'lookup_case',
      category: 'exact_lookup' as const,
      scopeId: 'client:acme_corp',
      sleeveId: 'client:acme_corp',
      query: 'cobalt close',
      expectedSourceIds: ['note:a'],
      forbiddenSourceIds: [],
      expectAbstention: false
    },
    {
      id: 'abstain_case',
      category: 'abstention' as const,
      scopeId: 'client:acme_corp',
      sleeveId: 'client:acme_corp',
      query: 'unknown payroll figure',
      expectedSourceIds: [],
      forbiddenSourceIds: [],
      expectAbstention: true
    }
  ]
};

function perfectRuns() {
  return [
    {
      caseId: 'lookup_case',
      selected: [{ sourceId: 'note:a', scopeId: 'client:acme_corp', sleeveId: 'client:acme_corp' }]
    },
    { caseId: 'abstain_case', selected: [] }
  ];
}

describe('multi-backend evaluation edges', () => {
  it('breaks exact ties by backend id and reports non-null abstention accuracy', () => {
    const comparison = evaluateMemoryBackends(abstentionFixture, {
      arms: [
        { backend: 'typed_hybrid', runs: perfectRuns() },
        { backend: 'flat', runs: perfectRuns() }
      ]
    });
    // identical metrics -> deterministic tie-break by backend id ascending
    expect(comparison.ranking).toEqual(['flat', 'typed_hybrid']);
    expect(comparison.leader).toBe('flat');
    expect(comparison.arms[0]?.result.abstentionAccuracy).toBe(1);
  });
});

describe('promotion precision edges', () => {
  it('treats an empty proposal set against no promote-worthy gold as perfect', () => {
    const result = evaluatePromotionPrecision({
      proposed: [],
      gold: [{ candidateId: 'a', shouldPromote: false }]
    });
    expect(result).toMatchObject({ precision: 1, recall: 1, f1: 1 });
  });

  it('scores full recall but partial precision when over-proposing', () => {
    const result = evaluatePromotionPrecision({
      proposed: ['a', 'b'],
      gold: [
        { candidateId: 'a', shouldPromote: true },
        { candidateId: 'b', shouldPromote: false }
      ]
    });
    expect(result).toMatchObject({
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 0,
      recall: 1
    });
    expect(result.precision).toBeCloseTo(0.5, 5);
  });

  it('rejects a non-unique proposal set and duplicate gold labels', () => {
    expect(() =>
      evaluatePromotionPrecision({
        proposed: ['a', 'a'],
        gold: [{ candidateId: 'a', shouldPromote: true }]
      })
    ).toThrow();
    expect(() =>
      evaluatePromotionPrecision({
        proposed: ['a'],
        gold: [
          { candidateId: 'a', shouldPromote: true },
          { candidateId: 'a', shouldPromote: false }
        ]
      })
    ).toThrow();
  });
});
