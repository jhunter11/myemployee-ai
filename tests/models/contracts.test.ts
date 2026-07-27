import { describe, expect, it } from 'vitest';

import {
  ModelGenerationRequestSchema,
  ModelGenerationResultSchema,
  ProviderError
} from '../../src/models/contracts';

describe('ModelGenerationRequestSchema', () => {
  it('accepts a well-formed bounded request', () => {
    const parsed = ModelGenerationRequestSchema.parse({
      system: 'You are Jarvis.',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'dashboard_snapshot', description: 'read', parameters: {} }],
      maxOutputTokens: 512,
      timeoutMs: 30_000
    });
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.tools?.[0]?.name).toBe('dashboard_snapshot');
  });

  it('rejects an empty message list, a bad tool name, and an out-of-range budget', () => {
    expect(() =>
      ModelGenerationRequestSchema.parse({
        system: '',
        messages: [],
        maxOutputTokens: 10,
        timeoutMs: 30_000
      })
    ).toThrow();
    expect(() =>
      ModelGenerationRequestSchema.parse({
        system: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'Bad Name', description: 'd', parameters: {} }],
        maxOutputTokens: 10,
        timeoutMs: 30_000
      })
    ).toThrow();
    expect(() =>
      ModelGenerationRequestSchema.parse({
        system: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        maxOutputTokens: 999_999,
        timeoutMs: 30_000
      })
    ).toThrow();
  });
});

describe('ModelGenerationResultSchema', () => {
  it('accepts bounded normalized provider output', () => {
    expect(
      ModelGenerationResultSchema.parse({
        text: 'Ready.',
        toolCalls: [],
        tokensIn: 12,
        tokensOut: 2,
        cacheReadTokens: null,
        cacheWriteTokens: 0,
        provider: 'ollama',
        model: 'qwen3:8b',
        costBasis: 'local',
        finishReason: 'stop'
      })
    ).toMatchObject({ text: 'Ready.', provider: 'ollama' });
  });

  it('rejects unknown fields, unsafe counters, malformed tools, and unbounded output', () => {
    const valid = {
      text: 'Ready.',
      toolCalls: [],
      tokensIn: 12,
      tokensOut: 2,
      cacheReadTokens: null,
      cacheWriteTokens: 0,
      provider: 'ollama',
      model: 'qwen3:8b',
      costBasis: 'local',
      finishReason: 'stop'
    };

    expect(ModelGenerationResultSchema.safeParse({ ...valid, secret: 'nope' }).success).toBe(false);
    expect(
      ModelGenerationResultSchema.safeParse({
        ...valid,
        tokensOut: Number.MAX_SAFE_INTEGER + 1
      }).success
    ).toBe(false);
    expect(
      ModelGenerationResultSchema.safeParse({
        ...valid,
        toolCalls: [{ name: 'Bad Tool', arguments: {} }]
      }).success
    ).toBe(false);
    expect(
      ModelGenerationResultSchema.safeParse({ ...valid, text: 'x'.repeat(1_048_577) }).success
    ).toBe(false);
    expect(ModelGenerationResultSchema.safeParse({ ...valid, text: '' }).success).toBe(false);
  });
});

describe('ProviderError', () => {
  it('carries the provider, kind, and retriable flag with a prefixed message', () => {
    const error = new ProviderError('ollama', 'runtime down', 'unavailable', true);
    expect(error.name).toBe('ProviderError');
    expect(error.provider).toBe('ollama');
    expect(error.kind).toBe('unavailable');
    expect(error.retriable).toBe(true);
    expect(error.message).toBe('[ollama] runtime down');
  });

  it('optionally carries a rate-limit reset timestamp while preserving four-argument construction', () => {
    const resetAt = 1_752_003_600_000;
    const limited = new ProviderError(
      'codex',
      'subscription rate limited',
      'rate_limited',
      true,
      resetAt
    );
    const legacy = new ProviderError('ollama', 'runtime down', 'unavailable', true);

    expect(limited).toMatchObject({
      provider: 'codex',
      kind: 'rate_limited',
      retriable: true,
      resetAt
    });
    expect(legacy.resetAt).toBeUndefined();
  });
});
