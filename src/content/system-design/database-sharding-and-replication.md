---
title: "Database Sharding & Replication"
category: "Scale"
day: 14
difficulty: "advanced"
read_time: 27
listen_time: 38
tags: [system-design, databases, sharding, replication, distributed-systems, scaling, interview]
last_updated: "2026-06-19"
---

# Database Sharding & Replication

Sharding and replication are the two foundational techniques for scaling a database beyond the capacity of a single machine, and although they are often discussed together they solve fundamentally different problems. Sharding is about *spreading data out* so that no one node holds more than a fraction of the total dataset, which primarily addresses write throughput and storage capacity. Replication is about *copying data* so that the same information lives on multiple nodes, which primarily addresses read throughput, availability, and durability. The two are orthogonal: you can shard without replicating (each row exists on exactly one shard, cheap but fragile), replicate without sharding (every node holds the entire dataset, simple but bounded by the largest node's capacity), or — as almost every production system at scale eventually does — combine them so that each shard is itself backed by a primary and several replicas. Understanding when each technique applies, and the exact failure modes that emerge when they are combined, is one of the most consistently tested areas in senior and staff-level system design interviews.

## Summary & Interview Framing

Splitting a large database into smaller partitions (shards) across multiple machines for horizontal scaling, plus copying data to replicas for read scaling and fault tolerance. Sharding addresses write throughput and storage capacity by spreading rows across nodes; replication addresses read throughput, availability, and durability by copying data — and most production systems combine both with each shard backed by a primary and replicas.

**How it's asked:** "Design a sharding strategy for a 10TB database with 500K QPS. Choose shard key, handle cross-shard queries, resharding, and replication lag."

## Horizontal vs Vertical Partitioning

Before diving into sharding it is worth separating the related but distinct idea of partitioning. Vertical partitioning splits a table by *columns*: you might move a large rarely-accessed JSON blob column or a full-text payload into its own table or even its own storage engine, keeping the hot, narrow columns on the fast primary row store. Vertical partitioning is something a single database instance can do internally and it does not require any distributed machinery; it reduces row width, improves cache hit rates, and lets you tune storage per column family, but it does not increase write throughput or total storage beyond what one machine can hold because every row still has to live on the same node. Horizontal partitioning instead splits a table by *rows*, distributing different rows to different nodes. When that horizontal split crosses machine boundaries it is what we call sharding. The practical rule of thumb is to exhaust vertical partitioning, read replicas, and query optimization first — these buy you maybe an order of magnitude — and only reach for horizontal sharding once you are genuinely bound by the CPU, memory, or disk of a single primary, because sharding introduces a permanent layer of operational complexity that you can never fully remove.

A subtle but important point is that horizontal partitioning *within* a single node (partitioned tables in PostgreSQL, InnoDB partitioning in MySQL) is sometimes confused with sharding. Both split rows by a key, but intra-node partitioning only helps with manageability — faster maintenance operations, partition pruning on queries, easier archiving of old partitions — and does nothing for write throughput because all partitions still contend for one node's I/O and CPU. Sharding is specifically the *cross-node* form, and everything hard about it (cross-shard transactions, distributed joins, rebalancing) follows from that one design decision to put partitions on physically separate machines.

## Choosing a Shard Key

The shard key is the single most consequential decision in any sharding design because it determines data placement forever after, and changing it later is roughly as expensive as a full migration. A good shard key has three properties: high cardinality, so that the key space can be split into many distinct buckets and no single value dominates; even write distribution, so that traffic does not concentrate on one shard; and locality for the dominant access pattern, so that the common query — almost always "fetch one entity by its key" — touches exactly one shard and never fans out. `user_id` is the canonical good key for a social or SaaS product because it has enormous cardinality, writes are naturally spread across the user base, and almost every request is scoped to a single user. A composite key like `(tenant_id, user_id)` is common in multi-tenant systems where you want all of a tenant's data colocated for per-tenant queries but still spread across shards at the tenant level. Bad keys are easy to spot in hindsight: `country` has low cardinality and concentrates load wherever the largest user base lives; a monotonically increasing timestamp creates a single hot shard at the "head" of the insert stream where all new writes land; and any key whose hash is taken modulo a small N will eventually produce skew. The key insight interviewers look for is that the shard key must be chosen around the *write* path and the primary read path, not around analytic range queries, because analytic queries can always be served by a secondary system (a data warehouse, ClickHouse, an Elasticsearch index) whereas the transactional read and write path has to be fast on the shard store itself.

## Sharding Strategies

### Range-Based Sharding

Range-based sharding assigns contiguous ranges of the shard key to each shard: shard 0 holds user IDs 0 to one million, shard 1 holds one million to two million, and so on. The great advantage of range sharding is that range scans become single-shard or few-shard operations, because adjacent keys are colocated, which makes queries like "all users created between these two IDs" efficient. The equally great disadvantage is that range sharding is extremely prone to hot spots: any monotonically increasing key (an auto-increment ID, a timestamp) funnels all new inserts onto whichever shard currently owns the top of the range, turning that one node into a bottleneck while the rest of the cluster sits idle. Range sharding also tends to produce uneven shard sizes over time unless ranges are actively split and rebalanced, because real data is rarely uniform — a shard covering a dense geographic region or a viral tenant will dwarf its siblings. In practice pure range sharding is used when range queries are a first-class requirement and the key is not monotonic, or as the underlying mechanism in systems like HBase and Bigtable that combine a range-partitioned key space with automatic region splitting.

### Hash-Based Sharding

Hash-based sharding computes `shard = hash(key) % N` and places the row on the resulting shard, which distributes writes evenly as long as the hash function is good and the key has high cardinality. This eliminates the hot-spot problem of range sharding for inserts because consecutive keys hash to random shards, so a monotonically increasing ID spreads its writes across the whole cluster. The price you pay is that range queries become scatter-gather operations hitting every shard, since adjacent keys are now scattered, and that resharding is acutely painful: if N changes from 10 to 11, the modulus changes and roughly 90% of all keys need to move to a new shard, because `hash(key) % 11` differs from `hash(key) % 10` for almost every key. This modulus-resizing problem is the motivation for consistent hashing, discussed below. Hash sharding is the right default when the workload is point lookups and writes with no meaningful range component, which covers a large fraction of OLTP workloads.

### Directory-Based Sharding

Directory-based sharding introduces a separate lookup service — typically a highly available key-value store like ZooKeeper, etcd, or a Redis cluster — that maps each shard key (or key range) to the physical shard that owns it. The application or a routing layer consults the directory for every request, then routes to the indicated shard. The strength of this approach is flexibility: the mapping is arbitrary data, not arithmetic, so you can assign specific heavy tenants to dedicated shards, move a single key by editing one mapping entry, and support complex multi-tenant placement policies without rehashing anything. The weakness is that the directory itself is now a critical piece of infrastructure: it is a dependency on the hot path of every query, it must itself be replicated and highly available, and if it goes down the entire system loses the ability to route. Real systems mitigate this with aggressive client-side caching of the directory (so the common case is a cache hit and the directory is only consulted on a miss or a suspected move) and by making the directory small enough to fit entirely in memory on every router. Vitess uses a variant of this pattern with its topology service storing shard-key mappings, and Citus essentially uses a directory-style metadata table in the coordinator node to track which shard holds which hash ranges.

```
                         SHARDING STRATEGIES

   RANGE-BASED              HASH-BASED              DIRECTORY-BASED
   ────────────             ──────────              ───────────────
   key ──┐                  key ──┐                 key ──┐
         ▼                       ▼                       ▼
   ┌─────────────┐        shard = hash(key) % N   ┌─────────────┐
   │ Shard 0     │              │                 │  Directory  │
   │   0 – 1M    │              ▼                 │   Service   │
   │ Shard 1     │        ┌───────────┐           │  (etcd/ZK)  │
   │   1M – 2M   │        │  hash to  │           └──────┬──────┘
   │ Shard 2     │        │  shard N  │                  │ lookup
   │   2M – 3M   │        └─────┬─────┘                  ▼
   │   ...       │              │                   routed shard
   │ Shard 9     │              ▼
   │   9M – 10M  │        shards 0..N-1
   └─────────────┘
   contiguous              even spread            arbitrary mapping
   ✓ range scans cheap     ✓ even writes          ✓ flexible placement
   ✗ hot spot at head      ✗ range query fan-out  ✗ directory = hot path
   ✗ uneven sizes          ✗ reshard moves ~all   ✗ extra hop per query
```

| Strategy | Key → shard mapping | Range queries | Write distribution | Resharding cost | Best for |
|----------|---------------------|---------------|--------------------|-----------------|----------|
| Range | contiguous key ranges | cheap — single/few shards | poor — hot range at the head | split/merge ranges (manageable) | range-scan workloads; HBase, Bigtable |
| Hash | `hash(key) % N` | expensive — scatter-gather all shards | even (high-cardinality key) | painful — ~all keys relocate when N changes | point lookups + writes; most OLTP |
| Directory | lookup service maps key → shard | depends on the mapping | flexible — manual control | cheap — edit one mapping entry | multi-tenant; pinning heavy tenants |

## Consistent Hashing for Sharding

Consistent hashing solves the resharding problem of naive hash modulo. Instead of mapping keys directly to shards with `hash(key) % N`, both the keys and the shard nodes are placed onto the same hash ring — a fixed-size circular space, typically the full 32-bit or 128-bit hash range — and each key is assigned to the first node encountered moving clockwise from the key's position on the ring. The defining property is that when a node is added or removed, only the keys in the arc between the changed node and its predecessor need to move; every other key stays put. Contrast this with modulo hashing where changing N relocates nearly the entire keyspace. This means going from 10 to 11 shards migrates roughly 1/11 of the data instead of 10/11, which is the difference between a feasible online migration and a full rebuild.

```
              CONSISTENT HASHING RING

                     0
                .  ·  ·  .
            ·              ·
         ·                    ·   ◀ key k routes clockwise to the
       ·         N1            ·     first node it meets on the ring
      ·            ◀            ·
     ·      key k  ·   N2        ·
     ·                ◀          ·
      ·                          ·
        ·          N3          ·
            ·              ·
                ·  ·  ·
                    2^32 / 2^128

   Add node N4 → only the arc between N4 and its predecessor
   moves keys; every other key stays put.
   (10 → 11 shards ≈ 1/11 of data moves,
    vs. ~10/11 under naive modulo hashing.)
```

The naive ring has two problems that production systems must address. First, a random placement of a small number of nodes produces uneven arc lengths, so some nodes own far more of the ring than others and become disproportionately loaded. The standard fix is *virtual nodes* (also called vnodes): each physical node is placed on the ring multiple times at pseudo-random positions (typically 100 to 200 vnodes per node), which statistically smooths out the owned arc length so that every physical node ends up with close to an equal share. Second, on a plain ring a node addition still takes ownership of its arc immediately, which can cause a brief window of stale reads and write loss during the migration. Production consistent-hashing systems (Dynamo, Cassandra, ScyllaDB) layer a token-aware replication strategy on top: data is replicated to the next R nodes clockwise, and when a node joins it gradually streams its assigned ranges from the existing replicas before advertising itself as ready, so that ownership transfer is gradual rather than instantaneous. For a sharded relational database, consistent hashing is most useful not as the storage engine's internal mechanism but as the *routing* layer's mechanism: a proxy like Vitess can use a consistent-hash shard map so that adding a shard only remaps the keys in the affected arc, making resharding a bounded, online operation rather than a full table rewrite.

## Cross-Shard Queries and Distributed Joins

The moment you shard, you have given up the ability to do a single-node join or a single-node transaction across arbitrary rows, and every query that is not routed by the shard key becomes a distributed operation. A point query on the shard key — `SELECT * FROM orders WHERE user_id = 42` — is the happy path: the router hashes `user_id`, picks one shard, and the query is as fast as on an unsharded database. Everything else is harder. A query that filters on a non-sharded column, like `SELECT * FROM orders WHERE status = 'shipped'`, has no single shard to target, so the router must fan it out to every shard, run the query locally on each, then merge the results at the router layer — the classic scatter-gather pattern. Scatter-gather multiplies your query latency by the slowest shard, saturates the router's merge buffers with partial results, and breaks any query that needs global ordering or a global limit unless the router implements merge-sort and top-K logic on the streamed partial results. The standard mitigations are to design the schema so that the dominant queries are shard-key-routed, to maintain denormalized copies of frequently-joined data colocated with the shard key (embedding the user's profile fields into the order row, for example), and to push analytics that genuinely need a global view into a separate OLAP system fed by change data capture.

