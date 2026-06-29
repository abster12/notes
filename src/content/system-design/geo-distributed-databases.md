---
title: "Geo-Distributed Databases (CockroachDB, Spanner, Fauna)"
type: system-design
category: Platform
date: 2026-06-14
tags: [system-design, interview, platform, geo-distributed, spanner, cockroachdb, fauna, truetime, hlc, cap, consistency, replication, multi-region, paxos, raft, strict-serializability, external-consistency, distributed-transactions]
aliases: ["Geo-Distributed Databases", "Geo-Distributed Databases (CockroachDB, Spanner, Fauna)", "CockroachDB Internals", "Spanner Internals", "Fauna Internals", "Global Database Design", "Multi-Region Database"]
---

# Geo-Distributed Databases (CockroachDB, Spanner, Fauna)

> **Staff-Engineer Focus:** "Use Spanner if you need strong consistency across regions" is the senior answer. Understanding that Spanner achieves this via atomic clocks and TrueTime while CockroachDB approximates it with hybrid logical clocks — and that Fauna takes a completely different approach via deterministic transaction execution — is the staff answer. **Knowing exactly when TrueTime's uncertainty window silently degrades your P99 latency, when HLCs create anomalies that violate external consistency, and how to design your schema and application logic to tolerate the residual inconsistencies that NO geo-distributed database can eliminate — that's the staff engineer.** The interview question isn't "what is Spanner?" It's: "You're designing a global payments ledger that must process writes in 5 regions simultaneously with P99 latency < 100ms, zero data loss, and the ability to query any region for an up-to-date balance. Postgres sharded across regions can't do it. Cassandra eventually-consistent reads fail audit requirements. How do you design this — and what trade-off are you NOT telling me about?"

---

## Summary & Interview Framing

Databases that replicate data across continents while maintaining strong consistency — Spanner uses atomic clocks (TrueTime), CockroachDB uses hybrid logical clocks.

**How it's asked:** "Design a global payments ledger across 5 regions with P99 <100ms, zero data loss, and strong consistency. Compare Spanner, CockroachDB, and Cassandra approaches."

---

## 1. Why Geo-Distributed Databases Exist

The traditional three-tier architecture with a single-region primary database breaks at global scale for three reasons:

1. **Latency:** A user in Tokyo querying a database in Virginia pays 150ms RTT on every request. At scale, that 150ms compounds across queries, API calls, and user interactions — the app feels sluggish.
2. **Availability (Region Failure):** When us-east-1 goes down (it has, repeatedly: 2012, 2015, 2017, 2021), every user on every continent loses service. The database is a single point of geographic failure.
3. **Data Residency (Regulatory):** GDPR requires EU user data to stay in the EU. Schrems II invalidated Privacy Shield. Countries like India, Brazil, China, and Russia have data localization laws. A single-region database can't comply.

The solution appears simple: put replicas in multiple regions and let users read from the nearest one. But writes collide. Two users in different regions updating the same bank account balance simultaneously create conflicting states. The database MUST resolve these conflicts — and the resolution strategy determines every downstream property: correctness guarantees, latency, availability during partitions, and developer experience.

**The core tension of geo-distributed databases:** You can have low-latency writes OR strong consistency guarantees across regions, but not both simultaneously in the general case. Every geo-distributed database is a specific point on this spectrum.

```
                    Strong Consistency
                         ▲
                         │   Spanner (TrueTime)
                         │   CockroachDB (HLC + serializable)
                         │   Fauna (Calvin protocol)
                         │   YugabyteDB (HLC)
                         │   FoundationDB (strict serializable)
                         │
                         │   Cosmos DB (bounded staleness)
                         │   TiDB (snapshot isolation)
                         │
                         │   DynamoDB Global Tables (last-write-wins)
                         │   Cassandra (tunable consistency)
                         │   MongoDB (causal consistency)
                         ▼
                    Low Write Latency
```

The further up you go, the higher the write latency (inter-region RTT paid on commit). The further down, the more anomalies your application must handle.

---

## 2. The Problem: Why Regular Databases Break Across Regions

### 2.1 CAP Theorem Refresher

CAP: a distributed data store can provide at most two of {Consistency, Availability, Partition Tolerance} simultaneously. In a multi-region deployment, network partitions between regions are inevitable (transatlantic cable cuts happen ~200 times/year). So you MUST be partition-tolerant — which means you choose between:

- **CP (Consistent + Partition-tolerant):** During a partition, the minority partition stops accepting writes. Spanner, CockroachDB, Fauna.
- **AP (Available + Partition-tolerant):** Both sides of a partition accept writes; conflicts resolved later. DynamoDB Global Tables, Cassandra.

But the clean dichotomy is misleading. Real systems make subtler choices:

| System | During Partition | After Partition | Consistency Model |
|--------|-----------------|-----------------|-------------------|
| Spanner | Minority stops writes (CP) | No conflicts (everyone agrees) | External consistency |
| CockroachDB | Minority stops writes (CP) | No conflicts | Serializable |
| Fauna | Minority stops writes (CP) | No conflicts | Strict serializability |
| DynamoDB Global Tables | Both sides accept writes (AP) | Last-write-wins resolution | Eventual |
| Cosmos DB with Bounded Staleness | Both sides may accept reads | Configurable staleness window | Bounded staleness |

### 2.2 The Multi-Region Write Problem

```
Time ──────────────────────────────────────────────────────────────►

Region A (us-east)          Region B (eu-west)
     │                            │
     │  BEGIN                       │  BEGIN
     │  UPDATE accounts            │  UPDATE accounts
     │  SET balance = balance - 100 │  SET balance = balance - 100
     │  WHERE id = 'alice'         │  WHERE id = 'alice'
     │  COMMIT                     │  COMMIT
     │                            │
     ▼                            ▼
  balance = $400               balance = $400
  (both saw $500,              (both saw $500,
   subtracted $100)             subtracted $100)
```

Alice started with $500. Two concurrent withdrawals of $100 in different regions. Both read $500, both wrote $400. Alice has $400 instead of $300. This is a **write-write conflict** (lost update). A single-region database uses row locks or MVCC to serialize these — but locks across a 120ms transatlantic link are catastrophically slow.

### 2.3 The Clock Problem

Distributed transactions need a total order: which transaction happened "before" the other? In a single machine, the CPU clock answers this. Across regions, clocks drift. NTP keeps them within ~10-50ms of each other on a good day, but a bad day (NTP failure, VM migration, leap second) can produce seconds of drift.

