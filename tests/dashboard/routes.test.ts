import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import type { ClientService } from '../../src/clients/service';
import type { ActionDecisionRequest } from '../../src/commands/action-proposal-contracts';
import type { CreatePageRequest, PagePlanRequest } from '../../src/dashboard/contracts';
import type {
  DashboardModelRuntimeDisableRequest,
  DashboardModelRuntimeSelectionRequest
} from '../../src/dashboard/model-runtime-service';
import { PagePlanner } from '../../src/dashboard/page-planner';
import { listOperatorPageTemplates } from '../../src/dashboard/page-templates';
import {
  isLoopbackAddress,
  requireLoopbackMutation,
  type DashboardApi
} from '../../src/dashboard/routes';
import { createApp, type AutomationRunner } from '../../src/gateway/app';
import { RequestMetrics } from '../../src/gateway/metrics';

const projectRoot = join(__dirname, '..', '..');
const now = '2026-07-18T18:00:00.000Z';

function cssHex(source: string, token: string): string {
  const value = source.match(new RegExp(`--${token}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
  if (!value) throw new Error(`Missing CSS token --${token}`);
  return value;
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
    const linear = channels.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
}

describe('dashboard routes', () => {
  let dashboard: DashboardApi;
  let app: ReturnType<typeof createApp>;
  let previewInputs: PagePlanRequest[];
  let createInputs: CreatePageRequest[];
  let actionProposalDecisions: ActionDecisionRequest[];
  let modelRuntimeSelections: DashboardModelRuntimeSelectionRequest[];
  let modelRuntimeDisables: DashboardModelRuntimeDisableRequest[];
  let modelRuntimeLogins: string[];
  const plan = new PagePlanner().plan({
    request: 'Create a health and client page for operations'
  });

  beforeEach(() => {
    previewInputs = [];
    createInputs = [];
    actionProposalDecisions = [];
    modelRuntimeSelections = [];
    modelRuntimeDisables = [];
    modelRuntimeLogins = [];
    const clients: ClientService = {
      list: () => Promise.resolve([]),
      findById: () => Promise.resolve(undefined),
      create: () => Promise.reject(new Error('not used'))
    };
    const runner: AutomationRunner = {
      run: () => Promise.reject(new Error('not used'))
    };
    dashboard = {
      overview: () =>
        Promise.resolve({
          generatedAt: now,
          health: { overall: 'healthy' },
          metrics: { scope: 'current_process', totalRequests: 1, errors: 0 },
          clients: { counts: { total: 0 }, items: [] },
          runs: { counts: { running: 0, succeeded: 0, failed: 0 }, recent: [] },
          attention: { unresolvedCount: 0, recent: [] },
          economics: {
            status: 'unavailable',
            reason: 'No model-usage telemetry has been recorded.'
          },
          improvements: { mode: 'proposal_only', proposals: [] },
          memory: { nodeCount: 3, edgeCount: 2, pageCount: 0 }
        }),
      queueSnapshot: () =>
        Promise.resolve({
          generatedAt: now,
          tenantId: 'jarvis',
          returnedTaskCount: 0,
          truncated: false,
          lanes: []
        }),
      personalSnapshot: () =>
        Promise.resolve({
          generatedAt: now,
          briefing: { headline: 'One clear next move', eventCount: 1 },
          calendar: { events: [], conflicts: [], truncated: false },
          memory: { records: [], reviewDue: [] },
          calendarMode: 'local_demo'
        }),
      agencyControlSnapshot: () =>
        Promise.resolve({
          generatedAt: now,
          posture: 'paused',
          killSwitchEngaged: true,
          autonomous: [],
          approvalRequired: [],
          blocked: []
        }),
      chat: () =>
        Promise.resolve({
          mode: 'deterministic',
          intent: 'today',
          reply: 'One clear next move.',
          suggestedView: 'today',
          evidenceRefs: [],
          requiresApproval: false
        }),
      modelRuntimeSnapshot: () =>
        Promise.resolve({
          enabled: false,
          version: 4,
          selectedProvider: null,
          providers: [
            {
              provider: 'claude',
              connectionState: 'connected',
              loginAvailable: true,
              loginInProgress: false,
              detail: 'Subscription login confirmed'
            },
            {
              provider: 'openai',
              connectionState: 'disconnected',
              loginAvailable: true,
              loginInProgress: false,
              detail: 'Subscription login required'
            }
          ]
        }),
      startModelProviderLogin: (provider) => {
        modelRuntimeLogins.push(provider);
        return Promise.resolve({
          provider,
          outcome: 'started',
          detail: 'Subscription login started'
        });
      },
      selectModelRuntime: (input) => {
        modelRuntimeSelections.push(input);
        return Promise.resolve({
          enabled: true,
          version: input.expectedVersion + 1,
          selectedProvider: input.provider,
          providers: []
        });
      },
      disableModelRuntime: (input) => {
        modelRuntimeDisables.push(input);
        return Promise.resolve({
          enabled: false,
          version: input.expectedVersion + 1,
          selectedProvider: null,
          providers: []
        });
      },
      decideActionProposal: (input) => {
        actionProposalDecisions.push(input);
        return Promise.resolve({
          id: `decision:${'b'.repeat(64)}`,
          proposalId: input.proposalId,
          verdict: input.verdict,
          proposalVersion: input.expectedVersion + 1
        });
      },
      graphIndex: () =>
        Promise.resolve({
          generatedAt: now,
          nodes: [{ id: 'index', type: 'index', title: 'Graph', path: 'index.md' }],
          edges: []
        }),
      listPages: () => Promise.resolve([]),
      previewPage: (input) => {
        previewInputs.push(input);
        return Promise.resolve(plan);
      },
      createPage: (input) => {
        createInputs.push(input);
        return Promise.resolve({
          created: true,
          page: {
            version: 1 as const,
            slug: plan.slug,
            title: plan.title,
            request: plan.request,
            widgets: plan.widgets,
            createdAt: now,
            planFingerprint: plan.fingerprint
          }
        });
      }
    };
    app = createApp({
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
      dashboardDelegationEvents: (_request, response) => {
        response
          .status(200)
          .type('text/event-stream')
          .send('retry: 5000\n\nid: 1\nevent: delegation.run_queued\ndata: {}\n\n');
      },
      dashboardRoot: join(projectRoot, 'public', 'dashboard')
    });
  });

  it('serves bounded personal and agency command-center projections', async () => {
    await request(app)
      .get('/api/v1/dashboard/personal')
      .expect('cache-control', 'no-store')
      .expect(200)
      .expect((response) => expect(JSON.stringify(response.body)).toContain('local_demo'));
    await request(app)
      .get('/api/v1/dashboard/agency')
      .expect('cache-control', 'no-store')
      .expect(200)
      .expect((response) => expect(JSON.stringify(response.body)).toContain('killSwitchEngaged'));
  });

  it('serves the bounded delegation event stream through the local dashboard boundary', async () => {
    await request(app)
      .get('/api/v1/dashboard/delegation/events')
      .expect('content-type', /text\/event-stream/)
      .expect(200)
      .expect((response) => expect(response.text).toContain('delegation.run_queued'));
  });

  it('accepts strict loopback Jarvis chat messages', async () => {
    await request(app)
      .post('/api/v1/dashboard/chat')
      .send({ message: 'What needs my attention today?' })
      .expect(200)
      .expect((response) => expect(JSON.stringify(response.body)).toContain('One clear next move'));
    await request(app)
      .post('/api/v1/dashboard/chat')
      .send({ message: 'today', tenantId: 'acme' })
      .expect(400);
  });

  it('serves redacted model runtime state and strict subscription control mutations', async () => {
    await request(app)
      .get('/api/v1/dashboard/model-runtime')
      .expect('cache-control', 'no-store')
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          enabled: false,
          version: 4,
          selectedProvider: null,
          providers: [
            { provider: 'claude', connectionState: 'connected' },
            { provider: 'openai', connectionState: 'disconnected' }
          ]
        });
        expect(JSON.stringify(response.body)).not.toMatch(/token|email|orgId/iu);
      });

    await request(app)
      .post('/api/v1/dashboard/model-runtime/providers/claude/login')
      .send({})
      .expect(202);
    expect(modelRuntimeLogins).toEqual(['claude']);

    await request(app)
      .post('/api/v1/dashboard/model-runtime/select')
      .send({ provider: 'openai', expectedVersion: 4 })
      .expect(200);
    expect(modelRuntimeSelections).toEqual([{ provider: 'openai', expectedVersion: 4 }]);

    await request(app)
      .post('/api/v1/dashboard/model-runtime/disable')
      .send({ expectedVersion: 5 })
      .expect(200);
    expect(modelRuntimeDisables).toEqual([{ expectedVersion: 5 }]);
  });

  it('rejects browser-supplied model authority, login commands, and unknown providers', async () => {
    await request(app)
      .post('/api/v1/dashboard/model-runtime/select')
      .send({
        provider: 'claude',
        expectedVersion: 4,
        allowedTiers: [2, 3],
        surface: 'automation',
        tenantId: 'acme_corp'
      })
      .expect(400);
    await request(app)
      .post('/api/v1/dashboard/model-runtime/disable')
      .send({ expectedVersion: 4, reason: 'browser supplied' })
      .expect(400);
    await request(app)
      .post('/api/v1/dashboard/model-runtime/providers/openai/login')
      .send({ command: '/bin/sh', args: ['-c', 'anything'] })
      .expect(400);
    await request(app)
      .post('/api/v1/dashboard/model-runtime/providers/gemini/login')
      .send({})
      .expect(400);
    expect(modelRuntimeSelections).toEqual([]);
    expect(modelRuntimeDisables).toEqual([]);
    expect(modelRuntimeLogins).toEqual([]);
  });

  it('records an exact local action-proposal decision without accepting scope text', async () => {
    const proposalId = `proposal:${'a'.repeat(64)}`;
    const confirmationFingerprint = `sha256:${'c'.repeat(64)}`;
    await request(app)
      .post(`/api/v1/dashboard/action-proposals/${proposalId}/decision`)
      .send({ verdict: 'approved', expectedVersion: 1, confirmationFingerprint })
      .expect(200);
    expect(actionProposalDecisions).toEqual([
      { proposalId, verdict: 'approved', expectedVersion: 1, confirmationFingerprint }
    ]);

    await request(app)
      .post(`/api/v1/dashboard/action-proposals/${proposalId}/decision`)
      .send({
        verdict: 'approved',
        expectedVersion: 1,
        confirmationFingerprint,
        scopeId: 'client:other'
      })
      .expect(400);
  });

  it('serves a secured dashboard shell and fixed static assets', async () => {
    const root = await request(app).get('/').expect(302);
    expect(root.headers.location).toBe('/dashboard');

    const shell = await request(app).get('/dashboard').expect(200);
    expect(shell.type).toBe('text/html');
    expect(shell.text).toContain('Jarvis Control Room');
    expect(shell.text.indexOf('/dashboard/assets/navigation.js')).toBeLessThan(
      shell.text.indexOf('/dashboard/assets/app.js')
    );
    expect(shell.text.indexOf('/dashboard/assets/revenue-widget.js')).toBeLessThan(
      shell.text.indexOf('/dashboard/assets/app.js')
    );
    expect(shell.text.indexOf('/dashboard/assets/dashboard-core.js')).toBeLessThan(
      shell.text.indexOf('/dashboard/assets/app.js')
    );
    expect(shell.headers['content-security-policy']).toContain("default-src 'self'");
    expect(shell.headers['content-security-policy']).toContain("object-src 'none'");
    expect(shell.headers['permissions-policy']).toBe('microphone=(self)');
    expect(shell.headers['referrer-policy']).toBe('no-referrer');
    expect(shell.headers['x-content-type-options']).toBe('nosniff');

    await request(app)
      .get('/dashboard/assets/styles.css')
      .expect('content-type', /text\/css/)
      .expect(200);
    await request(app)
      .get('/dashboard/assets/app.js')
      .expect('content-type', /javascript/)
      .expect(200);
    await request(app)
      .get('/dashboard/assets/navigation.js')
      .expect('content-type', /javascript/)
      .expect(200);
    await request(app)
      .get('/dashboard/assets/revenue-widget.js')
      .expect('content-type', /javascript/)
      .expect(200);
    await request(app)
      .get('/dashboard/assets/dashboard-core.js')
      .expect('content-type', /javascript/)
      .expect(200);
    await request(app).get('/dashboard/assets/.secret').expect(404);
  });

  it('serves one semantic view heading and one concise global status region', async () => {
    const shell = await request(app).get('/dashboard').expect(200);
    expect(shell.text.match(/<h1\b/g)).toHaveLength(1);
    expect(shell.text).toContain('<h1 id="view-title"');
    expect(shell.text).toContain('<main id="main-content" tabindex="-1">');
    expect(shell.text).not.toMatch(/<h[4-6]\b/);
    expect(shell.text.match(/role="status"/g)).toHaveLength(1);
    expect(shell.text).not.toMatch(/id="overview-metrics"[^>]*aria-live/);
    expect(shell.text).not.toMatch(/id="growth-metrics"[^>]*aria-live/);
    expect(shell.text).not.toMatch(/id="queue-inspector"[^>]*aria-live/);
    expect(shell.text).not.toMatch(/id="page-form-status"[^>]*aria-live/);
    expect(shell.text).not.toMatch(/id="page-plan"[^>]*aria-live/);
    expect(shell.text).not.toContain('<article class="context-card"');

    const nextMove = shell.text.indexOf('id="growth-next"');
    const agencyPipeline = shell.text.indexOf('id="agency-pipeline"');
    expect(nextMove).toBeGreaterThan(0);
    expect(nextMove).toBeLessThan(agencyPipeline);
  });

  it('serves a full-width queue-first operator desk with explicit revenue lanes', async () => {
    const shell = await request(app).get('/dashboard').expect(200);
    expect(shell.text).toContain('data-view="queue"');
    expect(shell.text).toContain('id="queue-list"');
    expect(shell.text).toContain('id="queue-inspector"');
    expect(shell.text).toContain('data-lane="agency"');
    expect(shell.text).toContain('data-lane="task_market"');
    expect(shell.text).toContain('href="/dashboard?view=queue"');

    const styles = await request(app).get('/dashboard/assets/styles.css').expect(200);
    expect(styles.text).toMatch(/\.app-shell\s*\{[^}]*inline-size:\s*100%/s);
    expect(styles.text).toMatch(/\.workspace\s*\{[^}]*inline-size:\s*100%/s);
    expect(styles.text).toMatch(/main\s*\{[^}]*max-inline-size:\s*none/s);
    expect(styles.text).toMatch(
      /@media \(max-width: 600px\)[\s\S]*\.brand-lockup \.brand-caption\s*\{[^}]*display:\s*none/
    );

    const script = await request(app).get('/dashboard/assets/app.js').expect(200);
    expect(script.text).not.toContain("element('h5'");
    expect(script.text).toContain("queue: '/queue'");
    expect(script.text).toContain('queueSnapshotItems');
    expect(script.text).toContain('Automation eligible for worker claim');
    expect(script.text).toContain('Operator review ready');
    expect(script.text).toContain('Project work ready');
    expect(script.text).toContain("item.scrollIntoView({ block: 'nearest', inline: 'nearest' })");
    expect(script.text).not.toContain('Ready for worker claim');
  });

  it('serves useful personal Jarvis, calendar, memory, agency, and recipe surfaces', async () => {
    const shell = await request(app).get('/dashboard').expect(200);
    expect(shell.text).toContain('data-view="today"');
    expect(shell.text).toContain('data-view="chat"');
    expect(shell.text).toContain('data-view="calendar"');
    expect(shell.text).toContain('data-view="personal"');
    expect(shell.text).toContain('data-view="agency"');
    expect(shell.text).toContain('id="personal-memory-tree"');
    expect(shell.text).toContain('id="page-template-list"');
    expect(shell.text).toContain('/dashboard/assets/widget-registry.js');

    const script = await request(app).get('/dashboard/assets/app.js').expect(200);
    expect(script.text).toContain("personal: '/personal'");
    expect(script.text).toContain("agency: '/agency'");
    expect(script.text).toContain('renderPersonalJarvis');
    expect(script.text).toContain("availability.calendar !== 'unavailable'");
    expect(script.text).toContain("availability.memoryRecords !== 'unavailable'");
    expect(script.text).toContain("availability.memoryReviews !== 'unavailable'");
    expect(script.text).toContain('renderAgencyControl');
    expect(script.text).toContain('renderActionProposals');
    expect(script.text).toContain('decideActionProposal');
    expect(script.text).toContain('approval applies the exact runtime pause immediately');
    expect(script.text).toContain('approval records the decision; no runtime effect is configured');
    expect(script.text).toContain('CORE.actionProposalDecisionBody');
    expect(script.text).toContain('sendChat');
    expect(script.text).toContain('WIDGETS.cardsFor');
    expect(script.text).toContain('renderPageTemplates');
  });

  it('serves the static Agent Workbench and dynamic Agent Floor mount points', async () => {
    const shell = await request(app).get('/dashboard').expect(200);
    const styles = await request(app).get('/dashboard/assets/styles.css').expect(200);

    expect(shell.text).toContain('class="agent-workbench"');
    expect(shell.text).toContain('id="agent-tree"');
    expect(shell.text).toContain('id="agent-conversation-list"');
    expect(shell.text).toContain('id="agent-new-conversation"');
    expect(shell.text).toContain('id="agent-chat-heading"');
    expect(shell.text).toContain('id="agent-runtime-badge"');
    expect(shell.text).toContain('id="agent-profile-inspector"');
    expect(shell.text).toContain('id="agent-mobile-agents"');
    expect(shell.text).toContain('id="agent-mobile-chats"');
    expect(shell.text).toContain('id="agent-mobile-profile"');
    expect(shell.text).toMatch(/for="chat-message"[^>]*>\s*Message Jarvis directly/s);
    expect(shell.text).toContain('id="chat-form"');
    expect(shell.text).toContain('id="chat-message"');
    expect(shell.text).toContain('id="chat-send"');
    expect(shell.text).toContain('id="chat-status"');
    expect(shell.text).toContain('id="chat-transcript"');
    expect(shell.text).toContain('id="agent-floor-tree"');
    expect(shell.text).toContain(
      '<nav\n                class="topology-tree"\n                id="agent-floor-tree"'
    );
    expect(shell.text).toContain('id="agent-floor-registry"');
    expect(shell.text).toContain('id="agent-registry-details"');
    expect(shell.text).toContain('id="agent-registry-disclosure-count"');
    expect(shell.text).not.toContain('class="agent-row agent-table-head"');
    expect(shell.text).toContain('id="active-scope-name"');
    expect(shell.text).toContain('id="active-scope-detail"');
    expect(shell.text).not.toContain('class="scope-button"');
    expect(shell.text).toContain('class="agent-sort-state"');
    expect(shell.text).not.toContain('aria-label="Agent sorting preview"');

    expect(styles.text).toMatch(
      /\.agent-workbench\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(14rem, 18rem\) minmax\(0, 1fr\) minmax\(16rem, 20rem\)/s
    );
    expect(styles.text).toMatch(
      /@media \(max-width: 1100px\)[\s\S]*?\.agent-workbench\s*\{[^}]*grid-template-columns:\s*minmax\(14rem, 18rem\) minmax\(0, 1fr\)/s
    );
    expect(styles.text).toMatch(
      /@media \(max-width: 1100px\)[\s\S]*?\.agent-profile-inspector\s*\{[^}]*grid-column:\s*1 \/ -1/s
    );
    expect(styles.text).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.agent-mobile-toolbar\s*\{[^}]*display:\s*grid/s
    );
    expect(styles.text).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.agent-workbench\s*\{[^}]*grid-template-columns:\s*1fr/s
    );
    expect(styles.text).toMatch(/\.agent-registry-details > summary\s*\{[^}]*display:\s*flex/s);
    expect(styles.text).toMatch(
      /body\[data-active-view='chat'\] \.operator-context\s*\{[^}]*display:\s*none/s
    );
    expect(styles.text).toMatch(
      /\.agent-chat-pane\s*\{[^}]*height:\s*clamp\([^}]*overflow:\s*hidden/s
    );
    expect(styles.text).toMatch(
      /\.chat-transcript\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s
    );
    expect(styles.text).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.agent-chat-pane\s*\{[^}]*height:\s*max\(20rem, calc\(100dvh - 19\.25rem\)\)[^}]*max-height:\s*32rem/s
    );
  });

  it('renders a review-only Growth desk from the fixed revenue read model', async () => {
    const shell = await request(app).get('/dashboard').expect(200);
    expect(shell.text).toContain('id="growth-metrics"');
    expect(shell.text).toContain('id="agency-pipeline"');
    expect(shell.text).toContain('id="task-market-pipeline"');
    expect(shell.text).toContain('Proposed pipeline');
    expect(shell.text).toContain('No send or payment actions');
    expect(shell.text).not.toContain('Send outreach');

    const script = await request(app).get('/dashboard/assets/app.js').expect(200);
    const registry = await request(app).get('/dashboard/assets/widget-registry.js').expect(200);
    expect(script.text).toContain("revenue: '/revenue'");
    expect(script.text).toContain('renderGrowth');
    expect(registry.text).toContain("id: 'work-queue'");
    expect(registry.text).toContain("id: 'revenue-pipeline'");
    expect(script.text).toContain('prospectContactNote');
    expect(script.text).toContain('outreachReviewSummary');
    expect(script.text).toContain('Drafts ready for review');
    expect(script.text).not.toContain('contact reference reviewed locally');
    expect(script.text).not.toContain("metricCard('Drafts reviewed'");
    expect(shell.text).not.toContain('Move reviewed prospects');
    expect(shell.text).not.toContain('Loading reviewed prospects');
    expect(shell.text).not.toContain('Next reviewed move');
  });

  it('encodes the operator meta-UX, resilient refresh, and reflow contracts', async () => {
    const styles = await request(app).get('/dashboard/assets/styles.css').expect(200);
    expect(styles.text).toMatch(/--control-line:\s*#[0-9a-f]{6}/i);
    const panel = cssHex(styles.text, 'panel');
    expect(contrastRatio(cssHex(styles.text, 'quiet'), panel)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(cssHex(styles.text, 'control-line'), panel)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(cssHex(styles.text, 'line-strong'), panel)).toBeGreaterThanOrEqual(3);
    expect(styles.text).toMatch(/\.sr-only\s*\{/);
    expect(styles.text).toMatch(/\.operator-context\s*\{/);
    expect(styles.text).toMatch(/\.context-link,[\s\S]*display:\s*inline-flex/);
    expect(styles.text).toMatch(/\.view\s*\{[^}]*container-type:\s*inline-size/s);
    expect(styles.text).toMatch(/@container \(max-width:\s*55rem\)/);
    expect(styles.text).toMatch(
      /@container \(max-width:\s*55rem\)[\s\S]*\.pages-layout > \.saved-pages,[\s\S]*\.pages-layout > \.page-canvas\s*\{[^}]*grid-column:\s*1 \/ -1/s
    );
    expect(styles.text).toMatch(
      /@container \(max-width:\s*55rem\)[\s\S]*\.jarvis-home-grid > \.panel:first-child,[\s\S]*grid-column:\s*1 \/ -1/s
    );
    expect(styles.text).toMatch(/\.queue-workspace\s*>\s*\*\s*\{[^}]*min-width:\s*0/s);
    expect(styles.text).toMatch(
      /@container \(max-width:\s*55rem\)[\s\S]*\.queue-workspace\s*\{[^}]*grid-template-columns:\s*1fr/s
    );
    expect(styles.text).toMatch(
      /@container \(max-width:\s*60rem\)[\s\S]*\.agent-workbench\s*\{[^}]*grid-template-columns:\s*1fr/s
    );
    expect(styles.text).toMatch(/\.node-button strong[^}]*overflow-wrap:\s*anywhere/s);
    expect(styles.text).toMatch(/@media \(max-width: 1100px\)[\s\S]*\.queue-workspace/s);
    expect(styles.text).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*transform:\s*none\s*!important/s
    );
    expect(styles.text).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none\s*!important/s
    );
    expect(styles.text).toMatch(/--control-min:\s*2\.75rem/);
    expect(styles.text).toMatch(/\.proposal-actions\s*\{[^}]*display:\s*flex/s);
    expect(styles.text).toMatch(/\.nav-item\s*\{[^}]*min-height:\s*var\(--control-min\)/s);
    expect(styles.text).toMatch(
      /\.context-link,[\s\S]*\.button\s*\{[^}]*min-height:\s*var\(--control-min\)/s
    );
    expect(styles.text).toMatch(/\.lane-button,[\s\S]*min-height:\s*var\(--control-min\)/s);

    const script = await request(app).get('/dashboard/assets/app.js').expect(200);
    expect(script.text).toContain('Promise.allSettled');
    expect(script.text).toContain('const REQUEST_TIMEOUT_MS = 10_000');
    expect(script.text).toContain('new AbortController()');
    expect(script.text).toContain('signal: controller.signal');
    expect(script.text).toContain('if (controller.signal.aborted) throw error;');
    expect(script.text).toContain('window.clearTimeout(timeoutId)');
    expect(script.text).toContain('function applySourceSettlement');
    expect(script.text).toContain('function renderQueue()');
    expect(script.text).toMatch(/function renderAll\(\)[\s\S]*renderQueue\(\)/);
    expect(script.text).not.toContain('function widgetSource(widget)');
    expect(script.text).toContain('WIDGETS.sourceFor(widget)');
    expect(script.text).toContain('source unavailable; this widget is not current');
    expect(script.text).toContain('CORE.refreshPresentation');
    expect(script.text).toContain('CORE.shouldHandleNavigation');
    expect(script.text).toContain('document.title = definition.documentTitle');
    expect(script.text).toContain("document.addEventListener('visibilitychange'");
    expect(script.text).toContain('renderOperationalContext');
  });

  it('reaches every top-bar tab from the mobile navigation', async () => {
    const shell = await request(app).get('/dashboard').expect(200);

    const tabViews = [...shell.text.matchAll(/class="tab-button"[^>]*data-view-target="([a-z]+)"/g)]
      .map((match) => match[1])
      .filter((view): view is string => view !== undefined);
    const mobileSection = shell.text.slice(shell.text.indexOf('class="mobile-command-bar"'));
    const mobileViews = new Set(
      [...mobileSection.matchAll(/data-view-target="([a-z]+)"/g)].map((match) => match[1])
    );

    // The mobile bar and the tab bar drifted apart once already, stranding the
    // landing view on phones. Every tab must stay reachable from both.
    expect(tabViews.length).toBeGreaterThan(0);
    expect(tabViews.filter((view) => !mobileViews.has(view))).toEqual([]);
  });

  it('adapts navigation and queue priorities to compact viewport formats', async () => {
    const shell = await request(app).get('/dashboard').expect(200);
    const styles = await request(app).get('/dashboard/assets/styles.css').expect(200);

    expect(shell.text.indexOf('id="decision-context"')).toBeLessThan(
      shell.text.indexOf('id="posture-context"')
    );
    expect(shell.text).toContain('Review controls');
    expect(shell.text).toMatch(
      /id="overview-metrics"[^>]*tabindex="0"[^>]*role="region"[^>]*aria-label="Queue metrics"/
    );
    expect(shell.text).toMatch(
      /id="growth-metrics"[^>]*tabindex="0"[^>]*role="region"[^>]*aria-label="Growth metrics"/
    );

    expect(shell.text).toContain('class="mobile-command-bar"');
    // The first mobile primary mirrors the landing view, so the composed board
    // is reachable on a phone without going through the More menu.
    expect(shell.text).toContain('data-mobile-primary="home"');
    expect(shell.text).toContain('data-mobile-primary="chat"');
    expect(shell.text).toContain('data-mobile-primary="queue"');
    expect(shell.text).toContain('data-mobile-primary="agency"');
    expect(shell.text).toContain('class="mobile-more"');
    expect(styles.text).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.mobile-command-bar\s*\{[^}]*display:\s*grid/s
    );
    expect(styles.text).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?input,[\s\S]*?textarea\s*\{[^}]*font-size:\s*1rem/s
    );
    expect(styles.text).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.operator-context\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)[^}]*overflow-x:\s*clip[^}]*scroll-snap-type:\s*none/s
    );
    expect(styles.text).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?body\[data-active-view='chat'\] \.app-shell\s*\{[^}]*height:\s*calc\(100dvh - 4\.25rem - env\(safe-area-inset-bottom\)\)[^}]*min-height:\s*0/s
    );
    expect(styles.text).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?body\[data-active-view='chat'\] main\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto[^}]*scroll-padding-block-end:\s*1rem/s
    );
    expect(styles.text).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.instrument-strip\s*\{[^}]*display:\s*flex[^}]*overflow-x:\s*auto/s
    );
    expect(styles.text).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.operator-context\s*\{[^}]*display:\s*grid[^}]*overflow-x:\s*visible/s
    );
    expect(styles.text).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.context-card\s*\{[^}]*min-width:\s*0/s
    );
    expect(styles.text).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.instrument-strip\s*\{[^}]*display:\s*grid[^}]*overflow-x:\s*visible/s
    );
    expect(styles.text).toMatch(
      /@media \(max-width: 360px\)[\s\S]*?\.queue-toolbar\s*\{[^}]*flex-direction:\s*column/s
    );
  });

  it('keeps a selected saved page in the URL so reload and Back restore its canvas', () => {
    const source = readFileSync(
      join(projectRoot, 'public', 'dashboard', 'assets', 'navigation.js'),
      'utf8'
    );
    const context: {
      URL: typeof URL;
      JarvisDashboardNavigation?: {
        isSavedView: (href: string) => boolean;
        laneFromUrl: (href: string) => 'agency' | 'task_market';
        pageUrl: (href: string, slug: string | null) => string;
        selectedPageSlug: (href: string, pages: Array<{ slug: string }>) => string | null;
        shouldPushPageUrl: (href: string, slug: string | null) => boolean;
        viewUrl: (href: string, view: string) => string;
      };
    } = { URL };
    runInNewContext(source, context);
    const navigation = context.JarvisDashboardNavigation;
    expect(navigation).toBeDefined();

    const selectedUrl = navigation!.pageUrl(
      'http://127.0.0.1:3000/dashboard?view=queue&lane=agency',
      'queue-and-revenue'
    );
    expect(selectedUrl).toBe(
      'http://127.0.0.1:3000/dashboard?view=saved&lane=agency&page=queue-and-revenue'
    );
    expect(navigation!.isSavedView(selectedUrl)).toBe(true);
    expect(navigation!.laneFromUrl(selectedUrl)).toBe('agency');
    expect(navigation!.laneFromUrl(selectedUrl.replace('lane=agency', 'lane=unknown'))).toBe(
      'agency'
    );
    expect(navigation!.selectedPageSlug(selectedUrl, [{ slug: 'queue-and-revenue' }])).toBe(
      'queue-and-revenue'
    );
    expect(navigation!.selectedPageSlug(selectedUrl, [{ slug: 'different-page' }])).toBeNull();
    expect(navigation!.shouldPushPageUrl(selectedUrl, 'queue-and-revenue')).toBe(false);
    expect(navigation!.shouldPushPageUrl(selectedUrl, 'different-page')).toBe(true);

    const queueUrl = navigation!.viewUrl(selectedUrl, 'queue');
    expect(queueUrl).toBe('http://127.0.0.1:3000/dashboard?view=queue&lane=agency');
    expect(navigation!.isSavedView(queueUrl)).toBe(false);

    const taskMarketUrl = navigation!.viewUrl(
      'http://127.0.0.1:3000/dashboard?view=queue&lane=task_market',
      'saved'
    );
    expect(navigation!.laneFromUrl(taskMarketUrl)).toBe('task_market');

    const appSource = readFileSync(
      join(projectRoot, 'public', 'dashboard', 'assets', 'app.js'),
      'utf8'
    );
    expect(appSource).toContain('NAVIGATION.shouldPushPageUrl');
    expect(appSource).toContain('function syncLaneFromUrl()');
  });

  it('returns no-store overview, graph, and saved page JSON', async () => {
    const overview = await request(app).get('/api/v1/dashboard/overview').expect(200);
    expect(overview.headers['cache-control']).toBe('no-store');
    expect(overview.body).toMatchObject({
      generatedAt: now,
      clients: { counts: { total: 0 } },
      economics: { status: 'unavailable' },
      memory: { nodeCount: 3 }
    });

    await request(app)
      .get('/api/v1/dashboard/graph')
      .expect(200, {
        generatedAt: now,
        nodes: [{ id: 'index', type: 'index', title: 'Graph', path: 'index.md' }],
        edges: []
      });
    await request(app)
      .get('/api/v1/dashboard/pages')
      .expect(200, { pages: [], templates: listOperatorPageTemplates() });
  });

  it('previews then explicitly creates a canonical page', async () => {
    const preview = await request(app)
      .post('/api/v1/dashboard/page-plans')
      .send({ request: plan.request })
      .expect(200);
    expect(preview.body).toEqual(plan);

    const created = await request(app)
      .post('/api/v1/dashboard/pages')
      .send({
        request: plan.request,
        expectedFingerprint: plan.fingerprint,
        confirmed: true
      })
      .expect(201);
    expect(created.body).toMatchObject({ created: true, page: { slug: plan.slug } });
    expect(createInputs).toEqual([
      {
        request: plan.request,
        expectedFingerprint: plan.fingerprint,
        confirmed: true
      }
    ]);
  });

  it('rejects unknown planning fields and missing confirmation before delegation', async () => {
    await request(app)
      .post('/api/v1/dashboard/page-plans')
      .send({ request: plan.request, script: 'alert(1)' })
      .expect(400);
    await request(app)
      .post('/api/v1/dashboard/pages')
      .send({ request: plan.request, expectedFingerprint: plan.fingerprint })
      .expect(400);
    expect(previewInputs).toEqual([]);
    expect(createInputs).toEqual([]);
  });

  it('requires a dashboard root when the dashboard is enabled', () => {
    expect(() =>
      createApp({
        clients: {
          list: () => Promise.resolve([]),
          findById: () => Promise.resolve(undefined),
          create: () => Promise.reject(new Error('not used'))
        },
        runner: { run: () => Promise.reject(new Error('not used')) },
        metrics: new RequestMetrics(),
        health: {
          check: () =>
            Promise.resolve({
              timestamp: now,
              overall: 'healthy',
              severity: 'none',
              checks: {},
              failures: [],
              action: 'none'
            })
        },
        requestLog: () => undefined,
        dashboard
      })
    ).toThrow(/dashboardRoot is required/);
  });
});

describe('loopback dashboard mutation boundary', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('accepts loopback address %s', (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });

  it.each([undefined, '', '192.168.1.20', '::ffff:10.0.0.2', '2001:db8::1'])(
    'rejects non-loopback address %s',
    (address) => {
      expect(isLoopbackAddress(address)).toBe(false);
    }
  );

  it('denies the mutation middleware before a non-loopback request reaches the API', () => {
    const next = vi.fn();
    requireLoopbackMutation(
      { socket: { remoteAddress: '10.0.0.20' } } as unknown as Request,
      {} as Response,
      next
    );

    expect(next.mock.calls[0]?.[0]).toMatchObject({
      statusCode: 403,
      code: 'DASHBOARD_LOCAL_ONLY'
    });
  });
});
