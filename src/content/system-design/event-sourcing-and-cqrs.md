---
title: "Event Sourcing & CQRS"
type: system-design
category: Advanced
date: 2026-05-21
tags: [system-design, interview, advanced, event-sourcing, cqrs, eventual-consistency, projections, event-store, sagas, kafka, snapshots]
aliases: []
difficulty: advanced
read_time: 25
listen_time: 33
---

# Event Sourcing & CQRS

## Summary & Interview Framing

An architecture where state changes are stored as an immutable event log (event sourcing), and reads are separated from writes using different models (CQRS). The event store is the system of record; current state is derived by replaying events, while projections build specialized read models from the log for query-optimized access.

**How it's asked:** "Design an event-sourced system for a banking ledger. Handle event schema evolution, snapshots, replay, and separate read models for balance queries and audit trails."

---

## Overview

**Event Sourcing** persists every state-changing fact as an immutable, append-only sequence of events, and treats that log — the *event store* — as the system of record. The "current state" of any entity is never stored directly; it is a *derived* value, computed by folding the events for that entity in order. **CQRS** (Command Query Responsibility Segregation) is a separate but companion pattern: it splits the model used to accept writes (commands) from the model(s) used to serve reads (queries), allowing each side to be optimised independently. The two are frequently paired because event sourcing naturally produces a write-optimised, ordered log, while CQRS consumes that log to build many specialised read models (projections) — but they are emphatically not the same thing. You can practise CQRS without event sourcing (separate read replicas or a denormalised read table updated synchronously), and you can practise event sourcing without CQRS (replaying events into a single aggregated model on every query).

At staff level, this topic stops being about definitions and becomes a test of how well you reason about the *seams*: where eventual consistency bites, how to evolve schemas on a log you cannot rewrite, how to keep replay times bounded as years of events accumulate, how to make handlers idempotent under at-least-once delivery, and how sagas coordinate long-running workflows across services without a distributed transaction. The rest of this note walks those seams in depth.

## The Event Store as Source of Truth

The defining commitment of event sourcing is that the event store is the *only* authoritative state. Everything else — every read model, every cache, every in-memory aggregate — is disposable and reconstructable. This is a profound inversion of the usual CRUD model, where a row in a table *is* the state and updates mutate it in place. In event sourcing, a row in a table is at best a cached projection; if it drifts or is lost, you delete it and replay the log. This single property yields four consequences worth internalising.

First, you get a complete, immutable audit trail for free. Every deposit, every address change, every refund is recorded with who, what, and when, in the exact order it happened. Regulators and finance teams love this because "show me the history of account X" is a query against the log, not a reconstruction from a mutable row that may have been overwritten. Second, you get temporal queries for free: because state is a pure function of the event stream, you can compute the state of an entity *as of any historical instant* by replaying events up to that timestamp. Third, the write path is extremely simple and fast — it is an append, with no read-modify-write cycle, no row-level locking, and no contention on the "current" row. Fourth, you decouple the *shape* of writes from the *shape* of reads: commands produce small, intent-revealing events; projections reshape those events into whatever query-optimal form each consumer needs (a wide table, a search index, a graph).

The price is that the event store becomes the most critical, most irreplaceable component in the system. It must never lose data, it must never reorder events within a stream, and it must remain readable for the entire lifetime of the system (which means you must solve schema evolution on an immutable log — see below). Losing a projection is a nuisance; losing or corrupting the event store is a company-ending event. This is why event stores are typically deployed with synchronous replication, fsync on every append, and careful WAL handling, and why you should never treat "we'll restore from the projections" as a recovery strategy.

### Event Sourcing vs CRUD

| Dimension | CRUD (mutable state) | Event Sourcing (append-only log) |
|---|---|---|
| System of record | Current row in a table | Immutable event log |
| State representation | Stored directly; mutated in place | Derived by folding events in order |
| Update semantics | Read-modify-write; in-place overwrite | Append-only; corrections are events |
| Audit trail | Optional; often lost on overwrite | Free; complete, ordered, immutable |
| Temporal queries | Hard/impossible (old values overwritten) | Native (replay to a timestamp) |
| Write path | Read-modify-write, row locking, contention | Pure append; no read-modify-write |
| Write/read shape coupling | Same table serves both | Decoupled; events vs. projections |
| Recovery model | Restore from backup; lose recent changes | Replay log to rebuild any projection |
| Schema evolution | Alter table in place; migrate rows | Upcasters / versioned interpretation layer |
| Storage growth | Bounded by current-state size | Monotonic; grows with event volume forever |
| Failure blast radius | Lost row = lost state | Lost projection = reindex; lost log = catastrophic |

## The Append-Only Log: Mechanics and Guarantees