If clocks disagree, transactions that happened simultaneously get assigned conflicting timestamps — breaking any total-order-based consistency protocol. This is the **clock uncertainty problem** and it's the defining challenge of geo-distributed databases.

---

## 3. Google Spanner — Atomic Clocks + TrueTime

### 3.1 The Core Idea

Spanner is Google's globally-distributed SQL database, described in the 2012 OSDI paper. Its breakthrough: instead of solving clock synchronization algorithmically, solve it with hardware. Google deploys GPS and atomic clocks in every Spanner datacenter. TrueTime is an API that gives:

```
TT.now() → [earliest, latest]
```

TrueTime GUARANTEES that absolute time lies within the interval `[earliest, latest]`. The uncertainty window ε = `latest - earliest` is typically **1-7ms**. This guarantee is the foundation of everything Spanner does.

### 3.2 How TrueTime Enables External Consistency

Spanner uses **Paxos** for replication across regions. Each Paxos group (a "tablet" or "split") has a leader. The leader assigns commit timestamps to transactions.

The commit protocol:

```
1. Coordinator acquires all necessary locks
2. Coordinator chooses a commit timestamp s = TT.now().latest
   (i.e., the UPPER bound of TrueTime's uncertainty window)
3. Coordinator waits for TT.after(s) — i.e., until TrueTime guarantees
   that the current time is > s. This is the "commit wait."
   Wait time = 2 × ε (the uncertainty window round-trip)
4. Coordinator releases locks; the transaction's effects are now visible
   at timestamp s

Guarantee: s > any timestamp assigned by any previous transaction.
Why: Because we chose s = latest, waited until TT.after(s),
      and any earlier transaction's timestamp was ≤ previous latest
      which is < current earliest (since TrueTime advances monotonically).
```

The commit wait is typically **7-14ms** (twice the uncertainty window). This is the latency cost of external consistency in Spanner.

### 3.3 External Consistency (a.k.a. Strict Serializability + Real-Time Ordering)

External consistency is the strongest consistency guarantee in distributed systems:

> If transaction T1 commits before transaction T2 starts (in real/wall-clock time), then T1's timestamp < T2's timestamp, and all readers see T1's effects before T2's effects.

This is stronger than serializability. Serializability says there EXISTS a total order equivalent to some serial execution. External consistency says that total order MUST respect real-time commit ordering. A read-only transaction at time t sees ALL writes committed before t and NO writes committed after t.

**This is the property that makes Spanner suitable for global financial ledgers, inventory systems, and any application where real-time correctness matters.**

### 3.4 Spanner Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SPANNER ARCHITECTURE                          │
│                                                                      │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐ │
│  │   Zone A        │     │   Zone B        │     │   Zone C        │ │
│  │  (us-east)      │     │  (eu-west)      │     │  (asia-east)    │ │
│  │                 │     │                 │     │                 │ │
│  │ ┌─────────────┐ │     │ ┌─────────────┐ │     │ ┌─────────────┐ │ │
│  │ │ Paxos Group │ │◄───►│ │ Paxos Group │ │◄───►│ │ Paxos Group │ │ │
│  │ │  (Tablet A) │ │Paxos│ │  (Tablet A) │ │Paxos│ │  (Tablet A) │ │ │
│  │ │  LEADER     │ │     │ │  FOLLOWER   │ │     │ │  FOLLOWER   │ │ │
│  │ └─────────────┘ │     │ └─────────────┘ │     │ └─────────────┘ │ │
│  │                 │     │                 │     │                 │ │
│  │ ┌─────────────┐ │     │ ┌─────────────┐ │     │ ┌─────────────┐ │ │
│  │ │ TrueTime    │ │     │ │ TrueTime    │ │     │ │ TrueTime    │ │ │
│  │ │ GPS+Atomic  │ │     │ │ GPS+Atomic  │ │     │ │ GPS+Atomic  │ │ │
│  │ └─────────────┘ │     │ └─────────────┘ │     │ └─────────────┘ │ │
│  └─────────────────┘     └─────────────────┘     └─────────────────┘ │
│                                                                      │
│  Data is sharded into "splits" (tablets). Each split is a Paxos     │
│  group with replicas across zones. The leader handles writes.        │
│  Reads from any zone (with timestamp bound).                         │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.5 Spanner's Read Path

Spanner supports multiple read modes:

| Read Mode | Guarantee | Latency | Use Case |
|-----------|-----------|---------|----------|
| **Strong Read** | Read at current timestamp; leader-contact required | ~RTT to leader | Balance checks, inventory |
| **Snapshot Read (bounded staleness)** | Read at timestamp ≥ `now - staleness`; can read from local follower | ~Local | Analytics, dashboards |
| **Exact Staleness Read** | Read at exact timestamp T (for causally consistent reads) | ~Local | Multi-read consistency |
| **Read-Your-Writes** | Read reflects all of user's prior writes; uses session timestamp | ~RTT on first read after write | User profile pages |

### 3.6 Spanner's Limitations (What the Paper Doesn't Emphasize)

1. **TrueTime hardware dependency.** If GPS is jammed or atomic clocks fail, TrueTime uncertainty ε widens. At ε > 100ms, commit latency explodes and P99 latency spikes. Spanner degrades gracefully (reads are still correct, just slow) — but your SLA might not.
2. **Cross-Paxos-group transactions use 2PC.** Spanner uses Two-Phase Commit when a transaction spans multiple Paxos groups. 2PC has known failure modes: coordinator failure leaves locks held, blocking other transactions until the coordinator recovers.
3. **"External consistency" is expensive.** The commit wait adds 2×ε to every write transaction's latency. At 7ms ε, that's 14ms of intentional waiting — pure latency you're paying for the consistency guarantee.
4. **Not open-source.** Spanner is Google Cloud's proprietary product. You can use it via Cloud Spanner, but you can't run it on-prem. CockroachDB and YugabyteDB are the open-source Spanner-inspired alternatives.

---

## 4. CockroachDB — Hybrid Logical Clocks Without Atomic Hardware

### 4.1 The Core Idea

CockroachDB achieves Spanner-like serializability WITHOUT requiring atomic clocks or GPS hardware. It does this via **Hybrid Logical Clocks (HLCs)** combined with **Raft consensus**.

An HLC is a tuple: `(wall_time, logical_counter)`. It combines a physical wall-clock component with a logical component (incremented on each event, Lamport-clock style) to provide monotonicity even when clocks drift.

```
HLC = (physical_time, logical_counter)

On send:
  physical = max(local_wall_time, last_physical)
  if physical == last_physical:
    logical += 1
  else:
    logical = 0

Comparison: (p1, l1) < (p2, l2) iff p1 < p2 OR (p1 == p2 AND l1 < l2)
```

