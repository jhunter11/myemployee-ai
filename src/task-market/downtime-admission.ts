import { createHash } from 'node:crypto';

import { z } from 'zod';

// @anchor tm.admission.disk-floor - scouting requires at least this percentage of free disk and the threshold is never lowered to make a denied gate pass
const DISK_FREE_MINIMUM_PERCENT = 20;
const MAX_PRIORITY_COUNT = 1_000_000;
const MAX_QUOTA = 1_000_000_000;
const MAX_EVIDENCE_AGE_MS = 5 * 60 * 1_000;
const MAX_QUIET_PERIOD_MS = 24 * 60 * 60 * 1_000;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const TimestampSchema = z.iso.datetime();
const BoundedCountSchema = z.number().finite().int().min(0).max(MAX_PRIORITY_COUNT);
const QuotaCountSchema = z.number().finite().int().min(0).max(MAX_QUOTA);

export const DOWNTIME_ADMISSION_TOKEN_TTL_MS = 15_000;

export const DowntimeAdmissionSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  capturedAt: TimestampSchema,
  maxEvidenceAgeMs: z.number().finite().int().min(1).max(MAX_EVIDENCE_AGE_MS),
  killSwitchEnabled: z.boolean(),
  coreReadiness: z.enum(['green', 'red', 'unknown']),
  diskFreePercent: z.number().finite().min(0).max(100),
  priorityWork: z.strictObject({
    p0Ready: BoundedCountSchema,
    p0Leased: BoundedCountSchema,
    p1Ready: BoundedCountSchema,
    p1Leased: BoundedCountSchema
  }),
  execution: z.strictObject({
    clientActive: z.boolean(),
    taskMarketActive: z.boolean()
  }),
  foreground: z.strictObject({
    lastActivityAt: TimestampSchema.nullable(),
    quietPeriodMs: z.number().finite().int().min(1).max(MAX_QUIET_PERIOD_MS)
  }),
  hostCapability: z.enum(['healthy', 'unhealthy', 'unknown']),
  quotas: z.strictObject({
    requests: z.strictObject({
      used: QuotaCountSchema,
      limit: QuotaCountSchema.min(1)
    }),
    responses: z.strictObject({
      used: QuotaCountSchema,
      limit: QuotaCountSchema.min(1)
    })
  })
});

export type DowntimeAdmissionSnapshot = z.infer<typeof DowntimeAdmissionSnapshotSchema>;

export const DowntimeAdmissionTokenSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.literal('read_only_scouting'),
  evidenceDigest: Sha256Schema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  bindingDigest: Sha256Schema
});

export type DowntimeAdmissionToken = z.infer<typeof DowntimeAdmissionTokenSchema>;

export type DowntimeAdmissionReason =
  | 'SNAPSHOT_INVALID'
  | 'EVIDENCE_FROM_FUTURE'
  | 'EVIDENCE_STALE'
  | 'KILL_SWITCH_DISABLED'
  | 'CORE_READINESS_NOT_GREEN'
  | 'DISK_BELOW_MINIMUM'
  | 'P0_WORK_PENDING'
  | 'P1_WORK_PENDING'
  | 'CLIENT_EXECUTION_ACTIVE'
  | 'TASK_MARKET_EXECUTION_ACTIVE'
  | 'FOREGROUND_ACTIVITY_UNKNOWN'
  | 'FOREGROUND_NOT_QUIET'
  | 'HOST_CAPABILITY_UNHEALTHY'
  | 'REQUEST_QUOTA_EXHAUSTED'
  | 'RESPONSE_QUOTA_EXHAUSTED'
  | 'TOKEN_INVALID'
  | 'TOKEN_SNAPSHOT_MISMATCH'
  | 'TOKEN_EXPIRED';

export interface DowntimeAdmissionDecision {
  admitted: boolean;
  reasons: DowntimeAdmissionReason[];
  evidenceDigest: string;
  evaluatedAt: string;
  token: DowntimeAdmissionToken | null;
}

const INVALID_SNAPSHOT_DIGEST = sha256('jarvis.downtime-admission.invalid-snapshot.v1');

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizedTimestamp(timestamp: string): string {
  return new Date(timestamp).toISOString();
}

function normalizedNow(now: string): string {
  return normalizedTimestamp(TimestampSchema.parse(now));
}

