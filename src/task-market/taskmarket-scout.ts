import { createHash } from 'node:crypto';

import { z } from 'zod';

export const TASKMARKET_API_ORIGIN = 'https://api.taskmarket.dev' as const;

const DEFAULT_LIMIT = 20;
const MAX_TASKS = 100;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 256 * 1_024;
const DEFAULT_MINIMUM_LEAD_TIME_MS = 6 * 60 * 60 * 1_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1_048_576;
const MAX_LEAD_TIME_MS = 30 * 24 * 60 * 60 * 1_000;

const HexAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const HashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const PublicKeySchema = z.string().regex(/^(?:02|03)[a-fA-F0-9]{64}$/);
const AmountSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,14})$/);
const TimestampSchema = z.iso.datetime({ offset: true });
const BoundedExternalTextSchema = z.string().max(50_000);
const BoundedLabelSchema = z.string().min(1).max(256);
const CountSchema = z.number().int().min(0).max(1_000_000);
const BasisPointsSchema = z.number().int().min(0).max(10_000);

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
const TaskModeSchema = z.enum(['bounty', 'claim', 'pitch', 'benchmark', 'auction']);
const ActorTypeSchema = z.enum(['agent', 'human']);
const AuctionTypeSchema = z.enum(['dutch', 'english', 'reverse_dutch', 'reverse_english']);
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

const PrimaryAwardSchema = z.strictObject({
  workerAddress: HexAddressSchema,
  rating: z.number().min(0).max(100).nullable()
});

const PendingActionSchema = z.strictObject({
  role: PendingActionRoleSchema,
  action: PendingActionNameSchema,
  command: z.string().max(4_000),
  eligibleAddress: HexAddressSchema.nullable().optional(),
  requiresPayment: z.boolean().optional(),
  paymentAmount: AmountSchema.nullable().optional(),
  availableAfter: TimestampSchema.nullable().optional(),
  availableUntil: TimestampSchema.nullable().optional(),
  targetWorker: HexAddressSchema.nullable().optional()
});

const TaskDropSchema = z.strictObject({
  id: BoundedLabelSchema,
  name: BoundedLabelSchema
});

const TaskmarketTaskSchema = z.strictObject({
  id: HashSchema,
  requester: HexAddressSchema,
  requesterPubkey: PublicKeySchema.nullable(),
  description: BoundedExternalTextSchema,
  reward: AmountSchema,
  escrowTxHash: HashSchema,
  createdAt: TimestampSchema,
  expiryTime: TimestampSchema,
  status: TaskStatusSchema,
  tags: z.array(z.string().min(1).max(256)).max(32),
  mode: TaskModeSchema,
  stakeRequired: z.boolean(),
  stakeBps: BasisPointsSchema,
  pitchDeadline: TimestampSchema.nullable(),
  bidDeadline: TimestampSchema.nullable(),
  maxPrice: AmountSchema.nullable(),
  metricDescription: BoundedExternalTextSchema.nullable(),
  metricTarget: z.string().max(4_000).nullable(),
  claimedBy: HexAddressSchema.nullable(),
  claimedAt: TimestampSchema.nullable(),
  platformFeeBps: BasisPointsSchema,
  submissionCount: CountSchema,
  awardCount: CountSchema.optional(),
  primaryAward: PrimaryAwardSchema.nullable().optional(),
  pitchCount: CountSchema,
  requesterAgentId: BoundedLabelSchema.nullable().optional(),
  requesterActorType: ActorTypeSchema.optional(),
  workerAgentId: BoundedLabelSchema.nullable().optional(),
  workerActorType: ActorTypeSchema.optional(),
  auctionType: AuctionTypeSchema.nullable().optional(),
  auctionStartPrice: AmountSchema.nullable().optional(),
  auctionFloorPrice: AmountSchema.nullable().optional(),
  currentAuctionPrice: AmountSchema.nullable().optional(),
  auctionBidCount: CountSchema.nullable().optional(),
  auctionPriceReachesFloorAt: TimestampSchema.nullable().optional(),
  auctionPriceReachesMaxAt: TimestampSchema.nullable().optional(),
  currentLowestBid: AmountSchema.nullable().optional(),
  hookContract: HexAddressSchema.nullable().optional(),
  evaluator: HexAddressSchema.nullable().optional(),
  evaluatorStake: AmountSchema.nullable().optional(),
  evaluatorFeeBps: BasisPointsSchema.nullable().optional(),
  evaluationWindow: CountSchema.nullable().optional(),
  appealWindow: CountSchema.nullable().optional(),
  disputeResolver: HexAddressSchema.nullable().optional(),
  appealDeadline: TimestampSchema.nullable().optional(),
  evaluatorDeadline: TimestampSchema.nullable().optional(),
  verdictType: z.enum(['APPROVE', 'REJECT', 'PARTIAL']).nullable().optional(),
  verdictScore: z.number().finite().nullable().optional(),
  verdictConfidence: z.number().finite().nullable().optional(),
  verdictEvidenceHash: HashSchema.nullable().optional(),
  submissionWindowOpen: z.boolean(),
  netReward: AmountSchema.nullable().optional(),
  pendingActions: z.array(PendingActionSchema).max(50).optional(),
  selfAward: z.boolean().nullable().optional(),
  taskDropId: BoundedLabelSchema.nullable().optional(),
  taskDrop: TaskDropSchema.nullable().optional(),
  hooks: z.array(z.string().max(256)).max(32).optional()
});

