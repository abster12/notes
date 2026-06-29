---
title: "Design Problems — Coding Interview Prep"
tags: [coding-interview, java, oop, design, system-design]
date: 2026-06-19
difficulty: medium-to-hard
language: java
topics: [lru-cache, lfu-cache, hashmap, circular-queue, trie, oop-design]
---

# Design Problems — Coding Interview Prep

Object-Oriented Design (OOD) problems are a staple of coding interviews at major tech companies. They test your ability to model real-world or abstract systems using classes, data structures, and design patterns. Unlike pure algorithm problems, design problems reward clean encapsulation, careful choice of internal data structures, and an understanding of time/space tradeoffs.

This article walks through the most frequently asked design problems with full Java solutions, ASCII diagrams, design pattern notes, and a pattern recognition table at the end.

## Summary & Interview Framing

Object-oriented design interview questions that ask you to model real-world systems using classes, interfaces, and design patterns.

**How it's asked:** "Design a parking lot, design an elevator system, design a library management system — problems testing class design, relationships, and SOLID principles."

---

## Why Design Problems Matter

Design questions evaluate several skills at once:

- **Data structure selection** — picking the right container for each operation's required complexity.
- **Encapsulation** — hiding internal state behind a clean public API.
- **Tradeoff reasoning** — trading memory for speed, or write cost for read cost.
- **Edge case handling** — capacity boundaries, eviction policies, empty/overflow states.

The most common trap is reaching for an `ArrayList` or `HashMap` without thinking through whether it supports every required operation at the target complexity. The solutions below show the deliberate, layered approach interviewers look for.

---

## 1. LRU Cache (LeetCode 146)

Design a data structure that follows the constraints of a **Least Recently Used (LRU) cache**:

- `LRUCache(int capacity)` — initialize with positive capacity.
- `int get(int key)` — return the value if the key exists, otherwise `-1`.
- `void put(int key, int value)` — update the value if the key exists, otherwise add the key-value pair. When the cache reaches its capacity, evict the least recently used key before inserting.

Both `get` and `put` must run in **O(1)** average time.

### Approach

The key insight: we need two things simultaneously — **O(1) lookup** (HashMap) and **O(1) recency tracking** (doubly linked list). The HashMap maps keys to list nodes. The doubly linked list maintains order from most-recently-used (head side) to least-recently-used (tail side). On every access, we move the node to the head; on eviction, we remove the tail.

Using a **doubly** linked list (not singly) is essential because we need O(1) removal of an arbitrary node — a singly linked list would force O(n) traversal to find the predecessor.

### ASCII Diagram — LRU Cache Structure

```
                    HashMap<Integer, Node>
                    +--------+------------+
                    |  key   |  node ptr  |
                    +--------+------------+
                    |   1    |  --------> [Node(1,A)]
                    |   3    |  --------> [Node(3,C)]
                    |   4    |  --------> [Node(4,D)]
                    +--------+------------+
                                          |
                                          v
   Doubly Linked List (MRU ... LRU):
                                          
     head <-> [4,D] <-> [3,C] <-> [1,A] <-> tail
                                               ^
                                               |
                                      Evict from tail (LRU)

   get(1):  look up node in map, move to head
   put(2,B): if full -> remove tail node + its map entry,
             then insert new node at head + map entry
```

### Full Java Solution

```java
class LRUCache {

    // Doubly linked list node
    private class Node {
        int key, value;
        Node prev, next;
        Node(int key, int value) {
            this.key = key;
            this.value = value;
        }
    }

    private final int capacity;
    private final Map<Integer, Node> map;
    private final Node head; // dummy head (MRU side)
    private final Node tail; // dummy tail (LRU side)

    public LRUCache(int capacity) {
        this.capacity = capacity;
        this.map = new HashMap<>();
        // Initialize dummy head and tail linked together
        head = new Node(0, 0);
        tail = new Node(0, 0);
        head.next = tail;
        tail.prev = head;
    }

    public int get(int key) {
        if (!map.containsKey(key)) return -1;
        Node node = map.get(key);
        // Move accessed node to head (mark most-recently-used)
        removeNode(node);
        addToHead(node);
        return node.value;
    }

    public void put(int key, int value) {
        if (map.containsKey(key)) {
            // Update existing node and move to head
            Node node = map.get(key);
            node.value = value;
            removeNode(node);
            addToHead(node);
        } else {
            // Evict LRU if at capacity
            if (map.size() == capacity) {
                Node lru = tail.prev;
                removeNode(lru);
                map.remove(lru.key);
            }
            Node newNode = new Node(key, value);
            addToHead(newNode);
            map.put(key, newNode);
        }
    }

    // Remove a node from the doubly linked list
    private void removeNode(Node node) {
        node.prev.next = node.next;
        node.next.prev = node.prev;
    }

    // Insert a node right after the dummy head (MRU position)
    private void addToHead(Node node) {
        node.next = head.next;
        node.prev = head;
        head.next.prev = node;
        head.next = node;
    }
}
```

### Complexity

- `get`: O(1) — HashMap lookup + O(1) list reordering.
- `put`: O(1) — HashMap insert + O(1) list insert, with O(1) eviction.
- Space: O(capacity) for the map and list nodes.

### Key Takeaways

- Dummy `head` and `tail` nodes eliminate null checks and simplify boundary handling.
- Store the `key` in the node so eviction can remove the map entry without an extra reverse lookup.
- `LinkedHashMap` with `accessOrder=true` and an overridden `removeEldestEntry` solves this in ~5 lines, but interviewers expect the manual implementation.

---

## 2. LFU Cache (LeetCode 460)

Design and implement a data structure for a **Least Frequently Used (LFU)** cache:

- `LFUCache(int capacity)` — initialize with capacity.
- `int get(int key)` — return value if present, else `-1`.
- `void put(int key, int value)` — set or insert. When capacity is reached, evict the **least frequently used** key. If there is a tie, evict the **least recently used** among them.

Both operations must run in **O(1)** average time. This is one of the hardest "design" problems because of the dual-frequency + recency tracking.

### Approach

We maintain three structures:

