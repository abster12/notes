---
title: "Real-Time ML Inference (Streaming Features, Online Learning)"
type: system-design
category: AI/ML
date: 2026-06-27
tags: [system-design, interview, ai-ml, real-time-inference, streaming-features, online-learning, feature-store, model-serving, continual-learning, staff-engineering]
aliases: ["Real-Time ML Inference", "Streaming Features", "Online Learning", "Real-Time ML", "Streaming ML"]
---

# Real-Time ML Inference (Streaming Features, Online Learning)

> **Staff-Engineer Focus:** "We serve the model behind a REST endpoint with a feature store lookup" is the senior-MLE answer. **The staff engineer doesn't stop at the serving layer. They ask: "We have a fraud detection model that scores every payment transaction in <50ms P99 at 20,000 TPS. The model consumes 87 features — 72 are pre-computed nightly (credit score, 30-day avg transaction volume, device reputation), 12 are near-real-time computed in the last 5 minutes from a Kafka stream (velocity of transactions from this IP, geo-velocity — distance between last two transaction locations, count of distinct merchants in the last 10 minutes), and 3 are computed at request time from the transaction payload itself (amount z-score relative to user's historical distribution, time-of-day anomaly score, merchant category code risk). The 12 real-time features are computed by a Flink job that maintains 15-minute sliding windows with 1-second slide intervals. When a new payment arrives, the serving layer must merge the batch features from the feature store, the streaming features from a Redis cache that Flink writes to, and the request-time features — all within the 50ms budget. Now, here's the hard part: the fraud patterns shift — what was fraudulent last month (elderly-targeted phishing) is different from what's fraudulent today (synthetic identity with BNPL layering). You need to update the model weights continuously as new labeled fraud cases come in (typically confirmed 2-72 hours after the transaction). Walk me through: (a) your online learning architecture — do you retrain from scratch nightly, fine-tune incrementally on new labels, or use a two-model setup with a fast learner and a stable learner ensembled together, (b) how you validate that the online-updated model isn't degrading — what metrics tell you the new weights are better and not just overfitting to yesterday's fraud ring, (c) your strategy for feature consistency when the nightly batch pipeline computes '30-day avg transaction volume' using a different code path than the streaming pipeline that computes '5-minute transaction velocity' — and what happens when they disagree, and (d) the rollback story: the online model updated at 2 AM, and at 9 AM the fraud ops team reports a 40% false positive spike — how do you revert to the last known-good checkpoint in under 30 seconds without dropping any transactions?"**

---

## Summary & Interview Framing

A system that serves ML predictions using features computed in real-time from streaming data, with models that update continuously as new labels arrive.

**How it's asked:** "Design a fraud detection system scoring 20K transactions/sec in <50ms, with 12 real-time features from Kafka streams and online model updates as fraud labels arrive."

---

## 1. Overview

Real-time ML inference is the practice of serving model predictions on live data with latency constraints measured in milliseconds, consuming features that span a freshness spectrum from "pre-computed last night" to "computed 50 milliseconds ago from the event that triggered this prediction." It is not a model problem — it is an infrastructure problem that intersects feature engineering, stream processing, model serving, and operational safety.

The defining tension in real-time ML is between **freshness and reliability.** Batch-trained models updated nightly are stable, well-validated, and easy to roll back — but they can't react to a fraud ring that emerged at 10 AM. Online-updated models react instantly, but they can silently degrade, overfit to transient patterns, and lack the validation safety net that batch training provides. The staff engineer's job is to design a system where freshness and reliability are not opposites but complements — where the fast path and the slow path reinforce each other.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                    REAL-TIME ML INFERENCE — SYSTEM TOPOLOGY                         │
│                                                                                    │
│                            ┌──────────────────────┐                                │
│                            │   EVENT PRODUCERS     │                                │
│                            │  (app servers, IoT,   │                                │
│                            │   mobile, payment gw) │                                │
│                            └──────────┬───────────┘                                │
│                                       │ events (Kafka)                             │
│                                       ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐      │
│  │                        STREAM PROCESSING (Flink / Kafka Streams)          │      │
│  │                                                                          │      │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐        │      │
│  │  │ Windowed Agg    │  │ Streaming Joins  │  │ Feature Compute  │        │      │
│  │  │ (5-min sliding) │  │ (event + profile)│  │ (z-score, vec)   │        │      │
│  │  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘        │      │
│  │           │                     │                     │                   │      │
│  │           └─────────────────────┼─────────────────────┘                   │      │
│  │                                 │                                         │      │
│  │                    Write real-time features to Redis                       │      │
│  └─────────────────────────────────┼─────────────────────────────────────────┘      │
│                                    │                                                │
│                                    ▼                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐      │
│  │                      FEATURE STORE (Online Serving Layer)                  │      │
│  │                                                                           │      │
│  │  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐     │      │
│  │  │ Batch Features   │    │ Streaming Feat.  │    │ Request-Time     │     │      │
│  │  │ (Redis/Dynamo)   │    │ (Redis, TTL 15m) │    │ (compute on fly) │     │      │
│  │  │ TTL: 24h         │    │ Updated: ~1s     │    │                  │     │      │
│  │  └────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘     │      │
│  │           │                       │                       │               │      │
│  │           └───────────────────────┼───────────────────────┘               │      │
│  │                                   │                                       │      │
│  │                    Feature Merge (entity_id join)                          │      │
│  └───────────────────────────────────┼───────────────────────────────────────┘      │
│                                      │ feature vector (87 dims)                     │
│                                      ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐      │
│  │                        MODEL SERVING LAYER                                │      │
│  │                                                                          │      │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐     │      │
│  │  │ Primary  │  │ Shadow   │  │ Canary   │  │ Online Learner        │     │      │
│  │  │ Model v3 │  │ Model v4 │  │ Model v4 │  │ (async weight update) │     │      │
│  │  │ (stable) │  │ (eval)   │  │ (1% traf)│  │                       │     │      │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────────────────┘     │      │
│  │                                                                          │      │
│  │  Inference Engine: Triton / TorchServe / custom gRPC                     │      │
│  │  P99 Latency budget: 50ms (feature merge + inference)                    │      │
│  └──────────────────────────────────────────────────────────────────────────┘      │
│                                      │                                              │
│                                      ▼                                              │
│                            ┌──────────────────┐                                     │
│                            │   PREDICTION      │                                     │
│                            │   (score + reason)│                                     │
│                            └──────────────────┘                                     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

