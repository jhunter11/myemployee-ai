import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { z } from 'zod';

import { createDatabase } from '../db/database';
import { PriorityQueueRepository } from '../db/priority-queue-repository';
import { RevenuePipelineRepository } from '../db/revenue-pipeline-repository';
import { QueueTaskInputSchema, type QueueTaskInput } from '../queue/contracts';
import {
  CreateOfferInputSchema,
  CreateOutreachDraftInputSchema,
  CreateProspectInputSchema,
  InitializeTaskMarketContractInputSchema,
  MICRO_USD_PER_USD,
  RecordTaskMarketSimulationInputSchema,
  REVENUE_PIPELINE_SAFETY,
  type TaskMarketSimulationScenario
} from './contracts';

const MAX_PACK_BYTES = 256 * 1_024;
const BOOTSTRAP_ACTOR = 'bootstrap:first-client';
const A2A_VERSION = '0.3.0';
const TASK_PRODUCT_ID = 'edge-validation-v1';
const TASK_SKILL_ID = 'edge_validation';
const TASK_QUOTE_MICROUSD = MICRO_USD_PER_USD / 2;
const OFFER_AMOUNT_MICROUSD = 750 * MICRO_USD_PER_USD;
const TIE_BREAK = 'score_desc_id_asc' as const;
const OPERATOR_TENANT_ID = 'jarvis' as const;
const OPERATOR_QUEUE_PAYLOAD_KINDS = ['operator_gate', 'project_task'] as const;

const ExpectedApprovals = [
  'reverify_public_business_and_contact_page',
  'confirm_contact_channel_terms_and_applicable_law',
  'confirm_business_identity_and_sender_address',
  'review_exact_recipient_subject_and_body',
  'record_operator_approval_for_one_message_only'
] as const;
const DiscoveryUnknowns = [
  'lead_volume',
  'current_system',
  'budget',
  'decision_authority'
] as const;
const SimulationScenarios = [
  'authorization_accepted',
  'authorization_rejected',
  'duplicate_replay'
] as const satisfies readonly TaskMarketSimulationScenario[];

const RevenueIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/);
const SafeTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      ![...value].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
      }),
    'control characters are not allowed'
  );
const DirectHttpsUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    context.addIssue({ code: 'custom', message: 'URL must be direct public HTTPS' });
  }
});
const PublicSignalSchema = z.enum([
  'residential_roofing',
  'local_or_regional_footprint',
  'public_estimate_intake',
  'published_response_window',
  'storm_or_repair_workflow'
]);
const DiscoveryUnknownSchema = z.enum(DiscoveryUnknowns);

const PackProspectSchema = z
  .strictObject({
    id: RevenueIdSchema,
    businessLabel: SafeTextSchema,
    locationLabel: z.literal('Charlotte metro, NC'),
    contactPageUrl: DirectHttpsUrlSchema,
    status: z.literal('research_only'),
    qualification: z.strictObject({
      score: z.number().int().min(0).max(5),
      maximumScore: z.literal(5),
      publicSignals: z.array(PublicSignalSchema).min(3).max(5),
      discoveryUnknowns: z.array(DiscoveryUnknownSchema).length(DiscoveryUnknowns.length)
    }),
    provenanceUrls: z.array(DirectHttpsUrlSchema).min(1).max(4)
  })
  .superRefine((prospect, context) => {
    if (
      new Set(prospect.qualification.publicSignals).size !==
      prospect.qualification.publicSignals.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['qualification', 'publicSignals'],
        message: 'public signals must be unique'
      });
    }
    if (!sameStringSet(prospect.qualification.discoveryUnknowns, DiscoveryUnknowns)) {
      context.addIssue({
        code: 'custom',
        path: ['qualification', 'discoveryUnknowns'],
        message: 'discovery unknowns must match the reviewed rubric'
      });
    }
    if (!prospect.provenanceUrls.includes(prospect.contactPageUrl)) {
      context.addIssue({
        code: 'custom',
        path: ['provenanceUrls'],
        message: 'contact page must be retained as provenance'
      });
    }
  });

