import { describe, expect, it, vi } from 'vitest';

import {
  defaultKeychainPresent,
  ProviderCredentialInspector,
  type CredentialProviderId,
  type CredentialStatus
} from '../../src/secrets/provider-credentials';

const SECRET = 'sk-super-secret-token-value-DO-NOT-LEAK';

function fakeReadFile(files: Record<string, string>): (path: string) => Promise<string> {
  return (path: string) => {
    const match = Object.entries(files).find(([suffix]) => path.endsWith(suffix));
    if (!match) {
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      return Promise.reject(error);
    }
    return Promise.resolve(match[1]);
  };
}

function inspector(options: {
  files?: Record<string, string>;
  env?: Record<string, string | undefined>;
  keychain?: (lookup: { service: string; account?: string }) => Promise<boolean>;
  now?: () => number;
}): ProviderCredentialInspector {
  return new ProviderCredentialInspector({
    homedir: () => '/home/op',
    readFile: fakeReadFile(options.files ?? {}),
    env: options.env ?? {},
    keychainPresent: options.keychain ?? (() => Promise.resolve(false)),
    now: options.now ?? (() => Date.parse('2026-07-23T18:00:00.000Z'))
  });
}

function byProvider(statuses: CredentialStatus[]): Record<CredentialProviderId, CredentialStatus> {
  return Object.fromEntries(statuses.map((status) => [status.provider, status])) as Record<
    CredentialProviderId,
    CredentialStatus
  >;
}

