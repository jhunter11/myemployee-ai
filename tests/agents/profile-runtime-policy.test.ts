import { describe, expect, it } from 'vitest';

import {
  ControlScopeRecordSchema,
  type ControlScopeRecord
} from '../../src/agents/access-control-contracts';
import { planProfileInstance } from '../../src/agents/profile-instance-planner';
import {
  findAgentProfile,
  listAgentProfiles,
  type AgentProfile
} from '../../src/agents/profile-catalog';
import {
  AgentRuntimePolicySchema,
  AgentRuntimeUnavailableError,
  assertAgentRuntimeExecutable,
  isAgentRuntimeExecutable,
  resolveAgentRuntimePolicy
} from '../../src/agents/profile-runtime-policy';
import {
  KnowledgeScopeRecordSchema,
  type KnowledgeScopeRecord
} from '../../src/knowledge/contracts';

function requiredProfile(id: string): AgentProfile {
  const profile = findAgentProfile(id);
  if (profile === undefined) throw new Error(`Missing profile fixture ${id}`);
  return profile;
}

describe('agent profile runtime policy', () => {
  it('maps all 10 durable and 35 template catalog profiles by lifecycle only', () => {
    const policies = listAgentProfiles().map(resolveAgentRuntimePolicy);

    expect(
      policies.filter(
        ({ lifecycle, memoryCell, checkpointMode }) =>
          lifecycle === 'durable' &&
          memoryCell === 'full' &&
          checkpointMode === 'stage_checkpoint_v1'
      )
    ).toHaveLength(10);
    expect(
      policies.filter(
        ({ lifecycle, memoryCell, checkpointMode }) =>
          lifecycle === 'template' &&
          memoryCell === 'run_bounded' &&
          checkpointMode === 'fail_closed'
      )
    ).toHaveLength(35);

    expect(policies.filter(({ memoryCell }) => memoryCell === 'full')).toHaveLength(10);
    expect(policies.filter(({ memoryCell }) => memoryCell === 'run_bounded')).toHaveLength(35);
    expect(
      policies.filter(({ checkpointMode }) => checkpointMode === 'stage_checkpoint_v1')
    ).toHaveLength(10);
    expect(policies.filter(({ checkpointMode }) => checkpointMode === 'fail_closed')).toHaveLength(
      35
    );
  });

  it('keeps runtime availability separate and never enables profile-only runtimes', () => {
    const jarvis = resolveAgentRuntimePolicy(requiredProfile('jarvis'));
    const agency = resolveAgentRuntimePolicy(requiredProfile('agency'));

    expect(jarvis).toMatchObject({
      runtimeMode: 'deterministic',
      execution: 'enabled',
      memoryCell: 'full',
      checkpointMode: 'stage_checkpoint_v1'
    });
    expect(isAgentRuntimeExecutable(jarvis)).toBe(true);
    expect(() => assertAgentRuntimeExecutable(jarvis)).not.toThrow();

    expect(agency).toMatchObject({
      runtimeMode: 'profile_only',
      execution: 'not_configured',
      memoryCell: 'full',
      checkpointMode: 'stage_checkpoint_v1'
    });
    expect(isAgentRuntimeExecutable(agency)).toBe(false);
    expect(() => assertAgentRuntimeExecutable(agency)).toThrowError(AgentRuntimeUnavailableError);

    try {
      assertAgentRuntimeExecutable(agency);
      throw new Error('Expected profile-only runtime assertion to fail');
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 503,
        code: 'AGENT_RUNTIME_UNAVAILABLE',
        details: {
          profileId: 'agency',
          profileRevision: 1,
          runtimeMode: 'profile_only',
          execution: 'not_configured'
        }
      });
    }

    const policies = listAgentProfiles().map(resolveAgentRuntimePolicy);
    expect(policies.filter(({ execution }) => execution === 'enabled')).toHaveLength(1);
    expect(
      policies
        .filter(({ runtimeMode }) => runtimeMode === 'profile_only')
        .every((policy) => !isAgentRuntimeExecutable(policy))
    ).toBe(true);
  });

  it('returns an exact, frozen policy DTO', () => {
    const policy = resolveAgentRuntimePolicy(requiredProfile('agency-developer-code-red'));

    expect(policy).toEqual({
      profileId: 'agency-developer-code-red',
      profileRevision: 1,
      lifecycle: 'template',
      runtimeMode: 'profile_only',
      execution: 'not_configured',
      memoryCell: 'run_bounded',
      checkpointMode: 'fail_closed'
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(AgentRuntimePolicySchema.safeParse(policy).success).toBe(true);
    expect(
      AgentRuntimePolicySchema.safeParse({ ...policy, contextPolicy: 'continuous' }).success
    ).toBe(false);
    expect(
      AgentRuntimePolicySchema.safeParse({
        ...policy,
        lifecycle: 'durable',
        memoryCell: 'run_bounded'
      }).success
    ).toBe(false);
    expect(
      AgentRuntimePolicySchema.safeParse({
        ...policy,
        runtimeMode: 'profile_only',
        execution: 'enabled'
      }).success
    ).toBe(false);
  });

  it('fails closed for runtime-instance members cloned from durable recipe leads', () => {
    const createdAt = '2026-07-25T20:00:00.000Z';
    const staticLead = requiredProfile('agency-developer');
    const controlScope: ControlScopeRecord = ControlScopeRecordSchema.parse({
      id: 'project:runtime_policy',
      kind: 'project',
      subjectId: 'runtime_policy',
      parentScopeId: 'agency:agency',
      trustDomain: 'agency',
      state: 'active',
      version: 1,
      createdAt,
      updatedAt: createdAt
    });
    const knowledgeScope: KnowledgeScopeRecord = KnowledgeScopeRecordSchema.parse({
      id: 'project:runtime_policy',
      kind: 'project',
      subjectId: 'runtime_policy',
      clientId: null,
      parentScopeId: 'harness:jarvis',
      rootKey: 'knowledge/project/runtime_policy',
      graphPartition: 'graphify/project/runtime_policy',
      createdAt
    });
    const plan = planProfileInstance({
      recipeId: 'developer',
      scope: controlScope,
      knowledgeScope,
      approvedBy: 'operator:jack_hunter',
      createdAt,
      expiresAt: '2026-07-25T22:00:00.000Z'
    });
    const concreteLead = plan.manifest.members[0];

    expect(staticLead.lifecycle).toBe('durable');
    expect(resolveAgentRuntimePolicy(staticLead)).toMatchObject({
      memoryCell: 'full',
      checkpointMode: 'stage_checkpoint_v1'
    });
    expect(concreteLead).toMatchObject({
      templateProfileId: staticLead.id,
      profile: {
        lifecycle: 'template',
        runtimeMode: 'profile_only'
      }
    });
    expect(resolveAgentRuntimePolicy(concreteLead!.profile)).toMatchObject({
      lifecycle: 'template',
      execution: 'not_configured',
      memoryCell: 'run_bounded',
      checkpointMode: 'fail_closed'
    });
  });
});
