import {
  ContentProviderError,
  type ContentProviderAvailability,
  type VisualAsset,
  type VisualProvider,
  type VisualQueryRequest,
  type VisualQueryResult
} from './contracts';
import { ContentCredentialResolver } from './content-credentials';

const DEFAULT_BASE_URL = 'https://api.pexels.com';
const MAX_PER_PAGE = 80;

export interface PexelsVisualProviderOptions {
  credentials?: ContentCredentialResolver;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

interface PexelsVideoFile {
  link?: unknown;
  quality?: unknown;
  width?: unknown;
  height?: unknown;
  file_type?: unknown;
}

interface PexelsVideo {
  id?: unknown;
  width?: unknown;
  height?: unknown;
  duration?: unknown;
  url?: unknown;
  user?: { name?: unknown };
  video_files?: unknown;
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function bestVideoFileLink(
  files: unknown
): { link: string; width: number | null; height: number | null } | null {
  if (!Array.isArray(files)) return null;
  const usable = files.filter(
    (file): file is PexelsVideoFile =>
      typeof (file as PexelsVideoFile)?.link === 'string' &&
      ((file as PexelsVideoFile).file_type === undefined ||
        (file as PexelsVideoFile).file_type === 'video/mp4')
  );
  if (usable.length === 0) return null;
  const preferred = usable.find((file) => file.quality === 'hd') ?? usable[0];
  if (preferred === undefined || typeof preferred.link !== 'string') return null;
  return { link: preferred.link, width: asInt(preferred.width), height: asInt(preferred.height) };
}

/**
 * Pexels stock B-roll over the documented `/videos/search` API. Cost basis
 * `free_api`; `premium: false` so it is a first-class starter once connected.
 * Inert until a `PEXELS_API_KEY` is present. Preserves per-asset provenance and
 * the Pexels license posture even though attribution is optional. The key is
 * read only at call time and never logged.
 */
export class PexelsVisualProvider implements VisualProvider {
  readonly id = 'pexels' as const;
  readonly costBasis = 'free_api' as const;
  readonly premium = false;
  private readonly credentials: ContentCredentialResolver;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: PexelsVisualProviderOptions = {}) {
    this.credentials = options.credentials ?? new ContentCredentialResolver();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  async probe(): Promise<ContentProviderAvailability> {
    const presence = await this.credentials.presence('pexels');
    return {
      provider: this.id,
      available: presence.present,
      costBasis: this.costBasis,
      premium: false,
      detail: presence.present
        ? `credential present (${presence.source})`
        : 'no credential connected (set PEXELS_API_KEY or keychain ai-agency-jarvis.pexels)'
    };
  }

  async query(request: VisualQueryRequest): Promise<VisualQueryResult> {
    const query = request.query.trim();
    if (query.length === 0) {
      throw new ContentProviderError(this.id, 'query text is empty', 'protocol', false);
    }
    const perPage = Math.min(Math.max(request.count, 1), MAX_PER_PAGE);

    let apiKey: string;
    try {
      apiKey = await this.credentials.read('pexels');
    } catch {
      throw new ContentProviderError(this.id, 'no credential connected', 'not_credentialed', false);
    }

    const url = new URL(`${this.baseUrl}/videos/search`);
    url.searchParams.set('query', query);
    url.searchParams.set('orientation', request.orientation);
    url.searchParams.set('per_page', String(perPage));

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Authorization: apiKey },
        signal: AbortSignal.timeout(request.timeoutMs)
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new ContentProviderError(
        this.id,
        timedOut ? 'request timed out' : 'runtime unreachable',
        timedOut ? 'timeout' : 'unavailable',
        true
      );
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new ContentProviderError(this.id, 'api key rejected', 'auth', false);
      }
      if (response.status === 429) {
        throw new ContentProviderError(this.id, 'rate limited', 'rate_limited', true);
      }
      throw new ContentProviderError(
        this.id,
        `api responded ${response.status}`,
        'runtime',
        response.status >= 500
      );
    }

    let body: { videos?: unknown };
    try {
      body = (await response.json()) as { videos?: unknown };
    } catch {
      throw new ContentProviderError(this.id, 'malformed response body', 'protocol', false);
    }
    const videos = Array.isArray(body.videos) ? (body.videos as PexelsVideo[]) : [];

    const assets: VisualAsset[] = [];
    for (const video of videos) {
      const id = asInt(video.id);
      const file = bestVideoFileLink(video.video_files);
      if (id === null || file === null) continue;
      assets.push({
        provider: this.id,
        assetId: `pexels-${id}`,
        sourceRef: file.link,
        license: 'pexels_license',
        provenanceRef: typeof video.url === 'string' ? video.url : `pexels:video:${id}`,
        author: typeof video.user?.name === 'string' ? video.user.name : null,
        width: file.width ?? asInt(video.width),
        height: file.height ?? asInt(video.height),
        durationSeconds: asInt(video.duration),
        requiresManualProduction: false
      });
      if (assets.length >= perPage) break;
    }

    return { provider: this.id, costBasis: this.costBasis, assets };
  }
}
