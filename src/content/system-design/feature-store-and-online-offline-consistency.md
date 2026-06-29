---
title: "Feature Store & Online/Offline Consistency"
type: system-design
category: AI/ML
date: 2026-06-25
tags: [system-design, interview, ai-ml, feature-store, ml-infrastructure, training-serving-skew, feast, tecton, point-in-time-correctness, staff-engineering]
aliases: ["Feature Store", "Online Offline Consistency", "Training Serving Skew", "Feature Engineering Platform"]
---

# Feature Store & Online/Offline Consistency

> **Staff-Engineer Focus:** "We use a feature store to serve features for our models" is the senior-MLE answer. **The staff engineer doesn't ask whether to use a feature store. They ask: "We have 800 models in production, each consuming 200 features on average — 160,000 feature definitions across 47 feature groups. Our online store handles 2 million feature vector lookups per second at P99 < 5ms, while our offline store generates 50 TB of training data nightly. The fraud detection team just discovered that their model's AUC dropped 8 points in prod because the `user_7d_avg_transaction_amount` feature was computed with a 24-hour aggregation window in training but a sliding 7-day window at serving — classic training-serving skew from a misconfigured feature definition. Walk me through: (a) how you'd design a feature registry that guarantees bitwise-identical feature computation across training and serving, including how you'd version feature definitions so that model v3 trained on feature v1.2 can still be served when the feature is now at v2.0, (b) your point-in-time join strategy when `user_profile` was updated at T=10:00, `transaction_count` was computed hourly and last ran at T=9:00, and the training label `fraud_report` arrived at T=10:15 — what timestamp does each feature get, and how do you prevent future leakage when joining these three sources, (c) the online store's failure mode at 2AM when the offline backfill job accidentally writes 500M stale feature rows with TTL=0, flooding the online store and evicting genuinely fresh features — how does your serving layer distinguish 'stale but valid' from 'stale and should fall back to default,' and (d) how you'd detect the skew before the model's AUC drops — what distribution-comparison tests run on the online vs. offline feature distributions, at what cadence, and what's the p-value threshold that pages the on-call before the business metric moves?"** The interview question isn't "What is a feature store?" It's: "You're building an ML platform for a company with 50 data scientists deploying models to a real-time fraud detection pipeline and a nightly batch recommendation pipeline. The fraud models need features computed over 7-day, 30-day, and 90-day windows with sub-millisecond lookup. The recommendation models train on 2 years of historical data with complex temporal joins. Design a feature store that guarantees the same feature values in training and serving. What consistency model do you pick? Where does it break?"**

---

## Summary & Interview Framing

A centralized repository for ML features that bridges offline training and online serving, ensuring identical feature computation in both paths. It provides a feature registry for versioned definitions, an online store for sub-ms serving lookups, an offline store for point-in-time correct training joins, and skew detection between the two.

**How it's asked:** "Design a feature store for 500 ML models consuming 200 features each, with sub-ms online lookups, point-in-time correct training joins, and training-serving skew detection."

---

## 1. Overview

A feature store is the central interface between data engineering and model serving. It solves a deceptively simple problem: when you train a model, you compute features from historical data; when you serve predictions, you compute features from live data. If those two computations differ by even one bit, you have training-serving skew — the model is answering a different question than the one it was trained on. This is arguably the most expensive silent failure mode in production ML because it doesn't throw exceptions, doesn't crash pods, and doesn't trigger latency alerts. It just quietly makes your model worse, dollar by dollar.

The feature store's job is to be the single source of truth for three things: feature definitions (the transformation logic), feature values (the actual computed numbers for a given entity at a given time), and feature metadata (lineage, freshness, statistics). By centralizing these, the feature store guarantees that `compute_feature("user_7d_avg_spend", user_id=42, as_of=timestamp)` returns the same value whether you call it from a Spark job at 3 AM or from a gRPC serving endpoint at 3 PM.

