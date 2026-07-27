import { createHash } from 'node:crypto';

import { z } from 'zod';

export const TASKMARKET_API_ORIGIN = 'https://api.taskmarket.dev' as const;

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 256 * 1_024;
const MAX_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1_048_576;

const TaskIdSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const WalletAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const AmountSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,77})$/);
const TimestampSchema = z.iso.datetime({ offset: true });
const TaskStatusSchema = z.enum([
  'open',
  'claimed',
  'worker_selected',
  'pending_approval',
  'review',
  'appealing',
  'disputed',
  'completed',
  'expired',
  'cancelled'
]);
const PendingActionRoleSchema = z.enum([
  'requester',
  'worker',
  'evaluator',
  'dispute_resolver',
  'anyone'
]);
const PendingActionNameSchema = z.enum([
  'accept',
  'accept_submissions',
  'appeal',
  'auction_accept',
  'bid',
  'cancel',
  'claim',
  'evaluate',
  'evaluator_timeout',
  'finalize_verdict',
  'forfeit',
  'pitch',
  'rate',
  'reject_submission',
  'refund_expired',
  'resolve_dispute',
  'select_winner',
  'select_worker',
  'submit',
  'submit_proof',
  'update'
]);

// Deliberately not strict: Taskmarket may add informational fields, but only this
// bounded allowlist is parsed and projected into the local authority record.
const PendingActionResponseSchema = z.object({
  role: PendingActionRoleSchema,
  action: PendingActionNameSchema,
  command: z.string().max(4_000),
  eligibleAddress: WalletAddressSchema.nullable(),
  requiresPayment: z.boolean(),
  paymentAmount: AmountSchema.nullable(),
  availableAfter: TimestampSchema.nullable(),
  availableUntil: TimestampSchema.nullable()
});

const TaskDetailResponseSchema = z.object({
  id: TaskIdSchema,
  description: z.string().max(100_000),
  reward: AmountSchema,
  expiryTime: TimestampSchema,
  status: TaskStatusSchema,
  submissionWindowOpen: z.boolean(),
  pendingActions: z.array(PendingActionResponseSchema).max(50)
});

type TaskDetailResponse = z.infer<typeof TaskDetailResponseSchema>;

export type TaskmarketInspectorErrorCode =
  | 'invalid_task_id'
  | 'timeout'
  | 'transport_error'
  | 'upstream_status'
  | 'response_too_large'
  | 'invalid_response';

export class TaskmarketInspectorError extends Error {
  public readonly code: TaskmarketInspectorErrorCode;

  public constructor(code: TaskmarketInspectorErrorCode) {
    super('Taskmarket inspection rejected');
    this.name = 'TaskmarketInspectorError';
    this.code = code;
  }
}

export interface TaskmarketInspectorOptions {
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export interface TaskmarketSubmissionActionInspection {
  role: 'worker';
  action: 'submit';
  eligibleAddress: string | null;
  requiresPayment: false;
  paymentAmount: '0' | null;
  availableAfter: string | null;
  availableUntil: string | null;
}

export interface TaskmarketSubmissionInspection {
  schemaVersion: 1;
  taskId: string;
  taskDigest: string;
  status: z.infer<typeof TaskStatusSchema>;
  submissionWindowOpen: boolean;
  expiresAt: string;
  pendingActions: TaskmarketSubmissionActionInspection[];
}

function integerOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizedTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function compareActions(
  left: TaskmarketSubmissionActionInspection,
  right: TaskmarketSubmissionActionInspection
): number {
  const leftCanonical = canonicalJson(left);
  const rightCanonical = canonicalJson(right);
  if (leftCanonical === rightCanonical) {
    return 0;
  }
  return leftCanonical < rightCanonical ? -1 : 1;
}

function sanitizePendingActions(task: TaskDetailResponse): TaskmarketSubmissionActionInspection[] {
  const actions: TaskmarketSubmissionActionInspection[] = [];
  for (const action of task.pendingActions) {
    if (action.role !== 'worker' || action.action !== 'submit') {
      continue;
    }
    if (action.requiresPayment) {
      continue;
    }
    if (action.paymentAmount !== null && action.paymentAmount !== '0') {
      throw new TaskmarketInspectorError('invalid_response');
    }
    actions.push({
      role: 'worker',
      action: 'submit',
      eligibleAddress: action.eligibleAddress?.toLowerCase() ?? null,
      requiresPayment: false,
      paymentAmount: action.paymentAmount,
      availableAfter:
        action.availableAfter === null ? null : normalizedTimestamp(action.availableAfter),
      availableUntil:
        action.availableUntil === null ? null : normalizedTimestamp(action.availableUntil)
    });
  }
  return actions.sort(compareActions);
}

function projectInspection(
  task: TaskDetailResponse,
  requestedTaskId: string
): TaskmarketSubmissionInspection {
  const taskId = task.id.toLowerCase();
  if (taskId !== requestedTaskId) {
    throw new TaskmarketInspectorError('invalid_response');
  }

  const expiresAt = normalizedTimestamp(task.expiryTime);
  const pendingActions = sanitizePendingActions(task);
  const digestState = {
    domain: 'jarvis.taskmarket.submission-inspection.v1',
    taskId,
    descriptionSha256: sha256(task.description),
    status: task.status,
    submissionWindowOpen: task.submissionWindowOpen,
    expiresAt,
    rewardBaseUnits: task.reward,
    pendingActions
  };

  return {
    schemaVersion: 1,
    taskId,
    taskDigest: sha256(canonicalJson(digestState)),
    status: task.status,
    submissionWindowOpen: task.submissionWindowOpen,
    expiresAt,
    pendingActions
  };
}

async function readBoundedBody(response: Response, maxBodyBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]{0,9})$/.test(contentLength)) {
      throw new TaskmarketInspectorError('invalid_response');
    }
    if (Number(contentLength) > maxBodyBytes) {
      throw new TaskmarketInspectorError('response_too_large');
    }
  }
  if (response.body === null) {
    throw new TaskmarketInspectorError('invalid_response');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBodyBytes) {
        void reader.cancel().catch(() => undefined);
        throw new TaskmarketInspectorError('response_too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof TaskmarketInspectorError) {
      throw error;
    }
    throw new TaskmarketInspectorError('invalid_response');
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new TaskmarketInspectorError('invalid_response');
  }
}

