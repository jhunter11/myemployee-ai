import type { Kysely, Selectable, Transaction } from 'kysely';
import { z } from 'zod';

import type { AgentConversationsTable, AgentMessagesTable, JarvisDatabase } from '../db/types';

const MAX_CONVERSATION_VERSION = 2_147_483_647;
const MAX_EXPECTED_VERSION = MAX_CONVERSATION_VERSION - 1;
const MAX_EXCHANGE_EXPECTED_VERSION = MAX_CONVERSATION_VERSION - 2;
const MAX_CONVERSATION_LIST = 100;
const MAX_MESSAGE_LIST = 200;
const MAX_TITLE_LENGTH = 160;
const MAX_MESSAGE_TEXT_LENGTH = 16_000;
const MAX_EVIDENCE_REFS = 32;

const CanonicalIdTail = '[a-z0-9](?:[a-z0-9]|[._:-](?=[a-z0-9]))';

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) as number;
    return codePoint <= 31 || codePoint === 127;
  });
}

export const AgentConversationIdSchema = z
  .string()
  .regex(new RegExp(`^conversation:${CanonicalIdTail}{2,95}$`));
export const AgentMessageIdSchema = z
  .string()
  .regex(new RegExp(`^message:${CanonicalIdTail}{2,95}$`));
export const AgentConversationTurnClaimIdSchema = z
  .string()
  .regex(new RegExp(`^turn-claim:${CanonicalIdTail}{2,95}$`));
export const ConversationAgentIdSchema = z
  .string()
  .max(128)
  .regex(/^[a-z](?:[a-z0-9]|[._:-](?=[a-z0-9])){0,127}$/);
export const ConversationTrustDomainSchema = z.enum(['personal', 'agency', 'task_market']);
export const ConversationTitleSchema = z
  .string()
  .min(1)
  .max(MAX_TITLE_LENGTH)
  .refine((title) => title.trim() === title, 'conversation title must be trimmed')
  .refine((title) => !containsControlCharacter(title), 'conversation title is invalid');
export const AgentMessageTextSchema = z
  .string()
  .min(1)
  .max(MAX_MESSAGE_TEXT_LENGTH)
  .refine((message) => message.trim().length > 0, 'message text must contain visible content')
  .refine((message) => !message.includes('\u0000'), 'message text is invalid');
export const AgentMessageResponseModeSchema = z.enum([
  'operator_input',
  'deterministic',
  'profile',
  'model',
  'runtime_not_configured'
]);
export const AgentMessageAuthorKindSchema = z.enum(['operator', 'agent']);
export const AgentEvidenceReferenceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/);
export const AgentEvidenceReferencesSchema = z
  .array(AgentEvidenceReferenceSchema)
  .max(MAX_EVIDENCE_REFS)
  .superRefine((references, context) => {
    if (new Set(references).size !== references.length) {
      context.addIssue({ code: 'custom', message: 'evidence references must be unique' });
    }
  });
export const AgentConversationTimestampSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
export const AgentConversationExpectedVersionSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_EXPECTED_VERSION);
export const AgentConversationCurrentVersionSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_CONVERSATION_VERSION);

export const CreateAgentConversationInputSchema = z.strictObject({
  id: AgentConversationIdSchema,
  agentId: ConversationAgentIdSchema,
  trustDomain: ConversationTrustDomainSchema,
  title: ConversationTitleSchema.nullable().default(null),
  createdAt: AgentConversationTimestampSchema
});

export const ListAgentConversationsInputSchema = z.strictObject({
  agentId: ConversationAgentIdSchema,
  trustDomain: ConversationTrustDomainSchema,
  limit: z.number().int().min(1).max(MAX_CONVERSATION_LIST)
});

const NewAgentMessageSchema = z.strictObject({
  id: AgentMessageIdSchema,
  authorKind: AgentMessageAuthorKindSchema,
  respondingAgentId: ConversationAgentIdSchema.nullable(),
  responseMode: AgentMessageResponseModeSchema,
  text: AgentMessageTextSchema,
  evidenceRefs: AgentEvidenceReferencesSchema,
  createdAt: AgentConversationTimestampSchema
});

