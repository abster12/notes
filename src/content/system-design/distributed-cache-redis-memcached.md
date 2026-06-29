---
title: "Distributed Cache (Redis/Memcached)"
type: system-design
category: Basics
date: 2026-04-26
last_updated: "2026-06-19"
tags: [system-design, interview, basics, caching, redis, memcached, eviction, persistence, pubsub]
difficulty: intermediate
read_time: 34
listen_time: 48
---

# Distributed Cache (Redis/Memcached)

A distributed cache is a layer of in-memory storage positioned between an application and its backing database, and its purpose is to absorb the read traffic that would otherwise be served from disk-backed storage. The justification is mechanical, not stylistic: a memory read completes in roughly 100 nanoseconds, a flash SSD read in 50–150 microseconds, and a network round-trip to a primary database in 1–10 milliseconds. A cache collapses that stack by two to five orders of magnitude, and at scale the compounding effect is that a single Redis node can serve 100,000 to 1 million operations per second while a primary database instance of comparable cost might handle 5,000–20,000 queries per second before its connection pool saturates.

The cache is therefore the single highest-leverage optimization in most production systems, but it is also the layer where staleness, consistency, and failure-mode reasoning become most subtle, because the cache is by definition a derivative copy of data whose authority lives elsewhere. Designing a cache well is less about choosing Redis over Memcached and more about making deliberate decisions about population strategy, [[Glossary#Eviction Policy|eviction policy]], consistency guarantees, failure behavior, and capacity — each of which has a correct answer only in the context of a specific read-write pattern.

## Summary & Interview Framing

An in-memory key-value store shared across application instances, absorbing 90%+ of read traffic before it hits the database. Redis and Memcached are the primary implementations, offering 100K-1M ops/sec per node with sub-millisecond latency through population strategies, eviction policies, and failure-mode handling.

**How it's asked:** "Design a distributed cache layer using Redis for a system with 1M QPS, 95% hit rate, and <5ms p99 latency. Handle cache penetration, avalanche, stampede, and eviction policies."

## Why Cache: The Three Forces

Three forces drive caching decisions and it is worth naming them explicitly because they pull in different directions:

- **[[Glossary#Latency|Latency]]** — users perceive interactions below 100ms as instant and above 1 second as sluggish, and for many read-heavy workloads the database is the bottleneck on that budget.
- **[[Glossary#Throughput|Throughput]]** — a cache absorbs repeated reads so the database can spend its limited connection slots and IOPS on writes and cold reads, which means the cache is effectively a load-shedding mechanism as much as a latency mechanism.
- **Cost** — hot data served from memory costs less per query than the same data served from a provisioned database, because database pricing scales with storage, compute, and IOPS while cache pricing scales primarily with memory.

The tension between these forces is that maximizing hit rate (cost, throughput) pushes you toward long TTLs and aggressive caching, while minimizing staleness (correctness) pushes you toward short TTLs and conservative caching. Every caching decision is a point on that spectrum, and the engineer's job is to pick the point deliberately for each data class rather than applying one global policy.

## Cache Population Patterns

The four canonical cache population patterns — cache-aside, read-through, write-through, and write-behind — differ in who is responsible for populating the cache, when population happens relative to reads and writes, and what consistency and failure trade-offs result. Choosing among them is the first architectural decision and it should be driven by the read-write ratio, the staleness tolerance, and the write-latency sensitivity of the workload.

### Pattern Comparison at a Glance

| Pattern | Who populates cache | Write latency | Consistency | Cache in critical path? | Best for |
|---|---|---|---|---|---|
| **Cache-Aside** | Application (on miss) | Low (DB only) | Eventual; TTL-bounded | No (cache failure → slow, not broken) | General default; fault-tolerant reads |
| **Read-Through** | Cache layer (loader callback) | Low (DB only) | Eventual; TTL-bounded | No | Many read paths; single gateway to DB |
| **Write-Through** | Cache (sync write to DB) | High (~2x: cache + DB) | Strong (no stale window) | Yes (cache down → writes fail) | Config, flags, session, write-then-read |
| **Write-Behind** | Cache (async batch flush) | Lowest (cache only) | Weakest (data loss on crash) | Yes (cache is sole authority) | Telemetry, counters; not transactional |

### Read/Write Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      CACHE POPULATION PATTERNS                              │
└─────────────────────────────────────────────────────────────────────────────┘

CACHE-ASIDE  (lazy loading — application owns the cache)
  App            Cache          DB
   │── get(k) ───▶│              │
   │              │ (MISS)       │
   │── get(k) ──────────────────▶│
   │◀──── value ─────────────────│
   │── set(k,v)─▶│               │
   │◀── value ───│               │
  WRITE path:  update DB ──▶ DEL cache   (never SET on write — race risk)

READ-THROUGH  (cache layer owns the loader)
  App            Cache          DB
   │── get(k) ───▶│              │
   │              │ (MISS)       │
   │              │── loader() ─▶│
   │              │◀── value ───│
   │              │── set(k,v) ▶│  (internal)
   │◀── value ────│              │
  App never talks to DB for cached reads; miss logic in one place.

WRITE-THROUGH  (synchronous double write)
  App            Cache          DB
   │── set(k,v)─▶│              │
   │             │── set(k,v) ─▶│   (synchronous)
   │◀── ok ──────│◀── ok ───────│
  Returns only after BOTH writes succeed → no stale-read window.

WRITE-BEHIND / WRITE-BACK  (async batch flush)
  App            Cache          DB
   │── set(k,v)─▶│              │
   │◀── ok ──────│              │   (returns immediately)
   │             │  ··· batch ···│
   │             │── flush ────▶│   (timer / count / pressure)
  Lowest write latency; BUT cache crash before flush = permanent loss.
  Reads must always prefer the cache (DB may be stale until flush).
```

### Cache-Aside (Lazy Loading)

Cache-aside is the most common pattern because it is the simplest to reason about and the most fault-tolerant. The application code explicitly manages the cache: on a read, it checks the cache first, and only on a miss does it query the database and then backfill the cache with a TTL. On a write, it updates the database and then deletes the cache entry — not updates it, deletes it — so the next read is forced to reload fresh data.

The elegance of cache-aside is that the cache is purely an optimization: if the cache crashes or is flushed, the system continues to function correctly, just slower, because every cache miss transparently falls through to the database. This makes cache-aside the safest default for systems where the cache is not in the critical path of correctness. The downsides are three:

- Every cache miss incurs three round-trips (cache check, database read, cache backfill).
- The cache is cold for data that has never been read.
- The application code must carry cache-management logic in every read path, which is a source of bugs if one code path forgets to backfill.

The deletion-on-write rule is non-negotiable: updating the cache with `SET` after a database write creates a race where a concurrent read loads the old value from the database and overwrites your fresh cache entry with stale data, and this race is the single most common caching bug in production.

### Read-Through

Read-through moves the cache-population logic into the cache layer itself: the application calls a single `get` API on the cache, and if the key is absent the cache internally invokes a configurable loader callback that fetches from the database, populates the cache, and returns the value. The application never talks to the database directly for cached reads. This is cleaner than cache-aside because the read path has a single call and the cache-miss logic lives in one place rather than being scattered across every read site, which eliminates the "forgot to backfill" class of bug.

Read-through still has the cold-start cost of cache-aside — the first read of any key hits the database — and it introduces a coupling between the cache and the database that makes the cache layer slightly harder to swap out. Redis does not natively support read-through; it is typically implemented in a client library (like Spring Cache or a custom wrapper) that intercepts cache misses and invokes the loader. Read-through is the right choice when you have many read paths that would otherwise duplicate cache-aside logic, and when you want the cache to be the single gateway to the database for reads.

### Write-Through

Write-through inverts the write path: the application writes to the cache, and the cache synchronously writes to the database before returning success to the application. The cache is always warm and always consistent with the database — there is no stale-read window because the cache and database are updated atomically from the caller's perspective.

This is the strongest consistency guarantee of the four patterns, and it is the right choice for data where staleness is unacceptable: configuration, feature flags, session state, or any write-then-immediately-read workflow. The cost is write latency: every write now pays for both a cache write and a database write before the caller can proceed, which roughly doubles write latency compared to writing to the database alone. Write-through works best when writes are relatively infrequent compared to reads (so the latency overhead is amortized) and when the cache and database are co-located enough that the double write is cheap. It also requires the cache to be in the critical path of correctness: if the cache is down, writes fail, which means write-through demands higher availability for the cache layer than cache-aside does.

### Write-Behind (Write-Back)

Write-behind is the highest-throughput write pattern: the application writes only to the cache, and the cache asynchronously flushes to the database in batches, either on a timer, after a configurable number of writes, or when memory pressure triggers a flush. This gives the lowest possible write latency because the caller never waits for the database, and it smooths out write spikes by absorbing them into memory and draining to the database at a controlled rate.

The trade-off is the most severe of any pattern: if the cache node crashes before a flush completes, those writes are permanently lost, because the cache was the sole authority and the database never saw them. This makes write-behind unsuitable for transactional data — financial records, orders, anything with audit or compliance requirements — and suitable for telemetry, counters, session updates, and other data where a small loss window is acceptable in exchange for throughput. Write-behind also complicates reads: if a read hits the cache it gets the latest value, but if it falls through to the database it gets a stale value because the database hasn't been flushed yet, so the read path must always prefer the cache. Redis does not natively support write-behind; it is implemented with client-side write buffering, or with Redis Streams as a durable write-ahead log that a consumer drains to the database, which adds durability at the cost of complexity.

## Redis Architecture: Single-Threaded Command Execution with I/O Multiplexing

Redis's architecture is often summarized as "single-threaded," but that summary is incomplete and the full picture matters for capacity planning and for understanding why Redis behaves the way it does under load. The core model is that a single Redis process handles all command execution on a single main thread, using an event loop based on `epoll` (on Linux) or `kqueue` (on macOS) for I/O multiplexing. This means Redis processes one command at a time, serially, and because there is no parallel command execution, every command is inherently atomic with respect to every other command — there are no locks, no mutexes, no race conditions within a single Redis instance, and this is the structural reason Redis can offer atomic operations like `INCR`, `GETSET`, and `LPUSH` without any explicit locking mechanism. The event loop accepts connections, reads commands from sockets into an input buffer, executes them one at a time on the main thread, and writes responses back to sockets — all without blocking, because the I/O is non-blocking and multiplexed.

Since Redis 6.0, the I/O threading model has been extended: Redis can now use a pool of I/O threads to handle the read and write of socket buffers in parallel, while command execution remains on the single main thread. This is because for high-throughput workloads with many connections, the bottleneck is often not command execution but the CPU cost of reading from and writing to sockets — the `read` and `write` system calls and the buffer copying. I/O threads parallelize that work, but they do not execute commands, so the single-threaded execution semantics are preserved. This is an important nuance for interviews: Redis 6+ is not multi-threaded in the sense that Memcached is; it is single-threaded for command execution with optional multi-threaded I/O, and the atomicity guarantees are unchanged.

The practical implication is that a single Redis instance is CPU-bound on a single core for command execution, so vertical scaling is limited to the speed of one core, and horizontal scaling requires Redis Cluster or multiple instances. A slow command — `KEYS *`, `SMEMBERS` on a large set, `LRANGE 0 -1` on a million-element list — blocks the entire event loop and stalls every other client, which is why Redis commands are designed to be O(1) or O(log N) and why the `KEYS` command is forbidden in production in favor of `SCAN`.

## Memcached Architecture: Multi-Threaded with Slab Allocation

Memcached takes the opposite architectural bet: it is multi-threaded, with a configurable number of worker threads (typically set to the number of CPU cores), each handling commands independently and sharing access to the hash table via a fine-grained per-bucket lock. This means Memcached can utilize all available CPU cores for command execution, which makes it more throughput-efficient on multi-core machines than a single Redis instance, and it is the reason Memcached can scale vertically by adding cores while Redis cannot without clustering. The trade-off is that Memcached's command set is intentionally minimal — `get`, `set`, `add`, `replace`, `delete`, `incr`, `decr`, `cas` — because any complex operation would require cross-thread coordination that would defeat the purpose of the multi-threaded design. There are no lists, sets, sorted sets, or Lua scripts; every value is an opaque blob, and the application is responsible for any structural interpretation.

Memcached's memory management is built around the slab allocator, which is the second defining difference from Redis. Rather than using a general-purpose allocator like `jemalloc` (which Redis uses) and accepting the fragmentation that comes with variable-size allocations, Memcached pre-divides memory into slabs, each slab class serving objects of a specific size range (e.g., slab class 1 serves 1–64 byte objects, class 2 serves 65–128 byte objects, and so on, doubling up to the maximum item size of 1MB by default). When a `set` arrives, Memcached determines the slab class for the value size and allocates from that class's free chunk list. This eliminates per-allocation fragmentation within a slab class because every chunk in a class is the same size, and allocation and deallocation are O(1) pointer manipulations.

The cost is that memory is partitioned by size class and cannot be dynamically rebalanced: if your workload stores many 70-byte objects, slab class 2 fills up while slab class 1 (64-byte chunks) sits empty, and Memcached will evict from class 2 rather than reclaim class 1's memory. This is called slab assignment imbalance and it is a known operational concern with Memcached, mitigated by the `-f` growth factor flag (which controls the ratio between slab class sizes) and by monitoring `stats slabs` output to verify that no class is starved while another is over-provisioned. The 1MB item size limit is also a hard constraint: Memcached cannot store a value larger than 1MB without recompilation, while Redis can store values up to 512MB.

## Redis vs Memcached: Side-by-Side

| Dimension | Redis | Memcached |
|---|---|---|
| **Threading model** | Single main thread for command execution; optional I/O threads (6.0+) | Multi-threaded; one worker per core, per-bucket locks |
| **CPU scaling** | Vertical limited to one core; scale horizontally via Cluster | Scales vertically with cores |
| **Atomicity** | Inherent — no locks needed (serial execution) | Per-bucket locks; `CAS` for check-and-set |
| **Data types** | Strings, hashes, lists, sets, sorted sets, streams, bitmaps, HyperLogLog | Opaque blobs only |
| **Max value size** | 512 MB | 1 MB (hard, unless recompiled) |
| **Memory allocator** | `jemalloc` (variable-size; fragmentation possible) | Slab allocator (size-classed; O(1) alloc, imbalance risk) |
| **Eviction** | Approximate LRU / LFU / random / TTL / noeviction | True LRU per slab class |
| **Persistence** | RDB snapshots + AOF log | None (purely in-memory) |
| **Replication / HA** | Primary-replica async replication; Redis Cluster failover | None built-in (client-side sharding; no replicas) |
| **Sharding** | Redis Cluster — 16,384 hash slots, `MOVED`/`ASK` redirects | Client-side consistent hashing |
| **Pub/Sub & Streams** | Native Pub/Sub + Streams (durable, consumer groups) | None |
| **Scripting** | Lua, functions | None |
| **Best fit** | Rich data structures, persistence, HA, complex workloads | Pure, simple, high-throughput opaque-key caching |

## Eviction Policies

When a cache reaches its memory limit, it must evict existing keys to make room for new ones, and the eviction policy determines which keys are sacrificed. The choice of policy should be driven by the access pattern of the workload: some workloads have a stable hot set where recency is a good predictor of future access, others have a long tail where frequency matters more, and others are essentially random.

### Eviction Policy — Victim Selection

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                  EVICTION POLICY — VICTIM SELECTION                         │
│   sample keys with access history (age = time since last access)            │
└─────────────────────────────────────────────────────────────────────────────┘

  key     last access        count    TTL left
  ──────  ───────────────    ──────   ──────────
  A       5 min ago          100      none
  B       1 hour ago         2        30s
  C       just now           1        10m
  D       10 min ago         50       2s

  LRU            ─▶ evicts B   (accessed longest ago)        recency predicts future
  LFU            ─▶ evicts C   (lowest frequency count)      frequency predicts value
  RANDOM         ─▶ evicts ?   (uniform random pick)         zero tracking overhead
  volatile-ttl   ─▶ evicts D   (shortest remaining TTL)      ephemeral first, keep permanent
  noeviction     ─▶ evicts none — returns OOM error          refuse writes; no data loss

  Redis implements APPROXIMATE LRU/LFU: samples `maxmemory-samples` random keys
  (default 5) and evicts the worst among the sample — cheap, near-optimal in practice.
```

### LRU (Least Recently Used)

LRU evicts the key that was accessed longest ago, under the assumption that keys accessed recently are more likely to be accessed again. Redis implements an approximate LRU: rather than maintaining a globally sorted linked list of all keys by access time (which would be expensive in memory and CPU), Redis samples a configurable number of random keys (default 5, tunable via `maxmemory-samples`) and evicts the least recently used among the sample. This approximation is effective in practice because the sampled subset is usually representative, and increasing `maxmemory-samples` to 10 brings the approximation close to true LRU at the cost of slightly more CPU per eviction. Memcached uses a true LRU per slab class, which is feasible because each class has its own doubly-linked list and the number of items per class is bounded by the slab's memory.

### LFU (Least Frequently Used)

LFU evicts keys with the lowest access frequency count, under the assumption that keys accessed many times are more valuable than keys accessed recently but rarely. Redis 4.0 introduced LFU with a probabilistic counter: each key carries a logarithmic access counter that decays over time, so a key accessed 100 times in the last hour has a higher count than a key accessed 100 times over the last week. LFU is the right choice for workloads with a stable hot set and a long cold tail — recommendation systems, configuration data, product catalogs — where the hot keys are hot because of intrinsic popularity, not recency. The decay mechanism ensures that a key that was popular last month but is now dead will eventually be evicted even if its historical count is high.

### Random

Random eviction removes a random key when memory is full. This sounds naive but is surprisingly effective for workloads where all keys have roughly equal access probability — session storage where all sessions are equally likely to be accessed next, for example. Random eviction has zero tracking overhead (no access timestamps, no frequency counters) and is the fastest eviction policy in terms of per-eviction CPU cost. Memcached does not support random eviction natively; Redis supports it via `maxmemory-policy allkeys-random`.

### TTL-based Eviction

TTL-based eviction is not strictly an eviction policy but a complementary mechanism: keys with a TTL expire automatically after their lifetime, reducing the need for eviction under memory pressure. Redis's `volatile-ttl` policy evicts keys with the shortest remaining TTL first among keys that have a TTL set, which is useful when you can distinguish between "important" keys (no TTL, never evict) and "ephemeral" keys (TTL set, evict these first). Redis's `noeviction` policy, the default, refuses writes when memory is full and returns an error to the client — this is the safest policy for caches that are in the write-path of correctness, because silent eviction can cause data loss in write-through or write-behind patterns, but it requires the operator to monitor memory and scale before the limit is hit.

### Production Policy Choices

The Redis eviction policy is set via `maxmemory-policy` and the common production choices are:

| Policy | Behavior | Use when |
|---|---|---|
| `allkeys-lru` | Evict any key by LRU | Standard cache-aside choice |
| `volatile-lru` | Evict only TTL keys, by LRU | Mixed workloads; some keys permanent |
| `allkeys-lfu` | Evict any key by LFU | Stable hot-set workloads |
| `volatile-lfu` | Evict only TTL keys, by LFU | Mixed workloads with stable hot set |
| `allkeys-random` | Evict any key at random | Uniform-access workloads (e.g. sessions) |
| `volatile-ttl` | Evict shortest-TTL keys first | Distinguish permanent vs ephemeral |
| `noeviction` | Refuse writes; return OOM error | Write-through/write-behind (eviction = data loss) |

The choice should be documented and reviewed, because the default `noeviction` will cause write failures under memory pressure that are easy to misdiagnose as network issues.

## Cache Stampede and Thundering Herd

A cache stampede, also called a thundering herd or dog-pile, occurs when a popular cache key expires and a large number of concurrent requests simultaneously discover the miss and all attempt to load the same data from the database. Instead of one database query, you get hundreds or thousands of identical queries hitting the database at the same instant, and because the database is typically not provisioned for this burst, the result is a latency spike, connection pool exhaustion, or a cascading failure where the database slows down, which causes the application's request timeout to fire, which causes retries, which further load the database. The stampede is particularly dangerous because it is self-reinforcing: the more requests that pile up, the longer each one takes, and the longer they take, the more new requests arrive while the old ones are still in flight.

### Stampede Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   CACHE STAMPEDE / THUNDERING HERD                          │
└─────────────────────────────────────────────────────────────────────────────┘

  T0: hot key's TTL expires
        │
        ▼
   ┌──────────┐  miss   ┌───────────┐
   │  Req 1   │────────▶│ DB query  │
   └──────────┘         └───────────┘
   ┌──────────┐  miss   ┌───────────┐
   │  Req 2   │────────▶│ DB query  │   N identical queries
   └──────────┘         └───────────┘   hit the DB at once ──▶ overload
   ┌──────────┐  miss   ┌───────────┐
   │  Req N   │────────▶│ DB query  │   (self-reinforcing: pile-up
   └──────────┘         └───────────┘    slows each req → more arrive)

  ── DEFENSE 1: LOCK-BASED FILL (request coalescing) ─────────────────────────
     Req1 ──SET NX lock──▶ [ DB query + backfill ] ──DEL lock
     Req2..N ──poll cache──▶ read fresh value
     → collapses N queries into 1; lock TTL must outlast DB query
       but be short enough that a crashed holder doesn't block all.

  ── DEFENSE 2: PROBABILISTIC EARLY EXPIRATION (PER / XFetch) ────────────────
     on HIT: compute early-refresh time = now + (TTL − β·rand^α)
     if now > early-refresh ──▶ background refresh, return cached value
     → staggered refreshers; no lock contention; no synchronized miss.

  ── DEFENSE 3: BACKGROUND REFRESH / CACHE WARMING ───────────────────────────
     scheduled job refreshes known hot keys BEFORE TTL expiry
     → read path never sees a miss for those keys; only helps known hot set.

  In production: combine all three — warming for known hot keys,
  PER for the middle tier, lock-based fill as the fallback.
```

### Defense 1 — Lock-Based Cache Fill (Request Coalescing)

The first line of defense is lock-based cache fill, also called request coalescing: when a cache miss is detected, the requesting thread acquires a distributed lock (using Redis `SET NX` or a dedicated lock service) for that key, and only the lock holder queries the database and backfills the cache. All other concurrent requests for the same key poll the cache and wait for the lock holder to populate it, then read the freshly cached value. This collapses N identical database queries into one, but it introduces a dependency on the lock service and a failure mode where the lock holder crashes before backfilling, leaving the other requests waiting until the lock expires. The lock TTL must be set carefully: long enough that the database query can complete, short enough that a crashed lock holder doesn't block everyone for too long.

### Defense 2 — Probabilistic Early Expiration (PER / XFetch)

The second defense is probabilistic early expiration (PER), also known as XFetch, which avoids the lock entirely by having each client probabilistically decide to refresh the cache before the TTL expires. The algorithm is elegant: on a cache hit, the client computes a probabilistic early refresh time based on the key's TTL and a random factor, and if the current time exceeds that threshold, the client refreshes the cache in the background while still returning the cached value to the caller. The probability distribution is tuned so that the expected number of early refreshes is small (typically one or two) while the chance of a stampede — where no client refreshes early and all hit the miss simultaneously — is negligible. PER has no lock contention, no extra infrastructure, and degrades gracefully, making it the preferred solution for high-traffic hot keys where lock contention itself would be a bottleneck.

### Defense 3 — Background Refresh / Cache Warming

The third defense is background refresh or cache warming: a separate process or scheduled job proactively refreshes hot keys before they expire, so the application read path never sees a miss for those keys. This is the most robust approach for a small, known set of hot keys — the homepage of a news site, the top 100 products on an e-commerce platform — but it requires identifying the hot keys in advance and it does not help for the long tail of less-popular keys that can still stampede if they happen to expire simultaneously. In practice, production systems combine all three: background refresh for known hot keys, PER for the middle tier, and lock-based fill as the fallback for everything else.

## Cache Warming

Cache warming is the practice of pre-populating the cache with data before it is needed, rather than waiting for organic reads to fill it. The most common trigger is a cold start: after a cache flush, a deployment, or a failover, the cache is empty and the first wave of traffic will produce a 100% miss rate that floods the database. Without warming, this cold-start period can last minutes to hours depending on traffic volume, and during that window the database is vulnerable to overload. Warming collapses that window by loading the expected hot set into the cache before traffic is directed to it.

The warming process typically iterates over a known list of hot keys — derived from historical access logs, analytics, or a static configuration — and loads each from the database into the cache with an appropriate TTL. For systems with a stable hot set, warming can be done once at startup; for systems with a shifting hot set, warming can be run on a schedule (e.g., every 10 minutes) to keep the cache populated with the current hot keys. The key insight is that warming is a trade-off between database load during warming and database load during cold starts: warming spreads the database queries over a controlled period, while a cold start concentrates them into a burst. For any cache that serves a workload with a identifiable hot set and a restart or failover scenario, warming should be a standard operational procedure, not an afterthought.

## Distributed Cache Consistency

The fundamental tension in cache consistency is that the cache is a guess about future reads while the database is the ground truth, and any time the database is updated without a corresponding cache update (or invalidation), the cache becomes stale. The question is not whether staleness occurs but how large the staleness window is and whether it is bounded.

The most common consistency bug is the **write-after-delete race** in cache-aside: Thread A reads the cache and gets a miss, Thread A reads the old value from the database, Thread B updates the database with a new value, Thread B deletes the cache entry, Thread A writes the old value back into the cache. Now the cache has stale data that will persist until the TTL expires, and the staleness window is the full TTL, which could be minutes or hours. This race is subtle because it requires a specific interleaving of a slow read and a fast write, but at high concurrency it happens with non-trivial probability, especially for keys with long read latencies (large values, complex database queries). The mitigation is to never write the old value to the cache after a database read if the database read took longer than the write-to-delete window — or more practically, to use a cache versioning scheme where each cached value carries a version number, and the cache is only populated if the version matches the current version in the database. Another mitigation is to delay the cache deletion slightly (the "delayed double delete" pattern): after updating the database and deleting the cache, schedule a second deletion after a short delay (e.g., 500ms) to clean up any stale value that was written by a racing read.

A broader consistency concern is **cross-key consistency**: when a database transaction updates multiple keys, the cache invalidations for those keys are not atomic — one key may be invalidated while another still holds the old value, and a read that spans both keys can see an inconsistent snapshot. This is inherent to cache-aside with a non-transactional cache and cannot be fully solved without making cache invalidation transactional with the database write, which is what write-through achieves at the cost of latency. For most workloads, the pragmatic approach is to accept a short inconsistency window for cross-key reads and to design the application to tolerate it (e.g., by reading the full object from a single cached key rather than assembling it from multiple keys), or to use a database change data capture (CDC) stream to invalidate cache entries in a controlled, ordered manner after each transaction commits.

## Redis Cluster: Slots, Sharding, and Resharding

Redis Cluster is Redis's built-in [[Glossary#Sharding|sharding]] and high-availability solution, and understanding its slot-based architecture is essential for operating Redis at scale. Redis Cluster divides the entire keyspace into 16,384 hash slots, and each key is mapped to a slot by a CRC16 hash of the key modulo 16,384. Each node in the cluster is responsible for a contiguous or non-contiguous range of slots, and every node knows the full slot-to-node mapping, so any node can redirect a client to the correct node for a given key. This slot-based approach has two important properties: first, the number of slots is fixed at 16,384 regardless of the number of nodes, which means the mapping function is stable and does not change when nodes are added or removed; second, because the slot assignment is deterministic from the key, clients can compute the target node locally and connect directly, avoiding a proxy hop for every request.

### Slot Distribution Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              REDIS CLUSTER — 16,384 HASH SLOTS                              │
│            key  ──CRC16(key) % 16384──▶  slot  ──▶  owner node             │
└─────────────────────────────────────────────────────────────────────────────┘

   slot 0                slot 5461            slot 10923         slot 16383
     ▼                      ▼                    ▼                  ▼
  ┌────────────────────┬─────────────────────┬─────────────────────┐
  │  Node A (primary)  │  Node B (primary)   │  Node C (primary)   │
  │  slots 0 – 5460    │  slots 5461 – 10922 │  slots 10923 – 16383│
  │     ▲ async repl   │     ▲ async repl    │     ▲ async repl    │
  │     │               │     │              │     │               │
  │     ▼               │     ▼              │     ▼               │
  │  Node A' (replica) │  Node B' (replica) │  Node C' (replica)  │
  └────────────────────┴─────────────────────┴─────────────────────┘

   client computes slot locally ──▶ connects directly to owner node (no proxy)

   wrong node?  ──MOVED──▶  permanent redirect; client updates slot map, retries
               ──ASK────▶  temporary redirect (slot mid-migration);
                           client follows but does NOT update slot map

   primary fails?  gossip detects (≈30s) ──▶ promote replica for its slots
                  no replica?  slots UNAVAILABLE (cluster may keep serving
                  other slots unless cluster-require-full-coverage = yes)
```

### Resharding

**Resharding** is the process of moving hash slots from one node to another, typically when adding or removing nodes to change the cluster's capacity. Redis Cluster supports online resharding: the cluster remains available for reads and writes while slots are being migrated. The process works at the slot level: for each slot being moved, the source node marks the slot as "migrating" and the destination node marks it as "importing," and keys in that slot are moved one at a time using the `MIGRATE` command. During migration, a key lookup on the source node for a key that has already been moved returns an `ASK` redirect to the destination node, and a key lookup on the destination node for a key that has not yet been moved returns a `MOVED` redirect to the source node (since the slot is not yet fully owned by the destination). Clients must handle both redirects: `MOVED` is a permanent redirect that updates the client's slot map, while `ASK` is a temporary redirect that does not update the slot map (because the slot is mid-migration and the mapping is not yet final). This distinction is important for interview depth: `MOVED` means "this slot lives on a different node permanently, update your cache," while `ASK` means "this specific key has been moved ahead of the slot migration, follow me but don't remember it."

### Replication and Failover

Each slot range is served by a primary node and one or more replica nodes, and the replicas use asynchronous replication from the primary. If a primary fails, the cluster's gossip protocol detects the failure (after a configurable timeout, default 30 seconds) and promotes a replica to primary for the affected slots. If a primary fails and has no replica, the slots served by that primary become unavailable, and the cluster can be configured to either continue serving other slots (the default) or to stop serving all slots (the `cluster-require-full-coverage` option). This is a trade-off between availability and consistency: partial availability means some keys are unreachable while others are served, which is acceptable for most cache workloads but problematic for systems that require all-or-nothing availability.

## Pub/Sub

Redis Pub/Sub is a messaging mechanism where publishers send messages to channels without knowledge of subscribers, and subscribers receive messages in real-time as they are published. Unlike list-based queues, Pub/Sub does not persist messages: if no subscriber is listening, the message is dropped, and if a subscriber disconnects and reconnects, it does not receive messages that were published during the disconnection. This fire-and-forget semantic makes Pub/Sub suitable for real-time signaling — chat presence notifications, cache invalidation broadcasts, live leaderboard updates — but unsuitable for reliable delivery where every message must be processed. Redis maintains a global command queue for each subscriber, and if a subscriber is slow to consume, the queue grows, and Redis will eventually disconnect the subscriber if its output buffer exceeds a configurable limit (`client-output-buffer-limit pubsub`), which is a backpressure mechanism to prevent one slow subscriber from degrading the entire Redis instance.

For use cases that need reliable delivery, Redis Streams (introduced in Redis 5.0) provide a persistent, consumer-group-capable log that combines the real-time feel of Pub/Sub with the durability of a message queue. Streams support multiple consumers reading from the same stream with consumer groups, automatic acknowledgment, and message replay from any offset, making them a better fit for event-driven architectures where message loss is unacceptable. The common interview point is that Pub/Sub is for ephemeral fan-out (the message is valuable only at the moment of publication) while Streams are for durable fan-out (the message must be processed even if the consumer is temporarily unavailable), and conflating the two leads to either lost messages (using Pub/Sub where durability is needed) or unnecessary complexity (using Streams where fire-and-forget suffices).

## Redis Persistence: RDB and AOF

Redis is primarily an in-memory store, but it offers two persistence mechanisms that allow data to survive a restart or crash, and the choice between them (or their combination) depends on the acceptable data loss window and the performance budget.

### RDB (Redis Database) Snapshots

RDB snapshots are point-in-time binary dumps of the entire dataset, written to a single file (`dump.rdb`). Redis forks a child process that writes the snapshot while the parent continues serving traffic, using copy-on-write semantics so the child sees a consistent snapshot of memory at the fork moment. RDB is compact (a single binary file, efficient to transfer for backups), fast to load on restart (reading a binary file into memory is quicker than replaying a log), and has zero impact on the main thread's command execution during the snapshot (the fork does the work). The downside is granularity: if Redis crashes between snapshots, all writes since the last snapshot are lost. The snapshot frequency is configurable (`save 900 1` means "snapshot if at least 1 key changed in the last 900 seconds"), but more frequent snapshots increase fork frequency, and on large datasets the fork itself can cause a latency spike due to copy-on-write page table duplication, even though the main thread is not blocked. RDB is the right choice for backup and disaster recovery where losing the last few minutes of writes is acceptable and where fast restart is important.

### AOF (Append-Only File)

AOF is a log of every write command, appended to a file as it is received. On restart, Redis replays the AOF to reconstruct the dataset. The AOF can be configured with three sync policies:

| Policy | Behavior | Trade-off |
|---|---|---|
| `always` | fsync after every write | Most durable, but very slow (each fsync is a disk sync, ms-scale) |
| `everysec` | fsync once per second | Recommended default; max loss window ≈ 1 second |
| `no` | OS decides when to fsync | Fastest; unpredictable loss window up to ~30s |

The AOF grows over time as every write is logged, so Redis periodically rewrites the AOF: the rewrite forks a child process that constructs a new, minimal AOF by reading the current dataset state and writing the minimal set of commands needed to reproduce it, which collapses a log that has accumulated thousands of increments on the same key into a single `SET` with the final value. AOF is the right choice when the data loss window must be bounded to approximately one second, which covers most session, configuration, and application-state workloads.

### Combining RDB and AOF

The production best practice is to enable both RDB and AOF: RDB provides fast restart and a compact backup artifact, while AOF provides a bounded data-loss window. On restart, Redis loads the AOF (which is more complete than the last RDB), so the RDB serves as a fallback and backup. The combined approach has slightly higher disk usage and write overhead, but for any Redis instance where data persistence matters, the overhead is justified by the resilience.

## Memory Optimization

Redis memory efficiency is a critical operational concern because Redis stores everything in RAM, and RAM is the most expensive resource per gigabyte in a server. Several techniques can dramatically reduce memory usage, and they should be applied proactively during capacity planning rather than reactively after OOM events.

- **Use the right data structure for the access pattern.** Redis offers hashes, lists, sets, and sorted sets as first-class types, and for small collections, Redis uses a compact encoding called `ziplist` (or `listpack` in Redis 7.0+) that stores the entire collection as a single contiguous memory block with no per-element overhead. A hash with 10 fields stored as a ziplist takes roughly 100–200 bytes, while the same 10 fields stored as 10 separate string keys takes 10 × (key overhead + value overhead + dict entry) ≈ 600–1000 bytes, because each top-level key has a Redis object header, a dict table entry, and an expires table entry if it has a TTL. The thresholds for compact encoding are configurable: `hash-max-ziplist-entries` (default 128) and `hash-max-ziplist-value` (default 64 bytes) control when a hash switches from ziplist to the standard hashtable encoding. Increasing these thresholds keeps more hashes in compact encoding at the cost of O(N) access time for operations on the ziplist, which is acceptable for small N. The general rule is: if you are storing many small objects with a shared prefix (`user:1001:name`, `user:1001:email`, `user:1001:age`), use a single hash per object (`HSET user:1001 name ... email ... age ...`) rather than separate string keys — the memory savings can be 5–10x for workloads with many small objects.

- **Shorten keys and values.** Every byte in a key is stored in memory for the lifetime of the key, and for workloads with millions of keys, key length is a dominant memory factor. A key named `user:session:authentication:token:12345` (43 bytes) vs `u:s:a:t:12345` (14 bytes) saves 29 bytes per key, and at 10 million keys that is 290 MB of savings. The trade-off is readability, which is why key shortening should be applied to high-cardinality, high-volume keys and not to configuration or low-volume keys where clarity matters more. Similarly, values should use the smallest representation that preserves semantics: store integers as integers (Redis encodes small integers in a special 7-byte format), use MessagePack or Protobuf instead of JSON for serialized values, and consider whether boolean flags need to be stored as the string "true" (4 bytes) or as the integer 1 (a few bytes).

- **Set TTLs on all ephemeral keys.** Keys without a TTL accumulate indefinitely, and in a long-running cache, a significant fraction of memory can be consumed by keys that are no longer being accessed but were never expired. Setting a TTL on every key — even a generous one — ensures that dead keys are eventually reclaimed, and the TTL should be chosen based on the data's staleness tolerance, not set to the maximum possible value "just in case." Redis's active expiration cycle runs incrementally in the event loop, sampling keys with TTLs and deleting expired ones, so expiration does not cause latency spikes; the passive path also deletes keys on access if they are found to be expired.

- **Enable `activedefrag` (Redis 4.0+).** This runs an active defragmentation thread that reclaims memory fragmented by jemalloc's allocation patterns. Without defragmentation, Redis's `used_memory_rss` (resident set size) can be significantly larger than `used_memory` (logical data size), because freed allocations leave holes that jemalloc cannot return to the OS. Active defragmentation coalesces these holes by copying live data into contiguous regions and freeing the fragmented pages, which can reduce RSS by 10–30% on workloads with high churn (frequent sets and deletes). It is enabled with `activedefrag yes` and tuned with `active-defrag-ignore-bytes` and `active-defrag-threshold-lower` to control when defragmentation triggers.

## Capacity Planning

Cache capacity planning is the process of determining how much memory, how many nodes, and what topology are needed to serve a workload at a target hit rate, and it should be done before deployment rather than after an OOM incident. The planning process starts with the **working set size**: the total size of all keys that are accessed frequently enough that they should be in the cache. The working set is not the total dataset size — the total dataset may be 1 TB while the working set (the hot 20% that receives 80% of traffic) may be 50 GB. The cache must be sized to hold the working set with headroom for churn, because if the cache is smaller than the working set, the eviction rate will be high and the hit rate will suffer — this is the point of diminishing returns where adding more memory produces a disproportionate hit-rate improvement until the working set fits, after which additional memory yields diminishing returns.

The rule of thumb is to provision cache memory at 1.5–2x the working set size: the working set itself plus headroom for new keys being written, for keys that are temporarily hot during a traffic spike, and for the overhead of Redis's data structures (dict table, expires table, object headers — roughly 30–50% overhead on top of the raw key-value bytes for string types, less for compact-encoded hashes). The memory headroom also gives the eviction policy room to make good decisions: a cache at 95% capacity evicts aggressively and may evict keys that would have been accessed soon, while a cache at 70% capacity evicts lazily and preserves a deeper history.

**Hit rate targets** depend on the workload: 95–99% is typical for read-heavy workloads with a well-defined hot set, while 80–90% may be acceptable for workloads with a long tail. The hit rate directly determines the database load: at 99% hit rate, 1% of reads hit the database, while at 90% hit rate, 10% of reads hit the database — a 10x difference in database load for a 9-point hit-rate change. This is why capacity planning should start from the database's capacity: if the database can handle 5,000 QPS and the peak read traffic is 100,000 QPS, the cache must achieve at least 95% hit rate (100,000 × 0.05 = 5,000 QPS to the database), which sets a minimum on the cache size needed to hold the working set.

**Node count and topology** are determined by the total memory requirement and the per-node memory limit. A single Redis instance is typically limited to 10–25 GB of data because of the fork-on-snapshot latency (larger datasets mean longer fork times and bigger copy-on-write memory spikes during RDB or AOF rewrite), so a 100 GB working set requires 5–10 Redis instances, which in turn requires Redis Cluster or a client-side sharding layer. The per-node memory limit is also influenced by the failure model: if a node fails, the data on that node is unavailable until a replica is promoted, and the failover causes a temporary spike in miss rate for the affected keys. More nodes means smaller blast radius per failure but more operational complexity, while fewer nodes means simpler operations but larger blast radius. The common production topology for a 100 GB working set is 5–10 primary nodes with 1–2 replicas each, deployed across availability zones, with Redis Cluster managing the slot distribution and failover.

## Interview Question

> **Q: You run a Redis cache in front of a PostgreSQL database serving a product catalog. After a bulk price update that touches 50,000 products, you see a 10x spike in database QPS that lasts for 20 minutes. Walk through the root cause and your fix. Then: how would you prevent this if the bulk update runs every hour?**

**Model Answer:** The root cause is a mass cache invalidation stampede. The bulk update deleted 50,000 cache entries at once, and the next read for each of those products is a cache miss that queries PostgreSQL. If your peak read rate is 100,000 QPS and those 50,000 keys were collectively receiving 80% of read traffic, the miss rate jumps from ~1% to ~80% instantaneously, which is a 60–80x increase in database QPS, not 10x — the 10x you observed is probably the averaged view; the instantaneous spike is worse. The spike lasts 20 minutes because that is how long it takes for the organic read traffic to repopulate the cache and bring the hit rate back above 95%.

**Immediate fix:** Rate-limit the cache invalidation. Instead of deleting all 50,000 keys in one batch, delete them in a trickle — e.g., delete 500 keys per second over 100 seconds — so the miss rate rises gradually rather than instantaneously, and the database sees a 5% increase in QPS sustained for 100 seconds rather than a 60x spike for 20 minutes. This requires the application to tolerate a short staleness window for some products (those whose cache entries are deleted later in the trickle), which is almost always acceptable for a price catalog. Alternatively, use a **cache warming** approach: after the bulk update, proactively reload the hot products into the cache from the database in a controlled, rate-limited manner before allowing organic traffic to hit the misses.

**Prevention for hourly bulk updates:** The deeper fix is to decouple the cache invalidation from the bulk update entirely. Instead of deleting keys on write, use a **version-based invalidation** scheme: each cached product entry stores a version number, and the bulk update increments a global "price version" counter. On read, the client checks the cached entry's version against the current global version (which can itself be cached and is a single key), and if they differ, the entry is treated as stale and refreshed. This means the invalidation is a single `INCR` command rather than 50,000 `DEL` commands, and the refresh happens lazily and spread out over time as each key is organically accessed, which naturally rate-limits the database load. For the hottest keys, a background warmer refreshes them proactively before the next bulk update runs. The combination of version-based invalidation (for correctness) and background warming (for hot-key latency) eliminates the stampede entirely while keeping the cache fresh.

## Common Pitfall

> **Setting `maxmemory` but forgetting to set `maxmemory-policy`, or setting it to `noeviction` for a cache-aside workload.** Redis's default `maxmemory-policy` is `noeviction`, which means when Redis hits the memory limit it starts refusing writes with an `OOM command not allowed when used memory > 'maxmemory'` error — it does not evict. For a cache-aside pattern where the cache is not the source of truth and stale-or-missing data is acceptable, this is the wrong policy: you want `allkeys-lru` or `allkeys-lfu`, which evict old keys to make room for new ones and keep the cache serving. The failure mode of `noeviction` on a cache is insidious: reads still work (they return cached values), but every cache-miss backfill (the `SET` after a database read) fails silently or with an error that the application may not handle, so the cache hit rate degrades over time as keys expire and cannot be replaced, and the database load climbs steadily until it is overwhelmed. Always set `maxmemory` to 70–80% of the available RAM (leaving room for the OS, the fork's copy-on-write overhead, and the output buffers) and set `maxmemory-policy` to `allkeys-lru` for general cache-aside workloads. Monitor `evicted_keys` in `INFO stats` — a steady, low eviction rate is healthy; a suddenly increasing rate signals that the working set has grown beyond the cache capacity and it is time to scale up.

## Interview Cheat Sheet

**Key Points to Remember:**
- Cache-aside (lazy loading) is the safest default: the cache is purely an optimization, and if it fails the system still works, just slower. Always delete (not update) the cache on write to avoid the stale-overwrite race.
- Redis is single-threaded for command execution (commands are inherently atomic) but CPU-bound on one core; Memcached is multi-threaded but stores only opaque blobs with no persistence or replication.
- Eviction policy must match the access pattern: LRU for recency-driven workloads, LFU for stable hot sets, and `noeviction` only when the cache is in the write-path of correctness (write-through/write-behind).
- A cache stampede (thundering herd) happens when a hot key expires and every concurrent request hammers the database at once — defend with request coalescing (locks), probabilistic early expiration (PER), and background warming.
- Size the cache to 1.5–2x the working set (not the full dataset); the hit rate directly determines database load, and a 9-point hit-rate swing means a 10x difference in database QPS.

**Common Follow-Up Questions:**
- **"What happens if the cache goes down entirely?"** — In cache-aside, reads fall through to the database and the system degrades gracefully (slower but correct); in write-through/write-behind, writes fail because the cache is in the critical path, so you need replicas and failover.
- **"How do you keep the cache consistent with the database?"** — Use delete-on-write (not set), accept TTL-bounded eventual consistency for most data, and apply delayed double-delete or version-based invalidation for high-consistency needs; write-through gives strong consistency at the cost of doubled write latency.
- **"Redis or Memcached?"** — Redis for rich data structures, persistence, replication, and pub/sub; Memcached for pure, simple, high-throughput opaque-key caching where you want multi-core vertical scaling and nothing else.

**Gotcha:**
- The default Redis `maxmemory-policy` is `noeviction`, which silently refuses cache-miss backfills (`SET` after a DB read) when memory is full — the cache hit rate decays over time and database load climbs until it's overwhelmed, and the error is easy to misdiagnose as a network issue. Always set `maxmemory` to 70–80% of RAM and `maxmemory-policy` to `allkeys-lru` for cache-aside workloads.
