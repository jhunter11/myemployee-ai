import { describe, expect, it } from 'vitest';

import type { ModelGenerationRequest, ProviderError } from '../../src/models/contracts';
import { OllamaProvider } from '../../src/models/ollama-provider';
import { bodyText, fakeFetch } from './http-fakes';

const request: ModelGenerationRequest = {
  system: 'You are Jarvis.',
  messages: [{ role: 'user', content: 'Say pong.' }],
  maxOutputTokens: 64,
  timeoutMs: 30_000
};

describe('OllamaProvider', () => {
  it('probes runtime liveness via /api/tags', async () => {
    const provider = new OllamaProvider({
      fetchImpl: fakeFetch((url) => {
        expect(url).toContain('/api/tags');
        return new Response(JSON.stringify({ models: [{}, {}, {}] }), { status: 200 });
      })
    });
    await expect(provider.probe()).resolves.toEqual({
      provider: 'ollama',
      available: true,
      detail: 'runtime serving (3 models)'
    });
  });

  it('reports unavailable when the runtime is unreachable', async () => {
    const provider = new OllamaProvider({
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED'))
    });
    await expect(provider.probe()).resolves.toMatchObject({ available: false });
  });

  it('sends system+messages and maps content/tokens from /api/chat', async () => {
    let sentBody: Record<string, unknown> = {};
    const provider = new OllamaProvider({
      fetchImpl: fakeFetch((url, init) => {
        expect(url).toContain('/api/chat');
        sentBody = JSON.parse(bodyText(init)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            message: { role: 'assistant', content: 'pong' },
            done_reason: 'stop',
            prompt_eval_count: 21,
            eval_count: 2
          }),
          { status: 200 }
        );
      })
    });

    const result = await provider.generate('local', request);

    expect(sentBody.model).toBe('qwen2.5-coder:7b');
    expect(sentBody.messages).toEqual([
      { role: 'system', content: 'You are Jarvis.' },
      { role: 'user', content: 'Say pong.' }
    ]);
    expect(sentBody.options).toEqual({ num_predict: 64 });
    expect(result).toMatchObject({
      text: 'pong',
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
      costBasis: 'local',
      tokensIn: 21,
      tokensOut: 2,
      finishReason: 'stop'
    });
  });

  it('maps tool calls when the model returns them', async () => {
    const provider = new OllamaProvider({
      fetchImpl: fakeFetch(
        () =>
          new Response(
            JSON.stringify({
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  { function: { name: 'dashboard_snapshot', arguments: { scope: 'today' } } }
                ]
              },
              prompt_eval_count: 30,
              eval_count: 12
            }),
            { status: 200 }
          )
      )
    });

    const result = await provider.generate('economy', {
      ...request,
      tools: [{ name: 'dashboard_snapshot', description: 'read', parameters: {} }]
    });

    expect(result.toolCalls).toEqual([
      { name: 'dashboard_snapshot', arguments: { scope: 'today' } }
    ]);
    expect(result.finishReason).toBe('tool_calls');
  });

  it('throws a retriable ProviderError on a 5xx runtime error', async () => {
    const provider = new OllamaProvider({
      fetchImpl: fakeFetch(() => new Response('boom', { status: 503 }))
    });
    await expect(provider.generate('local', request)).rejects.toMatchObject({
      name: 'ProviderError',
      provider: 'ollama',
      retriable: true
    } satisfies Partial<ProviderError>);
  });

  it('reports unavailable when /api/tags returns a non-2xx status', async () => {
    const provider = new OllamaProvider({
      fetchImpl: fakeFetch(() => new Response('err', { status: 500 }))
    });
    await expect(provider.probe()).resolves.toEqual({
      provider: 'ollama',
      available: false,
      detail: 'runtime responded 500'
    });
  });

  it('maps an AbortSignal timeout to a retriable timeout error', async () => {
    const provider = new OllamaProvider({
      fetchImpl: () => Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))
    });
    await expect(provider.generate('local', request)).rejects.toMatchObject({
      kind: 'timeout',
      retriable: true
    });
  });

  it('maps a non-timeout fetch failure to a retriable unavailable error', async () => {
    const provider = new OllamaProvider({
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED'))
    });
    await expect(provider.generate('local', request)).rejects.toMatchObject({
      kind: 'unavailable',
      retriable: true
    });
  });

  it('throws a protocol error on a malformed response body', async () => {
    const provider = new OllamaProvider({
      fetchImpl: fakeFetch(() => new Response('not-json', { status: 200 }))
    });
    await expect(provider.generate('local', request)).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('reports a length finish reason when the model is truncated', async () => {
    const provider = new OllamaProvider({
      fetchImpl: fakeFetch(
        () =>
          new Response(
            JSON.stringify({
              message: { content: 'partial' },
              done_reason: 'length',
              prompt_eval_count: 5,
              eval_count: 16
            }),
            { status: 200 }
          )
      )
    });
    const result = await provider.generate('economy', request);
    expect(result.finishReason).toBe('length');
  });
});
