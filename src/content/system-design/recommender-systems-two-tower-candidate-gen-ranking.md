---
title: "Recommender Systems (Two-Tower, Candidate Gen, Ranking)"
type: system-design
category: AI/ML
date: 2026-06-26
tags: [system-design, interview, ai-ml, recommender-systems, two-tower, candidate-generation, ranking, retrieval, embedding, ann, staff-engineering]
aliases: ["Recommender Systems", "Two-Tower Model", "Candidate Generation", "Recommendation Pipeline", "Deep Retrieval"]
---

# Recommender Systems (Two-Tower, Candidate Gen, Ranking)

> **Staff-Engineer Focus:** "We use collaborative filtering and a two-tower model for recommendations" is the senior-MLE answer. **The staff engineer doesn't stop at model architecture. They ask: "Our product catalog has 80 million items, we serve 5 million DAU, and every user session generates 200 recommendation requests across 6 surfaces (homepage, search, cart, checkout, email, push). That's 1 billion candidate-generation calls and 50 million ranking calls per day, all within a P99 latency budget of 30ms for the homepage widget and 10ms for the mid-article 'you might also like' slot. The two-tower model computes 256-dimensional embeddings for both users and items, but the user tower takes 47 features — 12 of which are real-time (last-30-min behavior stream) and 35 are batch-computed overnight. When a user adds an item to their cart, the ANN index for that user's candidate set is already 15 minutes stale with 2000 candidates pre-computed. Walk me through: (a) how you'd design the candidate-generation pipeline so that real-time user actions (clicks, adds-to-cart, purchases) update the user embedding within 500ms and refresh the ANN retrieval set — do you recompute the full embedding, partial-update, or use a separate 'recent intent' signal blended post-retrieval, (b) your strategy for multi-stage filtering when the business rules engine says 'no out-of-stock items, no items the user already purchased, respect the user's blocked-creator list and brand-safety denylist, cap at most 2 items from the same brand, and boost items from the A/B experiment group X by 15%' — at which stage does each filter apply and what's the cost of getting the ordering wrong, (c) the cold-start problem for a new item added 3 minutes ago with zero interactions — how do you make it discoverable without waiting for collaborative signals, and what happens when a viral item goes from 0 to 100K interactions in 20 minutes, and (d) how you'd detect that the ranking model's CTR is up 3% but long-term retention is down 1.2% — and what you'd tell the VP of Product who's asking why we can't just ship the model with the higher CTR?"** The interview question isn't "What's a two-tower model?" It's: "You have 80M items, 5M users, and 200ms end-to-end. Design the system."

---

## Summary & Interview Framing

A two-stage system — candidate generation retrieves relevant items via two-tower neural networks and ANN search, then ranking scores them with a deep model using user and item features.

**How it's asked:** "Design a recommendation system for 80M items and 5M users with 200ms latency budget. Cover candidate generation, ranking, cold-start, and real-time feature updates."

---

## 1. Overview

A recommender system at internet scale is not one model. It is a multi-stage funnel — a pipeline that narrows an enormous item corpus (tens or hundreds of millions) down to a handful of personalized candidates (dozens) in under 200 milliseconds. Each stage trades recall for precision, and the architecture of this funnel — not the details of any single model — determines whether your recommendations are fast enough to serve and good enough to matter.

The three canonical stages are **candidate generation** (retrieval), **ranking** (scoring), and **post-processing** (filtering/re-ranking). Candidate generation is the recall stage: it takes the full catalog and produces a few hundred to a few thousand plausible items. Ranking is the precision stage: it scores those candidates and picks the top N to display. Post-processing applies business rules, diversity constraints, and freshness boosts.

