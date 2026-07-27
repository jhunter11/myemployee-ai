import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

interface WidgetCard {
  title: string;
  content: string;
  items?: Array<{ title: string; detail: string; aside: string }>;
}

interface WidgetRegistryModule {
  list(): Array<{ id: string; title: string; source: string }>;
  definition(id: string): { id: string; title: string; source: string } | null;
  sourceFor(id: string): string | null;
  cardsFor(id: string, context: unknown): WidgetCard[];
}

const requireAsset = createRequire(__filename);
const registry = requireAsset(
  join(__dirname, '..', '..', 'public', 'dashboard', 'assets', 'widget-registry.js')
) as WidgetRegistryModule;

const context = {
  overview: {
    health: { overall: 'healthy' },
    clients: {
      counts: { total: 2 },
      items: [{ id: 'acme', name: 'Acme', profile: 'data_processing', status: 'active' }]
    },
    runs: {
      recent: [
        {
          id: 'one',
          clientId: 'acme',
          automation: 'weekly_reconciliation',
          status: 'succeeded',
          workerId: 'worker-one'
        }
      ]
    },
    attention: {
      unresolvedCount: 3,
      recent: [{ id: 7, severity: 'warning', clientId: 'acme', runId: 'one' }]
    },
    improvements: {
      proposals: [{ taskSignature: 'reconcile-ledger', executionCount: 8 }]
    },
    economics: {
      status: 'available',
      usage: { requestCount: 4, inputTokens: 100, outputTokens: 25 },
      cost: { observedCostEvents: 1, estimatedCostEvents: 0, knownMicroUsd: 250_000 }
    }
  },
  graph: { nodes: [{ id: 'one' }], edges: [{ from: 'one', to: 'two' }] },
  queueItems: [
    {
      title: 'Verify onboarding evidence',
      readiness: 'ready',
      priority: 'P1',
      payloadKind: 'project_task',
      whyNow: 'Dependency checks passed.'
    },
    {
      title: 'Approve outreach',
      readiness: 'blocked',
      priority: 'P0',
      payloadKind: 'operator_gate',
      whyNow: 'One dependency remains.'
    }
  ],
  revenueCards: [
    { title: 'Agency pipeline', content: 'Two bounded proposals; recognized revenue: none.' }
  ],
  personal: {
    briefing: { headline: 'Protect the proposal block.' },
    calendar: {
      events: [
        {
          id: 'focus',
          title: 'Proposal block',
          start: '2026-07-21T14:00:00.000Z',
          location: null,
          source: 'local_demo'
        }
      ],
      conflicts: [],
      truncated: false
    },
    memory: {
      records: [
        {
          id: 'preference',
          title: 'Protect focus time',
          branch: 'preferences',
          confidence: 0.9,
          reviewAt: '2026-07-22T12:00:00.000Z'
        }
      ],
      reviewDue: []
    }
  },
  agency: { autonomous: [{ id: 'one' }], approvalRequired: [{ id: 'two' }] }
};

describe('saved-page widget registry', () => {
  it('registers every allowlisted widget behind one source lifecycle boundary', () => {
    const definitions = registry.list();

    expect(definitions.map(({ id }) => id)).toEqual([
      'health',
      'clients',
      'recent-runs',
      'run-supervision',
      'sleeve-pnl',
      'attention',
      'toolsmith',
      'memory-graph',
      'model-economics',
      'work-queue',
      'revenue-pipeline',
      'daily-briefing',
      'personal-calendar',
      'personal-memory',
      'agency-control'
    ]);
    expect(definitions.every(({ id }) => registry.cardsFor(id, context).length > 0)).toBe(true);
    expect(registry.sourceFor('personal-calendar')).toBe('personal');
    expect(registry.sourceFor('not-allowlisted')).toBeNull();
    expect(registry.definition('not-allowlisted')).toBeNull();
    expect(registry.cardsFor('not-allowlisted', context)).toEqual([]);
  });

  it('returns data-only cards with honest bounded summaries', () => {
    expect(registry.cardsFor('health', context)).toEqual([
      { title: 'Health', content: 'All checked services are healthy.' }
    ]);
    expect(registry.cardsFor('work-queue', context)).toEqual([
      {
        title: 'Work queue',
        content: '2 bounded tasks · 1 ready · 1 blocked.',
        items: [
          {
            title: 'Verify onboarding evidence',
            detail: 'Project task · Dependency checks passed.',
            aside: 'P1 · ready'
          },
          {
            title: 'Approve outreach',
            detail: 'Operator gate · One dependency remains.',
            aside: 'P0 · blocked'
          }
        ]
      }
    ]);
    expect(registry.cardsFor('revenue-pipeline', context)).toEqual(context.revenueCards);
    expect(registry.cardsFor('model-economics', context)[0]?.content).toContain(
      '4 requests · 125 tokens · $0.25 known cost'
    );
    expect(registry.cardsFor('clients', context)[0]?.items).toEqual([
      {
        title: 'Acme',
        detail: 'Data processing',
        aside: 'active'
      }
    ]);
  });

  it('does not mutate callers or return a writable registry definition', () => {
    const definition = registry.definition('health');
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(registry.list())).toBe(true);
    expect(context.overview.clients.counts.total).toBe(2);
  });
});
