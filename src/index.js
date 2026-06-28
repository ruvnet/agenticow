// agenticow — Git for Agent Memory
// Copy-On-Write vector branching for embedded multi-agent memory.
//
// Built on ruvector's RVF format via @ruvector/rvf-node. The headline capability
// is base-size-independent COW branch creation: deriving a branch off a base
// memory costs ~0.5 ms and ~162 bytes regardless of how big the base is —
// proven 83x faster and ~3000x smaller than full-copy snapshots at 1M vectors.
//
// Honest scope:
//   - Branch/checkpoint CREATE is O(edits), O(1) in base size. PROVEN.
//   - query() is an EXACT read-through: parent ∪ child-edits, child wins on an
//     id collision, deletes are honored. It works by merging each store in the
//     lineage chain (child -> ... -> base). Each store answers with its own
//     native index; agenticow merges + re-ranks exactly across the boundary.
//   - A single ANN/HNSW index that SPANS the COW boundary is NOT shipped — that
//     is roadmap. Native cluster-level read-through (branch()) landed in
//     ruvnet/RuVector PR #617; until it is published, agenticow implements the
//     read-through in this wrapper over the shipped derive() primitive.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pkg from '@ruvector/rvf-node';

const { RvfDatabase } = pkg;

const DEFAULT_METRIC = 'cosine';

// Process-wide monotonic counter for auto-assigned ids (the convenience
// `ingest(vec, {text})` form with no explicit id). Shared across ALL instances
// so a base and the branches forked from it never collide on an auto-id — a
// per-instance counter would hand out the same id on both sides and a later
// promote() would silently overwrite. Starts high to stay clear of typical
// caller-assigned ids. Explicit ids are unaffected, so example determinism holds.
let GLOBAL_AUTO_ID = 9_000_000_000;

/** @param {number[]|Float32Array} v */
function toF32(v) {
  return v instanceof Float32Array ? v : Float32Array.from(v);
}