The consistency problem sits at the heart of this. Offline training is batch, high-throughput, tolerant of minutes of latency. Online serving is real-time, low-latency, and must never block. The feature store must bridge these two worlds while maintaining a consistency guarantee strong enough that data scientists trust it — if they can't trust the feature store, they'll compute features ad hoc in their serving code, and you're back to square one.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                       FEATURE STORE — HIGH LEVEL                          │
│                                                                           │
│  ┌─────────────────┐         ┌──────────────────────┐                     │
│  │  Data Sources    │         │   Feature Registry    │                     │
│  │  (Kafka, DB, S3) │────────▶│   (definitions,       │                     │
│  └─────────────────┘         │    versions, lineage)  │                     │
│         │                    └──────────┬─────────────┘                     │
│         │                               │                                   │
│         ▼                               ▼                                   │
│  ┌─────────────────┐         ┌──────────────────────┐                     │
│  │  Transformation  │────────▶│   Offline Store       │──▶ Training (Spark) │
│  │  (Spark/Flink)   │         │   (Parquet/Iceberg)   │                     │
│  └────────┬────────┘         └──────────────────────┘                     │
│           │                                                                │
│           ▼                                                                │
│  ┌─────────────────┐         ┌──────────────────────┐                     │
│  │  Ingestion Job   │────────▶│   Online Store        │──▶ Serving (gRPC)  │
│  │  (materialize    │         │   (Redis/DynamoDB)    │   < 5ms P99        │
│  │   to online)     │         └──────────────────────┘                     │
│  └─────────────────┘                                                       │
│                                                                           │
│                    ┌──────────────────────┐                               │
│                    │   Monitoring          │                               │
│                    │   (drift, freshness,   │                               │
│                    │    distribution tests) │                               │
│                    └──────────────────────┘                               │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Key Requirements

### Functional Requirements
- Define features once, use everywhere (training, serving, evaluation)
- Point-in-time correct feature retrieval — "give me features for user X as they existed at timestamp T"
- Support for batch (offline) and real-time (online) feature serving
- Feature versioning — model v3 trained on feature def v1.2 must produce identical values at serving
- Feature discovery — data scientists search/browse available features and understand their lineage
- Backfill — regenerate historical feature values when a bug is discovered in the transformation logic

### Non-Functional Requirements (SLAs)
- **Online serving latency:** P99 < 5ms for single-entity lookup, P99 < 50ms for batch of 100 entities
- **Online serving throughput:** 1M+ lookups/second (horizontal scaling)
- **Offline training throughput:** TB-scale nightly jobs completing within SLA window (4 hours typical)
- **Consistency:** Training-serving skew must be zero (identical computation) by design; point-in-time accuracy bounded by source data granularity
- **Freshness:** Online features updated within 1 minute of source data change for real-time use cases, hourly for batch use cases
- **Availability:** Online store 99.99% — serving must degrade gracefully (stale features > no features)

---

## 3. Capacity Planning

| Metric | Estimate |
|--------|----------|
| Number of feature groups (distinct entity types) | 100–500 |
| Features per group | 10–200 |
| Total feature definitions | 5,000–50,000 |
| Online store QPS (reads) | 500K–2M |
| Online store write QPS (materialization) | 10K–50K |
| Offline training data generated nightly | 10 TB–100 TB |
| Online store size (hot features only) | 50 GB–500 GB (Redis cluster) |
| Feature TTL range | 1 min (real-time) to 30 days (slow-moving) |
| Point-in-time lookback window | 2 years for training; 30 days for online fallback |

---

## 4. Data Model

```
FeatureGroup (entity type)
  - name: "user_features"
  - entity_id_type: "user_uuid"
  - online_ttl: 3600s
  - features: [FeatureDef, ...]

FeatureDef
  - name: "user_7d_avg_transaction_amount"
  - version: "1.2"
  - dtype: float64
  - transformation: transformation_id → references source tables/queries
  - aggregation_window: 7d
  - depends_on: ["transactions_stream", "user_profiles"]
  - owner_team: "fraud-ml"

FeatureValue (online store — key-value)
  - key: "user_features:{user_uuid}:{feature_name}"
  - value: float64/int64/bytes
  - written_at: epoch_ms
  - ttl: seconds

FeatureVector (offline store — columnar)
  - entity_id: user_uuid
  - event_timestamp: when this feature snapshot was valid
  - processed_timestamp: when it was computed
  - features: {f1: v1, f2: v2, ...}
```

