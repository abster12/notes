---
title: "Vector Database Internals (HNSW, IVF, Sharding)"
type: system-design
category: AI/ML
date: 2026-06-19
tags: [system-design, interview, ai-ml, vector-database, hnsw, ivf, sharding, ann, approximate-nearest-neighbor, similarity-search, embeddings, faiss, milvus, qdrant, pinecone, weaviate, staff-engineering]
aliases: ["Vector Database Internals", "HNSW", "IVF", "Vector DB Sharding", "Approximate Nearest Neighbor", "ANN Indexes"]
difficulty: advanced
read_time: 23
listen_time: 32
---

# Vector Database Internals (HNSW, IVF, Sharding)

> **Staff-Engineer Focus:** "We store embeddings in Pinecone and do similarity search" is the mid-level answer. Understanding that every ANN index is a precision-recall-speed trade-off on a Pareto frontier — and that no single index type dominates across all workloads — that's the senior answer. **The staff engineer doesn't ask "which vector DB should we use?" They ask: "What is the recall curve of our index at various ef_search values? At what dataset size does our current IVF clustering degrade because the centroids no longer represent the distribution? How does the HNSW graph's memory footprint grow with dimensionality, and what's our per-node memory budget? When we shard, does our fan-out query multiply latency linearly, or can we prune entire shards? And critically — what happens during index rebuild? Do we serve stale results, drop availability, or run a shadow index with zero-downtime cutover?" The interview question isn't "Explain HNSW." It's: "Your vector search system handles 500M embeddings of dimension 1536. You're migrating from single-node to a 10-shard cluster. P99 latency is 80ms during low traffic, but spikes to 2 seconds during index compaction at 2 AM. A customer reports that the same query returns different top-10 results when run two seconds apart. Walk me through: (a) exactly what compaction is doing under the hood and why it causes latency spikes, (b) why the same query gives different results 2 seconds apart — is this a bug or by design, (c) how you'd eliminate both problems without sacrificing recall below 0.95, and (d) what happens if you naively shard by embedding ID instead of by vector space proximity."**

---

## Summary & Interview Framing

A database optimized for high-dimensional vector search using approximate nearest neighbor algorithms — HNSW (graph-based, fast), IVF (cluster-based, tunable), with sharding for scale.

**How it's asked:** "Design a vector database for 1B embeddings with <10ms P99 ANN search. Compare HNSW vs IVF, cover sharding, and handle index updates without downtime."

## 1. What Problem Vector Databases Actually Solve

### 1.1 The Fundamental Operation: k-Nearest Neighbors

At their core, vector databases answer one question: **Given a query vector `q` and a collection of `N` vectors `{v₁, v₂, ..., vₙ}`, return the `k` vectors with smallest distance to `q`.**

The brute-force approach — compute distance from `q` to every `vᵢ`, sort, take top `k` — is `O(N·D)` where D is dimensionality. For 500M vectors of 1536 dimensions:

```
Brute force: 500M × 1536 = 768 billion floating-point operations per query
At 100 GFLOPS: 7.68 seconds per query
At 100 QPS: need 768 GFLOPS just for distance computation
```

