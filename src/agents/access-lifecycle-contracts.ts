import { z } from 'zod';

import {
  AccessGrantIdSchema,
  IssueAgentSleeveGrantInputSchema,
  IssueAgentToolGrantInputSchema,
  PublishSharedApprovedBundleInputSchema,
  SharedApprovedBundleIdSchema
} from './access-control-contracts';

const TimestampSchema = z.iso.datetime({ offset: true });
const PositiveVersionSchema = z.number().int().min(1).max(2_147_483_646);

export const AccessLifecycleResourceKindSchema = z.enum([
  'sleeve_grant',
  'tool_grant',
  'shared_bundle'
]);
export const AccessLifecycleActionSchema = z.enum(['revoked', 'replaced']);
export const AccessLifecycleReasonSchema = z
  .string()
  .min(3)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u);
export const OperatorIdSchema = z
  .string()
  .min(12)
  .max(128)
  .regex(/^operator:[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/u);

export const VerifiedOperatorIdentitySchema = z.strictObject({ id: OperatorIdSchema });

export const RevokeGrantInputSchema = z.discriminatedUnion('resourceKind', [
  z.strictObject({
    resourceKind: z.literal('sleeve_grant'),
    id: AccessGrantIdSchema,
    expectedVersion: PositiveVersionSchema,
    reason: AccessLifecycleReasonSchema,
    occurredAt: TimestampSchema
  }),
  z.strictObject({
    resourceKind: z.literal('tool_grant'),
    id: AccessGrantIdSchema,
    expectedVersion: PositiveVersionSchema,
    reason: AccessLifecycleReasonSchema,
    occurredAt: TimestampSchema
  })
]);

export const ReplaceGrantInputSchema = z.discriminatedUnion('resourceKind', [
  z.strictObject({
    resourceKind: z.literal('sleeve_grant'),
    id: AccessGrantIdSchema,
    expectedVersion: PositiveVersionSchema,
    reason: AccessLifecycleReasonSchema,
    occurredAt: TimestampSchema,
    replacement: IssueAgentSleeveGrantInputSchema
  }),
  z.strictObject({
    resourceKind: z.literal('tool_grant'),
    id: AccessGrantIdSchema,
    expectedVersion: PositiveVersionSchema,
    reason: AccessLifecycleReasonSchema,
    occurredAt: TimestampSchema,
    replacement: IssueAgentToolGrantInputSchema
  })
]);

export const RevokeSharedBundleInputSchema = z.strictObject({
  id: SharedApprovedBundleIdSchema,
  expectedVersion: PositiveVersionSchema,
  reason: AccessLifecycleReasonSchema,
  occurredAt: TimestampSchema
});

export const ReplaceSharedBundleInputSchema = RevokeSharedBundleInputSchema.extend({
  replacement: PublishSharedApprovedBundleInputSchema
});

export const AccessLifecycleProjectionInputSchema = z.strictObject({
  resourceKind: AccessLifecycleResourceKindSchema.optional(),
  resourceId: z.string().min(8).max(160).optional(),
  limit: z.number().int().min(1).max(100).default(50)
});

export const AccessLifecycleEventSchema = z.strictObject({
  sequence: z.number().int().positive(),
  id: z
    .string()
    .length(77)
    .regex(/^access-event:[a-f0-9]{64}$/u),
  resourceKind: AccessLifecycleResourceKindSchema,
  resourceId: z.string().min(8).max(160),
  action: AccessLifecycleActionSchema,
  replacementResourceId: z.string().min(8).max(160).nullable(),
  priorVersion: PositiveVersionSchema,
  resultingVersion: z.number().int().min(2).max(2_147_483_647),
  actorId: OperatorIdSchema,
  reason: AccessLifecycleReasonSchema,
  evidenceSha256: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]{64}$/u),
  occurredAt: TimestampSchema
});

export type AccessLifecycleResourceKind = z.infer<typeof AccessLifecycleResourceKindSchema>;
export type AccessLifecycleAction = z.infer<typeof AccessLifecycleActionSchema>;
export type VerifiedOperatorIdentity = z.infer<typeof VerifiedOperatorIdentitySchema>;
export type RevokeGrantInput = z.infer<typeof RevokeGrantInputSchema>;
export type ReplaceGrantInput = z.infer<typeof ReplaceGrantInputSchema>;
export type RevokeSharedBundleInput = z.infer<typeof RevokeSharedBundleInputSchema>;
export type ReplaceSharedBundleInput = z.infer<typeof ReplaceSharedBundleInputSchema>;
export type AccessLifecycleProjectionInput = z.infer<typeof AccessLifecycleProjectionInputSchema>;
export type AccessLifecycleEvent = z.infer<typeof AccessLifecycleEventSchema>;
