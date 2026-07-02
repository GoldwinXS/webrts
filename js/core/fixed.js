// Deterministic integer math. The entire simulation runs on integers so both
// machines in a lockstep match compute bit-identical state. No Math.sin/cos/
// pow/atan2 and no Math.random() may ever touch sim state.

export const FP = 256;               // fixed-point scale: 1 tile = 256 fp units
export const HALF = FP >> 1;

export const tileToFp = (t) => (t * FP + HALF) | 0;   // center of tile
export const fpToTile = (v) => (v / FP) | 0;

// Integer square root (Newton). Inputs up to 2^31-1.
export function isqrt(n) {
  if (n <= 0) return 0;
  let x = n, y = ((x + 1) / 2) | 0;
  while (y < x) {
    x = y;
    y = ((y + ((n / y) | 0)) / 2) | 0;
  }
  return x;
}

export function dist(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return isqrt(dx * dx + dy * dy);
}

export function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

// Deterministic PRNG (mulberry32 core, integer ops only). Returns uint32.
export function makeRng(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

// FNV-1a style rolling hash for desync detection.
export function makeHash() {
  let h = 0x811c9dc5 | 0;
  return {
    mix(v) { h = Math.imul(h ^ (v | 0), 0x01000193); },
    value() { return h >>> 0; },
  };
}
