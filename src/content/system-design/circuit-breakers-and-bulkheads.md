---
title: "Circuit Breakers & Bulkheads (Resilience4j, Hystrix patterns)"
type: system-design
category: Platform
date: 2026-06-16
tags: [system-design, interview, platform, circuit-breaker, bulkhead, resilience4j, hystrix, resilience, fault-tolerance, cascading-failure, backpressure, staff-engineering]
aliases: ["Circuit Breakers", "Bulkheads", "Circuit Breakers & Bulkheads", "Resilience Patterns", "Fault Tolerance"]
difficulty: intermediate
read_time: 15
listen_time: 22
---

# Circuit Breakers & Bulkheads (Resilience4j, Hystrix patterns)

> **Staff-Engineer Focus:** "Wrap every external call in a circuit breaker" is the mid-level answer. Understanding the state machine (CLOSED → OPEN → HALF-OPEN), knowing when to use count-based vs time-based sliding windows, and tuning thresholds from production data rather than gut feelings — that's the senior answer. **Knowing that circuit breakers don't solve the problem — they *reveal* it. The circuit breaker is a canary, not a cure. Your real job is to diagnose WHY downstream is failing and fix the root cause, while the breaker prevents cascading failure in the meantime. The bulkhead pattern extends this thinking across *organizational boundaries*: isolating tenant workloads so that a noisy neighbor doesn't drown everyone else. The staff engineer designs the resilience architecture so that individual team failures are contained, monitored, and recoverable without cross-team fire drills — that's the staff engineer.** The interview question isn't "What are the three states of a circuit breaker?" It's: "Your payment service calls 12 downstream services. One of them — the fraud detection service — starts timing out at P99. Within 60 seconds, your entire payment pipeline is blocked because connection pools are exhausted waiting for fraud detection responses. No circuit breaker is in place. Walk me through: (a) what just happened at the thread-pool level, (b) how you'd prevent it architecturally, (c) what metrics you'd need to detect it in production, and (d) why adding a circuit breaker to fraud detection alone isn't enough."

---

## Summary & Interview Framing

Resilience patterns that prevent cascading failures — circuit breakers stop calling failing services, bulkheads isolate resources so one failure doesn't exhaust everything. A circuit breaker operates as a state machine (CLOSED → OPEN → HALF-OPEN) that trips when error rates or latency exceed thresholds, while bulkheads partition thread pools and connections per dependency.

**How it's asked:** "Design the resilience layer for a microservices architecture with 50 services. How do you prevent one service's failure from taking down the entire system?"

---

## 1. Why Resilience Patterns Matter at Staff Level

At the staff level, a service dependency isn't just an API call — it's a **failure domain boundary**. When that boundary fails, the failure mode matters more than the failure itself:

1. **Cascading failure is silent and fast.** A downstream slowdown (not even a crash) can exhaust your connection pools, thread pools, or file descriptors in seconds. Your service looks healthy (CPU low, no errors) but can't accept new work because every thread is blocked waiting.

2. **Retry storms amplify the problem.** The intuitive reaction to a timeout — "retry it" — doubles or triples load on an already-struggling downstream, turning a brownout into a full outage.

3. **Noisy neighbor is a platform problem, not a tenant problem.** In a multi-tenant system, one tenant's traffic spike or slow query can consume shared resources (DB connections, cache capacity, thread pools) and degrade every other tenant.

4. **Recovery is often worse than the failure.** When a downstream comes back after being down, it faces a backlog of queued-up requests — the "thundering herd." Without backpressure, it goes down again. This cycle repeats until you add a circuit breaker.

**The core insight:** Resilience patterns aren't about making failures impossible — they're about **changing the failure mode from catastrophic (system-wide outage) to graceful (degraded functionality)**. A circuit breaker turns a 5-minute downstream outage into 5 seconds of rejected requests + 55 seconds of HALF-OPEN probing + 4 minutes of normal operation. The users see 5% degradation, not 100% outage.

---

## 2. The Circuit Breaker State Machine

