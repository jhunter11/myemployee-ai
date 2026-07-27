import { z } from 'zod';

const RevenueIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/);
const ActorIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);
const ContactReferenceSchema = z
  .string()
  .regex(/^contact:[a-z0-9][a-z0-9._:-]{2,95}$/)
  .refine((value) => !value.includes('@'), 'contact references must be opaque');
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const hasControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
const SafeLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !hasControlCharacters(value), 'control characters are not allowed');
const DraftTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_000)
  .superRefine((value, context) => {
    const privateKeyHeader = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu;
    const labelledSecret = /\b(?:private[_ -]?key|seed[_ -]?phrase|mnemonic)\s*[:=]/iu;
    const rawHexKey = /\b0x[a-f0-9]{64}\b/iu;
    if (privateKeyHeader.test(value) || labelledSecret.test(value) || rawHexKey.test(value)) {
      context.addIssue({
        code: 'custom',
        message: 'outreach drafts must not contain wallet or private-key material'
      });
    }
  });

export const RevenueLaneSchema = z.enum(['agency', 'task_market']);
export const ContactChannelSchema = z.enum([
  'email',
  'linkedin',
  'referral',
  'marketplace',
  'other'
]);
export const ProspectSourceSchema = z.enum([
  'operator_research',
  'referral',
  'public_directory',
  'github'
]);
export const ProspectNeedSchema = z.enum([
  'agency_automation_audit',
  'agency_workflow_pilot',
  'task_validation_api'
]);
export const ProspectStatusSchema = z.enum(['identified', 'qualified', 'paused', 'archived']);
export const OfferDeliverableSchema = z.enum([
  'automation_audit',
  'workflow_pilot',
  'edge_validation_v1'
]);
export const InternalReviewStatusSchema = z.enum(['draft', 'review_ready', 'reviewed', 'archived']);
export const TaskMarketActivationStateSchema = z.enum(['contract_only', 'simulation']);
export const TaskMarketSimulationScenarioSchema = z.enum([
  'authorization_accepted',
  'authorization_rejected',
  'duplicate_replay'
]);
export const TaskMarketSimulationOutcomeSchema = z.enum(['pass', 'fail']);

const EventFields = {
  actorId: ActorIdSchema,
  createdAt: z.iso.datetime()
} as const;

export const CreateProspectInputSchema = z
  .strictObject({
    id: RevenueIdSchema,
    lane: RevenueLaneSchema,
    publicLabel: SafeLabelSchema,
    contactChannel: ContactChannelSchema,
    contactReference: ContactReferenceSchema.nullable(),
    source: ProspectSourceSchema,
    need: ProspectNeedSchema,
    ...EventFields
  })
  .superRefine((input, context) => {
    const validNeed =
      (input.lane === 'agency' && input.need.startsWith('agency_')) ||
      (input.lane === 'task_market' && input.need === 'task_validation_api');
    if (!validNeed) {
      context.addIssue({
        code: 'custom',
        path: ['need'],
        message: `need is not valid for ${input.lane}`
      });
    }
  });

export const TransitionProspectInputSchema = z.strictObject({
  id: RevenueIdSchema,
  expectedVersion: z.number().int().min(1),
  status: ProspectStatusSchema,
  actorId: ActorIdSchema,
  changedAt: z.iso.datetime()
});

export const CreateOfferInputSchema = z
  .strictObject({
    id: RevenueIdSchema,
    prospectId: RevenueIdSchema,
    lane: RevenueLaneSchema,
    title: SafeLabelSchema,
    deliverable: OfferDeliverableSchema,
    proposedAmountMicrousd: z.number().int().min(1).max(1_000_000_000_000),
    turnaroundHours: z.number().int().min(1).max(2_160),
    revisionLimit: z.number().int().min(0).max(10),
    ...EventFields
  })
  .superRefine((input, context) => {
    const validDeliverable =
      (input.lane === 'agency' && input.deliverable !== 'edge_validation_v1') ||
      (input.lane === 'task_market' && input.deliverable === 'edge_validation_v1');
    if (!validDeliverable) {
      context.addIssue({
        code: 'custom',
        path: ['deliverable'],
        message: `deliverable is not valid for ${input.lane}`
      });
    }
  });

