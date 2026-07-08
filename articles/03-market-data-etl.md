---
title: "Designing the Market Data ETL Layer"
date: 2026-07-01
type: article
tags: [system-design, etl, market-data, olap, clickhouse, idempotent, lineage, staleness, hedge-fund]
related: [hedgineer-sd-prep, 01-llm-research-tool-for-a-pm, 02-multi-tenant-llm-platform]
audience: [senior-engineer, staff-engineer, system-design-interview-prep]
estimated_read_time: 22 min deep read, 8 min skim
---

# Designing the Market Data ETL Layer

The data layer question. If the interviewer has gone deep on the orchestrator (article 1) and the platform (article 2), this is the third leg — the part that decides whether the system is actually production-grade or just a demo.

Most candidates skip this. They assume "we have market data" and move on. A Staff candidate knows that the data layer is where the trust contract is signed. The PM-facing UI is the visible 30%. The data layer is the invisible 70% that the visible 30% depends on.

The question tests:
- **Idempotency.** Replay safety. Real-time market data feeds replay all the time. Your ETL must produce the same state on replay.
- **Late-arriving data.** Real feeds are messy. A tick for 13:24 ET arrives at 13:31 ET. Your system has to handle it.
- **Schema evolution.** Vendors change formats. Your system has to survive that without downtime.
- **OLAP vs OLTP.** Different storage for different query patterns. Wrong choice = slow queries or expensive storage.
- **Lineage.** Every number in the agent's response must trace back to the source feed and the timestamp it was observed. Required for compliance.
- **Staleness.** The data layer must know when its data is stale and surface that to the user. The system from article 1 depends on this.

This article walks the data layer end-to-end: the architecture, the threats, the operational model, the close.

> Cross-link: this article assumes the architecture from [Article 1: LLM Research Tool](./01-llm-research-tool-for-a-pm.md) and the multi-tenant concerns from [Article 2: Multi-Tenant LLM Platform](./02-multi-tenant-llm-platform.md). Read those first for the orchestrator and the platform layers. This article goes deep on the storage and ingestion layers.

## The question

> "We need a data layer that ingests market data from refinitiv, plus internal research notes (PDFs), plus the fund's positions from their PMS, and serves it to the agent with sub-second latency for the PM-facing queries. The corpus is 5 years of tick data, ~10M research memos, ~50M positions records. Walk me through how you'd design the storage and ingestion. Address idempotency, late-arriving data, schema evolution, and lineage."

The interviewer is testing whether you understand that the data layer is the system. The agent is a renderer. The data is the truth.

## The clarifying questions

Five minutes of clarification. The first answer changes everything.

