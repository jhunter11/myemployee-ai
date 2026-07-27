import { describe, expect, it } from 'vitest';

import { ContentCredentialResolver } from '../../../src/content/providers/content-credentials';
import { HiggsfieldVisualProvider } from '../../../src/content/providers/higgsfield-visual-provider';

function resolver(present: boolean) {
  return new ContentCredentialResolver({
    env: present ? { HIGGSFIELD_API_KEY: 'hf-key' } : {},
    keychainPresent: () => Promise.resolve(false),
    keychainRead: () => Promise.reject(new Error('none'))
  });
}

const request = {
  query: 'cinematic hero shot of a lighthouse',
  orientation: 'portrait' as const,
  count: 3,
  timeoutMs: 1_000
};

describe('HiggsfieldVisualProvider', () => {
  it('probes available only with a credential and is premium/subscription', async () => {
    const on = await new HiggsfieldVisualProvider({ credentials: resolver(true) }).probe();
    expect(on).toMatchObject({ available: true, premium: true, costBasis: 'subscription' });
    expect(on.detail).toContain('manual production manifest');
    expect(
      (await new HiggsfieldVisualProvider({ credentials: resolver(false) }).probe()).available
    ).toBe(false);
  });

  it('emits a manual production manifest when connected', async () => {
    const result = await new HiggsfieldVisualProvider({ credentials: resolver(true) }).query(
      request
    );
    expect(result.assets).toHaveLength(3);
    expect(result.assets[0]).toMatchObject({
      provider: 'higgsfield',
      license: 'manual_production_required',
      requiresManualProduction: true,
      width: null,
      height: null
    });
  });

  it('fails closed without a credential and on empty query', async () => {
    await expect(
      new HiggsfieldVisualProvider({ credentials: resolver(false) }).query(request)
    ).rejects.toMatchObject({ kind: 'not_credentialed' });
    await expect(
      new HiggsfieldVisualProvider({ credentials: resolver(true) }).query({ ...request, query: '' })
    ).rejects.toMatchObject({ kind: 'protocol' });
  });
});
