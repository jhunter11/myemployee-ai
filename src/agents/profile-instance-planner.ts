import { createHash } from 'node:crypto';

import { z } from 'zod';

import type {
  AccessSensitivity,
  ControlScopeRecord,
  IssueAgentSleeveGrantInput,
  IssueAgentToolGrantInput,
  RegisterAccessAgentInput,
  RegisterMemorySleeveInput
} from './access-control-contracts';
import { ControlScopeRecordSchema } from './access-control-contracts';
import { OperatorIdSchema } from './access-lifecycle-contracts';
import { archetypeFor, assertArchetypeConformance } from './archetypes';
import { POD_RECIPES, type PodMember, type PodRecipe } from './pod-recipes';
import {
  ProfileInstanceManifestSchema,
  ProfileInstancePlanSchema,
  type ProfileInstanceMember,
  type ProfileInstancePlan
} from './profile-instance-contracts';
import { AgentProfileSchema, findAgentProfile, type AgentProfile } from './profile-catalog';
import { KnowledgeScopeRecordSchema } from '../knowledge/contracts';

const TimestampSchema = z.iso.datetime({ offset: true });
const RecipeIdSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/u);

export const PlanProfileInstanceInputSchema = z
  .strictObject({
    recipeId: RecipeIdSchema,
    scope: ControlScopeRecordSchema,
    knowledgeScope: KnowledgeScopeRecordSchema,
    approvedBy: OperatorIdSchema,
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema
  })
  .superRefine((input, context) => {
    if (Date.parse(input.expiresAt) <= Date.parse(input.createdAt)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'profile instance expiry must follow creation'
      });
    }
    if (
      Date.parse(input.scope.createdAt) > Date.parse(input.createdAt) ||
      Date.parse(input.scope.updatedAt) > Date.parse(input.createdAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['scope'],
        message: 'profile instance scope timestamps must not follow instance creation'
      });
    }
    if (Date.parse(input.knowledgeScope.createdAt) > Date.parse(input.createdAt)) {
      context.addIssue({
        code: 'custom',
        path: ['knowledgeScope'],
        message: 'knowledge scope creation must not follow profile instance creation'
      });
    }
  });

export type PlanProfileInstanceInput = z.infer<typeof PlanProfileInstanceInputSchema>;

const SENSITIVITY_BY_DOMAIN = {
  personal: 'private',
  agency: 'confidential',
  task_market: 'internal'
} as const satisfies Record<AgentProfile['trustDomain'], AccessSensitivity>;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function runtimeRecipe(recipeId: string): PodRecipe {
  const recipe = POD_RECIPES.find(({ id }) => id === recipeId);
  if (
    recipe === undefined ||
    !recipe.runtimeInstantiable ||
    ![recipe.lead, ...recipe.members].every(({ relation }) => archetypeFor(relation).generalizable)
  ) {
    throw new Error(`Pod recipe ${recipeId} is not runtime-instantiable`);
  }
  if (recipe.parentId === null) {
    throw new Error(`Pod recipe ${recipeId} is not runtime-instantiable without a static parent`);
  }
  return recipe;
}

function assertExactScopeBinding(
  recipe: PodRecipe,
  scope: ControlScopeRecord,
  knowledgeScope: z.infer<typeof KnowledgeScopeRecordSchema>
): void {
  if (
    scope.state !== 'active' ||
    !['company', 'client', 'project'].includes(scope.kind) ||
    scope.trustDomain !== recipe.trustDomain
  ) {
    throw new Error(
      `Profile instance scope must be an active company, client, or project scope in ${recipe.trustDomain}`
    );
  }

  const expected =
    scope.kind === 'client'
      ? {
          id: `client:${scope.subjectId}`,
          kind: 'client',
          subjectId: scope.subjectId,
          clientId: scope.subjectId
        }
      : scope.kind === 'project'
        ? {
            id: `project:${scope.subjectId}`,
            kind: 'project',
            subjectId: scope.subjectId,
            clientId: null
          }
        : {
            id: `project:company_${scope.subjectId}`,
            kind: 'project',
            subjectId: `company_${scope.subjectId}`,
            clientId: null
          };

  if (
    knowledgeScope.id !== expected.id ||
    knowledgeScope.kind !== expected.kind ||
    knowledgeScope.subjectId !== expected.subjectId ||
    knowledgeScope.clientId !== expected.clientId ||
    knowledgeScope.rootKey !== `knowledge/${expected.kind}/${expected.subjectId}` ||
    knowledgeScope.graphPartition !== `graphify/${expected.kind}/${expected.subjectId}`
  ) {
    throw new Error(
      `Knowledge scope ${knowledgeScope.id} does not match control scope ${scope.id}`
    );
  }
}