1. **"What's the query mix?"** Real-time PM queries (sub-second, "what's AAPL trading at?"), end-of-day analytics (5-10s, "show me exposure by sector"), historical research ("show me all research notes mentioning AAPL in 2024"). Different storage for each.
2. **"What's the freshness SLA per query class?"** Real-time: < 5s end-to-end from feed to PM. EOD: < 1 hour. Historical: any latency is fine.
3. **"What's the source mix?"** Refinitiv (or polygon, or IEX) for market data. PDF uploads for research notes. Direct DB sync from the fund's PMS for positions. RSS or vendor push for news.
4. **"What's the data volume?"** Tick data: ~100M ticks/day for a $4B long/short equity fund. Research notes: ~50 PDFs/day, average 20 pages each. Positions: ~10K records, updated intraday.
5. **"What's the retention policy?"** Market data: 7 years (regulatory). Research notes: indefinite (the fund's IP). Positions: 7 years.

> Pro move: name the storage choice with the query class. "Real-time PM queries need an OLAP store with columnar compression — ClickHouse. EOD analytics can use the same store with pre-computed aggregates. Historical research can be on S3 with Athena or DuckDB for ad-hoc queries. The query class drives the storage choice, not the other way around."

This is a Staff-level move. It shows you think in terms of access patterns, not in terms of "let's just use Postgres for everything."

## The architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          SOURCES                                      │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐      │
│  │ Refinitiv  │  │ PDF upload │  │ PMS sync   │  │ News feed  │      │
│  │ (market    │  │ (research  │  │ (positions)│  │ (RSS /     │      │
│  │  ticks)    │  │  notes)    │  │            │  │  vendor)   │      │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘      │
└────────┼───────────────┼───────────────┼───────────────┼─────────────┘
         │               │               │               │
┌────────▼───────────────▼───────────────▼───────────────▼─────────────┐
│                       INGESTION LAYER                                 │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ 1. Source adapter (per source type)                          │   │
│  │    • Refinitiv: WebSocket → normalized JSON                  │   │
│  │    • PDF: S3 upload → OCR + chunking                         │   │
│  │    • PMS: CDC from Postgres → Kafka                          │   │
│  │    • News: RSS poll or webhook                               │   │
│  ├──────────────────────────────────────────────────────────────┤   │
│  │ 2. Validation + schema check                                 │   │
│  │    • JSON schema validation                                  │   │
│  │    • As-of timestamp enforcement                             │   │
│  │    • Reject malformed records → DLQ                          │   │
│  ├──────────────────────────────────────────────────────────────┤   │
│  │ 3. Routing (Kafka topics)                                    │   │
│  │    • market.ticks (partitioned by symbol)                    │   │
│  │    • research.chunks (partitioned by doc_id)                 │   │
│  │    • positions.updates (partitioned by account_id)           │   │
│  │    • news.articles (partitioned by source)                   │   │
│  ├──────────────────────────────────────────────────────────────┤   │
│  │ 4. Consumer workers                                          │   │
│  │    • Per-topic worker pool                                    │   │
│  │    • Idempotent processing (primary key + as_of)              │   │
│  │    • Embedding generation (for research + news)               │   │
│  │    • DLQ on failure (3 retries, then alert)                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
└────────────────────────┬─────────────────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────────────────┐
│                       STORAGE LAYER                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────┐  │
│  │ ClickHouse   │  │ Postgres     │  │ Milvus       │  │ S3       │  │
│  │ (per-tenant  │  │ (per-tenant  │  │ (per-tenant  │  │ (per-    │  │
│  │  DB)         │  │  schema,     │  │  index)      │  │  tenant  │  │
│  │              │  │  RLS)        │  │              │  │  prefix) │  │
│  │ • ticks      │  │ • positions  │  │ • research   │  │ • PDFs   │  │
│  │ • OHLCV      │  │ • users      │  │ • news       │  │ • blobs  │  │
│  │ • news       │  │ • audit log  │  │              │  │ • cold   │  │
│  │              │  │              │  │              │  │   data  │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────┘  │
└────────────────────────┬─────────────────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────────────────┐
│                       SERVING LAYER                                   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Materialized views (ClickHouse)                              │   │
│  │  • Daily aggregates: PnL, exposure by sector                 │   │
│  │  • Pre-computed at EOD, refreshed intraday                   │   │
│  ├──────────────────────────────────────────────────────────────┤   │
│  │ Caching (Redis)                                              │   │
│  │  • Hot prices: TTL 1s                                        │   │
│  │  • Hot positions: TTL 60s                                    │   │
│  │  • Single-flight to prevent stampede                         │   │
│  ├──────────────────────────────────────────────────────────────┤   │
│  │ Tool layer (from article 1)                                  │   │
│  │  • get_current_price, get_price_history, etc.                │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

Five layers. Each does one job. Let me walk through each.

### Layer: Sources

Four source types, four adapter patterns:

1. **Market data (refinitiv, polygon, IEX).** Real-time WebSocket or TCP feed. Vendor-specific protocol. The adapter normalizes to a common schema: `{symbol, price, volume, as_of, source}`. The adapter handles vendor outages, replays, and gap detection.
2. **PDF uploads (research notes).** S3 upload triggers a Lambda or worker. The PDF is OCR'd (Docling, pdfplumber, or AWS Textract), chunked, embedded, and stored. The original PDF is retained in S3 for citation.
3. **PMS sync (positions).** Change data capture (CDC) from the fund's position management system. Most PMSes are Postgres or Oracle; CDC tools include Debezium, AWS DMS, or native logical replication. The CDC stream is consumed into Kafka and applied to the platform's positions store.
4. **News feed (RSS, vendor push).** Either RSS polling (every 5 min) or a vendor webhook (push-based). Normalized to `{title, body, source, published_at, symbols}`.

### Layer: Ingestion

The ingestion layer has four stages. Each is a separate concern with its own failure modes.

**Stage 1: Source adapter.** Per source type. Normalizes vendor-specific formats to a common schema. The adapter is the only place that knows the vendor's quirks.

**Stage 2: Validation.** Every record is validated against a JSON schema. The schema enforces:
- Required fields are present
- Types are correct (price is a number, not a string)
- `as_of` timestamp is present and not in the future
- `tenant_id` is present and matches the source

Invalid records go to a dead-letter queue (DLQ) for inspection. They do not block the pipeline.

**Stage 3: Routing.** Records go to Kafka topics, partitioned for parallelism:
- `market.ticks` — partitioned by `symbol` (so all ticks for AAPL go to the same partition, preserving order)
- `research.chunks` — partitioned by `doc_id` (so all chunks of a document are processed in order)
- `positions.updates` — partitioned by `account_id`
- `news.articles` — partitioned by `source`

Partitioning is critical. Without it, parallel consumers would process out-of-order ticks for the same symbol, leading to inconsistent state.

**Stage 4: Consumer workers.** Per-topic worker pool. Each worker:
- Reads from Kafka
- Processes the record (idempotently)
- Writes to the storage layer
- Commits the Kafka offset

The workers are stateless and horizontally scalable. Adding workers = adding throughput.

**Idempotency:** Every record has a primary key (e.g., `(tenant_id, symbol, as_of)` for ticks). The worker's write is an upsert: if the primary key exists, replace; if not, insert. Replaying a Kafka offset produces the same state.

**Embedding generation:** For research chunks and news articles, the worker calls the embedding API (e.g., OpenAI `text-embedding-3-small`). The embedding is stored alongside the chunk in Milvus, keyed by `(tenant_id, doc_id, chunk_id, model_version)`. The model version is non-negotiable.

**DLQ on failure:** If a record fails validation, the worker rejects it to the DLQ. If a record fails processing (e.g., embedding API timeout, database connection lost), the worker retries up to 3 times with exponential backoff. After 3 retries, the record goes to the DLQ and an alert fires.

### Layer: Storage

Four storage backends, chosen for the access pattern. Not "use Postgres for everything" — that's the trap.

| Storage | Use case | Why this storage | Access pattern |
|---|---|---|---|
| **ClickHouse** (per-tenant DB) | Market data, OHLCV, news | OLAP, columnar, fast aggregations. Compresses tick data 10-20x. Sub-second queries on billions of rows. | Time-range queries, symbol aggregations, "give me AAPL prices between 13:00 and 14:00" |
| **Postgres** (per-tenant schema, RLS) | Positions, users, audit log | ACID, joins, exact match. The source of truth for relational data. | "Get all positions for account X as of timestamp Y" |
| **Milvus** (per-tenant index) | Research notes, news (vector search) | Vector search, semantic retrieval. | "Find research notes semantically similar to query Q" |
| **S3** (per-tenant prefix) | PDFs, full documents, cold data | Cheap, durable, infinite scale. | "Download the full PDF for citation" |

The four are not redundant — each has a job. ClickHouse is not Postgres. Milvus is not Postgres. S3 is not any of them. The system works because each layer does what it's best at.

**Embedding model versioning:** Every embedding stores `(doc_id, chunk_text, embedding_vector, model_version)`. When the model changes:
1. Build a new index (`research_notes_v2`) with new embeddings, alongside the old (`research_notes_v1`)
2. Dual-query during cutover — query both, merge, dedupe by `doc_id`
3. Atomic swap — new writes go to v2
4. Drop v1 after retention

This is the same pattern as article 1, but at the storage layer.

### Layer: Serving

Three components in front of storage:

1. **Materialized views (ClickHouse).** Pre-computed aggregates refreshed periodically:
   - Daily PnL by account
   - Daily exposure by sector
   - Daily volume by symbol
   - Refreshed at EOD; intraday refresh every 15 min for hot accounts

   Materialized views are the difference between a sub-second PM query and a 30-second scan. The PM doesn't wait for the system to compute exposure — the system already has it.

2. **Caching (Redis).** Hot data with short TTLs:
   - Hot prices: TTL 1s (prices change fast)
   - Hot positions: TTL 60s (positions change less often)
   - Single-flight: if 1000 PMs ask for the same price at the same time, one request goes to ClickHouse, 999 wait for the result. Prevents cache stampede.

3. **Tool layer.** The deterministic tools from article 1:
   - `get_current_price(symbol)` — Redis first, ClickHouse on miss
   - `get_price_history(symbol, range)` — ClickHouse
   - `get_portfolio_positions(as_of)` — Postgres
   - `search_research_notes(query, top_k)` — Milvus
   - etc.

### Layer: Lineage and observability

The invisible layer that makes the system defensible.

**Lineage metadata:** Every record in the storage layer has lineage metadata:
```json
{
  "tenant_id": "fund_a",
  "record_id": "AAPL@2026-07-01T13:24:00Z",
  "source": "refinitiv",
  "ingested_at": "2026-07-01T13:24:03Z",
  "ingestion_lag_ms": 3000,
  "embedding_model_version": "text-embedding-3-small@1",
  "schema_version": "v3"
}
```

When the PM sees "AAPL $182.50", the system knows:
- The source (refinitiv)
- The exact time it was observed (13:24:00Z)
- The exact time it was ingested (13:24:03Z)
- The ingestion lag (3 seconds)
- The schema version it conforms to

This is what makes compliance reviews tractable. The compliance officer can answer "where did this number come from?" in one query.

**Observability:** Standard metrics:
- Ingestion lag per source (alert if > 10s)
- DLQ depth per topic (alert if > 100)
- Storage size per tenant (alert if growing unexpectedly)
- Query latency P50/P95/P99 per tool
- Cache hit rate per tool
- Embedding API latency and error rate

## The threats

Five threats specific to the data layer. For each: what fails, what the PM sees, what the system does.

### Threat 1: Replay produces different state

**What fails:** A consumer worker processes a tick, then crashes before committing the Kafka offset. Kafka redelivers the tick. The worker processes it again. But the database now has two records, or the worker's internal state is inconsistent.

**What the PM sees:** Wrong prices, wrong positions, wrong PnL. Silent corruption.

**Defense:**
1. **Idempotent writes.** Every record has a primary key. The worker's write is an upsert (`INSERT ... ON CONFLICT DO UPDATE`). Replay produces the same state.
2. **Stateless workers.** Workers have no in-memory state. They read from Kafka, process, write to storage, commit offset. If they crash, Kafka redelivers; the work is redone from scratch.
3. **Exactly-once semantics with Kafka transactions.** Kafka supports exactly-once between producer and consumer. The worker can use transactional writes to ensure the database write and the offset commit happen atomically.
4. **Reconciliation jobs.** A nightly job compares the source feed's tick count to the platform's tick count. If they diverge, an alert fires.

### Threat 2: Late-arriving data

**What fails:** A tick for 13:24 ET arrives at 13:31 ET (the feed was delayed). The worker processes it, but the system has already moved on. The 13:24 candle is wrong. The PM's "what was AAPL at 13:24?" query returns the wrong number.

**What the PM sees:** Stale or wrong candle. The PM makes a decision on bad data.

**Defense:**
1. **As-of timestamp is sacred.** The tick's primary key includes `as_of`, not `ingested_at`. The system knows the data represents 13:24 even if it arrived at 13:31.
2. **Backfill window.** Late ticks within a configurable window (e.g., 24 hours) update the state. After the window, late ticks go to a separate "historical correction" log for manual review.
3. **Candle recomputation.** When a late tick updates a candle, the candle is recomputed. Subsequent queries see the corrected value.
4. **Staleness flag.** If a query asks for "AAPL at 13:24" and the data was updated at 13:31, the response includes the ingestion lag: "AAPL $182.50 (refinitiv, 13:24 ET, ingested at 13:31 ET — 7 min late)".
5. **Reconciliation against vendor.** Daily reconciliation against the vendor's authoritative candle data. Divergences trigger investigation.

### Threat 3: Schema evolution breaks ingestion

**What fails:** The vendor changes the tick schema (adds a field, renames a field, changes a type). The platform's adapter fails validation. All ticks go to the DLQ. The PM sees no data.

**What the PM sees:** The agent returns "I don't have current data for AAPL." Repeatedly. The PM loses trust.

**Defense:**
1. **Schema registry.** All schemas are versioned in a registry (Confluent Schema Registry, AWS Glue, or a simple S3 + JSON Schema store). The adapter validates against the current schema version.
2. **Additive evolution only.** Schema changes are backward-compatible: new fields have defaults, old fields are deprecated but not removed. Breaking changes require a coordinated upgrade.
3. **Dual-schema support during migration.** When a vendor releases a new schema, the platform supports both for a transition period. Old records use the old schema; new records use the new. After the transition, the old schema is dropped.
4. **Canary deployment.** New schema support is rolled out to a canary consumer first. If the canary fails, the change is reverted before it hits production.
5. **DLQ alerting.** DLQ depth spikes trigger immediate alerts. Schema breakage is caught within minutes, not hours.

### Threat 4: Storage cost explodes

**What fails:** The corpus grows faster than expected. Tick data accumulates. Research notes accumulate. The bill for ClickHouse and S3 grows 3x in a quarter.

**What the platform does:** Cost monitoring, but more importantly:
1. **Tiered storage.** Hot data in ClickHouse (last 30 days). Warm data in S3 (last 7 years, queryable via Athena or DuckDB). Cold data in S3 Glacier (compliance retention, not queryable).
2. **Compression.** ClickHouse's columnar compression gets 10-20x on tick data. S3 + Parquet + Snappy gets similar on research notes.
3. **Retention policies enforced.** Configurable per data type. Market data: 7 years hot, then warm, then cold. Research notes: indefinite warm, then cold.
4. **Per-tenant cost dashboards.** The platform operator sees per-tenant storage cost. The tenant's compliance officer sees their own.

### Threat 5: Lineage breaks under scale

**What fails:** The lineage metadata is supposed to track every number back to the source. But under scale, with billions of ticks, the lineage table becomes unwieldy. Or a bug in the ingestion code drops the lineage metadata. The compliance officer can no longer trace a number to its source.

**What the PM sees:** Doesn't know. The PM sees correct numbers. But the compliance officer, in a subpoena, can't answer "where did this come from?" SOC2 fails.

**Defense:**
1. **Lineage is a hard requirement in the schema.** The ingestion code can't write a record without lineage metadata. The schema validation rejects records missing lineage.
2. **Lineage is immutable.** Once written, lineage is never updated. Corrections go in a new record with new lineage.
3. **Lineage is sampled for verification.** A nightly job randomly samples N records, traces them back to the source feed, and verifies the chain. Discrepancies trigger alerts.
4. **Lineage is queryable.** A dedicated tool for compliance officers: "given this number in this response, show me the source feed entry, the ingestion timestamp, the worker that processed it, and the storage location."

## The operational model

Building the data layer is half. Running it is the other half.

**Daily operations:**
- DLQ review (any records that failed processing)
- Reconciliation report (vendor vs platform counts)
- Anomaly dashboard (latency spikes, cost spikes, lineage breaks)
- Backfill window (any late-arriving data to process)

**Weekly operations:**
- Schema evolution review (vendor announcements)
- Storage cost review
- Embedding model version review (any drift?)
- Performance review (P95/P99 latencies per tool)

**Monthly operations:**
- Per-tenant cost report
- Compliance officer audit log review
- Penetration test (cross-tenant data access attempts)
- Capacity planning (storage growth, query volume)

**Quarterly operations:**
- Disaster recovery test (restore from backup, verify data integrity)
- Schema registry review
- Embedding model upgrade (when a new model ships)

## The deployment story

Same as articles 1 and 2, but with the data layer as a first-class concern.

1. **Single-tenant data layer (4-6 weeks).** ClickHouse, Postgres, Milvus, S3. Idempotent ingestion. Materialized views. Caching.
2. **Multi-tenant hardening (2-4 weeks).** Per-tenant partitions, RLS, per-tenant indexes, audit log per tenant.
3. **Shadow mode for ingestion (2-4 weeks).** Run ingestion in parallel with the fund's existing data sources. Compare ticks, compare positions, compare research notes. Reconcile.
4. **Compliance review (parallel with shadow).** Lineage verification, retention policy verification, schema registry review.
5. **Single-PM pilot (1-2 weeks).** The PM uses the agent. The data layer is in production.
6. **Team rollout (2-4 weeks).** Whole team.
7. **Cross-tenant onboarding (3-4 weeks per tenant).** Repeat.

## The close

The interviewer's wrap-up, answered:

> "What's the hardest part of this data layer?"

The strong answer:

> "Idempotency under failure. The system has to be replay-safe end-to-end. A consumer crashes, Kafka redelivers, the database has to be in the same state. A worker fails after writing to the database but before committing the offset, Kafka redelivers, the database has to be in the same state. A vendor sends the same tick twice, the database has to be in the same state. Every piece of the pipeline has to be designed for replay, and most engineers don't think that way until they've been bitten.
>
> The second hardest part is lineage. It's invisible until a regulator asks, and then it's the only thing that matters. Building lineage in from day 1 is cheap. Bolting it on after a SOC2 audit is a multi-quarter project."

That's the close. It names the underrated engineering problem (idempotency under failure) and the underrated operational problem (lineage as a day-1 concern, not a backfill).

## What to practice out loud

Practice saying this in 8 minutes. Hit these checkpoints:

1. **The clarifying questions** (1 min) — name the query mix
2. **The storage layer** (2 min) — ClickHouse for time-series, Postgres for relational, Milvus for vectors, S3 for blobs. Name why each.
3. **The ingestion pipeline** (2 min) — adapter, validation, routing (Kafka), consumer workers, idempotent writes
4. **The threats** (2 min) — at least 3 of the 5
5. **The close** (1 min) — idempotency under failure, lineage as day-1

> Cross-link: the data layer feeds the orchestrator from [Article 1: LLM Research Tool](./01-llm-research-tool-for-a-pm.md) and is partitioned per-tenant as described in [Article 2: Multi-Tenant LLM Platform](./02-multi-tenant-llm-platform.md). The mock interview gaps that drove this article are in [Learning Record 0001](../learning-records/0001-mock-interview-2026-07-01.md).
