---
title: "Database Indexing & Query Optimization"
type: system-design
category: Basics
date: 2026-05-08
difficulty: "advanced"
read_time: 24
listen_time: 34
tags: [system-design, interview, basics, databases, indexing, query-optimization, postgresql]
---

# Database Indexing & Query Optimization

## Summary & Interview Framing

The practice of creating and maintaining data structures (B-trees, hash indexes) that accelerate query performance, plus the query planning that chooses which index to use. It covers index selection, composite column ordering, write-amplification trade-offs, and the cost-based optimizer's access path selection.

**How it's asked:** "A query that used to take 10ms now takes 5 seconds after a schema change. Walk me through your diagnosis — execution plans, index analysis, and optimization strategy."

## Overview

Indexing is the single highest-leverage lever a backend engineer has over read latency in a relational database. At staff level the expectation is not merely "know what an index is" but the ability to reason about on-disk data structures, predict which access path the query planner will choose, quantify the write-amplification tax each index imposes, and defend storage and memory budgets against unconstrained index growth. A well-designed indexing scheme can collapse a forty-five second sequential scan into a two-millisecond index lookup; a poorly-designed one silently turns every INSERT into a five-index write storm, bloats the buffer pool, and pushes checkpoint I/O into the foreground latency path. The discipline therefore lives at the intersection of data structure theory, storage internals, and query-cost modelling, and this note covers all three layers in the depth an interviewer expects.

## Key Requirements

### Functional Requirements
- Accelerate SELECT, WHERE, JOIN, GROUP BY, ORDER BY, and uniqueness enforcement over tables that may hold hundreds of millions of rows.
- Support equality, range, prefix, and set-membership predicates, plus ordering and covering-scan access patterns.
- Support composite and partial predicates that mirror real application query shapes, not theoretical ones.

### Non-Functional Requirements (SLAs)
- Write amplification budget: every additional secondary index multiplies INSERT/UPDATE/DELETE work; the cost must be justified by read gain.
- Storage overhead: composite B-tree indexes typically consume 2–10× the logical size of the columns they cover once page fill factors, free space maps, and bloat are accounted for.
- Buffer-pool residency: an index that does not fit in shared buffers becomes random I/O, which on SSD is ~4× and on HDD ~100× a sequential page read.
- Lock and latch contention on hot index pages, especially the rightmost leaf of a monotonically increasing key (sequences, timestamps).

## Index Data Structures: B-tree vs B+tree

The default index in PostgreSQL, MySQL InnoDB, SQLite, Oracle, and SQL Server is a balanced multi-way tree, but the precise variant matters. A classic B-tree stores both keys and payload in internal and leaf nodes; every node is a sorted array of (key, pointer, value) triples, and a lookup may terminate at any level once the key is found. A B+tree, which is what InnoDB and most modern engines actually implement, stores keys and child pointers in internal nodes but relegates all row data (or row references) exclusively to leaf nodes, and links those leaves together in a doubly-linked list. This single design choice has deep consequences: range scans in a B+tree become a sequential walk along the leaf chain rather than a recursive traversal back up and down the tree, which is why `WHERE created_at BETWEEN x AND y ORDER BY created_at` can be served with essentially one tree descent plus streaming I/O.

```
                          B+TREE STRUCTURE
   (internal nodes = keys + child pointers; leaves = row refs, linked)

                         +-------------------------------+
   Root / Internal  ->   |   10   |   20   |   30   | 40 |
                         +-------------------------------+
                          /       |       |       |      \
                         /        |       |       |       \
                  +---------+ +--------+ +--------+ +---------+
   Internal      | 1..10   | | 11..20 | | 21..30 | | 31..40  |
                  +---------+ +--------+ +--------+ +---------+
                     |          |          |          |
                     v          v          v          v
   Leaf (data):  [1,3,7,10] [11,15,20] [21,25,30] [31,35,40]
                   <----->    <----->    <----->    <----->
                   doubly-linked list  =>  range scans walk the chain
                                          in one streaming pass

   fanout ~1000 with 16KB pages => 10^9 rows in ~3 levels
   => point lookup touches <= 3 pages + leaf
```

