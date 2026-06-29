---
title: "Notification System (Push, Email, SMS)"
category: "Scale"
day: 8
difficulty: "Medium"
tags: [system-design, interview, scale, notifications, push, email, sms, fan-out, deduplication, queues]
last_updated: "2026-06-19"
---

# Notification System (Push, Email, SMS)

A notification system is one of the most deceptively hard services in a modern platform because it sits at the intersection of three forces that pull in opposite directions: users want timely, relevant, non-spammy messages; product teams want maximum engagement and will happily send everything to everyone; and third-party delivery providers impose hard rate limits, charge per message, and will throttle or ban you if you misbehave. The engineer's job is to build a pipeline that absorbs bursty, heterogeneous events from dozens of upstream services, fans them out across three delivery channels with radically different cost and latency profiles, respects per-user preference and quiet-hours rules, and still delivers within a few seconds for time-sensitive notifications. Get it wrong and you either leak money on SMS spam, get your APNS certificate revoked for pushing to stale tokens, or silently drop the password-reset email that locks a user out of their account. The design that follows is the one a staff engineer would whiteboard in an interview, with the trade-offs made explicit at every layer.

## Summary & Interview Framing

A system that fans out notifications across push, email, and SMS channels, respecting user preferences, quiet hours, rate limits, and deduplication.

**How it's asked:** "Design a notification system supporting 10M notifications/sec across push, email, and SMS with per-user preferences, priority queues, and deduplication at multiple layers."

---

## Requirements and the Shape of the Problem

The functional surface is small: upstream services (orders, billing, social, security) emit events, the system transforms them into human-readable notifications, and delivers them through one or more channels. The non-functional requirements are where the difficulty lives. Throughput is bursty and unpredictable — a product launch or a credential breach can generate a hundredfold spike in seconds, while a quiet Tuesday morning trickles at a few events per second. Latency targets differ by notification class: a 2FA code must arrive in under five seconds or the user reloads and generates a second, while a weekly digest can tolerate minutes. Reliability is asymmetric: a missed marketing push is tolerable, a missed transactional email is a support ticket, and a missed security alert is a security incident. Cost is dominated by SMS (cents per message) and email (fractions of a cent but volume is enormous), while push is nearly free but capacity-constrained by Apple and Google. Availability must be high because the notification system is often the *only* way users learn their account was compromised, so it cannot share a failure domain with the services that generate the alerts.

A useful framing is to separate the notification into three lifecycle stages: ingestion (accepting and validating the intent to notify), orchestration (deciding who gets what, through which channel, and when), and delivery (the actual handoff to a provider and the tracking of the result). Each stage has its own scaling characteristics, its own failure modes, and its own queue, and the architecture is cleanest when those stages are decoupled by message brokers rather than stitched together with synchronous RPC.

## High-Level Event-Driven Architecture

The system is fundamentally event-driven because the sources of notifications are themselves event producers and because decoupling ingestion from delivery is the only way to survive bursts without shedding load indiscriminately. An upstream service — say, the payments service confirming a charge — publishes a `payment.succeeded` event to an event bus (Kafka or SNS). A notification ingestion service consumes that event, enriches it with user context, and writes a notification intent record to the database. It then publishes an internal `notification.requested` event to a Kafka topic partitioned by `user_id`. This partitioning is load-bearing: it guarantees that all notifications for a given user are processed by the same consumer in order, which matters because a user receiving "your order shipped" before "your order was placed" is a real and embarrassing bug.

The notification orchestrator consumes `notification.requested`, resolves the user's preferences, selects channels and templates, applies rate limiting and deduplication, and produces one `delivery.requested` event per (user, channel) pair, pushing each into the appropriate priority queue. Channel workers — separate consumer groups for push, email, and SMS — pull from their queues, call the provider SDK, and emit `delivery.completed` or `delivery.failed` events back to the bus, which a tracking service persists for analytics and which a retry service consumes to schedule backoff retries. This pipeline has no synchronous cross-service calls in the hot path: every handoff is through Kafka, which means a downstream provider outage backs up the queue instead of cascading a timeout back into the upstream service that triggered the notification. That back-pressure behavior is the single most important architectural property and the reason a queue-based design beats a synchronous fan-out for anything beyond trivial scale.

