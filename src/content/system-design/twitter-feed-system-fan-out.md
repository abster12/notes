---
title: "Twitter / Feed System (Fan-out)"
type: system-design
category: Advanced
date: 2026-05-17
tags: [system-design, interview, advanced, feed-system, twitter]
aliases: []
---

# Twitter / Feed System (Fan-out)

## Summary & Interview Framing

A system that delivers tweets to followers' feeds using fan-out-on-write (push to all followers) for normal users and fan-out-on-read (pull on demand) for celebrities.

**How it's asked:** "Design Twitter's timeline system for 300M users. Handle the celebrity problem (50M followers), feed ordering, and the hybrid push/pull model."

---

## Overview

A social media feed system delivers a personalized, reverse-chronological stream of posts from the accounts a user follows. The superficial product description is simple — "show me the latest tweets from people I follow" — but the engineering reality is one of the hardest read-heavy, write-amplified problems in consumer software. The crux is the **fan-out problem**: when a single user posts a tweet, that tweet must, in some form, become visible to every one of their followers. If a user has a hundred million followers, a single keystroke can translate into a hundred million downstream effects. Designing a feed system is fundamentally about choosing *where* and *when* that amplification happens — at write time, at read time, or some combination of both — and then making that choice survive at the scale of hundreds of millions of daily active users without violating latency, consistency, or cost budgets.

This document walks through the full design space: the push and pull models and their hybrid, timeline caching with Redis sorted sets, persistent storage in Cassandra, ranking algorithms that go beyond reverse-chronological ordering, the celebrity problem and its tiered mitigations, cursor-based feed pagination, real-time streaming updates, consistency tradeoffs, and a concrete capacity estimation for a 300M-DAU service. The goal is the depth a senior or staff engineer would be expected to reach in a system design interview.

## Requirements

### Functional Requirements

