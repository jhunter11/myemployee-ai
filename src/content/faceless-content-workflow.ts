import { createHash, createHmac } from 'node:crypto';

import { z } from 'zod';

import type { BasicWorker, WorkerContext } from '../agents/contracts';
import { ClientIdSchema, type JsonValue } from '../config/schemas';

export const FACELESS_CONTENT_AUTOMATION_ID = 'faceless-content';

const SlugSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,95}$/);
const BoundedReferenceSchema = z.string().trim().min(3).max(512);
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const EmailGroupIdSchema = z.string().regex(/^email_group:[a-f0-9]{48}$/);
const JsonValueSchema = z.json();

export const FacelessContentLaneSchema = z.enum([
  'short_story',
  'broll_short',
  'cinematic_short',
  'longform'
]);

const ContentSourceSchema = z
  .strictObject({
    kind: z.enum(['original', 'licensed', 'public_domain', 'researched_transformative']),
    rightsConfirmed: z.literal(true),
    references: z.array(BoundedReferenceSchema).max(20)
  })
  .superRefine((source, context) => {
    if (source.kind !== 'original' && source.references.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['references'],
        message: 'Non-original source material requires at least one rights or provenance reference'
      });
    }
  });

const InterestEvidenceSchema = z.strictObject({
  kind: z.enum([
    'platform_trend',
    'search_signal',
    'audience_request',
    'prior_performance',
    'operator_hypothesis'
  ]),
  sourceRef: BoundedReferenceSchema,
  observedAt: z.iso.datetime()
});

const SeriesSchema = z.strictObject({
  id: SlugSchema,
  title: z.string().trim().min(3).max(120),
  targetAudience: z.string().trim().min(20).max(500),
  audiencePromise: z.string().trim().min(20).max(500),
  creativeThesis: z.string().trim().min(30).max(1_000),
  recurringDevice: z.string().trim().min(20).max(500)
});

const ConceptSchema = z.strictObject({
  id: SlugSchema,
  title: z.string().trim().min(3).max(160),
  premise: z.string().trim().min(30).max(2_000),
  viewerPayoff: z.string().trim().min(30).max(1_000),
  originalContribution: z.string().trim().min(30).max(1_000),
  source: ContentSourceSchema,
  interestEvidence: z.array(InterestEvidenceSchema).min(1).max(20)
});

export const FacelessContentPilotPolicySchema = z
  .strictObject({
    winnerDefinition: z.string().trim().min(30).max(1_000),
    minPublishedPosts: z.number().int().min(1).max(1_000),
    minWinningPosts: z.number().int().min(1).max(1_000),
    minAnalyticsCoverageBps: z.number().int().min(1).max(10_000),
    minKnownCostCoverageBps: z.number().int().min(1).max(10_000)
  })
  .refine((policy) => policy.minWinningPosts <= policy.minPublishedPosts, {
    path: ['minWinningPosts'],
    message: 'Minimum winning posts cannot exceed minimum published posts'
  });

export const FacelessContentPilotObservationSchema = z
  .strictObject({
    publishedPosts: z.number().int().min(0).max(1_000_000),
    winningPosts: z.number().int().min(0).max(1_000_000),
    analyticsCoverageBps: z.number().int().min(0).max(10_000),
    knownCostCoverageBps: z.number().int().min(0).max(10_000),
    policyIncidents: z.number().int().min(0).max(1_000_000),
    rightsIncidents: z.number().int().min(0).max(1_000_000),
    operatorApprovedPaidGeneration: z.boolean(),
    evidenceRefs: z.array(BoundedReferenceSchema).max(100)
  })
  .refine((observation) => observation.winningPosts <= observation.publishedPosts, {
    path: ['winningPosts'],
    message: 'Winning posts cannot exceed published posts'
  });

export const FacelessContentPilotGateSchema = z.strictObject({
  policy: FacelessContentPilotPolicySchema,
  observation: FacelessContentPilotObservationSchema
});

const PlanCommandSchema = z
  .strictObject({
    command: z.literal('plan'),
    requestId: SlugSchema,
    series: SeriesSchema,
    concept: ConceptSchema,
    lane: FacelessContentLaneSchema,
    productionTier: z.enum(['poc', 'premium']),
    containsGenerativeMedia: z.boolean(),
    realisticSyntheticMedia: z.boolean(),
    usesRealPersonLikeness: z.boolean(),
    likenessConsentConfirmed: z.boolean(),
    pilotGate: FacelessContentPilotGateSchema.optional()
  })
  .superRefine((input, context) => {
    if (input.realisticSyntheticMedia && !input.containsGenerativeMedia) {
      context.addIssue({
        code: 'custom',
        path: ['realisticSyntheticMedia'],
        message: 'Realistic synthetic media must be declared as generative media'
      });
    }
    if (input.usesRealPersonLikeness && !input.likenessConsentConfirmed) {
      context.addIssue({
        code: 'custom',
        path: ['likenessConsentConfirmed'],
        message: 'Real-person likeness use requires explicit consent evidence'
      });
    }
  });

const SocialConnectionSchema = z
  .strictObject({
    connectionId: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
    providerKey: z.enum(['manual_export', 'direct_platform', 'zernio', 'ayrshare']),
    credentialRef: z
      .string()
      .regex(
        /^secretref:[A-Za-z0-9][A-Za-z0-9._:-]{4,239}$/,
        'Credential must be an opaque secretref reference'
      )
      .nullable(),
    state: z.enum(['disconnected', 'active', 'credential_expired', 'revoked', 'provider_error']),
    version: z.number().int().min(1).max(2_147_483_647)
  })
  .superRefine((connection, context) => {
    if (
      connection.providerKey !== 'manual_export' &&
      connection.state !== 'disconnected' &&
      connection.credentialRef === null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['credentialRef'],
        message: 'Connected publishing providers require an opaque credential reference'
      });
    }
    if (connection.providerKey === 'manual_export' && connection.credentialRef !== null) {
      context.addIssue({
        code: 'custom',
        path: ['credentialRef'],
        message: 'Manual export must not reference a publishing credential'
      });
    }
  });

