(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JarvisDashboardCore = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const SOURCE_NAMES = [
    'agents',
    'modelRuntime',
    'overview',
    'queue',
    'revenue',
    'graph',
    'codeGraph',
    'pages',
    'personal',
    'agency',
    'pnl'
  ];
  const CORE_CHECKS = ['gateway', 'database', 'disk'];
  const CHECK_ORDER = [...CORE_CHECKS, 'ollama', 'docker'];
  const VIEW_DEFINITIONS = Object.freeze({
    /**
     * The configurable main board. It composes widgets that each also have a
     * dedicated view, so the operator can work from one screen or go straight to
     * a single surface. Its sources are the union of what its widgets can read.
     */
    home: Object.freeze({
      id: 'home',
      title: 'Main board',
      kicker: 'Configurable operator surface',
      summary: 'Compose the widgets you want, size them, then lock the board against stray edits.',
      documentTitle: 'Main board — Jarvis Control Room',
      sources: Object.freeze(['overview', 'queue', 'revenue', 'personal', 'agency', 'pnl'])
    }),
    pnl: Object.freeze({
      id: 'pnl',
      title: 'P&L',
      kicker: 'Expenses, revenue, and coverage',
      summary:
        'Metered spend per sleeve and system-wide. Revenue stays unrecognized until settlement is verified.',
      documentTitle: 'P&L — Jarvis Control Room',
      sources: Object.freeze(['overview', 'queue', 'revenue', 'pnl'])
    }),
    today: Object.freeze({
      id: 'today',
      title: 'Today',
      kicker: 'Personal command surface',
      summary: 'See the day, memory reviews, and agency decisions that need you.',
      documentTitle: 'Today — Jarvis Control Room',
      sources: Object.freeze(['overview', 'queue', 'personal', 'agency'])
    }),
    chat: Object.freeze({
      id: 'chat',
      title: 'Jarvis',
      kicker: 'Conversation and command',
      summary: 'Ask Jarvis for bounded status, calendar, memory, agency, and page context.',
      documentTitle: 'Jarvis — Jarvis Control Room',
      sources: Object.freeze([
        'overview',
        'queue',
        'agents',
        'modelRuntime',
        'personal',
        'agency',
        'pages'
      ])
    }),
    calendar: Object.freeze({
      id: 'calendar',
      title: 'Calendar',
      kicker: 'Time and conflicts',
      summary: 'Inspect today’s local calendar projection before approving provider changes.',
      documentTitle: 'Calendar — Jarvis Control Room',
      sources: Object.freeze(['overview', 'queue', 'personal'])
    }),
    personal: Object.freeze({
      id: 'personal',
      title: 'Personal memory',
      kicker: 'Private memory tree',
      summary: 'Review inspectable memories that remain invisible to agency and client workers.',
      documentTitle: 'Personal memory — Jarvis Control Room',
      sources: Object.freeze(['overview', 'queue', 'personal'])
    }),
    agency: Object.freeze({
      id: 'agency',
      title: 'Agent floor',
      kicker: 'Hierarchy, sleeves, and bounded autonomy',
      summary: 'Inspect agent purpose, authority, autonomous work, approvals, and blocks.',
      documentTitle: 'Agent floor — Jarvis Control Room',
      sources: Object.freeze(['overview', 'queue', 'agents', 'agency'])
    }),
    queue: Object.freeze({
      id: 'queue',
      title: 'Work queue',
      kicker: 'Decision workspace',
      summary: 'Prioritize the next safe piece of work and inspect why it is ready.',
      documentTitle: 'Work queue — Jarvis Control Room',
      sources: Object.freeze(['overview', 'queue'])
    }),
    runs: Object.freeze({
      id: 'runs',
      title: 'Run history',
      kicker: 'Execution evidence',
      summary: 'Review bounded automation outcomes without exposing tenant inputs or errors.',
      documentTitle: 'Run history — Jarvis Control Room',
      sources: Object.freeze(['overview', 'queue'])
    }),
    clients: Object.freeze({
      id: 'clients',
      title: 'Client scopes',
      kicker: 'Tenant portfolio',
      summary: 'Inspect lifecycle state while client-private notes remain compartmentalized.',
      documentTitle: 'Client scopes — Jarvis Control Room',
      sources: Object.freeze(['overview', 'queue'])
    }),
    growth: Object.freeze({
      id: 'growth',
      title: 'Growth',
      kicker: 'Commercial review',
      summary: 'Advance one reviewed first-client decision without sending or charging.',
      documentTitle: 'Growth — Jarvis Control Room',
      sources: Object.freeze(['overview', 'queue', 'revenue'])
    }),
    knowledge: Object.freeze({
      id: 'knowledge',
      title: 'Knowledge graph',
      kicker: 'Validated memory',
      summary: 'Traverse the global Markdown graph without crossing tenant-private boundaries.',
      documentTitle: 'Knowledge graph — Jarvis Control Room',
      sources: Object.freeze(['overview', 'queue', 'graph'])
    }),
    system: Object.freeze({
      id: 'system',
      title: 'Runtime',
      kicker: 'Runtime and economics',
      summary: 'Separate core readiness from dependencies, usage evidence, and routing policy.',
      documentTitle: 'Runtime — Jarvis Control Room',
      sources: Object.freeze(['overview', 'queue'])
    }),
    saved: Object.freeze({
      id: 'saved',
      title: 'Page Studio',
      kicker: 'Operator page workflow',
      summary: 'Render and create reviewed declarative pages from existing safe read models.',
      documentTitle: 'Page Studio — Jarvis Control Room',
      sources: Object.freeze([
        'overview',
        'queue',
        'revenue',
        'graph',
        'pages',
        'personal',
        'agency'
      ])
    })
  });
  const LEGACY_VIEWS = Object.freeze({
    overview: 'queue',
    economics: 'system',
    memory: 'knowledge',
    improvements: 'growth',
    pages: 'saved'
  });
  const STATUS_CLASSES = Object.freeze({
    priority: Object.freeze({
      P0: 'priority-p0',
      P1: 'priority-p1',
      P2: 'priority-p2',
      P3: 'priority-p3'
    }),
    state: Object.freeze({
      active: 'status-active',
      blocked: 'status-blocked',
      failed: 'status-failed',
      pass: 'status-pass',
      ready: 'status-ready',
      running: 'status-running',
      succeeded: 'status-succeeded'
    }),
    tone: Object.freeze({
      attention: 'tone-attention',
      blocked: 'tone-blocked',
      ready: 'tone-ready'
    })
  });

  function safeObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function count(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  function boundedText(value, fallback) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text ? text.slice(0, 160) : fallback;
  }

  function humanize(value) {
    const text = boundedText(value, 'Unknown')
      .replace(/[_:.\-]+/g, ' ')
      .replace(/\s+/g, ' ');
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  }

  function plural(value, noun) {
    return `${value} ${noun}${value === 1 ? '' : 's'}`;
  }

  function validAgentId(value) {
    return typeof value === 'string' && /^[a-z][a-z0-9-]{2,63}$/u.test(value);
  }

  function validConversationId(value) {
    return (
      typeof value === 'string' &&
      /^conversation:[a-z0-9](?:[a-z0-9]|[._:-](?=[a-z0-9])){2,95}$/u.test(value)
    );
  }

  function validMessageId(value) {
    return (
      typeof value === 'string' &&
      /^message:[a-z0-9](?:[a-z0-9]|[._:-](?=[a-z0-9])){2,95}$/u.test(value)
    );
  }

  function agentProfiles(catalogInput) {
    const seen = new Set();
    return safeArray(safeObject(catalogInput).profiles)
      .map(safeObject)
      .filter((profile) => {
        if (!validAgentId(profile.id) || seen.has(profile.id)) return false;
        seen.add(profile.id);
        return true;
      })
      .slice(0, 100);
  }

  function selectedAgentProfile(catalogInput, agentIdInput) {
    const profiles = agentProfiles(catalogInput);
    const requested = validAgentId(agentIdInput) ? agentIdInput : 'jarvis';
    return (
      profiles.find((profile) => profile.id === requested) ||
      profiles.find((profile) => profile.id === 'jarvis') ||
      profiles[0] ||
      null
    );
  }

  function agentTreeRows(catalogInput) {
    const catalog = safeObject(catalogInput);
    const profiles = agentProfiles(catalog);
    const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
    const seen = new Set();
    const rows = [];
    function visit(nodeInput, depth, parentId) {
      if (rows.length >= 100) return;
      const node = safeObject(nodeInput);
      const profile = profilesById.get(node.id);
      if (!profile || seen.has(profile.id)) return;
      seen.add(profile.id);
      const children = safeArray(node.children).filter(
        (child) => validAgentId(safeObject(child).id) && profilesById.has(safeObject(child).id)
      );
      rows.push({
        id: profile.id,
        displayName: boundedText(node.displayName || profile.displayName, humanize(profile.id)),
        role: boundedText(node.role || profile.role, 'Agent profile'),
        parentId: parentId || null,
        depth,
        hasChildren: children.length > 0,
        trustDomain: boundedText(node.trustDomain || profile.trustDomain, 'unknown'),
        runtimeMode: boundedText(node.runtimeMode || profile.runtimeMode, 'disabled'),
        availability: boundedText(
          node.availability || safeObject(profile.availability).state,
          'disabled'
        )
      });
      children.forEach((child) => visit(child, depth + 1, profile.id));
    }
    safeArray(safeObject(catalog.hierarchy).roots).forEach((root) => visit(root, 0, null));
    return rows;
  }

  function agentBreadcrumb(catalogInput, agentIdInput) {
    if (!validAgentId(agentIdInput)) return ['You'];
    const rows = agentTreeRows(catalogInput);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const names = [];
    const seen = new Set();
    let current = byId.get(agentIdInput);
    while (current && !seen.has(current.id) && names.length < 100) {
      seen.add(current.id);
      names.unshift(current.displayName);
      current = current.parentId ? byId.get(current.parentId) : null;
    }
    return names.length ? ['You', ...names] : ['You'];
  }

  function durableAgentRows(catalogInput) {
    const durableIds = new Set(
      agentProfiles(catalogInput)
        .filter((profile) => profile.lifecycle === 'durable')
        .map((profile) => profile.id)
    );
    return agentTreeRows(catalogInput).filter((row) => durableIds.has(row.id));
  }

  function agentMutationIsCurrent(tokenInput, currentInput) {
    const token = safeObject(tokenInput);
    const current = safeObject(currentInput);
    const validEpoch = (value) => Number.isSafeInteger(value) && value >= 0;
    const validConversationOrNull = (value) => value === null || validConversationId(value);
    return (
      validAgentId(token.agentId) &&
      validAgentId(current.agentId) &&
      validConversationOrNull(token.conversationId) &&
      validConversationOrNull(current.conversationId) &&
      validEpoch(token.navigationEpoch) &&
      validEpoch(current.navigationEpoch) &&
      validEpoch(token.mutationEpoch) &&
      validEpoch(current.mutationEpoch) &&
      token.agentId === current.agentId &&
      token.conversationId === current.conversationId &&
      token.navigationEpoch === current.navigationEpoch &&
      token.mutationEpoch === current.mutationEpoch
    );
  }

  function scopedAgentConversations(payloadInput, agentIdInput) {
    const agentId = validAgentId(agentIdInput) ? agentIdInput : '';
    const seen = new Set();
    return safeArray(safeObject(payloadInput).conversations)
      .map(safeObject)
      .filter((conversation) => {
        if (
          conversation.agentId !== agentId ||
          !validConversationId(conversation.id) ||
          !Number.isSafeInteger(conversation.version) ||
          conversation.version < 1 ||
          seen.has(conversation.id)
        )
          return false;
        seen.add(conversation.id);
        return true;
      })
      .slice(0, 100);
  }

  function scopedAgentMessages(payloadInput, agentIdInput, conversationIdInput) {
    const agentId = validAgentId(agentIdInput) ? agentIdInput : '';
    const conversationId = validConversationId(conversationIdInput) ? conversationIdInput : '';
    const seen = new Set();
    return safeArray(safeObject(payloadInput).messages)
      .map(safeObject)
      .filter((message) => {
        const operator =
          message.authorKind === 'operator' &&
          (message.respondingAgentId === null || message.respondingAgentId === undefined);
        const exactAgent = message.authorKind === 'agent' && message.respondingAgentId === agentId;
        if (
          message.agentId !== agentId ||
          message.conversationId !== conversationId ||
          !validMessageId(message.id) ||
          typeof message.text !== 'string' ||
          message.text.trim().length === 0 ||
          (!operator && !exactAgent) ||
          seen.has(message.id)
        )
          return false;
        seen.add(message.id);
        return true;
      })
      .slice(0, 200);
  }

  const MODEL_PROVIDER_DEFINITIONS = Object.freeze([
    Object.freeze({ provider: 'claude', displayName: 'Claude' }),
    Object.freeze({ provider: 'openai', displayName: 'OpenAI / ChatGPT' })
  ]);
  const MODEL_CONNECTION_STATES = Object.freeze([
    'connected',
    'disconnected',
    'unavailable',
    'check_failed'
  ]);

  function modelRuntimePresentation(runtimeInput) {
    const runtime = safeObject(runtimeInput);
    const enabled = runtime.enabled === true;
    const version =
      Number.isSafeInteger(runtime.version) && runtime.version >= 0 ? runtime.version : 0;
    const selectedProvider = MODEL_PROVIDER_DEFINITIONS.some(
      (definition) => definition.provider === runtime.selectedProvider
    )
      ? runtime.selectedProvider
      : null;
    const providerRecords = safeArray(runtime.providers).map(safeObject);
    const providers = MODEL_PROVIDER_DEFINITIONS.map((definition) => {
      const record =
        providerRecords.find((candidate) => candidate.provider === definition.provider) || {};
      const connectionState = MODEL_CONNECTION_STATES.includes(record.connectionState)
        ? record.connectionState
        : 'unavailable';
      const loginInProgress = record.loginInProgress === true;
      const connectionLabels = {
        connected: 'Connected',
        disconnected: 'Not connected',
        unavailable: 'Unavailable',
        check_failed: 'Status check failed'
      };
      return {
        provider: definition.provider,
        displayName: definition.displayName,
        connectionState,
        connectionLabel: loginInProgress ? 'Login in progress' : connectionLabels[connectionState],
        connected: connectionState === 'connected',
        loginAvailable: record.loginAvailable === true,
        loginInProgress,
        selected: enabled && selectedProvider === definition.provider,
        detail: boundedText(
          record.detail,
          connectionState === 'connected'
            ? 'The local subscription session is connected.'
            : 'No account details are shown.'
        )
      };
    });
    return { enabled, version, selectedProvider, providers };
  }

  function agentRuntimePresentation(profileInput, modelRuntimeInput) {
    const profile = safeObject(profileInput);
    const runtimeMode = profile.runtimeMode;
    const availability = safeObject(profile.availability).state;
    if (runtimeMode === 'deterministic' && availability === 'available') {
      const modelRuntime = modelRuntimePresentation(modelRuntimeInput);
      const selected = modelRuntime.providers.find((provider) => provider.selected);
      if (profile.id === 'jarvis' && selected) {
        return {
          label: `${selected.displayName} subscription`,
          detail: `Jarvis uses the selected ${selected.displayName} subscription for model replies and keeps deterministic fallback available.`,
          tone: 'ready',
          canMessage: true
        };
      }
      return {
        label: 'Deterministic · available',
        detail: 'Answers from bounded local read models.',
        tone: 'ready',
        canMessage: true
      };
    }
    if (runtimeMode === 'profile_only' && availability !== 'disabled') {
      return {
        label: 'Profile chat · no executor',
        detail: 'Profile questions work; execution requests return runtime not configured.',
        tone: 'neutral',
        canMessage: true
      };
    }
    return {
      label: 'Disabled',
      detail: 'This profile cannot accept conversation messages.',
      tone: 'blocked',
      canMessage: false
    };
  }

  function viewDefinition(view) {
    const requested = typeof view === 'string' ? view : '';
    const resolved = LEGACY_VIEWS[requested] || requested;
    return VIEW_DEFINITIONS[resolved] || VIEW_DEFINITIONS.today;
  }

  function createSourceState(names) {
    const state = {};
    safeArray(names)
      .filter((name) => SOURCE_NAMES.includes(name))
      .forEach((name) => {
        state[name] = {
          value: null,
          status: 'empty',
          sequence: 0,
          updatedAt: null,
          message: null
        };
      });
    return state;
  }

  function reduceSourceState(previousInput, eventInput) {
    const previous = safeObject(previousInput);
    const event = safeObject(eventInput);
    const source = typeof event.source === 'string' ? event.source : '';
    const current = safeObject(previous[source]);
    const sequence = count(event.sequence);
    if (!SOURCE_NAMES.includes(source) || !Object.hasOwn(previous, source)) return previous;
    if (sequence < count(current.sequence)) return previous;

    const next = { ...previous };
    if (event.type === 'source_succeeded') {
      next[source] = {
        value: event.value,
        status: 'fresh',
        sequence,
        updatedAt: boundedText(event.at, null),
        message: null
      };
      return next;
    }
    if (event.type === 'source_failed') {
      const hasLastGood = current.value !== null && current.value !== undefined;
      next[source] = {
        value: hasLastGood ? current.value : null,
        status: hasLastGood ? 'stale' : 'unavailable',
        sequence,
        updatedAt: current.updatedAt || null,
        message: boundedText(event.message, `${humanize(source)} unavailable`)
      };
      return next;
    }
    return previous;
  }

  function refreshPresentation(sourcesInput, optionsInput) {
    const sources = safeObject(sourcesInput);
    const options = safeObject(optionsInput);
    const required = safeArray(options.requiredSources).filter((name) =>
      SOURCE_NAMES.includes(name)
    );
    if (options.hidden === true) {
      return {
        mode: 'paused',
        label: 'Auto-refresh paused',
        detail: 'This tab is hidden; refresh resumes when it becomes visible.'
      };
    }
    const unavailable = required.filter(
      (name) => safeObject(sources[name]).status === 'unavailable'
    );
    const stale = required.filter((name) => safeObject(sources[name]).status === 'stale');
    const empty = required.filter((name) => safeObject(sources[name]).status === 'empty');
    if (unavailable.length > 0) {
      return {
        mode: 'disconnected',
        label: 'Sources unavailable',
        detail: `${unavailable.map(humanize).join(', ')} could not be loaded.`
      };
    }
    if (stale.length > 0) {
      return {
        mode: 'stale',
        label: 'Snapshot partially stale',
        detail: `${stale.map(humanize).join(', ')} retained last-good data.`
      };
    }
    if (empty.length > 0) {
      return {
        mode: 'active',
        label: 'Refreshing local sources',
        detail: 'Waiting for the current operator snapshot.'
      };
    }
    return {
      mode: 'active',
      label: 'Auto-refresh on',
      detail: 'Every 30 seconds while this tab is visible.'
    };
  }

  function checkValue(key, rawValue) {
    const value = typeof rawValue === 'string' ? rawValue : 'unavailable';
    if (value === 'ok') return { value: 'Available', available: true };
    if (key === 'disk' && /^ok:[0-9]{1,3}%_free$/.test(value)) {
      return { value: value.slice(3).replace('_', ' '), available: true };
    }
    if (value === 'down') return { value: 'Unavailable', available: false };
    return { value: 'Unavailable', available: false };
  }

  function healthPosture(healthInput) {
    const health = safeObject(healthInput);
    const checks = safeObject(health.checks);
    const evidence = CHECK_ORDER.filter((key) => Object.hasOwn(checks, key)).map((key) => {
      const result = checkValue(key, checks[key]);
      return {
        key,
        label: humanize(key),
        value: result.value,
        tone: result.available ? 'ready' : CORE_CHECKS.includes(key) ? 'blocked' : 'attention'
      };
    });
    const coreReady = CORE_CHECKS.every((key) => checkValue(key, checks[key]).available);
    const optionalUnavailable = evidence.filter(
      ({ key, tone }) => !CORE_CHECKS.includes(key) && tone === 'attention'
    );
    const action = health.action === 'escalate_P1' ? 'P1 review required' : 'No escalation';
    if (!coreReady) {
      const failed = evidence.filter(
        ({ key, tone }) => CORE_CHECKS.includes(key) && tone === 'blocked'
      );
      return {
        tone: 'blocked',
        label: 'Core not ready',
        summary: `${failed.map(({ label }) => label).join(', ') || 'Core checks'} unavailable · ${action}`,
        coreReady,
        evidence,
        action
      };
    }
    if (health.overall === 'degraded' || optionalUnavailable.length > 0) {
      return {
        tone: 'attention',
        label: 'Core ready',
        summary: `${optionalUnavailable.map(({ label }) => label).join(', ') || 'Optional dependency'} unavailable · ${action}`,
        coreReady,
        evidence,
        action
      };
    }
    return {
      tone: 'ready',
      label: 'Core ready',
      summary: 'Gateway, database, and disk checks passed.',
      coreReady,
      evidence,
      action
    };
  }

  function runSummary(runsInput) {
    const counts = safeObject(safeObject(runsInput).counts);
    const running = count(counts.running);
    const succeeded = count(counts.succeeded);
    const failed = count(counts.failed);
    return {
      running,
      succeeded,
      failed,
      total: running + succeeded + failed,
      value: `${running} running`,
      detail: `${succeeded} succeeded · ${failed} failed`
    };
  }

  function queueSummary(queueInput, laneInput, sourceStatusInput) {
    const available = queueInput && typeof queueInput === 'object' && !Array.isArray(queueInput);
    if (!available) {
      if (sourceStatusInput === 'empty') {
        return {
          available: false,
          ready: 0,
          blocked: 0,
          value: 'Loading',
          detail: 'Queue refresh in progress'
        };
      }
      return {
        available: false,
        ready: 0,
        blocked: 0,
        value: 'Unavailable',
        detail: 'Queue source not loaded'
      };
    }
    const lane = laneInput === 'task_market' ? 'task_market' : 'agency';
    const laneSnapshot = safeArray(safeObject(queueInput).lanes)
      .map(safeObject)
      .find((item) => item.lane === lane);
    const ready = safeArray(safeObject(laneSnapshot).ready).length;
    const blocked = safeArray(safeObject(laneSnapshot).blocked).length;
    return {
      available: true,
      ready,
      blocked,
      value: `${ready} ready`,
      detail: `${blocked} blocked · ${lane === 'task_market' ? 'task market' : 'agency'} lane`
    };
  }

  function operatorDecision(queueInput, laneInput) {
    const queue = safeObject(queueInput);
    const lane = laneInput === 'task_market' ? 'task_market' : 'agency';
    const laneSnapshot = safeArray(queue.lanes)
      .map(safeObject)
      .find((item) => item.lane === lane);
    const ready = safeArray(safeObject(laneSnapshot).ready);
    const blocked = safeArray(safeObject(laneSnapshot).blocked);
    const item = safeObject(ready[0] || blocked[0]);
    if (!item.id) {
      return {
        available: false,
        subject: 'No queued decision',
        state: 'No work ready',
        whyNow: 'No work is ready or blocked in this lane.',
        href: null,
        cta: null
      };
    }
    const isReady = ready.length > 0;
    const kind = item.payloadKind;
    const state = !isReady
      ? 'Blocked by dependencies'
      : kind === 'automation'
        ? 'Automation eligible for worker claim'
        : kind === 'operator_gate'
          ? 'Operator review ready'
          : 'Project work ready';
    const band = ['P0', 'P1', 'P2', 'P3'].includes(item.band) ? item.band : 'P3';
    const blockedCount = count(item.blockedDependencyCount);
    const href = isReady && kind === 'operator_gate' ? '/dashboard?view=growth' : null;
    return {
      available: true,
      subject: humanize(item.id),
      state,
      whyNow: isReady
        ? `${band} policy band · available now · dependency checks passed`
        : `${plural(blockedCount, 'dependency')} must complete before this work becomes ready`,
      href,
      cta: href ? 'Open Growth review' : null
    };
  }

  function queueRowPresentation(itemInput, indexInput, nowInput) {
    const item = safeObject(itemInput);
    const ordinal = String(count(indexInput) + 1).padStart(2, '0');
    const owner = boundedText(item.ownerDisplayName || item.ownerId || item.claimedBy, 'Unclaimed');
    const observedAt = new Date(item.timestamp);
    const now = new Date(nowInput || Date.now());
    let age = 'Age unknown';
    if (!Number.isNaN(observedAt.getTime()) && !Number.isNaN(now.getTime())) {
      const minutes = Math.max(0, Math.floor((now.getTime() - observedAt.getTime()) / 60_000));
      if (minutes < 1) age = '<1m';
      else if (minutes < 60) age = `${minutes}m`;
      else if (minutes < 1_440) age = `${Math.floor(minutes / 60)}h`;
      else age = `${Math.floor(minutes / 1_440)}d`;
    }
    return {
      ordinal,
      owner,
      age,
      status: humanize(item.readiness),
      whyNow: boundedText(item.whyNow, 'Ordering evidence unavailable')
    };
  }

  function actionProposalPresentation(proposalInput, nowInput) {
    const proposal = safeObject(proposalInput);
    const now = new Date(nowInput || Date.now());
    const expiresAt = new Date(proposal.expiresAt);
    if (
      typeof proposal.id !== 'string' ||
      !/^proposal:[a-f0-9]{64}$/u.test(proposal.id) ||
      !Number.isSafeInteger(proposal.version) ||
      proposal.version < 1 ||
      proposal.expectedVersion !== proposal.version ||
      proposal.state !== 'pending' ||
      typeof proposal.confirmationFingerprint !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/u.test(proposal.confirmationFingerprint) ||
      Number.isNaN(now.getTime()) ||
      Number.isNaN(expiresAt.getTime()) ||
      expiresAt.getTime() <= now.getTime()
    )
      return null;
    return {
      id: proposal.id,
      title: humanize(proposal.kind),
      detail: `${humanize(proposal.channel)} proposal · expires ${expiresAt.toISOString()}`,
      aside: `${humanize(proposal.risk)} risk`,
      expectedVersion: proposal.version,
      confirmationFingerprint: proposal.confirmationFingerprint
    };
  }

  function actionProposalDecisionBody(proposalInput, verdictInput, nowInput) {
    const proposal = actionProposalPresentation(proposalInput, nowInput);
    if (!proposal || !['approved', 'rejected'].includes(verdictInput)) return null;
    return {
      verdict: verdictInput,
      expectedVersion: proposal.expectedVersion,
      confirmationFingerprint: proposal.confirmationFingerprint
    };
  }

  function actionProposalDecisionOutcome(proposalInput, responseInput, nowInput) {
    const proposal = safeObject(proposalInput);
    const presentation = actionProposalPresentation(proposal, nowInput);
    const response = safeObject(responseInput);
    const decision = safeObject(response.decision);
    if (
      !presentation ||
      typeof decision.id !== 'string' ||
      !/^decision:[a-f0-9]{64}$/u.test(decision.id) ||
      decision.proposalId !== presentation.id ||
      !['approved', 'rejected'].includes(decision.verdict) ||
      decision.proposalVersion !== presentation.expectedVersion + 1
    ) {
      return {
        outcome: 'unconfirmed',
        message: 'The action-proposal response did not match the exact pending decision.'
      };
    }
    if (decision.verdict === 'rejected') {
      return {
        outcome: 'rejected',
        message: `${presentation.title} was rejected. No runtime effect was applied.`
      };
    }
    if (proposal.kind !== 'pause_runtime') {
      return {
        outcome: 'recorded_only',
        message: `${presentation.title} was approved. The decision was recorded; no runtime effect is configured.`
      };
    }

    const posture = safeObject(response.executionPosture);
    if (
      posture.posture === 'paused' &&
      posture.sourceProposalId === presentation.id &&
      posture.sourceProposalVersion === decision.proposalVersion &&
      posture.sourceConfirmationFingerprint === presentation.confirmationFingerprint &&
      posture.sourceDecisionId === decision.id
    ) {
      return {
        outcome: 'effect_applied',
        message: `${presentation.title} was approved. The exact approved runtime pause was applied.`
      };
    }
    return {
      outcome: 'unconfirmed',
      message: `${presentation.title} was approved, but the resulting runtime pause could not be confirmed.`
    };
  }

  function boundedListSummary(returnedInput, totalInput, noun) {
    const returned = count(returnedInput);
    const total = Math.max(returned, count(totalInput));
    return returned === total
      ? `Showing all ${plural(total, noun)}`
      : `Showing ${returned} of ${plural(total, noun)}`;
  }

  function nextRefreshDelay(failureCountInput) {
    const failureCount = Math.min(count(failureCountInput), 8);
    return Math.min(30_000 * 2 ** failureCount, 300_000);
  }

  function statusClass(kindInput, valueInput) {
    const kind = typeof kindInput === 'string' ? kindInput : '';
    const value = typeof valueInput === 'string' ? valueInput : '';
    const mapping = STATUS_CLASSES[kind];
    return (
      (mapping && mapping[value]) || (kind === 'priority' ? 'priority-unknown' : 'status-unknown')
    );
  }

  function shouldHandleNavigation(metaInput) {
    const meta = safeObject(metaInput);
    return (
      meta.defaultPrevented !== true &&
      meta.button === 0 &&
      meta.metaKey !== true &&
      meta.ctrlKey !== true &&
      meta.shiftKey !== true &&
      meta.altKey !== true
    );
  }

  return Object.freeze({
    VIEW_DEFINITIONS,
    actionProposalDecisionBody,
    actionProposalDecisionOutcome,
    actionProposalPresentation,
    agentBreadcrumb,
    agentMutationIsCurrent,
    agentProfiles,
    agentRuntimePresentation,
    agentTreeRows,
    boundedListSummary,
    createSourceState,
    durableAgentRows,
    healthPosture,
    modelRuntimePresentation,
    nextRefreshDelay,
    operatorDecision,
    queueRowPresentation,
    queueSummary,
    reduceSourceState,
    refreshPresentation,
    runSummary,
    scopedAgentConversations,
    scopedAgentMessages,
    selectedAgentProfile,
    shouldHandleNavigation,
    statusClass,
    viewDefinition
  });
});
