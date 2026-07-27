import { describe, expect, it } from 'vitest';

import { OperatorPageTemplateSchema } from '../../src/dashboard/contracts';
import { PagePlanner } from '../../src/dashboard/page-planner';
import { listOperatorPageTemplates } from '../../src/dashboard/page-templates';

describe('operator page templates', () => {
  it('provides a small validated catalog of useful starting workspaces', () => {
    const templates = listOperatorPageTemplates();

    expect(templates.map(({ id }) => id)).toEqual([
      'morning-command',
      'agency-cockpit',
      'client-operations',
      'growth-review',
      'runtime-watch',
      'memory-review'
    ]);
    expect(
      templates.every((template) => OperatorPageTemplateSchema.safeParse(template).success)
    ).toBe(true);
    expect(new Set(templates.map(({ request }) => request)).size).toBe(templates.length);
  });

  it('keeps every template publishable through the canonical token-free planner', () => {
    const planner = new PagePlanner();

    for (const template of listOperatorPageTemplates()) {
      const plan = planner.plan({ request: template.request });
      expect(plan.ready, template.id).toBe(true);
      expect(plan.recommendedWorkflow, template.id).toBe('declarative_page');
      expect(plan.gaps, template.id).toEqual([]);
      expect(plan.widgets, template.id).toEqual(template.widgets);
    }
  });

  it('rejects executable or undeclared template fields', () => {
    expect(() =>
      OperatorPageTemplateSchema.parse({
        ...listOperatorPageTemplates()[0],
        script: 'alert(1)'
      })
    ).toThrow();
  });
});
