import { timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import type { Express, RequestHandler } from 'express';

import { createTaskMarketSellerApp, type SellerMode, type SellerReadiness } from './seller-app';
import type { EdgeMcpPaymentWrapper } from './mcp-server';
import { SettlementLedger, type SuccessfulSettlementInput } from './settlement-ledger';
import {
  createX402Runtime,
  parseX402SellerConfig,
  type PostSettlementRecorder,
  type X402RuntimeOptions,
  type X402SellerConfig
} from './x402-runtime';

const DEFAULT_PORT = 4021;
export const DEFAULT_SETTLEMENT_LEDGER_PATH = resolve(
  process.cwd(),
  '.jarvis-task-market',
  'settlements.sqlite'
);
const SimulationTokenPattern = /^[a-f0-9]{64}$/;
const SettlementLedgerFilename = 'settlements.sqlite';
const SettlementLedgerDirectoryNames = new Set(['jarvis-task-market', '.jarvis-task-market']);

interface BaseServerConfig {
  schemaVersion: 1;
  mode: SellerMode;
  host: '127.0.0.1' | '::1' | '0.0.0.0' | '::';
  port: number;
  acceptingWork: boolean;
}

export interface SimulationSellerServerConfig extends BaseServerConfig {
  mode: 'simulation';
  host: '127.0.0.1' | '::1';
  simulationToken: string;
}

export interface PaidSellerServerConfig extends BaseServerConfig {
  mode: 'testnet' | 'mainnet_enabled';
  settlementLedgerPath: string;
  x402: X402SellerConfig;
}

export type TaskMarketSellerServerConfig = SimulationSellerServerConfig | PaidSellerServerConfig;

export interface SellerPaymentRuntime {
  paymentMiddleware: RequestHandler;
  mcpPaymentWrapper: EdgeMcpPaymentWrapper;
}

export interface SettlementLedgerPort {
  record(input: SuccessfulSettlementInput): unknown;
  close(): void;
}

type PaidRuntimeFactory = (
  config: X402SellerConfig,
  options: X402RuntimeOptions
) => Promise<SellerPaymentRuntime>;

export interface ConfiguredSellerAppOverrides {
  acceptingWork?: () => boolean;
  createPaidRuntime?: PaidRuntimeFactory;
  recordSettlement?: PostSettlementRecorder;
  onSettlementRecorderFailure?: () => void | Promise<void>;
}

export interface SellerServerOverrides {
  acceptingWork?: () => boolean;
  createPaidRuntime?: PaidRuntimeFactory;
  openSettlementLedger?: (filename: string) => Promise<SettlementLedgerPort>;
  onSettlementLedgerFailure?: () => void;
}

export interface TaskMarketSellerHandle {
  app: Express;
  server: Server;
  close(): Promise<void>;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  if (
    !/^(?:[1-9]|[1-9][0-9]{1,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/.test(
      value
    )
  ) {
    throw new Error('TASK_MARKET_PORT must be an integer from 1 through 65535');
  }
  return Number(value);
}

function parseAcceptingWork(value: string | undefined, mode: SellerMode): boolean {
  if (mode !== 'simulation') {
    if (value === undefined || value === 'false') return false;
    if (value === 'true') {
      throw new Error(
        'Paid task-market activation is blocked until the Task 29 MCP and Origin review passes'
      );
    }
    throw new Error('TASK_MARKET_ACCEPTING_WORK must be true or false');
  }
  if (value === undefined) return true;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('TASK_MARKET_ACCEPTING_WORK must be true or false');
}

function parseSettlementLedgerPath(value: string | undefined): string {
  const path = value ?? DEFAULT_SETTLEMENT_LEDGER_PATH;
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    basename(path) !== SettlementLedgerFilename ||
    !SettlementLedgerDirectoryNames.has(basename(dirname(path)))
  ) {
    throw new Error('Settlement ledger path must name a dedicated absolute ledger location');
  }
  return path;
}

function parseHost(value: string | undefined, mode: SellerMode): BaseServerConfig['host'] {
  const host = value ?? (mode === 'simulation' ? '127.0.0.1' : '0.0.0.0');
  if (!['127.0.0.1', '::1', '0.0.0.0', '::'].includes(host)) {
    throw new Error('TASK_MARKET_HOST is not allowlisted');
  }
  if (mode === 'simulation' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error('Simulation seller must bind to loopback');
  }
  return host as BaseServerConfig['host'];
}

export function parseTaskMarketSellerServerConfig(
  environment: NodeJS.ProcessEnv
): TaskMarketSellerServerConfig {
  const mode = environment.TASK_MARKET_MODE;
  if (mode !== 'simulation' && mode !== 'testnet' && mode !== 'mainnet_enabled') {
    throw new Error('TASK_MARKET_MODE must be simulation, testnet, or mainnet_enabled');
  }
  const common = {
    schemaVersion: 1 as const,
    mode,
    host: parseHost(environment.TASK_MARKET_HOST, mode),
    port: parsePort(environment.TASK_MARKET_PORT),
    acceptingWork: parseAcceptingWork(environment.TASK_MARKET_ACCEPTING_WORK, mode)
  };

  if (mode === 'simulation') {
    const simulationToken = environment.TASK_MARKET_SIMULATION_TOKEN;
    if (simulationToken === undefined || !SimulationTokenPattern.test(simulationToken)) {
      throw new Error('TASK_MARKET_SIMULATION_TOKEN must be 64 lowercase hexadecimal characters');
    }
    return {
      ...common,
      mode,
      host: common.host as '127.0.0.1' | '::1',
      simulationToken
    };
  }

  return {
    ...common,
    mode,
    settlementLedgerPath: parseSettlementLedgerPath(environment.TASK_MARKET_SETTLEMENT_LEDGER_PATH),
    x402: parseX402SellerConfig(environment)
  };
}

function safeTokenMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string' || !SimulationTokenPattern.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

function mcpMeta(context: unknown): Record<string, unknown> | undefined {
  if (context === null || typeof context !== 'object') return undefined;
  const meta = (context as { _meta?: unknown })._meta;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  return meta as Record<string, unknown>;
}

function deniedMcpResult(message: 'Payment required' | 'Service unavailable') {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: {
            code: message === 'Payment required' ? 402 : 503,
            message
          }
        })
      }
    ],
    isError: true
  };
}

