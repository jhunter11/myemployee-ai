import { describe, expect, it } from 'vitest';

import {
  composeFacelessContentVariants,
  planFacelessUploadSession
} from '../../src/content/faceless-content-workflow';
import { renderUploadSessionSheet } from '../../src/content/upload-session-sheet';

function portfolio() {
  return {
    version: 1 as const,
    portfolioId: 'portfolio-midnight-memos',
    binding: { kind: 'client' as const, scopeId: 'client:creator_lab' },
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
      }
    ]
  };
}

function plan() {
  const composed = composeFacelessContentVariants({
    command: 'compose_variants',
    requestId: 'request-compose-midnight-memos',
    lane: 'short_story',
    story: {
      storyId: 'story-memo-from-tomorrow',
      title: 'The Memo From Tomorrow',
      scriptDigest: `sha256:${'a'.repeat(64)}`,
      originalStory: true,
      containsGenerativeMedia: true,
      realisticSyntheticMedia: false
    },
    portfolio: portfolio(),
    voices: [
      {
        voiceId: 'voice-calm-archivist',
        provider: 'elevenlabs',
        kind: 'licensed_stock',
        licenseRef: 'license:elevenlabs:voice-calm-archivist',
        consentRef: null
      },
      {
        voiceId: 'voice-tense-archivist',
        provider: 'elevenlabs',
        kind: 'synthetic_designed',
        licenseRef: 'license:elevenlabs:commercial-plan',
        consentRef: null
      }
    ],
    visualPacks: [
      {
        visualPackId: 'visual-archive-broll',
        provider: 'pexels',
        strategy: 'owned_licensed_broll',
        rightsRef: 'rights:pexels:archive-broll-001',
        containsGenerativeMedia: false
      },
      {
        visualPackId: 'visual-clock-storyboard',
        provider: 'local',
        strategy: 'poc_storyboard',
        rightsRef: 'rights:creator-lab:clock-storyboard',
        containsGenerativeMedia: true
      }
    ],
    policy: {
      maxVariants: 2,
      minChangedDimensions: 2,
      staggerMinutes: 180,
      requireExactPublishApproval: true
    }
  });

  return planFacelessUploadSession({
    command: 'plan_upload_session',
    requestId: 'request-daily-upload-session',
    sessionId: 'session-2026-07-25',
    sessionStart: '2026-07-25T09:00:00.000Z',
    portfolio: portfolio(),
    queue: composed.variants.map((variant, index) => ({
      itemId: `item-${index + 1}-${variant.accountId}`,
      variantId: variant.variantId,
      accountId: variant.accountId,
      storyId: variant.storyId,
      assetRef: `render:/Users/operator/faceless/${variant.accountId}.mp4`,
      assetDigest: `sha256:${String(index + 1).padStart(64, '0')}`,
      renderManifestDigest: variant.renderManifestDigest,
      metadataRef: `metadata:${variant.accountId}`,
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
      requireSignOut: true,
      maxAccountsPerSession: 8,
      maxUploadsPerAccount: 3
    }
  });
}

describe('upload session sheet renderer', () => {
  it('renders one checkbox block per account with sign-in first and sign-out last', () => {
    const sheet = renderUploadSessionSheet(plan());

    expect(sheet).toContain('# Upload session — session-2026-07-25');
    expect(sheet).toContain('State: **ready_for_operator_execution**');
    expect(sheet).toContain('## Block 1 — tiktok @midnightmemos (primary)');
    expect(sheet).toContain('## Block 2 — youtube @midnightmemos (primary)');
    expect(sheet).toContain('`09:00` **Sign in**');

    const firstBlock = sheet.slice(sheet.indexOf('## Block 1'), sheet.indexOf('## Block 2'));
    expect(firstBlock.indexOf('**Sign in**')).toBeLessThan(firstBlock.indexOf('**Upload**'));
    expect(firstBlock.indexOf('**Upload**')).toBeLessThan(firstBlock.indexOf('**Verify**'));
    expect(firstBlock.indexOf('**Verify**')).toBeLessThan(firstBlock.indexOf('**Sign out**'));
  });

  it('renders platform-native disclosure checklist lines with underscores humanized', () => {
    const sheet = renderUploadSessionSheet(plan());
    expect(sheet).toContain('enable the ai generated content label');
    expect(sheet).toContain(
      'confirm the master runs at least one minute for the creator rewards format'
    );
    expect(sheet).not.toContain('enable_the_ai_generated_content_label');
  });

  it('renders a completion-log row per scheduled upload and the checkpoint instruction', () => {
    const sheet = renderUploadSessionSheet(plan());
    expect(sheet).toContain('## Completion log');
    expect(sheet).toContain('| item-2-account-tiktok-main | account-tiktok-main |  |  |  |  |');
    expect(sheet).toContain('| item-1-account-youtube-main | account-youtube-main |  |  |  |  |');
    expect(sheet).toContain('Set analytics checkpoints at 24h, 7d, 30d.');
  });

  it('never renders a credential, token, or secret reference', () => {
    const sheet = renderUploadSessionSheet(plan());
    expect(sheet).not.toMatch(/secretref:/);
    expect(sheet).not.toMatch(/access[_-]?token|refresh[_-]?token/i);
  });

  it('renders deferred and rejected sections only when present', () => {
    const clean = renderUploadSessionSheet(plan());
    expect(clean).not.toContain('## Deferred');
    expect(clean).not.toContain('## Rejected');
  });

  it('renders the deferred and rejected sections when the plan carries them', () => {
    const composed = composeFacelessContentVariants({
      command: 'compose_variants',
      requestId: 'request-compose-midnight-memos',
      lane: 'short_story',
      story: {
        storyId: 'story-memo-from-tomorrow',
        title: 'The Memo From Tomorrow',
        scriptDigest: `sha256:${'a'.repeat(64)}`,
        originalStory: true,
        containsGenerativeMedia: false,
        realisticSyntheticMedia: false
      },
      portfolio: portfolio(),
      voices: [
        {
          voiceId: 'voice-a',
          provider: 'local_tts',
          kind: 'synthetic_designed',
          licenseRef: 'license:local:voice-a',
          consentRef: null
        },
        {
          voiceId: 'voice-b',
          provider: 'human_recorded',
          kind: 'human_original',
          licenseRef: 'license:operator:voice-b',
          consentRef: null
        }
      ],
      visualPacks: [
        {
          visualPackId: 'visual-a',
          provider: 'pexels',
          strategy: 'owned_licensed_broll',
          rightsRef: 'rights:pexels:a',
          containsGenerativeMedia: false
        },
        {
          visualPackId: 'visual-b',
          provider: 'owned',
          strategy: 'owned_licensed_broll',
          rightsRef: 'rights:operator:b',
          containsGenerativeMedia: false
        }
      ],
      policy: {
        maxVariants: 2,
        minChangedDimensions: 2,
        staggerMinutes: 180,
        requireExactPublishApproval: true
      }
    });

    const overflowed = planFacelessUploadSession({
      command: 'plan_upload_session',
      requestId: 'request-overflow',
      sessionId: 'session-overflow',
      sessionStart: '2026-07-25T09:00:00.000Z',
      portfolio: portfolio(),
      queue: [
        ...composed.variants.map((variant, index) => ({
          itemId: `item-${index + 1}-${variant.accountId}`,
          variantId: variant.variantId,
          accountId: variant.accountId,
          storyId: variant.storyId,
          assetRef: `render:/Users/operator/faceless/${variant.accountId}.mp4`,
          assetDigest: `sha256:${String(index + 1).padStart(64, '0')}`,
          renderManifestDigest: variant.renderManifestDigest,
          metadataRef: `metadata:${variant.accountId}`,
          finalQcApproved: true,
          rightsCleared: true,
          disclosure: variant.renderManifest.disclosures,
          priority: index + 1
        })),
        {
          itemId: 'item-ghost',
          variantId: `variant:${'a'.repeat(48)}`,
          accountId: 'account-ghost',
          storyId: 'story-memo-from-tomorrow',
          assetRef: 'render:/Users/operator/faceless/ghost.mp4',
          assetDigest: `sha256:${'f'.repeat(64)}`,
          renderManifestDigest: `sha256:${'e'.repeat(64)}`,
          metadataRef: 'metadata:ghost',
          finalQcApproved: false,
          rightsCleared: true,
          disclosure: { containsGenerativeMedia: false, realisticSyntheticMedia: false },
          priority: 9
        }
      ],
      // 11 minutes fits exactly one account block, forcing the second to defer.
      policy: {
        sessionMinutes: 11,
        signInMinutes: 2,
        uploadMinutes: 6,
        verifyMinutes: 2,
        signOutMinutes: 1,
        requireSignOut: true,
        maxAccountsPerSession: 8,
        maxUploadsPerAccount: 3
      }
    });

    expect(overflowed.deferred.length).toBeGreaterThan(0);
    expect(overflowed.rejected.length).toBeGreaterThan(0);
    const sheet = renderUploadSessionSheet(overflowed);
    expect(sheet).toContain('## Deferred');
    expect(sheet).toContain('## Rejected');
    expect(sheet).toContain('account-ghost');
    expect(sheet).toContain('account_not_in_portfolio');
  });
});
