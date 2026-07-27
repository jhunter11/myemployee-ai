import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  CommandPrincipalSchema,
  ServerScopeBindingSchema,
  type CommandPrincipal,
  type ServerScopeBinding
} from '../../commands/contracts';
import type { SqliteTelegramInboxRepository } from './inbox-repository';
import { pauseRuntimePayloadDigest } from '../../agency/execution-posture';

const TelegramUpdateSchema = z.object({
  update_id: z.number().int().min(0),
  message: z
    .object({
      message_id: z.number().int(),
      date: z.number().int().min(0),
      from: z.object({ id: z.number().int(), is_bot: z.boolean() }),
      chat: z.object({ id: z.number().int(), type: z.string().max(32) }),
      text: z.string().max(4_096).optional()
    })
    .optional()
});
const TelegramUpdateIdSchema = z.object({ update_id: z.number().int().min(0) });

interface SharedCommandPort {
  execute(input: {
    principal: CommandPrincipal;
    binding: ServerScopeBinding;
    request: { message: string; idempotencyKey: string };
  }): Promise<unknown>;
}

interface ProposalPort {
  propose(input: {
    principal: CommandPrincipal;
    binding: ServerScopeBinding;
    request: {
      kind: 'pause_runtime';
      externalEffect: false;
      reversible: true;
      sourceId: string;
      payloadDigest: string;
      expiresInSeconds: 300;
    };
  }): Promise<unknown>;
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function updateSourceId(updateId: number): string {
  return `telegram:update:${String(updateId).padStart(16, '0')}`;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function classifiedKind(input: {
  authorized: boolean;
  reason: string;
  text: string | undefined;
}): string {
  if (!input.authorized) return `rejected:${input.reason}`;
  const command = (input.text ?? '').trim().split(/\s+/u)[0]?.toLowerCase();
  if (['/today', '/status', '/queue', '/projects', '/help'].includes(command ?? '')) {
    return `read:${command?.slice(1)}`;
  }
  if (command === '/pause') return 'proposal:pause_runtime';
  return 'rejected:unsupported_command';
}

function authorization(input: {
  userId: number | undefined;
  chatId: number | undefined;
  chatType: string | undefined;
  isBot: boolean | undefined;
  allowlist: { userId: number; chatId: number };
}): { authorized: boolean; reason: string } {
  if (input.userId !== input.allowlist.userId) return { authorized: false, reason: 'user' };
  if (input.chatId !== input.allowlist.chatId) return { authorized: false, reason: 'chat' };
  if (input.chatType !== 'private') return { authorized: false, reason: 'non_private' };
  if (input.isBot !== false) return { authorized: false, reason: 'bot_sender' };
  return { authorized: true, reason: 'allowlisted_private_chat' };
}

export interface TelegramProcessResult {
  accepted: boolean;
  duplicate: boolean;
  reply: string | null;
}

export class TelegramUpdateProcessor {
  private readonly principal: CommandPrincipal;
  private readonly binding: ServerScopeBinding;

  constructor(
    private readonly options: {
      allowlist: { userId: number; chatId: number };
      principal: unknown;
      binding: unknown;
      inbox: SqliteTelegramInboxRepository;
      commands: SharedCommandPort;
      proposals: ProposalPort;
      delivery?: { send(chatId: number, text: string): Promise<void> };
    }
  ) {
    this.principal = CommandPrincipalSchema.parse(options.principal);
    this.binding = ServerScopeBindingSchema.parse(options.binding);
    if (this.principal.channel !== 'telegram') {
      throw new Error('Telegram processor requires a Telegram-bound principal');
    }
  }

  async process(rawUpdate: unknown): Promise<TelegramProcessResult> {
    const updateId = TelegramUpdateIdSchema.parse(rawUpdate).update_id;
    const parsedUpdate = TelegramUpdateSchema.safeParse(rawUpdate);
    if (!parsedUpdate.success) {
      const claim = await this.options.inbox.claim({
        updateId,
        updateDigest: digest(JSON.stringify(rawUpdate)),
        identityDigest: digest('malformed-telegram-identity'),
        redactedKind: 'rejected:malformed'
      });
      if (claim.duplicate) return { accepted: false, duplicate: true, reply: null };
      if (claim.pendingReplay) {
        await this.options.inbox.complete(updateId, null);
        return { accepted: false, duplicate: true, reply: null };
      }
      await this.options.inbox.complete(updateId, null);
      return { accepted: false, duplicate: false, reply: null };
    }
    const update = parsedUpdate.data;
    const message = update.message;
    const auth = authorization({
      userId: message?.from.id,
      chatId: message?.chat.id,
      chatType: message?.chat.type,
      isBot: message?.from.is_bot,
      allowlist: this.options.allowlist
    });
    const redactedKind = classifiedKind({
      authorized: auth.authorized,
      reason: auth.reason,
      text: message?.text
    });
    const updateDigest = digest(
      JSON.stringify({
        updateId: update.update_id,
        messageId: message?.message_id ?? null,
        userId: message?.from.id ?? null,
        chatId: message?.chat.id ?? null,
        chatType: message?.chat.type ?? null,
        isBot: message?.from.is_bot ?? null,
        text: message?.text ?? null
      })
    );
    const identityDigest = digest(
      `${message?.from.id ?? 'missing'}\u001f${message?.chat.id ?? 'missing'}`
    );
    const claim = await this.options.inbox.claim({
      updateId: update.update_id,
      updateDigest,
      identityDigest,
      redactedKind
    });
    if (claim.duplicate) return { accepted: false, duplicate: true, reply: null };
    if (claim.pendingReplay) {
      // The prior process may already have emitted an external reply. Telegram
      // offers no atomic transaction spanning our inbox and its send API, so a
      // replay is closed without invoking commands or delivery a second time.
      await this.options.inbox.complete(update.update_id, null);
      return { accepted: false, duplicate: true, reply: null };
    }

    if (!auth.authorized) {
      await this.options.inbox.complete(update.update_id, null);
      return { accepted: false, duplicate: false, reply: null };
    }

    const text = message?.text?.trim() ?? '';
    const command = text.split(/\s+/u)[0]?.toLowerCase();
    const readMessages: Record<string, string> = {
      '/today': 'today',
      '/status': 'status',
      '/queue': 'agency status',
      '/projects': 'agency work',
      '/help': 'help'
    };
    if (command && readMessages[command]) {
      const receipt = object(
        await this.options.commands.execute({
          principal: this.principal,
          binding: this.binding,
          request: {
            message: readMessages[command],
            idempotencyKey: updateSourceId(update.update_id)
          }
        })
      );
      const envelope = object(receipt.envelope);
      const response = object(receipt.response);
      const reply = typeof response.reply === 'string' ? response.reply.slice(0, 4_000) : null;
      if (reply && this.options.delivery) {
        await this.options.delivery.send(this.options.allowlist.chatId, reply);
      }
      await this.options.inbox.complete(
        update.update_id,
        typeof envelope.commandId === 'string' ? envelope.commandId : null
      );
      return { accepted: true, duplicate: false, reply };
    }

    if (command === '/pause') {
      if (!this.principal.authority.includes('propose')) {
        const reply = 'This channel is not authorized to propose a runtime pause.';
        if (this.options.delivery) {
          await this.options.delivery.send(this.options.allowlist.chatId, reply);
        }
        await this.options.inbox.complete(update.update_id, null);
        return {
          accepted: true,
          duplicate: false,
          reply
        };
      }
      const sourceId = updateSourceId(update.update_id);
      const proposal = object(
        await this.options.proposals.propose({
          principal: this.principal,
          binding: this.binding,
          request: {
            kind: 'pause_runtime',
            externalEffect: false,
            reversible: true,
            sourceId,
            payloadDigest: pauseRuntimePayloadDigest(),
            expiresInSeconds: 300
          }
        })
      );
      const reply = `Pause proposal ${typeof proposal.id === 'string' ? proposal.id : 'created'} awaits exact desktop approval; no runtime state changed.`;
      if (this.options.delivery) {
        await this.options.delivery.send(this.options.allowlist.chatId, reply);
      }
      await this.options.inbox.complete(update.update_id, null);
      return {
        accepted: true,
        duplicate: false,
        reply
      };
    }

    const reply =
      'Supported private commands: /today, /status, /queue, /projects, /pause, and /help. Free text cannot grant authority.';
    if (this.options.delivery) {
      await this.options.delivery.send(this.options.allowlist.chatId, reply);
    }
    await this.options.inbox.complete(update.update_id, null);
    return {
      accepted: true,
      duplicate: false,
      reply
    };
  }
}