The architecture above reflects the fundamental insight: real-time ML is a **data pipeline problem as much as a serving problem.** The model is the easy part. Getting the right features, at the right freshness, with the right consistency guarantees, within the latency budget — that's where systems fail.

---

## 2. Key Requirements

### Functional Requirements
- Serve model predictions at <50ms P99 for online inference requests (synchronous path)
- Compute real-time features from streaming event data with <1 second staleness
- Merge batch features (nightly-computed), streaming features (last N minutes), and request-time features into a single feature vector per prediction request
- Support online model updates — incorporate new labeled data into model weights within minutes of label availability, not hours
- Multi-model deployment: stable model (95% traffic), canary model (5% traffic), shadow model (0% traffic, log-only)
- Feature freshness monitoring: detect when streaming features are stale and gracefully degrade (use last-known value or batch fallback)
- Explainability: return feature contributions alongside prediction scores for debugging and compliance

### Non-Functional Requirements (SLAs)
- **Prediction latency:** P99 < 50ms end-to-end (feature fetch + merge + inference)
- **Throughput:** 20,000 predictions/second at peak (sustained), 50,000 burst (30-second windows)
- **Availability:** 99.95% — failed predictions must be handled gracefully (default-allow or default-deny based on use case, never a 500 error to the caller)
- **Feature freshness:** Real-time features no more than 1 second stale; streaming features no more than 5 minutes stale; batch features up to 24 hours stale
- **Online update latency:** New labels incorporated into model within 5 minutes of label availability
- **Rollback time:** < 30 seconds to revert to last-known-good model checkpoint
- **Cost:** 70% of inference infrastructure cost in feature serving (storage + retrieval), not model compute

---

## 3. Capacity Planning

| Metric | Estimate |
|--------|----------|
| Peak prediction QPS | 20,000 (sustained), 50,000 (burst) |
| Features per prediction | 87 (72 batch + 12 streaming + 3 request-time) |
| Feature vector size | 87 × 8 bytes (float64) = 696 bytes per request |
| Batch features storage | 100M entities × 72 floats × 8 bytes = ~58 GB |
| Streaming features storage (Redis) | 10M active entities × 12 floats × 8 bytes = ~1 GB |
| Streaming events throughput | 100,000 events/sec (Kafka, partitioned by entity_id) |
| Flink parallelism | 64 task slots (event throughput / per-slot capacity ~1,500/sec) |
| Model size (GBDT/NN) | ~500 MB (compressed, in-memory at serving) |
| Serving instances | 20 × 8 vCPU + 16 GB RAM (1,000 QPS per instance) |
| Redis cluster (feature store) | 6 nodes × 32 GB (Redis Cluster, sharded by entity_id) |
| Online training throughput | ~1,000 updates/sec (mini-batch SGD on GPU) |
| Label delay | P50: 2 hours, P99: 72 hours (fraud confirmation lag) |

**Storage choice:** Batch features in Redis Cluster (hot path) with DynamoDB fallback. Streaming features exclusively in Redis (volatile, TTL-governed). Model checkpoints in S3 with local SSD cache on serving instances for fast rollback. Training data (labeled events) in a columnar data lake (Iceberg/Parquet) for batch retraining; recent labels streamed via Kafka for online updates.

---

## 4. Feature Freshness Ladder

The single most important concept in real-time ML architecture is that not all features have the same freshness requirement. Categorizing features by freshness tier determines where they're computed, where they're stored, and how they're retrieved.

