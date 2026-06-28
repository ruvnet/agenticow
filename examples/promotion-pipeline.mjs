// promotion-pipeline.mjs — agent → test-sandbox → review-gate → promote-to-base,
// with a lineage audit at every step. [PLATFORM tier — DEMONSTRATED]
//
// Demonstrates the "memory DevOps" pipeline: an agent proposes memories in an
// isolated branch, a review gate scores them, and ONLY a passing branch is
// promoted into the base. A rejected branch is discarded and never reaches base.
// Every step prints the lineage (parent pointer, label, createdAt, mutations).
//
// Run: node examples/promotion-pipeline.mjs
// ── verified output: see examples/README.md ──

import fs from 'node:fs';
import path from 'node:path';
import { open } from '../src/index.js'; // in your project: from 'agenticow'
import { vecFactory, tmpdir } from './_shared.mjs';

const DIM = 48;
const dir = tmpdir('promotion');
const vec = vecFactory(DIM, 101);
const audit = (mem, step) => {
  const top = mem.lineage()[0];
  console.log(`  audit[${step}] node=${top.label} id=${top.id.slice(0, 8)}… parent=${top.parent ? top.parent.slice(0, 8) + '…' : '—'} mutations=${top.mutations} created=${new Date(top.createdAt).toISOString().slice(11, 23)}`);
};

// Base "production" memory.
const base = open(path.join(dir, 'prod.rvf'), { dimension: DIM });
base.ingest(Array.from({ length: 500 }, (_, i) => ({ id: i, vector: vec() })));
console.log(`production base: ${base.status().totalVectors} vectors`);

// A review gate: accept a branch only if every proposed vector is "in-policy"
// (here: norm-after-normalize ~1 and not a near-duplicate of a flagged vector).
const flagged = vec(); // an example "policy-violating" memory
function reviewGate(proposals) {
  for (const v of proposals) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < DIM; i++) { dot += v[i] * flagged[i]; na += v[i] * v[i]; nb += flagged[i] * flagged[i]; }
    const cosDist = 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
    if (cosDist < 0.05) return { ok: false, reason: 'near a flagged/banned memory' };
  }
  return { ok: true };
}

function runAgent(name, proposals) {
  console.log(`\n── agent "${name}" ──`);
  // 1. agent branch
  const agent = base.fork(`agent/${name}`);
  audit(agent, 'spawn');
  // 2. test sandbox (branch of the agent's work)
  const sandbox = agent.fork(`sandbox/${name}`);
  proposals.forEach((v, i) => sandbox.ingest([{ id: 70000 + i, vector: v }]));
  audit(sandbox, 'sandbox-ingest');
  // 3. review gate
  const verdict = reviewGate(proposals);
  console.log(`  review gate: ${verdict.ok ? 'PASS' : 'REJECT (' + verdict.reason + ')'}`);
  // 4. promote or discard
  const beforeBase = base.status().totalVectors;
  if (verdict.ok) {
    const r = sandbox.promote(base);
    console.log(`  → promoted: ${r.ingested} vectors merged into base (was ${beforeBase}, now ${base.status().totalVectors})`);
  } else {
    const p = sandbox.lineage()[0].path;
    sandbox.close(); fs.rmSync(p, { force: true });
    console.log(`  → discarded sandbox; base unchanged (${base.status().totalVectors} vectors)`);
  }
  agent.close();
  try { sandbox.close(); } catch { /* already closed on reject */ }
}

// Good agent: clean proposals → promoted.
runAgent('alice', [vec(), vec()]);
// Bad agent: one proposal duplicates the flagged memory → rejected, never reaches base.
runAgent('mallory', [vec(), flagged]);

// Final proof: the flagged memory never made it into the base.
const flaggedInBase = base.query(flagged, 1)[0];
console.log(`\nflagged memory present in base = ${flaggedInBase.distance < 0.05} (top hit id ${flaggedInBase.id}, dist ${flaggedInBase.distance.toFixed(3)})`);
console.log(`base final size: ${base.status().totalVectors} vectors`);

base.close();
fs.rmSync(dir, { recursive: true, force: true });