const SocialAccountSchema = z.strictObject({
  accountId: SlugSchema,
  platform: z.enum(['youtube', 'tiktok', 'instagram', 'facebook']),
  placement: z.enum(['shorts', 'reels', 'watch', 'feed']),
  publicLabel: z.string().trim().min(2).max(120),
  connection: SocialConnectionSchema,
  role: z.enum(['primary', 'experiment', 'archive']),
  audience: z.string().trim().min(20).max(500),
  allowedLanes: z.array(FacelessContentLaneSchema).min(1).max(4)
});

export const SocialAccountPortfolioSchema = z
  .strictObject({
    version: z.literal(1),
    portfolioId: SlugSchema,
    binding: z.strictObject({
      kind: z.literal('client'),
      scopeId: z.string().regex(/^client:[a-z][a-z0-9_]{2,62}$/)
    }),
    emailGroupId: EmailGroupIdSchema,
    providerProfileRef: BoundedReferenceSchema.nullable(),
    accounts: z.array(SocialAccountSchema).min(1).max(64)
  })
  .superRefine((portfolio, context) => {
    const serialized = JSON.stringify(portfolio);
    if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(serialized)) {
      context.addIssue({
        code: 'custom',
        message: 'A social account portfolio cannot contain a raw email address'
      });
    }
    const accountIds = new Set<string>();
    const connectionIds = new Set<string>();
    for (const [index, account] of portfolio.accounts.entries()) {
      if (accountIds.has(account.accountId)) {
        context.addIssue({
          code: 'custom',
          path: ['accounts', index, 'accountId'],
          message: 'Social account IDs must be unique within a portfolio'
        });
      }
      if (connectionIds.has(account.connection.connectionId)) {
        context.addIssue({
          code: 'custom',
          path: ['accounts', index, 'connection', 'connectionId'],
          message: 'Social connection IDs must be unique within a portfolio'
        });
      }
      accountIds.add(account.accountId);
      connectionIds.add(account.connection.connectionId);

      const compatiblePlacement =
        (account.platform === 'youtube' &&
          (account.placement === 'shorts' || account.placement === 'watch')) ||
        (account.platform === 'tiktok' && account.placement === 'reels') ||
        ((account.platform === 'instagram' || account.platform === 'facebook') &&
          (account.placement === 'reels' || account.placement === 'feed'));
      if (!compatiblePlacement) {
        context.addIssue({
          code: 'custom',
          path: ['accounts', index, 'placement'],
          message: `Placement ${account.placement} is not compatible with ${account.platform}`
        });
      }
      if (new Set(account.allowedLanes).size !== account.allowedLanes.length) {
        context.addIssue({
          code: 'custom',
          path: ['accounts', index, 'allowedLanes'],
          message: 'Allowed content lanes must be unique'
        });
      }
    }

    const unifiedProviderUsed = portfolio.accounts.some((account) =>
      ['zernio', 'ayrshare'].includes(account.connection.providerKey)
    );
    if (unifiedProviderUsed && portfolio.providerProfileRef === null) {
      context.addIssue({
        code: 'custom',
        path: ['providerProfileRef'],
        message: 'Unified publishing providers require an opaque provider profile reference'
      });
    }
  });

const VoiceComponentSchema = z
  .strictObject({
    voiceId: SlugSchema,
    provider: z.enum(['human_recorded', 'local_tts', 'elevenlabs', 'higgsfield_native_audio']),
    kind: z.enum(['human_original', 'licensed_stock', 'synthetic_designed', 'operator_clone']),
    licenseRef: BoundedReferenceSchema,
    consentRef: BoundedReferenceSchema.nullable()
  })
  .superRefine((voice, context) => {
    if (voice.kind === 'operator_clone' && voice.consentRef === null) {
      context.addIssue({
        code: 'custom',
        path: ['consentRef'],
        message: 'A cloned voice requires explicit consent evidence'
      });
    }
  });

const VisualComponentSchema = z.strictObject({
  visualPackId: SlugSchema,
  provider: z.enum(['owned', 'pexels', 'pixabay', 'local', 'higgsfield']),
  strategy: z.enum([
    'owned_licensed_broll',
    'poc_storyboard',
    'higgsfield_cinema_manual',
    'hybrid_longform'
  ]),
  rightsRef: BoundedReferenceSchema,
  containsGenerativeMedia: z.boolean()
});

const VariantPolicySchema = z.strictObject({
  maxVariants: z.number().int().min(1).max(32),
  minChangedDimensions: z.literal(2),
  staggerMinutes: z.number().int().min(0).max(43_200),
  requireExactPublishApproval: z.literal(true)
});

const ComposeVariantsCommandSchema = z
  .strictObject({
    command: z.literal('compose_variants'),
    requestId: SlugSchema,
    lane: FacelessContentLaneSchema,
    story: z.strictObject({
      storyId: SlugSchema,
      title: z.string().trim().min(3).max(160),
      scriptDigest: DigestSchema,
      originalStory: z.literal(true),
      containsGenerativeMedia: z.boolean(),
      realisticSyntheticMedia: z.boolean()
    }),
    portfolio: SocialAccountPortfolioSchema,
    voices: z.array(VoiceComponentSchema).min(1).max(16),
    visualPacks: z.array(VisualComponentSchema).min(1).max(16),
    policy: VariantPolicySchema
  })
  .superRefine((input, context) => {
    if (input.story.realisticSyntheticMedia && !input.story.containsGenerativeMedia) {
      context.addIssue({
        code: 'custom',
        path: ['story', 'realisticSyntheticMedia'],
        message: 'Realistic synthetic media must be declared as generative media'
      });
    }
    const voiceIds = input.voices.map((voice) => voice.voiceId);
    if (new Set(voiceIds).size !== voiceIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['voices'],
        message: 'Voice component IDs must be unique'
      });
    }
    const visualIds = input.visualPacks.map((visual) => visual.visualPackId);
    if (new Set(visualIds).size !== visualIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['visualPacks'],
        message: 'Visual component IDs must be unique'
      });
    }
  });

const VariantIdSchema = z.string().regex(/^variant:[a-f0-9]{48}$/);

