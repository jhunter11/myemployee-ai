import type {
  ModelGenerationRequest,
  ModelGenerationResult,
  ModelProvider,
  ModelProviderId,
  ModelTierRoute,
  ProviderAvailability,
  ProviderCostBasis,
  ProviderError
} from './contracts';

export interface FakeProviderOptions {
  id: ModelProviderId;
  costBasis: ProviderCostBasis;
  available: boolean;
  /** Routes this fake serves; defaults to all three. */
  routes?: ModelTierRoute[];
  models?: Partial<Record<ModelTierRoute, string>>;
  /** When set, `generate` throws this instead of returning a result. */
  failWith?: ProviderError;
  /** Overrides the generated result; otherwise a deterministic echo is returned. */
  result?: Partial<ModelGenerationResult>;
  detail?: string;
}

const DEFAULT_MODELS: Record<ModelTierRoute, string> = {
  local: 'fake-local',
  economy: 'fake-economy',
  frontier: 'fake-frontier'
};

/**
 * A fully deterministic in-memory provider used to drive unit tests of the
 * catalog and executor without touching any CLI or network. It records every
 * request it receives so tests can assert what was (and was not) sent.
 */
export class FakeModelProvider implements ModelProvider {
  readonly id: ModelProviderId;
  readonly costBasis: ProviderCostBasis;
  readonly requests: Array<{ route: ModelTierRoute; request: ModelGenerationRequest }> = [];
  probeCount = 0;
  private readonly routes: Set<ModelTierRoute>;

  constructor(private readonly options: FakeProviderOptions) {
    this.id = options.id;
    this.costBasis = options.costBasis;
    this.routes = new Set(options.routes ?? ['local', 'economy', 'frontier']);
  }

  modelForRoute(route: ModelTierRoute): string {
    return this.options.models?.[route] ?? DEFAULT_MODELS[route];
  }

  servesRoute(route: ModelTierRoute): boolean {
    return this.routes.has(route);
  }

  probe(): Promise<ProviderAvailability> {
    this.probeCount += 1;
    return Promise.resolve({
      provider: this.id,
      available: this.options.available,
      detail:
        this.options.detail ?? (this.options.available ? 'fake available' : 'fake unavailable')
    });
  }

  generate(route: ModelTierRoute, request: ModelGenerationRequest): Promise<ModelGenerationResult> {
    this.requests.push({ route, request });
    if (this.options.failWith) return Promise.reject(this.options.failWith);
    const model = this.modelForRoute(route);
    return Promise.resolve({
      text: `fake:${this.id}:${route}:${request.messages.at(-1)?.content ?? ''}`,
      toolCalls: [],
      tokensIn: 10,
      tokensOut: 5,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      provider: this.id,
      model,
      costBasis: this.costBasis,
      finishReason: 'stop',
      ...this.options.result
    });
  }
}