Distributed joins are the most expensive operation in a sharded system because they come in two painful flavors. A *colocated join* — joining two tables on the shard key, where both tables are sharded by the same key so matching rows live on the same shard — is cheap because the join runs locally on each shard and no data moves. This is why multi-tenant systems almost always shard every tenant-scoped table by `tenant_id`: all joins within a tenant are colocated and free. A *broadcast join* handles the case where one side of the join is small enough to replicate to every shard; the small table is sent to all shards and each shard joins its local partition against the broadcast copy. The truly expensive case is a *shuffle join* between two large tables sharded on different keys, which requires redistributing one or both sides across the network so that matching rows meet on the same node — essentially a distributed hash join with a network shuffle. Citus, which extends PostgreSQL for distributed querying, can do all three: it colocates joins on the distribution column for free, broadcasts small reference tables automatically, and can plan shuffle joins for the rare cross-distribution case. The interview-level takeaway is that you should engineer your schema so that 99% of joins are colocated, accept broadcast joins for small dimension tables, and treat shuffle joins as a red flag that your shard key or your data model is wrong.

## Sharded Counters and Aggregations

Global counters are a surprisingly hard problem in a sharded system because the whole point of sharding is that no single node sees all the writes, so a naive `UPDATE counters SET count = count + 1` would have to be a cross-shard transaction on every increment. The standard solution is a *sharded counter*: instead of one row holding the count, you maintain N counter rows (one per shard, or more) and each increment writes to one of them chosen at random or by shard affinity. The total count is obtained by scatter-gathering a `SUM` across all counter rows, which is eventually consistent and cheap to read even though each individual increment is a single-shard local write. Google's original MapReduce paper and the App Engine docs made this pattern famous for view counters and like counts. The trade-offs are clear: writes scale linearly with the number of counter shards (no contention on a single row), reads require a fan-out and are only as fresh as the last scatter-gather, and you must size the number of counter shards to the write rate — too few and a single counter row becomes a hot row again, too many and reads pay a larger fan-out cost. The same principle generalizes to any global aggregation: maintain per-shard partial aggregates and combine them at read time, accepting that you have moved from strong to eventual consistency for the aggregate.