const UploadQueueItemSchema = z.strictObject({
  itemId: SlugSchema,
  variantId: VariantIdSchema,
  accountId: SlugSchema,
  storyId: SlugSchema,
  assetRef: BoundedReferenceSchema,
  assetDigest: DigestSchema,
  renderManifestDigest: DigestSchema,
  metadataRef: BoundedReferenceSchema,
  finalQcApproved: z.boolean(),
  rightsCleared: z.boolean(),
  disclosure: z.strictObject({
    containsGenerativeMedia: z.boolean(),
    realisticSyntheticMedia: z.boolean()
  }),
  priority: z.number().int().min(1).max(1_000)
});

export const FacelessUploadSessionPolicySchema = z
  .strictObject({
    sessionMinutes: z.number().int().min(5).max(480),
    signInMinutes: z.number().int().min(0).max(30),
    uploadMinutes: z.number().int().min(1).max(60),
    verifyMinutes: z.number().int().min(0).max(30),
    signOutMinutes: z.number().int().min(0).max(30),
    requireSignOut: z.literal(true),
    maxAccountsPerSession: z.number().int().min(1).max(16),
    maxUploadsPerAccount: z.number().int().min(1).max(16)
  })
  .superRefine((policy, context) => {
    const minimumBlockMinutes =
      policy.signInMinutes + policy.uploadMinutes + policy.verifyMinutes + policy.signOutMinutes;
    if (minimumBlockMinutes > policy.sessionMinutes) {
      context.addIssue({
        code: 'custom',
        path: ['sessionMinutes'],
        message: `A session of ${policy.sessionMinutes} minutes cannot hold one sign-in, upload, verify, and sign-out block of ${minimumBlockMinutes} minutes`
      });
    }
  });

const PlanUploadSessionCommandSchema = z
  .strictObject({
    command: z.literal('plan_upload_session'),
    requestId: SlugSchema,
    sessionId: SlugSchema,
    sessionStart: z.iso.datetime(),
    portfolio: SocialAccountPortfolioSchema,
    queue: z.array(UploadQueueItemSchema).min(1).max(64),
    policy: FacelessUploadSessionPolicySchema
  })
  .superRefine((input, context) => {
    const itemIds = new Set<string>();
    const assetDigests = new Set<string>();
    const variantIds = new Set<string>();
    for (const [index, item] of input.queue.entries()) {
      if (itemIds.has(item.itemId)) {
        context.addIssue({
          code: 'custom',
          path: ['queue', index, 'itemId'],
          message: 'Upload queue item IDs must be unique within a session'
        });
      }
      if (assetDigests.has(item.assetDigest)) {
        context.addIssue({
          code: 'custom',
          path: ['queue', index, 'assetDigest'],
          message: 'The same rendered asset cannot be uploaded twice in one session'
        });
      }
      if (variantIds.has(item.variantId)) {
        context.addIssue({
          code: 'custom',
          path: ['queue', index, 'variantId'],
          message: 'The same variant cannot be uploaded twice in one session'
        });
      }
      itemIds.add(item.itemId);
      assetDigests.add(item.assetDigest);
      variantIds.add(item.variantId);
    }
  });

const EvaluatePilotCommandSchema = z.strictObject({
  command: z.literal('evaluate_pilot'),
  requestId: SlugSchema,
  pilotGate: FacelessContentPilotGateSchema
});

const PlanAccountLinksCommandSchema = z.strictObject({
  command: z.literal('plan_account_links'),
  requestId: SlugSchema,
  portfolio: SocialAccountPortfolioSchema
});

export const FacelessContentCommandSchema = z.union([
  PlanCommandSchema,
  ComposeVariantsCommandSchema,
  PlanAccountLinksCommandSchema,
  PlanUploadSessionCommandSchema,
  EvaluatePilotCommandSchema
]);

export type FacelessContentPilotGate = z.infer<typeof FacelessContentPilotGateSchema>;
export type FacelessContentPlanCommand = z.infer<typeof PlanCommandSchema>;
export type ComposeFacelessContentVariantsCommand = z.infer<typeof ComposeVariantsCommandSchema>;

export interface FacelessContentPilotDecision {
  promoteToPaidGeneration: boolean;
  reasons: string[];
  evidenceRefs: string[];
  winnerDefinition: string;
}

export function deriveSocialAccountGroupId(input: {
  clientId: string;
  email: string;
  hmacKey: string;
}): string {
  const clientId = ClientIdSchema.parse(input.clientId);
  const email = z.string().trim().email().max(320).parse(input.email).toLowerCase();
  const hmacKey = z.string().min(32).max(4_096).parse(input.hmacKey);
  const digest = createHmac('sha256', hmacKey)
    .update(`${clientId}\u0000${email}`, 'utf8')
    .digest('hex')
    .slice(0, 48);
  return EmailGroupIdSchema.parse(`email_group:${digest}`);
}

export function evaluateFacelessContentPilot(rawGate: unknown): FacelessContentPilotDecision {
  const gate = FacelessContentPilotGateSchema.parse(rawGate);
  const { policy, observation } = gate;
  const reasons: string[] = [];
  if (observation.publishedPosts < policy.minPublishedPosts) {
    reasons.push('insufficient_published_posts');
  }
  if (observation.winningPosts < policy.minWinningPosts) {
    reasons.push('insufficient_winning_posts');
  }
  if (observation.analyticsCoverageBps < policy.minAnalyticsCoverageBps) {
    reasons.push('analytics_coverage_incomplete');
  }
  if (observation.knownCostCoverageBps < policy.minKnownCostCoverageBps) {
    reasons.push('known_cost_coverage_incomplete');
  }
  if (observation.policyIncidents > 0) reasons.push('policy_incident_detected');
  if (observation.rightsIncidents > 0) reasons.push('rights_incident_detected');
  if (!observation.operatorApprovedPaidGeneration) {
    reasons.push('operator_approval_required');
  }
  if (observation.evidenceRefs.length === 0) reasons.push('evidence_reference_required');
  return {
    promoteToPaidGeneration: reasons.length === 0,
    reasons,
    evidenceRefs: [...observation.evidenceRefs],
    winnerDefinition: policy.winnerDefinition
  };
}

interface TargetProfile {
  platform: 'tiktok' | 'youtube_shorts' | 'youtube_watch';
  aspectRatio: '9:16' | '16:9';
  width: 1080 | 1920;
  height: 1920 | 1080;
  durationSeconds: 75 | 600;
  monetizationFit: string;
}

