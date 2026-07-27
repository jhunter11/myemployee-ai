import { describe, expect, it, vi } from 'vitest';

import type { CliResult, CliRunner } from '../../../src/models/cli-runtime';
import { LocalSayVoiceProvider } from '../../../src/content/providers/local-say-voice-provider';

function okRunner(result: Partial<CliResult> = {}): CliRunner {
  return () => Promise.resolve({ stdout: '', stderr: '', code: 0, timedOut: false, ...result });
}

const request = {
  text: 'The archivist opened the memo from tomorrow.',
  outputPath: '/tmp/narration.aiff',
  timeoutMs: 30_000
};

describe('LocalSayVoiceProvider', () => {
  it('is available on macOS and unavailable elsewhere', async () => {
    expect((await new LocalSayVoiceProvider({ platform: 'darwin' }).probe()).available).toBe(true);
    expect((await new LocalSayVoiceProvider({ platform: 'linux' }).probe()).available).toBe(false);
  });

  it('feeds narration on stdin (never as an argument) and writes to the output path', async () => {
    const runner = vi.fn(okRunner());
    const provider = new LocalSayVoiceProvider({ runner, platform: 'darwin' });
    const result = await provider.synthesize(request);

    expect(result).toMatchObject({
      provider: 'local_say',
      costBasis: 'local',
      audioPath: '/tmp/narration.aiff',
      format: 'aiff',
      characters: request.text.length,
      voiceId: 'system_default'
    });
    const [, args, invocation] = runner.mock.calls[0] ?? [];
    expect(args).toEqual(['-o', '/tmp/narration.aiff']);
    expect(invocation?.input).toBe(request.text);
  });

  it('passes a voice and WAV format flags through', async () => {
    const runner = vi.fn(okRunner());
    await new LocalSayVoiceProvider({ runner, platform: 'darwin' }).synthesize({
      ...request,
      voiceId: 'Samantha',
      format: 'wav'
    });
    const [, args] = runner.mock.calls[0] ?? [];
    expect(args).toContain('-v');
    expect(args).toContain('Samantha');
    expect(args).toContain('--file-format=WAVE');
  });

  it('rejects mp3 and empty text', async () => {
    const provider = new LocalSayVoiceProvider({ runner: okRunner(), platform: 'darwin' });
    await expect(provider.synthesize({ ...request, format: 'mp3' })).rejects.toMatchObject({
      kind: 'protocol'
    });
    await expect(provider.synthesize({ ...request, text: '   ' })).rejects.toMatchObject({
      kind: 'protocol'
    });
  });

  it('maps a timeout and a non-zero exit to retriable errors', async () => {
    await expect(
      new LocalSayVoiceProvider({
        runner: okRunner({ timedOut: true }),
        platform: 'darwin'
      }).synthesize(request)
    ).rejects.toMatchObject({ kind: 'timeout', retriable: true });

    await expect(
      new LocalSayVoiceProvider({ runner: okRunner({ code: 1 }), platform: 'darwin' }).synthesize(
        request
      )
    ).rejects.toMatchObject({ kind: 'runtime', retriable: true });
  });

  it('maps a launch failure to an unavailable error', async () => {
    const provider = new LocalSayVoiceProvider({
      runner: () => Promise.reject(new Error('spawn ENOENT')),
      platform: 'darwin'
    });
    await expect(provider.synthesize(request)).rejects.toMatchObject({ kind: 'unavailable' });
  });
});
