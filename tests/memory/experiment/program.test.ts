import { describe, expect, it } from 'vitest';

import {
  DIFFICULTY_TIERS,
  DIFFICULTY_TIER_BANDS,
  EXPERIMENT_ARM_IDS,
  EXPERIMENT_PHASES,
  EXPERIMENT_PHASE_IDS,
  FROZEN_FAIRNESS_BUDGET,
  FROZEN_SAFETY_GATES,
  FROZEN_UTILITY_WEIGHTS_PERMILLE,
  MVE_ARM_IDS,
  UtilityComponentSchema,
  WORKLOAD_FAMILIES,
  type BehaviorMetrics,
  type CompilationMetrics,
  type ExperimentArmId,
  type MaintenanceMetrics,
  type MetricBundle,
  type RetrievalMetrics,
  type WriteMetrics
} from '../../../src/memory/experiment/contracts';
import {
  DecisionRubricError,
  EXTENDED_UTILITY_COMPONENTS,
  MINIMUM_VIABLE_EXPERIMENT,
  PHASE_ORDER,
  PHASE_PROGRAM,
  PROFILE_COMPONENTS,
  PROFILE_WEIGHTS_PERMILLE,
  PROGRAM_INVARIANTS_HOLD,
  REQUIRED_GATE_METRICS,
  SCENARIO_PROFILES_FOR_WINNER,
  SCENARIO_PROFILE_IDS,
  buildLeaderboard,
  evaluateArmEligibility,
  getPhase,
  mveWorkloadInput,
  paretoFrontier,
  shouldStopExperimenting,
  type ArmScorecardInput,
  type BudgetLadderRung,
  type CohortMetrics,
  type StopCriteriaState
} from '../../../src/memory/experiment/program';
import {
  decideNonInferiority,
  type ConfidenceInterval
} from '../../../src/memory/experiment/statistics';
import {
  WorkloadGeneratorInputSchema,
  generateWorkload
} from '../../../src/memory/experiment/workload-generator';

// --- Fixtures ---------------------------------------------------------------

interface BundleOverrides {
  readonly write?: Partial<WriteMetrics>;
  readonly maintenance?: Partial<MaintenanceMetrics>;
  readonly retrieval?: Partial<RetrievalMetrics>;
  readonly compilation?: Partial<CompilationMetrics>;
  readonly behavior?: Partial<BehaviorMetrics>;
}

/** A fully gate-passing metric bundle; every fixture below is a deviation from it. */
function bundle(overrides: BundleOverrides = {}): MetricBundle {
  return {
    write: {
      writePrecision: 0.9,
      writeRecall: 0.9,
      duplicateMemoryRate: 0,
      incorrectInferenceRate: 0,
      wrongSleeveWriteRate: 0,
      unsupportedMemoryRate: 0,
      consolidationDistortion: 0,
      procedureExtractionPrecision: 0.9,
      ...overrides.write
    },
    maintenance: {
      correctUpdateRate: 0.9,
      supersessionAccuracy: 0.9,
      deletionCompletion: 1,
      conflictDetectionRecall: 0.9,
      staleMemorySurvival: 0,
      promotionPrecision: 0.9,
      promotionRecall: 0.8,
      provenancePreservation: 1,
      severeIrreversibleErrorRate: 0,
      ...overrides.maintenance
    },
    retrieval: {
      recallAtK: 0.743,
      precisionAtK: 0.4,
      meanReciprocalRank: 0.7,
      ndcgAtK: 0.7,
      scopeFilterCorrectness: 1,
      temporalFilterCorrectness: 1,
      distractorRetrievalRate: 0.1,
      unsupportedGraphExpansionRate: 0,
      ...overrides.retrieval
    },
    compilation: {
      evidenceCoverage: 0.9,
      redundancy: 0.05,
      contradictionRate: 0,
      tokenUtilization: 0.6,
      relevantTokenDensity: 0.6,
      positionEffect: null,
      overflowFrequency: 0,
      ...overrides.compilation
    },
    behavior: {
      taskSuccess: 0.75,
      answerAccuracy: 0.75,
      toolExecutionAccuracy: 1,
      toolCallsPerSolvedTask: 3,
      policyCompliance: 1,
      abstentionCorrectness: 1,
      operatorCorrectionRate: 0.04,
      crossSleeveLeakage: 0,
      secretLeakage: 0,
      deterministicReplayRate: 1,
      latencyP50Ms: 500,
      latencyP95Ms: 1_000,
      costModelTokens: 1_080,
      costEmbeddingCalls: 4,
      costIndexQueries: 4,
      costGpuSeconds: 0.5,
      energyJoules: null,
      ...overrides.behavior
    }
  };
}

function cohorts(overrides: Partial<CohortMetrics> = {}): CohortMetrics {
  return {
    temporalCorrectness: 0.8,
    multiHopAccuracy: 0.7,
    procedureEfficiency: 0.743,
    handoffSuccess: 0.7,
    duplicateWorkAvoidance: 0.7,
    ...overrides
  };
}

function scorecard(
  armId: ExperimentArmId,
  metrics: MetricBundle,
  cohortMetrics: CohortMetrics
): ArmScorecardInput {
  return {
    armId,
    metrics,
    cohorts: cohortMetrics,
    itemsScored: 2_400,
    retrievalK: 10,
    budget: FROZEN_FAIRNESS_BUDGET
  };
}

