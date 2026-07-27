import { AppError } from '../../utils/errors';
import type { MemorySystemId } from '../system/contracts';
import {
  ArmSpecSchema,
  EXPERIMENT_ARMS,
  EXPERIMENT_ARM_IDS,
  FROZEN_FAIRNESS_BUDGET,
  MVE_ARM_IDS,
  assertArmsShareBudget,
  memoryBudgetMismatchFields,
  type ArmBudgetBinding,
  type ArmSpec,
  type ExperimentArmId,
  type MemoryBudget,
  type MemoryBudgetField
} from './contracts';

/**
 * The runnable arm catalog: the report's eight-row arm table bound to real repo
 * backends, plus the fairness assertion that makes any comparison between them
 * admissible.
 *
 * The frozen table itself lives in {@link EXPERIMENT_ARMS} and is deliberately NOT
 * restated here. Two competing arm tables is exactly the failure mode this program
 * is built to prevent: the screening phase, the scorer, and the leaderboard would
 * each be able to disagree about which backend an arm ran on, and no run log would
 * reveal it. This module derives from the frozen table, validates it, explains each
 * mapping, and refuses unfair comparisons.
 *
 * Everything here is pure data and pure functions — no clock, no randomness, no I/O.
 */

/** Raised when a caller asks for an arm the frozen table does not define. */
export class UnknownExperimentArmError extends AppError {
  constructor(readonly requestedArmId: string) {
    super(404, 'EXPERIMENT_ARM_UNKNOWN', `Unknown experiment arm: '${requestedArmId}'`, {
      requestedArmId,
      knownArmIds: EXPERIMENT_ARM_IDS
    });
  }
}

export type FairnessViolationReason =
  'no_arms_bound' | 'duplicate_arm_binding' | 'budget_deviates_from_frozen';

/**
 * Raised when a set of arms cannot legitimately be compared. Structural failures
 * (an empty set, a duplicated arm) are violations in their own right: "no fairness
 * check ran" is not evidence of fairness, in the same way that an empty gate set is
 * not evidence of safety.
 */
export class ExperimentFairnessError extends AppError {
  constructor(
    readonly reason: FairnessViolationReason,
    message: string,
    details: Readonly<Record<string, unknown>> = {}
  ) {
    super(409, 'EXPERIMENT_FAIRNESS_VIOLATION', message, { reason, ...details });
  }
}

/**
 * One catalog row: the frozen spec, why its representation maps onto the repo
 * backend it does, and what the evaluation harness must layer on top.
 *
 * `harnessOverlay` exists because backends and arms are not one-to-one. Three arms
 * share `typed_temporal` and two share `ledger`; what separates them is the write,
 * retrieval, and scope policy the harness applies over the same substrate. Writing
 * that down per arm is what lets a reviewer confirm that only the six intended axes
 * differ between any two rows.
 */
export interface ArmCatalogEntry {
  readonly spec: ArmSpec;
  readonly backendRationale: string;
  readonly harnessOverlay: readonly string[];
}

const ARM_BACKEND_RATIONALE: Readonly<Record<ExperimentArmId, string>> = {
  FlatTag:
    "The `flat` backend is one memory_fragments table behind one lexical retrieval path with metadata filters — literally the report's 'unified store with metadata tags'. It is the control every typed arm must beat by the +3 pp SESOI, so it must be the plain substrate and nothing more.",
  TypedBasic:
    '`typed_hybrid` activates the CoALA store classes (working/episodic/semantic/procedural) with propose-only consolidation and no temporal reasoning. That is exactly TypedBasic: routing and per-store retrieval are switched on, validity windows are not, so the FlatTag->TypedBasic contrast isolates typing alone.',
  TypedTemporal:
    '`typed_temporal` is typed_hybrid plus validity-window reasoning and stale suppression. Binding TypedTemporal here keeps the TypedBasic->TypedTemporal contrast a single-axis change, which is the only way the -50% stale-error hypothesis can be attributed to temporal validity rather than to a bundle of improvements.',
  Hierarchical:
    'Hierarchical is TypedTemporal plus operator/subordinate tiers, so it must share the `typed_temporal` substrate; the tiering is a SCOPE policy, not a storage format. Running it on a different backend would confound the leakage comparison that this arm exists to make.',
  GraphAssist:
    "GraphAssist is defined as 'Hierarchical + graph edges', so it inherits Hierarchical's `typed_temporal` substrate. The edges it expands over are the provenance links the substrate already records (source fragments, supersession chains, approval links); expansion is a retrieval-time overlay that must return to the same final candidate count, so it cannot be allowed to change the storage backend as well.",
  EpisodeOnly:
    "The `ledger` backend is an append-only event log with bitemporal revisions — the report's 'append-only episodic ledger' with no distillation step. Its capability flags deliberately report no consolidation and no procedural promotion, which is precisely EpisodeOnly's 'no auto-merge, summaries for compression only' policy expressed as a backend property rather than as harness discipline.",
  FactOnly:
    'FactOnly keeps typed semantic/procedural extraction but forbids episode retrieval, so it needs the typed store classes `typed_hybrid` provides. It is the mirror image of EpisodeOnly under the same candidate and token caps, which is what makes the raw-episodes-versus-extracted-facts hypothesis a clean paired contrast.',
  HybridLedger:
    'HybridLedger stores BOTH raw episodes and extracted items, so it needs the ledger substrate that can hold an append-only episode stream, with temporal semantics over the extracted side. The query decides the mixture ratio inside the shared budget, which is a retrieval overlay rather than a second storage system.'
};