For approximate global counts where exactness is not required, probabilistic structures let you avoid the fan-out entirely. HyperLogLog maintains a constant-size cardinality sketch that can be merged across shards by taking the max of the registers, giving you a distinct-count with roughly 1% error in a few kilobytes regardless of how many billions of events you have seen. Count-Min Sketch does the same for frequency estimates. These are the data structures behind "unique viewers in the last 24 hours" counters at Twitter and Reddit scale, where a scatter-gather sum over sharded counters would itself be a bottleneck.

## Replication Modes

Replication creates copies of data, and the critical design axis is *how the primary acknowledges writes relative to how many replicas have applied them*, which is fundamentally a latency-versus-durability trade-off. In *synchronous replication*, the primary waits for at least one replica to durably write the transaction to its own log before acknowledging the commit to the client. This guarantees that the committed data survives a primary failure (no committed transaction is lost) and that the replica is an exact, up-to-date copy, but it makes every write pay the round-trip latency to the replica, so throughput is bounded by the slowest replica and a slow or stalled replica can block the primary entirely. Synchronous replication is used when data loss is unacceptable — financial ledgers, configuration stores — and is the default in systems like PostgreSQL's synchronous commit mode and Spanner's Paxos groups.

In *asynchronous replication*, the primary writes to its own log and acknowledges the commit immediately, then ships the log (often via a WAL stream or binlog) to replicas in the background. This gives the primary full write throughput independent of replica health and adds zero replica latency to the write path, which is why it is the default in MySQL and the common case in PostgreSQL. The cost is *replication lag*: the replica is always some milliseconds to seconds behind the primary, so reads from a replica can return stale data, and if the primary crashes with unreplicated transactions in its log those transactions are permanently lost on failover. The window is usually small (sub-second on a healthy LAN) but it is non-zero and it widens under load, which is the root of the "read-your-writes" consistency problem.

