---
title: "Rate Limiter — LLD Focus"
type: system-design
category: Deep Dive
date: 2026-05-30
tags: [system-design, interview, rate-limiting, LLD, concurrency, thread-safety, design-patterns, SOLID, Redis]
aliases: [Rate Limiter LLD, Low-Level Design Rate Limiter, Token Bucket Implementation, Sliding Window Rate Limiter]
---

# Rate Limiter — Low-Level Design (LLD) Focus

## Summary & Interview Framing

The low-level design of rate limiting — data structures, concurrency patterns, and lock-free algorithms for enforcing request limits in a single process. This article covers the implementation layer rather than the distributed architecture.

**How it's asked:** "Design a thread-safe rate limiter using the token bucket algorithm. Handle concurrent requests without locks, and discuss the trade-offs of CAS vs striped locks."

---

## Overview

This is the Low-Level Design companion to the [[Rate Limiter]] fundamentals article. Where the high-level discussion covers algorithm trade-offs, distributed architecture, and capacity planning, this article is concerned with what you would actually type into an IDE: the interfaces, the classes, the concurrency primitives, the configuration plumbing, and the test scaffolding. This is the layer senior and staff candidates are expected to whiteboard when the interviewer leans in and says, "That's the architecture — now show me how you'd implement it."

At the LLD level a rate limiter is best understood as a **concurrent, time-aware state machine bolted to a configurable policy engine**. Getting it right is almost never about the algorithm itself; everyone knows token bucket. It is about three engineering properties that are easy to get wrong and expensive to debug in production: **atomicity** (no double-counting or token leakage under real concurrency), **memory** (efficient per-key state that does not balloon with cardinality), and **composability** (the ability to stack limiters — per-user *and* per-IP *and* global — without violating each contract or producing surprising coupling). The design below is built around those three properties, with design patterns chosen to keep the code open for extension but closed for modification.

## Core Interface Design

### The RateLimiter Contract

A good LLD begins with a clean, narrow interface. The contract below is intentionally small: one primary decision method, one introspection method, and one administrative method. Everything else is a specialization that should live behind a separate interface rather than bloating the core.

```
public interface RateLimiter {
    // Primary decision: is this request allowed under the configured policy?
    RateLimitResult tryAcquire(String key);

    // Read-only introspection: tokens/requests remaining, retry hint.
    // Must NEVER mutate state and must be safe to call from monitoring threads.
    RateLimitStatus getStatus(String key);

    // Administrative reset: tests, ops runbooks, key rotation.
    void reset(String key);
}
```

The return type is an immutable value object, never a mutable handle into the limiter's internals. Returning mutable state is the most common encapsulation leak in hand-rolled limiters; it lets callers corrupt counters or race the refill thread. A well-designed result carries the decision, the remaining budget, the timestamp the decision was computed against, and a `RetryAfter` hint expressed in milliseconds so the caller can back off precisely rather than guessing.

```
public final class RateLimitResult {
    private final boolean allowed;
    private final long remaining;       // tokens or requests left in current window
    private final long retryAfterMillis; // 0 when allowed; hint when denied
    private final String policyId;      // which rule produced this decision
    private final long decidedAtEpochMillis;

    // all-args constructor, getters, equals/hashCode, toString.
    // No setters. Construct once, share freely across threads.
}
```

### RateLimiter Interface / Class Diagram (UML-style)

The core type hierarchy: a decision interface, two segregated sibling interfaces, and the concrete strategies that implement them. The immutable value objects `RateLimitResult` and `RateLimitStatus` flow back from every call.

```
                  <<interface>>                       <<interface>>                  <<interface>>
                  RateLimiter                         RateLimitInspector             RateLimitAdmin
                  ─────────────                       ──────────────────             ──────────────
                  + tryAcquire(key): RateLimitResult  + getStatus(key): RateLimitStatus  + reset(key): void
                                                                                         + resetAll(): void
                        ▲                                    ▲                                ▲
                        │ implements                         │ implements                     │ implements
   ┌────────────────────┼──────────────────────┐    ┌────────┴────────┐                  ┌────┴────────────┐
   │                    │                      │    │                 │                  │                 │
┌──┴──────────────┐ ┌───┴───────────────┐ ┌────┴────────────┐ ┌─────┴──────┐ ┌───────────┴────┐  (in-process
│ TokenBucketRate │ │ SlidingWindowRate │ │ FixedWindowRate │ │ RedisRate  │ │ in-process      │   limiters
│ Limiter         │ │ Limiter           │ │ Limiter         │ │ Limiter    │ │ limiters        │   implement
│ ─────────────── │ │ ───────────────── │ │ ─────────────── │ │ (also      │ │ (Token/Sliding/ │   reset +
│ - buckets:Map   │ │ - logs:Map<Deque> │ │ - counters:Map  │ │  RateLimiter)│ │  Fixed)         │   resetAll)
│ - config        │ │ - config          │ │ - config        │ │            │ │ + getStatus()   │
│ - clock         │ │ - clock           │ │ - clock         │ │            │ └─────────────────┘
│ + tryAcquire()  │ │ + tryAcquire()    │ │ + tryAcquire()  │ │
└─────────────────┘ └───────────────────┘ └─────────────────┘ │
                                                             │
   ┌─────────────────────────────┐     ┌─────────────────────────────────┐
   │ RateLimitResult             │     │ RateLimitStatus                 │
   │ <<final, immutable value>>  │     │ <<final, immutable snapshot>>   │
   │ ─────────────────────────── │     │ ─────────────────────────────── │
   │ - allowed: boolean          │     │ - tokensAvailable: long         │
   │ - remaining: long           │     │ - lastRefillTime: long          │
   │ - retryAfterMillis: long    │     │ - windowBoundaries: long[]      │
   │ - policyId: String          │     │ - policyId: String              │
   │ - decidedAtEpochMillis:long │     └─────────────────────────────────┘
   │ (no setters; safe to publish│
   │  across threads)            │
   └─────────────────────────────┘
```

A class may implement one, two, or all three interfaces. A Redis-backed read replica might implement only `RateLimitInspector` (it cannot authorize writes); a test stub might implement only `RateLimiter`. Callers always depend on the narrowest interface that suffices.

### Immutable Result and Status Types

