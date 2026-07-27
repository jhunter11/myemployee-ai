import { describe, expect, it } from 'vitest';

import {
  ARCHETYPES,
  BUDGETS,
  GENERALIZABLE_RELATIONS,
  archetypeFor,
  assertArchetypeConformance,
  type AgentRelation
} from '../../src/agents/archetypes';
import { POD_RECIPES } from '../../src/agents/pod-recipes';
import { listAgentProfiles, type AgentProfile } from '../../src/agents/profile-catalog';

function clone(id: string): AgentProfile {
  const found = listAgentProfiles().find((profile) => profile.id === id);
  if (found === undefined) throw new Error(`Missing fixture profile ${id}`);
  return structuredClone(found);
}

describe('agent archetypes', () => {
  it('holds a spec for every relation the catalog can express', () => {
    const relations = new Set(listAgentProfiles().map(({ relation }) => relation));
    for (const relation of relations) {
      expect(archetypeFor(relation).relation).toBe(relation);
    }
  });

  it('marks exactly the inward-facing archetypes as generalizable', () => {
    expect([...GENERALIZABLE_RELATIONS].sort()).toEqual([
      'advisor',
      'builder',
      'reviewer',
      'specialist',
      'verifier'
    ]);
  });

  it('treats every boundary-crossing archetype as scope-specific', () => {
    // root and coordinator cross upward to the operator, operator crosses
    // outward to the world, auditor crosses backward to an external ledger.
    for (const relation of ['root', 'coordinator', 'operator', 'auditor'] as AgentRelation[]) {
      expect(ARCHETYPES[relation].generalizable).toBe(false);
    }
  });

  it('accepts every profile in the shipped catalog', () => {
    for (const profile of listAgentProfiles()) {
      expect(() => assertArchetypeConformance(profile)).not.toThrow();
    }
  });
});

describe('archetype conformance enforcement', () => {
  it('rejects an escalation target that is not the parent', () => {
    const profile = clone('agency-developer-code-red');
    profile.continuation.escalation.target = 'jarvis';

    expect(() => assertArchetypeConformance(profile)).toThrow(/escalation rule/iu);
  });

  it('requires the root to escalate to the operator', () => {
    const profile = clone('jarvis');
    profile.continuation.escalation.target = 'agency';

    expect(() => assertArchetypeConformance(profile)).toThrow(/escalation rule/iu);
  });

  it('rejects a budget outside the archetype allowlist', () => {
    const profile = clone('agency-developer-code-red');
    profile.continuation.budgets = { ...BUDGETS.coordinator };

    expect(() => assertArchetypeConformance(profile)).toThrow(/budget allowlist/iu);
  });

  it('requires reviewers to open on a pinned stage', () => {
    const profile = clone('agency-idea-red');
    profile.continuation.stages = profile.continuation.stages.map((stage, index) =>
      index === 0 ? { ...stage, id: 'proposal_loaded' } : stage
    );

    expect(() => assertArchetypeConformance(profile)).toThrow(/must open on a \*_pinned stage/iu);
  });

  it('requires verifiers to close on a published stage', () => {
    const profile = clone('agency-delivery-verifier');
    const last = profile.continuation.stages.length - 1;
    profile.continuation.stages = profile.continuation.stages.map((stage, index) =>
      index === last ? { ...stage, id: 'verdict_kept' } : stage
    );

    expect(() => assertArchetypeConformance(profile)).toThrow(
      /must close on a \*_published stage/iu
    );
  });

  it('leaves boundary-crossing archetypes free of a run shape', () => {
    for (const relation of ['root', 'coordinator', 'specialist', 'operator'] as AgentRelation[]) {
      expect(ARCHETYPES[relation].stageBookend).toBeNull();
    }
  });
});

