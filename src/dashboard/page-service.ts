import { AppError } from '../utils/errors';

import {
  CreatePageRequestSchema,
  OperatorPageSpecSchema,
  PagePlanRequestSchema,
  PagePlanSchema,
  type CreatePageRequest,
  type OperatorPageSpec,
  type PagePlan
} from './contracts';

export interface PagePlannerPort {
  plan(input: unknown): PagePlan;
}

export interface OperatorPageGraph {
  createOperatorPage(page: OperatorPageSpec): Promise<{ created: boolean; page: OperatorPageSpec }>;
  listOperatorPages(): Promise<OperatorPageSpec[]>;
}

export interface PageServiceOptions {
  planner: PagePlannerPort;
  graph: OperatorPageGraph;
  now?: () => string;
}

/**
 * Publishes only a canonical, validated declarative page. Browser input never
 * selects a slug, a widget, a data source, or an executable implementation.
 */
export class PageService {
  private readonly now: () => string;

  constructor(private readonly options: PageServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  preview(input: unknown): Promise<PagePlan> {
    return Promise.resolve().then(() => {
      const request = PagePlanRequestSchema.parse(input);
      return PagePlanSchema.parse(this.options.planner.plan(request));
    });
  }

  async create(input: unknown): Promise<{ created: boolean; page: OperatorPageSpec }> {
    const request = CreatePageRequestSchema.parse(input);
    const plan = this.planCanonicalRequest(request);

    if (plan.fingerprint !== request.expectedFingerprint) {
      throw new AppError(
        409,
        'DASHBOARD_PAGE_PLAN_CHANGED',
        'The page plan changed. Preview the request again before publishing.',
        { expectedFingerprint: request.expectedFingerprint, actualFingerprint: plan.fingerprint }
      );
    }

    if (!plan.ready || plan.recommendedWorkflow !== 'declarative_page') {
      throw new AppError(
        422,
        'DASHBOARD_PAGE_REQUIRES_CODE',
        'This request requires repository work before a dashboard page can be published.',
        { gaps: plan.gaps, recommendedWorkflow: plan.recommendedWorkflow }
      );
    }

    const page = OperatorPageSpecSchema.parse({
      version: 1,
      slug: plan.slug,
      title: plan.title,
      request: plan.request,
      widgets: plan.widgets,
      createdAt: this.now(),
      planFingerprint: plan.fingerprint
    });
    return this.options.graph.createOperatorPage(page);
  }

  list(): Promise<OperatorPageSpec[]> {
    return this.options.graph.listOperatorPages();
  }

  private planCanonicalRequest(request: CreatePageRequest): PagePlan {
    return PagePlanSchema.parse(this.options.planner.plan({ request: request.request }));
  }
}
