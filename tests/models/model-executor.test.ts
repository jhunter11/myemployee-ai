import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import { ModelUsageRepository } from '../../src/db/model-usage-repository';
import {
  ProviderError,
  type ModelGenerationRequest,
  type ModelGenerationResult
} from '../../src/models/contracts';
import { FakeModelProvider } from '../../src/models/fake-provider';
import {
  MAX_MODEL_RESULT_TEXT_BYTES,
  ModelExecutor,
  PROVIDER_CLAIM_COMPLETION_GRACE_MS
} from '../../src/models/model-executor';
import { ProviderCatalog } from '../../src/models/provider-catalog';
import { ProviderRateLimitCircuit } from '../../src/models/provider-rate-limit-circuit';

const projectRoot = join(__dirname, '..', '..');

const generation: ModelGenerationRequest = {
  system: 'You are Jarvis.',
  messages: [{ role: 'user', content: 'status?' }],
  maxOutputTokens: 256,
  timeoutMs: 30_000
};

function sub(
  id: 'claude' | 'codex' | 'gemini',
  opts: Partial<ConstructorParameters<typeof FakeModelProvider>[0]> = {}
) {
  return new FakeModelProvider({
    id,
    costBasis: 'subscription',
    available: true,
    routes: ['economy', 'frontier'],
    ...opts
  });
}

function ollama(opts: Partial<ConstructorParameters<typeof FakeModelProvider>[0]> = {}) {
  return new FakeModelProvider({
    id: 'ollama',
    costBasis: 'local',
    available: true,
    routes: ['local', 'economy', 'frontier'],
    models: { local: 'qwen2.5-coder:7b', economy: 'qwen3:8b', frontier: 'qwen3:8b' },
    ...opts
  });
}

