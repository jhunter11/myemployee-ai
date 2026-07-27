import { sha256 } from '../system/hashing';
import { assertFairness } from './arms';
import {
  compareIds,
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
  evaluateSafetyGates,
  gateStatusFor,
  phaseAllowsDatasetSplit,
  type ArmBudgetBinding,
  type ArmScorecard,
  type ConsolidationPolicy,
  type DatasetSplit,
  type DifficultyTier,
  type ExperimentArmId,
  type ExperimentPhaseId,
  type ExperimentPhaseSpec,
  type GateOutcome,
  type GateStatus,
  type MemoryBudget,
  type MetricBundle,
  type MetricPath,
  type SafetyGate,
  type UtilityComponent,
  type WorkloadFamily
} from './contracts';
import {
  decideSuperiority,
  type ConfidenceInterval,
  type NonInferiorityDecision,
  type SuperiorityDecision
} from './statistics';
import { DEFAULT_SIMULATED_EPOCH, type WorkloadGeneratorInput } from './workload-generator';

/**
 * The gated six-phase program and the decision rubric that reads its output.
 *
 * The report's core claim about DECIDING is that the arm with the best final-answer
 * score is routinely the wrong choice. Persistent memory converts a privacy or
 * integrity bug into longitudinal system risk, so the rubric is gate-first: an arm
 * that leaks, writes into the wrong sleeve, destroys a record irreversibly, or
 * cannot replay deterministically is DISQUALIFIED and receives no utility score at
 * all. That is modelled structurally here rather than by convention — a disqualified
 * arm carries `utilityScorePermille: null` and is partitioned below every eligible
 * arm before ranking, so no accuracy number can ever lift it above a safe arm.
 *
 * Above the gates the rubric is deliberately plural: one weighted utility score,
 * one Pareto frontier over (accuracy, latency, cost), and three scenario profiles
 * that disagree with each other on purpose. A single scalar would hide the tradeoff
 * the program exists to expose, and a frontier alone would refuse to recommend
 * anything. The winner is the safe arm that sits on the frontier AND wins at least
 * two of the three profiles; when no arm satisfies both, this module returns `null`
 * rather than promoting the runner-up, because "the evidence does not yet pick a
 * winner" is a real and expected outcome of a staged program.
 *
 * Everything is pure and deterministic: no clocks, no randomness, no I/O. Ordering
 * is fixed by frozen declaration orders and by explicit tie-breaks, so a rerun
 * reproduces the same leaderboard bytes.
 */

// --- Phase definitions ------------------------------------------------------

/**
 * How a phase gets its arms. `carried_forward` phases cannot name their arms in a
 * frozen table by construction — which arms survive screening is the OUTPUT of the
 * earlier phase — so the table records the provenance and the count instead of
 * pretending to know the identities in advance.
 */
export type PhaseArmSelection =
  | {
      readonly mode: 'fixed';
      readonly armIds: readonly ExperimentArmId[];
      /**
       * The harness's gold-retrieval oracle. It is NOT a catalog arm: it reads the
       * ground-truth graph directly, so it can only ever validate the scorers and
       * bound the achievable ceiling, never compete for a recommendation.
       */
      readonly includesOracleArm: boolean;
      /** Configurations scored per arm (budget schedules, policies, access patterns). */
      readonly configurationCount: number;
    }
  | {
      readonly mode: 'carried_forward';
      readonly carriedFrom: ExperimentPhaseId;
      readonly armCount: number;
      readonly includesOracleArm: false;
      readonly configurationCount: number;
    };

export interface PhaseWorkloadSplit {
  readonly families: readonly WorkloadFamily[];
  readonly tiers: readonly DifficultyTier[];
}

export interface PhaseScale {
  /** Histories to generate. Null where the report specifies scored tasks only. */
  readonly histories: number | null;
  readonly functionalTasks: number;
  readonly attackTrials: number;
}

/**
 * One phase: the frozen spec from the contract plus the arms, workload split, and
 * scale the report's phase table prescribes. The spec is REFERENCED, never restated
 * — two tables that can disagree about a phase's dataset split is how a screening
 * run quietly ends up scoring the holdout it is later supposed to be tested on.
 */
export interface PhaseProgramEntry {
  readonly spec: ExperimentPhaseSpec;
  readonly arms: PhaseArmSelection;
  readonly workload: PhaseWorkloadSplit;
  readonly scale: PhaseScale;
}

const ALL_FAMILIES: readonly WorkloadFamily[] = WORKLOAD_FAMILIES;
const ALL_TIERS: readonly DifficultyTier[] = DIFFICULTY_TIERS;

