import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from 'express';

import { createEdgeValidationMcpServer } from '../../src/task-market/mcp-server';
import {
  createConfiguredSellerApp,
  createSimulationPaymentRuntime,
  parseTaskMarketSellerServerConfig,
  startTaskMarketSeller,
  type PaidSellerServerConfig,
  type SellerPaymentRuntime
} from '../../src/task-market/seller-server';
import type { SuccessfulSettlementInput } from '../../src/task-market/settlement-ledger';
import type { X402RuntimeOptions } from '../../src/task-market/x402-runtime';

const TOKEN = 'a'.repeat(64);
const PAY_TO = '0x1111111111111111111111111111111111111111';
const LEDGER_PATH = '/var/lib/jarvis-task-market/settlements.sqlite';
const input = {
  schemaVersion: 1 as const,
  observations: [10, 10, 10, 10, 10],
  parameters: { minObservations: 5, minimumMean: 10, confidenceZ: 1.96 }
};

describe('task-market seller server configuration', () => {
  it('defaults simulation to loopback and requires an explicit high-entropy token', () => {
    expect(
      parseTaskMarketSellerServerConfig({
        TASK_MARKET_MODE: 'simulation',
        TASK_MARKET_SIMULATION_TOKEN: TOKEN
      })
    ).toEqual({
      schemaVersion: 1,
      mode: 'simulation',
      host: '127.0.0.1',
      port: 4021,
      acceptingWork: true,
      simulationToken: TOKEN
    });

    for (const invalid of [
      { TASK_MARKET_MODE: 'simulation' },
      { TASK_MARKET_MODE: 'simulation', TASK_MARKET_SIMULATION_TOKEN: 'short' },
      {
        TASK_MARKET_MODE: 'simulation',
        TASK_MARKET_SIMULATION_TOKEN: TOKEN,
        TASK_MARKET_HOST: '0.0.0.0'
      }
    ]) {
      expect(() => parseTaskMarketSellerServerConfig(invalid)).toThrow();
    }
  });

  it('parses testnet hosting only through the strict x402 seller configuration', () => {
    expect(
      parseTaskMarketSellerServerConfig({
        TASK_MARKET_MODE: 'testnet',
        TASK_MARKET_NETWORK: 'eip155:84532',
        TASK_MARKET_FACILITATOR_URL: 'https://x402.org/facilitator',
        TASK_MARKET_PAY_TO: PAY_TO,
        TASK_MARKET_PRICE: '$0.01',
        TASK_MARKET_PUBLIC_BASE_URL: 'https://edge.example.test',
        TASK_MARKET_HOST: '0.0.0.0',
        TASK_MARKET_PORT: '8080',
        TASK_MARKET_ACCEPTING_WORK: 'false',
        TASK_MARKET_SETTLEMENT_LEDGER_PATH: LEDGER_PATH
      })
    ).toEqual({
      schemaVersion: 1,
      mode: 'testnet',
      host: '0.0.0.0',
      port: 8080,
      acceptingWork: false,
      settlementLedgerPath: LEDGER_PATH,
      x402: {
        schemaVersion: 1,
        mode: 'testnet',
        network: 'eip155:84532',
        facilitatorUrl: 'https://x402.org/facilitator',
        payTo: PAY_TO,
        price: '$0.01',
        publicBaseUrl: 'https://edge.example.test'
      }
    });
  });

  it('defaults every paid deployment to the disabled kill-switch state', () => {
    expect(
      parseTaskMarketSellerServerConfig({
        TASK_MARKET_MODE: 'testnet',
        TASK_MARKET_NETWORK: 'eip155:84532',
        TASK_MARKET_FACILITATOR_URL: 'https://x402.org/facilitator',
        TASK_MARKET_PAY_TO: PAY_TO,
        TASK_MARKET_PRICE: '$0.01',
        TASK_MARKET_PUBLIC_BASE_URL: 'https://edge.example.test',
        TASK_MARKET_SETTLEMENT_LEDGER_PATH: LEDGER_PATH
      })
    ).toMatchObject({ acceptingWork: false });
    expect(() =>
      parseTaskMarketSellerServerConfig({
        TASK_MARKET_MODE: 'testnet',
        TASK_MARKET_NETWORK: 'eip155:84532',
        TASK_MARKET_FACILITATOR_URL: 'https://x402.org/facilitator',
        TASK_MARKET_PAY_TO: PAY_TO,
        TASK_MARKET_PRICE: '$0.01',
        TASK_MARKET_PUBLIC_BASE_URL: 'https://edge.example.test',
        TASK_MARKET_SETTLEMENT_LEDGER_PATH: LEDGER_PATH,
        TASK_MARKET_ACCEPTING_WORK: 'true'
      })
    ).toThrow(/Task 29 MCP and Origin review/i);
  });

  it('rejects unsafe ports, hosts, booleans, and unknown modes without echoing secrets', () => {
    for (const changed of [
      { TASK_MARKET_PORT: '0' },
      { TASK_MARKET_PORT: '65536' },
      { TASK_MARKET_PORT: '1.5' },
      { TASK_MARKET_HOST: 'example.com' },
      { TASK_MARKET_ACCEPTING_WORK: 'yes' },
      { TASK_MARKET_MODE: 'mainnet' }
    ]) {
      expect(() =>
        parseTaskMarketSellerServerConfig({
          TASK_MARKET_MODE: 'simulation',
          TASK_MARKET_SIMULATION_TOKEN: TOKEN,
          ...changed
        })
      ).toThrow();
    }
  });

  it('requires an absolute, dedicated paid settlement ledger filename', () => {
    const environment = {
      TASK_MARKET_MODE: 'testnet',
      TASK_MARKET_NETWORK: 'eip155:84532',
      TASK_MARKET_FACILITATOR_URL: 'https://x402.org/facilitator',
      TASK_MARKET_PAY_TO: PAY_TO,
      TASK_MARKET_PRICE: '$0.01',
      TASK_MARKET_PUBLIC_BASE_URL: 'https://edge.example.test'
    };

    for (const invalidPath of ['relative/settlements.sqlite', '/tmp/jarvis.sqlite']) {
      expect(() =>
        parseTaskMarketSellerServerConfig({
          ...environment,
          TASK_MARKET_SETTLEMENT_LEDGER_PATH: invalidPath
        })
      ).toThrow(/ledger/i);
    }
  });
});

