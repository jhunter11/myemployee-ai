import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { Kysely, Selectable, Transaction } from 'kysely';
import { z } from 'zod';

import {
  ContactChannelSchema,
  CreateOfferInputSchema,
  CreateOutreachDraftInputSchema,
  CreateProspectInputSchema,
  EnableTaskMarketSimulationInputSchema,
  InitializeTaskMarketContractInputSchema,
  InternalReviewStatusSchema,
  OfferDeliverableSchema,
  ProspectNeedSchema,
  ProspectSourceSchema,
  ProspectStatusSchema,
  RecordTaskMarketSimulationInputSchema,
  REVENUE_PIPELINE_SAFETY,
  RevenueEventReadSchema,
  RevenueLaneReadSchema,
  RevenueLaneSchema,
  TaskMarketActivationStateSchema,
  TaskMarketSimulationOutcomeSchema,
  TaskMarketSimulationScenarioSchema,
  TransitionOfferInputSchema,
  TransitionOutreachDraftInputSchema,
  TransitionProspectInputSchema,
  type CreateOfferInput,
  type CreateOutreachDraftInput,
  type CreateProspectInput,
  type EnableTaskMarketSimulationInput,
  type InitializeTaskMarketContractInput,
  type RecordTaskMarketSimulationInput,
  type RedactedOffer,
  type RedactedOutreachDraft,
  type RedactedProspect,
  type RedactedRevenueEvent,
  type RedactedTaskMarketActivation,
  type RedactedTaskMarketSimulation,
  type RevenueLaneSnapshot,
  type TransitionOfferInput,
  type TransitionOutreachDraftInput,
  type TransitionProspectInput
} from '../revenue/contracts';
import type {
  JarvisDatabase,
  RevenueOffersTable,
  RevenueOutreachDraftsTable,
  RevenueProspectsTable,
  TaskMarketActivationTable,
  TaskMarketSimulationsTable
} from './types';

type RevenueEntityType = RedactedRevenueEvent['entityType'];
type RevenueEventType = RedactedRevenueEvent['eventType'];

interface EventInput {
  lane: 'agency' | 'task_market';
  entityType: RevenueEntityType;
  entityId: string;
  eventType: RevenueEventType;
  fromStatus: string | null;
  toStatus: string;
  entityVersion: number;
  actorId: string;
  occurredAt: string;
  detail: Record<string, string | number | boolean>;
}

function canonicalTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const AggregateCountSchema = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

function safeCount(value: unknown): number {
  return AggregateCountSchema.parse(value);
}

