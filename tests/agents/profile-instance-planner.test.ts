import { describe, expect, it } from 'vitest';

import {
  AccessGrantIdSchema,
  ControlScopeRecordSchema,
  MemorySleeveIdSchema
} from '../../src/agents/access-control-contracts';
import {
  listRuntimeInstantiableRecipeIds,
  planProfileInstance
} from '../../src/agents/profile-instance-planner';
import { AgentSleeveIdSchema } from '../../src/agents/profile-catalog';
import {
  KnowledgeScopeRecordSchema,
  type KnowledgeScopeRecord
} from '../../src/knowledge/contracts';

const createdAt = '2026-07-25T20:00:00.000Z';
const expiresAt = '2026-07-25T22:00:00.000Z';

function scope(input: {
  id: string;
  kind: 'company' | 'client' | 'project';
  subjectId: string;
  parentScopeId: string;
  trustDomain?: 'agency' | 'task_market';
}) {
  return ControlScopeRecordSchema.parse({
    ...input,
    trustDomain: input.trustDomain ?? 'agency',
    state: 'active',
    version: 1,
    createdAt,
    updatedAt: createdAt
  });
}

function knowledge(input: {
  id: string;
  kind: 'client' | 'project';
  subjectId: string;
  parentScopeId: string;
  clientId?: string | null;
}): KnowledgeScopeRecord {
  return KnowledgeScopeRecordSchema.parse({
    ...input,
    clientId: input.clientId ?? null,
    rootKey: `knowledge/${input.kind}/${input.subjectId}`,
    graphPartition: `graphify/${input.kind}/${input.subjectId}`,
    createdAt
  });
}

