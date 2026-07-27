import { describe, expect, it } from 'vitest';

import {
  CreatePageRequestSchema,
  OperatorPageSpecSchema,
  PagePlanRequestSchema
} from '../../src/dashboard/contracts';
import { PagePlanner } from '../../src/dashboard/page-planner';

describe('PagePlanner', () => {
  const planner = new PagePlanner();

  it('maps a request to existing capabilities and a deterministic declarative plan', () => {
    const plan = planner.plan({
      request: 'Create a client health and recent automation runs page'
    });

    expect(plan).toMatchObject({
      request: 'Create a client health and recent automation runs page',
      title: 'Client Health And Recent Automation Runs',
      slug: 'client-health-and-recent-automation-runs',
      ready: true,
      recommendedWorkflow: 'declarative_page',
      widgets: ['health', 'clients', 'recent-runs'],
      gaps: []
    });
    expect(plan.mapping).toEqual([
      expect.objectContaining({
        capability: 'health',
        widget: 'health',
        source: '/api/v1/dashboard/overview',
        matchedKeywords: ['health'],
        implementationFiles: ['src/monitoring/heartbeat.ts', 'src/gateway/app.ts']
      }),
      expect.objectContaining({
        capability: 'clients',
        widget: 'clients',
        source: '/api/v1/dashboard/overview',
        matchedKeywords: ['client']
      }),
      expect.objectContaining({
        capability: 'runs',
        widget: 'recent-runs',
        source: '/api/v1/dashboard/overview',
        matchedKeywords: ['automation', 'runs']
      })
    ]);
    expect(plan.checks).toEqual(
      expect.arrayContaining([
        'Validate the declarative widget allowlist',
        'Rebuild and validate the Markdown graph',
        'Render every widget from a same-origin read model'
      ])
    );
    expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(planner.plan({ request: plan.request })).toEqual(plan);
  });

  it('reports known and unknown gaps instead of silently publishing a partial page', () => {
    const plan = planner.plan({ request: 'Build a client billing margin and weather page' });

    expect(plan).toMatchObject({
      ready: false,
      recommendedWorkflow: 'repository_skill',
      widgets: ['clients']
    });
    expect(plan.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: 'commercial-billing' }),
        expect.objectContaining({ capability: 'unmapped-requirement' })
      ])
    );
  });

  it('maps model routing, token usage, and cost telemetry to honest economics', () => {
    const plan = planner.plan({
      request: 'Create a model routing token usage and cost economics page'
    });

    expect(plan).toMatchObject({
      ready: true,
      recommendedWorkflow: 'declarative_page',
      widgets: ['model-economics'],
      gaps: []
    });
    expect(plan.mapping).toEqual([
      expect.objectContaining({
        capability: 'model-economics',
        widget: 'model-economics',
        matchedKeywords: ['model', 'routing', 'token', 'usage', 'cost', 'economics']
      })
    ]);
  });

  it('maps queue and revenue requests to their fixed standalone read models', () => {
    const plan = planner.plan({
      request: 'Create a queue and revenue pipeline page'
    });

    expect(plan).toMatchObject({
      ready: true,
      recommendedWorkflow: 'declarative_page',
      widgets: ['work-queue', 'revenue-pipeline'],
      gaps: []
    });
    expect(plan.mapping).toEqual([
      expect.objectContaining({
        capability: 'work-queue',
        widget: 'work-queue',
        source: '/api/v1/dashboard/queue',
        matchedKeywords: ['queue']
      }),
      expect.objectContaining({
        capability: 'revenue-pipeline',
        widget: 'revenue-pipeline',
        source: '/api/v1/dashboard/revenue',
        matchedKeywords: ['revenue', 'pipeline']
      })
    ]);
  });

  it.each([
    ['Make me a page that shows what needs my attention today', ['attention', 'daily-briefing']],
    ['Show me the work that is blocked and what needs approval', ['work-queue', 'agency-control']],
    ['Create a client operations workspace', ['health', 'clients', 'recent-runs', 'attention']],
    [
      'Build a morning command center',
      ['daily-briefing', 'personal-calendar', 'personal-memory', 'agency-control']
    ]
  ])('accepts ordinary operator language in “%s”', (request, widgets) => {
    expect(planner.plan({ request })).toMatchObject({
      ready: true,
      recommendedWorkflow: 'declarative_page',
      widgets,
      gaps: []
    });
  });

  it('still rejects text-selected tenant names and real unknown capabilities', () => {
    const plan = planner.plan({
      request: 'Show Acme client health and active automations with weather'
    });

    expect(plan.ready).toBe(false);
    expect(plan.widgets).toEqual(['health', 'clients', 'recent-runs']);
    expect(plan.gaps).toHaveLength(1);
    expect(plan.gaps[0]?.capability).toBe('unmapped-requirement');
    expect(plan.gaps[0]?.reason).toMatch(/acme.*weather/i);
  });

  it('routes requests beyond the seven-widget manifest limit to repository work without throwing', () => {
    const request =
      'Create a health clients automation attention toolsmith memory model queue revenue page';

    expect(() => planner.plan({ request })).not.toThrow();
    const plan = planner.plan({ request });

    expect(plan).toMatchObject({
      ready: false,
      recommendedWorkflow: 'repository_skill',
      widgets: [
        'health',
        'clients',
        'recent-runs',
        'attention',
        'toolsmith',
        'memory-graph',
        'model-economics'
      ]
    });
    expect(plan.mapping).toHaveLength(7);
    expect(plan.gaps).toHaveLength(1);
    expect(plan.gaps[0]).toMatchObject({ capability: 'page-widget-capacity' });
    expect(plan.gaps[0]?.reason).toMatch(/9 capabilities.*7-widget.*no partial page/i);
    expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses a stable fallback name when a request contains only planning grammar', () => {
    expect(planner.plan({ request: 'Create a new dashboard page please' })).toMatchObject({
      title: 'Operator Page',
      slug: 'operator-page',
      widgets: [],
      ready: false,
      recommendedWorkflow: 'repository_skill'
    });
    expect(planner.plan({ request: '!!!!!!!!' })).toMatchObject({
      title: 'Operator Page',
      slug: 'operator-page',
      widgets: [],
      ready: false
    });
  });

  it('sanitizes a hostile request into a safe title and slug', () => {
    const plan = planner.plan({
      request: 'Create a memory graph </script> ../../ page'
    });

    expect(plan.ready).toBe(true);
    expect(plan.title).toBe('Memory Graph Script');
    expect(plan.slug).toBe('memory-graph-script');
    expect(plan.slug).toMatch(/^[a-z][a-z0-9-]{2,47}$/);
  });
});

