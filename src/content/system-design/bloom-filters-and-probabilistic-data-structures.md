---
title: "Bloom Filters & Probabilistic Data Structures"
type: system-design
category: Platform
date: 2026-06-12
tags: [system-design, interview, platform, bloom-filters, probabilistic-data-structures, hyperloglog, count-min-sketch, cuckoo-filter, space-efficiency, false-positives, approximate-counting]
aliases: ["Bloom Filters & Probabilistic Data Structures", "Bloom Filter Architecture", "Probabilistic Data Structures in System Design", "Space-Efficient Approximate Data Structures"]
difficulty: advanced
read_time: 23
listen_time: 32
---

# Bloom Filters & Probabilistic Data Structures

> **Staff-Engineer Focus:** "Use a Bloom filter" is the mid-level answer. Knowing that a Bloom filter trades a small false-positive rate for massive space savings is the senior answer. **Knowing when a Bloom filter is the wrong data structure and reaching for a Cuckoo filter (deletable), a Counting Bloom filter (frequency), or a HyperLogLog (cardinality) instead — that's the staff engineer.** The interview question isn't "explain a Bloom filter." It's: "You're building a URL blocklist for 10 billion URLs. Disk is limited to 4 GB. You need sub-millisecond lookups with zero false negatives. False positives are acceptable at 0.1%. What do you build, and what are the operational failure modes when the blocklist surpasses 12 billion entries?"

---

## Summary & Interview Framing

Space-efficient data structures that trade certainty for memory — a Bloom filter can tell you if an element is definitely NOT in a set, but can only say it's probably in it. Variants include Counting Bloom filters (support deletions), Cuckoo filters (deletable, more space-efficient), HyperLogLog (cardinality estimation), and Count-Min Sketch (frequency estimation).

**How it's asked:** "Design a Bloom filter for a web crawler to check if a URL has been visited, using less than 1GB of memory for 100M URLs with <1% false positive rate."

## 1. What Problem Do Probabilistic Data Structures Solve?

The fundamental tension in distributed systems: **you need to answer membership, frequency, or cardinality questions across massive datasets, but you can't afford to store the full dataset in memory (or sometimes even on disk).**

| Data Structure | Question It Answers | Space per Element | Error Type | Deletable? |
|---------------|-------------------|-------------------|------------|-----------|
| **Bloom Filter** | "Is X in the set?" (membership) | ~1-2 bytes | False positive only (no false negatives) | No (standard) |
| **Counting Bloom Filter** | "Is X in the set? How many times?" | ~4 bytes per counter | False positive (overcount possible) | Yes (decrement) |
| **Cuckoo Filter** | "Is X in the set?" (membership) | ~1-2 bytes | False positive only | Yes |
| **HyperLogLog** | "How many unique elements?" (cardinality) | ~1.5 KB for 2% error (any set size) | Count estimate ±2% | N/A (counting) |
| **Count-Min Sketch** | "What's the frequency of X?" | ~2-5 KB for reasonable error | Overcount only (never undercount) | N/A (counting) |
| **MinHash / SimHash** | "How similar are two sets?" (Jaccard) | ~1-4 KB per sketch | Similarity estimate ±ε | N/A (similarity) |

**The unifying insight:** All of these trade perfect accuracy for massive reductions in space (and often time). In systems where 99.9% accuracy is sufficient and 100% accuracy would require 100× the resources, probabilistic data structures aren't a compromise — they're the correct engineering choice.

### When to Use (and When NOT to Use)

| Scenario | Probabilistic? | Why |
|----------|---------------|-----|
| URL blocklist for 10B URLs | ✅ Bloom/Cuckoo filter | 4 GB Bloom filter vs. 500 GB hash table. 0.1% FP acceptable for blocklist. |
| Payment transaction lookup | ❌ | Can't tolerate false positives. $1M transaction must be found exactly. |
| CDN cache key eviction | ✅ Bloom filter | "Is this object likely in cache?" FP = unnecessary eviction miss (acceptable). |
| Password "already used" check | ✅ Bloom filter | "Have you used this password before?" FP = rejects a safe password (annoying but safe). |
| Unique visitor count (1B events/day) | ✅ HyperLogLog | 1.5 KB memory for cardinality. Exact count would need GBs. |
| Database primary key lookup | ❌ | B-tree or hash index. Cannot tolerate FPs. |
| Crawler "already visited" URL set | ✅ Bloom filter | FP = skip a URL we haven't visited (acceptable). No FN = never re-crawl (guaranteed). |
| Spam filter word frequency | ✅ Count-Min Sketch | "Is this word too frequent in spam?" Overcount is conservative (safe). |

---

## 2. Bloom Filter — The Core Data Structure

### How It Works

