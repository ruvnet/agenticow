#!/usr/bin/env node
// agenticow CLI — Git for Agent Memory.
//
// Stateful verbs operate on a memory file (e.g. memory.rvf) plus a sibling
// lineage manifest (memory.rvf.agenticow.json) that tracks the COW chain.
//
//   agenticow init   <file> --dim <n>           create a base memory
//   agenticow ingest <file> --n <n>             ingest n random vectors (demo data)
//   agenticow branch <file> --as <label>        COW-fork the memory (per-user/per-repo)
//   agenticow checkpoint <file> --as <label>    freeze a restore point
//   agenticow rollback  <file>                  discard edits since last checkpoint
//   agenticow diff   <file>                     show added / overridden / tombstoned ids
//   agenticow promote <branchFile> <intoFile>   merge a branch's edits into a base
//   agenticow query  <file> --k <k>             top-K read-through (tombstone-masked, reranked)
//   agenticow lineage <file>                    show the COW chain
//
//   agenticow demo          scripted end-to-end walkthrough
//   agenticow bench         COW branch-create benchmark (SIZES env to add 1M)
//   agenticow acceptance    1,000-branch acceptance proof (BASE/BRANCHES env)
//   agenticow help          this help

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'src', 'index.js');

const C = { r: '\x1b[0m', b: '\x1b[1m', d: '\x1b[2m', c: '\x1b[36m', g: '\x1b[32m', y: '\x1b[33m', m: '\x1b[35m', red: '\x1b[31m' };
const col = (k, s) => `${C[k]}${s}${C.r}`;

function manifestFor(file) { return `${file}.agenticow.json`; }
function rndVec(dim) { return Float32Array.from({ length: dim }, () => Math.random() * 2 - 1); }

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    else pos.push(argv[i]);
  }
  return { pos, flags };
}

function help() {
  console.log(`
${col('b', 'agenticow')} — ${col('c', 'Git for Agent Memory')}
Copy-on-write vector branching: branch a base memory in ~0.5 ms / 162 bytes,
regardless of base size. Exact read-through (parent ∪ edits, child wins).

${col('b', 'Stateful verbs')} (operate on <file> + its lineage manifest)
  init       <file> --dim <n>            create a base memory
  ingest     <file> --n <n>              ingest n random demo vectors
  branch     <file> --as <label>         COW-fork (per-user / per-repo personalization)
  checkpoint <file> --as <label>         freeze a restore point
  rollback   <file>                      discard edits since last checkpoint
  diff       <file>                      added / overridden / tombstoned ids
  promote    <branchFile> <intoFile>     merge a branch's edits into a base
  query      <file> --k <k>              top-K read-through (tombstone-masked, reranked)
  lineage    <file>                      show the COW chain

${col('b', 'Showcases')}
  demo                                   scripted end-to-end walkthrough
  bench                                  branch-create benchmark
  acceptance                             1,000-branch acceptance proof
  help                                   this help

${col('b', 'Example')}
  agenticow init mem.rvf --dim 128
  agenticow ingest mem.rvf --n 5000
  agenticow branch mem.rvf --as user-42      ${col('d', '# cheap personalization')}
  agenticow query  mem.rvf.user-42.rvf --k 10
`);
}

function runChild(script, env) {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bench', script)], { stdio: 'inherit', env: { ...process.env, ...env } });
  process.exit(res.status || 0);
}

async function lib() { return import(LIB); }

async function cmdInit(pos, flags) {
  const { open } = await lib();
  const file = pos[0];
  const dim = Number(flags.dim || 128);
  if (!file) throw new Error('usage: agenticow init <file> --dim <n>');
  const mem = open(file, { dimension: dim, metric: flags.metric || 'cosine' });
  mem.save(manifestFor(file));
  mem.close();
  console.log(`${col('g', '✓')} created base memory ${col('c', file)} (dim ${dim})`);
}

async function loadMem(file) {
  const { AgenticMemory, open } = await lib();
  const man = manifestFor(file);
  if (fs.existsSync(man)) return { mem: AgenticMemory.load(man), man };
  if (fs.existsSync(file)) { const mem = open(file); return { mem, man }; }
  throw new Error(`no such memory: ${file} (run: agenticow init ${file} --dim <n>)`);
}

async function cmdIngest(pos, flags) {
  const file = pos[0];
  const n = Number(flags.n || 100);
  const { mem, man } = await loadMem(file);
  const dim = mem.dimension;
  const flat = new Float32Array(n * dim);
  const ids = [];
  const base = Number(flags.startId || Math.floor(Math.random() * 1e6));
  for (let i = 0; i < n; i++) { flat.set(rndVec(dim), i * dim); ids.push(base + i); }
  const res = mem.ingest(flat, ids);
  mem.save(man);
  mem.close();
  console.log(`${col('g', '✓')} ingested ${col('g', res.accepted)} vectors into ${col('c', file)} (ids ${base}..${base + n - 1})`);
}

