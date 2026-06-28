import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open } from '../src/index.js';

const DIM = 16;
function rnd() { return Float32Array.from({ length: DIM }, () => Math.random() * 2 - 1); }
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agenticow-test-'));
  return d;
}

test('read-through: branch sees base vectors (parent ∪ edits)', () => {
  const dir = tmpdir();
  const base = open(path.join(dir, 'base.rvf'), { dimension: DIM });
  const recs = [];
  for (let i = 0; i < 50; i++) recs.push({ id: i, vector: rnd() });
  base.ingest(recs);

  const br = base.branch('agent-a');
  // query the branch for a known base vector -> should find it via read-through
  const target = recs[7].vector;
  const hits = br.query(target, 3);
  assert.equal(hits[0].id, 7, 'branch must read through to base vector id 7');
  base.close();
  br.close();
});

test('child wins on id collision (override)', () => {
  const dir = tmpdir();
  const base = open(path.join(dir, 'base.rvf'), { dimension: DIM });
  const v5 = rnd();
  base.ingest([{ id: 5, vector: v5 }, { id: 6, vector: rnd() }]);
  const br = base.branch('agent-b');
  const newV5 = rnd();
  br.ingest([{ id: 5, vector: newV5 }]); // override id 5 in branch
  // querying for the NEW v5 should return id 5 from the branch
  const hits = br.query(newV5, 1);
  assert.equal(hits[0].id, 5);
  assert.ok(hits[0].distance < 0.01, 'branch override should match closely');
  base.close();
  br.close();
});

test('isolation: parent does not see branch edits and vice versa', () => {
  const dir = tmpdir();
  const base = open(path.join(dir, 'base.rvf'), { dimension: DIM });
  base.ingest([{ id: 1, vector: rnd() }]);
  const br = base.branch('iso');
  const onlyInBranch = rnd();
  br.ingest([{ id: 999, vector: onlyInBranch }]);
  const onlyInParent = rnd();
  base.ingest([{ id: 888, vector: onlyInParent }]);
  // parent must NOT see branch's 999
  const pHits = base.query(onlyInBranch, 5).map((h) => h.id);
  assert.ok(!pHits.includes(999), 'parent must not see branch-only id 999');
  // branch must NOT see parent's later 888
  const bHits = br.query(onlyInParent, 5).map((h) => h.id);
  assert.ok(!bHits.includes(888), 'branch must not see parent later id 888');
  base.close();
  br.close();
});

test('delete tombstone hides ancestor vector from branch', () => {
  const dir = tmpdir();
  const base = open(path.join(dir, 'base.rvf'), { dimension: DIM });
  const v3 = rnd();
  base.ingest([{ id: 3, vector: v3 }, { id: 4, vector: rnd() }]);
  const br = base.branch('del');
  br.delete([3]);
  const hits = br.query(v3, 5).map((h) => h.id);
  assert.ok(!hits.includes(3), 'tombstoned id 3 must be hidden in branch');
  // base still has it
  const bHits = base.query(v3, 1);
  assert.equal(bHits[0].id, 3);
  base.close();
  br.close();
});

test('checkpoint + rollback discards poisoned edits', () => {
  const dir = tmpdir();
  const mem = open(path.join(dir, 'm.rvf'), { dimension: DIM });
  const good = rnd();
  mem.ingest([{ id: 1, vector: good }]);
  const ckpt = mem.checkpoint('clean');
  // poison: add a bad vector
  const poison = rnd();
  mem.ingest([{ id: 666, vector: poison }]);
  assert.equal(mem.query(poison, 1)[0].id, 666, 'poison present before rollback');
  // rollback to clean checkpoint
  mem.rollback(ckpt.id);
  const after = mem.query(poison, 5).map((h) => h.id);
  assert.ok(!after.includes(666), 'poison gone after rollback');
  // good data survives
  assert.equal(mem.query(good, 1)[0].id, 1, 'clean data survives rollback');
  mem.close();
});

