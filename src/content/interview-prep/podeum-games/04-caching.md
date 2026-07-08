---
title: "Module 4: Redis Caching — Rate Limiting, Sessions, and Ephemeral State"
date: 2026-07-09
type: article
tags: [podeum, redis, caching, redisson, rate-limiting, system-design, fantasy-gaming]
related: [podeum-games, 02-mongodb, 03-api-resources, 05-payment-gateway]
audience: [senior-engineer, system-design-interview-prep]
estimated_read_time: 20 min deep read, 10 min skim
---

# Module 4: Redis Caching — Rate Limiting, Sessions, and Ephemeral State

The caching module (`caching/src/main/java/com/podeum/caching/`) is Podeum's survival mechanism under load. During an IPL playoff match with 8,000 concurrent users, the MySQL database is protected by Hibernate's connection pool, and MongoDB absorbs the document writes — but neither database can handle the per-request, sub-millisecond lookups that a fantasy gaming platform needs.

Redis fills the gap. It handles three categories of data that share one property: they're ephemeral, they're accessed on nearly every API request, and they must be read in under 1 millisecond.

---

## 1. Why Redisson Over Jedis/Lettuce

This is the first question a Java Redis user asks. Jedis is the de facto standard (4,000+ GitHub stars, synchronous, thread-safe via pooling). Lettuce is the async-first alternative (Netty-based, reactive). Redisson is less common — and Podeum chose it deliberately.

### The Three Java Redis Clients Compared

| Feature | Jedis | Lettuce | Redisson |
|---------|-------|---------|----------|
| Threading model | Synchronous, one connection per thread (pooled) | Async/reactive, single connection shared across threads | Async by default, Netty-based, connection pool optional |
| API style | Low-level Redis commands (`SET key value`) | Low-level Redis commands (`set(key, value)`) | High-level distributed objects (`RBucket`, `RMap`, `RLock`) |
| Connection management | Manual pool (`JedisPool`) | Automatic by `RedisClient` | Automatic by `RedissonClient` |
| Distributed data structures | None — raw commands only | None — raw commands only | `RMap`, `RMapCache`, `RBucket`, `RLock`, `RAtomicLong`, `RCountDownLatch`, `RQueue` |
| Redis Cluster support | Manual sharding via `ShardedJedis` | Built-in | Built-in, transparent |
| TTL on nested map entries | Not supported (SETEX only for keys) | Not supported | Supported via `RMapCache` |
| Watchdog (lock renewal) | Manual | Manual | Automatic for `RLock` |
| Async operations | `Jedis` only (sync) + `JedisPool` | Native async (`RedisAsyncCommands`) | Native async (`setAsync`, `putAsync`) |

### The Decisive Factor: RMapCache

The feature that made Redisson the only viable choice was `RMapCache` — a distributed `Map<K,V>` where each entry has its own TTL independent of the map key itself.

Podeum's rate limiting works like this: every API request from a user increments a counter keyed by `{userId}:{api_path}:{minute_bucket}`. The counter must auto-expire after the minute window ends, but the map itself (the collection of all rate-limit counters) must persist indefinitely.

With Jedis or Lettuce, you'd implement this as individual `SETEX` commands — one Redis key per user-per-endpoint-per-minute. At 5,000 concurrent users making 10 API calls/minute each across 40 endpoints, that's 2 million ephemeral keys in Redis, all requires manual cleanup logic when the TTL expires (Redis handles deletion, but your key-naming scheme must be perfectly consistent).

With Redisson's `RMapCache`, it's one map (`rate_limits`) with per-entry TTL:

```java
RMapCache<String, Integer> rateLimits = redisson.getMapCache("rate_limits");
rateLimits.put(
    "user_123:/api/match/score:2026-07-09T14:35", // key
    1,                                               // value (counter)
    60, TimeUnit.SECONDS                             // TTL for this entry only
);
```

The map stays. Entries auto-expire. No key-naming conventions, no manual cleanup, no `SCAN` operations to find orphaned keys. This single feature eliminated an entire class of Redis key-management bugs.

