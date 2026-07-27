import { describe, expect, it, vi } from 'vitest';

import { ContentCredentialResolver } from '../../../src/content/providers/content-credentials';
import { PexelsVisualProvider } from '../../../src/content/providers/pexels-visual-provider';

function keyedResolver(key: string | null = 'pexels-key') {
  return new ContentCredentialResolver({
    env: key === null ? {} : { PEXELS_API_KEY: key },
    keychainPresent: () => Promise.resolve(false),
    keychainRead: () => Promise.reject(new Error('none'))
  });
}

const request = {
  query: 'rainy city street at night',
  orientation: 'portrait' as const,
  count: 3,
  timeoutMs: 30_000
};

const bodyWithOneVideo = {
  videos: [
    {
      id: 987,
      width: 1080,
      height: 1920,
      duration: 12,
      url: 'https://www.pexels.com/video/987',
      user: { name: 'A Creator' },
      video_files: [
        {
          link: 'https://cdn/sd.mp4',
          quality: 'sd',
          file_type: 'video/mp4',
          width: 540,
          height: 960
        },
        {
          link: 'https://cdn/hd.mp4',
          quality: 'hd',
          file_type: 'video/mp4',
          width: 1080,
          height: 1920
        }
      ]
    },
    { id: 5, video_files: [] } // dropped: no usable file
  ]
};

function jsonFetch(body: unknown, status = 200) {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      })
    )) as unknown as typeof fetch;
}

describe('PexelsVisualProvider', () => {
  it('probes available only with a credential and is not premium', async () => {
    const p = await new PexelsVisualProvider({ credentials: keyedResolver() }).probe();
    expect(p).toMatchObject({ available: true, premium: false, costBasis: 'free_api' });
    expect(
      (await new PexelsVisualProvider({ credentials: keyedResolver(null) }).probe()).available
    ).toBe(false);
  });

  it('parses videos into assets with provenance and the best-quality link', async () => {
    const fetchImpl = vi.fn(jsonFetch(bodyWithOneVideo));
    const provider = new PexelsVisualProvider({ credentials: keyedResolver('pk'), fetchImpl });
    const result = await provider.query(request);

    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({
      provider: 'pexels',
      assetId: 'pexels-987',
      sourceRef: 'https://cdn/hd.mp4',
      license: 'pexels_license',
      provenanceRef: 'https://www.pexels.com/video/987',
      author: 'A Creator',
      durationSeconds: 12,
      requiresManualProduction: false
    });
    const url = (fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]?.[0] ?? '';
    expect(url).toContain('orientation=portrait');
    expect(url).toContain('per_page=3');
    const init = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0];
    expect((init?.[1]?.headers as Record<string, string>).Authorization).toBe('pk');
  });

  it('maps auth, rate-limit, and server errors', async () => {
    const make = (status: number) =>
      new PexelsVisualProvider({ credentials: keyedResolver(), fetchImpl: jsonFetch({}, status) });
    await expect(make(401).query(request)).rejects.toMatchObject({ kind: 'auth' });
    await expect(make(429).query(request)).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(make(503).query(request)).rejects.toMatchObject({
      kind: 'runtime',
      retriable: true
    });
  });

  it('fails closed without a credential and on empty query', async () => {
    await expect(
      new PexelsVisualProvider({
        credentials: keyedResolver(null),
        fetchImpl: jsonFetch({})
      }).query(request)
    ).rejects.toMatchObject({ kind: 'not_credentialed' });
    await expect(
      new PexelsVisualProvider({ credentials: keyedResolver(), fetchImpl: jsonFetch({}) }).query({
        ...request,
        query: '   '
      })
    ).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('maps a network failure and a timeout to typed transient errors', async () => {
    const unreachable = new PexelsVisualProvider({
      credentials: keyedResolver(),
      fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch
    });
    await expect(unreachable.query(request)).rejects.toMatchObject({ kind: 'unavailable' });

    const timeoutError = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const timedOut = new PexelsVisualProvider({
      credentials: keyedResolver(),
      fetchImpl: (() => Promise.reject(timeoutError)) as unknown as typeof fetch
    });
    await expect(timedOut.query(request)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('rejects a malformed (non-JSON) response body', async () => {
    const provider = new PexelsVisualProvider({
      credentials: keyedResolver(),
      fetchImpl: (() =>
        Promise.resolve(new Response('not json', { status: 200 }))) as unknown as typeof fetch
    });
    await expect(provider.query(request)).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('returns an empty asset list when the API has no videos', async () => {
    const provider = new PexelsVisualProvider({
      credentials: keyedResolver(),
      fetchImpl: jsonFetch({ videos: [] })
    });
    expect((await provider.query(request)).assets).toEqual([]);
  });
});
