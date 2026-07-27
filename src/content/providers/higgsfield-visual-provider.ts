import { createHash } from 'node:crypto';

import {
  ContentProviderError,
  type ContentProviderAvailability,
  type VisualAsset,
  type VisualProvider,
  type VisualQueryRequest,
  type VisualQueryResult
} from './contracts';
import { ContentCredentialResolver } from './content-credentials';

const MAX_SHOTS = 8;

function shotSlug(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Higgsfield premium cinematic visuals. Cost basis `subscription`,
 * `premium: true` — never auto-selected. Availability flips on the moment a
 * `HIGGSFIELD_API_KEY` is connected, giving the operator the "usable the second
 * it is plugged in" seam.
 *
 * V1 is deliberately a **reviewable manual production manifest**: per the studio
 * decision record, Jarvis must not assume or reverse-engineer a generation API.
 * `query()` therefore returns shot specs with `requiresManualProduction: true`.
 * When an official API is separately verified, only the internal body of
 * `query()` changes — the connection contract stays identical.
 */
export class HiggsfieldVisualProvider implements VisualProvider {
  readonly id = 'higgsfield' as const;
  readonly costBasis = 'subscription' as const;
  readonly premium = true;
  private readonly credentials: ContentCredentialResolver;

  constructor(options: { credentials?: ContentCredentialResolver } = {}) {
    this.credentials = options.credentials ?? new ContentCredentialResolver();
  }

  async probe(): Promise<ContentProviderAvailability> {
    const presence = await this.credentials.presence('higgsfield');
    return {
      provider: this.id,
      available: presence.present,
      costBasis: this.costBasis,
      premium: true,
      detail: presence.present
        ? `credential present (${presence.source}); V1 emits a manual production manifest`
        : 'no credential connected (set HIGGSFIELD_API_KEY or keychain ai-agency-jarvis.higgsfield)'
    };
  }

  async query(request: VisualQueryRequest): Promise<VisualQueryResult> {
    const query = request.query.trim();
    if (query.length === 0) {
      throw new ContentProviderError(this.id, 'query text is empty', 'protocol', false);
    }
    // The credential is the connection switch even though V1 output is a manual
    // manifest: an operator must connect the tool before Jarvis proposes premium
    // cinematic shots.
    const presence = await this.credentials.presence('higgsfield');
    if (!presence.present) {
      throw new ContentProviderError(this.id, 'no credential connected', 'not_credentialed', false);
    }

    const count = Math.min(Math.max(request.count, 1), MAX_SHOTS);
    const base = shotSlug(`${request.orientation}:${query}`);
    const assets: VisualAsset[] = Array.from({ length: count }, (_unused, index) => ({
      provider: this.id,
      assetId: `higgsfield-shot-${base}-${index}`,
      sourceRef: `higgsfield-manifest:${request.orientation}:${base}:${index}`,
      license: 'manual_production_required',
      provenanceRef: 'higgsfield:manual_manifest_v1',
      author: null,
      width: null,
      height: null,
      durationSeconds: null,
      requiresManualProduction: true
    }));
    return { provider: this.id, costBasis: this.costBasis, assets };
  }
}
