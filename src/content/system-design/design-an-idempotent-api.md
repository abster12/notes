---
title: "Design an Idempotent API"
type: system-design
category: Deep Dive
date: 2026-05-31
tags: [system-design, interview, idempotency, api-design, distributed-systems, payments, at-least-once, retry, idempotency-key]
aliases: [Idempotent API Design, Idempotency Keys, Exactly-Once Semantics]
---

# Design an Idempotent API

## Summary & Interview Framing

An API that produces the same result whether called once or many times, using client-generated idempotency keys to prevent duplicate side effects on retry. It stores keys with the response, enforces TTLs, and handles concurrent requests with the same key through locking or conditional writes.

**How it's asked:** "Design an idempotent payment API that guarantees no double-charging even under network failures, retries, and concurrent requests. Handle idempotency key storage, TTL, and race conditions."

---

## Overview

**Idempotency** is the property of an operation where executing it one or more times produces the same observable result as executing it exactly once. In distributed systems — where networks drop packets, connections time out, and clients retry as a matter of course — idempotency is not a convenience feature but a correctness invariant. Without it, a single transient failure cascades into double charges, duplicate orders, orphaned inventory reservations, and support tickets that cost more than the infrastructure that caused them.

The canonical example is payments: if Stripe, Adyen, or Square did not treat `POST /charges` as idempotent, every timeout-induced retry would create a fresh charge, and the resulting chargeback volume would be catastrophic. But the principle extends to any mutating RPC — order placement, email dispatch, user registration, webhook delivery, state-machine transitions — anywhere a retry could mutate state a second time.

The subtlety that separates a junior answer from a staff-level one is this: idempotency is easy to describe and hard to implement correctly under concurrency, partial failure, and geographic distribution. The interview conversation moves quickly past "use an idempotency key" toward the real engineering questions:

- How do you guarantee the side effect executes at most once when your idempotency record and your business-logic database are two separate systems that cannot share an atomic transaction?
- How do you handle two identical requests arriving simultaneously at different replicas in different regions?
- What happens when the idempotency store itself loses data or becomes unavailable mid-request?
- How long must a key be retained, and what is the cost of retaining it too long or expiring it too early?

These questions have no single universally correct answer; they involve trade-offs between latency, durability, consistency, and cost that must be reasoned about explicitly.

## Key Requirements

### Functional Requirements

The system must provide **duplicate detection**: a client retrying the same logical request with the same idempotency key must receive the same response — same status code, same body, same meaningful headers — without the underlying side effect executing a second time. This implies **response caching**, not merely status tracking; a retry must not return a 200 with a different body than the original call returned, because the client may have already acted on the first response.

The system must provide **concurrent safety**: two requests carrying the same key that arrive at nearly the same instant (a common pattern when a client's connection drops and it retries before the original request's response arrives) must be serialized such that one executes the mutation and the other receives the cached or in-flight result.

The system must enforce a **key lifecycle**: keys expire after a configurable retention window so storage does not grow unboundedly, but the window must be long enough to cover the maximum realistic client retry interval plus clock skew.

Finally, the system must support **post-completion recovery**: a key that arrives after the original request has fully completed and its response already dispatched must still be recognized and replayed, not treated as a new request.

### Non-Functional Requirements

The idempotency check must be fast — ideally under five milliseconds at p99 — because it sits on the hot path of every mutating request and must not dominate end-to-end API latency. Key-to-response mappings must be durable enough to survive node crashes; losing the mapping for a completed payment is arguably worse than never having had idempotency at all, because it creates a false sense of safety.

The default TTL is typically twenty-four hours for payment endpoints (covering the standard retry-backoff window of most HTTP clients and queue processors), but it should be configurable per endpoint. Throughput targets are on the order of one hundred thousand idempotency checks per second per shard in a high-volume payments system. Consistency is strong within a shard (a given key must resolve to exactly one outcome) and eventually consistent across regions, with careful handling of cross-region collisions.

## The Idempotency Key

### Key Design

The idempotency key is a **client-supplied unique string** that the server uses as the deduplication handle. It is most commonly transmitted in an `Idempotency-Key` HTTP header (the de facto convention popularized by Stripe) rather than in the request body, because keeping it out of the body allows the same middleware to enforce idempotency across heterogeneous endpoints without each handler parsing business logic.

A good key is a **UUID v4** or a **versioned ULID** (which encodes a timestamp and is sortable, useful for TTL eviction and debugging). The key must be generated by the client **before** the first attempt and reused verbatim on every retry; the server must never generate keys on the client's behalf, because a server-generated key returned in a response that the client never receives (due to a network drop) leaves the client with no key to retry with and forces a duplicate.

**Idempotency key design rules:**

- Keys should be **opaque to the server** — the server should not attempt to parse semantic meaning out of them, because doing so creates a coupling between key format and business logic that breaks the moment a client changes its generation scheme.
- The only validation the server should perform is **length bounds** (reject keys longer than, say, 255 characters to prevent storage abuse) and **character-set sanity** (printable ASCII or UTF-8).
- Do **not** accept a content hash as an idempotency key; this conflates "same payload" with "same logical operation" and breaks when a client legitimately wants to issue two identical-looking operations (two separate $10 charges to the same card, minutes apart) or when a field like a client-side timestamp changes between retries without changing the logical intent.
- Prefer **UUID v4** (uniformly random, no collision coordination) or **ULID** (timestamp-prefixed, sortable, useful for TTL eviction and debugging).
- Generate the key **client-side, before the first attempt**, and reuse it verbatim on every retry.
- Never let the server generate keys on the client's behalf — a server-generated key lost to a network drop leaves the client with no key to retry with.
- Keep the key in the **`Idempotency-Key` header**, not the request body, so the same middleware can enforce idempotency across heterogeneous endpoints.

