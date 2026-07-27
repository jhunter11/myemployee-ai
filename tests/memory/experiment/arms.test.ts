import { describe, expect, it } from 'vitest';

import { MemorySystemIdSchema } from '../../../src/memory/system/contracts';
import {
  ALL_ARMS,
  ARM_CATALOG,
  ExperimentFairnessError,
  MVE_ARMS,
  UnknownExperimentArmError,
  armsByBackend,
  assertFairness,
  backendForArm,
  fairnessDeviations,
  frozenFairnessBindings,
  getArm,
  getArmCatalogEntry
} from '../../../src/memory/experiment/arms';
import {
  ArmSpecSchema,
  EXPERIMENT_ARMS,
  EXPERIMENT_ARM_IDS,
  ExperimentBudgetMismatchError,
  FROZEN_FAIRNESS_BUDGET,
  MVE_ARM_IDS,
  type ArmBudgetBinding,
  type ExperimentArmId,
  type MemoryBudget
} from '../../../src/memory/experiment/contracts';

const ALL_ARM_IDS: readonly ExperimentArmId[] = EXPERIMENT_ARM_IDS;

function bindings(overrides: Partial<Record<ExperimentArmId, MemoryBudget>> = {}) {
  return ALL_ARM_IDS.map<ArmBudgetBinding>((armId) => ({
    armId,
    budget: overrides[armId] ?? FROZEN_FAIRNESS_BUDGET
  }));
}

describe('experiment arm catalog', () => {
  it('exposes all eight arms in the frozen declaration order', () => {
    expect(ALL_ARMS.map((arm) => arm.armId)).toEqual([...EXPERIMENT_ARM_IDS]);
    expect(ALL_ARMS).toHaveLength(8);
  });

  it('derives from the frozen table instead of restating it', () => {
    for (const armId of ALL_ARM_IDS) {
      expect(getArm(armId)).toEqual(EXPERIMENT_ARMS[armId]);
      expect(ArmSpecSchema.parse(getArm(armId))).toEqual(getArm(armId));
    }
  });

  it('binds every arm to a real repo backend', () => {
    const expectedBackends: Readonly<Record<ExperimentArmId, string>> = {
      FlatTag: 'flat',
      TypedBasic: 'typed_hybrid',
      TypedTemporal: 'typed_temporal',
      Hierarchical: 'typed_temporal',
      GraphAssist: 'typed_temporal',
      EpisodeOnly: 'ledger',
      FactOnly: 'typed_hybrid',
      HybridLedger: 'ledger'
    };
    for (const armId of ALL_ARM_IDS) {
      expect(MemorySystemIdSchema.parse(backendForArm(armId))).toBe(expectedBackends[armId]);
    }
  });

  it('groups arms by backend in stable order', () => {
    const grouped = armsByBackend();
    expect(grouped.get('typed_temporal')).toEqual(['TypedTemporal', 'Hierarchical', 'GraphAssist']);
    expect(grouped.get('typed_hybrid')).toEqual(['TypedBasic', 'FactOnly']);
    expect(grouped.get('ledger')).toEqual(['EpisodeOnly', 'HybridLedger']);
    expect(grouped.get('flat')).toEqual(['FlatTag']);
  });

  it('documents why each representation maps onto its backend', () => {
    for (const armId of ALL_ARM_IDS) {
      const entry = getArmCatalogEntry(armId);
      expect(entry.backendRationale.length).toBeGreaterThan(80);
      expect(entry.harnessOverlay.length).toBeGreaterThanOrEqual(3);
      expect(entry.spec.armId).toBe(armId);
    }
    expect(Object.keys(ARM_CATALOG)).toHaveLength(8);
  });

  it('varies only the intended axes: each arm has a distinct representation', () => {
    const representations = ALL_ARMS.map((arm) => arm.representation);
    expect(new Set(representations).size).toBe(representations.length);
  });

  it('keeps every screening arm deny-first: no arm widens cross-scope visibility', () => {
    for (const arm of ALL_ARMS) {
      expect(['deny_first_flat', 'deny_first_typed', 'approved_bundles']).toContain(
        arm.scopePolicy
      );
      expect(arm.scopePolicy).not.toBe('narrow_projection');
    }
  });

  it('ships no screening arm with automatic consolidation', () => {
    // Automatic consolidation exists only so the consolidation phase can measure
    // its irreversible-error tail risk; a screening arm must never carry it.
    for (const arm of ALL_ARMS) {
      expect(arm.consolidationPolicy).not.toBe('automatic');
    }
  });

  it('exposes the four MVE arms in the same stable order', () => {
    expect(MVE_ARMS.map((arm) => arm.armId)).toEqual([...MVE_ARM_IDS]);
  });

  it('fails closed on an unknown arm id', () => {
    const bogus = 'TypedTemporalV2' as ExperimentArmId;
    expect(() => getArm(bogus)).toThrow(UnknownExperimentArmError);
    expect(() => getArm(bogus)).toThrow(/Unknown experiment arm/u);
  });
});

