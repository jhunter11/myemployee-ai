import { describe, expect, it } from 'vitest';

import type { WorkerContext } from '../../src/agents/contracts';
import {
  FACELESS_CONTENT_AUTOMATION_ID,
  FacelessContentCommandSchema,
  SocialAccountPortfolioSchema,
  composeFacelessContentVariants,
  createFacelessContentWorker,
  deriveSocialAccountGroupId,
  evaluateFacelessContentPilot,
  planFacelessContentWorkflow,
  planFacelessUploadSession,
  planSocialAccountLinks
} from '../../src/content/faceless-content-workflow';

function pilotGate(overrides: Record<string, unknown> = {}) {
  return {
    policy: {
      winnerDefinition:
        'A winner beats the prior seven-day channel median for engaged watch rate and shares.',
      minPublishedPosts: 12,
      minWinningPosts: 3,
      minAnalyticsCoverageBps: 10_000,
      minKnownCostCoverageBps: 10_000
    },
    observation: {
      publishedPosts: 12,
      winningPosts: 3,
      analyticsCoverageBps: 10_000,
      knownCostCoverageBps: 10_000,
      policyIncidents: 0,
      rightsIncidents: 0,
      operatorApprovedPaidGeneration: true,
      evidenceRefs: ['analytics:creator-lab:pilot-001'],
      ...overrides
    }
  };
}

function planCommand(
  lane: 'short_story' | 'broll_short' | 'cinematic_short' | 'longform',
  overrides: Record<string, unknown> = {}
) {
  return {
    command: 'plan' as const,
    requestId: `request-${lane}`,
    series: {
      id: 'midnight-memos',
      title: 'Midnight Memos',
      targetAudience: 'Curious adults who enjoy compact speculative mysteries.',
      audiencePromise: 'Every episode resolves one strange rule with a fair, human payoff.',
      creativeThesis:
        'Small impossible events reveal ordinary decisions people avoid making in real life.',
      recurringDevice: 'Each story begins with a timestamped memo that should not exist.'
    },
    concept: {
      id: `concept-${lane}`,
      title: 'The Memo From Tomorrow',
      premise:
        'A night-shift archivist receives a memo written by their future self with one line erased.',
      viewerPayoff:
        'The erased line is a choice, not a warning, and the archivist must decide who remembers it.',
      originalContribution:
        'An original closed-loop mystery about responsibility, memory, and choosing an imperfect future.',
      source: {
        kind: 'original' as const,
        rightsConfirmed: true as const,
        references: []
      },
      interestEvidence: [
        {
          kind: 'operator_hypothesis' as const,
          sourceRef: 'decision:faceless-pilot-2026-07-23',
          observedAt: '2026-07-23T12:00:00.000Z'
        }
      ]
    },
    lane,
    productionTier: 'poc' as const,
    containsGenerativeMedia: true,
    realisticSyntheticMedia: false,
    usesRealPersonLikeness: false,
    likenessConsentConfirmed: false,
    ...overrides
  };
}

function portfolio() {
  return {
    version: 1 as const,
    portfolioId: 'portfolio-midnight-memos',
    binding: {
      kind: 'client' as const,
      scopeId: 'client:creator_lab'
    },
    emailGroupId: 'email_group:111111111111111111111111111111111111111111111111',
    providerProfileRef: 'publisher-profile:midnight-memos',
    accounts: [
      {
        accountId: 'account-youtube-main',
        platform: 'youtube' as const,
        placement: 'shorts' as const,
        publicLabel: '@midnightmemos',
        connection: {
          connectionId: 'social_youtube_main',
          providerKey: 'zernio' as const,
          credentialRef: 'secretref:keychain:social_youtube_main',
          state: 'active' as const,
          version: 1
        },
        role: 'primary' as const,
        audience: 'English-language speculative mystery viewers.',
        allowedLanes: ['short_story', 'cinematic_short']
      },
      {
        accountId: 'account-tiktok-main',
        platform: 'tiktok' as const,
        placement: 'reels' as const,
        publicLabel: '@midnightmemos',
        connection: {
          connectionId: 'social_tiktok_main',
          providerKey: 'zernio' as const,
          credentialRef: 'secretref:keychain:social_tiktok_main',
          state: 'active' as const,
          version: 1
        },
        role: 'primary' as const,
        audience: 'TikTok viewers who watch one-minute mystery stories.',
        allowedLanes: ['short_story', 'cinematic_short']
      },
      {
        accountId: 'account-instagram-alt',
        platform: 'instagram' as const,
        placement: 'reels' as const,
        publicLabel: '@tomorrowarchive',
        connection: {
          connectionId: 'social_instagram_alt',
          providerKey: 'zernio' as const,
          credentialRef: 'secretref:keychain:social_instagram_alt',
          state: 'active' as const,
          version: 1
        },
        role: 'experiment' as const,
        audience: 'Visual-fiction and cinematic-art viewers.',
        allowedLanes: ['short_story', 'cinematic_short']
      },
      {
        accountId: 'account-facebook-alt',
        platform: 'facebook' as const,
        placement: 'reels' as const,
        publicLabel: 'Tomorrow Archive',
        connection: {
          connectionId: 'social_facebook_alt',
          providerKey: 'zernio' as const,
          credentialRef: 'secretref:keychain:social_facebook_alt',
          state: 'active' as const,
          version: 1
        },
        role: 'experiment' as const,
        audience: 'Older mystery and narrated-fiction viewers.',
        allowedLanes: ['short_story']
      }
    ]
  };
}

