import { describe, expect, it } from 'vitest';

import { renderResolution } from '../../src/content/content-connections-cli';
import type { ContentProviderResolution } from '../../src/content/providers/content-provider-catalog';

const resolution: ContentProviderResolution = {
  voice: {
    availability: [
      {
        provider: 'local_say',
        available: true,
        costBasis: 'local',
        premium: false,
        detail: 'local ok'
      },
      {
        provider: 'elevenlabs',
        available: false,
        costBasis: 'metered',
        premium: true,
        detail: 'no credential connected'
      }
    ],
    starter: 'local_say',
    premiumReady: []
  },
  visual: {
    availability: [
      {
        provider: 'pexels',
        available: true,
        costBasis: 'free_api',
        premium: false,
        detail: 'credential present (env)'
      },
      {
        provider: 'local_title_card',
        available: true,
        costBasis: 'local',
        premium: false,
        detail: 'local ok'
      },
      {
        provider: 'higgsfield',
        available: true,
        costBasis: 'subscription',
        premium: true,
        detail: 'credential present (env)'
      }
    ],
    starter: 'pexels',
    premiumReady: ['higgsfield']
  }
};

describe('content connections CLI rendering', () => {
  it('renders each lane, marks up/down and free/premium, and never prints a key', () => {
    const out: string[] = [];
    renderResolution(resolution, {
      stdout: (m) => out.push(m),
      stderr: () => undefined
    });
    const text = out.join('\n');
    expect(text).toContain('Narration (voice)');
    expect(text).toContain('[up  ] local_say');
    expect(text).toContain('[down] elevenlabs');
    expect(text).toContain('starter -> local_say');
    expect(text).toContain('starter -> pexels');
    expect(text).toContain('premium ready -> higgsfield');
    // Never leaks a secret: the detail strings are the only source and are curated.
    expect(text).not.toMatch(/PEXELS_API_KEY=|xi-key|hf-key/);
  });
});
