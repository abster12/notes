---
title: "CDN & Edge Computing"
category: "Scale"
day: 11
difficulty: "Medium"
read_time: 18
listen_time: 22
tags: ["cdn", "edge-computing", "caching", "anycast", "video-streaming", "performance", "ddos"]
last_updated: "2026-06-19"
---

# CDN & Edge Computing

A Content Delivery Network is a globally distributed fabric of proxy servers whose single purpose is to move bytes closer to the people asking for them. The economics are brutal and simple: a round trip from Mumbai to an origin in us-east-1 is 200–300 ms of network latency before the origin even starts generating a response, while the same request served from an edge point-of-presence (PoP) in Mumbai is 5–20 ms. At scale, that gap is the difference between a product that feels instant and one that users abandon. But a CDN is not a single mechanism — it is the composition of DNS routing, anycast networking, cache key engineering, invalidation policy, edge compute, multi-tier storage, and security controls. Designing with a CDN means making explicit decisions at each of those layers, because the defaults will serve you well until the day they quietly leak personalized data across users or stampede your origin during a launch.

## Summary & Interview Framing

A CDN caches content at geographically distributed edge servers, serving users from the nearest location to reduce latency and origin load. It uses DNS-based routing, anycast networking, cache key engineering, and multi-tier storage to move bytes closer to users, while also absorbing DDoS traffic and offloading work from the origin.

**How it's asked:** "Design a CDN that serves 10M RPS across 50 edge locations with 95% cache hit rate and <50ms latency globally."

## How Request Routing Actually Works

When a user types `https://example.com/assets/logo.png`, the first thing that happens is a DNS resolution, and this is where the CDN inserts itself. The domain's authoritative nameserver — usually delegated to the CDN provider via a CNAME or NS record — does not return a fixed IP. Instead it runs a mapping function that considers the client's EDNS Client Subnet (ECS), the resolver's location, real-time PoP load, link health, and cost, then returns one or more IPs that point at a specific edge PoP. This is fundamentally different from geo-DNS round-robin, which is coarse and oblivious to PoP capacity. Modern CDNs (Akamai, Cloudflare, Fastly, AWS CloudFront) use dense, continuously-updated mapping tables and BGP-aware logic so that a user in São Paulo lands on a São Paulo PoP rather than being shipped to Ashburn. The key insight for interviews is that the CDN does not "know" the user's true location in the packet path — it only knows the recursive resolver's IP unless ECS is enabled, which is why ECS support across resolvers materially improves routing accuracy and is a common follow-up question.

### DNS-Based CDN Routing Flow

```
  User (Mumbai)            Recursive Resolver         CDN Authoritative NS
      |                          |                          |
      |--- example.com --------->|                          |
      |                          |--- query (+ ECS) ------->|
      |                          |                          |
      |                          |    mapping function:     |
      |                          |     - client subnet(ECS) |
      |                          |     - resolver location  |
      |                          |     - PoP load / health  |
      |                          |     - cost / BGP path    |
      |                          |<-- 203.0.113.10 (PoP) ---|
      |<-- 203.0.113.10 ---------|                          |
      |                          |                          |
      |--- HTTPS to 203.0.113.10>|                          |
      v                          v                          v
  [Mumbai Edge PoP]   (anycast IP announced from hundreds of PoPs;
                       BGP shortest-path delivers user to nearest)
```

Anycast is the networking primitive that makes the edge globally reachable from a small number of advertised IPs. The CDN announces the same IP prefix from hundreds of PoPs simultaneously; BGP's shortest-path selection causes each user's traffic to flow to the topologically nearest announcing router. This has three consequences worth naming:

