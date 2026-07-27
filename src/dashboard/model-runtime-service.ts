import { z } from 'zod';

import type {
  ModelExecutionEnablement,
  ModelExecutionEnablementService
} from '../economics/model-execution-enablement';
import {
  SubscriptionLoginResultSchema,
  SubscriptionProviderSchema,
  SubscriptionRuntimeStatusSchema,
  type SubscriptionLoginResult,
  type SubscriptionProviderId,
  type SubscriptionRuntimePort,
  type SubscriptionRuntimeService,
  type SubscriptionRuntimeStatus
} from '../models/subscription-runtime';

const MODEL_RUNTIME_ACTOR = 'principal:web_operator';
const VERSION_CONFLICT_FRAGMENT = 'model execution enablement version conflict';

export const DashboardModelRuntimeSelectionRequestSchema = z.strictObject({
  provider: SubscriptionProviderSchema,
  expectedVersion: z.number().int().min(1).max(2_147_483_646)
});

export const DashboardModelRuntimeDisableRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1).max(2_147_483_646)
});

export type DashboardModelRuntimeSelectionRequest = z.infer<
  typeof DashboardModelRuntimeSelectionRequestSchema
>;
export type DashboardModelRuntimeDisableRequest = z.infer<
  typeof DashboardModelRuntimeDisableRequestSchema
>;

export interface DashboardModelRuntimeSnapshot {
  enabled: boolean;
  version: number;
  selectedProvider: SubscriptionProviderId | null;
  providers: SubscriptionRuntimeStatus[];
}

interface ModelEnablementPort {
  current(): Promise<ModelExecutionEnablement>;
  enable(input: unknown): Promise<ModelExecutionEnablement>;
  disable(input: unknown): Promise<ModelExecutionEnablement>;
}

export class ModelRuntimeProviderConnectionRequiredError extends Error {
  constructor() {
    super('A verified provider subscription login is required');
    this.name = 'ModelRuntimeProviderConnectionRequiredError';
  }
}

export class ModelRuntimeVersionConflictError extends Error {
  constructor() {
    super('Model runtime selection changed; refresh before retrying');
    this.name = 'ModelRuntimeVersionConflictError';
  }
}

function internalProvider(provider: SubscriptionProviderId): 'claude' | 'codex' {
  return provider === 'openai' ? 'codex' : 'claude';
}

function providerLabel(provider: SubscriptionProviderId): 'Claude' | 'OpenAI' {
  return provider === 'claude' ? 'Claude' : 'OpenAI';
}

function canonicalStatus(
  provider: SubscriptionProviderId,
  raw: unknown
): SubscriptionRuntimeStatus {
  const parsed = SubscriptionRuntimeStatusSchema.safeParse(raw);
  if (!parsed.success || parsed.data.provider !== provider) {
    return {
      provider,
      connectionState: 'check_failed',
      loginAvailable: false,
      loginInProgress: false,
      detail: `${providerLabel(provider)} subscription status could not be verified.`
    };
  }
  const { connectionState, loginAvailable, loginInProgress } = parsed.data;
  const detail =
    connectionState === 'connected'
      ? `${providerLabel(provider)} subscription connected.`
      : connectionState === 'disconnected'
        ? `${providerLabel(provider)} subscription login required.`
        : connectionState === 'unavailable'
          ? `${providerLabel(provider)} subscription login is unavailable on this host.`
          : `${providerLabel(provider)} subscription status could not be verified.`;
  return { provider, connectionState, loginAvailable, loginInProgress, detail };
}

function canonicalLoginResult(
  provider: SubscriptionProviderId,
  raw: unknown
): SubscriptionLoginResult {
  const parsed = SubscriptionLoginResultSchema.safeParse(raw);
  if (!parsed.success || parsed.data.provider !== provider) {
    return {
      provider,
      outcome: 'unavailable',
      detail: `${providerLabel(provider)} subscription login is unavailable on this host.`
    };
  }
  const detail =
    parsed.data.outcome === 'started'
      ? `${providerLabel(provider)} subscription login started.`
      : parsed.data.outcome === 'already_in_progress'
        ? `${providerLabel(provider)} subscription login is already in progress.`
        : `${providerLabel(provider)} subscription login is unavailable on this host.`;
  return { provider, outcome: parsed.data.outcome, detail };
}