The fanout of a B+tree is enormous because internal nodes carry only keys and pointers, not payloads. A 16 KB InnoDB page holding 8-byte primary keys and 6-byte child pointers can branch to roughly a thousand children, so a one-billion-row table is covered in only three levels of tree — log1000(10^9) ≈ 3 — meaning every point lookup touches at most three pages plus the leaf, and the top two levels are almost always resident in the buffer pool. This is the structural reason B+tree point lookups are effectively O(log_f N) with f in the hundreds-to-thousands, not the textbook O(log2 N) that assumes binary fanout. The trade-off is that non-clustered (secondary) B+tree indexes store a copy of the primary key at the leaf rather than a physical row pointer, so a secondary index lookup that needs columns not in the index becomes a two-tree traversal: descend the secondary tree, extract the primary key, then descend the clustered tree. This is the origin of the covering-index optimisation discussed below.

### Clustered vs Non-Clustered

A clustered index dictates the physical sort order of the table itself, so there is exactly one per table — InnoDB makes the primary key the clustered index by default, and the leaf pages ARE the table pages. A non-clustered (secondary) index is a separate B+tree whose leaves hold (indexed columns, primary key) tuples; it does not control heap layout. The practical consequence is that a secondary index range scan that needs non-indexed columns pays one random clustered-tree descent per matching row, which on a large cold table can be catastrophic. Engineers who treat "the index is used" as a success signal miss this: `EXPLAIN` may show `Index Range Scan` while the query still takes seconds because of a thousand bookmark lookups into the clustered index behind the scenes.

## Index Type Comparison

| Feature | B-tree | B+tree | Hash | BRIN |
|---|---|---|---|---|
| Equality (`=`) lookup | Yes | Yes | Yes (O(1)) | Approximate |
| Range / `BETWEEN` | Yes | Yes | No | Coarse only (block ranges) |
| `ORDER BY` | Yes | Yes | No | No |
| Prefix matching | Yes | Yes | No | No |
| Fanout per page | moderate | very high (100s–1000s) | n/a | n/a |
| Leaf structure | keys + values | keys + refs, linked list | buckets | per-range min/max summary |
| Range scan cost | recursive up/down | sequential leaf walk | impossible | skip whole ranges |
| Typical use | (older engines) | default in InnoDB/PG/SQLite | session/equality, dedup | append-only time-series |
| Crash-safe | yes | yes | PostgreSQL >= 10 | yes |
| Space cost | medium | medium | low | very low (~1000× smaller) |

## Hash Indexes

A hash index maps a key through a hash function into a fixed-size bucket array, giving O(1) average lookup for strict equality predicates (`=`, `IN` with small cardinality). It does not preserve order, so it cannot serve range queries, `BETWEEN`, `ORDER BY`, or prefix matching, and it cannot be used to satisfy a covering scan because only the hashed value and row locator are stored. PostgreSQL's hash indexes were historically not WAL-logged and thus unsafe after a crash, but since version 10 they are crash-safe and replication-safe, making them viable for pure-equality workloads like session lookups or deduplication maps where the O(log N) B-tree descent is measurable overhead at very high QPS. InnoDB has an adaptive hash index layer that automatically builds in-memory hash entries on hot B-tree pages; for most workloads this is a net win, but under heavy concurrent writes it can become a contention point on the hash mutex and is sometimes disabled on large, write-heavy deployments.

## Index Lookup Flow

```
   Query: SELECT total FROM orders
          WHERE user_id = 42 AND created_at > '2026-06-01'

   [1] DESCEND SECONDARY INDEX (user_id, created_at)
                     |
                     v
            +----------------+
            |  root page     |  <-- buffer pool hit (almost always resident)
            +----------------+
                     |
                     v
            +----------------+
            |  internal page |
            +----------------+
                     |
                     v
            +----------------+
            |  leaf page     |  seek to user_id=42 subtree,
            +----------------+  walk created_at > '...' along leaf chain
                     |
                     |  yields (PK list) for matching entries
                     v
   [2] DESCEND CLUSTERED INDEX for each PK  (the "heap fetch" / bookmark lookup)
                     |
                     v
            +----------------+
            |  heap/leaf pg  |  fetch row, project (total)
            +----------------+
                     |
                     v
                 [ RESULT SET ]

   NOTE: if the secondary index is COVERING (INCLUDE total),
         step [2] vanishes -> Index-Only Scan, no random heap I/O
```

## Composite Indexes and Column Order

A composite index is a B+tree over an ordered tuple of columns, and its usefulness is governed entirely by the leftmost-prefix rule: the index can only be "seeked" (used to narrow the search via tree descent) for predicates on a contiguous prefix of its column list. A query with `WHERE status = 'active' AND created_at > '2026-01-01'` can use an index on `(status, created_at)` because the equality on the first column pins a subtree and the range on the second walks a contiguous leaf range. The reverse index `(created_at, status)` cannot seek on the range-first predicate in the same way — the range on the leading column opens many subtrees, and the equality on `status` becomes a filter applied during the scan rather than a seek constraint, dramatically increasing rows examined.