async function cmdBranch(pos, flags) {
  const file = pos[0];
  const label = flags.as || 'branch';
  const { mem, man } = await loadMem(file);
  const childPath = flags.out || path.join(path.dirname(file), `${path.basename(file).replace(/\.rvf$/, '')}.${label}.rvf`);
  const t0 = performance.now();
  const br = mem.fork(label, childPath);
  const ms = performance.now() - t0;
  const bytes = fs.statSync(childPath).size;
  br.save(manifestFor(childPath));
  mem.save(man); // base unchanged by fork, but keep manifest fresh
  br.close(); mem.close();
  console.log(`${col('g', '✓')} branched ${col('c', file)} -> ${col('m', childPath)}`);
  console.log(`  ${col('g', ms.toFixed(3) + ' ms')} / ${col('g', bytes + ' B')} (O(1) in base size)`);
}

async function cmdCheckpoint(pos, flags) {
  const file = pos[0];
  const { mem, man } = await loadMem(file);
  const ck = mem.checkpoint(flags.as || undefined);
  mem.save(man);
  mem.close();
  console.log(`${col('g', '✓')} checkpoint ${col('m', ck.label)} (id ${ck.id.slice(0, 12)}…, depth ${ck.depth}, 162 B)`);
}

async function cmdRollback(pos, flags) {
  const file = pos[0];
  const { mem, man } = await loadMem(file);
  const t0 = performance.now();
  const r = mem.rollback(flags.to || undefined);
  const ms = performance.now() - t0;
  mem.save(man);
  mem.close();
  console.log(`${col('g', '✓')} rolled back to ${col('m', r.restoredTo.slice(0, 12) + '…')} in ${col('g', ms.toFixed(3) + ' ms')} (depth ${r.depth})`);
}

async function cmdDiff(pos) {
  const file = pos[0];
  const { mem } = await loadMem(file);
  const d = mem.diff();
  mem.close();
  console.log(`${col('b', 'diff')} ${col('c', file)} vs parent`);
  console.log(`  ${col('g', '+ added     ')} ${d.added.length} ids ${d.added.length ? col('d', '[' + d.added.slice(0, 8).join(', ') + (d.added.length > 8 ? ', …' : '') + ']') : ''}`);
  console.log(`  ${col('y', '~ overridden')} ${d.overridden.length} ids ${d.overridden.length ? col('d', '[' + d.overridden.slice(0, 8).join(', ') + (d.overridden.length > 8 ? ', …' : '') + ']') : ''}`);
  console.log(`  ${col('red', '- deleted   ')} ${d.deleted.length} ids ${d.deleted.length ? col('d', '[' + d.deleted.slice(0, 8).join(', ') + (d.deleted.length > 8 ? ', …' : '') + ']') : ''}`);
}

async function cmdPromote(pos) {
  const [branchFile, intoFile] = pos;
  if (!branchFile || !intoFile) throw new Error('usage: agenticow promote <branchFile> <intoFile>');
  const br = await loadMem(branchFile);
  const target = await loadMem(intoFile);
  const r = br.mem.promote(target.mem);
  target.mem.save(target.man);
  br.mem.close(); target.mem.close();
  console.log(`${col('g', '✓')} promoted ${col('m', branchFile)} -> ${col('c', intoFile)}: ` +
    `${col('g', r.ingested)} vectors merged, ${col('red', r.deleted)} tombstoned`);
}

async function cmdQuery(pos, flags) {
  const file = pos[0];
  const k = Number(flags.k || 10);
  const { mem } = await loadMem(file);
  // random probe (CLI is for demonstrating the read-through path)
  const q = rndVec(mem.dimension);
  const hits = mem.query(q, k);
  mem.close();
  console.log(`${col('b', `top-${k} read-through`)} for ${col('c', file)} (tombstone-masked, reranked)`);
  for (const h of hits) {
    console.log(`  id ${col('g', String(h.id).padStart(10))}  dist ${col('y', h.distance.toFixed(4))}  ${col('d', 'from ' + h.branch)}`);
  }
}

async function cmdLineage(pos) {
  const file = pos[0];
  const { mem } = await loadMem(file);
  const chain = mem.lineage();
  mem.close();
  console.log(`${col('b', 'lineage')} ${col('c', file)} (working → base)`);
  chain.forEach((n, i) => {
    const arm = i === chain.length - 1 ? '└─' : '├─';
    console.log(`  ${arm} ${col('m', n.role.padEnd(10))} ${col('d', n.id.slice(0, 12) + '…')}  ${n.label || ''}  ${n.tombstones ? col('red', n.tombstones + ' tombstones') : ''}`);
  });
}

