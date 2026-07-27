import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  composeFacelessContentVariants,
  type FacelessUploadSessionPlan
} from '../../src/content/faceless-content-workflow';
import { runFacelessSessionCli } from '../../src/content/faceless-session-cli';

const workDir = mkdtempSync(join(tmpdir(), 'faceless-session-cli-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const portfolio = {
  version: 1,
  portfolioId: 'portfolio-midnight-memos',
  binding: { kind: 'client', scopeId: 'client:creator_lab' },
  emailGroupId: 'email_group:111111111111111111111111111111111111111111111111',
  providerProfileRef: 'publisher-profile:midnight-memos',
  accounts: [
    {
      accountId: 'account-youtube-main',
      platform: 'youtube',
      placement: 'shorts',
      publicLabel: '@midnightmemos',
      connection: {
        connectionId: 'social_youtube_main',
        providerKey: 'zernio',
        credentialRef: 'secretref:keychain:social_youtube_main',
        state: 'active',
        version: 1
      },
      role: 'primary',
      audience: 'English-language speculative mystery viewers.',
      allowedLanes: ['short_story']
    },
    {
      accountId: 'account-tiktok-main',
      platform: 'tiktok',
      placement: 'reels',
      publicLabel: '@midnightmemos',
      connection: {
        connectionId: 'social_tiktok_main',
        providerKey: 'zernio',
        credentialRef: 'secretref:keychain:social_tiktok_main',
        state: 'active',
        version: 1
      },
      role: 'primary',
      audience: 'TikTok viewers who watch one-minute mystery stories.',
      allowedLanes: ['short_story']
    }
  ]
};

function queueItems() {
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
    portfolio,
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
  return composed.variants.map((variant, index) => ({
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
  }));
}

function writeInputs(prefix: string, queue: unknown = queueItems()) {
  const queuePath = join(workDir, `${prefix}-queue.json`);
  const portfolioPath = join(workDir, `${prefix}-portfolio.json`);
  writeFileSync(queuePath, JSON.stringify(queue));
  writeFileSync(portfolioPath, JSON.stringify(portfolio));
  return { queuePath, portfolioPath };
}

function capturingIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (message: string) => out.push(message),
      stderr: (message: string) => err.push(message)
    }
  };
}

