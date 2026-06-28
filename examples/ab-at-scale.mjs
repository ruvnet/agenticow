// ab-at-scale.mjs — A/B at scale: 100+ variant branches, score, promote winner.
// [PLATFORM tier — DEMONSTRATED + benchmarked]
//
// Extends ab-branches to N=128 variants forked off one base. Each variant gets a
// candidate vector blended toward a target; we score every variant against the
// target and promote only the winner. Benchmarks fork throughput, score
// throughput, and total branch storage (delta-only).
//
// Run: node examples/ab-at-scale.mjs   (override: VARIANTS=256 node ...)
// ── verified output: see examples/README.md ──

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { open } from '../src/index.js'; // in your project: from 'agenticow'
import { vecFactory, tmpdir, ms, kb } from './_shared.mjs';

const DIM = 64;
const BASE = 5000;
const VARIANTS = Number(process.env.VARIANTS || 128);
const dir = tmpdir('ab-scale');
const vec = vecFactory(DIM, 303);

const base = open(path.join(dir, 'base.rvf'), { dimension: DIM });
const flat = new Float32Array(BASE * DIM);
for (let i = 0; i < BASE; i++) flat.set(vec(), i * DIM);
base.ingest(flat, Array.from({ length: BASE }, (_, i) => i));
const target = vec();
console.log(`base: ${BASE} vectors; A/B over ${VARIANTS} variant branches`);

// fork all variants (benchmark)
const tFork = performance.now();
const variants = [];
for (let v = 0; v < VARIANTS; v++) {
  const br = base.fork(`v${v}`);
  const w = (v + 1) / VARIANTS; // higher index = closer to target
  const blend = Float32Array.from(target, (x) => x * w + vec()[0] * (1 - w));
  br.ingest([{ id: 5_000_000, vector: blend }]);
  variants.push(br);
}
const forkMs = performance.now() - tFork;

// The base HNSW index builds lazily on the FIRST query (a one-time cost shared
// by every branch, since they read through to the same base). Warm it once and
// report that separately, so the per-variant score number reflects steady state.
const SCORE_K = 10; // winner's candidate is rank-1 vs the target; small k is enough
const tWarm = performance.now();
base.query(target, SCORE_K);
const warmMs = performance.now() - tWarm;

// score all variants (steady-state benchmark)
const tScore = performance.now();
const scores = variants.map((br, v) => {
  const hit = br.query(target, SCORE_K).find((h) => h.id === 5_000_000);
  return { v, dist: hit ? hit.distance : Infinity }; // Infinity = not competitive
});
const scoreMs = performance.now() - tScore;
scores.sort((a, b) => a.dist - b.dist);
const winner = scores[0];

// promote winner (benchmark)
const tProm = performance.now();
const r = variants[winner.v].promote(base);
const promMs = performance.now() - tProm;

// storage
let branchBytes = 0;
for (const br of variants) branchBytes += fs.statSync(br.lineage()[0].path).size;

console.log(`winner: v${winner.v} (dist ${winner.dist.toFixed(4)}); promoted ${r.ingested} vector into base`);
console.log('benchmark:');
console.log(`  fork    : ${forkMs.toFixed(1)} ms total, ${(forkMs / VARIANTS).toFixed(3)} ms/variant (${Math.round(VARIANTS / (forkMs / 1000))} forks/s)`);
console.log(`  index   : ${warmMs.toFixed(1)} ms one-time lazy base-HNSW build (first query, shared by all branches)`);
console.log(`  score   : ${scoreMs.toFixed(1)} ms total, ${(scoreMs / VARIANTS).toFixed(3)} ms/variant (${Math.round(VARIANTS / (scoreMs / 1000))} scores/s, steady-state)`);
console.log(`  promote : ${promMs.toFixed(3)} ms`);
console.log(`  storage : ${kb(branchBytes)} for ${VARIANTS} variants (${(branchBytes / VARIANTS / 1024).toFixed(2)} KB/variant) vs a full copy of the base each`);

base.close();
variants.forEach((br) => br.close());
fs.rmSync(dir, { recursive: true, force: true });