describe('ModelExecutor', () => {
  let temporaryRoot: string;
  let context: GlobalDatabaseContext;
  let usage: ModelUsageRepository;
  let ids: number;
  let nowMs: number;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-model-executor-test-'));
    context = await createDatabase({ projectRoot, filename: join(temporaryRoot, 'jarvis.sqlite') });
    usage = new ModelUsageRepository(context.db);
    ids = 0;
    nowMs = 1_752_000_000_000;
  });

  afterEach(async () => {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  function executor(
    providers: FakeModelProvider[],
    rateLimitCircuit?: ProviderRateLimitCircuit
  ): ModelExecutor {
    return new ModelExecutor({
      catalog: new ProviderCatalog(providers),
      usage,
      clock: () => nowMs,
      ...(rateLimitCircuit === undefined ? {} : { rateLimitCircuit }),
      newId: () => `model-usage:test-${(ids += 1).toString().padStart(4, '0')}`
    });
  }

  it('calls the bound subscription provider and meters a subscription (NULL) cost row', async () => {
    const claude = sub('claude');
    const outcome = await executor([claude, ollama()]).execute({
      operation: 'summarization',
      clientId: null,
      route: 'economy',
      generation,
      allowedProviders: ['claude', 'codex', 'gemini', 'ollama']
    });

    expect(outcome.status).toBe('succeeded');
    expect(claude.requests).toHaveLength(1);

    const rows = context.sqlite
      .prepare(
        'SELECT provider, model, route, status, cost_basis, cost_microusd FROM model_usage_events'
      )
      .all();
    expect(rows).toEqual([
      {
        provider: 'claude',
        model: 'fake-economy',
        route: 'economy',
        status: 'succeeded',
        cost_basis: 'subscription',
        cost_microusd: null
      }
    ]);
  });

  it('meters an Ollama call as a local (exactly 0) cost row', async () => {
    const outcome = await executor([ollama()]).execute({
      operation: 'code',
      clientId: null,
      route: 'local',
      generation,
      allowedProviders: ['ollama']
    });

    expect(outcome.status).toBe('succeeded');
    const row = context.sqlite
      .prepare('SELECT provider, cost_basis, cost_microusd FROM model_usage_events')
      .get();
    expect(row).toEqual({ provider: 'ollama', cost_basis: 'local', cost_microusd: 0 });
  });

  it('never attempts a provider outside the operator allow-list (deny-first)', async () => {
    const claude = sub('claude');
    const local = ollama();
    // claude is available and preferred, but only ollama is authorized.
    const outcome = await executor([claude, local]).execute({
      operation: 'drafting',
      clientId: null,
      route: 'economy',
      generation,
      allowedProviders: ['ollama']
    });

    expect(outcome.status).toBe('succeeded');
    expect(claude.probeCount).toBe(0);
    expect(claude.requests).toHaveLength(0);
    if (outcome.status === 'succeeded') expect(outcome.provider).toBe('ollama');
  });

  it('falls through to the next candidate on a provider failure and meters both attempts', async () => {
    const claude = sub('claude', {
      failWith: new ProviderError(
        'claude',
        'DO_NOT_LEAK private prompt and provider response',
        'auth',
        false
      )
    });
    const codex = sub('codex');
    const outcome = await executor([claude, codex, ollama()]).execute({
      operation: 'review',
      clientId: null,
      route: 'frontier',
      generation,
      allowedProviders: ['claude', 'codex', 'gemini', 'ollama']
    });

    expect(outcome.status).toBe('succeeded');
    if (outcome.status === 'succeeded') {
      expect(outcome.provider).toBe('codex');
      expect(outcome.attempts[0]?.detail).toBe('auth: provider attempt failed');
    }
    expect(JSON.stringify(outcome)).not.toContain('DO_NOT_LEAK');

    const rows = context.sqlite
      .prepare('SELECT provider, status FROM model_usage_events ORDER BY id')
      .all();
    expect(rows).toEqual([
      { provider: 'claude', status: 'failed' },
      { provider: 'codex', status: 'succeeded' }
    ]);
  });

  it('fails closed without a second provider call when successful generation cannot be metered', async () => {
    const claude = sub('claude', {
      result: { text: 'DO_NOT_RETURN_UNMETERED_COMPLETION' }
    });
    const codex = sub('codex');
    const record = vi
      .spyOn(usage, 'record')
      .mockRejectedValue(new Error('database unavailable: DO_NOT_LEAK_USAGE_ERROR'));

    const outcome = await executor([claude, codex]).execute({
      operation: 'review',
      clientId: null,
      route: 'frontier',
      generation,
      allowedProviders: ['claude', 'codex']
    });

    expect(outcome).toEqual({
      status: 'metering_failed',
      provider: 'claude',
      model: 'fake-frontier',
      attempts: []
    });
    expect(claude.requests).toHaveLength(1);
    expect(codex.requests).toHaveLength(0);
    expect(record).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(outcome)).not.toContain('DO_NOT_RETURN_UNMETERED_COMPLETION');
    expect(JSON.stringify(outcome)).not.toContain('DO_NOT_LEAK_USAGE_ERROR');
    expect(
      context.sqlite.prepare('SELECT COUNT(*) AS count FROM model_usage_events').get()
    ).toEqual({ count: 0 });
  });

  it.each([
    ['schema', { tokensIn: -1 }],
    ['provider identity', { provider: 'codex' as const }],
    ['model identity', { model: 'unexpected-model' }],
    ['cost basis', { costBasis: 'local' as const }],
    ['output token bound', { tokensOut: generation.maxOutputTokens + 1 }],
    ['UTF-8 output byte bound', { text: '😀'.repeat(MAX_MODEL_RESULT_TEXT_BYTES / 4 + 1) }],
    ['undeclared tool', { toolCalls: [{ name: 'read_secret', arguments: { path: 'ignored' } }] }]
  ] satisfies Array<[string, Partial<ModelGenerationResult>]>)(
    'treats an invalid provider result (%s) as a sanitized protocol failure and falls through',
    async (_case, result) => {
      const claude = sub('claude', { result });
      const local = ollama();

      const outcome = await executor([claude, local]).execute({
        operation: 'review',
        clientId: null,
        route: 'economy',
        generation,
        allowedProviders: ['claude', 'ollama']
      });

      expect(outcome.status).toBe('succeeded');
      if (outcome.status === 'succeeded') {
        expect(outcome.provider).toBe('ollama');
        expect(outcome.attempts[0]).toMatchObject({
          provider: 'claude',
          status: 'failed',
          detail: 'protocol: provider attempt failed'
        });
      }
      expect(claude.requests).toHaveLength(1);
      expect(local.requests).toHaveLength(1);
      expect(
        context.sqlite.prepare('SELECT provider, status FROM model_usage_events ORDER BY id').all()
      ).toEqual([
        { provider: 'claude', status: 'failed' },
        { provider: 'ollama', status: 'succeeded' }
      ]);
    }
  );

  it('returns all_failed and meters each failed attempt when every candidate errors', async () => {
    const claude = sub('claude', {
      failWith: new ProviderError('claude', 'timeout', 'timeout', true)
    });
    const local = ollama({
      failWith: new ProviderError('ollama', 'runtime down', 'unavailable', true)
    });
    const outcome = await executor([claude, local]).execute({
      operation: 'classification',
      clientId: null,
      route: 'economy',
      generation,
      allowedProviders: ['claude', 'ollama']
    });

    expect(outcome.status).toBe('all_failed');
    const rows = context.sqlite
      .prepare('SELECT provider, status FROM model_usage_events ORDER BY id')
      .all();
    expect(rows).toEqual([
      { provider: 'claude', status: 'timeout' },
      { provider: 'ollama', status: 'failed' }
    ]);
  });

  it('returns no_runtime without any usage row when no authorized provider is available', async () => {
    const outcome = await executor([
      sub('claude', { available: false }),
      ollama({ available: false })
    ]).execute({
      operation: 'synthesis',
      clientId: null,
      route: 'economy',
      generation,
      allowedProviders: ['claude', 'codex', 'gemini', 'ollama']
    });

    expect(outcome.status).toBe('no_runtime');
    const count = context.sqlite
      .prepare('SELECT COUNT(*) AS count FROM model_usage_events')
      .get() as { count: number };
    expect(count.count).toBe(0);
  });

  it('rejects malformed direct inputs before probes, generations, or usage writes', async () => {
    const claude = sub('claude');
    const local = ollama();
    const modelExecutor = executor([claude, local]);
    const valid = {
      operation: 'drafting',
      clientId: null,
      route: 'economy',
      generation,
      allowedProviders: ['claude', 'ollama']
    };
    const malformed: unknown[] = [
      {
        ...valid,
        generation: { ...generation, timeoutMs: 999 }
      },
      {
        ...valid,
        clientId: '../other_tenant'
      },
      {
        ...valid,
        unexpected: true
      }
    ];

    for (const input of malformed) {
      await expect(modelExecutor.execute(input as never)).rejects.toThrow();
    }

    expect(claude.probeCount).toBe(0);
    expect(local.probeCount).toBe(0);
    expect(claude.requests).toEqual([]);
    expect(local.requests).toEqual([]);
    const count = context.sqlite
      .prepare('SELECT COUNT(*) AS count FROM model_usage_events')
      .get() as { count: number };
    expect(count.count).toBe(0);
  });

  it('reports the earliest retry when every authorized candidate is cooling down', async () => {
    const circuit = new ProviderRateLimitCircuit(context.sqlite, { clock: () => nowMs });
    circuit.open('claude', { detectedAt: nowMs, resetAt: nowMs + 20 * 60_000 });
    circuit.open('codex', { detectedAt: nowMs, resetAt: nowMs + 10 * 60_000 });
    const claude = sub('claude');
    const codex = sub('codex');

    const outcome = await executor([claude, codex], circuit).execute({
      operation: 'drafting',
      clientId: null,
      route: 'economy',
      generation,
      allowedProviders: ['claude', 'codex']
    });

    expect(outcome).toEqual({
      status: 'cooling_down',
      retryAt: nowMs + 15 * 60_000,
      attempts: []
    });
    expect(claude.requests).toEqual([]);
    expect(codex.requests).toEqual([]);
    const count = context.sqlite
      .prepare('SELECT COUNT(*) AS count FROM model_usage_events')
      .get() as { count: number };
    expect(count.count).toBe(0);
  });

  it('opens a durable cooldown on a rate limit and skips that provider on later calls', async () => {
    const claude = sub('claude', {
      failWith: new ProviderError('claude', 'usage limit reached', 'rate_limited', true)
    });
    const local = ollama();
    const circuit = new ProviderRateLimitCircuit(context.sqlite, { clock: () => nowMs });
    const modelExecutor = executor([claude, local], circuit);
    const input = {
      operation: 'drafting' as const,
      clientId: null,
      route: 'economy' as const,
      generation,
      allowedProviders: ['claude', 'ollama'] as const
    };

    const first = await modelExecutor.execute({
      ...input,
      allowedProviders: [...input.allowedProviders]
    });
    const second = await modelExecutor.execute({
      ...input,
      allowedProviders: [...input.allowedProviders]
    });

    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('succeeded');
    expect(claude.requests).toHaveLength(1);
    expect(local.requests).toHaveLength(2);
    expect(
      context.sqlite
        .prepare(
          'SELECT state, reset_at, not_before FROM provider_rate_limit_circuits WHERE provider = ?'
        )
        .get('claude')
    ).toEqual({
      state: 'open',
      reset_at: null,
      not_before: nowMs + 60 * 60 * 1_000
    });
    expect(
      context.sqlite
        .prepare('SELECT provider FROM model_usage_events ORDER BY recorded_at, id')
        .all()
    ).toEqual([{ provider: 'claude' }, { provider: 'ollama' }, { provider: 'ollama' }]);
  });

  it('retries at a trusted reset plus five minutes and reopens on another limit', async () => {
    const resetAt = nowMs + 10 * 60 * 1_000;
    const claude = sub('claude', {
      failWith: new ProviderError('claude', 'usage limit reached', 'rate_limited', true, resetAt)
    });
    const local = ollama();
    const circuit = new ProviderRateLimitCircuit(context.sqlite, { clock: () => nowMs });
    const modelExecutor = executor([claude, local], circuit);
    const input = {
      operation: 'drafting' as const,
      clientId: null,
      route: 'economy' as const,
      generation,
      allowedProviders: ['claude', 'ollama'] as const
    };

    await modelExecutor.execute({ ...input, allowedProviders: [...input.allowedProviders] });
    nowMs = resetAt + 5 * 60 * 1_000 - 1;
    await modelExecutor.execute({ ...input, allowedProviders: [...input.allowedProviders] });
    expect(claude.requests).toHaveLength(1);

    nowMs += 1;
    await modelExecutor.execute({ ...input, allowedProviders: [...input.allowedProviders] });
    expect(claude.requests).toHaveLength(2);
    expect(
      context.sqlite
        .prepare(
          'SELECT state, reset_at, not_before FROM provider_rate_limit_circuits WHERE provider = ?'
        )
        .get('claude')
    ).toEqual({
      state: 'open',
      reset_at: null,
      not_before: nowMs + 60 * 60 * 1_000
    });
  });

  it('passes the request timeout as the half-open lease and closes on success', async () => {
    const claude = sub('claude');
    const circuit = new ProviderRateLimitCircuit(context.sqlite, { clock: () => nowMs });
    circuit.open('claude', { detectedAt: nowMs - 60 * 60_000, resetAt: null });
    const claim = vi.spyOn(circuit, 'claim');
    const close = vi.spyOn(circuit, 'close');

    const outcome = await executor([claude], circuit).execute({
      operation: 'summarization',
      clientId: null,
      route: 'economy',
      generation,
      allowedProviders: ['claude']
    });

    expect(outcome.status).toBe('succeeded');
    expect(claim).toHaveBeenCalledWith(
      'claude',
      generation.timeoutMs + PROVIDER_CLAIM_COMPLETION_GRACE_MS
    );
    expect(close).toHaveBeenCalledWith(
      'claude',
      nowMs + generation.timeoutMs + PROVIDER_CLAIM_COMPLETION_GRACE_MS
    );
    expect(
      context.sqlite
        .prepare('SELECT provider FROM provider_rate_limit_circuits WHERE provider = ?')
        .get('claude')
    ).toBeUndefined();
  });

  it('releases a non-rate-limit half-open failure so the next request is not wedged', async () => {
    const claude = sub('claude', {
      failWith: new ProviderError('claude', 'temporary protocol failure', 'protocol', true)
    });
    const local = ollama();
    const circuit = new ProviderRateLimitCircuit(context.sqlite, { clock: () => nowMs });
    circuit.open('claude', { detectedAt: nowMs - 60 * 60_000, resetAt: null });
    const release = vi.spyOn(circuit, 'release');
    const modelExecutor = executor([claude, local], circuit);
    const input = {
      operation: 'drafting' as const,
      clientId: null,
      route: 'economy' as const,
      generation,
      allowedProviders: ['claude', 'ollama'] as const
    };

    await modelExecutor.execute({ ...input, allowedProviders: [...input.allowedProviders] });
    expect(
      context.sqlite
        .prepare(
          `SELECT state, claim_expires_at
             FROM provider_rate_limit_circuits
            WHERE provider = ?`
        )
        .get('claude')
    ).toEqual({ state: 'open', claim_expires_at: null });
    expect(release).toHaveBeenCalledWith(
      'claude',
      nowMs + generation.timeoutMs + PROVIDER_CLAIM_COMPLETION_GRACE_MS
    );

    await modelExecutor.execute({ ...input, allowedProviders: [...input.allowedProviders] });
    expect(claude.requests).toHaveLength(2);
    expect(local.requests).toHaveLength(2);
  });
});