The circuit breaker is a finite state machine with three states:

```
  ┌──────────┐    failure threshold     ┌──────────┐
  │  CLOSED  │ ────────────────────────→ │   OPEN   │
  │ (normal) │                          │ (reject) │
  └──────────┘                          └──────────┘
       ↑                                      │
       │      success threshold               │
       │      (or time-based reset)            │
       │                                      ↓
       └───────────────────────────────── ┌─────────────┐
                                          │  HALF-OPEN   │
                                          │ (probing)    │
                                          └─────────────┘
```

### 2.1 CLOSED State (Normal Operation)

- Requests flow through normally
- Circuit breaker tracks success/failure counts or rates
- When failures exceed the threshold within the configured window, transition to OPEN

**Tuning parameters:**
- `failureRateThreshold` (e.g., 50%) — percentage of failures that trigger the breaker
- `slidingWindowSize` (e.g., 100) — how many recent calls to evaluate
- `slidingWindowType` — COUNT_BASED or TIME_BASED
- `minimumNumberOfCalls` (e.g., 10) — don't open before collecting this many samples (prevents flapping on low traffic)

### 2.2 OPEN State (Fail-Fast Rejection)

- All requests are immediately rejected with a `CallNotPermittedException`
- No requests reach the downstream — this is the critical protection
- After `waitDurationInOpenState` (e.g., 30s), transition to HALF-OPEN

**Why fail-fast matters:** Without immediate rejection, each request would wait for the full timeout (e.g., 5s) before failing. With 200 concurrent requests, that's 200 threads blocked for 5 seconds = 1000 thread-seconds of wasted capacity. Fail-fast makes the failure cost near-zero.

### 2.3 HALF-OPEN State (Probing)

- A limited number of requests are allowed through (configured by `permittedNumberOfCallsInHalfOpenState`, typically 3-10)
- If these requests succeed, transition back to CLOSED
- If any fail, transition back to OPEN (reset the wait timer)

**The HALF-OPEN trap:** If `permittedNumberOfCallsInHalfOpenState` is too high, you can overwhelm a recovering downstream. If too low, you might never trigger enough successes to close. The sweet spot depends on downstream recovery characteristics — databases need fewer probes than stateless services.

### 2.4 Resilience4j Configuration Example

```yaml
resilience4j:
  circuitbreaker:
    instances:
      fraudDetection:
        registerHealthIndicator: true
        slidingWindowSize: 100
        slidingWindowType: COUNT_BASED
        minimumNumberOfCalls: 10
        failureRateThreshold: 50
        waitDurationInOpenState: 30s
        permittedNumberOfCallsInHalfOpenState: 5
        automaticTransitionFromOpenToHalfOpenEnabled: true
        recordExceptions:
          - java.net.SocketTimeoutException
          - java.net.ConnectException
          - org.springframework.web.client.HttpServerErrorException
        ignoreExceptions:
          - com.example.ValidationException  # Don't open breaker on client errors
```

---

## 3. Sliding Window: Count-Based vs. Time-Based

This is one of the most common interview traps. Both approaches implement the sliding window differently:

| Aspect | COUNT_BASED | TIME_BASED |
|--------|-------------|------------|
| **Window measured in** | Last N calls | Last T seconds |
| **Memory cost** | Fixed (ring buffer of N) | Variable (aggregates per bucket) |
| **Reacts to traffic spikes** | Quickly (can fill window in ms) | Slowly (must wait for time to pass) |
| **Reacts to traffic dips** | Window ages slowly | Window ages predictably |
| **Good for** | Stable traffic patterns | Bursty traffic patterns |
| **Example** | "Open if 50 of last 100 calls fail" | "Open if 50% of calls in last 60s fail" |

### 3.1 The COUNT_BASED Pitfall

If you set `slidingWindowSize=100` with `minimumNumberOfCalls=10`, and you get 10 failures in a row during a traffic spike, the breaker opens. But if those 10 failures happened in 50ms because of a network blip, you just blocked ALL traffic for 30 seconds based on a 50ms event.

