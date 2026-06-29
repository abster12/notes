---
title: "WhatsApp Architecture"
type: system-design
category: Deep Dive
date: 2026-05-29
tags: [system-design, interview, whatsapp, messaging, erlang, cassandra, end-to-end-encryption, signal-protocol, webrtc, real-time, multi-device]
aliases: [WhatsApp System Design, Messaging at Scale, WhatsApp Infra, Signal Protocol at Scale]
---

# WhatsApp Architecture

## Summary & Interview Framing

A messaging system built on Erlang's actor model with per-recipient mailboxes, end-to-end encryption (server is a blind relay), and per-sender sequence numbers for ordering.

**How it's asked:** "Design a messaging system for 2B users with 50 engineers. Cover the actor model, E2E encryption, message ordering, delivery guarantees, and how simplicity enables scale."

---

## Overview & Engineering Philosophy

WhatsApp is the world's largest end-to-end encrypted messaging platform, serving more than two billion monthly active users who exchange over one hundred billion messages every day. What makes the architecture remarkable is not merely the scale but the radical efficiency behind it: at the time of its nineteen-billion-dollar acquisition by Facebook in 2014, WhatsApp served roughly 450 million users with just 35 engineers and on the order of 50 servers. That ratio is not an accident of luck — it is the downstream consequence of a deliberate technology bet on Erlang/OTP, a store-and-forward delivery model, and a fanatically minimal protocol surface. Understanding WhatsApp's design means understanding how a single language runtime and a handful of storage primitives can absorb the entire planet's casual conversation.

The architecture rests on three structural pillars:

- **Erlang/OTP on the BEAM virtual machine** — gives the system millions of lightweight concurrent processes, preemptive scheduling, and supervisor trees that restart failed components without taking down a connection.
- **The Signal Protocol** (originally the Axolotl ratchet) — provides end-to-end encryption with forward secrecy and post-compromise security by default; the server never holds a plaintext message and never holds the keys to decrypt one.
- **A store-and-forward delivery model** — every message is persisted to a durable queue on write, acknowledged to the sender, and replayed to the recipient whenever they next appear online, whether that is milliseconds or weeks later. This is fundamentally different from a pub/sub system like Discord or a broker like Kafka; WhatsApp is point-to-point delivery with per-message server acknowledgements, and the persistence layer is the contract that makes delivery guarantees tractable.

## Requirements at a Glance

The functional surface is deceptively small:

- Send and receive text, media, and location in real time.
- Track three delivery states — sent (single check), delivered (double check), read (blue double check).
- Support group chats of up to 1,024 participants with consistent ordering.
- Carry voice and video calls over WebRTC with the Signal protocol carrying the key exchange.
- Queue messages for offline recipients and drain that queue on reconnect.
- Sync across up to four linked devices per account with independent key material.
- Do all of this encrypted end-to-end by default with no opt-in.

The non-functional targets are where the engineering pressure lives:

- Delivery latency for an online recipient must stay under 500 milliseconds at the 95th percentile.
- Each chat server must hold on the order of one to two million persistent TCP connections.
- Availability targets four nines (99.99 percent).
- Durability is at-least-once: once the server acknowledges a message, it must not be lost.
- The offline queue must retain undelivered messages for weeks.
- The cost-per-user must stay low enough that the service can run profitably at planetary scale without a per-message charge to the end user.

## Capacity Estimation for 2 Billion Users

Working through the numbers is how a candidate demonstrates they can reason about the machine footprint, not just the boxes on a diagram. Assume two billion monthly active users. The key capacity figures break down as follows:

- **Concurrent connections:** ~600 million users (≈30 percent of 2B MAU) are concurrently connected during peak hours.
- **Message volume:** ~100 billion messages/day; each user sends an average of 50 messages/day and receives somewhat more in groups.
- **Sustained rate:** ~1.16 million messages/second spread evenly; peak bursts reach 5–10 million messages/second due to geographic concentration.
- **Stored footprint per recipient:** ~200 bytes (100-byte ciphertext payload + envelope, routing metadata, per-recipient queue entries).
- **Raw message data/day:** ~30 TB before replication (100B messages × ~1.5 avg fan-out × 200 bytes).
- **Chat server fleet:** at ~1M connections/server, the fleet needs ~600 chat servers for the connection layer; with headroom and failover, closer to 1,000–1,500.
- **Memory per server:** ~10–20 GB aggregate for 1M connections with their per-connection state — fits comfortably on a modern box (each BEAM process holding a socket is a few kilobytes).
- **Media volume:** ~5 percent of messages carry media; average media object ~500 KB after compression → ~5 billion media objects/day → ~2.5 petabytes/day.
- **Hot media storage:** with 30-day retention → ~75 petabytes hot on the object store, plus CDN cache.

