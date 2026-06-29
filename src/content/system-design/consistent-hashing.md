---
title: "Consistent Hashing"
category: "Scale"
day: 10
difficulty: "intermediate"
read_time: 14
listen_time: 20
tags: [system-design, distributed-systems, hashing, caching, interview]
last_updated: "2026-06-19"
---

# Consistent Hashing

## Summary & Interview Framing

A distributed hashing scheme that minimizes data movement when nodes join or leave — only K/N keys are remapped instead of all keys. It maps both keys and nodes onto a circular hash ring, assigning each key to the first node clockwise from its position, and uses virtual nodes to balance load distribution.

**How it's asked:** "Design a consistent hashing ring for a cache cluster of 100 nodes. Handle virtual nodes, hotspots, and node addition/removal with minimal data movement."

## Overview

Consistent hashing is a distributed hashing scheme that addresses a fundamental problem in distributed systems: when you add or remove servers from a cluster, how do you minimize the amount of data that needs to be moved between nodes? Traditional hash-based partitioning (like `hash(key) % N`) requires remapping nearly all keys when N changes, because the modulo operation produces an entirely different distribution. Consistent hashing solves this by ensuring that, on average, only `K/N` keys need to be remapped when a node joins or leaves — where K is the total number of keys and N is the number of nodes.

The technique was originally introduced by David Karger and his colleagues at MIT in 1997, in a paper titled "Consistent Hashing and Random Trees." It was designed to solve the caching locality problem in distributed web caches, but it has since become one of the most important building blocks in distributed systems engineering. It is used in production by Cassandra, DynamoDB, Memcached, Akamai's CDN, Discord's chat infrastructure, and countless other systems where data needs to be partitioned across a dynamic set of nodes.

The core insight is elegant: instead of mapping keys directly to nodes using modulo arithmetic, you map both keys and nodes onto the same circular hash space (a "ring"). Each key is assigned to the first node that appears clockwise from the key's position on the ring. When a node is added or removed, only the keys that were mapped to that node (or would be mapped to the new node) need to be relocated — everything else stays put.

## The Problem with Modulo Hashing

To understand why consistent hashing matters, consider a simple caching cluster with 4 nodes. Using `hash(key) % 4`, each node handles roughly 25% of the keys. Now suppose traffic grows and you add a 5th node. The new hash function is `hash(key) % 5`. Almost every key will now map to a different node than before, meaning nearly 100% of your cached data is now in the wrong place. Cache hit rates plummet to near zero, your origin servers get hammered, and the system takes a long time to recover as cache gradually warms up again.

This problem gets worse at scale. If you have 1000 nodes and add one more, modulo hashing would invalidate ~99.9% of all key-to-node mappings. In a system serving millions of requests per second, this is catastrophic. Consistent hashing, by contrast, would require moving only ~0.1% of keys — the ones that fall in the new node's segment of the ring.

## How Consistent Hashing Works

### The Hash Ring

Imagine a ring with hash values ranging from 0 to 2^32 - 1 (for a 32-bit hash function). Both nodes and keys are hashed onto this ring using the same hash function. A node's position on the ring is determined by hashing its identifier (IP address, node name, etc.). A key's position is determined by hashing the key itself.

To determine which node is responsible for a given key, you start at the key's position on the ring and walk clockwise until you encounter the first node. That node owns the key. If you reach the end of the ring (2^32 - 1), you wrap around to 0 and continue — hence the "ring" metaphor.

```
                       0
                     ╱   ╲
                  ╱         ╲
               ╱               ╲
           ● N1                   ● N2
        (h=100)                (h=450)
             │                     │
         ○ keyA                 ○ keyC
        (h=250)               (h=500)
             │                     │
           ● N4 ────────────── ● N3
        (h=850)                (h=700)
                     2^32-1

  Clockwise traversal (→):
    0 ──→ N1 ──→ keyA ──→ N2 ──→ keyC ──→ N3 ──→ N4 ──→ (wrap to 0)

  keyA's owner = N2   (first node clockwise from keyA)
  keyC's owner = N3   (first node clockwise from keyC)
```