**Fix:** Use `slowCallRateThreshold` alongside `failureRateThreshold`. A slow call (exceeds `slowCallDurationThreshold`, e.g., 3s) counts differently from a hard failure. This lets you trip on genuine degradation, not transient blips.

### 3.2 The TIME_BASED Pitfall

If traffic is low (1 request/sec), and your window is 60s, you need at least 60 seconds of data before the window is meaningful. A burst of 3 failures out of 3 calls is 100% failure rate — but it's only 3 calls. The `minimumNumberOfCalls` guard is essential here.

**The staff-level answer:** Measure your traffic patterns in production. If your service gets 1000 RPS, COUNT_BASED with window=100 fills in 100ms — fast reaction. If you get 10 RPS, TIME_BASED with window=60s gives you 600 samples — statistically meaningful. There's no one-size-fits-all. **Pick the window that gives you a statistically significant sample at your P50 traffic volume.**

---

## 4. The Bulkhead Pattern

> **Bulkhead:** A dividing wall or barrier between compartments in a ship, aircraft, or spacecraft. If one compartment is breached, the bulkhead prevents flooding from spreading.

In software, a bulkhead **isolates resource consumption** so that a failure in one part of the system doesn't starve other parts.

### 4.1 Thread Pool Isolation (Physical Bulkhead)

Each downstream dependency gets its own thread pool:

```
┌─────────────────────────────────────┐
│         Incoming Requests            │
└──────────────┬──────────────────────┘
               │
       ┌───────┴───────┐
       │  Dispatcher    │
       └───┬───┬───┬───┘
           │   │   │
    ┌──────┘   │   └──────┐
    ▼          ▼          ▼
┌────────┐ ┌────────┐ ┌────────┐
│Payment │ │ Fraud  │ │ Email  │
│ Pool   │ │ Pool   │ │ Pool   │
│ 20 thr │ │ 10 thr │ │ 5 thr  │
└───┬────┘ └───┬────┘ └───┬────┘
    ▼          ▼          ▼
 Payment    Fraud      Email
 Service   Service     Service
```

**Pros:**
- Complete isolation — Fraud pool exhaustion can't block Payment or Email calls
- Queue per dependency — backpressure is localized
- Easy to monitor — thread pool saturation is a clear signal

**Cons:**
- Thread overhead — 20 + 10 + 5 = 35 threads per service instance. At 50 instances, that's 1,750 threads just for outbound calls.
- Fixed limits — if Payment needs 25 threads during peak but pool is capped at 20, you queue or reject
- Context switching cost at high thread counts

### 4.2 Semaphore Isolation (Logical Bulkhead)

Instead of separate thread pools, use semaphores to limit concurrent calls:

```
Thread Pool (unified, e.g., 50 threads)
    │
    ├── Semaphore(Payment, permits=20)
    ├── Semaphore(Fraud, permits=10)
    └── Semaphore(Email, permits=5)
```

**Pros:**
- Lighter weight — one thread pool, no context switching penalty
- Dynamic — semaphore permits can be changed at runtime without restarting threads

**Cons:**
- Leaky isolation — a thread in the unified pool can still be blocked by a slow downstream. Semaphore only limits CONCURRENCY, not thread blocking.
- Harder to monitor — thread dump shows "waiting on semaphore" but doesn't say WHICH semaphore

### 4.3 When to Use Which

| Scenario | Isolation Type | Why |
|----------|---------------|-----|
| Critical payment path — 50ms P99 latency target | Thread Pool | Full isolation. Slow dependency can't exhaust pool because thread is blocked, not pooled. |
| 30 downstream dependencies, 2-5ms P99 | Semaphore | Thread pool per dep = 30 pools × 5 threads = 150 threads minimum. Too heavy. |
| Mixed criticality (fraud is optional, payment is not) | Thread Pool for critical, Semaphore for optional | Critical paths get full isolation. Optional paths share a pool. |
| Serverless / container with 0.25 vCPU | Semaphore | Thread creation is too expensive at these resource levels. |

