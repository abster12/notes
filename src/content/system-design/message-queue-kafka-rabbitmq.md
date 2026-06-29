---
title: "Message Queue (Kafka / RabbitMQ)"
type: system-design
category: Basics
date: 2026-05-04
tags: [system-design, interview, basics, kafka, rabbitmq, messaging]
difficulty: intermediate
read_time: 22
listen_time: 31
---

# Message Queue (Kafka / RabbitMQ)

## Summary & Interview Framing

A system that decouples producers from consumers using durable, replayable message logs — Kafka for high-throughput streaming, RabbitMQ for complex routing.

**How it's asked:** "Design a message queue supporting 1M messages/sec with exactly-once delivery, consumer groups, and 7-day retention. Compare Kafka and RabbitMQ for this use case."

## Overview

A message queue is a durability-first, asynchronous communication channel between services. Producers write messages; consumers read them. The queue decouples sender from receiver — the producer never blocks waiting for the consumer, and vice versa.

At its core, a message broker is an intermediary that accepts messages from producers, stores them durably (in memory or on disk), and delivers them to consumers according to a defined routing and delivery model. Two dominant architectures have emerged:

- **The traditional AMQP-style broker (RabbitMQ)** — a smart routing layer that pushes messages to consumers and deletes them on acknowledgment.
- **The distributed commit log (Kafka)** — a dumb, append-only log that consumers pull from and that retains messages for a configurable period regardless of whether they have been consumed.

The choice between these two models is one of the most consequential infrastructure decisions in a distributed system, because it shapes throughput characteristics, ordering guarantees, delivery semantics, operational complexity, and the kinds of failure modes the system will exhibit.

```
                     PRODUCER                       CONSUMER
                        |                              |
                        v                              v
   +--------------------+------------------------------+--------------------+
   |                  MESSAGE BROKER (intermediary)                         |
   |                                                                         |
   |   RabbitMQ:  Exchange -> [routing rules] -> Queue -> push -> Consumer   |
   |              (message destroyed on ack)                                 |
   |                                                                         |
   |   Kafka:     Topic -> Partition[] -> append-only log -> Consumer pulls  |
   |              (message retained for TTL / replayable)                    |
   +-------------------------------------------------------------------------+
```

## Why It Matters at Scale

Message queues earn their keep in four specific ways at scale:

