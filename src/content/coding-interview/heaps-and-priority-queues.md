---
title: "Heaps & Priority Queues — Interview Prep"
topic: "Coding Interview Prep"
category: "Data Structures & Algorithms"
tags: [heap, priority-queue, java, interview, top-k, median, two-heaps]
difficulty: "medium-to-hard"
last-reviewed: "2026-06-19"
---

# Heaps & Priority Queues

Heaps are the backbone of "top k", "k-th largest", "merge sorted streams", "running median", "scheduling", and "closest points" problems. Once you internalize the heap-as-sorted-buffer trick, most collapse into one skeleton: push elements in, pop what you do not want, keep what remains.

This article covers heap fundamentals, the Java `PriorityQueue` API, canonical patterns, and six fully-worked Java solutions with complexity analysis.

---

## Summary & Interview Framing

A complete binary tree where each node is ≤/≥ its children, supporting O(log n) insert and O(1) min/max access — Java's PriorityQueue.

**How it's asked:** "Kth largest element, top K frequent, merge K sorted lists, median of data stream, find median from data stream — 'top K' or 'running median' problems."

---

## 1. Heap Basics

A **binary heap** is a complete binary tree stored in an array that satisfies the **heap property**:

- **Min-heap**: every node is ≤ its children. The minimum lives at the root.
- **Max-heap**: every node is ≥ its children. The maximum lives at the root.

Because the tree is *complete* (every level filled except possibly the last, filled left-to-right), it packs perfectly into an array with O(1) parent/child arithmetic:

```
For a node at index i (0-based):
  parent(i)      = (i - 1) / 2
  leftChild(i)   = 2 * i + 1
  rightChild(i)  = 2 * i + 2
```

### 1.1 ASCII: Min-heap structure

```
           1
         /   \
        3     6
       / \   / \
      5  9  7   8
     / \
    10 12

Array (0-based): [1, 3, 6, 5, 9, 7, 8, 10, 12]

Index:           0  1  2  3  4  5  6   7   8
```

Notice each parent is ≤ both children, yet the array is **not** fully sorted — only the heap invariant holds. A heap is weaker and cheaper to maintain than a sorted sequence.

### 1.2 Core operations

| Operation     | Description                          | Complexity       |
|---------------|--------------------------------------|------------------|
| `insert`      | Add at end, bubble up (sift up)      | O(log n)         |
| `extractMin`  | Remove root, move last up, sift down | O(log n)         |
| `peek`        | Read root (index 0)                  | O(1)             |
| `heapify`     | Build heap from arbitrary array      | O(n) amortized   |
| `replace`     | Pop root then insert in one step     | O(log n)         |

The O(n) build-heap cost (not O(n log n)) is a classic result: most nodes sit near the leaves where sift-down is cheap, so the total work sums to a linear bound.

### 1.3 Heapify Up (insert)

```
Insert 2 into min-heap below, start at the new leaf.

Step 0: append at end
           1
         /   \
        3     6
       / \
      5   2          <-- 2 added here (violates heap: 2 < 3)

Step 1: compare 2 with parent 3 -> swap
           1
         /   \
        2     6
       / \
      5   3

Step 2: compare 2 with parent 1 -> stop (2 >= 1). Done.
```

### 1.4 Heapify Down (extract)

```
ExtractMin removes root 1. Move last element (3) to root, shrink, sift down.

Step 0: replace root with last element
           3
         /   \
        2     6
       / \
      5   (gone)

Step 1: 3 > left child 2 -> swap with smaller child
           2
         /   \
        3     6
       /
      5

Step 2: 3 <= child 5 -> stop. Heap valid.
```

> **Min-heap vs max-heap for k-th largest**: To find the k-th largest element you keep a **min-heap of size k**. After pushing every element, the heap root *is* the k-th largest (the smallest among the top-k seen so far). Dually, k-th smallest uses a max-heap of size k. Using the "wrong" type of heap and keeping it size-bounded is the #1 trick in this whole category.

---

## 2. PriorityQueue in Java

Java's `java.util.PriorityQueue` is a **min-heap by default**. It implements `Queue`, so you use `add`/`offer` (insert), `poll` (extract min), and `peek` (read min). To get a max-heap, pass a `Comparator.reverseOrder()` (or a custom lambda).