These numbers are what force the S3-plus-CDN split and the Cassandra cluster topology described below; they are not afterthoughts.

## Why Erlang/BEAM — The Concurrency Story

The single most important architectural decision in WhatsApp's history was choosing Erlang. Erlang was built by Ericsson in the 1980s for telecom switches, where the requirements are eerily similar to a chat platform: millions of concurrent connections, soft real-time latency, fault tolerance as a first-class concern, and hot code upgrades without dropping calls. The BEAM virtual machine implements its own scheduler that runs across all CPU cores and uses preemptive reduction-counting, so no single process can starve the system the way a long-running goroutine or OS thread can. Each connection is modeled as its own Erlang process — not an OS thread — and Erlang processes are extraordinarily cheap: a fresh process is roughly 300 bytes of memory and the system routinely runs tens of millions of them per node. This is why a single WhatsApp server can hold over a million persistent TCP sockets without the thread-per-connection explosion that would sink a JVM or a C10K-era server.

OTP, the middleware layer on top of Erlang, provides supervisor trees that implement "let it crash" semantics. Instead of writing defensive code that catches every exception and tries to limp along, an Erlang chat process simply dies when it hits an unexpected state, and its supervisor restarts it from a known-good init. The supervisor itself has a restart intensity policy (the classic `one_for_one`, `rest_for_one`, or `one_for_all`) that prevents crash loops from taking down the node. This philosophy composes beautifully with connection handling: if a socket process dies, the supervisor restarts it, the client reconnects, and the offline queue replays anything missed. The result is a system that achieves four nines not by never failing but by failing constantly and invisibly. WhatsApp also relies on Erlang's distributed message passing (`gen_server` calls and casts between nodes) and its `mnesia`-era patterns for in-memory replicated state, though the durable storage tier has long since moved to Cassandra and other stores. Hot code loading — swapping a module on a live node without dropping connections — is how WhatsApp deploys multiple times a day across thousands of nodes with no user-visible disruption.

### BEAM Process Model (per chat-server node)

```
                    BEAM VM  (single chat-server node)
  ┌───────────────────────────────────────────────────────────────┐
  │  Scheduler  (preemptive, reduction-counted, spans all cores)   │
  │                                                                │
  │    ┌────────┐   ┌────────┐   ┌────────┐   ┌────────┐          │
  │    │ Core 0 │   │ Core 1 │   │ Core 2 │   │ Core N │          │
  │    └───┬────┘   └───┬────┘   └───┬────┘   └───┬────┘          │
  │        └────────────┴────────────┴─────────────┘               │
  │                          │                                     │
  │                 ┌────────▼────────┐                            │
  │                 │   Run Queue     │  millions of processes     │
  │                 │   (processes)   │  ~300 B each when fresh    │
  │                 └──┬────┬────┬───┘                            │
  │          ┌─────────┘    │    └──────────┐                      │
  │     ┌────▼────┐   ┌─────▼─────┐    ┌─────▼─────┐               │
  │     │ socket  │   │  socket   │    │  socket   │   ... ~1M     │
  │     │ proc #1 │   │  proc #2  │    │  proc #N  │   conns/node  │
  │     └────┬────┘   └─────┬─────┘    └─────┬─────┘               │
  │          │              │                │                      │
  │     ┌────▼──────────────▼────────────────▼─────┐               │
  │     │       OTP Supervisor Tree                 │              │
  │     │  one_for_one | rest_for_one | one_for_all │              │
  │     │  crash → restart from known-good init     │              │
  │     └───────────────────────────────────────────┘              │
  │                                                                │
  │  Hot code loading: swap a module on a live node, no conn drop   │
  └────────────────────────────────────────────────────────────────┘
```

## Connection & Routing Layer

When a client opens WhatsApp, it establishes a single long-lived TCP (or TLS-over-443) connection to a chat server selected by the load balancer, typically after a DNS resolution that returns an anycast or geographically nearby address. The connection carries a custom binary protocol, not HTTP or JSON; the wire format is compact protobuf-like framing that keeps per-message overhead to a handful of bytes. Each connection is fronted by an Erlang process that owns the socket, parses incoming frames, and dispatches them to the appropriate message-handling process. A separate registry maps each user ID to the node currently holding that user's connection, so when a message arrives addressed to a user, the routing layer can look up which chat server owns the recipient's socket and forward the payload via inter-node Erlang messaging.