```
 EVENT-DRIVEN ARCHITECTURE
 =========================

 [Upstream Services]            [Event Bus]              [Ingestion Service]
  orders                         Kafka / SNS              validate + enrich
  billing           event ----->  (topics)    ----->      user context
  social            payment.                               |
  security          succeeded                              | notification.requested
                                                          | (Kafka, partitioned by user_id)
                                                          v
                                               [Orchestrator]
                                               - resolve preferences
                                               - select channels + templates
                                               - rate limit + dedup check
                                               - render content
                                                  |
                +--------------------------------+--------------------------------+
                |                                |                                |
                v                                v                                v
          [Push Queue]                    [Email Queue]                    [SMS Queue]
         (per priority)                  (per priority)                  (per priority)
                |                                |                                |
                v                                v                                v
          [Push Worker]                   [Email Worker]                   [SMS Worker]
                |                                |                                |
                v                                v                                v
             FCM / APNS                      SES / SendGrid                     Twilio
                |                                |                                |
                +--------------------------------+--------------------------------+
                                                 |
                                      delivery.completed / .failed
                                                 |
                                        +--------+--------+
                                        |                 |
                                        v                 v
                                 [Tracking Service]  [Retry Service]
                                 delivery log +       exponential backoff
                                 in-app bell icon     + jitter scheduler
```

## User Preference Graph

Before any notification is sent, the orchestrator must answer a surprisingly complex question: does this user want this notification, through this channel, at this time, in this language? The naive model — a single `notification_preferences` table with a boolean per category — collapses the moment a real product grows, because preferences are multi-dimensional and contextual. A user may want push for direct messages but email for weekly summaries and nothing for marketing. They may want security alerts on every channel regardless of their other settings, because those are non-suppressible. They may have quiet hours (no push between 22:00 and 07:00 local time), device-level Do Not Disturb that the OS surfaces back to you, per-channel bundling preferences (digest emails instead of individual ones), and locale-specific template selection.

The right model is a preference graph rather than a flat table. At the top is the user, who has a global default (opted in to all, opted out of marketing). Below that are channel-level defaults (push on, email on, SMS off unless verified). Below that are category-level overrides (I want order updates by push but not email). Below that are specific notification-type rules (I want "price drop" alerts for my saved items but not "back in stock"). Resolution walks this graph from most-specific to least-specific and takes the first explicit setting, falling back to category, then channel, then global default. This is implemented as a small rules engine backed by a document store (DynamoDB or Mongo) where each user's preference tree is a single document, allowing the entire resolution to happen in one read. A separate immutable `preference_history` table records every change for audit and for "you turned this off on March 3" support flows. The security-alert exemption is enforced as a hard override in code, not as a preference, because no user preference should ever have the power to suppress a "your password was changed" notification.

## Templates and Localization

Notifications are rendered from templates, not constructed inline by the emitting service, for three reasons: it keeps the rendering logic in one place so a brand voice change doesn't require touching forty services; it enables localization without the upstream service knowing the user's language; and it allows non-engineers (product, marketing, legal) to edit copy through a CMS without a deploy. The template service stores versioned templates keyed by `(notification_type, channel, locale)`, with a fallback chain: if the `fr-CA` push template doesn't exist, fall back to `fr`, then to the default locale. Templates use a restricted expression language (Handlebars or a sandboxed subset) that can interpolate event payload fields and a small set of user context fields, but cannot execute arbitrary code — this matters because template authors are not always engineers and a template that calls into the database would be a performance and security disaster.

Rendering happens at the orchestrator, not at the channel worker, so that the worker stays a thin provider adapter and so that rendered content can be deduplicated and batched before it hits the provider. A subtle but important detail: the subject line, preheader, and body of an email are all rendered together and hashed, and that hash feeds both the deduplication key and the A/B test assignment, ensuring that a user who qualifies for two logically identical notifications in quick succession gets one, not two.

## Multi-Channel Delivery: Push, Email, and SMS

The three delivery channels are architecturally similar (a worker pulls a job, calls a provider, records the result) but operationally very different, and treating them as interchangeable is a common mistake. The multi-channel pipeline fans a single notification intent out to one or more channel-specific workers, each with its own provider, rate-limit profile, and failure semantics.

