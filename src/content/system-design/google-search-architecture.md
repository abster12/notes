---
title: "Google Search Architecture"
type: system-design
category: Deep Dive
date: 2026-05-27
tags: [system-design, interview, google, search, web-crawling, inverted-index, pagerank, mapreduce, caffeine, serving-tree]
aliases: [Web Search Engine, Large-Scale Search]
---

# Google Search Architecture

## Summary & Interview Framing

The system that crawls the web, builds an inverted index of hundreds of billions of pages, and serves ranked results in under 200ms for 8.5B queries/day.

**How it's asked:** "Design a search engine that crawls 100B pages, builds an inverted index, and serves results in <200ms. Cover crawling, indexing, ranking, and sharding strategy."

---

## Overview

Google Search is arguably the most complex distributed system ever built. It crawls the entire web — hundreds of billions of pages across trillions of URLs — builds a searchable inverted index, and serves ranked results in under 200ms per query. The architecture spans three massive subsystems: **Crawling** (ingesting the web), **Indexing** (structuring that data for fast retrieval), and **Serving** (answering user queries at planetary scale). Each subsystem is itself a distributed system with thousands of machines.

What makes this a classic system design interview topic: it touches nearly every distributed systems concept — MapReduce, sharding, replication, caching, eventual consistency, consensus, tiered storage, batch vs. streaming, and machine learning at scale — all tied together by a product everyone uses daily.

## Key Requirements

### Functional

- Accept a text query; return a ranked list of relevant URLs with snippets
- Crawl new and updated pages continuously; re-crawl at appropriate cadences
- Handle image, video, news, map, and shopping searches (multi-corpus)
- Support spelling corrections, autocomplete, and query understanding (NLU)
- Show knowledge panels (structured facts) and direct answers
- Serve ads alongside organic results without degrading search latency

### Non-Functional

| Requirement | Target |
|---|---|
| **Query latency** | < 200ms p99 (user-perceived as "instant") |
| **Index freshness** | Minutes-to-hours for news; days for static content |
| **Scale** | Hundreds of billions of pages; trillions of URLs |
| **Availability** | 99.99%+ — search must "never" be down |
| **Relevance** | Results quality is existential; measured via human raters + A/B experiments |
| **Throughput** | ~8.5 billion searches/day (~100K QPS at steady state; peaks higher) |

## Capacity Estimates

| Metric | Estimate |
|---|---|
| Pages indexed | 100–200 billion+ |
| Unique URLs known | 50+ trillion |
| Size of raw crawl data | 100+ PB |
| Size of inverted index (compressed) | ~10–20 PB |
| Queries per second (peak) | ~150,000+ |
| Crawlers fetching pages/sec | Millions |
| Average page size | ~500 KB (modern web; compressed to ~50 KB) |
| Machines in serving fleet | Tens of thousands |

## Core Design

### The Three Pillars

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│ CRAWLING │────▶│ INDEXING │────▶│ SERVING  │
│          │     │          │     │          │
│ Fetch    │     │ Parse    │     │ Accept   │
│ Parse    │     │ Build    │     │ Rewrite  │
│ Store    │     │ Invert   │     │ Retrieve │
│ Enqueue  │     │ Shard    │     │ Rank     │
└──────────┘     └──────────┘     └──────────┘
```

---

## 1. Crawling (Ingestion)

The crawler's job is to download every page on the web, extract links, and feed the indexer — all without overwhelming any single website.

### URL Frontier
A priority queue of URLs to crawl. This is a large-scale distributed priority queue where:

- **Politeness:** Only one connection per host at a time; respect `robots.txt` and `Crawl-Delay`
- **Priority:** High-value pages (news, frequently updated) crawled more often than static pages
- **Freshness:** Re-crawl interval proportional to historical change rate of the page
- **Deduplication:** URL canonicalization (trailing slash, `www`, protocol) + content fingerprinting (SimHash) to avoid re-crawling duplicates

### Crawler Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌────────────┐
│ URL Frontier  │────▶│  DNS Resolver    │────▶│   Fetch    │
│ (priority Q)  │     │  (cache + batch) │     │  (HTTP/S)  │
└──────────────┘     └──────────────────┘     └─────┬──────┘
                                                    │
                    ┌──────────────────┐            │
                    │  Link Extractor  │◀───────────┘
                    │  (new URLs)      │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │  Content Store   │──▶ Indexer
                    │  (GFS/Colossus)  │
                    └──────────────────┘
```

