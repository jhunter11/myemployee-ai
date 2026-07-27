import { createHash } from 'node:crypto';

import {
  type DashboardWidget,
  type PageCapabilityGap,
  type PageCapabilityMapping,
  type PagePlan,
  OPERATOR_PAGE_WIDGET_LIMIT,
  PagePlanRequestSchema,
  PagePlanSchema
} from './contracts';

interface CapabilityDefinition {
  readonly capability: string;
  readonly widget: DashboardWidget;
  readonly source: string;
  readonly keywords: readonly string[];
  readonly implementationFiles: readonly string[];
}

const capabilityCatalog: readonly CapabilityDefinition[] = [
  {
    capability: 'health',
    widget: 'health',
    source: '/api/v1/dashboard/overview',
    keywords: ['health', 'status'],
    implementationFiles: ['src/monitoring/heartbeat.ts', 'src/gateway/app.ts']
  },
  {
    capability: 'clients',
    widget: 'clients',
    source: '/api/v1/dashboard/overview',
    keywords: ['client', 'clients'],
    implementationFiles: [
      'src/clients/service.ts',
      'src/db/client-repository.ts',
      'src/gateway/app.ts'
    ]
  },
  {
    capability: 'runs',
    widget: 'recent-runs',
    source: '/api/v1/dashboard/overview',
    keywords: ['automation', 'automations', 'run', 'runs'],
    implementationFiles: [
      'src/agents/supervisor.ts',
      'src/db/run-repository.ts',
      'src/gateway/app.ts'
    ]
  },
  {
    capability: 'attention',
    widget: 'attention',
    source: '/api/v1/dashboard/overview',
    keywords: ['attention', 'alert', 'alerts', 'audit', 'audits', 'error', 'errors'],
    implementationFiles: ['src/db/audit-repository.ts', 'src/gateway/app.ts']
  },
  {
    capability: 'toolsmith',
    widget: 'toolsmith',
    source: '/api/v1/dashboard/overview',
    keywords: ['improvement', 'improvements', 'toolsmith'],
    implementationFiles: ['src/agents/toolsmith.ts', 'src/gateway/app.ts']
  },
  {
    capability: 'memory-graph',
    widget: 'memory-graph',
    source: '/api/v1/dashboard/graph',
    keywords: ['graph', 'memory'],
    implementationFiles: ['src/memory/markdown-graph.ts', 'src/memory/graph-cli.ts']
  },
  {
    capability: 'model-economics',
    widget: 'model-economics',
    source: '/api/v1/dashboard/overview',
    keywords: [
      'model',
      'models',
      'routing',
      'token',
      'tokens',
      'usage',
      'cost',
      'costs',
      'spend',
      'price',
      'pricing',
      'economics'
    ],
    implementationFiles: [
      'src/economics/model-router.ts',
      'src/economics/context-budget.ts',
      'src/db/model-usage-repository.ts',
      'src/dashboard/dashboard-service.ts'
    ]
  },
  {
    capability: 'work-queue',
    widget: 'work-queue',
    source: '/api/v1/dashboard/queue',
    keywords: ['queue', 'priority', 'priorities', 'work'],
    implementationFiles: [
      'src/queue/priority-queue-service.ts',
      'src/db/priority-queue-repository.ts',
      'src/dashboard/dashboard-service.ts'
    ]
  },
  {
    capability: 'revenue-pipeline',
    widget: 'revenue-pipeline',
    source: '/api/v1/dashboard/revenue',
    keywords: [
      'revenue',
      'pipeline',
      'prospect',
      'prospects',
      'offer',
      'offers',
      'outreach',
      'growth',
      'x402',
      'a2a',
      'task',
      'market'
    ],
    implementationFiles: [
      'src/revenue/revenue-pipeline-service.ts',
      'src/db/revenue-pipeline-repository.ts',
      'src/dashboard/dashboard-service.ts'
    ]
  },
  {
    capability: 'daily-briefing',
    widget: 'daily-briefing',
    source: '/api/v1/dashboard/personal',
    keywords: ['briefing', 'briefings', 'today', 'daily'],
    implementationFiles: ['src/personal/briefing.ts', 'src/dashboard/jarvis-dashboard-service.ts']
  },
  {
    capability: 'personal-calendar',
    widget: 'personal-calendar',
    source: '/api/v1/dashboard/personal',
    keywords: ['calendar', 'calendars', 'event', 'events', 'schedule'],
    implementationFiles: ['src/personal/calendar.ts', 'src/dashboard/jarvis-dashboard-service.ts']
  },
  {
    capability: 'personal-memory',
    widget: 'personal-memory',
    source: '/api/v1/dashboard/personal',
    keywords: ['personal', 'memory', 'preference', 'preferences', 'remember'],
    implementationFiles: [
      'src/personal/memory-repository.ts',
      'src/dashboard/jarvis-dashboard-service.ts'
    ]
  },
  {
    capability: 'agency-control',
    widget: 'agency-control',
    source: '/api/v1/dashboard/agency',
    keywords: ['agency', 'autonomy', 'approval', 'approvals', 'control'],
    implementationFiles: [
      'src/agency/control-center.ts',
      'src/dashboard/jarvis-dashboard-service.ts'
    ]
  }
];

