---
title: "Chat System (WebSocket, WebRTC)"
type: system-design
category: Advanced
date: 2026-05-18
tags: [system-design, interview, advanced, chat, websocket, webrtc, cassandra, e2ee]
aliases: []
---

# Chat System (WebSocket, WebRTC)

## Summary & Interview Framing

A real-time messaging system using WebSockets for persistent connections, handling message delivery, presence, and sync across devices. It decomposes into a connection plane (WebSocket gateways), routing plane (message bus + processors), storage plane (durable message store), and push/notification plane.

**How it's asked:** "Design a chat application like WhatsApp supporting 100M concurrent users, group chats, message ordering, delivery receipts, and offline message delivery."

---

## Overview

A real-time messaging system is one of the hardest distributed systems to build because it combines two notoriously difficult problems: maintaining millions of long-lived stateful connections, and delivering ordered, durable messages between arbitrary pairs or groups of users with sub-second latency. Unlike a stateless API where each request is independent, a chat server must remember which socket belongs to which user, survive node failures without losing in-flight messages, and keep conversation state consistent across datacenters. The reference scale here is WhatsApp-class — roughly 100 billion messages per day and tens of millions of concurrent connections — but the design principles apply from a ten-person startup chat to a global messenger.

The architecture decomposes into four planes that can be reasoned about and scaled independently:

- **Connection plane** — the fleet of WebSocket gateway servers that hold open sockets to connected clients and translate between the wire protocol and the internal message bus.
- **Routing plane** — the Kafka (or equivalent) backbone plus message processors that persist messages, resolve recipient locations, and fan out delivery.
- **Storage plane** — Cassandra for the append-only message log, PostgreSQL for relational metadata, and S3 for media.
- **Control plane** — presence, typing indicators, read receipts, and push notification fan-out — the ephemeral signals that make chat feel "live" even though they carry no durable content.

Each plane has different consistency, latency, and availability requirements, and conflating them is one of the most common design mistakes.

```
   CLIENTS (100M concurrent)
   ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐
   │ C1  │ │ C2  │ │ C3  │ │ Cn  │
   └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘
      └───────┴────┬───┴───────┘
                   │ WebSocket over TLS (one socket per user)
                   ▼
        ┌──────────────────────────────┐
        │   L4 Load Balancer           │
        │   (HAProxy / NLB / Maglev)   │   distributes across many
        │                             │   gateway IPs to beat the
        └─────────────┬───────────────┘   65,500-tuple limit
                      │ sticky / L4 passthrough
       ┌──────────────┼──────────────┐
       ▼              ▼              ▼
   ┌────────┐     ┌────────┐     ┌────────┐
   │  GW1   │     │  GW2   │     │  GWn   │   CONNECTION PLANE
   │ ~100K  │     │ ~100K  │     │ ~100K  │   (1k–2k gateways)
   │ conns  │     │ conns  │     │ conns  │
   │uid↔sock│     │uid↔sock│     │uid↔sock│
   └───┬────┘     └───┬────┘     └───┬────┘
       └──────────────┼──────────────┘
                      │ publish / consume
                      ▼
        ┌──────────────────────────────┐
        │   Kafka                      │  ROUTING PLANE
        │   (partitioned by            │
        │    conversation_id)          │
        └──────────────┬───────────────┘
                       ▼
        ┌──────────────────────────────┐
        │   Message Processor          │
        └──┬───────────┬───────────┬───┘
           ▼           ▼           ▼
       ┌──────┐   ┌────────┐   ┌──────┐
       │Cassan│   │ Redis  │   │  S3  │   STORAGE PLANE
       │dra   │   │ pub/sub│   │ media│
       │msgs  │   │ +pres. │   │      │
       └──────┘   └────┬───┘   └──────┘
                       │
                       ▼
        ┌──────────────────────────────┐
        │   CONTROL PLANE              │
        │   presence · typing ·        │
        │   read receipts · push fanout│
        └──────────────────────────────┘
```

## Real-Time Transport: WebSocket vs SSE vs Long Polling

The choice of client-to-server transport is foundational because it determines connection semantics, overhead, and how bidirectional features like typing indicators are implemented.

**HTTP long polling** is the legacy fallback: the client issues an HTTP request that the server holds open until either data is available or a timeout (typically 30–60 seconds) expires, at which point the response is sent and the client immediately re-issues a new request. It works through any proxy and requires no special protocol upgrade, but every "message" carries full HTTP header overhead (hundreds of bytes), each poll cycle incurs a new TCP or TLS handshake unless keep-alive is maintained, and the gap between a poll expiring and the next one starting creates a delivery latency floor. Long polling also doubles request volume because the server must respond to the hanging poll *and* the client must re-poll, and it makes the "client wants to send" path awkward — that requires a separate POST, so sending and receiving happen on different connections with no shared ordering.