This simple rule has a powerful property: when a node is added, it only takes over responsibility for keys that fall between it and the previous node clockwise. When a node is removed, its keys are absorbed by the next node clockwise. No other node-to-key assignments change.

### Adding a Node

When a new node N is added to the ring, it is hashed to some position. It immediately takes ownership of all keys that fall in the arc between its position and the position of the node that previously owned those keys (the node counter-clockwise from N). The node that previously owned those keys must transfer them to N, but no other node in the ring is affected. The number of keys transferred is, on average, `K/N` — the total keys divided by the total nodes.

```
  ═══ BEFORE (3 nodes) ═══════════════════════ AFTER (+ N4) ═══

         0                                      0
       ╱   ╲                                  ╱   ╲
    ● N1     ● N2                          ● N1     ● N2
    ╲         ╲                            ╲    ●N4   ╲
     ● N3 ────╱                             ● N3 ─────╱
     2^32-1                                  2^32-1
                                            N4 lands at h≈250

  key1 (h=120) → N2                         key1 (h=120) → N2   ✓ unchanged
  key2 (h=300) → N3                         key2 (h=300) → N3   ✓ unchanged
  key3 (h=700) → N1                         key3 (h=700) → N1   ✓ unchanged

  ★ Only keys in the arc (N4 ... N2] move:  N2 hands them → N4
  ★ Every other key stays exactly where it was.
  ★ Avg keys moved = K/N.
```

### Removing a Node

When a node is removed, its keys are simply reassigned to the next node clockwise on the ring. Again, only the keys that were owned by the removed node are affected. Every other key stays exactly where it was.

```
  ═══ BEFORE (4 nodes) ═══════════════════════ AFTER (− N4) ═══

         0                                      0
       ╱   ╲                                  ╱   ╲
    ● N1     ● N2                          ● N1     ● N2
    ╲    ●N4   ╲                            ╲         ╲
     ● N3 ─────╱                             ● N3 ─────╱
     2^32-1                                  2^32-1

  N4's keys → reassigned to N1  (next node clockwise from N4)
  All other keys: untouched
```

## The Hotspot Problem and Virtual Nodes

### The Problem

In a basic consistent hashing ring with a small number of nodes, the distribution of keys can be uneven. This happens because the hash function places nodes at random positions on the ring, and with few nodes, some nodes may end up with much larger arcs than others. A node with a large arc receives a disproportionately large share of keys and becomes a hotspot.

For example, with 3 nodes placed at positions 100, 200, and 800 on a ring of 1000, the node at 200 owns the arc from 200 to 800 — 60% of the ring — while the node at 800 owns only 20%. This is clearly unbalanced.

### The Solution: Virtual Nodes (VNodes)

The standard solution is to place each physical node on the ring multiple times using "virtual nodes" or "replicas." Instead of hashing a node once, you hash it M times using different identifiers (e.g., `hash(node1-0)`, `hash(node1-1)`, ..., `hash(node1-M-1)`). Each virtual node acts as an independent point on the ring, but they all map back to the same physical node.

With a large number of virtual nodes (typically 100-200 per physical node), the key distribution becomes approximately uniform. The probability that any single physical node owns a disproportionate share of the ring drops dramatically. When a physical node joins or leaves, its virtual nodes are spread across the ring, so the load is redistributed evenly among all remaining nodes rather than dumping everything onto a single neighbor.

