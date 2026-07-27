import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import { ModelUsageRepository } from '../../src/db/model-usage-repository';
import { ModelExecutor } from '../../src/models/model-executor';
import { OllamaProvider } from '../../src/models/ollama-provider';
import { ProviderCatalog } from '../../src/models/provider-catalog';

const projectRoot = join(__dirname, '..', '..');

// The smallest model pulled on this host; keeps the live turn fast.
const LIVE_MODEL = 'qwen2.5-coder:1.5b';

// Only run when a real Ollama runtime is serving locally. Elsewhere (CI, a host
// without Ollama) the single test skips itself rather than failing — the adapter's
// parsing/error logic is covered by the unit tests either way.
describe('Ollama live integration (real localhost runtime)', () => {
  let temporaryRoot: string;
  let context: GlobalDatabaseContext | undefined;
  let executor: ModelExecutor | undefined;
  let ollamaLive = false;

  beforeAll(async () => {
    ollamaLive = await new OllamaProvider()
      .probe()
      .then((availability) => availability.available)
      .catch(() => false);
    if (!ollamaLive) return;
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-ollama-live-test-'));
    context = await createDatabase({ projectRoot, filename: join(temporaryRoot, 'jarvis.sqlite') });
    const provider = new OllamaProvider({
      models: { local: LIVE_MODEL, economy: LIVE_MODEL, frontier: LIVE_MODEL }
    });
    executor = new ModelExecutor({
      catalog: new ProviderCatalog([provider]),
      usage: new ModelUsageRepository(context.db)
    });
  });

  afterAll(async () => {
    if (context) {
      await context.destroy();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('generates a real completion and meters a local (0-cost) usage row', async (ctx) => {
    if (!ollamaLive || !executor || !context) {
      ctx.skip();
      return;
    }
    const outcome = await executor.execute({
      operation: 'classification',
      clientId: null,
      route: 'local',
      generation: {
        system: 'You reply with exactly one lowercase word and nothing else.',
        messages: [{ role: 'user', content: 'Respond with the word: pong' }],
        maxOutputTokens: 16,
        timeoutMs: 120_000
      },
      allowedProviders: ['ollama']
    });

    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;
    expect(outcome.provider).toBe('ollama');
    expect(outcome.result.text.trim().length).toBeGreaterThan(0);
    expect(outcome.result.costBasis).toBe('local');

    const row = context.sqlite
      .prepare('SELECT provider, route, status, cost_basis, cost_microusd FROM model_usage_events')
      .get();
    expect(row).toEqual({
      provider: 'ollama',
      route: 'local',
      status: 'succeeded',
      cost_basis: 'local',
      cost_microusd: 0
    });
  }, 130_000);
});
