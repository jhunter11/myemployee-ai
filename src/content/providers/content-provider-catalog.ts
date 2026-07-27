import { ContentCredentialResolver } from './content-credentials';
import {
  type ContentProviderAvailability,
  type VisualProvider,
  type VisualProviderId,
  type VoiceProvider,
  type VoiceProviderId
} from './contracts';
import { ElevenLabsVoiceProvider } from './elevenlabs-voice-provider';
import { HiggsfieldVisualProvider } from './higgsfield-visual-provider';
import { LocalSayVoiceProvider } from './local-say-voice-provider';
import { LocalTitleCardVisualProvider } from './local-title-card-visual-provider';
import { PexelsVisualProvider } from './pexels-visual-provider';

export interface ContentLaneResolution<Id extends string> {
  availability: ContentProviderAvailability[];
  /** First available, non-premium provider in preference order — the free-first default. */
  starter: Id | null;
  /** Premium providers whose credential is connected and ready to select on request. */
  premiumReady: Id[];
}

export interface ContentProviderResolution {
  voice: ContentLaneResolution<VoiceProviderId>;
  visual: ContentLaneResolution<VisualProviderId>;
}

async function safeProbe(provider: {
  id: string;
  costBasis: ContentProviderAvailability['costBasis'];
  premium: boolean;
  probe: () => Promise<ContentProviderAvailability>;
}): Promise<ContentProviderAvailability> {
  try {
    return await provider.probe();
  } catch {
    return {
      provider: provider.id as ContentProviderAvailability['provider'],
      available: false,
      costBasis: provider.costBasis,
      premium: provider.premium,
      detail: 'probe failed'
    };
  }
}

/**
 * Resolves the connected content providers into free-first bindings, mirroring
 * the model catalog. `starter` is the cheapest available non-premium provider in
 * a fixed preference order; `premiumReady` lists credentialed premium providers
 * that can be selected on explicit request. Premium is never chosen as a starter,
 * preserving the free-first, fail-closed posture.
 */
export class ContentProviderCatalog {
  constructor(
    private readonly voiceProviders: readonly VoiceProvider[],
    private readonly visualProviders: readonly VisualProvider[]
  ) {}

  async resolve(): Promise<ContentProviderResolution> {
    const [voiceAvailability, visualAvailability] = await Promise.all([
      Promise.all(this.voiceProviders.map((provider) => safeProbe(provider))),
      Promise.all(this.visualProviders.map((provider) => safeProbe(provider)))
    ]);

    return {
      voice: this.laneResolution<VoiceProviderId>(this.voiceProviders, voiceAvailability),
      visual: this.laneResolution<VisualProviderId>(this.visualProviders, visualAvailability)
    };
  }

  private laneResolution<Id extends string>(
    providers: readonly { id: Id; premium: boolean }[],
    availability: ContentProviderAvailability[]
  ): ContentLaneResolution<Id> {
    const availableIds = new Set<string>(
      availability.filter((entry) => entry.available).map((entry) => entry.provider)
    );
    let starter: Id | null = null;
    const premiumReady: Id[] = [];
    for (const provider of providers) {
      if (!availableIds.has(provider.id)) continue;
      if (provider.premium) {
        premiumReady.push(provider.id);
      } else if (starter === null) {
        starter = provider.id;
      }
    }
    return { availability, starter, premiumReady };
  }
}

/**
 * Builds the default catalog: the free/local starters first in preference order
 * (Pexels ahead of the title-card backstop; local `say` for voice), with the
 * premium adapters wired but inert until their credential is connected. All
 * credentialed adapters share one resolver so the connection switch is uniform.
 */
export function createContentProviderCatalog(
  options: { credentials?: ContentCredentialResolver } = {}
): ContentProviderCatalog {
  const credentials = options.credentials ?? new ContentCredentialResolver();
  return new ContentProviderCatalog(
    [new LocalSayVoiceProvider(), new ElevenLabsVoiceProvider({ credentials })],
    [
      new PexelsVisualProvider({ credentials }),
      new LocalTitleCardVisualProvider(),
      new HiggsfieldVisualProvider({ credentials })
    ]
  );
}
