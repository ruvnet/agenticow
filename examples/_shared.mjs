// Shared helpers for the examples — a deterministic RNG so outputs are
// reproducible, plus a tiny timer. Examples import the library from the local
// source so they run against this repo with zero setup:
//
//   in your own project:   import { open } from 'agenticow';
//   in this repo:          import { open } from '../src/index.js';

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// mulberry32 — small, fast, seedable PRNG (deterministic example output).
export function rng(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function vecFactory(dim, seed) {
  const r = rng(seed);
  return () => Float32Array.from({ length: dim }, () => r() * 2 - 1);
}

export function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agenticow-${tag}-`));
}

export const ms = (t0) => `${(performance.now() - t0).toFixed(3)} ms`;
export const kb = (b) => `${(b / 1024).toFixed(1)} KB`;
export const mb = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`;