```
 MULTI-CHANNEL NOTIFICATION PIPELINE
 ===================================

  [Orchestrator]
  (rendered content ready)
       |
       |  one delivery.requested per (user, channel) pair
       |
       +------------------+------------------+------------------+
       |                  |                  |                  |
       v                  v                  v                  v
  [Push Queue]      [Email Queue]      [SMS Queue]        [In-App]
       |                  |                  |             (bell icon)
       v                  v                  v                  |
  [Push Worker]     [Email Worker]     [SMS Worker]            |
       |                  |                  |                 |
       | batch?           | batch?           | coalesce?       | always free
       | FCM multicast    | SES SendBulk     | merge within    | always delivered
       | (up to 1000      | SMTP reuse       | 10-sec window   |
       |  tokens)         |                  |                 |
       v                  v                  v                 |
  +---------+        +---------+        +---------+            |
  | FCM     |        | SES /   |        | Twilio  |            |
  | APNS    |        | SendGrid|        | Vonage  |            |
  +---------+        +---------+        +---------+            |
       |                  |                  |                 |
       +------------------+------------------+-----------------+
                          |
               delivery.completed / .failed
                          |
                 +--------+--------+
                 |                 |
                 v                 v
          [Tracking]         [Retry Service]
          (delivery log)     (backoff + jitter)
```

| Dimension | Push | Email | SMS |
|---|---|---|---|
| **Providers** | FCM (Android), APNS (iOS, HTTP/2 API) | Amazon SES, SendGrid, Postmark, self-hosted Postfix | Twilio, Vonage, MessageBird |
| **Cost per message** | Nearly free | Fractions of a cent (enormous volume) | Cents per message (varies by country/carrier) |
| **Latency** | Sub-second | Seconds (TLS handshake dominates small messages) | Seconds (carrier handoff) |
| **Reliability** | Unreliable by design — OS may silently drop if app backgrounded | Adversarial receiving side — aggressive spam filtering | Carrier-dependent; delivery receipts unreliable internationally |
| **Throughput constraint** | Capacity-constrained by Apple/Google; throttled on invalid tokens | Very high (bulk APIs, SMTP reuse) | Limited; most aggressively rate-limited channel |
| **Regulatory burden** | Minimal | DKIM/SPF/DMARC alignment, CAN-SPAM, List-Unsubscribe | TCPA (US), A2P 10DLC, GDPR consent (EU), DLT registration (India) |
| **Batching mechanism** | FCM multicast (up to 1,000 device tokens per send) | SES `SendBulkEmail` (hundreds per call), SMTP connection reuse | Coalescing into concatenated SMS (merge within a window) |
| **Idempotency support** | FCM message ID | SES MessageId | Twilio `IdempotencyKey` header (clearest native support) |
| **Key failure mode** | Stale/rotated tokens → provider throttling or certificate revocation | Sender reputation decay → legitimate messages land in spam | Duplicate sends → cost burn + user annoyance |
| **Primary mitigation** | Mark dead tokens inactive in device registry on APNS/FCM feedback | Dedicated IP pools, suppress bounces, honor unsubscribe headers | Verification gate, dedicated short codes / toll-free numbers |

Push notifications go through Firebase Cloud Messaging (FCM) for Android and the Apple Push Notification service (APNS) for iOS, with FCM also able to proxy to APNS via the legacy pathway though most teams now call APNS directly using the modern HTTP/2 API with token-based authentication. Push is nearly free and sub-second, but it is unreliable by design: the OS may silently drop the message if the app is backgrounded and the user has not engaged recently, the device token rotates and must be refreshed, and Apple will throttle or reject your connection if you send to invalid tokens repeatedly. The worker must handle token-expiration feedback from APNS and FCM and mark those tokens inactive in the device registry so future sends skip them, because sending to dead tokens is the fastest way to get rate-limited by the providers.