```
┌──────────────────────────────────────────────────────────────────────┐
│                    FEATURE FRESHNESS LADDER                            │
│                                                                       │
│  TIER 0: REQUEST-TIME (0ms staleness)                                 │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Computed from the prediction request payload itself.          │    │
│  │ Examples: amount_zscore(transaction), time_of_day_sin_cos,    │    │
│  │            merchant_category_risk_lookup                       │    │
│  │ Storage: NOWHERE — computed inline in the serving layer       │    │
│  │ Latency: 1-3ms (pure compute, no I/O)                         │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  TIER 1: STREAMING HOT (< 1 second staleness)                        │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Computed by stream processor, written to Redis.               │    │
│  │ Examples: 5-min tx_velocity, geo_velocity, distinct_merchants │    │
│  │ Storage: Redis, TTL = window_size + grace_period              │    │
│  │ Latency: <5ms (Redis GET, batch by entity_id)                 │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  TIER 2: STREAMING WARM (< 5 minutes staleness)                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Computed by stream processor on larger windows.               │    │
│  │ Examples: 30-min session_features, hourly_aggregates           │    │
│  │ Storage: Redis, TTL = 1 hour                                   │    │
│  │ Latency: <5ms (Redis GET)                                      │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  TIER 3: BATCH FRESH (< 24 hours staleness)                          │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Computed by nightly Spark/Dataflow jobs.                      │    │
│  │ Examples: 30d_avg_tx_volume, credit_score, device_reputation   │    │
│  │ Storage: Redis (hot cache) with DynamoDB/Feast (source)        │    │
│  │ Latency: <5ms (Redis GET); <20ms (DynamoDB if cache miss)     │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  TIER 4: SLOW-BATCH (> 24 hours staleness)                           │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Computed weekly/monthly. Rarely changes.                      │    │
│  │ Examples: user_segment, lifetime_value_tier, churn_risk_score  │    │
│  │ Storage: Redis (preloaded, TTL = 7 days)                       │    │
│  │ Latency: <5ms                                                  │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

The key architectural insight: **Tier 0 features cost nothing at retrieval time but consume serving-layer CPU. Tier 1 features cost stream-processing infrastructure and Redis memory. Tier 3 features cost batch compute and storage.** The staff engineer's optimization problem is allocating features to the right tier based on their marginal value to model accuracy vs their infrastructure cost.

---

## 5. Streaming Feature Computation — Flink Deep Dive

Real-time features are computed in a stream processor, typically Apache Flink or Kafka Streams. The architecture must handle exactly-once semantics, late-arriving data, and state recovery from failure.

```
┌──────────────────────────────────────────────────────────────────────────┐
│              STREAMING FEATURE COMPUTATION — FLINK JOB TOPOLOGY            │
│                                                                           │
│  Kafka Source Topic: raw.events (100K msg/sec, partitioned by entity_id)  │
│       │                                                                    │
│       ▼                                                                    │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │ Step 1: Parse + Validate                                         │    │
│  │   - Deserialize Protobuf/Avro                                    │    │
│  │   - Drop events with missing entity_id or timestamp               │    │
│  │   - Enrich with static entity metadata (Redis async lookup)      │    │
│  └──────────────────────────┬───────────────────────────────────────┘    │
│                             │ Keyed by entity_id                          │
│                             ▼                                             │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │ Step 2: Windowed Aggregation (5-min sliding, 1-min slide)        │    │
│  │                                                                  │    │
│  │   Window 1 [10:00–10:05] ────┐                                    │    │
│  │   Window 2 [10:01–10:06] ────┤                                    │    │
│  │   Window 3 [10:02–10:07] ────┤─── Emit every minute              │    │
│  │   Window 4 [10:03–10:08] ────┤                                    │    │
│  │   Window 5 [10:04–10:09] ────┘                                    │    │
│  │                                                                  │    │
│  │   Aggregates per window:                                         │    │
│  │   - COUNT(event) → tx_velocity                                   │    │
│  │   - COUNT(DISTINCT merchant) → distinct_merchants                │    │
│  │   - SUM(amount) / COUNT → avg_tx_amount                          │    │
│  │   - LAST(location) → for geo-velocity computation                │    │
│  └──────────────────────────┬───────────────────────────────────────┘    │
│                             │                                             │
│                             ▼                                             │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │ Step 3: Feature Transform                                        │    │
│  │   - geo_velocity = haversine(last_location, prev_location)       │    │
│  │                    / time_diff_hours                              │    │
│  │   - amount_zscore = (amount - global_mean) / global_stddev       │    │
│  │   - velocity_ratio = current_window_count / prev_window_count    │    │
│  └──────────────────────────┬───────────────────────────────────────┘    │
│                             │                                             │
│                             ▼                                             │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │ Step 4: Redis Sink                                               │    │
│  │   - Key: "stream_feat:{entity_id}"                               │    │
│  │   - Value: JSON/Protobuf of all 12 features                      │    │
│  │   - TTL: 15 minutes (window_size + 2× slide_interval + buffer)   │    │
│  │   - Write mode: UPSERT (overwrites, atomic per-key)              │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                           │
│  State Backend: RocksDB (local SSD) with Checkpointing to S3 every 60s    │
│  Failure Recovery: Restore from latest checkpoint, replay from Kafka      │
└──────────────────────────────────────────────────────────────────────────┘
```

### Late Data and Watermarks

Streaming windows must handle events that arrive out of order. A user's click on their phone might arrive 30 seconds after the click on their laptop, even though the phone click happened first. Flink handles this with **watermarks** — a watermark(t) says "all events with timestamp < t have probably arrived." The window fires when the watermark passes the window end + allowed lateness.

The allowed lateness is a trade-off: longer lateness = more accurate features but more state to retain and more memory. For real-time ML features, 30 seconds of allowed lateness is typical — any event later than that is dropped from the window and the feature is computed from incomplete data. This is acceptable because a single dropped event in a 5-minute window of hundreds of events barely moves the aggregate.

---

## 6. Online Learning — Architecture and Safety

Online learning is the practice of updating model weights incrementally as new labeled data arrives, rather than retraining from scratch periodically. It is the right approach when:
- the data distribution shifts faster than your batch retraining cadence (fraud patterns, trending topics, seasonal demand)
- labels arrive continuously (clicks, conversions, fraud confirmations)
- the cost of a stale model is high (fraud loss, missed recommendations)

But online learning is dangerous. A model that updates on every new label can overfit to the most recent examples, oscillate on noisy labels, or be adversarially poisoned. The safe architecture uses a **dual-model pattern:**

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    DUAL-MODEL ONLINE LEARNING ARCHITECTURE                  │
│                                                                           │
│                          ┌─────────────────────┐                          │
│                          │   Labeled Events     │                          │
│                          │   (Kafka: labels)    │                          │
│                          └──────────┬──────────┘                          │
│                                     │                                      │
│                                     ▼                                      │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │                    ONLINE LEARNER (GPU Instance)                   │    │
│  │                                                                   │    │
│  │  ┌─────────────────────┐    ┌─────────────────────┐               │    │
│  │  │ Fast Model          │    │ Stable Model        │               │    │
│  │  │ (updated every 100  │    │ (updated every 10K  │               │    │
│  │  │  labels, high LR)   │    │  labels, low LR)    │               │    │
│  │  │                     │    │                     │               │    │
│  │  │ • Learns new        │    │ • Maintains long-   │               │    │
│  │  │   patterns fast     │    │   term stability    │               │    │
│  │  │ • High variance     │    │ • Low variance      │               │    │
│  │  │ • Risk of overfit   │    │ • Risk of staleness │               │    │
│  │  │                     │    │                     │               │    │
│  │  └──────────┬──────────┘    └──────────┬──────────┘               │    │
│  │             │                          │                           │    │
│  │             └──────────┬───────────────┘                           │    │
│  │                        │                                           │    │
│  │                        ▼                                           │    │
│  │              ┌─────────────────────┐                               │    │
│  │              │ Ensemble / Gating   │                               │    │
│  │              │ (weighted average   │                               │    │
│  │              │  or contextual      │                               │    │
│  │              │  routing)           │                               │    │
│  │              └─────────────────────┘                               │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │                    SAFETY GUARDRAILS                               │    │
│  │                                                                   │    │
│  │  1. Validation Holdout: Last 1 hour of labels → evaluate before    │    │
│  │     promoting online model (must beat stable on AUROC by >1%)      │    │
│  │                                                                   │    │
│  │  2. Shadow Deployment: Online model always runs in shadow on       │    │
│  │     100% of traffic (predictions logged, not served) for 1 hour    │    │
│  │     before any promotion                                           │    │
│  │                                                                   │    │
│  │  3. Performance Degradation Auto-Rollback: If online model's       │    │
│  │     shadow AUROC drops below stable model's for 3 consecutive      │    │
│  │     10-minute windows → auto-revert to last checkpoint             │    │
│  │                                                                   │    │
│  │  4. Prediction Distribution Drift: If prediction mean shifts       │    │
│  │     by >2 standard deviations from 24h baseline → alert, pause     │    │
│  │     online updates, investigate                                    │    │
│  │                                                                   │    │
│  │  5. Weight Norm Monitoring: If L2 norm of weight delta from        │    │
│  │     checkpoint exceeds threshold → clip or reject update           │    │
│  └──────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
```