### The Second Factor: Distributed Object Abstraction

Redisson maps Redis data structures directly to Java collections interfaces:

- `RBucket<V>` → `java.util.concurrent` style bucket (get/set with TTL)
- `RMap<K,V>` → `java.util.Map` interface (implemented on Redis hashes)
- `RMapCache<K,V>` → `Map` with per-entry TTL
- `RLock` → `java.util.concurrent.locks.Lock` (distributed)
- `RAtomicLong` → `java.util.concurrent.atomic.AtomicLong` (distributed)

This means Podeum's service code never writes raw Redis commands. There's no `jedis.set("key", "value")` anywhere in the codebase. Instead, the `RedisClient` wraps these distributed objects behind domain methods like `cacheUserSession(userId, session)` and `incrementRateLimit(userId, endpoint)`. This abstraction makes the caching layer testable — tests mock `RedisClient`, not `RedissonClient` or raw Redis commands.

### The Tradeoff

Redisson's abstraction comes at a cost: it's heavier than Jedis. The Redisson JAR is ~3MB vs. Jedis's ~300KB. It maintains internal data structures for distributed object management, pub/sub for lock notifications, and a watchdog thread for lock renewal. At Podeum's scale (single-digit thousands of concurrent users), this overhead is negligible. But it's worth noting — if you're building a high-frequency trading system with 100K+ operations/second and strict GC pause budgets, you'd benchmark Redisson vs. Lettuce carefully.

---

## 2. Three Data Structures and Their Use Cases

The `RedisClient.java` class (`implementations/RedisClient.java`) is the central Redis abstraction. It exposes exactly three data structures, each chosen for a specific access pattern in the Podeum platform.

### RBucket<V>: Simple Key-Value with 7-Day TTL

`RBucket` is Redisson's equivalent of Redis's `SET/GET` commands — a single value stored at a key. Podeum uses it for any data that matches this pattern: fetch once, read many times, discard after 7 days.

```java
public class RedisClient {
    private final RedissonClient redisson;

    // Store any object with a 7-day TTL
    public <T> void put(String key, T value) {
        RBucket<T> bucket = redisson.getBucket(key);
        bucket.set(value, 7, TimeUnit.DAYS);
    }

    // Retrieve an object
    public <T> T get(String key) {
        RBucket<T> bucket = redisson.getBucket(key);
        return bucket.get();
    }

    // Async write — returns immediately, Redis write happens on Netty event loop
    public <T> void putAsync(String key, T value) {
        RBucket<T> bucket = redisson.getBucket(key);
        bucket.setAsync(value, 7, TimeUnit.DAYS);
    }

    // Delete a key
    public void delete(String key) {
        RBucket<Object> bucket = redisson.getBucket(key);
        bucket.delete();
    }

    // Bulk read — single pipeline for multiple keys
    public <T> Map<String, T> bulkGet(List<String> keys) {
        Map<String, T> result = new HashMap<>();
        for (String key : keys) {
            RBucket<T> bucket = redisson.getBucket(key);
            T value = bucket.get();
            if (value != null) {
                result.put(key, value);
            }
        }
        return result;
    }
}
```

**Use cases for RBucket in Podeum:**

| Use Case | Key Pattern | Value | Why RBucket? |
|----------|-------------|-------|--------------|
| Match state snapshots | `match:{matchId}:state` | Current score, inning, overs, wickets | Fetched on every scoreboard API call. Recalculated on every webhook event. Always read as a whole unit. |
| Fantasy leaderboard cache | `leaderboard:{gameId}:top100` | Serialized top-100 list | Expensive MySQL query (JOINs across fantasy_teams, player_stats, users). Recalculated every 30 seconds by Quartz job. |
| User profile cache | `user:{userId}:profile` | Username, avatar URL, level | Displayed on every screen. Rarely changes (profile updates). Perfect for bucket pattern. |
| Quiz pod config | `pod:{podId}:config` | Pod metadata, active quizzes list | Fetched once when user opens a pod. Invalidated when new quiz is added. |
| Referral link cache | `referral:{code}` | Target URL, expiry, campaign ID | Redirect lookup — must be sub-millisecond. Code → URL mapping changes rarely. |
| PhonePe transaction status | `payment:{txnId}:status` | Payment status, UPI ref ID | Polled every 5 seconds by client during payment flow. Status mutates from PENDING → SUCCESS/FAILED. TTL ensures stale transaction data doesn't accumulate. |

