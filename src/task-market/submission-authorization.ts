import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

import { z } from 'zod';

const TaskIdSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const WalletAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const TimestampSchema = z.iso.datetime({ offset: true });
const ZeroAmountSchema = z.union([z.literal('0'), z.null()]);

export const SubmissionApprovalSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    action: z.literal('taskmarket_submit'),
    approved: z.literal(true),
    taskId: TaskIdSchema,
    taskDigest: DigestSchema,
    artifactDigest: DigestSchema,
    walletAddress: WalletAddressSchema,
    maxPaymentBaseUnits: z.literal('0'),
    approvedBy: z.literal('owner'),
    approvedAt: TimestampSchema,
    expiresAt: TimestampSchema
  })
  .superRefine((approval, context) => {
    if (Date.parse(approval.expiresAt) <= Date.parse(approval.approvedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'approval expiry must be after approval time'
      });
    }
  });

const SubmissionIntentSchema = z.strictObject({
  taskId: TaskIdSchema,
  taskDigest: DigestSchema,
  artifactDigest: DigestSchema,
  walletAddress: WalletAddressSchema,
  projectRoot: z
    .string()
    .min(1)
    .refine(
      (value) => isAbsolute(value) && resolve(value) === value,
      'project root must be an absolute normalized path'
    )
});

const PendingActionSchema = z.strictObject({
  role: z.string().min(1).max(64),
  action: z.string().min(1).max(64),
  eligibleAddress: WalletAddressSchema.nullable(),
  requiresPayment: z.boolean(),
  paymentAmount: ZeroAmountSchema,
  availableAfter: TimestampSchema.nullable(),
  availableUntil: TimestampSchema.nullable()
});

const SubmissionInspectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  taskId: TaskIdSchema,
  taskDigest: DigestSchema,
  status: z.string().min(1).max(64),
  submissionWindowOpen: z.boolean(),
  expiresAt: TimestampSchema,
  pendingActions: z.array(PendingActionSchema).max(50)
});

const NowSchema = TimestampSchema;

type SubmissionIntent = z.infer<typeof SubmissionIntentSchema>;
type SubmissionApproval = z.infer<typeof SubmissionApprovalSchema>;
type SubmissionInspection = z.infer<typeof SubmissionInspectionSchema>;

export interface AuthorizedTaskmarketSubmission {
  schemaVersion: 1;
  authorized: true;
  authorizationDigest: string;
  expiresAt: string;
  command: {
    executable: 'taskmarket';
    args: ['task', 'submit', string, '--file', string];
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function normalizedTimestamp(value: string): string {
  return new Date(value).toISOString();
}

export function taskmarketSubmissionArtifactPath(projectRoot: string, taskId: string): string {
  const root = SubmissionIntentSchema.shape.projectRoot.parse(projectRoot);
  const normalizedTaskId = TaskIdSchema.parse(taskId).toLowerCase();
  return resolve(root, 'workspaces', 'taskmarket', normalizedTaskId.slice(2), 'submission.json');
}

export function authorizeTaskmarketSubmission(
  rawIntent: unknown,
  rawApproval: unknown,
  rawInspection: unknown,
  rawNow: string
): AuthorizedTaskmarketSubmission {
  const intent: SubmissionIntent = SubmissionIntentSchema.parse(rawIntent);
  const approval: SubmissionApproval = SubmissionApprovalSchema.parse(rawApproval);
  const inspection: SubmissionInspection = SubmissionInspectionSchema.parse(rawInspection);
  const now = Date.parse(NowSchema.parse(rawNow));

  if (!sameHex(intent.taskId, approval.taskId) || !sameHex(intent.taskId, inspection.taskId)) {
    throw new Error('Task ID is not bound to the current approval and inspection');
  }
  if (intent.taskDigest !== approval.taskDigest || intent.taskDigest !== inspection.taskDigest) {
    throw new Error('Task digest is not bound to the current approval and inspection');
  }
  if (intent.artifactDigest !== approval.artifactDigest) {
    throw new Error('Artifact digest is not bound to the current approval');
  }
  if (!sameHex(intent.walletAddress, approval.walletAddress)) {
    throw new Error('Wallet is not bound to the current approval');
  }
  if (approval.maxPaymentBaseUnits !== '0') {
    throw new Error('Taskmarket submission authorization cannot move funds');
  }

  const approvedAt = Date.parse(approval.approvedAt);
  const approvalExpiresAt = Date.parse(approval.expiresAt);
  if (approvedAt > now || approvalExpiresAt <= now) {
    throw new Error('Taskmarket submission approval is not current');
  }
  if (
    inspection.status !== 'open' ||
    !inspection.submissionWindowOpen ||
    Date.parse(inspection.expiresAt) <= now
  ) {
    throw new Error('Taskmarket submission window is not open');
  }

  const submitAction = inspection.pendingActions.find((action) => {
    const addressEligible =
      action.eligibleAddress === null || sameHex(action.eligibleAddress, intent.walletAddress);
    const available =
      (action.availableAfter === null || Date.parse(action.availableAfter) <= now) &&
      (action.availableUntil === null || Date.parse(action.availableUntil) > now);
    return (
      action.role === 'worker' &&
      action.action === 'submit' &&
      addressEligible &&
      !action.requiresPayment &&
      (action.paymentAmount === null || action.paymentAmount === '0') &&
      available
    );
  });
  if (submitAction === undefined) {
    throw new Error('No current free worker submit action is available');
  }

  const taskId = intent.taskId.toLowerCase();
  const artifactPath = taskmarketSubmissionArtifactPath(intent.projectRoot, taskId);
  const expiresAt = normalizedTimestamp(approval.expiresAt);
  const authorizationDigest = sha256(
    JSON.stringify({
      schemaVersion: 1,
      action: 'taskmarket_submit',
      taskId,
      taskDigest: intent.taskDigest,
      artifactDigest: intent.artifactDigest,
      walletSha256: sha256(`jarvis.taskmarket.wallet.v1:${intent.walletAddress.toLowerCase()}`),
      maxPaymentBaseUnits: '0',
      approvedAt: normalizedTimestamp(approval.approvedAt),
      expiresAt,
      taskExpiresAt: normalizedTimestamp(inspection.expiresAt),
      submitAvailableAfter:
        submitAction.availableAfter === null
          ? null
          : normalizedTimestamp(submitAction.availableAfter),
      submitAvailableUntil:
        submitAction.availableUntil === null
          ? null
          : normalizedTimestamp(submitAction.availableUntil),
      executable: 'taskmarket',
      args: ['task', 'submit', taskId, '--file', artifactPath]
    })
  );

  return {
    schemaVersion: 1,
    authorized: true,
    authorizationDigest,
    expiresAt,
    command: {
      executable: 'taskmarket',
      args: ['task', 'submit', taskId, '--file', artifactPath]
    }
  };
}