- **Failover is nearly free:** if a PoP drops, its BGP withdrawal makes traffic reroute to the next-nearest within seconds, with no DNS change required.
- **DDoS dispersion is structural:** anycast naturally distributes a volumetric attack across the entire edge surface, because every attacker packet is attracted to its nearest PoP rather than concentrating on one origin pipe — this is the structural reason CDNs are effective DDoS scrubbers.
- **Long-lived TCP is problematic:** anycast is connectionless-friendly but problematic for long-lived TCP sessions, because a route flap mid-connection can hand the flow to a different PoP that has no state for it. For this reason CDNs terminate TCP at the edge and open a fresh connection to the origin (split TCP), so the anycast hop only carries the client-to-edge leg.

## Cache Key Design

The cache key is the single most important and most under-thought design decision in any CDN deployment. A naive key is just the URL path, and that is correct for immutable static assets but catastrophic for anything with personalization. The key is typically constructed from a normalized combination of the scheme, host, path, and a curated subset of query string parameters and headers. The discipline is to include every input that changes the response and exclude every input that does not.

**Cache key rules:**

- **Include** the scheme, host, and path (the base identity of the resource).
- **Include** `Accept-Encoding` when you serve different byte streams for gzip vs br vs identity.
- **Include** `Accept-Language` when you negotiate locale at the origin.
- **Include** the variant header for every token named by `Vary`.
- **Include** a user-identity segment (user ID, or `Vary: Cookie`) only for genuinely per-user content — and accept the low hit ratio as the price of correctness.
- **Exclude** tracking parameters (`utm_*`, `fbclid`, `gclid`) and cache-busters.
- **Exclude** any header or query param the origin ignores — every superfluous key fragment shatters the cache into near-unique shards and tanks your hit ratio.
- **Normalize** before keying: lowercase host, sort query params, strip trailing slashes, so equivalent requests collapse to one key.
- Most providers expose a "cache key normalization" or "ignore query string" setting, and the right configuration is almost never the default.

The failure modes here are symmetric and equally bad:

- **Over-inclusive keys → cross-user data leakage.** If you cache `/api/profile` keyed only on path and the response is user-specific, user A's profile gets served to user B — a security incident, not a performance bug.
- **Under-inclusive keys → cache fragmentation.** If you include a per-request nonce, every request misses.

A staff-level rule is to treat the cache key as a function signature — it must be a pure, minimal function of exactly the inputs that determine the response body. For personalized content the correct move is usually to not cache at the CDN at all, or to cache a shared fragment and personalize at the edge (Edge-Side Includes or edge compute), or to cache per-user with a `Vary: Cookie` or a key segment derived from the user ID — accepting that hit ratio will be low but correctness is preserved. The `Vary` header is the origin's way of telling the CDN "this response depends on this request header," and ignoring it is one of the most common causes of corrupt cached content in production.

## Cache Invalidation: Purge vs TTL

There are only two hard problems in CDNs, and one of them is invalidation. The fundamental tension is that TTL-based expiry is simple, eventually consistent, and free, while explicit purging is immediate, operationally expensive, and racy.

**Invalidation strategies (in order of preference):**

- **Immutable assets + long TTL (best):** set `Cache-Control: max-age=31536000, immutable` for fingerprinted assets like `logo.a1b2c3.png`. You never purge — you publish a new filename and the old one ages out harmlessly. This is the single highest-leverage CDN design choice you can make.
- **Moderate TTL + stale-while-revalidate:** for content that changes on the order of minutes to hours (product page, news article, pricing JSON), a 60–300 s TTL with stale-while-revalidate gives users instant responses while the CDN refreshes in the background, trading bounded staleness for a massive hit-ratio win.
- **Surrogate-key purge (Fastly surrogate keys / Cloudflare cache tags / Akamai CP codes):** tag every object produced by a given backend with a shared key, and on a deploy purge only that key, limiting origin refetch to the affected subset. This is the staff-level answer to "how do you deploy without melting the origin."
- **Purge by URL:** immediate freshness for a single object; use when correctness demands freshness faster than the TTL (a price change, a takedown).
- **stale-if-error:** serve stale when the origin errors so an outage does not become a 500 for users.
- **Never "purge everything":** a global purge during a deploy causes a synchronized cache stampede as every edge re-fetches from origin at once.