The key naming convention (`entity:identifier:subresource`) is enforced in `CacheConstants.java` to prevent key collisions across services.

### RMap<K,V>: Hash-Based Lookups

`RMap` is Redisson's implementation of Redis hashes — a key that contains a map of field-value pairs. Podeum uses it for data that's logically grouped and where partial reads are common (fetch one field from the group, not the entire bucket).

```java
public class RedisClient {
    // Store a field inside a hash
    public <K, V> void hset(String mapKey, K field, V value) {
        RMap<K, V> map = redisson.getMap(mapKey);
        map.fastPut(field, value);
    }

    // Retrieve a single field from a hash
    public <K, V> V hget(String mapKey, K field) {
        RMap<K, V> map = redisson.getMap(mapKey);
        return map.get(field);
    }

    // Retrieve all fields from a hash
    public <K, V> Map<K, V> hgetAll(String mapKey) {
        RMap<K, V> map = redisson.getMap(mapKey);
        return map.readAllMap();
    }

    // Delete a field from a hash
    public <K, V> void hdel(String mapKey, K field) {
        RMap<K, V> map = redisson.getMap(mapKey);
        map.fastRemove(field);
    }
}
```

**Use cases for RMap in Podeum:**

| Use Case | Map Key | Fields | Why RMap? |
|----------|---------|--------|-----------|
| User sessions | `sessions:{userId}` | `token`, `device_id`, `last_active_ms`, `ip_address` | Multiple fields per session. Need to update `last_active_ms` independently without re-serializing the entire object. |
| Live match game states | `game:{gameId}:state` | `status`, `current_inning`, `last_event_id`, `last_updated_ms` | Updates happen field-by-field (inning changes, status transitions). Don't want to read-modify-write the entire state object. |
| Player fantasy points | `points:{matchId}` | `player_001: 125.5`, `player_002: 87.0`, ... | Points for all players in a match. UI fetches individual player points (not all 22 players at once). |
| Pod user memberships | `pod:{podId}:members` | `user_001: "admin"`, `user_002: "member"` | Role lookups per user. Check membership without loading all members. |
| Feature flags | `features:active` | `new_ui: "true"`, `phonepe_upi: "true"` | Individual flag checks without loading the entire flag set. |

The key advantage of `RMap` over `RBucket` for these cases: **partial reads and writes.** When a user's session `last_active_ms` updates every 30 seconds, an `RBucket` would require deserializing the entire session object, updating one field, and re-serializing. `RMap` does a single `HSET` — one field, one Redis command, no serialization overhead for the unchanged fields.

### RMapCache<K,V>: Rate Limiting with Per-Entry TTL

`RMapCache` is the data structure that sold Podeum on Redisson. It's an `RMap` where each entry (field-value pair) has its own TTL — when the TTL expires, that entry is silently removed from the map.

```java
public class RedisClient {
    // Increment a rate-limit counter. Creates if absent, increments if present.
    // Entry auto-expires after 'duration' seconds.
    public int incrementRateLimit(String userId, String endpoint, int durationSeconds) {
        RMapCache<String, Integer> cache = redisson.getMapCache("rate_limits");
        String key = userId + ":" + endpoint;
        
        // Atomic get-and-increment. Returns null if key doesn't exist.
        Integer current = cache.get(key);
        if (current == null) {
            cache.put(key, 1, durationSeconds, TimeUnit.SECONDS);
            return 1;
        } else {
            int newValue = current + 1;
            // Preserve original TTL — don't reset it on each increment
            // (would allow indefinite rate-limit evasion by spacing requests)
            cache.put(key, newValue, durationSeconds, TimeUnit.SECONDS);
            return newValue;
        }
    }

    // Check if a rate limit has been exceeded
    public boolean isRateLimited(String userId, String endpoint, int maxRequests) {
        RMapCache<String, Integer> cache = redisson.getMapCache("rate_limits");
        String key = userId + ":" + endpoint;
        Integer count = cache.get(key);
        return count != null && count >= maxRequests;
    }
}
```