The routing registry is the subtle part. At WhatsApp's scale you cannot broadcast "who has user X" to a thousand nodes, so the registry is itself a sharded, replicated structure — conceptually a consistent-hash ring mapping user IDs to the node responsible for tracking their connection. When a user connects, their home node writes the mapping; when they disconnect or migrate (say, switching from Wi-Fi to cellular), the mapping updates. If the recipient is offline, the registry returns "no connection" and the message is routed to the persistence tier instead. This split between the ephemeral connection layer and the durable storage layer is what makes the store-and-forward guarantee clean: the chat server is stateless with respect to message durability, and the storage tier is stateless with respect to live sockets.

### Connection-Layer Approach Comparison

| Approach | Conns / box | Memory / conn | Fault isolation | Hot upgrade | Verdict at WhatsApp scale |
|---|---|---|---|---|---|
| Thread-per-conn (JVM / OS) | ~10K (C10K wall) | ~1 MB stack | one thread crash can destabilize the JVM | requires restart | cannot hold 1M sockets |
| Goroutine-per-conn (Go) | ~100K+ | ~8 KB stack, growable | cooperative-ish; long task can block scheduler | binary swap, drops conns | better, but no supervisor trees, no "let it crash" semantics |
| Erlang process-per-conn (BEAM) | ~1M+ | ~300 B fresh, few KB live | process crash → supervisor restarts | hot code load, no conn drop | WhatsApp's choice |

## Message Storage — Cassandra

WhatsApp's durable message store is Apache Cassandra, chosen because it provides write-heavy throughput, linear horizontal scalability, and tunable consistency — all of which match a chat workload that is overwhelmingly writes (every message is a write to the sender's outbox and each recipient's inbox), naturally partitioned by user, and must remain available during network partitions. Cassandra's log-structured storage engine (LSM-tree based) turns random writes into sequential appends, which is ideal for a system absorbing millions of messages per second. The data model leverages Cassandra's wide-row design: the partition key is the user ID, and the clustering key is a time-ordered message ID, so an inbox lookup for "give me the next 50 undelivered messages for user X" is a single partition read with a range scan — the most efficient access pattern Cassandra offers.

The schema conceptually has a per-recipient inbox table where each row is `(recipient_id, message_id, sender_id, ciphertext, timestamp, status)`, and the message ID is a timeUUID so messages sort chronologically within a partition. Because Cassandra partitions by recipient, all of a user's undelivered messages live on a known set of nodes (the replicas for that partition key), which makes the "drain the offline queue" operation a localized read rather than a global scatter.

### Message Inbox Schema (conceptual)

| Column | Type | Role |
|---|---|---|
| `recipient_id` | UUID / text | **Partition key** — routes all of a user's messages to a known replica set |
| `message_id` | timeUUID | **Clustering key** — chronological ordering within the partition |
| `sender_id` | UUID / text | Originator, used for receipts and UI grouping |
| `ciphertext` | blob | E2E-encrypted payload; the server never reads it |
| `timestamp` | bigint | Server receipt time, drives retention / TTL |
| `status` | int | 0 = sent, 1 = delivered, 2 = read; updated via lightweight transaction |

Replication factor is typically three with a quorum read and quorum write (`LOCAL_QUORUM` in practice for latency), giving strong consistency for any single key while tolerating a replica failure. Compaction and tombstones are the operational pain points: when a message is delivered and acknowledged, it is either marked delivered (a lightweight update) or eventually tombstoned after the retention window, and the ops team tunes compaction strategies (`SizeTieredCompactionStrategy` for write-heavy, `LeveledCompactionStrategy` for read-heavy) per table. A common production concern is tombstone warnings during offline-queue drains if messages expire faster than they are read, which is mitigated by setting `gc_grace_seconds` appropriately and monitoring tombstone sweep rates.

## Media Storage — S3 + CDN

Text messages are tiny, but images, videos, voice notes, and documents dominate the storage and bandwidth budget. WhatsApp does not stream media through the chat servers; instead, the uploading client encrypts the media with a symmetric key, uploads the ciphertext to object storage, and sends the recipient a message containing a pointer (a URL or object key) plus the decryption key wrapped in the Signal session. The object store is S3 (or an equivalent large-scale object store) fronted by a CDN that caches hot objects at edge locations close to the recipient. This split is essential: the chat servers stay lightweight because they never touch the bytes, and the CDN absorbs the bursty, geographically skewed read traffic that a viral video or a widely forwarded image generates.

The upload flow is: the sender generates a random AES-256 key, encrypts the media, requests a pre-signed upload URL from a media service, PUTs the ciphertext to S3, and embeds the S3 key and the AES key (the latter protected by the Signal double ratchet) into the message envelope. The recipient, on receiving the pointer, fetches the object from the CDN edge — which pulls from S3 on a cache miss — decrypts locally, and renders. Retention is bounded: media objects are deleted from S3 after the recipient has downloaded them and acknowledged, or after a fixed TTL (commonly 30 days for undelivered media) to keep the storage footprint finite. The CDN cache is governed by TTL and admission policies so that a single viral media object does not evict the working set of frequently accessed content. Thumbnails and transcoded variants (e.g., lower-resolution previews) are generated server-side — but note that because the media is encrypted, any server-side processing requires either client-supplied derived keys or a convention where the client uploads a separately encrypted thumbnail alongside the original, which is what WhatsApp does in practice to preserve the end-to-end encryption guarantee.