interface Beat {
  id: string;
  startSecond: number;
  endSecond: number;
  purpose: string;
  visualDirection: string;
}

function shortTargets(): TargetProfile[] {
  return [
    {
      platform: 'tiktok',
      aspectRatio: '9:16',
      width: 1080,
      height: 1920,
      durationSeconds: 75,
      monetizationFit:
        'One-minute format fit only; account, region, originality, and qualified-view rules still apply.'
    },
    {
      platform: 'youtube_shorts',
      aspectRatio: '9:16',
      width: 1080,
      height: 1920,
      durationSeconds: 75,
      monetizationFit:
        'YouTube Shorts format fit only; YPP admission and channel-wide originality review still apply.'
    }
  ];
}

function longformTargets(): TargetProfile[] {
  return [
    {
      platform: 'youtube_watch',
      aspectRatio: '16:9',
      width: 1920,
      height: 1080,
      durationSeconds: 600,
      monetizationFit:
        'Eight-minute mid-roll format fit only; YPP admission, ad suitability, and viewer value still apply.'
    }
  ];
}

function shortBeats(input: FacelessContentPlanCommand): Beat[] {
  const premise = input.concept.premise;
  return [
    {
      id: 'cold_open',
      startSecond: 0,
      endSecond: 3,
      purpose: 'Open on the unresolved consequence, not channel branding.',
      visualDirection: `Show one concrete consequence from: ${premise}`
    },
    {
      id: 'setup',
      startSecond: 3,
      endSecond: 12,
      purpose: 'Establish the protagonist, rule, and immediate question.',
      visualDirection: `Introduce the recurring device: ${input.series.recurringDevice}`
    },
    {
      id: 'escalation',
      startSecond: 12,
      endSecond: 35,
      purpose: 'Escalate with specific evidence and no filler recap.',
      visualDirection: 'Change composition or source footage at each meaningful narrative beat.'
    },
    {
      id: 'reversal',
      startSecond: 35,
      endSecond: 58,
      purpose: 'Reveal the interpretation that changes the original question.',
      visualDirection: `Earn the promised payoff: ${input.concept.viewerPayoff}`
    },
    {
      id: 'payoff',
      startSecond: 58,
      endSecond: 72,
      purpose: 'Resolve the episode while preserving the series world.',
      visualDirection: 'Hold long enough for the emotional consequence to register.'
    },
    {
      id: 'native_bridge',
      startSecond: 72,
      endSecond: 75,
      purpose: 'Invite interpretation or point to a related episode without engagement bait.',
      visualDirection: 'Use a clean final frame that remains legible without interface overlays.'
    }
  ];
}

function longformBeats(input: FacelessContentPlanCommand): Beat[] {
  return [
    {
      id: 'cold_open',
      startSecond: 0,
      endSecond: 30,
      purpose: 'Open with the strongest unanswered consequence.',
      visualDirection: `Visualize the central tension in: ${input.concept.premise}`
    },
    {
      id: 'promise_and_context',
      startSecond: 30,
      endSecond: 75,
      purpose: 'State the viewer promise, source posture, and narrative question.',
      visualDirection: 'Introduce the visual grammar and any provenance notes.'
    },
    {
      id: 'act_one',
      startSecond: 75,
      endSecond: 210,
      purpose: 'Build the world, evidence, and stakes.',
      visualDirection: 'Alternate B-roll, diagrams, stills, and restrained generated sequences.'
    },
    {
      id: 'act_two',
      startSecond: 210,
      endSecond: 390,
      purpose: 'Complicate the initial explanation with the strongest counterpoint.',
      visualDirection: 'Use visual changes to mark new information, not arbitrary cadence.'
    },
    {
      id: 'reversal_and_payoff',
      startSecond: 390,
      endSecond: 540,
      purpose: 'Deliver the original contribution and resolve the central promise.',
      visualDirection: `Land the promised consequence: ${input.concept.viewerPayoff}`
    },
    {
      id: 'takeaway_and_bridge',
      startSecond: 540,
      endSecond: 600,
      purpose: 'Give the viewer a complete takeaway and a related next path.',
      visualDirection: 'Use a natural chapter boundary suitable for a mid-roll before this segment.'
    }
  ];
}

type VisualProvider =
  'poc_storyboard' | 'owned_licensed_broll' | 'hybrid_longform' | 'higgsfield_cinema_manual';

interface ProviderPlan {
  selected: VisualProvider;
  enhancement: 'higgsfield_cinema_manual' | null;
  higgsfieldStatus: 'not_requested' | 'blocked_pending_proof' | 'eligible_manual';
  integrationMode: 'local_manifest' | 'manual_manifest';
  gateReasons: string[];
  reason: string;
}

function fallbackProvider(lane: z.infer<typeof FacelessContentLaneSchema>): VisualProvider {
  if (lane === 'broll_short') return 'owned_licensed_broll';
  if (lane === 'longform') return 'hybrid_longform';
  return 'poc_storyboard';
}

function providerPlan(input: FacelessContentPlanCommand): ProviderPlan {
  const fallback = fallbackProvider(input.lane);
  if (input.productionTier === 'poc') {
    return {
      selected: fallback,
      enhancement: null,
      higgsfieldStatus: 'not_requested',
      integrationMode: 'local_manifest',
      gateReasons: [],
      reason: 'Use the lowest-cost rights-safe visual treatment while the story earns proof.'
    };
  }

  const gate =
    input.pilotGate === undefined
      ? {
          promoteToPaidGeneration: false,
          reasons: ['pilot_gate_required'],
          evidenceRefs: [],
          winnerDefinition: ''
        }
      : evaluateFacelessContentPilot(input.pilotGate);
  if (!gate.promoteToPaidGeneration) {
    return {
      selected: fallback,
      enhancement: null,
      higgsfieldStatus: 'blocked_pending_proof',
      integrationMode: 'local_manifest',
      gateReasons: gate.reasons,
      reason: 'Premium visual spend is held; continue with the proof treatment.'
    };
  }

  if (input.lane === 'broll_short' || input.lane === 'longform') {
    return {
      selected: fallback,
      enhancement: 'higgsfield_cinema_manual',
      higgsfieldStatus: 'eligible_manual',
      integrationMode: 'manual_manifest',
      gateReasons: [],
      reason: 'Keep the primary edit efficient and add Higgsfield only for selected hero shots.'
    };
  }
  return {
    selected: 'higgsfield_cinema_manual',
    enhancement: null,
    higgsfieldStatus: 'eligible_manual',
    integrationMode: 'manual_manifest',
    gateReasons: [],
    reason: 'The evidence gate allows a reviewable Higgsfield Cinema production manifest.'
  };
}