const knownUnsupportedKeywords = new Set(['bill', 'billing', 'invoice', 'invoices', 'margin']);

const capabilityBundles = [
  {
    keywords: ['morning', 'command'],
    capabilities: ['daily-briefing', 'personal-calendar', 'personal-memory', 'agency-control']
  },
  {
    keywords: ['agency', 'cockpit'],
    capabilities: ['work-queue', 'revenue-pipeline', 'agency-control']
  },
  {
    keywords: ['client', 'operations'],
    capabilities: ['health', 'clients', 'runs', 'attention']
  },
  {
    keywords: ['growth', 'review'],
    capabilities: ['attention', 'work-queue', 'revenue-pipeline']
  },
  {
    keywords: ['runtime', 'watch'],
    capabilities: ['health', 'runs', 'toolsmith', 'model-economics']
  },
  {
    keywords: ['memory', 'review'],
    capabilities: ['memory-graph', 'personal-memory']
  }
] as const;

const requestFillerWords = new Set([
  'a',
  'active',
  'an',
  'are',
  'blocked',
  'build',
  'center',
  'create',
  'dashboard',
  'for',
  'in',
  'is',
  'make',
  'me',
  'my',
  'new',
  'need',
  'needs',
  'of',
  'on',
  'operation',
  'operations',
  'operator',
  'page',
  'please',
  'show',
  'shows',
  'showing',
  'that',
  'the',
  'to',
  'view',
  'what',
  'with',
  'workspace'
]);

// Grammar and markup remnants do not describe a new dashboard capability.
// `script` intentionally remains in a human-readable title after sanitization.
const nonRequirementWords = new Set(['and', 'recent', 'script']);

const canonicalChecks = [
  'Validate the declarative widget allowlist',
  'Rebuild and validate the Markdown graph',
  'Render every widget from a same-origin read model',
  'Require explicit human confirmation before publication'
] as const;

function words(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function containsSequence(tokens: readonly string[], sequence: readonly string[]): boolean {
  return tokens.some((_, start) =>
    sequence.every((keyword, offset) => tokens[start + offset] === keyword)
  );
}

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

function pageName(tokens: readonly string[]): { title: string; slug: string } {
  const meaningful = tokens.filter((token) => !requestFillerWords.has(token));
  const name = meaningful.length === 0 ? ['operator', 'page'] : meaningful;
  const joined = name.join('-');
  const compact = joined.length > 48 ? name.filter((token) => token !== 'and').join('-') : joined;
  const slug =
    compact.length > 48
      ? compact
          .slice(0, 48)
          .replace(/-[^-]*$/u, '')
          .replace(/-+$/gu, '')
      : compact;
  const safeSlug = /^[a-z][a-z0-9-]{2,47}$/.test(slug) ? slug : 'operator-page';
  const title = name.map(titleCase).join(' ').slice(0, 120);
  return { title, slug: safeSlug };
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right)
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: Omit<PagePlan, 'fingerprint'>): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function mappingFor(
  definition: CapabilityDefinition,
  requestedWords: ReadonlySet<string>,
  inferredKeywords: readonly string[] = []
): PageCapabilityMapping {
  const directKeywords = definition.keywords.filter((keyword) => requestedWords.has(keyword));
  return {
    capability: definition.capability,
    widget: definition.widget,
    source: definition.source,
    matchedKeywords: [...new Set([...directKeywords, ...inferredKeywords])],
    implementationFiles: [...definition.implementationFiles]
  };
}

