import { describe, expect, it } from 'vitest';

import {
  defaultCliRunner,
  minimalCliEnvironment,
  secretsPlaneProbe
} from '../../src/models/cli-runtime';
import type { ProviderCredentialInspector } from '../../src/secrets/provider-credentials';

describe('defaultCliRunner', () => {
  it('builds a minimal environment and keeps only explicitly approved credential variables', () => {
    expect(
      minimalCliEnvironment(
        {
          HOME: '/home/operator',
          PATH: '/usr/bin:/bin',
          TMPDIR: '/tmp/private',
          LANG: 'en_US.UTF-8',
          HTTPS_PROXY: 'http://127.0.0.1:8080',
          CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
          ANTHROPIC_API_KEY: 'metered-key',
          OPENAI_API_KEY: 'metered-key',
          DATABASE_URL: 'private-database'
        },
        ['CLAUDE_CODE_OAUTH_TOKEN']
      )
    ).toEqual({
      HOME: '/home/operator',
      PATH: '/usr/bin:/bin',
      TMPDIR: '/tmp/private',
      LANG: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://127.0.0.1:8080',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token'
    });
  });

  it('captures stdout and exit code and feeds stdin', async () => {
    const result = await defaultCliRunner(
      process.execPath,
      ['-e', 'process.stdin.on("data", (d) => process.stdout.write("got:" + d))'],
      { input: 'hello', timeoutMs: 10_000 }
    );
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe('got:hello');
  });

  it('kills a process that exceeds the timeout and flags timedOut', async () => {
    const result = await defaultCliRunner(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      timeoutMs: 200
    });
    expect(result.timedOut).toBe(true);
  });

  it('rejects when the command cannot be launched', async () => {
    await expect(
      defaultCliRunner('definitely-not-a-real-binary-xyz', [], { timeoutMs: 5_000 })
    ).rejects.toBeInstanceOf(Error);
  });
});

describe('secretsPlaneProbe', () => {
  function inspectorWith(
    statuses: Array<{ provider: string; state: string; detail: string }>
  ): () => ProviderCredentialInspector {
    return () =>
      ({ statuses: () => Promise.resolve(statuses) }) as unknown as ProviderCredentialInspector;
  }

  it('reports available when the secrets plane state is valid', async () => {
    const probe = secretsPlaneProbe(
      'codex',
      inspectorWith([{ provider: 'codex', state: 'valid', detail: 'auth.json present' }])
    );
    await expect(probe()).resolves.toEqual({
      provider: 'codex',
      available: true,
      detail: 'auth.json present'
    });
  });

  it('reports unavailable for any non-valid state', async () => {
    const probe = secretsPlaneProbe(
      'claude',
      inspectorWith([{ provider: 'claude', state: 'missing', detail: 'no credential' }])
    );
    await expect(probe()).resolves.toMatchObject({ provider: 'claude', available: false });
  });

  it('fails closed (unavailable) when the inspector throws', async () => {
    const probe = secretsPlaneProbe('gemini', () => {
      throw new Error('inspector exploded');
    });
    await expect(probe()).resolves.toMatchObject({
      available: false,
      detail: 'credential probe failed'
    });
  });
});