const SCREENING = { phaseId: 'representation_screening', datasetSplit: 'synthetic_dev' } as const;

/**
 * The report's own sample leaderboard, transcribed as inputs. Latency, cost, and
 * operator burden are given as raw measurements whose ratios reproduce the published
 * multiples; retrieval recall and procedure efficiency are the two columns the table
 * omits and are set to the single value that makes all three published utility
 * scores come out at once.
 */
const REPORT_RECALL_AND_PROCEDURE = 0.743;

function reportLeaderboardInputs(): ArmScorecardInput[] {
  return [
    scorecard(
      'FlatTag',
      bundle({
        behavior: {
          taskSuccess: 0.732,
          crossSleeveLeakage: 0.006,
          latencyP95Ms: 940,
          costModelTokens: 1_004,
          operatorCorrectionRate: 0.01
        },
        maintenance: { severeIrreversibleErrorRate: 0.002 },
        retrieval: { recallAtK: REPORT_RECALL_AND_PROCEDURE }
      }),
      cohorts({ temporalCorrectness: 0.715, multiHopAccuracy: 0.671 })
    ),
    scorecard(
      'TypedTemporal',
      bundle({
        behavior: {
          taskSuccess: 0.786,
          crossSleeveLeakage: 0.001,
          latencyP95Ms: 1_000,
          costModelTokens: 1_080,
          operatorCorrectionRate: 0.04,
          toolCallsPerSolvedTask: 3
        },
        maintenance: { promotionPrecision: 0.9 },
        retrieval: { recallAtK: REPORT_RECALL_AND_PROCEDURE }
      }),
      cohorts({
        temporalCorrectness: 0.814,
        multiHopAccuracy: 0.742,
        procedureEfficiency: REPORT_RECALL_AND_PROCEDURE,
        handoffSuccess: 0.7,
        duplicateWorkAvoidance: 0.7
      })
    ),
    scorecard(
      'GraphAssist',
      bundle({
        behavior: {
          taskSuccess: 0.809,
          crossSleeveLeakage: 0.003,
          latencyP95Ms: 1_540,
          costModelTokens: 1_310,
          operatorCorrectionRate: 0.04,
          toolCallsPerSolvedTask: 4
        },
        maintenance: { promotionPrecision: 0.88 },
        retrieval: { recallAtK: REPORT_RECALL_AND_PROCEDURE }
      }),
      cohorts({
        temporalCorrectness: 0.82,
        multiHopAccuracy: 0.798,
        procedureEfficiency: REPORT_RECALL_AND_PROCEDURE,
        handoffSuccess: 0.74,
        duplicateWorkAvoidance: 0.72
      })
    ),
    scorecard(
      'Hierarchical',
      bundle({
        behavior: {
          taskSuccess: 0.778,
          crossSleeveLeakage: 0.001,
          latencyP95Ms: 1_090,
          costModelTokens: 1_120,
          operatorCorrectionRate: 0.07,
          toolCallsPerSolvedTask: 3
        },
        maintenance: { promotionPrecision: 0.92 },
        retrieval: { recallAtK: REPORT_RECALL_AND_PROCEDURE }
      }),
      cohorts({
        temporalCorrectness: 0.806,
        multiHopAccuracy: 0.724,
        procedureEfficiency: REPORT_RECALL_AND_PROCEDURE,
        handoffSuccess: 0.86,
        duplicateWorkAvoidance: 0.88
      })
    )
  ];
}

// --- Phase program ----------------------------------------------------------

