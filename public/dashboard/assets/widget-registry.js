(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JarvisWidgetRegistry = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const ITEM_LIMIT = 5;

  function safeObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function count(value) {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  }

  function boundedText(value, fallback) {
    const candidate = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    const normalized = candidate.replace(/\s+/g, ' ').trim();
    return (normalized || fallback).slice(0, 240);
  }

  function humanize(value, fallback) {
    const normalized = boundedText(value, fallback).replace(/[-_]+/g, ' ');
    return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
  }

  function plural(value, noun) {
    return `${value} ${noun}${value === 1 ? '' : 's'}`;
  }

  function money(microUsd) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 6
    }).format(count(microUsd) / 1_000_000);
  }

  function item(title, detail, aside) {
    return Object.freeze({
      title: boundedText(title, 'Untitled item'),
      detail: boundedText(detail, 'No bounded detail is available.'),
      aside: boundedText(aside, '')
    });
  }

  function card(title, content, items) {
    const normalized = {
      title: boundedText(title, 'Widget'),
      content: boundedText(content, 'No bounded summary is available.')
    };
    const visibleItems = safeArray(items).slice(0, ITEM_LIMIT);
    return Object.freeze(
      visibleItems.length > 0 ? { ...normalized, items: Object.freeze(visibleItems) } : normalized
    );
  }

  function sourceContext(input) {
    const context = safeObject(input);
    return {
      overview: safeObject(context.overview),
      graph: safeObject(context.graph),
      queueItems: safeArray(context.queueItems),
      revenueCards: safeArray(context.revenueCards),
      personal: safeObject(context.personal),
      agency: safeObject(context.agency),
      pnl: safeObject(context.pnl)
    };
  }

  /**
   * Expense coverage is rendered as words, never as a bare $0. A sleeve billed
   * entirely through a flat-rate subscription has a genuinely unknown per-call
   * cost (ADR-003), so presenting its spend as zero would understate it.
   */
  function expenseText(expense) {
    const known = money(expense.knownMicroUsd);
    if (expense.coverage === 'complete') return `${known} metered`;
    if (expense.coverage === 'none') {
      return `no known cost · ${plural(count(expense.uncoveredEvents), 'uncovered call')}`;
    }
    return `${known} known · ${plural(count(expense.uncoveredEvents), 'uncovered call')}`;
  }

  const definitions = [
    {
      id: 'health',
      title: 'Health',
      source: 'overview',
      present(context) {
        const health = safeObject(context.overview.health);
        return [
          card(
            'Health',
            health.overall === 'healthy'
              ? 'All checked services are healthy.'
              : 'At least one checked service requires operator attention.'
          )
        ];
      }
    },
    {
      id: 'clients',
      title: 'Clients',
      source: 'overview',
      present(context) {
        const clients = safeObject(context.overview.clients);
        const rows = safeArray(clients.items).map((client) => {
          const value = safeObject(client);
          return item(
            value.name || value.id,
            humanize(value.profile, 'Profile unavailable'),
            boundedText(value.status, 'unknown')
          );
        });
        return [
          card(
            'Clients',
            `${plural(count(safeObject(clients.counts).total), 'client')} registered.`,
            rows
          )
        ];
      }
    },
    {
      id: 'recent-runs',
      title: 'Recent runs',
      source: 'overview',
      present(context) {
        const runs = safeArray(safeObject(context.overview.runs).recent);
        const rows = runs.map((run) => {
          const value = safeObject(run);
          return item(
            humanize(value.automation, 'Bounded run'),
            `${boundedText(value.clientId, 'No client')} · ${boundedText(value.workerId, 'No worker')}`,
            boundedText(value.status, 'unknown')
          );
        });
        return [card('Recent runs', `${plural(runs.length, 'bounded run')} available.`, rows)];
      }
    },
    {
      id: 'run-supervision',
      title: 'Run supervision',
      source: 'overview',
      present(context) {
        const runs = safeArray(safeObject(context.overview.runs).recent);
        const rows = runs.map((run) => {
          const value = safeObject(run);
          const supervisor = safeObject(value.supervisor);
          return item(
            humanize(value.automation, 'Bounded run'),
            `Supervised by ${boundedText(supervisor.label, 'Jarvis')} · ${boundedText(supervisor.sleeveId, 'system')} sleeve`,
            boundedText(value.status, 'unknown')
          );
        });
        const supervised = runs.filter(
          (run) => safeObject(safeObject(run).supervisor).kind === 'delegating_run'
        ).length;
        return [
          card(
            'Run supervision',
            `${plural(runs.length, 'run')} · ${plural(supervised, 'delegated run')}. Supervisors come from recorded edges only.`,
            rows
          )
        ];
      }
    },
    {
      id: 'sleeve-pnl',
      title: 'Sleeve P&L',
      source: 'pnl',
      present(context) {
        const pnl = context.pnl;
        const sleeves = safeArray(pnl.sleeves);
        const system = safeObject(pnl.system);
        const rows = sleeves.map((sleeve) => {
          const value = safeObject(sleeve);
          const expense = safeObject(value.expense);
          return item(
            boundedText(value.label, 'Sleeve'),
            `${expenseText(expense)} · no recognized revenue`,
            money(expense.knownMicroUsd)
          );
        });
        const systemExpense = safeObject(system.expense);
        return [
          card(
            'Sleeve P&L',
            `${expenseText(systemExpense)} across ${plural(sleeves.length, 'sleeve')}. Recognized revenue is 0; pipeline is never valued.`,
            rows
          )
        ];
      }
    },
    {
      id: 'attention',
      title: 'Attention',
      source: 'overview',
      present(context) {
        const attention = safeObject(context.overview.attention);
        const rows = safeArray(attention.recent).map((entry) => {
          const value = safeObject(entry);
          return item(
            `Audit ${boundedText(value.id, 'item')}`,
            `${boundedText(value.clientId, 'System')} · ${boundedText(value.runId, 'No run')}`,
            boundedText(value.severity, 'unknown')
          );
        });
        return [
          card('Attention', `${plural(count(attention.unresolvedCount), 'unresolved item')}.`, rows)
        ];
      }
    },
    {
      id: 'toolsmith',
      title: 'Improvements',
      source: 'overview',
      present(context) {
        const proposals = safeArray(safeObject(context.overview.improvements).proposals);
        const rows = proposals.map((proposal) => {
          const value = safeObject(proposal);
          return item(
            humanize(value.taskSignature, 'Repeated task'),
            'Proposal only; no repository change has been applied.',
            plural(count(value.executionCount), 'execution')
          );
        });
        return [card('Improvements', `${plural(proposals.length, 'proposal')} in review.`, rows)];
      }
    },
    {
      id: 'memory-graph',
      title: 'Memory graph',
      source: 'graph',
      present(context) {
        const nodes = safeArray(context.graph.nodes);
        const edges = safeArray(context.graph.edges);
        const rows = nodes.map((node) => {
          const value = safeObject(node);
          return item(value.title || value.id, humanize(value.type, 'Graph node'), 'global graph');
        });
        return [
          card(
            'Memory graph',
            `${plural(nodes.length, 'node')} and ${plural(edges.length, 'edge')}.`,
            rows
          )
        ];
      }
    },
    {
      id: 'model-economics',
      title: 'Model economics',
      source: 'overview',
      present(context) {
        const economics = safeObject(context.overview.economics);
        if (economics.status !== 'available') {
          return [
            card(
              'Model economics',
              economics.reason || 'No model-call telemetry has been recorded; cost remains unknown.'
            )
          ];
        }
        const usage = safeObject(economics.usage);
        const cost = safeObject(economics.cost);
        const knownCostEvents = count(cost.observedCostEvents) + count(cost.estimatedCostEvents);
        const summary = `${plural(count(usage.requestCount), 'request')} · ${count(usage.inputTokens) + count(usage.outputTokens)} tokens · ${knownCostEvents > 0 ? `${money(cost.knownMicroUsd)} known cost` : 'cost unknown'}.`;
        const rows = safeArray(economics.models).map((model) => {
          const value = safeObject(model);
          return item(
            `${boundedText(value.provider, 'provider')} / ${boundedText(value.model, 'model')}`,
            `${humanize(value.route, 'Route unavailable')} · ${count(value.inputTokens) + count(value.outputTokens)} tokens`,
            plural(count(value.requestCount), 'request')
          );
        });
        return [card('Model economics', summary, rows)];
      }
    },
    {
      id: 'work-queue',
      title: 'Work queue',
      source: 'queue',
      present(context) {
        const tasks = context.queueItems;
        const ready = tasks.filter((task) => safeObject(task).readiness === 'ready').length;
        const rows = tasks.map((task) => {
          const value = safeObject(task);
          return item(
            value.title,
            `${humanize(value.payloadKind, 'Bounded task')} · ${boundedText(value.whyNow, 'No readiness evidence.')}`,
            `${boundedText(value.priority, 'P3')} · ${boundedText(value.readiness, 'unknown')}`
          );
        });
        return [
          card(
            'Work queue',
            `${plural(tasks.length, 'bounded task')} · ${ready} ready · ${tasks.length - ready} blocked.`,
            rows
          )
        ];
      }
    },
    {
      id: 'revenue-pipeline',
      title: 'Revenue pipeline',
      source: 'revenue',
      present(context) {
        return context.revenueCards.map((entry) => {
          const value = safeObject(entry);
          return card(value.title, value.content, value.items);
        });
      }
    },
    {
      id: 'daily-briefing',
      title: 'Daily briefing',
      source: 'personal',
      present(context) {
        const briefing = safeObject(context.personal.briefing);
        const rows = safeArray(briefing.nextEvents).map((event) => {
          const value = safeObject(event);
          return item(
            value.title,
            boundedText(value.location, 'No location'),
            boundedText(value.start, 'Time unavailable')
          );
        });
        return [card('Daily briefing', briefing.headline || 'Briefing unavailable.', rows)];
      }
    },
    {
      id: 'personal-calendar',
      title: 'Personal calendar',
      source: 'personal',
      present(context) {
        const calendar = safeObject(context.personal.calendar);
        const events = safeArray(calendar.events);
        const conflicts = safeArray(calendar.conflicts).length;
        const rows = events.map((event) => {
          const value = safeObject(event);
          return item(
            value.title,
            `${boundedText(value.location, 'No location')} · ${humanize(value.source, 'Source unavailable')}`,
            boundedText(value.start, 'Time unavailable')
          );
        });
        return [
          card(
            'Personal calendar',
            `${plural(events.length, 'event')} · ${plural(conflicts, 'conflict')}${calendar.truncated ? ' · bounded list truncated' : ''}.`,
            rows
          )
        ];
      }
    },
    {
      id: 'personal-memory',
      title: 'Personal memory',
      source: 'personal',
      present(context) {
        const memory = safeObject(context.personal.memory);
        const records = safeArray(memory.records);
        const due = safeArray(memory.reviewDue);
        const showingDue = due.length > 0;
        const visible = due.length > 0 ? due : records;
        const rows = visible.map((record) => {
          const value = safeObject(record);
          const confidence = Math.round(Math.min(1, Number(value.confidence) || 0) * 100);
          return item(
            value.title,
            `${humanize(value.branch, 'Memory')} · ${confidence}% confidence`,
            showingDue ? 'review due' : value.reviewAt ? 'review scheduled' : 'recorded'
          );
        });
        return [
          card(
            'Personal memory',
            `${plural(records.length, 'private record')} · ${due.length} due for review.`,
            rows
          )
        ];
      }
    },
    {
      id: 'agency-control',
      title: 'Agency control',
      source: 'agency',
      present(context) {
        const agency = context.agency;
        const autonomous = safeArray(agency.autonomous);
        const approvals = safeArray(agency.approvalRequired);
        const blocked = safeArray(agency.blocked);
        const rows = [
          ...approvals.map((action) => ({ action, state: 'approval' })),
          ...blocked.map((action) => ({ action, state: 'blocked' })),
          ...autonomous.map((action) => ({ action, state: 'autonomous' }))
        ].map(({ action, state }) => {
          const value = safeObject(action);
          return item(
            value.label || value.id,
            value.reason || 'Bounded by agency policy.',
            `${humanize(value.category, 'Action')} · ${state}`
          );
        });
        return [
          card(
            'Agency control',
            `${plural(autonomous.length, 'autonomous action')} · ${plural(approvals.length, 'approval')} · ${plural(blocked.length, 'blocked action')}.`,
            rows
          )
        ];
      }
    }
  ].map((definition) => Object.freeze(definition));

  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const publicDefinitions = Object.freeze(
    definitions.map(({ id, title, source }) => Object.freeze({ id, title, source }))
  );
  const publicById = new Map(publicDefinitions.map((definition) => [definition.id, definition]));

  function list() {
    return publicDefinitions;
  }

  function definition(id) {
    return publicById.get(id) || null;
  }

  function sourceFor(id) {
    return definition(id)?.source || null;
  }

  function cardsFor(id, input) {
    const selected = byId.get(id);
    if (!selected) return [];
    return Object.freeze(selected.present(sourceContext(input)).slice(0, 6));
  }

  return Object.freeze({ list, definition, sourceFor, cardsFor });
});