The deeper principle is index selectivity, often written as the fraction of rows a predicate eliminates: a column with cardinality C over N rows has selectivity roughly 1/C for uniformly distributed values, and a composite index is most effective when the leftmost columns are the most selective under the actual query workload. Selectivity is not a property of the column alone but of the predicate against the data distribution — `WHERE country = 'US'` on a table where 80% of rows are US-based is low selectivity despite country having high global cardinality, and the planner will correctly estimate that a full scan is cheaper than an index scan that returns most of the table. The staff-level insight is to order composite index columns by (equality columns first, then range columns, then order-by columns), and within the equality group by descending selectivity, while always validating against `EXPLAIN` row estimates rather than rules of thumb. PostgreSQL's extended statistics (`CREATE STATISTICS`) can capture multi-column correlations that the default single-column statistics miss, which matters when two columns are individually low-selectivity but jointly highly selective.

## Covering Indexes and Index-Only Scans

A covering index is one whose column set includes every column referenced by the query — filter columns, join columns, and projected columns — so the executor can answer the query entirely from the index without touching the heap or clustered table. This is called an index-only scan, and it is the single most powerful optimisation for high-QPS read endpoints because it collapses a random I/O per row into a sequential leaf scan. PostgreSQL implements this with the `INCLUDE` clause: `CREATE INDEX idx_orders_cover ON orders(user_id, created_at) INCLUDE (total, status)` keeps `(user_id, created_at)` as the seekable B-tree key and stores `(total, status)` as payload in the leaf without making them part of the sort order, so they cannot be used for further seeking but can be returned without a heap fetch. InnoDB secondary indexes implicitly include the primary key columns, so a query that projects only the indexed columns plus the PK is automatically covering.

