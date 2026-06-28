// memory-evolution.mjs — Darwin-on-memory: branches reproduce over generations.
// [EXOTIC tier — PoC: mechanics demonstrated, "fitness" is a function not cognition]
//
// HONEST LABEL: demonstrates the evolutionary MECHANICS on COW memory — a
// population of branches per generation, each scored by an outcome function, the
// top survivors becoming the PARENTS of the next generation (fork off the
// winner). It shows the branch substrate supports population-based search and
// that storage stays delta-sized across generations. It does NOT claim the
// evolved memory is "smarter" — fitness is a deterministic function here, a
// stand-in for any real eval.
//
// Run: node examples/memory-evolution.mjs
// ── verified output: see examples/README.md ──

import fs from 'node:fs';
import path from 'node:path';
import { open } from '../src/index.js'; // in your project: from 'agenticow'
import { vecFactory, tmpdir, kb } from './_shared.mjs';

const DIM = 32;
const GENERATIONS = 6;
const POP = 12;
const SURVIVORS = 3;
const dir = tmpdir('evolution');
const vec = vecFactory(DIM, 505);

const base = open(path.join(dir, 'base.rvf'), { dimension: DIM });
base.ingest(Array.from({ length: 500 }, (_, i) => ({ id: i, vector: vec() })));
const target = vec();
const fitness = (v) => { // lower distance to target = fitter
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < DIM; i++) { d += v[i] * target[i]; na += v[i] * v[i]; nb += target[i] * target[i]; }
  return -(1 - d / (Math.sqrt(na) * Math.sqrt(nb)));
};

let parents = [{ mem: base, best: vec() }]; // gen-0 parent = base
let allBranches = [];
let bestEver = -Infinity;

for (let g = 1; g <= GENERATIONS; g++) {
  const pop = [];
  for (let i = 0; i < POP; i++) {
    const parent = parents[i % parents.length];
    const child = parent.mem.fork(`g${g}-i${i}`);
    // "mutate": blend parent's best candidate toward target with noise
    const w = 0.25 + 0.6 * (i / POP);
    const cand = Float32Array.from(parent.best, (x, k) => x * (1 - w) + (target[k] * w) + vec()[0] * 0.15);
    child.ingest([{ id: 80000, vector: cand }]);
    pop.push({ mem: child, best: cand, fit: fitness(cand) });
    allBranches.push(child);
  }
  pop.sort((a, b) => b.fit - a.fit);
  const survivors = pop.slice(0, SURVIVORS);
  bestEver = Math.max(bestEver, survivors[0].fit);
  console.log(`gen ${g}: best fitness ${survivors[0].fit.toFixed(4)} (pop ${POP}, survivors ${SURVIVORS})`);
  parents = survivors; // winners reproduce → next gen forks off them
}

let bytes = 0;
for (const b of allBranches) { try { bytes += fs.statSync(b.lineage()[0].path).size; } catch { /* */ } }
console.log(`\nbest fitness reached: ${bestEver.toFixed(4)} over ${GENERATIONS} generations`);
console.log(`total branches created: ${allBranches.length}; total branch storage: ${kb(bytes)} (${(bytes / allBranches.length / 1024).toFixed(2)} KB/branch, delta-sized)`);
console.log(`base size: ${(base.status().fileSize / 1024).toFixed(1)} KB — storage stays delta-sized regardless of generations.`);
console.log('NOTE: mechanics only — "fitness" is a scoring function, not validated cognition.');

base.close();
allBranches.forEach((b) => { try { b.close(); } catch { /* */ } });
fs.rmSync(dir, { recursive: true, force: true });
