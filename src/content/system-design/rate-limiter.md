---
title: "Rate Limiter"
type: system-design
category: Basics
date: 2026-04-25
difficulty: "intermediate"
read_time: 20
listen_time: 28
tags: [system-design, interview, basics, rate-limiting, distributed-systems, api-gateway]
---

# Rate Limiter

## Summary & Interview Framing

A system that controls request rate to protect services from overload, using algorithms like token bucket, sliding window, and fixed window at the API gateway level.

**How it's asked:** "Design a distributed rate limiter for an API gateway handling 500K RPS across 3 regions. Choose the algorithm, handle clock skew, and ensure per-user limits are enforced globally."

## Overview

A rate limiter is a mechanism that controls the rate at which a client or source can issue requests against a service within a defined time window. It is the first line of defense against abuse, whether accidental (a misconfigured retry loop in a partner's cron job) or intentional (a credential-stuffing botnet, a scraper harvesting prices, a volumetric DDoS attack). Beyond pure protection, a well-designed rate limiter enforces fairness across tenants, keeps cost predictable when upstream providers bill per call, and gives operators a graceful degradation story under load: instead of the service collapsing under its own queue depth, the limiter rejects excess traffic early and keeps the system alive for the requests it does accept. At staff level, the interesting work is not "should we rate limit" — almost every public-facing API must — but choosing the right algorithm, the right keying dimension, the right enforcement tier, and a distributed implementation that is correct under contention without becoming the new bottleneck.

## Throttling vs Rate Limiting vs Load Shedding

These three terms are often used interchangeably but describe distinct behaviors, and conflating them in an interview signals shallow understanding.

| Mechanism | Scope | Trigger | Purpose |
|-----------|-------|---------|---------|
| Rate Limiting | Per-client | Nth request exceeds quota | Admission control against a configured quota |
| Throttling | Per-client | Client has exceeded limit | Shape behavior: slow down, degrade, retry-after |
| Load Shedding | Global | System overloaded (p99, queue depth, dependency failure) | System survival; protect critical capacity |

Rate limiting is a policy mechanism: it decides whether the Nth request in a window is allowed, based on a counter or token budget assigned to some identity. It is fundamentally about admission control against a configured quota. Throttling is a consequence or strategy layered on top: when a client exceeds its limit, the system can throttle that client by slowing it down — for example, by inserting deliberate delays (the "503 with Retry-After" pattern), by returning a queue position, or by degrading the response (returning a cached or lower-fidelity result) instead of hard-rejecting. Throttling is the softer, behavior-shaping cousin of a hard 429. Load shedding is something else again: it is a system-survival action taken when the service itself is overloaded, independent of any per-client quota. When latency p99 crosses a threshold, when a downstream dependency is failing, or when queue depth exceeds a safety margin, the service proactively drops or fast-fails work — even for clients well within their rate limit — to protect critical capacity.

A good design uses all three: rate limiting for fairness and quota, throttling to shape client behavior politely, and load shedding as the last-resort circuit breaker that prioritizes keeping the system alive over serving every request. The key distinction interviewers probe is that rate limiting is per-client and policy-driven, while load shedding is global and capacity-driven.

## Core Algorithms

The choice of algorithm determines what traffic shape you can enforce, how much state you keep, and how the limiter behaves at boundaries and under bursts. Each makes a different trade-off between precision, memory, and burst tolerance.

### Algorithm Comparison

| Algorithm | Burst Tolerance | Memory | Precision | Boundary Issue | Best For |
|-----------|----------------|--------|-----------|----------------|----------|
| Token Bucket | High (up to capacity) | O(1) | Smooth, lazy refill | None | General API gateways (AWS, Stripe, GitHub) |
| Leaky Bucket | Low (queues bursts) | O(queue size) | Strict constant outflow | None | Downstream smoothing, strict no-spike targets |
| Fixed Window | None within window | O(1) | Counter | 2x burst at seam | Low-stakes APIs, trivial Redis impl |
| Sliding Window Log | Bounded | O(N) | Exact | None | Low-throughput precision needs |
| Sliding Window Counter | Bounded | O(1) | Conservative approx | None | High-throughput production (Cloudflare, Redis) |

### Token Bucket

The token bucket is the most widely deployed algorithm in production API gateways (AWS API Gateway, Stripe, GitHub all use variants of it). Each identity — a user, an IP, an API key — owns a logical bucket with a maximum capacity of tokens and a steady refill rate. Tokens are added to the bucket at the refill rate continuously (or in discrete ticks computed lazily), up to the capacity ceiling; any overflow is discarded. Each incoming request consumes one token; if the bucket has at least one token the request is admitted, and if it is empty the request is rejected (or queued/throttled).

```
           Token Bucket  (capacity = 5, refill = 2 tokens/sec)

   refill ──►  ● ● ● ● ●          ← tokens accumulate up to capacity
              █████████░░          (5/5 full; overflow discarded)
              └──────┬──────┘
                     │  lazy refill on each request:
                     │  tokens = min(capacity, tokens + Δt * rate)
                     ▼
   request ─────► [ consume 1 token? ]
                      ├── token available ──► ADMIT
                      └── bucket empty    ──► REJECT / 429
```

The crucial property is burst tolerance: because the bucket can accumulate up to capacity tokens during idle periods, a client can issue a short burst of `capacity` requests instantly, then settle into the steady `refill_rate` rate. This models real API traffic well, where clients often batch requests at startup or on a user action and then go quiet. Refill is typically computed lazily on each request: `tokens = min(capacity, tokens + (now - last_refill) * rate)`, which avoids a background timer per bucket and makes the algorithm O(1) in memory and compute per request.

Configuration parameters:

- **capacity** — maximum tokens the bucket can hold; maps to "how big a burst"
- **refill_rate** — tokens added per second; maps to "what sustained rate"
- **tokens** — current count, decremented per request, refilled lazily
- **last_refill** — timestamp of last refill computation (avoids per-bucket timers)

The two parameters — capacity and refill rate — map intuitively to "how big a burst" and "what sustained rate," which is why product and API teams find this model easy to reason about.

### Leaky Bucket

The leaky bucket is the dual of the token bucket and is best understood as a smoothing queue. Requests arrive into a FIFO queue of fixed size; the queue "leaks" (processes) at a constant outflow rate. If the queue is full, new arrivals are dropped. Where token bucket allows a burst up to capacity and then enforces an average rate, leaky bucket enforces a strictly constant output rate regardless of input spikes — it transforms bursty traffic into a smooth stream. This makes it ideal for protecting downstream systems that cannot tolerate spikes at all, such as a legacy database with a fixed connection pool, or an upstream partner API that bills per-second concurrency. The trade-off is that legitimate bursts incur queueing latency, and under sustained overload the queue fills and every subsequent request is rejected until the queue drains, so the client sees all-or-nothing behavior rather than the token bucket's "burst then steady" cadence. Leaky bucket is also the conceptual basis for the Guzzle-style concurrency limiter and for traffic shaping in network equipment; in API design it is less common than token bucket but appears wherever strict smoothing is the goal.

### Fixed Window

Fixed window is the simplest counter-based algorithm. The timeline is divided into fixed, non-overlapping windows — typically aligned to clock boundaries (the minute starting at 12:00:00, the minute starting at 12:01:00). A per-identity counter is incremented for each request; when the counter exceeds the limit, further requests in that window are rejected. The counter resets to zero at the start of each new window. The appeal is extreme simplicity: one integer per identity per window, O(1) increment, trivial to implement in Redis with `INCR` and a TTL. The well-known flaw is boundary burst: if the limit is 100 requests per minute, a client can issue 100 requests at 11:59:59 and another 100 at 12:00:00, delivering 200 requests in one second across the window seam. For many low-stakes APIs this is acceptable, but for anything where a 2x burst at the boundary is dangerous (a payment API, an inference endpoint with a GPU cost), fixed window is the wrong choice. It also has a reset-time cliff: a client that exhausts its quota at 11:59:01 gets a fresh full quota one second later, which can produce a synchronized thundering herd at minute boundaries if many clients align on the same window.

### Sliding Window

Sliding window eliminates the boundary-burst problem by avoiding fixed reset points. There are two implementations worth knowing.

```
   Sliding Window LOG  (precise, O(N) memory/time per request)

   timeline ──────────────────────────────────────────►
           |<──────────  window (60s)  ──────────>|
     ●     ●    ●     ●         ●        ●     ●      ← stored timestamps
     t=0   t=5  t=10  t=20      t=40     t=55  t=60

   on each request: drop timestamps older than (now - window),
                    count remaining, admit only if count < limit.


   Sliding Window COUNTER  (approx, O(1) memory, two counters)

   timeline ──────────────────────────────────────────►
          |<── prev window ──>|<── curr window ──>|
          t-60            t=0  t=now (30% in)
          count_prev = 80      count_curr = 25

   effective = count_curr + count_prev * (1 - position)
             = 25 + 80 * (1 - 0.30)
             = 25 + 56 = 81
```

The first is sliding window log: keep a timestamped list of every request in the current window, and on each new request drop timestamps older than the window length, count the remainder, and admit only if the count is under the limit. This is precise but costs O(N) memory and time per request where N is the number of requests in the window, which is unacceptable at high throughput. The second and far more common implementation is sliding window counter, which approximates the sliding window by combining two adjacent fixed windows weighted by position. If the current time is 30% into the current minute, the effective count is `count_current_window + count_previous_window * (1 - 0.30)`. This gives a smooth, bounded estimate that never allows more than the limit across any real sliding window, costs only two counters per identity, and is the algorithm most production "sliding window" rate limiters actually run (Redis's own sliding-window-cell and the Cloudflare limiter use this approach). The approximation is conservative enough for virtually all API use cases and avoids the memory blowup of the log variant.

## Distributed Rate Limiting

A single-node rate limiter is trivial: an in-process map of counters or token buckets guarded by a mutex. The hard problem is enforcing a global limit across a fleet of API servers, because each node only sees the slice of traffic routed to it, and naive per-node limits compound (a 1000-rpm global limit split across 10 nodes becomes 10,000 rpm in practice). There are two dominant architectures for distributed rate limiting, plus a hybrid.

```
                     Distributed Rate Limiting Architecture

                          ┌──────────────────────────┐
                          │     Redis Cluster         │
                          │   (sharded by identity)   │
                          │   Lua EVAL = atomic       │
                          │   read-modify-write       │
                          └─────────────┬────────────┘
                   refill / reconcile    │   check (hot path)
              ┌──────────────────────────┼──────────────────────────┐
              │                          │                          │
       ┌──────▼───────┐           ┌──────▼───────┐           ┌──────▼───────┐
       │  API node 1  │           │  API node 2  │           │  API node N  │
       │  local sub-  │           │  local sub-  │           │  local sub-  │
       │  bucket/key  │           │  bucket/key  │           │  bucket/key  │
       └──────┬───────┘           └──────┬───────┘           └──────┬───────┘
              │                          │                          │
              ▼                          ▼                          ▼
          client A                   client B                   client C

   Common path: request → local sub-bucket (in-process) → admit/reject.
   Periodic path: every ~100ms each node refills from Redis + reconciles.
   Most requests never hit Redis; Redis only owns global correctness.
```

### Redis-Based Centralized Limiter

The most common production pattern is a shared Redis (or Redis Cluster) instance holding the counters, with every API node issuing a read-modify-write to Redis on each request. The canonical implementation is the token bucket or sliding window counter expressed as a small Lua script executed atomically inside Redis via `EVAL`: the script reads the bucket, applies refill or window math, decrements or increments, writes back, and returns the remaining budget and reset time. Doing this in a Lua script is essential because Redis executes Lua atomically, eliminating the race where two concurrent requests both read an empty bucket and both admit. The cost is one Redis round-trip per request, typically 0.3–1ms in-region, which is acceptable for most APIs but becomes the dominant latency term for very fast endpoints. Redis Cluster shards by key so the limiter scales horizontally with the number of identities, but a single hot identity's bucket is still single-threaded on one shard — a client hammering one key can saturate a Redis core. Mitigations include local pre-checks (a small per-node token sub-bucket refilled periodically from Redis, so most requests never hit Redis) and consistent-hashing the limiter across multiple Redis instances by key prefix.

### Token Server / Dedicated Limiter Service

For very high throughput or when Redis round-trips are too costly, teams run a dedicated rate limiter service — a cluster of stateful nodes, each owning a shard of the identity space by consistent hash, holding buckets in memory. API nodes make a fast RPC (often gRPC or a custom UDP/TCP protocol) to the limiter service, which responds in well under a millisecond since the state is hot in RAM. This is the architecture used by large platforms (Twitter's limiter, Lyft's ratelimit open-source service, Google's internal limiter infrastructure). The trade-off is operational complexity: the limiter service is now a stateful system that must replicate or accept some loss on node failure, must be sized for the peak request rate, and becomes a hard dependency — if the limiter is down, every API call is blocked unless you implement a fail-open fallback. Many designs pin the limiter service to the same racks or availability zones as the API nodes and use local sub-buckets to absorb the majority of checks, calling the central service only for refill and reconciliation, which gets the failure domain small and the common-case latency to near zero.

### The Fail-Open vs Fail-Closed Decision

When the limiter dependency is unavailable, you must choose: fail open (admit all traffic, risking overload) or fail closed (reject all traffic, causing an outage of your own making).

- **Fail open** — admit all traffic when the limiter is down. Preferred for non-critical/read endpoints; a brief period without rate limiting is better than a total outage, and downstream load shedding plus per-node soft limits provide a backstop.
- **Fail closed** — reject all traffic when the limiter is down. Preferred for payment, fraud, and security-sensitive endpoints where the inability to enforce a limit is worse than degraded availability.

Most public APIs fail open for non-critical endpoints. Payment, fraud, and security-sensitive endpoints often fail closed, treating the inability to enforce a limit as worse than degraded availability. This is a product and risk decision, not a purely technical one, and stating it explicitly in an interview distinguishes a senior candidate from one who has only read the happy-path docs.

## Enforcement Tier: Client, Server, Gateway

Where the limiter runs shapes its capabilities, cost, and trust model.

| Tier | Location | Context Available | Server Cost | Enforceable? | Role |
|------|----------|-------------------|-------------|--------------|------|
| Client-side | Caller SDK / app | None | Zero | No (advisory) | Reduce 429 noise, partner hygiene |
| Server-side | Application / sidecar | Full (plan tier, endpoint cost, user) | App CPU + limiter RTT | Yes | Nuanced per-user, per-endpoint policy |
| Gateway-level | Reverse proxy / edge / CDN | Path, API key, IP only | Offloaded to infra | Yes | Coarse IP/key limits, absorb easy abuse |

Client-side rate limiting is advisory: the client (an SDK you ship, or the caller's own throttle) counts its own requests and backs off before hitting the server. It is cheap, adds zero server load, and improves the client's own retry hygiene, but it is unenforceable — any client can ignore it, and hostile clients will. It is useful as a first line for well-behaved partners and to reduce 429 noise, never as the actual control. Server-side rate limiting runs inside the application process or a sidecar: the service itself checks the limiter on each request before doing real work. This gives the deepest context — the handler knows the user's plan tier, the endpoint's cost, the request's resource weight — and lets you apply heterogeneous limits (100 rpm for free users, 10,000 rpm for enterprise, 10 rpm for a /search endpoint that hits a GPU). The cost is application CPU and the Redis/limiter round-trip on the hot path. Gateway-level rate limiting runs in the reverse proxy, API gateway, or edge (NGINX with limit_req, AWS API Gateway, Cloudflare, Kong): the limiter rejects before the request ever reaches your origin, which protects the application entirely and offloads the work to infrastructure built for line-rate packet inspection. The limitation is context: the gateway typically knows the path, the API key, and the source IP, but not the user's plan tier or the per-request cost, so gateway limits are coarser and usually serve as the blunt instrument while server-side limits apply the nuanced policy. Mature systems layer all three: client SDKs throttle themselves, the gateway enforces coarse IP and key limits to absorb the easiest abuse, and the application enforces fine-grained per-user, per-endpoint, per-plan limits using full request context.

## Keying Dimension: Per-User, Per-IP, Per-API-Key

The identity you rate limit by determines who gets throttled and how easy it is to evade.

| Dimension | Requires Auth | Evasion Risk | Best For | Weakness |
|-----------|--------------|--------------|----------|----------|
| Per-IP | No | High (botnet rotation, shared NAT) | Anonymous traffic, DDoS protection | Throttles legitimate users behind shared NAT |
| Per-API-Key | Yes (credential) | Medium (key sharing/compromise) | B2B, developer APIs, per-customer quotas | One key may serve many internal services |
| Per-User | Yes (authenticated) | Low (ties to real entity) | App tier, plan-tier policy | Auth must complete before limiter can key |

Per-IP is the default for anonymous traffic and DDoS protection: it requires no authentication, works at the network layer, and is the only option when you have no caller identity. Its fatal weakness is shared-NAT: a university dorm, a corporate office, or a mobile carrier gateway can sit behind one public IP, so a per-IP limit throttles legitimate users collectively because one of them is noisy. It is also trivially evaded by an attacker rotating across a botnet of residential IPs. Per-API-key ties the limit to a credential you issued, so you can set per-customer quotas, attribute abuse to a specific account, and revoke the key. This is the standard for B2B and developer APIs. The evasion risk is key sharing or a compromised key; the operational cost is key management and the fact that one key may be used by many backend services within a customer, so a per-key limit can throttle a customer's own internal cross-talk. Per-user (authenticated user or account) is the highest-signal dimension: it ties limits to a real entity, survives IP rotation and key rotation, and lets you express policy like "1000 rpm per user regardless of how many keys they hold." The cost is that it requires authentication to have completed before the limiter can key correctly, which means the auth check itself is not rate limited by user — a gap usually filled by a per-IP or per-anonymous-token pre-auth limit. The right answer in production is almost always a blend: a per-IP limit on unauthenticated and pre-auth traffic, a per-key limit for partner and developer access, and a per-user limit for the authenticated application tier, applied as a hierarchy so the tightest applicable limit wins.

## Hierarchical Rate Limiting

Real platforms rarely apply a single limit. A user on the Pro plan calling the /generate endpoint through a specific API key may be subject to several limits simultaneously, and a request must pass every level to be admitted — the effective limit is the minimum of all applicable budgets.

```
   Hierarchical Rate Limiting Flow
   (one atomic Lua call checks all levels; min budget wins)

   request arrives
        │
        ▼
   ┌─────────────────────┐
   │  Global account     │   1M req/month   (billing ceiling)
   │  limit              │
   └─────────┬───────────┘
             │ pass?
             ▼
   ┌─────────────────────┐
   │  Per-key limit      │   10,000 rpm     (production key cap)
   └─────────┬───────────┘
             │ pass?
             ▼
   ┌─────────────────────┐
   │  Per-endpoint limit │   /generate = 100 rpm  (expensive endpoint)
   └─────────┬───────────┘
             │ pass?
             ▼
   ┌─────────────────────┐
   │  Per-IP limit       │   500 rpm        (office IP, runaway-script guard)
   └─────────┬───────────┘
             │ pass?
             ▼
        ADMIT  (effective limit = min of all budgets)

   any level fails ──► 429 + Retry-After = most restrictive reset time
   (atomic multi-bucket check prevents token leakage across levels)
```

Hierarchical rate limiting is what lets you combine a billing/quota ceiling, a fairness ceiling, and a safety ceiling without them fighting each other. Implementing it well means computing all applicable limits in a single limiter call (one Lua script that checks and decrements every bucket in the hierarchy atomically, so you don't burn a token at one level and then get rejected at another) and returning the most restrictive reset time in the response headers so the client backs off for the right duration. Without atomic multi-bucket checks, you get token leakage — a request rejected at the /generate level still consumed the account-level token — which distorts billing and customer-visible quotas.

## Adaptive Rate Limiting

Static limits are tuned for a peak load that is a guess. Adaptive rate limiting adjusts the limit in real time based on observed system health, so the service admits more traffic when it is healthy and throttles earlier when it is struggling.

Signals a controller typically consumes:

- p99 latency (and its trend)
- CPU utilization on service nodes
- Queue depth / in-flight request count
- Downstream dependency error rate
- Active connection count

Controller strategies:

- **AIMD loop** (additive increase, multiplicative decrease) — borrowed from TCP congestion control
- **Recomputed-capacity token bucket** — capacity recalculated every few seconds from a moving average of the signals
- **Concurrency limiter** — based on Little's Law: `throughput = concurrency / latency`; estimate max sustainable concurrency, reject when in-flight exceeds it
- **Backpressure-aware limits** — derived from downstream latency degradation

The classic formulation is the concurrency limiter: estimate the service's max sustainable concurrency from `Little's Law (throughput = concurrency / latency)`, measure the current latency, and reject requests when in-flight count exceeds the computed limit — this directly ties admission to the system's actual capacity rather than a pre-set number. Adaptive limiting is what keeps a service alive during partial degradation: when a downstream dependency slows from 50ms to 500ms, the static limiter would keep admitting at the old rate until the queue fills and latency explodes, while the adaptive limiter sees the latency spike and cuts the admission rate by 10x within seconds, keeping the remaining requests fast. The risk is oscillation (the controller overcorrects, throttles too hard, then over-admits), which is why production implementations use smoothing, hysteresis (a deliberate buffer zone where the limit doesn't change immediately, preventing rapid oscillation between over-throttling and over-admitting), and conservative decrease factors.

## Response Headers and Client Contract

A rate limiter that returns a bare 429 is a poor citizen. The HTTP standard (RFC 6585) defines 429 Too Many Requests, and the convention across well-behaved APIs is to accompany it with headers that let the client back off correctly.

Standard response headers:

- `Retry-After` (RFC 7231) — seconds to wait before retrying, as delta-seconds or HTTP-date
- `X-RateLimit-Limit` — total quota for the window
- `X-RateLimit-Remaining` — tokens or count left
- `X-RateLimit-Reset` — epoch second when the window resets and quota replenishes
- `RateLimit-*` / `RateLimit-Policy` (draft, no X- prefix) — standardized, machine-parseable form; the direction the ecosystem is moving

Returning these headers on every response — not just 429s — lets well-behaved clients proactively throttle themselves before hitting the limit, which is strictly better than forcing them to discover the limit by being rejected. Some newer APIs use the draft `RateLimit-*` (without the X- prefix) and `RateLimit-Policy` headers to express the limit and its policy in a standardized, machine-parseable form, which is worth mentioning as the direction the ecosystem is moving. On a 429, the best practice is to also include the limit and reset in the response body for clients that log bodies but not headers, and to use a distinguishable error code so the client can tell a rate-limit 429 from an auth 429 (some APIs return 429 only for rate limits and 403 for quota exhaustion to make the distinction explicit).

## Capacity Estimation

Sizing a rate limiter is a capacity-planning exercise with a few moving parts.

Demand-side inputs:

- Peak requests per second across all identities
- Number of distinct identities (sets memory footprint: each bucket/counter is a Redis key, so 10M users × a few hundred bytes ≈ a few GB)
- Desired burst headroom — capacity is usually 2–10x the sustained rate to absorb legitimate bursts without throttling good clients

Supply-side throughput bounds (slowest of these wins):

- **Limiter node CPU** — in-memory token server: low hundreds of thousands of checks/sec per core
- **Redis shard throughput** — a single Redis core does ~100k ops/sec for small Lua scripts; a 1M rps global limit needs at least 10 shards keyed by identity
- **Network round-trip** — a 0.5ms Redis RTT means a single in-flight check per connection caps you at 2000 rps per connection; need pipelining or connection pooling to go higher

Practical sizing approach:

- Measure the p99 request rate
- Multiply by the number of availability zones you replicate across
- Add 50% headroom for failover (when one zone's limiter dies, survivors absorb its traffic)
- Size the Redis cluster or token-server fleet to that number with CPU headroom below 70%

For the application-side cost, assume one limiter check per request and budget the Redis RTT into your endpoint's latency budget — if your endpoint's SLO is 100ms p99 and the limiter adds 1ms, that is 1% of your budget gone before the handler runs, which matters at tight SLOs and is the reason high-throughput services move the limiter in-process with periodic Redis refill rather than checking Redis per request.

## Putting It Together

A staff-level design for a public API rate limiter usually lands on: token bucket as the core algorithm (burst tolerance matches real traffic), keyed by a hierarchy of IP → API key → user with the tightest limit winning, enforced at the gateway for coarse IP and key limits and at the application for per-user, per-endpoint, and plan-tier limits, backed by a Redis Cluster or dedicated token server sharded by identity, with local sub-buckets on each API node to absorb the majority of checks and avoid a Redis round-trip per request, adaptive capacity adjustments driven by p99 latency and downstream health, and a complete `X-RateLimit-*` plus `Retry-After` response contract. The limiter fails open for read endpoints and fail-closed for write and payment endpoints, with a per-node soft concurrency cap as the load-shedding backstop when the limiter itself is degraded. That is a design you can defend end-to-end: every choice has a reason, every component has a failure mode and a mitigation, and the system degrades gracefully at every layer.

## Interview Question

**Q: You run a multi-tenant SaaS API with 10,000 enterprise customers behind a fleet of 50 API servers. Each customer authenticates with an API key and has a negotiated rpm limit that varies by contract. Design the rate limiting. Specifically: where do you enforce it, what algorithm, how do you keep it correct under a Redis outage, and how do you handle a single customer whose traffic spikes 100x?**

**Model answer:** Enforce at two tiers. At the gateway (NGINX/Kong), apply a coarse per-API-key limit as the blunt instrument — this absorbs the easiest abuse and the 100x spike before it reaches the application. At the application, apply the contractual per-customer limit using a token bucket, because enterprise traffic is bursty (batch jobs, sync runs) and token bucket tolerates bursts up to the negotiated capacity while holding the sustained rate. Back the application limiter with Redis Cluster sharded by API key, using a Lua-script token bucket for atomic read-modify-write. To avoid a Redis round-trip on every request, give each of the 50 API nodes a local sub-bucket per key, refilled every 100ms from Redis: most checks hit the local bucket, and Redis only reconciles and refills periodically, cutting Redis load by ~100x. Under a Redis outage, fail open for read endpoints (a brief period without limiting is better than an outage, and the gateway's coarse limit still applies) and fail closed for write and payment endpoints where the inability to enforce a contractual limit is a compliance problem. For the 100x spike on one customer: the token bucket naturally throttles them once their bucket drains — they get their negotiated burst, then 429s with `Retry-After` set to the bucket refill time. If the spike is so large it threatens the Redis shard that owns that key (a single hot key on one Redis core), the gateway's per-key limit caps it at the edge and the local sub-buckets mean the spike is mostly absorbed in-process without Redis round-trips. If the customer's spike is legitimately higher than their contract, the right answer is a contract conversation, not a technical change — the limiter is enforcing a business agreement.

**Common pitfall:** Reaching for a fixed window counter "because it's simple" and deploying it on a per-node basis (each of 50 nodes applies the full customer limit independently). This compounds to 50x the negotiated limit in practice, and the fixed window allows 2x boundary bursts on top, so a customer contracted for 1,000 rpm can actually push 100,000 rpm at a window seam. The candidate who proposes this has missed both the distributed-correctness problem (limits must be global, not per-node) and the algorithm's boundary flaw. A related pitfall is checking Redis per request with a naive GET-then-SET instead of an atomic Lua script: under concurrency two requests both read 1 remaining token and both admit, leaking 2x the limit. Atomicity is not optional.

## Interview Cheat Sheet

**Key Points to Remember:**
- [[Glossary#Token Bucket|Token bucket]] is the most widely deployed algorithm (AWS, Stripe, GitHub) because it tolerates bursts up to capacity while enforcing a sustained rate — O(1) memory and compute per request.
- Fixed window has a 2x boundary-burst flaw (100 req at 11:59:59 + 100 at 12:00:00 = 200 in one second); sliding window counter fixes this with two adjacent-window counters weighted by position.
- In a distributed system, per-node limits compound (50 nodes × 1000 rpm = 50,000 rpm actual). Use a shared Redis store with atomic Lua scripts (`EVAL`) for the read-modify-write to prevent race conditions where two concurrent requests both read one remaining token and both admit.
- Local sub-buckets on each API node (refilled periodically from Redis) cut Redis load by ~100x — most checks never hit Redis.
- Fail open for read endpoints (brief uncontrolled traffic is better than an outage); fail closed for write/payment endpoints (inability to enforce a limit is a compliance problem).

**Common Follow-Up Questions:**
- *How do you handle a single customer whose traffic spikes 100x?* — The token bucket naturally throttles them once their bucket drains. If the spike threatens the Redis shard owning that key (hot key on one core), the gateway's per-key limit caps it at the edge and local sub-buckets absorb most checks in-process without Redis round-trips. If the spike exceeds their contract, it's a business conversation, not a technical fix.
- *What's the difference between rate limiting, throttling, and load shedding?* — Rate limiting is per-client admission control against a quota. Throttling is the consequence: slowing down or degrading a client who exceeded their limit. Load shedding is a global, system-survival action (dropping work when the service itself is overloaded, regardless of per-client quotas).
- *How do you enforce hierarchical limits (global → per-key → per-endpoint → per-IP)?* — Compute all applicable limits in a single atomic Lua call so you don't burn a token at one level and get rejected at another (token leakage). Return the most restrictive `Retry-After` in the response so the client backs off for the right duration.

**Gotcha:**
- The most common interview mistake is proposing a fixed window counter deployed on a per-node basis. Each of 50 nodes independently applies the full customer limit, compounding to 50x the negotiated limit — and the fixed window allows a 2x boundary burst on top, so a customer contracted for 1,000 rpm can actually push 100,000 rpm. The limiter must be global (shared state in Redis or a token server), and the algorithm must be atomically applied (Lua script, not naive GET-then-SET) to prevent concurrent requests from both admitting when only one token remains.
