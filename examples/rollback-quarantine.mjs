// rollback-quarantine.mjs — quarantine a poisoned ingest, then discard it.
//
// Demonstrates: an agent ingests "hallucinated" / adversarial vectors into a
// branch. You detect them, then throw the branch away → the shared base is
// instantly clean. No re-indexing, no restore-from-backup. Shows the query
// result before (poison visible in the branch) and after (gone, base intact).
//
// Run: node examples/rollback-quarantine.mjs
//
// ── verified output ───────────────────────────────────────────────────────
// (see examples/README.md)
// ──────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { open } from '../src/index.js'; // in your project: from 'agenticow'
import { vecFactory, tmpdir, ms } from './_shared.mjs';

const DIM = 48;
const dir = tmpdir('quarantine');
const vec = vecFactory(DIM, 7);

// 1. Trusted base memory.
const base = open(path.join(dir, 'base.rvf'), { dimension: DIM });
const known = Array.from({ length: 2000 }, () => vec());
const flat = new Float32Array(2000 * DIM);
known.forEach((v, i) => flat.set(v, i * DIM));
base.ingest(flat, known.map((_, i) => i));
console.log(`base: ${base.status().totalVectors} trusted vectors`);

// 2. An untrusted agent works in a sandbox branch and ingests poison.
const sandbox = base.fork('untrusted-agent');
const sandboxPath = sandbox.lineage()[0].path; // capture before we close it
const poison = Array.from({ length: 100 }, () => vec());
const POISON_IDS = poison.map((_, i) => 666000 + i);
poison.forEach((v, i) => sandbox.ingest([{ id: POISON_IDS[i], vector: v }]));
console.log(`agent ingested ${POISON_IDS.length} unvetted vectors into its sandbox branch`);

// 3. Detection: query near a poisoned vector — it should surface in the sandbox.
const detect = sandbox.query(poison[0], 1)[0];
const poisonPresent = POISON_IDS.includes(detect.id);
console.log(`before: query near poison[0] -> id ${detect.id} (poison present in sandbox = ${poisonPresent})`);

// 4. Quarantine = discard the branch. The base never saw the poison.
const t0 = performance.now();
sandbox.close();
fs.rmSync(sandboxPath, { force: true });
const discardMs = ms(t0);
const poisonInBase = POISON_IDS.includes(base.query(poison[0], 1)[0].id);
console.log(`discarded branch in ${discardMs} → poison present in base = ${poisonInBase}`);
console.log(`base intact: ${base.status().totalVectors} vectors, base vector #1 still found = ${base.query(known[1], 1)[0].id === 1}`);

base.close();
fs.rmSync(dir, { recursive: true, force: true });
