---
title: "Payment System / Ledger Design"
category: "Finance"
day: 28
difficulty: "Hard"
tags: [system-design, interview, finance, payments, ledger, idempotency, transactions, outbox-pattern, reconciliation]
last_updated: "2026-06-19"
---

# Payment System / Ledger Design

A payment system is the financial backbone of any commerce platform, and it is the one subsystem where bugs are measured in real money and regulatory fines rather than user irritation. The design forces a collision between two traditionally hostile goals: the mathematical rigor of accounting and the operational reality of distributed systems. Every architectural decision — from isolation levels to retry semantics to idempotency key storage — must be evaluated not just for performance but for whether it can produce an incorrect monetary state that an auditor will eventually find. The sections below walk through the full lifecycle of a payment, from ledger modeling through gateway integration, settlement, fraud, and the distributed-transaction patterns that hold it all together.

## Summary & Interview Framing

A financial backbone using double-entry ledgers, idempotent APIs, and outbox patterns to ensure every transaction is exactly-once, auditable, and reconcilable.

**How it's asked:** "Design a payment system for an e-commerce platform processing 10K transactions/sec. Handle idempotency, ledger integrity, gateway integration, reconciliation, and fraud detection."

---

## Capacity Estimation

Before diving into design, it is worth grounding the problem in realistic numbers because they drive nearly every downstream choice. A mid-to-large commerce platform might process 10 million payments per day. That is roughly 116 payments per second on average, but traffic is bursty — Black Friday or flash-sale peaks can hit 5–10x the average, so design for 1,000–2,000 payments per second at peak.

Key capacity drivers:

- **Payments:** 10M/day; ~116/s average; 1,000–2,000/s at peak (5–10x burst factor)
- **Ledger writes:** each payment produces a handful of entries (debit customer, credit merchant, debit gateway fee, credit settlement suspense) → 4,000–8,000 inserts/s at peak
- **Storage:** ~40 bytes/row + indexes; 10M payments/day × 4 entries × 4 years ≈ 58 billion rows → tens of terabytes → "must shard the ledger" territory
- **Read traffic:** dominated by balance queries and reconciliation jobs; a balance query scanning the full ledger for an active account is unacceptable → materialized balance snapshots or running-balance columns with periodic verification become necessary, even though the purest design computes balance from entries alone
- **Reconciliation:** nightly batch job against the gateway settlement file must complete within a few hours → sets the throughput floor for that pipeline

## Double-Entry Ledger Design

The foundation of any trustworthy payment system is double-entry bookkeeping, a 700-year-old discipline that predates computers and remains the only correct way to model money movement. The core invariant is that every financial event debits one account and credits another, and the sum of all debits must always equal the sum of all credits — `Σ(debits) = Σ(credits)`. This is not merely a convention; it is a structural correctness guarantee. If the sums do not balance after a transaction, you know with certainty that something is wrong, and the ledger itself tells you where to look. Single-entry systems (a `balance` column that gets incremented and decremented) offer no such invariant; a bug that debits without crediting silently loses money and is detectable only by external audit.

```
            Double-Entry Ledger — $100 Customer Payment
            ============================================

  transaction_id = txn_001            Account               Dr ($)   Cr ($)
  ┌──────────────────────────────┐   ┌─────────────────────────────────────┐
  │ ledger_entries (append-only) │   │ Customer funding source │ 100.00  │         │
  │  • Dr Customer funding 100.00│──▶│ Merchant payable        │         │  97.00  │
  │  • Cr Merchant payable  97.00│   │ Platform fee income     │         │   3.00  │
  │  • Cr Platform fee inc   3.00│   │ ───────────────────────────────────  │
  └──────────────────────────────┘   │ Σ debits = Σ credits   │ 100.00  │ 100.00  │
                                     └─────────────────────────────────────┘
  Invariant: Σ(debits) = Σ(credits) → always balanced, always auditable
  Immutability: no UPDATE/DELETE; corrections are negative reversal entries
```

In a ledger-grade schema, every monetary event produces two or more rows in an append-only `ledger_entries` table, each tagged as a debit or credit against a specific account, all sharing a common `transaction_id`. The ledger is strictly immutable — you never `UPDATE` or `DELETE` a ledger row. Corrections are reversal entries: a new row with a negative amount and a reference to the original transaction. This append-only discipline means the ledger functions as an audit log by construction; every state the system has ever been in can be reconstructed by replaying entries in order, which is the bridge to event sourcing discussed later.

