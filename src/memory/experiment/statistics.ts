import { z } from 'zod';

import { AppError } from '../../utils/errors';
import { compareIds } from './contracts';
import { createPrng } from './prng';

/**
 * The analysis layer that turns a scored leaderboard into an honest comparison.
 *
 * The report is explicit about four things this module has to encode, because
 * each one is a way a memory bake-off quietly lies to itself:
 *
 *   1. Items CLUSTER by profile, project, and workload family, so an interval
 *      built by resampling individual items understates variance badly. The
 *      bootstrap here resamples whole clusters.
 *   2. Secondary endpoints multiply, so false-discovery control runs WITHIN an
 *      endpoint family rather than across the whole report.
 *   3. Leakage and secret exposure are rare events where a point estimate of zero
 *      means nothing without an exact upper bound — the program's gate is phrased
 *      as "zero exfiltrations in 1,500 trials puts the 95% bound near 0.2%".
 *   4. A nonsignificant result is NOT evidence of practical equivalence. The
 *      decision types below make that impossible to conflate: only an equivalence
 *      test can ever report `impliesEquivalence: true`.
 *
 * Everything is pure and deterministic. Randomness comes from the program's shared
 * seeded {@link createPrng} stream, so the same deltas, iteration count, and seed
 * always produce the same interval — `Math.random` would make a confidence interval
 * unreproducible, which for a preregistered analysis is the same as making it
 * unusable.
 */

/**
 * Raised when an analysis is misspecified. Fails closed: a malformed interval, an
 * impossible discordance, or a single-cluster bootstrap is refused rather than
 * answered, because each one yields a plausible-looking number that is wrong.
 */
export class StatisticalPlanError extends AppError {
  constructor(reason: string, details?: unknown) {
    super(422, 'STATISTICS_PLAN_INVALID', `Analysis is not admissible: ${reason}`, details);
  }
}

// --- Shared helpers ---------------------------------------------------------

/** Linear-interpolated quantile over an ascending sample. */
function quantile(ascending: readonly number[], fraction: number): number {
  if (ascending.length === 0) return 0;
  const position = (ascending.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = ascending[lowerIndex] ?? 0;
  const upper = ascending[upperIndex] ?? lower;
  return lower + (upper - lower) * (position - lowerIndex);
}

// --- Cluster-aware paired bootstrap -----------------------------------------

/**
 * One within-item contrast. Every compared arm runs the same replayed history, so
 * the primary comparison is a paired delta; `clusterId` names the history, profile,
 * or project the item belongs to, which is the unit the bootstrap resamples.
 */
export const PairedDeltaSchema = z.strictObject({
  clusterId: z.string().trim().min(1).max(128),
  itemId: z.string().trim().min(1).max(128),
  delta: z.number().finite()
});
export type PairedDelta = z.infer<typeof PairedDeltaSchema>;

export const PairedDeltaSetSchema = z
  .array(PairedDeltaSchema)
  .min(1)
  .max(100_000)
  .superRefine((deltas, context) => {
    const seen = new Set<string>();
    deltas.forEach((entry, index) => {
      if (seen.has(entry.itemId)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'itemId'],
          message: `Duplicate paired item: ${entry.itemId}`
        });
      }
      seen.add(entry.itemId);
    });
  });

export const BootstrapOptionsSchema = z.strictObject({
  iterations: z.number().int().min(100).max(200_000),
  confidence: z.number().gt(0.5).lt(1),
  seed: z.number().int().min(0).max(2_147_483_647)
});
export type BootstrapOptions = z.infer<typeof BootstrapOptionsSchema>;

/**
 * A two-sided interval. Deliberately carries no confidence level: the decision
 * functions below each require a specific level (a superiority claim reads a
 * 1−α interval, TOST reads a 1−2α interval), and silently reusing one interval
 * for both is the error that makes an equivalence claim invalid.
 */
export interface ConfidenceInterval {
  readonly pointEstimate: number;
  readonly lower: number;
  readonly upper: number;
}

/**
 * Cluster-aware paired bootstrap percentile interval.
 *
 * Whole clusters are resampled with replacement, not individual items. That is the
 * whole point: items generated from one profile, project, or workload family share
 * a difficulty and a memory history, so treating them as independent draws shrinks
 * the interval toward a confidence the design does not have.
 *
 * A single cluster is REFUSED rather than reported. Resampling one cluster
 * reproduces it every iteration and yields a zero-width interval — a number that
 * looks like certainty and carries none.
 */
