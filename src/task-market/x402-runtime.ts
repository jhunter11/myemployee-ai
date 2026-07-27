import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import type { RequestHandler } from 'express';
import { z } from 'zod';

import type { EdgeMcpPaymentWrapper } from './mcp-server';
import type { EdgeValidationInput } from './edge-validation';
import type { SuccessfulSettlementInput } from './settlement-ledger';

interface SettlementResultContext {
  result: {
    success: unknown;
    transaction: unknown;
    network: unknown;
    amount?: unknown;
    payer?: unknown;
  };
  requirements: {
    [key: string]: unknown;
    scheme: unknown;
    network: unknown;
    asset: unknown;
    amount: unknown;
    payTo: unknown;
  };
}

interface ExactRequirementFingerprint {
  scheme: 'exact';
  network: string;
  asset: string;
  amount: string;
  payTo: string;
}

interface ResourceServer {
  register(network: string, scheme: unknown): ResourceServer;
  onAfterSettle(hook: (context: SettlementResultContext) => Promise<void>): ResourceServer;
  initialize(): Promise<void>;
  buildPaymentRequirements(options: {
    scheme: 'exact';
    network: string;
    payTo: string;
    price: string;
  }): Promise<Array<Record<string, unknown>>>;
}

interface EdgeToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

type PaidToolFactory = (
  handler: (args: EdgeValidationInput, context: unknown) => Promise<EdgeToolResult>
) => (args: EdgeValidationInput, context: unknown) => Promise<EdgeToolResult>;

const requirePackage = createRequire(__filename);
const { HTTPFacilitatorClient, x402ResourceServer } = requirePackage('@x402/core/server') as {
  HTTPFacilitatorClient: new (config: { url: string }) => unknown;
  x402ResourceServer: new (facilitator: unknown) => ResourceServer;
};
const { ExactEvmScheme } = requirePackage('@x402/evm/exact/server') as {
  ExactEvmScheme: new () => unknown;
};
const { paymentMiddleware } = requirePackage('@x402/express') as {
  paymentMiddleware: (
    routes: Record<string, unknown>,
    server: ResourceServer,
    paywallConfig?: unknown,
    paywall?: unknown,
    syncFacilitatorOnStart?: boolean
  ) => RequestHandler;
};
const { declareDiscoveryExtension } = requirePackage('@x402/extensions/bazaar') as {
  declareDiscoveryExtension: (config: Record<string, unknown>) => Record<string, unknown>;
};
const { createPaymentWrapper } = requirePackage('@x402/mcp') as {
  createPaymentWrapper: (
    server: ResourceServer,
    config: Record<string, unknown>
  ) => PaidToolFactory;
};

const TESTNET_NETWORK = 'eip155:84532';
const MAINNET_NETWORK = 'eip155:8453';
const TESTNET_FACILITATOR = 'https://x402.org/facilitator';
const MAINNET_FACILITATOR = 'https://api.cdp.coinbase.com/platform/v2/x402';

const EvmAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const PriceSchema = z
  .string()
  .regex(/^\$(?:0\.\d*[1-9]\d*|[1-9]\d*(?:\.\d{1,6})?)$/)
  .refine((value) => Number(value.slice(1)) <= 100, 'Price exceeds the service ceiling');
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_RECORDED_SETTLEMENT_IDENTITIES = 10_000;

function secureUrl(options: { originOnly: boolean }): z.ZodType<string> {
  return z
    .string()
    .url()
    .max(512)
    .superRefine((value, context) => {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:') {
        context.addIssue({ code: 'custom', message: 'URL must use HTTPS' });
      }
      if (parsed.username !== '' || parsed.password !== '') {
        context.addIssue({ code: 'custom', message: 'URL credentials are forbidden' });
      }
      if (parsed.search !== '' || parsed.hash !== '') {
        context.addIssue({ code: 'custom', message: 'URL query and fragment are forbidden' });
      }
      if (options.originOnly && parsed.pathname !== '/') {
        context.addIssue({ code: 'custom', message: 'Public base URL must be an origin' });
      }
    });
}