describe('pod recipes', () => {
  it('expands into the whole catalog', () => {
    const fromRecipes = POD_RECIPES.flatMap((recipe) => [
      recipe.lead.id,
      ...recipe.members.map(({ id }) => id)
    ]);

    expect(fromRecipes).toEqual(listAgentProfiles().map(({ id }) => id));
  });

  it('binds every member of a pod to one trust domain and knowledge scope', () => {
    const profiles = new Map(listAgentProfiles().map((profile) => [profile.id, profile]));
    for (const recipe of POD_RECIPES) {
      const ids = [recipe.lead.id, ...recipe.members.map(({ id }) => id)];
      for (const id of ids) {
        const profile = profiles.get(id);
        expect(profile?.trustDomain).toBe(recipe.trustDomain);
      }
      const scopes = new Set(ids.map((id) => profiles.get(id)?.knowledge.scopeId));
      expect(scopes.size).toBe(1);
    }
  });

  it('keeps adversarial review out of the sleeve it critiques', () => {
    const profiles = new Map(listAgentProfiles().map((profile) => [profile.id, profile]));
    const reviewers = POD_RECIPES.flatMap((recipe) =>
      [recipe.lead, ...recipe.members].filter(({ relation }) => relation === 'reviewer')
    );

    expect(reviewers).not.toHaveLength(0);
    for (const reviewer of reviewers) {
      const [sleeve] = profiles.get(reviewer.id)?.memory.proposeWritableSleeveIds ?? [];
      expect(sleeve).toMatch(/_reviews$/u);
    }
  });

  it('derives the reviewer sleeve from the pod unless the member overrides it', () => {
    // `mcp-x402-contract-red-team` writes to `contract_reviews` while its pod
    // sleeve is `contracts`. The recipe carries that as an explicit override
    // rather than normalising it, so the irregularity stays visible.
    const overrides = POD_RECIPES.flatMap((recipe) =>
      [recipe.lead, ...recipe.members]
        .filter(({ relation, sleeve }) => relation === 'reviewer' && sleeve !== undefined)
        .map(({ id, sleeve }) => `${id}:${String(sleeve)}`)
    );

    expect(overrides).toEqual(['mcp-x402-contract-red-team:contract_reviews']);
  });

  it('names a sleeve explicitly wherever the archetype cannot derive one', () => {
    for (const recipe of POD_RECIPES) {
      for (const member of [recipe.lead, ...recipe.members]) {
        if (archetypeFor(member.relation).sleeveRule !== 'explicit') continue;
        expect(member.sleeve).toBeTypeOf('string');
      }
    }
  });

  it('explicitly allowlists only recipes composed from generalizable archetypes', () => {
    expect(
      POD_RECIPES.filter(({ runtimeInstantiable }) => runtimeInstantiable).map(({ id }) => id)
    ).toEqual([
      'developer',
      'idea',
      'growth',
      'knowledge',
      'finance',
      'marketing',
      'contracts',
      'scouting'
    ]);

    for (const recipe of POD_RECIPES) {
      if (!recipe.runtimeInstantiable) continue;
      for (const member of [recipe.lead, ...recipe.members]) {
        expect(archetypeFor(member.relation).generalizable).toBe(true);
      }
    }
  });

  it('completes the Growth, Delivery, and Knowledge review shapes in V2', () => {
    const relationIds = (recipeId: string, relation: AgentRelation): string[] => {
      const recipe = POD_RECIPES.find(({ id }) => id === recipeId);
      if (recipe === undefined) throw new Error(`Missing recipe ${recipeId}`);
      return [recipe.lead, ...recipe.members]
        .filter((member) => member.relation === relation)
        .map(({ id }) => id);
    };

    expect(relationIds('growth', 'verifier')).toEqual(['agency-growth-verifier']);
    expect(relationIds('delivery', 'reviewer')).toEqual(['agency-delivery-reviewer']);
    expect(relationIds('knowledge', 'reviewer')).toEqual(['agency-knowledge-reviewer']);
  });
});