`RateLimitStatus` is the read-only sibling used by dashboards, health checks, and the `/debug/ratelimit` endpoints. It carries a snapshot of the current state for a key — tokens available, last refill time, window boundaries — but, critically, it is a **snapshot taken under the same lock or atomic read** that guards mutation. If you compute status outside the lock you will publish inconsistent views (tokens reported as available that a concurrent `tryAcquire` has just consumed), which leads to confusing dashboards and noisy alerts.

Making both result and status `final` value classes with all fields set at construction time gives you three properties for free: they are safe to publish across threads without additional synchronization, they can be cached or logged without defensive copying, and they cannot be turned into a covert channel for mutating limiter state. This is the single most important habit to carry into the rest of the design.

## Concrete Implementations

Each algorithm is a concrete strategy implementing `RateLimiter`. The implementations share a common skeleton — a keyed store of state, a clock, a config — but differ in *what* state they keep and *how* they mutate it. Keeping the state representation inside each class (rather than in a shared base class) is deliberate: it lets each algorithm choose the minimal representation it needs and prevents a "god base class" that pretends all algorithms have the same fields.

### Token Bucket Implementation

Token bucket maintains, per key, a bucket of capacity `C` that refills at rate `R` tokens per second. Each allowed request consumes one token. The trick is computing the refill lazily on every access rather than running a refill thread, which avoids a background scheduler and the coordination headaches that come with it.

```
public final class TokenBucketRateLimiter implements RateLimiter {
    private final ConcurrentMap<String, BucketState> buckets = new ConcurrentHashMap<>();
    private final TokenBucketConfig config;   // capacity, refillRatePerSec
    private final Clock clock;                // injectable for testing

    private static final class BucketState {
        // Guarded by this instance's intrinsic lock.
        double tokens;
        long lastRefillNanos;
    }

    public RateLimitResult tryAcquire(String key) {
        BucketState state = buckets.computeIfAbsent(key,
            k -> new BucketState(config.getCapacity(), clock.nanoTime()));
        synchronized (state) {                         // lock per-key, not global
            long now = clock.nanoTime();
            long elapsedNanos = now - state.lastRefillNanos;
            double refilled = (elapsedNanos / 1e9) * config.getRefillRatePerSec();
            state.tokens = Math.min(config.getCapacity(), state.tokens + refilled);
            state.lastRefillNanos = now;
            if (state.tokens >= 1.0) {
                state.tokens -= 1.0;
                return allowed(key, (long) state.tokens);
            }
            double deficit = 1.0 - state.tokens;
            long retryMs = (long) Math.ceil(deficit / config.getRefillRatePerSec() * 1000);
            return denied(key, (long) state.tokens, retryMs);
        }
    }
    // getStatus() takes the same synchronized(state) read; reset() removes the key.
}
```

Two details matter. First, the lock is **per-bucket** (`synchronized(state)`), not on the limiter; this gives independent keys independent throughput and prevents one hot key from serializing the world. Second, `computeIfAbsent` is used to lazily materialize state, so memory is proportional to the number of *distinct active keys*, not pre-allocated capacity. A bounded `ConcurrentHashMap` or an LRU eviction policy layered on top prevents unbounded growth from adversarial key spaces — a real concern for per-IP limiters facing a botnet.

### Sliding Window Implementation

The sliding window log keeps a sorted structure of request timestamps within the window `[now - windowSize, now]` and rejects when the count exceeds the limit. The sliding window *counter* approximation is a memory optimization that splits the window into sub-buckets and interpolates, trading exactness for O(1) memory; both share the same interface.

```
public final class SlidingWindowRateLimiter implements RateLimiter {
    private final ConcurrentMap<String, Deque<Long>> logs = new ConcurrentHashMap<>();
    private final SlidingWindowConfig config;   // maxRequests, windowMillis
    private final Clock clock;

    public RateLimitResult tryAcquire(String key) {
        Deque<Long> log = logs.computeIfAbsent(key, k -> new ConcurrentLinkedDeque<>());
        long now = clock.currentTimeMillis();
        long windowStart = now - config.getWindowMillis();
        synchronized (log) {
            // Evict expired entries.
            while (!log.isEmpty() && log.peekFirst() <= windowStart) log.pollFirst();
            if (log.size() < config.getMaxRequests()) {
                log.addLast(now);
                return allowed(key, config.getMaxRequests() - log.size());
            }
            long oldest = log.peekFirst();
            long retryMs = (oldest + config.getWindowMillis()) - now;
            return denied(key, 0, Math.max(retryMs, 1));
        }
    }
}
```

The eviction-then-count sequence must be atomic with respect to the count decision, hence the `synchronized(log)`. Doing eviction in a separate pass without holding the lock is a classic race: between eviction and the size check a concurrent thread can insert, making the count stale and admitting an over-limit request. The synchronized block is short and contention is bounded per key, so throughput stays high for distinct keys.

### Fixed Window Implementation

Fixed window is the simplest and cheapest: a key plus a window identifier (epoch floor) map to an integer counter that resets when the window rolls over. It is the right choice for coarse limits where the boundary burstiness at window edges is acceptable.

```
public final class FixedWindowRateLimiter implements RateLimiter {
    private final ConcurrentMap<String, WindowCounter> counters = new ConcurrentHashMap<>();
    private final FixedWindowConfig config;   // maxRequests, windowMillis
    private final Clock clock;

    private static final class WindowCounter {
        volatile long windowStart;
        final AtomicLong count = new AtomicLong();
    }

    public RateLimitResult tryAcquire(String key) {
        long now = clock.currentTimeMillis();
        long currentWindowStart = (now / config.getWindowMillis()) * config.getWindowMillis();
        WindowCounter wc = counters.computeIfAbsent(key, k -> new WindowCounter(currentWindowStart));
        synchronized (wc) {
            if (wc.windowStart != currentWindowStart) {   // window rollover
                wc.windowStart = currentWindowStart;
                wc.count.set(0);
            }
            long c = wc.count.incrementAndGet();
            if (c <= config.getMaxRequests()) return allowed(key, config.getMaxRequests() - c);
            return denied(key, 0, wc.windowStart + config.getWindowMillis() - now);
        }
    }
}
```

The rollover check and the increment must be atomic together; if you only rely on `AtomicLong` without the surrounding `synchronized(wc)`, two threads can both observe a stale window, both reset to zero, and both admit, producing a double-burst at the boundary. The counter is still `AtomicLong` so that `getStatus` can read it without taking the lock for the common steady-state case, but the *decision* path always holds the per-key monitor.

### Algorithm Comparison

