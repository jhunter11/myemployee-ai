import { z } from 'zod';

import {
  CommandChannelSchema,
  CommandPrincipalSchema,
  ServerScopeBindingSchema
} from './contracts';

export const ActionProposalKindSchema = z.enum([
  'pause_runtime',
  'create_queue_work',
  'calendar_private_hold',
  'memory_change'
]);

export const ActionProposalRequestSchema = z.strictObject({
  sourceId: z.string().trim().min(3).max(160),
  kind: ActionProposalKindSchema,
  payloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  reversible: z.boolean(),
  externalEffect: z.boolean(),
  expiresInSeconds: z.number().int().min(30).max(3_600)
});

export const ActionProposalSchema = z.strictObject({
  id: z.string().regex(/^proposal:[a-f0-9]{64}$/),
  version: z.number().int().min(1),
  expectedVersion: z.number().int().min(1),
  sourceId: ActionProposalRequestSchema.shape.sourceId,
  principalId: CommandPrincipalSchema.shape.id,
  channel: CommandChannelSchema,
  scopeId: ServerScopeBindingSchema.shape.scopeId,
  tenantId: ServerScopeBindingSchema.shape.tenantId,
  policyVersion: ServerScopeBindingSchema.shape.policyVersion,
  kind: ActionProposalKindSchema,
  payloadDigest: ActionProposalRequestSchema.shape.payloadDigest,
  reversible: z.boolean(),
  externalEffect: z.boolean(),
  risk: z.enum(['low', 'medium', 'high', 'critical']),
  state: z.enum(['pending', 'approved', 'rejected', 'expired']),
  confirmationFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
});

export const ActionDecisionRequestSchema = z.strictObject({
  proposalId: ActionProposalSchema.shape.id,
  verdict: z.enum(['approved', 'rejected']),
  expectedVersion: z.number().int().min(1),
  confirmationFingerprint: ActionProposalSchema.shape.confirmationFingerprint
});

export const ActionDecisionSchema = z.strictObject({
  id: z.string().regex(/^decision:[a-f0-9]{64}$/),
  proposalId: ActionProposalSchema.shape.id,
  principalId: CommandPrincipalSchema.shape.id,
  verdict: z.enum(['approved', 'rejected']),
  proposalVersion: z.number().int().min(2),
  decidedAt: z.iso.datetime()
});

export type ActionProposalRequest = z.infer<typeof ActionProposalRequestSchema>;
export type ActionProposal = z.infer<typeof ActionProposalSchema>;
export type ActionDecisionRequest = z.infer<typeof ActionDecisionRequestSchema>;
export type ActionDecision = z.infer<typeof ActionDecisionSchema>;
