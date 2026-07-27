import { join } from 'node:path';

import express, { type Express, type RequestHandler } from 'express';
import { z } from 'zod';

import {
  AgentProfileNotFoundError,
  CreateAgentConversationRequestSchema,
  SendAgentConversationMessageRequestSchema,
  type CreateAgentConversationRequest,
  type SendAgentConversationMessageRequest
} from '../agents/agent-conversation-service';
import {
  AgentConversationIdSchema,
  AgentConversationUnavailableError,
  AgentConversationVersionConflictError
} from '../agents/conversation-repository';
import {
  ActionDecisionRequestSchema,
  type ActionDecisionRequest
} from '../commands/action-proposal-contracts';
import { isLoopbackHostHeader, requireLoopbackMutation } from '../gateway/loopback-mutation-guard';
import type { GraphIndex } from '../memory/markdown-graph';
import { JarvisChatRequestSchema, type JarvisChatRequest } from '../chat/jarvis-chat';
import { AppError } from '../utils/errors';
import type { DashboardQueueSnapshot, DashboardRevenueSnapshot } from './dashboard-service';
import type { DashboardCodeGraphSnapshot } from './code-graph-reader';
import { listOperatorPageTemplates } from './page-templates';
import {
  CreatePageRequestSchema,
  PagePlanRequestSchema,
  type CreatePageRequest,
  type OperatorPageSpec,
  type PagePlan,
  type PagePlanRequest
} from './contracts';
import {
  DashboardModelRuntimeDisableRequestSchema,
  DashboardModelRuntimeSelectionRequestSchema,
  ModelRuntimeProviderConnectionRequiredError,
  ModelRuntimeVersionConflictError,
  type DashboardModelRuntimeDisableRequest,
  type DashboardModelRuntimeSelectionRequest
} from './model-runtime-service';
import {
  SubscriptionProviderSchema,
  type SubscriptionProviderId
} from '../models/subscription-runtime';

export {
  isLoopbackAddress,
  isLoopbackHostHeader,
  requireLoopbackMutation
} from '../gateway/loopback-mutation-guard';

const DASHBOARD_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'"
].join('; ');
const EmptyDashboardQueueQuerySchema = z.strictObject({});
const EmptyDashboardRevenueQuerySchema = z.strictObject({});
const EmptyDashboardCodeGraphQuerySchema = z.strictObject({});
const EmptyAgentWorkbenchQuerySchema = z.strictObject({});
const EmptyModelRuntimeQuerySchema = z.strictObject({});
const EmptyModelRuntimeBodySchema = z.strictObject({});
const ModelRuntimeProviderRouteParamsSchema = z.strictObject({
  provider: SubscriptionProviderSchema
});
const AgentRouteParamsSchema = z.strictObject({
  agentId: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/u)
});
const AgentConversationRouteParamsSchema = AgentRouteParamsSchema.extend({
  conversationId: AgentConversationIdSchema
});
const ActionProposalRouteParamsSchema = z.strictObject({
  proposalId: ActionDecisionRequestSchema.shape.proposalId
});
const ActionProposalDecisionBodySchema = ActionDecisionRequestSchema.omit({ proposalId: true });

