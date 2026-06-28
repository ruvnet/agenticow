// parallel-selves.mjs — ensemble of cognitive branches off one base.
// [EXOTIC tier — PoC: mechanics demonstrated, cognition OUT OF SCOPE]
//
// HONEST LABEL: this demonstrates the *branching substrate* for an ensemble of
// "selves" — a shared base, four isolated deltas (conservative / creative /
// adversarial / security), a scoring function (the "judge") that picks a winner,
// and promote() of the winner into the base. It does NOT demonstrate that the
// selves are intelligent — the judge here is a deterministic scoring function,
// not an LLM. The cognitive QUALITY of each self is out of scope; only the
// shared-base / isolated-delta / judge+promote MECHANICS are shown.
//
// Run: node examples/parallel-selves.mjs
// ── verified output: see examples/README.md ──

import fs from 'node:fs';
import path from 'node:path';
import { open } from '../src/index.js'; // in your project: from 'agenticow'
import { vecFactory, tmpdir } from './_shared.mjs';

const DIM = 48;
const dir = tmpdir('selves');
const vec = vecFactory(DIM, 404);

const base = open(path.join(dir, 'base.rvf'), { dimension: DIM });
base.ingest(Array.from({ length: 1000 }, (_, i) => ({ id: i, vector: vec() })));

// A "goal" the ensemble is trying to match. The judge scores each self's
// candidate answer (id 90000) by distance to this goal. (Stand-in for any
// outcome/eval function — swap in an LLM judge in a real system.)
const goal = vec();
const selves = ['conservative', 'creative', 'adversarial', 'security'].map((persona, i) => {
  const self = base.fork(`self/${persona}`);
  // each persona ingests a different candidate (here: varying blend toward goal)
  const w = [0.2, 0.95, 0.5, 0.7][i];
  const candidate = Float32Array.from(goal, (x) => x * w + vec()[0] * (1 - w));
  self.ingest([{ id: 90000, vector: candidate }]);
  return { persona, self };
});

// Judge: score each self's candidate vs the goal (lower distance = better).
const ranked = selves.map(({ persona, self }) => {
  const hit = self.query(goal, 1100).find((h) => h.id === 90000);
  return { persona, self, score: hit ? 1 - hit.distance : 0 };
}).sort((a, b) => b.score - a.score);

console.log('ensemble (shared base, isolated deltas) — judge scores:');
for (const r of ranked) console.log(`  ${r.persona.padEnd(13)} score=${r.score.toFixed(4)}`);
const winner = ranked[0];
console.log(`judge picks: "${winner.persona}"`);

// promote the winning self's memory into the shared base.
const r = winner.self.promote(base);
console.log(`promoted "${winner.persona}" → ${r.ingested} vector merged into base`);
console.log('NOTE: mechanics only — the "selves" are scored by a function, not validated as intelligent.');

base.close();
selves.forEach((s) => s.self.close());
fs.rmSync(dir, { recursive: true, force: true });
