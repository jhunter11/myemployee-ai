import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkerRegistry } from '../../src/agents/worker-registry';
import { createDatabase } from '../../src/db/database';
import { PriorityQueueRepository } from '../../src/db/priority-queue-repository';
import type { HealthProvider } from '../../src/gateway/app';
import { startServer, type StartedServer } from '../../src/gateway/server';

const projectRoot = join(__dirname, '..', '..');
const now = '2026-07-18T18:00:00.000Z';
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

describe('production dashboard composition', () => {
  let temporaryRoot: string;
  let started: StartedServer | undefined;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-dashboard-server-'));
  });

  afterEach(async () => {
    await started?.stop();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('previews and publishes a declarative page into the live Markdown graph', async () => {
    const graphRoot = join(temporaryRoot, 'memory', 'graph');
    const databaseFile = join(temporaryRoot, 'jarvis.sqlite');
    const seedDatabase = await createDatabase({ projectRoot, filename: databaseFile });
    await new PriorityQueueRepository(seedDatabase.db).enqueue({
      id: 'agency-security-review',
      tenantId: 'jarvis',
      lane: 'agency',
      source: { kind: 'operator', id: 'security-review-source', occurredAt: now },
      payload: {
        kind: 'operator_gate',
        gateType: 'security',
        subjectRef: 'private-security-subject'
      },
      policy: { band: 'P0', impact: 10, urgency: 10, effort: 1 },
      dependencies: []
    });
    await seedDatabase.destroy();
    started = await startServer({
      projectRoot,
      databaseFile,
      clientRoot: join(temporaryRoot, 'clients'),
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot,
      workerRegistry: new WorkerRegistry(),
      heartbeat,
      monitoring: false,
      now: () => now,
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });
    const baseUrl = `http://127.0.0.1:${started.port}`;

    const overview = await fetch(`${baseUrl}/api/v1/dashboard/overview`);
    expect(overview.status).toBe(200);
    await expect(overview.json()).resolves.toMatchObject({
      generatedAt: now,
      health: { overall: 'healthy' },
      clients: { counts: { total: 0, active: 0, suspended: 0 }, items: [] },
      economics: {
        status: 'unavailable',
        reason: 'No model-usage telemetry has been recorded.'
      },
      improvements: { mode: 'proposal_only', proposals: [] },
      memory: { pageCount: 0 }
    });

    const queueResponse = await fetch(`${baseUrl}/api/v1/dashboard/queue`);
    expect(queueResponse.status).toBe(200);
    const queue = (await queueResponse.json()) as unknown;
    expect(queue).toMatchObject({
      generatedAt: now,
      tenantId: 'jarvis',
      returnedTaskCount: 1,
      truncated: false,
      lanes: [
        {
          lane: 'agency',
          ready: [
            {
              id: 'agency-security-review',
              payloadKind: 'operator_gate',
              band: 'P0',
              state: 'queued',
              ready: true
            }
          ]
        }
      ]
    });
    expect(JSON.stringify(queue)).not.toContain('private-security-subject');

    const request = 'Create a client health page for operations';
    const previewResponse = await fetch(`${baseUrl}/api/v1/dashboard/page-plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request })
    });
    expect(previewResponse.status).toBe(200);
    const plan = (await previewResponse.json()) as {
      fingerprint: string;
      ready: boolean;
      slug: string;
      widgets: string[];
    };
    expect(plan).toMatchObject({ ready: true, widgets: ['health', 'clients'] });

    const createResponse = await fetch(`${baseUrl}/api/v1/dashboard/pages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request,
        expectedFingerprint: plan.fingerprint,
        confirmed: true
      })
    });
    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toMatchObject({
      created: true,
      page: { slug: plan.slug, widgets: ['health', 'clients'] }
    });

    const pageMarkdown = await readFile(join(graphRoot, 'pages', `${plan.slug}.md`), 'utf8');
    expect(pageMarkdown).toContain('dashboard_manifest:');
    expect(pageMarkdown).toContain('- `health`');
    expect(pageMarkdown).toContain('- `clients`');

    const pagesResponse = await fetch(`${baseUrl}/api/v1/dashboard/pages`);
    await expect(pagesResponse.json()).resolves.toMatchObject({
      pages: [{ slug: plan.slug, widgets: ['health', 'clients'] }]
    });
  });
});