```
  ═══ WITHOUT vnodes (3 nodes — UNEVEN) ═══

         0
       ╱   ╲
    ● N1(h=100) ─── ● N2(h=200) ─── ● N3(h=800)
       ╲              ╲               ╱
        ╲      N2 owns arc 200→800    ╱
         ╲      = 60% of ring!  ◆HOT  ╱
          ╲                        ╱
           └──── N3 owns only 20% ──┘

  ═══ WITH vnodes (3 physical × 4 vnodes = 12 points) ═══

         0
    ●N1ₐ  ●N1ᵦ  ●N2ₐ   ●N3ᵦ
       ●N3ₐ    ●N1ᵧ      ●N2ᵦ
    ●N2ᵧ   ●N1ᵨ  ●N3ᵧ    ●N1ₑ
       ●N3ᵨ   ●N2ₑ  ●N1ₑ  ●N3ₑ
         2^32-1

  Each physical node's 4 vnodes are scattered around the ring.
  → Arcs owned per physical node are roughly equal.
  → Load is uniform. No hotspots.
  → When a physical node leaves, its 4 vnodes vanish and the
    freed arcs are absorbed by vnodes of MANY different nodes
    (not just one neighbor).
```

Cassandra uses 256 virtual nodes per physical node by default. DynamoDB uses a similar approach. The trade-off is memory: more virtual nodes means more metadata to store and exchange, but the amount is trivial compared to the data itself.

## Implementation Details

### Hash Function Selection

The choice of hash function matters. You want a function that distributes values uniformly across the ring. Common choices include:

- **MurmurHash3** — Fast, non-cryptographic, uniform distribution. The most popular choice for consistent hashing.
- **FNV-1a** — Simple and fast, slightly less uniform than MurmurHash.
- **MD5/SHA-1** — Cryptographic hashes work but are overkill and slower. Some systems use them because they're already available.
- **xxHash** — Extremely fast, excellent distribution. Increasingly popular in modern systems.

Avoid using Java's `hashCode()` directly — it has poor distribution for consistent hashing because it produces clustered values for similar inputs.

### Ring Lookup: Binary Search

In a production system, you maintain a sorted array of all node positions on the ring. To find the owner of a key, you hash the key, then binary search the sorted array for the first node position greater than or equal to the key's hash (wrapping around if needed). This gives O(log N) lookup where N is the number of virtual nodes. With 100 physical nodes and 200 vnodes each, that's 20,000 entries — a binary search over this takes about 14 comparisons, which is negligible.

### Java Implementation Sketch

```java
public class ConsistentHash<T> {
    private final HashFunction hashFunction;
    private final int numberOfReplicas;
    private final SortedMap<Integer, T> ring = new TreeMap<>();

    public ConsistentHash(HashFunction hashFunction, int numberOfReplicas, Collection<T> nodes) {
        this.hashFunction = hashFunction;
        this.numberOfReplicas = numberOfReplicas;
        for (T node : nodes) {
            add(node);
        }
    }

    public void add(T node) {
        for (int i = 0; i < numberOfReplicas; i++) {
            ring.put(hashFunction.hash(node.toString() + i), node);
        }
    }

    public void remove(T node) {
        for (int i = 0; i < numberOfReplicas; i++) {
            ring.remove(hashFunction.hash(node.toString() + i));
        }
    }

    public T get(Object key) {
        if (ring.isEmpty()) return null;
        int hash = hashFunction.hash(key);
        if (!ring.containsKey(hash)) {
            SortedMap<Integer, T> tailMap = ring.tailMap(hash);
            hash = tailMap.isEmpty() ? ring.firstKey() : tailMap.firstKey();
        }
        return ring.get(hash);
    }
}
```

## Weighted Consistent Hashing

In real-world deployments, not all nodes are equal. You might have a cluster with mixed hardware — some nodes with 64GB RAM and others with 16GB. Standard consistent hashing with equal virtual nodes per physical node would give each node the same share of the ring, which is wrong: the 64GB node should handle 4x more keys than the 16GB node.

Weighted consistent hashing solves this by assigning virtual nodes proportional to the node's capacity. If node A has capacity 4 and node B has capacity 1, you give A 4x more virtual nodes than B. This ensures that the load distribution matches the capacity distribution.