export function pairedBootstrapCI(rawDeltas: unknown, rawOptions: unknown): ConfidenceInterval {
  const deltas = PairedDeltaSetSchema.parse(rawDeltas);
  const options = BootstrapOptionsSchema.parse(rawOptions);

  // Stable cluster order and stable within-cluster order: the resample draws are a
  // function of the seed, so the ordering they index into must not depend on input
  // array order or Map insertion order.
  const ordered = [...deltas].sort((left, right) => compareIds(left.itemId, right.itemId));
  const byCluster = new Map<string, number[]>();
  for (const entry of ordered) {
    const bucket = byCluster.get(entry.clusterId) ?? [];
    bucket.push(entry.delta);
    byCluster.set(entry.clusterId, bucket);
  }
  const clusters = [...byCluster.keys()]
    .sort(compareIds)
    .map((clusterId) => byCluster.get(clusterId) ?? []);

  if (clusters.length < 2) {
    throw new StatisticalPlanError('a cluster bootstrap needs at least two clusters', {
      clusterCount: clusters.length
    });
  }

  // Summed in the same canonical item order as the resamples: floating-point
  // addition is not associative, so summing in caller order would make the point
  // estimate depend on how the deltas happened to be collected.
  const pointEstimate = ordered.reduce((total, entry) => total + entry.delta, 0) / ordered.length;

  // The named stream keeps resample draws independent of every other stage that
  // consumes the same root seed: a generator change upstream must not silently
  // move a published confidence interval.
  const draws = createPrng(options.seed, 'bootstrap');
  const resampledMeans: number[] = [];
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    let total = 0;
    let count = 0;
    for (let pick = 0; pick < clusters.length; pick += 1) {
      const cluster = clusters[draws.nextInt(clusters.length)] ?? [];
      for (const delta of cluster) {
        total += delta;
        count += 1;
      }
    }
    resampledMeans.push(count === 0 ? 0 : total / count);
  }
  resampledMeans.sort((left, right) => left - right);

  const tail = (1 - options.confidence) / 2;
  return {
    pointEstimate,
    lower: quantile(resampledMeans, tail),
    upper: quantile(resampledMeans, 1 - tail)
  };
}

// --- False-discovery control within an endpoint family ----------------------

export interface HypothesisOutcome {
  /** Position in the caller's input, so a family can never be silently reordered. */
  readonly index: number;
  readonly pValue: number;
  /** BH-adjusted p-value (q-value), monotone non-decreasing in rank and capped at 1. */
  readonly adjustedPValue: number;
  readonly rejected: boolean;
}

/**
 * Benjamini-Hochberg FDR control, applied WITHIN one endpoint family.
 *
 * The report is specific that control belongs inside a family (all retrieval
 * endpoints, all safety endpoints) rather than across the entire report: pooling
 * unrelated endpoints inflates the correction until real effects vanish, while
 * skipping correction inside a family manufactures them.
 *
 * Results come back in the caller's original order with the rank explicit, because
 * the classic implementation bug is returning a p-sorted array and letting the
 * caller re-associate it with the wrong hypothesis.
 */
export function benjaminiHochberg(
  rawPValues: unknown,
  rawQ: unknown
): readonly HypothesisOutcome[] {
  const pValues = z.array(z.number().min(0).max(1)).min(1).max(10_000).parse(rawPValues);
  const q = z.number().gt(0).lt(1).parse(rawQ);

  const total = pValues.length;
  const ranked = pValues
    .map((pValue, index) => ({ pValue, index }))
    .sort((left, right) => left.pValue - right.pValue || left.index - right.index);

  // Step-up from the largest p-value, carrying the running minimum. This is the
  // standard monotone adjustment: a smaller p-value can never receive a larger
  // q-value than a bigger one.
  const adjusted = new Array<number>(total).fill(1);
  let runningMinimum = 1;
  for (let rank = total; rank >= 1; rank -= 1) {
    const entry = ranked[rank - 1];
    if (entry === undefined) continue;
    runningMinimum = Math.min(runningMinimum, (total / rank) * entry.pValue);
    adjusted[entry.index] = Math.min(1, runningMinimum);
  }

  return pValues.map((pValue, index) => {
    const adjustedPValue = adjusted[index] ?? 1;
    return { index, pValue, adjustedPValue, rejected: adjustedPValue <= q };
  });
}

