import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { ClientIdSchema } from '../config/schemas';
import {
  ModelOperationSchema,
  ModelRouteSchema,
  type ModelUsageRepository
} from '../db/model-usage-repository';
import {
  ModelGenerationRequestSchema,
  ModelGenerationResultSchema,
  type ModelGenerationRequest,
  type ModelGenerationResult,
  type ModelProvider,
  type ModelProviderId,
  type ModelTierRoute,
  ProviderError
} from './contracts';
import type { ProviderCatalog } from './provider-catalog';
import type {
  ProviderRateLimitCircuit,
  ProviderRateLimitClaim
} from './provider-rate-limit-circuit';

/** The content-free operation label carried into `model_usage_events`. */
export type ModelOperation =
  'classification' | 'extraction' | 'drafting' | 'summarization' | 'synthesis' | 'code' | 'review';

export interface ModelExecutionInput {
  operation: ModelOperation;
  clientId: string | null;
  route: ModelTierRoute;
  generation: ModelGenerationRequest;
  /**
   * The providers the operator has authorized in the enablement record. Deny-first:
   * a provider that is available but not on this allow-list is never attempted.
   */
  allowedProviders: ModelProviderId[];
}

const ModelExecutionInputSchema = z.strictObject({
  operation: ModelOperationSchema,
  clientId: ClientIdSchema.nullable(),
  route: ModelRouteSchema,
  generation: ModelGenerationRequestSchema,
  allowedProviders: z.array(z.enum(['claude', 'codex', 'gemini', 'ollama'])).max(4)
});

export const PROVIDER_CLAIM_COMPLETION_GRACE_MS = 30_000;
export const MAX_MODEL_RESULT_TEXT_BYTES = 1_048_576;

export interface ModelExecutionAttempt {
  provider: ModelProviderId;
  model: string;
  status: 'succeeded' | 'failed' | 'timeout';
  /** Secret-free reason; never carries prompt/completion/response bytes. */
  detail: string;
  usageEventId: string;
}

export type ModelExecutionOutcome =
  | {
      status: 'succeeded';
      result: ModelGenerationResult;
      provider: ModelProviderId;
      usageEventId: string;
      attempts: ModelExecutionAttempt[];
    }
  | {
      /**
       * Generation succeeded, but its mandatory usage event could not be
       * confirmed. The unmetered result is withheld and no other provider is
       * attempted, preventing both an unaccounted response and duplicate spend.
       */
      status: 'metering_failed';
      provider: ModelProviderId;
      model: string;
      attempts: ModelExecutionAttempt[];
    }
  | { status: 'admission_revoked'; attempts: ModelExecutionAttempt[] }
  | { status: 'all_failed'; attempts: ModelExecutionAttempt[] }
  | { status: 'cooling_down'; retryAt: number; attempts: ModelExecutionAttempt[] }
  | { status: 'no_runtime'; attempts: ModelExecutionAttempt[] };

/**
 * A per-turn kill-switch fence supplied by the trusted coordinator. The
 * executor invokes it after provider probes and immediately before each real
 * generation call.
 */
export interface ModelExecutionAdmissionFence {
  readonly enablementVersion: number;
  revalidate(enablementVersion: number): Promise<boolean>;
}

const MAX_LATENCY_MS = 86_400_000;

export interface ModelExecutorDeps {
  catalog: ProviderCatalog;
  usage: ModelUsageRepository;
  /** Durable provider-wide cooldown state. Omit only in isolated tests/tools. */
  rateLimitCircuit?: ProviderRateLimitCircuit;
  /** Epoch-millisecond clock, injected for deterministic tests. */
  clock?: () => number;
  /** Usage-event id factory, injected for deterministic tests. */
  newId?: () => string;
}

/**
 * Turns a router-approved logical route into a real, metered model call. It never
 * decides *whether* a model may run — that gate is the operator enablement record
 * consulted upstream by `routeModelWork()`. It enforces the provider allow-list
 * (deny-first), attempts the catalog's ordered candidates with graceful call-time
 * fall-through, and writes exactly one `model_usage_events` row per attempt with
 * the serving provider's label and cost basis (subscription = NULL, local = 0).
 * When no authorized provider is available it returns `no_runtime` and NEVER
 * fabricates a reply (SPEC §15, briefing).
 */
