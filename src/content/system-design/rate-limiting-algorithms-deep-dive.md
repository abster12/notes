---
title: "Rate Limiting Algorithms Deep Dive"
type: system-design
category: Platform
date: 2026-06-13
tags: [system-design, interview, platform, rate-limiting, token-bucket, sliding-window, leaky-bucket, fixed-window, concurrency, distributed-systems, redis, api-gateway, traffic-shaping]
aliases: ["Rate Limiting Algorithms Deep Dive", "Rate Limiting Algorithm Deep Dive (Token Bucket, Sliding Window, Leaky Bucket)", "Token Bucket vs Sliding Window", "Rate Limiting Implementation", "Traffic Shaping Algorithms"]
---

# Rate Limiting Algorithms Deep Dive (Token Bucket, Sliding Window, Leaky Bucket)

> **Staff-Engineer Focus:** "Use a token bucket" is the junior answer. Knowing that a sliding window log provides perfect accuracy at the cost of memory is the senior answer. **Knowing when a token bucket silently fails at scale — and designing a hybrid that combines the memory guarantees of sliding window with the burst tolerance of token bucket, while handling clock skew in a distributed deployment — that's the staff engineer.** The interview question isn't "explain rate limiting." It's: "You're building rate limiting for a global API gateway handling 500K RPS across 3 regions. The rate limit is 100 requests/second per user. You have 5ms budget for the rate-limit check. Users must NEVER be rate-limited incorrectly due to clock skew between regions. Concurrency of up to 10 parallel requests from the same user must be handled correctly. How do you design this?"

---

## Summary & Interview Framing

A mathematical comparison of rate limiting algorithms — token bucket (burst-tolerant), sliding window (precise), fixed window (simple but boundary-prone), and leaky bucket (smooth).

**How it's asked:** "Compare token bucket vs sliding window for a 100 RPS/user limit with 5ms budget. Which would you choose for bursty traffic? For steady traffic? Justify with the math."

---

## 1. Why Rate Limiting Algorithms Matter

Rate limiting is one of the most common distributed systems problems. At face value it's simple — "allow N requests per time window T" — but the implementation choices cascade into availability, fairness, cost, and correctness guarantees. Getting the algorithm wrong means:

- **Too strict:** Users are incorrectly throttled → churn, support tickets, revenue loss
- **Too lenient:** A single abusive user saturates your backend → cascading failures
- **Wrong burst behavior:** Legitimate traffic spikes (login rush, flash sale) get blocked while slow-drip abusers slip through
- **Unfairness:** One user's 100 requests/second get all allocated in the first 50ms, starving other users in the same second

The algorithm you pick determines every downstream property: accuracy, memory cost, burst handling, distributed correctness, and operational overhead.

---

## 2. Algorithm Taxonomy at a Glance

