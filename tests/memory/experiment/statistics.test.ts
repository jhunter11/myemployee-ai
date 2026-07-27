import { describe, expect, it } from 'vitest';

import { FROZEN_SAFETY_GATES } from '../../../src/memory/experiment/contracts';
import {
  StatisticalPlanError,
  benjaminiHochberg,
  decideEquivalence,
  decideNonInferiority,
  decideSuperiority,
  exactBinomialUpperBound,
  pairedBootstrapCI,
  pairedSampleSize,
  type ConfidenceInterval,
  type PairedDelta
} from '../../../src/memory/experiment/statistics';

const BOOTSTRAP = { iterations: 2_000, confidence: 0.95, seed: 17 };

/** Builds a clustered paired-delta set: one delta value repeated inside each cluster. */
function clusteredDeltas(clusterValues: readonly number[], itemsPerCluster: number): PairedDelta[] {
  const deltas: PairedDelta[] = [];
  clusterValues.forEach((value, clusterIndex) => {
    for (let item = 0; item < itemsPerCluster; item += 1) {
      deltas.push({
        clusterId: `hist_${clusterIndex}`,
        itemId: `hist_${clusterIndex}_item_${item}`,
        delta: value
      });
    }
  });
  return deltas;
}

describe('pairedBootstrapCI', () => {
  it('resamples clusters, not items, so within-cluster correlation widens the interval', () => {
    // Three clusters of zeros and one cluster of ones. An item-level bootstrap would
    // report roughly [0.17, 0.34] here because it treats 100 perfectly correlated
    // items as 100 independent draws. A cluster bootstrap can only ever draw whole
    // histories, so the interval spans the real uncertainty.
    const deltas = clusteredDeltas([0, 0, 0, 1], 25);

    const interval = pairedBootstrapCI(deltas, BOOTSTRAP);

    expect(interval.pointEstimate).toBe(0.25);
    expect(interval.lower).toBe(0);
    expect(interval.upper).toBeGreaterThanOrEqual(0.7);
  });

  it('is deterministic under a fixed seed and sensitive to the seed', () => {
    const deltas = clusteredDeltas([0.02, 0.11, -0.04, 0.09, 0.15, -0.01, 0.06, 0.2], 6);

    const first = pairedBootstrapCI(deltas, BOOTSTRAP);
    const second = pairedBootstrapCI(deltas, BOOTSTRAP);
    const other = pairedBootstrapCI(deltas, { ...BOOTSTRAP, seed: 4_242 });

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(other.pointEstimate).toBe(first.pointEstimate);
    expect([other.lower, other.upper]).not.toEqual([first.lower, first.upper]);
  });

  it('does not depend on the order the deltas arrive in', () => {
    const deltas = clusteredDeltas([0.02, 0.11, -0.04, 0.09], 5);
    const shuffled = [...deltas].reverse();

    expect(pairedBootstrapCI(shuffled, BOOTSTRAP)).toEqual(pairedBootstrapCI(deltas, BOOTSTRAP));
  });

  it('collapses to a point when every history agrees', () => {
    const interval = pairedBootstrapCI(clusteredDeltas([0.05, 0.05, 0.05], 4), BOOTSTRAP);

    expect(interval.pointEstimate).toBeCloseTo(0.05, 12);
    expect(interval.lower).toBeCloseTo(0.05, 12);
    expect(interval.upper).toBeCloseTo(0.05, 12);
  });

  it('brackets the point estimate and widens as confidence rises', () => {
    const deltas = clusteredDeltas([0.01, 0.08, -0.03, 0.12, 0.04, 0.09], 4);

    const narrow = pairedBootstrapCI(deltas, { ...BOOTSTRAP, confidence: 0.8 });
    const wide = pairedBootstrapCI(deltas, { ...BOOTSTRAP, confidence: 0.99 });

    expect(narrow.lower).toBeLessThanOrEqual(narrow.pointEstimate);
    expect(narrow.upper).toBeGreaterThanOrEqual(narrow.pointEstimate);
    expect(wide.lower).toBeLessThanOrEqual(narrow.lower);
    expect(wide.upper).toBeGreaterThanOrEqual(narrow.upper);
  });

  it('refuses a single-cluster bootstrap instead of reporting a zero-width interval', () => {
    expect(() => pairedBootstrapCI(clusteredDeltas([0.07], 40), BOOTSTRAP)).toThrow(
      StatisticalPlanError
    );
  });

  it('refuses a paired item counted twice', () => {
    const deltas = clusteredDeltas([0.02, 0.05], 3);
    const duplicated = [...deltas, { clusterId: 'hist_1', itemId: 'hist_0_item_0', delta: 0.9 }];

    expect(() => pairedBootstrapCI(duplicated, BOOTSTRAP)).toThrow();
  });

  it('refuses inadmissible bootstrap options', () => {
    const deltas = clusteredDeltas([0.02, 0.05], 3);

    expect(() => pairedBootstrapCI(deltas, { ...BOOTSTRAP, iterations: 12 })).toThrow();
    expect(() => pairedBootstrapCI(deltas, { ...BOOTSTRAP, confidence: 1.2 })).toThrow();
    expect(() => pairedBootstrapCI(deltas, { ...BOOTSTRAP, confidence: 0.4 })).toThrow();
    expect(() => pairedBootstrapCI(deltas, { ...BOOTSTRAP, seed: 1.5 })).toThrow();
    expect(() => pairedBootstrapCI([], BOOTSTRAP)).toThrow();
  });
});