export const AppendAgentMessageInputSchema = z
  .strictObject({
    conversationId: AgentConversationIdSchema,
    agentId: ConversationAgentIdSchema,
    trustDomain: ConversationTrustDomainSchema,
    expectedVersion: AgentConversationExpectedVersionSchema,
    message: NewAgentMessageSchema
  })
  .superRefine((input, context) => {
    const message = input.message;
    if (message.authorKind === 'operator') {
      if (message.respondingAgentId !== null) {
        context.addIssue({
          code: 'custom',
          path: ['message', 'respondingAgentId'],
          message: 'operator messages cannot claim a responding agent'
        });
      }
      if (message.responseMode !== 'operator_input') {
        context.addIssue({
          code: 'custom',
          path: ['message', 'responseMode'],
          message: 'operator messages require operator_input mode'
        });
      }
      return;
    }

    if (message.respondingAgentId !== input.agentId) {
      context.addIssue({
        code: 'custom',
        path: ['message', 'respondingAgentId'],
        message: 'responding agent must match the bound conversation agent'
      });
    }
    if (message.responseMode === 'operator_input') {
      context.addIssue({
        code: 'custom',
        path: ['message', 'responseMode'],
        message: 'agent messages cannot use operator_input mode'
      });
    }
  });

export const AppendAgentExchangeInputSchema = z
  .strictObject({
    conversationId: AgentConversationIdSchema,
    agentId: ConversationAgentIdSchema,
    trustDomain: ConversationTrustDomainSchema,
    expectedVersion: z.number().int().min(1).max(MAX_EXCHANGE_EXPECTED_VERSION),
    operatorMessage: NewAgentMessageSchema,
    agentMessage: NewAgentMessageSchema
  })
  .superRefine((input, context) => {
    if (input.operatorMessage.authorKind !== 'operator') {
      context.addIssue({
        code: 'custom',
        path: ['operatorMessage', 'authorKind'],
        message: 'the first exchange message must be operator-authored'
      });
    }
    if (input.operatorMessage.respondingAgentId !== null) {
      context.addIssue({
        code: 'custom',
        path: ['operatorMessage', 'respondingAgentId'],
        message: 'operator messages cannot claim a responding agent'
      });
    }
    if (input.operatorMessage.responseMode !== 'operator_input') {
      context.addIssue({
        code: 'custom',
        path: ['operatorMessage', 'responseMode'],
        message: 'operator messages require operator_input mode'
      });
    }
    if (input.agentMessage.authorKind !== 'agent') {
      context.addIssue({
        code: 'custom',
        path: ['agentMessage', 'authorKind'],
        message: 'the second exchange message must be agent-authored'
      });
    }
    if (input.agentMessage.respondingAgentId !== input.agentId) {
      context.addIssue({
        code: 'custom',
        path: ['agentMessage', 'respondingAgentId'],
        message: 'responding agent must match the bound conversation agent'
      });
    }
    if (input.agentMessage.responseMode === 'operator_input') {
      context.addIssue({
        code: 'custom',
        path: ['agentMessage', 'responseMode'],
        message: 'agent messages cannot use operator_input mode'
      });
    }
    if (input.operatorMessage.id === input.agentMessage.id) {
      context.addIssue({
        code: 'custom',
        path: ['agentMessage', 'id'],
        message: 'exchange message IDs must be unique'
      });
    }
  });

export const ClaimAgentConversationTurnInputSchema = z
  .strictObject({
    conversationId: AgentConversationIdSchema,
    agentId: ConversationAgentIdSchema,
    trustDomain: ConversationTrustDomainSchema,
    expectedVersion: z.number().int().min(1).max(MAX_EXCHANGE_EXPECTED_VERSION),
    claimId: AgentConversationTurnClaimIdSchema,
    claimedAt: AgentConversationTimestampSchema,
    expiresAt: AgentConversationTimestampSchema
  })
  .superRefine((input, context) => {
    if (input.expiresAt <= input.claimedAt) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'turn claim expiry must follow its claim timestamp'
      });
    }
  });

