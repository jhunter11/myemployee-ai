import { z } from 'zod';

import {
  CommandPrincipalSchema,
  ServerScopeBindingSchema,
  SharedCommandRequestSchema
} from '../commands/contracts';

export const DelegationRunIdSchema = z.string().regex(/^run:[a-f0-9]{64}$/u);
export const DelegationSpanIdSchema = z.string().regex(/^span:[a-f0-9]{64}$/u);
export const DelegationDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const DelegationAgentIdSchema = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/u);
export const DelegationCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{2,63}$/u);
export const DelegationStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancel_requested',
  'cancelled'
]);
export const DelegationEventTypeSchema = z.enum([
  'run_queued',
  'run_started',
  'run_succeeded',
  'run_failed',
  'run_retried',
  'cancel_requested',
  'run_cancelled',
  'span_recorded'
]);
export const DelegationSpanKindSchema = z.enum(['orchestrator', 'agent', 'review', 'system']);
export const DelegationSpanOutcomeSchema = z.enum(['succeeded', 'failed', 'cancelled']);

const IdempotencyKeySchema = SharedCommandRequestSchema.shape.idempotencyKey;
const ExpectedVersionSchema = z.number().int().min(1).max(2_147_483_647);

export const CreateDelegationRootRequestSchema = z.strictObject({
  idempotencyKey: IdempotencyKeySchema,
  assignedAgentId: DelegationAgentIdSchema,
  operationCode: DelegationCodeSchema,
  inputDigest: DelegationDigestSchema
});

export const DelegateRunRequestSchema = CreateDelegationRootRequestSchema.extend({
  parentRunId: DelegationRunIdSchema
});

export const StartDelegationRunRequestSchema = z.strictObject({
  runId: DelegationRunIdSchema,
  expectedVersion: ExpectedVersionSchema
});

export const FinishDelegationRunRequestSchema = StartDelegationRunRequestSchema.extend({
  outcome: z.enum(['succeeded', 'failed']),
  resultCode: DelegationCodeSchema,
  evidenceDigest: DelegationDigestSchema.nullable().optional()
});

export const RetryDelegationRunRequestSchema = StartDelegationRunRequestSchema.extend({
  idempotencyKey: IdempotencyKeySchema
});

export const CancelDelegationRunRequestSchema = StartDelegationRunRequestSchema.extend({
  reasonCode: DelegationCodeSchema
});

export const RecordDelegationSpanRequestSchema = z.strictObject({
  runId: DelegationRunIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  parentSpanId: DelegationSpanIdSchema.nullable(),
  kind: DelegationSpanKindSchema,
  nameCode: DelegationCodeSchema,
  outcome: DelegationSpanOutcomeSchema,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  evidenceDigest: DelegationDigestSchema.nullable().optional()
});

export const DelegationRunRecordSchema = z.strictObject({
  id: DelegationRunIdSchema,
  rootRunId: DelegationRunIdSchema,
  parentRunId: DelegationRunIdSchema.nullable(),
  retryOfRunId: DelegationRunIdSchema.nullable(),
  scopeId: ServerScopeBindingSchema.shape.scopeId,
  trustDomain: ServerScopeBindingSchema.shape.trustDomain,
  tenantId: ServerScopeBindingSchema.shape.tenantId,
  policyVersion: ServerScopeBindingSchema.shape.policyVersion,
  principalId: CommandPrincipalSchema.shape.id,
  channel: CommandPrincipalSchema.shape.channel,
  idempotencyKey: IdempotencyKeySchema,
  requestDigest: DelegationDigestSchema,
  assignedAgentId: DelegationAgentIdSchema,
  operationCode: DelegationCodeSchema,
  inputDigest: DelegationDigestSchema,
  depth: z.number().int().min(0).max(32),
  attempt: z.number().int().min(1).max(32),
  status: DelegationStatusSchema,
  version: ExpectedVersionSchema,
  maxDepth: z.number().int().min(1).max(32),
  maxFanOut: z.number().int().min(1).max(64),
  maxAttempts: z.number().int().min(1).max(16),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  terminalAt: z.iso.datetime().nullable()
});

export const DelegationSpanRecordSchema = z.strictObject({
  id: DelegationSpanIdSchema,
  runId: DelegationRunIdSchema,
  rootRunId: DelegationRunIdSchema,
  parentSpanId: DelegationSpanIdSchema.nullable(),
  kind: DelegationSpanKindSchema,
  nameCode: DelegationCodeSchema,
  outcome: DelegationSpanOutcomeSchema,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  durationMs: z.number().int().min(0).max(86_400_000),
  recordedAt: z.iso.datetime()
});

export const DelegationSafeEventSchema = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]*$/u),
  runId: DelegationRunIdSchema,
  rootRunId: DelegationRunIdSchema,
  type: DelegationEventTypeSchema,
  code: DelegationCodeSchema,
  stateVersion: ExpectedVersionSchema,
  occurredAt: z.iso.datetime()
});

export const DelegationProjectionNodeSchema = z.strictObject({
  id: DelegationRunIdSchema,
  parentRunId: DelegationRunIdSchema.nullable(),
  retryOfRunId: DelegationRunIdSchema.nullable(),
  depth: z.number().int().min(0).max(32),
  attempt: z.number().int().min(1).max(32),
  assignedAgentId: DelegationAgentIdSchema,
  operationCode: DelegationCodeSchema,
  status: DelegationStatusSchema,
  version: ExpectedVersionSchema,
  childCount: z.number().int().min(0),
  spanCount: z.number().int().min(0),
  lastEventId: z.string().regex(/^[1-9][0-9]*$/u),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  terminalAt: z.iso.datetime().nullable()
});

export const DelegationProjectionSchema = z.strictObject({
  rootRunId: DelegationRunIdSchema,
  truncated: z.boolean(),
  nodes: z.array(DelegationProjectionNodeSchema).max(200),
  statusCounts: z.partialRecord(DelegationStatusSchema, z.number().int().min(0))
});

export type CreateDelegationRootRequest = z.infer<typeof CreateDelegationRootRequestSchema>;
export type DelegateRunRequest = z.infer<typeof DelegateRunRequestSchema>;
export type StartDelegationRunRequest = z.infer<typeof StartDelegationRunRequestSchema>;
export type FinishDelegationRunRequest = z.infer<typeof FinishDelegationRunRequestSchema>;
export type RetryDelegationRunRequest = z.infer<typeof RetryDelegationRunRequestSchema>;
export type CancelDelegationRunRequest = z.infer<typeof CancelDelegationRunRequestSchema>;
export type RecordDelegationSpanRequest = z.infer<typeof RecordDelegationSpanRequestSchema>;
export type DelegationRunRecord = z.infer<typeof DelegationRunRecordSchema>;
export type DelegationSpanRecord = z.infer<typeof DelegationSpanRecordSchema>;
export type DelegationSafeEvent = z.infer<typeof DelegationSafeEventSchema>;
export type DelegationProjectionNode = z.infer<typeof DelegationProjectionNodeSchema>;
export type DelegationProjection = z.infer<typeof DelegationProjectionSchema>;
export type DelegationStatus = z.infer<typeof DelegationStatusSchema>;
export type DelegationEventType = z.infer<typeof DelegationEventTypeSchema>;
export type DelegationSpanKind = z.infer<typeof DelegationSpanKindSchema>;
export type DelegationSpanOutcome = z.infer<typeof DelegationSpanOutcomeSchema>;
