import { join } from 'node:path';

import type { Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { ClientService } from '../../src/clients/service';
import { PagePlanner } from '../../src/dashboard/page-planner';
import { requireLoopbackMutation, type DashboardApi } from '../../src/dashboard/routes';
import { createApp, type AutomationRunner } from '../../src/gateway/app';
import { RequestMetrics } from '../../src/gateway/metrics';
import { AppError } from '../../src/utils/errors';

const projectRoot = join(__dirname, '..', '..');
const now = '2026-07-21T16:00:00.000Z';

const catalog = {
  generatedAt: now,
  profiles: [
    {
      id: 'jarvis',
      displayName: 'Jarvis',
      trustDomain: 'personal',
      runtimeMode: 'deterministic'
    },
    {
      id: 'agency-developer',
      displayName: 'Developer',
      trustDomain: 'agency',
      runtimeMode: 'profile_only'
    }
  ],
  hierarchy: {
    roots: [{ id: 'jarvis', children: [{ id: 'agency-developer', children: [] }] }],
    returnedCount: 2,
    totalCount: 2,
    truncated: false
  }
};

const conversation = {
  id: 'conversation:developer-review',
  agentId: 'agency-developer',
  trustDomain: 'agency',
  title: 'Review the workbench',
  version: 1,
  createdAt: now,
  updatedAt: now
};

const operatorMessage = {
  id: 'message:operator-001',
  conversationId: conversation.id,
  agentId: 'agency-developer',
  trustDomain: 'agency',
  sequence: 1,
  authorKind: 'operator',
  respondingAgentId: null,
  responseMode: 'operator_input',
  text: 'What can you review?',
  evidenceRefs: [],
  createdAt: now
};

const agentMessage = {
  id: 'message:developer-001',
  conversationId: conversation.id,
  agentId: 'agency-developer',
  trustDomain: 'agency',
  sequence: 2,
  authorKind: 'agent',
  respondingAgentId: 'agency-developer',
  responseMode: 'profile',
  text: 'I can explain my bounded review contract.',
  evidenceRefs: ['profile:agency-developer@1'],
  createdAt: now
};

function baseDashboard(): DashboardApi {
  const plan = new PagePlanner().plan({ request: 'Create a health page for operations' });
  return {
    overview: () => Promise.resolve({ generatedAt: now }),
    queueSnapshot: () =>
      Promise.resolve({
        generatedAt: now,
        tenantId: 'jarvis',
        returnedTaskCount: 0,
        truncated: false,
        lanes: []
      }),
    graphIndex: () => Promise.resolve({ generatedAt: now, nodes: [], edges: [] }),
    listPages: () => Promise.resolve([]),
    previewPage: () => Promise.resolve(plan),
    createPage: () =>
      Promise.resolve({
        created: true,
        page: {
          version: 1,
          slug: plan.slug,
          title: plan.title,
          request: plan.request,
          widgets: plan.widgets,
          createdAt: now,
          planFingerprint: plan.fingerprint
        }
      })
  };
}

function createDashboardApp(dashboard: DashboardApi): ReturnType<typeof createApp> {
  const clients: ClientService = {
    list: () => Promise.resolve([]),
    findById: () => Promise.resolve(undefined),
    create: () => Promise.reject(new Error('not used'))
  };
  const runner: AutomationRunner = {
    run: () => Promise.reject(new Error('not used'))
  };
  return createApp({
    clients,
    runner,
    dashboard,
    dashboardRoot: join(projectRoot, 'public', 'dashboard'),
    metrics: new RequestMetrics(),
    health: {
      check: () =>
        Promise.resolve({
          timestamp: now,
          overall: 'healthy',
          severity: 'none',
          checks: { gateway: 'ok', database: 'ok', disk: 'ok:50%' },
          failures: [],
          action: 'none'
        })
    },
    requestLog: () => undefined
  });
}

describe('Agent Workbench dashboard route contract', () => {
  let app: ReturnType<typeof createApp>;
  let api: DashboardApi;
  let agentCatalog: Mock<() => Promise<unknown>>;
  let listAgentConversations: Mock<(agentId: string) => Promise<unknown>>;
  let createAgentConversation: Mock<
    (agentId: string, input: { title?: string }) => Promise<unknown>
  >;
  let listAgentMessages: Mock<(agentId: string, conversationId: string) => Promise<unknown>>;
  let sendAgentMessage: Mock<
    (
      agentId: string,
      conversationId: string,
      input: { message: string; expectedVersion: number }
    ) => Promise<unknown>
  >;

  beforeEach(() => {
    agentCatalog = vi.fn(() => Promise.resolve(catalog));
    listAgentConversations = vi.fn(() => Promise.resolve({ conversations: [conversation] }));
    createAgentConversation = vi.fn(() => Promise.resolve({ conversation }));
    listAgentMessages = vi.fn(() => Promise.resolve({ messages: [operatorMessage, agentMessage] }));
    sendAgentMessage = vi.fn(() =>
      Promise.resolve({
        conversation: { ...conversation, version: 3 },
        messages: [operatorMessage, agentMessage]
      })
    );
    api = {
      ...baseDashboard(),
      agentCatalog: () => agentCatalog(),
      listAgentConversations: (agentId) => listAgentConversations(agentId),
      createAgentConversation: (agentId, input) => createAgentConversation(agentId, input),
      listAgentMessages: (agentId, conversationId) => listAgentMessages(agentId, conversationId),
      sendAgentMessage: (agentId, conversationId, input) =>
        sendAgentMessage(agentId, conversationId, input)
    };
    app = createDashboardApp(api);
  });

  it('gets the complete no-store server-owned catalog without browser-selected scope', async () => {
    await request(app)
      .get('/api/v1/dashboard/agents')
      .expect('cache-control', 'no-store')
      .expect(200, catalog);

    expect(agentCatalog).toHaveBeenCalledOnce();
    expect(agentCatalog).toHaveBeenCalledWith();
  });

  it('lists and creates conversations for the exact path agent', async () => {
    await request(app)
      .get('/api/v1/dashboard/agents/agency-developer/conversations')
      .expect('cache-control', 'no-store')
      .expect(200, { conversations: [conversation] });
    await request(app)
      .post('/api/v1/dashboard/agents/agency-developer/conversations')
      .send({ title: 'Review the workbench' })
      .expect('cache-control', 'no-store')
      .expect(201, { conversation });

    expect(listAgentConversations).toHaveBeenCalledWith('agency-developer');
    expect(createAgentConversation).toHaveBeenCalledWith('agency-developer', {
      title: 'Review the workbench'
    });
  });

  it('lists and sends messages for the exact agent and conversation binding', async () => {
    const path =
      '/api/v1/dashboard/agents/agency-developer/conversations/conversation:developer-review/messages';
    await request(app)
      .get(path)
      .expect('cache-control', 'no-store')
      .expect(200, { messages: [operatorMessage, agentMessage] });
    await request(app)
      .post(path)
      .send({ message: 'What can you review?', expectedVersion: 1 })
      .expect('cache-control', 'no-store')
      .expect(200, {
        conversation: { ...conversation, version: 3 },
        messages: [operatorMessage, agentMessage]
      });

    expect(listAgentMessages).toHaveBeenCalledWith(
      'agency-developer',
      'conversation:developer-review'
    );
    expect(sendAgentMessage).toHaveBeenCalledWith(
      'agency-developer',
      'conversation:developer-review',
      { message: 'What can you review?', expectedVersion: 1 }
    );
  });

  it('rejects unknown scope, authority, and payload fields before calling the API', async () => {
    await request(app).get('/api/v1/dashboard/agents?tenantId=acme').expect(400);
    await request(app)
      .get('/api/v1/dashboard/agents/agency-developer/conversations?trustDomain=personal')
      .expect(400);
    await request(app)
      .post('/api/v1/dashboard/agents/agency-developer/conversations')
      .send({ title: 'Injected scope', trustDomain: 'personal' })
      .expect(400);
    await request(app)
      .post(
        '/api/v1/dashboard/agents/agency-developer/conversations/conversation:developer-review/messages'
      )
      .send({
        message: 'Use this authority',
        expectedVersion: 1,
        agentId: 'jarvis',
        toolGrant: 'wallet.sign'
      })
      .expect(400);

    expect(agentCatalog).not.toHaveBeenCalled();
    expect(listAgentConversations).not.toHaveBeenCalled();
    expect(createAgentConversation).not.toHaveBeenCalled();
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it('preserves typed failures for unknown agents, mismatched conversations, and stale writes', async () => {
    listAgentConversations.mockRejectedValueOnce(
      new AppError(404, 'DASHBOARD_AGENT_NOT_FOUND', 'Agent profile was not found')
    );
    listAgentMessages.mockRejectedValueOnce(
      new AppError(
        404,
        'DASHBOARD_AGENT_CONVERSATION_NOT_FOUND',
        'Agent conversation was not found'
      )
    );
    sendAgentMessage.mockRejectedValueOnce(
      new AppError(
        409,
        'DASHBOARD_AGENT_CONVERSATION_VERSION_CONFLICT',
        'Agent conversation version is stale'
      )
    );

    await request(app)
      .get('/api/v1/dashboard/agents/unknown-agent/conversations')
      .expect(404)
      .expect(({ body }) => {
        expect(body as unknown).toMatchObject({
          error: { code: 'DASHBOARD_AGENT_NOT_FOUND' }
        });
      });
    await request(app)
      .get(
        '/api/v1/dashboard/agents/agency-idea-generator/conversations/conversation:developer-review/messages'
      )
      .expect(404)
      .expect(({ body }) => {
        expect(body as unknown).toMatchObject({
          error: { code: 'DASHBOARD_AGENT_CONVERSATION_NOT_FOUND' }
        });
      });
    await request(app)
      .post(
        '/api/v1/dashboard/agents/agency-developer/conversations/conversation:developer-review/messages'
      )
      .send({ message: 'Stale request', expectedVersion: 1 })
      .expect(409)
      .expect(({ body }) => {
        expect(body as unknown).toMatchObject({
          error: { code: 'DASHBOARD_AGENT_CONVERSATION_VERSION_CONFLICT' }
        });
      });
  });

  it('keeps conversation and message mutations behind the loopback boundary', () => {
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
    expect(createAgentConversation).not.toHaveBeenCalled();
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it('rejects DNS-rebinding hosts and cross-origin browser mutations', async () => {
    await request(app)
      .get('/api/v1/dashboard/agents')
      .set('Host', 'jarvis.attacker.example')
      .expect(403)
      .expect(({ body }) => {
        expect(body as unknown).toMatchObject({
          error: { code: 'DASHBOARD_HOST_FORBIDDEN' }
        });
      });

    await request(app)
      .post('/api/v1/dashboard/agents/agency-developer/conversations')
      .set('Host', '127.0.0.1')
      .set('Origin', 'https://attacker.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ title: 'Cross-origin request' })
      .expect(403)
      .expect(({ body }) => {
        expect(body as unknown).toMatchObject({
          error: { code: 'DASHBOARD_ORIGIN_FORBIDDEN' }
        });
      });
    expect(agentCatalog).not.toHaveBeenCalled();
    expect(createAgentConversation).not.toHaveBeenCalled();
  });

  it('returns typed service-unavailable errors when Agent Workbench APIs are absent', async () => {
    const unavailable = createDashboardApp(baseDashboard());

    await request(unavailable)
      .get('/api/v1/dashboard/agents')
      .expect(503)
      .expect(({ body }) => {
        expect(body as unknown).toMatchObject({
          error: { code: 'DASHBOARD_AGENT_CATALOG_UNAVAILABLE' }
        });
      });
    await request(unavailable)
      .get('/api/v1/dashboard/agents/jarvis/conversations')
      .expect(503)
      .expect(({ body }) => {
        expect(body as unknown).toMatchObject({
          error: { code: 'DASHBOARD_AGENT_CONVERSATIONS_UNAVAILABLE' }
        });
      });
    await request(unavailable)
      .post('/api/v1/dashboard/agents/jarvis/conversations')
      .send({})
      .expect(503)
      .expect(({ body }) => {
        expect(body as unknown).toMatchObject({
          error: { code: 'DASHBOARD_AGENT_CONVERSATIONS_UNAVAILABLE' }
        });
      });
    await request(unavailable)
      .get('/api/v1/dashboard/agents/jarvis/conversations/conversation:jarvis-001/messages')
      .expect(503)
      .expect(({ body }) => {
        expect(body as unknown).toMatchObject({
          error: { code: 'DASHBOARD_AGENT_CONVERSATIONS_UNAVAILABLE' }
        });
      });
    await request(unavailable)
      .post('/api/v1/dashboard/agents/jarvis/conversations/conversation:jarvis-001/messages')
      .send({ message: 'Hello', expectedVersion: 1 })
      .expect(503)
      .expect(({ body }) => {
        expect(body as unknown).toMatchObject({
          error: { code: 'DASHBOARD_AGENT_CONVERSATIONS_UNAVAILABLE' }
        });
      });
  });
});