Purges propagate through the CDN's control plane, not the data plane, so they are not instant: a global purge across thousands of PoPs typically completes in seconds to low tens of seconds, but during that window some edges will still serve the old object. Purges are also rate-limited at scale. When interviewers ask the canonical "cache invalidation is one of the two hard problems" question, the response they want is: avoid invalidation by design through immutable assets and long TTLs; when you cannot, use surrogate-key purges scoped to the smallest possible object set; and never assume a purge is instantaneous or atomic across the edge.

### Cache Strategies Comparison

| Strategy | When to Use | TTL Behavior | Invalidation | Hit Ratio | Origin Risk |
|---|---|---|---|---|---|
| Immutable + long TTL | Fingerprinted static assets (JS/CSS/images) | 1 yr, `immutable` | New filename; never purge | 95–99% | Near-zero (origin untouched) |
| TTL + stale-while-revalidate | Content changing in minutes–hours (HTML, JSON) | 60–300 s + SWR | Ages out; no purge | High | Bounded QPS (SWR caps refetch) |
| Short per-user TTL | Authenticated, user-scoped reads | 1–30 s, keyed by user ID | Ages out per user | Low–moderate | Moderate (per-user miss rate) |
| Surrogate-key purge | Deploys touching a known object set | Medium TTL | Purge one key on deploy | Recovers fast | Low (scoped refetch only) |
| Purge by URL | Single-object freshness fix (price, takedown) | Any | Explicit, per-URL | Brief dip | Low |
| Purge everything | Avoid except emergencies | Any | Global | Drops to ~0% | **Stampede** — origin hammered |
| No-store / `private` | Authed, user-specific, mutating responses | none | n/a (never cached) | 0% for that path | High if mis-cached: data leakage |
| stale-if-error | Resilience overlay on any cacheable path | Inherits TTL | Serves stale on origin error | Preserved during outage | Graceful degrade, no 500s |

## Origin Shield and Multi-Tier Caching

Without a shield, a cache miss on a popular object produces a thundering herd: 50 edge PoPs around the world all miss simultaneously on the same object and each opens an origin request, so a single viral URL can generate N times the origin load instead of one fetch. An origin shield is an additional caching tier — typically one or two regional CDN PoPs designated as the only nodes allowed to fetch from the origin — that collapses that fan-in. Every edge still misses, but they all miss to the shield, and the shield serves the first object it fetched to all of them. The result is that origin sees at most one request per object per shield region regardless of global edge count. Shields also provide a stable place to enforce origin-side concerns (header rewriting, request normalization, centralized rate limits) and a single point to absorb origin retries.

Multi-tier caching generalizes this idea into a hierarchy: user-facing edges, regional mid-tier caches, a shield, then the origin. Each tier filters requests so that only misses propagate upward, and each tier has its own TTL and eviction policy. The design tradeoff is latency versus origin protection: every tier adds a hop on a miss, but each hop dramatically reduces the load on the layer above. The right depth depends on object popularity distribution and origin cost. For a long-tail catalog where most objects are rarely requested, two tiers (edge + shield) is usually enough; for a small hot set with a fragile origin, three tiers pay for themselves. The same logic applies inside a single PoP: an in-process memory cache (LRU, hottest objects) sits in front of the on-disk CDN cache, which sits in front of the shield, giving a hit path that never touches disk for the top percentile of objects.

### Multi-Tier Cache Topology