const FirstClientPackSchema = z
  .strictObject({
    schema: z.literal('jarvis.first-client-pack.v1'),
    asOf: z.iso.date(),
    purpose: z.literal('review_only_first_client_acquisition'),
    segment: z.strictObject({
      label: SafeTextSchema,
      buyerRoleHypothesis: SafeTextSchema,
      workflowHypothesis: SafeTextSchema,
      marketPainState: z.literal('unverified_until_discovery')
    }),
    offer: z.strictObject({
      name: z.literal('Daily Lead Triage Pilot'),
      blueprintMonthlyRange: z.strictObject({
        minimumUsd: z.literal(500),
        minimumMicrousd: z.literal(500_000_000),
        maximumUsd: z.literal(2_000),
        maximumMicrousd: z.literal(2_000_000_000)
      }),
      foundingPilot: z.strictObject({
        firstMonthUsd: z.literal(750),
        firstMonthMicrousd: z.literal(750_000_000),
        standardMonthlyUsd: z.literal(1_250),
        standardMonthlyMicrousd: z.literal(1_250_000_000),
        billing: z.literal('monthly_in_advance_after_signed_scope'),
        minimumTermMonths: z.literal(1),
        setupFeeUsd: z.literal(0),
        includedLeadSources: z.literal(1),
        includedDailyRuns: z.literal(31),
        includedRevisionRounds: z.literal(1),
        externalPaymentState: z.literal('blocked')
      })
    }),
    sendGate: z.strictObject({
      state: z.literal('blocked_pending_operator_review'),
      operatorApprovalRequired: z.literal(true),
      automationMaySend: z.literal(false),
      formsMayBeSubmitted: z.literal(false),
      callsMayBePlaced: z.literal(false),
      requiredApprovals: z.array(z.enum(ExpectedApprovals)).length(ExpectedApprovals.length)
    }),
    prospects: z.array(PackProspectSchema).length(10)
  })
  .superRefine((pack, context) => {
    if (!sameStringSet(pack.sendGate.requiredApprovals, ExpectedApprovals)) {
      context.addIssue({
        code: 'custom',
        path: ['sendGate', 'requiredApprovals'],
        message: 'send approvals must match the reviewed gate'
      });
    }
    if (new Set(pack.prospects.map(({ id }) => id)).size !== pack.prospects.length) {
      context.addIssue({
        code: 'custom',
        path: ['prospects'],
        message: 'prospect IDs must be unique'
      });
    }
    if (
      new Set(pack.prospects.map(({ contactPageUrl }) => contactPageUrl)).size !==
      pack.prospects.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['prospects'],
        message: 'prospect contact pages must be unique'
      });
    }
  });

type FirstClientPack = z.infer<typeof FirstClientPackSchema>;

export interface FirstClientBootstrapOptions {
  projectRoot: string;
  packPath: string;
  databaseFile?: string;
  apply?: boolean;
}

export interface FirstClientBootstrapResult {
  schema: 'jarvis.first-client-bootstrap-result.v1';
  mode: 'dry_run' | 'applied';
  pack: {
    asOf: string;
    prospectCount: number;
    deterministicSelection: {
      prospectId: string;
      score: number;
      tieBreak: typeof TIE_BREAK;
    };
  };
  ledger: {
    mutation: 'none' | 'local_sqlite_only';
    agency: {
      prospectsPlanned: number;
      prospectsSeededOrVerified: number;
      identifiedProspectsVerified: number;
      offersPersistedByBootstrap: 0;
      outreachDraftsPersistedByBootstrap: 0;
      proposedAmountMicrousdPersistedByBootstrap: 0;
    };
    taskMarket: {
      contractState: 'planned_simulation' | 'simulation';
      quotedAmountMicrousd: number;
      scenariosPlanned: number;
      scenariosSeededOrVerified: number;
      passEvidenceSeededOrVerified: number;
    };
    operatorQueue: {
      tenantId: typeof OPERATOR_TENANT_ID;
      tasksPlanned: number;
      tasksSeededOrVerified: number;
      queuedTasksVerified: number;
      payloadKinds: typeof OPERATOR_QUEUE_PAYLOAD_KINDS;
      automationPayloadsPersistedByBootstrap: 0;
      automationCycleEligibleTasks: 0;
    };
  };
  reviewGatePlans: {
    offer: {
      state: 'blocked_by_review_gate';
      prospectId: string;
      offerId: string;
      proposedAmountMicrousd: number;
      ledgerRowCreated: false;
      blockingRequirement: 'prospect_must_be_human_qualified';
    };
    outreachDraft: {
      state: 'blocked_by_review_gate';
      prospectId: string;
      offerId: string;
      draftId: string;
      channel: 'other';
      subjectLength: number;
      bodyLength: number;
      contentDigest: string;
      ledgerRowCreated: false;
      blockingRequirement: 'offer_must_be_human_reviewed';
    };
  };
  safety: typeof REVENUE_PIPELINE_SAFETY;
}

