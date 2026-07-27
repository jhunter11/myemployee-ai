import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { JarvisChatResponse } from '../chat/jarvis-chat';
import {
  AgentConversationExpectedVersionSchema,
  AgentEvidenceReferenceSchema,
  AgentMessageTextSchema,
  ConversationTitleSchema,
  type AgentConversationRecord,
  type AgentConversationRepository,
  type AgentMessageRecord,
  type AgentMessageResponseMode
} from './conversation-repository';
import {
  findAgentProfile,
  listAgentProfiles,
  projectAgentHierarchy,
  type AgentProfile
} from './profile-catalog';

/** Bounded lease so an abandoned turn cannot wedge a conversation forever. */
const TURN_CLAIM_LEASE_MS = 630_000;

export const CreateAgentConversationRequestSchema = z.strictObject({
  title: z.string().trim().pipe(ConversationTitleSchema).optional()
});

export const SendAgentConversationMessageRequestSchema = z.strictObject({
  message: z.string().trim().max(2_000).pipe(AgentMessageTextSchema),
  expectedVersion: AgentConversationExpectedVersionSchema
});

export type CreateAgentConversationRequest = z.infer<typeof CreateAgentConversationRequestSchema>;
export type SendAgentConversationMessageRequest = z.infer<
  typeof SendAgentConversationMessageRequestSchema
>;

export interface AgentConversationReply {
  respondingAgentId: string;
  responseMode: Exclude<AgentMessageResponseMode, 'operator_input'>;
  text: string;
  evidenceRefs: string[];
  suggestedView: JarvisChatResponse['suggestedView'] | null;
}

export interface AgentConversationExchange {
  conversation: AgentConversationRecord;
  operatorMessage: AgentMessageRecord;
  reply: AgentConversationReply;
  agentMessage: AgentMessageRecord;
}

export interface JarvisConversationHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface JarvisResponder {
  respond(input: unknown): Promise<JarvisChatResponse>;
  respondConversation?(input: {
    message: string;
    history: JarvisConversationHistoryMessage[];
  }): Promise<JarvisChatResponse>;
}

interface ConversationRepositoryPort {
  createConversation(input: unknown): Promise<AgentConversationRecord>;
  listConversations(input: unknown): Promise<AgentConversationRecord[]>;
  requireConversation(input: unknown): Promise<AgentConversationRecord>;
  claimTurn(input: unknown): Promise<unknown>;
  releaseTurn(input: unknown): Promise<void>;
  completeClaimedExchange(input: unknown): Promise<{
    conversation: AgentConversationRecord;
    operatorMessage: AgentMessageRecord;
    agentMessage: AgentMessageRecord;
  }>;
  listMessages(input: unknown): Promise<AgentMessageRecord[]>;
}

export class AgentProfileNotFoundError extends Error {
  constructor() {
    super('Agent profile was not found');
    this.name = 'AgentProfileNotFoundError';
  }
}

export interface AgentProfileResolver {
  findAgentProfile(agentId: string): AgentProfile | undefined | Promise<AgentProfile | undefined>;
}

function resolveStaticProfile(agentId: string): AgentProfile {
  const profile = findAgentProfile(agentId);
  if (profile === undefined) throw new AgentProfileNotFoundError();
  return profile;
}

async function resolveProfile(
  agentId: string,
  instanceResolver: AgentProfileResolver | undefined
): Promise<AgentProfile> {
  const staticProfile = findAgentProfile(agentId);
  if (staticProfile !== undefined) return staticProfile;
  const instanceProfile = await instanceResolver?.findAgentProfile(agentId);
  if (instanceProfile === undefined) throw new AgentProfileNotFoundError();
  return instanceProfile;
}

function profileEvidence(profile: AgentProfile): string[] {
  return [`profile:${profile.id}@${profile.revision}`];
}

function boundedEvidenceReferences(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const references: string[] = [];
  const seen = new Set<string>();
  for (const candidate of input) {
    const parsed = AgentEvidenceReferenceSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data)) continue;
    seen.add(parsed.data);
    references.push(parsed.data);
    if (references.length === 32) break;
  }
  return references;
}

