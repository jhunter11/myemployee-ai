import { describe, expect, it } from 'vitest';

import {
  SubmissionApprovalSchema,
  authorizeTaskmarketSubmission,
  taskmarketSubmissionArtifactPath
} from '../../src/task-market/submission-authorization';

const NOW = '2026-07-20T16:00:00.000Z';
const TASK_ID = `0x${'1'.repeat(64)}`;
const TASK_DIGEST = '2'.repeat(64);
const ARTIFACT_DIGEST = '3'.repeat(64);
const WALLET = `0x${'4'.repeat(40)}`;

function approval(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    action: 'taskmarket_submit',
    approved: true,
    taskId: TASK_ID,
    taskDigest: TASK_DIGEST,
    artifactDigest: ARTIFACT_DIGEST,
    walletAddress: WALLET,
    maxPaymentBaseUnits: '0',
    approvedBy: 'owner',
    approvedAt: '2026-07-20T15:55:00.000Z',
    expiresAt: '2026-07-20T16:05:00.000Z',
    ...overrides
  };
}

function inspection(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    taskDigest: TASK_DIGEST,
    status: 'open',
    submissionWindowOpen: true,
    expiresAt: '2026-07-22T16:00:00.000Z',
    pendingActions: [
      {
        role: 'worker',
        action: 'submit',
        eligibleAddress: null,
        requiresPayment: false,
        paymentAmount: null,
        availableAfter: null,
        availableUntil: '2026-07-22T16:00:00.000Z'
      }
    ],
    ...overrides
  };
}

