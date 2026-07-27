import type SQLite from 'better-sqlite3';
import { z } from 'zod';

import { ActionProposalService } from '../../commands/action-proposal-service';
import { SqliteActionProposalRepository } from '../../commands/action-proposal-repository';
import {
  InMemoryCommandReceiptRepository,
  SharedCommandService
} from '../../commands/command-service';
import { MacOSKeychainSecretReader } from '../../secrets/macos-keychain';
import { TelegramBotApiClient } from './bot-api-client';
import { SqliteTelegramInboxRepository } from './inbox-repository';
import { TelegramLongPoller } from './long-poller';
import { TelegramUpdateProcessor } from './update-processor';

const TelegramChannelOptionsSchema = z.strictObject({
  allowlist: z.strictObject({
    userId: z.number().int().positive(),
    chatId: z.number().int().positive()
  }),
  keychain: z.strictObject({
    service: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/),
    account: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/)
  })
});

export type TelegramServerOptions = z.infer<typeof TelegramChannelOptionsSchema>;

function privateTelegramId(value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]{0,15}$/u.test(value)) {
    throw new Error('Telegram ID must be a positive decimal integer');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('Telegram ID is outside the safe range');
  return parsed;
}

interface Poller {
  pollOnce(): Promise<{ received: number; processed: number }>;
}

interface TelegramApi {
  getUpdates(input: {
    offset: number;
    limit: 50;
    timeout: 30;
    allowedUpdates: ['message'];
  }): Promise<unknown[]>;
  send(chatId: number, text: string): Promise<void>;
}

interface TelegramIntervalHandle {
  unref(): void;
}

export interface TelegramPollingRuntimeOptions {
  poller: Poller;
  intervalMs?: number;
  setIntervalFn?: (callback: () => void, delay: number) => TelegramIntervalHandle;
  clearIntervalFn?: (handle: TelegramIntervalHandle) => void;
  onCycle?: (result: { received: number; processed: number }) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
}

function defaultSetInterval(callback: () => void, delay: number): TelegramIntervalHandle {
  return setInterval(callback, delay);
}

function defaultClearInterval(handle: TelegramIntervalHandle): void {
  clearInterval(handle as NodeJS.Timeout);
}

/**
 * Runs one bounded long poll at a time. Provider exceptions are deliberately
 * replaced with a stable error before they reach logs or observability hooks.
 */
export class TelegramPollingRuntime {
  private readonly intervalMs: number;
  private readonly setIntervalFn: (callback: () => void, delay: number) => TelegramIntervalHandle;
  private readonly clearIntervalFn: (handle: TelegramIntervalHandle) => void;
  private intervalHandle: TelegramIntervalHandle | undefined;
  private activeWork: Promise<void> | undefined;
  private started = false;
  private stopped = false;

