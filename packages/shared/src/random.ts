/**
 * Seeded randomness (spec §53 "deterministic").
 *
 * Every non-deterministic draw in the emulator -- id generation, latency
 * jitter, chaos failure sampling, fixture selection -- comes from here. With
 * PAYBOX_SEED set, two runs of the same input sequence produce byte-identical
 * output, which is what makes the emulator usable in CI.
 *
 * `fork()` is the load-bearing part. If the webhook dispatcher and the id
 * generator shared one stream, adding a single retry would shift every
 * subsequent id and break unrelated snapshot tests. Each subsystem forks its
 * own labelled stream instead, so draws in one never perturb another.
 */
export interface Random {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Lowercase hex string of `bytes` bytes. */
  hex(bytes: number): string;
  /** Uniformly pick one element. Throws on an empty array. */
  pick<T>(items: readonly T[]): T;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** A derived, independently-advancing stream. Same label => same stream. */
  fork(label: string): Random;
}

/** FNV-1a, used to turn a seed string into 32 bits of state. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** SplitMix32 -- used only to expand one seed word into the four we need. */
function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
}

class Xoshiro128 implements Random {
  #s: [number, number, number, number];
  readonly #seed: string;

  constructor(seed: string) {
    this.#seed = seed;
    const mix = splitmix32(fnv1a(seed));
    this.#s = [mix(), mix(), mix(), mix()];
    // A zero state is absorbing; nudge it if the seed happened to produce one.
    if (this.#s.every((w) => w === 0)) this.#s[0] = 1;
    // Discard the first few outputs so low-entropy seeds ("1", "test") do not
    // produce visibly correlated first draws.
    for (let i = 0; i < 16; i++) this.#raw();
  }

  /** xoshiro128** -- 32-bit output, 2^128 period. */
  #raw(): number {
    const [s0, s1, s2, s3] = this.#s;
    const result = (Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0) as number;
    const t = (s1 << 9) >>> 0;
    let a = s2 ^ s0;
    let b = s3 ^ s1;
    this.#s[1] = (s1 ^ a) >>> 0;
    this.#s[0] = (s0 ^ b) >>> 0;
    this.#s[2] = (a ^ t) >>> 0;
    this.#s[3] = rotl(b, 11);
    return result >>> 0;
  }

  next(): number {
    // 53-bit mantissa from two 32-bit draws, so next() is uniform over the
    // full double precision range rather than a 2^-32 lattice.
    const hi = this.#raw() >>> 5;
    const lo = this.#raw() >>> 6;
    return (hi * 67108864 + lo) / 9007199254740992;
  }

  int(min: number, max: number): number {
    if (max < min) throw new RangeError(`int(${min}, ${max}): max < min`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  hex(bytes: number): string {
    let out = '';
    for (let i = 0; i < bytes; i++) {
      out += (this.#raw() & 0xff).toString(16).padStart(2, '0');
    }
    return out;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick() on an empty array');
    return items[this.int(0, items.length - 1)]!;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  fork(label: string): Random {
    return new Xoshiro128(`${this.#seed}::${label}`);
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export function createRandom(seed: string): Random {
  return new Xoshiro128(seed);
}