| Algorithm | State per Key | Memory | Burst Behavior | Accuracy | Correctness Primitive | Best For |
|---|---|---|---|---|---|---|
| **Token Bucket** | `tokens (double), lastRefillNanos` | O(1) | Smooth bursts up to capacity | Exact, lazy-refill | per-key `synchronized(state)` | APIs needing burst tolerance + steady rate |
| **Sliding Window Log** | Sorted `Deque<Long>` of timestamps | O(N) where N = requests in window | No burst beyond limit; strict | Exact | per-key `synchronized(log)` | Strict per-request fairness |
| **Sliding Window Counter** | Sub-bucket counters | O(1) (fixed sub-buckets) | Interpolated | Approximate | per-key lock | High-cardinality keys needing bounded memory |
| **Fixed Window** | `windowStart, AtomicLong count` | O(1) | Boundary burst (up to 2× at edges) | Coarse | `synchronized(wc)` around rollover+increment | Cheap edge scrubbers, coarse limits |
| **Leaky Bucket** | Queue depth + leak rate | O(queue size) | Smoothed output, no bursts | Exact (as queue) | per-key lock | Traffic shaping / output smoothing |
| **Redis (any algo)** | Lua-managed `HMSET` in Redis | O(1) per key server-side | Per underlying algorithm | Globally consistent | atomic `EVAL` script (single-threaded) | Multi-instance deployments |

## Strategy Pattern and the Factory

### Strategy Pattern: Swapping Algorithms at the Boundary

The `RateLimiter` interface is the strategy contract; each concrete limiter is a strategy. The value of the pattern here is that the **call site never knows which algorithm it is using**. A middleware filter or interceptor holds a `RateLimiter` reference and calls `tryAcquire(key)`; whether that resolves to token bucket, sliding window, or fixed window is a deployment concern, not a code-path concern. This is what lets you run token bucket in one tier (API gateway) and fixed window in another (per-IP scrubber at the edge) from the same codebase.

#### Strategy Pattern Structure

```
   ┌─────────────────────────────┐
   │          Context            │
   │   RateLimitInterceptor      │
   │   ──────────────────────    │
   │   - limiter: RateLimiter    │──── holds a strategy ref ───┐
   │   - keyResolver: KeyResolver│                             │
   │   + intercept(req): Response│                             │
   └─────────────┬───────────────┘                             │
                 │ calls                                        │
                 ▼                                             │
   ┌─────────────────────────────────────────────┐             │
   │       <<interface>> Strategy                │◀────────────┘
   │            RateLimiter                      │
   │   + tryAcquire(key): RateLimitResult        │
   └────────────────▲────────────────────────────┘
                    │ implements
   ┌────────────────┼────────────────────────────────────────────┐
   │                │                │                  │        │
   ▼                ▼                ▼                  ▼        ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
│ TokenBucket  │ │ SlidingWindow│ │ FixedWindow  │ │ LeakyBucket  │ │ RedisRateLimiter │
│ RateLimiter  │ │ RateLimiter  │ │ RateLimiter  │ │ RateLimiter  │ │ (distributed     │
│ (in-process) │ │ (in-process) │ │ (in-process) │ │ (in-process) │ │  adapter)        │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘ └──────────────────┘

   ┌──────────────────────┐  create(policy)   ┌──────────────────────────────┐
   │ RateLimiterFactory   │──────────────────▶│ one concrete strategy above  │
   │ + create()           │  createDistributed│ (the ONLY place that knows   │
   │ + createDistributed()│──────────────────▶│  concrete class names)       │
   └──────────────────────┘                   └──────────────────────────────┘
```

`KeyResolver` is itself a strategy, deliberately decoupled so that keying policy (per-user, per-IP, per-tenant-per-endpoint composite) can evolve independently of the limiting algorithm. In practice you will stack strategies through composition (covered below), but the unit of interchange remains the single `RateLimiter` contract.

```
public final class RateLimitInterceptor {
    private final RateLimiter limiter;            // strategy reference
    private final KeyResolver keyResolver;        // userId? ip? apiKey?

    public Response intercept(Request req) {
        String key = keyResolver.resolve(req);
        RateLimitResult result = limiter.tryAcquire(key);
        if (!result.isAllowed()) {
            return Response.status(429)
                .header("Retry-After", result.getRetryAfterMillis() / 1000)
                .header("X-RateLimit-Remaining", result.getRemaining())
                .build();
        }
        return chain.proceed(req);
    }
}
```

The `KeyResolver` is itself a strategy, deliberately decoupled so that keying policy (per-user, per-IP, per-tenant-per-endpoint composite) can evolve independently of the limiting algorithm. In practice you will stack strategies through composition (covered below), but the unit of interchange remains the single `RateLimiter` contract.

### Factory Pattern: Constructing Limiters from Configuration

Construction is non-trivial because each algorithm needs different config fields and different state stores, and you do not want `if/else` ladders leaking into business code. A factory centralizes this, taking a `RateLimitPolicy` descriptor and returning a fully-wired `RateLimiter`. The factory is the only place that knows concrete class names, which keeps the rest of the system dependent on abstractions.

```
public final class RateLimiterFactory {
    private final Clock clock;
    private final RedisConnection redis;   // null when in-process only

    public RateLimiter create(RateLimitPolicy policy) {
        return switch (policy.getAlgorithm()) {
            case TOKEN_BUCKET   -> new TokenBucketRateLimiter(policy.asTokenBucket(), clock);
            case SLIDING_WINDOW  -> new SlidingWindowRateLimiter(policy.asSlidingWindow(), clock);
            case FIXED_WINDOW    -> new FixedWindowRateLimiter(policy.asFixedWindow(), clock);
            case LEOAKED_BUCKET   -> new LeakyBucketRateLimiter(policy.asLeakyBucket(), clock);
        };
    }

    public RateLimiter createDistributed(RateLimitPolicy policy) {
        // Returns a Redis-backed limiter sharing the same contract.
        return new RedisRateLimiter(policy, redis, clock);
    }
}
```

The factory is also the natural seam for **distributed vs. local**: `create()` returns an in-process limiter, `createDistributed()` returns one backed by Redis. Both implement the same `RateLimiter` interface, so the interceptor does not change. This is the Open/Closed Principle in action — adding a new algorithm or a new backend means adding a factory branch, not editing the interceptor or the interface.

## Configuration Management

