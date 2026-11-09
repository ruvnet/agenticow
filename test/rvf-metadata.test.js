// rvf-node >= 0.4.2 integration: durable text metadata, persisted metric,
// forceExact pass-through, the feature-check fallback, and reading stores
// written by agenticow 0.2.5 on rvf-node 0.4.0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgenticMemory, TEXT_FIELD } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const v = (s, d = 8) => Array.from({ length: d }, (_, i) => Math.sin(s * 1.7 + i));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'acow-meta-'));

test('texts survive a plain open() of the .rvf (no manifest)', () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'b.rvf');
    const m = AgenticMemory.open(f, { dimension: 8 });
    m.ingest([{ id: 1, vector: v(1), text: 'alpha' }, { id: 2, vector: v(2) }]);
    m.ingest(v(3), { id: 3, text: 'gamma "q" ünï' });
    m.close();
    const r = AgenticMemory.open(f);
    assert.equal(r.query(v(1), 1)[0].text, 'alpha');
    assert.equal(r.query(v(3), 1)[0].text, 'gamma "q" ünï');
    assert.equal(r.query(v(2), 1)[0].text, undefined, 'no text -> no field');
    r.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cosine metric is persisted, so a plain open() keeps normalizing', () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'b.rvf');
    AgenticMemory.open(f, { dimension: 8, metric: 'cosine' }).close();
    const r = AgenticMemory.open(f);
    assert.equal(r.status().metric, 'cosine');
    // a scaled copy of a stored direction must be distance ~0 under cosine
    r.ingest([{ id: 9, vector: v(9).map((x) => x * 50) }]);
    assert.ok(r.query(v(9), 1)[0].distance < 1e-5);
    r.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('texts written on a branch and a promote land on disk', () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'b.rvf');
    const base = AgenticMemory.open(f, { dimension: 8 });
    base.ingest([{ id: 1, vector: v(1), text: 'base' }]);
    const br = base.fork('agent');
    br.ingest([{ id: 2, vector: v(2), text: 'from-branch' }]);
    assert.equal(br.query(v(1), 1)[0].text, 'base', 'read-through text from ancestor');
    br.promote();
    br.close();
    base.close();
    const r = AgenticMemory.open(f);
    assert.equal(r.query(v(2), 1)[0].text, 'from-branch', 'promoted text is durable');
    r.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('native COW fork returns parent texts from metadata', () => {
  const dir = tmp();
  try {
    const base = AgenticMemory.open(path.join(dir, 'b.rvf'), { dimension: 8 });
    base.ingest([{ id: 1, vector: v(1), text: 'parent' }]);
    const nat = base.fork('n', undefined, { nativeAnn: true });
    nat._working.texts.clear(); base._working.texts.clear(); // only disk metadata left
    nat.ingest([{ id: 2, vector: v(2) }]);
    if (nat.nativeAnn) assert.equal(nat.query(v(1), 1)[0].text, 'parent');
    // forceExact on a native fork still spans parent and child
    assert.deepEqual(nat.query(v(1), 2, { forceExact: true }).map((h) => h.id).sort(), [1, 2]);
    nat.close(); base.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('forceExact chain-walk equals brute force', () => {
  const dir = tmp();
  try {
    const D = 64, N = 3000;
    const m = AgenticMemory.open(path.join(dir, 'b.rvf'), { dimension: D });
    let s = 3; const r = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5; };
    const rows = new Map(); const flat = new Float32Array(N * D); const ids = [];
    for (let i = 0; i < N; i++) { const x = Float32Array.from({ length: D }, r); flat.set(x, i * D); ids.push(i); rows.set(i, x); }
    m.ingest(flat, ids);
    m.checkpoint();
    for (let i = 0; i < 50; i++) { const x = Float32Array.from({ length: D }, r); m.ingest([{ id: i * 13, vector: x }]); rows.set(i * 13, x); }
    const nrm = (x) => { const n = Math.hypot(...x); return x.map((y) => y / n); };
    for (let q = 0; q < 10; q++) {
      const qv = Float32Array.from({ length: D }, r); const qn = nrm(qv);
      const truth = [...rows].map(([id, x]) => { const xn = nrm(x); let d = 0; for (let j = 0; j < D; j++) d += (xn[j] - qn[j]) ** 2; return [id, d]; })
        .sort((a, b) => a[1] - b[1]).slice(0, 10).map((e) => e[0]);
      assert.deepEqual(m.query(qv, 10, { forceExact: true }).map((h) => h.id), truth);
    }
    m.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('falls back cleanly when the binding lacks the metadata API', () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'b.rvf');
    const m = AgenticMemory.open(f, { dimension: 8 });
    // simulate rvf-node 0.4.0/0.4.1 on this handle
    m._working.db.ingestBatchWithMetadata = undefined;
    m.ingest([{ id: 1, vector: v(1), text: 'mem-only' }]);
    assert.equal(m.query(v(1), 1)[0].text, 'mem-only');
    m.close();
    const r = AgenticMemory.open(f);
    assert.equal(r.query(v(1), 1)[0].text, undefined, 'old path: text not on disk');
    r.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stores written by agenticow 0.2.5 + rvf-node 0.4.0 still open', () => {
  const src = path.join(here, 'fixtures', 'legacy-0.2.5');
  const dir = tmp();
  try {
    for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dir, f));
    const manPath = path.join(dir, 'legacy.agenticow.json');
    const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
    for (const n of man.nodes) n.path = path.join(dir, n.path);
    fs.writeFileSync(manPath, JSON.stringify(man));
    const exp = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
    const m = AgenticMemory.load(manPath);
    exp.seeds.forEach((s, i) => {
      const got = m.query(v(s), 3).map((h) => [h.id, +h.distance.toFixed(5), h.text ?? null]);
      assert.deepEqual(got, exp.expect[i], `seed ${s}`);
    });
    // new writes on top of a legacy store work and are durable
    m.ingest([{ id: 7, vector: v(7), text: 'new' }]);
    assert.equal(m.query(v(7), 1)[0].text, 'new');
    m.close();
    // the raw legacy base also opens with a plain open() (metric via opts)
    const raw = AgenticMemory.open(path.join(dir, 'legacy.rvf'), { metric: 'cosine' });
    assert.equal(raw.query(v(1), 1)[0].id, 1);
    raw.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('TEXT_FIELD is the documented metadata field', () => assert.equal(TEXT_FIELD, 0));
