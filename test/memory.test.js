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
