import SQLite from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTelegramChannelRuntime,
  TelegramPollingRuntime,
  telegramServerOptionsFromEnvironment
} from '../../src/channels/telegram/runtime';

const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';

function update(updateId: number, text = '/today') {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_784_657_600,
      from: { id: 42, is_bot: false },
      chat: { id: 84, type: 'private' },
      text
    }
  };
}

describe('Telegram polling runtime', () => {
  it('starts immediately, prevents overlapping polls, and drains the active poll on stop', async () => {
    let finish: (() => void) | undefined;
    const pollOnce = vi.fn(
      () =>
        new Promise<{ received: number; processed: number }>((resolve) => {
          finish = () => resolve({ received: 1, processed: 1 });
        })
    );
    let tick: (() => void) | undefined;
    const clearIntervalFn = vi.fn();
    const runtime = new TelegramPollingRuntime({
      poller: { pollOnce },
      intervalMs: 1_000,
      setIntervalFn: (callback) => {
        tick = callback;
        return { unref: vi.fn() };
      },
      clearIntervalFn
    });

    runtime.start();
    tick?.();
    expect(pollOnce).toHaveBeenCalledTimes(1);

    runtime.stop();
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    finish?.();
    await runtime.settled();
  });

  it('sanitizes polling failures and remains retryable', async () => {
    const onError = vi.fn();
    const pollOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error(`provider leaked ${token}`))
      .mockResolvedValueOnce({ received: 0, processed: 0 });
    let tick: (() => void) | undefined;
    const runtime = new TelegramPollingRuntime({
      poller: { pollOnce },
      intervalMs: 1_000,
      setIntervalFn: (callback) => {
        tick = callback;
        return { unref: vi.fn() };
      },
      clearIntervalFn: vi.fn(),
      onError
    });

    runtime.start();
    await runtime.settled();
    tick?.();
    await runtime.settled();

    expect(pollOnce).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]?.[0])).toBe('Error: Telegram polling cycle failed');
    expect(String(onError.mock.calls[0]?.[0])).not.toContain(token);
    runtime.stop();
  });
});

describe('Telegram channel runtime assembly', () => {
  let sqlite: SQLite.Database;

  beforeEach(() => {
    sqlite = new SQLite(':memory:');
    sqlite.exec(`
      CREATE TABLE telegram_channel_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        update_cursor INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO telegram_channel_state VALUES (1, -1, '2026-07-21T00:00:00.000Z');
      CREATE TABLE telegram_channel_inbox (
        update_id INTEGER PRIMARY KEY,
        update_digest TEXT NOT NULL,
        identity_digest TEXT NOT NULL,
        redacted_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        command_id TEXT,
        received_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE action_proposals (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, principal_id TEXT NOT NULL,
        channel TEXT NOT NULL, scope_id TEXT NOT NULL, tenant_id TEXT,
        policy_version INTEGER NOT NULL, kind TEXT NOT NULL, payload_digest TEXT NOT NULL,
        reversible INTEGER NOT NULL, external_effect INTEGER NOT NULL, risk TEXT NOT NULL,
        state TEXT NOT NULL, version INTEGER NOT NULL, confirmation_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(principal_id, channel, source_id)
      );
      CREATE TABLE action_proposal_decisions (
        id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, principal_id TEXT NOT NULL,
        verdict TEXT NOT NULL, proposal_version INTEGER NOT NULL, decided_at TEXT NOT NULL
      );
    `);
  });

  afterEach(() => sqlite.close());

  it('loads the bot token from Keychain and binds reads to the personal Jarvis scope', async () => {
    const read = vi.fn().mockResolvedValue(token);
    const getUpdates = vi.fn().mockResolvedValue([update(7)]);
    const send = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue({
      mode: 'deterministic',
      intent: 'today',
      reply: 'Bounded personal status.',
      suggestedView: 'today',
      evidenceRefs: [],
      requiresApproval: false
    });
    const runtime = await createTelegramChannelRuntime({
      sqlite,
      allowlist: { userId: 42, chatId: 84 },
      keychain: { service: 'com.aiagency.jarvis.telegram', account: 'bot-token' },
      secrets: { read },
      responder: { respond },
      apiFactory: (receivedToken) => {
        expect(receivedToken).toBe(token);
        return { getUpdates, send };
      }
    });

    await runtime.pollOnce();

    expect(read).toHaveBeenCalledWith({
      service: 'com.aiagency.jarvis.telegram',
      account: 'bot-token'
    });
    expect(respond).toHaveBeenCalledWith({ message: 'today' });
    expect(send).toHaveBeenCalledWith(84, 'Bounded personal status.');
    expect(sqlite.prepare('SELECT update_cursor FROM telegram_channel_state').pluck().get()).toBe(
      7
    );
  });

  it('does not accept credentials or authority through environment text', () => {
    expect(telegramServerOptionsFromEnvironment({})).toBe(false);
    expect(
      telegramServerOptionsFromEnvironment({
        JARVIS_TELEGRAM_ENABLED: '1',
        JARVIS_TELEGRAM_USER_ID: '42',
        JARVIS_TELEGRAM_CHAT_ID: '84',
        JARVIS_TELEGRAM_KEYCHAIN_SERVICE: 'com.aiagency.jarvis.telegram',
        JARVIS_TELEGRAM_KEYCHAIN_ACCOUNT: 'bot-token',
        JARVIS_TELEGRAM_TOKEN: token,
        JARVIS_TELEGRAM_AUTHORITY: 'approve'
      })
    ).toEqual({
      allowlist: { userId: 42, chatId: 84 },
      keychain: {
        service: 'com.aiagency.jarvis.telegram',
        account: 'bot-token'
      }
    });
    expect(() =>
      telegramServerOptionsFromEnvironment({
        JARVIS_TELEGRAM_ENABLED: '1',
        JARVIS_TELEGRAM_USER_ID: '42',
        JARVIS_TELEGRAM_CHAT_ID: '-100123'
      })
    ).toThrow('Telegram channel configuration is invalid');
    expect(() =>
      telegramServerOptionsFromEnvironment({
        JARVIS_TELEGRAM_ENABLED: '1',
        JARVIS_TELEGRAM_USER_ID: '1e2',
        JARVIS_TELEGRAM_CHAT_ID: '84'
      })
    ).toThrow('Telegram channel configuration is invalid');
  });
});
