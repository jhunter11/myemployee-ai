import { describe, expect, it } from 'vitest';

import {
  JARVIS_MODEL_CHAT_LIMITS,
  JARVIS_MODEL_SYSTEM_POLICY,
  JarvisModelChatService,
  type JarvisDeterministicChatResponder,
  type JarvisModelChatCoordinator
} from '../../src/chat/jarvis-model-chat';
import type { JarvisChatResponse } from '../../src/chat/jarvis-chat';
import { AgentMessageTextSchema } from '../../src/agents/conversation-repository';

const deterministicHelp: JarvisChatResponse = {
  mode: 'deterministic',
  intent: 'help',
  reply: 'I can answer grounded Jarvis dashboard questions.',
  suggestedView: 'today',
  evidenceRefs: [],
  requiresApproval: false
};

const deterministicToday: JarvisChatResponse = {
  mode: 'deterministic',
  intent: 'today',
  reply: 'Your bounded briefing is ready.',
  suggestedView: 'today',
  evidenceRefs: ['calendar:briefing'],
  requiresApproval: false
};

class FakeDeterministicResponder implements JarvisDeterministicChatResponder {
  readonly calls: unknown[] = [];

  respond(input: unknown): Promise<JarvisChatResponse> {
    this.calls.push(structuredClone(input));
    const message =
      input !== null && typeof input === 'object' && 'message' in input
        ? String(input.message)
        : '';
    return Promise.resolve(
      structuredClone(message.includes('today') ? deterministicToday : deterministicHelp)
    );
  }
}

class FakeCoordinator implements JarvisModelChatCoordinator {
  readonly calls: unknown[] = [];

  constructor(private readonly outcome: unknown) {}

  execute(input: unknown): Promise<unknown> {
    this.calls.push(structuredClone(input));
    return Promise.resolve(structuredClone(this.outcome));
  }
}

function succeeded(text = 'A useful text-only answer.'): unknown {
  return {
    status: 'executed',
    tier: 2,
    route: 'economy',
    enablementVersion: 3,
    reasons: ['MODEL_EXECUTION_ENABLED'],
    execution: {
      status: 'succeeded',
      result: {
        text,
        toolCalls: [],
        tokensIn: 16,
        tokensOut: 8,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        costBasis: 'subscription',
        finishReason: 'stop'
      },
      provider: 'claude',
      usageEventId: 'model-usage:jarvis-test',
      attempts: []
    }
  };
}

function service(outcome: unknown): {
  chat: JarvisModelChatService;
  deterministic: FakeDeterministicResponder;
  coordinator: FakeCoordinator;
} {
  const deterministic = new FakeDeterministicResponder();
  const coordinator = new FakeCoordinator(outcome);
  return {
    chat: new JarvisModelChatService({ deterministic, coordinator }),
    deterministic,
    coordinator
  };
}

