import { describe, expect, it } from 'vitest';

import { runAuthStatusCli } from '../../src/secrets/auth-status-cli';
import type { CredentialStatus } from '../../src/secrets/provider-credentials';

const statuses: CredentialStatus[] = [
  {
    provider: 'claude',
    state: 'valid',
    source: 'macos-keychain:Claude Code-credentials',
    detail: 'present'
  },
  {
    provider: 'codex',
    state: 'valid',
    source: '~/.codex/auth.json',
    detail: 'refresh token present'
  },
  {
    provider: 'gemini',
    state: 'expired',
    source: '~/.gemini/oauth_creds.json',
    detail: 'no refresh token'
  },
  {
    provider: 'telegram',
    state: 'missing',
    source: 'openclaw + keychain',
    detail: 'allowlist present; bot token not in keychain'
  },
  { provider: 'ollama', state: 'valid', source: 'local:ollama', detail: 'no credential required' }
];

describe('jarvis auth status CLI', () => {
  it('prints one non-secret line per provider plus a summary and returns the statuses', async () => {
    const lines: string[] = [];
    const result = await runAuthStatusCli({
      inspector: { statuses: () => Promise.resolve(statuses) },
      write: (message) => lines.push(message)
    });

    expect(result).toBe(statuses);
    const providerLines = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const perProvider = providerLines.filter((line) => line.event === 'auth_status');
    expect(perProvider).toHaveLength(5);
    expect(perProvider.map((line) => line.provider)).toEqual([
      'claude',
      'codex',
      'gemini',
      'telegram',
      'ollama'
    ]);

    const summary = providerLines.find((line) => line.event === 'auth_status_summary');
    expect(summary).toMatchObject({ total: 5, valid: 3 });
    expect(summary?.byState).toMatchObject({ valid: 3, expired: 1, missing: 1 });
  });
});