Mechanically, an event store is a set of *streams*, where a stream is an ordered, append-only sequence of events belonging to a single aggregate (an account, an order, a shopping cart). Each event carries a monotonically increasing *version* or *sequence number* within its stream, a globally unique event id, a timestamp, the event type, and a serialised payload. Appends are conditional on an *expected version*: a client says "append these events to stream S, provided its current version is N." If the store's version is not N — because another writer appended in between — the append fails with a concurrency conflict (an optimistic-concurrency violation) and the client must re-read, re-validate, and retry. This expected-version check is the mechanism that enforces the invariant of a single aggregate without any locks: serialise all writes through one stream, reject concurrent conflicting writes, and let the application retry.

The log is append-only in the strict sense: events are never edited and never deleted in the normal path. This is what makes it a reliable audit trail and what makes replay deterministic. "Corrections" are themselves events — a `PaymentReversed` event rather than a delete of `PaymentRecorded`. The only sanctioned mutation is *archival*: very old events may be moved to cold storage once they have been folded into a snapshot, provided the snapshot plus the retained tail can still reconstruct full state. Even then, most teams refuse to delete from the live log and instead keep it forever (or for the regulatory retention window), relying on snapshotting to bound *replay* cost without bounding *storage*.

Durability and ordering guarantees vary by store. Dedicated event stores (EventStoreDB, Axon, Marten) provide first-class stream semantics, optimistic concurrency, and often subscriptions. If you build on a general-purpose database, you typically implement the log as an `events` table with `(stream_id, version)` as a unique constraint — the unique index *is* your optimistic-concurrency enforcement — and use `SERIALIZABLE` or row-level locking on the stream head to serialise appends. Kafka is sometimes used as the event store itself (see below), but Kafka's partition is a coarser unit than a business aggregate stream, so you must partition by aggregate id and accept that the "expected version" check becomes a partition-level offset check rather than a per-aggregate version.

### Event Store Append-Only Log

```
                     EVENT STORE (system of record)
  ┌────────────────────────────────────────────────────────────────────┐
  │                                                                    │
  │  Stream: account-42                       Stream: order-77         │
  │  ┌─────────────────────────────────────┐  ┌─────────────────────┐  │
  │  │ v1 │ AccountOpened    {owner,...}   │  │ v1 │ OrderPlaced     │  │
  │  │ v2 │ FundsDeposited   {amt: 100}    │  │ v2 │ PaymentCharged  │  │
  │  │ v3 │ FundsWithdrawn   {amt: 30}     │  │ v3 │ OrderShipped    │  │
  │  │ v4 │ AddressChanged   {city: ...}   │  │ v4 │ OrderDelivered  │  │
  │  │ v5 │ FundsDeposited   {amt: 50}     │  │    │                 │  │
  │  │    ▼ append-only, never edited      │  │    ▼ append-only     │  │
  │  └─────────────────────────────────────┘  └─────────────────────┘  │
  │                                                                    │
  │  Each event: { id, stream_id, version, type, timestamp, payload }  │
  │  Append guard: expected_version == current stream version          │
  │  Unique constraint on (stream_id, version) => optimistic concurrency│
  └────────────────────────────────────────────────────────────────────┘
         ▲                              │
         │ append(events, expectedVer)  │ ordered subscription / tail
         │  fails if version mismatch   ▼
     Write side                    Projections / Sagas / Kafka bus

  "Current state" = fold(events[1..N])
      AccountOpened  -> FundsDeposited(100) -> FundsWithdrawn(30)
                     -> FundsDeposited(50)   =>  balance = 120
```

## Event Schema Evolution and Versioning

The hardest long-term problem in event sourcing is that events are *immutable facts* but their *schema* must evolve. An `OrderPlaced` event written in 2019 had a certain shape; the same logical event in 2026 may need additional fields, renamed fields, or a restructured payload. You cannot rewrite billions of historical events, and you cannot break projections that consume five-year-old events. You need a deliberate versioning and evolution strategy, and it must be decided *before* you write the first event, because retrofitting it is painful.

The baseline technique is **weak schema evolution** via optional fields and additive change: new fields are added with defaults, old consumers ignore unknown fields, and you never remove or rename a field that existing consumers depend on. This works for purely additive changes and is the cheapest path — most teams adopt Avro, Protobuf, or JSON Schema with forward/backward compatibility rules enforced in CI. The next level is **event versioning**: include a `schema_version` (or `event_version`) field in the event metadata, and have consumers branch on version during deserialisation. `OrderPlaced.v1` had `currency` as a free string; `OrderPlaced.v2` carries an ISO-4217 code plus a `tax_breakdown` array. A version-aware deserialiser (an "upcaster" or "normaliser") transforms v1 payloads into the v2 canonical shape on read, so the domain logic and projections only ever see the latest shape. Upcasters are pure functions composed in a chain (v1→v2→v3) and are the standard pattern in mature frameworks (Axon's `EventUpcaster`, EventStoreDB's upcaster pipelines).