export const ReleaseAgentConversationTurnInputSchema = z.strictObject({
  conversationId: AgentConversationIdSchema,
  agentId: ConversationAgentIdSchema,
  trustDomain: ConversationTrustDomainSchema,
  expectedVersion: z.number().int().min(1).max(MAX_EXCHANGE_EXPECTED_VERSION),
  claimId: AgentConversationTurnClaimIdSchema
});

export const CompleteClaimedAgentExchangeInputSchema = z.strictObject({
  claimId: AgentConversationTurnClaimIdSchema,
  exchange: AppendAgentExchangeInputSchema
});

export const RequireAgentConversationInputSchema = z.strictObject({
  conversationId: AgentConversationIdSchema,
  agentId: ConversationAgentIdSchema,
  trustDomain: ConversationTrustDomainSchema,
  expectedVersion: AgentConversationCurrentVersionSchema
});

export const ListAgentMessagesInputSchema = z.strictObject({
  conversationId: AgentConversationIdSchema,
  agentId: ConversationAgentIdSchema,
  trustDomain: ConversationTrustDomainSchema,
  limit: z.number().int().min(1).max(MAX_MESSAGE_LIST)
});

const AgentConversationRecordSchema = z.strictObject({
  id: AgentConversationIdSchema,
  agentId: ConversationAgentIdSchema,
  trustDomain: ConversationTrustDomainSchema,
  title: ConversationTitleSchema.nullable(),
  version: z.number().int().min(1).max(MAX_CONVERSATION_VERSION),
  createdAt: AgentConversationTimestampSchema,
  updatedAt: AgentConversationTimestampSchema
});

const AgentMessageRecordSchema = z.strictObject({
  id: AgentMessageIdSchema,
  conversationId: AgentConversationIdSchema,
  agentId: ConversationAgentIdSchema,
  trustDomain: ConversationTrustDomainSchema,
  sequence: z.number().int().min(1).max(MAX_EXPECTED_VERSION),
  authorKind: AgentMessageAuthorKindSchema,
  respondingAgentId: ConversationAgentIdSchema.nullable(),
  responseMode: AgentMessageResponseModeSchema,
  text: AgentMessageTextSchema,
  evidenceRefs: AgentEvidenceReferencesSchema,
  createdAt: AgentConversationTimestampSchema
});

export type AgentConversationTrustDomain = z.infer<typeof ConversationTrustDomainSchema>;
export type AgentMessageResponseMode = z.infer<typeof AgentMessageResponseModeSchema>;
export type CreateAgentConversationInput = z.input<typeof CreateAgentConversationInputSchema>;
export type ListAgentConversationsInput = z.input<typeof ListAgentConversationsInputSchema>;
export type AppendAgentMessageInput = z.input<typeof AppendAgentMessageInputSchema>;
export type AppendAgentExchangeInput = z.input<typeof AppendAgentExchangeInputSchema>;
export type ClaimAgentConversationTurnInput = z.input<typeof ClaimAgentConversationTurnInputSchema>;
export type ReleaseAgentConversationTurnInput = z.input<
  typeof ReleaseAgentConversationTurnInputSchema
>;
export type CompleteClaimedAgentExchangeInput = z.input<
  typeof CompleteClaimedAgentExchangeInputSchema
>;
export type RequireAgentConversationInput = z.input<typeof RequireAgentConversationInputSchema>;
export type ListAgentMessagesInput = z.input<typeof ListAgentMessagesInputSchema>;
export type AgentConversationRecord = z.infer<typeof AgentConversationRecordSchema>;
export type AgentMessageRecord = z.infer<typeof AgentMessageRecordSchema>;

export interface AppendedAgentMessage {
  conversation: AgentConversationRecord;
  message: AgentMessageRecord;
}

export interface AppendedAgentExchange {
  conversation: AgentConversationRecord;
  operatorMessage: AgentMessageRecord;
  agentMessage: AgentMessageRecord;
}

export interface AgentConversationTurnClaim {
  conversationId: string;
  agentId: string;
  trustDomain: AgentConversationTrustDomain;
  expectedVersion: number;
  claimId: string;
  claimedAt: string;
  expiresAt: string;
}