```
   Users (global)
     |
     v
 +---------------------+       +---------------------+
 | Edge PoP (Mumbai)   |  ...  | Edge PoP (São Paulo)|
 |  [RAM LRU hot set]  |       |  [RAM LRU hot set]  |
 |  [on-disk cache]    |       |  [on-disk cache]    |
 +---------+-----------+       +---------+-----------+
           | miss                        | miss
           v                             v
   +-----------------+          +-----------------+
   | Regional Mid-   |   ...    | Regional Mid-   |
   | Tier Cache      |          | Tier Cache      |
   +--------+--------+          +--------+--------+
            | miss                       | miss
            v                            v
        +------------------------------------+
        | Origin Shield (1–2 PoPs only)     |
        |  - only node allowed to hit origin|
        |  - header rewrite / rate limits   |
        |  - absorbs origin retries         |
        +-----------------+------------------+
                          | miss (<= 1 fetch per object per region)
                          v
                   +---------------+
                   |    Origin     |
                   +---------------+
```

## Cache Hit Ratio Optimization

Cache hit ratio (CHR) is the metric that determines whether your CDN is saving you money or just adding hops. World-class static-asset deployments run 95–99% CHR; dynamic/API deployments are happy to exceed 50%. The levers, in order of impact, are:

- **Cache key normalization** — drop useless query params and headers (highest impact).
- **TTL tuning** — raise TTLs to the maximum the business tolerates, with stale-while-revalidate for headroom.
- **Popularity-driven pre-warming** — pre-fetch the top decile of objects so the first request is already a hit.
- **Serve stale on error** — `Cache-Control: stale-if-error` so an origin outage does not turn into a 500 for users.
- **Request collapsing (coalescing)** — when N users request the same object during a miss window, the edge forwards a single request to origin and holds the other N–1 open until the response arrives, then serves all of them. This is the per-request analog of an origin shield and is essential for surviving traffic spikes on cold or expiring caches.

Measurement matters as much as tuning. CHR must be measured at the edge, not the origin, and it must be segmented by content type, URL pattern, and PoP, because a global 80% CHR can hide a 30% CHR on your API path that is quietly hammering the origin. Watch the byte hit ratio too: a few large video objects can dominate bandwidth even with a high request CHR, and conversely a long tail of small API calls can produce high request CHR with low bandwidth savings. The failure mode to call out in interviews is the "cache everything" anti-pattern: blindly setting long TTLs on dynamic or personalized content to chase CHR, which produces correctness bugs that are far more expensive than the bandwidth you saved. Hit ratio is a means, not the goal; the goal is correct, fast, cheap responses, in that order.

## Edge Compute: Cloudflare Workers and Lambda@Edge

Edge compute moves application logic from the origin into the PoP, dissolving the latency between "request lands at edge" and "logic runs." The two dominant models are the isolates-based model (Cloudflare Workers, built on V8 isolates; sub-5ms cold starts, no per-request container boot) and the function-at-the-edge model (AWS Lambda@Edge and CloudFront Functions, where Lambda@Edge runs Node/Python functions in regional caches triggered by viewer/origin request/response events, with cold starts in the tens to hundreds of milliseconds). The architectural payoff is that you can do authN/token validation, A/B routing, geo-redirects, header rewriting, bot scoring, response rewriting, and even full request handling (e.g., a Worker that reads from Workers KV and never touches the origin at all) within 20 ms of the user. That shifts the origin's job from "serve every request" to "handle the long tail of requests the edge could not satisfy," which can cut origin compute and load by an order of magnitude.

### Edge Compute Request Flow

```
  Client (Mumbai, 5–20 ms to edge)
    |
    | HTTPS request
    v
  +--------------------------------------------------+
  | Edge PoP  (Cloudflare Worker / Lambda@Edge)      |
  |                                                  |
  |   1. JWT validation against cached JWKS          |
  |   2. Per-IP / per-account rate limit (token-bkt) |
  |   3. A/B routing / geo-redirect                  |
  |   4. WAF rule set (OWASP CRS + custom rules)     |
  |   5. Bot scoring (JA3 TLS fingerprint, headers)  |
  |                                                  |
  |   Fully handleable at edge?                      |
  |     |-- yes --> read edge KV --> respond to user |
  |     |-- no  --> forward verified principal ----->|
  +--------------------------+-----------------------+
                             |
                             v
                      +---------------+
                      |    Origin     |  (only the long tail;
                      |  (us-east-1)  |   unauth traffic never
                      +---------------+   reaches it)
```

