import { createHash } from 'node:crypto';

import {
  ContentProviderError,
  type ContentProviderAvailability,
  type VisualAsset,
  type VisualOrientation,
  type VisualProvider,
  type VisualQueryRequest,
  type VisualQueryResult
} from './contracts';

const MAX_ASSETS = 12;

function dimensions(orientation: VisualOrientation): { width: number; height: number } {
  if (orientation === 'portrait') return { width: 1080, height: 1920 };
  if (orientation === 'landscape') return { width: 1920, height: 1080 };
  return { width: 1080, height: 1080 };
}

function slug(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * The always-available, zero-cost visual backstop: deterministic title-card
 * specs (a solid/gradient background with overlaid text) that the local renderer
 * turns into frames. No network, no credential, no third-party rights. This is
 * the free starter visual; Pexels B-roll and Higgsfield are the upgrades.
 */
export class LocalTitleCardVisualProvider implements VisualProvider {
  readonly id = 'local_title_card' as const;
  readonly costBasis = 'local' as const;
  readonly premium = false;

  probe(): Promise<ContentProviderAvailability> {
    return Promise.resolve({
      provider: this.id,
      available: true,
      costBasis: this.costBasis,
      premium: false,
      detail: 'local renderer available (no credential)'
    });
  }

  query(request: VisualQueryRequest): Promise<VisualQueryResult> {
    const query = request.query.trim();
    if (query.length === 0) {
      return Promise.reject(
        new ContentProviderError(this.id, 'query text is empty', 'protocol', false)
      );
    }
    const count = Math.min(Math.max(request.count, 1), MAX_ASSETS);
    const { width, height } = dimensions(request.orientation);
    const base = slug(`${request.orientation}:${query}`);
    const assets: VisualAsset[] = Array.from({ length: count }, (_unused, index) => ({
      provider: this.id,
      assetId: `titlecard-${base}-${index}`,
      sourceRef: `titlecard:${request.orientation}:${base}:${index}`,
      license: 'operator_generated',
      provenanceRef: 'operator_generated:local_title_card',
      author: null,
      width,
      height,
      durationSeconds: null,
      requiresManualProduction: false
    }));
    return Promise.resolve({ provider: this.id, costBasis: this.costBasis, assets });
  }
}