*Semi-synchronous replication* is the pragmatic middle ground used by most production MySQL deployments and by PostgreSQL's reputation-based quorum modes. The primary acknowledges the commit as soon as *at least one* replica (or a configurable number) has received the transaction, but it does not wait for all replicas and does not necessarily wait for the replica to durably flush. This bounds the potential data loss on failover to at most the transactions that were acknowledged by the primary but not yet acknowledged by any replica, which in steady state is near zero, while keeping write latency close to the asynchronous case because you wait on only one replica rather than the full fleet. The subtlety is that "at least one replica received it" is weaker than "at least one replica durably committed it" — if you need the stronger guarantee you configure the replica to ack only after a sync flush, which costs latency but eliminates loss. Interviewers often probe exactly this distinction: semi-sync trades a small, bounded durability risk for most of the latency benefit of async, and the knob is how durable the ack must be.

Beyond the ack timing, replication also differs in topology. *Single-leader* (primary-replica) is the most common: one primary takes writes, N replicas serve reads, failover promotes a replica. *Multi-leader* (multi-active) lets several nodes accept writes and replicate to each other, which is great for geographic locality and write availability but introduces write conflicts that must be resolved by last-writer-wins timestamps, CRDTs (Conflict-free Replicated Data Types — data structures like counters or sets that can be merged automatically without conflict), or application logic — conflict resolution is genuinely hard and is why multi-leader is rare outside geographically distributed deployments. *Leaderless* (Dynamo-style, used by Cassandra and Riak) has no designated leader: the client writes to N nodes and reads from R nodes, and if `W + R > N` the read is guaranteed to see the latest write (a quorum). Leaderless systems have excellent write availability and no failover concept, but they require read-repair to reconcile divergent replicas and application-level conflict tolerance for the eventual-consistency window.