The harder cases are *semantic* drift — the meaning of a field changed, or a business rule was applied retroactively — and *structural* changes that upcasting cannot hide. For these you generally accept one of two strategies: introduce a new event type entirely (`OrderPlacedV2` alongside the legacy `OrderPlaced`) and route new writes to it, leaving old streams to keep producing the old type; or perform a one-off *migration* that reads the entire log, applies a transformation, and writes a *new* event stream or a new projection while keeping the original log untouched as the legal record. Never rewrite the original events in place — you lose the audit property and you invalidate every snapshot's assumptions. The golden rule is: the log is append-only and immutable; evolution happens at the *interpretation* layer (upcasters, versioned projections), not at the storage layer.

### Event Versioning Rules

- **Decide the strategy before the first event.** Retrofitting versioning onto a log with billions of events is painful; bake it in from day one.
- **Prefer additive, backward-compatible change first.** New optional fields with defaults; old consumers ignore unknown fields; never remove or rename a field existing consumers depend on.
- **Enforce compatibility in CI.** Adopt Avro, Protobuf, or JSON Schema with forward/backward compatibility rules checked on every producer change (schema registry rejects incompatible schemas pre-deploy).
- **Carry an explicit version in event metadata.** Include `schema_version` / `event_version` so consumers can branch on version during deserialisation.
- **Transform on read with upcasters.** Version-aware normalisers (pure functions, composed as a chain v1→v2→v3) convert old payloads to the current canonical shape, so domain logic and projections see only the latest shape.
- **Never rewrite historical events in place.** The log is immutable; rewriting loses the audit property and invalidates snapshot assumptions. Evolution lives at the interpretation layer, not the storage layer.
- **For semantic drift or structural change, fork the event type.** Introduce `OrderPlacedV2` alongside the legacy `OrderPlaced`; route new writes to the new type; leave old streams on the old type.
- **For retroactive business rules, run a one-off migration.** Read the log, transform, write a new stream or new projection — keep the original log untouched as the legal record.
- **Version snapshots too.** Include a `snapshot_schema_version`; skip snapshots produced by older domain logic and fall back to a full replay for those streams.

## Snapshots and Snapshotting Strategies

Without snapshots, reconstructing an aggregate's state requires replaying every event in its stream from the beginning — a cost that grows linearly with the stream's age. An account opened in 2018 and active ever since may have tens of thousands of events; rebuilding it on every command is unacceptable. **Snapshotting** breaks that linear cost by periodically persisting the *fully-folded state* of an aggregate at a specific version, so that a rebuild loads the nearest snapshot and replays only the events after it.

The simplest and most common strategy is **frequency-based snapshotting**: every N events appended to a stream, persist a snapshot at that version. N is tuned per aggregate type — small enough that replay-after-snapshot stays in the millisecond range, large enough that you don't pay snapshot-write overhead on every append (a common choice is N=100 to N=500). The snapshot is keyed by `(stream_id, version)` and is itself an append to a `snapshots` store; on rebuild, you fetch the highest-version snapshot below the requested version and fold forward. A subtlety: snapshots must be *consistent* with the event folding function. If you change your domain logic, old snapshots encode the old logic's output and will produce wrong state on rebuild. The standard mitigation is to include a `snapshot_schema_version` and to *invalidate* (skip) snapshots whose schema version is older than the current folder, falling back to a full replay for those streams. Many teams also add a manual "purge all snapshots" operation tied to a deploy of logic-changing code, accepting a one-time slow rebuild.

A second strategy is **time-based snapshotting**: snapshot at most once per T (e.g., daily), useful when streams are bursty. A third is **demand-driven / on-demand snapshotting**: snapshot only when a rebuild actually happens and the replay exceeded a threshold — this avoids snapshotting cold streams that are never read. A fourth, increasingly popular at scale, is **caching the live aggregate**: keep the folded aggregate in an in-memory cache (or a fast KV store) keyed by stream id, invalidate on eviction, and rebuild only on cache miss — effectively a snapshot on every state change, trading memory for replay cost. The right combination depends on read/write ratios, stream length distributions, and memory budget. The key capacity invariant to enforce: *worst-case rebuild time* (snapshot interval ÷ append rate × per-event fold cost) must stay under your command-latency SLA, with headroom for cold-cache misses.

### Snapshot Strategies Compared

