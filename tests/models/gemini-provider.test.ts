import { describe, expect, it } from 'vitest';

import { type ModelGenerationRequest } from '../../src/models/contracts';
import {
  classifyGeminiCliFailure,
  GeminiProvider,
  parseGeminiCliResponse
} from '../../src/models/gemini-provider';

const request: ModelGenerationRequest = {
  system: 'You are Jarvis.',
  messages: [{ role: 'user', content: 'status?' }],
  maxOutputTokens: 256,
  timeoutMs: 60_000
};

describe('GeminiProvider', () => {
  it('keeps CLI generation hard-disabled with no execution opt-in', async () => {
    const provider = new GeminiProvider();

    await expect(provider.generate('economy', request)).rejects.toMatchObject({
      provider: 'gemini',
      kind: 'unavailable',
      retriable: false
    });
    await expect(provider.probe()).resolves.toEqual({
      provider: 'gemini',
      available: false,
      detail: 'Gemini CLI execution is disabled pending a separately reviewed runtime'
    });
  });

  it('still advertises its logical routes and concrete model mapping without executing', () => {
    const provider = new GeminiProvider({
      models: { frontier: 'gemini-reviewed-frontier' }
    });

    expect(provider.servesRoute('local')).toBe(false);
    expect(provider.servesRoute('economy')).toBe(true);
    expect(provider.servesRoute('frontier')).toBe(true);
    expect(provider.modelForRoute('frontier')).toBe('gemini-reviewed-frontier');
  });
});

describe('parseGeminiCliResponse', () => {
  it('reads current per-model token metrics without inventing missing usage', () => {
    const parsed = parseGeminiCliResponse(
      JSON.stringify({
        response: 'All systems nominal.',
        stats: {
          models: {
            'gemini-2.5-pro': {
              tokens: {
                input: 30,
                prompt: 40,
                candidates: 6,
                cached: 10
              }
            }
          }
        }
      }),
      'gemini-2.5-pro'
    );

    expect(parsed).toEqual({
      text: 'All systems nominal.',
      tokensIn: 30,
      tokensOut: 6,
      cacheReadTokens: 10
    });
  });

  it('uses prompt tokens only as a compatibility fallback and rejects invalid counters', () => {
    const parsed = parseGeminiCliResponse(
      JSON.stringify({
        response: 'ok',
        stats: {
          models: {
            'gemini-2.5-flash': {
              tokens: {
                input: 'not-a-number',
                prompt: 11,
                candidates: 4.9,
                cached: -1
              }
            }
          }
        }
      }),
      'gemini-2.5-flash'
    );

    expect(parsed).toEqual({
      text: 'ok',
      tokensIn: 11,
      tokensOut: 4,
      cacheReadTokens: null
    });
  });

  it.each([
    ['malformed JSON', 'not json'],
    ['missing response', JSON.stringify({ stats: { models: {} } })],
    ['structured error', JSON.stringify({ response: 'unsafe partial', error: { code: 500 } })]
  ])('returns null for %s', (_label, stdout) => {
    expect(parseGeminiCliResponse(stdout, 'gemini-2.5-pro')).toBeNull();
  });
});

describe('classifyGeminiCliFailure', () => {
  it.each([
    ['numeric 429', { code: 429 }],
    ['string 429', { code: '429' }],
    ['RESOURCE_EXHAUSTED status', { status: 'RESOURCE_EXHAUSTED' }],
    ['RESOURCE_EXHAUSTED type', { type: 'resource_exhausted' }],
    [
      'Google RetryInfo metadata',
      {
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '40s'
          }
        ]
      }
    ]
  ])('classifies structured %s as a rate limit', (_label, error) => {
    expect(classifyGeminiCliFailure(JSON.stringify({ response: null, error }), '')).toMatchObject({
      kind: 'rate_limited',
      retriable: true
    });
  });

  it.each([
    ['RESOURCE_EXHAUSTED', 'API error: RESOURCE_EXHAUSTED'],
    ['standalone 429', 'API error: 429 - Resource exhausted']
  ])('classifies stderr %s as a rate limit', (_label, stderr) => {
    expect(classifyGeminiCliFailure('', stderr)).toMatchObject({
      kind: 'rate_limited',
      retriable: true
    });
  });

  it.each([
    ['quota project text', '', 'Authentication failed: quota project is missing'],
    [
      'quota-named structured type',
      JSON.stringify({ error: { type: 'QuotaProjectMissingError' } }),
      ''
    ],
    [
      'quota-exceeded wording without status',
      JSON.stringify({ error: { type: 'QuotaExceededError' } }),
      ''
    ],
    ['bare rate-limit wording', '', 'Request rate-limit exceeded'],
    ['embedded resource status', '', 'internal NOT_RESOURCE_EXHAUSTED marker'],
    ['429 embedded in a larger number', '', 'internal reference 14290'],
    [
      'malformed RetryInfo metadata',
      JSON.stringify({
        error: {
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.RetryInfo',
              retryDelay: 'eventually'
            }
          ]
        }
      }),
      ''
    ]
  ])('does not misclassify %s as a rate limit', (_label, stdout, stderr) => {
    expect(classifyGeminiCliFailure(stdout, stderr).kind).not.toBe('rate_limited');
  });

  it('maps authentication failures without retaining stderr', () => {
    const privateStderr =
      'IneligibleTierError: authentication required for private-user@example.com';
    const failure = classifyGeminiCliFailure('', privateStderr);

    expect(failure).toEqual({
      kind: 'auth',
      retriable: false,
      message: 'subscription ineligible or not authenticated'
    });
    expect(failure.message).not.toContain(privateStderr);
  });

  it('maps all other unusable output to a sanitized retriable protocol failure', () => {
    const failure = classifyGeminiCliFailure(
      JSON.stringify({ error: { message: 'private provider response' } }),
      'private stderr'
    );

    expect(failure).toEqual({
      kind: 'protocol',
      retriable: true,
      message: 'CLI returned no usable response'
    });
    expect(failure.message).not.toContain('private');
  });
});
