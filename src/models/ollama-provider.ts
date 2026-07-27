import {
  type ModelGenerationRequest,
  type ModelGenerationResult,
  type ModelProvider,
  type ModelTierRoute,
  type ModelToolCall,
  type ProviderAvailability,
  ProviderError
} from './contracts';

export interface OllamaProviderOptions {
  baseUrl?: string;
  /** Concrete model per route; local defaults to a code model, the others to a general one. */
  models?: Partial<Record<ModelTierRoute, string>>;
  fetchImpl?: typeof fetch;
  /** Probe timeout (liveness); generation uses the request's own timeout. */
  probeTimeoutMs?: number;
}

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODELS: Record<ModelTierRoute, string> = {
  local: 'qwen2.5-coder:7b',
  economy: 'qwen3:8b',
  frontier: 'qwen3:8b'
};

interface OllamaChatResponse {
  message?: { content?: unknown; tool_calls?: unknown };
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function toToolCalls(raw: unknown): ModelToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ModelToolCall[] = [];
  for (const entry of raw) {
    const fn = (entry as { function?: { name?: unknown; arguments?: unknown } })?.function;
    if (fn && typeof fn.name === 'string') {
      const args =
        fn.arguments && typeof fn.arguments === 'object'
          ? (fn.arguments as Record<string, unknown>)
          : {};
      calls.push({ name: fn.name, arguments: args });
    }
  }
  return calls;
}

/**
 * Ollama adapter: the always-available local runtime and the universal fallback.
 * It talks the documented `POST /api/chat` HTTP API on localhost and meters at
 * cost basis `local` (a genuine 0 — no metered API charge). No credential is
 * required; availability is a runtime-liveness probe (`GET /api/tags`).
 */
export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama' as const;
  readonly costBasis = 'local' as const;
  private readonly baseUrl: string;
  private readonly models: Record<ModelTierRoute, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly probeTimeoutMs: number;

  constructor(options: OllamaProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.models = { ...DEFAULT_MODELS, ...options.models };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 2_000;
  }

  modelForRoute(route: ModelTierRoute): string {
    return this.models[route];
  }

  servesRoute(): boolean {
    return true;
  }

  async probe(): Promise<ProviderAvailability> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.probeTimeoutMs)
      });
      if (!response.ok) {
        return {
          provider: this.id,
          available: false,
          detail: `runtime responded ${response.status}`
        };
      }
      const body = (await response.json()) as { models?: unknown };
      const count = Array.isArray(body.models) ? body.models.length : 0;
      return { provider: this.id, available: true, detail: `runtime serving (${count} models)` };
    } catch {
      return {
        provider: this.id,
        available: false,
        detail: 'runtime not serving on localhost:11434'
      };
    }
  }

  async generate(
    route: ModelTierRoute,
    request: ModelGenerationRequest
  ): Promise<ModelGenerationResult> {
    const model = this.modelForRoute(route);
    const messages = [
      { role: 'system', content: request.system },
      ...request.messages.map((message) => ({ role: message.role, content: message.content }))
    ];
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      options: { num_predict: request.maxOutputTokens }
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters }
      }));
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(request.timeoutMs)
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new ProviderError(
        this.id,
        timedOut ? 'request timed out' : 'runtime unreachable',
        timedOut ? 'timeout' : 'unavailable',
        true
      );
    }

    if (!response.ok) {
      throw new ProviderError(
        this.id,
        `runtime responded ${response.status}`,
        'runtime',
        response.status >= 500
      );
    }

    let parsed: OllamaChatResponse;
    try {
      parsed = (await response.json()) as OllamaChatResponse;
    } catch {
      throw new ProviderError(this.id, 'malformed response body', 'protocol', false);
    }

    const text = typeof parsed.message?.content === 'string' ? parsed.message.content : '';
    const toolCalls = toToolCalls(parsed.message?.tool_calls);
    return {
      text,
      toolCalls,
      tokensIn: asCount(parsed.prompt_eval_count),
      tokensOut: asCount(parsed.eval_count),
      cacheReadTokens: null,
      cacheWriteTokens: null,
      provider: this.id,
      model,
      costBasis: this.costBasis,
      finishReason:
        toolCalls.length > 0 ? 'tool_calls' : parsed.done_reason === 'length' ? 'length' : 'stop'
    };
  }
}
