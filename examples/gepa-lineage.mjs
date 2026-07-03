// gepa-lineage.mjs — evolutionary candidate lineage (the metaharness GEPA pattern, ADR-230).
//
// Reproduces, in miniature, how the metaharness GEPA loop (an evolutionary optimizer of an
// LLM executor's operating policy) uses agenticow in production as its MEMORY-TRANSACTION
// layer — see `packages/darwin-mode/bench/swebench/gepa/branch-memory.mjs` in
// github.com/ruvnet/metaharness. The design rules it demonstrates:
//
//   1. memory-transaction layer, NOT the intelligence — agenticow RECORDS lineage; the
//      accept/reject decision comes from an EXTERNAL metric, never from the memory layer.
//   2. frozen seed — ONLY a holdout-confirmed winner promotes into the seed base.
//   3. retain rejected — rejected candidates are never promoted AND never deleted; they stay
//      queryable as "what-not-to-do" memory.
//   4. portable lessons, not raw branches — what leaves the process is the lesson JSON,
//      not the .rvf branch mechanics.
//
// Run: node examples/gepa-lineage.mjs
//
// ── verified output ───────────────────────────────────────────────────────
// (see examples/README.md)
// ──────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { open } from '../src/index.js'; // in your project: from 'agenticow'
import { tmpdir } from './_shared.mjs';

const DIM = 32;
const dir = tmpdir('gepa');

// Deterministic dependency-free string→vector marker (FNV-1a), as in the production module:
// lineage truth lives in the JSON payload; the vector is a semantic marker for querying.
function embedText(text, dim = DIM) {
  const v = new Float32Array(dim);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
    v[h % dim] += ((h >>> 8) & 0xff) / 255 - 0.5;
  }
  let n = 0;
  for (let i = 0; i < dim; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}

// 1. The FROZEN SEED base: the seed genome's components + its eval traces, stored once.
const base = open(path.join(dir, 'seed.rvf'), { dimension: DIM });
let nextId = 1000;
base.ingest([
  { id: 1, vector: embedText('seed::component::edit_strategy::replace-whole-function'), text: 'edit_strategy: replace-whole-function' },
  { id: 2, vector: embedText('seed::component::localization::grep-then-read'), text: 'localization: grep-then-read' },
]);
console.log(`seed base: ${base.status().totalVectors} vectors (frozen — only a holdout winner may promote)`);

// 2. Candidate loop: checkpoint pre-mutation, then one COW branch PER candidate genome.
//    The external metric (here: a fixed score table standing in for GEPA's train/holdout
//    evals) decides; agenticow only records.
const candidates = [
  { id: 'cand-1', mutation: 'edit_strategy: insert-at-top', train: 0.31, decision: 'reject', lesson: 'inserting at top of file breaks imports ordering' },
  { id: 'cand-2', mutation: 'localization: read-whole-repo', train: 0.28, decision: 'reject', lesson: 'whole-repo reads blow the context budget' },
  { id: 'cand-6', mutation: 'edit_strategy: edit-by-midpoint', train: 0.52, decision: 'holdout_win', holdout: { gold: '2/12 → 3/12', emptyPatch: '0.583 → 0.333', regressions: 0 }, lesson: 'anchor edits on the midpoint of the localized span' },
];

const ck = base.checkpoint('pre-mutation');
console.log(`checkpoint "${ck.label}" (${fs.statSync(ck.path).size} B) — pre-mutation restore point`);

const branches = new Map(); // candidate id → { branch, lesson-record } — RETAINED, win or lose
for (const c of candidates) {
  const br = base.branch(c.id);                       // 162 B COW branch off the frontier parent
  const emptySize = fs.statSync(br.lineage()[0].path).size;
  br.ingest([{ id: nextId++, vector: embedText(`${c.id}::${c.mutation}`), text: `${c.id} :: ${c.mutation} :: ${c.lesson}` }]);
  const d = br.diff();                                // recorded vs parent, per candidate
  branches.set(c.id, { branch: br, record: c });
  console.log(`  ${c.id}: branch ${emptySize} B → diff +${d.added.length}/~${d.overridden.length}/-${d.deleted.length} → external metric says ${c.decision.toUpperCase()} (train ${c.train})`);
}

// 3. Promotion is holdout-gated: ONLY the holdout winner merges into the frozen seed.
const winner = candidates.find((c) => c.decision === 'holdout_win');
const r = branches.get(winner.id).branch.promote(base);
console.log(`promoted ${winner.id} "${winner.mutation}" → ${r.ingested} vector into the seed base`);
console.log(`  measured (production run): holdout gold ${winner.holdout.gold}, empty-patch ${winner.holdout.emptyPatch}, regressions ${winner.holdout.regressions}`);

// 4. Rejected candidates are RETAINED as queryable what-not-to-do memory: a new, similar
//    proposal is checked against each rejected branch's OWN recorded edits (diff().added).
const probe = embedText('cand-9::edit_strategy: insert-at-top-of-file'); // a new, similar proposal
for (const [id, { branch, record }] of branches) {
  if (record.decision !== 'reject') continue;
  const own = new Set(branch.diff().added);
  const hit = branch.query(probe, 10).find((h) => own.has(h.id));
  if (hit?.text) console.log(`  what-not-to-do (${id}, dist ${hit.distance.toFixed(3)}): ${hit.text}`);
}

// 5. What leaves the process: PORTABLE lessons (JSON), not the raw .rvf branch mechanics.
const lessons = candidates.map(({ id, mutation, decision, lesson }) => ({ genome_id: id, mutation, decision, lesson }));
console.log(`portable lessons exported: ${lessons.length} (all decided candidates, win AND lose)`);

base.close();
for (const { branch } of branches.values()) branch.close();
fs.rmSync(dir, { recursive: true, force: true });