| Strategy | Trigger | Best for | Cost trade-off | Watch-outs |
|---|---|---|---|---|
| Frequency-based | Every N events appended | General purpose; steady streams | Snapshot write every N appends; bounded replay | Tune N per aggregate; invalidation on logic change |
| Time-based | At most once per T (e.g. daily) | Bursty streams; periodic workloads | Fewer snapshot writes; replay can exceed T of events | Replay window grows with burst size |
| Demand-driven / on-demand | When a rebuild replay exceeds a threshold | Cold streams rarely read | No overhead on unread streams | First rebuild after threshold is slow |
| Cache the live aggregate | Every state change (in-memory / KV) | Hot, high-traffic aggregates | Memory-for-replay trade; near-zero replay on hit | Eviction → cold miss; invalidation discipline |
| Projection snapshot / checkpointed dump | Periodic dump of the read model | Full-projection rebuild SLAs | Bounds *projection* rebuild, not per-aggregate | Stale between dumps; reindex pipeline needed |

## Projections and Read Models (CQRS Separation)

CQRS formalises what event sourcing makes natural: the write side accepts *commands*, validates them against the aggregate (rebuilt from the log), and appends events; the read side serves queries from *projections* — independently-built, query-optimised representations derived from the event stream. The two sides have different shapes, different scaling characteristics, and different consistency models, and that separation is the whole point. The write model is small, normalised, and optimised for correctness and append throughput; each read model is denormalised, wide, and optimised for a specific query pattern — a `customer_orders_summary` table, an Elasticsearch index for full-text order search, a Redis sorted set for a leaderboard, a graph store for relationship traversal.

A projection is built by a *projection handler* that subscribes to the event stream and, for each event, updates the read model accordingly. `OrderPlaced` inserts a row; `OrderShipped` sets a status column and writes to a `shipments` index; `OrderCancelled` flips the status and emits a compensating entry to a revenue projection. Because projections are derived, you can have *as many as you want* without touching the write side, and you can rebuild any of them from scratch by replaying the log — which is the recovery story when a projection is corrupted, when you add a new query, or when you change a projection's schema. This "throw away and replay" property is one of the most powerful operational features of the pattern: a bad migration becomes a reindex, not a data-loss incident.

The separation also enables independent scaling and independent technology choice. A write store optimised for ordered appends (EventStoreDB, Postgres events table, Kafka) can be paired with read stores optimised for their access pattern (Postgres for transactional reads, ClickHouse for analytics, OpenSearch for search, Redis for hot lookups). The cost is operational complexity: you now run more infrastructure, and you must monitor projection lag (see below) as a first-class SLI. A common failure mode is teams that build five projections but only alert on the write side — the system looks healthy while reads are serving stale data because one projection handler is wedged.

### CQRS Read/Write Separation

```
                         ┌──────────────────────┐
                         │      Client / API     │
                         └──────────┬───────────┘
            commands (write)        │        queries (read)
                         ▼          │            ▼
            ┌────────────────┐      │      ┌────────────────┐
            │   Write Side   │      │      │   Read Side    │
            │  (Command Bus) │      │      │  (Query APIs)  │
            └───────┬────────┘      │      └───────▲────────┘
                    │               │              │
                    ▼               │              │
        ┌───────────────────┐       │      ┌───────────────┐
        │   Aggregate(s)    │       │      │  Projections  │
        │  decide()→events  │       │      │  (read models)│
        │  apply()→state    │       │      └───────▲───────┘
        └─────────┬─────────┘       │              │
                  │ append events   │      update  │
                  ▼ (expected ver)  │              │
        ┌───────────────────┐       │              │
        │    EVENT STORE    │───────┼──────────────┘
        │  (system of       │ subscribe / tail
        │   record, log)    │──────────────────────────► projection handlers
        └───────────────────┘
        STRONG consistency        EVENTUAL consistency
        (validate vs log)         (projections lag the log)

  Rule: command validation ALWAYS reads the event store, never a projection.
```

## Eventually Consistent Reads

Because projections are populated *asynchronously* by subscribing to the event stream, there is an unavoidable lag between the moment a command appends an event and the moment that event is reflected in a given projection. This is *eventual consistency*, and it is not a bug to be eliminated — it is an inherent property of the architecture that must be modelled explicitly. The lag has several sources: the time for the event store to publish the event to subscribers, the time for the projection handler to process it, the time to commit the read-model update, and any batching the handler does for throughput. Typical lag is tens to hundreds of milliseconds; under load or during a backlog it can balloon to seconds or minutes.

The engineering discipline is to make this lag *measurable and bounded*. Every projection should track a *checkpoint* (the last event sequence number it has applied) and expose it; the system should expose the event store's current head; and the gap between them is your projection lag, graphed and alerted on. A common pattern is for read APIs to return not just data but also the *as-of version* they reflect, so a client that just issued a command can poll or wait until the read model catches up to the version it knows its write produced ("read-your-writes consistency through version gating"). Some systems offer a *read-your-writes* guarantee by routing a client's reads to a projection that has been confirmed to have processed at least up to the client's last write — a stronger but more expensive contract.

