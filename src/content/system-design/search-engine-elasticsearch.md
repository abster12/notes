---
title: "Search Engine (Elasticsearch)"
category: "Search Infrastructure"
day: 11
difficulty: advanced
last_updated: "2026-06-19"
tags: [system-design, interview, search, elasticsearch, inverted-index, distributed-search, lucene, bm25, sharding, near-real-time]
read_time: 29
listen_time: 41
---

# Search Engine (Elasticsearch)

## Summary & Interview Framing

A system that builds inverted indices from documents and serves full-text queries with ranking, filtering, and aggregation — Elasticsearch is the open-source standard built on Lucene.

**How it's asked:** "Design a search engine for 1B documents with <100ms query latency. Cover inverted index, sharding, relevance ranking, and handling real-time updates."

## Overview

Elasticsearch is a distributed, RESTful search and analytics engine built on top of Apache Lucene, the same Java full-text search library that powers Solr. Where a relational database lets you find rows that match a predicate, Elasticsearch lets you find documents that are *relevant* to a natural-language query, rank them by statistical significance, and aggregate billions of records in milliseconds. It stores data as schema-free JSON documents, exposes a HTTP/JSON API, and scales horizontally by partitioning an index across many nodes.

Its dominance in logs (the Elastic/ELK stack), product search, observability, and security analytics comes from a single design bet: treat search as a distributed, near-real-time problem and push relevance, filtering, and analytics all the way down into an immutable, segment-based inverted index.

Understanding Elasticsearch at a senior level means understanding four overlapping systems — and how their tuning knobs trade off against one another:

- The **Lucene segment model** (immutable inverted indexes, merges)
- The **analysis pipeline** (text → tokens)
- The **shard/replica distribution layer** (horizontal scaling)
- The **scatter-gather query coordinator** (distributed search)

```
                        ┌─────────────────────────────────────┐
                        │         ELASTICSEARCH STACK         │
                        └─────────────────────────────────────┘
                                          │
            ┌───────────────┬─────────────┼──────────────┬───────────────┐
            ▼               ▼             ▼              ▼               ▼
   ┌──────────────┐ ┌──────────────┐ ┌──────────┐ ┌────────────┐ ┌────────────┐
   │  Lucene      │ │  Analyzer    │ │  Shard / │ │  Scatter-  │ │  Relevance │
   │  Segment     │ │  Chain       │ │  Replica │ │  Gather    │ │  Scoring   │
   │  Model       │ │  Pipeline    │ │  Distrib.│ │  Query     │ │  (BM25)    │
   └──────────────┘ └──────────────┘ └──────────┘ └────────────┘ └────────────┘
```

---

## The Inverted Index: The Heart of Full-Text Search

The fundamental data structure inside every shard is the inverted index, and it is the reason full-text search is fast at all. A forward index maps a document to the terms it contains; an inverted index inverts that relationship, mapping each distinct term to the list of documents that contain it. When you search for "dog," the engine does not scan every document — it looks up "dog" in the term dictionary and reads its posting list directly.

The term dictionary is kept memory-efficient and lookup-fast by an **FST** (finite state transducer), a compressed automaton that maps term strings to the on-disk file offset of their postings. The posting list itself is not a naive array of integers; Lucene encodes it with frame-of-reference compression and, for conjunctions, runs skip pointers so that intersections of large posting lists skip ahead rather than walking element by element.

```
   DOCUMENTS                    INVERTED INDEX (per segment)
   ─────────                    ─────────────────────────────

   Doc 1: "the quick brown fox"     TERM DICTIONARY (FST)
   Doc 2: "the lazy dog"            ┌─────────────┐    on-disk
   Doc 3: "the quick dog barks"     │  "brown" ───────┐ offset
                                   │  "dog"    ───────┤
                                   │  "fox"    ───────┤
                                   │  "lazy"   ───────┤
                                   │  "quick"  ───────┤
                                   │  "the"    ───────┘
                                   └─────────────┘
                                          │
                                          ▼
                                 POSTING LISTS (frame-of-reference compressed)
   ┌─────────────┬────────┬───────────┬───────────────┬───────────────────────┐
   │ Term        │ Doc IDs │ Term Freq │  Positions    │  Offsets / Payloads   │
   ├─────────────┼────────┼───────────┼───────────────┼───────────────────────┤
   │ "brown"     │ [1]    │ 1         │ [2]           │ (for highlighting)    │
   │ "dog"       │ [2,3]  │ 1, 1      │ [2],[2]       │                       │
   │ "fox"       │ [1]    │ 1         │ [3]           │                       │
   │ "lazy"      │ [2]    │ 1         │ [1]           │                       │
   │ "quick"     │ [1,3]  │ 1, 1      │ [1],[1]       │                       │
   │ "the"       │ [1,2,3]│ 1, 1, 1   │ [0],[0],[0]   │                       │
   └─────────────┴────────┴───────────┴───────────────┴───────────────────────┘
         ▲ skip pointers enable fast intersection of large posting lists
```

Each posting typically stores more than just a doc ID. For the `text` field it stores:

- **Term frequency** — how many times the term appears in the document
- **Positions** — the position of each occurrence (for phrase and proximity queries)
- **Offsets** — for highlighting
- **Payloads** — optional, application-specific

These ancillary values are what make relevance scoring and phrase matching possible without re-reading the source document.

### Segments: The Immutable Unit

Crucially, Lucene does not store one giant inverted index per shard. A shard is a *Lucene index*, and a Lucene index is a collection of immutable **segments**. Each segment is a fully self-contained inverted index written once and never modified.

