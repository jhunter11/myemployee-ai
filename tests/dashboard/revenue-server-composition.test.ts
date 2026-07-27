import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkerRegistry } from '../../src/agents/worker-registry';
import { createDatabase } from '../../src/db/database';
import { RevenuePipelineRepository } from '../../src/db/revenue-pipeline-repository';
import type { HealthProvider } from '../../src/gateway/app';
import { startServer, type StartedServer } from '../../src/gateway/server';
import { MICRO_USD_PER_USD } from '../../src/revenue/contracts';

const projectRoot = join(__dirname, '..', '..');
const now = '2026-07-18T22:00:00.000Z';
const heartbeat: HealthProvider = {
  check: () =>
    Promise.resolve({
      timestamp: now,
      overall: 'healthy',
      severity: 'none',
      checks: { gateway: 'ok', database: 'ok' },
      failures: [],
      action: 'none'
    })
};

describe('production revenue dashboard composition', () => {
  let temporaryRoot: string;
  let started: StartedServer | undefined;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-revenue-dashboard-server-'));
  });

  afterEach(async () => {
    await started?.stop();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('wires the durable redacted repository into the fixed two-lane endpoint', async () => {
    const databaseFile = join(temporaryRoot, 'jarvis.sqlite');
    const seedDatabase = await createDatabase({ projectRoot, filename: databaseFile });
    const revenue = new RevenuePipelineRepository(seedDatabase.db);
    await revenue.createProspect({
      id: 'prospect_alpha',
      lane: 'agency',
      publicLabel: 'Alpha Operations',
      contactChannel: 'email',
      contactReference: 'contact:must_remain_private',
      source: 'operator_research',
      need: 'agency_automation_audit',
      actorId: 'operator:must-remain-private',
      createdAt: now
    });
    await revenue.initializeTaskMarketContract({
      productId: 'edge-validation-v1',
      a2aVersion: '0.3.0',
      skillId: 'edge_validation',
      inputContract: 'bounded_numeric_series',
      outputContract: 'validation_verdict',
      x402Scheme: 'exact',
      quotedAmountMicrousd: MICRO_USD_PER_USD / 2,
      actorId: 'operator:must-remain-private',
      createdAt: now
    });
    await seedDatabase.destroy();

    started = await startServer({
      projectRoot,
      databaseFile,
      clientRoot: join(temporaryRoot, 'clients'),
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot: join(temporaryRoot, 'memory', 'graph'),
      workerRegistry: new WorkerRegistry(),
      heartbeat,
      monitoring: false,
      now: () => now,
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });

    const response = await fetch(`http://127.0.0.1:${started.port}/api/v1/dashboard/revenue`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown;
    expect(body).toMatchObject({
      generatedAt: now,
      lanes: {
        agency: {
          lane: 'agency',
          counts: { prospects: 1 },
          prospects: [
            { id: 'prospect_alpha', publicLabel: 'Alpha Operations', hasContactReference: true }
          ]
        },
        task_market: {
          lane: 'task_market',
          activation: {
            state: 'contract_only',
            x402: {
              quote: { basis: 'simulation', amountMicrousd: MICRO_USD_PER_USD / 2 },
              paymentMode: 'blocked'
            }
          }
        }
      }
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('contact:must_remain_private');
    expect(serialized).not.toContain('operator:must-remain-private');
    expect(serialized).not.toMatch(/private[_ -]?key|walletAddress|paymentAction/i);
  });
});
