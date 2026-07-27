import { AppError } from '../../utils/errors';
import { sha256 } from '../system/hashing';

/**
 * The experiment program's only source of randomness.
 *
 * `Math.random()` is banned repo-wide because the report's operational definition
 * of determinism requires that the same seed, replay log, and simulated clock
 * reproduce the same writes, candidates, compiled context, and output bytes. A
 * global RNG cannot satisfy that: its stream depends on how many draws every
 * earlier stage happened to make, so adding one distractor to a generator stage
 * silently reshuffles every later stage and the "identical seed" guarantee dies.
 *
 * This module therefore provides splitmix64 (Steele/Lea/Flood), a 64-bit counter
 * generator with no correlated seed families, plus {@link DeterministicPrng.derive}
 * for named child streams. Streams are keyed by `(rootSeed, labelPath)` and never
 * by the parent's consumption count, which is what keeps the stages independent.
 *
 * All arithmetic is BigInt masked to 64 bits: JavaScript numbers cannot hold the
 * multiplications below without losing low-order bits, and losing low-order bits
 * would make the generator's output platform-dependent.
 */

const MASK_64 = 0xffff_ffff_ffff_ffffn;
const GOLDEN_GAMMA = 0x9e37_79b9_7f4a_7c15n;
const MIX_MULTIPLIER_A = 0xbf58_476d_1ce4_e5b9n;
const MIX_MULTIPLIER_B = 0x94d0_49bb_1331_11ebn;
const TWO_POW_32 = 0x1_0000_0000;
const MAX_SEED = Number.MAX_SAFE_INTEGER;
const LABEL_PATTERN = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;

/**
 * Raised on any argument that would make a draw non-uniform, non-terminating, or
 * ambiguous. The generator fails closed rather than clamping: a silently clamped
 * bound would produce a plausible-looking dataset whose distribution no longer
 * matches the tier schedule it claims to implement.
 */
export class DeterministicPrngError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'DETERMINISTIC_PRNG_INVALID_ARGUMENT', message, details);
  }
}

function mix64(value: bigint): bigint {
  let z = value & MASK_64;
  z = ((z ^ (z >> 30n)) * MIX_MULTIPLIER_A) & MASK_64;
  z = ((z ^ (z >> 27n)) * MIX_MULTIPLIER_B) & MASK_64;
  return (z ^ (z >> 31n)) & MASK_64;
}

/**
 * Maps an arbitrary label to 64 bits through sha256 rather than through a cheap
 * string hash. Two sibling stages ("distractors" and "distractor") must not land
 * on adjacent seeds: splitmix64 decorrelates adjacent seeds well, but a weak label
 * hash can still collide outright, which would entangle the very stages `derive`
 * exists to separate.
 */
function labelSeed(labelPath: string): bigint {
  return BigInt(`0x${sha256(labelPath).slice(0, 16)}`) & MASK_64;
}

function assertSafeSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new DeterministicPrngError(
      `A PRNG seed must be an integer in [0, ${MAX_SEED}]; received ${String(seed)}`,
      { seed }
    );
  }
}

function assertValidLabel(label: string): void {
  if (!LABEL_PATTERN.test(label)) {
    throw new DeterministicPrngError(
      `A stream label must match ${LABEL_PATTERN.source}; received '${label}'`,
      { label }
    );
  }
}

/**
 * A named, reproducible stream of 64-bit values.
 *
 * The stream is mutable by design (drawing advances it), but its identity —
 * `seed` and `path` — is immutable, so a child stream derived from it is a pure
 * function of that identity. Reconstructing a `DeterministicPrng` with the same
 * seed replays the same sequence on any platform and any Node release.
 */
export class DeterministicPrng {
  /** The 64-bit stream seed, after label mixing. Stable for the stream's lifetime. */
  readonly seed: bigint;

  /** Dotted lineage of `derive` labels, e.g. `root.sessions.distractors`. */
  readonly path: string;

  private state: bigint;

  private constructor(seed: bigint, path: string) {
    this.seed = seed & MASK_64;
    this.path = path;
    this.state = this.seed;
  }

