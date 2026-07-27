import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentConversationRepository,
  AgentConversationUnavailableError,
  AgentConversationVersionConflictError
} from '../../src/agents/conversation-repository';
import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';

const projectRoot = join(__dirname, '..', '..');
const createdAt = '2026-07-21T12:00:00.000Z';
const laterAt = '2026-07-21T12:01:00.000Z';

describe('AgentConversationRepository', () => {
  let temporaryRoot: string;
  let filename: string;
  let context: GlobalDatabaseContext;
  let repository: AgentConversationRepository;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-agent-conversations-'));
    filename = join(temporaryRoot, 'jarvis.sqlite');
    context = await createDatabase({ projectRoot, filename });
    repository = new AgentConversationRepository(context.db);
  });

  afterEach(async () => {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('creates exact-agent conversations and lists them in bounded deterministic order', async () => {
    await repository.createConversation({
      id: 'conversation:jarvis-older',
      agentId: 'jarvis',
      trustDomain: 'personal',
      title: 'Older conversation',
      createdAt
    });
    await repository.createConversation({
      id: 'conversation:jarvis-newer-b',
      agentId: 'jarvis',
      trustDomain: 'personal',
      title: null,
      createdAt: laterAt
    });
    await repository.createConversation({
      id: 'conversation:jarvis-newer-a',
      agentId: 'jarvis',
      trustDomain: 'personal',
      title: 'Same timestamp',
      createdAt: laterAt
    });
    await repository.createConversation({
      id: 'conversation:agency-private',
      agentId: 'agency',
      trustDomain: 'agency',
      title: 'Agency only',
      createdAt: laterAt
    });

    await expect(
      repository.listConversations({ agentId: 'jarvis', trustDomain: 'personal', limit: 2 })
    ).resolves.toEqual([
      {
        id: 'conversation:jarvis-newer-a',
        agentId: 'jarvis',
        trustDomain: 'personal',
        title: 'Same timestamp',
        version: 1,
        createdAt: laterAt,
        updatedAt: laterAt
      },
      expect.objectContaining({ id: 'conversation:jarvis-newer-b', title: null })
    ]);
    await expect(
      repository.listConversations({ agentId: 'jarvis', trustDomain: 'agency', limit: 10 })
    ).resolves.toEqual([]);
  });

  it('rejects malformed, extensible, oversized, and duplicate conversation records', async () => {
    await expect(
      repository.createConversation({
        id: 'conversation:untitled-record',
        agentId: 'jarvis',
        trustDomain: 'personal',
        createdAt
      })
    ).resolves.toMatchObject({ title: null });
    const base = {
      id: 'conversation:strict-record',
      agentId: 'jarvis',
      trustDomain: 'personal' as const,
      title: 'Strict record',
      createdAt
    };

    await expect(repository.createConversation({ ...base, extra: 'forbidden' })).rejects.toThrow();
    await expect(
      repository.createConversation({ ...base, title: `x${'y'.repeat(160)}` })
    ).rejects.toThrow();
    await expect(repository.createConversation({ ...base, id: 'strict-record' })).rejects.toThrow();
    await expect(
      repository.createConversation({ ...base, trustDomain: 'client' as 'personal' })
    ).rejects.toThrow();

    await repository.createConversation(base);
    await expect(repository.createConversation(base)).rejects.toThrow();
    await expect(
      repository.listConversations({ agentId: 'jarvis', trustDomain: 'personal', limit: 0 })
    ).rejects.toThrow();
  });

  it('appends operator and exact responding-agent provenance while incrementing versions', async () => {
    await repository.createConversation({
      id: 'conversation:jarvis-roundtrip',
      agentId: 'jarvis',
      trustDomain: 'personal',
      title: 'Round trip',
      createdAt
    });

    const first = await repository.appendMessage({
      conversationId: 'conversation:jarvis-roundtrip',
      agentId: 'jarvis',
      trustDomain: 'personal',
      expectedVersion: 1,
      message: {
        id: 'message:operator-001',
        authorKind: 'operator',
        respondingAgentId: null,
        responseMode: 'operator_input',
        text: 'What is on my calendar?',
        evidenceRefs: [],
        createdAt
      }
    });
    const second = await repository.appendMessage({
      conversationId: 'conversation:jarvis-roundtrip',
      agentId: 'jarvis',
      trustDomain: 'personal',
      expectedVersion: 2,
      message: {
        id: 'message:jarvis-001',
        authorKind: 'agent',
        respondingAgentId: 'jarvis',
        responseMode: 'deterministic',
        text: 'Your next event begins at 14:00.',
        evidenceRefs: ['calendar:event-123', 'calendar:briefing'],
        createdAt: laterAt
      }
    });

    expect(first.conversation.version).toBe(2);
    expect(first.message).toMatchObject({ sequence: 1, respondingAgentId: null });
    expect(second.conversation).toMatchObject({ version: 3, updatedAt: laterAt });
    expect(second.message).toMatchObject({
      sequence: 2,
      respondingAgentId: 'jarvis',
      responseMode: 'deterministic',
      evidenceRefs: ['calendar:event-123', 'calendar:briefing']
    });

    await expect(
      repository.listMessages({
        conversationId: 'conversation:jarvis-roundtrip',
        agentId: 'jarvis',
        trustDomain: 'personal',
        limit: 10
      })
    ).resolves.toEqual([first.message, second.message]);
  });

  it('appends an operator and exact-agent exchange atomically with one version precondition', async () => {
    await repository.createConversation({
      id: 'conversation:atomic-exchange',
      agentId: 'jarvis',
      trustDomain: 'personal',
      title: 'Atomic exchange',
      createdAt
    });

    await expect(
      repository.requireConversation({
        conversationId: 'conversation:atomic-exchange',
        agentId: 'jarvis',
        trustDomain: 'personal',
        expectedVersion: 1
      })
    ).resolves.toMatchObject({ id: 'conversation:atomic-exchange', version: 1 });

    const exchange = await repository.appendExchange({
      conversationId: 'conversation:atomic-exchange',
      agentId: 'jarvis',
      trustDomain: 'personal',
      expectedVersion: 1,
      operatorMessage: {
        id: 'message:exchange-operator',
        authorKind: 'operator',
        respondingAgentId: null,
        responseMode: 'operator_input',
        text: 'Summarize today.',
        evidenceRefs: [],
        createdAt
      },
      agentMessage: {
        id: 'message:exchange-agent',
        authorKind: 'agent',
        respondingAgentId: 'jarvis',
        responseMode: 'deterministic',
        text: 'Today has three scheduled events.',
        evidenceRefs: ['calendar:today'],
        createdAt: laterAt
      }
    });

    expect(exchange.conversation).toMatchObject({ version: 3, updatedAt: laterAt });
    expect(exchange.operatorMessage).toMatchObject({
      id: 'message:exchange-operator',
      sequence: 1,
      authorKind: 'operator'
    });
    expect(exchange.agentMessage).toMatchObject({
      id: 'message:exchange-agent',
      sequence: 2,
      authorKind: 'agent',
      respondingAgentId: 'jarvis'
    });
    await expect(
      repository.listMessages({
        conversationId: 'conversation:atomic-exchange',
        agentId: 'jarvis',
        trustDomain: 'personal',
        limit: 10
      })
    ).resolves.toEqual([exchange.operatorMessage, exchange.agentMessage]);
    await expect(
      repository.requireConversation({
        conversationId: 'conversation:atomic-exchange',
        agentId: 'jarvis',
        trustDomain: 'personal',
        expectedVersion: 1
      })
    ).rejects.toBeInstanceOf(AgentConversationVersionConflictError);
  });

  it('rolls back the whole exchange when its second message insert fails', async () => {
    await repository.createConversation({
      id: 'conversation:exchange-rollback',
      agentId: 'jarvis',
      trustDomain: 'personal',
      title: null,
      createdAt
    });
    await repository.appendMessage({
      conversationId: 'conversation:exchange-rollback',
      agentId: 'jarvis',
      trustDomain: 'personal',
      expectedVersion: 1,
      message: {
        id: 'message:existing-agent-id',
        authorKind: 'agent',
        respondingAgentId: 'jarvis',
        responseMode: 'profile',
        text: 'Existing response.',
        evidenceRefs: [],
        createdAt
      }
    });

    await expect(
      repository.appendExchange({
        conversationId: 'conversation:exchange-rollback',
        agentId: 'jarvis',
        trustDomain: 'personal',
        expectedVersion: 2,
        operatorMessage: {
          id: 'message:must-roll-back',
          authorKind: 'operator',
          respondingAgentId: null,
          responseMode: 'operator_input',
          text: 'This must not become a half turn.',
          evidenceRefs: [],
          createdAt: laterAt
        },
        agentMessage: {
          id: 'message:existing-agent-id',
          authorKind: 'agent',
          respondingAgentId: 'jarvis',
          responseMode: 'deterministic',
          text: 'Duplicate primary key forces the second insert to fail.',
          evidenceRefs: [],
          createdAt: laterAt
        }
      })
    ).rejects.toThrow();

    await expect(
      repository.requireConversation({
        conversationId: 'conversation:exchange-rollback',
        agentId: 'jarvis',
        trustDomain: 'personal',
        expectedVersion: 2
      })
    ).resolves.toMatchObject({ version: 2, updatedAt: createdAt });
    await expect(
      repository.listMessages({
        conversationId: 'conversation:exchange-rollback',
        agentId: 'jarvis',
        trustDomain: 'personal',
        limit: 10
      })
    ).resolves.toEqual([expect.objectContaining({ id: 'message:existing-agent-id', sequence: 1 })]);
  });

  it('rejects malformed exchanges and preflight bindings without writing either turn', async () => {
    await repository.createConversation({
      id: 'conversation:strict-exchange',
      agentId: 'agency-developer',
      trustDomain: 'agency',
      title: null,
      createdAt
    });
    const base = {
      conversationId: 'conversation:strict-exchange',
      agentId: 'agency-developer',
      trustDomain: 'agency' as const,
      expectedVersion: 1,
      operatorMessage: {
        id: 'message:strict-operator',
        authorKind: 'operator' as const,
        respondingAgentId: null,
        responseMode: 'operator_input' as const,
        text: 'Review this.',
        evidenceRefs: [],
        createdAt
      },
      agentMessage: {
        id: 'message:strict-agent',
        authorKind: 'agent' as const,
        respondingAgentId: 'agency-developer',
        responseMode: 'deterministic' as const,
        text: 'Review complete.',
        evidenceRefs: [],
        createdAt: laterAt
      }
    };

    await expect(
      repository.appendExchange({
        ...base,
        agentMessage: { ...base.agentMessage, respondingAgentId: 'agency' }
      })
    ).rejects.toThrow();
    await expect(repository.appendExchange({ ...base, extra: 'forbidden' })).rejects.toThrow();
    await expect(
      repository.requireConversation({
        conversationId: base.conversationId,
        agentId: 'agency',
        trustDomain: 'agency',
        expectedVersion: 1
      })
    ).rejects.toBeInstanceOf(AgentConversationUnavailableError);
    await expect(
      repository.requireConversation({
        conversationId: base.conversationId,
        agentId: base.agentId,
        trustDomain: base.trustDomain,
        expectedVersion: 1,
        extra: 'forbidden'
      })
    ).rejects.toThrow();
    await expect(
      repository.listConversations({
        agentId: base.agentId,
        trustDomain: base.trustDomain,
        limit: 10
      })
    ).resolves.toEqual([expect.objectContaining({ version: 1 })]);
    await expect(repository.listMessages({ ...base, limit: 10 })).rejects.toThrow();
    await expect(
      repository.listMessages({
        conversationId: base.conversationId,
        agentId: base.agentId,
        trustDomain: base.trustDomain,
        limit: 10
      })
    ).resolves.toEqual([]);
  });

  it('persists transcripts across database reloads', async () => {
    await repository.createConversation({
      id: 'conversation:reload-proof',
      agentId: 'agency-developer',
      trustDomain: 'agency',
      title: 'Reload proof',
      createdAt
    });
    await repository.appendMessage({
      conversationId: 'conversation:reload-proof',
      agentId: 'agency-developer',
      trustDomain: 'agency',
      expectedVersion: 1,
      message: {
        id: 'message:reload-001',
        authorKind: 'agent',
        respondingAgentId: 'agency-developer',
        responseMode: 'profile',
        text: 'I can describe my purpose without claiming a configured runtime.',
        evidenceRefs: ['profile:agency-developer@1'],
        createdAt
      }
    });

    await context.destroy();
    context = await createDatabase({ projectRoot, filename });
    repository = new AgentConversationRepository(context.db);

    await expect(
      repository.listMessages({
        conversationId: 'conversation:reload-proof',
        agentId: 'agency-developer',
        trustDomain: 'agency',
        limit: 10
      })
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'message:reload-001',
        respondingAgentId: 'agency-developer',
        responseMode: 'profile'
      })
    ]);
  });

  it('returns the newest bounded transcript window in chronological order', async () => {
    await repository.createConversation({
      id: 'conversation:bounded-window',
      agentId: 'jarvis',
      trustDomain: 'personal',
      title: 'Bounded window',
      createdAt
    });
    for (let index = 1; index <= 202; index += 1) {
      const timestamp = new Date(Date.parse(createdAt) + index).toISOString();
      await repository.appendMessage({
        conversationId: 'conversation:bounded-window',
        agentId: 'jarvis',
        trustDomain: 'personal',
        expectedVersion: index,
        message: {
          id: `message:bounded-${String(index).padStart(3, '0')}`,
          authorKind: 'operator',
          respondingAgentId: null,
          responseMode: 'operator_input',
          text: `Bounded message ${index}`,
          evidenceRefs: [],
          createdAt: timestamp
        }
      });
    }

    const messages = await repository.listMessages({
      conversationId: 'conversation:bounded-window',
      agentId: 'jarvis',
      trustDomain: 'personal',
      limit: 200
    });
    expect(messages).toHaveLength(200);
    expect(messages[0]).toMatchObject({ sequence: 3, text: 'Bounded message 3' });
    expect(messages.at(-1)).toMatchObject({ sequence: 202, text: 'Bounded message 202' });
  });

  it('rejects stale writes and duplicate message IDs without partially advancing state', async () => {
    await repository.createConversation({
      id: 'conversation:versioned-append',
      agentId: 'jarvis',
      trustDomain: 'personal',
      title: null,
      createdAt
    });
    const firstInput = {
      conversationId: 'conversation:versioned-append',
      agentId: 'jarvis',
      trustDomain: 'personal' as const,
      expectedVersion: 1,
      message: {
        id: 'message:versioned-001',
        authorKind: 'operator' as const,
        respondingAgentId: null,
        responseMode: 'operator_input' as const,
        text: 'First message',
        evidenceRefs: [],
        createdAt
      }
    };
    await repository.appendMessage(firstInput);

    await expect(
      repository.appendMessage({
        ...firstInput,
        message: { ...firstInput.message, id: 'message:stale-append', text: 'Stale' }
      })
    ).rejects.toBeInstanceOf(AgentConversationVersionConflictError);
    await expect(
      repository.appendMessage({
        ...firstInput,
        expectedVersion: 2,
        message: { ...firstInput.message, text: 'Duplicate ID' }
      })
    ).rejects.toThrow();

    await expect(
      repository.listConversations({ agentId: 'jarvis', trustDomain: 'personal', limit: 10 })
    ).resolves.toEqual([expect.objectContaining({ version: 2 })]);
    await expect(
      repository.listMessages({
        conversationId: firstInput.conversationId,
        agentId: 'jarvis',
        trustDomain: 'personal',
        limit: 10
      })
    ).resolves.toHaveLength(1);
  });

  it('reserves one turn per version and refuses a concurrent claim on the same version', async () => {
    await repository.createConversation({
      id: 'conversation:turn-claim',
      agentId: 'jarvis',
      trustDomain: 'personal',
      title: 'Turn claim',
      createdAt
    });
    const binding = {
      conversationId: 'conversation:turn-claim',
      agentId: 'jarvis',
      trustDomain: 'personal' as const,
      expectedVersion: 1
    };

    await expect(
      repository.claimTurn({
        ...binding,
        claimId: 'turn-claim:first',
        claimedAt: createdAt,
        expiresAt: laterAt
      })
    ).resolves.toMatchObject({ claimId: 'turn-claim:first', expectedVersion: 1 });

    await expect(
      repository.claimTurn({
        ...binding,
        claimId: 'turn-claim:concurrent',
        claimedAt: createdAt,
        expiresAt: laterAt
      })
    ).rejects.toBeInstanceOf(AgentConversationVersionConflictError);

    // A claim on a version the conversation has not reached is equally stale.
    await expect(
      repository.claimTurn({
        ...binding,
        expectedVersion: 2,
        claimId: 'turn-claim:ahead',
        claimedAt: createdAt,
        expiresAt: laterAt
      })
    ).rejects.toBeInstanceOf(AgentConversationVersionConflictError);
  });

  it('releases an abandoned turn, allows expiry takeover, and fences the displaced writer', async () => {
    await repository.createConversation({
      id: 'conversation:turn-lease',
      agentId: 'jarvis',
      trustDomain: 'personal',
      title: 'Turn lease',
      createdAt
    });
    const conversation = {
      conversationId: 'conversation:turn-lease',
      agentId: 'jarvis',
      trustDomain: 'personal' as const
    };
    const binding = { ...conversation, expectedVersion: 1 };

    await repository.claimTurn({
      ...binding,
      claimId: 'turn-claim:abandoned',
      claimedAt: createdAt,
      expiresAt: laterAt
    });

    // An explicit release frees the slot immediately, and repeats are harmless.
    await repository.releaseTurn({ ...binding, claimId: 'turn-claim:abandoned' });
    await repository.releaseTurn({ ...binding, claimId: 'turn-claim:abandoned' });

    await repository.claimTurn({
      ...binding,
      claimId: 'turn-claim:retry',
      claimedAt: laterAt,
      expiresAt: '2026-07-21T12:02:00.000Z'
    });

    // A lapsed lease is taken over only after it expires, never before.
    await expect(
      repository.claimTurn({
        ...binding,
        claimId: 'turn-claim:too-early',
        claimedAt: '2026-07-21T12:01:30.000Z',
        expiresAt: '2026-07-21T12:05:00.000Z'
      })
    ).rejects.toBeInstanceOf(AgentConversationVersionConflictError);

    await expect(
      repository.claimTurn({
        ...binding,
        claimId: 'turn-claim:takeover',
        claimedAt: '2026-07-21T12:02:00.000Z',
        expiresAt: '2026-07-21T12:12:00.000Z'
      })
    ).resolves.toMatchObject({ claimId: 'turn-claim:takeover' });

    const exchange = {
      ...binding,
      operatorMessage: {
        id: 'message:lease-operator',
        authorKind: 'operator' as const,
        respondingAgentId: null,
        responseMode: 'operator_input' as const,
        text: 'Run this once.',
        evidenceRefs: [],
        createdAt: '2026-07-21T12:03:00.000Z'
      },
      agentMessage: {
        id: 'message:lease-agent',
        authorKind: 'agent' as const,
        respondingAgentId: 'jarvis',
        responseMode: 'model' as const,
        text: 'The only paid response.',
        evidenceRefs: ['model-usage:lease'],
        createdAt: '2026-07-21T12:03:00.000Z'
      }
    };

    // The displaced writer no longer owns the slot and must not append.
    await expect(
      repository.completeClaimedExchange({ claimId: 'turn-claim:retry', exchange })
    ).rejects.toBeInstanceOf(AgentConversationVersionConflictError);
    await expect(repository.listMessages({ ...conversation, limit: 10 })).resolves.toEqual([]);

    await expect(
      repository.completeClaimedExchange({ claimId: 'turn-claim:takeover', exchange })
    ).resolves.toMatchObject({ conversation: { version: 3 } });

    // Completing consumed the claim, so replaying it cannot duplicate the turn.
    await expect(
      repository.completeClaimedExchange({ claimId: 'turn-claim:takeover', exchange })
    ).rejects.toBeInstanceOf(AgentConversationVersionConflictError);
    await expect(repository.listMessages({ ...conversation, limit: 10 })).resolves.toHaveLength(2);
  });

  it('restores the claim when a completed exchange rolls back so the turn can be retried', async () => {
    await repository.createConversation({
      id: 'conversation:turn-rollback',
      agentId: 'jarvis',
      trustDomain: 'personal',
      title: 'Turn rollback',
      createdAt
    });
    const conversation = {
      conversationId: 'conversation:turn-rollback',
      agentId: 'jarvis',
      trustDomain: 'personal' as const
    };
    const binding = { ...conversation, expectedVersion: 1 };
    await repository.claimTurn({
      ...binding,
      claimId: 'turn-claim:rollback',
      claimedAt: createdAt,
      expiresAt: laterAt
    });

    await expect(
      repository.completeClaimedExchange({
        claimId: 'turn-claim:rollback',
        exchange: {
          ...binding,
          operatorMessage: {
            id: 'message:rollback-operator',
            authorKind: 'operator',
            respondingAgentId: null,
            responseMode: 'operator_input',
            text: 'This turn must not half-commit.',
            evidenceRefs: [],
            createdAt
          },
          agentMessage: {
            id: 'message:rollback-operator',
            authorKind: 'agent',
            respondingAgentId: 'jarvis',
            responseMode: 'model',
            text: 'Duplicate message identifier.',
            evidenceRefs: [],
            createdAt
          }
        }
      })
    ).rejects.toThrow();

    await expect(repository.listMessages({ ...conversation, limit: 10 })).resolves.toEqual([]);
    // The rolled-back delete left the claim intact, so the owner still holds it.
    await expect(
      repository.claimTurn({
        ...binding,
        claimId: 'turn-claim:stealer',
        claimedAt: createdAt,
        expiresAt: laterAt
      })
    ).rejects.toBeInstanceOf(AgentConversationVersionConflictError);
  });

  it('allows the final bounded append without overflowing the conversation version', async () => {
    context.sqlite
      .prepare(
        `
          INSERT INTO agent_conversations
            (id, agent_id, trust_domain, title, version, created_at, updated_at)
          VALUES ('conversation:max-version', 'jarvis', 'personal', NULL, 2147483646, ?, ?)
        `
      )
      .run(createdAt, createdAt);

    const appended = await repository.appendMessage({
      conversationId: 'conversation:max-version',
      agentId: 'jarvis',
      trustDomain: 'personal',
      expectedVersion: 2_147_483_646,
      message: {
        id: 'message:max-version',
        authorKind: 'agent',
        respondingAgentId: 'jarvis',
        responseMode: 'deterministic',
        text: 'Final bounded append.',
        evidenceRefs: [],
        createdAt
      }
    });

    expect(appended.conversation.version).toBe(2_147_483_647);
    expect(appended.message.sequence).toBe(2_147_483_646);
    await expect(
      repository.appendMessage({
        conversationId: 'conversation:max-version',
        agentId: 'jarvis',
        trustDomain: 'personal',
        expectedVersion: 2_147_483_647,
        message: {
          id: 'message:version-overflow',
          authorKind: 'operator',
          respondingAgentId: null,
          responseMode: 'operator_input',
          text: 'Must not overflow.',
          evidenceRefs: [],
          createdAt
        }
      })
    ).rejects.toThrow();
    await expect(
      repository.listMessages({
        conversationId: 'conversation:max-version',
        agentId: 'jarvis',
        trustDomain: 'personal',
        limit: 10
      })
    ).resolves.toEqual([appended.message]);
  });

  it('fails closed for guessed conversations, mismatched agents, and mismatched trust domains', async () => {
    await repository.createConversation({
      id: 'conversation:exact-binding',
      agentId: 'agency-developer',
      trustDomain: 'agency',
      title: 'Exact binding',
      createdAt
    });

    for (const binding of [
      {
        conversationId: 'conversation:missing-binding',
        agentId: 'agency-developer',
        trustDomain: 'agency' as const
      },
      {
        conversationId: 'conversation:exact-binding',
        agentId: 'agency-idea-generator',
        trustDomain: 'agency' as const
      },
      {
        conversationId: 'conversation:exact-binding',
        agentId: 'agency-developer',
        trustDomain: 'task_market' as const
      }
    ]) {
      await expect(repository.listMessages({ ...binding, limit: 10 })).rejects.toEqual(
        new AgentConversationUnavailableError()
      );
      await expect(
        repository.appendMessage({
          ...binding,
          expectedVersion: 1,
          message: {
            id: 'message:denied-binding',
            authorKind: 'operator',
            respondingAgentId: null,
            responseMode: 'operator_input',
            text: 'Do not append this.',
            evidenceRefs: [],
            createdAt
          }
        })
      ).rejects.toEqual(new AgentConversationUnavailableError());
    }
  });

  it('rejects invalid author, responder, response-mode, evidence, and message text contracts', async () => {
    await repository.createConversation({
      id: 'conversation:strict-message',
      agentId: 'jarvis',
      trustDomain: 'personal',
      title: null,
      createdAt
    });
    const base = {
      conversationId: 'conversation:strict-message',
      agentId: 'jarvis',
      trustDomain: 'personal' as const,
      expectedVersion: 1,
      message: {
        id: 'message:strict-001',
        authorKind: 'agent' as const,
        respondingAgentId: 'jarvis',
        responseMode: 'deterministic' as const,
        text: 'Bounded response',
        evidenceRefs: ['calendar:briefing'],
        createdAt
      }
    };

    await expect(
      repository.appendMessage({
        ...base,
        message: { ...base.message, respondingAgentId: 'agency' }
      })
    ).rejects.toThrow();
    await expect(
      repository.appendMessage({
        ...base,
        message: { ...base.message, responseMode: 'operator_input' }
      })
    ).rejects.toThrow();
    await expect(
      repository.appendMessage({
        ...base,
        message: {
          ...base.message,
          evidenceRefs: ['calendar:briefing', 'calendar:briefing']
        }
      })
    ).rejects.toThrow();
    await expect(
      repository.appendMessage({
        ...base,
        message: { ...base.message, text: 'x'.repeat(16_001) }
      })
    ).rejects.toThrow();
    await expect(
      repository.appendMessage({
        ...base,
        message: { ...base.message, extra: 'forbidden' }
      })
    ).rejects.toThrow();
  });

  it('makes messages append-only and prevents conversation identity deletion at SQLite', async () => {
    await repository.createConversation({
      id: 'conversation:append-only',
      agentId: 'jarvis',
      trustDomain: 'personal',
      title: null,
      createdAt
    });
    await repository.appendMessage({
      conversationId: 'conversation:append-only',
      agentId: 'jarvis',
      trustDomain: 'personal',
      expectedVersion: 1,
      message: {
        id: 'message:append-only',
        authorKind: 'operator',
        respondingAgentId: null,
        responseMode: 'operator_input',
        text: 'Immutable',
        evidenceRefs: [],
        createdAt
      }
    });

    expect(() =>
      context.sqlite
        .prepare('UPDATE agent_messages SET message_text = ? WHERE id = ?')
        .run('changed', 'message:append-only')
    ).toThrow(/append-only/i);
    expect(() =>
      context.sqlite.prepare('DELETE FROM agent_messages WHERE id = ?').run('message:append-only')
    ).toThrow(/append-only/i);
    expect(() =>
      context.sqlite
        .prepare('DELETE FROM agent_conversations WHERE id = ?')
        .run('conversation:append-only')
    ).toThrow(/cannot be deleted/i);
    expect(repository).not.toHaveProperty('delete');
    expect(repository).not.toHaveProperty('update');
  });
});
