---
title: "Saga Pattern & Distributed Transactions (Compensation, Orchestration)"
type: system-design
category: Platform
date: 2026-06-17
tags: [system-design, interview, platform, saga, distributed-transactions, compensation, orchestration, choreography, outbox-pattern, eventual-consistency, 2pc, staff-engineering]
aliases: ["Saga Pattern", "Distributed Transactions", "Saga Pattern & Distributed Transactions", "Compensation Transactions", "Saga Orchestration"]
difficulty: advanced
read_time: 20
listen_time: 28
---

# Saga Pattern & Distributed Transactions (Compensation, Orchestration)

> **Staff-Engineer Focus:** "We use sagas instead of distributed transactions" is the mid-level answer. Understanding the fundamental tension between atomicity and availability — and knowing which side of that trade-off your business domain falls on — that's the senior answer. **The Saga pattern isn't a replacement for ACID; it's an admission that ACID doesn't scale across service boundaries, and a structured way to manage the consequences. The staff engineer doesn't ask "should I use saga or 2PC?" They ask: "What is the business cost of an inconsistency, how long can it persist, and which compensating actions are truly reversible vs. merely mitigative?" A refund that issues store credit instead of cash because the payment gateway's compensating API is down is NOT a successful compensation — it's a degraded fallback that must be tracked as technical debt. The interview question isn't "What is a saga?" It's: "Your order service creates an order, reserves inventory, charges payment, and schedules shipping. The shipping service fails because the warehouse API returns a 500. Payment has already been charged. Walk me through: (a) what state the system is in right now, (b) how you'd structure the compensating transactions, (c) what happens if the refund compensation also fails, and (d) why an orchestrator that retries shipping 3 times before compensating is dangerous if inventory reservation has a 5-minute TTL."**

---

## Summary & Interview Framing

A pattern for managing distributed transactions as a sequence of local transactions, each with a compensating action for rollback — avoiding the blocking of Two-Phase Commit.

**How it's asked:** "Design a saga for an e-commerce order spanning payment, inventory, shipping, and notification services. Handle compensation, orchestration vs choreography, and failure recovery."

---

## 1. Why Sagas: The Problem of Distributed Transactions

### 1.1 The Monolith Baseline: ACID

In a monolithic application with a single database:

```sql
BEGIN TRANSACTION;
  INSERT INTO orders (id, user_id, total) VALUES (...);
  UPDATE inventory SET quantity = quantity - 1 WHERE product_id = ...;
  INSERT INTO payments (order_id, amount, status) VALUES (...);
COMMIT;
```

If any statement fails, the entire transaction rolls back. The database guarantees atomicity, consistency, isolation, and durability. This is ACID.

### 1.2 The Microservices Reality: No Shared Database

In a microservices architecture, each of those operations lives in a separate service with its own database:

```
┌──────────┐    ┌───────────┐    ┌──────────┐    ┌──────────┐
│  Order   │    │ Inventory │    │ Payment  │    │ Shipping │
│ Service  │    │  Service  │    │ Service  │    │ Service  │
│  (DB-A)  │    │  (DB-B)   │    │  (DB-C)  │    │  (DB-D)  │
└──────────┘    └───────────┘    └──────────┘    └──────────┘
```

Now there's no `BEGIN TRANSACTION` that spans databases. Each service commits independently. If Payment succeeds but Shipping fails, you have a charged customer with no shipment. This is a **partial failure** — the defining challenge of distributed systems.

### 1.3 Why 2PC Doesn't Scale

Two-Phase Commit (2PC) provides atomicity across databases:

1. **Prepare phase:** Coordinator asks every participant: "Can you commit?" Each participant locks resources and votes YES/NO.
2. **Commit phase:** If ALL vote YES, coordinator tells everyone to commit. If ANY vote NO, coordinator tells everyone to abort.

**Why 2PC breaks at scale:**

| Problem | Impact |
|---------|--------|
| **Coordinator is single point of failure** | Coordinator crash during commit → participants blocked holding locks indefinitely (in-doubt transaction) |
| **Lock duration = slowest participant** | One slow participant holds locks across ALL databases. At 1000 TPS, lock contention kills throughput. |
| **Participants must ALL be available** | One participant down → entire transaction blocked. Availability = product of individual availabilities (0.99^4 = 96% max). |
| **Latency is additive** | 4 participants × 2 network round trips (prepare + commit) = 8 RTTs minimum. At 50ms RTT, that's 400ms per transaction. |
| **Cross-organizational impossibility** | Payment gateway (Stripe) won't participate in your 2PC. You can't hold their locks. |