const ARM_HARNESS_OVERLAY: Readonly<Record<ExperimentArmId, readonly string[]>> = {
  FlatTag: [
    'hybrid lexical+dense fusion capped at the frozen candidate cap',
    'metadata filters only: no per-store routing, no validity filtering',
    'dedup is the only maintenance step'
  ],
  TypedBasic: [
    'write router assigns each candidate to exactly one store class',
    'per-store retrieval merged to the frozen candidate cap',
    'consolidation proposals are generated but never auto-applied'
  ],
  TypedTemporal: [
    'explicit update/supersession events at deterministic session boundaries',
    'time-aware retrieval evaluated at the item queryTime, never a wall clock',
    'records outside their validity window are suppressed, not deleted'
  ],
  Hierarchical: [
    'local writes stay in the writing sleeve until an operator promotes them',
    'parent reads resolve to operator-approved bundles only',
    'promotion proposals are reviewed rather than auto-applied'
  ],
  GraphAssist: [
    'bounded 1-hop expansion over recorded provenance, supersession, and approval edges',
    'exact rerank back down to the frozen candidate cap so the budget stays identical',
    'expanded items without a gold path justification are counted, not hidden'
  ],
  EpisodeOnly: [
    'raw episodes and artifacts are the only retrievable unit',
    'extractive summaries may compress storage but never enter the candidate pool',
    'run-local working memory is reconstructed per item rather than persisted'
  ],
  FactOnly: [
    'extraction writes facts, preferences, decisions, and procedures only',
    'raw episodes remain queryable for audit scoring but are excluded from retrieval',
    'canonicalization plus dedup replaces proposal-based consolidation'
  ],
  HybridLedger: [
    'dual write: the raw episode and its extracted items both persist',
    'the query chooses the episode/fact mixture inside one shared candidate cap',
    'both forms are retained so consolidation distortion stays measurable'
  ]
};

function buildCatalogEntry(armId: ExperimentArmId): ArmCatalogEntry {
  return {
    // Parsing (rather than trusting) the frozen table means a hand-edit that breaks
    // an arm spec fails at import time, before it can silently skew a leaderboard.
    spec: ArmSpecSchema.parse(EXPERIMENT_ARMS[armId]),
    backendRationale: ARM_BACKEND_RATIONALE[armId],
    harnessOverlay: ARM_HARNESS_OVERLAY[armId]
  };
}

/** The catalog, keyed by arm id. */
export const ARM_CATALOG: Readonly<Record<ExperimentArmId, ArmCatalogEntry>> = Object.freeze(
  Object.fromEntries(
    EXPERIMENT_ARM_IDS.map((armId) => [armId, buildCatalogEntry(armId)])
  ) as Record<ExperimentArmId, ArmCatalogEntry>
);

/**
 * Every arm in the frozen declaration order of {@link EXPERIMENT_ARM_IDS}. Stable
 * ordering is load-bearing: leaderboards, fingerprints, and stratified samples all
 * iterate this array, and a reordering would change run hashes without changing a
 * single measurement.
 */
export const ALL_ARMS: readonly ArmSpec[] = Object.freeze(
  EXPERIMENT_ARM_IDS.map((armId) => ARM_CATALOG[armId].spec)
);

/** The minimum viable experiment's four arms, in the same stable order. */
export const MVE_ARMS: readonly ArmSpec[] = Object.freeze(
  EXPERIMENT_ARM_IDS.filter((armId) => MVE_ARM_IDS.includes(armId)).map(
    (armId) => ARM_CATALOG[armId].spec
  )
);

const ARM_BY_ID: ReadonlyMap<string, ArmSpec> = new Map(ALL_ARMS.map((spec) => [spec.armId, spec]));

