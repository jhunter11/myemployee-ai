import { z } from 'zod';

const clientIdPattern = /^[a-z][a-z0-9_]{2,62}$/;
const automationPattern = /^[a-z][a-z0-9-]{2,62}$/;
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const ClientIdSchema = z.string().regex(clientIdPattern);
export const AutomationIdSchema = z.string().regex(automationPattern);
export const RunIdSchema = z.string().regex(runIdPattern);

export const ClientProfileSchema = z.enum([
  'email_only',
  'data_processing',
  'offline_compute',
  'full_automation'
]);

export const ElevatedApprovalRecordSchema = z.strictObject({
  profile: ClientProfileSchema,
  approved: z.literal(true),
  approver: z.string().trim().min(1),
  timestamp: z.iso.datetime()
});

export const ClientConfigSchema = z.strictObject({
  id: ClientIdSchema,
  name: z.string().trim().min(1).max(120),
  profile: ClientProfileSchema,
  status: z.enum(['active', 'suspended']).default('active'),
  createdAt: z.iso.datetime(),
  workspacePath: z.string().min(1),
  clientDirectory: z.string().min(1),
  databasePath: z.string().min(1)
});

export const AgentRunSchema = z.strictObject({
  id: RunIdSchema,
  clientId: ClientIdSchema,
  automation: AutomationIdSchema,
  status: z.enum(['pending', 'running', 'succeeded', 'failed']),
  input: z.json().optional(),
  output: z.json().nullable().default(null),
  errorMessage: z.string().nullable().default(null),
  parentRunId: RunIdSchema.nullable().default(null),
  workerId: z.string().nullable().default(null),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable().default(null)
});

export const EscalationEventSchema = z.strictObject({
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  clientId: ClientIdSchema.nullable().default(null),
  runId: RunIdSchema.nullable().default(null),
  eventDescription: z.string().trim().min(1),
  actions: z.array(z.string().min(1)),
  resolved: z.boolean().default(false),
  timestamp: z.iso.datetime()
});

export const ToolPolicySchema = z
  .strictObject({
    description: z.string().min(1),
    tools_allow: z.array(z.string().min(1)),
    tools_deny: z.array(z.string().min(1)),
    exec_scope: z.string().min(1).optional(),
    requires_elevated_approval: z.boolean(),
    approval_record: z.string().min(1).optional()
  })
  .refine((policy) => !policy.tools_allow.some((tool) => policy.tools_deny.includes(tool)), {
    message: 'A tool cannot be both allowed and denied'
  })
  .refine((policy) => !policy.requires_elevated_approval || policy.approval_record !== undefined, {
    message: 'Elevated policies require an approval record'
  });

export const NetworkPolicySchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('none'),
    description: z.string().min(1).optional()
  }),
  z.strictObject({
    mode: z.literal('allowlist'),
    allowed_hosts: z.array(z.string().min(1)).min(1),
    deny_all_other: z.boolean(),
    notes: z.string().min(1).optional(),
    description: z.string().min(1).optional()
  })
]);

export const ToolPolicyFileSchema = z.strictObject({
  _comment: z.string().optional(),
  profiles: z.record(z.string(), ToolPolicySchema),
  client_assignments: z.record(z.string(), ClientProfileSchema).default({})
});

export const CreateClientRequestSchema = z.strictObject({
  id: ClientIdSchema,
  name: z.string().trim().min(1).max(120),
  profile: ClientProfileSchema
});

export const RunAutomationRequestSchema = z.strictObject({
  automation: AutomationIdSchema,
  input: z.json().optional()
});

export type ClientProfile = z.infer<typeof ClientProfileSchema>;
export type ElevatedApprovalRecord = z.infer<typeof ElevatedApprovalRecordSchema>;
export type ClientConfig = z.infer<typeof ClientConfigSchema>;
export type AgentRun = z.infer<typeof AgentRunSchema>;
export type EscalationEvent = z.infer<typeof EscalationEventSchema>;
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;
export type CreateClientRequest = z.infer<typeof CreateClientRequestSchema>;
export type RunAutomationRequest = z.infer<typeof RunAutomationRequestSchema>;
export type JsonValue = z.infer<ReturnType<typeof z.json>>;
