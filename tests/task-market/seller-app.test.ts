import { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createTaskMarketSellerApp, type SellerReadiness } from '../../src/task-market/seller-app';
import { evaluateEdgeValidation } from '../../src/task-market/edge-validation';

const validInput = {
  schemaVersion: 1 as const,
  observations: [10, 10, 10, 10, 10],
  parameters: {
    minObservations: 5,
    minimumMean: 10,
    confidenceZ: 1.96
  }
};

function paidOnly(expected = 'test-payment'): RequestHandler {
  return (incoming, response, next) => {
    if (incoming.header('payment-signature') !== expected) {
      response.status(402).json({ error: { code: 'PAYMENT_REQUIRED' } });
      return;
    }
    next();
  };
}

const ready = (): SellerReadiness => ({ ready: true, reason: 'ready' });

describe('task-market seller HTTP app', () => {
  it('publishes bounded public health and product metadata without operator routes', async () => {
    const app = createTaskMarketSellerApp({
      mode: 'simulation',
      readiness: ready,
      paymentMiddleware: paidOnly()
    });

    await request(app).get('/livez').expect(200, { status: 'alive' });
    await request(app).get('/readyz').expect(200, {
      status: 'ready',
      mode: 'simulation',
      product: 'edge-validation-v1'
    });
    const metadata = await request(app).get('/.well-known/task-market.json').expect(200);
    expect(metadata.body).toEqual({
      schemaVersion: 1,
      service: 'jarvis-task-market',
      mode: 'simulation',
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
    await request(app).get('/api/v1/clients').expect(404);
    await request(app).get('/dashboard').expect(404);
  });

  it('validates the bounded request before asking for payment', async () => {
    const payments = vi.fn<RequestHandler>((_incoming, _response, next) => next());
    const execute = vi.fn();
    const app = createTaskMarketSellerApp({
      mode: 'simulation',
      readiness: ready,
      paymentMiddleware: payments,
      execute
    });

    const response = await request(app)
      .post('/v1/edge-validation')
      .send({ ...validInput, observations: [1, 2, 3] })
      .expect(400);

    expect(response.body).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'Request validation failed' }
    });
    expect(payments).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects unavailable capacity before payment or execution', async () => {
    const payments = vi.fn<RequestHandler>((_incoming, _response, next) => next());
    const execute = vi.fn();
    const app = createTaskMarketSellerApp({
      mode: 'simulation',
      readiness: () => ({ ready: false, reason: 'capacity_unavailable' }),
      paymentMiddleware: payments,
      execute
    });

    await request(app)
      .post('/v1/edge-validation')
      .send(validInput)
      .expect(503, {
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Service is not accepting paid work' }
      });
    expect(payments).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not execute an unpaid request and executes an authorized request once', async () => {
    const execute = vi.fn(evaluateEdgeValidation);
    const app = createTaskMarketSellerApp({
      mode: 'simulation',
      readiness: ready,
      paymentMiddleware: paidOnly(),
      execute
    });

    await request(app).post('/v1/edge-validation').send(validInput).expect(402);
    expect(execute).not.toHaveBeenCalled();

    const response = await request(app)
      .post('/v1/edge-validation')
      .set('payment-signature', 'test-payment')
      .send(validInput)
      .expect(200);

    expect(response.body).toMatchObject({
      schemaVersion: 1,
      algorithm: { id: 'edge-validation', version: '1.0.0' },
      verdict: 'PASS'
    });
    expect(response.body).not.toHaveProperty('observations');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('bounds request bodies before payment and redacts internal execution failures', async () => {
    const payments = vi.fn<RequestHandler>((_incoming, _response, next) => next());
    const app = createTaskMarketSellerApp({
      mode: 'simulation',
      readiness: ready,
      paymentMiddleware: payments,
      execute: () => {
        throw new Error('secret-internal-detail');
      }
    });

    await request(app)
      .post('/v1/edge-validation')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(70_000) }))
      .expect(413, {
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the service limit' }
      });
    expect(payments).not.toHaveBeenCalled();

    const failure = await request(app).post('/v1/edge-validation').send(validInput).expect(500);
    expect(JSON.stringify(failure.body)).not.toContain('secret-internal-detail');
    expect(failure.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Request could not be completed' }
    });
  });
});