  constructor(private readonly options: TelegramPollingRuntimeOptions) {
    this.intervalMs = options.intervalMs ?? 1_000;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new RangeError('intervalMs must be a finite positive number');
    }
    this.setIntervalFn = options.setIntervalFn ?? defaultSetInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? defaultClearInterval;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.intervalHandle = this.setIntervalFn(() => this.startCycle(), this.intervalMs);
    this.intervalHandle.unref();
    this.startCycle();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.intervalHandle !== undefined) {
      this.clearIntervalFn(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  async settled(): Promise<void> {
    while (this.activeWork !== undefined) {
      await this.activeWork;
    }
  }

  private startCycle(): void {
    if (this.stopped || this.activeWork !== undefined) return;
    const work = this.runCycle();
    this.activeWork = work;
    void work.then(() => {
      if (this.activeWork === work) this.activeWork = undefined;
    });
  }

  private async runCycle(): Promise<void> {
    try {
      const result = await this.options.poller.pollOnce();
      if (!this.stopped) await this.options.onCycle?.(result);
    } catch {
      try {
        await this.options.onError?.(new Error('Telegram polling cycle failed'));
      } catch {
        // Observability callbacks must not produce an unhandled background rejection.
      }
    }
  }
}

export interface TelegramChannelRuntime extends TelegramPollingRuntime {
  pollOnce(): Promise<{ received: number; processed: number }>;
}

interface TelegramSecretReader {
  read(input: { service: string; account: string }): Promise<string>;
}

interface TelegramResponder {
  respond(input: { message: string }): Promise<unknown>;
}

export interface CreateTelegramChannelRuntimeOptions {
  sqlite: SQLite.Database;
  allowlist: TelegramServerOptions['allowlist'];
  keychain: TelegramServerOptions['keychain'];
  responder: TelegramResponder;
  secrets?: TelegramSecretReader;
  apiFactory?: (token: string) => TelegramApi;
  now?: () => string;
  intervalMs?: number;
  onCycle?: TelegramPollingRuntimeOptions['onCycle'];
  onError?: TelegramPollingRuntimeOptions['onError'];
}

export async function createTelegramChannelRuntime(
  options: CreateTelegramChannelRuntimeOptions
): Promise<TelegramChannelRuntime> {
  const configuration = TelegramChannelOptionsSchema.parse({
    allowlist: options.allowlist,
    keychain: options.keychain
  });
  const secrets = options.secrets ?? new MacOSKeychainSecretReader();
  const token = await secrets.read(configuration.keychain);
  const api = (options.apiFactory ?? ((value) => new TelegramBotApiClient({ token: value })))(
    token
  );
  const inbox = new SqliteTelegramInboxRepository(options.sqlite, {
    ...(options.now === undefined ? {} : { now: options.now })
  });
  const commands = new SharedCommandService({
    responder: options.responder,
    receipts: new InMemoryCommandReceiptRepository(),
    ...(options.now === undefined ? {} : { now: options.now })
  });
  const proposals = new ActionProposalService({
    repository: new SqliteActionProposalRepository(options.sqlite),
    ...(options.now === undefined ? {} : { now: options.now })
  });
  const processor = new TelegramUpdateProcessor({
    allowlist: configuration.allowlist,
    principal: {
      version: 1,
      id: 'principal:telegram_operator',
      kind: 'operator',
      channel: 'telegram',
      authority: ['read', 'propose']
    },
    binding: {
      scopeId: 'personal:jarvis',
      trustDomain: 'personal',
      tenantId: null,
      policyVersion: 1
    },
    inbox,
    commands,
    proposals,
    delivery: api
  });
  const poller = new TelegramLongPoller({ inbox, processor, api });
  const scheduler = new TelegramPollingRuntime({
    poller,
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    ...(options.onCycle === undefined ? {} : { onCycle: options.onCycle }),
    ...(options.onError === undefined ? {} : { onError: options.onError })
  });
  return Object.assign(scheduler, { pollOnce: () => poller.pollOnce() });
}

/**
 * Environment values can enable and identify one private chat, but cannot
 * supply a bot token, select a scope, or grant authority. The token remains in
 * macOS Keychain and principal/scope binding is compiled into the adapter.
 */
export function telegramServerOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv
): TelegramServerOptions | false {
  if (environment.JARVIS_TELEGRAM_ENABLED !== '1') return false;
  try {
    return TelegramChannelOptionsSchema.parse({
      allowlist: {
        userId: privateTelegramId(environment.JARVIS_TELEGRAM_USER_ID),
        chatId: privateTelegramId(environment.JARVIS_TELEGRAM_CHAT_ID)
      },
      keychain: {
        service: environment.JARVIS_TELEGRAM_KEYCHAIN_SERVICE ?? 'com.aiagency.jarvis.telegram',
        account: environment.JARVIS_TELEGRAM_KEYCHAIN_ACCOUNT ?? 'bot-token'
      }
    });
  } catch {
    throw new Error('Telegram channel configuration is invalid');
  }
}