```
              REPLICATION TOPOLOGIES

   PRIMARY-REPLICA                 MULTI-LEADER
   ──────────────                  ────────────

       ┌─────────┐                ┌─────────┐ ⇄ ┌─────────┐
       │ Primary │                │ Leader A│──▶│ Leader B│
       │(writes) │                │(writes) │   │(writes) │
       └────┬────┘                └────┬────┘   └────┬────┘
            │ WAL/binlog               │ replicate    │ replicate
      ┌─────┴─────┐                   ▼              ▼
      ▼           ▼               ┌──────┐      ┌──────┐
   ┌──────┐   ┌──────┐            │Repl A│      │Repl B│
   │Repl 1│   │Repl 2│            │reads │      │reads │
   │reads │   │reads │            └──────┘      └──────┘
   └──────┘   └──────┘

   1 writer, N readers             N writers; conflict resolution
   ✓ simple, strong consistency    ✓ geo locality + write availability
   ✗ write capacity = 1 node       ✗ write conflicts, hard to merge
```

| Mode | Primary acks after… | Write latency | Data loss on failover | Typical use |
|------|---------------------|---------------|----------------------|-------------|
| Synchronous | ≥1 replica durably commits the txn | high (RTT to a replica) | none — committed txns survive | financial ledgers, config stores; Postgres sync commit, Spanner |
| Asynchronous | its own log write only | low (no replica wait) | any unreplicated txn is lost | MySQL default; common Postgres |
| Semi-synchronous | ≥1 replica has received it (configurable flush) | near-async | bounded — acked-but-unreplicated txns only | most production MySQL; Postgres quorum |

| Topology | Writers | Conflict resolution | Failover | Best for |
|----------|---------|---------------------|----------|----------|
| Single-leader (primary-replica) | 1 primary | none needed | promote a replica | most common workloads; simple consistency |
| Multi-leader (multi-active) | N leaders | last-writer-wins / CRDTs / app logic | N/A — multi-active | geo-distributed deployments |
| Leaderless (Dynamo-style) | any of N (W quorum) | read-repair + app tolerance | none — no leader concept | high write availability; Cassandra, Riak |

## Read Replicas and Write Scaling

Read replicas are the first scaling lever most teams reach for, and they are effective as long as your workload is read-heavy, which the majority of web workloads are. The pattern is straightforward: the primary handles all writes and strong-consistency reads, and a pool of replicas serves the read-heavy traffic that can tolerate eventual consistency. A social feed, a product catalog, a search index all fit this shape. The operational challenges are replica lag management and read routing. Replica lag is measured continuously and exposed as a metric; the router must decide, for each read, whether it can go to a replica (accepting staleness) or must go to the primary (requiring freshness). The common policy is *read-your-writes consistency*: any read that might be observing the user's own just-written data goes to the primary or to a replica confirmed to have replayed past the user's last write timestamp, while reads from other users or anonymous traffic go to any replica. Without this, users see maddening "I just saved it but it's gone" glitches. Some systems (PostgreSQL's `synchronous_commit=remote_apply`, Vitess's `@primary` / `@replica` targeted reads) let you pin specific reads to the primary or to a replica with applied lag under a threshold.

Read replicas scale reads horizontally but they do *not* scale writes, because every replica must apply every write — adding replicas increases the write fan-out and the primary's replication load without increasing aggregate write capacity. This is the essential asymmetry to internalize: replication scales reads, sharding scales writes. When writes outgrow a single primary you must shard, and the transition from "one primary plus replicas" to "many primaries each with their own replicas" is the architectural inflection point that most teams underestimate. Until that point, you can extract more write headroom from a single primary by vertical scaling (bigger box, faster disks), by moving workloads off the primary (running analytics on a replica, moving search to Elasticsearch), and by batching and reducing write amplification, but these are all delays, not solutions.

## Hot Shard Mitigation

A hot shard is a shard receiving disproportionate traffic, and it is the failure mode that turns a theoretically even hash distribution into a real-world bottleneck. Hot shards arise from three causes, each with a different remedy. A *hot key* is a single shard-key value that receives a large fraction of all traffic — a celebrity's user record on a social network, a viral post's like counter, a globally shared configuration row. The fix is to break the key apart: sharded counters for the like count, caching the celebrity profile in a CDN or memcached so the database is bypassed, or replicating that one row to every shard as a broadcast read. A *hot range* arises in range-based sharding where all new inserts land on the shard owning the top of the key space; the fix is to pre-split ranges aggressively or to use a hash of a high-cardinality key instead of a monotonic one. A *hot shard from skew* happens when the hash distribution is even but the *workload* per key is not — a few tenants generate 80% of the traffic — and the fix is directory-based placement that assigns heavy tenants to dedicated or over-provisioned shards, essentially manual rebalancing guided by traffic metrics rather than by key distribution alone.

The general principle is that you cannot rely on the shard key alone to guarantee even load, because real workloads are power-law distributed. You need continuous monitoring of per-shard CPU, I/O, query latency, and connection count, and you need a playbook for moving a hot tenant or splitting a hot range without downtime. Systems like Vitess expose live shard metrics and support online shard splits; Cassandra's vnodes and dynamic snitching down-rank slow nodes for reads; and at the application layer a read-through cache in front of the hottest keys is almost always cheaper than resharding.

