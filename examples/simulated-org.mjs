// simulated-org.mjs — departmental branches + cross-branch contradiction check.
// [EXOTIC tier — PoC: graph + contradiction-detection mechanics demonstrated]
//
// HONEST LABEL: demonstrates the MECHANICS of a "simulated org" memory — four
// departmental branches (Finance / Legal / Eng / Sales) off one corporate base,
// each asserting facts at shared "topic" ids. Before a rollout (promote-all) we
// detect CONTRADICTIONS: the same topic id asserted with divergent values across
// branches. This shows the branch graph + a contradiction scan; it does NOT
// claim the departments reason — the facts are vectors and the contradiction
// rule is a distance threshold.
//
// Run: node examples/simulated-org.mjs
// ── verified output: see examples/README.md ──

import fs from 'node:fs';
import path from 'node:path';
import { open } from '../src/index.js'; // in your project: from 'agenticow'
import { vecFactory, tmpdir } from './_shared.mjs';

const DIM = 32;
const dir = tmpdir('org');
const vec = vecFactory(DIM, 606);

const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < DIM; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return 1 - d / (Math.sqrt(na) * Math.sqrt(nb)); };

const base = open(path.join(dir, 'corp.rvf'), { dimension: DIM });
base.ingest(Array.from({ length: 400 }, (_, i) => ({ id: i, vector: vec() })));

// Topic ids both departments may assert facts about (e.g. "remote-policy",
// "revenue-recognition", "headcount", "contract-terms").
const TOPICS = { 1001: 'remote-policy', 1002: 'revenue-recognition', 1003: 'headcount', 1004: 'contract-terms' };

// Each dept branch asserts a value vector per topic. We track the asserted
// vectors so a governance scan can compare them across branches.
const facts = {}; // dept -> Map(topicId -> vector)
const depts = {};
const sharedRevenue = vec(); // Finance & Sales AGREE on revenue-recognition
for (const name of ['Finance', 'Legal', 'Eng', 'Sales']) {
  const b = base.fork(`dept:${name}`);
  const m = new Map();
  for (const tid of Object.keys(TOPICS).map(Number)) {
    // Most facts are dept-specific (independent) → many will diverge.
    let v = vec();
    if (tid === 1002 && (name === 'Finance' || name === 'Sales')) v = sharedRevenue; // an agreement
    b.ingest([{ id: tid, vector: v }]);
    m.set(tid, v);
  }
  facts[name] = m; depts[name] = b;
}

// Contradiction scan: for each topic, compare every pair of departments. A
// contradiction = both assert the topic but their vectors diverge beyond a
// threshold (cosine distance > 0.3).
const THRESH = 0.3;
const names = Object.keys(facts);
const contradictions = [];
for (const tid of Object.keys(TOPICS).map(Number)) {
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = facts[names[i]].get(tid), b = facts[names[j]].get(tid);
      if (!a || !b) continue;
      const d = cos(a, b);
      if (d > THRESH) contradictions.push({ topic: TOPICS[tid], a: names[i], b: names[j], dist: d });
    }
  }
}

console.log(`departments: ${names.join(', ')} (each a COW branch off the corporate base)`);
console.log(`scanned ${Object.keys(TOPICS).length} topics × ${names.length * (names.length - 1) / 2} dept-pairs`);
console.log(`contradictions found (cosine distance > ${THRESH}): ${contradictions.length}`);
// show a few, and confirm the known agreement is NOT flagged
const agreementFlagged = contradictions.some((c) => c.topic === 'revenue-recognition' && ((c.a === 'Finance' && c.b === 'Sales') || (c.a === 'Sales' && c.b === 'Finance')));
for (const c of contradictions.slice(0, 4)) console.log(`  ⚠ "${c.topic}": ${c.a} vs ${c.b} diverge (dist ${c.dist.toFixed(3)})`);
console.log(`Finance↔Sales agree on revenue-recognition (not flagged) = ${!agreementFlagged}`);
console.log(`→ gate the rollout: ${contradictions.length} contradictions must be resolved before promote-all to base.`);
console.log('NOTE: mechanics only — facts are vectors; the contradiction rule is a distance threshold, not reasoning.');

base.close();
Object.values(depts).forEach((b) => b.close());
fs.rmSync(dir, { recursive: true, force: true });