const PublicBaseUrlSchema = secureUrl({ originOnly: true });
const FacilitatorUrlSchema = secureUrl({ originOnly: false });

export interface MainnetApprovalDigestInput {
  schemaVersion: 1;
  approved: true;
  network: string;
  facilitatorUrl: string;
  payTo: string;
  price: string;
  publicBaseUrl: string;
}

export function computeMainnetApprovalDigest(input: MainnetApprovalDigestInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        domain: 'jarvis.x402.mainnet-approval.v1',
        schemaVersion: input.schemaVersion,
        approved: input.approved,
        network: input.network,
        facilitatorUrl: input.facilitatorUrl,
        payTo: input.payTo,
        price: input.price,
        publicBaseUrl: input.publicBaseUrl
      }),
      'utf8'
    )
    .digest('hex');
}

const TestnetSellerConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.literal('testnet'),
  network: z.literal(TESTNET_NETWORK),
  facilitatorUrl: z.literal(TESTNET_FACILITATOR),
  payTo: EvmAddressSchema,
  price: PriceSchema,
  publicBaseUrl: PublicBaseUrlSchema
});

const MainnetApprovalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  approved: z.literal(true),
  network: z.literal(MAINNET_NETWORK),
  facilitatorUrl: z.literal(MAINNET_FACILITATOR),
  payTo: EvmAddressSchema,
  price: PriceSchema,
  publicBaseUrl: PublicBaseUrlSchema,
  approvalDigest: Sha256Schema
});

const MainnetSellerConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    mode: z.literal('mainnet_enabled'),
    network: z.enum([TESTNET_NETWORK, MAINNET_NETWORK]),
    facilitatorUrl: FacilitatorUrlSchema,
    payTo: EvmAddressSchema,
    price: PriceSchema,
    publicBaseUrl: PublicBaseUrlSchema,
    approval: MainnetApprovalSchema
  })
  .superRefine((config, context) => {
    if (config.network !== MAINNET_NETWORK) {
      context.addIssue({
        code: 'custom',
        path: ['approval', 'network'],
        message: 'Mainnet approval requires the Base mainnet network'
      });
    }
    if (config.facilitatorUrl !== MAINNET_FACILITATOR) {
      context.addIssue({
        code: 'custom',
        path: ['approval', 'facilitatorUrl'],
        message: 'Mainnet approval requires the reviewed production facilitator'
      });
    }
    for (const field of ['network', 'facilitatorUrl', 'payTo', 'price', 'publicBaseUrl'] as const) {
      if (config[field] !== config.approval[field]) {
        context.addIssue({
          code: 'custom',
          path: ['approval', field],
          message: `Mainnet approval does not match ${field}`
        });
      }
    }
    const { approvalDigest, ...approvalBinding } = config.approval;
    if (approvalDigest !== computeMainnetApprovalDigest(approvalBinding)) {
      context.addIssue({
        code: 'custom',
        path: ['approval', 'approvalDigest'],
        message: 'Mainnet approval digest does not match the reviewed configuration'
      });
    }
  });

export const X402SellerConfigSchema = z.discriminatedUnion('mode', [
  TestnetSellerConfigSchema,
  MainnetSellerConfigSchema
]);

export type X402SellerConfig = z.infer<typeof X402SellerConfigSchema>;

export const EDGE_VALIDATION_INPUT_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    observations: {
      type: 'array',
      minItems: 5,
      maxItems: 10_000,
      items: { type: 'number', minimum: -1_000_000_000, maximum: 1_000_000_000 }
    },
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        minObservations: { type: 'integer', minimum: 5, maximum: 10_000 },
        minimumMean: { type: 'number' },
        confidenceZ: { type: 'number', minimum: 0, maximum: 6 }
      },
      required: ['minObservations', 'minimumMean', 'confidenceZ']
    }
  },
  required: ['schemaVersion', 'observations', 'parameters']
});

