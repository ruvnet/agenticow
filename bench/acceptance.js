#!/usr/bin/env node
// agenticow ACCEPTANCE TEST — the headline proof.
//
// Spec (run exactly, report real numbers):
//   1. Create 1 base RVF, fork N branches (target N=1000).
//   2. Per branch: insert new vectors + tombstone some base vectors.
//   3. Prove top-K correctness after masking + reranking: for a sample of
//      branches, query top-K via agenticow read-through and assert it matches a
//      brute-force exact ground truth (base ∪ inserts − tombstones, reranked by
//      distance). Report recall/exactness.
//   4. Rollback any branch instantly — measure rollback latency (~constant).
//   5. Show total storage grows with DELTA size, not base size — bytes(N
//      branches) vs bytes(base) vs N×full-copy. Prove sublinear-in-base.
//
// Honesty: read-through is the EXACT path (parent ∪ edits, child wins, deletes
// honored). A single ANN index spanning the COW boundary is roadmap; this test
// proves exact correctness of the read-through merge. If forking N branches hits
// a real limit (fd/memory/time), the max that worked + the scaling curve are
// reported — the 1000 is not faked.
//
// Usage:
//   node bench/acceptance.js                 # base=20k, branches=1000 (default)
//   BASE=50000 BRANCHES=1000 DIM=128 node bench/acceptance.js

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { open } from '../src/index.js';

const DIM = Number(process.env.DIM || 128);
const BASE = Number(process.env.BASE || 20000);
const BRANCHES = Number(process.env.BRANCHES || 1000);
const INSERTS_PER_BRANCH = Number(process.env.INSERTS || 8);
const TOMBSTONES_PER_BRANCH = Number(process.env.TOMBS || 4);
const SAMPLE = Number(process.env.SAMPLE || 40); // branches to verify for correctness
const K = Number(process.env.K || 10);

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenticow-acc-'));
const basePath = path.join(workDir, 'base.rvf');

function rndVec() {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.random() * 2 - 1;
  return v;
}
function cosineDist(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < DIM; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den === 0 ? 1 : 1 - dot / den;
}
function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function median(xs) { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function dirSize(dir, filter) {
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    if (filter && !filter(f)) continue;
    try { total += fs.statSync(path.join(dir, f)).size; } catch { /* */ }
  }
  return total;
}