function concreteAgentId(instanceId: string, templateProfileId: string): string {
  const digest = sha256(`${instanceId}\0${templateProfileId}`).slice(0, 16);
  return `pi-${templateProfileId.slice(0, 44)}-${digest}`;
}

function boundedSleeveSubject(scope: ControlScopeRecord, abstractSleeve: string): string {
  const rawSubject = `${scope.subjectId}_${abstractSleeve}`;
  const sanitized = scope.kind === 'client' ? rawSubject.replaceAll('-', '_') : rawSubject;
  const maxLength = scope.kind === 'client' ? 63 : 128;
  if (sanitized === rawSubject && sanitized.length <= maxLength) return sanitized;

  const suffix = `_${sha256(rawSubject).slice(0, 12)}`;
  const prefix = sanitized.slice(0, maxLength - suffix.length).replace(/[_-]+$/u, '');
  return `${prefix}${suffix}`;
}

function concreteSleeveId(
  recipe: PodRecipe,
  scope: ControlScopeRecord,
  abstractSleeveId: string
): string | undefined {
  if (abstractSleeveId === `${recipe.trustDomain}:core`) return undefined;

  const prefix = `${recipe.trustDomain}:`;
  if (!abstractSleeveId.startsWith(prefix)) {
    throw new Error(
      `Template sleeve ${abstractSleeveId} does not belong to recipe domain ${recipe.trustDomain}`
    );
  }
  const abstractSleeve = abstractSleeveId.slice(prefix.length);
  return `${scope.kind}:${boundedSleeveSubject(scope, abstractSleeve)}`;
}

function concreteProfile(
  recipe: PodRecipe,
  member: PodMember,
  ordinal: number,
  instanceId: string,
  scope: ControlScopeRecord,
  knowledgeScope: z.infer<typeof KnowledgeScopeRecordSchema>,
  concreteLeadId: string
): ProfileInstanceMember {
  const template = findAgentProfile(member.id);
  if (
    template === undefined ||
    template.relation !== member.relation ||
    template.trustDomain !== recipe.trustDomain
  ) {
    throw new Error(`Static template profile ${member.id} does not match recipe ${recipe.id}`);
  }

  const id = concreteAgentId(instanceId, template.id);
  const parentId = ordinal === 0 ? recipe.parentId : concreteLeadId;
  const readableSleeveIds = template.memory.readableSleeveIds.flatMap((sleeveId) => {
    const concrete = concreteSleeveId(recipe, scope, sleeveId);
    return concrete === undefined ? [] : [concrete];
  });
  const proposeWritableSleeveIds = template.memory.proposeWritableSleeveIds.flatMap((sleeveId) => {
    const concrete = concreteSleeveId(recipe, scope, sleeveId);
    return concrete === undefined ? [] : [concrete];
  });

  const profile = AgentProfileSchema.parse({
    ...template,
    id,
    parentId,
    lifecycle: 'template',
    memory: {
      ...template.memory,
      scratchSleeveId: `agent:${id}:scratch`,
      readableSleeveIds,
      proposeWritableSleeveIds
    },
    knowledge: {
      ...template.knowledge,
      scopeId: knowledgeScope.id,
      partitionId: knowledgeScope.graphPartition
    },
    continuation: {
      ...template.continuation,
      escalation: {
        ...template.continuation.escalation,
        target: parentId
      }
    }
  });
  assertArchetypeConformance(profile);

  return {
    ordinal,
    templateProfileId: template.id,
    profile
  };
}

function grantId(kind: 'sleeve' | 'tool', identity: string): string {
  return `${kind}-grant:instance-${sha256(identity).slice(0, 40)}`;
}

