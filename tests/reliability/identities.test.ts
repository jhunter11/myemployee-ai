import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as identityFactories from '../../src/reliability/identities';

const {
  createAcceptedLossDecisionId,
  createArtifactAbandonmentEvidenceId,
  createArtifactClaimId,
  createControlMutationId,
  createExecutionRequestId,
  createFailedSettlementId,
  createIncidentId,
  createNotificationId,
  createOccurrenceId,
  createProjectionJobId,
  createProjectionReceiptKey,
  createQueueTaskId,
  createRunId,
  createSourceClaimId,
  createToolSmithProposalId,
  createVerificationAttemptId,
  createVerificationHoldId,
  createVerifiedSettlementId
} = identityFactories;

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const DIGEST_D = 'd'.repeat(64);
const DIGEST_E = 'e'.repeat(64);

const GOLDEN_IDENTITIES = {
  createOccurrenceId: '25c3ebed175138d412fbe27c25b1a2baaebd2ec013c91cd36ea1a9b588b1dd03',
  createExecutionRequestId: 'c1b4839988a2d52d1042cc0e302a121bb9e9af635d2621364f5e2d22836c427d',
  createQueueTaskId: '2a44f8378501cc66548cce1ec724bd34b19e9cb121470d2eb5126247af363fff',
  createRunId: '6dc5bbf64c5d4bd48498d9ed39d814644b49cb303cb175836bc3c5a2372a182f',
  createArtifactClaimId: '10dd155a216caafbeb2adf18531ec6f167541d415d74630770227a89def449c3',
  createSourceClaimId: '34c7697c949329b91a670a73acec1c2977d5f33f445ef2819f4949d1fab96ba5',
  createArtifactAbandonmentEvidenceId:
    'ee3ca26c00d7ee3d2493f63e15ca632a081376e72a30c529076ca4ba089b58d2',
  createVerificationHoldId: '5033b7763dc7e7007a3917ea93c19591b426898011c48ef23c221458e978b8ad',
  createVerificationAttemptId: '51ec664a5a3d04cb01c37d6e66cb7689389384086a94f976cb25f0e2ee7af98e',
  createVerifiedSettlementId: 'fa76d07ae62ba8ff4ab04b17a36a303ccbf90534d67a7c54fcce1eb77a20e997',
  createFailedSettlementId: '231d0e36b88f67f686eb1a3d99b177fc09f9a1d82582aa8241d4e6fb91223915',
  createProjectionJobId: '1cffdd34b40634a327edcc3bde3236009d095a54f361dae6c5e1624e4ae9b1a5',
  createProjectionReceiptKey: '490b3f2214e8a6398811c4fc7da0ba40c9354ff26e05846f2049c67a79d60fb5',
  createIncidentId: '0f1390c95bac8bbbef9ef13de952e3313af97eeec2bfde502b31eaadf5125800',
  createAcceptedLossDecisionId: 'ad9487e754f0e233242e14a563eac3727c62bc4b39d82452e24947d0fe03be2c',
  createNotificationId: 'ed18932998890841dfed1ac7d794da5bfb32ef097932fb2b53f8a1d14fbf3f5a',
  createToolSmithProposalId: 'f6f5afdb1245f5f82fb811c6a6165ec09831c466748c0dec0062d1a13d00c754',
  createControlMutationId: '68cee6a588f105291158292a3603e4fb05e7193cb0e924d242c7fce737dc4684'
} as const;

type IdentityFactoryName = keyof typeof GOLDEN_IDENTITIES;

interface IdentityFactoryCase {
  name: IdentityFactoryName;
  create: () => string;
  mutations: ReadonlyArray<readonly [field: string, create: () => string]>;
}