function publicProvider(enablement: ModelExecutionEnablement): SubscriptionProviderId | null {
  if (
    !enablement.enabled ||
    enablement.allowedTiers.length !== 1 ||
    enablement.allowedTiers[0] !== 2 ||
    enablement.allowedSurfaces.length !== 1 ||
    enablement.allowedSurfaces[0] !== 'web' ||
    enablement.allowedProviders.length !== 1
  ) {
    return null;
  }
  const provider = enablement.allowedProviders[0];
  if (provider === 'claude') return 'claude';
  return provider === 'codex' ? 'openai' : null;
}

function rethrowVersionConflict(error: unknown): never {
  if (error instanceof Error && error.message.includes(VERSION_CONFLICT_FRAGMENT)) {
    throw new ModelRuntimeVersionConflictError();
  }
  throw error;
}

/**
 * Loopback-dashboard facade over the durable execution gate.
 *
 * Browser input can select only a public provider and an optimistic version.
 * The actor, reason, logical tier, surface, and exact internal provider
 * allow-list are fixed here and cannot be widened by request text.
 */
export class DashboardModelRuntimeService {
  private readonly enablement: ModelEnablementPort;
  private readonly subscriptions: SubscriptionRuntimePort;

  constructor(options: {
    enablement: ModelExecutionEnablementService | ModelEnablementPort;
    subscriptions: SubscriptionRuntimeService | SubscriptionRuntimePort;
  }) {
    this.enablement = options.enablement;
    this.subscriptions = options.subscriptions;
  }

  async snapshot(): Promise<DashboardModelRuntimeSnapshot> {
    const [enablement, rawProviders] = await Promise.all([
      this.enablement.current(),
      this.subscriptions.snapshot()
    ]);
    const providers = (['claude', 'openai'] as const).map((provider) =>
      canonicalStatus(
        provider,
        rawProviders.find((candidate) => candidate?.provider === provider)
      )
    );
    return {
      enabled: enablement.enabled,
      version: enablement.version,
      selectedProvider: publicProvider(enablement),
      providers
    };
  }

  async startLogin(rawProvider: unknown): Promise<SubscriptionLoginResult> {
    const provider = SubscriptionProviderSchema.parse(rawProvider);
    return canonicalLoginResult(provider, await this.subscriptions.startLogin(provider));
  }

  async select(rawInput: unknown): Promise<DashboardModelRuntimeSnapshot> {
    const input = DashboardModelRuntimeSelectionRequestSchema.parse(rawInput);
    const status = canonicalStatus(input.provider, await this.subscriptions.status(input.provider));
    if (status.connectionState !== 'connected') {
      throw new ModelRuntimeProviderConnectionRequiredError();
    }
    try {
      await this.enablement.enable({
        approver: MODEL_RUNTIME_ACTOR,
        reason: 'dashboard_subscription_selected',
        allowedTiers: [2],
        allowedSurfaces: ['web'],
        allowedProviders: [internalProvider(input.provider)],
        expectedVersion: input.expectedVersion
      });
    } catch (error) {
      rethrowVersionConflict(error);
    }
    return this.snapshot();
  }

  async disable(rawInput: unknown): Promise<DashboardModelRuntimeSnapshot> {
    const input = DashboardModelRuntimeDisableRequestSchema.parse(rawInput);
    try {
      await this.enablement.disable({
        updatedBy: MODEL_RUNTIME_ACTOR,
        reason: 'dashboard_subscription_disabled',
        expectedVersion: input.expectedVersion
      });
    } catch (error) {
      rethrowVersionConflict(error);
    }
    return this.snapshot();
  }
}
