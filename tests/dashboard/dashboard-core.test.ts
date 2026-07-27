import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

interface SourceRecord {
  value: unknown;
  status: 'empty' | 'fresh' | 'stale' | 'unavailable';
  sequence: number;
  updatedAt: string | null;
  message: string | null;
}

interface DashboardCoreModule {
  viewDefinition(view: unknown): {
    id: string;
    title: string;
    kicker: string;
    summary: string;
    documentTitle: string;
    sources: string[];
  };
  createSourceState(names: string[]): Record<string, SourceRecord>;
  reduceSourceState(
    previous: Record<string, SourceRecord>,
    event:
      | { type: 'source_succeeded'; source: string; sequence: number; value: unknown; at: string }
      | { type: 'source_failed'; source: string; sequence: number; message: string; at: string }
  ): Record<string, SourceRecord>;
  refreshPresentation(
    sources: Record<string, SourceRecord>,
    options: { hidden: boolean; requiredSources: string[] }
  ): { mode: 'active' | 'paused' | 'stale' | 'disconnected'; label: string; detail: string };
  healthPosture(health: unknown): {
    tone: 'ready' | 'attention' | 'blocked';
    label: string;
    summary: string;
    coreReady: boolean;
    evidence: Array<{ key: string; label: string; value: string; tone: string }>;
    action: string;
  };
  runSummary(runs: unknown): {
    running: number;
    succeeded: number;
    failed: number;
    total: number;
    value: string;
    detail: string;
  };
  queueSummary(
    queue: unknown,
    lane: unknown,
    sourceStatus?: unknown
  ): {
    available: boolean;
    ready: number;
    blocked: number;
    value: string;
    detail: string;
  };
  operatorDecision(
    queue: unknown,
    lane: unknown
  ): {
    available: boolean;
    subject: string;
    state: string;
    whyNow: string;
    href: string | null;
    cta: string | null;
  };
  boundedListSummary(returned: unknown, total: unknown, noun: string): string;
  nextRefreshDelay(failureCount: unknown): number;
  statusClass(kind: unknown, value: unknown): string;
  shouldHandleNavigation(meta: unknown): boolean;
  queueRowPresentation(
    item: unknown,
    index: unknown,
    now?: unknown
  ): { ordinal: string; owner: string; age: string; status: string; whyNow: string };
  agentProfiles(catalog: unknown): Array<Record<string, unknown>>;
  agentTreeRows(catalog: unknown): Array<{
    id: string;
    displayName: string;
    role: string;
    parentId: string | null;
    depth: number;
    hasChildren: boolean;
    trustDomain: string;
    runtimeMode: string;
    availability: string;
  }>;
  selectedAgentProfile(catalog: unknown, agentId: unknown): Record<string, unknown> | null;
  scopedAgentConversations(payload: unknown, agentId: unknown): Array<Record<string, unknown>>;
  scopedAgentMessages(
    payload: unknown,
    agentId: unknown,
    conversationId: unknown
  ): Array<Record<string, unknown>>;
  agentRuntimePresentation(
    profile: unknown,
    modelRuntime?: unknown
  ): {
    label: string;
    detail: string;
    tone: 'ready' | 'neutral' | 'blocked';
    canMessage: boolean;
  };
  modelRuntimePresentation(runtime: unknown): {
    enabled: boolean;
    version: number;
    selectedProvider: 'claude' | 'openai' | null;
    providers: Array<{
      provider: 'claude' | 'openai';
      displayName: string;
      connectionState: 'connected' | 'disconnected' | 'unavailable' | 'check_failed';
      connectionLabel: string;
      connected: boolean;
      loginAvailable: boolean;
      loginInProgress: boolean;
      selected: boolean;
      detail: string;
    }>;
  };
  agentBreadcrumb(catalog: unknown, agentId: unknown): string[];
  durableAgentRows(catalog: unknown): Array<{ id: string }>;
  agentMutationIsCurrent(token: unknown, current: unknown): boolean;
  actionProposalPresentation(
    proposal: unknown,
    now?: unknown
  ): {
    id: string;
    title: string;
    detail: string;
    aside: string;
    expectedVersion: number;
    confirmationFingerprint: string;
  } | null;
  actionProposalDecisionBody(
    proposal: unknown,
    verdict: unknown,
    now?: unknown
  ): {
    verdict: 'approved' | 'rejected';
    expectedVersion: number;
    confirmationFingerprint: string;
  } | null;
  actionProposalDecisionOutcome(
    proposal: unknown,
    response: unknown,
    now?: unknown
  ): {
    outcome: 'effect_applied' | 'recorded_only' | 'rejected' | 'unconfirmed';
    message: string;
  };
}

