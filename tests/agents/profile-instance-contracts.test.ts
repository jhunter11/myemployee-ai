import { describe, expect, it } from 'vitest';

import type { ControlScopeRecord } from '../../src/agents/access-control-contracts';
import { planProfileInstance } from '../../src/agents/profile-instance-planner';
import {
  ProfileInstanceManifestSchema,
  type ProfileInstanceManifest
} from '../../src/agents/profile-instance-contracts';
import type { KnowledgeScopeRecord } from '../../src/knowledge/contracts';

const createdAt = '2026-07-25T20:00:00.000Z';
const expiresAt = '2026-07-25T22:00:00.000Z';

const controlScope: ControlScopeRecord = {
  id: 'client:acme_corp',
  kind: 'client',
  subjectId: 'acme_corp',
  parentScopeId: 'agency:agency',
  trustDomain: 'agency',
  state: 'active',
  version: 1,
  createdAt,
  updatedAt: createdAt
};

const knowledgeScope: KnowledgeScopeRecord = {
  id: 'client:acme_corp',
  kind: 'client',
  subjectId: 'acme_corp',
  clientId: 'acme_corp',
  parentScopeId: 'project:agency_operations',
  rootKey: 'knowledge/client/acme_corp',
  graphPartition: 'graphify/client/acme_corp',
  createdAt
};

function approvedManifest(): ProfileInstanceManifest {
  return planProfileInstance({
    recipeId: 'marketing',
    scope: controlScope,
    knowledgeScope,
    approvedBy: 'operator:jack_hunter',
    createdAt,
    expiresAt
  }).manifest;
}

/**
 * Each case is authority a manifest must not be able to carry. The approved
 * manifest is the only shape that parses; every mutation of it is rejected.
 */