## End-to-End Encryption — The Signal Protocol

Every WhatsApp message is end-to-end encrypted by default, and the server is structurally incapable of reading the content. This is achieved with the Signal Protocol, which combines three cryptographic primitives:

- **X3DH (Extended Triple Diffie-Hellman)** — for initial key agreement.
- **The Double Ratchet algorithm** — for per-message forward secrecy and post-compromise security.
- **Sesame** — for session management across multiple devices.

When two users first message each other, the initiator fetches the recipient's public prekey bundle (signed prekey, one-time prekeys, and identity key) from the server — these are uploaded by the recipient in advance and consumed one at a time. The initiator performs an X3DH handshake to derive a shared root key, then initializes the Double Ratchet. From that point, every message advances a symmetric ratchet that derives a fresh message key from the previous one, so compromising one message key does not reveal past or future messages. Additionally, a Diffie-Hellman ratchet triggers whenever a new ephemeral key is received from the other party, giving post-compromise security: even if an attacker records all ciphertext and later steals a session key, they cannot decrypt messages sent after the next DH ratchet step.

The server's role is deliberately minimal: it stores public prekeys, forwards ciphertext, and maintains session state references, but it never sees plaintext or the symmetric keys derived from the handshake. Key verification is offered via a safety number — a short fingerprint of both parties' identity keys — that users can compare out-of-band to detect a man-in-the-middle attack. Group chats extend the protocol with the Sender Keys mechanism: instead of pairwise encrypting a message N times for N members (an O(N) cost per message), each participant distributes a chain key to the group once, and thereafter sends a single ciphertext that any member can decrypt with their copy of the evolving sender key. This reduces group encryption from quadratic to linear and is what makes 1,024-member groups feasible. The common pitfall in interviews is assuming the server holds session keys or performs encryption on behalf of clients — it does not; the server is a blind relay, and the entire security model collapses if it ever did.

### Signal Protocol — X3DH + Double Ratchet Flow

```
  Alice (client)                 Server (blind relay)                 Bob (client)
      │                                │                                  │
      │  ── X3DH Key Agreement ──       │                                  │
      │  fetch Bob's prekey bundle:     │  (Bob uploaded prekeys in        │
      │   signed prekey, one-time       │   advance; consumed one at a     │
      │   prekeys, identity key         │   time)                          │
      │───────────────────────────────>│                                  │
      │<───────────────────────────────│                                  │
      │  derive shared root key (X3DH) │                                  │
      │  initialize Double Ratchet     │                                  │
      │                                │                                  │
      │  ── Per-Message: Double Ratchet ──                                │
      │  symmetric ratchet:            │                                  │
      │   msg_key = HKDF(root_key, n)  │                                  │
      │   cipher = AEAD(msg_key, msg)  │                                  │
      │───────────────────────────────>│────────────────────────────────>│
      │                                │  forwards ciphertext ONLY        │
      │                                │  (no plaintext, no keys)         │  DH ratchet fires
      │                                │                                  │  on new ephemeral
      │                                │                                  │  key → post-
      │                                │                                  │  compromise security
      │                                │                                  │  decrypt via
      │                                │                                  │  reverse ratchet
      │                                │                                  │<────────
      │                                                                  │
      │  safety number = fingerprint(A_id_key, B_id_key)                 │
      │  ← compare out-of-band to detect MITM                            │
```

## Group Chat at Scale

Group chat is where naive architectures break, because a single send becomes a fan-out to up to 1,024 recipients, each potentially on a different chat server, each with their own online/offline state, and each needing their own delivery and read receipts. WhatsApp handles this by treating the group as a logical entity with its own identifier but distributing the fan-out across the routing layer rather than centralizing it. When a member sends a group message, their chat server looks up the group membership (cached and periodically refreshed from a group metadata store) and, rather than the sender's node individually contacting every recipient's node, it writes the message to each recipient's inbox in Cassandra and notifies the recipient's home chat server — which then pushes to the live socket if connected or leaves the message in the offline queue. The Sender Keys scheme means only one ciphertext is produced per message, so the encryption cost is constant regardless of group size; the fan-out cost is in storage writes and routing lookups, which scale linearly with membership.

### Group Chat Fan-Out Architecture

