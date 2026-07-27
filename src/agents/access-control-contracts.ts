import { z } from 'zod';

const canonicalIdPattern = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const agentIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const scopeSubjectPattern = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/u;
const purposePattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const toolIdPattern = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const scopeIdPattern =
  /^(personal|agency|task_market|company|client|project):[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/u;

const TimestampSchema = z.iso.datetime({ offset: true });
const PositiveVersionSchema = z.number().int().min(1).max(2_147_483_647);
const EntityStateSchema = z.enum(['active', 'disabled']);
const GrantStateSchema = z.enum(['active', 'revoked']);

function addDerivedIdentityIssue(context: z.RefinementCtx, path: string[], message: string): void {
  context.addIssue({ code: 'custom', path, message });
}

function timestampsAreOrdered(createdAt: string, updatedAt: string): boolean {
  return Date.parse(updatedAt) >= Date.parse(createdAt);
}

export const AUTHORITY_LAYERS = ['blueprint', 'operator', 'tenant', 'channel', 'run'] as const;

export const AuthorityLayerSchema = z.enum(AUTHORITY_LAYERS);
export const AccessSensitivitySchema = z.enum([
  'public',
  'internal',
  'confidential',
  'private',
  'restricted'
]);
export const ControlTrustDomainSchema = z.enum(['personal', 'agency', 'task_market']);
export const ControlScopeKindSchema = z.enum([
  'personal',
  'agency',
  'task_market',
  'company',
  'client',
  'project'
]);
export const ControlScopeIdSchema = z.string().min(5).max(128).regex(scopeIdPattern);
export const ControlScopeSubjectSchema = z.string().min(2).max(96).regex(scopeSubjectPattern);
export const AccessAgentIdSchema = z.string().min(3).max(64).regex(agentIdPattern);
export const AccessPurposeSchema = z.string().min(3).max(96).regex(purposePattern);
export const ToolCapabilityIdSchema = z.string().min(3).max(128).regex(toolIdPattern);
export const AccessGrantIdSchema = z.string().min(8).max(160).regex(canonicalIdPattern);
export const SharedApprovedBundleIdSchema = z
  .string()
  .min(18)
  .max(160)
  .regex(/^shared-bundle:[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);

export const MemorySleeveIdSchema = z.union([
  z
    .string()
    .min(5)
    .max(160)
    .regex(
      /^(?:personal|agency|task_market|shared|company|project):[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/u
    ),
  z
    .string()
    .min(9)
    .max(160)
    .regex(/^client:[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u),
  z
    .string()
    .min(17)
    .max(160)
    .regex(/^agent:[a-z][a-z0-9]*(?:-[a-z0-9]+)*:scratch$/u)
]);

export const MemorySleeveKindSchema = z.enum([
  'personal',
  'agency',
  'task_market',
  'company',
  'client',
  'project',
  'agent_scratch',
  'shared_approved'
]);

export const MemorySleevePartitionKeySchema = z
  .string()
  .min(20)
  .max(192)
  .regex(/^memory\/sleeves\/[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*){1,2}$/u);

export const RegisterControlScopeInputSchema = z
  .strictObject({
    id: ControlScopeIdSchema,
    kind: ControlScopeKindSchema,
    subjectId: ControlScopeSubjectSchema,
    parentScopeId: ControlScopeIdSchema.nullable(),
    trustDomain: ControlTrustDomainSchema,
    createdAt: TimestampSchema
  })
  .superRefine((scope, context) => {
    if (scope.id !== `${scope.kind}:${scope.subjectId}`) {
      addDerivedIdentityIssue(context, ['id'], 'scope ID must be derived from kind and subject');
    }
    if (scope.parentScopeId === scope.id) {
      addDerivedIdentityIssue(context, ['parentScopeId'], 'scope cannot contain itself');
    }
  });

export const ControlScopeRecordSchema = z
  .strictObject({
    id: ControlScopeIdSchema,
    kind: ControlScopeKindSchema,
    subjectId: ControlScopeSubjectSchema,
    parentScopeId: ControlScopeIdSchema.nullable(),
    trustDomain: ControlTrustDomainSchema,
    state: EntityStateSchema,
    version: PositiveVersionSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema
  })
  .superRefine((scope, context) => {
    if (scope.id !== `${scope.kind}:${scope.subjectId}`) {
      addDerivedIdentityIssue(context, ['id'], 'scope ID must be derived from kind and subject');
    }
    if (scope.parentScopeId === scope.id) {
      addDerivedIdentityIssue(context, ['parentScopeId'], 'scope cannot contain itself');
    }
    if (!timestampsAreOrdered(scope.createdAt, scope.updatedAt)) {
      addDerivedIdentityIssue(context, ['updatedAt'], 'updated timestamp precedes creation');
    }
  });

export const RegisterAccessAgentInputSchema = z.strictObject({
  id: AccessAgentIdSchema,
  homeScopeId: ControlScopeIdSchema,
  trustDomain: ControlTrustDomainSchema,
  profileRevision: PositiveVersionSchema,
  createdAt: TimestampSchema
});

export const AccessAgentRecordSchema = z
  .strictObject({
    id: AccessAgentIdSchema,
    homeScopeId: ControlScopeIdSchema,
    trustDomain: ControlTrustDomainSchema,
    profileRevision: PositiveVersionSchema,
    state: EntityStateSchema,
    version: PositiveVersionSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema
  })
  .superRefine((agent, context) => {
    if (!timestampsAreOrdered(agent.createdAt, agent.updatedAt)) {
      addDerivedIdentityIssue(context, ['updatedAt'], 'updated timestamp precedes creation');
    }
  });

export const RegisterMemorySleeveInputSchema = z
  .strictObject({
    id: MemorySleeveIdSchema,
    ownerScopeId: ControlScopeIdSchema,
    maxSensitivity: AccessSensitivitySchema,
    expiresAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema
  })
  .superRefine((sleeve, context) => {
    if (sleeve.expiresAt !== null && Date.parse(sleeve.expiresAt) <= Date.parse(sleeve.createdAt)) {
      addDerivedIdentityIssue(context, ['expiresAt'], 'sleeve expiry must follow creation');
    }
  });

export const MemorySleeveRecordSchema = z
  .strictObject({
    id: MemorySleeveIdSchema,
    ownerScopeId: ControlScopeIdSchema,
    kind: MemorySleeveKindSchema,
    maxSensitivity: AccessSensitivitySchema,
    partitionKey: MemorySleevePartitionKeySchema,
    expiresAt: TimestampSchema.nullable(),
    state: EntityStateSchema,
    version: PositiveVersionSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema
  })
  .superRefine((sleeve, context) => {
    if (!timestampsAreOrdered(sleeve.createdAt, sleeve.updatedAt)) {
      addDerivedIdentityIssue(context, ['updatedAt'], 'updated timestamp precedes creation');
    }
    if (sleeve.expiresAt !== null && Date.parse(sleeve.expiresAt) <= Date.parse(sleeve.createdAt)) {
      addDerivedIdentityIssue(context, ['expiresAt'], 'sleeve expiry must follow creation');
    }
  });

export const SleevePermissionSchema = z.enum(['read', 'propose']);
export const ToolAccessSchema = z.enum(['read', 'propose', 'execute']);

export const IssueAgentSleeveGrantInputSchema = z
  .strictObject({
    id: AccessGrantIdSchema,
    agentId: AccessAgentIdSchema,
    sleeveId: MemorySleeveIdSchema,
    authorityLayer: AuthorityLayerSchema,
    permission: SleevePermissionSchema,
    purpose: AccessPurposeSchema,
    sensitivityCap: AccessSensitivitySchema,
    expiresAt: TimestampSchema,
    expectedAgentVersion: PositiveVersionSchema,
    expectedScopeVersion: PositiveVersionSchema,
    expectedSleeveVersion: PositiveVersionSchema,
    issuedAt: TimestampSchema
  })
  .superRefine((grant, context) => {
    if (Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt)) {
      addDerivedIdentityIssue(context, ['expiresAt'], 'grant expiry must follow issuance');
    }
  });

export const AgentSleeveGrantRecordSchema = z
  .strictObject({
    id: AccessGrantIdSchema,
    agentId: AccessAgentIdSchema,
    sleeveId: MemorySleeveIdSchema,
    authorityLayer: AuthorityLayerSchema,
    permission: SleevePermissionSchema,
    purpose: AccessPurposeSchema,
    sensitivityCap: AccessSensitivitySchema,
    expiresAt: TimestampSchema,
    state: GrantStateSchema,
    version: PositiveVersionSchema,
    boundAgentVersion: PositiveVersionSchema,
    boundScopeVersion: PositiveVersionSchema,
    boundSleeveVersion: PositiveVersionSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema
  })
  .superRefine((grant, context) => {
    if (!timestampsAreOrdered(grant.createdAt, grant.updatedAt)) {
      addDerivedIdentityIssue(context, ['updatedAt'], 'updated timestamp precedes creation');
    }
    if (Date.parse(grant.expiresAt) <= Date.parse(grant.createdAt)) {
      addDerivedIdentityIssue(context, ['expiresAt'], 'grant expiry must follow issuance');
    }
  });

export const IssueAgentToolGrantInputSchema = z
  .strictObject({
    id: AccessGrantIdSchema,
    agentId: AccessAgentIdSchema,
    toolId: ToolCapabilityIdSchema,
    authorityLayer: AuthorityLayerSchema,
    access: ToolAccessSchema,
    purpose: AccessPurposeSchema,
    sensitivityCap: AccessSensitivitySchema,
    expiresAt: TimestampSchema,
    expectedAgentVersion: PositiveVersionSchema,
    expectedScopeVersion: PositiveVersionSchema,
    issuedAt: TimestampSchema
  })
  .superRefine((grant, context) => {
    if (Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt)) {
      addDerivedIdentityIssue(context, ['expiresAt'], 'grant expiry must follow issuance');
    }
  });

export const AgentToolGrantRecordSchema = z
  .strictObject({
    id: AccessGrantIdSchema,
    agentId: AccessAgentIdSchema,
    toolId: ToolCapabilityIdSchema,
    authorityLayer: AuthorityLayerSchema,
    access: ToolAccessSchema,
    purpose: AccessPurposeSchema,
    sensitivityCap: AccessSensitivitySchema,
    expiresAt: TimestampSchema,
    state: GrantStateSchema,
    version: PositiveVersionSchema,
    boundAgentVersion: PositiveVersionSchema,
    boundScopeVersion: PositiveVersionSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema
  })
  .superRefine((grant, context) => {
    if (!timestampsAreOrdered(grant.createdAt, grant.updatedAt)) {
      addDerivedIdentityIssue(context, ['updatedAt'], 'updated timestamp precedes creation');
    }
    if (Date.parse(grant.expiresAt) <= Date.parse(grant.createdAt)) {
      addDerivedIdentityIssue(context, ['expiresAt'], 'grant expiry must follow issuance');
    }
  });

export const GrantVersionSetSchema = z.strictObject({
  blueprint: PositiveVersionSchema,
  operator: PositiveVersionSchema,
  tenant: PositiveVersionSchema,
  channel: PositiveVersionSchema,
  run: PositiveVersionSchema
});

export const AgentAuthorizationPrincipalSchema = z.strictObject({
  agentId: AccessAgentIdSchema,
  expectedAgentVersion: PositiveVersionSchema
});

export const AuthorizeMemoryAccessInputSchema = z.strictObject({
  sleeveId: MemorySleeveIdSchema,
  expectedSleeveVersion: PositiveVersionSchema,
  expectedOwnerScopeVersion: PositiveVersionSchema,
  permission: SleevePermissionSchema,
  purpose: AccessPurposeSchema,
  sensitivity: AccessSensitivitySchema,
  grantVersions: GrantVersionSetSchema
});

export const AuthorizeMemoryRetrievalInputSchema = AuthorizeMemoryAccessInputSchema.safeExtend({
  permission: z.literal('read')
});

export const AuthorizeToolUseInputSchema = z.strictObject({
  toolId: ToolCapabilityIdSchema,
  expectedHomeScopeVersion: PositiveVersionSchema,
  access: ToolAccessSchema,
  purpose: AccessPurposeSchema,
  sensitivity: AccessSensitivitySchema,
  grantVersions: GrantVersionSetSchema
});

export const AuthorizedMemoryAccessSchema = z.strictObject({
  agentId: AccessAgentIdSchema,
  sleeveId: MemorySleeveIdSchema,
  ownerScopeId: ControlScopeIdSchema,
  partitionKey: MemorySleevePartitionKeySchema,
  permission: SleevePermissionSchema,
  purpose: AccessPurposeSchema,
  sensitivity: AccessSensitivitySchema,
  authorizedAt: TimestampSchema,
  effectiveExpiresAt: TimestampSchema,
  agentVersion: PositiveVersionSchema,
  ownerScopeVersion: PositiveVersionSchema,
  sleeveVersion: PositiveVersionSchema,
  grantVersions: GrantVersionSetSchema
});

export const AuthorizedMemoryRetrievalSchema = AuthorizedMemoryAccessSchema.safeExtend({
  permission: z.literal('read')
});

export const AuthorizedToolUseSchema = z.strictObject({
  agentId: AccessAgentIdSchema,
  homeScopeId: ControlScopeIdSchema,
  toolId: ToolCapabilityIdSchema,
  access: ToolAccessSchema,
  purpose: AccessPurposeSchema,
  sensitivity: AccessSensitivitySchema,
  authorizedAt: TimestampSchema,
  effectiveExpiresAt: TimestampSchema,
  agentVersion: PositiveVersionSchema,
  homeScopeVersion: PositiveVersionSchema,
  grantVersions: GrantVersionSetSchema
});

export const SharedApprovedFragmentSchema = z.strictObject({
  id: z
    .string()
    .min(10)
    .max(160)
    .regex(/^fragment:[a-z0-9]+(?:[._-][a-z0-9]+)*$/u),
  sourceDocumentId: z.string().min(3).max(160).regex(canonicalIdPattern),
  sourceVersion: PositiveVersionSchema,
  materializedText: z.string().trim().min(1).max(4_000),
  provenanceRef: z.string().min(3).max(256).regex(canonicalIdPattern)
});

export const PublishSharedApprovedBundleInputSchema = z
  .strictObject({
    id: SharedApprovedBundleIdSchema,
    sourceScopeId: ControlScopeIdSchema,
    expectedSourceScopeVersion: PositiveVersionSchema,
    targetSleeveId: MemorySleeveIdSchema,
    expectedTargetScopeVersion: PositiveVersionSchema,
    expectedTargetSleeveVersion: PositiveVersionSchema,
    purpose: AccessPurposeSchema,
    publishedSensitivity: AccessSensitivitySchema,
    fragments: z
      .array(SharedApprovedFragmentSchema)
      .min(1)
      .max(64)
      .refine(
        (fragments) => new Set(fragments.map(({ id }) => id)).size === fragments.length,
        'shared fragment IDs must be unique'
      ),
    reviewedBy: z
      .string()
      .min(12)
      .max(128)
      .regex(/^operator:[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/u),
    reviewedAt: TimestampSchema,
    expiresAt: TimestampSchema
  })
  .superRefine((bundle, context) => {
    if (Date.parse(bundle.expiresAt) <= Date.parse(bundle.reviewedAt)) {
      addDerivedIdentityIssue(context, ['expiresAt'], 'bundle expiry must follow review');
    }
  });

export const SharedApprovedBundleRecordSchema = PublishSharedApprovedBundleInputSchema.extend({
  contentSha256: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]{64}$/u),
  state: GrantStateSchema,
  version: PositiveVersionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
}).superRefine((bundle, context) => {
  if (!timestampsAreOrdered(bundle.createdAt, bundle.updatedAt)) {
    addDerivedIdentityIssue(context, ['updatedAt'], 'updated timestamp precedes creation');
  }
});

export const RevokeAccessRecordInputSchema = z.strictObject({
  id: AccessGrantIdSchema,
  expectedVersion: PositiveVersionSchema,
  revokedAt: TimestampSchema
});

export type AuthorityLayer = z.infer<typeof AuthorityLayerSchema>;
export type AccessSensitivity = z.infer<typeof AccessSensitivitySchema>;
export type ControlTrustDomain = z.infer<typeof ControlTrustDomainSchema>;
export type ControlScopeId = z.infer<typeof ControlScopeIdSchema>;
export type ControlScopeRecord = z.infer<typeof ControlScopeRecordSchema>;
export type RegisterControlScopeInput = z.infer<typeof RegisterControlScopeInputSchema>;
export type AccessAgentRecord = z.infer<typeof AccessAgentRecordSchema>;
export type RegisterAccessAgentInput = z.infer<typeof RegisterAccessAgentInputSchema>;
export type MemorySleeveId = z.infer<typeof MemorySleeveIdSchema>;
export type MemorySleeveKind = z.infer<typeof MemorySleeveKindSchema>;
export type MemorySleeveRecord = z.infer<typeof MemorySleeveRecordSchema>;
export type RegisterMemorySleeveInput = z.infer<typeof RegisterMemorySleeveInputSchema>;
export type AgentSleeveGrantRecord = z.infer<typeof AgentSleeveGrantRecordSchema>;
export type IssueAgentSleeveGrantInput = z.infer<typeof IssueAgentSleeveGrantInputSchema>;
export type AgentToolGrantRecord = z.infer<typeof AgentToolGrantRecordSchema>;
export type IssueAgentToolGrantInput = z.infer<typeof IssueAgentToolGrantInputSchema>;
export type GrantVersionSet = z.infer<typeof GrantVersionSetSchema>;
export type AgentAuthorizationPrincipal = z.infer<typeof AgentAuthorizationPrincipalSchema>;
export type AuthorizeMemoryAccessInput = z.infer<typeof AuthorizeMemoryAccessInputSchema>;
export type AuthorizeMemoryRetrievalInput = z.infer<typeof AuthorizeMemoryRetrievalInputSchema>;
export type AuthorizeToolUseInput = z.infer<typeof AuthorizeToolUseInputSchema>;
export type AuthorizedMemoryAccess = z.infer<typeof AuthorizedMemoryAccessSchema>;
export type AuthorizedMemoryRetrieval = z.infer<typeof AuthorizedMemoryRetrievalSchema>;
export type AuthorizedToolUse = z.infer<typeof AuthorizedToolUseSchema>;
export type SharedApprovedFragment = z.infer<typeof SharedApprovedFragmentSchema>;
export type PublishSharedApprovedBundleInput = z.infer<
  typeof PublishSharedApprovedBundleInputSchema
>;
export type SharedApprovedBundleRecord = z.infer<typeof SharedApprovedBundleRecordSchema>;
export type RevokeAccessRecordInput = z.infer<typeof RevokeAccessRecordInputSchema>;