export function createSimulationPaymentRuntime(
  simulationToken: string,
  acceptingWork: () => boolean
): SellerPaymentRuntime {
  if (!SimulationTokenPattern.test(simulationToken)) {
    throw new Error('Invalid simulation payment token');
  }
  const simulationPaymentMiddleware: RequestHandler = (request, response, next) => {
    if (!acceptingWork()) {
      response.status(503).json({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Service is not accepting paid work' }
      });
      return;
    }
    if (!safeTokenMatches(simulationToken, request.header('x-jarvis-simulation-payment'))) {
      response.status(402).json({
        error: { code: 'PAYMENT_REQUIRED', message: 'Simulation payment proof required' }
      });
      return;
    }
    next();
  };
  const mcpPaymentWrapper: EdgeMcpPaymentWrapper = (handler) => async (args, context) => {
    if (!acceptingWork()) return deniedMcpResult('Service unavailable');
    if (!safeTokenMatches(simulationToken, mcpMeta(context)?.['jarvis/simulation-payment'])) {
      return deniedMcpResult('Payment required');
    }
    return handler(args, context);
  };
  return { paymentMiddleware: simulationPaymentMiddleware, mcpPaymentWrapper };
}

export async function createConfiguredSellerApp(
  config: TaskMarketSellerServerConfig,
  overrides: ConfiguredSellerAppOverrides = {}
): Promise<Express> {
  const acceptingWork = () =>
    config.acceptingWork && (overrides.acceptingWork === undefined || overrides.acceptingWork());
  let runtime: SellerPaymentRuntime;
  if (config.mode === 'simulation') {
    runtime = createSimulationPaymentRuntime(config.simulationToken, acceptingWork);
  } else {
    if (overrides.recordSettlement === undefined) {
      throw new Error('Paid seller requires a settlement recorder');
    }
    const createPaidRuntime = overrides.createPaidRuntime ?? createX402Runtime;
    runtime = await createPaidRuntime(config.x402, {
      acceptingWork,
      recordSettlement: overrides.recordSettlement,
      onSettlementRecorderFailure: overrides.onSettlementRecorderFailure
    });
  }
  const readiness = (): SellerReadiness =>
    acceptingWork() ? { ready: true, reason: 'ready' } : { ready: false, reason: 'kill_switch' };

  return createTaskMarketSellerApp({
    mode: config.mode,
    readiness,
    paymentMiddleware: runtime.paymentMiddleware,
    mcpPaymentWrapper: runtime.mcpPaymentWrapper
  });
}