export const TransitionOfferInputSchema = z.strictObject({
  id: RevenueIdSchema,
  expectedVersion: z.number().int().min(1),
  status: InternalReviewStatusSchema,
  actorId: ActorIdSchema,
  changedAt: z.iso.datetime()
});

export const CreateOutreachDraftInputSchema = z.strictObject({
  id: RevenueIdSchema,
  prospectId: RevenueIdSchema,
  offerId: RevenueIdSchema,
  lane: RevenueLaneSchema,
  channel: ContactChannelSchema,
  subject: DraftTextSchema.pipe(z.string().max(160)),
  body: DraftTextSchema,
  ...EventFields
});

export const TransitionOutreachDraftInputSchema = z.strictObject({
  id: RevenueIdSchema,
  expectedVersion: z.number().int().min(1),
  status: InternalReviewStatusSchema,
  actorId: ActorIdSchema,
  changedAt: z.iso.datetime()
});

export const InitializeTaskMarketContractInputSchema = z.strictObject({
  productId: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
  a2aVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
  skillId: RevenueIdSchema,
  inputContract: z.literal('bounded_numeric_series'),
  outputContract: z.literal('validation_verdict'),
  x402Scheme: z.literal('exact'),
  quotedAmountMicrousd: z.number().int().min(1).max(1_000_000_000_000),
  ...EventFields
});

export const EnableTaskMarketSimulationInputSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  actorId: ActorIdSchema,
  changedAt: z.iso.datetime()
});

export const RecordTaskMarketSimulationInputSchema = z.strictObject({
  id: RevenueIdSchema,
  activationVersion: z.number().int().min(1),
  scenario: TaskMarketSimulationScenarioSchema,
  outcome: TaskMarketSimulationOutcomeSchema,
  requestDigest: Sha256Schema,
  evidenceDigest: Sha256Schema,
  actorId: ActorIdSchema,
  recordedAt: z.iso.datetime()
});

export const RevenueLaneReadSchema = z.strictObject({
  lane: RevenueLaneSchema,
  limit: z.number().int().min(1).max(50)
});

export const RevenueEventReadSchema = z.strictObject({
  lane: RevenueLaneSchema,
  limit: z.number().int().min(1).max(100)
});

export type RevenueLane = z.infer<typeof RevenueLaneSchema>;
export type ContactChannel = z.infer<typeof ContactChannelSchema>;
export type ProspectSource = z.infer<typeof ProspectSourceSchema>;
export type ProspectNeed = z.infer<typeof ProspectNeedSchema>;
export type ProspectStatus = z.infer<typeof ProspectStatusSchema>;
export type OfferDeliverable = z.infer<typeof OfferDeliverableSchema>;
export type InternalReviewStatus = z.infer<typeof InternalReviewStatusSchema>;
export type TaskMarketActivationState = z.infer<typeof TaskMarketActivationStateSchema>;
export type TaskMarketSimulationScenario = z.infer<typeof TaskMarketSimulationScenarioSchema>;
export type TaskMarketSimulationOutcome = z.infer<typeof TaskMarketSimulationOutcomeSchema>;
export type CreateProspectInput = z.infer<typeof CreateProspectInputSchema>;
export type TransitionProspectInput = z.infer<typeof TransitionProspectInputSchema>;
export type CreateOfferInput = z.infer<typeof CreateOfferInputSchema>;
export type TransitionOfferInput = z.infer<typeof TransitionOfferInputSchema>;
export type CreateOutreachDraftInput = z.infer<typeof CreateOutreachDraftInputSchema>;
export type TransitionOutreachDraftInput = z.infer<typeof TransitionOutreachDraftInputSchema>;
export type InitializeTaskMarketContractInput = z.infer<
  typeof InitializeTaskMarketContractInputSchema