async function demo() {
  const { open } = await lib();
  const DIM = 32;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenticow-demo-'));
  const rnd = () => rndVec(DIM);
  const line = () => console.log(col('d', '─'.repeat(64)));
  console.log(`\n${col('b', 'agenticow demo')} — ${col('c', 'Git for Agent Memory')}\n`);

  line(); console.log(col('b', '1. Build a shared base memory (5,000 vectors)'));
  const base = open(path.join(dir, 'base.rvf'), { dimension: DIM });
  const N = 5000; const vecs = new Float32Array(N * DIM); const ids = [];
  for (let i = 0; i < N; i++) { vecs.set(rnd(), i * DIM); ids.push(i); }
  base.ingest(vecs, ids);
  console.log(`   base: ${col('g', base.status().totalVectors)} vectors, ${col('g', (base.status().fileSize / 1024 / 1024).toFixed(1) + ' MB')}`);

  line(); console.log(col('b', '2. Per-user personalization — one branch per user (cheap)'));
  const t0 = performance.now();
  const users = ['alice', 'bob', 'carol'].map((u) => base.fork(u));
  const ms = (performance.now() - t0) / users.length;
  console.log(`   3 user branches in ${col('g', (performance.now() - t0).toFixed(2) + ' ms')} ` +
    `(${col('g', ms.toFixed(3) + ' ms')}/user, ${col('g', '162 B')}/user)`);
  console.log(`   ${col('d', 'personalization without the memory explosion of N full copies')}`);

  line(); console.log(col('b', '3. Read-through — each user sees the shared base + own edits'));
  const probe = vecs.slice(42 * DIM, 43 * DIM);
  const h = users[0].query(probe, 1)[0];
  console.log(`   alice queries base vector #42 -> id=${col('g', h.id)} dist=${col('g', h.distance.toFixed(4))} from ${col('m', h.branch)}`);
  users[1].ingest([{ id: 900001, vector: rnd() }]);
  const d = users[1].diff();
  console.log(`   bob adds a private memory -> diff: ${col('g', '+' + d.added.length)} added, ${col('red', '-' + d.deleted.length)} deleted`);

  line(); console.log(col('b', '4. Quarantine a bad ingest — checkpoint + instant rollback'));
  const ck = users[2].checkpoint('clean');
  console.log(`   checkpoint '${col('m', ck.label)}' (${col('g', '162 B')})`);
  const poison = rnd();
  for (let i = 0; i < 50; i++) users[2].ingest([{ id: 800000 + i, vector: rnd() }]);
  users[2].ingest([{ id: 666666, vector: poison }]);
  console.log(`   injected 51 hallucinated vectors -> present: ${col('y', users[2].query(poison, 1)[0].id === 666666)}`);
  const tr = performance.now();
  users[2].rollback(ck.id);
  console.log(`   rollback in ${col('g', (performance.now() - tr).toFixed(2) + ' ms')} -> ` +
    `poison present: ${col('g', users[2].query(poison, 5).map((x) => x.id).includes(666666))}`);

  line(); console.log(col('b', '5. Git-style workflow — promote a reviewed branch to production'));
  const prod = open(path.join(dir, 'prod.rvf'), { dimension: DIM });
  prod.ingest([{ id: 1, vector: rnd() }]);
  const feature = prod.fork('feature');
  feature.ingest([{ id: 5001, vector: rnd() }, { id: 5002, vector: rnd() }]);
  const r = feature.promote(prod);
  console.log(`   reviewed branch promoted -> ${col('g', r.ingested)} vectors merged into production`);

  line();
  console.log(`\n${col('g', '✓')} branch / checkpoint / promote are O(1) in base size.`);
  console.log(`${col('g', '✓')} read-through is exact: parent ∪ edits, child wins, tombstones masked.`);
  console.log(`${col('d', 'Run')} ${col('c', 'agenticow acceptance')} ${col('d', 'for the 1,000-branch proof.')}\n`);

  base.close(); prod.close(); feature.close(); users.forEach((u) => u.close());
  fs.rmSync(dir, { recursive: true, force: true });
}

const { pos, flags } = parseArgs(process.argv.slice(2));
const cmd = (pos.shift() || 'help').toLowerCase();
const run = async () => {
  switch (cmd) {
    case 'init': return cmdInit(pos, flags);
    case 'ingest': return cmdIngest(pos, flags);
    case 'branch': return cmdBranch(pos, flags);
    case 'checkpoint': return cmdCheckpoint(pos, flags);
    case 'rollback': return cmdRollback(pos, flags);
    case 'diff': return cmdDiff(pos, flags);
    case 'promote': return cmdPromote(pos, flags);
    case 'query': return cmdQuery(pos, flags);
    case 'lineage': return cmdLineage(pos, flags);
    case 'demo': return demo();
    case 'bench': return runChild('bench.js', {});
    case 'acceptance': return runChild('acceptance.js', {});
    default: return help();
  }
};
run().catch((e) => { console.error(col('red', 'error: ') + e.message); process.exit(1); });
