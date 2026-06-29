---
title: "Data Pipeline Architecture (Kafka + Flink + Lakehouse)"
type: system-design
category: Platform
date: 2026-06-10
tags: [system-design, interview, platform, data-engineering, kafka, flink, lakehouse, iceberg, stream-processing, batch-processing, exactly-once, data-quality]
aliases: ["Data Pipeline Architecture", "Kafka Flink Lakehouse", "Stream Processing Architecture", "Data Lakehouse"]
---

# Data Pipeline Architecture (Kafka + Flink + Lakehouse)

> **Staff-Engineer Focus:** Building a data pipeline that moves events from A to B is a junior task. Building a data pipeline that ensures exactly-once semantics across a dozen services with millisecond latency at 10 million events/second — while handling schema evolution, late-arriving data, backfills, and a data quality SLA of 99.99% — that's a staff engineer problem. The interview question isn't "explain Kafka" — it's "your company has 200 microservices each emitting events to 30 different destinations. The operations team says they find data quality issues 3 days after they occur. The data science team says they can't trust the numbers. The VP of engineering says data pipeline delays are blocking 3 product launches. Walk me through your architecture."

---

## Summary & Interview Framing

A streaming data platform using Kafka for transport, Flink for processing, and a Lakehouse (Iceberg/Delta) for ACID storage on object storage — the modern replacement for data warehouses and lakes. It handles exactly-once semantics, schema evolution, and data quality SLAs across hundreds of source services.

**How it's asked:** "Design a data pipeline that moves 10M events/sec from 200 microservices to a lakehouse with exactly-once semantics, schema evolution, and 99.99% data quality."

---

## 1. What Problem Does a Data Pipeline Solve?

At its core, a data pipeline answers one question: **how does data get from where it's born to where it's needed — correctly, on time, and at scale?**

But at the staff level, the real question is deeper: **how do you build a data platform that turns 200+ independent producers and 50+ independent consumers into a coherent, observable, trustworthy system — without becoming a bottleneck yourself?**

### The Three Generations of Data Architecture

| Generation | Paradigm | Storage | Processing | Problems |
|-----------|----------|---------|------------|----------|
| **Gen 1 — Data Warehouse** | ETL (Extract → Transform → Load) | Relational DB (Oracle, Teradata) | Batch SQL, nightly jobs | Schema changes = 6-week project. Can't handle unstructured data. Costs $500K/year in licenses. |
| **Gen 2 — Data Lake** | ELT (Extract → Load → Transform) | Object store (S3/HDFS) + Hive metastore | Spark/Hadoop batch | "Lake" becomes "swamp" — no ACID, no schema enforcement, no data versioning. 30% of queries return wrong answers because someone wrote a bad partition. The "small files problem" brings reads to a crawl. |
| **Gen 3 — Data Lakehouse** | Streaming ELT + ACID | Object store (S3) + table format (Iceberg/Delta/Hudi) | Flink (streaming) + Spark/Trino (batch) | Unifies batch and streaming on the same storage layer. ACID transactions, time travel, schema evolution, partition evolution — all on cheap S3 storage. |

**The gen 3 architecture — Kafka + Flink + Lakehouse — is what you should reach for in an interview.** It's the modern standard for companies operating at scale, and it directly addresses the pain points of gen 1 and gen 2.

### The Three-Layer Model

