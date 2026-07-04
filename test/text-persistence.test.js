// Regression: text payloads must survive the save/load manifest round-trip.
// Before the fix, save() serialized tombstones/editIds/editVecs but NOT the
// per-node `texts` Map, so query hits lost their `text` after reload.
// (Reported via ruflo #2549-adjacent agenticow integration.)
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgenticMemory } from '../src/index.js';

const v = (s) => Array.from({ length: 8 }, (_, i) => Math.sin(s + i));

test('text payloads survive save/load round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acow-text-'));
  try {
    const f = join(dir, 'b.rvf');
    const man = f + '.agenticow.json';
    const m = AgenticMemory.open(f, { dimension: 8 });
    m.ingest([{ id: 1, vector: v(1), text: 'alpha' }, { id: 2, vector: v(2), text: 'beta' }]);
    assert.strictEqual(m.query(v(1), 1)[0].text, 'alpha', 'text present before save');
    m.save(man);
    m.close();

    const m2 = AgenticMemory.load(man);
    assert.strictEqual(m2.query(v(1), 1)[0].text, 'alpha', 'text survives reload');
    assert.strictEqual(m2.query(v(2), 1)[0].text, 'beta');
    m2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('text on an ancestor survives round-trip after branching', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acow-text2-'));
  try {
    const base = join(dir, 'base.rvf');
    const m = AgenticMemory.open(base, { dimension: 8 });
    m.ingest([{ id: 1, vector: v(1), text: 'from-base' }]);
    const br = m.fork('exp', join(dir, 'branch.rvf'));
    br.ingest([{ id: 2, vector: v(2), text: 'from-branch' }]);
    const man = join(dir, 'branch.rvf.agenticow.json');
    br.save(man);
    br.close();
    m.close();

    const r = AgenticMemory.load(man);
    const h1 = r.query(v(1), 1)[0]; // hits the base ancestor
    const h2 = r.query(v(2), 1)[0]; // hits the working branch
    assert.strictEqual(h1.text, 'from-base', 'ancestor text survives');
    assert.strictEqual(h2.text, 'from-branch', 'branch text survives');
    r.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