interface ReviewPlans {
  selectedProspectId: string;
  selectedScore: number;
  offerId: string;
  draftId: string;
  draftChannel: 'other';
  draftSubjectLength: number;
  draftBodyLength: number;
  draftContentDigest: string;
}

interface ApplyCounts {
  prospects: number;
  identifiedProspects: number;
  simulations: number;
  passingSimulations: number;
  queueTasks: number;
  queuedTasks: number;
}

/**
 * Validates and optionally seeds the review-only acquisition pack. This module
 * has filesystem and local SQLite capabilities only; it has no network,
 * messaging, payment, wallet, settlement, or revenue-recognition collaborator.
 */
export async function bootstrapFirstClientRevenue(
  options: FirstClientBootstrapOptions
): Promise<FirstClientBootstrapResult> {
  assertAbsoluteDirectPath(options.projectRoot, 'projectRoot');
  assertAbsoluteDirectPath(options.packPath, 'packPath');
  if (options.databaseFile !== undefined) {
    assertAbsoluteDirectPath(options.databaseFile, 'databaseFile');
  }

  const pack = await readFirstClientPack(options.packPath);
  const plans = buildReviewPlans(pack);
  const queuePlans = buildOperatorQueuePlans(pack);
  if (options.apply !== true) {
    return buildResult(pack, plans, 'dry_run');
  }
  if (options.databaseFile === undefined) {
    throw new Error('databaseFile is required for explicit apply');
  }

  await assertSafeLocalDatabase(options.databaseFile);
  const counts = await applyToLocalLedger(
    pack,
    plans,
    queuePlans,
    options.projectRoot,
    options.databaseFile
  );
  return buildResult(pack, plans, 'applied', counts);
}

async function readFirstClientPack(packPath: string): Promise<FirstClientPack> {
  let handle;
  try {
    handle = await open(packPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > MAX_PACK_BYTES) {
      throw new Error('First-client pack must be a bounded regular direct file');
    }
    const content = await handle.readFile('utf8');
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error('First-client pack changed while being read');
    }
    try {
      return FirstClientPackSchema.parse(JSON.parse(content) as unknown);
    } catch (error) {
      throw new Error('First-client pack failed strict validation', { cause: error });
    }
  } catch (error) {
    if (
      error instanceof Error &&
      /strict validation|changed while|bounded regular/.test(error.message)
    ) {
      throw error;
    }
    throw new Error('First-client pack must be a readable regular direct file', { cause: error });
  } finally {
    await handle?.close();
  }
}

function buildReviewPlans(pack: FirstClientPack): ReviewPlans {
  const selected = [...pack.prospects].sort(
    (left, right) =>
      right.qualification.score - left.qualification.score ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  )[0];
  if (selected === undefined) throw new Error('First-client pack has no deterministic prospect');

  const createdAt = packTimestamp(pack.asOf, 0);
  const offerId = `offer_${selected.id}_pilot`;
  const draftId = `draft_${selected.id}_intro`;
  const offer = CreateOfferInputSchema.parse({
    id: offerId,
    prospectId: selected.id,
    lane: 'agency',
    title: 'Daily Lead Triage Founding Pilot',
    deliverable: 'workflow_pilot',
    proposedAmountMicrousd: OFFER_AMOUNT_MICROUSD,
    turnaroundHours: 168,
    revisionLimit: 1,
    actorId: BOOTSTRAP_ACTOR,
    createdAt
  });
  const draft = CreateOutreachDraftInputSchema.parse({
    id: draftId,
    prospectId: selected.id,
    offerId: offer.id,
    lane: 'agency',
    channel: 'other',
    subject: `Daily Lead Triage Pilot for ${selected.businessLabel}`,
    body: [
      'Internal draft only. Ask whether manual lead sorting is a verified problem before proposing',
      'the bounded founding pilot. No sending, form submission, customer contact, payment, or',
      'revenue claim is authorized by this draft.'
    ].join(' '),
    actorId: BOOTSTRAP_ACTOR,
    createdAt
  });
  if (draft.channel !== 'other') {
    throw new Error('First-client internal draft channel must remain other');
  }

  return {
    selectedProspectId: selected.id,
    selectedScore: selected.qualification.score,
    offerId: offer.id,
    draftId: draft.id,
    draftChannel: draft.channel,
    draftSubjectLength: draft.subject.length,
    draftBodyLength: draft.body.length,
    draftContentDigest: sha256(`${draft.subject}\n${draft.body}`)
  };
}