At the heart of modern large-scale candidate generation is the **two-tower model**: one neural network (the user tower) encodes users into a dense vector, another (the item tower) encodes items into the same vector space. Recommendation becomes a nearest-neighbor search: given a user embedding, find the items whose embeddings are closest. This decoupling is the key insight — user and item embeddings can be computed independently and cached, making retrieval blazingly fast via approximate nearest neighbor (ANN) indexes.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    RECOMMENDER SYSTEM — THREE-STAGE FUNNEL                 │
│                                                                           │
│  80M ITEMS                                                                │
│  ───────────────────────────────────────────────────────────────────────  │
│     │                                                                     │
│     │  STAGE 1: CANDIDATE GENERATION (Recall)                             │
│     │  ┌──────────────────────────────────────────┐                       │
│     │  │ Two-Tower ANN │ Collaborative Filtering   │                       │
│     │  │ Graph Traversal│ Real-Time Behavior Match  │                       │
│     │  └──────────────────────────────────────────┘                       │
│     │  Latency: 5-15ms  |  Recall target: >95% of relevant items          │
│     ▼                                                                     │
│  ~2,000 CANDIDATES                                                        │
│  ───────────────────────────────────────────────────────────────────────  │
│     │                                                                     │
│     │  STAGE 2: RANKING (Precision)                                       │
│     │  ┌──────────────────────────────────────────┐                       │
│     │  │ Deep Cross Network │ Multi-Task (CTR+CVR) │                       │
│     │  │ Feature Crosses    │ Gradient-Boosted Tree│                       │
│     │  └──────────────────────────────────────────┘                       │
│     │  Latency: 20-50ms  |  Scores: CTR, CVR, engagement, diversity       │
│     ▼                                                                     │
│  ~200 SCORED CANDIDATES                                                   │
│  ───────────────────────────────────────────────────────────────────────  │
│     │                                                                     │
│     │  STAGE 3: POST-PROCESSING (Filter + Re-Rank)                        │
│     │  ┌──────────────────────────────────────────┐                       │
│     │  │ Business Rules │ Diversity │ Freshness    │                       │
│     │  │ A/B Experiment  │ Ad Policy │ Frequency Cap│                      │
│     │  └──────────────────────────────────────────┘                       │
│     │  Latency: 1-5ms                                                      │
│     ▼                                                                     │
│  TOP-20 ITEMS → USER SCREEN                                               │
└──────────────────────────────────────────────────────────────────────────┘
```

The separation into stages is not an optimization — it's an architectural necessity. You cannot run a deep neural network with hundreds of feature crosses on 80 million items in 200ms. You can, however, run a cheap similarity search (dot product in embedding space via ANN) on 80M items in <10ms, then run the expensive ranker on the top 2,000. This is the fundamental trade-off of recommender systems: **recall at the first stage, precision at the second, business logic at the third.**

---

## 2. Key Requirements

### Functional Requirements
- Serve personalized recommendations across multiple surfaces (homepage feed, related items, search autocomplete, email, push notifications)
- Support real-time updates — user clicks an item, next page load reflects that signal
- Multi-objective optimization: optimize for clicks AND purchases AND session length AND diversity (not just CTR)
- Cold-start handling for new users (no history) and new items (no interactions)
- A/B experimentation framework — canary 1% of traffic to a new candidate-generation strategy without affecting the other 99%
- Business rules engine: block out-of-stock, respect creator blocklists, apply brand-safety filters, cap brand frequency, boost promotional items
- Explainability: why was this item recommended? (for both user trust and debugging)

### Non-Functional Requirements (SLAs)
- **End-to-end latency:** P99 < 200ms for full funnel (candidate gen + ranking + post-processing), P99 < 30ms for lightweight surfaces
- **Throughput:** 1B+ candidate-generation calls/day, 50M+ ranking calls/day at peak
- **Availability:** 99.95% — degraded recommendations (stale embeddings, fallback to global-popular) are acceptable; empty results are not
- **Freshness:** User embedding updated within 500ms of a real-time event; item embedding updated within 5 minutes of metadata change
- **Consistency:** Eventual — it is acceptable for a recommendation to be 30 seconds stale; it is not acceptable for it to be 30 minutes stale on an active session
- **Cost:** 80% of inference cost should be in the cheap candidate-generation stage, not the expensive ranking stage

---

## 3. Capacity Planning

| Metric | Estimate |
|--------|----------|
| DAU | 5 million |
| Items in catalog | 80 million |
| Surfaces per user session | 6 (homepage, search, cart, checkout, email, push) |
| Recommendation requests per user per session | ~200 (includes scroll-as-you-go pagination) |
| Candidate gen calls/day | 5M × 200 = 1 billion |
| Ranking calls/day (2K candidates each) | 1 billion retrievals × (varies) ≈ 50M ranking calls |
| Embedding dimension | 256 (user and item) |
| Embedding storage (80M items × 256 × 4 bytes) | ~82 GB |
| User embedding cache (5M users × 256 × 4 bytes) | ~5 GB |
| ANN index size (80M × 256 × 4 bytes + graph overhead ~2x) | ~164 GB |
| Peak QPS candidate gen (10% of daily in peak hour) | ~28,000 QPS |
| Peak QPS ranking | ~1,400 QPS |
| Real-time event stream throughput | ~50K events/sec (clicks, purchases, views) |

**Storage choice:** Embeddings stored in a vector database or ANN index (Faiss IVF-PQ, ScaNN, HNSW in-memory). Item metadata in a key-value store (DynamoDB/Redis) for fast post-retrieval enrichment. Training data in a data lake (Parquet/Iceberg) for offline training pipelines.

---

## 4. Data Model

```
User Profile (offline, daily batch)
  - user_id: UUID
  - user_embedding: float[256]  (computed nightly, refreshed intra-session)
  - demographic_features: {age_bucket, country, language, device_type}
  - long_term_interests: [{category_id, weight}]
  - recent_interactions: [{item_id, action_type, timestamp}]  (last 30 days)
  - segment: enum[new, casual, power, dormant]

