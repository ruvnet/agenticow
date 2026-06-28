// multi-persona-consensus.mjs — 5 persona branches, an EXTERNAL judge, 1 winner.
//
// PARADIGM: Branch → Mutate → external-Verify → Promote / Discard.
// One base memory, 5 single-turn persona branches (security-cynic, perf-optimizer,
// compliance-auditor, ux-advocate, cost-minimizer). Each persona proposes one
// "answer" embedding into its own isolated branch. An EXTERNAL DETERMINISTIC
// JUDGE selects the winner and ONLY the winner's delta is promoted into the base.
//
// The judge is a two-part deterministic selector — NOT a cheap LM-judge:
//   (1) a HARD CONSTRAINT checker (a boolean policy gate): a proposal is
//       DISQUALIFIED if it lands within a forbidden region (cosine to a banned
//       "policy-violation" direction below a margin) — like a regex/schema gate.
//   (2) a SCORE among the qualified: cosine distance to a known-good target
//       (a rubric vector) — lower is better.
// This is ensemble *mechanics* with an external selector. The scaffolding
// ablation showed THIS shape is the right one: a verifier-gated cheap-LM judge
// picks WORSE than a plain vote (a negative generation–verification gap), so the
// selector here is a checker function that cannot hallucinate, not a model.
//
// Run: node examples/multi-persona-consensus.mjs
//
// ── verified output (deterministic) ─────────────────────────────────────────
// base: 1500 shared vectors; 5 personas each propose 1 answer into a branch
//   compliance-auditor   score=0.0000  constraint=PASS   ← qualified
//   perf-optimizer       score=0.0152  constraint=PASS   ← qualified
//   ux-advocate          score=0.0809  constraint=PASS   ← qualified
//   security-cynic       score=0.1792  constraint=PASS   ← qualified
//   cost-minimizer       score=  n/a   constraint=FAIL (forbidden region)  ✗ disqualified
// external judge → winner: "compliance-auditor" (score 0.0000, 4/5 qualified)
// promoted winner delta into base (1500 → 1501); 4 losing branches discarded for free
// winner answer now reachable in base = true ; any loser reachable in base = false
// ──────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { openBase } from '../src/index.js'; // in your project: from 'agenticow'
import { vecFactory, tmpdir } from './_shared.mjs';

const DIM = 64;
const dir = tmpdir('consensus');
const vec = vecFactory(DIM, 2024);

// The task: an ideal-answer "rubric" target (deterministic) the judge scores against.
const TARGET = vecFactory(DIM, 555)();
// A forbidden "policy-violation" direction. Proposals too close to it are
// disqualified by the hard-constraint checker regardless of their score.
const FORBIDDEN = vecFactory(DIM, 666)();
const FORBIDDEN_MARGIN = 0.05; // cosine-distance margin around the banned region

function cosineDistance(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ── 5 personas, each with a deterministic proposal vector ───────────────────
// Proposals are mixes of TARGET + persona noise so they spread out predictably.
// compliance-auditor lands exactly on target; cost-minimizer lands in the
// forbidden region (it will be disqualified by the constraint gate).
const personas = [
  { name: 'security-cynic',     mix: 0.55, seed: 11 },
  { name: 'perf-optimizer',     mix: 0.85, seed: 22 },
  { name: 'compliance-auditor', mix: 1.00, seed: 33 },  // best
  { name: 'ux-advocate',        mix: 0.70, seed: 44 },
  { name: 'cost-minimizer',     mix: 0.00, seed: 55, forbidden: true }, // violates policy
];

function proposalFor(p) {
  if (p.forbidden) return Float32Array.from(FORBIDDEN); // lands in the banned region
  const noise = vecFactory(DIM, p.seed)();
  const out = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) out[i] = p.mix * TARGET[i] + (1 - p.mix) * noise[i];
  return out;
}

// ── HARD CONSTRAINT checker (boolean policy gate) ───────────────────────────
function constraintPass(proposalVec) {
  return cosineDistance(proposalVec, FORBIDDEN) > FORBIDDEN_MARGIN;
}

// base + 1500 shared vectors
const base = openBase(path.join(dir, 'base.rvf'), { dimension: DIM });
const shared = Array.from({ length: 1500 }, () => vec());
const sflat = new Float32Array(1500 * DIM);
shared.forEach((v, i) => sflat.set(v, i * DIM));
base.ingest(sflat, shared.map((_, i) => i));
console.log(`base: ${base.status().totalVectors} shared vectors; 5 personas each propose 1 answer into a branch`);

// each persona forks a branch and ingests its single proposal
const ANSWER_ID = 880000;
const branches = personas.map((p, i) => {
  const b = base.fork(p.name);
  const proposal = proposalFor(p);
  b.ingest(proposal, { id: ANSWER_ID + i, text: `${p.name}-answer` });
  return { p, b, proposal, answerId: ANSWER_ID + i };
});

// ── EXTERNAL judge: constraint gate, then score among the qualified ─────────
const scored = branches.map(({ p, proposal, answerId, b }) => {
  const pass = constraintPass(proposal);
  const score = pass ? cosineDistance(proposal, TARGET) : Infinity;
  return { name: p.name, pass, score, answerId, b, proposal };
});
for (const s of [...scored].sort((a, b) => a.score - b.score)) {
  if (s.pass) {
    console.log(`  ${s.name.padEnd(20)} score=${s.score.toFixed(4)}  constraint=PASS   ← qualified`);
  } else {
    console.log(`  ${s.name.padEnd(20)} score=  n/a   constraint=FAIL (forbidden region)  ✗ disqualified`);
  }
}

const qualified = scored.filter((s) => s.pass);
const winner = qualified.reduce((a, b) => (b.score < a.score ? b : a));
console.log(`external judge → winner: "${winner.name}" (score ${winner.score.toFixed(4)}, ${qualified.length}/${personas.length} qualified)`);

// promote ONLY the winner's delta; discard the losers for free.
const before = base.status().totalVectors;
winner.b.promote();
for (const s of scored) if (s !== winner) s.b.close();
console.log(`promoted winner delta into base (${before} → ${base.status().totalVectors}); ${personas.length - 1} losing branches discarded for free`);

// verify the selection actually took effect: winner reachable in base, losers not.
const winReach = base.query(winner.proposal, 1).some((h) => h.id === winner.answerId);
const anyLoser = scored.filter((s) => s !== winner).some((s) =>
  base.query(s.proposal, 5).some((h) => h.id === s.answerId));
console.log(`winner answer now reachable in base = ${winReach} ; any loser reachable in base = ${anyLoser}`);

winner.b.close();
base.close();
fs.rmSync(dir, { recursive: true, force: true });
