---
title: "URL Shortener"
type: system-design
category: Basics
date: 2026-04-24
difficulty: "intermediate"
read_time: 40
listen_time: 56
tags: [system-design, interview, basics, url-shortener, base62, encoding, caching, cdn, analytics, rate-limiting, sharding, redirection, distributed-systems]
aliases: ["URL Shortener", "Design a URL Shortener", "TinyURL Design", "Bitly System Design", "Short Link Service"]
---

# URL Shortener

> **Staff-Engineer Focus:** "Generate a random string, store it in a database, and redirect on lookup" is the junior answer. The senior answer understands the 100:1 read-write asymmetry, picks an encoding strategy that balances enumerability against collision probability, and layers a CDN in front of redirects so the origin barely sees read traffic. **The staff engineer reasons about the birthday-paradox collision math for a 6-character base62 keyspace, designs an ID-allocation scheme that survives a shard outage without duplicate ranges, builds an analytics pipeline that counts clicks without a hot-row write bottleneck, and chooses between 301 and 302 with full awareness of the SEO and cache-pollution consequences.** The interview question isn't "build a URL shortener." It's: "You run a shortener doing 1M redirects/sec with 99.99% availability and sub-10ms p99 latency. A single short code goes viral and accounts for 30% of global traffic. Walk me through every layer — from CDN edge to database shard — and tell me where this breaks first."

---

## Summary & Interview Framing

A system that maps long URLs to short codes using base62 encoding, with a read-heavy (100:1) architecture layered with CDN, cache, and database shards.

**How it's asked:** "Design a URL shortener serving 100M redirects/day with 99.99% availability and sub-10ms p99 latency. Handle viral links, analytics, and the birthday-paradox collision math."

---

## 1. Overview

A URL shortener accepts a long URL and returns a compact alias such as `bit.ly/3xK9aZ2`. When a client requests that alias, the service responds with an HTTP redirect to the original URL. The product surface looks trivially small, but beneath it sits a read-heavy, latency-sensitive, globally-distributed system whose design touches almost every core distributed-systems concept: key generation, caching, database sharding, CDN edge delivery, analytics streaming, and abuse prevention.

The URL shortener is a perennial interview favorite because its scope is narrow enough to design end-to-end in forty-five minutes yet deep enough to expose how a candidate thinks about scale. A shortener is dominated by reads: every short link created is subsequently clicked hundreds or thousands of times, often years after creation, often in geographic bursts when a link goes viral. That read-write asymmetry — commonly cited as 100:1 — shapes every architectural decision. The write path must be correct, collision-free, and fast enough to not frustrate a user pasting a link into a textbox, but the read path is where the operational complexity and cost live, because a single viral redirect can saturate an entire origin database if the caching and CDN layers are misconfigured.

The system also has an unusual durability profile. Short links are effectively permanent: once a user tweets, prints, or emails a short URL, breaking it is a visible, reputation-damaging outage. A redirect that returns a 404 is a broken promise to every person who ever copied that link. This permanence shapes the storage choice, the backup strategy, and the reluctance to ever delete a record without an explicit, user-initiated expiry.

---

## 2. Requirements

### 2.1 Functional Requirements

The core contract is small but must be specified precisely, because every "optional" feature changes the data model and the API surface. At minimum the system must shorten a given long URL into a unique short code, and resolve that short code back to the original URL via an HTTP redirect. Beyond that baseline, a production shortener typically supports a range of additional features:

- **Custom aliases** — a user chooses `bit.ly/MyLaunch` instead of an auto-generated code
- **Link expiry** after a configurable TTL
- **Click analytics** — count, referrer, geography, device
- **Authenticated account model** so users can manage and delete their own links
- **QR-code generation** (some commercial shorteners)
- **Deep-link routing** for mobile apps
- **Password-protected redirects**
- **A/B test routing** where a single short code resolves to different destinations based on the visitor's cohort

For an interview, the disciplined move is to nail down scope explicitly before designing. Ask the interviewer: "Do we need custom aliases? Expiry? Analytics? User accounts?" Each yes expands the schema and the failure surface. The minimum viable version — anonymous shorten, permanent redirect — is a one-table system; the full commercial version is closer to a small platform with billing, team permissions, and an analytics warehouse.

### 2.2 Non-Functional Requirements

Availability must be high — 99.9% at minimum, 99.99% for a commercial provider — because a redirect is a user-facing, latency-critical interaction. When a user clicks a short link inside a tweet, they expect the destination in under a second end-to-end, and a meaningful fraction of that budget is consumed by network RTT and browser rendering before the shortener's server even sees the request. That leaves a tight p99 latency target for the redirect-resolution path: single-digit milliseconds at the origin, and effectively zero when served from a CDN edge.

Throughput demands are large but skewed. A mid-sized provider might see 10,000 shorten (write) requests per second and 1,000,000 redirect (read) requests per second at peak, reflecting the 100:1 read-write ratio. Storage must be durable and append-mostly: short links are written once and read forever, so the working set for writes is small but the total corpus grows monotonically. The non-functional headline is therefore: **reads dominate, latency is king, durability is forever, and a single link can go viral and quintuple your origin traffic in five minutes.**

---

## 3. Capacity Estimation

Capacity estimation is where good candidates show they can reason in real numbers rather than hand-wave. Assume 100 million monthly active users, each shortening 2 links per week on average.

**Write volume:**

- ~800 million new short links per month
- ~27 million per day
- ~300 shorten requests per second (average)
- 5× peak-to-average multiplier → **1,500 RPS peak writes** — modest, well within a single well-tuned PostgreSQL primary

**Read volume (100:1 read-to-write ratio):**

- 30,000 RPS average redirects
- 5× peak multiplier → **150,000 RPS peak redirects**

**Storage growth:**

- 27 million records per day
- Per-record composition:
  - Short code: 7 bytes
  - Original URL: ~80 bytes average (long-tail outliers of 2 KB for tracking-heavy marketing links)
  - Metadata timestamps: 16 bytes
  - User ID: 16 bytes (UUID)
  - Click counter: 8 bytes
  - Indexing overhead (primary B-tree on short code + secondary index on user_id)
  - **Total: ~250 bytes per record on disk**
- 6.75 GB per day
- ~200 GB per month
- ~2.4 TB per year
- Five-year retention: **12 TB** of primary data plus replicas, plus the analytics warehouse (typically 10–50× the size of the link table because every click generates an event row)

This is not large by modern standards, but it is large enough that you cannot keep it on a single unsharded box forever.

**Bandwidth (the more telling number):**

- 150,000 redirects/sec × ~300 bytes avg response = ~45 MB/s origin egress
- ~3.9 TB/day if every redirect hits origin
- This is precisely why a CDN is not optional for a serious shortener: serving 150K RPS of redirects from a single origin region is both expensive and fragile, while serving them from edge POPs scattered globally is cheaper, faster, and resilient

**Cache sizing (Pareto distribution of real link traffic):**

- Top 20% of links by click volume ≈ 200 million records (for a billion-link corpus)
- 150 bytes per cached entry → **~30 GB of hot working set** in Redis
- Fits comfortably in a modest Redis deployment
- **~95% cache hit rate** → origin database QPS drops from 150,000 to under 10,000 — a 15× reduction that makes the database tier tractable on a handful of replicas