---

## 5. Resilience4j vs. Hystrix vs. Alternatives

Hystrix (Netflix) popularized circuit breakers but is now in maintenance mode. The ecosystem has evolved:

| Library | Status | Circuit Breaker | Bulkhead | Rate Limiter | Retry | Time Limiter |
|---------|--------|:---:|:---:|:---:|:---:|:---:|
| **Resilience4j** | Active (2024+) | ✅ | ✅ (both types) | ✅ | ✅ | ✅ |
| **Hystrix** | Archived (2018) | ✅ | ✅ (thread pool only) | ❌ | ✅ (basic) | ✅ |
| **Sentinel** (Alibaba) | Active | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Failsafe** | Active | ✅ | ❌ | ❌ | ✅ | ✅ |
| **Spring Cloud Circuit Breaker** | Active | ✅ (abstracts impl) | ❌ | ❌ | ❌ | ✅ |

**Why Resilience4j won:**

1. **Functional programming model.** Decorators compose: `CircuitBreaker.decorateSupplier(Retry.decorateSupplier(TimeLimiter.decorateFuture(supplier, 3s), retryConfig), cbConfig)`. Hystrix required extending `HystrixCommand` — inheritance-based, hard to compose.

2. **Modular.** Each resilience pattern is a separate module. If you only need retry, you only include `resilience4j-retry`. Hystrix bundled everything.

3. **Non-blocking.** Resilience4j supports reactive streams (Project Reactor, RxJava). Hystrix's thread-pool isolation blocked threads.

4. **Lightweight.** Zero external dependencies. Hystrix pulled in Archaius (config), servo (metrics), and Hystrix dashboard.

5. **Operational control.** Resilience4j exposes `/actuator/circuitbreakers` for runtime state transitions. You can force a breaker OPEN for testing or CLOSED for emergency override without redeploying.

### 5.1 When Hystrix Still Teaches Us Things

Even though Hystrix is dead, its design philosophy is still the gold standard for interview discussions:

- **Command pattern:** Every external call is modeled as a `HystrixCommand`. This forces you to think about fallbacks (`getFallback()`), timeouts, and thread pool isolation for every dependency.
- **Request collapsing (request batching):** Hystrix could merge N concurrent requests to the same dependency into a single batch call. Resilience4j doesn't have this built-in — you'd need to implement it yourself or use GraphQL's DataLoader pattern.
- **Dashboard:** Hystrix Dashboard was revolutionary for its time — real-time circuit state visualization. Modern equivalents: Grafana + Micrometer metrics from Resilience4j.

---

## 6. Putting It All Together: The Resilience Stack

No single pattern is sufficient. The patterns compose into a resilience stack:

```
Request
  │
  ▼
┌──────────────┐   Rejects if too many concurrent calls to THIS dependency
│   Bulkhead   │   (Thread pool exhaustion or semaphore limit)
└──────┬───────┘
       │ (allowed through)
       ▼
┌──────────────┐   Fails fast if circuit is OPEN
│   Circuit    │   Protects downstream from overload
│   Breaker    │
└──────┬───────┘
       │ (call attempt)
       ▼
┌──────────────┐   Caps total call time (including retries)
│ Time Limiter │   "If fraud detection doesn't respond in 3s, it failed"
└──────┬───────┘
       │
       ▼
┌──────────────┐   Retries on transient failures (with backoff)
│   Retry      │   Exponential backoff: 100ms → 200ms → 400ms
└──────┬───────┘
       │
       ▼
┌──────────────┐   What to return when everything fails
│  Fallback    │   Cached result, default value, or graceful degradation
└──────────────┘
```

### 6.1 Order Matters

The ordering above is deliberate:

1. **Bulkhead first** — if we're out of capacity for this dependency, reject immediately. Don't waste circuit breaker tracking capacity on calls that can't even be attempted.