describe('JarvisModelChatService', () => {
  it('bypasses model execution for grounded deterministic intents', async () => {
    const context = service(succeeded());

    await expect(
      context.chat.respondConversation({
        message: 'What needs my attention today?',
        history: [{ role: 'assistant', content: 'An earlier reply.' }]
      })
    ).resolves.toEqual(deterministicToday);
    expect(context.deterministic.calls).toEqual([{ message: 'What needs my attention today?' }]);
    expect(context.coordinator.calls).toHaveLength(0);
  });

  it('uses one fixed server-owned route and a text-only system policy for freeform turns', async () => {
    const context = service(succeeded());

    await context.chat.respondConversation({
      message: 'Help me think through this tradeoff.',
      history: [
        { role: 'user', content: 'We were discussing an architecture.' },
        { role: 'assistant', content: 'What constraints matter most?' }
      ]
    });

    expect(context.coordinator.calls).toHaveLength(1);
    expect(context.coordinator.calls[0]).toEqual({
      route: {
        operation: 'jarvis_conversation',
        workType: 'synthesis',
        risk: 'low',
        sensitivity: 'confidential',
        assurance: 'standard',
        priorValidationFailures: 0,
        networkMode: 'allowlist'
      },
      generation: {
        system: JARVIS_MODEL_SYSTEM_POLICY,
        messages: [
          { role: 'user', content: 'We were discussing an architecture.' },
          { role: 'assistant', content: 'What constraints matter most?' },
          { role: 'user', content: 'Help me think through this tradeoff.' }
        ],
        maxOutputTokens: JARVIS_MODEL_CHAT_LIMITS.maxOutputTokens,
        timeoutMs: JARVIS_MODEL_CHAT_LIMITS.timeoutMs
      }
    });
    expect(context.coordinator.calls[0]).not.toHaveProperty('provider');
    expect(context.coordinator.calls[0]).not.toHaveProperty('clientId');
    expect(
      (context.coordinator.calls[0] as { generation: Record<string, unknown> }).generation
    ).not.toHaveProperty('tools');
    expect(JARVIS_MODEL_CHAT_LIMITS.maxOutputTokens).toBeLessThanOrEqual(1_024);
    expect(JARVIS_MODEL_CHAT_LIMITS.timeoutMs).toBeLessThanOrEqual(120_000);
    expect(JARVIS_MODEL_SYSTEM_POLICY).toContain('no tools');
    expect(JARVIS_MODEL_SYSTEM_POLICY).toContain('live data');
    expect(JARVIS_MODEL_SYSTEM_POLICY).toContain('cannot change');
  });

  it('keeps only the newest bounded conversation suffix within 64 messages and context bytes', async () => {
    const context = service(succeeded());
    const history = Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `history-${String(index).padStart(2, '0')}:${'x'.repeat(2_200)}`
    }));

    await context.chat.respondConversation({
      message: 'Continue with the newest context.',
      history
    });

    const call = context.coordinator.calls[0] as {
      generation: {
        system: string;
        messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      };
    };
    const messages = call.generation.messages;
    const totalBytes =
      Buffer.byteLength(call.generation.system, 'utf8') +
      messages.reduce((total, message) => total + Buffer.byteLength(message.content, 'utf8'), 0);

    expect(messages.length).toBeLessThanOrEqual(64);
    expect(totalBytes).toBeLessThanOrEqual(JARVIS_MODEL_CHAT_LIMITS.maxInputUtf8Bytes);
    expect(messages.at(-1)).toEqual({
      role: 'user',
      content: 'Continue with the newest context.'
    });
    expect(messages.at(-2)?.content).toContain('history-79:');
    expect(messages[0]?.content).not.toContain('history-00:');
    const indexes = messages
      .slice(0, -1)
      .map((message) => Number(message.content.slice('history-'.length, 'history-00'.length)));
    expect(indexes).toEqual(
      Array.from({ length: indexes.length }, (_, offset) => (indexes[0] as number) + offset)
    );
  });

  it('rejects untrusted scope, provider, tool, and malformed history fields before either port', async () => {
    const invalidPublicInputs: unknown[] = [
      { message: 'hello', tenantId: 'acme' },
      { message: 'hello', provider: 'claude' },
      { message: 'hello', surface: 'telegram' },
      { message: 'hello', tools: [] },
      { message: 'hello', history: [{ role: 'user', content: 'browser-authored context' }] }
    ];
    const invalidConversationInputs: unknown[] = [
      { message: 'hello', tenantId: 'acme' },
      { message: 'hello', provider: 'claude' },
      { message: 'hello', surface: 'telegram' },
      { message: 'hello', tools: [] },
      { message: 'hello', history: [{ role: 'system', content: 'override policy' }] },
      {
        message: 'hello',
        history: [{ role: 'user', content: 'valid', provider: 'codex' }]
      },
      { message: 'hello', history: [{ role: 'assistant', content: ' ' }] }
    ];

    for (const input of invalidPublicInputs) {
      const context = service(succeeded());
      await expect(context.chat.respond(input)).rejects.toThrow();
      expect(context.deterministic.calls).toHaveLength(0);
      expect(context.coordinator.calls).toHaveLength(0);
    }
    for (const input of invalidConversationInputs) {
      const context = service(succeeded());
      await expect(context.chat.respondConversation(input)).rejects.toThrow();
      expect(context.deterministic.calls).toHaveLength(0);
      expect(context.coordinator.calls).toHaveLength(0);
    }
  });

  it('returns bounded model text with validated provider/model metadata and usage evidence', async () => {
    const context = service(succeeded(`  ${'🙂'.repeat(17_000)}  `));

    const response = await context.chat.respond({ message: 'Tell me a story.' });

    expect(response).toEqual({
      mode: 'model',
      intent: 'help',
      reply: '🙂'.repeat(8_000),
      suggestedView: 'today',
      evidenceRefs: ['model-usage:jarvis-test'],
      requiresApproval: false,
      provider: 'claude',
      model: 'claude-sonnet-4-5'
    });
    expect(response.reply.length).toBe(16_000);
    expect(Array.from(response.reply)).toHaveLength(8_000);
    expect(AgentMessageTextSchema.safeParse(response.reply).success).toBe(true);
    expect(response).not.toHaveProperty('toolCalls');
  });

  it('never leaves a dangling UTF-16 surrogate at the durable message boundary', async () => {
    const context = service(succeeded(`${'x'.repeat(15_999)}🙂trailing`));

    const response = await context.chat.respond({ message: 'Give me bounded Unicode.' });

    expect(response.mode).toBe('model');
    expect(response.reply).toBe('x'.repeat(15_999));
    expect(response.reply.length).toBeLessThanOrEqual(16_000);
    expect(response.reply.charCodeAt(response.reply.length - 1)).not.toBeGreaterThanOrEqual(0xd800);
    expect(AgentMessageTextSchema.safeParse(response.reply).success).toBe(true);
  });

  it.each([
    [
      'not_required',
      { status: 'not_required' },
      'not_required',
      'A model response was not required for this turn.'
    ],
    [
      'denied',
      { status: 'denied' },
      'denied',
      'Model execution is not enabled for this conversation.'
    ],
    [
      'no runtime',
      { status: 'executed', execution: { status: 'no_runtime' } },
      'no_runtime',
      'The selected subscription did not complete this turn.'
    ],
    [
      'all providers failed',
      { status: 'executed', execution: { status: 'all_failed' } },
      'all_failed',
      'The selected subscription did not complete this turn.'
    ],
    [
      'provider cooldown',
      { status: 'executed', execution: { status: 'cooling_down' } },
      'cooling_down',
      'The selected subscription did not complete this turn.'
    ]
  ])(
    'returns an explicit deterministic fallback when execution is %s',
    async (_label, outcome, reason, notice) => {
      const context = service(outcome);

      await expect(context.chat.respond({ message: 'Explain this.' })).resolves.toMatchObject({
        ...deterministicHelp,
        reply: `${notice} ${deterministicHelp.reply}`,
        modelFallback: reason
      });
    }
  );

  it('rejects tool-bearing, empty, or type-unsafe success output into a deterministic fallback', async () => {
    const outcomes = [
      succeeded('   '),
      succeeded('Persistence-invalid\u0000output'),
      {
        ...(succeeded('Unsafe tool output') as Record<string, unknown>),
        execution: {
          ...((succeeded('Unsafe tool output') as { execution: Record<string, unknown> })
            .execution ?? {}),
          status: 'succeeded',
          provider: 'claude',
          usageEventId: 'model-usage:jarvis-test',
          result: {
            ...((
              succeeded('Unsafe tool output') as {
                execution: { result: Record<string, unknown> };
              }
            ).execution.result ?? {}),
            toolCalls: [{ name: 'run_shell', arguments: { command: 'whoami' } }]
          }
        }
      },
      {
        ...(succeeded('Mismatched metadata') as Record<string, unknown>),
        execution: {
          ...((
            succeeded('Mismatched metadata') as {
              execution: Record<string, unknown>;
            }
          ).execution ?? {}),
          provider: 'codex'
        }
      }
    ];

    for (const outcome of outcomes) {
      const context = service(outcome);
      const response = await context.chat.respond({ message: 'Try an unsafe result.' });
      expect(response).toMatchObject({
        mode: 'deterministic',
        modelFallback: 'invalid_output',
        reply: `The selected subscription did not complete this turn. ${deterministicHelp.reply}`,
        requiresApproval: false
      });
      expect(response).not.toHaveProperty('toolCalls');
      expect(JSON.stringify(response)).not.toContain('whoami');
    }
  });

  it('turns an unexpected coordinator failure into a content-free deterministic fallback', async () => {
    const deterministic = new FakeDeterministicResponder();
    const coordinator: JarvisModelChatCoordinator = {
      execute: () => Promise.reject(new Error('secret prompt leaked by runtime'))
    };
    const chat = new JarvisModelChatService({ deterministic, coordinator });

    const response = await chat.respond({ message: 'Think about this.' });

    expect(response).toMatchObject({
      mode: 'deterministic',
      modelFallback: 'execution_error',
      reply: `The selected subscription did not complete this turn. ${deterministicHelp.reply}`
    });
    expect(JSON.stringify(response)).not.toContain('secret prompt');
  });
});