A key design decision is whether account balance is stored or computed. The purist answer is that balance is always derived: `SELECT SUM(CASE WHEN type='CREDIT' THEN amount ELSE -amount END) FROM ledger_entries WHERE account_id=?`. This is unimpeachable from an audit standpoint because the balance cannot drift from the ledger — it *is* the ledger. But for an account with millions of entries, that query is too slow for a real-time balance check on a hot read path. The pragmatic resolution is a hybrid: maintain a `current_balance` column on the `accounts` table updated in the same database transaction as the ledger insert, and run a periodic reconciliation job that recomputes the sum from entries and compares it to the stored balance, alerting on any mismatch. This gives you fast reads with a safety net. Some systems go further and maintain periodic balance snapshots (e.g., "balance as of end of each day") so that a full balance query only needs to sum entries since the last snapshot plus the snapshot value.

The chart of accounts — the set of logical accounts against which entries are posted — must be designed carefully. A typical commerce ledger has customer liability accounts (money we owe the customer or hold on their behalf), merchant payable accounts (money we owe the merchant pending payout), clearing or suspense accounts (money in flight at the gateway), fee income accounts, and settlement accounts. When a customer pays $100 for an order, the entries might be: debit customer funding source $100, credit merchant payable $97, credit platform fee income $3. When the gateway settles, debit clearing suspense $100, credit settlement bank account $100. Every real-world money movement maps to a balanced set of entries against this chart.

## Concurrency Control and the Double-Spend Problem

Money systems have a concurrency hazard that most other systems do not: the double-spend. Under naive `READ COMMITTED` isolation (the default in PostgreSQL), two concurrent transactions both read a $100 balance, both see that $100 ≥ $100, both debit $100, and both commit — leaving the account at -$100 and the platform $100 poorer. The database considered each transaction consistent in isolation, but the interleaving is financially wrong.

There are two main defenses. Pessimistic locking uses `SELECT ... FOR UPDATE` to acquire an exclusive row lock on the account before checking and mutating the balance. The second concurrent transaction blocks until the first commits or rolls back, at which point it re-reads and sees the updated $0 balance, correctly rejecting the debit. This is simple and bulletproof but serializes access to hot accounts — a high-volume merchant's account becomes a bottleneck. Optimistic locking instead adds a `version` column and performs an atomic conditional update: `UPDATE accounts SET balance=balance-?, version=version+1 WHERE user_id=? AND balance>=? AND version=?`. If `rows_affected=0`, either the balance was insufficient or someone else modified the row; the application retries with a fresh read. Optimistic locking yields higher throughput under low contention but requires retry logic and can degrade under heavy contention on a single hot row.

A critical subtlety is deadlock prevention when a transaction locks multiple accounts. If transaction A locks account 1 then waits for account 2, while transaction B locks account 2 then waits for account 1, both deadlock and one is aborted. The fix is to always acquire locks in a deterministic, globally consistent order — typically `ORDER BY account_id` — so that any two transactions touching overlapping accounts acquire them in the same sequence and never deadlock. This ordering discipline must be enforced in the data access layer, not left to individual developers, because a single non-conforming transaction can reintroduce deadlocks.

## Idempotency

Idempotency is the property that executing the same operation twice produces the same result as executing it once. In payments this is not a nicety — it is mandatory, because the real world is full of duplicate requests. A user double-clicks the pay button, a mobile client retries after a network timeout, a message queue redelivers a payment event, an upstream service crashes after charging the customer but before receiving the response. Without idempotency, every one of these scenarios can double-charge a customer.

The standard mechanism is a client-generated idempotency key included with every payment request. The server stores a mapping from `(idempotency_key, response)` so that a duplicate request with the same key returns the cached original response without reprocessing. The key should be generated by the client (a UUID or a hash of the request intent) and sent as an HTTP header — `Idempotency-Key: a4f3c2b1-...`. The server's responsibility is to atomically check-and-insert: if the key is unknown, process the payment and store the response; if known, return the stored response. This check-and-insert must be atomic to avoid a race where two duplicate requests both see "key not found" and both process. In a database this is a `INSERT ... ON CONFLICT DO NOTHING` against an idempotency table within the same transaction as the payment; in Redis it is a `SET NX` with a TTL.

There is a sharp distinction between an idempotency key and a request deduplication cache. A dedup cache prevents the same network request from being processed twice within a short window. An idempotency key is a durable, semantic guarantee: "this business operation, identified by this key, happens exactly once, regardless of how many times the request arrives or how much time passes." Idempotency keys should be persisted, not stored only in Redis with a short TTL, because a duplicate request can arrive hours or days later (a queued retry, a manually re-submitted batch). The TTL approach is a common pitfall: a 24-hour TTL means a duplicate arriving on day 2 re-processes and double-charges. Store idempotency keys in the database alongside the transaction they produced, with no expiry, and use Redis only as a fast-path cache in front of the DB lookup.