```java
import java.util.PriorityQueue;
import java.util.Collections;
import java.util.Comparator;

// Min-heap (default): smallest first
PriorityQueue<Integer> minHeap = new PriorityQueue<>();
minHeap.offer(5); minHeap.offer(1); minHeap.offer(3);
minHeap.peek();   // 1
minHeap.poll();   // 1 -> heap now [3, 5]

// Max-heap: largest first
PriorityQueue<Integer> maxHeap = new PriorityQueue<>(Collections.reverseOrder());
// or equivalently:
PriorityQueue<Integer> maxHeap2 = new PriorityQueue<>(Comparator.reverseOrder());

// Heap of int[] ranked by first element (e.g. distance), ties broken by index
PriorityQueue<int[]> pq = new PriorityQueue<>(
    (a, b) -> a[0] != b[0] ? Integer.compare(a[0], b[0]) : Integer.compare(a[1], b[1])
);
```

### API cheat sheet

| Method   | Action                              | Throws on empty?     |
|----------|-------------------------------------|----------------------|
| `offer`  | Insert (sift up)                    | No (returns false)   |
| `add`    | Insert (sift up)                    | Yes (capacity*)      |
| `poll`   | Remove and return head (sift down)  | No (returns null)    |
| `remove` | Remove and return head              | Yes                  |
| `peek`   | Return head without removing        | No (returns null)    |
| `element`| Return head without removing        | Yes                  |
| `size`   | Element count                       | —                    |

*`PriorityQueue` is unbounded by default, so `add` effectively never throws.

### Custom objects

For non-natural-order objects, supply a `Comparator` rather than making the class implement `Comparable` — it keeps ordering logic local to the heap usage and avoids polluting the domain class.

```java
// Max-heap of points by distance^2 to origin
PriorityQueue<int[]> closest = new PriorityQueue<>(
    (a, b) -> Integer.compare(b[0]*b[0]+b[1]*b[1], a[0]*a[0]+a[1]*a[1])
);
```

### Gotchas

- **No random access / efficient search**: `pq.contains(x)` is O(n). Keep a parallel `Set`/`Map` if you need membership checks.
- **Iteration order is NOT sorted**: drain via `poll()` to process in priority order.
- **Not thread-safe**: use `PriorityBlockingQueue` for concurrent producers/consumers.
- **No decrease-key**: remove-and-reinsert (O(n)) or push a fresh entry and lazily skip stale ones (the "lazy deletion" pattern from Dijkstra).

---

## 3. The Unifying Insight

**A heap is a sorted buffer of bounded size.** You let it absorb a stream and it discards the irrelevant tail automatically, so the answer is always at the root in O(1). Most heap problems reduce to: push elements in, pop the element you do not want, whatever remains is your answer. The full signal-to-pattern mapping is in the Pattern Cheat Sheet (Section 12).

---

## 4. Approach Comparison: Heap vs Sorting vs Quickselect

| Criterion              | Sorting (Arrays.sort)         | Quickselect (Hoare)             | Heap (size-k PQ)              |
|------------------------|-------------------------------|--------------------------------|-------------------------------|
| Best for               | Need full order, small n      | One-shot k-th, n fits in memory | Streaming / top-k / k << n   |
| Time (k-th largest)    | O(n log n)                    | O(n) avg, O(n^2) worst         | O(n log k)                    |
| Time (top-k)           | O(n log n)                    | O(n) + O(k log k) to sort top  | O(n log k)                    |
| Space                  | O(log n) stack / O(n) copy    | O(log n) recursion             | O(k)                          |
| Streaming friendly?    | No — needs all data first     | No — needs random access       | Yes — push/pop per element    |
| Stable / deterministic | Deterministic (TimSort)       | Non-deterministic (pivot)      | Deterministic                 |
| Handles duplicates     | Yes                           | Yes                            | Yes                           |
| Online (per-element)   | No                            | No                             | Yes                           |
| Implementation cost    | Trivial (1 line)              | Moderate (partition + recurse) | Low (PQ API)                  |
| Worst-case guarantee   | O(n log n)                    | O(n^2) unless randomized       | O(n log k)                    |

**Rules of thumb**: k tiny + streaming data → **heap**. One-shot k-th + n in memory → **quickselect**. Need full order → **sort**. Keywords like "running", "streaming", "online", "so far", "at any time" → **heap** almost certainly.

---

## 5. Solution 1 — Kth Largest Element in an Array

**LeetCode 215.** Given an integer array and an integer k, return the k-th largest element (1-indexed). Do not sort the whole array in the optimal solution.

### Approaches

1. **Sort** descending, return index k-1 — O(n log n). Acceptable but not optimal.
2. **Min-heap of size k** — O(n log k), O(k). The classic; generalizes to streaming.
3. **Quickselect** — O(n) avg, O(n^2) worst. Fastest on average but randomized.

We implement the min-heap approach.

### Intuition

Maintain a min-heap holding the **k largest elements seen so far**. For each new element:

- If heap size < k, push it.
- Else if the element is larger than the heap root, pop the root and push the new element (a "replace").

After processing all elements, the root of the size-k min-heap is the smallest among the top-k = the k-th largest.

