#!/usr/bin/env node
// claim-ladder.js — benchmark the per-tier operations behind the claim ladder.
//
// Measures the agenticow primitives the tier examples are built on, with real
// numbers on this machine: fork (exact + native), score (read-through query),
// promote, contradiction-check, and per-branch storage.
//
// Honesty: these are MECHANICS benchmarks (latency + storage of branch ops). The
// "cognitive quality" of any evolved/ensembled branch is NOT measured here.
//
// Usage: node bench/claim-ladder.js   (env: BASE, DIM, N)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { open } from '../src/index.js';

const DIM = Number(process.env.DIM || 64);
const BASE = Number(process.env.BASE || 5000);
const N = Number(process.env.N || 200);
const REPEAT = Number(process.env.REPEAT || 5);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenticow-ladder-'));
let s = 42;
const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff * 2 - 1; };
const vec = () => Float32Array.from({ length: DIM }, rnd);
const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < DIM; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return 1 - d / (Math.sqrt(na) * Math.sqrt(nb)); };
const median = (xs) => { const t = [...xs].sort((a, b) => a - b); return t[Math.floor(t.length / 2)]; };
const fmt = (ms) => ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(3)} ms`;

console.log('agenticow — claim-ladder operation benchmark');
console.log('='.repeat(64));
console.log(`machine: ${os.cpus()[0].model.trim()} (${os.cpus().length} threads)`);
console.log(`node   : ${process.version}   base=${BASE} dim=${DIM} N=${N}`);
console.log('='.repeat(64));

const base = open(path.join(dir, 'base.rvf'), { dimension: DIM });
const flat = new Float32Array(BASE * DIM);
for (let i = 0; i < BASE; i++) flat.set(vec(), i * DIM);
base.ingest(flat, Array.from({ length: BASE }, (_, i) => i));
const target = vec();

// fork (exact)
const forkExact = [];
const forks = [];
for (let i = 0; i < N; i++) { const t = performance.now(); const f = base.fork(`e${i}`); forkExact.push(performance.now() - t); f.ingest([{ id: 9e6 + i, vector: vec() }]); forks.push(f); }

// fork (native ANN, if available)
let nativeOn = false; const forkNative = [];
for (let i = 0; i < Math.min(N, 50); i++) {
  const t = performance.now();
  const f = base.fork(`n${i}`, undefined, { nativeAnn: true });
  forkNative.push(performance.now() - t);
  nativeOn = f.nativeAnn;
  f.close();
}

// score (read-through query of target, modest k)
const scoreLat = [];
for (let r = 0; r < REPEAT; r++) for (const f of forks) { const t = performance.now(); f.query(target, 10); scoreLat.push(performance.now() - t); }

// promote
const promoteLat = [];
for (let i = 0; i < Math.min(N, 50); i++) { const t = performance.now(); forks[i].promote(base); promoteLat.push(performance.now() - t); }

// contradiction-check: compare M branch facts pairwise at one shared id
const M = Math.min(N, 50);
const factVecs = forks.slice(0, M).map(() => vec());
const tC = performance.now();
let contradictions = 0, pairs = 0;
for (let i = 0; i < M; i++) for (let j = i + 1; j < M; j++) { pairs++; if (cos(factVecs[i], factVecs[j]) > 0.3) contradictions++; }
const contradictionMs = performance.now() - tC;

// storage
let branchBytes = 0;
for (const f of forks) branchBytes += fs.statSync(f.lineage()[0].path).size;
const perBranch = branchBytes / forks.length;

const rows = [
  ['fork (exact, derive)', fmt(median(forkExact)), `${Math.round(1000 / median(forkExact))}/s`],
  [`fork (native ANN${nativeOn ? '' : ', fallback→exact'})`, fmt(median(forkNative)), `${Math.round(1000 / median(forkNative))}/s`],
  ['score (read-through query k=10)', fmt(median(scoreLat)), `${Math.round(1000 / median(scoreLat))}/s`],
  ['promote (replay delta)', fmt(median(promoteLat)), `${Math.round(1000 / median(promoteLat))}/s`],
  [`contradiction-check (${pairs} pairs)`, fmt(contradictionMs), `${Math.round(pairs / (contradictionMs / 1000)).toLocaleString()} pairs/s`],
];

console.log('\noperation                                 p50           throughput');
console.log('-'.repeat(64));
for (const [op, p50, tp] of rows) console.log(`${op.padEnd(42)}${p50.padStart(8)}     ${tp}`);
console.log('-'.repeat(64));
console.log(`per-branch storage : ${(perBranch / 1024).toFixed(2)} KB (${forks.length} branches, ${(branchBytes / 1024).toFixed(1)} KB total)`);
console.log(`native ANN active  : ${nativeOn} (linux-x64-gnu; graceful exact fallback elsewhere)`);
console.log(`contradictions     : ${contradictions}/${pairs} pairs over threshold`);

const out = {
  machine: os.cpus()[0].model.trim(), node: process.version, base: BASE, dim: DIM, n: N, date: new Date().toISOString(),
  forkExactMs: median(forkExact), forkNativeMs: median(forkNative), nativeAnnActive: nativeOn,
  scoreMs: median(scoreLat), promoteMs: median(promoteLat),
  contradictionPairsPerSec: Math.round(pairs / (contradictionMs / 1000)),
  perBranchBytes: perBranch,
};
try { fs.writeFileSync(path.join(process.cwd(), 'bench', 'claim-ladder-results.json'), JSON.stringify(out, null, 2)); console.log('\nwrote bench/claim-ladder-results.json'); } catch { /* */ }

base.close(); forks.forEach((f) => { try { f.close(); } catch { /* */ } });
fs.rmSync(dir, { recursive: true, force: true });