- Users can publish short posts (historically 140 characters, now 280, optionally with images, video, or a link card).
- Users can follow or unfollow any other user.
- The home timeline must display posts from all followed accounts in reverse-chronological order by default.
- Engagement actions — likes, retweets, replies — influence ranking in enhanced modes.
- Users must see their own tweets immediately after posting.
- A user who unfollows someone should stop seeing that account's new tweets in their feed without needing to reload history.
- The system must also support a user timeline (one person's posts), a search surface, and trending topics, though those are secondary to the home feed.

### Non-Functional Requirements

- **Read latency:** feed loads must return in under 100 milliseconds at the 99th percentile because a slow feed directly tanks engagement.
- **Write throughput:** roughly 500 million tweets per day, averaging around 5,800 tweets per second but with peak bursts (breaking news, major events) reaching several times that.
- **Fan-out latency:** the time between a tweet being posted and it appearing in the *last* follower's feed should be on the order of seconds for pushed content, not minutes.
- **Availability:** 99.9% or better, with graceful degradation — a partial Redis outage should not prevent feed rendering, only slow it.
- **Cost:** a persistent constraint, so we cannot simply push every tweet to every follower regardless of follower count.

## Capacity Estimation for 300M Users

Working from 300 million daily active users, we assume each user opens the app roughly five times per day and scrolls through an average of 150 feed items per session.

**Read volume:**

- ~225 billion feed item impressions per day
- Sustained read rate of roughly 2.6 million feed reads per second
- Peaks above 1 million concurrent feed requests during evening hours
- Read-to-write ratio is roughly 500:1

**Write and fan-out volume:**

- 500 million tweets per day
- Average of 500 followers per user (heavy power-law distribution: a tiny fraction of accounts have tens of millions of followers while the vast majority have fewer than a thousand)
- Naive push to every follower = ~250 billion feed-item insertions per day
- This is the number that makes pure push infeasible for celebrities and motivates the hybrid design

**Storage:**

- Each tweet averages ~500 bytes of metadata and text (media is stored in object storage and referenced by URL)
- 500M tweets/day × 500 bytes = 250 GB/day of raw tweet data
- ~7.5 terabytes for a 30-day hot window
- Feed cache (materialized for 300M users, each capped at 800 entries of 8-byte tweet IDs): 300M × 800 × 8 bytes ≈ 1.9 TB logical state
- With Redis memory overhead and only active users cached, resident memory lands closer to 1–1.5 TB
- Follow graph: ~150 billion edges (500 avg followers × 300M users), ~1.5 TB in a relational store with indexes
- Follower-list reads for fan-out are the hot path, so the follower store must serve tens of thousands of paginated reads per second

**Network and CPU:**

- Fan-out workers performing Redis `ZADD` operations can batch pipeline thousands of inserts per round trip.
- A single worker handling 10K ZADDs/sec can clear a million-follower fan-out in ~100 seconds with a hundred parallel workers.
- At peak, the fan-out fleet needs to sustain tens of thousands of pipelined writes per second across the Redis cluster.
- This is comfortably within Redis cluster throughput (100K+ ops/sec per shard) but requires careful sharding by `user_id` so a single user's feed always lands on one shard.

## Data Model

The core entities are Users, Tweets, Follow relationships, and FeedItem cache entries.

- **User:** a Snowflake or UUID identifier, username, display name, follower count, and creation timestamp.
- **Tweet:** a Snowflake ID (which encodes timestamp, so IDs are naturally time-ordered), the author's user ID, content text, an array of media URLs, optional geolocation, and a created_at timestamp. Snowflake IDs are critical because they make reverse-chronological ordering a simple `ORDER BY id DESC` without a separate timestamp index.
- **Follow edge:** follower_id, followee_id, and a created_at timestamp — the input to every fan-out decision.
- **FeedItem:** not a persisted entity in the traditional sense — it is a cache artifact, a per-user ordered list of tweet IDs materialized in Redis.

The storage split reflects access patterns:

- **Tweets** are append-only, write-heavy, time-series data with lookups by ID or by `(user_id, time_range)` — an excellent fit for Cassandra with a partition key of `user_id` and clustering column of `tweet_id` (or `created_at`).
- **The follow graph** needs random access, secondary indexes, and transactional follow/unfollow semantics, so it lives in MySQL or PostgreSQL with read replicas.
- **The feed cache** lives in Redis because it demands sub-millisecond reads and high write throughput, and because Redis sorted sets natively model "an ordered, scored, capped list of IDs."
- **User profile data** sits in a relational or document store with a Redis cache in front.

## Fan-Out on Write vs Fan-Out on Read

The fundamental architectural fork is whether to do the work of fan-out when a tweet is *written* or when a feed is *read*, and each choice has a characteristic cost profile that maps onto different parts of the workload.

```
                   FAN-OUT ON WRITE (PUSH)              FAN-OUT ON READ (PULL)
                   ---------------------------          ---------------------------

  Author  ──post──► Fan-out worker                    Author  ──post──► Tweet Store
                        │                                  (single write, O(1))
                   read followers                              │
                        │                                      │
              ┌─────────┴─────────┐                       (no pre-computation)
              ▼                   ▼                              │
         feed:{f1}            feed:{fN}                  ┌───────┴────────┐
         ZADD tweet           ZADD tweet                ▼                ▼
         (N writes,           (one per              Reader opens    Reader opens
          amplified)           follower)             feed            feed
              │                   │                      │                │
              └─────────┬─────────┘              scatter-gather    merge + sort
                        │                        500 queries       by timestamp
                  Feeds pre-built                      │                │
                        │                        merge + sort          ▼
                  Reader opens                     top page          return
                  feed                          ◄────────────────  (expensive read,
                        │                                            cheap write)
                  ZRANGE (O(1),
                  microseconds)
                        ▼
                  return
                  (cheap read,
                   expensive write)
```

**Fan-out on write** (the push model) materializes each follower's feed eagerly. When a user posts a tweet, a fan-out worker reads their full follower list, then writes the tweet's ID into every follower's feed cache. Reads subsequently become trivial — a feed request is a single `ZRANGE` against the user's Redis sorted set, returning pre-assembled results in microseconds. The write path is expensive and amplifies a single tweet into N writes, but the read path is O(1) and extremely cache-friendly. This model is ideal when reads vastly outnumber writes (which they do here, by roughly 500:1) and when the average fan-out is moderate. The fatal weakness is the celebrity: a user with ten million followers turns one tweet into ten million Redis writes, which can saturate the cache cluster and introduce multi-second delays for *all* other fan-out work queued behind it.

**Fan-out on read** (the pull model) does the opposite. A tweet is written exactly once to the tweet store, with no pre-computation. When a user opens their feed, the system queries the tweet store for recent tweets from every account that user follows, merges the results in memory, sorts by timestamp, and returns the top page. Writes are O(1) and trivially fast regardless of follower count, which makes the celebrity problem vanish. The cost moves to the read path: a user following 500 accounts triggers 500 point queries (or a scatter-gather across Cassandra partitions) on every feed load, and the merge-and-sort must complete within the 100ms latency budget. Caching mitigates this — a per-user "previously seen" cursor avoids re-scanning old tweets — but the first load and any cache miss are expensive. Pure pull also makes real-time feed updates harder because there is no materialized feed to stream from.

The tradeoff is asymmetric in an important way: push front-loads irreversible work (you cannot un-write a tweet from a feed if the author deletes it), while pull does work only when someone actually reads, which means wasted push work for inactive followers is eliminated. For a service where most users are active daily but a long tail of accounts is dormant, pure push wastes significant work pushing to feeds that will never be read.

### Fan-Out Strategy Comparison

| Dimension | Fan-out on Write (Push) | Fan-out on Read (Pull) | Hybrid |
|---|---|---|---|
| Write cost | O(N) — amplified per follower | O(1) — single write | O(N) for normal, O(1) for celebrities |
| Read cost | O(1) — single `ZRANGE` | O(F) — scatter-gather over F follows | O(1) + small constant celebrity merge |
| Celebrity handling | Fatal — 10M writes per celeb tweet | Trivial — single write | Pulled at read time, bounded merge |
| Read latency | Microseconds | Tens to hundreds of ms | Near push latency for most users |
| Inactive-follower waste | High — pushes to never-read feeds | None — work only on read | Reduced — celebrities pulled, normals pushed |
| Deletion cost | Expensive — fan-out delete to all feeds | Trivial — gone from store | Mixed — delete for pushed, trivial for pulled |
| Real-time streaming | Natural — feed is materialized | Hard — no materialized feed | Natural for pushed, polling for pulled |
| Best fit | Read-heavy, moderate fan-out | Write-heavy or celeb-heavy | Bimodal workload (production) |

## Hybrid Fan-Out

Production systems — including Twitter's own documented architecture — use a **hybrid** that assigns each user to a push or pull path based on follower count. The rule is roughly: users below a follower threshold (commonly cited around 10K, sometimes tuned to a few thousand) have their tweets pushed to all followers' feeds, because the fan-out cost is bounded and the read-side benefit is large. Users above the threshold — celebrities, brands, large media accounts — have their tweets written only to the tweet store, and their tweets are *pulled* at read time and merged into each viewer's feed alongside the pushed content. A Redis set (`celebrities`) holds the IDs of users whose tweets should not be pushed, and the fan-out worker checks this set before deciding whether to fan out.

```
                        HYBRID FAN-OUT ARCHITECTURE
                        ============================

  Author ──post──► API ──► Cassandra (tweet store) ──┐
                                                     │
                                  ┌──────────────────┘
                                  ▼
                         Enqueue fan-out task (Kafka)
                                  │
                                  ▼
                         Fan-out worker consumes
                                  │
                          ┌───────┴────────┐
                          │ Check celeb set│
                          │ (Redis SISMEMBER)
                          └───────┬────────┘
                                  │
                    ┌─────────────┴──────────────┐
                    ▼                            ▼
             NORMAL (< threshold)          CELEBRITY (>= threshold)
             ────────────────────          ──────────────────────
                    │                            │
           Read follower list            Write only to tweet store
           (paginated batches)          (no feed writes)
                    │                            │
           Pipelined ZADD               Publish lightweight
           to feed:{follower}           "celebrity posted" announce
           for each follower            event to broadcast bus
                    │                            │
                    ▼                            ▼
           Publish per-user              (gateways filter per-user
           feed-update event             and pull tweet on demand)
           to streaming bus
                    │
                    ▼
  ┌──────────────────────────────────────────────────────────┐
  │                     READ PATH                            │
  │                                                          │
  │  Client ──load feed──► API                               │
  │                          │                               │
  │              ┌───────────┴────────────┐                  │
  │              ▼                        ▼                  │
  │      ZRANGEBYSCORE            Query Cassandra for        │
  │      feed:{user_id}           recent tweets from         │
  │      (pushed content)         followed celebrities       │
  │              │                        │                  │
  │              └──────────┬─────────────┘                  │
  │                         ▼                                │
  │                Merge + deduplicate                       │
  │                by tweet ID                               │
  │                         │                                │
  │                         ▼                                │
  │                Enrich + (optionally) re-rank             │
  │                         │                                │
  │                         ▼                                │
  │                   Return page                            │
  └──────────────────────────────────────────────────────────┘
```

The read path therefore does two things: it fetches the pre-materialized feed from the user's Redis sorted set (the pushed tweets from normal accounts), *and* it queries the tweet store for recent tweets from any celebrities the user follows, then merges the two streams by timestamp, deduplicates, and returns the combined page. The celebrity pull is bounded — a user typically follows only a handful of celebrity accounts — so the extra read cost is a small constant rather than the full scatter-gather of pure pull. The threshold is a tunable knob: lowering it reduces fan-out load but increases read-time merge work; raising it does the opposite. In practice the threshold is set so that the top 0.1% of accounts (by follower count) are pulled, which captures the vast majority of the fan-out cost while affecting a tiny fraction of read paths.

A further refinement is **tiered fan-out buckets**. Instead of a binary celebrity/normal split, accounts are bucketed by follower magnitude:

| Bucket | Follower count | Fan-out strategy |
|---|---|---|
| Micro | under 1K | Always pushed |
| Mid | 1K – 100K | Always pushed |
| Macro | 100K – 1M | Pushed with sampled or delayed fan-out |
| Mega | 1M+ | Always pulled |

This lets the system shed fan-out load progressively as follower count grows, and it makes the cost curve smoother rather than cliff-edged at a single threshold.

## Timeline Caching with Redis Sorted Sets

The feed cache is the single most important component for hitting the 100ms read SLA, and Redis sorted sets are the canonical data structure for it. Each user's feed is a sorted set keyed `feed:{user_id}`, with each member being a tweet ID and the score being the tweet's timestamp (or Snowflake-derived timestamp). Sorted sets keep members ordered by score, support range queries by score or by rank, and allow O(log N) insertion and O(log N + M) range retrieval — exactly the operations a feed needs.

```
  REDIS SORTED SET: feed:{user_id}
  =================================

  Key:   feed:42
  Type:  ZSET (sorted set)

  ┌──────────────────────────────────────────────────────────┐
  │  Score (ts)    │  Member (tweet_id)   │  Rank (by score) │
  ├──────────────────────────────────────────────────────────┤
  │  1718900005    │  1199887766543201    │  0  (newest)     │
  │  1718900004    │  1199887766543188    │  1               │
  │  1718900003    │  1199887766543155    │  2               │
  │  1718900002    │  1199887766543099    │  3               │
  │  ...           │  ...                 │  ...             │
  │  1718890000    │  1199887766510000    │  799 (oldest)    │
  └──────────────────────────────────────────────────────────┘
       ▲                                       ▲
       │ newest (highest score)                │ cap at 800 entries
       │ ZADD inserts here (O log N)           │ ZREMRANGEBYRANK trims here

  READ (feed load):
    ZRANGEBYSCORE feed:42 <max_time> -inf LIMIT 0 20
    ──► returns newest 20 tweet IDs below cursor, microseconds

  WRITE (fan-out):
    ZADD feed:42 <ts> <tweet_id>      (insert, O log N)
    ZREMRANGEBYRANK feed:42 0 -801    (trim to 800 cap)

  PAGINATION (cursor-based):
    cursor = last seen tweet's timestamp
    ZRANGEBYSCORE feed:42 <cursor_ts> -inf LIMIT 0 20
    ──► next 20 older tweets, stable under new inserts
```

A feed read is a single `ZRANGEBYSCORE feed:{user_id} <max_time> +inf LIMIT 0 20` (or `ZREVRANGEBYSCORE` depending on Redis version), returning the newest 20 tweet IDs in microseconds, which the API layer then enriches with tweet bodies and user profiles fetched in batch from their respective caches.

The cap on feed size — typically 800 entries — serves two purposes. It bounds memory: 300M users × 800 × 8 bytes is the ~1.9 TB figure from the capacity section, which is manageable but not unbounded. And it reflects usage reality: users almost never scroll past a few hundred items, so retaining older entries wastes memory. The cap is enforced with a combination of `ZREMRANGEBYRANK` (trim the oldest entries after a `ZADD`) and a periodic background compaction. When a feed exceeds the cap, the oldest entries are evicted; if a user scrolls beyond the cached window, the system falls back to a pull-based reconstruction from the tweet store for older pages, which is rare and acceptable to be slower.

Cache population on write is pipelined and batched. The fan-out worker, after reading a batch of follower IDs, issues a single pipelined `ZADD feed:{f1} <ts> <tweet_id> feed:{f2} <ts> <tweet_id> ...` covering thousands of followers per round trip, then follows with pipelined `ZREMRANGEBYRANK` trims. Pipelining is essential: per-follower round trips would make a million-follower fan-out take minutes, whereas pipelined batches complete in seconds. Redis Cluster shards feeds by `user_id` so all operations on one user's feed hit one shard, avoiding cross-slot errors and keeping the sorted set local.

Cache misses and cold starts deserve attention. A new user has no cached feed, and a user returning after a long absence may have a stale or evicted cache. The fallback is a pull-based reconstruction: query the tweet store for recent tweets from all followed accounts, merge, cache the result, and return it. This is more expensive (hundreds of milliseconds) and is ideally done out-of-band or with a "loading" UX, but it guarantees correctness. For brand-new users with no follows, the system seeds the feed with trending or recommended tweets so the first impression is not empty.

## Ranking Algorithms

Pure reverse-chronological ordering is the baseline and the simplest correct behavior, but modern feeds almost always layer a ranking model on top to surface the most relevant or engaging content, especially for users who follow many accounts and would otherwise miss good tweets buried in noise. Ranking transforms the feed from a time-ordered list into a score-ordered list where score is a function of recency *and* relevance signals.

A typical ranking score combines several features:

- **Recency:** a decaying function of time since posting, so fresh tweets still win unless heavily out-scored.
- **Author affinity:** how often the viewer interacts with the author — likes, replies, profile visits.
- **Tweet engagement velocity:** likes, retweets, replies in the first minutes, normalized by the author's baseline.
- **Content type signals:** whether the tweet has media, whether it's a reply or an original post.
- **Graph signals:** whether the viewer's friends also engaged with the tweet.

The score is computed by a model — historically a logistic regression or GBDT, increasingly a learned neural ranking model — that is trained on engagement logs offline and served via a feature store + model server online.

The architectural impact of ranking is significant. The pushed feed cache can no longer be a pure reverse-chronological sorted set for ranked feeds, because the final order depends on viewer-specific and time-decayed scores that are not known at write time. Two common patterns handle this:

1. **Candidate-pool approach (more common):** keep the sorted set as a reverse-chronological candidate pool (say, the newest 800 tweets) and re-rank the top page at read time by querying the model server for scores on the 800 candidates and returning the top 20. This bounds model work to the candidate set and keeps the cache simple.
2. **Batch recompute approach:** maintain separate per-user ranked caches that are periodically recomputed by a batch or streaming job, accepting some staleness for a cheaper read path.

The candidate-pool approach is more common because it balances freshness, cost, and personalization.

## Push vs Pull Models in Detail

The push/pull distinction is sometimes conflated with fan-out-on-write/read, but it is worth separating as a *delivery* concern. Push delivery means the server proactively sends new feed items to a connected client (via WebSocket, Server-Sent Events, or a long-lived streaming connection), so the user sees new tweets appear without reloading. Pull delivery means the client polls or reloads to fetch updates. A system can fan out on write but still use pull delivery (the feed is pre-materialized but the client reloads to see it), or fan out on read with push delivery (the server computes the feed on a poll interval and pushes deltas).

For a real-time feed experience, the typical design combines write-time fan-out (to materialize the feed cache) with **push delivery over a streaming connection**. Each connected client holds an open WebSocket to a streaming gateway. When a fan-out worker writes a tweet to a user's Redis feed, it also publishes an event to a per-user notification channel (a Redis Pub/Sub channel or a Kafka topic keyed by user_id). The streaming gateway subscribed to that user's channel receives the event and pushes it down the WebSocket to the client, which prepends it to the visible feed. This gives sub-second update latency for pushed content. For celebrity (pulled) content, the streaming gateway can either poll the tweet store on a short interval for followed celebrities or accept that celebrity tweets appear on the next reload — a reasonable tradeoff given that celebrity tweets are high-volume and polling them for every viewer would be expensive.

Scaling the streaming layer is its own problem. With millions of concurrent connections, the gateway fleet must be horizontally scalable and stateless per-connection routing must be maintained (a user's connection lives on one gateway instance, and the fan-out event must be routed to that instance). A common pattern is a consistent-hash mapping of user_id to gateway instance, published to a routing service, so the fan-out worker (or the pub/sub subscriber) can forward events to the correct gateway. Connection lifecycle, reconnection, and backpressure (a user following a celebrity who tweets in a burst must not be flooded) all need handling.

## Celebrity Problem Handling

The celebrity problem is the canonical failure mode of pure fan-out-on-write and deserves explicit treatment. When a user with tens of millions of followers posts, the naive push generates tens of millions of Redis writes, which (a) takes many seconds even pipelined, (b) saturates the Redis cluster and crowds out fan-out for ordinary users, and (c) wastes work pushing to inactive followers who will never read the tweet. The hybrid model addresses the *write* side by pulling celebrity tweets at read time, but there are additional refinements.

```
                    CELEBRITY HANDLING FLOW
                    =======================

  Celebrity posts tweet
          │
          ▼
  ┌──────────────────┐     YES    ┌──────────────────────┐
  │ In celebrities   │───────────►│ WRITE ONLY to tweet   │
  │ Redis set?       │            │ store (Cassandra)     │
  │ (SISMEMBER)      │            │ NO feed fan-out       │
  └────────┬─────────┘            └──────────┬───────────┘
           │ NO                              │
           ▼                                 │
  ┌──────────────────┐                      │
  │ Follower count   │                      │
  │ tier?            │                      │
  └────────┬─────────┘                      │
           │                                │
    ┌──────┴──────┬─────────────┐           │
    ▼             ▼             ▼           │
  MICRO/MID     MACRO         MEGA          │
  (< 100K)    (100K–1M)     (1M+)           │
    │             │             │           │
    ▼             ▼             ▼           │
  Full push   Sampled/       Treated as    │
  to all      delayed        celebrity     │
  followers   fan-out        (pull path) ──┤
  (pipelined  (subset of     │             │
  ZADD)       followers)     │             │
    │             │           │             │
    ▼             ▼           ▼             ▼
  ┌──────────────────────────────────────────┐
  │           READ-TIME MERGE                │
  │                                          │
  │  For each reader who follows this author:│
  │    1. ZRANGEBYSCORE on feed:{reader}     │
  │       (pushed content from normals)      │
  │    2. Cassandra range scan for recent    │
  │       tweets from followed celebrities   │
  │    3. Merge + deduplicate by tweet_id    │
  │    4. Enrich + return                    │
  └──────────────────────────────────────────┘
```

**Threshold tuning.** The celebrity threshold should be set conservatively enough that the pulled set is small (so read-time merge cost is low) but high enough that the pushed set excludes only the truly expensive accounts. Empirically, pulling tweets from the top 0.05–0.1% of accounts by follower count eliminates the vast majority of fan-out write volume while keeping the per-read celebrity merge to a handful of accounts.

**Rate-limiting and sampling for near-celebrities.** Even within the pushed population, fan-out can be rate-limited or sampled for high-but-not-celebrity accounts: a user with 500K followers might be pushed fully, but a user with 2M followers who is just below the celebrity threshold might be pushed with a small delay or to a sampled subset, with the rest pulled.

**Sharding and prioritization for large accounts.** The fan-out for a single large account should be sharded across workers and prioritized so it does not block the queue: a celebrity tweet is enqueued as many smaller fan-out sub-tasks (one per follower-list page), each handled by an independent worker, and the queue scheduler gives small fan-out tasks priority so ordinary users are not starved.

### Deletion and Edits

A subtle issue is deletion and edits:

- If a **celebrity** deletes a tweet that was pulled (never pushed), deletion is trivial — the tweet is gone from the store and read-time merges simply no longer find it.
- If an **ordinary user** deletes a tweet that *was* pushed to a million feeds, the system must issue a fan-out *delete* to remove the tweet ID from every affected feed cache, which is another million-write operation.
- This is handled by the same fan-out infrastructure (a delete event triggers `ZREM feed:{follower} <tweet_id>` pipelined across followers) and by a fallback where the enrichment layer treats a missing tweet body as "this tweet was deleted" and filters it out at read time even if the ID lingers in the cache.

## Pagination and Feed Pagination

Feed pagination is deceptively nuanced. The naive approach — offset-based pagination (`LIMIT 20 OFFSET 40`) — is broken for feeds because the feed is a live, growing list: between the user's first and second page load, new tweets arrive and shift every offset, causing duplicated or skipped items. The correct approach is **cursor-based pagination** where the cursor encodes the position of the last item seen.

For a reverse-chronological feed, the cursor is simply the timestamp (or Snowflake ID, which is monotonic and time-ordered) of the last item on the current page. The next page request is `ZRANGEBYSCORE feed:{user_id} <cursor_ts> -inf LIMIT 0 20` — give me the 20 tweets older than the cursor. This is stable under insertion: new tweets have higher timestamps and do not affect the older-than-cursor window, so pages never skip or duplicate. The cursor is opaque to the client (base64-encoded, signed) to prevent tampering, and it may also encode the feed version or cache generation to detect when the feed has been rebuilt and pagination should restart.

For ranked feeds, cursor pagination is harder because the rank order is not a monotonic function of time — a tweet's score changes as engagement accrues, so "the tweet after this one" is not well-defined across page loads. Common compromises include:

- **Rank only the first page** (the top 20) and paginate the rest reverse-chronologically.
- **Snapshot the ranked order** at first load and paginate against that snapshot (accepting that the feed is a moment-in-time view) — widely used because it gives a stable, non-duplicating scroll while still presenting a ranked first impression.
- **Recompute rank per page** and accept minor duplication, with client-side dedup.

Deep pagination — a user scrolling thousands of items back — is a path that should be discouraged or capped. Beyond the cached 800-item window, the system falls back to pull-based reconstruction from the tweet store, which is expensive and slow. Most products cap scroll depth or transition to an "explore" or search surface rather than supporting unbounded backward pagination, both for cost and because engagement data shows users rarely go deep.

## Real-Time Updates via Streaming

Real-time feed updates are delivered via a streaming transport layered on top of the materialized feed cache. The design has three parts: a fan-out event bus, a streaming gateway, and the client connection. When a tweet is fanned out to a user's Redis feed (for pushed content), the fan-out worker additionally publishes a compact event — tweet ID, author ID, timestamp — to a per-user channel. The streaming gateway, which maintains the user's WebSocket, is subscribed to that user's channel (directly via Redis Pub/Sub or via a Kafka topic with the user_id as the partition key and the gateway as a consumer group). On receiving the event, the gateway forwards it to the client, which renders the new tweet at the top of the feed without a full reload.

For pulled (celebrity) content, real-time delivery is harder because there is no fan-out event to publish. Options include:

- A short-interval poll by the gateway for each user's followed celebrities (expensive at scale).
- A hybrid where celebrity tweets *are* announced via a lightweight event bus (without the full feed write) so the gateway can fetch and push them — the lightweight-announce approach is a good middle ground: the celebrity's tweet is written only to the tweet store, but a single "celebrity X posted" event is published to a broadcast channel that gateways filter per-user, so the gateway can pull the tweet and push it to only the users who follow that celebrity and are currently connected. This avoids the million-feed write while still enabling real-time delivery.
- Accepting that celebrity tweets appear on reload.

Backpressure and connection management are essential:

- A user who follows many high-volume accounts must not be flooded with updates faster than the client can render; the gateway coalesces bursts and applies a client-specific rate limit.
- Connection lifecycle — reconnect on network drop, resume from a last-seen cursor, timeout idle connections — is handled by the gateway with a session store backing the cursor.
- At scale, the gateway fleet is behind a load balancer with sticky routing or a consistent-hash directory so a reconnecting user lands on a gateway that can resume their session.

## Feed Consistency

Feed consistency is inherently eventual because the fan-out is asynchronous: a tweet is written to the tweet store first, then fanned out to follower feeds over the next few seconds. During that window, a follower who loads their feed may not yet see the tweet. This is acceptable for a social feed (users do not expect instant propagation) but has boundaries: the author must always see their *own* tweet immediately (handled by writing to the author's own feed synchronously, or by merging the author's recent tweets at read time), and the staleness should be bounded (seconds, not minutes) to avoid user confusion.

Stronger consistency applies to the tweet store itself: Cassandra with a replication factor of 3 and quorum reads and writes (R + W > N) gives strong consistency for tweet body fetches, so a tweet that has been fanned out is never a "phantom" — if a feed references a tweet ID, the tweet body is guaranteed to be readable. The feed cache is explicitly eventually consistent: Redis is not transactionally tied to the tweet store, and feeds may briefly contain IDs whose tweets are in the process of being deleted; the enrichment layer treats missing tweet bodies as deleted and filters them, which gives the user a consistent view even if the cache lags.

The follow/unfollow operation has its own consistency considerations:

- **Unfollow:** when a user unfollows an account, future tweets from that account should not enter the user's feed — for pushed content, the fan-out worker simply checks the current follow graph before pushing, so new tweets naturally stop. Old tweets already in the feed cache remain until they age out or are scrolled past, which is the expected behavior (unfollowing does not retroactively erase history from the feed).
- **Follow:** when a user *follows* a new account, the system can optionally backfill the new account's recent tweets into the follower's feed cache via an async job, or simply let future tweets appear on the next fan-out; backfill gives a better first-impression but costs an extra write job.
- **Follow graph storage:** stored in a relational database with strong consistency, so follow/unfollow is atomic and the fan-out worker always reads a consistent snapshot.

## Storage Choices: Redis Sorted Sets and Cassandra

The storage choices are driven by access patterns and scale.

**Redis sorted sets** for the feed cache are chosen because they natively provide an ordered, scored, deduplicated, cap-enforced list with O(log N) writes and O(log N + M) range reads — a near-perfect match for a feed. Alternatives (a plain Redis list, a Cassandra row per user) either lack efficient range-by-score queries or have higher read latency. Redis Cluster provides horizontal scaling by sharding on `user_id`, and persistence (AOF with fsync-every-second or RDB snapshots) gives recoverability without making Redis the system of record (the tweet store is the source of truth; the cache can be rebuilt). The tradeoff is memory cost — Redis is in-memory, so the ~1.5 TB of feed cache is a significant memory footprint requiring a sizable Redis cluster, but the read-latency benefit justifies it.

**Cassandra** for the tweet store is chosen because tweets are write-heavy, append-only, time-series data with lookups by `user_id` and time range — exactly Cassandra's sweet spot. The schema uses `user_id` as the partition key and `tweet_id` (Snowflake, time-ordered) as the clustering column, so a user's tweets are physically stored together in reverse-chronological order and a range scan for "recent tweets by user X" is a single-partition read. Cassandra's tunable consistency (ONE for writes for throughput, QUORUM for reads when correctness matters) and linear horizontal scalability by adding nodes match the tweet workload's growth. The tradeoff is no secondary indexes or joins — but the feed system does not need them, since all access is by user_id or by tweet_id (a separate lookup table or a Cassandra row keyed by tweet_id handles random tweet fetches). Tweet bodies are eventually archived to object storage (S3) after the 30-day hot window to control Cassandra cluster size, with a lookup table mapping old tweet IDs to their S3 location for the rare deep-read.

The follow graph in MySQL/PostgreSQL provides the transactional, indexed, random-access semantics that follow/unfollow and follower-list pagination require, with read replicas handling the heavy fan-out read load. A Redis cache in front of the follower store caches paginated follower lists for the fan-out hot path, with short TTLs to bound staleness. The celebrity set is a small Redis set, cached indefinitely and updated by a batch job that recomputes follower counts and re-buckets accounts.

## End-to-End Architecture Summary

**The write path:**

1. A user posts a tweet.
2. The API writes it to Cassandra (tweet store) and to the author's own feed synchronously.
3. The API enqueues a fan-out task to Kafka.
4. A fan-out worker consumes the task, reads the author's follower list in paginated batches from the follower store (via Redis cache).
5. The worker checks the celebrity set.
6. For each non-celebrity follower batch, the worker issues a pipelined `ZADD` to the followers' Redis feed sorted sets, followed by trims.
7. For celebrity authors, the worker writes only to the tweet store and publishes a lightweight announce event.
8. The worker also publishes per-user feed-update events to the streaming bus for real-time delivery.

**The read path:**

1. A client requests its feed.
2. The API issues a `ZRANGEBYSCORE` against the user's Redis feed sorted set with a cursor.
3. The API fetches the celebrity tweets from followed celebrity accounts via Cassandra range scans.
4. The API merges and deduplicates by tweet ID.
5. The API enriches with tweet bodies and user profiles from their caches.
6. The API optionally re-ranks the top page via the ranking model.
7. The API returns the page.
8. The streaming gateway simultaneously pushes any new-tweet events to the connected client.

## Sharp Interview Question

**Question:** "Our hybrid fan-out pulls celebrity tweets at read time and merges them with the pushed feed. But a user who follows a celebrity and loads their feed gets a 200ms response because of the celebrity scatter-gather, while a user who follows only normal accounts gets 20ms. How do you make the celebrity-following user's experience fast without pushing celebrity tweets to all their followers?"

**Model Answer:** The key insight is that the celebrity pull is expensive because it is *per-read* and *synchronous*. The fix is to **push a lightweight pointer, not the tweet, into the follower's feed cache** — but only for users who actually follow that celebrity and are likely to read soon, which is a much smaller set than "all followers." Concretely: when a celebrity tweets, instead of writing the full tweet ID to every follower's feed (the expensive push), write a single "celebrity bucket" entry per *viewer* who has recently been active, or maintain a per-user "celebrity follows" small list that the read path checks against a short-TTL celebrity-recent-tweets cache. Even simpler and very effective: maintain a small Redis cache of each celebrity's last-N tweets (say, last 50, 5-minute TTL) — this cache is written once per celebrity tweet and read by all the celebrity's followers at read time, turning N scatter-gathers into N cheap cache hits against a single hot key. The read path then merges the user's pushed feed with the cached celebrity tweets for the few celebrities they follow, and the 200ms drops to near 20ms because the celebrity fetch is now a handful of Redis `GET`s rather than Cassandra range scans. The cost is one small cache write per celebrity tweet instead of a million-feed fan-out — a 10,000:1 reduction in write work for a mega-celebrity. The tradeoff is a few seconds of potential staleness on celebrity tweets, which is acceptable.

**Common Pitfall:** Reaching for a pure push or pure pull model and not recognizing that the workload is bimodal — a few accounts generate most of the fan-out cost, and the rest generate most of the read volume. A candidate who proposes pure push will be eaten alive by the celebrity write amplification; a candidate who proposes pure pull will blow the read latency budget on the 500-follow scatter-gather. The hybrid is not an optimization, it is the *only* design that fits both tails of the distribution, and the threshold and tiering are the levers that tune it.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Two approaches: fan-out-on-write (push tweet to all followers' feeds) vs fan-out-on-read (pull on demand)
- Celebrity problem: a user with 50M followers can't fan-out-on-write — it would be 50M writes per tweet
- Hybrid: fan-out-on-write for normal users, fan-out-on-read for celebrities (threshold-based)
- Feed is a timeline cache (Redis sorted set by timestamp), not a database query at read time
- Caching is critical: 95%+ of feed reads should be served from cache, not database

**Common Follow-Up Questions:**
- "How do you handle tweets that go viral after posting?" — If a tweet crosses the celebrity threshold after posting, switch it from push to pull dynamically. Pre-compute for existing followers, pull for new followers.
- "How do you maintain feed ordering with clock skew?" — Use a logical timestamp (Twitter Snowflake) that encodes timestamp + machine ID + sequence, not wall clock.

**Gotcha:**
- Pure push or pure pull doesn't work. Pure push breaks on celebrities (write amplification). Pure pull breaks on normal users (read amplification — scatter-gather across 500 followed accounts). The hybrid is not an optimization — it's the only design that fits both tails of the distribution.
