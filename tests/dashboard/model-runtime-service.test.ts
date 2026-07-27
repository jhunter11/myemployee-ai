import { describe, expect, it, vi } from 'vitest';

import {
  DashboardModelRuntimeDisableRequestSchema,
  DashboardModelRuntimeSelectionRequestSchema,
  DashboardModelRuntimeService,
  ModelRuntimeProviderConnectionRequiredError,
  ModelRuntimeVersionConflictError
} from '../../src/dashboard/model-runtime-service';
import type {
  SubscriptionRuntimeStatus,
  SubscriptionProviderId
} from '../../src/models/subscription-runtime';
import type { ModelExecutionEnablement } from '../../src/economics/model-execution-enablement';

const now = '2026-07-23T20:00:00.000Z';

function connected(provider: SubscriptionProviderId): SubscriptionRuntimeStatus {
  return {
    provider,
    connectionState: 'connected',
    loginAvailable: true,
    loginInProgress: false,
    detail:
      provider === 'claude' ? 'Claude subscription connected.' : 'OpenAI subscription connected.'
  };
}

function disconnected(provider: SubscriptionProviderId): SubscriptionRuntimeStatus {
  return {
    provider,
    connectionState: 'disconnected',
    loginAvailable: true,
    loginInProgress: false,
    detail:
      provider === 'claude'
        ? 'Claude subscription login required.'
        : 'OpenAI subscription login required.'
  };
}

function disabledEnablement(version = 1): ModelExecutionEnablement {
  return {
    enabled: false,
    version,
    updatedAt: now,
    updatedBy: 'system:bootstrap',
    reason: 'runtime_state_initialized',
    approver: null,
    approvedAt: null,
    allowedTiers: [] as Array<1 | 2 | 3>,
    allowedSurfaces: [] as Array<'web' | 'telegram' | 'automation'>,
    allowedProviders: [] as Array<'claude' | 'codex' | 'gemini' | 'ollama'>
  };
}

function service(options?: {
  enablement?: ModelExecutionEnablement;
  statuses?: SubscriptionRuntimeStatus[];
}) {
  let current = options?.enablement ?? disabledEnablement();
  const enable = vi.fn((input: unknown) => {
    const request = input as {
      approver: string;
      reason: string;
      allowedTiers: Array<1 | 2 | 3>;
      allowedSurfaces: Array<'web' | 'telegram' | 'automation'>;
      allowedProviders: Array<'claude' | 'codex' | 'gemini' | 'ollama'>;
      expectedVersion: number;
    };
    if (request.expectedVersion !== current.version) {
      return Promise.reject(new Error('model execution enablement version conflict'));
    }
    current = {
      enabled: true,
      version: current.version + 1,
      updatedAt: now,
      updatedBy: request.approver,
      reason: request.reason,
      approver: request.approver,
      approvedAt: now,
      allowedTiers: request.allowedTiers,
      allowedSurfaces: request.allowedSurfaces,
      allowedProviders: request.allowedProviders
    };
    return Promise.resolve(current);
  });
  const disable = vi.fn((input: unknown) => {
    const request = input as { updatedBy: string; reason: string; expectedVersion: number };
    if (request.expectedVersion !== current.version) {
      return Promise.reject(new Error('model execution enablement version conflict'));
    }
    current = {
      ...disabledEnablement(current.version + 1),
      updatedBy: request.updatedBy,
      reason: request.reason
    };
    return Promise.resolve(current);
  });
  const statuses = options?.statuses ?? [connected('claude'), connected('openai')];
  const subscriptions = {
    snapshot: vi.fn(() => Promise.resolve(statuses)),
    status: vi.fn((provider: SubscriptionProviderId) =>
      Promise.resolve(
        statuses.find((candidate) => candidate.provider === provider) ?? disconnected(provider)
      )
    ),
    startLogin: vi.fn((provider: SubscriptionProviderId) =>
      Promise.resolve({
        provider,
        outcome: 'started' as const,
        detail: 'Subscription login started'
      })
    )
  };
  return {
    runtime: new DashboardModelRuntimeService({
      enablement: {
        current: () => Promise.resolve(current),
        enable,
        disable
      },
      subscriptions
    }),
    enable,
    disable,
    subscriptions
  };
}