/**
 * Resolves an arm spec. Typed callers cannot miss, but untyped ones (a CLI flag, a
 * replayed run log, a stored phase config) can, and those must fail closed rather
 * than run an unspecified architecture.
 */
export function getArm(armId: ExperimentArmId): ArmSpec {
  const spec = ARM_BY_ID.get(armId);
  if (spec === undefined) {
    throw new UnknownExperimentArmError(String(armId));
  }
  return spec;
}

/** The catalog row, including the mapping rationale, for one arm. */
export function getArmCatalogEntry(armId: ExperimentArmId): ArmCatalogEntry {
  getArm(armId);
  return ARM_CATALOG[armId];
}

/** The repo backend an arm runs on. */
export function backendForArm(armId: ExperimentArmId): MemorySystemId {
  return getArm(armId).backend;
}

/** Arms grouped by backend, each group in stable arm order. */
export function armsByBackend(): ReadonlyMap<MemorySystemId, readonly ExperimentArmId[]> {
  const grouped = new Map<MemorySystemId, ExperimentArmId[]>();
  for (const spec of ALL_ARMS) {
    const bucket = grouped.get(spec.backend) ?? [];
    bucket.push(spec.armId);
    grouped.set(spec.backend, bucket);
  }
  return grouped;
}

/**
 * Binds a set of arms to the frozen fairness budget. Constructing bindings through
 * this helper is the intended path: it is impossible to accidentally hand one arm a
 * larger candidate cap than another.
 */
export function frozenFairnessBindings(
  armIds: readonly ExperimentArmId[]
): readonly ArmBudgetBinding[] {
  return armIds.map((armId) => ({ armId: getArm(armId).armId, budget: FROZEN_FAIRNESS_BUDGET }));
}

export interface FairnessDeviation {
  readonly armId: ExperimentArmId;
  readonly mismatchedFields: readonly MemoryBudgetField[];
}

/** Pure report of which bound arms deviate from a reference budget, in binding order. */
export function fairnessDeviations(
  bindings: readonly ArmBudgetBinding[],
  reference: MemoryBudget = FROZEN_FAIRNESS_BUDGET
): readonly FairnessDeviation[] {
  const deviations: FairnessDeviation[] = [];
  for (const binding of bindings) {
    const mismatchedFields = memoryBudgetMismatchFields(binding.budget, reference);
    if (mismatchedFields.length > 0) {
      deviations.push({ armId: binding.armId, mismatchedFields });
    }
  }
  return deviations;
}

/**
 * The program's central methodological control: every compared arm reads under the
 * same candidate cap, the same compiled-context token cap, the same stored-bytes
 * cap, and the same model-call cap.
 *
 * If those float, an architecture can win purely because it was allowed to read
 * more, and no amount of downstream statistics can recover the confounded effect —
 * so this throws rather than annotating the run. Two distinct failures are reported
 * with two distinct errors: drift BETWEEN arms surfaces as the contract's
 * {@link ExperimentBudgetMismatchError} (it names both arms), while drift of the
 * whole set away from the frozen budget surfaces as {@link ExperimentFairnessError}
 * (every arm agrees with every other, and all of them are wrong).
 */
export function assertFairness(
  bindings: readonly ArmBudgetBinding[],
  reference: MemoryBudget = FROZEN_FAIRNESS_BUDGET
): void {
  if (bindings.length === 0) {
    throw new ExperimentFairnessError(
      'no_arms_bound',
      'A fairness assertion over zero arms proves nothing and is rejected'
    );
  }

  const seen = new Set<ExperimentArmId>();
  for (const binding of bindings) {
    getArm(binding.armId);
    if (seen.has(binding.armId)) {
      throw new ExperimentFairnessError(
        'duplicate_arm_binding',
        `Arm '${binding.armId}' is bound twice, so its effective budget is ambiguous`,
        { armId: binding.armId }
      );
    }
    seen.add(binding.armId);
  }

  const [first, ...rest] = bindings;
  if (first === undefined) {
    throw new ExperimentFairnessError(
      'no_arms_bound',
      'A fairness assertion over zero arms proves nothing and is rejected'
    );
  }
  // Pairwise against the first binding: the contract error names both arms, which is
  // what an operator needs to see when one arm's config drifted.
  for (const binding of rest) {
    assertArmsShareBudget(first, binding);
  }

  const deviations = fairnessDeviations(bindings, reference);
  if (deviations.length > 0) {
    throw new ExperimentFairnessError(
      'budget_deviates_from_frozen',
      `Bound arms do not run under the frozen fairness budget: ${deviations
        .map((deviation) => `${deviation.armId}(${deviation.mismatchedFields.join(', ')})`)
        .join('; ')}`,
      { deviations }
    );
  }
}