export class TaskmarketInspector {
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;

  public constructor(options: TaskmarketInspectorOptions) {
    if (typeof options.fetch !== 'function') {
      throw new TypeError('Taskmarket inspector requires a fetch dependency');
    }
    this.fetchImplementation = options.fetch;
    this.timeoutMs = integerOption(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      1,
      MAX_TIMEOUT_MS,
      'timeoutMs'
    );
    this.maxBodyBytes = integerOption(
      options.maxBodyBytes,
      DEFAULT_MAX_BODY_BYTES,
      1_024,
      MAX_BODY_BYTES,
      'maxBodyBytes'
    );
  }

  public async inspect(rawTaskId: string): Promise<TaskmarketSubmissionInspection> {
    const parsedTaskId = TaskIdSchema.safeParse(rawTaskId);
    if (!parsedTaskId.success) {
      throw new TaskmarketInspectorError('invalid_task_id');
    }
    const taskId = parsedTaskId.data.toLowerCase();
    return this.inspectWithTimeout(taskId);
  }

  private async inspectWithTimeout(taskId: string): Promise<TaskmarketSubmissionInspection> {
    const controller = new AbortController();
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        reject(new TaskmarketInspectorError('timeout'));
        controller.abort();
      }, this.timeoutMs);
    });

    const operation = Promise.resolve()
      .then(async () => {
        let response: Response;
        try {
          response = await this.fetchImplementation(
            `${TASKMARKET_API_ORIGIN}/api/tasks/${taskId}`,
            {
              method: 'GET',
              credentials: 'omit',
              redirect: 'error',
              referrerPolicy: 'no-referrer',
              cache: 'no-store',
              headers: { accept: 'application/json' },
              signal: controller.signal
            }
          );
        } catch {
          throw new TaskmarketInspectorError(timedOut ? 'timeout' : 'transport_error');
        }

        if (!response.ok) {
          throw new TaskmarketInspectorError('upstream_status');
        }
        if (response.redirected) {
          throw new TaskmarketInspectorError('invalid_response');
        }
        const contentType = response.headers
          .get('content-type')
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase();
        if (contentType !== 'application/json') {
          throw new TaskmarketInspectorError('invalid_response');
        }

        const body = await readBoundedBody(response, this.maxBodyBytes);
        let decoded: unknown;
        try {
          decoded = JSON.parse(body) as unknown;
        } catch {
          throw new TaskmarketInspectorError('invalid_response');
        }
        const parsed = TaskDetailResponseSchema.safeParse(decoded);
        if (!parsed.success) {
          throw new TaskmarketInspectorError('invalid_response');
        }
        return projectInspection(parsed.data, taskId);
      })
      .catch((error: unknown) => {
        if (error instanceof TaskmarketInspectorError) {
          throw error;
        }
        throw new TaskmarketInspectorError(timedOut ? 'timeout' : 'invalid_response');
      });

    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