Where you cannot tolerate the lag — typically for the *command validation* itself, which must see the aggregate's current state — you do *not* read from a projection; you rebuild the aggregate from the event log (with snapshots), which is strongly consistent because it reads the authoritative stream. This is the key consistency boundary: writes are strongly consistent against the event store; reads from projections are eventually consistent; the aggregate rebuild for command validation is strongly consistent against the log. Designers who confuse these three and try to validate commands against a projection get subtle correctness bugs (a command accepted against stale state, producing an event that violates an invariant). The rule: *command validation always reads the event store, never a projection*.

### Projection Rebuild Flow

```
  Trigger: projection corrupted  |  new query added  |  schema changed
                                   │
                                   ▼
          ┌───────────────────────────────────────────────────┐
          │  1. DROP / TRUNCATE the target read model          │
          │     (it is disposable & reconstructable)           │
          └───────────────────────┬───────────────────────────┘
                                  ▼
          ┌───────────────────────────────────────────────────┐
          │  2. RESET projection checkpoint to 0               │
          │     (last_applied = 0, idempotency table cleared)  │
          └───────────────────────┬───────────────────────────┘
                                  ▼
          ┌───────────────────────────────────────────────────┐
          │  3. REPLAY the event log from the beginning        │
          │     ┌──────────┐   partition by aggregate id       │
          │     │  EVENT   │   ┌──────┐ ┌──────┐ ┌──────┐      │
          │     │  STORE   │──►│worker│►│worker│►│worker│      │
          │     │ (log)    │   └──┬───┘ └──┬───┘ └──┬───┘      │
          │     └──────────┘      │        │        │          │
          │   parallelised:       ▼        ▼        ▼          │
          │   total_events ÷ replay_throughput = rebuild time   │
          └───────────────────────┬───────────────────────────┘
                                  ▼
          ┌───────────────────────────────────────────────────┐
          │  4. APPLY each event via projection handler        │
          │     idempotent + in-order within partition         │
          │     advance checkpoint in same tx as read-model    │
          │     update (both succeed or neither)               │
          └───────────────────────┬───────────────────────────┘
                                  ▼
          ┌───────────────────────────────────────────────────┐
          │  5. CATCH UP to event store head                   │
          │     checkpoint == head  =>  rebuild complete       │
          │     switch handler back to live subscription       │
          └───────────────────────────────────────────────────┘

  Bounded by:  total events ÷ replay throughput  ≤  recovery SLA
  Speed-ups:   partition the log, shard the projection,
               use periodic projection snapshots as starting point
```

## Command Validation and the Write Side

The write side is organised around *commands* — imperative, intent-revealing requests ("PlaceOrder", "CancelOrder", "TransferFunds") — and *aggregates*, the consistency boundary that enforces invariants. Processing a command is a four-step pipeline: load the aggregate by replaying its event stream (from the latest snapshot), apply the command to the aggregate's current state to decide whether it is *allowed* and, if so, which events it produces, append those events to the stream with the expected-version check, and publish them to subscribers. The decisive property is that *validation happens against the folded current state*, and the events emitted are the *decision*, not a mutation. The aggregate never mutates state directly; it returns events, and those events are what actually change state when folded.

This split between "decide" (pure function of command + state → events) and "apply" (pure function of state + event → new state) is what makes the whole pattern tractable: the same `apply` function is used both during command processing and during replay, guaranteeing that the state reconstructed from the log is identical to the state the command saw. Idempotency of command handling is typically achieved with an *idempotency key* (a client-generated UUID) stored alongside the events or in a dedup table: if a command with the same key has already been processed, return the cached result instead of appending duplicate events. Without this, retries (network failures, client retries) produce double-charged cards and duplicate orders — a classic production incident.

Concurrency on the write side is handled by the expected-version check described earlier. When two commands target the same stream concurrently, the first append succeeds and bumps the version; the second's expected-version check fails, and the command is retried by re-loading the aggregate (now including the first command's events), re-validating, and re-deciding. Under contention this retry loop can livelock, so aggregates should be small (a single account, a single order) to keep contention localised, and high-contention hotspots should be modelled with finer-grained aggregates or with a saga/event-driven coordination rather than a single bottleneck aggregate.

## Idempotency in Event Handlers

Projection handlers and saga processors consume events from a subscription, and subscriptions almost always deliver events *at-least-once*, not exactly-once — exactly-once delivery is provably impossible across a network with failures, and even Kafka's "exactly-once" is really transactional consume-produce, not transactional external side effects. So every handler must assume it will see the same event more than once (after a crash mid-commit, a rebalance, a redelivery) and must be *idempotent*: applying an event a second time must not change the projection's state or produce duplicate side effects.

The standard mechanism is to record the *last processed event id* (or sequence number) per handler and skip events already applied. For a projection backed by a database, this is often done transactionally with the projection update itself: in the same transaction that updates the read model, advance the handler's checkpoint, so either both happen or neither. For handlers that produce external side effects (sending an email, calling a payment gateway), the checkpoint alone is insufficient because the side effect may have succeeded before the crash; you need an *idempotency table* keyed by event id plus handler id, recording that the side effect was attempted, and the external system itself must be idempotent on its own idempotency key (a payment API called twice with the same idempotency key returns the same result rather than charging twice).

