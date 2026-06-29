---
title: "Glossary — System Design & Coding Interview Terms"
type: reference
category: Reference
tags: [glossary, reference, system-design, coding-interview, terminology]
aliases: ["Glossary", "System Design Glossary", "Coding Interview Glossary", "Technical Terms"]
---

# Glossary — System Design & Coding Interview Terms

> A centralized reference for every technical term used across the System Design and Coding Interview Prep notes. Organized by domain. Each definition is written so a beginner can understand it and an experienced engineer can use it for quick revision.

---

## A

**ACID** — A set of properties for database transactions: **A**tomicity (all-or-nothing), **C**onsistency (valid state to valid state), **I**solation (concurrent transactions don't interfere), **D**urability (committed writes survive crashes). Guarantees correctness in relational databases like PostgreSQL, MySQL.

**Actor Model** — A concurrency model where independent "actors" communicate exclusively by exchanging messages. Each actor processes one message at a time and has private state. Used in Erlang, Akka. Relevant to chat systems and WhatsApp architecture.

**Akamai** — One of the largest CDN providers. Pioneered commercial CDN technology in the late 1990s. Also one of the earliest production users of consistent hashing.

**Amortized Analysis** — A method of analyzing time complexity that averages the cost of operations over a sequence, even if individual operations are expensive. Example: `ArrayList.add()` is O(1) amortized even though resizing is O(n) occasionally.

**Annihilation** — In rate limiting, a term describing the complete blocking of requests when a limit is exceeded. See Rate Limiting.

**API Gateway** — A single entry point that routes client requests to backend services, handles cross-cutting concerns like authentication, rate limiting, SSL termination, and request aggregation. Examples: Kong, AWS API Gateway, NGINX.

**Approximate Nearest Neighbor (ANN)** — Algorithms that find points "close" to a query point in high-dimensional space without exhaustively comparing against all points. Trades exactness for speed. Used in vector databases (HNSW, IVF, LSH).

**Asynchronous Replication** — A database replication mode where the primary acknowledges a write before replicas have confirmed it. Improves write latency but means replicas may lag behind — eventual consistency. See also Synchronous Replication.

**Auto-scaling** — Automatically adjusting the number of running instances based on load. Typically scales out (add instances) under high load and scales in (remove instances) under low load. Configured via metrics like CPU utilization, request queue depth, or custom metrics.

---

## B

**Backpressure** — A mechanism where a slow downstream component signals upstream producers to slow down or pause, preventing unbounded queue growth and memory exhaustion. Critical in streaming systems (Kafka, Flink) and reactive systems.

**Back-of-Envelope Estimation** — Quick, rough calculations used to reason about system capacity, storage, bandwidth, and throughput without precise measurement. Named after calculations done "on the back of an envelope." A key interview skill.

**Base62 Encoding** — A encoding scheme using 62 characters (a-z, A-Z, 0-9) to represent numbers. Used in URL shorteners to convert numeric IDs into short, human-readable codes. 6 characters of base62 can represent 62^6 ≈ 56.8 billion values.

**BASE** — The counterpart to ACID for distributed systems: **B**asically **A**vailable, **S**oft state, **E**ventually consistent. Describes systems that prioritize availability over immediate consistency.

**Bloom Filter** — A probabilistic data structure that efficiently tests whether an element is *possibly* in a set or *definitely not* in a set. No false negatives, but false positives are possible. Uses multiple hash functions and a bit array. Space-efficient for membership testing.

**B-tree** — A self-balancing tree data structure that maintains sorted data for efficient search, insertion, and deletion in O(log n) time. The standard index structure in most relational databases. Optimized for disk I/O by keeping nodes the size of disk pages.

**Bulkhead Pattern** — An isolation pattern where system resources (thread pools, connections) are partitioned so that failure in one subsystem doesn't exhaust resources needed by others. Named after ship compartments (bulkheads) that prevent flooding of the entire ship.

**Birthday Paradox** — A probability result: in a group of just 23 people, there's a >50% chance two share a birthday. In hashing, it means collisions become likely when the number of items reaches ~√(keyspace size). Relevant to URL shortener collision analysis.

**Byzantine Fault** — A fault where a node behaves arbitrarily — it may lie, send conflicting messages, or stop responding. Distinct from a crash fault (node simply stops). Byzantine fault tolerance (BFT) is needed in blockchain and distributed systems with untrusted participants.

---

## C

**CAP Theorem** — States that a distributed system can provide at most two of three guarantees simultaneously: **C**onsistency, **A**vailability, and **P**artition tolerance. Since network partitions are inevitable, the practical choice is between CP (consistency + partition tolerance) and AP (availability + partition tolerance).

**Capacity Estimation** — See Back-of-Envelope Estimation.

**CDN (Content Delivery Network)** — A geographically distributed network of edge servers that caches content close to users, reducing latency and origin load. Examples: Cloudflare, Akamai, AWS CloudFront. Key metrics: cache hit rate, edge POP locations, TTL.

**Circuit Breaker** — A resilience pattern that monitors failures to an external service. After a threshold of failures, the circuit "trips" (opens), and subsequent calls fail fast without hitting the failing service. After a cooldown, it allows a test call (half-open) to check if the service has recovered.

**Cloud-Native** — An approach to building and running applications that exploits the advantages of the cloud computing delivery model: microservices, containers, dynamic orchestration, declarive APIs.

**Cluster** — A group of machines working together as a single system, sharing load and providing failover. See also Sharding, Replication.

**Collision (Hash)** — When two different inputs produce the same hash output. In hash tables, collisions are resolved via chaining (linked lists at each bucket) or open addressing (probing for the next free slot).

**Consistent Hashing** — A distributed hashing scheme where adding or removing a node only requires remapping ~K/N keys (not all keys). Maps both keys and nodes onto a circular hash space (ring). Used in DynamoDB, Cassandra, Memcached. See also Virtual Nodes.

**CRDT (Conflict-free Replicated Data Type)** — A data structure that can be replicated across nodes, updated independently and concurrently, and merged without conflicts. Used in collaborative editors (Google Docs, Figma) and distributed counters. Examples: G-Counter, OR-Set, LWW-Register.

**CQRS (Command Query Responsibility Segregation)** — An architectural pattern that separates read operations (queries) from write operations (commands), often using different data models or even different databases for each. Enables independent scaling of reads and writes.

---

## D

**Data Partitioning** — See Sharding.

**Data Skew** — Uneven distribution of data across partitions, where some partitions hold significantly more data or receive more traffic than others. Causes hotspots. Mitigated by better partition keys, salting, or consistent hashing with virtual nodes.

**Debounce** — A technique that delays processing until a specified quiet period has passed, collapsing multiple rapid events into one. Used in search-as-you-type, UI input handling. See also Throttle.

**Deduplication** — Eliminating duplicate data or requests. In messaging, preventing the same message from being processed twice. In storage, storing one copy of repeated data blocks.

**Distributed Cache** — A caching layer shared across multiple application instances, providing fast reads and reducing database load. Examples: Redis (primary-store), Memcached (cache-only). See also Cache Hit Rate, Eviction Policy.

**Distributed Lock** — A mutual exclusion mechanism across multiple machines. Ensures only one process can access a resource at a time in a distributed system. Implementations: Redis Redlock, ZooKeeper, etcd. Must handle lock expiry, node crashes, and clock drift.

**Distributed Transaction** — A transaction that spans multiple services or databases. Ensuring ACID properties across distributed components is expensive. Approaches: Two-Phase Commit (2PC), Saga Pattern, eventual consistency.

**DynamoDB** — Amazon's managed NoSQL database. Uses consistent hashing for partitioning, tunable consistency (eventual or strong), and automatic scaling. A canonical example of an AP system in CAP theorem terms.

---

## E

**Edge Computing** — Processing data at or near the source of data generation (the "edge" of the network) rather than in a centralized cloud. Reduces latency for real-time applications and reduces bandwidth costs.

**Event Sourcing** — An architectural pattern where state changes are stored as an immutable sequence of events. Current state is derived by replaying events. Enables audit trails, time-travel queries, and event replay. See also CQRS.

**Eventual Consistency** — A consistency model where, given no new updates, all replicas will eventually converge to the same value. Prioritizes availability over immediate consistency. Contrast with Strong Consistency.

**Eviction Policy** — The rule determining which cache entries to remove when the cache is full. Common policies: LRU (Least Recently Used), LFU (Least Frequently Used), FIFO (First In First Out), TTL-based.

---

## F

**Failover** — Automatically switching to a redundant or standby system when the primary fails. Can be active-passive (standby takes over) or active-active (both serve traffic, one absorbs the other's load on failure).

**Fan-Out** — A pattern where a single request or event triggers multiple downstream operations in parallel. Example: Twitter's fan-out-on-write, where a tweet is pushed to all followers' timelines simultaneously. See also Fan-In.

**Fault Tolerance** — A system's ability to continue operating correctly after component failures. Achieved through redundancy, replication, health checks, and graceful degradation.

**Feature Store** — A centralized repository for ML features — serving pre-computed features to online models (low-latency) and storing them for offline training (high-throughput). Ensures consistency between training and serving. Examples: Feast, Tecton.

**Follower (Database)** — A read replica that replicates changes from a primary/leader database. Handles read traffic, cannot accept writes. See also Primary, Replication.

---

## G

**Gossip Protocol** — A decentralized communication protocol where nodes periodically share state information with random peers. Information spreads through the cluster like an epidemic. Used for cluster membership, failure detection, and topology discovery. Used in Cassandra, Consul, DynamoDB.

**Granularity** — The level of detail or scope of a component, lock, cache entry, or metric. Fine-grained = more specific, more overhead. Coarse-grained = broader, less overhead but more contention.

**GPT (Generative Pre-trained Transformer)** — A class of large language models that generate text by predicting the next token in a sequence. The architecture is a decoder-only transformer. Used in ChatGPT and similar systems.

**Gradient** — In ML, the direction and magnitude of steepest increase of a loss function. Gradient descent updates model parameters in the negative gradient direction to minimize loss. Gradients are computed via backpropagation.

---

## H

**Hash Ring** — The circular hash space used in consistent hashing. Both nodes and keys are mapped to positions on this ring. A key is assigned to the first node found by walking clockwise from the key's position.

**Hash Table** — A data structure providing O(1) average-time insert, delete, and lookup by mapping keys to array indices via a hash function. Collisions are resolved by chaining or open addressing. The foundation of dictionaries, maps, and sets.

**Hashing** — Applying a function that maps data of arbitrary size to fixed-size values. Used in hash tables, checksums, partitioning, and content addressing. Properties: deterministic, uniform distribution, fast computation.

**Hotspot** — A node, partition, cache entry, or key that receives a disproportionately large share of traffic or data. Causes performance bottlenecks. Mitigated by load balancing, sharding, salting, and consistent hashing with virtual nodes.

**HNSW (Hierarchical Navigable Small World)** — A graph-based approximate nearest neighbor algorithm used in vector databases. Builds a multi-layer graph where higher layers have fewer nodes for coarse search, and lower layers have all nodes for fine search. Provides fast search with high recall.

**HTTP/2** — A major revision of the HTTP protocol. Features: multiplexing (multiple requests over one connection), header compression (HPACK), server push, binary framing. Reduces latency compared to HTTP/1.1.

**HTTP/3 (QUIC)** — The next HTTP version, running over QUIC (UDP-based). Features: zero-round-trip connection setup, no head-of-line blocking, connection migration. Used by Google, Cloudflare.

---

## I

**Idempotency** — A property where performing an operation multiple times has the same effect as performing it once. Critical for reliable APIs: if a client retries a payment due to a timeout, the system should not charge twice. Implemented via idempotency keys.

**Idempotency Key** — A unique identifier (usually a UUID) sent by the client with a request. The server stores the key and the response for a TTL period. On retry with the same key, the server returns the stored response instead of re-executing.

**Index (Database)** — A data structure that improves the speed of data retrieval at the cost of additional writes and storage. The most common type is a B-tree index. Without an index, the database must scan every row (sequential scan).

**Inverted Index** — The core data structure of search engines. Maps each term to the list of documents that contain it. Enables fast full-text search. Used in Elasticsearch, Lucene, Google Search.

**IOPS (Input/Output Operations Per Second)** — A measure of storage device performance. HDDs: ~100 IOPS, SSDs: ~10,000-100,000 IOPS, NVMe: ~100,000+ IOPS. Critical for database and cache performance.

---

## J-K

**JSON (JavaScript Object Notation)** — A lightweight data-interchange format. Human-readable, machine-parseable. The de facto standard for REST APIs.

**Kafka** — A distributed event streaming platform. Organizes messages into topics, partitioned for parallelism, replicated for durability. Producers write to topics, consumers read from them. Used for messaging, event sourcing, log aggregation, stream processing.

**Key-Value Store** — A type of NoSQL database where data is stored as key-value pairs. Values can be anything (blob, JSON, structured data). Examples: Redis, DynamoDB, Riak. Optimized for simple lookups by key.

**KV Cache** — In LLM serving, a cache of the key and value tensors from the attention mechanism for previously generated tokens. Avoids recomputing attention over the full context for each new token. Major memory consumer in LLM inference. Quantization and paged attention (vLLM) optimize KV cache usage.

---

## L

**Lag (Replication)** — The delay between a write on the primary and that write being visible on a replica. In asynchronous replication, lag can range from milliseconds to seconds. High lag causes stale reads.

**Latency** — The time from initiating a request to receiving the response. Measured at percentiles: p50 (median), p95, p99, p99.9. p99 latency is the experience of the slowest 1% of users — a key SLO metric.

**Leader Election** — The process by which nodes in a distributed cluster choose one node as the coordinator (leader). The leader handles writes, coordination, or primary responsibilities. Algorithms: Raft, Paxos, Bully. If the leader fails, a new one is elected.

**LLM (Large Language Model)** — A neural network model trained on vast amounts of text to generate and understand human language. Examples: GPT-4, Llama, Claude. Architecture: transformer (decoder-only for generation). Served via inference engines like vLLM, TGI.

**Load Balancer** — A component that distributes incoming requests across multiple servers. Algorithms: round-robin, least connections, consistent hashing, weighted, IP hash. Types: L4 (transport layer, e.g., TCP), L7 (application layer, e.g., HTTP). Examples: NGINX, HAProxy, AWS ALB.

**LoRA (Low-Rank Adaptation)** — A parameter-efficient fine-tuning technique for LLMs. Instead of updating all model weights, it trains small low-rank matrices (A and B) that are added to the frozen base weights. Reduces trainable parameters by ~99% with minimal quality loss.

**LRU (Least Recently Used)** — A cache eviction policy that removes the item that was accessed least recently. The most common eviction policy. Implemented with a hash map + doubly linked list for O(1) operations.

**LWW-Register (Last-Writer-Wins Register)** — A CRDT where the value with the highest timestamp wins on conflict resolution. Simple but can lose updates if clocks are skewed or events are concurrent.

---

## M

**MapReduce** — A programming model for processing large datasets in parallel. Map: transform each record independently. Reduce: aggregate results by key. Pioneered by Google. Largely superseded by stream processing (Flink, Spark).

**Merkle Tree** — A tree where each leaf node is a hash of a data block, and each internal node is a hash of its children. Enables efficient verification of large data structures. Used in Git, Bitcoin, Cassandra (anti-entropy repair).

**Microservices** — An architectural style where an application is composed of small, independently deployable services, each owning its own data and communicating via APIs (usually REST or gRPC). Contrast with Monolith.

**Modulo Hashing** — A partitioning scheme: `node = hash(key) % N`. Simple but causes ~all keys to be remapped when N changes. Replaced by consistent hashing in most production systems.

**Monolith** — An architectural style where the entire application is a single deployable unit. Simpler to build and operate but harder to scale independently. Many systems start as monoliths and evolve to microservices.

**MSE (Mean Squared Error)** — A common loss function in ML: the average of squared differences between predictions and actual values. Used in regression tasks. Sensitive to outliers due to squaring.

**Multi-Agent System** — A system where multiple AI agents collaborate to solve complex tasks. Each agent has a role, uses tools, and communicates with others. Patterns: planning, routing, tool-use, memory. See also Multi-Agent Orchestration.

---

## N

**NoSQL** — A class of databases that don't use the traditional relational table model. Types: key-value (Redis), document (MongoDB), column-family (Cassandra), graph (Neo4j), vector (Milvus, Pinecone). Chosen for horizontal scalability, flexible schemas, or specialized access patterns.

**Node** — An individual machine or process in a distributed system. See also Cluster, Replica, Leader, Follower.

**Normalization** — The process of organizing database tables to reduce redundancy and dependency. Normal forms (1NF, 2NF, 3NF, BCNF). Trades write efficiency for storage efficiency and consistency. Contrast with Denormalization.

**N+1 Query Problem** — An anti-pattern where fetching a list of entities and their related data results in N+1 database queries (1 for the list, N for each related item). Fixed by JOINs, eager loading, or batch fetching.

---

## O

**OAuth 2.0** — An authorization framework that allows third-party applications to obtain limited access to a user's account without sharing credentials. Uses access tokens and refresh tokens. Flows: Authorization Code, Client Credentials, PKCE.

**Open Addressing** — A hash table collision resolution strategy where colliding items are placed in the next available slot (probing). Variants: linear probing, quadratic probing, double hashing. Contrast with Chaining.

**OLAP (Online Analytical Processing)** — A workload characterized by complex queries aggregating large amounts of historical data. Examples: data warehouses, analytics dashboards. Contrast with OLTP.

**OLTP (Online Transaction Processing)** — A workload characterized by many short, read-write transactions. Examples: e-commerce checkout, banking transfers. Requires low latency and high consistency. Contrast with OLAP.

---

## P

**P99 Latency** — The latency experienced by the 99th percentile of requests — only 1% of requests are slower. A more meaningful metric than average for understanding worst-case user experience. Also: p50 (median), p95, p99.9.

**Pagefind** — A static-site full-text search library that indexes built HTML pages at build time. No backend required. Used in this notes site project.

**Partition (Database)** — See Sharding.

**Partition Tolerance** — The ability of a distributed system to continue operating despite network partitions (communication failures between nodes). One of the three CAP theorem guarantees. Since partitions are inevitable in real networks, this is typically non-negotiable.

**Paxos** — A consensus algorithm for reaching agreement among distributed nodes in the presence of failures. Proven correct but notoriously difficult to understand and implement. See also Raft, Consensus.

**Pinned Connection** — A database or HTTP connection that is kept open and reused across requests, avoiding the overhead of establishing a new connection each time. See also Connection Pool.

**Primary Key** — A column or set of columns that uniquely identifies each row in a database table. Automatically indexed. Must be non-null and unique.

**Proxy** — An intermediary that forwards requests between clients and servers. Forward proxy: sits between client and internet (VPN, corporate proxy). Reverse proxy: sits between internet and servers (load balancer, CDN edge). See also Load Balancer.

---

## Q

**QPS (Queries Per Second)** — A measure of request throughput. Similar to RPS (Requests Per Second). Used to size infrastructure and set rate limits.

**Quantization (Model)** — Reducing the precision of model weights (e.g., FP16 → INT8 → INT4) to reduce memory and speed up inference with minimal quality loss. Techniques: GPTQ, AWQ, GGUF. Reduces a 7B model from ~14GB (FP16) to ~4GB (INT4).

**Queue** — A FIFO (First-In-First-Out) data structure. In distributed systems, a buffer that decouples producers from consumers. See also Message Queue, Kafka.

**Quorum** — The minimum number of nodes that must participate in a distributed operation for it to be considered valid. For a cluster of N nodes with F failures tolerated, quorum = F + 1. Common: majority quorum = floor(N/2) + 1. See also Raft, Consensus.

---

## R

**Raft** — A consensus algorithm designed for understandability (easier than Paxos). Elects a leader, replicates a log via heartbeats, and guarantees safety under network partitions. Used in etcd, Consul, CockroachDB. See also Leader Election, Consensus.

**Rate Limiting** — Controlling the rate of incoming requests to protect a service from overload or abuse. Algorithms: Token Bucket, Leaky Bucket, Fixed Window, Sliding Window Log, Sliding Window Counter. Enforced at API gateway, load balancer, or application level.

**RAG (Retrieval-Augmented Generation)** — A technique that enhances LLM responses by retrieving relevant documents from a knowledge base and providing them as context. Pipeline: chunk documents → embed chunks → store in vector DB → retrieve top-k → feed to LLM. Reduces hallucination and enables domain-specific knowledge.

**Read Replica** — See Follower.

**Redis** — An in-memory data structure store used as a distributed cache, message broker, and session store. Supports strings, hashes, lists, sets, sorted sets, streams, and pub/sub. Single-threaded (mostly), which eliminates contention but limits throughput to one CPU core.

**Replication** — Copying data from a primary database to one or more replicas for read scaling, fault tolerance, and geographic distribution. Types: synchronous, asynchronous, semi-synchronous. See also Follower, Primary.

**RPS (Requests Per Second)** — See QPS.

**Reranking** — In RAG, a second-stage process that re-scores retrieved documents using a more powerful model (e.g., a cross-encoder) to improve the relevance ordering. First stage (vector search) prioritizes speed; second stage (reranking) prioritizes precision.

**Reverse Index** — See Inverted Index.

---

## S

**Saga Pattern** — A pattern for managing distributed transactions as a sequence of local transactions, each with a compensating action for rollback. If step 3 fails, compensating actions for steps 1-2 are executed. Avoids the blocking and fragility of Two-Phase Commit.

**Scalability** — A system's ability to handle increased load by adding resources. Vertical scaling (scale up): more CPU/RAM on one machine. Horizontal scaling (scale out): more machines. Horizontal is generally preferred for distributed systems.

**Sequence Number** — A monotonically increasing number assigned to events, messages, or log entries. Used for ordering, deduplication, and conflict resolution. Can be generated centrally (e.g., ZooKeeper) or via logical clocks (Lamport timestamps, vector clocks).

**Service Mesh** — An infrastructure layer that handles service-to-service communication via sidecar proxies. Provides mTLS, traffic management, observability, and retry/circuit breaking without application code changes. Examples: Istio, Linkerd.

**Sharding** — Splitting a large dataset into smaller partitions (shards) distributed across multiple machines, each handling a subset of data. Strategies: range-based, hash-based, consistent hashing, directory-based. Essential for horizontal scaling of databases.

**Shard Key** — The column or field used to determine which shard a row/document belongs to. Choosing a good shard key is critical: it should distribute data evenly and support common query patterns. Poor shard keys cause hotspots and cross-shard queries.

**Skip List** — A probabilistic data structure that allows fast search, insertion, and deletion in O(log n) average time. Used in Redis (sorted sets) and MemSQL. An alternative to balanced trees with simpler implementation.

**Sliding Window (Algorithm)** — A coding interview pattern that converts nested O(n^2) loops over contiguous subarrays/substrings into a single O(n) pass by maintaining a running window state. Two flavors: fixed-size and variable-size.

**SLO (Service Level Objective)** — A target for a service's reliability, e.g., "p99 latency < 200ms" or "99.9% availability." More specific than an SLA (the legal contract). SLOs guide engineering decisions about capacity and resilience.

**Stale Read** — A read that returns outdated data because the replica hasn't yet received the latest write from the primary. Common in asynchronous replication. Mitigated by read-after-write consistency or reading from the primary.

**Strong Consistency** — A consistency model where every read returns the most recent write. After a write completes, all subsequent reads (from any replica) see the new value. Expensive to achieve in distributed systems. Contrast with Eventual Consistency.

**Synchronous Replication** — A replication mode where the primary waits for replicas to confirm a write before acknowledging it to the client. Guarantees strong consistency but increases write latency. See also Asynchronous Replication.

---

## T

**Throughput** — The number of operations (requests, messages, transactions) a system processes per unit of time. Contrast with Latency (time per operation). A system can have high throughput but high latency (batch processing) or low throughput but low latency (real-time).

**Time Complexity** — A function describing how the runtime of an algorithm grows with input size n. Common complexities (best to worst): O(1), O(log n), O(n), O(n log n), O(n^2), O(2^n), O(n!). See also Big O Notation.

**Token Bucket** — A rate limiting algorithm. Tokens are added to a bucket at a fixed rate. Each request consumes one token. If the bucket is empty, the request is rejected. Allows bursts up to the bucket capacity. See also Leaky Bucket.

**Trie** — A tree data structure for storing strings, where each node represents a character. Shared prefixes share nodes. Supports prefix search, autocomplete, and dictionary lookups in O(L) time where L is the string length. Also called a prefix tree.

**TTL (Time To Live)** — A lifespan assigned to a cache entry, DNS record, or message. After the TTL expires, the entry is evicted or considered stale. Used in Redis, CDN caching, DNS resolution, and session management.

**Two-Phase Commit (2PC)** — A distributed transaction protocol. Phase 1 (Prepare): coordinator asks all participants to prepare. Phase 2 (Commit/Abort): if all prepared, coordinator tells them to commit; if any didn't, abort. Blocking and slow. See also Saga, Consensus.

---

## U

**Upsert** — An operation that inserts a new row if it doesn't exist, or updates it if it does. Combines UPDATE and INSERT. Supported by most databases (`INSERT ... ON CONFLICT UPDATE` in PostgreSQL, `MERGE` in Oracle).

**URL Shortener** — A service that maps long URLs to short, memorable codes. Canonical interview question for system design. Key concepts: base62 encoding, read-write asymmetry, CDN caching, analytics.

---

## V

**Vector Database** — A database optimized for storing and querying high-dimensional vectors (embeddings). Core operation: approximate nearest neighbor (ANN) search. Examples: Milvus, Pinecone, Weaviate, Qdrant. Used in RAG, semantic search, recommendation systems.

**Vector Embedding** — A numerical representation of text, images, or audio as a vector in high-dimensional space. Semantically similar items have vectors close together. Generated by embedding models (e.g., text-embedding-3-small, BGE). The foundation of semantic search and RAG.

**Virtual Node (VNode)** — In consistent hashing, a technique where each physical node is mapped to multiple positions on the hash ring. Improves key distribution uniformity and reduces hotspots. Typical: 100-200 virtual nodes per physical node.

**vLLM** — A high-throughput LLM inference engine. Key innovation: PagedAttention (manages KV cache like virtual memory with paging), reducing memory waste and enabling larger batch sizes. Supports continuous batching and quantization.

---

## W

**Warm Cache** — A cache that has been populated with frequently accessed data and is serving a high hit rate. A "cold" cache is empty or newly created and has a low hit rate. Warming a cache after deployment is a common operational task.

**WebSocket** — A full-duplex communication protocol over a single TCP connection. Unlike HTTP (request-response), WebSocket allows the server to push data to the client without a request. Used in chat systems, live notifications, real-time dashboards.

**Write-Ahead Log (WAL)** — A durability technique where changes are written to an append-only log before being applied to the main data structure. On crash recovery, the log is replayed to restore state. Used in PostgreSQL, Redis (AOF), Kafka.

**Write-Through Cache** — A caching strategy where writes go to both the cache and the backing store simultaneously. Ensures cache consistency but adds write latency. Contrast with Write-Back (write to cache, asynchronously to store) and Write-Around (write to store, cache on read).

---

## X-Y-Z

**ZooKeeper** — A centralized coordination service for distributed systems. Provides configuration management, leader election, distributed locks, and service discovery. Uses a hierarchical key-value store (znodes) with strong consistency via ZAB consensus.

**ZAB (ZooKeeper Atomic Broadcast)** — The consensus protocol used by ZooKeeper. Similar to Raft: leader-based, crash-recovery, total order broadcast. Ensures all updates are applied in the same order on all replicas.

---

## Coding Interview — Data Structures & Algorithms

**Big O Notation** — A mathematical notation describing the upper bound of an algorithm's time or space complexity as input size grows. Focuses on dominant terms and ignores constants. O(n log n) is the theoretical lower bound for comparison-based sorting.

**Binary Search** — An O(log n) search algorithm for sorted arrays. Repeatedly divides the search interval in half. Requires sorted data. Variants: find exact match, find first/last occurrence, find insertion point.

**BFS (Breadth-First Search)** — A graph/tree traversal that explores all nodes at the current depth before moving deeper. Uses a queue. Finds shortest path in unweighted graphs. O(V + E).

**DFS (Depth-First Search)** — A graph/tree traversal that explores as deep as possible before backtracking. Uses a stack or recursion. Useful for cycle detection, topological sort, connected components. O(V + E).

**Deque (Double-Ended Queue)** — A data structure supporting insert and delete at both ends in O(1). Implemented as a doubly-linked list or circular array. Used in sliding window maximum (monotonic deque), BFS.

**Dynamic Programming** — An optimization technique that solves problems by breaking them into overlapping subproblems, solving each once, and storing results (memoization or tabulation). Identifiable when a problem has optimal substructure and overlapping subproblems.

**Greedy Algorithm** — An algorithm that makes the locally optimal choice at each step, hoping to reach a global optimum. Works when the problem has the greedy-choice property. Examples: Huffman coding, Dijkstra's, interval scheduling. Not always optimal.

**Heap** — A complete binary tree where each node is ≥ (max-heap) or ≤ (min-heap) its children. Supports insert and extract-min/max in O(log n). Implemented as an array. Used for priority queues, top-k problems, heap sort.

**Monotonic Stack/Deque** — A stack or deque where elements are maintained in sorted order (increasing or decreasing). Used to efficiently find the next greater/smaller element or maintain the max/min in a sliding window.

**Recursion** — A function that calls itself. Every recursive solution can be converted to an iterative one using an explicit stack. Base case (stopping condition) is essential to prevent infinite recursion. Risk: stack overflow for deep recursion.

**Topological Sort** — An ordering of vertices in a directed acyclic graph (DAG) such that for every edge (u, v), u comes before v. Computed via DFS or BFS (Kahn's algorithm). Used for task scheduling, build dependency resolution.

**Two Pointers** — A technique using two indices that move through an array (same direction or opposite directions) to solve problems in O(n) time. Used for sorted two-sum, partitioning, palindrome checking.

---

## Capacity Planning Terms

**Availability** — The percentage of time a system is operational and accessible. Calculated as uptime / (uptime + downtime). 99.9% = ~8.76 hours downtime/year. 99.99% = ~52.6 minutes/year. Each "9" is exponentially harder.

**Bandwidth** — The maximum rate of data transfer across a network path, measured in bits per second (bps, Kbps, Mbps, Gbps). Affects how much data can be served and how quickly.

**Bottleneck** — The component that limits overall system performance. Improving non-bottleneck components doesn't help. Identifying and fixing the bottleneck is the key to effective optimization (Theory of Constraints).

**Peak-to-Average Ratio** — The ratio of peak traffic to average traffic. Used in capacity planning to size for worst-case load. Typical web systems: 2-5x. Retail/holiday: 10x+. Must size infrastructure for peak, not average.

**Storage Estimation** — Calculating how much disk space a system will need over time. Per-record size × growth rate × retention period. Must include indexes, replicas, and overhead (typically 1.5-2x raw data size).

---

## How To Use This Glossary

1. **While reading an article**: If you encounter an unfamiliar term, search this page (Ctrl+F / Cmd+F) for it.
2. **While revising**: Skim a category to refresh your memory on key concepts.
3. **Before an interview**: Read through terms you're less confident about — each definition is interview-ready.

> This glossary is a living document. As new articles are added and new terms are introduced, this page is updated. If a term is missing, check the article's context first — if it's still unclear, add it here.
