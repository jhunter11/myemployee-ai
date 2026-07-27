import { describe, expect, it, vi } from 'vitest';

import type { ToolSmithProposal } from '../../src/agents/toolsmith';
import type { OperatorPageSpec } from '../../src/dashboard/contracts';
import { DashboardService } from '../../src/dashboard/dashboard-service';
import { PagePlanner } from '../../src/dashboard/page-planner';
import { PageService } from '../../src/dashboard/page-service';
import type { HealthResult } from '../../src/gateway/app';
import type { GraphIndex } from '../../src/memory/markdown-graph';

const now = '2026-07-18T18:00:00.000Z';
const health: HealthResult = {
  timestamp: now,
  overall: 'healthy',
  severity: 'none',
  checks: { gateway: 'ok', database: 'ok', ollama: 'ok', docker: 'ok', disk: 'ok:40%_free' },
  failures: [],
  action: 'none'
};
const graphIndex: GraphIndex = {
  generatedAt: now,
  nodes: [
    { id: 'index', type: 'index', title: 'Graph', path: 'index.md' },
    { id: 'clients/index', type: 'index', title: 'Clients', path: 'clients/index.md' }
  ],
  edges: [{ from: 'index', to: 'clients/index' }]
};
const savedPage: OperatorPageSpec = {
  version: 1,
  slug: 'health-page',
  title: 'Health Page',
  request: 'Create a health page for operations',
  widgets: ['health'],
  createdAt: now,
  planFingerprint: 'a'.repeat(64)
};
const proposal: ToolSmithProposal = {
  kind: 'autonomous_pr_simulation',
  mode: 'proposal_only',
  skill: '5-d-build',
  taskSignature: 'acme_corp:daily-report',
  executionCount: 5,
  payload: {
    objective: 'Automate repeated task: acme_corp:daily-report',
    evidence: {
      executionCount: 5,
      averageDurationSeconds: 2,
      manualInterventionCount: 0,
      lastExecutedAt: now
    }
  }
};

function emptyQueueReader() {
  return {
    readTenantQueue: () =>
      Promise.resolve({
        tenantId: 'jarvis',
        returnedTaskCount: 0,
        truncated: false,
        lanes: []
      })
  };
}