### 4.2 How CockroachDB Assigns Timestamps Without TrueTime

CockroachDB's commit protocol is called the **Parallel Commit Protocol**:

```
1. Client sends write to leaseholder (Raft leader) for the range
2. Leaseholder assigns a provisional timestamp based on its HLC
3. Data is replicated via Raft to followers (majority quorum)
4. Transaction coordinator collects all write intents
5. Coordinator picks a final commit timestamp = max(provisional timestamps)
6. Coordinator resolves write intents to committed values at that timestamp
```

The HLC provides a partial order. Raft provides consensus on the order of writes within a range. Together, CockroachDB achieves **serializable isolation** (not external consistency — see §4.4).

### 4.3 CockroachDB Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     COCKROACHDB ARCHITECTURE                         │
│                                                                      │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐ │
│  │   Region A      │     │   Region B      │     │   Region C      │ │
│  │  (us-east)      │     │  (eu-west)      │     │  (asia-east)    │ │
│  │                 │     │                 │     │                 │ │
│  │  ┌──┐ ┌──┐ ┌──┐ │     │  ┌──┐ ┌──┐ ┌──┐ │     │  ┌──┐ ┌──┐ ┌──┐ │ │
│  │  │R1│ │R2│ │R3│ │     │  │R1│ │R2│ │R3│ │     │  │R1│ │R2│ │R3│ │ │
│  │  │L │ │F │ │F │ │     │  │F │ │L │ │F │ │     │  │F │ │F │ │L │ │ │
│  │  └──┘ └──┘ └──┘ │     │  └──┘ └──┘ └──┘ │     │  └──┘ └──┘ └──┘ │ │
│  └─────────────────┘     └─────────────────┘     └─────────────────┘ │
│                                                                      │
│  L = Raft Leaseholder (handles reads and coordinates writes)        │
│  F = Raft Follower                                                  │
│                                                                      │
│  Data is partitioned into "ranges" (default 512MB). Each range is   │
│  a Raft group with replicas across regions. Leaseholders rotate     │
│  across regions for load balancing.                                  │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │     SQL Layer (PostgreSQL wire-compatible)                     │  │
│  │     ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │  │
│  │     │  Parser  │→│ Planner  │→│Optimizer │→│Executor  │   │  │
│  │     └──────────┘  └──────────┘  └──────────┘  └──────────┘   │  │
│  │                         ↓                                      │  │
│  │     ┌──────────────────────────────────────────────────────┐  │  │
│  │     │  KV Layer (DistSQL — distributed query execution)    │  │  │
│  │     └──────────────────────────────────────────────────────┘  │  │
│  │                         ↓                                      │  │
│  │     ┌──────────────────────────────────────────────────────┐  │  │
│  │     │  Raft Consensus Layer (per-range replication)        │  │  │
│  │     └──────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.4 Serializability vs. External Consistency — The Critical Distinction

CockroachDB provides **serializable isolation** (the strongest ANSI SQL isolation level). Spanner provides **external consistency** (strict serializability + real-time ordering).

The difference matters in practice:

```
Scenario: Alice transfers $100 to Bob.

Timeline:
  T1: UPDATE accounts SET balance = balance - 100 WHERE id = 'alice'  (Region A)
  T2: UPDATE accounts SET balance = balance + 100 WHERE id = 'bob'    (Region B)

  T1 commits at wall-clock time 12:00:00.050
  T2 commits at wall-clock time 12:00:00.060

Spanner (external consistency):
  T1's timestamp < T2's timestamp (guaranteed because TrueTime)
  Any reader at 12:00:00.070 sees both T1 and T2
  ✓ Alice's balance is debited, Bob's is credited — atomic from any region

CockroachDB (serializable):
  T1's timestamp and T2's timestamp are assigned by HLCs
  A reader at 12:00:00.070 might see T1 but not T2 if T2's HLC
  timestamp is slightly behind due to clock skew between regions
  ⚠ Reader in Region C might see Alice debited but Bob NOT credited
        (the "fractured read" problem — data is consistent per-range
         but a cross-range read at a single timestamp may miss recent
         commits if clock skew creates timestamp gaps)
```

**This is the single most important interview distinction.** Serializability guarantees that the database state is equivalent to SOME serial execution. External consistency guarantees that the serial execution respects real-time commit order. For financial applications, if you commit Alice's debit at 12:00:00.050, any subsequent read MUST see it — serializability alone doesn't guarantee this.

### 4.5 CockroachDB's Answer to the Fractured Read Problem

CockroachDB uses the **uncertainty interval** to handle cross-range reads:

```
When a transaction reads from a range at timestamp T:
  It observes all writes with timestamps in [T - max_clock_offset, T + max_clock_offset]
  where max_clock_offset = 500ms (configurable)

If the read encounters a write with timestamp > T but within the
uncertainty interval, it must RESTART at the higher timestamp.
```

This is a pessimistic approach: restarts cost latency but ensure correctness. The uncertainty interval is effectively CockroachDB's analog to TrueTime's ε — but it's much larger (500ms vs. 7ms) because it's based on NTP, not atomic clocks.

### 4.6 When CockroachDB Wins Over Spanner

| Factor | CockroachDB | Spanner |
|--------|-------------|---------|
| Deployment | Self-hosted, any cloud, on-prem | Google Cloud only (Cloud Spanner) |
| Hardware requirement | Commodity servers | GPS/Atomic clocks (Google handles this in Cloud Spanner) |
| Cost | Open-source core; Enterprise license | Pay-per-node, expensive at scale |
| Consistency model | Serializable | External consistency |
| Clock uncertainty | 500ms (NTP-based) | 1-7ms (TrueTime hardware) |
| Multi-cloud | ✓ Native | ✗ Google Cloud only |
| SQL compatibility | PostgreSQL wire-compatible | Proprietary SQL dialect (similar to PostgreSQL) |
| Schema changes | Online, no locking | Online, no locking |

**Choose CockroachDB when:** You need self-hosted, multi-cloud, or budget-conscious geo-distribution, and serializable isolation is sufficient.

**Choose Spanner when:** You need external consistency (financial ledgers, inventory with real-time correctness), you're on GCP, and the cost is acceptable.

---

## 5. Fauna — Deterministic Execution (Calvin Protocol)

### 5.1 A Completely Different Approach

Fauna (now FaunaDB) takes a fundamentally different approach to distributed consistency: **deterministic transaction execution** using the Calvin protocol. Instead of coordinating transactions across nodes with locks and 2PC, Fauna:

