---
title: "Multi-Region Active-Active (Geo-replication, Conflict Resolution)"
type: system-design
category: Platform
date: 2026-06-07
tags: [system-design, interview, platform, multi-region, active-active, geo-replication, conflict-resolution, consistency]
aliases: ["Multi-Region Active-Active", "Geo-replication", "Conflict Resolution", "Active-Active Architecture", "Multi-Master"]
---

# Multi-Region Active-Active (Geo-replication, Conflict Resolution)

> **Staff-Engineer Focus:** Multi-region active-active is not "run the same app in two regions and put a global load balancer in front." It's a deep architectural commitment that touches your data layer, your consistency model, your application logic, and your incident response. The interview question isn't "what is active-active" — it's "your VP wants active-active for the payment system. Walk me through the top 5 things that will break and how you'd prevent them." At the staff level, you're not drawing boxes — you're enumerating failure modes and designing countermeasures.

---

## Summary & Interview Framing

Running a system in multiple regions simultaneously, all serving live traffic and accepting writes, with conflict resolution for concurrent updates.

**How it's asked:** "Design a multi-region active-active system for a global e-commerce platform. Handle conflict resolution, replication lag, split-brain, and the CAP trade-offs."

---

## 1. What Problem Does Multi-Region Active-Active Solve?

Single-region deployments have a single point of failure: the region itself. When us-east-1 goes down (and it will — AWS has had 6 major us-east-1 outages since 2017), every user on the planet experiences a full outage, even if they're sitting in Tokyo.

**Multi-region active-active means:**
- Multiple regions serve live production traffic simultaneously
- A user in Singapore hits ap-southeast-1; a user in Frankfurt hits eu-central-1
- If one region fails, traffic shifts to surviving regions with minimal disruption
- **The hard part:** both regions can accept writes concurrently

### The Deployment Spectrum

| Architecture | Reads | Writes | Failover Time | Data Loss Risk | Complexity |
|-------------|-------|--------|---------------|----------------|------------|
| **Single-Region** | 1 region | 1 region | Hours (manual) | High | Low |
| **Active-Passive (Hot Standby)** | 1 region | 1 region | Minutes (automated) | Some (replication lag) | Medium |
| **Active-Active (Reads Only)** | All regions | 1 region | Seconds | Low | Medium |
| **Active-Active (Reads + Writes)** | All regions | All regions | Sub-second | Depends on conflict resolution | **Very High** |

**The core tension:** Every step toward better availability increases the probability of data conflicts. Active-active with writes in multiple regions means the same record CAN be modified simultaneously in Tokyo and Frankfurt. The question is: what do you do when it happens?

---

## 2. Key Requirements

### Functional Requirements
- Users in any region read and write data with region-local latency
- During a regional outage, all remaining regions continue full read+write operations
- Conflicting writes are resolved without data loss and without human intervention
- The system provides a clear consistency guarantee to developers (not "it depends")

### Non-Functional Requirements (SLAs)

| Requirement | Target | Why It's Hard |
|------------|--------|---------------|
| **Availability** | 99.995% ("four nines five") | Requires surviving multi-region failures. A single region at 99.9% achieves 99.7% after one failover. |
| **Write Latency (p99)** | < 50ms regional, < 300ms cross-region | Speed of light: Tokyo→Frankfurt is ~250ms RTT minimum. You can't beat physics. |
| **Recovery Point Objective (RPO)** | < 1 second | Data written in Region A must be visible in Region B within 1s — or you risk reading stale data after failover. |
| **Recovery Time Objective (RTO)** | < 5 seconds | Automated failover must redirect traffic before users notice. |
| **Conflict Rate** | < 0.001% of writes | If 1 in 100,000 writes conflict, and you do 100K writes/sec, that's 1 conflict/sec — your resolution path is now a hot path. |
| **Consistency Model** | Tunable (strong for payments, eventual for profiles) | One system, multiple consistency requirements. |


## 3. Capacity Planning

| Metric | Per-Region Estimate | Global Estimate |
|--------|---------------------|-----------------|
| **DAU** | 10M | 50M (5 regions) |
| **Write RPS** | 5K | 25K |
| **Read RPS** | 50K | 250K |
| **Storage (per region)** | 50 TB | 250 TB (replicated) |
| **Cross-Region Bandwidth** | N/A | 10 Gbps (replication traffic) |
| **Conflict Rate (estimated)** | 0.0005% of writes | ~75 conflicts/day |