**The CAP theorem in action:** 2PC chooses consistency over availability. When the network partitions, 2PC blocks. Sagas choose availability over consistency — the transaction eventually completes, but there's a window of inconsistency.

---

## 2. The Saga Pattern: A Structured Alternative

A **Saga** is a sequence of local transactions, each updating data within a single service. Each local transaction publishes an event or message that triggers the next step. If any step fails, the saga executes **compensating transactions** to undo the preceding steps.

### 2.1 The Core Principle

```
Success path:  T1 → T2 → T3 → T4
Failure path:  T1 → T2 → T3(FAILS)
                    ← C2 ← C3 (compensate T2 and T1)
```

Every forward transaction `Tn` has a corresponding compensating transaction `Cn` that semantically undoes its effects. This is NOT a database rollback — it's an application-level undo.

### 2.2 Compensation: What "Undo" Actually Means

| Forward Transaction | Compensating Transaction | Reversible? |
|---------------------|--------------------------|:-----------:|
| `INSERT INTO orders` | `UPDATE orders SET status = 'CANCELLED'` | ✅ Semantically (order exists but cancelled) |
| `UPDATE inventory SET quantity = quantity - 1` | `UPDATE inventory SET quantity = quantity + 1` | ✅ If no race condition |
| `Charge credit card $100` | `Refund credit card $100` | ⚠️ Refund API can fail; may take days |
| `Send confirmation email` | `Send "order cancelled" email` | ✅ Semantically |
| `Reserve warehouse slot` | `Release warehouse slot` | ✅ |
| `Ship physical item` | `Issue return label + restock` | ❌ Physically irreversible once shipped |
| `Generate coupon code` | `Invalidate coupon code` | ✅ |

**The critical insight:** Some compensations are **technical reversals** (database update), some are **business reversals** (refund), and some are **physically impossible** (un-shipping an item). The saga designer's job is to structure the sequence so that the most expensive-to-compensate steps happen LAST.

---

## 3. Saga Coordination: Choreography vs. Orchestration

This is the single most important architectural decision in saga design.

### 3.1 Choreography-Based Saga (Event-Driven)

Each service listens for events and decides independently what to do next:

```
Order Service          Inventory Service      Payment Service        Shipping Service
    │                        │                      │                      │
    │ OrderCreated           │                      │                      │
    ├───────────────────────→│                      │                      │
    │                        │ InventoryReserved    │                      │
    │                        ├─────────────────────→│                      │
    │                        │                      │ PaymentCharged       │
    │                        │                      ├─────────────────────→│
    │                        │                      │                      │ ShipmentScheduled
```

**Failure scenario (choreography):**

```
Payment Service fails after charging. It emits PaymentFailed.
    → Inventory Service listens for PaymentFailed → emits InventoryReleased (compensation)
    → Order Service listens for InventoryReleased → marks order CANCELLED
```

**Pros:**
- **Decentralized** — no single point of failure (no orchestrator to crash)
- **Loose coupling** — services don't know about each other; they only know events
- **Simple to extend** — add a new listener for OrderCreated without touching existing services
- **Low latency** — no extra hop through an orchestrator

**Cons:**
- **Implicit workflow** — the saga flow is distributed across N services. No single place shows the current state. Debugging: "Is the order stuck because Payment didn't emit, or because Inventory didn't listen?"
- **Cyclic dependency risk** — Service A listens to B, B listens to C, C listens to A → infinite event loop if not careful
- **Compensation complexity** — each service must know which events trigger its compensation. What if InventoryReserved is followed by PaymentFailed AND OrderCancelled? Which compensation runs?
- **Testing nightmare** — end-to-end test requires ALL services running. No way to test the saga flow in isolation.

### 3.2 Orchestration-Based Saga (Central Coordinator)

A dedicated orchestrator service directs each step:

```
                     ┌──────────────────┐
                     │ Saga Orchestrator │
                     │                  │
                     │  Current Step: 2  │
                     │  State: RUNNING   │
                     └───────┬──────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
    ┌──────────┐      ┌───────────┐      ┌──────────┐
    │  Order   │      │ Inventory │      │ Payment  │
    │ Service  │      │  Service  │      │ Service  │
    └──────────┘      └───────────┘      └──────────┘
```

The orchestrator sends commands (not events) to each service, waits for the response, and decides the next step.

```
Orchestrator:  → CreateOrder()
               ← OrderCreated {orderId: 123}
               → ReserveInventory(orderId, items)
               ← InventoryReserved
               → ChargePayment(orderId, amount)
               ← PaymentFailed {reason: insufficient_funds}
               → CancelOrder(orderId)        ← compensating
               → ReleaseInventory(orderId)    ← compensating
```