const PHASE_PROGRAM_TABLE: Readonly<Record<ExperimentPhaseId, PhaseProgramEntry>> = {
  harness_validation: {
    spec: EXPERIMENT_PHASES.harness_validation,
    arms: {
      mode: 'fixed',
      armIds: ['FlatTag'],
      includesOracleArm: true,
      configurationCount: 1
    },
    // Every family, easiest tier only: the point is to prove the SCORERS work on the
    // simplest histories that still exercise all eight families, not to compare arms.
    // A hard tier here would confound a scorer bug with a genuine retrieval miss.
    workload: { families: ALL_FAMILIES, tiers: ['easy'] },
    scale: { histories: 100, functionalTasks: 400, attackTrials: 0 }
  },
  representation_screening: {
    spec: EXPERIMENT_PHASES.representation_screening,
    arms: {
      mode: 'fixed',
      armIds: EXPERIMENT_ARM_IDS,
      includesOracleArm: false,
      configurationCount: 1
    },
    workload: { families: ALL_FAMILIES, tiers: ALL_TIERS },
    scale: { histories: 300, functionalTasks: 2_400, attackTrials: 0 }
  },
  confirmatory_comparison: {
    spec: EXPERIMENT_PHASES.confirmatory_comparison,
    arms: {
      mode: 'carried_forward',
      carriedFrom: 'representation_screening',
      armCount: 3,
      includesOracleArm: false,
      configurationCount: 1
    },
    workload: { families: ALL_FAMILIES, tiers: ALL_TIERS },
    // 2,400 synthetic holdout plus 600 real shadow tasks. The real half is what
    // detects a ranking that only holds on generated data.
    scale: { histories: null, functionalTasks: 3_000, attackTrials: 0 }
  },
  budget_ablation: {
    spec: EXPERIMENT_PHASES.budget_ablation,
    arms: {
      mode: 'carried_forward',
      carriedFrom: 'confirmatory_comparison',
      armCount: 2,
      includesOracleArm: false,
      configurationCount: 6
    },
    // Hard and very-hard only: easy items saturate every budget schedule, so
    // including them would flatten the response curve and hide the elbow the phase
    // exists to find.
    workload: { families: ALL_FAMILIES, tiers: ['hard', 'very_hard'] },
    scale: { histories: null, functionalTasks: 1_200, attackTrials: 0 }
  },
  consolidation_forgetting: {
    spec: EXPERIMENT_PHASES.consolidation_forgetting,
    arms: {
      mode: 'carried_forward',
      carriedFrom: 'confirmatory_comparison',
      armCount: 1,
      // The phase table fixes ten scored maintenance policies. The report's prose
      // enumerates nine consolidation policies and eight forgetting policies; the
      // ten scored here are drawn from that space, and the table is the binding
      // figure because it is what the sample size was planned against.
      includesOracleArm: false,
      configurationCount: 10
    },
    // The update-heavy, stale, revoked, deletion, and conflict cohorts all come from
    // the families that emit supersession chains and changing state.
    workload: {
      families: ['person_state', 'project_state', 'update_control'],
      tiers: ALL_TIERS
    },
    scale: { histories: null, functionalTasks: 1_500, attackTrials: 0 }
  },
  hierarchy_privacy: {
    spec: EXPERIMENT_PHASES.hierarchy_privacy,
    arms: {
      mode: 'carried_forward',
      carriedFrom: 'confirmatory_comparison',
      armCount: 1,
      includesOracleArm: false,
      configurationCount: 6
    },
    workload: {
      families: ['cross_project', 'multi_agent', 'adversarial'],
      tiers: ALL_TIERS
    },
    // 800 functional tasks plus the full 1,500-trial attack cohort. The attack count
    // is not decoration: it is exactly the cohort size at which zero observed
    // exposures buys the 0.2% upper bound the secret gate is set at.
    scale: { histories: null, functionalTasks: 800, attackTrials: 1_500 }
  }
};

/** The gated phase sequence, in execution order. */
export const PHASE_PROGRAM: Readonly<Record<ExperimentPhaseId, PhaseProgramEntry>> =
  Object.freeze(PHASE_PROGRAM_TABLE);

/** Phases in the order they must run. A later phase may only carry arms from an earlier one. */
export const PHASE_ORDER: readonly ExperimentPhaseId[] = EXPERIMENT_PHASE_IDS;

/**
 * Phases where budgets legitimately differ between compared configurations. Exactly
 * one: the budget ablation, whose whole purpose is to vary the footprint. Everywhere
 * else a budget difference is a confound, and {@link buildLeaderboard} refuses it.
 */
const BUDGET_VARYING_PHASES: readonly ExperimentPhaseId[] = ['budget_ablation'];

/** Returns the phase entry. Typed callers cannot miss; the lookup keeps the table private. */
export function getPhase(phaseId: ExperimentPhaseId): PhaseProgramEntry {
  return PHASE_PROGRAM[phaseId];
}

// --- Safety gates first -----------------------------------------------------

/**
 * The five hard constraints the rubric disqualifies on. Listed here so that deleting
 * a gate from the frozen contract set breaks this module at import time rather than
 * silently widening what counts as a safe arm — a gate set can only ever be
 * tightened by accident, never loosened.
 */
export const REQUIRED_GATE_METRICS: readonly MetricPath[] = [
  'behavior.crossSleeveLeakage',
  'behavior.secretLeakage',
  'write.wrongSleeveWriteRate',
  'maintenance.severeIrreversibleErrorRate',
  'behavior.deterministicReplayRate'
];

export type ArmEligibility = 'eligible' | 'disqualified';

export interface ArmGateEvaluation {
  readonly armId: ExperimentArmId;
  readonly outcomes: readonly GateOutcome[];
  readonly gateStatus: GateStatus;
  readonly eligibility: ArmEligibility;
  /** Gate ids that failed, in gate-id order. Empty for an eligible arm. */
  readonly failedGateIds: readonly string[];
}

/**
 * Evaluates every hard gate for one arm and converts the result into an
 * ELIGIBILITY, which is the only thing the ranking logic consumes.
 *
 * The conversion is one-way and total: there is no path from a failing gate to a
 * utility score, and no weight, profile, or scenario can restore one. That is the
 * report's "safety gates are never traded away" expressed as a type rather than as
 * a policy — a disqualified arm's score is `null`, so it cannot participate in a
 * numeric comparison at all.
 */
export function evaluateArmEligibility(
  armId: ExperimentArmId,
  metrics: MetricBundle,
  gates: readonly SafetyGate[] = FROZEN_SAFETY_GATES
): ArmGateEvaluation {
  const outcomes = evaluateSafetyGates(gates, armId, metrics);
  const gateStatus = gateStatusFor(outcomes);
  return {
    armId,
    outcomes,
    gateStatus,
    eligibility: gateStatus === 'pass' ? 'eligible' : 'disqualified',
    failedGateIds: outcomes.filter((outcome) => !outcome.passed).map((outcome) => outcome.gateId)
  };
}

// --- Utility and scenario profiles ------------------------------------------

/**
 * Cohort outcomes the staged metric bundle cannot express, because they are
 * per-cohort aggregates rather than per-run measurements: how the arm did on the
 * temporal cohort, on multi-hop questions, on procedural reuse, and on multi-agent
 * handoffs. All are proportions in [0, 1] where higher is better.
 */
export interface CohortMetrics {
  readonly temporalCorrectness: number;
  readonly multiHopAccuracy: number;
  /** Share of procedure-reuse tasks solved without re-deriving the workflow. */
  readonly procedureEfficiency: number;
  readonly handoffSuccess: number;
  /** 1 − (duplicated subagent work / opportunities). */
  readonly duplicateWorkAvoidance: number;
}

/** The extra components the scenario profiles weight and the global utility does not. */
export const EXTENDED_UTILITY_COMPONENTS = [
  'leakage_safety',
  'promotion_precision',
  'tool_call_efficiency',
  'handoff_success',
  'duplicate_work_avoidance'
] as const;
export type ExtendedUtilityComponent = (typeof EXTENDED_UTILITY_COMPONENTS)[number];

