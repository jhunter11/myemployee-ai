import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

interface NavigationApi {
  selectedAgentId(href: string, agents: Array<{ id: string }>): string;
  selectedConversationId(href: string, conversations: Array<{ id: string }>): string | null;
  agentUrl(href: string, agentId: string, conversationId?: string | null): string;
  viewUrl(href: string, view: string): string;
}

function navigation(): NavigationApi {
  const source = readFileSync(
    join(__dirname, '..', '..', 'public', 'dashboard', 'assets', 'navigation.js'),
    'utf8'
  );
  const context: { URL: typeof URL; JarvisDashboardNavigation?: NavigationApi } = { URL };
  runInNewContext(source, context);
  if (context.JarvisDashboardNavigation === undefined) throw new Error('navigation unavailable');
  return context.JarvisDashboardNavigation;
}

describe('agent workbench URL state', () => {
  const agents = [{ id: 'jarvis' }, { id: 'agency' }, { id: 'mcp-x402' }];

  it('restores only catalog agents and known conversations', () => {
    const api = navigation();
    const href = 'http://127.0.0.1:3187/dashboard?view=chat&agent=agency&conversation=conv-1';

    expect(api.selectedAgentId(href, agents)).toBe('agency');
    expect(api.selectedAgentId(href.replace('agency', 'guessed-agent'), agents)).toBe('jarvis');
    expect(api.selectedConversationId(href, [{ id: 'conv-1' }])).toBe('conv-1');
    expect(api.selectedConversationId(href, [{ id: 'conv-2' }])).toBeNull();
  });

  it('builds a workbench link and clears stale selection when leaving chat', () => {
    const api = navigation();
    const selected = api.agentUrl(
      'http://127.0.0.1:3187/dashboard?view=agency&page=stale&lane=agency',
      'mcp-x402',
      'conv-7'
    );
    expect(selected).toBe(
      'http://127.0.0.1:3187/dashboard?view=chat&lane=agency&agent=mcp-x402&conversation=conv-7'
    );

    const switched = api.agentUrl(selected, 'agency');
    expect(switched).toBe('http://127.0.0.1:3187/dashboard?view=chat&lane=agency&agent=agency');

    expect(api.viewUrl(switched, 'queue')).toBe(
      'http://127.0.0.1:3187/dashboard?view=queue&lane=agency'
    );
  });
});
