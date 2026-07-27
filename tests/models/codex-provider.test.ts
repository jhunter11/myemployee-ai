import { describe, expect, it } from 'vitest';

import {
  CodexAppServerFailure,
  type CodexAppServerRequest,
  type CodexAppServerRunner
} from '../../src/models/codex-app-server-runtime';
import type { ModelGenerationRequest } from '../../src/models/contracts';
import { CodexProvider } from '../../src/models/codex-provider';

const request: ModelGenerationRequest = {
  system: 'You are Jarvis.',
  messages: [
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'status?' }
  ],
  maxOutputTokens: 256,
  timeoutMs: 60_000
};

function successfulRunner(
  capture?: (request: CodexAppServerRequest) => void
): CodexAppServerRunner {
  return (runtimeRequest) => {
    capture?.(runtimeRequest);
    return Promise.resolve({
      text: 'All systems nominal.',
      tokensIn: 1200,
      tokensOut: 8,
      cacheReadTokens: 400,
      cacheWriteTokens: 0
    });
  };
}

describe('CodexProvider', () => {
  it('routes economy to Terra and frontier to Sol through the injected app-server runner', async () => {
    const captured: CodexAppServerRequest[] = [];
    const provider = new CodexProvider({
      command: '/Applications/ChatGPT.app/Contents/Resources/codex',
      homedir: () => '/Users/operator',
      env: {
        HOME: '/Users/operator',
        PATH: '/usr/bin:/bin',
        DATABASE_URL: 'private-database'
      },
      credentialProbe: () =>
        Promise.resolve({ provider: 'codex', available: true, detail: 'present' }),
      runner: successfulRunner((runtimeRequest) => captured.push(runtimeRequest))
    });

    const economy = await provider.generate('economy', request);
    const frontier = await provider.generate('frontier', request);

    expect(provider.modelForRoute('economy')).toBe('gpt-5.6-terra');
    expect(provider.modelForRoute('frontier')).toBe('gpt-5.6-sol');
    expect(captured.map((entry) => entry.model)).toEqual(['gpt-5.6-terra', 'gpt-5.6-sol']);
    expect(captured[0]).toMatchObject({
      command: '/Applications/ChatGPT.app/Contents/Resources/codex',
      sourceAuthPath: '/Users/operator/.codex/auth.json',
      system: request.system,
      messages: request.messages,
      maxOutputTokens: request.maxOutputTokens,
      timeoutMs: request.timeoutMs
    });
    expect(captured[0]?.sourceEnv).toMatchObject({
      HOME: '/Users/operator',
      PATH: '/usr/bin:/bin',
      DATABASE_URL: 'private-database'
    });
    expect(economy).toMatchObject({
      text: 'All systems nominal.',
      provider: 'codex',
      model: 'gpt-5.6-terra',
      costBasis: 'subscription',
      tokensIn: 1200,
      tokensOut: 8,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
      toolCalls: [],
      finishReason: 'stop'
    });
    expect(frontier.model).toBe('gpt-5.6-sol');
  });

  it('does not serve the local route and delegates availability to the credential probe', async () => {
    const provider = new CodexProvider({
      credentialProbe: () =>
        Promise.resolve({ provider: 'codex', available: false, detail: 'no credential' })
    });

    expect(provider.servesRoute('local')).toBe(false);
    expect(provider.servesRoute('economy')).toBe(true);
    expect(provider.servesRoute('frontier')).toBe(true);
    await expect(provider.probe()).resolves.toEqual({
      provider: 'codex',
      available: false,
      detail: 'no credential'
    });
  });

  it.each([
    ['auth', 'auth', false],
    ['rate_limited', 'rate_limited', true],
    ['timeout', 'timeout', true],
    ['unavailable', 'unavailable', true],
    ['protocol', 'protocol', false],
    ['runtime', 'runtime', true]
  ] as const)(
    'maps a sanitized app-server %s failure to ProviderError',
    async (runtimeKind, providerKind, retriable) => {
      const provider = new CodexProvider({
        runner: () => Promise.reject(new CodexAppServerFailure(runtimeKind))
      });

      const error = await provider.generate('economy', request).then(
        () => undefined,
        (reason: unknown) => reason
      );

      expect(error).toMatchObject({
        provider: 'codex',
        kind: providerKind,
        retriable
      });
      expect((error as Error).message).not.toContain(request.system);
      expect((error as Error).message).not.toContain(request.messages[2]?.content);
    }
  );

  it('sanitizes an unexpected injected-runner exception as unavailable', async () => {
    const provider = new CodexProvider({
      runner: () => Promise.reject(new Error(`spawn failed for ${request.messages[2]?.content}`))
    });

    const error = await provider.generate('economy', request).then(
      () => undefined,
      (reason: unknown) => reason
    );

    expect(error).toMatchObject({
      provider: 'codex',
      kind: 'unavailable',
      retriable: true
    });
    expect((error as Error).message).not.toContain(request.messages[2]?.content);
  });
});
