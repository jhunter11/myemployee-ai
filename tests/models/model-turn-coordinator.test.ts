import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ClientRepository } from '../../src/db/client-repository';
import { createDatabase } from '../../src/db/database';
import { ModelUsageRepository } from '../../src/db/model-usage-repository';
import type { ModelExecutionEnablement } from '../../src/economics/model-execution-enablement';
import { FakeModelProvider } from '../../src/models/fake-provider';
import {
  ModelExecutor,
  type ModelExecutionInput,
  type ModelExecutionOutcome
} from '../../src/models/model-executor';
import {
  MODEL_TURN_LIMITS,
  ModelTurnCoordinator,
  type ModelTurnEnablementReader,
  type ModelTurnExecutor
} from '../../src/models/model-turn-coordinator';
import { ProviderCatalog } from '../../src/models/provider-catalog';

const SAFE_OUTPUT = 'bounded generated output';
const projectRoot = join(__dirname, '..', '..');

const successfulExecution: ModelExecutionOutcome = {
  status: 'succeeded',
  result: {
    text: SAFE_OUTPUT,
    toolCalls: [],
    tokensIn: 24,
    tokensOut: 6,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    provider: 'ollama',
    model: 'fake-local',
    costBasis: 'local',
    finishReason: 'stop'
  },
  provider: 'ollama',
  usageEventId: 'model-usage:test-0001',
  attempts: [
    {
      provider: 'ollama',
      model: 'fake-local',
      status: 'succeeded',
      detail: 'ok',
      usageEventId: 'model-usage:test-0001'
    }
  ]
};

function enabledRecord(
  overrides: Partial<ModelExecutionEnablement> = {}
): ModelExecutionEnablement {
  return {
    enabled: true,
    version: 7,
    updatedAt: '2026-07-23T18:00:00.000Z',
    updatedBy: 'principal:web_operator',
    reason: 'operator_enabled_model_execution',
    approver: 'principal:web_operator',
    approvedAt: '2026-07-23T18:00:00.000Z',
    allowedTiers: [1, 2, 3],
    allowedSurfaces: ['web'],
    allowedProviders: ['claude', 'ollama'],
    ...overrides
  };
}

function disabledRecord(version = 11): ModelExecutionEnablement {
  return {
    enabled: false,
    version,
    updatedAt: '2026-07-23T18:01:00.000Z',
    updatedBy: 'principal:web_operator',
    reason: 'operator_disabled_model_execution',
    approver: null,
    approvedAt: null,
    allowedTiers: [],
    allowedSurfaces: [],
    allowedProviders: []
  };
}

function request(
  overrides: {
    route?: Record<string, unknown>;
    generation?: Record<string, unknown>;
    outer?: Record<string, unknown>;
  } = {}
): Record<string, unknown> {
  return {
    route: {
      operation: 'status_summary',
      workType: 'summarization',
      risk: 'low',
      sensitivity: 'internal',
      assurance: 'standard',
      priorValidationFailures: 0,
      networkMode: 'allowlist',
      ...overrides.route
    },
    generation: {
      system: 'You are Jarvis.',
      messages: [{ role: 'user', content: 'very-secret-prompt' }],
      maxOutputTokens: 256,
      timeoutMs: 30_000,
      ...overrides.generation
    },
    ...overrides.outer
  };
}

class SequenceEnablementReader implements ModelTurnEnablementReader {
  readCount = 0;

  constructor(private readonly records: Array<ModelExecutionEnablement | Error>) {}

  current(): Promise<ModelExecutionEnablement> {
    const index = Math.min(this.readCount, this.records.length - 1);
    this.readCount += 1;
    const record = this.records[index];
    if (record instanceof Error) return Promise.reject(record);
    if (record === undefined) return Promise.reject(new Error('missing fake enablement record'));
    return Promise.resolve(structuredClone(record));
  }
}

class FakeExecutor implements ModelTurnExecutor {
  readonly calls: ModelExecutionInput[] = [];

  constructor(private readonly outcome: ModelExecutionOutcome = successfulExecution) {}

  execute(input: ModelExecutionInput): Promise<ModelExecutionOutcome> {
    this.calls.push(structuredClone(input));
    return Promise.resolve(structuredClone(this.outcome));
  }
}