export class AgentConversationUnavailableError extends Error {
  constructor() {
    super('Agent conversation is unavailable for the requested binding');
    this.name = 'AgentConversationUnavailableError';
  }
}

export class AgentConversationVersionConflictError extends Error {
  constructor() {
    super('Agent conversation version is stale');
    this.name = 'AgentConversationVersionConflictError';
  }
}

type ConversationDatabase = Kysely<JarvisDatabase> | Transaction<JarvisDatabase>;

function toConversation(row: Selectable<AgentConversationsTable>): AgentConversationRecord {
  return AgentConversationRecordSchema.parse({
    id: row.id,
    agentId: row.agent_id,
    trustDomain: row.trust_domain,
    title: row.title,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function parseEvidenceReferences(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Agent message evidence is invalid');
  }
  return AgentEvidenceReferencesSchema.parse(parsed);
}

function toMessage(row: Selectable<AgentMessagesTable>): AgentMessageRecord {
  return AgentMessageRecordSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    agentId: row.conversation_agent_id,
    trustDomain: row.trust_domain,
    sequence: row.sequence,
    authorKind: row.author_kind,
    respondingAgentId: row.responding_agent_id,
    responseMode: row.response_mode,
    text: row.message_text,
    evidenceRefs: parseEvidenceReferences(row.evidence_refs_json),
    createdAt: row.created_at
  });
}

async function findBoundConversation(
  database: ConversationDatabase,
  binding: { conversationId: string; agentId: string; trustDomain: AgentConversationTrustDomain }
): Promise<Selectable<AgentConversationsTable>> {
  const row = await database
    .selectFrom('agent_conversations')
    .selectAll()
    .where('id', '=', binding.conversationId)
    .where('agent_id', '=', binding.agentId)
    .where('trust_domain', '=', binding.trustDomain)
    .executeTakeFirst();
  if (row === undefined) throw new AgentConversationUnavailableError();
  return row;
}

async function requireConversationCheckpoint(
  database: ConversationDatabase,
  binding: { conversationId: string; agentId: string; trustDomain: AgentConversationTrustDomain },
  expectedVersion: number,
  expectedUpdatedAt: string
): Promise<Selectable<AgentConversationsTable>> {
  const row = await findBoundConversation(database, binding);
  if (row.version !== expectedVersion) {
    throw new AgentConversationVersionConflictError();
  }
  if (row.updated_at !== expectedUpdatedAt) {
    throw new Error('Agent conversation checkpoint does not match the appended message');
  }
  return row;
}

export class AgentConversationRepository {
  constructor(private readonly db: Kysely<JarvisDatabase>) {}