function isMissingPath(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

async function openDedicatedSettlementLedger(filename: string): Promise<SettlementLedgerPort> {
  const parent = dirname(filename);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStatus = await lstat(parent);
  if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink()) {
    throw new Error('Settlement ledger parent must be a dedicated directory');
  }
  await chmod(parent, 0o700);

  try {
    const databaseStatus = await lstat(filename);
    if (!databaseStatus.isFile() || databaseStatus.isSymbolicLink()) {
      throw new Error('Settlement ledger must be a regular file');
    }
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }

  const ledger = new SettlementLedger(filename);
  try {
    await chmod(filename, 0o600);
    return ledger;
  } catch (error) {
    ledger.close();
    throw error;
  }
}

function defaultLedgerFailureReporter(): void {
  process.stderr.write(
    `${JSON.stringify({ event: 'task_market_settlement_ledger_failed', message: 'Settlement recording is unavailable' })}\n`
  );
}

export async function startTaskMarketSeller(
  config: TaskMarketSellerServerConfig,
  overrides: SellerServerOverrides = {}
): Promise<TaskMarketSellerHandle> {
  let ledger: SettlementLedgerPort | undefined;
  let ledgerClosed = false;
  let ledgerHealthy = true;
  const reportLedgerFailure = () => {
    ledgerHealthy = false;
    try {
      (overrides.onSettlementLedgerFailure ?? defaultLedgerFailureReporter)();
    } catch {
      // Diagnostics must not expose or alter settlement responses.
    }
  };
  const closeLedger = () => {
    if (ledger === undefined || ledgerClosed) return;
    ledgerClosed = true;
    try {
      ledger.close();
    } catch {
      reportLedgerFailure();
    }
  };

  try {
    if (config.mode !== 'simulation') {
      const openLedger = overrides.openSettlementLedger ?? openDedicatedSettlementLedger;
      ledger = await openLedger(config.settlementLedgerPath);
    }
    const app = await createConfiguredSellerApp(config, {
      acceptingWork: () =>
        ledgerHealthy && (overrides.acceptingWork === undefined || overrides.acceptingWork()),
      createPaidRuntime: overrides.createPaidRuntime,
      recordSettlement:
        ledger === undefined
          ? undefined
          : (settlement) => {
              ledger?.record(settlement);
            },
      onSettlementRecorderFailure: reportLedgerFailure
    });
    const server = await new Promise<Server>((resolveServer, reject) => {
      const listening = app.listen(config.port, config.host, () => resolveServer(listening));
      listening.once('error', reject);
    });
    server.once('close', closeLedger);

    const close = async (): Promise<void> => {
      if (!server.listening) {
        closeLedger();
        return;
      }
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error === undefined ? resolveClose() : reject(error)));
      });
      closeLedger();
    };
    return { app, server, close };
  } catch (error) {
    closeLedger();
    throw error;
  }
}

async function main(): Promise<void> {
  try {
    const config = parseTaskMarketSellerServerConfig(process.env);
    const running = await startTaskMarketSeller(config);
    const shutdown = () => {
      void running.close().catch(() => {
        process.stderr.write(
          `${JSON.stringify({ event: 'task_market_seller_stop_failed', message: 'Shutdown failed' })}\n`
        );
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.stdout.write(
      `${JSON.stringify({ event: 'task_market_seller_started', mode: config.mode, host: config.host, port: config.port })}\n`
    );
  } catch {
    process.stderr.write(
      `${JSON.stringify({ event: 'task_market_seller_start_failed', message: 'Configuration or startup failed' })}\n`
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