The capacity conclusion is that the write path is easy, the read path is hard, and the dominant cost is egress bandwidth mitigated by caching.

---

## 4. API Design

A clean, small API is a hallmark of a well-considered shortener. The surface should be RESTful, versioned, and ruthlessly consistent in its error model.

### 4.1 Endpoint Comparison

| Endpoint | Method | Purpose | Response | Backed By |
|---|---|---|---|---|
| `/api/v1/shorten` | POST | Create a short link | JSON: short URL, short code, timestamp, expiry | PostgreSQL primary |
| `/{short_code}` | GET | Redirect to original URL | 302 + `Location` header (+ HTML fallback body) | CDN → Redis → PG replica |
| `/api/v1/links/{short_code}/analytics` | GET | Aggregated click data | JSON: total clicks, time windows, referrers, geo, device | Analytics warehouse (ClickHouse) |

### 4.2 POST /api/v1/shorten — The Write Endpoint

The request body is JSON containing the long URL, optional custom alias, optional TTL in seconds, and optional metadata. The response returns the fully-qualified short URL, the assigned short code, the creation timestamp, and the expiry if set. Idempotency is a subtle concern: if a user retries a shorten request due to a network timeout, the service should ideally return the same short code rather than create a duplicate. This can be achieved with an idempotency key header (`Idempotency-Key: <uuid>`) that the server caches for 24 hours, mapping the key to a previously-created short code on retry. Without this, a flaky client can silently mint dozens of duplicate links to the same destination, polluting analytics and the user's link list.

### 4.3 GET /{short_code} — The Read Endpoint

This is the operational heart of the system. It must not be presented as a JSON API — it is a raw HTTP redirect intended to be hit by browsers, crawlers, and app deep-linkers. The response is a 302 Found with a `Location` header pointing to the original URL, plus a small HTML body containing a meta-refresh and a clickable link as a fallback for user agents that don't follow redirects. Response codes:

- **302 Found** — successful redirect to the original URL
- **404 Not Found** — unknown or expired code
- **410 Gone** — deliberately deactivated link

### 4.4 GET /api/v1/links/{short_code}/analytics

Returns aggregated click data: total clicks, clicks over a time window, top referrers, geographic distribution, and device breakdown. This endpoint is read against the analytics warehouse, not the operational database, so that heavy analytical queries don't compete with redirect-serving for the same resources.

### 4.5 Error Envelope

A consistent error envelope prevents client confusion. Every error response should carry a stable machine-readable code, a human message, and a request ID for support correlation:

```json
{
  "error": {
    "code": "SHORT_CODE_TAKEN",
    "message": "The custom alias 'launch' is already in use.",
    "request_id": "req_01HXYZ..."
  }
}
```

Distinguishing error codes lets clients implement intelligent retry and UX logic rather than parsing free-text strings:

- `SHORT_CODE_TAKEN` — conflict, HTTP 409
- `INVALID_SHORT_CODE` — bad format, HTTP 422
- `RATE_LIMITED` — HTTP 429 (must include `Retry-After` and `X-RateLimit-Reset` headers so well-behaved clients can back off correctly)

---

## 5. Encoding Strategies: The Heart of the Design

The choice of how to turn an internal identifier into the user-facing short code is the single most consequential design decision in a URL shortener. There are three mainstream strategies — counter-based, hash-based, and random-key-based — and each carries a distinct set of trade-offs around collisions, enumerability, key length, and operational complexity.

### 5.1 Base62 Fundamentals

Base62 uses the 62 characters `[0-9a-zA-Z]` — ten digits, 26 lowercase, 26 uppercase — to represent numbers in a positional system analogous to base-10 or base-16. The appeal is that every character is URL-safe and human-readable, requiring no percent-encoding.

```
Base62 Positional Encoding
──────────────────────────────────────────────────────

Alphabet:  0 1 2 ... 9 a b c ... z A B C ... Z
           ───────────────────────────────────
           0-9  →  values  0 .. 9
           a-z  →  values 10 .. 35
           A-Z  →  values 36 .. 61

Position weights (right to left):
   62^6   62^5   62^4   62^3   62^2   62^1   62^0

Example — encode integer 12,345 to base62:

   12345 ÷ 62 = 199   remainder 7   → '7'   (index  7)
     199 ÷ 62 =  3    remainder 13  → 'd'   (index 13)
       3 ÷ 62 =  0    remainder 3   → '3'   (index  3)

   Read remainders bottom → top:  "3d7"

   12,345₁₀  =  3d7₆₂

Keyspace capacity:

   62^6  =  56,800,235,584        ≈  56.8 billion
   62^7  =  3,521,614,606,208     ≈  3.52 trillion
```

A 6-character base62 string can represent 62^6 = 56,800,235,584 distinct values (about 56.8 billion); a 7-character string reaches 62^7 ≈ 3.52 trillion. For a service expecting a billion links, 6 characters gives ~57× headroom; for a service expecting a hundred billion links over its lifetime, 7 characters is the safer default. The trade-off is that every additional character makes the short URL one byte longer — trivial for storage, but non-trivial when printed in a magazine ad or embedded in an SMS.

Encoding an integer to base62 is straightforward: repeatedly divide by 62, prepending the corresponding character for each remainder. The cost is negligible — microseconds for a 7-character string — and the operation is trivially parallelizable. The real question is not the encoding algorithm but where the integer to be encoded comes from.

### 5.2 Strategy A: Auto-Increment Counter + Base62

The most common production approach is to maintain a monotonically increasing integer ID per link — either a database auto-increment column, a dedicated counter service, or a Snowflake-style distributed ID generator — and to base62-encode that integer to produce the short code. The advantages are profound: there are no collisions by construction, because the IDs are unique by definition; the keyspace is consumed densely, so 6 characters last as long as mathematically possible; and the integer ID is useful internally as a sortable, analytics-friendly primary key.

The cost is enumerability. Because IDs are sequential, anyone can trivially crawl the entire link corpus by incrementing the short code: `bit.ly/1`, `bit.ly/2`, `bit.ly/3`, and so on. For some services this is a feature — Wikipedia-style transparency — but for most commercial shorteners it is a privacy and security hole. A competitor could enumerate every Bitly link ever created and build a searchable index of what the internet is sharing, which is exactly what some research projects have done. Mitigations exist:

- **Random per-link salt** prepended to the encoded ID
- **XOR the ID with a secret** before encoding
- **Rotate the encoding alphabet** with a keyed permutation so that adjacent IDs do not produce lexicographically adjacent codes

These obfuscation techniques turn "trivially enumerable" into "requires nontrivial reverse engineering," though they do not provide cryptographic security.

The second cost is operational: a single global auto-increment counter is a bottleneck and a single point of failure. The fix is to distribute ID generation across shards or application servers, covered in the scaling section below.

### 5.3 Strategy B: Hash of the Original URL

An alternative is to hash the original URL with MD5 or SHA-1 and take the first 6–7 characters of the digest, encoding them into base62. This requires no central counter, which is architecturally appealing: every application server can generate short codes independently with no coordination. The first obvious problem is collisions: a 6-character keyspace of 56.8 billion values subjected to the birthday paradox will see its first collision after roughly sqrt(56.8B) ≈ 238,000 inserts, far earlier than most people intuit. By the time you've inserted a few million URLs, collisions are a near-certainty and must be handled with a lookup-and-retry loop, which reintroduces the very database coordination the hash strategy was meant to avoid.