describe('Taskmarket submission authorization', () => {
  it('binds one zero-payment submission to the exact task, artifact, wallet, and fixed command', () => {
    const result = authorizeTaskmarketSubmission(
      {
        taskId: TASK_ID,
        taskDigest: TASK_DIGEST,
        artifactDigest: ARTIFACT_DIGEST,
        walletAddress: WALLET,
        projectRoot: '/srv/jarvis'
      },
      approval(),
      inspection(),
      NOW
    );

    expect(result).toEqual({
      schemaVersion: 1,
      authorized: true,
      authorizationDigest: result.authorizationDigest,
      expiresAt: '2026-07-20T16:05:00.000Z',
      command: {
        executable: 'taskmarket',
        args: [
          'task',
          'submit',
          TASK_ID,
          '--file',
          `/srv/jarvis/workspaces/taskmarket/${TASK_ID.slice(2)}/submission.json`
        ]
      }
    });
    expect(result.authorizationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toMatch(/approvedBy|walletAddress|pendingActions/i);
  });

  it('uses a fixed artifact path and cannot be redirected by task text or caller paths', () => {
    expect(taskmarketSubmissionArtifactPath('/srv/jarvis', TASK_ID)).toBe(
      `/srv/jarvis/workspaces/taskmarket/${TASK_ID.slice(2)}/submission.json`
    );
    for (const invalid of ['../escape', '0x1234', `${TASK_ID}/../../escape`]) {
      expect(() => taskmarketSubmissionArtifactPath('/srv/jarvis', invalid)).toThrow();
    }
    expect(() => taskmarketSubmissionArtifactPath('relative/root', TASK_ID)).toThrow();
  });

  it('rejects any mismatch between current evidence and the exact approval', () => {
    const intent = {
      taskId: TASK_ID,
      taskDigest: TASK_DIGEST,
      artifactDigest: ARTIFACT_DIGEST,
      walletAddress: WALLET,
      projectRoot: '/srv/jarvis'
    };
    const mismatches = [
      approval({ taskId: `0x${'5'.repeat(64)}` }),
      approval({ taskDigest: '5'.repeat(64) }),
      approval({ artifactDigest: '5'.repeat(64) }),
      approval({ walletAddress: `0x${'5'.repeat(40)}` }),
      approval({ maxPaymentBaseUnits: '1' }),
      inspection({ taskDigest: '5'.repeat(64) })
    ];

    for (const mismatch of mismatches) {
      const isInspection = 'pendingActions' in mismatch;
      expect(() =>
        authorizeTaskmarketSubmission(
          intent,
          isInspection ? approval() : mismatch,
          isInspection ? mismatch : inspection(),
          NOW
        )
      ).toThrow();
    }
  });

  it('requires a current free worker submit action and an open task/window', () => {
    const intent = {
      taskId: TASK_ID,
      taskDigest: TASK_DIGEST,
      artifactDigest: ARTIFACT_DIGEST,
      walletAddress: WALLET,
      projectRoot: '/srv/jarvis'
    };
    const deniedInspections = [
      inspection({ status: 'completed' }),
      inspection({ submissionWindowOpen: false }),
      inspection({ expiresAt: NOW }),
      inspection({ pendingActions: [] }),
      inspection({
        pendingActions: [
          {
            ...inspection().pendingActions[0],
            role: 'requester'
          }
        ]
      }),
      inspection({
        pendingActions: [
          {
            ...inspection().pendingActions[0],
            requiresPayment: true,
            paymentAmount: '1000'
          }
        ]
      }),
      inspection({
        pendingActions: [
          {
            ...inspection().pendingActions[0],
            eligibleAddress: `0x${'6'.repeat(40)}`
          }
        ]
      }),
      inspection({
        pendingActions: [
          {
            ...inspection().pendingActions[0],
            availableAfter: '2026-07-20T16:00:01.000Z'
          }
        ]
      }),
      inspection({
        pendingActions: [
          {
            ...inspection().pendingActions[0],
            availableUntil: NOW
          }
        ]
      })
    ];

    for (const current of deniedInspections) {
      expect(() => authorizeTaskmarketSubmission(intent, approval(), current, NOW)).toThrow();
    }
  });

  it('rejects expired, future, malformed, and extensible approval records', () => {
    const intent = {
      taskId: TASK_ID,
      taskDigest: TASK_DIGEST,
      artifactDigest: ARTIFACT_DIGEST,
      walletAddress: WALLET,
      projectRoot: '/srv/jarvis'
    };
    for (const invalid of [
      approval({ approved: false }),
      approval({ extra: 'authority expansion' }),
      approval({ action: 'taskmarket_accept' })
    ]) {
      expect(() => SubmissionApprovalSchema.parse(invalid)).toThrow();
      expect(() => authorizeTaskmarketSubmission(intent, invalid, inspection(), NOW)).toThrow();
    }

    for (const temporallyInvalid of [
      approval({ approvedAt: '2026-07-20T16:00:01.000Z' }),
      approval({ expiresAt: NOW })
    ]) {
      expect(() => SubmissionApprovalSchema.parse(temporallyInvalid)).not.toThrow();
      expect(() =>
        authorizeTaskmarketSubmission(intent, temporallyInvalid, inspection(), NOW)
      ).toThrow();
    }

    expect(() =>
      SubmissionApprovalSchema.parse(
        approval({
          approvedAt: '2026-07-20T16:05:00.000Z',
          expiresAt: '2026-07-20T16:04:59.000Z'
        })
      )
    ).toThrow();
  });

  it('is deterministic across strict object key order', () => {
    const intent = {
      taskId: TASK_ID,
      taskDigest: TASK_DIGEST,
      artifactDigest: ARTIFACT_DIGEST,
      walletAddress: WALLET,
      projectRoot: '/srv/jarvis'
    };
    const first = authorizeTaskmarketSubmission(intent, approval(), inspection(), NOW);
    const reversedApproval = Object.fromEntries(Object.entries(approval()).reverse());
    const reversedInspection = Object.fromEntries(Object.entries(inspection()).reverse());

    expect(
      authorizeTaskmarketSubmission(intent, reversedApproval, reversedInspection, NOW)
    ).toEqual(first);
  });
});