A [[Glossary#Bloom Filter|Bloom filter]] is a space-efficient probabilistic set. It uses **k hash functions** and a **bit array of m bits** (all initialized to 0).

```
INSERT "foo":
  h1("foo") = 3  →  set bit[3] = 1
  h2("foo") = 7  →  set bit[7] = 1
  h3("foo") = 12 →  set bit[12] = 1

  Bit array: [0,0,0,1,0,0,0,1,0,0,0,0,1,0,0,0]
              0  1  2  3  4  5  6  7  8  9  10 11 12 13 14 15

INSERT "bar":
  h1("bar") = 3  →  bit[3] already 1 (collision!)
  h2("bar") = 10 →  set bit[10] = 1
  h3("bar") = 14 →  set bit[14] = 1

QUERY "baz":
  h1("baz") = 7  →  bit[7] = 1 ✓
  h2("baz") = 10 →  bit[10] = 1 ✓
  h3("baz") = 14 →  bit[14] = 1 ✓
  → "baz" ∈ set? YES (but it was never inserted — FALSE POSITIVE!)

QUERY "qux":
  h1("qux") = 5  →  bit[5] = 0 ✗
  → "qux" ∈ set? NO (guaranteed — never false negative)
```

**Key guarantee:** If any hash position is 0, the element is DEFINITELY not in the set. If all positions are 1, the element MIGHT be in the set (with a calculable false-positive probability).

### The Math (Interview Essential)

Given:
- **n** = number of elements inserted
- **m** = bit array size
- **k** = number of hash functions

**False-positive probability (after n insertions):**

```
p ≈ (1 - e^(-kn/m))^k
```

**Optimal k (minimizing false-positive rate for given m, n):**

```
k_opt = (m/n) * ln(2) ≈ 0.693 * (m/n)
```

**At k_opt, the false-positive rate simplifies to:**

```
p ≈ (0.6185)^(m/n)
```

**Bits per element (m/n) needed for target false-positive rate p:**

```
m/n = -1.44 * log2(p)
```

| Target FP Rate (p) | m/n (bits per element) | Example: space for 1B elements |
|-------------------|----------------------|-------------------------------|
| 1% (0.01) | 9.6 bits | 1.2 GB |
| 0.1% (0.001) | 14.4 bits | 1.8 GB |
| 0.01% (0.0001) | 19.2 bits | 2.4 GB |
| 0.001% (0.00001) | 24.0 bits | 3.0 GB |
| 1e-6 | 28.8 bits | 3.6 GB |

**The interview takeaway:** A Bloom filter needs only ~10 bits per element for 1% FP rate and ~14 bits per element for 0.1% FP rate. That's roughly 1–2 bytes per element — 100-1000× smaller than storing the elements themselves.

### Capacity Planning — The Critical Operational Concern

A Bloom filter's false-positive rate is calculated for a given capacity `n`. **As you insert beyond the designed capacity, the false-positive rate degrades exponentially:**

```
Elements inserted | Actual FP rate (designed for 1% at n)
------------------|------------------------------------
0.5 × n           | << 1% (under-utilized)
1.0 × n           | 1% (at design point)
1.5 × n           | ~3% (degrading)
2.0 × n           | ~8% (significantly degraded)
3.0 × n           | ~25% (useless)
5.0 × n           | ~60% (basically returns "yes" for everything)
```

**⚠️ This is the #1 operational pitfall.** Teams deploy a Bloom filter designed for n = 1 billion, watch it fill up, and don't re-provision. At n = 1.5 billion, the 1% filter becomes a 3% filter. At n = 3 billion, it becomes a 25% filter — meaning 1 in 4 non-members are returned as members. This silently corrupts the system's behavior.

### Hash Functions — The Implementation Details

You don't need k independent hash functions. Use **double hashing** (Kirsch-Mitzenmacher technique):

```python
# Generate k hash values from just TWO hash functions
h1 = murmur3_128(key)  # First 64 bits
h2 = murmur3_128(key)  # Second 64 bits (or a different seed)

for i in range(k):
    position = (h1 + i * h2) % m
    # Set/check bit[position]
```

This is both faster (only two hash computations) and mathematically equivalent for Bloom filter purposes. Mention this in interviews to demonstrate implementation depth.

### Bloom Filter Implementation Sketch

```python
import mmh3  # MurmurHash3
import bitarray

class BloomFilter:
    def __init__(self, n: int, p: float = 0.01):
        self.n = n                          # Expected elements
        self.p = p                          # Target FP rate
        self.m = int(-n * math.log(p) / (math.log(2)**2))  # Bit array size
        self.k = int((self.m / n) * math.log(2))           # Optimal hash count
        self.bits = bitarray.bitarray(self.m)
        self.bits.setall(0)
        self.count = 0                      # Track actual insertions

    def add(self, key: str):
        h1, h2 = mmh3.hash64(key)  # Two 64-bit hashes
        for i in range(self.k):
            pos = (h1 + i * h2) % self.m
            self.bits[pos] = 1
        self.count += 1

    def contains(self, key: str) -> bool:
        h1, h2 = mmh3.hash64(key)
        for i in range(self.k):
            pos = (h1 + i * h2) % self.m
            if not self.bits[pos]:
                return False  # DEFINITELY not present
        return True  # MIGHT be present (with FP probability)

    def current_fp_rate(self) -> float:
        """Estimate actual FP rate given current insertions."""
        return (1 - math.exp(-self.k * self.count / self.m)) ** self.k
```

---

## 3. Beyond Standard Bloom Filters — The Family

### 3.1 Counting Bloom Filter — Adding Deletion

The standard Bloom filter can't delete (clearing a bit to 0 might also clear another element's bit). A **Counting Bloom Filter** replaces each bit with an n-bit counter (typically 4 bits = count up to 15):

```
Standard:  [0][1][0][1][1]          # Can't decrement — which element owns bit[1]?
Counting:  [0][2][0][1][1]          # Insert: increment counters. Delete: decrement.
```

**Trade-offs:**
- 4× space increase (4-bit counter per position instead of 1 bit)
- Counter overflow risk at 16+ collisions (mitigated with 8-bit counters or "stick at max" policy)
- Now supports deletion — but a counting Bloom filter is 3–4× larger than a standard Bloom filter for the same FP rate

### 3.2 Cuckoo Filter — Deletion Without Bloat

Cuckoo filters use **cuckoo hashing** — each element has two candidate buckets. If both are full, evict an existing element to its alternate bucket (like a cuckoo bird pushing eggs out of a nest).

```
Insert X:
  Bucket A = fingerprint(X) ⊕ hash(X)
  Bucket B = fingerprint(X) ⊕ hash(fingerprint(X))
  → If either bucket has space, store fingerprint there.
  → If both full, evict an existing fingerprint to ITS alternate bucket.
  → Repeat until all elements placed or max evictions reached (table full → resize).

Lookup X:
  Check Bucket A and Bucket B for fingerprint(X). If found → yes.
```

**Cuckoo Filter vs Bloom Filter:**

| Property | Bloom Filter | Cuckoo Filter |
|----------|-------------|---------------|
| Deletion | ❌ (standard), ✅ (counting, 4× space) | ✅ (native) |
| Space efficiency (at 0.1% FP) | ~14 bits/element | ~12 bits/element |
| Space efficiency (at 1% FP) | ~10 bits/element | ~8 bits/element |
| Lookup speed | k memory accesses (e.g., 7) | At most 2 memory accesses |
| Insert speed | k memory accesses | 1-2 accesses (amortized), up to ~500 for full tables |
| Maximum load factor | N/A (FP degrades, not fails) | ~95% (then insertions fail → resize) |
| Implementation complexity | Low | Medium |

**When to prefer Cuckoo over Bloom:** You need deletion support AND space is tight AND lookups must be fast (2 cache lines vs. 7). **When to prefer Bloom:** Simplicity, predictable behavior, no insertion failure mode.

### 3.3 Scalable Bloom Filter — Dynamic Growth

A standard Bloom filter's FP rate degrades beyond capacity. A **Scalable Bloom Filter** addresses this by creating a chain of Bloom filters, each with progressively tighter FP rates:

```
Filter 0: n=1M, p=0.01   →  after 1M insertions, create Filter 1
Filter 1: n=2M, p=0.005  →  after 2M insertions, create Filter 2
Filter 2: n=4M, p=0.0025 →  after 4M insertions, create Filter 3
...

Total FP rate = 1 - ∏(1 - p_i) ≈ p_0 + p_1 + p_2 + ... (since p_i ≪ 1)
```

Each new filter is larger (capacity doubles) but tighter (FP rate halves). The geometric series converges: even with infinite filters, total FP ≈ 2 × p_0. **This lets the Bloom filter "scale out" instead of degrading** — the trade-off is that lookups must check ALL filters in the chain.

### 3.4 Bloom Filter Variants Summary

| Variant | Solves | Space Overhead | Key Trade-off |
|---------|--------|---------------|---------------|
| **Standard Bloom** | Membership | 10-15 bits/elem | No deletion, FP degrades with overfill |
| **Counting Bloom** | Membership + Deletion | 40-60 bits/elem | 4× space, counter overflow risk |
| **Cuckoo Filter** | Membership + Deletion (efficient) | 8-12 bits/elem | Insertion failures at ~95% load |
| **Scalable Bloom** | Membership + Dynamic growth | ~2× factor | Multi-filter lookup latency |
| **Compressed Bloom** | Network transmission | 10-15 bits/elem (compressed) | CPU cost of (de)compression |
| **Blocked Bloom** | Cache-friendly lookups | Same | One cache line per lookup, but more complex |
| **Bloomier Filter** | Associate values with keys | Larger | Returns a value OR "not present" |
| **Invertible Bloom Lookup Table (IBLT)** | Set reconciliation | Larger | Can LIST all elements present (not just test membership) |

---

## 4. HyperLogLog — Cardinality Estimation

"How many unique users visited today?" With 500M events/day, exact counting needs O(n) memory. HyperLogLog uses **1.5 KB** for ~2% error, regardless of how many billions of elements you count.

### How It Works (Intuition)

1. **Hash each element** to a uniformly distributed random bit string.
2. **Count leading zeros.** If you hash a million elements, you'll probably see "0000..." (many leading zeros) at some point. The more elements you process, the longer the maximum run of leading zeros you'll observe.
3. **The estimate.** If the longest run of leading zeros is L, the approximate cardinality is 2^L (divided into registers for accuracy via harmonic mean).

```
Hash("user_123") → 00101...  (2 leading zeros)
Hash("user_456") → 00010...  (3 leading zeros) ← new max!
Hash("user_789") → 10011...  (0 leading zeros)
...
After N elements: max_leading_zeros = 14  →  cardinality ≈ 2^14 = 16,384

With 16,384 registers (HLL standard): counting 2^64 elements with ~2% error in 12 KB.
```

### Size vs Accuracy Trade-off

| Registers (m) | Memory | Standard Error | Use Case |
|--------------|--------|---------------|----------|
| 256 | 256 bytes | ~6.5% | IoT sensor unique IDs |
| 1024 | 1 KB | ~3.2% | Basic analytics |
| 4096 | 4 KB | ~1.6% | Production analytics (Redis default) |
| 16384 (HLL) | 12 KB | ~0.81% | Standard production HLL |
| 65536 | 48 KB | ~0.41% | High-precision analytics |

**The key HLL operations:**
- **PFADD** — add an element (idempotent)
- **PFCOUNT** — estimate cardinality
- **PFMERGE** — merge two HLLs (cardinality of the union)

The merge property is incredibly powerful: you can have 1,000 web servers each maintaining a local HLL, then merge them at query time to get the global unique count. No central coordination needed.

### When HyperLogLog Fails

- **Small cardinalities (< 1000):** HLL uses Linear Counting correction, but precision is worse than exact counting with a HashSet.
- **When exact counts matter:** "How many users?" → HLL. "Did user 42 visit?" → Bloom filter. "How much revenue?" → exact counter.
- **When you need per-element metadata:** HLL only gives you the count. If you need the list of users, you need a different structure.

---

## 5. Count-Min Sketch — Frequency Estimation

"How many times was this IP address seen?" A Count-Min Sketch gives an **overcount estimate** (never undercounts) with bounded error.

### How It Works

A Count-Min Sketch is a 2D array of counters: **d rows (depth) × w columns (width)**.

```
INSERT "192.168.1.1":
  For each row i (0 to d-1):
    col = hash_i("192.168.1.1") % w
    sketch[i][col] += 1

ESTIMATE frequency of "192.168.1.1":
  freq = infinity
  For each row i (0 to d-1):
    col = hash_i("192.168.1.1") % w
    freq = min(freq, sketch[i][col])  # Take the minimum across all rows
  return freq   # This is an OVERCOUNT (never an undercount)
```

**Why take the minimum?** Each row independently hashes the element. Collisions cause overcounts. By taking the minimum across d independent rows, we minimize the collision-induced overcount.

**Error bounds:** With depth d = ⌈ln(1/δ)⌉ and width w = ⌈e/ε⌉ (where e ≈ 2.718):

```
P(estimate > true_count + ε × N) ≤ δ
```

Where N = total sum of all counts in the sketch. This means: with probability 1-δ, the estimate is within ε×N of the true value.

**Example:** For ε = 0.001 (0.1% error) and δ = 0.01 (99% confidence):
- w = e/0.001 ≈ 2719 columns
- d = ln(1/0.01) ≈ 5 rows
- Total counters: 2719 × 5 = 13,595
- Memory: 13,595 × 4 bytes (32-bit counters) ≈ 54 KB

**54 KB to estimate frequencies of billions of events with 99% confidence within 0.1%!**

---

## 6. Real-World System Design Applications

### 6.1 Google Bigtable / Apache HBase / Cassandra — Read Path Optimization

In LSM-tree (Log-Structured Merge-tree — a write-optimized storage engine that batches writes into sorted, immutable files on disk) databases (Bigtable, HBase, Cassandra, RocksDB), a read may need to check multiple SSTables (sorted string tables) on disk. A Bloom filter per SSTable avoids unnecessary disk seeks:

```
Without Bloom filter:
  SELECT * FROM users WHERE id = 42;
  → Check SSTable-1 (disk seek) → not found
  → Check SSTable-2 (disk seek) → not found
  → Check SSTable-3 (disk seek) → FOUND

With Bloom filter per SSTable:
  SELECT * FROM users WHERE id = 42;
  → Check Bloom-1 → "definitely not" → skip SSTable-1
  → Check Bloom-2 → "definitely not" → skip SSTable-2
  → Check Bloom-3 → "might be" → read SSTable-3 → FOUND

Result: 1 disk seek instead of 3 (67% reduction in this example, often 90%+ in production).
```

**Configuration in practice:**
```
# Cassandra table creation
CREATE TABLE users (...) WITH bloom_filter_fp_chance = 0.01;

# RocksDB configuration
rocksdb::BlockBasedTableOptions::filter_policy.reset(
    rocksdb::NewBloomFilterPolicy(10, false));
                                  #  ↑ 10 bits per key, false = block-based (not full filter)
```

### 6.2 CDN / Web Cache — "Is This Object Cached?"

Akamai, Cloudflare, and other CDNs handle billions of objects. A per-edge-server Bloom filter can answer "is this object likely cached locally?" in O(k) without a distributed cache lookup:

```
Request: GET /images/cat.jpg
  → Edge Bloom filter: "Is /images/cat.jpg in local cache?"
    → NO (definite)  → Fetch from origin, cache locally
    → YES (maybe)    → Check local cache (may be a false positive — minor waste)
```

The false-positive cost is bounded: one unnecessary local cache lookup per false positive. The savings: avoid origin fetches for cache-hit objects.

### 6.3 Web Crawler — URL Deduplication

Google's crawler has visited trillions of URLs. Storing visited URLs exactly would take petabytes. A Bloom filter with p = 0.001 (0.1% FP, ~14 bits/URL) needs only ~1.7 TB for 1 trillion URLs, vs ~100 TB for a hash set of 100-byte average URLs.

```
Crawl frontier:
  Dequeue URL → Bloom filter: "Already visited?"
    → NO  → Visit page, extract outlinks, add to Bloom
    → YES → Skip (0.1% chance it's a false positive → miss a page)
```

The 0.1% missed-page rate is acceptable for web crawling since pages are re-crawled periodically.

### 6.4 Database Query Optimization — Bloom Filter Join

In distributed SQL engines (Presto, Spark, BigQuery), Bloom-filter-based joins can dramatically reduce shuffle volume:

```sql
-- Without Bloom filter join: shuffle ALL rows from both tables
SELECT * FROM orders o JOIN customers c ON o.customer_id = c.id
WHERE c.region = 'EU';

-- With Bloom filter join:
-- 1. Scan customers, build Bloom filter of customer IDs in EU region
-- 2. Broadcast Bloom filter to all order-scanner nodes
-- 3. Each order node filters: "Is customer_id in EU Bloom filter?"
--    → NO → drop row (no shuffle needed)
--    → YES → shuffle row to join (may be FP → filtered at join)
-- 4. Only ~10-20% of orders shuffled (dramatic reduction)
```

This technique is called a **Bloom filter pushdown** or **dynamic filter** and is often a 5-50× improvement in join performance.

### 6.5 Malware / Phishing URL Blocklist — Chrome's Safe Browsing

Google Safe Browsing maintains a blocklist of millions of malicious URLs. Shipping the full list to every Chrome browser would be GB-sized and update slowly. Instead:

```
1. Server sends a compressed Bloom filter (few MB) to each browser.
2. Browser checks each URL against local Bloom filter:
   → NO  → Safe (no server query needed — preserves privacy!)
   → YES → Hash prefix sent to Google for server-side verification
3. Server-side verification resolves false positives with full database.
```

This preserves user privacy (only a hash prefix leaves the browser for "yes" answers) while keeping the client-side database tiny.

### 6.6 Rate Limiting — Sliding Window with Approximate Counts

A hyper-scale rate limiter (1M requests/sec) can use Count-Min Sketch for approximate per-user counts:

```
Rate limit: 1000 requests per hour per user

For each request from user U:
  count = CountMinSketch.estimate(U, last_hour_window)
  if count > 1000:
      reject request (with probability 1 - FP rate)
  else:
      CountMinSketch.add(U, last_hour_window)
      accept request
```

The Count-Min Sketch overcount guarantees: a user may be rate-limited even if they're slightly below the limit, but will NEVER be allowed over the limit unrecognized. This is conservative and safe.

---

## 7. Architectural Decision: Choosing the Right Structure

```
┌────────────────────────────────────────────────────────────────────┐
│                WHICH PROBABILISTIC DATA STRUCTURE?                   │
│                                                                      │
│  Question you're answering:                                          │
│                                                                      │
│  "Is X in the set?"                                                  │
│    ├── Need deletion? ──YES── Need space efficiency?                 │
│    │                          ├── YES → Cuckoo Filter                │
│    │                          └── NO (flexible) → Counting Bloom     │
│    └── No deletion ────→ Standard Bloom Filter                       │
│                                                                      │
│  "How many of X?"                                                    │
│    ├── Frequency of individual items ──→ Count-Min Sketch            │
│    └── Unique count (cardinality)    ──→ HyperLogLog                 │
│                                                                      │
│  "How similar are A and B?"                                          │
│    ├── Set similarity (Jaccard) ──→ MinHash                         │
│    └── Document similarity (cosine) ──→ SimHash / Random Projection  │
│                                                                      │
│  "What are the top K?"                                               │
│    ├── Heavy hitters (frequent items) ──→ Count-Min Sketch + Heap    │
│    └── Top K with bounded error     ──→ SpaceSaving (deterministic)  │
│                                                                      │
│  "Which items differ between two sets?"                              │
│    └── Set reconciliation ──→ Invertible Bloom Lookup Table (IBLT)   │
│                                                                      │
└────────────────────────────────────────────────────────────────────┘
```

### Decision Table: Space vs. Accuracy

| Structure | Space for 1B elements | Error Type | Error Rate | Operations |
|-----------|----------------------|-----------|------------|-----------|
| HashSet (baseline) | ~100 GB (100B avg) | None (exact) | 0 | Insert, Lookup, Delete |
| Bloom Filter (p=0.1%) | ~1.8 GB | FP only | 0.1% | Insert, Lookup |
| Cuckoo Filter (p=0.1%) | ~1.5 GB | FP only | 0.1% | Insert, Lookup, Delete |
| Counting Bloom (p=0.1%) | ~7 GB | FP + overcount | 0.1% FP | Insert, Lookup, Delete, Count |
| Count-Min Sketch (ε=0.001) | ~100 KB (fixed) | Overcount | ε × N | Add, Estimate |
| HyperLogLog (2% error) | ~1.5 KB (fixed) | Estimate ±2% | 2% relative | Add, Count, Merge |

**The story in one line:** A Bloom filter is ~55× smaller than a hash set at 0.1% error. HyperLogLog is 70,000,000× smaller than exact counting for 1B elements.

---

## 8. Operational Pitfalls (The Things That Break in Production)

### Pitfall 1: Capacity Overrun (The Silent Degradation)

```
Week 1:  Bloom filter deployed, n=1B, p=0.1%. 0.1% of non-members return "yes."
Week 52: 1.5B elements inserted. Actual FP rate ≈ 3%.
         System is silently returning 30× more false positives.
         No alert. No metric. Just degraded behavior.
```

**Fix:** (a) Monitor `actual_insertions / designed_capacity`. Alert at 80%. (b) Use a Scalable Bloom Filter that auto-expands. (c) Expose `current_fp_rate()` metric to monitoring.

### Pitfall 2: Serialization/Deserialization Drift

```
Server A: Bloom filter with murmur3 hash, m=10M bits, k=7
Server B: Bloom filter with sha256 hash, m=10M bits, k=7
→ Same element produces different hash positions.
→ Filters are incompatible.
→ Combined (union) gives garbage results.
```

**Fix:** Serialize the Bloom filter parameters (hash algorithm, seed, m, k) along with the bit array. Never assume two filters are compatible without checking parameters.

### Pitfall 3: False Negatives from Misimplementation

A true Bloom filter has ZERO false negatives by design. But bugs introduce them:
- Concurrency: two threads setting bits simultaneously, one clobbers the other (use atomic bit sets or `compare_and_swap`).
- Hash collision between different hash functions (use double hashing with independent seeds).
- Bit array resizing without rehashing (loses all existing members).

### Pitfall 4: Using Bloom Filter Where Exact Lookup Is Required

"Let's use a Bloom filter for our user authentication lookup — it's so memory-efficient!"
→ False positive = a non-existent user passes authentication.
→ This is a CRITICAL security flaw, not a minor annoyance.

**Rule:** Bloom filters are for optimization, not for correctness-critical paths. If a wrong answer has a security, financial, or legal consequence, use an exact data structure.

### Pitfall 5: HyperLogLog Merge with Different Precisions

```
HLL(precision=12) from server A (4 KB)
HLL(precision=14) from server B (16 KB)
→ Merging them: which precision? The lower one loses information.
→ Merged result has error rate of the lowest-precision HLL.
```

**Fix:** Standardize precision across all services. Include precision in serialization.

---

## 9. Interview Question: The URL Blocklist at Scale

### The Scenario

> "You're building a URL blocklist for a security product that processes 50 billion URLs per day. The blocklist contains 10 billion known malicious URLs. You have a budget of 4 GB RAM per server for the blocklist data structure. Lookups must return in under 1 microsecond. False negatives (classifying a malicious URL as safe) are catastrophic. False positives (classifying a safe URL as malicious) are acceptable up to 0.1%. The blocklist grows by 100 million URLs per day. How do you design this system?"

### Model Answer

**1. Pick the data structure: Bloom filter (not a hash set).** 
A hash set of 10 billion URLs at ~100 bytes per URL (string + hash table overhead) would need ~1 TB of RAM — well beyond our 4 GB budget. A Bloom filter at 0.1% FP needs ~14 bits per element: 10B × 14 bits = 17.5 GB if we sized for the full 10B. But we can compress: serialized Bloom filters compress extremely well (they're mostly random bits, but the sparsity creates compressibility in early stages). Even without compression, with 4 GB = 32 Gbits / 10B elements = 3.2 bits per element → FP rate ≈ 25% — unacceptable. We need a better approach.

**2. The multi-layer architecture:**
```
Layer 1 (L1 - Hot Cache): LRU cache of recently seen URLs
  → 500 MB. Hash set of ~5M exact URLs. 0.02μs lookup.
  → 80% of requests hit here (power-law distribution: most traffic is to popular URLs).

Layer 2 (L2 - Bloom Filter): Compressed Bloom filter for the full 10B blocklist
  → 3 GB compressed (~2.4 bits/elem at rest, decompressed on startup).
  → Online, the Bloom filter needs ~14 bits/elem uncompressed = 17.5 GB. But we can:
    a) Partition the Bloom filter across 5 servers (3.5 GB each), or
    b) Use a Scalable Bloom Filter where only "hot" filters are in memory.

Layer 3 (L3 - Exact verification): Remote query to blocklist database
  → For L2 "yes" answers, verify against RocksDB on SSD (50TB blocklist on disk).
  → Only ~0.1% of total traffic (the FPs from L2) hit this layer.
  → RTT to L3: ~100-500μs. Total pipeline: still < 1ms for FP case.
```

**3. Handling growth of 100M URLs/day:**
```
- Rebuild the Bloom filter daily from the ground truth database during off-peak.
- Use a delta Bloom filter for new URLs added between rebuilds.
- Total pipeline: query L1 → L2 (main) → L2 (delta) → L3 (exact).
- Daily rebuild takes ~10 minutes with parallelized hashing.
```

**4. The complete read path:**
```
Request: "Is https://evil.com/phish safe?"
  → L1 (Hot Cache): Check exact URL hash set. If HIT → "MALICIOUS" (0.02μs)
  → L2 (Bloom Filter): Query Bloom. 
    → If NO → "SAFE" (guaranteed). (0.3μs)
    → If YES → continue. (might be FP)
  → L3 (RocksDB): Exact lookup in blocklist database on SSD.
    → If FOUND → "MALICIOUS" (confirmed).
    → If NOT FOUND → "SAFE" (it was a false positive — update monitoring).
  → Promote to L1 cache on "MALICIOUS" hits.
```

**5. Deployment architecture:**
```
┌──────────────────────────────────────────────────────┐
│                   Load Balancer                       │
└───┬──────────────┬──────────────┬─────────────────┬──┘
    │              │              │                 │
┌───▼───┐     ┌───▼───┐     ┌───▼───┐        ┌────▼────┐
│Server 1│     │Server 2│     │Server 3│   ...  │Server N │
│L1: LRU │     │L1: LRU │     │L1: LRU │        │L1: LRU  │
│L2: BF  │     │L2: BF  │     │L2: BF  │        │L2: BF   │
│ (full) │     │ (full) │     │ (full) │        │ (full)  │
└───┬───┘     └───┬───┘     └───┬───┘        └────┬────┘
    │              │              │                 │
    └──────────────┴──────────────┴─────────────────┘
                        │
                   ┌────▼────┐
                   │  RocksDB │  (SSD cluster — ground truth)
                   │  Cluster  │
                   └─────────┘
```

Each server has the full Bloom filter (4 GB, occasionally swapped to disk for cold sections). The L1 cache is per-server (500 MB) — no coordination needed. The L3 RocksDB cluster is the single source of truth, updated atomically.

### Common Pitfall

**❌ "Just use a 4 GB Bloom filter for 10 billion URLs."** At 4 GB = 32 Gbits = 3.2 bits per element, the FP rate is ~(0.6185)^3.2 ≈ 25%. One in four safe URLs would be flagged as malicious. Your security product would block Google.com, GitHub.com, and every other popular site 25% of the time. It would be completely unusable.

**✅ The fix:** Don't try to fit the full blocklist in RAM with a single Bloom filter at 0.1% FP — it needs ~17.5 GB. Instead, use the multi-layer architecture: an LRU hot cache (80% hit rate), a Bloom filter at higher FP rate (2-5%) as a "probable block" filter, and an exact verification layer for Bloom positives. The layered approach reduces average lookup to the cost of L1/L2, with L3 only handling the FP tail. Also consider: do you really need 0.1% FP for ALL URLs, or can you use a higher FP rate for cold URLs and exact storage for hot URLs? A **weighted Bloom filter** approach (larger filter for frequently-accessed URL prefixes) can provide better effective accuracy.

---

## 10. Curveball Questions

**"Your Bloom filter has been running for 6 months. The CISO asks: 'Can you prove that a specific URL was definitely in the blocklist on March 15th?' How do you answer?"**

A Bloom filter can't answer this. It's a probabilistic structure with no audit trail — you can't reconstruct past membership from the current bit array (because bits are set by multiple elements and never cleared). 

**The staff-engineer answer:** "No — a standard Bloom filter can't answer historical membership queries. Here's how I'd solve it: (a) Keep a WAL (write-ahead log) of all Bloom filter insertions in append-only storage. To answer 'was X present on March 15th?', replay the WAL up to that date. (b) Or, use versioned Bloom filters — daily snapshots stored in S3. To answer a historical query, load the March 15th snapshot. (c) Better: recognize that this is a fundamentally different requirement (auditability) and the Bloom filter is the wrong tool for it. Use an exact structure (Merkle tree, append-only log, or database with temporal tables) for audit queries, and keep the Bloom filter for the real-time path."

**"You're building a distributed rate limiter. Your Count-Min Sketch is kept locally on each server. The rate limit is 100 requests per minute per user. How do you handle the fact that the same user's requests may hit different servers?"**

Single-server Count-Min Sketch doesn't work for distributed rate limiting — each server only sees its fraction of the user's traffic, so the total is undercounted (and the overcount guarantee is violated across servers).

**Solutions:**
1. **Sticky sessions** — route User X always to Server Y ([[Glossary#Consistent Hashing|consistent hashing]] on user_id). Simple but breaks if Server Y goes down and user is re-routed.
2. **Distributed Count-Min Sketch** — each server writes to a shared Redis cluster. The sketch is in Redis; all servers read/write the same counters. Trade-off: Redis becomes a bottleneck at 1M RPS.
3. **Local sketch + periodic merge** — each server maintains its own Count-Min Sketch. Every 10 seconds, servers exchange sketches and merge (pointwise addition). Rate limit check: estimate from merged sketch. Trade-off: 10-second staleness means a user can burst 2× the limit briefly.
4. **Two-layer: local (fast, stale) + global (slow, accurate)** — local Count-Min Sketch with relaxed limit (80 requests). When local approaches limit, query global Redis for exact count. This is the practical answer.

---

## 11. Key Metrics Summary

| Metric | Target | Why |
|--------|--------|-----|
| False-positive rate | ≤ 0.1% (for blocklist/security) | User trust. Higher FPs → product unusable. |
| False-negative rate | 0 (guaranteed by design) | Non-negotiable for security filters. |
| Insertion throughput | 1M+ per second per server | Must keep up with URL ingestion (100M/day). |
| Lookup latency (P99) | < 1μs (L1), < 5μs (L2) | Must not add perceptible latency to page loads. |
| Memory per server | < 4 GB for 10B-element filter | Hardware constraints. |
| Capacity headroom monitor | Alert at 80% of designed n | Prevents silent FP degradation. |
| Bloom filter rebuild time | < 30 minutes | Must complete during off-peak window. |

---

## 12. Weaknesses & Trade-offs

1. **Bloom filters degrade silently.** The FP rate increases with insertions, but there's no obvious signal unless you explicitly monitor `current_fp_rate()`. Most teams don't. By the time someone notices, the system has been returning garbage for weeks.

2. **No deletion without cost.** Standard Bloom filters can't delete. Counting Bloom filters cost 4× space. Cuckoo filters can delete but fail to insert at high load. Choose carefully.

3. **No enumeration.** You can test "is X in the set?" but you can't ask "give me all elements in the set." If you need enumeration (e.g., "list all blocked URLs"), you need a separate exact data store.

4. **Parameter lock-in.** Once you choose m (size) and k (hash functions), you can't change them without rebuilding the entire filter from the original dataset. If you lose the original dataset, you're stuck.

5. **False sense of precision.** HyperLogLog's "2% error" sounds precise, but for small cardinalities (< 1000), the error can be much higher. Always check the HLL error profile for your expected cardinality range.

6. **Hash function distribution matters.** A poor hash function (non-uniform distribution) breaks all the probability guarantees. Use well-tested hash functions: MurmurHash3, xxHash, SipHash. Never use a cryptographic hash (SHA-256) for Bloom filters — it's 100× slower and adds unnecessary collision resistance that you don't need.

---

## Related
- [[topic-queue]]
- [[Distributed Cache (Redis-Memcached)]]
- [[Consistent Hashing]] (for partitioning Bloom filters across servers)
- [[Database Indexing & Query Optimization]] (for Bloom filter join pushdown)
- [[Rate Limiter]] (for Count-Min Sketch in rate limiting)
- [[Bloom Filters & Probabilistic Data Structures — Weakness Vault]]

## Interview Cheat Sheet

**Key Points to Remember:**
- A Bloom filter answers "is X possibly in the set?" with zero false negatives and a tunable false-positive rate. It needs only ~10–14 bits per element (1%–0.1% FP), making it 100–1000x smaller than a hash set.
- The false-positive rate degrades exponentially as you insert beyond the designed capacity — at 3x the design point, a 1% filter becomes ~25%. Monitor `actual_insertions / designed_capacity` and alert at 80%, or use a Scalable Bloom Filter.
- Bloom filters cannot delete (standard) or enumerate elements. Need deletion? Use a Cuckoo filter (native delete, ~2 memory accesses) or Counting Bloom filter (4x space). Need unique counts? Use HyperLogLog (~1.5 KB for billions of elements at ~2% error).
- Never use a Bloom filter where a false positive has security, financial, or legal consequences — it is an optimization layer, not a correctness layer. Always pair it with an exact verification step for "yes" answers in critical paths.
- Use double hashing (Kirsch-Mitzenmacher) to derive k hash positions from just two hash computations — mathematically equivalent and far faster than k independent hashes.

**Common Follow-Up Questions:**
- **"How do you handle a Bloom filter that needs to grow beyond its original capacity?"** — Use a Scalable Bloom Filter: a chain of filters with progressively tighter FP rates that auto-expand, keeping total FP bounded at ~2x the initial rate. The cost is that lookups must check every filter in the chain.
- **"You need to count unique visitors across 1,000 servers — how?"** — Use HyperLogLog on each server (1.5 KB each), then merge with PFMERGE at query time. The merge is associative and needs no central coordination, giving a global unique count with ~2% error in kilobytes total.
- **"When is a Bloom filter the wrong choice?"** — When you need deletion, element enumeration, exact counts, historical auditability, or zero false positives. Each of these maps to a different structure (Cuckoo filter, IBLT, exact counter, WAL/versioned snapshots, or a hash set).

**Gotcha:**
- The silent degradation trap: a Bloom filter designed for n=1B at 1% FP will still "work" at n=3B — no errors, no crashes — but its actual FP rate has climbed to ~25%, quietly corrupting system behavior with no alert. Most teams never expose `current_fp_rate()` to monitoring, so the degradation goes unnoticed for weeks.
