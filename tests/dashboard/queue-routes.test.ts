import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import type { ClientService } from '../../src/clients/service';
import type { DashboardApi } from '../../src/dashboard/routes';
import { createApp, type AutomationRunner } from '../../src/gateway/app';
import { RequestMetrics } from '../../src/gateway/metrics';

const projectRoot = join(__dirname, '..', '..');
const now = '2026-07-18T18:00:00.000Z';

describe('dashboard queue read route', () => {
  it('serves one no-store redacted snapshot and rejects caller-controlled scope', async () => {
    const queueSnapshot = vi.fn(() =>
      Promise.resolve({
        generatedAt: now,
        tenantId: 'jarvis',
        returnedTaskCount: 1,
        truncated: false,
        lanes: [
          {
            lane: 'agency',
            ready: [
              {
                id: 'agency-follow-up-1',
                lane: 'agency',
                payloadKind: 'project_task' as const,
                band: 'P2' as const,
                state: 'queued' as const,
                version: 1,
                dependencyCount: 0,
                blockedDependencyCount: 0,
                createdAt: now,
                availableAt: now,
                ready: true
              }
            ],
            blocked: []
          }
        ]
      })
    );
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
      queueSnapshot,
      graphIndex: () => Promise.resolve({ generatedAt: now, nodes: [], edges: [] }),
      listPages: () => Promise.resolve([]),
      previewPage: () => Promise.reject(new Error('not used')),
      createPage: () => Promise.reject(new Error('not used'))
    };
    const app = createApp({
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

    const response = await request(app).get('/api/v1/dashboard/queue').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      generatedAt: now,
      tenantId: 'jarvis',
      lanes: [{ lane: 'agency', ready: [{ id: 'agency-follow-up-1', band: 'P2' }] }]
    });

    await request(app).get('/api/v1/dashboard/queue?tenantId=acme_corp').expect(400);
    await request(app).get('/api/v1/dashboard/queue?lane=agency').expect(400);
    await request(app).get('/api/v1/dashboard/queue?limit=50').expect(400);
    await request(app).post('/api/v1/dashboard/queue').send({}).expect(404);
    expect(queueSnapshot).toHaveBeenCalledOnce();
  });
});