/**
 * A token-free, fixed mapping from operator language to declarative widgets.
 * It has no filesystem, network, or model dependency and is safe to repeat.
 */
export class PagePlanner {
  plan(input: unknown): PagePlan {
    const { request } = PagePlanRequestSchema.parse(input);
    const tokens = words(request);
    const requestedWords = new Set(tokens);
    const inferredCapabilities = new Map<string, readonly string[]>();
    capabilityBundles
      .filter((bundle) => containsSequence(tokens, bundle.keywords))
      .forEach((bundle) =>
        bundle.capabilities.forEach((capability) =>
          inferredCapabilities.set(capability, bundle.keywords)
        )
      );
    const requestedMapping = capabilityCatalog
      .filter(
        (definition) =>
          !(
            definition.capability === 'memory-graph' &&
            requestedWords.has('personal') &&
            !requestedWords.has('graph') &&
            !inferredCapabilities.has(definition.capability)
          ) &&
          !(
            definition.capability === 'personal-memory' &&
            !['personal', 'preference', 'preferences', 'remember'].some((keyword) =>
              requestedWords.has(keyword)
            ) &&
            !inferredCapabilities.has(definition.capability)
          )
      )
      .filter(
        (definition) =>
          definition.keywords.some((keyword) => requestedWords.has(keyword)) ||
          inferredCapabilities.has(definition.capability)
      )
      .map((definition) =>
        mappingFor(definition, requestedWords, inferredCapabilities.get(definition.capability))
      );
    const mapping = requestedMapping.slice(0, OPERATOR_PAGE_WIDGET_LIMIT);

    const mappedWords = new Set(requestedMapping.flatMap((entry) => entry.matchedKeywords));
    const gaps: PageCapabilityGap[] = [];
    if (requestedMapping.length > OPERATOR_PAGE_WIDGET_LIMIT) {
      gaps.push({
        capability: 'page-widget-capacity',
        reason: `Request maps ${requestedMapping.length} capabilities, exceeding the ${OPERATOR_PAGE_WIDGET_LIMIT}-widget declarative manifest. Repository work must split or redesign the request; no partial page can be published.`
      });
    }
    if (tokens.some((token) => knownUnsupportedKeywords.has(token))) {
      gaps.push({
        capability: 'commercial-billing',
        reason: 'Client billing, invoices, and realized margin need a separate authorized ledger.'
      });
    }

    const unknownWords = [...new Set(tokens)].filter(
      (token) =>
        !requestFillerWords.has(token) &&
        !nonRequirementWords.has(token) &&
        !mappedWords.has(token) &&
        !knownUnsupportedKeywords.has(token)
    );
    if (unknownWords.length > 0) {
      gaps.push({
        capability: 'unmapped-requirement',
        reason: `No declarative capability maps: ${unknownWords.join(', ')}.`
      });
    }

    const { title, slug } = pageName(tokens);
    const ready = gaps.length === 0 && mapping.length > 0;
    const planned = {
      request,
      title,
      slug,
      widgets: mapping.map((entry) => entry.widget),
      mapping,
      gaps,
      checks: [...canonicalChecks],
      ready,
      recommendedWorkflow: ready ? ('declarative_page' as const) : ('repository_skill' as const)
    };
    return PagePlanSchema.parse({ ...planned, fingerprint: fingerprint(planned) });
  }
}
