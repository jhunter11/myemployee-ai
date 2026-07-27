import { z } from 'zod';

import { AutomationIdSchema, ClientIdSchema } from '../config/schemas';

const OperationalIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);
const OpaqueReferenceSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);
export const QueueLaneSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,62}$/);
export const QueueWorkerIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);
export const QueueLeaseTokenSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);

export const QueuePolicyBandSchema = z.enum(['P0', 'P1', 'P2', 'P3']);
export const QueuePolicySchema = z.strictObject({
  band: QueuePolicyBandSchema,
  impact: z.number().int().min(0).max(10),
  urgency: z.number().int().min(0).max(10),
  effort: z.number().int().min(1).max(10)
});

export const QueueSourceSchema = z.strictObject({
  kind: z.enum(['api', 'operator', 'project', 'recovery', 'schedule']),
  id: OperationalIdSchema,
  occurredAt: z.iso.datetime()
});

export const QueuePayloadKindSchema = z.enum(['automation', 'project_task', 'operator_gate']);

export const QueuePayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('automation'),
    automationId: AutomationIdSchema,
    inputRef: OpaqueReferenceSchema.optional()
  }),
  z.strictObject({
    kind: z.literal('project_task'),
    projectId: z.string().regex(/^[a-z][a-z0-9_-]{2,62}$/),
    taskType: z.enum(['build', 'research', 'review', 'verify']),
    artifactRef: OpaqueReferenceSchema.optional()
  }),
  z.strictObject({
    kind: z.literal('operator_gate'),
    gateType: z.enum(['approval', 'budget', 'release', 'security']),
    subjectRef: OpaqueReferenceSchema
  })
]);

export const QueueTaskInputSchema = z
  .strictObject({
    id: OperationalIdSchema,
    tenantId: ClientIdSchema,
    lane: QueueLaneSchema,
    source: QueueSourceSchema,
    payload: QueuePayloadSchema,
    policy: QueuePolicySchema,
    dependencies: z.array(OperationalIdSchema).max(32),
    availableAt: z.iso.datetime().optional()
  })
  .superRefine((task, context) => {
    if (new Set(task.dependencies).size !== task.dependencies.length) {
      context.addIssue({
        code: 'custom',
        path: ['dependencies'],
        message: 'dependencies must be unique'
      });
    }
    if (task.dependencies.includes(task.id)) {
      context.addIssue({
        code: 'custom',
        path: ['dependencies'],
        message: 'a task cannot depend on itself'
      });
    }
    if (
      task.availableAt !== undefined &&
      Date.parse(task.availableAt) < Date.parse(task.source.occurredAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['availableAt'],
        message: 'availableAt must not precede source.occurredAt'
      });
    }
  });

export const QueueTaskStateSchema = z.enum(['queued', 'leased', 'succeeded', 'failed']);
export const QueueFailureReasonSchema = z.enum([
  'cancelled',
  'dependency_invalidated',
  'policy_blocked',
  'verification_failed',
  'worker_error'
]);

export const QueueClaimInputSchema = z.strictObject({
  tenantId: ClientIdSchema,
  workerId: QueueWorkerIdSchema,
  leaseToken: QueueLeaseTokenSchema,
  now: z.iso.datetime(),
  leaseDurationMs: z.number().int().min(1_000).max(86_400_000),
  payloadKinds: z
    .array(QueuePayloadKindSchema)
    .min(1)
    .max(QueuePayloadKindSchema.options.length)
    .refine((values) => new Set(values).size === values.length, 'payloadKinds must be unique')
    .optional()
});

const QueueSettlementBaseSchema = z.strictObject({
  tenantId: ClientIdSchema,
  taskId: OperationalIdSchema,
  workerId: QueueWorkerIdSchema,
  leaseToken: QueueLeaseTokenSchema,
  expectedVersion: z.number().int().min(1),
  now: z.iso.datetime()
});

export const QueueSettlementInputSchema = z.discriminatedUnion('outcome', [
  QueueSettlementBaseSchema.extend({ outcome: z.literal('succeeded') }),
  QueueSettlementBaseSchema.extend({
    outcome: z.literal('failed'),
    reasonCode: QueueFailureReasonSchema
  })
]);

export const QueueReadQuerySchema = z.strictObject({
  tenantId: ClientIdSchema,
  limit: z.number().int().min(1).max(50),
  now: z.iso.datetime()
});

export const QueueDecisionLogQuerySchema = z.strictObject({
  tenantId: ClientIdSchema,
  limit: z.number().int().min(1).max(50)
});

export const QueueDecisionCodeSchema = z.enum([
  'source_accepted',
  'lane_head_claimed',
  'expired_lease_reclaimed',
  'lease_succeeded',
  'lease_failed'
]);

export type QueuePolicyBand = z.infer<typeof QueuePolicyBandSchema>;
export type QueuePolicy = z.infer<typeof QueuePolicySchema>;
export type QueuePayload = z.infer<typeof QueuePayloadSchema>;
export type QueueTaskInput = z.infer<typeof QueueTaskInputSchema>;
export type QueueTaskState = z.infer<typeof QueueTaskStateSchema>;
export type QueueClaimInput = z.infer<typeof QueueClaimInputSchema>;
export type QueueSettlementInput = z.infer<typeof QueueSettlementInputSchema>;
export type QueueFailureReason = z.infer<typeof QueueFailureReasonSchema>;
export type QueueDecisionCode = z.infer<typeof QueueDecisionCodeSchema>;

export interface QueueTaskReceipt {
  id: string;
  tenantId: string;
  lane: string;
  payloadKind: QueuePayload['kind'];
  policy: QueuePolicy;
  state: QueueTaskState;
  version: number;
  dependencyCount: number;
  createdAt: string;
  availableAt: string;
}

/**
 * Enqueue is idempotent on (tenantId, source.kind, source.id): re-submitting identical work
 * returns the existing row rather than failing. `inserted` distinguishes the two outcomes so
 * callers can report what actually changed instead of assuming every submit created a task.
 */
export interface QueueEnqueueReceipt extends QueueTaskReceipt {
  inserted: boolean;
}

export interface QueueLease {
  id: string;
  tenantId: string;
  lane: string;
  payload: QueuePayload;
  policy: QueuePolicy;
  version: number;
  effectiveScore: number;
  lease: {
    token: string;
    expiresAt: string;
    attempt: number;
  };
}

export interface RedactedQueueTask {
  id: string;
  tenantId: string;
  lane: string;
  payloadKind: QueuePayload['kind'];
  /** Present only for automation binding checks; never includes worker input. */
  automationId?: string;
  band: QueuePolicyBand;
  state: QueueTaskState;
  version: number;
  dependencyCount: number;
  blockedDependencyCount: number;
  createdAt: string;
  availableAt: string;
  ready: boolean;
}

export interface TenantQueueView {
  tenantId: string;
  returnedTaskCount: number;
  truncated: boolean;
  lanes: Array<{
    lane: string;
    ready: RedactedQueueTask[];
    blocked: RedactedQueueTask[];
  }>;
}

export interface RedactedQueueDecision {
  sequence: number;
  taskId: string;
  tenantId: string;
  eventAt: string;
  decisionCode: QueueDecisionCode;
  fromState: QueueTaskState | null;
  toState: QueueTaskState;
  taskVersion: number;
}