The idempotency guarantee extends to the response as well. If the server processed the payment but crashed before sending the response, the client retries with the same key, and the server must return the stored successful response — not an error, not a new transaction. This means the idempotency record must be written and committed *before* the response is sent, and the payment processing and idempotency record creation must be in the same transaction or a carefully ordered saga.

## Payment Gateway Integration

The payment gateway (Stripe, Adyen, Braintree, or a direct processor integration) is the bridge between your ledger and the outside financial network — the card networks, banks, and wallets. Your internal ledger records the intent and the internal accounting; the gateway actually moves the money. The integration pattern that has become standard is the authorize-capture two-phase flow, which mirrors a hold-then-settle pattern in your ledger.

```
                 Authorize-Capture Payment Flow
                 ==============================

  Customer        API / LedgerSvc        Gateway          Card Network / Bank
     │                 │                    │                   │
     │── pay $100 ───▶│                    │                   │
     │                 │                    │                   │
     │  [1] AUTHORIZE  │── auth $100 ─────▶│                   │
     │                 │   (idempotency-key)│── verify + hold ▶│
     │                 │◀── auth_code ─────│◀── funds held ────│
     │                 │                    │                   │
     │  ledger: Dr Customer funding 100 / Cr Clearing-Suspense 100
     │  (no money moved yet — issuing bank holds funds only)
     │                 │                    │                   │
     │  [2] CAPTURE (triggered when order ships)                │
     │                 │── capture ────────▶│── finalize charge▶│
     │                 │◀── captured ───────│◀── charged ───────│
     │                 │                    │                   │
     │  ledger: Dr Clearing-Suspense 100 / Cr Merchant-Payable 97 / Cr Fee-Income 3
     │                 │                    │                   │
     │  Void option (before capture): no chargeback fee if order unfulfillable
```

In the authorize phase, you send the payment details to the gateway, which contacts the card network and issuing bank to verify funds and place a hold. The gateway returns an authorization code and a balance transaction reference. At this point no money has moved — the issuing bank has reserved the funds. In your ledger, you post entries to a clearing or suspense account reflecting the authorized-but-uncaptured state. In the capture phase, typically triggered when the order ships, you tell the gateway to finalize the authorized amount, converting the hold into a real charge. Only at capture do you move the ledger entries from suspense to the merchant payable and fee income accounts. This two-phase design protects against the scenario where you charge a customer for an order you cannot fulfill — an authorization can be voided at no cost, but a captured charge that must be refunded costs a chargeback fee and hurts your dispute ratio.

The gateway is an external dependency and must be treated as untrusted and unreliable. Every gateway call must have a timeout (typically 30 seconds), a retry strategy (exponential backoff for transient failures, never retry on definitive failures), and an idempotency key so that a retried capture does not double-charge. Gateway responses must be persisted immutably — the raw API response, status code, and transaction reference — because these are your evidence in any later dispute and your input to reconciliation. You must handle the full state machine of gateway statuses: `authorized`, `captured`, `failed`, `declined`, `voided`, `refunded`, `disputed`, and the various pending states in between. A common error is treating a gateway timeout as a failure and showing the user an error, when in fact the charge may have succeeded — the gateway processed it but the response was lost. The correct behavior on timeout is to query the gateway by idempotency key to determine the actual state before presenting anything to the user.

## PCI Compliance

The Payment Card Industry Data Security Standard (PCI DSS) is the compliance framework that governs any system that touches card data. The cardinal rule of PCI in modern architecture is: **don't touch card data**. The entire industry has converged on tokenization as the way to achieve this. The customer enters their card number into a gateway-hosted iframe (Stripe Elements, Adyen Components) or is redirected to a gateway-hosted payment page. The raw card number (PAN) never touches your servers — it goes directly from the browser to the gateway, which returns a token representing that card. Your system stores and uses only the token. Because your servers never see, store, or transmit the PAN, your PCI scope is dramatically reduced — you fall under the much lighter Self-Assessment Questionnaire A (SAQ A) instead of the onerous SAQ D that applies to systems storing card data.

If for business reasons you must handle card data directly, you enter the full PCI DSS assessment regime, which mandates network segmentation, encryption of card data at rest and in transit, strict access controls, key management procedures, vulnerability scanning, penetration testing, quarterly ASV scans, and an annual audit by a Qualified Security Assessor. This is expensive and risky. The architectural advice is unanimous: engineer your system so that card data never enters your perimeter, and accept the tokenization model even if it means a slightly less seamless UX. The cost of a PCI breach — fines, forensic investigation, card brand penalties, reputational damage — dwarfs the engineering cost of tokenization.