describe('benjaminiHochberg', () => {
  // The worked example from the original BH paper: 15 hypotheses, q = 0.05,
  // four discoveries. An uncorrected 0.05 cut would claim nine.
  const BH_EXAMPLE = [
    0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344, 0.0459, 0.324, 0.4262, 0.5719,
    0.6528, 0.759, 1.0
  ];

  it('reproduces the published worked example', () => {
    const outcomes = benjaminiHochberg(BH_EXAMPLE, 0.05);

    expect(outcomes.filter((outcome) => outcome.rejected).map((outcome) => outcome.index)).toEqual([
      0, 1, 2, 3
    ]);
    expect(BH_EXAMPLE.filter((pValue) => pValue <= 0.05)).toHaveLength(9);
  });

  it('returns results in the caller order with the original index attached', () => {
    const shuffled = [0.0459, 0.0001, 0.759, 0.0004];

    const outcomes = benjaminiHochberg(shuffled, 0.05);

    expect(outcomes.map((outcome) => outcome.index)).toEqual([0, 1, 2, 3]);
    expect(outcomes.map((outcome) => outcome.pValue)).toEqual(shuffled);
    expect(outcomes[1]?.rejected).toBe(true);
    expect(outcomes[3]?.rejected).toBe(true);
    expect(outcomes[0]?.rejected).toBe(false);
  });

  it('produces monotone adjusted values that never fall below the raw p-value', () => {
    const outcomes = benjaminiHochberg(BH_EXAMPLE, 0.05);
    const byRank = [...outcomes].sort((left, right) => left.pValue - right.pValue);

    for (const outcome of outcomes) {
      expect(outcome.adjustedPValue).toBeGreaterThanOrEqual(outcome.pValue);
      expect(outcome.adjustedPValue).toBeLessThanOrEqual(1);
    }
    for (let index = 1; index < byRank.length; index += 1) {
      expect(byRank[index]?.adjustedPValue).toBeGreaterThanOrEqual(
        byRank[index - 1]?.adjustedPValue ?? 0
      );
    }
  });

  it('computes the classic adjusted values for a small family', () => {
    // m = 3: the largest p is unchanged, the middle is 3/2 * 0.02 = 0.03, and the
    // smallest is capped by the running minimum at 0.03 rather than 3 * 0.01.
    const outcomes = benjaminiHochberg([0.01, 0.02, 0.6], 0.05);

    expect(outcomes[0]?.adjustedPValue).toBeCloseTo(0.03, 12);
    expect(outcomes[1]?.adjustedPValue).toBeCloseTo(0.03, 12);
    expect(outcomes[2]?.adjustedPValue).toBeCloseTo(0.6, 12);
    expect(outcomes.map((outcome) => outcome.rejected)).toEqual([true, true, false]);
  });

  it('leaves a single-hypothesis family uncorrected', () => {
    const outcomes = benjaminiHochberg([0.04], 0.05);

    expect(outcomes[0]?.adjustedPValue).toBeCloseTo(0.04, 12);
    expect(outcomes[0]?.rejected).toBe(true);
  });

  it('rejects an inadmissible family or FDR level', () => {
    expect(() => benjaminiHochberg([], 0.05)).toThrow();
    expect(() => benjaminiHochberg([0.5, 1.4], 0.05)).toThrow();
    expect(() => benjaminiHochberg([0.5], 0)).toThrow();
    expect(() => benjaminiHochberg([0.5], 1)).toThrow();
  });
});