Email is delivered through Amazon SES (or SendGrid, Postmark, or a self-hosted Postfix fleet). Email has the highest deliverability complexity of the three channels because the receiving side is adversarial: Gmail, Outlook, and Yahoo run aggressive spam filtering that scores your sender reputation, your DKIM/SPF/DMARC alignment, your engagement rates, and your content. A notification system that blasts low-engagement transactional email will see its sender reputation decay until legitimate messages start landing in spam, which is effectively a silent outage. The email worker must handle bounces and complaints (SES SNS notifications for bounce and complaint), suppress addresses that bounce, honor unsubscribe headers (List-Unsubscribe-One-Click), and segment sending through dedicated IP pools so that a marketing campaign's reputation cannot drag down password-reset deliverability. Email is also the channel where batching pays off the most: SES accepts a SendEmail call per message but SendBulkEmail batches hundreds, and SMTP connection reuse across messages avoids the TLS handshake cost that dominates small-message latency.

SMS is delivered through Twilio (or Vonage, MessageBird) and is the most expensive and most regulated channel. SMS costs cents per message, varies by country and carrier, and is subject to strict regulatory rules — TCPA in the US requiring opt-in and STOP/HELP/QUIT keyword handling, A2P 10DLC registration, GDPR consent in Europe, and DLT template registration in India. The SMS worker must respect these per-region rules, must use dedicated numbers or sender IDs where required, and must be the most aggressively rate-limited and deduplicated channel because duplicate SMS messages are both expensive and deeply annoying. SMS is also the channel most often gated behind a verification step: a user must have verified their phone number before receiving any SMS, and high-value SMS (2FA codes) should use a dedicated short code or toll-free number to improve throughput and deliverability over a shared long code.

## Priority Queues and Dispatch Policy

Not all notifications are equal, and a single FIFO queue will let a million low-priority "your friend posted" pushes starve a thousand "your account was accessed from a new device" security alerts. The system uses multiple priority queues per channel — typically three: critical (security, 2FA, account changes), high (transactional: orders, payments, appointments), and low (marketing, social, digests). The dispatcher uses a weighted round-robin or strict-preemption policy: critical messages jump to the head of the line, high messages are served as long as the critical queue is empty, and low messages are served only when the higher queues are drained. In Kafka this is modeled as separate topics per priority with a consumer that polls the critical topic first, then high, then low, or as a single topic with a priority field and a custom partitioner plus a head-of-line bypass for critical messages via a separate fast-path topic.

```
 PRIORITY QUEUE DISPATCH (per channel)
 =====================================

                      [Dispatcher / Consumer]
                              |
           +------------------+------------------+------------------+
           |                  |                  |                  |
           v                  v                  v                  v
     +-----------+      +-----------+      +-----------+    +---------------+
     | CRITICAL  |      | HIGH      |      | LOW       |    | RESERVED      |
     | security  |      | orders    |      | marketing |    | CAPACITY      |
     | 2FA       |      | payments  |      | social    |    | (min fraction |
     | account   |      | appts     |      | digests   |    |  of workers   |
     | changes   |      |           |      |           |    |  for critical)|
     +-----+-----+      +-----+-----+      +-----+-----+    +-------+-------+
           |                  |                  |                  |
           |   1. poll first  |                  |                  |
           |<-----------------+                  |                  |
           |                                    |                  |
           |   2. serve when critical empty      |                  |
           +<-----------------------------------+                  |
           |                                                       |
           |   3. serve only when critical + high drained           |
           +<-------------------------------------------------------+
           |
           v
    [Channel Workers]  (push / email / sms)

  Policy rules:
  - Critical:  jump to head of line via fast-path topic
  - High:      served when critical queue is empty
  - Low:       served only when critical + high are drained
  - Reserved:  a minimum fraction of worker capacity is always
               held for critical, even during a low-priority flood
  - Depth signal: low queue growing = OK (drains later)
                  critical queue growing beyond threshold = PAGE
  - Deadline:   notifications carry not_after timestamp;
                if still queued past it, drop (late is worse than absent)
```

The depth of each queue is a primary operational signal: if the low-priority queue grows unbounded during a burst, that is acceptable and expected (it will drain later), but if the critical queue depth grows beyond a threshold, it is a paging incident. A refinement is to reserve a minimum fraction of worker capacity for critical messages even during a low-priority flood, so that a marketing blast cannot fully monopolize the worker pool. Some systems also implement deadline-based scheduling: a notification carries a `not_after` timestamp, and if it is still in the queue past that time it is dropped rather than delivered late, because a "your flight is boarding" push delivered after landing is worse than no push at all.

## Rate Limiting Per User and Per Channel

Rate limiting exists at three levels, and conflating them is a common source of both spam and false drops.

