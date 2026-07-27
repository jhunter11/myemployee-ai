import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import type { ClientService } from '../../src/clients/service';
import type { DashboardApi } from '../../src/dashboard/routes';
import { createApp, type AutomationRunner } from '../../src/gateway/app';
import { RequestMetrics } from '../../src/gateway/metrics';
import { REVENUE_PIPELINE_SAFETY } from '../../src/revenue/contracts';

const projectRoot = join(__dirname, '..', '..');
const now = '2026-07-18T22:00:00.000Z';

describe('dashboard revenue read route', () => {
  it('serves one no-store fixed-scope snapshot and rejects query scope or mutations', async () => {
    const revenueSnapshot = vi.fn(() =>
      Promise.resolve({
        generatedAt: now,
        lanes: {
          agency: {
            lane: 'agency' as const,
            counts: { prospects: 0, offers: 0, outreachDrafts: 0, simulations: 0 },
            prospects: [],
            offers: [],
            outreachDrafts: [],
            simulations: [],
            activation: null,
            safety: REVENUE_PIPELINE_SAFETY
          },
          task_market: {
            lane: 'task_market' as const,
            counts: { prospects: 0, offers: 0, outreachDrafts: 0, simulations: 0 },
            prospects: [],
            offers: [],
            outreachDrafts: [],
            simulations: [],
            activation: null,
            safety: REVENUE_PIPELINE_SAFETY
          }
        }
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
      queueSnapshot: () =>
        Promise.resolve({
          generatedAt: now,
          tenantId: 'jarvis',
          returnedTaskCount: 0,
          truncated: false,
          lanes: []
        }),
      revenueSnapshot,
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

    const response = await request(app).get('/api/v1/dashboard/revenue').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      generatedAt: now,
      lanes: {
        agency: { lane: 'agency' },
        task_market: { lane: 'task_market' }
      }
    });

    await request(app).get('/api/v1/dashboard/revenue?lane=agency').expect(400);
    await request(app).get('/api/v1/dashboard/revenue?limit=50').expect(400);
    await request(app).get('/api/v1/dashboard/revenue?clientId=acme_corp').expect(400);
    dashboard.revenueSnapshot = undefined;
    await request(app).get('/api/v1/dashboard/revenue').expect(503);
    await request(app).post('/api/v1/dashboard/revenue').send({}).expect(404);
    expect(revenueSnapshot).toHaveBeenCalledOnce();
    expect(revenueSnapshot).toHaveBeenCalledWith();
  });
});