const TAMPERINGS: ReadonlyArray<{
  name: string;
  tamper: (manifest: ProfileInstanceManifest) => void;
}> = [
  {
    name: 'a sleeve no member profile declares',
    tamper: (manifest) => {
      const template = manifest.sleeves[0];
      if (template === undefined) throw new Error('Missing sleeve fixture');
      manifest.sleeves.push({ ...template, id: 'client:acme_corp_undeclared' });
    }
  },
  {
    name: 'a declared sleeve dropped from the manifest',
    tamper: (manifest) => {
      manifest.sleeves.pop();
    }
  },
  {
    name: 'a sleeve grant rebound to a member that never declared it',
    tamper: (manifest) => {
      const grant = manifest.sleeveGrants[0];
      const other = manifest.members[1]?.profile.id;
      if (grant === undefined || other === undefined) throw new Error('Missing grant fixture');
      grant.agentId = other;
    }
  },
  {
    name: 'a sleeve grant widened from read to propose',
    tamper: (manifest) => {
      const grant = manifest.sleeveGrants.find(({ permission }) => permission === 'read');
      if (grant === undefined) throw new Error('Missing read grant fixture');
      grant.sleeveId = `agent:${manifest.members[1]?.profile.id ?? ''}:scratch`;
    }
  },
  {
    name: 'a declared tool grant dropped from the manifest',
    tamper: (manifest) => {
      manifest.toolGrants.pop();
    }
  },
  {
    name: 'a tool grant escalated past the blueprint layer',
    tamper: (manifest) => {
      const grant = manifest.toolGrants[0];
      if (grant === undefined) throw new Error('Missing tool grant fixture');
      grant.authorityLayer = 'operator';
    }
  },
  {
    name: 'a grant outliving the lease it was issued under',
    tamper: (manifest) => {
      const grant = manifest.toolGrants[0];
      if (grant === undefined) throw new Error('Missing tool grant fixture');
      grant.expiresAt = '2026-07-26T22:00:00.000Z';
    }
  },
  {
    name: 'a member inheriting the trust-domain core sleeve',
    tamper: (manifest) => {
      manifest.members[0]?.profile.memory.readableSleeveIds.push('agency:core');
    }
  },
  {
    name: 'a member reparented away from the concrete lead',
    tamper: (manifest) => {
      const member = manifest.members[1];
      if (member === undefined) throw new Error('Missing member fixture');
      member.profile.parentId = 'agency-chief-of-staff';
    }
  },
  {
    name: 'member ordinals no longer contiguous',
    tamper: (manifest) => {
      const member = manifest.members[1];
      if (member === undefined) throw new Error('Missing member fixture');
      member.ordinal = 7;
    }
  },
  {
    name: 'an agent registration homed outside the instance scope',
    tamper: (manifest) => {
      const registration = manifest.agentRegistrations[0];
      if (registration === undefined) throw new Error('Missing registration fixture');
      registration.homeScopeId = 'agency:agency';
    }
  },
  {
    name: 'a knowledge scope that does not match the control scope',
    tamper: (manifest) => {
      manifest.knowledgeScope.id = 'project:agency_operations';
    }
  },
  {
    name: 'a lease that expires before it begins',
    tamper: (manifest) => {
      manifest.expiresAt = '2026-07-25T19:00:00.000Z';
    }
  },
  {
    name: 'an inactive control scope',
    tamper: (manifest) => {
      manifest.scope.state = 'disabled';
    }
  },
  {
    name: 'a control scope registered after the lease was approved',
    tamper: (manifest) => {
      manifest.scope.updatedAt = '2026-07-25T21:00:00.000Z';
    }
  },
  {
    name: 'a duplicated sleeve id',
    tamper: (manifest) => {
      const sleeve = manifest.sleeves[0];
      if (sleeve === undefined) throw new Error('Missing sleeve fixture');
      manifest.sleeves.push({ ...sleeve });
    }
  },
  {
    name: 'a duplicated sleeve grant id',
    tamper: (manifest) => {
      const grant = manifest.sleeveGrants[1];
      if (grant === undefined) throw new Error('Missing sleeve grant fixture');
      grant.id = manifest.sleeveGrants[0]?.id ?? grant.id;
    }
  },
  {
    name: 'a duplicated tool grant id',
    tamper: (manifest) => {
      const grant = manifest.toolGrants[1];
      if (grant === undefined) throw new Error('Missing tool grant fixture');
      grant.id = manifest.toolGrants[0]?.id ?? grant.id;
    }
  },
  {
    name: 'two members sharing one agent id',
    tamper: (manifest) => {
      const [first, second] = manifest.members;
      if (first === undefined || second === undefined) throw new Error('Missing member fixture');
      second.profile.id = first.profile.id;
    }
  },
  {
    name: 'two members sharing one template profile id',
    tamper: (manifest) => {
      const [first, second] = manifest.members;
      if (first === undefined || second === undefined) throw new Error('Missing member fixture');
      second.templateProfileId = first.templateProfileId;
    }
  },
  {
    name: 'an agent registration that covers no member',
    tamper: (manifest) => {
      const registration = manifest.agentRegistrations[0];
      if (registration === undefined) throw new Error('Missing registration fixture');
      manifest.agentRegistrations.push({ ...registration, id: 'pi-unmatched-0123456789abcdef' });
    }
  },
  {
    name: 'an agent registration pinned to the wrong profile revision',
    tamper: (manifest) => {
      const registration = manifest.agentRegistrations[0];
      if (registration === undefined) throw new Error('Missing registration fixture');
      registration.profileRevision += 1;
    }
  },
  {
    name: 'a sleeve owned outside the instance scope',
    tamper: (manifest) => {
      const sleeve = manifest.sleeves[0];
      if (sleeve === undefined) throw new Error('Missing sleeve fixture');
      sleeve.ownerScopeId = 'agency:agency';
    }
  },
  {
    name: 'a member bound to another knowledge partition',
    tamper: (manifest) => {
      const member = manifest.members[0];
      if (member === undefined) throw new Error('Missing member fixture');
      member.profile.knowledge.partitionId = 'graphify/project/ai_agency';
    }
  }
];

describe('ProfileInstanceManifestSchema', () => {
  it('accepts the manifest the planner approves', () => {
    expect(ProfileInstanceManifestSchema.safeParse(approvedManifest()).success).toBe(true);
  });

  it.each(TAMPERINGS)('rejects $name', ({ tamper }) => {
    const tampered = structuredClone(approvedManifest());
    tamper(tampered);
    expect(ProfileInstanceManifestSchema.safeParse(tampered).success).toBe(false);
  });
});