A subtle trap is *out-of-order* delivery. Some subscriptions (Kafka partitions within a stream, cross-stream merges) can deliver events out of order, and a naive "apply every event" handler will corrupt state — e.g., applying `OrderShipped` before `OrderPlaced`. Mitigations include partitioning strictly by aggregate id so per-stream order is preserved, buffering out-of-order events until the predecessor arrives, or designing projections to be order-insensitive where possible (using event timestamps and merge logic rather than positional apply). For most business projections, partitioning by aggregate id and requiring in-order delivery within a partition is the pragmatic choice, and you alert on sequence gaps as a sign of a broken pipeline.

## Sagas with Event Sourcing

A *saga* is a long-running, multi-step business process that coordinates work across several services or aggregates without a distributed transaction, using compensating actions to roll back when a step fails. In an event-sourced system, sagas are themselves often modelled as event-sourced state machines: a saga instance has its own event stream (`SagaStarted`, `FlightReserved`, `HotelBooked`, `PaymentCharged`, `SagaCompleted`, or `SagaCompensated`), its current state is rebuilt by replaying those events, and it reacts to events from the participating services by emitting commands and, eventually, its own events.

The classic example is the travel-booking saga: reserve a flight, reserve a hotel, charge payment; if the hotel reservation fails, cancel the flight and refund any partial charge; if the payment fails, cancel both. Each step is a command to a separate aggregate (or service), each emits events, and the saga subscribes to those events to drive its state machine forward. Because there is no two-phase commit across the flight, hotel, and payment services, the saga must be designed for *semantic atomicity* through compensations, not technical atomicity through a transaction. This means the business must accept that intermediate states are observable (a flight can be reserved before the hotel is confirmed) and that "rollback" is a domain-level compensation (a `FlightCancelled` event), not a database rollback.

Modelling sagas as event-sourced state machines gives you the same benefits as any event-sourced aggregate: full auditability of the process, rebuildability, and a clear current-state reconstruction. It also gives you a natural place to enforce *process idempotency*: a saga's state encodes which steps have completed, so a redelivered `FlightReserved` event finds the saga already in the `flight_reserved` state and is a no-op rather than a double-charge. The failure modes to design for are: a saga stuck because a compensating command itself fails (you need retry with backoff plus human escalation / a "poison" state), a saga that cannot complete because a participant is permanently unavailable (you need a timeout/slip mechanism that forces a compensation decision), and duplicate saga instances from duplicate triggering events (gate saga creation on a correlation id). Sagas are where event sourcing meets its hardest coordination problems, and they are a frequent interview focus precisely because they expose whether a candidate understands that distributed consistency is a *business* design problem, not a database feature.

### Saga with Event Sourcing Flow

```
  Travel Booking Saga  (event-sourced state machine, own event stream)

  Trigger: OrderRequested event  ──►  SagaStarted (saga stream v1)
                                        │
                                        ▼
                           ┌─────────────────────────┐
                           │  State: started          │
                           │  emit cmd: ReserveFlight │
                           └────────────┬────────────┘
                                        ▼
                        ┌──────────────────────────────┐
                        │  Flight Service (aggregate)   │
                        │  FlightReserved event         │
                        └───────────────┬──────────────┘
                                        │ saga subscribes
                                        ▼
                           ┌─────────────────────────┐
                           │  State: flight_reserved  │
                           │  Saga stream: v2          │
                           │  emit cmd: ReserveHotel   │
                           └────────────┬────────────┘
                                        ▼
                        ┌──────────────────────────────┐
                        │  Hotel Service (aggregate)    │
                        │  HotelReserved  ─or─  Failed   │
                        └───────────────┬──────────────┘
                                  success│        │failure
                                        ▼        ▼
                          ┌──────────────┐  ┌──────────────────┐
                          │ hotel_booked │  │ COMPENSATE:       │
                          │  emit cmd:   │  │  CancelFlight     │
                          │  ChargePayment│  │  FlightCancelled  │
                          └──────┬───────┘  │  SagaCompensated  │
                                 ▼          └──────────────────┘
                        ┌──────────────────┐
                        │ Payment Service   │
                        │ PaymentCharged    │
                        └────────┬─────────┘
                                 ▼
                          ┌──────────────┐
                          │ SagaCompleted │
                          │ saga stream: vN│
                          └──────────────┘

  Properties:
   - No 2PC; semantic atomicity via compensations (FlightCancelled, RefundIssued)
   - Saga state = fold(saga events); redelivered events are no-ops
   - Idempotency: gate saga creation on correlation id
   - Timeouts force a compensation decision if a participant is unavailable
```