```
                       Group G  (up to 1,024 members)
                                  │
                       a member sends a message
                                  │
                                  ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  Sender's Chat Server                                             │
  │   1. encrypt ONCE with Sender Key  →  O(1) encryption cost        │
  │   2. lookup group membership (cached, periodically refreshed)     │
  │   3. fan-out = N inbox writes + N routing lookups (O(N))          │
  └──────┬──────────────┬──────────────┬──────────────┬───────────────┘
         │              │              │              │
         ▼              ▼              ▼              ▼
  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
  │ recip. 1   │  │ recip. 2   │  │ recip. 3   │  │ recip. N   │
  │ inbox      │  │ inbox      │  │ inbox      │  │ inbox      │
  │ write      │  │ write      │  │ write      │  │ write      │
  │ (Cassandra)│  │ (Cassandra)│  │ (Cassandra)│  │ (Cassandra)│
  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
        │               │               │               │
        ▼               ▼               ▼               ▼
  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
  │ home node  │  │ home node  │  │ home node  │  │ home node  │
  │ online? →  │  │ online? →  │  │ offline? → │  │ online? →  │
  │ push socket│  │ push socket│  │ leave queue│  │ push socket│
  │            │  │            │  │ + push wake│  │            │
  └────────────┘  └────────────┘  └────────────┘  └────────────┘

  Encryption cost:    O(1) per message (Sender Keys — single ciphertext)
  Fan-out cost:       O(N) storage writes + routing lookups (linear in membership)
  Per-recipient order: timeUUID clustering preserves per-sender stream order
  Read receipts:      aggregated ("read by N") past a size threshold to prevent receipt storms
```

Consistency in groups is deliberately relaxed: there is no global total order across recipients, only a per-recipient order guaranteed by the timeUUID clustering in Cassandra and the sequential delivery from the offline queue. This means two members might see messages in slightly different interleavings if messages arrive from different senders nearly simultaneously, but within a single sender's stream the order is preserved — which is what users actually care about. Read receipts in a group are aggregated: the sender sees "read by N" rather than per-individual receipts once the group exceeds a size threshold, both for privacy and to avoid a receipt storm. The group metadata store (membership, name, admin list) is kept separate from the message store and is cached aggressively on the chat servers because it is read on every send but mutated rarely.

## Presence & Last-Seen

Presence — the green dot that tells you someone is online — and last-seen timestamps are surprisingly hard at scale because the naive approach (a central registry updated on every connect/disconnect and queried on every chat open) becomes a write and read hotspot immediately. WhatsApp treats presence as a per-user ephemeral state stored on the user's home chat server and propagated sparingly. When a user connects, their home node marks them online; when the socket drops or a heartbeat times out, they are marked offline with a last-seen timestamp. A subscriber to that user's presence (someone who has the contact open or has recently messaged them) receives a presence push only if they are currently subscribed, and subscriptions are time-bounded to avoid a permanent fan-out graph. The system uses a publish-subscribe pattern scoped to the routing layer: the home node publishes presence changes, and only nodes with actively subscribed connections receive the update.

Last-seen is eventually consistent by design. If a user's home node crashes, their presence may briefly show online when they are not, or stale last-seen until the heartbeat reconciliation runs. WhatsApp deliberately does not guarantee real-time accuracy of last-seen for privacy reasons as well — users can hide it, and the system errs on the side of under-reporting rather than over-reporting. The heartbeat mechanism is a lightweight keepalive on the long-lived socket (often riding on the same TCP connection as message traffic) with a timeout tuned to detect a dead socket within 30 to 60 seconds without imposing excessive traffic on mobile networks. On mobile, the connection is often suspended when the app is backgrounded, so presence transitions to "offline" via the push notification channel rather than a clean TCP FIN, which is why WhatsApp relies on the push infrastructure as a backup liveness signal.

## Message Delivery Status (Sent, Delivered, Read)

The three-state receipt system — a single grey check for "the server accepted your message," double grey checks for "the recipient's client received it," and double blue checks for "the recipient read it" — maps onto three distinct protocol events with different durability guarantees.

- **Sent (✓)** — the server acknowledgement returned to the sender the instant the message is durably written to Cassandra; this is the at-least-once contract.
- **Delivered (✓✓ grey)** — a reverse-direction message sent by the recipient's client when it pulls the message from its inbox (either via a live push or an offline-queue drain) and writes it to its local store; the recipient's home node forwards this receipt back to the sender, who updates the UI and persists the state.
- **Read (✓✓ blue)** — an explicit user action (the recipient opened the conversation); handled identically in transport but semantically distinct.

### Message Delivery Flow (with receipts)