**Storage Choice:**
- **Online store:** Redis Cluster (latency) or DynamoDB (managed, consistent) for hot-path key-value lookups. Redis is ideal for sub-ms P50 latency with hash-tag-based sharding on entity_id. DynamoDB is preferred when the ops burden of Redis isn't justified, trading ~2ms P99 for zero maintenance.
- **Offline store:** Apache Iceberg or Delta Lake on S3/GCS. Columnar format (Parquet) for efficient training reads. Time-partitioned by event_timestamp for point-in-time filtering.
- **Registry:** PostgreSQL or a Git-based registry (declarative YAML in a monorepo, with CI/CD for validation).

---

## 5. Core Design

### 5.1 The Training-Serving Skew Problem

This is the central problem the feature store solves. Training-serving skew occurs whenever the code path that computes features during training produces different results than the code path that computes features during serving. There are three categories:

**Code skew (most common).** The data scientist writes feature engineering in a Python notebook for training, then an ML engineer reimplements it in Java/Go for the serving layer. Subtle differences in rounding, null handling, or aggregation window boundaries produce different outputs. The feature store eliminates this by storing the transformation definition once and executing it identically in both paths.

**Data skew (harder).** The training data is a static snapshot from last week; the serving data is live. If the underlying data distribution shifts (e.g., a new payment method launches and transaction patterns change), the model sees feature distributions it never trained on. The feature store mitigates this with distribution monitoring, but it can't eliminate it — this is the domain of model retraining cadence.

**Temporal skew (hardest).** During training, you join features from multiple time windows and must ensure temporal consistency. If you train on `user_profile` from Tuesday but `transaction_count` from Wednesday, you've introduced leakage — the model learned from the future. The feature store enforces point-in-time correctness to prevent this.

```
┌───────────────────────────────────────────────────────────────────────┐
│                    TRAINING-SERVING SKEW DETECTION                     │
│                                                                        │
│   Training Pipeline            Serving Pipeline                        │
│   ┌──────────────┐             ┌──────────────┐                        │
│   │ Raw Data     │             │ Live Event    │                        │
│   │ (S3/DB)      │             │ (Kafka/gRPC)  │                        │
│   └──────┬───────┘             └──────┬────────┘                        │
│          │                            │                                 │
│          ▼                            ▼                                 │
│   ┌──────────────┐             ┌──────────────┐                        │
│   │ Feature      │             │ Feature       │                        │
│   │ Transform    │    SAME     │ Transform     │  ◄── Registry ensures  │
│   │ (Spark UDF)  │◄───CODE────│ (Online calc) │      identical code    │
│   └──────┬───────┘             └──────┬────────┘                        │
│          │                            │                                 │
│          ▼                            ▼                                 │
│   ┌──────────────┐             ┌──────────────┐                        │
│   │ Offline Store│             │ Online Store  │                        │
│   │ (Parquet)    │             │ (Redis)       │                        │
│   └──────┬───────┘             └──────┬────────┘                        │
│          │                            │                                 │
│          ▼                            ▼                                 │
│   ┌──────────────┐             ┌──────────────┐                        │
│   │ Trainer       │             │ Model Server  │                        │
│   └──────────────┘             └──────────────┘                        │
│          │                            │                                 │
│          └──────────┬─────────────────┘                                 │
│                     ▼                                                   │
│            ┌─────────────────┐                                         │
│            │ Distribution     │                                         │
│            │ Comparison Test  │  ◄── KS test / Jensen-Shannon / PSI     │
│            │ (hourly batch)   │      Alert if divergence > threshold     │
│            └─────────────────┘                                         │
└───────────────────────────────────────────────────────────────────────┘
```