Configuration is a first-class concern, not an afterthought. A `RateLimitPolicy` is an immutable descriptor that carries the algorithm choice, the numeric parameters, the keying strategy, and an identifier used in results and logs. Keeping it immutable means policies can be cached, shared across threads, and hot-reloaded without partial-update races.

```
public final class RateLimitPolicy {
    private final String policyId;
    private final Algorithm algorithm;
    private final KeyStrategy keyStrategy;
    private final long limit;          // requests or tokens
    private final long windowMillis;   // for window algorithms
    private final double refillRatePerSec; // for token bucket
    private final List<String> scope;  // e.g. ["user","endpoint"]
    // builder with validation: limit > 0, window > 0, etc.
}
```

Policies are loaded from configuration sources — YAML, a database table, a feature-flag service — and assembled by a `PolicyRepository`. The repository exposes a `get(policyId)` that returns the current effective policy and supports hot reload via a watch or polling loop. When a policy changes, the repository constructs a *new* `RateLimiter` instance through the factory and atomically swaps it into the interceptor's reference (a `volatile RateLimiter` field or an `AtomicReference<RateLimiter>`). In-flight requests continue against the old instance; new requests pick up the new one. This avoids any "half-applied config" window and requires no global lock.

Validation belongs in the builder, not at use time. A policy with `limit = 0` or `windowMillis = -1` should fail fast at load time with a clear error, never silently degrade to "block everything" or "allow everything" in production. This is defensive configuration: the system should refuse to start with a malformed rate-limit rule rather than discover the misconfiguration during an incident.

## Thread Safety Considerations

### In-Process Concurrency Model

The implementations above use a **per-key striped locking** model: each key's mutable state is wrapped in a small object, and decisions synchronize on that object. This is preferable to a single global lock (which serializes all traffic) and to lock-free atomics alone (which cannot make the multi-step "evict, count, decide" decision atomic). The stripe granularity is the key itself, so contention is proportional to how many threads hit the *same* key simultaneously, not to total traffic.

Two failure modes dominate hand-rolled limiters. The first is **check-then-act without synchronization**: reading the count, comparing to the limit, then incrementing, with no lock between read and write. Under concurrency this admits roughly `threadCount - 1` extra requests per burst, which is exactly when the limit matters most. The second is **double-checked locking done wrong**: publishing a partially-constructed `BucketState` through a non-volatile field so another thread sees a non-null reference but zeroed fields. Using `computeIfAbsent` on `ConcurrentHashMap` sidesteps this entirely because the map guarantees the inserted value is safely published and the function runs at most once per absent key.

A subtle point: `ConcurrentHashMap.computeIfAbsent` can hold a bin lock during the mapping function, so the function must be **fast and side-effect-free** — never do I/O or nested map mutations inside it. Our mapping functions only allocate a small state object, which is safe. If you ever need expensive initialization, compute the value first into a local, then put-if-absent.

### Memory and Eviction

Unbounded `ConcurrentHashMap` growth is the silent killer for per-IP or per-device limiters. A botnet rotating through millions of source IPs will OOM a naive implementation. The production-grade answer is to layer a bounded cache — Caffeine with `maximumSize` and `expireAfterAccess` set to a few times the largest window — on top of the map, or to use a `LinkedHashMap` with `removeEldestEntry` under a lock. Eviction must be tolerant of state being reclaimed mid-use: `tryAcquire` already handles this because `computeIfAbsent` re-creates state on demand, so an evicted key simply starts a fresh bucket on its next request. That is acceptable behavior for a limiter; the worst case is one extra request slips through when an idle key's state is reclaimed and then immediately reused.

## Distributed Locking for Shared State

### Why In-Process Locks Stop Working

The moment you run more than one instance of your service, the per-key `synchronized` blocks guard nothing — each instance has its own `ConcurrentHashMap`, so a key is limited per-instance, not globally. Two instances behind a load balancer each allow `N` requests, so the effective limit is `N * instanceCount`. This is the central correctness problem of distributed rate limiting, and the LLD must address it explicitly rather than hand-waving "use Redis."

### Locking Strategies on Shared State

There are two correctness strategies for shared state, and you should know both because they trade off latency against accuracy.

The first is **optimistic concurrency via compare-and-swap** (Redis `WATCH`/`MULTI` or Lua scripts that read-modify-write atomically server-side). The limiter reads the current counter, computes the new value, and writes it back only if no one changed it in between; on conflict it retries. This avoids holding a lock across the network and scales well, but retry storms under heavy contention can waste Redis CPU and increase tail latency.

The second is **distributed locking** (Redis `SET NX PX` with a fencing token, or Redlock across multiple Redis nodes for fault tolerance). The limiter acquires a per-key lock, reads and mutates state, and releases. This serializes per-key access across instances, giving strict correctness, at the cost of one extra round trip and the lock's TTL window. The TTL must be short (a few hundred milliseconds) to avoid a crashed holder blocking the key forever, and a fencing token (a monotonically increasing lock id) must be included in writes so a slow holder that recovers after its TTL expired cannot stomp on a newer holder's state.

The strong recommendation is to **prefer Lua-scripted atomicity over distributed locks** for rate limiting, because the operations are simple stateless functions (read counter, increment, compare) that fit naturally into a single atomic server-side script and do not need the lock's "holding" semantics. Locks are the right tool when you need to coordinate a *multi-step* critical section; rate limiting almost never does.

## Redis Integration Design

### Atomic Scripts, Not Multi-Call Sequences

The Redis integration's cardinal rule is that the read-modify-write for a single decision must execute as **one atomic server-side operation**. Splitting it into a `GET`, a client-side computation, and a `SET` is incorrect under any concurrency, because two clients can both read the same value and both write `value + 1`, losing an increment. The correct approach is a Lua script executed with `EVAL`; Redis runs scripts atomically, single-threaded, so the entire decision is consistent.

#### Redis Lua Script Atomic Flow

Redis executes a script to completion with no other command interleaving. Instance B's `EVALSHA` is queued and only begins after Instance A's atomic block returns, which is what makes the decision globally consistent across all instances.