1. `keyToVal` — key to value map.
2. `keyToFreq` — key to its current access frequency.
3. `freqToKeys` — frequency to a `LinkedHashSet` of keys at that frequency. `LinkedHashSet` preserves insertion order, so the oldest key at a given frequency is first — this gives us the LRU tiebreaker for free.
4. `minFreq` — the current minimum frequency, so eviction knows which `LinkedHashSet` to pop from.

On every `get` or `put` (update), we increment the key's frequency: remove it from the old frequency bucket, add it to the `freqToKeys(freq+1)` bucket, and bump `minFreq` (it always becomes 1 for a brand-new key, or `freq+1` when the only key at `minFreq` gets promoted).

### ASCII Diagram — LFU Frequency Tracking

```
   freqToKeys (LinkedHashSet preserves insertion order):

   freq=1: { 7 }            <-- minFreq points here
   freq=2: { 3, 5 }         <-- 3 is older than 5 (LRU tiebreaker)
   freq=3: { 1 }
   freq=4: { 2, 9, 8 }

   Eviction: poll first element of freqToKeys[minFreq]  --> key 7

   get(3):
     remove 3 from freq=2 bucket  -> { 5 }
     add 3 to freq=3 bucket       -> { 1, 3 }
     keyToFreq[3] = 3
     minFreq unchanged (freq=1 bucket still has key 7)

   put(10, v) when full:
     evict key 7 (first in minFreq bucket)
     insert key 10 into freq=1 bucket
     minFreq = 1
```

### Full Java Solution

```java
class LFUCache {

    private final int capacity;
    private int minFreq;
    private final Map<Integer, Integer> keyToVal;
    private final Map<Integer, Integer> keyToFreq;
    // LinkedHashSet preserves insertion order -> LRU tiebreaker within a freq
    private final Map<Integer, LinkedHashSet<Integer>> freqToKeys;

    public LFUCache(int capacity) {
        this.capacity = capacity;
        this.minFreq = 0;
        this.keyToVal = new HashMap<>();
        this.keyToFreq = new HashMap<>();
        this.freqToKeys = new HashMap<>();
    }

    public int get(int key) {
        if (!keyToVal.containsKey(key)) return -1;
        increaseFreq(key);
        return keyToVal.get(key);
    }

    public void put(int key, int value) {
        if (capacity <= 0) return;

        if (keyToVal.containsKey(key)) {
            // Update value and bump frequency
            keyToVal.put(key, value);
            increaseFreq(key);
            return;
        }

        // Evict LFU (and LRU among ties) if at capacity
        if (keyToVal.size() >= capacity) {
            evict();
        }

        // Insert brand-new key at frequency 1
        keyToVal.put(key, value);
        keyToFreq.put(key, 1);
        freqToKeys.computeIfAbsent(1, k -> new LinkedHashSet<>()).add(key);
        minFreq = 1; // a fresh key always resets min frequency
    }

    // Promote a key from its current frequency bucket to freq+1
    private void increaseFreq(int key) {
        int freq = keyToFreq.get(key);
        keyToFreq.put(key, freq + 1);

        LinkedHashSet<Integer> set = freqToKeys.get(freq);
        set.remove(key);
        // If we emptied the min-frequency bucket, advance minFreq
        if (set.isEmpty()) {
            freqToKeys.remove(freq);
            if (minFreq == freq) {
                minFreq++;
            }
        }
        freqToKeys.computeIfAbsent(freq + 1, k -> new LinkedHashSet<>()).add(key);
    }

    // Evict the least-frequently-used (and least-recently-used tie) key
    private void evict() {
        LinkedHashSet<Integer> set = freqToKeys.get(minFreq);
        int evictKey = set.iterator().next(); // oldest key at minFreq
        set.remove(evictKey);
        if (set.isEmpty()) {
            freqToKeys.remove(minFreq);
        }
        keyToVal.remove(evictKey);
        keyToFreq.remove(evictKey);
    }
}
```

### Complexity

- `get` / `put`: O(1) — all HashMap and LinkedHashSet operations are O(1).
- Space: O(capacity).

### Key Takeaways

- `LinkedHashSet` is the secret weapon — it gives O(1) add/remove AND preserves insertion order for the LRU tiebreaker.
- `minFreq` is reset to `1` on every brand-new insert; it only advances on promotion when the old min bucket empties.
- A common alternative uses a `freq`-keyed doubly linked list of frequency buckets, each holding a doubly linked list of nodes. That avoids `LinkedHashSet` but is far more code.

---

## 3. Design HashMap (LeetCode 706)

Design a HashMap **without using any built-in hash table libraries**. Implement `MyHashMap` with `put(key, value)`, `get(key)`, and `remove(key)`. All keys and values are integers in the range `[0, 1000000]`.

### Approach — Separate Chaining

A hash map is an array of "buckets." Each bucket holds a linked list (chain) of entries that hash to the same index. Collisions are resolved by chaining — multiple entries in the same bucket are stored in the list. We pick a fixed bucket count (e.g., 1000) to keep load factor reasonable.

```
   buckets array (size = 1000)
   +------+
   |  [0] | -> null
   |  [1] | -> [k=1001,v=a] -> [k=2001,v=b] -> null   (collision chain)
   |  [2] | -> null
   | ...  |
   | [999] | -> [k=999,v=z] -> null
   +------+

   hash(key) = key % 1000
```

### Full Java Solution

```java
class MyHashMap {

    private static final int SIZE = 1000;

    // Linked list node for separate chaining
    private class Node {
        int key, value;
        Node next;
        Node(int key, int value) {
            this.key = key;
            this.value = value;
        }
    }

    private final Node[] buckets;

    public MyHashMap() {
        buckets = new Node[SIZE];
    }

    private int hash(int key) {
        return key % SIZE;
    }

    public void put(int key, int value) {
        int idx = hash(key);
        Node prev = findNode(idx, key);
        if (prev == null) {
            // Insert at head of chain
            Node node = new Node(key, value);
            node.next = buckets[idx];
            buckets[idx] = node;
        } else if (prev.next == null) {
            // Key not found; append new node at end
            prev.next = new Node(key, value);
        } else {
            // Key found; update value
            prev.next.value = value;
        }
    }

    public int get(int key) {
        int idx = hash(key);
        Node prev = findNode(idx, key);
        if (prev == null || prev.next == null) return -1;
        return prev.next.value;
    }

    public void remove(int key) {
        int idx = hash(key);
        Node prev = findNode(idx, key);
        if (prev == null || prev.next == null) return;
        prev.next = prev.next.next;
    }

    // Returns the node BEFORE the target key's node.
    // A dummy head simplifies head-of-chain removals.
    // Returns null only if bucket is empty.
    // If prev.next == null, key was not found.
    private Node findNode(int idx, int key) {
        if (buckets[idx] == null) return null;
        // If head matches, return a synthetic "prev" via dummy handling
        if (buckets[idx].key == key) {
            Node dummy = new Node(-1, -1);
            dummy.next = buckets[idx];
            return dummy;
        }
        Node curr = buckets[idx];
        while (curr.next != null && curr.next.key != key) {
            curr = curr.next;
        }
        return curr;
    }
}
```