// --- Exact binomial bound for rare events ------------------------------------

const LANCZOS_G = 7;
const LANCZOS_COEFFICIENTS: readonly number[] = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7
];

function logGamma(value: number): number {
  if (value < 0.5) {
    // Reflection: Γ(z)Γ(1−z) = π / sin(πz), which keeps the series in its stable range.
    return Math.log(Math.PI / Math.sin(Math.PI * value)) - logGamma(1 - value);
  }
  const shifted = value - 1;
  let series = LANCZOS_COEFFICIENTS[0] ?? 0;
  for (let index = 1; index < LANCZOS_COEFFICIENTS.length; index += 1) {
    series += (LANCZOS_COEFFICIENTS[index] ?? 0) / (shifted + index);
  }
  const t = shifted + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(series);
}

/** Continued-fraction expansion of the incomplete beta (Lentz's method). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let result = d;

  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    const even = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + even * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + even / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    result *= d * c;

    const odd = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + odd * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + odd / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const step = d * c;
    result *= step;
    if (Math.abs(step - 1) < 1e-14) break;
  }
  return result;
}

/** Regularized incomplete beta I_x(a, b). */
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(x, a, b)) / a;
  }
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/**
 * Inverse of I_x(a, b) by bisection. Bisection rather than Newton because the
 * derivative vanishes in exactly the regime this is used for (a = 1, tiny x), and
 * a deterministic 200-step halving reaches machine precision without ever failing
 * to converge.
 */