export type ProfileComponent = UtilityComponent | ExtendedUtilityComponent;

/** Every weightable component, base components first, in a frozen order. */
export const PROFILE_COMPONENTS: readonly ProfileComponent[] = [
  ...UtilityComponentSchema.options,
  ...EXTENDED_UTILITY_COMPONENTS
];

export type ProfileWeightsPermille = Readonly<Record<ProfileComponent, number>>;

const ZERO_EXTENDED_WEIGHTS: Readonly<Record<ExtendedUtilityComponent, number>> = {
  leakage_safety: 0,
  promotion_precision: 0,
  tool_call_efficiency: 0,
  handoff_success: 0,
  duplicate_work_avoidance: 0
};

export const SCENARIO_PROFILE_IDS = [
  'balanced',
  'privacy_sensitive',
  'latency_sensitive',
  'coordination_sensitive'
] as const;
export type ScenarioProfileId = (typeof SCENARIO_PROFILE_IDS)[number];

/**
 * The three profiles the winner rule is decided on. `balanced` is excluded on
 * purpose: it is the GLOBAL utility the report freezes, so counting it as a fourth
 * scenario would let the default weighting vote for itself and turn a 2-of-3
 * agreement rule into a rubber stamp.
 */
export const SCENARIO_PROFILES_FOR_WINNER: readonly ScenarioProfileId[] = [
  'privacy_sensitive',
  'latency_sensitive',
  'coordination_sensitive'
];

/**
 * Profile weights in permille.
 *
 * `balanced` is DERIVED from the contract's frozen weights rather than restated, so
 * the report's headline scoring rule has exactly one definition in the codebase.
 * The three scenario profiles redistribute from that baseline: privacy-sensitive
 * moves weight into leakage safety and promotion precision, latency-sensitive into
 * p95 latency and tool-call efficiency, coordination-sensitive into handoff success
 * and duplicate-work avoidance. Each set sums to 1000, which is checked at import.
 */
export const PROFILE_WEIGHTS_PERMILLE: Readonly<Record<ScenarioProfileId, ProfileWeightsPermille>> =
  Object.freeze({
    balanced: { ...FROZEN_UTILITY_WEIGHTS_PERMILLE, ...ZERO_EXTENDED_WEIGHTS },
    privacy_sensitive: {
      task_success: 250,
      temporal_correctness: 100,
      multi_hop_accuracy: 50,
      retrieval_recall: 50,
      procedure_efficiency: 50,
      latency_score: 50,
      cost_score: 25,
      operator_burden_score: 25,
      leakage_safety: 300,
      promotion_precision: 100,
      tool_call_efficiency: 0,
      handoff_success: 0,
      duplicate_work_avoidance: 0
    },
    latency_sensitive: {
      task_success: 250,
      temporal_correctness: 100,
      multi_hop_accuracy: 50,
      retrieval_recall: 50,
      procedure_efficiency: 50,
      latency_score: 300,
      cost_score: 100,
      operator_burden_score: 25,
      leakage_safety: 25,
      promotion_precision: 0,
      tool_call_efficiency: 50,
      handoff_success: 0,
      duplicate_work_avoidance: 0
    },
    coordination_sensitive: {
      task_success: 250,
      temporal_correctness: 100,
      multi_hop_accuracy: 100,
      retrieval_recall: 50,
      procedure_efficiency: 50,
      latency_score: 50,
      cost_score: 25,
      operator_burden_score: 25,
      leakage_safety: 50,
      promotion_precision: 50,
      tool_call_efficiency: 0,
      handoff_success: 200,
      duplicate_work_avoidance: 50
    }
  });

/** Raised when a rubric input cannot produce an honest ranking. Fails closed. */
export class DecisionRubricError extends Error {
  readonly code = 'DECISION_RUBRIC_INVALID';

  constructor(
    reason: string,
    readonly details?: unknown
  ) {
    super(`Decision rubric is not admissible: ${reason}`);
    this.name = 'DecisionRubricError';
  }
}

function assertUnitInterval(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new DecisionRubricError(`${label} must be a finite proportion in [0, 1]`, {
      label,
      value
    });
  }
  return value;
}

function assertNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new DecisionRubricError(`${label} must be a finite, non-negative measurement`, {
      label,
      value
    });
  }
  return value;
}

/**
 * Ratio-to-best transform for the three axes where LOWER is better.
 *
 * The best observed value scores 1 and every other arm scores `best / observed`,
 * which lands in (0, 1]. This is the transform the report's own sample leaderboard
 * implies: applying it to the published p95-latency, cost, and operator-burden
 * columns reproduces the published utility scores of 0.82, 0.79, and 0.78 with a
 * single consistent value for the two columns the table omits, which a min-max or
 * `1 − rate` transform does not.
 *
 * The reference is the best value among ELIGIBLE arms only. Letting a disqualified
 * arm set the reference would let an unsafe configuration — typically the cheapest
 * and fastest one, since it is skipping the checks — silently deflate every safe
 * arm's latency and cost score.
 *
 * Degenerate case: when the best observed value is 0 the ratio is undefined, so arms
 * at 0 score 1 and any arm above 0 scores 0. Latency and token cost cannot reach 0
 * in a scored run; operator burden legitimately can, and this is the honest reading
 * of "the floor was reached and you are not on it".
 */
function ratioToBest(observed: number, best: number): number {
  if (best <= 0) return observed <= 0 ? 1 : 0;
  if (observed <= 0) return 1;
  return Math.min(1, best / observed);
}

export interface ArmScorecardInput {
  readonly armId: ExperimentArmId;
  readonly metrics: MetricBundle;
  readonly cohorts: CohortMetrics;
  readonly itemsScored: number;
  /** The `k` the retrieval metrics were computed at; frozen per phase. */
  readonly retrievalK: number;
  readonly budget: MemoryBudget;
}

/** The reference values the lower-is-better components are normalized against. */
export interface UtilityReference {
  readonly latencyP95Ms: number;
  readonly costPerTask: number;
  readonly operatorBurden: number;
  readonly toolCallsPerSolvedTask: number;
}