```
┌─────────────────────────────────────────────────────────┐
│                    INGESTION LAYER                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐          │
│  │  Kafka   │  │  Kafka   │  │  Change Data  │          │
│  │  (app    │  │  Connect │  │  Capture      │          │
│  │  events) │  │  (DB → K)│  │  (Debezium)   │          │
│  └────┬─────┘  └────┬─────┘  └──────┬───────┘          │
│       └──────────────┼──────────────┘                   │
│                      ▼                                   │
├─────────────────────────────────────────────────────────┤
│                  PROCESSING LAYER                        │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Apache Flink (Streaming)             │   │
│  │  ┌─────────┐  ┌────────┐  ┌──────────────────┐   │   │
│  │  │Enrich   │  │Window  │  │Stateful joins    │   │   │
│  │  └────┬────┘  └───┬────┘  └────────┬─────────┘   │   │
│  │       └───────────┼───────────────┘              │   │
│  └───────────────────┼──────────────────────────────┘   │
│                      ▼                                   │
├─────────────────────────────────────────────────────────┤
│                   STORAGE LAYER                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │     Lakehouse (Apache Iceberg / Delta / Hudi)     │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────┐    │   │
│  │  │ Bronze   │→ │ Silver   │→ │ Gold         │    │   │
│  │  │ (raw)    │  │ (clean)  │  │ (aggregated) │    │   │
│  │  └──────────┘  └──────────┘  └──────────────┘    │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## 2. Layer 1 — Ingestion (Apache Kafka)

Kafka is the **durable, replayable, partitioned commit log** at the heart of the pipeline. It decouples producers from consumers: producers write to topics; consumers read at their own pace.

### Kafka Internals (what matters for interviews)

| Concept | What It Is | Why It Matters at Scale |
|---------|-----------|------------------------|
| **Partition** | An ordered, immutable sequence of records. Kafka's unit of parallelism. | All records with the same key go to the same partition → ordering guarantees for that key. Partition count determines max consumer parallelism. You can't decrease partitions once set. |
| **Consumer Group** | A set of consumers that divide partitions among themselves. | Exactly one consumer per partition in a group → no duplicate processing within the group. Rebalancing (when consumers join/leave) causes a brief processing pause — the "stop-the-world" problem. |
| **ISR (In-Sync Replicas)** | Replicas that are fully caught up with the leader. | `min.insync.replicas = 2` means you survive 1 broker failure without data loss. Setting this to `replication.factor` sacrifices availability for durability. |
| **Log Compaction** | Keeps only the latest value per key (not time-based deletion). | Essential for CDC (Change Data Capture) — the latest state of each database row is always available. Enables "bootstrap a new consumer from the compacted topic" without replaying years of events. |
| **Idempotent Producer** | `enable.idempotence=true` ensures no duplicates from producer retries. | The foundation for exactly-once semantics. Without it, a producer retry can result in duplicate messages. With it, the broker de-duplicates using producer ID + sequence number. |
| **Transactions** | Atomic writes across multiple partitions/topics. | Enables "exactly-once" for read-process-write patterns (consume from topic A, process, produce to topic B — either both succeed or neither does). Critical for financial pipelines. |

### The Decision That Shapes Everything: How Many Partitions?

**The rule:** `partitions >= max(expected throughput / per-partition throughput, consumer parallelism needed)`

But this is deceptively simple. The real question is: **what ordering guarantees do you need?**

- **Global ordering?** 1 partition. Throughput limited to ~50-100 MB/s per partition. All consumers bottlenecked.
- **Per-entity ordering?** Partition by entity ID. Orders for the same user are ordered; orders across users are not. Scales horizontally.
- **No ordering needed?** Partition by random key or round-robin. Maximum parallelism, zero ordering guarantees.

**Pitfall:** Setting partitions too low initially, then realizing you need more parallelism. You can increase partitions, but existing key-based data won't redistribute — old data stays on old partitions, creating hot spots during replay. **Always over-provision partitions by 2-3x** at topic creation time. The overhead of extra partitions is negligible; the cost of re-partitioning is enormous.

### Kafka Connect: Don't Write Producers

For database → Kafka ingestion, use **Kafka Connect with Debezium connectors**. Writing a custom producer that reads from Postgres and writes to Kafka is reinventing a wheel that Debezium has already perfected — with transaction log tailing, schema registry integration, and exactly-once support.

---

## 3. Layer 2 — Processing (Apache Flink)

Kafka gets data in. Flink transforms it. Flink is the **stateful stream processing engine** — it processes events one-at-a-time (or in micro-batches) with exactly-once guarantees and sub-millisecond latency.

### Why Flink over Spark Streaming?

| Concern | Spark Structured Streaming | Apache Flink |
|---------|---------------------------|-------------|
| **Processing model** | Micro-batch (hundreds of ms latency) | True event-at-a-time (sub-ms latency) |
| **State management** | In-memory or checkpointed to DFS | RocksDB-backed state store; incremental checkpointing; state scales to TB |
| **Exactly-once** | Yes (with idempotent sinks) | Yes (two-phase commit via Kafka transactions) |
| **Late data handling** | Watermark-based, but limited | Sophisticated side outputs for late data; multiple window types |
| **Backpressure** | Stops accepting new micro-batches | Natural backpressure through TCP flow control |
| **Savepoints** | Checkpoint-based, requires structured streaming format | True savepoints — pause job, upgrade Flink version, resume from savepoint |
| **Ecosystem maturity** | Tied to Databricks/Spark ecosystem | Standalone, but growing rapidly (AWS Managed Flink, Ververica, Confluent) |

**The interview heuristic:** Reach for Spark when you're already in the Databricks/Spark ecosystem and latency > 1 second is acceptable. Reach for Flink when sub-second latency matters, stateful processing is required, or you have complex event-time windowing with late data.

### The Flink State Model (The Hardest Part)

Flink's state management is what separates it from stateless stream processors. Understanding state backends, checkpointing, and savepoints is the difference between a junior and staff answer.

**Checkpointing:** Flink periodically takes a consistent snapshot of all operator state and stores it in a durable store (S3, HDFS). On failure, it restarts from the last checkpoint — exactly-once. The **checkpoint interval** is the key tuning parameter: shorter = faster recovery + higher overhead. Typical: 1-5 minutes.

**Savepoints:** A manually triggered checkpoint that includes the exact positions in the Kafka partitions being consumed. Savepoints let you stop a Flink job, upgrade your code, and resume from where you left off — without data loss or duplication. This is critical for operational pipelines that run 24/7.

**State Backend (RocksDB):** Flink stores state in RocksDB (an embedded key-value store) on local disk, with incremental checkpoints to S3. Each key's state is stored separately, enabling scaling to **terabytes of state** — think "the last 30 days of user session activity" materialized in state.

**The critical interview point:** Flink state must be **keyed by something that distributes evenly.** If your state key is `user_id`, and you have a handful of power users generating 50% of events, you get **state skew** — one task manager holds 50% of the state and becomes the bottleneck. The fix: pre-aggregate or use a composite key that distributes load.

### Windowing: The Core Enrichment Primitive

| Window Type | Description | Example |
|-------------|-------------|---------|
| **Tumbling** | Fixed-size, non-overlapping windows | "Count orders every 5 minutes" |
| **Sliding** | Fixed-size, overlapping windows (slide < size) | "Moving average of orders over last 30 minutes, updated every 5 minutes" |
| **Session** | Activity-based windows with a gap timeout | "Group all clicks in a user session (30 min inactivity gap)" |
| **Global** | Single window across all time (custom triggers) | "Maintain the latest state for each user forever" |

**Event time vs. processing time:** This is the #1 source of data quality bugs. Processing time is when Flink receives the event; event time is when the event actually occurred. If you window by processing time and events arrive 5 minutes late, your windows will be wrong. Always window by **event time** with **watermarks** that tolerate late data.

---

## 4. Layer 3 — Storage (Lakehouse: Apache Iceberg)

The data lakehouse is where data lands — but it's not "a bucket of Parquet files." It's an **ACID-compliant table format on top of object storage.** Iceberg (Netflix), Delta Lake (Databricks), and Hudi (Uber) all solve the same problem: make S3 behave like a database.

### Why Not Just Write Parquet to S3?

| Problem | Parquet-on-S3 | Lakehouse (Iceberg) |
|---------|--------------|---------------------|
| **Atomic writes** | Partial files visible during write → readers see incomplete data | Snapshot isolation — writes are all-or-nothing |
| **Schema evolution** | Add a column → rewrite the entire table | Add/drop/rename columns as metadata operations (no data rewrite) |
| **Partition evolution** | Change partition scheme → rewrite entire table | Change partition spec → new data uses new scheme, old data stays |
| **Time travel** | Hope you kept old files around | Query table as of any snapshot ID or timestamp |
| **Concurrent writes** | Writers silently clobber each other | Optimistic concurrency with retry — Iceberg catalog arbitrates |
| **Small files** | 10,000 tiny Parquet files = 30x slower queries | Compaction jobs merge small files into optimal sizes |
| **Data skipping** | Read every file | Min/max stats per file + partition pruning → skip 99% of data |

### The Medallion Architecture (Bronze → Silver → Gold)

This is the standard pattern for organizing data in the lakehouse:

| Layer | Purpose | Transformations | Schema |
|-------|---------|----------------|--------|
| **Bronze** | Raw ingestion, immutable append-only | None (exactly as ingested) | Source schema |
| **Silver** | Cleaned, deduplicated, enriched, validated | De-duplication, PII masking, schema normalization, quality checks | Standardized schema |
| **Gold** | Business-level aggregates, dimensional models, ML features | Aggregations, joins, feature engineering | Business-friendly schema |

**The key principle:** Bronze is append-only and never modified. If you discover a bug in Silver, you don't fix Bronze — you fix the Flink job and reprocess Bronze → Silver. This preserves the immutable raw data while enabling correction downstream.

### Iceberg Internals (the 30-second explanation)

An Iceberg table has three layers:

1. **Data files** — Parquet files in S3 (the actual data)
2. **Manifest files** — Lists of data files with per-file statistics (min/max per column, row count)
3. **Manifest list / metadata file** — Snapshot of the table: which manifest files belong to this version, schema, partition spec

When you query, the engine reads the metadata file, uses partition + column stats to prune 95-99% of files, then reads only the relevant Parquet files. When you write, a new metadata file is atomically swapped in via the catalog's compare-and-swap operation — readers see either the old snapshot or the new one, never a partial write.

---

## 5. Exactly-Once Semantics: The Full Pipeline

End-to-end exactly-once is the gold standard. Here's how the layers work together:

```
Producer → Kafka (idempotent producer + transactions)
  ↓
