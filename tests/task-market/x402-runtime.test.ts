import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from 'express';

import { SettlementLedger } from '../../src/task-market/settlement-ledger';
import {
  X402SellerConfigSchema,
  computeMainnetApprovalDigest,
  createBazaarDiscovery,
  createX402Runtime,
  parseX402SellerConfig,
  type X402RuntimeDependencies,
  type X402SellerConfig
} from '../../src/task-market/x402-runtime';

const testnet = {
  schemaVersion: 1 as const,
  mode: 'testnet' as const,
  network: 'eip155:84532' as const,
  facilitatorUrl: 'https://x402.org/facilitator',
  payTo: '0x1111111111111111111111111111111111111111',
  price: '$0.01',
  publicBaseUrl: 'https://edge.example.test'
} satisfies X402SellerConfig;

const transactionHash = `0x${'a'.repeat(64)}`;

interface SettlementHookContext {
  result: {
    success: boolean;
    transaction: string;
    network: string;
    amount?: string;
    payer?: string;
  };
  requirements: {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
  };
  paymentPayload: Record<string, unknown>;
  declaredExtensions: Record<string, unknown>;
}

function createFakeRuntimeDependencies() {
  let settlementHook: ((context: SettlementHookContext) => Promise<void>) | undefined;
  const resourceServer = {
    register: vi.fn(() => resourceServer),
    onAfterSettle: vi.fn((hook: (context: SettlementHookContext) => Promise<void>) => {
      settlementHook = hook;
      return resourceServer;
    }),
    initialize: vi.fn(() => Promise.resolve()),
    buildPaymentRequirements: vi.fn(
      (options: { scheme: 'exact'; network: string; payTo: string; price: string }) =>
        Promise.resolve([
          {
            scheme: options.scheme,
            network: options.network,
            asset: '0x0000000000000000000000000000000000000001',
            amount: '10000',
            payTo: options.payTo,
            maxTimeoutSeconds: 60,
            extra: {}
          }
        ])
    )
  };
  const middleware: RequestHandler = (_request, _response, next) => {
    next();
  };
  const createHttpPaymentMiddleware: X402RuntimeDependencies['createHttpPaymentMiddleware'] = () =>
    middleware;
  const createMcpPaymentWrapper: X402RuntimeDependencies['createMcpPaymentWrapper'] =
    () => (handler) => (args, context) =>
      handler(args, context);
  const dependencies = {
    createResourceServer: vi.fn(() => resourceServer),
    createHttpPaymentMiddleware: vi.fn(createHttpPaymentMiddleware),
    createMcpPaymentWrapper: vi.fn(createMcpPaymentWrapper)
  };

  return {
    dependencies,
    resourceServer,
    middleware,
    getSettlementHook: () => {
      if (settlementHook === undefined) throw new Error('settlement hook was not registered');
      return settlementHook;
    }
  };
}