PCI compliance also touches your logging and observability practices. You must never log full card numbers, CVVs, or track data. Logging middleware must scrub these fields, and you should periodically scan logs for PAN patterns (the Luhn algorithm check) to catch accidental exposure. CVV must never be stored, even encrypted, even transiently, post-authorization — this is a hard PCI DSS requirement. Tokenization sidesteps all of this because the sensitive data lives only in the gateway's vault.

## Settlement and Reconciliation

Settlement is the process by which the gateway actually transfers funds to your merchant bank account, typically on a T+1 or T+2 cycle (transaction day plus one or two business days). The gateway batches your captured transactions and sends an ACH or wire transfer for the net amount, along with a settlement report detailing every transaction included in the batch, the fees deducted, and the net amount. Reconciliation is the process of comparing your internal ledger against this external settlement report to ensure they agree.

Reconciliation is where silent bugs become loud. If your ledger says you captured $10,000 in a day but the gateway settlement report says $9,850, there is a $150 discrepancy that must be explained. Common causes: a capture that succeeded at the gateway but whose confirmation response was lost and your ledger still shows it as authorized-only; a refund processed at the gateway that failed to post a reversal entry in your ledger; a currency conversion rounding difference; a gateway fee that was charged but not recorded as a ledger entry. The reconciliation job matches each settlement line item to a ledger transaction by gateway transaction ID, flags unmatched items on either side, and routes them to an ops team for manual investigation. Unmatched items are not errors to be silently fixed — they are signals of bugs in the payment pipeline that must be root-caused.

```
                  Reconciliation Flow
                  ===================

  Gateway Settlement File        Internal Ledger
  (T+1, per-txn + fees)          (ledger_entries)
       │                              │
       └─────────────┬────────────────┘
                     ▼
         ┌─────────────────────┐
         │ Reconciliation Job  │  (match by gateway_txn_id)
         └──────────┬──────────┘
                    │
        ┌───────────┼───────────────┐
        ▼           ▼               ▼
   ┌────────┐  ┌───────────┐   ┌─────────────┐
   │MATCHED │  │INTERNAL-  │   │SETTLEMENT-  │
   │        │  │ONLY       │   │ONLY         │
   │ledger =│  │ledger has │   │settlement   │
   │settlmt │  │txn,       │   │has txn,     │
   │        │  │settl does │   │ledger does  │
   │        │  │not        │   │not          │
   └───┬────┘  └─────┬─────┘   └──────┬──────┘
       │             │                │
       ▼             ▼                ▼
   no action     will-settle-      investigate:
                 tomorrow OR       chargeback,
                 bug (capture     gateway fee,
                 never sent)      lost capture
                 → root-cause     → post missing
                                  ledger entry
```

A well-designed reconciliation system produces three categories of output:

- **Matched items** — ledger and settlement agree, no action
- **Internal-only items** — ledger has a transaction the settlement report does not (possibly a capture that will settle tomorrow, or a bug where the gateway never received the capture)
- **Settlement-only items** — settlement report has a transaction the ledger does not (possibly a chargeback or fee the gateway applied without a corresponding ledger entry)

The system must be smart enough to distinguish "will settle tomorrow" from "genuinely missing" by looking at settlement dates. Chargebacks, representments, and gateway fees are the most common settlement-only items that catch teams by surprise because they appear in the settlement file without a preceding notification.

Reconciliation should run at multiple granularities:

- **Real-time / near-real-time** — balance check against the gateway's balance API (catches large discrepancies quickly)
- **Daily batch** — reconciliation against the settlement report (the formal audit)
- **Monthly accounting close** — ties the ledger to the bank statement

Each layer catches a different class of error at a different latency.

## Retry Strategies

Retrying failed operations is essential in distributed payments, but naive retries are dangerous. The fundamental tension is that some failures are retryable (network blip, gateway 500, timeout) and some are not (insufficient funds, card declined, invalid card number). Retrying a declined card charges the platform a gateway API fee each time and may trigger fraud alerts at the issuing bank. Retrying a network timeout is safe *only if* the original operation is idempotent — otherwise the retry may double-charge.

The correct retry strategy is layered. First, classify the error by type:

- **4xx (except 429)** — definitive failure (insufficient funds, declined, invalid card); do not retry, return the error to the caller
- **5xx / network timeout** — ambiguous (operation may or may not have succeeded); retry with idempotency protection
- **429 rate-limit** — retry after the indicated backoff

Second, use exponential backoff with jitter to avoid thundering herds:

