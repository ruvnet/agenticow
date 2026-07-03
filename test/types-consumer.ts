// types-consumer.ts — compile-only consumer check for src/index.d.ts.
//
// Every call below is REAL usage taken from the README / examples / downstream
// consumers (metaharness GEPA branch-memory, ADR-230). `npm run check:types`
// compiles this file (no emit) against the published type surface, so any
// drift between the .d.ts and the runtime API fails CI-style instead of
// surprising a consumer. This file is never executed.

import awDefault, { open, openBase, AgenticMemory } from 'agenticow';
import type {
  IngestResult,
  IngestRecord,
  MemoryDiff,
  QueryHit,
  CheckpointDescriptor,
  LineageNode,
  MemoryStatus,
} from 'agenticow';

declare const vec: Float32Array;

// ── factories: open, the openBase alias, the static, and the default export ──
const base: AgenticMemory = open('kb.rvf', { dimension: 1536 });
const viaAlias: AgenticMemory = openBase('kb.rvf', { dimension: 1536, metric: 'cosine', track: true });
const viaStatic: AgenticMemory = AgenticMemory.open('kb.rvf', { dimension: 8, m: 16, efConstruction: 200 });
const viaDefault: AgenticMemory = awDefault.openBase('kb.rvf', { dimension: 8 });

// ── ingest: all three forms, with and without text payloads ──────────────────
const records: IngestRecord[] = [{ id: 1, vector: vec, text: 'payload' }, { id: 2, vector: [0.1, 0.2] }];
const r1: IngestResult = base.ingest(records);
const r2: IngestResult = base.ingest(vec, [1, 2, 3]); // flat batch (Float32Array, ids)
const r3: IngestResult = base.ingest(vec, { text: 'auto-id single vector' });
const r4: IngestResult = base.ingest(vec, { id: 42, text: 'explicit id' });
const r5: IngestResult = base.ingest([0.1, 0.2, 0.3]); // number[] single-vector, no payload

// ── query: positional k and options form; hits carry optional text ───────────
const hits: QueryHit[] = base.query(vec, 10, { efSearch: 200, overscan: 40 });
const hits2: QueryHit[] = base.query(vec, { topK: 5 });
const t: string | undefined = hits[0]?.text;
const b: string = hits[0]!.branch;

// ── branch / fork / native ANN ────────────────────────────────────────────────
const br: AgenticMemory = base.branch('cand-6');
const fk: AgenticMemory = base.fork('agent-007', undefined, { nativeAnn: true });
const isNative: boolean = fk.nativeAnn;

// ── diff / promote: no-arg (defaults to parent) AND explicit target ──────────
const d: MemoryDiff = br.diff();
const p1: { ingested: number; deleted: number } = br.promote(); // parent default
const p2: { ingested: number; deleted: number } = fk.promote(base); // explicit target

// ── checkpoint / rollback / introspection / persistence ─────────────────────
const ck: CheckpointDescriptor = base.checkpoint('pre-mutation');
const rb: { restoredTo: string; depth: number } = base.rollback(ck.id);
const chain: LineageNode[] = br.lineage();
const st: MemoryStatus = base.status();
const del: { deleted: number; tombstoned: number } = br.delete([3]);
const manifest: string = br.save('br.json');
const reopened: AgenticMemory = AgenticMemory.load(manifest);
const dim: number = reopened.dimension;
reopened.close();

// keep "unused variable" lint-style flags quiet without executing anything
export const _typechecked = [viaAlias, viaStatic, viaDefault, r1, r2, r3, r4, r5, hits2, t, b, d, p1, p2, rb, chain, st, del, dim, isNative] as const;