function variantCommand(overrides: Record<string, unknown> = {}) {
  return {
    command: 'compose_variants' as const,
    requestId: 'request-compose-midnight-memos',
    lane: 'short_story' as const,
    story: {
      storyId: 'story-memo-from-tomorrow',
      title: 'The Memo From Tomorrow',
      scriptDigest: `sha256:${'a'.repeat(64)}`,
      originalStory: true as const,
      containsGenerativeMedia: true,
      realisticSyntheticMedia: false
    },
    portfolio: portfolio(),
    voices: [
      {
        voiceId: 'voice-calm-archivist',
        provider: 'elevenlabs' as const,
        kind: 'licensed_stock' as const,
        licenseRef: 'license:elevenlabs:voice-calm-archivist',
        consentRef: null
      },
      {
        voiceId: 'voice-tense-archivist',
        provider: 'elevenlabs' as const,
        kind: 'operator_clone' as const,
        licenseRef: 'license:elevenlabs:commercial-plan',
        consentRef: 'consent:operator:voice-tense-archivist'
      }
    ],
    visualPacks: [
      {
        visualPackId: 'visual-archive-broll',
        provider: 'pexels' as const,
        strategy: 'owned_licensed_broll' as const,
        rightsRef: 'rights:pexels:archive-broll-001',
        containsGenerativeMedia: false
      },
      {
        visualPackId: 'visual-clock-storyboard',
        provider: 'local' as const,
        strategy: 'poc_storyboard' as const,
        rightsRef: 'rights:creator-lab:clock-storyboard',
        containsGenerativeMedia: true
      }
    ],
    policy: {
      maxVariants: 4,
      minChangedDimensions: 2 as const,
      staggerMinutes: 180,
      requireExactPublishApproval: true as const
    },
    ...overrides
  };
}

function uploadSessionCommand(overrides: Record<string, unknown> = {}) {
  const composed = composeFacelessContentVariants(variantCommand());
  return {
    command: 'plan_upload_session' as const,
    requestId: 'request-daily-upload-session',
    sessionId: 'session-2026-07-24-morning',
    sessionStart: '2026-07-24T09:00:00.000Z',
    portfolio: portfolio(),
    queue: composed.variants.map((variant, index) => ({
      itemId: `item-${index + 1}-${variant.accountId}`,
      variantId: variant.variantId,
      accountId: variant.accountId,
      storyId: variant.storyId,
      assetRef: `render:/Users/operator/faceless/${variant.variantId}.mp4`,
      assetDigest: `sha256:${'0'.repeat(63)}${index + 1}`,
      renderManifestDigest: variant.renderManifestDigest,
      metadataRef: `metadata:${variant.variantId}`,
      finalQcApproved: true,
      rightsCleared: true,
      disclosure: variant.renderManifest.disclosures,
      priority: index + 1
    })),
    policy: {
      sessionMinutes: 60,
      signInMinutes: 2,
      uploadMinutes: 6,
      verifyMinutes: 2,
      signOutMinutes: 1,
      requireSignOut: true as const,
      maxAccountsPerSession: 4,
      maxUploadsPerAccount: 3
    },
    ...overrides
  };
}

