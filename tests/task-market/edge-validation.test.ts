import { describe, expect, it } from 'vitest';

import {
  EDGE_VALIDATION_ALGORITHM,
  EdgeValidationInputSchema,
  evaluateEdgeValidation
} from '../../src/task-market/edge-validation';

function request(
  observations: number[],
  parameters: Partial<{
    minObservations: number;
    minimumMean: number;
    confidenceZ: number;
  }> = {}
) {
  return {
    schemaVersion: 1,
    observations,
    parameters: {
      minObservations: 5,
      minimumMean: 0,
      confidenceZ: 1.96,
      ...parameters
    }
  };
}

describe('edge-validation-v1 input contract', () => {
  it('accepts only the strict schema and bounded finite observations', () => {
    expect(EdgeValidationInputSchema.parse(request([1, 2, 3, 4, 5]))).toEqual(
      request([1, 2, 3, 4, 5])
    );

    for (const invalid of [
      { ...request([1, 2, 3, 4, 5]), schemaVersion: 2 },
      { ...request([1, 2, 3, 4, 5]), extra: true },
      {
        ...request([1, 2, 3, 4, 5]),
        parameters: { ...request([1, 2, 3, 4, 5]).parameters, extra: true }
      },
      request([1, 2, 3, 4]),
      request(Array.from({ length: 10_001 }, () => 1)),
      request([1, 2, 3, 4, 1_000_000_001]),
      request([1, 2, 3, 4, -1_000_000_001]),
      request([1, 2, 3, 4, Number.NaN]),
      request([1, 2, 3, 4, Number.POSITIVE_INFINITY]),
      request([1, 2, 3, 4, Number.NEGATIVE_INFINITY]),
      request([1, 2, 3, 4, 5], { minObservations: 4 }),
      request([1, 2, 3, 4, 5], { minObservations: 10_001 }),
      request([1, 2, 3, 4, 5], { minObservations: 5.5 }),
      request([1, 2, 3, 4, 5], { minimumMean: Number.NaN }),
      request([1, 2, 3, 4, 5], { minimumMean: Number.POSITIVE_INFINITY }),
      request([1, 2, 3, 4, 5], { confidenceZ: -0.01 }),
      request([1, 2, 3, 4, 5], { confidenceZ: 6.01 }),
      request([1, 2, 3, 4, 5], { confidenceZ: Number.NaN })
    ]) {
      expect(() => EdgeValidationInputSchema.parse(invalid)).toThrow();
    }
  });

  it('treats an attainable minimum above the supplied count as insufficient evidence', () => {
    const result = evaluateEdgeValidation(
      request([10, 10, 10, 10, 10], { minObservations: 6, minimumMean: 10 })
    );

    expect(result.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.checks.minimumObservations).toEqual({
      passed: false,
      actual: 5,
      required: 6
    });
  });
});

describe('evaluateEdgeValidation', () => {
  it('produces identical canonical evidence for equivalent strict input objects', () => {
    const first = evaluateEdgeValidation(
      request([2, 4, 6, 8, 10], { minObservations: 5, minimumMean: 3, confidenceZ: 1 })
    );
    const second = evaluateEdgeValidation({
      parameters: { confidenceZ: 1, minimumMean: 3, minObservations: 5 },
      observations: [2, 4, 6, 8, 10],
      schemaVersion: 1
    });

    expect(second).toEqual(first);
    expect(first.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      evaluateEdgeValidation(
        request([10, 8, 6, 4, 2], { minObservations: 5, minimumMean: 3, confidenceZ: 1 })
      ).inputDigest
    ).not.toBe(first.inputDigest);
  });

  it('uses compensated summation for a cancellation-prone mean', () => {
    const result = evaluateEdgeValidation(
      request([1_000_000_000, 0.1, -1_000_000_000, 0.1, 0.1], {
        minimumMean: -1_000_000_000,
        confidenceZ: 0
      })
    );

    expect(result.metrics.mean).toBeCloseTo(0.06, 15);
  });

  it('passes only when both the mean and lower confidence bound meet the threshold', () => {
    const result = evaluateEdgeValidation(
      request([10, 10, 10, 10, 10], { minimumMean: 10, confidenceZ: 2 })
    );

    expect(result).toMatchObject({
      schemaVersion: 1,
      algorithm: EDGE_VALIDATION_ALGORITHM,
      verdict: 'PASS',
      metrics: {
        observationCount: 5,
        mean: 10,
        sampleStandardDeviation: 0,
        standardError: 0,
        lowerConfidenceBound: 10
      },
      checks: {
        minimumObservations: { passed: true, actual: 5, required: 5 },
        minimumMean: { passed: true, actual: 10, required: 10 },
        lowerConfidenceBound: { passed: true, actual: 10, required: 10 }
      }
    });
  });

  it('fails when the mean passes but uncertainty puts the lower bound below the threshold', () => {
    const result = evaluateEdgeValidation(
      request([0, 0, 0, 0, 100], { minimumMean: 10, confidenceZ: 2 })
    );

    expect(result.verdict).toBe('FAIL');
    expect(result.metrics).toMatchObject({
      observationCount: 5,
      mean: 20,
      sampleStandardDeviation: Math.sqrt(2_000),
      standardError: 20,
      lowerConfidenceBound: -20
    });
    expect(result.checks.minimumMean.passed).toBe(true);
    expect(result.checks.lowerConfidenceBound.passed).toBe(false);
  });

  it('fails when the mean is below the threshold', () => {
    const result = evaluateEdgeValidation(
      request([1, 1, 1, 1, 1], { minimumMean: 2, confidenceZ: 0 })
    );

    expect(result.verdict).toBe('FAIL');
    expect(result.checks.minimumMean.passed).toBe(false);
    expect(result.checks.lowerConfidenceBound.passed).toBe(false);
  });

  it('returns a fixed bounded result without observations or arbitrary input fields', () => {
    const observations = [987_654_321, -123_456_789, 246_813_579, -975_318_642, 111_111_111];
    const result = evaluateEdgeValidation(request(observations, { minimumMean: -500_000_000 }));
    const serialized = JSON.stringify(result);

    expect(Object.keys(result)).toEqual([
      'schemaVersion',
      'algorithm',
      'inputDigest',
      'verdict',
      'metrics',
      'checks'
    ]);
    expect(Object.keys(result.metrics)).toEqual([
      'observationCount',
      'mean',
      'sampleStandardDeviation',
      'standardError',
      'lowerConfidenceBound'
    ]);
    expect(Object.keys(result.checks)).toEqual([
      'minimumObservations',
      'minimumMean',
      'lowerConfidenceBound'
    ]);
    expect(serialized).not.toContain('observations');
    for (const observation of observations) {
      expect(serialized).not.toContain(String(observation));
    }
  });
});