### Why Not Just Retrain Nightly?

For use cases with moderate label delay and slowly shifting distributions (recommendations, search ranking), nightly retraining is sufficient and safer. Online learning is justified only when all three conditions hold: (a) fast distribution shift, (b) continuous label arrival, (c) high cost of staleness. If labels arrive with a 72-hour delay (fraud confirmation), online learning on a per-label basis is still valuable because labels trickle in — you don't need to wait for all labels from Tuesday to start learning on Tuesday's patterns.

---

## 7. Feature Serving — The Merge Problem

When a prediction request arrives, the serving layer must assemble the full feature vector from three sources (batch, streaming, request-time). This is called the **feature merge** and it is a surprisingly hard problem.

```
┌──────────────────────────────────────────────────────────────────────┐
│                    FEATURE MERGE — REQUEST LIFECYCLE                   │
│                                                                       │
│  TIME (ms)                                                            │
│  0    │  Prediction request arrives (user_id, transaction_payload)    │
│       │                                                                │
│  0-2  │  Request-time feature compute (amount_zscore, time_features)  │
│       │  Pure CPU, no I/O                                              │
│       │                                                                │
│  2-7  │  Parallel Redis GET:                                           │
│       │  ┌─ "batch_feat:{user_id}"     (Redis shard A)                │
│       │  ├─ "stream_feat:{user_id}"    (Redis shard B)                │
│       │  └─ "profile:{user_id}"         (Redis shard C)                │
│       │  Each <5ms P99 (Redis pipelined)                               │
│       │                                                                │
│  7-8  │  Feature merge + validation                                    │
│       │  - Align feature indices (slot 0 = credit_score, etc.)        │
│       │  - Handle cache misses: fallback batch feat → DynamoDB        │
│       │  - Handle stale streaming feat: use batch feature instead     │
│       │  - Impute missing values (mean/median per feature)            │
│       │  - Validate: dimension == 87, no NaN, no Inf                  │
│       │                                                                │
│  8-10 │  Construct inference tensor → GPU (if NN) or CPU (if GBDT)    │
│       │                                                                │
│ 10-15 │  Model inference (NN: GPU batch; GBDT: CPU tree traversal)    │
│       │                                                                │
│ 15-16 │  Post-processing: sigmoid → score, SHAP → explanations         │
│       │                                                                │
│ 16    │  Response returned                                             │
│       ▼                                                                │
│  End-to-end: ~16ms (well within 50ms P99 budget)                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Feature Merge Pitfalls

**Missing streaming features:** If Flink is down or the entity has no recent events, `stream_feat:{user_id}` returns nil. The merge layer must have a well-defined fallback: (a) use the batch equivalent if it exists (e.g., batch `30d_avg_tx_volume` ≈ streaming `5m_tx_count` scaled up — not the same feature but a correlated signal), (b) impute with the population mean, or (c) use the last-known streaming value if within its TTL window. Option (a) is the safest — it degrades information quality but doesn't introduce arbitrary values.

**Stale-but-not-expired features:** Redis TTL of 15 minutes means a feature computed 14 minutes ago is still returned. For a prediction at minute 14:30, that's a 14-minute-stale feature being treated as if it's "streaming fresh." The fix: store the computation timestamp alongside the feature value, and the merge layer checks: if `now - feature_compute_time > freshness_threshold`, downgrade to batch fallback.

**Feature divergence:** The batch pipeline computes `30d_avg_tx_volume` using a Spark SQL query with a 30-day rolling window. The streaming pipeline computes `5m_tx_velocity` using Flink sliding windows. These are different code paths, different frameworks, different time semantics (event time vs processing time). If a bug in the batch pipeline causes a feature to be consistently 10% higher than its streaming equivalent, the model sees a distribution shift at the batch/streaming boundary — which features shift? The model learns to rely on whichever is more predictive, but if the discontinuity changes day-to-day (because the batch job's output varies based on when it runs), prediction quality oscillates. The defense: **feature monitoring** — track the mean and variance of every feature in both batch and streaming pipelines, alert on divergence > 3 standard deviations, and freeze online updates when divergence is detected.

---

## 8. Online/Offline Consistency — Point-in-Time Correctness

This topic builds directly on Day 50 (Feature Store) but with the added complexity of streaming features. The problem: when you join a batch feature computed at midnight with a streaming feature computed at 10:15 AM, the joined feature vector represents a state that never actually existed. The batch feature used data through midnight, but the streaming feature used data through 10:15 AM. There's a 10-hour gap where intermediate events occurred.

For most applications, this inconsistency is harmless — the model learns to handle it implicitly. But for time-sensitive predictions (fraud detection on a transaction at 10:15 AM using a credit score computed at midnight), the inconsistency can cause errors.

The solution has two layers:

1. **Point-in-time feature retrieval:** The feature store tracks when each feature value was computed. The merge layer annotates the feature vector with a `max_staleness` field. The online learner can use this as an input feature — the model learns to discount certain features when they're stale.

2. **Temporal consistency windows:** Batch features that change slowly (credit score updates monthly) don't need point-in-time precision. Streaming features that change every second do. Categorize features by their natural update frequency, and only enforce point-in-time consistency on features where the update frequency is faster than the prediction frequency.

---

## 9. Model Serving Infrastructure

The serving layer for real-time ML must balance three constraints: low latency, high throughput, and model version agility.

```
┌──────────────────────────────────────────────────────────────────────┐
│                    MODEL SERVING ARCHITECTURE                          │
│                                                                       │
│   Load Balancer (Envoy / NGINX)                                       │
│   │                                                                   │
│   ├─▶ Serving Pod 1 ─▶ Model v3 (stable) + Model v4 (shadow)         │
│   ├─▶ Serving Pod 2 ─▶ Model v3 (stable) + Model v4 (shadow)         │
│   ├─▶ ...                                                             │
│   ├─▶ Serving Pod 18 ─▶ Model v3 (stable)                             │
│   ├─▶ Serving Pod 19 ─▶ Model v4 (canary, 5% traffic)                │
│   └─▶ Serving Pod 20 ─▶ Model v4 (canary, 5% traffic)                │
│                                                                       │
│   Model Loading Protocol:                                             │
│   ┌─────────────────────────────────────────────────────────────┐    │
│   │ 1. New model version published to S3:                        │    │
│   │    s3://models/fraud/v4/checkpoint-2026-06-27-0200.pt        │    │
│   │                                                              │    │
│   │ 2. Serving instances poll S3 every 60s (or S3 event → SQS)  │    │
│   │                                                              │    │
│   │ 3. Download to local SSD: /models/fraud/v4/                  │    │
│   │                                                              │    │
│   │ 4. Load into GPU/CPU memory (warm-up: run 100 dummy inputs   │    │
│   │    to populate CUDA kernels and cache)                       │    │
│   │                                                              │    │
│   │ 5. Atomic model swap: update pointer in serving engine        │    │
│   │    (no dropped requests during swap)                          │    │
│   │                                                              │    │
│   │ 6. Health check: /health returns 200 only after warm-up       │    │
│   └─────────────────────────────────────────────────────────────┘    │
│                                                                       │
│   Rollback Architecture:                                              │
│   ┌─────────────────────────────────────────────────────────────┐    │
│   │ Each serving instance keeps the LAST 3 model versions on     │    │
│   │ local SSD (checkpoint, config, feature transform).           │    │
│   │                                                              │    │
│   │ Rollback command (Redis pub/sub or gRPC admin endpoint):     │    │
│   │   ROLLBACK model=fraud to_version=v3                         │    │
│   │                                                              │    │
│   │ All instances receive within 1s, swap atomically.            │    │
│   │ No S3 download needed — v3 already on disk.                  │    │
│   │ Total rollback time: <5 seconds after command issued.        │    │
│   └─────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