1. Accepts all transactions into a global log (ordered by timestamp)
2. Each transaction is a pure function of its reads (declared in advance)
3. Every replica executes the SAME transactions in the SAME order
4. Determinism guarantees identical state on every replica

This eliminates the coordination overhead of distributed locking and 2PC. The cost: transactions must declare their read-set and write-set upfront (no interactive transactions). This is the same constraint as stored procedures.

### 5.2 The Calvin Protocol

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CALVIN PROTOCOL                               │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Step 1: SEQUENCING LAYER — establishes global transaction     │  │
│  │           order (distributed log, partitioned by time)         │  │
│  │                                                                │  │
│  │  All transactions → Sequencer → [T1, T2, T3, ...] (total order)│  │
│  └───────────────────────────────────────────────────────────────┘  │
│                         │                                            │
│                         ▼                                            │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Step 2: SCHEDULER — assigns transactions to execution threads │  │
│  │           based on declared read/write sets                    │  │
│  │                                                                │  │
│  │  T1 reads {A, B}, writes {A}    → Scheduler Thread 1          │  │
│  │  T2 reads {C, D}, writes {C}    → Scheduler Thread 2 (parallel)│  │
│  │  T3 reads {A, C}, writes {C}    → Must wait for T1, T2        │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                         │                                            │
│                         ▼                                            │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Step 3: EXECUTION — every replica independently executes the  │  │
│  │           same transaction in the same order → identical state │  │
│  │                                                                │  │
│  │  Replica 1: T1 → T2 → T3 → ...                                │  │
│  │  Replica 2: T1 → T2 → T3 → ...  (identical!)                  │  │
│  │  Replica 3: T1 → T2 → T3 → ...                                │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.3 Fauna's Consistency Model