## Resharding Without Downtime

Resharding — changing the number of shards or the placement of keys — is the hardest operational task in a sharded system, and doing it without downtime is a recurring interview topic because it forces you to combine replication, dual-write, and cutover techniques. The naive approach of taking the cluster offline, rehashing all data, and bringing it back up is unacceptable for any real production system, so the industry-standard pattern is a multi-phase online migration. The first phase is *dual-write*: the application is configured to write every change to both the old shard layout and the new shard layout, so that new data is present in both places from the moment the migration starts. The second phase is *backfill*: a background job reads historical data from the old shards and copies it into the new shards, typically using a cursor over the shard key and a change-data-capture stream to apply any concurrent writes that occurred during the backfill. Because dual-write is already capturing new changes, the backfill only needs to catch up to the moving frontier, and once it converges the new shards are a complete, current copy. The third phase is *verification*: a checksum or sampled comparison between old and new confirms they agree, catching any dual-write bug or backfill gap. The fourth phase is *cutover*: the router switches reads (and then writes) from the old shards to the new shards, ideally behind a feature flag so it can be instantly rolled back. The final phase is *cleanup*: dual-write is disabled and the old shards are decommissioned after a watch period.

```
        RESHARDING MIGRATION FLOW (5 phases, online)

   ┌────────────┐     ┌────────────┐     ┌────────────┐
   │ 1. DUAL    │────▶│ 2. BACKFILL │────▶│ 3. VERIFY  │
   │    WRITE   │     │             │     │            │
   └────────────┘     └────────────┘     └────────────┘
   app writes to      bg job copies      checksum /
   old + new layout   old → new shards   sampled compare
                      (CDC catches
                       concurrent writes)        │
                                                 ▼
   ┌────────────┐     ┌────────────┐
   │ 5. CLEANUP │◀────│ 4. CUTOVER │
   │            │     │            │
   └────────────┘     └────────────┘
   disable dual-      router flips reads
   write, retire      then writes to new
   old shards         (behind a flag,
                      instant rollback)
```

Vitess implements exactly this flow with its vreplication (migration replication) feature: it streams changes from source shards to target shards continuously, supports a `MoveTables` workflow that handles dual-write, backfill, verify, and cutover as managed phases, and lets you cut over with a single command and roll back just as easily. The keys to making this safe are that the cutover is a routing change (instant, reversible) rather than a data move, that dual-write guarantees no data is lost during the migration window, and that verification catches divergence before the cutover rather than after. The mistake that ruins resharding is trying to migrate by copying data and then flipping, without dual-write — any write between the copy and the flip is lost, and any write to the old shard after the flip is orphaned. Dual-write is non-negotiable for a correct online reshard.

## Vitess and Citus

Vitess and Citus are the two most prominent open-source systems for sharding a relational database, and they illustrate two different philosophies worth understanding for interviews. Vitess, born at YouTube and now a CNCF project, is a sharding layer *in front of* MySQL: it provides a proxy (vtgate) that accepts SQL, parses it, routes each query to the correct shard (vttablet) based on a vindex (the shard key mapping, which can be hash-based, range-based, or a lookup vindex for directory-style sharding), and merges results for scatter queries. Because it sits in front of unmodified MySQL, you inherit MySQL's storage engine and replication, and Vitess adds the sharding logic, the topology service, the online resharding workflows, and a transaction model that supports cross-shard transactions with best-effort or two-phase-commit semantics. Vitess is the system that powers YouTube, Slack, Square Cash, and GitHub's early sharding, and it is the canonical answer to "how do you shard MySQL at scale."

Citus, by contrast, is a PostgreSQL *extension* rather than a proxy: it extends the Postgres planner and executor so that a single Postgres coordinator can distribute tables across worker nodes, push query fragments down to the workers, and merge results back, all within the Postgres query engine rather than alongside it. You mark a table as distributed with `SELECT create_distributed_table('orders', 'user_id')` and Citus automatically shards it by hashing the distribution column into 32 (by default) shard placements spread across the workers. Joins on the distribution column are colocated and run locally on each worker; small reference tables can be marked as reference tables that are broadcast to every worker for cheap broadcast joins; and the coordinator handles the rare shuffle join by repartitioning data on the fly. Citus is now part of the Postgres ecosystem (acquired by Microsoft, available as a managed Hyperscale option in Azure), and it is the canonical answer to "how do you scale Postgres horizontally." The architectural contrast is instructive: Vitess is a sharding proxy over an unchanged storage engine, while Citus is a sharding-aware extension that modifies the engine itself — the former is more portable and storage-engine-agnostic, the latter is more integrated and can push more optimization into the planner.

## Capacity Planning

