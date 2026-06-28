#!/usr/bin/env node
// agenticow benchmark — reproduces the COW branch-CREATE advantage honestly.
//
// What this measures (and what it does NOT):
//   - COW branch CREATE: time + on-disk delta size to derive() a branch off a
//     base of N vectors. This is the headline, base-size-INDEPENDENT primitive.
//   - Naive FULL COPY: time + bytes to byte-copy the whole base .rvf file (the
//     baseline every other vector store forces you into for a snapshot).
//   - Speed/size ratios at each base size.
//
// Honest caveats (printed in the footer):
//   - This benchmarks branch CREATION, not query throughput.
//   - Branch delta = O(edits), 162 B empty + ~520 B/edited-vector, independent
//     of base size. Full copy = O(base file).
//   - ANN query that spans the COW boundary is NOT benchmarked (roadmap). The
//     shipped read-through is exact (parent ∪ edits) and lives in the lib layer.
//
// Usage:
//   node bench/bench.js                 # 10k + 100k (fast, default)
//   SIZES=10000,100000,1000000 node bench/bench.js   # include the 1M row (slow)
//   DIM=128 node bench/bench.js

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import pkg from '@ruvector/rvf-node';

const { RvfDatabase } = pkg;

const DIM = Number(process.env.DIM || 128);
const METRIC = 'cosine';
const SIZES = (process.env.SIZES || '10000,100000')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter(Boolean);
const REPEAT = Number(process.env.REPEAT || 11); // odd -> clean median
const EDIT_COUNTS = [0, 10, 100, 1000];

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenticow-bench-'));