Fauna provides **strict serializability** (equivalent to Spanner's external consistency) WITHOUT requiring atomic clocks. How?

The sequencer assigns timestamps in a globally consistent order. Since every replica executes transactions in that exact order, the result is deterministic. A read in any region at timestamp T sees the state after all transactions with timestamp < T have been applied. There are no clock-synchronization tricks — the total order is established by the sequencer's consensus, not by wall-clock agreement.

### 5.4 Fauna's Region Groups

Fauna splits data into **Region Groups** — logical partitions that can be pinned to specific geographic regions for data residency compliance:

```
┌──────────────────────────────────────────────────────────┐
│  Fauna Database (global)                                  │
│  ┌──────────────────┐  ┌──────────────────┐              │
│  │ Region Group: EU │  │ Region Group: US │              │
│  │ Data stays in    │  │ Data stays in    │              │
│  │ eu-west          │  │ us-east          │              │
│  │                  │  │                  │              │
│  │ Reads: ultra-low │  │ Reads: ultra-low │              │
│  │ latency in EU    │  │ latency in US    │              │
│  │ Writes: global   │  │ Writes: global   │              │
│  │   consensus with │  │   consensus with │              │
│  │   FQL constraints│  │   FQL constraints│              │
│  └──────────────────┘  └──────────────────┘              │
└──────────────────────────────────────────────────────────┘
```

### 5.5 The Transaction Declaration Constraint

Fauna's biggest limitation: transactions MUST declare their read/write sets upfront. You can't do:

```sql
-- This DOESN'T work in Fauna:
SELECT * FROM users WHERE email = 'alice@example.com';
-- Now decide what to update based on the result
```

Instead, you write the transaction in Fauna Query Language (FQL) — a functional DSL — that declares everything upfront:

```javascript
// FQL example:
Let({
  user: Get(Match(Index("users_by_email"), "alice@example.com")),
  updated: If(GTE(Select(["data", "balance"], Var("user")), 100),
    Update(Select("ref", Var("user")), {
      data: { balance: Subtract(Select(["data", "balance"], Var("user")), 100) }
    }),
    Abort("Insufficient funds")
  )
}, Var("updated"))
```

This is unintuitive for developers used to ORMs and interactive SQL. The payoff: no distributed deadlocks, no 2PC, predictable latency, and strict serializability.

---

## 6. Trade-Off Matrix: Choosing Between the Three

| Dimension | Spanner | CockroachDB | Fauna |
|-----------|---------|-------------|-------|
| **Consistency** | External consistency | Serializable | Strict serializability |
| **Clock approach** | TrueTime (GPS/Atomic, 1-7ms ε) | HLC (NTP, ~500ms uncertainty) | None needed (Calvin sequencer) |
| **Write latency** | ~RTT to leader + 2×ε (14ms+) | ~RTT to leaseholder (~5-100ms) | ~RTT to sequencer (~5-50ms) |
| **Read latency (nearest)** | Snapshot reads: local. Strong: leader RTT. | Leaseholder RTT for consistent reads | Local (deterministic replica) |
| **Hardware** | Google Cloud only | Any | Cloud (Fauna cloud) or on-prem |
| **SQL compatibility** | Spanner SQL (PostgreSQL-like) | PostgreSQL wire protocol | FQL (functional DSL, not SQL) |
| **Schema changes** | Online | Online | Online (but declarative) |
| **Multi-writer regions** | ✓ (with leader per split) | ✓ (with leaseholder per range) | ✓ (sequencer handles ordering) |
| **Data residency** | Configurable | Configurable (zones) | Region Groups |
| **Max cluster size** | Thousands of nodes (Google scale) | Hundreds of nodes (typical) | 10-100 nodes (typical) |
| **Open source** | No | Yes (BSL, then Apache 2.0) | No (source available) |
| **Interactive transactions** | ✓ | ✓ | ✗ (must declare read/write sets) |

---

## 7. Data Model & Schema Design for Geo-Distributed

### 7.1 Interleaved Tables (Spanner) & Table Families (CockroachDB)

Both Spanner and CockroachDB support co-locating related rows for join-free access:

```sql
-- Spanner/CockroachDB: parent-child co-location
CREATE TABLE users (
  user_id STRING PRIMARY KEY,
  name STRING,
  email STRING
);

CREATE TABLE orders (
  user_id STRING,
  order_id STRING,
  amount DECIMAL,
  PRIMARY KEY (user_id, order_id)
) INTERLEAVE IN PARENT users;  -- orders co-located with their user
```

A query to get all orders for a user touches a SINGLE split/range — no cross-node joins.

### 7.2 Choosing Primary Keys for Geo-Distribution

The primary key determines data placement. A bad key distributes data poorly; a great key co-locates related data:

| Key Strategy | Pros | Cons |
|-------------|------|------|
| **UUID/random** | Even distribution, no hot spots | No co-location; related data scattered |
| **UserID + Timestamp** | Co-locates user data; temporal locality | Hot user = hot split/range |
| **Region prefix (e.g., `eu-` + UUID)** | Data residency by region | Requires application-level routing |
| **Monotonic integer** | Simplicity | Hot spot at the end of the range (last split gets all writes) |

**Staff-engineer insight:** For geo-distributed databases, UUIDs are the safe default. Monotonic keys create hot ranges that concentrate writes on a single region's leader, defeating the purpose of geo-distribution. But pure UUIDs lose locality — use composite keys like `(customer_id, uuid)` to get both distribution AND co-location.

### 7.3 Secondary Indexes in Geo-Distributed Systems

Secondary indexes in a geo-distributed database are themselves distributed tables. An index on `users.email` is a separate table keyed by email → user_id. An update to a user touches both the user's range AND the index's range — possibly on different continents. This makes writes 2-3× slower than a single-region database.

**Rule of thumb for geo-distributed:** Minimize secondary indexes. Prefer covering indexes that eliminate the need for a second lookup. Every index is a distributed table with its own replication cost.

---

## 8. Latency Budget & Replication Topology

### 8.1 The Inter-Region Latency Map

| Path | Typical RTT | Notes |
|------|-------------|-------|
| Within same AZ | < 1ms | Ideal for synchronous replication |
| Cross-AZ (same region) | 1-3ms | Acceptable for quorum replication |
| Cross-region (nearby: us-east ↔ us-west) | 40-60ms | Writes feel slow |
| Cross-continent (us ↔ europe) | 80-120ms | Writes are noticeably slow |
| Transpacific (us ↔ asia) | 120-180ms | Very slow writes; read-only replicas preferred |

### 8.2 Replication Topology Choices

```
Single-Region Write (with global reads):
┌──────────┐     ┌──────────┐     ┌──────────┐
│ Region A │◄───│ Region B │◄───│ Region C │
│ (WRITER) │     │ (READER) │     │ (READER) │
└──────────┘     └──────────┘     └──────────┘
Latency: Writes = 0 (local), Reads in B/C = ~0 (local follower)
Drawback: Region A is SPOF for writes. A failure blocks all writes.

Multi-Region Write (active-active):
┌──────────┐     ┌──────────┐     ┌──────────┐
│ Region A │◄───►│ Region B │◄───►│ Region C │
│ (WRITER) │     │ (WRITER) │     │ (WRITER) │
└──────────┘     └──────────┘     └──────────┘
Latency: Writes = ~RTT to consensus majority
         (e.g., 2-of-3 quorum: A does local write, must get ACK from B or C)
Drawback: Higher write latency, but no single region failure blocks writes.

Follower Reads (best of both):
┌──────────┐     ┌──────────┐     ┌──────────┐
│ Region A │     │ Region B │     │ Region C │
│ LEADER   │◄───►│ FOLLOWER │◄───►│ FOLLOWER │
│ for R1   │     │ for R2   │     │ for R3   │
│ FOLLOWER │     │ LEADER   │     │ FOLLOWER │
│ for R2,R3│     │ for R1   │     │ for R1,R2│
└──────────┘     └──────────┘     └──────────┘
Each region is the LEADER for ~1/3 of the data (the "home" region).
Writes: local for leader ranges, cross-region for follower ranges.
Reads: local for follower reads (eventual) OR cross-region for strong reads.
```

**CockroachDB does this by default** via leaseholder balancing. Spanner can be configured similarly. Fauna's deterministic execution means reads are always local (no leader concept).

---

## 9. Consistency Anomalies You MUST Know

### 9.1 The "Spanner Isn't Magic" Anomaly

Even with external consistency, Spanner has a subtle issue: **stale reads from followers if you don't specify a read timestamp.** A Spanner read in "strong" mode contacts the Paxos leader. A read in "snapshot" mode contacts the nearest replica — which may be behind by up to the staleness bound (typically 15 seconds). If you do:

```sql
-- Write (goes to leader)
UPDATE inventory SET quantity = quantity - 1 WHERE product_id = 'X';

-- Immediate read (snapshot mode, local follower)
SELECT quantity FROM inventory WHERE product_id = 'X';
```

The read may return the OLD quantity if the follower hasn't caught up. This isn't a Spanner bug — it's using the wrong read mode. Always use strong reads for freshness-sensitive queries.

### 9.2 CockroachDB's "Restart Loop" Under Contention

When two transactions conflict in CockroachDB, one must restart. Under high contention (e.g., updating the same counter), transactions can restart repeatedly:

```
T1: BEGIN → read counter=0 → write counter=1 → commit (success)
T2: BEGIN → read counter=0 → write counter=1 → COMMIT FAIL (conflict)
T2: RETRY → read counter=1 → write counter=2 → COMMIT FAIL (conflict with T3)
T2: RETRY → read counter=2 → write counter=3 → COMMIT FAIL (conflict with T4)
...
```

Each restart adds latency. Under sustained contention, P99 latency spikes. **Mitigation:** Use `SELECT FOR UPDATE` to acquire locks early, batch updates, or use atomic increments instead of read-modify-write patterns.

### 9.3 Fauna's "Declare Everything" Pain

Fauna's Calvin protocol requires declaring the read-set and write-set upfront. If your transaction needs to read an unknown number of rows (e.g., "update all orders from the last 7 days"), you must either:
- Declare a maximal read-set (may be huge, slowing the transaction)
- Use paginated transactions (multiple round-trips, losing atomicity across pages)
- Restructure the data model to make the read-set bounded

This constraint forces a schema design mindset shift. Developers used to MongoDB/Postgres find this the hardest adjustment.

---

## 10. The Conflict-Free Replicated Data Type (CRDT) Alternative

Geo-distributed databases try to eliminate conflicts. The alternative: embrace conflicts and resolve them deterministically via CRDTs.

### 10.1 How CRDTs Work

A CRDT is a data structure that converges to the same state regardless of the order of operations:

```
Counter CRDT (GCounter):
  Region A increments: A = 1, B = 0, C = 0
  Region B increments: A = 1, B = 1, C = 0
  Region C increments: A = 1, B = 1, C = 1

  Merge: A+B+C = 3  (correct regardless of merge order!)

PN-Counter (supports increment AND decrement):
  P = [A_inc=1, B_inc=1, C_inc=1]  (positive increments)
  N = [A_dec=0, B_dec=0, C_dec=0]  (negative/delete increments)
  Value = sum(P) - sum(N) = 3
```

### 10.2 CRDTs vs. Geo-Distributed Databases

| Dimension | CRDTs | Geo-Distributed DBs (Spanner/CockroachDB) |
|-----------|-------|---------------------------------------------|
| Write latency | Local (< 1ms) — no consensus | Inter-region RTT (5-150ms) |
| Read latency | Local (merge before read) | Configurable (local follower or leader RTT) |
| Conflict resolution | Automatic (CRDT merge rules) | No conflicts (prevented via consensus) |
| Data types supported | Counters, sets, maps, registers | Full SQL: tables, joins, aggregations |
| Query capability | None (CRDT is a data structure, not a query engine) | Full SQL |
| Developer experience | Library-level, no SQL | PostgreSQL-compatible SQL |

**CRDTs are the AP answer (high availability, eventual consistency).** Geo-distributed databases are the CP answer (strong consistency, partition tolerance). Choose based on whether your application can tolerate temporary inconsistencies.

---

## 11. Interview Question: Global Payments Ledger

### The Scenario

> "You're designing a global payments ledger for a fintech company. Requirements:
> - Users in 5 regions (US, EU, APAC, LATAM, Middle East) must be able to check their balance and make transfers
> - P99 read latency < 20ms in all regions
> - P99 write latency < 100ms globally
> - Zero data loss (no lost transfers)
> - A transfer debiting Alice in the US and crediting Bob in the EU must appear atomic: no observer should ever see Alice debited without Bob credited (or vice versa)
> - Regulatory: EU user data must stay in EU. Middle East requires data localization.
> - Audit: all transfers must be queryable with a globally consistent view
> - Peak: 50,000 transfers/second globally
>
> Postgres with read replicas can't meet the write latency SLA globally. Cassandra can't guarantee atomic cross-region transfers. What do you propose?"

### Model Answer

**Step 1: System Choice — Spanner (or CockroachDB with application-level ordering)**

Spanner is the natural fit because:
- **External consistency:** The atomic-transfer requirement ("no observer sees Alice debited without Bob credited") requires external consistency. Standard serializability doesn't guarantee real-time read ordering across regions.
- **Data residency:** Spanner's placement policies pin data to specific regions. EU user data goes to `europe-west1`. Middle East data goes to `me-central1`.
- **Zero data loss:** Paxos replication with majority quorum ensures durability.
- **SQL with global consistency:** Audit queries can run at a global timestamp and see a consistent snapshot.

**Step 2: Schema Design**

```sql
-- Accounts table — interleaved with transactions for co-location
CREATE TABLE accounts (
  account_id STRING(36) NOT NULL,
  region STRING(2) NOT NULL,          -- 'US', 'EU', etc.
  balance DECIMAL NOT NULL,
  version INT64 NOT NULL,             -- Optimistic locking
  updated_at TIMESTAMP NOT NULL,
) PRIMARY KEY (account_id);

-- Transactions table — interleaved with accounts
CREATE TABLE transfers (
  account_id STRING(36) NOT NULL,
  transfer_id STRING(36) NOT NULL,
  amount DECIMAL NOT NULL,
  counterparty_account STRING(36) NOT NULL,
  direction STRING(4) NOT NULL,        -- 'DEBIT' or 'CREDIT'
  status STRING(10) NOT NULL,          -- 'PENDING', 'COMMITTED', 'FAILED'
  created_at TIMESTAMP NOT NULL,
) PRIMARY KEY (account_id, transfer_id),
  INTERLEAVE IN PARENT accounts;

-- Global secondary index for audit (cross-account queries)
CREATE INDEX transfers_by_time ON transfers(created_at DESC);
```

**Step 3: Atomic Cross-Region Transfer Protocol**

```sql
-- The transfer is a single Spanner transaction across two Paxos groups
BEGIN;

-- Lock and debit Alice's account (in us-east1)
UPDATE accounts
SET balance = balance - 100.00, version = version + 1, updated_at = CURRENT_TIMESTAMP()
WHERE account_id = 'alice-123' AND balance >= 100.00;

-- Lock and credit Bob's account (in eu-west1)
UPDATE accounts
SET balance = balance + 100.00, version = version + 1, updated_at = CURRENT_TIMESTAMP()
WHERE account_id = 'bob-456';

-- Insert transfer records (interleaved — co-located with accounts)
INSERT INTO transfers (account_id, transfer_id, amount, counterparty_account, direction, status, created_at)
VALUES
  ('alice-123', 'txn-789', 100.00, 'bob-456', 'DEBIT', 'COMMITTED', CURRENT_TIMESTAMP()),
  ('bob-456', 'txn-789', 100.00, 'alice-123', 'CREDIT', 'COMMITTED', CURRENT_TIMESTAMP());

COMMIT;
```

Because Spanner provides external consistency, the commit timestamp is globally ordered. A read at timestamp T sees both the debit and credit as a single atomic change, even if the data lives in different Paxos groups on different continents.

**Step 4: Latency Budget Analysis**

```
Paxos group A (us-east) leader: in us-east
Paxos group B (eu-west) leader: in eu-west

Alice's account → Paxos group A (us-east)
Bob's account   → Paxos group B (eu-west)

Write latency budget:
  Lock A (local to us-east):                    ~1ms
  Lock B (us-east → eu-west RTT):             ~90ms
  2PC prepare (A + B acknowledge):             ~10ms (parallel)
  Commit + commit wait (2 × TrueTime ε):       ~14ms
                                               ─────
  Total write latency:                        ~115ms

This exceeds the 100ms P99 write SLA. Mitigations:
  1. Co-locate counter-parties that frequently transact with each other
     (e.g., intra-region transfers are fast; cross-region pay the RTT)
  2. Use async acknowledgment: accept the transfer, confirm later
     (breaks atomic-visibility requirement — must evaluate trade-off)
  3. Reserve Spanner nodes in eu-west that are peered with us-east
     (reduces RTT from 90ms to ~60ms with optimized routing)
```

**Step 5: The Trade-Off You're Not Telling Me**

> The 100ms P99 write SLA is achievable for *intra-region* transfers. Cross-region transfers will exceed it because the RTT to the counterparty's Paxos leader is unavoidable. Spanner's commit wait adds another ~14ms. 

The honest answer: "For cross-region transfers, P99 write latency will be ~115-150ms. We can meet the 100ms SLA for transfers where both accounts are in the same region. For cross-region transfers, we accept the higher latency with a product-level UX treatment: show an optimistic 'Transfer Initiated' immediately, and resolve to 'Confirmed' when the commit succeeds ~115ms later. This maintains the atomicity guarantee at the database level while keeping the user experience responsive."

### Common Pitfall

**❌ "Use CockroachDB — it's open-source Spanner."** CockroachDB provides serializable isolation, NOT external consistency. The 500ms HLC uncertainty interval means a read in one region right after a write in another MAY NOT see that write. In a payments system, this means:

```
Scenario:
  T1: Alice transfers $100 to Bob (commits at HLC timestamp T)
  T2: Bob checks his balance 50ms after T1 commit (in another region)

  CockroachDB: T2's read timestamp could be T - 400ms (within uncertainty
               interval) → Bob doesn't see the $100 credit
  Spanner:     T2's read timestamp is > T1's commit timestamp (TrueTime
               guarantees) → Bob sees the $100 credit ✓
```

A payment system where users sometimes can't see their own recent transfers is customer-support poison. External consistency isn't a nice-to-have for fintech — it's table stakes.

**✅ The fix:** Use Spanner (or Fauna) for financial ledgers. If CockroachDB is mandated for cost/self-hosting reasons, add application-level fencing: include the previous balance in every read, compare at write time, and reject if stale. Use `SELECT FOR UPDATE` aggressively. Accept the trade-off consciously — don't pretend CockroachDB == Spanner.

---

## 12. Monitoring & Operations for Geo-Distributed Databases

### 12.1 Key Metrics

| Metric | Target | Why |
|--------|--------|-----|
| Write latency P50 & P99 (per region) | P50 < 10ms, P99 < 150ms | User experience baseline |
| Read latency P50 & P99 (per region) | P50 < 2ms, P99 < 20ms | Strong reads may be slower |
| Cross-region RTT (between each pair) | Monitor baseline; alert on 2× deviation | Network issues first sign of trouble |
| Clock skew (Spanner: TrueTime ε) | ε < 10ms | Wider ε = higher commit latency |
| Clock skew (CockroachDB: NTP offset) | offset < 100ms | Beyond 500ms = restarts |
| Raft/Paxos replication lag | < 100ms | Followers catching up |
| Transaction restart rate | < 1% of transactions | High = contention problem |
| 2PC coordinator failure rate | 0 (any failure = incident) | 2PC failures block transactions |
| Split/range count | Monitor growth; alert on hot ranges | Hot range = single-region bottleneck |
| Storage per region | Track imbalance > 30% | Rebalance proactively |

### 12.2 Operational Gotchas

1. **Spanner's "commit wait" is invisible but measurable.** Monitor `spanner.googleapis.com/commit_latency` — contributions from TrueTime uncertainty appear here. If ε spikes (GPS issue), commit latency spikes too. Page on it before users notice.
2. **CockroachDB's "uncertainty restart" cascade.** Under heavy cross-region writes, uncertainty restarts can cascade: T1 restarts → its retry conflicts with T2 → T2 restarts → T2's retry conflicts with T3... Monitor `sql.txns.restarts` by restart reason. `uncertainty` restarts > 5% of total = clock sync issue.
3. **Raft snapshots can saturate cross-region links.** When a follower falls behind, the leader sends a full snapshot. A 500MB range snapshot over an 80ms RTT link can take minutes and saturate inter-region bandwidth. Tune `raft-snapshot-rate` and monitor snapshot sizes.
4. **"Split brain" is not just a CAP theoretical concern.** In 2024, a real transatlantic fiber cut between Europe and North America isolated Spanner regions. The isolated minority stopped accepting writes (correct CP behavior), but the application wasn't prepared for write unavailability in the minority regions. **Always deploy with cross-region application-level graceful degradation.**

---

## 13. Edge Cases & Curveball Questions

### "Your Spanner deployment has been live for 6 months. A user in Singapore reports their balance shows $500 less than their local bank statement. The discrepancy is exactly 7 days old. What happened?"

**Staff-engineer debugging:**

1. **Check for zombie writers in a failed region.** If the Singapore region lost connectivity 7 days ago and a local cache held stale leader information, writes may have been routed to a zombie Paxos group that was later overwritten when connectivity restored. Check Spanner's admin logs for region isolation events 7 days ago.
2. **Check TrueTime ε during that window.** If ε exceeded the fail-safe threshold (configurable, typically 100ms), Spanner may have rejected transactions or assigned incorrect timestamps. Narrow down: check `spanner.googleapis.com/truetime_uncertainty` for the 24-hour window 7 days ago.
3. **Application-level idempotency bug.** Was the transfer retried without an idempotency key? A retry-after-timeout could create a duplicate transfer that was logically committed but the user's view came from a stale snapshot read. Check the transfers table for duplicate `transfer_id`s.
4. **Stale read from snapshot mode.** The user's balance check used a snapshot read (bound-staleness = 15s). If a follower in Singapore was 15 seconds behind, the user saw the balance BEFORE a recent transfer. This isn't a Spanner bug — it's using the wrong read mode.

### "You need to migrate a 50TB PostgreSQL database to CockroachDB with zero downtime. How?"

1. **Phase 1 — Schema migration:** Create CockroachDB schema. Enable change data capture (CDC) from PostgreSQL → Kafka.
2. **Phase 2 — Bulk import:** Use CockroachDB's `IMPORT` for the historical snapshot. Run while PostgreSQL is live.
3. **Phase 3 — CDC replication:** Stream changes from PostgreSQL WAL → Kafka → CockroachDB. CockroachDB applies changes through its SQL layer.
4. **Phase 4 — Dual-write:** Application writes to BOTH PostgreSQL and CockroachDB. Read from PostgreSQL. CockroachDB verifies data parity.
5. **Phase 5 — Cutover:** Switch reads to CockroachDB. Wait 1 hour (monitoring). Switch writes to CockroachDB only. Decommission PostgreSQL CDC.
6. **Phase 6 — Post-migration:** Run consistency checks (`cockroach sql` vs `pg_dump`). Compare row counts, checksums.

**The trap:** CockroachDB's `IMPORT` bypasses the SQL layer and writes directly to the KV layer. If your schema has foreign keys or triggers, they won't fire during import. You must validate referential integrity after import.

### "Fauna's Calvin protocol sounds elegant. Why isn't everyone using it?"

Because of developer adoption friction:
- No SQL. FQL is a functional DSL that requires learning a new paradigm.
- No interactive transactions. Every transaction must be a self-contained function.
- The upfront read/write set declaration is fundamentally incompatible with ORMs, ad-hoc queries, and most existing application architectures.
- The sequencing layer is a bottleneck under extreme write loads (>100K writes/second). Though partitionable in theory, the inter-partition ordering in practice is complex.

**The trade-off:** Fauna chose architectural elegance (deterministic execution = no locks, no 2PC, no clock problems) over developer compatibility. For greenfield projects where developers accept FQL, it's excellent. For migrating existing Postgres applications, it's a non-starter.

---

## 14. Key Metrics Summary

| Metric | Target | Why |
|--------|--------|-----|
| External consistency guarantee (Spanner) | 100% (no anomalies ever) | Financial correctness |
| TrueTime ε (Spanner) | < 7ms P99 | Lower = faster commits |
| Clock skew (CockroachDB) | < 100ms P99 | Beyond = transaction restarts |
| Cross-region transaction rate | > 50K TPS | Payments/fintech scale |
| Read-after-write staleness | 0ms for strong reads (Spanner) | Real-time correctness |
| Region failure failover time | < 30s (leader election) | Availability SLA |
| Data residency compliance | 100% (no data leaks across regions) | GDPR / regulatory |
| Transaction restart rate | < 1% | Healthy system indicator |

---

## 15. Weaknesses & Trade-Offs (Self-Check)

1. **Geo-distributed databases solve one problem (global reads/writes with consistency) but create others.** Every write crossing a region boundary pays the inter-region RTT. Your application architecture MUST be latency-aware: batch cross-region writes, prefer intra-region writes, and design UX to hide latency (optimistic updates, loading states).

2. **Not all data needs geo-distribution.** Session data, analytics snapshots, and read-heavy reference data can stay in a single-region database with CDN-style caching. Reserve geo-distributed databases for data that MUST be consistent globally: financial balances, inventory counts, user identity.

3. **Fauna's transaction declaration constraint is genuinely hard.** If your team is used to Rails/Django ORMs, the shift to FQL + declared read/write sets is a 2-3 month learning curve. Calculate the developer productivity cost before choosing Fauna.

4. **Spanner's TrueTime is a single point of failure in a different form.** If all GPS satellites in a region are jammed simultaneously (military exercises, solar flares), TrueTime ε widens dramatically. Spanner still operates — just slower. But at ε = 1 second, P99 commit latency hits 2 seconds. Your application MUST be designed to handle degraded commit latency.

5. **CockroachDB's serializable, not external consistency.** This is the #1 misconception among engineers evaluating CockroachDB for fintech. Serializable guarantees a consistent database state. It does NOT guarantee that a reader at time t sees all writes committed before t. If your use case requires "I commit; you must see it immediately," you need external consistency → Spanner or Fauna.

6. **The CAP theorem is a spectrum, not a binary.** During a network partition, Spanner/CockroachDB/Fauna are CP (minority stops accepting writes). But in practice, partitions are rare (minutes/year). For the 99.99% of time when the network is healthy, these systems provide both consistency AND availability AND low latency — the "CAP doesn't apply" reality. The art is knowing what happens during the 0.01% when it does.

---

## 16. Self-Assessment: Interview Readiness

### Can you answer these?

1. **"Explain External Consistency vs. Serializability in one sentence each."**
   - External consistency: If T1 commits before T2 starts in real time, every reader sees T1 before T2 — real-time order is preserved.
   - Serializability: There exists SOME serial execution order equivalent to the concurrent execution — real-time order is NOT guaranteed.

2. **"How does Spanner's TrueTime enable external consistency?"**
   TrueTime provides a guaranteed time interval `[earliest, latest]` with ε = 1-7ms. Spanner assigns commit timestamp = latest, then waits 2×ε (the commit wait). This guarantees the assigned timestamp is greater than any previous transaction's timestamp in real time, creating a total order that respects real-time commit ordering.

3. **"Why does CockroachDB use HLCs instead of atomic clocks?"**
   CockroachDB targets commodity hardware deployments. Atomic clocks and GPS receivers aren't available on standard cloud VMs. HLCs approximate a global clock using NTP + logical counters, achieving serializable isolation without specialized hardware. The trade-off: a 500ms uncertainty interval (vs. Spanner's 7ms) and serializable instead of external consistency.

