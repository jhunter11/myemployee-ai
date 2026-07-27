import { z } from 'zod';

export const OPERATOR_PAGE_WIDGET_LIMIT = 7;

/** The complete set of data-only dashboard widgets that can be published. */
export const DashboardWidgetSchema = z.enum([
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

export const PageRequestSchema = z.string().trim().min(8).max(2000);

export const PageSlugSchema = z.string().regex(/^[a-z][a-z0-9-]{2,47}$/);

export const PageTitleSchema = z.string().trim().min(3).max(120);

export const PlanFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Curated Page Studio starting points remain data-only and planner-verifiable. */
export const OperatorPageTemplateSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]{2,47}$/),
  title: PageTitleSchema,
  category: z.enum(['personal', 'agency', 'clients', 'growth', 'system', 'knowledge']),
  description: z.string().trim().min(8).max(240),
  request: PageRequestSchema,
  widgets: z.array(DashboardWidgetSchema).min(1).max(OPERATOR_PAGE_WIDGET_LIMIT)
});

/** Preview input deliberately contains no executable, routing, or manifest fields. */
export const PagePlanRequestSchema = z.strictObject({
  request: PageRequestSchema
});

/**
 * The browser may only return its original text and the fingerprint it received
 * from a preview. The service re-plans it before publishing a page.
 */
export const CreatePageRequestSchema = z.strictObject({
  request: PageRequestSchema,
  expectedFingerprint: PlanFingerprintSchema,
  confirmed: z.literal(true)
});

export const PageCapabilityMappingSchema = z.strictObject({
  capability: z.string().min(1).max(80),
  widget: DashboardWidgetSchema,
  source: z.string().regex(/^\/api\/v1\/dashboard\/[a-z-]+$/),
  matchedKeywords: z.array(z.string().min(1).max(80)).min(1).max(12),
  implementationFiles: z
    .array(z.string().regex(/^src\/[a-z0-9_/-]+\.ts$/))
    .min(1)
    .max(12)
});

export const PageCapabilityGapSchema = z.strictObject({
  capability: z.string().min(1).max(80),
  reason: z.string().trim().min(1).max(400)
});

export const PagePlanSchema = z.strictObject({
  request: PageRequestSchema,
  title: PageTitleSchema,
  slug: PageSlugSchema,
  widgets: z.array(DashboardWidgetSchema).max(OPERATOR_PAGE_WIDGET_LIMIT),
  mapping: z.array(PageCapabilityMappingSchema).max(OPERATOR_PAGE_WIDGET_LIMIT),
  gaps: z.array(PageCapabilityGapSchema).max(12),
  checks: z.array(z.string().min(1).max(240)).min(1).max(12),
  ready: z.boolean(),
  recommendedWorkflow: z.enum(['declarative_page', 'repository_skill']),
  fingerprint: PlanFingerprintSchema
});

/**
 * JSON stored in the global Markdown graph. It is intentionally data-only so
 * neither Markdown nor a dashboard request can smuggle executable behaviour.
 */
export const OperatorPageSpecSchema = z.strictObject({
  version: z.literal(1),
  slug: PageSlugSchema,
  title: PageTitleSchema,
  request: PageRequestSchema,
  widgets: z.array(DashboardWidgetSchema).min(1).max(OPERATOR_PAGE_WIDGET_LIMIT),
  createdAt: z.iso.datetime(),
  planFingerprint: PlanFingerprintSchema
});

export type DashboardWidget = z.infer<typeof DashboardWidgetSchema>;
export type OperatorPageTemplate = z.infer<typeof OperatorPageTemplateSchema>;
export type PagePlanRequest = z.infer<typeof PagePlanRequestSchema>;
export type CreatePageRequest = z.infer<typeof CreatePageRequestSchema>;
export type PageCapabilityMapping = z.infer<typeof PageCapabilityMappingSchema>;
export type PageCapabilityGap = z.infer<typeof PageCapabilityGapSchema>;
export type PagePlan = z.infer<typeof PagePlanSchema>;
export type OperatorPageSpec = z.infer<typeof OperatorPageSpecSchema>;