### Batch Inference Optimization

For GPU-based models (neural networks), inference throughput improves dramatically with batching. But real-time requests arrive one at a time — you can't wait to accumulate a batch because latency would spike.

The solution is **dynamic batching:** the serving engine (Triton, TorchServe) queues incoming requests for a configurable window (e.g., 5ms). All requests arriving in that window are batched into a single GPU forward pass. This amortizes GPU kernel launch overhead across multiple requests while keeping latency bounded. At 20,000 QPS, a 5ms batching window collects ~100 requests per batch, achieving near-theoretical GPU throughput while maintaining <15ms inference latency.

For CPU-based models (GBDT/XGBoost), batching is less critical — tree traversal is already O(depth) per prediction and doesn't benefit as much from vectorization. Each request is processed independently on a thread pool.

---

## 10. Monitoring and Drift Detection

Real-time ML systems fail silently. The model returns a prediction — it's always a number — but that number may be wrong. Monitoring must detect four types of failure:

| Failure Mode | Detection Signal | Threshold | Action |
|---|---|---|---|
| Feature drift | KL divergence of feature distribution (24h window vs 7d baseline) | > 0.3 for any top-10-importance feature | Alert; if >3 features drift simultaneously → pause online updates |
| Prediction drift | Mean prediction shift (1h window vs 24h baseline) | > 2 std dev | Alert; if sustained for 3 windows → auto-rollback |
| Label drift | Positive label rate change (1h vs 24h) | > 50% relative change | Alert (may be real pattern shift, not degradation) |
| Latency degradation | P99 latency (1-min rolling window) | > 50ms | Alert; if sustained → scale up serving instances |
| Feature staleness | % of predictions using fallback features | > 5% | Alert; investigate stream processor health |
| Model staleness | Hours since last successful online update | > 4 hours | Alert; may need manual intervention |

