import { createHash } from 'node:crypto';

import {
  BoundedCommandResponseSchema,
  CommandEnvelopeSchema,
  CommandPrincipalSchema,
  CommandReceiptSchema,
  ServerScopeBindingSchema,
  SharedCommandRequestSchema,
  type CommandPrincipal,
  type CommandReceipt,
  type ServerScopeBinding,
  type SharedCommandRequest
} from './contracts';

interface CommandResponder {
  respond(input: { message: string }): Promise<unknown>;
}

export interface CommandReceiptRepository {
  find(input: {
    principalId: string;
    channel: string;
    idempotencyKey: string;
  }): Promise<CommandReceipt | null>;
  save(receipt: CommandReceipt): Promise<void>;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function commandId(input: {
  principalId: string;
  channel: string;
  idempotencyKey: string;
  payloadDigest: string;
}): string {
  return `command:${createHash('sha256')
    .update(
      [input.principalId, input.channel, input.idempotencyKey, input.payloadDigest].join('\u001f')
    )
    .digest('hex')}`;
}

function receiptKey(input: {
  principalId: string;
  channel: string;
  idempotencyKey: string;
}): string {
  return `${input.principalId}\u001f${input.channel}\u001f${input.idempotencyKey}`;
}

export class InMemoryCommandReceiptRepository implements CommandReceiptRepository {
  private readonly receipts = new Map<string, CommandReceipt>();

  find(input: {
    principalId: string;
    channel: string;
    idempotencyKey: string;
  }): Promise<CommandReceipt | null> {
    return Promise.resolve(this.receipts.get(receiptKey(input)) ?? null);
  }

  save(receiptInput: CommandReceipt): Promise<void> {
    const receipt = CommandReceiptSchema.parse(receiptInput);
    const key = receiptKey({
      principalId: receipt.envelope.principalId,
      channel: receipt.envelope.channel,
      idempotencyKey: receipt.envelope.idempotencyKey
    });
    if (this.receipts.has(key)) throw new Error('command receipt already exists');
    this.receipts.set(key, receipt);
    return Promise.resolve();
  }
}

export class SharedCommandService {
  private readonly now: () => string;

  constructor(
    private readonly options: {
      responder: CommandResponder;
      receipts: CommandReceiptRepository;
      now?: () => string;
    }
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async execute(input: {
    principal: unknown;
    binding: unknown;
    request: unknown;
  }): Promise<CommandReceipt & { replayed: boolean }> {
    const principal = CommandPrincipalSchema.parse(input.principal);
    const binding = ServerScopeBindingSchema.parse(input.binding);
    const request = SharedCommandRequestSchema.parse(input.request);
    this.assertReadBoundary(principal, binding, request);
    const payloadDigest = sha256(JSON.stringify({ message: request.message }));
    const previous = await this.options.receipts.find({
      principalId: principal.id,
      channel: principal.channel,
      idempotencyKey: request.idempotencyKey
    });
    if (previous) {
      if (previous.envelope.payloadDigest !== payloadDigest) {
        throw new Error('idempotency key was already bound to different command content');
      }
      return { ...previous, replayed: true };
    }

    const createdAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + 5 * 60_000).toISOString();
    const envelope = CommandEnvelopeSchema.parse({
      version: 1,
      commandId: commandId({
        principalId: principal.id,
        channel: principal.channel,
        idempotencyKey: request.idempotencyKey,
        payloadDigest
      }),
      principalId: principal.id,
      channel: principal.channel,
      scopeId: binding.scopeId,
      tenantId: binding.tenantId,
      policyVersion: binding.policyVersion,
      kind: 'bounded_read',
      payloadDigest,
      idempotencyKey: request.idempotencyKey,
      expectedVersion: 1,
      risk: 'read_only',
      createdAt,
      expiresAt,
      confirmationFingerprint: null
    });
    const response = BoundedCommandResponseSchema.parse(
      await this.options.responder.respond({ message: request.message })
    );
    const receipt = CommandReceiptSchema.parse({ envelope, response, executedAt: createdAt });
    await this.options.receipts.save(receipt);
    return { ...receipt, replayed: false };
  }

  private assertReadBoundary(
    principal: CommandPrincipal,
    binding: ServerScopeBinding,
    request: SharedCommandRequest
  ): void {
    if (!principal.authority.includes('read')) throw new Error('principal lacks read authority');
    if (!request.idempotencyKey.startsWith(`${principal.channel}:`)) {
      throw new Error('idempotency key channel does not match authenticated principal');
    }
    const expectedPrefix =
      binding.trustDomain === 'mcp_x402'
        ? 'mcp'
        : binding.trustDomain === 'system'
          ? 'harness'
          : binding.trustDomain;
    if (!binding.scopeId.startsWith(`${expectedPrefix}:`)) {
      throw new Error('server scope binding does not match its trust domain');
    }
    if (binding.trustDomain === 'personal' && binding.tenantId !== null) {
      throw new Error('personal commands cannot bind a tenant');
    }
  }
}
