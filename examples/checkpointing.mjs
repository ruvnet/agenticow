// checkpointing.mjs — zero-cost checkpoints + crash recovery without replay.
//
// Demonstrates: an agent loop that checkpoints memory every 10 steps. A failure
// hits at step 31; we roll back to the step-30 checkpoint and resume. The first
// 30 steps are NOT replayed — they live in the 162-byte checkpoint and are
// already visible via read-through.
//
// Run: node examples/checkpointing.mjs
//
// ── verified output ───────────────────────────────────────────────────────
// (see examples/README.md)
// ──────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { open } from '../src/index.js'; // in your project: from 'agenticow'
import { vecFactory, tmpdir, ms } from './_shared.mjs';

const DIM = 32;
const dir = tmpdir('checkpoint');
const vec = vecFactory(DIM, 11);

const mem = open(path.join(dir, 'agent.rvf'), { dimension: DIM });
const stored = new Map(); // step -> vector, to verify read-through later

let ingestCalls = 0;
function step(n) {
  const v = vec();
  mem.ingest([{ id: n, vector: v }]);
  stored.set(n, v);
  ingestCalls++;
}

// Run steps 1..30, checkpoint at 10, 20, 30.
const checkpoints = {};
for (let n = 1; n <= 30; n++) {
  step(n);
  if (n % 10 === 0) {
    checkpoints[n] = mem.checkpoint(`step-${n}`);
    console.log(`checkpoint @ step ${n}: id ${checkpoints[n].id.slice(0, 10)}… (162 B, depth ${checkpoints[n].depth})`);
  }
}

// Step 31 does some work, then "crashes".
step(31);
const crashedHasGarbage = mem.query(stored.get(31), 1)[0].id === 31;
console.log(`step 31 ran (partial work present = ${crashedHasGarbage}) ... 💥 simulated crash`);

// Recover: roll back to the step-30 checkpoint.
const callsBefore = ingestCalls;
const t0 = performance.now();
mem.rollback(checkpoints[30].id);
const recoverMs = ms(t0);

// The 30 steps are intact WITHOUT replay (ingestCalls unchanged), step 31 gone.
const step31Gone = mem.query(stored.get(31), 5).every((h) => h.id !== 31);
const step15Present = mem.query(stored.get(15), 1)[0].id === 15;
const step30Present = mem.query(stored.get(30), 1)[0].id === 30;
console.log(`recovered to step-30 in ${recoverMs} (re-ingests during recovery: ${ingestCalls - callsBefore})`);
console.log(`after recovery: step 31 gone = ${step31Gone}, step 15 present = ${step15Present}, step 30 present = ${step30Present}`);
console.log(`total ingest() calls across the whole run: ${ingestCalls} (31 steps, no replay)`);

mem.close();
fs.rmSync(dir, { recursive: true, force: true });