const TaskmarketEnvelopeSchema = z.strictObject({
  tasks: z.array(TaskmarketTaskSchema).max(MAX_TASKS),
  nextCursor: z.string().max(1_024).nullable(),
  hasMore: z.boolean()
});

const ScanInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(MAX_TASKS).default(DEFAULT_LIMIT)
});

type TaskmarketTask = z.infer<typeof TaskmarketTaskSchema>;

export type TaskmarketScoutErrorCode =
  | 'timeout'
  | 'transport_error'
  | 'upstream_status'
  | 'response_too_large'
  | 'invalid_response'
  | 'task_limit_exceeded';

export class TaskmarketScoutError extends Error {
  public readonly code: TaskmarketScoutErrorCode;

  public constructor(code: TaskmarketScoutErrorCode) {
    super('Taskmarket response rejected');
    this.name = 'TaskmarketScoutError';
    this.code = code;
  }
}

export interface TaskmarketScoutOptions {
  fetch: typeof globalThis.fetch;
  clock: () => Date;
  timeoutMs?: number;
  maxBodyBytes?: number;
  minimumLeadTimeMs?: number;
}

export interface TaskmarketRewardSummary {
  asset: 'USDC';
  decimals: 6;
  grossBaseUnits: number;
  netBaseUnits: number;
}

export interface TaskmarketDeadlineSummary {
  expiresAt: string;
  remainingSeconds: number;
}

export interface TaskmarketCandidate {
  taskId: string;
  taskDigest: string;
  mode: 'bounty';
  requesterActorType: 'agent' | 'human' | 'unknown';
  reward: TaskmarketRewardSummary;
  deadline: TaskmarketDeadlineSummary;
  submissionCount: number;
  awardCount: number;
  marketStakeBaseUnits: 0;
  marketAccessRisk: 'zero_stake';
  executionReview: 'required';
  rank: number;
}

export type TaskmarketRejectionReason =
  | 'not_open'
  | 'submission_window_closed'
  | 'expired'
  | 'deadline_too_close'
  | 'unknown_reward'
  | 'reward_not_positive'
  | 'unknown_cost'
  | 'nonzero_market_stake'
  | 'unsupported_mode';

export interface TaskmarketRejection {
  taskId: string;
  taskDigest: string;
  reason: TaskmarketRejectionReason;
}

export interface TaskmarketScoutResult {
  schemaVersion: 1;
  source: 'taskmarket';
  observedAt: string;
  scannedTaskCount: number;
  candidates: TaskmarketCandidate[];
  rejections: TaskmarketRejection[];
}

interface UnrankedCandidate extends Omit<TaskmarketCandidate, 'rank'> {
  rank?: never;
}

interface TaskDecision {
  candidate?: UnrankedCandidate;
  rejection?: TaskmarketRejection;
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

function taskDigest(task: TaskmarketTask): string {
  return createHash('sha256').update(canonicalJson(task), 'utf8').digest('hex');
}

function safeAmount(amount: string): number {
  const parsed = Number(amount);
  if (!Number.isSafeInteger(parsed)) {
    throw new TaskmarketScoutError('invalid_response');
  }
  return parsed;
}

function compareCandidates(left: UnrankedCandidate, right: UnrankedCandidate): number {
  if (left.reward.netBaseUnits !== right.reward.netBaseUnits) {
    return left.reward.netBaseUnits > right.reward.netBaseUnits ? -1 : 1;
  }
  if (left.reward.grossBaseUnits !== right.reward.grossBaseUnits) {
    return left.reward.grossBaseUnits > right.reward.grossBaseUnits ? -1 : 1;
  }
  if (left.submissionCount !== right.submissionCount) {
    return left.submissionCount - right.submissionCount;
  }
  const deadlineOrder = left.deadline.expiresAt.localeCompare(right.deadline.expiresAt);
  if (deadlineOrder !== 0) {
    return deadlineOrder;
  }
  return left.taskId.localeCompare(right.taskId);
}

async function readBoundedBody(response: Response, maxBodyBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]{0,9})$/.test(contentLength)) {
      throw new TaskmarketScoutError('invalid_response');
    }
    if (Number(contentLength) > maxBodyBytes) {
      throw new TaskmarketScoutError('response_too_large');
    }
  }

  if (response.body === null) {
    throw new TaskmarketScoutError('invalid_response');
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
        throw new TaskmarketScoutError('response_too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof TaskmarketScoutError) {
      throw error;
    }
    throw new TaskmarketScoutError('invalid_response');
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
    throw new TaskmarketScoutError('invalid_response');
  }
}

export class TaskmarketScout {
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly clock: () => Date;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly minimumLeadTimeMs: number;