### Client-Generated Keys

The decision to make keys **client-generated** is foundational and worth understanding deeply. The client is the only party that knows which retries correspond to which original request — the server sees only independent HTTP calls and cannot, in general, distinguish a retry from a new request by inspecting the payload. By forcing the client to attach a stable identifier, we externalize the "is this the same operation?" question to the party that actually knows the answer.

This places a burden on the client: it must generate the key once, persist it locally (in memory, in a queue, in a database column alongside the pending operation), and reuse it across retries until a terminal response is received. A well-behaved client treats the key as part of the operation's identity, on equal footing with the payload itself.

The practical implication is that client SDKs and queue processors must be designed to carry the key forward:

- A **message-queue consumer** that dequeues a message, calls a downstream service, and re-enqueues on failure must store the idempotency key in the message metadata and reuse it on the next attempt.
- A **mobile app** that crashes mid-request must have persisted the key to disk so that on relaunch it can retry safely rather than abandoning the operation or blindly reissuing it.
- **Server-side SDKs** that wrap idempotent endpoints should expose the key as a first-class parameter, not an optional header, to make the contract explicit.

## Server-Side Deduplication

### The Dedup Table Pattern

Server-side deduplication is implemented via a **dedup table** (also called an idempotency store) that maps each key to the state and eventual response of its request. The table has at minimum three columns: the key (primary key), a status field (`in_progress`, `completed`, or `failed`), and the serialized response (status code, headers, body) populated once the handler finishes. A `created_at` timestamp drives TTL eviction.

On every incoming request, the server performs a **conditional insert** — an `INSERT ... ON CONFLICT DO NOTHING` (Postgres) or an equivalent atomic check-and-insert — keyed on the idempotency key. If the insert succeeds, this is a first-time request and the server proceeds to execute the business logic. If the insert fails because the key already exists, the server reads the existing row: if the status is `completed`, it replays the stored response; if `in_progress`, it either polls until completion or returns a `409 Conflict` / `409 Request In Progress` instructing the client to retry shortly.

**Idempotency key flow (client → server → dedup table):**

```
  CLIENT                              API SERVER                         DEDUP TABLE (Postgres / Redis / DynamoDB)
  ======                              =========                          ========================================
  
  1. Generate Idempotency-Key
     (UUID v4 / ULID)
        |                                                                 
        |  POST /charges                                              +-------------------------+
        |  Idempotency-Key: 7f3a-...                                  |  key  | status        |
        +------------------------------------------------------------->| 7f3a  | in_progress   |
        |                                  2. Conditional INSERT            |       | (payload_hash)|
        |                                  INSERT ... ON CONFLICT            +-------------------------+
        |                                  DO NOTHING                            |
        |                                       | insert OK                     |
        |                                       v                               |
        |                              3. Execute business logic              |
        |                                 (charge $10)                         |
        |                                       |                               |
        |                                       v                               |
        |                              4. UPDATE row -> completed              v
        |                                 store response              +-------------------------+
        |                                       |                    | 7f3a  | completed     |
        |                                       v                    |       | resp: 200... |
        |  5. 200 OK + response <----------------+                    +-------------------------+
        |
        |  *** network drop / timeout ***
        |
        |  6. Retry with SAME key
        |  POST /charges
        |  Idempotency-Key: 7f3a-...
        +----------------------------------------------+
                                                       |
                                  7. INSERT -> conflict | (key exists)
                                                       v
                                  8. SELECT row -> status=completed
                                                       |
                                                       v
        |  9. 200 OK (replayed response, NO re-charge) <-+
```

The critical correctness property is that the conditional insert and the subsequent business-logic write must be **ordered such that the dedup record is visible before the side effect can execute**, and the response must be recorded **in the same atomic boundary as the side effect** whenever possible. When the dedup table and the business database are the same physical database (the **colocated** pattern), this is straightforward: a single transaction inserts the idempotency row, performs the mutation, and updates the row to `completed` with the response — all committing atomically. When they are separate systems (the **separate-store** pattern, common when using Redis or DynamoDB for the dedup table and Postgres for business data), atomicity across the two is impossible, and the system must use compensating actions, a transactional outbox, or accept a small window of inconsistency. This split-store problem is the single most common source of idempotency bugs at scale and is discussed in detail below.

### Race Condition Handling

The two-simultaneous-request race is the textbook concurrency hazard. Without protection, both requests could pass the "does this key exist?" check, both proceed to execute the mutation, and both charge the customer. The conditional insert solves this atomically at the database level: only one insert wins, the other sees the conflict and takes the retry path.

For the in-progress case, the losing request must wait for the winner to finish. Options include:

- **Busy polling** the dedup row with a short sleep (simple, adds latency and database load).
- **Database row-level locks** (`SELECT ... FOR UPDATE` on the existing row, which blocks until the holder commits).
- **A notification mechanism** (Postgres `LISTEN/NOTIFY`, Redis pub/sub) that wakes waiters when the row transitions to `completed`.