```
   ┌─────────────────── ONE SHARD = ONE LUCENE INDEX ───────────────────┐
   │                                                                     │
   │   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
   │   │ Segment 1│  │ Segment 2│  │ Segment 3│  │   Segment N      │  │
   │   │(refresh) │  │(refresh) │  │(refresh) │  │ (merged, large)  │  │
   │   │immutable │  │immutable │  │immutable │  │   immutable      │  │
   │   └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘  │
   │        │             │             │                 │            │
   │        │   .live bitset marks deleted docs per segment             │
   │        ▼             ▼             ▼                 ▼            │
   │   ┌─────────────────────────────────────────────────────────────┐  │
   │   │            Background Tiered Merge Policy                   │  │
   │   │  many small segments  ──►  fewer larger segments            │  │
   │   │  reclaims deletes  •  reduces file handle count             │  │
   │   └─────────────────────────────────────────────────────────────┘  │
   │                                                                     │
   │   Translog (append-only, durability for uncommitted writes)        │
   │   ────────────────────────────────────────────────────────         │
   └─────────────────────────────────────────────────────────────────────┘
```

The lifecycle of a document through the segment model:

- New documents are first **buffered in memory**
- A **refresh** writes them out as a new segment (searchable, but not `fsync`'d)
- Deleted documents are not actually removed but **marked in a `.live` bitset**
- A segment only physically shrinks when it is **merged** with other segments
- Merge is the background garbage collector: the tiered merge policy combines many small segments into fewer larger ones, reclaims deletes, and reduces the number of files the search path must consult

This immutability is what enables:

- Lock-free concurrent reads
- Cheap OS page-cache reuse
- The near-real-time model

But it also explains why **updates are really "mark old doc deleted, index new doc"** and why a freshly indexed document is invisible until the next refresh opens a new segment.

### Doc Values: The Columnar Store for Sorting and Aggregations

A second, equally important structure is **doc values**, a columnar on-disk store keyed by document that backs sorting, aggregations, and scripting. Where the inverted index is optimized for "which documents contain this term," doc values are optimized for "what is the value of this field for this document."

Because doc values live on disk and are designed for sequential, cache-friendly access, aggregations and sorts do not require loading the inverted index into heap — a major operational difference from the older `fielddata` mechanism, which inverted the inverted index into JVM heap for text fields and was a frequent source of out-of-memory crashes.

- **Doc values** are enabled by default for almost every non-text field
- For `text` fields they are **off**, which is why you typically map a field as both `text` (for search) and `keyword` (for aggregation) using multi-fields

---

## The Analyzer Chain: From Raw Text to Searchable Tokens

Raw text almost never enters the inverted index verbatim. Before a string is broken into postings, it passes through an analyzer chain consisting of, in strict order:

1. Zero or more **character filters**
2. Exactly one **tokenizer**
3. Zero or more **token filters**

```
   RAW TEXT
   "The <b>Quick</b> Brown Fox"
       │
       ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  1. CHARACTER FILTER(S)  (zero or more)                          │
   │     html_strip  →  "The Quick Brown Fox"                         │
   │     mapping     →  accent / character normalization              │
   └──────────────────────────────────────────────────────────────────┘
       │
       ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  2. TOKENIZER  (exactly one — fixes token boundaries)            │
   │     standard    →  ["The","Quick","Brown","Fox"]                 │
   │     whitespace  →  splits on whitespace only                      │
   │     keyword     →  whole string as one token                      │
   │     ngram/edge  →  overlapping substrings for partial match       │
   │     path_hierarchy → "/a/b/c" matchable by "/a/b"                │
   └──────────────────────────────────────────────────────────────────┘
       │  stream of tokens
       ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  3. TOKEN FILTER(S)  (zero or more — order matters!)             │
   │     lowercase  →  ["the","quick","brown","fox"]                  │
   │     stop       →  removes stopwords  ["quick","brown","fox"]     │
   │     asciifolding → strips diacritics                              │
   │     synonym    →  "cu" → "see you"                                │
   │     stemmer    →  "running","runs","ran" → "run"                 │
   │     decompounder → "schuhgeschäft" → "schuh","geschäft"          │
   └──────────────────────────────────────────────────────────────────┘
       │
       ▼
   FINAL TOKENS  →  indexed as postings in the inverted index
   ["quick","brown","fox"]
```

### Character Filters

Character filters operate on the raw string before tokenization:

- `html_strip` removes markup
- Mapping filters can replace characters or normalize accents

### Tokenizers

The tokenizer then splits the string into a stream of tokens:

- `standard` — Unicode-aware segmentation (the default)
- `whitespace` — splits on whitespace only
- `keyword` — emits the whole string as a single token
- `ngram` and `edge_ngram` — emit overlapping substrings for partial matching
- `path_hierarchy` — splits filesystem-like paths so that `/a/b/c` can be matched by `/a/b`

The choice of tokenizer is consequential because it fixes token boundaries that the rest of the chain cannot undo.

### Token Filters

Token filters then transform the token stream in a pipeline:

- `lowercase` — near-universal
- `stop` — removes a configured set of stopwords
- `asciifolding` — strips diacritics
- `synonym` — expands or rewrites tokens (e.g., "cu" → "see you")
- `stemmer` or language-specific filters like `porter_stem`, `kstem`, or the Snowball filters — reduce inflected words to a root form so that "running," "runs," and "ran" collapse to a single posting
- Decompounders — split German compounds like "schuhgeschäft" into "schuh" and "geschäft"

**Order matters:**

- Synonyms should generally be applied **before** stemming so the synonym's root is also stemmed
- Stopwords should be removed **carefully** because removing them can break phrase queries whose positions no longer line up

### Index-Time vs Search-Time Analysis

A subtle but critical operational point is the distinction between index-time and search-time analysis:

- **At index time:** the field's configured analyzer produces the tokens that go into the inverted index
- **At search time:** a `match` query on a `text` field re-analyzes the query string — by default with the same analyzer, though a separate `search_analyzer` can be configured to apply lighter processing at query time (for example, synonyms only at search time so you don't inflate index size)

**Mismatched analysis** is one of the most common "why didn't my document match?" bugs: if you index with stemming but search without it, "running" indexes under "run" while the query looks for "running" and finds nothing.

- The `_analyze` API lets you dry-run any analyzer against sample text to diagnose exactly this
- For exact-match fields — IDs, tags, statuses, hostnames — you use the `keyword` type, which bypasses analysis entirely and indexes the whole value as a single token

---

## Mapping Types and Field Datatypes

Mapping is Elasticsearch's schema: it declares what fields exist, what type each is, and how it should be indexed. Older versions supported *mapping types*, a notion that one index could hold several logical "tables" distinguished by a `_type` field; this was deprecated in 6.x and removed in 7.x because fields of the same name in different types had to share one Lucene field, leading to confusing semantics, and because the type served no real isolation that a separate index wouldn't provide better. Today the unit of schema isolation is the index itself, and the recommended pattern for distinct entity shapes is one index per entity type (or a single index with a discriminating field and `type`-aware filtering).

### Field Types and Their Indexing Behavior

| Type | Analyzed? | Index Structure | Doc Values | Use Case |
|------|-----------|-----------------|------------|----------|
| `text` | Yes | Inverted index + positions | Off | Full-text search |
| `keyword` | No | Single token + doc values | On | Exact match, sort, aggregate |
| `long`/`integer`/`double`/`float` | No | BKD tree | On | Numeric range queries |
| `scaled_float` | No | BKD tree (long × factor) | On | Currency |
| `date` | No | BKD tree (epoch ms) | On | Time-based queries |
| `boolean` | No | Term index | On | True/false filters |
| `ip` | No | Term index | On | IP range/CIDR queries |
| `object` | No | Flattened | On | Nested JSON |
| `nested` | No | Hidden sub-docs | On | Per-element queries |
| `geo_point` | No | BKD tree | On | Lat/long distance, bbox |
| `geo_shape` | No | BKD tree | On | Polygons, lines, GIS |

The canonical pattern for human-readable fields is a multi-field:

```json
"title": {
  "type": "text",
  "fields": {
    "raw": { "type": "keyword" }
  }
}
```

This lets you both full-text search `title` and aggregate on `title.raw`.

Because Lucene has no true nested objects, arrays of `object` fields lose their per-element associations — for that you use `nested` type, which indexes each inner object as a separate hidden document so that queries can match "the city is X *and* the salary is Y within the same inner object."

### Two Mapping Decisions with Outsized Operational Impact

- **`index: false`** — disables indexing entirely (the field is stored but not searchable), useful for large blobs you only retrieve by `_id`
- **`norms: false`** — every indexed `text` field carries a `norm` (a single byte encoding field length and index-time boost) which costs heap per document; if you never need relevance scoring on a field (say, a log level), set `norms: false` to save memory

### Dynamic Mapping and Mapping Explosion

Dynamic mapping is convenient but dangerous in multi-tenant or log ingestion workloads: a single malformed document with thousands of unique field names can blow up the cluster's mapping (the "mapping explosion").

- Production indices set `index.mapping.total_fields.limit`
- Often use dynamic templates or switch to `strict` dynamic mode that rejects unknown fields
- **Runtime fields** (7.11+) let you define fields evaluated at query time from a Painless script rather than stored in the index, decoupling schema evolution from reindexing

---

## [[Glossary#Sharding|Shards]] and Replicas: Distributing the Index

An Elasticsearch index is a logical namespace spread across one or more **primary shards**, and each primary shard has zero or more **replica shards**. A primary shard is the authoritative write target for the subset of documents routed to it; a replica is a full copy of a primary that serves reads and survives primary failure. Each shard is itself a complete, independent Lucene index — its own segments, its own inverted index, its own translog.

```
   INDEX "products"  (3 primary shards, 1 replica each)
   ────────────────────────────────────────────────────

        ┌─────────┐         ┌─────────┐         ┌─────────┐
        │  Prim 0 │         │  Prim 1 │         │  Prim 2 │
        └────┬────┘         └────┬────┘         └────┬────┘
             │                   │                   │
        ┌────┴────┐         ┌────┴────┐         ┌────┴────┐
        │Repl 0  │         │Repl 1  │         │Repl 2  │
        └─────────┘         └─────────┘         └─────────┘

   ALLOCATION ACROSS NODES (rack/zone aware)
   ┌──────────────┬──────────────┬──────────────┐
   │   Node A     │   Node B     │   Node C     │
   │  (Zone 1)    │  (Zone 2)    │  (Zone 3)    │
   ├──────────────┼──────────────┼──────────────┤
   │  P0          │  P1          │  P2          │
   │  R1          │  R2          │  R0          │
   └──────────────┴──────────────┴──────────────┘
   ▲ Primaries and their replicas are NEVER on the same node
   ▲ With shard awareness, replicas land in different zones

   ROUTING:  shard = hash(routing) % num_primary_shards
             routing defaults to _id, can be supplied per-doc
             (e.g., route all of a user's events by user_id)
```

- The number of **primary shards is fixed at index creation time** (later versions can split an index, but you cannot reshuffle arbitrarily without reindexing) — this makes initial shard sizing a decision you live with
- The number of **replicas can be changed at any time** with a single API call, making replicas the primary knob for read throughput and availability

The modulo-over-primes routing design is exactly why the shard count is immutable: changing it would remap every document.

### Replica Placement and Failover

- Replicas are placed on different nodes than their primary (and, with shard awareness, in different racks or zones) by the master's allocation service, which continuously rebalances as nodes join or leave
- When a primary fails, a replica is **promoted**
- When a node recovers, shards recover either from a replica (preferred, since the primary's segments may be stale) and go through a phase of replaying the translog before being marked active
- **Cluster state** — the mapping of which shard lives where — is maintained by an elected master node and gossiped through the cluster; the master does not participate in search or indexing, only in metadata and allocation

### Hot-Warm-Cold-Frozen Tiered Architecture

For data that ages, the tiered architecture, driven by Index Lifecycle Management (ILM), is the standard pattern:

```
   ┌──────────┐   rollover    ┌──────────┐   age/size   ┌──────────┐
   │   HOT    │ ─────────────►│   WARM   │ ────────────►│   COLD   │
   │ fast SSD │               │ SSD      │               │ cheap    │
   │ high CPU │               │ less CPU │               │ disk     │
   │ write-   │               │ read-    │               │ heap-    │
   │ heavy    │               │ heavy    │               │ light    │
   └──────────┘               └──────────┘               └────┬─────┘
                                                                 │
                            ┌──────────┐                          │
                            │  FROZEN  │◄─────────────────────────┘
                            │ searchable│
                            │ snapshots │
                            │ (object   │
                            │  storage) │
                            └─────┬─────┘
                                  │
                                  ▼  ILM delete policy
                              [ DELETED ]
```

- **Hot nodes** (fast SSD, high CPU) hold today's write-heavy indices
- **Warm nodes** (SSD, less CPU) hold recent read-heavy indices
- **Cold and frozen nodes** (cheap disk, heap-light) keep older data searchable, with frozen indices backed by searchable snapshots that page in from object storage on demand
- ILM rolls over an index when it hits a size or age threshold, force-merges it to reduce segment count, moves it down the tiers, and finally deletes it — automating the lifecycle that would otherwise require manual curation

---

## Distributed Search: The Scatter-Gather Protocol

A search request to any node becomes a two-phase scatter-gather across the cluster. The receiving node acts as the **coordinating node**.

```
                    CLIENT
                      │
                      │  POST /products/_search  { "query": ... }
                      ▼
   ┌───────────────────────────────────────────────────────────────┐
   │                  COORDINATING NODE                            │
   │  Determines which shards to consult (1 copy of each primary) │
   └───────────────────────────────────────────────────────────────┘
                      │
   ══════════════════════════════════════════════════════════════════
   PHASE 1 — QUERY (scatter): fan out in parallel to all shards
   ══════════════════════════════════════════════════════════════════
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   ┌─────────┐   ┌─────────┐   ┌─────────┐
   │ Shard 0 │   │ Shard 1 │   │ Shard 2 │
   │ runs    │   │ runs    │   │ runs    │
   │ query   │   │ query   │   │ query   │
   │ locally │   │ locally │   │ locally │
   └────┬────┘   └────┬────┘   └────┬────┘
        │             │             │
        │ returns:    │ returns:    │ returns:
        │ top N doc   │ top N doc   │ top N doc
        │ IDs +       │ IDs +       │ IDs +
        │ scores      │ scores      │ scores
        │ (NOT        │ (NOT        │ (NOT
        │  _source!)  │  _source!)  │  _source!)
        └─────────────┼─────────────┘
                      ▼
   ┌───────────────────────────────────────────────────────────────┐
   │              COORDINATOR MERGES                                │
   │  Per-shard top-N  ──►  global ranked top-N                    │
   └───────────────────────────────────────────────────────────────┘
                      │
   ══════════════════════════════════════════════════════════════════
   PHASE 2 — FETCH (gather): multi-get only the winning documents
   ══════════════════════════════════════════════════════════════════
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   ┌─────────┐   ┌─────────┐   ┌─────────┐
   │ Shard 0 │   │ Shard 1 │   │ Shard 2 │
   │ fetches │   │ fetches │   │ fetches │
   │ _source │   │ _source │   │ _source │
   │ + high- │   │ + high- │   │ + high- │
   │ lighting│   │ lighting│   │ lighting│
   └────┬────┘   └────┬────┘   └────┬────┘
        └─────────────┼─────────────┘
                      ▼
   ┌───────────────────────────────────────────────────────────────┐
   │  FINAL RESULTS  ──►  returned to client                       │
   └───────────────────────────────────────────────────────────────┘
```

In the **query phase** it fans the query out to the target shards in parallel. Each shard runs the query locally against its own segments, computes local scores, and returns to the coordinator the top *N* matching document IDs together with the sort values or scores the coordinator needs to merge them — *not* the full documents. The coordinator merges these per-shard top-N lists into a globally ranked top-N and then, in the **fetch phase**, issues multi-get requests to the specific shards that own the winning documents to retrieve their `_source`, highlighting, and fields. This split is what keeps large result sets cheap: only the final page of documents is actually fetched and shipped to the client.

### Correctness Caveat 1: Shard-Local Statistics

BM25's IDF component depends on document frequency, but in the default `QUERY_THEN_FETCH` mode each shard computes scores using only its own document frequencies. For a term that is evenly distributed across shards this is a fine approximation, but for a rare term concentrated in one shard the local IDF can be wildly off, distorting the relative ranking.

- **`QUERY_THEN_FETCH`** (default) — uses shard-local statistics; fast, slight score distortion for rare terms
- **`DFS_QUERY_THEN_FETCH`** — adds a preliminary round trip to collect global term frequencies and pre-distribute them; fixes the score at the cost of one extra network phase. Rarely worth it on large clusters but is the textbook answer to "why are my scores slightly different than a single-shard index?"

### Correctness Caveat 2: Per-Shard Top-N Cutoff

Because each shard returns only its local top-N, the global top-N can theoretically miss a document that ranks just below a shard's cutoff but would rank globally above a document from another shard.

- Mitigation: size the per-shard `size` generously relative to the requested page
- For `terms` aggregations: set `shard_size` higher than `size` to bound the `doc_count_error_upper_bound` error that terms aggregations report

### Over-Sharding and Fan-Out Cost

Every additional shard multiplies fan-out: a search over an index with 100 shards sends 100 sub-queries even if you want ten results. This is the root reason over-sharding hurts query latency — not just heap overhead, but raw network and per-shard CPU amplification.

- Coordinating nodes, thread pool queues (`search`), and `search.max_buckets` for aggregations are all sized against this fan-out
- A misconfigured `size` (e.g., asking for 10,000 results) forces every shard to return 10,000 candidates, which is both slow and memory-hungry

**Deep pagination:**

- `from + size` is capped (default 10,000) precisely because it scales as O(from) work per shard
- The supported alternative is `search_after`, which uses the sort values of the last returned document as a cursor and is O(1) per page

---

## Relevance Scoring: From TF-IDF to BM25

Relevance scoring answers the question "given that these documents all match the query, which are the best?" The classical answer is TF-IDF: a term's weight in a document is its term frequency (how often it appears) multiplied by its inverse document frequency (how rare it is across the corpus), so a term appearing in every document contributes little while a term appearing in few documents contributes a lot.

Lucene's practical TF-IDF variant used a square-root term frequency to damp raw counts, a `1/sqrt(fieldLength)` norm so that shorter fields get a boost, and a `1 + ln(N/(df+1))` IDF. TF-IDF has two well-known weaknesses:

- Term frequency keeps growing **linearly** with repetition, so a document that repeats a keyword a hundred times scores dramatically higher than one that mentions it ten times (an obvious spam surface)
- Length normalization is **crude**

Elasticsearch switched its default similarity to **BM25** (Okapi BM25) in version 5.0 to address both. BM25 is a probabilistic model whose term-frequency term **saturates**: the score contribution of a term rises steeply at first and then asymptotes, so the hundredth occurrence barely adds anything over the tenth. It also normalizes document length with a tunable parameter rather than a hard inverse square root.

### BM25 vs TF-IDF Comparison

| Feature | TF-IDF (Lucene variant) | BM25 (default since ES 5.0) |
|---------|------------------------|----------------------------|
| Term frequency saturation | None — grows linearly (sqrt damp) | Saturating curve (asymptotes) |
| Spam resistance | Weak — repetition exploits | Strong — 100th occurrence ≈ 10th |
| Length normalization | `1/sqrt(fieldLength)` (crude) | Tunable `b` parameter (0–1) |
| IDF formula | `1 + ln(N/(df+1))` | `ln(1 + (N - df + 0.5)/(df + 0.5))` |
| IDF sign | Can be negative (needs clamping) | Always non-negative, bounded |
| Tunable params | None | `k1` (saturation), `b` (length norm) |
| Default k1 | N/A | 1.2 |
| Default b | N/A | 0.75 |
| Model type | Heuristic | Probabilistic (Okapi) |

### The BM25 Formula

Summed over query terms:

```
   score = IDF(q) ×  (tf × (k1 + 1))
                   ──────────────────────
                   tf + k1 × (1 - b + b × |d|/avgdl)
```

Where:

- `tf` = term frequency in the document
- `|d|` = the document's field length
- `avgdl` = average field length across the corpus
- `k1` = term frequency saturation rate (default 1.2)
- `b` = length normalization strength (default 0.75)
- `IDF(q) = ln(1 + (N - df + 0.5) / (df + 0.5))` — non-negative and bounded, unlike raw TF-IDF's IDF

### Tuning k1 and b

| Param | Default | Effect of Increasing | Effect of Decreasing | When to use |
|-------|---------|-----------------------|----------------------|-------------|
| `k1` | 1.2 | TF keeps mattering longer; repetition is signal | TF saturates faster; less repetition impact | Higher: long docs where repetition = signal. Lower: short docs, keyword-like fields |
| `b` | 0.75 | More penalty for long documents | Less length normalization | `b=0`: ignore length entirely. `b=1`: fully penalize long docs. `b=0.75`: balanced default |

### Beyond the Base Similarity: Boosts and Functions

Relevance is also shaped by query structure and boosts:

- In a `bool` query, `should` clauses add to the score while `must` and `filter` contribute only to matching
- Per-field `boost` and per-query `^` notation tilt weight toward title matches over body matches
- `function_score` and `script_score` let you blend text relevance with business signals — recency, popularity, price, or a learned model's output — so that a fresh, popular document can outrank a slightly better text match

The discipline of relevance tuning is iterative: you assemble a graded query suite, run it against changes, and watch metrics like NDCG. A common mistake is to reach for `function_score` to paper over bad analysis — if stemming or synonyms are wrong, no amount of boosting will fix the recall.

---

## Query DSL: Structuring Complex Searches

Elasticsearch's Query DSL is a JSON language of composable query clauses, and mastering it is mostly about knowing which clauses score and which merely filter.

### Leaf Queries (probe a single field)

| Query | Scores? | Analysis? | Use Case |
|-------|---------|-----------|----------|
| `match` | Yes | Yes (analyzer) | Full-text search on `text` field |
| `match_phrase` | Yes | Yes | Terms in order, configurable slop |
| `term` / `terms` | Yes (but trivial) | No | Exact lookup on `keyword`/numeric |
| `range` | Yes (but trivial) | No | Numeric/date intervals |
| `exists` | No | No | Field present |
| `prefix` / `wildcard` / `regexp` | Yes | No | Pattern matching (performance traps!) |
| `fuzzy` | Yes | Yes | Terms within Levenshtein distance |
| `ids` | Yes (trivial) | No | Match by `_id` |

### Compound Queries

The most important compound query is `bool`, with its four clauses:

| Clause | Matches? | Scores? | Cacheable? | Purpose |
|--------|----------|---------|------------|---------|
| `must` | Yes (AND) | Yes | No | Required match + contributes to score |
| `should` | Optional | Yes | No | Boosts score; required if no `must` (gated by `minimum_should_match`) |
| `must_not` | Excludes | No | Yes | Exclude documents |
| `filter` | Yes (AND) | **No** | **Yes** | Yes/no question — skips scoring, cached in node-level query cache |

**The filter-versus-query distinction is the single most important DSL concept:** a clause in `filter` context is a yes/no question that skips scoring and is cached in the node-level query cache, so anything that doesn't need relevance — status = active, date in range, category in list — belongs in `filter`, not `must`. Putting pure filters in `must` both wastes CPU on scoring and forfeits caching.

### multi_match Strategies

`multi_match` extends `match` across several fields and offers strategies that change semantics:

- **`best_fields`** (default) — takes the best single-field score; suits queries where the whole phrase should match in one field
- **`most_fields`** — sums scores across fields; suits cases where matching more fields is better
- **`cross_fields`** — treats the fields as one big field; appropriate when the query terms are spread across fields like `first_name` + `last_name`
- **`phrase`** / **`phrase_prefix`** — apply phrase semantics across fields

### Other Compound Queries

- `dis_max` (disjunction max) — returns the best-matching clause's score rather than summing; useful when alternative fields are mutually exclusive descriptions of the same thing
- `constant_score` — wraps a filter and returns a fixed score; handy when you want a clause to act as a hard filter but still combine with `should` scoring

### Performance Traps in the DSL

- **Leading-wildcard queries** (`*foo`) — cannot use the term dictionary's sorted order and effectively scan the dictionary, which on large indices is catastrophically slow. Fix: index an `edge_ngram` sub-field for prefix-as-you-type and reserve `wildcard`/`regexp` for constrained, suffix-heavy cases
- **`fuzzy` and `prefix`** — expand to many terms and should be bounded
- **Heavy `script` queries** — run interpreted Painless on every matching document and bypass the query cache; occasionally necessary but should be replaced by indexed fields or runtime fields where possible
- **`from + size` deep pagination** — capped for the scatter-gather reasons above; production paging uses `search_after` or, for cursoring over a stable result set, the Point-in-Time (PIT) API combined with `search_after`

---

## Numeric, Date, and Geo Queries

Numeric and date fields are not stored in the inverted index the same way text is. Since Lucene 6, numeric, date, and geo fields are indexed in **BKD trees** — multidimensional balanced KD-trees that support range and nearest-neighbor queries in logarithmic time without the older "numeric is many precision-step tokens" trick that inflated index size.

This means `range` queries on `long`, `double`, and `date` are genuinely efficient and first-class, not a degenerate case of term enumeration.

- Date fields support a rich date-math syntax (`now-1d/d`, `2026-06-19||-1y/M`) so that rolling-window queries like "last 7 days rounded to the day" can be expressed inline

### Geo Support

Geo support is built on the same multidimensional foundations. A `geo_point` field stores a latitude/longitude pair indexed in a BKD tree (and, for legacy compatibility, optionally as geohashes).

The geo query family includes:

- `geo_distance` — find points within a radius
- `geo_bounding_box` — points within a rectangle
- `geo_polygon` — points within an arbitrary polygon
- `geo_shape` queries — operate on `geo_shape` fields storing full GIS geometries with indexed relation predicates (`intersects`, `within`, `disjoint`, `contains`)

Sorting by distance is supported directly and is common in store-locator and dispatch features.

| Approach | Accuracy | Efficiency | Distance Sort | Use Case |
|----------|----------|------------|---------------|----------|
| `geo_point` (real type) | Precise | Efficient distance/range | Yes | Store locator, dispatch, any real distance |
| `keyword` geohash prefix | Coarse bucketing | Cheap prefix-match | No (lossy) | "Give me everything in this coarse region" |

For anything that needs real distance computation, use `geo_point`; for cheap "give me everything in this coarse region," a geohash prefix on a `keyword` field can be a useful denormalization.

---

## Aggregations: Analytics on Top of Search

Aggregations turn Elasticsearch from a search engine into an analytics engine, and they are the basis of Kibana's dashboards. An aggregation request runs over the result set of the query (or, with careful use, over the whole index) and is organized into **bucket** aggregations, which partition documents into groups, and **metric** aggregations, which compute a value over the documents in a bucket. The two compose, so you can nest average-price-per-category-per-month trees arbitrarily deep.

### Bucket Aggregations

- `terms` — top N values of a field
- `range` and `histogram` — fixed or custom numeric intervals
- `date_histogram` — time bucketing with calendar-aware intervals like `1M` that respect month length
- `filter` / `filters` — explicit query-based buckets
- `composite` — efficient multi-dimensional bucketing for pagination over all buckets

### Metric Aggregations

- `sum`, `avg`, `min`, `max`, `stats`
- `cardinality` — distinct count via HyperLogLog++
- `percentiles` — via T-Digest
- `top_hits` — return actual documents per bucket (e.g., the best-selling product in each category)

### Pipeline Aggregations

Pipeline aggregations like `cumulative_sum` or `derivative` then operate on the output of other aggregations.

### What Backs Aggregations

All of this is backed by **doc values**, which is why doc values are enabled by default for non-text fields: aggregations read them from disk via the OS page cache without loading the inverted index into heap.

- For `text` fields, doc values are off and aggregations are **not directly supported** — you aggregate on the `keyword` sub-field instead, or pay the cost of enabling `fielddata`, which loads term ordinals into heap and is gated by a circuit breaker for good reason

### Two Aggregation Pitfalls

**1. `terms` aggregations are approximate on large shard counts** — each shard returns only its top `shard_size` terms; the coordinator merges these and reports `doc_count_error_upper_bound`. For low-cardinality-but-high-skew fields you must raise `shard_size` or the reported counts can be meaningfully wrong.

**2. `cardinality` is probabilistic** — with a `precision_threshold` (default 3000) trading memory for accuracy:

- At thresholds above a few tens of thousands the error is small but the memory cost is real
- Users who expect exact distinct counts are surprised by the ~1% error
- For exact counts you need a transform or a count on a `keyword` field with a sufficiently high `shard_size`, which is expensive

### Aggregation Execution Model

The execution model for aggregations mirrors search scatter-gather: each shard computes its partial aggregation, the coordinator reduces them, and the result is returned alongside (or instead of) the hits.

- Aggregations over the full index with no query are **expensive** because they touch every shard and every doc value
- `search.max_buckets` guards against runaway cardinality
- For repeated analytics, the **transform** feature or **rollup** indices precompute common aggregations into a smaller, query-friendly index

---

## Near-Real-Time Search and the Refresh Interval

Elasticsearch is *near*-real-time, not real-time: by default a document is not visible to search until one second after it is indexed. The mechanism is the **refresh**.

```
   INDEXING → REFRESH → FLUSH LIFECYCLE
   ────────────────────────────────────

   Document arrives
       │
       ▼
   ┌──────────────────────────────────────────────┐
   │  IN-MEMORY INDEXING BUFFER + TRANSLOG       │
   │  (translog = append-only durability log)     │
   └──────────────────┬───────────────────────────┘
                      │
                REFRESH (default every 1s)
                (no fsync — stays in OS page cache)
                      ▼
   ┌──────────────────────────────────────────────┐
   │  NEW IN-MEMORY SEGMENT (immediately          │
   │  searchable, but NOT fsync'd to disk)        │
   └──────────────────┬───────────────────────────┘
                      │
                FLUSH (heavier — periodic)
                (fsync + clear translog + commit point)
                      ▼
   ┌──────────────────────────────────────────────┐
   │  SEGMENTS ON DISK (survives hard crash)      │
   │  Background tiered merge compacts segments   │
   └──────────────────────────────────────────────┘

   KEY POINTS:
   • Durable (in translog) the moment index() returns
   • Searchable only after refresh opens a new segment
   • Only flushed data survives a hard crash
   • Translog is fsync'd on its own schedule
```

### Key Operations

- **Refresh** — takes the in-memory buffer and writes it out as a new in-memory Lucene segment that is immediately searchable — *without* an `fsync`, so it lives in the OS page cache and is fast
- **Flush** — the heavier operation that `fsync`s the segments to disk, clears the translog, and writes a new commit point; only flushed data survives a hard crash, which is why the translog is periodically `fsync`'d on its own schedule (configurable per index)
- **Segment merging** (background) — compacts the steady stream of small refresh-produced segments into fewer larger ones, reclaiming deleted documents and reducing per-query file count; the tiered merge policy balances merge I/O against segment count

### The Refresh Interval: Central Tuning Knob

The **refresh interval** is the central tuning knob of the indexing/search tradeoff.

| Workload | `refresh_interval` | Replicas | Rationale |
|----------|-------------------|----------|-----------|
| Interactive (default) | `1s` | 1+ | Sub-second search latency for new docs |
| Interactive, freshness-critical | `500ms` or `true`-on-write | 1+ | Faster freshness, accept segment churn |
| Bulk ingestion | `30s` or `-1` (disabled) | `0` during load, restore after | Avoid torrent of tiny segments; halve CPU/I/O |

### Tuning Parameters for Indexing

- `indices.memory.index_buffer_size` (default 10% of heap, shared across shards) — controls how much indexing can buffer before a refresh is forced
- `index.translog.flush_threshold_size` (default 512MB) — controls when a flush is triggered
- Both interact with refresh to determine the steady-state segment profile

### Bulk-Loading Recipe (Standard)

- Set `refresh_interval` to `30s` or `-1` (disabled)
- Reduce replicas to `0` during the load
- Load using the Bulk API
- Restore `refresh_interval` and replicas afterward
- Gains are often an order of magnitude

### Force Merge for Read-Only Indices

For read-only indices, a **force merge** to a single segment:

- Maximizes search performance
- Reduces heap usage (fewer segment-level structures, no deleted-doc bitsets)
- Is a routine step after an ILM rollover moves an index to warm

---

## Bulk Indexing: High-Throughput Writes

The **Bulk API** is the only correct way to load large volumes into Elasticsearch; single-document indexing at scale is dominated by HTTP and per-request overhead. A bulk request is a newline-delimited JSON stream pairing an action line with an optional data line — `index`, `create`, `update`, or `delete` — so that one HTTP request can carry thousands of operations.

### Indexing Path Per Operation

```
   BULK REQUEST (newline-delimited JSON)
       │
       ▼
   ┌──────────────────────────────────────────────┐
   │  COORDINATING NODE: parse + route            │
   └──────────────────┬───────────────────────────┘
                      │  hash(routing) % num_primaries
                      ▼
   ┌──────────────────────────────────────────────┐
   │  PRIMARY SHARD                                │
   │  1. Append to translog                        │
   │  2. Add to indexing buffer                    │
   │  3. Async replicate to replica shards         │
   └──────────────────┬───────────────────────────┘
                      │
                      ▼
   ┌──────────────────────────────────────────────┐
   │  REPLICA SHARD(S)                             │
   │  Append to their translogs + indexing buffers │
   └──────────────────┬───────────────────────────┘
                      │
                      ▼
   ┌──────────────────────────────────────────────┐
   │  ACK to coordinator when required number of   │
   │  shards have confirmed (write consistency:    │
   │  quorum / wait_for_active_shards)             │
   └──────────────────────────────────────────────┘
```

### Throughput Tuning Parameters

- **Ideal bulk request size:** 5–15 MB — small enough to distribute load across shards and avoid overloading a single coordinating node's heap, large enough to amortize per-request overhead
- **Parallelism:** multiple concurrent bulk workers (often driven by a queue) keep all primary shards busy, but too much concurrency saturates thread pools and fills the `write` queue, at which point nodes return 429 (`EsRejectedExecutionException`) and the client must back off and retry
- **Replication factor:** directly multiplies write work — every replica does the same indexing work as the primary — so the bulk-load recipe of `replicas: 0` then re-add is not just about refresh churn but about halving the CPU and disk I/O during the load

### Other Levers

- Disable `_source` reprocessing with `update` (prefer `index` with the full doc over `update` scripts where possible)
- Pre-create the index with explicit mapping to avoid dynamic-mapping overhead
- Use the **Reindex API** or `update_by_query` for in-cluster moves with throttling (`requests_per_second`)
- For very high sustained ingestion: use a buffering layer (Kafka) feeding a bulk consumer that batches and retries, decoupling producer rate from cluster capacity

---

## Capacity Planning and Operational Sizing

Capacity planning for Elasticsearch is dominated by the interaction of shard count, shard size, and JVM heap, and most production incidents trace back to violating these guidelines.

### Shard Sizing Rules

| Guideline | Target | Too Small | Too Large |
|-----------|--------|-----------|-----------|
| Data per shard | 10–50 GB | < few GB: wasted overhead (fixed Lucene + cluster-state cost per shard) | > 50 GB: slow, fragile recovery; hard to rebalance |
| Shards per GB of heap | ~20 (upper bound) | — | Exceeding: heap pressure from segment metadata, cluster-state bloat |
| Shards per node (30 GB heap) | ~a few hundred | — | Thousands: slow master elections, recoveries, constant GC |

The classic **over-sharding** failure mode: an operator creates daily indices with 30 primaries across a small cluster and accumulates tens of thousands of shards, at which point cluster-state updates, master elections, and recoveries all slow to a crawl and heap pressure triggers constant GC.

### Node Sizing Rules

- **Heap should be 50% of available RAM, capped at the compressed-oops threshold of ~31 GB** — leaving the other 50% for the OS filesystem cache
- Lucene is designed around the assumption that hot segments live in the OS page cache, so a node with a huge heap and no free RAM for caching will paradoxically search slower than one with a smaller heap and more cache
- **Storage:** SSDs for hot and warm tiers (HDDs are acceptable only for cold/frozen); IOPS matter because merges, recoveries, and large aggregations are I/O-bound
- **Thread pools** (`write`, `search`, `get`) have bounded queues and reject work when full — monitoring rejections is essential
- **Circuit breakers** — `fielddata`, `parent` (request), and `in-flight requests` — protect the JVM from OOM by aborting queries that would load too much into heap; tripping them is a sign of a query that needs restructuring (e.g., aggregating on a `text` field without `fielddata` planning) rather than a cluster that needs more memory

### Cluster-Level Planning

- Choose the number of data nodes to keep per-node shard count and disk usage within bounds while providing enough CPU for the expected query and indexing load
- Size the master nodes: **dedicated, 3 for quorum, low CPU but enough to hold cluster state** to avoid split brain
- Use **cross-cluster replication** or search for multi-region or disaster-recovery setups
- ILM ties this together by rolling indices over at a target size, moving them through tiers, and deleting them — which is what keeps a logging cluster from growing itself to death

### The Recurring Lesson

Elasticsearch punishes over-provisioning of one resource at the expense of another:

| Over-provisioning | Consequence |
|-------------------|-------------|
| Too many shards | Ruins heap |
| Too-large shards | Ruins recovery |
| Too little cache | Ruins search |
| Too few replicas | Ruins availability |

The art is in balancing them against the workload's actual read/write/analytics mix.

---

## Interview Deep Dive

**Question:** *You index a document and immediately search for it, but it doesn't appear. A second later it does. Your teammate says Elasticsearch is "inconsistent." Is that right, and what is actually happening — and how would you make a document visible to search the instant it's written without wrecking indexing throughput?*

**Model answer:** It is not a consistency bug; it is the near-real-time refresh model. A document is durable (it is in the translog) the moment the index call returns, but it is not *searchable* until a refresh opens a new Lucene segment containing it, which by default happens every 1 second. So the document was safely written — a crash and translog replay would recover it — it just wasn't in any *open, searchable segment* yet.

To make a specific write visible immediately:

- Call the index API with `refresh=true`, which forces a refresh of the affected shards before returning
- For testing, `?refresh=wait_for` blocks until the next natural refresh

**The trap:** `refresh=true` on every document defeats the batching that makes refresh cheap: you create one tiny segment per write, starving the merger and exploding segment count.

**The production pattern:**

- Keep `refresh_interval` at a tuned value (1s for interactive, tens of seconds for bulk)
- Only force-refresh for the rare case that truly needs instant visibility
- Or accept that search-visible-after-1-second is a feature, not a bug, and design the application around it

**Common pitfall — Over-sharding by default:** Creating a daily index with `number_of_shards: 10` for a workload that ingests a few hundred MB per day sounds prudent ("more shards = more parallelism"), but after a year you have 3,650 shards, most of them a few megabytes each, each carrying fixed Lucene and cluster-state overhead and each adding a fan-out sub-query to every search.

The cost shows up as:

- Slow master elections
- Bloated cluster state
- Heap pressure from segment metadata
- Per-query latency proportional to shard count even when the data is tiny

**The fix:**

- Size shards to the 10–50 GB target — for a small daily volume, that means far fewer primaries, or rolling over by size rather than by day, or using ILM to merge old small indices
- Remember that the number of primaries is *immutable* once set, so undersizing shards at index creation is an error you can only fix by reindexing

## Interview Cheat Sheet

**Key Points to Remember:**
- Elasticsearch is built on Lucene's immutable, segment-based inverted index. Documents are not searchable until a refresh opens a new segment (default 1s) — this is a feature, not a bug, and the root cause of most "I wrote it but can't find it" confusion.
- The inverted index answers "which documents contain this term"; doc values (columnar store) answer "what is this field's value for this document" — and back all sorting and aggregations. Map human-readable fields as both `text` (search) and `keyword` (aggregate/sort).
- Use `filter` context (not `must`) for yes/no predicates — filters skip scoring and are cached, while putting pure filters in `must` wastes CPU and forfeits caching. This is the single most important Query DSL concept.
- Primary shard count is immutable at index creation; over-sharding (too many tiny shards) is the #1 production failure mode — size shards to 10–50 GB and keep ~20 shards per GB of heap. Use ILM tiering (hot-warm-cold-frozen) for time-series data.
- BM25 (default since ES 5.0) saturates term frequency so keyword repetition doesn't game ranking, unlike linear TF-IDF. Tune `k1` (saturation) and `b` (length normalization) only with a graded query suite and NDCG metrics.

**Common Follow-Up Questions:**
- **"I index a document and search immediately but can't find it — is Elasticsearch inconsistent?"** — No, it's near-real-time by design: the document is durable in the translog immediately but not searchable until the next refresh opens a new segment (default 1s). Use `refresh=true` for instant visibility, but never in bulk — it creates one tiny segment per write and starves the merger.
- **"How do you scale Elasticsearch for a logging workload ingesting 1TB/day?"** — Use ILM with time-based indices, size shards to 10–50 GB, set replicas to 0 during bulk loads with disabled refresh, use the Bulk API at 5–15 MB per request, and tier storage (hot SSD → warm → cold disk → frozen searchable snapshots).
- **"Why are my search scores slightly different than expected?"** — The default `QUERY_THEN_FETCH` uses shard-local document frequencies for BM25's IDF, which distorts scores for rare terms concentrated in one shard. Use `DFS_QUERY_THEN_FETCH` for global term frequencies at the cost of one extra round trip.

**Gotcha:**
- Over-sharding by default: creating daily indices with many primary shards for a low-volume workload accumulates thousands of tiny shards, each carrying fixed Lucene and cluster-state overhead and each adding a fan-out sub-query to every search. The number of primary shards is immutable once set, so undersizing is an error you can only fix by reindexing — always size shards to the 10–50 GB target from the start.