The second problem is that the same long URL always produces the same short code, which sounds like a feature but breaks a common use case: two different users shortening the same destination URL typically want two different short links so they can track clicks independently. Working around this by salting the hash with the user ID or a random nonce reintroduces collision risk and makes the short code non-deterministic. In practice, hash-based schemes are rarely used in production shorteners because the collision-handling complexity erases their coordination advantage. They appear frequently in interviews because they are easy to describe, and the strong candidate's job is to explain why they don't survive contact with scale.

### 5.4 Strategy C: Random Key Generation

The third strategy is to generate a random 6- or 7-character base62 string, attempt to insert it as the primary key, and retry on a collision. The advantage is that the keys are unguessable — there is no enumeration risk — and there is no central counter to coordinate. The disadvantage is that as the keyspace fills, the collision probability on each insert rises and the number of retries per insert grows, creating a long tail of slow writes and eventual write unavailability when the keyspace saturates:

- **50% keyspace utilization** → 50% collision chance per insert, expected 2 retries
- **90% utilization** → expected 10 retries
- **99% utilization** → expected 100 retries

This makes random-key generation unsuitable for long-lived services that intend to consume a large fraction of their keyspace, but perfectly fine for services with a large enough keyspace (7+ characters) that utilization stays low for the service's operational horizon.

### 5.5 Strategy Comparison

| Strategy | Collisions | Enumerable | Coordination Cost | Keyspace Density | Production Use |
|---|---|---|---|---|---|
| **Counter + base62** | None (by construction) | Yes (sequential) | High (central counter) | Dense | Most common |
| **Hash of URL** | Frequent (birthday paradox) | No | None | Sparse | Rare (interviews) |
| **Random key** | Rises with utilization | No | None | Sparse | OK for large keyspace |
| **Counter + keyed obfuscation** | None | No (without secret) | Low (Snowflake/range) | Dense | Refined production |

A hybrid that addresses all three strategies' weaknesses is **counter-based generation with keyed obfuscation**: use a distributed counter (Snowflake) for the underlying integer to guarantee uniqueness, but apply a keyed bijective transformation (an XOR with a secret, or a permutation under a Feistel network keyed by a service secret) before base62 encoding. The result is unique, dense, non-enumerable without the secret, and requires no collision retry. This is the approach used in refined production shorteners and is worth articulating in an interview as the "best of all worlds" answer.

---

## 6. Collision Handling and the Birthday Paradox

Collision analysis is where candidates either impress or falter, because the math is counterintuitive. The birthday paradox tells us that in a keyspace of size N, the expected number of inserts before a 50% collision probability is approximately 1.177 × sqrt(N):

- **6-character base62** (N ≈ 56.8 billion) → 50% collision threshold at ~280 million inserts — well within the lifetime of a popular service
- **7-character base62** (N ≈ 3.52 trillion) → 50% threshold at ~2.2 billion inserts — buys time but is not infinite

