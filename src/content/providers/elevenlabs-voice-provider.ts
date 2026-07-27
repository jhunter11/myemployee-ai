import { writeFile as fsWriteFile } from 'node:fs/promises';

import {
  ContentProviderError,
  type ContentProviderAvailability,
  type VoiceProvider,
  type VoiceSynthesisRequest,
  type VoiceSynthesisResult
} from './contracts';
import { ContentCredentialResolver } from './content-credentials';

const MAX_NARRATION_CHARS = 20_000;
const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';

export interface ElevenLabsVoiceProviderOptions {
  credentials?: ContentCredentialResolver;
  fetchImpl?: typeof fetch;
  writeFile?: (path: string, data: Buffer) => Promise<void>;
  baseUrl?: string;
  modelId?: string;
  /** A configured default voice id used when a request omits one. */
  defaultVoiceId?: string;
}

function parseResetAt(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Date.now() + Math.trunc(seconds) * 1_000;
}

/**
 * ElevenLabs narration over the documented `/v1/text-to-speech/{voice}` API.
 * Cost basis `metered` (character-priced) and `premium: true`, so it is never
 * auto-selected without an explicit premium request. Fully inert until an
 * `ELEVENLABS_API_KEY` (env or keychain) is connected — at which point it works
 * with no code change. The key is read only at call time and never logged.
 */
export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly id = 'elevenlabs' as const;
  readonly costBasis = 'metered' as const;
  readonly premium = true;
  private readonly credentials: ContentCredentialResolver;
  private readonly fetchImpl: typeof fetch;
  private readonly writeFile: (path: string, data: Buffer) => Promise<void>;
  private readonly baseUrl: string;
  private readonly modelId: string;
  private readonly defaultVoiceId: string | undefined;

  constructor(options: ElevenLabsVoiceProviderOptions = {}) {
    this.credentials = options.credentials ?? new ContentCredentialResolver();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.writeFile = options.writeFile ?? ((path, data) => fsWriteFile(path, data));
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.modelId = options.modelId ?? DEFAULT_MODEL_ID;
    this.defaultVoiceId = options.defaultVoiceId;
  }

  async probe(): Promise<ContentProviderAvailability> {
    const presence = await this.credentials.presence('elevenlabs');
    return {
      provider: this.id,
      available: presence.present,
      costBasis: this.costBasis,
      premium: true,
      detail: presence.present
        ? `credential present (${presence.source})`
        : 'no credential connected (set ELEVENLABS_API_KEY or keychain ai-agency-jarvis.elevenlabs)'
    };
  }

  async synthesize(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
    const text = request.text.trim();
    if (text.length === 0 || text.length > MAX_NARRATION_CHARS) {
      throw new ContentProviderError(
        this.id,
        'narration text is empty or exceeds the limit',
        'protocol',
        false
      );
    }
    const voiceId = request.voiceId ?? this.defaultVoiceId;
    if (voiceId === undefined || voiceId.trim().length === 0) {
      throw new ContentProviderError(
        this.id,
        'a voiceId is required (none supplied and no default configured)',
        'protocol',
        false
      );
    }

    let apiKey: string;
    try {
      apiKey = await this.credentials.read('elevenlabs');
    } catch {
      throw new ContentProviderError(this.id, 'no credential connected', 'not_credentialed', false);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'content-type': 'application/json',
            accept: 'audio/mpeg'
          },
          body: JSON.stringify({
            text,
            model_id: this.modelId,
            voice_settings: { stability: 0.5, similarity_boost: 0.75 }
          }),
          signal: AbortSignal.timeout(request.timeoutMs)
        }
      );
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
        throw new ContentProviderError(
          this.id,
          'rate limited',
          'rate_limited',
          true,
          parseResetAt(response.headers.get('retry-after'))
        );
      }
      throw new ContentProviderError(
        this.id,
        `api responded ${response.status}`,
        'runtime',
        response.status >= 500
      );
    }

    let audio: Buffer;
    try {
      audio = Buffer.from(await response.arrayBuffer());
    } catch {
      throw new ContentProviderError(this.id, 'unreadable audio body', 'protocol', false);
    }
    if (audio.byteLength === 0) {
      throw new ContentProviderError(this.id, 'empty audio body', 'protocol', false);
    }
    try {
      await this.writeFile(request.outputPath, audio);
    } catch {
      throw new ContentProviderError(this.id, 'failed to write audio file', 'runtime', true);
    }

    return {
      provider: this.id,
      costBasis: this.costBasis,
      audioPath: request.outputPath,
      format: 'mp3',
      characters: text.length,
      voiceId
    };
  }
}
