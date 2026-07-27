import { z } from 'zod';

import { ModelRouteInputSchema, type ModelRouteInput } from './contracts';

export type LogicalModelRoute = 'deterministic' | 'local' | 'economy' | 'frontier';
export type ModelRouteReason =
  | 'DETERMINISTIC_IMPLEMENTATION_AVAILABLE'
  | 'LOW_RISK_CONSTRAINED_WORK'
  | 'AMBIGUOUS_OR_CODE_WORK'
  | 'HIGH_RISK_REQUIRES_FRONTIER'
  | 'MEDIUM_RISK_REQUIRES_ECONOMY'
  | 'CONFIDENTIAL_DATA_REQUIRES_ECONOMY'
  | 'RESTRICTED_DATA_REQUIRES_FRONTIER'
  | 'HIGH_ASSURANCE_REQUIRES_FRONTIER'
  | 'PRIOR_VALIDATION_FAILURE_REQUIRES_ECONOMY'
  | 'REPEATED_VALIDATION_FAILURES_REQUIRE_FRONTIER'
  | 'NETWORK_POLICY_BLOCKED'
  | 'LOCAL_NETWORK_ONLY'
  | 'MODEL_EXECUTION_DISABLED'
  | 'TIER_NOT_ENABLED'
  | 'MODEL_EXECUTION_ENABLED';

export interface ModelRouteDecision {
  tier: 0 | 1 | 2 | 3;
  route: LogicalModelRoute;
  mode: 'deterministic' | 'simulation_only' | 'blocked' | 'execute';
  modelExecutionAllowed: boolean;
  requiresHumanReview: boolean;
  reasons: ModelRouteReason[];
}

/**
 * The provider-agnostic slice of the operator-owned model-execution enablement
 * record that the router is allowed to see. It never carries provider names,
 * surfaces, or secrets — only whether execution is enabled and which logical
 * tiers the operator has approved. Provider and surface gating happen in the
 * separate binding layer so this policy function stays provider-agnostic.
 */
export const ModelExecutionEnablementSnapshotSchema = z.strictObject({
  enabled: z.boolean(),
  allowedTiers: z.array(z.union([z.literal(1), z.literal(2), z.literal(3)])).max(3),
  version: z.number().int().min(1)
});

export type ModelExecutionEnablementSnapshot = z.infer<
  typeof ModelExecutionEnablementSnapshotSchema
>;

function baseRoute(input: ModelRouteInput): {
  tier: 1 | 2 | 3;
  reasons: ModelRouteReason[];
} {
  if (input.workType === 'synthesis' || input.workType === 'code' || input.workType === 'review') {
    return { tier: 2, reasons: ['AMBIGUOUS_OR_CODE_WORK'] };
  }
  return { tier: 1, reasons: ['LOW_RISK_CONSTRAINED_WORK'] };
}

function routeForTier(tier: 1 | 2 | 3): 'local' | 'economy' | 'frontier' {
  if (tier === 1) return 'local';
  return tier === 2 ? 'economy' : 'frontier';
}

/**
 * Chooses the cheapest logical capability tier that satisfies fixed policy.
 *
 * The optional enablement snapshot is the ONLY thing that can permit a real
 * model call, and it fails closed: when it is absent, disabled, malformed, or
 * does not cover the resolved tier, the decision is byte-identical to the
 * historical deterministic/simulation behaviour (`modelExecutionAllowed:false`,
 * `MODEL_EXECUTION_DISABLED`). Network policy still wins over an enabled tier.
 */
export function routeModelWork(rawInput: unknown, enablement?: unknown): ModelRouteDecision {
  const input = ModelRouteInputSchema.parse(rawInput);
  const gate =
    enablement === undefined
      ? undefined
      : ModelExecutionEnablementSnapshotSchema.safeParse(enablement).data;
  if (input.workType === 'deterministic') {
    return {
      tier: 0,
      route: 'deterministic',
      mode: 'deterministic',
      modelExecutionAllowed: false,
      requiresHumanReview: false,
      reasons: ['DETERMINISTIC_IMPLEMENTATION_AVAILABLE']
    };
  }

  const base = baseRoute(input);
  let tier = base.tier;
  const reasons = [...base.reasons];
  if (input.risk === 'medium' && tier < 2) {
    tier = 2;
    reasons.push('MEDIUM_RISK_REQUIRES_ECONOMY');
  }
  if (input.sensitivity === 'confidential' && tier < 2) {
    tier = 2;
    reasons.push('CONFIDENTIAL_DATA_REQUIRES_ECONOMY');
  } else if (input.sensitivity === 'confidential') {
    reasons.push('CONFIDENTIAL_DATA_REQUIRES_ECONOMY');
  }
  if (input.risk === 'high') {
    tier = 3;
    reasons.push('HIGH_RISK_REQUIRES_FRONTIER');
  }
  if (input.sensitivity === 'restricted') {
    tier = 3;
    reasons.push('RESTRICTED_DATA_REQUIRES_FRONTIER');
  }
  if (input.assurance === 'high') {
    tier = 3;
    reasons.push('HIGH_ASSURANCE_REQUIRES_FRONTIER');
  }
  if (input.priorValidationFailures === 1 && tier < 2) {
    tier = 2;
    reasons.push('PRIOR_VALIDATION_FAILURE_REQUIRES_ECONOMY');
  } else if (input.priorValidationFailures === 1 && tier === 2) {
    reasons.push('PRIOR_VALIDATION_FAILURE_REQUIRES_ECONOMY');
  }
  if (input.priorValidationFailures === 2) {
    tier = 3;
    reasons.push('REPEATED_VALIDATION_FAILURES_REQUIRE_FRONTIER');
  }

  let mode: ModelRouteDecision['mode'] = 'simulation_only';
  if (input.networkMode === 'none') {
    mode = 'blocked';
    reasons.push('NETWORK_POLICY_BLOCKED');
  } else if (input.networkMode === 'local_only' && tier > 1) {
    mode = 'blocked';
    reasons.push('LOCAL_NETWORK_ONLY');
  }

  const enabled = gate?.enabled === true;
  const tierAllowed = enabled && gate !== undefined && gate.allowedTiers.includes(tier);
  let modelExecutionAllowed = false;
  if (!enabled) {
    reasons.push('MODEL_EXECUTION_DISABLED');
  } else if (!tierAllowed) {
    reasons.push('TIER_NOT_ENABLED');
  } else {
    // The tier is enabled; execution proceeds only when network policy also
    // permits it. Deny-first: a blocked network keeps the call in `blocked`.
    modelExecutionAllowed = mode !== 'blocked';
    if (modelExecutionAllowed) mode = 'execute';
    reasons.push('MODEL_EXECUTION_ENABLED');
  }

  return {
    tier,
    route: routeForTier(tier),
    mode,
    modelExecutionAllowed,
    requiresHumanReview: tier === 3,
    reasons
  };
}