This is why we need **[[Glossary#Approximate Nearest Neighbor (ANN)|Approximate Nearest Neighbor (ANN)]]** algorithms — they trade a small amount of accuracy for orders-of-magnitude speed improvements.

### 1.2 The ANN Contract

Every ANN algorithm makes an explicit trade-off:

| Metric | What It Means | Good Number |
|--------|---------------|-------------|
| **Recall@k** | Fraction of true nearest neighbors found | > 0.95 |
| **QPS** | Queries per second per node | 100-10,000+ |
| **Latency (P99)** | Tail latency per query | < 50ms |
| **Index Build Time** | Time to construct the index | Minutes to hours |
| **Memory Overhead** | Extra memory beyond raw vectors | 20%–300% |
| **Insertion Speed** | Vectors/second for incremental updates | 1K–100K/sec |

**The Pareto Frontier:** You can't simultaneously maximize recall, minimize latency, and minimize memory. HNSW gives high recall and high QPS but high memory overhead. IVF gives low memory but lower recall at the same speed. Disk-backed IVF gives unlimited scale but higher latency.

### 1.3 Distance Metrics

The choice of distance metric fundamentally changes which points are "close." This is NOT a detail — it determines which ANN index structures work and don't work.

| Distance | Formula | Index Compatibility | Use Case |
|----------|---------|---------------------|----------|
| **L2 (Euclidean)** | `‖q - v‖₂` | HNSW, IVF, PQ, brute-force | General purpose; rotation-invariant |
| **Inner Product (IP)** | `⟨q, v⟩` | HNSW (with transformation), IVF | Maximum inner product search (MIPS); used when embeddings are unnormalized |
| **Cosine** | `1 - ⟨q̂, v̂⟩` | Normalize vectors → use IP on unit vectors | Embedding similarity (most common) |
| **Jaccard** | `|A ∩ B| / |A ∪ B|` | MinHash LSH | Set similarity (documents, tags) |
| **Hamming** | Count differing bits | Bit-sampled LSH | Binary codes, image hashing |

**Critical Pitfall:** Cosine similarity on unnormalized vectors is NOT equivalent to IP. If your embedding model produces unnormalized vectors and you store them with cosine distance configured, the ANN index will return wrong results. Always verify: divide by norm or pick the right distance metric — don't assume.

---

## 2. Inverted File Index (IVF) — The Clustering Approach

### 2.1 How IVF Works

IVF partitions the vector space into `nlist` clusters using k-means (a clustering algorithm that iteratively groups data points around k centers by minimizing within-group distance). Each cluster has a centroid. At query time, you only search the `nprobe` closest clusters.

```
┌───────────────────────────────────────────────────────────────────┐
│                      IVF INDEX STRUCTURE                           │
│                                                                    │
│  Build Phase:                                                      │
│  ┌─────────┐   k-means    ┌──────────────────────────────────┐    │
│  │ N vectors│ ──────────► │ Centroid₁ │ Centroid₂ │ ... │ Cₙ │    │
│  └─────────┘              │  [v₁,v₇]  │ [v₃,v₉]   │     │[]  │    │
│                           └──────────────────────────────────┘    │
│                                                                    │
│  Query Phase:                                                      │
│  ┌──────┐   1. Dist to    ┌──────────────────────────────┐        │
│  │  q   │ ── centroids ─► │ C₂ (nearest)  │ C₇ (2nd)    │        │
│  └──────┘                 │ probe vectors │ ...          │        │
│                           └──────────────────────────────┘        │
│                                     │                              │
│                                     ▼                              │
│                           ┌─────────────────┐                     │
│                           │ Brute-force over │                    │
│                           │ nprobe clusters  │ → top-k             │
│                           │ (nprobe × N/nlist │                    │
│                           │  comparisons)     │                    │
│                           └─────────────────┘                     │
└───────────────────────────────────────────────────────────────────┘
```

### 2.2 The Two Critical Parameters

**`nlist`** — Number of clusters (set at build time, immutable without rebuild):
- Too small: Each cluster is huge, probe time dominates → degenerates to brute-force
- Too large: Clusters are tiny, but centroid computation is expensive and clusters become imbalanced
- **Rule of thumb:** `nlist = 4 × sqrt(N)` — for 1M vectors, nlist ≈ 4000

**`nprobe`** — Number of clusters to search (set at query time, tunable):
- Low nprobe: Fast, low recall (you miss the cluster containing the true nearest neighbor)
- High nprobe: High recall, slow (approaching brute-force)
- **The recall cliff:** Recall vs nprobe is NOT linear. Going from nprobe=1 to nprobe=5 might increase recall from 0.65 to 0.92. Going from nprobe=10 to nprobe=20 might only go from 0.97 to 0.98. The curve plateaus — find the knee.

### 2.3 IVF Variants

#### IVF-Flat
Stores raw vectors in each cluster. Brute-force within each probed cluster. Highest recall for a given nprobe, but highest memory (stores full vectors) and slowest per-cluster search.

#### IVF-PQ (Product Quantization)
Compresses vectors using Product Quantization (covered in §4). Dramatically reduces memory (16x-32x compression), but search uses approximate distance tables → lower recall. **Trade-off:** IVF-PQ is the workhorse for billion-scale — the PQ compression is what makes it possible to hold vectors in RAM.

#### IVFFlat vs IVFPQ Decision Matrix

| Criterion | IVF-Flat | IVF-PQ |
|-----------|----------|--------|
| Memory per vector (1536d) | 6 KB (float32) | 192 bytes (PQ 96×8) |
| Recall@10 at nprobe=32 | 0.97-0.99 | 0.88-0.94 |
| Query latency (same recall) | Slower | Faster (less data to scan) |
| Index build time | Faster | Slower (needs PQ training) |
| Use case | <10M vectors, max recall | >10M vectors, memory-constrained |

### 2.4 IVF Weakness: Cluster Boundary Misses

The fundamental failure mode of IVF: **a query vector falls near the boundary between cluster A and cluster B. The true nearest neighbor is in cluster B, but B is just outside the nprobe radius from the query.**

```
         Cluster A              │              Cluster B
    •  •     •                  │           •  •    • ★
  •    Cₐ    •       •q         │     ★  C_b  •   •
    •  •     •                  │      •  •    •
                                │
  q is closest to Cₐ → probes A only
  True NN ★ is in B → missed entirely
```

**Mitigations:**
1. **Increase nprobe** — but you pay latency
2. **Overlap clusters during build** — assign each vector to top-2 centroids (doubles storage)
3. **Multi-pass IVF** — do a coarse probe with high nprobe, then refine with PQ or brute-force
4. **Hybrid approach:** IVF for coarse filtering → HNSW graph within cluster for precise search

---

## 3. Hierarchical Navigable Small World (HNSW) — The Graph Approach

### 3.1 Intuition: Skip Lists for Vector Space

HNSW is essentially a **skip list in high-dimensional space.** In a skip list, each node participates in increasingly sparse layers — long "express lanes" at higher levels, detailed local connections at lower levels. HNSW does the same with neighbor graphs.

```
┌───────────────────────────────────────────────────────────────────┐
│                    HNSW THREE-LEVEL GRAPH                          │
│                                                                    │
│  Level 2 (sparse, long-range):                                    │
│    ● ─────────────────────────────── ●                            │
│                                                                   │
│  Level 1 (medium density):                                        │
│    ● ────── ● ────── ● ────── ● ────── ●                         │
│                                                                   │
│  Level 0 (dense, short-range, contains ALL nodes):                │
│    ●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●               │
│                                                                   │
│  Search:                                                          │
│    1. Start at entry point (top layer)                            │
│    2. Greedy descent: at each layer, move to neighbor closest to q│
│    3. Drop to next layer when local minimum reached                │
│    4. At layer 0, collect k nearest within the connected component│
│    5. Result: approximate k-NN (not guaranteed exact — graph is   │
│       navigable, not complete)                                    │
└───────────────────────────────────────────────────────────────────┘
```

### 3.2 Search Algorithm (Layer-by-Layer Greedy Descent)

```
SEARCH_HNSW(q, entry_point, M, ef_search):
    W = {entry_point}           # candidate set (dynamic size ef)
    visited = {entry_point}
    
    for layer = top_level down to 0:
        W = greedy_search_layer(q, W, M, ef_construction or ef_search)
        # At each step: expand W to neighbors of current closest,
        # keep only the ef closest to q
        # "ef" = exploration factor — trade recall for speed
    
    return top-k from W
```

**Parameters:**
- **`M`** — Maximum out-degree per node (edges per node). Typical: 16-64. Higher M = higher recall, higher memory, slower build.
- **`ef_construction`** — Exploration factor during index building. Higher = better graph quality (more edges explored per insertion), slower build. Typical: 100-500.
- **`ef_search`** — Exploration factor at query time. Higher = higher recall, higher latency. **This is your live recall knob — it's tunable per-query with no rebuild.**

### 3.3 The Recall-Latency Curve

This is the most important practical fact about HNSW:

```
Recall@10 vs ef_search (M=16, 1M vectors, 768d)
──────────────────────────────────────────────────
ef_search=16   → recall=0.78, latency=0.3ms
ef_search=32   → recall=0.92, latency=0.5ms  ← common default
ef_search=64   → recall=0.97, latency=0.9ms
ef_search=128  → recall=0.99, latency=1.6ms
ef_search=256  → recall=0.995, latency=3.0ms
ef_search=512  → recall=0.998, latency=5.5ms  ← diminishing returns
```

The curve is **convex**: early ef_search increases give big recall jumps; later ones give fractions of a percent for 2x latency. Find the ef_search that hits your recall SLA, not the maximum.

### 3.4 Memory Overhead — HNSW's Achilles' Heel

Each edge in the HNSW graph is a pointer to a neighbor. The storage cost:

```
Memory per node = sizeof(vector) + M * sizeof(edge) * layers_per_node_avg

For 1536-d float32, M=16, 4-byte edge IDs:
  Vector: 1536 × 4 = 6,144 bytes
  Edges:  16 × 4 × 1.3 (avg layers) ≈ 83 bytes
  Total per node: ~6.2 KB

For 100M nodes: 100M × 6.2 KB = 620 GB
For comparison, raw vectors: 100M × 6 KB = 600 GB
Memory overhead: ~3.3% — manageable

BUT for 768-d float32, M=32:
  Vector: 768 × 4 = 3,072 bytes
  Edges: 32 × 4 × 1.3 ≈ 166 bytes
  Overhead: 166 / 3072 = 5.4% — also manageable

The dangerous zone: LOW dimensionality + HIGH M
For 128-d, M=64:
  Vector: 512 bytes
  Edges: 64 × 4 × 1.3 ≈ 333 bytes
  Overhead: 65% — significant!
```

**Staff-Engineer Insight:** HNSW's memory overhead gets WORSE as dimensionality decreases (edges are a larger fraction of total storage). At 1536d the overhead is trivial; at 128d it dominates. **The dimension determines whether HNSW is memory-feasible, not just the vector count.**

### 3.5 Insertion and Deletion

**Insertion:** New nodes are added incrementally. The algorithm:
1. Assigns a random level (exponentially decaying probability: 1/M for each additional level)
2. Searches from top to find insertion neighborhood at each layer
3. Adds bidirectional edges to M nearest neighbors at each layer

**Deletion:** HNSW doesn't natively support deletion. The common approaches:
- **Tombstone:** Mark deleted, skip during search — cheap but graph degrades over time (edges to deleted nodes waste memory and search steps)
- **Periodic rebuild:** Run full rebuild weekly — prevents degradation but is expensive
- **Lazy reconnection:** On deletion, reconnect orphaned neighbors to each other — complex, requires checking connectivity

**The Degradation Problem:** Over months of inserts and tombstones, an HNSW graph accumulates dead edges. Recall drops slowly — it's a silent degradation. Benchmark recall weekly. When recall drops > 2%, trigger a rebuild.

### 3.6 HNSW vs IVF: The Real Trade-Off

| Dimension | HNSW | IVF |
|-----------|------|-----|
| **Recall at same latency** | Higher (0.98 vs 0.92 at 1ms) | Lower |
| **Memory** | Higher (graph edges + vectors) | Lower (vectors only for IVF-Flat) |
| **Build time** | Slower (O(N·log N) inserts) | Faster (single-pass k-means) |
| **Incremental inserts** | ✅ Native, fast | ⚠️ Possible but cluster assignment degrades over time |
| **Deletes** | ❌ Not native (tombstones degrade graph) | ✅ Trivial (remove from cluster) |
| **Dimensionality scaling** | Memory overhead higher at LOW dim | Agnostic to dimension |
| **Query-time tuning** | ef_search (per-query, fine-grained) | nprobe (per-query, coarse) |
| **Disk-backed** | ❌ Requires full graph in RAM | ✅ IVF-PQ can be disk-backed |

**Rule of thumb:**
- **<100M vectors, RAM fits:** HNSW — best recall-latency trade-off
- **>100M vectors or memory-constrained:** IVF-PQ — compression enables scale
- **High insert/delete rate:** Switch from HNSW to IVF or accept periodic rebuilds
- **GPU available:** Both benefit, but IVF's brute-force per-cluster step parallelizes extremely well

---

## 4. Vector Compression: Product Quantization (PQ) and Scalar Quantization (SQ)

### 4.1 Product Quantization

PQ splits each vector into `M` subvectors, clusters each subspace independently, and stores only the cluster IDs.

```
Original vector (D=128 dimensions, float32 → 512 bytes):
  [0.23, -0.45, 0.67, ..., 0.12]  # 128 floats

PQ with M=8 subvectors of 16 dimensions each:
  Subvector 1: [0.23, -0.45, ..., 0.67] → cluster ID 142 (1 byte)
  Subvector 2: [0.34, 0.89, ..., -0.12] → cluster ID 67  (1 byte)
  ...
  Subvector 8: [-0.56, 0.78, ..., 0.12] → cluster ID 201 (1 byte)

Stored: [142, 67, ..., 201] → 8 bytes (64x compression!)
```

**Distance computation with PQ:**
Instead of computing `‖q - stored_vector‖₂`, you precompute distance from `q` to every cluster centroid for each subspace (this is small — 256 centroids × 8 subspaces = 2048 distances). Then:

```
distance(q, [c1, c2, ..., c8]) = sum(distance_table[i][ci] for i, ci in enumerate(codes))
```

This is an APPROXIMATION — the true distance uses the actual vector, not the centroid. The error comes from quantization: replacing a subvector with its nearest centroid.

**PQ Trade-Off Table:**

| M (subvectors) | Bytes/vector | Compression | Recall Impact |
|----------------|-------------|-------------|---------------|
| 8 (D/M=192 for 1536d) | 8 | 768:1 | Severe (-20% recall) |
| 16 (D/M=96) | 16 | 384:1 | Significant (-10-15%) |
| 32 (D/M=48) | 32 | 192:1 | Moderate (-5-8%) |
| 64 (D/M=24) | 64 | 96:1 | Small (-2-4%) |
| 96 (D/M=16) | 96 | 64:1 | Minimal (-1-2%) |

**Staff-Engineer Insight:** PQ recall loss is NOT uniform across the vector space. Dense clusters (regions where many vectors are close) suffer LESS loss — the centroid is a good representative. Sparse regions (outliers) suffer MORE — the centroid is a poor substitute. If your data has heavy tails, PQ will degrade recall for tail queries. Monitor P50 and P99 recall separately — P99 might drop catastrophically while P50 looks fine.

### 4.2 Scalar Quantization (SQ)

Simpler than PQ: compress each dimension independently from float32 to int8.

```
float32: 4 bytes per dimension → 1536 × 4 = 6144 bytes
int8:    1 byte per dimension  → 1536 × 1 = 1536 bytes (4x compression)

Conversion: v_int8[i] = round((v_float32[i] - min) / (max - min) * 255)
```

SQ loses less recall than PQ at the same compression ratio because it doesn't split dimensions into unrelated subspaces. But 4x compression is the maximum. For higher compression (8x+), you need PQ.

### 4.3 Matryoshka Embeddings

A newer approach: train the embedding model to produce embeddings where the first K dimensions alone give good retrieval. Store full 1536d, but search with truncated 256d to reduce compute and memory.

```
Matryoshka embedding: first 256d → 90% recall, first 512d → 95%, full 1536d → 99%
```

This is orthogonal to PQ/SQ — you can apply PQ to the truncated dimensions for even more compression.

---

## 5. [[Glossary#Sharding|Sharding]] Vector Databases

### 5.1 Why Shard?

A single node has limits:
- **RAM:** HNSW for 20M × 1536d vectors needs ~124 GB just for vectors (you want them in RAM)
- **Throughput:** One CPU can compute ~10K QPS for brute-force, ~1K QPS for HNSW with ef_search=128
- **Disk IOPS:** IVF with disk-backed clusters can bottleneck on random reads

### 5.2 The Critical Design Decision: Sharding Strategy

There are two fundamentally different ways to shard vectors, and they have wildly different consequences.

#### Strategy A: Shard by ID (Hash-Based)

```
shard_id = hash(vector_id) % num_shards
```

| Pros | Cons |
|------|------|
| Simple, balanced distribution | Each query must fan out to ALL shards |
| ID-based operations (fetch, update, delete) are O(1) | Latency = max(shard_latencies) |
| Shard addition is just rehashing | No pruning — every shard searched for every query |

#### Strategy B: Shard by Vector Space Proximity (Cluster-Based)

```
shard_id = nearest_centroid(vector)  # among num_shards centroids
```

| Pros | Cons |
|------|------|
| Query can route to only K nearest shards | Hotspots — some shards get more vectors |
| Latency proportional to K, not total shards | Imbalanced storage and throughput |
| Higher recall for same compute | Rebalancing requires moving vectors across shards |

### 5.3 The Fan-Out Problem

With ID-based sharding, query latency scales with the SLOWEST shard, not the average:

```
Without sharding: P99 latency = T
10-shard ID-based: P99 latency = max(shard₁_latency, ..., shard₁₀_latency)
                                ≈ T + 3σ  # tail latency amplification
```

If shards have identical hardware and load, P99 goes UP because you're taking the max of 10 independent latency distributions. This is the **tail latency amplification** problem.

Mitigations:
1. **Hedged requests:** Send query to all shards, return results when K of N respond (accept partial results)
2. **Redundant shards:** Each vector stored on 2+ shards; query can skip one shard if it's slow
3. **Approximate shard pruning:** Even with ID-based sharding, maintain per-shard cluster centroids. At query time, skip shards whose centroid is very far from q (introduces recall loss proportional to pruning aggressiveness).

### 5.4 Shard Count Determination

| Scale | Shards | Shard Strategy | Notes |
|-------|--------|---------------|-------|
| <10M vectors | 1 | N/A | Single node fine |
| 10-100M | 3-5 | Cluster-based | Prune to 1-2 shards per query |
| 100M-1B | 10-32 | Hybrid | Cluster-based routing + ID-based within shard |
| 1B+ | 32-128 | Cluster-based + hierarchical | Coarse routing shard → fine-grained shards within |

### 5.5 Bloom Filters in Vector Search

**Inserts:** Before inserting, check if the vector already exists (by hash of content). A Bloom filter gives `O(1)` "definitely not present" with controllable false positive rate. If Bloom says "might be present," do a full check (expensive).

```
Bloom filter for 100M vectors, 1% FPR: ~120 MB
Saves 99% of duplicate checks → massive speedup for high-ingestion pipelines
```

---

## 6. Index Rebuild: The Operational Nightmare

### 6.1 Why Rebuilds Happen

- **IVF:** Cluster centroids drift as new vectors are inserted. After ~20% new data, recall degrades measurably. Full reclustering needed.
- **HNSW:** Graph accumulates dead edges from deletes/tombstones. After months, recall drops 2-5%.
- **PQ:** Codebooks become suboptimal for new data distribution (e.g., new document domain for RAG).
- **Shard rebalancing:** Adding or removing shards requires redistribution.

### 6.2 Zero-Downtime Rebuild Pattern

```
Step 1: BUILD SHADOW INDEX
  ┌──────────┐     ┌─────────────────┐
  │ Live Index│     │ Shadow Index     │
  │ (serving) │     │ (building, idle) │
  └──────────┘     └─────────────────┘
       ▲
       │ queries

Step 2: CATCH-UP INGESTION
  ┌──────────┐     ┌─────────────────┐
  │ Live Index│ ──►│ Shadow Index     │  ← dual-write new vectors
  │ (serving) │     │ (catching up)   │
  └──────────┘     └─────────────────┘
       ▲
       │ queries

Step 3: VALIDATE
  ┌──────────┐     ┌─────────────────┐
  │ Live Index│     │ Shadow Index     │
  │ (serving) │     │ (recall > 0.98?) │  ← run eval
  └──────────┘     └─────────────────┘
       ▲
       │ queries

Step 4: CUTOVER
  ┌──────────┐     ┌─────────────────┐
  │ Old Index │     │ New Index        │  ← switch traffic
  │ (keep 24h)│     │ (serving)        │
  └──────────┘     └─────────────────┘
                         ▲
                         │ queries

Step 5: DECOMMISSION
  Old index deleted after 24h of healthy new index operation.
```

**Cost:** 2x storage during rebuild. **Risk:** If shadow index validation is incomplete, you cut over to a degraded system. Run validation on a representative query sample (not just random queries — the tail matters).

---

## 7. Freshness, Staleness, and Eventual Consistency

### 7.1 The Write Path

Vector databases have a fundamental write-amplification problem: inserting a vector isn't just storing bytes — it requires index structure modification.

| Index Type | Insert Cost | Why |
|------------|------------|-----|
| IVF-Flat | Low | Append to cluster list. Cluster assignment is O(nlist) distance calcs. |
| IVF-PQ | Medium | Encode with PQ codebook + append. |
| HNSW | High | Search for insertion neighborhood at multiple layers + edge addition. O(M · log N) distance calcs. |
| DiskANN | Very High | Must update graph edges on disk — random writes. |

### 7.2 Read-Your-Writes: A Hard Problem

User inserts a document → embedding generated → vector inserted → user searches → should find their own document.

With eventual consistency, this can fail:
- Vector inserted, but index not yet updated (stale read)
- Vector inserted on shard A, query hits shard B (for cluster-based sharding with rebalancing in progress)

Mitigations:
- **Synchronous write to WAL first**, acknowledge after WAL, build index async
- **Read-your-writes via doc ID:** For a user searching their own doc, check by doc ID directly (not vector search) to confirm presence
- **Sticky routing:** Route queries from the user who inserted to the same shard for a grace period

---

## 8. Hybrid Search: Vectors + Keywords

### 8.1 Why Hybrid?

Pure vector search fails when:
- **Exact match matters:** Searching for "error code E0503" — vector similarity might return "error code E0504" (similar embedding) but the user wants exact string match
- **Rare terms:** A product name that appears 3 times in your corpus — its embedding is poorly learned
- **Booleans/filters:** "Documents from 2023 about Kubernetes pods" — date is a filter, not a similarity concept

### 8.2 Reciprocal Rank Fusion (RRF)

The simplest fusion algorithm that works well in practice:

```
RRF(doc) = Σ (1 / (k + rank_in_shard(doc))) for each shard

For shard 1 (dense): doc A ranked 1st, doc B 3rd
For shard 2 (sparse/BM25): doc A ranked 5th, doc B 1st

RRF(A) = 1/(60+1) + 1/(60+5) = 0.0164 + 0.0154 = 0.0318
RRF(B) = 1/(60+3) + 1/(60+1) = 0.0159 + 0.0164 = 0.0323  ← B wins despite lower dense rank
```

`k=60` is the standard constant — it dampens the effect of very high ranks. RRF doesn't require score normalization between shards — it only uses ranks, making it plug-and-play across arbitrary retrieval methods.

### 8.3 Filtered Vector Search: Pre-Filtering vs Post-Filtering

**Pre-filtering:** Apply metadata filters FIRST, then vector search over the reduced set.

```
Pre-filter (WHERE date > '2024-01-01' AND category = 'engineering')
  → 50K vectors pass filter
  → Vector search over 50K → top-10
```

**Post-filtering:** Vector search FIRST (k=100), then apply metadata filters.

```
Vector search over 10M → top-100
  → Apply filter → only 2 vectors pass
  → Return top-2 (but might miss vectors ranked #101-200 that WOULD pass the filter)
```

**Pre-filtering is correct; post-filtering is fast but lossy.** The right approach: pre-filter when the filter is selective (<1% of corpus). Pre-filter + ANN when the filter is broad — you can build a separate HNSW index per common filter value (e.g., per-category indexes) but this explodes memory. "Filtered HNSW" implementations modify the search to skip filtered-out nodes — correct but slower than unfiltered search.

---

## 9. Monitoring and Observability

### 9.1 What to Monitor

| Metric | Why | Alert Threshold |
|--------|-----|-----------------|
| **Recall@k** | Is your ANN still finding true neighbors? | Drop > 2% from baseline |
| **P50/P99 query latency** | Are users waiting? | P99 > 3x baseline |
| **Index memory usage** | Is HNSW graph bloating? | >90% node RAM |
| **Index build time** | Is your rebuild pipeline healthy? | >2x previous build |
| **Insertion rate vs query rate** | Is ingestion keeping up? | Insert lag > 60s |
| **Shard imbalance** | Are some shards overloaded? | Max/min ratio > 2x |
| **Per-shard recall** | Is one shard silently degraded? | Any shard < 0.90 |
| **Cache hit rate** | Are cached results meaningful? | Query cache hit rate < 30% |
| **Tombstone ratio** | How much dead data in the index? | Tombstones > 5% of vectors |

### 9.2 Recall Measurement in Production

This is HARD — you don't have ground truth for user queries.

**Approach 1: Golden Query Set**
Maintain 500-2000 labeled queries with known relevant documents. Run periodically (hourly/daily) and compare results.

**Approach 2: Brute-Force Comparison**
For a random 1% of queries, also run brute-force k-NN in the background. Compare ANN results to brute-force. This is expensive but gives ground-truth recall.

**Approach 3: Click-Through Rate (Proxy)**
If your search serves a UI, track whether users click results. Degrading recall → lower CTR. This is a noisy proxy but it's free and continuous.

---

## 10. Interview Question + Model Answer

> **Question:** "You're building a semantic search system for 500 million scientific papers, each with a 1536-dimensional embedding. The index must serve 1000 QPS with P99 latency < 50ms and recall@10 > 0.95. Total vector storage is ~3 TB. Walk me through your index architecture, explain why you chose your specific ANN algorithm and sharding strategy, and identify the three operational risks you'd lose sleep over."

### Model Answer

**Architecture:**

**Index choice: IVF-PQ with cluster-based sharding.**

Why NOT HNSW: At 500M × 1536d, raw vectors are 3 TB. HNSW with M=16 adds ~3% overhead for edges → ~3.1 TB total. This can fit across 10 nodes (310 GB/node), but HNSW requires full graph in RAM — each node needs 310 GB which is expensive but not impossible. However, the killer is insertion: 500M HNSW inserts with ef_construction=200 takes days per node. With a weekly corpus refresh (new papers), you need faster rebuilds.

Why IVF-PQ: PQ with M=96 subvectors compresses 500M vectors from 3 TB → ~48 GB. This fits in RAM on a SINGLE high-memory node for the codebook, with vectors on SSD. 10-shard cluster-based sharding means each shard handles ~30 GB. With nprobe=3 (query routes to 3 nearest shards), latency is 3x single-shard latency. IVFPQ search over 50M vectors in RAM completes in <10ms per shard, comfortably under 50ms budget.

**Sharding strategy: Cluster-based routing with 32 shards.**

1. Run k-means (k=32) on a sample of 10M vectors to establish shard centroids.
2. Assign each paper to its nearest centroid.
3. At query time, compute distance to all 32 centroids (32 × 1536 ≈ 49K operations — negligible relative to query). Route to nprobe=3 nearest shards.
4. Merge and re-rank top results from 3 shards.

Why not ID-based: Fan-out to all 32 shards would make P99 = max(P99_shard₁ ... P99_shard₃₂). With tail latency amplification, this could push P99 from 15ms to 60ms.

**Risk 1: PQ Recall Degradation for Outliers**

Papers in niche subfields (rare topics, non-English) have embeddings far from cluster centroids. PQ will badly approximate their vectors. Querying for "Finnish phonology in endangered Uralic languages" might get 0.75 recall instead of 0.95 because every quantization dimension introduces error that compounds for unusual embeddings.

Mitigation: Monitor recall@10 stratified by topic/popularity quintile. If P5 recall < 0.85, increase M (use fewer subvectors, less compression) for outlier-heavy shards — you can use different PQ configs per shard.

**Risk 2: Shard Imbalance Under Cluster-Based Assignment**

K-means minimizes within-cluster variance, NOT cluster size. A natural distribution like "machine learning papers" (huge cluster) vs "paleontology papers" (small cluster) creates uneven shards. If one shard holds 80M vectors while others hold 20M, query latency will be 4x higher when routed to the large shard.

Mitigation: Use k-means with size constraints, or post-process assignment: for the largest clusters, split into sub-clusters and assign to separate shards. This breaks the "exact nearest centroid" property but recall only degrades if papers naturally belong in that shard (they don't — they just happen to be in a dense region of vector space).

**Risk 3: Index Staleness During Rebuild**

The system indexes new papers daily (arXiv releases ~15K new papers/day). Over months, cluster centroids drift — papers from 2026 use different terminology than 2020 papers. Recall degrades slowly due to stale cluster assignments.

Mitigation: Shadow rebuild (see §6.2) every 90 days. The 3 TB of raw vectors takes ~2 hours to recluster and ~4 hours to build new PQ codebooks and indices. During the 6-hour window, dual-write new papers to old and new indices. Cut over after validation on 10K golden queries (recall must match or exceed current index). Keep old index hot for 24 hours as rollback.

### ❗ Common Pitfall

**"We'll use HNSW because it has the best recall-latency tradeoff, and we'll just add more RAM."**

This is the most expensive vector search mistake. HNSW has the best single-node recall-latency curve, but it imposes three hidden costs at scale:

1. **RAM is not linearly scalable.** A single node with 512 GB RAM costs 4-8x more per GB than 8 nodes with 64 GB each. At billion-scale, you're paying for the privilege of keeping a perfect graph in memory.

2. **HNSW insert time grows with dataset size.** Inserting the 500-millionth vector requires traversing a graph with 500M nodes. Each insertion does O(M · log N) distance computations. For M=16, N=500M: ~400 distance calcs per insert. At 100K inserts/sec: 40M distance calcs/sec — saturates a CPU. IVF cluster append is constant-time (add to list).

3. **The recall advantage shrinks at scale.** At 1M vectors, HNSW beats IVF by 5-8% recall. At 500M vectors, with PQ compression and tuned nprobe for IVF, that gap shrinks to 1-2%. You're paying 5x hardware cost for a 2% recall improvement. The staff-engineer move: spend that budget on a better embedding model (10-20% recall gain) instead of fancier indexing.

**When HNSW IS the right choice:** (1) <50M vectors, (2) RAM is cheap for your budget, (3) high insert/delete churn is NOT expected, (4) recall@10 > 0.98 is a hard requirement. If any of these isn't true, IVF-PQ or DiskANN deserves a serious look.

---

## 11. Key Takeaways

1. **No index dominates the Pareto frontier.** HNSW wins recall-latency. IVF-PQ wins scale-per-dollar. DiskANN wins cost at rest. The question isn't "which is best?" — it's "which trade-offs match my constraints?"

2. **HNSW's hidden cost is memory at low dimensions.** The graph edge overhead as a fraction of total storage INCREASES as dimensionality decreases. At 1536d, M=16 HNSW overhead is ~3%. At 128d, it's 65%. Don't just count vectors — count dimensions when sizing.

3. **IVF recall cliff is real and sharp.** Below nprobe=4*sqrt(N), recall drops geometrically. Above ~10*sqrt(N), recall gains are microscopic. Find the knee for your data — it's not in any paper, you must measure it on your corpus.

4. **PQ recall loss hits the tail hardest.** Dense clusters compress well. Sparse regions (outliers, rare topics) lose 10-20% recall. Monitor P5 and P1 recall separately from P50. If your critical use case involves niche/rare queries, PQ may be the wrong choice for those queries even if aggregate recall looks fine.

5. **Shard by vector space, not by ID.** ID-based sharding forces fan-out to all shards, amplifying tail latency. Cluster-based routing prunes shards but requires vigilance against imbalance. The hybrid: coarse cluster routing with ID-based sharding within each cluster group.

6. **The rebuild is the product.** Designing the index is 20% of the work. Designing the zero-downtime rebuild — with validation, catch-up, cutover, and rollback — is 80%. Every vector DB at scale rebuilds. If your rebuild takes 12 hours and blocks writes, your system has 12 hours of planned downtime per rebuild cycle. This is a design failure, not an ops detail.

7. **Hybrid search is table stakes now.** Pure vector search fails on exact-match queries, rare terms, and filtered queries. RRF is simple enough to implement and good enough to ship. The engineering cost of hybrid search is low; the user experience cost of pure vector-only is high for any real-world application.

8. **Monitor recall, not just latency.** Latency is easy to measure — Prometheus gives it for free. Recall requires golden query sets, brute-force baselines, or proxy metrics. Vector search systems that only monitor latency are flying blind. You cannot tune an ANN index without recall data. Every day you don't measure recall, your system is probably degrading and you don't know it.

9. **Staff-level reframe:** Don't ask "HNSW or IVF?" Ask: **"What is the recall budget for this system? What's the cost of a missed result vs. a slow result? How does our data distribution (cluster density, dimensionality, tail behavior) interact with each index type's failure modes? And what's the operational cost — not just hardware, but rebuild frequency, on-call burden, and migration path when we grow 10x?"** The index choice, sharding strategy, and compression scheme all follow from those answers.

---

## Related
- [[topic-queue]]
- [[RAG Pipeline (Chunking, Embeddings, Retrieval, Reranking)]]
- [[LLM Serving at Scale (vLLM, Quantization, Batching, KV cache)]]
- [[Bloom Filters & Probabilistic Data Structures]]
- [[Database Sharding & Replication]]
- [[Search Engine (Elasticsearch)]]
- [[Metrics & Monitoring (Prometheus-Grafana)]]
- [[Weakness Vault/Day-46-Vector-Database-Internals]]

## Interview Cheat Sheet

**Key Points to Remember:**
- Every ANN index is a precision-recall-speed trade-off on a Pareto frontier — no single index dominates. HNSW wins recall-latency (<100M, RAM-resident); IVF-PQ wins scale-per-dollar (billion-scale, compressed, disk-backed).
- HNSW's memory overhead gets WORSE at low dimensionality (graph edges dominate storage at 128d, trivial at 1536d) and it cannot delete natively (tombstones silently degrade recall over months). `ef_search` is your live per-query recall knob — no rebuild needed.
- IVF's recall depends on `nprobe` and has a sharp "recall cliff" — find the knee for your data, don't just max it out. Cluster centroids drift as data grows; plan for periodic re-clustering.
- Shard by vector space proximity (cluster-based), NOT by ID — ID-based sharding forces fan-out to all shards and amplifies tail latency (P99 = max of all shard latencies).
- The rebuild is 80% of the operational work: use a shadow-index pattern (build → catch-up → validate → cutover → keep old for rollback) to achieve zero-downtime. Always monitor recall, not just latency.

**Common Follow-Up Questions:**
- **"How do you keep recall high as new data arrives and the index drifts?"** — Centroids drift and HNSW graphs accumulate dead edges; set a recall budget, benchmark weekly against a golden query set, and trigger a shadow rebuild when recall drops >2% from baseline.
- **"Why might the same query return different results two seconds apart?"** — By design, not a bug: ANN is approximate, and concurrent inserts/deletes/tombstones change the index structure between queries. If determinism is required, cache results or snapshot the index.
- **"When is HNSW the wrong choice despite its great recall-latency curve?"** — At billion scale (RAM cost), high insert/delete churn (graph degrades), low dimensionality (edge overhead dominates), or when the recall advantage over tuned IVF-PQ shrinks to 1-2% — spend the budget on a better embedding model instead.

**Gotcha:**
- Assuming HNSW's recall advantage holds at scale. At 1M vectors HNSW beats IVF by 5-8% recall; at 500M with tuned PQ compression and nprobe, that gap shrinks to 1-2% — while HNSW costs 5x more in RAM and has insert time that grows with O(M·log N). The staff move is to spend the hardware budget on a better embedding model (10-20% recall gain) rather than fancier indexing.