```
 Sender        Sender's Home     Cassandra       Recipient's Home     Recipient
  Client         Chat Server       (inbox)         Chat Server          Client
   │                │                 │                  │                 │
   │ encrypt(Signal)│                 │                  │                 │
   │ send ciphertext│                 │                  │                 │
   │───────────────>│                 │                  │                 │
   │                │ quorum write    │                  │                 │
   │                │ (recipient_id,  │                  │                 │
   │                │  timeUUID, ...) │                  │                 │
   │                │────────────────>│  RF=3 replicated │                 │
   │ server ACK     │                 │                  │                 │
   │<───────────────│                 │                  │                 │
   │ ✓ single tick  │                 │                  │                 │
   │                │ if recipient offline → enqueue content-free push     │
   │                │ routing lookup: which node owns recipient socket?   │
   │                │────────────────────────────────────>│                 │
   │                │                 │                  │ online? → push  │
   │                │                 │                  │────────────────>│
   │                │                 │                  │ offline? →      │
   │                │                 │  range scan on   │ leave in queue  │
   │                │                 │  reconnect       │                 │
   │                │                 │<─────────────────│ sync from       │
   │                │                 │  stream queued   │ watermark       │
   │                │                 │  messages        │                 │
   │                │                 │─────────────────>│────────────────>│ decrypt
   │                │                 │                  │                 │ + local store
   │                │ delivered       │                  │ ACK watermark   │
   │                │ receipt         │                  │<────────────────│
   │ ✓✓ double tick │<────────────────────────────────────│                 │
   │<───────────────│                 │                  │                 │
   │                │                 │                  │ read receipt    │
   │ ✓✓ blue tick   │<────────────────────────────────────│<────────────────│
   │<───────────────│                 │                  │                 │
```

The subtlety is that receipts are themselves messages and must be idempotent and ordered. If the network flaps, a "delivered" receipt might be sent twice; the sender's client must treat the second as a no-op, which it does by keying receipt state on the original message ID. Read receipts in groups are throttled and aggregated to prevent a thousand clients from each sending a read receipt that floods the sender. A production concern is that receipts can arrive out of order with the message they refer to (the message is still in the offline queue, but the receipt for a later message arrives first via a different path); the client reconciles by monotonic watermark tracking — a receipt for message N implies all messages before N from that sender are also delivered, so the client advances the watermark rather than tracking per-message state. This watermark approach is far cheaper than per-message bookkeeping and is the standard pattern in chat systems from WhatsApp to iMessage.

## Offline Message Sync

When a recipient is offline, every message addressed to them lands in their Cassandra inbox and stays there until they reconnect. This is the store-and-forward core. On reconnect, the client opens its connection, authenticates, and requests a sync starting from the last message ID it has acknowledged (a per-sender or per-group sequence number stored client-side). The server reads the recipient's inbox partition starting after that cursor and streams the queued messages in order. Because Cassandra's clustering key is time-ordered, this is an efficient range scan on a single partition. The client processes messages, writes them to its local encrypted store, and sends back an acknowledgement watermark; the server uses that watermark to decide which messages can be expired or tombstoned from the inbox.

The offline queue has a retention policy — typically 30 days — after which undelivered messages are garbage-collected from Cassandra. This bounds the storage footprint and aligns with user expectations (if you are offline for a month, you may not get every message). The queue is not a FIFO in the Kafka sense; it is a per-recipient table that supports random access by message ID, which matters for read receipts and for the case where a client acknowledges messages out of order. A critical operational detail is that the inbox partition for a very popular user (a celebrity with millions of followers in a broadcast channel) can become a hot partition and exceed Cassandra's per-partition throughput; WhatsApp mitigates this with bucketing — splitting a single logical inbox into N sub-partitions keyed by `(user_id, bucket)` — and by treating broadcast channels differently from normal chats, often routing them through a dedicated fan-out pipeline.

## Push Notifications

When a message lands in an offline user's inbox, the server cannot simply wait for them to reconnect — it must prod the device to wake the app. WhatsApp relies on the platform push gateways: Apple Push Notification service (APNs) for iOS, Firebase Cloud Messaging (FCM) for Android, and the Unified Push or manufacturer-specific channels for other platforms. The chat server, after writing the message to Cassandra, enqueues a push task containing a minimal, encrypted payload (often just "you have a new message from X" with no content, because the content is end-to-end encrypted and the push server cannot decrypt it). A push service consumes the task, fans out to APNs/FCM, and the device OS wakes the WhatsApp app, which then opens its socket and drains the inbox.

The design challenge is that push is a black box controlled by Apple and Google, with latency variance from milliseconds to minutes and with throttling policies that WhatsApp cannot directly control. To keep push traffic efficient, WhatsApp batches notifications for a user who has multiple pending messages into a single push, and it coalesces pushes within a short window (a few seconds) to avoid hammering the gateway during a group conversation. The push payload is intentionally content-free for privacy — the real message is fetched only after the app is awake and has established its encrypted session — which means the push channel carries no sensitive data and a compromised push gateway learns only metadata (that a message arrived). A failure mode is push storms during large group broadcasts; WhatsApp rate-limits push per recipient and degrades gracefully to "you have N new messages" rather than N individual notifications.