function profileReply(profile: AgentProfile, rawMessage: string): AgentConversationReply {
  const message = rawMessage.toLowerCase();
  const sections: string[] = [];
  const isProfileInspection =
    /\bprofile\b/iu.test(message) ||
    /^(?:what|which|who|describe|explain|list|show|tell|how|are|is|do|does|can)\b/iu.test(
      message.trim()
    ) ||
    message.trim().endsWith('?');

  if (!isProfileInspection) {
    return {
      respondingAgentId: profile.id,
      responseMode: 'runtime_not_configured',
      text: `${profile.displayName} did not run this request. Its execution runtime is not configured for work from this conversation. Profile inspection remains available, and no tool or external action was performed.`,
      evidenceRefs: profileEvidence(profile),
      suggestedView: null
    };
  }

  const asksIdentity = /\b(?:who|identity|purpose|role|responsibilit|what are you)\b/iu.test(
    message
  );
  const asksTools =
    /\b(?:tools?|grants?|capabilit(?:y|ies)|what can you do|authority|permissions?)\b/iu.test(
      message
    );
  const asksMemory = /\b(?:memory|scope|sleeve|knowledge|partition|context)\b/iu.test(message);
  const asksContinuation =
    /\b(?:continu|checkpoint|resume|stage|handoff|complete|escalat|budget)\b/iu.test(message);
  const asksRuntime = /\b(?:runtime|available|availability|configured|status|online)\b/iu.test(
    message
  );

  if (asksIdentity) {
    sections.push(`${profile.displayName} is ${profile.role}. Purpose: ${profile.purpose}`);
  }
  if (asksTools) {
    sections.push(
      `Tools: ${profile.toolGrants
        .map((grant) => `${grant.id} (${grant.access})`)
        .join(', ')}. Tool authority is fixed by the server profile.`
    );
  }
  if (asksMemory) {
    sections.push(
      `Memory and scope: scratch sleeve ${profile.memory.scratchSleeveId}; readable sleeves ${profile.memory.readableSleeveIds.join(', ')}; propose-writable sleeves ${profile.memory.proposeWritableSleeveIds.join(', ') || 'none'}; knowledge scope ${profile.knowledge.scopeId}.`
    );
  }
  if (asksContinuation) {
    sections.push(
      `Continuation: ${profile.continuation.stages.map(({ label }) => label).join(' → ')}. Checkpoints occur ${profile.continuation.checkpoint.trigger.replaceAll('_', ' ')}; uncertainty stops and escalates to ${profile.continuation.escalation.target}.`
    );
  }
  if (asksRuntime) {
    sections.push(
      `Runtime: ${profile.runtimeMode.replaceAll('_', ' ')}; availability is ${profile.availability.state.replaceAll('_', ' ')}.`
    );
  }

  if (sections.length === 0) {
    return {
      respondingAgentId: profile.id,
      responseMode: 'runtime_not_configured',
      text: `${profile.displayName} did not run this request. Its execution runtime is not configured for work from this conversation. Profile inspection remains available, and no tool or external action was performed.`,
      evidenceRefs: profileEvidence(profile),
      suggestedView: null
    };
  }

  return {
    respondingAgentId: profile.id,
    responseMode: 'profile',
    text: `${sections.join('\n\n')}\n\nProfile information only; no tool or work ran.`,
    evidenceRefs: profileEvidence(profile),
    suggestedView: null
  };
}

/**
 * Resolves trust domains and capabilities exclusively from the immutable
 * server-owned catalog. Conversation text can request work, but cannot select
 * a scope, tenant, tool grant, or responding agent.
 */
