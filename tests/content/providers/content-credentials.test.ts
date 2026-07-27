import { describe, expect, it } from 'vitest';

import { ContentCredentialResolver } from '../../../src/content/providers/content-credentials';

function resolver(overrides: {
  env?: Record<string, string | undefined>;
  present?: boolean;
  read?: string;
}) {
  return new ContentCredentialResolver({
    env: overrides.env ?? {},
    keychainPresent: () => Promise.resolve(overrides.present ?? false),
    keychainRead: () =>
      overrides.read !== undefined
        ? Promise.resolve(overrides.read)
        : Promise.reject(new Error('not in keychain'))
  });
}

describe('content credential resolver', () => {
  it('reports env presence without touching the keychain', async () => {
    const presence = await resolver({ env: { PEXELS_API_KEY: 'k' } }).presence('pexels');
    expect(presence).toEqual({ present: true, source: 'env' });
  });

  it('falls back to keychain presence when the env var is absent', async () => {
    const presence = await resolver({ present: true }).presence('elevenlabs');
    expect(presence).toEqual({ present: true, source: 'keychain' });
  });

  it('reports absence when neither source has the credential', async () => {
    const presence = await resolver({}).presence('higgsfield');
    expect(presence).toEqual({ present: false, source: null });
  });

  it('reads the env value first and never the keychain when env is set', async () => {
    const value = await resolver({ env: { PEXELS_API_KEY: '  env-key  ' }, read: 'kc-key' }).read(
      'pexels'
    );
    expect(value).toBe('env-key');
  });

  it('reads from the keychain when the env var is missing', async () => {
    const value = await resolver({ read: 'kc-key' }).read('elevenlabs');
    expect(value).toBe('kc-key');
  });

  it('throws when no credential is connected', async () => {
    await expect(resolver({}).read('pexels')).rejects.toThrow(/No credential is connected/);
  });

  it('ignores a blank env value and falls through', async () => {
    const presence = await resolver({ env: { PEXELS_API_KEY: '   ' } }).presence('pexels');
    expect(presence.present).toBe(false);
  });

  it('constructs with default keychain deps and resolves an env credential without touching them', async () => {
    const withDefaults = new ContentCredentialResolver({ env: { PEXELS_API_KEY: 'env-only' } });
    expect(await withDefaults.presence('pexels')).toEqual({ present: true, source: 'env' });
    expect(await withDefaults.read('pexels')).toBe('env-only');
  });

  it('treats an oversized env value as absent and fails closed', async () => {
    const huge = 'x'.repeat(20_000);
    const r = new ContentCredentialResolver({
      env: { ELEVENLABS_API_KEY: huge },
      keychainPresent: () => Promise.resolve(false),
      keychainRead: () => Promise.reject(new Error('none'))
    });
    expect((await r.presence('elevenlabs')).present).toBe(false);
    await expect(r.read('elevenlabs')).rejects.toThrow(/No credential is connected/);
  });
});