## Event Streaming Integration (Kafka)

A common scaling and integration question is how an event-sourced system relates to a streaming platform like Kafka. The two are often conflated but serve different layers: the event store is the *system of record* (durable, per-aggregate ordered, optimised for appends and replay-by-stream), while Kafka is an *event distribution backbone* (high-throughput, partition-ordered, multi-consumer pub/sub). The cleanest architecture uses the event store as the authoritative log and *publishes* each committed event to Kafka so that downstream consumers — projections, analytics, other services, data lakes — can subscribe without each one polling the event store. This is the "event store as source, Kafka as bus" pattern: a small publisher component tails the event store (via its subscription/catch-up API) and writes each event to a Kafka topic, preserving order within a partition keyed by aggregate id.

A key decision is whether Kafka *is* the event store or merely mirrors it. Using Kafka as the event store (log-compaction retained forever, keyed by aggregate id, one partition per aggregate id hash) is tempting because it removes a component, but it has real costs: optimistic concurrency is weaker (you check against the partition's high watermark, not a per-aggregate version), per-aggregate replay requires scanning a partition, snapshotting is harder to bolt on, and the granular stream semantics of a dedicated store are absent. Most production designs therefore keep a dedicated event store for the write/validate path and use Kafka purely as the fan-out bus for reads and integration. This also lets you shape the Kafka events differently from the stored events — e.g., publishing normalised, upcast, public-API events to Kafka while the store keeps the raw internal events.

Integration concerns include *exactly-once* semantics across the boundary. Kafka's transactional producer/consumer (EOS) guarantees that a consumer that reads from Kafka, processes, and writes back to Kafka does so without duplicates *within Kafka*, but it does *not* extend to external side effects (a database projection write). So projection handlers that consume from Kafka and write to Postgres still need their own idempotency (checkpoint + idempotency table), and a Kafka rebalance mid-commit can still cause a redelivery. Schema management across the bus is enforced with a schema registry (Confluent Schema Registry + Avro/Protobuf) so that producers and consumers negotiate compatible versions — this is where the schema-evolution discipline from earlier pays off, because the registry will reject a producer publishing an incompatible schema before any consumer breaks. Finally, plan for *topic partitioning by aggregate id* to preserve per-stream order, and for *partition count as a hard-to-change decision* — choose it based on long-term throughput, not initial load.

## Time-Travel Queries

Because state is a pure fold over the event stream, "what was the balance of account X on 2023-04-15 at 14:00?" is answerable exactly: replay the stream up to that timestamp and stop. This *time-travel* capability is a first-class benefit of event sourcing and is painful or impossible in a CRUD system (where the old values were overwritten). The naive implementation — replay from the beginning up to the target timestamp — works but is O(stream length); for long streams you apply snapshots: find the most recent snapshot *at or before* the target time and fold forward from there. For frequent historical queries, you can build a *time-travel projection* that stores periodic snapshots (e.g., end-of-day balances) indexed by time, so a historical query is a lookup plus a short forward fold.

A more sophisticated read model uses a database that natively supports temporal queries (a `SYSTEM_TIME` period table in SQL:2011, or a bitemporal data model) and have the projection write each event's effect with valid-time and transaction-time, enabling "as-of" and "as-known-at" queries directly in SQL. Bitemporal modelling is expensive but is the right answer when audit and regulatory reconstruction are core requirements (insurance, finance, healthcare). The cost of all time-travel facilities is storage and index complexity, and the discipline to never mutate a historical fact — only append corrections with their own timestamps.

A subtle pitfall: time-travel over *projections* reconstructs the projection's state at a time, which may differ from the aggregate's true state at that time if the projection was lagging then. For authoritative historical state, fold the event stream directly; projections are for query convenience and may encode their own delays. Designers who conflate "the projection said X at time T" with "the aggregate was X at time T" produce subtle audit errors.

## Capacity Planning

Capacity planning for an event-sourced system is unusual because the dominant growth axis is *event volume*, not row count or current-state size — and event volume is permanent and monotonic (you append forever; you rarely delete). The key numbers to model are: events per second written (peak and sustained), average event payload size (which drives storage and network), events per aggregate over its lifetime (which drives per-stream replay cost and thus snapshot frequency), projection count and their per-event processing cost (which drives total compute), and projection lag budget (which drives how much parallelism each projection needs).

Storage grows at `events/s × payload × retention`. At 1k events/s, 1KB each, that is ~86GB/day or ~31TB/year before replication and compaction — a number that forces an early decision on tiering (hot store vs. cold archive) and on whether you ever delete. Most teams keep the live log for the regulatory window (often 7+ years in finance) and move cold events to object storage once folded into snapshots. Read-side compute scales with `events/s × Σ(projection processing cost per event)`; five projections each doing 2ms of work per event at 1k events/s is 10 CPU-seconds per wall-second of pure projection work, before parallelism — so projections are horizontally scaled with per-partition workers, and the partition count must be chosen to allow enough parallelism to keep lag under budget.

Replay capacity is the often-forgotten axis: rebuilding a projection from scratch requires replaying the entire log, and the time to do so (`total events ÷ replay throughput`) must fit your recovery SLA. For a 10-billion-event log at 50k events/s replay, that is ~55 hours — unacceptable for most SLAs, which is why teams build parallelised replay (partition the log, replay each partition concurrently into a sharded projection) and invest in the tooling to do this safely. Snapshots bound *per-aggregate* rebuild but not *full-projection* rebuild; for the latter you need either periodic projection snapshots (a checkpointed dump of the read model) or a parallelised reindex pipeline. Finally, model the *event store* as a write-critical path: its append latency is your command latency, so provision it for the write peak with headroom, replicate synchronously, and fsync on commit — cutting corners here is how teams lose the system of record.

## Interview Question

**Q:** You're running an event-sourced order system. A new projection you just deployed is being populated from the live event stream, but the business reports the new read API is returning *stale* data for orders placed in the last few minutes, while old orders look correct. Walk me through your diagnosis.

**Model answer:** First, distinguish two failure modes: (1) the projection is *behind* (lagging the live stream), which would affect all recent writes, or (2) the projection is *wrong* (mis-handling events), which would affect a subset deterministically. The symptom — recent orders stale, old orders correct — points strongly at lag, not logic: old orders had time to catch up, recent ones have not. I'd check the projection's checkpoint versus the event store head: if the gap is large and growing, the handler is not keeping up (undersized parallelism, a slow downstream, a blocking call in the handler). If the gap is small but the API is still stale, the problem is between the API and the projection — a caching layer in front of the read model with a long TTL, or the API reading from a read replica that is itself lagging. I'd also confirm the API returns its as-of version and compare it to the event store head for a just-placed order; that pinpoints where the staleness lives. Once I know it's projection lag, the fix is capacity (more partitions/workers) or removing a bottleneck in the handler; the *design* fix is to expose lag as an SLI with an SLO, and to offer a read-your-writes path for clients that just wrote. I'd explicitly *not* try to make the projection synchronous — that defeats the CQRS decoupling and couples read latency to write throughput.

**Common pitfall:** Reaching for *synchronous projection updates* or *two-phase commit* to "fix" staleness. This re-couples reads to writes, kills the independent-scaling benefit of CQRS, and under load produces write timeouts that look exactly like the data-loss you were trying to prevent. Eventual consistency between log and projection is a *design property*, not a bug — the correct response is to measure it, bound it, and expose it to clients via version gating, not to eliminate it with a distributed transaction. The complementary pitfall is *validating commands against a projection* to avoid a rebuild: that makes correctness depend on the lag you just accepted, so a command can be accepted against stale state and emit an event that violates an invariant. Command validation always reads the event store.

## Interview Cheat Sheet

**Key Points to Remember:**
- Event sourcing makes an immutable, append-only event log the system of record; current state is *derived* by folding events in order. Projections and caches are disposable — delete them and replay the log to rebuild.
- CQRS separates the write model (commands → events, optimised for append correctness) from read models (projections, optimised per query). They're often paired but independent: you can do CQRS without event sourcing and vice versa.
- Eventual consistency between the log and projections is a *design property*, not a bug. Make lag measurable (checkpoint vs head) and bounded; never "fix" it with synchronous updates or 2PC — that re-couples reads to writes.
- Command validation ALWAYS reads the event store (rebuild the aggregate from the log + snapshots), never a projection. Validating against a stale projection accepts commands that violate invariants.
- Schema evolution must be solved *before* the first event: use upcasters (v1→v2→v3 pure functions) at the interpretation layer; never rewrite historical events in place.

**Common Follow-Up Questions:**
- *How do you handle a projection serving stale data?* — First distinguish lag (checkpoint behind event store head) from logic errors. If lag, add parallelism/partitions or fix a blocking handler; expose lag as an SLI and offer read-your-writes via version gating. Don't make the projection synchronous.
- *How do you keep replay bounded as events accumulate?* — Snapshotting: persist the fully-folded aggregate state every N events so a rebuild loads the nearest snapshot and replays only the tail. Include a snapshot_schema_version and invalidate old snapshots when domain logic changes.
- *Can Kafka be your event store?* — You can, but you lose per-aggregate optimistic concurrency (you get partition-offset checks instead), granular stream semantics, and easy snapshotting. Most production designs keep a dedicated event store for writes and use Kafka only as the fan-out bus.

**Gotcha:**
- People conflate "the projection said X at time T" with "the aggregate was X at time T," but projections lag the log and may have been behind at that moment. For authoritative historical state, fold the event stream directly; projections are for query convenience, not audit truth.