```
Array: [3,2,1,5,6,4], k=2
Process 3 -> [3]  2 -> [2,3] (size=2==k, root=2)
1 -> skip(1<2)  5 -> pop2,push5 -> [3,5]  6 -> pop3,push6 -> [5,6]
4 -> skip(4<5)
Root=5. Answer: 5 (2nd largest).
```

### Java solution (min-heap)

```java
class Solution {
    public int findKthLargest(int[] nums, int k) {
        // Min-heap of size k holding the k largest seen so far.
        PriorityQueue<Integer> heap = new PriorityQueue<>();
        for (int x : nums) {
            heap.offer(x);
            if (heap.size() > k) {
                heap.poll();        // evict the smallest of the k+1 largest
            }
        }
        return heap.peek();         // smallest among the top-k = k-th largest
    }
}
```

**Complexity**: O(n log k) time, O(k) space. Each offer/poll is O(log k), and we do n of them but only k evictions matter.

> **Quickselect alternative**: partition around a random pivot, recurse into the side containing the (n-k)-th index. O(n) average, O(n^2) worst (randomized pivot), O(1) space. Faster for one-shot but does not generalize to streaming.

> **Interview tip**: Mention all three approaches, then implement the heap unless the interviewer pushes for quickselect. The heap solution generalizes immediately to streaming data and to "k-th largest in a data stream" variants.

---

## 6. Solution 2 — Merge K Sorted Lists

**LeetCode 23.** You are given an array of k sorted linked lists. Merge them into one sorted list and return its head.

### Intuition

This is the canonical **k-way merge**. At every step, the next smallest overall node is the minimum among the k current list heads. A min-heap of size k gives that minimum in O(log k), so the total cost is O(N log k) where N is the total number of nodes.

```
Lists: 1->4->5, 1->3->4, 2->6
Heap seeded with heads: [1(L0), 1(L1), 2(L2)]
Pop 1->push 4  Pop 1->push 3  Pop 2->push 6  Pop 3->push 4
Pop 4(L0)  Pop 4(L1)  Pop 6(L2)
Output: 1->1->2->3->4->4->5->6
```

### Java solution

```java
import java.util.PriorityQueue;

class ListNode {
    int val;
    ListNode next;
    ListNode() {}
    ListNode(int val) { this.val = val; }
    ListNode(int val, ListNode next) { this.val = val; this.next = next; }
}

class Solution {
    public ListNode mergeKLists(ListNode[] lists) {
        if (lists == null || lists.length == 0) return null;

        // Min-heap ordered by node value; tie-break by list index to avoid
        // comparing ListNode objects directly (which have no natural order).
        PriorityQueue<int[]> pq = new PriorityQueue<>(
            (a, b) -> a[0] != b[0]
                      ? Integer.compare(a[0], b[0])
                      : Integer.compare(a[1], b[1])
        );

        // Seed with each list's head: entry = [value, listIndex].
        for (int i = 0; i < lists.length; i++) {
            if (lists[i] != null) {
                pq.offer(new int[]{lists[i].val, i});
            }
        }

        ListNode dummy = new ListNode(0);
        ListNode tail = dummy;

        while (!pq.isEmpty()) {
            int[] top = pq.poll();          // smallest current head
            int idx = top[1];
            ListNode node = lists[idx];     // the actual node
            tail.next = node;               // append to output
            tail = tail.next;
            lists[idx] = node.next;         // advance that list
            if (lists[idx] != null) {
                pq.offer(new int[]{lists[idx].val, idx});
            }
        }
        tail.next = null;
        return dummy.next;
    }
}
```

**Complexity**: O(N log k) time, O(k) space (heap) + O(1) output pointers (we reuse existing nodes). N = total nodes, k = number of lists.

### Why store `[value, listIndex]` instead of `ListNode` directly?

`ListNode` does not implement `Comparable`, and even if it did, ties on equal values would force a comparison on object identity which Java's comparator contract forbids (can throw `IllegalArgumentException` on some JDKs). Storing the list index as a stable tie-breaker sidesteps this. Alternatively, wrap nodes in a small `class Holder implements Comparable<Holder>`.

### Alternative: divide-and-conquer merge