describe('exactBinomialUpperBound', () => {
  it('reproduces the program planning figure: zero exposures in 1,500 trials', () => {
    const bound = exactBinomialUpperBound(0, 1_500, 0.95);

    expect(bound.pointEstimate).toBe(0);
    expect(bound.upperBound).toBeGreaterThan(0.0019);
    expect(bound.upperBound).toBeLessThan(0.0021);
    // At zero successes the limit has the closed form 1 - (1 - c)^(1/n); the general
    // solver must land on it, which is what proves the beta inversion is right.
    expect(bound.upperBound).toBeCloseTo(1 - Math.pow(0.05, 1 / 1_500), 12);
  });

  it('is the number the frozen secret-leakage gate was set from', () => {
    const gate = FROZEN_SAFETY_GATES.find((entry) => entry.id === 'gate:secret_leakage');
    const bound = exactBinomialUpperBound(0, 1_500, 0.95);

    expect(gate?.bound).toBe(0.002);
    expect(bound.upperBound).toBeLessThanOrEqual(gate?.bound ?? 0);
  });

  it('matches published Clopper-Pearson limits', () => {
    expect(exactBinomialUpperBound(0, 10, 0.95).upperBound).toBeCloseTo(0.2589, 4);
    expect(exactBinomialUpperBound(1, 10, 0.95).upperBound).toBeCloseTo(0.3942, 4);
    // The 0.975 one-sided limit is the upper half of the textbook two-sided 95% CI
    // for 5/10, which is symmetric: (0.187086, 0.812914).
    expect(exactBinomialUpperBound(5, 10, 0.975).upperBound).toBeCloseTo(0.812914, 6);
  });

  it('satisfies the defining property P(X <= k | upper) = 1 - confidence', () => {
    // Independent check against a directly summed binomial CDF: the limit is defined
    // as the p at which observing this few successes becomes (1 - confidence) likely.
    // A wrong beta inversion cannot pass this for all four shapes.
    const binomialCdf = (successes: number, trials: number, rate: number): number => {
      let total = 0;
      for (let count = 0; count <= successes; count += 1) {
        let logChoose = 0;
        for (let step = 1; step <= count; step += 1) {
          logChoose += Math.log((trials - count + step) / step);
        }
        total += Math.exp(
          logChoose + count * Math.log(rate) + (trials - count) * Math.log(1 - rate)
        );
      }
      return total;
    };

    for (const [successes, trials, confidence] of [
      [0, 10, 0.95],
      [1, 10, 0.95],
      [5, 10, 0.975],
      [3, 1_500, 0.95]
    ] as const) {
      const bound = exactBinomialUpperBound(successes, trials, confidence);
      expect(binomialCdf(successes, trials, bound.upperBound)).toBeCloseTo(1 - confidence, 9);
    }
  });

  it('never claims a bound below the observed rate and returns 1 when every trial hit', () => {
    for (const successes of [0, 1, 7, 25]) {
      const bound = exactBinomialUpperBound(successes, 50, 0.95);
      expect(bound.upperBound).toBeGreaterThan(bound.pointEstimate);
    }
    expect(exactBinomialUpperBound(50, 50, 0.95).upperBound).toBe(1);
  });

  it('tightens with more trials and loosens with more successes', () => {
    const few = exactBinomialUpperBound(0, 100, 0.95).upperBound;
    const many = exactBinomialUpperBound(0, 1_500, 0.95).upperBound;
    expect(many).toBeLessThan(few);

    const zero = exactBinomialUpperBound(0, 1_500, 0.95).upperBound;
    const three = exactBinomialUpperBound(3, 1_500, 0.95).upperBound;
    expect(three).toBeGreaterThan(zero);

    const lower = exactBinomialUpperBound(0, 1_500, 0.9).upperBound;
    expect(lower).toBeLessThan(zero);
  });

  it('refuses impossible counts', () => {
    expect(() => exactBinomialUpperBound(5, 4, 0.95)).toThrow(StatisticalPlanError);
    expect(() => exactBinomialUpperBound(-1, 10, 0.95)).toThrow();
    expect(() => exactBinomialUpperBound(1, 0, 0.95)).toThrow();
    expect(() => exactBinomialUpperBound(1, 10, 1.5)).toThrow();
  });
});

