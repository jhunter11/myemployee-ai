import { defaultCliRunner, type CliRunner } from '../../models/cli-runtime';
import {
  ContentProviderError,
  type ContentProviderAvailability,
  type VoiceProvider,
  type VoiceSynthesisRequest,
  type VoiceSynthesisResult
} from './contracts';

const MAX_NARRATION_CHARS = 20_000;

export interface LocalSayVoiceProviderOptions {
  runner?: CliRunner;
  command?: string;
  /** Injected platform string for deterministic probes (default `process.platform`). */
  platform?: NodeJS.Platform;
}

/**
 * The always-available local narration backstop: macOS `say` synthesizing to an
 * audio file. Cost basis `local` (a genuine 0 — no metered API). Text is fed on
 * stdin, never as a shell argument, so narration content cannot alter the
 * command line. This is the free starter voice; ElevenLabs is the paid upgrade.
 */
export class LocalSayVoiceProvider implements VoiceProvider {
  readonly id = 'local_say' as const;
  readonly costBasis = 'local' as const;
  readonly premium = false;
  private readonly runner: CliRunner;
  private readonly command: string;
  private readonly platform: NodeJS.Platform;

  constructor(options: LocalSayVoiceProviderOptions = {}) {
    this.runner = options.runner ?? defaultCliRunner;
    this.command = options.command ?? 'say';
    this.platform = options.platform ?? process.platform;
  }

  probe(): Promise<ContentProviderAvailability> {
    const available = this.platform === 'darwin';
    return Promise.resolve({
      provider: this.id,
      available,
      costBasis: this.costBasis,
      premium: false,
      detail: available
        ? 'macOS say runtime available (local, no credential)'
        : 'say is only available on macOS'
    });
  }

  async synthesize(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
    const text = request.text.trim();
    if (text.length === 0 || text.length > MAX_NARRATION_CHARS) {
      throw new ContentProviderError(
        this.id,
        'narration text is empty or exceeds the local limit',
        'protocol',
        false
      );
    }
    const format = request.format ?? 'aiff';
    if (format === 'mp3') {
      throw new ContentProviderError(
        this.id,
        'local say cannot emit mp3; use aiff or wav',
        'protocol',
        false
      );
    }

    const args = ['-o', request.outputPath];
    if (request.voiceId !== undefined) args.push('-v', request.voiceId);
    if (format === 'wav') args.push('--file-format=WAVE', '--data-format=LEI16@22050');

    let result;
    try {
      result = await this.runner(this.command, args, {
        input: text,
        timeoutMs: request.timeoutMs
      });
    } catch {
      throw new ContentProviderError(this.id, 'failed to launch say', 'unavailable', true);
    }
    if (result.timedOut) {
      throw new ContentProviderError(this.id, 'say timed out', 'timeout', true);
    }
    if (result.code !== 0) {
      throw new ContentProviderError(this.id, 'say reported a non-zero exit', 'runtime', true);
    }

    return {
      provider: this.id,
      costBasis: this.costBasis,
      audioPath: request.outputPath,
      format,
      characters: text.length,
      voiceId: request.voiceId ?? 'system_default'
    };
  }
}
