import { z } from 'zod';

import { isLiveClaim, type MemoryLifecycleState } from './lifecycle';

/**
 * The eight-tier authority hierarchy, ordered from strongest to weakest.
 *
 * The report's core claim is that authoritative memory is an AUTHORITY problem
 * before it is a convergence problem: explicit denial, revocation, and operator
 * override cannot be expressed as commutative merge laws, so precedence has to
 * be a fixed, auditable, total order rather than a heuristic. The array order IS
 * the hierarchy — rank is derived from it so the two can never drift apart.
 */
export const AUTHORITY_TIERS = [
  'policy_signed_approved',
  'operator_explicit',
  'human_artifact_verified',
  'external_system_of_record',
  'tool_observation',
  'agent_observation',
  'agent_inference',
  'statistical_pattern'
] as const;

export const AuthorityTierSchema = z.enum(AUTHORITY_TIERS);
export type AuthorityTier = z.infer<typeof AuthorityTierSchema>;

export interface AuthorityTierPolicy {
  readonly tier: AuthorityTier;
  /** Higher wins. Derived from {@link AUTHORITY_TIERS} order so the table is self-consistent. */
  readonly rank: number;
  readonly examples: readonly string[];
  readonly resolutionDefault: string;
}

function buildAuthorityPolicies(): Readonly<Record<AuthorityTier, AuthorityTierPolicy>> {
  const examples: Readonly<Record<AuthorityTier, readonly string[]>> = {
    policy_signed_approved: [
      'signed operator-approved policy',
      'validated procedure',
      'approved shared bundle'
    ],
    operator_explicit: ['direct operator statement', 'operator correction', 'operator approval'],
    human_artifact_verified: [
      'signed contract',
      'approved requirements doc',
      'verified human-authored artifact'
    ],
    external_system_of_record: ['current OAuth source-of-truth data with provider timestamp'],
    tool_observation: ['direct tool or API result', 'raw episode extraction'],
    agent_observation: ['extraction from an episode or artifact by an agent'],
    agent_inference: ['inferred preference', 'synthesized fact', 'summary'],
    statistical_pattern: ['pattern derived from repeated behavior']
  };
  const resolutionDefaults: Readonly<Record<AuthorityTier, string>> = {
    policy_signed_approved: 'beats all lower tiers; deny overrides permit',
    operator_explicit: 'beats all lower non-policy tiers',
    human_artifact_verified: 'beats tool summaries and agent inference',
    external_system_of_record: 'beats local inference, but not explicit operator override',
    tool_observation: 'beats summaries and statistical inference',
    agent_observation: 'beats unsupported summary or generalization',
    agent_inference: 'lower than direct evidence',
    statistical_pattern: 'lowest authority'
  };
  const entries = AUTHORITY_TIERS.map((tier, index): [AuthorityTier, AuthorityTierPolicy] => [
    tier,
    {
      tier,
      rank: AUTHORITY_TIERS.length - index,
      examples: examples[tier],
      resolutionDefault: resolutionDefaults[tier]
    }
  ]);
  return Object.freeze(Object.fromEntries(entries) as Record<AuthorityTier, AuthorityTierPolicy>);
}

/** The exhaustive tier table: rank, canonical examples, and the report's resolution default. */
export const AUTHORITY_TIER_POLICIES = buildAuthorityPolicies();

/** Rank lookup. Strictly higher rank means strictly stronger authority. */
export function authorityRank(tier: AuthorityTier): number {
  return AUTHORITY_TIER_POLICIES[tier].rank;
}

/**
 * Comparator over the hierarchy: positive when `left` outranks `right`, negative
 * when it is outranked, zero on a tie. A tie is a real outcome, not a rounding
 * error — the conflict engine must never silently pick a side on a tie.
 */
export function compareAuthority(left: AuthorityTier, right: AuthorityTier): number {
  return authorityRank(left) - authorityRank(right);
}

/** The three XACML-family rule outcomes. `not_applicable` is a non-answer, never an allow. */
export const POLICY_EFFECTS = ['permit', 'deny', 'not_applicable'] as const;
export const PolicyEffectSchema = z.enum(POLICY_EFFECTS);
export type PolicyEffect = z.infer<typeof PolicyEffectSchema>;

export type CombinedPolicyEffect = 'permit' | 'deny';

/**
 * `deny overrides permit`, the XACML-family combining algorithm the report names
 * as the correct default for scope and disclosure decisions.
 *
 * Two properties matter and both are fail-closed: a single `deny` beats any
 * number of permits, and an empty or wholly `not_applicable` rule set combines
 * to `deny` because "no rule matched" must never mean "allowed".
 */
export function combineDenyOverrides(effects: readonly PolicyEffect[]): CombinedPolicyEffect {
  let permitted = false;
  for (const effect of effects) {
    if (effect === 'deny') return 'deny';
    if (effect === 'permit') permitted = true;
  }
  return permitted ? 'permit' : 'deny';
}

