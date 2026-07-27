import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { DatabaseClientService } from '../../src/clients/service';
import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import { ClientRepository } from '../../src/db/client-repository';
import {
  createApp,
  type AutomationRunner,
  type RunAutomationInput,
  type RunAutomationResult
} from '../../src/gateway/app';
import { RequestMetrics } from '../../src/gateway/metrics';
import type { RequestLogEntry } from '../../src/gateway/middleware';

const projectRoot = join(__dirname, '..', '..');
const now = '2026-07-18T12:00:00.000Z';

class RecordingRunner implements AutomationRunner {
  readonly inputs: RunAutomationInput[] = [];

  run(input: RunAutomationInput): Promise<RunAutomationResult> {
    this.inputs.push(input);
    return Promise.resolve({
      run: {
        id: 'run-1',
        clientId: input.clientId,
        automation: input.automation,
        status: 'succeeded',
        completedAt: now
      },
      result: { qualifiedCount: 4 },
      diagramPath: '/tmp/logs/diagrams/flow_run-1.md'
    });
  }
}

describe('gateway app', () => {
  let temporaryRoot: string;
  let database: GlobalDatabaseContext;
  let runner: RecordingRunner;
  let metrics: RequestMetrics;
  let logs: RequestLogEntry[];
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-gateway-test-'));
    database = await createDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    runner = new RecordingRunner();
    metrics = new RequestMetrics();
    logs = [];
    app = createApp({
      clients: new DatabaseClientService(new ClientRepository(database.db), () => now),
      runner,
      metrics,
      health: {
        check: () =>
          Promise.resolve({
            timestamp: now,
            overall: 'healthy',
            severity: 'none',
            checks: { gateway: 'ok', database: 'ok' },
            failures: [],
            action: 'none'
          })
      },
      requestLog: (entry) => logs.push(entry)
    });
  });

  afterEach(async () => {
    await database.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  async function createAcme(): Promise<void> {
    await request(app)
      .post('/api/v1/clients')
      .send({ id: 'acme_corp', name: 'Acme Corporation', profile: 'data_processing' })
      .expect(201);
  }

  it('returns structured health with request metrics', async () => {
    const response = await request(app).get('/health').expect(200);

    expect(response.body).toEqual({
      timestamp: now,
      overall: 'healthy',
      severity: 'none',
      checks: { gateway: 'ok', database: 'ok' },
      failures: [],
      action: 'none',
      metrics: {
        totalRequests: 1,
        errors: 0,
        lastRunAtByClient: {}
      }
    });
  });

  it.each(['/health', '/api/v1/clients'])(
    'rejects DNS-rebinding reads of control-plane details at %s',
    async (path) => {
      const response = await request(app)
        .get(path)
        .set('Host', 'jarvis.attacker.example')
        .expect(403);

      expect(response.body).toEqual({
        error: {
          code: 'CONTROL_PLANE_HOST_FORBIDDEN',
          message: 'Control-plane details require an exact loopback host'
        }
      });
    }
  );

  it('separates liveness from core readiness', async () => {
    await request(app).get('/livez').expect(200, { status: 'alive' });

    const readyApp = createApp({
      clients: new DatabaseClientService(new ClientRepository(database.db), () => now),
      runner,
      metrics: new RequestMetrics(),
      health: {
        check: () =>
          Promise.resolve({
            timestamp: now,
            overall: 'degraded',
            severity: 'P1',
            checks: {
              gateway: 'ok',
              database: 'ok',
              disk: 'ok:16%_free',
              ollama: 'unreachable',
              docker: 'down'
            },
            failures: ['ollama_unreachable', 'docker_down'],
            action: 'escalate_P1'
          })
      },
      requestLog: () => undefined
    });

    await request(readyApp)
      .get('/readyz')
      .expect(200, {
        timestamp: now,
        status: 'ready',
        checks: { gateway: 'ok', database: 'ok', disk: 'ok:16%_free' },
        failures: []
      });
  });

  it('returns service unavailable when a core readiness check fails', async () => {
    const notReadyApp = createApp({
      clients: new DatabaseClientService(new ClientRepository(database.db), () => now),
      runner,
      metrics: new RequestMetrics(),
      health: {
        check: () =>
          Promise.resolve({
            timestamp: now,
            overall: 'degraded',
            severity: 'P1',
            checks: {
              gateway: 'ok',
              database: 'down',
              disk: 'critical:8%_free',
              ollama: 'ok',
              docker: 'ok'
            },
            failures: ['database_down', 'disk_low'],
            action: 'escalate_P1'
          })
      },
      requestLog: () => undefined
    });

    await request(notReadyApp).get('/livez').expect(200, { status: 'alive' });
    await request(notReadyApp)
      .get('/readyz')
      .expect(503, {
        timestamp: now,
        status: 'not_ready',
        checks: { gateway: 'ok', database: 'down', disk: 'critical:8%_free' },
        failures: ['database_down', 'disk_low']
      });
  });

  it('lists an empty registry and then a persisted client', async () => {
    await request(app).get('/api/v1/clients').expect(200, { clients: [] });
    await createAcme();

    const response = await request(app).get('/api/v1/clients').expect(200);

    const body = response.body as { clients: unknown[] };
    expect(body.clients).toEqual([
      {
        id: 'acme_corp',
        name: 'Acme Corporation',
        profile: 'data_processing',
        status: 'active',
        createdAt: now
      }
    ]);
  });

  it('rejects invalid and unknown client fields', async () => {
    const response = await request(app)
      .post('/api/v1/clients')
      .send({ id: '../acme', name: 'Acme', profile: 'data_processing', secret: 'nope' })
      .expect(400);

    const body = response.body as { error: { code: string; message: string } };
    expect(body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed'
    });
  });

  it('returns a conflict for a duplicate client', async () => {
    await createAcme();

    const response = await request(app)
      .post('/api/v1/clients')
      .send({ id: 'acme_corp', name: 'Other Acme', profile: 'email_only' })
      .expect(409);

    expect(response.body).toEqual({
      error: { code: 'CLIENT_EXISTS', message: 'Client acme_corp already exists' }
    });
  });

  it('rejects DNS-rebinding hosts before creating a client', async () => {
    const response = await request(app)
      .post('/api/v1/clients')
      .set('Host', 'jarvis.attacker.example')
      .send({ id: 'acme_corp', name: 'Acme Corporation', profile: 'data_processing' })
      .expect(403);

    expect(response.body).toEqual({
      error: {
        code: 'DASHBOARD_ORIGIN_FORBIDDEN',
        message: 'Dashboard mutations require the exact loopback dashboard origin'
      }
    });
    await request(app).get('/api/v1/clients').expect(200, { clients: [] });
  });

  it('rejects cross-origin browser requests before running client automation', async () => {
    await createAcme();

    const response = await request(app)
      .post('/api/v1/clients/acme_corp/run')
      .set('Host', '127.0.0.1')
      .set('Origin', 'https://attacker.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ automation: 'daily-report' })
      .expect(403);

    expect(response.body).toEqual({
      error: {
        code: 'DASHBOARD_ORIGIN_FORBIDDEN',
        message: 'Dashboard mutations require the exact loopback dashboard origin'
      }
    });
    expect(runner.inputs).toHaveLength(0);
  });

  it('routes a registered client run with the injected tenant context', async () => {
    await createAcme();

    const response = await request(app)
      .post('/api/v1/clients/acme_corp/run')
      .set('x-tenant-id', 'acme_corp')
      .send({ automation: 'daily-report', input: { status: 'qualified' } })
      .expect(200);

    expect(response.body).toMatchObject({
      run: { id: 'run-1', clientId: 'acme_corp', status: 'succeeded' },
      result: { qualifiedCount: 4 }
    });
    expect(runner.inputs).toEqual([
      {
        clientId: 'acme_corp',
        automation: 'daily-report',
        input: { status: 'qualified' }
      }
    ]);
    expect(metrics.snapshot().lastRunAtByClient).toEqual({ acme_corp: now });
  });

  it('rejects a tenant header that does not match the route', async () => {
    await createAcme();

    const response = await request(app)
      .post('/api/v1/clients/acme_corp/run')
      .set('x-tenant-id', 'other_client')
      .send({ automation: 'daily-report' })
      .expect(403);

    const body = response.body as { error: { code: string } };
    expect(body.error.code).toBe('TENANT_MISMATCH');
    expect(runner.inputs).toHaveLength(0);
  });

  it('returns not found for an unknown client and an unknown route', async () => {
    const clientResponse = await request(app)
      .post('/api/v1/clients/missing_client/run')
      .send({ automation: 'daily-report' })
      .expect(404);
    const routeResponse = await request(app).get('/missing').expect(404);

    const clientBody = clientResponse.body as { error: { code: string } };
    const routeBody = routeResponse.body as { error: { code: string } };
    expect(clientBody.error.code).toBe('CLIENT_NOT_FOUND');
    expect(routeBody.error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('logs completed requests and counts error responses', async () => {
    await request(app).get('/missing').expect(404);
    await request(app).get('/health').expect(200);

    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ method: 'GET', path: '/missing', status: 404 });
    expect(metrics.snapshot()).toMatchObject({ totalRequests: 2, errors: 1 });
  });

  it('normalizes malformed JSON as a validation response', async () => {
    const response = await request(app)
      .post('/api/v1/clients')
      .set('content-type', 'application/json')
      .send('{bad-json')
      .expect(400);

    const body = response.body as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_JSON');
  });

  it('rejects an invalid run request before invoking the runner', async () => {
    await createAcme();

    const response = await request(app)
      .post('/api/v1/clients/acme_corp/run')
      .send({ automation: '../unsafe' })
      .expect(400);

    const body = response.body as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(runner.inputs).toHaveLength(0);
  });

  it('returns a safe internal error when an unexpected dependency fails', async () => {
    await createAcme();
    const failingApp = createApp({
      clients: new DatabaseClientService(new ClientRepository(database.db), () => now),
      runner: {
        run: () => Promise.reject(new Error('sensitive failure'))
      },
      metrics: new RequestMetrics(),
      health: {
        check: () =>
          Promise.resolve({
            timestamp: now,
            overall: 'healthy',
            severity: 'none',
            checks: { gateway: 'ok', database: 'ok' },
            failures: [],
            action: 'none'
          })
      },
      requestLog: () => undefined
    });

    const response = await request(failingApp)
      .post('/api/v1/clients/acme_corp/run')
      .send({ automation: 'daily-report' })
      .expect(500);

    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }
    });
  });
});