export function createBazaarDiscovery(): Record<string, unknown> {
  return declareDiscoveryExtension({
    toolName: 'edge_validation_v1',
    description:
      'Deterministically evaluate a bounded numeric series against an evidence threshold.',
    transport: 'streamable-http',
    inputSchema: EDGE_VALIDATION_INPUT_JSON_SCHEMA,
    example: {
      schemaVersion: 1,
      observations: [10, 10, 10, 10, 10],
      parameters: { minObservations: 5, minimumMean: 10, confidenceZ: 1.96 }
    },
    output: {
      example: {
        schemaVersion: 1,
        verdict: 'PASS',
        algorithm: { id: 'edge-validation', version: '1.0.0' }
      }
    }
  });
}

function createHttpDiscovery(): Record<string, unknown> {
  return declareDiscoveryExtension({
    bodyType: 'json',
    input: {
      schemaVersion: 1,
      observations: [10, 10, 10, 10, 10],
      parameters: { minObservations: 5, minimumMean: 10, confidenceZ: 1.96 }
    },
    inputSchema: EDGE_VALIDATION_INPUT_JSON_SCHEMA,
    output: {
      example: {
        schemaVersion: 1,
        verdict: 'PASS',
        algorithm: { id: 'edge-validation', version: '1.0.0' }
      }
    }
  });
}

export function parseX402SellerConfig(environment: NodeJS.ProcessEnv): X402SellerConfig {
  const base = {
    schemaVersion: 1 as const,
    mode: environment.TASK_MARKET_MODE,
    network: environment.TASK_MARKET_NETWORK,
    facilitatorUrl: environment.TASK_MARKET_FACILITATOR_URL,
    payTo: environment.TASK_MARKET_PAY_TO,
    price: environment.TASK_MARKET_PRICE,
    publicBaseUrl: environment.TASK_MARKET_PUBLIC_BASE_URL
  };

  if (environment.TASK_MARKET_MODE !== 'mainnet_enabled') {
    return X402SellerConfigSchema.parse(base);
  }

  return X402SellerConfigSchema.parse({
    ...base,
    approval: {
      schemaVersion: 1,
      approved: environment.TASK_MARKET_APPROVED === 'true',
      network: environment.TASK_MARKET_APPROVED_NETWORK,
      facilitatorUrl: environment.TASK_MARKET_APPROVED_FACILITATOR_URL,
      payTo: environment.TASK_MARKET_APPROVED_PAY_TO,
      price: environment.TASK_MARKET_APPROVED_PRICE,
      publicBaseUrl: environment.TASK_MARKET_APPROVED_PUBLIC_BASE_URL,
      approvalDigest: environment.TASK_MARKET_APPROVAL_DIGEST
    }
  });
}

export interface X402Runtime {
  paymentMiddleware: RequestHandler;
  mcpPaymentWrapper: EdgeMcpPaymentWrapper;
}

export type PostSettlementRecorder = (settlement: SuccessfulSettlementInput) => unknown;

export interface X402RuntimeDependencies {
  createResourceServer(config: X402SellerConfig): ResourceServer;
  createHttpPaymentMiddleware(
    routes: Record<string, unknown>,
    server: ResourceServer,
    paywallConfig?: unknown,
    paywall?: unknown,
    syncFacilitatorOnStart?: boolean
  ): RequestHandler;
  createMcpPaymentWrapper(server: ResourceServer, config: Record<string, unknown>): PaidToolFactory;
}

export interface X402RuntimeOptions {
  acceptingWork: () => boolean;
  recordSettlement?: PostSettlementRecorder;
  onSettlementRecorderFailure?: () => void | Promise<void>;
  now?: () => Date;
  dependencies?: Partial<X402RuntimeDependencies>;
}