A more sophisticated approach is used by DynamoDB, which uses a "token allocation" strategy where each node is assigned a set of tokens (positions on the ring) based on its capacity, and the system continuously monitors and rebalances if the actual load diverges from the expected distribution.

## Bounded Consistent Hashing

Standard consistent hashing has a subtle issue: when a node joins, it takes keys from only its immediate counter-clockwise neighbor. This means that neighbor bears the entire cost of the transfer. In a large cluster, this can create a temporary load spike on a single node.

Bounded consistent hashing (also called "load-balanced consistent hashing") addresses this by spreading the key transfer across multiple nodes. When a new node joins, instead of taking all its keys from one neighbor, it takes a small portion from each of several nodes. This ensures that no single node experiences a significant load change.

This is particularly important in systems where the "cost" of a key is variable — for example, in a CDN where some objects are much larger than others. If the new node happens to take over a segment containing several large objects, its neighbor could experience significant load. Bounded hashing mitigates this by sampling from multiple segments.

## Rendezvous Hashing (HRW)

Rendezvous hashing, also known as Highest Random Weight (HRW) hashing, is an alternative to consistent hashing that achieves the same properties with a different approach. Instead of placing nodes on a ring, for each key, you compute a hash of the key combined with each node identifier: `weight_i = hash(key, node_i)`. The node with the highest weight wins.

Rendezvous hashing has the same minimal redistribution property as consistent hashing — when a node is added or removed, only the keys that were assigned to that node (or would be assigned to the new node) are affected. However, it has different trade-offs:

- **Lookup** — O(N) per key (compute N hashes and pick the max), compared to O(log N) for consistent hashing with binary search. This makes it slower for large clusters.
- **Memory** — O(1); no ring data structure needed, just the list of nodes.
- **Simplicity** — Much simpler to implement. No virtual nodes, no ring, no sorted array.
- **Uniformity** — Naturally uniform without virtual nodes, because the hash function provides randomness directly.

```
  ═══ CONSISTENT HASHING (ring-based) ═══

         0
       ╱   ╲
    ● N1     ● N2     key → hash(key) → walk ring clockwise
    ╲         ╲       O(log N) lookup · O(V·N) memory
     ● N3 ────╱       Needs vnodes for uniformity
     2^32-1

  ═══ RENDEZVOUS HASHING (weight-based, no ring) ═══

   For key X, compute one weight per node, pick the MAX:

     X ──┬── hash(X, N1) = 0.73
         ├── hash(X, N2) = 0.41
         └── hash(X, N3) = 0.88   ◆ highest → N3 owns X

   O(N) lookup · O(1) memory · no vnodes needed
   Naturally uniform.
```

For small-to-medium clusters (up to ~100 nodes), rendezvous hashing is often preferred for its simplicity. For large clusters (thousands of nodes), consistent hashing with virtual nodes is more efficient due to the O(log N) lookup.

## Real-World Usage

### Apache Cassandra

Cassandra uses consistent hashing with virtual nodes (256 per physical node by default) to distribute data across the cluster. Each node is responsible for a range of token values on the ring. When a node joins, it announces its token ranges, and the nodes that currently own those ranges transfer the relevant data. Cassandra's use of virtual nodes ensures that adding a node redistributes load evenly across all existing nodes, not just one neighbor.

Cassandra also uses consistent hashing for replica placement. The replication factor N determines how many nodes store a copy of each piece of data. The first node clockwise from the key's position is the primary replica, the next N-1 nodes clockwise are the secondary replicas. This ensures that replicas are spread across different racks and data centers when configured properly.

### Amazon DynamoDB

DynamoDB uses consistent hashing internally to partition data across storage nodes. However, DynamoDB hides this complexity from users — you specify a partition key, and DynamoDB handles the distribution. DynamoDB's implementation is more sophisticated than vanilla consistent hashing: it uses a continuous monitoring and rebalancing system that detects hot partitions and splits them across nodes dynamically.

