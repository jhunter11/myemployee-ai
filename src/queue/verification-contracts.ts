import { createHash } from 'node:crypto';

import { z } from 'zod';

import { AutomationIdSchema, ClientIdSchema } from '../config/schemas';
import { assertCanonicalJson } from '../reliability/canonical';
import {
  createArtifactClaimId,
  createQueueTaskId,
  createRunId,
  createSourceClaimId,
  createVerificationHoldId
} from '../reliability/identities';
import { QueueLeaseTokenSchema, QueueWorkerIdSchema } from './contracts';

export const MAX_CANDIDATE_RESULT_BYTES = 256 * 1024;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export const VerificationOpaqueIdSchema = z
  .string()
  .min(3)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const VerificationRevisionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const GeneratedReliabilityIdSchema = Sha256Schema;

export const SnapshotRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.startsWith('/') && !value.includes('\\') && !value.includes('\0'), {
    message: 'snapshotRelativePath must be a normalized relative POSIX path'
  })
  .refine((value) => !/\p{Cc}/u.test(value), {
    message: 'snapshotRelativePath must not contain control characters'
  })
  .refine(
    (value) =>
      value
        .split('/')
        .every((component) => component.length > 0 && component !== '.' && component !== '..'),
    { message: 'snapshotRelativePath must not contain empty, dot, or parent components' }
  );

export const CanonicalCandidateResultJsonSchema = z
  .string()
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_CANDIDATE_RESULT_BYTES, {
    message: `canonicalResultJson must be at most ${MAX_CANDIDATE_RESULT_BYTES} bytes`
  })
  .refine((value) => {
    try {
      assertCanonicalJson(value, { maxBytes: MAX_CANDIDATE_RESULT_BYTES });
      return true;
    } catch {
      return false;
    }
  }, 'canonicalResultJson must contain unique-key canonical JSON');

export const ArtifactScopeClaimStateSchema = z.enum([
  'executing',
  'verification_pending',
  'finalization_pending',
  'released',
  'abandoned'
]);

const LeaseBindingSchema = z.strictObject({
  tenantId: ClientIdSchema,
  taskId: GeneratedReliabilityIdSchema,
  capturedQueueVersion: z.number().int().min(1),
  queueAttempt: z.number().int().min(1),
  leaseOwner: QueueWorkerIdSchema,
  leaseToken: QueueLeaseTokenSchema,
  now: z.iso.datetime()
});

export const AcquireArtifactClaimInputSchema = LeaseBindingSchema.extend({
  schemaVersion: z.literal(1),
  claimId: GeneratedReliabilityIdSchema,
  artifactScopeKey: VerificationOpaqueIdSchema,
  automationId: AutomationIdSchema,
  executionRequestId: GeneratedReliabilityIdSchema,
  runId: GeneratedReliabilityIdSchema,
  acquiredAt: z.iso.datetime()
}).superRefine((input, context) => {
  if (Date.parse(input.acquiredAt) > Date.parse(input.now)) {
    context.addIssue({
      code: 'custom',
      path: ['acquiredAt'],
      message: 'acquiredAt must not be later than now'
    });
  }
  const expectedTaskId = createQueueTaskId({
    executionRequestId: input.executionRequestId,
    tenantId: input.tenantId,
    automationId: input.automationId
  });
  const expectedRunId = createRunId({
    executionRequestId: input.executionRequestId,
    queueTaskId: expectedTaskId
  });
  const expectedClaimId = createArtifactClaimId({
    artifactScopeKey: input.artifactScopeKey,
    executionRequestId: input.executionRequestId,
    runId: expectedRunId
  });
  if (input.taskId !== expectedTaskId) {
    context.addIssue({
      code: 'custom',
      path: ['taskId'],
      message: 'taskId does not match its canonical queue-task identity'
    });
  }
  if (input.runId !== expectedRunId) {
    context.addIssue({
      code: 'custom',
      path: ['runId'],
      message: 'runId does not match its canonical run identity'
    });
  }
  if (input.claimId !== expectedClaimId) {
    context.addIssue({
      code: 'custom',
      path: ['claimId'],
      message: 'claimId does not match its canonical artifact-claim identity'
    });
  }
});

export const RecordSourceSnapshotInputSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    sourceClaimId: GeneratedReliabilityIdSchema,
    artifactClaimId: GeneratedReliabilityIdSchema,
    taskId: GeneratedReliabilityIdSchema,
    runId: GeneratedReliabilityIdSchema,
    tenantId: ClientIdSchema,
    automationId: AutomationIdSchema,
    sourceRegistrationId: VerificationOpaqueIdSchema,
    snapshotRelativePath: SnapshotRelativePathSchema,
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sourceSha256: Sha256Schema,
    createdAt: z.iso.datetime()
  })
  .superRefine((input, context) => {
    const expectedSourceClaimId = createSourceClaimId({
      artifactClaimId: input.artifactClaimId,
      sourceRegistrationId: input.sourceRegistrationId
    });
    if (input.sourceClaimId !== expectedSourceClaimId) {
      context.addIssue({
        code: 'custom',
        path: ['sourceClaimId'],
        message: 'sourceClaimId does not match its canonical source-snapshot identity'
      });
    }
  });

export const FreezeCandidateInputSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    holdId: GeneratedReliabilityIdSchema,
    candidateId: VerificationOpaqueIdSchema,
    tenantId: ClientIdSchema,
    taskId: GeneratedReliabilityIdSchema,
    leasedVersion: z.number().int().min(1),
    queueAttempt: z.number().int().min(1),
    leaseOwner: QueueWorkerIdSchema,
    leaseToken: QueueLeaseTokenSchema,
    runId: GeneratedReliabilityIdSchema,
    automationId: AutomationIdSchema,
    executionRequestId: GeneratedReliabilityIdSchema,
    occurrenceId: GeneratedReliabilityIdSchema.nullable(),
    workerId: VerificationOpaqueIdSchema,
    artifactClaimId: GeneratedReliabilityIdSchema,
    artifactScopeKey: VerificationOpaqueIdSchema,
    expectedArtifactClaimVersion: z.number().int().min(1),
    sourceClaimId: GeneratedReliabilityIdSchema,
    sourceSha256: Sha256Schema,
    resultSchemaVersion: z.number().int().min(1),
    canonicalResultJson: CanonicalCandidateResultJsonSchema,
    resultSha256: Sha256Schema,
    artifactSha256: Sha256Schema,
    journalClaimId: VerificationOpaqueIdSchema,
    journalClaimSha256: Sha256Schema,
    criteriaSha256: Sha256Schema,
    capturedPostureVersion: z.number().int().min(1),
    verifierId: VerificationOpaqueIdSchema,
    verifierRevision: VerificationRevisionSchema,
    committedAt: z.iso.datetime(),
    now: z.iso.datetime()
  })
  .superRefine((input, context) => {
    if (Date.parse(input.committedAt) > Date.parse(input.now)) {
      context.addIssue({
        code: 'custom',
        path: ['committedAt'],
        message: 'committedAt must not be later than now'
      });
    }
    if (sha256(input.canonicalResultJson) !== input.resultSha256) {
      context.addIssue({
        code: 'custom',
        path: ['resultSha256'],
        message: 'resultSha256 does not match canonicalResultJson'
      });
    }
    const expectedTaskId = createQueueTaskId({
      executionRequestId: input.executionRequestId,
      tenantId: input.tenantId,
      automationId: input.automationId
    });
    const expectedRunId = createRunId({
      executionRequestId: input.executionRequestId,
      queueTaskId: expectedTaskId
    });
    const expectedClaimId = createArtifactClaimId({
      artifactScopeKey: input.artifactScopeKey,
      executionRequestId: input.executionRequestId,
      runId: expectedRunId
    });
    const expectedHoldId = createVerificationHoldId({
      tenantId: input.tenantId,
      queueTaskId: expectedTaskId,
      leasedVersion: input.leasedVersion,
      queueAttempt: input.queueAttempt,
      runId: expectedRunId
    });
    if (input.taskId !== expectedTaskId) {
      context.addIssue({
        code: 'custom',
        path: ['taskId'],
        message: 'taskId does not match its canonical queue-task identity'
      });
    }
    if (input.runId !== expectedRunId) {
      context.addIssue({
        code: 'custom',
        path: ['runId'],
        message: 'runId does not match its canonical run identity'
      });
    }
    if (input.artifactClaimId !== expectedClaimId) {
      context.addIssue({
        code: 'custom',
        path: ['artifactClaimId'],
        message: 'artifactClaimId does not match its canonical artifact-claim identity'
      });
    }
    if (input.holdId !== expectedHoldId) {
      context.addIssue({
        code: 'custom',
        path: ['holdId'],
        message: 'holdId does not match its canonical verification-hold identity'
      });
    }
  });