- **Temporal decoupling** — services evolve independently on different release cycles, and a producer can write messages even when the downstream consumer is temporarily down or mid-deployment.
- **[[Glossary#Backpressure|Backpressure]] management** — a slow consumer does not crash the producer; messages queue up in the broker, and the producer continues operating at its own rate.
- **Replayability** — Kafka retains messages on disk for days or weeks, so you can replay events for debugging, auditing, rebuilding state stores, or backfilling a new downstream service that was added later.
- **Throughput isolation** — critical for workflows where one slow downstream service cannot be allowed to choke the entire pipeline, because each consumer reads at its own pace from its own offset or queue.

Beyond these four, message queues also serve as the backbone for:

- Event-driven architecture
- Change data capture (CDC)
- Real-time stream processing
- The transactional outbox pattern, where a database table and a relay process together provide reliable event publication without dual-write inconsistency

## Kafka Architecture

Kafka is a distributed, partitioned, replicated commit log. The unit of organization is the **topic**, which is a named logical stream of records. Each topic is split into one or more **partitions**, and each partition is an ordered, append-only sequence of records identified by a monotonically increasing integer called the **offset**.

Partitions are the fundamental unit of parallelism in Kafka: a topic with N partitions can be consumed by up to N consumers in parallel within a single consumer group, and adding partitions is the primary mechanism for scaling a topic's throughput. A record's position within a partition is its offset, and offsets are assigned by the broker at write time — the producer does not choose offsets. Ordering is guaranteed only within a single partition, never across partitions, which is why partition key selection is a critical design decision (covered below).

### Brokers, Partitions, and Offsets

A Kafka cluster consists of one or more **brokers** — servers that host partitions. Each partition is replicated across a configurable number of brokers (the replication factor, typically 3) for fault tolerance. One replica of each partition is designated the **leader**, and all other replicas are **followers**. The leader handles all reads and writes for that partition; followers passively replicate the leader's log. If the leader fails, one of the in-sync followers is elected as the new leader by the cluster controller.

Partition leadership is distributed across brokers so that no single broker is the leader for all partitions of a busy topic, which balances load. Producers connect to any broker (which acts as a bootstrap server) and the broker redirects metadata requests to the correct leader. Consumers similarly discover partition leaders through metadata.

The offset model is powerful because it gives consumers random access into the log — a consumer can seek to any offset, replay from the beginning, or skip ahead. This is fundamentally different from a traditional queue where a message is destroyed after acknowledgement.

```
                        KAFKA CLUSTER  (topic "orders", 3 partitions, RF=3)

   Broker 1                Broker 2                Broker 3
  +----------------+     +----------------+     +----------------+
  | P0 [LEADER]    |     | P1 [LEADER]    |     | P2 [LEADER]    |
  |  offset: 0..n  |<--->|  offset: 0..m  |<--->|  offset: 0..k  |   (followers
  | P1 [follower]  |     | P2 [follower]  |     | P0 [follower]  |    replicate
  | P2 [follower]  |     | P0 [follower]  |     | P1 [follower]  |    leader log)
  +----------------+     +----------------+     +----------------+
          ^                     ^                     ^
          |                     |                     |
          +----------+----------+----------+----------+
                     |                     |
               PRODUCER (writes              CONSUMER (pulls,
               to leader of P0)              seeks any offset)

  Partition/Offset model (one partition = one ordered log):

   P0:  [0] msg_A   <-- oldest
        [1] msg_B
        [2] msg_C
        [3] msg_D   <-- high-watermark (last committed; visible to consumers)
        [4] msg_E   <-- uncommitted (leader only; NOT visible until ISR acks)

  Consumer can seek(0) to replay, seek(end) to tail, or seek(N) to skip ahead.
```

### Consumer Groups and Rebalancing

All consumers sharing the same `group.id` form a **consumer group**, and partitions of a topic are distributed among the group's members. Each partition is assigned to exactly one consumer within the group, which means parallelism is bounded by the number of partitions, not the number of consumers — adding more consumers than partitions yields idle consumers.

When consumers join or leave the group (due to deployment, crash, or scaling), a **rebalance** occurs: the partition-to-consumer assignment is recomputed and redistributed. Rebalances are expensive because they involve a stop-the-world pause during which no consumption happens, and in older Kafka versions they could take seconds or longer.

Modern Kafka (2.4+) offers **incremental cooperative rebalancing** (the CooperativeStickyAssignor) that reduces this disruption by transferring only the partitions that must move rather than revoking and reassigning everything. For workloads where rebalance pauses are unacceptable, **static partition assignment** (assigning partitions manually and forgoing the group protocol) is an option.

```
   CONSUMER GROUP REBALANCING  (topic with 4 partitions: P0, P1, P2, P3)

   BEFORE (3 consumers):          AFTER (consumer-2 crashes -> 2 consumers):

   consumer-1: P0, P1   |           consumer-1: P0, P1, P2
   consumer-2: P2       |     -->   consumer-3: P3
   consumer-3: P3       |           (consumer-2 gone; P2 reassigned)

   Stop-the-world pause during rebalance -> no consumption.
   CooperativeStickyAssignor moves ONLY P2 (the changed partition),
   instead of revoking + reassigning all partitions.
```

A key operational detail: the consumer offset (the last successfully processed offset) is committed to an internal compacted topic called `__consumer_offsets`, and committing offsets after processing (not before) is what gives Kafka its at-least-once default. Consumers can commit offsets:

- **Automatically** — at a fixed interval (simpler, but may commit before processing finishes → duplicates on crash)
- **Manually** — after processing a batch (finer control; the basis for exactly-once-adjacent semantics)

### ISR (In-Sync Replicas) and Replication

The **ISR (In-Sync Replicas)** set is the set of replicas that have fully caught up with the leader's log — they have fetched all messages up to the leader's high-watermark within a configurable lag threshold (controlled by `replica.lag.time.max.ms`, default 30 seconds). Only ISR members are eligible to become leader if the current leader fails.

The replication factor (typically 3) determines how many brokers hold a copy of each partition. When `acks=all` (the recommended setting) is configured on the producer, the leader waits for all ISR replicas to acknowledge the write before considering it committed, meaning a single broker failure cannot lose data as long as at least one ISR replica survives. If a follower falls behind and leaves the ISR, it rejoins only after fully catching up.

```
   ISR & REPLICATION (partition P0, replication factor 3)

        Leader (Broker 1)          Follower (Broker 2)      Follower (Broker 3)
        offset 0..5 [committed]    offset 0..5 [caught up]  offset 0..3 [LAGGING]
             |                          |                         |
             |  acks=all: leader waits  |                         |
             +-- for ISR acks --------->+                         |
             |                          |   (NOT in ISR —         |
             |  high-watermark = 5 <----+   ineligible to lead)   |
             v
        [6] new write   ---- replicated to ISR members ----> Broker 2 ✓
                          ---- Broker 3 lagging, excluded -------> ✗

   IF leader fails:  controller elects an ISR follower as new leader.
   IF all ISR fail simultaneously (rare): data can be lost.
   unclean.leader.election.enable=true  -> prefer availability (may lose data)
   unclean.leader.election.enable=false -> prefer consistency (partition down
                                            until ISR recovers) [DEFAULT]
```

The critical failure mode to understand: if all ISR replicas fail simultaneously (a rare but catastrophic scenario), data can be lost. Kafka's `unclean.leader.election.enable` setting controls whether a non-ISR replica can become leader:

- **`true`** — availability is prioritized over consistency (potential data loss)
- **`false`** (the default in modern Kafka) — consistency is prioritized (the partition remains unavailable until an ISR replica recovers)

This is the classic [[Glossary#CAP Theorem|CAP]] tradeoff surfaced as a configuration knob.

The **high-watermark** is the offset of the last committed message — it advances only after ISR acks, and only messages below the high-watermark are visible to consumers, which prevents consumers from reading uncommitted data that could be rolled back if the leader fails.

## RabbitMQ Architecture

RabbitMQ is a traditional AMQP 0-9-1 message broker built on Erlang/OTP, designed around a smart broker and dumb consumer model. Where Kafka is a distributed log that consumers pull from, RabbitMQ is a routing and delivery engine that pushes messages to consumers based on a graph of exchanges, bindings, and queues. The broker takes responsibility for routing messages to the right place, tracking delivery, and removing messages once they are acknowledged. This model excels at complex routing, task distribution, and request-response patterns where each message has a clear destination and lifecycle.

### Exchanges, Queues, Bindings, and Channels

An **exchange** is the entry point for a published message — producers never write directly to a queue; they write to an exchange. The exchange inspects the message's **routing key** (and optionally headers) and routes it to one or more queues based on **bindings**. A binding is a rule that links an exchange to a queue with a routing key pattern.

```
   RABBITMQ: PRODUCER -> EXCHANGE -> [binding rules] -> QUEUE -> CONSUMER

   Producer --publish(routing_key)--> EXCHANGE
                                          |
              +---------------------------+---------------------------+
              |                           |                           |
        binding(key="A")            binding(key="B.*")          binding(any)
              |                           |                           |
              v                           v                           v
         +--------+                 +--------+                 +--------+
         | Queue1 |                 | Queue2 |                 | Queue3 |
         +--------+                 +--------+                 +--------+
              |                           |                           |
              v (push)                    v (push)                    v (push)
          Consumer1                   Consumer2                   Consumer3
              |                           |                           |
              +-- ack/nack ---------------+-- ack/nack ---------------+
                  (broker removes              (broker removes
                   message on ack)             message on ack)

   Channels: one TCP connection multiplexes many virtual "channels"
   (unit of concurrency; avoids repeated TCP handshake/auth overhead).
```

There are four core exchange types:

- **Direct exchange** — routes messages to queues whose binding key exactly matches the routing key. Useful for point-to-point delivery and task routing by severity or category.
- **Topic exchange** — matches the routing key against wildcard patterns where `*` matches one word and `#` matches zero or more dot-separated words. Useful for hierarchical routing like `logs.us.west.error` or `orders.region-7.created`.
- **Fanout exchange** — ignores the routing key and delivers a copy of every message to every bound queue. Useful for broadcast patterns like cache invalidation or fan-out work distribution.
- **Headers exchange** — routes based on message headers rather than the routing key, allowing arbitrary attribute-based matching.

```
   EXCHANGE TYPES (routing behavior)

   DIRECT (exact key match):
        routing_key="error"  -->  Queue[bind "error"]
        routing_key="info"   X   Queue[bind "error"]  (no match)

   TOPIC (wildcard pattern):
        routing_key="logs.us.west.error"
          -> Queue[bind "logs.*.west.*"]       (* = one word)   MATCH
          -> Queue[bind "logs.#.error"]        (# = 0+ words)   MATCH
          -> Queue[bind "logs.eu.#"]                            NO MATCH

   FANOUT (ignore key, copy to ALL bound queues):
        routing_key=<anything>
          -> Queue A (copy)  -> Queue B (copy)  -> Queue C (copy)

   HEADERS (match on headers, not routing key):
        headers={format="json", type="report"}
          -> Queue[bind x-match=all, format=json, type=report]  MATCH
```

**Queues** are the actual message buffers; they are durable or transient, and they hold messages until a consumer acknowledges them. **Channels** are virtual multiplexed connections — a single TCP connection from a client can carry many channels, each acting as an independent session, which avoids the overhead of opening many TCP connections while still allowing concurrent operations. This is important because opening a TCP connection in AMQP involves a handshake and authentication that is relatively expensive, so channels are the unit of concurrency.

### Delivery and Acknowledgment Model

RabbitMQ uses a **push model**: when a consumer is registered on a queue, the broker pushes messages to it, subject to a **prefetch count** (QoS setting) that limits how many unacknowledged messages can be in flight to a single consumer. The prefetch count is the RabbitMQ equivalent of flow control — it prevents a fast broker from overwhelming a slow consumer by capping the number of unacked messages buffered at the consumer.

When the consumer finishes processing a message, it sends an **ack** (`basic.ack`) to the broker, which then removes the message from the queue. If the consumer dies (TCP connection drops) without acking, the broker requeues the message for redelivery to another consumer — this is the basis of at-least-once delivery. A consumer can also:

- **Nack** a message (`basic.nack`), optionally with `requeue=false` to send it to a dead letter exchange.
- **Reject** a single message.

RabbitMQ also supports **publisher confirms** (an async acknowledgment from broker to publisher that a message was received and persisted) for durable delivery, and **transactions** for atomic publish operations, though transactions are slow and confirms are preferred in practice.

The choice between auto-ack and manual-ack is a delivery-semantics decision:

- **Auto-ack** — the broker removes the message as soon as it is delivered. Gives **at-most-once** (a consumer crash after delivery loses the message).
- **Manual-ack** — the consumer must explicitly ack. Gives **at-least-once** (a crash before ack requeues it).

## Delivery Semantics

The three delivery semantics — at-most-once, at-least-once, and exactly-once — are the central correctness tradeoff in any messaging system, and interviewers probe them heavily because they connect to the broader distributed systems concepts of idempotency, consensus, and the two-general problem.

### At-Most-Once

Each message is delivered zero or one times; duplicates are impossible but losses are possible. This is the cheapest semantic because it requires no acknowledgments or retries.

- **RabbitMQ:** auto-ack consumers
- **Kafka:** `acks=0` on the producer and never retrying
- **Use case:** telemetry, metrics, and log forwarding where occasional loss is acceptable and the cost of deduplication exceeds the cost of loss.

### At-Least-Once

Each message is delivered one or more times; losses are impossible but duplicates are possible under failure. This is the most common and practical semantic.

- **Kafka:** the default with `acks=all`, retries enabled, and the idempotent producer enabled (`enable.idempotence=true`), which deduplicates retries within a producer session so the broker never writes the same sequence number twice.
- **RabbitMQ:** manual ack and publisher confirms.
- **Critical implication:** consumers must be **[[Glossary#Idempotency|idempotent]]** — processing the same message twice must not corrupt state. This is typically achieved with a deduplication key (a message ID stored in a processed-messages set or database unique constraint) so the consumer can detect and skip duplicates.
- Most production systems default to at-least-once with idempotent consumers because it is simple, robust, and sufficient for the vast majority of workloads.

### Exactly-Once

Each message is delivered exactly one time — no losses, no duplicates. True end-to-end exactly-once is expensive and often impossible without distributed transactions or consensus across the producer, broker, and consumer.

- **Kafka:** offers exactly-once within the Kafka ecosystem via its transactions API. A producer can atomically write to multiple partitions and a consumer can read only committed transactions (`isolation.level=read_committed`). The consume-process-produce loop (the read-modify-write pattern common in stream processing) can be made exactly-once with `transactional.id` and the Kafka Streams API.
- **Kafka + external system:** exactly-once across Kafka and an external system (e.g., Kafka to a database) is **not** provided by Kafka alone — you need the transactional outbox pattern (write the message and the database update in the same database transaction, then a relay publishes to Kafka) or a two-phase commit, both of which have performance and complexity costs.

The standard senior-level guidance: default to at-least-once with idempotent consumers, and reserve exactly-once for cases where duplicates cause financial or correctness harm (payment processing, inventory deduction) and where the infrastructure cost is justified.

### Delivery Semantics Comparison

| Semantic | Losses? | Duplicates? | Cost | Kafka config | RabbitMQ config | Typical use |
|---|---|---|---|---|---|---|
| **At-most-once** | Yes | No | Lowest | `acks=0`, no retries | auto-ack consumers | Telemetry, metrics, log forwarding |
| **At-least-once** | No | Yes | Medium | `acks=all`, retries, `enable.idempotence=true` | manual ack + publisher confirms | Most production workloads |
| **Exactly-once** | No | No | Highest | Transactions API, `transactional.id`, `isolation.level=read_committed` | Not natively supported (needs app-level dedup + outbox) | Payments, inventory deduction, financial systems |

## Partition Strategies

Partition key selection determines which messages land on which partition, and because ordering is only guaranteed within a partition, it determines the ordering guarantees your system can provide.

- **Key-based hashing (default):** partition by a key like `user_id` or `order_id` using a hash of the key (Kafka's default partitioner uses `murmur2` hash mod number of partitions). This guarantees that all messages for a given user land on the same partition and are consumed in order by a single consumer — essential for per-entity state machines like order lifecycle processing.
- **Risk: skew.** A disproportionately active user (a "hot key") can overload a single partition, creating a bottleneck because that partition's throughput is bounded by a single broker and a single consumer.

Mitigations for skew:

- **Salting the key** — append a random number to create sub-partitions that are later reassembled.
- **Custom partitioners** that spread known hot keys.
- **Partitioning by a higher-cardinality field.**

If no ordering is needed, **round-robin** or **sticky partitioning** (Kafka 2.4+, which batches messages to the same partition to improve batching efficiency) can maximize throughput by evenly distributing load.

A common mistake is choosing a key that produces severe skew without realizing it — always validate partition distribution in production with metrics on per-partition message rate. Another subtle issue: the number of partitions is set at topic creation and can only be increased (never decreased), and adding partitions breaks key ordering for keys whose hash now maps to a new partition, so plan partition counts upfront based on throughput estimates.

## Log Compaction

Kafka's retention model offers two modes:

- **Time-based retention** — delete messages older than a TTL (default 7 days).
- **Log compaction** — retain the latest value for each key in a partition and delete older records with the same key, producing a snapshot-like log where each key maps to its most recent value.

Log compaction is the mechanism behind Kafka's use as a state store and source of truth — the `__consumer_offsets` topic and the Kafka Streams changelog topics are compacted, and any application can use compacted topics to maintain a materialized view (e.g., current user profiles, current inventory levels) by simply replaying the log from the beginning and retaining only the last value per key.

Compaction characteristics:

- Runs in the background by a thread that builds clean segments; active segments are never compacted until they roll.
- Does not guarantee immediate removal of old keys — there is a delay, and a key with only one record is retained.
- Guarantees that eventually the log contains at least the last value for every key that was ever written.
- Conceptually similar to the LSM-tree compaction in LevelDB or RocksDB. Kafka Streams uses RocksDB locally for state stores, syncing changes back to a compacted Kafka topic for fault tolerance.

The practical implication for design:

- If you need a durable, replayable **source of truth for current state** (not events) → use a **compacted topic** with a stable key.
- If you need an **event log of all changes** → use **time-based retention**.

## Throughput Optimization

Kafka's throughput comes from a set of design choices:

- **Sequential disk writes** — on modern SSDs and even spinning disks approach the speed of random memory access for large sequential workloads because the OS page cache and disk prefetch absorb the cost.
- **Zero-copy transfer** — the broker uses `sendfile` to move data directly from page cache to the socket without copying into user space.
- **Batching** — producers batch messages into large requests and consumers batch fetches, amortizing network and disk overhead.

### Kafka Producer Tuning

- `batch.size` — max batch size in bytes (default 16KB). Increase to 64KB or more for high-throughput.
- `linger.ms` — time the producer waits to fill a batch (default 0). Setting to 5–20ms trades a small latency increase for much larger batches.
- **Compression** — `snappy` (balanced CPU/compression), `lz4` (speed), `zstd` (best ratio).
- **Enable the idempotent producer** (`enable.idempotence=true`).

### Kafka Consumer Tuning

- Increase `fetch.min.bytes` and `fetch.max.bytes` to pull larger batches per request.
- Increase the number of partitions and consumers in the group.
- Use manual offset commits per batch rather than per message.

### Kafka Broker Tuning

- Ensure sufficient **disk I/O bandwidth** (Kafka is disk-bound under load).
- Enough **page cache RAM** (a rule of thumb is enough RAM to hold the active working set).
- Avoid overloading any single broker with too many partition leaders — use **partition reassignment** to balance.

### RabbitMQ Throughput Tuning

RabbitMQ throughput is bounded by the broker's single-node Erlang scheduler and routing overhead, so the primary levers are:

- Use **quorum queues** (replicated, Raft-based, better than classic mirrored queues for durability and throughput under failure) or **classic queues** for raw single-node throughput.
- Increase **prefetch count** to keep consumers busy.
- Use **multiple queues and consumers** for parallelism.
- Keep messages small (large messages should be offloaded to object storage with a reference passed in the message body).
- Be aware classic queues peak around 20,000–50,000 messages per second on a single broker; quorum queues are lower due to Raft replication overhead.

## Dead Letter Queues

A **dead letter queue (DLQ)** is a destination for messages that cannot be processed successfully after exhausting retries — it is the safety net that prevents poison messages from blocking the main pipeline indefinitely.

- **RabbitMQ:** DLQs are a first-class feature. A queue can be configured with `x-dead-letter-exchange` so that messages that are:
  - rejected (`nack` with `requeue=false`),
  - expired (TTL exceeded), or
  - exceed a queue length limit
  
  are routed to a specified exchange, which typically feeds a DLQ for inspection and replay.

- **Kafka:** there is no built-in DLQ. It is an application-level pattern where the consumer catches processing exceptions and publishes the failed message to a separate dead letter topic, then commits the original offset so the main topic can continue.

The DLQ message should carry metadata:

- Original topic, partition, offset
- Exception type and message
- Timestamp

A common production pattern is a **tiered retry strategy**: retry a few times with exponential backoff (using a delayed exchange in RabbitMQ or a scheduled retry topic in Kafka), and if still failing, move to the DLQ for human or automated inspection.

The key design principle: never block the main pipeline on an unprocessable message — move it aside, preserve it, and keep the pipeline flowing. DLQs are also a debugging goldmine: a rising DLQ depth is an alert signal that something is wrong with a downstream dependency, a schema change, or a data quality issue.

## Schema Registry

In a Kafka-based event streaming architecture, producers and consumers need to agree on the structure of messages — the **schema**. Without a central registry, schema evolution breaks consumers silently: if a producer starts sending a new field or renames an existing one, consumers built for the old schema fail or produce garbage.

The **Confluent Schema Registry** solves this by storing schemas (typically Avro, Protobuf, or JSON Schema) in a dedicated service and assigning each a unique ID. Producers register or look up the schema, include the schema ID in the message payload, and the registry enforces compatibility rules configured per topic.

Compatibility modes:

- **Backward compatibility** (default) — new schema can read old data.
- **Forward compatibility** — old schema can read new data.
- **Full compatibility** — both backward and forward.

The compatibility check happens at publish time — a producer cannot publish a message with a schema that violates the topic's compatibility policy, which prevents breaking changes from reaching production.

Practical guidance for schema evolution:

- **Add fields with defaults** (backward compatible).
- **Never remove fields** without a deprecation window (breaks backward compatibility).
- **Never change field types** (breaks everything).
- **Use union types or optional fields** for forward-compatible changes.

Schema Registry is often paired with **Avro** for compact binary encoding (smaller than JSON, faster to parse) and with the Confluent serializers that integrate with Kafka producers and consumers transparently.

For a senior interview, the key points are:

- Schema registry is about **governance and safe evolution**.
- It enforces **compatibility at publish time**.
- It decouples the schema from the message bytes by embedding only an ID.

## When to Use Kafka vs RabbitMQ

The decision rests on the workload's shape and the guarantees needed.

**Use Kafka when you need:**

- High-throughput event streaming (millions of messages per second across a cluster)
- Durable retention and replay (consuming the same events multiple times by different applications, rebuilding state, auditing)
- Decoupled multi-consumer fan-out where many independent applications read the same stream at their own pace
- Change data capture (CDC) pipelines
- Log aggregation
- Real-time stream processing with Kafka Streams or Flink
- Event sourcing where the log itself is the system of record

**Use RabbitMQ when you need:**

- Complex routing (topic exchanges, header-based routing, conditional delivery)
- Low-latency per-message delivery with individual acknowledgement
- Task queues and work distribution where each task should be processed exactly once by one of many workers
- Request-response RPC patterns (reply queues, correlation IDs)
- Legacy AMQP ecosystem integration
- Smaller message volumes where the operational overhead of a Kafka cluster is not justified

A useful mental model:

- **Kafka is a ledger** — append-only, retained, replayable, high throughput, coarse ordering.
- **RabbitMQ is a mailroom** — routed, delivered, discarded, lower throughput, flexible routing.

Many systems use both — Kafka for the event backbone and durable stream, RabbitMQ for command-style task queues and RPC. Do not use Kafka for RPC (it can be done but it is awkward and fights the design), and do not use RabbitMQ for long-term event retention (it can be done with lazy queues but it is not the sweet spot).

### Kafka vs RabbitMQ — Feature Comparison

| Dimension | Kafka | RabbitMQ |
|---|---|---|
| **Model** | Distributed append-only commit log (consumers pull) | Smart routing broker (push to consumers) |
| **Unit of organization** | Topic → partitions → offset-ordered log | Exchange → binding → queue |
| **Message retention** | Retained for TTL (default 7 days) or compacted; replayable | Removed on ack; not replayable |
| **Throughput** | Millions/sec across cluster | ~20K–50K/sec per queue (single node) |
| **Parallelism** | Partitions (consumers ≤ partitions per group) | Multiple queues + consumers |
| **Ordering guarantee** | Per-partition (offset order) | Per-queue (FIFO) |
| **Routing** | Partition key (hash-based) | Rich: direct, topic, fanout, headers |
| **Delivery** | Pull, offset-based, seekable | Push, prefetch-limited, ack-based |
| **Replay** | Yes (seek to any offset) | No (deleted on ack) |
| **Durability** | Replication (ISR, acks=all, RF=3) | Quorum queues (Raft) or classic mirrored |
| **DLQ** | Application-level pattern | First-class (`x-dead-letter-exchange`) |
| **Best for** | Event streaming, CDC, log aggregation, event sourcing | Task queues, RPC, complex routing, work distribution |
| **Mental model** | Ledger (append-only, retained) | Mailroom (routed, delivered, discarded) |

## Capacity Estimation

For a senior interview, you should be able to size a Kafka cluster from requirements. Suppose the workload is **100,000 events per second**, each event averaging **1 KB**, with a **7-day retention** and a **replication factor of 3**.

### Kafka Sizing Math

- **Raw write throughput:** 100,000 × 1 KB = ~100 MB/s
- **Network write amplification (RF=3):** ~300 MB/s across the cluster (each message written to leader + replicated to 2 followers)
- **Storage per day:** 100 MB/s × 86,400 s = ~8.6 TB raw data
- **With RF=3:** ~26 TB per day across the cluster
- **With 7-day retention:** ~180 TB total storage
- **Broker count:** if each broker has 4 TB usable disk (leaving headroom for OS and compaction), you need ~180 / 4 = 45 broker-disks; with 4 disks per broker → ~12 brokers. Ensure no single broker is a bottleneck for network or disk I/O — 100 MB/s of leader writes plus 200 MB/s of follower replication traffic must be spread so no broker exceeds its bandwidth.

### Partition Count Sizing

- Write side: if each partition handles ~10–20 MB/s (conservative, hardware/batching dependent), you need at least **5–10 partitions** for 100,000 events/sec.
- Consume side: if you want 10 parallel consumers, you need at least **10 partitions**.
- In practice, **over-provision partitions to 2–3× the consumer count** to allow for scaling and rebalancing headroom.

### RabbitMQ Sizing

- Dominant constraint is **per-queue throughput on a single node**:
  - Classic queues peak around **20,000–50,000 messages/sec** on a single broker.
  - Quorum queues are lower due to Raft replication overhead.
- High-throughput RabbitMQ deployments **shard across many queues and brokers**.
- Primary resource constraints:
  - **RAM** (for the message backlog in classic queues)
  - **Disk** (for durable messages and quorum queue logs)

## Interview Question

**Question:** You are building an order processing system. Orders arrive at 10,000 per second and each order goes through a payment, inventory, and shipping step, each handled by a separate service. The payment step must not be duplicated (double-charging is unacceptable). How do you design the messaging layer, and what delivery semantics do you choose for each step?

**Model Answer:**

Use Kafka as the backbone with an `orders` topic partitioned by `order_id` so all events for a given order land on the same partition and are processed in order — this preserves the order state machine's integrity. Each downstream service (payment, inventory, shipping) is its own consumer group reading from the relevant topic, so they are decoupled and can scale independently up to the partition count.

**Payment step — exactly-once required (avoid double-charging):**

- Cleanest approach: the **transactional outbox pattern** — the payment service processes the order and writes both the payment record and an outbox event to the same database transaction, then a relay publishes the outbox event to Kafka. This guarantees the payment and the event publication are atomic: no double-charge, no lost event.
- Alternative: if the payment service uses Kafka Streams with `transactional.id` and the consume-process-produce loop, exactly-once within Kafka is achievable without an external outbox.

**Inventory & shipping — at-least-once with idempotent consumers:**

- Each consumer deduplicates by `order_id` using a processed-events table or a Redis set with a TTL, so redelivery after a consumer crash is safe.

**Producer settings:**

- Set `acks=all` and `enable.idempotence=true` on all producers to prevent duplicate writes on retry.

**Retry/failure handling:**

- Use a tiered retry with a DLQ topic for messages that fail after N attempts so a poison message does not block the partition.

**Monitoring:**

- Monitor **consumer lag** (the gap between the log-end offset and the committed offset) as the primary health metric — rising lag means a downstream service cannot keep up and signals a capacity or failure issue.

**Common Pitfall:** A frequent mistake is assuming that Kafka's idempotent producer gives end-to-end exactly-once delivery. It does not — the idempotent producer only prevents duplicate writes to Kafka within a producer session; it says nothing about the consumer side, where a crash after processing but before committing the offset causes redelivery. End-to-end exactly-once requires either Kafka transactions (within Kafka) or the outbox pattern (with an external system), plus idempotent consumers as a defense in depth.

Another pitfall is choosing `order_id` as the partition key without checking for skew — if one merchant bulk-submits 10,000 orders, all land on one partition and overwhelm a single consumer; salt the key or use a composite key in that case.

## Summary

The Kafka-versus-RabbitMQ choice is not about which is "better" — it is about which model fits the workload.

- **Kafka** is the right tool for high-throughput, retained, replayable event streams where the log is the system of record and multiple consumers read independently at their own pace.
- **RabbitMQ** is the right tool for routed, task-oriented message delivery where each message has a clear destination and lifecycle, complex routing is needed, and retention is not the goal.

For senior interviews, master the four pillars:

1. **Kafka's partition-and-offset model** and its implications for ordering and parallelism.
2. **The ISR and replication mechanics** that underpin durability and the CAP tradeoff.
3. **The three delivery semantics** and how to achieve each in both systems.
4. **The operational patterns** (idempotent consumers, outbox, DLQ, schema registry, capacity sizing) that make a messaging system production-grade.

Default to at-least-once with idempotent consumers; reach for exactly-once only when the business cost of duplicates justifies the infrastructure complexity.

## Interview Cheat Sheet

**Key Points to Remember:**
- Kafka is a durable, append-only log that consumers pull from and replay; RabbitMQ is a smart routing broker that pushes messages and deletes them on ack. Mental model: Kafka is a ledger, RabbitMQ is a mailroom.
- Kafka guarantees ordering only within a partition — partition key choice determines both ordering and skew risk. Parallelism is bounded by partition count (consumers ≤ partitions per group).
- Default to at-least-once delivery with idempotent consumers (dedup by message ID); reserve exactly-once for cases where duplicates cause real harm (payments), using Kafka transactions or the transactional outbox pattern.
- `acks=all` with `enable.idempotence=true` and replication factor 3 is the production baseline for Kafka durability; `unclean.leader.election.enable=false` prioritizes consistency over availability when all ISR replicas fail.
- Size partitions to 2–3x the consumer count, and monitor consumer lag (the gap between log-end and committed offset) as the primary health metric.

**Common Follow-Up Questions:**
- **"How do you prevent duplicate processing if a consumer crashes mid-handling?"** — Make consumers idempotent: store a processed-message ID (in a DB unique constraint or Redis set with TTL) and skip duplicates on redelivery, since at-least-once means redelivery is expected, not exceptional.
- **"When would you pick RabbitMQ over Kafka?"** — When you need complex routing (topic/header exchanges), low-latency per-message delivery with individual acks, task queues/RPC patterns, or smaller volumes where a Kafka cluster's operational overhead isn't justified.
- **"Can Kafka give you exactly-once delivery?"** — Only within the Kafka ecosystem (transactions API with `transactional.id`); across Kafka and an external system you need the transactional outbox pattern. The idempotent producer alone only prevents duplicate writes to Kafka, not end-to-end duplicates.

**Gotcha:**
- Assuming Kafka's idempotent producer delivers end-to-end exactly-once. It does not — it only deduplicates producer retries within a session. A consumer crash after processing but before committing the offset causes redelivery, so end-to-end exactly-once still requires Kafka transactions or the outbox pattern plus idempotent consumers.
