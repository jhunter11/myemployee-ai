import { describe, expect, it } from 'vitest';

import type { DeterministicPrng } from '../../../src/memory/experiment/prng';
import { DeterministicPrngError, createPrng } from '../../../src/memory/experiment/prng';

function drawMany(prng: DeterministicPrng, count: number): number[] {
  return Array.from({ length: count }, () => prng.nextUint32());
}

describe('deterministic prng', () => {
  it('reproduces a golden sequence, pinning the algorithm itself', () => {
    // A regression here means the stream changed shape: every frozen dataset seed,
    // every recorded historyHash, and every replay manifest would silently drift.
    // Re-pinned once, deliberately: root streams now mix their label into the seed
    // (see `fromSeed`), which moved every root sequence. Nothing had been recorded
    // against the old values yet, so this was the last cost-free moment to fix it.
    expect(drawMany(createPrng(17), 4)).toEqual([2139432730, 724176477, 1263710286, 1167134011]);
    expect(createPrng(17).nextUint64()).toBe(9188793609613289666n);
    expect(drawMany(createPrng(17).derive('sessions'), 2)).toEqual([516116567, 1495915431]);
  });

  it('separates root streams by label, not just child streams', () => {
    // The class invariant is that a stream is keyed by (rootSeed, labelPath). While
    // `fromSeed` stored the label without mixing it in, two components the manifest
    // presents as independent — say the workload generator and the privacy suite —
    // drew the identical sequence from a shared seed. Any effect measured across
    // them would then be an artifact of shared randomness, not a result.
    expect(drawMany(createPrng(17, 'workload'), 8)).not.toEqual(
      drawMany(createPrng(17, 'privacy'), 8)
    );
    // Still a pure function of (seed, path): same pair, same stream.
    expect(drawMany(createPrng(17, 'workload'), 8)).toEqual(
      drawMany(createPrng(17, 'workload'), 8)
    );
  });

  it('produces an identical sequence for the same seed', () => {
    expect(drawMany(createPrng(4_242), 64)).toEqual(drawMany(createPrng(4_242), 64));
  });

  it('produces a different sequence for a different seed', () => {
    expect(drawMany(createPrng(4_242), 64)).not.toEqual(drawMany(createPrng(4_243), 64));
  });

  it('decorrelates adjacent seeds rather than shifting one stream into the next', () => {
    const left = drawMany(createPrng(1), 32);
    const right = drawMany(createPrng(2), 32);
    const overlap = left.filter((value) => right.includes(value));
    expect(overlap).toEqual([]);
  });

  it('keeps nextInt inside the bound and rejects unusable bounds', () => {
    const prng = createPrng(9);
    for (let index = 0; index < 500; index += 1) {
      const draw = prng.nextInt(7);
      expect(draw).toBeGreaterThanOrEqual(0);
      expect(draw).toBeLessThan(7);
    }
    expect(createPrng(9).nextInt(1)).toBe(0);
    expect(() => createPrng(9).nextInt(0)).toThrow(DeterministicPrngError);
    expect(() => createPrng(9).nextInt(-3)).toThrow(DeterministicPrngError);
    expect(() => createPrng(9).nextInt(2.5)).toThrow(DeterministicPrngError);
    expect(() => createPrng(9).nextInt(2 ** 32 + 1)).toThrow(DeterministicPrngError);
  });

  it('covers every residue of a bound that does not divide 2^32', () => {
    // Modulo folding would still cover every residue; what it would break is the
    // balance between them, so assert the low residues are not over-represented.
    const prng = createPrng(31);
    const counts = new Map<number, number>();
    for (let index = 0; index < 6_000; index += 1) {
      const draw = prng.nextInt(7);
      counts.set(draw, (counts.get(draw) ?? 0) + 1);
    }
    expect([...counts.keys()].sort((left, right) => left - right)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(700);
      expect(count).toBeLessThan(1_000);
    }
  });

  it('draws inclusive bands and rejects inverted ones', () => {
    const prng = createPrng(5);
    for (let index = 0; index < 200; index += 1) {
      const draw = prng.nextIntInclusive(3, 5);
      expect(draw).toBeGreaterThanOrEqual(3);
      expect(draw).toBeLessThanOrEqual(5);
    }
    expect(createPrng(5).nextIntInclusive(4, 4)).toBe(4);
    expect(() => createPrng(5).nextIntInclusive(6, 5)).toThrow(DeterministicPrngError);
    expect(() => createPrng(5).nextIntInclusive(1.5, 5)).toThrow(DeterministicPrngError);
  });

  it('rejects seeds that cannot be represented exactly', () => {
    expect(() => createPrng(-1)).toThrow(DeterministicPrngError);
    expect(() => createPrng(1.5)).toThrow(DeterministicPrngError);
    expect(() => createPrng(Number.MAX_SAFE_INTEGER + 2)).toThrow(DeterministicPrngError);
  });

  it('picks only real elements and fails closed on an empty array', () => {
    const values = ['a', 'b', 'c'] as const;
    const prng = createPrng(11);
    for (let index = 0; index < 100; index += 1) {
      expect(values).toContain(prng.pick(values));
    }
    expect(() => createPrng(11).pick([])).toThrow(DeterministicPrngError);
  });

  it('shuffles into a true permutation without mutating the input', () => {
    const input = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const shuffled = createPrng(77).shuffle(input);
    expect(shuffled).toHaveLength(input.length);
    expect([...shuffled].sort((left, right) => left - right)).toEqual([...input]);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(createPrng(77).shuffle(input)).toEqual(shuffled);
  });

  it('actually reorders rather than returning the identity', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const permutations = [1, 2, 3, 4, 5].map((seed) => createPrng(seed).shuffle(input));
    expect(permutations.some((permutation) => !permutation.every((v, i) => v === input[i]))).toBe(
      true
    );
  });

  it('samples without replacement and refuses to over-draw', () => {
    const input = [1, 2, 3, 4, 5];
    const sample = createPrng(3).sample(input, 3);
    expect(sample).toHaveLength(3);
    expect(new Set(sample).size).toBe(3);
    for (const value of sample) expect(input).toContain(value);
    expect(createPrng(3).sample(input, 0)).toEqual([]);
    expect(() => createPrng(3).sample(input, 6)).toThrow(DeterministicPrngError);
    expect(() => createPrng(3).sample(input, -1)).toThrow(DeterministicPrngError);
  });

  it('derives child streams that differ from the parent and from each other', () => {
    const root = createPrng(101);
    const left = drawMany(root.derive('sessions'), 16);
    const right = drawMany(root.derive('distractors'), 16);
    const parent = drawMany(createPrng(101), 16);
    expect(left).not.toEqual(right);
    expect(left).not.toEqual(parent);
  });

  it('keeps a child stream independent of how much the parent consumed', () => {
    // This is the entanglement guard: adding a draw to one generation stage must
    // not shift a single value produced by any other stage.
    const untouched = createPrng(55);
    const consumed = createPrng(55);
    drawMany(consumed, 1_000);
    expect(drawMany(consumed.derive('artifacts'), 16)).toEqual(
      drawMany(untouched.derive('artifacts'), 16)
    );
  });

  it('keeps derived lineages distinct by path, not just by label', () => {
    const root = createPrng(8);
    const nested = root.derive('a').derive('b');
    const flat = root.derive('b');
    expect(nested.path).toBe('root.a.b');
    expect(flat.path).toBe('root.b');
    expect(drawMany(nested, 8)).not.toEqual(drawMany(flat, 8));
  });

  it('rejects stream labels that could collide once joined into a path', () => {
    const root = createPrng(8);
    expect(() => root.derive('Sessions')).toThrow(DeterministicPrngError);
    expect(() => root.derive('')).toThrow(DeterministicPrngError);
    expect(() => root.derive('a b')).toThrow(DeterministicPrngError);
    expect(() => root.derive('_leading')).toThrow(DeterministicPrngError);
  });
});
