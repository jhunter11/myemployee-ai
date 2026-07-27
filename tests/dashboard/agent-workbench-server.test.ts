import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkerRegistry } from '../../src/agents/worker-registry';
import type { HealthProvider } from '../../src/gateway/app';
import { startServer, type StartedServer } from '../../src/gateway/server';

const projectRoot = join(__dirname, '..', '..');
const now = '2026-07-21T17:00:00.000Z';
const heartbeat: HealthProvider = {
  check: () =>
    Promise.resolve({
      timestamp: now,
      overall: 'healthy',
      severity: 'none',
      checks: { gateway: 'ok', database: 'ok', disk: 'ok:50%' },
      failures: [],
      action: 'none'
    })
};

describe('production Agent Workbench composition', () => {
  let temporaryRoot: string;
  let databaseFile: string;
  let started: StartedServer | undefined;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-agent-workbench-server-'));
    databaseFile = join(temporaryRoot, 'jarvis.sqlite');
  });

  afterEach(async () => {
    await started?.stop();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  async function start(): Promise<string> {
    started = await startServer({
      projectRoot,
      databaseFile,
      clientRoot: join(temporaryRoot, 'clients'),
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot: join(temporaryRoot, 'memory', 'graph'),
      workerRegistry: new WorkerRegistry(),
      heartbeat,
      monitoring: false,
      automationCycling: false,
      now: () => now,
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });
    return `http://127.0.0.1:${started.port}`;
  }

  it('serves the real hierarchy and preserves exact-agent profile chat across restart', async () => {
    let baseUrl = await start();
    const catalogResponse = await fetch(`${baseUrl}/api/v1/dashboard/agents`);
    expect(catalogResponse.status).toBe(200);
    expect(catalogResponse.headers.get('cache-control')).toBe('no-store');
    const catalog = (await catalogResponse.json()) as {
      profiles: Array<{
        id: string;
        trustDomain: string;
        toolGrants: Array<{ id: string }>;
      }>;
      hierarchy: { totalCount: number; roots: Array<{ id: string }> };
    };
    expect(catalog.profiles).toHaveLength(45);
    expect(catalog.hierarchy).toMatchObject({ totalCount: 45, roots: [{ id: 'jarvis' }] });
    expect(
      catalog.profiles
        .filter(({ trustDomain }) => trustDomain === 'task_market')
        .flatMap(({ toolGrants }) => toolGrants.map(({ id }) => id))
        .join(' ')
    ).not.toMatch(/(?:^|[. :_-])(?:wallet|sign|signing|withdraw|mainnet)(?:[. :_-]|$)/iu);

    const createResponse = await fetch(
      `${baseUrl}/api/v1/dashboard/agents/agency-developer-code-red/conversations`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Review contract' })
      }
    );
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      conversation: { id: string; agentId: string; trustDomain: string; version: number };
    };
    expect(created.conversation).toMatchObject({
      agentId: 'agency-developer-code-red',
      trustDomain: 'agency',
      version: 1
    });

    const messagePath = `/api/v1/dashboard/agents/agency-developer-code-red/conversations/${created.conversation.id}/messages`;
    const sendResponse = await fetch(`${baseUrl}${messagePath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'What is your purpose and runtime status?',
        expectedVersion: 1
      })
    });
    expect(sendResponse.status).toBe(200);
    const exchange = (await sendResponse.json()) as {
      conversation: { version: number };
      messages: Array<{ respondingAgentId: string | null; responseMode: string }>;
      reply: { respondingAgentId: string; responseMode: string; text: string };
    };
    expect(exchange).toMatchObject({
      conversation: { version: 3 },
      reply: {
        respondingAgentId: 'agency-developer-code-red',
        responseMode: 'profile'
      }
    });
    expect(exchange.reply.text).toMatch(/purpose/iu);
    expect(exchange.messages.map(({ respondingAgentId }) => respondingAgentId)).toEqual([
      null,
      'agency-developer-code-red'
    ]);

    await started?.stop();
    started = undefined;
    baseUrl = await start();

    const persistedResponse = await fetch(`${baseUrl}${messagePath}`);
    expect(persistedResponse.status).toBe(200);
    await expect(persistedResponse.json()).resolves.toMatchObject({
      messages: [
        { authorKind: 'operator', responseMode: 'operator_input' },
        {
          authorKind: 'agent',
          respondingAgentId: 'agency-developer-code-red',
          responseMode: 'profile'
        }
      ]
    });

    const crossAgentResponse = await fetch(
      `${baseUrl}/api/v1/dashboard/agents/mcp-x402/conversations/${created.conversation.id}/messages`
    );
    expect(crossAgentResponse.status).toBe(404);
    await expect(crossAgentResponse.json()).resolves.toMatchObject({
      error: { code: 'DASHBOARD_AGENT_CONVERSATION_NOT_FOUND' }
    });
  });
});
