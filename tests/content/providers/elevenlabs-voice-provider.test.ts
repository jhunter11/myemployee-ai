import { describe, expect, it, vi } from 'vitest';

import { ContentCredentialResolver } from '../../../src/content/providers/content-credentials';
import { ElevenLabsVoiceProvider } from '../../../src/content/providers/elevenlabs-voice-provider';

function keyedResolver(key: string | null = 'xi-key') {
  return new ContentCredentialResolver({
    env: key === null ? {} : { ELEVENLABS_API_KEY: key },
    keychainPresent: () => Promise.resolve(false),
    keychainRead: () => Promise.reject(new Error('none'))
  });
}

const request = {
  text: 'Narrate this line.',
  outputPath: '/tmp/out.mp3',
  voiceId: 'voice-123',
  timeoutMs: 30_000
};

describe('ElevenLabsVoiceProvider', () => {
  it('probes as available only when a credential is connected', async () => {
    expect(
      (await new ElevenLabsVoiceProvider({ credentials: keyedResolver() }).probe()).available
    ).toBe(true);
    const inert = await new ElevenLabsVoiceProvider({ credentials: keyedResolver(null) }).probe();
    expect(inert.available).toBe(false);
    expect(inert.premium).toBe(true);
  });

  it('synthesizes audio, sends the key as a header, and writes the file', async () => {
    const written: { path: string; bytes: number }[] = [];
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }))
    ) as unknown as typeof fetch;
    const provider = new ElevenLabsVoiceProvider({
      credentials: keyedResolver('secret-xi'),
      fetchImpl,
      writeFile: (path, data) => {
        written.push({ path, bytes: data.byteLength });
        return Promise.resolve();
      }
    });

    const result = await provider.synthesize(request);
    expect(result).toMatchObject({
      provider: 'elevenlabs',
      costBasis: 'metered',
      format: 'mp3',
      voiceId: 'voice-123',
      characters: request.text.length
    });
    expect(written).toEqual([{ path: '/tmp/out.mp3', bytes: 4 }]);

    const init = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0];
    const headers = init?.[1]?.headers as Record<string, string>;
    expect(headers['xi-api-key']).toBe('secret-xi');
    expect(init?.[0]).toContain('/v1/text-to-speech/voice-123');
  });

  it('maps auth, rate-limit, and server errors to typed failures', async () => {
    const make = (status: number) =>
      new ElevenLabsVoiceProvider({
        credentials: keyedResolver(),
        fetchImpl: (() => Promise.resolve(new Response('', { status }))) as unknown as typeof fetch,
        writeFile: () => Promise.resolve()
      });
    await expect(make(401).synthesize(request)).rejects.toMatchObject({
      kind: 'auth',
      retriable: false
    });
    await expect(make(429).synthesize(request)).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(make(500).synthesize(request)).rejects.toMatchObject({
      kind: 'runtime',
      retriable: true
    });
  });

  it('fails closed when no credential is connected', async () => {
    const provider = new ElevenLabsVoiceProvider({
      credentials: keyedResolver(null),
      fetchImpl: (() =>
        Promise.resolve(
          new Response(new Uint8Array([1]), { status: 200 })
        )) as unknown as typeof fetch,
      writeFile: () => Promise.resolve()
    });
    await expect(provider.synthesize(request)).rejects.toMatchObject({ kind: 'not_credentialed' });
  });

  it('requires a voiceId and non-empty text', async () => {
    const provider = new ElevenLabsVoiceProvider({
      credentials: keyedResolver(),
      fetchImpl: (() =>
        Promise.resolve(
          new Response(new Uint8Array([1]), { status: 200 })
        )) as unknown as typeof fetch,
      writeFile: () => Promise.resolve()
    });
    await expect(provider.synthesize({ ...request, voiceId: undefined })).rejects.toMatchObject({
      kind: 'protocol'
    });
    await expect(provider.synthesize({ ...request, text: '  ' })).rejects.toMatchObject({
      kind: 'protocol'
    });
  });

  it('maps a fetch timeout and an unreachable runtime to typed transient errors', async () => {
    const timeoutError = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const timedOut = new ElevenLabsVoiceProvider({
      credentials: keyedResolver(),
      fetchImpl: (() => Promise.reject(timeoutError)) as unknown as typeof fetch,
      writeFile: () => Promise.resolve()
    });
    await expect(timedOut.synthesize(request)).rejects.toMatchObject({ kind: 'timeout' });

    const unreachable = new ElevenLabsVoiceProvider({
      credentials: keyedResolver(),
      fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
      writeFile: () => Promise.resolve()
    });
    await expect(unreachable.synthesize(request)).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('rejects an empty audio body and a write failure', async () => {
    const empty = new ElevenLabsVoiceProvider({
      credentials: keyedResolver(),
      fetchImpl: (() =>
        Promise.resolve(
          new Response(new Uint8Array([]), { status: 200 })
        )) as unknown as typeof fetch,
      writeFile: () => Promise.resolve()
    });
    await expect(empty.synthesize(request)).rejects.toMatchObject({ kind: 'protocol' });

    const writeFails = new ElevenLabsVoiceProvider({
      credentials: keyedResolver(),
      fetchImpl: (() =>
        Promise.resolve(
          new Response(new Uint8Array([1, 2]), { status: 200 })
        )) as unknown as typeof fetch,
      writeFile: () => Promise.reject(new Error('disk full'))
    });
    await expect(writeFails.synthesize(request)).rejects.toMatchObject({ kind: 'runtime' });
  });

  it('uses a configured default voice when the request omits one', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(new Uint8Array([9]), { status: 200 }))
    ) as unknown as typeof fetch;
    const provider = new ElevenLabsVoiceProvider({
      credentials: keyedResolver(),
      fetchImpl,
      writeFile: () => Promise.resolve(),
      defaultVoiceId: 'default-voice'
    });
    const result = await provider.synthesize({ ...request, voiceId: undefined });
    expect(result.voiceId).toBe('default-voice');
  });
});
