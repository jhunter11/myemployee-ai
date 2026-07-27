import { z } from 'zod';

/**
 * The provider-binding layer. It sits BEHIND the provider-agnostic router
 * (`src/economics/model-router.ts`): the router decides risk → logical tier →
 * whether to call a model at all and never learns a provider name; this layer
 * binds a logical tier to a concrete provider + model, probes availability, and
 * turns a bounded request into text/tool-calls/usage. Crossing the execution gate
 * still requires the operator-owned enablement record (SPEC §15, ADR-001).
 */

export type ModelProviderId = 'claude' | 'codex' | 'gemini' | 'ollama';

/**
 * The three model-serving logical routes. Tier 0 (`deterministic`) never reaches
 * this layer — it is pure code — so it is intentionally absent here.
 */
export type ModelTierRoute = 'local' | 'economy' | 'frontier';

/**
 * Cost basis a provider meters under (SPEC §15, ADR-003). Subscription providers
 * (Claude Max, ChatGPT/Codex, Gemini) have a genuinely-unknown per-call dollar
 * cost → `subscription` (NULL). Local Ollama calls incur no metered charge →
 * `local` (exactly 0).
 */
export type ProviderCostBasis = 'subscription' | 'local';

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ModelToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool's parameters. */
  parameters: Record<string, unknown>;
}

export const ModelGenerationRequestSchema = z.strictObject({
  system: z.string().max(200_000),
  messages: z
    .array(
      z.strictObject({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(200_000)
      })
    )
    .min(1)
    .max(64),
  tools: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
        description: z.string().min(1).max(1_024),
        parameters: z.record(z.string(), z.unknown())
      })
    )
    .max(32)
    .optional(),
  maxOutputTokens: z.number().int().min(1).max(32_768),
  timeoutMs: z.number().int().min(1_000).max(600_000)
});

export type ModelGenerationRequest = z.infer<typeof ModelGenerationRequestSchema>;

export interface ModelToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const ModelResultCounterSchema = z.number().int().min(0).max(2_147_483_647).nullable();

export const ModelGenerationResultSchema = z
  .strictObject({
    text: z.string().max(1_048_576),
    toolCalls: z
      .array(
        z.strictObject({
          name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
          arguments: z.record(z.string(), z.unknown())
        })
      )
      .max(32),
    tokensIn: ModelResultCounterSchema,
    tokensOut: ModelResultCounterSchema,
    cacheReadTokens: ModelResultCounterSchema,
    cacheWriteTokens: ModelResultCounterSchema,
    provider: z.enum(['claude', 'codex', 'gemini', 'ollama']),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/),
    costBasis: z.enum(['subscription', 'local']),
    finishReason: z.enum(['stop', 'length', 'tool_calls', 'error', 'unknown'])
  })
  .refine((result) => result.text.length > 0 || result.toolCalls.length > 0, {
    message: 'provider output must contain text or at least one tool call'
  });

export interface ModelGenerationResult {
  text: string;
  toolCalls: ModelToolCall[];
  tokensIn: number | null;
  tokensOut: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  provider: ModelProviderId;
  model: string;
  costBasis: ProviderCostBasis;
  /** Provider-reported stop reason, normalized to a short secret-free label. */
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error' | 'unknown';
}

export interface ProviderAvailability {
  provider: ModelProviderId;
  available: boolean;
  /**
   * Human-readable, ALWAYS secret-free explanation of the availability decision
   * (e.g. "credential present", "runtime not serving", "no credential").
   */
  detail: string;
}

/**
 * A typed provider failure. `retriable` distinguishes a transient fault (timeout,
 * 5xx, rate limit, runtime down) — where degrading to the next provider is appropriate
 * — from a hard auth/eligibility failure. `resetAt`, when present, is provider-supplied
 * structured metadata normalized to epoch milliseconds. The message is sanitized and
 * never carries prompt, completion, token, or response-body bytes (SPEC §15 secrets
 * discipline).
 */
export class ProviderError extends Error {
  constructor(
    readonly provider: ModelProviderId,
    message: string,
    readonly kind: 'auth' | 'unavailable' | 'timeout' | 'protocol' | 'runtime' | 'rate_limited',
    readonly retriable: boolean,
    readonly resetAt?: number
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
  }
}

/**
 * One adapter per provider. Every adapter is a thin, injectable seam over a CLI
 * or HTTP runtime; the real I/O is dependency-injected so unit tests drive fakes
 * and only the integration tests touch the live runtime.
 */
export interface ModelProvider {
  readonly id: ModelProviderId;
  readonly costBasis: ProviderCostBasis;
  /** The concrete model this provider serves for a given logical route. */
  modelForRoute(route: ModelTierRoute): string;
  /** Which logical routes this provider can serve at all. */
  servesRoute(route: ModelTierRoute): boolean;
  /** Cheap, secret-free availability probe (credential presence or runtime liveness). */
  probe(): Promise<ProviderAvailability>;
  /** Execute one bounded turn. Throws {@link ProviderError} on failure. */
  generate(route: ModelTierRoute, request: ModelGenerationRequest): Promise<ModelGenerationResult>;
}
