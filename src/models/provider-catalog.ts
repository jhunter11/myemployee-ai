import {
  type ModelProvider,
  type ModelProviderId,
  type ModelTierRoute,
  type ProviderAvailability
} from './contracts';

export interface ProviderPreferences {
  /**
   * Preference order for the subscription-served routes (economy/frontier). The
   * briefing fixes this to Claude → Codex → Gemini; the first available one wins.
   */
  subscriptionOrder: ModelProviderId[];
  /** The always-local fallback provider (Ollama) that also backstops every route. */
  localProvider: ModelProviderId;
}

export const DEFAULT_PROVIDER_PREFERENCES: ProviderPreferences = {
  subscriptionOrder: ['claude', 'codex', 'gemini'],
  localProvider: 'ollama'
};

export type BindingReason =
  'bound_preferred' | 'bound_local' | 'degraded_to_local' | 'no_provider_available';

export interface RouteBinding {
  route: ModelTierRoute;
  /** `null` means no model runtime is available → deterministic fallback / runtime_not_configured. */
  provider: ModelProviderId | null;
  model: string | null;
  reason: BindingReason;
}

export interface CatalogResolution {
  availability: ProviderAvailability[];
  bindings: Record<ModelTierRoute, RouteBinding>;
  /**
   * Ordered providers the executor should attempt per route (primary first, the
   * local fallback last). A failing attempt falls through to the next entry; an
   * empty list means deterministic fallback.
   */
  candidates: Record<ModelTierRoute, ModelProvider[]>;
}

const ROUTES: ModelTierRoute[] = ['local', 'economy', 'frontier'];

/**
 * Binds the router's provider-agnostic logical tiers to concrete providers by the
 * configured preference order and degrades gracefully: economy/frontier prefer the
 * first available subscription of [Claude, Codex, Gemini]; every route falls back
 * to the local provider (Ollama); when nothing is available the route resolves to
 * a deterministic fallback rather than fabricating a reply (SPEC §15, briefing).
 */
export class ProviderCatalog {
  private readonly providers: Map<ModelProviderId, ModelProvider>;

  constructor(
    providers: ModelProvider[],
    private readonly preferences: ProviderPreferences = DEFAULT_PROVIDER_PREFERENCES
  ) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  provider(id: ModelProviderId): ModelProvider | undefined {
    return this.providers.get(id);
  }

  async resolve(allowedProviders?: ReadonlySet<ModelProviderId>): Promise<CatalogResolution> {
    const availability = await Promise.all(
      [...this.providers.values()]
        .filter((provider) => allowedProviders === undefined || allowedProviders.has(provider.id))
        .map((provider) => this.safeProbe(provider))
    );
    const availableIds = new Set(
      availability.filter((entry) => entry.available).map((entry) => entry.provider)
    );

    const local = this.providers.get(this.preferences.localProvider);
    const localAvailable =
      local !== undefined && availableIds.has(local.id) && local.servesRoute('local');

    const bindings = {} as Record<ModelTierRoute, RouteBinding>;
    const candidates = {} as Record<ModelTierRoute, ModelProvider[]>;

    for (const route of ROUTES) {
      const ordered: ModelProvider[] = [];
      if (route !== 'local') {
        for (const id of this.preferences.subscriptionOrder) {
          const provider = this.providers.get(id);
          if (provider && availableIds.has(id) && provider.servesRoute(route)) {
            ordered.push(provider);
          }
        }
      }
      // The local provider backstops every route (including economy/frontier when
      // all subscriptions are down), as long as it is live and serves the route.
      if (local && localAvailable && local.servesRoute(route) && !ordered.includes(local)) {
        ordered.push(local);
      }
      candidates[route] = ordered;
      bindings[route] = this.bind(route, ordered);
    }

    return { availability, bindings, candidates };
  }

  private bind(route: ModelTierRoute, ordered: ModelProvider[]): RouteBinding {
    const primary = ordered[0];
    if (!primary) {
      return { route, provider: null, model: null, reason: 'no_provider_available' };
    }
    const isLocal = primary.id === this.preferences.localProvider;
    const reason: BindingReason = isLocal
      ? route === 'local'
        ? 'bound_local'
        : 'degraded_to_local'
      : 'bound_preferred';
    return { route, provider: primary.id, model: primary.modelForRoute(route), reason };
  }

  private async safeProbe(provider: ModelProvider): Promise<ProviderAvailability> {
    try {
      return await provider.probe();
    } catch {
      // A throwing probe is treated as unavailable — fail closed, never assume a
      // provider is usable because its probe errored.
      return { provider: provider.id, available: false, detail: 'probe failed' };
    }
  }
}