const FACTORY_CASES: readonly IdentityFactoryCase[] = [
  {
    name: 'createOccurrenceId',
    create: () =>
      createOccurrenceId({
        scheduleId: 'daily_report',
        scheduleVersion: 7,
        scheduledFor: '2026-07-22T13:00:00Z'
      }),
    mutations: [
      [
        'scheduleId',
        () =>
          createOccurrenceId({
            scheduleId: 'weekly_report',
            scheduleVersion: 7,
            scheduledFor: '2026-07-22T13:00:00Z'
          })
      ],
      [
        'scheduleVersion',
        () =>
          createOccurrenceId({
            scheduleId: 'daily_report',
            scheduleVersion: 8,
            scheduledFor: '2026-07-22T13:00:00Z'
          })
      ],
      [
        'scheduledFor',
        () =>
          createOccurrenceId({
            scheduleId: 'daily_report',
            scheduleVersion: 7,
            scheduledFor: '2026-07-22T13:00:01Z'
          })
      ]
    ]
  },
  {
    name: 'createExecutionRequestId',
    create: () =>
      createExecutionRequestId({
        sourceKind: 'schedule',
        sourceId: GOLDEN_IDENTITIES.createOccurrenceId,
        tenantId: 'acme_corp',
        automationId: 'daily-report'
      }),
    mutations: [
      [
        'sourceKind',
        () =>
          createExecutionRequestId({
            sourceKind: 'api',
            sourceId: GOLDEN_IDENTITIES.createOccurrenceId,
            tenantId: 'acme_corp',
            automationId: 'daily-report'
          })
      ],
      [
        'sourceId',
        () =>
          createExecutionRequestId({
            sourceKind: 'schedule',
            sourceId: DIGEST_B,
            tenantId: 'acme_corp',
            automationId: 'daily-report'
          })
      ],
      [
        'tenantId',
        () =>
          createExecutionRequestId({
            sourceKind: 'schedule',
            sourceId: GOLDEN_IDENTITIES.createOccurrenceId,
            tenantId: 'beta_corp',
            automationId: 'daily-report'
          })
      ],
      [
        'automationId',
        () =>
          createExecutionRequestId({
            sourceKind: 'schedule',
            sourceId: GOLDEN_IDENTITIES.createOccurrenceId,
            tenantId: 'acme_corp',
            automationId: 'weekly-report'
          })
      ]
    ]
  },
  {
    name: 'createQueueTaskId',
    create: () =>
      createQueueTaskId({
        executionRequestId: DIGEST_A,
        tenantId: 'acme_corp',
        automationId: 'daily-report'
      }),
    mutations: [
      [
        'executionRequestId',
        () =>
          createQueueTaskId({
            executionRequestId: DIGEST_B,
            tenantId: 'acme_corp',
            automationId: 'daily-report'
          })
      ],
      [
        'tenantId',
        () =>
          createQueueTaskId({
            executionRequestId: DIGEST_A,
            tenantId: 'beta_corp',
            automationId: 'daily-report'
          })
      ],
      [
        'automationId',
        () =>
          createQueueTaskId({
            executionRequestId: DIGEST_A,
            tenantId: 'acme_corp',
            automationId: 'weekly-report'
          })
      ]
    ]
  },
  {
    name: 'createRunId',
    create: () => createRunId({ executionRequestId: DIGEST_A, queueTaskId: DIGEST_B }),
    mutations: [
      [
        'executionRequestId',
        () => createRunId({ executionRequestId: DIGEST_C, queueTaskId: DIGEST_B })
      ],
      ['queueTaskId', () => createRunId({ executionRequestId: DIGEST_A, queueTaskId: DIGEST_C })]
    ]
  },
  {
    name: 'createArtifactClaimId',
    create: () =>
      createArtifactClaimId({
        artifactScopeKey: 'acme_corp:daily-report:report',
        executionRequestId: DIGEST_A,
        runId: DIGEST_B
      }),
    mutations: [
      [
        'artifactScopeKey',
        () =>
          createArtifactClaimId({
            artifactScopeKey: 'acme_corp:daily-report:summary',
            executionRequestId: DIGEST_A,
            runId: DIGEST_B
          })
      ],
      [
        'executionRequestId',
        () =>
          createArtifactClaimId({
            artifactScopeKey: 'acme_corp:daily-report:report',
            executionRequestId: DIGEST_C,
            runId: DIGEST_B
          })
      ],
      [
        'runId',
        () =>
          createArtifactClaimId({
            artifactScopeKey: 'acme_corp:daily-report:report',
            executionRequestId: DIGEST_A,
            runId: DIGEST_C
          })
      ]
    ]
  },
  {
    name: 'createSourceClaimId',
    create: () =>
      createSourceClaimId({
        artifactClaimId: DIGEST_A,
        sourceRegistrationId: 'acme-daily-report-source-v1'
      }),
    mutations: [
      [
        'artifactClaimId',
        () =>
          createSourceClaimId({
            artifactClaimId: DIGEST_B,
            sourceRegistrationId: 'acme-daily-report-source-v1'
          })
      ],
      [
        'sourceRegistrationId',
        () =>
          createSourceClaimId({
            artifactClaimId: DIGEST_A,
            sourceRegistrationId: 'acme-daily-report-source-v2'
          })
      ]
    ]
  },
  {
    name: 'createArtifactAbandonmentEvidenceId',
    create: () =>
      createArtifactAbandonmentEvidenceId({
        artifactClaimId: DIGEST_A,
        expectedClaimVersion: 2,
        reasonCode: 'worker_failed'
      }),
    mutations: [
      [
        'artifactClaimId',
        () =>
          createArtifactAbandonmentEvidenceId({
            artifactClaimId: DIGEST_B,
            expectedClaimVersion: 2,
            reasonCode: 'worker_failed'
          })
      ],
      [
        'expectedClaimVersion',
        () =>
          createArtifactAbandonmentEvidenceId({
            artifactClaimId: DIGEST_A,
            expectedClaimVersion: 3,
            reasonCode: 'worker_failed'
          })
      ],
      [
        'reasonCode',
        () =>
          createArtifactAbandonmentEvidenceId({
            artifactClaimId: DIGEST_A,
            expectedClaimVersion: 2,
            reasonCode: 'source_snapshot_failed'
          })
      ]
    ]
  },
  {
    name: 'createVerificationHoldId',
    create: () =>
      createVerificationHoldId({
        tenantId: 'acme_corp',
        queueTaskId: DIGEST_A,
        leasedVersion: 3,
        queueAttempt: 1,
        runId: DIGEST_B
      }),
    mutations: [
      [
        'tenantId',
        () =>
          createVerificationHoldId({
            tenantId: 'beta_corp',
            queueTaskId: DIGEST_A,
            leasedVersion: 3,
            queueAttempt: 1,
            runId: DIGEST_B
          })
      ],
      [
        'queueTaskId',
        () =>
          createVerificationHoldId({
            tenantId: 'acme_corp',
            queueTaskId: DIGEST_C,
            leasedVersion: 3,
            queueAttempt: 1,
            runId: DIGEST_B
          })
      ],
      [
        'leasedVersion',
        () =>
          createVerificationHoldId({
            tenantId: 'acme_corp',
            queueTaskId: DIGEST_A,
            leasedVersion: 4,
            queueAttempt: 1,
            runId: DIGEST_B
          })
      ],
      [
        'queueAttempt',
        () =>
          createVerificationHoldId({
            tenantId: 'acme_corp',
            queueTaskId: DIGEST_A,
            leasedVersion: 3,
            queueAttempt: 2,
            runId: DIGEST_B
          })
      ],
      [
        'runId',
        () =>
          createVerificationHoldId({
            tenantId: 'acme_corp',
            queueTaskId: DIGEST_A,
            leasedVersion: 3,
            queueAttempt: 1,
            runId: DIGEST_C
          })
      ]
    ]
  },
  {
    name: 'createVerificationAttemptId',
    create: () =>
      createVerificationAttemptId({
        holdId: DIGEST_A,
        verifierRevision: 'daily-report-v1',
        subattempt: 1
      }),
    mutations: [
      [
        'holdId',
        () =>
          createVerificationAttemptId({
            holdId: DIGEST_B,
            verifierRevision: 'daily-report-v1',
            subattempt: 1
          })
      ],
      [
        'verifierRevision',
        () =>
          createVerificationAttemptId({
            holdId: DIGEST_A,
            verifierRevision: 'daily-report-v2',
            subattempt: 1
          })
      ],
      [
        'subattempt',
        () =>
          createVerificationAttemptId({
            holdId: DIGEST_A,
            verifierRevision: 'daily-report-v1',
            subattempt: 2
          })
      ]
    ]
  },
  {
    name: 'createVerifiedSettlementId',
    create: () => createVerifiedSettlementId({ holdId: DIGEST_A, attemptId: DIGEST_B }),
    mutations: [
      ['holdId', () => createVerifiedSettlementId({ holdId: DIGEST_C, attemptId: DIGEST_B })],
      ['attemptId', () => createVerifiedSettlementId({ holdId: DIGEST_A, attemptId: DIGEST_C })]
    ]
  },
  {
    name: 'createFailedSettlementId',
    create: () =>
      createFailedSettlementId({
        holdId: DIGEST_A,
        attemptId: DIGEST_B,
        reasonCode: 'artifact_mismatch'
      }),
    mutations: [
      [
        'holdId',
        () =>
          createFailedSettlementId({
            holdId: DIGEST_C,
            attemptId: DIGEST_B,
            reasonCode: 'artifact_mismatch'
          })
      ],
      [
        'attemptId',
        () =>
          createFailedSettlementId({
            holdId: DIGEST_A,
            attemptId: DIGEST_C,
            reasonCode: 'artifact_mismatch'
          })
      ],
      [
        'reasonCode',
        () =>
          createFailedSettlementId({
            holdId: DIGEST_A,
            attemptId: DIGEST_B,
            reasonCode: 'output_invalid'
          })
      ]
    ]
  },
  {
    name: 'createProjectionJobId',
    create: () =>
      createProjectionJobId({
        settlementId: DIGEST_A,
        finalizationAction: 'finalize_verified'
      }),
    mutations: [
      [
        'settlementId',
        () =>
          createProjectionJobId({
            settlementId: DIGEST_B,
            finalizationAction: 'finalize_verified'
          })
      ],
      [
        'finalizationAction',
        () =>
          createProjectionJobId({
            settlementId: DIGEST_A,
            finalizationAction: 'finalize_rejected'
          })
      ]
    ]
  },
  {
    name: 'createProjectionReceiptKey',
    create: () =>
      createProjectionReceiptKey({
        runId: DIGEST_A,
        projectionKind: 'artifact',
        projectorVersion: 'daily-report-artifact-v1'
      }),
    mutations: [
      [
        'runId',
        () =>
          createProjectionReceiptKey({
            runId: DIGEST_B,
            projectionKind: 'artifact',
            projectorVersion: 'daily-report-artifact-v1'
          })
      ],
      [
        'projectionKind',
        () =>
          createProjectionReceiptKey({
            runId: DIGEST_A,
            projectionKind: 'diagram',
            projectorVersion: 'daily-report-artifact-v1'
          })
      ],
      [
        'projectorVersion',
        () =>
          createProjectionReceiptKey({
            runId: DIGEST_A,
            projectionKind: 'artifact',
            projectorVersion: 'daily-report-artifact-v2'
          })
      ]
    ]
  },
  {
    name: 'createIncidentId',
    create: () =>
      createIncidentId({
        kind: 'verification_failed',
        subjectId: DIGEST_A,
        policyVersion: 'v1'
      }),
    mutations: [
      [
        'kind',
        () =>
          createIncidentId({
            kind: 'verification_interrupted',
            subjectId: DIGEST_A,
            policyVersion: 'v1'
          })
      ],
      [
        'subjectId',
        () =>
          createIncidentId({
            kind: 'verification_failed',
            subjectId: DIGEST_B,
            policyVersion: 'v1'
          })
      ],
      [
        'policyVersion',
        () =>
          createIncidentId({
            kind: 'verification_failed',
            subjectId: DIGEST_A,
            policyVersion: 'v2'
          })
      ]
    ]
  },
  {
    name: 'createAcceptedLossDecisionId',
    create: () =>
      createAcceptedLossDecisionId({
        incidentId: DIGEST_A,
        expectedIncidentVersion: 1,
        subjectId: DIGEST_B,
        remediationEvidenceSha256: DIGEST_C,
        newCampaignBoundarySha256: DIGEST_D
      }),
    mutations: [
      [
        'incidentId',
        () =>
          createAcceptedLossDecisionId({
            incidentId: DIGEST_E,
            expectedIncidentVersion: 1,
            subjectId: DIGEST_B,
            remediationEvidenceSha256: DIGEST_C,
            newCampaignBoundarySha256: DIGEST_D
          })
      ],
      [
        'expectedIncidentVersion',
        () =>
          createAcceptedLossDecisionId({
            incidentId: DIGEST_A,
            expectedIncidentVersion: 2,
            subjectId: DIGEST_B,
            remediationEvidenceSha256: DIGEST_C,
            newCampaignBoundarySha256: DIGEST_D
          })
      ],
      [
        'subjectId',
        () =>
          createAcceptedLossDecisionId({
            incidentId: DIGEST_A,
            expectedIncidentVersion: 1,
            subjectId: DIGEST_E,
            remediationEvidenceSha256: DIGEST_C,
            newCampaignBoundarySha256: DIGEST_D
          })
      ],
      [
        'remediationEvidenceSha256',
        () =>
          createAcceptedLossDecisionId({
            incidentId: DIGEST_A,
            expectedIncidentVersion: 1,
            subjectId: DIGEST_B,
            remediationEvidenceSha256: DIGEST_E,
            newCampaignBoundarySha256: DIGEST_D
          })
      ],
      [
        'newCampaignBoundarySha256',
        () =>
          createAcceptedLossDecisionId({
            incidentId: DIGEST_A,
            expectedIncidentVersion: 1,
            subjectId: DIGEST_B,
            remediationEvidenceSha256: DIGEST_C,
            newCampaignBoundarySha256: DIGEST_E
          })
      ]
    ]
  },
  {
    name: 'createNotificationId',
    create: () =>
      createNotificationId({
        eventKind: 'scheduled_run_verified',
        eventId: DIGEST_A,
        bindingDigest: DIGEST_B,
        templateVersion: 'scheduled_run_verified_v1'
      }),
    mutations: [
      [
        'eventKind',
        () =>
          createNotificationId({
            eventKind: 'scheduled_run_failed',
            eventId: DIGEST_A,
            bindingDigest: DIGEST_B,
            templateVersion: 'scheduled_run_verified_v1'
          })
      ],
      [
        'eventId',
        () =>
          createNotificationId({
            eventKind: 'scheduled_run_verified',
            eventId: DIGEST_C,
            bindingDigest: DIGEST_B,
            templateVersion: 'scheduled_run_verified_v1'
          })
      ],
      [
        'bindingDigest',
        () =>
          createNotificationId({
            eventKind: 'scheduled_run_verified',
            eventId: DIGEST_A,
            bindingDigest: DIGEST_C,
            templateVersion: 'scheduled_run_verified_v1'
          })
      ],
      [
        'templateVersion',
        () =>
          createNotificationId({
            eventKind: 'scheduled_run_verified',
            eventId: DIGEST_A,
            bindingDigest: DIGEST_B,
            templateVersion: 'scheduled_run_verified_v2'
          })
      ]
    ]
  },
  {
    name: 'createToolSmithProposalId',
    create: () =>
      createToolSmithProposalId({
        tenantId: 'acme_corp',
        automationId: 'daily-report',
        ruleVersion: 'toolsmith-frequency-v1'
      }),
    mutations: [
      [
        'tenantId',
        () =>
          createToolSmithProposalId({
            tenantId: 'beta_corp',
            automationId: 'daily-report',
            ruleVersion: 'toolsmith-frequency-v1'
          })
      ],
      [
        'automationId',
        () =>
          createToolSmithProposalId({
            tenantId: 'acme_corp',
            automationId: 'weekly-report',
            ruleVersion: 'toolsmith-frequency-v1'
          })
      ],
      [
        'ruleVersion',
        () =>
          createToolSmithProposalId({
            tenantId: 'acme_corp',
            automationId: 'daily-report',
            ruleVersion: 'toolsmith-frequency-v2'
          })
      ]
    ]
  },
  {
    name: 'createControlMutationId',
    create: () =>
      createControlMutationId({
        kind: 'release_cutover',
        planFingerprint: DIGEST_A,
        expectedPriorStateSha256: DIGEST_B
      }),
    mutations: [
      [
        'kind',
        () =>
          createControlMutationId({
            kind: 'trust_registry_sync',
            planFingerprint: DIGEST_A,
            expectedPriorStateSha256: DIGEST_B
          })
      ],
      [
        'planFingerprint',
        () =>
          createControlMutationId({
            kind: 'release_cutover',
            planFingerprint: DIGEST_C,
            expectedPriorStateSha256: DIGEST_B
          })
      ],
      [
        'expectedPriorStateSha256',
        () =>
          createControlMutationId({
            kind: 'release_cutover',
            planFingerprint: DIGEST_A,
            expectedPriorStateSha256: DIGEST_C
          })
      ]
    ]
  }
];