Row-level locking is the cleanest when the dedup table is in the same database as the business logic; pub/sub is preferable when the dedup store is Redis and the wait could span hundreds of milliseconds.

A subtler race involves **crash recovery mid-flight**: the server inserts an `in_progress` row, begins the mutation, and then crashes before recording the response. The key is now stranded — the client retries, sees `in_progress`, and waits forever (or until the row's TTL expires, which could be hours). The standard mitigation is a **lease or heartbeat timeout** on the `in_progress` state: each in-progress row has a `lease_expires_at` column, refreshed by a background heartbeat while the handler runs. If a retry arrives and the lease has expired, the server may **claim** the row by atomically updating its owner (a compare-and-set on `lease_expires_at < now()`) and re-executing the operation. This introduces the possibility of double execution if the original handler is merely slow rather than dead, so leases must be tuned conservatively — long enough that a healthy handler never loses its lease, short enough that a crashed handler's key is reclaimable in minutes, not hours.

## Idempotency in REST vs gRPC

### REST: Idempotency by Convention and Header

In REST, idempotency is partially baked into the HTTP method semantics: `GET`, `PUT`, and `DELETE` are defined as idempotent by the HTTP specification, while `POST` and `PATCH` are not. This is a useful default but it is **weak** — it describes the intended semantics, not a guarantee. A naive `PUT /users/123` that does `user.balance += 100` is not idempotent despite the method, because the spec's idempotency is about the server's observable state, not about the client's intent.

Real-world idempotency for `POST` endpoints (the vast majority of mutating business operations) is achieved via the `Idempotency-Key` header convention, layered on top of the dedup-table machinery described above. REST's flexibility is a double-edged sword: the header can be applied selectively to any endpoint, but nothing in the protocol enforces it, so a forgotten header on a critical endpoint is a silent bug.

### gRPC: Idempotency in the Service Definition

gRPC bakes idempotency into the **service definition** via protobuf method options. A method can be annotated as `idempotent`, signaling to the client library that it is safe to retry the call transparently on transient failures. This is stronger than REST's convention because the contract is machine-readable and the generated client stubs can enforce retry behavior automatically.

However, gRPC's idempotency annotation is a **promise the server must keep**; the framework does not implement deduplication for you. The server-side implementation still requires a dedup table or equivalent, often keyed by a combination of the gRPC method name and a client-generated request ID (gRPC metadata). The advantage is that the idempotency contract is visible in the `.proto` file, reviewable in code review, and enforceable by linters — whereas in REST, an endpoint's idempotency status is often discoverable only by reading the implementation or a separate wiki page.

A practical difference: gRPC streaming RPCs (client-streaming, bidi-streaming) do not map cleanly onto the request-response idempotency model, and idempotency for stream-based workflows typically requires application-level sequence numbers or a checkpoint mechanism rather than a simple key-per-call header. For unary RPCs, however, gRPC and REST idempotency are conceptually identical and differ only in plumbing.

## Idempotency for Payments

Payments are the domain where idempotency is most scrutinized, because a bug has direct financial cost and regulatory consequences. The Stripe API is the most cited reference: every `POST` to a mutating endpoint accepts an `Idempotency-Key` header, and Stripe guarantees that retrying with the same key returns the cached response without creating a duplicate resource. Stripe stores idempotency keys for **twenty-four hours** by default, after which the key is evicted and a reuse is treated as a new request — a window chosen to cover all reasonable client retry backoffs. The key is scoped to the Stripe account and the endpoint, so the same key used on two different endpoints or two different accounts is treated independently.

The payment-specific nuances go beyond the generic pattern:

- **Partial failures** are more dangerous: a charge that succeeds at the processor but whose confirmation response is lost to a network drop leaves the client uncertain and retrying. The idempotency layer must query the processor (or its own record of the processor's response) before reissuing the charge, because blindly reissuing could create a second charge if the first truly succeeded. This is why payment idempotency systems often store not just the API response but also the **upstream processor reference** — so a retry can reconcile against the processor's state.
- **Amount and currency validation**: a robust implementation rejects a retry whose payload (amount, currency, recipient) differs from the original request's payload even though the key matches, returning a `422` or `409` with a clear message. This catches client bugs where a key is accidentally reused across logically distinct operations.
- **Refunds and credits** need their own idempotency — a double refund is as costly as a double charge — and the same machinery applies, often with a longer TTL because refund reconciliation windows can span days.

## Retry-Safe Operations

Not all operations need an explicit idempotency key to be retry-safe. An operation is inherently idempotent if its effect is a pure function of its inputs and the target's current state: `SET balance = 100` is idempotent (retrying sets the same value), whereas `balance += 100` is not. Designing APIs around **absolute state transitions** rather than **relative mutations** is the simplest path to retry safety and requires no dedup infrastructure at all. A `PUT /inventory/items/{sku}/reserved { quantity: 5 }` that sets the reservation to exactly five units is retry-safe by construction; a `POST /inventory/items/{sku}/reserve { quantity: 5 }` that increments is not.

For operations that cannot be expressed as absolute sets — typically those that create new entities or append to an unbounded collection — the idempotency key is the standard tool. A useful middle ground is the **client-side request ID combined with a natural-key uniqueness constraint**: the server enforces a unique index on `(user_id, cart_id)` for order creation, so a duplicate insert fails at the database level even without a dedicated dedup table. This is cheaper and simpler than a full idempotency layer but works only when a natural unique key exists and when the response can be reconstructed by querying the created entity rather than caching it. The trade-off is that the client must handle the unique-constraint violation by fetching the existing entity, which requires the handler to be written in a "create-or-get" style rather than a "create-or-replay" style.

**Retry-safe request lifecycle:**

```
   CLIENT                  NETWORK                API SERVER              DEDUP STORE          BUSINESS DB
   ------                  -------                ---------                ----------          -----------
   
   [1] Create op + key
        |
        |  [2] POST + Idempotency-Key ----+========+ (timeout / drop)
        |                                 |  N/W   |
        |   <--- retry? client unsure --->|  FAIL  |
        |                                 +========+
        |  [3] Retry SAME key ---------------> [4] Conditional INSERT ----->[5] insert OK
        |                                                                   (row: in_progress)
        |                                                                   [6] lease/heartbeat set
        |                                                                        |
        |                                                                        | [7] BEGIN txn
        |                                                                        |     run business logic
        |                                                                        |     UPDATE row -> completed
        |                                                                        |     COMMIT
        |                                                                        v
        |                                                                   [8] row: completed
        |  [9] 200 OK (replayed) <---------------- [10] SELECT -> completed <-+
        |                                       
        |  *** OR, first attempt actually finished late ***
        |
        |  client gets response from [1] OR [3]; dedup ensures
        |  business logic ran exactly once; client sees one
        |  consistent response regardless of path.
```

## Idempotency Key Storage

### Store Selection

The idempotency store is chosen based on the consistency, latency, and durability requirements of the workload.

**Postgres (or MySQL) colocated with the business database** is the gold standard for correctness: the dedup table and the business mutation share a transaction, so the key record and the side effect commit atomically. This eliminates the entire class of "dedup says completed but business logic didn't run" (or vice versa) inconsistencies. The cost is that the dedup table competes for the same database's capacity and its TTL eviction requires either a cron-driven `DELETE WHERE created_at < ...` or a partitioned table with daily partitions that can be dropped wholesale.

**Redis** is attractive for latency-sensitive workloads: a `SET NX` (set-if-not-exists) with a TTL is a one-millisecond idempotency check, and Redis's built-in key expiration eliminates the cleanup problem entirely. The trade-off is that Redis is not the same system as the business database, so atomicity across the two is impossible, and a crash between the Redis `SET` and the Postgres `COMMIT` (or vice versa) creates a window where the key is marked used but the operation did not complete, or the operation completed but the key was never recorded. Mitigations include writing the idempotency record to Postgres as a fallback (a "belt and suspenders" approach), using Redis only as a fast-path cache with Postgres as the authoritative store, or accepting the small inconsistency window for non-financial operations where the cost of a duplicate is bounded.

**DynamoDB** (or Cassandra) is the typical choice for very high-throughput, globally distributed systems where a single-region relational database cannot keep up. DynamoDB's conditional write (`PutItem` with a `ConditionExpression` of `attribute_not_exists(pk)`) provides the atomic check-and-insert, and TTL on the item handles cleanup. The consistency model is per-partition strong consistency (with `consistent read` enabled), which is sufficient for single-key dedup. Cross-region replication in DynamoDB Global Tables is eventually consistent, so a key written in us-east-1 may not be visible in eu-west-1 for a second or two — a window during which a cross-region retry could slip through. For payment-grade idempotency, cross-region dedup requires either routing all retries for a given key to a single "home" region (via a consistent hash of the key) or accepting a small duplicate rate and reconciling after the fact.

**Storage backend comparison:**

| Store | Atomicity w/ Business Logic | Latency (p99) | TTL / Cleanup | Durability | Best Fit |
|-------|------------------------------|---------------|---------------|------------|----------|
| Postgres (colocated) | Strong — single txn | ~2-5 ms | Partition drops or batched DELETE | High (durable WAL) | Correctness-first workloads; payments |
| Redis (separate) | None — atomicity gap | ~1 ms | Native TTL (auto) | Volatile (can lose on crash) | Latency-sensitive, non-financial |
| DynamoDB (separate) | None — atomicity gap | ~5-10 ms | Native TTL (best-effort) | High (replicated) | High-throughput, globally distributed |
| MySQL (colocated) | Strong — single txn | ~2-5 ms | Partition drops or batched DELETE | High (durable) | MySQL shops; same as Postgres |
| Cassandra (separate) | None — atomicity gap | ~5-10 ms | Native TTL | High (replicated) | Write-heavy, globally distributed |
| Postgres + Redis (hybrid) | Eventual via outbox | ~1 ms fast path | Redis TTL + Postgres partition | High | Latency + durability compromise |

### Colocated vs Separate Store — The Atomicity Gap

The colocated pattern (dedup table in the same Postgres database as the business tables) is strongly preferred whenever feasible because it eliminates the atomicity gap. In a single transaction, the handler inserts the idempotency row in `in_progress` state, performs the business mutation, updates the row to `completed` with the serialized response, and commits. Either all of it happens or none of it does. A retry arriving after commit sees `completed` and replays the response; a retry arriving during the transaction blocks on the row lock. A crash leaves no durable trace of the `in_progress` row (the transaction rolls back), so the client's retry creates a fresh row and re-executes cleanly. This is the cleanest possible model and is what Stripe and most payment platforms use internally.

The separate-store pattern (Redis or DynamoDB for dedup, Postgres for business) is chosen when the business database cannot absorb the dedup-table write load, when the dedup store must be globally distributed while the business database is regional, or when the API gateway layer (which enforces idempotency) is operated by a different team than the service layer (which owns the business database). The atomicity gap here is real and must be managed. The safest approach is the **transactional outbox pattern**: the business transaction writes the idempotency-completion record into an outbox table within the same Postgres transaction, and a background process drains the outbox and mirrors the records into the separate dedup store. This guarantees that the dedup store is eventually consistent with the business state, though there is a brief window after commit and before the outbox drain during which a retry will not find the key and may re-execute. For payment-grade guarantees, the outbox drain must be fast (sub-second) and the client retry interval must be longer than the drain latency.

## TTL and Cleanup

Idempotency keys cannot live forever — storage is finite, and a table that grows by one row per mutating request will eventually degrade query performance and exhaust disk. Every key has a **TTL** after which it is eligible for deletion. The TTL must be longer than the maximum realistic retry interval for the workload:

- For **HTTP clients with exponential backoff**, typically a few minutes to an hour.
- For **queue-based retries with long backoff and dead-letter handling**, it can be hours.
- For **payment reconciliation**, twenty-four hours is the industry default.

Setting the TTL too short means a slow client retry (e.g., a mobile app that reconnects after a network outage) arrives after the key has expired and creates a duplicate. Setting it too long wastes storage and slows eviction. The TTL should be **per-endpoint configurable** because a webhook-delivery endpoint and a charge endpoint have very different retry profiles.

Cleanup is implemented in one of three ways:

- **Redis and DynamoDB** provide native TTL expiration — the store evicts expired keys automatically with no application code, though the eviction is best-effort and expired keys may linger briefly.
- **Postgres without partitioning** requires a periodic background job (`DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`) run every few minutes; the deletion must be batched (delete in chunks of a few thousand rows with a `LIMIT`) to avoid long-running transactions and lock contention on a high-write table.
- **Postgres with range partitioning** by `created_at` (daily partitions) is the cleanest at scale: a cron job drops yesterday's oldest partition in a single metadata operation, which is O(1) regardless of row count and produces no vacuum bloat. This is the pattern used by high-volume platforms — partition by day, retain N days, drop the oldest partition daily.

A subtle operational concern: the dedup table is on the write hot path, so its size directly affects insert latency. A table with hundreds of millions of rows (a year of unpruned keys) will have slower index maintenance and inserts than a table pruned to twenty-four hours. This is an argument for shorter TTLs where the business permits, and for partitioning where longer retention is required for audit or compliance.

## Distributed Idempotency

### Single-Region Concurrency

Within a single region, the dedup table (whether Postgres, Redis, or DynamoDB) provides a single serialization point per key. The conditional insert is atomic at the row or key level, so two concurrent requests with the same key are guaranteed that exactly one wins the insert. The loser takes the retry or wait path. This holds regardless of how many API replicas are fronting the table, because the deduplication is delegated to the storage layer's own concurrency control. The only requirement is that all replicas in the region share the same dedup store — a per-replica in-memory cache is not sufficient and will allow duplicates whenever a retry lands on a different replica.

### Multi-Region and Cross-Region Collisions

Multi-region idempotency is where the design gets genuinely hard. If the dedup store is replicated asynchronously across regions (DynamoDB Global Tables, Postgres logical replication), a key written in region A is not visible in region B until replication completes — typically tens to hundreds of milliseconds, but up to seconds under degraded conditions. During that window, a client that fails over from region A to region B (because A's endpoint returned a timeout) and retries with the same key will not find the key in B's store, and B will re-execute the operation. This is the **cross-region duplicate window**, and it is the primary reason that globally distributed idempotency is harder than single-region idempotency.

**Distributed idempotency — cross-region duplicate window and strategies:**

```
                            GLOBAL CLIENT
                                  |
                 failover (A timed out) on retry w/ same key
                                  |
        +-------------------------+-------------------------+
        | REGION A (us-east-1)    |   REGION B (eu-west-1)  |
        |                         |                         |
        |  API -> Dedup Store_A   |   API -> Dedup Store_B  |
        |   [key 7f3a: completed] |    [key 7f3a: NOT FOUND]|
        |          |              |           |             |
        |          |              |           | (replication lag: 50ms-2s)
        |          |   async      |           |             |
        |          +--replicate-->+-----------+             |
        |             (Global     |                         |
        |              Tables /   |   >>> DUPLICATE RISK <<<|
        |              logical    |   retry re-executes     |
        |              replication)   business logic        |
        |                         |                         |
        +-------------------------+-------------------------+
                                  |
        THREE MITIGATION STRATEGIES:
        
        (1) KEY-AFFINITY ROUTING                (2) SYNC CROSS-REGION DEDUP
            hash(key) -> "home" region              write to ALL regions before exec
            ALL retries -> home region              via Raft/Paxos consensus
            + zero cross-region window              + strong global dedup
            - cross-region latency                  - 50-150ms added per write
            - requires deterministic routing        - acceptable for payments
        
        (3) ACCEPT WINDOW + RECONCILE
            allow small duplicate rate
            async job detects duplicates -> refunds
            + simple, no consensus
            - financial cost of rare duplicates
            - only viable when duplicate is recoverable
```

Three strategies address this:

- **Key-affinity routing**: hash the idempotency key to a "home" region and route all requests for that key (including retries) to the home region, even under regional failover for other traffic. This eliminates the cross-region window for a given key at the cost of higher latency for cross-region clients and the need for a deterministic routing layer.
- **Synchronous cross-region dedup**: write the idempotency record to all regions synchronously before executing the operation, using a consensus protocol (Raft, Paxos) across regions. This provides strong global deduplication but adds the cross-region round-trip latency to every mutating request — often 50–150 ms — which is acceptable for payments and unacceptable for high-throughput low-latency endpoints.
- **Accept the window and reconcile**: allow a small duplicate rate and run an asynchronous reconciliation job that detects duplicates (e.g., by scanning for multiple charges with the same client reference within a window) and issues compensating refunds. This is the pragmatic choice for systems where the duplicate cost is financial rather than safety-critical, and where the operational complexity of global consensus is not justified.

## Conflict Resolution

A conflict arises when a retry arrives with a key that already exists but the **payload differs** from the original. This is almost always a client bug — the client generated a new idempotency key for a different operation (correct) but accidentally reused an old key, or it mutated the payload between retries (incorrect). The server's response defines the system's conflict-resolution posture.

The safest and most common choice is to **reject with a 422 Unprocessable Entity** (or 409), returning a clear error message that the idempotency key has already been used with a different request body, and including a hash or summary of the original request so the client can diagnose the mismatch. Silently replaying the old response (ignoring the new payload) is dangerous because it masks the client bug; the client believes its updated payload was processed when in fact the original was. Silently executing the new payload (overwriting the old) is worse because it breaks the idempotency guarantee for the original operation.

For the in-progress conflict (same key, same payload, original still running), the correct response is either a `409 Conflict` with a `Retry-After` header (telling the client to back off and retry in N seconds) or a long-poll that blocks until the original completes and then returns its response. The long-poll approach is friendlier to clients but ties up a server connection and must have a timeout (typically 10–30 seconds) after which it falls back to the 409-and-retry model. The choice depends on the expected original-request duration: for sub-second operations, block; for multi-second operations (e.g., a payment that calls a slow processor), return 409 immediately.

## Idempotency vs Exactly-Once

A common interview confusion is equating idempotency with exactly-once delivery. They are related but distinct. **Idempotency** is a property of an operation: applying it N times has the same effect as applying it once. **Exactly-once delivery** is a property of a messaging system: a message is delivered to the receiver once and only once, with no duplicates and no losses.

True exactly-once delivery across an asynchronous network is **impossible** in the general case (the Two Generals Problem and the FLP impossibility result establish that you cannot guarantee both safety and liveness under network partitions and failures). What systems actually provide is **effectively-once processing**: the message may be delivered more than once (at-least-once delivery), but the receiver's processing is idempotent, so the observable effect is as if it were processed once.

**Idempotency vs exactly-once comparison:**

| Dimension | Idempotency | Exactly-Once Delivery |
|-----------|-------------|------------------------|
| What it is | Property of an *operation* | Property of a *messaging system* |
| Definition | Applying N times == applying once | Message delivered once and only once |
| Network feasibility | Achievable on any network | Impossible in general (Two Generals, FLP) |
| Where implemented | Receiver-side (dedup table, key) | Transport-level (dedup at delivery) |
| Realistic pattern | At-least-once delivery + idempotent receiver | "Effectively-once processing" via the two combined |
| Engineering effort | Bounded, robust | Fool's errand at the transport level |
| Duplicate delivery allowed? | Yes (handled by receiver) | No (theoretically) |
| Example | `SET x = 5` (replays are safe) | True exactly-once: provably impossible |
| Combined effect | Same observable outcome as exactly-once | — |

This distinction matters because it tells you where to invest engineering effort. Trying to build an exactly-once delivery layer (deduplicating at the transport level, never sending a duplicate) is a fool's errand that fights fundamental distributed-systems limits. Building an at-least-once delivery layer with an idempotent receiver is achievable, robust, and is the pattern used by every serious payments, order-management, and event-processing system.

The idempotency machinery described in this document — dedup tables, idempotency keys, conditional inserts — is the receiver-side component of effectively-once processing. The delivery side (message queues with acknowledgments and redelivery) provides at-least-once. Together they yield the exactly-once effect the business requires, without pretending to solve the impossible transport-level problem.

## Practical Patterns

### Transactional Outbox

The **transactional outbox pattern** solves the dual-write problem that arises when a single business operation must atomically update a database and publish a message (to Kafka, SNS, etc.) — or, in the idempotency context, when it must atomically commit the business mutation and record the idempotency completion.

The pattern: within the same database transaction that performs the business mutation, the handler also inserts a row into an `outbox` table describing the idempotency-completion record (or the event to publish). Because both writes are in one transaction, they commit atomically. A separate background process (the "outbox drainer" or "relay") reads unprocessed outbox rows and mirrors them to the external system (the Redis dedup store, the Kafka topic), then marks the outbox row as processed. If the drain fails, the outbox row remains and is retried; the business state and the outbox row are consistent because they committed together.

**Transactional outbox pattern (idempotency + Kafka event):**

```
  API HANDLER (single Postgres txn)                       OUTBOX DRAINER (background)
  ================================                       ==========================
  
   BEGIN;
     [1] INSERT idempotency_keys                          +-----------------+
         (key, in_progress) ----+                         |  OUTBOX TABLE   |
                               |                          | (in same txn)   |
     [2] perform business      |                          |  id | event     |  processed
         mutation (charge)     |                          |  ---+-----------+  ---------+
                               |                          |  1  | {resp...}  |  false   |
     [3] INSERT outbox row ----+--->                      |  2  | {resp...}  |  false   |
         (event + event ID)                               +-----------------+         |
                               |                                       |               |
     [4] UPDATE idempotency_keys -> completed                         |               |
         (store response)                                              |               |
   COMMIT;  <---- all atomic ----+                                    |               |
                                  |                                    v               |
                                  |                         [5] poll unprocessed     |
                                  |                             rows                 |
                                  |                                    |               |
                                  |                             [6] publish to        |
                                  |                                 Kafka (event ID   |
                                  |                                 as msg key)       |
                                  |                                    |               |
                                  |                             [7] mark outbox row   |
                                  |                                 processed = true  |
                                  v                                    |               |
   Postgres = source of truth ---------------------------------->  Kafka consumers dedup
   (idempotency row + outbox row committed atomically)           on event ID; effectively-once
                                                                 event emission achieved.
```

For idempotency, the outbox pattern means: the Postgres transaction inserts the `in_progress` idempotency row, performs the mutation, writes an outbox row containing the final response, updates the idempotency row to `completed`, and commits. The outbox drainer then mirrors the `completed` record to the Redis or DynamoDB dedup store for cross-service visibility. The business database is the source of truth; the external dedup store is a fast-path cache that is eventually consistent with it. Retries that hit the Postgres table get immediate, authoritative answers; retries that hit the external store get fast answers that are correct except in the brief pre-drain window.

### Dedup Table with Colocated Transaction

When the dedup table lives in the same Postgres database as the business tables, the implementation is a single transaction and the outbox machinery is unnecessary. The handler executes:

```sql
BEGIN;
INSERT INTO idempotency_keys (key, status, payload_hash)
  VALUES (..., 'in_progress', ...)
  ON CONFLICT DO NOTHING;
-- if insert succeeded, perform business logic;
UPDATE idempotency_keys
  SET status='completed', response=...
  WHERE key=...;
COMMIT;
```

If the `ON CONFLICT DO NOTHING` insert affected zero rows, the key already exists and the handler reads the existing row and replays or waits. This is the simplest correct implementation and should be the default choice for any service whose business logic already runs in a relational database. The dedup table is range-partitioned by `created_at` for efficient TTL eviction, and the `key` column is the primary key within each partition.

### Create-or-Get via Unique Constraint

For entity-creation endpoints where a natural unique key exists (e.g., `(tenant_id, client_request_id)` for order creation), a unique constraint on the business table itself provides deduplication without a separate idempotency table. The handler attempts `INSERT INTO orders (...) VALUES (...)`, and on a unique-constraint violation, it queries for the existing order by the natural key and returns it.

This is cheaper (no extra table, no extra write) and naturally idempotent, but it requires that the response can be reconstructed from the persisted entity (not a cached response blob) and that the natural key is truly unique across all dimensions that matter. It is less flexible than a dedicated dedup layer because it cannot cache arbitrary response metadata (headers, computed fields) and cannot enforce payload-match validation, but for straightforward create endpoints it is an elegant and low-overhead choice.

## Capacity Planning

Sizing the idempotency store requires estimating the **write rate** (one dedup insert per mutating request), the **retention volume** (write rate × TTL in seconds), and the **read rate** (one dedup check per request, including retries — typically 1.0–1.3× the write rate depending on the retry ratio). For a service handling 10,000 mutating requests per second with a 24-hour TTL, the steady-state dedup table size is 10,000 × 86,400 = 864 million rows. At ~200 bytes per row (key, status, response hash, timestamps), that is ~170 GB of dedup data — non-trivial and a strong argument for partitioning and aggressive TTL pruning where the business permits.

For Postgres, the key capacity considerations are:

- **Write throughput** — the dedup table is append-mostly with occasional updates, which is WAL-heavy.
- **Index size** — the primary key on the idempotency key is a B-tree that must fit in memory for low insert latency; aim for the hottest working set (the last hour or two of keys) to fit in `shared_buffers`.
- **Vacuum overhead** — if using `DELETE`-based cleanup rather than partition drops, the dead tuples from mass deletes must be vacuumed, which competes with the write load. Partitioning by day and dropping old partitions eliminates the vacuum problem entirely.

For Redis, the consideration is memory: the dedup dataset must fit in RAM, and the TTL-based eviction means memory usage is bounded by write-rate × TTL × average-value-size. For DynamoDB, the considerations are write-capacity-unit provisioning (or on-demand cost) and the hot-partition risk if keys are not uniformly distributed — UUID v4 keys distribute uniformly by construction, but sequential or timestamp-based keys can create hot partitions.

A capacity-planning pitfall: the **retry storm**. Under a downstream outage, the retry ratio can spike from 1.1× to 5–10× as every client retries aggressively. The dedup store must be provisioned for the retry-storm peak, not the steady state, because the dedup check is the first thing every retry hits — and if the dedup store is overloaded, it becomes the bottleneck that prevents the system from recovering (the retries pile up at the dedup layer before they even reach the business logic). Over-provisioning the dedup store by 3–5× steady-state capacity is prudent for any system where retry storms are plausible, which is to say, any system with clients that retry.

## Weaknesses & Improvements

The idempotency layer is itself a single point of failure: if the dedup store is down, every mutating request either fails (if the service refuses to process without a dedup check) or proceeds without deduplication (if the service degrades to non-idempotent mode, risking duplicates). The correct failure mode depends on the business:

- For **payments**, **fail closed** (reject the request rather than risk a duplicate charge).
- For a **low-stakes notification endpoint**, **fail open** (send the notification, accept the rare duplicate).

This decision should be explicit and configurable, not an accident of implementation. A robust system also monitors the **dedup hit rate** (the ratio of retries to first attempts) — a rising hit rate signals upstream instability (clients retrying more, indicating timeout or error problems) and is an early warning signal worth alerting on.

Another weakness is **key reuse across operations**: if a client generates idempotency keys by incrementing a counter and the counter resets (a bug, a redeploy without persistent state), it will reuse keys across logically distinct operations, and the server will incorrectly replay old responses. Server-side **payload-hash validation** (storing a hash of the original request and rejecting mismatches) catches this class of bug at the cost of an extra stored field and a comparison per retry. This is strongly recommended for any endpoint where the cost of an incorrect replay is high.

## ⚡ Sharp Question + Model Answer

**Question:** Your idempotency table is in Postgres and your business logic writes to the same Postgres, so you use a single colocated transaction — great. But now you need to publish an event to Kafka after the payment succeeds, and you cannot have a duplicate event (downstream consumers are not all idempotent). The Kafka publish and the Postgres commit are not atomic. How do you prevent a duplicate event without losing one?

**Model Answer:** Use the transactional outbox pattern. Within the same Postgres transaction that performs the charge and updates the idempotency row to `completed`, insert a row into an `outbox` table containing the event payload and a unique event ID (which can be derived from the idempotency key, so the event itself is idempotently identifiable). Commit the transaction — the charge, the idempotency record, and the outbox row all commit atomically.

A separate outbox-drainer process reads unprocessed outbox rows, publishes them to Kafka with the event ID as the Kafka message key (so Kafka's log compaction and downstream consumer dedup can work), and marks the outbox row as published. If the drainer crashes after publishing but before marking the row, it re-publishes on restart — but because the event ID is deterministic and downstream consumers can dedup on it (or Kafka's producer is idempotent with `enable.idempotence=true`, which prevents duplicate messages within a producer session), the duplicate publish is harmless. If the drainer crashes before publishing, the outbox row is still there and will be published on restart — no event lost.

The key insight is that the outbox table, being in the same transaction as the business mutation, inherits its atomicity, and the drainer provides at-least-once delivery to Kafka, which combined with the idempotent event ID yields effectively-once event emission. This is the standard pattern for reconciling transactional databases with non-transactional downstream systems, and it is exactly the same principle as the idempotency layer itself: accept at-least-once delivery, make the receiver idempotent.

**Common Pitfall:** The most common idempotency bug in production is the **"completed but not really" window** in the separate-store pattern: the handler marks the idempotency key as `completed` in Redis, then crashes before committing the Postgres transaction (or the Postgres commit fails). The client retries, sees `completed` in Redis, and receives a replayed response for an operation that never actually committed. The business state is inconsistent with the idempotency record, and the client has no way to detect it.

The fix is to never mark the key `completed` in the separate store until **after** the business transaction commits — and to do that marking via a transactional outbox drainer so that the completion record is durable and eventually consistent with the business state. Naive implementations that update Redis first (for latency) and Postgres second (for durability) get this backwards and create exactly the class of bug that idempotency was supposed to prevent.

## Key Insight to Remember

Idempotency is not a header you add; it is a distributed-systems invariant you engineer. The header is the easy part. The hard part is guaranteeing that the side effect and the idempotency record commit atomically — or, when they cannot, designing the reconciliation and outbox machinery that makes the gap small and recoverable.

Always ask:

- What happens if a crash occurs between every pair of steps?
- What does the retry see?
- Is the response replayed or reconstructed, and are they identical?

If you cannot answer these for every failure point, your idempotency layer has a bug you have not found yet.

## Related

- [[Transactional Outbox Pattern]]
- [[At-Least-Once, At-Most-Once, Exactly-Once]]
- [[Distributed Cache (Redis-Memcached)]]
- [[Message Queue (Kafka-RabbitMQ)]]
- [[Database Sharding & Replication]]
- [[Circuit Breakers & Bulkheads]]
- [[Event Sourcing & CQRS]]

---

## Interview Cheat Sheet

**Key Points to Remember:**
- An idempotent API produces the same result whether called once or many times — the key is a client-generated idempotency key
- Server stores the idempotency key + response for a TTL period; on retry, returns the stored response instead of re-executing
- Idempotency keys must be per-request, not per-session — each unique operation gets its own key
- For payment systems, idempotency is non-negotiable: a retried checkout must never double-charge
- The idempotency layer must be outside the business logic — check the key before entering the transaction

**Common Follow-Up Questions:**
- "Where do you store idempotency keys?" — In a fast key-value store (Redis) with TTL, or in the same database as the business data (for transactional consistency).
- "What happens if the idempotency key store is down?" — Fail open (allow the request through, accept rare duplicates) or fail closed (reject the request). The choice depends on the business cost of duplicates vs. the cost of unavailability.

**Gotcha:**
- Idempotency is not the same as deduplication. Idempotency prevents re-execution; deduplication removes duplicates after they occur. You need idempotency at the API layer, not deduplication at the database layer.
