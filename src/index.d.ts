// Type declarations for agenticow — Git for Agent Memory.

export interface OpenOptions {
  /** Vector dimension. Required when creating a new memory file. */
  dimension?: number;
  /** Distance metric. Default: "cosine". */
  metric?: string;
  /** HNSW M parameter (optional, create only). */
  m?: number;
  /** HNSW efConstruction (optional, create only). */
  efConstruction?: number;
  /** Keep an in-memory edit log enabling diff()/promote(). Default: true. */
  track?: boolean;
}

export interface MemoryDiff {
  added: number[];
  overridden: number[];
  deleted: number[];
}

export interface IngestResult {
  accepted: number;
  rejected: number;
  epoch: number;
}

export interface QueryOptions {
  /** HNSW efSearch passed to each store in the lineage chain. */
  efSearch?: number;
  /** Candidates to over-fetch per store before exact merge. Default: k*4. */
  overscan?: number;
  /**
   * Force the exact JS chain-walk even on a native-COW fork.
   * Default false (native path used when available).
   */
  forceExact?: boolean;
}

export interface ForkOptions {
  /**
   * Use the native Rust COW dual-graph ANN path (PR #618).
   * When true, fork() calls RvfDatabase.branch() instead of derive(), giving
   * the returned fork a working node whose query() spans the COW boundary in
   * a single Rust call. recall@10 = 1.0 at 1200-vector L2 test corpus.
   * Default: false (exact JS chain-walk).
   */
  nativeAnn?: boolean;
}

export interface QueryHit {
  id: number;
  distance: number;
  /** label/id of the lineage node the hit came from (which "wins"). */
  branch: string;
}

export interface CheckpointDescriptor {
  id: string;
  label: string;
  path: string;
  depth: number;
}

export interface LineageNode {
  role: 'working' | 'checkpoint' | 'base';
  id: string;
  label: string | null;
  path: string;
  /** fileId of the parent node (null for the base). */
  parent: string | null;
  /** epoch ms when this node was created. */
  createdAt: number;
  /** number of ids ingested at this node (requires track). */
  mutations: number;
  tombstones: number;
}

export interface MemoryStatus {
  totalVectors: number;
  totalSegments: number;
  fileSize: number;
  currentEpoch: number;
  profileId: number;
  compactionState: string;
  deadSpaceRatio: number;
  readOnly: boolean;
  chainDepth: number;
  dimension: number;
  metric: string;
}

export type IngestRecord = { id: number; vector: number[] | Float32Array };

export class AgenticMemory {
  static open(filePath: string, opts?: OpenOptions): AgenticMemory;
  readonly dimension: number;
  /**
   * True when this fork was created with `{nativeAnn:true}`.
   * query() routes through the Rust dual-graph ANN merge (PR #618).
   */
  readonly nativeAnn: boolean;
  ingest(records: IngestRecord[]): IngestResult;
  ingest(vectors: Float32Array, ids: number[]): IngestResult;
  delete(ids: number[]): { deleted: number; tombstoned: number };
  query(vector: number[] | Float32Array, k?: number, opts?: QueryOptions): QueryHit[];
  branch(label?: string, filePath?: string): AgenticMemory;
  fork(label?: string, filePath?: string, opts?: ForkOptions): AgenticMemory;
  diff(): MemoryDiff;
  promote(target: AgenticMemory): { ingested: number; deleted: number };
  checkpoint(label?: string): CheckpointDescriptor;
  rollback(checkpointId?: string): { restoredTo: string; depth: number };
  lineage(): LineageNode[];
  status(): MemoryStatus;
  save(manifestPath: string): string;
  static load(manifestPath: string): AgenticMemory;
  close(): void;
}

export function open(filePath: string, opts?: OpenOptions): AgenticMemory;

declare const _default: {
  open: typeof open;
  AgenticMemory: typeof AgenticMemory;
};
export default _default;