- **Provider-side rate limits:** APNS, FCM, SES, and Twilio each impose rate limits on the sender. The channel worker must pace its outgoing calls to stay under those limits, typically using a token bucket per provider connection.
- **Per-user, per-channel, per-window rate limits:** even within the provider's allowance, sending a user thirty pushes in a minute will get them to disable notifications or uninstall the app. The system enforces a per-user, per-channel, per-window rate limit (for example, at most five pushes per user per hour for low-priority, no cap for critical). This is implemented with a sliding window or token bucket in Redis keyed by `user_id:channel`, checked by the orchestrator before enqueuing a delivery.
- **Per-notification-type rate limits:** a "friend went live" notification might be capped at one per user per friend per day, so that a hyperactive friend does not generate a flood.

A critical design decision is what to do when a notification is rate-limited. The available options are:

- **Drop it silently** — discard the notification without further action.
- **Coalesce into a digest** — merge with sibling notifications ("3 friends posted while you were away").
- **Downgrade the channel** — push suppressed, email queued instead.
- **Hold for retry** — retain and retry within the window.

The right answer depends on notification class:

- **Critical notifications** bypass all user-level rate limits (the security exemption again).
- **High-priority notifications** coalesce or digest.
- **Low-priority notifications** are dropped with a counter that feeds a "you would have received 12 notifications today, tap to see them" badge.

The rate-limit decision must be logged so that analytics can attribute "notifications not sent" to rate limiting rather than to a delivery failure, otherwise the metrics will silently undercount intent.

## Deduplication and Idempotency

Duplicate notifications are the single most common user-visible bug in notification systems, and they arise from two distinct causes that require two distinct defenses. The first cause is upstream duplication: an event is published twice (because the producer retried, or because a Kafka consumer offset was rewound), producing two identical notification intents. The defense is a deduplication key, typically a hash of `(event_id, user_id, notification_type)` or an explicit idempotency key provided by the producer, stored in Redis with a TTL of a few hours and checked at ingestion. If the key exists, the second event is acknowledged and dropped. This must happen at ingestion, before the notification is rendered and enqueued, because deduplicating after enqueue requires coordinating across workers and is far more expensive.