function canonicalSnapshot(snapshot: DowntimeAdmissionSnapshot): string {
  return JSON.stringify({
    schemaVersion: 1,
    capturedAt: normalizedTimestamp(snapshot.capturedAt),
    maxEvidenceAgeMs: snapshot.maxEvidenceAgeMs,
    killSwitchEnabled: snapshot.killSwitchEnabled,
    coreReadiness: snapshot.coreReadiness,
    diskFreePercent: snapshot.diskFreePercent,
    priorityWork: {
      p0Ready: snapshot.priorityWork.p0Ready,
      p0Leased: snapshot.priorityWork.p0Leased,
      p1Ready: snapshot.priorityWork.p1Ready,
      p1Leased: snapshot.priorityWork.p1Leased
    },
    execution: {
      clientActive: snapshot.execution.clientActive,
      taskMarketActive: snapshot.execution.taskMarketActive
    },
    foreground: {
      lastActivityAt:
        snapshot.foreground.lastActivityAt === null
          ? null
          : normalizedTimestamp(snapshot.foreground.lastActivityAt),
      quietPeriodMs: snapshot.foreground.quietPeriodMs
    },
    hostCapability: snapshot.hostCapability,
    quotas: {
      requests: {
        used: snapshot.quotas.requests.used,
        limit: snapshot.quotas.requests.limit
      },
      responses: {
        used: snapshot.quotas.responses.used,
        limit: snapshot.quotas.responses.limit
      }
    }
  });
}

function snapshotDigest(snapshot: DowntimeAdmissionSnapshot): string {
  return sha256(canonicalSnapshot(snapshot));
}

function canonicalTokenBinding(token: Omit<DowntimeAdmissionToken, 'bindingDigest'>): string {
  return JSON.stringify({
    schemaVersion: 1,
    scope: 'read_only_scouting',
    evidenceDigest: token.evidenceDigest,
    issuedAt: normalizedTimestamp(token.issuedAt),
    expiresAt: normalizedTimestamp(token.expiresAt)
  });
}

function createToken(evidenceDigest: string, issuedAt: string): DowntimeAdmissionToken {
  const unsigned = {
    schemaVersion: 1,
    scope: 'read_only_scouting',
    evidenceDigest,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + DOWNTIME_ADMISSION_TOKEN_TTL_MS).toISOString()
  } as const;
  return {
    ...unsigned,
    bindingDigest: sha256(canonicalTokenBinding(unsigned))
  };
}

function snapshotReasons(
  snapshot: DowntimeAdmissionSnapshot,
  evaluatedAt: string
): DowntimeAdmissionReason[] {
  const reasons: DowntimeAdmissionReason[] = [];
  const evaluatedAtMs = Date.parse(evaluatedAt);
  const capturedAtMs = Date.parse(snapshot.capturedAt);
  const evidenceAgeMs = evaluatedAtMs - capturedAtMs;

  if (evidenceAgeMs < 0) reasons.push('EVIDENCE_FROM_FUTURE');
  else if (evidenceAgeMs > snapshot.maxEvidenceAgeMs) reasons.push('EVIDENCE_STALE');
  if (!snapshot.killSwitchEnabled) reasons.push('KILL_SWITCH_DISABLED');
  if (snapshot.coreReadiness !== 'green') reasons.push('CORE_READINESS_NOT_GREEN');
  if (snapshot.diskFreePercent < DISK_FREE_MINIMUM_PERCENT) {
    reasons.push('DISK_BELOW_MINIMUM');
  }
  if (snapshot.priorityWork.p0Ready > 0 || snapshot.priorityWork.p0Leased > 0) {
    reasons.push('P0_WORK_PENDING');
  }
  if (snapshot.priorityWork.p1Ready > 0 || snapshot.priorityWork.p1Leased > 0) {
    reasons.push('P1_WORK_PENDING');
  }
  if (snapshot.execution.clientActive) reasons.push('CLIENT_EXECUTION_ACTIVE');
  if (snapshot.execution.taskMarketActive) reasons.push('TASK_MARKET_EXECUTION_ACTIVE');
  if (snapshot.foreground.lastActivityAt === null) {
    reasons.push('FOREGROUND_ACTIVITY_UNKNOWN');
  } else if (
    evaluatedAtMs - Date.parse(snapshot.foreground.lastActivityAt) <
    snapshot.foreground.quietPeriodMs
  ) {
    reasons.push('FOREGROUND_NOT_QUIET');
  }
  if (snapshot.hostCapability !== 'healthy') reasons.push('HOST_CAPABILITY_UNHEALTHY');
  if (snapshot.quotas.requests.used >= snapshot.quotas.requests.limit) {
    reasons.push('REQUEST_QUOTA_EXHAUSTED');
  }
  if (snapshot.quotas.responses.used >= snapshot.quotas.responses.limit) {
    reasons.push('RESPONSE_QUOTA_EXHAUSTED');
  }

  return reasons;
}