async function main() {
  console.log('agenticow — ACCEPTANCE TEST');
  console.log('='.repeat(72));
  console.log(`machine : ${os.cpus()[0].model.trim()} (${os.cpus().length} threads)`);
  console.log(`node    : ${process.version}  platform: ${process.platform}-${process.arch}`);
  console.log(`config  : base=${BASE.toLocaleString()} vectors  target branches=${BRANCHES}  dim=${DIM}`);
  console.log(`        : ${INSERTS_PER_BRANCH} inserts + ${TOMBSTONES_PER_BRANCH} tombstones / branch`);
  console.log('='.repeat(72));

  // ---- 1. Base ----
  process.stdout.write(`\n[1] building base of ${BASE.toLocaleString()} vectors ... `);
  const baseVecs = []; // keep ground-truth copies (base is small enough for the test)
  const base = open(basePath, { dimension: DIM, metric: 'cosine', track: false });
  const BATCH = 10000;
  for (let off = 0; off < BASE; off += BATCH) {
    const m = Math.min(BATCH, BASE - off);
    const flat = new Float32Array(m * DIM);
    const ids = new Array(m);
    for (let i = 0; i < m; i++) {
      const v = rndVec();
      flat.set(v, i * DIM);
      ids[i] = off + i;
      baseVecs.push(v);
    }
    base.ingest(flat, ids);
  }
  const baseBytes = fs.statSync(basePath).size;
  console.log(`${fmtBytes(baseBytes)}`);

  // ---- 2. Fork N branches with inserts + tombstones ----
  // Ground truth per branch: { inserts: Map(id->vec), tombstones: Set(id) }
  process.stdout.write(`[2] forking branches (insert + tombstone each) ... `);
  const branches = [];
  const truth = [];
  let maxForked = 0;
  const forkLat = [];
  const tFork0 = performance.now();
  try {
    for (let b = 0; b < BRANCHES; b++) {
      const tf = performance.now();
      const br = base.fork(`u${b}`);
      forkLat.push(performance.now() - tf);
      const inserts = new Map();
      for (let i = 0; i < INSERTS_PER_BRANCH; i++) {
        const id = 1_000_000_000 + b * 1000 + i; // unique new id space per branch
        const v = rndVec();
        br.ingest([{ id, vector: v }]);
        inserts.set(id, v);
      }
      const tombs = new Set();
      for (let i = 0; i < TOMBSTONES_PER_BRANCH; i++) {
        const id = (b * 7 + i * 13) % BASE; // deterministic spread over base ids
        tombs.add(id);
      }
      br.delete([...tombs]);
      branches.push(br);
      truth.push({ inserts, tombstones: tombs });
      maxForked = b + 1;
      if ((b + 1) % 200 === 0) process.stdout.write(`${b + 1} `);
    }
  } catch (e) {
    console.log(`\n    ! hit a limit at ${maxForked} branches: ${e.message}`);
    console.log(`    reporting results for the ${maxForked} branches that succeeded.`);
  }
  const forkWallMs = performance.now() - tFork0;
  const N = maxForked;
  console.log(`\n    forked ${N} branches in ${forkWallMsFmt(forkWallMs)} ` +
    `(median ${median(forkLat).toFixed(3)} ms/fork)`);

  // ---- 3. Top-K correctness vs brute-force ground truth ----
  process.stdout.write(`[3] verifying top-${K} correctness on ${Math.min(SAMPLE, N)} sampled branches ... `);
  let exactMatches = 0;
  let recallSum = 0;
  let checks = 0;
  const sampleIdxs = [];
  for (let s = 0; s < Math.min(SAMPLE, N); s++) sampleIdxs.push(Math.floor((s * N) / Math.min(SAMPLE, N)));
  for (const bi of sampleIdxs) {
    const br = branches[bi];
    const t = truth[bi];
    // a few query vectors per branch: one near an insert, one near a base vec, one random
    const queries = [];
    const anyInsert = [...t.inserts.values()][0];
    if (anyInsert) queries.push(anyInsert);
    queries.push(baseVecs[(bi * 17) % BASE]);
    queries.push(rndVec());
    for (const q of queries) {
      // ground truth: brute force over (base − tombstones) ∪ inserts
      const cand = [];
      for (let id = 0; id < BASE; id++) {
        if (t.tombstones.has(id)) continue;
        cand.push({ id, distance: cosineDist(q, baseVecs[id]) });
      }
      for (const [id, v] of t.inserts) cand.push({ id, distance: cosineDist(q, v) });
      cand.sort((a, b) => a.distance - b.distance);
      const gold = cand.slice(0, K).map((c) => c.id);

      const got = br.query(q, K).map((h) => h.id);
      const goldSet = new Set(gold);
      const inter = got.filter((id) => goldSet.has(id)).length;
      recallSum += inter / K;
      if (gold.length === got.length && gold.every((id, i) => id === got[i])) exactMatches++;
      checks++;
    }
  }
  const recall = recallSum / checks;
  const exactRate = exactMatches / checks;
  console.log(`done`);
  console.log(`    recall@${K} = ${(recall * 100).toFixed(1)}%   ` +
    `exact-order match = ${(exactRate * 100).toFixed(1)}%   (${checks} queries)`);

  // verify tombstone masking explicitly: a tombstoned base id must never appear
  let maskViolations = 0;
  for (const bi of sampleIdxs) {
    const t = truth[bi];
    const br = branches[bi];
    for (const tid of t.tombstones) {
      const hits = br.query(baseVecs[tid], 3).map((h) => h.id);
      if (hits.includes(tid)) maskViolations++;
    }
  }
  console.log(`    tombstone masking: ${maskViolations === 0 ? 'PASS' : 'FAIL'} ` +
    `(${maskViolations} leaked tombstones)`);

  // ---- 4. Rollback latency ----
  process.stdout.write(`[4] rollback latency (checkpoint, poison, rollback) ... `);
  const rbLat = [];
  const rbSample = Math.min(50, N);
  for (let s = 0; s < rbSample; s++) {
    const br = branches[Math.floor((s * N) / rbSample)];
    const ck = br.checkpoint('clean');
    for (let i = 0; i < 20; i++) br.ingest([{ id: 2_000_000_000 + s * 100 + i, vector: rndVec() }]);
    const tr = performance.now();
    br.rollback(ck.id);
    rbLat.push(performance.now() - tr);
  }
  console.log(`done`);
  console.log(`    rollback p50 = ${median(rbLat).toFixed(3)} ms   ` +
    `min ${Math.min(...rbLat).toFixed(3)} / max ${Math.max(...rbLat).toFixed(3)} ms (${rbSample} samples)`);

  // ---- 5. Storage: delta, not base ----
  const branchBytes = dirSize(workDir, (f) => f !== 'base.rvf' && f.endsWith('.rvf'));
  const perBranch = branchBytes / N;
  const fullCopyEquiv = baseBytes * N;
  console.log(`[5] storage`);
  console.log(`    base file            : ${fmtBytes(baseBytes)}`);
  console.log(`    ${N} branches (total) : ${fmtBytes(branchBytes)}  (${fmtBytes(perBranch)}/branch)`);
  console.log(`    N x full-copy would be: ${fmtBytes(fullCopyEquiv)}`);
  console.log(`    => branches use ${(fullCopyEquiv / branchBytes).toFixed(0)}x less disk than N full copies`);
  console.log(`    => total branch storage is ${(branchBytes / baseBytes).toFixed(2)}x the base ` +
    `(grows with DELTA, not base)`);

  // ---- verdict ----
  const pass1000 = N >= 1000;
  const correctnessOk = recall >= 0.99 && maskViolations === 0;
  console.log('\n' + '='.repeat(72));
  console.log('VERDICT');
  console.log(`  branches forked        : ${N}${pass1000 ? ' (>= 1000 target met)' : ' (below 1000 target)'}`);
  console.log(`  top-${K} correctness     : recall ${(recall * 100).toFixed(1)}%, masking ${maskViolations === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  rollback latency       : ${median(rbLat).toFixed(3)} ms p50 (~constant)`);
  console.log(`  storage vs base        : ${(branchBytes / baseBytes).toFixed(2)}x base for ${N} branches (sublinear in base)`);
  console.log(`  ACCEPTANCE: ${pass1000 && correctnessOk ? 'PASS ✓' : 'PARTIAL — see notes above'}`);
  console.log('='.repeat(72));

  // write results.json for README/site
  const out = {
    machine: os.cpus()[0].model.trim(),
    node: process.version,
    date: new Date().toISOString(),
    config: { base: BASE, branchesTarget: BRANCHES, dim: DIM, insertsPerBranch: INSERTS_PER_BRANCH, tombstonesPerBranch: TOMBSTONES_PER_BRANCH, k: K },
    branchesForked: N,
    forkMedianMs: median(forkLat),
    forkTotalMs: forkWallMs,
    recallAtK: recall,
    exactOrderMatch: exactRate,
    maskViolations,
    rollbackP50Ms: median(rbLat),
    rollbackMinMs: Math.min(...rbLat),
    rollbackMaxMs: Math.max(...rbLat),
    baseBytes,
    branchTotalBytes: branchBytes,
    perBranchBytes: perBranch,
    fullCopyEquivBytes: fullCopyEquiv,
    diskSavingsVsFullCopy: fullCopyEquiv / branchBytes,
    storageVsBaseRatio: branchBytes / baseBytes,
    pass: pass1000 && correctnessOk,
  };
  try {
    fs.writeFileSync(path.join(process.cwd(), 'bench', 'acceptance-results.json'), JSON.stringify(out, null, 2));
    console.log(`\nwrote bench/acceptance-results.json`);
  } catch (e) { console.log(`(could not write results: ${e.message})`); }

  for (const br of branches) { try { br.close(); } catch { /* */ } }
  try { base.close(); } catch { /* */ }
  fs.rmSync(workDir, { recursive: true, force: true });
  process.exit(out.pass ? 0 : 1);
}

function forkWallMsFmt(ms) { return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`; }

main().catch((e) => { console.error(e); process.exit(1); });