  public constructor(options: TaskmarketScoutOptions) {
    if (typeof options.fetch !== 'function' || typeof options.clock !== 'function') {
      throw new TypeError('Taskmarket scout requires fetch and clock dependencies');
    }
    this.fetchImplementation = options.fetch;
    this.clock = options.clock;
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
    this.minimumLeadTimeMs = integerOption(
      options.minimumLeadTimeMs,
      DEFAULT_MINIMUM_LEAD_TIME_MS,
      0,
      MAX_LEAD_TIME_MS,
      'minimumLeadTimeMs'
    );
  }

  public async scan(input: { limit?: number } = {}): Promise<TaskmarketScoutResult> {
    const { limit } = ScanInputSchema.parse(input);
    const observedAt = this.clock();
    if (Number.isNaN(observedAt.getTime())) {
      throw new TypeError('Taskmarket scout clock returned an invalid date');
    }

    const body = await this.fetchTasks(limit);
    let decoded: unknown;
    try {
      decoded = JSON.parse(body) as unknown;
    } catch {
      throw new TaskmarketScoutError('invalid_response');
    }
    const parsed = TaskmarketEnvelopeSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new TaskmarketScoutError('invalid_response');
    }
    if (parsed.data.tasks.length > limit) {
      throw new TaskmarketScoutError('task_limit_exceeded');
    }

    const decisions = parsed.data.tasks.map((task) => this.decide(task, observedAt));
    const unranked = decisions
      .flatMap((decision) => (decision.candidate === undefined ? [] : [decision.candidate]))
      .sort(compareCandidates);
    const candidates = unranked.map((candidate, index): TaskmarketCandidate => {
      return { ...candidate, rank: index + 1 };
    });
    const rejections = decisions
      .flatMap((decision) => (decision.rejection === undefined ? [] : [decision.rejection]))
      .sort((left, right) => left.taskId.localeCompare(right.taskId));

    return {
      schemaVersion: 1,
      source: 'taskmarket',
      observedAt: observedAt.toISOString(),
      scannedTaskCount: parsed.data.tasks.length,
      candidates,
      rejections
    };
  }

  private async fetchTasks(limit: number): Promise<string> {
    const controller = new AbortController();
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new TaskmarketScoutError('timeout'));
      }, this.timeoutMs);
    });
    const request = Promise.resolve().then(async () => {
      try {
        const response = await this.fetchImplementation(
          `${TASKMARKET_API_ORIGIN}/api/tasks?status=open&limit=${String(limit)}`,
          {
            method: 'GET',
            redirect: 'error',
            credentials: 'omit',
            headers: { accept: 'application/json' },
            signal: controller.signal
          }
        );
        if (!response.ok) {
          throw new TaskmarketScoutError('upstream_status');
        }
        if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
          throw new TaskmarketScoutError('invalid_response');
        }
        return await readBoundedBody(response, this.maxBodyBytes);
      } catch (error) {
        if (error instanceof TaskmarketScoutError) throw error;
        throw new TaskmarketScoutError(timedOut ? 'timeout' : 'transport_error');
      }
    });

    try {
      return await Promise.race([request, timeout]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private decide(task: TaskmarketTask, observedAt: Date): TaskDecision {
    const digest = taskDigest(task);
    const reject = (reason: TaskmarketRejectionReason): TaskDecision => ({
      rejection: { taskId: task.id, taskDigest: digest, reason }
    });
    if (task.status !== 'open') {
      return reject('not_open');
    }
    if (!task.submissionWindowOpen) {
      return reject('submission_window_closed');
    }

    const expiryTime = new Date(task.expiryTime).getTime();
    const remainingMs = expiryTime - observedAt.getTime();
    if (remainingMs <= 0) {
      return reject('expired');
    }
    if (remainingMs < this.minimumLeadTimeMs) {
      return reject('deadline_too_close');
    }
    if (task.netReward === null || task.netReward === undefined) {
      return reject('unknown_reward');
    }
    const grossReward = safeAmount(task.reward);
    const netReward = safeAmount(task.netReward);
    if (grossReward <= 0 || netReward <= 0 || netReward > grossReward) {
      return reject('reward_not_positive');
    }
    if (task.stakeRequired && task.stakeBps === 0) {
      return reject('unknown_cost');
    }
    if (!task.stakeRequired && task.stakeBps !== 0) {
      return reject('unknown_cost');
    }
    if (task.stakeRequired) {
      return reject('nonzero_market_stake');
    }
    if (task.mode !== 'bounty') {
      return reject('unsupported_mode');
    }

    return {
      candidate: {
        taskId: task.id,
        taskDigest: digest,
        mode: task.mode,
        requesterActorType: task.requesterActorType ?? 'unknown',
        reward: {
          asset: 'USDC',
          decimals: 6,
          grossBaseUnits: grossReward,
          netBaseUnits: netReward
        },
        deadline: {
          expiresAt: new Date(expiryTime).toISOString(),
          remainingSeconds: Math.floor(remainingMs / 1_000)
        },
        submissionCount: task.submissionCount,
        awardCount: task.awardCount ?? 0,
        marketStakeBaseUnits: 0,
        marketAccessRisk: 'zero_stake',
        executionReview: 'required'
      }
    };
  }
}