export const SUPERSESSION_DECISION_CODES = [
  'authority_higher',
  'authority_equal',
  'authority_lower_denied',
  'base_not_supersedable',
  'cross_sleeve_denied',
  'cross_scope_denied',
  'legal_hold_denied'
] as const;

export const SupersessionDecisionCodeSchema = z.enum(SUPERSESSION_DECISION_CODES);
export type SupersessionDecisionCode = z.infer<typeof SupersessionDecisionCodeSchema>;

export interface SupersessionDecision {
  readonly allowed: boolean;
  readonly code: SupersessionDecisionCode;
  readonly reason: string;
}

/**
 * May a candidate at `candidateTier` supersede an active revision at
 * `existingTier`?
 *
 * Equal authority is permitted — an operator correcting an earlier operator
 * statement is the ordinary revision path. Strictly lower authority is denied,
 * which is the report's invariant "no lower-authority revision may supersede a
 * higher-authority active revision in the same context": it is what stops an
 * agent inference from quietly overwriting a signed policy.
 */
export function maySupersedeByAuthority(
  candidateTier: AuthorityTier,
  existingTier: AuthorityTier
): SupersessionDecision {
  const difference = compareAuthority(candidateTier, existingTier);
  if (difference > 0) {
    return {
      allowed: true,
      code: 'authority_higher',
      reason: `Candidate authority '${candidateTier}' outranks active '${existingTier}'`
    };
  }
  if (difference === 0) {
    return {
      allowed: true,
      code: 'authority_equal',
      reason: `Candidate and active revision share authority '${candidateTier}'`
    };
  }
  return {
    allowed: false,
    code: 'authority_lower_denied',
    reason: `Candidate authority '${candidateTier}' is below active '${existingTier}'`
  };
}

/**
 * The scope-, lifecycle-, and hold-aware facts a supersession decision needs.
 * Structural on purpose: `authority.ts` must stay usable by the reducer without
 * depending on the full revision schema.
 */
export interface SupersessionSubject {
  readonly authorityTier: AuthorityTier;
  readonly ownerScopeId: string;
  readonly sleeveId: string;
  readonly status: MemoryLifecycleState;
  readonly legalHold: boolean;
}

interface SupersessionGuard {
  readonly effect: PolicyEffect;
  readonly code: SupersessionDecisionCode;
  readonly reason: string;
}

/**
 * A guard that does not fire contributes `not_applicable`, never `permit`. Only
 * the authority hierarchy is allowed to say "permit"; everything else can only
 * stay silent or deny. That is what makes deny-by-default real here rather than
 * decorative.
 */
function supersessionGuard(
  denied: boolean,
  code: SupersessionDecisionCode,
  reason: string
): SupersessionGuard {
  return { effect: denied ? 'deny' : 'not_applicable', code, reason };
}

/**
 * The full supersession gate, combined with `deny overrides permit`.
 *
 * Every guard contributes an independent effect and any single `deny` wins, so
 * a higher-authority candidate still cannot cross a sleeve boundary, resurrect a
 * purged base, or bypass a legal hold. The scope and sleeve guards exist because
 * supersession is the one operation that could otherwise widen access: allowing
 * it across sleeves would let a stronger tier in one sleeve rewrite another's
 * canonical state.
 */
export function maySupersedeRevision(
  candidate: SupersessionSubject,
  existing: SupersessionSubject
): SupersessionDecision {
  const authority = maySupersedeByAuthority(candidate.authorityTier, existing.authorityTier);
  const rules: readonly SupersessionGuard[] = [
    {
      effect: authority.allowed ? 'permit' : 'deny',
      code: authority.code,
      reason: authority.reason
    },
    supersessionGuard(
      candidate.ownerScopeId !== existing.ownerScopeId,
      'cross_scope_denied',
      'Supersession may not cross an owning control scope'
    ),
    supersessionGuard(
      candidate.sleeveId !== existing.sleeveId,
      'cross_sleeve_denied',
      'Supersession may not cross a memory sleeve boundary'
    ),
    // The report's SUPERSEDE precondition: the base must be active or expired,
    // and never purged. A flagged (`active_conflicted`) base IS supersedable —
    // that is one of the sanctioned ways an operator clears a contradiction.
    supersessionGuard(
      !isLiveClaim(existing.status) && existing.status !== 'expired',
      'base_not_supersedable',
      `Base revision in state '${existing.status}' is not supersedable`
    ),
    supersessionGuard(existing.legalHold, 'legal_hold_denied', 'Base revision is under legal hold')
  ];

  if (combineDenyOverrides(rules.map((rule) => rule.effect)) === 'permit') {
    return authority;
  }
  // Deterministic denial reporting: rules are inspected in declaration order, so
  // the same denied supersession always reports the same code and reason.
  let denial: SupersessionDecision = authority;
  for (const rule of rules) {
    if (rule.effect === 'deny') {
      denial = { allowed: false, code: rule.code, reason: rule.reason };
      break;
    }
  }
  return denial;
}