describe('the gated phase program', () => {
  it('holds its own invariants at import time', () => {
    expect(PROGRAM_INVARIANTS_HOLD).toBe(true);
  });

  it('defines all six phases in execution order and derives each spec from the contract', () => {
    expect(PHASE_ORDER).toEqual([...EXPERIMENT_PHASE_IDS]);
    for (const phaseId of PHASE_ORDER) {
      expect(getPhase(phaseId).spec).toBe(EXPERIMENT_PHASES[phaseId]);
    }
  });

  it('plans exactly the scored-task scale the contract budgeted for', () => {
    for (const phaseId of PHASE_ORDER) {
      const entry = PHASE_PROGRAM[phaseId];
      expect(entry.scale.functionalTasks + entry.scale.attackTrials).toBe(
        entry.spec.recommendedScoredTasks
      );
    }
    // The hierarchy phase is the one that splits: 800 functional plus the 1,500
    // attack trials the secret gate's upper bound was sized against.
    expect(PHASE_PROGRAM.hierarchy_privacy.scale).toMatchObject({
      functionalTasks: 800,
      attackTrials: 1_500
    });
    expect(PHASE_PROGRAM.confirmatory_comparison.scale.functionalTasks).toBe(3_000);
  });

  it('validates the harness against an oracle before any arm is compared', () => {
    const harness = PHASE_PROGRAM.harness_validation.arms;

    expect(harness.mode).toBe('fixed');
    expect(harness.includesOracleArm).toBe(true);
    expect(PHASE_PROGRAM.harness_validation.workload.tiers).toEqual(['easy']);
    expect(PHASE_PROGRAM.harness_validation.spec.datasetSplits).toEqual(['synthetic_micro']);
  });

  it('screens every arm and then carries a shrinking set forward', () => {
    const screening = PHASE_PROGRAM.representation_screening.arms;
    expect(screening.mode === 'fixed' ? screening.armIds : []).toEqual([...EXPERIMENT_ARM_IDS]);

    const carried = PHASE_ORDER.filter(
      (phaseId) => PHASE_PROGRAM[phaseId].arms.mode === 'carried_forward'
    );
    expect(carried).toEqual([
      'confirmatory_comparison',
      'budget_ablation',
      'consolidation_forgetting',
      'hierarchy_privacy'
    ]);
    for (const phaseId of carried) {
      const arms = PHASE_PROGRAM[phaseId].arms;
      if (arms.mode !== 'carried_forward') throw new Error('expected a carried-forward selection');
      expect(PHASE_ORDER.indexOf(arms.carriedFrom)).toBeLessThan(PHASE_ORDER.indexOf(phaseId));
    }
  });

  it('runs the ablations at the configuration counts the report prescribes', () => {
    expect(PHASE_PROGRAM.budget_ablation.arms.configurationCount).toBe(6);
    expect(PHASE_PROGRAM.consolidation_forgetting.arms.configurationCount).toBe(10);
    expect(PHASE_PROGRAM.hierarchy_privacy.arms.configurationCount).toBe(6);
    // Easy items saturate every budget schedule, so the elbow can only appear on the
    // two hardest tiers.
    expect(PHASE_PROGRAM.budget_ablation.workload.tiers).toEqual(['hard', 'very_hard']);
  });

  it('draws every workload split from the frozen vocabularies', () => {
    for (const phaseId of PHASE_ORDER) {
      const { families, tiers } = PHASE_PROGRAM[phaseId].workload;
      expect(families.length).toBeGreaterThan(0);
      expect(tiers.length).toBeGreaterThan(0);
      expect(new Set(families).size).toBe(families.length);
      expect(families.every((family) => WORKLOAD_FAMILIES.includes(family))).toBe(true);
      expect(tiers.every((tier) => DIFFICULTY_TIERS.includes(tier))).toBe(true);
    }
    expect(PHASE_PROGRAM.hierarchy_privacy.workload.families).toContain('adversarial');
    expect(PHASE_PROGRAM.consolidation_forgetting.workload.families).toContain('update_control');
  });
});

// --- Gates ------------------------------------------------------------------

describe('safety gates come first', () => {
  it('still covers every hard constraint the rubric disqualifies on', () => {
    for (const metric of REQUIRED_GATE_METRICS) {
      expect(FROZEN_SAFETY_GATES.some((gate) => gate.metric === metric)).toBe(true);
    }
  });

  it('disqualifies on each hard constraint independently', () => {
    const violations: readonly BundleOverrides[] = [
      { behavior: { crossSleeveLeakage: 0.02 } },
      { behavior: { secretLeakage: 0.01 } },
      { behavior: { deterministicReplayRate: 0.99 } },
      { write: { wrongSleeveWriteRate: 0.01 } },
      { maintenance: { severeIrreversibleErrorRate: 0.01 } }
    ];

    expect(evaluateArmEligibility('TypedTemporal', bundle()).eligibility).toBe('eligible');
    for (const violation of violations) {
      const evaluation = evaluateArmEligibility('TypedTemporal', bundle(violation));
      expect(evaluation.eligibility).toBe('disqualified');
      expect(evaluation.failedGateIds).toHaveLength(1);
    }
  });

  it('never lets a high-accuracy leaky arm outrank a safe one', () => {
    // FlatTag is given the best task success, the lowest latency, the lowest cost,
    // and the lowest operator burden on the board. It leaks.
    const leaky = scorecard(
      'FlatTag',
      bundle({
        behavior: {
          taskSuccess: 0.99,
          crossSleeveLeakage: 0.02,
          latencyP95Ms: 100,
          costModelTokens: 100,
          operatorCorrectionRate: 0,
          toolCallsPerSolvedTask: 1
        },
        retrieval: { recallAtK: 1 }
      }),
      cohorts({
        temporalCorrectness: 1,
        multiHopAccuracy: 1,
        procedureEfficiency: 1,
        handoffSuccess: 1,
        duplicateWorkAvoidance: 1
      })
    );
    const safe = scorecard('TypedTemporal', bundle({ behavior: { taskSuccess: 0.4 } }), cohorts());

    const board = buildLeaderboard([leaky, safe], SCREENING);
    const leakyRow = board.rows.find((row) => row.armId === 'FlatTag');

    expect(board.rankedArmIds).toEqual(['TypedTemporal', 'FlatTag']);
    expect(board.leader).toBe('TypedTemporal');
    expect(leakyRow?.utilityScorePermille).toBeNull();
    expect(leakyRow?.gateStatus).toBe('fail');
    expect(leakyRow?.rank).toBe(2);
    expect(leakyRow?.onParetoFrontier).toBe(false);
    expect(Object.values(board.profileWinners)).not.toContain('FlatTag');
    expect(board.recommendedArmId).not.toBe('FlatTag');
    // Its accuracy is still on the board: the point is that it scored well and was
    // rejected anyway, not that it disappeared.
    expect(leakyRow?.overallSuccess).toBe(0.99);
    expect(leakyRow?.crossSleeveLeakage).toBe(0.02);
  });

  it('excludes a disqualified arm from the normalization reference', () => {
    const safeOnly = buildLeaderboard(
      [
        scorecard('TypedTemporal', bundle(), cohorts()),
        scorecard('Hierarchical', bundle({ behavior: { latencyP95Ms: 2_000 } }), cohorts())
      ],
      SCREENING
    );
    const withLeakyFastArm = buildLeaderboard(
      [
        scorecard('TypedTemporal', bundle(), cohorts()),
        scorecard('Hierarchical', bundle({ behavior: { latencyP95Ms: 2_000 } }), cohorts()),
        scorecard(
          'FlatTag',
          bundle({ behavior: { latencyP95Ms: 10, crossSleeveLeakage: 0.5 } }),
          cohorts()
        )
      ],
      SCREENING
    );

    const before = safeOnly.rows.map((row) => [row.armId, row.utilityScorePermille]);
    const after = withLeakyFastArm.rows
      .filter((row) => row.armId !== 'FlatTag')
      .map((row) => [row.armId, row.utilityScorePermille]);
    expect(after).toEqual(before);
  });
});

