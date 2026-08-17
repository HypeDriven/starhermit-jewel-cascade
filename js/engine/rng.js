/**
 * rng.js — seeded random streams and stable hashing for Jewel Cascade.
 *
 * Rules, content decoration, and audiovisual variants each use their own
 * seeded stream so cosmetic randomness can never change rules outcomes.
 * Everything here is dependency-free and runs identically in browser and Node.
 */

/** 32-bit FNV-1a hash of a string. Returns an unsigned 32-bit integer. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Hash any number of string parts into one uint32 seed. */
export function hashStrings(...parts) {
  return fnv1a(parts.join(''));
}

/** Hex string (8 chars) of a uint32, used for state hashes in replays. */
export function hex32(n) {
  return (n >>> 0).toString(16).padStart(8, '0');
}

/**
 * mulberry32 — small, fast, deterministic PRNG.
 * State is a single uint32; getState()/setState() make it serializable.
 */
export class Rng {
  constructor(seed) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }
  /** Next float in [0, 1). */
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [0, n). */
  int(n) {
    return Math.floor(this.next() * n);
  }
  /** Integer in [min, max] inclusive. */
  range(min, max) {
    return min + this.int(max - min + 1);
  }
  /** Uniform pick from an array. */
  pick(arr) {
    return arr[this.int(arr.length)];
  }
  /** In-place Fisher–Yates shuffle (deterministic for a given state). */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }
  getState() {
    return this.s >>> 0;
  }
  setState(s) {
    this.s = s >>> 0;
  }
  clone() {
    return new Rng(this.s);
  }
}

/** Canonical JSON with recursively sorted object keys (stable across engines). */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') +
    '}'
  );
}

/** Stable 8-hex-char hash of any JSON-serializable value. */
export function stateHash(value) {
  return hex32(fnv1a(stableStringify(value)));
}