function buildOperatorQueuePlans(pack: FirstClientPack): QueueTaskInput[] {
  return [
    QueueTaskInputSchema.parse({
      id: 'first_client_offer_review',
      tenantId: OPERATOR_TENANT_ID,
      lane: 'agency',
      source: {
        kind: 'operator',
        id: 'bootstrap:first-client-offer-review',
        occurredAt: packTimestamp(pack.asOf, 5)
      },
      payload: {
        kind: 'operator_gate',
        gateType: 'approval',
        subjectRef: 'first-client-review-gate'
      },
      policy: { band: 'P2', impact: 8, urgency: 7, effort: 2 },
      dependencies: []
    }),
    QueueTaskInputSchema.parse({
      id: 'x402_simulation_testnet_review',
      tenantId: OPERATOR_TENANT_ID,
      lane: 'task_market',
      source: {
        kind: 'project',
        id: 'bootstrap:x402-simulation-review',
        occurredAt: packTimestamp(pack.asOf, 6)
      },
      payload: {
        kind: 'project_task',
        projectId: 'x402_task_market',
        taskType: 'review',
        artifactRef: 'x402:simulation-evidence-v1'
      },
      policy: { band: 'P2', impact: 7, urgency: 5, effort: 3 },
      dependencies: []
    })
  ];
}

async function applyToLocalLedger(
  pack: FirstClientPack,
  plans: ReviewPlans,
  queuePlans: QueueTaskInput[],
  projectRoot: string,
  databaseFile: string
): Promise<ApplyCounts> {
  const context = await createDatabase({ projectRoot, filename: databaseFile });
  try {
    const revenueRepository = new RevenuePipelineRepository(context.db);
    const queueRepository = new PriorityQueueRepository(context.db);
    let identifiedProspects = 0;
    for (const prospect of pack.prospects) {
      const created = await revenueRepository.createProspect(
        CreateProspectInputSchema.parse({
          id: prospect.id,
          lane: 'agency',
          publicLabel: prospect.businessLabel,
          contactChannel: 'other',
          contactReference: `contact:${prospect.id}`,
          source: 'operator_research',
          need: 'agency_workflow_pilot',
          actorId: BOOTSTRAP_ACTOR,
          createdAt: packTimestamp(pack.asOf, 0)
        })
      );
      if (created.status !== 'identified') {
        throw new Error(`Bootstrap prospect ${created.id} must remain identified`);
      }
      identifiedProspects += 1;
    }

    const contractInput = InitializeTaskMarketContractInputSchema.parse({
      productId: TASK_PRODUCT_ID,
      a2aVersion: A2A_VERSION,
      skillId: TASK_SKILL_ID,
      inputContract: 'bounded_numeric_series',
      outputContract: 'validation_verdict',
      x402Scheme: 'exact',
      quotedAmountMicrousd: TASK_QUOTE_MICROUSD,
      actorId: BOOTSTRAP_ACTOR,
      createdAt: packTimestamp(pack.asOf, 0)
    });
    let activation = await revenueRepository.initializeTaskMarketContract(contractInput);
    if (activation.state === 'contract_only') {
      activation = await revenueRepository.enableTaskMarketSimulation({
        expectedVersion: activation.version,
        actorId: BOOTSTRAP_ACTOR,
        changedAt: packTimestamp(pack.asOf, 1)
      });
    }
    if (
      activation.state !== 'simulation' ||
      activation.x402.quote.amountMicrousd !== TASK_QUOTE_MICROUSD
    ) {
      throw new Error('Task-market bootstrap must remain exact simulation only');
    }

    const simulations = [];
    for (const [index, scenario] of SimulationScenarios.entries()) {
      const requestDigest = sha256(
        JSON.stringify({
          schema: 'jarvis.task-market-bootstrap-request.v1',
          scenario,
          quotedAmountMicrousd: TASK_QUOTE_MICROUSD
        })
      );
      const evidenceDigest = sha256(
        JSON.stringify({
          schema: 'jarvis.task-market-bootstrap-evidence.v1',
          scenario,
          outcome: 'pass',
          externalPayment: 'blocked',
          revenueRecognition: 'none'
        })
      );
      simulations.push(
        await revenueRepository.recordTaskMarketSimulation(
          RecordTaskMarketSimulationInputSchema.parse({
            id: simulationId(scenario),
            activationVersion: activation.version,
            scenario,
            outcome: 'pass',
            requestDigest,
            evidenceDigest,
            actorId: BOOTSTRAP_ACTOR,
            recordedAt: packTimestamp(pack.asOf, index + 2)
          })
        )
      );
    }

    const queueReceipts = [];
    for (const queuePlan of queuePlans) {
      const receipt = await queueRepository.enqueue(queuePlan);
      if (
        receipt.tenantId !== OPERATOR_TENANT_ID ||
        receipt.state !== 'queued' ||
        receipt.payloadKind === 'automation'
      ) {
        throw new Error(`Bootstrap queue task ${receipt.id} must remain queued for review`);
      }
      queueReceipts.push(receipt);
    }

    // The plans are deliberately validated above but never passed to a ledger writer.
    void plans;
    return {
      prospects: pack.prospects.length,
      identifiedProspects,
      simulations: simulations.length,
      passingSimulations: simulations.filter(({ outcome }) => outcome === 'pass').length,
      queueTasks: queueReceipts.length,
      queuedTasks: queueReceipts.filter(({ state }) => state === 'queued').length
    };
  } finally {
    await context.destroy();
  }
}