### Complexity

- Average `put`/`get`/`remove`: O(1 + α) where α = load factor (n/size).
- Worst case (all keys collide): O(n). A good hash function or dynamic resizing keeps the average near O(1).

### Key Takeaways

- Separate chaining is simpler than open addressing (linear probing) and tolerates high load factors.
- A dummy-head technique makes head-of-chain removal uniform with interior removal.
- For production, you'd add **resizing** (rehash when load factor exceeds a threshold) and a better hash function.

---

## 4. Design HashSet (LeetCode 705)

Design a HashSet **without using built-in hash table libraries**. Implement `add(key)`, `remove(key)`, and `contains(key)`.

### Approach

A HashSet is a HashMap without values. We can reuse the same separate-chaining structure, but since we only store presence, a simple boolean bucket array or a bit-set works for fixed-range integer keys. For generality, we use the same chaining approach as the HashMap.

### Java Solution

```java
class MyHashSet {

    private static final int SIZE = 1000;
    private final Node[] buckets;

    private class Node {
        int key;
        Node next;
        Node(int key) { this.key = key; }
    }

    public MyHashSet() {
        buckets = new Node[SIZE];
    }

    private int hash(int key) {
        return key % SIZE;
    }

    public void add(int key) {
        int idx = hash(key);
        if (buckets[idx] == null) {
            buckets[idx] = new Node(key);
            return;
        }
        Node curr = buckets[idx];
        while (true) {
            if (curr.key == key) return; // already present
            if (curr.next == null) {
                curr.next = new Node(key);
                return;
            }
            curr = curr.next;
        }
    }

    public void remove(int key) {
        int idx = hash(key);
        Node curr = buckets[idx];
        if (curr == null) return;
        if (curr.key == key) {
            buckets[idx] = curr.next;
            return;
        }
        while (curr.next != null) {
            if (curr.next.key == key) {
                curr.next = curr.next.next;
                return;
            }
            curr = curr.next;
        }
    }

    public boolean contains(int key) {
        int idx = hash(key);
        Node curr = buckets[idx];
        while (curr != null) {
            if (curr.key == key) return true;
            curr = curr.next;
        }
        return false;
    }
}
```

### Complexity

- Average O(1) per operation; worst case O(n) with bad hashing.

### Key Takeaways

- For fixed small ranges (e.g., keys 0..1000000), a plain `boolean[]` of size 1000001 is the simplest O(1) solution — but it wastes memory and doesn't scale.
- The chaining version generalizes to any hashable key type.

---

## 5. Min Stack (LeetCode 155)

Design a stack that supports `push`, `pop`, `top`, and retrieving the **minimum element** in **O(1)** time.

### Approach