export function planFacelessContentWorkflow(rawCommand: unknown) {
  const input = PlanCommandSchema.parse(rawCommand);
  const short = input.lane !== 'longform';
  return {
    version: 1,
    requestId: input.requestId,
    status: 'ready_for_operator_review',
    lane: input.lane,
    seriesId: input.series.id,
    conceptId: input.concept.id,
    targets: short ? shortTargets() : longformTargets(),
    beatSheet: short ? shortBeats(input) : longformBeats(input),
    provider: providerPlan(input),
    deliverables: short
      ? [
          { id: 'master_9x16', quantity: 1, description: '75-second captioned vertical master' },
          { id: 'thumbnail_cover', quantity: 1, description: 'Platform-safe cover frame' },
          { id: 'metadata_pack', quantity: 2, description: 'TikTok and YouTube-native metadata' }
        ]
      : [
          { id: 'master_16x9', quantity: 1, description: '10-minute captioned YouTube master' },
          {
            id: 'short_derivatives',
            quantity: 3,
            description: 'Three native short concepts, not raw duplicate excerpts'
          },
          { id: 'thumbnail_options', quantity: 3, description: 'Distinct thumbnail concepts' }
        ],
    workflow: [
      { id: 'evidence', authority: 'deterministic', result: 'validated_input' },
      { id: 'concept_review', authority: 'human', result: 'approval_required' },
      { id: 'script_and_assets', authority: 'agent_proposal', result: 'artifact_required' },
      { id: 'script_rights_review', authority: 'human', result: 'approval_required' },
      { id: 'render_manifest', authority: 'agent_proposal', result: 'artifact_required' },
      { id: 'final_qc', authority: 'human', result: 'approval_required' },
      { id: 'publish', authority: 'human_external', result: 'blocked' },
      { id: 'analytics', authority: 'provider_read', result: 'post_publish_only' }
    ],
    compliance: {
      sourceRightsConfirmed: true,
      sourceKind: input.concept.source.kind,
      realPersonLikenessConsentRequired: input.usesRealPersonLikeness,
      realPersonLikenessConsentConfirmed: input.likenessConsentConfirmed,
      audioPolicy: 'owned_licensed_or_platform_library_only',
      visualPolicy: 'owned_licensed_public_domain_or_original_generated_only',
      aiDisclosure: {
        tiktokCreatorLabelRequired: input.containsGenerativeMedia,
        youtubeAiUseDisclosureRequired: input.realisticSyntheticMedia,
        realisticSyntheticMedia: input.realisticSyntheticMedia
      }
    },
    scorecard: short
      ? {
          checkpoints: ['24h', '7d', '30d'],
          metrics: [
            'engaged_view_rate',
            'average_percentage_viewed',
            'shares_per_1000_views',
            'meaningful_comments_per_1000_views',
            'follows_per_1000_views',
            'known_cost_per_published_variant'
          ]
        }
      : {
          checkpoints: ['24h', '7d', '30d'],
          metrics: [
            'impressions_click_through_rate',
            'thirty_second_retention',
            'average_view_duration',
            'end_screen_click_rate',
            'subscribers_per_1000_views',
            'known_cost_per_published_variant'
          ]
        },
    publishState: 'blocked_pending_operator_review',
    monetization: {
      strategy: short
        ? 'Use native short episodes for concept discovery and audience acquisition.'
        : 'Use proven premises for public watch time and a complete viewer experience.',
      disclaimer:
        'Format fit does not guarantee program eligibility, distribution, advertiser suitability, views, or revenue.'
    }
  };
}