- `delay = min(base * 2^attempt, max_delay) + random_jitter`
- Typical base: 1 second
- Typical max delay: 60 seconds
- Cap on total attempts: 3–5

Third, for payment-specific operations, apply a circuit breaker: if the gateway is returning 5xxs at a high rate, stop sending it new payments and fail fast rather than queuing up retries that will all fail and then all retry simultaneously when the gateway recovers.

For asynchronous payment processing (e.g., a queue of payment jobs), the retry strategy is a dead-letter queue pattern. Failed jobs go back on the queue with an incrementing attempt count and a visible-after timestamp implementing backoff. After N attempts, the job moves to a dead-letter queue for manual inspection. The dead-letter queue must be monitored — an unbounded DLQ is a silent failure mode where payments are lost without anyone noticing. A scheduled job should reconcile the DLQ against the original intent to ensure no payment request is permanently stuck.

A subtle but critical pitfall: retries must use the same idempotency key as the original request. If a capture times out and you retry with a new idempotency key, the gateway sees it as a new capture and may double-charge. The idempotency key must be derived from the business operation (e.g., `capture-{order_id}`), not generated fresh per HTTP request.

## Fraud Detection

Fraud detection in a payment system operates on a spectrum from simple rule-based filters to real-time machine learning models, and most production systems use both in layers. The first layer is velocity rules: more than N failed payment attempts from the same IP in 10 minutes, more than M distinct cards from the same device fingerprint in an hour, a new account placing a high-value order within minutes of creation. These rules are cheap to evaluate and catch the bulk of obvious fraud. They are typically implemented as a streaming aggregation over a windowed store (Redis sorted sets with timestamps, or a Flink job maintaining rolling counters).

The second layer is risk scoring using a trained model — a gradient-boosted tree or a neural network that takes features (transaction amount relative to user history, time of day, geo-distance between billing and shipping address, card age, device reputation, email domain age) and outputs a fraud probability score. Transactions above a threshold are blocked, those in a gray zone are challenged with 3D Secure or step-up authentication, and those below are allowed. The model must be retrained regularly because fraud patterns shift; a static model decays within months.

3D Secure (Verified by Visa, Mastercard SecureCode) is the card network's fraud liability shift mechanism. When a transaction is authenticated through 3D Secure, liability for certain types of fraud chargebacks shifts from the merchant to the issuing bank. The trade-off is added friction — the customer is redirected to their bank's authentication page — which reduces conversion rate. The modern 3D Secure 2 protocol reduces this friction through risk-based authentication, where low-risk transactions can be frictionless. The decision of when to invoke 3D Secure is itself a risk-based optimization: invoke it on high-risk transactions to shift liability, let low-risk ones through to maximize conversion.

Fraud detection must be fast because it runs on the payment critical path. A risk score that takes 500ms to compute adds 500ms to every checkout. The typical architecture precomputes user-level features in a streaming pipeline (so the per-transaction fraud check only needs to look up pre-aggregated values) and uses a low-latency model serving tier. The fraud decision and its features must be logged for every transaction — both for model retraining and for the eventual chargeback dispute where you may need to prove you took reasonable fraud prevention measures.

## Multi-Currency

Multi-currency support sounds simple — store an amount and a currency code — but it is rife with precision and conversion pitfalls. The first rule is: never store money as a floating-point number. Use integer minor units (cents, pence) or a fixed-point decimal type. `float` introduces rounding errors that accumulate across millions of transactions and eventually produce a ledger that does not balance. Store amounts as `bigint` in minor units (e.g., $10.00 stored as 1000) or as `numeric(18, 4)` in the database. The choice of minor-unit precision must account for currencies with different subdivisions: some currencies (JPY, KRW) have zero decimal places, some (BHD, IQD) have three, and most have two. A zero-decimal currency stored in a system assuming two decimals will be silently mis-scaled.