The discipline of edge compute is to keep functions small, pure, and stateless-or-edge-stateful. Cold starts, CPU limits, and memory caps are real: Workers get a tight CPU budget measured in milliseconds, Lambda@Edge has stricter limits than regional Lambda and its functions deploy slowly (region by region) with invocation quotas. Edge state must be eventually consistent by nature — Workers KV and similar stores replicate writes across regions in seconds, so you cannot use them for strongly consistent transactions. The right pattern is to use the edge for read-heavy, lateness-tolerant state (config, feature flags, public keys for JWT verification, rate-limit counters) and to keep authoritative writes and strong consistency at the origin. A common staff-level pattern is JWT validation at the edge: the edge holds the JWKS, verifies the signature and expiry, and only forwards a verified principal to the origin, so unauthenticated traffic never reaches your servers — effectively a distributed auth firewall.

## Video Streaming: HLS and DASH

Video is the workload that built the CDN industry, and it is where chunked, cacheable, adaptive-bitrate delivery matters most. HLS (HTTP Live Streaming, Apple) and DASH (Dynamic Adaptive Streaming over HTTP, MPEG) both work the same fundamental way: the video is encoded at multiple bitrates (renditions), each rendition is sliced into small duration segments (commonly 2–10 s, with LL-HLS pushing to sub-1 s), and a manifest file (`.m3u8` for HLS, `.mpd` for DASH) lists the available renditions and segment URLs. The client requests the manifest, picks a rendition based on its bandwidth and buffer, and fetches segments over plain HTTP — which means the entire delivery path is cacheable by any CDN with no special protocol. The CDN caches segments keyed by URL; because segments are immutable once encoded, they get long TTLs and near-100% CHR after the first fetch. The manifest is the only object with freshness concerns, and it is small, so a short TTL on the manifest plus long TTLs on segments is the standard recipe.

### HLS Segment Flow

```
 Client (player)        Edge PoP         Origin Shield      Origin / Encoder
    |                     |                  |                   |
    |-- GET master.m3u8 ->|                  |                   |
    |                     |-- miss? -------->|                   |
    |                     |<-- manifest -----|<-- GET manifest --|
    |<-- master.m3u8 -----|                  |                   |
    |  (lists renditions: |                  |                   |
    |   240p/480p/1080p)  |                  |                   |
    |                     |                  |                   |
    |  choose rendition by bandwidth + buffer                  |
    |                     |                  |                   |
    |-- GET seg-003.ts --->|                  |                   |
    |   (1080p, 4 s)      |-- miss --------->|                   |
    |                     |                 |-- GET seg-003.ts ->|
    |                     |                 |<-- 4 s segment ----|
    |                     |<-- seg (long TTL)|                  |
    |<-- seg-003.ts ------|                  |                   |
    |                     |                  |                   |
    |  next segment (next 2–10 s);           |                   |
    |  adapt bitrate up/down as bw changes   |                   |
    |  ...                                  |                   |
```

Origin shield is almost mandatory for video because of the fan-in problem at scale: a new live segment is requested by every viewer of a stream within seconds of publication, and without a shield each edge would independently fetch the same segment from origin. A single shield collapses that to one origin fetch per segment globally. Capacity planning for video is bandwidth-dominated in a way that web traffic is not: a 1080p stream at 5 Mbps sustained across a million concurrent viewers is ~5 Tbps of egress, and the CDN contract must be sized for peak concurrent streams times peak bitrate times overhead, not for requests per second. CDNs also offer specialized video features — token-signed segment URLs to prevent hotlinking, geo-blocking, DRM integration (FairPlay, Widevine, PlayReady via segmented CENC), and multi-CDN steering for live events where a single provider's regional capacity is insufficient. The interview-worthy nuance is that live and VOD have opposite cache-warming profiles: VOD segments are requested lazily and warm over time, while live segments are requested by everyone at once, so live requires pre-warming or shield collapsing and VOD does not.

