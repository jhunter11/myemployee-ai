/**
 * Content-provider connection layer.
 *
 * Mirrors the model-runtime provider pattern: every connection is a thin,
 * dependency-injected seam over a local runtime or an HTTP API. Free/local
 * providers are always available; credentialed providers (Pexels, ElevenLabs,
 * Higgsfield) become available the moment their credential is present in the
 * secrets plane — no code change. Premium providers stay inert (and are never
 * selected by default) until both a credential and an explicit premium request
 * are supplied, preserving the free-first, fail-closed posture.
 */

export type ContentProviderCostBasis = 'local' | 'free_api' | 'metered' | 'subscription';

export type VoiceProviderId = 'local_say' | 'elevenlabs';
export type VisualProviderId = 'local_title_card' | 'pexels' | 'higgsfield';
export type ContentProviderId = VoiceProviderId | VisualProviderId;

export type ContentProviderErrorKind =
  'auth' | 'unavailable' | 'timeout' | 'protocol' | 'runtime' | 'rate_limited' | 'not_credentialed';

/**
 * A typed content-provider failure. `retriable` marks transient faults (timeout,
 * 5xx, rate limit, runtime down) where falling back to a free provider is
 * appropriate, versus hard auth/credential failures. The message is always
 * sanitized: it never carries an API key, prompt, or response body.
 */
export class ContentProviderError extends Error {
  constructor(
    readonly provider: ContentProviderId,
    message: string,
    readonly kind: ContentProviderErrorKind,
    readonly retriable: boolean,
    readonly resetAt?: number
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ContentProviderError';
  }
}

export interface ContentProviderAvailability {
  provider: ContentProviderId;
  available: boolean;
  costBasis: ContentProviderCostBasis;
  /** Whether this provider must never be auto-selected without an explicit premium opt-in. */
  premium: boolean;
  /** ALWAYS secret-free explanation (e.g. "credential present (env)", "no credential", "runtime available"). */
  detail: string;
}

export type AudioFormat = 'aiff' | 'wav' | 'mp3';

export interface VoiceSynthesisRequest {
  /** Narration text. Bounded by the adapter. */
  text: string;
  /** Absolute path the rendered audio file must be written to. */
  outputPath: string;
  /** Provider-specific voice identity; each adapter falls back to a safe default. */
  voiceId?: string;
  format?: AudioFormat;
  timeoutMs: number;
}

export interface VoiceSynthesisResult {
  provider: VoiceProviderId;
  costBasis: ContentProviderCostBasis;
  audioPath: string;
  format: AudioFormat;
  /** Character count — the ElevenLabs cost basis; a local `say` render is a genuine 0-cost. */
  characters: number;
  voiceId: string;
}

export interface VoiceProvider {
  readonly id: VoiceProviderId;
  readonly costBasis: ContentProviderCostBasis;
  readonly premium: boolean;
  probe(): Promise<ContentProviderAvailability>;
  synthesize(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult>;
}

export type VisualOrientation = 'portrait' | 'landscape' | 'square';

export interface VisualQueryRequest {
  query: string;
  orientation: VisualOrientation;
  /** How many assets to return. Bounded by the adapter. */
  count: number;
  timeoutMs: number;
}

export interface VisualAsset {
  provider: VisualProviderId;
  assetId: string;
  /** Direct link to the usable media (or, for a manual manifest, a shot reference). */
  sourceRef: string;
  /** License / rights posture, e.g. "pexels_license", "operator_generated", "manual_production_required". */
  license: string;
  /** Attribution/provenance reference to preserve even when attribution is optional. */
  provenanceRef: string;
  author: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  /** True when the asset requires human production before it exists (Higgsfield V1 manual manifest). */
  requiresManualProduction: boolean;
}

export interface VisualQueryResult {
  provider: VisualProviderId;
  costBasis: ContentProviderCostBasis;
  assets: VisualAsset[];
}

export interface VisualProvider {
  readonly id: VisualProviderId;
  readonly costBasis: ContentProviderCostBasis;
  readonly premium: boolean;
  probe(): Promise<ContentProviderAvailability>;
  query(request: VisualQueryRequest): Promise<VisualQueryResult>;
}