```
   Instance A (client)              Redis (single-threaded server)
        │                                  │
        │  EVALSHA(scriptSha, key, args)   │
        │─────────────────────────────────>│
        │                                  │  ┌─────────────────────────┐
        │                                  │  │  ◆ ATOMIC BLOCK START   │  ← no other command
        │                                  │  └─────────────────────────┘    can interleave
        │                                  │           │
        │                                  │           ▼ 1. HMGET key "tokens" "lastRefill"
        │                                  │                    (or seed defaults from ARGV)
        │                                  │           │
        │                                  │           ▼ 2. Compute refill
        │                                  │              elapsed = (now - last) / 1000
        │                                  │              refilled = min(capacity, tokens + elapsed*rate)
        │                                  │           │
        │                                  │           ▼ 3. Decide
        │                                  │              if refilled >= cost:
        │                                  │                  refilled -= cost  → ALLOW {1, refilled, 0}
        │                                  │              else:
        │                                  │                  retry = ceil((cost-refilled)/rate*1000)
        │                                  │                              → DENY  {0, refilled, retry}
        │                                  │           │
        │                                  │           ▼ 4. HMSET key "tokens" refilled "lastRefill" now
        │                                  │              EXPIRE key 300   (≈5× largest window)
        │                                  │  ┌─────────────────────────┐
        │                                  │  │  ◆ ATOMIC BLOCK END     │
        │                                  │  └─────────────────────────┘
        │       [1, remaining, retryMs]    │
        │<─────────────────────────────────│
        │                                  │
   Instance B (client)                     │
        │  EVALSHA(...) while A's block    │  ◀── queued; only starts after A's block ENDs
        │─────────────────────────────────>│      → reads A's committed state, never a stale mid-update
        │       [...]                      │
```

```
-- Token bucket in one script. KEYS[1] = bucket key.
-- ARGV = [capacity, refillRatePerSec, nowMillis, cost]
local state = redis.call("HMGET", KEYS[1], "tokens", "lastRefill")
local tokens = tonumber(state[1]) or tonumber(ARGV[1])
local last = tonumber(state[2]) or tonumber(ARGV[3])
local now = tonumber(ARGV[3])
local refilled = math.min(tonumber(ARGV[1]),
    tokens + ((now - last) / 1000.0) * tonumber(ARGV[2]))
if refilled >= tonumber(ARGV[4]) then
    refilled = refilled - tonumber(ARGV[4])
    redis.call("HMSET", KEYS[1], "tokens", refilled, "lastRefill", now)
    redis.call("EXPIRE", KEYS[1], 300)
    return {1, math.floor(refilled), 0}
else
    local deficit = tonumber(ARGV[4]) - refilled
    local retryMs = math.ceil(deficit / tonumber(ARGV[2]) * 1000)
    redis.call("HMSET", KEYS[1], "tokens", refilled, "lastRefill", now)
    redis.call("EXPIRE", KEYS[1], 300)
    return {0, math.floor(refilled), retryMs}
end
```

The `EXPIRE` is essential: without it, keys for transient clients accumulate forever in Redis. A TTL of roughly 5x the largest window is a safe default; it lets an idle key's state expire and be garbage-collected by Redis while keeping active keys warm.

### The RedisRateLimiter Adapter

The Redis-backed limiter implements the *same* `RateLimiter` interface so the interceptor is unaware of the backend. It serializes the decision into a script call and deserializes the reply into the same immutable `RateLimitResult`. This is a straight adapter — it owns no in-process state, only a connection and a script SHA cache — which keeps instances cheap and lets you create one per policy without concern.

```
public final class RedisRateLimiter implements RateLimiter {
    private final RedisConnection redis;
    private final String scriptSha;        // pre-loaded via SCRIPT LOAD
    private final RateLimitPolicy policy;
    private final Clock clock;

    public RateLimitResult tryAcquire(String key) {
        String redisKey = "rl:" + policy.getPolicyId() + ":" + key;
        List<Long> reply = redis.evalSha(scriptSha,
            List.of(redisKey),
            policy.serializedArgs(clock.currentTimeMillis()));
        boolean allowed = reply.get(0) == 1L;
        return new RateLimitResult(allowed, reply.get(1),
            reply.get(2), policy.getPolicyId(), clock.currentTimeMillis());
    }
}
```

Pre-loading the script with `SCRIPT LOAD` and referencing it by SHA avoids re-sending the script body on every call, cutting bandwidth and parse cost. The failure mode to design for is **Redis unavailability**: a hard choice between fail-open (allow traffic, risk overload downstream) and fail-closed (deny traffic, risk an outage). Most production systems choose fail-open with an alarm and a circuit breaker, because a rate limiter that takes the site down when Redis blips is worse than no limiter. This decision must be explicit in the LLD and wired through a `FallbackPolicy` enum on the limiter, not buried in a catch block.

## Interface Segregation and SOLID Principles Applied

### SOLID Principles — Summary

| Principle | How It Is Applied in This Design |
|---|---|
| **S — Single Responsibility** | Each class has exactly one reason to change: `TokenBucketRateLimiter` (the algorithm), `RateLimiterFactory` (construction wiring), `PolicyRepository` (the configuration source), `RateLimitInterceptor` (the interception mechanics). Co-locating two responsibilities is how a 600-line "RateLimitManager" that everyone is afraid to touch gets born. |
| **O — Open/Closed** | New algorithms are added by writing a new concrete `RateLimiter` and adding one branch to the factory. No existing class is edited, no interface is widened, no call site is touched. The seam is the interface; the extension point is the factory; the closure is the rest of the system being oblivious. |
| **L — Liskov Substitution** | Every concrete limiter honors the behavioral guarantees: `tryAcquire` is deterministic for a given key and time, never throws on a valid key, never returns a `remaining` that exceeds the configured limit, and never mutates state when it returns `allowed == false`. Fail-open behavior is modeled as an explicit `FallbackRateLimiter` decorator, not a hidden contract violation buried inside one implementation. |
| **I — Interface Segregation** | Three narrow interfaces — `RateLimiter` (decision), `RateLimitInspector` (status), `RateLimitAdmin` (reset) — so a Redis-backed read replica can implement only the inspector, a test stub can implement only `RateLimiter`, and no client is ever forced to depend on methods it does not use. |
| **D — Dependency Inversion** | High-level policy — the interceptor, the orchestrator — depends on the `RateLimiter` abstraction, not on `TokenBucketRateLimiter` or `RedisRateLimiter`. `Clock`, `RedisConnection`, and `KeyResolver` are likewise abstractions injected at construction, so the core logic depends on interfaces and concrete infrastructure is injected from the outside. |

### Interface Segregation: Don't Force Capabilities onto All Clients