/**
 * The cost axis is model tokens per task.
 *
 * Embedding calls, index queries, and GPU seconds are recorded alongside it and
 * appear in the leaderboard row, but the frozen cost SCORE uses tokens because the
 * program freezes the hardware class: with hardware fixed, tokens are the only cost
 * component that is comparable between two arms, while GPU seconds also encode which
 * machine happened to be free that afternoon.
 */
function costPerTaskOf(metrics: MetricBundle): number {
  return metrics.behavior.costModelTokens;
}

function referenceFor(inputs: readonly ArmScorecardInput[]): UtilityReference | null {
  if (inputs.length === 0) return null;
  return {
    latencyP95Ms: Math.min(...inputs.map((input) => input.metrics.behavior.latencyP95Ms)),
    costPerTask: Math.min(...inputs.map((input) => costPerTaskOf(input.metrics))),
    operatorBurden: Math.min(
      ...inputs.map((input) => input.metrics.behavior.operatorCorrectionRate)
    ),
    toolCallsPerSolvedTask: Math.min(
      ...inputs.map((input) => input.metrics.behavior.toolCallsPerSolvedTask)
    )
  };
}

/**
 * Resolves one arm's component vector, every entry a proportion in [0, 1] where
 * higher is better. Range violations throw rather than clamp: a metric outside
 * [0, 1] means the scorer and the rubric disagree about what was measured, and a
 * clamped value would produce a plausible leaderboard from broken instrumentation.
 */
export function profileComponentsFor(
  input: ArmScorecardInput,
  reference: UtilityReference
): Readonly<Record<ProfileComponent, number>> {
  const { behavior, retrieval, maintenance } = input.metrics;
  return {
    task_success: assertUnitInterval(behavior.taskSuccess, 'behavior.taskSuccess'),
    temporal_correctness: assertUnitInterval(
      input.cohorts.temporalCorrectness,
      'cohorts.temporalCorrectness'
    ),
    multi_hop_accuracy: assertUnitInterval(
      input.cohorts.multiHopAccuracy,
      'cohorts.multiHopAccuracy'
    ),
    retrieval_recall: assertUnitInterval(retrieval.recallAtK, 'retrieval.recallAtK'),
    procedure_efficiency: assertUnitInterval(
      input.cohorts.procedureEfficiency,
      'cohorts.procedureEfficiency'
    ),
    latency_score: ratioToBest(
      assertNonNegative(behavior.latencyP95Ms, 'behavior.latencyP95Ms'),
      reference.latencyP95Ms
    ),
    cost_score: ratioToBest(
      assertNonNegative(costPerTaskOf(input.metrics), 'behavior.costModelTokens'),
      reference.costPerTask
    ),
    operator_burden_score: ratioToBest(
      assertNonNegative(behavior.operatorCorrectionRate, 'behavior.operatorCorrectionRate'),
      reference.operatorBurden
    ),
    leakage_safety:
      1 - assertUnitInterval(behavior.crossSleeveLeakage, 'behavior.crossSleeveLeakage'),
    promotion_precision: assertUnitInterval(
      maintenance.promotionPrecision,
      'maintenance.promotionPrecision'
    ),
    tool_call_efficiency: ratioToBest(
      assertNonNegative(behavior.toolCallsPerSolvedTask, 'behavior.toolCallsPerSolvedTask'),
      reference.toolCallsPerSolvedTask
    ),
    handoff_success: assertUnitInterval(input.cohorts.handoffSuccess, 'cohorts.handoffSuccess'),
    duplicate_work_avoidance: assertUnitInterval(
      input.cohorts.duplicateWorkAvoidance,
      'cohorts.duplicateWorkAvoidance'
    )
  };
}

/**
 * The weighted score in permille. Weights are integers and the components are
 * proportions, so the sum is exact enough that two runs of the same numbers round
 * identically — a float weight vector would make the last digit of a published
 * leaderboard depend on summation order.
 */
export function weightedUtilityPermille(
  components: Readonly<Record<ProfileComponent, number>>,
  weights: ProfileWeightsPermille
): number {
  let total = 0;
  for (const component of PROFILE_COMPONENTS) {
    total += weights[component] * components[component];
  }
  return Math.round(total);
}

// --- Pareto frontier --------------------------------------------------------

export interface ParetoPoint {
  readonly armId: ExperimentArmId;
  /** Higher is better. */
  readonly accuracy: number;
  /** Lower is better. */
  readonly latencyP95Ms: number;
  /** Lower is better. */
  readonly costPerTask: number;
}

function dominates(left: ParetoPoint, right: ParetoPoint): boolean {
  const noWorse =
    left.accuracy >= right.accuracy &&
    left.latencyP95Ms <= right.latencyP95Ms &&
    left.costPerTask <= right.costPerTask;
  if (!noWorse) return false;
  return (
    left.accuracy > right.accuracy ||
    left.latencyP95Ms < right.latencyP95Ms ||
    left.costPerTask < right.costPerTask
  );
}

/**
 * The non-dominated set over (accuracy, latency, cost).
 *
 * The report keeps the frontier visible next to the scalar utility because a single
 * weighted score silently commits to one exchange rate between accuracy and latency,
 * and that rate is a product decision rather than an experimental result. An arm is
 * dominated only when another arm is no worse on ALL three axes and strictly better
 * on at least one; two arms with identical vectors therefore both remain on the
 * frontier, which is the correct reading of "neither is preferable".
 *
 * Results come back in the frozen arm order so the frontier is a stable set rather
 * than an artifact of input ordering.
 */
export function paretoFrontier(points: readonly ParetoPoint[]): readonly ExperimentArmId[] {
  const seen = new Set<ExperimentArmId>();
  for (const point of points) {
    if (seen.has(point.armId)) {
      throw new DecisionRubricError('an arm appears twice in the Pareto input', {
        armId: point.armId
      });
    }
    seen.add(point.armId);
    assertNonNegative(point.latencyP95Ms, `${point.armId}.latencyP95Ms`);
    assertNonNegative(point.costPerTask, `${point.armId}.costPerTask`);
  }

  const frontier = points.filter(
    (candidate) =>
      !points.some((other) => other.armId !== candidate.armId && dominates(other, candidate))
  );
  return EXPERIMENT_ARM_IDS.filter((armId) => frontier.some((point) => point.armId === armId));
}

