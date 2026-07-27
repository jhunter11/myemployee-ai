import { describe, expect, it } from 'vitest';

import type { ModelProviderId, ModelTierRoute } from '../../src/models/contracts';
import { FakeModelProvider } from '../../src/models/fake-provider';
import { DEFAULT_PROVIDER_PREFERENCES, ProviderCatalog } from '../../src/models/provider-catalog';

function subscription(id: ModelProviderId, available: boolean): FakeModelProvider {
  return new FakeModelProvider({
    id,
    costBasis: 'subscription',
    available,
    routes: ['economy', 'frontier']
  });
}

function ollama(available: boolean): FakeModelProvider {
  return new FakeModelProvider({
    id: 'ollama',
    costBasis: 'local',
    available,
    routes: ['local', 'economy', 'frontier'],
    models: { local: 'qwen2.5-coder:7b', economy: 'qwen3:8b', frontier: 'qwen3:8b' }
  });
}

function catalog(providers: FakeModelProvider[]): ProviderCatalog {
  return new ProviderCatalog(providers, DEFAULT_PROVIDER_PREFERENCES);
}

function reasons(
  bindings: Awaited<ReturnType<ProviderCatalog['resolve']>>['bindings']
): Record<ModelTierRoute, { provider: ModelProviderId | null; reason: string }> {
  return {
    local: { provider: bindings.local.provider, reason: bindings.local.reason },
    economy: { provider: bindings.economy.provider, reason: bindings.economy.reason },
    frontier: { provider: bindings.frontier.provider, reason: bindings.frontier.reason }
  };
}

describe('ProviderCatalog', () => {
  it('binds economy/frontier to the first available subscription and local to Ollama', async () => {
    const resolution = await catalog([
      subscription('claude', true),
      subscription('codex', true),
      subscription('gemini', true),
      ollama(true)
    ]).resolve();

    expect(reasons(resolution.bindings)).toEqual({
      local: { provider: 'ollama', reason: 'bound_local' },
      economy: { provider: 'claude', reason: 'bound_preferred' },
      frontier: { provider: 'claude', reason: 'bound_preferred' }
    });
    expect(resolution.bindings.economy.model).toBe('fake-economy');
    expect(resolution.bindings.local.model).toBe('qwen2.5-coder:7b');
    // Ordered candidates place every available subscription first (preference
    // order, for call-time fall-through) and Ollama last as the backstop.
    expect(resolution.candidates.economy.map((p) => p.id)).toEqual([
      'claude',
      'codex',
      'gemini',
      'ollama'
    ]);
  });

  it('honours the preference order when the first subscription is unavailable', async () => {
    const resolution = await catalog([
      subscription('claude', false),
      subscription('codex', true),
      subscription('gemini', true),
      ollama(true)
    ]).resolve();

    expect(resolution.bindings.economy.provider).toBe('codex');
    expect(resolution.bindings.frontier.provider).toBe('codex');
    expect(resolution.candidates.frontier.map((p) => p.id)).toEqual(['codex', 'gemini', 'ollama']);
  });

  it('degrades economy/frontier to Ollama when every subscription is unavailable', async () => {
    const resolution = await catalog([
      subscription('claude', false),
      subscription('codex', false),
      subscription('gemini', false),
      ollama(true)
    ]).resolve();

    expect(reasons(resolution.bindings)).toEqual({
      local: { provider: 'ollama', reason: 'bound_local' },
      economy: { provider: 'ollama', reason: 'degraded_to_local' },
      frontier: { provider: 'ollama', reason: 'degraded_to_local' }
    });
    expect(resolution.bindings.frontier.model).toBe('qwen3:8b');
    expect(resolution.candidates.economy.map((p) => p.id)).toEqual(['ollama']);
  });

  it('resolves to a deterministic fallback when nothing is available', async () => {
    const resolution = await catalog([
      subscription('claude', false),
      subscription('codex', false),
      subscription('gemini', false),
      ollama(false)
    ]).resolve();

    expect(reasons(resolution.bindings)).toEqual({
      local: { provider: null, reason: 'no_provider_available' },
      economy: { provider: null, reason: 'no_provider_available' },
      frontier: { provider: null, reason: 'no_provider_available' }
    });
    for (const route of ['local', 'economy', 'frontier'] as const) {
      expect(resolution.candidates[route]).toEqual([]);
    }
  });

  it('reports deterministic fallback for local when only subscriptions are up', async () => {
    // Subscriptions never serve the `local` route — it is Ollama-only.
    const resolution = await catalog([
      subscription('claude', true),
      subscription('codex', true),
      subscription('gemini', true),
      ollama(false)
    ]).resolve();

    expect(resolution.bindings.local).toMatchObject({
      provider: null,
      reason: 'no_provider_available'
    });
    expect(resolution.bindings.economy.provider).toBe('claude');
  });

  it('treats a throwing probe as unavailable (fail closed)', async () => {
    const exploding = new FakeModelProvider({
      id: 'claude',
      costBasis: 'subscription',
      available: true,
      routes: ['economy', 'frontier']
    });
    exploding.probe = () => Promise.reject(new Error('boom'));

    const resolution = await catalog([
      exploding,
      subscription('codex', true),
      ollama(true)
    ]).resolve();

    expect(resolution.availability).toContainEqual({
      provider: 'claude',
      available: false,
      detail: 'probe failed'
    });
    expect(resolution.bindings.economy.provider).toBe('codex');
  });

  it('probes every registered provider exactly once per resolve', async () => {
    const claude = subscription('claude', true);
    const local = ollama(true);
    await catalog([claude, local]).resolve();
    expect(claude.probeCount).toBe(1);
    expect(local.probeCount).toBe(1);
  });
});
