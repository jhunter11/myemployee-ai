import { describe, expect, it } from 'vitest';

import {
  evaluateMemoryBackends,
  evaluatePromotionPrecision
} from '../../../src/memory/system/eval-harness';

const fixture = {
  id: 'memory-backend-compare',
  status: 'scaffold' as const,
  version: 1,
  k: 5,
  cases: [
    {
      id: 'case_1',
      category: 'exact_lookup' as const,
      scopeId: 'client:acme_corp',
      sleeveId: 'client:acme_corp',
      query: 'cobalt close',
      expectedSourceIds: ['note:a'],
      forbiddenSourceIds: ['note:b'],
      expectAbstention: false
    }
  ]
};

describe('multi-backend memory evaluation', () => {
  it('ranks a leaking backend below a clean one', () => {
    const comparison = evaluateMemoryBackends(fixture, {
      arms: [
        {
          backend: 'flat',
          runs: [
            {
              caseId: 'case_1',
              selected: [
                { sourceId: 'note:b', scopeId: 'client:beta_labs', sleeveId: 'client:beta_labs' }
              ]
            }
          ]
        },
        {
          backend: 'typed_hybrid',
          runs: [
            {
              caseId: 'case_1',
              selected: [
                { sourceId: 'note:a', scopeId: 'client:acme_corp', sleeveId: 'client:acme_corp' }
              ]
            }
          ]
        }
      ]
    });

    expect(comparison.leader).toBe('typed_hybrid');
    expect(comparison.ranking).toEqual(['typed_hybrid', 'flat']);
    expect(comparison.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const flatArm = comparison.arms.find((arm) => arm.backend === 'flat');
    expect(flatArm?.result.scopeLeakageCount).toBe(1);
    expect(flatArm?.result.forbiddenSourceSelectionCount).toBe(1);
  });

  it('rejects duplicate backend arms', () => {
    expect(() =>
      evaluateMemoryBackends(fixture, {
        arms: [
          { backend: 'flat', runs: [{ caseId: 'case_1', selected: [] }] },
          { backend: 'flat', runs: [{ caseId: 'case_1', selected: [] }] }
        ]
      })
    ).toThrow();
  });
});

describe('promotion precision', () => {
  it('scores precision, recall, and f1 over gold-labeled candidates', () => {
    const result = evaluatePromotionPrecision({
      proposed: ['a', 'b'],
      gold: [
        { candidateId: 'a', shouldPromote: true },
        { candidateId: 'b', shouldPromote: false },
        { candidateId: 'c', shouldPromote: true }
      ]
    });
    expect(result).toMatchObject({
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 1,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5
    });
  });

  it('requires every proposed id to carry a gold label', () => {
    expect(() =>
      evaluatePromotionPrecision({
        proposed: ['a', 'unlabeled'],
        gold: [{ candidateId: 'a', shouldPromote: true }]
      })
    ).toThrow();
  });
});