  async createConversation(rawInput: unknown): Promise<AgentConversationRecord> {
    const input = CreateAgentConversationInputSchema.parse(rawInput);
    const row = await this.db
      .insertInto('agent_conversations')
      .values({
        id: input.id,
        agent_id: input.agentId,
        trust_domain: input.trustDomain,
        title: input.title,
        version: 1,
        created_at: input.createdAt,
        updated_at: input.createdAt
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toConversation(row);
  }

  async listConversations(rawInput: unknown): Promise<AgentConversationRecord[]> {
    const input = ListAgentConversationsInputSchema.parse(rawInput);
    const rows = await this.db
      .selectFrom('agent_conversations')
      .selectAll()
      .where('agent_id', '=', input.agentId)
      .where('trust_domain', '=', input.trustDomain)
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'asc')
      .limit(input.limit)
      .execute();
    return rows.map(toConversation);
  }

  async requireConversation(rawInput: unknown): Promise<AgentConversationRecord> {
    const input = RequireAgentConversationInputSchema.parse(rawInput);
    const row = await findBoundConversation(this.db, input);
    if (row.version !== input.expectedVersion) {
      throw new AgentConversationVersionConflictError();
    }
    return toConversation(row);
  }

  async appendMessage(rawInput: unknown): Promise<AppendedAgentMessage> {
    const input = AppendAgentMessageInputSchema.parse(rawInput);
    return this.db.transaction().execute(async (transaction) => {
      const existing = await findBoundConversation(transaction, input);
      if (existing.version !== input.expectedVersion) {
        throw new AgentConversationVersionConflictError();
      }
      if (input.message.createdAt < existing.updated_at) {
        throw new Error('Agent message timestamp precedes the conversation checkpoint');
      }

      const messageRow = await transaction
        .insertInto('agent_messages')
        .values({
          id: input.message.id,
          conversation_id: input.conversationId,
          conversation_agent_id: input.agentId,
          trust_domain: input.trustDomain,
          sequence: input.expectedVersion,
          author_kind: input.message.authorKind,
          responding_agent_id: input.message.respondingAgentId,
          response_mode: input.message.responseMode,
          message_text: input.message.text,
          evidence_refs_json: JSON.stringify(input.message.evidenceRefs),
          created_at: input.message.createdAt
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const conversationRow = await requireConversationCheckpoint(
        transaction,
        input,
        input.expectedVersion + 1,
        input.message.createdAt
      );

      return { conversation: toConversation(conversationRow), message: toMessage(messageRow) };
    });
  }

  async appendExchange(rawInput: unknown): Promise<AppendedAgentExchange> {
    const input = AppendAgentExchangeInputSchema.parse(rawInput);
    return this.db.transaction().execute((transaction) => appendExchangeWithin(transaction, input));
  }

  /**
   * Reserves the single turn slot at `expectedVersion` before any paid model
   * work starts, so a concurrent stale send is refused instead of buying a
   * duplicate response that the exchange append would later discard.
   */
  async claimTurn(rawInput: unknown): Promise<AgentConversationTurnClaim> {
    const input = ClaimAgentConversationTurnInputSchema.parse(rawInput);
    const claim: AgentConversationTurnClaim = {
      conversationId: input.conversationId,
      agentId: input.agentId,
      trustDomain: input.trustDomain,
      expectedVersion: input.expectedVersion,
      claimId: input.claimId,
      claimedAt: input.claimedAt,
      expiresAt: input.expiresAt
    };

    return this.db.transaction().execute(async (transaction) => {
      const conversation = await findBoundConversation(transaction, input);
      if (conversation.version !== input.expectedVersion) {
        throw new AgentConversationVersionConflictError();
      }

      const existing = await transaction
        .selectFrom('agent_conversation_turn_claims')
        .selectAll()
        .where('conversation_id', '=', input.conversationId)
        .where('expected_version', '=', input.expectedVersion)
        .executeTakeFirst();

      if (existing === undefined) {
        await transaction
          .insertInto('agent_conversation_turn_claims')
          .values({
            conversation_id: input.conversationId,
            conversation_agent_id: input.agentId,
            trust_domain: input.trustDomain,
            expected_version: input.expectedVersion,
            claim_id: input.claimId,
            claimed_at: input.claimedAt,
            expires_at: input.expiresAt
          })
          .execute();
        return claim;
      }

      // A live claim means another turn already owns this version.
      if (existing.expires_at > input.claimedAt) {
        throw new AgentConversationVersionConflictError();
      }

      // The prior owner abandoned the lease; take it over under its own identity
      // so a concurrent takeover cannot also win.
      const takeover = await transaction
        .updateTable('agent_conversation_turn_claims')
        .set({
          claim_id: input.claimId,
          claimed_at: input.claimedAt,
          expires_at: input.expiresAt
        })
        .where('conversation_id', '=', input.conversationId)
        .where('conversation_agent_id', '=', input.agentId)
        .where('trust_domain', '=', input.trustDomain)
        .where('expected_version', '=', input.expectedVersion)
        .where('claim_id', '=', existing.claim_id)
        .where('expires_at', '<=', input.claimedAt)
        .executeTakeFirst();
      if (takeover.numUpdatedRows !== 1n) {
        throw new AgentConversationVersionConflictError();
      }
      return claim;
    });
  }

  /** Idempotent: a claim already reaped or taken over needs no release. */
  async releaseTurn(rawInput: unknown): Promise<void> {
    const input = ReleaseAgentConversationTurnInputSchema.parse(rawInput);
    await this.db
      .deleteFrom('agent_conversation_turn_claims')
      .where('conversation_id', '=', input.conversationId)
      .where('conversation_agent_id', '=', input.agentId)
      .where('trust_domain', '=', input.trustDomain)
      .where('expected_version', '=', input.expectedVersion)
      .where('claim_id', '=', input.claimId)
      .execute();
  }

  /**
   * Consumes the caller's own claim and appends the exchange in one transaction.
   * A claim lost to expiry and takeover fences this writer out entirely.
   */
  async completeClaimedExchange(rawInput: unknown): Promise<AppendedAgentExchange> {
    const input = CompleteClaimedAgentExchangeInputSchema.parse(rawInput);
    return this.db.transaction().execute(async (transaction) => {
      const consumed = await transaction
        .deleteFrom('agent_conversation_turn_claims')
        .where('conversation_id', '=', input.exchange.conversationId)
        .where('conversation_agent_id', '=', input.exchange.agentId)
        .where('trust_domain', '=', input.exchange.trustDomain)
        .where('expected_version', '=', input.exchange.expectedVersion)
        .where('claim_id', '=', input.claimId)
        .executeTakeFirst();
      if (consumed.numDeletedRows !== 1n) {
        throw new AgentConversationVersionConflictError();
      }
      return appendExchangeWithin(transaction, input.exchange);
    });
  }

  async listMessages(rawInput: unknown): Promise<AgentMessageRecord[]> {
    const input = ListAgentMessagesInputSchema.parse(rawInput);
    await findBoundConversation(this.db, input);
    const rows = await this.db
      .selectFrom('agent_messages')
      .selectAll()
      .where('conversation_id', '=', input.conversationId)
      .where('conversation_agent_id', '=', input.agentId)
      .where('trust_domain', '=', input.trustDomain)
      .orderBy('sequence', 'desc')
      .limit(input.limit)
      .execute();
    return rows.reverse().map(toMessage);
  }
}

async function appendExchangeWithin(
  transaction: Transaction<JarvisDatabase>,
  input: z.output<typeof AppendAgentExchangeInputSchema>
): Promise<AppendedAgentExchange> {
  const existing = await findBoundConversation(transaction, input);
  if (existing.version !== input.expectedVersion) {
    throw new AgentConversationVersionConflictError();
  }
  if (input.operatorMessage.createdAt < existing.updated_at) {
    throw new Error('Operator message timestamp precedes the conversation checkpoint');
  }
  if (input.agentMessage.createdAt < input.operatorMessage.createdAt) {
    throw new Error('Agent message timestamp precedes the operator message');
  }

  const operatorMessageRow = await transaction
    .insertInto('agent_messages')
    .values({
      id: input.operatorMessage.id,
      conversation_id: input.conversationId,
      conversation_agent_id: input.agentId,
      trust_domain: input.trustDomain,
      sequence: input.expectedVersion,
      author_kind: input.operatorMessage.authorKind,
      responding_agent_id: input.operatorMessage.respondingAgentId,
      response_mode: input.operatorMessage.responseMode,
      message_text: input.operatorMessage.text,
      evidence_refs_json: JSON.stringify(input.operatorMessage.evidenceRefs),
      created_at: input.operatorMessage.createdAt
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await requireConversationCheckpoint(
    transaction,
    input,
    input.expectedVersion + 1,
    input.operatorMessage.createdAt
  );

  const agentMessageRow = await transaction
    .insertInto('agent_messages')
    .values({
      id: input.agentMessage.id,
      conversation_id: input.conversationId,
      conversation_agent_id: input.agentId,
      trust_domain: input.trustDomain,
      sequence: input.expectedVersion + 1,
      author_kind: input.agentMessage.authorKind,
      responding_agent_id: input.agentMessage.respondingAgentId,
      response_mode: input.agentMessage.responseMode,
      message_text: input.agentMessage.text,
      evidence_refs_json: JSON.stringify(input.agentMessage.evidenceRefs),
      created_at: input.agentMessage.createdAt
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const conversationRow = await requireConversationCheckpoint(
    transaction,
    input,
    input.expectedVersion + 2,
    input.agentMessage.createdAt
  );

  return {
    conversation: toConversation(conversationRow),
    operatorMessage: toMessage(operatorMessageRow),
    agentMessage: toMessage(agentMessageRow)
  };
}