describe('faceless content workflow', () => {
  it.each(['short_story', 'broll_short', 'cinematic_short'] as const)(
    'plans a 75-second native vertical master for %s',
    (lane) => {
      const plan = planFacelessContentWorkflow(planCommand(lane));

      expect(plan.lane).toBe(lane);
      expect(plan.targets.map((target) => target.platform)).toEqual(['tiktok', 'youtube_shorts']);
      expect(plan.targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            aspectRatio: '9:16',
            width: 1080,
            height: 1920,
            durationSeconds: 75
          })
        ])
      );
      expect(plan.beatSheet.at(-1)?.endSecond).toBe(75);
      expect(plan.publishState).toBe('blocked_pending_operator_review');
      expect(plan.monetization.disclaimer).toMatch(/not guarantee/i);
    }
  );

  it('plans a 10-minute long-form master with short derivatives', () => {
    const plan = planFacelessContentWorkflow(planCommand('longform'));

    expect(plan.targets).toEqual([
      expect.objectContaining({
        platform: 'youtube_watch',
        aspectRatio: '16:9',
        width: 1920,
        height: 1080,
        durationSeconds: 600
      })
    ]);
    expect(plan.beatSheet.at(-1)?.endSecond).toBe(600);
    expect(plan.deliverables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'master_16x9' }),
        expect.objectContaining({ id: 'short_derivatives', quantity: 3 })
      ])
    );
  });

  it('keeps premium Higgsfield generation blocked until the complete pilot gate passes', () => {
    const held = planFacelessContentWorkflow(
      planCommand('cinematic_short', {
        productionTier: 'premium',
        pilotGate: pilotGate({ winningPosts: 2 })
      })
    );

    expect(held.provider.higgsfieldStatus).toBe('blocked_pending_proof');
    expect(held.provider.selected).toBe('poc_storyboard');
    expect(held.provider.gateReasons).toContain('insufficient_winning_posts');

    const promoted = planFacelessContentWorkflow(
      planCommand('cinematic_short', {
        productionTier: 'premium',
        pilotGate: pilotGate()
      })
    );

    expect(promoted.provider).toEqual(
      expect.objectContaining({
        selected: 'higgsfield_cinema_manual',
        enhancement: null,
        higgsfieldStatus: 'eligible_manual',
        integrationMode: 'manual_manifest'
      })
    );
    expect(promoted.provider.gateReasons).toEqual([]);
  });

  it('adds Higgsfield as selected hero-shot enhancement without replacing B-roll or long-form edit', () => {
    for (const lane of ['broll_short', 'longform'] as const) {
      const plan = planFacelessContentWorkflow(
        planCommand(lane, {
          productionTier: 'premium',
          pilotGate: pilotGate()
        })
      );

      expect(plan.provider.selected).toBe(
        lane === 'broll_short' ? 'owned_licensed_broll' : 'hybrid_longform'
      );
      expect(plan.provider.enhancement).toBe('higgsfield_cinema_manual');
      expect(plan.provider.higgsfieldStatus).toBe('eligible_manual');
    }
  });

  it('fails the pilot closed for incomplete evidence, unknown costs, incidents, or no approval', () => {
    const decision = evaluateFacelessContentPilot(
      pilotGate({
        publishedPosts: 8,
        analyticsCoverageBps: 9_000,
        knownCostCoverageBps: 0,
        policyIncidents: 1,
        rightsIncidents: 1,
        operatorApprovedPaidGeneration: false,
        evidenceRefs: []
      })
    );

    expect(decision.promoteToPaidGeneration).toBe(false);
    expect(decision.reasons).toEqual([
      'insufficient_published_posts',
      'analytics_coverage_incomplete',
      'known_cost_coverage_incomplete',
      'policy_incident_detected',
      'rights_incident_detected',
      'operator_approval_required',
      'evidence_reference_required'
    ]);
  });

  it('requires confirmed source rights, references for non-original sources, and likeness consent', () => {
    expect(() =>
      planFacelessContentWorkflow(
        planCommand('short_story', {
          concept: {
            ...planCommand('short_story').concept,
            source: {
              kind: 'licensed',
              rightsConfirmed: true,
              references: []
            }
          }
        })
      )
    ).toThrow(/reference/i);

    expect(() =>
      FacelessContentCommandSchema.parse({
        ...planCommand('short_story'),
        concept: {
          ...planCommand('short_story').concept,
          source: {
            kind: 'original',
            rightsConfirmed: false,
            references: []
          }
        }
      })
    ).toThrow();

    expect(() =>
      planFacelessContentWorkflow(
        planCommand('cinematic_short', {
          usesRealPersonLikeness: true,
          likenessConsentConfirmed: false
        })
      )
    ).toThrow(/consent/i);
  });

  it('requires conservative AI labels for generative media and rejects unknown input fields', () => {
    const plan = planFacelessContentWorkflow(
      planCommand('short_story', { realisticSyntheticMedia: true })
    );

    expect(plan.compliance.aiDisclosure).toEqual({
      tiktokCreatorLabelRequired: true,
      youtubeAiUseDisclosureRequired: true,
      realisticSyntheticMedia: true
    });
    expect(() =>
      FacelessContentCommandSchema.parse({ ...planCommand('short_story'), publishNow: true })
    ).toThrow();
  });

  it('constructs an exact tenant-bound, side-effect-free Jarvis worker', async () => {
    const worker = createFacelessContentWorker('creator_lab');
    const logs: string[] = [];
    const context = {
      clientId: 'creator_lab',
      automation: FACELESS_CONTENT_AUTOMATION_ID,
      runId: 'faceless-run-001',
      clientRoot: '/tmp/jarvis-clients',
      clientDirectory: '/tmp/jarvis-clients/creator_lab',
      memoryDirectory: '/tmp/jarvis-clients/creator_lab/memory',
      input: planCommand('short_story'),
      toolPolicy: {
        description: 'No tools required for deterministic planning.',
        tools_allow: [],
        tools_deny: ['network', 'publish'],
        requires_elevated_approval: false
      },
      networkPolicy: { mode: 'none' as const },
      logger: {
        start: () => undefined,
        log: (from: string, to: string, message: string) => logs.push(`${from}:${to}:${message}`),
        save: () => Promise.resolve('/tmp/unused.md')
      }
    } satisfies WorkerContext;

    await expect(worker.execute(context)).resolves.toEqual(
      expect.objectContaining({
        lane: 'short_story',
        publishState: 'blocked_pending_operator_review'
      })
    );
    expect(worker.id).toBe('creator_lab_faceless_content');
    expect(logs).toContain(
      'creator_lab_faceless_content:Supervisor:planned short_story content workflow'
    );

    await expect(worker.execute({ ...context, clientId: 'another_client' })).rejects.toThrow(
      /restricted to creator_lab/i
    );
    await expect(worker.execute({ ...context, automation: 'another-automation' })).rejects.toThrow(
      /faceless-content/i
    );
  });

  it('derives a normalized, tenant-bound email group without exposing the email', () => {
    const first = deriveSocialAccountGroupId({
      clientId: 'creator_lab',
      email: '  Creator+Studio@Example.COM ',
      hmacKey: 'test-only-tenant-secret-that-is-long-enough'
    });
    const second = deriveSocialAccountGroupId({
      clientId: 'creator_lab',
      email: 'creator+studio@example.com',
      hmacKey: 'test-only-tenant-secret-that-is-long-enough'
    });
    const otherTenant = deriveSocialAccountGroupId({
      clientId: 'another_client',
      email: 'creator+studio@example.com',
      hmacKey: 'test-only-tenant-secret-that-is-long-enough'
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^email_group:[a-f0-9]{48}$/);
    expect(first).not.toContain('creator');
    expect(otherTenant).not.toBe(first);
  });

  it('groups four linked social accounts without accepting raw email or credential values', () => {
    const parsed = SocialAccountPortfolioSchema.parse(portfolio());

    expect(parsed.accounts.map((account) => account.platform)).toEqual([
      'youtube',
      'tiktok',
      'instagram',
      'facebook'
    ]);
    expect(JSON.stringify(parsed)).not.toContain('@example.com');
    expect(() =>
      SocialAccountPortfolioSchema.parse({
        ...portfolio(),
        email: 'creator@example.com'
      })
    ).toThrow();
    expect(() =>
      SocialAccountPortfolioSchema.parse({
        ...portfolio(),
        accounts: [
          {
            ...portfolio().accounts[0],
            publicLabel: 'creator@example.com'
          }
        ]
      })
    ).toThrow(/raw email/i);
    expect(() =>
      SocialAccountPortfolioSchema.parse({
        ...portfolio(),
        accounts: [
          {
            ...portfolio().accounts[0],
            connection: {
              ...portfolio().accounts[0]?.connection,
              credentialRef: 'actual-oauth-access-token'
            }
          }
        ]
      })
    ).toThrow(/credential/i);
  });

  it('plans exact OAuth connection handoffs for disconnected accounts without producing tokens', () => {
    const disconnectedPortfolio = {
      ...portfolio(),
      accounts: portfolio().accounts.map((account, index) =>
        index === 0
          ? {
              ...account,
              connection: {
                ...account.connection,
                credentialRef: null,
                state: 'disconnected' as const
              }
            }
          : account
      )
    };
    const result = planSocialAccountLinks({
      command: 'plan_account_links',
      requestId: 'request-link-social-accounts',
      portfolio: disconnectedPortfolio
    });

    expect(result.linkIntents[0]).toEqual(
      expect.objectContaining({
        accountId: 'account-youtube-main',
        providerKey: 'zernio',
        nextAction: 'oauth_authorization_required',
        interactionMode: 'unified_provider_oauth_redirect',
        userInteractionRequired: true,
        credentialSink: 'secretref:keychain:social_youtube_main',
        state: 'blocked_pending_operator_connection'
      })
    );
    expect(result.linkIntents[1]).toEqual(
      expect.objectContaining({
        currentState: 'active',
        nextAction: 'health_check',
        state: 'connection_ready'
      })
    );
    expect(JSON.stringify(result)).not.toMatch(/access[_-]?token|refresh[_-]?token/i);
  });

  it('reuses one original story as unique voice and visual combinations across accounts', () => {
    const result = composeFacelessContentVariants(variantCommand());

    expect(result.variants).toHaveLength(4);
    expect(
      new Set(result.variants.map((variant) => `${variant.voiceId}:${variant.visualPackId}`)).size
    ).toBe(4);
    expect(new Set(result.variants.map((variant) => variant.accountId)).size).toBe(4);
    expect(
      result.variants.every((variant) => variant.storyId === variantCommand().story.storyId)
    ).toBe(true);
    expect(result.variants.every((variant) => variant.publishIntent.externalEffect)).toBe(true);
    expect(
      result.variants.every(
        (variant) => variant.publishIntent.state === 'blocked_pending_operator_review'
      )
    ).toBe(true);
    expect(
      result.variants.every((variant) => variant.publishIntent.payloadDigest.startsWith('sha256:'))
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain('test-only-tenant-secret');
  });

  it('fails closed when accounts outnumber unique voice and visual treatments', () => {
    expect(() =>
      composeFacelessContentVariants(
        variantCommand({
          voices: [variantCommand().voices[0]],
          visualPacks: [variantCommand().visualPacks[0]]
        })
      )
    ).toThrow(/unique.*combination/i);
  });

  it('requires consent evidence for a cloned voice and rights evidence for every visual pack', () => {
    expect(() =>
      composeFacelessContentVariants(
        variantCommand({
          voices: [variantCommand().voices[0], { ...variantCommand().voices[1], consentRef: null }]
        })
      )
    ).toThrow(/consent/i);

    expect(() =>
      composeFacelessContentVariants(
        variantCommand({
          visualPacks: [
            variantCommand().visualPacks[0],
            { ...variantCommand().visualPacks[1], rightsRef: '' }
          ]
        })
      )
    ).toThrow();
  });

  it('routes compose-variants through the tenant-bound worker without linking or publishing', async () => {
    const worker = createFacelessContentWorker('creator_lab');
    const context = {
      clientId: 'creator_lab',
      automation: FACELESS_CONTENT_AUTOMATION_ID,
      runId: 'faceless-compose-001',
      clientRoot: '/tmp/jarvis-clients',
      clientDirectory: '/tmp/jarvis-clients/creator_lab',
      memoryDirectory: '/tmp/jarvis-clients/creator_lab/memory',
      input: variantCommand(),
      toolPolicy: {
        description: 'No tools required for deterministic composition.',
        tools_allow: [],
        tools_deny: ['network', 'publish'],
        requires_elevated_approval: false
      },
      networkPolicy: { mode: 'none' as const },
      logger: {
        start: () => undefined,
        log: () => undefined,
        save: () => Promise.resolve('/tmp/unused.md')
      }
    } satisfies WorkerContext;

    const result = await worker.execute(context);
    expect(JSON.stringify(result)).toContain('"state":"blocked_pending_operator_review"');
    await expect(
      worker.execute({
        ...context,
        input: variantCommand({
          portfolio: {
            ...portfolio(),
            binding: { kind: 'client', scopeId: 'client:another_client' }
          }
        })
      })
    ).rejects.toThrow(/not bound to client:creator_lab/i);
  });

  it('sequences one sign-in, upload, and sign-out block per account inside the session budget', () => {
    const session = planFacelessUploadSession(uploadSessionCommand());

    expect(session.mode).toBe('operator_manual_upload');
    expect(session.sessionState).toBe('ready_for_operator_execution');
    expect(session.blocks.map((block) => block.accountId)).toEqual([
      'account-tiktok-main',
      'account-youtube-main',
      'account-facebook-alt',
      'account-instagram-alt'
    ]);
    for (const block of session.blocks) {
      const kinds = block.steps.map((step) => (step as { kind: string }).kind);
      expect(kinds[0]).toBe('sign_in');
      expect(kinds.at(-1)).toBe('sign_out');
      expect(kinds).toContain('verify');
      expect(kinds.filter((kind) => kind === 'upload')).toHaveLength(block.uploadCount);
      expect(block.credentialSource).toBe('operator_password_manager');
    }
    const offsets = session.blocks.map((block) => block.startOffsetMinutes);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    expect(session.blocks[0]?.steps[0]).toMatchObject({
      kind: 'sign_in',
      scheduledAt: '2026-07-24T09:00:00.000Z',
      jarvisPerforms: false
    });
    expect(session.totals).toMatchObject({
      sessionMinutes: 60,
      estimatedMinutes: 44,
      remainingMinutes: 16,
      accountBlocks: 4,
      scheduledUploads: 4,
      deferredItems: 0,
      rejectedItems: 0
    });
    expect(session.boundaries).toMatchObject({
      jarvisSignsIn: false,
      jarvisHoldsPlatformPassword: false,
      jarvisUploads: false,
      jarvisPublishes: false
    });
  });

  it('defers overflow instead of overrunning the operator hour', () => {
    const session = planFacelessUploadSession(
      uploadSessionCommand({
        policy: { ...uploadSessionCommand().policy, sessionMinutes: 30 }
      })
    );

    expect(session.totals.estimatedMinutes).toBeLessThanOrEqual(30);
    expect(session.totals.scheduledUploads).toBe(2);
    expect(session.deferred).toHaveLength(2);
    expect(session.deferred.every((entry) => entry.reason === 'session_minutes_exhausted')).toBe(
      true
    );
    expect(session.totals.rejectedItems).toBe(0);
  });

  it('rejects unapproved, uncleared, or unknown-account items without scheduling them', () => {
    const base = uploadSessionCommand();
    const queue = base.queue.map((item, index) => {
      if (index === 0) return { ...item, finalQcApproved: false };
      if (index === 1) return { ...item, rightsCleared: false };
      if (index === 2) return { ...item, accountId: 'account-not-in-portfolio' };
      return item;
    });
    const session = planFacelessUploadSession(uploadSessionCommand({ queue }));

    expect(session.totals.scheduledUploads).toBe(1);
    expect(session.rejected.map((entry) => entry.reasons.join(','))).toEqual([
      'final_qc_not_approved',
      'rights_not_cleared',
      'account_not_in_portfolio'
    ]);
  });

  it('emits platform-native disclosure steps and never a credential', () => {
    const base = uploadSessionCommand();
    const session = planFacelessUploadSession(
      uploadSessionCommand({
        queue: base.queue.map((item) =>
          item.accountId === 'account-youtube-main'
            ? {
                ...item,
                disclosure: { containsGenerativeMedia: true, realisticSyntheticMedia: true }
              }
            : item
        )
      })
    );

    const stepsFor = (accountId: string) =>
      session.blocks
        .find((block) => block.accountId === accountId)
        ?.steps.flatMap((step) => (step as { checklist?: string[] }).checklist ?? []) ?? [];

    expect(stepsFor('account-tiktok-main')).toContain('enable_the_ai_generated_content_label');
    expect(stepsFor('account-tiktok-main')).toContain(
      'confirm_the_master_runs_at_least_one_minute_for_the_creator_rewards_format'
    );
    expect(stepsFor('account-youtube-main')).toContain(
      'declare_altered_or_synthetic_content_in_the_disclosure_step'
    );
    expect(stepsFor('account-instagram-alt')).toContain('enable_the_ai_or_digitally_created_label');

    const serialized = JSON.stringify(session);
    expect(serialized).not.toMatch(/secretref:/);
    expect(serialized).not.toMatch(/access[_-]?token|refresh[_-]?token/i);
  });

  it('refuses duplicate assets and sessions too short for one complete block', () => {
    const base = uploadSessionCommand();
    const firstItem = base.queue[0];
    const secondItem = base.queue[1];
    expect(firstItem).toBeDefined();
    expect(secondItem).toBeDefined();
    expect(() =>
      planFacelessUploadSession(
        uploadSessionCommand({
          queue: [firstItem, { ...secondItem, assetDigest: firstItem?.assetDigest }]
        })
      )
    ).toThrow(/same rendered asset/i);

    expect(() =>
      planFacelessUploadSession(
        uploadSessionCommand({
          policy: { ...base.policy, sessionMinutes: 5 }
        })
      )
    ).toThrow(/cannot hold one sign-in/i);
  });

  it('routes the daily upload session through the tenant-bound worker', async () => {
    const worker = createFacelessContentWorker('creator_lab');
    const context = {
      clientId: 'creator_lab',
      automation: FACELESS_CONTENT_AUTOMATION_ID,
      runId: 'faceless-session-001',
      clientRoot: '/tmp/jarvis-clients',
      clientDirectory: '/tmp/jarvis-clients/creator_lab',
      memoryDirectory: '/tmp/jarvis-clients/creator_lab/memory',
      input: uploadSessionCommand(),
      toolPolicy: {
        description: 'Session planning cannot sign in, upload, or publish.',
        tools_allow: [],
        tools_deny: ['network', 'publish', 'secrets_read'],
        requires_elevated_approval: false
      },
      networkPolicy: { mode: 'none' as const },
      logger: {
        start: () => undefined,
        log: () => undefined,
        save: () => Promise.resolve('/tmp/unused.md')
      }
    } satisfies WorkerContext;

    const result = await worker.execute(context);
    expect(JSON.stringify(result)).toContain('"sessionState":"ready_for_operator_execution"');
    expect(JSON.stringify(result)).toContain('"jarvisUploads":false');
    await expect(
      worker.execute({
        ...context,
        input: uploadSessionCommand({
          portfolio: {
            ...portfolio(),
            binding: { kind: 'client', scopeId: 'client:another_client' }
          }
        })
      })
    ).rejects.toThrow(/not bound to client:creator_lab/i);
  });

  it('routes account-link planning through the same tenant-bound worker', async () => {
    const worker = createFacelessContentWorker('creator_lab');
    const context = {
      clientId: 'creator_lab',
      automation: FACELESS_CONTENT_AUTOMATION_ID,
      runId: 'faceless-link-001',
      clientRoot: '/tmp/jarvis-clients',
      clientDirectory: '/tmp/jarvis-clients/creator_lab',
      memoryDirectory: '/tmp/jarvis-clients/creator_lab/memory',
      input: {
        command: 'plan_account_links',
        requestId: 'request-link-social-accounts',
        portfolio: portfolio()
      },
      toolPolicy: {
        description: 'Connection planning cannot open OAuth or write credentials.',
        tools_allow: [],
        tools_deny: ['network', 'secrets_write'],
        requires_elevated_approval: false
      },
      networkPolicy: { mode: 'none' as const },
      logger: {
        start: () => undefined,
        log: () => undefined,
        save: () => Promise.resolve('/tmp/unused.md')
      }
    } satisfies WorkerContext;

    const result = await worker.execute(context);
    expect(JSON.stringify(result)).toContain('"accountId":"account-youtube-main"');
    expect(JSON.stringify(result)).toContain('"state":"connection_ready"');
  });
});
