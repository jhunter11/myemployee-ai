import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(__dirname, '..', '..', 'public', 'dashboard', 'assets', 'app.js'),
  'utf8'
);

describe('Agent Workbench browser integration contract', () => {
  it('loads the catalog through the ordinary resilient source lifecycle', () => {
    expect(source).toContain("agents: '/agents'");
    expect(source).toContain("if (source === 'agents')");
    expect(source).toContain('CORE.agentProfiles(state.agents)');
    expect(source).toContain('CORE.agentTreeRows(state.agents)');
    expect(source).toContain('restoreAgentSelectionFromUrl');
    expect(source).toContain('document.body.dataset.activeView = selected');
  });

  it('uses exact nested routes and sends no browser-selected trust domain or agent authority', () => {
    expect(source).toContain(
      '`/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}/messages`'
    );
    expect(source).toContain('`/agents/${encodeURIComponent(agentId)}/conversations`');
    expect(source).toContain(
      'body: JSON.stringify({ message, expectedVersion: conversation.version })'
    );
    expect(source).toContain('body: JSON.stringify(title ? { title } : {})');
    expect(source).not.toMatch(/JSON\.stringify\([^)]*trustDomain/s);
    expect(source).not.toMatch(/JSON\.stringify\([^)]*toolGrant/s);
  });

  it('restores URL selection and filters returned records to the exact binding', () => {
    expect(source).toContain('NAVIGATION.selectedAgentId(window.location.href, profiles())');
    expect(source).toContain('NAVIGATION.selectedConversationId(');
    expect(source).toContain('CORE.scopedAgentConversations(response, agentId)');
    expect(source).toContain('CORE.scopedAgentMessages(response, agentId, conversationId)');
    expect(source).toContain("updateAgentUrl(agentId, state.selectedConversationId, 'replace')");
  });

  it('fails closed when an in-flight mutation finishes after agent navigation', () => {
    expect(source).toContain('agentNavigationEpoch: 0');
    expect(source).toContain('agentMutationEpoch: 0');
    expect(source).toContain('agentMutationAgentId: null');
    expect(source).toContain('function beginAgentMutation(');
    expect(source).toContain('function agentMutationIsCurrent(');
    expect(source).toContain('CORE.agentMutationIsCurrent(token, {');
    expect(source).toContain('state.agentNavigationEpoch += 1');
    expect(source).toContain('if (!agentMutationIsCurrent(mutation))');
    expect(source).toContain(
      'Previous agent request is finishing; this selection remains isolated.'
    );
  });

  it('renders keyboard-selectable hierarchy, profiles, and the shared Agent Floor', () => {
    expect(source).toContain("expandedAgentIds: new Set(['jarvis', 'agency'])");
    expect(source).toContain("focusedAgentId: 'jarvis'");
    expect(source).toContain('function visibleAgentRows()');
    expect(source).toContain('toggleAgentExpansion(row.id)');
    expect(source).toContain("item.setAttribute('role', 'treeitem')");
    expect(source).toContain("item.setAttribute('aria-level', String(row.depth + 1))");
    expect(source).toContain("event.key === 'ArrowDown'");
    expect(source).toContain("event.key === 'ArrowLeft'");
    expect(source).toContain("event.key === 'ArrowRight'");
    expect(source).toContain('function focusRenderedAgentTreeItem(');
    expect(source).toContain('CORE.durableAgentRows(state.agents)');
    expect(source).toContain("tree.removeAttribute('role')");
    expect(source).toContain("window.matchMedia('(max-width: 720px)').matches");
    expect(source).toContain("$('#agent-registry-details').open = false");
    expect(source).toContain('function renderAgentProfile()');
    expect(source).toContain('function renderAgentFloor()');
    expect(source).toContain("$('#agent-floor-registry')");
  });

  it('renders scope-honest identity and the full root-to-agent breadcrumb', () => {
    expect(source).toContain('CORE.agentBreadcrumb(state.agents, profile.id)');
    expect(source).toContain("$('.agent-chat-header .eyebrow').textContent");
    expect(source).toContain('`${label(profile.trustDomain)} scope · ${profile.role}`');
  });

  it('shows the exact memory, knowledge, continuation, escalation, and budget manifest', () => {
    expect(source).toContain("profileFact('Scratch sleeve'");
    expect(source).toContain("'Readable sleeves'");
    expect(source).toContain("'Propose-write sleeves'");
    expect(source).toContain('knowledge.partitionId');
    expect(source).toContain("profileFact(\n        'Checkpoint'");
    expect(source).toContain("profileFact(\n        'Resume'");
    expect(source).toContain("profileFact(\n        'Escalation'");
    expect(source).toContain('budgets.maxEstimatedTokens');
    expect(source).toContain('budgets.maxChildRuns');
  });

  it('shows unavailable execution honestly and renders server text only through DOM APIs', () => {
    expect(source).toContain("message.responseMode === 'runtime_not_configured'");
    expect(source).toContain('Runtime not configured · no work performed');
    expect(source).toContain('did not run work; its execution runtime is not configured');
    expect(source).toContain('error.code = payload.error.code');
    expect(source).toContain('error.status = response.status');
    expect(source).toContain("error.code === 'DASHBOARD_AGENT_CONVERSATION_VERSION_CONFLICT'");
    expect(source).not.toContain('.innerHTML');
    expect(source).not.toContain("request('/chat'");
  });

  it('states the real effect of an exact action-proposal decision', () => {
    expect(source).toContain("proposalKind === 'pause_runtime'");
    expect(source).toContain('approval applies the exact runtime pause immediately');
    expect(source).toContain("? 'Applying…'");
    expect(source).toContain(": 'Approve and pause'");
    expect(source).toContain('const result = await request(');
    expect(source).toContain('CORE.actionProposalDecisionOutcome(proposal, result)');
    expect(source).toContain(
      'Decision outcome is unknown; reconciling current posture and pending proposals.'
    );
    expect(
      source.match(/await load\(\{ manual: true, sources: \['agency', 'personal'\] \}\);/gu)
    ).toHaveLength(2);
    expect(source).not.toContain(
      'approval records the decision only; no runtime effect executes automatically'
    );
    expect(source).not.toContain('it did not execute the proposed effect');
  });
});