// --- Utility ----------------------------------------------------------------

describe('the cost-adjusted utility score', () => {
  it('uses exactly the report weights, with the extended components at zero', () => {
    const balanced = PROFILE_WEIGHTS_PERMILLE.balanced;

    for (const component of UtilityComponentSchema.options) {
      expect(balanced[component]).toBe(FROZEN_UTILITY_WEIGHTS_PERMILLE[component]);
    }
    for (const component of EXTENDED_UTILITY_COMPONENTS) {
      expect(balanced[component]).toBe(0);
    }
    expect(balanced.task_success).toBe(350);
    expect(balanced.temporal_correctness).toBe(150);
  });

  it('keeps every profile a proper weighting', () => {
    for (const profileId of SCENARIO_PROFILE_IDS) {
      const weights = PROFILE_WEIGHTS_PERMILLE[profileId];
      const total = PROFILE_COMPONENTS.reduce((sum, component) => sum + weights[component], 0);
      expect(total).toBe(1_000);
      expect(PROFILE_COMPONENTS.every((component) => weights[component] >= 0)).toBe(true);
    }
    expect(SCENARIO_PROFILES_FOR_WINNER).not.toContain('balanced');
    expect(SCENARIO_PROFILES_FOR_WINNER).toHaveLength(3);
  });

  it("reproduces the report's published sample leaderboard", () => {
    const board = buildLeaderboard(reportLeaderboardInputs(), SCREENING);

    expect(board.rankedArmIds).toEqual(['TypedTemporal', 'GraphAssist', 'Hierarchical', 'FlatTag']);
    expect(board.rows.map((row) => row.utilityScorePermille)).toEqual([820, 791, 783, null]);
    expect(board.rows.map((row) => row.gateStatus)).toEqual(['pass', 'pass', 'pass', 'fail']);
    expect(board.rows.map((row) => row.armId)).toEqual(board.rankedArmIds);

    const multiples = new Map(
      board.rows.map((row) => [row.armId, [row.latencyP95Multiple, row.costMultiple]])
    );
    expect(multiples.get('TypedTemporal')?.[0]).toBeCloseTo(1.0, 2);
    expect(multiples.get('GraphAssist')?.[0]).toBeCloseTo(1.54, 2);
    expect(multiples.get('Hierarchical')?.[0]).toBeCloseTo(1.09, 2);
    expect(multiples.get('FlatTag')?.[0]).toBeCloseTo(0.94, 2);
    // Cost is reported against the same reference as latency: the cheapest safe arm.
    expect(multiples.get('TypedTemporal')?.[1]).toBeCloseTo(1.0, 2);
    expect(multiples.get('Hierarchical')?.[1]).toBeCloseTo(1_120 / 1_080, 2);
    expect(multiples.get('GraphAssist')?.[1]).toBeCloseTo(1_310 / 1_080, 2);
    expect(multiples.get('FlatTag')?.[1]).toBeCloseTo(0.93, 2);
  });

  it('shows risk beside utility on every row', () => {
    const board = buildLeaderboard(reportLeaderboardInputs(), SCREENING);
    const flat = board.rows.find((row) => row.armId === 'FlatTag');

    expect(flat).toMatchObject({
      crossSleeveLeakage: 0.006,
      secretLeakage: 0,
      wrongSleeveWriteRate: 0,
      severeIrreversibleErrorRate: 0.002,
      deterministicReplayRate: 1,
      gateStatus: 'fail'
    });
    expect(flat?.failedGateIds).toEqual(['gate:cross_sleeve_leakage']);
  });

  it('emits contract-shaped scorecards in rank order with no score for a failing arm', () => {
    const board = buildLeaderboard(reportLeaderboardInputs(), SCREENING);

    expect(board.scorecards.map((card) => card.armId)).toEqual(board.rankedArmIds);
    for (const card of board.scorecards) {
      expect(card.phaseId).toBe('representation_screening');
      expect(card.datasetSplit).toBe('synthetic_dev');
      expect(card.gates.length).toBe(FROZEN_SAFETY_GATES.length);
      expect(card.utilityScorePermille === null).toBe(card.gateStatus === 'fail');
      expect(card.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it('is deterministic and independent of the order arms are supplied in', () => {
    const forward = buildLeaderboard(reportLeaderboardInputs(), SCREENING);
    const reversed = buildLeaderboard([...reportLeaderboardInputs()].reverse(), SCREENING);

    expect(reversed.fingerprint).toBe(forward.fingerprint);
    expect(reversed.rankedArmIds).toEqual(forward.rankedArmIds);
    expect(buildLeaderboard(reportLeaderboardInputs(), SCREENING).fingerprint).toBe(
      forward.fingerprint
    );
  });
});

// --- Pareto frontier --------------------------------------------------------

describe('paretoFrontier', () => {
  it('drops a point that is no better on any axis', () => {
    const frontier = paretoFrontier([
      { armId: 'TypedTemporal', accuracy: 0.786, latencyP95Ms: 1_000, costPerTask: 1_080 },
      { armId: 'GraphAssist', accuracy: 0.809, latencyP95Ms: 1_540, costPerTask: 1_310 },
      { armId: 'Hierarchical', accuracy: 0.778, latencyP95Ms: 1_090, costPerTask: 1_120 }
    ]);

    // Hierarchical is worse on accuracy, latency, AND cost than TypedTemporal.
    // GraphAssist survives because nothing beats its accuracy.
    expect(frontier).toEqual(['TypedTemporal', 'GraphAssist']);
  });

  it('keeps a point that trades one axis for another', () => {
    const frontier = paretoFrontier([
      { armId: 'FlatTag', accuracy: 0.6, latencyP95Ms: 100, costPerTask: 100 },
      { armId: 'TypedTemporal', accuracy: 0.9, latencyP95Ms: 900, costPerTask: 900 },
      { armId: 'GraphAssist', accuracy: 0.75, latencyP95Ms: 400, costPerTask: 400 }
    ]);

    expect(frontier).toEqual(['FlatTag', 'TypedTemporal', 'GraphAssist']);
  });

  it('keeps both arms when their vectors are identical, since neither is preferable', () => {
    const frontier = paretoFrontier([
      { armId: 'TypedBasic', accuracy: 0.8, latencyP95Ms: 500, costPerTask: 500 },
      { armId: 'FactOnly', accuracy: 0.8, latencyP95Ms: 500, costPerTask: 500 }
    ]);

    expect(frontier).toEqual(['TypedBasic', 'FactOnly']);
  });

  it('needs strict improvement on at least one axis to dominate', () => {
    const frontier = paretoFrontier([
      { armId: 'TypedBasic', accuracy: 0.8, latencyP95Ms: 500, costPerTask: 500 },
      { armId: 'FactOnly', accuracy: 0.8, latencyP95Ms: 500, costPerTask: 499 }
    ]);

    expect(frontier).toEqual(['FactOnly']);
  });

  it('returns the frontier in the frozen arm order and handles the single-point case', () => {
    expect(
      paretoFrontier([
        { armId: 'HybridLedger', accuracy: 0.9, latencyP95Ms: 100, costPerTask: 100 },
        { armId: 'FlatTag', accuracy: 0.9, latencyP95Ms: 100, costPerTask: 100 }
      ])
    ).toEqual(['FlatTag', 'HybridLedger']);
    expect(
      paretoFrontier([{ armId: 'EpisodeOnly', accuracy: 0.1, latencyP95Ms: 9, costPerTask: 9 }])
    ).toEqual(['EpisodeOnly']);
    expect(paretoFrontier([])).toEqual([]);
  });

  it('refuses a duplicated arm rather than ranking it against itself', () => {
    expect(() =>
      paretoFrontier([
        { armId: 'FlatTag', accuracy: 0.8, latencyP95Ms: 1, costPerTask: 1 },
        { armId: 'FlatTag', accuracy: 0.9, latencyP95Ms: 1, costPerTask: 1 }
      ])
    ).toThrow(DecisionRubricError);
  });
});

// --- Scenario profiles and the winner rule ----------------------------------

describe('scenario profiles and the winner rule', () => {
  it('lets the profiles genuinely disagree and resolves the winner on 2 of 3', () => {
    const board = buildLeaderboard(reportLeaderboardInputs(), SCREENING);

    // Hierarchical is the best coordinator on the board; TypedTemporal is the safest
    // and the fastest. A single scalar would have hidden that split entirely.
    expect(board.profileWinners.privacy_sensitive).toBe('TypedTemporal');
    expect(board.profileWinners.latency_sensitive).toBe('TypedTemporal');
    expect(board.profileWinners.coordination_sensitive).toBe('Hierarchical');
    expect(board.paretoFrontArmIds).toEqual(['TypedTemporal', 'GraphAssist']);
    expect(board.recommendedArmId).toBe('TypedTemporal');
  });

  it('refuses to recommend a profile sweeper that is off the frontier', () => {
    // Hierarchical wins all three profiles on cohort strength, but TypedTemporal is
    // better on accuracy, latency, AND cost, so Hierarchical is dominated.
    const dominated = scorecard(
      'Hierarchical',
      bundle({
        behavior: {
          taskSuccess: 0.7,
          latencyP95Ms: 2_000,
          costModelTokens: 2_000,
          operatorCorrectionRate: 0.1,
          toolCallsPerSolvedTask: 10
        },
        maintenance: { promotionPrecision: 1 },
        retrieval: { recallAtK: 1 }
      }),
      cohorts({
        temporalCorrectness: 1,
        multiHopAccuracy: 1,
        procedureEfficiency: 1,
        handoffSuccess: 1,
        duplicateWorkAvoidance: 1
      })
    );
    const dominant = scorecard(
      'TypedTemporal',
      bundle({
        behavior: {
          taskSuccess: 0.72,
          latencyP95Ms: 1_000,
          costModelTokens: 1_000,
          operatorCorrectionRate: 0.05,
          toolCallsPerSolvedTask: 5
        },
        maintenance: { promotionPrecision: 0.1 },
        retrieval: { recallAtK: 0.1 }
      }),
      cohorts({
        temporalCorrectness: 0.1,
        multiHopAccuracy: 0.1,
        procedureEfficiency: 0.1,
        handoffSuccess: 0.1,
        duplicateWorkAvoidance: 0.1
      })
    );

    const board = buildLeaderboard([dominated, dominant], SCREENING);

    const scenarioWins = SCENARIO_PROFILES_FOR_WINNER.filter(
      (profileId) => board.profileWinners[profileId] === 'Hierarchical'
    );

    expect(board.paretoFrontArmIds).toEqual(['TypedTemporal']);
    // It clears the 2-of-3 profile bar comfortably and still cannot be recommended,
    // because frontier membership is a separate, non-negotiable condition.
    expect(scenarioWins).toEqual(['privacy_sensitive', 'coordination_sensitive']);
    // The balanced leader and the recommendation are different things, and the
    // rubric says so rather than promoting the runner-up.
    expect(board.leader).toBe('Hierarchical');
    expect(board.recommendedArmId).toBeNull();
  });

  it('recommends nothing when the three profiles pick three different arms', () => {
    const privacyWinner = scorecard(
      'TypedTemporal',
      bundle({
        behavior: {
          taskSuccess: 0.8,
          crossSleeveLeakage: 0,
          latencyP95Ms: 3_000,
          costModelTokens: 3_000
        },
        maintenance: { promotionPrecision: 1 }
      }),
      cohorts({ handoffSuccess: 0.1, duplicateWorkAvoidance: 0.1, multiHopAccuracy: 0.1 })
    );
    const latencyWinner = scorecard(
      'FlatTag',
      bundle({
        behavior: {
          taskSuccess: 0.8,
          crossSleeveLeakage: 0.004,
          latencyP95Ms: 500,
          costModelTokens: 500,
          toolCallsPerSolvedTask: 1
        },
        maintenance: { promotionPrecision: 0.2 }
      }),
      cohorts({ handoffSuccess: 0.1, duplicateWorkAvoidance: 0.1, multiHopAccuracy: 0.1 })
    );
    const coordinationWinner = scorecard(
      'Hierarchical',
      bundle({
        behavior: {
          taskSuccess: 0.8,
          crossSleeveLeakage: 0.004,
          latencyP95Ms: 3_000,
          costModelTokens: 3_000,
          toolCallsPerSolvedTask: 9
        },
        maintenance: { promotionPrecision: 0.2 }
      }),
      cohorts({ handoffSuccess: 1, duplicateWorkAvoidance: 1, multiHopAccuracy: 1 })
    );

    const board = buildLeaderboard([privacyWinner, latencyWinner, coordinationWinner], SCREENING);

    expect(new Set(SCENARIO_PROFILES_FOR_WINNER.map((id) => board.profileWinners[id])).size).toBe(
      3
    );
    expect(board.recommendedArmId).toBeNull();
  });
});

// --- Leaderboard guards -----------------------------------------------------

describe('buildLeaderboard guards', () => {
  it('refuses a leaderboard over zero arms', () => {
    expect(() => buildLeaderboard([], SCREENING)).toThrow(DecisionRubricError);
  });

  it('refuses a duplicated arm', () => {
    const input = scorecard('TypedTemporal', bundle(), cohorts());
    expect(() => buildLeaderboard([input, input], SCREENING)).toThrow(DecisionRubricError);
  });

  it('refuses a phase/split pairing the contract does not allow', () => {
    expect(() =>
      buildLeaderboard([scorecard('TypedTemporal', bundle(), cohorts())], {
        phaseId: 'representation_screening',
        datasetSplit: 'real_shadow_holdout'
      })
    ).toThrow(DecisionRubricError);
  });

  it('refuses budget-confounded comparisons outside the budget ablation', () => {
    const wide = {
      ...scorecard('GraphAssist', bundle(), cohorts()),
      budget: { ...FROZEN_FAIRNESS_BUDGET, candidateCap: 48 }
    };
    const arms = [scorecard('TypedTemporal', bundle(), cohorts()), wide];

    expect(() => buildLeaderboard(arms, SCREENING)).toThrow();
    // The budget ablation is the one phase whose whole purpose is to vary the
    // footprint, so the same comparison is admissible there.
    expect(() =>
      buildLeaderboard(arms, {
        phaseId: 'budget_ablation',
        datasetSplit: 'synthetic_holdout'
      })
    ).not.toThrow();
  });

  it('refuses a retrieval k the arm budget never permitted', () => {
    expect(() =>
      buildLeaderboard(
        [{ ...scorecard('TypedTemporal', bundle(), cohorts()), retrievalK: 999 }],
        SCREENING
      )
    ).toThrow(DecisionRubricError);
  });

  it('refuses an out-of-range component rather than clamping broken instrumentation', () => {
    expect(() =>
      buildLeaderboard(
        [scorecard('TypedTemporal', bundle(), cohorts({ handoffSuccess: 1.4 }))],
        SCREENING
      )
    ).toThrow(DecisionRubricError);
  });

  it('scores nothing and recommends nothing when every arm is disqualified', () => {
    const board = buildLeaderboard(
      [
        scorecard('FlatTag', bundle({ behavior: { crossSleeveLeakage: 0.9 } }), cohorts()),
        scorecard('TypedBasic', bundle({ write: { wrongSleeveWriteRate: 0.9 } }), cohorts())
      ],
      SCREENING
    );

    expect(board.leader).toBeNull();
    expect(board.recommendedArmId).toBeNull();
    expect(board.paretoFrontArmIds).toEqual([]);
    expect(board.rows.every((row) => row.utilityScorePermille === null)).toBe(true);
    expect(board.rows.every((row) => row.latencyP95Multiple === null)).toBe(true);
    expect(Object.values(board.profileWinners).every((winner) => winner === null)).toBe(true);
  });
});

// --- Stop criteria ----------------------------------------------------------

const LADDER: readonly BudgetLadderRung[] = [
  { storeBytesCap: 26_214_400, taskSuccess: 0.72 },
  { storeBytesCap: 52_428_800, taskSuccess: 0.77 },
  { storeBytesCap: 104_857_600, taskSuccess: 0.786 },
  { storeBytesCap: 209_715_200, taskSuccess: 0.789 }
];

function interval(lower: number, point: number, upper: number): ConfidenceInterval {
  return { pointEstimate: point, lower, upper };
}

function stopState(overrides: Partial<StopCriteriaState> = {}): StopCriteriaState {
  return {
    topArmId: 'TypedTemporal',
    runnerUpArmId: 'Hierarchical',
    topArmGateStatus: 'pass',
    holdoutSuccessInterval: interval(0.035, 0.052, 0.07),
    sesoi: 0.03,
    latencyDecision: decideNonInferiority(interval(-0.02, 0.01, 0.04), 0.05),
    costDecision: decideNonInferiority(interval(-0.03, 0.0, 0.03), 0.05),
    syntheticRanking: ['TypedTemporal', 'Hierarchical', 'FlatTag'],
    realHoldoutRanking: ['TypedTemporal', 'Hierarchical', 'FlatTag'],
    budgetLadder: LADDER,
    selectedStoreBytesCap: 104_857_600,
    materialReturnThreshold: 0.01,
    ...overrides
  };
}

describe('shouldStopExperimenting', () => {
  it('stops only when all six criteria hold', () => {
    const decision = shouldStopExperimenting(stopState());

    expect(decision.decision).toBe('stop');
    expect(decision.unresolved).toEqual([]);
    expect(decision.satisfied).toHaveLength(6);
    expect(decision.superiority.decision).toBe('superior');
  });

  it('continues on the unresolved axis alone when a gate fails', () => {
    const decision = shouldStopExperimenting(stopState({ topArmGateStatus: 'fail' }));

    expect(decision.decision).toBe('continue');
    expect(decision.unresolved).toEqual(['top_arm_passes_gates']);
  });

  it('requires the lower bound to clear the SESOI, not merely to exclude zero', () => {
    const decision = shouldStopExperimenting(
      stopState({ holdoutSuccessInterval: interval(0.005, 0.02, 0.04) })
    );

    expect(decision.unresolved).toEqual(['lower_bound_exceeds_sesoi']);
    expect(decision.superiority.reason).toBe('lower_bound_below_sesoi');
    expect(decision.superiority.impliesEquivalence).toBe(false);
  });

  it('will not stop on an inconclusive latency or cost margin', () => {
    expect(
      shouldStopExperimenting(
        stopState({ latencyDecision: decideNonInferiority(interval(-0.2, -0.05, 0.1), 0.05) })
      ).unresolved
    ).toEqual(['latency_non_inferior']);
    expect(
      shouldStopExperimenting(
        stopState({ costDecision: decideNonInferiority(interval(-0.4, -0.3, -0.2), 0.05) })
      ).unresolved
    ).toEqual(['cost_non_inferior']);
  });

  it('detects a ranking that reverses on the real holdout', () => {
    const decision = shouldStopExperimenting(
      stopState({ realHoldoutRanking: ['Hierarchical', 'TypedTemporal', 'FlatTag'] })
    );

    expect(decision.unresolved).toEqual(['ranking_stable_across_holdouts']);
  });

  it('fails closed when an arm was never ranked on the real holdout', () => {
    const decision = shouldStopExperimenting(
      stopState({ realHoldoutRanking: ['TypedTemporal', 'FlatTag'] })
    );

    expect(decision.unresolved).toEqual(['ranking_stable_across_holdouts']);
  });

  it('will not stop while the next larger footprint still buys accuracy', () => {
    const decision = shouldStopExperimenting(stopState({ selectedStoreBytesCap: 52_428_800 }));

    // 0.77 -> 0.786 is +1.6 pp, above the 1 pp materiality threshold.
    expect(decision.unresolved).toEqual(['budget_curve_saturated']);
  });

  it('treats an unmeasured larger footprint as undemonstrated, not as saturated', () => {
    const decision = shouldStopExperimenting(stopState({ selectedStoreBytesCap: 209_715_200 }));

    expect(decision.unresolved).toEqual(['budget_curve_saturated']);
  });

  it('counts a negative return from the next rung as saturation', () => {
    const decision = shouldStopExperimenting(
      stopState({
        budgetLadder: [
          { storeBytesCap: 104_857_600, taskSuccess: 0.79 },
          { storeBytesCap: 209_715_200, taskSuccess: 0.76 }
        ]
      })
    );

    expect(decision.decision).toBe('stop');
  });

  it('reports every open axis at once rather than only the first', () => {
    const decision = shouldStopExperimenting(
      stopState({
        topArmGateStatus: 'fail',
        holdoutSuccessInterval: interval(-0.01, 0.01, 0.03),
        realHoldoutRanking: ['Hierarchical', 'TypedTemporal']
      })
    );

    expect(decision.unresolved).toEqual([
      'top_arm_passes_gates',
      'lower_bound_exceeds_sesoi',
      'ranking_stable_across_holdouts'
    ]);
    expect(decision.satisfied).toEqual([
      'latency_non_inferior',
      'cost_non_inferior',
      'budget_curve_saturated'
    ]);
  });

  it('refuses a malformed stop state', () => {
    expect(() => shouldStopExperimenting(stopState({ runnerUpArmId: 'TypedTemporal' }))).toThrow(
      DecisionRubricError
    );
    expect(() =>
      shouldStopExperimenting(
        stopState({ budgetLadder: [{ storeBytesCap: 104_857_600, taskSuccess: 0.79 }] })
      )
    ).toThrow(DecisionRubricError);
    expect(() => shouldStopExperimenting(stopState({ materialReturnThreshold: 0 }))).toThrow(
      DecisionRubricError
    );
    expect(() =>
      shouldStopExperimenting(
        stopState({
          budgetLadder: [
            { storeBytesCap: 1_024, taskSuccess: 0.5 },
            { storeBytesCap: 1_024, taskSuccess: 0.6 }
          ]
        })
      )
    ).toThrow(DecisionRubricError);
  });
});

// --- Minimum viable experiment ----------------------------------------------

describe('the minimum viable experiment preset', () => {
  it('runs exactly the four arms the report prescribes, synthetic only', () => {
    expect(MINIMUM_VIABLE_EXPERIMENT.armIds).toEqual([...MVE_ARM_IDS]);
    expect(MINIMUM_VIABLE_EXPERIMENT.armIds).toEqual([
      'FlatTag',
      'TypedBasic',
      'TypedTemporal',
      'Hierarchical'
    ]);
    expect(MINIMUM_VIABLE_EXPERIMENT.datasetSplits).toEqual(['synthetic_dev']);
  });

  it('sizes itself at 120 histories of 8-12 sessions and about 800 scored tasks', () => {
    expect(MINIMUM_VIABLE_EXPERIMENT.historyCount).toBe(120);
    expect(MINIMUM_VIABLE_EXPERIMENT.scoredTasks).toBe(800);
    // The session band is DERIVED from the medium tier's own schedule, so the preset
    // cannot drift away from the difficulty definition it claims to use.
    expect(MINIMUM_VIABLE_EXPERIMENT.sessionsPerHistory).toBe(
      DIFFICULTY_TIER_BANDS.medium.sessionCount
    );
    expect(MINIMUM_VIABLE_EXPERIMENT.sessionsPerHistory).toEqual({ min: 8, max: 12 });
    expect(MINIMUM_VIABLE_EXPERIMENT.tiers).toEqual(['medium']);
  });

  it('caps the compiled context at 1,200 tokens with one model call and proposal-only consolidation', () => {
    expect(MINIMUM_VIABLE_EXPERIMENT.budget).toBe(FROZEN_FAIRNESS_BUDGET);
    expect(MINIMUM_VIABLE_EXPERIMENT.budget.compiledContextTokenCap).toBe(1_200);
    expect(MINIMUM_VIABLE_EXPERIMENT.llmCallsPerTask).toBe(1);
    expect(MINIMUM_VIABLE_EXPERIMENT.budget.llmCallCap).toBe(1);
    expect(MINIMUM_VIABLE_EXPERIMENT.consolidationPolicy).toBe('proposal_only');
  });

  it('covers the cohorts the three MVE questions need', () => {
    expect(MINIMUM_VIABLE_EXPERIMENT.families).toEqual([
      'person_state',
      'project_state',
      'update_control',
      'reasoning',
      'multi_agent',
      'adversarial'
    ]);
    expect(MINIMUM_VIABLE_EXPERIMENT.questions).toHaveLength(3);
    expect(MINIMUM_VIABLE_EXPERIMENT.stopRule).toContain('do not add graph overlays');
  });

  it('produces a workload-generator input the generator actually accepts', () => {
    const input = mveWorkloadInput(17);

    expect(WorkloadGeneratorInputSchema.parse(input)).toEqual(input);
    expect(mveWorkloadInput(17)).toEqual(input);
    expect(mveWorkloadInput(18).seed).toBe(18);

    // Generated small so the assertion is about compatibility, not throughput.
    const workload = generateWorkload({ ...input, historyCount: 6 });
    expect(workload.items).toHaveLength(6);
    expect(new Set(workload.items.map((generated) => generated.item.tier))).toEqual(
      new Set(['medium'])
    );
  });
});