describe('provider credential inspector', () => {
  it('reports codex, gemini, claude, telegram, and ollama with no secret material', async () => {
    const statuses = await inspector({
      files: {
        '.codex/auth.json': JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: { access_token: SECRET, refresh_token: `${SECRET}-refresh` }
        }),
        '.gemini/oauth_creds.json': JSON.stringify({
          access_token: SECRET,
          refresh_token: `${SECRET}-refresh`,
          expiry_date: Date.parse('2026-07-24T00:00:00.000Z'),
          scope: 'https://www.googleapis.com/auth/cloud-platform'
        }),
        '.openclaw/credentials/telegram-default-allowFrom.json': JSON.stringify({
          allowFrom: [123456789],
          version: 1
        })
      },
      env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET },
      keychain: ({ service }) => Promise.resolve(service === 'ai-agency-jarvis.telegram')
    }).statuses();

    const map = byProvider(statuses);
    expect(map.codex.state).toBe('valid');
    expect(map.gemini.state).toBe('valid');
    expect(map.claude.state).toBe('valid');
    expect(map.telegram.state).toBe('valid');
    expect(map.ollama.state).toBe('valid');

    // No secret bytes may appear anywhere in the reported status.
    const serialized = JSON.stringify(statuses);
    expect(serialized).not.toContain(SECRET);
  });

  it('marks missing credential files as missing without throwing', async () => {
    const map = byProvider(await inspector({}).statuses());
    expect(map.codex.state).toBe('missing');
    expect(map.gemini.state).toBe('missing');
    expect(map.claude.state).toBe('missing');
    expect(map.telegram.state).toBe('missing');
  });

  it('marks malformed credential files as malformed, not valid', async () => {
    const map = byProvider(
      await inspector({
        files: {
          '.codex/auth.json': '{ this is not json',
          '.gemini/oauth_creds.json': JSON.stringify({ token_type: 'Bearer' })
        }
      }).statuses()
    );
    expect(map.codex.state).toBe('malformed');
    expect(map.gemini.state).toBe('malformed');
  });

  it('treats a Gemini credential with only an expired access token as expired, but valid when refreshable', async () => {
    const expired = byProvider(
      await inspector({
        files: {
          '.gemini/oauth_creds.json': JSON.stringify({
            access_token: SECRET,
            expiry_date: Date.parse('2026-07-23T17:00:00.000Z')
          })
        }
      }).statuses()
    );
    expect(expired.gemini.state).toBe('expired');

    const refreshable = byProvider(
      await inspector({
        files: {
          '.gemini/oauth_creds.json': JSON.stringify({
            access_token: SECRET,
            refresh_token: `${SECRET}-refresh`,
            expiry_date: Date.parse('2026-07-23T17:00:00.000Z')
          })
        }
      }).statuses()
    );
    expect(refreshable.gemini.state).toBe('valid');
  });

  it('falls back to the keychain when no headless Claude token is present', async () => {
    const probe = vi.fn(({ service }: { service: string }) =>
      Promise.resolve(service === 'Claude Code-credentials')
    );
    const map = byProvider(await inspector({ keychain: probe }).statuses());
    expect(map.claude.state).toBe('valid');
    expect(map.claude.source).toContain('keychain');
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'Claude Code-credentials' })
    );
  });

  it('reports telegram allowlist present but bot token missing as missing', async () => {
    const map = byProvider(
      await inspector({
        files: {
          '.openclaw/credentials/telegram-default-allowFrom.json': JSON.stringify({
            allowFrom: [123456789],
            version: 1
          })
        },
        keychain: () => Promise.resolve(false)
      }).statuses()
    );
    expect(map.telegram.state).toBe('missing');
    expect(map.telegram.detail.toLowerCase()).toContain('allowlist');
  });

  it('covers gemini valid-until, access-only, and refresh-only detail branches', async () => {
    const future = byProvider(
      await inspector({
        files: {
          '.gemini/oauth_creds.json': JSON.stringify({
            access_token: SECRET,
            expiry_date: Date.parse('2026-07-24T00:00:00.000Z')
          })
        }
      }).statuses()
    );
    expect(future.gemini.state).toBe('valid');
    expect(future.gemini.detail).toContain('valid until');

    const noExpiry = byProvider(
      await inspector({
        files: { '.gemini/oauth_creds.json': JSON.stringify({ access_token: SECRET }) }
      }).statuses()
    );
    expect(noExpiry.gemini.state).toBe('valid');
    expect(noExpiry.gemini.detail).toContain('access token present');

    const refreshNoExpiry = byProvider(
      await inspector({
        files: {
          '.gemini/oauth_creds.json': JSON.stringify({
            access_token: SECRET,
            refresh_token: `${SECRET}-refresh`
          })
        }
      }).statuses()
    );
    expect(refreshNoExpiry.gemini.detail).toBe('refresh token present');
  });

  it('reports codex without an auth_mode as valid with an unknown mode', async () => {
    const map = byProvider(
      await inspector({
        files: { '.codex/auth.json': JSON.stringify({ tokens: { access_token: SECRET } }) }
      }).statuses()
    );
    expect(map.codex.state).toBe('valid');
    expect(map.codex.detail).toContain('auth_mode=unknown');
    expect(map.codex.detail).toContain('refresh token absent');
  });

  it('treats an unreadable (non-ENOENT) credential file as malformed', async () => {
    const map = byProvider(
      await new ProviderCredentialInspector({
        homedir: () => '/home/op',
        readFile: (path) =>
          path.endsWith('.codex/auth.json')
            ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
            : Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
        env: {},
        keychainPresent: () => Promise.resolve(false),
        now: () => 0
      }).statuses()
    );
    expect(map.codex.state).toBe('malformed');
  });

  it('reports an empty telegram allowlist as malformed', async () => {
    const map = byProvider(
      await inspector({
        files: {
          '.openclaw/credentials/telegram-default-allowFrom.json': JSON.stringify({
            allowFrom: [],
            version: 1
          })
        }
      }).statuses()
    );
    expect(map.telegram.state).toBe('malformed');
  });

  it('defaultKeychainPresent rejects unsafe identifiers and absent items without exposing secrets', async () => {
    await expect(defaultKeychainPresent({ service: 'a' })).resolves.toBe(false);
    await expect(defaultKeychainPresent({ service: 'bad;service' })).resolves.toBe(false);
    await expect(
      defaultKeychainPresent({ service: 'valid.service', account: 'bad;acct' })
    ).resolves.toBe(false);
    await expect(
      defaultKeychainPresent({ service: 'ai-agency-jarvis.absent-xyz', account: 'no-such' })
    ).resolves.toBe(false);
  });
});