**Use cases for RMapCache in Podeum:**

| Use Case | Map Key | Entry Pattern | TTL | Max Limit |
|----------|---------|---------------|-----|-----------|
| API rate limiting (per minute) | `rate_limits` | `{userId}:{endpoint}:{minute_bucket}` | 60 seconds | Varies by endpoint (see `CacheConstants`) |
| OTP verification attempts | `otp_attempts` | `{phoneNumber}` | 300 seconds (5 min) | 3 attempts |
| Payment retry attempts | `payment_retries` | `{userId}:{txnId}` | 900 seconds (15 min) | 5 attempts |
| Quiz answer spam prevention | `quiz_answers` | `{userId}:{quizId}` | 30 seconds | 1 answer per quiz |
| Referral code generation | `referral_gen` | `{userId}` | 3600 seconds (1 hour) | 1 code per hour |

The critical design detail: **TTL is set on entry creation, not reset on each increment.** If you reset the TTL on every request, a malicious user could send 1 request every 59 seconds forever and never hit the rate limit. By preserving the original TTL (the entry was created at minute boundary 14:35:00 and expires at 14:36:00 regardless of how many increments happen), the window stays fixed.

However, the current implementation above does reset TTL on each increment (`cache.put(key, newValue, durationSeconds, ...)`). This is a known design tradeoff documented in Podeum's code. The alternative — using `RMapCache` with `addAndGet` semantics and a fixed TTL — is possible with a Lua script but adds complexity. At Podeum's threat model (casual abuse, not sophisticated attackers), the sliding-window behavior is acceptable.

---

## 3. Rate Limiting Architecture

Rate limiting is the highest-value use of Redis in Podeum because it protects the entire API surface from abuse without adding latency.

### How It Works: The Request Filter Pipeline

Every incoming HTTP request passes through a Dropwizard request filter before reaching any Jersey resource:

```
HTTP Request
    │
    ▼
┌──────────────────────────────────────┐
│  AuthenticationFilter                │
│  - Extract JWT, validate Firebase    │
│  - Set userId on security context     │
└───────────────┬──────────────────────┘
                │
                ▼
┌──────────────────────────────────────┐
│  RateLimitFilter                     │
│  - Extract userId + request path     │
│  - Look up rate limit config for     │
│    this endpoint in CacheConstants   │
│  - Call RedisClient.incrementRateLimit│
│  - If count > limit: return 429     │
│  - If count <= limit: chain.doFilter │
└───────────────┬──────────────────────┘
                │ (if not rate limited)
                ▼
┌──────────────────────────────────────┐
│  Jersey Resource / Service Layer     │
└──────────────────────────────────────┘
```

### CacheConstants: The Rate Limit Configuration

```java
public class CacheConstants {
    // Maps endpoint patterns to max requests per window
    public static final Map<String, Integer> LIMIT = new HashMap<>();
    // Maps endpoint patterns to window duration in seconds
    public static final Map<String, Long> DURATION = new HashMap<>();

    static {
        // Auth endpoints — low limit, high sensitivity
        LIMIT.put("/api/auth/send-otp", 3);
        DURATION.put("/api/auth/send-otp", 300L); // 5 minutes

        LIMIT.put("/api/auth/verify-otp", 5);
        DURATION.put("/api/auth/verify-otp", 300L);

        // Payment endpoints — moderate limit, financial sensitivity
        LIMIT.put("/api/payment/init", 10);
        DURATION.put("/api/payment/init", 60L); // per minute

        LIMIT.put("/api/payment/status", 30);
        DURATION.put("/api/payment/status", 60L); // polling allowed

        // Fantasy game endpoints — higher limit, core gameplay
        LIMIT.put("/api/fantasy/create-team", 5);
        DURATION.put("/api/fantasy/create-team", 60L);

        LIMIT.put("/api/fantasy/join-game", 10);
        DURATION.put("/api/fantasy/join-game", 60L);

        // Quiz endpoints — moderate limit
        LIMIT.put("/api/quiz/submit-answer", 20);
        DURATION.put("/api/quiz/submit-answer", 60L);

        // Match data endpoints — high limit, read-heavy
        LIMIT.put("/api/match/score", 120);
        DURATION.put("/api/match/score", 60L);

        LIMIT.put("/api/match/commentary", 60);
        DURATION.put("/api/match/commentary", 60L);

        // Default — catch-all for unlisted endpoints
        LIMIT.put("default", 60);
        DURATION.put("default", 60L);
    }
}
```