describe('DashboardService', () => {
  it('composes one bounded safe operator overview and graph/page reads', async () => {
    const clients = {
      dashboardSummary: vi.fn(() =>
        Promise.resolve({
          counts: { total: 1, active: 1, suspended: 0 },
          items: [
            {
              id: 'acme_corp',
              name: 'Acme Corporation',
              profile: 'data_processing' as const,
              status: 'active' as const,
              createdAt: now
            }
          ]
        })
      )
    };
    const runs = {
      dashboardSummary: vi.fn(() =>
        Promise.resolve({
          counts: { pending: 0, running: 0, succeeded: 1, failed: 0 },
          recent: []
        })
      )
    };
    const audits = {
      dashboardSummary: vi.fn(() => Promise.resolve({ unresolvedCount: 0, recent: [] }))
    };
    const economics = {
      dashboardSummary: vi.fn(() =>
        Promise.resolve({
          status: 'unavailable' as const,
          reason: 'No model-usage telemetry has been recorded.'
        })
      )
    };
    const queue = {
      readTenantQueue: vi.fn(({ tenantId }: { tenantId: string }) => {
        if (tenantId === 'acme_corp') {
          return Promise.resolve({
            tenantId,
            returnedTaskCount: 1,
            truncated: false,
            lanes: [
              {
                lane: 'delivery',
                ready: [
                  {
                    id: 'daily-report-ready',
                    tenantId,
                    lane: 'delivery',
                    payloadKind: 'automation' as const,
                    automationId: 'daily-report',
                    band: 'P1' as const,
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
          });
        }
        return Promise.resolve({
          tenantId: 'jarvis',
          returnedTaskCount: 1,
          truncated: false,
          lanes: [
            {
              lane: 'agency',
              ready: [
                {
                  id: 'agency-follow-up-1',
                  tenantId: 'jarvis',
                  lane: 'agency',
                  payloadKind: 'project_task' as const,
                  band: 'P2' as const,
                  state: 'queued' as const,
                  version: 1,
                  dependencyCount: 0,
                  blockedDependencyCount: 0,
                  createdAt: now,
                  availableAt: now,
                  ready: true,
                  payload: { private: 'must-not-cross-dashboard-boundary' },
                  lease: { token: 'private-lease-token' },
                  source: { id: 'private-source-reference' }
                }
              ],
              blocked: []
            }
          ]
        });
      })
    };
    const readIndex = vi.fn(() => Promise.resolve(graphIndex));
    const listOperatorPages = vi.fn(() => Promise.resolve([savedPage]));
    const service = new DashboardService({
      clients,
      runs,
      audits,
      economics,
      queue,
      queueTenantId: 'jarvis',
      queueTenantIds: () => Promise.resolve(['acme_corp']),
      queueExecutionEligibility: (task) =>
        task.tenantId === 'acme_corp' && task.automationId === 'daily-report'
          ? 'bound'
          : 'proposal_only',
      health: { check: () => Promise.resolve(health) },
      metrics: {
        snapshot: () => ({
          totalRequests: 7,
          errors: 1,
          lastRunAtByClient: { acme_corp: now }
        })
      },
      toolsmith: { analyze: () => Promise.resolve([proposal]) },
      graph: { readIndex, listOperatorPages },
      now: () => now,
      itemLimit: 5
    });

    await expect(service.overview()).resolves.toEqual({
      generatedAt: now,
      health,
      metrics: {
        scope: 'current_process',
        totalRequests: 7,
        errors: 1,
        lastRunAtByClient: { acme_corp: now }
      },
      clients: {
        counts: { total: 1, active: 1, suspended: 0 },
        items: [
          {
            id: 'acme_corp',
            name: 'Acme Corporation',
            profile: 'data_processing',
            status: 'active',
            createdAt: now
          }
        ]
      },
      runs: { counts: { pending: 0, running: 0, succeeded: 1, failed: 0 }, recent: [] },
      attention: { unresolvedCount: 0, recent: [] },
      economics: {
        status: 'unavailable',
        reason: 'No model-usage telemetry has been recorded.'
      },
      improvements: { mode: 'proposal_only', proposals: [proposal] },
      memory: { nodeCount: 2, edgeCount: 1, pageCount: 1 }
    });
    expect(clients.dashboardSummary).toHaveBeenCalledWith(5);
    expect(runs.dashboardSummary).toHaveBeenCalledWith(5);
    expect(audits.dashboardSummary).toHaveBeenCalledWith(5);
    expect(economics.dashboardSummary).toHaveBeenCalledWith({ limit: 5 });

    const queueSnapshot = await service.queueSnapshot();
    expect(queueSnapshot).toEqual({
      generatedAt: now,
      tenantId: 'jarvis',
      tenantIds: ['acme_corp', 'jarvis'],
      returnedTaskCount: 2,
      truncated: false,
      lanes: [
        {
          lane: 'delivery',
          ready: [
            {
              id: 'daily-report-ready',
              tenantId: 'acme_corp',
              lane: 'delivery',
              payloadKind: 'automation',
              executionEligibility: 'bound',
              band: 'P1',
              state: 'queued',
              version: 1,
              dependencyCount: 0,
              blockedDependencyCount: 0,
              createdAt: now,
              availableAt: now,
              ready: true
            }
          ],
          blocked: []
        },
        {
          lane: 'agency',
          ready: [
            {
              id: 'agency-follow-up-1',
              tenantId: 'jarvis',
              lane: 'agency',
              payloadKind: 'project_task',
              executionEligibility: 'proposal_only',
              band: 'P2',
              state: 'queued',
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
    });
    expect(queue.readTenantQueue).toHaveBeenCalledWith({
      tenantId: 'acme_corp',
      limit: 12,
      now
    });
    expect(queue.readTenantQueue).toHaveBeenCalledWith({ tenantId: 'jarvis', limit: 12, now });
    expect(JSON.stringify(queueSnapshot)).not.toContain('private');
    queue.readTenantQueue.mockResolvedValueOnce({
      tenantId: 'jarvis',
      returnedTaskCount: 0,
      truncated: false,
      lanes: []
    });
    await expect(service.queueSnapshot()).rejects.toThrow('outside configured tenant acme_corp');

    await expect(service.graphIndex()).resolves.toEqual(graphIndex);
    await expect(service.listPages()).resolves.toEqual([savedPage]);
  });

  it.each([0, -1, 26, 1.5])('rejects invalid item limit %s', (itemLimit) => {
    const emptySummary = () => Promise.resolve({ counts: {}, items: [], recent: [] });
    expect(
      () =>
        new DashboardService({
          clients: { dashboardSummary: emptySummary },
          runs: { dashboardSummary: emptySummary },
          audits: {
            dashboardSummary: () => Promise.resolve({ unresolvedCount: 0, recent: [] })
          },
          queue: emptyQueueReader(),
          queueTenantId: 'jarvis',
          economics: {
            dashboardSummary: () =>
              Promise.resolve({
                status: 'unavailable' as const,
                reason: 'No model-usage telemetry has been recorded.'
              })
          },
          health: { check: () => Promise.resolve(health) },
          metrics: { snapshot: () => ({ totalRequests: 0, errors: 0, lastRunAtByClient: {} }) },
          toolsmith: { analyze: () => Promise.resolve([]) },
          graph: {
            readIndex: () => Promise.resolve(graphIndex),
            listOperatorPages: () => Promise.resolve([])
          },
          itemLimit
        })
    ).toThrow(RangeError);
  });

  it('uses the bounded default item limit and a real ISO generation time', async () => {
    const clients = {
      dashboardSummary: vi.fn(() =>
        Promise.resolve({
          counts: { total: 0, active: 0, suspended: 0 },
          items: []
        })
      )
    };
    const service = new DashboardService({
      clients,
      runs: {
        dashboardSummary: () =>
          Promise.resolve({
            counts: { pending: 0, running: 0, succeeded: 0, failed: 0 },
            recent: []
          })
      },
      audits: {
        dashboardSummary: () => Promise.resolve({ unresolvedCount: 0, recent: [] })
      },
      queue: emptyQueueReader(),
      queueTenantId: 'jarvis',
      economics: {
        dashboardSummary: () =>
          Promise.resolve({
            status: 'unavailable' as const,
            reason: 'No model-usage telemetry has been recorded.'
          })
      },
      health: { check: () => Promise.resolve(health) },
      metrics: { snapshot: () => ({ totalRequests: 0, errors: 0, lastRunAtByClient: {} }) },
      toolsmith: { analyze: () => Promise.resolve([]) },
      graph: {
        readIndex: () => Promise.resolve(graphIndex),
        listOperatorPages: () => Promise.resolve([])
      }
    });

    const overview = await service.overview();

    expect(clients.dashboardSummary).toHaveBeenCalledWith(8);
    expect(Number.isNaN(Date.parse(overview.generatedAt))).toBe(false);
  });

  it('passes through measured economics without inventing cost or savings', async () => {
    const measured = {
      status: 'available' as const,
      period: { startsAt: now, endsAt: now },
      usage: {
        requestCount: 1,
        succeededCount: 1,
        failedCount: 0,
        timeoutCount: 0,
        cancelledCount: 0,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        unknownTokenEvents: 0
      },
      latency: { averageMs: 200 },
      cost: {
        currency: 'USD' as const,
        coverage: 'partial' as const,
        knownMicroUsd: 5,
        observedMicroUsd: 5,
        estimatedMicroUsd: 0,
        observedCostEvents: 1,
        estimatedCostEvents: 0,
        unknownCostEvents: 1,
        subscriptionCostEvents: 0,
        localCostEvents: 0
      },
      routing: [{ route: 'local' as const, requestCount: 1 }],
      models: []
    };
    const empty = () => Promise.resolve({ counts: {}, items: [], recent: [] });
    const service = new DashboardService({
      clients: { dashboardSummary: empty },
      runs: { dashboardSummary: empty },
      audits: { dashboardSummary: () => Promise.resolve({ unresolvedCount: 0, recent: [] }) },
      queue: emptyQueueReader(),
      queueTenantId: 'jarvis',
      economics: { dashboardSummary: () => Promise.resolve(measured) },
      health: { check: () => Promise.resolve(health) },
      metrics: { snapshot: () => ({ totalRequests: 0, errors: 0, lastRunAtByClient: {} }) },
      toolsmith: { analyze: () => Promise.resolve([]) },
      graph: {
        readIndex: () => Promise.resolve(graphIndex),
        listOperatorPages: () => Promise.resolve([])
      }
    });

    expect((await service.overview()).economics).toEqual(measured);
  });
});

describe('PageService', () => {
  it('maps personal Jarvis and agency control requests to safe declarative widgets', () => {
    const plan = new PagePlanner().plan({
      request: 'Create a daily briefing with calendar personal memory and agency control'
    });

    expect(plan).toMatchObject({
      ready: true,
      recommendedWorkflow: 'declarative_page',
      title: 'Daily Briefing Calendar Personal Memory And Agency Control',
      slug: 'daily-briefing-calendar-personal-memory-agency',
      widgets: ['daily-briefing', 'personal-calendar', 'personal-memory', 'agency-control'],
      gaps: []
    });
    expect(plan.mapping.map(({ source }) => source)).toEqual([
      '/api/v1/dashboard/personal',
      '/api/v1/dashboard/personal',
      '/api/v1/dashboard/personal',
      '/api/v1/dashboard/agency'
    ]);
  });

  it('re-plans a confirmed request and publishes only the canonical manifest', async () => {
    const planner = new PagePlanner();
    const request = 'Create a health and client page for operations';
    const plan = planner.plan({ request });
    const createOperatorPage = vi.fn((page: OperatorPageSpec) =>
      Promise.resolve({ created: true, page })
    );
    const service = new PageService({
      planner,
      graph: {
        createOperatorPage,
        listOperatorPages: () => Promise.resolve([])
      },
      now: () => now
    });

    await expect(service.preview({ request })).resolves.toEqual(plan);
    await expect(
      service.create({ request, expectedFingerprint: plan.fingerprint, confirmed: true })
    ).resolves.toEqual({
      created: true,
      page: {
        version: 1,
        slug: plan.slug,
        title: plan.title,
        request,
        widgets: plan.widgets,
        createdAt: now,
        planFingerprint: plan.fingerprint
      }
    });
    expect(createOperatorPage).toHaveBeenCalledOnce();
  });

  it('rejects a stale fingerprint and a plan that requires repository code', async () => {
    const planner = new PagePlanner();
    const createOperatorPage = vi.fn();
    const service = new PageService({
      planner,
      graph: {
        createOperatorPage,
        listOperatorPages: () => Promise.resolve([savedPage])
      }
    });

    await expect(
      service.create({
        request: 'Create a health page for operations',
        expectedFingerprint: 'b'.repeat(64),
        confirmed: true
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'DASHBOARD_PAGE_PLAN_CHANGED' });
    const codePlan = planner.plan({ request: 'Create a billing page for operations' });
    await expect(
      service.create({
        request: codePlan.request,
        expectedFingerprint: codePlan.fingerprint,
        confirmed: true
      })
    ).rejects.toMatchObject({ statusCode: 422, code: 'DASHBOARD_PAGE_REQUIRES_CODE' });
    expect(createOperatorPage).not.toHaveBeenCalled();
    await expect(service.list()).resolves.toEqual([savedPage]);
  });

  it('previews an over-capacity page as a gap and never publishes its bounded partial mapping', async () => {
    const planner = new PagePlanner();
    const request =
      'Create a health clients automation attention toolsmith memory model queue revenue page';
    const plan = planner.plan({ request });
    const createOperatorPage = vi.fn();
    const service = new PageService({
      planner,
      graph: {
        createOperatorPage,
        listOperatorPages: () => Promise.resolve([])
      }
    });

    await expect(service.preview({ request })).resolves.toEqual(plan);
    await expect(
      service.create({ request, expectedFingerprint: plan.fingerprint, confirmed: true })
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'DASHBOARD_PAGE_REQUIRES_CODE',
      details: {
        gaps: [expect.objectContaining({ capability: 'page-widget-capacity' })],
        recommendedWorkflow: 'repository_skill'
      }
    });
    expect(createOperatorPage).not.toHaveBeenCalled();
  });

  it('timestamps a valid page when no clock is injected', async () => {
    const planner = new PagePlanner();
    const request = 'Create a health page for operations';
    const plan = planner.plan({ request });
    const service = new PageService({
      planner,
      graph: {
        createOperatorPage: (page) => Promise.resolve({ created: true, page }),
        listOperatorPages: () => Promise.resolve([])
      }
    });

    const result = await service.create({
      request,
      expectedFingerprint: plan.fingerprint,
      confirmed: true
    });

    expect(Number.isNaN(Date.parse(result.page.createdAt))).toBe(false);
  });
});