Pairwise merge the lists in rounds (like merge sort's combine phase): O(N log k) time, O(log k) recursion stack. Same asymptotics, but the heap version is shorter and handles streaming lists naturally.

---

## 7. Solution 3 — Top K Frequent Elements

**LeetCode 347.** Given an integer array and an integer k, return the k most frequent elements. Any order is accepted.

### Intuition

Two phases: **count** frequencies with a HashMap (O(n)), then **select top k**. For selection, use a min-heap of size k keyed by frequency (O(n log k)) — push each (freq, element), evict the least frequent when size > k. Alternatively, bucket sort by frequency gives O(n) time since frequencies are bounded by n. We show the heap version.

### Java solution (min-heap)

```java
import java.util.*;

class Solution {
    public int[] topKFrequent(int[] nums, int k) {
        // Phase 1: count frequencies.
        Map<Integer, Integer> freq = new HashMap<>();
        for (int x : nums) {
            freq.merge(x, 1, Integer::sum);
        }

        // Phase 2: min-heap of size k keyed by frequency.
        // Heap entry = [frequency, element]. Comparator orders by frequency only.
        PriorityQueue<int[]> heap = new PriorityQueue<>(
            Comparator.comparingInt(a -> a[0])
        );

        for (Map.Entry<Integer, Integer> e : freq.entrySet()) {
            heap.offer(new int[]{e.getValue(), e.getKey()});
            if (heap.size() > k) {
                heap.poll();            // drop the least frequent of the k+1
            }
        }

        int[] result = new int[k];
        for (int i = 0; i < k; i++) {
            result[i] = heap.poll()[1];
        }
        return result;
    }
}
```

**Complexity**: O(n + u log k) where u = number of distinct elements (u ≤ n). So O(n log k) worst case, O(k) space for the heap.

> **Bucket sort alternative (O(n) time)**: since frequencies are bounded by n, create n+1 buckets keyed by frequency and walk them high-to-low collecting k elements. Beats the heap when n is large and k is large, but cannot handle streaming because n is unknown ahead of time.

---

## 8. Solution 4 — Find Median from Data Stream

**LeetCode 295.** Design a data structure that supports adding integers and returning the median of all elements seen so far in O(log n) per add.

### The two-heap idea

Keep the **lower half** of numbers in a **max-heap** (`left`) and the **upper half** in a **min-heap** (`right`). Maintain two invariants:

1. **Balanced sizes**: `left.size()` is either equal to `right.size()` or one larger.
2. **Ordering**: every element in `left` ≤ every element in `right`, i.e. `left.peek() <= right.peek()`.

Then:

- If sizes are equal → median = `(left.max + right.min) / 2.0`.
- If `left` has one extra → median = `left.max`.

### ASCII: Two-heap median finder

```
   Numbers seen: [5, 2, 9, 1, 7, 12]

   LEFT (max-heap)       RIGHT (min-heap)
   lower half             upper half
   largest on top         smallest on top

     [ 5 ]                  [ 9 ]
     [ 2 ]                  [ 7 ]
     [ 1 ]                  [ 12 ]

   left.max=5  right.min=9  sizes equal -> median = (5+9)/2 = 7.0
   Invariant: left.max <= right.min  (5 <= 9)  OK
```
```

### Insert algorithm

For a new number `num`:

1. Decide which side: if `left` is empty or `num <= left.peek()`, push to `left`; else push to `right`.
2. **Rebalance**: if `left.size() > right.size() + 1`, move `left` max into `right`; if `right.size() > left.size()`, move `right` min into `left`.
3. The size invariant from step 2 also guarantees the ordering invariant is preserved, because we always move the extreme element across.

### Java solution

```java
import java.util.PriorityQueue;
import java.util.Collections;

class MedianFinder {
    private final PriorityQueue<Integer> left;   // max-heap, lower half
    private final PriorityQueue<Integer> right;  // min-heap, upper half

    public MedianFinder() {
        left  = new PriorityQueue<>(Collections.reverseOrder());
        right = new PriorityQueue<>();
    }

    public void addNum(int num) {
        // Step 1: route to the correct half.
        if (left.isEmpty() || num <= left.peek()) {
            left.offer(num);
        } else {
            right.offer(num);
        }

        // Step 2: rebalance so |left.size - right.size| <= 1 and left >= right by 0 or 1.
        if (left.size() > right.size() + 1) {
            right.offer(left.poll());
        } else if (right.size() > left.size()) {
            left.offer(right.poll());
        }
    }

    public double findMedian() {
        if (left.size() == right.size()) {
            return (left.peek() + right.peek()) / 2.0;
        }
        // By our invariant, left is the larger one when sizes differ.
        return left.peek();
    }
}
```

**Complexity**: `addNum` is O(log n) (one or two heap operations). `findMedian` is O(1). Space O(n).

### Why max-heap for the left half?

We need O(1) access to the *largest* of the lower half — that boundary value participates in the median. A max-heap gives that at the root. Dually, the right half needs O(1) access to its *smallest*, so it is a min-heap. Getting this backwards is the most common bug.

### Extension — Sliding Window Median (LeetCode 480)

The same two-heap structure works, but with a **sliding window** you must *remove* the element leaving the window. `PriorityQueue` has no efficient remove-by-value (O(window size)), so you have two options:

1. **Lazy deletion**: keep a `HashMap<value, countToRemove>` of elements that should be ignored. When peeking, skip any root whose removal count > 0, decrement, and pop. Add lazily-delayed rebalancing. O(n log k) amortized.
2. **Two `TreeSet`/`TreeMap`-backed halves** (or an indexed structure like a Fenwick tree over values): each add/remove is O(log k) with true random access by value. Cleaner to reason about but more code.

The lazy-deletion two-heap approach is the interview-favored answer. Key extra steps:

- On `add`: do the normal two-heap insert.
- On `remove`: increment the lazy-removal count for that value, then "clean" the heads of both heaps (pop while the head value has a pending removal count, decrementing each time). Then rebalance using the *effective* sizes (size minus pending-removal count).
- Median is computed exactly as in the static case, after cleaning.

---

## 9. Solution 5 — K Closest Points to Origin

**LeetCode 973.** Given an array of points and an integer k, return the k points closest to the origin (0,0). Distance is Euclidean; you may return the squared distance to avoid sqrt.

### Intuition

"Closest k of n" is the textbook **size-k max-heap** problem. Keep a max-heap of the k closest so far; for each new point, if it is closer than the farthest in the heap (the root of the max-heap), evict the root and push the new point.

Why a max-heap and not a min-heap? We want to *evict the worst* of the surviving k, and the worst is the **farthest**, which sits at the root of a max-heap ordered by distance. A min-heap of all n would also work but uses O(n) space and O(n log n) time; the size-k max-heap uses O(k) and O(n log k).

```
Points (x,y) with d=x^2+y^2, k=2: (1,3)->10 (2,2)->8 (3,2)->13 (0,1)->1 (5,0)->25

Max-heap (keep k=2 closest), root = farthest survivor:
  Add (1,3): [10]  Add (2,2): [10,8] root=10
  Add (3,2): 13>root 10 -> skip   Add (0,1): 1<root 10 -> pop 10, push 1 -> [8,1]
  Add (5,0): 25>root 8 -> skip
Final: {8,1} -> points (2,2) and (0,1).
```

### Java solution

```java
import java.util.PriorityQueue;
import java.util.Comparator;

class Solution {
    public int[][] kClosest(int[][] points, int k) {
        // Max-heap of size k ordered by squared distance (descending).
        // Stores the point array; comparator computes distance on the fly.
        PriorityQueue<int[]> heap = new PriorityQueue<>(
            (a, b) -> Integer.compare(
                b[0] * b[0] + b[1] * b[1],
                a[0] * a[0] + a[1] * a[1]
            )
        );

        for (int[] p : points) {
            heap.offer(p);
            if (heap.size() > k) {
                heap.poll();          // evict the farthest of the k+1 closest
            }
        }

        int[][] result = new int[k][];
        for (int i = 0; i < k; i++) {
            result[i] = heap.poll();
        }
        return result;
    }
}
```

**Complexity**: O(n log k) time, O(k) space.

### Variants and notes

- **Avoid `sqrt`**: comparing squared distances gives identical ordering and keeps everything in integer math — no floating-point drift.
- **Quickselect** (partition around the k-th smallest distance) gives O(n) average and O(1) extra space (in-place). Faster for one-shot, large n, small k. Same trade-off as in Section 4.
- **Ties**: the canonical problem guarantees unique answer sets. If ties are possible and you must break them deterministically (e.g., lexicographically by x then y), add that tie-break into the comparator.

---

## 10. Solution 6 — Task Scheduler

**LeetCode 621.** Given a char array of tasks and a cooldown `n` (same task must be separated by at least n idle slots), return the minimum number of intervals to finish all tasks.

### Intuition (greedy + max-heap + cooldown queue)

At each time step we want to run the **most-remaining task that is not currently cooling down**. Greedy: always pick the task with the highest remaining count that is available. After running a task, it becomes unavailable for `n` ticks, then becomes available again.

Implementation:

- A **max-heap of remaining counts** for tasks that are currently available.
- A **FIFO queue** (cooldown) of `(count, readyTime)` for tasks that just ran and are waiting out their cooldown. When `time` reaches `readyTime`, move them back into the heap.
- Loop: pop the largest available count, decrement, if still > 0 push `(count, time + n)` into the cooldown queue; tick the clock. If nothing is available, the CPU idles (still tick the clock).

```
tasks = A A A B B B, n = 2  -> counts: A=3, B=3

t0: run A (A=2,B=3)  t1: run B (A=2,B=2)  t2: A frees, run A (A=1,B=2)
t3: B frees, run B (A=1,B=1)  t4: A frees, run A (A=0,B=1)  t5: run B (done)

Sequence: A B _ A B _ A B  -> 8 intervals.
```

### Java solution (simulation)

```java
import java.util.*;

class Solution {
    public int leastInterval(char[] tasks, int n) {
        // Count remaining work per task.
        int[] counts = new int[26];
        for (char c : tasks) counts[c - 'A']++;

        // Max-heap of available remaining counts.
        PriorityQueue<Integer> available = new PriorityQueue<>(Collections.reverseOrder());
        for (int c : counts) if (c > 0) available.offer(c);

        // Cooldown queue: entries [remainingCount, readyTime].
        // Using LinkedList as a deque keeps the head inspection cheap.
        Deque<int[]> cooling = new ArrayDeque<>();

        int time = 0;
        while (!available.isEmpty() || !cooling.isEmpty()) {
            // Release any tasks whose cooldown has elapsed.
            while (!cooling.isEmpty() && cooling.peek()[1] <= time) {
                available.offer(cooling.poll()[0]);
            }

            if (available.isEmpty()) {
                // No task can run: CPU idles. Jump to next release time to avoid
                // looping tick-by-tick through long idle stretches.
                time = cooling.peek()[1];
                continue;
            }

            int remaining = available.poll() - 1;   // run one instance of the task
            time++;
            if (remaining > 0) {
                cooling.offer(new int[]{remaining, time + n});
            }
        }
        return time;
    }
}
```

**Complexity**: O(total intervals) in the worst case, which can be O(tasks + idleSlots). The "jump to next release" optimization avoids per-tick idle loops. Space O(26) = O(1).

### The closed-form formula (interviewers love this)

```
Let maxFreq = highest count among all tasks.
Let numMax  = how many tasks share that maxFreq.

answer = max( tasks.length, (maxFreq - 1) * (n + 1) + numMax )
```

The idea: lay down `(maxFreq - 1)` blocks of length `(n + 1)` (one run of the hottest task plus n cooldown slots), then append the final run of each task tying for max frequency. If other tasks fill idle slots completely, the answer is just `tasks.length`. O(n) time, O(1) space — much simpler, but the simulation is what demonstrates the heap-and-queue technique interviewers are testing. Know both.

---

## 11. Related Patterns (short notes)

### 11.1 Last Stone Weight (LeetCode 1046)

Smash the two heaviest stones each turn; if unequal, the remainder goes back. Pure **max-heap**: keep all weights in a max-heap, repeatedly pop two, push the difference if nonzero. O(n log n) time, O(n) space.

```java
class Solution {
    public int lastStoneWeight(int[] stones) {
        PriorityQueue<Integer> pq = new PriorityQueue<>(Collections.reverseOrder());
        for (int s : stones) pq.offer(s);
        while (pq.size() > 1) {
            int y = pq.poll(), x = pq.poll();
            if (y != x) pq.offer(y - x);
        }
        return pq.isEmpty() ? 0 : pq.peek();
    }
}
```

### 11.2 Design Twitter (LeetCode 355)

`getNewsFeed(userId)` returns the k most recent tweets from the user and their followees. Two designs:

- **Per-user feed merged on demand (heap)**: store each user's tweets newest-first. To get the feed, collect each followee's (+ self) head tweet into a **max-heap by timestamp**, pop up to 10, pushing each user's next-newest tweet after popping. This is **k-way merge** like Merge K Sorted Lists. O(F + 10 log F) per call, F = followees.
- **Fan-out on write**: push each tweet into every follower's bounded timeline. `getNewsFeed` is O(10) but write amplification is huge for users with millions of followers.

The on-demand merge with a heap is the answer interviewers want because it mirrors Merge K Sorted Lists and avoids fan-out scaling problems.

Compact skeleton (k-way merge of per-user tweet lists):

```java
class Twitter {
    private static int ts = 0;
    private Map<Integer, Deque<int[]>> tweets = new HashMap<>();   // userId -> [(ts, tweetId)]
    private Map<Integer, Set<Integer>> following = new HashMap<>();

    public void postTweet(int u, int tid) {
        tweets.computeIfAbsent(u, k -> new ArrayDeque<>())
              .push(new int[]{ts++, tid});
    }
    public List<Integer> getNewsFeed(int u) {
        PriorityQueue<int[]> pq = new PriorityQueue<>((a,b) -> b[0]-a[0]); // max-heap by ts
        Map<Integer, Iterator<int[]>> it = new HashMap<>();
        Set<Integer> src = new HashSet<>(following.getOrDefault(u, Set.of()));
        src.add(u);
        for (int s : src) {
            Deque<int[]> dq = tweets.get(s);
            if (dq != null && !dq.isEmpty()) {
                it.put(s, dq.iterator());
                int[] f = it.get(s).next();
                pq.offer(new int[]{f[0], f[1], s});
            }
        }
        List<Integer> feed = new ArrayList<>();
        while (feed.size() < 10 && !pq.isEmpty()) {
            int[] top = pq.poll();
            feed.add(top[1]);
            if (it.get(top[2]).hasNext()) {
                int[] n = it.get(top[2]).next();
                pq.offer(new int[]{n[0], n[1], top[2]});
            }
        }
        return feed;
    }
    public void follow(int a, int b) { following.computeIfAbsent(a, k -> new HashSet<>()).add(b); }
    public void unfollow(int a, int b) { Set<Integer> s = following.get(a); if (s != null) s.remove(b); }
}
```

`follow`/`unfollow` are O(1); `postTweet` is O(1); `getNewsFeed` is O(F + 10 log F) where F = followee count. The k-way-merge skeleton is identical to Merge K Sorted Lists — same pattern, different domain object.

### 11.3 Sliding Window Median (LeetCode 480)

Discussed in Section 8's extension. The key new piece versus Find Median from Data Stream is **removal of the outgoing element**, handled with lazy deletion (a removal-count map) plus head-cleaning, or by replacing the two heaps with two `TreeMap`s for true O(log k) removal.

---

## 12. Comparison Summary Table

| Problem                       | Heap type / size         | Time             | Space  | Key trick                                   |
|-------------------------------|--------------------------|------------------|--------|---------------------------------------------|
| Kth Largest in Array          | min-heap, size k         | O(n log k)       | O(k)   | size-k buffer; root is the answer           |
| Merge K Sorted Lists          | min-heap, size k         | O(N log k)       | O(k)   | k-way merge; seed with all heads            |
| Top K Frequent Elements       | min-heap, size k         | O(n log k)       | O(k)   | count then select; bucket sort is O(n)      |
| Find Median from Data Stream  | max-heap + min-heap      | O(log n) add     | O(n)   | two halves, balance sizes, ordering inv.    |
| Sliding Window Median         | two heaps + lazy del.    | O(n log k)       | O(k)   | lazy-removal map + head cleaning            |
| K Closest Points to Origin    | max-heap, size k         | O(n log k)       | O(k)   | keep k closest; evict farthest              |
| Last Stone Weight             | max-heap, size n         | O(n log n)       | O(n)   | pop two, push difference                    |
| Task Scheduler (simulation)   | max-heap + cooldown deque| O(intervals)     | O(1)*  | greedy + cooldown queue; *26 distinct       |
| Task Scheduler (formula)      | none                     | O(n)             | O(1)   | (maxFreq-1)*(n+1) + numMax                  |
| Design Twitter (getNewsFeed)  | max-heap, size F         | O(F + 10 log F)  | O(F)   | k-way merge over per-user tweet lists       |

\* Space for the counts array is O(alphabet size) = O(1) for uppercase letters.

---

## 13. Pattern Cheat Sheet (when you see this, do this)

| Signal in the problem statement                               | Use this heap pattern                              | Canonical problem(s)                       |
|---------------------------------------------------------------|----------------------------------------------------|--------------------------------------------|
| "k-th largest" / "k-th smallest"                              | Size-k min-heap (largest) or max-heap (smallest)   | Kth Largest, Kth Smallest                  |
| "top k" / "most frequent k" / "k closest"                     | Size-k heap of survivors; evict worst each step    | Top K Frequent, K Closest Points           |
| "merge k sorted ..."                                          | Min-heap of current heads; pop & advance           | Merge K Sorted Lists, Merge K Sorted Arrays|
| "running median" / "median so far" / "balance two halves"     | Max-heap (left) + min-heap (right), rebalance       | Find Median from Data Stream               |
| "sliding window" + "median/order statistic"                   | Two heaps + lazy deletion OR two TreeMaps          | Sliding Window Median                      |
| "schedule with cooldown" / "spacing"                          | Max-heap of counts + cooldown deque (or formula)   | Task Scheduler                             |
| "news feed" / "top k from multiple sources"                   | k-way merge with max-heap over source heads        | Design Twitter                             |
| "stream of numbers" + "query k-th/median/top-k"               | Size-bounded heap that persists across calls       | Kth Largest in Data Stream (LC 703)        |
| "smallest range covering elements from k lists"               | Min-heap of k heads + track max seen so far        | Smallest Range Covering K Lists (LC 632)   |
| "reorganize string so no two adjacent equal"                  | Max-heap of remaining counts, pop two per step     | Reorganize String (LC 767)                 |
| "process jobs with profit/deadline"                           | Min-heap of selected jobs by deadline (greedy)     | Course Schedule III / Job Sequencing       |

### Universal skeleton (memorize this)

```java
PriorityQueue<T> heap = new PriorityQueue<>(/* comparator: WORST survivor at root */);
for (T x : stream) { heap.offer(x); if (heap.size() > k) heap.poll(); }
// heap now holds the k best; root is the marginal (k-th best) element.
```

The comparator is the whole trick: it must rank the element you want to *throw away first* at the root. For "k largest" the throwaway is the smallest → min-heap. For "k closest" the throwaway is the farthest → max-heap by distance. Get that direction right and the rest is mechanical. For the median family, the rebalancing skeleton is exactly the `insert`/`median` pair shown in the Find Median solution (Section 8): route to the correct half, then rebalance so `|left.size - right.size| <= 1` with `left` the larger side.

---

## 14. Common Mistakes and Edge Cases

- **Wrong heap direction**: the survivor heap must surface the element you want to *discard*. For "k largest" the discard is the smallest → min-heap. For "k closest" the discard is the farthest → max-heap. Draw the heap before writing the comparator.
- **Forgetting to size-limit**: pushing all n elements before popping turns O(n log k) into O(n log n). Always `poll` immediately when `size > k`.
- **Comparator ties on non-Comparable payloads**: `PriorityQueue<int[]>` with a comparator returning 0 for distinct entries can throw on some JDKs. Add a stable tie-breaker (e.g., index).
- **Median: flipping the larger half**: fix a convention — we keep `left` (max-heap) one larger. Flip the rebalance condition and the median read together if you change it.
- **Integer math for distances**: use squared Euclidean distance, not `Math.hypot`, to avoid precision issues and slow transcendentals.
- **Iterating a PriorityQueue**: iteration yields array order, not priority order. Drain via `poll` to process in order.
- **Task Scheduler idle loops**: when `n` is large and few tasks remain, jump the clock to the next cooldown release instead of ticking idle slots one by one.
- **Sliding Window Median stale entries**: with lazy deletion, clean BOTH heap heads before computing the median, or you may read a value that has logically left the window.

---

## 15. Complexity Reference & Final Checklist

| Operation                 | Binary heap    | `PriorityQueue` |
|---------------------------|----------------|-----------------|
| Build from n elements     | O(n) amortized | O(n) (constructor) |
| Insert (offer)            | O(log n)       | O(log n)        |
| Extract min/max (poll)    | O(log n)       | O(log n)        |
| Peek (root)               | O(1)           | O(1)            |
| Remove arbitrary element  | O(n) scan      | O(n)            |
| Contains / size           | O(n) / O(1)    | O(n) / O(1)     |

For O(log n) arbitrary remove or decrease-key, use `TreeSet`/`TreeMap` (red-black tree) or an indexed priority queue.

**Pre-coding checklist:**

1. What am I keeping — the k *best* or k *worst*? This decides min-heap vs max-heap.
2. Stream or fixed batch? Stream → size-bounded heap that persists. Batch → also consider sorting/quickselect.
3. Need two halves (median/order-statistics)? Two heaps + rebalance.
4. Need to *remove* specific elements later (window/scheduling)? Plan lazy deletion or a `TreeMap`.
5. Is my comparator total and stable? Add tie-breakers for non-Comparable payloads.
6. Am I calling `poll` as soon as `size > k`? Keep the heap bounded every iteration.

Master the size-k survivor heap and the two-heap rebalance and you cover roughly 80% of heap questions in interviews. The rest are variations where the *payload* changes (tweets, points, lists, tasks) but the *skeleton* does not.

## Interview Cheat Sheet

**Key Points to Remember:**
- Heap = complete binary tree with heap property (min-heap: parent ≤ children).
- Java: PriorityQueue (min-heap by default, use Comparator.reverseOrder() for max-heap).
- Size-K survivor: keep heap of size K, push new element, pop smallest — O(n log K).
- Two-heap median: max-heap for lower half, min-heap for upper half, rebalance to keep sizes within 1.

**Common Follow-Up Questions:**
- "Heap sort vs Arrays.sort?" — Arrays.sort uses TimSort (O(n log n), stable, optimized for partially sorted). Heap sort is O(n log n) but not stable and has worse cache behavior. Use Arrays.sort for actual sorting; use heaps for streaming top-K.
- "How do you implement a heap?" — Array where parent at index i has children at 2i+1 and 2i+2. Sift-up for insert, sift-down for extract.

**Gotcha:**
- Using a max-heap when you need the K smallest (or vice versa). For "Kth largest," use a MIN-heap of size K — the root is the Kth largest. For "Kth smallest," use a MAX-heap of size K. Getting this backwards is the most common heap interview mistake.
