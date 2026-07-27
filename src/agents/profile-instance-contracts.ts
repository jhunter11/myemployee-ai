import { z } from 'zod';

import { KnowledgeScopeRecordSchema } from '../knowledge/contracts';
import {
  AccessAgentIdSchema,
  ControlScopeRecordSchema,
  IssueAgentSleeveGrantInputSchema,
  IssueAgentToolGrantInputSchema,
  RegisterAccessAgentInputSchema,
  RegisterMemorySleeveInputSchema
} from './access-control-contracts';
import { OperatorIdSchema } from './access-lifecycle-contracts';
import { AgentProfileSchema } from './profile-catalog';

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const InstanceIdSchema = z.string().regex(/^profile-instance:[a-f0-9]{32}$/u);
const RecipeIdSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/u);
const TimestampSchema = z.iso.datetime({ offset: true });

function authorityKey(agentId: string, subjectId: string, mode: string): string {
  return [agentId, subjectId, mode].join('|');
}

export const ProfileInstanceStateSchema = z.enum(['planned', 'active', 'expired']);

export const ProfileInstanceMemberSchema = z.strictObject({
  ordinal: z.number().int().min(0).max(99),
  templateProfileId: AccessAgentIdSchema,
  profile: AgentProfileSchema
});

export const ProfileInstanceManifestSchema = z
  .strictObject({
    instanceId: InstanceIdSchema,
    recipeId: RecipeIdSchema,
    recipeSha256: DigestSchema,
    scope: ControlScopeRecordSchema,
    knowledgeScope: KnowledgeScopeRecordSchema,
    approvedBy: OperatorIdSchema,
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
    members: z.array(ProfileInstanceMemberSchema).min(1).max(100),
    agentRegistrations: z.array(RegisterAccessAgentInputSchema).min(1).max(100),
    sleeves: z.array(RegisterMemorySleeveInputSchema).min(1).max(1_600),
    sleeveGrants: z.array(IssueAgentSleeveGrantInputSchema).min(1).max(3_200),
    toolGrants: z.array(IssueAgentToolGrantInputSchema).min(1).max(3_200)
  })
  .superRefine((manifest, context) => {
    if (Date.parse(manifest.expiresAt) <= Date.parse(manifest.createdAt)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'profile instance expiry must follow creation'
      });
    }

    if (
      manifest.scope.state !== 'active' ||
      !['company', 'client', 'project'].includes(manifest.scope.kind)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['scope'],
        message: 'profile instance scope must be an active company, client, or project scope'
      });
    }
    if (
      Date.parse(manifest.scope.createdAt) > Date.parse(manifest.createdAt) ||
      Date.parse(manifest.scope.updatedAt) > Date.parse(manifest.createdAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['scope'],
        message: 'profile instance scope timestamps must not follow instance creation'
      });
    }
    if (Date.parse(manifest.knowledgeScope.createdAt) > Date.parse(manifest.createdAt)) {
      context.addIssue({
        code: 'custom',
        path: ['knowledgeScope'],
        message: 'knowledge scope creation must not follow profile instance creation'
      });
    }

    const expectedKnowledge =
      manifest.scope.kind === 'client'
        ? {
            id: `client:${manifest.scope.subjectId}`,
            kind: 'client',
            subjectId: manifest.scope.subjectId,
            clientId: manifest.scope.subjectId
          }
        : manifest.scope.kind === 'project'
          ? {
              id: `project:${manifest.scope.subjectId}`,
              kind: 'project',
              subjectId: manifest.scope.subjectId,
              clientId: null
            }
          : manifest.scope.kind === 'company'
            ? {
                id: `project:company_${manifest.scope.subjectId}`,
                kind: 'project',
                subjectId: `company_${manifest.scope.subjectId}`,
                clientId: null
              }
            : undefined;
    if (
      expectedKnowledge === undefined ||
      manifest.knowledgeScope.id !== expectedKnowledge.id ||
      manifest.knowledgeScope.kind !== expectedKnowledge.kind ||
      manifest.knowledgeScope.subjectId !== expectedKnowledge.subjectId ||
      manifest.knowledgeScope.clientId !== expectedKnowledge.clientId ||
      manifest.knowledgeScope.rootKey !==
        `knowledge/${expectedKnowledge.kind}/${expectedKnowledge.subjectId}` ||
      manifest.knowledgeScope.graphPartition !==
        `graphify/${expectedKnowledge.kind}/${expectedKnowledge.subjectId}`
    ) {
      context.addIssue({
        code: 'custom',
        path: ['knowledgeScope'],
        message: 'knowledge scope must exactly match the profile instance control scope'
      });
    }

    const memberAgentIds = new Set<string>();
    const templateProfileIds = new Set<string>();
    for (const [index, member] of manifest.members.entries()) {
      if (member.ordinal !== index) {
        context.addIssue({
          code: 'custom',
          path: ['members', index, 'ordinal'],
          message: 'profile instance member ordinals must be contiguous and ordered'
        });
      }
      if (memberAgentIds.has(member.profile.id)) {
        context.addIssue({
          code: 'custom',
          path: ['members', index, 'profile', 'id'],
          message: 'profile instance agent IDs must be unique'
        });
      }
      if (templateProfileIds.has(member.templateProfileId)) {
        context.addIssue({
          code: 'custom',
          path: ['members', index, 'templateProfileId'],
          message: 'profile instance template profile IDs must be unique'
        });
      }
      memberAgentIds.add(member.profile.id);
      templateProfileIds.add(member.templateProfileId);

      if (
        member.profile.lifecycle !== 'template' ||
        member.profile.trustDomain !== manifest.scope.trustDomain ||
        member.profile.knowledge.scopeId !== manifest.knowledgeScope.id ||
        member.profile.knowledge.partitionId !== manifest.knowledgeScope.graphPartition ||
        member.profile.memory.scratchSleeveId !== `agent:${member.profile.id}:scratch` ||
        member.profile.continuation.escalation.target !== member.profile.parentId
      ) {
        context.addIssue({
          code: 'custom',
          path: ['members', index, 'profile'],
          message: 'profile instance member is not bound to the exact instance scope and parent'
        });
      }
      if (
        member.profile.memory.readableSleeveIds.includes(`${manifest.scope.trustDomain}:core`) ||
        member.profile.memory.proposeWritableSleeveIds.includes(
          `${manifest.scope.trustDomain}:core`
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['members', index, 'profile', 'memory'],
          message: 'profile instance members cannot inherit the trust-domain core sleeve'
        });
      }
    }

    const lead = manifest.members[0]?.profile;
    if (lead !== undefined) {
      for (const [index, member] of manifest.members.entries()) {
        if (index > 0 && member.profile.parentId !== lead.id) {
          context.addIssue({
            code: 'custom',
            path: ['members', index, 'profile', 'parentId'],
            message: 'profile instance members must be parented to the concrete lead'
          });
        }
      }
    }

    const registrations = new Map(
      manifest.agentRegistrations.map((registration) => [registration.id, registration] as const)
    );
    if (
      registrations.size !== manifest.agentRegistrations.length ||
      registrations.size !== manifest.members.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['agentRegistrations'],
        message: 'profile instance agent registrations must exactly cover its members'
      });
    }
    for (const [index, member] of manifest.members.entries()) {
      const registration = registrations.get(member.profile.id);
      if (
        registration === undefined ||
        registration.homeScopeId !== manifest.scope.id ||
        registration.trustDomain !== member.profile.trustDomain ||
        registration.profileRevision !== member.profile.revision ||
        registration.createdAt !== manifest.createdAt
      ) {
        context.addIssue({
          code: 'custom',
          path: ['agentRegistrations', index],
          message: 'profile instance agent registration does not match its member snapshot'
        });
      }
    }

    // Access declared by the member profile snapshots is the only authority a
    // manifest may carry. Both directions are checked: a grant the profiles never
    // declared is undeclared authority, and a declared grant that is missing would
    // silently install a partially authorized pod.
    const declaredSleeveIds = new Set<string>();
    const declaredSleeveAuthority = new Set<string>();
    const declaredToolAuthority = new Set<string>();
    for (const { profile } of manifest.members) {
      const scratchSleeveId = profile.memory.scratchSleeveId;
      for (const sleeveId of [
        scratchSleeveId,
        ...profile.memory.readableSleeveIds,
        ...profile.memory.proposeWritableSleeveIds
      ]) {
        declaredSleeveIds.add(sleeveId);
      }
      for (const sleeveId of [...profile.memory.readableSleeveIds, scratchSleeveId]) {
        declaredSleeveAuthority.add(authorityKey(profile.id, sleeveId, 'read'));
      }
      for (const sleeveId of [...profile.memory.proposeWritableSleeveIds, scratchSleeveId]) {
        declaredSleeveAuthority.add(authorityKey(profile.id, sleeveId, 'propose'));
      }
      for (const tool of profile.toolGrants) {
        declaredToolAuthority.add(authorityKey(profile.id, tool.id, tool.access));
      }
    }

    const sleeveIds = new Set<string>();
    for (const [index, sleeve] of manifest.sleeves.entries()) {
      if (sleeveIds.has(sleeve.id)) {
        context.addIssue({
          code: 'custom',
          path: ['sleeves', index, 'id'],
          message: 'profile instance sleeve IDs must be unique'
        });
      }
      sleeveIds.add(sleeve.id);
      if (
        sleeve.ownerScopeId !== manifest.scope.id ||
        sleeve.createdAt !== manifest.createdAt ||
        sleeve.expiresAt !== manifest.expiresAt ||
        !declaredSleeveIds.has(sleeve.id)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['sleeves', index],
          message: 'profile instance sleeve must be owned and bounded by the exact instance scope'
        });
      }
    }
    if (sleeveIds.size !== declaredSleeveIds.size) {
      context.addIssue({
        code: 'custom',
        path: ['sleeves'],
        message: 'profile instance sleeves must exactly cover the sleeves its profiles declare'
      });
    }

    const sleeveGrantIds = new Set<string>();
    const grantedSleeveAuthority = new Set<string>();
    for (const [index, grant] of manifest.sleeveGrants.entries()) {
      if (sleeveGrantIds.has(grant.id)) {
        context.addIssue({
          code: 'custom',
          path: ['sleeveGrants', index, 'id'],
          message: 'profile instance sleeve grant IDs must be unique'
        });
      }
      sleeveGrantIds.add(grant.id);
      grantedSleeveAuthority.add(authorityKey(grant.agentId, grant.sleeveId, grant.permission));
      if (
        !memberAgentIds.has(grant.agentId) ||
        !sleeveIds.has(grant.sleeveId) ||
        !declaredSleeveAuthority.has(
          authorityKey(grant.agentId, grant.sleeveId, grant.permission)
        ) ||
        grant.authorityLayer !== 'blueprint' ||
        grant.expiresAt !== manifest.expiresAt ||
        grant.issuedAt !== manifest.createdAt ||
        grant.expectedScopeVersion !== manifest.scope.version
      ) {
        context.addIssue({
          code: 'custom',
          path: ['sleeveGrants', index],
          message: 'profile instance sleeve grant exceeds its exact blueprint snapshot'
        });
      }
    }
    // Compared as authority tuples rather than grant counts: two grants naming
    // the same agent, sleeve, and permission would otherwise balance the count
    // while a declared permission went unissued.
    if (grantedSleeveAuthority.size !== declaredSleeveAuthority.size) {
      context.addIssue({
        code: 'custom',
        path: ['sleeveGrants'],
        message: 'profile instance sleeve grants must exactly cover the memory its profiles declare'
      });
    }

    const toolGrantIds = new Set<string>();
    const grantedToolAuthority = new Set<string>();
    for (const [index, grant] of manifest.toolGrants.entries()) {
      if (toolGrantIds.has(grant.id)) {
        context.addIssue({
          code: 'custom',
          path: ['toolGrants', index, 'id'],
          message: 'profile instance tool grant IDs must be unique'
        });
      }
      toolGrantIds.add(grant.id);
      grantedToolAuthority.add(authorityKey(grant.agentId, grant.toolId, grant.access));
      if (
        !memberAgentIds.has(grant.agentId) ||
        !declaredToolAuthority.has(authorityKey(grant.agentId, grant.toolId, grant.access)) ||
        grant.authorityLayer !== 'blueprint' ||
        grant.expiresAt !== manifest.expiresAt ||
        grant.issuedAt !== manifest.createdAt ||
        grant.expectedScopeVersion !== manifest.scope.version
      ) {
        context.addIssue({
          code: 'custom',
          path: ['toolGrants', index],
          message: 'profile instance tool grant exceeds its exact blueprint snapshot'
        });
      }
    }
    if (grantedToolAuthority.size !== declaredToolAuthority.size) {
      context.addIssue({
        code: 'custom',
        path: ['toolGrants'],
        message: 'profile instance tool grants must exactly cover the tools its profiles declare'
      });
    }
  });

export const ProfileInstancePlanSchema = z.strictObject({
  manifest: ProfileInstanceManifestSchema,
  manifestSha256: DigestSchema
});

export type ProfileInstanceState = z.infer<typeof ProfileInstanceStateSchema>;
export type ProfileInstanceMember = z.infer<typeof ProfileInstanceMemberSchema>;
export type ProfileInstanceManifest = z.infer<typeof ProfileInstanceManifestSchema>;
export type ProfileInstancePlan = z.infer<typeof ProfileInstancePlanSchema>;
