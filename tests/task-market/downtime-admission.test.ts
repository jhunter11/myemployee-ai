import { describe, expect, it } from 'vitest';

import {
  DOWNTIME_ADMISSION_TOKEN_TTL_MS,
  evaluateDowntimeAdmission,
  revalidateDowntimeAdmissionToken
} from '../../src/task-market/downtime-admission';
import type {
  DowntimeAdmissionReason,
  DowntimeAdmissionSnapshot
} from '../../src/task-market/downtime-admission';

const now = '2026-07-20T15:00:00.000Z';
const nowMs = Date.parse(now);

function at(offsetMs: number): string {
  return new Date(nowMs + offsetMs).toISOString();
}

function snapshot(): DowntimeAdmissionSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: at(-10_000),
    maxEvidenceAgeMs: 60_000,
    killSwitchEnabled: true,
    coreReadiness: 'green',
    diskFreePercent: 20,
    priorityWork: {
      p0Ready: 0,
      p0Leased: 0,
      p1Ready: 0,
      p1Leased: 0
    },
    execution: {
      clientActive: false,
      taskMarketActive: false
    },
    foreground: {
      lastActivityAt: at(-600_000),
      quietPeriodMs: 300_000
    },
    hostCapability: 'healthy',
    quotas: {
      requests: { used: 9, limit: 10 },
      responses: { used: 9, limit: 10 }
    }
  };
}

type Snapshot = DowntimeAdmissionSnapshot;

function changed(change: (copy: Snapshot) => void): Snapshot {
  const copy = structuredClone(snapshot());
  change(copy);
  return copy;
}

const denialCases: ReadonlyArray<
  readonly [string, (value: Snapshot) => void, readonly DowntimeAdmissionReason[]]
> = [
  [
    'kill switch disabled',
    (value) => void (value.killSwitchEnabled = false),
    ['KILL_SWITCH_DISABLED']
  ],
  [
    'core readiness red',
    (value) => void (value.coreReadiness = 'red'),
    ['CORE_READINESS_NOT_GREEN']
  ],
  [
    'core readiness unknown',
    (value) => void (value.coreReadiness = 'unknown'),
    ['CORE_READINESS_NOT_GREEN']
  ],
  [
    'disk below threshold',
    (value) => void (value.diskFreePercent = 19.999),
    ['DISK_BELOW_MINIMUM']
  ],
  ['P0 ready work', (value) => void (value.priorityWork.p0Ready = 1), ['P0_WORK_PENDING']],
  ['P0 leased work', (value) => void (value.priorityWork.p0Leased = 1), ['P0_WORK_PENDING']],
  ['P1 ready work', (value) => void (value.priorityWork.p1Ready = 1), ['P1_WORK_PENDING']],
  ['P1 leased work', (value) => void (value.priorityWork.p1Leased = 1), ['P1_WORK_PENDING']],
  [
    'client execution',
    (value) => void (value.execution.clientActive = true),
    ['CLIENT_EXECUTION_ACTIVE']
  ],
  [
    'task-market execution',
    (value) => void (value.execution.taskMarketActive = true),
    ['TASK_MARKET_EXECUTION_ACTIVE']
  ],
  [
    'recent foreground activity',
    (value) => void (value.foreground.lastActivityAt = at(-299_999)),
    ['FOREGROUND_NOT_QUIET']
  ],
  [
    'unknown foreground activity',
    (value) => void (value.foreground.lastActivityAt = null),
    ['FOREGROUND_ACTIVITY_UNKNOWN']
  ],
  [
    'unhealthy host capability',
    (value) => void (value.hostCapability = 'unhealthy'),
    ['HOST_CAPABILITY_UNHEALTHY']
  ],
  [
    'unknown host capability',
    (value) => void (value.hostCapability = 'unknown'),
    ['HOST_CAPABILITY_UNHEALTHY']
  ],
  [
    'request quota exhausted',
    (value) => void (value.quotas.requests.used = value.quotas.requests.limit),
    ['REQUEST_QUOTA_EXHAUSTED']
  ],
  [
    'response quota exhausted',
    (value) => void (value.quotas.responses.used = value.quotas.responses.limit),
    ['RESPONSE_QUOTA_EXHAUSTED']
  ]
];

