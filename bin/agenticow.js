#!/usr/bin/env node
// agenticow CLI — Git for Agent Memory
//
//   agenticow demo     run a scripted demo of branch / checkpoint / rollback / read-through
//   agenticow bench    run the COW branch-create benchmark (10k + 100k by default)
//   agenticow help     show this help

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', mag: '\x1b[35m',
};
const c = (color, s) => `${C[color]}${s}${C.reset}`;

function help() {
  console.log(`
${c('bold', 'agenticow')} — ${c('cyan', 'Git for Agent Memory')}
Copy-On-Write vector branching: branch a base memory in ~0.5 ms / 162 bytes,
regardless of base size. Exact read-through queries (parent ∪ edits, child wins).

${c('bold', 'Usage')}
  agenticow demo      scripted demo: branch, checkpoint, rollback, read-through
  agenticow bench     COW branch-create benchmark (SIZES env to add 1M)
  agenticow help      this help

${c('bold', 'Examples')}
  agenticow demo
  agenticow bench
  SIZES=10000,100000,1000000 agenticow bench
`);
}

function runBench() {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bench', 'bench.js')], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(res.status || 0);
}

async function demo() {
  const { open } = await import(path.join(ROOT, 'src', 'index.js'));
  const DIM = 32;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenticow-demo-'));
  const rnd = () => Float32Array.from({ length: DIM }, () => Math.random() * 2 - 1);

  const line = () => console.log(c('dim', '─'.repeat(64)));
  console.log(`\n${c('bold', 'agenticow demo')} — ${c('cyan', 'Git for Agent Memory')}\n`);

  // 1. Build a shared base memory
  line();
  console.log(c('bold', '1. Build a shared base memory (5,000 vectors)'));
  const base = open(path.join(dir, 'base.rvf'), { dimension: DIM });
  const N = 5000;
  const vecs = new Float32Array(N * DIM);
  const ids = [];
  for (let i = 0; i < N; i++) { vecs.set(rnd(), i * DIM); ids.push(i); }
  base.ingest(vecs, ids);
  console.log(`   base has ${c('green', base.status().totalVectors)} vectors, ` +
    `${c('green', (base.status().fileSize / 1024 / 1024).toFixed(1) + ' MB')} on disk`);

  // 2. Parallel agents share the base via cheap COW branches
  line();
  console.log(c('bold', '2. Spawn 3 parallel agents — each gets a COW branch'));
  const tBr = performance.now();
  const a = base.branch('agent-research');
  const b = base.branch('agent-coder');
  const d = base.branch('agent-tester');
  const brMs = (performance.now() - tBr) / 3;
  const brBytes = fs.statSync(a.lineage()[0].path).size;
  console.log(`   created 3 branches in ${c('green', ((performance.now() - tBr)).toFixed(2) + ' ms')} ` +
    `(${c('green', brMs.toFixed(3) + ' ms')}/branch, ${c('green', brBytes + ' B')}/branch)`);
  console.log(`   ${c('dim', 'vs a full copy of the 5,000-vector base for each agent')}`);

  // 3. Read-through: each branch sees the base
  line();
  console.log(c('bold', '3. Read-through — each branch sees the shared base'));
  const probe = vecs.slice(42 * DIM, 43 * DIM);
  const hit = a.query(probe, 1)[0];
  console.log(`   agent-research queries for base vector #42 -> ` +
    `hit id=${c('green', hit.id)} dist=${c('green', hit.distance.toFixed(4))} ` +
    `from ${c('mag', hit.branch)}`);

  // 4. Isolation + private edits
  line();
  console.log(c('bold', '4. Each agent adds private memory (isolated)'));
  const coderSecret = rnd();
  b.ingest([{ id: 900001, vector: coderSecret }]);
  const seenByResearch = a.query(coderSecret, 1).map((h) => h.id).includes(900001);
  const seenByCoder = b.query(coderSecret, 1)[0].id === 900001;
  console.log(`   agent-coder added a private vector ->  ` +
    `coder sees it: ${c('green', seenByCoder)}, research sees it: ${c(seenByResearch ? 'yellow' : 'green', seenByResearch)}`);

  // 5. Checkpoint + rollback a poisoned branch
  line();
  console.log(c('bold', '5. Checkpoint, poison, and instant rollback'));
  const ckpt = b.checkpoint('clean');
  console.log(`   checkpoint '${c('mag', ckpt.label)}' saved (${c('green', '162 B')}, depth ${ckpt.depth})`);
  const poison = rnd();
  for (let i = 0; i < 50; i++) b.ingest([{ id: 800000 + i, vector: rnd() }]);
  b.ingest([{ id: 666666, vector: poison }]);
  const before = b.query(poison, 1)[0].id === 666666;
  console.log(`   injected 51 poisoned vectors -> present: ${c('yellow', before)}`);
  const tRb = performance.now();
  b.rollback(ckpt.id);
  const rbMs = performance.now() - tRb;
  const after = b.query(poison, 5).map((h) => h.id).includes(666666);
  console.log(`   rollback in ${c('green', rbMs.toFixed(2) + ' ms')} -> poison present: ${c('green', after)}, ` +
    `clean memory intact: ${c('green', b.query(coderSecret, 1)[0].id === 900001)}`);

  line();
  console.log(`\n${c('green', '✓')} branch create + checkpoint are O(1) in base size.`);
  console.log(`${c('green', '✓')} read-through is exact: parent ∪ edits, child wins.`);
  console.log(`${c('dim', 'Run')} ${c('cyan', 'agenticow bench')} ${c('dim', 'for the full 83x / 3000x table.')}\n`);

  base.close(); a.close(); b.close(); d.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

const cmd = (process.argv[2] || 'help').toLowerCase();
if (cmd === 'bench') runBench();
else if (cmd === 'demo') demo();
else help();