Currency conversion introduces the question of which exchange rate to use and when to lock it. The standard approach is to lock the rate at authorization time and use that same rate for capture, settlement, and reporting — otherwise, FX movement between authorization and settlement creates gains or losses that must be tracked in their own ledger accounts (realized FX gain/loss). The gateway typically provides the rate; you must store it alongside the transaction for auditability. Rounding on conversion must use a defined rule (banker's rounding to avoid systematic bias) and the rounding remainder — the fraction of a minor unit lost — must be accounted for, typically accumulated in a rounding account that is periodically reconciled to zero.

A deeper challenge is that a payment in one currency may settle in another. A customer pays in EUR, your merchant account settles in USD, and the gateway applies its own conversion. Your ledger must track the original currency amount, the settlement currency amount, the applied rate, and any FX margin the gateway charged as a separate fee. Multi-currency ledger entries should always store the original currency and amount as the source of truth and the converted amount as a derived, auditable field with the rate that produced it. Reporting (revenue, refunds, fees) must specify which currency it is aggregating in and how conversion was applied, because aggregating converted amounts with different rates produces nonsense totals.

## Refund and Chargeback Flows

Refunds and chargebacks are the two ways money flows back to the customer, and they are operationally and ledger-distinct. A refund is an action you initiate — the customer requests their money back, you call the gateway's refund API, and the gateway returns the funds to the customer's card. In the ledger, a refund is a reversal entry set: debit merchant payable, credit customer account, referencing the original transaction. Refunds can be partial (refund $30 of a $100 charge) and can be issued long after the original capture (most gateways allow refunds within 180 days, some up to 365). A critical invariant is that total refunds cannot exceed the original captured amount — the system must check `sum(refunds) <= capture_amount` before issuing a new refund, using the same concurrency control as the original payment to prevent two concurrent partial refunds from exceeding the total.

A chargeback is initiated by the customer's issuing bank, not by you. The customer disputes the charge with their bank (claiming fraud, goods not received, or product not as described), the bank reverses the transaction and pulls the funds back, and the gateway notifies you via a webhook or daily dispute report. You have the option to fight the chargeback by submitting evidence (proof of delivery, signed receipt, terms of service) through a process called representment. If you win, the funds are returned; if you lose, the chargeback stands and you also pay a chargeback fee ($15–$25 typical). Chargebacks must be tracked through their own state machine: `dispute_opened`, `evidence_submitted`, `dispute_won`, `dispute_lost`, with ledger entries at each state transition. When a dispute is opened, you should post a provisional debit to a chargeback suspense account; when it is resolved, you either reverse that entry (won) or make it permanent and post the chargeback fee (lost).

A common pitfall is conflating refunds and chargebacks in the ledger. They have different tax implications, different fee structures, different dispute resolution paths, and different accounting treatment. A refund is a reversal of the original sale; a chargeback is a forced reversal by an external party. Mixing them in the same ledger account makes reconciliation and financial reporting ambiguous. Maintain separate accounts or at minimum clear distinguishing metadata on every reversal entry. Also note that a customer who has already been refunded cannot also chargeback the same transaction — your system must detect this and reject or flag the duplicate recovery attempt.

## Event Sourcing for Audit Trail

The append-only ledger is a natural fit for event sourcing, and for payment systems this convergence is more than coincidental — it is the correct architecture. In an event-sourced payment system, every state change is captured as an immutable event stored in an append-only event log: `PaymentAuthorized`, `PaymentCaptured`, `RefundInitiated`, `RefundCompleted`, `DisputeOpened`, `SettlementReceived`. The current state of any payment is derived by replaying its event stream from the beginning. The ledger entries are themselves projections of these events — a `PaymentCaptured` event produces the debit-and-credit ledger entries as a side effect of being processed.

The value of this architecture is a complete, reconstructable audit trail. Given the event log, you can replay the entire history of any transaction, any account, or the entire system to any point in time. This satisfies financial auditors, supports debugging ("what sequence of events led to this account being $5 off?"), and enables temporal queries ("what was this user's balance at the end of Q3?"). The event log is the system of record; the ledger, the read-optimized balance projections, and the API-facing state machine are all derived views that can be rebuilt from the log if they are corrupted or if the projection logic changes.

The trade-off is complexity. Event sourcing requires careful event schema design (events must be backward-compatible because they are immutable and will be replayed by future code versions), a reliable event store (Kafka or a dedicated event store database), and idempotent event handlers (because events can be redelivered during recovery). The projection that builds the ledger from events must be exactly-once in effect — processing the same `PaymentCaptured` event twice must not produce duplicate ledger entries, which is why the projection handler checks "have I already processed this event ID?" before applying it. This is the same idempotency principle, applied at the event processing layer. CQRS naturally accompanies this: commands (payment requests) write to the event log, queries (balance checks) read from the projections, and the two are decoupled and independently scalable.

For regulatory reasons, the event log must be retained for years (typically 7 years for financial records in most jurisdictions) and must be tamper-evident. Some systems hash-chain events (each event includes the hash of the previous event) so that any retrospective tampering is detectable, similar to a blockchain but centralized. This is overkill for most platforms but is seen in systems with stringent audit requirements or where multiple parties need cryptographic proof of the log's integrity.

## Distributed Transaction Patterns for Payments

Payments are inherently distributed: the request originates at an API gateway, the ledger write happens in a database, the gateway call happens over the network to an external service, and downstream notifications (to the order service, the inventory service, the fraud service) must be triggered. The question is how to keep these in a consistent state without the brittleness of distributed transactions.

Two-phase commit (2PC) is the textbook distributed transaction protocol: a coordinator asks all participants to prepare, and if all agree, asks them to commit. It provides strong consistency — all participants either commit or abort. But it is almost universally the wrong choice for payments. The fatal flaw is that the coordinator can fail after participants have prepared but before issuing the commit or abort, leaving those participants holding locks and blocking indefinitely until the coordinator recovers. In a payment system where those locks may be on customer accounts, a coordinator failure can freeze the ability to process payments for those customers. The availability cost is unacceptable for a revenue-critical path.

The Saga pattern is the standard alternative. A saga is a sequence of local transactions, each committing independently, with a defined compensating transaction for each step that can undo its effects if a later step fails. For a payment flow: `ReserveInventory → AuthorizePayment → CapturePayment → ConfirmOrder`. If `CapturePayment` fails, the compensation is `VoidAuthorization → ReleaseInventory → NotifyCustomerOfFailure`. Each step commits its local transaction and publishes an event triggering the next step; a saga orchestrator tracks the state machine and invokes compensations in reverse order on failure. The consistency guarantee is *eventual* — there is a window during which the system is in an intermediate state (inventory reserved, payment authorized, order not confirmed) — but the system never blocks indefinitely and always converges to a terminal state (completed or fully compensated).

```
           Saga + Transactional Outbox Pattern
           ====================================

  API ──▶ Orchestrator (saga state in DB)
            │
            │  [step 1] ReserveInventory
            │   └─ local txn: InventoryDB write + outbox{InventoryReserved}
            │        │
            │        ▼   outbox reader publishes event to broker
            │  [step 2] AuthorizePayment
            │   └─ local txn: LedgerDB (suspense) + outbox{PaymentAuthorized}
            │        │
            │        ▼
            │  [step 3] CapturePayment
            │   └─ local txn: LedgerDB (payable+fee) + outbox{PaymentCaptured}
            │        │
            │        ▼
            │  [step 4] ConfirmOrder
            │   └─ local txn: OrderDB write + outbox{OrderConfirmed}
            │
            │  ✗ on failure at step 3 → compensate in reverse order:
            │     VoidAuthorization → ReleaseInventory → NotifyCustomerOfFailure
            │
            └─ outbox table = atomic "DB write + event publish" guarantee
               (no 2PC needed; either both happen or neither does)
```

The orchestration vs. choreography decision within sagas matters. In choreography, each service listens for events and reacts independently — `OrderService` publishes `OrderCreated`, `PaymentService` listens and processes payment, publishes `PaymentCaptured`, `InventoryService` listens and ships. This is loosely coupled but the flow is implicit and hard to debug — there is no single place that shows the full saga state. In orchestration, a dedicated orchestrator service explicitly commands each step and tracks the saga's state in a database table. This is more coupled but far more observable and debuggable, and for payments where correctness and auditability matter more than maximal decoupling, orchestration is usually preferred. The orchestrator itself must be highly available (it is a single point of failure for in-flight sagas), typically implemented as a stateless service with saga state in a replicated database and a lock-based or lease-based leader election if only one orchestrator should process a given saga.

A pattern that sits between 2PC and saga is the transactional outbox. When a service needs to both write to its database and publish an event, it writes the event to an outbox table in the *same database transaction* as its business write, then a separate process reads the outbox and publishes to the message broker. This guarantees that the database write and the event publication are atomic without a distributed transaction — either both happen or neither does. This is essential for the saga steps themselves: when `PaymentService` captures a payment, it must both update the ledger and publish `PaymentCaptured` without the risk of one happening without the other. The outbox pattern is the glue that makes sagas reliable.

Transaction pattern comparison:

| Pattern | Consistency | Availability | Locking | Failure Handling | Best For |
|---|---|---|---|---|---|
| Two-Phase Commit (2PC) | Strong (all-or-nothing) | Low — coordinator failure blocks participants | Participants hold locks through prepare→commit; blocking | Coordinator can deadlock participants indefinitely | Rarely appropriate for payments; only when all resources support XA |
| Saga (orchestrated) | Eventual — intermediate states visible | High — no cross-resource locks; each step commits locally | No long-held cross-system locks | Compensating transactions roll back in reverse order | Multi-service payment flows where auditability matters |
| Saga (choreographed) | Eventual | High | No cross-system locks | Event-driven compensations; implicit flow | Maximal decoupling; harder to debug/observe |
| Transactional Outbox | Atomic DB+event (per service) | High — outbox reader retries publish | Local DB txn only | Outbox reader retries until broker acks | Glue for reliable saga steps; guarantees DB write + event publish |

## CAP Theorem for Payments

The CAP theorem states that a distributed system can guarantee at most two of consistency, availability, and partition tolerance. For payment systems the answer is clear: payments are CP. When money is at stake, a failed payment is better than a double payment, and an unavailable payment is better than an inconsistent one. If a network partition separates your ledger primary from your gateway integration service, you choose to reject payments (sacrificing availability) rather than process them against a stale or divergent ledger (sacrificing consistency). Design for partition tolerance — partitions will happen — and make the consistency-preserving choice when they do: fail closed, queue the payment for retry, and never process a payment against data you cannot verify is current.

This CP orientation shows up in concrete choices: synchronous replication for the ledger database (wait for the replica to acknowledge before committing, so a failover never loses a committed transaction), strongly consistent reads for balance checks (read from the primary, not a eventually-consistent replica, when deciding whether to authorize), and fail-closed behavior in the gateway integration (if you cannot confirm a payment's prior state, do not capture it). The cost is availability — a primary failure means a brief outage while a new primary is promoted — but this is the correct trade for a financial system.

## Sharp Interview Question

**Q: You process a $100 capture by calling the payment gateway. The gateway charges the card successfully, but your service crashes after the gateway responds and before you commit the ledger entry. The customer is charged but your ledger shows the payment as still authorized. How do you prevent this permanent inconsistency, and what happens when the nightly reconciliation runs?**

**Model Answer:** The root cause is a non-atomic cross-system operation: the gateway charge and the ledger update are not in a single transaction (they cannot be, since the gateway is an external HTTP service). The fix is the transactional outbox pattern combined with an idempotent gateway call and a reconciliation safety net. Specifically: before calling the gateway, write a `capture_requested` event to an outbox table in the same transaction as your state transition to "capturing." A worker reads the outbox and calls the gateway with an idempotency key derived from the capture intent (`capture-{order_id}`). When the gateway responds, the worker writes the `captured` event (with the gateway transaction reference) to the outbox in a transaction that also updates the ledger. If the worker crashes at any point, the outbox entry is still pending and another worker (or the same one on restart) picks it up and retries the gateway call — which is safe because the idempotency key means a duplicate call returns the original success response without re-charging. The ledger is updated from the event, and the system converges.

In the specific crash scenario described — gateway charged, ledger not updated — the outbox entry for the capture is still in "pending" or "gateway called, response not recorded" state. On restart, the worker re-calls the gateway with the same idempotency key, gets the cached success response, and completes the ledger update. The customer is not double-charged. If the crash also destroyed the outbox entry (e.g., the transaction rolled back entirely), then the reconciliation job catches it that night: the settlement file from the gateway shows a $100 capture with no matching ledger entry, it is flagged as a settlement-only item, and an ops engineer manually posts the missing ledger entry (or an automated remediation job does so). The system is self-healing within 24 hours even in the worst case, and within seconds in the common case.

**Common Pitfall:** A naive implementation writes to the ledger, then calls the gateway, then commits the ledger — putting the external call inside the database transaction. This holds a database transaction (and its row locks) open for the duration of a network call to an external service that may take seconds or hang. Under load, this exhausts the connection pool and cascades into a full outage. Worse, if the gateway call succeeds but the transaction is then rolled back (due to a timeout or a post-gateway-call error), the customer is charged with no ledger record — the exact inconsistency the question describes, but caused by the design rather than a crash. The external call must always be outside the database transaction, coordinated via the outbox pattern, never inline.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Double-entry ledger: every transaction has two entries (debit + credit) that must balance — the foundation of accounting
- Idempotency is non-negotiable: idempotency key + stored response prevents double-charging on retry
- External gateway calls must be OUTSIDE the database transaction — use the outbox pattern
- Reconciliation: periodically compare internal ledger with bank/gateway statements to catch discrepancies
- Saga pattern for distributed payments: each step has a compensating action for rollback

**Common Follow-Up Questions:**
- "How do you handle a payment that's 'pending' for hours?" — Gateway webhook updates the status. Set a timeout — if no webhook in X hours, query the gateway API directly and reconcile.
- "What happens if the gateway accepts the charge but your database commit fails?" — The outbox pattern ensures the ledger write and the gateway call are coordinated. If the DB commit fails after gateway success, a reconciliation job detects the orphaned charge and records it.

**Gotcha:**
- Never put an external API call inside a database transaction. The transaction holds row locks open for the duration of the network call — under load, this exhausts the connection pool and cascades into a full outage. The external call must be coordinated via the outbox pattern, never inline.
