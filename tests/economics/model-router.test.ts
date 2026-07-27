import { describe, expect, it } from 'vitest';

import { ModelRouteInputSchema } from '../../src/economics/contracts';
import { routeModelWork } from '../../src/economics/model-router';

const baseInput = {
  operation: 'lead_triage',
  workType: 'classification' as const,
  risk: 'low' as const,
  sensitivity: 'internal' as const,
  assurance: 'standard' as const,
  priorValidationFailures: 0,
  networkMode: 'allowlist' as const
};

describe('routeModelWork', () => {
  it('keeps deterministic work at Tier 0 even when network access is denied', () => {
    const decision = routeModelWork({
      ...baseInput,
      workType: 'deterministic',
      risk: 'high',
      sensitivity: 'restricted',
      assurance: 'high',
      priorValidationFailures: 2,
      networkMode: 'none'
    });

    expect(decision).toEqual({
      tier: 0,
      route: 'deterministic',
      mode: 'deterministic',
      modelExecutionAllowed: false,
      requiresHumanReview: false,
      reasons: ['DETERMINISTIC_IMPLEMENTATION_AVAILABLE']
    });
  });

  it('plans low-risk constrained work on the logical local tier without executing it', () => {
    const decision = routeModelWork(baseInput);

    expect(decision).toEqual({
      tier: 1,
      route: 'local',
      mode: 'simulation_only',
      modelExecutionAllowed: false,
      requiresHumanReview: false,
      reasons: ['LOW_RISK_CONSTRAINED_WORK', 'MODEL_EXECUTION_DISABLED']
    });
    expect(decision).not.toHaveProperty('provider');
    expect(decision).not.toHaveProperty('model');
    expect(decision).not.toHaveProperty('price');
  });

  it('fails closed when a model-shaped task has no network authorization', () => {
    expect(routeModelWork({ ...baseInput, networkMode: 'none' })).toEqual({
      tier: 1,
      route: 'local',
      mode: 'blocked',
      modelExecutionAllowed: false,
      requiresHumanReview: false,
      reasons: ['LOW_RISK_CONSTRAINED_WORK', 'NETWORK_POLICY_BLOCKED', 'MODEL_EXECUTION_DISABLED']
    });
  });

  it.each(['synthesis', 'code'] as const)(
    'routes %s work to the logical economy tier',
    (workType) => {
      expect(routeModelWork({ ...baseInput, workType })).toMatchObject({
        tier: 2,
        route: 'economy',
        mode: 'simulation_only',
        reasons: ['AMBIGUOUS_OR_CODE_WORK', 'MODEL_EXECUTION_DISABLED']
      });
    }
  );

  it('escalates medium risk and confidential data with explicit stable reasons', () => {
    expect(
      routeModelWork({
        ...baseInput,
        risk: 'medium',
        sensitivity: 'confidential'
      })
    ).toMatchObject({
      tier: 2,
      route: 'economy',
      reasons: [
        'LOW_RISK_CONSTRAINED_WORK',
        'MEDIUM_RISK_REQUIRES_ECONOMY',
        'CONFIDENTIAL_DATA_REQUIRES_ECONOMY',
        'MODEL_EXECUTION_DISABLED'
      ]
    });
  });

  it.each([
    [{ risk: 'high' as const }, 'HIGH_RISK_REQUIRES_FRONTIER'],
    [{ sensitivity: 'restricted' as const }, 'RESTRICTED_DATA_REQUIRES_FRONTIER'],
    [{ assurance: 'high' as const }, 'HIGH_ASSURANCE_REQUIRES_FRONTIER']
  ])('escalates high-assurance work to frontier for %j', (override, reason) => {
    const decision = routeModelWork({ ...baseInput, ...override });

    expect(decision).toMatchObject({
      tier: 3,
      route: 'frontier',
      mode: 'simulation_only',
      requiresHumanReview: true
    });
    expect(decision.reasons).toEqual([
      'LOW_RISK_CONSTRAINED_WORK',
      reason,
      'MODEL_EXECUTION_DISABLED'
    ]);
  });

  it('escalates one validation failure to economy and repeated failures to frontier', () => {
    expect(routeModelWork({ ...baseInput, priorValidationFailures: 1 })).toMatchObject({
      tier: 2,
      route: 'economy',
      reasons: [
        'LOW_RISK_CONSTRAINED_WORK',
        'PRIOR_VALIDATION_FAILURE_REQUIRES_ECONOMY',
        'MODEL_EXECUTION_DISABLED'
      ]
    });
    expect(routeModelWork({ ...baseInput, priorValidationFailures: 2 })).toMatchObject({
      tier: 3,
      route: 'frontier',
      requiresHumanReview: true,
      reasons: [
        'LOW_RISK_CONSTRAINED_WORK',
        'REPEATED_VALIDATION_FAILURES_REQUIRE_FRONTIER',
        'MODEL_EXECUTION_DISABLED'
      ]
    });
  });

  it('rejects unknown, unsafe, and unbounded routing input', () => {
    expect(ModelRouteInputSchema.safeParse({ ...baseInput, provider: 'surprise' }).success).toBe(
      false
    );
    expect(ModelRouteInputSchema.safeParse({ ...baseInput, operation: '../escape' }).success).toBe(
      false
    );
    expect(
      ModelRouteInputSchema.safeParse({ ...baseInput, priorValidationFailures: 3 }).success
    ).toBe(false);
    expect(() => routeModelWork({ ...baseInput, networkMode: 'open' })).toThrow();
  });
});