2. **Circuit breaker second** — if the downstream is known-broken, fail fast. Don't let calls reach the retry layer (which would just amplify load).

3. **Retry last** (before the actual call) — only retry if the bulkhead allowed the call AND the circuit breaker permitted it AND the call actually failed (not rejected by earlier layers).

**Common anti-pattern:** Retry wrapping circuit breaker. If the breaker is OPEN, the retry logic sees "rejected by circuit breaker" as a failure and retries → more rejected calls → more retries → effectively a retry storm against yourself.

---

## 7. Monitoring & Observability

At the staff level, resilience is a monitoring discipline, not a code one.

### 7.1 Essential Circuit Breaker Metrics

| Metric | Why | Alert? |
|--------|-----|:------:|
| `circuitbreaker.state` (0=CLOSED, 1=OPEN, 2=HALF_OPEN) | State transitions are the canary | YES — page on OPEN |
| `circuitbreaker.call.count` (successful + failed) | Traffic volume per breaker | No |
| `circuitbreaker.failure.rate` | Approaching threshold? | Warn at 40% (before 50% trip) |
| `circuitbreaker.slow.call.rate` | Degradation before hard failure | Warn at 20% |
| `circuitbreaker.buffered.calls` | Window fullness | No |
| `circuitbreaker.not.permitted.calls` | Requests rejected in OPEN state | Monitor trend |
| `circuitbreaker.half_open.successful.calls` | Is probing working? | Alert if 0 after 3 cycles |
| `circuitbreaker.half_open.failed.calls` | Recovery failing | Alert on ANY failure in HALF-OPEN |

### 7.2 Essential Bulkhead Metrics

| Metric | Why | Alert? |
|--------|-----|:------:|
| `bulkhead.max.thread.pool.size` | Configured capacity | No |
| `bulkhead.current.thread.pool.size` | Current utilization | Warn at 70% |
| `bulkhead.available.queue.capacity` | Queue depth available | Warn at 0 |
| `bulkhead.queue.wait.time.p99` | How long requests wait for a thread | Alert if > SLA |
| `bulkhead.rejected.calls` | Calls denied due to full bulkhead | YES — page |

### 7.3 The Dashboard That Matters

A staff engineer doesn't look at individual breaker states — they look at the **system-wide resilience dashboard**:

