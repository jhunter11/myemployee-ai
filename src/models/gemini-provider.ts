import {
  type ModelGenerationRequest,
  type ModelGenerationResult,
  type ModelProvider,
  type ModelTierRoute,
  type ProviderAvailability,
  ProviderError
} from './contracts';

export interface GeminiProviderOptions {
  models?: Partial<Record<ModelTierRoute, string>>;
}

const DEFAULT_MODELS: Record<ModelTierRoute, string> = {
  local: 'gemini-2.5-flash',
  economy: 'gemini-2.5-flash',
  frontier: 'gemini-2.5-pro'
};

interface GeminiJsonEnvelope {
  response?: unknown;
  stats?: unknown;
  error?: unknown;
}

export interface ParsedGeminiCliResponse {
  text: string;
  tokensIn: number | null;
  tokensOut: number | null;
  cacheReadTokens: number | null;
}

export interface GeminiCliFailure {
  kind: 'auth' | 'protocol' | 'rate_limited';
  retriable: boolean;
  message: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function parseEnvelope(text: string): GeminiJsonEnvelope | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function looksLikeAuthFailure(stderr: string): boolean {
  return /ineligible|authenticat|unauthor|no longer supported|login/iu.test(stderr);
}

function looksLikeRateLimitFailure(stderr: string): boolean {
  return /\bRESOURCE_EXHAUSTED\b|\b429\b/iu.test(stderr);
}

function hasValidGoogleRetryDelay(value: unknown): boolean {
  if (typeof value === 'string') {
    return /^(?:0|[1-9]\d*)(?:\.\d+)?s$/u.test(value);
  }

  const duration = asRecord(value);
  if (!duration) return false;
  const seconds = duration.seconds;
  const validSeconds =
    (typeof seconds === 'number' && Number.isInteger(seconds) && seconds >= 0) ||
    (typeof seconds === 'string' && /^(?:0|[1-9]\d*)$/u.test(seconds));
  if (!validSeconds) return false;

  const nanos = duration.nanos;
  return (
    nanos === undefined ||
    (typeof nanos === 'number' && Number.isInteger(nanos) && nanos >= 0 && nanos <= 999_999_999)
  );
}

function hasTrustedRetryInfo(error: Record<string, unknown>): boolean {
  const details = error.details;
  if (!Array.isArray(details)) return false;

  return details.some((detail) => {
    const record = asRecord(detail);
    return (
      record?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo' &&
      hasValidGoogleRetryDelay(record.retryDelay)
    );
  });
}

function isStructuredRateLimit(error: unknown): boolean {
  const fields = asRecord(error);
  if (!fields) return false;

  if (
    fields.code === 429 ||
    fields.code === '429' ||
    fields.status === 429 ||
    fields.status === '429'
  ) {
    return true;
  }

  const statusValues = [fields.status, fields.type];
  if (
    statusValues.some(
      (value) => typeof value === 'string' && value.toUpperCase() === 'RESOURCE_EXHAUSTED'
    )
  ) {
    return true;
  }

  return hasTrustedRetryInfo(fields);
}

/**
 * Parses the supported Gemini CLI JSON success envelope without launching a
 * process. Current CLI token metrics are keyed by concrete model under
 * `stats.models`.
 */
export function parseGeminiCliResponse(
  stdout: string,
  model: string
): ParsedGeminiCliResponse | null {
  const envelope = parseEnvelope(stdout);
  if (!envelope || typeof envelope.response !== 'string' || envelope.error !== undefined) {
    return null;
  }

  const stats = asRecord(envelope.stats);
  const models = asRecord(stats?.models);
  const modelMetrics = asRecord(models?.[model]);
  const tokens = asRecord(modelMetrics?.tokens);
  const input = asCount(tokens?.input);

  return {
    text: envelope.response,
    tokensIn: input ?? asCount(tokens?.prompt),
    tokensOut: asCount(tokens?.candidates) ?? asCount(tokens?.output),
    cacheReadTokens: asCount(tokens?.cached)
  };
}

/**
 * Classifies unusable CLI output using only bounded, structured signals. It
 * never includes stdout/stderr/provider response bytes in the returned message.
 */
export function classifyGeminiCliFailure(stdout: string, stderr: string): GeminiCliFailure {
  const envelope = parseEnvelope(stdout);
  if (isStructuredRateLimit(envelope?.error) || looksLikeRateLimitFailure(stderr)) {
    return {
      kind: 'rate_limited',
      retriable: true,
      message: 'subscription rate limited'
    };
  }

  if (looksLikeAuthFailure(stderr)) {
    return {
      kind: 'auth',
      retriable: false,
      message: 'subscription ineligible or not authenticated'
    };
  }

  return {
    kind: 'protocol',
    retriable: true,
    message: 'CLI returned no usable response'
  };
}

/**
 * Metadata-only Gemini provider placeholder. The stock Gemini CLI cannot meet
 * Jarvis's no-tools, no-customizations, no-session, and no-prompt-persistence
 * boundary, so no production execution option exists here.
 */
export class GeminiProvider implements ModelProvider {
  readonly id = 'gemini' as const;
  readonly costBasis = 'subscription' as const;
  private readonly models: Record<ModelTierRoute, string>;

  constructor(options: GeminiProviderOptions = {}) {
    this.models = { ...DEFAULT_MODELS, ...options.models };
  }

  modelForRoute(route: ModelTierRoute): string {
    return this.models[route];
  }

  servesRoute(route: ModelTierRoute): boolean {
    return route === 'economy' || route === 'frontier';
  }

  probe(): Promise<ProviderAvailability> {
    return Promise.resolve({
      provider: this.id,
      available: false,
      detail: 'Gemini CLI execution is disabled pending a separately reviewed runtime'
    });
  }

  generate(route: ModelTierRoute, request: ModelGenerationRequest): Promise<ModelGenerationResult> {
    void route;
    void request;
    return Promise.reject(
      new ProviderError(
        this.id,
        'Gemini CLI execution is disabled pending a separately reviewed runtime',
        'unavailable',
        false
      )
    );
  }
}