Capacity planning for a sharded system is the practice of deciding how many shards you need and how big each should be, and it is driven by three independent constraints that all must be satisfied simultaneously. The *storage* constraint is the simplest: total dataset size divided by number of shards must fit comfortably on one node's disk, with headroom for growth and for the post-compaction size of indexes. The *write throughput* constraint says that the per-shard write rate (total writes divided by shards, adjusted for skew) must stay under the per-node write ceiling, which for a typical MySQL or Postgres primary on fast NVMe is on the order of tens of thousands of writes per second before you hit log or replication bottlenecks. The *memory* constraint says the working set of hot data per shard should fit in the node's RAM for good cache hit rates; if the hot working set is larger than RAM you will be disk-bound regardless of how many shards you have, and adding shards helps only insofar as it shrinks the per-shard hot set. The binding constraint is whichever of these runs out first, and a common planning error is to size only for storage while ignoring write throughput, resulting in a few enormous shards that are disk-rich but CPU-poor.

Concrete numbers and targets to plan against:

- **Per-node write ceiling** (MySQL/Postgres primary, fast NVMe): on the order of tens of thousands of writes/second before hitting log or replication bottlenecks.
- **Per-shard target:** aim for ~half of the node's observed write ceiling, leaving headroom for skew and growth.
- **Skew multiplier:** design for the hottest shard to carry **2–3×** the average load; the per-shard ceiling must absorb that multiplier.
- **Planning horizon:** project write rate and dataset size roughly **18 months** out.
- **Shard count formula:** `max(storage-driven count, write-driven count)`, then validated against the memory working-set constraint.
- **Shard count alignment:** keep it a **power of two** or a **multiple of the replication factor** so future resharding stays cheap.

A concrete planning approach is to start from the projected write rate and dataset size at the horizon date (say, 18 months out), pick a per-shard target that is half of the node's observed ceiling to leave headroom for skew and growth, and compute the shard count as the maximum of the storage-driven and write-driven counts. Then validate against the memory working-set constraint. Always plan for skew: real traffic is rarely perfectly uniform, so design for the hottest shard to carry 2-3x the average load, which means your per-shard ceiling must absorb that multiplier. Plan the resharding path before you need it — knowing whether you will split shards (add shards within an existing key range, requiring data migration of half of each shard) or add new hash buckets (requiring a full consistent-hash rebalance) — because the architecture decisions that make future resharding cheap, such as using consistent hashing and keeping the shard count a power of two or a multiple of your replication factor, must be made at the initial design. The rule interviewers reward is that capacity planning is not a one-time calculation but a continuous discipline: measure the actual per-shard load distribution, track the gap between current and ceiling, and trigger a reshard when you cross the threshold that leaves you enough lead time to migrate before you hit the wall.

---

## Interview Question

**Q: Walk me through how you would shard a rapidly growing multi-tenant SaaS database that is hitting the write ceiling of a single Postgres primary. How do you choose the shard key, handle cross-tenant analytics, and plan to double the shard count next year without downtime?**

**Model answer:** "I would shard by `tenant_id` using hash-based distribution — specifically, I'd use Citus or an equivalent consistent-hashing router so that adding shards later only remaps the keys in the affected arc rather than the whole keyspace. `tenant_id` is the right key because every transactional query in a multi-tenant product is already scoped to a tenant, so sharding on it makes nearly all reads and writes single-shard and makes every join between tenant-scoped tables colocated and free. The dominant access pattern — 'load this tenant's data' — hits exactly one shard. For the rare very large tenant that would alone overload a shard, I'd use directory-based placement to pin that tenant to a dedicated shard or a pair of shards, since the hash distribution would otherwise let one tenant dominate a shard.

For cross-tenant analytics — 'total revenue across all tenants last month' — I would not run that against the transactional shard store, because it's a scatter-gather over every shard that competes with the OLTP workload. Instead I'd stream changes from the shards via logical replication or a CDC tool like Debezium into a separate analytics warehouse — ClickHouse, BigQuery, or a columnar Postgres — where full-table scans and global aggregations are cheap and isolated from the production write path. Global counters that the application needs in real time, like a platform-wide active-user count, I'd implement as sharded counters with per-shard partial sums merged at read time, or as a HyperLogLog sketch for cardinality, accepting eventual consistency.

For doubling the shard count next year, I'd plan the reshard as a four-phase online migration: enable dual-write to both the current and the new shard layout so every new change lands in both; backfill the historical data from old to new shards using CDC to catch concurrent writes; verify with checksums that old and new agree; then cut over the router from old to new behind a feature flag, with instant rollback. Because the routing uses consistent hashing, the new shards only take ownership of the arc ranges assigned to them, so the backfill is bounded to roughly half the data rather than the entire keyspace. The cutover itself is a routing change, not a data move, so it's instant and reversible. The thing I would never do is rehash by modulo and flip without dual-write — that loses writes in the gap between copy and cutover."