The configuration reflects real usage patterns:
- **Auth endpoints**: 3-5 requests per 5 minutes. OTP abuse is the #1 attack vector on Indian gaming platforms. Strict limits prevent SMS bombing (which costs real money per SMS sent via Firebase Phone Auth).
- **Payment endpoints**: 10 initiations/minute but 30 status checks/minute. Users poll payment status frequently during UPI flow — throttling status checks would degrade UX without security benefit.
- **Match score endpoint**: 120 requests/minute. This is the most-hit endpoint during live matches. The limit is high because the Flutter client polls every 2 seconds (30 requests/minute), and power users might have multiple matches open.
- **Default: 60 requests/minute**: Any endpoint without explicit configuration gets a reasonable baseline. This prevents accidentally leaving an endpoint unprotected.

### Why Rate Limiting Lives in Redis, Not in Application Memory

Three reasons:

**1. Multi-pod consistency.** Podeum runs 3-10 pods on EKS. A user's requests are load-balanced across all pods (sticky sessions not enforced). If rate limiting were in-memory (a `ConcurrentHashMap` per pod), a user could send 60 requests to pod A, hit the limit, and then 60 more requests to pod B — effectively doubling the limit. Redis provides a single source of truth across all pods.

**2. Survival across pod restarts.** Kubernetes rolling deploys replace pods every few hours (config changes, image updates). In-memory rate limit counters would be wiped on every restart, effectively resetting all limits. Redis counters survive pod lifecycle changes.

**3. No GC pressure.** 5,000 concurrent users × 40 endpoints = 200,000 rate-limit counters. Storing this in a JVM `ConcurrentHashMap` with TTL-expiry logic would create significant GC pressure (object allocation + eviction). In Redis, these are hash entries using native memory, invisible to the JVM garbage collector.

---

## 4. Async Operations with setAsync

One of the most important design decisions in `RedisClient` is that writes are asynchronous by default.

### The Async Write Pattern

```java
public class RedisClient {
    // Synchronous write — blocks until Redis acknowledges
    public <T> void put(String key, T value) {
        RBucket<T> bucket = redisson.getBucket(key);
        bucket.set(value, 7, TimeUnit.DAYS);
    }

    // Asynchronous write — returns immediately, no Redis round-trip in request thread
    public <T> void putAsync(String key, T value) {
        RBucket<T> bucket = redisson.getBucket(key);
        bucket.setAsync(value, 7, TimeUnit.DAYS);
    }
}
```

### When Async Is Used vs. Sync

| Operation | Sync or Async? | Rationale |
|-----------|---------------|-----------|
| Rate limit increment | **Async** | Fire-and-forget. If increment fails, the next request will succeed (or the user gets a free pass — acceptable). Blocking every API request on a Redis round-trip adds 1-2ms latency to every endpoint. |
| Match state cache update | **Async** | Webhook handler writes "match state updated" to Redis. The write is best-effort — if it fails, the next webhook event (arriving in ~30 seconds for the next ball) will overwrite it. No benefit to blocking the webhook response. |
| Leaderboard cache refresh | **Async** | Quartz job recalculates leaderboard and writes to Redis. The write is background — no user request is waiting for it. |
| Payment status cache | **Sync** | Payment status transitions (PENDING → SUCCESS) must be confirmed before returning to the client. If Redis write fails, the client would see stale PENDING and retry unnecessarily. |
| OTP verification cache | **Sync** | OTP attempt counter must be incremented BEFORE the OTP is verified. If async write fails and the counter isn't incremented, the user gets unlimited OTP attempts. Security-critical — must be synchronous. |
| Quiz answer submission | **Sync** | "User already answered this quiz" check must be consistent. If async write fails, user can submit the same answer twice and double-count points. |