### Memcached

Many Memcached client libraries (like libketama) use consistent hashing to distribute keys across multiple memcached servers. This is critical for caching because when a cache server is added or removed, you want to minimize cache invalidation. With consistent hashing, adding a server only invalidates the keys that move to the new server — the rest of the cache remains intact.

### Discord

Discord uses consistent hashing to distribute chat messages across their backend servers. With millions of concurrent users and hundreds of server nodes, consistent hashing ensures that when servers are added or removed for scaling, only a small fraction of channels need to be migrated to new servers.

## Failure Handling and Replication

Consistent hashing defines where data *should* live, but it doesn't handle node failures directly. In practice, consistent hashing is combined with replication strategies:

1. **Replica placement** — The primary replica is the first node clockwise from the key. Secondary replicas are the next N-1 nodes clockwise. This ensures replicas are on different nodes.
2. **Failure detection** — When a node fails, the nodes that hold replicas of its data detect the failure (via [[Glossary#Gossip Protocol|gossip protocol]] — a decentralized protocol where nodes periodically share state with random peers, heartbeats, or a failure detector like Phi Accrual). The key's next-in-line replica is promoted to primary.
3. **Read repair** — When a read hits a replica that has stale data, the system repairs it by pushing the correct version from the freshest replica. This works hand-in-hand with consistent hashing because the nodes involved are deterministic.
4. **Hinted handoff** — If a write is destined for a node that is temporarily down, another node (the "hint" node) takes the write on behalf of the failed node. When the failed node recovers, the hint node forwards the stored write. The hint node is typically the next node clockwise on the ring — the same node that would take over if the failed node were permanently removed.

## Capacity Planning with Consistent Hashing

When planning capacity for a system using consistent hashing, consider:

- **Cluster size** — With V virtual nodes per physical node and P physical nodes, the ring has V×P entries. Memory for the ring is O(V×P) — negligible compared to data.
- **Rebalancing cost** — Adding or removing a node transfers approximately `data_size / P` of the total data. For a 1TB cluster with 100 nodes, adding a node transfers ~10GB.
- **Heterogeneous clusters** — Use weighted virtual nodes to match capacity. A node with 2x the CPU and memory should get 2x the virtual nodes.
- **Replication overhead** — With replication factor R, each node stores `R × data_size / P` of data. Plan disk capacity accordingly.

## Trade-offs

| Aspect | Consistent Hashing | Modulo Hashing | Rendezvous Hashing |
|--------|-------------------|----------------|-------------------|
| Redistribution on node change | K/N keys | ~K keys (all) | K/N keys |
| Lookup complexity | O(log N) | O(1) | O(N) |
| Memory | O(V×N) | O(1) | O(1) |
| Uniformity | Depends on V | Perfect | Perfect |
| Heterogeneous support | Weighted vnodes | Difficult | Weight-based |
| Implementation complexity | Medium | Simple | Simple |

## Sharp Interview Question

> **"You're building a distributed cache with 50 nodes using consistent hashing with 150 virtual nodes each. You notice that one node is receiving 3x more traffic than the average. What are the possible causes and how do you fix it?"**

### Model Answer

There are three likely causes, each with a different fix:

**1. Skewed key distribution (hot keys):** The problem may not be the hash ring at all — it may be that a small number of keys receive disproportionate traffic. If a specific cache key (e.g., a viral product page) gets 100x the traffic of other keys, whichever node owns that key will be overloaded regardless of ring balance.

- Fix: identify hot keys via monitoring, and either (a) add a caching layer in front of those specific keys (client-side caching), (b) replicate the hot key to multiple nodes using a "hot key replication" strategy, or (c) use request coalescing to batch multiple requests for the same key.

**2. Insufficient virtual nodes:** With 150 vnodes per physical node and 50 nodes, you have 7,500 points on the ring. While this is generally good, it's possible (with bad luck) that one node's vnodes happen to cluster in a high-traffic region.

- Fix: increase the virtual node count to 200-300 per node and redistribute. You can verify this by measuring the actual arc length owned by each node — if the variance is high, more vnodes will help.

**3. Non-uniform hash function:** If your hash function has poor distribution properties (e.g., Java's `String.hashCode()`), keys may cluster in certain ring segments.

- Fix: switch to a known-good hash function like MurmurHash3 or xxHash.

**Diagnostic approach:** First, check if the load imbalance is in requests or storage. If it's request imbalance with uniform storage, it's hot keys. If storage is also imbalanced, it's the ring. Plot the arc lengths owned by each node — if they're roughly equal, the problem is hot keys. If they vary significantly, increase vnodes.

### Common Pitfall

> ❌ "I'd just increase the number of virtual nodes."

While this might help if the issue is ring imbalance, it does nothing for hot keys. Many candidates jump straight to the ring when they hear "consistent hashing" and "uneven load." The first diagnostic step should always be: is the imbalance in storage (ring problem) or in requests (hot key problem)? These require completely different solutions. Fixing the ring when the problem is hot keys will just move the overloaded node from one physical machine to another.

## Key Takeaways

- Consistent hashing minimizes redistribution when nodes are added or removed — only K/N keys move, versus ~K keys with modulo hashing.
- Virtual nodes solve the hotspot problem by spreading each physical node across the ring multiple times, ensuring uniform distribution.
- The ring lookup is O(log N) with binary search over a sorted array of node positions.
- Weighted consistent hashing handles heterogeneous clusters by assigning vnodes proportional to capacity.
- Rendezvous hashing is a simpler alternative for small-to-medium clusters, with O(N) lookup but no ring data structure.
- Real-world systems combine consistent hashing with replication, failure detection, and read repair for production-grade durability.
- The first diagnostic when debugging load imbalance is to distinguish storage imbalance (ring) from request imbalance (hot keys) — they need different fixes.

## Interview Cheat Sheet

**Key Points to Remember:**
- Consistent hashing minimizes data movement when nodes join or leave: only K/N keys move, versus ~K keys with modulo hashing (`hash(key) % N`).
- [[Glossary#Virtual Node (VNode)|Virtual nodes]] (vnodes) solve uneven distribution by placing each physical node on the ring multiple times (typically 100–200); without them, a small cluster will have hotspots.
- Ring lookup is O(log N) via binary search over a sorted array of node positions — fast even with thousands of virtual nodes.
- Rendezvous hashing (HRW) is a simpler alternative for small clusters (O(N) lookup, no ring needed) but doesn't scale to thousands of nodes.
- When debugging load imbalance, first determine whether it's a storage problem (ring imbalance → add vnodes) or a request problem (hot keys → cache/replicate the hot key).

**Common Follow-Up Questions:**
- *How do you handle heterogeneous nodes (different capacities)?* — Use weighted consistent hashing: assign virtual nodes proportional to each node's capacity, so a 4x larger machine gets 4x more vnodes.
- *What happens when a node fails?* — Its keys are absorbed by the next node clockwise. In production, this is combined with [[Glossary#Replication|replication]] (the next N-1 nodes clockwise hold replicas) and hinted handoff for temporary failures.
- *How does this compare to rendezvous hashing?* — Rendezvous hashing is simpler (no ring, no vnodes, naturally uniform) but has O(N) lookup per key, making it better for small clusters and worse for large ones.

**Gotcha:**
- The most common mistake is jumping straight to "increase virtual nodes" when a node is overloaded. If the overload is from a hot *key* (a viral cache entry), no amount of ring rebalancing will help — you're just moving the overloaded node. Always diagnose first: is the imbalance in storage (ring problem) or in requests (hot key problem)?