export class ModelExecutor {
  private readonly clock: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: ModelExecutorDeps) {
    this.clock = deps.clock ?? Date.now;
    this.newId = deps.newId ?? (() => `model-usage:${randomUUID()}`);
  }

  async execute(
    input: ModelExecutionInput,
    admission?: ModelExecutionAdmissionFence
  ): Promise<ModelExecutionOutcome> {
    const validated = ModelExecutionInputSchema.parse(input);
    const claimLeaseMs = this.claimLeaseMs(validated.generation.timeoutMs);
    const allowed = new Set(validated.allowedProviders);
    const { candidates } = await this.deps.catalog.resolve(allowed);
    const ordered = candidates[validated.route].filter((provider) => allowed.has(provider.id));

    if (ordered.length === 0) {
      return { status: 'no_runtime', attempts: [] };
    }

    const attempts: ModelExecutionAttempt[] = [];
    const coolingRetryTimes: number[] = [];
    for (const provider of ordered) {
      const circuitClaim = this.claimProvider(provider.id, claimLeaseMs);
      if (!circuitClaim.allowed) {
        if (circuitClaim.retryAt !== null) coolingRetryTimes.push(circuitClaim.retryAt);
        continue;
      }

      if (!(await this.admissionAllowed(admission))) {
        this.releaseClaim(provider.id, circuitClaim);
        return { status: 'admission_revoked', attempts };
      }

      const model = provider.modelForRoute(validated.route);
      const startedAt = this.clock();
      let result: ModelGenerationResult;
      try {
        const generated = await provider.generate(validated.route, validated.generation);
        result = this.validateResult(provider, model, validated.generation, generated);
      } catch (error) {
        this.completeFailedClaim(provider.id, circuitClaim, error);
        const latencyMs = this.elapsed(startedAt);
        const kind = error instanceof ProviderError ? error.kind : 'runtime';
        const status = kind === 'timeout' ? 'timeout' : 'failed';
        const usageEventId = await this.meter({
          provider,
          model,
          route: validated.route,
          operation: validated.operation,
          clientId: validated.clientId,
          status,
          latencyMs,
          tokensIn: null,
          tokensOut: null,
          cacheReadTokens: null,
          cacheWriteTokens: null
        });
        attempts.push({
          provider: provider.id,
          model,
          status,
          detail: this.sanitize(error),
          usageEventId
        });
        // Fall through to the next authorized candidate.
        continue;
      }

      this.completeSuccessfulClaim(provider.id, circuitClaim);
      const latencyMs = this.elapsed(startedAt);
      let usageEventId: string;
      try {
        usageEventId = await this.meter({
          provider,
          model: result.model,
          route: validated.route,
          operation: validated.operation,
          clientId: validated.clientId,
          status: 'succeeded',
          latencyMs,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          cacheReadTokens: result.cacheReadTokens,
          cacheWriteTokens: result.cacheWriteTokens
        });
      } catch {
        return {
          status: 'metering_failed',
          provider: provider.id,
          model: result.model,
          attempts
        };
      }
      attempts.push({
        provider: provider.id,
        model: result.model,
        status: 'succeeded',
        detail: 'ok',
        usageEventId
      });
      return { status: 'succeeded', result, provider: provider.id, usageEventId, attempts };
    }
    if (attempts.length === 0 && coolingRetryTimes.length === ordered.length) {
      const retryAt = Math.min(...coolingRetryTimes);
      return { status: 'cooling_down', retryAt, attempts };
    }
    return attempts.length === 0
      ? { status: 'no_runtime', attempts }
      : { status: 'all_failed', attempts };
  }

  private async admissionAllowed(admission: ModelExecutionAdmissionFence | undefined) {
    if (admission === undefined) return true;
    if (!Number.isSafeInteger(admission.enablementVersion) || admission.enablementVersion < 1) {
      return false;
    }
    try {
      return (await admission.revalidate(admission.enablementVersion)) === true;
    } catch {
      return false;
    }
  }

  private claimProvider(provider: ModelProviderId, leaseMs: number): ProviderRateLimitClaim {
    if (provider === 'ollama' || this.deps.rateLimitCircuit === undefined) {
      return {
        allowed: true,
        halfOpen: false,
        retryAt: null,
        claimToken: null
      };
    }
    try {
      const claim = this.deps.rateLimitCircuit.claim(provider, leaseMs);
      if (
        !claim.allowed &&
        (claim.retryAt === null || !Number.isSafeInteger(claim.retryAt) || claim.retryAt < 0)
      ) {
        return {
          allowed: false,
          halfOpen: false,
          retryAt: null,
          claimToken: null
        };
      }
      if (
        claim.allowed &&
        claim.halfOpen &&
        (claim.claimToken === null ||
          !Number.isSafeInteger(claim.claimToken) ||
          claim.claimToken < 0)
      ) {
        return {
          allowed: false,
          halfOpen: false,
          retryAt: null,
          claimToken: null
        };
      }
      return claim;
    } catch {
      // A missing/corrupt cooldown store must not cause subscription hammering.
      // Fail this provider closed and continue to the next authorized candidate.
      return {
        allowed: false,
        halfOpen: false,
        retryAt: null,
        claimToken: null
      };
    }
  }

  private validateResult(
    provider: ModelProvider,
    expectedModel: string,
    request: ModelGenerationRequest,
    resultInput: unknown
  ): ModelGenerationResult {
    const parsed = ModelGenerationResultSchema.safeParse(resultInput);
    if (!parsed.success) {
      throw new ProviderError(provider.id, 'invalid provider result', 'protocol', false);
    }

    const result = parsed.data;
    const declaredTools = new Set(request.tools?.map(({ name }) => name) ?? []);
    const invalid =
      result.provider !== provider.id ||
      result.model !== expectedModel ||
      result.costBasis !== provider.costBasis ||
      Buffer.byteLength(result.text, 'utf8') > MAX_MODEL_RESULT_TEXT_BYTES ||
      (result.tokensOut !== null && result.tokensOut > request.maxOutputTokens) ||
      result.toolCalls.some(({ name }) => !declaredTools.has(name));
    if (invalid) {
      throw new ProviderError(provider.id, 'invalid provider result', 'protocol', false);
    }
    return result;
  }

  private claimLeaseMs(requestTimeoutMs: number): number {
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs > Number.MAX_SAFE_INTEGER - PROVIDER_CLAIM_COMPLETION_GRACE_MS
    ) {
      throw new TypeError('request timeout cannot produce a safe provider claim lease');
    }
    return requestTimeoutMs + PROVIDER_CLAIM_COMPLETION_GRACE_MS;
  }

  private completeSuccessfulClaim(provider: ModelProviderId, claim: ProviderRateLimitClaim): void {
    if (provider === 'ollama' || !claim.halfOpen || claim.claimToken === null) {
      return;
    }
    try {
      this.deps.rateLimitCircuit?.close(provider, claim.claimToken);
    } catch {
      // Serving the successful result is preferable to turning bookkeeping
      // failure into a duplicate provider call. The hourly audit can surface DB
      // health independently.
    }
  }

  private releaseClaim(provider: ModelProviderId, claim: ProviderRateLimitClaim): void {
    if (
      provider === 'ollama' ||
      this.deps.rateLimitCircuit === undefined ||
      !claim.halfOpen ||
      claim.claimToken === null
    ) {
      return;
    }
    try {
      this.deps.rateLimitCircuit.release(provider, claim.claimToken);
    } catch {
      // Admission remains denied even if cooldown bookkeeping is unavailable.
    }
  }

  private completeFailedClaim(
    provider: ModelProviderId,
    claim: ProviderRateLimitClaim,
    error: unknown
  ): void {
    if (provider === 'ollama' || this.deps.rateLimitCircuit === undefined) {
      return;
    }
    try {
      if (error instanceof ProviderError && error.kind === 'rate_limited') {
        this.deps.rateLimitCircuit.open(
          provider,
          {
            detectedAt: this.clock(),
            resetAt: error.resetAt ?? null
          },
          claim.halfOpen ? (claim.claimToken ?? undefined) : undefined
        );
      } else if (claim.halfOpen && claim.claimToken !== null) {
        this.deps.rateLimitCircuit.release(provider, claim.claimToken);
      }
    } catch {
      // Preserve graceful fall-through even if durable cooldown bookkeeping fails.
    }
  }

  private elapsed(startedAt: number): number {
    const delta = this.clock() - startedAt;
    if (!Number.isFinite(delta) || delta < 0) return 0;
    return Math.min(Math.trunc(delta), MAX_LATENCY_MS);
  }

  private sanitize(error: unknown): string {
    if (error instanceof ProviderError) return `${error.kind}: provider attempt failed`;
    return 'provider call failed';
  }

  private async meter(row: {
    provider: ModelProvider;
    model: string;
    route: ModelTierRoute;
    operation: ModelOperation;
    clientId: string | null;
    status: 'succeeded' | 'failed' | 'timeout';
    latencyMs: number;
    tokensIn: number | null;
    tokensOut: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
  }): Promise<string> {
    const id = this.newId();
    await this.deps.usage.record({
      id,
      recordedAt: new Date(this.clock()).toISOString(),
      clientId: row.clientId,
      operation: row.operation,
      provider: row.provider.id,
      model: row.model,
      route: row.route,
      inputTokens: row.tokensIn,
      outputTokens: row.tokensOut,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      latencyMs: row.latencyMs,
      status: row.status,
      cost: row.provider.costBasis === 'local' ? { basis: 'local' } : { basis: 'subscription' }
    });
    return id;
  }
}
