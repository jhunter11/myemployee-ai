import { describe, expect, it } from 'vitest';

import { ContentCredentialResolver } from '../../../src/content/providers/content-credentials';
import {
  ContentProviderCatalog,
  createContentProviderCatalog
} from '../../../src/content/providers/content-provider-catalog';
import type {
  ContentProviderAvailability,
  VisualProvider,
  VisualProviderId,
  VoiceProvider,
  VoiceProviderId
} from '../../../src/content/providers/contracts';

function voiceStub(
  id: VoiceProviderId,
  premium: boolean,
  probe: () => Promise<ContentProviderAvailability>
): VoiceProvider {
  return {
    id,
    premium,
    costBasis: premium ? 'metered' : 'local',
    probe,
    synthesize: () => Promise.reject(new Error('unused'))
  };
}

function visualStub(
  id: VisualProviderId,
  premium: boolean,
  probe: () => Promise<ContentProviderAvailability>
): VisualProvider {
  return {
    id,
    premium,
    costBasis: premium ? 'subscription' : 'local',
    probe,
    query: () => Promise.reject(new Error('unused'))
  };
}

function avail(
  provider: string,
  available: boolean,
  premium: boolean
): () => Promise<ContentProviderAvailability> {
  return () =>
    Promise.resolve({
      provider: provider as ContentProviderAvailability['provider'],
      available,
      costBasis: premium ? 'metered' : 'local',
      premium,
      detail: available ? 'ready' : 'off'
    });
}

describe('ContentProviderCatalog', () => {
  it('binds the first available non-premium provider as the starter and lists ready premium', async () => {
    const catalog = new ContentProviderCatalog(
      [
        voiceStub('local_say', false, avail('local_say', true, false)),
        voiceStub('elevenlabs', true, avail('elevenlabs', true, true))
      ],
      [
        visualStub('local_title_card', false, avail('local_title_card', true, false)),
        visualStub('higgsfield', true, avail('higgsfield', true, true))
      ]
    );
    const resolution = await catalog.resolve();
    expect(resolution.voice.starter).toBe('local_say');
    expect(resolution.voice.premiumReady).toEqual(['elevenlabs']);
    expect(resolution.visual.starter).toBe('local_title_card');
    expect(resolution.visual.premiumReady).toEqual(['higgsfield']);
  });

  it('prefers an earlier free provider as the starter and skips a down one', async () => {
    const catalog = new ContentProviderCatalog(
      [voiceStub('local_say', false, avail('local_say', true, false))],
      [
        visualStub('pexels', false, avail('pexels', false, false)), // down
        visualStub('local_title_card', false, avail('local_title_card', true, false))
      ]
    );
    const resolution = await catalog.resolve();
    expect(resolution.visual.starter).toBe('local_title_card');
  });

  it('reports no starter when only premium providers are available', async () => {
    const catalog = new ContentProviderCatalog(
      [voiceStub('elevenlabs', true, avail('elevenlabs', true, true))],
      [visualStub('higgsfield', true, avail('higgsfield', true, true))]
    );
    const resolution = await catalog.resolve();
    expect(resolution.voice.starter).toBeNull();
    expect(resolution.voice.premiumReady).toEqual(['elevenlabs']);
  });

  it('treats a throwing probe as unavailable (fail-closed)', async () => {
    const catalog = new ContentProviderCatalog(
      [voiceStub('local_say', false, () => Promise.reject(new Error('probe boom')))],
      [visualStub('local_title_card', false, avail('local_title_card', true, false))]
    );
    const resolution = await catalog.resolve();
    expect(resolution.voice.availability[0]).toMatchObject({
      available: false,
      detail: 'probe failed'
    });
    expect(resolution.voice.starter).toBeNull();
  });

  it('factory wiring: a connected Pexels/ElevenLabs key lights them up without code change', async () => {
    const credentials = new ContentCredentialResolver({
      env: { PEXELS_API_KEY: 'pk', ELEVENLABS_API_KEY: 'xi' },
      keychainPresent: () => Promise.resolve(false),
      keychainRead: () => Promise.reject(new Error('none'))
    });
    const resolution = await createContentProviderCatalog({ credentials }).resolve();

    expect(resolution.voice.availability).toHaveLength(2);
    expect(resolution.visual.availability).toHaveLength(3);
    expect(resolution.voice.premiumReady).toContain('elevenlabs');
    expect(resolution.visual.starter).toBe('pexels');
    expect(
      resolution.visual.availability.find((entry) => entry.provider === 'higgsfield')?.available
    ).toBe(false);
  });
});