Not every caller needs every operation. A request handler needs `tryAcquire`; a dashboard needs `getStatus`; an admin tool needs `reset`. Forcing them all through one fat interface couples the dashboard to methods it never calls and tempts implementers to stub methods they do not support. The cleaner split is three segregated interfaces, each narrow enough that an implementation can meaningfully satisfy all of its methods.

```
public interface RateLimiter        { RateLimitResult tryAcquire(String key); }
public interface RateLimitInspector { RateLimitStatus  getStatus(String key); }
public interface RateLimitAdmin     { void reset(String key); void resetAll(); }
```

A class can implement all three when it supports them, but a Redis-backed read replica might implement only `RateLimitInspector` (it cannot authorize writes), and a test stub might implement only `RateLimiter`. Callers depend on the narrowest interface that suffices, which is the Interface Segregation Principle in its purest form: no client should be forced to depend on methods it does not use.

### The Single Responsibility Principle

Each class has one reason to change. `TokenBucketRateLimiter` changes only when the token bucket algorithm changes. `RateLimiterFactory` changes only when construction wiring changes. `PolicyRepository` changes only when the configuration source changes. `RateLimitInterceptor` changes only when the interception mechanics change. Co-locating two of these responsibilities in one class is how you get a 600-line "RateLimitManager" that everyone is afraid to touch.

### The Open/Closed Principle

New algorithms are added by writing a new concrete `RateLimiter` and adding one branch to the factory. No existing class is edited, no interface is widened, no call site is touched. This is the property that lets a team add a leaky-bucket or a sliding-window-counter approximation three months later without a cross-cutting refactor. The seam is the interface; the extension point is the factory; the closure is the rest of the system being oblivious.

### The Liskov Substitution Principle

Every concrete limiter must honor the `RateLimiter` contract's behavioral guarantees: `tryAcquire` is deterministic for a given key and time, never throws on a valid key, never returns a result whose `remaining` exceeds the configured limit, and never mutates state when it returns `allowed == false`. A limiter that "fails open" by returning allowed on internal errors violates LSP because callers written against the interface assume denials are meaningful. If you need fail-open behavior, model it as an explicit `FallbackRateLimiter` decorator that wraps a real limiter and substitutes an allowed result on failure — the substitution is then intentional and visible, not a hidden contract violation buried inside one implementation.

### The Dependency Inversion Principle

High-level policy — the interceptor, the orchestrator — depends on the `RateLimiter` abstraction, not on `TokenBucketRateLimiter` or `RedisRateLimiter`. The `Clock`, `RedisConnection`, and `KeyResolver` are likewise abstractions injected at construction, so the core logic depends on interfaces and the concrete infrastructures are injected from the outside. This is what makes the in-process limiter unit-testable without Redis and the Redis limiter testable with a fake connection.

## Composing Limiters: Stacking Policies

Real systems rarely apply a single limit. A request is subject to a per-user limit *and* a per-endpoint limit *and* a global safety limit, and a denial from any one must reject. This is the **composite rate limiter**, a list of child limiters evaluated in order, returning the most restrictive result.

#### Composite Rate Limiter Stacking Flow

Children are ordered most-selective-first so the first denial short-circuits and saves work on the children most likely to admit. When all children admit, the retry hints are merged to the largest (most restrictive) value so the caller backs off long enough for every policy to recover.

```
                                  Request (key = userId + endpoint)
                                              │
                                              ▼
                       ┌────────────────────────────────────────────┐
                       │        CompositeRateLimiter                 │
                       │        <<implements RateLimiter>>           │
                       │        ─────────────────────────────────    │
                       │        children (ordered, most-selective    │
                       │         first):                             │
                       └───────────────────┬────────────────────────┘
                                           │ tryAcquire(key)
            ┌──────────────────────────────┼──────────────────────────────┐
            ▼                              ▼                              ▼
   ┌───────────────────┐         ┌───────────────────┐         ┌───────────────────┐
   │  Per-User         │         │  Per-Endpoint     │         │  Global Safety    │
   │  Limiter          │         │  Limiter          │         │  Limiter          │
   │  (token bucket)   │         │  (sliding window) │         │  (fixed window)   │
   └─────────┬─────────┘         └─────────┬─────────┘         └─────────┬─────────┘
             │                             │                             │
             │ result                      │ result                      │ result
             ▼                             ▼                             ▼
        allowed?                       allowed?                       allowed?
        │                              │                              │
   NO → return r (short-circuit)  NO → return r (short-circuit)  NO → return r (short-circuit)
   YES → keep r, continue         YES → keep r, continue         YES → keep r, continue
        │                              │                              │
        └──────────────┬───────────────┘──────────────────────────────┘
                       │ all children allowed
                       ▼
            merge retryAfterMillis across kept results
            → pick the LARGEST (most restrictive) hint
                       │
                       ▼
            return final RateLimitResult (allowed=true, most-restrictive retry hint)

   Note: a child can itself be a CompositeRateLimiter (e.g. a per-tenant composite
   nested inside the global composite) → Composite pattern on top of Strategy,
   turning "one algorithm per request" into "a policy graph per request" with no
   special-case code and no interface change.
```

```
public final class CompositeRateLimiter implements RateLimiter {
    private final List<RateLimiter> children;   // ordered most-selective to least
    public RateLimitResult tryAcquire(String key) {
        RateLimitResult mostRestrictive = null;
        for (RateLimiter child : children) {
            RateLimitResult r = child.tryAcquire(key);
            if (!r.isAllowed()) return r;                 // short-circuit on first deny
            if (mostRestrictive == null ||
                r.getRetryAfterMillis() > mostRestrictive.getRetryAfterMillis())
                mostRestrictive = r;
        }
        return mostRestrictive;                            // all allowed; merge hints
    }
}
```

Two design notes: ordering children most-selective-first short-circuits on the limiter most likely to deny, saving work; and `CompositeRateLimiter` is itself a `RateLimiter`, so composites can nest (a per-tenant composite inside a global composite) without any special-case code. This is the Composite pattern layered on the Strategy pattern, and it is the mechanism that turns "one algorithm per request" into "a policy graph per request" without breaking the interface.

## Code Structure and Package Organization

Package structure should make the seams visible: interfaces at the top, implementations grouped by concern, infrastructure behind its own boundary. A clean layout looks like this:

