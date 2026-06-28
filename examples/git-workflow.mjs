// git-workflow.mjs — agent → test → prod memory pipeline (branch/diff/promote).
//
// Demonstrates the Git-style workflow for vector memory: branch a feature off
// production, ingest into it, review the change with diff(), then promote() the
// vetted delta back into production. Production is untouched until you promote.
//
// Run: node examples/git-workflow.mjs
//
// ── verified output ───────────────────────────────────────────────────────
// (see examples/README.md)
// ──────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { open } from '../src/index.js'; // in your project: from 'agenticow'
import { vecFactory, tmpdir } from './_shared.mjs';

const DIM = 32;
const dir = tmpdir('git-workflow');
const vec = vecFactory(DIM, 23);

// 1. Production memory.
const prod = open(path.join(dir, 'prod.rvf'), { dimension: DIM });
const v1 = vec(); const v2 = vec();
prod.ingest([{ id: 1, vector: v1 }, { id: 2, vector: v2 }]);
console.log(`prod: ${prod.status().totalVectors} vectors`);

// 2. Branch a feature, ingest new memories, override one, delete one.
const feature = prod.branch('feature/new-facts');
const f100 = vec(); const f101 = vec(); const v2new = vec();
feature.ingest([{ id: 100, vector: f100 }, { id: 101, vector: f101 }]);
feature.ingest([{ id: 2, vector: v2new }]); // override an existing prod id
feature.delete([1]);                          // retract a prod fact in the branch

// 3. Review the change set before merging.
const d = feature.diff();
console.log(`diff(feature): +added=${JSON.stringify(d.added)} ~overridden=${JSON.stringify(d.overridden)} -deleted=${JSON.stringify(d.deleted)}`);

// prod is still untouched at this point (feature edits are isolated):
const id100InProdBefore = prod.query(f100, 1)[0].id === 100;
console.log(`prod before promote: id 1 present = ${prod.query(v1, 1)[0].id === 1}, feature id 100 present = ${id100InProdBefore}`);

// 4. Promote the vetted delta into production.
const r = feature.promote(prod);
console.log(`promote → ${r.ingested} vectors merged, ${r.deleted} tombstoned into prod`);
const id100InProd = prod.query(f100, 1)[0].id === 100;
const id1Retracted = prod.query(v1, 5).every((h) => h.id !== 1);
console.log(`prod after promote: id 100 present = ${id100InProd}, id 1 retracted = ${id1Retracted}`);

prod.close();
feature.close();
fs.rmSync(dir, { recursive: true, force: true });
