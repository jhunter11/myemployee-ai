import { OperatorPageTemplateSchema, type OperatorPageTemplate } from './contracts';

const templates = [
  {
    version: 1,
    id: 'morning-command',
    title: 'Morning command',
    category: 'personal',
    description: 'Briefing, calendar, private memory, and agency decisions in one starting view.',
    request: 'Create a morning command page',
    widgets: ['daily-briefing', 'personal-calendar', 'personal-memory', 'agency-control']
  },
  {
    version: 1,
    id: 'agency-cockpit',
    title: 'Agency cockpit',
    category: 'agency',
    description: 'Review bounded work, proposed revenue, and actions that still need approval.',
    request: 'Create an agency cockpit page',
    widgets: ['work-queue', 'revenue-pipeline', 'agency-control']
  },
  {
    version: 1,
    id: 'client-operations',
    title: 'Client operations',
    category: 'clients',
    description: 'See client scope, system posture, recent bounded runs, and unresolved attention.',
    request: 'Create a client operations page',
    widgets: ['health', 'clients', 'recent-runs', 'attention']
  },
  {
    version: 1,
    id: 'growth-review',
    title: 'Growth review',
    category: 'growth',
    description: 'Inspect the proposed pipeline beside attention signals and the durable queue.',
    request: 'Create a growth review page',
    widgets: ['attention', 'work-queue', 'revenue-pipeline']
  },
  {
    version: 1,
    id: 'runtime-watch',
    title: 'Runtime watch',
    category: 'system',
    description: 'Keep health, bounded runs, improvement proposals, and model economics together.',
    request: 'Create a runtime watch page',
    widgets: ['health', 'recent-runs', 'toolsmith', 'model-economics']
  },
  {
    version: 1,
    id: 'memory-review',
    title: 'Memory review',
    category: 'knowledge',
    description: 'Pair the global Markdown graph with the private personal-memory projection.',
    request: 'Create a memory review page',
    widgets: ['memory-graph', 'personal-memory']
  }
] satisfies unknown[];

const catalog = Object.freeze(
  templates.map((template) => Object.freeze(OperatorPageTemplateSchema.parse(template)))
);

/** Returns caller-owned copies so no request can mutate the process catalog. */
export function listOperatorPageTemplates(): OperatorPageTemplate[] {
  return catalog.map((template) => ({ ...template, widgets: [...template.widgets] }));
}
