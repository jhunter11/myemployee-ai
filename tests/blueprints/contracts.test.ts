import { describe, expect, it } from 'vitest';

import {
  BlueprintConfigSchema,
  BlueprintGateObservationSchema
} from '../../src/blueprints/contracts';

const DIGEST = 'a'.repeat(64);

function validConfig() {
  return {
    blueprintId: 'daily_report',
    revision: 1,
    previousRevision: null,
    ownerScopeId: 'client:acme_corp',
    objective: 'Create an internal daily qualification report.',
    inputContractDigest: 'b'.repeat(64),
    outputContractDigest: 'c'.repeat(64),
    workflowPattern: 'sequential' as const,
    implementationDigest: DIGEST,
    toolGrants: ['report.read'],
    sleeveGrants: [{ sleeveId: 'client:acme_corp:shared', permissions: ['read'] as const }],
    networkPolicy: { mode: 'none' as const, allowedHosts: [] },
    sideEffectPolicy: 'reversible_internal' as const,
    budgets: {
      maxDurationMs: 60_000,
      maxTurns: 8,
      maxToolCalls: 12,
      maxInputTokens: 20_000,
      maxOutputTokens: 4_000,
      maxCostMicrousd: 500_000,
      maxDepth: 2,
      maxFanout: 3
    },
    evalSuite: {
      suiteId: 'daily_report_eval',
      revision: 1,
      graderDigest: 'd'.repeat(64),
      hiddenHoldoutDigest: 'e'.repeat(64)
    },
    gatePolicy: {
      requiredTrials: 3,
      requireCompleteTrajectories: true as const,
      requireHiddenHoldouts: true as const,
      maxPolicyViolations: 0 as const,
      maxScopeViolations: 0 as const,
      maxBudgetBreaches: 0 as const,
      maxIrreversibleEffects: 0 as const,
      maxQualityRegressionBps: 0,
      maxInterventionIncreaseBps: 0
    },
    economicsPolicy: {
      pricingVersion: 'pricing-2026-07-01',
      minKnownCostCoverageBps: 10_000,
      maxCostPerSuccessfulTaskMicrousd: 250_000,
      maxP95LatencyMs: 45_000,
      maxUnexplainedCostIncreaseBps: 0
    },
    rollout: {
      shadowMode: 'read_only' as const,
      canaryTaskCount: 3,
      canaryRisk: 'low' as const,
      canaryEffects: 'reversible_internal' as const
    },
    provenance: {
      sourceKind: 'operator' as const,
      sourceRef: 'decision:daily-report-v1',
      evidenceDigest: 'f'.repeat(64)
    },
    rollbackRevision: null
  };
}

describe('blueprint contracts', () => {
  it('accepts bounded declarative configuration and strips no unknown executable fields', () => {
    expect(BlueprintConfigSchema.parse(validConfig())).toEqual(validConfig());
    expect(() =>
      BlueprintConfigSchema.parse({ ...validConfig(), sourceCode: 'fetch("prod")' })
    ).toThrow();
  });

  it('requires read-only shadow and fixed low-risk reversible canaries', () => {
    expect(() =>
      BlueprintConfigSchema.parse({
        ...validConfig(),
        rollout: { ...validConfig().rollout, shadowMode: 'write_enabled' }
      })
    ).toThrow();
    expect(() =>
      BlueprintConfigSchema.parse({
        ...validConfig(),
        rollout: { ...validConfig().rollout, canaryTaskCount: 0 }
      })
    ).toThrow();
  });

  it('rejects inconsistent revision, network, and sleeve declarations', () => {
    expect(() =>
      BlueprintConfigSchema.parse({
        ...validConfig(),
        previousRevision: 1
      })
    ).toThrow(/revision one/i);
    expect(() =>
      BlueprintConfigSchema.parse({
        ...validConfig(),
        revision: 3,
        previousRevision: 1,
        rollbackRevision: 2
      })
    ).toThrow(/immediately follow/i);
    expect(() =>
      BlueprintConfigSchema.parse({
        ...validConfig(),
        revision: 2,
        previousRevision: 1,
        rollbackRevision: null
      })
    ).toThrow(/rollback revision/i);
    expect(() =>
      BlueprintConfigSchema.parse({
        ...validConfig(),
        networkPolicy: { mode: 'none', allowedHosts: ['api.example.com'] }
      })
    ).toThrow(/cannot allow hosts/i);
    expect(() =>
      BlueprintConfigSchema.parse({
        ...validConfig(),
        networkPolicy: { mode: 'allowlist', allowedHosts: [] }
      })
    ).toThrow(/requires at least one host/i);
    expect(() =>
      BlueprintConfigSchema.parse({
        ...validConfig(),
        sleeveGrants: [validConfig().sleeveGrants[0], validConfig().sleeveGrants[0]]
      })
    ).toThrow(/unique by sleeve id/i);
    expect(() =>
      BlueprintConfigSchema.parse({
        ...validConfig(),
        toolGrants: ['report.read', 'report.read']
      })
    ).toThrow(/unique/i);
  });

  it('represents unknown economics honestly instead of treating it as zero', () => {
    const observation = BlueprintGateObservationSchema.parse({
      policy: {
        policyViolations: 0,
        scopeViolations: 0,
        budgetBreaches: 0,
        irreversibleEffects: 0,
        trialsCompleted: 3,
        trajectoriesComplete: true,
        hiddenHoldoutsPassed: true,
        qualityRegressionBps: 0,
        interventionIncreaseBps: 0
      },
      economics: {
        pricingVersion: null,
        knownCostCoverageBps: 0,
        successfulTasks: 0,
        costPerSuccessfulTaskMicrousd: null,
        p95LatencyMs: null,
        unexplainedCostIncreaseBps: null
      }
    });

    expect(observation.economics.costPerSuccessfulTaskMicrousd).toBeNull();
    expect(observation.economics.pricingVersion).toBeNull();
  });
});
