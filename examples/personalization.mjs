// personalization.mjs — one shared base memory, a cheap COW branch per user.
//
// Demonstrates: per-user/per-account personalization without copying the base.
// Each user gets an isolated branch (their edits stay private) while still
// reading through to the shared base. Storage is delta-only (KB/user), not a
// full copy of the base (MB/user).
//
// Run: node examples/personalization.mjs
//
// ── verified output ───────────────────────────────────────────────────────
// (see examples/README.md — outputs are deterministic via a seeded RNG)
// ──────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { open } from '../src/index.js'; // in your project: from 'agenticow'
import { vecFactory, tmpdir, ms, kb, mb } from './_shared.mjs';

const DIM = 64;
const USERS = 50;
const dir = tmpdir('personalization');
const vec = vecFactory(DIM, 1);

// 1. One shared base memory (e.g. the org-wide knowledge base).
const base = open(path.join(dir, 'base.rvf'), { dimension: DIM });
const N = 10_000;
const flat = new Float32Array(N * DIM);
const ids = [];
for (let i = 0; i < N; i++) { flat.set(vec(), i * DIM); ids.push(i); }
base.ingest(flat, ids);
const baseBytes = base.status().fileSize;
console.log(`base: ${N.toLocaleString()} vectors, ${mb(baseBytes)}`);

// 2. A cheap COW branch per user — fork() off the read-only base.
//    Each user adds one private preference vector (id 900000 + u).
const t0 = performance.now();
const users = [];
for (let u = 0; u < USERS; u++) {
  const ub = base.fork(`user-${u}`);
  ub.ingest([{ id: 900000 + u, vector: vec() }]);
  users.push(ub);
}
const forkWall = ms(t0);
let deltaBytes = 0;
for (const u of users) deltaBytes += fs.statSync(u.lineage()[0].path).size;
const fullCopyBytes = baseBytes * USERS;
console.log(`branched ${USERS} users in ${forkWall} (${((performance.now() - t0) / USERS).toFixed(3)} ms/user) — ` +
  `total delta ${kb(deltaBytes)} (${(deltaBytes / USERS / 1024).toFixed(2)} KB/user)`);
console.log(`vs ${USERS} full copies of the base: ${mb(fullCopyBytes)}  →  ` +
  `${Math.round(fullCopyBytes / deltaBytes).toLocaleString()}x less storage`);

// 3. Isolation: user-0 sees its own preference; user-1's stays private.
const u0SeesOwn = users[0].diff().added.includes(900000);
const u1LeaksToU0 = users[0]
  .query(flat.slice(0, DIM), USERS)
  .some((h) => h.id === 900001);
console.log(`isolation: user-0 sees own pref (id 900000)=${u0SeesOwn}, user-1's pref leaks to user-0=${u1LeaksToU0}`);

// 4. Read-through: every user still queries the shared base.
const probe = flat.slice(42 * DIM, 43 * DIM);
const hit = users[7].query(probe, 1)[0];
console.log(`read-through: user-7 top hit for base vector #42 = id ${hit.id} (from ${hit.branch})`);

base.close();
users.forEach((u) => u.close());
fs.rmSync(dir, { recursive: true, force: true });
