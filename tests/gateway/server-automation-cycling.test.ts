import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClientRepository } from '../../src/db/client-repository';
import { createDatabase } from '../../src/db/database';
import { PriorityQueueRepository } from '../../src/db/priority-queue-repository';
import type { HealthProvider } from '../../src/gateway/app';
import { startServer, type StartedServer } from '../../src/gateway/server';
import { MarkdownGraph } from '../../src/memory/markdown-graph';

const projectRoot = join(__dirname, '..', '..');
const at = '2026-07-18T23:00:00.000Z';
const heartbeat: HealthProvider = {
  check: () =>
    Promise.resolve({
      timestamp: at,
      overall: 'healthy',
      severity: 'none',
      checks: { gateway: 'ok', database: 'ok' },
      failures: [],
      action: 'none'
    })
};

async function waitForSucceededRun(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/v1/dashboard/overview`);
    const body = (await response.json()) as {
      runs?: { counts?: { succeeded?: number } };
    };
    if ((body.runs?.counts?.succeeded ?? 0) >= 1) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('automation queue cycle did not complete before the test deadline');
}

describe('production automation queue cycling', () => {
  let temporaryRoot: string;
  let started: StartedServer | undefined;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-automation-cycle-server-'));
  });

  afterEach(async () => {
    await started?.stop();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('claims an active client automation, executes it, and settles durable queue evidence', async () => {
    const databaseFile = join(temporaryRoot, 'jarvis.sqlite');
    const clientRoot = join(temporaryRoot, 'clients');
    await cp(join(projectRoot, 'clients', 'acme_corp'), join(clientRoot, 'acme_corp'), {
      recursive: true
    });
    const seed = await createDatabase({ projectRoot, filename: databaseFile });
    const client = await new ClientRepository(seed.db).create({
      id: 'acme_corp',
      name: 'ACME Corp',
      profile: 'data_processing',
      status: 'active',
      createdAt: at
    });
    await new PriorityQueueRepository(seed.db).enqueue({
      id: 'queued-daily-report',
      tenantId: 'acme_corp',
      lane: 'delivery',
      source: { kind: 'schedule', id: 'daily-report-2026-07-18', occurredAt: at },
      payload: { kind: 'automation', automationId: 'daily-report' },
      policy: { band: 'P1', impact: 8, urgency: 6, effort: 3 },
      dependencies: []
    });
    await seed.destroy();
    const graphRoot = join(temporaryRoot, 'memory', 'graph');
    const graph = new MarkdownGraph({ graphRoot, clientRoot, now: () => at });
    await graph.initialize();
    await graph.createClientNode({
      ...client,
      clientDirectory: join(clientRoot, 'acme_corp')
    });

    started = await startServer({
      projectRoot,
      databaseFile,
      clientRoot,
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot,
      heartbeat,
      monitoring: false,
      now: () => at,
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });

    await waitForSucceededRun(`http://127.0.0.1:${started.port}`);
    await started.stop();
    started = undefined;

    const evidence = await createDatabase({ projectRoot, filename: databaseFile });
    await expect(
      new PriorityQueueRepository(evidence.db).readDecisionLog({
        tenantId: 'acme_corp',
        limit: 10
      })
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: 'queued-daily-report',
          decisionCode: 'lease_succeeded',
          toState: 'succeeded'
        })
      ])
    );
    await evidence.destroy();

    await expect(
      readFile(join(clientRoot, 'acme_corp', 'output', 'report.json'), 'utf8')
    ).resolves.toContain('qualifiedCount');
    await expect(readdir(join(temporaryRoot, 'logs', 'diagrams'))).resolves.toHaveLength(1);
  });
});
