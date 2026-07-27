import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';

import {
  EdgeValidationInputSchema,
  evaluateEdgeValidation,
  type EdgeValidationInput,
  type EdgeValidationResult
} from './edge-validation';
import { installEdgeValidationMcpRoutes, type EdgeMcpPaymentWrapper } from './mcp-server';

export type SellerMode = 'simulation' | 'testnet' | 'mainnet_enabled';

export interface SellerReadiness {
  ready: boolean;
  reason: 'ready' | 'capacity_unavailable' | 'kill_switch' | 'dependency_unavailable';
}

export interface TaskMarketSellerDependencies {
  mode: SellerMode;
  readiness: () => SellerReadiness;
  paymentMiddleware: RequestHandler;
  mcpPaymentWrapper?: EdgeMcpPaymentWrapper;
  execute?: (input: EdgeValidationInput) => EdgeValidationResult;
}

function publicError(
  status: number,
  code: string,
  message: string
): Error & { status: number; code: string } {
  return Object.assign(new Error(message), { status, code });
}

const secureHeaders: RequestHandler = (_request, response, next) => {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  next();
};

const denyMcpPayment: EdgeMcpPaymentWrapper = () => () =>
  Promise.resolve({
    content: [{ type: 'text', text: '{"error":{"code":402,"message":"Payment required"}}' }],
    isError: true
  });

function errorHandler(): ErrorRequestHandler {
  return (error: unknown, _request, response, next) => {
    void next;
    const typed = error as {
      type?: string;
      status?: number;
      code?: string;
    };
    if (typed.type === 'entity.too.large' || typed.status === 413) {
      response.status(413).json({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the service limit' }
      });
      return;
    }
    if (typed.type === 'entity.parse.failed') {
      response.status(400).json({
        error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' }
      });
      return;
    }
    if (typeof typed.status === 'number' && typeof typed.code === 'string') {
      response.status(typed.status).json({
        error: {
          code: typed.code,
          message: error instanceof Error ? error.message : 'Request failed'
        }
      });
      return;
    }
    response.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Request could not be completed' }
    });
  };
}

export function createTaskMarketSellerApp(dependencies: TaskMarketSellerDependencies): Express {
  const app = express();
  const execute = dependencies.execute ?? evaluateEdgeValidation;
  app.disable('x-powered-by');
  app.use(secureHeaders);
  app.use(express.json({ limit: '64kb', strict: true }));

  app.get('/livez', (_request, response) => {
    response.json({ status: 'alive' });
  });
  app.get('/readyz', (_request, response) => {
    const readiness = dependencies.readiness();
    response.status(readiness.ready ? 200 : 503).json({
      status: readiness.ready ? 'ready' : 'not_ready',
      mode: dependencies.mode,
      product: 'edge-validation-v1'
    });
  });
  app.get('/.well-known/task-market.json', (_request, response) => {
    response.json({
      schemaVersion: 1,
      service: 'jarvis-task-market',
      mode: dependencies.mode,
      products: [
        {
          id: 'edge-validation-v1',
          http: { method: 'POST', path: '/v1/edge-validation' },
          mcp: { tool: 'edge_validation_v1', transport: 'streamable-http', path: '/mcp' },
          deterministic: true,
          paymentRequired: true
        }
      ]
    });
  });

  const validate: RequestHandler = (request, response, next) => {
    const parsed = EdgeValidationInputSchema.safeParse(request.body);
    if (!parsed.success) {
      next(publicError(400, 'VALIDATION_ERROR', 'Request validation failed'));
      return;
    }
    response.locals.edgeValidationInput = parsed.data;
    next();
  };
  const requireCapacity: RequestHandler = (_request, _response, next) => {
    if (!dependencies.readiness().ready) {
      next(publicError(503, 'SERVICE_UNAVAILABLE', 'Service is not accepting paid work'));
      return;
    }
    next();
  };

  app.post(
    '/v1/edge-validation',
    validate,
    requireCapacity,
    dependencies.paymentMiddleware,
    (_request, response) => {
      const input = response.locals.edgeValidationInput as EdgeValidationInput;
      response.json(execute(input));
    }
  );

  installEdgeValidationMcpRoutes(app, {
    paymentWrapper: dependencies.mcpPaymentWrapper ?? denyMcpPayment,
    execute
  });

  app.use((_request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
  app.use(errorHandler());
  return app;
}