export interface DashboardApi {
  overview(): Promise<unknown>;
  queueSnapshot(): Promise<DashboardQueueSnapshot>;
  revenueSnapshot?(): Promise<DashboardRevenueSnapshot>;
  pnlSnapshot?(): Promise<unknown>;
  personalSnapshot?(): Promise<unknown>;
  agencyControlSnapshot?(): Promise<unknown>;
  chat?(input: JarvisChatRequest): Promise<unknown>;
  modelRuntimeSnapshot?(): Promise<unknown>;
  startModelProviderLogin?(provider: SubscriptionProviderId): Promise<{
    provider: SubscriptionProviderId;
    outcome: 'started' | 'already_in_progress' | 'unavailable' | 'launch_failed';
    detail: string;
  }>;
  selectModelRuntime?(input: DashboardModelRuntimeSelectionRequest): Promise<unknown>;
  disableModelRuntime?(input: DashboardModelRuntimeDisableRequest): Promise<unknown>;
  decideActionProposal?(input: ActionDecisionRequest): Promise<unknown>;
  agentCatalog?(): Promise<unknown>;
  listAgentConversations?(agentId: string): Promise<unknown>;
  createAgentConversation?(
    agentId: string,
    input: CreateAgentConversationRequest
  ): Promise<unknown>;
  listAgentMessages?(agentId: string, conversationId: string): Promise<unknown>;
  sendAgentMessage?(
    agentId: string,
    conversationId: string,
    input: SendAgentConversationMessageRequest
  ): Promise<unknown>;
  codeGraphIndex?(): Promise<DashboardCodeGraphSnapshot>;
  graphIndex(): Promise<GraphIndex>;
  listPages(): Promise<OperatorPageSpec[]>;
  previewPage(input: PagePlanRequest): Promise<PagePlan>;
  createPage(input: CreatePageRequest): Promise<{
    created: boolean;
    page: OperatorPageSpec;
  }>;
}

export interface DashboardRoutesOptions {
  api: DashboardApi;
  dashboardRoot: string;
  delegationEvents?: RequestHandler;
}

function validationError(issues: unknown): AppError {
  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', issues);
}

function rethrowAgentWorkbenchError(error: unknown): never {
  if (error instanceof AgentProfileNotFoundError) {
    throw new AppError(404, 'DASHBOARD_AGENT_NOT_FOUND', 'Agent profile was not found');
  }
  if (error instanceof AgentConversationUnavailableError) {
    throw new AppError(
      404,
      'DASHBOARD_AGENT_CONVERSATION_NOT_FOUND',
      'Agent conversation was not found'
    );
  }
  if (error instanceof AgentConversationVersionConflictError) {
    throw new AppError(
      409,
      'DASHBOARD_AGENT_CONVERSATION_VERSION_CONFLICT',
      'Conversation changed; refresh before retrying'
    );
  }
  throw error;
}

function rethrowModelRuntimeError(error: unknown): never {
  if (error instanceof ModelRuntimeProviderConnectionRequiredError) {
    throw new AppError(
      409,
      'DASHBOARD_MODEL_PROVIDER_CONNECTION_REQUIRED',
      'Connect the provider subscription before selecting it'
    );
  }
  if (error instanceof ModelRuntimeVersionConflictError) {
    throw new AppError(
      409,
      'DASHBOARD_MODEL_RUNTIME_VERSION_CONFLICT',
      'Model runtime selection changed; refresh before retrying'
    );
  }
  throw error;
}

function parseAgentParams(raw: unknown): z.infer<typeof AgentRouteParamsSchema> {
  const parsed = AgentRouteParamsSchema.safeParse(raw);
  if (!parsed.success) throw validationError(parsed.error.issues);
  return parsed.data;
}

function parseAgentConversationParams(
  raw: unknown
): z.infer<typeof AgentConversationRouteParamsSchema> {
  const parsed = AgentConversationRouteParamsSchema.safeParse(raw);
  if (!parsed.success) throw validationError(parsed.error.issues);
  return parsed.data;
}

function validateEmptyAgentQuery(raw: unknown): void {
  const parsed = EmptyAgentWorkbenchQuerySchema.safeParse(raw);
  if (!parsed.success) throw validationError(parsed.error.issues);
}

function requireAgentConversationApi(
  api: DashboardApi
): asserts api is DashboardApi &
  Required<
    Pick<
      DashboardApi,
      | 'listAgentConversations'
      | 'createAgentConversation'
      | 'listAgentMessages'
      | 'sendAgentMessage'
    >
  > {
  if (
    api.listAgentConversations === undefined ||
    api.createAgentConversation === undefined ||
    api.listAgentMessages === undefined ||
    api.sendAgentMessage === undefined
  ) {
    throw new AppError(
      503,
      'DASHBOARD_AGENT_CONVERSATIONS_UNAVAILABLE',
      'Agent conversations are not configured'
    );
  }
}