We keep two stacks: the main stack for values, and an auxiliary `minStack` that tracks the running minimum. Whenever we push, we also push the current minimum (either the new value if it's smaller, or repeat the current top of `minStack`). On pop, we pop from both. The top of `minStack` is always the global minimum.

```
   main stack        min stack
   +-------+         +-------+
   |  -3   |         |  -3   |   <-- top of min stack = current min
   |   0   |         |  -2   |
   |  -2   |         |  -2   |
   +-------+         +-------+

   push(-2): min = -2
   push(0):  min = -2 (0 > -2, push -2 again)
   push(-3): min = -3 (-3 < -2, push -3)
   top() = -3, getMin() = -3
   pop():    remove -3 from both; min = -2 again
```

### Full Java Solution

```java
class MinStack {

    private final Deque<Integer> stack;
    private final Deque<Integer> minStack;
    private int min;

    public MinStack() {
        stack = new ArrayDeque<>();
        minStack = new ArrayDeque<>();
        min = Integer.MAX_VALUE;
        // Seed minStack so first push has a baseline
        minStack.push(min);
    }

    public void push(int val) {
        stack.push(val);
        min = Math.min(min, val);
        minStack.push(min);
    }

    public void pop() {
        stack.pop();
        minStack.pop();
        // Restore min to the new top of minStack (or MAX_VALUE if empty)
        min = minStack.peek();
    }

    public int top() {
        return stack.peek();
    }

    public int getMin() {
        return minStack.peek();
    }
}
```

### Alternative — One-Stack with Differential Encoding

A space-optimized variant stores the **difference** between the value and the previous min in a single stack, recomputing the min on pop. It halves memory at the cost of trickier arithmetic and potential overflow with large deltas. The two-stack version is clearer and interview-friendly.

### Complexity

- All operations: O(1) time, O(n) auxiliary space for the `minStack`.

### Key Takeaways

- The invariant: `minStack.peek()` is always the minimum of all elements currently in `stack`.
- Seeding `minStack` with `Integer.MAX_VALUE` avoids an empty-stack special case on the first push.

---

## 6. Design Circular Queue (LeetCode 622)

Design a **circular queue** (ring buffer) with fixed capacity `k`:

- `MyCircularQueue(int k)` — constructor.
- `enQueue(int value)` — insert; return `true` on success, `false` if full.
- `deQueue()` — delete from front; return `false` if empty.
- `Front()` — get front element, `-1` if empty.
- `Rear()` — get last element, `-1` if empty.
- `isEmpty()` / `isFull()` — state checks.

### Approach

A circular queue uses a fixed-size array with two pointers (`front` and `rear`) that wrap around modulo the array size. This avoids the O(n) shifting cost of a naive array queue and the pointer overhead of a linked list. We track `size` explicitly so that `isEmpty` and `isFull` are trivial and we don't lose a slot to distinguish full from empty.

### ASCII Diagram — Circular Queue Wrap-Around

```
   capacity = 5, array indices 0..4

   Empty:     front=0, rear=-1, size=0
   +---+---+---+---+---+
   | . | . | . | . | . |
   +---+---+---+---+---+
     ^
     front

   After enQueue(10,20,30):
   +----+----+----+---+---+
   | 10 | 20 | 30 | . | . |
   +----+----+----+---+---+
     ^         ^
     front     rear        size=3

   After enQueue(40,50) -> full:
   +----+----+----+----+----+
   | 10 | 20 | 30 | 40 | 50 |
   +----+----+----+----+----+
     ^                   ^
     front               rear   size=5

   deQueue() x2 -> front wraps:
   +----+----+----+----+----+
   |  . |  . | 30 | 40 | 50 |
   +----+----+----+----+----+
               ^         ^
               front     rear   size=3

   enQueue(60) -> rear wraps to index 0:
   +----+----+----+----+----+
   | 60 |  . | 30 | 40 | 50 |
   +----+----+----+----+----+
   ^         ^
   rear      front           size=4

   Key formula: rear = (rear + 1) % capacity
                front = (front + 1) % capacity
```

### Full Java Solution

```java
class MyCircularQueue {

    private final int[] queue;
    private final int capacity;
    private int front;
    private int rear;
    private int size;

    public MyCircularQueue(int k) {
        this.queue = new int[k];
        this.capacity = k;
        this.front = 0;
        this.rear = -1; // rear will be advanced before first insert
        this.size = 0;
    }

    public boolean enQueue(int value) {
        if (isFull()) return false;
        rear = (rear + 1) % capacity; // wrap around
        queue[rear] = value;
        size++;
        return true;
    }

    public boolean deQueue() {
        if (isEmpty()) return false;
        front = (front + 1) % capacity; // wrap around
        size--;
        return true;
    }

    public int Front() {
        if (isEmpty()) return -1;
        return queue[front];
    }

    public int Rear() {
        if (isEmpty()) return -1;
        return queue[rear];
    }

    public boolean isEmpty() {
        return size == 0;
    }

    public boolean isFull() {
        return size == capacity;
    }
}
```

### Complexity

- All operations: O(1) time, O(k) space.

### Key Takeaways

- Tracking `size` explicitly is cleaner than the classic "waste one slot" trick to distinguish full from empty.
- The modulo operation `% capacity` is what makes the queue "circular" — pointers never run off the end, they wrap.
- Circular queues power producer-consumer buffers, streaming pipelines, and bounded task queues.

---

## 7. Design Browser History (LeetCode 1472)

Design a browser history simulator:

- `BrowserHistory(String homepage)` — open with the homepage.
- `void visit(String url)` — visit `url` from the current page; this clears all forward history.
- `String back(int steps)` — move `steps` back in history; return the current URL. If steps exceed history, go as far as possible.
- `String forward(int steps)` — move `steps` forward; return current URL.

### Approach

Use an `ArrayList<String>` as the history log and an integer `currentIndex` pointing at the page we're on. `visit` truncates everything after `currentIndex`, appends the new URL, and moves `currentIndex` to it. `back`/`forward` clamp the index within bounds and return the page at that index.

```
   history list:        [a, b, c, d, e]
                         0  1  2  3  4
                                  ^
                          currentIndex=3 (d)

   back(2) -> index=1 (b)
   forward(5) -> clamp to last index = 4 (e)
   visit("z") -> truncate forward history, append z:
                 [a, b, z], index=2
```

### Full Java Solution

```java
class BrowserHistory {

    private final List<String> history;
    private int currentIndex;

    public BrowserHistory(String homepage) {
        history = new ArrayList<>();
        history.add(homepage);
        currentIndex = 0;
    }

    public void visit(String url) {
        // Clear forward history: remove everything after currentIndex
        while (history.size() > currentIndex + 1) {
            history.remove(history.size() - 1);
        }
        history.add(url);
        currentIndex++;
    }

    public String back(int steps) {
        // Move back, but not before index 0
        currentIndex = Math.max(0, currentIndex - steps);
        return history.get(currentIndex);
    }

    public String forward(int steps) {
        // Move forward, but not past the last page
        currentIndex = Math.min(history.size() - 1, currentIndex + steps);
        return history.get(currentIndex);
    }
}
```

### Complexity

- `visit`: O(n) in the worst case (truncating forward history), but amortized O(1) with a `LinkedList` or by overwriting and tracking a `size` cursor.
- `back` / `forward`: O(1).
- Space: O(history length).

### Optimization

To make `visit` O(1), store history in a pre-sized array and track a `lastIndex`. On `visit`, set `history[++currentIndex] = url` and `lastIndex = currentIndex`, overwriting forward entries without removing them. `forward` clamps to `lastIndex`. This avoids list resizing/truncation entirely.

### Key Takeaways

- A single list + index pointer is the cleanest model; no stack or deque needed.
- The `visit` semantics (clear forward history) mirror real browsers — visiting a new page "forks" history.

---

## 8. Design Parking System (LeetCode 1603)

Design a parking system for a lot with a fixed number of slots for three car types: `big`, `medium`, `small`. Implement `addCar(carType)` which returns `true` if a slot of that type is available, parking the car; otherwise `false`.

### Approach

Trivially simple: store the remaining slots for each type in an array indexed by car type, decrement on a successful add.

### Java Solution

```java
class ParkingSystem {

    private final int[] slots; // index 1=big, 2=medium, 3=small

    public ParkingSystem(int big, int medium, int small) {
        slots = new int[4]; // index 0 unused for 1-based carType
        slots[1] = big;
        slots[2] = medium;
        slots[3] = small;
    }

    public boolean addCar(int carType) {
        if (slots[carType] <= 0) return false;
        slots[carType]--;
        return true;
    }
}
```

### Complexity

- O(1) per operation, O(1) space.

### Key Takeaways

- A 1-indexed array maps cleanly to the problem's car-type encoding, avoiding a switch statement or three separate fields.
- Don't over-engineer — the simplest correct solution is the best here.

---

## 9. Design Underground System (LeetCode 1396)

Design an underground railway system that supports:

- `checkIn(int id, String stationName, int t)` — passenger `id` checks in at `stationName` at time `t`.
- `checkOut(int id, String stationName, int t)` — passenger checks out at `stationName` at time `t`.
- `getAverageTime(String startStation, String endStation)` — return the average travel time from `startStation` to `endStation` across all completed journeys.

`getAverageTime` should return a floating-point average in O(1).

### Approach

We track two things:

1. **Active check-ins**: `Map<customerId, CheckIn{stationName, checkInTime}>` — a passenger who has checked in but not yet checked out.
2. **Completed journey stats**: `Map<routeKey, {totalTime, count}>` where `routeKey` = `"start,end"`. We accumulate total time and count so the average is just `totalTime / count` in O(1).

```
   checkIns:    { 5 -> ("King's Cross", 3), 10 -> ("Waterloo", 7) }

   On checkOut(5, "Euston", 12):
     journey time = 12 - 3 = 9
     route = "King's Cross,Euston"
     journeyStats["King's Cross,Euston"] += (9, 1)

   getAverageTime("King's Cross","Euston") = total / count
```

### Full Java Solution

```java
class UndergroundSystem {

    // Active check-ins: customerId -> {stationName, checkInTime}
    private static class CheckIn {
        String station;
        int time;
        CheckIn(String station, int time) {
            this.station = station;
            this.time = time;
        }
    }

    // Accumulated journey stats per route
    private static class Journey {
        int totalTime;
        int count;
    }

    private final Map<Integer, CheckIn> checkIns;
    private final Map<String, Journey> journeyStats; // key = "start,end"

    public UndergroundSystem() {
        checkIns = new HashMap<>();
        journeyStats = new HashMap<>();
    }

    public void checkIn(int id, String stationName, int t) {
        checkIns.put(id, new CheckIn(stationName, t));
    }

    public void checkOut(int id, String stationName, int t) {
        CheckIn checkIn = checkIns.remove(id);
        String routeKey = checkIn.station + "," + stationName;
        Journey journey = journeyStats.computeIfAbsent(routeKey, k -> new Journey());
        journey.totalTime += (t - checkIn.time);
        journey.count++;
    }

    public double getAverageTime(String startStation, String endStation) {
        String routeKey = startStation + "," + endStation;
        Journey journey = journeyStats.get(routeKey);
        return (double) journey.totalTime / journey.count;
    }
}
```

### Complexity

- `checkIn`: O(1).
- `checkOut`: O(1) — HashMap remove + computeIfAbsent.
- `getAverageTime`: O(1) — pre-aggregated totals.
- Space: O(P + R) where P = active passengers, R = distinct routes.

### Key Takeaways

- Pre-aggregating `(totalTime, count)` per route is the key to O(1) average queries. Storing a list of journey times and averaging on demand would be O(n) per query.
- The route key as a concatenated string is simple and collision-free since station names don't contain commas.

---

## 10. Design Trie (LeetCode 208) — Reference

A **trie** (prefix tree) stores strings in a tree where each edge is a character. Common prefixes share nodes, making prefix queries efficient. Tries underpin autocomplete, spell-check, and IP routing tables.

### Structure

```
            root
           /  |  \
          a   b    c
         /    |     \
        p     a      a
       /      |       \
      p       d        t
     /        |        \
    l         |         (isEnd)
    e(isEnd)
```

Stores "apple", "bad", "cat".

### Core Operations

- `insert(word)` — walk/create nodes for each char; mark the final node as `isEnd`.
- `search(word)` — walk nodes; return `true` only if the final node is `isEnd`.
- `startsWith(prefix)` — walk nodes; return `true` if the path exists (regardless of `isEnd`).

### Java Solution

```java
class Trie {

    private static class TrieNode {
        TrieNode[] children = new TrieNode[26];
        boolean isEnd;
    }

    private final TrieNode root;

    public Trie() {
        root = new TrieNode();
    }

    public void insert(String word) {
        TrieNode node = root;
        for (char c : word.toCharArray()) {
            int idx = c - 'a';
            if (node.children[idx] == null) {
                node.children[idx] = new TrieNode();
            }
            node = node.children[idx];
        }
        node.isEnd = true;
    }

    public boolean search(String word) {
        TrieNode node = traverse(word);
        return node != null && node.isEnd;
    }

    public boolean startsWith(String prefix) {
        return traverse(prefix) != null;
    }

    private TrieNode traverse(String s) {
        TrieNode node = root;
        for (char c : s.toCharArray()) {
            int idx = c - 'a';
            if (node.children[idx] == null) return null;
            node = node.children[idx];
        }
        return node;
    }
}
```

### Complexity

- `insert`/`search`/`startsWith`: O(L) where L = word/prefix length.
- Space: O(total characters × alphabet size). For large alphabets (Unicode), use a `HashMap<Character, TrieNode>` per node instead of a fixed array.

### Key Takeaways

- The `isEnd` flag distinguishes a stored word from a mere prefix of a longer word.
- A fixed 26-array is fast for lowercase English; a `HashMap` per node handles arbitrary characters and saves space for sparse nodes.

---

## 11. Insert Delete GetRandom O(1) (LeetCode 380)

Design a data structure that supports `insert(val)`, `remove(val)`, and `getRandom()` — all in **O(1)** average time. `getRandom` must return a random element with uniform probability.

### Approach

The challenge is O(1) `remove` from an array (normally O(n)) AND O(1) uniform-random access (which requires array indexing). The trick: keep an `ArrayList` for O(1) indexed access and a `HashMap<val, index>` for O(1) lookup. To remove in O(1), swap the target element with the last element, update the swapped element's index in the map, then `remove` the last position (which is O(1) for an `ArrayList`).

```
   list:    [10, 20, 30, 40]      map: {10->0, 20->1, 30->2, 40->3}
               0   1   2   3

   remove(20):
     idx = map[20] = 1
     lastVal = list[3] = 40
     list[1] = 40              // overwrite target with last
     list.remove(3)            // O(1) remove at end
     map[40] = 1               // update swapped element's index
     map.remove(20)
   list:    [10, 40, 30]        map: {10->0, 40->1, 30->2}

   getRandom(): list[random.nextInt(size)]
```

### Full Java Solution

```java
class RandomizedSet {

    private final List<Integer> list;
    private final Map<Integer, Integer> valToIndex;
    private final java.util.Random rand;

    public RandomizedSet() {
        list = new ArrayList<>();
        valToIndex = new HashMap<>();
        rand = new java.util.Random();
    }

    public boolean insert(int val) {
        if (valToIndex.containsKey(val)) return false;
        valToIndex.put(val, list.size());
        list.add(val);
        return true;
    }

    public boolean remove(int val) {
        if (!valToIndex.containsKey(val)) return false;
        int idx = valToIndex.get(val);
        int lastVal = list.get(list.size() - 1);
        // Move last element into the removed slot
        list.set(idx, lastVal);
        valToIndex.put(lastVal, idx);
        // Drop the last element
        list.remove(list.size() - 1);
        valToIndex.remove(val);
        return true;
    }

    public int getRandom() {
        return list.get(rand.nextInt(list.size()));
    }
}
```

**Edge case:** if the removed element *is* the last element, the swap is a no-op but still correct — we set `list[idx] = lastVal` (same slot), update `valToIndex[lastVal] = idx` (same index), then remove the last and the map entry. To avoid a redundant map put, guard with `if (idx != list.size() - 1)` before the swap, though the code above works either way.

### Complexity

- All operations: O(1) average.
- Space: O(n).

### Key Takeaways

- The **swap-to-end** trick converts an O(n) arbitrary-index removal into O(1).
- The dual structure (list for indexing, map for lookup) is a recurring pattern — also seen in `RandomizedCollection` (LeetCode 381) and token caches.
- Uniform randomness requires array-backed storage; a `HashSet` cannot provide O(1) random sampling.

---

## 12. Design Snake Game (LeetCode 353)

Design a Snake game on an `n × n` screen with a list of food positions. The snake starts at `(0, 0)` and moves one cell per tick based on a direction input. Eating food grows the snake and increases the score. The game ends if the snake hits the wall or its own body.

### Approach

- Represent the snake as a **deque** of `[row, col]` positions, with the head at the front.
- Use a `Set<String>` for the body cells (excluding the current tail, which will move) for O(1) collision detection.
- Each move: compute the new head position. If out of bounds or in the body set (and it's not the tail that's about to vacate), game over. If food is at the new head, keep the tail (grow) and advance the food pointer. Otherwise, remove the tail from the deque and the set.
- The body set must exclude the tail *before* checking collision, because the tail moves out of the way on a normal step — but not when growing.

### Java Solution

```java
class SnakeGame {

    private final int width, height;
    private final int[][] food;
    private int foodIndex;
    private final Deque<int[]> snake;     // head at front, tail at back
    private final Set<String> body;       // "row,col" of all segments except tail-when-moving

    public SnakeGame(int width, int height, int[][] food) {
        this.width = width;
        this.height = height;
        this.food = food;
        this.foodIndex = 0;
        this.snake = new ArrayDeque<>();
        this.body = new HashSet<>();
        snake.offerFirst(new int[]{0, 0});
        body.add("0,0");
    }

    public int move(String direction) {
        int[] head = snake.peekFirst();
        int newRow = head[0], newCol = head[1];
        switch (direction) {
            case "U": newRow--; break;
            case "D": newRow++; break;
            case "L": newCol--; break;
            case "R": newCol++; break;
        }

        // Wall collision
        if (newRow < 0 || newRow >= height || newCol < 0 || newCol >= width) {
            return -1;
        }

        // Determine if we grow (food at new head)
        boolean grows = foodIndex < food.length
                && food[foodIndex][0] == newRow
                && food[foodIndex][1] == newCol;

        // If not growing, the tail will vacate — remove it from the body set first
        // so we don't falsely detect a self-collision when the snake turns onto its
        // own tail's old position.
        if (!grows) {
            int[] tail = snake.pollLast();
            body.remove(tail[0] + "," + tail[1]);
        }

        // Self-collision check (after tail removed if not growing)
        if (body.contains(newRow + "," + newCol)) {
            return -1;
        }

        // Move head
        snake.offerFirst(new int[]{newRow, newCol});
        body.add(newRow + "," + newCol);

        if (grows) {
            foodIndex++;
        }

        return foodIndex; // score = number of foods eaten
    }
}
```

### Complexity

- `move`: O(1) — deque + set operations.
- Space: O(snake length) = O(score + 1).

### Key Takeaways

- The subtle bug to avoid: checking self-collision **before** removing the moving tail. The tail vacates on a non-growing move, so turning onto its old cell is legal.
- A deque models the snake's head/tail operations naturally; a `Set` gives O(1) collision lookup.

---

## 13. Design Tic-Tac-Toe (LeetCode 348)

Design an `n × n` Tic-Tac-Toe game where `move(row, col, player)` places a mark and returns the winning player (1 or 2) if the move completes a row, column, or diagonal of `n` marks; otherwise returns 0.

### Approach

Instead of scanning the board after each move (O(n)), we keep **running counts** per row, per column, and for the two diagonals. Each player's move increments their counts and decrements the opponent's (or we track separate arrays per player). If any count reaches `+n` (or `-n`), that player wins. This makes `move` O(1).

```
   rows[i], cols[i], diag, antiDiag — each starts at 0.
   Player 1 move adds +1; Player 2 move adds -1.
   If |rows[i]| == n or |cols[i]| == n or |diag| == n or |antiDiag| == n -> winner.
```

### Java Solution

```java
class TicTacToe {

    private final int n;
    private final int[] rows;
    private final int[] cols;
    private int diag;      // top-left to bottom-right
    private int antiDiag;  // top-right to bottom-left

    public TicTacToe(int n) {
        this.n = n;
        this.rows = new int[n];
        this.cols = new int[n];
    }

    public int move(int row, int col, int player) {
        int delta = (player == 1) ? 1 : -1;

        rows[row] += delta;
        cols[col] += delta;
        if (row == col) diag += delta;
        if (row + col == n - 1) antiDiag += delta;

        // Check for a win on this move
        if (Math.abs(rows[row]) == n
                || Math.abs(cols[col]) == n
                || Math.abs(diag) == n
                || Math.abs(antiDiag) == n) {
            return player;
        }
        return 0;
    }
}
```

### Complexity

- `move`: O(1).
- Space: O(n) for the row/col arrays.

### Key Takeaways

- Encoding player 1 as `+1` and player 2 as `-1` lets a single set of counters track both players and a win is `|count| == n`.
- Diagonal membership tests: `row == col` for the main diagonal, `row + col == n - 1` for the anti-diagonal.

---

## 14. Design File System (LeetCode 1166)

Design an in-memory file system that supports:

- `List<String> ls(String path)` — list files/dirs at `path` in lexicographic order. If `path` is a file path, return just that file's name.
- `void mkdir(String path)` — create a directory at `path`.
- `void addContentToFile(String filePath, String content)` — append `content` to the file at `filePath` (creating it if absent).
- `String readContentFromFile(String filePath)` — return the file's content.

### Approach

Model the file system as a **tree of `FileNode` objects**. Each node is either a directory (with a `Map<String, FileNode>` of children) or a file (with a `StringBuilder` of content). The root is a directory node at `/`. Path operations split the path by `/` and walk the tree, creating intermediate directories as needed.

```
   root (dir, "/")
     |
     +-- "a" (dir)
          |
          +-- "b" (dir)
               |
               +-- "c.txt" (file, content="hello")
```

### Java Solution

```java
class FileSystem {

    private static class FileNode {
        boolean isFile;
        String name;
        StringBuilder content;
        Map<String, FileNode> children; // only for directories

        FileNode(String name) {
            this.name = name;
            this.isFile = false;
            this.content = new StringBuilder();
            this.children = new TreeMap<>(); // TreeMap keeps names sorted
        }
    }

    private final FileNode root;

    public FileSystem() {
        root = new FileNode("/");
    }

    // Traverse to the node at path, creating directories along the way if create=true.
    private FileNode traverse(String path, boolean create) {
        String[] parts = path.split("/");
        FileNode curr = root;
        for (String part : parts) {
            if (part.isEmpty()) continue;
            if (!curr.children.containsKey(part)) {
                if (!create) return null;
                curr.children.put(part, new FileNode(part));
            }
            curr = curr.children.get(part);
        }
        return curr;
    }

    public List<String> ls(String path) {
        FileNode node = traverse(path, false);
        List<String> result = new ArrayList<>();
        if (node == null) return result;
        if (node.isFile) {
            result.add(node.name);
        } else {
            result.addAll(node.children.keySet()); // TreeMap -> already sorted
        }
        return result;
    }

    public void mkdir(String path) {
        traverse(path, true);
    }

    public void addContentToFile(String filePath, String content) {
        FileNode node = traverse(filePath, true);
        node.isFile = true;
        node.content.append(content);
    }

    public String readContentFromFile(String filePath) {
        FileNode node = traverse(filePath, false);
        return node.content.toString();
    }
}
```

### Complexity

- `ls`: O(k + m log m) where k = path depth, m = entries in the directory. Using a `TreeMap`, keys are sorted, so listing is O(m).
- `mkdir` / `addContentToFile` / `readContentFromFile`: O(k) where k = path depth.
- Space: O(total nodes + total content).

### Key Takeaways

- A `TreeMap` for children gives sorted `ls` output for free, avoiding a separate sort step.
- Splitting paths by `/` and skipping empty parts (from leading `/`) is the standard path-parsing idiom.
- A single `FileNode` class with an `isFile` flag unifies files and directories — a clean OOP model.

---

## Design Pattern Usage Table

The table below maps each design problem to the core design pattern(s) and data structures it employs.

| Problem | Core Data Structures | Design Pattern / Technique | Key Trick |
|---|---|---|---|
| LRU Cache (146) | HashMap + Doubly Linked List | **Adapter** (node wraps entry), dummy sentinels | Map points to list nodes; move-to-head on access |
| LFU Cache (460) | HashMap + LinkedHashSet (per freq) | **Frequency bucketing**, running minimum | `LinkedHashSet` gives O(1) add/remove + insertion order (LRU tiebreaker) |
| Design HashMap (706) | Array of linked lists | **Separate chaining**, hashing | Dummy head simplifies head removal |
| Design HashSet (705) | Array of linked lists | **Separate chaining** | Same as HashMap, valueless |
| Min Stack (155) | Two stacks | **Auxiliary/Companion stack** | Min stack mirrors with running minimum |
| Circular Queue (622) | Fixed array + 2 pointers + size | **Ring buffer**, modular indexing | `(ptr + 1) % capacity` wraps pointers |
| Browser History (1472) | ArrayList + index | **Cursor/index tracking** | `visit` truncates forward history |
| Parking System (1603) | int array | **Direct indexing** (table lookup) | 1-indexed array matches carType encoding |
| Underground System (1396) | 2 HashMaps | **Aggregation/accumulation** (precompute averages) | Route key = "start,end"; store (total, count) |
| Trie (208) | Tree of nodes w/ child map/array | **Composite/Tree** pattern | `isEnd` distinguishes word from prefix |
| Insert Delete GetRandom (380) | ArrayList + HashMap | **Swap-to-end** for O(1) removal | Map stores index; swap last into removed slot |
| Snake Game (353) | Deque + HashSet | **State machine**, body-as-set | Remove tail before collision check when not growing |
| Tic-Tac-Toe (348) | Counting arrays + diag vars | **Running counters** (accumulate deltas) | Player 1 = +1, Player 2 = -1; win = \|count\| == n |
| File System (1166) | Tree of FileNode (TreeMap children) | **Composite pattern** (file & dir share interface) | TreeMap keeps ls() sorted |

---

## Pattern Recognition Table

When you see these signals in a problem statement, reach for the corresponding pattern.

| Signal / Keywords in Prompt | Pattern to Use | Example Problems |
|---|---|---|
| "O(1) get and put", "evict least recently used" | HashMap + Doubly Linked List | LRU Cache |
| "evict least frequently used", "tie-break by recency" | Freq buckets via LinkedHashSet + running minFreq | LFU Cache |
| "implement without built-in hash libraries", "keys 0..10^6" | Array of buckets + separate chaining | Design HashMap, HashSet |
| "get minimum in O(1)", stack context | Auxiliary min-stack | Min Stack, Max Stack |
| "fixed capacity", "circular", "wrap around", "ring buffer" | Array + 2 modular pointers + size counter | Circular Queue, Ring Buffer |
| "history", "back/forward", "visit clears forward" | ArrayList + index cursor | Browser History |
| "fixed slots per type", "allocate/decrement" | Direct-indexed array | Parking System |
| "average over completed journeys", "check-in/check-out" | Two maps: active state + pre-aggregated stats | Underground System |
| "prefix search", "autocomplete", "word dictionary" | Trie (prefix tree) | Trie, Word Search II |
| "insert/remove/getRandom all O(1)", "uniform random" | ArrayList + val-to-index map; swap-to-end removal | Insert Delete GetRandom |
| "move head/tail", "self-collision", "grows on eat" | Deque (head/tail) + body Set | Snake Game |
| "win on full row/col/diagonal", O(1) move check | Running delta counters per row/col/diag | Tic-Tac-Toe |
| "ls sorted", "mkdir", "append to file", path-based | Tree of nodes (TreeMap children), Composite pattern | File System |
| "O(1) remove from collection + random access" | Swap target with last, then drop last; map for indices | Insert Delete GetRandom, RandomizedCollection |
| "tie-break by insertion order among equals" | LinkedHashSet or LinkedHashMap (insertion/access order) | LFU Cache, LRU via LinkedHashMap |
| "traverse/create path segments" | Split path by `/`, walk/create tree nodes | File System, Trie insert |

---

## General Strategies for Design Problems

1. **Identify the required per-operation complexity first.** The prompt usually states it ("O(1) get/put"). Let that constrain your data structure choices before writing any code.
2. **List every operation and its needed complexity.** A table of `op -> required complexity -> candidate structure` prevents overlooking an expensive operation.
3. **Combine structures when no single one suffices.** LRU needs both a map (lookup) and a list (order). GetRandom needs both a list (indexing) and a map (lookup). This "dual structure" pattern is extremely common.
4. **Use sentinels/dummies to simplify edge cases.** Dummy head/tail nodes (LRU) and a seeded `minStack` (Min Stack) eliminate null checks.
5. **Pre-aggregate for O(1) queries.** If a query asks for an average/sum/count over a growing dataset, accumulate totals on each write so the query is a division (Underground System).
6. **Encode to reduce state.** Player 1 = +1, Player 2 = -1 turns two sets of counters into one (Tic-Tac-Toe). A single `size` field replaces the "waste one slot" full/empty trick (Circular Queue).
7. **Pick collections that give free ordering.** `TreeMap`/`TreeSet` keep keys sorted; `LinkedHashSet`/`LinkedHashMap` preserve insertion or access order — often eliminating an explicit sort step.
8. **Discuss tradeoffs out loud.** Memory vs. speed, write cost vs. read cost, simplicity vs. generality. Interviewers want to hear the reasoning, not just see the code.
9. **Handle edge cases explicitly.** Empty structures, full caches, single-element states, wrap-around indices, and self-collision-when-tail-moves (Snake) are the classic bug sources.
10. **Start with the simplest correct version, then optimize.** A working O(n) solution you can explain beats a half-written O(1) one. Optimize after correctness is clear.

---

## Complexity Summary Table

| Problem | Time (per op) | Space |
|---|---|---|
| LRU Cache | O(1) get/put | O(capacity) |
| LFU Cache | O(1) get/put | O(capacity) |
| Design HashMap | O(1) avg, O(n) worst | O(size + n) |
| Design HashSet | O(1) avg, O(n) worst | O(size + n) |
| Min Stack | O(1) all | O(n) |
| Circular Queue | O(1) all | O(k) |
| Browser History | O(1) back/forward, O(n) visit | O(history) |
| Parking System | O(1) | O(1) |
| Underground System | O(1) all | O(passengers + routes) |
| Trie | O(L) insert/search | O(Σ × nodes) |
| Insert Delete GetRandom | O(1) avg all | O(n) |
| Snake Game | O(1) move | O(snake length) |
| Tic-Tac-Toe | O(1) move | O(n) |
| File System | O(k) per op, O(m) ls | O(nodes + content) |

---

## Closing Notes

Design problems reward **deliberate data structure selection** and **clean encapsulation** over clever algorithmic tricks. The recurring themes are:

- **Dual structures** (map + list, list + map, deque + set) when one structure can't cover all required operations.
- **Running aggregates and counters** to make queries O(1) by paying the cost on writes.
- **Sentinel/dummy nodes** to eliminate edge-case branching.
- **Order-preserving collections** (`LinkedHashSet`, `TreeMap`) to get sorting or recency for free.

Master the eight full solutions above (LRU, LFU, HashMap, GetRandom, Min Stack, Circular Queue, Underground System, Browser History) and the pattern recognition table, and you'll be equipped to handle the vast majority of OOD interview questions. The remaining problems (HashSet, Parking System, Trie, Snake, Tic-Tac-Toe, File System) reinforce the same patterns with lighter or heavier state management.

Practice each solution by hand, explain the tradeoffs aloud, and always confirm the required complexity before committing to a structure. Good luck.

---

## Interview Cheat Sheet

**Key Points to Remember:**

- OOD = classes + relationships + patterns. Identify nouns (classes), verbs (methods), and relationships (inheritance, composition, aggregation).
- Use interfaces for abstractions — Strategy, Factory, and Observer are the most commonly tested design patterns.
- Favor composition over inheritance — it's more flexible and easier to test.
- Encapsulate what varies — isolate the parts of your design that are likely to change behind a stable interface.
- Always start with requirements, then identify entities, then design classes — don't jump to code before understanding the problem.

**Common Follow-Up Questions:**

- *Singleton vs static class?* — Singleton allows lazy initialization, can implement interfaces, and can be passed as a parameter. A static class is simpler but can't be mocked for testing and can't participate in polymorphism.
- *How do you handle extensibility?* — Strategy pattern for interchangeable algorithms, Factory for object creation, Observer for event notification. Choose the pattern that solves the specific extension point, not the most impressive-sounding one.

**Gotcha:**

Over-engineering with design patterns. Don't add a Factory if there's only one implementation. Patterns should solve real problems, not demonstrate knowledge. An interviewer who sees three unnecessary patterns will dock you more than one who sees none.