describe('faceless session CLI', () => {
  it('writes a sheet file and prints a bounded JSON summary on success', async () => {
    const { queuePath, portfolioPath } = writeInputs('ok');
    const outPath = join(workDir, 'ok-session.md');
    const { out, err, io } = capturingIo();

    const code = await runFacelessSessionCli(
      [
        '--queue',
        queuePath,
        '--portfolio',
        portfolioPath,
        '--start',
        '2026-07-25T09:00:00.000Z',
        '--out',
        outPath
      ],
      io
    );

    expect(code).toBe(0);
    expect(err).toHaveLength(0);
    const summary = JSON.parse(out[0] ?? '{}') as {
      sessionId: string;
      sheetPath: string;
      sessionState: string;
      totals: FacelessUploadSessionPlan['totals'];
    };
    expect(summary.sessionId).toBe('session-2026-07-25');
    expect(summary.sessionState).toBe('ready_for_operator_execution');
    expect(summary.totals.scheduledUploads).toBe(2);
    expect(summary.sheetPath).toBe(outPath);

    const sheet = readFileSync(outPath, 'utf8');
    expect(sheet).toContain('# Upload session — session-2026-07-25');
    expect(sheet).toContain('**Sign in**');
    expect(sheet).toContain('## Completion log');
  });

  it('accepts a {queue: [...]} wrapper and derives the session id from the start date', async () => {
    const { queuePath, portfolioPath } = writeInputs('wrap', { queue: queueItems() });
    const outPath = join(workDir, 'wrap-session.md');
    const { out, io } = capturingIo();

    const code = await runFacelessSessionCli(
      [
        '--queue',
        queuePath,
        '--portfolio',
        portfolioPath,
        '--start',
        '2026-08-01T08:30:00.000Z',
        '--out',
        outPath
      ],
      io
    );

    expect(code).toBe(0);
    expect((JSON.parse(out[0] ?? '{}') as { sessionId: string }).sessionId).toBe(
      'session-2026-08-01'
    );
  });

  it('never prints a credential in the summary', async () => {
    const { queuePath, portfolioPath } = writeInputs('leak');
    const { out, io } = capturingIo();
    await runFacelessSessionCli(
      [
        '--queue',
        queuePath,
        '--portfolio',
        portfolioPath,
        '--start',
        '2026-07-25T09:00:00.000Z',
        '--out',
        join(workDir, 'leak.md')
      ],
      io
    );
    expect(out.join('\n')).not.toMatch(/secretref:|access[_-]?token|refresh[_-]?token/i);
  });

  it('fails closed with a structured error when a required flag is missing', async () => {
    const { portfolioPath } = writeInputs('missing');
    const { err, io } = capturingIo();
    const code = await runFacelessSessionCli(
      ['--portfolio', portfolioPath, '--start', '2026-07-25T09:00:00.000Z'],
      io
    );
    expect(code).toBe(1);
    expect((JSON.parse(err[0] ?? '{}') as { error: { code: string } }).error.code).toBe(
      'MISSING_QUEUE'
    );
  });

  it('reports an unreadable input file without throwing', async () => {
    const { portfolioPath } = writeInputs('unreadable');
    const { err, io } = capturingIo();
    const code = await runFacelessSessionCli(
      [
        '--queue',
        join(workDir, 'does-not-exist.json'),
        '--portfolio',
        portfolioPath,
        '--start',
        '2026-07-25T09:00:00.000Z'
      ],
      io
    );
    expect(code).toBe(1);
    expect((JSON.parse(err[0] ?? '{}') as { error: { code: string } }).error.code).toBe(
      'QUEUE_UNREADABLE'
    );
  });

  it('surfaces schema issues from an invalid queue', async () => {
    const { queuePath, portfolioPath } = writeInputs('invalid', [{ itemId: 'x' }]);
    const { err, io } = capturingIo();
    const code = await runFacelessSessionCli(
      ['--queue', queuePath, '--portfolio', portfolioPath, '--start', '2026-07-25T09:00:00.000Z'],
      io
    );
    expect(code).toBe(1);
    const payload = JSON.parse(err[0] ?? '{}') as {
      error: { code: string; issues?: { path: string }[] };
    };
    expect(payload.error.code).toBe('INVALID_SESSION_INPUT');
    expect(payload.error.issues?.length ?? 0).toBeGreaterThan(0);
  });

  it('rejects an unsupported argument', async () => {
    const { err, io } = capturingIo();
    const code = await runFacelessSessionCli(['--wat', 'value'], io);
    expect(code).toBe(1);
    expect((JSON.parse(err[0] ?? '{}') as { error: { code: string } }).error.code).toBe(
      'UNSUPPORTED_ARGUMENT'
    );
  });

  it('bounds the derived requestId when a long session id is supplied', async () => {
    const { queuePath, portfolioPath } = writeInputs('longid');
    const outPath = join(workDir, 'longid-session.md');
    const longSessionId = `s${'a'.repeat(94)}`; // 95 chars: valid slug, near the max
    const { out, err, io } = capturingIo();
    const code = await runFacelessSessionCli(
      [
        '--queue',
        queuePath,
        '--portfolio',
        portfolioPath,
        '--start',
        '2026-07-25T09:00:00.000Z',
        '--session-id',
        longSessionId,
        '--out',
        outPath
      ],
      io
    );
    expect(err).toHaveLength(0);
    expect(code).toBe(0);
    const summary = JSON.parse(out[0] ?? '{}') as { sessionId: string; requestId: string };
    expect(summary.sessionId).toBe(longSessionId);
    expect(summary.requestId.length).toBeLessThanOrEqual(96);
  });
});
