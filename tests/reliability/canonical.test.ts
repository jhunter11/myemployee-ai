import { describe, expect, it } from 'vitest';

import {
  assertCanonicalJson,
  canonicalUtcTimestamp,
  canonicalizeJson,
  domainSeparatedSha256,
  frameLengthPrefixedFields,
  parseStrictJson
} from '../../src/reliability/canonical';

describe('reliability canonical evidence protocol', () => {
  it('canonicalizes nested JSON with recursively sorted keys and no insignificant whitespace', () => {
    expect(
      canonicalizeJson({
        z: 3,
        nested: { beta: 'é', alpha: true },
        array: [{ second: 2, first: 1 }, null]
      })
    ).toBe('{"array":[{"first":1,"second":2},null],"nested":{"alpha":true,"beta":"é"},"z":3}');
    const scalar = 'quote:" slash:/ backslash:\\ controls:\u0000\b\f\n\r\t emoji:😀';
    expect(canonicalizeJson(scalar)).toBe(JSON.stringify(scalar));
  });

  it('rejects values that cannot have one lossless JSON identity', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = new Array<unknown>(1);
    const withAccessor = Object.defineProperty({}, 'unsafe', {
      enumerable: true,
      get: () => 'side effect'
    });

    for (const value of [
      -0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      1n,
      Symbol('x'),
      () => undefined,
      new Date('2026-07-22T00:00:00.000Z'),
      sparse,
      withAccessor,
      cyclic,
      '\ud800'
    ]) {
      expect(() => canonicalizeJson(value)).toThrow();
    }
  });

  it('parses JSON while rejecting duplicate keys at every nesting level', () => {
    expect(parseStrictJson(' { "b": 2, "a": [true, null, "ok"] } ')).toEqual({
      b: 2,
      a: [true, null, 'ok']
    });

    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow(/duplicate/iu);
    expect(() => parseStrictJson('{"outer":{"a":1,"a":2}}')).toThrow(/duplicate/iu);
    expect(() => parseStrictJson('{"a":1} trailing')).toThrow(/trailing/iu);
    expect(() => parseStrictJson('{"n":-0}')).toThrow(/negative zero/iu);
    expect(() => parseStrictJson('"\\ud800"')).toThrow(/surrogate/iu);
  });

  it('covers empty/scalar grammar and rejects malformed parser boundaries', () => {
    expect(canonicalizeJson(false)).toBe('false');
    expect(() => canonicalizeJson('\udc00')).toThrow(/surrogate/iu);
    expect(parseStrictJson('false')).toBe(false);
    expect(parseStrictJson('{}')).toEqual({});
    expect(parseStrictJson('[]')).toEqual([]);

    for (const malformed of [
      '',
      '{1:2}',
      '"control\ncharacter"',
      '"' + '\\',
      '"\\u12xz"',
      '-',
      '1e9999',
      'truX',
      '{"key" 1}'
    ]) {
      expect(() => parseStrictJson(malformed)).toThrow();
    }
  });

  it('keeps parser limits and duplicate-key failures bounded', () => {
    expect(() => canonicalizeJson([], { maxDepth: 10_000 })).toThrow(/maxDepth/iu);
    expect(() => parseStrictJson('[]', { maxBytes: Number.MAX_SAFE_INTEGER })).toThrow(
      /maxBytes/iu
    );
    expect(() => canonicalizeJson('\u0000'.repeat(10_000), { maxBytes: 128 })).toThrow(
      /byte limit/iu
    );

    const duplicateKey = 'sensitive'.repeat(20_000);
    let failure: unknown;
    try {
      parseStrictJson(`{"${duplicateKey}":1,"${duplicateKey}":2}`);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/duplicate/iu);
    expect((failure as Error).message.length).toBeLessThan(256);
    expect((failure as Error).message).not.toContain(duplicateKey);
  });

  it('distinguishes valid JSON from its unique canonical representation', () => {
    const canonical = '{"a":1,"b":[2,3]}';

    expect(assertCanonicalJson(canonical)).toEqual({ a: 1, b: [2, 3] });
    expect(() => assertCanonicalJson('{ "a": 1, "b": [2, 3] }')).toThrow(/noncanonical/iu);
    expect(() => assertCanonicalJson('{"b":[2,3],"a":1}')).toThrow(/noncanonical/iu);
  });

  it('frames every UTF-8 field with an unsigned 32-bit big-endian byte length', () => {
    const framed = frameLengthPrefixedFields('example:v1', ['é', 'x']);

    expect(framed.toString('hex')).toBe('0000000a6578616d706c653a763100000002c3a90000000178');
  });

  it('produces stable domain-separated hashes without delimiter collisions', () => {
    expect(
      domainSeparatedSha256('occurrence:v1', ['daily_report', '7', '2026-07-22T13:00:00.000Z'])
    ).toBe('25c3ebed175138d412fbe27c25b1a2baaebd2ec013c91cd36ea1a9b588b1dd03');
    expect(domainSeparatedSha256('example:v1', ['ab', 'c'])).toBe(
      'b78bce0c522ba505a037c1aac37fd571fbe429958148427ced608aded1958a17'
    );
    expect(domainSeparatedSha256('example:v1', ['a', 'bc'])).toBe(
      '470840c9a7d8dbfc87074e5b14dba1790f9e02d3ef3b673eb5396dbb3d5a37f4'
    );
  });

  it('rejects invalid domain tags and oversized fields before hashing', () => {
    expect(() => domainSeparatedSha256('Occurrence V1', ['safe'])).toThrow(/domain/iu);
    expect(() => domainSeparatedSha256('occurrence:v1', ['x'.repeat(1_048_577)])).toThrow(
      /field/iu
    );
  });

  it('normalizes exact UTC RFC 3339 instants and rejects offsets or impossible dates', () => {
    expect(canonicalUtcTimestamp('2026-07-22T13:00:00Z')).toBe('2026-07-22T13:00:00.000Z');
    expect(canonicalUtcTimestamp('2026-07-22T13:00:00.120Z')).toBe('2026-07-22T13:00:00.120Z');
    expect(() => canonicalUtcTimestamp('2026-07-22T09:00:00-04:00')).toThrow(/UTC/iu);
    expect(() => canonicalUtcTimestamp('2026-02-30T00:00:00Z')).toThrow(/RFC 3339/iu);
  });
});