### 5.2 API Contract

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/features/{entity_type}/{entity_id}` | GET | Online: fetch all features for an entity |
| `/features/{entity_type}/{entity_id}?names=f1,f2` | GET | Online: fetch specific features |
| `/features/batch` | POST | Online: fetch features for up to 100 entities |
| `/features/materialize` | POST (internal) | Write computed features to online store |
| `/registry/features` | GET/POST | CRUD for feature definitions |
| `/registry/features/{name}/versions` | GET | List versions of a feature definition |
| `/offline/features?entity_type=X&start=T1&end=T2` | GET | Offline: retrieve training dataset |

### 5.3 Architectural Decisions

> **Key Choice #1: Online materialization vs. Online computation.** Should the online store hold pre-computed feature values (push model), or should the serving layer compute features on the fly from source data (pull model)?

**Push model (pre-materialized):** A batch job (Spark/Flink) continuously computes features and writes them to the online store (Redis). The serving layer does a simple KV lookup. This gives predictable latency — the computation cost is paid upfront. The downside is staleness: if the batch job runs every 5 minutes, features are up to 5 minutes stale. This works for 95% of features.

**Pull model (on-demand computation):** The serving layer calls source systems directly (e.g., query the transactions DB for the last 7 days of data and compute the average). This gives fresh results but introduces latency (source system call) and availability coupling (if the transactions DB is slow, your model is slow). Use this only for real-time features that absolutely cannot tolerate staleness, and wrap in a circuit breaker.

**The pragmatic answer — hybrid.** The feature store pre-materializes all features on a configurable cadence (1 min, 5 min, 1 hour, or 1 day) based on each feature's freshness SLA. For the rare feature that requires sub-second freshness, the online layer falls back to on-demand computation, but only if the cached value's age > the feature's declared max_staleness. The key insight: 80% of features can tolerate minutes of staleness. Don't build real-time infrastructure for features that don't need it.

```
┌──────────────────────────────────────────────────────────────────────┐
│              MATERIALIZATION STRATEGY — PUSH VS PULL                  │
│                                                                       │
│  Feature Freshness SLA:                                               │
│                                                                       │
│  ┌──────────────────┬──────────────┬──────────────┬───────────────┐  │
│  │  Max Staleness   │  Strategy    │  Latency P99 │  Availability  │  │
│  ├──────────────────┼──────────────┼──────────────┼───────────────┤  │
│  │  < 1 sec         │  Pull (live) │  10-50ms     │  Depends on    │  │
│  │                  │              │              │  source        │  │
│  ├──────────────────┼──────────────┼──────────────┼───────────────┤  │
│  │  1 sec – 5 min   │  Push (Flink)│  < 1ms       │  Redis only    │  │
│  ├──────────────────┼──────────────┼──────────────┼───────────────┤  │
│  │  5 min – 1 hr    │  Push (Spark)│  < 1ms       │  Redis only    │  │
│  ├──────────────────┼──────────────┼──────────────┼───────────────┤  │
│  │  > 1 hr          │  Push (daily)│  < 1ms       │  Redis only    │  │
│  └──────────────────┴──────────────┴──────────────┴───────────────┘  │
│                                                                       │
│  Fallback chain when online key misses:                               │
│    1. Serve from offline store (Parquet → Redis cache)                │
│    2. Compute on-demand (if freshness SLA requires it)                │
│    3. Return default value (with "feature_stale" flag in response)    │
└──────────────────────────────────────────────────────────────────────┘
```

> **Key Choice #2: Point-in-time correctness — how do you join features temporally?**

This is the hardest consistency problem in feature stores. Consider a fraud model that needs three features for user U at 2026-06-25 10:00:00:

- `user_account_age`: sourced from `user_profiles` table, updated at 2026-06-25 08:30:00
- `user_7d_txn_count`: aggregated from `transactions` stream, last computed at 2026-06-25 09:00:00
- `user_device_os`: sourced from `login_events`, last event at 2026-06-25 09:55:00

The naive approach joins the "latest" value of each, producing a feature vector mixing data from 08:30, 09:00, and 09:55. This isn't necessarily wrong, but it's not point-in-time consistent — you're answering "what do we know about this user right now?" not "what did we know about this user at 10:00?"

**Point-in-time join (the correct approach):** Each feature value in the offline store carries an `event_timestamp` (when the source event occurred) and a `processed_timestamp` (when we computed it). When training, you specify `as_of = label_timestamp - ε`, and every feature retrieval returns the value that would have been observable at that moment — no future leakage. Implementation:

1. For each feature group, maintain time-partitioned Parquet files keyed by `event_timestamp`.
2. When generating a training example at time T, query each feature group with `WHERE event_timestamp <= T ORDER BY event_timestamp DESC LIMIT 1` — this is an as-of join.
3. The label (e.g., `fraud_report`) has its own timestamp T_label. All features must be queried as-of `T_label - 1 second` to prevent the model from seeing the label as a feature.

This is computationally expensive — an as-of join over 50 feature groups with 2 years of data is a heavy Spark job. Optimizations: pre-join feature groups that share the same entity and timestamp granularity; use Z-ordering on event_timestamp in the Parquet files; maintain snapshot tables that denormalize the as-of state at daily/hourly boundaries for common lookback windows.

> **Key Choice #3: Feature versioning and backward compatibility.**

Features evolve. A data scientist improves `user_7d_avg_transaction_amount` from a simple average (v1.0) to an exponentially weighted moving average (v1.1). Model v3 was trained on v1.0. Model v4 is trained on v1.1. At serving time, the feature store must serve v1.0 to model v3 and v1.1 to model v4 simultaneously.

**Strategy:** The model deployment manifest declares which feature versions it requires. The serving layer appends the version to the online store key: `user_features:{user_uuid}:user_7d_avg_txn:v1.0` and `user_features:{user_uuid}:user_7d_avg_txn:v1.1`. Both are materialized independently. A feature version is deprecated (materialization stops) only when no live model references it. This burns 2× the online store memory during the migration window — the price of safe rollbacks.

```
┌──────────────────────────────────────────────────────────────────────┐
│                    FEATURE VERSIONING LIFECYCLE                       │
│                                                                       │
│   v1.0 ─────────────────────────────────────────────▶ deprecated      │
│          │                                                             │
│          │ model_v3 (trained on v1.0)                                  │
│          │   └── serving: fetches v1.0 ◄── still materialized          │
│                                                                        │
│   v1.1 ─────────────────────────────────────────────▶ active           │
│          │                                                             │
│          │ model_v4 (trained on v1.1)                                  │
│          │   └── serving: fetches v1.1                                 │
│                                                                        │
│   v1.2 ─────────────────────────────────────────────▶ active (latest)  │
│                                                                        │
│   Rule: A version is safe to deprecate when:                          │
│     1. Zero live models reference it (from model registry)            │
│     2. Grace period (7 days) has elapsed since last model              │
│        stopped referencing it (allows rollback)                        │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.4 The Online Store Architecture