function interval(pointEstimate: number, lower: number, upper: number): ConfidenceInterval {
  return { pointEstimate, lower, upper };
}

describe('decision rules', () => {
  it('supports superiority only when the lower bound clears the SESOI', () => {
    const decision = decideSuperiority(interval(0.06, 0.041, 0.08), 0.03);

    expect(decision.decision).toBe('superior');
    expect(decision.reason).toBe('lower_bound_exceeds_sesoi');
    expect(decision.impliesEquivalence).toBe(false);
  });

  it('distinguishes an interval crossing zero from one that is real but too small', () => {
    const crossesZero = decideSuperiority(interval(0.01, -0.02, 0.04), 0.03);
    const belowSesoi = decideSuperiority(interval(0.02, 0.005, 0.035), 0.03);

    expect(crossesZero.decision).toBe('not_superior');
    expect(crossesZero.reason).toBe('interval_crosses_zero');
    expect(belowSesoi.decision).toBe('not_superior');
    expect(belowSesoi.reason).toBe('lower_bound_below_sesoi');
  });

  it('never lets a failed superiority test stand in for equivalence', () => {
    // The report's warning, encoded: this interval fails superiority AND fails
    // equivalence against tight bounds. Only the equivalence test can ever answer
    // the "practically the same" question.
    const wide = interval(0.01, -0.06, 0.08);

    const superiority = decideSuperiority(wide, 0.03);
    const equivalence = decideEquivalence(wide, { lower: -0.02, upper: 0.02 });

    expect(superiority.decision).toBe('not_superior');
    expect(superiority.impliesEquivalence).toBe(false);
    expect(equivalence.decision).toBe('not_equivalent');
    expect(equivalence.reason).toBe('interval_wider_than_bounds');
    expect(equivalence.impliesEquivalence).toBe(false);
  });

  it('declares equivalence by TOST only when the interval sits strictly inside the bounds', () => {
    const bounds = { lower: -0.02, upper: 0.02 };

    const inside = decideEquivalence(interval(0.001, -0.011, 0.013), bounds);
    const overUpper = decideEquivalence(interval(0.012, -0.005, 0.031), bounds);
    const underLower = decideEquivalence(interval(-0.012, -0.031, 0.005), bounds);

    expect(inside.decision).toBe('equivalent');
    expect(inside.impliesEquivalence).toBe(true);
    expect(overUpper.reason).toBe('interval_exceeds_upper_bound');
    expect(underLower.reason).toBe('interval_exceeds_lower_bound');
    expect(overUpper.impliesEquivalence).toBe(false);
    expect(underLower.impliesEquivalence).toBe(false);
  });

  it('separates non-inferior, inconclusive, and inferior against the margin', () => {
    const margin = 0.01;

    expect(decideNonInferiority(interval(0.002, -0.008, 0.012), margin).decision).toBe(
      'non_inferior'
    );
    expect(decideNonInferiority(interval(-0.009, -0.02, 0.002), margin).decision).toBe(
      'inconclusive'
    );
    expect(decideNonInferiority(interval(-0.04, -0.06, -0.02), margin).decision).toBe('inferior');
    expect(decideNonInferiority(interval(0.002, -0.008, 0.012), margin).impliesEquivalence).toBe(
      false
    );
  });

  it('refuses malformed intervals and inadmissible thresholds', () => {
    expect(() => decideSuperiority(interval(0.5, 0.6, 0.7), 0.01)).toThrow(StatisticalPlanError);
    expect(() => decideSuperiority(interval(0.05, 0.01, 0.09), -0.01)).toThrow(
      StatisticalPlanError
    );
    expect(() => decideNonInferiority(interval(0.05, 0.01, 0.09), 0)).toThrow(StatisticalPlanError);
    expect(() =>
      decideEquivalence(interval(0.0, -0.01, 0.01), { lower: 0.02, upper: -0.02 })
    ).toThrow(StatisticalPlanError);
    expect(() =>
      decideEquivalence(interval(0.0, -0.01, 0.01), { lower: Number.NaN, upper: 0.02 })
    ).toThrow(StatisticalPlanError);
  });
});