describe('reliability identity factory', () => {
  it('keeps an exact golden vector for every exported identity factory', () => {
    const exportedFactoryNames = Object.keys(identityFactories)
      .filter((name) => name.startsWith('create'))
      .sort();

    expect(exportedFactoryNames).toEqual(Object.keys(GOLDEN_IDENTITIES).sort());
    expect(FACTORY_CASES).toHaveLength(exportedFactoryNames.length);

    for (const factoryCase of FACTORY_CASES) {
      expect(factoryCase.create(), factoryCase.name).toBe(GOLDEN_IDENTITIES[factoryCase.name]);
    }
  });

  it('binds every declared field of every factory into its identity', () => {
    for (const factoryCase of FACTORY_CASES) {
      const baseline = factoryCase.create();
      for (const [field, createMutation] of factoryCase.mutations) {
        const mutated = createMutation();
        expect(mutated, `${factoryCase.name}.${field}`).toMatch(/^[a-f0-9]{64}$/u);
        expect(mutated, `${factoryCase.name}.${field}`).not.toBe(baseline);
      }
    }
  });

  it('accepts only exact enumerable data-property input shapes', () => {
    expect(() =>
      createOccurrenceId({
        scheduleId: 'daily_report',
        scheduleVersion: 7,
        scheduledFor: '2026-07-22T13:00:00Z',
        unexpected: 'must-not-be-hashed'
      } as never)
    ).toThrow(/exact registered fields/iu);

    expect(() =>
      createOccurrenceId({
        scheduleId: 'daily_report',
        scheduleVersion: 7
      } as never)
    ).toThrow(/exact registered fields/iu);

    let accessorRead = false;
    const accessorInput: Record<string, unknown> = {
      sourceKind: 'schedule',
      tenantId: 'acme_corp',
      automationId: 'daily-report'
    };
    Object.defineProperty(accessorInput, 'sourceId', {
      enumerable: true,
      get: () => {
        accessorRead = true;
        return GOLDEN_IDENTITIES.createOccurrenceId;
      }
    });

    expect(() => createExecutionRequestId(accessorInput as never)).toThrow(
      /enumerable data properties/iu
    );
    expect(accessorRead).toBe(false);
  });

  it('requires an occurrence digest only for scheduled execution requests', () => {
    expect(() =>
      createExecutionRequestId({
        sourceKind: 'schedule',
        sourceId: 'occurrence-7',
        tenantId: 'acme_corp',
        automationId: 'daily-report'
      })
    ).toThrow(/sourceId/iu);

    expect(
      createExecutionRequestId({
        sourceKind: 'api',
        sourceId: 'api-request-17',
        tenantId: 'acme_corp',
        automationId: 'daily-report'
      })
    ).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects unregistered runtime enum and protocol-code values', () => {
    const invalidCases: ReadonlyArray<readonly [field: string, invoke: () => string]> = [
      [
        'sourceKind',
        () =>
          createExecutionRequestId({
            sourceKind: 'manual' as never,
            sourceId: 'request-1',
            tenantId: 'acme_corp',
            automationId: 'daily-report'
          })
      ],
      [
        'reasonCode',
        () =>
          createArtifactAbandonmentEvidenceId({
            artifactClaimId: DIGEST_A,
            expectedClaimVersion: 1,
            reasonCode: 'arbitrary' as never
          })
      ],
      [
        'reasonCode',
        () =>
          createFailedSettlementId({
            holdId: DIGEST_A,
            attemptId: DIGEST_B,
            reasonCode: 'arbitrary' as never
          })
      ],
      [
        'finalizationAction',
        () =>
          createProjectionJobId({
            settlementId: DIGEST_A,
            finalizationAction: 'finalize_anything' as never
          })
      ],
      [
        'projectionKind',
        () =>
          createProjectionReceiptKey({
            runId: DIGEST_A,
            projectionKind: 'arbitrary' as never,
            projectorVersion: 'v1'
          })
      ],
      [
        'kind',
        () =>
          createControlMutationId({
            kind: 'anything' as never,
            planFingerprint: DIGEST_A,
            expectedPriorStateSha256: DIGEST_B
          })
      ],
      [
        'kind',
        () => createIncidentId({ kind: 'UPPERCASE', subjectId: DIGEST_A, policyVersion: 'v1' })
      ],
      [
        'eventKind',
        () =>
          createNotificationId({
            eventKind: 'not-hyphenated',
            eventId: DIGEST_A,
            bindingDigest: DIGEST_B,
            templateVersion: 'v1'
          })
      ]
    ];

    for (const [field, invoke] of invalidCases) {
      expect(invoke, field).toThrow(new RegExp(field, 'iu'));
    }
  });

  it('rejects every digest-bearing field when its runtime value is not a SHA-256 digest', () => {
    const invalidDigestCases: ReadonlyArray<readonly [field: string, invoke: () => string]> = [
      [
        'sourceId',
        () =>
          createExecutionRequestId({
            sourceKind: 'schedule',
            sourceId: 'not-an-occurrence-digest',
            tenantId: 'acme_corp',
            automationId: 'daily-report'
          })
      ],
      [
        'executionRequestId',
        () =>
          createQueueTaskId({
            executionRequestId: 'not-a-digest',
            tenantId: 'acme_corp',
            automationId: 'daily-report'
          })
      ],
      [
        'executionRequestId',
        () => createRunId({ executionRequestId: 'not-a-digest', queueTaskId: DIGEST_B })
      ],
      [
        'queueTaskId',
        () => createRunId({ executionRequestId: DIGEST_A, queueTaskId: 'not-a-digest' })
      ],
      [
        'executionRequestId',
        () =>
          createArtifactClaimId({
            artifactScopeKey: 'scope',
            executionRequestId: 'not-a-digest',
            runId: DIGEST_B
          })
      ],
      [
        'runId',
        () =>
          createArtifactClaimId({
            artifactScopeKey: 'scope',
            executionRequestId: DIGEST_A,
            runId: 'not-a-digest'
          })
      ],
      [
        'artifactClaimId',
        () =>
          createSourceClaimId({
            artifactClaimId: 'not-a-digest',
            sourceRegistrationId: 'source-v1'
          })
      ],
      [
        'artifactClaimId',
        () =>
          createArtifactAbandonmentEvidenceId({
            artifactClaimId: 'not-a-digest',
            expectedClaimVersion: 1,
            reasonCode: 'worker_failed'
          })
      ],
      [
        'queueTaskId',
        () =>
          createVerificationHoldId({
            tenantId: 'acme_corp',
            queueTaskId: 'not-a-digest',
            leasedVersion: 1,
            queueAttempt: 1,
            runId: DIGEST_B
          })
      ],
      [
        'runId',
        () =>
          createVerificationHoldId({
            tenantId: 'acme_corp',
            queueTaskId: DIGEST_A,
            leasedVersion: 1,
            queueAttempt: 1,
            runId: 'not-a-digest'
          })
      ],
      [
        'holdId',
        () =>
          createVerificationAttemptId({
            holdId: 'not-a-digest',
            verifierRevision: 'v1',
            subattempt: 1
          })
      ],
      ['holdId', () => createVerifiedSettlementId({ holdId: 'not-a-digest', attemptId: DIGEST_B })],
      [
        'attemptId',
        () => createVerifiedSettlementId({ holdId: DIGEST_A, attemptId: 'not-a-digest' })
      ],
      [
        'holdId',
        () =>
          createFailedSettlementId({
            holdId: 'not-a-digest',
            attemptId: DIGEST_B,
            reasonCode: 'artifact_mismatch'
          })
      ],
      [
        'attemptId',
        () =>
          createFailedSettlementId({
            holdId: DIGEST_A,
            attemptId: 'not-a-digest',
            reasonCode: 'artifact_mismatch'
          })
      ],
      [
        'settlementId',
        () =>
          createProjectionJobId({
            settlementId: 'not-a-digest',
            finalizationAction: 'finalize_verified'
          })
      ],
      [
        'runId',
        () =>
          createProjectionReceiptKey({
            runId: 'not-a-digest',
            projectionKind: 'artifact',
            projectorVersion: 'v1'
          })
      ],
      [
        'subjectId',
        () =>
          createIncidentId({
            kind: 'verification_failed',
            subjectId: 'not-a-digest',
            policyVersion: 'v1'
          })
      ],
      [
        'incidentId',
        () =>
          createAcceptedLossDecisionId({
            incidentId: 'not-a-digest',
            expectedIncidentVersion: 1,
            subjectId: DIGEST_B,
            remediationEvidenceSha256: DIGEST_C,
            newCampaignBoundarySha256: DIGEST_D
          })
      ],
      [
        'subjectId',
        () =>
          createAcceptedLossDecisionId({
            incidentId: DIGEST_A,
            expectedIncidentVersion: 1,
            subjectId: 'not-a-digest',
            remediationEvidenceSha256: DIGEST_C,
            newCampaignBoundarySha256: DIGEST_D
          })
      ],
      [
        'remediationEvidenceSha256',
        () =>
          createAcceptedLossDecisionId({
            incidentId: DIGEST_A,
            expectedIncidentVersion: 1,
            subjectId: DIGEST_B,
            remediationEvidenceSha256: 'not-a-digest',
            newCampaignBoundarySha256: DIGEST_D
          })
      ],
      [
        'newCampaignBoundarySha256',
        () =>
          createAcceptedLossDecisionId({
            incidentId: DIGEST_A,
            expectedIncidentVersion: 1,
            subjectId: DIGEST_B,
            remediationEvidenceSha256: DIGEST_C,
            newCampaignBoundarySha256: 'not-a-digest'
          })
      ],
      [
        'eventId',
        () =>
          createNotificationId({
            eventKind: 'scheduled_run_verified',
            eventId: 'not-a-digest',
            bindingDigest: DIGEST_B,
            templateVersion: 'v1'
          })
      ],
      [
        'bindingDigest',
        () =>
          createNotificationId({
            eventKind: 'scheduled_run_verified',
            eventId: DIGEST_A,
            bindingDigest: 'not-a-digest',
            templateVersion: 'v1'
          })
      ],
      [
        'planFingerprint',
        () =>
          createControlMutationId({
            kind: 'release_cutover',
            planFingerprint: 'not-a-digest',
            expectedPriorStateSha256: DIGEST_B
          })
      ],
      [
        'expectedPriorStateSha256',
        () =>
          createControlMutationId({
            kind: 'release_cutover',
            planFingerprint: DIGEST_A,
            expectedPriorStateSha256: 'not-a-digest'
          })
      ]
    ];

    for (const [field, invoke] of invalidDigestCases) {
      expect(invoke, field).toThrow(new RegExp(field, 'iu'));
    }
  });

  it('rejects empty canonical fields and non-positive or unsafe versions', () => {
    expect(() => createIncidentId({ kind: '', subjectId: DIGEST_A, policyVersion: 'v1' })).toThrow(
      /kind/iu
    );
    expect(() =>
      createVerificationHoldId({
        tenantId: 'acme_corp',
        queueTaskId: DIGEST_A,
        leasedVersion: 0,
        queueAttempt: 1,
        runId: DIGEST_B
      })
    ).toThrow(/leasedVersion/iu);
    expect(() =>
      createOccurrenceId({
        scheduleId: 'daily_report',
        scheduleVersion: Number.MAX_SAFE_INTEGER + 1,
        scheduledFor: '2026-07-22T13:00:00Z'
      })
    ).toThrow(/scheduleVersion/iu);
  });

  it('reproduces every golden identity in a fresh tsx process', () => {
    const repositoryRoot = resolve(__dirname, '../..');
    const tsxExecutable = resolve(repositoryRoot, 'node_modules/.bin/tsx');
    const identitiesModule = resolve(repositoryRoot, 'src/reliability/identities.ts');
    const childScript = `
      const i = require(${JSON.stringify(identitiesModule)});
      const a = 'a'.repeat(64);
      const b = 'b'.repeat(64);
      const c = 'c'.repeat(64);
      const d = 'd'.repeat(64);
      const occurrenceId = i.createOccurrenceId({ scheduleId: 'daily_report', scheduleVersion: 7, scheduledFor: '2026-07-22T13:00:00Z' });
      const results = {
        createOccurrenceId: occurrenceId,
        createExecutionRequestId: i.createExecutionRequestId({ sourceKind: 'schedule', sourceId: occurrenceId, tenantId: 'acme_corp', automationId: 'daily-report' }),
        createQueueTaskId: i.createQueueTaskId({ executionRequestId: a, tenantId: 'acme_corp', automationId: 'daily-report' }),
        createRunId: i.createRunId({ executionRequestId: a, queueTaskId: b }),
        createArtifactClaimId: i.createArtifactClaimId({ artifactScopeKey: 'acme_corp:daily-report:report', executionRequestId: a, runId: b }),
        createSourceClaimId: i.createSourceClaimId({ artifactClaimId: a, sourceRegistrationId: 'acme-daily-report-source-v1' }),
        createArtifactAbandonmentEvidenceId: i.createArtifactAbandonmentEvidenceId({ artifactClaimId: a, expectedClaimVersion: 2, reasonCode: 'worker_failed' }),
        createVerificationHoldId: i.createVerificationHoldId({ tenantId: 'acme_corp', queueTaskId: a, leasedVersion: 3, queueAttempt: 1, runId: b }),
        createVerificationAttemptId: i.createVerificationAttemptId({ holdId: a, verifierRevision: 'daily-report-v1', subattempt: 1 }),
        createVerifiedSettlementId: i.createVerifiedSettlementId({ holdId: a, attemptId: b }),
        createFailedSettlementId: i.createFailedSettlementId({ holdId: a, attemptId: b, reasonCode: 'artifact_mismatch' }),
        createProjectionJobId: i.createProjectionJobId({ settlementId: a, finalizationAction: 'finalize_verified' }),
        createProjectionReceiptKey: i.createProjectionReceiptKey({ runId: a, projectionKind: 'artifact', projectorVersion: 'daily-report-artifact-v1' }),
        createIncidentId: i.createIncidentId({ kind: 'verification_failed', subjectId: a, policyVersion: 'v1' }),
        createAcceptedLossDecisionId: i.createAcceptedLossDecisionId({ incidentId: a, expectedIncidentVersion: 1, subjectId: b, remediationEvidenceSha256: c, newCampaignBoundarySha256: d }),
        createNotificationId: i.createNotificationId({ eventKind: 'scheduled_run_verified', eventId: a, bindingDigest: b, templateVersion: 'scheduled_run_verified_v1' }),
        createToolSmithProposalId: i.createToolSmithProposalId({ tenantId: 'acme_corp', automationId: 'daily-report', ruleVersion: 'toolsmith-frequency-v1' }),
        createControlMutationId: i.createControlMutationId({ kind: 'release_cutover', planFingerprint: a, expectedPriorStateSha256: b })
      };
      process.stdout.write(JSON.stringify(results));
    `;

    const childOutput = execFileSync(tsxExecutable, ['--eval', childScript], {
      cwd: repositoryRoot,
      encoding: 'utf8'
    });

    expect(JSON.parse(childOutput) as unknown).toEqual(GOLDEN_IDENTITIES);
  });
});