function invalidSnapshotDecision(evaluatedAt: string): DowntimeAdmissionDecision {
  return {
    admitted: false,
    reasons: ['SNAPSHOT_INVALID'],
    evidenceDigest: INVALID_SNAPSHOT_DIGEST,
    evaluatedAt,
    token: null
  };
}

export function evaluateDowntimeAdmission(
  rawSnapshot: unknown,
  now: string
): DowntimeAdmissionDecision {
  const evaluatedAt = normalizedNow(now);
  const parsed = DowntimeAdmissionSnapshotSchema.safeParse(rawSnapshot);
  if (!parsed.success) return invalidSnapshotDecision(evaluatedAt);

  const evidenceDigest = snapshotDigest(parsed.data);
  const reasons = snapshotReasons(parsed.data, evaluatedAt);
  const admitted = reasons.length === 0;
  return {
    admitted,
    reasons,
    evidenceDigest,
    evaluatedAt,
    token: admitted ? createToken(evidenceDigest, evaluatedAt) : null
  };
}

function tokenIsInternallyValid(token: DowntimeAdmissionToken): boolean {
  const issuedAtMs = Date.parse(token.issuedAt);
  const expiresAtMs = Date.parse(token.expiresAt);
  const expectedBinding = sha256(
    canonicalTokenBinding({
      schemaVersion: 1,
      scope: 'read_only_scouting',
      evidenceDigest: token.evidenceDigest,
      issuedAt: token.issuedAt,
      expiresAt: token.expiresAt
    })
  );
  return (
    expiresAtMs - issuedAtMs === DOWNTIME_ADMISSION_TOKEN_TTL_MS &&
    token.bindingDigest === expectedBinding
  );
}

export function revalidateDowntimeAdmissionToken(
  rawToken: unknown,
  rawSnapshot: unknown,
  now: string
): DowntimeAdmissionDecision {
  const evaluatedAt = normalizedNow(now);
  const parsedSnapshot = DowntimeAdmissionSnapshotSchema.safeParse(rawSnapshot);
  if (!parsedSnapshot.success) return invalidSnapshotDecision(evaluatedAt);

  const evidenceDigest = snapshotDigest(parsedSnapshot.data);
  const liveReasons = snapshotReasons(parsedSnapshot.data, evaluatedAt);
  const parsedToken = DowntimeAdmissionTokenSchema.safeParse(rawToken);
  if (!parsedToken.success || !tokenIsInternallyValid(parsedToken.data)) {
    return {
      admitted: false,
      reasons: [...liveReasons, 'TOKEN_INVALID'],
      evidenceDigest,
      evaluatedAt,
      token: null
    };
  }

  const tokenReasons: DowntimeAdmissionReason[] = [];
  if (parsedToken.data.evidenceDigest !== evidenceDigest) {
    tokenReasons.push('TOKEN_SNAPSHOT_MISMATCH');
  }
  const evaluatedAtMs = Date.parse(evaluatedAt);
  if (evaluatedAtMs < Date.parse(parsedToken.data.issuedAt)) {
    tokenReasons.push('TOKEN_INVALID');
  } else if (evaluatedAtMs >= Date.parse(parsedToken.data.expiresAt)) {
    tokenReasons.push('TOKEN_EXPIRED');
  }

  const reasons = [...liveReasons, ...tokenReasons];
  const admitted = reasons.length === 0;
  return {
    admitted,
    reasons,
    evidenceDigest,
    evaluatedAt,
    token: admitted ? parsedToken.data : null
  };
}