```
┌─────────────────────────────────────────────────────────┐
│  RESILIENCE OVERVIEW                      2026-06-16     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ACTIVE OUTAGES:    ██ Fraud Detection (OPEN 45s)       │
│                                                         │
│  DEGRADED:          ▓▓ Notification (HALF-OPEN)         │
│                     ▓▓ Inventory (slow calls 32%)        │
│                                                         │
│  HEALTHY:           12 services                          │
│                                                         │
│  BULKHEAD SAT:      Payment Pool:  14/20 (70%)          │
│                     Email Pool:      3/5  (60%)          │
│                     Fraud Pool:      0/10 (OPEN) ⚠       │
│                                                         │
│  REJECTED (last 5m):  1,247 calls to Fraud Detection     │
│                        (all caught by circuit breaker)   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Key pattern:** Circuit breakers are TRIPPED (OPEN state), not "alerted on." The actual alert fires on the upstream symptom — payment success rate dropping below SLA, not "circuit breaker for fraud detection opened." The circuit breaker state is diagnostic information, not the alert condition itself.

---

## 8. Interview Questions & Model Answers

### ⚡ Q1: "Your payment service calls fraud detection, which starts timing out at P99. Within 60 seconds, your entire payment pipeline is blocked. Walk me through what happened at the thread-pool level, and how you'd fix it."

**Staff-level answer:**

"At the thread-pool level, this is a **connection pool exhaustion cascade**:

1. Each incoming payment request acquires a thread from the application server's thread pool (e.g., Tomcat's 200 threads).

2. That thread makes an HTTP call to fraud detection. The HTTP client has its own connection pool (e.g., 50 connections). Each connection is leased to a request for the duration of the call.

3. Fraud detection's P99 latency goes from 200ms to 5s (timing out). Each connection is now held for 5s instead of 200ms — a 25× increase in hold time.

4. At 100 RPS, with 50 connections and 5s hold time, the connection pool saturates in: 50 connections / (100 calls/sec) = 0.5 seconds if all were instant. But with 5s hold: new requests queue up waiting for connections.

5. The connection pool request queue fills up. Now every Tomcat thread making a payment call is blocked waiting for an HTTP connection to fraud detection.

6. All 200 Tomcat threads are now blocked → no threads available for ANY request → health checks fail → load balancer marks instance as unhealthy → remaining instances get MORE traffic → cascade.

**The fix (resilience stack):**

1. **Time limiter** on the HTTP client: cap fraud detection calls at 1.5s (below Tomcat's own timeout). Failed calls return fast, threads are freed.

2. **Circuit breaker** on fraud detection: after 50% of calls fail (sliding window of 100), OPEN the circuit. New calls are rejected immediately — no thread blocking, no connection pool consumption.

3. **Bulkhead** (thread pool isolation): give fraud detection its own thread pool of 10 threads. Even if all 10 block, the other 190 Tomcat threads process non-fraud requests.

4. **Fallback:** return a `FraudCheckResult.ALLOW_WITH_FLAG` default — the payment goes through but is flagged for async review. Better to process payments without real-time fraud detection than to reject ALL payments.

5. **Observability:** Alert on P99 latency of fraud detection BEFORE the circuit breaker trips. If P99 crosses 500ms, wake someone up. The circuit breaker is the safety net, not the first line of defense."

### ⚡ Q2: "What's the difference between a circuit breaker and a retry? When would you use only one, and when both?"

**Staff-level answer:**

"A circuit breaker prevents calls FROM being made. A retry repeats calls that HAVE been made. They solve opposite problems:

| | Circuit Breaker | Retry |
|---|---|---|
| **Purpose** | Protect downstream from overload | Handle transient failures |
| **Action** | Rejects calls (fail-fast) | Repeats calls |
| **When** | Downstream is known-broken | Transient network blip, temporary unavailability |
| **Risk** | False positives (opens on transient error) | Amplifies load (retry storm) |

**Use only retry** when: downstream failures are transient, the operation is idempotent, and your retry budget (max attempts × base load) won't overwhelm the downstream on recovery. Example: fetching a user profile from a cache — cache miss is normal, retry once if connection drops.

**Use only circuit breaker** when: downstream failures are correlated (if one call fails, all will fail for a while), and you have a meaningful fallback. Example: fraud detection during a Datadog outage — if the API key service is down, NO fraud check will work. Retrying just adds load.

**Use both** when: you want retry for transient blips AND circuit breaker for sustained failures. But ORDER MATTERS: retry INSIDE the circuit breaker, not outside. If the breaker is OPEN, retry sees "rejected by breaker" and retries → self-inflicted retry storm. The correct composition: circuit breaker wraps retry."

### ❗ Common Pitfall: "The circuit breaker opened, but downstream was healthy — it was a transient blip"

**The trap:** You set `failureRateThreshold=20%`, `slidingWindowSize=20`, `minimumNumberOfCalls=5`. Under normal load (10 RPS), 4 out of the last 20 calls time out because of a GC pause in your own service. The breaker opens. For the next 30 seconds, ALL traffic is rejected — 300 requests fail-fast. The root cause was a 500ms GC pause in YOUR service, not a downstream outage.

**Why this happens:** The circuit breaker is **caller-side**. It observes failures from the caller's perspective, which includes:
- Downstream failures (what you want to detect)
- Network failures between caller and downstream (partially want to detect)
- Caller-side problems (GC pauses, CPU starvation, thread exhaustion — NOT what you want to detect as "downstream failure")

**The fix:**

1. **Distinguish failure types.** Don't trip the breaker on `java.net.SocketTimeoutException` from your own HTTP client's read timeout if the read timeout is shorter than the downstream's actual processing time. Set timeouts deliberately — a read timeout of 2s when downstream P99 is 1.8s will trip falsely on normal P99 variation.

2. **Use `slowCallRateThreshold` as the primary trip mechanism.** A slow call means the downstream IS responding, just slowly. This filters out caller-side timeouts (where no response arrives at all due to caller issues). Set `slowCallDurationThreshold` to 2× downstream P50, not P99 — you want to detect degradation early.

3. **Correlate breaker state with downstream health metrics.** Don't trust the breaker alone. If the breaker is OPEN but downstream metrics (from its own `/health` or Prometheus endpoint) show healthy, suppress the page and investigate caller-side issues.

4. **Add a `minimumNumberOfCalls` that's statistically meaningful.** 5 calls out of 5 = 100% failure rate but zero statistical significance. At 10 RPS with 100ms latency, 5 calls complete in 500ms — a single GC pause kills all 5. Use `minimumNumberOfCalls` >= 20, or use TIME_BASED window with 30s+ of data.

---

## 9. Architectural Decisions — Trade-Off Table

This is the table to have in your head during an interview. When the interviewer asks "why not just retry?" or "why thread pool instead of semaphore?", you should be able to walk this table:

| Decision | Option A | Option B | Why A Wins | When B Wins |
|----------|----------|----------|------------|-------------|
| **Circuit breaker vs. Retry-only** | Circuit Breaker | Retry-only | Prevents cascading failure in sustained outages | Transient failures only, lightweight |
| **Count-based vs. Time-based window** | COUNT_BASED (last N calls) | TIME_BASED (last T seconds) | Fast reaction at high traffic; predictable memory | Statistically meaningful at low traffic; predictable aging |
| **Thread pool vs. Semaphore bulkhead** | Thread Pool | Semaphore | Full isolation — slow dep can't exhaust threads | 30+ dependencies; low resource overhead |
| **Fail-fast vs. Fallback-first** | Fail-fast (reject + fallback) | Call fallback synchronously | Avoids fallback latency on OPEN circuit | Fallback is cheap (< 5ms) and always available |
| **Automatic vs. Manual HALF-OPEN → CLOSED** | Automatic (after N successes) | Manual (operator flips switch) | Hands-off operations; faster recovery | Systems where false recovery is catastrophic (payment ledgers) |
| **Breaker per endpoint vs. Breaker per service** | Per endpoint | Per service | Isolates failures; GET /health may work while POST /checkout fails | Simpler configuration; fewer breakers to tune |

---

## 10. Real-World Patterns Beyond the Basics

### 10.1 Partial Circuit Breaking

Not all requests to a downstream are equal. You might want to:
- **OPEN** the circuit for non-critical reads (GET /recommendations) while keeping it CLOSED for critical writes (POST /payment)
- **Route to a degraded endpoint:** Pattern matching — if POST /fraud/advanced fails, fall back to POST /fraud/basic (simpler model, lower accuracy, but doesn't block payments)

### 10.2 Adaptive Thresholds

Static thresholds (`failureRateThreshold=50`) are fragile. Adaptive approaches:
- **Percentile-based:** Open when P99 latency exceeds 5× P50 latency for 3 consecutive windows
- **Consecutive-failure count:** Open on 5 consecutive failures, regardless of rate. Simple, effective, no window math.
- **Increasing threshold on recovery:** After reopening, start with a lower threshold (e.g., 10% failure rate trips back to OPEN) and gradually normalize to 50% as confidence builds.

### 10.3 Chaos: Circuit Breaker Testing Gap

The #1 un-tested resilience pattern: nobody tests that circuit breakers actually WORK. Common failures:
- Breaker configured but `ignoreExceptions` catches the real exception type
- Breaker scoped to the wrong bean/method (Spring AOP proxy issue)
- Retry exhausting its attempts before the breaker sees enough failures to open
- Two breakers on the same dependency with different thresholds creating inconsistent behavior

**The staff answer:** Run Game Days where you deliberately break downstream services and verify that (a) breakers open within the expected time, (b) fallbacks activate correctly, (c) recovery happens automatically, and (d) the on-call engineer can interpret the dashboard correctly.

---

## 11. Key Takeaways

1. **Circuit breakers reveal problems, they don't solve them.** The breaker stopping cascading failure is temporary — the permanent fix is diagnosing and resolving the downstream issue. Don't let the breaker become a crutch.

2. **Compose patterns in the right order:** Bulkhead → Circuit Breaker → Time Limiter → Retry → Fallback. Wrong ordering creates self-inflicted failures.

3. **Thread pool isolation is the nuclear option.** Use it for critical paths where a blocked thread is unacceptable. For everything else, semaphores are lighter and sufficient.

4. **Slow calls, not hard failures, are the real threat.** A downstream that consistently returns 500s is obvious. A downstream whose P99 creeps from 200ms to 2s is invisible until every connection pool is exhausted. `slowCallRateThreshold` is your most important tuning parameter.

5. **The circuit breaker is caller-side — it's biased.** It can't distinguish between "downstream is slow" and "my own service had a GC pause." Design your monitoring to correlate breaker state with downstream health metrics before paging.

6. **HALF-OPEN is the hardest state to get right.** Too many probes overwhelms recovery. Too few probes never closes. Test your recovery behavior under load, not in isolation.

7. **Staff-level reframe:** Don't ask "should I use a circuit breaker or a retry?" Ask "**what is the failure mode I'm designing for, what is the blast radius of that failure, and what combination of patterns limits the blast radius to an acceptable level while preserving the user experience?**" The patterns are tools; the resilience architecture is the answer.

---

## Related
- [[topic-queue]]
- [[Rate Limiter]]
- [[Rate Limiting Algorithms Deep Dive]]
- [[Chaos Engineering (Failure Injection, Game Days)]]
- [[Service Mesh (Istio-Linkerd)]]
- [[API Gateway & Load Balancer]]
- [[Weakness Vault/Day-43-Circuit-Breakers-Bulkheads]]

## Interview Cheat Sheet

**Key Points to Remember:**
- Circuit breakers have three states — CLOSED (normal), OPEN (fail-fast), HALF-OPEN (probing). The breaker is a canary that reveals problems, not a cure.
- Order your resilience stack correctly: Bulkhead → Circuit Breaker → Time Limiter → Retry → Fallback. Putting retry outside the breaker causes self-inflicted retry storms.
- Slow calls (latency degradation) are the real threat, not hard failures. Use `slowCallRateThreshold` as your primary trip — a downstream whose P99 creeps from 200ms to 2s is invisible until every connection pool is exhausted.
- The circuit breaker is caller-side and biased — it can't distinguish "downstream is slow" from "my own service had a GC pause." Correlate breaker state with downstream health metrics before paging.
- Thread pool isolation gives full isolation (a blocked thread can't starve other deps); semaphores are lighter but leaky. Use thread pools for critical paths, semaphores when you have 30+ dependencies.

**Common Follow-Up Questions:**
- *What's the difference between a circuit breaker and a retry?* — A breaker prevents calls from being made (fail-fast); a retry repeats calls that were made. Use retry for transient blips, breaker for sustained failures, and both together with retry *inside* the breaker.
- *How do you tune the sliding window?* — Choose the window that gives a statistically significant sample at your P50 traffic volume: COUNT_BASED for high RPS, TIME_BASED for low/bursty RPS. Always set `minimumNumberOfCalls` high enough to avoid flapping on GC pauses.
- *When thread pool vs semaphore bulkhead?* — Thread pool for critical paths where a blocked thread is unacceptable; semaphore for many dependencies or constrained resources (serverless) where thread overhead matters.

**Gotcha:**
- People assume the circuit breaker detects *downstream* failures, but it's caller-side and also trips on your own GC pauses, CPU starvation, or misconfigured timeouts. A read timeout shorter than the downstream's P99 will open the breaker on perfectly healthy traffic.
