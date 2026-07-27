import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import SQLite from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkerRegistry } from '../../src/agents/worker-registry';
import type { SubscriptionRuntimeStatus } from '../../src/models/subscription-runtime';
import type { HealthProvider } from '../../src/gateway/app';
import { startServer, type StartedServer } from '../../src/gateway/server';

const projectRoot = join(__dirname, '..', '..');
const now = '2026-07-23T21:00:00.000Z';
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

const connectedProviders: SubscriptionRuntimeStatus[] = [
  {
    provider: 'claude',
    connectionState: 'connected',
    loginAvailable: true,
    loginInProgress: false,
    detail: 'Subscription login confirmed'
  },
  {
    provider: 'openai',
    connectionState: 'connected',
    loginAvailable: true,
    loginInProgress: false,
    detail: 'Subscription login confirmed'
  }
];

describe('production dashboard model-chat composition', () => {
  let temporaryRoot: string;
  let databaseFile: string;
  let started: StartedServer | undefined;
  const claudeRunner = vi.fn();

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-model-chat-server-'));
    databaseFile = join(temporaryRoot, 'jarvis.sqlite');
    claudeRunner.mockReset();
    claudeRunner.mockResolvedValue({
      stdout: JSON.stringify({
        result: 'A real model-path answer from the selected subscription.',
        is_error: false,
        usage: { input_tokens: 24, output_tokens: 11 }
      }),
      stderr: '',
      code: 0,
      timedOut: false
    });
  });

  afterEach(async () => {
    await started?.stop();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  async function start(): Promise<string> {
    const subscriptionRuntime = {
      snapshot: () => Promise.resolve(structuredClone(connectedProviders)),
      status: (provider: 'claude' | 'openai') =>
        Promise.resolve(
          structuredClone(
            connectedProviders.find((candidate) => candidate.provider === provider)
          ) as SubscriptionRuntimeStatus
        ),
      startLogin: (provider: 'claude' | 'openai') =>
        Promise.resolve({
          provider,
          outcome: 'started' as const,
          detail: 'Subscription login started'
        })
    };
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
      providerRecovery: false,
      subscriptionRuntime,
      modelStack: {
        claude: {
          command: '/test/claude',
          credentialProbe: () =>
            Promise.resolve({
              provider: 'claude',
              available: true,
              detail: 'verified subscription test double'
            }),
          runner: claudeRunner,
          systemPromptFileLifecycle: () =>
            Promise.resolve({
              path: '/private/test/system-prompt.txt',
              cleanup: () => Promise.resolve()
            })
        }
      },
      now: () => now,
      host: '127.0.0.1',
      port: 0,
      requestLog: () => undefined
    });
    return `http://127.0.0.1:${started.port}`;
  }

  async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  it('selects, meters, persists, restarts, and durably disables the regular Jarvis model path', async () => {
    let baseUrl = await start();
    const initial = await fetch(`${baseUrl}/api/v1/dashboard/model-runtime`);
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({
      enabled: false,
      version: 1,
      selectedProvider: null
    });

    const selected = await postJson(baseUrl, '/api/v1/dashboard/model-runtime/select', {
      provider: 'claude',
      expectedVersion: 1
    });
    expect(selected.status).toBe(200);
    await expect(selected.json()).resolves.toMatchObject({
      enabled: true,
      version: 2,
      selectedProvider: 'claude'
    });

    const created = await postJson(baseUrl, '/api/v1/dashboard/agents/jarvis/conversations', {
      title: 'Subscription conversation'
    });
    expect(created.status).toBe(201);
    const conversation = (await created.json()) as {
      conversation: { id: string; version: number };
    };
    const messagesPath = `/api/v1/dashboard/agents/jarvis/conversations/${conversation.conversation.id}/messages`;

    const first = await postJson(baseUrl, messagesPath, {
      message: 'Help me think through a product tradeoff.',
      expectedVersion: 1
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      conversation: { version: 3 },
      reply: {
        respondingAgentId: 'jarvis',
        responseMode: 'model',
        text: 'A real model-path answer from the selected subscription.',
        evidenceRefs: [expect.stringMatching(/^model-usage:/u)]
      },
      messages: [
        { authorKind: 'operator', responseMode: 'operator_input' },
        { authorKind: 'agent', responseMode: 'model' }
      ]
    });
    expect(claudeRunner).toHaveBeenCalledTimes(1);

    let sqlite = new SQLite(databaseFile, { readonly: true });
    try {
      expect(
        sqlite
          .prepare('SELECT provider, route, operation, client_id, status FROM model_usage_events')
          .all()
      ).toEqual([
        {
          provider: 'claude',
          route: 'economy',
          operation: 'synthesis',
          client_id: null,
          status: 'succeeded'
        }
      ]);
    } finally {
      sqlite.close();
    }

    await started?.stop();
    started = undefined;
    baseUrl = await start();
    const afterRestart = await fetch(`${baseUrl}/api/v1/dashboard/model-runtime`);
    await expect(afterRestart.json()).resolves.toMatchObject({
      enabled: true,
      version: 2,
      selectedProvider: 'claude'
    });

    const second = await postJson(baseUrl, messagesPath, {
      message: 'Continue from our last exchange.',
      expectedVersion: 3
    });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      conversation: { version: 5 },
      reply: { responseMode: 'model' }
    });
    expect(claudeRunner).toHaveBeenCalledTimes(2);
    const secondInvocation = claudeRunner.mock.calls[1]?.[2] as { input: string };
    expect(secondInvocation.input).toContain('Help me think through a product tradeoff.');
    expect(secondInvocation.input).toContain(
      'A real model-path answer from the selected subscription.'
    );

    const disabled = await postJson(baseUrl, '/api/v1/dashboard/model-runtime/disable', {
      expectedVersion: 2
    });
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({
      enabled: false,
      version: 3,
      selectedProvider: null
    });

    const fallback = await postJson(baseUrl, messagesPath, {
      message: 'Explain one more general tradeoff.',
      expectedVersion: 5
    });
    expect(fallback.status).toBe(200);
    await expect(fallback.json()).resolves.toMatchObject({
      conversation: { version: 7 },
      reply: { responseMode: 'deterministic' }
    });
    expect(claudeRunner).toHaveBeenCalledTimes(2);

    sqlite = new SQLite(databaseFile, { readonly: true });
    try {
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM model_usage_events').get()).toEqual({
        count: 2
      });
    } finally {
      sqlite.close();
    }
  });
});