function settlementContext(
  changed: Partial<SettlementHookContext['result']> = {},
  requirementAmount = '10000',
  changedRequirements: Partial<SettlementHookContext['requirements']> = {}
): SettlementHookContext {
  return {
    result: {
      success: true,
      transaction: transactionHash,
      network: testnet.network,
      amount: '10000',
      payer: testnet.payTo,
      ...changed
    },
    requirements: {
      scheme: 'exact',
      network: testnet.network,
      asset: '0x0000000000000000000000000000000000000001',
      amount: requirementAmount,
      payTo: testnet.payTo,
      ...changedRequirements
    },
    paymentPayload: { privatePayload: 'must-never-be-recorded' },
    declaredExtensions: {}
  };
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('x402 seller runtime configuration', () => {
  it('accepts an exact Base Sepolia configuration and produces MCP Bazaar metadata', () => {
    expect(X402SellerConfigSchema.parse(testnet)).toEqual(testnet);
    expect(createBazaarDiscovery()).toMatchObject({
      bazaar: {
        info: {
          input: {
            type: 'mcp',
            toolName: 'edge_validation_v1',
            transport: 'streamable-http'
          }
        }
      }
    });
  });

  it('rejects mainnet unless every reviewed activation value matches exactly', async () => {
    const approvalBinding = {
      schemaVersion: 1 as const,
      approved: true as const,
      network: 'eip155:8453',
      facilitatorUrl: 'https://api.cdp.coinbase.com/platform/v2/x402',
      payTo: testnet.payTo,
      price: '$0.01',
      publicBaseUrl: testnet.publicBaseUrl
    };
    const mainnet = {
      ...testnet,
      mode: 'mainnet_enabled',
      network: 'eip155:8453',
      facilitatorUrl: 'https://api.cdp.coinbase.com/platform/v2/x402',
      approval: {
        ...approvalBinding,
        approvalDigest: computeMainnetApprovalDigest(approvalBinding)
      }
    };

    const parsedMainnet = X402SellerConfigSchema.parse(mainnet);
    expect(parsedMainnet).toMatchObject({ mode: 'mainnet_enabled' });
    for (const changed of [
      { network: 'eip155:84532' },
      { facilitatorUrl: 'https://x402.org/facilitator' },
      { payTo: '0x2222222222222222222222222222222222222222' },
      { price: '$0.02' },
      { publicBaseUrl: 'https://other.example.test' }
    ]) {
      expect(() => X402SellerConfigSchema.parse({ ...mainnet, ...changed })).toThrowError(
        /approval/i
      );
    }
    expect(() =>
      X402SellerConfigSchema.parse({
        ...mainnet,
        approval: { ...mainnet.approval, approvalDigest: 'a'.repeat(64) }
      })
    ).toThrowError(/digest/i);
    expect(() => X402SellerConfigSchema.parse({ ...mainnet, approval: undefined })).toThrowError();
    await expect(createX402Runtime(parsedMainnet, { acceptingWork: () => false })).rejects.toThrow(
      /authenticated facilitator adapter/i
    );
  });

  it('fails closed on unsafe URLs, malformed addresses, unknown fields, and simulation mode', () => {
    for (const invalid of [
      { ...testnet, facilitatorUrl: 'http://x402.org/facilitator' },
      { ...testnet, facilitatorUrl: 'https://user:pass@x402.org/facilitator' },
      { ...testnet, publicBaseUrl: 'http://edge.example.test' },
      { ...testnet, publicBaseUrl: 'https://edge.example.test/path' },
      { ...testnet, payTo: '0x1234' },
      { ...testnet, price: '$0' },
      { ...testnet, secret: 'forbidden' },
      { ...testnet, mode: 'simulation' }
    ]) {
      expect(() => X402SellerConfigSchema.parse(invalid)).toThrow();
    }
  });

  it('parses only allowlisted environment keys without returning unrelated secrets', () => {
    const parsed = parseX402SellerConfig({
      TASK_MARKET_MODE: 'testnet',
      TASK_MARKET_NETWORK: 'eip155:84532',
      TASK_MARKET_FACILITATOR_URL: 'https://x402.org/facilitator',
      TASK_MARKET_PAY_TO: testnet.payTo,
      TASK_MARKET_PRICE: '$0.01',
      TASK_MARKET_PUBLIC_BASE_URL: testnet.publicBaseUrl,
      DATABASE_URL: 'should-never-appear',
      PRIVATE_KEY: 'should-never-appear'
    });

    expect(parsed).toEqual(testnet);
    expect(JSON.stringify(parsed)).not.toContain('should-never-appear');
  });

  it('registers one recorder hook on the shared HTTP and MCP resource server', async () => {
    const fake = createFakeRuntimeDependencies();
    const recordSettlement = vi.fn();

    const runtime = await createX402Runtime(testnet, {
      acceptingWork: () => true,
      recordSettlement,
      now: () => new Date('2026-07-20T12:00:00.000Z'),
      dependencies: fake.dependencies
    });
    await fake.getSettlementHook()(settlementContext());

    expect(fake.resourceServer.onAfterSettle).toHaveBeenCalledOnce();
    expect(fake.dependencies.createHttpPaymentMiddleware.mock.calls[0]?.[0]).toMatchObject({
      'POST /v1/edge-validation': {
        resource: 'https://edge.example.test/v1/edge-validation'
      }
    });
    expect(fake.dependencies.createHttpPaymentMiddleware).toHaveBeenCalledWith(
      expect.any(Object),
      fake.resourceServer,
      undefined,
      undefined,
      false
    );
    expect(fake.dependencies.createMcpPaymentWrapper).toHaveBeenCalledWith(
      fake.resourceServer,
      expect.any(Object)
    );
    expect(runtime.paymentMiddleware).toBe(fake.middleware);
    expect(recordSettlement).toHaveBeenCalledWith({
      schemaVersion: 1,
      mode: 'testnet',
      productId: 'edge-validation-v1',
      network: 'base-sepolia',
      transactionHash,
      amountBaseUnits: '10000',
      payerAddress: testnet.payTo,
      settledAt: '2026-07-20T12:00:00.000Z'
    });
    expect(JSON.stringify(recordSettlement.mock.calls)).not.toContain('privatePayload');
  });

  it('records the exact requirement amount only when any reported amount agrees', async () => {
    const fake = createFakeRuntimeDependencies();
    const recordSettlement = vi.fn();
    await createX402Runtime(testnet, {
      acceptingWork: () => true,
      recordSettlement,
      dependencies: fake.dependencies
    });
    const hook = fake.getSettlementHook();

    await hook(settlementContext({ amount: undefined }, '10000'));
    await hook(settlementContext({ transaction: `0x${'b'.repeat(64)}`, amount: '9000' }, '10000'));
    await hook(settlementContext({ amount: '0' }, '10000'));
    await hook(settlementContext({ amount: '01' }, '10000'));
    await hook(settlementContext({ amount: undefined }, '010000'));

    expect(recordSettlement).toHaveBeenCalledOnce();
    expect(recordSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ amountBaseUnits: '10000' })
    );
  });

  it('never records failed, mismatched-network, or unidentified settlements', async () => {
    const fake = createFakeRuntimeDependencies();
    const recordSettlement = vi.fn();
    await createX402Runtime(testnet, {
      acceptingWork: () => true,
      recordSettlement,
      dependencies: fake.dependencies
    });
    const hook = fake.getSettlementHook();

    await hook(settlementContext({ success: false }));
    await hook(settlementContext({ network: 'eip155:8453' }));
    await hook(settlementContext({ network: 'eip155:999999' }));
    await hook(settlementContext({ transaction: '' }));
    await hook(settlementContext({}, '9999'));
    await hook(settlementContext({}, '10000', { scheme: 'upto' }));
    await hook(
      settlementContext({}, '10000', {
        asset: '0x0000000000000000000000000000000000000002'
      })
    );
    await hook(
      settlementContext({}, '10000', {
        payTo: '0x2222222222222222222222222222222222222222'
      })
    );

    expect(recordSettlement).not.toHaveBeenCalled();
  });

  it('deduplicates replayed testnet settlements without recognizing revenue', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-x402-runtime-'));
    temporaryRoots.push(temporaryRoot);
    const ledger = new SettlementLedger(join(temporaryRoot, 'settlements.sqlite'));
    const fake = createFakeRuntimeDependencies();
    const recordSettlement = vi.fn((settlement) => ledger.record(settlement));
    let clockTick = 0;
    await createX402Runtime(testnet, {
      acceptingWork: () => true,
      recordSettlement,
      now: () => new Date(Date.UTC(2026, 6, 20, 12, 0, clockTick++)),
      dependencies: fake.dependencies
    });

    const hook = fake.getSettlementHook();
    await hook(settlementContext());
    await hook(settlementContext());

    expect(recordSettlement).toHaveBeenCalledOnce();
    expect(ledger.summary()).toEqual({
      schemaVersion: 1,
      testnet: { successfulSettlementCount: 1, settledAmountBaseUnits: '10000' },
      mainnet: {
        successfulSettlementCount: 0,
        facilitatorReportedAmountBaseUnits: '0',
        recognizedRevenue: {
          basis: 'requires_independent_chain_reconciliation',
          amountBaseUnits: '0',
          fiatValue: { basis: 'unknown' }
        }
      },
      economics: {
        settlementCost: { basis: 'unknown' },
        netRevenue: { basis: 'unknown' }
      }
    });
    ledger.close();
  });

  it('maps approved Base mainnet settlements and contains recorder failures', async () => {
    const approvalBinding = {
      schemaVersion: 1 as const,
      approved: true as const,
      network: 'eip155:8453',
      facilitatorUrl: 'https://api.cdp.coinbase.com/platform/v2/x402',
      payTo: testnet.payTo,
      price: testnet.price,
      publicBaseUrl: testnet.publicBaseUrl
    };
    const mainnet = X402SellerConfigSchema.parse({
      ...testnet,
      mode: 'mainnet_enabled',
      network: 'eip155:8453',
      facilitatorUrl: 'https://api.cdp.coinbase.com/platform/v2/x402',
      approval: {
        ...approvalBinding,
        approvalDigest: computeMainnetApprovalDigest(approvalBinding)
      }
    });
    const fake = createFakeRuntimeDependencies();
    const onSettlementRecorderFailure = vi.fn();
    await createX402Runtime(mainnet, {
      acceptingWork: () => true,
      recordSettlement: () => {
        throw new Error('sensitive database payload');
      },
      onSettlementRecorderFailure,
      dependencies: fake.dependencies
    });

    await expect(
      fake.getSettlementHook()(
        settlementContext({ network: 'eip155:8453' }, '10000', { network: 'eip155:8453' })
      )
    ).resolves.toBeUndefined();
    expect(onSettlementRecorderFailure).toHaveBeenCalledOnce();
    expect(onSettlementRecorderFailure).toHaveBeenCalledWith();
  });
});