## Dynamic Content Acceleration and CDN for APIs

CDNs were born for static content, but a large fraction of modern traffic is dynamic and cannot be cached by URL. Dynamic content acceleration still helps here through mechanisms that do not depend on caching the body:

- **TCP and TLS optimization:** the edge terminates TLS next to the user (one short RTT) and maintains a warm, persistent, TCP-tuned connection pool to the origin over an optimized backbone (Tier-1 routes, BGP optimization, private fiber), so the client does not pay the cross-globe TCP slow-start and TLS handshake costs.
- **Connection reuse and request collapsing at the edge.**
- **Route optimization:** the CDN's backbone may take a path that is shorter in latency than the public internet's BGP-best path, which optimizes for latency rather than hop count.

The net effect is that even uncacheable API calls can be 30–60% faster through a CDN than direct-to-origin, purely from transport-layer gains.

Caching API responses is a legitimate and powerful technique but it demands discipline. The safe cases are idempotent, non-personalized, read-heavy endpoints: a product catalog, a public pricing table, a feature-flag config, a leaderboard, a search results page for a popular query. These can be cached at the edge with short TTLs (1–30 s) and stale-while-revalidate, giving the origin a bounded QPS regardless of client load. The unsafe cases are anything authenticated, anything user-scoped, and any mutating verb (POST/PUT/DELETE must not be cached). The right pattern for authed APIs is to cache only the shared sub-responses and assemble the personalized result at the edge, or to use a short per-user TTL with a key segment derived from the user identity. API CDN also requires correct handling of `Cache-Control` response directives — origins must emit `private` for user-specific responses so the CDN does not cache them, and `no-store` for anything truly uncachable. A frequent production bug is an API gateway defaulting to a cacheable `Cache-Control` on error responses, which then caches 500s at the edge for the TTL duration; always set `no-store` on error paths.

## Security at the Edge: DDoS, WAF, Rate Limiting

The edge is the best place to enforce security because it is where malicious traffic is closest to its source and farthest from your origin. DDoS protection at a CDN is partly structural (anycast spreads volumetric attacks across the global edge surface, so a 100 Gbps attack becomes 1 Gbps per PoP) and partly active (edge scrubbing detects and drops SYN floods, UDP reflection, amplification attacks, and application-layer floods using fingerprinting and behavioral signals). L3/L4 attacks are absorbed almost transparently because the edge terminates TCP; L7 attacks require a WAF and rate limiting. A CDN-based WAF applies managed rule sets (OWASP Core Rule Set, provider-curated signatures) to inspect request bodies, headers, and parameters before traffic reaches the origin, blocking SQL injection, XSS, request smuggling, and known-exploit patterns. The WAF can also run custom rules: block by ASN, by geo, by URI pattern, by header anomaly score.

Rate limiting at the edge is orders of magnitude cheaper than at the origin because the edge sees the full request volume and can reject before any origin work is done. Edge rate limits are typically token-bucket per key (IP, API key, user ID, path) with a configurable window, and at scale they rely on an eventually-consistent edge counter store — meaning a strict global limit is approximate under partition, which is usually acceptable. The design choice is between per-PoP limits (cheap, accurate per PoP, loose globally) and global limits (requires cross-PoP state, stricter, more expensive). For login brute-force and credential-stuffing defense, a per-IP and per-account limit at the edge combined with bot detection (TLS fingerprinting like JA3, header ordering, behavioral signals) is standard.

**Security headers & directives to set at the edge:**

