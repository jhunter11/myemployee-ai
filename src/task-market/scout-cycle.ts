import { z } from 'zod';

import { evaluateDowntimeAdmission } from './downtime-admission';
import type { DowntimeAdmissionReason, DowntimeAdmissionSnapshot } from './downtime-admission';
import { TaskmarketScoutError } from './taskmarket-scout';
import type { TaskmarketScout, TaskmarketScoutErrorCode } from './taskmarket-scout';

const DEFAULT_CANDIDATE_LIMIT = 20;
const MAX_CANDIDATE_LIMIT = 100;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const TaskIdSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const CountSchema = z.number().int().min(0).max(1_000_000);
const RewardBaseUnitsSchema = z.number().int().min(0).max(999_999_999_999_999);

const CycleCandidateSchema = z.strictObject({
  taskId: TaskIdSchema,
  taskDigest: Sha256Schema,
  mode: z.literal('bounty'),
  requesterActorType: z.enum(['agent', 'human', 'unknown']),
  reward: z.strictObject({
    asset: z.literal('USDC'),
    decimals: z.literal(6),
    grossBaseUnits: RewardBaseUnitsSchema,
    netBaseUnits: RewardBaseUnitsSchema
  }),
  deadline: z.strictObject({
    expiresAt: z.iso.datetime({ offset: true }),
    remainingSeconds: z.number().int().min(0).max(1_000_000_000)
  }),
  submissionCount: CountSchema,
  awardCount: CountSchema,
  marketStakeBaseUnits: z.literal(0),
  marketAccessRisk: z.literal('zero_stake'),
  executionReview: z.literal('required'),
  rank: z.number().int().min(1).max(MAX_CANDIDATE_LIMIT)
});

export type ScoutCycleCandidate = z.infer<typeof CycleCandidateSchema>;

export interface ScoutSignalProvider {
  capture(): Promise<DowntimeAdmissionSnapshot>;
}

export interface ReadonlyTaskmarketScout {
  scan(input: { limit: number }): ReturnType<TaskmarketScout['scan']>;
}

export type ScoutCycleOperationalErrorCode =
  | 'CLOCK_INVALID'
  | 'SIGNALS_UNAVAILABLE'
  | 'SCOUT_TIMEOUT'
  | 'SCOUT_TRANSPORT_ERROR'
  | 'SCOUT_UPSTREAM_STATUS'
  | 'SCOUT_RESPONSE_TOO_LARGE'
  | 'SCOUT_INVALID_RESPONSE'
  | 'SCOUT_TASK_LIMIT_EXCEEDED'
  | 'SCOUT_INVALID_RESULT'
  | 'SCOUT_INTERNAL_ERROR';

export interface ScoutCycleDeniedResult {
  schemaVersion: 1;
  status: 'denied';
  stage: 'initial_admission' | 'immediate_admission';
  checkedAt: string;
  reasons: DowntimeAdmissionReason[];
  evidenceDigest: string;
}

export interface ScoutCycleSuccessResult {
  schemaVersion: 1;
  status: 'scouted';
  checkedAt: string;
  admissionEvidenceDigests: [string, string];
  scan: {
    observedAt: string;
    scannedTaskCount: number;
    candidateCount: number;
    rejectedTaskCount: number;
    candidates: ScoutCycleCandidate[];
  };
}

export interface ScoutCycleOperationalErrorResult {
  schemaVersion: 1;
  status: 'operational_error';
  checkedAt: string | null;
  errorCode: ScoutCycleOperationalErrorCode;
}

export type ScoutCycleResult =
  ScoutCycleDeniedResult | ScoutCycleSuccessResult | ScoutCycleOperationalErrorResult;

export interface ScoutCycleOptions {
  signals: ScoutSignalProvider;
  scout: ReadonlyTaskmarketScout;
  clock: () => Date;
  candidateLimit?: number;
}

const scoutErrorCodeMap: Record<TaskmarketScoutErrorCode, ScoutCycleOperationalErrorCode> = {
  timeout: 'SCOUT_TIMEOUT',
  transport_error: 'SCOUT_TRANSPORT_ERROR',
  upstream_status: 'SCOUT_UPSTREAM_STATUS',
  response_too_large: 'SCOUT_RESPONSE_TOO_LARGE',
  invalid_response: 'SCOUT_INVALID_RESPONSE',
  task_limit_exceeded: 'SCOUT_TASK_LIMIT_EXCEEDED'
};

function projectCandidate(raw: unknown): ScoutCycleCandidate {
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError('Scout candidate is not an object');
  }
  const candidate = raw as Record<string, unknown>;
  return CycleCandidateSchema.parse({
    taskId: candidate.taskId,
    taskDigest: candidate.taskDigest,
    mode: candidate.mode,
    requesterActorType: candidate.requesterActorType,
    reward: candidate.reward,
    deadline: candidate.deadline,
    submissionCount: candidate.submissionCount,
    awardCount: candidate.awardCount,
    marketStakeBaseUnits: candidate.marketStakeBaseUnits,
    marketAccessRisk: candidate.marketAccessRisk,
    executionReview: candidate.executionReview,
    rank: candidate.rank
  });
}