function sha256Json(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function laneFitsAccount(
  lane: z.infer<typeof FacelessContentLaneSchema>,
  account: z.infer<typeof SocialAccountSchema>
): boolean {
  if (!account.allowedLanes.includes(lane)) return false;
  if (lane === 'longform') {
    return account.platform === 'youtube' && account.placement === 'watch';
  }
  return account.placement === 'shorts' || account.placement === 'reels';
}

export function composeFacelessContentVariants(rawCommand: unknown) {
  const input = ComposeVariantsCommandSchema.parse(rawCommand);
  const accounts = input.portfolio.accounts.slice(0, input.policy.maxVariants);
  for (const account of accounts) {
    if (account.connection.state !== 'active') {
      throw new Error(`Social account ${account.accountId} does not have an active connection`);
    }
    if (!laneFitsAccount(input.lane, account)) {
      throw new Error(`Content lane ${input.lane} is not allowed for account ${account.accountId}`);
    }
  }

  const combinations = input.voices.flatMap((voice) =>
    input.visualPacks.map((visual) => ({ voice, visual }))
  );
  if (combinations.length < accounts.length) {
    throw new Error(
      `The selected accounts require ${accounts.length} unique voice and visual combinations, but only ${combinations.length} are available`
    );
  }

  const variants = accounts.map((account, index) => {
    const combination = combinations[index];
    if (combination === undefined) throw new Error('Variant combination assignment failed');
    const { voice, visual } = combination;
    const variantIdentity = {
      requestId: input.requestId,
      emailGroupId: input.portfolio.emailGroupId,
      storyId: input.story.storyId,
      scriptDigest: input.story.scriptDigest,
      accountId: account.accountId,
      voiceId: voice.voiceId,
      visualPackId: visual.visualPackId
    };
    const variantId = `variant:${sha256Json(variantIdentity).slice('sha256:'.length, 55)}`;
    const renderManifest = {
      variantId,
      lane: input.lane,
      storyId: input.story.storyId,
      scriptDigest: input.story.scriptDigest,
      voice: {
        voiceId: voice.voiceId,
        provider: voice.provider,
        kind: voice.kind,
        licenseRef: voice.licenseRef,
        consentRef: voice.consentRef
      },
      visual: {
        visualPackId: visual.visualPackId,
        provider: visual.provider,
        strategy: visual.strategy,
        rightsRef: visual.rightsRef
      },
      disclosures: {
        containsGenerativeMedia:
          input.story.containsGenerativeMedia || visual.containsGenerativeMedia,
        realisticSyntheticMedia: input.story.realisticSyntheticMedia
      }
    };
    const renderManifestDigest = sha256Json(renderManifest);
    const publishPayload = {
      variantId,
      renderManifestDigest,
      accountId: account.accountId,
      connectionId: account.connection.connectionId,
      providerKey: account.connection.providerKey,
      platform: account.platform,
      placement: account.placement,
      staggerMinutes: input.policy.staggerMinutes,
      exactApprovalRequired: true
    };
    return {
      variantId,
      storyId: input.story.storyId,
      accountId: account.accountId,
      platform: account.platform,
      placement: account.placement,
      voiceId: voice.voiceId,
      visualPackId: visual.visualPackId,
      renderManifest,
      renderManifestDigest,
      metadataChecklist: [
        'account_native_title_or_caption',
        'account_native_call_to_action',
        'rights_and_music_confirmed',
        'ai_disclosure_confirmed',
        'final_render_human_qc'
      ],
      publishIntent: {
        sourceId: variantId,
        connectionId: account.connection.connectionId,
        providerKey: account.connection.providerKey,
        credentialRef: account.connection.credentialRef,
        platform: account.platform,
        placement: account.placement,
        externalEffect: true,
        reversible: false,
        requiresExactApproval: true,
        state: 'blocked_pending_operator_review',
        payloadDigest: sha256Json(publishPayload)
      }
    };
  });

  return {
    version: 1,
    requestId: input.requestId,
    portfolioId: input.portfolio.portfolioId,
    binding: input.portfolio.binding,
    emailGroupId: input.portfolio.emailGroupId,
    storyId: input.story.storyId,
    variantCount: variants.length,
    uniqueCombinationCount: combinations.length,
    variants,
    publishState: 'blocked_pending_operator_review'
  };
}

export function planSocialAccountLinks(rawCommand: unknown) {
  const input = PlanAccountLinksCommandSchema.parse(rawCommand);
  return {
    version: 1,
    requestId: input.requestId,
    portfolioId: input.portfolio.portfolioId,
    binding: input.portfolio.binding,
    emailGroupId: input.portfolio.emailGroupId,
    providerProfileRef: input.portfolio.providerProfileRef,
    linkIntents: input.portfolio.accounts.map((account) => {
      const provider = account.connection.providerKey;
      const state = account.connection.state;
      const nextAction =
        provider === 'manual_export'
          ? 'no_connection_required'
          : state === 'active'
            ? 'health_check'
            : state === 'disconnected'
              ? 'oauth_authorization_required'
              : state === 'credential_expired' || state === 'revoked'
                ? 'oauth_reauthorization_required'
                : 'provider_health_review_required';
      return {
        accountId: account.accountId,
        platform: account.platform,
        placement: account.placement,
        connectionId: account.connection.connectionId,
        providerKey: provider,
        providerProfileRef: input.portfolio.providerProfileRef,
        currentState: state,
        nextAction,
        interactionMode:
          provider === 'manual_export'
            ? 'manual'
            : provider === 'direct_platform'
              ? 'platform_oauth_redirect'
              : 'unified_provider_oauth_redirect',
        userInteractionRequired: provider !== 'manual_export' && state !== 'active',
        credentialSink:
          provider === 'manual_export'
            ? null
            : `secretref:keychain:${account.connection.connectionId}`,
        state:
          provider === 'manual_export' || state === 'active'
            ? 'connection_ready'
            : 'blocked_pending_operator_connection'
      };
    })
  };
}

type UploadQueueItem = z.infer<typeof UploadQueueItemSchema>;
type SocialAccount = z.infer<typeof SocialAccountSchema>;
type UploadDisclosure = UploadQueueItem['disclosure'];

export type PlanFacelessUploadSessionCommand = z.infer<typeof PlanUploadSessionCommandSchema>;

interface UploadSessionStepBase {
  stepId: string;
  offsetMinutes: number;
  scheduledAt: string;
  durationMinutes: number;
  jarvisPerforms: false;
}

export interface UploadSignInStep extends UploadSessionStepBase {
  kind: 'sign_in';
  instruction: string;
  credentialSource: 'operator_password_manager';
}

export interface UploadUploadStep extends UploadSessionStepBase {
  kind: 'upload';
  itemId: string;
  variantId: string;
  storyId: string;
  assetRef: string;
  assetDigest: string;
  renderManifestDigest: string;
  metadataRef: string;
  disclosure: UploadDisclosure;
  checklist: string[];
}

export interface UploadVerifyStep extends UploadSessionStepBase {
  kind: 'verify';
  instruction: string;
}

export interface UploadSignOutStep extends UploadSessionStepBase {
  kind: 'sign_out';
  instruction: string;
  required: boolean;
}

export type UploadSessionStep =
  UploadSignInStep | UploadUploadStep | UploadVerifyStep | UploadSignOutStep;

export interface UploadSessionBlock {
  blockIndex: number;
  accountId: string;
  platform: SocialAccount['platform'];
  placement: SocialAccount['placement'];
  publicLabel: string;
  role: SocialAccount['role'];
  connectionId: string;
  providerKey: SocialAccount['connection']['providerKey'];
  connectionIndependent: true;
  credentialSource: 'operator_password_manager';
  uploadCount: number;
  startOffsetMinutes: number;
  endOffsetMinutes: number;
  estimatedMinutes: number;
  steps: UploadSessionStep[];
}

export type FacelessUploadSessionPlan = ReturnType<typeof planFacelessUploadSession>;

function accountRoleRank(role: SocialAccount['role']): number {
  if (role === 'primary') return 0;
  if (role === 'experiment') return 1;
  return 2;
}

function uploadChecklist(account: SocialAccount, item: UploadQueueItem): string[] {
  const steps = ['open_the_composer_from_the_signed_in_profile', 'select_the_exact_rendered_file'];
  if (account.platform === 'youtube') {
    steps.push(
      'paste_the_prepared_title_within_100_characters',
      'paste_the_prepared_description_and_pinned_comment',
      'answer_the_made_for_kids_question',
      account.placement === 'watch'
        ? 'set_chapters_and_confirm_the_mid_roll_break_position'
        : 'confirm_the_vertical_master_and_cover_frame'
    );
    if (item.disclosure.realisticSyntheticMedia) {
      steps.push('declare_altered_or_synthetic_content_in_the_disclosure_step');
    }
  } else if (account.platform === 'tiktok') {
    steps.push(
      'paste_the_prepared_caption_and_hashtags',
      'set_the_cover_frame',
      'confirm_the_master_runs_at_least_one_minute_for_the_creator_rewards_format'
    );
    if (item.disclosure.containsGenerativeMedia) {
      steps.push('enable_the_ai_generated_content_label');
    }
    steps.push('confirm_who_can_watch_and_comment_settings');
  } else {
    steps.push('paste_the_prepared_caption', 'set_the_cover_frame', 'confirm_audio_rights');
    if (item.disclosure.containsGenerativeMedia) {
      steps.push('enable_the_ai_or_digitally_created_label');
    }
  }
  steps.push('confirm_the_visible_metadata_matches_the_prepared_pack', 'publish_the_post');
  return steps;
}

function rejectionReasons(item: UploadQueueItem, account: SocialAccount | undefined): string[] {
  const reasons: string[] = [];
  if (account === undefined) reasons.push('account_not_in_portfolio');
  if (!item.finalQcApproved) reasons.push('final_qc_not_approved');
  if (!item.rightsCleared) reasons.push('rights_not_cleared');
  if (item.disclosure.realisticSyntheticMedia && !item.disclosure.containsGenerativeMedia) {
    reasons.push('invalid_disclosure_declaration');
  }
  return reasons;
}

/**
 * Turns approved, rendered variants into one bounded, human-executed
 * sign-in → upload → verify → sign-out session sheet. Jarvis never signs in,
 * holds a platform password, or performs an upload here.
 */
export function planFacelessUploadSession(rawCommand: unknown) {
  const input = PlanUploadSessionCommandSchema.parse(rawCommand);
  const accountsById = new Map(
    input.portfolio.accounts.map((account) => [account.accountId, account])
  );
  const sessionStartMs = Date.parse(input.sessionStart);
  const scheduledAt = (offsetMinutes: number): string =>
    new Date(sessionStartMs + offsetMinutes * 60_000).toISOString();

  const rejected: { itemId: string; accountId: string; reasons: string[] }[] = [];
  const deferred: { itemId: string; accountId: string; reason: string }[] = [];
  const eligible: UploadQueueItem[] = [];
  for (const item of input.queue) {
    const reasons = rejectionReasons(item, accountsById.get(item.accountId));
    if (reasons.length > 0) {
      rejected.push({ itemId: item.itemId, accountId: item.accountId, reasons });
      continue;
    }
    eligible.push(item);
  }

  const byAccount = new Map<string, UploadQueueItem[]>();
  for (const item of eligible) {
    const bucket = byAccount.get(item.accountId) ?? [];
    bucket.push(item);
    byAccount.set(item.accountId, bucket);
  }
  const orderedAccounts = [...byAccount.keys()]
    .map((accountId) => {
      const account = accountsById.get(accountId);
      if (account === undefined) throw new Error(`Account ${accountId} left the portfolio`);
      return account;
    })
    .sort(
      (left, right) =>
        accountRoleRank(left.role) - accountRoleRank(right.role) ||
        left.accountId.localeCompare(right.accountId)
    );

  const { policy } = input;
  const blockOverheadMinutes = policy.signInMinutes + policy.verifyMinutes + policy.signOutMinutes;
  let cursorMinutes = 0;
  let accountsUsed = 0;
  const blocks: UploadSessionBlock[] = [];

  for (const account of orderedAccounts) {
    const items = (byAccount.get(account.accountId) ?? []).sort(
      (left, right) => left.priority - right.priority || left.itemId.localeCompare(right.itemId)
    );
    const withinAccountCap = items.slice(0, policy.maxUploadsPerAccount);
    for (const overflow of items.slice(policy.maxUploadsPerAccount)) {
      deferred.push({
        itemId: overflow.itemId,
        accountId: account.accountId,
        reason: 'account_upload_cap_reached'
      });
    }
    if (accountsUsed >= policy.maxAccountsPerSession) {
      for (const held of withinAccountCap) {
        deferred.push({
          itemId: held.itemId,
          accountId: account.accountId,
          reason: 'session_account_cap_reached'
        });
      }
      continue;
    }
    const remainingMinutes = policy.sessionMinutes - cursorMinutes;
    const uploadCapacity = Math.max(
      0,
      Math.floor((remainingMinutes - blockOverheadMinutes) / policy.uploadMinutes)
    );
    const scheduledItems = withinAccountCap.slice(0, uploadCapacity);
    for (const held of withinAccountCap.slice(uploadCapacity)) {
      deferred.push({
        itemId: held.itemId,
        accountId: account.accountId,
        reason: 'session_minutes_exhausted'
      });
    }
    if (scheduledItems.length === 0) continue;

    const startOffsetMinutes = cursorMinutes;
    let stepOffset = cursorMinutes;
    const steps: UploadSessionStep[] = [
      {
        stepId: `${account.accountId}:sign_in`,
        kind: 'sign_in',
        offsetMinutes: stepOffset,
        scheduledAt: scheduledAt(stepOffset),
        durationMinutes: policy.signInMinutes,
        instruction: `Sign in to ${account.platform} as ${account.publicLabel} using the operator password manager.`,
        credentialSource: 'operator_password_manager',
        jarvisPerforms: false
      }
    ];
    stepOffset += policy.signInMinutes;
    for (const item of scheduledItems) {
      steps.push({
        stepId: `${account.accountId}:upload:${item.itemId}`,
        kind: 'upload',
        offsetMinutes: stepOffset,
        scheduledAt: scheduledAt(stepOffset),
        durationMinutes: policy.uploadMinutes,
        itemId: item.itemId,
        variantId: item.variantId,
        storyId: item.storyId,
        assetRef: item.assetRef,
        assetDigest: item.assetDigest,
        renderManifestDigest: item.renderManifestDigest,
        metadataRef: item.metadataRef,
        disclosure: item.disclosure,
        checklist: uploadChecklist(account, item),
        jarvisPerforms: false
      });
      stepOffset += policy.uploadMinutes;
    }
    steps.push({
      stepId: `${account.accountId}:verify`,
      kind: 'verify',
      offsetMinutes: stepOffset,
      scheduledAt: scheduledAt(stepOffset),
      durationMinutes: policy.verifyMinutes,
      instruction:
        'Confirm every post is live, then record the public URL and posted time for each item.',
      jarvisPerforms: false
    });
    stepOffset += policy.verifyMinutes;
    steps.push({
      stepId: `${account.accountId}:sign_out`,
      kind: 'sign_out',
      offsetMinutes: stepOffset,
      scheduledAt: scheduledAt(stepOffset),
      durationMinutes: policy.signOutMinutes,
      instruction: 'Sign out completely before opening the next account.',
      required: policy.requireSignOut,
      jarvisPerforms: false
    });
    stepOffset += policy.signOutMinutes;

    blocks.push({
      blockIndex: accountsUsed,
      accountId: account.accountId,
      platform: account.platform,
      placement: account.placement,
      publicLabel: account.publicLabel,
      role: account.role,
      connectionId: account.connection.connectionId,
      providerKey: account.connection.providerKey,
      connectionIndependent: true,
      credentialSource: 'operator_password_manager',
      uploadCount: scheduledItems.length,
      startOffsetMinutes,
      endOffsetMinutes: stepOffset,
      estimatedMinutes: stepOffset - startOffsetMinutes,
      steps
    });
    cursorMinutes = stepOffset;
    accountsUsed += 1;
  }

  const scheduledCount = blocks.reduce((total, block) => total + block.uploadCount, 0);
  return {
    version: 1,
    requestId: input.requestId,
    sessionId: input.sessionId,
    mode: 'operator_manual_upload',
    sessionStart: input.sessionStart,
    portfolioId: input.portfolio.portfolioId,
    binding: input.portfolio.binding,
    emailGroupId: input.portfolio.emailGroupId,
    blocks,
    totals: {
      sessionMinutes: policy.sessionMinutes,
      estimatedMinutes: cursorMinutes,
      remainingMinutes: policy.sessionMinutes - cursorMinutes,
      accountBlocks: blocks.length,
      scheduledUploads: scheduledCount,
      deferredItems: deferred.length,
      rejectedItems: rejected.length
    },
    deferred,
    rejected,
    completionLog: {
      recordPerItem: [
        'itemId',
        'accountId',
        'publicPostUrl',
        'postedAt',
        'disclosureApplied',
        'incidentNotes'
      ],
      analyticsCheckpoints: ['24h', '7d', '30d'],
      instruction:
        'Record every published item before the session ends; unrecorded posts count as incomplete analytics coverage at the pilot gate.'
    },
    boundaries: {
      jarvisSignsIn: false,
      jarvisHoldsPlatformPassword: false,
      jarvisUploads: false,
      jarvisPublishes: false,
      credentialSource: 'operator_password_manager'
    },
    sessionState: 'ready_for_operator_execution'
  };
}

export function createFacelessContentWorker(clientId: string): BasicWorker {
  const boundClientId = ClientIdSchema.parse(clientId);
  const workerId = `${boundClientId}_faceless_content`;
  return {
    id: workerId,
    async execute(context: WorkerContext): Promise<JsonValue> {
      await Promise.resolve();
      if (context.clientId !== boundClientId) {
        throw new Error(`Faceless content worker is restricted to ${boundClientId}`);
      }
      if (context.automation !== FACELESS_CONTENT_AUTOMATION_ID) {
        throw new Error(
          `Faceless content worker only handles ${FACELESS_CONTENT_AUTOMATION_ID} automation`
        );
      }
      const command = FacelessContentCommandSchema.parse(context.input);
      if (command.command === 'plan') {
        const result = planFacelessContentWorkflow(command);
        context.logger.log(workerId, 'Supervisor', `planned ${command.lane} content workflow`);
        return JsonValueSchema.parse(result);
      }
      if (command.command === 'compose_variants') {
        if (command.portfolio.binding.scopeId !== `client:${boundClientId}`) {
          throw new Error(
            `Social account portfolio scope ${command.portfolio.binding.scopeId} is not bound to client:${boundClientId}`
          );
        }
        const result = composeFacelessContentVariants(command);
        context.logger.log(
          workerId,
          'Supervisor',
          `composed ${result.variantCount} content variants`
        );
        return JsonValueSchema.parse(result);
      }
      if (command.command === 'plan_account_links') {
        if (command.portfolio.binding.scopeId !== `client:${boundClientId}`) {
          throw new Error(
            `Social account portfolio scope ${command.portfolio.binding.scopeId} is not bound to client:${boundClientId}`
          );
        }
        const result = planSocialAccountLinks(command);
        context.logger.log(
          workerId,
          'Supervisor',
          `planned ${result.linkIntents.length} social account connections`
        );
        return JsonValueSchema.parse(result);
      }
      if (command.command === 'plan_upload_session') {
        if (command.portfolio.binding.scopeId !== `client:${boundClientId}`) {
          throw new Error(
            `Social account portfolio scope ${command.portfolio.binding.scopeId} is not bound to client:${boundClientId}`
          );
        }
        const result = planFacelessUploadSession(command);
        context.logger.log(
          workerId,
          'Supervisor',
          `planned ${result.totals.scheduledUploads} manual uploads across ${result.totals.accountBlocks} account blocks`
        );
        return JsonValueSchema.parse(result);
      }
      const result = evaluateFacelessContentPilot(command.pilotGate);
      context.logger.log(workerId, 'Supervisor', 'evaluated faceless content pilot gate');
      return JsonValueSchema.parse({
        version: 1,
        requestId: command.requestId,
        ...result
      });
    }
  };
}