const StrictPositiveDecimalPattern = /^[1-9][0-9]*$/;
const TransactionHashPattern = /^0x[a-fA-F0-9]{64}$/;
const PayerAddressPattern = /^0x[a-fA-F0-9]{40}$/;

const officialRuntimeDependencies: X402RuntimeDependencies = {
  createResourceServer: (config) => {
    if (config.mode === 'mainnet_enabled') {
      throw new Error(
        'Mainnet seller requires a reviewed authenticated facilitator adapter outside the public seller zone'
      );
    }
    const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
    return new x402ResourceServer(facilitator).register(config.network, new ExactEvmScheme());
  },
  createHttpPaymentMiddleware: paymentMiddleware,
  createMcpPaymentWrapper: createPaymentWrapper
};

function ledgerNetwork(network: unknown): SuccessfulSettlementInput['network'] | undefined {
  if (network === TESTNET_NETWORK) return 'base-sepolia';
  if (network === MAINNET_NETWORK) return 'base';
  return undefined;
}

function sameEvmAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function exactRequirementFingerprint(
  requirement: Record<string, unknown>,
  config: X402SellerConfig
): ExactRequirementFingerprint | undefined {
  const { scheme, network, asset, amount, payTo } = requirement;
  if (
    scheme !== 'exact' ||
    typeof network !== 'string' ||
    network !== config.network ||
    typeof asset !== 'string' ||
    !EvmAddressSchema.safeParse(asset).success ||
    typeof amount !== 'string' ||
    !StrictPositiveDecimalPattern.test(amount) ||
    typeof payTo !== 'string' ||
    !EvmAddressSchema.safeParse(payTo).success ||
    !sameEvmAddress(payTo, config.payTo)
  ) {
    return undefined;
  }
  return { scheme, network, asset, amount, payTo };
}

function requirementsMatch(
  selected: ExactRequirementFingerprint,
  expected: ExactRequirementFingerprint
): boolean {
  return (
    selected.scheme === expected.scheme &&
    selected.network === expected.network &&
    sameEvmAddress(selected.asset, expected.asset) &&
    selected.amount === expected.amount &&
    sameEvmAddress(selected.payTo, expected.payTo)
  );
}

function successfulSettlement(
  config: X402SellerConfig,
  context: SettlementResultContext,
  now: () => Date,
  recognizedRequirements: readonly ExactRequirementFingerprint[]
): SuccessfulSettlementInput | undefined {
  if (context.result.success !== true || context.result.network !== config.network)
    return undefined;
  const selectedRequirement = exactRequirementFingerprint(context.requirements, config);
  if (
    selectedRequirement === undefined ||
    !recognizedRequirements.some((expected) => requirementsMatch(selectedRequirement, expected))
  ) {
    return undefined;
  }
  const network = ledgerNetwork(context.result.network);
  const transactionHash = context.result.transaction;
  if (
    network === undefined ||
    typeof transactionHash !== 'string' ||
    !TransactionHashPattern.test(transactionHash) ||
    (context.result.amount !== undefined && context.result.amount !== selectedRequirement.amount)
  ) {
    return undefined;
  }
  const payerAddress =
    typeof context.result.payer === 'string' && PayerAddressPattern.test(context.result.payer)
      ? context.result.payer
      : undefined;

  return {
    schemaVersion: 1,
    mode: config.mode,
    productId: 'edge-validation-v1',
    network,
    transactionHash,
    amountBaseUnits: selectedRequirement.amount,
    ...(payerAddress === undefined ? {} : { payerAddress }),
    settledAt: now().toISOString()
  };
}

function settlementIdentity(settlement: SuccessfulSettlementInput): string {
  return `${settlement.network}:${settlement.transactionHash.toLowerCase()}`;
}

function settlementFingerprint(settlement: SuccessfulSettlementInput): string {
  return JSON.stringify({
    amountBaseUnits: settlement.amountBaseUnits,
    payerAddress: settlement.payerAddress?.toLowerCase() ?? null
  });
}