The difference between a good ML engineer and a staff engineer is that the staff engineer builds the monitoring before the model goes to production, not after the first incident. They also design for **graceful degradation:** when features are missing or stale, the model should still return a prediction — perhaps with a lower confidence score or a flag indicating reduced reliability — rather than throwing an error that the caller must handle.

---

## 11. Deployment and Experimentation

Real-time ML systems require safe deployment patterns that go beyond standard software canary deployments because model quality is stateful and distribution-dependent.

**Shadow deployment:** Deploy the new model alongside the current one. Route 100% of traffic to the current model for actual predictions, but also run the new model on 100% of traffic and log its predictions (without serving them). Compare offline. This is zero-risk and should be the default first step for every model update.

**A/B (canary) deployment:** Route a small percentage of traffic (1-5%) to the new model. Compare business metrics (fraud catch rate, click-through rate, conversion) between the A and B groups. This is higher-risk than shadow but necessary because offline metrics don't always correlate with online outcomes (the model may have better AUROC offline but worse business impact due to interaction effects).

**Traffic splitting mechanism:** Use a consistent hash on `entity_id` to ensure the same entity always goes to the same model variant within an experiment. This prevents a single user from seeing predictions from two different models within the same session, which would corrupt both the experiment results and the user experience.

```
┌──────────────────────────────────────────────────────────────────┐
│                    SAFE DEPLOYMENT PIPELINE                        │
│                                                                   │
│  Stage 1: Offline Validation (automated, runs on every checkpoint)│
│  ┌───────────────────────────────────────────────────────────┐   │
│  │ • AUROC on last-7-day holdout > stable model               │   │
│  │ • No feature with >50% importance change                   │   │
│  │ • Prediction calibration (expected vs actual rate) < 5%    │   │
│  └───────────────────────────────────────────────────────────┘   │
│       │ Pass                                                       │
│       ▼                                                            │
│  Stage 2: Shadow Deployment (100% traffic, log-only, 2 hours)     │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │ • Shadow predictions logged, compared offline              │   │
│  │ • Distribution comparison: KS-test shadow vs stable        │   │
│  │ • If KS statistic > 0.1 → investigate, pause promotion     │   │
│  └───────────────────────────────────────────────────────────┘   │
│       │ Pass                                                       │
│       ▼                                                            │
│  Stage 3: Canary Deployment (5% traffic, 4 hours)                 │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │ • Business metrics comparison (fraud catch rate, CTR)      │   │
│  │ • Latency comparison (P50/P99 must be within 10%)          │   │
│  │ • Error rate comparison (must be within 0.1%)              │   │
│  └───────────────────────────────────────────────────────────┘   │
│       │ Pass                                                       │
│       ▼                                                            │
│  Stage 4: Full Rollout (100% traffic, gradual over 1 hour)        │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │ • 10% → 25% → 50% → 100% in 15-minute increments           │   │
│  │ • Monitor at each step: latency, errors, prediction drift  │   │
│  │ • Auto-rollback trigger active throughout                  │   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 12. Weaknesses & Improvements

- **Online learning instability:** The dual-model pattern mitigates but doesn't eliminate the risk of online model degradation. A coordinated fraud ring that slowly poisons labels over 48 hours can steer both models. Improvement: adversarial label validation — compare label distributions across data sources; if labels from source A (manual review) disagree with labels from source B (customer disputes) by > threshold, quarantine the batch.

- **Streaming pipeline as single point of failure:** If the Flink cluster fails, all Tier 1 features go stale simultaneously, and the model degrades across all predictions. Improvement: run two independent Flink clusters (active-active) consuming the same Kafka topic with different consumer groups, writing to different Redis keyspaces. The merge layer reads from both and uses whichever is fresher.

- **Feature store consistency across batch and streaming:** As discussed, two code paths computing related features will inevitably diverge. Improvement: adopt a unified feature definition language (Feast, Tecton) where the same feature definition is compiled to both batch (Spark SQL) and streaming (Flink SQL) — one source of truth, two execution engines. This is aspirational; in practice, even with unified definitions, floating-point differences between engines cause subtle divergence.

- **Cold-start for new entities:** A new user with no history has no batch features and no streaming features. The model receives a vector of imputed values, which produces an uninformative (often near-median) prediction. Improvement: content-based initialization — use static attributes (device type, signup source, geo) to initialize a "prior" feature vector that's better than population imputation. Alternatively, use a separate cold-start model trained specifically on new-entity outcomes.

- **Explainability overhead:** Computing SHAP values for 87 features at 20K QPS is expensive (~10ms per prediction for tree-SHAP). Improvement: pre-compute approximate SHAP values for common feature-value ranges and serve them from a lookup table; only compute exact SHAP for a sampled 1% of traffic for monitoring.

---

## 13. Sharp Question

**Q:** You're the ML platform tech lead at a payments company. Your fraud detection model serves 20,000 predictions per second at P99 < 50ms. The business team reports a new fraud pattern: synthetic identity fraud using Buy-Now-Pay-Later (BNPL) layering — fraudsters create accounts with stolen identities, make small legitimate purchases for 2 weeks to build credit, then make a large BNPL purchase and disappear. The current model misses 92% of these cases because the 2-week grooming period looks like normal behavior to batch features. How do you add a new streaming feature that detects this pattern — specifically a "BNPL usage velocity over the last 7 days" feature — and get it into production within 24 hours, without breaking the existing pipeline or adding more than 3ms to P99 latency?

**Model Answer:**

The constraint is tight (24 hours, no >3ms latency increase), which means you can't redesign the streaming pipeline. You need a lightweight addition that plugs into the existing architecture.

**Step 1 — New stream processor (3 hours to deploy):** Instead of modifying the existing Flink job (which requires code review, testing, and a full deployment cycle that typically takes days), deploy a **new, independent Flink job** that consumes the same Kafka topic and computes only one feature: `bnpl_7d_velocity` = count of BNPL transactions in a 7-day sliding window per entity. This job is small (one operator, one window) and can be deployed independently. It writes to a new Redis key: `stream_feat_bnpl:{entity_id}` with TTL 8 days. This pattern — **feature-level microservices for stream processing** — is the real architectural insight. Features should be independently deployable, not bundled into monolithic Flink jobs.

**Step 2 — Feature merge update (1 hour to deploy):** Add one line to the feature merge configuration: `bnpl_7d_velocity → redis("stream_feat_bnpl:{entity_id}")`. This is a config change, not a code change — the merge layer already supports reading from arbitrary Redis keys. The additional Redis GET adds ~1ms to latency (pipelined with existing Redis calls), well within the 3ms budget. No serving-layer code change needed.

**Step 3 — Model update (2 hours to train + validate):** The model needs to learn the new feature's weight. You have two paths:

- **Path A (fastest, recommended for 24h):** Train a new GBDT model (XGBoost/LightGBM) that includes the new feature alongside all existing features. GBDT training on 87 features with 30 days of data takes ~30 minutes on a single GPU. It automatically handles feature interactions (BNPL velocity × account age, BNPL velocity × credit score) without manual feature engineering.

- **Path B (if NN):** Add the new feature to the input layer (88th dimension) and fine-tune the existing model for 2 epochs with a low learning rate, freezing all layers except the first and last. This preserves existing knowledge while incorporating the new signal. ~1 hour on GPU.

Deploy via the standard 4-stage pipeline: offline validation → shadow 2h → canary 4h → full rollout.

**Step 4 — Model doesn't need the new feature to serve (graceful degradation):** The merge layer treats missing `bnpl_7d_velocity` as 0 (the feature didn't exist before, so 0 is the correct historical default). Old model versions (v3) that don't have the 88th input dimension won't be accidentally served the new feature. The serving engine handles variable-length input via feature name mapping, not positional indexing.

**Latency:** +1ms for the additional Redis GET, +0ms for inference (GDBT tree depth is unchanged at 87 → 88 features). Total increase: ~1ms. P99 stays at ~17ms, well under the 50ms budget.

**Common Pitfall:** Engineers try to add the new feature by modifying the existing Flink job, which couples the new feature's deployment to the existing pipeline's release cycle and risks breaking existing features if the window configuration is accidentally changed. The correct pattern is **feature-level isolation** — each feature or small group of related features gets its own stream processor. This is the microservices principle applied to stream processing: independent deployability, independent scaling, independent failure domains.

A second pitfall: assuming the new feature works by just adding it to the input. Without validation on holdout data, you don't know if `bnpl_7d_velocity` is actually predictive of the new fraud pattern. Always validate on a labeled dataset before deploying — the 2-hour training window includes 30 minutes of feature engineering (constructing the label: "was this transaction part of a confirmed BNPL synthetic fraud case?") and 30 minutes of feature importance analysis (does `bnpl_7d_velocity` rank in the top 20 features by SHAP importance?).

---

## Related
- [[topic-queue]]
- [[Feature Store & Online-Offline Consistency]]
- [[Vector Database Internals (HNSW, IVF, Sharding)]]
- [[LLM Serving at Scale (vLLM, Quantization, Batching, KV Cache)]]
- [[Multi-Agent Orchestration (Planning, Tool Use, Memory, Routing)]]
- [[Recommender Systems (Two-Tower, Candidate Gen, Ranking)]]

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Two-stage architecture: candidate generation (millions → thousands) then ranking (thousands → top-N)
- Two-tower model: user tower + item tower produce embeddings; ANN search retrieves nearest items for a user
- Real-time features (last 5 min behavior) must be blended with batch features (30-day history) within the serving latency budget
- Cold-start: new items need content-based features (category, tags) until collaborative signals accumulate
- Online learning: update model weights incrementally as new labels arrive, but validate to prevent overfitting to recent patterns

**Common Follow-Up Questions:**
- "How do you handle the exploration vs exploitation trade-off?" — Reserve a percentage of slots for exploration (random or diverse items) to gather new interaction data. Epsilon-greedy or bandit approaches.
- "What's your latency budget breakdown?" — User embedding (5ms) + ANN retrieval (10ms) + ranking (10ms) + feature fetch (5ms) = ~30ms P99 for homepage recommendations.

**Gotcha:**
- A model with higher CTR isn't always better. Short-term engagement metrics (clicks) can cannibalize long-term metrics (retention, satisfaction). Always monitor north-star metrics alongside model metrics before shipping.