**Pros:**
- **Explicit workflow** — the saga is a single state machine in one place. You can query "what step is order 123 on?" and get an answer.
- **Centralized error handling** — the orchestrator decides when to retry vs. compensate. No distributed "who's responsible?" ambiguity.
- **Testable in isolation** — mock the services, test the orchestrator's state machine logic.
- **Simpler services** — each service exposes a command API. It doesn't need saga logic.

**Cons:**
- **Single point of failure** — if the orchestrator crashes mid-saga, the saga is stuck. (Mitigated by persisting orchestrator state — see below.)
- **Extra hop latency** — every step goes through the orchestrator (1 extra network round trip per step).
- **Orchestrator becomes a monolith** — as more sagas are added, the orchestrator accumulates business logic. Risk: "distributed monolith."
- **Coupling at the orchestrator** — the orchestrator knows about ALL services. Adding a new step requires modifying the orchestrator.

### 3.3 When to Use Which

| Scenario | Choice | Why |
|----------|--------|-----|
| **Simple, linear workflow** (3-4 steps, always same order) | Choreography | No need for central coordination overhead |
| **Complex branching/conditional logic** | Orchestration | Centralized decision-making; choreography would scatter logic |
| **Need visibility** ("where is order #123 stuck?") | Orchestration | Single place to query state |
| **High throughput, latency-sensitive** (100K+ TPS) | Choreography | No extra hop; each event processed directly |
| **Cross-team ownership** (each service owned by different team) | Choreography | Teams can evolve independently; no shared orchestrator |
| **Need exactly-once semantics** | Orchestration | Orchestrator tracks exactly which steps completed; can safely retry |
| **Compensation must be ordered** (refund BEFORE restock) | Orchestration | Explicit ordering of compensations |

### 3.4 The Hybrid: Orchestration with Event Bus

Many real-world implementations use BOTH:

- Orchestrator sends commands via a message queue (not HTTP)
- Services publish domain events that the orchestrator ALSO listens to
- The orchestrator's state is the source of truth; events are audit trail

```
Orchestrator → [Command Queue] → Service processes → [Event Bus] → Orchestrator updates state
```

This gives you the best of both: centralized state machine + durable, async communication.

---

## 4. The Outbox Pattern: Reliable Messaging for Sagas

A saga is only as reliable as its messaging. If the orchestrator sends `ChargePayment` but the message is lost, the saga stalls forever. The **Outbox Pattern** solves this.

### 4.1 The Problem: Dual Write

```
Orchestrator:  UPDATE saga_state SET step = 'CHARGING' WHERE saga_id = 123;
               publish("ChargePayment", {sagaId: 123, amount: 100});
```

These two operations span the database and the message broker. If either fails:
- DB updated, message NOT sent → saga thinks it's charging, Payment never gets the message
- Message sent, DB NOT updated → Payment charges the card, saga thinks it's still reserving

This is the **dual-write problem** — two systems, no shared transaction.

### 4.2 The Outbox Solution

Instead of directly publishing, write the message to an `outbox` table in the SAME database transaction as the state update:

```sql
BEGIN;
  UPDATE saga_state SET step = 'CHARGING' WHERE saga_id = 123;
  INSERT INTO outbox (id, aggregate_id, event_type, payload, created_at)
  VALUES (uuid(), 123, 'ChargePayment', '{"amount": 100}', NOW());
COMMIT;
```

A separate **outbox poller** (or Change Data Capture like Debezium) reads the outbox table and publishes messages to the broker:

```
┌──────────┐   INSERT into outbox   ┌──────────┐   Poll/CDC   ┌──────────┐
│  Saga DB │ ←────────────────────── │ Outbox   │ ───────────→ │ Message  │
│          │                        │ Table    │              │ Broker   │
└──────────┘                        └──────────┘              └──────────┘
```

**Guarantees:**
- **At-least-once delivery:** Outbox poller may deliver same message twice on crash recovery → consumers MUST be idempotent
- **Atomicity:** Saga state update and message creation are in the same DB transaction
- **Ordering (per saga):** Messages for saga 123 are inserted in order; poller sends them in order

### 4.3 Debezium (CDC) vs. Poller

| Approach | Pros | Cons |
|----------|------|------|
| **DB Poller** (SELECT * FROM outbox WHERE published = false) | Simple; no extra infrastructure | Adds latency (poll interval); DB load at scale |
| **Debezium (CDC)** | Near-real-time (reads WAL/binlog); no polling | Complex infrastructure (Kafka Connect cluster); DB-specific |
| **Transactional Outbox in the app** (same app writes to outbox + publishes after commit) | Simplest implementation | No atomicity if app crashes between DB commit and publish |

