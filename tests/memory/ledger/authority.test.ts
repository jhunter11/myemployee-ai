import { describe, expect, it } from 'vitest';

import {
  AUTHORITY_TIER_POLICIES,
  AUTHORITY_TIERS,
  authorityRank,
  combineDenyOverrides,
  compareAuthority,
  maySupersedeByAuthority,
  maySupersedeRevision,
  type AuthorityTier,
  type SupersessionSubject
} from '../../../src/memory/ledger/authority';

function subject(overrides: Partial<SupersessionSubject> = {}): SupersessionSubject {
  return {
    authorityTier: 'agent_observation',
    ownerScopeId: 'client:acme_corp',
    sleeveId: 'client:acme_corp',
    status: 'active',
    legalHold: false,
    ...overrides
  };
}

describe('authority hierarchy', () => {
  it('is a strict total order matching the declared tier sequence', () => {
    expect(AUTHORITY_TIERS).toHaveLength(8);
    const ranks = AUTHORITY_TIERS.map((tier) => authorityRank(tier));
    expect(new Set(ranks).size).toBe(ranks.length);
    for (let index = 1; index < AUTHORITY_TIERS.length; index += 1) {
      const stronger = AUTHORITY_TIERS[index - 1] as AuthorityTier;
      const weaker = AUTHORITY_TIERS[index] as AuthorityTier;
      expect(authorityRank(stronger)).toBeGreaterThan(authorityRank(weaker));
      expect(compareAuthority(stronger, weaker)).toBeGreaterThan(0);
      expect(compareAuthority(weaker, stronger)).toBeLessThan(0);
    }
    expect(compareAuthority('operator_explicit', 'operator_explicit')).toBe(0);
    // Signed policy beats everything; statistical pattern loses to everything.
    expect(authorityRank('policy_signed_approved')).toBe(8);
    expect(authorityRank('statistical_pattern')).toBe(1);
  });

  it('exposes an exhaustive tier table whose ranks cannot drift from the order', () => {
    for (const tier of AUTHORITY_TIERS) {
      const policy = AUTHORITY_TIER_POLICIES[tier];
      expect(policy.tier).toBe(tier);
      expect(policy.rank).toBe(authorityRank(tier));
      expect(policy.examples.length).toBeGreaterThan(0);
      expect(policy.resolutionDefault.length).toBeGreaterThan(0);
    }
    expect(Object.keys(AUTHORITY_TIER_POLICIES)).toHaveLength(AUTHORITY_TIERS.length);
  });
});

describe('deny overrides permit', () => {
  it('lets a single deny beat any number of permits', () => {
    expect(combineDenyOverrides(['permit', 'permit', 'deny'])).toBe('deny');
    expect(combineDenyOverrides(['deny', 'permit'])).toBe('deny');
    expect(combineDenyOverrides(['permit', 'permit'])).toBe('permit');
    expect(combineDenyOverrides(['permit', 'not_applicable'])).toBe('permit');
  });

  it('denies by default when nothing matched', () => {
    expect(combineDenyOverrides([])).toBe('deny');
    expect(combineDenyOverrides(['not_applicable'])).toBe('deny');
    expect(combineDenyOverrides(['not_applicable', 'not_applicable'])).toBe('deny');
  });
});

describe('supersession by authority', () => {
  it('permits equal or higher authority and denies lower', () => {
    expect(maySupersedeByAuthority('operator_explicit', 'agent_inference')).toMatchObject({
      allowed: true,
      code: 'authority_higher'
    });
    // An operator correcting an earlier operator statement is the ordinary path.
    expect(maySupersedeByAuthority('operator_explicit', 'operator_explicit')).toMatchObject({
      allowed: true,
      code: 'authority_equal'
    });
    // An inference must never quietly overwrite a signed policy.
    expect(maySupersedeByAuthority('agent_inference', 'policy_signed_approved')).toMatchObject({
      allowed: false,
      code: 'authority_lower_denied'
    });
    expect(maySupersedeByAuthority('statistical_pattern', 'agent_inference').allowed).toBe(false);
  });
});

describe('full supersession gate', () => {
  it('permits a same-scope, same-sleeve supersession of a live or expired base', () => {
    expect(
      maySupersedeRevision(subject({ authorityTier: 'operator_explicit' }), subject()).allowed
    ).toBe(true);
    // A flagged base is supersedable — that is how an operator clears a contradiction.
    expect(
      maySupersedeRevision(
        subject({ authorityTier: 'operator_explicit' }),
        subject({ status: 'active_conflicted' })
      ).allowed
    ).toBe(true);
    expect(
      maySupersedeRevision(
        subject({ authorityTier: 'operator_explicit' }),
        subject({ status: 'expired' })
      ).allowed
    ).toBe(true);
  });

  it('denies a boundary crossing even at the very top of the hierarchy', () => {
    const top = subject({ authorityTier: 'policy_signed_approved' });
    expect(maySupersedeRevision(top, subject({ sleeveId: 'client:beta_labs' }))).toMatchObject({
      allowed: false,
      code: 'cross_sleeve_denied'
    });
    expect(maySupersedeRevision(top, subject({ ownerScopeId: 'client:beta_labs' }))).toMatchObject({
      allowed: false,
      code: 'cross_scope_denied'
    });
  });

  it('denies resurrection of a non-supersedable base and any base under legal hold', () => {
    const top = subject({ authorityTier: 'policy_signed_approved' });
    for (const status of ['purged', 'superseded', 'retracted', 'proposed'] as const) {
      expect(maySupersedeRevision(top, subject({ status }))).toMatchObject({
        allowed: false,
        code: 'base_not_supersedable'
      });
    }
    expect(maySupersedeRevision(top, subject({ legalHold: true }))).toMatchObject({
      allowed: false,
      code: 'legal_hold_denied'
    });
  });

  it('reports the hierarchy verdict first when several guards deny at once', () => {
    const weak = subject({ authorityTier: 'statistical_pattern' });
    const decision = maySupersedeRevision(
      weak,
      subject({
        authorityTier: 'policy_signed_approved',
        sleeveId: 'client:beta_labs',
        status: 'purged',
        legalHold: true
      })
    );
    expect(decision).toMatchObject({ allowed: false, code: 'authority_lower_denied' });
    expect(decision.reason).toContain('statistical_pattern');
  });

  it('is deterministic: the same pair always yields the same decision', () => {
    const candidate = subject({ authorityTier: 'agent_inference' });
    const existing = subject({ authorityTier: 'tool_observation', legalHold: true });
    expect(maySupersedeRevision(candidate, existing)).toEqual(
      maySupersedeRevision(candidate, existing)
    );
  });
});