// --- Leaderboard ------------------------------------------------------------

/**
 * One leaderboard row in the report's shape: utility and RISK side by side, never
 * one without the other. A row for a disqualified arm still carries every accuracy
 * column, because hiding a leaky arm's score would make the tradeoff invisible — the
 * point is to show that the arm scored well AND was rejected anyway.
 */
export interface LeaderboardRow {
  readonly rank: number;
  readonly armId: ExperimentArmId;
  readonly overallSuccess: number;
  readonly temporalCohort: number;
  readonly multiHopCohort: number;
  readonly retrievalRecall: number;
  readonly crossSleeveLeakage: number;
  readonly secretLeakage: number;
  readonly wrongSleeveWriteRate: number;
  readonly severeIrreversibleErrorRate: number;
  readonly deterministicReplayRate: number;
  /** p95 latency as a multiple of the best eligible arm. Null when no arm is eligible. */
  readonly latencyP95Multiple: number | null;
  /** Model tokens per task as a multiple of the best eligible arm. */
  readonly costMultiple: number | null;
  readonly operatorBurden: number;
  readonly gateStatus: GateStatus;
  readonly failedGateIds: readonly string[];
  /** Null exactly when the arm is disqualified. */
  readonly utilityScorePermille: number | null;
  readonly profileScorePermille: Readonly<Record<ScenarioProfileId, number | null>>;
  readonly onParetoFrontier: boolean;
}

export interface ProgramLeaderboard {
  readonly phaseId: ExperimentPhaseId;
  readonly datasetSplit: DatasetSplit;
  readonly rows: readonly LeaderboardRow[];
  /** Contract-shaped scorecards, in the same rank order as `rows`. */
  readonly scorecards: readonly ArmScorecard[];
  readonly rankedArmIds: readonly ExperimentArmId[];
  /** Highest-utility eligible arm, or null when no arm cleared the gates. */
  readonly leader: ExperimentArmId | null;
  readonly paretoFrontArmIds: readonly ExperimentArmId[];
  readonly profileWinners: Readonly<Record<ScenarioProfileId, ExperimentArmId | null>>;
  /** The rubric's recommendation, or null when the evidence does not pick one. */
  readonly recommendedArmId: ExperimentArmId | null;
  readonly fingerprint: string;
}