const requireAsset = createRequire(__filename);
const core = requireAsset(
  join(__dirname, '..', '..', 'public', 'dashboard', 'assets', 'dashboard-core.js')
) as DashboardCoreModule;

describe('dashboard meta-UX core', () => {
  it('owns canonical view identity, source needs, and document titles', () => {
    expect(core.viewDefinition('today')).toMatchObject({
      id: 'today',
      title: 'Today',
      sources: ['overview', 'queue', 'personal', 'agency']
    });
    expect(core.viewDefinition('chat')).toMatchObject({
      id: 'chat',
      title: 'Jarvis',
      sources: ['overview', 'queue', 'agents', 'modelRuntime', 'personal', 'agency', 'pages']
    });
    expect(core.viewDefinition('agency').sources).toEqual([
      'overview',
      'queue',
      'agents',
      'agency'
    ]);
    expect(core.viewDefinition('queue')).toMatchObject({
      id: 'queue',
      title: 'Work queue',
      documentTitle: 'Work queue — Jarvis Control Room',
      sources: ['overview', 'queue']
    });
    expect(core.viewDefinition('growth')).toMatchObject({
      id: 'growth',
      title: 'Growth',
      sources: ['overview', 'queue', 'revenue']
    });
    expect(core.viewDefinition('knowledge').sources).toEqual(['overview', 'queue', 'graph']);
    expect(core.viewDefinition('saved').sources).toEqual([
      'overview',
      'queue',
      'revenue',
      'graph',
      'pages',
      'personal',
      'agency'
    ]);
    expect(core.viewDefinition('not-a-view').id).toBe('today');
  });

  it('loads the persistent operator posture and decision sources on every direct view', () => {
    const directViews = [
      'today',
      'chat',
      'calendar',
      'personal',
      'agency',
      'queue',
      'runs',
      'clients',
      'growth',
      'knowledge',
      'system',
      'saved'
    ];

    directViews.forEach((view) => {
      expect(core.viewDefinition(view).sources, `${view} source contract`).toEqual(
        expect.arrayContaining(['overview', 'queue'])
      );
    });

    expect(core.viewDefinition(undefined).id).toBe('today');
  });

  it('presents ranked queue evidence without inventing an owner', () => {
    expect(
      core.queueRowPresentation(
        {
          readiness: 'ready',
          timestamp: '2026-07-21T16:30:00.000Z',
          whyNow: 'Dependency checks passed'
        },
        0,
        '2026-07-21T18:00:00.000Z'
      )
    ).toEqual({
      ordinal: '01',
      owner: 'Unclaimed',
      age: '1h',
      status: 'Ready',
      whyNow: 'Dependency checks passed'
    });

    expect(
      core.queueRowPresentation(
        {
          readiness: 'blocked',
          timestamp: '2026-07-18T18:00:00.000Z',
          ownerDisplayName: 'Delivery verifier',
          whyNow: 'Waiting for one approval'
        },
        8,
        '2026-07-21T18:00:00.000Z'
      )
    ).toMatchObject({ ordinal: '09', owner: 'Delivery verifier', age: '3d', status: 'Blocked' });
  });

  it('projects only exact unexpired action proposals into bounded decision bodies', () => {
    const proposal = {
      id: `proposal:${'a'.repeat(64)}`,
      version: 1,
      expectedVersion: 1,
      kind: 'pause_runtime',
      channel: 'telegram',
      risk: 'medium',
      state: 'pending',
      confirmationFingerprint: `sha256:${'b'.repeat(64)}`,
      createdAt: '2026-07-21T17:59:00.000Z',
      expiresAt: '2026-07-21T18:05:00.000Z',
      injectedScopeId: 'client:other'
    };

    expect(core.actionProposalPresentation(proposal, '2026-07-21T18:00:00.000Z')).toEqual({
      id: proposal.id,
      title: 'Pause runtime',
      detail: 'Telegram proposal · expires 2026-07-21T18:05:00.000Z',
      aside: 'Medium risk',
      expectedVersion: 1,
      confirmationFingerprint: proposal.confirmationFingerprint
    });
    expect(
      core.actionProposalDecisionBody(proposal, 'approved', '2026-07-21T18:00:00.000Z')
    ).toEqual({
      verdict: 'approved',
      expectedVersion: 1,
      confirmationFingerprint: proposal.confirmationFingerprint
    });
    expect(JSON.stringify(core.actionProposalDecisionBody(proposal, 'approved'))).not.toContain(
      'client:other'
    );
    expect(
      core.actionProposalDecisionBody(proposal, 'execute', '2026-07-21T18:00:00.000Z')
    ).toBeNull();
    expect(core.actionProposalPresentation(proposal, '2026-07-21T18:05:00.000Z')).toBeNull();
  });

  it('announces proposal effects only from the exact server decision and resulting posture', () => {
    const proposal = {
      id: `proposal:${'a'.repeat(64)}`,
      version: 1,
      expectedVersion: 1,
      kind: 'pause_runtime',
      channel: 'telegram',
      risk: 'medium',
      state: 'pending',
      confirmationFingerprint: `sha256:${'b'.repeat(64)}`,
      createdAt: '2026-07-21T17:59:00.000Z',
      expiresAt: '2026-07-21T18:05:00.000Z'
    };
    const decision = {
      id: `decision:${'c'.repeat(64)}`,
      proposalId: proposal.id,
      principalId: 'principal:web_operator',
      verdict: 'approved',
      proposalVersion: 2,
      decidedAt: '2026-07-21T18:00:00.000Z'
    };

    expect(
      core.actionProposalDecisionOutcome(
        proposal,
        {
          decision,
          executionPosture: {
            posture: 'paused',
            sourceProposalId: proposal.id,
            sourceProposalVersion: 2,
            sourceConfirmationFingerprint: proposal.confirmationFingerprint,
            sourceDecisionId: decision.id
          }
        },
        '2026-07-21T18:00:00.000Z'
      )
    ).toEqual({
      outcome: 'effect_applied',
      message: 'Pause runtime was approved. The exact approved runtime pause was applied.'
    });
    expect(
      core.actionProposalDecisionOutcome(
        proposal,
        { decision, executionPosture: { posture: 'active', sourceProposalId: null } },
        '2026-07-21T18:00:00.000Z'
      )
    ).toEqual({
      outcome: 'unconfirmed',
      message: 'Pause runtime was approved, but the resulting runtime pause could not be confirmed.'
    });
    expect(
      core.actionProposalDecisionOutcome(
        { ...proposal, kind: 'create_queue_work' },
        { decision, executionPosture: { posture: 'active', sourceProposalId: null } },
        '2026-07-21T18:00:00.000Z'
      )
    ).toEqual({
      outcome: 'recorded_only',
      message:
        'Create queue work was approved. The decision was recorded; no runtime effect is configured.'
    });
    expect(
      core.actionProposalDecisionOutcome(
        proposal,
        { decision: { ...decision, proposalId: `proposal:${'d'.repeat(64)}` } },
        '2026-07-21T18:00:00.000Z'
      )
    ).toEqual({
      outcome: 'unconfirmed',
      message: 'The action-proposal response did not match the exact pending decision.'
    });
  });

  it('distinguishes core readiness from optional dependency degradation', () => {
    const optionalFailure = core.healthPosture({
      overall: 'degraded',
      severity: 'P1',
      action: 'escalate_P1',
      checks: {
        gateway: 'ok',
        database: 'ok',
        disk: 'ok:15%_free',
        ollama: 'ok',
        docker: 'down',
        unsafe_extra: '<img onerror=alert(1)>'
      },
      failures: ['docker_down']
    });
    expect(optionalFailure).toMatchObject({
      tone: 'attention',
      label: 'Core ready',
      coreReady: true,
      action: 'P1 review required'
    });
    expect(optionalFailure.summary).toContain('Docker');
    expect(optionalFailure.evidence.map(({ key }) => key)).toEqual([
      'gateway',
      'database',
      'disk',
      'ollama',
      'docker'
    ]);
    expect(JSON.stringify(optionalFailure)).not.toContain('unsafe_extra');
    expect(JSON.stringify(optionalFailure)).not.toContain('<img');

    expect(
      core.healthPosture({
        overall: 'degraded',
        severity: 'P1',
        action: 'escalate_P1',
        checks: { gateway: 'ok', database: 'down', disk: 'ok:15%_free' },
        failures: ['database_down']
      })
    ).toMatchObject({ tone: 'blocked', label: 'Core not ready', coreReady: false });
  });

  it('makes running, succeeded, and failed run counts explicit', () => {
    expect(core.runSummary({ counts: { running: 0, succeeded: 2, failed: 1 } })).toEqual({
      running: 0,
      succeeded: 2,
      failed: 1,
      total: 3,
      value: '0 running',
      detail: '2 succeeded · 1 failed'
    });
  });

  it('does not present an unavailable queue source as zero ready work', () => {
    expect(core.queueSummary(null, 'agency', 'empty')).toEqual({
      available: false,
      ready: 0,
      blocked: 0,
      value: 'Loading',
      detail: 'Queue refresh in progress'
    });
    expect(core.queueSummary(null, 'agency')).toEqual({
      available: false,
      ready: 0,
      blocked: 0,
      value: 'Unavailable',
      detail: 'Queue source not loaded'
    });
    expect(
      core.queueSummary(
        {
          lanes: [
            {
              lane: 'agency',
              ready: [{ id: 'review' }],
              blocked: [{ id: 'blocked' }, { id: 'also_blocked' }]
            }
          ]
        },
        'agency'
      )
    ).toEqual({
      available: true,
      ready: 1,
      blocked: 2,
      value: '1 ready',
      detail: '2 blocked · agency lane'
    });
  });

  it('retains last-good source data, localizes failure, and rejects late responses', () => {
    const empty = core.createSourceState(['overview', 'queue']);
    const overview = { health: { overall: 'healthy' } };
    const first = core.reduceSourceState(empty, {
      type: 'source_succeeded',
      source: 'overview',
      sequence: 2,
      value: overview,
      at: '2026-07-20T04:00:00.000Z'
    });
    const stale = core.reduceSourceState(first, {
      type: 'source_failed',
      source: 'overview',
      sequence: 3,
      message: 'Overview unavailable',
      at: '2026-07-20T04:01:00.000Z'
    });
    const queueUnavailable = core.reduceSourceState(stale, {
      type: 'source_failed',
      source: 'queue',
      sequence: 3,
      message: 'Queue unavailable',
      at: '2026-07-20T04:01:00.000Z'
    });
    const ignoredLateSuccess = core.reduceSourceState(queueUnavailable, {
      type: 'source_succeeded',
      source: 'overview',
      sequence: 1,
      value: { health: { overall: 'degraded' } },
      at: '2026-07-20T03:59:00.000Z'
    });

    expect(ignoredLateSuccess.overview).toEqual({
      value: overview,
      status: 'stale',
      sequence: 3,
      updatedAt: '2026-07-20T04:00:00.000Z',
      message: 'Overview unavailable'
    });
    expect(ignoredLateSuccess.queue).toMatchObject({
      value: null,
      status: 'unavailable',
      sequence: 3,
      message: 'Queue unavailable'
    });
    expect(
      core.refreshPresentation(ignoredLateSuccess, {
        hidden: false,
        requiredSources: ['overview', 'queue']
      })
    ).toMatchObject({ mode: 'disconnected', label: 'Sources unavailable' });
    expect(
      core.refreshPresentation(ignoredLateSuccess, {
        hidden: true,
        requiredSources: ['overview']
      })
    ).toMatchObject({ mode: 'paused', label: 'Auto-refresh paused' });

    expect(
      core.refreshPresentation(stale, {
        hidden: false,
        requiredSources: ['overview']
      })
    ).toMatchObject({ mode: 'stale', label: 'Snapshot partially stale' });
    expect(
      core.refreshPresentation(first, {
        hidden: false,
        requiredSources: ['overview']
      })
    ).toMatchObject({ mode: 'active', label: 'Auto-refresh on' });
  });

  it('tracks the optional Graphify source independently from Markdown memory', () => {
    const empty = core.createSourceState(['graph', 'codeGraph']);
    expect(Object.keys(empty)).toEqual(['graph', 'codeGraph']);

    const failed = core.reduceSourceState(empty, {
      type: 'source_failed',
      source: 'codeGraph',
      sequence: 1,
      message: 'Could not refresh code graph data.',
      at: '2026-07-25T18:00:00.000Z'
    });

    expect(failed.graph).toMatchObject({ status: 'empty', value: null });
    expect(failed.codeGraph).toMatchObject({
      status: 'unavailable',
      value: null,
      message: 'Could not refresh code graph data.'
    });
  });

  it('presents one safe next decision without inventing an external action', () => {
    expect(
      core.operatorDecision(
        {
          tenantId: 'jarvis',
          lanes: [
            {
              lane: 'agency',
              ready: [
                {
                  id: 'first_client_offer_review',
                  payloadKind: 'operator_gate',
                  band: 'P2',
                  availableAt: '2026-07-20T04:00:00.000Z',
                  blockedDependencyCount: 0
                }
              ],
              blocked: []
            }
          ]
        },
        'agency'
      )
    ).toEqual({
      available: true,
      subject: 'First client offer review',
      state: 'Operator review ready',
      whyNow: 'P2 policy band · available now · dependency checks passed',
      href: '/dashboard?view=growth',
      cta: 'Open Growth review'
    });
    expect(core.operatorDecision({}, 'agency')).toMatchObject({
      available: false,
      href: null,
      cta: null
    });
  });

  it('bounds refresh delays, list disclosure, navigation interception, and class tokens', () => {
    expect(core.nextRefreshDelay(0)).toBe(30_000);
    expect(core.nextRefreshDelay(1)).toBe(60_000);
    expect(core.nextRefreshDelay(99)).toBe(300_000);
    expect(core.boundedListSummary(8, 10, 'prospect')).toBe('Showing 8 of 10 prospects');
    expect(core.boundedListSummary(10, 10, 'prospect')).toBe('Showing all 10 prospects');
    expect(core.statusClass('priority', 'P2')).toBe('priority-p2');
    expect(core.statusClass('priority', 'P2 injected-class')).toBe('priority-unknown');
    expect(core.statusClass('state', '<img onerror=alert(1)>')).toBe('status-unknown');

    expect(
      core.shouldHandleNavigation({
        defaultPrevented: false,
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false
      })
    ).toBe(true);
    expect(core.shouldHandleNavigation({ button: 0, metaKey: true })).toBe(false);
    expect(core.shouldHandleNavigation({ button: 1 })).toBe(false);
  });

  it('projects a bounded recursive agent tree and resolves only catalog selections', () => {
    const catalog = {
      profiles: [
        {
          id: 'jarvis',
          displayName: 'Jarvis',
          runtimeMode: 'deterministic',
          availability: { state: 'available' }
        },
        {
          id: 'agency',
          displayName: 'Agency',
          runtimeMode: 'profile_only',
          availability: { state: 'not_configured' }
        },
        { id: 'duplicate', displayName: 'First' },
        { id: 'duplicate', displayName: 'Second' },
        { id: '<script>', displayName: 'Unsafe' }
      ],
      hierarchy: {
        roots: [
          {
            id: 'jarvis',
            displayName: 'Jarvis',
            role: 'Coordinator',
            parentId: null,
            depth: 0,
            trustDomain: 'personal',
            runtimeMode: 'deterministic',
            availability: 'available',
            children: [
              {
                id: 'agency',
                displayName: 'Agency',
                role: 'Agency coordinator',
                parentId: 'jarvis',
                depth: 1,
                trustDomain: 'agency',
                runtimeMode: 'profile_only',
                availability: 'not_configured',
                children: []
              }
            ]
          }
        ]
      }
    };

    expect(core.agentProfiles(catalog).map(({ id }) => id)).toEqual([
      'jarvis',
      'agency',
      'duplicate'
    ]);
    expect(core.agentTreeRows(catalog)).toEqual([
      expect.objectContaining({ id: 'jarvis', depth: 0, hasChildren: true }),
      expect.objectContaining({ id: 'agency', depth: 1, hasChildren: false })
    ]);
    expect(core.selectedAgentProfile(catalog, 'agency')).toMatchObject({ id: 'agency' });
    expect(core.selectedAgentProfile(catalog, 'guessed-agent')).toMatchObject({ id: 'jarvis' });
    expect(core.selectedAgentProfile({ profiles: [] }, 'jarvis')).toBeNull();
  });

  it('projects full ancestry and a compact durable coordinator outline', () => {
    const catalog = {
      profiles: [
        { id: 'jarvis', displayName: 'Jarvis', lifecycle: 'durable' },
        { id: 'agency', displayName: 'Agency', lifecycle: 'durable' },
        { id: 'agency-developer', displayName: 'Developer', lifecycle: 'durable' },
        { id: 'agency-developer-code-red', displayName: 'Code Red', lifecycle: 'template' }
      ],
      hierarchy: {
        roots: [
          {
            id: 'jarvis',
            children: [
              {
                id: 'agency',
                children: [
                  {
                    id: 'agency-developer',
                    children: [{ id: 'agency-developer-code-red', children: [] }]
                  }
                ]
              }
            ]
          }
        ]
      }
    };

    expect(core.agentBreadcrumb(catalog, 'agency-developer-code-red')).toEqual([
      'You',
      'Jarvis',
      'Agency',
      'Developer',
      'Code Red'
    ]);
    expect(core.agentBreadcrumb(catalog, 'unknown-agent')).toEqual(['You']);
    expect(core.durableAgentRows(catalog).map(({ id }) => id)).toEqual([
      'jarvis',
      'agency',
      'agency-developer'
    ]);
  });

  it('rejects stale agent mutation results after any navigation or mutation identity change', () => {
    const token = {
      agentId: 'agency-developer',
      conversationId: 'conversation:review-1',
      navigationEpoch: 4,
      mutationEpoch: 7
    };
    expect(core.agentMutationIsCurrent(token, token)).toBe(true);
    expect(core.agentMutationIsCurrent(token, { ...token, agentId: 'agency' })).toBe(false);
    expect(
      core.agentMutationIsCurrent(token, {
        ...token,
        conversationId: 'conversation:review-2'
      })
    ).toBe(false);
    expect(core.agentMutationIsCurrent(token, { ...token, navigationEpoch: 5 })).toBe(false);
    expect(core.agentMutationIsCurrent(token, { ...token, mutationEpoch: 8 })).toBe(false);
    expect(core.agentMutationIsCurrent({}, {})).toBe(false);

    const createToken = {
      agentId: 'agency',
      conversationId: null,
      navigationEpoch: 1,
      mutationEpoch: 2
    };
    expect(core.agentMutationIsCurrent(createToken, createToken)).toBe(true);
  });

  it('filters conversations and messages to their exact selected binding', () => {
    expect(
      core.scopedAgentConversations(
        {
          conversations: [
            { id: 'conversation:jarvis-1', agentId: 'jarvis', version: 2 },
            { id: 'conversation:agency-1', agentId: 'agency', version: 1 },
            { id: 'bad id', agentId: 'jarvis', version: 1 }
          ]
        },
        'jarvis'
      )
    ).toEqual([expect.objectContaining({ id: 'conversation:jarvis-1', version: 2 })]);

    expect(
      core.scopedAgentMessages(
        {
          messages: [
            {
              id: 'message:operator-1',
              conversationId: 'conversation:jarvis-1',
              agentId: 'jarvis',
              authorKind: 'operator',
              respondingAgentId: null,
              text: 'Hello'
            },
            {
              id: 'message:jarvis-1',
              conversationId: 'conversation:jarvis-1',
              agentId: 'jarvis',
              authorKind: 'agent',
              respondingAgentId: 'jarvis',
              text: 'Hi'
            },
            {
              id: 'message:spoofed',
              conversationId: 'conversation:jarvis-1',
              agentId: 'jarvis',
              authorKind: 'agent',
              respondingAgentId: 'agency',
              text: 'Wrong responder'
            },
            {
              id: 'message:other',
              conversationId: 'conversation:other',
              agentId: 'jarvis',
              authorKind: 'operator',
              respondingAgentId: null,
              text: 'Wrong conversation'
            }
          ]
        },
        'jarvis',
        'conversation:jarvis-1'
      )
    ).toEqual([
      expect.objectContaining({ id: 'message:operator-1' }),
      expect.objectContaining({ id: 'message:jarvis-1' })
    ]);
  });

  it('labels deterministic, profile-only, and disabled runtimes honestly', () => {
    expect(
      core.agentRuntimePresentation({
        runtimeMode: 'deterministic',
        availability: { state: 'available' }
      })
    ).toMatchObject({ label: 'Deterministic · available', tone: 'ready', canMessage: true });
    expect(
      core.agentRuntimePresentation({
        runtimeMode: 'profile_only',
        availability: { state: 'not_configured' }
      })
    ).toMatchObject({ label: 'Profile chat · no executor', tone: 'neutral', canMessage: true });
    expect(
      core.agentRuntimePresentation({
        runtimeMode: 'disabled',
        availability: { state: 'disabled' }
      })
    ).toMatchObject({ label: 'Disabled', tone: 'blocked', canMessage: false });
  });

  it('normalizes the fixed subscription providers and discards unknown provider authority', () => {
    expect(
      core.modelRuntimePresentation({
        enabled: true,
        version: 7,
        selectedProvider: 'claude',
        providers: [
          {
            provider: 'claude',
            connectionState: 'connected',
            loginAvailable: true,
            loginInProgress: false,
            detail: 'Signed in through the local Claude CLI.'
          },
          {
            provider: 'openai',
            connectionState: 'disconnected',
            loginAvailable: true,
            loginInProgress: true,
            detail: 'Complete the browser login.'
          },
          {
            provider: 'attacker-provider',
            connectionState: 'connected',
            loginAvailable: true,
            detail: '<img src=x onerror=alert(1)>'
          }
        ]
      })
    ).toEqual({
      enabled: true,
      version: 7,
      selectedProvider: 'claude',
      providers: [
        {
          provider: 'claude',
          displayName: 'Claude',
          connectionState: 'connected',
          connectionLabel: 'Connected',
          connected: true,
          loginAvailable: true,
          loginInProgress: false,
          selected: true,
          detail: 'Signed in through the local Claude CLI.'
        },
        {
          provider: 'openai',
          displayName: 'OpenAI / ChatGPT',
          connectionState: 'disconnected',
          connectionLabel: 'Login in progress',
          connected: false,
          loginAvailable: true,
          loginInProgress: true,
          selected: false,
          detail: 'Complete the browser login.'
        }
      ]
    });

    expect(
      core.modelRuntimePresentation({
        enabled: 'yes',
        version: -1,
        selectedProvider: 'attacker-provider',
        providers: []
      })
    ).toMatchObject({
      enabled: false,
      version: 0,
      selectedProvider: null,
      providers: [
        {
          provider: 'claude',
          connectionState: 'unavailable',
          selected: false
        },
        {
          provider: 'openai',
          connectionState: 'unavailable',
          selected: false
        }
      ]
    });
  });

  it('shows a selected subscription only for the exact enabled Jarvis profile', () => {
    const runtime = {
      enabled: true,
      version: 2,
      selectedProvider: 'openai',
      providers: [
        {
          provider: 'openai',
          connectionState: 'connected',
          loginAvailable: true,
          loginInProgress: false,
          detail: 'Connected.'
        }
      ]
    };

    expect(
      core.agentRuntimePresentation(
        {
          id: 'jarvis',
          runtimeMode: 'deterministic',
          availability: { state: 'available' }
        },
        runtime
      )
    ).toMatchObject({
      label: 'OpenAI / ChatGPT subscription',
      tone: 'ready',
      canMessage: true
    });
    expect(
      core.agentRuntimePresentation(
        {
          id: 'agency',
          runtimeMode: 'profile_only',
          availability: { state: 'not_configured' }
        },
        runtime
      )
    ).toMatchObject({
      label: 'Profile chat · no executor',
      tone: 'neutral',
      canMessage: true
    });
    expect(
      core.agentRuntimePresentation(
        {
          id: 'jarvis',
          runtimeMode: 'deterministic',
          availability: { state: 'available' }
        },
        { ...runtime, enabled: false }
      )
    ).toMatchObject({ label: 'Deterministic · available' });
  });
});