The online store is the hot path. Every model prediction hits it. The design constraints:

- **Latency:** At P99 < 5ms, you're in Redis territory. DynamoDB can achieve ~2ms P99 with DAX but it's more expensive. A Redis Cluster sharded by `{entity_type}:{entity_id}` keeps all features for one entity on one shard, enabling single-round-trip lookups.
- **Key design:** `{entity_type}:{entity_id}:{feature_name}:{version}` — hash-tagged on `{entity_type}:{entity_id}` for co-location. A single `HGETALL {entity_type}:{entity_id}:*` fetches all features in one command if you use Redis Hashes per entity.
- **Write path:** A Flink/Spark streaming job reads from Kafka, computes features, and writes to Redis via pipeline batches (500–1000 keys per pipeline). The write path must never block the read path — use separate Redis connection pools or even separate Redis instances for ingestion vs. serving.
- **Eviction:** Features carry TTLs. Redis key expiration handles most of this. But a sudden flood of stale writes (e.g., a backfill job gone wrong) can evict fresh keys. Mitigation: the ingestion job sets TTL only on keys it genuinely intends to expire; backfill jobs write with TTL=0 (no expiry) or explicitly skip keys that already have a fresher value (check `written_at` before overwriting).

---

## 6. Scaling & Bottlenecks

### Read Path (online serving)
```
Client ──gRPC──▶ Feature Service ──Redis Pipeline──▶ Redis Cluster
                                             │
                                    ┌────────┴────────┐
                                    │  Shard 0        │
                                    │  Shard 1        │
                                    │  ...            │
                                    │  Shard N        │
                                    └─────────────────┘
```
- **Bottleneck #1 — Redis hot keys.** If 80% of traffic is for 5% of entities (power users, popular products), those Redis shards become hot. Solution: client-side in-process caching with a short TTL (1–5 seconds). With 1M QPS and a 5-second cache TTL, a 10% cache hit rate removes 100K QPS from Redis.
- **Bottleneck #2 — Serialization overhead.** Protobuf/gRPC serialization adds 0.5–1ms per request. For high-throughput, use a binary protocol or pre-serialize feature vectors into byte arrays in Redis.
- **Bottleneck #3 — Missing keys.** A cache miss in Redis triggers a fallback chain (offline store → on-demand compute → default). If the miss rate spikes (e.g., new entity type deployed without pre-materialization), the fallback chain's latency blows the P99. Solution: pre-warm the online store before deploying models; monitor miss rate by feature group; circuit-break the fallback chain at >1% miss rate and serve defaults.