Item Catalog
  - item_id: UUID
  - item_embedding: float[256]
  - title, description, category, brand_id, creator_id
  - price, currency, availability_status
  - content_tags: [string]
  - creation_timestamp, last_updated

Interaction Event (real-time stream, Kafka)
  - event_id: UUID
  - user_id, item_id
  - event_type: enum[impression, click, add_to_cart, purchase, share, hide, report]
  - timestamp: epoch_ms
  - surface: enum[homepage, search, cart, ...]
  - session_id: UUID
  - experiment_ids: [string]

Recommendation Request (gRPC)
  - user_id: UUID
  - surface: enum
  - context: {device, locale, time_of_day, session_active_duration}
  - num_results: int (default 20)
  - exclude_items: [UUID]  (already seen this session)
  - experiment_overrides: map[string]string
```

---

## 5. The Two-Tower Model — Deep Dive

The two-tower architecture is the workhorse of large-scale candidate generation. Its defining property is that the user tower and item tower are **independent at inference time** — you compute the user embedding once, then find the nearest item embeddings in a pre-built index. No cross-features between user and item at retrieval time.

### How it works

```
┌─────────────────────┐          ┌─────────────────────┐
│     USER TOWER      │          │     ITEM TOWER       │
│                     │          │                      │
│  user_id            │          │  item_id             │
│  demographics ──┐   │          │  category ───────┐    │
│  long_term ─────┤   │          │  brand ──────────┤    │
│  recent_acts ───┤   │          │  price ──────────┤    │
│  context ───────┘   │          │  content_tags ───┘    │
│       │             │          │       │               │
│       ▼             │          │       ▼               │
│  ┌─────────┐        │          │  ┌─────────┐          │
│  │ DNN     │        │          │  │ DNN     │          │
│  │ (FC +   │        │          │  │ (FC +   │          │
│  │  ReLU)  │        │          │  │  ReLU)  │          │
│  └────┬────┘        │          │  └────┬────┘          │
│       │             │          │       │               │
│       ▼             │          │       ▼               │
│   user_emb          │          │   item_emb            │
│   float[256]        │          │   float[256]          │
│   L2-normalized     │          │   L2-normalized       │
└─────────────────────┘          └─────────────────────┘
         │                               │
         │         similarity =          │
         └─────── user_emb · item_emb ───┘
                  (dot product / cosine)
```

**Training objective:** During training, the two towers ARE connected — the dot product of user and item embeddings is fed into a loss function. A common loss for implicit feedback is the **sampled softmax loss** (also called batch softmax or in-batch negative sampling): treat the correct (user, item) pair as the positive, and all other items in the same batch as negatives. This scales to massive catalogs because you only need to compute the item embeddings for ~1,000 items per batch, not 80 million.

The user tower takes features that can be a mix of:
- **Static/demographic:** age bucket, country, language, device, account age
- **Long-term behavioral:** category affinities, average purchase frequency, price sensitivity
- **Recent behavioral (sequence features):** last 50 item IDs → embedding lookup → average pooling or lightweight transformer
- **Contextual:** time of day, day of week, session duration, surface type

The item tower takes:
- **Categorical:** item_id, category, brand, creator
- **Textual:** title, description → pretrained text embedding (e.g., from a small BERT)
- **Numerical:** price, rating, popularity score, age of item
- **Content-based:** image embedding, video embedding (for multimedia platforms)

### The real-time user embedding problem

The classic two-tower setup re-computes user embeddings daily in batch. But if a user just clicked on three running shoes, the nightly embedding doesn't know that — and the next 50 page loads will recommend based on yesterday's interests.

**Solution: hybrid embedding with a "fast" and "slow" component.**

```
User Embedding = α × slow_emb  +  β × fast_emb  +  γ × context_emb

slow_emb:  recomputed nightly, captures long-term interests
           (computed by user tower offline, cached in Redis with 24h TTL)

fast_emb:  updated in real-time from the last 50 interactions
           (lightweight: interaction item embeddings → weighted average)
           (stored in Redis with 30-min TTL, updated on each event)

context_emb: session-level signals — current surface, time of day, scroll depth
           (computed at request time, cheap — just feature lookup + tiny MLP)