>;
export type EnableTaskMarketSimulationInput = z.infer<typeof EnableTaskMarketSimulationInputSchema>;
export type RecordTaskMarketSimulationInput = z.infer<typeof RecordTaskMarketSimulationInputSchema>;

export const REVENUE_PIPELINE_SAFETY = Object.freeze({
  outboundNetwork: 'none' as const,
  externalMessaging: 'blocked' as const,
  externalPayment: 'blocked' as const,
  walletMaterial: 'forbidden' as const,
  revenueRecognition: 'none' as const
});

export const MICRO_USD_PER_USD = 1_000_000;

export interface RedactedProspect {
  id: string;
  lane: RevenueLane;
  publicLabel: string;
  contactChannel: ContactChannel;
  hasContactReference: boolean;
  source: ProspectSource;
  need: ProspectNeed;
  status: ProspectStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RedactedOffer {
  id: string;
  prospectId: string;
  lane: RevenueLane;
  title: string;
  deliverable: OfferDeliverable;
  quote: {
    basis: 'proposed';
    currency: 'USD';
    amountMicrousd: number;
  };
  turnaroundHours: number;
  revisionLimit: number;
  status: InternalReviewStatus;
  version: number;
  externalPayment: 'blocked';
  createdAt: string;
  updatedAt: string;
}

export interface RedactedOutreachDraft {
  id: string;
  prospectId: string;
  offerId: string;
  lane: RevenueLane;
  channel: ContactChannel;
  status: InternalReviewStatus;
  version: number;
  subjectLength: number;
  bodyLength: number;
  contentDigest: string;
  externalDelivery: 'blocked';
  createdAt: string;
  updatedAt: string;
}

export interface RedactedTaskMarketActivation {
  lane: 'task_market';
  productId: string;
  state: TaskMarketActivationState;
  version: number;
  contractDigest: string;
  a2a: {
    version: string;
    skillId: string;
    inputContract: 'bounded_numeric_series';
    outputContract: 'validation_verdict';
  };
  x402: {
    scheme: 'exact';
    quote: { basis: 'simulation'; currency: 'USD'; amountMicrousd: number };
    paymentMode: 'blocked' | 'simulated';
  };
  safety: typeof REVENUE_PIPELINE_SAFETY;
  createdAt: string;
  updatedAt: string;
}

export interface RedactedTaskMarketSimulation {
  id: string;
  activationVersion: number;
  scenario: TaskMarketSimulationScenario;
  outcome: TaskMarketSimulationOutcome;
  requestDigest: string;
  evidenceDigest: string;
  quote: { basis: 'simulation'; currency: 'USD'; amountMicrousd: number };
  externalPayment: 'blocked';
  revenueRecognition: 'none';
  recordedAt: string;
}

export interface RevenueLaneSnapshot {
  lane: RevenueLane;
  counts: {
    prospects: number;
    offers: number;
    outreachDrafts: number;
    simulations: number;
  };
  prospects: RedactedProspect[];
  offers: RedactedOffer[];
  outreachDrafts: RedactedOutreachDraft[];
  simulations: RedactedTaskMarketSimulation[];
  activation: RedactedTaskMarketActivation | null;
  safety: typeof REVENUE_PIPELINE_SAFETY;
}

export type RevenueEventType = 'created' | 'status_changed' | 'simulation_recorded';
export interface RedactedRevenueEvent {
  sequence: number;
  lane: RevenueLane;
  entityType:
    'prospect' | 'offer' | 'outreach_draft' | 'task_market_activation' | 'task_market_simulation';
  entityId: string;
  eventType: RevenueEventType;
  fromStatus: string | null;
  toStatus: string;
  entityVersion: number;
  occurredAt: string;
}