describe('pairedSampleSize', () => {
  it("reproduces the report's planning figures at 80% power and two-sided 0.05", () => {
    const fivePoints = pairedSampleSize(0.73, 0.05, 0.25, 0.8, 0.05);
    const threePoints = pairedSampleSize(0.73, 0.03, 0.21, 0.8, 0.05);
    const twoPoints = pairedSampleSize(0.73, 0.02, 0.18, 0.8, 0.05);

    expect(fivePoints.pairedItems).toBeGreaterThanOrEqual(750);
    expect(fivePoints.pairedItems).toBeLessThanOrEqual(850);
    expect(threePoints.pairedItems).toBeGreaterThanOrEqual(1_700);
    expect(threePoints.pairedItems).toBeLessThanOrEqual(1_900);
    expect(twoPoints.pairedItems).toBeGreaterThanOrEqual(3_400);
    expect(twoPoints.pairedItems).toBeLessThanOrEqual(3_600);
  });

  it('shows why discordance is a parameter and not a constant', () => {
    // Holding discordance at the +5 pp value makes the +2 pp arm need about a third
    // more items than the report's figure — planning with the wrong discordance
    // under-powers the confirmatory phase.
    const atReportedDiscordance = pairedSampleSize(0.73, 0.02, 0.18, 0.8, 0.05);
    const atFixedDiscordance = pairedSampleSize(0.73, 0.02, 0.25, 0.8, 0.05);

    expect(atFixedDiscordance.pairedItems).toBeGreaterThan(4_500);
    expect(atFixedDiscordance.pairedItems).toBeGreaterThan(atReportedDiscordance.pairedItems);
  });

  it('grows as the effect shrinks and as power rises', () => {
    const base = pairedSampleSize(0.73, 0.05, 0.25, 0.8, 0.05).pairedItems;

    expect(pairedSampleSize(0.73, 0.03, 0.25, 0.8, 0.05).pairedItems).toBeGreaterThan(base);
    expect(pairedSampleSize(0.73, 0.05, 0.25, 0.9, 0.05).pairedItems).toBeGreaterThan(base);
    expect(pairedSampleSize(0.73, 0.05, 0.25, 0.8, 0.01).pairedItems).toBeGreaterThan(base);
    expect(pairedSampleSize(0.73, 0.05, 0.4, 0.8, 0.05).pairedItems).toBeGreaterThan(base);
  });

  it('reports the expected discordant pairs alongside the item count', () => {
    const plan = pairedSampleSize(0.73, 0.05, 0.25, 0.8, 0.05);

    expect(plan.discordantPairs).toBe(Math.ceil(plan.pairedItems * 0.25));
    expect(plan.targetDelta).toBe(0.05);
    expect(plan.power).toBe(0.8);
  });

  it('refuses plans that cannot exist', () => {
    // Discordance below the net effect: the effect has to be produced BY discordant pairs.
    expect(() => pairedSampleSize(0.73, 0.05, 0.02, 0.8, 0.05)).toThrow();
    // An improvement past a 100% success rate.
    expect(() => pairedSampleSize(0.98, 0.05, 0.25, 0.8, 0.05)).toThrow();
    expect(() => pairedSampleSize(0.73, 0.05, 0.25, 0.4, 0.05)).toThrow();
    expect(() => pairedSampleSize(0.73, 0.05, 0.25, 0.8, 0.6)).toThrow();
    expect(() => pairedSampleSize(0.73, 0, 0.25, 0.8, 0.05)).toThrow();
  });
});