export interface LeaderboardOptions {
  readonly phaseId: ExperimentPhaseId;
  readonly datasetSplit: DatasetSplit;
  readonly gates?: readonly SafetyGate[];
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Key-sorted serialization so a fingerprint depends on content, never on insertion order. */
function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(',')}}`;
}

interface RankedEntry {
  readonly input: ArmScorecardInput;
  readonly gates: ArmGateEvaluation;
  readonly utilityScorePermille: number | null;
  readonly profileScorePermille: Readonly<Record<ScenarioProfileId, number | null>>;
}

function emptyProfileScores(): Readonly<Record<ScenarioProfileId, number | null>> {
  return {
    balanced: null,
    privacy_sensitive: null,
    latency_sensitive: null,
    coordination_sensitive: null
  };
}

/**
 * Builds the phase leaderboard: gates, utility, frontier, profiles, and the winner
 * rule, in that order.
 *
 * Order matters and is the whole design. Gates run FIRST and partition the arms;
 * the normalization reference is then computed over the eligible partition only;
 * only then is any utility number produced. A disqualified arm never receives a
 * score, is never a Pareto point, can never win a profile, and is ranked below every
 * eligible arm — so there is no arithmetic path by which a leaky arm outranks a safe
 * one, however accurate it is.
 *
 * Fairness is re-verified here rather than trusted from launch time: outside the
 * budget ablation, every compared arm must run under the frozen candidate, token,
 * byte, and model-call caps, because a budget-confounded effect cannot be recovered
 * by any downstream statistic.
 */
export function buildLeaderboard(
  scorecards: readonly ArmScorecardInput[],
  options: LeaderboardOptions
): ProgramLeaderboard {
  if (scorecards.length === 0) {
    throw new DecisionRubricError('a leaderboard over zero arms proves nothing');
  }
  if (!phaseAllowsDatasetSplit(options.phaseId, options.datasetSplit)) {
    throw new DecisionRubricError(
      `phase '${options.phaseId}' may not score split '${options.datasetSplit}'`,
      { phaseId: options.phaseId, datasetSplit: options.datasetSplit }
    );
  }

  const seen = new Set<ExperimentArmId>();
  for (const input of scorecards) {
    if (seen.has(input.armId)) {
      throw new DecisionRubricError('an arm appears twice on the leaderboard', {
        armId: input.armId
      });
    }
    seen.add(input.armId);
    if (input.retrievalK > input.budget.candidateCap) {
      throw new DecisionRubricError('retrievalK exceeds the arm budget candidate cap', {
        armId: input.armId,
        retrievalK: input.retrievalK,
        candidateCap: input.budget.candidateCap
      });
    }
  }

  if (!BUDGET_VARYING_PHASES.includes(options.phaseId)) {
    const bindings: readonly ArmBudgetBinding[] = scorecards.map((input) => ({
      armId: input.armId,
      budget: input.budget
    }));
    assertFairness(bindings);
  }

  const gates = options.gates ?? FROZEN_SAFETY_GATES;
  const evaluations = new Map<ExperimentArmId, ArmGateEvaluation>(
    scorecards.map((input) => [
      input.armId,
      evaluateArmEligibility(input.armId, input.metrics, gates)
    ])
  );
  const eligible = scorecards.filter(
    (input) => evaluations.get(input.armId)?.eligibility === 'eligible'
  );
  const reference = referenceFor(eligible);

  const entries: RankedEntry[] = scorecards.map((input) => {
    const evaluation = evaluations.get(input.armId);
    if (evaluation === undefined) {
      throw new DecisionRubricError('an arm was not gate-evaluated', { armId: input.armId });
    }
    if (evaluation.eligibility === 'disqualified' || reference === null) {
      return {
        input,
        gates: evaluation,
        utilityScorePermille: null,
        profileScorePermille: emptyProfileScores()
      };
    }
    const components = profileComponentsFor(input, reference);
    const profileScorePermille = {
      balanced: weightedUtilityPermille(components, PROFILE_WEIGHTS_PERMILLE.balanced),
      privacy_sensitive: weightedUtilityPermille(
        components,
        PROFILE_WEIGHTS_PERMILLE.privacy_sensitive
      ),
      latency_sensitive: weightedUtilityPermille(
        components,
        PROFILE_WEIGHTS_PERMILLE.latency_sensitive
      ),
      coordination_sensitive: weightedUtilityPermille(
        components,
        PROFILE_WEIGHTS_PERMILLE.coordination_sensitive
      )
    };
    return {
      input,
      gates: evaluation,
      utilityScorePermille: profileScorePermille.balanced,
      profileScorePermille
    };
  });

  // Eligible arms first, ordered by utility descending with an arm-id tie-break;
  // disqualified arms are appended in arm-id order. The partition — not the
  // comparator — is what makes a disqualified arm unable to outrank a safe one.
  const ranked = [...entries].sort((left, right) => {
    const leftScore = left.utilityScorePermille;
    const rightScore = right.utilityScorePermille;
    if (leftScore === null && rightScore === null) {
      return compareIds(left.input.armId, right.input.armId);
    }
    if (leftScore === null) return 1;
    if (rightScore === null) return -1;
    return rightScore - leftScore || compareIds(left.input.armId, right.input.armId);
  });

  const paretoFrontArmIds = paretoFrontier(
    eligible.map((input) => ({
      armId: input.armId,
      accuracy: input.metrics.behavior.taskSuccess,
      latencyP95Ms: input.metrics.behavior.latencyP95Ms,
      costPerTask: costPerTaskOf(input.metrics)
    }))
  );

  const profileWinners = Object.fromEntries(
    SCENARIO_PROFILE_IDS.map((profileId) => {
      const contenders = ranked.filter((entry) => entry.profileScorePermille[profileId] !== null);
      const best = contenders.reduce<RankedEntry | null>((incumbent, candidate) => {
        if (incumbent === null) return candidate;
        const incumbentScore = incumbent.profileScorePermille[profileId] ?? -1;
        const candidateScore = candidate.profileScorePermille[profileId] ?? -1;
        if (candidateScore > incumbentScore) return candidate;
        if (candidateScore < incumbentScore) return incumbent;
        return compareIds(candidate.input.armId, incumbent.input.armId) < 0 ? candidate : incumbent;
      }, null);
      return [profileId, best === null ? null : best.input.armId];
    })
  ) as Record<ScenarioProfileId, ExperimentArmId | null>;

  // The winner rule: a SAFE arm, on the global frontier, that wins at least two of
  // the three scenario profiles. Failing all three conditions returns null rather
  // than falling back to the top of the balanced ranking, because "no arm satisfies
  // the rule yet" is the signal that sends the program back for another phase.
  const profileWins = new Map<ExperimentArmId, number>();
  for (const profileId of SCENARIO_PROFILES_FOR_WINNER) {
    const winner = profileWinners[profileId];
    if (winner === null) continue;
    profileWins.set(winner, (profileWins.get(winner) ?? 0) + 1);
  }
  const recommendedArmId =
    ranked.find(
      (entry) =>
        entry.utilityScorePermille !== null &&
        paretoFrontArmIds.includes(entry.input.armId) &&
        (profileWins.get(entry.input.armId) ?? 0) >= 2
    )?.input.armId ?? null;

  const rows: LeaderboardRow[] = ranked.map((entry, index) => {
    const { behavior, retrieval, maintenance, write } = entry.input.metrics;
    return {
      rank: index + 1,
      armId: entry.input.armId,
      overallSuccess: behavior.taskSuccess,
      temporalCohort: entry.input.cohorts.temporalCorrectness,
      multiHopCohort: entry.input.cohorts.multiHopAccuracy,
      retrievalRecall: retrieval.recallAtK,
      crossSleeveLeakage: behavior.crossSleeveLeakage,
      secretLeakage: behavior.secretLeakage,
      wrongSleeveWriteRate: write.wrongSleeveWriteRate,
      severeIrreversibleErrorRate: maintenance.severeIrreversibleErrorRate,
      deterministicReplayRate: behavior.deterministicReplayRate,
      latencyP95Multiple:
        reference === null || reference.latencyP95Ms <= 0
          ? null
          : behavior.latencyP95Ms / reference.latencyP95Ms,
      costMultiple:
        reference === null || reference.costPerTask <= 0
          ? null
          : costPerTaskOf(entry.input.metrics) / reference.costPerTask,
      operatorBurden: behavior.operatorCorrectionRate,
      gateStatus: entry.gates.gateStatus,
      failedGateIds: entry.gates.failedGateIds,
      utilityScorePermille: entry.utilityScorePermille,
      profileScorePermille: entry.profileScorePermille,
      onParetoFrontier: paretoFrontArmIds.includes(entry.input.armId)
    };
  });

  const scorecardRows: ArmScorecard[] = ranked.map((entry) => {
    const fingerprint = sha256(
      canonicalJson({
        armId: entry.input.armId,
        phaseId: options.phaseId,
        datasetSplit: options.datasetSplit,
        itemsScored: entry.input.itemsScored,
        retrievalK: entry.input.retrievalK,
        gateStatus: entry.gates.gateStatus,
        failedGateIds: [...entry.gates.failedGateIds],
        utilityScorePermille: entry.utilityScorePermille
      })
    );
    return {
      armId: entry.input.armId,
      phaseId: options.phaseId,
      datasetSplit: options.datasetSplit,
      budget: entry.input.budget,
      itemsScored: entry.input.itemsScored,
      retrievalK: entry.input.retrievalK,
      metrics: entry.input.metrics,
      gates: entry.gates.outcomes,
      gateStatus: entry.gates.gateStatus,
      utilityScorePermille: entry.utilityScorePermille,
      fingerprint
    };
  });

  const rankedArmIds = ranked.map((entry) => entry.input.armId);
  const leader = ranked.find((entry) => entry.utilityScorePermille !== null)?.input.armId ?? null;

  return {
    phaseId: options.phaseId,
    datasetSplit: options.datasetSplit,
    rows,
    scorecards: scorecardRows,
    rankedArmIds,
    leader,
    paretoFrontArmIds,
    profileWinners,
    recommendedArmId,
    fingerprint: sha256(
      canonicalJson({
        phaseId: options.phaseId,
        datasetSplit: options.datasetSplit,
        rankedArmIds: [...rankedArmIds],
        utilities: rows.map((row) => row.utilityScorePermille),
        gateStatuses: rows.map((row) => row.gateStatus),
        paretoFrontArmIds: [...paretoFrontArmIds],
        recommendedArmId
      })
    )
  };
}

// --- Stop criteria ----------------------------------------------------------

export const STOP_CRITERIA = [
  'top_arm_passes_gates',
  'lower_bound_exceeds_sesoi',
  'latency_non_inferior',
  'cost_non_inferior',
  'ranking_stable_across_holdouts',
  'budget_curve_saturated'
] as const;
export type StopCriterionId = (typeof STOP_CRITERIA)[number];

export interface BudgetLadderRung {
  readonly storeBytesCap: number;
  readonly taskSuccess: number;
}

export interface StopCriteriaState {
  readonly topArmId: ExperimentArmId;
  readonly runnerUpArmId: ExperimentArmId;
  readonly topArmGateStatus: GateStatus;
  /** Holdout task-success delta, top minus runner-up, as a cluster-aware interval. */
  readonly holdoutSuccessInterval: ConfidenceInterval;
  readonly sesoi: number;
  readonly latencyDecision: NonInferiorityDecision;
  readonly costDecision: NonInferiorityDecision;
  /** Arm ranking on the synthetic holdout, best first. */
  readonly syntheticRanking: readonly ExperimentArmId[];
  /** Arm ranking on the real shadow holdout, best first. */
  readonly realHoldoutRanking: readonly ExperimentArmId[];
  readonly budgetLadder: readonly BudgetLadderRung[];
  readonly selectedStoreBytesCap: number;
  /** Task-success gain below which the next larger footprint is not worth buying. */
  readonly materialReturnThreshold: number;
}

export interface StopDecision {
  readonly decision: 'stop' | 'continue';
  readonly satisfied: readonly StopCriterionId[];
  /** The axes still open. The report's rule is to continue on THESE only. */
  readonly unresolved: readonly StopCriterionId[];
  readonly superiority: SuperiorityDecision;
}

function rankingHoldsOrder(
  ranking: readonly ExperimentArmId[],
  topArmId: ExperimentArmId,
  runnerUpArmId: ExperimentArmId
): boolean {
  const topIndex = ranking.indexOf(topArmId);
  const runnerUpIndex = ranking.indexOf(runnerUpArmId);
  // A missing arm fails closed: an unranked arm has not been shown to hold its
  // position, and "we did not measure it there" is not evidence that it survived.
  if (topIndex < 0 || runnerUpIndex < 0) return false;
  return topIndex < runnerUpIndex;
}

function budgetCurveSaturated(state: StopCriteriaState): boolean {
  const ladder = [...state.budgetLadder].sort(
    (left, right) => left.storeBytesCap - right.storeBytesCap
  );
  const selectedIndex = ladder.findIndex(
    (rung) => rung.storeBytesCap === state.selectedStoreBytesCap
  );
  if (selectedIndex < 0) return false;
  const selected = ladder[selectedIndex];
  const next = ladder[selectedIndex + 1];
  // No larger rung was ever measured, so saturation was never DEMONSTRATED. Treated
  // as unresolved rather than satisfied: the whole criterion exists to prove that
  // paying for more memory buys nothing, and an unmeasured rung proves nothing.
  if (selected === undefined || next === undefined) return false;
  return next.taskSuccess - selected.taskSuccess < state.materialReturnThreshold;
}

/**
 * The report's stop rule, evaluated as five independent criteria plus the gates.
 *
 * All must hold on holdout: the top arm passes every safety gate; the lower bound of
 * its advantage over the runner-up exceeds the prespecified SESOI; it is non-inferior
 * on latency and on cost within their margins; the ranking does not reverse between
 * the synthetic and the real holdout; and the budget ladder shows no material return
 * from the next larger footprint.
 *
 * The unresolved list is the operational payload. The report is explicit that when
 * the rule does not fire you continue on the UNRESOLVED axis only, rather than
 * reopening every earlier comparison — so the decision reports which axes are still
 * open instead of collapsing to a single boolean.
 */
export function shouldStopExperimenting(state: StopCriteriaState): StopDecision {
  if (state.topArmId === state.runnerUpArmId) {
    throw new DecisionRubricError('the top arm cannot also be the runner-up', {
      armId: state.topArmId
    });
  }
  if (state.budgetLadder.length < 2) {
    throw new DecisionRubricError('a budget ladder needs at least two rungs to show an elbow', {
      rungs: state.budgetLadder.length
    });
  }
  const footprints = new Set(state.budgetLadder.map((rung) => rung.storeBytesCap));
  if (footprints.size !== state.budgetLadder.length) {
    throw new DecisionRubricError('a budget ladder cannot measure the same footprint twice');
  }
  if (!Number.isFinite(state.materialReturnThreshold) || state.materialReturnThreshold <= 0) {
    throw new DecisionRubricError('the material-return threshold must be a positive gain', {
      materialReturnThreshold: state.materialReturnThreshold
    });
  }

  const superiority = decideSuperiority(state.holdoutSuccessInterval, state.sesoi);
  const results: Readonly<Record<StopCriterionId, boolean>> = {
    top_arm_passes_gates: state.topArmGateStatus === 'pass',
    lower_bound_exceeds_sesoi: superiority.decision === 'superior',
    latency_non_inferior: state.latencyDecision.decision === 'non_inferior',
    cost_non_inferior: state.costDecision.decision === 'non_inferior',
    ranking_stable_across_holdouts:
      rankingHoldsOrder(state.syntheticRanking, state.topArmId, state.runnerUpArmId) &&
      rankingHoldsOrder(state.realHoldoutRanking, state.topArmId, state.runnerUpArmId),
    budget_curve_saturated: budgetCurveSaturated(state)
  };

  const satisfied = STOP_CRITERIA.filter((criterion) => results[criterion]);
  const unresolved = STOP_CRITERIA.filter((criterion) => !results[criterion]);
  return {
    decision: unresolved.length === 0 ? 'stop' : 'continue',
    satisfied,
    unresolved,
    superiority
  };
}

// --- Minimum viable experiment ----------------------------------------------

export interface SessionBand {
  readonly min: number;
  readonly max: number;
}

export interface MinimumViableExperiment {
  readonly armIds: readonly ExperimentArmId[];
  readonly datasetSplits: readonly DatasetSplit[];
  readonly families: readonly WorkloadFamily[];
  readonly tiers: readonly DifficultyTier[];
  readonly historyCount: number;
  readonly sessionsPerHistory: SessionBand;
  readonly scoredTasks: number;
  readonly budget: MemoryBudget;
  readonly consolidationPolicy: ConsolidationPolicy;
  readonly llmCallsPerTask: number;
  /** The three questions the MVE exists to answer cheaply. */
  readonly questions: readonly string[];
  readonly stopRule: string;
}

/**
 * The solo-developer preset the report prescribes.
 *
 * Four arms, synthetic histories only, 120 histories of 8-12 sessions yielding about
 * 800 scored tasks, a 1,200-token compiled-context cap, one answer-model call per
 * task, and proposal-only consolidation. Everything is DERIVED rather than restated:
 * the arms come from the contract's `MVE_ARM_IDS`, the session band from the medium
 * difficulty tier's own schedule, and the budget from the frozen fairness budget —
 * so the preset cannot drift away from the program it is a subset of.
 *
 * The narrowness is the design. The MVE is not trying to pick a production
 * architecture; it is trying to answer three questions cheaply enough that a wrong
 * answer costs a weekend. If typed and temporal memory cannot beat FlatTag here,
 * graph overlays and automatic consolidation are not the next thing to try.
 */
const MINIMUM_VIABLE_EXPERIMENT_TABLE: MinimumViableExperiment = {
  armIds: MVE_ARM_IDS,
  datasetSplits: ['synthetic_dev'],
  // Preference stability and change, project facts and decisions, temporal
  // questions, stale/revoked items, one multi-agent handoff cohort, one leakage
  // suite. Cross-project reuse and tool procedures are deliberately left out: they
  // are the axes the MVE is not yet trying to decide.
  families: [
    'person_state',
    'project_state',
    'update_control',
    'reasoning',
    'multi_agent',
    'adversarial'
  ],
  // The medium tier IS 8-12 sessions with two scopes and two to three updates, which
  // is exactly the shape the report specifies for the MVE.
  tiers: ['medium'],
  historyCount: 120,
  sessionsPerHistory: DIFFICULTY_TIER_BANDS.medium.sessionCount,
  scoredTasks: 800,
  budget: FROZEN_FAIRNESS_BUDGET,
  consolidationPolicy: 'proposal_only',
  llmCallsPerTask: 1,
  questions: [
    'Does typed memory beat FlatTag on task success by at least the +3 pp SESOI?',
    'Does temporal validity materially reduce stale-memory errors?',
    'Does hierarchical scoping prevent leakage without collapsing coordination?'
  ],
  stopRule:
    'If neither TypedTemporal nor Hierarchical clearly beats FlatTag here, do not add graph overlays, dynamic budgets, or automatic consolidation yet.'
};

export const MINIMUM_VIABLE_EXPERIMENT: MinimumViableExperiment = Object.freeze(
  MINIMUM_VIABLE_EXPERIMENT_TABLE
);

/**
 * The MVE's workload-generator input. Returned as data so the seed stays an explicit
 * argument recorded in the run manifest rather than a constant baked into a preset.
 */
export function mveWorkloadInput(seed: number): WorkloadGeneratorInput {
  return {
    seed,
    families: [...MINIMUM_VIABLE_EXPERIMENT.families],
    tiers: [...MINIMUM_VIABLE_EXPERIMENT.tiers],
    historyCount: MINIMUM_VIABLE_EXPERIMENT.historyCount,
    startAt: DEFAULT_SIMULATED_EPOCH
  };
}

// --- Import-time invariants -------------------------------------------------

/**
 * Checks the program's own consistency at import time, the way the arm catalog
 * parses the frozen arm table.
 *
 * These are the invariants that no test can be relied on to catch late enough: a
 * phase whose task counts drift from the contract's planned scale, a phase that
 * carries arms forward from a phase that has not run yet, a deleted safety gate, or
 * a profile whose weights no longer sum to one. Each would produce a plausible
 * leaderboard from an unplanned experiment.
 */
function assertProgramInvariants(): boolean {
  for (const metric of REQUIRED_GATE_METRICS) {
    if (!FROZEN_SAFETY_GATES.some((gate) => gate.metric === metric)) {
      throw new DecisionRubricError(`the frozen gate set no longer covers '${metric}'`, { metric });
    }
  }

  for (const profileId of SCENARIO_PROFILE_IDS) {
    const weights = PROFILE_WEIGHTS_PERMILLE[profileId];
    const total = PROFILE_COMPONENTS.reduce((sum, component) => sum + weights[component], 0);
    if (total !== 1_000) {
      throw new DecisionRubricError(`profile '${profileId}' weights must sum to 1000`, {
        profileId,
        total
      });
    }
  }

  PHASE_ORDER.forEach((phaseId, index) => {
    const entry = PHASE_PROGRAM[phaseId];
    const planned = entry.scale.functionalTasks + entry.scale.attackTrials;
    if (planned !== entry.spec.recommendedScoredTasks) {
      throw new DecisionRubricError(
        `phase '${phaseId}' scores ${planned} tasks but was planned for ${entry.spec.recommendedScoredTasks}`,
        { phaseId, planned, recommended: entry.spec.recommendedScoredTasks }
      );
    }
    if (entry.workload.families.length === 0 || entry.workload.tiers.length === 0) {
      throw new DecisionRubricError(`phase '${phaseId}' has an empty workload split`, { phaseId });
    }
    if (entry.arms.mode === 'carried_forward') {
      const sourceIndex = PHASE_ORDER.indexOf(entry.arms.carriedFrom);
      if (sourceIndex < 0 || sourceIndex >= index) {
        throw new DecisionRubricError(
          `phase '${phaseId}' carries arms from a phase that does not precede it`,
          { phaseId, carriedFrom: entry.arms.carriedFrom }
        );
      }
    }
  });

  return true;
}

/** True when the program's frozen tables agree with the contract they derive from. */
export const PROGRAM_INVARIANTS_HOLD: boolean = assertProgramInvariants();