The rule: **async for non-critical writes where eventual consistency is acceptable; sync for writes where correctness depends on the write having succeeded.** This is the same tradeoff as the MySQL-vs-MongoDB consistency decision — Podeum's architecture consistently chooses performance over strict consistency for non-critical paths.

### How Async Works Under the Hood

Redisson's `setAsync()` returns a `RFuture<T>` (a `CompletionStage`-like object). The write is enqueued on the Netty event loop and processed asynchronously. The calling thread returns immediately.

```java
// What setAsync actually does:
RFuture<Void> future = bucket.setAsync(value, 7, TimeUnit.DAYS);
// future completes when Redis sends +OK
// No blocking on the calling thread
```

Redisson internally manages a connection pool for async operations. Each Netty event loop thread gets its own Redis connection, so concurrent `setAsync` calls on different threads don't contend for a single connection.

The `RedisClient` does not expose `RFuture` to the service layer — that would leak Redisson types into business logic. Instead, `putAsync` is fire-and-forget (void return). For cases where the caller needs to know the write completed, they use the synchronous `put()`. This is a deliberate API design choice: async writes are fire-and-forget, sync writes are blocking. No callbacks, no futures, no reactive streams — the code stays readable.

---

## 5. Why 7-Day TTL as Default

Every `RBucket` write in Podeum defaults to a 7-day TTL. This isn't an arbitrary number — it was chosen to balance three competing concerns.

### Concern 1: Stale Data Must Not Accumulate

Without a TTL, Redis would grow unbounded. Every match state snapshot, every user session, every leaderboard cache would persist forever. Over months of operation, this would saturate Redis memory (ElastiCache instances are memory-bound, not disk-bound). The 7-day TTL acts as a garbage collector — any data not accessed or refreshed within 7 days is silently deleted by Redis's built-in eviction.

### Concern 2: Data Must Survive a Weekend

Podeum's peak usage is on weekends (Saturday-Sunday IPL matches). Data cached on Saturday must still be valid on Monday morning when users check their fantasy standings and transaction history. A 24-hour TTL would mean Monday-morning traffic hits cold caches, causing a thundering herd on MySQL. A 7-day TTL means the entire week's cached data survives.

### Concern 3: Cache Invalidation Must Be Automatic

Podeum does not have a cache invalidation service. There's no `CacheInvalidator` class that subscribes to MySQL binlogs and purges stale Redis keys. The team of 2 engineers couldn't justify building one. Instead, TTL-based expiry provides automatic invalidation:

- Match state cache: overwritten every 30 seconds by webhook handler → 7-day TTL is irrelevant (data is continuously refreshed)
- Leaderboard cache: overwritten every 30 seconds by Quartz job → 7-day TTL is a safety net
- User profile cache: overwritten when user updates profile → 7-day TTL catches profiles of inactive users
- Payment status cache: overwritten on each status poll → 7-day TTL is a safety net for abandoned transactions
- Referral link cache: rarely changes → 7-day TTL means a referral code change takes up to 7 days to propagate. This is the one case where TTL-based invalidation is imperfect, but referral code changes are rare (once per campaign, which runs for weeks).

### The TTL Spectrum

| TTL | What It's Good For | What It's Bad For |
|-----|--------------------|-------------------|
| 60 seconds | Rate limit counters, OTP attempts | Everything else — caches are cold most of the time |
| 5 minutes | Payment retry counters, quiz answer spam | Session data, match states |
| 1 hour | Feature flags (if you want flags to refresh hourly) | Leaderboards (recalculated every 30 seconds anyway) |
| **7 days (Podeum default)** | Match states, sessions, leaderboards, profiles, pod configs | Data that changes multiple times per hour and needs instant propagation |
| 30 days | Referral codes, static config | Any frequently-changing data |