Flink consumes from Kafka (reads committed transactions only)
  ↓
Flink processes with checkpointed state (state is part of checkpoint)
  ↓
Flink writes to Iceberg via two-phase commit:
  Phase 1: Write data files to S3 (but don't commit)
  Phase 2: On checkpoint completion, atomically commit Iceberg snapshot
  ↓
Consumer reads from Iceberg (sees only committed snapshots)
```

**What this guarantees:** Every event is processed exactly once, from producer to consumer. If Flink crashes mid-write, it restarts from the last checkpoint — data files from the failed write are orphaned (they exist in S3 but aren't referenced by any Iceberg snapshot) and are cleaned up by a background compaction job.

**The practical trade-off:** Exactly-once adds ~15-25% latency overhead (waiting for Kafka transactions + Iceberg commits). For 95% of pipelines, **at-least-once with idempotent sinks** is sufficient and simpler. Reserve exactly-once for pipelines where duplicates have financial or legal consequences (payments, billing, compliance).

---

## 6. Schema Evolution & Data Contracts

In a pipeline with 200 services producing events and 50 consuming them, schema changes without coordination cause cascading failures. The staff-engineer answer is **schema registry + data contracts.**

### Schema Registry (Confluent / Apicurio)

Every Kafka topic has a schema (Avro/Protobuf/JSON Schema) registered in the Schema Registry. Producers validate messages against the schema before publishing. Consumers know exactly what they're reading.

**Compatibility modes that matter:**

| Mode | Rule | Safe For |
|------|------|----------|
| `BACKWARD` | New schema can read old data | Consumers upgrade first → safe for producers to add optional fields |
| `FORWARD` | Old schema can read new data | Producers upgrade first → safe for consumers to add optional fields |
| `FULL` | Both directions compatible | Add optional fields only. Breaking changes require a new topic. |
| `NONE` | No compatibility checks | Fast and dangerous — use only for POC topics |

**Data contracts go beyond schemas:** They specify SLAs — freshness (data available within X minutes), completeness (99.9% of expected events present), and schema guarantees. Violation = alert to the producer team (not the data team). **The data platform team is not responsible for data quality — they're responsible for enforcing the contracts that make data quality the producer's responsibility.**

---

## 7. Common Architecture Patterns (and when to use them)

### Pattern A: Simple Streaming ETL

```
App → Kafka → Flink (clean/enrich) → Iceberg (Silver) → dbt/Spark → Iceberg (Gold) → BI
```

**When:** You have well-structured events, moderate volume (< 100K events/sec), and batch-compatible latency (> 5 min).

### Pattern B: Lambda Architecture (Streaming + Batch)

```
Fast path: App → Kafka → Flink → Redis/Serving layer (latency: ms)
Slow path: Kafka → S3 (raw) → Spark (batch) → Iceberg (corrected) → Serving layer
```

**When:** You need sub-second latency but also need exact correctness. The streaming layer gives fast, approximate results; the batch layer corrects them nightly. **The cost:** You maintain two codebases. Use only if streaming-only can't meet your accuracy requirements.

### Pattern C: Kappa Architecture (Streaming-Only)

```
App → Kafka → Flink (all processing) → Iceberg → Everything else
```

**When:** All processing — including historical re-processing — happens through the streaming system. When you need to backfill 3 years of data, you replay from Kafka's retention (or the raw data in S3). Single codebase, single processing model. **This is the modern default.** Use it unless you have a specific reason not to.

### Pattern D: CDC-First (Database as Source of Truth)

```
Postgres → Debezium → Kafka → Flink (denormalize) → Iceberg → Search/Analytics
```

**When:** Your databases are the system of record and you need to synchronize derived views (search indexes, analytics, caches) in near-real-time. Debezium tails the Postgres WAL (Write-Ahead Log), producing a Kafka event for every INSERT/UPDATE/DELETE. Flink denormalizes across tables. Iceberg stores the denormalized view for analytics.

---

## 8. Operations & Observability

A data pipeline without observability is a black box that breaks silently. The staff engineer's pipeline has:

### The Four Golden Signals for Data Pipelines

| Signal | Metric | Alert Threshold |
|--------|--------|----------------|
| **Latency** | End-to-end event age: time from event creation to availability in Gold | P99 > SLA (e.g., 5 min) |
| **Throughput** | Events per second at each stage | -20% of 7-day average (silent data loss) |
| **Errors** | Dead letter queue (DLQ) depth, Flink checkpoint failures, Iceberg commit failures | > 0 DLQ messages in 15 min |
| **Freshness** | Time since last successful write to each Iceberg table | > 2x expected interval |

### The Dead Letter Queue (DLQ) Pattern

Every pipeline stage pushes unprocessable events to a DLQ topic — not to /dev/null. The DLQ stores the raw event + error metadata (which stage failed, what the error was, the timestamp). A separate process monitors DLQ depth and alerts. **Events in the DLQ are not lost — they're quarantined.**

### Data Quality Checks (Great Expectations / Soda / dbt tests)

At each Medallion layer, automated tests validate:
- **Bronze:** Row count within expected range, no null primary keys
- **Silver:** Referential integrity, no PII in unencrypted columns, values in expected ranges
- **Gold:** Aggregate values consistent with Silver, no sudden 20%+ drops

**The rule:** Quality issues discovered at Gold cost 10x more to fix than issues discovered at Bronze. Validate early, validate often.

---

## 9. Capacity Planning & Cost

| Component | Scaling Unit | Cost Driver | Optimization |
|-----------|-------------|-------------|-------------|
| **Kafka** | Number of partitions × replication factor | Provisioned throughput (MSK) or broker count (self-managed) | Right-size partitions. Use tiered storage (S3-backed) for topics > 1TB. Delete old data aggressively. |
| **Flink** | Task slots (cores) × task managers | State size (RocksDB on disk), checkpoint frequency | Incremental checkpoints. State TTL to evict old state. Use AsyncIO for external calls instead of blocking. |
| **Iceberg** | S3 storage + query engine compute | Parquet file size (too small → high overhead), compaction | Compaction job merges small files. Partition wisely → partition pruning saves 90%+ of query scans. |

**Back-of-napkin:** At 1M events/sec, expect: 3-6 Kafka brokers (r6i.xlarge), 10-20 Flink task slots, 5-50 TB/month in Iceberg (depending on event size).

---

## 10. Weaknesses & Trade-offs

1. **Operational complexity is real.** Kafka + Flink + Iceberg is 3 distributed systems that each need expertise to run. Managed services (MSK, Kinesis Data Analytics, AWS Glue) reduce but don't eliminate the complexity.

2. **Kafka retention is not infinite.** Tiered storage helps, but replaying 3 years of data from Kafka is not practical. You need the S3 raw layer (Bronze) for long-term replayability.

3. **Exactly-once adds latency overhead.** Evaluate whether you truly need it vs. at-least-once with idempotent consumers.

4. **Flink state can grow unbounded.** Without State TTL, RocksDB state grows until it OOMs. Always configure `state.backend.rocksdb.ttl` or use timers to evict stale keys.

5. **The "schema registry is down" scenario.** If the Schema Registry is unavailable, producers can't validate new schemas (but can produce with cached schemas). Ensure your Schema Registry is highly available — it's a critical dependency.

---

## Related
- [[topic-queue]]
- [[Message Queue (Kafka-RabbitMQ)]]
- [[Event Sourcing & CQRS]]
- [[Data Pipeline Architecture (Kafka + Flink + Lakehouse) — Weakness Vault]]

---

## Interview Cheat Sheet

**Key Points to Remember:**
- The three-generation evolution: Data Warehouse (ETL, expensive) → Data Lake (ELT, no ACID) → Lakehouse (streaming ELT + ACID on object storage). Always reach for gen 3 in interviews.
- Kafka is the transport layer (durable, replayable), Flink is the processing layer (streaming SQL, exactly-once), and Iceberg/Delta/Hudi is the storage layer (ACID, time travel, schema evolution on S3).
- Exactly-once semantics require idempotent producers + transactional consumers + checkpointed processing — all three, not two out of three.
- Schema Registry is a critical dependency — if it's down, producers can't validate schemas. Make it highly available.
- The small files problem kills lakehouse read performance — compaction jobs are mandatory, not optional.

**Common Follow-Up Questions:**
- "How do you handle late-arriving data in a streaming pipeline?" — Use Flink's watermarks and allowed lateness; route late events to a side output for reprocessing.
- "What happens if a consumer falls behind by hours?" — Kafka retains data by retention policy (hours/days), so the consumer can catch up. Monitor consumer lag as a key SLO.
- "How do you do a backfill without breaking the live pipeline?" — Run a parallel Flink job that reads from the earliest Kafka offset, writes to a new table, then swap.

**Gotcha:**
- "Exactly-once" in Kafka means exactly-once within the Kafka cluster + consumer group. It does NOT mean exactly-once to an external sink (like a database) unless you use Kafka Connect with exactly-once sink connectors or two-phase commit. Many candidates conflate the two.