**Server-Sent Events (SSE)** improve on long polling by using a single persistent HTTP response stream with a defined `text/event-stream` content type and automatic reconnection built into the browser EventSource API. The server pushes events down the stream with minimal framing (a few bytes per event), and the browser handles reconnect with the `Last-Event-ID` header so the server can resume without gaps. SSE is excellent for one-way push — notifications, live scores, presence feeds — because it is simple, uses standard HTTP/2 multiplexing, and has near-zero framing overhead. Its fundamental limitation is that it is server-to-client only. The client still needs a separate HTTP POST to send a message, which means two connections per user, no shared backpressure, and no way to push a message down the same stream the client is typing into. For a chat product that needs typing indicators, delivery acknowledgements, and call signaling on the same channel, SSE forces a hybrid design that is harder to reason about than a single full-duplex channel.

**WebSocket** is the right default for chat because it provides a single full-duplex, framed, persistent connection over one TCP (and typically one TLS) session. After an HTTP Upgrade handshake, the protocol switches to a binary framing layer with 2–10 bytes of overhead per frame, and both directions share the same connection with a single ordering context. This matters operationally: one socket per user instead of two, one TLS handshake amortized over the session, heartbeats that work in both directions, and a natural channel for signaling, typing, receipts, and acks. The cost is that WebSockets are stateful — a load balancer must use sticky or L4 passthrough routing, the gateway must hold per-connection state in memory, and a gateway failure drops every connection on that node. Mobile networks add friction because carrier NATs and proxies can idle-kill sockets, so robust ping/pong heartbeats and client-side reconnect with backoff are mandatory.

In practice, production chat systems use WebSocket as the primary transport, fall back to long polling for hostile corporate proxies that block upgrades, and reserve SSE for narrow one-way push surfaces (a notification-only widget, for example) rather than the core chat channel.

| Dimension | Long Polling | SSE | WebSocket |
|---|---|---|---|
| Direction | Half-duplex (request/response) | Server→client only | Full-duplex |
| Connections per user | 2 (recv poll + send POST) | 2 (stream + send POST) | 1 |
| Framing overhead | Full HTTP headers per poll (~hundreds of bytes) | A few bytes per event | 2–10 bytes per frame |
| Handshake cost | New TCP/TLS each poll (unless keep-alive) | One per stream | One HTTP Upgrade per session |
| Reconnect | Client-driven re-poll | Built into EventSource via `Last-Event-ID` | Client-side backoff |
| Typing / signaling on same channel | No (separate POST) | No (separate POST) | Yes |
| Latency floor | Re-poll gap | Low (persistent stream) | Lowest |
| Request amplification | ~2× (hanging poll + re-poll) | 1× | 1× |
| Proxy compatibility | Excellent (plain HTTP) | Good (HTTP) | Good, but blocked by some corporate proxies |
| Backpressure | None shared | None shared | Shared on one socket |
| Best fit | Legacy fallback through hostile proxies | One-way push (notifications, scores, presence feeds) | Chat core |

## Connection Management at 100 Million Concurrent

Holding 100 million concurrent WebSocket connections is a textbook exercise in eliminating per-connection cost. A single Linux gateway node is typically tuned to carry 50,000–200,000 connections, which means 100M connections require roughly 500–2,000 gateway instances — a fleet, not a machine.

The first hard limit is the **ephemeral port range**: a client TCP connection is identified by the 4-tuple (source IP, source port, dest IP, dest port), so a single source IP can only open about 65,500 connections to a single destination IP:port. To exceed that, gateways either:

- Bind multiple listening ports
- Use multiple IPs per node
- Or — the common production pattern — sit behind an L4 load balancer (HAProxy, AWS NLB, Maglev, Envoy's TCP proxy) that distributes inbound connections across many gateway IPs so each `(client IP, gateway IP)` pair stays under the tuple limit

The kernel must also be tuned:

- `ulimit -n` raised to a few hundred thousand
- `net.core.somaxconn` and `net.ipv4.tcp_max_syn_backlog` increased
- `ip_local_port_range` widened
- `fs.file-max` raised globally

Memory is the binding constraint, not CPU, because idle WebSockets cost RAM but almost no CPU. A typical Go or Erlang gateway uses 10–40 KB of state per connection (read/write buffers, goroutine/process stack, per-user routing entry), so 100K connections consume roughly 1–4 GB and a 200K-connection node needs a memory headroom budget accordingly. This is why production gateways are written in connection-efficient runtimes:

- **Erlang/OTP** (WhatsApp, ejabberd) — each connection is a cheap process with a small heap
- **Go** (Discord) — goroutines
- **Hand-tuned C++/Rust** with epoll/kqueue and io_uring for event-driven I/O
- **Node.js** works but per-connection memory is higher and its single-threaded model caps throughput per core, so it is usually sharded horizontally

The gateway's in-memory map — `user_id → connection object` — is the single piece of stateful routing data, and it must be rebuilt on reconnect and never trusted as durable.

**Gateway failover** is the operational nemesis of this design. When a gateway holding 100K connections dies, 100K clients reconnect within seconds, creating a thundering herd that can overload the load balancer, the presence service, and adjacent gateways. The standard mitigations are:

- Client-side exponential backoff with full jitter (a random spread across a 1–30 second window)
- Per-client reconnect deadline staggering
- A "connection drain" mode where a node about to be terminated stops accepting new sockets and lets existing ones migrate on natural heartbeat failure
- Some systems add a **connection registry** — a Redis or etcd cluster mapping `user_id → gateway_id` — so that on reconnect a client can be routed back to a node that still holds its session, though at 100M scale this registry itself becomes a hot path and is usually sharded by user_id

Heartbeats run every 15–30 seconds with a server-side timeout of 45–60 seconds: shorter intervals burn mobile battery, longer intervals delay dead-connection detection. The heartbeat is also the carrier for presence updates, so one packet does double duty.

## Message Delivery Guarantees

Chat does not need exactly-once delivery — that is impossible across an unreliable network with retries — but it does need **at-least-once with client-side deduplication**, plus durable persistence so a message survives even if the recipient is offline and the sender's gateway crashes mid-send. The write path is the canonical place to enforce durability.

When the sender's gateway receives a message, it does not deliver it to the recipient until it has been durably written to the message store and acknowledged. Specifically:

1. The gateway publishes the message to a Kafka topic partitioned by `conversation_id`
2. The message processor consumes it
3. It writes to Cassandra with a quorum acknowledgement
4. Only then does it fan out to the recipient's gateway via Redis pub/sub

The sender sees the following UI states:

- **"sent" (single check)** — when the message is durably persisted
- **"delivered" (double check)** — when the recipient's gateway acknowledges receipt
- **"read" (blue ticks)** — when the client reports a read receipt

This ordering of acknowledgements is the mechanism by which the UI communicates guarantee level to the user.

```
SENDER    SENDER GW    KAFKA      PROCESSOR   CASSANDRA   REDIS        RECV GW    RECIPIENT
  │          │           │           │           │        PUB/SUB         │          │
  │── msg ─▶│           │           │           │          │             │          │
  │          │── pub ──▶│(conv_id)  │           │          │             │          │
  │          │           │── consume▶│          │          │             │          │
  │          │           │           │── write ▶│          │             │          │
  │          │           │           │          │LOCAL_Q   │             │          │
  │          │           │           │◀─ ack ───│          │             │          │
  │          │◀─"sent"───│           │          │          │             │          │
  │◀─ ✓ ─────│           │           │          │          │             │          │
  │          │           │           │── fanout ─────────▶│             │          │
  │          │           │           │          │          │── deliver ▶│          │
  │          │           │           │          │          │             │── push ▶│
  │          │           │           │          │          │             │◀─ ack ──│
  │          │           │           │◀─delivered│         │             │          │
  │◀─ ✓✓ ────│           │           │          │          │             │          │
  │          │           │           │          │          │             │◀─"read"─│
  │◀─ blue ──│           │           │          │          │             │          │

   real-time path (online recipient): <100 ms end-to-end
   offline path (recipient offline): gateway→Kafka→processor→persist→enqueue push
                                      →notification service→APNs/FCM→device wake
                                      →app connects→client pulls from store by cursor
```

At-least-once means a message can arrive twice. The cause is retry: if the recipient's gateway delivers the message but the network drops the ack, the message processor retries, and the recipient sees the message again. The defense is a **client-side deduplication set** keyed by `message_id` (a server-assigned Snowflake or UUIDv7) — the client tracks the last few hundred message IDs per conversation and silently drops duplicates. Idempotency also applies to the persist step: Cassandra writes are naturally idempotent on the same primary key, so retrying a write with the same `message_id` is safe. For the rare case where a message is persisted but never delivered (gateway crash after persist, before fan-out), the recipient pulls undelivered messages from the message store on reconnect — this is why the "real-time vs offline" distinction matters and why the store must be the source of truth, not the in-flight pub/sub channel.

A subtler guarantee is **delivery confirmation semantics for group chats**. In a 50-person group, "delivered" can mean "delivered to one recipient" or "delivered to all," and different products choose differently. WhatsApp shows single/double ticks at the conversation level (delivered to all, read by all) whereas some enterprise tools show per-recipient state. The implementation collects per-recipient acks at the message processor and only flips the aggregate status when a quorum or all recipients have acked — a design choice that trades UI simplicity for fan-out ack traffic, which can itself be a bottleneck in large groups and is often throttled or aggregated.

## Message Ordering

Ordering within a conversation must be causal and monotonic from each user's perspective, but global ordering across conversations is irrelevant. The mechanism is **Kafka partition affinity**: all messages for a given `conversation_id` hash to the same partition, and Kafka preserves offset order within a partition, so a single message processor instance consuming that partition sees messages in send order. The processor assigns a monotonically increasing sequence (either derived from the Kafka offset or a per-conversation counter in Cassandra) and writes to the store with that sequence as the clustering key, so reads back from Cassandra are ordered without a sort step.

The hard part is the **distributed send race**: if user A and user B send messages nearly simultaneously from different gateways, both publish to the same partition, and Kafka's ordering reflects publish time, not the user's perceived send time. For most products this is acceptable because the difference is milliseconds and the displayed timestamp reconciles it. For stricter ordering, the system can use a **logical clock per conversation** — a Lamport-style counter where each client tags its message with `max(its last seen counter) + 1` and the server breaks ties by sender_id — but this adds a round trip and is rarely worth it.

A more practical concern is **reconnection ordering**: when a client reconnects, it must receive offline messages first (pulled from the store by sequence) and then transition to the live pub/sub stream without gaps or duplicates. The gateway handles this by:

1. Fetching the offline backlog with a `last_message_id` cursor
2. Simultaneously subscribing to the live channel
3. Deduplicating any message that appears in both

Group chats add the wrinkle that different recipients may see messages arrive in slightly different orders if their gateways process pub/sub events at different speeds, but because each message carries its server-assigned sequence, the client renders by sequence, not by arrival order, so the final display is consistent. The store is the invariant: reads are always ordered by `(conversation_id, message_id)`, and any in-memory reordering on the client is a presentation concern, not a correctness one.

## Group Chat Fan-Out

Direct messages are easy: one persist, one pub/sub push. Groups are where the architecture strains. A message to a 256-person group requires one persist and 256 delivery attempts, each of which may hit an online gateway (fast, cheap pub/sub) or an offline user (trigger a push notification, queue for later). The naive approach — loop over participants and push to each — falls over for two reasons:

- It turns one Kafka message into 256 pub/sub publishes on the hot path, multiplying gateway load
- For very large groups (channels with 10K–100K members) it becomes a write-amplification disaster: one send becomes 100K deliveries

The production pattern separates **fan-out-on-write** from **fan-out-on-read**:

- **Fan-out-on-write (small groups, up to a few hundred members)** — the message processor expands the recipient list at write time, publishes to each user's per-user Redis channel, and writes a per-recipient inbox row (or a pointer) so offline users can pull their undelivered messages on reconnect. This is what WhatsApp, Signal, and most group messengers use.
- **Fan-out-on-read (large broadcast channels)** — the message is written once to the channel's timeline, and each recipient pulls from that timeline with a per-user read cursor, identical to a Twitter-style feed. This caps write amplification at 1 regardless of channel size, at the cost of N reads instead of 1 read per message — the right trade-off when members far outnumber messages per member.

```
             ONE MESSAGE to a 256-person group
                      │
                      ▼
              ┌───────────────┐
              │  Processor    │
              └───────┬───────┘
                      │ single persist (1 write)
                      ▼
                 ┌─────────┐
                 │Cassandra│
                 └─────────┘
                      │
              ┌───────┴────────┐
              │ recipient list │
              └───────┬────────┘
                      │
        ┌─────────────┼──────────────┐
        ▼             ▼              ▼
   ONLINE         ONLINE        OFFLINE
   members        members       members
        │             │              │
        ▼             ▼              ▼
   ┌─────────┐   ┌─────────┐   ┌──────────────┐
   │  Redis  │   │  Redis  │   │ inbox pointer│
   │ pub/sub │   │ pub/sub │   │  (Cassandra) │
   └────┬────┘   └────┬────┘   └──────┬───────┘
        │             │               │
        ▼             ▼               ▼
   gateway       gateway         push notification
   push (fast)   push (fast)     (coalesced, drained
                                   on reconnect)

  ── fan-out-on-WRITE: small groups (≤ few hundred members) ──
      write amplification = N members; one push each

  ── fan-out-on-READ: large channels (10K – 1M members) ──
      write amplification = 1; message written once to
      channel timeline; each member pulls with per-user cursor
      (Twitter-feed style). The honest framing for a
      1M-member channel is "broadcast with a chat UI".
```

A middle ground for medium groups is a **hybrid tiered fan-out**:

- Online members get immediate pub/sub delivery
- Offline members get a lightweight inbox pointer written to Cassandra (one row per offline recipient) and a push notification
- The inbox pointer is cheap because it is a single wide-row write per conversation per batch, and it drains on reconnect

Delivery acknowledgements for groups are aggregated: the processor collects acks and updates a per-message delivery bitmap, only flipping the conversation-level "delivered" status when enough recipients have acked, and throttling ack traffic for large groups to avoid a feedback storm. For groups above a threshold (often 1000+), read receipts are dropped or sampled entirely because the ack volume scales with group size and provides little value to the sender.

## Presence System

Presence is the system's knowledge of who is online, where they are connected, and what their last-seen time is. It is an eventually consistent, high-write, high-read subsystem and is almost always backed by Redis. The core data structure is a per-user hash: `presence:{user_id} → {status, gateway_id, last_heartbeat}`, with a TTL of roughly three heartbeat intervals (e.g., 45 seconds for 15-second heartbeats). If heartbeats stop, the key expires and the user is considered offline — no explicit logout is required, which gracefully handles dropped connections and phone crashes.

```
  CLIENT             GATEWAY              REDIS (presence)              CONTACTS
   │                   │                      │                           │
   │── heartbeat ────▶│  (every 15–30s)      │                           │
   │                   │── HSET presence:{uid}│                           │
   │                   │   {status,gw,last_hb}│                           │
   │                   │   + EXPIRE ~45s      │                           │
   │                   │◀─────────────────────│                           │
   │                   │                      │                           │
   │                   │   (no heartbeat →   │                           │
   │                   │    key expires →    │                           │
   │                   │    user "offline")  │                           │
   │                   │                      │                           │
   │── open chat list▶│                      │                           │
   │                   │── MGET presence:    │                           │
   │                   │   {contact1..N} ───▶│                           │
   │                   │◀── statuses ────────│                           │
   │◀── contact status│                      │                           │
   │                   │                      │                           │
   │                   │   status change ───▶│ PUBLISH presence:{uid}    │
   │                   │                      │   "online"                │
   │                   │                      │───────┬───────────────────┤
   │                   │                      │       ▼                   │
   │                   │◀── notify ───────────│  subscribers              │
   │◀── "Alice online"│                      │  (buddy list / pub-sub)   │
```

The gateway writes a heartbeat to Redis every interval for every connected user, which at 100M concurrent is 100M writes per 15 seconds, or about 6.7M writes/sec — well within a sharded Redis cluster's capacity but a meaningful load that must be budgeted.

Presence is read-heavy in a different way: a user opening their chat list wants the online status of all their contacts, which can be hundreds or thousands of people. A naive `MGET` per contact is fine for small lists but a single user's contact-status query can fan into thousands of Redis gets. The optimization is a **presence aggregation cache**: each user's status is also published to a sorted set or a denormalized "buddy list" structure that the client can fetch in one round trip, refreshed on a longer interval (30–60 seconds) rather than on every list open.

Presence *changes* are the interesting real-time event: when a user goes online or offline, their contacts who care must be notified. This is done by having each user subscribe to a Redis pub/sub channel for their contact list, or by batching change events and pushing them down the WebSocket on a slow tick. The cardinality problem is real — a user with 5,000 contacts generates 5,000 presence notifications per status change — so production systems:

- Throttle and batch (notify at most once per 30 seconds per user)
- Allow users to opt out of broadcasting their presence (the "last seen" privacy setting)

Last-seen timestamps are stored separately and durably (Cassandra or Redis with a longer TTL) because they must survive a full disconnect and be queryable days later. The "typing" indicator is the most ephemeral presence signal: it has a TTL of 3–5 seconds, is never persisted, and is fanned out only to the active conversation's participants, not to the contact list. Typing events are high-frequency and bursty, so they are typically throttled at the gateway (the client sends a typing-start at most once per 2 seconds) and dropped rather than retried — losing a typing indicator is harmless, whereas losing a message is not.

## Typing Indicators and Read Receipts

Typing indicators and read receipts are the two ephemeral signals that distinguish a chat product from an email system, and they share a design property: they are **loss-tolerant, high-frequency, and never persisted to the durable store**.

**Typing indicators** flow over the same WebSocket and pub/sub path as messages but bypass the Kafka/Cassandra write entirely — the sender's gateway receives a typing event, looks up the conversation's other participants' gateways via presence, and pushes a typing-start or typing-stop event to each, with a short TTL so that a missed typing-stop self-heals within a few seconds. There is no acknowledgement, no retry, and no ordering concern; if a typing indicator is lost, the worst case is the recipient briefly does not see "typing…" which is cosmetically irrelevant. This makes them cheap to implement but also a potential noise source, so gateways coalesce multiple typing events from the same user within a short window into a single downstream push.

**Read receipts** are more constrained because they are semantically meaningful (they tell the sender the recipient actually saw the message) but still ephemeral in transit. The client sends a read receipt when a message is rendered in the viewport, tagged with the `message_id` up to which the user has read. The flow is:

1. Client sends `read_up_to = message_id` when a message is rendered in the viewport
2. The gateway forwards this to the message processor
3. The processor updates a per-conversation per-recipient read cursor (stored in Cassandra or Redis)
4. It notifies the sender's gateway, which flips the UI to "read"

The read cursor is durable because on reconnect the client needs to know where it left off, but the in-transit read event itself is fire-and-forget — if it is lost, the next read event for a later message will supersede it, and the cursor is the source of truth. A common optimization is to batch read receipts: instead of one event per message read, the client sends `read_up_to = message_id` which covers all earlier messages in one update, dramatically reducing ack traffic in fast-scroll scenarios.

The **privacy dimension** matters here too. Read receipts and last-seen are user-controlled: a user can disable read receipts globally, in which case the system simply does not generate them, and can hide last-seen, in which case the presence service returns a coarse value ("recently") or nothing. This is enforced at the gateway and presence layer, not at the client, because a malicious client could otherwise forge receipts. The enforcement cost is a per-user privacy preference lookup on every receipt path, which is cached aggressively in Redis.

## Message Storage with Cassandra

Cassandra is the canonical choice for the message store because the access pattern is a perfect fit: writes are append-only and time-ordered, reads are almost always "fetch the last N messages in a conversation" (a range scan on a partition), and the workload is write-heavy with predictable hot partitions (active conversations). The schema is:

```
messages(conversation_id, message_id, sender_id, content, type, created_at, …)
        └─partition key─┘  └─clustering key (DESC)─┘
```

This makes "load recent messages" a single-partition, single-range read — the fastest path Cassandra has. A partition holds one conversation's messages; for very long-lived conversations with millions of messages, the partition is bounded by a time-bucketing strategy (e.g., partition by `conversation_id + month`) to avoid unbounded partition growth, which degrades read latency.

The consistency level is a deliberate trade-off:

- **Writes** use `LOCAL_QUORUM` so a message is durable in the local datacenter before the sender sees "sent," protecting against a single node loss without paying cross-region latency.
- **Reads** for recent messages use `LOCAL_QUORUM` as well, but because the client almost always reads messages it just received over pub/sub, the hot path is served from the in-memory cache (Redis list per conversation, 24-hour TTL) and the Cassandra read is only for scroll-back or reconnect.

This makes Cassandra a durability and history store, not the real-time delivery path — a separation that is essential for latency. Compaction is tuned with `SizeTieredCompactionStrategy` for the append-heavy workload, and TTL-based expiring messages (Snapchat-style) are supported natively by Cassandra's cell TTL without a delete.

The failure modes to design for are:

- **Hot partitions** — a viral group chat where one `conversation_id` receives thousands of writes/sec. Mitigated by the time-bucketing above and by detecting and migrating truly viral conversations to a broadcast/fan-out-on-read model.
- **Wide partitions** — a years-old conversation with millions of rows. Mitigated by bucketing and by capping the scroll-back query to a window (e.g., last 1000 messages) with pagination.
- **Tombstone accumulation** — if messages are deleted (the "delete for everyone" feature), Cassandra tombstones must be read and skipped, and if a conversation accumulates many, read latency degrades. Mitigated by bounded tombstone lifetimes, targeted compaction, and in extreme cases a tombstone-compaction sub-step.

PostgreSQL holds the relational metadata (users, conversation membership, settings) where transactions and secondary indexes are needed; it is not in the message hot path.

## End-to-End Encryption

End-to-end encryption (E2EE) changes the architecture profoundly because the server becomes a blind relay: it can route and store messages but cannot read their content, which means search, server-side moderation, and intelligent features must move to the client or be abandoned.

The **Signal Protocol** is the industry standard and uses:

- **X3DH key agreement** for initial session setup — one-time pre-keys fetched from the server, combined with the recipient's identity key to derive a shared secret
- **The Double Ratchet** for every subsequent message — each message uses a new message key derived from a chain that ratchets forward on every send and every receive, providing **forward secrecy** (past keys cannot be recovered from current keys) and **post-compromise security** (a single key compromise heals after a few messages because the ratchet advances)

Operationally, E2EE means the server stores only ciphertext, indexed by `conversation_id` and `message_id`, and the client decrypts on receipt. The server still does routing, presence, delivery acks, and push notification — but push notifications become a challenge because the server cannot read the message to put a preview in the notification payload. Solutions include:

- A separate "notification key" shared with the push service
- A short-lived preview encrypted with an APNs/FCM-retrievable key
- Or simply notifying "You have a new message" with no content

Media sharing under E2EE encrypts the blob on the client, uploads the ciphertext to S3, and sends the media reference plus the decryption key through the same encrypted message channel — the server never sees the cleartext image. Group E2EE uses a sender-keys variant where each sender has one ratchet per group rather than pairwise ratchet between every pair of members, scaling the key material to O(members) instead of O(members²).

The hardest E2EE problems are:

- **Key verification** (safety numbers, QR scanning)
- **Multi-device support** — each device has its own key, messages are sent to all devices of a recipient, requiring per-device encryption
- **Key rotation across device loss**

Multi-device means a message to a user is actually fanned out and encrypted separately for each of their devices, which multiplies fan-out and storage. The server cannot help reconcile devices because it cannot read the messages, so the client must handle device-list management and detect added devices (a security-critical event the user must be warned about). These constraints are why E2EE is an architectural decision made early, not bolted on later — retrofitting E2EE onto a server-readable store requires re-encrypting all history and rebuilding the client, which is what most products that added E2EE late effectively did.

## Media Sharing

Media (images, video, files) must not flow over the WebSocket channel because a large blob blocks the framing layer, head-of-line blocks small messages behind it, and consumes gateway memory buffering bytes that belong in object storage. The standard pattern is **out-of-band upload**:

1. The client requests an upload URL (a presigned S3 PUT, or a token to a media service)
2. It uploads the blob directly to S3 over HTTP
3. It receives a media reference (bucket + key + optionally a thumbnail key)
4. It then sends a normal chat message of type `image` or `file` whose content is the media reference, not the bytes
5. The recipient's client fetches the media from S3 (or a CDN edge) using a signed URL or a token, decrypts if E2EE is in use, and renders it

This keeps the WebSocket path small and fast, lets the media path use HTTP/2 or HTTP/3 with its own connection pooling and resume, and lets the media be cached at CDN edges for viral content.

Media processing — thumbnail generation, transcoding, virus scanning — happens asynchronously after upload, typically via a queue-driven worker pool that reads from S3, processes, and writes derived artifacts (a 256px thumbnail, a transcoded H.264 video) back to S3, updating the media metadata. The chat message can be sent before processing completes, with the client showing a placeholder and fetching the thumbnail when ready. For E2EE systems, processing is limited to what the client can do (client-side thumbnail generation before upload) because the server cannot decrypt to transcode. Capacity for media is substantial: at WhatsApp scale, media is the dominant storage and bandwidth cost, often 10–100× the text-message volume, and the S3/CDN budget dwarfs the Cassandra budget. Deduplication (content-addressable storage keyed by a hash of the ciphertext) saves storage for viral media forwarded to many users, since the same encrypted blob is stored once and referenced many times.

## Push Notifications for Offline Users

When a recipient is offline, the message cannot be delivered over WebSocket, so the system must notify the user through the platform push channel — APNs for iOS, FCM for Android, and Web Push for browsers. This is a fundamentally different delivery path with different latency (seconds, not milliseconds), different payload limits (4 KB for APNs, 2 KB for FCM v1), and different reliability (best-effort, no ack).

The flow is:

1. The message processor, upon discovering the recipient is offline (presence lookup returns no active gateway), enqueues a push task
2. A dedicated **notification service** consumes these tasks
3. It formats a platform-specific payload (title, body preview, conversation ID, deep link)
4. It sends to APNs/FCM, which deliver to the device
5. The device OS wakes the app, which connects over WebSocket and pulls the actual message from the message store

The push notification is a trigger, not the delivery channel, because push payloads are small, unreliable, and (for E2EE systems) cannot contain readable content.

A critical design decision is **push coalescing**: if a user is offline and receives 50 messages in a group chat, sending 50 push notifications is spammy, battery-draining, and rate-limited by the OS. The notification service:

- Batches messages per conversation and per user within a short window (e.g., 30 seconds), sending one notification like "Alice: 5 new messages" rather than five separate pings
- Respects do-not-disturb settings, per-conversation mute, and server-side rate limits per device token
- Handles token invalidation (a user uninstalls the app, the token becomes invalid, APNs returns an error) and updates the user's device-token registry, pruning dead tokens to avoid wasted sends

Push delivery is tracked for analytics but not for delivery guarantees — if APNs drops a notification, the user simply does not see it, and the actual message is still in the store waiting for the next app open.

The **real-time vs offline message** boundary is thus cleanly drawn by presence:

- **Online path** — gateway → Kafka → processor → persist → pub/sub → recipient gateway → recipient client, all in under 100ms
- **Offline path** — gateway → Kafka → processor → persist → enqueue push → notification service → APNs/FCM → device wake → app connects → client pulls from store by `last_message_id` cursor

The store is the durable bridge between these two worlds: the real-time path is an optimization on top of the durable store, and the offline path falls back to the store directly. On reconnect, the client always pulls any messages with `message_id > last_seen_id` from the store, deduplicating against anything that arrived over pub/sub in the overlap — this guarantees no message is lost regardless of which path was active.

## Capacity Estimation

Assume WhatsApp-class scale: 1 billion registered users, 500M daily active, 100M concurrent connections at peak.

**Message volume:**

- 100B messages/day
- ~200 bytes average message size (text + metadata)
- ~20 TB/day uncompressed text volume
- ~7 PB/year raw before replication
- With Cassandra RF=3 + LZ4/Snappy compression (2–4× on chat text): ~7 PB/year effective storage

**Media (dominant cost):**

- ~20% of messages include media, averaging 500 KB
- 20B media objects/day × 500 KB = ~10 PB/day raw
- ~3.6 EB/year before dedup
- Requires aggressive deduplication, CDN offload, and tiered storage (hot on S3 Standard, cold on Glacier)

**Message throughput:**

- Peak: ~100B messages over a 4-hour active window ≈ 7M msgs/sec sustained peak
- Bursts to 10M+/sec
- Kafka partitions sized so per-partition throughput (a few thousand msgs/sec) × partition count comfortably exceeds this → 2,000–4,000 partitions across the message topic

**Gateway fleet:**

- At 100K connections/node and 100M concurrent → 1,000 gateway instances
- At 50K connections/node (conservative) → 2,000 instances
- Per node at 100K connections × 20 KB/connection ≈ 2 GB connection state + overhead → 8–16 GB VM is comfortable
- CPU light at idle, spikes on message bursts → overprovision cores or auto-scale on pub/sub throughput

**Redis (presence):**

- 100M keys × ~100 bytes ≈ 10 GB memory → easily a 3-node Redis Cluster with replication
- Heartbeat write rate ~7M writes/sec is the binding constraint → met by a 6–9 node cluster sharded by user_id

**Notification service:**

- ~20% of messages go to offline users → 20B push sends/day
- Requires a fleet doing hundreds of thousands of APNs/FCM calls per second with HTTP/2 connection reuse

**Network egress:**

- Media delivery to clients (especially through CDNs) often dwarfs all other bandwidth
- The CDN bill is the line item most likely to prompt an architecture review

## Interview Question, Model Answer, and Common Pitfall

**Question:** You are designing a group chat where one conversation has 10,000 members and a single sender can post a message per second. Walk me through how you deliver that message without melting the system, and tell me where the design breaks if the group grows to 1 million members.

**Model Answer:** At 10,000 members, fan-out-on-write is borderline. One send becomes 10,000 delivery attempts, of which perhaps 2,000 are online (immediate pub/sub push) and 8,000 are offline (push notifications and inbox pointers). The single persist to Cassandra is fine, but the 8,000 inbox-pointer writes and 8,000 push enqueues are a write-amplification problem, and the 2,000 pub/sub pushes spike gateway CPU. I would handle this by tiering:

- Online members get immediate pub/sub (cheap, in-memory)
- Offline members get a single batched inbox write per conversation per short window plus a coalesced push notification
- I would also cap the per-recipient ack traffic — for a 10K group, read receipts are sampled or disabled because 10K acks per message is pure overhead

If the group grows to 1 million members, fan-out-on-write is dead: one send becomes 1M writes, which is a sustained 1M writes/sec just from one sender. The architecture must switch to **fan-out-on-read**: the message is written once to the channel's timeline, and each member pulls from it with a per-member read cursor, exactly like a Twitter feed. The trade-off is that delivery latency increases (members pull on their own schedule, not on push) and the system is no longer "real-time chat" but "broadcast with a chat UI," which is the honest framing for a 1M-member channel. The breaking point is the fan-out factor: once `members × messages_per_member_per_sec` exceeds the system's write capacity, you must invert the fan-out direction.

**Common Pitfall:** Designers often treat group chat as "just a direct message with more recipients" and reuse the DM fan-out loop. This works to a few hundred members and then fails silently: gateway CPU spikes on pub/sub storms, Cassandra hot-partition latency rises on per-recipient inbox writes, and push notifications get rate-limited or marked spam by the OS. The deeper pitfall is not recognizing the **fan-out-on-write vs fan-out-on-read inflection point** and having no architecture to switch to when a group crosses it, leaving the system to degrade under load instead of changing strategy. A related mistake is giving large groups the same delivery and read-receipt guarantees as DMs — the ack traffic alone can be a denial-of-service attack on your own infrastructure.

---

## Related
- [[topic-queue]]
- [[WhatsApp Architecture]]
- [[Notification System (Push-Email-SMS)]]
- [[CDN & Edge Computing]]
- [[Database Sharding & Replication]]
- [[Weakness Vault/Day-18-Chat-System]]

---

## Interview Cheat Sheet

**Key Points to Remember:**
- WebSocket for persistent connections (server-push), HTTP for history retrieval, push notifications for offline delivery
- Messages are delivered exactly-once within a chat session using sequence numbers and deduplication
- Presence is the hardest part — use heartbeat + TTL, not immediate connect/disconnect events
- Shard by conversation ID (group chat) or user ID (DMs), not by timestamp
- Read receipts and typing indicators are best-effort, not guaranteed — don't block on them

**Common Follow-Up Questions:**
- "How do you handle messages when the recipient is offline?" — Store in database, deliver via push notification. On reconnect, client fetches missed messages.
- "How do you scale to 100M concurrent WebSocket connections?" — Connection servers behind a load balancer, shard by user, use epoll/kqueue for efficient I/O multiplexing.
- "How does end-to-end encryption change the architecture?" — Server can't read messages, so search and moderation must happen client-side. Key exchange via Signal Protocol or similar.

**Gotcha:**
- Candidates often design for message delivery but forget presence and read receipts. A chat system without presence is just an email system with lower latency.