**Staff-level answer:** The outbox poller is sufficient for 99% of systems. Debezium is warranted when you need sub-second delivery AND you're already running Kafka. If you don't have Kafka, don't introduce it just for the outbox — use a simple poller with a 1-2 second interval.

---

## 5. Saga Failure Modes & Their Mitigations

This is where interviews get deep. Knowing that sagas exist is junior-level. Knowing how they fail and how to recover is staff-level.

### 5.1 The Compensating Transaction That Fails

```
T1: Create Order    ✓
T2: Reserve Stock   ✓
T3: Charge Payment  ✓
T4: Schedule Ship   ✗ (warehouse API down)
C3: Refund Payment  ✗ (payment gateway timeout)
```

Now you have a charged customer, reserved inventory, and no shipment — AND you can't refund. This is a **compensation failure**.

**Mitigations:**

1. **Retry compensation with exponential backoff.** Compensations should be retried MORE aggressively than forward transactions. A compensation failure is worse than a forward failure — money is held, inventory is locked.

2. **Compensation Dead Letter Queue (DLQ).** If compensation fails after N retries, move to a DLQ for manual intervention. Alert on-call immediately.

3. **Idempotent compensations.** The refund API MUST be idempotent. Use an idempotency key (e.g., `saga_id + "_refund"`). If the orchestrator crashes after sending the refund command but before recording it, it retries the refund — the payment gateway deduplicates.

4. **Design the sequence to minimize compensation blast radius.** Charge payment LAST (or second-to-last before physically irreversible steps). If payment is early and shipping fails, you're refunding money — expensive, slow, visible to the user.

### 5.2 Sequence Matters: Order Steps by Compensatability

```
GOOD ordering:
  T1: Validate order (cheap to compensate: delete record)
  T2: Reserve inventory (can release)
  T3: Charge payment (can refund — expensive but possible)
  T4: Ship item (physically irreversible — do this LAST)

BAD ordering:
  T1: Charge payment (expensive to compensate)
  T2: Ship item (irreversible)
  T3: Reserve inventory (can release)
  T4: Validate order (pointless — payment already charged)
```

**Rule of thumb:** Order saga steps from cheapest-to-compensate to most-expensive-to-compensate.

### 5.3 Phantom Reads & Isolation Anomalies

Sagas provide **ACD** (Atomicity, Consistency, Durability) but NOT **Isolation**. Between T1 and T4, other transactions can read intermediate state.

```
Saga A:  T1: Reserve last MacBook → T2: Charge payment → T3: Ship
Saga B:  ------------ T1': Read inventory → sees MacBook RESERVED (but not yet paid)
```

Saga B sees inventory as "reserved" but doesn't know if Saga A will complete or compensate. If Saga A fails and releases, Saga B missed a purchase opportunity.

**Mitigations:**