describe('simulation payment runtime', () => {
  const closeCallbacks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map((close) => close()));
  });

  it('protects HTTP execution with a redacted exact token check', async () => {
    const runtime = createSimulationPaymentRuntime(TOKEN, () => true);
    const app = await createConfiguredSellerApp({
      schemaVersion: 1,
      mode: 'simulation',
      host: '127.0.0.1',
      port: 4021,
      acceptingWork: true,
      simulationToken: TOKEN
    });

    const denied = await request(app).post('/v1/edge-validation').send(input).expect(402);
    expect(denied.body).toEqual({
      error: { code: 'PAYMENT_REQUIRED', message: 'Simulation payment proof required' }
    });
    expect(JSON.stringify(denied.body)).not.toContain(TOKEN);

    const paid = await request(app)
      .post('/v1/edge-validation')
      .set('x-jarvis-simulation-payment', TOKEN)
      .send(input)
      .expect(200);
    expect(paid.body).toMatchObject({ verdict: 'PASS' });

    const middlewareResult = vi.fn();
    runtime.paymentMiddleware({ header: () => TOKEN } as never, {} as never, middlewareResult);
    expect(middlewareResult).toHaveBeenCalledOnce();
  });

  it('protects MCP tool execution with metadata and does not run on denial', async () => {
    const execute = vi.fn(() => {
      throw new Error('must not execute');
    });
    const deniedRuntime = createSimulationPaymentRuntime(TOKEN, () => true);
    const deniedServer = createEdgeValidationMcpServer({
      paymentWrapper: deniedRuntime.mcpPaymentWrapper,
      execute
    });
    const deniedClient = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await deniedServer.connect(serverTransport);
    await deniedClient.connect(clientTransport);
    closeCallbacks.push(async () => {
      await deniedClient.close();
      await deniedServer.close();
    });

    const result = await deniedClient.callTool({ name: 'edge_validation_v1', arguments: input });
    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();

    const runtime = createSimulationPaymentRuntime(TOKEN, () => true);
    const wrapped = runtime.mcpPaymentWrapper(() => ({
      content: [{ type: 'text', text: 'ok' }]
    }));
    await expect(
      wrapped(input, { _meta: { 'jarvis/simulation-payment': TOKEN } })
    ).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('denies both protocols when the service stops accepting work', async () => {
    const runtime = createSimulationPaymentRuntime(TOKEN, () => false);
    const next = vi.fn();
    const status = vi.fn(() => ({ json: vi.fn() }));
    runtime.paymentMiddleware({ header: () => TOKEN } as never, { status } as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(503);

    const wrapped = runtime.mcpPaymentWrapper(() => ({
      content: [{ type: 'text', text: 'should-not-run' }]
    }));
    const result = await wrapped(input, {
      _meta: { 'jarvis/simulation-payment': TOKEN }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe('paid seller settlement lifecycle', () => {
  const paidConfig = (settlementLedgerPath: string): PaidSellerServerConfig => ({
    schemaVersion: 1,
    mode: 'testnet',
    host: '127.0.0.1',
    port: 0,
    acceptingWork: true,
    settlementLedgerPath,
    x402: {
      schemaVersion: 1,
      mode: 'testnet',
      network: 'eip155:84532',
      facilitatorUrl: 'https://x402.org/facilitator',
      payTo: PAY_TO,
      price: '$0.01',
      publicBaseUrl: 'https://edge.example.test'
    }
  });

  const paidRuntime = (): SellerPaymentRuntime => {
    const paymentMiddleware: RequestHandler = (_request, _response, next) => {
      next();
    };
    return {
      paymentMiddleware,
      mcpPaymentWrapper: (handler) => (args, context) => handler(args, context)
    };
  };

  const settlement: SuccessfulSettlementInput = {
    schemaVersion: 1,
    mode: 'testnet',
    productId: 'edge-validation-v1',
    network: 'base-sepolia',
    transactionHash: `0x${'c'.repeat(64)}`,
    amountBaseUnits: '10000',
    payerAddress: PAY_TO,
    settledAt: '2026-07-20T12:00:00.000Z'
  };

  it('owns the paid ledger, wires its recorder, and closes it exactly once with the server', async () => {
    const ledger = { record: vi.fn(), close: vi.fn() };
    let runtimeOptions: X402RuntimeOptions | undefined;
    const createPaidRuntime = vi.fn((_config, options: X402RuntimeOptions) => {
      runtimeOptions = options;
      return Promise.resolve(paidRuntime());
    });
    const openSettlementLedger = vi.fn(() => Promise.resolve(ledger));
    const running = await startTaskMarketSeller(paidConfig(LEDGER_PATH), {
      createPaidRuntime,
      openSettlementLedger
    });

    expect(openSettlementLedger).toHaveBeenCalledWith(LEDGER_PATH);
    expect(runtimeOptions?.recordSettlement).toBeTypeOf('function');
    await runtimeOptions?.recordSettlement?.(settlement);
    expect(ledger.record).toHaveBeenCalledWith(settlement);

    await running.close();
    await running.close();
    expect(ledger.close).toHaveBeenCalledOnce();
  });

  it('closes the ledger when paid runtime startup fails', async () => {
    const ledger = { record: vi.fn(), close: vi.fn() };
    await expect(
      startTaskMarketSeller(paidConfig(LEDGER_PATH), {
        openSettlementLedger: () => Promise.resolve(ledger),
        createPaidRuntime: () => Promise.reject(new Error('runtime failed'))
      })
    ).rejects.toThrow('runtime failed');
    expect(ledger.close).toHaveBeenCalledOnce();
  });

  it('fails readiness closed after the settlement recorder reports a failure', async () => {
    const ledger = { record: vi.fn(), close: vi.fn() };
    const onSettlementLedgerFailure = vi.fn();
    let runtimeOptions: X402RuntimeOptions | undefined;
    const running = await startTaskMarketSeller(paidConfig(LEDGER_PATH), {
      openSettlementLedger: () => Promise.resolve(ledger),
      createPaidRuntime: (_config, options) => {
        runtimeOptions = options;
        return Promise.resolve(paidRuntime());
      },
      onSettlementLedgerFailure
    });

    try {
      await request(running.app).get('/readyz').expect(200);
      await runtimeOptions?.onSettlementRecorderFailure?.();
      await request(running.app).get('/readyz').expect(503);
      await request(running.app).post('/v1/edge-validation').send(input).expect(503);
      expect(onSettlementLedgerFailure).toHaveBeenCalledOnce();
      expect(ledger.record).not.toHaveBeenCalled();
    } finally {
      await running.close();
    }
  });

  it('creates the ledger parent and database with restrictive permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-paid-seller-'));
    const ledgerPath = join(root, 'jarvis-task-market', 'settlements.sqlite');
    let runtimeOptions: X402RuntimeOptions | undefined;
    const running = await startTaskMarketSeller(paidConfig(ledgerPath), {
      createPaidRuntime: (_config, options) => {
        runtimeOptions = options;
        return Promise.resolve(paidRuntime());
      }
    });

    try {
      const directoryMode = (await stat(join(root, 'jarvis-task-market'))).mode & 0o777;
      const databaseMode = (await stat(ledgerPath)).mode & 0o777;
      expect(directoryMode).toBe(0o700);
      expect(databaseMode).toBe(0o600);
      await runtimeOptions?.recordSettlement?.(settlement);
    } finally {
      await running.close();
      await rm(root, { recursive: true });
    }
  });
});