The critical caveat is visibility. An index-only scan still requires the executor to confirm that the indexed row version is visible to the current transaction, which in PostgreSQL means consulting the visibility map — a bitmap marking pages where all tuples are visible to everyone. If a page has recently been updated, the visibility map bit is clear and the executor must fetch the heap tuple to check MVCC (Multi-Version Concurrency Control — a technique where the database keeps multiple versions of each row so that readers don't block writers) visibility, degrading the index-only scan back into a heap fetch. Frequent VACUUM (or autovacuum tuned aggressively enough) is what keeps the visibility map dense and index-only scans fast; a table that is constantly updated will not enjoy index-only scans even with a perfect covering index. This is an operational detail that interviewers love because it separates people who have run production Postgres from those who have only read the manual.

## Partial Indexes

A partial index is restricted to rows matching a WHERE predicate in its definition, for example `CREATE INDEX idx_orders_pending ON orders(created_at) WHERE status = 'pending'`. The resulting index is physically tiny — only the matching rows — which means it is far more likely to stay resident in the buffer pool, its maintenance cost applies only to writes that touch pending rows, and the planner can use it whenever a query's WHERE clause logically implies the index predicate. Partial indexes are extraordinarily effective for the common pattern where a small fraction of rows are "hot": pending orders, unread notifications, unverified accounts, soft-deleted records flagged for cleanup. An index over ten million orders that contains only the two thousand currently pending is effectively free to scan and trivially cache-resident.

The planning implication is important: the query must contain a predicate that the planner can prove implies the index predicate. `WHERE status = 'pending' AND created_at > NOW() - INTERVAL '1 day'` implies the partial index predicate and uses it; `WHERE created_at > NOW() - INTERVAL '1 day'` alone does not, because it could match non-pending rows, so the index is unavailable. This means partial indexes are designed for specific query shapes, not general-purpose, and a schema with many partial indexes is a signal of a workload with well-understood access patterns.

## Index Selectivity and Full Table Scan Avoidance

The query planner chooses between a sequential scan and an index scan by estimating the cost of each, and the dominant input is the predicted number of rows returned. The cost model is roughly `cost = seq_page_cost × pages + cpu_tuple_cost × rows` for a sequential scan versus `random_page_cost × index_pages + cpu_tuple_cost × rows + random_page_cost × heap_pages` for an index scan, with `random_page_cost` defaulting to 4.0 (tuned for spinning disks but commonly lowered to 1.1–2.0 on NVMe where random and sequential reads have similar latency). When a predicate is selective — returning perhaps 1–5% of a large table — the index scan touches far fewer pages and wins. When the predicate returns 30% or more of the table, the sequential scan wins because reading the whole table in one streaming pass is cheaper than thousands of random heap fetches, and the planner correctly prefers it. An index that is not used is not necessarily a bad index; it may be that the query is genuinely unselective and the planner is right.

This is the heart of full-table-scan avoidance: you do not eliminate scans by adding indexes indiscriminately, you eliminate them by ensuring the hot query predicates are selective AND covered by an index whose column order matches the predicate shape. A query like `WHERE created_at > '2026-01-01'` on a time-series table where 60% of rows are newer than that date will always scan, and no index fixes that — the fix is to narrow the predicate (add an `AND status = ...`), partition the table by time so the scan is bounded to one partition, or precompute the result into a materialised view. The anti-pattern to avoid is reflexively adding an index on every column that appears in a WHERE clause; this creates an index graveyard that slows writes, wastes memory, and is never used because the underlying predicates are unselective. `pg_stat_user_indexes` with `idx_scan = 0` over a representative monitoring window is how you find and drop such indexes.

## Query Plan Analysis and EXPLAIN

Reading `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)` output is the core diagnostic skill. `EXPLAIN` alone shows the planner's estimated plan and costs; `EXPLAIN ANALYZE` actually runs the query and shows estimated versus actual rows and timing per node; `BUFFERS` adds hit/shared/dirtied/written page counts which reveal whether the workload is cache-bound or I/O-bound. The plan is a tree read inside-out: the outermost node is the final result delivery, and leaves are the first I/O performed.

### EXPLAIN Node Types

| Node | Meaning | When it appears | Diagnostic signal |
|---|---|---|---|
| `Seq Scan` | Read entire table in physical order | no usable index, or predicate unselective | on a large table = missing/wrong index |
| `Index Scan` | Use index, then heap fetch per row | selective predicate, index exists | fine if rows low; watch `Rows Removed by Filter` |
| `Index Only Scan` | Covering index, no heap fetch | all columns covered + visibility map clear | ideal; verify `Heap Fetches = 0` |
| `Bitmap Index Scan` | Build TID bitmap from index | moderate selectivity, scattered matches | paired with `Bitmap Heap Scan` |
| `Bitmap Heap Scan` | Fetch heap pages in physical order from bitmap | follows `Bitmap Index Scan` | converts random I/O to ~sequential |
| `Nested Loop` | For each outer row, probe inner | small outer + indexed inner | catastrophic if both large / inner unindexed |
| `Hash Join` | Build hash on smaller side, probe with larger | equi-join, unsorted inputs | watch for batch spilling (raise `work_mem`) |
| `Merge Join` | Merge two sorted streams | both inputs pre-sorted on join key | ideal when index provides sort order |
| `Sort` | Explicit in-memory or on-disk sort | `ORDER BY` without matching index | `external merge Disk` => raise `work_mem` |

### Query Plan Execution Tree

```
   EXPLAIN plan for:
     SELECT u.email, o.total
     FROM users u
     JOIN orders o ON o.user_id = u.id
     WHERE u.country = 'US'
       AND o.created_at > NOW() - INTERVAL '30 days';

                    [ Hash Join ]   (build=users, probe=orders)
                       /      \
                      /        \
                     /          \
        [ Seq Scan: users ]   [ Index Only Scan: orders ]
         Filter: country='US'   Index Cond: user_id = u.id
         Rows est: 1.2M                  AND created_at > ...
         (no index on country)  Heap Fetches: 0  (covering!)
                                 Rows est: 80k

   READ OUTSIDE-IN / BOTTOM-UP:
     leaves execute first (I/O), root delivers final result.
   FOCUS on the node whose cost is ~95% of total => optimise there.
```

The most important reading habit is comparing `rows` (estimated) to `actual rows`. A gross mismatch — estimated 100, actual 5,000,000 — means the planner's statistics are stale or the column correlation is uncaptured, and the plan is likely wrong (a nested loop chosen because the planner thought the outer side was tiny). The fix is `ANALYZE` (or `VACUUM ANALYZE`), and for correlated multi-column predicates, `CREATE STATISTICS (dependencies, mcv) ON col1, col2 FROM table` followed by ANALYZE. The `cost` figures are in arbitrary planner units but their ratio matters: a node whose cost is 95% of the total is where to focus optimisation. The `actual time` is in milliseconds and is the ground truth for where wall-clock time goes.

A practical worked example:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT u.email, o.total
FROM users u
JOIN orders o ON o.user_id = u.id
WHERE u.country = 'US' AND o.created_at > NOW() - INTERVAL '30 days';
```

A bad plan shows `Seq Scan on orders` with `actual rows=8000000` and a `Nested Loop` outer, totalling forty seconds of random I/O. The diagnosis: no composite index on `orders(user_id, created_at)`, and the planner believed only a handful of orders matched. The fix is `CREATE INDEX ON orders(user_id, created_at) INCLUDE (total)` (covering, so the join probe returns total without a heap fetch), `ANALYZE orders`, and re-checking that the plan now shows `Index Only Scan on orders` with `Rows Removed by Index Recheck` low and total time under fifty milliseconds.

## Slow Query Optimization

The systematic workflow for a slow query is: capture the actual plan with `EXPLAIN (ANALYZE, BUFFERS, VERBOSE)`, identify the highest-cost node, classify the pathology, and apply the targeted fix. The recurring pathologies are:

- **Sequential scan where an index should exist** — add or fix the index.
- **Index scan with huge `Rows Removed by Filter`** — the index is selective on its leading column but a later predicate rejects most matches; column order is wrong or a more selective predicate is missing.
- **Nested loop with a large outer side** — add an index on the inner join column, or force a hash join if memory permits.
- **Explicit `Sort` spilling to disk** (`Sort Method: external merge Disk: 50000kB`) — add an index matching the `ORDER BY`, or raise `work_mem`.
- **Bitmap heap scan with high `Heap Fetches` and low `Rows Removed`** — the index is working but the result is scattered; consider clustering the table or moving to a covering index.
- **Hash join spilling to disk** (`Buckets: 131072 Batches: 16 Memory Usage: 40MB`) — raise `work_mem` to fit the hash table in a single batch.

`work_mem` is per-node, per-query, and per-sort-or-hash, so a single complex query with three sorts and two hashes can consume 5× work_mem. Setting it too high under concurrency causes OOM; the common production pattern is a modest global value (4–16 MB) with per-session raises for known heavy analytical queries. The `pg_stat_statements` extension is the macro view: it aggregates query text, calls, total time, rows, and buffer hit/miss ratios per query fingerprint, so `SELECT query, calls, total_exec_time, mean_exec_time, shared_blks_hit, shared_blks_read FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20` surfaces the queries that collectively consume the most database time, which is where indexing effort pays off most.

## Optimization Checklist

- Capture the real plan: `EXPLAIN (ANALYZE, BUFFERS, VERBOSE)` — never guess from query text alone.
- Find the highest-cost node; that is where effort pays off.
- Compare `rows` (estimated) vs `actual rows` — a big mismatch means stale stats; run `ANALYZE`.
- For correlated columns, add `CREATE STATISTICS (dependencies, mcv) ON ...` then `ANALYZE`.
- Ensure the hot predicate's leading column is the leftmost column of a composite index (leftmost-prefix rule).
- Order composite columns: equality first, then range, then order-by; within equality, most selective first.
- Make the index covering with `INCLUDE` for the projected columns to get an Index-Only Scan.
- Confirm `Heap Fetches = 0` on index-only scans; if not, tune autovacuum to keep the visibility map dense.
- Check join columns are indexed on the larger side and have matching types (no implicit cast disabling the index).
- Prune unused indexes via `pg_stat_user_indexes` (`idx_scan = 0` over a representative window).
- Raise `work_mem` per-session for heavy sorts/hashes that spill to disk; keep the global value modest.
- Use `pg_stat_statements` to rank queries by total time and focus indexing effort there.
- Re-run `EXPLAIN ANALYZE` after every change to confirm the plan actually improved.

## The N+1 Problem

The N+1 query problem is the most common cause of latency in ORM-driven applications: a query loads N parent rows, then the ORM lazily issues one additional query per parent to fetch children, producing 1 + N round trips where one JOIN would have sufficed. At N=1000 and 2ms per round trip this is two seconds of pure network latency with the database doing almost no work; the EXPLAIN of any single child query looks trivially fast, which is why the problem hides from query-level profiling and surfaces only at the endpoint latency level. The fixes are eager loading (Django's `select_related` for FK / `prefetch_related` for M2M, Rails' `includes`, SQLAlchemy's `selectinload` / `joinedload`), which issue one JOIN or one `IN (...)` batch query instead of N individual ones. The `selectin` strategy is usually preferable to `joined` for many-valued relations because it avoids row multiplication and the cartesian-product memory blowup that JOINs cause when a parent has multiple child collections. The staff-level signal is to instrument at the HTTP endpoint level (OpenTelemetry spans per query) rather than the query level, because the pathology is query count, not query cost.

## Join Optimization

Join order and join algorithm selection are the planner's most consequential decisions after index choice. For a three-table join there are 12 possible orderings and the planner uses dynamic programming (or, for very large joins, the genetic GEQO algorithm) to enumerate them, estimating cost at each. The engineer's leverage is ensuring the join columns are indexed on at least the larger side, that join predicates are equality (so hash and merge joins are available, not just nested loop), and that the query does not defeat type matching — joining a `VARCHAR` user_id to a `BIGINT` foreign key silently disables index usage because of an implicit cast on the indexed column. This last point is one of the most common production regressions: a schema migration that widened an ID column on one table but not the other leaves the join cast-broken and unindexed, and query latency jumps by orders of magnitude with no schema change on the hot table.

For large analytical joins that do not fit in memory, the planner spills hash joins to batches or falls back to merge join with an explicit sort. Pushing the join down into a covering index scan on both sides so a merge join can stream without sorting is the ideal; failing that, increasing `work_mem` to fit the smaller side's hash table is the pragmatic fix. Denormalisation — duplicating the frequently-joined columns into the fact table so the join is eliminated entirely — is the architectural fix when a join is run millions of times per second and even the indexed nested loop is too expensive. This is the trade-off behind wide fact tables in star schemas: you pay storage and write complexity to eliminate read-time joins.

## Buffer Pool Management

The buffer pool (InnoDB buffer pool, PostgreSQL shared buffers) is the in-memory cache of disk pages, typically sized to 50–75% of RAM on a dedicated database host. Pages are loaded on demand via a clock-sweep or LRU-variant eviction algorithm and evicted when the pool is full; the hit ratio determines whether the workload is CPU-bound (hits) or I/O-bound (misses). PostgreSQL uses a clock-sweep with a usage count so that a page touched repeatedly survives longer than one touched once, protecting index root pages and hot heap pages from eviction by a single large scan. InnoDB uses a variant LRU split into a young (new) sublist and an old sublist so that a full table scan does not flush the hot working set: newly loaded pages enter the old region and are promoted to young only if accessed again after a configurable interval (`innodb_old_blocks_time`, default 1 second), which is precisely the mechanism that prevents a single analytical query from evicting the OLTP working set.

```
   InnoDB BUFFER POOL  (split LRU, ~50-75% of RAM)

   |<================ young / new sublist ================>|<==== old sublist ====>|
   |                                                       |                       |
   |  HOT working set:                                     |  Newly loaded pages   |
   |   - index root/internal pages                         |   enter here FIRST    |
   |   - hot heap & leaf pages                             |   (e.g. from a        |
   |   - accessed repeatedly => high usage count           |    full table scan)   |
   |                                                       |                       |
   +-------------------------------------------------------+-----------------------+
   ^                                                       ^                       |
   |                                                       |  eviction from tail   |
   |  <-- promoted here only after 2nd access              |  (old side first)     |
   |      occurring > innodb_old_blocks_time (1s) ---------|                       |
                                                           |
   A full table scan loads pages into the OLD region only  |
   => does NOT evict the young working set.                |
   A page accessed again after 1s => promoted to young.    |
```

Buffer-pool sizing and eviction strategy interact directly with index design. A covering index that keeps a hot query entirely in a small number of leaf pages means those pages stay resident and the query is CPU-bound at sub-millisecond latency; a non-covering index that triggers heap fetches across thousands of scattered pages thrashes the buffer pool, evicting other useful pages and degrading the whole system, not just that query. This is why "add an index and measure" must include buffer hit ratio and eviction rate, not just query latency: an index that speeds up one query by evicting the working set of ten other queries is a net loss. The `pg_buffercache` extension (PostgreSQL) and `information_schema.INNODB_BUFFER_PAGE` (MySQL) let you inspect exactly which relations and indexes occupy the pool, which is how you discover that a rarely-used 20GB index is crowding out the hot 2GB index.

## Checkpointing and Write Amplification

Every modification to a buffered page dirties that page in memory; the page is later written back to disk by the background writer or during a checkpoint, which is the mechanism that guarantees all WAL (write-ahead log) records up to a certain LSN are reflected in the data files, so crash recovery can start from that point. PostgreSQL checkpoints default to every 5 minutes or when `max_wal_size` (default 1GB) is exceeded, and a checkpoint writes all dirty buffers in a sweep that, if unthrottled, saturates disk I/O and stalls foreground writes — the classic "checkpoint spike" visible as periodic latency spikes in write-heavy workloads. Tuning `checkpoint_timeout` longer (e.g. 15–30 min), increasing `max_wal_size` (e.g. 8–16GB), and enabling `checkpoint_completion_target` (0.9) spreads the write work across the whole interval, smoothing I/O.

Write amplification is the ratio of physical writes to logical row changes, and indexes are its primary driver. A single `UPDATE` that changes one non-indexed column on an InnoDB table writes the new row to the clustered index, plus an entry to every secondary index that includes that column (because secondary indexes in InnoDB are logical, not physical, so most updates do NOT touch them — but updating an indexed column rewrites that index entry). PostgreSQL is less clever here: any UPDATE creates a new tuple version and inserts a new entry into every index on the table, even indexes on unchanged columns, unless the HOT (Heap-Only Tuple) optimisation applies, which requires that no indexed column changed AND there is free space in the same page. This is why PostgreSQL write performance degrades with index count far faster than InnoDB's, and why aggressive index pruning is essential on high-write Postgres tables. The combined amplification — WAL, data page, index pages, full-page-image WAL records after the first modification of a page post-checkpoint — can easily reach 10–30× the logical write, which is the real cost behind "just add an index."

## Capacity Planning

Index and storage capacity planning must account for logical size, page fill factor, bloat, and growth rate. A B+tree index over (BIGINT, TIMESTAMP) on a 100M-row table is roughly 100M × 16 bytes = 1.6GB of leaf payload, but with InnoDB's default 15/16 fill factor (6.25% free space per page for future insertions) and internal-node overhead the on-disk size is closer to 2.2GB, and after sustained churn without optimisation it can bloat to 3GB+ as free space fragments and page splits leave half-empty pages. PostgreSQL's `pgstattuple` extension measures exact bloat; `VACUUM` reclaims dead tuples but does not shrink index files (REINDEX or `pg_repack` does), so a write-heavy index tends to grow monotonically until it is rebuilt. Planning for 1.5–2× the logical size as steady-state disk footprint, and budgeting buffer-pool memory for the hot index working set (not the whole index), is the realistic baseline.

The operational levers for keeping index footprint bounded are: drop unused indexes based on `pg_stat_user_indexes`, use `INCLUDE` instead of wide composite keys, use partial indexes for hot-fraction workloads, use BRIN (Block Range Index) for append-only time-series where a tiny per-block-range summary suffices instead of a full B-tree, and partition large tables by time so that each partition's indexes are small and individually cacheable, and so old partitions can be dropped (detaching an index with the partition) instead of vacuumed. Partitioning is the architectural answer to the unbounded-growth problem: a single orders table with three years of data and one global index is uncacheable, but the same data partitioned by month with per-partition indexes means the current month's index is 1/36 the size and fully resident, and old months are read-only and can live on cheaper storage.

## Sharp Interview Question

**Question:** You have a PostgreSQL table with 200M rows and a composite index on `(tenant_id, created_at)`. A query `WHERE created_at > NOW() - INTERVAL '7 days'` is doing a full table scan and taking 40 seconds, but the same query with `AND tenant_id = 42` is sub-millisecond. Explain why, and give two fixes that do not involve changing the query.

**Model Answer:** The leftmost-prefix rule means the index can only be seeked for predicates that include `tenant_id` as a leading column; the query without `tenant_id` has no predicate on the index's first column, so the planner cannot descend the tree and falls back to a sequential scan, which at 200M rows is ~40s of I/O. Two fixes that do not touch the query:

- **Add a second index on `(created_at) INCLUDE (tenant_id, ...)`** — a dedicated index whose leading column is `created_at` makes the time-window predicate seekable, and the `INCLUDE` lets it be covering for the common projection.
- **Partition the table by `created_at`** (range partitioning by week or month) — the planner can prune all but the current partition, turning a 200M-row scan into a 5M-row scan bounded to one or two partitions, each with its own index.

The deeper point is that a single composite index cannot serve every query shape; the access pattern dictates the index, and partitioning is the scaling lever when no single index can cover the table economically.

**Common Pitfall:** Reaching for `SET enable_seqscan = off` to "force" the index. This does not fix the problem — it forces the planner to use an index scan that touches every leaf page of the `(tenant_id, created_at)` index plus a random heap fetch per row, which is slower than the sequential scan, not faster. The planner chose the seqscan because it was genuinely cheaper; the fix is a better index or partition pruning, not overriding the planner. The same anti-pattern appears as `USE INDEX (...)` hints in MySQL, which similarly fight the planner instead of fixing the underlying access path.

## Common Pitfalls

- **Missing index on the join's large side** — a nested loop with a 10M-row outer and an unindexed inner is O(N×M); the EXPLAIN looks fine in dev with 100 rows and detonates in production.
- **Wrong composite column order** — index defined `(created_at, tenant_id)` but the hot query filters on `tenant_id` alone; leftmost prefix is violated and the index is unused.
- **Stale or single-column statistics** — planner estimates 100 rows, actual is 10M, picks nested loop over hash join; fix with `ANALYZE` and `CREATE STATISTICS` for correlated columns.
- **Type mismatch on join columns** — `VARCHAR` joined to `BIGINT` applies a cast on the indexed column and silently disables the index; latency jumps after a partial migration.
- **Function on indexed column** — `WHERE LOWER(email) = $1` cannot use an index on `email`; create an expression index `CREATE INDEX ON users (LOWER(email))`.
- **Over-indexing write-heavy tables** — eight indexes turn every INSERT into eight index writes, bloating WAL, saturating checkpoint I/O, and thrashing the buffer pool; prune with `pg_stat_user_indexes`.
- **Fighting the planner** — `enable_seqscan=off`, `USE INDEX` hints, or `/*+ INDEX(...) */` hints mask the real problem and usually make things slower; fix the access path instead.
- **Ignoring visibility map for index-only scans** — a covering index is present but the table is constantly updated so the visibility map is sparse and every index-only scan degrades to a heap fetch; tune autovacuum.

## Weaknesses & Improvements

- **v2:** Range-partition large tables by time so each partition's indexes are small, cacheable, and individually droppable; the current month's index is the only hot one.
- **v2:** Use BRIN for append-only time-series columns — a block-range summary of min/max per 128-block range is ~1000× smaller than a B-tree and sufficient for coarse time-window pruning.
- **v2:** Materialised views for expensive aggregations (monthly rollups, leaderboards) refreshed incrementally or on a schedule, so the read path is an index scan over a small summary table.
- **v2:** HypoPG for testing candidate indexes against real workloads without actually building them — `CREATE HYPOTHETICAL INDEX` lets you validate that an index will be used and measure the gain before paying the build cost on a production-sized table.

---

## Related
- [[topic-queue]]
- [[Database Sharding & Replication]]

## Interview Cheat Sheet

**Key Points to Remember:**
- The leftmost-prefix rule: a composite index can only be *seeked* (used for tree descent) for predicates on a contiguous prefix of its column list. Put equality columns first, then range columns, then order-by columns.
- A covering index (PostgreSQL's `INCLUDE` clause) eliminates heap fetches entirely — this is the single most powerful optimization for high-QPS read endpoints.
- The query planner chooses between seq scan and index scan based on estimated row count; a predicate returning >30% of a large table will correctly prefer a sequential scan over an index scan.
- Every secondary index multiplies write cost (write amplification); prune unused indexes with `pg_stat_user_indexes` where `idx_scan = 0`.
- Always validate with `EXPLAIN (ANALYZE, BUFFERS)` — compare estimated vs actual rows, and focus on the node whose cost is ~95% of total.

**Common Follow-Up Questions:**
- *Why is my index not being used?* — Common causes: stale statistics (run `ANALYZE`), type mismatch on a join column (implicit cast disables the index), a function wrapping the indexed column (`WHERE LOWER(email) = $1`), or the predicate is genuinely unselective and the planner correctly prefers a seq scan.
- *What is the [[Glossary#N+1 Query Problem|N+1 problem]] and how do you fix it?* — An ORM lazily issues one query per parent row to fetch children, producing N+1 round trips. Fix with eager loading (`select_related` / `prefetch_related` / `selectinload`) to batch into one JOIN or one `IN (...)` query.
- *When is a sequential scan better than an index scan?* — When the predicate returns a large fraction of the table (>~30%), reading the whole table in one streaming pass is cheaper than thousands of random heap fetches. The planner knows this; forcing the index (`enable_seqscan=off`) usually makes things slower.

**Gotcha:**
- The most subtle trap is treating "the index is used" as success. `EXPLAIN` may show `Index Range Scan` while the query still takes seconds because of thousands of bookmark lookups into the clustered index behind the scenes. A non-covering index that triggers a heap fetch per matching row can be worse than no index at all for large result sets — always check `Heap Fetches` in the EXPLAIN output.