## Voice & Video Calls — WebRTC

WhatsApp's voice and video calls use WebRTC for the media path and the Signal Protocol for the key exchange that bootstraps each call. WebRTC provides the browser-grade media engine — codecs (Opus for audio, H.264/VP8/AV1 for video), echo cancellation, jitter buffering, bandwidth estimation, and secure RTP (SRTP) for transport encryption — but the call setup requires a signaling channel, and that signaling rides over the existing WhatsApp chat connection. The initiator sends a call-offer message (an SDP description encrypted with the Signal session) to the recipient through the normal message path; the recipient responds with an answer; ICE candidates are exchanged through the same channel to establish the best network path. Once the DTLS-SRTP handshake completes over WebRTC, media flows directly peer-to-peer when possible, or through a TURN relay server when NAT or firewall symmetry prevents a direct connection.

At WhatsApp's scale, most calls are one-to-one and can be peer-to-peer, but group calls (up to 32 participants) require a Selective Forwarding Unit (SFU) topology rather than a full mesh, because a 32-way mesh is 992 media flows per participant and is untenable. The SFU, running on WhatsApp's media infrastructure, receives each participant's encoded streams and forwards only the relevant subset to each receiver, dramatically reducing client bandwidth. The SFU never sees plaintext media because SRTP is end-to-end between participants (with per-participant keys derived via the Sender Keys group protocol extended to real-time media). TURN servers are deployed globally and are a significant cost center; they relay traffic only when needed, and the ICE negotiation prefers host and server-reflexive candidates before falling back to relay. A subtle reliability point is that the signaling channel (the chat socket) and the media channel (WebRTC) are decoupled — if the chat socket drops mid-call, the call continues because media is on a separate transport, and signaling can resume on reconnect.

## Multi-Device Sync

WhatsApp originally required the phone to be the single source of truth, with companion devices (web, desktop) acting as mirrors that only worked while the phone was online. The 2021 multi-device rewrite changed this fundamentally: each linked device now has its own identity key pair, its own Signal sessions with every contact, and can send and receive messages independently while the phone is offline. The server maintains a per-user, per-device message queue, and each device syncs from its own cursor. The architecture is essentially a per-device inbox layered on top of the per-user inbox — a message addressed to the user is fanned out to all of their linked devices' queues, and each device drains independently and maintains its own acknowledgement watermark.

The hard problem is consistency across devices: if you send a message from your phone and then open your laptop, the laptop must show the message you sent, even though it originated on a different device. WhatsApp solves this with a sender-side log that is itself synced: every outgoing message is written to a per-sender, per-device-synced log (conceptually the "sent messages" table), and each companion device catches up on that log as part of its sync. Conflicts are rare because messages are append-only and identified by client-generated, monotonic-per-sender IDs, but message ordering across devices is eventually consistent — a message sent from the phone may appear on the laptop a few seconds later as the sync catches up. Key management is the real complexity: each device has its own identity key, and every contact must establish a separate Signal session with each of your devices, which means the prekey consumption and session-count multiply by the number of linked devices (capped at four to keep this bounded). The security property preserved is that compromising one device does not compromise the others — each device's keys are independent, and revoking a linked device invalidates only its sessions.

## Failure Handling & Reliability

WhatsApp's reliability story is less "we never fail" and more "we fail in small, recoverable ways constantly and you never notice." The Erlang supervisor tree is the first line: a chat process that hits a bad state crashes and restarts; the client reconnects and resumes from its last-acknowledged watermark, losing at most a few in-flight messages that the store-and-forward layer re-delivers. Node failures are handled by the routing registry: when a chat server dies, the load balancer stops sending new connections to it, the affected clients reconnect to other nodes, and their undelivered messages are still safe in Cassandra because the chat servers are stateless with respect to durability. Cassandra itself tolerates node loss via its replication factor of three and gossip-based failure detection; losing one replica is transparent, and losing two is survivable for the remaining replica with `LOCAL_QUORUM` degraded to read-repair.

Network partitions are the classic distributed-systems trap, and WhatsApp's choice of eventual consistency for presence, last-seen, and group ordering is what lets the system stay available during a partition rather than blocking. The only strongly consistent operations are the per-recipient inbox writes (quorum on a single partition key), which is a narrow enough consistency scope to hold during most partitions. Push notification failures are handled by retry with exponential backoff and by falling back to the platform's own retry semantics; if push is entirely unavailable, the messages simply wait in the offline queue and are delivered when the user next opens the app organically. Media upload failures use a resumable, chunked upload protocol so a dropped connection mid-upload does not restart the whole object. At the higher level, WhatsApp practices progressive, region-by-region deployments with canarying, and the hot code upgrade capability of BEAM means a bad deploy can be rolled back without dropping connections. The overarching principle is that every component is designed to be disposable and replayable: if in doubt, throw it away and rebuild state from the durable tier, because the durable tier is the single source of truth.