describe('runtime profile instance planner', () => {
  it('exposes the explicit runtime recipe allowlist', () => {
    expect(listRuntimeInstantiableRecipeIds()).toEqual([
      'developer',
      'idea',
      'growth',
      'knowledge',
      'finance',
      'marketing',
      'contracts',
      'scouting'
    ]);
  });

  it('rebinds a Marketing recipe to one exact client scope without domain-core inheritance', () => {
    const input = {
      recipeId: 'marketing',
      scope: scope({
        id: 'client:acme_corp',
        kind: 'client',
        subjectId: 'acme_corp',
        parentScopeId: 'agency:agency'
      }),
      knowledgeScope: knowledge({
        id: 'client:acme_corp',
        kind: 'client',
        subjectId: 'acme_corp',
        parentScopeId: 'project:ai_agency',
        clientId: 'acme_corp'
      }),
      approvedBy: 'operator:jack_hunter',
      createdAt,
      expiresAt
    } as const;

    const first = planProfileInstance(input);
    const second = planProfileInstance(input);

    expect(second).toEqual(first);
    expect(first.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.manifest.recipeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.manifest.instanceId).toMatch(/^profile-instance:[a-f0-9]{32}$/u);
    expect(first.manifest.scope.id).toBe('client:acme_corp');
    expect(first.manifest.knowledgeScope.id).toBe('client:acme_corp');
    expect(first.manifest.members).toHaveLength(4);

    const profiles = first.manifest.members.map(({ profile }) => profile);
    const lead = profiles[0];
    expect(lead).toMatchObject({
      parentId: 'agency',
      lifecycle: 'template',
      trustDomain: 'agency'
    });
    expect(lead?.memory.proposeWritableSleeveIds).toEqual(['client:acme_corp_marketing']);

    for (const profile of profiles) {
      expect(profile.id.length).toBeLessThanOrEqual(64);
      expect(profile.lifecycle).toBe('template');
      expect(profile.memory.scratchSleeveId).toBe(`agent:${profile.id}:scratch`);
      expect(
        [...profile.memory.readableSleeveIds, ...profile.memory.proposeWritableSleeveIds].some(
          (sleeveId) => sleeveId === 'agency:core'
        )
      ).toBe(false);
      expect(profile.knowledge.scopeId).toBe('client:acme_corp');
      expect(profile.knowledge.partitionId).toBe('graphify/client/acme_corp');
      expect(profile.continuation.escalation.target).toBe(profile.parentId);
    }

    const reviewer = profiles.find(({ relation }) => relation === 'reviewer');
    expect(reviewer?.memory.proposeWritableSleeveIds).toEqual([
      'client:acme_corp_marketing_reviews'
    ]);
    expect(profiles.slice(1).every(({ parentId }) => parentId === lead?.id)).toBe(true);

    expect(first.manifest.agentRegistrations).toHaveLength(4);
    expect(
      first.manifest.agentRegistrations.every(
        ({ homeScopeId }) => homeScopeId === 'client:acme_corp'
      )
    ).toBe(true);
    expect(
      first.manifest.sleeveGrants.every(({ authorityLayer }) => authorityLayer === 'blueprint')
    ).toBe(true);
    expect(
      first.manifest.toolGrants.every(({ authorityLayer }) => authorityLayer === 'blueprint')
    ).toBe(true);
  });

  it('bounds concrete profile, sleeve, and grant IDs for long client subjects', () => {
    const subjectId = `client_${'x'.repeat(45)}`;
    const plan = planProfileInstance({
      recipeId: 'marketing',
      scope: scope({
        id: `client:${subjectId}`,
        kind: 'client',
        subjectId,
        parentScopeId: 'agency:agency'
      }),
      knowledgeScope: knowledge({
        id: `client:${subjectId}`,
        kind: 'client',
        subjectId,
        parentScopeId: 'project:ai_agency',
        clientId: subjectId
      }),
      approvedBy: 'operator:jack_hunter',
      createdAt,
      expiresAt
    });

    for (const { profile } of plan.manifest.members) {
      expect(profile.id.length).toBeLessThanOrEqual(64);
      expect(AgentSleeveIdSchema.safeParse(profile.memory.scratchSleeveId).success).toBe(true);
      for (const sleeveId of [
        ...profile.memory.readableSleeveIds,
        ...profile.memory.proposeWritableSleeveIds
      ]) {
        expect(AgentSleeveIdSchema.safeParse(sleeveId).success).toBe(true);
      }
    }
    for (const sleeve of plan.manifest.sleeves) {
      expect(MemorySleeveIdSchema.safeParse(sleeve.id).success).toBe(true);
    }
    for (const grant of [...plan.manifest.sleeveGrants, ...plan.manifest.toolGrants]) {
      expect(AccessGrantIdSchema.safeParse(grant.id).success).toBe(true);
    }
  });

  it('accepts exact project and company knowledge bindings and rejects mismatches', () => {
    expect(() =>
      planProfileInstance({
        recipeId: 'finance',
        scope: scope({
          id: 'project:alpha',
          kind: 'project',
          subjectId: 'alpha',
          parentScopeId: 'agency:agency'
        }),
        knowledgeScope: knowledge({
          id: 'project:alpha',
          kind: 'project',
          subjectId: 'alpha',
          parentScopeId: 'harness:jarvis'
        }),
        approvedBy: 'operator:jack_hunter',
        createdAt,
        expiresAt
      })
    ).not.toThrow();

    expect(() =>
      planProfileInstance({
        recipeId: 'finance',
        scope: scope({
          id: 'company:acme_group',
          kind: 'company',
          subjectId: 'acme_group',
          parentScopeId: 'agency:agency'
        }),
        knowledgeScope: knowledge({
          id: 'project:company_acme_group',
          kind: 'project',
          subjectId: 'company_acme_group',
          parentScopeId: 'harness:jarvis'
        }),
        approvedBy: 'operator:jack_hunter',
        createdAt,
        expiresAt
      })
    ).not.toThrow();

    expect(() =>
      planProfileInstance({
        recipeId: 'finance',
        scope: scope({
          id: 'company:acme_group',
          kind: 'company',
          subjectId: 'acme_group',
          parentScopeId: 'agency:agency'
        }),
        knowledgeScope: knowledge({
          id: 'project:other_company',
          kind: 'project',
          subjectId: 'other_company',
          parentScopeId: 'harness:jarvis'
        }),
        approvedBy: 'operator:jack_hunter',
        createdAt,
        expiresAt
      })
    ).toThrow(/knowledge scope/iu);
  });

  it('rejects recipes containing a boundary-crossing archetype', () => {
    expect(() =>
      planProfileInstance({
        recipeId: 'delivery',
        scope: scope({
          id: 'client:acme_corp',
          kind: 'client',
          subjectId: 'acme_corp',
          parentScopeId: 'agency:agency'
        }),
        knowledgeScope: knowledge({
          id: 'client:acme_corp',
          kind: 'client',
          subjectId: 'acme_corp',
          parentScopeId: 'project:ai_agency',
          clientId: 'acme_corp'
        }),
        approvedBy: 'operator:jack_hunter',
        createdAt,
        expiresAt
      })
    ).toThrow(/not runtime-instantiable/iu);
  });

  it('rejects an unknown recipe and a scope outside the recipe trust domain', () => {
    const clientScope = scope({
      id: 'client:acme_corp',
      kind: 'client',
      subjectId: 'acme_corp',
      parentScopeId: 'agency:agency'
    });
    const clientKnowledge = knowledge({
      id: 'client:acme_corp',
      kind: 'client',
      subjectId: 'acme_corp',
      parentScopeId: 'project:ai_agency',
      clientId: 'acme_corp'
    });

    expect(() =>
      planProfileInstance({
        recipeId: 'not-a-recipe',
        scope: clientScope,
        knowledgeScope: clientKnowledge,
        approvedBy: 'operator:jack_hunter',
        createdAt,
        expiresAt
      })
    ).toThrow(/not runtime-instantiable/iu);

    // `marketing` lives in the agency domain; a task-market scope cannot host it.
    expect(() =>
      planProfileInstance({
        recipeId: 'marketing',
        scope: scope({
          id: 'client:acme_corp',
          kind: 'client',
          subjectId: 'acme_corp',
          parentScopeId: 'agency:agency',
          trustDomain: 'task_market'
        }),
        knowledgeScope: clientKnowledge,
        approvedBy: 'operator:jack_hunter',
        createdAt,
        expiresAt
      })
    ).toThrow(/active company, client, or project scope/iu);
  });

  it('rejects a lease whose window or scope timestamps precede the approval', () => {
    const clientScope = scope({
      id: 'client:acme_corp',
      kind: 'client',
      subjectId: 'acme_corp',
      parentScopeId: 'agency:agency'
    });
    const clientKnowledge = knowledge({
      id: 'client:acme_corp',
      kind: 'client',
      subjectId: 'acme_corp',
      parentScopeId: 'project:ai_agency',
      clientId: 'acme_corp'
    });
    const base = {
      recipeId: 'marketing',
      scope: clientScope,
      knowledgeScope: clientKnowledge,
      approvedBy: 'operator:jack_hunter',
      createdAt,
      expiresAt
    };

    expect(() => planProfileInstance({ ...base, expiresAt: createdAt })).toThrow();
    // A scope registered after the instance was approved cannot back it.
    expect(() => planProfileInstance({ ...base, createdAt: '2026-07-25T19:00:00.000Z' })).toThrow();
    expect(() =>
      planProfileInstance({
        ...base,
        knowledgeScope: { ...clientKnowledge, createdAt: '2026-07-25T21:00:00.000Z' }
      })
    ).toThrow();
  });
});
