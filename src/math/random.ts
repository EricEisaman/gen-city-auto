// Deterministic PRNG (sfc32) and hash helpers. Every generator takes a seed so
// the same (city type, seed) builds the same city everywhere.

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    this.a = 0x9e3779b9;
    this.b = 0x243f6a88;
    this.c = 0xb7e15162;
    this.d = seed >>> 0;
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  nextU32() {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    const t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    const r = (t + this.d) | 0;
    this.c = (this.c + r) | 0;
    return r >>> 0;
  }

  /** Uniform float in [0, 1). */
  next() {
    return this.nextU32() / 4294967296;
  }

  range(lo: number, hi: number) {
    return lo + (hi - lo) * this.next();
  }

  int(lo: number, hiExclusive: number) {
    return lo + Math.floor(this.next() * (hiExclusive - lo));
  }

  chance(p: number) {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Weighted pick: weights need not be normalized. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** Roughly normal distribution (sum of uniforms). */
  gauss(mean = 0, sd = 1) {
    return (
      mean +
      sd * (this.next() + this.next() + this.next() + this.next() - 2) * 1.732
    );
  }

  fork(salt: number) {
    return new Rng(hash2(this.nextU32(), salt));
  }
}

export function hash1(x: number) {
  x = Math.imul((x >>> 16) ^ x, 0x45d9f3b) >>> 0;
  x = Math.imul((x >>> 16) ^ x, 0x45d9f3b) >>> 0;
  return ((x >>> 16) ^ x) >>> 0;
}

export function hash2(x: number, y: number) {
  return hash1((x | 0) ^ hash1((y | 0) + 0x9e3779b9));
}

export function hash3(x: number, y: number, z: number) {
  return hash1(hash2(x, y) ^ hash1((z | 0) + 0x7f4a7c15));
}

/** Hash to float in [0, 1). */
export const hashf = (x: number, y = 0, z = 0) => hash3(x, y, z) / 4294967296;