```
com.acme.ratelimit/
  api/              RateLimiter, RateLimitResult, RateLimitStatus, RateLimitAdmin
  policy/           RateLimitPolicy, Algorithm enum, KeyStrategy, PolicyRepository
  factory/          RateLimiterFactory
  core/             TokenBucketRateLimiter, SlidingWindowRateLimiter,
                    FixedWindowRateLimiter, CompositeRateLimiter
  storage/          RedisRateLimiter, RedisConnection, LuaScripts
  web/              RateLimitInterceptor, KeyResolver impls, 429 exception mapper
  metrics/          RateLimitMetrics, Micrometer bindings
  test/             unit tests, fakes, Clock stub, RedisTestContainer
```

The `api` package depends on nothing. `core` depends only on `api` and `policy`. `storage` depends on `api`, `policy`, and a Redis client. `web` depends on `api` and the web framework. This layered dependency graph means you can compile and unit-test `core` with zero infrastructure, and the only place concrete Redis classes appear is behind the `storage` boundary. Enforcing this with a tool like ArchUnit or Checkstyle's import-control prevents the slow rot where an implementation accidentally imports a web class.

## Sequence Diagrams

### Local Single-Limiter Sequence

The request path through an in-process limiter, showing the lazy-refill and per-key lock interaction:

```
Client          Interceptor        TokenBucketLimiter        ConcurrentHashMap        BucketState
  |  POST /api      |                     |                       |                       |
  |---------------->|                     |                       |                       |
  |                 | tryAcquire(userId)  |                       |                       |
  |                 |-------------------->|                       |                       |
  |                 |                     | computeIfAbsent(key)  |                       |
  |                 |                     |---------------------->|                       |
  |                 |                     |       BucketState     |                       |
  |                 |                     |<----------------------|                       |
  |                 |                     | synchronized(state)   |                       |
  |                 |                     |-----------------------|---------------------->|
  |                 |                     |                       |  refill + consume     |
  |                 |                     |       Result(allowed) |<----------------------|
  |                 |       Result        |<----------------------|                       |
  |                 |<--------------------|                       |                       |
  |    200 OK       |                     |                       |                       |
  |<----------------|                     |                       |                       |
```

The important property is that the lock is held only on `BucketState`, for the duration of the arithmetic, and the map's own bin lock is released as soon as `computeIfAbsent` returns. Distinct keys never contend on the same monitor.

### Distributed Redis Sequence

The distributed path replaces the in-process map with a single round-trip script evaluation. The interceptor is identical; only the limiter's internals change.

```
Client      Interceptor     RedisRateLimiter         Redis (Lua, atomic)        Downstream
  |  POST       |                 |                       |                         |
  |------------>|                 |                       |                         |
  |             | tryAcquire(key) |                       |                         |
  |             |---------------->|                       |                         |
  |             |                 | EVALSHA(sha, key,args)|                         |
  |             |                 |---------------------->|                         |
  |             |                 |                       | HMGET + refill + EXPIRE |
  |             |                 |     [1, remaining, 0] |                         |
  |             |                 |<----------------------|                         |
  |             |      Result     |                       |                         |
  |             |<----------------|                       |                         |
  |             |  chain.proceed()|                       |                         |
  |             |------------------------------------------------->|            |
  |             |                         200 OK                                |
  |<------------|                                                          |<----|
```

If Redis is unreachable, the limiter consults its `FallbackPolicy`: fail-open returns an allowed result and emits an alarm; fail-closed returns a 503-class denial. The diagram hides this branch, but the code path is mandatory — an unhandled Redis exception in `tryAcquire` is a production bug.

## Unit Testing Strategy

### Testability Built into the Design

Two design choices make the limiter cheaply testable. First, `Clock` is an injected abstraction, so tests drive time forward without `Thread.sleep`, which is the difference between a suite that runs in 200ms and one that runs in 20 seconds. Second, the in-process limiters depend on no infrastructure, so they test as pure logic. A `MutableClock` implementation with `advanceMillis(long)` lets a test simulate window rollovers, token refills, and boundary bursts deterministically.

### The Test Matrix

The unit test matrix has three orthogonal axes. Each axis is exercised as a distinct set of steps so a regression in one dimension does not hide behind a pass in another.

- **Algorithm axis** — verify each limiter in isolation:
  - Allow requests up to the configured limit.
  - Deny the request immediately beyond the limit.
  - Recover correctly after the window/refill period elapses (advance the `MutableClock`).
  - Report correct `remaining` and `retryAfterMillis` on both allow and deny paths.
  - Return `remaining` that never exceeds the configured limit (LSP check).
- **Concurrency axis** — verify atomicity under contention:
  - Spin up `N` threads (e.g. 16), each calling `tryAcquire` `M` times (e.g. 1000) against the *same* key.
  - Collect admissions into a single `AtomicInteger`.
  - Await all futures and shut down the pool.
  - Assert exactly `limit` admissions — no more, no less — which is the test that catches check-then-act races.
- **Composition axis** — verify the composite behaves correctly:
  - Short-circuit and return on the first child that denies.
  - Continue to the next child only while every prior child admitted.
  - Merge `retryAfterMillis` across all admitting children and return the largest (most restrictive) hint.
  - Nest a composite inside a composite and confirm the interface is unchanged.

```
@Test void tokenBucket_admitsExactlyCapacityUnderConcurrency() throws Exception {
    MutableClock clock = new MutableClock();
    TokenBucketRateLimiter lb = new TokenBucketRateLimiter(
        TokenBucketConfig.builder().capacity(100).refillRatePerSec(0).build(), clock);
    ExecutorService pool = Executors.newFixedThreadPool(16);
    AtomicInteger allowed = new AtomicInteger();
    List<Future<?>> futs = new ArrayList<>();
    for (int i = 0; i < 16; i++) futs.add(pool.submit(() ->
        IntStream.range(0, 1000).forEach(j -> { if (lb.tryAcquire("k").isAllowed()) allowed.incrementAndGet(); })));
    for (Future<?> f : futs) f.get();
    pool.shutdown();
    assertEquals(100, allowed.get(), "must not exceed capacity under contention");
}
```

The Redis-backed limiter is tested against a real Redis via Testcontainers, not a mock, because the correctness property lives in the Lua script's atomicity and a mock cannot validate that. The script itself is also unit-tested by loading it into the container and asserting edge cases: empty bucket, exact refill to capacity, boundary at `now == windowStart`, and idempotent re-evaluation. Fuzzing the script with random `now` sequences is a cheap way to catch non-monotonic-time bugs that unit tests with fixed clocks miss.

## Extensibility for New Algorithms