  /**
   * Creates a root stream from an integer seed recorded in the run manifest.
   *
   * The path is mixed INTO the seed, not merely carried alongside it. Without that,
   * `fromSeed(7, 'workload')` and `fromSeed(7, 'privacy')` emit the identical
   * sequence — two components that the manifest presents as independent would draw
   * the same numbers, and any effect measured across them would be an artifact of
   * shared randomness rather than a result. Child streams already mix via
   * {@link labelSeed} in `derive`; roots have to obey the same rule for the class
   * invariant "streams are keyed by (rootSeed, labelPath)" to actually hold.
   */
  static fromSeed(seed: number, path = 'root'): DeterministicPrng {
    assertSafeSeed(seed);
    assertValidLabel(path);
    return new DeterministicPrng(mix64(BigInt(seed) ^ labelSeed(path)), path);
  }

  /** Raw 64-bit draw. Public so a caller can build its own derived distribution. */
  nextUint64(): bigint {
    this.state = (this.state + GOLDEN_GAMMA) & MASK_64;
    return mix64(this.state);
  }

  /** The high 32 bits of a draw, which are the best-mixed half of splitmix64's output. */
  nextUint32(): number {
    return Number(this.nextUint64() >> 32n);
  }

  /**
   * Uniform integer in `[0, bound)`.
   *
   * Uses rejection sampling instead of `% bound`. Modulo folding biases the low
   * residues whenever `bound` does not divide 2^32, and the generator's whole job
   * here is to make tier knobs (session counts, update counts, distractor counts)
   * land where the schedule says they land. Rejection terminates deterministically:
   * the rejected draws are part of the reproducible stream.
   */
  nextInt(bound: number): number {
    if (!Number.isInteger(bound) || bound < 1 || bound > TWO_POW_32) {
      throw new DeterministicPrngError(
        `nextInt bound must be an integer in [1, 2^32]; received ${String(bound)}`,
        { bound }
      );
    }
    const limit = TWO_POW_32 - (TWO_POW_32 % bound);
    let draw = this.nextUint32();
    while (draw >= limit) {
      draw = this.nextUint32();
    }
    return draw % bound;
  }

  /** Uniform integer in the inclusive band `[min, max]`, the shape the tier schedule uses. */
  nextIntInclusive(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new DeterministicPrngError(
        `nextIntInclusive requires integers with max >= min; received [${String(min)}, ${String(max)}]`,
        { min, max }
      );
    }
    return min + this.nextInt(max - min + 1);
  }

  /** Uniform element. Empty input throws: an empty pick has no fail-closed default value. */
  pick<Value>(values: readonly Value[]): Value {
    if (values.length === 0) {
      throw new DeterministicPrngError('pick() requires a non-empty array');
    }
    const chosen = values[this.nextInt(values.length)];
    if (chosen === undefined) {
      throw new DeterministicPrngError('pick() drew an index outside the array');
    }
    return chosen;
  }

  /**
   * Fisher-Yates permutation into a NEW array; the input is never mutated. Purity
   * matters because generator stages share frozen template tables, and an in-place
   * shuffle would let one item's generation reorder the next item's templates.
   */
  shuffle<Value>(values: readonly Value[]): Value[] {
    const result = values.slice();
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = this.nextInt(index + 1);
      const left = result[index];
      const right = result[swapIndex];
      if (left === undefined || right === undefined) continue;
      result[index] = right;
      result[swapIndex] = left;
    }
    return result;
  }

  /** The first `count` elements of a permutation: sampling without replacement. */
  sample<Value>(values: readonly Value[], count: number): Value[] {
    if (!Number.isInteger(count) || count < 0) {
      throw new DeterministicPrngError(
        `sample() count must be a non-negative integer; received ${String(count)}`,
        { count }
      );
    }
    if (count > values.length) {
      throw new DeterministicPrngError(
        `sample() cannot draw ${count} of ${values.length} values without replacement`,
        { count, available: values.length }
      );
    }
    return this.shuffle(values).slice(0, count);
  }

  /**
   * An independent child stream for one generation stage.
   *
   * Derived from the parent's IDENTITY (`seed`, `path`) and never from its current
   * state, so a child's sequence is fixed the moment the root seed is chosen. That
   * is the entanglement guard: adding, removing, or reordering draws in the
   * "sessions" stage cannot shift a single value produced by the "adversarial"
   * stage, which is what makes a regression in one stage debuggable in isolation.
   */
  derive(label: string): DeterministicPrng {
    assertValidLabel(label);
    const childPath = `${this.path}.${label}`;
    return new DeterministicPrng(mix64(this.seed ^ labelSeed(childPath)), childPath);
  }
}

/** Convenience factory mirroring the repo's `createX` naming. */
export function createPrng(seed: number, path = 'root'): DeterministicPrng {
  return DeterministicPrng.fromSeed(seed, path);
}
