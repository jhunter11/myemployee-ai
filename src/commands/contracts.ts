import { z } from 'zod';

const BoundedIdentifierSchema = z.string().trim().min(3).max(160);

export const CommandChannelSchema = z.enum(['web', 'telegram', 'local']);
export const CommandAuthoritySchema = z.enum(['read', 'propose', 'approve', 'execute_internal']);

export const CommandPrincipalSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(/^principal:[a-z][a-z0-9_-]{2,63}$/),
  kind: z.enum(['operator', 'channel_adapter', 'agent']),
  channel: CommandChannelSchema,
  authority: z.array(CommandAuthoritySchema).min(1).max(4)
});

export const ServerScopeBindingSchema = z.strictObject({
  scopeId: BoundedIdentifierSchema,
  trustDomain: z.enum(['personal', 'agency', 'mcp_x402', 'system']),
  tenantId: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{2,63}$/)
    .nullable(),
  policyVersion: z.number().int().min(1)
});

export const SharedCommandRequestSchema = z.strictObject({
  message: z.string().trim().min(1).max(2_000),
  idempotencyKey: z.string().regex(/^(?:web|telegram|local):[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/)
});

export const CommandEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  commandId: z.string().regex(/^command:[a-f0-9]{64}$/),
  principalId: CommandPrincipalSchema.shape.id,
  channel: CommandChannelSchema,
  scopeId: BoundedIdentifierSchema,
  tenantId: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{2,63}$/)
    .nullable(),
  policyVersion: z.number().int().min(1),
  kind: z.literal('bounded_read'),
  payloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  idempotencyKey: SharedCommandRequestSchema.shape.idempotencyKey,
  expectedVersion: z.literal(1),
  risk: z.literal('read_only'),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  confirmationFingerprint: z.null()
});

export const BoundedCommandResponseSchema = z.strictObject({
  mode: z.literal('deterministic'),
  intent: z.enum(['today', 'calendar', 'memory', 'agency', 'pages', 'help']),
  reply: z.string().trim().min(1).max(4_000),
  suggestedView: z.enum(['today', 'calendar', 'personal', 'agency', 'saved']),
  evidenceRefs: z.array(z.string().trim().min(1).max(240)).max(100),
  requiresApproval: z.literal(false)
});

export const CommandReceiptSchema = z.strictObject({
  envelope: CommandEnvelopeSchema,
  response: BoundedCommandResponseSchema,
  executedAt: z.iso.datetime()
});

export type CommandPrincipal = z.infer<typeof CommandPrincipalSchema>;
export type ServerScopeBinding = z.infer<typeof ServerScopeBindingSchema>;
export type SharedCommandRequest = z.infer<typeof SharedCommandRequestSchema>;
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;
export type BoundedCommandResponse = z.infer<typeof BoundedCommandResponseSchema>;
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;