describe('evaluateDowntimeAdmission', () => {
  it('admits only the fixed read-only scouting scope and emits bounded evidence', () => {
    const decision = evaluateDowntimeAdmission(snapshot(), now);
    if (decision.token === null) throw new Error('Expected an admission token');

    expect(decision).toEqual({
      admitted: true,
      reasons: [],
      evidenceDigest: decision.evidenceDigest,
      evaluatedAt: now,
      token: {
        schemaVersion: 1,
        scope: 'read_only_scouting',
        evidenceDigest: decision.evidenceDigest,
        issuedAt: now,
        expiresAt: at(DOWNTIME_ADMISSION_TOKEN_TTL_MS),
        bindingDigest: decision.token.bindingDigest
      }
    });
    expect(decision.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(decision.token.bindingDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(decision)).toEqual([
      'admitted',
      'reasons',
      'evidenceDigest',
      'evaluatedAt',
      'token'
    ]);
    expect(JSON.stringify(decision)).not.toMatch(/priorityWork|foreground|quota|diskFree/i);
  });

  it.each(denialCases)('denies %s', (_description, mutate, expectedReasons) => {
    const decision = evaluateDowntimeAdmission(changed(mutate), now);

    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toEqual(expectedReasons);
    expect(decision.token).toBeNull();
  });

  it('returns every simultaneous denial in stable policy order', () => {
    const denied = changed((value) => {
      value.killSwitchEnabled = false;
      value.coreReadiness = 'red';
      value.diskFreePercent = 15;
      value.priorityWork.p0Ready = 1;
      value.priorityWork.p1Leased = 1;
      value.execution.clientActive = true;
      value.execution.taskMarketActive = true;
      value.foreground.lastActivityAt = at(-1);
      value.hostCapability = 'unhealthy';
      value.quotas.requests.used = value.quotas.requests.limit;
      value.quotas.responses.used = value.quotas.responses.limit;
    });

    expect(evaluateDowntimeAdmission(denied, now).reasons).toEqual([
      'KILL_SWITCH_DISABLED',
      'CORE_READINESS_NOT_GREEN',
      'DISK_BELOW_MINIMUM',
      'P0_WORK_PENDING',
      'P1_WORK_PENDING',
      'CLIENT_EXECUTION_ACTIVE',
      'TASK_MARKET_EXECUTION_ACTIVE',
      'FOREGROUND_NOT_QUIET',
      'HOST_CAPABILITY_UNHEALTHY',
      'REQUEST_QUOTA_EXHAUSTED',
      'RESPONSE_QUOTA_EXHAUSTED'
    ]);
  });

  it('enforces evidence freshness with inclusive boundary and rejects future evidence', () => {
    expect(
      evaluateDowntimeAdmission(
        changed((value) => (value.capturedAt = at(-value.maxEvidenceAgeMs))),
        now
      ).admitted
    ).toBe(true);
    expect(
      evaluateDowntimeAdmission(
        changed((value) => (value.capturedAt = at(-value.maxEvidenceAgeMs - 1))),
        now
      ).reasons
    ).toEqual(['EVIDENCE_STALE']);
    expect(
      evaluateDowntimeAdmission(
        changed((value) => (value.capturedAt = at(1))),
        now
      ).reasons
    ).toEqual(['EVIDENCE_FROM_FUTURE']);
  });

  it('admits the disk, quiet-period, and remaining-quota boundaries', () => {
    const boundary = changed((value) => {
      value.diskFreePercent = 20;
      value.foreground.lastActivityAt = at(-value.foreground.quietPeriodMs);
      value.quotas.requests.used = value.quotas.requests.limit - 1;
      value.quotas.responses.used = value.quotas.responses.limit - 1;
    });

    expect(evaluateDowntimeAdmission(boundary, now).admitted).toBe(true);
    expect(
      evaluateDowntimeAdmission(
        changed((value) => (value.diskFreePercent = 15)),
        now
      ).reasons
    ).toEqual(['DISK_BELOW_MINIMUM']);
  });

  it('fails closed on malformed, missing, unknown, or non-finite evidence without leaking it', () => {
    const malformed: unknown[] = [
      { ...snapshot(), schemaVersion: 2 },
      { ...snapshot(), capturedAt: undefined },
      { ...snapshot(), secretNote: 'sensitive-value' },
      changed((value) => (value.diskFreePercent = Number.NaN)),
      changed((value) => (value.diskFreePercent = Number.POSITIVE_INFINITY)),
      changed((value) => (value.foreground.quietPeriodMs = -1)),
      changed((value) => (value.quotas.requests.used = -1)),
      changed((value) => (value.quotas.responses.limit = 0))
    ];

    for (const invalid of malformed) {
      const decision = evaluateDowntimeAdmission(invalid, now);
      expect(decision).toMatchObject({
        admitted: false,
        reasons: ['SNAPSHOT_INVALID'],
        evaluatedAt: now,
        token: null
      });
      expect(decision.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(decision)).not.toContain('sensitive-value');
    }
  });

  it('is deterministic and canonicalizes strict object key order', () => {
    const first = evaluateDowntimeAdmission(snapshot(), now);
    const source = snapshot();
    const reordered = {
      quotas: source.quotas,
      hostCapability: source.hostCapability,
      foreground: source.foreground,
      execution: source.execution,
      priorityWork: source.priorityWork,
      diskFreePercent: source.diskFreePercent,
      coreReadiness: source.coreReadiness,
      killSwitchEnabled: source.killSwitchEnabled,
      maxEvidenceAgeMs: source.maxEvidenceAgeMs,
      capturedAt: source.capturedAt,
      schemaVersion: source.schemaVersion
    };

    expect(evaluateDowntimeAdmission(snapshot(), now)).toEqual(first);
    expect(evaluateDowntimeAdmission(reordered, now)).toEqual(first);
  });
});

describe('revalidateDowntimeAdmissionToken', () => {
  it('immediately revalidates an unexpired token against its exact canonical snapshot', () => {
    const source = snapshot();
    const issued = evaluateDowntimeAdmission(source, now);
    if (issued.token === null) throw new Error('Expected an admission token');

    const revalidated = revalidateDowntimeAdmissionToken(issued.token, source, at(1_000));

    expect(revalidated).toEqual({
      ...issued,
      evaluatedAt: at(1_000)
    });
  });

  it('rejects a token when the canonical snapshot changes', () => {
    const issued = evaluateDowntimeAdmission(snapshot(), now);
    if (issued.token === null) throw new Error('Expected an admission token');
    const different = changed((value) => (value.diskFreePercent = 21));

    const revalidated = revalidateDowntimeAdmissionToken(issued.token, different, at(1_000));

    expect(revalidated.admitted).toBe(false);
    expect(revalidated.reasons).toEqual(['TOKEN_SNAPSHOT_MISMATCH']);
    expect(revalidated.token).toBeNull();
  });

  it('treats the exact expiry boundary as expired', () => {
    const source = snapshot();
    const issued = evaluateDowntimeAdmission(source, now);
    if (issued.token === null) throw new Error('Expected an admission token');

    expect(
      revalidateDowntimeAdmissionToken(
        issued.token,
        source,
        at(DOWNTIME_ADMISSION_TOKEN_TTL_MS - 1)
      ).admitted
    ).toBe(true);
    expect(
      revalidateDowntimeAdmissionToken(issued.token, source, issued.token.expiresAt).reasons
    ).toEqual(['TOKEN_EXPIRED']);
  });

  it('rejects malformed or tampered tokens', () => {
    const source = snapshot();
    const issued = evaluateDowntimeAdmission(source, now);
    if (issued.token === null) throw new Error('Expected an admission token');

    for (const token of [
      null,
      { ...issued.token, extra: true },
      { ...issued.token, evidenceDigest: 'a'.repeat(64) },
      { ...issued.token, expiresAt: at(DOWNTIME_ADMISSION_TOKEN_TTL_MS + 1) }
    ]) {
      const decision = revalidateDowntimeAdmissionToken(token, source, at(1_000));
      expect(decision.admitted).toBe(false);
      expect(decision.reasons).toEqual(['TOKEN_INVALID']);
      expect(decision.token).toBeNull();
    }
  });
});