## 4. The Speed of Light Problem

You cannot discuss multi-region architecture without acknowledging physics. The speed of light in fiber is ~200,000 km/s (about 2/3 of vacuum speed).

| Region Pair | Approximate Distance | Minimum RTT (physics) | Real RTT (network) |
|------------|---------------------|----------------------|-------------------|
| us-east-1 ↔ us-west-2 | 4,500 km | 45 ms | 60-70 ms |
| us-east-1 ↔ eu-west-1 | 6,500 km | 65 ms | 80-100 ms |
| us-west-2 ↔ ap-southeast-1 | 14,000 km | 140 ms | 180-200 ms |
| eu-west-1 ↔ ap-northeast-1 | 9,500 km | 95 ms | 220-280 ms (routing) |

**Implication:** Synchronous replication across continents is physically impossible at interactive latencies. If you require a write to be confirmed in Tokyo AND Frankfurt before returning to the user, that user waits 300ms minimum. For comparison: Amazon found that every 100ms of latency costs them 1% in sales.

**The architectural conclusion:** Cross-region replication MUST be asynchronous for any system that serves interactive users. Synchronous replication is only viable within a metro area (< 10ms RTT, e.g., multi-AZ within a single region).

---

## 5. Core Architecture Patterns

### 5.1 Global DNS + Regional Stacks

```
                          ┌──────────────────────┐
                          │   Route 53 / Cloud DNS │
                          │   (Latency-Based Routing)│
                          └──────┬───────┬───────┘
                                 │       │
                    ┌────────────┘       └────────────┐
                    ▼                                  ▼
        ┌──────────────────────┐        ┌──────────────────────┐
        │   Region A (us-east) │        │   Region B (eu-west) │
        │                      │        │                      │
        │  ┌────────────────┐  │        │  ┌────────────────┐  │
        │  │   API Gateway  │  │        │  │   API Gateway  │  │
        │  └───────┬────────┘  │        │  └───────┬────────┘  │
        │          │            │        │          │            │
        │  ┌───────▼────────┐  │        │  ┌───────▼────────┐  │
        │  │  App Servers   │  │        │  │  App Servers   │  │
        │  └───┬───────┬────┘  │        │  └───┬───────┬────┘  │
        │      │       │       │        │      │       │       │
        │  ┌───▼──┐ ┌──▼────┐ │        │  ┌───▼──┐ ┌──▼────┐ │
        │  │  DB  │ │ Redis │ │        │  │  DB  │ │ Redis │ │
        │  │(Write)│ │(Cache)│ │        │  │(Write)│ │(Cache)│ │
        │  └──┬───┘ └───────┘ │        │  └──┬───┘ └───────┘ │
        │     │                │        │     │                │
        └─────┼────────────────┘        └─────┼────────────────┘
              │                                │
              │    ┌──────────────────────┐    │
              └────┤  Async Replication  ├────┘
                   │  (CDC / Binlog /    │
                   │   Event Stream)     │
                   └──────────────────────┘
```

Every region is a fully self-contained stack — API gateway, application servers, database (accepting writes), cache. No region depends on another for core operation. Cross-region communication happens through an async replication channel.

### 5.2 The Write Path — Conflict-Aware

```
User in Tokyo writes "status: shipped"

  1. API Gateway → Tokyo App Server
  2. Tokyo App Server → Tokyo DB (write locally, < 10ms)
  3. User gets 200 OK immediately (not waiting for replication)
  4. Tokyo DB → CDC stream → Event Bus (Kafka)
  5. Kafka → Frankfurt Consumer → Frankfurt DB (apply write)
  6. Frankfurt DB detects: "this record was also modified in
     Frankfurt 50ms ago → CONFLICT"
  7. Conflict resolver runs → merged record written
```

**Key observation:** The user NEVER waits for cross-region replication. The local write returns immediately. The conflict is resolved asynchronously. This is the fundamental performance trick of active-active: optimistic writes with post-hoc conflict resolution.

---

## 6. Conflict Resolution Strategies

This is the hardest problem in active-active architecture. Here are the options, ranked by complexity:

### 6.1 Last-Write-Wins (LWW) — The Simple Default

Every write carries a timestamp (or logical clock). When a conflict is detected, the write with the latest timestamp wins. The older write is silently discarded.

