(function () {
  'use strict';

  const API = '/api/v1/dashboard';
  const REQUEST_TIMEOUT_MS = 10_000;
  const MODEL_CHAT_TIMEOUT_MS = 120_000;
  const MODEL_RUNTIME_POLL_INTERVAL_MS = 1_200;
  const MODEL_RUNTIME_POLL_ATTEMPTS = 20;
  const MODEL_PROVIDER_IDS = Object.freeze(['claude', 'openai']);
  const NAVIGATION = window.JarvisDashboardNavigation;
  const CORE = window.JarvisDashboardCore;
  const WIDGETS = window.JarvisWidgetRegistry;
  const LAYOUT = window.JarvisDashboardLayout;
  const GRAPH_VIEW = window.JarvisGraphView;
  if (!NAVIGATION) throw new Error('Dashboard navigation helpers are unavailable.');
  if (!CORE) throw new Error('Dashboard meta-UX helpers are unavailable.');
  if (!WIDGETS) throw new Error('Dashboard widget registry is unavailable.');
  if (!LAYOUT) throw new Error('Dashboard layout engine is unavailable.');
  if (!GRAPH_VIEW) throw new Error('Dashboard graph viewer is unavailable.');
  const SOURCE_ENDPOINTS = Object.freeze({
    agents: '/agents',
    modelRuntime: '/model-runtime',
    overview: '/overview',
    queue: '/queue',
    revenue: '/revenue',
    graph: '/graph',
    codeGraph: '/code-graph',
    pages: '/pages',
    personal: '/personal',
    agency: '/agency',
    pnl: '/pnl'
  });
  const state = {
    agents: null,
    modelRuntime: null,
    overview: null,
    queue: null,
    revenue: null,
    graph: null,
    codeGraph: null,
    personal: null,
    agency: null,
    pnl: null,
    layout: null,
    pages: [],
    pageTemplates: [],
    graphMode: 'memory',
    graphModels: { memory: null, code: null },
    graphQueries: { memory: '', code: '' },
    selectedGraphNodeIds: { memory: null, code: null },
    selectedPageSlug: null,
    selectedQueueId: null,
    selectedAgentId: 'jarvis',
    selectedConversationId: null,
    focusedAgentId: 'jarvis',
    agentNavigationEpoch: 0,
    agentMutationEpoch: 0,
    agentMutationAgentId: null,
    agentConversations: [],
    agentMessages: [],
    agentConversationLoading: false,
    agentMessageLoading: false,
    agentMutationPending: false,
    agentConversationError: null,
    agentMessageError: null,
    agentNotice: null,
    agentLoadSequence: 0,
    actionProposalMutationId: null,
    modelRuntimeMutationPending: false,
    modelRuntimeNotice: null,
    modelRuntimePollTimer: null,
    expandedAgentIds: new Set(['jarvis', 'agency']),
    activeLane: 'agency',
    plan: null,
    loading: false,
    loadSequence: 0,
    modelRuntimeLoadSequence: 0,
    refreshFailureCount: 0,
    refreshTimer: null,
    pendingSources: new Set(),
    pendingManualRefresh: false,
    sources: CORE.createSourceState(Object.keys(SOURCE_ENDPOINTS))
  };
  const $ = (selector) => document.querySelector(selector);
  let graphRenderer = null;
  let renderedGraphInput = null;

  function element(tag, options = {}) {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = String(options.text);
    if (options.type) node.type = options.type;
    if (options.id) node.id = options.id;
    if (options.href) node.setAttribute('href', options.href);
    if (options.ariaLabel) node.setAttribute('aria-label', options.ariaLabel);
    if (options.ariaPressed !== undefined)
      node.setAttribute('aria-pressed', String(options.ariaPressed));
    if (options.disabled) node.disabled = true;
    return node;
  }

  function replace(target, children) {
    target.replaceChildren(...children);
  }
  function stateMessage(message, kind) {
    return element('p', { className: `panel-state${kind ? ` ${kind}` : ''}`, text: message });
  }
  function announce(message) {
    $('#announcements').textContent = message;
  }
  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }
  function safeObject(value) {
    return value && typeof value === 'object' ? value : {};
  }
  function number(value) {
    return Number.isFinite(value) ? value : 0;
  }
  function date(value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'Unknown time' : parsed.toLocaleString();
  }
  function plural(value, word) {
    return `${value} ${word}${value === 1 ? '' : 's'}`;
  }
  function microUsd(value) {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 6
    }).format(number(value) / 1_000_000);
  }
  function label(value) {
    if (value === 'modelRuntime') return 'model runtime';
    if (value === 'codeGraph') return 'code graph';
    if (value === 'pnl') return 'P&L';
    return String(value || 'unknown').replace(/[-_]/g, ' ');
  }
  function subject(value) {
    const words = label(value).replace(/\s+/g, ' ').trim();
    const readable = words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : 'Queued work';
    return readable.length > 72 ? `${readable.slice(0, 69)}…` : readable;
  }

  function requestedPageSlug() {
    return NAVIGATION.selectedPageSlug(window.location.href, state.pages);
  }

  function syncSelectedPageFromUrl() {
    state.selectedPageSlug = requestedPageSlug();
  }

  function selectPage(slug, updateHistory) {
    const selected = state.pages.some((page) => page.slug === slug) ? slug : null;
    state.selectedPageSlug = selected;
    if (updateHistory && NAVIGATION.shouldPushPageUrl(window.location.href, selected)) {
      const nextUrl = NAVIGATION.pageUrl(window.location.href, selected);
      window.history.pushState({ view: 'saved', page: selected }, '', nextUrl);
    }
    renderPages();
  }

  function syncLaneFromUrl() {
    const lane = NAVIGATION.laneFromUrl(window.location.href);
    if (lane !== state.activeLane) state.selectedQueueId = null;
    state.activeLane = lane;
    document.querySelectorAll('[data-lane]').forEach((button) => {
      const active = button.dataset.lane === lane;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (state.queue) {
      renderQueue();
      renderOverview();
      renderOperationalContext();
    }
  }

  async function request(path, options, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${API}${path}`, {
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          ...(options && options.body ? { 'Content-Type': 'application/json' } : {})
        },
        ...options,
        signal: controller.signal
      });
      const payload = await response.json().catch((error) => {
        if (controller.signal.aborted) throw error;
        return null;
      });
      if (!response.ok) {
        const message =
          payload && payload.error && payload.error.message
            ? payload.error.message
            : `Request failed (${response.status})`;
        const error = new Error(message);
        if (payload && payload.error && payload.error.code) error.code = payload.error.code;
        error.status = response.status;
        throw error;
      }
      return payload;
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(
          `Local dashboard request timed out after ${Math.round(timeoutMs / 1_000)} seconds.`
        );
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function setLoading(loading) {
    state.loading = loading;
    $('#refresh-button').disabled = loading;
    $('#refresh-button').textContent = loading ? 'Refreshing…' : 'Refresh';
    $('#main-content').setAttribute('aria-busy', String(loading));
  }

  function selectedViewDefinition() {
    return CORE.viewDefinition(NAVIGATION.viewFromUrl(window.location.href));
  }

  function selectedLoadSources() {
    const definition = selectedViewDefinition();
    return definition.id === 'knowledge' && state.graphMode === 'code'
      ? [...definition.sources, 'codeGraph']
      : definition.sources;
  }

  function renderActiveScope(viewInput) {
    const view = CORE.viewDefinition(viewInput || selectedViewDefinition().id).id;
    const profile = view === 'chat' ? selectedAgentProfile() : null;
    let name = 'Harness';
    let detail = 'System evidence · local';
    if (profile) {
      name = profile.displayName || subject(profile.id);
      const readableSleeves = safeArray(safeObject(profile.memory).readableSleeveIds);
      detail = `${label(profile.trustDomain)} · ${readableSleeves[0] || 'profile sleeve'}`;
    } else if (['today', 'calendar', 'personal'].includes(view)) {
      name = 'Personal';
      detail = 'Private sleeve · local';
    } else if (['agency', 'queue', 'runs', 'clients', 'growth'].includes(view)) {
      name = 'Agency';
      detail = 'Agency sleeve · local';
    }
    $('#active-scope-sigil').textContent = name.slice(0, 1).toUpperCase();
    $('#active-scope-name').textContent = name;
    $('#active-scope-detail').textContent = detail;
  }

  function commitSourceValue(source, value) {
    if (source === 'agents') {
      state.agents = safeObject(value);
      void restoreAgentSelectionFromUrl();
    } else if (source === 'modelRuntime') state.modelRuntime = safeObject(value);
    else if (source === 'overview') state.overview = safeObject(value);
    else if (source === 'queue') state.queue = safeObject(value);
    else if (source === 'revenue') state.revenue = safeObject(value);
    else if (source === 'personal') state.personal = safeObject(value);
    else if (source === 'agency') state.agency = safeObject(value);
    else if (source === 'pnl') state.pnl = safeObject(value);
    else if (source === 'graph') {
      state.graph = safeObject(value);
      state.graphModels.memory = GRAPH_VIEW.normalizeGraph(state.graph);
      state.selectedGraphNodeIds.memory = GRAPH_VIEW.reconcileSelection(
        state.graphModels.memory,
        state.selectedGraphNodeIds.memory
      );
    } else if (source === 'codeGraph') {
      state.codeGraph = safeObject(value);
      state.graphModels.code = GRAPH_VIEW.normalizeGraph(state.codeGraph);
      state.selectedGraphNodeIds.code = GRAPH_VIEW.reconcileSelection(
        state.graphModels.code,
        state.selectedGraphNodeIds.code
      );
    } else if (source === 'pages') {
      state.pages = safeArray(safeObject(value).pages);
      state.pageTemplates = safeArray(safeObject(value).templates);
      syncSelectedPageFromUrl();
    }
  }

  function applySourceSettlement(source, settlement, sequence) {
    const completedAt = new Date().toISOString();
    if (sequence < number(safeObject(state.sources[source]).sequence))
      return { source, status: 'superseded', completedAt };
    if (settlement.status === 'fulfilled') {
      state.sources = CORE.reduceSourceState(state.sources, {
        type: 'source_succeeded',
        source,
        sequence,
        value: settlement.value,
        at: completedAt
      });
      commitSourceValue(source, settlement.value);
      updateRefreshTimestamp(completedAt);
      return { source, status: 'fulfilled', completedAt };
    }
    state.sources = CORE.reduceSourceState(state.sources, {
      type: 'source_failed',
      source,
      sequence,
      message: `Could not refresh ${label(source)} data.`,
      at: completedAt
    });
    return { source, status: 'rejected', completedAt };
  }

  function nextModelRuntimeLoadSequence() {
    state.modelRuntimeLoadSequence =
      Math.max(
        state.modelRuntimeLoadSequence,
        number(safeObject(state.sources.modelRuntime).sequence)
      ) + 1;
    return state.modelRuntimeLoadSequence;
  }

  function unavailableTargets(source) {
    return (
      {
        agents: [
          '#agent-tree',
          '#agent-conversation-list',
          '#agent-profile-inspector',
          '#agent-floor-tree',
          '#agent-floor-registry'
        ],
        modelRuntime: ['#model-runtime-providers'],
        overview: [
          '#overview-metrics',
          '#improvement-snapshot',
          '#economics-snapshot',
          '#economics-metrics',
          '#economics-routing',
          '#economics-models',
          '#improvements-list',
          '#clients-list',
          '#run-counts',
          '#runs-list'
        ],
        queue: ['#attention-list', '#queue-inspector-content'],
        revenue: ['#growth-metrics', '#agency-pipeline', '#task-market-pipeline', '#growth-next'],
        pages: ['#saved-pages-list', '#page-canvas', '#page-template-list'],
        personal: [
          '#today-metrics',
          '#today-events',
          '#today-memory',
          '#calendar-metrics',
          '#calendar-suggestion',
          '#calendar-events',
          '#personal-memory-tree'
        ],
        agency: [
          '#today-decisions',
          '#agency-metrics',
          '#agency-autonomous',
          '#agency-approval',
          '#agency-blocked'
        ],
        pnl: ['#pnl-body']
      }[source] || []
    );
  }

  function renderUnavailableSources(sources) {
    sources.forEach((source) => {
      const record = safeObject(state.sources[source]);
      if (record.status !== 'unavailable') return;
      unavailableTargets(source).forEach((selector) => {
        const target = $(selector);
        if (target)
          replace(target, [
            stateMessage(record.message || `${label(source)} unavailable`, 'error')
          ]);
      });
    });
  }

  function updateRefreshTimestamp(value) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return;
    const target = $('#refreshed-at');
    target.dateTime = parsed.toISOString();
    target.textContent = `Snapshot ${parsed.toLocaleString()}`;
  }

  function clearRefreshTimer() {
    if (state.refreshTimer !== null) window.clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }

  function scheduleRefresh() {
    clearRefreshTimer();
    renderOperationalContext();
    if (document.hidden) return;
    const delay = CORE.nextRefreshDelay(state.refreshFailureCount);
    state.refreshTimer = window.setTimeout(() => load({ manual: false }), delay);
  }

  async function load({ manual = false, sources = selectedLoadSources() } = {}) {
    const requestedSources = [...new Set(safeArray(sources))].filter((source) =>
      Object.hasOwn(SOURCE_ENDPOINTS, source)
    );
    if (state.loading) {
      requestedSources.forEach((source) => state.pendingSources.add(source));
      state.pendingManualRefresh ||= manual;
      return;
    }
    clearRefreshTimer();
    setLoading(true);
    const sequence = ++state.loadSequence;
    const previouslyDegraded = requestedSources.some((source) =>
      ['stale', 'unavailable'].includes(safeObject(state.sources[source]).status)
    );
    try {
      const results = await Promise.allSettled(
        requestedSources.map(async (source) => {
          const sourceSequence =
            source === 'modelRuntime' ? nextModelRuntimeLoadSequence() : sequence;
          let settlement;
          try {
            settlement = { status: 'fulfilled', value: await request(SOURCE_ENDPOINTS[source]) };
          } catch (error) {
            settlement = { status: 'rejected', reason: error };
          }
          const applied = applySourceSettlement(source, settlement, sourceSequence);
          try {
            renderAll();
          } catch (error) {
            console.error(`Could not render ${source} dashboard data.`, error);
            throw error;
          }
          if (applied.status === 'rejected') renderUnavailableSources([source]);
          return applied;
        })
      );
      const settlements = results.map((result, index) =>
        result.status === 'fulfilled'
          ? result.value
          : { source: requestedSources[index], status: 'rejected' }
      );
      const failedSources = settlements
        .filter((settlement) => settlement.status === 'rejected')
        .map((settlement) => settlement.source);
      const succeededSourceCount = settlements.length - failedSources.length;
      state.refreshFailureCount = failedSources.length
        ? Math.min(state.refreshFailureCount + 1, 8)
        : 0;
      renderAll();
      renderUnavailableSources(failedSources);
      renderOperationalContext();
      if (failedSources.length > 0 && (manual || !previouslyDegraded)) {
        announce(
          `${manual ? 'Refresh' : 'Background refresh'} incomplete. ${failedSources.map(label).join(', ')} unavailable; other sources were preserved.`
        );
      } else if (manual) announce('Dashboard refreshed. All requested local sources are current.');
    } finally {
      setLoading(false);
      const pendingSources = [...state.pendingSources];
      const pendingManualRefresh = state.pendingManualRefresh;
      state.pendingSources.clear();
      state.pendingManualRefresh = false;
      if (pendingSources.length > 0)
        void load({ manual: pendingManualRefresh, sources: pendingSources });
      else scheduleRefresh();
    }
  }

  function metricCard(labelText, value, detail) {
    const card = element('article', { className: 'metric-card' });
    card.append(
      element('span', { className: 'metric-label', text: labelText }),
      element('strong', { text: value }),
      element('span', { text: detail })
    );
    return card;
  }

  function postureBadgeClass(tone) {
    if (tone === 'ready') return 'status-badge';
    if (tone === 'attention' || tone === 'blocked') return 'status-badge degraded';
    return 'status-badge neutral';
  }

  function renderHealthPosture(posture) {
    const evidence = safeArray(posture.evidence);
    const systemBadge = $('#system-health-badge');
    systemBadge.textContent = posture.label;
    systemBadge.className = postureBadgeClass(posture.tone);
    $('#system-health-summary').textContent = posture.summary;

    const evidenceList = $('#system-health-evidence');
    const rows = evidence.map((check) => {
      const row = element('div', {
        className: `health-check ${CORE.statusClass('tone', check.tone)}`
      });
      row.append(element('dt', { text: check.label }), element('dd', { text: check.value }));
      return row;
    });
    replace(evidenceList, rows);

    const queueBadge = $('#health-badge');
    queueBadge.textContent = posture.label;
    queueBadge.className = postureBadgeClass(posture.tone);
    const connectionTone =
      posture.tone === 'ready' ? 'ok' : posture.tone === 'attention' ? 'attention' : 'problem';
    $('#connection-dot').className = `status-dot ${connectionTone}`;
    $('#connection-status').textContent =
      posture.tone === 'ready'
        ? 'Core services ready'
        : posture.tone === 'attention'
          ? 'Core ready · dependency attention'
          : 'Core services require review';
  }

  function renderOperationalContext() {
    const definition = selectedViewDefinition();
    const refresh = CORE.refreshPresentation(state.sources, {
      requiredSources: definition.sources,
      hidden: document.hidden
    });
    const refreshClass = {
      active: 'is-active',
      stale: 'is-stale',
      disconnected: 'is-disconnected',
      paused: 'is-paused'
    }[refresh.mode];
    $('#refresh-mode').className = `refresh-mode ${refreshClass || 'is-active'}`;
    $('#refresh-mode').textContent = refresh.label;
    $('#refresh-detail').textContent = refresh.detail;

    const overviewRecord = safeObject(state.sources.overview);
    const postureCard = $('#posture-context');
    if (state.overview) {
      const posture = CORE.healthPosture(safeObject(state.overview).health);
      postureCard.className = `context-card ${CORE.statusClass('tone', posture.tone)}`;
      $('#context-posture').textContent = posture.label;
      $('#context-posture-detail').textContent = posture.summary;
      renderHealthPosture(posture);
    } else {
      const unavailable = overviewRecord.status === 'unavailable';
      postureCard.className = 'context-card';
      $('#context-posture').textContent = unavailable ? 'Health unavailable' : 'Checking readiness';
      $('#context-posture-detail').textContent = unavailable
        ? overviewRecord.message || 'The overview source could not be loaded.'
        : 'Waiting for the bounded health snapshot.';
      $('#system-health-badge').textContent = unavailable ? 'Unavailable' : 'Checking';
      $('#system-health-badge').className = 'status-badge neutral';
      $('#system-health-summary').textContent = $('#context-posture-detail').textContent;
      replace($('#system-health-evidence'), []);
    }

    const queueRecord = safeObject(state.sources.queue);
    const decisionCard = $('#decision-context');
    const decisionLink = $('#context-decision-link');
    if (state.queue) {
      const decision = CORE.operatorDecision(state.queue, state.activeLane);
      const decisionTone = decision.available
        ? decision.state === 'Blocked by dependencies'
          ? 'blocked'
          : 'ready'
        : null;
      decisionCard.className = decisionTone
        ? `context-card ${CORE.statusClass('tone', decisionTone)}`
        : 'context-card';
      $('#context-decision').textContent = decision.subject;
      $('#context-decision-detail').textContent = `${decision.state} · ${decision.whyNow}`;
      decisionLink.hidden = !decision.href;
      if (decision.href) {
        decisionLink.setAttribute('href', decision.href);
        decisionLink.textContent = decision.cta;
      }
    } else if (state.agency) {
      const approvals = safeArray(safeObject(state.agency).approvalRequired);
      const autonomous = safeArray(safeObject(state.agency).autonomous);
      const next = approvals[0] || autonomous[0];
      decisionCard.className = `context-card ${CORE.statusClass(
        'tone',
        approvals.length ? 'attention' : 'ready'
      )}`;
      $('#context-decision').textContent = next
        ? next.label || subject(next.id)
        : 'No agency decision is waiting';
      $('#context-decision-detail').textContent = next
        ? next.reason || 'Bounded by the agency policy.'
        : 'Jarvis found no current approval or autonomous candidate.';
      decisionLink.hidden = false;
      decisionLink.setAttribute('href', '/dashboard?view=agency');
      decisionLink.textContent = 'Open Agency agent';
    } else {
      const unavailable = queueRecord.status === 'unavailable';
      decisionCard.className = 'context-card';
      $('#context-decision').textContent = unavailable
        ? 'Queue unavailable'
        : 'Loading the durable queue';
      $('#context-decision-detail').textContent = unavailable
        ? queueRecord.message || 'The queue source could not be loaded.'
        : 'No action has been selected.';
      decisionLink.hidden = true;
    }
  }

  function renderOverview() {
    const overview = state.overview;
    if (!overview) return;
    const health = safeObject(overview.health);
    const clients = safeObject(overview.clients);
    const runs = safeObject(overview.runs);
    const memory = safeObject(overview.memory);
    const posture = CORE.healthPosture(health);
    const queueSummary = CORE.queueSummary(
      state.queue,
      state.activeLane,
      safeObject(state.sources.queue).status
    );
    const runSummary = CORE.runSummary(runs);
    replace($('#overview-metrics'), [
      metricCard('Ready work', queueSummary.value, queueSummary.detail),
      metricCard(
        'Clients',
        number(safeObject(clients.counts).total),
        `${number(safeObject(clients.counts).active)} active`
      ),
      metricCard('Runs', runSummary.value, runSummary.detail),
      metricCard('Memory', number(memory.nodeCount), `${number(memory.edgeCount)} graph edges`)
    ]);
    renderImprovementSnapshot(safeArray(safeObject(overview.improvements).proposals));
    renderEconomicsSnapshot();
    renderHealthPosture(posture);
    renderOperationalContext();
  }

  function renderEconomicsSnapshot() {
    const target = $('#economics-snapshot');
    const economics = safeObject(safeObject(state.overview).economics);
    if (economics.status !== 'available') {
      return replace(target, [
        stateMessage(
          economics.reason ||
            'No model-call telemetry exists. Deterministic Tier 0 work remains model-free.'
        )
      ]);
    }
    const usage = safeObject(economics.usage);
    const cost = safeObject(economics.cost);
    const list = element('div', { className: 'row-list' });
    const usageRow = element('div', { className: 'data-row' });
    const usageMain = element('div', { className: 'row-main' });
    usageMain.append(
      element('strong', { text: plural(number(usage.requestCount), 'model request') }),
      element('span', {
        text: `${number(usage.inputTokens) + number(usage.outputTokens)} observed tokens`
      })
    );
    usageRow.append(usageMain);
    const costRow = element('div', { className: 'data-row' });
    const costMain = element('div', { className: 'row-main' });
    const knownCostEvents = number(cost.observedCostEvents) + number(cost.estimatedCostEvents);
    costMain.append(
      element('strong', {
        text: knownCostEvents > 0 ? microUsd(cost.knownMicroUsd) : 'Cost unavailable'
      }),
      element('span', { text: `${label(cost.coverage)} price coverage` })
    );
    costRow.append(costMain);
    list.append(usageRow, costRow);
    replace(target, [list]);
  }

  function renderEconomics() {
    if (!state.overview) return;
    const economics = safeObject(safeObject(state.overview).economics);
    const badge = $('#economics-badge');
    if (economics.status !== 'available') {
      badge.textContent = 'Telemetry unavailable';
      badge.className = 'status-badge neutral';
      replace($('#economics-metrics'), [
        metricCard(
          'Attribution',
          'Unavailable',
          economics.reason || 'No model-usage records have been written.'
        ),
        metricCard('Tier 0', 'Active', 'Deterministic work uses no model tokens'),
        metricCard('Model execution', 'Disabled', 'Logical routes are simulation only'),
        metricCard('Cost coverage', 'Unknown', 'No price evidence is treated as zero')
      ]);
      replace($('#economics-routing'), [
        stateMessage('No measured model requests exist. Tier 0 is not miscounted as a model call.')
      ]);
      replace($('#economics-models'), [
        stateMessage('No provider or model activity has been recorded.')
      ]);
      return;
    }

    badge.textContent = 'Observed telemetry';
    badge.className = 'status-badge';
    const usage = safeObject(economics.usage);
    const cost = safeObject(economics.cost);
    const knownCostEvents = number(cost.observedCostEvents) + number(cost.estimatedCostEvents);
    replace($('#economics-metrics'), [
      metricCard(
        'Requests',
        number(usage.requestCount),
        `${number(usage.succeededCount)} succeeded · ${number(usage.failedCount) + number(usage.timeoutCount)} failed or timed out`
      ),
      metricCard(
        'Observed tokens',
        number(usage.inputTokens) + number(usage.outputTokens),
        `${number(usage.inputTokens)} in · ${number(usage.outputTokens)} out`
      ),
      metricCard(
        'Cache reads',
        number(usage.cacheReadTokens),
        `${number(usage.unknownTokenEvents)} requests with incomplete token data`
      ),
      metricCard(
        'Known cost',
        knownCostEvents > 0 ? microUsd(cost.knownMicroUsd) : 'Unknown',
        `${label(cost.coverage)} coverage · ${number(cost.unknownCostEvents)} unknown`
      )
    ]);

    const routes = safeArray(economics.routing);
    if (!routes.length)
      replace($('#economics-routing'), [stateMessage('No measured routing mix is available.')]);
    else {
      const list = element('div', { className: 'row-list' });
      routes.forEach((route) => {
        const row = element('div', { className: 'data-row' });
        row.append(
          element('strong', { text: label(route.route) }),
          element('span', {
            className: 'row-aside',
            text: plural(number(route.requestCount), 'request')
          })
        );
        list.append(row);
      });
      replace($('#economics-routing'), [list]);
    }

    const models = safeArray(economics.models);
    if (!models.length)
      replace($('#economics-models'), [stateMessage('No bounded model groups are available.')]);
    else {
      const list = element('div', { className: 'row-list' });
      models.forEach((model) => {
        const row = element('div', { className: 'data-row' });
        const main = element('div', { className: 'row-main' });
        main.append(
          element('strong', {
            text: `${model.provider || 'provider'} / ${model.model || 'model'}`
          }),
          element('span', {
            text: `${label(model.route)} · ${number(model.inputTokens) + number(model.outputTokens)} tokens · ${number(model.averageLatencyMs)} ms avg`
          })
        );
        row.append(
          main,
          element('span', {
            className: 'row-aside',
            text: plural(number(model.requestCount), 'request')
          })
        );
        list.append(row);
      });
      replace($('#economics-models'), [list]);
    }
  }

  function queueSnapshotItems(snapshot) {
    const items = [];
    safeArray(safeObject(snapshot).lanes).forEach((lane) => {
      for (const [readiness, tasks] of [
        ['ready', safeArray(lane.ready)],
        ['blocked', safeArray(lane.blocked)]
      ]) {
        tasks.forEach((task) => {
          const blockedCount = number(task.blockedDependencyCount);
          const executionEligibility =
            task.executionEligibility === 'bound' ? 'bound' : 'proposal_only';
          const sourceLane = String(lane.lane || 'agency');
          const operatorLane = task.tenantId && task.tenantId !== 'jarvis' ? 'agency' : sourceLane;
          items.push({
            ...task,
            id: String(task.id),
            lane: operatorLane,
            sourceLane,
            priority: ['P0', 'P1', 'P2', 'P3'].includes(task.band) ? task.band : 'P3',
            title: subject(task.id),
            readiness,
            executionEligibility,
            timestamp: task.availableAt || task.createdAt,
            whyNow:
              executionEligibility === 'proposal_only'
                ? 'No verified executor is bound to this tenant and work type; inspect or propose only'
                : readiness === 'ready'
                  ? `${task.band || 'P3'} policy band · available now · dependency checks passed`
                  : `${plural(blockedCount, 'dependency')} must complete before this work becomes ready`
          });
        });
      }
    });
    return items;
  }

  function renderQueue() {
    if (!state.queue) return;
    renderAttention(queueSnapshotItems(state.queue));
  }

  function renderAttention(items) {
    const target = $('#attention-list');
    const visible = items.filter((item) => item.lane === state.activeLane);
    $('#attention-count').textContent = plural(visible.length, 'item');
    if (!visible.length) {
      state.selectedQueueId = null;
      renderQueueInspector([]);
      return replace(target, [
        stateMessage(
          state.activeLane === 'agency'
            ? 'No agency work is ready or blocked in the durable queue.'
            : 'No task-market work is ready or blocked. This lane stays inactive until a reviewed contract exists.'
        )
      ]);
    }
    if (!visible.some((item) => item.id === state.selectedQueueId)) {
      state.selectedQueueId = visible[0].id;
    }
    const list = element('div', { className: 'row-list' });
    visible.forEach((item, index) => {
      const presentation = CORE.queueRowPresentation(item, index);
      const row = element('button', {
        className: 'queue-item',
        type: 'button',
        ariaPressed: item.id === state.selectedQueueId
      });
      const main = element('div', { className: 'row-main' });
      main.append(
        element('strong', {
          text: item.title
        }),
        element('span', {
          text: `${label(item.payloadKind)} · ${item.readiness}`
        })
      );
      const meta = element('div', { className: 'queue-item-meta' });
      meta.append(
        element('span', {
          className: `priority ${CORE.statusClass('priority', item.priority)}`,
          text: item.priority
        }),
        element('span', {
          className: CORE.statusClass('state', item.readiness),
          text:
            item.readiness === 'blocked'
              ? `Blocked · ${number(item.blockedDependencyCount)}`
              : 'Ready'
        }),
        element('span', { className: 'queue-owner', text: presentation.owner }),
        element('time', {
          className: 'queue-age',
          text: presentation.age,
          ariaLabel: `Observed ${date(item.timestamp)}`
        })
      );
      const body = element('div', { className: 'queue-item-body' });
      body.append(main, element('p', { className: 'queue-why', text: presentation.whyNow }));
      row.append(
        element('span', { className: 'queue-ordinal', text: presentation.ordinal }),
        body,
        meta
      );
      row.addEventListener('click', () => {
        state.selectedQueueId = item.id;
        renderAttention(items);
      });
      list.append(row);
    });
    replace(target, [list]);
    renderQueueInspector(visible);
  }

  function renderQueueInspector(items) {
    const target = $('#queue-inspector-content');
    const selected = items.find((item) => item.id === state.selectedQueueId);
    if (!selected) {
      return replace(target, [
        stateMessage('Select a queue item to inspect its safe ordering evidence.')
      ]);
    }
    const detail = element('div', { className: 'inspector-detail' });
    const heading = element('div', { className: 'inspector-heading' });
    heading.append(
      element('span', {
        className: `priority ${CORE.statusClass('priority', selected.priority)}`,
        text: selected.priority
      }),
      element('h3', { text: selected.title })
    );
    const facts = element('dl', { className: 'fact-list' });
    const readyState =
      selected.executionEligibility !== 'bound'
        ? 'Proposal-only · no verified executor binding'
        : selected.payloadKind === 'automation'
          ? 'Automation eligible for worker claim'
          : selected.payloadKind === 'operator_gate'
            ? 'Operator review ready'
            : 'Project work ready';
    [
      ['Lane', selected.lane === 'task_market' ? 'Task market' : 'AI agency'],
      ['Worker lane', label(selected.sourceLane)],
      ['Scope', `Tenant ${selected.tenantId || safeObject(state.queue).tenantId || 'unavailable'}`],
      [
        'Execution',
        selected.executionEligibility === 'bound'
          ? 'Verified tenant/worker binding'
          : 'Proposal-only; no autonomous handler'
      ],
      ['Kind', label(selected.payloadKind)],
      [
        'Dependencies',
        `${number(selected.blockedDependencyCount)} blocked of ${number(selected.dependencyCount)}`
      ],
      ['State', selected.readiness === 'ready' ? readyState : 'Blocked'],
      ['Available', date(selected.timestamp)]
    ].forEach(([term, value]) => {
      facts.append(element('dt', { text: term }), element('dd', { text: value }));
    });
    const why = element('section', { className: 'why-now' });
    why.append(
      element('p', { className: 'eyebrow', text: 'Why now' }),
      element('p', { text: selected.whyNow })
    );
    detail.append(heading, facts, why);
    replace(target, [detail]);
  }

  function renderImprovementSnapshot(proposals) {
    const target = $('#improvement-snapshot');
    if (!proposals.length)
      return replace(target, [
        stateMessage('No repeated-work proposals meet the current threshold.')
      ]);
    const list = element('div', { className: 'row-list' });
    proposals.slice(0, 3).forEach((proposal) => {
      const row = element('div', { className: 'data-row' });
      const main = element('div', { className: 'row-main' });
      main.append(
        element('strong', { text: proposal.taskSignature || 'Repeated task' }),
        element('span', {
          text: `${plural(number(proposal.executionCount), 'execution')} · ${proposal.skill || 'repository skill'}`
        })
      );
      row.append(main);
      list.append(row);
    });
    replace(target, [list]);
  }

  function renderClients() {
    if (!state.overview) return;
    const clients = safeObject(safeObject(state.overview).clients);
    const items = safeArray(clients.items);
    $('#client-total').textContent = plural(number(safeObject(clients.counts).total), 'client');
    if (!items.length)
      return replace($('#clients-list'), [
        stateMessage(
          'No clients are registered yet. Create a client through the scoped API before operating automations.'
        )
      ]);
    const cards = items.map((client) => {
      const card = element('article', { className: 'client-card' });
      const header = element('header');
      header.append(
        element('h2', { text: client.name || client.id || 'Unnamed client' }),
        element('span', {
          className: CORE.statusClass('state', client.status),
          text: label(client.status)
        })
      );
      card.append(
        header,
        element('p', { className: 'client-meta', text: `ID: ${client.id || '—'}` }),
        element('p', { className: 'client-meta', text: `Profile: ${label(client.profile)}` }),
        element('p', { className: 'client-meta', text: `Created: ${date(client.createdAt)}` })
      );
      return card;
    });
    replace($('#clients-list'), cards);
  }

  function renderRuns() {
    if (!state.overview) return;
    const runs = safeObject(safeObject(state.overview).runs);
    const counts = safeObject(runs.counts);
    replace(
      $('#run-counts'),
      ['pending', 'running', 'succeeded', 'failed'].map((status) =>
        metricCard(status, number(counts[status]), 'bounded run summary')
      )
    );
    const recent = safeArray(runs.recent);
    const target = $('#runs-list');
    if (!recent.length)
      return replace(target, [
        stateMessage(
          'No runs have been recorded. Run summaries will appear here without their inputs or outputs.'
        )
      ]);
    const table = element('table', { className: 'data-table' });
    const head = element('thead');
    const headRow = element('tr');
    ['Automation', 'Sleeve', 'Supervisor', 'Status', 'Last activity'].forEach((heading) =>
      headRow.append(element('th', { text: heading }))
    );
    head.append(headRow);
    const body = element('tbody');
    recent.forEach((run) => {
      const supervisor = safeObject(run.supervisor);
      const row = element('tr');

      const automation = element('td');
      automation.append(
        element('strong', { text: run.automation || 'Automation' }),
        element('span', { className: 'quiet', text: run.id || 'Unknown run' })
      );

      // The chip names which recorded edge produced the attribution, so the
      // operator can tell a real delegation from the root-coordinator default.
      const supervisorCell = element('td');
      const chip = element('span', {
        className: 'supervisor-chip',
        text: boundedLabel(supervisor.label) || 'Jarvis'
      });
      chip.dataset.kind = boundedLabel(supervisor.kind) || 'jarvis';
      chip.title = `Derived from ${boundedLabel(supervisor.derivedFrom) || 'root_default'}`;
      supervisorCell.append(chip);

      row.append(
        automation,
        element('td', { text: boundedLabel(supervisor.sleeveId) || run.clientId || 'system' }),
        supervisorCell,
        element('td', {
          className: CORE.statusClass('state', run.status),
          text: label(run.status)
        }),
        element('td', { text: date(run.completedAt || run.startedAt) })
      );
      body.append(row);
    });
    table.append(head, body);
    replace(target, [table]);
  }

  function graphModeKey() {
    return state.graphMode === 'code' ? 'code' : 'memory';
  }

  function graphSourceName() {
    return graphModeKey() === 'code' ? 'codeGraph' : 'graph';
  }

  function activeGraphModel() {
    return safeObject(state.graphModels)[graphModeKey()] || null;
  }

  function graphNodeLocation(node) {
    const path = boundedLabel(node.path) || boundedLabel(node.id);
    return node.line ? `${path}:L${number(node.line)}` : path;
  }

  function graphGroupLabel(node) {
    return boundedLabel(node.group).replace(':', ' ') || boundedLabel(node.type) || 'node';
  }

  function graphRevisionSummary(graph, sourceRecord) {
    const metadata = safeObject(graph.metadata);
    const staleRead = sourceRecord.status === 'stale' ? 'Refresh failed; showing prior data. ' : '';
    if (graph.source !== 'graphify') {
      return `${staleRead}Validated global Markdown only · generated ${date(metadata.generatedAt)}`;
    }
    const built = boundedLabel(metadata.builtAtCommit).slice(0, 8) || 'unknown';
    const current = boundedLabel(metadata.currentCommit).slice(0, 8);
    const revision =
      metadata.revisionStatus === 'stale'
        ? `Built at ${built}; current HEAD is ${current || 'different'}. This map may be stale.`
        : metadata.revisionStatus === 'current'
          ? `Built at current HEAD ${built}. Uncommitted changes are not claimed.`
          : `Built at ${built}; current HEAD could not be verified.`;
    const omitted = number(metadata.omittedNonStructuralEdgeCount);
    return `${staleRead}${revision}${
      omitted > 0 ? ` ${plural(omitted, 'inferred edge')} omitted.` : ''
    }`;
  }

  function showGraphStageState(message, isError = false) {
    const target = $('#graph-canvas-state');
    target.hidden = false;
    target.classList.toggle('is-error', isError);
    replace(target, [element('p', { text: message })]);
  }

  function hideGraphStageState() {
    const target = $('#graph-canvas-state');
    target.hidden = true;
    target.classList.remove('is-error');
  }

  function clearRenderedGraph(mode) {
    if (!graphRenderer || renderedGraphInput === null) return;
    graphRenderer.setGraph({
      source: mode === 'code' ? 'graphify' : 'memory',
      nodes: [],
      edges: []
    });
    renderedGraphInput = null;
  }

  function restoreGraphFocus(nodeId, focusScope) {
    if (!nodeId || !focusScope) return;
    const target = [...document.querySelectorAll('[data-graph-node-id]')].find(
      (candidate) =>
        candidate.dataset.graphNodeId === nodeId && candidate.dataset.graphFocusScope === focusScope
    );
    if (target) target.focus({ preventScroll: true });
  }

  function selectGraphNode(nodeId, focusCanvas = false, focusScope = null) {
    const mode = graphModeKey();
    const graph = activeGraphModel();
    const selected = GRAPH_VIEW.reconcileSelection(graph, nodeId);
    state.selectedGraphNodeIds[mode] = selected;
    if (selected && graphRenderer) {
      if (focusCanvas) graphRenderer.focusNode(selected, { notify: false });
      else graphRenderer.setSelection(selected, { notify: false });
    }
    renderMemory();
    restoreGraphFocus(selected, focusScope);
    const node = safeArray(safeObject(graph).nodes).find((candidate) => candidate.id === selected);
    if (node) announce(`${node.title || node.id} selected in the ${mode} graph.`);
  }

  function renderGraphResults(graph, query, selectedId) {
    const result = GRAPH_VIEW.search(graph, query, GRAPH_VIEW.MAX_SEARCH_RESULTS);
    const nodesById = new Map(safeArray(graph.nodes).map((node) => [node.id, node]));
    $('#graph-results-summary').textContent =
      result.total > result.items.length
        ? `${result.items.length} of ${result.total}`
        : plural(result.total, 'result');
    if (result.items.length === 0) {
      return replace($('#graph-nodes'), [
        stateMessage(query ? 'No graph nodes match that search.' : 'This graph has no nodes.')
      ]);
    }
    const list = element('div', { className: 'row-list' });
    result.items.forEach(({ id }) => {
      const node = nodesById.get(id);
      if (!node) return;
      const copy = element('span', { className: 'graph-node-copy' });
      copy.append(
        element('strong', { text: node.title || node.id }),
        element('span', {
          text: `${node.type || 'node'} · ${graphNodeLocation(node)}`
        })
      );
      const button = element('button', {
        className: `node-button${node.id === selectedId ? ' is-active' : ''}`,
        type: 'button',
        ariaPressed: node.id === selectedId
      });
      button.dataset.graphNodeId = node.id;
      button.dataset.graphFocusScope = 'results';
      button.append(copy, element('span', { className: 'row-aside', text: graphGroupLabel(node) }));
      button.addEventListener('click', () => selectGraphNode(node.id, true, 'results'));
      list.append(button);
    });
    replace($('#graph-nodes'), [list]);
  }

  function renderGraphInspector(graph, selectedId) {
    const nodes = safeArray(graph.nodes);
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const selected = nodesById.get(selectedId);
    if (!selected) {
      return replace($('#graph-neighbors'), [
        stateMessage('Choose a node to inspect its relationships.')
      ]);
    }

    const selectedSummary = element('div', { className: 'data-row' });
    selectedSummary.tabIndex = -1;
    selectedSummary.dataset.graphNodeId = selected.id;
    selectedSummary.dataset.graphFocusScope = 'inspector';
    const selectedCopy = element('div', { className: 'graph-node-copy' });
    selectedCopy.append(
      element('strong', { text: selected.title || selected.id }),
      element('span', {
        text: `${selected.type || 'node'} · ${graphNodeLocation(selected)} · ${graphGroupLabel(selected)}`
      })
    );
    selectedSummary.append(selectedCopy);

    const relations = GRAPH_VIEW.neighbors(graph, selected.id);
    if (relations.length === 0) {
      return replace($('#graph-neighbors'), [
        selectedSummary,
        stateMessage(`“${selected.title || selected.id}” has no linked neighbors in this graph.`)
      ]);
    }

    const list = element('div', { className: 'row-list' });
    relations.forEach((relation) => {
      const neighbor = nodesById.get(relation.id);
      if (!neighbor) return;
      const directions = [];
      if (relation.outbound.length)
        directions.push(`out: ${relation.outbound.map(label).join(', ')}`);
      if (relation.inbound.length) directions.push(`in: ${relation.inbound.map(label).join(', ')}`);
      const copy = element('span', { className: 'graph-node-copy' });
      copy.append(
        element('strong', { text: neighbor.title || neighbor.id }),
        element('span', { text: graphNodeLocation(neighbor) }),
        element('span', {
          className: 'graph-relation',
          text: directions.join(' · ') || 'related'
        })
      );
      const button = element('button', {
        className: 'node-button',
        type: 'button',
        ariaLabel: `Select ${neighbor.title || neighbor.id}`
      });
      button.dataset.graphNodeId = neighbor.id;
      button.dataset.graphFocusScope = 'inspector';
      button.append(
        copy,
        element('span', { className: 'row-aside', text: graphGroupLabel(neighbor) })
      );
      button.addEventListener('click', () => selectGraphNode(neighbor.id, true, 'inspector'));
      list.append(button);
    });
    replace($('#graph-neighbors'), [selectedSummary, list]);
  }

  function renderMemory() {
    const mode = graphModeKey();
    const source = graphSourceName();
    const sourceRecord = safeObject(state.sources[source]);
    const graph = activeGraphModel();
    const query = boundedLabel(state.graphQueries[mode]).trim().toLowerCase();

    document.querySelectorAll('[data-graph-source]').forEach((button) => {
      const active = button.dataset.graphSource === mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $('#graph-workspace-heading').textContent =
      mode === 'code' ? 'Harness code constellation' : 'Memory constellation';

    if (!graph) {
      clearRenderedGraph(mode);
      const unavailable = sourceRecord.status === 'unavailable';
      const message = unavailable
        ? sourceRecord.message || 'The optional harness code graph is unavailable.'
        : mode === 'code'
          ? 'Loading the bounded Graphify snapshot…'
          : 'Loading the validated Markdown graph…';
      $('#memory-stats').textContent = unavailable ? 'Unavailable' : 'Loading graph…';
      $('#graph-source-status').textContent = message;
      $('#graph-results-summary').textContent = unavailable ? 'Unavailable' : 'Waiting';
      replace($('#graph-nodes'), [stateMessage(message, unavailable ? 'error' : '')]);
      replace($('#graph-neighbors'), [
        stateMessage('Choose a node after this graph becomes available.')
      ]);
      showGraphStageState(message, unavailable);
      return;
    }

    state.selectedGraphNodeIds[mode] = GRAPH_VIEW.reconcileSelection(
      graph,
      state.selectedGraphNodeIds[mode]
    );
    const selectedId = state.selectedGraphNodeIds[mode];
    if (graphRenderer && renderedGraphInput !== graph) {
      graphRenderer.setGraph(graph);
      renderedGraphInput = graph;
    }
    if (graphRenderer) {
      graphRenderer.setSelection(selectedId, { notify: false });
      graphRenderer.setQuery(query);
    }

    const metadata = safeObject(graph.metadata);
    const renderedEdgeCount = safeArray(graph.edges).length;
    $('#memory-stats').textContent =
      `${plural(safeArray(graph.nodes).length, 'node')} · ${plural(renderedEdgeCount, 'edge')}`;
    $('#graph-source-status').textContent = graphRevisionSummary(graph, sourceRecord);
    if (safeArray(graph.nodes).length === 0) {
      showGraphStageState(
        mode === 'code'
          ? 'The Graphify snapshot contains no structural code nodes.'
          : 'The validated global Markdown graph is empty.'
      );
    } else {
      hideGraphStageState();
    }
    if (number(metadata.totalNodeCount) > safeArray(graph.nodes).length) {
      $('#memory-stats').textContent += ` · bounded from ${number(metadata.totalNodeCount)}`;
    }
    renderGraphResults(graph, query, selectedId);
    renderGraphInspector(graph, selectedId);
  }

  function revenueLane(name) {
    return safeObject(safeObject(safeObject(state.revenue).lanes)[name]);
  }

  function proposedPipelineMicrousd(offers) {
    return offers.reduce(
      (total, offer) => total + number(safeObject(safeObject(offer).quote).amountMicrousd),
      0
    );
  }

  function renderAgencyPipeline(agency) {
    const prospects = safeArray(agency.prospects);
    const offers = safeArray(agency.offers);
    const target = $('#agency-pipeline');
    const visibleProspects = prospects.slice(0, 8);
    $('#agency-pipeline-count').textContent = CORE.boundedListSummary(
      visibleProspects.length,
      number(safeObject(agency.counts).prospects),
      'prospect'
    );
    if (!prospects.length) {
      return replace(target, [
        stateMessage(
          'No pipeline records are loaded. The public-business acquisition pack can be imported locally without sending anything.'
        )
      ]);
    }

    const content = element('div', { className: 'pipeline-stack' });
    const prospectList = element('div', { className: 'row-list' });
    const presenter = safeObject(window.JarvisRevenueWidget);
    visibleProspects.forEach((prospect) => {
      const row = element('div', { className: 'data-row' });
      const main = element('div', { className: 'row-main' });
      const contactNote =
        typeof presenter.prospectContactNote === 'function'
          ? presenter.prospectContactNote(prospect)
          : prospect.hasContactReference === true
            ? ' · contact reference present (details withheld)'
            : '';
      main.append(
        element('strong', { text: prospect.publicLabel || prospect.id }),
        element('span', {
          text: `${label(prospect.need)} · ${label(prospect.contactChannel)}${contactNote}`
        })
      );
      row.append(
        main,
        element('span', {
          className: 'row-aside',
          text: label(prospect.status)
        })
      );
      prospectList.append(row);
    });
    content.append(prospectList);

    const offerSummary = element('section', { className: 'pipeline-summary' });
    offerSummary.append(
      element('p', { className: 'eyebrow', text: 'Proposed offers' }),
      element('strong', { text: microUsd(proposedPipelineMicrousd(offers)) }),
      element('span', {
        text: `${plural(offers.length, 'bounded offer')} · proposed only, not recognized revenue`
      })
    );
    content.append(offerSummary);
    replace(target, [content]);
  }

  function appendFacts(target, facts) {
    const list = element('dl', { className: 'fact-list growth-facts' });
    facts.forEach(([term, value]) => {
      list.append(element('dt', { text: term }), element('dd', { text: value }));
    });
    target.append(list);
  }

  function renderTaskMarketPipeline(taskMarket) {
    const target = $('#task-market-pipeline');
    const activation = safeObject(taskMarket.activation);
    const simulations = safeArray(taskMarket.simulations);
    const stateLabel = activation.state ? label(activation.state) : 'Not initialized';
    $('#task-market-state').textContent = stateLabel;
    if (!activation.state) {
      return replace(target, [
        stateMessage(
          'No task-market contract is loaded. Mainnet, wallets, and external payment remain unavailable.'
        )
      ]);
    }

    const content = element('div', { className: 'pipeline-stack' });
    const a2a = safeObject(activation.a2a);
    const x402 = safeObject(activation.x402);
    appendFacts(content, [
      ['Product', activation.productId || 'Unknown product'],
      ['A2A skill', a2a.skillId || 'Unknown skill'],
      ['Contract', String(activation.contractDigest || '').slice(0, 12) || 'Unavailable'],
      ['x402 quote', microUsd(safeObject(x402.quote).amountMicrousd)],
      ['Payment', label(x402.paymentMode || 'blocked')],
      ['Revenue', 'None recognized']
    ]);
    const evidence = element('div', { className: 'row-list' });
    simulations.slice(0, 6).forEach((simulation) => {
      const row = element('div', { className: 'data-row' });
      const main = element('div', { className: 'row-main' });
      main.append(
        element('strong', { text: label(simulation.scenario) }),
        element('span', {
          text: `Evidence ${String(simulation.evidenceDigest || '').slice(0, 12)}`
        })
      );
      row.append(
        main,
        element('span', {
          className: `row-aside ${CORE.statusClass('state', simulation.outcome)}`,
          text: label(simulation.outcome)
        })
      );
      evidence.append(row);
    });
    if (simulations.length) content.append(evidence);
    replace(target, [content]);
  }

  function renderGrowthNext(agency) {
    const prospects = safeArray(agency.prospects);
    const next =
      prospects.find((prospect) => prospect.status === 'qualified') ||
      prospects.find((prospect) => prospect.status === 'identified');
    const target = $('#growth-next');
    if (!next) {
      const empty = element('div', { className: 'growth-action-empty' });
      empty.append(
        stateMessage(
          'Import the public-business shortlist, choose one business, and verify its contact page before drafting one exact message.'
        ),
        element('a', {
          className: 'context-link',
          href: '/dashboard?view=queue&lane=agency',
          text: 'Inspect agency queue evidence'
        })
      );
      return replace(target, [empty]);
    }
    const callout = element('div', { className: 'why-now growth-action' });
    callout.append(
      element('p', { className: 'eyebrow', text: next.publicLabel || next.id }),
      element('strong', { text: 'Review one exact recipient and draft' }),
      element('p', {
        text: 'Reverify the public business page, confirm the channel rules, then approve at most one message. Jarvis cannot send it from this dashboard.'
      }),
      element('a', {
        className: 'context-link',
        href: '/dashboard?view=queue&lane=agency',
        text: 'Inspect agency queue evidence'
      })
    );
    replace(target, [callout]);
  }

  function renderGrowth() {
    if (!state.revenue) return;
    const agency = revenueLane('agency');
    const taskMarket = revenueLane('task_market');
    const agencyCounts = safeObject(agency.counts);
    const offers = safeArray(agency.offers);
    const drafts = safeArray(agency.outreachDrafts);
    const simulations = safeArray(taskMarket.simulations);
    const presenter = safeObject(window.JarvisRevenueWidget);
    const draftSummary = safeObject(
      typeof presenter.outreachReviewSummary === 'function'
        ? presenter.outreachReviewSummary(agency)
        : {
            readyForReview: drafts.filter((draft) => draft.status === 'review_ready').length,
            reviewed: drafts.filter((draft) => draft.status === 'reviewed').length,
            returned: drafts.length,
            total: number(agencyCounts.outreachDrafts)
          }
    );
    const passedSimulations = simulations.filter(({ outcome }) => outcome === 'pass').length;
    replace($('#growth-metrics'), [
      metricCard(
        'Agency prospects',
        number(agencyCounts.prospects),
        `${number(agencyCounts.offers)} proposed offers`
      ),
      metricCard(
        'Drafts ready for review',
        number(draftSummary.readyForReview),
        `${number(draftSummary.reviewed)} reviewed · ${number(draftSummary.returned)} bounded records returned of ${number(draftSummary.total)} total`
      ),
      metricCard(
        'Proposed pipeline',
        microUsd(proposedPipelineMicrousd(offers)),
        'Not recognized revenue'
      ),
      metricCard(
        'Task simulations',
        `${passedSimulations}/${simulations.length}`,
        'External payment blocked'
      )
    ]);
    renderAgencyPipeline(agency);
    renderTaskMarketPipeline(taskMarket);
    renderGrowthNext(agency);
  }

  function renderImprovements() {
    if (!state.overview) return;
    const proposals = safeArray(safeObject(safeObject(state.overview).improvements).proposals);
    const target = $('#improvements-list');
    if (!proposals.length)
      return replace(target, [
        stateMessage(
          'No ToolSmith proposals are ready. Repeated work must meet the configured threshold first.'
        )
      ]);
    const list = element('div', { className: 'proposal-list' });
    proposals.forEach((proposal) => {
      const card = element('article', { className: 'proposal-card' });
      const header = element('header');
      header.append(
        element('h3', { text: proposal.taskSignature || 'Repeated task' }),
        element('span', { className: 'status-badge neutral', text: 'Simulation only' })
      );
      const evidence = safeObject(safeObject(proposal.payload).evidence);
      const footer = element('div', { className: 'proposal-footer' });
      footer.append(
        element('span', { text: `${plural(number(proposal.executionCount), 'execution')}` }),
        element('span', { text: proposal.skill || '5-d-build' })
      );
      card.append(
        header,
        element('p', { text: safeObject(proposal.payload).objective || 'No objective supplied.' }),
        element('p', {
          text: `Last observed: ${date(evidence.lastExecutedAt)} · Manual interventions: ${number(evidence.manualInterventionCount)}`
        }),
        footer
      );
      list.append(card);
    });
    replace(target, [list]);
  }

  function jarvisRows(items, emptyMessage, describe) {
    if (!items.length) return stateMessage(emptyMessage);
    const list = element('div', { className: 'row-list' });
    items.forEach((item) => {
      const row = element('div', { className: 'data-row' });
      const main = element('div', { className: 'row-main' });
      const description = describe(item);
      main.append(
        element('strong', { text: description.title }),
        element('span', { text: description.detail })
      );
      row.append(main, element('span', { className: 'row-aside', text: description.aside || '' }));
      list.append(row);
    });
    return list;
  }

  function profiles() {
    return CORE.agentProfiles(state.agents);
  }

  function selectedAgentProfile() {
    return CORE.selectedAgentProfile(state.agents, state.selectedAgentId);
  }

  function selectedConversation() {
    return (
      state.agentConversations.find(
        (conversation) => conversation.id === state.selectedConversationId
      ) || null
    );
  }

  function setAgentLocation(agentId, conversationId) {
    const nextConversationId = conversationId || null;
    if (state.selectedAgentId !== agentId || state.selectedConversationId !== nextConversationId) {
      state.agentNavigationEpoch += 1;
    }
    state.selectedAgentId = agentId;
    state.selectedConversationId = nextConversationId;
  }

  function beginAgentMutation(agentId, conversationId) {
    state.agentMutationEpoch += 1;
    state.agentMutationAgentId = agentId;
    return Object.freeze({
      agentId,
      conversationId: conversationId || null,
      navigationEpoch: state.agentNavigationEpoch,
      mutationEpoch: state.agentMutationEpoch
    });
  }

  function agentMutationIsCurrent(token) {
    return CORE.agentMutationIsCurrent(token, {
      agentId: state.selectedAgentId,
      conversationId: state.selectedConversationId,
      navigationEpoch: state.agentNavigationEpoch,
      mutationEpoch: state.agentMutationEpoch
    });
  }

  function discardStaleAgentMutation() {
    state.agentNotice = 'A previous agent request finished after navigation and was discarded.';
    announce(state.agentNotice);
  }

  function updateAgentUrl(agentId, conversationId, mode) {
    const nextUrl = NAVIGATION.agentUrl(window.location.href, agentId, conversationId);
    if (nextUrl === window.location.href) return;
    window.history[mode === 'replace' ? 'replaceState' : 'pushState'](
      { view: 'chat', agent: agentId, conversation: conversationId || null },
      '',
      nextUrl
    );
  }

  function runtimeBadgeClass(runtime) {
    if (runtime.tone === 'blocked') return 'status-badge degraded';
    return runtime.tone === 'ready' ? 'status-badge' : 'status-badge neutral';
  }

  function currentModelRuntime() {
    return CORE.modelRuntimePresentation(state.modelRuntime);
  }

  function clearModelRuntimePoll() {
    if (state.modelRuntimePollTimer !== null) window.clearTimeout(state.modelRuntimePollTimer);
    state.modelRuntimePollTimer = null;
  }

  function renderModelRuntime() {
    const target = $('#model-runtime-providers');
    const badge = $('#model-runtime-badge');
    const disable = $('#model-runtime-disable');
    const status = $('#model-runtime-status');
    const source = safeObject(state.sources.modelRuntime);
    if (source.status === 'empty') {
      badge.textContent = 'Checking locally';
      badge.className = 'status-badge neutral';
      disable.hidden = true;
      status.textContent =
        state.modelRuntimeNotice ||
        'Connect locally, then explicitly choose the subscription Jarvis should use.';
      replace(target, [stateMessage('Checking redacted subscription status…')]);
      return;
    }
    if (source.status === 'unavailable') {
      badge.textContent = 'Connection status unavailable';
      badge.className = 'status-badge degraded';
      disable.hidden = true;
      status.textContent =
        state.modelRuntimeNotice ||
        'Subscription status could not be checked. Jarvis remains deterministic.';
      replace(target, [
        stateMessage(
          'Model connection status is unavailable. No account details were inferred.',
          'error'
        )
      ]);
      return;
    }

    const runtime = currentModelRuntime();
    const selected = runtime.providers.find((provider) => provider.selected);
    badge.textContent = selected ? `${selected.displayName} selected` : 'Deterministic fallback';
    badge.className = selected ? 'status-badge' : 'status-badge neutral';
    disable.hidden = !runtime.enabled;
    disable.disabled = state.modelRuntimeMutationPending;
    const cards = runtime.providers.map((provider) => {
      const card = element('article', {
        className: `model-provider-card${provider.selected ? ' is-selected' : ''}`
      });
      card.dataset.modelProvider = provider.provider;
      const heading = element('div', { className: 'model-provider-heading' });
      heading.append(element('h3', { text: provider.displayName }));
      if (provider.selected)
        heading.append(element('span', { className: 'status-badge', text: 'Selected' }));
      const connection = element('p', { className: 'model-provider-state' });
      connection.append(
        element('span', {
          className:
            provider.connectionState === 'connected'
              ? 'connection-dot is-connected'
              : 'connection-dot',
          text: provider.connectionLabel
        })
      );
      const detail = element('p', {
        className: 'model-provider-detail',
        text: provider.detail
      });
      const actions = element('div', { className: 'model-provider-actions' });
      if (provider.loginAvailable) {
        const login = element('button', {
          className: 'button button-secondary',
          type: 'button',
          text: provider.loginInProgress
            ? 'Waiting for login…'
            : provider.connected
              ? 'Reconnect'
              : 'Connect',
          disabled: state.modelRuntimeMutationPending || provider.loginInProgress
        });
        login.dataset.modelAction = 'login';
        login.dataset.modelProvider = provider.provider;
        actions.append(login);
      }
      if (provider.connected) {
        const select = element('button', {
          className: 'button',
          type: 'button',
          text: provider.selected ? 'In use' : `Use ${provider.displayName}`,
          disabled: state.modelRuntimeMutationPending || provider.selected
        });
        select.dataset.modelAction = 'select';
        select.dataset.modelProvider = provider.provider;
        actions.append(select);
      }
      card.append(heading, connection, detail, actions);
      return card;
    });
    replace(target, cards);
    status.textContent =
      state.modelRuntimeNotice ||
      (selected
        ? `Jarvis model replies use the selected ${selected.displayName} subscription.`
        : 'Jarvis is deterministic until you choose one connected subscription.');
  }

  async function reconcileModelRuntime() {
    const sequence = nextModelRuntimeLoadSequence();
    let settlement;
    try {
      settlement = {
        status: 'fulfilled',
        value: await request(SOURCE_ENDPOINTS.modelRuntime)
      };
    } catch (error) {
      settlement = { status: 'rejected', reason: error };
    }
    const applied = applySourceSettlement('modelRuntime', settlement, sequence);
    renderAll();
    if (applied.status === 'rejected') renderUnavailableSources(['modelRuntime']);
    return currentModelRuntime();
  }

  function scheduleModelRuntimePoll(provider, attemptsRemaining = MODEL_RUNTIME_POLL_ATTEMPTS) {
    clearModelRuntimePoll();
    if (!MODEL_PROVIDER_IDS.includes(provider) || attemptsRemaining <= 0) {
      state.modelRuntimeNotice =
        'Login is still pending. Finish in the browser, then refresh the dashboard.';
      announce(state.modelRuntimeNotice);
      renderModelRuntime();
      return;
    }
    state.modelRuntimePollTimer = window.setTimeout(async () => {
      state.modelRuntimePollTimer = null;
      try {
        const runtime = await reconcileModelRuntime();
        const providerState = runtime.providers.find(
          (candidate) => candidate.provider === provider
        );
        if (providerState?.connected) {
          state.modelRuntimeNotice = `${providerState.displayName} subscription connected.`;
          announce(state.modelRuntimeNotice);
          renderModelRuntime();
          return;
        }
      } catch (_error) {
        state.modelRuntimeNotice =
          'Connection status could not be refreshed. Jarvis will check again briefly.';
        announce(state.modelRuntimeNotice);
        renderModelRuntime();
      }
      scheduleModelRuntimePoll(provider, attemptsRemaining - 1);
    }, MODEL_RUNTIME_POLL_INTERVAL_MS);
  }

  async function loginModelProvider(provider) {
    if (!MODEL_PROVIDER_IDS.includes(provider) || state.modelRuntimeMutationPending) return;
    const runtime = currentModelRuntime();
    const providerState = runtime.providers.find((candidate) => candidate.provider === provider);
    if (!providerState?.loginAvailable) return;
    state.modelRuntimeMutationPending = true;
    state.modelRuntimeNotice = `Opening ${providerState.displayName} login…`;
    renderModelRuntime();
    try {
      await request(`/model-runtime/providers/${encodeURIComponent(provider)}/login`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      state.modelRuntimeNotice = `${providerState.displayName} login opened. Finish in the browser while Jarvis checks the connection.`;
      announce(state.modelRuntimeNotice);
      const reconciled = await reconcileModelRuntime();
      const reconciledProvider = reconciled.providers.find(
        (candidate) => candidate.provider === provider
      );
      if (reconciledProvider?.connected) {
        clearModelRuntimePoll();
        state.modelRuntimeNotice = `${reconciledProvider.displayName} subscription connected.`;
        announce(state.modelRuntimeNotice);
      } else scheduleModelRuntimePoll(provider);
    } catch (error) {
      state.modelRuntimeNotice =
        error.message || `${providerState.displayName} login could not be started.`;
      await reconcileModelRuntime();
      announce(state.modelRuntimeNotice);
    } finally {
      state.modelRuntimeMutationPending = false;
      renderModelRuntime();
    }
  }

  async function selectModelProvider(provider) {
    if (!MODEL_PROVIDER_IDS.includes(provider) || state.modelRuntimeMutationPending) return;
    const runtime = currentModelRuntime();
    const providerState = runtime.providers.find((candidate) => candidate.provider === provider);
    if (!providerState?.connected || providerState.selected) return;
    state.modelRuntimeMutationPending = true;
    state.modelRuntimeNotice = `Selecting ${providerState.displayName} for Jarvis…`;
    renderModelRuntime();
    try {
      await request('/model-runtime/select', {
        method: 'POST',
        body: JSON.stringify({ provider, expectedVersion: runtime.version })
      });
      await reconcileModelRuntime();
      state.modelRuntimeNotice = `${providerState.displayName} subscription selected for Jarvis.`;
      announce(state.modelRuntimeNotice);
    } catch (error) {
      state.modelRuntimeNotice =
        error.message || `${providerState.displayName} could not be selected.`;
      await reconcileModelRuntime();
      announce(state.modelRuntimeNotice);
    } finally {
      state.modelRuntimeMutationPending = false;
      renderAll();
    }
  }

  async function disableModelRuntime() {
    if (state.modelRuntimeMutationPending) return;
    const runtime = currentModelRuntime();
    if (!runtime.enabled) return;
    state.modelRuntimeMutationPending = true;
    state.modelRuntimeNotice = 'Switching Jarvis to deterministic mode…';
    renderModelRuntime();
    try {
      await request('/model-runtime/disable', {
        method: 'POST',
        body: JSON.stringify({ expectedVersion: runtime.version })
      });
      await reconcileModelRuntime();
      state.modelRuntimeNotice = 'Subscription routing disabled. Jarvis is deterministic.';
      announce(state.modelRuntimeNotice);
    } catch (error) {
      state.modelRuntimeNotice = error.message || 'Model routing could not be disabled.';
      await reconcileModelRuntime();
      announce(state.modelRuntimeNotice);
    } finally {
      state.modelRuntimeMutationPending = false;
      renderAll();
    }
  }

  function handleModelRuntimeAction(event) {
    const button = event.target.closest('button[data-model-action][data-model-provider]');
    if (!button) return;
    const provider = button.dataset.modelProvider;
    if (!MODEL_PROVIDER_IDS.includes(provider)) return;
    if (button.dataset.modelAction === 'login') void loginModelProvider(provider);
    else if (button.dataset.modelAction === 'select') void selectModelProvider(provider);
  }

  function expandAgentAncestors(agentId) {
    const rows = CORE.agentTreeRows(state.agents);
    const byId = new Map(rows.map((row) => [row.id, row]));
    let current = byId.get(agentId);
    while (current && current.parentId) {
      state.expandedAgentIds.add(current.parentId);
      current = byId.get(current.parentId);
    }
  }

  function visibleAgentRows() {
    const rows = CORE.agentTreeRows(state.agents);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return rows.filter((row) => {
      let parentId = row.parentId;
      while (parentId) {
        if (!state.expandedAgentIds.has(parentId)) return false;
        parentId = byId.get(parentId)?.parentId || null;
      }
      return true;
    });
  }

  function toggleAgentExpansion(agentId) {
    if (state.expandedAgentIds.has(agentId)) state.expandedAgentIds.delete(agentId);
    else state.expandedAgentIds.add(agentId);
  }

  function makeAgentTreeItem(row, mode) {
    const profile = profiles().find((candidate) => candidate.id === row.id);
    const runtime = CORE.agentRuntimePresentation(profile, state.modelRuntime);
    const disclosure =
      mode !== 'floor' && row.hasChildren ? (state.expandedAgentIds.has(row.id) ? '▾ ' : '▸ ') : '';
    const prefix = row.depth > 0 ? `${'· '.repeat(row.depth)}` : '';
    const item = element(mode === 'floor' ? 'a' : 'button', {
      className: `topology-node${row.id === state.selectedAgentId ? ' is-selected' : ''}`,
      ...(mode === 'floor'
        ? { href: NAVIGATION.agentUrl(window.location.href, row.id, null) }
        : { type: 'button' })
    });
    item.dataset.agentId = row.id;
    item.dataset.parentId = row.parentId || '';
    if (mode !== 'floor') {
      item.setAttribute('role', 'treeitem');
      item.setAttribute('aria-level', String(row.depth + 1));
      item.setAttribute('aria-selected', String(row.id === state.selectedAgentId));
      if (row.hasChildren)
        item.setAttribute('aria-expanded', String(state.expandedAgentIds.has(row.id)));
      item.tabIndex = row.id === state.focusedAgentId ? 0 : -1;
    }
    item.append(
      element('span', {
        className: 'topology-index',
        text: `${prefix}${disclosure}${row.trustDomain}`
      }),
      element('strong', { text: row.displayName }),
      element('small', { text: `${row.role} · ${runtime.label}` })
    );
    if (mode !== 'floor')
      item.addEventListener('click', () => {
        state.focusedAgentId = row.id;
        if (row.hasChildren) toggleAgentExpansion(row.id);
        if (row.id === state.selectedAgentId) {
          renderAgentTree();
          focusRenderedAgentTreeItem(row.id);
          return;
        }
        selectAgent(row.id, { updateHistory: true });
        focusRenderedAgentTreeItem(row.id);
      });
    return item;
  }

  function focusRenderedAgentTreeItem(agentId) {
    const target = $('#agent-tree');
    const item = [...target.querySelectorAll('[role="treeitem"]')].find(
      (candidate) => candidate.dataset.agentId === agentId
    );
    if (!item) return;
    state.focusedAgentId = agentId;
    target.querySelectorAll('[role="treeitem"]').forEach((candidate) => {
      candidate.tabIndex = candidate === item ? 0 : -1;
    });
    item.focus({ preventScroll: true });
    item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function handleAgentTreeKeydown(event) {
    const target = $('#agent-tree');
    const current = event.target.closest('[role="treeitem"]');
    if (!current || !target.contains(current)) return;
    const items = [...target.querySelectorAll('[role="treeitem"]')];
    const index = items.indexOf(current);
    let destination = null;
    if (event.key === 'ArrowDown') destination = items[Math.min(index + 1, items.length - 1)];
    else if (event.key === 'ArrowUp') destination = items[Math.max(index - 1, 0)];
    else if (event.key === 'Home') destination = items[0];
    else if (event.key === 'End') destination = items[items.length - 1];
    else if (event.key === 'ArrowRight' && current.hasAttribute('aria-expanded')) {
      if (current.getAttribute('aria-expanded') === 'false') {
        state.expandedAgentIds.add(current.dataset.agentId);
        renderAgentTree();
        destination = [...target.querySelectorAll('[role="treeitem"]')].find(
          (item) => item.dataset.agentId === current.dataset.agentId
        );
      } else {
        destination = items
          .slice(index + 1)
          .find((item) => item.dataset.parentId === current.dataset.agentId);
      }
    } else if (event.key === 'ArrowLeft') {
      if (current.getAttribute('aria-expanded') === 'true') {
        state.expandedAgentIds.delete(current.dataset.agentId);
        renderAgentTree();
        destination = [...target.querySelectorAll('[role="treeitem"]')].find(
          (item) => item.dataset.agentId === current.dataset.agentId
        );
      } else if (current.dataset.parentId) {
        destination = items.find((item) => item.dataset.agentId === current.dataset.parentId);
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      current.click();
      return;
    } else return;
    event.preventDefault();
    if (destination) focusRenderedAgentTreeItem(destination.dataset.agentId);
  }

  function renderAgentTree() {
    const target = $('#agent-tree');
    const focusedBeforeRender = target.contains(document.activeElement)
      ? document.activeElement.dataset.agentId
      : null;
    if (!state.agents) {
      replace(target, [stateMessage('Loading the bounded agent hierarchy…')]);
      return;
    }
    const allRows = CORE.agentTreeRows(state.agents);
    const rows = visibleAgentRows();
    if (!rows.length) {
      replace(target, [stateMessage('No validated agent profiles are available.', 'error')]);
      return;
    }
    if (!rows.some((row) => row.id === state.focusedAgentId)) {
      state.focusedAgentId = rows.some((row) => row.id === state.selectedAgentId)
        ? state.selectedAgentId
        : rows[0].id;
    }
    target.setAttribute('role', 'tree');
    target.setAttribute('aria-label', 'Jarvis agent hierarchy');
    const countPill = target.closest('.agent-explorer-section')?.querySelector('.count-pill');
    if (countPill) {
      const profile = selectedAgentProfile();
      countPill.textContent = profile ? profile.displayName : 'No selection';
      countPill.setAttribute(
        'aria-label',
        `${rows.length} of ${allRows.length} agents visible; ${profile ? profile.displayName : 'none'} selected`
      );
    }
    target.onkeydown = handleAgentTreeKeydown;
    replace(
      target,
      rows.map((row) => makeAgentTreeItem(row, 'workbench'))
    );
    if (focusedBeforeRender && rows.some((row) => row.id === focusedBeforeRender)) {
      focusRenderedAgentTreeItem(focusedBeforeRender);
    }
  }

  function renderAgentFloor() {
    const tree = $('#agent-floor-tree');
    const registry = $('#agent-floor-registry');
    if (!tree || !registry) return;
    if (!state.agents) {
      replace(tree, [stateMessage('Loading the bounded agent hierarchy…')]);
      replace(registry, [stateMessage('Loading registered profiles…')]);
      return;
    }
    const rows = CORE.durableAgentRows(state.agents);
    const floorItems = rows.map((row) => makeAgentTreeItem(row, 'floor'));
    $('#agent-registry-disclosure-count').textContent = plural(profiles().length, 'profile');
    tree.removeAttribute('role');
    if (floorItems.length) {
      floorItems[0].classList.add('topology-root');
      const branches = element('div', { className: 'topology-branches' });
      branches.append(...floorItems.slice(1));
      replace(tree, [floorItems[0], branches]);
    } else replace(tree, [stateMessage('No validated agent profiles are available.', 'error')]);

    const heading = element('div', { className: 'agent-row agent-table-head' });
    heading.setAttribute('role', 'row');
    ['Agent', 'Purpose', 'Sleeve', 'Runtime'].forEach((text) => {
      const cell = element('span', { text });
      cell.setAttribute('role', 'columnheader');
      heading.append(cell);
    });
    const registryRows = profiles().map((profile) => {
      const row = element('div', { className: 'agent-row' });
      row.setAttribute('role', 'row');
      const nameCell = element('span');
      nameCell.setAttribute('role', 'cell');
      nameCell.append(
        element('a', {
          className: 'context-link',
          href: NAVIGATION.agentUrl(window.location.href, profile.id, null),
          text: profile.displayName || subject(profile.id)
        })
      );
      const purpose = element('span', { text: profile.role || 'Agent profile' });
      purpose.setAttribute('role', 'cell');
      const sleeve = element('span', { text: label(profile.trustDomain) });
      sleeve.setAttribute('role', 'cell');
      const runtime = element('span', {
        className: 'agent-state',
        text: CORE.agentRuntimePresentation(profile, state.modelRuntime).label
      });
      runtime.setAttribute('role', 'cell');
      row.append(nameCell, purpose, sleeve, runtime);
      return row;
    });
    replace(registry, [heading, ...registryRows]);
  }

  function renderAgentConversations() {
    const target = $('#agent-conversation-list');
    const profile = selectedAgentProfile();
    const heading = $('#agent-conversations-heading');
    if (heading) heading.textContent = `${profile ? profile.displayName : 'Agent'} chats`;
    if (state.agentConversationLoading) {
      replace(target, [stateMessage('Loading exact-agent conversations…')]);
      return;
    }
    if (state.agentConversationError) {
      replace(target, [stateMessage(state.agentConversationError, 'error')]);
      return;
    }
    if (!profile) {
      replace(target, [stateMessage('The agent catalog is unavailable.', 'error')]);
      return;
    }
    if (!state.agentConversations.length) {
      replace(target, [stateMessage(`No conversations with ${profile.displayName} yet.`)]);
      return;
    }
    const items = state.agentConversations.map((conversation) => {
      const link = element('a', {
        className: `topology-node${conversation.id === state.selectedConversationId ? ' is-selected' : ''}`,
        href: NAVIGATION.agentUrl(window.location.href, profile.id, conversation.id)
      });
      if (conversation.id === state.selectedConversationId)
        link.setAttribute('aria-current', 'page');
      link.append(
        element('strong', { text: conversation.title || 'Untitled conversation' }),
        element('small', {
          text: `Version ${number(conversation.version)} · ${date(conversation.updatedAt)}`
        })
      );
      link.addEventListener('click', (event) => {
        if (
          !CORE.shouldHandleNavigation({
            defaultPrevented: event.defaultPrevented,
            button: event.button,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey
          })
        )
          return;
        event.preventDefault();
        selectConversation(conversation.id, { updateHistory: true });
      });
      return link;
    });
    replace(target, items);
  }

  function profileFact(term, description) {
    const row = element('div');
    row.append(element('dt', { text: term }), element('dd', { text: description }));
    return row;
  }

  function renderAgentProfile() {
    const target = $('#agent-profile-inspector');
    const profile = selectedAgentProfile();
    if (!profile) {
      replace(target, [
        element('p', { className: 'eyebrow', text: 'Selected agent' }),
        element('h2', { id: 'agent-profile-heading', text: 'Profile unavailable' }),
        stateMessage('The server-owned agent catalog could not be loaded.', 'error')
      ]);
      return;
    }
    const runtime = CORE.agentRuntimePresentation(profile, state.modelRuntime);
    const memory = safeObject(profile.memory);
    const knowledge = safeObject(profile.knowledge);
    const continuation = safeObject(profile.continuation);
    const stages = safeArray(continuation.stages);
    const checkpoint = safeObject(continuation.checkpoint);
    const resume = safeObject(continuation.resume);
    const escalation = safeObject(continuation.escalation);
    const budgets = safeObject(continuation.budgets);
    const identityFacts = element('dl', { className: 'boundary-list' });
    identityFacts.append(
      profileFact('Role', profile.role || 'Agent profile'),
      profileFact('Purpose', profile.purpose || 'No purpose supplied.'),
      profileFact('Scope', `${label(profile.trustDomain)} · ${label(profile.lifecycle)}`),
      profileFact('Runtime', runtime.label)
    );
    const memoryFacts = element('dl', { className: 'boundary-list' });
    memoryFacts.append(
      profileFact('Scratch sleeve', memory.scratchSleeveId || 'Not declared'),
      profileFact(
        'Readable sleeves',
        safeArray(memory.readableSleeveIds).join(' · ') || 'None declared'
      ),
      profileFact(
        'Propose-write sleeves',
        safeArray(memory.proposeWritableSleeveIds).join(' · ') || 'None'
      ),
      profileFact(
        'Knowledge',
        knowledge.scopeId && knowledge.partitionId
          ? `${knowledge.scopeId} · ${knowledge.partitionId} · ${label(knowledge.projection)} · max ${number(knowledge.maxResults)} results`
          : 'No knowledge scope declared'
      )
    );
    const continuationFacts = element('dl', { className: 'boundary-list' });
    continuationFacts.append(
      profileFact(
        'Stages',
        stages.length ? stages.map((stage) => stage.label || stage.id).join(' → ') : 'Not declared'
      ),
      profileFact(
        'Checkpoint',
        `${label(checkpoint.trigger)} · requires ${safeArray(checkpoint.requiredFields).join(', ') || 'no declared fields'} · excludes ${safeArray(checkpoint.excludedFields).join(', ') || 'no declared fields'}`
      ),
      profileFact(
        'Resume',
        `${label(resume.onUncertainty)} · ${safeArray(resume.requirements).join(' · ') || 'No requirements declared'}`
      ),
      profileFact(
        'Escalation',
        `${escalation.target || 'operator'} · ${safeArray(escalation.conditions).join(' · ') || 'No conditions declared'}`
      ),
      profileFact(
        'Budgets',
        `${number(budgets.maxTurns)} turns · ${number(budgets.maxToolCalls)} tools · ${number(budgets.maxDurationSeconds)}s · ${number(budgets.maxEstimatedTokens)} tokens · ${number(budgets.maxChildRuns)} child runs`
      )
    );
    const memorySection = element('section');
    memorySection.append(element('h3', { text: 'Memory and knowledge' }), memoryFacts);
    const continuationSection = element('section');
    continuationSection.append(element('h3', { text: 'Continuation contract' }), continuationFacts);
    const tools = safeArray(profile.toolGrants);
    const toolSection = element('section');
    toolSection.append(
      element('h3', { text: 'Fixed tool grants' }),
      jarvisRows(tools, 'No tool grants are declared.', (tool) => ({
        title: tool.id || 'Tool grant',
        detail: tool.purpose || 'No purpose supplied.',
        aside: label(tool.access)
      }))
    );
    replace(target, [
      element('p', { className: 'eyebrow', text: 'Selected agent' }),
      element('h2', {
        id: 'agent-profile-heading',
        text: `${profile.displayName || subject(profile.id)} profile`
      }),
      element('p', { className: 'boundary-note', text: runtime.detail }),
      identityFacts,
      memorySection,
      continuationSection,
      toolSection
    ]);
  }

  function renderAgentMessages() {
    const transcript = $('#chat-transcript');
    const profile = selectedAgentProfile();
    const conversation = selectedConversation();
    if (state.agentMessageLoading) {
      replace(transcript, [stateMessage('Loading the exact conversation transcript…')]);
      return;
    }
    if (state.agentMessageError) {
      replace(transcript, [stateMessage(state.agentMessageError, 'error')]);
      return;
    }
    if (!conversation) {
      replace(transcript, [
        stateMessage(
          profile
            ? `Start a new conversation with ${profile.displayName}, or select a saved chat.`
            : 'Select a validated agent profile to begin.'
        )
      ]);
      return;
    }
    if (!state.agentMessages.length) {
      replace(transcript, [
        stateMessage(`This conversation is empty. Message ${profile.displayName} directly.`)
      ]);
      return;
    }
    const messages = state.agentMessages.map((message) => {
      const operator = message.authorKind === 'operator';
      const item = element('article', {
        className: `chat-message ${operator ? 'chat-operator' : 'chat-agent'}`
      });
      item.append(
        element('span', {
          className: 'chat-author',
          text: operator ? 'You' : profile.displayName || message.respondingAgentId
        })
      );
      String(message.text)
        .split(/\n{2,}/u)
        .filter(Boolean)
        .forEach((paragraph) => item.append(element('p', { text: paragraph })));
      if (!operator) {
        const mode = label(message.responseMode);
        item.append(
          element('span', {
            className:
              message.responseMode === 'runtime_not_configured'
                ? 'status-badge degraded'
                : 'status-badge neutral',
            text:
              message.responseMode === 'runtime_not_configured'
                ? 'Runtime not configured · no work performed'
                : `${mode} response · ${message.respondingAgentId}`
          })
        );
      }
      if (safeArray(message.evidenceRefs).length)
        item.append(
          element('p', {
            className: 'chat-evidence',
            text: `Evidence: ${message.evidenceRefs.join(' · ')}`
          })
        );
      return item;
    });
    replace(transcript, messages);
    transcript.scrollTop = transcript.scrollHeight;
  }

  function renderAgentHeader() {
    const profile = selectedAgentProfile();
    const runtime = CORE.agentRuntimePresentation(profile, state.modelRuntime);
    const breadcrumb = profile ? CORE.agentBreadcrumb(state.agents, profile.id) : [];
    $('#agent-chat-heading').textContent = profile ? profile.displayName : 'Agent unavailable';
    $('.agent-breadcrumb').textContent = breadcrumb.length
      ? breadcrumb.join(' / ')
      : 'No validated selection';
    $('.agent-chat-header .eyebrow').textContent = profile
      ? `${label(profile.trustDomain)} scope · ${profile.role}`
      : 'Validated agent profile unavailable';
    const badge = $('#agent-runtime-badge');
    badge.textContent = runtime.label;
    badge.className = runtimeBadgeClass(runtime);
    const labelNode = document.querySelector('label[for="chat-message"]');
    labelNode.textContent = `Message ${profile ? profile.displayName : 'agent'} directly`;
    $('#chat-target-boundary').textContent = profile
      ? `Target: ${profile.displayName} · ${label(profile.trustDomain)} scope resolved by server profile`
      : 'No exact agent target is available.';
    const disabled = !profile || !runtime.canMessage || state.agentMutationPending;
    $('#chat-message').disabled = disabled;
    $('#chat-send').disabled = disabled;
    $('#agent-new-conversation').disabled = disabled;
    $('#chat-transcript').setAttribute('aria-busy', String(state.agentMutationPending));
    $('#chat-send').textContent = state.agentMutationPending ? 'Sending…' : 'Send';
    $('#chat-message').placeholder = profile
      ? `Message ${profile.displayName} about its purpose, scope, tools, continuation, or bounded work…`
      : 'Agent catalog unavailable';
    const status = $('#chat-status');
    if (state.agentMutationPending)
      status.textContent =
        profile && state.agentMutationAgentId === profile.id
          ? `${profile.displayName} is responding…`
          : 'Previous agent request is finishing; this selection remains isolated.';
    else if (state.agentNotice) status.textContent = state.agentNotice;
    else if (!runtime.canMessage) status.textContent = runtime.detail;
    else if (!state.selectedConversationId)
      status.textContent = 'Sending the first message will create a persisted exact-agent chat.';
    else status.textContent = runtime.detail;
    if (selectedViewDefinition().id === 'chat') renderActiveScope('chat');
  }

  function renderChat() {
    renderAgentHeader();
    renderAgentTree();
    renderAgentConversations();
    renderAgentMessages();
    renderAgentProfile();
  }

  async function loadAgentMessages(agentId, conversationId) {
    const sequence = ++state.agentLoadSequence;
    state.agentMessageLoading = true;
    state.agentMessageError = null;
    state.agentMessages = [];
    renderChat();
    try {
      const response = await request(
        `/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}/messages`
      );
      if (
        sequence !== state.agentLoadSequence ||
        agentId !== state.selectedAgentId ||
        conversationId !== state.selectedConversationId
      )
        return;
      state.agentMessages = CORE.scopedAgentMessages(response, agentId, conversationId);
    } catch (error) {
      if (sequence !== state.agentLoadSequence) return;
      state.agentMessageError = error.message || 'Could not load this exact-agent transcript.';
    } finally {
      if (sequence === state.agentLoadSequence) {
        state.agentMessageLoading = false;
        renderChat();
      }
    }
  }

  async function loadAgentConversations(agentId, options = {}) {
    const sequence = ++state.agentLoadSequence;
    let conversationToLoad = null;
    state.agentConversationLoading = true;
    state.agentConversationError = null;
    state.agentMessageError = null;
    state.agentConversations = [];
    state.agentMessages = [];
    setAgentLocation(agentId, null);
    renderChat();
    try {
      const response = await request(`/agents/${encodeURIComponent(agentId)}/conversations`);
      if (sequence !== state.agentLoadSequence || agentId !== state.selectedAgentId) return;
      state.agentConversations = CORE.scopedAgentConversations(response, agentId);
      const restored = NAVIGATION.selectedConversationId(
        window.location.href,
        state.agentConversations
      );
      setAgentLocation(agentId, restored || state.agentConversations[0]?.id || null);
      if (NAVIGATION.viewFromUrl(window.location.href) === 'chat' && options.canonicalize !== false)
        updateAgentUrl(agentId, state.selectedConversationId, 'replace');
      conversationToLoad = state.selectedConversationId;
    } catch (error) {
      if (sequence !== state.agentLoadSequence) return;
      state.agentConversationError =
        error.message || 'Could not load conversations for the selected agent.';
    } finally {
      if (sequence === state.agentLoadSequence) {
        state.agentConversationLoading = false;
        renderChat();
      }
    }
    if (
      conversationToLoad &&
      agentId === state.selectedAgentId &&
      conversationToLoad === state.selectedConversationId
    )
      void loadAgentMessages(agentId, conversationToLoad);
  }

  async function restoreAgentSelectionFromUrl() {
    if (!state.agents) return;
    const selected = NAVIGATION.selectedAgentId(window.location.href, profiles());
    const restoredConversation = NAVIGATION.selectedConversationId(
      window.location.href,
      state.agentConversations
    );
    const selectionAlreadyLoaded =
      selected === state.selectedAgentId &&
      state.agentConversations.length > 0 &&
      restoredConversation === state.selectedConversationId;
    if (
      selectionAlreadyLoaded ||
      (state.agentMutationPending && selected === state.selectedAgentId)
    ) {
      expandAgentAncestors(selected);
      renderChat();
      return;
    }
    setAgentLocation(selected, null);
    state.focusedAgentId = selected;
    expandAgentAncestors(selected);
    state.agentNotice = null;
    renderChat();
    await loadAgentConversations(selected);
  }

  function selectAgent(agentId, options = {}) {
    const profile = CORE.selectedAgentProfile(state.agents, agentId);
    if (!profile || profile.id !== agentId) return;
    setAgentLocation(profile.id, null);
    state.focusedAgentId = profile.id;
    expandAgentAncestors(profile.id);
    state.agentConversations = [];
    state.agentMessages = [];
    state.agentConversationError = null;
    state.agentMessageError = null;
    state.agentNotice = null;
    if (options.updateHistory) updateAgentUrl(profile.id, null, 'push');
    renderChat();
    void loadAgentConversations(profile.id);
  }

  function selectConversation(conversationId, options = {}) {
    const conversation = state.agentConversations.find(
      (candidate) => candidate.id === conversationId
    );
    if (!conversation) return;
    setAgentLocation(state.selectedAgentId, conversation.id);
    state.agentMessages = [];
    state.agentMessageError = null;
    state.agentNotice = null;
    if (options.updateHistory) updateAgentUrl(state.selectedAgentId, conversation.id, 'push');
    renderChat();
    if (options.updateHistory) $('#agent-chat-heading').focus({ preventScroll: true });
    void loadAgentMessages(state.selectedAgentId, conversation.id);
  }

  async function createAgentConversation(title) {
    const profile = selectedAgentProfile();
    const runtime = CORE.agentRuntimePresentation(profile, state.modelRuntime);
    if (!profile || !runtime.canMessage) return null;
    const ownedPending = !state.agentMutationPending;
    if (ownedPending) state.agentMutationPending = true;
    const mutation = beginAgentMutation(profile.id, state.selectedConversationId);
    state.agentNotice = null;
    renderChat();
    try {
      const response = safeObject(
        await request(`/agents/${encodeURIComponent(profile.id)}/conversations`, {
          method: 'POST',
          body: JSON.stringify(title ? { title } : {})
        })
      );
      const created = CORE.scopedAgentConversations(
        { conversations: [safeObject(response.conversation)] },
        profile.id
      )[0];
      if (!created) throw new Error('The created conversation did not match the selected agent.');
      if (!agentMutationIsCurrent(mutation)) {
        discardStaleAgentMutation();
        return null;
      }
      state.agentConversations = CORE.scopedAgentConversations(
        { conversations: [created, ...state.agentConversations] },
        profile.id
      );
      setAgentLocation(profile.id, created.id);
      state.agentMessages = [];
      state.agentNotice = `New persisted conversation with ${profile.displayName}.`;
      updateAgentUrl(profile.id, created.id, 'push');
      return created;
    } catch (error) {
      if (!agentMutationIsCurrent(mutation)) {
        discardStaleAgentMutation();
        return null;
      }
      state.agentNotice = error.message || 'Could not create this exact-agent conversation.';
      announce(state.agentNotice);
      return null;
    } finally {
      if (ownedPending) {
        state.agentMutationPending = false;
        if (mutation.mutationEpoch === state.agentMutationEpoch) state.agentMutationAgentId = null;
      }
      renderChat();
    }
  }

  async function sendChat(event) {
    event.preventDefault();
    const input = $('#chat-message');
    const profile = selectedAgentProfile();
    const runtime = CORE.agentRuntimePresentation(profile, state.modelRuntime);
    const message = input.value.trim();
    if (!profile || !runtime.canMessage) {
      state.agentNotice = 'The selected profile cannot accept messages.';
      renderChat();
      return;
    }
    if (!message) {
      state.agentNotice = `Enter a message for ${profile.displayName}.`;
      renderChat();
      return;
    }
    state.agentMutationPending = true;
    state.agentMutationAgentId = profile.id;
    state.agentNotice = null;
    let mutation = null;
    renderChat();
    try {
      let conversation = selectedConversation();
      if (!conversation) conversation = await createAgentConversation(message.slice(0, 120));
      if (!conversation) return;
      mutation = beginAgentMutation(profile.id, conversation.id);
      const response = safeObject(
        await request(
          `/agents/${encodeURIComponent(profile.id)}/conversations/${encodeURIComponent(conversation.id)}/messages`,
          {
            method: 'POST',
            body: JSON.stringify({ message, expectedVersion: conversation.version })
          },
          MODEL_CHAT_TIMEOUT_MS
        )
      );
      if (!agentMutationIsCurrent(mutation)) {
        discardStaleAgentMutation();
        return;
      }
      const updated = CORE.scopedAgentConversations(
        { conversations: [safeObject(response.conversation), ...state.agentConversations] },
        profile.id
      );
      state.agentConversations = updated;
      state.agentMessages = CORE.scopedAgentMessages(
        { messages: [...state.agentMessages, ...safeArray(response.messages)] },
        profile.id,
        conversation.id
      );
      const reply = safeObject(response.reply);
      state.agentNotice =
        reply.responseMode === 'runtime_not_configured'
          ? `${profile.displayName} did not run work; its execution runtime is not configured.`
          : `${profile.displayName} replied as ${reply.respondingAgentId || profile.id}.`;
      input.value = '';
      announce(`${profile.displayName} replied.`);
    } catch (error) {
      if (mutation && !agentMutationIsCurrent(mutation)) {
        discardStaleAgentMutation();
        return;
      }
      state.agentNotice =
        error.message || `${profile.displayName} could not complete this message.`;
      announce(state.agentNotice);
      if (
        error.code === 'DASHBOARD_AGENT_CONVERSATION_VERSION_CONFLICT' &&
        profile.id === state.selectedAgentId
      )
        void loadAgentConversations(profile.id);
    } finally {
      state.agentMutationPending = false;
      if (!mutation || mutation.mutationEpoch === state.agentMutationEpoch)
        state.agentMutationAgentId = null;
      renderChat();
      if (mutation && agentMutationIsCurrent(mutation)) input.focus();
    }
  }

  function renderPersonalJarvis() {
    if (!state.personal) return;
    const personal = safeObject(state.personal);
    const briefing = safeObject(personal.briefing);
    const calendar = safeObject(personal.calendar);
    const memory = safeObject(personal.memory);
    const availability = safeObject(personal.availability);
    const briefingAvailable = availability.briefing !== 'unavailable';
    const calendarAvailable = availability.calendar !== 'unavailable';
    const memoryRecordsAvailable = availability.memoryRecords !== 'unavailable';
    const memoryReviewsAvailable = availability.memoryReviews !== 'unavailable';
    const events = safeArray(calendar.events);
    const conflicts = safeArray(calendar.conflicts);
    const reviews = safeArray(memory.reviewDue);
    const records = safeArray(memory.records);
    $('#today-headline').textContent =
      briefing.headline || 'Your deterministic daily briefing is ready.';
    $('#calendar-mode').textContent =
      personal.calendarMode === 'provider' ? 'Connected calendar' : 'Local demo calendar';
    $('#calendar-provider-status').textContent =
      personal.calendarMode === 'provider' ? 'Provider connected' : 'Local demo · writes gated';
    replace($('#today-metrics'), [
      metricCard(
        'Events',
        briefingAvailable ? number(briefing.eventCount) : 'Unavailable',
        briefingAvailable ? 'Bounded to today' : 'Briefing source unavailable'
      ),
      metricCard(
        'Conflicts',
        briefingAvailable ? number(briefing.conflictCount) : 'Unavailable',
        briefingAvailable ? 'Overlapping intervals' : 'Briefing source unavailable'
      ),
      metricCard(
        'Memory reviews',
        briefingAvailable ? number(briefing.memoryReviewCount) : 'Unavailable',
        briefingAvailable ? 'Private and inspectable' : 'Briefing source unavailable'
      ),
      metricCard(
        'Agency approvals',
        briefingAvailable ? number(briefing.agencyApprovalCount) : 'Unavailable',
        briefingAvailable ? 'External effects stay gated' : 'Briefing source unavailable'
      )
    ]);
    const eventRows = calendarAvailable
      ? jarvisRows(events.slice(0, 6), 'No events are scheduled today.', (event) => ({
          title: event.title || 'Calendar event',
          detail: `${date(event.start)} to ${date(event.end)}`,
          aside: event.location || 'No location'
        }))
      : stateMessage('Calendar is unavailable; other personal sources remain current.');
    replace($('#today-events'), [eventRows]);
    replace($('#calendar-events'), [
      calendarAvailable
        ? jarvisRows(events, 'No events in this bounded window.', (event) => ({
            title: event.title || 'Calendar event',
            detail: `${date(event.start)} to ${date(event.end)} · ${plural(number(event.attendeeCount), 'attendee')}`,
            aside: event.location || 'Private'
          }))
        : stateMessage('Calendar source unavailable. No event state is inferred.')
    ]);
    replace($('#calendar-metrics'), [
      metricCard(
        'Events',
        calendarAvailable ? events.length : 'Unavailable',
        calendarAvailable
          ? calendar.truncated
            ? 'Bounded list truncated'
            : 'Complete bounded list'
          : 'Calendar source unavailable'
      ),
      metricCard(
        'Conflicts',
        calendarAvailable ? conflicts.length : 'Unavailable',
        calendarAvailable
          ? conflicts.length
            ? 'Review overlapping time'
            : 'No overlap detected'
          : 'Calendar source unavailable'
      ),
      metricCard('Write mode', 'Approval', 'Invites, changes, and cancellations')
    ]);
    const proposal = safeObject(calendar.proposedFocusBlock);
    const proposedEvent = safeObject(proposal.event);
    replace($('#calendar-suggestion'), [
      !calendarAvailable
        ? stateMessage('Calendar source unavailable. No focus block was proposed.')
        : proposedEvent.start
          ? jarvisRows([proposal], 'No focus block fits today.', () => ({
              title: proposedEvent.title || 'Jarvis focus block',
              detail: `${date(proposedEvent.start)} to ${date(proposedEvent.end)} · no provider write performed`,
              aside:
                safeObject(proposal.policy).verdict === 'autonomous'
                  ? 'Standing policy permits'
                  : 'Approval required'
            }))
          : stateMessage('No one-hour focus block fits in today’s bounded window.')
    ]);
    replace($('#today-memory'), [
      memoryReviewsAvailable
        ? jarvisRows(reviews, 'No personal memories are due for review.', (record) => ({
            title: record.title || 'Memory review',
            detail: record.summary || 'Review this personal memory.',
            aside: label(record.branch)
          }))
        : stateMessage(
            'Memory review source unavailable; calendar and memory records remain independent.'
          )
    ]);

    const branches = [
      'identity',
      'preferences',
      'people',
      'projects',
      'decisions',
      'routines',
      'learning'
    ];
    const cards = memoryRecordsAvailable
      ? branches.map((branch) => {
          const card = element('section', { className: 'panel memory-branch' });
          const branchRecords = records.filter((record) => record.branch === branch);
          card.append(
            element('p', { className: 'eyebrow', text: label(branch) }),
            element('h2', { text: `${subject(branch)} · ${branchRecords.length}` }),
            jarvisRows(branchRecords, 'No memories in this branch.', (record) => ({
              title: record.title || 'Personal memory',
              detail: record.summary || 'No summary.',
              aside: `${Math.round(number(record.confidence) * 100)}% confidence`
            }))
          );
          return card;
        })
      : [stateMessage('Personal memory records are unavailable. No empty branches are inferred.')];
    replace($('#personal-memory-tree'), cards);
  }

  function renderAgencyControl() {
    if (!state.agency) return;
    const agency = safeObject(state.agency);
    const autonomous = safeArray(agency.autonomous);
    const approvals = safeArray(agency.approvalRequired);
    const actionProposals = safeArray(agency.actionProposals).filter((proposal) =>
      Boolean(CORE.actionProposalPresentation(proposal))
    );
    const blocked = safeArray(agency.blocked);
    const badge = $('#agency-posture');
    badge.textContent = agency.killSwitchEngaged ? 'Autonomy paused' : 'Bounded autonomy active';
    badge.className = agency.killSwitchEngaged ? 'status-badge degraded' : 'status-badge';
    replace($('#agency-metrics'), [
      metricCard('Autonomous', autonomous.length, 'Reversible internal work'),
      metricCard(
        'Needs approval',
        approvals.length + actionProposals.length,
        'External, privileged, or channel-proposed effects'
      ),
      metricCard(
        'Blocked',
        blocked.length,
        agency.killSwitchEngaged ? 'Kill switch engaged' : 'Policy blocked'
      )
    ]);
    const describe = (action) => ({
      title: action.label || subject(action.id),
      detail: action.reason || 'Bounded by agency policy.',
      aside: label(action.category)
    });
    replace($('#agency-autonomous'), [
      jarvisRows(
        autonomous,
        agency.killSwitchEngaged
          ? 'Autonomy is paused by the kill switch.'
          : 'No preapproved internal work is ready.',
        describe
      )
    ]);
    const approvalRows = [];
    if (approvals.length) approvalRows.push(jarvisRows(approvals, '', describe));
    if (actionProposals.length) approvalRows.push(renderActionProposals(actionProposals));
    if (!approvalRows.length)
      approvalRows.push(stateMessage('No agency actions or channel proposals need approval.'));
    replace($('#agency-approval'), approvalRows);
    replace($('#agency-blocked'), [jarvisRows(blocked, 'No agency work is blocked.', describe)]);
    const todayDecisions = [
      ...approvals,
      ...actionProposals.map((proposal) => {
        const presentation = CORE.actionProposalPresentation(proposal);
        return {
          label: presentation?.title,
          reason: presentation?.detail,
          category: 'channel proposal'
        };
      })
    ];
    replace($('#today-decisions'), [
      jarvisRows(todayDecisions.slice(0, 5), 'No agency decisions need you right now.', describe)
    ]);
  }

  function renderActionProposals(proposals) {
    const list = element('div', { className: 'row-list action-proposal-list' });
    proposals.forEach((proposal) => {
      const presentation = CORE.actionProposalPresentation(proposal);
      if (!presentation) return;
      const proposalKind = safeObject(proposal).kind;
      const appliesApprovedEffect = proposalKind === 'pause_runtime';
      const row = element('div', { className: 'data-row action-proposal-row' });
      const main = element('div', { className: 'row-main' });
      main.append(
        element('strong', { text: presentation.title }),
        element('span', {
          text: appliesApprovedEffect
            ? `${presentation.detail} · approval applies the exact runtime pause immediately.`
            : `${presentation.detail} · approval records the decision; no runtime effect is configured.`
        }),
        element('small', { text: presentation.aside })
      );
      const actions = element('div', { className: 'proposal-actions' });
      const pending = state.actionProposalMutationId === presentation.id;
      const approve = element('button', {
        className: 'button',
        type: 'button',
        text: appliesApprovedEffect
          ? pending
            ? 'Applying…'
            : 'Approve and pause'
          : pending
            ? 'Recording…'
            : 'Approve record',
        ariaLabel: `Approve ${presentation.title}`,
        disabled: pending
      });
      const reject = element('button', {
        className: 'button button-secondary',
        type: 'button',
        text: 'Reject',
        ariaLabel: `Reject ${presentation.title}`,
        disabled: pending
      });
      approve.addEventListener('click', () => void decideActionProposal(proposal, 'approved'));
      reject.addEventListener('click', () => void decideActionProposal(proposal, 'rejected'));
      actions.append(approve, reject);
      row.append(main, actions);
      list.append(row);
    });
    return list;
  }

  async function decideActionProposal(proposal, verdict) {
    const presentation = CORE.actionProposalPresentation(proposal);
    const body = CORE.actionProposalDecisionBody(proposal, verdict);
    if (!presentation || !body || state.actionProposalMutationId !== null) {
      announce('That proposal is no longer available for an exact decision.');
      return;
    }
    state.actionProposalMutationId = presentation.id;
    renderAgencyControl();
    try {
      const result = await request(
        `/action-proposals/${encodeURIComponent(presentation.id)}/decision`,
        {
          method: 'POST',
          body: JSON.stringify(body)
        }
      );
      const outcome = CORE.actionProposalDecisionOutcome(proposal, result);
      announce(
        outcome?.message || 'The action-proposal response could not be verified; refresh required.'
      );
      await load({ manual: true, sources: ['agency', 'personal'] });
    } catch (error) {
      console.error('Could not confirm the action-proposal decision outcome.', error);
      announce('Decision outcome is unknown; reconciling current posture and pending proposals.');
      await load({ manual: true, sources: ['agency', 'personal'] });
    } finally {
      state.actionProposalMutationId = null;
      renderAgencyControl();
    }
  }

  function renderPageTemplates() {
    if (safeObject(state.sources.pages).status === 'empty') return;
    const target = $('#page-template-list');
    if (!state.pageTemplates.length) {
      replace(target, [stateMessage('No validated page templates are available.')]);
      return;
    }
    const buttons = state.pageTemplates.map((template) => {
      const button = element('button', {
        className: 'recipe-button',
        type: 'button',
        ariaLabel: `Preview ${template.title || template.id} template`
      });
      button.append(
        element('strong', { text: template.title || subject(template.id) }),
        element('span', {
          text: template.description || 'Preview this validated operator workspace.'
        })
      );
      button.addEventListener('click', () => {
        const requestText = String(template.request || '');
        $('#page-request').value = requestText;
        $('#page-form-status').textContent =
          `Previewing the ${template.title || template.id} template…`;
        void previewRequest(requestText);
      });
      return button;
    });
    replace(target, buttons);
  }

  function renderPages() {
    renderPageTemplates();
    if (safeObject(state.sources.pages).status === 'empty') return;
    const target = $('#saved-pages-list');
    $('#saved-page-count').textContent = plural(state.pages.length, 'page');
    if (!state.pages.length)
      replace(target, [
        stateMessage(
          'No pages have been published. Use Page Studio to preview a supported request first.'
        )
      ]);
    else {
      const list = element('div', { className: 'row-list' });
      state.pages.forEach((page) => {
        const button = element('button', {
          className: 'page-button',
          type: 'button',
          ariaPressed: page.slug === state.selectedPageSlug
        });
        button.append(
          element('strong', { text: page.title || page.slug }),
          element('span', {
            text: `${plural(safeArray(page.widgets).length, 'widget')} · ${date(page.createdAt)}`
          })
        );
        button.addEventListener('click', () => {
          selectPage(page.slug, true);
        });
        list.append(button);
      });
      replace(target, [list]);
    }
    renderPageCanvas();
  }

  function widgetCard(title, content, items) {
    const card = element('article', { className: 'widget-card' });
    card.append(element('h4', { text: title }), element('p', { text: content }));
    if (safeArray(items).length)
      card.append(
        jarvisRows(items, 'No bounded details are available.', (item) => ({
          title: item.title,
          detail: item.detail,
          aside: item.aside
        }))
      );
    return card;
  }

  /**
   * Bring the active nav item into view without moving the page.
   *
   * The tab bar is sticky, so a plain scrollIntoView would scroll the document
   * vertically on every tab switch just to reveal a tab that is already pinned.
   * Inside the bar we therefore adjust only its own horizontal scroll.
   */
  function revealActiveNavItem(item) {
    const bar = item.closest('.tab-bar');
    if (!bar) {
      item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }
    const itemBox = item.getBoundingClientRect();
    const barBox = bar.getBoundingClientRect();
    if (itemBox.left < barBox.left) {
      bar.scrollLeft -= barBox.left - itemBox.left;
    } else if (itemBox.right > barBox.right) {
      bar.scrollLeft += itemBox.right - barBox.right;
    }
  }

  function registeredWidgetIds() {
    return WIDGETS.list().map((definition) => definition.id);
  }

  function currentLayout() {
    if (!state.layout) {
      state.layout = LAYOUT.load(safeStorage(), registeredWidgetIds());
    }
    return state.layout;
  }

  /** localStorage access can throw outright when the page is sandboxed. */
  function safeStorage() {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  function commitLayout(next) {
    if (next === state.layout) return;
    state.layout = next;
    LAYOUT.save(safeStorage(), next);
    renderHome();
  }

  /**
   * Render one tile of the main board. Tile controls are omitted entirely while
   * the board is locked rather than merely disabled, so a locked board offers no
   * drag or resize surface to hit by accident.
   */
  function homeTile(tile, layout, context, index, total) {
    const definition = WIDGETS.definition(tile.widget);
    const article = element('article', { className: 'board-tile' });
    article.dataset.span = String(tile.span);
    article.dataset.widget = tile.widget;

    const header = element('div', { className: 'board-tile-header' });
    header.append(
      element('h3', { text: definition ? definition.title : subject(tile.widget) }),
      element('span', { className: 'board-tile-size', text: tile.size })
    );

    if (!LAYOUT.isLocked(layout)) {
      const controls = element('div', { className: 'board-tile-controls' });
      const sizeSelect = element('select', { className: 'board-size-select' });
      sizeSelect.setAttribute(
        'aria-label',
        `Width of ${definition ? definition.title : tile.widget}`
      );
      LAYOUT.SIZE_NAMES.forEach((name) => {
        const option = element('option', { text: name, value: name });
        option.value = name;
        if (name === tile.size) option.selected = true;
        sizeSelect.append(option);
      });
      sizeSelect.addEventListener('change', () => {
        commitLayout(LAYOUT.resizeTile(currentLayout(), tile.id, sizeSelect.value));
      });

      const earlier = element('button', {
        className: 'button icon-button',
        type: 'button',
        text: '←'
      });
      earlier.setAttribute('aria-label', 'Move tile earlier');
      earlier.disabled = index === 0;
      earlier.addEventListener('click', () =>
        commitLayout(LAYOUT.moveTile(currentLayout(), tile.id, -1))
      );

      const later = element('button', {
        className: 'button icon-button',
        type: 'button',
        text: '→'
      });
      later.setAttribute('aria-label', 'Move tile later');
      later.disabled = index === total - 1;
      later.addEventListener('click', () =>
        commitLayout(LAYOUT.moveTile(currentLayout(), tile.id, 1))
      );

      const remove = element('button', {
        className: 'button icon-button',
        type: 'button',
        text: '×'
      });
      remove.setAttribute('aria-label', 'Remove tile from board');
      remove.addEventListener('click', () =>
        commitLayout(LAYOUT.removeTile(currentLayout(), tile.id))
      );

      controls.append(sizeSelect, earlier, later, remove);
      header.append(controls);
    }

    article.append(header);

    const source = WIDGETS.sourceFor(tile.widget);
    if (source && !['fresh', 'stale'].includes(safeObject(state.sources[source]).status)) {
      article.append(
        stateMessage(`${subject(source)} source unavailable; this tile is not current.`, 'warning')
      );
      return article;
    }
    const cards = WIDGETS.cardsFor(tile.widget, context);
    if (cards.length === 0) {
      article.append(stateMessage('This widget produced no bounded cards.'));
      return article;
    }
    cards.forEach((entry) => article.append(widgetCard(entry.title, entry.content, entry.items)));
    return article;
  }

  function renderHome() {
    const target = $('#home-board');
    if (!target) return;
    const layout = currentLayout();
    const locked = LAYOUT.isLocked(layout);
    const context = buildWidgetContext();

    const lockButton = $('#board-lock');
    if (lockButton) {
      lockButton.textContent = locked ? 'Unlock board' : 'Lock board';
      lockButton.setAttribute('aria-pressed', String(locked));
    }
    const lockNote = $('#board-lock-note');
    if (lockNote) {
      lockNote.textContent = locked
        ? 'Locked. Sizes and placement cannot change until you unlock.'
        : 'Unlocked. Resize, reorder, or remove tiles, then lock to protect the layout.';
    }

    // Reset is a shape change, so the lock blocks it too. Disable the control
    // rather than letting an enabled-looking button silently do nothing.
    const resetButton = $('#board-reset');
    if (resetButton) {
      resetButton.disabled = locked;
      resetButton.title = locked ? 'Unlock the board to reset it to the default tiles.' : '';
    }

    const picker = $('#board-add');
    if (picker) {
      const addable = LAYOUT.availableToAdd(layout, registeredWidgetIds());
      // There are more widgets than the board can hold, so a full board must
      // explain itself instead of offering buttons that cannot do anything.
      const atCapacity = layout.tiles.length >= LAYOUT.MAX_TILES;
      picker.hidden = locked;
      replace(
        picker,
        addable.length === 0
          ? [element('span', { className: 'quiet', text: 'Every widget is already placed.' })]
          : atCapacity
            ? [
                element('span', {
                  className: 'quiet',
                  text: `The board holds ${LAYOUT.MAX_TILES} tiles. Remove one to place ${plural(addable.length, 'remaining widget')}.`
                })
              ]
            : [
                element('span', { className: 'nav-label', text: 'Add widget' }),
                ...addable.map((id) => {
                  const definition = WIDGETS.definition(id);
                  const button = element('button', {
                    className: 'button button-secondary board-add-button',
                    type: 'button',
                    text: definition ? definition.title : subject(id)
                  });
                  button.addEventListener('click', () =>
                    commitLayout(LAYOUT.addTile(currentLayout(), id))
                  );
                  return button;
                })
              ]
      );
    }

    target.classList.toggle('is-locked', locked);
    replace(
      target,
      layout.tiles.length === 0
        ? [stateMessage('The board is empty. Add a widget to begin.')]
        : layout.tiles.map((tile, index) =>
            homeTile(tile, layout, context, index, layout.tiles.length)
          )
    );
  }

  function renderPnl() {
    const target = $('#pnl-body');
    if (!target) return;
    // Without a snapshot there is nothing true to report. Rendering the
    // zero-valued shape would assert "no spend has been recorded" when the
    // actual fact is "this read model did not load", which is the one claim a
    // P&L must never make on the operator's behalf.
    if (!state.pnl) {
      const record = safeObject(state.sources.pnl);
      return replace(target, [
        record.status === 'unavailable'
          ? stateMessage(
              record.message || 'The P&L read model is unavailable, so no figures can be shown.',
              'error'
            )
          : stateMessage('Loading metered expense and revenue recognition state…')
      ]);
    }
    const pnl = safeObject(state.pnl);
    const sleeves = safeArray(pnl.sleeves);
    const system = safeObject(pnl.system);
    const systemExpense = safeObject(system.expense);

    const metrics = element('div', { className: 'metric-grid' });
    metrics.append(
      metricCard(
        'Known expense',
        microUsd(systemExpense.knownMicroUsd),
        'Metered dollars, all recorded usage'
      ),
      metricCard('Recognized revenue', microUsd(0), 'No settlement has been verified'),
      metricCard(
        'Net',
        microUsd(number(system.netMicroUsd)),
        system.netIsComplete === true ? 'Complete coverage' : 'Floor only; some cost is unknown'
      ),
      metricCard(
        'Cost coverage',
        label(systemExpense.coverage || 'none'),
        plural(number(systemExpense.uncoveredEvents), 'uncovered call')
      )
    );

    const table = element('table', { className: 'data-table' });
    const head = element('thead');
    const headRow = element('tr');
    ['Sleeve', 'Known expense', 'Coverage', 'Recognized revenue', 'Net'].forEach((heading) =>
      headRow.append(element('th', { text: heading }))
    );
    head.append(headRow);
    const body = element('tbody');
    if (sleeves.length === 0) {
      const emptyRow = element('tr');
      const cell = element('td', {
        text: 'No metered model usage has been recorded yet, so there is nothing to attribute.'
      });
      cell.colSpan = 5;
      emptyRow.append(cell);
      body.append(emptyRow);
    }
    sleeves.forEach((sleeve) => {
      const value = safeObject(sleeve);
      const expense = safeObject(value.expense);
      const row = element('tr');

      // A sleeve whose spend is entirely unknown nets to 0, which reads as
      // "broke even". It is a floor, not a total, so the cell says so rather
      // than letting the number stand alone.
      const net = element('td');
      net.append(element('strong', { text: microUsd(number(value.netMicroUsd)) }));
      if (value.netIsComplete !== true) {
        net.append(element('span', { className: 'quiet', text: 'floor; some cost unknown' }));
      }

      row.append(
        element('td', { text: boundedLabel(value.label) }),
        element('td', { text: microUsd(expense.knownMicroUsd) }),
        element('td', {
          text: `${label(expense.coverage || 'none')}${
            number(expense.uncoveredEvents) > 0
              ? ` · ${plural(number(expense.uncoveredEvents), 'uncovered call')}`
              : ''
          }`
        }),
        element('td', { text: microUsd(0) }),
        net
      );
      body.append(row);
    });
    table.append(head, body);

    const disclosure = element('p', {
      className: 'panel-state',
      text: boundedLabel(pnl.disclosure) || 'Revenue recognition state is unavailable.'
    });

    replace(target, [metrics, table, disclosure]);
  }

  function boundedLabel(value) {
    return typeof value === 'string' ? value.slice(0, 400) : '';
  }

  /**
   * The single widget context used by both the configurable main board and
   * saved pages, so a widget renders identically wherever it is placed.
   */
  function buildWidgetContext() {
    const revenuePresenter = safeObject(window.JarvisRevenueWidget);
    return {
      overview: safeObject(state.overview),
      graph: safeObject(state.graph),
      queueItems: queueSnapshotItems(state.queue),
      revenueCards:
        typeof revenuePresenter.revenuePipelineCards === 'function'
          ? revenuePresenter.revenuePipelineCards(state.revenue)
          : [],
      personal: safeObject(state.personal),
      agency: safeObject(state.agency),
      pnl: safeObject(state.pnl)
    };
  }

  function renderPageCanvas() {
    const target = $('#page-canvas');
    const page = state.pages.find((item) => item.slug === state.selectedPageSlug);
    if (!page)
      return replace(target, [
        stateMessage('Select a published page to render its allowlisted widgets.')
      ]);
    const widgets = safeArray(page.widgets);
    const cards = [];
    const widgetContext = buildWidgetContext();
    widgets.forEach((widget) => {
      const definition = WIDGETS.definition(widget);
      if (!definition) {
        cards.push(widgetCard(subject(widget), 'This widget is not registered and was not run.'));
        return;
      }
      const source = WIDGETS.sourceFor(widget);
      if (source && !['fresh', 'stale'].includes(safeObject(state.sources[source]).status)) {
        cards.push(
          widgetCard(
            definition.title,
            `${subject(source)} source unavailable; this widget is not current.`
          )
        );
        return;
      }
      WIDGETS.cardsFor(widget, widgetContext).forEach((entry) =>
        cards.push(widgetCard(entry.title, entry.content, entry.items))
      );
    });
    const heading = element('div', { className: 'page-canvas-heading' });
    const headingCopy = element('div');
    headingCopy.append(
      element('h3', { text: page.title || page.slug }),
      element('p', {
        className: 'quiet',
        text: 'Rendered from the saved declarative widget manifest.'
      })
    );
    const reuse = element('button', {
      className: 'button button-secondary',
      type: 'button',
      text: 'Use as starting point'
    });
    reuse.addEventListener('click', () => {
      $('#page-request').value = page.request || '';
      $('#page-request').focus();
      $('#page-form-status').textContent =
        'Saved request loaded. Edit it, then preview the canonical mapping.';
    });
    heading.append(headingCopy, reuse);
    const grid = element('div', { className: 'widget-grid' });
    grid.append(...(cards.length ? cards : [stateMessage('This page has no renderable widgets.')]));
    replace(target, [heading, grid]);
  }

  function listBox(title, entries, renderer, warning) {
    const box = element('section', { className: `plan-box${warning ? ' plan-warning' : ''}` });
    box.append(element('h4', { text: title }));
    if (!entries.length)
      box.append(element('p', { className: 'quiet', text: warning ? 'No gaps found.' : 'None.' }));
    else {
      const list = element('ul');
      entries.forEach((entry) => list.append(element('li', { text: renderer(entry) })));
      box.append(list);
    }
    return box;
  }

  function renderPlan() {
    const target = $('#page-plan');
    const plan = state.plan;
    if (!plan)
      return replace(target, [
        stateMessage('Preview a request to inspect the mapped capabilities, gaps, and checks.')
      ]);
    const summary = element('div', { className: 'plan-summary' });
    const header = element('header');
    const title = element('div');
    title.append(
      element('h3', { text: plan.title || 'Page plan' }),
      element('p', {
        className: 'quiet',
        text: `Slug: ${plan.slug || 'unavailable'} · Fingerprint: ${plan.fingerprint || 'unavailable'}`
      })
    );
    header.append(
      title,
      element('span', {
        className: `status-badge${plan.ready ? '' : ' degraded'}`,
        text: plan.ready ? 'Ready for review' : 'Repository work required'
      })
    );
    const columns = element('div', { className: 'plan-columns' });
    columns.append(
      listBox(
        'Mapped capabilities',
        safeArray(plan.mapping),
        (item) =>
          `${item.capability} → ${item.widget} (${safeArray(item.implementationFiles).join(', ')})`
      ),
      listBox('Gaps', safeArray(plan.gaps), (item) => `${item.capability}: ${item.reason}`, true),
      listBox('Checks before publish', safeArray(plan.checks), (item) => item)
    );
    summary.append(header, columns);
    if (plan.ready && plan.recommendedWorkflow === 'declarative_page') {
      const confirm = element('div', { className: 'confirmation' });
      const labelNode = element('label');
      const checkbox = element('input', { type: 'checkbox', id: 'page-confirmation' });
      labelNode.append(
        checkbox,
        document.createTextNode('I reviewed this mapping and want to publish the canonical page.')
      );
      const create = element('button', {
        className: 'button',
        type: 'button',
        id: 'create-page-button',
        text: 'Create reviewed page',
        disabled: true
      });
      checkbox.addEventListener('change', () => {
        create.disabled = !checkbox.checked;
      });
      create.addEventListener('click', createPage);
      confirm.append(labelNode, create);
      summary.append(confirm);
    } else
      summary.append(
        element('p', {
          className: 'privacy-note',
          text: 'This request is not publishable as a declarative page. Use the recommended repository skill workflow to implement the missing capability, then preview again.'
        })
      );
    replace(target, [summary]);
  }

  async function previewRequest(input) {
    const requestText = String(input || '').trim();
    const status = $('#page-form-status');
    if (requestText.length < 8) {
      status.textContent = 'Please describe the page in at least 8 characters.';
      return;
    }
    $('#preview-button').disabled = true;
    status.textContent = 'Mapping request to available code and widgets…';
    state.plan = null;
    renderPlan();
    try {
      state.plan = await request('/page-plans', {
        method: 'POST',
        body: JSON.stringify({ request: requestText })
      });
      renderPlan();
      status.textContent = state.plan.ready
        ? 'Preview ready. Review before publishing.'
        : 'Preview found a gap requiring repository work.';
      announce(status.textContent);
    } catch (error) {
      status.textContent = error.message || 'Could not preview this request.';
      replace($('#page-plan'), [stateMessage(status.textContent, 'error')]);
      announce(status.textContent);
    } finally {
      $('#preview-button').disabled = false;
    }
  }

  function previewPage(event) {
    event.preventDefault();
    return previewRequest($('#page-request').value);
  }

  async function createPage() {
    const plan = state.plan;
    const status = $('#page-form-status');
    if (!plan || !plan.ready) return;
    const button = $('#create-page-button');
    button.disabled = true;
    status.textContent = 'Creating the reviewed canonical page…';
    try {
      const result = await request('/pages', {
        method: 'POST',
        body: JSON.stringify({
          request: plan.request,
          expectedFingerprint: plan.fingerprint,
          confirmed: true
        })
      });
      const page = safeObject(result).page;
      state.pages = [page, ...state.pages.filter((existing) => existing.slug !== page.slug)];
      state.plan = null;
      if (NAVIGATION.isSavedView(window.location.href)) selectPage(page.slug, true);
      else renderPages();
      renderPlan();
      status.textContent = `Published “${page.title || page.slug}”.`;
      announce(status.textContent);
    } catch (error) {
      status.textContent = error.message || 'Could not create this page.';
      button.disabled = false;
      announce(status.textContent);
    }
  }

  function setupDictation() {
    const button = $('#dictation-button');
    const status = $('#dictation-status');
    const TextRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!TextRecognition) {
      button.disabled = true;
      button.textContent = 'Dictation unavailable';
      status.textContent =
        'This browser does not support speech recognition. Typed input remains available.';
      return;
    }
    let recognition = null;
    let listening = false;
    let baseText = '';
    let finalText = '';
    function setListening(active) {
      listening = active;
      button.textContent = active ? 'Stop dictation' : 'Start dictation';
      button.setAttribute('aria-pressed', String(active));
    }
    button.addEventListener('click', () => {
      if (listening && recognition) {
        recognition.stop();
        return;
      }
      recognition = new TextRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      baseText = $('#page-request').value.trim();
      finalText = '';
      recognition.onstart = () => {
        setListening(true);
        status.textContent = 'Listening. Review and edit the text before previewing.';
      };
      recognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) finalText += `${transcript} `;
          else interim += transcript;
        }
        $('#page-request').value = [baseText, finalText.trim(), interim.trim()]
          .filter(Boolean)
          .join(baseText && (finalText || interim) ? ' ' : '');
      };
      recognition.onerror = (event) => {
        status.textContent = `Dictation stopped: ${event.error || 'recognition error'}. Your editable text was kept.`;
        setListening(false);
      };
      recognition.onend = () => {
        if (listening)
          status.textContent = 'Dictation ended. Review and edit the text before previewing.';
        setListening(false);
      };
      try {
        recognition.start();
      } catch (_error) {
        status.textContent = 'Dictation could not start. Typed input remains available.';
        setListening(false);
      }
    });
  }

  function setupAgentWorkbench() {
    if (window.matchMedia('(max-width: 720px)').matches) {
      $('#agent-registry-details').open = false;
    }
    $('#agent-new-conversation').addEventListener('click', () => {
      void createAgentConversation();
    });
    renderChat();
    renderAgentFloor();
  }

  function setGraphMode(modeInput) {
    const mode = modeInput === 'code' ? 'code' : 'memory';
    const previousMode = graphModeKey();
    state.graphQueries[previousMode] = $('#graph-search').value;
    state.graphMode = mode;
    $('#graph-search').value = state.graphQueries[mode];
    renderMemory();
    if (mode === 'code' && !state.codeGraph) {
      void load({ sources: ['codeGraph'] });
    }
    if (mode !== previousMode) {
      announce(
        mode === 'code'
          ? 'Code graph selected. Graphify is a bounded harness snapshot.'
          : 'Memory graph selected. Private client notes remain excluded.'
      );
    }
  }

  function setupGraph() {
    graphRenderer = GRAPH_VIEW.createRenderer({
      canvas: $('#graph-canvas'),
      onSelect: (nodeId) => {
        if (nodeId) selectGraphNode(nodeId, false);
      }
    });
    document.querySelectorAll('[data-graph-source]').forEach((button) => {
      button.addEventListener('click', () => setGraphMode(button.dataset.graphSource));
    });
    $('#graph-search').addEventListener('input', (event) => {
      state.graphQueries[graphModeKey()] = event.currentTarget.value;
      renderMemory();
    });
    $('#graph-zoom-in').addEventListener('click', () => graphRenderer.zoom(1.25));
    $('#graph-zoom-out').addEventListener('click', () => graphRenderer.zoom(0.8));
    $('#graph-fit').addEventListener('click', () => graphRenderer.fit());
  }

  function setupNavigation() {
    function selectedView() {
      return CORE.viewDefinition(NAVIGATION.viewFromUrl(window.location.href)).id;
    }
    function activateView(view, updateHistory) {
      const definition = CORE.viewDefinition(view);
      const selected = definition.id;
      if (document.body.dataset.activeView && document.body.dataset.activeView !== selected) {
        state.agentNavigationEpoch += 1;
      }
      document.body.dataset.activeView = selected;
      document.querySelectorAll('[data-view]').forEach((section) => {
        const active = section.dataset.view === selected;
        section.hidden = !active;
        section.classList.toggle('is-active', active);
      });
      document.querySelectorAll('[data-view-target]').forEach((item) => {
        const active = item.dataset.viewTarget === selected;
        item.classList.toggle('is-active', active);
        if (active) {
          item.setAttribute('aria-current', 'page');
          revealActiveNavItem(item);
        } else item.removeAttribute('aria-current');
      });
      // Any view that is not one of the four mobile primaries lives behind
      // More, so the summary carries the active marker in its place.
      const mobileMore = document.querySelector('.mobile-more');
      if (mobileMore) {
        const primaries = [...document.querySelectorAll('[data-mobile-primary]')].map(
          (item) => item.dataset.mobilePrimary
        );
        mobileMore.classList.toggle('is-active', !primaries.includes(selected));
      }
      renderActiveScope(selected);
      $('#view-title').textContent = definition.title;
      $('#view-kicker').textContent = definition.kicker;
      $('#view-summary').textContent = definition.summary;
      document.title = definition.documentTitle;
      if (updateHistory) {
        const nextUrl = NAVIGATION.viewUrl(window.location.href, selected);
        if (nextUrl !== window.location.href)
          window.history.pushState(
            { view: selected, page: selected === 'saved' ? requestedPageSlug() : null },
            '',
            nextUrl
          );
      }
      if (selected === 'saved') {
        syncSelectedPageFromUrl();
        renderPages();
      } else state.selectedPageSlug = null;
      if (selected === 'chat' && state.agents) void restoreAgentSelectionFromUrl();
      renderOperationalContext();
      const missingSources = definition.sources.filter((source) =>
        ['empty', 'unavailable'].includes(safeObject(state.sources[source]).status)
      );
      if (missingSources.length > 0) void load({ sources: missingSources });
      else renderAll();
      if (updateHistory) $('#view-title').focus({ preventScroll: true });
    }
    document.querySelectorAll('[data-view-target]').forEach((link) =>
      link.addEventListener('click', (event) => {
        if (
          !CORE.shouldHandleNavigation({
            defaultPrevented: event.defaultPrevented,
            button: event.button,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey
          })
        )
          return;
        event.preventDefault();
        const mobileMore = link.closest('.mobile-more');
        if (mobileMore) mobileMore.open = false;
        activateView(link.dataset.viewTarget, true);
      })
    );
    document.querySelectorAll('[data-lane]').forEach((button) =>
      button.addEventListener('click', () => {
        const url = new URL(window.location.href);
        url.searchParams.set('lane', button.dataset.lane);
        window.history.replaceState(window.history.state, '', url);
        syncLaneFromUrl();
      })
    );
    syncLaneFromUrl();
    activateView(selectedView(), false);
    window.addEventListener('popstate', () => {
      syncLaneFromUrl();
      activateView(selectedView(), false);
      $('#view-title').focus({ preventScroll: true });
    });
    document.addEventListener('visibilitychange', () => {
      clearRefreshTimer();
      renderOperationalContext();
      if (!document.hidden) void load({ manual: false });
    });
    $('#refresh-button').addEventListener('click', () => void load({ manual: true }));
    $('#page-request-form').addEventListener('submit', previewPage);
    $('#chat-form').addEventListener('submit', sendChat);
    $('#model-runtime-providers').addEventListener('click', handleModelRuntimeAction);
    $('#model-runtime-disable').addEventListener('click', () => void disableModelRuntime());
    $('#board-lock').addEventListener('click', () => {
      const layout = currentLayout();
      commitLayout(LAYOUT.setLocked(layout, !LAYOUT.isLocked(layout)));
    });
    $('#board-reset').addEventListener('click', () => {
      // Reset is intentionally blocked while locked: the lock protects the
      // layout from every shape change, not just from resizing.
      if (LAYOUT.isLocked(currentLayout())) return;
      commitLayout(LAYOUT.defaultLayout(registeredWidgetIds()));
    });
  }

  function renderAll() {
    renderOverview();
    renderQueue();
    renderClients();
    renderRuns();
    renderPnl();
    renderHome();
    renderEconomics();
    renderMemory();
    renderGrowth();
    renderImprovements();
    renderPersonalJarvis();
    renderAgencyControl();
    renderAgentFloor();
    renderModelRuntime();
    renderChat();
    renderPages();
    renderPlan();
    renderOperationalContext();
  }
  setupAgentWorkbench();
  setupGraph();
  setupNavigation();
  setupDictation();
})();