**Key design decisions:**

- **DNS caching:** A single crawl of a billion pages without DNS caching would DoS the DNS infrastructure. Google runs its own DNS resolution layer with massive caches.
- **Robots.txt cache:** Must respect per-host rules; cached aggressively.
- **Duplicate detection:** SimHash (locality-sensitive hashing) to detect near-duplicate content — ~30% of the web is duplicate.
- **Content store:** Raw HTML stored in Colossus (Google's successor to GFS). Crawl-first, index-later architecture: crawl is decoupled from indexing.

---

## 2. Indexing (Structuring)

The indexer transforms raw HTML into a searchable **inverted index**.

### Document Processing Pipeline

```
Raw HTML
   │
   ▼
┌──────────┐    ┌─────────────┐    ┌──────────────┐    ┌──────────┐
│  Parse   │───▶│  Tokenize   │───▶│  Normalize   │───▶│  Annotate │
│  (strip  │    │  (words,    │    │  (stemming,  │    │  (NER,    │
│   tags)  │    │   n-grams)  │    │   case-fold) │    │   links)  │
└──────────┘    └─────────────┘    └──────────────┘    └──────────┘
                                                            │
                                                            ▼
                                                     ┌──────────────┐
                                                     │  Build       │
                                                     │  Forward     │
                                                     │  Index       │
                                                     └──────┬───────┘
                                                            │
                                                            ▼
                                                     ┌──────────────┐
                                                     │  Invert      │
                                                     │  (sort/shuf) │
                                                     └──────┬───────┘
                                                            │
                                                            ▼
                                                     ┌──────────────┐
                                                     │  Inverted    │
                                                     │  Index       │
                                                     │  (sharded)   │
                                                     └──────────────┘
```

### The Inverted Index

The heart of any search engine. Maps **term → list of (docID, positions, metadata)**.

```
Term: "distributed"
├── docID: 17 → [positions: 4, 52, 108], [title: true, bold: false]
├── docID: 42 → [positions: 7, 89], [title: true, bold: true]
├── docID: 991 → [positions: 12], [title: false, bold: false]

Term: "systems"
├── docID: 17 → [positions: 5, 53, 109], [title: true]
├── docID: 3 → [positions: 90], [title: false]
...
```

**Optimizations:**

- **Delta encoding:** Store differences between docIDs, not absolute IDs (saves ~80% space)
- **Skip lists:** Within each posting list, skip pointers let the engine jump over irrelevant ranges
- **Tiered index:** Fresh (in-memory, recent crawls) + Base (on-disk, bulk of the index). Merged periodically. This is Google's **Caffeine** architecture — continuous indexing instead of batch.
- **Positional data:** Stores word positions to support phrase queries ("distributed systems" must appear consecutively)
- **Impact-sorted order:** Store posting lists sorted by PageRank, not docID — allows early termination for top-K queries

### Sharding

The index is too large for one machine. Two strategies:

| Strategy | How it works | Trade-off |
|---|---|---|
| **Document sharding** | Each shard holds all terms for a subset of docs | Query goes to ALL shards; fan-out = # shards |
| **Term sharding** | Each shard holds all docs for a subset of terms | Multi-term queries fan out to multiple shards |

In practice, Google uses a **hybrid**: replicas of index partitions. Each partition handles a slice of docs. Queries fan out to all partitions. Partitions are replicated for load and fault tolerance.

---

## 3. Serving (Query-Time)

This is where the 200ms SLA lives. Every millisecond counts.

### Query Flow

```
User query: "distributed systems design"
        │
        ▼
┌──────────────────────┐
│   Query Rewriting    │  Spelling correction, synonym expansion,
│   (spell, synonyms,  │  query relaxation, stop-word removal,
│    NLP, entity rec)  │  intent classification (informational/navigational/transactional)
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Retrieval          │  Hit ALL index shards in parallel.
│   (scatter-gather)   │  Each returns top-K candidates using
│                      │  early termination on impact-sorted postings.
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Scoring / Ranking  │  Hundreds of signals:
│                      │  - PageRank (static, query-independent)
│                      │  - BM25 / TF-IDF (term frequency)
│                      │  - Proximity (terms close together)
│                      │  - Freshness (recency bias for news queries)
│                      │  - Click-through rate (CTR) history
│                      │  - Personalization (location, history)
│                      │  - ML model (RankBrain, BERT, MUM)
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Blending           │  Merge organic results with:
│                      │  - Knowledge Graph panels
│                      │  - Ads (separate auction + serving path)
│                      │  - Images / Videos / News carousels
│                      │  - "People also ask" / featured snippets
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Result Assembly    │  Snippet generation, URL display,
│                      │  caching headers, logging
└──────────────────────┘
```

### Serving Tree

Google organizes its serving fleet as a **tree**:

```
         ┌──────────────┐
         │  Root /      │   Accepts query, fans out to leaves
         │  Aggregator  │
         └──────┬───────┘
      ┌─────────┼─────────┐
      ▼         ▼         ▼
   Leaf      Leaf      Leaf      Each leaf: holds one replica
   Server    Server    Server    of one index partition

Each leaf:
  - Loads its index partition into RAM (SSD for overflow)
  - Runs retrieval + scoring on its slice
  - Returns top-K results to root
Root:
  - Merges results from all leaves
  - Applies final re-ranking (costlier features on fewer candidates)
  - Returns top results to user
```

**Why a tree?** A single-level fan-out to thousands of leaf servers would overwhelm the root with network and merge overhead. Two-level tree: root fans to ~1000 intermediate aggregators, each fans to ~10-30 leaf servers. This bounds fan-in at each level.

### Caching at Every Layer

| Cache | What | Hit Rate |
|---|---|---|
| **Browser/DNS** | DNS resolution, static assets | 50-80% |
| **Edge/CDN** | Google.com homepage, cached snippets | Low for unique queries |
| **Query Result Cache** | Full results for repeated queries | ~30-50% (head queries dominate) |
| **Posting List Cache** | Frequently accessed posting lists | 60-80% |
| **Document Cache** | Recently crawled docs | Medium |

**Key insight:** The query distribution is heavily skewed — 25% of queries are brand new every day (long tail), but the head queries ("facebook", "weather") are hit millions of times. Result caching the head queries saves enormous compute.

---

## Key Concepts for Interview

### 1. PageRank (Static Ranking)

PageRank is query-independent — it's computed offline during indexing and stored with each document. The intuition: **a page is important if important pages link to it.**

$$PR(A) = \frac{1-d}{N} + d \sum_{p \in \text{inlinks}(A)} \frac{PR(p)}{\text{outlinks}(p)}$$

Where $d \approx 0.85$ is the damping factor. Computed iteratively using MapReduce across the entire web graph (link structure). This runs on a batch cycle (days), not per-query.

**Modern evolution:** PageRank is now one of hundreds of signals. Google uses ML models (RankBrain, BERT, MUM) that learn ranking from user behavior.

### 2. Caffeine (Continuous Indexing)

Pre-2010: Google rebuilt the index in batch cycles (every few weeks). Problem: stale results for rapidly changing content.

Caffeine (2010): **Incremental, continuous indexing.** New/changed pages enter a "fresh" index immediately. A background merger periodically merges fresh → base index. This is essentially an **LSM-tree** (Log-Structured Merge Tree) applied to web search — the same data structure underlying LevelDB/RocksDB.

### 3. Query Understanding (NLP)

Modern search is not keyword matching — it's intent understanding:

- **Spelling correction:** "distributd systms" → "distributed systems" (noisy-channel model + user click data)
- **Synonym expansion:** "automobile" ↔ "car" (learned from co-click patterns)
- **Entity recognition:** "jobs" → Steve Jobs (person) or job listings (intent classification)
- **BERT (2019):** Bi-directional transformers that understand context — "2019 brazil traveler to usa need a visa" understands the directionality (Brazilian traveling to US)
- **MUM (2021):** Multimodal, multilingual — can reason across text + images

### 4. Freshness vs. Relevance Trade-off

A constant tension: should we show the most relevant result or the most recent? Google resolves this with **query-intent classification**:

| Query signal | Bias |
|---|---|
| "election results" | Freshness-heavy |
| "python sort list" | Relevance-heavy (tutorials don't age) |
| Recency keywords ("today", "now") | Freshness |
| Click-through on recent results | Self-reinforcing freshness |

---

## Interview Question Pattern

**Common opener:** "Design a web search engine like Google."

**What the interviewer is listening for:**

1. Do you break it into crawling / indexing / serving? (structure)
2. Do you mention the **inverted index** as the core data structure?
3. Can you estimate scale? (100B+ pages, <200ms latency)
4. Do you discuss the **serving tree** and **fan-out** problem?
5. Can you articulate **caching layers** and which queries benefit?
6. Bonus: PageRank as query-independent static ranking vs. dynamic scoring
7. Bonus: Freshness vs. relevance trade-off, Caffeine/incremental indexing

**Common pitfalls:**

- ❌ Trying to scan all documents per query (you need the inverted index!)
- ❌ Focusing only on crawling and forgetting the serving latency SLA
- ❌ Assuming single-machine design — this must be partitioned
- ❌ Forgetting duplicate detection (30%+ of the web is duplicate content)
- ❌ Ignoring politeness in crawling (you'll get blocked by every website)
- ❌ Mixing up real-time vs. batch: PageRank is batch; query scoring is real-time

---

## System Diagram Summary

```
                           ┌──────────────────┐
                           │   Google.com      │
                           │   (UI + CDN)      │
                           └────────┬─────────┘
                                    │ query
                                    ▼
┌──────────────────────────────────────────────────────┐
│                   SERVING TIER                        │
│  ┌─────────┐   ┌──────────┐   ┌───────────────────┐ │
│  │ Query   │──▶│  Root    │──▶│  Leaf Servers     │ │
│  │ Rewrite │   │  Aggreg. │   │  (index shards    │ │
│  │ (NLP)   │   │          │   │   in RAM)         │ │
│  └─────────┘   └──────────┘   └───────────────────┘ │
└──────────────────────────────────────────────────────┘
                          ▲
                          │ index updates
                          │
┌──────────────────────────────────────────────────────┐
│                   INDEXING TIER                       │
│  ┌──────────┐   ┌──────────┐   ┌──────────────────┐ │
│  │Document  │──▶│Inverted  │──▶│ Index Shards     │ │
│  │Processor │   │Index     │   │ (GFS/Colossus)   │ │
│  │(MapReduce)│  │Build     │   │                  │ │
│  └──────────┘   └──────────┘   └──────────────────┘ │
└──────────────────────────────────────────────────────┘
                          ▲
                          │ raw HTML
                          │
┌──────────────────────────────────────────────────────┐
│                   CRAWLING TIER                       │
│  ┌──────────┐   ┌──────────┐   ┌──────────────────┐ │
│  │URL       │──▶│Fetcher   │──▶│ Content Store    │ │
│  │Frontier  │   │(polite)  │   │ + Link Extract   │ │
│  └──────────┘   └──────────┘   └──────────────────┘ │
└──────────────────────────────────────────────────────┘
```

## References

- Brin & Page, "The Anatomy of a Large-Scale Hypertextual Web Search Engine" (1998) — the original paper
- Google Caffeine (2010) — continuous indexing architecture
- "MapReduce: Simplified Data Processing on Large Clusters" (2004) — the indexing pipeline
- GFS (2003), Bigtable (2006), Spanner (2012), Colossus — storage evolution

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Three-stage pipeline: crawl the web → build an inverted index → rank and serve results
- Inverted index maps each term to the list of documents containing it — the core data structure of all search engines
- PageRank uses link structure as a vote of quality, but modern ranking uses hundreds of signals (freshness, location, personalization)
- Sharding by document range, with each shard having its own index and serving nodes
- Google's scale: ~100B pages indexed, 8.5B queries/day, <200ms response time

**Common Follow-Up Questions:**
- "How do you handle updates to web pages?" — Recrawl on a schedule (popular pages more frequently), update the index incrementally. The index is not rebuilt from scratch.
- "How does personalization affect ranking?" — Same query returns different results based on location, search history, and device. Adds a per-user context layer on top of the base ranker.

**Gotcha:**
- Candidates often focus on PageRank and forget that modern Google ranking is dominated by machine-learned models. PageRank is still a signal but it's one of hundreds. The real engineering challenge is the serving architecture, not the ranking algorithm.