function buildAccessManifest(
  members: readonly ProfileInstanceMember[],
  scope: ControlScopeRecord,
  createdAt: string,
  expiresAt: string
): {
  agentRegistrations: RegisterAccessAgentInput[];
  sleeves: RegisterMemorySleeveInput[];
  sleeveGrants: IssueAgentSleeveGrantInput[];
  toolGrants: IssueAgentToolGrantInput[];
} {
  const sensitivity = SENSITIVITY_BY_DOMAIN[scope.trustDomain];
  const agentRegistrations: RegisterAccessAgentInput[] = [];
  const sleeves = new Map<string, RegisterMemorySleeveInput>();
  const sleeveGrants = new Map<string, IssueAgentSleeveGrantInput>();
  const toolGrants = new Map<string, IssueAgentToolGrantInput>();

  for (const { profile } of members) {
    agentRegistrations.push({
      id: profile.id,
      homeScopeId: scope.id,
      trustDomain: profile.trustDomain,
      profileRevision: profile.revision,
      createdAt
    });

    const scratchSleeveId = profile.memory.scratchSleeveId;
    const declaredSleeveIds = new Set([
      scratchSleeveId,
      ...profile.memory.readableSleeveIds,
      ...profile.memory.proposeWritableSleeveIds
    ]);
    for (const sleeveId of declaredSleeveIds) {
      sleeves.set(sleeveId, {
        id: sleeveId,
        ownerScopeId: scope.id,
        maxSensitivity: sensitivity,
        expiresAt,
        createdAt
      });
    }

    const permissions = [
      ...profile.memory.readableSleeveIds.map((sleeveId) => ({
        sleeveId,
        permission: 'read' as const
      })),
      ...profile.memory.proposeWritableSleeveIds.map((sleeveId) => ({
        sleeveId,
        permission: 'propose' as const
      })),
      { sleeveId: scratchSleeveId, permission: 'read' as const },
      { sleeveId: scratchSleeveId, permission: 'propose' as const }
    ];
    for (const { sleeveId, permission } of permissions) {
      const identity = `${profile.id}\0${sleeveId}\0${permission}`;
      const id = grantId('sleeve', identity);
      sleeveGrants.set(id, {
        id,
        agentId: profile.id,
        sleeveId,
        authorityLayer: 'blueprint',
        permission,
        purpose:
          permission === 'read'
            ? 'profile_instance_memory_read'
            : 'profile_instance_memory_propose',
        sensitivityCap: sensitivity,
        expiresAt,
        expectedAgentVersion: 1,
        expectedScopeVersion: scope.version,
        expectedSleeveVersion: 1,
        issuedAt: createdAt
      });
    }

    for (const tool of profile.toolGrants) {
      const identity = `${profile.id}\0${tool.id}\0${tool.access}`;
      const id = grantId('tool', identity);
      toolGrants.set(id, {
        id,
        agentId: profile.id,
        toolId: tool.id,
        authorityLayer: 'blueprint',
        access: tool.access,
        purpose: 'profile_instance_tool_access',
        sensitivityCap: sensitivity,
        expiresAt,
        expectedAgentVersion: 1,
        expectedScopeVersion: scope.version,
        issuedAt: createdAt
      });
    }
  }

  return {
    agentRegistrations,
    sleeves: [...sleeves.values()],
    sleeveGrants: [...sleeveGrants.values()],
    toolGrants: [...toolGrants.values()]
  };
}

export function listRuntimeInstantiableRecipeIds(): string[] {
  return POD_RECIPES.filter(({ runtimeInstantiable }) => runtimeInstantiable).map(({ id }) => id);
}

export function planProfileInstance(rawInput: PlanProfileInstanceInput): ProfileInstancePlan {
  const input = PlanProfileInstanceInputSchema.parse(rawInput);
  const recipe = runtimeRecipe(input.recipeId);
  assertExactScopeBinding(recipe, input.scope, input.knowledgeScope);

  const recipeSha256 = sha256(JSON.stringify(recipe));
  // The identity is the whole approved lease, not just the recipe scope: a
  // renewal after quarantine is a distinct lease and must not reuse the
  // retired instance's ID or its derived agent IDs. Replanning the same lease
  // is still byte-identical, which is what makes installation idempotent.
  const instanceId = `profile-instance:${sha256(
    JSON.stringify([
      recipe.id,
      input.scope.id,
      input.scope.version,
      input.approvedBy,
      input.createdAt,
      input.expiresAt
    ])
  ).slice(0, 32)}`;
  const recipeMembers = [recipe.lead, ...recipe.members];
  const concreteLeadId = concreteAgentId(instanceId, recipe.lead.id);
  const members = recipeMembers.map((member, ordinal) =>
    concreteProfile(
      recipe,
      member,
      ordinal,
      instanceId,
      input.scope,
      input.knowledgeScope,
      concreteLeadId
    )
  );
  const accessManifest = buildAccessManifest(
    members,
    input.scope,
    input.createdAt,
    input.expiresAt
  );
  const manifest = ProfileInstanceManifestSchema.parse({
    instanceId,
    recipeId: recipe.id,
    recipeSha256,
    scope: input.scope,
    knowledgeScope: input.knowledgeScope,
    approvedBy: input.approvedBy,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    members,
    ...accessManifest
  });
  const manifestSha256 = sha256(JSON.stringify(manifest));
  return ProfileInstancePlanSchema.parse({ manifest, manifestSha256 });
}

export type { ProfileInstancePlan } from './profile-instance-contracts';
