import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import SQLite from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SqliteTelegramInboxRepository } from '../../src/channels/telegram/inbox-repository';
import { TelegramLongPoller } from '../../src/channels/telegram/long-poller';
import { TelegramUpdateProcessor } from '../../src/channels/telegram/update-processor';

const projectRoot = join(__dirname, '..', '..');
const operatorPrincipal = {
  version: 1 as const,
  id: 'principal:telegram_operator',
  kind: 'operator' as const,
  channel: 'telegram' as const,
  authority: ['read', 'propose'] as const
};
const binding = {
  scopeId: 'personal:jarvis',
  trustDomain: 'personal' as const,
  tenantId: null,
  policyVersion: 1
};

function update(input: {
  updateId?: number;
  userId?: number;
  chatId?: number;
  chatType?: string;
  text?: string;
}) {
  return {
    update_id: input.updateId ?? 100,
    message: {
      message_id: 50,
      date: 1_784_657_600,
      from: { id: input.userId ?? 42, is_bot: false },
      chat: { id: input.chatId ?? 84, type: input.chatType ?? 'private' },
      text: input.text ?? '/today'
    }
  };
}

describe('private Telegram command channel', () => {
  let sqlite: SQLite.Database;
  let repository: SqliteTelegramInboxRepository;

  beforeEach(async () => {
    sqlite = new SQLite(':memory:');
    sqlite.exec(
      await readFile(join(projectRoot, 'src/db/migrations/012_telegram_channel.sql'), 'utf8')
    );
    repository = new SqliteTelegramInboxRepository(sqlite, {
      now: () => '2026-07-21T18:00:00.000Z'
    });
  });

  afterEach(() => sqlite.close());

  it.each([
    ['wrong user', update({ userId: 999 })],
    ['wrong chat', update({ chatId: 999 })],
    ['group chat', update({ chatType: 'group' })],
    [
      'bot sender',
      { ...update({}), message: { ...update({}).message, from: { id: 42, is_bot: true } } }
    ]
  ])('fails closed for %s and advances past the poison update', async (_name, rawUpdate) => {
    const execute = vi.fn();
    const processor = new TelegramUpdateProcessor({
      allowlist: { userId: 42, chatId: 84 },
      principal: operatorPrincipal,
      binding,
      inbox: repository,
      commands: { execute },
      proposals: { propose: vi.fn() }
    });

    const result = await processor.process(rawUpdate);
    const replay = await processor.process(rawUpdate);

    expect(result).toMatchObject({ accepted: false, reply: null });
    expect(replay).toMatchObject({ accepted: false, duplicate: true, reply: null });
    expect(execute).not.toHaveBeenCalled();
    expect(await repository.cursor()).toBe(100);
    const stored = sqlite
      .prepare('SELECT redacted_kind, status FROM telegram_channel_inbox WHERE update_id = 100')
      .get() as { redacted_kind: string; status: string };
    expect(stored.status).toBe('completed');
    expect(stored.redacted_kind).not.toContain('999');
  });

  it('redacts and advances past a malformed poison update without invoking commands', async () => {
    const execute = vi.fn();
    const processor = new TelegramUpdateProcessor({
      allowlist: { userId: 42, chatId: 84 },
      principal: operatorPrincipal,
      binding,
      inbox: repository,
      commands: { execute },
      proposals: { propose: vi.fn() }
    });

    const result = await processor.process({
      update_id: 106,
      message: {
        message_id: 51,
        date: 1_784_657_600,
        from: { id: 42, is_bot: false },
        chat: { id: 84, type: 'private' },
        text: { secret: 'must-not-persist' }
      }
    });

    expect(result).toEqual({ accepted: false, duplicate: false, reply: null });
    expect(execute).not.toHaveBeenCalled();
    expect(await repository.cursor()).toBe(106);
    const serialized = JSON.stringify(
      sqlite.prepare('SELECT * FROM telegram_channel_inbox WHERE update_id = 106').get()
    );
    expect(serialized).toContain('rejected:malformed');
    expect(serialized).not.toContain('must-not-persist');
    await expect(
      processor.process({
        update_id: 106,
        message: {
          message_id: 51,
          date: 1_784_657_600,
          from: { id: 42, is_bot: false },
          chat: { id: 84, type: 'private' },
          text: { secret: 'must-not-persist' }
        }
      })
    ).resolves.toMatchObject({ duplicate: true });
  });

  it('handles pending replay, digest conflicts, and completion conflicts transactionally', async () => {
    const input = {
      updateId: 107,
      updateDigest: `sha256:${'a'.repeat(64)}`,
      identityDigest: `sha256:${'b'.repeat(64)}`,
      redactedKind: 'read:today'
    };
    await expect(repository.claim(input)).resolves.toEqual({
      claimed: true,
      duplicate: false,
      pendingReplay: false
    });
    await expect(repository.claim(input)).resolves.toEqual({
      claimed: true,
      duplicate: false,
      pendingReplay: true
    });
    await expect(
      repository.claim({ ...input, updateDigest: `sha256:${'c'.repeat(64)}` })
    ).rejects.toThrow('reused with different bounded content');
    await repository.complete(107, null);
    await expect(repository.complete(107, null)).resolves.toBeUndefined();
    await expect(repository.complete(999, null)).rejects.toThrow('was not claimed');
  });

  it('advances a missing-message update without revealing or invoking anything', async () => {
    const execute = vi.fn();
    const processor = new TelegramUpdateProcessor({
      allowlist: { userId: 42, chatId: 84 },
      principal: operatorPrincipal,
      binding,
      inbox: repository,
      commands: { execute },
      proposals: { propose: vi.fn() }
    });

    await expect(processor.process({ update_id: 108 })).resolves.toEqual({
      accepted: false,
      duplicate: false,
      reply: null
    });
    expect(execute).not.toHaveBeenCalled();
    expect(await repository.cursor()).toBe(108);
  });

  it('executes an allowlisted read through the principal-bound shared command service', async () => {
    const execute = vi.fn().mockResolvedValue({
      envelope: { commandId: `command:${'a'.repeat(64)}` },
      response: { reply: 'One safe next move.', evidenceRefs: ['queue:work-1'] },
      replayed: false
    });
    const processor = new TelegramUpdateProcessor({
      allowlist: { userId: 42, chatId: 84 },
      principal: operatorPrincipal,
      binding,
      inbox: repository,
      commands: { execute },
      proposals: { propose: vi.fn() }
    });

    const result = await processor.process(update({ updateId: 101, text: '/today' }));

    expect(result).toMatchObject({
      accepted: true,
      duplicate: false,
      reply: 'One safe next move.'
    });
    expect(execute).toHaveBeenCalledWith({
      principal: operatorPrincipal,
      binding,
      request: { message: 'today', idempotencyKey: 'telegram:update:0000000000000101' }
    });
    expect(await repository.cursor()).toBe(101);
  });

  it('deduplicates a completed update transactionally across repository instances', async () => {
    const execute = vi.fn().mockResolvedValue({
      envelope: { commandId: `command:${'b'.repeat(64)}` },
      response: { reply: 'Bounded status.', evidenceRefs: [] },
      replayed: false
    });
    const options = {
      allowlist: { userId: 42, chatId: 84 },
      principal: operatorPrincipal,
      binding,
      inbox: repository,
      commands: { execute },
      proposals: { propose: vi.fn() }
    };
    await new TelegramUpdateProcessor(options).process(update({ updateId: 102, text: '/status' }));
    const restarted = new TelegramUpdateProcessor({
      ...options,
      inbox: new SqliteTelegramInboxRepository(sqlite)
    });

    const replay = await restarted.process(update({ updateId: 102, text: '/status' }));

    expect(replay).toMatchObject({ duplicate: true, reply: null });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a pending restart replay without executing or delivering twice', async () => {
    const rawUpdate = update({ updateId: 111, text: '/today' });
    const serialized = JSON.stringify({
      updateId: rawUpdate.update_id,
      messageId: rawUpdate.message.message_id,
      userId: rawUpdate.message.from.id,
      chatId: rawUpdate.message.chat.id,
      chatType: rawUpdate.message.chat.type,
      isBot: rawUpdate.message.from.is_bot,
      text: rawUpdate.message.text
    });
    const { createHash } = await import('node:crypto');
    const hashed = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
    await repository.claim({
      updateId: 111,
      updateDigest: hashed(serialized),
      identityDigest: hashed('42\u001f84'),
      redactedKind: 'read:today'
    });
    const execute = vi.fn();
    const send = vi.fn();
    const processor = new TelegramUpdateProcessor({
      allowlist: { userId: 42, chatId: 84 },
      principal: operatorPrincipal,
      binding,
      inbox: new SqliteTelegramInboxRepository(sqlite),
      commands: { execute },
      proposals: { propose: vi.fn() },
      delivery: { send }
    });

    await expect(processor.process(rawUpdate)).resolves.toEqual({
      accepted: false,
      duplicate: true,
      reply: null
    });
    expect(execute).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(await repository.cursor()).toBe(111);
  });

  it('creates an exact pause proposal but never engages the runtime directly', async () => {
    const propose = vi.fn().mockResolvedValue({ id: `proposal:${'c'.repeat(64)}` });
    const processor = new TelegramUpdateProcessor({
      allowlist: { userId: 42, chatId: 84 },
      principal: operatorPrincipal,
      binding,
      inbox: repository,
      commands: { execute: vi.fn() },
      proposals: { propose }
    });

    const result = await processor.process(update({ updateId: 103, text: '/pause' }));

    const proposalInput: unknown = propose.mock.calls[0]?.[0];
    expect(proposalInput).toMatchObject({
      principal: operatorPrincipal,
      binding,
      request: {
        kind: 'pause_runtime',
        externalEffect: false,
        reversible: true,
        sourceId: 'telegram:update:0000000000000103',
        expiresInSeconds: 300
      }
    });
    expect(result.reply).toContain('proposal');
    expect(result.reply).toContain('desktop approval');
  });

  it('does not turn free text or dangerous commands into authority', async () => {
    const execute = vi.fn();
    const propose = vi.fn();
    const send = vi.fn().mockResolvedValue(undefined);
    const processor = new TelegramUpdateProcessor({
      allowlist: { userId: 42, chatId: 84 },
      principal: operatorPrincipal,
      binding,
      inbox: repository,
      commands: { execute },
      proposals: { propose },
      delivery: { send }
    });

    const result = await processor.process(
      update({ updateId: 104, text: 'cancel every client contract and pay me' })
    );

    expect(result.accepted).toBe(true);
    expect(result.reply).toContain('Supported private commands');
    expect(execute).not.toHaveBeenCalled();
    expect(propose).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(84, result.reply);
  });

  it('returns a bounded denial when the channel lacks proposal authority', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const processor = new TelegramUpdateProcessor({
      allowlist: { userId: 42, chatId: 84 },
      principal: { ...operatorPrincipal, authority: ['read'] },
      binding,
      inbox: repository,
      commands: { execute: vi.fn() },
      proposals: { propose: vi.fn() },
      delivery: { send }
    });

    const result = await processor.process(update({ updateId: 109, text: '/pause' }));

    expect(result.reply).toContain('not authorized');
    expect(send).toHaveBeenCalledWith(84, result.reply);
  });

  it('accepts a bounded read receipt with no reply without sending empty text', async () => {
    const send = vi.fn();
    const processor = new TelegramUpdateProcessor({
      allowlist: { userId: 42, chatId: 84 },
      principal: operatorPrincipal,
      binding,
      inbox: repository,
      commands: { execute: vi.fn().mockResolvedValue({ envelope: {}, response: {} }) },
      proposals: { propose: vi.fn() },
      delivery: { send }
    });

    await expect(
      processor.process(update({ updateId: 110, text: '/status' }))
    ).resolves.toMatchObject({ accepted: true, reply: null });
    expect(send).not.toHaveBeenCalled();
  });

  it('stores only hashes and a bounded command classification, never raw chat text', async () => {
    const secret = 'my private customer secret';
    const processor = new TelegramUpdateProcessor({
      allowlist: { userId: 42, chatId: 84 },
      principal: operatorPrincipal,
      binding,
      inbox: repository,
      commands: { execute: vi.fn() },
      proposals: { propose: vi.fn() }
    });

    await processor.process(update({ updateId: 105, text: secret }));

    const serialized = JSON.stringify(
      sqlite.prepare('SELECT * FROM telegram_channel_inbox WHERE update_id = 105').get()
    );
    expect(serialized).not.toContain(secret);
    expect(serialized).toMatch(/sha256:[a-f0-9]{64}/);
  });

  it('long-polls messages from cursor plus one and delivers only to the allowlisted chat', async () => {
    await repository.claim({
      updateId: 199,
      updateDigest: `sha256:${'a'.repeat(64)}`,
      identityDigest: `sha256:${'b'.repeat(64)}`,
      redactedKind: 'read:today'
    });
    await repository.complete(199, null);
    const getUpdates = vi
      .fn()
      .mockResolvedValue([
        update({ updateId: 201, text: '/help' }),
        update({ updateId: 200, text: '/today' })
      ]);
    const send = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({
      envelope: { commandId: `command:${'d'.repeat(64)}` },
      response: { reply: 'Private bounded reply.', evidenceRefs: [] },
      replayed: false
    });
    const processor = new TelegramUpdateProcessor({
      allowlist: { userId: 42, chatId: 84 },
      principal: operatorPrincipal,
      binding,
      inbox: repository,
      commands: { execute },
      proposals: { propose: vi.fn() },
      delivery: { send }
    });
    const poller = new TelegramLongPoller({
      inbox: repository,
      processor,
      api: { getUpdates }
    });

    const result = await poller.pollOnce();

    expect(getUpdates).toHaveBeenCalledWith({
      offset: 200,
      limit: 50,
      timeout: 30,
      allowedUpdates: ['message']
    });
    expect(result).toEqual({ received: 2, processed: 2 });
    expect(
      execute.mock.calls.map(
        ([input]) => (input as { request: { idempotencyKey: string } }).request.idempotencyKey
      )
    ).toEqual(['telegram:update:0000000000000200', 'telegram:update:0000000000000201']);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, 84, 'Private bounded reply.');
    expect(await repository.cursor()).toBe(201);
  });

  it('omits an update with no usable ID while continuing with later bounded updates', async () => {
    const getUpdates = vi
      .fn()
      .mockResolvedValue([
        { unexpected: 'provider noise' },
        update({ updateId: 202, text: '/help' })
      ]);
    const execute = vi.fn().mockResolvedValue({
      envelope: { commandId: `command:${'e'.repeat(64)}` },
      response: { reply: 'Safe help.', evidenceRefs: [] },
      replayed: false
    });
    const processor = new TelegramUpdateProcessor({
      allowlist: { userId: 42, chatId: 84 },
      principal: operatorPrincipal,
      binding,
      inbox: repository,
      commands: { execute },
      proposals: { propose: vi.fn() }
    });
    const poller = new TelegramLongPoller({
      inbox: repository,
      processor,
      api: { getUpdates }
    });

    await expect(poller.pollOnce()).resolves.toEqual({ received: 2, processed: 1 });
    expect(await repository.cursor()).toBe(202);
  });
});
