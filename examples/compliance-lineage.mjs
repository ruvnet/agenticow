// compliance-lineage.mjs — provenance + right-to-erasure via the lineage graph.
// [PLATFORM tier — DEMONSTRATED]
//
// Demonstrates two compliance questions answered with agenticow primitives:
//   1. "Why does the agent know X?"  -> query() returns which branch a hit came
//      from; lineage() gives the parent/author(label)/timestamp trail.
//   2. "Remove user Y's data."        -> each user's contributions live in their
//      own branch layer; dropping that layer surgically erases exactly their
//      data, leaving the base and other users intact (isolation = GDPR-friendly).
//
// Run: node examples/compliance-lineage.mjs
// ── verified output: see examples/README.md ──

import fs from 'node:fs';
import path from 'node:path';
import { open } from '../src/index.js'; // in your project: from 'agenticow'
import { vecFactory, tmpdir } from './_shared.mjs';

const DIM = 48;
const dir = tmpdir('compliance');
const vec = vecFactory(DIM, 202);

// Shared base knowledge.
const base = open(path.join(dir, 'corp.rvf'), { dimension: DIM });
base.ingest(Array.from({ length: 300 }, (_, i) => ({ id: i, vector: vec() })));

// Each user contributes in their OWN branch (author = branch label).
const userVecs = {};
const users = {};
for (const name of ['alice', 'bob', 'carol']) {
  const b = base.fork(`author:${name}`);
  const v = vec();
  b.ingest([{ id: 50000, vector: v }]); // each asserts a "fact" at id 50000
  userVecs[name] = v;
  users[name] = b;
}

// 1. Provenance: "why does the agent know this fact?" — trace the source branch.
console.log('— provenance —');
for (const name of ['alice', 'bob']) {
  const hit = users[name].query(userVecs[name], 1)[0];
  const ln = users[name].lineage();
  const src = ln.find((n) => n.id === hit.branch || n.label === hit.branch) || ln[0];
  console.log(`  ${name}: fact id ${hit.id} sourced from "${src.label}" (created ${new Date(src.createdAt).toISOString().slice(11, 19)}, mutations=${src.mutations})`);
}

// 2. Right-to-erasure: remove carol's data by dropping her branch layer.
console.log('\n— right-to-erasure (remove user "carol") —');
const carolHasIt = users.carol.query(userVecs.carol, 1)[0].id === 50000;
console.log(`  before: carol's branch knows her fact = ${carolHasIt}`);
const carolPath = users.carol.lineage()[0].path;
users.carol.close();
fs.rmSync(carolPath, { force: true }); // surgically drop the layer
console.log(`  dropped carol's branch layer (${path.basename(carolPath)})`);
// base never held carol's fact (isolation), and alice/bob are untouched.
const inBase = base.query(userVecs.carol, 1)[0];
console.log(`  after: carol's fact in base = ${inBase.id === 50000 && inBase.distance < 0.05} (base never held it)`);
console.log(`  alice still intact = ${users.alice.query(userVecs.alice, 1)[0].id === 50000}, bob still intact = ${users.bob.query(userVecs.bob, 1)[0].id === 50000}`);

base.close();
users.alice.close(); users.bob.close();
fs.rmSync(dir, { recursive: true, force: true });