export const SettlementVerificationRequestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  holdId: GeneratedReliabilityIdSchema
});

export const ResolvedVerificationSubjectV1Schema = z
  .strictObject({
    tenantId: ClientIdSchema,
    taskId: GeneratedReliabilityIdSchema,
    leasedVersion: z.number().int().min(1),
    queueAttempt: z.number().int().min(1),
    leaseOwner: QueueWorkerIdSchema,
    runId: GeneratedReliabilityIdSchema,
    automationId: AutomationIdSchema,
    executionRequestId: GeneratedReliabilityIdSchema,
    occurrenceId: GeneratedReliabilityIdSchema.nullable(),
    candidateId: VerificationOpaqueIdSchema,
    artifactClaimId: GeneratedReliabilityIdSchema,
    artifactScopeKey: VerificationOpaqueIdSchema,
    sourceClaimId: GeneratedReliabilityIdSchema,
    capturedPostureVersion: z.number().int().min(1),
    verifierId: VerificationOpaqueIdSchema,
    verifierRevision: VerificationRevisionSchema,
    criteriaSha256: Sha256Schema
  })
  .superRefine((input, context) => {
    const expectedTaskId = createQueueTaskId({
      executionRequestId: input.executionRequestId,
      tenantId: input.tenantId,
      automationId: input.automationId
    });
    const expectedRunId = createRunId({
      executionRequestId: input.executionRequestId,
      queueTaskId: expectedTaskId
    });
    const expectedClaimId = createArtifactClaimId({
      artifactScopeKey: input.artifactScopeKey,
      executionRequestId: input.executionRequestId,
      runId: expectedRunId
    });
    if (input.taskId !== expectedTaskId) {
      context.addIssue({
        code: 'custom',
        path: ['taskId'],
        message: 'taskId does not match its canonical queue-task identity'
      });
    }
    if (input.runId !== expectedRunId) {
      context.addIssue({
        code: 'custom',
        path: ['runId'],
        message: 'runId does not match its canonical run identity'
      });
    }
    if (input.artifactClaimId !== expectedClaimId) {
      context.addIssue({
        code: 'custom',
        path: ['artifactClaimId'],
        message: 'artifactClaimId does not match its canonical artifact-claim identity'
      });
    }
  });

export const BoundedCandidateResultSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    canonicalResultJson: CanonicalCandidateResultJsonSchema,
    resultSha256: Sha256Schema,
    artifactSha256: Sha256Schema,
    journalClaimSha256: Sha256Schema,
    sourceClaimId: GeneratedReliabilityIdSchema,
    sourceSha256: Sha256Schema
  })
  .superRefine((input, context) => {
    if (sha256(input.canonicalResultJson) !== input.resultSha256) {
      context.addIssue({
        code: 'custom',
        path: ['resultSha256'],
        message: 'resultSha256 does not match canonicalResultJson'
      });
    }
  });

export type AcquireArtifactClaimInput = z.infer<typeof AcquireArtifactClaimInputSchema>;
export type RecordSourceSnapshotInput = z.infer<typeof RecordSourceSnapshotInputSchema>;
export type FreezeCandidateInput = z.infer<typeof FreezeCandidateInputSchema>;
export type SettlementVerificationRequestV1 = z.infer<typeof SettlementVerificationRequestV1Schema>;
export type ResolvedVerificationSubjectV1 = z.infer<typeof ResolvedVerificationSubjectV1Schema>;
export type BoundedCandidateResult = z.infer<typeof BoundedCandidateResultSchema>;

export interface ArtifactClaimReceipt {
  claimId: string;
  state: 'executing';
  version: number;
  acquiredAt: string;
  replayed: boolean;
}

export interface SourceSnapshotClaimReceipt {
  sourceClaimId: string;
  artifactClaimId: string;
  sourceSha256: string;
  size: number;
  createdAt: string;
  replayed: boolean;
}

export interface FreezeCandidateReceipt {
  holdId: string;
  candidateId: string;
  artifactClaimId: string;
  artifactClaimVersion: number;
  createdAt: string;
  replayed: boolean;
}