function inverseRegularizedIncompleteBeta(target: number, a: number, b: number): number {
  let low = 0;
  let high = 1;
  for (let step = 0; step < 200; step += 1) {
    const middle = (low + high) / 2;
    if (regularizedIncompleteBeta(middle, a, b) < target) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return (low + high) / 2;
}

export interface ExactBinomialBound {
  readonly successes: number;
  readonly trials: number;
  readonly confidence: number;
  readonly pointEstimate: number;
  /** One-sided Clopper-Pearson upper limit at `confidence`. */
  readonly upperBound: number;
}

/**
 * Clopper-Pearson (exact) one-sided upper bound on an event rate.
 *
 * This is REQUIRED for the leakage and secret-exposure endpoints. A point estimate
 * of 0/1500 is not evidence of safety by itself; the bound is what turns it into
 * the program's engineering gate — zero exposures in 1,500 attack trials gives a
 * 95% upper bound of about 0.2%, which is where `gate:secret_leakage` (0.002) comes
 * from. The bound is exact rather than normal-approximate because the normal
 * interval degenerates to zero width at zero successes.
 *
 * The limit solves `I_U(k + 1, n − k) = confidence`; at `k = n` no upper limit is
 * identifiable and the bound is 1, which is the honest answer, not a failure.
 */
export function exactBinomialUpperBound(
  rawSuccesses: unknown,
  rawTrials: unknown,
  rawConfidence: unknown
): ExactBinomialBound {
  const successes = z.number().int().min(0).max(10_000_000).parse(rawSuccesses);
  const trials = z.number().int().min(1).max(10_000_000).parse(rawTrials);
  const confidence = z.number().gt(0.5).lt(1).parse(rawConfidence);
  if (successes > trials) {
    throw new StatisticalPlanError('successes cannot exceed trials', { successes, trials });
  }

  const upperBound =
    successes === trials
      ? 1
      : inverseRegularizedIncompleteBeta(confidence, successes + 1, trials - successes);

  return {
    successes,
    trials,
    confidence,
    pointEstimate: successes / trials,
    upperBound
  };
}

// --- Decision rules ---------------------------------------------------------

function assertWellFormedInterval(interval: ConfidenceInterval): void {
  if (
    !Number.isFinite(interval.lower) ||
    !Number.isFinite(interval.upper) ||
    !Number.isFinite(interval.pointEstimate)
  ) {
    throw new StatisticalPlanError('interval bounds must be finite', { interval });
  }
  if (interval.lower > interval.pointEstimate || interval.pointEstimate > interval.upper) {
    throw new StatisticalPlanError('point estimate must lie inside its interval', { interval });
  }
}

export type SuperiorityOutcome = 'superior' | 'not_superior';

export interface SuperiorityDecision {
  readonly test: 'superiority';
  readonly decision: SuperiorityOutcome;
  readonly reason:
    'lower_bound_exceeds_sesoi' | 'interval_crosses_zero' | 'lower_bound_below_sesoi';
  readonly sesoi: number;
  readonly interval: ConfidenceInterval;
  /**
   * Always `false`, as a literal type. Failing to demonstrate superiority says
   * nothing about practical equivalence, and the report calls out that conflation
   * specifically — so no superiority result can ever be read as an equivalence one.
   */
  readonly impliesEquivalence: false;
}

/**
 * Superiority against a prespecified smallest effect of interest. The claim holds
 * only when the interval's LOWER bound clears the SESOI: an interval that merely
 * excludes zero establishes a detectable effect, not a worthwhile one.
 */
export function decideSuperiority(
  interval: ConfidenceInterval,
  sesoi: number
): SuperiorityDecision {
  assertWellFormedInterval(interval);
  if (!Number.isFinite(sesoi) || sesoi < 0) {
    throw new StatisticalPlanError('SESOI must be a finite, non-negative effect size', { sesoi });
  }
  if (interval.lower > sesoi) {
    return {
      test: 'superiority',
      decision: 'superior',
      reason: 'lower_bound_exceeds_sesoi',
      sesoi,
      interval,
      impliesEquivalence: false
    };
  }
  return {
    test: 'superiority',
    decision: 'not_superior',
    reason:
      interval.lower <= 0 && interval.upper >= 0
        ? 'interval_crosses_zero'
        : 'lower_bound_below_sesoi',
    sesoi,
    interval,
    impliesEquivalence: false
  };
}

export type NonInferiorityOutcome = 'non_inferior' | 'inconclusive' | 'inferior';

export interface NonInferiorityDecision {
  readonly test: 'non_inferiority';
  readonly decision: NonInferiorityOutcome;
  readonly reason: 'lower_bound_within_margin' | 'interval_spans_margin' | 'interval_below_margin';
  /** Positive magnitude of the acceptable loss; deltas are new-minus-baseline, higher is better. */
  readonly margin: number;
  readonly interval: ConfidenceInterval;
  /** Always `false`: "not materially worse" is a weaker claim than "the same". */
  readonly impliesEquivalence: false;
}

/**
 * Non-inferiority against a prespecified margin. Used where a slower or costlier
 * architecture is acceptable only if it does not give up accuracy — the report's
 * procedural-memory and graph-retrieval hypotheses are both phrased this way.
 *
 * `inconclusive` exists as a distinct outcome from `inferior` on purpose: an
 * interval straddling the margin has failed to establish non-inferiority without
 * establishing harm, and collapsing the two would license the wrong decision.
 */
export function decideNonInferiority(
  interval: ConfidenceInterval,
  margin: number
): NonInferiorityDecision {
  assertWellFormedInterval(interval);
  if (!Number.isFinite(margin) || margin <= 0) {
    throw new StatisticalPlanError('non-inferiority margin must be a positive magnitude', {
      margin
    });
  }
  if (interval.lower > -margin) {
    return {
      test: 'non_inferiority',
      decision: 'non_inferior',
      reason: 'lower_bound_within_margin',
      margin,
      interval,
      impliesEquivalence: false
    };
  }
  if (interval.upper < -margin) {
    return {
      test: 'non_inferiority',
      decision: 'inferior',
      reason: 'interval_below_margin',
      margin,
      interval,
      impliesEquivalence: false
    };
  }
  return {
    test: 'non_inferiority',
    decision: 'inconclusive',
    reason: 'interval_spans_margin',
    margin,
    interval,
    impliesEquivalence: false
  };
}

export interface EquivalenceBounds {
  readonly lower: number;
  readonly upper: number;
}

export type EquivalenceOutcome = 'equivalent' | 'not_equivalent';

export interface EquivalenceDecision {
  readonly test: 'equivalence_tost';
  readonly decision: EquivalenceOutcome;
  readonly reason:
    | 'interval_within_bounds'
    | 'interval_exceeds_lower_bound'
    | 'interval_exceeds_upper_bound'
    | 'interval_wider_than_bounds';
  readonly bounds: EquivalenceBounds;
  readonly interval: ConfidenceInterval;
  /** The only decision type whose equivalence claim can be `true`. */
  readonly impliesEquivalence: boolean;
}

/**
 * Two one-sided tests (TOST) for practical equivalence, expressed through the
 * interval-inclusion form: both one-sided nulls are rejected exactly when the
 * interval lies strictly inside the equivalence bounds.
 *
 * IMPORTANT: TOST at level α reads a 1−2α interval (a 90% interval for α = 0.05).
 * Passing a 95% interval here is conservative, not wrong, but passing a 95%
 * interval while calling it an α = 0.025 test is. {@link ConfidenceInterval}
 * deliberately does not carry its own level, so the analysis plan — not this
 * function — is where the level is fixed.
 *
 * This is the only test that can conclude equivalence. A nonsignificant
 * superiority result cannot, which is why {@link SuperiorityDecision} pins
 * `impliesEquivalence` to the literal `false`.
 */
export function decideEquivalence(
  interval: ConfidenceInterval,
  bounds: EquivalenceBounds
): EquivalenceDecision {
  assertWellFormedInterval(interval);
  if (!Number.isFinite(bounds.lower) || !Number.isFinite(bounds.upper)) {
    throw new StatisticalPlanError('equivalence bounds must be finite', { bounds });
  }
  if (bounds.lower >= bounds.upper) {
    throw new StatisticalPlanError('equivalence bounds must be an ordered, non-empty region', {
      bounds
    });
  }

  const breachesLower = interval.lower <= bounds.lower;
  const breachesUpper = interval.upper >= bounds.upper;
  if (!breachesLower && !breachesUpper) {
    return {
      test: 'equivalence_tost',
      decision: 'equivalent',
      reason: 'interval_within_bounds',
      bounds,
      interval,
      impliesEquivalence: true
    };
  }
  return {
    test: 'equivalence_tost',
    decision: 'not_equivalent',
    reason:
      breachesLower && breachesUpper
        ? 'interval_wider_than_bounds'
        : breachesLower
          ? 'interval_exceeds_lower_bound'
          : 'interval_exceeds_upper_bound',
    bounds,
    interval,
    impliesEquivalence: false
  };
}

// --- Planning ---------------------------------------------------------------

const NORMAL_A1 = -3.969683028665376e1;
const NORMAL_A2 = 2.209460984245205e2;
const NORMAL_A3 = -2.759285104469687e2;
const NORMAL_A4 = 1.38357751867269e2;
const NORMAL_A5 = -3.066479806614716e1;
const NORMAL_A6 = 2.506628277459239;
const NORMAL_B1 = -5.447609879822406e1;
const NORMAL_B2 = 1.615858368580409e2;
const NORMAL_B3 = -1.556989798598866e2;
const NORMAL_B4 = 6.680131188771972e1;
const NORMAL_B5 = -1.328068155288572e1;
const NORMAL_C1 = -7.784894002430293e-3;
const NORMAL_C2 = -3.223964580411365e-1;
const NORMAL_C3 = -2.400758277161838;
const NORMAL_C4 = -2.549732539343734;
const NORMAL_C5 = 4.374664141464968;
const NORMAL_C6 = 2.938163982698783;
const NORMAL_D1 = 7.784695709041462e-3;
const NORMAL_D2 = 3.224671290700398e-1;
const NORMAL_D3 = 2.445134137142996;
const NORMAL_D4 = 3.754408661907416;
const NORMAL_LOW = 0.02425;

/**
 * Inverse standard-normal CDF (Acklam's rational approximation, ~1e-9 relative
 * error). Written with named coefficients rather than arrays so no index can be
 * undefined under `noUncheckedIndexedAccess` and no assertion is needed.
 */
function inverseStandardNormalCdf(probability: number): number {
  if (probability <= 0 || probability >= 1) {
    throw new StatisticalPlanError('normal quantile requires a probability in (0, 1)', {
      probability
    });
  }
  if (probability < NORMAL_LOW) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (
      (((((NORMAL_C1 * q + NORMAL_C2) * q + NORMAL_C3) * q + NORMAL_C4) * q + NORMAL_C5) * q +
        NORMAL_C6) /
      ((((NORMAL_D1 * q + NORMAL_D2) * q + NORMAL_D3) * q + NORMAL_D4) * q + 1)
    );
  }
  if (probability > 1 - NORMAL_LOW) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return (
      -(
        ((((NORMAL_C1 * q + NORMAL_C2) * q + NORMAL_C3) * q + NORMAL_C4) * q + NORMAL_C5) * q +
        NORMAL_C6
      ) /
      ((((NORMAL_D1 * q + NORMAL_D2) * q + NORMAL_D3) * q + NORMAL_D4) * q + 1)
    );
  }
  const q = probability - 0.5;
  const r = q * q;
  return (
    ((((((NORMAL_A1 * r + NORMAL_A2) * r + NORMAL_A3) * r + NORMAL_A4) * r + NORMAL_A5) * r +
      NORMAL_A6) *
      q) /
    (((((NORMAL_B1 * r + NORMAL_B2) * r + NORMAL_B3) * r + NORMAL_B4) * r + NORMAL_B5) * r + 1)
  );
}