The second cause is delivery-level duplication from at-least-once semantics: a channel worker sends a message successfully, but the ACK from the provider is lost or the worker crashes before recording the result, so the message is redelivered and sent again. The defense here is a delivery-level idempotency check using a `delivery_id` that is sent to the provider where supported (SES MessageId, FCS message ID) and is recorded in the delivery log before the send and confirmed after. Some providers support idempotency keys natively (Twilio's `IdempotencyKey` header is the clearest example), and using them turns "send at least once" into "send exactly once" at the provider boundary. Where the provider does not support it, the worker must check the delivery log for a recent successful send with the same `delivery_id` before re-sending, accepting a small window of risk in exchange for avoiding duplicates. The tension is real: leaning too far toward deduplication risks dropping a legitimate retry that should have been sent, while leaning too far toward retry risks duplicates. The pragmatic rule is to prefer duplicates for critical notifications (a duplicate 2FA code is harmless; a missing one is a lockout) and to prefer drops for marketing notifications (a duplicate marketing email is a complaint; a missing one is invisible).

## Batching and Coalescing

Batching reduces both cost and load, and it applies differently to each channel. For email, SES `SendBulkEmail` can dispatch up to hundreds of templated emails in a single API call, and SMTP connection reuse allows a single authenticated connection to carry many messages, amortizing the TLS and auth overhead that otherwise dominates small-message latency. The email worker holds messages for a short window (a few hundred milliseconds to a few seconds, configurable per notification type) and groups them by template and recipient domain, then dispatches in batches. For push, FCM supports multicast messaging where a single send targets up to a thousand device tokens, which is essential for broadcast notifications ("new feature available") but less useful for personalized notifications. For SMS, batching is less about the provider API and more about coalescing: if a user has three pending SMS notifications within a ten-second window, the system can merge them into a single concatenated SMS ("Your code is 123456. Also: your order shipped."), which saves cost and reduces annoyance.

Coalescing interacts with the priority queue: a low-priority notification can afford to wait in a coalescing buffer for a few seconds to see if siblings arrive, but a critical notification must flush the buffer immediately and send alone. The coalescing logic runs in the orchestrator and uses a per-user, per-channel buffer keyed in Redis with a short TTL; when a notification arrives it is appended to the buffer, and either a timer or a buffer-size threshold triggers a flush that renders the merged message and enqueues it as a single delivery. This is the mechanism behind digest emails ("your daily summary: 4 events") and behind push stacking (replacing the previous unread push with an updated one rather than adding a new one).

## Retry with Exponential Backoff

Delivery fails for transient reasons constantly: APNS returns a 503, SES throttles a burst, Twilio times out on a carrier handoff, a network blip drops the connection. The retry strategy must handle these without amplifying load during a provider degradation, which is where naive retries cause thundering herds. The standard approach is exponential backoff with jitter: a failed delivery is rescheduled after `base * 2^attempt` seconds with a random jitter of up to 50% of that value, capped at a maximum delay (typically 5–15 minutes) and a maximum attempt count (typically 5–8). The jitter is essential because without it, every worker that hit a 503 at the same instant will retry at the same instant, reproducing the burst that caused the 503. Full jitter (randomizing uniformly between 0 and `base * 2^attempt`) is more effective than equal jitter at spreading load and is the default in well-designed retry libraries.

```
 RETRY WITH EXPONENTIAL BACKOFF + JITTER
 =======================================

  [Channel Worker] ---- sends ----> [Provider]
        ^                                |
        |                                | response
        |<-------------------------------+
        |                            success?
        |                           /        \
        |                         yes         no
        |                        /              \
        |                       v                v
        |              delivery.completed   delivery.failed
        |                       |                |
        |                       v                v
        |              [Tracking Service]  [Retry Service]
        |                                      |
        |                                 retryable error?
        |                                (5xx, timeout, 429)  vs  (invalid token,
        |                               /          \              bounce, unverified)
        |                             yes          no
        |                            /               \
        |                           v                 v
        |                  compute backoff       terminal error
        |                  delay = base * 2^attempt      |
        |                  + full jitter                 v
        |                  (uniform 0 .. delay)    [Suppression List]
        |                  cap: 5-15 min            (mark endpoint
        |                  max attempts: 5-8         permanently bad)
        |                          |
        |                          v
        |                  [Delay Queue]
        |                  (Redis sorted set scored
        |                   by next-attempt time,
        |                   or SQS delay seconds,
        |                   or Kafka per-message delay)
        |                          |
        |                   wait until next-attempt time
        |                          |
        +<-------------------------+
        |
     re-deliver to worker

  Circuit breaker on 429:
  - 429 rate exceeds threshold --> worker pauses new sends
  - In-flight messages drain, provider rate-limit window resets
  - Worker resumes after backoff window
```

Retries are scheduled by a retry service that consumes `delivery.failed` events, computes the next attempt time, and writes the delivery back to a delayed queue (Kafka with a per-message delay, or a Redis sorted set scored by next-attempt time, or a dedicated delay queue like SQS with delay seconds). The retry service must distinguish retryable errors (5xx, timeouts, rate limits) from terminal errors (invalid device token, bounced email, unverified phone), which are marked failed permanently and routed to suppression rather than retried. A particularly important detail: a 429 from the provider must trigger not just a retry of that message but a global backoff of the worker, because a 429 means the provider is throttling the account and continuing to send will deepen the throttle. This is implemented as a circuit breaker around the provider client: when the 429 rate exceeds a threshold, the worker pauses enqueuing new sends for a backoff window, letting the in-flight messages drain and the provider's rate-limit window reset.

## Delivery Guarantees and At-Least-Once Semantics

The system provides at-least-once delivery, not exactly-once, and being explicit about this with stakeholders is important because exactly-once across a distributed system with third-party providers is provably impossible without provider-side idempotency support. At-least-once means every notification that is acknowledged into the system will be delivered to the provider at least once, assuming the user's channel endpoint is valid and the provider is reachable within the retry budget. The guarantee is implemented by acknowledging the Kafka offset only after the delivery result is durably recorded, so that a worker crash before the ACK causes the offset to be reprocessed and the message re-sent. Combined with the delivery-level idempotency check described above, the practical observed duplicate rate can be driven below 0.1%, which is acceptable for all but the most cost-sensitive SMS workloads.

The harder guarantee is end-to-end: did the notification actually reach the user? For push, the answer is unknowable past the provider — APNS does not confirm device-level delivery, only that it accepted the message, and the OS may drop it silently. For email, delivery confirmation is probabilistic: open tracking pixels and link click tracking tell you when a user engaged, but absence of an open does not mean non-delivery (many clients block images). For SMS, delivery receipts from carriers exist but are unreliable internationally. The system must be honest in its analytics about the distinction between "sent to provider," "accepted by provider," and "engaged by user," and must never report the first as the third.

## A/B Testing Notifications

Notification content is a product surface, and like any product surface it should be experimented on. A/B testing notifications adds two complications over standard web experimentation: the unit of assignment must be the user (not the request), so that a given user consistently sees variant A across multiple notifications, otherwise within-user carryover effects confound the measurement; and the outcome metric is often delayed and engagement-based (did they open the app within 24 hours), not immediate. The experiment service assigns each user to a variant at notification-render time using a deterministic hash of `(user_id, experiment_id)`, and the variant selection is recorded in the delivery log so that analytics can join deliveries to outcomes.

A subtlety is that notification A/B tests can cannibalize themselves: if variant B's push causes more app opens, those opens displace organic opens that variant A's users would have had anyway, so the measured lift overstates the true lift. The cleanest design holds out a control group that receives no notification at all, so the measured effect is notification-versus-no-notification rather than variant-versus-variant, and runs variant comparisons only when the baseline notification effect is already established. Notification experiments also need to respect the preference graph: a user opted out of marketing must not be pulled into a marketing experiment, and the experiment assignment must happen after preference resolution so that suppressed notifications are not counted in the experiment's denominator.

## Analytics, Tracking, and Observability

The notification system generates three classes of telemetry that serve different consumers. Operational metrics — queue depth per priority, send rate per channel, provider error rate, retry rate, end-to-end latency percentiles — feed dashboards and alerts and are emitted as a time series to Prometheus or CloudWatch, with the critical queue depth and the provider 5xx rate wired to paging alerts. Delivery logs — one record per delivery attempt with user, channel, template, variant, status, provider response, and timestamps — are written to the delivery log database (typically DynamoDB or a OLAP store like ClickHouse) and are the source of truth for "did we send this." Engagement events — push opens, email opens and clicks, SMS link clicks — are captured via instrumentation (the SDK callbacks for push, tracking pixels and wrapped links for email and SMS) and are joined to delivery logs in the analytics warehouse to compute open rate, click-through rate, and downstream conversion.

A frequently overlooked observability requirement is notification-level tracing: because a single user-facing notification can traverse five services (event bus, ingestion, orchestrator, channel worker, provider) and because "why didn't I get my notification" is a common support ticket, every notification must carry a correlation ID that is logged at each hop and that support can use to trace the notification's path through the system. Without this, a missed notification becomes an unanswerable question. The tracking service that consumes `delivery.*` events is also the system that powers the in-app notification center (the bell icon), which is itself a fourth delivery channel — one that is free, always delivered, and where the user can catch up on notifications they dismissed or that were suppressed by quiet hours.

## Capacity Estimation

Consider a mid-scale platform with 50 million monthly active users, of whom roughly 10 million are active on a peak day. A reasonable notification mix is: each active user receives an average of 4 push notifications, 0.5 emails, and 0.1 SMS per day.

**Throughput:**

- 40 million pushes, 5 million emails, and 1 million SMS daily — roughly 46 million notifications per day
- ~530 notifications per second on average
- Peak: 5–10x average (batch sends, marketing pushes, daily digest runs) = 3,000–5,000 notifications per second
- Burst tolerance: up to 10,000 per second
- Push and email workers: a few hundred sends per second per instance → fleet of 10–20 workers per channel with autoscaling covers peak with headroom
- SMS workers: fewer needed (low-volume, high-latency) but more careful pacing required

**Storage:**

- Delivery log: 46M deliveries/day × ~1 KB = 46 GB/day, ~1.4 TB/month, ~4 TB for 90-day retention (ClickHouse cluster or S3-backed Athena, with hot data in DynamoDB for point lookups)
- Preference store: 50M user documents × 2 KB = 100 GB (trivial for DynamoDB)
- Redis (rate-limit counters, dedup keys, coalescing buffers): dedup key set dominates — 530 notifications/sec × 2-hour TTL = ~3.8M steady-state keys at a few hundred bytes each = a few GB (small Redis cluster with replication)
- Event bus (Kafka): sized for ~5,000 events/sec peak ingress with 24–72 hour retention, ~1 KB per event = under 50 GB per partition-day, handled by a 3–5 broker cluster with comfortable headroom

**Cost:**

- SMS is the dominant variable cost: 1M SMS/day × $0.01–$0.05 per message = $300K–$1.5M per month
- This is why SMS is the channel most aggressively gated behind verification, deduplication, and coalescing

## Sharp Interview Question

**Question:** Your notification system delivers at-least-once, and a user reports receiving the same password-reset email three times within a minute. Walk me through where the duplication could have originated and how you would diagnose and prevent it.

**Model Answer:** There are three candidate sources, and a good diagnosis checks them in order of likelihood. First, upstream duplication: the auth service published `password.reset_requested` three times because its own retry logic fired before the first event was acknowledged, or because a Kafka consumer rebalance caused the offset to be reprocessed. I would check the event bus for duplicate `event_id` values within the window; if found, the fix is producer-side idempotency — the auth service must use an idempotency key (a hash of `user_id + reset_token`) and the ingestion service must dedup on that key in Redis before creating a notification intent. Second, orchestrator duplication: the preference resolution and channel selection happened three times because the `notification.requested` event was redelivered after a consumer crash before the offset was committed. I would check the delivery log for three records with the same `notification_id` but different `delivery_id`s; if found, the fix is to commit the Kafka offset only after the delivery intent is durably enqueued, and to make the orchestrator idempotent on `notification_id`. Third, delivery duplication: the email worker sent the message, SES accepted it, but the worker crashed before recording the success, so the redelivery sent it again — and this happened twice. I would check for three delivery records with the same `delivery_id`; if found, the fix is to check the delivery log for a recent successful send with that `delivery_id` before re-sending, or to use SES's native message ID for idempotency. The pragmatic prevention is layered: dedup at ingestion on the event key, idempotent processing on `notification_id`, and a delivery-level guard on `delivery_id`, plus alerting on the duplicate rate so this surfaces before a user reports it. For password-reset specifically, I would also add a server-side cooldown — at most one reset email per user per 60 seconds — because the cost of a duplicate is user confusion and the cost of a dropped retry is a lockout, and the cooldown tips that tradeoff correctly.

**Common Pitfall:** The most common mistake is treating deduplication as a single layer at ingestion and assuming it covers delivery-level duplication. It does not: ingestion dedup catches upstream re-publishes, but a crash between the provider send and the result recording will produce a duplicate that ingestion dedup cannot see because the ingestion already succeeded. Engineers who have not internalized at-least-once semantics often build the ingestion dedup, declare the duplicate problem solved, and then are surprised when duplicates still occur at a 0.1% rate during deployments or broker rebalances. The second, related pitfall is retrying without jitter during a provider outage, which converts a transient 503 into a sustained self-inflicted load spike that deepens the outage — the retry logic must use full jitter and must back off the whole worker on 429s, not just the individual message.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Three channels with different cost/latency: push (free, instant), email (cheap, seconds), SMS (expensive, instant)
- Fan-out pattern: event → notification service → channel-specific queues → provider adapters
- User preferences and quiet hours must be checked before sending — this is a product requirement, not just nice-to-have
- Deduplication at multiple layers: ingestion (same event twice), delivery (crash between send and ack)
- Provider rate limits are real — APNS/FCM will throttle, SMS gateways will charge per message

**Common Follow-Up Questions:**
- "How do you handle priority — a password reset vs a marketing push?" — Priority queue with weighted scheduling. Security notifications pre-empt promotional notifications.
- "How do you prevent notification spam?" — Rate limit per user per channel, deduplicate similar notifications within a time window, and respect user preferences rigorously.

**Gotcha:**
- Deduplication at ingestion is not enough. If the system crashes between sending to the provider and recording the send, a retry will produce a duplicate that ingestion dedup can't catch. You need delivery-level dedup (idempotent send with a message ID the provider recognizes) plus at-least-once semantics with consumer-side dedup.