```
Tokyo:  {user: "alice", status: "shipped", ts: 1001}
Frankfurt: {user: "alice", status: "cancelled", ts: 1000}
→ Tokyo's write wins. Frankfurt's "cancelled" is LOST.
```

**When to use:** Immutable or append-only data (logs, metrics, clickstream), single-writer-per-record patterns (user always hits same region), data where "latest is correct" holds (sensor readings, heartbeats).

**When NOT to use:** Financial transactions (losing a "cancel" is unacceptable), multi-field records where partial merge is needed, user-facing data where silent data loss erodes trust.

### 6.2 CRDTs (Conflict-Free Replicated Data Types)

CRDTs are mathematical data structures that guarantee convergence — no matter what order updates arrive, all replicas eventually reach the same state. They achieve this by making all operations **commutative** (order doesn't matter).

| CRDT Type | Example | Merge Strategy | Use Case |
|-----------|---------|----------------|----------|
| **G-Counter** (Grow-only) | `inc()` only | max(replicas) | Like counts, page views |
| **PN-Counter** (Positive-Negative) | `inc()`, `dec()` | merge P-counters and N-counters separately | Inventory count, voting |
| **G-Set** (Grow-only Set) | `add()` only | union of all sets | Unique visitors, tags |
| **2P-Set** (Two-Phase Set) | `add()`, `remove()` | added - removed | Group membership |
| **OR-Set** (Observed-Remove Set) | `add()`, `remove()` with tags | union of additions minus removed-by-all | Shopping cart, playlist |
| **LWW-Register** | `assign(value, time)` | latest timestamp wins | User profile fields |
| **MV-Register** (Multi-Value) | `assign(value)` | keeps all concurrent values | Collaborative text |

**CRDT Shopping Cart Example:**

```
Tokyo:      cart = {itemA, itemB}
Frankfurt:  cart = {itemA, itemC}

Both regions: OR-Set merge → {itemA, itemB, itemC}
(All additions preserved. Removals tracked by unique tags.)
```

**Trade-off:** CRDTs have metadata overhead (vector clocks, unique tags) and don't work for all data types (bank balances where order matters, unique constraints like usernames). They're excellent for collaborative editing, shopping carts, and multi-player state — domains where concurrent edits are expected and merging is natural.

### 6.3 Vector Clocks + Application-Level Merge

A vector clock tracks the causal history of each write: `{RegionA: 3, RegionB: 2}` means "this record has seen 3 writes in A and 2 in B."

```
Record X:
  Tokyo:    {vc: {TKO: 5, FRA: 2}, status: "shipped"}
  Frankfurt: {vc: {TKO: 4, FRA: 3}, status: "cancelled"}

Conflict detection:
  TKO(5) > FRA(4) but FRA(3) > TKO(2) → CONCURRENT (neither happened-before the other)

Resolution options:
  a) Application callback: "status conflict — keep 'cancelled' if exists"
  b) Multi-value register: keep both, surface to user: "Your order was
     both shipped and cancelled. Contact support."
  c) Retain both versions with a merge flag for an async reconciliation job
```

**When to use:** Systems where conflict resolution needs domain knowledge — an engineer writes a merge function that knows "cancelled beats shipped" or "higher bid beats lower bid." The infrastructure provides detection; the application provides resolution.

### 6.4 Strongly Consistent (Synchronous Replication) — The Expensive Option

Use a consensus protocol (Raft/Paxos) to synchronously replicate writes across regions before acknowledging to the user. This eliminates conflicts entirely — but at the cost of cross-region latency on every write.

**Use case:** Payment ledgers, account balances, any system where consistency trumps latency. Typically achieved with:
- **Spanner/Cloud Spanner:** TrueTime API provides globally-consistent externalized commits with < 10ms uncertainty
- **CockroachDB:** Serializability across regions using hybrid logical clocks
- **YugabyteDB:** Synchronous replication with tunable geo-partitioning

**The real-world pattern:** Most systems use a hybrid. Payment writes go to a globally-consistent DB (conflict-free but higher latency). Everything else — user profiles, activity feeds, analytics — uses async replication with CRDTs or LWW.

---

## 7. Replication Strategies

### 7.1 Database-Native Multi-Master

Some databases support multi-master replication natively:

| Database | Multi-Master Support | Conflict Resolution | Best For |
|----------|---------------------|---------------------|----------|
| **Cassandra** | Yes (multi-DC) | LWW (timestamp), tunable consistency per query | High-write, eventually-consistent workloads |
| **DynamoDB Global Tables** | Yes (managed) | LWW (last writer wins) | Key-value, serverless workloads |
| **CockroachDB** | Yes (by design) | Serializable isolation (no conflicts) | OLTP with strong consistency requirements |
| **PostgreSQL** | Via extensions (BDR, pglogical) | Configurable (LWW, custom conflict handlers, earliest/latest timestamp) | SQL-heavy apps with active-active needs |
| **MongoDB** | Yes (replica sets across regions) | LWW (timestamp) | Document-model apps |
| **MySQL** | Via Group Replication / InnoDB Cluster | First-committer-wins (rollback on conflict) | Traditional RDBMS workloads |

**BDR (Bi-Directional Replication) for PostgreSQL — Conflict Handler Example:**

```sql
-- Custom conflict handler: "latest timestamp wins, but never lose a 'cancelled'"
CREATE OR REPLACE FUNCTION order_conflict_handler(
  local_row orders,
  remote_row orders
) RETURNS orders AS $$
BEGIN
  -- Rule 1: "cancelled" always wins regardless of timestamp
  IF remote_row.status = 'cancelled' THEN
    RETURN remote_row;
  END IF;
  -- Rule 2: Otherwise, latest timestamp wins
  IF remote_row.updated_at > local_row.updated_at THEN
    RETURN remote_row;
  END IF;
  RETURN local_row;
END;
$$ LANGUAGE plpgsql;
```

### 7.2 Change Data Capture (CDC) — The Application-Level Approach

Instead of database-native replication, stream change events through a message bus:

```
Region A writes to PostgreSQL
      ↓
Debezium CDC connector reads WAL → Kafka topic: "db.orders.cdc"
      ↓
Region B consumer reads Kafka → applies to Region B PostgreSQL
      ↓
Conflict detector checks: "was this record modified locally
                         since the last applied remote write?"
      ↓
Yes → conflict resolver runs (CRDT / vector clock / app logic)
No  → applied cleanly
```

**Advantages of CDC over DB-native replication:**
- Database-agnostic (works with PostgreSQL, MySQL, MongoDB, etc.)
- Transformation logic between regions (schema evolution, data masking for GDPR)
- Full audit log of every change (Kafka retention)
- Dead-letter queue for failed/unresolvable conflicts
- Can fan-out to multiple consumers (update search index, invalidate CDN cache, trigger notifications)

**Disadvantages:**
- Additional infrastructure (Kafka, Debezium, consumers)
- Higher replication lag (CDC → Kafka → consumer adds 100-500ms)
- Schema changes must be coordinated (or handled with schema registry)

---

## 8. Consistency Models in Practice

Active-active forces you to be precise about consistency. "Eventual consistency" is not precise enough.

### The Consistency Ladder

| Level | Guarantee | Latency | When to Use |
|-------|-----------|---------|-------------|
| **Strong** | All regions see the same value at the same logical time | Cross-region RTT | Payment ledgers, inventory deduplication |
| **Sequential** | All regions see writes in the same order (but not necessarily at the same time) | Regional + replication lag | Order state machine transitions |
| **Causal** | If A happens-before B, all regions see A before B. Concurrent writes may appear in any order. | Regional + vector clock propagation | Social media comments, chat messages |
| **Eventual** | If no new writes, all regions eventually converge to the same state | Unbounded (typically seconds) | User profiles, preferences, analytics |
| **Read-Your-Own-Writes** | A user always sees their own writes, even if other users don't yet | Regional (sticky session) | User settings, draft documents |
| **Monotonic Reads** | A user never sees data "go backwards" (never reads a value older than one they've already seen) | Regional + read-repair | Timeline, activity feeds |

**The staff-level skill:** You don't pick ONE consistency model. You partition your data and apply different models per partition. Payment transactions = strong. User display names = eventual. Shopping cart contents = read-your-own-writes.

---

## 9. Caching Strategy for Multi-Region

Caching in active-active is harder than single-region because cache invalidation must be globally coordinated.

### 9.1 Regional Redis + TTL-Based Invalidation

```
Each region has its own Redis cluster.
Warm on read: cache miss → load from local DB → populate Redis
Invalidation: set short TTL (30s-5min) and accept stale reads
               OR broadcast invalidation via cross-region channel
```

**Staleness budget:** If your TTL is 30s and replication lag is 500ms, the worst-case staleness for a cached value is 30.5s. Is that acceptable? For product descriptions: yes. For inventory counts on Black Friday: absolutely not.

### 9.2 Write-Through with Cross-Region Invalidation

```
User writes in Tokyo:
  1. Write to Tokyo DB
  2. Invalidate Tokyo Redis key (local)
  3. Publish invalidation event to Kafka
  4. Frankfurt consumer receives event → invalidates Frankfurt Redis key
```

### 9.3 CDN at the Edge

| CDN Tier | What It Caches | TTL | Invalidation |
|----------|---------------|-----|-------------|
| **Edge (CloudFront, Cloudflare)** | Static assets, API responses (GET only) | 1h-24h | Cache-busting URLs, purge API |
| **Regional (in-app Redis)** | DB query results, computed objects | 30s-5min | Write-through + pub/sub |
| **Local (in-process LRU)** | Hot config, feature flags | 5min-1h | Poll for updates |

**Golden rule for active-active caching:** Never cache data that another region might be simultaneously modifying unless you've built explicit invalidation that covers the replication lag window.

---

## 10. Failure Modes & Mitigations

### 10.1 Split-Brain — Both Regions Think They're Primary

```
Scenario: Network partition between us-east-1 and eu-west-1.
Both regions are fully functional locally but can't talk to each other.

Problem: Both accept writes. When the partition heals, you have
DIVERGENT histories with no causal relationship.
```

**Mitigations:**
- **Witness/Tiebreaker node:** A lightweight third region (or cloud region) that breaks ties. Both regions check "can I reach the witness?" — only ONE can be primary if the witness is reachable.
- **Quorum-based consensus:** Use Raft across 3+ regions. A write requires majority acknowledgment. With 5 regions, you can lose 2 and still achieve consensus.
- **Fencing tokens:** Each write carries a monotonically increasing token. After partition heals, the region with the lower token knows it was isolated and discards its writes (or marks them as tentative).

### 10.2 Replication Lag Cascading

```
Tokyo writes a record → 500ms to reach Frankfurt
Frankfurt reads the record (stale) → makes a decision based on stale data
→ writes a conflicting record → BOTH writes are now wrong
```

**Mitigation:** Read-after-write consistency for the same user (sticky sessions to the same region). Cross-region reads must carry a "minimum freshness" requirement: "give me the record, but only if it's at most 1 second stale."

### 10.3 Thundering Herd on Region Recovery

```
Region A goes down for 10 minutes.
All traffic shifts to Region B (now handling 2x load).
Region A recovers → all users reconnect simultaneously → 2x traffic surge.
```

**Mitigation:** Gradual traffic ramp (not instantaneous failback). Health-check Region A with shadow traffic for 2 minutes. Then shift 10% → 50% → 100% over 5 minutes. Circuit-breaker on Region A during ramp: if error rate > threshold, abort ramp and stay on Region B.

---

## 11. Observability — Multi-Region Metrics

Single-region monitoring doesn't cut it. You need cross-region comparisons:

| Metric | Why It Matters |
|--------|---------------|
| **Replication Lag (p50, p95, p99)** | If lag exceeds your RPO, you're violating your SLA |
| **Conflict Rate (by record type)** | Rising conflict rate = growing divergence. Investigate before data loss. |
| **Cross-Region Write Latency** | Are writes propagating? Is a region silently partitioned? |
| **Cross-Region Consumer Lag** | CDC consumers falling behind? Kafka lag growing? |
| **Traffic Distribution (%)** | Is traffic balanced? Or has one region taken all load (DNS misconfig)? |
| **Per-Region Error Rate** | A spike in one region but not others = localized problem, not global outage |
| **TTD (Time to Detect) per region** | How fast does the surviving region detect the failed one? |
| **Stale Read Rate** | How often do users read data older than the replication lag window? |

**Dashboard layout:** A 4-panel dashboard showing the same metrics for each region side-by-side. Anomaly in one panel = regional issue. Anomaly in all panels = global issue. Without this layout, you waste critical minutes determining scope during an incident.

---

## 12. Sharp Question + Model Answer

### The Question

> **"You're designing a multi-region active-active architecture for an e-commerce platform. The product catalog is relatively static, but the inventory count changes with every order. The VP of Engineering insists that inventory MUST be accurate — no overselling. How do you handle inventory in active-active?"**

### Model Answer

**"Inventory is the hardest problem in active-active e-commerce. You cannot have fast writes AND perfect accuracy across regions — you must pick one. Here's the approach:**

**Tier 1 — Global Inventory Authority (Single Writer):**
For high-value, low-quantity items (limited edition sneakers, concert tickets), I'd use a single-region inventory authority with synchronous confirmation. Every purchase — regardless of which region the user hits — fans out to the inventory authority region for a synchronous decrement. This adds 100-200ms latency to the checkout for distant users, but guarantees no overselling. I'd cache the 'available/out-of-stock' status in all regions with a 10-second TTL, but the actual decrement is always synchronous to the authority.

**Tier 2 — Regional Inventory Pools (Pre-Allocated):**
For commodity items (phone chargers, books), I'd pre-allocate inventory pools to each region: Region A gets 500 units, Region B gets 500 units. Each region sells from its own pool. When a pool reaches 20%, it requests a top-up from a central pool (async). This is how airlines handle seat inventory — each sales channel gets an allocation. No conflicts because no region touches another region's pool.

**Tier 3 — Oversell Tolerance Model:**
For items where overselling is acceptable within a small margin (error rate < 0.1%), use local writes with async replication and a reconciliation job that detects oversells within 30 seconds. If an oversell is detected, automatically cancel the newer order and issue an automatic refund + $10 credit. The cost of the credit is cheaper than the cost of synchronous writes across regions.

**The key insight:** I'm not solving 'active-active inventory' as one problem. I'm partitioning inventory into three tiers based on oversell tolerance and applying different consistency guarantees to each. This is the staff-level answer — tiered consistency based on business impact, not a one-size-fits-all technical solution."

### Common Pitfall

❌ **Pitfall:** "Use DynamoDB Global Tables with last-write-wins — it handles multi-region automatically and we don't need to worry about conflicts."

**Why it's wrong:** This is the classic "let the database solve it" trap. DynamoDB Global Tables uses LWW conflict resolution. When two regions decrement inventory from 5 → 4 simultaneously, both writes have different timestamps. One "wins." The other is silently discarded. The database reports inventory = 4, but TWO units were sold. You just oversold and have no record of it. This answer demonstrates a dangerous pattern: assuming managed services abstract away the hard distributed systems problems. They don't. They abstract the infrastructure — not the semantics.

✅ **The fix:** "For inventory specifically, LWW is not safe because the decrement operation is not idempotent and not commutative. [Discuss tiered approach above.] Use DynamoDB Global Tables for the product catalog and user profiles where eventual consistency is acceptable. Keep inventory writes synchronous to a single-region authority or use a CRDT-based PN-Counter with transaction verification."

---

## 13. Interview Curveball Questions

> **"How would you test a multi-region active-active system before going live?"**

**Answer:** Three stages. **Stage 1 — Shadow traffic:** Mirror 1% of production traffic to the new region. Compare responses between regions. Log every divergence. Fix until divergence rate < 0.01%. **Stage 2 — Internal dogfooding:** Route all company employees to the new region for 1 week. They'll find bugs real users would hit. **Stage 3 — Gradual ramp:** 1% → 5% → 25% → 50% → 100% of real users. Monitor conflict rate, latency, error rate at every step. If conflict rate spikes at 5%, STOP the ramp. The ramp plan should be pre-written with explicit stop conditions — not decided in the moment.

> **"What happens if a user in Frankfurt writes data, immediately flies to Tokyo, and reads the same data 30 seconds later?"**

**Answer:** This is the "globetrotter problem" — a read-after-write consistency challenge across regions. Without sticky routing, the user in Tokyo might hit the Tokyo region and see stale data (the Frankfurt write hasn't replicated yet). Solutions: (1) Cookie-based region affinity — the user's session cookie includes their "home region" and reads are forwarded there if freshness is critical. (2) Read-after-write token — the write response includes a token (LSN, timestamp) that the user sends with their next read. The Tokyo region checks: "Has replication caught up to this token? If not, wait or forward to Frankfurt." (3) CRDT-based data — the read always returns the merged state, so the user at least sees their own write even if they don't see other concurrent writes.

> **"Multi-region active-active is expensive. When would you recommend against it?"**

**Answer:** When (1) your user base is geographically concentrated (90% in one country) — CDN + single-region + hot standby gives you 99.95% availability at 1/3 the cost. (2) Your data has strong mutual consistency requirements (double-entry bookkeeping where every credit must balance a debit) — the conflict resolution complexity will consume your engineering team. (3) Your RTO is > 1 hour — if your business can tolerate 1 hour of downtime, active-passive failover is cheaper and simpler. (4) Your team has never operated a single region reliably — active-active multiplies operational complexity. Walk before you run. **The staff-level answer:** Active-active is a tool in your reliability toolbox, not a moral imperative. The right architecture is the simplest one that meets your SLOs. Sometimes that's active-passive. Sometimes that's "fix your single-region reliability first."

> **"How does GDPR data residency interact with active-active architecture?"**

**Answer:** This is where active-active gets legally complicated. GDPR Article 45 restricts cross-border data transfers. If you replicate EU user data to a US region, you need Standard Contractual Clauses (SCCs) or an adequacy decision. The architectural answer: **Data locality sharding.** EU user data is pinned to EU regions. US user data is pinned to US regions. APAC user data to APAC regions. Cross-region replication runs within legal boundaries (EU→EU, US→US) but not across them (EU→US is blocked). This means: (1) Your user-to-region mapping is now a legal constraint, not just a latency optimization. (2) An EU user traveling to the US must still read from EU regions (adds latency, but legally required). (3) Your conflict resolution is simpler because data isn't replicated globally — but your disaster recovery now requires a backup region within the same legal boundary.

---

## 14. Key Metrics Summary

| Metric | Healthy Threshold | Investigate | Critical |
|--------|------------------|-------------|----------|
| **Replication Lag (p99)** | < 1s | 1-5s | > 5s |
| **Conflict Rate** | < 0.001% | 0.001-0.01% | > 0.01% |
| **Cross-Region Bandwidth Saturation** | < 50% | 50-80% | > 80% |
| **Per-Region Error Rate** | < 0.01% | 0.01-0.1% | > 0.1% |
| **Failover Time (RTO)** | < 5s | 5-30s | > 30s |
| **CDC Consumer Lag** | < 500ms | 500ms-5s | > 5s |
| **Traffic Imbalance** | ±10% from target | ±25% | ±50% (DNS fail) |

---

## Key Takeaway

**Multi-region active-active is the most expensive reliability pattern you can deploy — not in infrastructure cost (though that's significant), but in engineering complexity.** Every active-active system is a bet: "the probability of a regional outage multiplied by the cost of that outage exceeds the cost of building and operating active-active." For a payment system processing $10M/hour, that bet pays off quickly. For an internal dashboard, it doesn't.

The staff-level skill is not just designing the architecture — it's knowing when active-active is the right answer and when it's resume-driven development. The three hardest problems, in order: (1) Conflict resolution at the application layer (the only layer that understands business semantics). (2) Observability that tells you which region is authoritative when they disagree. (3) Operational readiness — your runbooks must handle a regional failover smoothly because if you've invested in active-active and still have a 30-minute RTO, you've built an expensive monument to poor execution.

**If you remember one thing:** Active-active doesn't eliminate failure — it shifts failure from "the system is down" to "the system has conflicting data." Which failure mode is worse for YOUR application? Answer that before you build anything.

---

## Related
- [[topic-queue]]
- [[Two-Phase Commit & Consensus (Raft-Paxos)]]
- [[Consistent Hashing]]
- [[Database Sharding & Replication]]
- [[CDN & Edge Computing]]
- [[Circuit Breakers & Bulkheads]]
- [[Weakness Vault/Day-35-Multi-Region-Active-Active]]

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Active-active means all regions serve live traffic and accept writes — not just reads
- Conflict resolution strategies: last-writer-wins (LWW), CRDTs, application-level merge, or avoid conflicts via data partitioning
- Replication latency between regions is bounded by physics — 50-150ms cross-continent
- Clock skew is the enemy — use NTP, hybrid logical clocks (HLC), or TrueTime (Spanner) for ordering
- Cost is 2-3x a single-region deployment — it's an availability investment, not a performance one

**Common Follow-Up Questions:**
- "When would you choose active-passive over active-active?" — When write volume is low, conflict resolution is complex, or budget is constrained. Active-passive is simpler but has RTO.
- "How do you handle a split-brain between two regions?" — Use a consensus-based fencing mechanism (e.g., ZooKeeper quorum) to ensure only one region accepts writes during a partition. The other region goes read-only.

**Gotcha:**
- Multi-region active-active does not eliminate downtime — it moves the failure mode from "region is down" to "conflict resolution is wrong." A bad merge function can silently corrupt data across all regions, which is worse than a regional outage.
