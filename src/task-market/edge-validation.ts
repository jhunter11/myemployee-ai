import { createHash } from 'node:crypto';

import { z } from 'zod';

const MAX_OBSERVATIONS = 10_000;
const MAX_ABSOLUTE_OBSERVATION = 1_000_000_000;

const FiniteNumberSchema = z.number().finite();
const ObservationSchema =
  FiniteNumberSchema.min(-MAX_ABSOLUTE_OBSERVATION).max(MAX_ABSOLUTE_OBSERVATION);

export const EdgeValidationInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  observations: z.array(ObservationSchema).min(5).max(MAX_OBSERVATIONS),
  parameters: z.strictObject({
    minObservations: z.number().int().min(5).max(MAX_OBSERVATIONS),
    minimumMean: FiniteNumberSchema,
    confidenceZ: FiniteNumberSchema.min(0).max(6)
  })
});

export type EdgeValidationInput = z.infer<typeof EdgeValidationInputSchema>;

export const EDGE_VALIDATION_ALGORITHM = Object.freeze({
  id: 'edge-validation',
  version: '1.0.0'
} as const);

export type EdgeValidationVerdict = 'PASS' | 'FAIL' | 'INSUFFICIENT_EVIDENCE';

interface ThresholdCheck {
  passed: boolean;
  actual: number;
  required: number;
}

export interface EdgeValidationResult {
  schemaVersion: 1;
  algorithm: typeof EDGE_VALIDATION_ALGORITHM;
  inputDigest: string;
  verdict: EdgeValidationVerdict;
  metrics: {
    observationCount: number;
    mean: number;
    sampleStandardDeviation: number;
    standardError: number;
    lowerConfidenceBound: number;
  };
  checks: {
    minimumObservations: ThresholdCheck;
    minimumMean: ThresholdCheck;
    lowerConfidenceBound: ThresholdCheck;
  };
}

/**
 * Neumaier summation preserves low-order contributions when a large value would
 * otherwise absorb them. Iteration order remains part of the input contract and
 * therefore part of the canonical digest.
 */
function compensatedSum(values: readonly number[]): number {
  let sum = 0;
  let compensation = 0;

  for (const value of values) {
    const next = sum + value;
    compensation += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
    sum = next;
  }

  return sum + compensation;
}

function canonicalInput(input: EdgeValidationInput): string {
  return JSON.stringify({
    schemaVersion: 1,
    observations: input.observations,
    parameters: {
      minObservations: input.parameters.minObservations,
      minimumMean: input.parameters.minimumMean,
      confidenceZ: input.parameters.confidenceZ
    }
  });
}

function inputDigest(input: EdgeValidationInput): string {
  return createHash('sha256').update(canonicalInput(input), 'utf8').digest('hex');
}

export function evaluateEdgeValidation(rawInput: unknown): EdgeValidationResult {
  const input = EdgeValidationInputSchema.parse(rawInput);
  const observationCount = input.observations.length;
  const mean = compensatedSum(input.observations) / observationCount;
  const squaredDeviations = input.observations.map((observation) => {
    const deviation = observation - mean;
    return deviation * deviation;
  });
  const sampleVariance = compensatedSum(squaredDeviations) / (observationCount - 1);
  const sampleStandardDeviation = Math.sqrt(sampleVariance);
  const standardError = sampleStandardDeviation / Math.sqrt(observationCount);
  const lowerConfidenceBound = mean - input.parameters.confidenceZ * standardError;

  const enoughObservations = observationCount >= input.parameters.minObservations;
  const meanPasses = mean >= input.parameters.minimumMean;
  const lowerBoundPasses = lowerConfidenceBound >= input.parameters.minimumMean;
  const verdict: EdgeValidationVerdict = !enoughObservations
    ? 'INSUFFICIENT_EVIDENCE'
    : meanPasses && lowerBoundPasses
      ? 'PASS'
      : 'FAIL';

  return {
    schemaVersion: 1,
    algorithm: EDGE_VALIDATION_ALGORITHM,
    inputDigest: inputDigest(input),
    verdict,
    metrics: {
      observationCount,
      mean,
      sampleStandardDeviation,
      standardError,
      lowerConfidenceBound
    },
    checks: {
      minimumObservations: {
        passed: enoughObservations,
        actual: observationCount,
        required: input.parameters.minObservations
      },
      minimumMean: {
        passed: meanPasses,
        actual: mean,
        required: input.parameters.minimumMean
      },
      lowerConfidenceBound: {
        passed: lowerBoundPasses,
        actual: lowerConfidenceBound,
        required: input.parameters.minimumMean
      }
    }
  };
}