export const PairedSampleSizeInputSchema = z
  .strictObject({
    /** Task-success rate of the comparator arm. */
    baselineRate: z.number().gt(0).lt(1),
    /** The improvement worth detecting, in proportion units (0.05 = +5 pp). */
    targetDelta: z.number().gt(0).lt(1),
    /** Total share of items expected to disagree between arms in either direction. */
    discordance: z.number().gt(0).lte(1),
    power: z.number().gt(0.5).lt(1),
    alpha: z.number().gt(0.0001).lt(0.5)
  })
  .superRefine((input, context) => {
    if (input.baselineRate + input.targetDelta > 1) {
      context.addIssue({
        code: 'custom',
        path: ['targetDelta'],
        message: 'baselineRate + targetDelta cannot exceed 1'
      });
    }
    if (input.discordance < input.targetDelta) {
      context.addIssue({
        code: 'custom',
        path: ['discordance'],
        message: 'total discordance cannot be smaller than the net effect it must produce'
      });
    }
  });
export type PairedSampleSizeInput = z.infer<typeof PairedSampleSizeInputSchema>;

export interface PairedSampleSizePlan {
  readonly pairedItems: number;
  /** Expected discordant pairs — the McNemar test's effective sample. */
  readonly discordantPairs: number;
  readonly baselineRate: number;
  readonly targetDelta: number;
  readonly discordance: number;
  readonly power: number;
  readonly alpha: number;
}