### Write Path (materialization)
```
Kafka ──▶ Flink ──▶ Feature Transform ──▶ Redis Pipeline ──▶ Online Store
                           │
                           ▼
                     Offline Store (S3/Parquet)
```
- **Bottleneck #1 — Window aggregation.** Computing `user_90d_avg_spend` requires reading 90 days of transactions per user. At 100M users, that's infeasible per-event. Solution: maintain intermediate aggregates (daily rollups) so the 90-day feature is a weighted average of 90 daily values, not 90 × N raw transactions.
- **Bottleneck #2 — Backfill storms.** When a feature definition changes, all historical values must be recomputed. This can saturate the Spark cluster. Solution: backfill in priority order (active models first, deprecated models later), rate-limit the online store writes, and use separate compute pools for backfill vs. steady-state materialization.

---

## 7. Consistency & Replication

### Consistency Model

The feature store spans three consistency domains:

| Domain | Consistency | Rationale |
|--------|-------------|-----------|
| Feature Registry (definitions) | Strong (Git/DB) | Must be the single source of truth; eventual consistency means two models could see different versions of the same feature |
| Offline Store (training data) | Eventual (batch) | Training is a nightly batch job; data is valid as of the job's start time. Point-in-time consistency is guaranteed within the batch |
| Online Store (serving) | Eventual (sub-minute) | Features are pre-materialized; staleness is bounded by the materialization interval. Different Redis replicas may diverge for seconds |

### The key invariant

**A model's prediction at time T should use feature values that the model COULD have seen during training.** This is a weaker guarantee than strong consistency — we don't need every serving replica to agree on the exact value, we just need the value to be within the distribution the model was trained on. This is why distribution monitoring (KS test, PSI) matters more than byte-level consistency in practice.

### Conflict resolution

Feature stores don't have write-write conflicts in the traditional sense — each feature value is keyed by entity + feature name + version, and writes are last-writer-wins by `written_at` timestamp. The real conflict is semantic: two teams defining different transformations for the same feature name. The registry prevents this with ownership (each feature has exactly one owner team) and code review for definition changes.

---

## 8. Caching Strategy

| Cache Layer | Technology | TTL | Invalidation |
|-------------|-----------|-----|--------------|
| Client-side (gRPC) | In-process LRU | 5–30 seconds | TTL-based; no invalidation |
| Online Store | Redis Cluster | 1 min – 30 days (per feature) | Key-level TTL; explicit DELETE on source data correction |
| Offline Store cache | Redis (read-through) | 1 hour | TTL; cleared after nightly training job completes |
| Feature definition cache | In-memory (per pod) | 5 minutes | Poll registry; reload on version bump event |

**The golden rule of feature caching:** never set a cache TTL shorter than the feature's natural staleness. If `user_account_age` changes once a year, caching it for 24 hours costs nothing and saves Redis load. If `user_session_clicks` changes every second, cache for 1 second or don't cache at all.

---

## 9. Weaknesses & Improvements

- **Training-serving skew detection is reactive.** Distribution tests catch skew after features have been served, not before. Improvement: add a "shadow serving" path that computes features using the offline code path in real-time (side-by-side with online path) and compares outputs. This detects code skew before it affects predictions.
- **Registry is a single point of failure for the platform.** If the registry is down, new feature deployments are blocked. Improvement: the serving layer caches the full registry and can operate in "static mode" for hours without the registry, using a baked-in snapshot.
- **Cost of dual storage.** Every feature value exists in both Parquet (offline) and Redis (online), roughly doubling storage costs. Improvement: for features with >1 hour staleness, serve directly from the offline store with a Parquet-to-Redis read-through cache, eliminating the separate materialization job.
- **Multi-tenancy is hard.** When 50 teams share the same Redis cluster, a single team's misconfigured backfill can degrade latency for everyone. Improvement: hard partition Redis by team or criticality tier (fraud gets dedicated nodes, experimentation shares a pool).

---

## 10. Sharp Question