What this means concretely is that any non-counter-based scheme must treat collisions as an expected, routine event rather than a rare error. The standard handling is a lookup-then-insert loop: generate a candidate key, query the database or a Bloom filter for existence, and if it exists, generate a new candidate and retry. To bound the worst case, services typically cap the retry count (e.g., 5 attempts) and fail the write with a `KEYSPACE_PRESSURE` error if all attempts collide, signaling operators that it is time to increase the key length. A [[Glossary#Bloom Filter|Bloom filter]] (a probabilistic data structure that can quickly tell you if an element is *definitely not* in a set, with possible false positives but no false negatives) in front of the database dramatically reduces the lookup cost for the common case (the key is almost certainly new), trading a small false-positive rate for an orders-of-magnitude reduction in database reads on the write path.

The deeper insight is that collision probability is a function not of how many keys have been issued but of how many have been issued *relative to the keyspace size*. A service that issues 10 million keys into a 62^7 keyspace has a collision probability per insert of 10M / 3.52T ≈ 0.0003% — negligible. The same service at 1 billion issued keys has a 0.028% per-insert collision rate, still small but no longer ignorable at high write throughput. Planning the key length to keep the collision rate below a target threshold across the service's projected lifetime is a capacity-planning exercise that senior candidates should be able to walk through numerically.

---

## 7. Database Schema Design

The schema for a URL shortener is deceptively small, but every column and index is a deliberate decision with downstream operational consequences. The discipline is in choosing types, indexes, and partitioning that match the access patterns rather than the entity relationships.

### 7.1 Core Link Table

```sql
CREATE TABLE links (
    id              BIGSERIAL    PRIMARY KEY,           -- internal integer ID
    short_code      VARCHAR(7)   NOT NULL UNIQUE,        -- user-facing base62 code
    original_url    TEXT         NOT NULL,
    user_id         UUID         NULL,                   -- nullable for anonymous
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ  NULL,                   -- nullable = never expires
    is_active       BOOLEAN      NOT NULL DEFAULT true,
    click_count     BIGINT       NOT NULL DEFAULT 0,     -- denormalized counter
    title           TEXT         NULL,                   -- optional OG metadata
    custom_alias    BOOLEAN      NOT NULL DEFAULT false
);

CREATE INDEX idx_links_user_id     ON links (user_id, created_at DESC);
CREATE INDEX idx_links_expires_at  ON links (expires_at) WHERE expires_at IS NOT NULL;
```

The `id` column is a `BIGSERIAL` — a 64-bit auto-increment — which serves as the monotonically increasing integer fed into the base62 encoder. It is the source of truth for uniqueness and the sort key for natural chronological ordering. The `short_code` is the user-facing string and carries a unique constraint, but it is *derived* from `id`, not the primary key. This separation matters: the integer ID is what gets sharded and what the counter service issues, while the short code is what gets cached and looked up on the read path. Storing both lets you shard by `id` (for write distribution) while indexing `short_code` for O(1) redirect lookups.

The `original_url` is `TEXT` rather than `VARCHAR(n)` because URLs have no universally-agreed upper bound, and the de facto limit in modern browsers is around 2 MB. In practice you enforce a sensible application-level cap (2 KB) to prevent abuse, but the column type should not truncate legitimate long URLs. The `click_count` is a denormalized counter kept on the link row for fast "show me my links with their click totals" queries; the authoritative per-click data lives in the analytics warehouse, and the counter is periodically reconciled from the event stream to catch drift. The `expires_at` index is partial — it only indexes rows where the column is not null — because the vast majority of links never expire and indexing all of them would waste space.

### 7.2 The Analytics Events Table

Click analytics are not stored in the operational database; they are written to an append-only event log consumed by a stream processor and aggregated into a warehouse. The event schema is intentionally narrow and write-optimized:

```sql
CREATE TABLE click_events (
    event_id        UUID         NOT NULL,
    short_code      VARCHAR(7)   NOT NULL,
    occurred_at     TIMESTAMPTZ  NOT NULL,
    referrer        TEXT         NULL,
    user_agent      TEXT         NULL,
    ip_hash         VARCHAR(64)  NULL,    -- hashed, not raw IP, for privacy
    country_code    CHAR(2)      NULL,
    device_type     VARCHAR(16)  NULL
) PARTITION BY RANGE (occurred_at);
```

This table is partitioned by time (daily or weekly partitions) so that old partitions can be dropped or archived without impacting active inserts. It is never updated in place; it is append-only, which makes it friendly to high-throughput columnar stores like ClickHouse. The operational `links.click_count` is a denormalized projection of this data, kept fresh by a periodic aggregation job rather than by a synchronous increment on every redirect.

### 7.3 Storage Tier Choices

| Storage Tier | Technology | Role | Why This Choice |
|---|---|---|---|
| **Operational primary** | PostgreSQL (sharded) | Link records, writes | ACID, unique constraints, B-tree indexes for O(1) lookups |
| **Read replicas** | PostgreSQL (streaming replication) | Redirect lookups on cache miss | Same engine as primary, PgBouncer connection pooling |
| **Hot redirect cache** | Redis Cluster | `short_code → original_url` | Sub-millisecond reads, LRU eviction, TTL support |
| **Edge cache** | CDN (Cloudflare/Akamai) | 302 response caching | Global POPs, absorbs 70–90% of redirect traffic |
| **Event log** | Kafka | Click event stream | Decouples capture from aggregation, durable replay |
| **Analytics warehouse** | ClickHouse / BigQuery | Aggregated click queries | Columnar, optimized for analytical scans, append-only friendly |

---

## 8. Architecture

The architecture of a production URL shortener separates the read and write paths aggressively, because their load profiles are wildly different and mixing them creates mutual contention. The write path is low-volume, correctness-critical, and synchronous; the read path is high-volume, latency-critical, and almost entirely served from cache or CDN.

### 8.1 High-Level Component Layout

```
                     ┌─────────────────────────────────────────────┐
                     │              CDN Edge (Cloudflare / Akamai) │
                     │  caches 302 responses for hot short codes   │
                     └────────────────┬────────────────────────────┘
                                      │ miss
                                      ▼
                     ┌─────────────────────────────────────────────┐
                     │            Load Balancer (L7, global)       │
                     └────────────────┬────────────────────────────┘
                   ┌──────────────────┴──────────────────┐
                   ▼                                     ▼
        ┌─────────────────────┐              ┌─────────────────────┐
        │  Write / Shorten    │              │  Read / Redirect    │
        │  API Servers        │              │  API Servers        │
        │  (validate, ID gen, │              │  (stateless,        │
        │   insert)           │              │   autoscaled, geo)  │
        └──────────┬──────────┘              └──────────┬──────────┘
                   ▼                                    ▼
        ┌─────────────────────┐              ┌─────────────────────┐
        │  ID Generation      │              │  Redis Cluster      │
        │  (Snowflake / range │              │  (short_code → URL) │
        │   allocator)        │              │  hot redirect cache │
        └──────────┬──────────┘              └──────────┬──────────┘
                   ▼                                    ▼ miss
        ┌─────────────────────┐              ┌─────────────────────┐
        │  PostgreSQL Primary │◄─────────────│ PostgreSQL Replicas │
        │  (writes, sharded)  │   replication│ (read-after-miss)   │
        └─────────────────────┘              └─────────────────────┘

                   ┌─────────────────────────────────────────────┐
                   │  Analytics: API → Kafka → Flink → ClickHouse│
                   └─────────────────────────────────────────────┘
```

### 8.2 The Write Path in Detail

When a `POST /shorten` arrives, the API server first validates the input: the long URL must be well-formed, must not point to a blacklisted domain (to prevent phishing redirects), and must respect length limits. If a custom alias is requested, the server validates its format (alphanumeric, 4–30 characters, not on a reserved-word list) and checks for an existing collision synchronously against the database. If no custom alias is requested, the server requests a new integer ID from the ID generation service, applies the keyed obfuscation transform, base62-encodes the result, and inserts the row into the PostgreSQL primary. The insert is a single statement with the unique constraint on `short_code` as the correctness backstop.

The ID generation service is the write path's coordination point. The naive approach — a single `SELECT nextval()` on a PostgreSQL sequence — works up to a few thousand writes per second but becomes a contention bottleneck beyond that, because every writer serializes on the sequence's internal lock. The production approaches are:

- **Snowflake-style ID generator** — a 64-bit ID composed of a timestamp, a worker ID, and a sequence number, generated locally by each app server with no coordination. Each server requires a uniquely-assigned worker ID, typically provisioned by a service registry or a ZooKeeper/etcd lease.
- **Range-allocator service** — hands each app server a block of, say, 10,000 contiguous IDs which the server consumes locally and then requests a new block. This reduces the coordination frequency by a factor of 10,000, turning a per-write RPC into a per-10,000-writes RPC.

### 8.3 The Read Path in Detail

The read path is where the architecture earns its keep. The request traverses three caching layers in order — CDN edge, Redis cluster, PostgreSQL replica — and each layer absorbs a fraction of the traffic so that the next layer down sees only the residual misses.

```
URL Redirect Flow (Read Path)
═══════════════════════════════════════════════════════════════

  Client (browser / crawler / app)
     │
     │  GET /{short_code}
     ▼
  ┌─────────────────────────────────────────┐
  │  ①  CDN Edge  (global POPs)             │
  │      Cached 302 for this code?          │
  └──────────────┬──────────────────────────┘
         yes     │     no (cache miss)
     ┌───────────┘           │
     │                       ▼
     │          ┌────────────────────────────┐
     │          │  L7 Load Balancer          │
     │          └──────────────┬─────────────┘
     │                         ▼
     │          ┌────────────────────────────┐
     │          │  ②  Read API Server        │
     │          │      (stateless, geo)      │
     │          │      request coalescing    │
     │          │      (singleflight)       │
     │          └──────────────┬─────────────┘
     │                         │
     │                         ▼
     │          ┌────────────────────────────┐
     │          │  ③  Redis Cluster          │
     │          │      short_code → URL      │
     │          │      Hit?                  │
     │          └──────────────┬─────────────┘
     │             yes         │     no (miss)
     │         ┌───────────────┘           │
     │         │                           ▼
     │         │          ┌────────────────────────────┐
     │         │          │  ④  PostgreSQL Read Replica│
     │         │          │      Lookup short_code      │
     │         │          │      Populate Redis on     │
     │         │          │      the way out           │
     │         │          └──────────────┬─────────────┘
     │         │                         │
     ▼         ▼                         ▼
  302 + Location header   (or 404 if not found / expired)
     │
     │  async, fire-and-forget
     ▼
  ┌─────────────────────────────────────────┐
  │  ⑤  Kafka → Flink → ClickHouse          │
  │      (analytics event emitted)          │
  └─────────────────────────────────────────┘
```

When a `GET /{short_code}` arrives, the request first hits the CDN edge. If the CDN has a cached 302 response for that code, it returns it directly without touching the origin — this is the fastest possible path and typically handles **70–90% of production redirect traffic** for a well-warmed cache. On a CDN miss, the request reaches the origin load balancer and is routed to a read API server, which first checks the Redis cluster. Redis holds the `short_code → original_url` mapping for the hot working set with a TTL of 24 hours and an LRU eviction policy; a hit returns the URL in under a millisecond and the server issues the 302. On a Redis miss, the server queries a PostgreSQL read replica, populates Redis on the way out, and returns the redirect. The database is thus the slowest, least-scaled tier and sees only the residual traffic after the CDN and Redis layers — commonly **1–5% of total redirect volume**.

The critical design rule for the read path is that it must never block on the write path. Redirects are served by read-optimized, stateless, autoscaled servers backed by replicas; shorten writes are served by a smaller pool of write servers backed by the primary. Mixing them on the same fleet means a spike in shorten requests can starve redirect latency, which is unacceptable given that redirects are the user-facing SLA.

---

## 9. Caching Strategy

Caching is the single most important performance lever in a URL shortener, and the strategy must be reasoned about at three layers: the CDN, the Redis hot-key cache, and the database's own buffer cache. Each layer serves a different population of requests and has different invalidation semantics.

The Redis layer is a straightforward key-value lookup: `short_code → original_url`, with a 24-hour TTL refreshed on each access. Because short links are immutable after creation — the destination URL never changes — there is no cache invalidation problem in the traditional sense. The only invalidation events are link expiry and explicit user deletion, both of which are rare and can be handled by a best-effort cache delete followed by the TTL as a backstop. The simplicity of this model is one of the shortener's pleasant properties: an immutable, append-mostly dataset is the easiest possible thing to cache correctly.

The TTL serves two purposes:

- **Bounds staleness for expired links** — after 24 hours, a Redis entry for a link that has since expired will be evicted naturally, and the next lookup will hit the database and return a 404.
- **Bounds memory growth** — without a TTL, Redis would accumulate every link ever created, eventually exceeding RAM. With a TTL and LRU eviction, Redis naturally retains the hot working set and evicts cold links, keeping memory bounded at the cost of occasional cache misses on resurrected cold links.

A refinement worth noting is **negative caching**: caching 404 responses for invalid short codes with a short TTL (e.g., 1 minute). Without negative caching, a crawler or a misbehaving client hitting random non-existent codes will generate a database lookup per request, turning curiosity into a load attack. Caching the negative result for a minute collapses repeated lookups for the same non-existent code into a single database hit. The short TTL ensures that if a code is later created (extremely unlikely for a random string), the negative entry expires quickly.

---

## 10. CDN Integration

The CDN is the difference between a shortener that scales and one that doesn't. Without a CDN, every redirect hits the origin, and the origin must be sized for peak global redirect traffic — an expensive, fragile proposition that concentrates load in a single region. With a CDN, the overwhelming majority of redirects are served from geographically-distributed edge POPs, and the origin sees only the residual miss traffic plus the write traffic.

The mechanism is HTTP response caching. When the origin returns a 302 redirect for a short code, the CDN can be configured (via `Cache-Control: public, max-age=300`) to cache that 302 response at the edge for a TTL of, say, 5 minutes. Subsequent requests for the same short code from the same geographic region are served directly from the edge with no origin round-trip. A 5-minute TTL is a deliberate compromise: short enough that an expiry or deletion propagates reasonably quickly, long enough that a viral link's traffic is almost entirely absorbed at the edge. For a link going viral and generating 10,000 redirects/sec globally, a 5-minute CDN TTL means the origin sees the redirect only once per edge POP per 5 minutes — perhaps a few dozen origin hits per minute instead of 10,000 per second.

The interaction between CDN caching and analytics is the key tension. If the CDN serves a redirect from cache, the origin never sees the request, and the click is not counted. This is the central reason production shorteners use 302 (Temporary) rather than 301 (Permanent) redirects: 301 is cached by the browser essentially forever, permanently severing the shortener from the click stream, while 302 is not permanently cached by the browser, so subsequent clicks still route through the shortener (or its CDN). To recover click counts even on CDN-cached redirects, sophisticated shorteners use one of these approaches:

- Configure the CDN to log every request and stream those logs to the analytics pipeline
- Embed a tracking pixel or beacon redirect that the CDN does not cache
- Accept that CDN-served clicks are counted approximately via sampling rather than exactly

The honest trade-off is that perfect click accuracy and maximal CDN hit rate are in tension, and the product decision is which to prioritize.

A subtle CDN failure mode is **cache stampede on TTL expiry**. When a popular short code's CDN entry expires, the next request triggers an origin fetch; if hundreds of requests arrive in the milliseconds before the new entry is populated, they can all miss simultaneously and thunder the origin. The standard mitigations are:

- **Request coalescing** — the CDN collapses concurrent misses into a single origin fetch
- **Stale-while-revalidate** — the CDN serves the stale entry while refreshing in the background

Both are supported by modern CDNs and should be enabled for any shortener expecting viral traffic patterns.

---

## 11. Analytics

Analytics is the part of a URL shortener that is invisible to end users but central to the business model — click counts are the value proposition that distinguishes a commercial shortener from a free toy. The design challenge is that every redirect is a potential analytics event, and at 1M redirects/sec the analytics write volume rivals the redirect volume itself. Naively incrementing a counter in the operational database on every click creates a hot-row write bottleneck: a single viral link can receive thousands of clicks per second, all contending to update the same row, which serializes on the row lock and caps throughput at a few hundred updates per second.

The production pattern decouples click capture from click aggregation. On every redirect, the read API server emits a click event to an async pipeline — typically a Kafka topic — and returns the 302 immediately without waiting for the event to be processed. The redirect latency budget is thus unaffected by analytics; the event is fire-and-forget. Downstream, a stream processor (Flink, Spark Streaming, or a Kafka Streams application) consumes the events and aggregates them: per-link counts per minute, per-hour, per-day; per-referrer breakdowns; geographic and device aggregations. The aggregated results are written to a columnar warehouse (ClickHouse, BigQuery, Redshift) optimized for analytical queries, and the `links.click_count` denormalized counter in the operational database is updated periodically (every minute) by the stream processor in a single batched UPDATE per link, collapsing thousands of per-click increments into one write.

This architecture has several desirable properties:

- The redirect path is never blocked by analytics processing
- The warehouse, not the operational database, answers analytical queries, so a user running a "show me all my links' click trends over the last year" query does not compete with redirect-serving for database resources
- The per-link counter in the operational database is eventually consistent with the warehouse, with a lag of at most one aggregation interval, which is acceptable for display purposes
- The raw event log in Kafka preserves the full fidelity of every click for ad-hoc analysis and compliance audits

Privacy is a non-trivial concern in the analytics layer. Storing raw IP addresses and full user agents creates PII and GDPR exposure, so production shorteners apply these sanitization rules at ingest:

- **Hash IPs** with a rotating salt (so the same IP cannot be joined across retention periods)
- **Truncate or categorize** user agents into device-type buckets rather than storing the full string
- **Sanitize referrer strings** to strip query parameters that might contain tokens

The discipline is to collect the minimum that serves the analytics product and to make retention and deletion first-class operations.

---

## 12. Rate Limiting

A URL shortener is a natural abuse target: it's a free, anonymous service that produces a redirect, which makes it attractive for spammers (shortening phishing or malware URLs), for crawlers (enumerating the keyspace), and for denial-of-service attempts (flooding the shorten endpoint to exhaust IDs or the redirect endpoint to exhaust origin capacity). Rate limiting is therefore not an afterthought but a core architectural concern applied at multiple layers.

**At the API gateway layer**, a coarse global rate limit protects the origin from traffic floods:

- Per-IP limit: 100 shorten requests per minute for anonymous users
- Per-API-key limit: scaled to the account tier for authenticated users
- Algorithm: token bucket or sliding-window-counter in Redis, evaluated synchronously on the request path with a sub-millisecond budget
- On limit exceeded: 429 response with `Retry-After` header

**At the application layer**, more nuanced limits apply. A single user bulk-creating links via an automation tool should be allowed up to their plan's quota but throttled beyond it, with a different limit than a casual user pasting one link at a time. Suspicious patterns — a new account creating thousands of links in the first minute, or a single IP shortening the same URL repeatedly — trigger soft blocks that require captcha or manual review rather than hard rejection, because false positives on a legitimate bulk user are costly.

**At the redirect endpoint**, rate limiting is typically not per-user (you cannot rate-limit a click on a shared link), but it is protected at the CDN layer by edge rate limiting that mitigates distributed floods. The combination of CDN-level DDoS protection, origin-level per-IP throttling, and application-level abuse detection covers the realistic threat model without imposing friction on legitimate traffic.

---

## 13. Custom vs Generated URLs

The decision to support custom aliases — letting a user choose `bit.ly/SuperBowlAd` instead of `bit.ly/xK9aZ2` — seems like a minor feature, but it has outsized design implications that interviewers enjoy probing.

Custom aliases are valuable for branding and memorability: a vanity URL printed on a billboard or spoken in a podcast is far more effective than a random string. But they introduce contention, because the namespace is small and desirable names are scarce. Two users cannot both claim `launch`, so the service must handle the conflict: the first to claim wins, and subsequent requests get a 409 Conflict. This requires a synchronous existence check on every custom-alias shorten, which is slower than the generated path (which never checks, because the ID is known unique by construction). For high-value names, services often implement a reservation system or an auction for premium short codes, which is a product feature with its own data model.

Validation rules for custom aliases must be enforced strictly:

- **Case-insensitive** (or case-preserving but case-insensitive in lookup) to avoid `bit.ly/Launch` and `bit.ly/launch` being different links
- **Reject reserved words** (`api`, `admin`, `www`, `help`, profanity) to prevent impersonation and brand damage
- **Minimum length** (typically 4 characters) so custom aliases don't consume the short generated-codes namespace
- **Checked against a deny-list** of previously-abused aliases to prevent re-registration of a phishing alias after deletion

The storage trade-off is that custom aliases are typically longer than generated codes (often 10–30 characters), consuming more index space and more URL length. They also break the dense keyspace property: the generated-code ID space and the custom-alias namespace coexist in the same `short_code` unique index, meaning the generated codes must avoid colliding with any custom alias a user might pick. The standard resolution is to reserve a prefix for generated codes (e.g., generated codes always start with a digit, custom aliases never do) or to partition the keyspace so the two never overlap, keeping the uniqueness guarantee clean.

---

## 14. Redirect Semantics: 301 vs 302

The choice between HTTP 301 (Permanent Redirect) and 302 (Found / Temporary Redirect) is one of the most frequently asked URL-shortener questions, and the answer reveals whether a candidate understands the downstream consequences of HTTP semantics.

### 14.1 Comparison

| Aspect | 301 Permanent | 302 Temporary |
|---|---|---|
| **Browser caching** | Lifetime (aggressive) | Brief / per `Cache-Control` |
| **Origin load** | Minimal (one hit ever per user) | Higher (every click returns) |
| **Analytics visibility** | Lost after first click | Every click counted |
| **Link re-pointing** | Impossible without user clearing cache | Supported |
| **SEO link equity** | Transferred to destination | Stays with shortener domain |
| **Default use case** | Permanent resource, no analytics needed | Analytics-driven, re-pointable |

### 14.2 301 — Permanent Redirect

A 301 redirect signals to the client that the redirect is permanent. Browsers cache 301s aggressively — often for the browser's lifetime — and subsequent navigations to the short URL are served directly from the browser cache without ever hitting the shortener again. This is excellent for performance and origin load: a link clicked repeatedly by the same user generates only one origin hit, ever. The cost is that the shortener permanently loses visibility into those clicks: the browser never returns, so no analytics event is generated, and if the destination URL ever needs to change, the browser's cached 301 will keep sending visitors to the old destination until the user manually clears their cache. Search engines also treat 301 as a signal to transfer link equity to the destination, which is desirable for SEO but means the shortener's domain doesn't accumulate authority.

### 14.3 302 — Temporary Redirect

A 302 redirect signals a temporary redirect. Browsers do not cache 302s permanently (though they may cache them briefly per `Cache-Control` headers), so subsequent navigations route back through the shortener, which sees every click and can count it, re-point the destination, or apply routing logic. This is the standard choice for commercial shorteners precisely because analytics is the product: a 301-cached click is a click the shortener can never monetize or report. The trade-off is higher origin load, which is precisely why the CDN layer exists — to absorb the repeated 302 traffic at the edge while still logging each request for analytics.

### 14.4 The Sophisticated Answer

The choice is per-link, not global. A short link for a permanent, never-changing resource where analytics doesn't matter could use 301 to minimize load; a short link for a marketing campaign that will be re-pointed and whose click count drives reporting must use 302. Production shorteners typically default to 302 and offer 301 as a per-link option for advanced users who understand the trade-off.

---

## 15. Scaling Strategies

Scaling a URL shortener is dominated by the read path, but the write path has its own scaling concerns around ID generation and shard management.

### 15.1 Scaling the Read Path

The read path scales outward through three layers:

- **CDN** — effectively infinitely scalable from the origin's perspective: adding edge capacity is the CDN provider's problem, and the origin sees only the residual miss traffic.
- **Redis cluster** — scales horizontally via consistent-hash sharding of the `short_code` keyspace across Redis nodes. Because every lookup is a single key fetch, Redis sharding is trivially parallel and scales linearly with the number of nodes.
- **PostgreSQL read replicas** — scale via streaming replication and a pooler (PgBouncer) to share connections. Because the database sees only cache-miss traffic (a few percent of total redirects), a handful of replicas is typically sufficient even at high redirect volume.

The read path's failure mode is a **cache stampede** — a sudden influx of misses for a newly-viral link that hasn't been warmed in cache. The mitigations are:

- **Request coalescing in Redis** — using a lock or a singleflight primitive so concurrent misses for the same key collapse to one database fetch
- **CDN origin-shield** — a second CDN caching layer that sits between the edge POPs and the origin, further collapsing misses

Without these, a single viral link can momentarily push 100% of its traffic to the database and cause latency spikes or timeouts for all redirect traffic, not just the viral link's.

### 15.2 Scaling the Write Path

The write path scales through ID generation distribution and database sharding. As discussed, a single auto-increment sequence is the bottleneck; the production solutions are Snowflake IDs (no coordination) or range allocation (low coordination). Both let the write API servers generate IDs locally and independently, so the write path scales horizontally with the number of API servers up to the point where the database primary itself becomes the bottleneck.

When a single PostgreSQL primary cannot keep up with write volume — which at ~300 average / ~1500 peak writes per second is unlikely for a mid-sized shortener but real for a Bitly-scale service — the next step is to shard the `links` table by a shard key. The natural shard key is the integer ID, because it is monotonically increasing and naturally time-correlated, which keeps shard growth balanced. A common scheme is to shard by `id mod N` across N database primaries, each with its own replicas. Cross-shard queries (e.g., "all links for user X") require either a secondary index maintained per shard plus a fan-out query, or a denormalized "user links" table that is itself sharded by `user_id`. The discipline is to shard along the dominant access pattern and accept the cost of fan-out for secondary patterns.

### 15.3 Multi-Region Considerations

For a globally-used shortener, single-region deployment is eventually a latency problem: a user in Singapore clicking a short link served from us-east-1 experiences a 200ms+ redirect latency just from network RTT. Multi-region deployment pushes the CDN edge closer to the user (which CDNs do naturally) and, for the residual origin traffic, deploys read replicas in each region. Writes remain pinned to a single primary region for simplicity, because write volume is low and the consistency cost of multi-region writes (latency, conflict resolution) is not justified. A multi-region active-active write topology is overkill for a shortener and introduces complexity (last-write-wins on `click_count` is acceptable, but last-write-wins on `original_url` is not) that the read-heavy workload doesn't require. The pragmatic pattern is **single-region writes, multi-region reads, global CDN** — which gives good global latency without the operational tax of distributed transactions.

---

## 16. Failure Modes and Reliability

A senior candidate articulates not just the happy path but the ways the system breaks, and what the operator does about each. The URL shortener has a characteristic set of failure modes worth enumerating.

- **Cache stampede on a viral link** — the most common production incident. A link goes viral, the CDN entry expires, and the origin is momentarily flooded with misses for that one key. *Fix:* request coalescing at both the CDN (origin shield) and the Redis layer (singleflight), plus a longer CDN TTL for demonstrably-permanent links. Without coalescing, a single viral link can degrade redirect latency for all users for the duration of the stampede.

- **ID generator outage** — the write-path equivalent. If the ID service becomes unavailable, no new short links can be created, which is a full write outage even though redirects continue to work. *Mitigation:* Snowflake IDs are generated locally per server (no external dependency), so a Snowflake deployment has no single point of failure as long as worker IDs are correctly assigned; for range allocation, each server holds a local buffer of IDs and can continue serving writes from that buffer for the buffer's duration, masking short allocator outages. A deeper mitigation is to pre-provision each server with a large enough ID range that it can ride out an allocator outage of N minutes, trading a small amount of ID-space fragmentation for write-path resilience.

- **Database primary failure** — the classic failover scenario. The primary fails, a replica is promoted, and the few seconds of unreplicated writes are lost. For a shortener, the cost of losing a few seconds of shorten writes is low (users retry), but the cost of losing redirect availability is high. *Standard practice:* synchronous replication to at least one replica (so a failover loses zero committed writes) plus automated failover via a tool like Patroni or RDS Multi-AZ. The read path should fall back from the primary to replicas on failure so that redirect serving survives a primary outage entirely.

- **Redis cluster failure** — degrades the read path to database-direct lookups, which typically have enough replica capacity to absorb the full redirect load at higher latency for a bounded period. *Operational rule:* the database tier must be sized to handle 100% of redirect traffic, even though it normally sees only 5%, so that a Redis outage is a latency degradation rather than an availability outage. This is expensive but is the price of the 99.99% SLA.

- **CDN misconfiguration** — a subtle and dangerous failure: a too-long TTL means expirations and deletions don't propagate; a too-short TTL means the origin absorbs too much traffic; a caching misconfiguration on the 302 response body (rather than just the redirect) can cause the CDN to cache HTML that should be dynamic. *Mitigation:* CDN configuration is high-leverage and high-risk, and changes should be canaried on a small fraction of traffic before global rollout.

- **Analytics pipeline lag or outage** — does not affect redirects but does affect the reporting product. A Kafka topic backlog, a Flink job crash, or a warehouse load failure can cause click counts to lag reality by hours. *Mitigation:* monitoring on end-to-end event latency, alerting when lag exceeds a threshold, and a catch-up mechanism that replays events from the Kafka retention window once the downstream consumer recovers.

---

## 17. Trade-off Summary

| Decision | Option A | Option B | When to Pick A | When to Pick B |
|----------|----------|----------|----------------|----------------|
| **Encoding** | Counter + base62 | Hash of URL | Always, for production | Only for stateless coordination (rare) |
| **Key obfuscation** | Plain sequential | Keyed transform | Internal/transparency OK | Commercial, anti-enumeration needed |
| **Key length** | 6 chars | 7 chars | < 1B links lifetime | > 1B links or long-lived service |
| **Redirect code** | 301 Permanent | 302 Temporary | Permanent, no analytics | Analytics-driven, re-pointable |
| **ID generation** | DB sequence | Snowflake/range | Low write volume | High write volume, no SPOF |
| **Cache TTL** | Short (1 min) | Long (24h / CDN 5m) | Mutable, expiry-sensitive | Immutable, perf-critical |
| **Analytics** | Sync DB increment | Async Kafka + warehouse | Never (hot-row bottleneck) | Always at scale |
| **Sharding** | Single primary | Sharded by ID | < few thousand writes/sec | Bitly-scale writes |
| **Multi-region** | Single region | Multi-region reads + CDN | Small/userbase concentrated | Global userbase, latency SLA |

The unifying theme is that every choice trades a property the service needs (accuracy, freshness, simplicity) against one it can afford to give up (latency, write throughput, enumerability). The staff engineer's job is to know, for each trade-off, which side the product's SLA demands and to make the choice explicit rather than accidental.

---

## 18. Interview Question with Model Answer

> **Question:** You run a shortener doing 1M redirects/sec globally with a 99.99% availability SLA and a sub-10ms p99 latency budget at the origin. One of your short codes goes viral and now accounts for 30% of global traffic — 300K redirects/sec for a single link. Walk me through every layer, from the CDN edge to the database shard, and tell me where this breaks first and what you do about it.

**Model Answer:**

The first thing to establish is that a single hot key is a different failure mode from a general traffic surge, because the mitigations that work for distributed load (horizontal scaling, sharding) do not help when the load is concentrated on one key. A single short code's lookups all hash to the same Redis shard and the same database partition, so adding capacity elsewhere doesn't relieve the hot spot.

**Starting at the CDN edge:** this is where the viral link should be absorbed. A 5-minute CDN TTL on 302 responses means each edge POP fetches the redirect from the origin at most once per 5 minutes, regardless of how many users in that POP's region click it. With ~200 edge POPs globally, the origin sees 200 fetches per 5 minutes for this link — 40 per minute, negligible. So if the CDN is configured correctly and warmed, the origin barely sees the viral traffic. The real danger is a CDN configuration error where this particular response isn't cached (wrong `Cache-Control` header), in which case 300K redirects/sec flow straight to the origin.

**At the Redis layer:** the hot key lives on a single shard. 300K lookups/sec for one key on one Redis node is within Redis's raw throughput, but it may saturate that node's CPU or network while other shards sit idle. The mitigation is hot-key replication: for known hot keys, replicate the value to multiple Redis shards (e.g., store the key under `hot:{code}` on N shards and read from a random shard) to spread the read load.

**At the database layer:** if the CDN and Redis layers are working, the database sees almost nothing for this link. If both fail, 300K/sec of single-key lookups hit one database partition and saturate it. The mitigation is request coalescing (singleflight) at the read API server: for a given short code, only one in-flight database fetch is allowed; concurrent requests for the same code wait on the same promise and are served from the result. This collapses 300K database queries/sec to 1.

**Where it breaks first:** realistically, the CDN edge handles it if configured right, and the origin never feels it. If the CDN is bypassed, Redis handles it on one shard with possible hot-key CPU saturation. The database only sees traffic if both CDN and Redis fail, which is a multi-layer failure and a serious incident. My first action on the pager is to verify the CDN cache hit rate for the viral code; if it's low, I fix the `Cache-Control` header immediately. My second is to enable hot-key replication in Redis if the single shard is saturating. My third, if the database is taking load, is to enable request coalescing and pre-warm the Redis key. The layered CDN → Redis → DB design makes the viral-link case a non-event at the origin when each layer is configured to absorb its share.

---

## 19. Common Pitfalls

- **Pitfall 1: Using a single database auto-increment sequence as the ID generator.** It works in development and fails in production the moment write volume exceeds a few thousand per second, because every writer serializes on the sequence lock. *Fix:* Snowflake or range allocation, decided before launch, not after the first outage.

- **Pitfall 2: Synchronously incrementing a click counter in the operational database on every redirect.** A viral link creates a hot-row write bottleneck that caps redirect throughput at a few hundred per second for that link, far below what the read path can otherwise deliver. *Fix:* async analytics via a Kafka pipeline with periodic batched aggregation.

- **Pitfall 3: Choosing 301 redirects for the default behavior.** It feels efficient (browser caches forever, origin load drops) but permanently severs the shortener from the click stream and makes link re-pointing impossible without users clearing their cache. *Fix:* the default for any analytics-driven shortener is 302.

- **Pitfall 4: Underestimating the birthday-paradox collision rate for short keys.** A 6-character base62 keyspace looks enormous (56.8 billion), but collisions become likely after ~280 million inserts, which a popular service reaches in months. *Fix:* pick 7 characters from the start, or have a documented plan to grow the key length, to avoid a painful migration later.

- **Pitfall 5: Not caching 404 responses (no negative caching).** A crawler enumerating the keyspace, or a misbehaving client retrying a deleted code, generates a database lookup per request because the cache only stores positive results. *Fix:* cache 404s for a short TTL to collapse repeated lookups for the same non-existent code into a single database hit.

- **Pitfall 6: Sizing the database tier for the normal 5% cache-miss traffic.** When Redis fails or a cache stampede occurs, the database must temporarily handle 100% of redirect traffic. If it's sized only for 5%, a Redis outage becomes a full availability outage rather than a latency degradation. *Fix:* size the database for the failure case, not the steady state.

- **Pitfall 7: Forgetting that custom aliases and generated codes share a keyspace.** If a user claims the custom alias `abc123` and the ID generator later produces `abc123` from base62-encoding an integer, the unique constraint rejects the generated insert and the shorten fails. *Fix:* reserve a keyspace partition (e.g., generated codes start with a digit, custom aliases don't) to keep the two namespaces disjoint.

- **Pitfall 8: Storing raw IPs and full user agents in analytics.** This creates a PII and compliance liability (GDPR, CCPA) with no analytical benefit, since you almost never need the raw IP — you need the country or the device type. *Fix:* hash or categorize at ingest, never store raw.

- **Pitfall 9: Assuming the CDN hit rate is high without measuring it.** A misconfigured `Cache-Control` header (e.g., `private` instead of `public`, or a missing `max-age`) silently disables CDN caching, and the origin absorbs full traffic with no visible error until a viral link takes it down. *Fix:* monitor CDN hit rate as a first-class metric and alert on drops.

- **Pitfall 10: Treating link deletion as immediate and final.** A user deletes a link, the database row is removed, but the CDN and Redis still hold the cached 302 for up to their TTL. Visitors continue to be redirected to the (now-deleted) destination for minutes. *Fix:* best-effort cache invalidation via a CDN purge API and a Redis DEL on deletion, with the TTL as the correctness backstop — and a clear product expectation that deletion propagates within N minutes, not instantly.

---

## 20. Summary

The URL shortener is a small-surface, deep-architecture system whose design is dominated by three forces: a 100:1 read-write ratio that makes the read path the center of operational attention; an immutable, append-mostly dataset that makes caching unusually clean; and a permanence contract that makes durability and careful encoding-strategy choices non-negotiable. The core decisions — counter-based base62 encoding with keyed obfuscation, 302 redirects with a CDN-absorbing TTL, async analytics via a Kafka-stream-warehouse pipeline, and a layered CDN → Redis → database read path with request coalescing at each layer — compose into a system that scales to millions of redirects per second with single-digit-millisecond origin latency and a 99.99% availability SLA. The failure modes are well-characterized — hot keys, cache stampedes, ID generator outages, CDN misconfiguration — and each has a known mitigation that a senior candidate should articulate without prompting. The shortener's enduring value as an interview topic is that it compresses almost every distributed-systems concern — encoding, caching, sharding, async pipelines, CDN, rate limiting, failure analysis — into a system small enough to design completely in a single session, which is exactly why it remains the canonical warm-up question for senior and staff engineering interviews.

## Interview Cheat Sheet

**Key Points to Remember:**
- The read-write ratio is ~100:1; the read path (redirects) is where all the operational complexity and cost live, not the write path (shortening).
- Use a counter-based ID + [[Glossary#Base62 Encoding|base62]] encoding with keyed obfuscation for the short code: unique by construction, dense keyspace, and non-enumerable without the secret.
- A [[Glossary#Birthday Paradox|birthday paradox]] collision at 6 characters (~56.8B keyspace) becomes likely after ~280M inserts — use 7 characters from the start for any service expecting longevity.
- Layer the read path: [[Glossary#CDN (Content Delivery Network)|CDN]] (70–90% of traffic) → Redis hot cache (~95% of remaining) → PostgreSQL replicas (residual 1–5%). The database must still be sized for 100% of redirect traffic as a fallback.
- Use 302 (Temporary) not 301 (Permanent) redirects by default — 301 is cached by browsers forever, severing you from the click stream and making link re-pointing impossible.

**Common Follow-Up Questions:**
- *How do you handle a viral link that accounts for 30% of traffic?* — The CDN absorbs it (5-min TTL means each edge POP fetches once per 5 min). If the CDN is bypassed, use hot-key replication in Redis (store the key on N shards) and request coalescing (singleflight) at the read API server to collapse concurrent database fetches to one.
- *How do you count clicks without a hot-row bottleneck?* — Never synchronously increment a counter in the operational DB on every redirect. Emit a fire-and-forget click event to Kafka, aggregate in a stream processor (Flink), and write batched updates to a columnar warehouse (ClickHouse). The operational `click_count` is a denormalized projection updated periodically.
- *301 vs 302 — what's the trade-off?* — 301 caches permanently in the browser (minimal origin load, but no analytics visibility and no re-pointing). 302 routes through the shortener on every click (higher origin load, but full analytics and re-pointable). Commercial shorteners default to 302 because analytics is the product.

**Gotcha:**
- The most common mistake is sizing the database tier for the normal 5% cache-miss traffic. When Redis fails or a cache stampede occurs, the database must temporarily handle 100% of redirect traffic. If it's sized only for 5%, a Redis outage becomes a full availability outage rather than a latency degradation. Always size the database for the failure case, not the steady state.