function rndVec() {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.random() * 2 - 1;
  return v;
}
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
function fmtMs(ms) {
  return ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(2)} ms`;
}

function buildBase(n) {
  const basePath = path.join(workDir, `base-${n}.rvf`);
  fs.rmSync(basePath, { force: true });
  const db = RvfDatabase.create(basePath, { dimension: DIM, metric: METRIC });
  const BATCH = 10000;
  let done = 0;
  while (done < n) {
    const m = Math.min(BATCH, n - done);
    const flat = new Float32Array(m * DIM);
    const ids = new Array(m);
    for (let i = 0; i < m; i++) {
      flat.set(rndVec(), i * DIM);
      ids[i] = done + i;
    }
    db.ingestBatch(flat, ids);
    done += m;
  }
  db.close();
  return basePath;
}

// COW branch CREATE: median latency over REPEAT derives, plus delta size for
// each edit count.
function benchBranchCreate(basePath) {
  const base = RvfDatabase.open(basePath);
  const lat = [];
  for (let r = 0; r < REPEAT; r++) {
    const childPath = path.join(workDir, `br-${r}-${Math.random().toString(36).slice(2)}.rvf`);
    const t0 = performance.now();
    const child = base.derive(childPath, { dimension: DIM, metric: METRIC });
    const t1 = performance.now();
    lat.push(t1 - t0);
    child.close();
    fs.rmSync(childPath, { force: true });
  }
  // delta sizes by edit count (apply edits to a fresh branch each time)
  const sizes = {};
  for (const ec of EDIT_COUNTS) {
    const childPath = path.join(workDir, `brsize-${ec}.rvf`);
    fs.rmSync(childPath, { force: true });
    const child = base.derive(childPath, { dimension: DIM, metric: METRIC });
    if (ec > 0) {
      const flat = new Float32Array(ec * DIM);
      const ids = new Array(ec);
      for (let i = 0; i < ec; i++) {
        flat.set(rndVec(), i * DIM);
        ids[i] = 1_000_000_000 + i; // new ids -> pure additions
      }
      child.ingestBatch(flat, ids);
    }
    child.close();
    sizes[ec] = fs.statSync(childPath).size;
    fs.rmSync(childPath, { force: true });
  }
  base.close();
  return { latency: median(lat), sizes };
}

// Naive FULL COPY baseline: byte-copy the whole base file (what a snapshot costs
// without COW). Median over REPEAT copies.
function benchFullCopy(basePath) {
  const baseSize = fs.statSync(basePath).size;
  const lat = [];
  for (let r = 0; r < REPEAT; r++) {
    const dst = path.join(workDir, `copy-${r}.rvf`);
    const t0 = performance.now();
    fs.copyFileSync(basePath, dst);
    const t1 = performance.now();
    lat.push(t1 - t0);
    fs.rmSync(dst, { force: true });
  }
  return { latency: median(lat), size: baseSize };
}

function main() {
  console.log('agenticow — COW branch-create benchmark');
  console.log('='.repeat(72));
  console.log(`machine : ${os.cpus()[0].model.trim()} (${os.cpus().length} threads)`);
  console.log(`node    : ${process.version}   platform: ${process.platform}-${process.arch}`);
  console.log(`vectors : dim=${DIM}  metric=${METRIC}  median of ${REPEAT} runs`);
  console.log('='.repeat(72));

  const rows = [];
  for (const n of SIZES) {
    process.stdout.write(`\nbuilding base of ${n.toLocaleString()} vectors ... `);
    const basePath = buildBase(n);
    const baseSize = fs.statSync(basePath).size;
    console.log(`${fmtBytes(baseSize)}`);
    const branch = benchBranchCreate(basePath);
    const copy = benchFullCopy(basePath);
    const speedup = copy.latency / branch.latency;
    const shrink = copy.size / branch.sizes[0];
    rows.push({ n, baseSize, branch, copy, speedup, shrink });
    fs.rmSync(basePath, { force: true });
    console.log(
      `  branch create : ${fmtMs(branch.latency)}  (empty delta ${fmtBytes(branch.sizes[0])})`
    );
    console.log(`  full copy     : ${fmtMs(copy.latency)}  (${fmtBytes(copy.size)})`);
    console.log(
      `  => ${speedup.toFixed(0)}x faster, ${Math.round(shrink).toLocaleString()}x smaller`
    );
  }

  // Markdown table
  console.log('\n\nResults table (Markdown)');
  console.log('-'.repeat(72));
  console.log(
    '| Base N | Base file | Branch create (p50) | Empty branch | 100-edit branch | Full copy (p50) | Speedup | Shrink |'
  );
  console.log(
    '|-------:|----------:|--------------------:|-------------:|----------------:|----------------:|--------:|-------:|'
  );
  for (const r of rows) {
    console.log(
      `| ${r.n.toLocaleString()} | ${fmtBytes(r.baseSize)} | ${fmtMs(r.branch.latency)} | ${fmtBytes(
        r.branch.sizes[0]
      )} | ${fmtBytes(r.branch.sizes[100])} | ${fmtMs(r.copy.latency)} | ${r.speedup.toFixed(
        0
      )}x | ${Math.round(r.shrink).toLocaleString()}x |`
    );
  }

  // Delta-size-vs-edits (should be flat across base sizes)
  console.log('\nBranch delta size by edit count (independent of base size):');
  console.log('| Edits | ' + rows.map((r) => `${r.n.toLocaleString()}`).join(' | ') + ' |');
  console.log('|------:|' + rows.map(() => '----------:').join('|') + '|');
  for (const ec of EDIT_COUNTS) {
    console.log(
      `| ${ec} | ` + rows.map((r) => fmtBytes(r.branch.sizes[ec])).join(' | ') + ' |'
    );
  }

  console.log('\nHonest notes:');
  console.log('  - Measures branch CREATION (derive), not query throughput.');
  console.log('  - Branch delta = O(edits), ~520 B/edited vector, flat in base size.');
  console.log('  - Full copy = O(base file). The COW advantage widens with base size.');
  console.log('  - Exact read-through (parent ∪ edits, child wins) is in the lib layer;');
  console.log('    a single ANN index spanning the COW boundary is roadmap, not shipped.');

  // JSON for the site/README
  const out = path.join(process.cwd(), 'bench', 'results.json');
  try {
    fs.writeFileSync(
      out,
      JSON.stringify(
        {
          machine: os.cpus()[0].model.trim(),
          threads: os.cpus().length,
          node: process.version,
          dim: DIM,
          metric: METRIC,
          repeat: REPEAT,
          date: new Date().toISOString(),
          rows: rows.map((r) => ({
            n: r.n,
            baseSize: r.baseSize,
            branchCreateMs: r.branch.latency,
            emptyBranchBytes: r.branch.sizes[0],
            edit100Bytes: r.branch.sizes[100],
            fullCopyMs: r.copy.latency,
            fullCopyBytes: r.copy.size,
            speedup: r.speedup,
            shrink: r.shrink,
            sizesByEdits: r.branch.sizes,
          })),
        },
        null,
        2
      )
    );
    console.log(`\nwrote ${out}`);
  } catch (e) {
    console.log(`\n(could not write results.json: ${e.message})`);
  }

  fs.rmSync(workDir, { recursive: true, force: true });
}

main();
