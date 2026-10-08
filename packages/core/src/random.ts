// Uniform integer in [0, n). Injectable so tests can be deterministic.
export type RandomInt = (n: number) => number;

// crypto-backed, with rejection sampling so there is no modulo bias.
export const cryptoRandomInt: RandomInt = (n) => {
  if (!Number.isSafeInteger(n) || n < 1 || n > 2 ** 32) throw new RangeError(`bad range ${n}`);
  const limit = Math.floor(2 ** 32 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % n;
  }
};

// Deterministic generator for tests and replays (mulberry32).
export function seededRandomInt(seed: number): RandomInt {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
    return Math.floor(r * n);
  };
}

export const pick = <T,>(xs: readonly T[], rand: RandomInt): T => xs[rand(xs.length)]!;

export function pickDistinct<T>(xs: readonly T[], k: number, rand: RandomInt): T[] {
  if (k > xs.length) throw new RangeError("not enough items");
  const pool = [...xs];
  for (let i = 0; i < k; i++) {
    const j = i + rand(pool.length - i);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, k);
}
