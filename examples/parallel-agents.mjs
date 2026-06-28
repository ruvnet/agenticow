// examples/parallel-agents.mjs
// Worked example: fork N branches off one base, ingest + tombstone per branch,
// query each branch (exact read-through), and roll one branch back.
//
//   node examples/parallel-agents.mjs
//
// This is the same shape as the acceptance test, at small scale, so you can read
// it top to bottom.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open } from 'agenticow'; // or '../src/index.js' from inside this repo

const DIM = 64;
const N_AGENTS = 8;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenticow-example-'));
const rnd = () => Float32Array.from({ length: DIM }, () => Math.random() * 2 - 1);

// 1. Build one shared base memory.
const base = open(path.join(dir, 'base.rvf'), { dimension: DIM });
const BASE_N = 2000;
const flat = new Float32Array(BASE_N * DIM);
const ids = [];
for (let i = 0; i < BASE_N; i++) { flat.set(rnd(), i * DIM); ids.push(i); }
base.ingest(flat, ids);
console.log(`base: ${base.status().totalVectors} vectors, ${(base.status().fileSize / 1024).toFixed(0)} KB`);

// 2. Fork N agent branches off the (now read-only) base. Each is ~162 B / ~0.5 ms.
const agents = [];
for (let a = 0; a < N_AGENTS; a++) {
  const br = base.fork(`agent-${a}`);
  // each agent ingests private memories + tombstones a couple of base vectors
  br.ingest([
    { id: 1_000_000 + a * 10 + 1, vector: rnd() },
    { id: 1_000_000 + a * 10 + 2, vector: rnd() },
  ]);
  br.delete([a, a + 100]); // hide two base vectors from this agent's view
  agents.push(br);
}
console.log(`forked ${agents.length} agent branches off the shared base`);

// 3. Query each branch — exact read-through (base ∪ edits − tombstones).
for (let a = 0; a < N_AGENTS; a++) {
  const top = agents[a].query(rnd(), 5);
  const fromBase = top.filter((h) => h.id < BASE_N).length;
  const fromBranch = top.length - fromBase;
  console.log(`agent-${a}: top-5 = ${fromBase} base + ${fromBranch} private  (e.g. id ${top[0].id} @ ${top[0].distance.toFixed(3)})`);
}

// 4. Roll one agent back to a clean checkpoint after a bad ingest.
const victim = agents[0];
const ck = victim.checkpoint('clean');
const halluc = rnd();
victim.ingest([{ id: 9_999_999, vector: halluc }]); // "hallucinated" memory
console.log(`agent-0 before rollback: hallucination present = ${victim.query(halluc, 1)[0].id === 9_999_999}`);
victim.rollback(ck.id);
console.log(`agent-0 after rollback:  hallucination present = ${victim.query(halluc, 5).map((h) => h.id).includes(9_999_999)} (base intact)`);

// cleanup
base.close();
agents.forEach((a) => a.close());
fs.rmSync(dir, { recursive: true, force: true });
console.log('done.');
