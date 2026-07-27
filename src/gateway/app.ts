import express, { type Express, type RequestHandler } from 'express';

import type { ClientService } from '../clients/service';
import {
  CreateClientRequestSchema,
  RunAutomationRequestSchema,
  type JsonValue
} from '../config/schemas';
import { AppError } from '../utils/errors';
import { installDashboardRoutes, type DashboardApi } from '../dashboard/routes';
import {
  requireLoopbackControlPlaneRead,
  requireLoopbackMutation
} from './loopback-mutation-guard';
import { errorHandler, notFound, observeRequests, type RequestLogSink } from './middleware';
import type { RequestMetrics } from './metrics';

export interface HealthResult {
  timestamp: string;
  overall: 'healthy' | 'degraded';
  severity: 'none' | 'P1';
  checks: Record<string, string>;
  failures: string[];
  action: 'none' | 'escalate_P1';
}

export interface HealthProvider {
  check(): Promise<HealthResult>;
}

const CORE_READINESS_FAILURES = new Set([
  'gateway_down',
  'database_down',
  'disk_low',
  'disk_unavailable'
]);

function coreReadiness(health: HealthResult): {
  timestamp: string;
  status: 'ready' | 'not_ready';
  checks: Record<'gateway' | 'database' | 'disk', string>;
  failures: string[];
} {
  const checks = {
    gateway: health.checks.gateway ?? 'unavailable',
    database: health.checks.database ?? 'unavailable',
    disk: health.checks.disk ?? 'unavailable'
  };
  const failures = health.failures.filter((failure) => CORE_READINESS_FAILURES.has(failure));
  if (checks.gateway !== 'ok' && !failures.includes('gateway_down')) {
    failures.push('gateway_down');
  }
  if (checks.database !== 'ok' && !failures.includes('database_down')) {
    failures.push('database_down');
  }
  if (!checks.disk.startsWith('ok:') && !failures.some((failure) => failure.startsWith('disk_'))) {
    failures.push('disk_unavailable');
  }

  return {
    timestamp: health.timestamp,
    status: failures.length === 0 ? 'ready' : 'not_ready',
    checks,
    failures
  };
}

export interface RunAutomationInput {
  clientId: string;
  automation: string;
  input?: JsonValue;
}

export interface RunAutomationResult {
  run: {
    id: string;
    clientId: string;
    automation: string;
    status: 'succeeded' | 'failed';
    completedAt: string;
  };
  result: JsonValue;
  diagramPath: string;
  warnings?: Array<{
    code: 'WORKER_RELEASE_FAILED' | 'FREQUENCY_RECORD_FAILED' | 'POST_SUCCESS_AUDIT_FAILED';
    message: string;
  }>;
}

export interface AutomationRunner {
  run(input: RunAutomationInput): Promise<RunAutomationResult>;
}

export interface AppDependencies {
  clients: ClientService;
  runner: AutomationRunner;
  metrics: RequestMetrics;
  health: HealthProvider;
  requestLog: RequestLogSink;
  dashboard?: DashboardApi;
  dashboardDelegationEvents?: RequestHandler;
  dashboardRoot?: string;
}

function validationError(issues: unknown): AppError {
  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', issues);
}

export function createApp(dependencies: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(observeRequests(dependencies.metrics, dependencies.requestLog));
  app.use(express.json({ limit: '1mb', strict: true }));

  if (dependencies.dashboard !== undefined) {
    if (dependencies.dashboardRoot === undefined) {
      throw new Error('dashboardRoot is required when dashboard routes are enabled');
    }
    installDashboardRoutes(app, {
      api: dependencies.dashboard,
      dashboardRoot: dependencies.dashboardRoot,
      ...(dependencies.dashboardDelegationEvents === undefined
        ? {}
        : { delegationEvents: dependencies.dashboardDelegationEvents })
    });
  }

  app.get('/livez', (_request, response) => {
    response.json({ status: 'alive' });
  });

  app.get('/readyz', async (_request, response) => {
    const readiness = coreReadiness(await dependencies.health.check());
    response.status(readiness.status === 'ready' ? 200 : 503).json(readiness);
  });

  app.get('/health', requireLoopbackControlPlaneRead, async (_request, response) => {
    const health = await dependencies.health.check();
    response.json({ ...health, metrics: dependencies.metrics.snapshot() });
  });

  app.get('/api/v1/clients', requireLoopbackControlPlaneRead, async (_request, response) => {
    response.json({ clients: await dependencies.clients.list() });
  });

  app.post('/api/v1/clients', requireLoopbackMutation, async (request, response) => {
    const parsed = CreateClientRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw validationError(parsed.error.issues);
    }

    const client = await dependencies.clients.create(parsed.data);
    response.status(201).json(client);
  });

  app.post<{ id: string }>(
    '/api/v1/clients/:id/run',
    requireLoopbackMutation,
    async (request, response) => {
      const clientId = request.params.id;
      const tenantId = response.locals.tenantId as string | undefined;
      if (tenantId !== undefined && tenantId !== clientId) {
        throw new AppError(403, 'TENANT_MISMATCH', 'Tenant header does not match route client');
      }

      const parsed = RunAutomationRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues);
      }

      const client = await dependencies.clients.findById(clientId);
      if (client === undefined) {
        throw new AppError(404, 'CLIENT_NOT_FOUND', `Client ${clientId} was not found`);
      }

      const result = await dependencies.runner.run({
        clientId,
        automation: parsed.data.automation,
        ...(parsed.data.input === undefined ? {} : { input: parsed.data.input })
      });
      dependencies.metrics.recordRun(clientId, result.run.completedAt);
      response.json(result);
    }
  );

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
