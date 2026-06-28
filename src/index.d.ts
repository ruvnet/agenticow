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
  ingest(records: IngestRecord[]): IngestResult;
  ingest(vectors: Float32Array, ids: number[]): IngestResult;
  delete(ids: number[]): { deleted: number; tombstoned: number };
  query(vector: number[] | Float32Array, k?: number, opts?: QueryOptions): QueryHit[];
  branch(label?: string, filePath?: string): AgenticMemory;
  fork(label?: string, filePath?: string): AgenticMemory;
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