1. **Semantic Lock:** Mark reserved items with a saga_id and expiry. Other sagas see "reserved until 17:05" and can choose to wait or skip.
2. **Countermeasures:** Use a counter/version field. If Saga A increments `version` on reserve and decrements on release, Saga B can read-with-version and detect conflicts.
3. **Commute the effect:** Instead of `quantity = quantity - 1` (which can't be undone cleanly if concurrent sagas read between reserve and release), use a separate `reservations` table. The actual available quantity = `inventory.quantity - SUM(reservations.quantity WHERE expiry > NOW())`.

### 5.4 The Orchestrator Crash

If the orchestrator crashes mid-saga, the saga must resume from where it left off. This requires **persistent saga state**:

```sql
CREATE TABLE saga_instance (
  saga_id UUID PRIMARY KEY,
  saga_type VARCHAR(100),      -- 'CreateOrderSaga'
  current_step VARCHAR(100),   -- 'CHARGING_PAYMENT'
  state VARCHAR(20),           -- 'RUNNING', 'COMPENSATING', 'COMPLETED', 'FAILED'
  payload JSONB,               -- Full saga data
  step_responses JSONB,        -- Results from each completed step
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  completed_at TIMESTAMP
);
```

On restart, the orchestrator:
1. Loads all `RUNNING` sagas from the database
2. For each, checks if the last step actually completed (query the service, or check if a response was recorded)
3. If the step completed but response wasn't saved → save response, advance to next step
4. If the step didn't complete → re-issue the command (idempotently)
5. If the step failed → initiate compensation

This is the **Saga Persistence** pattern, used by frameworks like Temporal, Cadence, and AWS Step Functions.

### 5.5 Duplicate Execution (At-Least-Once Semantics)

If the orchestrator crashes after sending `ChargePayment` but before recording the response, on restart it re-sends `ChargePayment`. The customer is charged twice.

**Mitigation: Idempotency Keys everywhere.**

Every saga step command includes an idempotency key:
```
POST /payments/charge
{
  "amount": 100,
  "order_id": "123",
  "idempotency_key": "saga-456-step-3"   // Same key on retry
}
```

The Payment service stores `idempotency_key → response` mapping and returns the cached response for duplicate keys.

---

## 6. Saga Implementation Patterns

### 6.1 The Command / Orchestrator Pattern

Every saga step is a command-response pair:

```
interface SagaStep<T> {
  StepResponse execute(T data);       // Forward action
  StepResponse compensate(T data);    // Compensating action
}
```

The orchestrator runs:
```
for step in saga.steps:
  if step.hasResponse():
    continue  // Already completed (idempotent replay)
  response = step.execute(data)
  if response.isFailure():
    start compensating from current step backwards
    break
  save response
```

### 6.2 Temporal / Cadence: Durable Execution

Temporal (Uber, now Temporal.io) abstracts saga orchestration into "workflows" — code that runs durably. If the worker crashes, Temporal replays the workflow from history:

```java
@WorkflowInterface
public interface OrderSaga {
  @WorkflowMethod
  void createOrder(OrderRequest request);
}

public class OrderSagaImpl implements OrderSaga {
  @Override
  public void createOrder(OrderRequest request) {
    // Each activity() call is recorded in Temporal's event history
    Order order = activities.createOrder(request);
    try {
      activities.reserveInventory(order);
      activities.chargePayment(order);
      activities.scheduleShipment(order);
    } catch (ActivityFailure e) {
      // Temporal ensures this compensation runs exactly-once
      activities.refundPayment(order);
      activities.releaseInventory(order);
      activities.cancelOrder(order);
    }
  }
}
```

Temporal guarantees:
- **Exactly-once execution:** Even if worker crashes and restarts, each activity runs exactly once
- **Durable timers:** `Workflow.sleep(Duration.ofDays(30))` survives worker restarts
- **Automatic retry:** Configurable retry policy per activity

**When to use Temporal:** If you have more than 5 saga types, run them yourself. Below that, a simple database-backed orchestrator is sufficient.

### 6.3 AWS Step Functions

AWS Step Functions provide saga orchestration as a service:

```json
{
  "StartAt": "CreateOrder",
  "States": {
    "CreateOrder": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...",
      "Next": "ReserveInventory",
      "Catch": [{ "ErrorEquals": ["States.ALL"], "Next": "CancelOrder" }]
    },
    "ReserveInventory": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...",
      "Next": "ChargePayment",
      "Catch": [{ "ErrorEquals": ["States.ALL"], "Next": "ReleaseInventory" }]
    },
    ...
  }
}
```

**Pros:** Fully managed, visualized state machine, built-in retry/error handling.
**Cons:** AWS lock-in; 1-year max execution time; pay-per-state-transition pricing can surprise at scale.

---

## 7. Architectural Decisions — Trade-Off Table

| Decision | Option A | Option B | Why A Wins | When B Wins |
|----------|----------|----------|------------|-------------|
| **Saga vs. 2PC** | Saga | 2PC (XA) | Availability over consistency; cross-service; long-running | Strong consistency required; single DB; short transactions |
| **Choreography vs. Orchestration** | Orchestration | Choreography | Visibility, debugging, testability, complex branching | Simple linear flow; high throughput; cross-team ownership |
| **Outbox (Poller) vs. Outbox (CDC)** | DB Poller | Debezium/CDC | Simple; no Kafka dependency | Sub-second delivery needed; already running Kafka |
| **Temporal vs. DIY orchestrator** | Temporal | DIY DB-backed | Complex workflows (10+ types); need durable timers | < 5 saga types; don't want framework dependency |
| **Idempotency key vs. Deduplication table** | Idempotency key in request | Deduplication table in service | Decouples caller from service internals; standard pattern | Legacy APIs that don't accept custom headers |
| **Compensation: Retry vs. DLQ + manual** | Retry with backoff | DLQ + on-call alert | Most compensations succeed on retry (transient failures) | Compensation failed after 5+ retries; human intervention needed |
| **Inventory: Pessimistic lock vs. Semantic lock** | Semantic lock (reservation with TTL) | Pessimistic lock (SELECT FOR UPDATE) | Avoids blocking other sagas; saga-compatible | Short-lived sagas (< 5 seconds); high contention on hot items |

---

## 8. Key Metrics for Saga Observability

| Metric | Why | Alert? |
|--------|-----|:------:|
| `saga.duration.p99` (from start to COMPLETED/FAILED) | How long users wait for consistency | Warn if > 10× P50 |
| `saga.stuck.count` (RUNNING > N minutes) | Sagas that haven't progressed — likely stuck | YES — page |
| `saga.compensation.rate` (% of sagas that compensate) | Are failures systemic or transient? | Warn if > 5% sustained |
| `saga.compensation.failure.rate` (% of compensations that themselves fail) | Double failure — the nightmare scenario | YES — page immediately |
| `saga.step.retry.count.p99` | Are steps retrying excessively? | Warn if > 3 per step |
| `outbox.lag.seconds` | How far behind is the outbox poller? | Warn if > 30s |
| `outbox.dlq.size` | Messages that failed all retries | YES — page if > 0 |

---

## 9. Interview Questions & Model Answers

### ⚡ Q1: "Design a saga for an e-commerce checkout: Create Order → Reserve Inventory → Charge Payment → Schedule Shipping. Walk me through a failure at step 4 and how you handle it."

**Staff-level answer:**

"When shipping fails at step 4, the system is in a dangerous state: payment is charged, inventory is reserved, but no shipment is scheduled. The customer has paid for nothing. Here's the recovery:

**1. Immediate state assessment:** The orchestrator records step 4 as `FAILED` in the saga instance table. Saga state transitions from `RUNNING` to `COMPENSATING`.

**2. Compensation sequence (reverse order):**
- **C3: Refund Payment** — `POST /payments/refund` with idempotency key `saga-{id}-compensate-payment`. The payment gateway deducts the refund. If it fails with a 5xx, retry with exponential backoff (1s, 2s, 4s, 8s, 16s). After 5 retries, move to DLQ and page on-call. The saga remains in `COMPENSATING` state — it's NOT failed yet, it's recovering.
- **C2: Release Inventory** — `POST /inventory/release` with the reservation ID. This is a simple DB update: `DELETE FROM reservations WHERE id = ?`. Rarely fails. If it does, retry.
- **C1: Cancel Order** — `PATCH /orders/{id}` → `status = CANCELLED`. Notify the user.

**3. What if refund fails permanently?** The saga enters a `MANUAL_INTERVENTION` state. An on-call engineer receives an alert with the full saga context (order ID, charge ID, amount, failure reason). They manually issue the refund via the payment gateway's admin panel and then mark the saga step as `MANUALLY_COMPENSATED`. The saga then continues with C2 and C1 automatically.

**4. Critical design decision I made:** I ordered the steps as Create → Reserve → Charge → Ship. The reasoning:
- **Reserve before Charge:** If we charge first and then discover inventory is gone, we're refunding money — slow, costs payment processing fees, visible on customer's statement.
- **Charge before Ship:** If we ship first and then payment fails, we've physically shipped an unpaid item — the worst possible outcome. Charging before shipping means the worst case is 'refund a charge' rather than 'chase a shipped item.'
- **Create first:** No irreversible actions if Create fails — no cleanup needed.

**5. Why I didn't use choreography here:** The checkout flow has branching logic (different payment methods, gift cards, loyalty points). Scattering that logic across 4 services via events would make it impossible to answer 'what state is order #123 in?' I need a single orchestrator that I can query."

### ⚡ Q2: "You mentioned idempotency keys. What happens if two different sagas accidentally use the same idempotency key?"

**Staff-level answer:**

"Two scenarios:

**Scenario A — Accidental collision (different sagas, same key):** If Saga-1 and Saga-2 both use `idempotency_key = 'step-3'` (poor key design), Saga-2's `ChargePayment` gets the cached response from Saga-1's charge. Saga-2 thinks it charged the customer but actually charged Saga-1's customer. This is catastrophic — money moves between wrong accounts.

**Prevention:** Idempotency keys MUST be globally unique. Use a composite: `{saga_type}:{saga_id}:{step_name}`. Example: `create-order-saga:abc123:charge-payment`. Even better, include the entity ID: `order:ORD-789:charge-payment`.

**Scenario B — Legitimate replay (same saga, same key):** Saga-1's orchestrator crashes after sending `ChargePayment` but before recording the response. On restart, it re-sends with the same idempotency key. The Payment service returns the cached response. This is the CORRECT behavior — it's the whole point of idempotency.

**The deeper problem:** Idempotency key storage itself needs a retention policy. If you cache every idempotency key forever, the cache grows unbounded. Two approaches:
1. **TTL-based:** Store keys with a 24-hour TTL. After that, a duplicate key is treated as new. This means you have a 24-hour window for safe replay — sagas that can be stuck for > 24 hours need a different mechanism.
2. **Saga-lifecycle-based:** Store keys until the saga reaches a terminal state (COMPLETED or FAILED), then delete. The orchestrator explicitly cleans up keys when the saga finishes. This is cleaner but requires the orchestrator to manage key lifecycle.

**In practice:** Use approach 2 for payment/charge operations (no TTL expiry — a charge must never be duplicated) and approach 1 for non-critical operations (inventory reserve — worst case is a double-reserve that gets caught by a unique constraint).

### ❗ Common Pitfall: "We'll just run compensation synchronously in the catch block"

**The trap:**

```java
try {
  orderService.create(order);
  inventoryService.reserve(order);
  paymentService.charge(order);
} catch (Exception e) {
  // Synchronous compensation
  paymentService.refund(order);  // But payment might not have been charged yet!
  inventoryService.release(order);
  orderService.cancel(order);
}
```

This code has THREE fatal flaws:

1. **Compensating unexecuted steps:** If `inventoryService.reserve()` throws, `paymentService.refund()` runs — but payment was never charged. You're issuing a refund for a charge that doesn't exist. The payment gateway returns an error, and now you have TWO failures.

2. **Compensation exceptions swallowed:** If `paymentService.refund()` throws, the exception is caught by the outer catch (if nested) or propagates. Either way, `inventoryService.release()` never runs. Inventory is leaked permanently.

3. **No retry on compensation:** A transient network error on `refund()` means the saga terminates with inventory reserved and payment charged — the worst outcome.

**The fix (proper compensation loop):**

```java
// Track which steps actually completed
List<SagaStep> completedSteps = new ArrayList<>();

for (SagaStep step : saga.steps) {
  try {
    StepResult result = step.execute();
    completedSteps.add(step);
    if (result.isFailure()) break; // Start compensation
  } catch (RetryableException e) {
    // Retry forward step before compensating
    retryWithBackoff(() -> step.execute());
  }
}

// Compensate ONLY completed steps, in REVERSE order
for (int i = completedSteps.size() - 1; i >= 0; i--) {
  SagaStep step = completedSteps.get(i);
  try {
    retryWithBackoff(() -> step.compensate()); // Retry compensations!
  } catch (NonRetryableException e) {
    dlq.send(step, e); // Human must intervene
    break; // Stop compensating — later steps depend on earlier steps being undone
  }
}
```

**The principle:** Compensation is NOT cleanup. It's a business operation that deserves the same reliability engineering as forward operations: retries, idempotency, monitoring, and alerting.

---

## 10. Beyond Sagas: When the Pattern Isn't Enough

### 10.1 Long-Running Sagas (Hours to Days)

The standard saga assumes steps complete in seconds. What if a step takes 3 days?

**Example: "Verify customer identity"** — calls an external KYC provider that takes 2-3 business days.

**Problems:**
- Orchestrator holds state for days — must survive deploys, crashes, maintenance windows
- Compensation might not be valid after 3 days (inventory TTL expired, price changed)
- User expects real-time feedback but gets "pending verification" for days

**Solutions:**
- **Async callback pattern:** Saga step sends KYC request, records `AWAITING_CALLBACK` state. KYC provider calls back with result. Saga resumes from the callback.
- **Temporal's durable timers:** `Workflow.await(() -> kycComplete)` — survives restarts.
- **Human-in-the-loop:** For steps requiring manual approval, use a task queue (the saga step creates a task, a human approves/rejects, the task system calls back to the saga).

### 10.2 Sagas Across Organizational Boundaries

If the payment step uses Stripe and the shipping step uses a 3PL provider:

- Stripe won't participate in your orchestrator's retry protocol
- 3PL's API might have rate limits you can't control
- Neither will accept your idempotency key format

**Solution: Anti-Corruption Layer (ACL).** Build adapter services that translate between your saga protocol and the external API. The ACL handles:
- Translating your idempotency key to Stripe's `Idempotency-Key` header
- Mapping your retry policy to the external API's acceptable retry patterns
- Polling for async results (e.g., 3PL shipment confirmation)

### 10.3 When NOT to Use Sagas

| Scenario | Better Alternative | Why Not Saga |
|----------|-------------------|--------------|
| **Single database, simple flow** | ACID transaction | Saga adds complexity with no benefit |
| **All-or-nothing with real-time consistency required** | 2PC (if latency/availability acceptable) | Sagas have an inconsistency window |
| **2-service flow with simple rollback** | Try-catch with sequential API calls | Saga overhead (outbox, state machine, etc.) is overkill |
| **Event sourcing architecture already in place** | Event-driven with projections | Sagas are a workflow pattern; event sourcing handles consistency differently |
| **Workflow that must complete in < 100ms** | Inline with circuit breaker + fallback | Saga orchestration adds latency |

---

## 11. Key Takeaways

1. **Sagas trade consistency for availability.** This trade-off is explicit and deliberate. Before implementing a saga, document what inconsistency looks like, how long it can persist, and what the business cost is. If the answer is "we can't tolerate ANY inconsistency," you need 2PC or a single database — not a saga.

2. **Compensation is a first-class business operation.** It deserves the same reliability engineering as the forward path: retries with backoff, idempotency keys, monitoring, alerting, and DLQ for manual intervention. The most common saga failure in production is "compensation failed and nobody noticed for 3 days."

3. **Order steps by compensatability.** Cheapest-to-compensate first, most-expensive (or irreversible) last. A charge that's refunded costs payment processing fees. A shipped item can't be un-shipped. Design the sequence to minimize the cost of failure.

4. **Orchestration gives you visibility; choreography gives you throughput.** For staff engineers, the default should be orchestration — the ability to answer "where is this saga stuck?" is worth the extra hop. Switch to choreography only when throughput demands it.

5. **The outbox pattern is NOT optional.** If your saga implementation writes state and publishes messages in separate operations, you WILL lose messages in production. Use the outbox pattern or accept data inconsistency.

6. **Idempotency is the foundation.** Every saga step, forward and compensating, must be idempotent. Without idempotency, you can't safely retry. Without safe retry, you can't recover from crashes. Without crash recovery, your saga is a distributed ticking time bomb.

7. **Staff-level reframe:** Don't ask "should I use saga or 2PC?" Ask: "**What is the business impact of a partial failure? For each step in the workflow, what does the customer experience during the inconsistency window, what is the cost of compensation, and who is paged when compensation fails?**" The saga pattern is the easy part. Designing the failure modes and recovery procedures is the staff engineer's job.

8. **The hallmark of a well-designed saga:** When a step fails, the system degrades gracefully. The customer sees "Order pending — we'll confirm shortly" instead of a 500 error. Behind the scenes, the saga is retrying or compensating. The on-call engineer has a dashboard showing exactly which sagas are stuck and why. And nobody at 3 AM is confused about whether inventory should be released manually.

---

## Related
- [[topic-queue]]
- [[Event Sourcing & CQRS]]
- [[Circuit Breakers & Bulkheads]]
- [[Design an Idempotent API]]
- [[Two-Phase Commit & Consensus (Raft-Paxos)]]
- [[Data Pipeline Architecture (Kafka + Flink + Lakehouse)]]
- [[Weakness Vault/Day-44-Saga-Pattern-Distributed-Transactions]]

## Interview Cheat Sheet

**Key Points to Remember:**
- A saga trades ACID atomicity for availability: each step is a local transaction, and failure triggers *compensating transactions* (semantic undo), not database rollbacks. Some compensations are reversible (release inventory), some are expensive (refund), some are physically impossible (un-ship an item).
- Order saga steps from cheapest-to-compensate to most-expensive/irreversible. Charge payment *before* shipping but *after* inventory reservation, so the worst case is "refund a charge," not "chase a shipped unpaid item."
- Orchestration gives visibility (one place to query "where is order #123?") and testability; choreography gives throughput and loose coupling. Default to orchestration unless throughput or cross-team autonomy demands choreography.
- The outbox pattern is mandatory for reliable messaging — never do dual writes (DB update + message publish) separately, or you'll lose messages on crash. Use idempotency keys everywhere so retries are safe.
- Compensation is a first-class business operation: retry with backoff, alert on failure, and have a DLQ + manual intervention path. The most common production incident is "compensation failed and nobody noticed for 3 days."

**Common Follow-Up Questions:**
- *What happens if a compensating transaction itself fails?* — Retry with exponential backoff, then move to a DLQ and page on-call. The saga stays in a COMPENSATING/MANUAL_INTERVENTION state; a human completes the refund and the saga resumes automatically.
- *Choreography vs. orchestration — how do you choose?* — Orchestration by default (visibility, debugging, branching logic); choreography when you need maximum throughput or each service is owned by a different team.
- *Why not just use 2PC?* — 2PC blocks on the slowest participant, requires all participants available, and can't span external services like Stripe. Sagas choose availability over consistency and accept a temporary inconsistency window.

**Gotcha:**
- People think compensation is a database rollback, but it's an *application-level* semantic undo — and some operations (shipping a physical item, sending an email) can't be truly reversed, only mitigated. A refund that issues store credit instead of cash because the payment API is down is a degraded fallback, not a successful compensation, and must be tracked as technical debt.