function redactedProspect(row: Selectable<RevenueProspectsTable>): RedactedProspect {
  return {
    id: row.id,
    lane: RevenueLaneSchema.parse(row.lane),
    publicLabel: row.public_label,
    contactChannel: ContactChannelSchema.parse(row.contact_channel),
    hasContactReference: row.contact_reference !== null,
    source: ProspectSourceSchema.parse(row.source),
    need: ProspectNeedSchema.parse(row.need),
    status: ProspectStatusSchema.parse(row.status),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function redactedOffer(row: Selectable<RevenueOffersTable>): RedactedOffer {
  return {
    id: row.id,
    prospectId: row.prospect_id,
    lane: RevenueLaneSchema.parse(row.lane),
    title: row.title,
    deliverable: OfferDeliverableSchema.parse(row.deliverable),
    quote: {
      basis: 'proposed',
      currency: 'USD',
      amountMicrousd: row.proposed_amount_microusd
    },
    turnaroundHours: row.turnaround_hours,
    revisionLimit: row.revision_limit,
    status: InternalReviewStatusSchema.parse(row.status),
    version: row.version,
    externalPayment: 'blocked',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function redactedDraft(row: Selectable<RevenueOutreachDraftsTable>): RedactedOutreachDraft {
  return {
    id: row.id,
    prospectId: row.prospect_id,
    offerId: row.offer_id,
    lane: RevenueLaneSchema.parse(row.lane),
    channel: ContactChannelSchema.parse(row.channel),
    status: InternalReviewStatusSchema.parse(row.status),
    version: row.version,
    subjectLength: row.subject.length,
    bodyLength: row.body.length,
    contentDigest: row.content_sha256,
    externalDelivery: 'blocked',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function redactedActivation(
  row: Selectable<TaskMarketActivationTable>
): RedactedTaskMarketActivation {
  return {
    lane: 'task_market',
    productId: row.product_id,
    state: TaskMarketActivationStateSchema.parse(row.activation_state),
    version: row.version,
    contractDigest: row.contract_sha256,
    a2a: {
      version: row.a2a_version,
      skillId: row.a2a_skill_id,
      inputContract: 'bounded_numeric_series',
      outputContract: 'validation_verdict'
    },
    x402: {
      scheme: 'exact',
      quote: {
        basis: 'simulation',
        currency: 'USD',
        amountMicrousd: row.quoted_amount_microusd
      },
      paymentMode: row.payment_mode === 'simulated' ? 'simulated' : 'blocked'
    },
    safety: REVENUE_PIPELINE_SAFETY,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function redactedSimulation(
  row: Selectable<TaskMarketSimulationsTable>
): RedactedTaskMarketSimulation {
  return {
    id: row.id,
    activationVersion: row.activation_version,
    scenario: TaskMarketSimulationScenarioSchema.parse(row.scenario),
    outcome: TaskMarketSimulationOutcomeSchema.parse(row.outcome),
    requestDigest: row.request_sha256,
    evidenceDigest: row.evidence_sha256,
    quote: {
      basis: 'simulation',
      currency: 'USD',
      amountMicrousd: row.quoted_amount_microusd
    },
    externalPayment: 'blocked',
    revenueRecognition: 'none',
    recordedAt: row.recorded_at
  };
}

function normalizedProspect(input: CreateProspectInput): CreateProspectInput {
  return { ...input, createdAt: canonicalTimestamp(input.createdAt) };
}

function normalizedOffer(input: CreateOfferInput): CreateOfferInput {
  return { ...input, createdAt: canonicalTimestamp(input.createdAt) };
}

function normalizedDraft(input: CreateOutreachDraftInput): CreateOutreachDraftInput {
  return {
    ...input,
    subject: input.subject.trim(),
    body: input.body.trim(),
    createdAt: canonicalTimestamp(input.createdAt)
  };
}

function normalizedContract(
  input: InitializeTaskMarketContractInput
): InitializeTaskMarketContractInput {
  return { ...input, createdAt: canonicalTimestamp(input.createdAt) };
}

function contractDigest(input: InitializeTaskMarketContractInput): string {
  return sha256(
    JSON.stringify({
      productId: input.productId,
      a2a: {
        version: input.a2aVersion,
        skillId: input.skillId,
        inputContract: input.inputContract,
        outputContract: input.outputContract
      },
      x402: {
        scheme: input.x402Scheme,
        currency: 'USD',
        quotedAmountMicrousd: input.quotedAmountMicrousd
      }
    })
  );
}

function storedProspectContract(row: Selectable<RevenueProspectsTable>) {
  return {
    id: row.id,
    lane: row.lane,
    publicLabel: row.public_label,
    contactChannel: row.contact_channel,
    contactReference: row.contact_reference,
    source: row.source,
    need: row.need,
    createdAt: row.created_at
  };
}

function prospectContract(input: CreateProspectInput) {
  return {
    id: input.id,
    lane: input.lane,
    publicLabel: input.publicLabel,
    contactChannel: input.contactChannel,
    contactReference: input.contactReference,
    source: input.source,
    need: input.need,
    createdAt: input.createdAt
  };
}

function storedOfferContract(row: Selectable<RevenueOffersTable>) {
  return {
    id: row.id,
    prospectId: row.prospect_id,
    lane: row.lane,
    title: row.title,
    deliverable: row.deliverable,
    proposedAmountMicrousd: row.proposed_amount_microusd,
    turnaroundHours: row.turnaround_hours,
    revisionLimit: row.revision_limit,
    createdAt: row.created_at
  };
}

function offerContract(input: CreateOfferInput) {
  return {
    id: input.id,
    prospectId: input.prospectId,
    lane: input.lane,
    title: input.title,
    deliverable: input.deliverable,
    proposedAmountMicrousd: input.proposedAmountMicrousd,
    turnaroundHours: input.turnaroundHours,
    revisionLimit: input.revisionLimit,
    createdAt: input.createdAt
  };
}

function storedDraftContract(row: Selectable<RevenueOutreachDraftsTable>) {
  return {
    id: row.id,
    prospectId: row.prospect_id,
    offerId: row.offer_id,
    lane: row.lane,
    channel: row.channel,
    subject: row.subject,
    body: row.body,
    createdAt: row.created_at
  };
}

function draftContract(input: CreateOutreachDraftInput) {
  return {
    id: input.id,
    prospectId: input.prospectId,
    offerId: input.offerId,
    lane: input.lane,
    channel: input.channel,
    subject: input.subject,
    body: input.body,
    createdAt: input.createdAt
  };
}

export class RevenuePipelineRepository {
  constructor(private readonly db: Kysely<JarvisDatabase>) {}

  async createProspect(input: CreateProspectInput): Promise<RedactedProspect> {
    const prospect = normalizedProspect(CreateProspectInputSchema.parse(input));
    return this.db.transaction().execute(async (transaction) => {
      const inserted = await transaction
        .insertInto('revenue_prospects')
        .values({
          id: prospect.id,
          lane: prospect.lane,
          public_label: prospect.publicLabel,
          contact_channel: prospect.contactChannel,
          contact_reference: prospect.contactReference,
          source: prospect.source,
          need: prospect.need,
          status: 'identified',
          version: 1,
          created_at: prospect.createdAt,
          updated_at: prospect.createdAt
        })
        .onConflict((conflict) => conflict.column('id').doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted === undefined) {
        const existing = await transaction
          .selectFrom('revenue_prospects')
          .selectAll()
          .where('id', '=', prospect.id)
          .executeTakeFirstOrThrow();
        if (!isDeepStrictEqual(storedProspectContract(existing), prospectContract(prospect))) {
          throw new Error(`Revenue prospect ${prospect.id} already exists with different details`);
        }
        return redactedProspect(existing);
      }
      await this.appendEvent(transaction, {
        lane: prospect.lane,
        entityType: 'prospect',
        entityId: prospect.id,
        eventType: 'created',
        fromStatus: null,
        toStatus: 'identified',
        entityVersion: 1,
        actorId: prospect.actorId,
        occurredAt: prospect.createdAt,
        detail: { contactChannel: prospect.contactChannel, need: prospect.need }
      });
      return redactedProspect(inserted);
    });
  }

  async transitionProspect(input: TransitionProspectInput): Promise<RedactedProspect> {
    const transition = TransitionProspectInputSchema.parse(input);
    const changedAt = canonicalTimestamp(transition.changedAt);
    return this.db.transaction().execute(async (transaction) => {
      const current = await transaction
        .selectFrom('revenue_prospects')
        .selectAll()
        .where('id', '=', transition.id)
        .executeTakeFirst();
      this.assertCurrentVersion(
        'Revenue prospect',
        transition.id,
        current,
        transition.expectedVersion
      );
      const updated = await transaction
        .updateTable('revenue_prospects')
        .set({
          status: transition.status,
          version: transition.expectedVersion + 1,
          updated_at: changedAt
        })
        .where('id', '=', transition.id)
        .where('version', '=', transition.expectedVersion)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.appendEvent(transaction, {
        lane: RevenueLaneSchema.parse(current.lane),
        entityType: 'prospect',
        entityId: transition.id,
        eventType: 'status_changed',
        fromStatus: current.status,
        toStatus: transition.status,
        entityVersion: updated.version,
        actorId: transition.actorId,
        occurredAt: changedAt,
        detail: {}
      });
      return redactedProspect(updated);
    });
  }

  async createOffer(input: CreateOfferInput): Promise<RedactedOffer> {
    const offer = normalizedOffer(CreateOfferInputSchema.parse(input));
    return this.db.transaction().execute(async (transaction) => {
      const inserted = await transaction
        .insertInto('revenue_offers')
        .values({
          id: offer.id,
          prospect_id: offer.prospectId,
          lane: offer.lane,
          title: offer.title,
          deliverable: offer.deliverable,
          proposed_amount_microusd: offer.proposedAmountMicrousd,
          currency: 'USD',
          turnaround_hours: offer.turnaroundHours,
          revision_limit: offer.revisionLimit,
          status: 'draft',
          version: 1,
          created_at: offer.createdAt,
          updated_at: offer.createdAt
        })
        .onConflict((conflict) => conflict.column('id').doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted === undefined) {
        const existing = await transaction
          .selectFrom('revenue_offers')
          .selectAll()
          .where('id', '=', offer.id)
          .executeTakeFirstOrThrow();
        if (!isDeepStrictEqual(storedOfferContract(existing), offerContract(offer))) {
          throw new Error(`Revenue offer ${offer.id} already exists with different details`);
        }
        return redactedOffer(existing);
      }
      await this.appendEvent(transaction, {
        lane: offer.lane,
        entityType: 'offer',
        entityId: offer.id,
        eventType: 'created',
        fromStatus: null,
        toStatus: 'draft',
        entityVersion: 1,
        actorId: offer.actorId,
        occurredAt: offer.createdAt,
        detail: {
          deliverable: offer.deliverable,
          proposedAmountMicrousd: offer.proposedAmountMicrousd
        }
      });
      return redactedOffer(inserted);
    });
  }

  async transitionOffer(input: TransitionOfferInput): Promise<RedactedOffer> {
    const transition = TransitionOfferInputSchema.parse(input);
    const changedAt = canonicalTimestamp(transition.changedAt);
    return this.db.transaction().execute(async (transaction) => {
      const current = await transaction
        .selectFrom('revenue_offers')
        .selectAll()
        .where('id', '=', transition.id)
        .executeTakeFirst();
      this.assertCurrentVersion(
        'Revenue offer',
        transition.id,
        current,
        transition.expectedVersion
      );
      const updated = await transaction
        .updateTable('revenue_offers')
        .set({
          status: transition.status,
          version: transition.expectedVersion + 1,
          updated_at: changedAt
        })
        .where('id', '=', transition.id)
        .where('version', '=', transition.expectedVersion)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.appendEvent(transaction, {
        lane: RevenueLaneSchema.parse(current.lane),
        entityType: 'offer',
        entityId: transition.id,
        eventType: 'status_changed',
        fromStatus: current.status,
        toStatus: transition.status,
        entityVersion: updated.version,
        actorId: transition.actorId,
        occurredAt: changedAt,
        detail: {}
      });
      return redactedOffer(updated);
    });
  }

  async createOutreachDraft(input: CreateOutreachDraftInput): Promise<RedactedOutreachDraft> {
    const draft = normalizedDraft(CreateOutreachDraftInputSchema.parse(input));
    const contentDigest = sha256(`${draft.subject}\n${draft.body}`);
    return this.db.transaction().execute(async (transaction) => {
      const inserted = await transaction
        .insertInto('revenue_outreach_drafts')
        .values({
          id: draft.id,
          prospect_id: draft.prospectId,
          offer_id: draft.offerId,
          lane: draft.lane,
          channel: draft.channel,
          subject: draft.subject,
          body: draft.body,
          content_sha256: contentDigest,
          status: 'draft',
          version: 1,
          created_at: draft.createdAt,
          updated_at: draft.createdAt
        })
        .onConflict((conflict) => conflict.column('id').doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted === undefined) {
        const existing = await transaction
          .selectFrom('revenue_outreach_drafts')
          .selectAll()
          .where('id', '=', draft.id)
          .executeTakeFirstOrThrow();
        if (!isDeepStrictEqual(storedDraftContract(existing), draftContract(draft))) {
          throw new Error(`Outreach draft ${draft.id} already exists with different content`);
        }
        return redactedDraft(existing);
      }
      await this.appendEvent(transaction, {
        lane: draft.lane,
        entityType: 'outreach_draft',
        entityId: draft.id,
        eventType: 'created',
        fromStatus: null,
        toStatus: 'draft',
        entityVersion: 1,
        actorId: draft.actorId,
        occurredAt: draft.createdAt,
        detail: {
          channel: draft.channel,
          subjectLength: draft.subject.length,
          bodyLength: draft.body.length
        }
      });
      return redactedDraft(inserted);
    });
  }

  async transitionOutreachDraft(
    input: TransitionOutreachDraftInput
  ): Promise<RedactedOutreachDraft> {
    const transition = TransitionOutreachDraftInputSchema.parse(input);
    const changedAt = canonicalTimestamp(transition.changedAt);
    return this.db.transaction().execute(async (transaction) => {
      const current = await transaction
        .selectFrom('revenue_outreach_drafts')
        .selectAll()
        .where('id', '=', transition.id)
        .executeTakeFirst();
      this.assertCurrentVersion(
        'Outreach draft',
        transition.id,
        current,
        transition.expectedVersion
      );
      const updated = await transaction
        .updateTable('revenue_outreach_drafts')
        .set({
          status: transition.status,
          version: transition.expectedVersion + 1,
          updated_at: changedAt
        })
        .where('id', '=', transition.id)
        .where('version', '=', transition.expectedVersion)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.appendEvent(transaction, {
        lane: RevenueLaneSchema.parse(current.lane),
        entityType: 'outreach_draft',
        entityId: transition.id,
        eventType: 'status_changed',
        fromStatus: current.status,
        toStatus: transition.status,
        entityVersion: updated.version,
        actorId: transition.actorId,
        occurredAt: changedAt,
        detail: {}
      });
      return redactedDraft(updated);
    });
  }

  async initializeTaskMarketContract(
    input: InitializeTaskMarketContractInput
  ): Promise<RedactedTaskMarketActivation> {
    const contract = normalizedContract(InitializeTaskMarketContractInputSchema.parse(input));
    const digest = contractDigest(contract);
    return this.db.transaction().execute(async (transaction) => {
      const inserted = await transaction
        .insertInto('task_market_activation')
        .values({
          id: 'task_market',
          product_id: contract.productId,
          a2a_version: contract.a2aVersion,
          a2a_skill_id: contract.skillId,
          input_contract: contract.inputContract,
          output_contract: contract.outputContract,
          contract_sha256: digest,
          x402_scheme: contract.x402Scheme,
          quoted_amount_microusd: contract.quotedAmountMicrousd,
          currency: 'USD',
          activation_state: 'contract_only',
          network_mode: 'none',
          payment_mode: 'blocked',
          wallet_mode: 'forbidden',
          version: 1,
          created_at: contract.createdAt,
          updated_at: contract.createdAt
        })
        .onConflict((conflict) => conflict.column('id').doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted === undefined) {
        const existing = await transaction
          .selectFrom('task_market_activation')
          .selectAll()
          .where('id', '=', 'task_market')
          .executeTakeFirstOrThrow();
        const sameContract =
          existing.product_id === contract.productId &&
          existing.a2a_version === contract.a2aVersion &&
          existing.a2a_skill_id === contract.skillId &&
          existing.input_contract === contract.inputContract &&
          existing.output_contract === contract.outputContract &&
          existing.x402_scheme === contract.x402Scheme &&
          existing.quoted_amount_microusd === contract.quotedAmountMicrousd &&
          existing.contract_sha256 === digest &&
          existing.created_at === contract.createdAt;
        if (!sameContract) {
          throw new Error('Task-market activation already exists with a different contract');
        }
        return redactedActivation(existing);
      }
      await this.appendEvent(transaction, {
        lane: 'task_market',
        entityType: 'task_market_activation',
        entityId: 'task_market',
        eventType: 'created',
        fromStatus: null,
        toStatus: 'contract_only',
        entityVersion: 1,
        actorId: contract.actorId,
        occurredAt: contract.createdAt,
        detail: { productId: contract.productId, contractDigest: digest }
      });
      return redactedActivation(inserted);
    });
  }

  async enableTaskMarketSimulation(
    input: EnableTaskMarketSimulationInput
  ): Promise<RedactedTaskMarketActivation> {
    const transition = EnableTaskMarketSimulationInputSchema.parse(input);
    const changedAt = canonicalTimestamp(transition.changedAt);
    return this.db.transaction().execute(async (transaction) => {
      const current = await transaction
        .selectFrom('task_market_activation')
        .selectAll()
        .where('id', '=', 'task_market')
        .executeTakeFirst();
      this.assertCurrentVersion(
        'Task-market activation',
        'task_market',
        current,
        transition.expectedVersion
      );
      const updated = await transaction
        .updateTable('task_market_activation')
        .set({
          activation_state: 'simulation',
          payment_mode: 'simulated',
          version: transition.expectedVersion + 1,
          updated_at: changedAt
        })
        .where('id', '=', 'task_market')
        .where('version', '=', transition.expectedVersion)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.appendEvent(transaction, {
        lane: 'task_market',
        entityType: 'task_market_activation',
        entityId: 'task_market',
        eventType: 'status_changed',
        fromStatus: current.activation_state,
        toStatus: 'simulation',
        entityVersion: updated.version,
        actorId: transition.actorId,
        occurredAt: changedAt,
        detail: { paymentMode: 'simulated', networkMode: 'none' }
      });
      return redactedActivation(updated);
    });
  }

  async recordTaskMarketSimulation(
    input: RecordTaskMarketSimulationInput
  ): Promise<RedactedTaskMarketSimulation> {
    const evidence = RecordTaskMarketSimulationInputSchema.parse(input);
    const recordedAt = canonicalTimestamp(evidence.recordedAt);
    return this.db.transaction().execute(async (transaction) => {
      const activation = await transaction
        .selectFrom('task_market_activation')
        .selectAll()
        .where('id', '=', 'task_market')
        .executeTakeFirst();
      if (
        activation === undefined ||
        activation.activation_state !== 'simulation' ||
        activation.version !== evidence.activationVersion
      ) {
        throw new Error('Task-market simulation activation does not match evidence');
      }
      const inserted = await transaction
        .insertInto('task_market_simulations')
        .values({
          id: evidence.id,
          activation_id: 'task_market',
          activation_version: evidence.activationVersion,
          scenario: evidence.scenario,
          outcome: evidence.outcome,
          request_sha256: evidence.requestDigest,
          evidence_sha256: evidence.evidenceDigest,
          quoted_amount_microusd: activation.quoted_amount_microusd,
          currency: 'USD',
          simulation_only: 1,
          recorded_at: recordedAt
        })
        .onConflict((conflict) => conflict.column('id').doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted === undefined) {
        const existing = await transaction
          .selectFrom('task_market_simulations')
          .selectAll()
          .where('id', '=', evidence.id)
          .executeTakeFirstOrThrow();
        const sameEvidence =
          existing.activation_version === evidence.activationVersion &&
          existing.scenario === evidence.scenario &&
          existing.outcome === evidence.outcome &&
          existing.request_sha256 === evidence.requestDigest &&
          existing.evidence_sha256 === evidence.evidenceDigest &&
          existing.recorded_at === recordedAt;
        if (!sameEvidence) {
          throw new Error(
            `Task-market simulation ${evidence.id} already exists with different evidence`
          );
        }
        return redactedSimulation(existing);
      }
      await this.appendEvent(transaction, {
        lane: 'task_market',
        entityType: 'task_market_simulation',
        entityId: evidence.id,
        eventType: 'simulation_recorded',
        fromStatus: null,
        toStatus: evidence.outcome,
        entityVersion: evidence.activationVersion,
        actorId: evidence.actorId,
        occurredAt: recordedAt,
        detail: { scenario: evidence.scenario, simulationOnly: true }
      });
      return redactedSimulation(inserted);
    });
  }

  async readLaneSnapshot(input: {
    lane: 'agency' | 'task_market';
    limit: number;
  }): Promise<RevenueLaneSnapshot> {
    const query = RevenueLaneReadSchema.parse(input);
    const prospectCountQuery = this.db
      .selectFrom('revenue_prospects')
      .select((expression) => expression.fn.countAll<number>().as('count'))
      .where('lane', '=', query.lane);
    const offerCountQuery = this.db
      .selectFrom('revenue_offers')
      .select((expression) => expression.fn.countAll<number>().as('count'))
      .where('lane', '=', query.lane);
    const draftCountQuery = this.db
      .selectFrom('revenue_outreach_drafts')
      .select((expression) => expression.fn.countAll<number>().as('count'))
      .where('lane', '=', query.lane);
    const simulationCountQuery = this.db
      .selectFrom('task_market_simulations')
      .select((expression) => expression.fn.countAll<number>().as('count'));
    const [prospectCount, offerCount, draftCount, prospects, offers, drafts] = await Promise.all([
      prospectCountQuery.executeTakeFirstOrThrow(),
      offerCountQuery.executeTakeFirstOrThrow(),
      draftCountQuery.executeTakeFirstOrThrow(),
      this.db
        .selectFrom('revenue_prospects')
        .selectAll()
        .where('lane', '=', query.lane)
        .orderBy('updated_at', 'desc')
        .orderBy('id', 'asc')
        .limit(query.limit)
        .execute(),
      this.db
        .selectFrom('revenue_offers')
        .selectAll()
        .where('lane', '=', query.lane)
        .orderBy('updated_at', 'desc')
        .orderBy('id', 'asc')
        .limit(query.limit)
        .execute(),
      this.db
        .selectFrom('revenue_outreach_drafts')
        .selectAll()
        .where('lane', '=', query.lane)
        .orderBy('updated_at', 'desc')
        .orderBy('id', 'asc')
        .limit(query.limit)
        .execute()
    ]);

    let activation: RedactedTaskMarketActivation | null = null;
    let simulations: RedactedTaskMarketSimulation[] = [];
    let simulationCount = 0;
    if (query.lane === 'task_market') {
      const [activationRow, simulationRows, count] = await Promise.all([
        this.db
          .selectFrom('task_market_activation')
          .selectAll()
          .where('id', '=', 'task_market')
          .executeTakeFirst(),
        this.db
          .selectFrom('task_market_simulations')
          .selectAll()
          .orderBy('recorded_at', 'desc')
          .orderBy('id', 'asc')
          .limit(query.limit)
          .execute(),
        simulationCountQuery.executeTakeFirstOrThrow()
      ]);
      activation = activationRow === undefined ? null : redactedActivation(activationRow);
      simulations = simulationRows.map(redactedSimulation);
      simulationCount = safeCount(count.count);
    }

    return {
      lane: query.lane,
      counts: {
        prospects: safeCount(prospectCount.count),
        offers: safeCount(offerCount.count),
        outreachDrafts: safeCount(draftCount.count),
        simulations: simulationCount
      },
      prospects: prospects.map(redactedProspect),
      offers: offers.map(redactedOffer),
      outreachDrafts: drafts.map(redactedDraft),
      simulations,
      activation,
      safety: REVENUE_PIPELINE_SAFETY
    };
  }

  async readEvents(input: {
    lane: 'agency' | 'task_market';
    limit: number;
  }): Promise<RedactedRevenueEvent[]> {
    const query = RevenueEventReadSchema.parse(input);
    const rows = await this.db
      .selectFrom('revenue_pipeline_events')
      .select([
        'sequence',
        'lane',
        'entity_type',
        'entity_id',
        'event_type',
        'from_status',
        'to_status',
        'entity_version',
        'occurred_at'
      ])
      .where('lane', '=', query.lane)
      .orderBy('sequence', 'desc')
      .limit(query.limit)
      .execute();

    return rows.map((row) => ({
      sequence: row.sequence,
      lane: RevenueLaneSchema.parse(row.lane),
      entityType: this.parseEntityType(row.entity_type),
      entityId: row.entity_id,
      eventType: this.parseEventType(row.event_type),
      fromStatus: row.from_status,
      toStatus: row.to_status,
      entityVersion: row.entity_version,
      occurredAt: row.occurred_at
    }));
  }

  private assertCurrentVersion(
    label: string,
    id: string,
    row: { version: number } | undefined,
    expectedVersion: number
  ): asserts row is { version: number } {
    if (row === undefined) throw new Error(`${label} ${id} does not exist`);
    if (row.version !== expectedVersion) {
      throw new Error(
        `${label} ${id} version conflict: expected ${expectedVersion}, found ${row.version}`
      );
    }
  }

  private parseEntityType(value: string): RevenueEntityType {
    const allowed: RevenueEntityType[] = [
      'prospect',
      'offer',
      'outreach_draft',
      'task_market_activation',
      'task_market_simulation'
    ];
    const parsed = allowed.find((candidate) => candidate === value);
    if (parsed === undefined) throw new Error(`Unknown revenue entity type ${value}`);
    return parsed;
  }

  private parseEventType(value: string): RevenueEventType {
    const allowed: RevenueEventType[] = ['created', 'status_changed', 'simulation_recorded'];
    const parsed = allowed.find((candidate) => candidate === value);
    if (parsed === undefined) throw new Error(`Unknown revenue event type ${value}`);
    return parsed;
  }

  private appendEvent(
    transaction: Transaction<JarvisDatabase>,
    event: EventInput
  ): Promise<unknown> {
    return transaction
      .insertInto('revenue_pipeline_events')
      .values({
        lane: event.lane,
        entity_type: event.entityType,
        entity_id: event.entityId,
        event_type: event.eventType,
        from_status: event.fromStatus,
        to_status: event.toStatus,
        entity_version: event.entityVersion,
        actor_id: event.actorId,
        detail_json: JSON.stringify(event.detail),
        occurred_at: event.occurredAt
      })
      .execute();
  }
}