function mapScoutFailure(error: unknown): ScoutCycleOperationalErrorCode {
  if (error instanceof TaskmarketScoutError) {
    return scoutErrorCodeMap[error.code];
  }
  return 'SCOUT_INTERNAL_ERROR';
}

function validClockValue(clock: () => Date): string | null {
  try {
    const value = clock();
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  } catch {
    return null;
  }
}

function operationalError(
  errorCode: ScoutCycleOperationalErrorCode,
  checkedAt: string | null
): ScoutCycleOperationalErrorResult {
  return {
    schemaVersion: 1,
    status: 'operational_error',
    checkedAt,
    errorCode
  };
}

export class ScoutCycle {
  private readonly candidateLimit: number;

  public constructor(private readonly options: ScoutCycleOptions) {
    const candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
    if (
      !Number.isInteger(candidateLimit) ||
      candidateLimit < 1 ||
      candidateLimit > MAX_CANDIDATE_LIMIT
    ) {
      throw new RangeError('candidateLimit must be an integer from 1 through 100');
    }
    this.candidateLimit = candidateLimit;
  }

  public async run(): Promise<ScoutCycleResult> {
    let initialSnapshot: DowntimeAdmissionSnapshot;
    try {
      initialSnapshot = await this.options.signals.capture();
    } catch {
      return operationalError('SIGNALS_UNAVAILABLE', validClockValue(this.options.clock));
    }
    const initialCheckedAt = validClockValue(this.options.clock);
    if (initialCheckedAt === null) {
      return operationalError('CLOCK_INVALID', null);
    }
    const initialAdmission = evaluateDowntimeAdmission(initialSnapshot, initialCheckedAt);
    if (!initialAdmission.admitted) {
      return {
        schemaVersion: 1,
        status: 'denied',
        stage: 'initial_admission',
        checkedAt: initialAdmission.evaluatedAt,
        reasons: initialAdmission.reasons,
        evidenceDigest: initialAdmission.evidenceDigest
      };
    }

    let immediateSnapshot: DowntimeAdmissionSnapshot;
    try {
      immediateSnapshot = await this.options.signals.capture();
    } catch {
      return operationalError('SIGNALS_UNAVAILABLE', validClockValue(this.options.clock));
    }
    const immediateCheckedAt = validClockValue(this.options.clock);
    if (immediateCheckedAt === null) {
      return operationalError('CLOCK_INVALID', null);
    }
    const immediateAdmission = evaluateDowntimeAdmission(immediateSnapshot, immediateCheckedAt);
    if (!immediateAdmission.admitted) {
      return {
        schemaVersion: 1,
        status: 'denied',
        stage: 'immediate_admission',
        checkedAt: immediateAdmission.evaluatedAt,
        reasons: immediateAdmission.reasons,
        evidenceDigest: immediateAdmission.evidenceDigest
      };
    }

    let rawScan: Awaited<ReturnType<ReadonlyTaskmarketScout['scan']>>;
    try {
      rawScan = await this.options.scout.scan({ limit: this.candidateLimit });
    } catch (error) {
      return operationalError(mapScoutFailure(error), immediateAdmission.evaluatedAt);
    }

    try {
      if (
        rawScan.schemaVersion !== 1 ||
        rawScan.source !== 'taskmarket' ||
        !z.iso.datetime({ offset: true }).safeParse(rawScan.observedAt).success ||
        !Number.isInteger(rawScan.scannedTaskCount) ||
        rawScan.scannedTaskCount < 0 ||
        rawScan.scannedTaskCount > MAX_CANDIDATE_LIMIT ||
        !Array.isArray(rawScan.candidates) ||
        !Array.isArray(rawScan.rejections) ||
        rawScan.candidates.length > this.candidateLimit ||
        rawScan.candidates.length + rawScan.rejections.length !== rawScan.scannedTaskCount
      ) {
        throw new TypeError('Scout result is invalid');
      }
      const candidates = rawScan.candidates.map((candidate) => projectCandidate(candidate));
      if (candidates.some((candidate, index) => candidate.rank !== index + 1)) {
        throw new TypeError('Scout ranks are invalid');
      }
      return {
        schemaVersion: 1,
        status: 'scouted',
        checkedAt: immediateAdmission.evaluatedAt,
        admissionEvidenceDigests: [
          initialAdmission.evidenceDigest,
          immediateAdmission.evidenceDigest
        ],
        scan: {
          observedAt: rawScan.observedAt,
          scannedTaskCount: rawScan.scannedTaskCount,
          candidateCount: candidates.length,
          rejectedTaskCount: rawScan.rejections.length,
          candidates
        }
      };
    } catch {
      return operationalError('SCOUT_INVALID_RESULT', immediateAdmission.evaluatedAt);
    }
  }
}