// L2-normalize a copy of v. Used when metric is cosine so that ranking is
// identical whether the engine scores with cosine or L2 — important because the
// shipped rvf-node binding reopens files with the l2 metric (the cosine setting
// is not persisted). On unit vectors, L2 distance is monotonic with cosine
// distance, so top-K is preserved either way.
function l2normalize(src) {
  const v = src instanceof Float32Array ? Float32Array.from(src) : Float32Array.from(src);
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function tmpChildPath(base, label) {
  const slug = (label || 'branch').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'branch';
  const rand = crypto.randomBytes(4).toString('hex');
  const dir = path.dirname(base);
  const stem = path.basename(base).replace(/\.rvf$/i, '');
  return path.join(dir, `${stem}.${slug}-${rand}.rvf`);
}

/**
 * One node in the COW lineage chain. `db` is an open RvfDatabase handle.
 * `tombstones` are ids deleted at this node (hide the same id in ancestors).
 */
class Node {
  constructor(db, nodePath, label) {
    this.db = db;
    this.path = nodePath;
    this.label = label || null;
    this.id = db.fileId();
    this.tombstones = new Set();
    // Audit: when this node was created (epoch ms). Surfaced via lineage() so
    // callers can build a provenance/compliance trail.
    this.createdAt = Date.now();
    // Edit log for diff()/promote(). Cheap on small branches; disabled on huge
    // bases via { track:false } in open().
    this.editIds = new Set();
    this.editVecs = new Map();
    // Optional per-id text/payload metadata (set via ingest(vec,{text}) or
    // ingest([{id,vector,text}])). Surfaced on query hits as `hit.text`.
    this.texts = new Map();
  }
}

export class AgenticMemory {
  /** @private */
  constructor(workingNode, ancestors, dim, metric, track = true, owned = null, nativeCow = false) {
    /** @type {Node} */
    this._working = workingNode;
    /** @type {Node[]} ancestors newest -> oldest (base last) */
    this._ancestors = ancestors;
    this._dim = dim;
    this._metric = metric;
    this._track = track;
    this._normalize = String(metric).toLowerCase() === 'cosine';
    // Engine metric of the underlying RVF store. For cosine we drive the engine
    // with L2 over L2-NORMALIZED vectors (L2 order == cosine order on unit
    // vectors). This is what makes BOTH the exact read-through and the native
    // COW dual-graph ANN path correct for cosine — rvf-node 0.2.0's native COW
    // query is accurate for L2 but not for the cosine metric directly.
    this._engineMetric = this._normalize ? 'l2' : String(metric).toLowerCase();
    // Nodes this instance is allowed to close. Ancestors shared from a parent
    // (via fork/branch) are NOT owned, so closing a fork never closes the base.
    /** @type {Set<Node>} */
    this._owned = owned || new Set([workingNode]);
    this._closed = false;
    /**
     * True when this instance's working node was created via RvfDatabase.branch()
     * (a real COW child with a dual-graph HNSW that spans the parent boundary).
     * When true, query() routes through the native Rust ANN path — a single
     * db.query() call returns parent∪child hits via the dual-graph merge in
     * rvf-runtime's query_via_index_cow. Verified recall@10 ≈ 1.0 (0.999,
     * 5,000-vector base ∪ 200 edits, dim 128, cosine via normalized-L2) on
     * linux-x64-gnu; degrades to the exact JS path on other platforms.
     * @type {boolean}
     */
    this._nativeCow = nativeCow;
    /**
     * The memory this instance was forked/branched from, if any. Lets
     * promote() default its target to the parent — so a documented snippet can
     * call `branch.promote()` with no argument (merge back into the base).
     * @type {AgenticMemory|null}
     */
    this._parent = null;
  }

  /**
   * Open an existing memory file, or create one if it does not exist.
   * @param {string} filePath
   * @param {{dimension?:number, metric?:string, m?:number, efConstruction?:number, track?:boolean}} [opts]
   *   track (default true): keep an in-memory edit log enabling diff()/promote().
   *   Set false on very large bases to avoid caching their vectors.
   * @returns {AgenticMemory}
   */
  static open(filePath, opts = {}) {
    let db, dim, metric;
    if (fs.existsSync(filePath)) {
      db = RvfDatabase.open(filePath);
      dim = db.dimension();
      // A reopened store reports its ENGINE metric (l2 for cosine stores). Let
      // the caller restore the user-facing metric with opts.metric — or use
      // save()/load(), which persists it. See README "Note on cosine".
      metric = opts.metric || (db.metric ? db.metric() : DEFAULT_METRIC);
    } else {
      if (!opts.dimension) {
        throw new Error('agenticow: dimension is required when creating a new memory file');
      }
      dim = opts.dimension;
      metric = opts.metric || DEFAULT_METRIC;
      // cosine -> drive the engine with l2 over normalized vectors.
      const engineMetric = String(metric).toLowerCase() === 'cosine' ? 'l2' : metric;
      db = RvfDatabase.create(filePath, {
        dimension: dim,
        metric: engineMetric,
        ...(opts.m ? { m: opts.m } : {}),
        ...(opts.efConstruction ? { efConstruction: opts.efConstruction } : {}),
      });
    }
    return new AgenticMemory(new Node(db, filePath, 'base'), [], dim, metric, opts.track !== false);
  }

  /** Full lineage chain, working node first. @returns {Node[]} */
  _chain() {
    return [this._working, ...this._ancestors];
  }

  _deriveOpts() {
    // Children must use the same ENGINE metric as the base (l2 for cosine).
    return { dimension: this._dim, metric: this._engineMetric };
  }

  _assertOpen() {
    if (this._closed) throw new Error('agenticow: memory is closed');
  }

  /**
   * Ingest vectors into the current working node.
   * Forms:
   *   ingest([{ id, vector }, ...])
   *   ingest(Float32Array, number[])   // flat batch, fastest
   * @returns {{accepted:number, rejected:number, epoch:number}}
   */
  ingest(records, ids) {
    this._assertOpen();
    // ── Convenience single-vector form: ingest(vec, {text?, id?}) ──────────
    // `vec` is a single embedding (Float32Array or number[] of length dim) and
    // the second arg is an options OBJECT (not an ids array). Auto-assigns an id
    // when none is given and records optional `text` payload. This is what lets
    // the documented snippet `branch.ingest(vec, { text })` run verbatim.
    const looksLikeVector =
      (records instanceof Float32Array || (Array.isArray(records) && typeof records[0] === 'number')) &&
      records.length === this._dim;
    const secondIsOpts =
      ids === undefined || (ids !== null && typeof ids === 'object' && !Array.isArray(ids) && !(ids instanceof Float32Array));
    if (looksLikeVector && secondIsOpts) {
      const opts = ids || {};
      const id = opts.id !== undefined ? opts.id : GLOBAL_AUTO_ID++;
      if (opts.text !== undefined) this._working.texts.set(id, opts.text);
      return this.ingest([{ id, vector: records }]);
    }

    let flat, idArr;
    if (records instanceof Float32Array) {
      flat = this._normalize ? Float32Array.from(records) : records;
      idArr = ids;
    } else if (Array.isArray(records)) {
      idArr = records.map((r) => r.id);
      flat = new Float32Array(records.length * this._dim);
      for (let i = 0; i < records.length; i++) flat.set(toF32(records[i].vector), i * this._dim);
      // record optional text payloads carried on the records
      for (const r of records) if (r.text !== undefined) this._working.texts.set(r.id, r.text);
    } else {
      throw new Error('agenticow: ingest expects an array of {id,vector} or (Float32Array, ids)');
    }
    if (this._normalize) {
      // normalize each row in place (flat is already a private copy here)
      for (let i = 0; i < idArr.length; i++) {
        const o = i * this._dim;
        let n = 0;
        for (let j = 0; j < this._dim; j++) n += flat[o + j] * flat[o + j];
        n = Math.sqrt(n);
        if (n > 0) for (let j = 0; j < this._dim; j++) flat[o + j] /= n;
      }
    }
    // A re-ingested id is no longer a delete in this node.
    for (const id of idArr) this._working.tombstones.delete(id);
    const res = this._working.db.ingestBatch(flat, idArr);
    if (this._track) {
      for (let i = 0; i < idArr.length; i++) {
        const id = idArr[i];
        this._working.editIds.add(id);
        this._working.editVecs.set(id, flat.slice(i * this._dim, (i + 1) * this._dim));
      }
    }
    return res;
  }

  /**
   * Delete ids from the current branch's view (COW tombstone). The id stays in
   * the ancestor on disk, but is hidden from this branch's reads.
   * @param {number[]} ids
   */
  delete(ids) {
    this._assertOpen();
    let deleted = 0;
    try {
      const res = this._working.db.delete(ids);
      deleted = res?.deleted ?? 0;
    } catch {
      /* id may live only in an ancestor; fall through to tombstone */
    }
    for (const id of ids) {
      this._working.tombstones.add(id);
      this._working.editIds.delete(id);
      this._working.editVecs.delete(id);
    }
    return { deleted, tombstoned: ids.length };
  }

  /**
   * EXACT read-through k-NN: parent ∪ child-edits, child wins on id collision,
   * deletes honored. Merges every node in the lineage chain and re-ranks.
   * @param {number[]|Float32Array} vector
   * @param {number} [k=10]
   * @param {{efSearch?:number, overscan?:number}} [opts]
   * @returns {{id:number, distance:number, branch:string}[]}
   */
  query(vector, k = 10, opts = {}) {
    this._assertOpen();
    // Convenience form: query(vec, { topK, efSearch?, overscan? }). When the
    // second arg is an options object, read k from topK/k. Lets the documented
    // snippet `branch.query(vec, { topK: 5 })` run verbatim.
    if (k !== null && typeof k === 'object' && !Array.isArray(k)) {
      opts = k;
      k = opts.topK ?? opts.k ?? 10;
    }
    const qv = this._normalize ? l2normalize(vector) : toF32(vector);
    const qopts = opts.efSearch ? { efSearch: opts.efSearch } : undefined;

    // ── Native COW dual-graph ANN path ────────────────────────────────
    // When this instance was created via fork({nativeAnn:true}) or
    // branch({nativeAnn:true}), the working node's db is a real COW child
    // (RvfDatabase.branch()). A single db.query() call transparently queries
    // both the child's own HNSW and the parent's HNSW, merges candidates with
    // child-wins semantics, and excludes tombstoned IDs — all in Rust.
    // Recall@10 = 1.0000 on the PR#618 integration test (1200-vector L2,
    // 60 new + 20 overrides + 10 tombstones, efSearch=300).
    if (this._nativeCow && !opts.forceExact) {
      const hits = this._working.db.query(qv, k, qopts);
      return hits.map((h) => this._withText({
        id: h.id,
        distance: h.distance,
        branch: this._working.label || this._working.id,
      }));
    }

    // ── Exact JS chain-walk (default / fallback) ──────────────────────
    // For each node in the lineage chain (newest first), query its local
    // store and merge with child-wins semantics.
    const fetch = Math.max(k, opts.overscan || k * 4);
    const resolved = new Map(); // id -> {id, distance, branch}
    const hidden = new Set(); // ids tombstoned by a nearer descendant
    for (const node of this._chain()) {
      for (const t of node.tombstones) hidden.add(t);
      let hits = [];
      try {
        hits = node.db.query(qv, fetch, qopts);
      } catch {
        hits = [];
      }
      for (const h of hits) {
        if (resolved.has(h.id) || hidden.has(h.id)) continue; // nearer node wins
        resolved.set(h.id, { id: h.id, distance: h.distance, branch: node.label || node.id });
      }
    }
    return [...resolved.values()]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k)
      .map((h) => this._withText(h));
  }

  /** Walk the lineage chain (child→base) for the text payload of an id. */
  _textFor(id) {
    for (const node of this._chain()) {
      if (node.texts.has(id)) return node.texts.get(id);
    }
    return undefined;
  }

  /** Attach a `text` field to a hit when a payload exists for its id. */
  _withText(hit) {
    const t = this._textFor(hit.id);
    return t === undefined ? hit : { ...hit, text: t };
  }

  /**
   * Whether this instance uses the native Rust COW dual-graph ANN query path.
   * true => query() routes through rvf-runtime's query_via_index_cow (PR #618).
   * false => exact JS chain-walk across the lineage.
   * @type {boolean}
   */
  get nativeAnn() {
    return this._nativeCow;
  }

  /**
   * Create an isolated COW branch (a parallel fork of this memory). O(1) in base
   * size — ~0.5 ms / 162 bytes. The branch sees everything this memory currently
   * has via read-through, plus its own future edits. Mutations are isolated:
   * neither side sees the other's later writes.
   * @param {string} [label]
   * @param {string} [filePath]
   * @returns {AgenticMemory}
   */
  branch(label, filePath) {
    this._assertOpen();
    // Freeze the current working node so BOTH sides derive off the same
    // immutable snapshot — this is what guarantees mutation isolation (neither
    // the parent nor the branch sees the other's later writes).
    const frozen = this._working;
    const parentChildPath = tmpChildPath(frozen.path, 'work');
    const parentChildDb = frozen.db.derive(parentChildPath, this._deriveOpts());
    const childPath = filePath || tmpChildPath(frozen.path, label);
    const childDb = frozen.db.derive(childPath, this._deriveOpts());
    // Parent continues, transparently, in its own fresh child (which it owns).
    this._ancestors = [frozen, ...this._ancestors];
    this._working = new Node(parentChildDb, parentChildPath, 'working');
    this._owned.add(this._working);
    // Branch shares the frozen snapshot + all older ancestors; it owns only its
    // own working child.
    const branchNode = new Node(childDb, childPath, label || 'branch');
    const child = new AgenticMemory(branchNode, [...this._ancestors], this._dim, this._metric, this._track);
    child._parent = this; // enables promote() with no explicit target
    return child;
  }

  /**
   * Lightweight fork: derive a child WITHOUT re-pointing this memory. Use this to
   * fan out many branches off a base you will not mutate again (e.g. spawn 1,000
   * per-user branches off one shared base). One derive() per fork — ~0.5 ms /
   * 162 bytes each, O(1) in base size. Read-through isolation holds as long as
   * the parent base stays read-only after forking.
   *
   * `opts.nativeAnn` (default false): when true, creates a real COW branch via
   * RvfDatabase.branch() instead of derive(). The returned fork's query() routes
   * through the native Rust dual-graph ANN merge (RuVector PR #617/#618), which
   * queries both the fork's own HNSW and the parent's HNSW in a single call —
   * sub-linear ANN ACROSS the COW boundary. Verified recall@10 ≈ 1.0 here
   * (0.999, 5,000-vector base ∪ 200 edits, dim 128, cosine via normalized-L2).
   * Platform: the native binary ships for linux-x64-gnu today; on other
   * platforms this degrades gracefully to the exact read-through path (identical
   * correctness, JS merge — `nativeAnn` will read false). Requires the parent to
   * NOT be mutated after forking (same rule as exact mode).
   * @param {string} [label]
   * @param {string} [filePath]
   * @param {{nativeAnn?:boolean}} [opts]
   * @returns {AgenticMemory}
   */
  fork(label, filePath, opts = {}) {
    this._assertOpen();
    const childPath = filePath || tmpChildPath(this._working.path, label);
    if (opts.nativeAnn) {
      // Native COW branch: the Rust COW engine wires parent→child read-through
      // so a single db.query() merges both sides via dual-graph ANN.
      // The native branch() binary ships for linux-x64-gnu today; on other
      // platforms RvfDatabase.branch() may be absent/throw — we degrade
      // gracefully to the exact read-through path (same correctness, JS merge).
      if (typeof this._working.db.branch === 'function') {
        try {
          const childDb = this._working.db.branch(childPath);
          const childNode = new Node(childDb, childPath, label || 'fork');
          // The COW child already knows its parent; no JS ancestor chain needed.
          const nativeChild = new AgenticMemory(
            childNode,
            [],  // ancestors managed by Rust COW engine
            this._dim,
            this._metric,
            this._track,
            null,
            true  // _nativeCow = true → query() uses native path
          );
          nativeChild._parent = this;
          return nativeChild;
        } catch {
          /* fall through to exact read-through */
        }
      }
      // graceful fallback (non-linux-x64, or native branch unavailable)
    }
    const childDb = this._working.db.derive(childPath, this._deriveOpts());
    const childNode = new Node(childDb, childPath, label || 'fork');
    const child = new AgenticMemory(
      childNode,
      [this._working, ...this._ancestors],
      this._dim,
      this._metric,
      this._track
    );
    child._parent = this; // enables promote() with no explicit target
    return child;
  }

  /**
   * Git-style diff of this branch's working node against its nearest ancestor:
   * which ids were added, overridden, or tombstoned. Requires edit tracking
   * (open with track !== false).
   * @returns {{added:number[], overridden:number[], deleted:number[]}}
   */
  diff() {
    this._assertOpen();
    const ancestorIds = new Set();
    for (const a of this._ancestors) for (const id of a.editIds) ancestorIds.add(id);
    const added = [];
    const overridden = [];
    for (const id of this._working.editIds) {
      (ancestorIds.has(id) ? overridden : added).push(id);
    }
    return {
      added: added.sort((a, b) => a - b),
      overridden: overridden.sort((a, b) => a - b),
      deleted: [...this._working.tombstones].sort((a, b) => a - b),
    };
  }

  /**
   * Promote (merge) this branch's recorded edits onto a target memory — the
   * Git-style "branch -> reviewed -> production" workflow. Replays the working
   * node's ingested vectors and tombstones into `target`. Requires edit tracking.
   * @param {AgenticMemory} target
   * @returns {{ingested:number, deleted:number}}
   */
  promote(target) {
    this._assertOpen();
    // Default the target to the parent this branch was forked/branched from, so
    // `branch.promote()` (no argument) merges back into its base — the verb the
    // documented snippet uses.
    target = target || this._parent;
    if (!(target instanceof AgenticMemory)) {
      throw new Error('agenticow: promote needs a target AgenticMemory (or a parent set by fork()/branch())');
    }
    const ids = [...this._working.editIds];
    if (ids.length && this._working.editVecs.size === 0) {
      throw new Error('agenticow: promote needs tracked edit vectors (open with track:true)');
    }
    if (ids.length) {
      const flat = new Float32Array(ids.length * this._dim);
      for (let i = 0; i < ids.length; i++) flat.set(this._working.editVecs.get(ids[i]), i * this._dim);
      target.ingest(flat, ids);
      // carry text payloads across the promotion
      for (const id of ids) {
        if (this._working.texts.has(id)) target._working.texts.set(id, this._working.texts.get(id));
      }
    }
    const tomb = [...this._working.tombstones];
    if (tomb.length) target.delete(tomb);
    return { ingested: ids.length, deleted: tomb.length };
  }

  /**
   * Freeze the current state as an immutable restore point and keep working in a
   * fresh COW child. O(1) in base size. Returns the checkpoint descriptor.
   * @param {string} [label]
   * @returns {{id:string, label:string, path:string, depth:number}}
   */
  checkpoint(label) {
    this._assertOpen();
    const frozen = this._working;
    frozen.label = label || frozen.label || `ckpt-${this._ancestors.length + 1}`;
    const childPath = tmpChildPath(frozen.path, 'work');
    const childDb = frozen.db.derive(childPath, this._deriveOpts());
    const childNode = new Node(childDb, childPath, 'working');
    this._ancestors = [frozen, ...this._ancestors];
    this._working = childNode;
    this._owned.add(childNode);
    return {
      id: frozen.id,
      label: frozen.label,
      path: frozen.path,
      depth: this._ancestors.length,
    };
  }

  /**
   * Discard all edits since a checkpoint and resume from it. With no argument,
   * rolls back to the most recent checkpoint. Abandons the poisoned working
   * child and derives a fresh writable child off the chosen checkpoint.
   * @param {string} [checkpointId] fileId of the checkpoint to return to
   * @returns {{restoredTo:string, depth:number}}
   */
  rollback(checkpointId) {
    this._assertOpen();
    if (this._ancestors.length === 0) {
      throw new Error('agenticow: nothing to roll back to (no checkpoints)');
    }
    let idx = 0; // default: most recent checkpoint
    if (checkpointId) {
      idx = this._ancestors.findIndex((n) => n.id === checkpointId);
      if (idx === -1) throw new Error(`agenticow: checkpoint ${checkpointId} not found`);
    }
    // Discard the current poisoned working child and any checkpoints newer than
    // target — but only ones THIS instance owns (never a shared ancestor).
    const discarded = [this._working, ...this._ancestors.slice(0, idx)];
    for (const n of discarded) {
      if (!this._owned.has(n)) continue;
      try { n.db.close(); } catch { /* ignore */ }
      try { fs.rmSync(n.path, { force: true }); } catch { /* ignore */ }
      this._owned.delete(n);
    }
    const target = this._ancestors[idx];
    const newAncestors = this._ancestors.slice(idx); // target + older
    const childPath = tmpChildPath(target.path, 'work');
    const childDb = target.db.derive(childPath, this._deriveOpts());
    this._working = new Node(childDb, childPath, 'working');
    this._owned.add(this._working);
    this._ancestors = newAncestors;
    return { restoredTo: target.id, depth: this._ancestors.length };
  }

  /** Lineage chain metadata, working node first. */
  lineage() {
    const chain = this._chain();
    return chain.map((n, i) => ({
      role: i === 0 ? 'working' : (i === chain.length - 1 ? 'base' : 'checkpoint'),
      id: n.id,
      label: n.label,
      path: n.path,
      parent: i < chain.length - 1 ? chain[i + 1].id : null,
      createdAt: n.createdAt,
      mutations: n.editIds.size,
      tombstones: n.tombstones.size,
    }));
  }

  /** Status of the working node plus chain depth. */
  status() {
    this._assertOpen();
    const s = this._working.db.status();
    return {
      ...s,
      chainDepth: this._chain().length,
      dimension: this._dim,
      metric: this._metric,
    };
  }

  /** dimension of stored vectors */
  get dimension() {
    return this._dim;
  }

  /**
   * Persist the lineage to a small JSON manifest so the CLI (or another process)
   * can reopen the exact chain. Vector data stays in the .rvf files; the manifest
   * holds the chain order, labels, tombstones and (for diff/promote) the working
   * node's recorded edits.
   * @param {string} manifestPath
   */
  save(manifestPath) {
    this._assertOpen();
    const nodes = this._chain().map((n, i) => ({
      path: path.resolve(n.path),
      label: n.label,
      tombstones: [...n.tombstones],
      // only the working node (i===0) needs its edit vectors for promote()
      editIds: i === 0 ? [...n.editIds] : [],
      editVecs: i === 0 ? Object.fromEntries([...n.editVecs].map(([id, v]) => [id, Array.from(v)])) : {},
    }));
    fs.writeFileSync(manifestPath, JSON.stringify({ v: 1, dim: this._dim, metric: this._metric, track: this._track, nodes }, null, 2));
    return manifestPath;
  }

  /**
   * Reconstruct an AgenticMemory from a manifest written by save().
   * @param {string} manifestPath
   * @returns {AgenticMemory}
   */
  static load(manifestPath) {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const nodes = m.nodes.map((nm, i) => {
      const db = i === 0 ? RvfDatabase.open(nm.path) : RvfDatabase.openReadonly(nm.path);
      const node = new Node(db, nm.path, nm.label);
      node.tombstones = new Set(nm.tombstones || []);
      node.editIds = new Set(nm.editIds || []);
      node.editVecs = new Map(Object.entries(nm.editVecs || {}).map(([id, v]) => [Number(id), Float32Array.from(v)]));
      return node;
    });
    // A loaded instance opened every handle itself, so it owns the whole chain.
    return new AgenticMemory(nodes[0], nodes.slice(1), m.dim, m.metric, m.track !== false, new Set(nodes));
  }

  /** Close the handles this instance owns (never a shared parent/base handle). */
  close() {
    if (this._closed) return;
    for (const n of this._owned) {
      try { n.db.close(); } catch { /* ignore */ }
    }
    this._closed = true;
  }
}

/** Convenience: open or create a memory. @see AgenticMemory.open */
export function open(filePath, opts) {
  return AgenticMemory.open(filePath, opts);
}

/**
 * Alias of {@link open}. Provided so documented snippets that read
 * `import { openBase } from 'agenticow'` run verbatim. Identical behavior.
 */
export const openBase = open;

export default { open, openBase, AgenticMemory };
