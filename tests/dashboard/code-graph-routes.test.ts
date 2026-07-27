import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import type { ClientService } from '../../src/clients/service';
import type { DashboardCodeGraphSnapshot } from '../../src/dashboard/code-graph-reader';
import type { DashboardApi } from '../../src/dashboard/routes';
import { createApp, type AutomationRunner } from '../../src/gateway/app';
import { RequestMetrics } from '../../src/gateway/metrics';

const projectRoot = join(__dirname, '..', '..');
const now = '2026-07-25T18:00:00.000Z';

function createDashboardApp(codeGraphIndex?: NonNullable<DashboardApi['codeGraphIndex']>) {
  const clients: ClientService = {
    list: () => Promise.resolve([]),
    findById: () => Promise.resolve(undefined),
    create: () => Promise.reject(new Error('not used'))
  };
  const runner: AutomationRunner = {
    run: () => Promise.reject(new Error('not used'))
  };
  const dashboard: DashboardApi = {
    overview: () => Promise.resolve({}),
    queueSnapshot: () =>
      Promise.resolve({
        generatedAt: now,
        tenantId: 'jarvis',
        returnedTaskCount: 0,
        truncated: false,
        lanes: []
      }),
    ...(codeGraphIndex === undefined ? {} : { codeGraphIndex }),
    graphIndex: () => Promise.resolve({ generatedAt: now, nodes: [], edges: [] }),
    listPages: () => Promise.resolve([]),
    previewPage: () => Promise.reject(new Error('not used')),
    createPage: () => Promise.reject(new Error('not used'))
  };
  return createApp({
    clients,
    runner,
    metrics: new RequestMetrics(),
    health: {
      check: () =>
        Promise.resolve({
          timestamp: now,
          overall: 'healthy',
          severity: 'none',
          checks: { gateway: 'ok' },
          failures: [],
          action: 'none'
        })
    },
    requestLog: () => undefined,
    dashboard,
    dashboardRoot: join(projectRoot, 'public', 'dashboard')
  });
}

describe('dashboard Graphify code graph route', () => {
  it('serves one no-store fixed harness projection and rejects caller-selected scope', async () => {
    const snapshot: DashboardCodeGraphSnapshot = {
      schemaVersion: 1,
      source: 'graphify',
      scope: 'harness',
      indexedAt: now,
      builtAtCommit: 'a'.repeat(40),
      currentCommit: 'b'.repeat(40),
      revisionStatus: 'stale',
      totalNodeCount: 1,
      totalEdgeCount: 0,
      omittedNonStructuralEdgeCount: 0,
      nodes: [
        {
          id: 'dashboard_routes',
          title: 'routes.ts',
          type: 'code',
          path: 'src/dashboard/routes.ts',
          line: 1,
          community: 2
        }
      ],
      edges: []
    };
    const codeGraphIndex = vi.fn(() => Promise.resolve(snapshot));
    const app = createDashboardApp(codeGraphIndex);

    const response = await request(app).get('/api/v1/dashboard/code-graph').expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual(snapshot);
    for (const query of [
      'project_path=/private/repository',
      'tenantId=acme_corp',
      'scope=client',
      'partition=graphify%2Fclient%2Facme_corp',
      'limit=100'
    ]) {
      await request(app)
        .get(`/api/v1/dashboard/code-graph?${query}`)
        .expect('cache-control', 'no-store')
        .expect(400)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            error: { code: 'VALIDATION_ERROR' }
          });
        });
    }
    expect(codeGraphIndex).toHaveBeenCalledOnce();
    expect(codeGraphIndex).toHaveBeenCalledWith();
    await request(app).post('/api/v1/dashboard/code-graph').send({}).expect(404);
  });

  it('keeps the Markdown graph available when the optional code reader is not configured', async () => {
    const app = createDashboardApp();

    await request(app).get('/api/v1/dashboard/graph').expect(200);
    await request(app)
      .get('/api/v1/dashboard/code-graph')
      .expect('cache-control', 'no-store')
      .expect(503, {
        error: {
          code: 'DASHBOARD_CODE_GRAPH_UNAVAILABLE',
          message: 'The harness code graph is unavailable'
        }
      });
  });
});