**Common pitfall to mention:** "The classic mistake is sharding on `tenant_id` but then needing a query that is *not* tenant-scoped — like a global admin dashboard or a cross-tenant search — and trying to serve it with a scatter-gather against the shards. That query will be slow, it will compete with the OLTP workload, and as the cluster grows the fan-out latency will grow with it. The fix is to recognize up front which queries are not tenant-scoped and route them to a separate system — a search index, an analytics warehouse, a denormalized aggregate table — rather than forcing the sharded OLTP store to serve workloads it was never designed for. A related mistake is ignoring the heavy-tenant problem: if one tenant is 30% of your traffic, hash sharding puts 30% of your load on one shard, and you need directory-based placement for that tenant before it takes down its shard."

---

## Key Terms

**Shard key** — the column (or columns) whose value determines which shard a row lives on; the most consequential and hardest-to-change decision in a sharded design. **Hot shard** — a shard receiving disproportionate traffic, caused by a hot key, a hot range, or workload skew; mitigated by sharded counters, caching, pre-splitting, or directory-based placement. **Cross-shard transaction** — a transaction spanning multiple shards, which requires two-phase commit or best-effort coordination and is expensive enough that well-designed systems avoid it. **Scatter-gather** — the query pattern of fanning a non-shard-key query to every shard, running it locally, and merging at the router; bounded by the slowest shard. **Colocated join** — a join between two tables sharded on the same key, where matching rows are guaranteed on the same shard and the join is local and free. **Read replica** — a read-only copy of the primary, fed by WAL or binlog replication, used to scale reads; subject to replica lag. **Replica lag** — the delay between a write on the primary and its application on a replica; the source of stale reads and the reason for read-your-writes routing. **Semi-synchronous replication** — the primary acks a write once at least one replica has received it, bounding data loss on failover while keeping latency near the async case. **WAL (Write-Ahead Log)** — the durable log of changes that the primary writes before ack and that replicas replay to stay in sync. **GTID (Global Transaction ID)** — a globally unique, monotonic identifier for each transaction in MySQL replication, enabling consistent failover and replica positioning. **Quorum** — in leaderless systems, the condition `W + R > N` that guarantees a read sees the latest write by overlapping the write and read replica sets. **Vindex (Vitess)** — the shard-key mapping function in Vitess (hash, numeric range, or lookup-based) that determines row placement and can be changed via online resharding. **Vnode** — a virtual node placement on a consistent-hashing ring; multiple vnodes per physical node smooth out the owned arc length to balance load. **CDC (Change Data Capture)** — streaming the WAL or binlog as an event stream, used for backfilling replicas, feeding analytics, and driving online reshard migrations.

## Interview Cheat Sheet

**Key Points to Remember:**
- Replication scales reads; [[Glossary#Sharding|sharding]] scales writes. Adding read replicas does not increase write capacity — every replica must apply every write.
- The [[Glossary#Shard Key|shard key]] is the most consequential and hardest-to-change decision; choose it around the write path and primary read path, not analytic queries. `user_id` or `(tenant_id, user_id)` are canonical good keys.
- Consistent hashing makes resharding bounded: adding a shard migrates ~1/N of data instead of ~all of it. Use it as the routing layer's mechanism.
- Online resharding requires dual-write (write to both old and new layout) + backfill + verify + cutover behind a feature flag. Never migrate by copying then flipping without dual-write — you lose writes in the gap.
- Design for the hottest shard to carry 2–3x the average load; size per-shard capacity to absorb that multiplier.

**Common Follow-Up Questions:**
- *How do you handle a query that isn't scoped to the shard key?* — It becomes a scatter-gather (fan-out to all shards, merge at the router). For frequently-needed non-shard-key queries, maintain a denormalized copy colocated with the shard key, or push the workload to a separate analytics system via CDC.
- *How do you handle a single tenant that's 30% of your traffic?* — Hash sharding puts 30% of load on one shard. Use directory-based placement to pin that tenant to a dedicated or over-provisioned shard.
- *Synchronous vs asynchronous replication — which do you choose?* — Synchronous guarantees zero data loss on failover but adds replica round-trip latency to every write. Asynchronous has no latency cost but risks losing unreplicated writes on failover. Semi-synchronous (wait for ≥1 replica to receive, not flush) is the pragmatic middle ground for most production deployments.

**Gotcha:**
- The classic mistake is sharding on `tenant_id` and then trying to serve a global/cross-tenant query (admin dashboard, global search) with a scatter-gather against the shards. That query will be slow, will compete with the OLTP workload, and will get worse as the cluster grows. The fix is to recognize non-tenant-scoped queries up front and route them to a separate system — not to force the sharded store to serve a workload it was never designed for.