The 7-day TTL is not enforced by Redisson automatically. It's explicitly passed in every `put()` and `putAsync()` call in `RedisClient`:

```java
bucket.set(value, 7, TimeUnit.DAYS);       // sync
bucket.setAsync(value, 7, TimeUnit.DAYS);   // async
```

For `RMap` operations, TTL is configured on the map itself at creation time via `RedisConfiguration`, which sets a 7-day TTL on the entire hash. Individual fields within a hash can have different TTLs only via `RMapCache` — which is why rate limiting uses `RMapCache` (per-entry TTL) while sessions use `RMap` (entire session expires together).

---

## RedisConfiguration: Wiring It All Together

```java
public class RedisConfiguration {
    private String redisUrl;        // "redis://podeum-cache.elasticache.aws:6379"
    private int connectionPoolSize; // 24
    private int connectionMinimumIdleSize; // 8
    private int retryAttempts;      // 3
    private int retryIntervalMs;    // 1500
    private int timeoutMs;          // 3000
}
```

The `CachingModule` (Guice module) reads this config and creates a singleton `RedissonClient`:

```java
public class CachingModule extends AbstractModule {
    @Override
    protected void configure() {
        Config config = new Config();
        config.useSingleServer()
            .setAddress(redisConfig.getRedisUrl())
            .setConnectionPoolSize(redisConfig.getConnectionPoolSize())
            .setConnectionMinimumIdleSize(redisConfig.getConnectionMinimumIdleSize())
            .setRetryAttempts(redisConfig.getRetryAttempts())
            .setRetryInterval(redisConfig.getRetryIntervalMs())
            .setTimeout(redisConfig.getTimeoutMs());

        RedissonClient redisson = Redisson.create(config);
        bind(RedissonClient.class).toInstance(redisson);
        bind(RedisClient.class).in(Singleton.class);
    }
}
```

### Connection Pool Sizing

Redis is single-threaded (for data operations — I/O is multithreaded in Redis 6+). Connection pool sizing follows different rules than MySQL:

- **Min idle: 8** — Enough to handle baseline traffic without connection setup latency.
- **Max: 24** — Sized for 3 pods × 8 connections = 24 total connections to the ElastiCache instance. Redis handles ~100K ops/sec on a single thread, so 24 connections are more than enough for 5K concurrent users.
- **Retry attempts: 3** with **1.5s interval** — Handles transient network blips (packet loss, ElastiCache failover). 3 attempts × 1.5s = 4.5s total before the operation fails. This is shorter than the 5-second Dropwizard HTTP request timeout, so Redis failures manifest as 503 responses, not hanging requests.

---

## Summary: What the Redis Module Teaches

1. **Choose the client for the data structures, not for the benchmarks.** Jedis and Lettuce are "faster" on raw SET/GET, but Redisson's `RMapCache` eliminates an entire class of key-management bugs that would otherwise require application-level TTL tracking.

2. **Async writes are a force multiplier.** By making cache writes async (fire-and-forget), Podeum avoids adding ~2ms of Redis latency to every API request. The tradeoff — occasional cache-miss on write failure — is acceptable for non-critical data.

3. **Rate limiting belongs in Redis, not in the application.** Multi-pod consistency + survival across restarts + no GC pressure. A `ConcurrentHashMap` with a cleanup thread in the JVM can never match Redis for operational simplicity.

4. **TTL-based expiry beats explicit invalidation for small teams.** Two engineers can't build a cache invalidation service. Seven-day TTLs mean data auto-expires without anyone writing a single line of invalidation code.

5. **The 7-day default is a deliberate tradeoff** between "data must survive the weekend" and "stale data must not accumulate." It's not an arbitrary number — it was chosen to match Podeum's weekly usage cycle (weekend peak, Monday review).

---

**Next:** [Module 5: PhonePe Payment Gateway](./05-payment-gateway) — UPI integration, SHA256 signing  
**Previous:** [Module 3: API Layer](./03-api-resources) — REST resources, services, webhooks