/**
 * Paired-binary sample size (Connor's normal approximation to McNemar's test):
 *
 *   n = [ z_{1−α/2}·√p_d + z_power·√(p_d − δ²) ]² / δ²
 *
 * Planning is done on PRACTICAL effects, not on the smallest detectable one. At
 * 80% power and two-sided 0.05 this reproduces the report's figures: about 800
 * paired items for +5 pp with 25% discordance, about 1,800 for +3 pp, and about
 * 3,500 for +2 pp. The smaller effects land on the report's numbers at slightly
 * lower discordance (~0.21 and ~0.18), which is why discordance is an explicit
 * parameter rather than a baked-in constant — with 25% discordance held fixed, a
 * +2 pp effect needs closer to 4,900 items, and pretending otherwise would
 * under-power the confirmatory phase by a third.
 */
export function pairedSampleSize(
  rawBaselineRate: unknown,
  rawTargetDelta: unknown,
  rawDiscordance: unknown,
  rawPower: unknown,
  rawAlpha: unknown
): PairedSampleSizePlan {
  const { baselineRate, targetDelta, discordance, power, alpha } =
    PairedSampleSizeInputSchema.parse({
      baselineRate: rawBaselineRate,
      targetDelta: rawTargetDelta,
      discordance: rawDiscordance,
      power: rawPower,
      alpha: rawAlpha
    });

  const zAlpha = inverseStandardNormalCdf(1 - alpha / 2);
  const zPower = inverseStandardNormalCdf(power);
  const residual = discordance - targetDelta * targetDelta;
  if (residual <= 0) {
    throw new StatisticalPlanError('discordance is too small for the target effect', {
      discordance,
      targetDelta
    });
  }

  const numerator = zAlpha * Math.sqrt(discordance) + zPower * Math.sqrt(residual);
  const pairedItems = Math.ceil((numerator * numerator) / (targetDelta * targetDelta));

  return {
    pairedItems,
    discordantPairs: Math.ceil(pairedItems * discordance),
    baselineRate,
    targetDelta,
    discordance,
    power,
    alpha
  };
}