The design is extensible by construction. Adding a new algorithm — say, a leaky bucket with a queue, or a sliding-window-counter approximation — is a four-step process that touches no existing production code:

1. **Write the strategy class** — implement `RateLimiter` (and `RateLimitInspector` if it can answer status cheaply); keep all state representation inside the class.
2. **Register it in the factory** — add an enum value to `Algorithm` and a builder branch to `RateLimiterFactory.create()` that wires the new config type.
3. **Extend the policy descriptor** — add the new algorithm's fields to `RateLimitPolicy` with sensible defaults so existing configs still parse and validation fails fast on malformed values.
4. **Add the algorithm to the test matrix** — cover it on the algorithm axis, the concurrency axis, and (if distributed) the Redis script-edge-case suite.

The interface does not change, the interceptor does not change, the Redis adapter does not change. This low-friction extension is the payoff of the strategy and factory patterns combined with interface segregation. A team that has to edit five files and re-review the interceptor to add a limiter will simply not add one; a team that adds one self-contained class and one factory branch will. The LLD's job is to make the second team's path the obvious one.

## Common Pitfalls

The most common pitfall is **treating the rate limiter as a single global singleton with one algorithm hard-coded**. This passes a code review because it "works," but it couples limiting policy to deployment topology, makes per-endpoint limits impossible without code changes, and forces every team through the same algorithm even when their traffic shapes differ. The fix is the pattern set above: interface + strategy + factory + per-policy instances, with the singleton replaced by a `PolicyRepository` that hands out the right limiter for the right scope.

The second pitfall is **non-atomic distributed decisions** — splitting the Redis read, computation, and write into separate calls and reasoning that "it's mostly fine." It is mostly fine right up until a traffic spike, at which point the limit leaks by the number of concurrent clients and the downstream service gets exactly the burst you built the limiter to prevent. The fix is a single `EVAL` script, always, with no exceptions for "simple" cases.

The third pitfall is **ignoring clock skew and non-monotonic time**. Using `System.currentTimeMillis()` for refill math across instances with skewed clocks, or wall-clock jumps from NTP corrections, can produce negative elapsed times and either stall or flood a limiter. Inject a `Clock` that documents monotonicity guarantees, and in the distributed case key all time on the Redis server's `TIME` command so there is a single authoritative clock.

The fourth pitfall is **failing to design the failure mode**. A rate limiter that throws on Redis timeout and propagates a 500 to the client is, in effect, a self-inflicted DoS amplifier. Decide fail-open vs fail-closed explicitly per policy, wire it through a decorator, emit a metric on fallback, and test the fallback path as deliberately as the happy path.

## Interview Question

**Question:** "You implemented token bucket with a per-key `synchronized` block. Now we scale to twenty instances and move the state to Redis. Walk me through exactly what changes in your code, what stays the same, and where the correctness guarantees now come from. Then tell me what happens to a request in flight when Redis becomes unreachable for two seconds."

**Model Answer:** "At the interface level nothing changes — `RateLimiter.tryAcquire` has the same signature, the `RateLimitInterceptor` is untouched, and the immutable `RateLimitResult` still flows back to the caller. What changes is the implementation behind the factory: `RateLimiterFactory.createDistributed(policy)` returns a `RedisRateLimiter` instead of a `TokenBucketRateLimiter`. That adapter owns no in-process state; it serializes the same read-refill-consume logic into a Lua script and sends it with `EVALSHA` against a key namespaced by policy id and the resolved key. The correctness guarantee moves from the JVM monitor on `BucketState` to Redis's single-threaded, atomic script execution — the entire decision runs server-side with no client-visible intermediate states, so two instances hitting the same key cannot interleave and double-admit. I lose the per-key lock locality, so I pay one Redis round trip per decision, but I gain a globally consistent limit across all twenty instances. The `EXPIRE` in the script bounds Redis memory; the `SCRIPT LOAD` + SHA reference avoids resending the body.

"For the failure case, I do not let a Redis exception escape `tryAcquire`. Each policy carries a `FallbackPolicy`. For most external-facing endpoints I choose fail-open: the limiter catches the Redis error, emits a `ratelimit.fallback.open` counter and a warning log, and returns an allowed `RateLimitResult` so the request proceeds to the downstream. For high-value or abusive endpoints I choose fail-closed, returning a 503-class denial. In flight, a request that already got an allowed result before the outage is unaffected — it proceeds downstream and the response is on the downstream service. A request that calls `tryAcquire` during the outage takes the fallback branch synchronously. The two-second blip is visible as a spike in the fallback metric, which pages the on-call to investigate Redis; it does not take the application down, which is the design goal. I would also put a circuit breaker around the Redis client so that during a sustained outage the limiter stops paying the timeout cost on every request and fails fast in the chosen direction."

## Further Reading

- [[Rate Limiter]] — the high-level design companion: algorithm trade-offs, distributed architecture, capacity sizing.
- [[Consistent Hashing]] — relevant when sharding rate-limit state across many Redis instances by key.
- [[Circuit Breakers & Bulkheads]] — the fail-open/fail-closed and timeout patterns overlap heavily with limiter fallback design.
- [[Distributed Cache (Redis-Memcached)]] — Lua scripting, eviction, and Redis operational concerns in depth.
- [[Concurrency Patterns]] — striped locks, compare-and-swap, and safe publication underpin the in-process guarantees.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- LLD rate limiter = data structure design, not system architecture. Focus on thread safety, memory, and correctness
- Token bucket: atomic counter + last refill timestamp. O(1) per check. Use CAS (compare-and-swap) for lock-free updates
- Sliding window counter: two counters (current + previous window) with weighted interpolation. O(1) memory per key
- For concurrency: use striped locks (lock per key hash bucket) to avoid global contention
- Distributed: Redis sorted set for sliding window log, Lua script for atomic check-and-increment

**Common Follow-Up Questions:**
- "How do you make the token bucket thread-safe without locks?" — Use AtomicInteger/AtomicLong with CAS loop. Read current tokens and timestamp, compute new values, CAS — retry on failure.
- "What's the memory overhead of per-user rate limit state?" — Token bucket: 16 bytes (tokens + timestamp) per key. 1M keys = 16MB. Sliding window log: O(n) per key — much more.

**Gotcha:**
- Using `synchronized` on the entire rate limiter creates a global bottleneck. The fix is striped locks (array of locks, pick by key hash) or per-key lock-free CAS. Candidates who propose a single lock fail the LLD round.
