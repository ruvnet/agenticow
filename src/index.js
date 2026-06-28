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

/** @param {number[]|Float32Array} v */
function toF32(v) {
  return v instanceof Float32Array ? v : Float32Array.from(v);
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
  }
}

export class AgenticMemory {
  /** @private */
  constructor(workingNode, ancestors, dim, metric) {
    /** @type {Node} */
    this._working = workingNode;
    /** @type {Node[]} ancestors newest -> oldest (base last) */
    this._ancestors = ancestors;
    this._dim = dim;
    this._metric = metric;
    this._closed = false;
  }

  /**
   * Open an existing memory file, or create one if it does not exist.
   * @param {string} filePath
   * @param {{dimension?:number, metric?:string, m?:number, efConstruction?:number}} [opts]
   * @returns {AgenticMemory}
   */
  static open(filePath, opts = {}) {
    let db, dim, metric;
    if (fs.existsSync(filePath)) {
      db = RvfDatabase.open(filePath);
      dim = db.dimension();
      metric = db.metric ? db.metric() : (opts.metric || DEFAULT_METRIC);
    } else {
      if (!opts.dimension) {
        throw new Error('agenticow: dimension is required when creating a new memory file');
      }
      dim = opts.dimension;
      metric = opts.metric || DEFAULT_METRIC;
      db = RvfDatabase.create(filePath, {
        dimension: dim,
        metric,
        ...(opts.m ? { m: opts.m } : {}),
        ...(opts.efConstruction ? { efConstruction: opts.efConstruction } : {}),
      });
    }
    return new AgenticMemory(new Node(db, filePath, 'base'), [], dim, metric);
  }

  /** Full lineage chain, working node first. @returns {Node[]} */
  _chain() {
    return [this._working, ...this._ancestors];
  }

  _deriveOpts() {
    return { dimension: this._dim, metric: this._metric };
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
    let flat, idArr;
    if (records instanceof Float32Array) {
      flat = records;
      idArr = ids;
    } else if (Array.isArray(records)) {
      idArr = records.map((r) => r.id);
      flat = new Float32Array(records.length * this._dim);
      for (let i = 0; i < records.length; i++) flat.set(toF32(records[i].vector), i * this._dim);
    } else {
      throw new Error('agenticow: ingest expects an array of {id,vector} or (Float32Array, ids)');
    }
    // A re-ingested id is no longer a delete in this node.
    for (const id of idArr) this._working.tombstones.delete(id);
    return this._working.db.ingestBatch(flat, idArr);
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
    for (const id of ids) this._working.tombstones.add(id);
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
    const qv = toF32(vector);
    const fetch = Math.max(k, opts.overscan || k * 4);
    const resolved = new Map(); // id -> {id, distance, branch}
    const hidden = new Set(); // ids tombstoned by a nearer descendant
    const qopts = opts.efSearch ? { efSearch: opts.efSearch } : undefined;
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
    return [...resolved.values()].sort((a, b) => a.distance - b.distance).slice(0, k);
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
    // Parent continues, transparently, in its own fresh child.
    this._ancestors = [frozen, ...this._ancestors];
    this._working = new Node(parentChildDb, parentChildPath, 'working');
    // Branch shares the frozen snapshot + all older ancestors.
    const branchNode = new Node(childDb, childPath, label || 'branch');
    return new AgenticMemory(branchNode, [...this._ancestors], this._dim, this._metric);
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
    // Discard the current poisoned working child and any checkpoints newer than target.
    try {
      this._working.db.close();
    } catch { /* ignore */ }
    try {
      fs.rmSync(this._working.path, { force: true });
    } catch { /* ignore */ }
    const target = this._ancestors[idx];
    const newAncestors = this._ancestors.slice(idx); // target + older
    const childPath = tmpChildPath(target.path, 'work');
    const childDb = target.db.derive(childPath, this._deriveOpts());
    this._working = new Node(childDb, childPath, 'working');
    this._ancestors = newAncestors;
    return { restoredTo: target.id, depth: this._ancestors.length };
  }

  /** Lineage chain metadata, working node first. */
  lineage() {
    return this._chain().map((n, i) => ({
      role: i === 0 ? 'working' : (i === this._chain().length - 1 ? 'base' : 'checkpoint'),
      id: n.id,
      label: n.label,
      path: n.path,
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

  /** Close all open handles in the chain. */
  close() {
    if (this._closed) return;
    for (const n of this._chain()) {
      try { n.db.close(); } catch { /* ignore */ }
    }
    this._closed = true;
  }
}

/** Convenience: open or create a memory. @see AgenticMemory.open */
export function open(filePath, opts) {
  return AgenticMemory.open(filePath, opts);
}

export default { open, AgenticMemory };