describe('fairness assertion', () => {
  it('accepts every arm bound to the frozen budget', () => {
    expect(() => assertFairness(frozenFairnessBindings(ALL_ARM_IDS))).not.toThrow();
    expect(frozenFairnessBindings(ALL_ARM_IDS)).toHaveLength(8);
    expect(fairnessDeviations(frozenFairnessBindings(ALL_ARM_IDS))).toEqual([]);
  });

  it('rejects a comparison in which one arm reads more candidates', () => {
    const unfair = bindings({
      GraphAssist: { ...FROZEN_FAIRNESS_BUDGET, candidateCap: 48 }
    });
    expect(() => assertFairness(unfair)).toThrow(ExperimentBudgetMismatchError);
    try {
      assertFairness(unfair);
    } catch (error) {
      expect(error).toBeInstanceOf(ExperimentBudgetMismatchError);
      if (error instanceof ExperimentBudgetMismatchError) {
        expect(error.mismatchedFields).toEqual(['candidateCap']);
      }
    }
  });

  it('rejects a comparison in which one arm compiles more tokens', () => {
    expect(() =>
      assertFairness(
        bindings({ HybridLedger: { ...FROZEN_FAIRNESS_BUDGET, compiledContextTokenCap: 4_000 } })
      )
    ).toThrow(ExperimentBudgetMismatchError);
  });

  it('rejects a set that agrees with itself but drifted off the frozen budget', () => {
    const drifted = ALL_ARM_IDS.map<ArmBudgetBinding>((armId) => ({
      armId,
      budget: { ...FROZEN_FAIRNESS_BUDGET, llmCallCap: 3, storeBytesCap: 2_048 }
    }));
    expect(() => assertFairness(drifted)).toThrow(ExperimentFairnessError);
    try {
      assertFairness(drifted);
    } catch (error) {
      expect(error).toBeInstanceOf(ExperimentFairnessError);
      if (error instanceof ExperimentFairnessError) {
        expect(error.reason).toBe('budget_deviates_from_frozen');
      }
    }
    expect(fairnessDeviations(drifted)).toHaveLength(8);
    expect(fairnessDeviations(drifted)[0]?.mismatchedFields).toEqual([
      'llmCallCap',
      'storeBytesCap'
    ]);
  });

  it('rejects an empty set: no fairness check ran is not evidence of fairness', () => {
    expect(() => assertFairness([])).toThrow(ExperimentFairnessError);
    try {
      assertFairness([]);
    } catch (error) {
      if (error instanceof ExperimentFairnessError) expect(error.reason).toBe('no_arms_bound');
    }
  });

  it('rejects a duplicated arm whose effective budget would be ambiguous', () => {
    const duplicated: readonly ArmBudgetBinding[] = [
      { armId: 'TypedTemporal', budget: FROZEN_FAIRNESS_BUDGET },
      { armId: 'TypedTemporal', budget: { ...FROZEN_FAIRNESS_BUDGET, candidateCap: 12 } }
    ];
    expect(() => assertFairness(duplicated)).toThrow(ExperimentFairnessError);
    try {
      assertFairness(duplicated);
    } catch (error) {
      if (error instanceof ExperimentFairnessError) {
        expect(error.reason).toBe('duplicate_arm_binding');
      }
    }
  });

  it('rejects a binding for an arm the frozen table does not define', () => {
    const bogus: readonly ArmBudgetBinding[] = [
      { armId: 'FlatTag', budget: FROZEN_FAIRNESS_BUDGET },
      { armId: 'FlatTagV2' as ExperimentArmId, budget: FROZEN_FAIRNESS_BUDGET }
    ];
    expect(() => assertFairness(bogus)).toThrow(UnknownExperimentArmError);
  });

  it('accepts an explicit non-frozen reference budget for ablation phases', () => {
    // The budget ablation deliberately varies the budget; what must never vary is
    // the budget BETWEEN the arms being compared inside one ablation cell.
    const ablation: MemoryBudget = { ...FROZEN_FAIRNESS_BUDGET, candidateCap: 8 };
    const cell = ALL_ARM_IDS.slice(0, 2).map<ArmBudgetBinding>((armId) => ({
      armId,
      budget: ablation
    }));
    expect(() => assertFairness(cell, ablation)).not.toThrow();
    expect(() => assertFairness(cell)).toThrow(ExperimentFairnessError);
  });
});