describe('dashboard page contracts', () => {
  it('uses strict bounded request and confirmation bodies', () => {
    expect(() => PagePlanRequestSchema.parse({ request: 'short' })).toThrow();
    expect(() =>
      PagePlanRequestSchema.parse({ request: 'Create a health page', execute: '<script>' })
    ).toThrow();
    expect(() =>
      CreatePageRequestSchema.parse({
        request: 'Create a health page',
        expectedFingerprint: 'not-a-hash'
      })
    ).toThrow();
  });

  it('rejects executable or unknown page manifest fields', () => {
    expect(() =>
      OperatorPageSpecSchema.parse({
        version: 1,
        slug: 'health-page',
        title: 'Health Page',
        request: 'Create a health page',
        widgets: ['health'],
        createdAt: '2026-07-18T17:00:00.000Z',
        planFingerprint: 'a'.repeat(64),
        script: 'alert(1)'
      })
    ).toThrow();
    expect(() =>
      OperatorPageSpecSchema.parse({
        version: 1,
        slug: '../escape',
        title: 'Escape',
        request: 'Create a health escape page',
        widgets: ['raw-html'],
        createdAt: '2026-07-18T17:00:00.000Z',
        planFingerprint: 'a'.repeat(64)
      })
    ).toThrow();
  });
});