describe('DashboardModelRuntimeService', () => {
  it('returns only bounded public provider state and maps internal codex selection to OpenAI', async () => {
    const enablement: ModelExecutionEnablement = {
      enabled: true,
      version: 8,
      updatedAt: now,
      updatedBy: 'principal:web_operator',
      reason: 'dashboard_subscription_selected',
      approver: 'principal:web_operator',
      approvedAt: now,
      allowedTiers: [2],
      allowedSurfaces: ['web'],
      allowedProviders: ['codex']
    };
    const { runtime } = service({ enablement });

    await expect(runtime.snapshot()).resolves.toEqual({
      enabled: true,
      version: 8,
      selectedProvider: 'openai',
      providers: [connected('claude'), connected('openai')]
    });
  });

  it('fails closed over malformed runtime status instead of returning dependency text', async () => {
    const secret = 'credential-output-must-not-reach-dashboard';
    const runtime = new DashboardModelRuntimeService({
      enablement: {
        current: () => Promise.resolve(disabledEnablement()),
        enable: () => Promise.reject(new Error('not used')),
        disable: () => Promise.reject(new Error('not used'))
      },
      subscriptions: {
        snapshot: () =>
          Promise.resolve([
            {
              provider: 'claude',
              connectionState: 'connected',
              loginAvailable: true,
              loginInProgress: false,
              detail: secret,
              rawToken: secret
            }
          ] as never),
        status: () => Promise.reject(new Error('not used')),
        startLogin: () => Promise.reject(new Error('not used'))
      }
    });

    const snapshot = await runtime.snapshot();

    expect(snapshot.providers).toEqual([
      {
        provider: 'claude',
        connectionState: 'check_failed',
        loginAvailable: false,
        loginInProgress: false,
        detail: 'Claude subscription status could not be verified.'
      },
      {
        provider: 'openai',
        connectionState: 'check_failed',
        loginAvailable: false,
        loginInProgress: false,
        detail: 'OpenAI subscription status could not be verified.'
      }
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
  });

  it('selects one connected subscription with server-owned tier, surface, actor, and reason', async () => {
    const { runtime, enable } = service();

    await expect(runtime.select({ provider: 'openai', expectedVersion: 1 })).resolves.toMatchObject(
      {
        enabled: true,
        version: 2,
        selectedProvider: 'openai'
      }
    );
    expect(enable).toHaveBeenCalledWith({
      approver: 'principal:web_operator',
      reason: 'dashboard_subscription_selected',
      allowedTiers: [2],
      allowedSurfaces: ['web'],
      allowedProviders: ['codex'],
      expectedVersion: 1
    });
  });

  it('requires a verified subscription connection and never treats presence alone as authority', async () => {
    const { runtime, enable } = service({
      statuses: [disconnected('claude'), connected('openai')]
    });

    await expect(runtime.select({ provider: 'claude', expectedVersion: 1 })).rejects.toBeInstanceOf(
      ModelRuntimeProviderConnectionRequiredError
    );
    expect(enable).not.toHaveBeenCalled();
  });

  it('durably disables all model execution with server-owned audit fields', async () => {
    const { runtime, disable } = service({
      enablement: {
        enabled: true,
        version: 3,
        updatedAt: now,
        updatedBy: 'principal:web_operator',
        reason: 'dashboard_subscription_selected',
        approver: 'principal:web_operator',
        approvedAt: now,
        allowedTiers: [2],
        allowedSurfaces: ['web'],
        allowedProviders: ['claude']
      }
    });

    await expect(runtime.disable({ expectedVersion: 3 })).resolves.toMatchObject({
      enabled: false,
      version: 4,
      selectedProvider: null
    });
    expect(disable).toHaveBeenCalledWith({
      updatedBy: 'principal:web_operator',
      reason: 'dashboard_subscription_disabled',
      expectedVersion: 3
    });
  });

  it('starts only the fixed provider login and reports optimistic conflicts as typed errors', async () => {
    const { runtime, subscriptions } = service();

    await expect(runtime.startLogin('claude')).resolves.toEqual({
      provider: 'claude',
      outcome: 'started',
      detail: 'Claude subscription login started.'
    });
    expect(subscriptions.startLogin).toHaveBeenCalledWith('claude');
    await expect(
      runtime.select({ provider: 'openai', expectedVersion: 999 })
    ).rejects.toBeInstanceOf(ModelRuntimeVersionConflictError);
  });

  it('strictly rejects browser attempts to widen provider authority', () => {
    expect(() =>
      DashboardModelRuntimeSelectionRequestSchema.parse({
        provider: 'claude',
        expectedVersion: 1,
        allowedProviders: ['claude', 'codex'],
        allowedTiers: [2, 3],
        surface: 'automation',
        tenantId: 'acme_corp',
        approver: 'operator:spoofed'
      })
    ).toThrow();
    expect(() =>
      DashboardModelRuntimeDisableRequestSchema.parse({
        expectedVersion: 1,
        reason: 'browser supplied'
      })
    ).toThrow();
  });
});
