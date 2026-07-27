import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClientRepository } from '../../src/db/client-repository';
import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import {
  ModelUsageEventInputSchema,
  ModelUsageRepository
} from '../../src/db/model-usage-repository';

const projectRoot = join(__dirname, '..', '..');
const at = '2026-07-18T18:00:00.000Z';

function event(
  overrides: Partial<Parameters<ModelUsageRepository['record']>[0]> = {}
): Parameters<ModelUsageRepository['record']>[0] {
  return {
    id: 'usage-event-001',
    recordedAt: at,
    clientId: null,
    operation: 'classification',
    provider: 'local-runtime',
    model: 'small-classifier-v1',
    route: 'local',
    inputTokens: 120,
    outputTokens: 20,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    latencyMs: 250,
    status: 'succeeded',
    cost: { basis: 'unknown' },
    ...overrides
  };
}

describe('ModelUsageRepository', () => {
  let temporaryRoot: string;
  let context: GlobalDatabaseContext;
  let repository: ModelUsageRepository;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-model-usage-test-'));
    context = await createDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    repository = new ModelUsageRepository(context.db);
  });

  afterEach(async () => {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('reports an explicit unavailable state instead of synthetic zero spend', async () => {
    await expect(repository.dashboardSummary({ limit: 8 })).resolves.toEqual({
      status: 'unavailable',
      reason: 'No model-usage telemetry has been recorded.'
    });
  });

  it('records content-free events and separates observed, estimated, and unknown cost', async () => {
    await repository.record(
      event({
        id: 'usage-observed',
        cost: { basis: 'observed', microUsd: 125 }
      })
    );
    await repository.record(
      event({
        id: 'usage-estimated',
        route: 'economy',
        provider: 'cloud-a',
        model: 'balanced-v2',
        inputTokens: 240,
        outputTokens: 60,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        latencyMs: 600,
        cost: { basis: 'estimated', microUsd: 75, pricingVersion: 'catalog-2026-07-18' }
      })
    );
    await repository.record(
      event({
        id: 'usage-unknown',
        route: 'frontier',
        operation: 'review',
        provider: 'cloud-b',
        model: 'review-v3',
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        latencyMs: 900,
        status: 'failed',
        cost: { basis: 'unknown' }
      })
    );

    await expect(repository.dashboardSummary({ limit: 8 })).resolves.toMatchObject({
      status: 'available',
      period: { startsAt: at, endsAt: at },
      usage: {
        requestCount: 3,
        succeededCount: 2,
        failedCount: 1,
        inputTokens: 360,
        outputTokens: 80,
        cacheReadTokens: 80,
        cacheWriteTokens: 0,
        unknownTokenEvents: 1
      },
      latency: { averageMs: 583 },
      cost: {
        currency: 'USD',
        coverage: 'partial',
        knownMicroUsd: 200,
        observedMicroUsd: 125,
        estimatedMicroUsd: 75,
        observedCostEvents: 1,
        estimatedCostEvents: 1,
        unknownCostEvents: 1
      },
      routing: [
        { route: 'local', requestCount: 1 },
        { route: 'economy', requestCount: 1 },
        { route: 'frontier', requestCount: 1 }
      ]
    });
  });

  it('distinguishes an observed zero cost from unknown cost', async () => {
    await repository.record(event({ cost: { basis: 'observed', microUsd: 0 } }));

    const summary = await repository.dashboardSummary({ limit: 8 });

    expect(summary).toMatchObject({
      status: 'available',
      cost: {
        coverage: 'complete',
        knownMicroUsd: 0,
        observedCostEvents: 1,
        unknownCostEvents: 0
      }
    });
  });

  it('records subscription cost as unknown-dollar coverage and local cost as a genuine zero', async () => {
    await repository.record(
      event({
        id: 'usage-subscription',
        route: 'frontier',
        provider: 'claude',
        model: 'claude-opus',
        cost: { basis: 'subscription' }
      })
    );
    await repository.record(
      event({
        id: 'usage-local',
        route: 'local',
        provider: 'ollama',
        model: 'qwen2.5-coder',
        cost: { basis: 'local' }
      })
    );

    // Round-trips: subscription persists NULL cost, local persists an exact 0.
    const rows = context.sqlite
      .prepare('SELECT id, cost_basis, cost_microusd FROM model_usage_events ORDER BY id')
      .all() as Array<{ id: string; cost_basis: string; cost_microusd: number | null }>;
    expect(rows).toEqual([
      { id: 'usage-local', cost_basis: 'local', cost_microusd: 0 },
      { id: 'usage-subscription', cost_basis: 'subscription', cost_microusd: null }
    ]);

    const summary = await repository.dashboardSummary({ limit: 8 });
    expect(summary).toMatchObject({
      status: 'available',
      cost: {
        // local (known 0) is covered, subscription is not → partial coverage.
        coverage: 'partial',
        knownMicroUsd: 0,
        observedCostEvents: 0,
        estimatedCostEvents: 0,
        unknownCostEvents: 0,
        subscriptionCostEvents: 1,
        localCostEvents: 1
      }
    });
  });

  it('rejects a subscription or local cost that carries a dollar amount', () => {
    expect(() =>
      ModelUsageEventInputSchema.parse({
        ...event(),
        cost: { basis: 'subscription', microUsd: 10 }
      })
    ).toThrow();
    expect(() =>
      ModelUsageEventInputSchema.parse({
        ...event(),
        cost: { basis: 'local', microUsd: 5 }
      })
    ).toThrow();
  });

  it('rejects a direct write of a subscription row that carries a non-null cost', () => {
    const insert = context.sqlite.prepare(`
      INSERT INTO model_usage_events (
        id, recorded_at, client_id, operation, provider, model, route,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        latency_ms, status, cost_basis, cost_microusd, pricing_version
      ) VALUES (?, ?, NULL, 'classification', 'claude', 'claude-opus', 'frontier',
                1, 1, 0, 0, 10, 'succeeded', ?, ?, NULL)
    `);
    // subscription must be NULL cost; local must be exactly 0.
    expect(() => insert.run('bad-subscription', at, 'subscription', 5)).toThrow();
    expect(() => insert.run('bad-local', at, 'local', 5)).toThrow();
    expect(() => insert.run('ok-local', at, 'local', 0)).not.toThrow();
  });

  it('treats an exact duplicate as idempotent and rejects a conflicting event id', async () => {
    const input = event();
    const first = await repository.record(input);

    await expect(repository.record(input)).resolves.toEqual(first);
    await expect(repository.record(event({ latencyMs: input.latencyMs + 1 }))).rejects.toThrow(
      'already exists with different telemetry'
    );

    const count = context.sqlite
      .prepare('SELECT COUNT(*) AS count FROM model_usage_events')
      .get() as { count: number };
    expect(count.count).toBe(1);
  });

  it('supports explicit tenant filtering without leaking content', async () => {
    const clients = new ClientRepository(context.db);
    await clients.create({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing',
      status: 'active',
      createdAt: at
    });
    await repository.record(event({ id: 'global-usage' }));
    await repository.record(event({ id: 'tenant-usage', clientId: 'acme_corp' }));

    const summary = await repository.dashboardSummary({ limit: 8, clientId: 'acme_corp' });

    expect(summary).toMatchObject({ status: 'available', usage: { requestCount: 1 } });
  });

  it('rejects content-shaped fields, unsafe labels, and invalid cost combinations', () => {
    expect(() => ModelUsageEventInputSchema.parse({ ...event(), prompt: 'secret' })).toThrow();
    expect(() =>
      ModelUsageEventInputSchema.parse({ ...event(), provider: 'https://provider.example' })
    ).toThrow();
    expect(() =>
      ModelUsageEventInputSchema.parse({
        ...event(),
        cost: { basis: 'estimated', microUsd: 20 }
      })
    ).toThrow();
    expect(() =>
      ModelUsageEventInputSchema.parse({
        ...event(),
        cost: { basis: 'unknown', microUsd: 0 }
      })
    ).toThrow();
  });

  it('enforces telemetry invariants for direct database writes', () => {
    const insert = context.sqlite.prepare(`
      INSERT INTO model_usage_events (
        id, recorded_at, client_id, operation, provider, model, route,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        latency_ms, status, cost_basis, cost_microusd, pricing_version
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    expect(() =>
      insert.run(
        'invalid-event',
        at,
        'classification',
        'provider',
        'model',
        'local',
        -1,
        0,
        0,
        0,
        10,
        'succeeded',
        'unknown',
        null,
        null
      )
    ).toThrow();
    expect(() =>
      insert.run(
        'invalid-cost',
        at,
        'classification',
        'provider',
        'model',
        'local',
        1,
        1,
        null,
        null,
        10,
        'succeeded',
        'unknown',
        0,
        null
      )
    ).toThrow();
  });
});