async function reportRecorderFailure(
  callback: X402RuntimeOptions['onSettlementRecorderFailure']
): Promise<void> {
  try {
    await callback?.();
  } catch {
    // Recorder diagnostics are deliberately isolated from settlement responses.
  }
}

export async function createX402Runtime(
  rawConfig: X402SellerConfig,
  options: X402RuntimeOptions
): Promise<X402Runtime> {
  const config = X402SellerConfigSchema.parse(rawConfig);
  const dependencies = { ...officialRuntimeDependencies, ...options.dependencies };
  const resourceServer = dependencies.createResourceServer(config);
  let recognizedRequirements: ExactRequirementFingerprint[] = [];
  if (options.recordSettlement !== undefined) {
    const recordedSettlements = new Map<string, string>();
    const recordingQueues = new Map<string, Promise<void>>();
    resourceServer.onAfterSettle(async (context) => {
      try {
        const settlement = successfulSettlement(
          config,
          context,
          options.now ?? (() => new Date()),
          recognizedRequirements
        );
        if (settlement === undefined) return;
        const identity = settlementIdentity(settlement);
        const fingerprint = settlementFingerprint(settlement);
        const preceding = recordingQueues.get(identity) ?? Promise.resolve();
        const recording = preceding
          .catch(() => undefined)
          .then(async () => {
            if (recordedSettlements.get(identity) === fingerprint) return;
            await options.recordSettlement?.(settlement);
            if (recordedSettlements.size >= MAX_RECORDED_SETTLEMENT_IDENTITIES) {
              const oldestIdentity = recordedSettlements.keys().next().value;
              if (oldestIdentity !== undefined) recordedSettlements.delete(oldestIdentity);
            }
            recordedSettlements.set(identity, fingerprint);
          });
        recordingQueues.set(identity, recording);
        try {
          await recording;
        } finally {
          if (recordingQueues.get(identity) === recording) recordingQueues.delete(identity);
        }
      } catch {
        await reportRecorderFailure(options.onSettlementRecorderFailure);
      }
    });
  }
  await resourceServer.initialize();

  const accepts = await resourceServer.buildPaymentRequirements({
    scheme: 'exact',
    network: config.network,
    payTo: config.payTo,
    price: config.price
  });
  recognizedRequirements = accepts.flatMap((requirement) => {
    const fingerprint = exactRequirementFingerprint(requirement, config);
    return fingerprint === undefined ? [] : [fingerprint];
  });
  if (recognizedRequirements.length === 0 || recognizedRequirements.length !== accepts.length) {
    throw new Error('Facilitator returned no recognized exact payment requirement');
  }
  const paid = dependencies.createMcpPaymentWrapper(resourceServer, {
    accepts,
    resource: {
      url: 'mcp://tool/edge_validation_v1',
      description:
        'Deterministically evaluate a bounded numeric series against an evidence threshold.',
      mimeType: 'application/json',
      serviceName: 'Jarvis Edge Validation',
      tags: ['statistics', 'validation', 'deterministic']
    },
    extensions: createBazaarDiscovery(),
    hooks: {
      onBeforeExecution: () => options.acceptingWork()
    }
  });

  const mcpPaymentWrapper: EdgeMcpPaymentWrapper = (handler) =>
    paid(async (args, context) => handler(args, context));

  return {
    paymentMiddleware: dependencies.createHttpPaymentMiddleware(
      {
        'POST /v1/edge-validation': {
          resource: new URL('/v1/edge-validation', config.publicBaseUrl).toString(),
          accepts: [
            {
              scheme: 'exact',
              price: config.price,
              network: config.network,
              payTo: config.payTo
            }
          ],
          description:
            'Deterministically evaluate a bounded numeric series against an evidence threshold.',
          mimeType: 'application/json',
          extensions: createHttpDiscovery()
        }
      },
      resourceServer,
      undefined,
      undefined,
      false
    ),
    mcpPaymentWrapper
  };
}