function coordinator(options: {
  records?: Array<ModelExecutionEnablement | Error>;
  executor?: FakeExecutor;
  surface?: 'web' | 'telegram' | 'automation';
  clientId?: string | null;
}) {
  const enablement = new SequenceEnablementReader(options.records ?? [enabledRecord()]);
  const executor = options.executor ?? new FakeExecutor();
  return {
    enablement,
    executor,
    coordinator: new ModelTurnCoordinator({
      surface: options.surface ?? 'web',
      clientId: options.clientId ?? null,
      enablement,
      executor
    })
  };
}

describe('ModelTurnCoordinator', () => {
  it('binds a validated tenant once and rejects request-selected tenant/provider/surface fields', async () => {
    const executor = new FakeExecutor();
    expect(
      () =>
        new ModelTurnCoordinator({
          surface: 'web',
          clientId: '../other_tenant',
          enablement: new SequenceEnablementReader([enabledRecord()]),
          executor
        })
    ).toThrowError(
      expect.objectContaining({
        code: 'INVALID_CLIENT_SCOPE'
      })
    );

    const bound = coordinator({ executor, clientId: 'acme_corp' });
    await expect(
      bound.coordinator.execute(
        request({
          outer: {
            clientId: 'beta_labs',
            surface: 'telegram',
            allowedProviders: ['gemini']
          }
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(bound.enablement.readCount).toBe(0);
    expect(executor.calls).toHaveLength(0);
  });

  it('rejects malformed generation, unknown fields, and tools before enablement or executor I/O', async () => {
    const { coordinator: turn, enablement, executor } = coordinator({});
    const invalidRequests: Array<[Record<string, unknown>, string]> = [
      [request({ generation: { unexpected: 'field' } }), 'INVALID_REQUEST'],
      [request({ generation: { tools: [] } }), 'TOOLS_NOT_SUPPORTED'],
      [
        request({
          generation: {
            tools: [
              {
                name: 'run_shell',
                description: 'unsafe tool',
                parameters: {}
              }
            ]
          }
        }),
        'TOOLS_NOT_SUPPORTED'
      ],
      [request({ generation: { messages: [] } }), 'INVALID_REQUEST']
    ];

    for (const [raw, code] of invalidRequests) {
      await expect(turn.execute(raw)).rejects.toMatchObject({
        code
      });
    }
    expect(enablement.readCount).toBe(0);
    expect(executor.calls).toHaveLength(0);
  });

  it.each([
    [
      'total UTF-8 context',
      () =>
        request({
          generation: {
            system: '🙂'.repeat(Math.floor(MODEL_TURN_LIMITS.maxInputUtf8Bytes / 4) + 1)
          }
        }),
      'CONTEXT_LIMIT_EXCEEDED'
    ],
    [
      'output tokens',
      () =>
        request({
          generation: { maxOutputTokens: MODEL_TURN_LIMITS.maxOutputTokens + 1 }
        }),
      'OUTPUT_LIMIT_EXCEEDED'
    ],
    [
      'timeout',
      () =>
        request({
          generation: { timeoutMs: MODEL_TURN_LIMITS.maxTimeoutMs + 1 }
        }),
      'TIMEOUT_LIMIT_EXCEEDED'
    ]
  ])('enforces the fixed %s cap before any I/O', async (_label, build, code) => {
    const { coordinator: turn, enablement, executor } = coordinator({});
    await expect(turn.execute(build())).rejects.toMatchObject({ code });
    expect(enablement.readCount).toBe(0);
    expect(executor.calls).toHaveLength(0);
  });

  it('denies a trusted surface that is absent from the durable allow-list', async () => {
    const {
      coordinator: turn,
      enablement,
      executor
    } = coordinator({
      records: [enabledRecord({ allowedSurfaces: ['telegram'] })]
    });

    const outcome = await turn.execute(request());

    expect(outcome).toMatchObject({
      status: 'denied',
      tier: 1,
      route: 'local',
      enablementVersion: 7
    });
    expect(outcome.reasons).toContain('SURFACE_NOT_ENABLED');
    expect(enablement.readCount).toBe(1);
    expect(executor.calls).toHaveLength(0);
  });

  it('denies the durable disabled state with bounded, content-free reasons', async () => {
    const { coordinator: turn, executor } = coordinator({
      records: [disabledRecord()]
    });

    const outcome = await turn.execute(request());

    expect(outcome).toMatchObject({
      status: 'denied',
      tier: 1,
      route: 'local',
      enablementVersion: 11
    });
    expect(outcome.reasons).toContain('MODEL_EXECUTION_DISABLED');
    expect(outcome.reasons.length).toBeLessThanOrEqual(MODEL_TURN_LIMITS.maxReasons);
    expect(JSON.stringify(outcome)).not.toContain('very-secret-prompt');
    expect(executor.calls).toHaveLength(0);
  });

  it('denies both a disabled logical tier and blocked network policy', async () => {
    const tierDenied = coordinator({
      records: [enabledRecord({ allowedTiers: [1] })]
    });
    const tierOutcome = await tierDenied.coordinator.execute(
      request({ route: { workType: 'synthesis' } })
    );
    expect(tierOutcome.status).toBe('denied');
    expect(tierOutcome.reasons).toContain('TIER_NOT_ENABLED');
    expect(tierDenied.executor.calls).toHaveLength(0);

    const networkDenied = coordinator({});
    const networkOutcome = await networkDenied.coordinator.execute(
      request({ route: { networkMode: 'none' } })
    );
    expect(networkOutcome.status).toBe('denied');
    expect(networkOutcome.reasons).toContain('NETWORK_POLICY_BLOCKED');
    expect(networkDenied.executor.calls).toHaveLength(0);
  });

  it('returns deterministic work as not required without touching the executor', async () => {
    const {
      coordinator: turn,
      enablement,
      executor
    } = coordinator({
      records: [disabledRecord(14)]
    });

    const outcome = await turn.execute(
      request({
        route: {
          workType: 'deterministic',
          risk: 'high',
          sensitivity: 'restricted',
          assurance: 'high',
          priorValidationFailures: 2,
          networkMode: 'none'
        }
      })
    );

    expect(outcome).toEqual({
      status: 'not_required',
      fallback: 'deterministic',
      tier: 0,
      route: 'deterministic',
      enablementVersion: 14,
      reasons: ['DETERMINISTIC_IMPLEMENTATION_AVAILABLE']
    });
    expect(enablement.readCount).toBe(1);
    expect(executor.calls).toHaveLength(0);
  });

  it('executes an enabled fake turn with the bound client and durable provider allow-list only', async () => {
    const executor = new FakeExecutor();
    const { coordinator: turn, enablement } = coordinator({
      executor,
      clientId: 'acme_corp',
      records: [
        enabledRecord({
          allowedProviders: ['ollama'],
          allowedTiers: [1],
          allowedSurfaces: ['web']
        })
      ]
    });

    const outcome = await turn.execute(request());

    expect(outcome).toMatchObject({
      status: 'executed',
      tier: 1,
      route: 'local',
      enablementVersion: 7,
      execution: { status: 'succeeded', provider: 'ollama' }
    });
    expect(outcome.reasons).toEqual(['LOW_RISK_CONSTRAINED_WORK', 'MODEL_EXECUTION_ENABLED']);
    expect(enablement.readCount).toBe(2);
    expect(executor.calls).toEqual([
      {
        operation: 'summarization',
        clientId: 'acme_corp',
        route: 'local',
        generation: {
          system: 'You are Jarvis.',
          messages: [{ role: 'user', content: 'very-secret-prompt' }],
          maxOutputTokens: 256,
          timeoutMs: 30_000
        },
        allowedProviders: ['ollama']
      }
    ]);
    expect(JSON.stringify(outcome)).not.toContain('very-secret-prompt');
    expect(JSON.stringify(outcome)).toContain(SAFE_OUTPUT);
  });

  it('flows enabled text through the real executor and records one exactly scoped usage row', async () => {
    const context = await createDatabase({ projectRoot, filename: ':memory:' });
    try {
      await new ClientRepository(context.db).create({
        id: 'acme_corp',
        name: 'Acme Corporation',
        profile: 'data_processing',
        status: 'active',
        createdAt: '2026-07-23T18:00:00.000Z'
      });
      const provider = new FakeModelProvider({
        id: 'ollama',
        costBasis: 'local',
        available: true,
        routes: ['local'],
        result: { text: SAFE_OUTPUT }
      });
      const executor = new ModelExecutor({
        catalog: new ProviderCatalog([provider]),
        usage: new ModelUsageRepository(context.db),
        clock: () => 1_753_296_000_000,
        newId: () => 'model-usage:coordinator-integration'
      });
      const enablement = new SequenceEnablementReader([
        enabledRecord({
          allowedTiers: [1],
          allowedProviders: ['ollama'],
          allowedSurfaces: ['automation']
        })
      ]);
      const turn = new ModelTurnCoordinator({
        surface: 'automation',
        clientId: 'acme_corp',
        enablement,
        executor
      });

      const outcome = await turn.execute(request());

      expect(outcome).toMatchObject({
        status: 'executed',
        enablementVersion: 7,
        execution: {
          status: 'succeeded',
          provider: 'ollama',
          result: { text: SAFE_OUTPUT }
        }
      });
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]?.request).not.toHaveProperty('tools');
      expect(
        context.sqlite
          .prepare(
            `SELECT client_id, operation, provider, model, route, status, cost_basis
               FROM model_usage_events`
          )
          .all()
      ).toEqual([
        {
          client_id: 'acme_corp',
          operation: 'summarization',
          provider: 'ollama',
          model: 'fake-local',
          route: 'local',
          status: 'succeeded',
          cost_basis: 'local'
        }
      ]);

      await expect(turn.execute(request({ generation: { tools: [] } }))).rejects.toMatchObject({
        code: 'TOOLS_NOT_SUPPORTED'
      });
      expect(provider.requests).toHaveLength(1);
      expect(
        context.sqlite.prepare('SELECT COUNT(*) AS count FROM model_usage_events').get()
      ).toEqual({ count: 1 });
    } finally {
      await context.destroy();
    }
  });

  it('revalidates admission after provider probing and makes no paid call after a disable', async () => {
    const context = await createDatabase({ projectRoot, filename: ':memory:' });
    try {
      let current = enabledRecord({
        allowedTiers: [2],
        allowedProviders: ['claude'],
        allowedSurfaces: ['web']
      });
      const enablement: ModelTurnEnablementReader & { readCount: number } = {
        readCount: 0,
        current() {
          this.readCount += 1;
          return Promise.resolve(structuredClone(current));
        }
      };
      const provider = new FakeModelProvider({
        id: 'claude',
        costBasis: 'subscription',
        available: true,
        routes: ['economy']
      });
      const probe = provider.probe.bind(provider);
      vi.spyOn(provider, 'probe').mockImplementation(async () => {
        const availability = await probe();
        current = disabledRecord(8);
        return availability;
      });
      const turn = new ModelTurnCoordinator({
        surface: 'web',
        clientId: null,
        enablement,
        executor: new ModelExecutor({
          catalog: new ProviderCatalog([provider]),
          usage: new ModelUsageRepository(context.db),
          clock: () => 1_753_296_000_000,
          newId: () => 'model-usage:must-not-be-written'
        })
      });

      const outcome = await turn.execute(request({ route: { workType: 'synthesis' } }));

      expect(outcome).toEqual({
        status: 'denied',
        tier: 2,
        route: 'economy',
        enablementVersion: 8,
        reasons: ['ENABLEMENT_CHANGED']
      });
      expect(enablement.readCount).toBe(3);
      expect(provider.probeCount).toBe(1);
      expect(provider.requests).toHaveLength(0);
      expect(
        context.sqlite.prepare('SELECT COUNT(*) AS count FROM model_usage_events').get()
      ).toEqual({ count: 0 });
    } finally {
      await context.destroy();
    }
  });

  it('fails closed on an enablement read error without returning prompt bytes', async () => {
    const executor = new FakeExecutor();
    const { coordinator: turn, enablement } = coordinator({
      executor,
      records: [new Error('database unavailable: very-secret-prompt')]
    });

    const outcome = await turn.execute(request());

    expect(outcome).toEqual({
      status: 'denied',
      tier: 1,
      route: 'local',
      enablementVersion: null,
      reasons: ['ENABLEMENT_UNAVAILABLE']
    });
    expect(JSON.stringify(outcome)).not.toContain('very-secret-prompt');
    expect(enablement.readCount).toBe(1);
    expect(executor.calls).toHaveLength(0);
  });

  it.each([
    ['disable', disabledRecord(8)],
    ['version', enabledRecord({ version: 8 })],
    ['tier allow-list', enabledRecord({ allowedTiers: [2] })],
    ['provider allow-list', enabledRecord({ allowedProviders: ['ollama'] })],
    ['surface allow-list', enabledRecord({ allowedSurfaces: ['telegram'] })]
  ])('fences a %s change immediately before the executor call', async (_label, changed) => {
    const executor = new FakeExecutor();
    const { coordinator: turn, enablement } = coordinator({
      executor,
      records: [enabledRecord(), changed]
    });

    const outcome = await turn.execute(request());

    expect(outcome).toMatchObject({
      status: 'denied',
      enablementVersion: changed.version,
      reasons: ['ENABLEMENT_CHANGED']
    });
    expect(enablement.readCount).toBe(2);
    expect(executor.calls).toHaveLength(0);
  });
});