| Algorithm | Accuracy | Memory per User | Burst Handling | Distributed Complexity | Best For |
|-----------|----------|----------------|----------------|------------------------|----------|
| **Fixed Window** | ❌ Poor (boundary double-spike) | O(1) — 1 counter | None (all-or-nothing) | Low | Simple quotas, low-stakes |
| **Sliding Window Log** | ✅ Perfect | O(N) — all timestamps | Inherent in design | High (log replication) | Billing, precision-critical |
| **Sliding Window Counter** | ✅ Good (±2× error) | O(1) — 2 counters | Smoothed | Low | General-purpose API limiting |
| **Token Bucket** | ✅ Good | O(1) — 2 counters | ✅ Excellent (configurable) | Low | Most API gateways |
| **Leaky Bucket** | ✅ Good | O(1) — 1 counter + queue | ❌ Rigid (smooths, doesn't burst) | Low | Traffic shaping, outbound queues |

**The unifying tension:** Sliding Window Log is the only algorithm with perfect accuracy, but it costs O(N) memory and requires a distributed log for correctness across servers. Every other algorithm trades some accuracy for O(1) memory and simpler distributed guarantees. The staff-engineer skill is picking where on this spectrum your use case lives.

---

## 3. Fixed Window Counter — The Trap

### How It Works

```
Window: 1 second (e.g., 12:00:00 to 12:00:01)
Counter resets at each window boundary.

12:00:00.200 → counter=0 → allow → counter=1
12:00:00.450 → counter=1 → allow → counter=2
...
12:00:00.900 → counter=99 → allow → counter=100
12:00:00.920 → counter=100 → REJECT (limit is 100)
12:00:01.000 → counter resets to 0
```

### The Boundary Problem (Double Spike)

```
  Window 1 (12:00:00 - 12:00:01)     Window 2 (12:00:01 - 12:00:02)
  ┌─────────────────────────────┐    ┌─────────────────────────────┐
  │ 100 requests @ 12:00:00.9   │    │ 100 requests @ 12:00:01.1   │
  └─────────────────────────────┘    └─────────────────────────────┘
                    ↓                            ↓
            0.2 seconds apart = 200 requests effectively in 200ms!
            The system sees 1000 RPS burst at the boundary.
```

**This is the fixed window killer.** At every boundary, an attacker (or a bursty legitimate client) can send 2× the limit within a span of microseconds — 100 requests at t=0.999s and 100 requests at t=1.001s. The system sees 200 requests in ~2ms but the algorithm permits both windows.

**Never use fixed window for anything that protects a downstream service.** It's fine for "free tier: 1000 requests/day" where the time scale is so large the boundary spike is diluted. For anything with sub-minute windows, it's a trap.

### Implementation (Redis, Atomic)

```
redis> INCR user:123:window:2026-06-13:12:00:00
redis> EXPIRE user:123:window:2026-06-13:12:00:00 2
```

**Cost:** 1 key per user per window. For 1-second windows, that's 3,600 keys/user/hour — large but manageable. The real problem is the accuracy, not the storage.

### When Fixed Window Is Acceptable

| Scenario | Window Size | Why It's OK |
|----------|------------|-------------|
| Daily free-tier quota | 1 day | 2× burst is diluted over 24h — actual load barely changes |
| Hourly report generation limit | 1 hour | Same dilution logic |
| Per-month API key billing | 1 month | Boundary spikes are invisible |
| Coarse-grained tenant fair-sharing | 1 hour | Fairness approximation is good enough |

---

## 4. Sliding Window Log — The Gold Standard

### How It Works

Maintain a sorted log of request timestamps for each user. On each request:

```
1. Remove all timestamps older than (now - window_size)
2. Count remaining timestamps
3. If count < limit → append current timestamp and ALLOW
4. If count >= limit → REJECT
```

### Precision

```
User requests at: [0.1, 0.3, 0.5, 0.8, 0.9, 1.05, 1.1]
Window: 1 second, Limit: 5

Request at 0.9s:  log = [0.1, 0.3, 0.5, 0.8, 0.9], count=5 → REJECT ✓
Request at 1.05s: log = [0.3, 0.5, 0.8, 0.9, 1.05], count=5 → REJECT ✓
Request at 1.1s:  log = [0.8, 0.9, 1.05, 1.1], count=4 → ALLOW ✓
→ At NO POINT did the user exceed 5 requests in any 1-second window.
```

Guarantee: if limit = N and window = T, NO sliding window of size T contains more than N requests. Period. This is the accuracy that billing systems and hard-enforcement SLAs demand.

### The Cost

For a user with 100 RPS sustained traffic, the log stores 100 timestamps. Each is ~8 bytes (64-bit epoch in ms) = 800 bytes per user. For 10M active users: 8 GB just for timestamp logs. Redis memory becomes the bottleneck.

**Optimization: Redis Sorted Set with background eviction**

```
# Add request timestamp
ZADD user:123:log <now_ms> <now_ms>:<uuid>

# Remove expired entries (can be lazy — run before each check)
ZREMRANGEBYSCORE user:123:log 0 <now_ms - window_ms>

# Count
count = ZCARD user:123:log
```

Use a Lua script for atomicity (ZREMRANGEBYSCORE + ZCARD + ZADD if allowed).

### Distributed Sliding Window Log

The log must be consistent across all servers. This means one of:
- **Global Redis/ZooKeeper:** every check hits a shared store. At 500K RPS, Redis becomes the bottleneck (single-threaded).
- **Partitioned logs:** consistent-hash users to specific log-shard servers. Sticky sessions, but failover is complex.
- **Eventual consistency with bounded error:** accept a small window of staleness (100ms replication lag) in exchange for local writes.

**The staff-engineer conclusion:** Perfect accuracy with sliding window log is only worth the cost when it's REQUIRED (billing, hard-enforcement compliance). For most API gateways, the approximation algorithms below are the pragmatic choice.

---

## 5. Sliding Window Counter — The Pragmatic Approximation

### How It Works

Instead of storing every timestamp, store only the **count for the current window** and **the count for the previous window**. Use a weighted interpolation to estimate the count in the rolling window.

```
                         now
                          │
   Previous Window    Current Window
┌──────────────────┬──────────────────┐
│  count_prev = 42 │ count_curr = 28  │
└──────────────────┴──────────────────┘
   ◄── 1 second ──► ◄── 1 second ──►
                   ▲
            now is 0.3s into current window
            (30% elapsed)

estimated_count = count_prev × (1 - 0.3) + count_curr
                = 42 × 0.7 + 28
                = 29.4 + 28
                = 57.4

If limit = 100: 57.4 < 100 → ALLOW
```

### The Formula

```
weight = (window_size - elapsed_in_current_window) / window_size
estimated = count_previous × weight + count_current
```

### Error Bound

The worst-case error is ±1 full window's worth of requests (both previous and current windows could have been dense or sparse at the boundary). In practice, for steady traffic the error is negligible. For bursty traffic, the error at window boundaries can approach ~1.5× the limit. This is still vastly better than fixed window's 2× boundary spike.

### Implementation (Redis)

```
# Keys
user:123:prev   → count in previous window (e.g., second 12:00:00-12:00:01)
user:123:curr   → count in current window (e.g., second 12:00:01-12:00:02)

# Lua script (atomic)
local prev_key = KEYS[1]
local curr_key = KEYS[2]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

local curr_window_start = math.floor(now / window_ms) * window_ms
local elapsed = now - curr_window_start
local weight = (window_ms - elapsed) / window_ms

local count_prev = tonumber(redis.call('GET', prev_key) or 0)
local count_curr = tonumber(redis.call('GET', curr_key) or 0)

local estimated = count_prev * weight + count_curr

if estimated >= limit then
    return 0  -- REJECT
end

redis.call('INCR', curr_key)
redis.call('EXPIRE', curr_key, math.ceil(window_ms * 3 / 1000))
return 1  -- ALLOW
```

### Window Boundary Handling

The tricky part: when `now` crosses a window boundary, the "current" window becomes the "previous" window, and we need a fresh current window. The Lua script must detect this and rotate:

```
curr_window_start = floor(now / window_ms) * window_ms
if curr_key's window ≠ curr_window_start:
    # Rotate
    RENAME curr_key prev_key   (or: EXPIRE prev_key, SET prev_key = curr_key value)
    DELETE curr_key
```

This adds complexity but is essential for correctness. **A common bug:** servers with slight clock skew rotate windows at different moments, causing the same request to count against different windows on different servers.

---

## 6. Token Bucket — The Industry Workhorse

### How It Works

```
┌─────────────────────────────────────┐
│           TOKEN BUCKET              │
│                                     │
│   Capacity: 100 tokens (burst)      │
│   Refill rate: 10 tokens/second     │
│                                     │
│   ┌─────────────────────────┐       │
│   │  [T][T][T][T][T]...     │ ← 72 tokens currently
│   └─────────────────────────┘       │
│                                     │
│   On each request:                  │
│     1. Refill: add (now - last_refill) × rate tokens
│     2. If tokens >= 1: consume 1 token → ALLOW
│     3. Else: REJECT                 │
└─────────────────────────────────────┘
```

Two parameters:
- **Rate (r):** sustained throughput (tokens/second)
- **Burst (b):** maximum bucket capacity (tokens)

This decouples _average rate_ from _instantaneous burst_ — the single most important design property in rate limiting.

### Behavior Over Time

```
Bucket capacity: 100, Refill rate: 10/sec

Time 0s:    Bucket = 100 (full)
Time 0-1s:  50 requests → Bucket = 50
Time 1s:    Refill +10 → Bucket = 60
Time 2s:    Refill +10 → Bucket = 70
Time 5s:    0 requests, refill +50 → Bucket = 100 (capped)
Time 5.1s:  120 requests burst → 100 ALLOW, 20 REJECT
Time 5.2s:  10 requests → ALL REJECT (bucket empty, no tokens yet)
Time 6s:    Refill +10 → Bucket = 10 (slow recovery begins)
```

**Key insight:** The burst allows legitimate traffic spikes (login rush, flash sale start) while the sustained rate prevents long-term abuse. A user who's been quiet for 10 seconds can burst 100 requests instantly — this is DESIRED behavior for legitimate use cases.

### Implementation (In-Memory, No Redis)

```python
import time
import threading

class TokenBucket:
    def __init__(self, rate: float, burst: int):
        self.rate = rate          # tokens per second
        self.burst = burst        # max bucket capacity
        self.tokens = burst       # current token count (starts full)
        self.last_refill = time.monotonic()
        self.lock = threading.Lock()

    def allow(self, cost: int = 1) -> bool:
        with self.lock:
            now = time.monotonic()
            elapsed = now - self.last_refill

            # Refill
            self.tokens = min(self.burst, self.tokens + elapsed * self.rate)
            self.last_refill = now

            # Consume
            if self.tokens >= cost:
                self.tokens -= cost
                return True
            return False
```

### Redis Implementation (Distributed Token Bucket)

```lua
-- KEYS[1]: user bucket key (e.g., "user:123:bucket")
-- ARGV[1]: rate (tokens per second)
-- ARGV[2]: burst (max tokens)
-- ARGV[3]: now in seconds (float)
-- ARGV[4]: cost (tokens per request, usually 1)

local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'last_refill')
local tokens = tonumber(bucket[1]) or ARGV[2]  -- default: full
local last_refill = tonumber(bucket[2]) or ARGV[3]

local now = tonumber(ARGV[3])
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local cost = tonumber(ARGV[4])

-- Refill
local elapsed = now - last_refill
tokens = math.min(burst, tokens + elapsed * rate)

-- Consume
if tokens >= cost then
    tokens = tokens - cost
    redis.call('HMSET', KEYS[1], 'tokens', tokens, 'last_refill', now)
    redis.call('EXPIRE', KEYS[1], math.ceil(burst / rate) + 10)
    return 1  -- ALLOW
end

-- Update last_refill even on reject (prevent token generation during denial)
redis.call('HSET', KEYS[1], 'last_refill', now)
redis.call('EXPIRE', KEYS[1], math.ceil(burst / rate) + 10)
return 0  -- REJECT
```

### Token Bucket Variants

| Variant | Description | Use Case |
|---------|-------------|----------|
| **Standard Token Bucket** | Fixed rate + burst. Tokens refill continuously. | General API rate limiting |
| **Multi-Rate Token Bucket** | Different limits per endpoint or per user tier. | Tiered API plans |
| **Hierarchical Token Bucket** | User bucket fills from a tenant bucket. | Multi-tenant SaaS (tenant quota → per-user sub-quotas) |
| **Token Bucket with Priority** | Reserve portion of bucket for high-priority requests. | Mix of critical and non-critical API calls |
| **Weighted Token Bucket** | Different endpoints consume different token amounts. | Expensive vs. cheap API calls |

---

## 7. Leaky Bucket — Traffic Shaping, Not Rate Limiting

### How It Works

Think of a bucket with a hole in the bottom. Water (requests) pours in from the top. Water leaks out at a constant rate through the bottom hole. If the bucket fills up (queue full), incoming water overflows (rejected).

```
        Requests arrive at variable rate
        │  │  │    ││││      │  │
        ▼  ▼  ▼    ▼▼▼▼      ▼  ▼
   ┌────────────────────────────────┐
   │        LEAKY BUCKET            │
   │   Queue capacity: 50 requests  │
   │                                │
   │   Processing rate: 10 req/sec  │
   │            (the "leak")        │
   └────────────────────────────────┘
                    │
                    ▼
        Requests drain at CONSTANT rate
        │  │  │  │  │  │  │  │  │  │
```

### Token Bucket vs. Leaky Bucket

| Property | Token Bucket | Leaky Bucket |
|----------|-------------|--------------|
| **What it controls** | Rate of accepting requests | Rate of processing requests |
| **Burst handling** | Allows bursts (up to bucket capacity) | Smoothes bursts (queues them) |
| **Queue** | No explicit queue | Has a queue (bounded) |
| **Downstream protection** | Indirect (rate-limited at entry) | Direct (constant outflow protects downstream) |
| **Latency** | No added latency for accepted requests | Requests may wait in queue → added latency |
| **Use case** | API gateway rate limiting | Traffic shaping for outbound calls, network policing |

**Leaky bucket is the wrong choice for API rate limiting** because it adds latency (queues requests). You don't want to hold a user's HTTP connection open while their request waits in a queue. Leaky bucket shines for **outbound traffic shaping** — e.g., your service calls a third-party API with a strict 10 QPS limit. You put outbound calls in a leaky bucket queue that drains at exactly 10 QPS, protecting the third party from your bursts.

### Implementation (Queue-Based)

```python
import time
import threading
from collections import deque

class LeakyBucket:
    def __init__(self, rate: float, capacity: int):
        self.rate = rate              # processing rate (requests/second)
        self.capacity = capacity      # queue capacity
        self.queue = deque()
        self.last_leak = time.monotonic()
        self.lock = threading.Lock()

    def submit(self, request) -> bool:
        """Returns True if request accepted, False if queue full (overflow)."""
        with self.lock:
            if len(self.queue) >= self.capacity:
                return False  # Overflow — reject
            self.queue.append(request)
            return True

    def process(self):
        """Drain the queue at the configured rate."""
        with self.lock:
            now = time.monotonic()
            elapsed = now - self.last_leak
            to_process = int(elapsed * self.rate)
            to_process = min(to_process, len(self.queue))

            for _ in range(to_process):
                request = self.queue.popleft()
                self._actually_process(request)

            self.last_leak = now
```

---

## 8. The Distributed Rate Limiting Problem

All the algorithms above assume a single rate limiter instance. In a distributed system with N gateway instances, the problem becomes:

```
        ┌──────────┐
   ┌───►│ Gateway 1│──┐
   │    └──────────┘  │
   │    ┌──────────┐  │     ┌─────────────┐
LB ─┼───►│ Gateway 2│──┼────►│  Backend    │
   │    └──────────┘  │     └─────────────┘
   │    ┌──────────┐  │
   └───►│ Gateway 3│──┘
        └──────────┘

User X's requests may hit Gateways 1, 2, and 3.
Each gateway has its own local counter.
→ User X effectively gets N × the limit (one per gateway).
```

### Solution 1: Centralized Counter (Redis/Memcached)

Every gateway checks a shared Redis cluster.

```
Gateway 1: INCR user:123:counter → 1 → ALLOW
Gateway 2: INCR user:123:counter → 2 → ALLOW
Gateway 3: INCR user:123:counter → 3 → ALLOW
...
Gateway 1: INCR user:123:counter → 101 → REJECT
```

**Pros:** Simple, correct for fixed/sliding window counters.
**Cons:** Redis becomes the bottleneck. At 500K RPS, a single Redis instance (100K-200K ops/sec) can't keep up. You need Redis Cluster with sharding. Network latency adds 0.1-1ms to every check.

**Optimization: Local LRU + Redis fallback**

```
1. Check local LRU cache: "user:123 → {count: 42, expires: 12:00:01}"
   → If present and count < limit: increment local, ALLOW
   → If present and count >= limit: REJECT
   → If absent: query Redis
2. Redis returns current count.
   → If count < limit: INCR in Redis, cache locally, ALLOW
   → If count >= limit: REJECT
3. Async background sync: every 100ms, flush local increments to Redis.
```

This reduces Redis load by 80-95% (most requests hit local cache) but introduces two problems:
- **Staleness:** Local counts lag behind global state → users may exceed limit by ~100ms × rate
- **Crash loss:** If a gateway crashes, its local increments are lost → undercount

### Solution 2: Consistent Hashing (Sticky Sessions)

```
hash(user_id) % N → Gateway K

All requests for User X always go to Gateway K:
  → Local in-memory rate limiter on Gateway K is authoritative
  → No Redis needed
  → No distributed coordination

Problem: Gateway K crashes → User X's rate limit state is lost.
        New Gateway K' starts from zero → user gets a fresh quota (abuse vector).
```

**Mitigation:** Gateway-to-gateway state gossip (each gateway periodically shares its user → count mapping with peer gateways). On failover, the new gateway can reconstruct approximate state.

### Solution 3: Two-Layer (Local + Global)

```
Layer 1 (Local): Token bucket, per-gateway, configured for 80% of per-user limit
  → Handles 99% of requests with <1μs latency
  → User can burst up to 80% of limit per gateway

Layer 2 (Global): Redis-based sliding window counter for the remaining 20%
  → When local bucket is empty AND user needs more, query Redis
  → Adds 0.5-1ms latency but only for 1% of requests
  → Correctness: global Redis prevents exceeding the cap
```

This is the **pragmatic staff-engineer answer** — it gives you near-perfect correctness (Redis is authoritative) with near-in-memory performance (local handles the steady state).

---

## 9. Clock Skew — The Hidden Distributed Rate Limiter Killer

In a multi-region deployment, servers in us-east-1, eu-west-1, and ap-southeast-1 have clocks that can drift by 100-500ms relative to each other. Even with NTP, 10-50ms skew is normal.

### The Problem

```
us-east-1 clock: 12:00:00.500
eu-west-1 clock: 12:00:00.450 (skewed -50ms)
ap-se-1 clock:   12:00:00.550 (skewed +50ms)

Window: 1 second from 12:00:00.000 to 12:00:01.000

Request arrives at absolute time 12:00:00.980:
  us-east-1 sees: 12:00:00.980 → in window → counts it
  eu-west-1 sees: 12:00:00.930 → in window → counts it
  ap-se-1 sees:   12:00:01.030 → NEXT window → counts it separately
```

A single request can be counted in different windows depending on which server handles it. For sliding window algorithms that rely on time boundaries, this causes:
- **Undercounting:** requests fall into "future" windows on skewed servers, appearing to not count
- **Overcounting:** the same request (on retry) may count in both the current and next window

### Solutions

**1. Use monotonic time for local decisions:** `time.monotonic()` is immune to clock adjustments. Use it for all in-process rate limiting. Only use wall-clock time when interacting with Redis (where monotonic time across machines is meaningless).

**2. Redis-based time source:** Use `TIME` command on the Redis server as the authoritative clock. All rate-limiting scripts use the Redis server's time, not the gateway's clock.

```lua
local redis_time = redis.call('TIME')  -- Returns [seconds, microseconds]
local now = tonumber(redis_time[1]) + tonumber(redis_time[2]) / 1000000
-- All window calculations use redis_time, not ARGV[3]
```

**3. Clock-skew-tolerant windowing:** Instead of strict second-boundary windows, use relative windows anchored to a user-specific epoch:

```
user_epoch = hash(user_id) % window_size
user_window = floor((now - user_epoch) / window_size)
```

This staggers window boundaries across users, so clock skew affects different users at different times — it doesn't create systematic bias.

**4. Token bucket is naturally clock-skew-resistant:** Token bucket doesn't have window boundaries — it refills continuously based on elapsed time. A ±50ms clock skew means ±0.5 tokens at 10 tokens/sec. Negligible. **This is a major practical reason token bucket dominates in distributed deployments.**

---

## 10. Concurrency Control in Rate Limiting

### The Problem

A user sends 10 parallel requests simultaneously. Each request checks the rate limiter:

```
Thread 1: GET counter → 0, < 100 → ALLOW, INCR → 1
Thread 2: GET counter → 0, < 100 → ALLOW, INCR → 2   ← also saw 0!
Thread 3: GET counter → 1, < 100 → ALLOW, INCR → 3
Thread 4: GET counter → 2, < 100 → ALLOW, INCR → 4
...
All 10 allowed — but some saw stale state.
```

With a limit of 5 requests/second, 10 parallel requests might all pass because they all read the counter before any of them wrote it. This is the **read-check-write race condition**.

### Solutions

**1. Atomic Redis operations:** Use `INCR` (atomic) instead of `GET` + `SET` (non-atomic). The Redis Lua scripts above handle this correctly — the entire check-and-increment is a single atomic operation.

**2. In-memory locking:**

```python
class ThreadSafeTokenBucket:
    def __init__(self, rate, burst):
        self.bucket = TokenBucket(rate, burst)
        self.lock = threading.RLock()  # Reentrant for testing

    def allow(self, cost=1):
        with self.lock:
            return self.bucket.allow(cost)
```

**3. Lock-free atomic operations (for local counters):**

For in-memory sliding window counters, use atomic compare-and-swap:

```python
import threading

class AtomicCounter:
    def __init__(self):
        self._value = 0
        self._lock = threading.Lock()

    def increment_if_below(self, limit):
        with self._lock:
            if self._value < limit:
                self._value += 1
                return True
            return False
```

**4. Distributed semaphore for precise limits:**

If you need EXACTLY N concurrent requests allowed and no more, use a Redis-based semaphore:

```
ACQUIRE:
  WATCH user:123:semaphore
  current = GET user:123:semaphore
  if current >= N: UNWATCH, REJECT
  MULTI
  INCR user:123:semaphore
  EXEC → if success, ALLOW; if fail (WATCH triggered), retry or REJECT

RELEASE (after request completes):
  DECR user:123:semaphore
```

---

## 11. Interview Question: Global API Gateway Rate Limiting

### The Scenario

> "You're building rate limiting for a global API gateway handling 500K RPS across 3 regions. The rate limit is 100 requests/second per user. You have a 5ms budget for the rate-limit check (including network calls). Users must NEVER be rate-limited incorrectly due to clock skew between regions. Concurrency of up to 10 parallel requests from the same user must be handled correctly. The system must degrade gracefully if Redis becomes unavailable. How do you design this?"

### Model Answer

**Step 1: Algorithm Choice — Hybrid Token Bucket + Sliding Window**

Pure token bucket is clock-skew-resistant but doesn't guarantee perfect per-second accuracy. Pure sliding window log is accurate but too expensive (500K RPS × 100 timestamps each → 50M Redis ops/sec). The hybrid approach:

```
┌─────────────────────────────────────────────────────────────────┐
│                      HYBRID RATE LIMITER                         │
│                                                                  │
│  Layer 1 — LOCAL TOKEN BUCKET (per-gateway, in-memory)          │
│    • Rate: 80 tokens/sec (80% of 100 limit)                     │
│    • Burst: 100 tokens (allows full burst locally)               │
│    • Latency: <1μs                                               │
│    • Handles: 99% of requests                                    │
│    • Clock-skew immune (uses monotonic time)                     │
│                                   │                              │
│                    Token bucket empty?                           │
│                                   │                              │
│  Layer 2 — GLOBAL SLIDING WINDOW (Redis Cluster)                 │
│    • Algorithm: Sliding window counter (not log — O(1) memory)  │
│    • Keys: user:123:{window_id}:count                            │
│    • Lua script: atomic check-and-increment                      │
│    • Latency: 0.5-2ms (Redis network round trip)                 │
│    • Handles: 1% of requests (overflow from L1)                  │
│    • Clock source: Redis TIME command (eliminates clock skew)    │
│                                   │                              │
│                         Redis unavailable?                       │
│                                   │                              │
│  Layer 3 — CIRCUIT BREAKER FALLBACK                              │
│    • Action: GRACEFUL DEGRADATION                                │
│    • Fall back to local token bucket ONLY (no global cap)       │
│    • Log warning, increment "degraded_rate_limiting" metric      │
│    • Per-user: still 80/sec local limit (not ideal, but safe)    │
│    • When Redis recovers: resume L2 checks transparently         │
└─────────────────────────────────────────────────────────────────┘
```

**Step 2: Concurrency Handling**

The Lua script in Redis runs atomically — no read-check-write race possible for the global counter. For the local token bucket, use a per-bucket mutex (lightweight, in-process, negligible overhead). The 10-parallel-request scenario is handled because:

- 5 requests grab local tokens (under the mutex, serially in microseconds)
- Remaining 5 hit L2 (Redis Lua), which atomically checks and increments
- Result: at exactly 100 requests, the next request is rejected — even with concurrency

**Step 3: Clock Skew Elimination**

1. **Local layer:** Use `time.monotonic()` — immune to NTP adjustments, clock skew, and leap seconds.
2. **Global layer:** Redis Lua script calls `redis.call('TIME')` for the authoritative timestamp. All window calculations use Redis time. Gateways' local clocks are irrelevant.

**Step 4: Redis Failure Degradation**

```
┌────────────────────────────────────────────┐
│         CIRCUIT BREAKER STATE MACHINE       │
│                                              │
│  CLOSED ───── Redis error rate > 1% ────► OPEN
│    ▲                                         │
│    │                                         ▼
│    │                                    HALF_OPEN
│    │                                         │
│    └─── Redis healthy > 30s ◄───────────────┘
│                                              │
│  States:                                      │
│    CLOSED:     Normal operation (local + Redis)
│    OPEN:       Local-only, alert fired        │
│    HALF_OPEN:  Probe Redis every 5s           │
└────────────────────────────────────────────┘
```

In OPEN state, ALL requests use the local token bucket (80/sec per gateway). If all 3 gateways see the user, they could get 240/sec — but (a) consistent hashing for sticky sessions minimizes this, (b) the backend is still protected against the worst case, and (c) it's a temporary degradation, not a permanent failure mode.

**Step 5: Monitoring & Alerting**

| Metric | Alert Threshold | Why |
|--------|----------------|-----|
| `rate_limiter.l1_hit_ratio` | < 95% | Users are falling through to Redis too often — increase L1 allocation |
| `rate_limiter.redis_latency_p99` | > 3ms | Redis is slowing down, nearing the 5ms budget |
| `rate_limiter.circuit_breaker_state` | != CLOSED | Redis is unavailable — degraded mode active |
| `rate_limiter.reject_rate` | Sudden spike (>10% above baseline) | Possible attack or misconfiguration |
| `rate_limiter.clock_skew_seconds` | > 1s | NTP is broken on a gateway — fix immediately |

### Common Pitfall

**❌ "Just use a global Redis with INCR and a TTL."** This is a fixed window counter in Redis. It has the boundary double-spike problem (user can send 100 at t=0.999s and 100 at t=1.001s = 200 in ~2ms). At 500K RPS, the Redis `INCR` operation load would be 500K ops/sec — within Redis's capability but without any local caching you're paying the network RTT on every request, which at 0.5ms minimum is 10% of your 5ms budget just for rate limiting. And if Redis has a hiccup, your entire API gateway blocks on rate-limit checks.

**✅ The fix:** Use the hybrid approach. Local token bucket (1μs, no network) for 99% of traffic. Redis sliding window counter as the global backstop for the 1% overflow. Redis TIME as the clock source. Circuit breaker for Redis failures. This gives you:
- **Performance:** 99% of requests skip the network hop
- **Correctness:** Global Redis prevents exceeding the limit
- **Resilience:** Circuit breaker prevents Redis from being a single point of failure
- **Clock-skew immunity:** Redis TIME + local monotonic time

---

## 12. Choosing the Right Algorithm — Decision Flowchart

```
┌─────────────────────────────────────────────────────────────────┐
│           WHICH RATE LIMITING ALGORITHM?                         │
│                                                                  │
│  Q1: Do you need PERFECT accuracy (zero tolerance for over-limit)?
│    ├── YES → Sliding Window Log (with Redis sorted sets)
│    │         Cost: O(N) memory, higher latency
│    │         Use case: Billing, compliance, hard-enforcement
│    │
│    └── NO → Q2: Do you need burst tolerance?
│                ├── YES → Q3: Is it an API gateway (latency-sensitive)?
│                │         ├── YES → Token Bucket
│                │         │          Most API gateways use this
│                │         │
│                │         └── NO → Q4: Is it outbound traffic shaping?
│                │                   ├── YES → Leaky Bucket
│                │                   │          Constant outflow, protects downstream
│                │                   │
│                │                   └── NO → Token Bucket
│                │                              (still the best general choice)
│                │
│                └── NO (no burst needed, steady throughput) →
│                      Sliding Window Counter (approximation)
│                      Good accuracy, O(1) memory, low complexity
│
│  Q5: Is it a COARSE (hourly/daily) quota, not real-time?
│    └── YES → Fixed Window is fine
│              Simplicity wins when the time scale dilutes errors
│
│  Q6: Are you in a DISTRIBUTED multi-region deployment?
│    └── YES → Hybrid: Local Token Bucket + Global Redis Sliding Window
│              Add circuit breaker for Redis failure
└─────────────────────────────────────────────────────────────────┘
```

---

## 13. Edge Cases & Curveball Questions

### "Your rate limiter has been running for months. A user complains they're being rate-limited despite only sending 50 requests/second (limit is 100). How do you debug?"

**Staff-engineer debugging process:**

1. **Check clock skew:** `ntpq -p` on all gateways. A gateway with -2s skew thinks requests from 2 seconds ago are in the current window — doubling the count.
2. **Check Redis partition:** Is the user's key on a specific Redis shard that's overloaded? Slow INCR responses may cause retries → double-counting.
3. **Check token bucket refill:** Is `last_refill` being updated correctly on REJECT? A common bug: updating `last_refill` only on ALLOW. When user is rejected for 10 seconds, `elapsed` grows to 10s, and suddenly 100 tokens materialize — allowing a burst they shouldn't get.
4. **Check for client retry amplification:** Client sends 1 request → gets 429 → retries immediately → 2 requests counted. If client retries in a loop, actual throughput can be 3-5× what the client thinks.
5. **Check for IPv6 / NAT:** Is the user_id derived from IP? Behind CGNAT, 1000 users share one IP → they all count against each other's limit. Use API keys or session tokens, not IPs.

### "You're asked to implement a 'fair' rate limiter that guarantees each user gets their proportional share even under overload. What changes?"

Token bucket (and most algorithms) is **first-come-first-served** — when the bucket is empty, everyone is rejected equally, regardless of their historical usage. A **Weighted Fair Queuing (WFQ)** approach:

```
Maintain per-user virtual finish time:
  virtual_time += cost / weight

On each request:
  If user's virtual_time < global_virtual_time:
    ALLOW (user is "behind" and deserves service)
  Else:
    REJECT (user is "ahead" — consumed more than fair share)
```

This guarantees that under overload, users who've used less get priority over heavy users. Used in network QoS (quality of service) and storage I/O schedulers. For API gateways, this is overkill unless you have a multi-tenant SaaS product where fairness is a paying feature.

### "You need a rate limiter that works in a client-side SDK (mobile app) with no server round-trip. The limit must be accurate within 10%. Is this possible?"

Yes, with caveats. The client-side SDK maintains a local token bucket. The server periodically pushes quota updates (every 60 seconds). The client enforces locally between updates.

```
Server → Client (every 60s): { remaining: 5400, reset_at: <epoch> }
Client enforces locally: 5400 requests per 60s = 90 RPS token bucket

Accuracy: ±10% because the client may slightly overuse before the next quota
update, and clock skew between client device and server adds uncertainty.
```

**Caveats:** A malicious client can bypass local rate limiting. This only works for cooperative clients (your own mobile app, not third-party API consumers). For third-party APIs, rate limiting MUST be server-side.

### "Your Redis-based rate limiter has P99 latency of 50ms due to network. Budget is 5ms. What do you do?"

Options (in order of increasing complexity):

1. **Co-locate Redis with gateways** — same AZ, same rack. Network RTT drops to <1ms.
2. **Redis pipelining** — batch multiple rate-limit checks into one Redis round-trip. Trade-off: added latency for the first request in the batch.
3. **Local-first architecture** (described above) — only 1% of requests hit Redis.
4. **Redis alternative with lower latency** — Dragonfly (10× faster than Redis for some workloads) or memcached (simpler protocol, slightly lower latency).
5. **Switch to local-only with gossip** — eliminate the centralized store entirely. Each gateway gossips its local counts every 100ms. Total known count = sum of all gateways' reported counts. Error = gossip staleness (100ms).

---

## 14. Key Metrics Summary

| Metric | Target | Why |
|--------|--------|-----|
| Rate-limit check latency (P50) | < 10μs | Must not add perceptible delay to API responses |
| Rate-limit check latency (P99) | < 3ms | Under the 5ms budget even at tail |
| Redis RTT (P99) | < 2ms | Redis is the dominant cost in L2 checks |
| Local hit ratio (L1) | > 95% | Most requests should skip the Redis hop |
| Clock skew (max across gateways) | < 50ms | Larger skew corrupts sliding window accuracy |
| Concurrency correctness | Zero race-condition allowances | Atomic Redis scripts + local mutexes |
| False-positive rate (incorrect rejection) | < 0.01% | User trust — must be near-zero |
| False-negative rate (incorrect allowance) | < 1% (degraded mode okay) | Over-limit by ~5% acceptable briefly during degraded mode |
| Redis circuit breaker trigger threshold | Error rate > 1% over 30s | Prevent Redis from being SPOF |
| Time to detect Redis recovery | < 30s | Minimize degraded-mode duration |

---

## 15. Weaknesses & Trade-offs

1. **Token bucket's dirty secret — burst amplification across gateways.** In the hybrid design, each gateway allocates 80 tokens/sec locally. With 3 gateways, a user who round-robins between them can get up to 240/sec locally before hitting Redis. The 100/sec global limit is enforced, but the local allocation is effectively per-gateway. Mitigation: use consistent hashing for sticky sessions, or lower local allocation (e.g., limit/N tokens per gateway).

2. **Sliding window counter's approximation error accumulates under sustained load.** If the previous window had 100 requests and the current window has 100 requests, at the boundary the estimate can read up to 150 (100 × 0.5 + 100). Users may see brief 50% over-limit allowance at window transitions.

3. **Redis is a single point of failure in centralized designs.** Distributed systems dogma says "don't have a SPOF," but pragmatically, a well-operated Redis Cluster with Sentinel for failover has >99.99% uptime — better than most homegrown distributed consensus systems. The circuit breaker is your insurance, not your primary strategy.

4. **Leaky bucket is almost always the wrong choice for API rate limiting.** It adds queuing latency, which is antithetical to API gateway performance. Yet it shows up in textbooks alongside token bucket as if they're interchangeable. They're not. Reserve leaky bucket for outbound traffic shaping.

5. **Fixed window's boundary spike is NOT just a theoretical concern.** Cloudflare's 2013 outage was partially caused by a fixed-window rate limiter that allowed double the expected traffic at window boundaries, overwhelming their backend during a DDoS. They switched to sliding window after.

6. **Clock skew is the silent killer.** Most rate limiter bugs in production are not algorithm bugs — they're clock skew bugs. NTP can silently fail. A server's clock can jump backward (negative leap second, VM migration). Always use monotonic time for local decisions and Redis TIME for global decisions.

7. **Cost of accuracy.** Sliding window log with 10M users at 100 RPS each = 1 billion timestamps in Redis = ~10 GB of memory. At ~$0.50/GB-month for Redis on cloud, that's $5/month — trivial. But at 1M RPS and 1-minute windows, you need 60M timestamps per user = 600 TB of Redis memory. The cost skyrockets. The algorithm's memory cost determines its feasibility at scale, not its theoretical elegance.

---

## Related
- [[topic-queue]]
- [[Rate Limiter]] (the system design article — Day 2)
- [[API Gateway & Load Balancer]] (rate limiting is often deployed at the API gateway layer)
- [[Distributed Cache (Redis-Memcached)]] (Redis as the centralized counter store)
- [[Circuit Breakers & Bulkheads]] (the circuit breaker pattern for Redis degradation)
- [[Consistent Hashing]] (for sticky-session based distributed rate limiting)

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Token Bucket: allows bursts up to capacity, refills at fixed rate. Best for APIs that need to handle short bursts
- Sliding Window Log: perfect accuracy, O(n) memory per key. Use only for low-volume, high-precision limits
- Sliding Window Counter: approximation using current + previous window weighted by overlap. O(1) memory, ~0.003% error
- Fixed Window: simple, O(1), but has boundary spikes (double traffic at window edges)
- Distributed rate limiting requires shared state (Redis) or consistent hashing for per-node limits

**Common Follow-Up Questions:**
- "How do you handle clock skew in distributed rate limiting?" — Use a centralized time service (NTP) or Redis as the single source of truth. For multi-region, use the region's local clock with a grace period.
- "What's the memory cost of sliding window log for 1M users at 100 req/sec?" — 1M × 100 entries × 8 bytes (timestamp) = 800MB. This is why sliding window counter (O(1) per key) is preferred at scale.

**Gotcha:**
- Per-node rate limits compound: if your limit is 100/sec and you have 5 nodes, a user can actually send 500/sec by hitting each node. You need a shared counter (Redis) or consistent hashing to ensure one user always hits the same node.
