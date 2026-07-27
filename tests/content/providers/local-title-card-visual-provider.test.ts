import { describe, expect, it } from 'vitest';

import { LocalTitleCardVisualProvider } from '../../../src/content/providers/local-title-card-visual-provider';

describe('LocalTitleCardVisualProvider', () => {
  const provider = new LocalTitleCardVisualProvider();

  it('is always available, local, and non-premium', async () => {
    expect(await provider.probe()).toMatchObject({
      available: true,
      costBasis: 'local',
      premium: false
    });
  });

  it('returns portrait 1080x1920 title-card specs, clamped to the max count', async () => {
    const result = await provider.query({
      query: 'midnight memo',
      orientation: 'portrait',
      count: 50,
      timeoutMs: 1_000
    });
    expect(result.assets).toHaveLength(12);
    expect(result.assets[0]).toMatchObject({
      provider: 'local_title_card',
      license: 'operator_generated',
      width: 1080,
      height: 1920,
      requiresManualProduction: false
    });
  });

  it('uses the right dimensions per orientation and is deterministic', async () => {
    const landscape = await provider.query({
      query: 'x',
      orientation: 'landscape',
      count: 1,
      timeoutMs: 1_000
    });
    expect(landscape.assets[0]).toMatchObject({ width: 1920, height: 1080 });

    const square = await provider.query({
      query: 'x',
      orientation: 'square',
      count: 1,
      timeoutMs: 1_000
    });
    expect(square.assets[0]).toMatchObject({ width: 1080, height: 1080 });

    const again = await provider.query({
      query: 'x',
      orientation: 'square',
      count: 1,
      timeoutMs: 1_000
    });
    expect(again.assets[0]?.assetId).toBe(square.assets[0]?.assetId);
  });

  it('rejects an empty query', async () => {
    await expect(
      provider.query({ query: '  ', orientation: 'portrait', count: 1, timeoutMs: 1_000 })
    ).rejects.toMatchObject({ kind: 'protocol' });
  });
});