- `Cache-Control: private` — user-specific responses; the CDN must not cache these.
- `Cache-Control: no-store` — truly uncachable responses and all error paths (prevents caching 500s).
- `Cache-Control: max-age=..., immutable` — fingerprinted static assets.
- `Cache-Control: stale-while-revalidate=..., stale-if-error=...` — resilience + freshness headroom.
- `Vary: <header>` — declare every request header the response depends on (Accept-Encoding, Accept-Language, Cookie).
- `Strict-Transport-Security` (HSTS) — force TLS at the edge, before traffic ever reaches origin.
- `Content-Security-Policy` — injected at the edge to govern scripts/resources client-side.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options` / `frame-ancestors` — baseline hardening added centrally.
- `CF-Connecting-IP` / `X-Forwarded-For` — the real client IP when behind the CDN; trust only after CDN validation, since spoofing these headers is a bypass vector.

The pitfall to avoid is relying on the client IP from the TCP source alone when the user is behind the CDN: the real client IP is in `CF-Connecting-IP` / `X-Forwarded-For`, and trusting spoofable headers without the CDN's validation is a bypass vector. The staff-level pattern is defense in depth: edge rate limit for volume, WAF for known attacks, origin-side authorization for correctness, and never let the edge be the only authN boundary for sensitive actions.

## Capacity Planning

CDN capacity planning is fundamentally about peak concurrent demand, object size distribution, and origin resilience, and it is easy to get wrong because the CDN's elastic feel masks a finite underlying network. The core dimensions are:

- **Egress bandwidth** — the dominant cost and the binding constraint for video and large-file workloads.
- **Requests per second** — the binding constraint for API and small-object workloads, and what drives edge CPU under TLS.
- **Connections per second / concurrent connections** — TLS handshake cost.
- **Storage / objects cached** — for disk-bound PoPs.

You plan to peak, not to average: a live sports stream, a product launch, or a Black Friday spike can be 5–20x the daily average, and a CDN contract with committed bandwidth that is sized to average will bill overages at punitive rates or, worse, throttle during the exact minutes you cannot afford to lose. The right planning unit is the 95th or 99th percentile of historical peak plus a growth factor plus a launch-event buffer, and you should validate it with load tests that drive traffic through the actual CDN, not just against the origin.

Origin-side capacity planning is the inverse exercise and the more dangerous one, because the CDN's job is to shield the origin and a misconfigured CDN can invert that protection. The question to answer is: at the worst realistic miss rate, what is the maximum QPS the origin will see, and can it survive that plus a purge stampede plus a regional failover where one shield's worth of traffic shifts to another? Capacity here is origin CPU, database connections, and the rate at which the origin can regenerate objects. A common failure is sizing the origin for "CDN hit ratio is 95%, so origin sees 5% of traffic" and then discovering that a deploy, a purge, or a cache-warming miss drops hit ratio to 60% for five minutes and the origin melts. The disciplined approach is to plan for the degraded case — origin sized for a 50% miss window sustained for the purge duration — and to use origin shields, request coalescing, queue limits, and circuit breakers so that origin overload degrades to stale or queued responses rather than a cascading failure. Multi-CDN is the final capacity lever: steering traffic across two or more CDN providers via DNS (NS1, Cedexis, Akamai's Adaptive Acceleration) lets you absorb single-provider regional saturation and gives you negotiating leverage on price, at the cost of operational complexity in cache warming, purge coordination, and consistent security policy across providers.

---

## Model Answer

**Q: "Design the content delivery for a global platform serving 50M users — static assets, a personalized API, and 1080p live video — with sub-100ms TTFB and a hard requirement that the origin never falls over during a launch. Walk me through the layers."**

A: *"I'd separate the three traffic classes because they have opposite cache profiles. Static assets get fingerprinted filenames, immutable `Cache-Control: max-age=31536000`, and a CDN in front with normalized cache keys that drop tracking query params — this is the 99% hit-ratio layer and it almost never touches the origin. The live video goes through HLS with segments at a 4-second duration, long TTLs on segments and a short TTL on the manifest, behind an origin shield because every viewer requests each new segment within seconds and the shield collapses that fan-in to one origin fetch per segment; I'd size the CDN contract to peak concurrent viewers times 5 Mbps plus overhead, and I'd consider multi-CDN steering for the live event because a single provider's regional capacity can saturate. The personalized API is the interesting part — I would not cache user-specific responses at the edge at all; instead I'd put a Cloudflare Worker at the edge that validates the JWT against a cached JWKS, applies per-IP and per-account rate limits, and forwards only authenticated traffic to the origin. For the shared, non-personalized API paths (catalog, config) I'd cache with a 10-second TTL plus stale-while-revalidate, which caps origin QPS at six per object regardless of client load.*

*For the 'origin never falls over' requirement, the load-bearing decisions are the origin shield, request coalescing at the edge, surrogate-key purges scoped tightly on deploys instead of 'purge all,' and sizing the origin for the degraded miss case — say a 50% miss window for the purge duration — not the steady-state 95% hit case. I'd add stale-if-error so an origin hiccup serves stale instead of 500, and a circuit breaker on the origin path so overload degrades gracefully. Finally I'd put the WAF and DDoS protection at the edge so volumetric and L7 attacks never reach the origin, and I'd load-test by driving traffic through the real CDN, not just the origin, because the failure modes that kill you — cache stampedes, anycast reroutes, shield saturation — only show up end-to-end."*

**Common pitfall:** Saying "put a CDN in front of everything" without (a) distinguishing cacheable from personalized content and specifying the cache key for each, (b) naming the invalidation strategy — immutable assets vs surrogate-key purges vs TTL+SWR — and (c) sizing the origin for the cache-miss and purge-stampede case rather than the steady-state hit ratio. Interviewers are testing whether you understand that a CDN moves load, it does not eliminate it, and that the origin is most exposed exactly when the cache is cold or being invalidated.

## Interview Cheat Sheet

**Key Points to Remember:**
- A CDN moves load closer to users — it does not eliminate load; the origin is most exposed when the cache is cold or being purged.
- The cache key is the single most important design decision: include every input that changes the response, exclude every input that does not, and normalize before keying.
- Prefer immutable assets + long TTL over explicit purging; when you must purge, use surrogate-key purges scoped to the smallest object set — never "purge everything" during a deploy.
- Origin shields and request coalescing collapse fan-in so a viral URL produces one origin fetch, not N; size the origin for the degraded miss case (50% miss), not the steady-state 95% hit.
- Anycast is the networking primitive that makes the edge globally reachable and structurally absorbs DDoS, but it is connectionless-friendly only — CDNs terminate TCP at the edge (split TCP) to handle long-lived sessions.

**Common Follow-Up Questions:**
- **How does a CDN route a user to the nearest PoP?** DNS-based mapping using EDNS Client Subnet, resolver location, PoP load/health, and BGP path cost — not coarse geo-DNS round-robin. Without ECS the CDN only sees the recursive resolver's IP, which degrades routing accuracy.
- **How do you cache personalized content safely?** Don't cache user-specific responses at the edge at all, or cache only shared fragments and personalize at the edge via ESI/edge compute, or cache per-user with a `Vary: Cookie` or user-ID key segment — accepting low hit ratio as the price of correctness.
- **What happens to the origin during a deploy or purge?** A global purge causes a synchronized cache stampede; mitigate with surrogate-key purges, stale-while-revalidate, stale-if-error, request coalescing, and circuit breakers so overload degrades to stale rather than cascading failure.

**Gotcha:**
- A high global cache hit ratio can hide a 30% CHR on your API path that is quietly hammering the origin — always segment CHR by content type, URL pattern, and PoP, and measure at the edge, not the origin. Hit ratio is a means, not the goal; correctness comes first.