function buildResult(
  pack: FirstClientPack,
  plans: ReviewPlans,
  mode: 'dry_run' | 'applied',
  counts?: ApplyCounts
): FirstClientBootstrapResult {
  const applied = mode === 'applied';
  return {
    schema: 'jarvis.first-client-bootstrap-result.v1',
    mode,
    pack: {
      asOf: pack.asOf,
      prospectCount: pack.prospects.length,
      deterministicSelection: {
        prospectId: plans.selectedProspectId,
        score: plans.selectedScore,
        tieBreak: TIE_BREAK
      }
    },
    ledger: {
      mutation: applied ? 'local_sqlite_only' : 'none',
      agency: {
        prospectsPlanned: pack.prospects.length,
        prospectsSeededOrVerified: counts?.prospects ?? 0,
        identifiedProspectsVerified: counts?.identifiedProspects ?? 0,
        offersPersistedByBootstrap: 0,
        outreachDraftsPersistedByBootstrap: 0,
        proposedAmountMicrousdPersistedByBootstrap: 0
      },
      taskMarket: {
        contractState: applied ? 'simulation' : 'planned_simulation',
        quotedAmountMicrousd: TASK_QUOTE_MICROUSD,
        scenariosPlanned: SimulationScenarios.length,
        scenariosSeededOrVerified: counts?.simulations ?? 0,
        passEvidenceSeededOrVerified: counts?.passingSimulations ?? 0
      },
      operatorQueue: {
        tenantId: OPERATOR_TENANT_ID,
        tasksPlanned: OPERATOR_QUEUE_PAYLOAD_KINDS.length,
        tasksSeededOrVerified: counts?.queueTasks ?? 0,
        queuedTasksVerified: counts?.queuedTasks ?? 0,
        payloadKinds: OPERATOR_QUEUE_PAYLOAD_KINDS,
        automationPayloadsPersistedByBootstrap: 0,
        automationCycleEligibleTasks: 0
      }
    },
    reviewGatePlans: {
      offer: {
        state: 'blocked_by_review_gate',
        prospectId: plans.selectedProspectId,
        offerId: plans.offerId,
        proposedAmountMicrousd: OFFER_AMOUNT_MICROUSD,
        ledgerRowCreated: false,
        blockingRequirement: 'prospect_must_be_human_qualified'
      },
      outreachDraft: {
        state: 'blocked_by_review_gate',
        prospectId: plans.selectedProspectId,
        offerId: plans.offerId,
        draftId: plans.draftId,
        channel: plans.draftChannel,
        subjectLength: plans.draftSubjectLength,
        bodyLength: plans.draftBodyLength,
        contentDigest: plans.draftContentDigest,
        ledgerRowCreated: false,
        blockingRequirement: 'offer_must_be_human_reviewed'
      }
    },
    safety: REVENUE_PIPELINE_SAFETY
  };
}

async function assertSafeLocalDatabase(databaseFile: string): Promise<void> {
  try {
    const metadata = await lstat(databaseFile);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error('databaseFile must be a regular direct local file');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function assertAbsoluteDirectPath(value: string, name: string): void {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${name} must be an absolute direct path`);
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

function packTimestamp(date: string, seconds: number): string {
  const timestamp = new Date(`${date}T00:00:00.000Z`);
  timestamp.setUTCSeconds(seconds);
  return timestamp.toISOString();
}

function simulationId(scenario: TaskMarketSimulationScenario): string {
  switch (scenario) {
    case 'authorization_accepted':
      return 'sim_first_client_authorized';
    case 'authorization_rejected':
      return 'sim_first_client_rejected';
    case 'duplicate_replay':
      return 'sim_first_client_duplicate';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