export class AgentConversationService {
  private readonly repository: ConversationRepositoryPort;
  private readonly jarvisResponder: JarvisResponder;
  private readonly profileResolver: AgentProfileResolver | undefined;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(options: {
    repository: AgentConversationRepository | ConversationRepositoryPort;
    jarvisResponder: JarvisResponder;
    profileResolver?: AgentProfileResolver;
    now?: () => string;
    idFactory?: () => string;
  }) {
    this.repository = options.repository;
    this.jarvisResponder = options.jarvisResponder;
    this.profileResolver = options.profileResolver;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  directorySnapshot(): {
    profiles: readonly AgentProfile[];
    hierarchy: ReturnType<typeof projectAgentHierarchy>;
  } {
    return {
      profiles: listAgentProfiles(),
      hierarchy: projectAgentHierarchy()
    };
  }

  async createConversation(agentId: string, rawInput: unknown): Promise<AgentConversationRecord> {
    const profile = await resolveProfile(agentId, this.profileResolver);
    const input = CreateAgentConversationRequestSchema.parse(rawInput);
    return this.repository.createConversation({
      id: `conversation:${this.idFactory()}`,
      agentId: profile.id,
      trustDomain: profile.trustDomain,
      title: input.title ?? null,
      createdAt: this.now()
    });
  }

  async listConversations(agentId: string): Promise<AgentConversationRecord[]> {
    const profile = await resolveProfile(agentId, this.profileResolver);
    return this.repository.listConversations({
      agentId: profile.id,
      trustDomain: profile.trustDomain,
      limit: 100
    });
  }

  async listMessages(agentId: string, conversationId: string): Promise<AgentMessageRecord[]> {
    const profile = await resolveProfile(agentId, this.profileResolver);
    return this.repository.listMessages({
      conversationId,
      agentId: profile.id,
      trustDomain: profile.trustDomain,
      limit: 200
    });
  }

  async sendMessage(
    agentId: string,
    conversationId: string,
    rawInput: unknown
  ): Promise<AgentConversationExchange> {
    const profile = await resolveProfile(agentId, this.profileResolver);
    const input = SendAgentConversationMessageRequestSchema.parse(rawInput);
    const turn = {
      conversationId,
      agentId: profile.id,
      trustDomain: profile.trustDomain,
      expectedVersion: input.expectedVersion
    };
    await this.repository.requireConversation(turn);

    // Reserve this version before responding. A model turn is paid work, so a
    // concurrent stale send must be refused up front rather than answered twice
    // and then discarded by the exchange append.
    const claimedAt = this.now();
    const claimId = `turn-claim:${this.idFactory()}`;
    await this.repository.claimTurn({
      ...turn,
      claimId,
      claimedAt,
      expiresAt: new Date(Date.parse(claimedAt) + TURN_CLAIM_LEASE_MS).toISOString()
    });

    try {
      const reply =
        profile.id === 'jarvis'
          ? await this.jarvisReply(input.message, conversationId, profile)
          : profileReply(profile, input.message);
      const exchange = await this.repository.completeClaimedExchange({
        claimId,
        exchange: {
          ...turn,
          operatorMessage: {
            id: `message:${this.idFactory()}`,
            authorKind: 'operator',
            respondingAgentId: null,
            responseMode: 'operator_input',
            text: input.message,
            evidenceRefs: [],
            createdAt: this.now()
          },
          agentMessage: {
            id: `message:${this.idFactory()}`,
            authorKind: 'agent',
            respondingAgentId: profile.id,
            responseMode: reply.responseMode,
            text: reply.text,
            evidenceRefs: reply.evidenceRefs,
            createdAt: this.now()
          }
        }
      });
      return {
        conversation: exchange.conversation,
        operatorMessage: exchange.operatorMessage,
        reply,
        agentMessage: exchange.agentMessage
      };
    } catch (error) {
      // Free the slot for a retry. A claim already consumed or taken over
      // deletes nothing, and a release failure must not mask the real error.
      await this.repository.releaseTurn({ ...turn, claimId }).catch(() => undefined);
      throw error;
    }
  }

  private async jarvisReply(
    message: string,
    conversationId: string,
    profile: AgentProfile
  ): Promise<AgentConversationReply> {
    if (
      /\b(?:agent tree|agents?|subagents?|hierarchy|profiles?|mcp|x402|developer|idea generator)\b/iu.test(
        message
      )
    ) {
      const profiles = listAgentProfiles();
      const durableCount = profiles.filter(({ lifecycle }) => lifecycle === 'durable').length;
      return {
        respondingAgentId: 'jarvis',
        responseMode: 'deterministic',
        text: `I coordinate two separate child domains: Agency and MCP/x402. The installed registry contains ${profiles.length} profiles: ${durableCount} durable coordinators and ${profiles.length - durableCount} bounded templates. Agency covers coordination, development, ideas, growth, delivery, knowledge improvement, finance evidence, and marketing planning. MCP/x402 covers contract publishing, simulation-only seller readiness, task-market scouting, and settlement auditing. This is a catalog synthesis only; I do not inherit child transcripts or private scopes without an explicit reviewed handoff.`,
        evidenceRefs: ['jarvis', 'agency', 'mcp-x402'].flatMap((id) =>
          profileEvidence(resolveStaticProfile(id))
        ),
        suggestedView: 'agency'
      };
    }
    const response =
      this.jarvisResponder.respondConversation === undefined
        ? await this.jarvisResponder.respond({ message })
        : await this.jarvisResponder.respondConversation({
            message,
            history: (
              await this.repository.listMessages({
                conversationId,
                agentId: profile.id,
                trustDomain: profile.trustDomain,
                limit: 64
              })
            ).map((record) => ({
              role: record.authorKind === 'operator' ? ('user' as const) : ('assistant' as const),
              content: record.text
            }))
          });
    return {
      respondingAgentId: 'jarvis',
      responseMode: response.mode,
      text: response.reply,
      evidenceRefs: boundedEvidenceReferences(response.evidenceRefs),
      suggestedView: response.suggestedView
    };
  }
}
