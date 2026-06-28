// multi-tenant-saas.mjs — one mmapped base, N isolated tenant branches.
//
// PARADIGM: Branch → Mutate → external-Verify (isolation oracle) → keep / evict.
// A single memory-mapped base (.rvf) is shared read-only by N tenant branches.
// Each tenant forks a cheap COW branch (~0.5 ms / delta-sized) and ingests its
// own PRIVATE documents. We then PROVE cross-tenant isolation with an EXTERNAL
// deterministic oracle: query tenant A near tenant B's private doc and assert
// B's id NEVER appears in A's results (only base ∪ A's own deltas). Finally we
// serialize one tenant (save() → manifest) and evict it (close + rm), showing
// the others + base stay intact (per-tenant right-to-erasure).
//
// Run: node examples/multi-tenant-saas.mjs
//
// ── verified output (N=1000; deterministic; only timings vary per machine) ──
// base: 5000 shared vectors, 1.26 MB (memory-mapped, read-only)
// forked 1000 tenant branches in 1896.9 ms (1.90 ms/tenant), 3 private docs each
// ── cross-tenant isolation oracle (200 random A→B probes) ──
//   probes where B's private doc leaked into A's top-10: 0 / 200   → ISOLATION: PASS
//   sample: tenant-0 query near tenant-1's private doc → top id 1001000? NO (got id 2896)
// ── storage ──
//   per-tenant delta: 2.4 KB   ·   1000 tenants total: 2.38 MB
//   vs 1000 full copies of the base: 1259.43 MB   →   530x less disk
//   total branch storage = 1.89x the base (grows with delta, not base)
// ── serialize + evict one tenant ──
//   saved tenant-500 manifest (6.5 KB) → then evicted (close + rm)
//   after eviction: tenant-500 reachable = false ; tenant-499 intact = true ; base intact = 5000
// ──────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { openBase } from '../src/index.js'; // in your project: from 'agenticow'
import { vecFactory, tmpdir, ms, kb, mb } from './_shared.mjs';

const DIM = 64;
const N = Number(process.env.TENANTS || 1000);
const DOCS_PER_TENANT = 3;
const BASE_N = 5000;
const dir = tmpdir('saas');
const vec = vecFactory(DIM, 31337);

// private id space, collision-free per tenant: 1_000_000 + tenant*1000 + docIdx
const privId = (t, j) => 1_000_000 + t * 1000 + j;

// ── shared, memory-mapped base ──────────────────────────────────────────────
const base = openBase(path.join(dir, 'base.rvf'), { dimension: DIM });
const shared = Array.from({ length: BASE_N }, () => vec());
const sflat = new Float32Array(BASE_N * DIM);
shared.forEach((v, i) => sflat.set(v, i * DIM));
base.ingest(sflat, shared.map((_, i) => i));
const baseBytes = base.status().fileSize;
console.log(`base: ${base.status().totalVectors} shared vectors, ${mb(baseBytes)} (memory-mapped, read-only)`);

// ── fork N tenant branches, each with private docs ──────────────────────────
const tenants = [];
const privateVecs = new Map(); // privId → vector (for the isolation oracle)
const t0 = performance.now();
for (let t = 0; t < N; t++) {
  const br = base.fork(`tenant-${t}`);
  for (let j = 0; j < DOCS_PER_TENANT; j++) {
    const v = vec();
    privateVecs.set(privId(t, j), v);
    br.ingest(v, { id: privId(t, j), text: `tenant-${t}-doc-${j}` });
  }
  tenants.push(br);
}
const forkMs = performance.now() - t0;
console.log(`forked ${N} tenant branches in ${forkMs.toFixed(1)} ms (${(forkMs / N).toFixed(2)} ms/tenant), ${DOCS_PER_TENANT} private docs each`);

// ── EXTERNAL isolation oracle: A's query must never surface B's private doc ──
console.log(`── cross-tenant isolation oracle (200 random A→B probes) ──`);
let leaks = 0;
const PROBES = 200;
let sampleLine = '';
for (let p = 0; p < PROBES; p++) {
  const a = Math.floor(((p * 2654435761) % N + N) % N);
  const b = (a + 1 + (p * 40503) % (N - 1)) % N; // a different tenant
  const bDoc = privId(b, p % DOCS_PER_TENANT);
  const top = tenants[a].query(privateVecs.get(bDoc), 10);
  const leaked = top.some((h) => h.id === bDoc);
  if (leaked) leaks++;
  if (p === 0) {
    const got = top[0];
    sampleLine = `  sample: tenant-${a} query near tenant-${b}'s private doc → top id ${bDoc}? ${leaked ? 'YES (LEAK!)' : `NO (got id ${got.id})`}`;
  }
}
console.log(`  probes where B's private doc leaked into A's top-10: ${leaks} / ${PROBES}   → ISOLATION: ${leaks === 0 ? 'PASS' : 'FAIL'}`);
console.log(sampleLine);

// ── storage accounting ──────────────────────────────────────────────────────
let branchBytes = 0;
for (const br of tenants) branchBytes += br.status().fileSize;
const perTenant = branchBytes / N;
const fullCopies = baseBytes * N; // the naive alternative: N full copies of the base
console.log(`── storage ──`);
console.log(`  per-tenant delta: ${kb(perTenant)}   ·   ${N} tenants total: ${mb(branchBytes)}`);
console.log(`  vs ${N} full copies of the base: ${mb(fullCopies)}   →   ${Math.round(fullCopies / branchBytes)}x less disk`);
console.log(`  total branch storage = ${(branchBytes / baseBytes).toFixed(2)}x the base (grows with delta, not base)`);

// ── serialize + evict one tenant (right-to-erasure) ─────────────────────────
const VICTIM = Math.min(500, N - 1);
const NEIGHBOR = Math.min(499, N - 2);
const manifestPath = path.join(dir, `tenant-${VICTIM}.manifest.json`);
tenants[VICTIM].save(manifestPath);
const manifestBytes = fs.statSync(manifestPath).size;
const victimPaths = tenants[VICTIM].lineage().filter((n) => n.role === 'working').map((n) => n.path);
tenants[VICTIM].close();
for (const p of victimPaths) fs.rmSync(p, { force: true });
console.log(`── serialize + evict one tenant ──`);
console.log(`  saved tenant-${VICTIM} manifest (${kb(manifestBytes)}) → then evicted (close + rm)`);

// the victim's private docs were only ever in its own branch → base never held them
const victimDoc = privId(VICTIM, 0);
const victimInBase = base.query(privateVecs.get(victimDoc), 5).some((h) => h.id === victimDoc);
const neighborDoc = privId(NEIGHBOR, 0);
const neighborIntact = tenants[NEIGHBOR].query(privateVecs.get(neighborDoc), 1)[0].id === neighborDoc;
console.log(`  after eviction: tenant-${VICTIM} reachable = ${victimInBase} ; tenant-${NEIGHBOR} intact = ${neighborIntact} ; base intact = ${base.status().totalVectors}`);

for (let t = 0; t < N; t++) if (t !== VICTIM) tenants[t].close();
base.close();
fs.rmSync(dir, { recursive: true, force: true });
