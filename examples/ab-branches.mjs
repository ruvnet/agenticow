// ab-branches.mjs — N variant branches off one base, score each, promote winner.
//
// Demonstrates A/B testing / Darwin-style evolution of agent memory: fork many
// variant branches off a shared base, give each a different candidate memory,
// score each variant against a target query, and promote() only the winner back
// into the base. Losing branches are discarded for free.
//
// Run: node examples/ab-branches.mjs
//
// ── verified output ───────────────────────────────────────────────────────
// (see examples/README.md)
// ──────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { open } from '../src/index.js'; // in your project: from 'agenticow'
import { vecFactory, tmpdir } from './_shared.mjs';

const DIM = 32;
const VARIANTS = 8;
const dir = tmpdir('ab');
const vec = vecFactory(DIM, 31);

// 1. Base memory + a "target" we want a variant to match well.
const base = open(path.join(dir, 'base.rvf'), { dimension: DIM });
const flat = new Float32Array(1000 * DIM);
for (let i = 0; i < 1000; i++) flat.set(vec(), i * DIM);
base.ingest(flat, Array.from({ length: 1000 }, (_, i) => i));
const target = vec();
console.log(`base: ${base.status().totalVectors} vectors; scoring ${VARIANTS} variant branches against a target`);

// 2. Fork one branch per variant; each ingests a candidate vector (id 5000).
//    Variant v's candidate is a blend of the target and noise — higher v = closer.
const variants = [];
for (let v = 0; v < VARIANTS; v++) {
  const br = base.fork(`variant-${v}`);
  const blend = Float32Array.from(target, (x) => x * (v / (VARIANTS - 1)) + (vec()[0] * (1 - v / (VARIANTS - 1))));
  br.ingest([{ id: 5000, vector: blend }]);
  variants.push(br);
}

// 3. Score each variant: distance of its candidate (id 5000) to the target.
//    Use k > base size so the candidate is always included in the read-through.
const scores = variants.map((br, v) => {
  const hit = br.query(target, 1001).find((h) => h.id === 5000);
  return { v, dist: hit ? hit.distance : Infinity };
});
scores.sort((a, b) => a.dist - b.dist);
for (const s of scores) console.log(`  variant-${s.v}: candidate distance to target = ${s.dist.toFixed(4)}`);
const winner = scores[0];
console.log(`winner: variant-${winner.v} (dist ${winner.dist.toFixed(4)})`);

// 4. Promote the winner into the base; discard the rest for free.
const r = variants[winner.v].promote(base);
const inBase = base.query(target, 5).some((h) => h.id === 5000);
console.log(`promoted variant-${winner.v} → ${r.ingested} vector merged; winner candidate now in base = ${inBase}`);

base.close();
variants.forEach((br) => br.close());
fs.rmSync(dir, { recursive: true, force: true });