4. **"What's the Calvin protocol and which database uses it?"**
   Fauna uses the Calvin protocol. Transactions are accepted into a globally ordered log by a sequencer. Every replica executes the same transactions in the same order deterministically, guaranteeing identical state without locks or 2PC. The cost: transactions must declare their read/write sets upfront — no interactive SQL.

5. **"When would you NOT use a geo-distributed database?"**
   - Read-heavy workloads with no strong consistency requirements → single-region DB + CDN is cheaper and simpler
   - Batch/analytics workloads → data warehouse (BigQuery, Snowflake) is faster
   - Team unfamiliar with geo-distributed constraints → the learning curve may outweigh the benefits
   - Budget-constrained: geo-distributed databases cost 3-10× more per GB than single-region

---

## Related
- [[topic-queue]]
- [[Two-Phase Commit & Consensus (Raft-Paxos)]] (Paxos/Raft underpin Spanner and CockroachDB)
- [[Consistent Hashing]] (data placement for geo-distributed sharding)
- [[Multi-Region Active-Active (Geo-replication, Conflict Resolution)]] (application-level geo-distribution)
- [[Database Sharding & Replication]] (foundational concepts)
- [[Event Sourcing & CQRS]] (alternative to strong consistency for geo-distributed writes)

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Geo-distributed DBs replicate data across continents while maintaining strong consistency — Spanner, CockroachDB, YugabyteDB
- Spanner uses TrueTime (atomic clocks + GPS) for external consistency; CockroachDB uses hybrid logical clocks (HLC) as an approximation
- The physics constraint: cross-continent RTT is 50-150ms, so consensus-based writes have a floor of 2×RTT (propose + accept)
- Clock uncertainty directly impacts write latency: if TrueTime uncertainty is 7ms, writes must wait 7ms before committing
- Choose partitioning carefully — data accessed together should be in the same region to avoid cross-region reads

**Common Follow-Up Questions:**
- "CockroachDB vs Spanner — what's the practical difference?" — Spanner needs atomic clocks (Google data centers). CockroachDB works with NTP but has higher uncertainty, meaning longer commit waits and potentially more aborts.
- "How do you minimize cross-region latency?" — Partition data by geography (user region as partition key). Writes go to the local region's replica; reads are served from the nearest replica.

**Gotcha:**
- "Strong consistency" in geo-distributed databases does NOT mean "fast." It means every read sees the latest write, but that guarantee comes with a latency cost. If your application can tolerate eventual consistency (e.g., social media feeds), don't pay for strong consistency you don't need.