```

The blending weights α, β, γ can themselves be learned (a small gating network) or tuned as hyperparameters. The key insight: the slow embedding provides stability and long-term personalization, the fast embedding provides reactivity to immediate intent, and the context embedding handles surface-specific behavior (what you want on the homepage vs. in search results is different even for the same user).

---

## 6. Candidate Generation Pipeline

Candidate generation is not one method — it's a **blended retrieval** strategy that combines multiple sources. No single method achieves both high recall and freshness across all scenarios.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    CANDIDATE GENERATION — BLENDED RETRIEVAL               │
│                                                                           │
│  REQUEST: user_id=42, surface=homepage, context={...}                     │
│       │                                                                   │
│       ├──▶ SOURCE 1: Two-Tower ANN (1,500 candidates)                     │
│       │    ┌──────────────────────────────────────────┐                   │
│       │    │ user_emb = redis.get("emb:u:42")          │                   │
│       │    │ results  = ann_index.search(user_emb, k=1500)│                │
│       │    │ Latency: 3-5ms   Recall: 60-70%           │                   │
│       │    └──────────────────────────────────────────┘                   │
│       │                                                                   │
│       ├──▶ SOURCE 2: Real-Time Behavior Match (300 candidates)            │
│       │    ┌──────────────────────────────────────────┐                   │
│       │    │ recent_items = redis.lrange("u:42:recent", 0, 50)│           │
│       │    │ for each item: co_visited = item2item_graph.neighbors(item) │ │
│       │    │ Latency: 2-4ms   Recall: 15-20% (freshness) │                │
│       │    └──────────────────────────────────────────┘                   │
│       │                                                                   │
│       ├──▶ SOURCE 3: Collaborative Filtering (100 candidates)             │
│       │    ┌──────────────────────────────────────────┐                   │
│       │    │ similar_users = user2user_graph.neighbors(user_id)│          │
│       │    │ candidates = popular_items_from(similar_users)  │           │
│       │    │ Latency: 1-2ms   Recall: 5-10%            │                   │
│       │    └──────────────────────────────────────────┘                   │
│       │                                                                   │
│       ├──▶ SOURCE 4: Global Popular / Trending (50 candidates)            │
│       │    ┌──────────────────────────────────────────┐                   │
│       │    │ top_items = redis.zrevrange("trending:global", 0, 50)│       │
│       │    │ Latency: <1ms   Recall: N/A (exploration) │                   │
│       │    └──────────────────────────────────────────┘                   │
│       │                                                                   │
│       └──▶ SOURCE 5: New-Item Boost (50 candidates)                       │
│            ┌──────────────────────────────────────────┐                   │
│            │ new_items = redis.zrevrange("new:items", 0, 50)│             │
│            │ Latency: <1ms   Recall: N/A (cold-start)  │                   │
│            │            (scored by category match + content sim)│         │
│            └──────────────────────────────────────────┘                   │
│                                                                           │
│       ▼                                                                   │
│  FUSION: deduplicate, interleave (round-robin from each source)           │
│  ───────────────────────────────────────────────────────────────────────  │
│  ~2,000 UNIQUE CANDIDATES → Ranking Stage                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

### The Item2Item and User2User Graphs

The item-to-item co-occurrence graph is built from session data: "users who interacted with item A also interacted with item B." This is essentially a sparse adjacency matrix, stored as:

```
Key: "i2i:{item_id}"
Value: [(neighbor_item_id, co_occurrence_score), ...]  (top 200 neighbors)
```

Updated hourly from a Spark job that reads the last 30 days of interaction logs. The graph captures collaborative patterns without needing embeddings — it's inherently real-time responsive because new interactions feed into the next hourly update.

### ANN Index Choices

| Method | Index Build Time | Query Latency (k=1000) | Memory | Recall@1000 |
|--------|-----------------|----------------------|--------|-------------|
| Faiss IVF-PQ | Minutes | 2-5ms | Low (compressed) | 90-95% |
| Faiss HNSW | Minutes | 1-3ms | High (graph) | 95-99% |
| ScaNN (Google) | Hours | 1-2ms | Medium | 95-99% |
| Brute-force | N/A | 80ms | N/A | 100% |

At 80M items, brute-force is out. The pragmatic choice for most teams is **Faiss IVF-PQ** for cost efficiency or **ScaNN** for latency-sensitive surfaces. The index is rebuilt nightly after item embeddings are recomputed. For real-time item additions (new products), a separate small in-memory index holds the last 24 hours of new items and is queried in parallel.

---

## 7. Ranking — From 2,000 to 20

Once candidate generation has narrowed 80M items to ~2,000, the ranking stage applies a much more expensive model. Here, cross-features between user and item ARE computed — this is where the model learns that "user_123 likes sports shoes from Brand X in the $80-120 range, but only on weekends."

### Model Architecture: Deep & Cross Network (DCN)

```
┌──────────────────────────────────────────────────────────────────────┐
│                     RANKING MODEL — DCN-V2                             │
│                                                                        │
│  INPUT: (user_features, item_features, context_features)               │
│     │                                                                  │
│     ├──▶ Cross Network (explicit feature crosses)                      │
│     │    x_0 = concat(all_features)                                    │
│     │    x_1 = x_0 ⊙ (W × x_0) + b + x_0                              │
│     │    x_2 = x_0 ⊙ (W × x_1) + b + x_1                              │
│     │    ... (6 cross layers)                                          │
│     │    Captures: user_age_bucket × item_category × price_range       │
│     │                                                                  │
│     └──▶ Deep Network (fully connected)                                │
│          h_0 = concat(all_features)                                    │
│          h_1 = ReLU(W × h_0 + b)                                       │
│          h_2 = ReLU(W × h_1 + b)                                       │
│          ... (4 hidden layers, 1024 → 512 → 256 → 128)                 │
│          Captures: complex non-linear interactions                     │
│                                                                        │
│     Both → concat(cross_output, deep_output) → output_layer            │
│                                                                        │
│  OUTPUT:                                                                │
│     ┌──────────────┬──────────────┬──────────────┐                     │
│     │  CTR head    │  CVR head    │  Engagement   │                     │
│     │  (sigmoid)   │  (sigmoid)   │  (regression) │                     │
│     │  "will click"│ "will buy"   │  "time on pg" │                     │
│     └──────────────┴──────────────┴──────────────┘                     │
│                                                                        │
│  FINAL SCORE = w₁·CTR + w₂·CVR + w₃·engagement + w₄·diversity_bonus  │
│                (weights tuned per surface via Bayesian optimization)    │
└──────────────────────────────────────────────────────────────────────┘
```

The cross network is what makes this more powerful than a plain MLP. In a regular DNN, feature interactions (like "user from Germany + item priced in USD") must be learned implicitly from data. The cross network computes them explicitly, which means it learns faster with less data and generalizes better to rare feature combinations.

### Multi-Task Learning

Recommenders are fundamentally multi-objective: you want clicks (engagement), purchases (revenue), session length (retention), and diversity (discovery). Optimizing for any single metric leads to pathological behavior:
- **Maximizing CTR only:** clickbait titles, sensational items, rage-bait
- **Maximizing CVR only:** only show items the user would definitely buy → boring, no discovery
- **Maximizing session length only:** infinite scroll traps, addiction-maximizing

The multi-task setup shares the bottom layers (feature representation) and has task-specific heads. The loss is a weighted sum: `L = α·L_ctr + β·L_cvr + γ·L_engagement`. The weights α, β, γ are hyperparameters tuned against a long-term business metric (e.g., 30-day retention), not the individual task metrics. This is crucial — you tune the weights so that optimizing the composite loss improves retention, even if individual task metrics appear worse.

---

## 8. Post-Processing — The Filter Funnel

Even perfect ML outputs need business logic. The post-processing stage applies filters and re-ranking rules. **Order matters enormously** — filtering 1,900 items out of 2,000 before ranking is cheap; filtering them after ranking wastes 1,900 expensive inferences.

```
┌────────────────────────────────────────────────────────────────────┐
│                    POST-PROCESSING FILTER CHAIN                      │
│                                                                      │
│  2,000 RANKED CANDIDATES                                             │
│     │                                                                │
│     ├──▶ 1. HARD FILTERS (remove, no recovery)                       │
│     │    • Out of stock / delisted / expired                         │
│     │    • Blocked creator / brand-safety denylist                   │
│     │    • User already purchased (optional, configurable)           │
│     │    • Items already seen this session (dedup)                   │
│     │    Cost: O(n) lookups, ~1ms                                    │
│     │    ~1,800 remain                                               │
│     │                                                                │
│     ├──▶ 2. SOFT CONSTRAINTS (re-rank, don't remove)                 │
│     │    • Max 2 items per brand (promote top 2, demote rest)        │
│     │    • Max 3 items per category                                  │
│     │    • Price diversity: ensure at least 1 budget, 1 mid, 1 premium│
│     │    Cost: O(n log n) sort within groups, ~2ms                   │
│     │                                                                │
│     ├──▶ 3. EXPERIMENT BOOSTS (multiply score)                       │
│     │    • A/B group X: boost items from seller cohort Y by 15%      │
│     │    • New-item boost: boost items < 7 days old by 10%           │
│     │    • Re-engagement boost: boost dormant-category items by 5%   │
│     │    Cost: O(n), ~1ms                                            │
│     │                                                                │
│     └──▶ 4. FINAL DIVERSITY RE-RANK (MMR)                            │
│          • Maximum Marginal Relevance: greedily select items         │
│            that maximize score × (1 - λ·max_similarity_to_selected)  │
│          • Ensures the final list isn't 20 nearly-identical items    │
│          • Cost: O(n × k) where k=20, ~3ms                           │
│                                                                      │
│  TOP-20 ITEMS → RESPONSE                                             │
└────────────────────────────────────────────────────────────────────┘
```

### Why filter ordering is a staff-engineer question

If you put business-rule filters AFTER ranking, you waste ranking compute on items you'll discard. If you put them BEFORE candidate generation, you might filter out the very items the user would have loved (recall loss). The correct answer: **hard filters (availability, blocklists) before ranking; soft constraints (diversity, brand caps) after ranking** because they depend on the relative scores.

---

## 9. Cold-Start Strategy

Every recommender has a cold-start problem. There are two variants:

### New User (no interaction history)

| Strategy | How It Works | When to Use |
|----------|-------------|-------------|
| Demographic prior | Use age/location/device to serve popular items in that cohort | First session |
| Onboarding survey | Ask for 3-5 categories/topics of interest | During signup (if UX allows) |
| Context-only embedding | Use time-of-day, surface, device → trained embedding from other users | Always available |
| Explore-exploit mix | 70% popular + 30% random high-quality items | First 10 sessions |

### New Item (zero interactions)

This is harder. The two-tower model's item embedding depends on interaction data that doesn't exist yet.

| Strategy | How It Works | Latency Impact |
|----------|-------------|---------------|
| Content-based embedding | Use title/description/image → text/image encoder → embedding | None (pre-computed at item creation) |
| Category/brand prior | Average embedding of items in same category + brand | None (pre-computed) |
| New-item boost in retrieval | Always include top-N new items in candidate blend (Source 5 above) | +1ms |
| Forced exploration slots | Reserve 1-2 slots in every feed for items < 24h old | None |
| Creator-fan injection | Show new item to followers of its creator (if creator-follow exists) | +2ms for graph lookup |

The content-based path is the backbone: even without interactions, the item has a title, description, image, price, and category. An embedding from these alone gets you 60-70% of the way to a fully-trained collaborative embedding. As interactions accumulate, the collaborative signal gradually overrides the content signal.

---

## 10. Scaling & Bottlenecks

### Read Path (serving a recommendation)

```
1. Client → API Gateway (gRPC, 200ms timeout)
2. Gateway → Candidate Gen Service
   a. Fetch user embedding from Redis (or compute fast_emb + context_emb) — 2ms
   b. ANN search in Faiss index — 3-5ms
   c. Parallel: item2item graph lookup — 2-4ms
   d. Parallel: collaborative filter, trending, new-items — 1-2ms each
   e. Fuse + deduplicate — 1ms
   → Returns ~2,000 candidate IDs — total 10-15ms

3. Gateway → Ranking Service
   a. Fetch item features for 2,000 items from feature store — 5ms (batched, cached)
   b. Run DCN model inference (batched) — 10-20ms on GPU, 30-50ms on CPU
   c. Sort by final score — 1ms
   → Returns top 200 scored items — total 20-40ms

4. Gateway → Post-Processing (often in-process with ranking)
   a. Hard filters, soft constraints, diversity re-rank — 3-5ms

Total: 35-60ms P50, 100-150ms P99 (well under 200ms budget)
```

### Write Path (updating embeddings)

```
1. User clicks "Add to Cart" → event published to Kafka (topic: user_events)
2. Real-Time Consumer Group:
   a. Updates Redis: LPUSH "u:42:recent" item_id; LTRIM to 50
   b. Updates "fast_emb" in Redis: recompute weighted avg of last 50 item embeddings
   c. Updates item2item graph edge weights (async, batched every 5 min)
   → User's next request sees updated fast embedding — ~300ms end-to-end

3. Hourly Batch Jobs (Spark):
   a. Rebuild item2item and user2user graphs from last 30 days of events
   b. Recompute item popularity scores, trending scores

4. Nightly Batch Jobs (Spark on GPU cluster):
   a. Retrain two-tower model on last 30 days of interaction data
   b. Recompute all 80M item embeddings
   c. Rebuild ANN index
   d. Recompute slow user embeddings for all 5M users → bulk-load Redis
```

### Bottlenecks and Mitigations

| Bottleneck | Symptom | Mitigation |
|-----------|---------|------------|
| ANN index memory | 164 GB doesn't fit on one machine | Shard by item_id modulo N across N machines; query all shards, merge top-K |
| Redis user embedding cache | 5M users, reads at 28K QPS → hotspot | Client-side local cache (LRU, 10K entries, 30-sec TTL) in each candidate-gen instance |
| Ranking model inference | 2K items × 50ms CPU = 100ms (too slow) | Batch inference on GPU (2K items in one forward pass ~10ms); use TensorRT/ONNX for optimized inference |
| Real-time event backpressure | 50K events/sec overwhelms consumer | Partition Kafka by user_id; consumer auto-scales with Consumer Group; fast_emb update is idempotent (last-write-wins is fine) |
| Cold-start latency spikes | New item embedding not yet in ANN index | Separate "new items" index (<100K items, brute-force OK); merge results client-side |
| Feature store latency | 2,000 items × 100 features = 200K lookups per ranking call | Batch fetch + client-side feature cache (TTL 5 min for stable features like category, 1 min for dynamic like price) |

---

## 11. Consistency & Freshness

Recommender systems are **eventually consistent by design.** The question is: how eventual?

| Data | Staleness Window | Consistency Model | Rationale |
|------|-----------------|-------------------|-----------|
| Item metadata (title, price, stock) | < 1 min | Eventual (CDC from source DB) | Must be fast to prevent recommending out-of-stock items |
| User slow embedding | 24 hours | Eventual (nightly batch) | Long-term interests don't change hour-to-hour |
| User fast embedding | < 500ms | Eventual (real-time stream) | Immediate intent — must react to "just searched for camping gear" |
| Item embedding | 24 hours (rebuilt nightly) + 5 min for new items | Eventual | Catalog changes slowly; content embedding bridges the gap for new items |
| Item2Item graph | 1 hour | Eventual (hourly Spark job) | Co-occurrence patterns evolve slowly |
| Trending/popularity scores | 15 min | Eventual (sliding window) | "What's hot right now" must be fresh |

There is no strong consistency requirement anywhere. A recommendation that's 30 seconds stale due to cache is imperceptible. A recommendation that's 30 minutes stale because the batch job failed is a problem — but it's a freshness problem, not a correctness bug. The system degrades gracefully: serve the stale embedding rather than return nothing.

---

## 12. Caching Strategy

Recommendation systems cache aggressively because latency budgets are tight and perfect freshness is unnecessary.

| Cache Layer | What | Where | Size | TTL |
|------------|------|-------|------|-----|
| L1: Request-scoped dedup | Items already seen this session | In-memory (request context) | ~200 IDs | Request duration |
| L2: User embedding (slow) | user_emb[256] | Redis cluster | 5M × 1KB = 5 GB | 24 hours |
| L2: User embedding (fast) | fast_emb[256] | Redis cluster | 5M × 1KB = 5 GB | 30 min |
| L3: Item embeddings | item_emb[256] | In Faiss index (memory-mapped) | 80M × 1KB = 80 GB | 24 hours (index rebuild) |
| L4: Item features | category, brand, price, etc. | Redis / feature store | 80M × 2KB = 160 GB | 5 min (metadata), 1 min (price/stock) |
| L5: Popular/trending lists | top-N item IDs | Redis sorted sets | ~1K items × 5 lists | 15 min |
| L6: Client-side LRU | user embeddings | In candidate-gen service memory | 10K entries | 30 sec |

Cache invalidation is TTL-based — no explicit invalidation. This is acceptable because recommendations are inherently tolerant of staleness. The one exception: when an item goes out of stock, the hard-filter stage (post-processing, before final response) will catch it regardless of cache state — the cache may still return the item as a candidate, but the filter blocks it before the user sees it.

---

## 13. Weaknesses & Improvements

- **Position bias feedback loop:** Items shown at position 1 get more clicks because they're at position 1, which trains the model to rank them higher, which keeps them at position 1. Mitigation: during training, use position as a feature but strip it at inference; periodically inject random items at top positions to collect unbiased feedback.
- **Popularity bias:** Popular items appear in more training examples, get better embeddings, get retrieved more often. Mitigation: negative sampling weights inversely proportional to item popularity; separate exploration budget.
- **Echo chambers:** The system recommends what you already like, never challenging or expanding your interests. Mitigation: diversity constraints in post-processing; a dedicated "discovery" surface with higher exploration weight.
- **Single embedding per item is limiting:** An item that appeals to wildly different user segments (e.g., a book that is both a romance novel and a historical fiction) gets averaged into one embedding that captures neither well. Improvement: multi-embedding approaches — learn K embeddings per item, route users to the most relevant one via a small gating network.
- **ANN index rebuild is a single point of staleness:** If the nightly job fails, the index is 48 hours stale. Improvement: online index update — insert/update embeddings in the HNSW graph incrementally; periodic compaction to reclaim deleted nodes.
- **Training-serving skew in feature computation:** If the "user_30d_avg_purchase" feature is computed with a 30-day rolling window in training but a 30-day fixed window at serving, the values differ. Mitigation: feature store with point-in-time correctness (see Day 50 — Feature Store).

---

## 14. Sharp Question

**Q:** You're designing the recommendation system for an e-commerce platform with 80M items. The product manager wants to add a "real-time trending" section to the homepage that shows items spiking in popularity within the last 15 minutes. Your two-tower ANN index is rebuilt nightly, so new trending items won't have strong collaborative embeddings yet. How do you make this work without blowing your 200ms latency budget?

**Model Answer:**

The trending section should NOT go through the two-tower retrieval path — the two-tower is fundamentally a collaborative-filtering model that needs interaction history, which trending items by definition don't have enough of.

Instead, build a separate lightweight pipeline:

1. **Trending detection (offline, streaming):** A Flink/Kafka Streams job consumes the click/purchase event stream, maintains a sliding 15-minute window of per-item interaction counts, and compares to a 24-hour baseline. Items with a z-score above threshold (e.g., >3 standard deviations above baseline) are flagged as trending. Results are written to a Redis sorted set: `trending:homepage → [(item_id, trending_score), ...]`.

2. **Candidate injection at retrieval time:** The candidate generation service always fetches the top 50 trending items (latency <1ms from Redis) and injects them as a separate source in the blended retrieval pool. They bypass the ANN lookup entirely.

3. **Content-based relevance filter:** Before the trending candidates enter the ranking pool, apply a lightweight relevance check — compute the cosine similarity between the user's slow embedding and the item's content-based embedding (pre-computed from title/description at item creation time, stored in Redis). Trending items below a similarity threshold are dropped. This prevents showing a trending car tire to a user who only buys fashion.

4. **Ranking still applies:** The trending candidates flow through the same ranking model as all other candidates. The ranking model will naturally down-rank items that don't match the user's preferences — but the trending signal gives them a chance to be scored that they wouldn't have gotten through the ANN path alone.

5. **Dedicated slots in post-processing:** Reserve 2 out of 20 slots on the homepage for trending items (if any pass the relevance filter). This ensures they get visibility without overwhelming the feed.

Latency breakdown: Redis trending fetch (<1ms) + content-similarity check (~2ms for 50 items) + flow through existing ranking pipeline (already accounted for). No net increase to P99.

**Common Pitfall:** Candidates try to solve this by "just making the two-tower handle it" — increasing the real-time update frequency of item embeddings or rebuilding the ANN index more often. This is the wrong lever. The two-tower's embedding for a 15-minute-old trending item will be dominated by the content-based initialization (title/description), which the ANN index already has. The problem isn't the embedding quality — it's that the ANN index, by design, surfaces items near the user embedding. A trending item that's outside the user's normal interest cluster won't surface regardless of how fresh its embedding is. You need a separate path — a "popularity" signal that bypasses the personalized retrieval entirely and lets the ranker decide if the user would actually like it.

---

## Related
- [[topic-queue]]
- [[Feature Store & Online-Offline Consistency]]
- [[Vector Database Internals (HNSW, IVF, Sharding)]]
- [[Real-Time ML Inference (Streaming Features, Online Learning)]]

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Two-stage pipeline: candidate generation (two-tower ANN, fast, high recall) → ranking (deep model, slow, high precision)
- Two-tower model trains user and item towers separately; dot product of embeddings measures relevance
- ANN index (HNSW, IVF) enables sub-10ms retrieval over millions of items
- Business rules (out-of-stock filter, brand caps, diversity) apply between candidate gen and ranking
- Cold-start: use content features (text, category, image embeddings) for new items with no interaction history

**Common Follow-Up Questions:**
- "How do you update the ANN index when new items are added?" — For HNSW, insert incrementally (O(log N)). For IVF, periodically rebuild. Real-time insertion is possible but monitor index quality degradation.
- "How do you handle A/B testing of recommendation models?" — Route a percentage of traffic to the new model via a feature flag. Compare not just CTR but also revenue, retention, and diversity metrics over 1-2 weeks.

**Gotcha:**
- The candidate generation stage's recall is the ceiling for ranking quality. If the best item isn't in the candidate set, the ranker can't surface it. Always measure candidate recall (did the relevant item make it into the top-K candidates?) before optimizing the ranker.
