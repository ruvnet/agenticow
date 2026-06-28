// time-travel-debug.mjs — checkpoint a long migration; rewind past a latent bug.
//
// PARADIGM: Branch → Mutate → external-Verify → Promote / Discard (here the
// "discard" is a precise time-rewind to a clean checkpoint, not a full replay).
//
// A 24-step migration loop ingests one "op" embedding per step and checkpoints
// every 5 steps (162 B each). A "hallucinated signature" is injected at step 12.
// It is LATENT — it only trips an EXTERNAL DETERMINISTIC compiler-check at
// step 24 (the check scans current memory for the known-bad signature). On
// failure we:
//   1. root-cause the bad op to step 12 (deterministic id→step map),
//   2. pick the newest checkpoint AT OR BEFORE the bug → checkpoint @ step 10,
//   3. rollback() to it (sub-ms; steps 1–10 are NOT replayed — they live in the
//      162-byte checkpoint),
//   4. inject the CORRECTIVE op and resume 11→24 cleanly,
//   5. re-run the compiler-check → PASS.
//
// The verifier is a signature scan (a "compiler"), not an LM-judge.
//
// Run: node examples/time-travel-debug.mjs
//
// ── verified output (deterministic; only timings vary per machine) ──────────
// migration: 24 steps, checkpoint every 5  (hallucinated signature injected at step 12)
//   checkpoint @ step  5 : id …(162 B, depth 1)
//   checkpoint @ step 10 : id …(162 B, depth 2)
//   checkpoint @ step 15 : id …(162 B, depth 3)   ← already contains the step-12 poison
//   checkpoint @ step 20 : id …(162 B, depth 4)   ← already contains the step-12 poison
// step 24 compiler-check: FAIL — bad signature reachable (op id 1012 @ dist 0.0000)
//   root cause: op id 1012 = migration step 12 (hallucinated signature)
//   newest clean checkpoint at/before step 12 → checkpoint @ step 10
//   rewind: rollback() to step-10 checkpoint in 1.100 ms (steps 1–10 NOT replayed)
//   inject corrective op at step 11, resume 11→24 …
// after rewind+resume compiler-check: PASS
//   ingest() calls: 24 (initial) + 14 (resume 11→24) = 38   ·   replayed steps 1–10: 0
//   final memory steps reachable: 24/24  ·  poison reachable = false
// ──────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { openBase } from '../src/index.js'; // in your project: from 'agenticow'
import { vecFactory, tmpdir, ms } from './_shared.mjs';

const DIM = 64;
const STEPS = 24;
const CK_EVERY = 5;
const BUG_STEP = 12;
const EPS = 0.02;
const dir = tmpdir('timetravel');
const vec = vecFactory(DIM, 4242);

// The known-bad "hallucinated signature" the compiler-check scans for.
const BAD_SIGNATURE = vecFactory(DIM, 13)();
const opId = (step) => 1000 + step;           // deterministic id ↔ step map
let ingestCalls = 0;
const opVecs = new Map();                      // opId → vector, for reachability proof

// EXTERNAL deterministic compiler-check: is the bad signature reachable?
function compilerCheck(mem) {
  const hit = mem.query(BAD_SIGNATURE, 1)[0];
  const bad = hit && hit.distance < EPS;
  return { ok: !bad, offendingId: bad ? hit.id : null };
}

const mem = openBase(path.join(dir, 'migration.rvf'), { dimension: DIM });
console.log(`migration: ${STEPS} steps, checkpoint every ${CK_EVERY}  (hallucinated signature injected at step ${BUG_STEP})`);

// ── run the migration, checkpointing every 5 steps ──────────────────────────
const checkpoints = []; // { step, id }
for (let step = 1; step <= STEPS; step++) {
  // step 12 ingests the hallucinated signature instead of a valid op.
  const v = step === BUG_STEP ? BAD_SIGNATURE : vec();
  opVecs.set(opId(step), v);
  mem.ingest(v, { id: opId(step), text: step === BUG_STEP ? 'HALLUCINATED-SIGNATURE' : `op-step-${step}` });
  ingestCalls++;
  if (step % CK_EVERY === 0) {
    const ck = mem.checkpoint(`step-${step}`);
    checkpoints.push({ step, id: ck.id });
    const poisoned = step > BUG_STEP ? '   ← already contains the step-12 poison' : '';
    console.log(`  checkpoint @ step ${String(step).padStart(2)} : id ${ck.id.slice(0, 10)}… (162 B, depth ${ck.depth})${poisoned}`);
  }
}

// ── step-24 compiler-check trips on the latent bug ──────────────────────────
const v1 = compilerCheck(mem);
console.log(`step 24 compiler-check: ${v1.ok ? 'PASS' : 'FAIL'} — bad signature reachable (op id ${v1.offendingId} @ dist ${mem.query(BAD_SIGNATURE, 1)[0].distance.toFixed(4)})`);

// ── root-cause + pick the newest clean checkpoint ───────────────────────────
const badStep = v1.offendingId - 1000;
console.log(`  root cause: op id ${v1.offendingId} = migration step ${badStep} (hallucinated signature)`);
const clean = [...checkpoints].reverse().find((c) => c.step < badStep); // newest at/before bug
console.log(`  newest clean checkpoint at/before step ${badStep} → checkpoint @ step ${clean.step}`);

// ── rewind (no full replay) + inject corrective path + resume ───────────────
const t0 = performance.now();
mem.rollback(clean.id);
const rewind = ms(t0);
console.log(`  rewind: rollback() to step-${clean.step} checkpoint in ${rewind} (steps 1–${clean.step} NOT replayed)`);
console.log(`  inject corrective op at step ${clean.step + 1}, resume ${clean.step + 1}→${STEPS} …`);
for (let step = clean.step + 1; step <= STEPS; step++) {
  const v = vec(); // corrective: a valid op (NOT the bad signature) — incl. step 12
  opVecs.set(opId(step), v);
  mem.ingest(v, { id: opId(step), text: `op-step-${step}` });
  ingestCalls++;
}

// ── re-verify ────────────────────────────────────────────────────────────────
const v2 = compilerCheck(mem);
console.log(`after rewind+resume compiler-check: ${v2.ok ? 'PASS' : 'FAIL'}`);
// PROVE reachability: every step's op is its own top-1 hit (checkpoint-held 1–10
// via read-through + resumed 11–24 in the working node).
let stepsReachable = 0;
for (let step = 1; step <= STEPS; step++) {
  const top = mem.query(opVecs.get(opId(step)), 1)[0];
  if (top && top.id === opId(step)) stepsReachable++;
}
const resume = STEPS - clean.step;
console.log(`  ingest() calls: ${STEPS} (initial) + ${resume} (resume ${clean.step + 1}→${STEPS}) = ${ingestCalls}   ·   replayed steps 1–${clean.step}: 0`);
console.log(`  final memory steps reachable: ${stepsReachable}/${STEPS}  ·  poison reachable = ${!v2.ok}`);

mem.close();
fs.rmSync(dir, { recursive: true, force: true });
