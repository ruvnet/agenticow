<div align="center">

# agenticow — Git for Agent Memory: Copy-On-Write vector branching (83× faster, 3000× smaller snapshots)

**Branch a base vector memory in ~0.5 ms / 162 bytes — independent of base size.** Exact read-through queries (parent ∪ edits, child wins). Built for embedded multi-agent memory.

[![npm](https://img.shields.io/npm/v/agenticow?color=3fe0c5)](https://www.npmjs.com/package/agenticow)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![tests](https://img.shields.io/badge/tests-8%2F8%20passing-3fe07a)](./test)
[![acceptance](https://img.shields.io/badge/acceptance-1000%20branches%20PASS-3fe07a)](#acceptance-the-1000-branch-proof)

**[Website / Demo →](https://ruvnet.github.io/agenticow/)** · **[npm](https://www.npmjs.com/package/agenticow)** · **[Benchmarks](#benchmarks)** · **[Acceptance proof](#acceptance-the-1000-branch-proof)**

![agenticow — Git for Agent Memory](./assets/hero.png)

</div>

> **agenticow turns memory from a static database into a branchable runtime primitive for agents.**

Every other vector store makes you **full-copy** the index to snapshot, fork, or checkpoint it. `agenticow` **branches** it — copy-on-write, like Git. Creating a branch costs ~0.5 ms and 162 bytes whether the base holds 10,000 or 1,000,000 vectors. Query a branch and you transparently see `parent ∪ your edits`, with the child winning on id collisions and deletes honored.

```bash
npm install agenticow
```

---

## Why

Agents need memory that branches: a per-user personalization layer, a sandbox to test a risky ingest, a checkpoint before a tool call, a thousand parallel experiments off one shared base. With a normal vector DB each of those is a **full copy** of the whole index. At 1M vectors that is **496 MB and 67 ms** — every time. agenticow makes it **162 bytes and 0.47 ms**, flat.

### Three things it makes cheap

| Use case | What it replaces | Cost with agenticow |
|---|---|---|
| 👥 **Parallel agents share one base memory** | N full copies of the index | N × 162 B, N × 0.5 ms |
| 🧪 **Roll back a poisoned / hallucinated branch** | re-ingest + re-index from backup | drop the branch, ~0.5 ms |
| 📌 **Zero-cost checkpointing before risky steps** | periodic full snapshots | 162 B + edits-since per checkpoint |

---

## Quick start

```js
import { open } from 'agenticow';

// open or create a base memory
const base = open('memory.rvf', { dimension: 1536 });
base.ingest([{ id: 1, vector: embedding }, /* ... */]);

// branch it for a parallel agent — ~0.5 ms / 162 B, any base size
const agent = base.branch('agent-a');
agent.ingest([{ id: 9001, vector: newMemory }]);     // isolated from the base

// exact read-through: sees base + its own edits, child wins on id collision
const hits = agent.query(queryVector, 10);
// -> [{ id, distance, branch }, ...]  (tombstone-masked, reranked)

// checkpoint + roll back a poisoned branch
const ckpt = agent.checkpoint('clean');
agent.ingest([{ id: 666, vector: poison }]);
agent.rollback(ckpt.id);                              // poison gone, clean memory intact
```

### CLI

```bash
agenticow init   mem.rvf --dim 128
agenticow ingest mem.rvf --n 5000
agenticow branch mem.rvf --as user-42        # cheap per-user personalization
agenticow query  mem.rvf.user-42.rvf --k 10  # top-K read-through (masked, reranked)
agenticow diff   mem.rvf.user-42.rvf         # added / overridden / tombstoned ids
agenticow demo                               # scripted end-to-end walkthrough
agenticow bench                              # branch-create benchmark
agenticow acceptance                         # the 1,000-branch proof
```

| Verb | Use case |
|---|---|
| `branch` | per-user / per-repo / per-account personalization off one shared base — *personalization without memory explosion* |
| `checkpoint` / `rollback` | per-task checkpointing; quarantine a bad/hallucinated ingest and instantly revert |
| `diff` / `promote` | Git-style memory workflow: agent branch → test → reviewed → production |
| `query` | top-K read-through with tombstone masking + exact rerank |
| `fork` (API) | fan out many branches off a static base (1,000 per-user branches in one process) |

A worked script lives in [`examples/parallel-agents.mjs`](./examples/parallel-agents.mjs): fork N branches from a base, ingest + tombstone per branch, query each, roll one back.

---

## How copy-on-write for vectors works

![COW concept](./assets/concept.png)

A branch records **only its own edits** plus a pointer to its parent. Creating one is constant-time and constant-size — **162 bytes** — independent of base size. A query walks the lineage chain (`child → … → base`), merges each store's results, lets the **child win** on any id collision, masks anything the branch **tombstoned**, and re-ranks by exact distance.

---

## Benchmarks

Reproduced on an **AMD Ryzen 9 9950X** (32 threads), Node v22, dim 128, cosine, median of 11 runs. Run it yourself: `npx agenticow bench`.

![Benchmarks: branch create vs full copy](./assets/benchmarks.png)

| Base N | Base file | Branch create (p50) | Empty branch | 100-edit branch | Full copy (p50) | Speedup | Smaller |
|-------:|----------:|--------------------:|-------------:|----------------:|----------------:|--------:|--------:|
| 10,000 | 5.0 MB | 519 µs | **162 B** | 51.4 KB | 373 µs | 1× | 32,102× |
| 100,000 | 49.6 MB | 463 µs | **162 B** | 51.4 KB | 5.83 ms | 13× | 321,037× |
| 1,000,000 | 496.3 MB | **472 µs** | **162 B** | 51.4 KB | 67.14 ms | **142×** | **3,212,443×** |

Branch delta is a pure function of edit count (~520 B / edited vector) with **zero dependence on base size**. At a 10k base a raw `copyFile` is already sub-millisecond, so the COW win shows up — and widens — at scale. The original [RVF COW proof](https://github.com/ruvnet/RuVector) reports the conservative **83× / 3000×** figures (0.78 ms vs 64.7 ms; 162 B vs 496 MB); the reproduction above is consistent and, on this machine, better on speed.

---

## Acceptance: the 1,000-branch proof

`npm run acceptance` (or `agenticow acceptance`) runs the full spec and reports real numbers. Latest run, **AMD Ryzen 9 9950X**, base = 20,000 vectors, dim 128:

| Measurement | Result |
|---|---|
| **Branches forked** | **1,000** off one base (median **0.487 ms/fork**, 4.5 s total) |
| **Top-10 correctness** | **recall@10 = 100%**, exact-order match 100% (120 sampled queries vs brute-force ground truth) |
| **Tombstone masking** | **PASS** — 0 tombstoned ids leaked into results |
| **Rollback latency** | **p50 = 0.571 ms** (min 0.48 / max 1.01), ~constant |
| **Storage vs delta** | 1,000 branches = **10.5 MB total** (10.8 KB/branch) vs **9.69 GB** for 1,000 full copies → **943× less disk**; total branch storage is **1.06× the base** (grows with delta, not base) |
| **Verdict** | **PASS ✓** |

The acceptance test builds a brute-force ground truth (`base ∪ branch-inserts − tombstones`, reranked by cosine distance) and asserts the read-through top-K matches it. If a 1,000-branch fork ever hits a real fd/memory/time limit, the test reports the max that worked plus the scaling curve — the 1,000 is not faked. Results are written to [`bench/acceptance-results.json`](./bench/acceptance-results.json).

---

## How it compares

![Comparison vs Pinecone / Milvus / pgvector / Chroma / Qdrant](./assets/comparison.png)

| Capability | agenticow | Pinecone | Milvus | pgvector | Chroma | Qdrant |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Native COW branch of the index | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| O(1)-in-base branch create | ✅ 162 B | ❌ | ❌ | ❌ | ❌ | ❌ |
| Snapshot mechanism | COW delta | full copy | full copy | SQL dump | full copy | full copy |
| Exact read-through (parent ∪ edits) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Embedded / in-process (no server) | ✅ | ❌ | ❌ | via PG | ✅ | ✅/server |
| Raw ANN throughput | ⚠️ ~2.7× behind hnswlib\* | high | high | moderate | moderate | high |
| ANN index spanning the branch | 🚧 roadmap | n/a | n/a | n/a | n/a | n/a |

\* **Honest concession.** On SIFT-1M, same machine, the underlying [ruvector](https://github.com/ruvnet/RuVector) HNSW does ~2,197 QPS @ recall 0.95 vs hnswlib-node ~9,344 QPS — roughly **2.7× slower** for raw ANN. If you need maximum raw similarity-search speed on a static index, use a dedicated ANN library. agenticow's edge is **cheap branching, checkpointing and rollback of agent memory** — which none of the above have.

---

## Honest scope

agenticow ships, and proves, exactly this:

- ✅ **COW branch creation** — base-size-independent, 162 B / ~0.5 ms (the 83× / 3000× headline). Proven by `npm run bench`.
- ✅ **Exact read-through queries** — point lookup / flat-scan merge returning `parent ∪ edits`, child wins on collisions, deletes honored. Proven by `npm run acceptance` (recall@10 = 100%, masking PASS).

What it does **not** yet ship:

- 🚧 **A single ANN/HNSW index that spans the COW boundary** is **roadmap, not shipped**. Read-through merges each store's own index and re-ranks exactly; it does not build one unified approximate index across parent and child. Native cluster-level read-through landed in [ruvnet/RuVector PR #617](https://github.com/ruvnet/RuVector/pull/617); until that build is published, agenticow implements read-through in its wrapper over the shipped `derive()` primitive.

We do not claim "fully queryable git-for-vectors". We claim **COW branch creation (83× / 3000×) + exact read-through queries** — and we prove both.

> **Note on cosine:** the shipped `@ruvector/rvf-node@0.1.8` binding does not persist the cosine metric across a file reopen (it reads back as `l2`). agenticow L2-normalizes vectors on ingest/query when the metric is cosine, so top-K ranking is identical whether the engine scores with cosine or L2. This is why read-through stays correct after `save()`/`load()`.

---

## Claim ladder

Where agenticow is today, and where it's going — labeled honestly.

| Tier | Claim | Status |
|---|---|---|
| **Practical** | Cheap, base-independent branch / checkpoint / rollback of vector memory (162 B / ~0.5 ms); exact read-through with tombstone masking. | ✅ **Proven** (bench + acceptance) |
| **Strong** | A Git-style workflow for vector state — `branch → diff → promote`, isolated experiments, instant revert of bad memory. | ✅ Shipped (CLI + API), proven at small scale |
| **Strategic** | A memory OS layer for multi-agent infrastructure — thousands of agents branching one shared base, per-user/per-task memory without the copy explosion. | 🔭 Vision (the primitives are here; scale-out is the work) |
| **Exotic** | A substrate for *evolving / competing cognitive branches* — parallel "selves", simulated orgs, time-travel debugging of agent memory. | 🌌 Roadmap / research — compelling, **not shipped** |

---

## API

```ts
import { open, AgenticMemory } from 'agenticow';

const mem = open(path, { dimension, metric?, track? });  // metric default "cosine"

mem.ingest([{ id, vector }])           // or ingest(Float32Array, ids) for speed
mem.query(vector, k?, { efSearch?, overscan? })  // exact read-through, child wins
mem.delete(ids)                        // COW tombstone (hides ancestor ids)

mem.branch(label?)                     // isolated COW fork (auto-isolates the parent)
mem.fork(label?)                       // lightweight fork off a static/read-only base
mem.checkpoint(label?)                 // freeze a restore point, keep working
mem.rollback(checkpointId?)            // discard edits since a checkpoint

mem.diff()                             // { added, overridden, deleted }
mem.promote(target)                    // replay this branch's edits into target

mem.lineage(); mem.status();           // introspection
mem.save(manifestPath); AgenticMemory.load(manifestPath)  // persist / reopen the chain
mem.close();
```

- **`branch()`** auto-isolates: it freezes the current state and re-points the parent to a fresh child, so neither side sees the other's later writes — safe when you keep writing to both.
- **`fork()`** is one `derive()` with no re-pointing — ideal for fanning out many branches off a base you won't mutate again (the 1,000-branch case).

---

## Install & requirements

```bash
npm install agenticow
```

- Node ≥ 18, ESM.
- Depends on [`@ruvector/rvf-node`](https://www.npmjs.com/package/@ruvector/rvf-node) (prebuilt native binding for linux-x64/arm64, darwin-x64/arm64, win32-x64).

---

## Keywords

agent memory · vector database branching · copy-on-write · COW vector store · multi-agent memory · embedded vector DB · memory checkpointing · vector branching · git for vectors · AI agent memory · LLM memory · vector snapshot · rollback · checkpoint

---

## License

MIT © [ruvnet](https://github.com/ruvnet). Built on [ruvector](https://github.com/ruvnet/RuVector) RVF.