## Sharp Interview Question

**Question:** *You send a message to a friend who is offline. They come online three days later. Walk me through every system component that touches that message from the moment you hit send to the moment the blue read ticks appear, and tell me where the message could be lost and how the architecture prevents that.*

**Model Answer:** When you hit send, your client encrypts the message with the Signal session established for that recipient, wraps it in the binary protocol envelope, and sends it over your long-lived TCP connection to your home chat server. That server does two things: it writes the ciphertext to the recipient's inbox partition in Cassandra (keyed by recipient ID, clustered by timeUUID) and, on a successful quorum write, returns a server ACK to you — this is the single grey tick, and it is the at-least-once durability contract. The message now lives in Cassandra, replicated to three nodes. Because the recipient is offline, the chat server also enqueues a push task, but the push is content-free; the real bytes stay in Cassandra. Your connection could drop right after you see the single tick — it does not matter, the message is durable.

Three days later, the recipient's phone wakes, the app opens, establishes a TCP connection to a chat server, and authenticates. It then requests a sync starting from its last-acknowledged message watermark. The server does a range scan on the recipient's inbox partition in Cassandra starting after that cursor and streams all queued messages — including yours — in chronological order. The client decrypts each with the Signal session, writes it to its local encrypted store, and sends back an updated acknowledgement watermark; the server receives this and advances the delivered state, sending a "delivered" receipt back through the routing layer to your home chat server, which pushes it to you — that is the double grey tick. When the recipient actually opens the conversation, the client sends a "read" receipt the same way, which reaches you as the blue ticks. The message could be lost in three places:

1. **Between your client and the server before the write** — prevented because you do not see the single tick until the Cassandra quorum write succeeds, and your client retries on no-ACK.
2. **In Cassandra** — prevented by replication factor three and quorum writes, with read-repair covering inconsistencies.
3. **Between the recipient's server and the recipient's client** — prevented because the message stays in the inbox until the client explicitly acknowledges it, so a dropped connection mid-sync just means the next sync resumes from the same cursor and re-delivers (idempotent because the client deduplicates by message ID).

The only genuine data-loss window is after the 30-day retention TTL, but that is a policy choice, not a bug.

**Common Pitfall:** Candidates often say "the message is stored in a queue like Kafka and consumed by the recipient." That is wrong on two counts. First, WhatsApp's inbox is not a log that is consumed and discarded; it is a per-recipient table that supports random access by message ID and is retained until acknowledged and then tombstoned — it is a mailbox, not a stream. Second, treating it as Kafka conflates the durability layer with a streaming broker and implies the recipient "subscribes," when in reality the recipient pulls from a cursor on reconnect. Another common mistake is assuming the server can read the message to route it — it cannot, because the content is end-to-end encrypted and the routing is done on the envelope's recipient ID, not the ciphertext. Saying the server decrypts to inspect content for spam or routing is an instant red flag in an interview; WhatsApp's server is a blind relay by design, and any answer that requires server-side plaintext misunderstands the entire security model.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- WhatsApp uses Erlang + Ejabberd (XMPP-inspired) — the actor model maps perfectly to per-user message routing
- End-to-end encryption: server is a blind relay — it routes by envelope recipient ID, not by decrypting content
- Message delivery: per-recipient inbox (mailbox), not a Kafka log — supports random access by message ID
- Ordering: per-sender sequence numbers, not global ordering — each chat has its own monotonic counter
- 2 billion users, ~50 engineers — ruthless simplicity over feature richness

**Common Follow-Up Questions:**
- "How does E2E encryption work with group messages?" — Sender encrypts once per recipient (not once per group) using the sender key protocol (Signal Protocol extension). Each recipient has their own session key.
- "How do you handle message delivery when both sender and recipient are offline?" — Message is stored in the recipient's inbox on the server (encrypted, server can't read it). Delivered via push notification when recipient comes online. Inbox entries are deleted after delivery acknowledgment.

**Gotcha:**
- Candidates often say "the message is stored in a queue like Kafka and consumed by the recipient." This is wrong on two counts: WhatsApp's inbox is a per-recipient mailbox table (not a consumed-and-discarded log), and the server can't read the message to route it (E2E encrypted — routing is by envelope metadata, not content). Saying the server decrypts to inspect content is an instant red flag.