function requireModelRuntimeApi(
  api: DashboardApi
): asserts api is DashboardApi &
  Required<
    Pick<
      DashboardApi,
      | 'modelRuntimeSnapshot'
      | 'startModelProviderLogin'
      | 'selectModelRuntime'
      | 'disableModelRuntime'
    >
  > {
  if (
    api.modelRuntimeSnapshot === undefined ||
    api.startModelProviderLogin === undefined ||
    api.selectModelRuntime === undefined ||
    api.disableModelRuntime === undefined
  ) {
    throw new AppError(
      503,
      'DASHBOARD_MODEL_RUNTIME_UNAVAILABLE',
      'Model subscription controls are not configured'
    );
  }
}

function requireCodeGraphApi(
  api: DashboardApi
): asserts api is DashboardApi & Required<Pick<DashboardApi, 'codeGraphIndex'>> {
  if (api.codeGraphIndex === undefined) {
    throw new AppError(
      503,
      'DASHBOARD_CODE_GRAPH_UNAVAILABLE',
      'The harness code graph is unavailable'
    );
  }
}

const dashboardSecurityHeaders: RequestHandler = (_request, response, next) => {
  response.set({
    'Content-Security-Policy': DASHBOARD_CSP,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'microphone=(self)',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  next();
};

const noStore: RequestHandler = (_request, response, next) => {
  response.set('Cache-Control', 'no-store');
  next();
};

export const requireLoopbackDashboardHost: RequestHandler = (request, _response, next) => {
  if (!isLoopbackHostHeader(request.get('host'))) {
    next(
      new AppError(
        403,
        'DASHBOARD_HOST_FORBIDDEN',
        'Dashboard requests require an exact loopback host'
      )
    );
    return;
  }
  next();
};

export function installDashboardRoutes(app: Express, options: DashboardRoutesOptions): void {
  const indexFile = join(options.dashboardRoot, 'index.html');
  const assetsRoot = join(options.dashboardRoot, 'assets');

  app.use(['/dashboard', '/dashboard/assets', '/api/v1/dashboard'], requireLoopbackDashboardHost);
  app.get('/', (_request, response) => response.redirect(302, '/dashboard'));
  app.get('/dashboard', dashboardSecurityHeaders, noStore, (_request, response, next) => {
    response.sendFile(indexFile, (error) => {
      if (error !== undefined) {
        next(error);
      }
    });
  });
  app.use(
    '/dashboard/assets',
    dashboardSecurityHeaders,
    express.static(assetsRoot, {
      dotfiles: 'ignore',
      fallthrough: true,
      index: false,
      redirect: false,
      setHeaders(response) {
        response.setHeader('Cache-Control', 'no-cache');
      }
    })
  );

  app.get('/api/v1/dashboard/overview', noStore, async (_request, response) => {
    response.json(await options.api.overview());
  });
  app.get('/api/v1/dashboard/queue', noStore, async (request, response) => {
    const parsed = EmptyDashboardQueueQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw validationError(parsed.error.issues);
    }
    response.json(await options.api.queueSnapshot());
  });
  app.get('/api/v1/dashboard/revenue', noStore, async (request, response) => {
    const parsed = EmptyDashboardRevenueQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw validationError(parsed.error.issues);
    }
    if (options.api.revenueSnapshot === undefined) {
      throw new AppError(
        503,
        'DASHBOARD_REVENUE_UNAVAILABLE',
        'Revenue dashboard read model is not configured'
      );
    }
    response.json(await options.api.revenueSnapshot());
  });
  app.get('/api/v1/dashboard/pnl', noStore, async (_request, response) => {
    if (options.api.pnlSnapshot === undefined) {
      throw new AppError(
        503,
        'DASHBOARD_PNL_UNAVAILABLE',
        'Operator P&L read model is not configured'
      );
    }
    response.json(await options.api.pnlSnapshot());
  });
  app.get('/api/v1/dashboard/personal', noStore, async (_request, response) => {
    if (options.api.personalSnapshot === undefined) {
      throw new AppError(
        503,
        'DASHBOARD_PERSONAL_UNAVAILABLE',
        'Personal Jarvis read model is not configured'
      );
    }
    response.json(await options.api.personalSnapshot());
  });
  app.get('/api/v1/dashboard/agency', noStore, async (_request, response) => {
    if (options.api.agencyControlSnapshot === undefined) {
      throw new AppError(
        503,
        'DASHBOARD_AGENCY_UNAVAILABLE',
        'Agency control read model is not configured'
      );
    }
    response.json(await options.api.agencyControlSnapshot());
  });
  if (options.delegationEvents !== undefined) {
    app.get('/api/v1/dashboard/delegation/events', noStore, options.delegationEvents);
  }
  app.post(
    '/api/v1/dashboard/chat',
    noStore,
    requireLoopbackMutation,
    async (request, response) => {
      const parsed = JarvisChatRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationError(parsed.error.issues);
      if (options.api.chat === undefined) {
        throw new AppError(503, 'DASHBOARD_CHAT_UNAVAILABLE', 'Jarvis chat is not configured');
      }
      response.json(await options.api.chat(parsed.data));
    }
  );
  app.get('/api/v1/dashboard/model-runtime', noStore, async (request, response) => {
    const parsed = EmptyModelRuntimeQuerySchema.safeParse(request.query);
    if (!parsed.success) throw validationError(parsed.error.issues);
    requireModelRuntimeApi(options.api);
    response.json(await options.api.modelRuntimeSnapshot());
  });
  app.post(
    '/api/v1/dashboard/model-runtime/providers/:provider/login',
    noStore,
    requireLoopbackMutation,
    async (request, response) => {
      const params = ModelRuntimeProviderRouteParamsSchema.safeParse(request.params);
      const body = EmptyModelRuntimeBodySchema.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        throw validationError([
          ...(params.success ? [] : params.error.issues),
          ...(body.success ? [] : body.error.issues)
        ]);
      }
      requireModelRuntimeApi(options.api);
      const result = await options.api.startModelProviderLogin(params.data.provider);
      if (result.outcome === 'unavailable' || result.outcome === 'launch_failed') {
        throw new AppError(
          503,
          'DASHBOARD_MODEL_PROVIDER_LOGIN_UNAVAILABLE',
          'The provider login runtime is unavailable'
        );
      }
      response.status(202).json(result);
    }
  );
  app.post(
    '/api/v1/dashboard/model-runtime/select',
    noStore,
    requireLoopbackMutation,
    async (request, response) => {
      const parsed = DashboardModelRuntimeSelectionRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationError(parsed.error.issues);
      requireModelRuntimeApi(options.api);
      try {
        response.json(await options.api.selectModelRuntime(parsed.data));
      } catch (error) {
        rethrowModelRuntimeError(error);
      }
    }
  );
  app.post(
    '/api/v1/dashboard/model-runtime/disable',
    noStore,
    requireLoopbackMutation,
    async (request, response) => {
      const parsed = DashboardModelRuntimeDisableRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationError(parsed.error.issues);
      requireModelRuntimeApi(options.api);
      try {
        response.json(await options.api.disableModelRuntime(parsed.data));
      } catch (error) {
        rethrowModelRuntimeError(error);
      }
    }
  );
  app.post(
    '/api/v1/dashboard/action-proposals/:proposalId/decision',
    noStore,
    requireLoopbackMutation,
    async (request, response) => {
      const params = ActionProposalRouteParamsSchema.safeParse(request.params);
      const body = ActionProposalDecisionBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        throw validationError([
          ...(params.success ? [] : params.error.issues),
          ...(body.success ? [] : body.error.issues)
        ]);
      }
      if (options.api.decideActionProposal === undefined) {
        throw new AppError(
          503,
          'DASHBOARD_ACTION_PROPOSALS_UNAVAILABLE',
          'Action-proposal decisions are not configured'
        );
      }
      response.json(
        await options.api.decideActionProposal({
          proposalId: params.data.proposalId,
          ...body.data
        })
      );
    }
  );
  app.get('/api/v1/dashboard/agents', noStore, async (request, response) => {
    validateEmptyAgentQuery(request.query);
    if (options.api.agentCatalog === undefined) {
      throw new AppError(
        503,
        'DASHBOARD_AGENT_CATALOG_UNAVAILABLE',
        'Agent profile catalog is not configured'
      );
    }
    response.json(await options.api.agentCatalog());
  });
  app.get('/api/v1/dashboard/agents/:agentId/conversations', noStore, async (request, response) => {
    validateEmptyAgentQuery(request.query);
    const { agentId } = parseAgentParams(request.params);
    requireAgentConversationApi(options.api);
    try {
      response.json(await options.api.listAgentConversations(agentId));
    } catch (error) {
      rethrowAgentWorkbenchError(error);
    }
  });
  app.post(
    '/api/v1/dashboard/agents/:agentId/conversations',
    noStore,
    requireLoopbackMutation,
    async (request, response) => {
      validateEmptyAgentQuery(request.query);
      const { agentId } = parseAgentParams(request.params);
      const parsed = CreateAgentConversationRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationError(parsed.error.issues);
      requireAgentConversationApi(options.api);
      try {
        response.status(201).json(await options.api.createAgentConversation(agentId, parsed.data));
      } catch (error) {
        rethrowAgentWorkbenchError(error);
      }
    }
  );
  app.get(
    '/api/v1/dashboard/agents/:agentId/conversations/:conversationId/messages',
    noStore,
    async (request, response) => {
      validateEmptyAgentQuery(request.query);
      const { agentId, conversationId } = parseAgentConversationParams(request.params);
      requireAgentConversationApi(options.api);
      try {
        response.json(await options.api.listAgentMessages(agentId, conversationId));
      } catch (error) {
        rethrowAgentWorkbenchError(error);
      }
    }
  );
  app.post(
    '/api/v1/dashboard/agents/:agentId/conversations/:conversationId/messages',
    noStore,
    requireLoopbackMutation,
    async (request, response) => {
      validateEmptyAgentQuery(request.query);
      const { agentId, conversationId } = parseAgentConversationParams(request.params);
      const parsed = SendAgentConversationMessageRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationError(parsed.error.issues);
      requireAgentConversationApi(options.api);
      try {
        response.json(await options.api.sendAgentMessage(agentId, conversationId, parsed.data));
      } catch (error) {
        rethrowAgentWorkbenchError(error);
      }
    }
  );
  app.get('/api/v1/dashboard/graph', noStore, async (_request, response) => {
    response.json(await options.api.graphIndex());
  });
  app.get('/api/v1/dashboard/code-graph', noStore, async (request, response) => {
    const parsed = EmptyDashboardCodeGraphQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw validationError(parsed.error.issues);
    }
    requireCodeGraphApi(options.api);
    response.json(await options.api.codeGraphIndex());
  });
  app.get('/api/v1/dashboard/pages', noStore, async (_request, response) => {
    response.json({
      pages: await options.api.listPages(),
      templates: listOperatorPageTemplates()
    });
  });
  app.post('/api/v1/dashboard/page-plans', noStore, async (request, response) => {
    const parsed = PagePlanRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw validationError(parsed.error.issues);
    }
    response.json(await options.api.previewPage(parsed.data));
  });
  app.post(
    '/api/v1/dashboard/pages',
    noStore,
    requireLoopbackMutation,
    async (request, response) => {
      const parsed = CreatePageRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues);
      }
      const result = await options.api.createPage(parsed.data);
      response.status(result.created ? 201 : 200).json(result);
    }
  );
}