**Q:** Your feature store serves 500K QPS of online lookups. The fraud team deploys a new model that adds a feature `user_90d_merchant_diversity` — a count of distinct merchants the user transacted with in 90 days. This feature was never materialized before. The model goes live immediately. At T+10 minutes, P99 latency spikes from 3ms to 800ms. What happened? How do you fix it without taking the model offline?

**Model Answer:**

The online store has no pre-materialized values for the new feature. Every lookup misses Redis and falls through the fallback chain: try offline store (slow S3 scan) → try on-demand compute (90-day aggregation over Kafka stream, even slower) → return default. The fallback chain's latency — especially the on-demand compute path reading 90 days of transaction data — is blowing the P99.

**Immediate fix:** Push a config change that sets `fallback_on_miss=false` and `default_value=0.0` for this feature, overriding the fallback chain. The model's accuracy will degrade for this one feature (it sees zeros instead of real values), but predictions continue at normal latency — graceful degradation.

**Permanent fix:** Trigger an emergency backfill job that computes `user_90d_merchant_diversity` for the top 100K users (by transaction volume) and writes to Redis. Once the online store has >95% coverage, re-enable the fallback chain with a tight timeout (50ms max). Going forward, materialization of new features must happen BEFORE model deployment — the deployment pipeline should gate on "feature coverage > 99%" in the online store.

### Common Pitfall
**"Just increase the Redis timeout."** Candidates often suggest bumping the Redis client timeout to mask the latency. This doesn't fix the problem — every request still waits for the full timeout before falling through, and the model server's thread pool saturates waiting for Redis, cascading the latency to ALL models, not just the fraud model. The correct answer is to fail fast and degrade gracefully, not to wait longer.

---

## 11. Self-Check Questions (Cron Session)

> These are for you to self-assess. Answer each out loud (or in writing) before continuing to the next.

1. **Explain the three types of training-serving skew** (code skew, data skew, temporal skew). For each, describe a real scenario where it could happen and how a feature store prevents or detects it.

2. **Point-in-time join:** You're training a churn model. The label "user churned" is timestamped at 2026-06-25. Feature A (`user_login_count_30d`) was last computed at 2026-06-26 (one day AFTER the label). If you join these naively, is there leakage? Why or why not? What timestamp should the AS-OF join use?

3. **Materialization cadence tradeoff:** A feature has `max_staleness = 1 second` but the materialization job (Flink) runs every 60 seconds. What happens? What are your options, and which one would you implement for a payments fraud model where 1 second of staleness means a fraudulent transaction goes undetected?

4. **Backfill safety:** A bug is discovered in `user_7d_avg_txn:v1.2` — it was undercounting by 20%. You fix the code and deploy v1.3. Describe the backfill process: what data gets recomputed, how do you ensure the online store isn't corrupted during the backfill, and how do you validate correctness before switching the model to v1.3?

5. **Design a distribution drift detection system** that compares online vs. offline feature distributions. What statistical test would you use? At what cadence? What's the p-value threshold for alerting? How do you prevent alert fatigue when 800 models are each producing weekly false positives?

---

## Related
- [[topic-queue]]
- [[Vector Database Internals (HNSW, IVF, Sharding)]]
- [[RAG Pipeline (Chunking, Embeddings, Retrieval, Reranking)]]
- [[Weakness Vault/Day-50-Feature-Store]]

---

## Interview Cheat Sheet

**Key Points to Remember:**
- The feature store bridges training (offline, batch) and serving (online, low-latency) with identical feature definitions
- Training-serving skew is the #1 failure mode — same feature must compute identically in both paths
- Online store: Redis/ DynamoDB for sub-ms lookups. Offline store: Parquet/Iceberg on S3 for batch training
- Point-in-time correctness prevents future leakage — features must be joined using the event timestamp, not the query timestamp
- Feature versioning: model trained on feature v1.2 must be servable even when feature is at v2.0

**Common Follow-Up Questions:**
- "How do you detect training-serving skew?" — Compare online and offline feature distributions using KS tests or population stability index (PSI). Alert when PSI > 0.2.
- "What happens when the online store is down?" — Fall back to default feature values (model trained with defaults) or cached features from the last successful lookup.

**Gotcha:**
- The same feature definition can produce different values if the aggregation window differs between training (e.g., 7-day calendar window) and serving (e.g., 7-day rolling window). The code must be shared, not just the definition.
