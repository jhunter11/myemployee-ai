import { describe, expect, it } from 'vitest';

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

// A representative matrix that exercises every tier, mode, and escalation path.
const matrix = [
  baseInput,
  { ...baseInput, workType: 'deterministic' as const },
  { ...baseInput, workType: 'synthesis' as const },
  { ...baseInput, workType: 'code' as const, risk: 'high' as const },
  { ...baseInput, sensitivity: 'restricted' as const },
  { ...baseInput, assurance: 'high' as const },
  { ...baseInput, priorValidationFailures: 1 as const },
  { ...baseInput, priorValidationFailures: 2 as const },
  { ...baseInput, networkMode: 'none' as const },
  { ...baseInput, workType: 'synthesis' as const, networkMode: 'local_only' as const },
  { ...baseInput, risk: 'medium' as const, sensitivity: 'confidential' as const }
];

describe('model execution enablement gate', () => {
  it('is off by default: an absent enablement snapshot reproduces today’s decisions exactly', () => {
    for (const input of matrix) {
      const withoutGate = routeModelWork(input);
      const withDisabledGate = routeModelWork(input, {
        enabled: false,
        allowedTiers: [1, 2, 3],
        version: 1
      });
      expect(withDisabledGate).toEqual(withoutGate);
      expect(withoutGate.modelExecutionAllowed).toBe(false);
      expect(withoutGate.mode).not.toBe('execute');
      expect(withoutGate.reasons.at(-1)).toBe(
        input.workType === 'deterministic'
          ? 'DETERMINISTIC_IMPLEMENTATION_AVAILABLE'
          : 'MODEL_EXECUTION_DISABLED'
      );
    }
  });

  it('a malformed enablement snapshot fails closed to the disabled decision', () => {
    const malformed = [
      { enabled: 'yes', allowedTiers: [1, 2, 3], version: 1 },
      { enabled: true, allowedTiers: [0], version: 1 },
      { enabled: true, allowedTiers: [4], version: 1 },
      { enabled: true, allowedTiers: [1, 2, 3], version: 0 },
      { enabled: true },
      { allowedTiers: [1, 2, 3] },
      null,
      'enabled'
    ];
    for (const snapshot of malformed) {
      expect(routeModelWork(baseInput, snapshot as never)).toEqual(routeModelWork(baseInput));
    }
  });

  it('allows execution only for enabled tiers, switching mode to execute and dropping the disabled reason', () => {
    const decision = routeModelWork(baseInput, {
      enabled: true,
      allowedTiers: [1, 2, 3],
      version: 4
    });
    expect(decision).toEqual({
      tier: 1,
      route: 'local',
      mode: 'execute',
      modelExecutionAllowed: true,
      requiresHumanReview: false,
      reasons: ['LOW_RISK_CONSTRAINED_WORK', 'MODEL_EXECUTION_ENABLED']
    });
    expect(decision.reasons).not.toContain('MODEL_EXECUTION_DISABLED');
  });

  it('keeps a tier that is enabled globally but not in the allow-list in simulation only', () => {
    const decision = routeModelWork(baseInput, {
      enabled: true,
      allowedTiers: [2, 3],
      version: 4
    });
    expect(decision).toMatchObject({
      tier: 1,
      route: 'local',
      mode: 'simulation_only',
      modelExecutionAllowed: false
    });
    expect(decision.reasons.at(-1)).toBe('TIER_NOT_ENABLED');
  });

  it('never miscounts deterministic tier-0 work as a model call even when the gate is on', () => {
    const decision = routeModelWork(
      { ...baseInput, workType: 'deterministic' },
      { enabled: true, allowedTiers: [1, 2, 3], version: 9 }
    );
    expect(decision).toEqual({
      tier: 0,
      route: 'deterministic',
      mode: 'deterministic',
      modelExecutionAllowed: false,
      requiresHumanReview: false,
      reasons: ['DETERMINISTIC_IMPLEMENTATION_AVAILABLE']
    });
  });

  it('lets network policy win over an enabled tier (deny-first), recording that the gate was on', () => {
    const decision = routeModelWork(
      { ...baseInput, networkMode: 'none' },
      { enabled: true, allowedTiers: [1, 2, 3], version: 9 }
    );
    expect(decision).toMatchObject({
      tier: 1,
      route: 'local',
      mode: 'blocked',
      modelExecutionAllowed: false
    });
    expect(decision.reasons).toContain('NETWORK_POLICY_BLOCKED');
    expect(decision.reasons).toContain('MODEL_EXECUTION_ENABLED');
  });

  it('escalates high-risk enabled work to frontier and still requires human review', () => {
    const decision = routeModelWork(
      { ...baseInput, workType: 'code', risk: 'high' },
      { enabled: true, allowedTiers: [1, 2, 3], version: 9 }
    );
    expect(decision).toMatchObject({
      tier: 3,
      route: 'frontier',
      mode: 'execute',
      modelExecutionAllowed: true,
      requiresHumanReview: true
    });
    expect(decision.reasons.at(-1)).toBe('MODEL_EXECUTION_ENABLED');
  });
});