test('fork: many branches off a static base, all read through', () => {
  const dir = tmpdir();
  const base = open(path.join(dir, 'base.rvf'), { dimension: DIM });
  const recs = [];
  for (let i = 0; i < 100; i++) recs.push({ id: i, vector: rnd() });
  base.ingest(recs);
  const forks = [];
  for (let i = 0; i < 25; i++) forks.push(base.fork(`u${i}`));
  // each fork reads through to a base vector and isolates its own insert
  for (let i = 0; i < 25; i++) {
    forks[i].ingest([{ id: 500000 + i, vector: rnd() }]);
    assert.equal(forks[i].query(recs[10].vector, 1)[0].id, 10, 'fork reads base');
  }
  // fork 0 must not see fork 1's private insert
  const v = rnd();
  forks[1].ingest([{ id: 777, vector: v }]);
  assert.ok(!forks[0].query(v, 5).map((h) => h.id).includes(777));
  base.close(); forks.forEach((f) => f.close());
});

test('diff + promote: branch edits merge into a target', () => {
  const dir = tmpdir();
  const prod = open(path.join(dir, 'prod.rvf'), { dimension: DIM });
  prod.ingest([{ id: 1, vector: rnd() }]);
  const feature = prod.fork('feature');
  const v1 = rnd(); const v2 = rnd();
  feature.ingest([{ id: 100, vector: v1 }, { id: 101, vector: v2 }]);
  feature.delete([1]);
  const d = feature.diff();
  assert.deepEqual(d.added, [100, 101]);
  assert.deepEqual(d.deleted, [1]);
  const r = feature.promote(prod);
  assert.equal(r.ingested, 2);
  // prod now has the promoted vector
  assert.equal(prod.query(v1, 1)[0].id, 100);
  prod.close(); feature.close();
});

test('save/load: read-through survives a reopen (metric quirk handled)', async () => {
  const dir = tmpdir();
  const base = open(path.join(dir, 'base.rvf'), { dimension: DIM });
  const recs = [];
  for (let i = 0; i < 80; i++) recs.push({ id: i, vector: rnd() });
  base.ingest(recs);
  const br = base.fork('persist', path.join(dir, 'br.rvf'));
  br.ingest([{ id: 9001, vector: rnd() }]);
  br.delete([3]);
  const man = path.join(dir, 'br.json');
  br.save(man);
  base.close(); br.close();
  // reopen from manifest in a "fresh" state
  const { AgenticMemory } = await import('../src/index.js');
  const reopened = AgenticMemory.load(man);
  // read-through still returns the right base vector (id 7), correctly ranked
  assert.equal(reopened.query(recs[7].vector, 1)[0].id, 7);
  // tombstone still masked after reopen
  assert.ok(!reopened.query(recs[3].vector, 5).map((h) => h.id).includes(3));
  reopened.close();
});

test('native ANN across branch: cosine recall@10 ~1.0 (or graceful fallback)', () => {
  const dir = tmpdir();
  const base = open(path.join(dir, 'base.rvf'), { dimension: DIM }); // cosine default
  const bv = Array.from({ length: 800 }, () => rnd());
  const flat = new Float32Array(800 * DIM);
  bv.forEach((v, i) => flat.set(v, i * DIM));
  base.ingest(flat, bv.map((_, i) => i));
  const nat = base.fork('agent', undefined, { nativeAnn: true });
  // ingest some edits into the native branch
  const ev = new Map();
  for (let i = 0; i < 40; i++) { const id = 1e6 + i; const v = rnd(); nat.ingest([{ id, vector: v }]); ev.set(id, v); }
  const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < DIM; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return 1 - d / (Math.sqrt(na) * Math.sqrt(nb)); };
  let sum = 0; const Q = 40, K = 10;
  for (let q = 0; q < Q; q++) {
    const qv = rnd();
    const gold = new Set([...bv.map((v, id) => ({ id, d: cos(qv, v) })), ...[...ev].map(([id, v]) => ({ id, d: cos(qv, v) }))]
      .sort((a, b) => a.d - b.d).slice(0, K).map((c) => c.id));
    const got = nat.query(qv, K).map((h) => h.id);
    sum += got.filter((id) => gold.has(id)).length / K;
  }
  const recall = sum / Q;
  // On linux-x64 the native path runs (recall must be high); elsewhere it
  // degrades to exact read-through (also high). Either way recall must be >= 0.9.
  assert.ok(recall >= 0.9, `native/fallback recall@10 too low: ${recall}`);
  base.close(); nat.close();
});
