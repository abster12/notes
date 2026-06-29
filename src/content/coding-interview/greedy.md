---
title: "Greedy Algorithms — Coding Interview Prep"
tags: [coding-interview, greedy, algorithms, java]
category: "Coding Interview Prep"
date: 2026-06-19
difficulty: medium-hard
topics:
  - greedy algorithms
  - interval scheduling
  - jump game
  - gas station
  - meeting rooms
  - candy
  - remove k digits
  - assign cookies
  - huffman coding
  - knapsack
leetcode_problems:
  - "55. Jump Game"
  - "45. Jump Game II"
  - "134. Gas Station"
  - "253. Meeting Rooms II"
  - "455. Assign Cookies"
  - "402. Remove K Digits"
  - "135. Candy"
  - "621. Task Scheduler"
  - "406. Queue Reconstruction by Height"
  - "763. Partition Labels"
  - "452. Minimum Arrows to Burst Balloons"
  - "435. Non-overlapping Intervals"
---

# Greedy Algorithms — Coding Interview Prep

> "A greedy algorithm makes the locally optimal choice at each stage with the hope of finding a global optimum."

Greedy algorithms are among the most elegant and frequently tested patterns in coding interviews. They are short to code, often O(n log n) or O(n), but the real challenge is **proving correctness** — knowing *why* the greedy choice is safe. This article covers the theory, the canonical problems, full Java solutions, ASCII diagrams, and pattern recognition tables to help you recognize greedy problems on sight.

---

## Summary & Interview Framing

Algorithms that make the locally optimal choice at each step, correct when the problem has the greedy-choice property.

**How it's asked:** "Activity selection, jump game, gas station, task scheduler, interval partitioning — 'find the minimum/maximum' problems where local optima lead to global optima."

---

## Table of Contents

1. [What Is a Greedy Algorithm?](#1-what-is-a-greedy-algorithm)
2. [When Does Greedy Work? (Matroids & Exchange Arguments)](#2-when-does-greedy-work)
3. [Interval Scheduling — The Canonical Greedy Problem](#3-interval-scheduling)
4. [Jump Game I (LeetCode 55)](#4-jump-game-i)
5. [Jump Game II (LeetCode 45)](#5-jump-game-ii)
6. [Gas Station (LeetCode 134)](#6-gas-station)
7. [Meeting Rooms II (LeetCode 253)](#7-meeting-rooms-ii)
8. [Assign Cookies (LeetCode 455)](#8-assign-cookies)
9. [Remove K Digits (LeetCode 402)](#9-remove-k-digits)
10. [Candy (LeetCode 135)](#10-candy)
11. [Task Scheduler (LeetCode 621)](#11-task-scheduler)
12. [Queue Reconstruction by Height (LeetCode 406)](#12-queue-reconstruction-by-height)
13. [Partition Labels (LeetCode 763)](#13-partition-labels)
14. [Minimum Arrows to Burst Balloons (LeetCode 452)](#14-minimum-arrows-to-burst-balloons)
15. [Huffman Coding — Conceptual](#15-huffman-coding)
16. [Fractional vs 0/1 Knapsack](#16-fractional-vs-01-knapsack)
17. [Greedy vs DP — Comparison Table](#17-greedy-vs-dp)
18. [Pattern Recognition Table](#18-pattern-recognition-table)

---

## 1. What Is a Greedy Algorithm?

A greedy algorithm builds a solution piece by piece by always choosing the next piece that offers the most immediate benefit. The key properties:

- **Locally optimal choices**: At each step, pick the best option *right now* without looking ahead.
- **No backtracking**: Once a choice is made, it is never reconsidered.
- **Irrevocable commitments**: Decisions are final.

### The Greedy Template

```
1. Define what "best" means at each step (the greedy choice).
2. Sort or preprocess the input so the greedy choice is easy to find.
3. Iterate: make the greedy choice, commit, advance.
4. Return the accumulated solution.
```

### Greedy vs Other Paradigms

| Property | Greedy | Dynamic Programming | Divide & Conquer |
|----------|--------|---------------------|-------------------|
| Overlapping subproblems | No | Yes | No |
| Optimal substructure | Yes | Yes | Yes |
| Choice strategy | Local best at each step | Explore all choices | Split & combine |
| Backtracking | No | Implicit (memoized) | No |
| Time complexity | Usually O(n log n) | O(n²)–O(n³) typical | O(n log n) typical |
| Correctness proof | Hardest part | Relatively systematic | Usually straightforward |
| Guarantees optimal? | Only if provable | Always (if formulated correctly) | Depends on problem |

---

## 2. When Does Greedy Work?

This is the most important theoretical question. Greedy does **not** always produce an optimal solution. Two formal frameworks tell us when it does:

### 2.1 Matroid Theory

A **matroid** is a combinatorial structure (S, I) where S is a finite set and I is a family of "independent" subsets satisfying:

1. **Hereditary**: If B ∈ I and A ⊆ B, then A ∈ I.
2. **Exchange property**: If A, B ∈ I and |A| < |B|, then there exists an element x ∈ B \ A such that A ∪ {x} ∈ I.

**Theorem (Rado-Edmonds):** If the feasible solutions of an optimization problem form a matroid, then the greedy algorithm — sorting elements by weight and adding them if independence is maintained — yields an optimal solution.

```
GREEDY-MATROID(S, w):
  Sort S by weight (descending for maximization)
  Result = {}
  for each element e in sorted S:
    if Result ∪ {e} is independent:
      Result = Result ∪ {e}
  return Result
```

Classic matroid examples where greedy is optimal:
- **Minimum Spanning Tree** (Kruskal's, Prim's) — graphic matroid
- **Task scheduling with deadlines** — scheduling matroid
- **Huffman coding** — related to matroid-like structures
- **Unit-time task scheduling** — transversal matroid

### 2.2 Exchange Argument (The Interview-Friendly Proof)

Most interview problems are **not** formal matroids, so we use the **exchange argument**:

```
EXCHANGE ARGUMENT STRUCTURE:
1. Assume OPT is an optimal solution that differs from the GREEDY solution.
2. Find the first point where OPT and GREEDY differ.
3. Show you can modify OPT (exchange one element) without making it worse,
   bringing it closer to GREEDY.
4. By induction, OPT can be transformed into GREEDY without loss of quality.
5. Therefore GREEDY is also optimal.
```

#### Example Exchange Argument: Interval Scheduling

**Claim:** Sorting intervals by earliest finish time and greedily selecting non-overlapping intervals gives the maximum count.

**Proof sketch:**
- Let GREEDY pick intervals g₁, g₂, ..., gₖ (by earliest finish time).
- Let OPT pick intervals o₁, o₂, ..., oₘ with m ≥ k (optimal is at least as good).
- Compare g₁ and o₁. Since g₁ has the earliest finish time among all intervals, f(g₁) ≤ f(o₁).
- If g₁ ≠ o₁, replace o₁ with g₁ in OPT. This doesn't cause any overlap because g₁ finishes no later than o₁ did.
- By induction, replace each oᵢ with gᵢ. Since GREEDY picked greedily, k ≥ m.
- But m ≥ k by assumption, so k = m. GREEDY is optimal. ∎

```
  Exchange Argument Visualization:

  GREEDY:  [==g1==]    [==g2==]    [==g3==]
  OPT:        [===o1===]   [===o2===]   [===o3===]

  Step 1: g1 finishes <= o1 finishes, so swap o1 -> g1 (no new conflicts)
  Step 2: g2 finishes <= o2 finishes (given g1 was placed), swap o2 -> g2
  ...
  Result: OPT transformed into GREEDY with same count => GREEDY is optimal
```

### 2.3 When Greedy Fails

Greedy fails when a locally optimal choice blocks a better global solution. Classic counterexample: **0/1 Knapsack**.

```
Items:  {weight=3, value=5}, {weight=2, value=3}, {weight=2, value=3}
Capacity = 4

Greedy by value/weight ratio:
  Pick item 1 (ratio 5/3 ≈ 1.67) -> remaining capacity = 1 -> can't fit anything
  Total value = 5

Optimal:
  Pick items 2 and 3 (total weight 4) -> total value = 6
```

The greedy choice (highest ratio item) was globally suboptimal because it wasted capacity. This is why 0/1 knapsack needs DP.

---

## 3. Interval Scheduling

Interval scheduling is the **canonical greedy problem** and the foundation for many interview questions.

### 3.1 The Core Problem: Maximum Non-Overlapping Intervals

Given n intervals, find the maximum number of non-overlapping intervals you can select.

**Greedy choice:** Always pick the interval with the **earliest end time**. This leaves the maximum remaining time for future intervals.

```
  Interval Scheduling — Earliest Finish Time (EFT) Strategy

  Input intervals (sorted by end time):
  A: [1, 3]
  B: [2, 5]
  C: [4, 6]
  D: [6, 8]
  E: [5, 7]
  F: [7, 9]

  Timeline:
  1   2   3   4   5   6   7   8   9
  |---|---|---|---|---|---|---|---|
  [===A===]                      <- pick A (ends at 3)
      [=====B=====]              <- skip B (overlaps A)
          [===C===]              <- pick C (starts at 4 >= 3)
              [===E===]          <- skip E (overlaps C)
                  [===D===]      <- pick D (starts at 6 >= 6)
                      [===F===]  <- pick F (starts at 7 >= 8? No, 7 < 8, skip)

  Wait, let's recheck: F starts at 7, D ends at 8 -> F overlaps D. Skip F.
  Selected: A, C, D -> 3 intervals
```

**Why earliest end time (not earliest start time, not shortest interval)?**

```
  Why NOT shortest interval first?

  Short = good?  Not necessarily:

  Case 1: Short interval blocks two longer ones
     [======long======] [======long======]
         [==short==]        <- picking short loses both longs

  Case 2: Earliest start?
     [=========early start, very long=========]
              [==short==] [==short==] [==short==]
     <- picking the early-start blocks 3 short intervals

  Earliest FINISH is safe because it maximizes remaining space.
```

### 3.2 Related Interval Problems

| Problem | LeetCode | Greedy Strategy |
|---------|----------|-----------------|
| Non-overlapping Intervals | 435 | Sort by end, count removals (total - kept) |
| Meeting Rooms I | 252 | Sort by start, check consecutive overlap |
| Meeting Rooms II | 253 | Min rooms = max concurrent meetings (heap or sweep line) |
| Merge Intervals | 56 | Sort by start, merge overlapping |
| Insert Interval | 57 | Insert then merge |
| Minimum Arrows to Burst Balloons | 452 | Sort by end, count arrow placements |
| Partition Labels | 763 | Extend partition to last occurrence of each char |

### 3.3 Non-Overlapping Intervals (LeetCode 435) — Solution

```java
// LeetCode 435: Non-overlapping Intervals
// Find minimum number of intervals to remove to make rest non-overlapping.
// = total intervals - maximum non-overlapping intervals we can keep.
class Solution {
    public int eraseOverlapIntervals(int[][] intervals) {
        if (intervals.length == 0) return 0;

        // Sort by end time (greedy: earliest finish first)
        Arrays.sort(intervals, (a, b) -> Integer.compare(a[1], b[1]));

        int count = 1;          // number of non-overlapping intervals we keep
        int end = intervals[0][1];

        for (int i = 1; i < intervals.length; i++) {
            if (intervals[i][0] >= end) {
                // No overlap -> keep this interval
                count++;
                end = intervals[i][1];
            }
            // Else: overlaps -> skip (remove) this interval
        }

        return intervals.length - count;
    }
}
// Time: O(n log n), Space: O(1) or O(n) for sort
```

---

## 4. Jump Game I

**LeetCode 55** | Difficulty: Medium

You are given an array `nums` where `nums[i]` represents the maximum jump length from position `i`. Return `true` if you can reach the last index.

### Approach: Greedy — Track Maximum Reach

Instead of DP or BFS, maintain the **farthest index reachable so far**. As we iterate left to right, if we ever reach a point beyond our current max reach, we're stuck.

```
  Jump Game I — Greedy Reach Tracking

  nums = [2, 3, 1, 1, 4]
  index: 0  1  2  3  4

  i=0: maxReach = max(0, 0+2) = 2   can reach index 2
       |----->  (0 can jump to 1 or 2)

  i=1: i(1) <= maxReach(2)? Yes
       maxReach = max(2, 1+3) = 4   can reach index 4 (the end!)
       |--------->  (1 can jump to 2, 3, or 4)

  i=2: i(2) <= maxReach(4)? Yes
       maxReach = max(4, 2+1) = 4

  i=3: maxReach still 4 >= last index 4 -> return true

  Failure example: nums = [3, 2, 1, 0, 4]
  i=0: maxReach = 3
  i=1: maxReach = 3
  i=2: maxReach = 3
  i=3: maxReach = 3, but i=3 and next i=4 > maxReach=3 -> STUCK -> false
```

### Java Solution

```java
// LeetCode 55: Jump Game
// Greedy: track the farthest reachable index.
class Solution {
    public boolean canJump(int[] nums) {
        int maxReach = 0;
        int n = nums.length;

        for (int i = 0; i < n; i++) {
            // If current index is beyond max reach, we're stuck
            if (i > maxReach) return false;

            // Update the farthest we can reach from here
            maxReach = Math.max(maxReach, i + nums[i]);

            // Early exit: if we can already reach the last index
            if (maxReach >= n - 1) return true;
        }

        return true;
    }
}
// Time: O(n), Space: O(1)
```

### Why Greedy Works Here

At each position, we don't need to decide *which* jump to make — we only need to know *whether* the last index is reachable. The maximum reach is monotonically non-decreasing as long as we can access the next position. If `i <= maxReach` for all `i`, the end is reachable.

---

## 5. Jump Game II

**LeetCode 45** | Difficulty: Medium

Return the **minimum number of jumps** to reach the last index (guaranteed reachable).

### Approach: Greedy — BFS Levels / Window Jumping

Think of it as BFS in an array. Each "level" is the set of indices reachable with `jumps` jumps. We greedily extend the farthest boundary of the current level, and when we finish the level, we increment the jump count.

```
  Jump Game II — BFS Level Greedy

  nums = [2, 3, 1, 1, 4]
  index: 0  1  2  3  4

  Level 0 (0 jumps): {0}
    From 0, can reach 1..2  -> nextEnd = 2
    i reaches currentEnd(0) -> jumps=1, currentEnd=2

  Level 1 (1 jump):  {1, 2}
    From 1, can reach 2..4  -> nextEnd = 4
    From 2, can reach 3     -> nextEnd = 4 (max)
    i reaches currentEnd(2) -> jumps=2, currentEnd=4

  Level 2 (2 jumps): {3, 4}
    currentEnd(4) >= last index -> done! Answer = 2

  Visualization:
  [2] [  3  |  1  ] [  1  |  4  ]
   L0    L1          L2
   ^     ^---^        ^---^
   jump  jump          jump -> reaches end
```

### Java Solution

```java
// LeetCode 45: Jump Game II
// Greedy BFS: treat reachable ranges as BFS levels.
class Solution {
    public int jump(int[] nums) {
        int n = nums.length;
        if (n <= 1) return 0;

        int jumps = 0;
        int currentEnd = 0;   // end of the current BFS level
        int farthest = 0;     // farthest index reachable from current level

        for (int i = 0; i < n - 1; i++) {  // stop before last index
            farthest = Math.max(farthest, i + nums[i]);

            // When we reach the boundary of the current level,
            // we must jump to continue
            if (i == currentEnd) {
                jumps++;
                currentEnd = farthest;

                // Early exit if we can already reach the last index
                if (currentEnd >= n - 1) break;
            }
        }

        return jumps;
    }
}
// Time: O(n), Space: O(1)
```

### Why Greedy Is Optimal Here

The BFS-level framing guarantees minimality: each level contains exactly the set of indices reachable in `jumps` jumps but not fewer. By always extending the farthest boundary, we cover the maximum territory per jump. This is optimal because any solution reaching the end in fewer jumps would imply a level we missed, contradicting the farthest-extension logic.

---

## 6. Gas Station

**LeetCode 134** | Difficulty: Medium

There are `n` gas stations along a circular route. You have a car with unlimited gas tank. Return the starting station index if you can travel around the circuit once, else return -1.

### Key Insight

Two critical observations make this greedy:

1. **Total gas vs total cost:** If total gas >= total cost, a solution **must exist**. If total gas < total cost, no solution exists.
2. **Greedy reset:** If you start at station `i` and run out of gas between station `j` and `j+1`, then **no station between `i` and `j` can be a valid start** (because each had a non-negative surplus when you passed it, so starting later only reduces your reserve). Skip ahead to `j+1`.

```
  Gas Station — Greedy Reset Logic

  gas  = [1, 2, 3, 4, 5]
  cost = [3, 4, 5, 1, 2]
  net  = [-2, -2, -2, 3, 3]   (gas[i] - cost[i])

  Start at 0: tank = -2 -> run out. Skip to index 1.
  Start at 1: tank = -2 -> run out. Skip to index 2.
  Start at 2: tank = -2 -> run out. Skip to index 3.
  Start at 3: tank = 3  -> ok
    -> 4: tank = 3+3 = 6 -> ok
    -> 0: tank = 6-2 = 4 -> ok
    -> 1: tank = 4-2 = 2 -> ok
    -> 2: tank = 2-2 = 0 -> ok, back to start!

  Total net = -2-2-2+3+3 = 0 >= 0 -> solution exists
  Answer = 3

  Why skip i..j when we fail at j?
  If we started at i with tank=0 and reached j with tank>=0 but
  failed at j+1, then starting at any k in (i, j] would give us
  tank=0 at k (we reset) but LESS accumulated surplus, so we'd
  still fail at j+1. So skip to j+1.
```

### Java Solution

```java
// LeetCode 134: Gas Station
// Greedy: if total surplus >= 0, a valid start exists.
// Reset start whenever tank goes negative.
class Solution {
    public int canCompleteCircuit(int[] gas, int[] cost) {
        int totalTank = 0;   // total gas - total cost across all stations
        int currentTank = 0; // tank from current start to here
        int start = 0;       // candidate starting station

        for (int i = 0; i < gas.length; i++) {
            int net = gas[i] - cost[i];
            totalTank += net;
            currentTank += net;

            // If we can't reach the next station from current start,
            // reset: no station between 'start' and 'i' can be valid.
            if (currentTank < 0) {
                start = i + 1;    // try starting from the next station
                currentTank = 0;  // reset tank
            }
        }

        // If total surplus is non-negative, 'start' is the answer.
        // Otherwise, no valid circuit exists.
        return totalTank >= 0 ? start : -1;
    }
}
// Time: O(n), Space: O(1)
```

### Proof of Correctness

- **Total check:** If Σ(gas) < Σ(cost), it's impossible — the car can never have enough total fuel. If Σ(gas) ≥ Σ(cost), we claim a valid start exists.
- **Skip correctness:** When starting at `s` and failing at index `i`, for any `k ∈ [s, i]`, starting at `k` means the car had ≥ 0 surplus at `k` (since it got there from `s`). But starting at `k` with 0 tank gives *less* fuel than arriving at `k` from `s` with a surplus. So starting at `k` also fails at or before `i`. Skipping to `i+1` is safe.
- **Final start:** After one pass, if total ≥ 0, the last reset point `start` must be valid because the remaining segment from `start` to end has non-negative surplus (currentTank never went negative after the last reset), and the total non-negativity guarantees the wrap-around segment also works.

---

## 7. Meeting Rooms II

**LeetCode 253** | Difficulty: Medium (Premium)

Given an array of meeting time intervals, find the minimum number of conference rooms required.

### Approach: Greedy with Min-Heap (or Sweep Line)

Sort meetings by start time. Use a min-heap to track **end times of ongoing meetings**. For each new meeting, if the earliest-ending meeting has ended (its end ≤ new meeting's start), reuse that room (poll the heap). Push the new meeting's end time. The heap size at any point = rooms in use; the max heap size = answer.

```
  Meeting Rooms II — Min-Heap Visualization

  Meetings (sorted by start): [0,30], [5,10], [15,20]

  Process [0,30]:
    Heap: [30]              -> rooms = 1
    |============================== 30

  Process [5,10]:
    Earliest end in heap = 30. 5 < 30 -> need new room.
    Heap: [10, 30]          -> rooms = 2
    |=====10
    |============================== 30

  Process [15,20]:
    Earliest end in heap = 10. 15 >= 10 -> reuse room! Poll 10.
    Heap: [20, 30]          -> rooms = 2
         |=====20
    |============================== 30

  Max heap size = 2 -> answer: 2 rooms

  Alternative: Sweep Line (Chronological Ordering)

  Events:  (0,+1) (5,+1) (10,-1) (15,+1) (20,-1) (30,-1)

  Timeline sweep:
  time  0:  +1 -> rooms=1
  time  5:  +1 -> rooms=2  <- MAX = 2
  time 10:  -1 -> rooms=1
  time 15:  +1 -> rooms=2
  time 20:  -1 -> rooms=1
  time 30:  -1 -> rooms=0

  Answer = max concurrent = 2
```

### Java Solution

```java
// LeetCode 253: Meeting Rooms II
// Greedy + Min-Heap: reuse the room that frees up earliest.
class Solution {
    public int minMeetingRooms(int[][] intervals) {
        if (intervals == null || intervals.length == 0) return 0;

        // Sort meetings by start time
        Arrays.sort(intervals, (a, b) -> Integer.compare(a[0], b[0]));

        // Min-heap of end times (rooms currently in use)
        PriorityQueue<Integer> minHeap = new PriorityQueue<>();

        for (int[] interval : intervals) {
            int start = interval[0];
            int end = interval[1];

            // If the earliest-ending meeting has ended, free that room
            if (!minHeap.isEmpty() && minHeap.peek() <= start) {
                minHeap.poll();
            }

            // Allocate a room for this meeting (push its end time)
            minHeap.offer(end);
        }

        // Heap size = number of rooms needed
        return minHeap.size();
    }
}
// Time: O(n log n) — sort + n heap operations
// Space: O(n) — heap can hold up to n end times
```

### Sweep Line Alternative (No Heap)

```java
// Alternative: Sweep Line with sorted start and end arrays
class Solution {
    public int minMeetingRooms(int[][] intervals) {
        int n = intervals.length;
        int[] starts = new int[n];
        int[] ends = new int[n];

        for (int i = 0; i < n; i++) {
            starts[i] = intervals[i][0];
            ends[i] = intervals[i][1];
        }

        Arrays.sort(starts);
        Arrays.sort(ends);

        int rooms = 0, maxRooms = 0;
        int s = 0, e = 0;

        while (s < n) {
            if (starts[s] < ends[e]) {
                rooms++;       // a meeting starts before the next one ends
                s++;
            } else {
                rooms--;       // a meeting ended, free a room
                e++;
            }
            maxRooms = Math.max(maxRooms, rooms);
        }

        return maxRooms;
    }
}
// Time: O(n log n), Space: O(n)
```

---

## 8. Assign Cookies

**LeetCode 455** | Difficulty: Easy

Given two arrays `g` (children's greed factors) and `s` (cookie sizes), find the maximum number of children you can satisfy. A child `i` is satisfied if `s[j] >= g[i]`.

### Approach: Greedy — Sort Both, Two Pointers

Sort both arrays. For each child, assign the smallest cookie that satisfies them. This maximizes the number of satisfied children because we're not "wasting" large cookies on children with small greed.

```
  Assign Cookies — Greedy Matching

  g = [1, 2, 3]   (children, greed)
  s = [1, 1]       (cookies, sizes)

  Sorted: g = [1, 2, 3], s = [1, 1]

  Child 0 (greed 1): Cookie 0 (size 1) >= 1 -> assign! child=1, cookie=1
  Child 1 (greed 2): Cookie 1 (size 1) < 2  -> skip cookie, cookie=2
  No more cookies -> done. Answer = 1

  Better example:
  g = [1, 2, 3], s = [1, 2, 3]

  Child 0 (greed 1): Cookie 0 (size 1) -> match! 
  Child 1 (greed 2): Cookie 1 (size 2) -> match!
  Child 2 (greed 3): Cookie 2 (size 3) -> match!
  Answer = 3

  Why smallest cookie for each child?
  If we give a bigger cookie to a low-greed child, we might not
  have enough for a high-greed child. Greedy: match smallest
  sufficient cookie to the least greedy child first.
```

### Java Solution

```java
// LeetCode 455: Assign Cookies
// Greedy: sort both, assign smallest sufficient cookie to each child.
class Solution {
    public int findContentChildren(int[] g, int[] s) {
        Arrays.sort(g);  // children by greed (ascending)
        Arrays.sort(s);  // cookies by size (ascending)

        int child = 0, cookie = 0;
        int count = 0;

        while (child < g.length && cookie < s.length) {
            if (s[cookie] >= g[child]) {
                // This cookie satisfies this child
                count++;
                child++;
                cookie++;
            } else {
                // Cookie too small, try the next (larger) cookie
                cookie++;
            }
        }

        return count;
    }
}
// Time: O(n log n + m log m), Space: O(1) or O(n+m) for sort
```

### Exchange Argument Proof

Suppose OPT assigns cookies differently. Find the first child where OPT uses a larger cookie than GREEDY. Swapping OPT's assignment to use the smaller cookie (that GREEDY used) still satisfies that child, and frees the larger cookie for a later child. By induction, OPT can be transformed into GREEDY without reducing the count.

---

## 9. Remove K Digits

**LeetCode 402** | Difficulty: Medium

Given a string `num` representing a non-negative integer and an integer `k`, return the smallest possible integer after removing `k` digits.

### Approach: Greedy with Monotonic Stack

The greedy choice: remove a digit if a **smaller digit follows it**. This is a "remove left neighbor if it's larger" pattern, implemented with a monotonic increasing stack.

```
  Remove K Digits — Monotonic Stack Visualization

  num = "1432219", k = 3

  Process each digit, popping from stack while top > current AND k > 0:

  Char '1': stack = [1]
  Char '4': stack = [1, 4]        (4 > 1, keep)
  Char '3': 4 > 3 and k=3 -> pop 4, k=2
            stack = [1, 3]
  Char '2': 3 > 2 and k=2 -> pop 3, k=1
            stack = [1, 2]
  Char '2': 2 = 2, keep
            stack = [1, 2, 2]
  Char '1': 2 > 1 and k=1 -> pop 2, k=0
            stack = [1, 2, 1]
  Char '9': k=0, can't pop anymore
            stack = [1, 2, 1, 9]

  Result: "1219"

  Stack trace:
  Step:  1    4    3    2    2    1    9
  Stack: [1] [14] [13] [12] [122][121][1219]
  k:     3    3    2    1    1    0    0

  Why this works:
  - A digit in a more significant (left) position has more impact.
  - If a larger digit is followed by a smaller one, removing the larger
    digit from the left yields a smaller number than removing the smaller
    digit from the right.
  - Monotonic increasing stack naturally finds these "peaks" to remove.
```

### Java Solution

```java
// LeetCode 402: Remove K Digits
// Greedy monotonic stack: remove larger left neighbors.
class Solution {
    public String removeKdigits(String num, int k) {
        // Use a StringBuilder as a stack
        StringBuilder stack = new StringBuilder();

        for (char digit : num.toCharArray()) {
            // While the top of the stack is greater than the current digit
            // and we still have removals left, pop the top.
            while (k > 0 && stack.length() > 0
                   && stack.charAt(stack.length() - 1) > digit) {
                stack.deleteCharAt(stack.length() - 1);
                k--;
            }
            stack.append(digit);
        }

        // If we still have removals left (digits were non-decreasing),
        // remove from the end (largest remaining digits)
        while (k > 0) {
            stack.deleteCharAt(stack.length() - 1);
            k--;
        }

        // Strip leading zeros
        int start = 0;
        while (start < stack.length() && stack.charAt(start) == '0') {
            start++;
        }

        String result = stack.substring(start);
        return result.isEmpty() ? "0" : result;
    }
}
// Time: O(n) — each digit pushed and popped at most once
// Space: O(n) — for the stack
```

### Edge Cases

- `num = "10", k = 2` → Remove both → `"0"` (not empty string)
- `num = "9", k = 1` → Remove the only digit → `"0"`
- `num = "112", k = 1` → Non-decreasing, remove from end → `"11"`
- Leading zeros: `"10200", k = 1` → Remove '1' → `"0200"` → strip → `"200"`

### Why Greedy Works

Removing a digit at position `i` affects the number by replacing the digit at `i` with the digit at `i+1`. To minimize the result, we want to remove the **leftmost digit that is greater than its right neighbor** — this is where the decrease has the biggest positional impact. The monotonic stack efficiently finds all such positions.

---

## 10. Candy

**LeetCode 135** | Difficulty: Hard

There are `n` children standing in a line. Each child has a rating. You must distribute candies such that:
1. Each child gets at least 1 candy.
2. Children with a higher rating get more candies than their neighbors.

Return the minimum total candies.

### Approach: Two-Pass Greedy

- **Left-to-right pass:** If `ratings[i] > ratings[i-1]`, then `candies[i] = candies[i-1] + 1`. Ensures left neighbor constraint.
- **Right-to-left pass:** If `ratings[i] > ratings[i+1]`, then `candies[i] = max(candies[i], candies[i+1] + 1)`. Ensures right neighbor constraint.

```
  Candy — Two-Pass Greedy

  ratings = [1, 0, 2]

  Step 1: Initialize all to 1
  candies = [1, 1, 1]

  Step 2: Left to right (compare with LEFT neighbor)
  i=1: 0 < 1 -> no increase needed
  i=2: 2 > 0 -> candies[2] = candies[1] + 1 = 2
  candies = [1, 1, 2]

  Step 3: Right to left (compare with RIGHT neighbor)
  i=1: 0 < 2 -> no, check: ratings[1] < ratings[2], 0 < 2
       Wait, we check if ratings[i] > ratings[i+1]
       0 > 2? No. Skip.
  i=0: 1 > 0? Yes -> candies[0] = max(1, candies[1]+1) = max(1, 2) = 2
  candies = [2, 1, 2]

  Total = 2 + 1 + 2 = 5

  Detailed example: ratings = [1, 2, 87, 87, 87, 2, 1]

  Init:       [1, 1, 1, 1, 1, 1, 1]
  L->R:       [1, 2, 3, 1, 1, 1, 1]   (87=87 -> reset to 1; 87>2? no)
  R->L:       [1, 2, 3, 1, 3, 2, 1]   (87>87? no; 87>2 -> 3; 2>1 -> 2)
  Total = 1+2+3+1+3+2+1 = 13
```

### Java Solution

```java
// LeetCode 135: Candy
// Two-pass greedy: satisfy left then right constraints independently.
class Solution {
    public int candy(int[] ratings) {
        int n = ratings.length;
        int[] candies = new int[n];
        Arrays.fill(candies, 1);  // every child gets at least 1

        // Left-to-right: ensure higher-rated child gets more than left neighbor
        for (int i = 1; i < n; i++) {
            if (ratings[i] > ratings[i - 1]) {
                candies[i] = candies[i - 1] + 1;
            }
        }

        // Right-to-left: ensure higher-rated child gets more than right neighbor
        // Take max to not break the left-neighbor constraint already set
        for (int i = n - 2; i >= 0; i--) {
            if (ratings[i] > ratings[i + 1]) {
                candies[i] = Math.max(candies[i], candies[i + 1] + 1);
            }
        }

        // Sum up total candies
        int total = 0;
        for (int c : candies) total += c;
        return total;
    }
}
// Time: O(n) — three linear passes
// Space: O(n) — candy array
```

### O(1) Space Alternative (Peak/Valley Approach)

```java
// O(1) space solution using peak/valley counting
class Solution {
    public int candy(int[] ratings) {
        int n = ratings.length;
        int total = 0;
        int up = 0, down = 0, peak = 0;

        for (int i = 1; i < n; i++) {
            if (ratings[i] >= ratings[i - 1]) {
                // End of a downward slope -> process valley
                if (down > 0) {
                    total += countCandies(up, down, peak);
                    up = 0;
                    down = 0;
                }
                peak = (ratings[i] == ratings[i - 1]) ? 0 : up + 1;
                up = (ratings[i] == ratings[i - 1]) ? 0 : up + 1;
            } else {
                down++;
            }
        }
        total += countCandies(up, down, peak);
        return total + n;  // +n for the base 1 candy per child
    }

    private int countCandies(int up, int down, int peak) {
        int sum = up * (up + 1) / 2 + down * (down + 1) / 2;
        if (peak > 0 && down >= peak) sum -= peak;       // adjust peak overlap
        else if (peak > 0) sum -= down;                  // valley adjustment
        return sum;
    }
}
```

### Why Two-Pass Greedy Works

Each pass independently satisfies one of the two constraints. The left-to-right pass guarantees the left-neighbor rule. The right-to-left pass enforces the right-neighbor rule **without violating** the left-neighbor rule (because we take the max). After both passes, both constraints are satisfied simultaneously, and the solution is minimal because each child gets exactly the minimum required by the binding constraint.

---

## 11. Task Scheduler

**LeetCode 621** | Difficulty: Medium

Given a char array `tasks` and a cooldown `n`, find the minimum number of CPU intervals to finish all tasks. Same tasks must be separated by at least `n` intervals.

### Approach: Greedy — Schedule Most Frequent First

The key insight: the most frequent task determines the **frame**. If task A appears `maxFreq` times, we need at least `(maxFreq - 1) * (n + 1) + countOfMaxFreq` intervals. Then we take the max of this and the total task count (in case idle slots aren't needed).

```
  Task Scheduler — Greedy Frame Construction

  tasks = ["A","A","A","B","B","B"], n = 2

  maxFreq = 3 (A and B both appear 3 times)
  countOfMaxFreq = 2 (two tasks have frequency 3)

  Frame:  A _ _ | A _ _ | A
          ^ slots between A's = n = 2
          We need (maxFreq - 1) = 2 full frames + 1 final execution

  Minimum intervals = (maxFreq - 1) * (n + 1) + countOfMaxFreq
                    = (3 - 1) * (2 + 1) + 2
                    = 2 * 3 + 2 = 8

  Actual schedule:
  A B _ | A B _ | A B
  1 2 3   4 5 6   7 8

  But we have 6 tasks total, and 8 >= 6, so answer = 8.
  If total tasks > formula, answer = total tasks (no idle needed).

  Visualization with more tasks:
  tasks = ["A","A","A","B","B","B","C","C","D","D"], n = 2

  maxFreq = 3, countOfMaxFreq = 2
  frame = (3-1)*(2+1)+2 = 8
  total tasks = 10
  answer = max(8, 10) = 10 (no idle slots needed!)
```

### Java Solution

```java
// LeetCode 621: Task Scheduler
// Greedy: most frequent task defines the frame.
class Solution {
    public int leastInterval(char[] tasks, int n) {
        int[] freq = new int[26];
        for (char task : tasks) {
            freq[task - 'A']++;
        }

        // Find the maximum frequency
        int maxFreq = 0;
        for (int f : freq) {
            maxFreq = Math.max(maxFreq, f);
        }

        // Count how many tasks have the max frequency
        int countOfMaxFreq = 0;
        for (int f : freq) {
            if (f == maxFreq) countOfMaxFreq++;
        }

        // Frame size: (maxFreq - 1) full cycles + final cycle with all max-freq tasks
        int frameSize = (maxFreq - 1) * (n + 1) + countOfMaxFreq;

        // Answer is max of frame size and total tasks
        return Math.max(frameSize, tasks.length);
    }
}
// Time: O(n), Space: O(1) — frequency array of size 26
```

### Why This Works

The most frequent task creates the longest "chain" with mandatory idle gaps. We fill these gaps with other tasks. If there are enough other tasks to fill all gaps (and extend beyond), no idle slots are needed and the answer is simply the total number of tasks. If not, we need `frameSize` intervals. The formula captures both cases.

---

## 12. Queue Reconstruction by Height

**LeetCode 406** | Difficulty: Medium

You are given an array of people where `people[i] = [h_i, k_i]` is the height and the number of people in front who have height >= h_i. Reconstruct the queue.

### Approach: Greedy — Insert Tallest First

Sort people by height descending, and for equal heights, by `k` ascending. Then insert each person at position `k` in the result list. Because we insert taller people first, shorter people inserted later don't affect the `k` count of taller people already placed.

```
  Queue Reconstruction — Greedy Insertion

  Input: [[7,0],[4,4],[7,1],[5,0],[6,1],[5,2]]

  Step 1: Sort by height desc, k asc:
  [7,0], [7,1], [6,1], [5,0], [5,2], [4,4]

  Step 2: Insert each at index k:

  Insert [7,0] at index 0:  [[7,0]]
  Insert [7,1] at index 1:  [[7,0],[7,1]]
  Insert [6,1] at index 1:  [[7,0],[6,1],[7,1]]
  Insert [5,0] at index 0:  [[5,0],[7,0],[6,1],[7,1]]
  Insert [5,2] at index 2:  [[5,0],[7,0],[5,2],[6,1],[7,1]]
  Insert [4,4] at index 4:  [[5,0],[7,0],[5,2],[6,1],[4,4],[7,1]]

  Result: [[5,0],[7,0],[5,2],[6,1],[4,4],[7,1]]

  Why insert tallest first?
  - Taller people are "invisible" to shorter people's k count.
  - When we insert a shorter person, it doesn't change how many
    taller people are in front of already-placed taller people.
  - So k for taller people remains valid after all insertions.
```

### Java Solution

```java
// LeetCode 406: Queue Reconstruction by Height
// Greedy: sort by height desc, k asc; insert at position k.
class Solution {
    public int[][] reconstructQueue(int[][] people) {
        // Sort: height descending, k ascending for ties
        Arrays.sort(people, (a, b) -> {
            if (a[0] != b[0]) return b[0] - a[0];  // taller first
            return a[1] - b[1];                      // smaller k first
        });

        // Insert each person at index k
        List<int[]> result = new ArrayList<>();
        for (int[] person : people) {
            result.add(person[1], person);  // insert at position k
        }

        return result.toArray(new int[0][]);
    }
}
// Time: O(n²) — n insertions into ArrayList, each O(n) worst case
// Space: O(n) — for the result list
```

### Exchange Argument

If we insert a shorter person before a taller one, the shorter person's k might be violated (more tall people in front). By inserting tallest first, we guarantee that when a person is placed at index k, exactly k taller-or-equal people are in front. Later insertions of shorter people between them don't change this count.

---

## 13. Partition Labels

**LeetCode 763** | Difficulty: Medium

You are given a string `s`. Partition it into as many parts as possible so that each letter appears in at most one part. Return a list of integers representing the size of each part.

### Approach: Greedy — Extend Partition to Last Occurrence

1. Record the last occurrence index of each character.
2. Iterate through the string, maintaining a `partitionEnd` = max last occurrence of any character seen in the current partition.
3. When `i == partitionEnd`, close the partition.

```
  Partition Labels — Greedy Extension

  s = "abacbdedc"

  Last occurrences: a=2, b=4, c=8, d=6, e=7

  Traverse:
  i=0: char='a', last[0]=2 -> partitionEnd = max(0, 2) = 2
  i=1: char='b', last[1]=4 -> partitionEnd = max(2, 4) = 4
  i=2: char='a', last[2]=2 -> partitionEnd = max(4, 2) = 4
  i=3: char='c', last[3]=8 -> partitionEnd = max(4, 8) = 8
  i=4: char='b', last[4]=4 -> partitionEnd = max(8, 4) = 8
  i=5: char='d', last[5]=6 -> partitionEnd = max(8, 6) = 8
  i=6: char='e', last[6]=7 -> partitionEnd = max(8, 7) = 8
  i=7: char='d', last[7]=6 -> partitionEnd = max(8, 6) = 8
  i=8: char='c', last[8]=8 -> partitionEnd = max(8, 8) = 8
       i == partitionEnd -> CLOSE partition! Size = 8-0+1 = 9

  Result: [9]

  Better example: s = "ababcbacadefegdehijhklij"
  Last: a=8, b=5, c=7, d=14, e=15, f=11, g=13, h=19, i=22, j=23, k=20, l=21

  i=0-8:   partitionEnd extends to 8  -> close at i=8, size=9
  i=9-15:  partitionEnd extends to 15 -> close at i=15, size=7
  i=16-23: partitionEnd extends to 23 -> close at i=23, size=8

  Result: [9, 7, 8]
```

### Java Solution

```java
// LeetCode 763: Partition Labels
// Greedy: extend partition boundary to the last occurrence of each char.
class Solution {
    public List<Integer> partitionLabels(String s) {
        int[] lastIndex = new int[26];
        for (int i = 0; i < s.length(); i++) {
            lastIndex[s.charAt(i) - 'a'] = i;
        }

        List<Integer> result = new ArrayList<>();
        int start = 0;
        int partitionEnd = 0;

        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            // Extend the partition to include the last occurrence of c
            partitionEnd = Math.max(partitionEnd, lastIndex[c - 'a']);

            // If we've reached the partition boundary, close it
            if (i == partitionEnd) {
                result.add(i - start + 1);
                start = i + 1;
            }
        }

        return result;
    }
}
// Time: O(n), Space: O(1) — alphabet is fixed at 26
```

### Correctness

The greedy extension is optimal because any partition boundary must be at or after the last occurrence of every character in the partition. By always extending to the max last occurrence, we find the **earliest valid cut point**, which maximizes the number of partitions.

---

## 14. Minimum Arrows to Burst Balloons

**LeetCode 452** | Difficulty: Medium

There are spherical balloons on a 2D plane (represented as horizontal diameter intervals). An arrow shot at x bursts all balloons whose interval contains x. Find the minimum number of arrows.

### Approach: Greedy — Sort by End, Shoot at Earliest End

This is essentially interval scheduling in reverse. Sort balloons by end coordinate. Shoot an arrow at the end of the first balloon. Any balloon that starts before or at this point is burst. Skip all burst balloons, then repeat.

```
  Minimum Arrows — Greedy Arrow Placement

  balloons = [[10,16], [2,8], [1,6], [7,12]]

  Sorted by end: [1,6], [2,8], [7,12], [10,16]

  Arrow 1: shoot at x=6 (end of [1,6])
    [1,6]     -> burst (6 in [1,6])
    [2,8]     -> burst (6 in [2,8])
    [7,12]    -> 7 > 6 -> not burst, start new arrow

  Arrow 2: shoot at x=12 (end of [7,12])
    [7,12]    -> burst
    [10,16]   -> burst (12 in [10,16])

  Total arrows = 2

  Visualization:
        1   2     6     7   8     10      12      16
        |===|======|=====|===|======|========|=======|
        [1======6]          <- burst by arrow at 6
          [2========8]      <- also burst by arrow at 6
                 [7=========12]  <- burst by arrow at 12
                      [10=========16]  <- also burst by arrow at 12
                              ^  ^
                              arrow1 (x=6)  arrow2 (x=12)
```

### Java Solution

```java
// LeetCode 452: Minimum Arrows to Burst Balloons
// Greedy: sort by end, shoot at earliest end, skip overlapping balloons.
class Solution {
    public int findMinArrowShots(int[][] points) {
        if (points.length == 0) return 0;

        // Sort by end coordinate
        Arrays.sort(points, (a, b) -> Integer.compare(a[1], b[1]));

        int arrows = 1;
        int arrowPos = points[0][1];  // shoot at end of first balloon

        for (int i = 1; i < points.length; i++) {
            // If this balloon starts after the arrow position,
            // we need a new arrow
            if (points[i][0] > arrowPos) {
                arrows++;
                arrowPos = points[i][1];  // shoot at this balloon's end
            }
            // Otherwise, this balloon is already burst by current arrow
        }

        return arrows;
    }
}
// Time: O(n log n), Space: O(1) or O(n) for sort
```

### Correctness (Exchange Argument)

Shooting at the earliest end point is optimal because it maximizes the chance of overlapping with other balloons. Any other arrow position that bursts the same set of balloons would be at most as far right, potentially missing balloons that start after the earliest end. The exchange argument: if OPT shoots later for the first group, we can move the shot to the earliest end of that group without losing any balloons (since all burst balloons contain the earliest end point by definition).

---

## 15. Huffman Coding

Huffman coding is a greedy algorithm for **optimal prefix-free binary coding** used in data compression. It's a classic example where greedy is provably optimal (via matroid/exchange arguments).

### The Problem

Given characters with frequencies, assign binary codes such that:
- No code is a prefix of another (prefix-free property → unambiguous decoding)
- Total encoded length is minimized

### Greedy Strategy

Repeatedly merge the two least frequent nodes into a new internal node whose frequency is their sum. Build a binary tree bottom-up.

```
  Huffman Coding — Tree Construction

  Characters and frequencies:
  A: 45, B: 13, C: 12, D: 16, E: 9, F: 5

  Step 1: Use a min-heap (priority queue)
  Heap: [F:5, E:9, C:12, B:13, D:16, A:45]

  Step 2: Repeatedly extract two minimum, merge, reinsert

  Merge F:5 + E:9 = 14
  Heap: [C:12, B:13, (FE):14, D:16, A:45]

  Merge C:12 + B:13 = 25
  Heap: [(FE):14, D:16, A:45, (CB):25]

  Merge (FE):14 + D:16 = 30
  Heap: [(CB):25, A:45, (FED):30]

  Merge (CB):25 + (FED):30 = 55
  Heap: [A:45, (CBFED):55]

  Merge A:45 + (CBFED):55 = 100
  Heap: [root:100]

  Huffman Tree:
              [100]
             /      \
           A:45    [55]
                  /     \
               [25]     [30]
              /   \    /    \
            C:12 B:13 [14]  D:16
                     /   \
                   E:9   F:5

  Codes (left=0, right=1):
  A = 0
  C = 100
  B = 101
  D = 110
  E = 1110
  F = 1111

  Total bits = 45*1 + 13*3 + 12*3 + 16*3 + 9*4 + 5*4
             = 45 + 39 + 36 + 48 + 36 + 20 = 224 bits

  Compare with fixed 3-bit code: 100 * 3 = 300 bits (29% savings)
```

### Java Implementation (Conceptual)

```java
import java.util.PriorityQueue;

class HuffmanCoding {
    // Tree node
    static class Node implements Comparable<Node> {
        char character;
        int freq;
        Node left, right;

        Node(char character, int freq) {
            this.character = character;
            this.freq = freq;
        }

        Node(int freq, Node left, Node right) {
            this.character = '\0';  // internal node
            this.freq = freq;
            this.left = left;
            this.right = right;
        }

        public int compareTo(Node other) {
            return this.freq - other.freq;
        }

        boolean isLeaf() {
            return left == null && right == null;
        }
    }

    public static Node buildTree(char[] chars, int[] freqs) {
        PriorityQueue<Node> pq = new PriorityQueue<>();

        // Create leaf nodes for each character
        for (int i = 0; i < chars.length; i++) {
            pq.offer(new Node(chars[i], freqs[i]));
        }

        // Greedily merge two least frequent nodes
        while (pq.size() > 1) {
            Node left = pq.poll();
            Node right = pq.poll();
            Node merged = new Node(left.freq + right.freq, left, right);
            pq.offer(merged);
        }

        return pq.poll();  // root of Huffman tree
    }

    public static void printCodes(Node root, String code) {
        if (root == null) return;
        if (root.isLeaf()) {
            System.out.println(root.character + ": " + code);
            return;
        }
        printCodes(root.left, code + "0");
        printCodes(root.right, code + "1");
    }

    public static void main(String[] args) {
        char[] chars = {'A', 'B', 'C', 'D', 'E', 'F'};
        int[] freqs = {45, 13, 12, 16, 9, 5};
        Node root = buildTree(chars, freqs);
        printCodes(root, "");
    }
}
```

### Why Greedy Is Optimal

Huffman coding satisfies the matroid-like exchange property. The proof relies on:
1. **Lemma:** The two least frequent characters are at the deepest level of some optimal tree.
2. **Exchange:** If an optimal tree doesn't have the two least frequent characters as siblings at the deepest level, we can swap them there without increasing the total cost.
3. **Induction:** After merging the two least frequent nodes, the subproblem is structurally identical but smaller. By induction, greedy produces the optimal tree.

---

## 16. Fractional vs 0/1 Knapsack

This is the **canonical example** that distinguishes greedy-solvable from DP-solvable problems.

### Fractional Knapsack (Greedy Works)

You can take **fractions** of items. Sort by value/weight ratio and take as much as possible from the highest ratio item.

```
  Fractional Knapsack — Greedy by Value/Weight Ratio

  Items:  (w=10, v=60), (w=20, v=100), (w=30, v=120)
  Capacity = 50

  Ratios: 6.0, 5.0, 4.0

  Greedy:
  Take all of item 1 (w=10, v=60)    -> capacity left = 40, value = 60
  Take all of item 2 (w=20, v=100)   -> capacity left = 20, value = 160
  Take 20/30 of item 3 (w=20, v=80)  -> capacity left = 0,  value = 240

  Total value = 240 (optimal!)

  Why greedy works here:
  - We can take fractions, so no "wasted" capacity.
  - Taking the highest ratio first is always optimal because
    any remaining capacity is filled with the next best ratio.
  - Exchange argument: if OPT uses less of a high-ratio item and
    more of a low-ratio item, swapping increases total value.
```

### Java Solution (Fractional Knapsack)

```java
class FractionalKnapsack {
    static class Item {
        int weight, value;
        double ratio;
        Item(int w, int v) {
            weight = w;
            value = v;
            ratio = (double) v / w;
        }
    }

    public static double fractionalKnapsack(int[] weights, int[] values, int capacity) {
        int n = weights.length;
        Item[] items = new Item[n];
        for (int i = 0; i < n; i++) {
            items[i] = new Item(weights[i], values[i]);
        }

        // Sort by ratio descending (greedy choice)
        Arrays.sort(items, (a, b) -> Double.compare(b.ratio, a.ratio));

        double totalValue = 0;
        int remaining = capacity;

        for (Item item : items) {
            if (remaining <= 0) break;
            int take = Math.min(item.weight, remaining);
            totalValue += take * item.ratio;
            remaining -= take;
        }

        return totalValue;
    }
}
// Time: O(n log n), Space: O(n)
```

### 0/1 Knapsack (Greedy Fails — Need DP)

You must take **whole items** or leave them. Greedy by ratio fails.

```
  0/1 Knapsack — Greedy FAILS

  Items:  (w=10, v=60), (w=20, v=100), (w=30, v=120)
  Capacity = 50

  Greedy by ratio (same as fractional):
  Take item 1 (w=10, v=60) -> cap=40, val=60
  Take item 2 (w=20, v=100) -> cap=20, val=160
  Can't take item 3 (w=30 > 20) -> STOP
  Total = 160

  Optimal (DP):
  Take item 2 + item 3 (w=20+30=50) -> val=100+120=220
  Total = 220  (much better!)

  Why greedy fails:
  The greedy choice (item 1, highest ratio) wastes 40 units of capacity
  that could have been used by items 2 and 3 for a higher total value.
  With 0/1 constraint, we can't "fill the gaps" with fractions.
```

### Java Solution (0/1 Knapsack — DP)

```java
class Knapsack01 {
    public static int knapsack01(int[] weights, int[] values, int capacity) {
        int n = weights.length;
        // dp[i][w] = max value using first i items with capacity w
        int[][] dp = new int[n + 1][capacity + 1];

        for (int i = 1; i <= n; i++) {
            for (int w = 0; w <= capacity; w++) {
                // Don't take item i
                dp[i][w] = dp[i - 1][w];
                // Take item i (if it fits)
                if (weights[i - 1] <= w) {
                    dp[i][w] = Math.max(dp[i][w],
                        dp[i - 1][w - weights[i - 1]] + values[i - 1]);
                }
            }
        }

        return dp[n][capacity];
    }

    // Space-optimized: O(capacity) space
    public static int knapsack01Optimized(int[] weights, int[] values, int capacity) {
        int[] dp = new int[capacity + 1];
        for (int i = 0; i < weights.length; i++) {
            for (int w = capacity; w >= weights[i]; w--) {
                dp[w] = Math.max(dp[w], dp[w - weights[i]] + values[i]);
            }
        }
        return dp[capacity];
    }
}
// Time: O(n * capacity), Space: O(capacity)
```

### Key Takeaway

| Aspect | Fractional Knapsack | 0/1 Knapsack |
|--------|--------------------|--------------| 
| Can take fractions? | Yes | No |
| Greedy optimal? | Yes | No |
| Algorithm | Sort by ratio, greedy fill | Dynamic Programming |
| Time complexity | O(n log n) | O(n * capacity) |
| Why? | No wasted capacity | Greedy wastes capacity; must explore all subsets |

The fundamental difference: **fractional knapsack has optimal substructure + greedy choice property**, while 0/1 knapsack has optimal substructure but **not** the greedy choice property (a locally optimal pick can block a globally better combination).

---

## 17. Greedy vs DP — Comparison Table

| Dimension | Greedy | Dynamic Programming |
|-----------|--------|---------------------|
| **Core idea** | Make locally optimal choice at each step | Explore all choices, memoize overlapping subproblems |
| **Optimal substructure** | Required | Required |
| **Greedy choice property** | Required (local optimal → global optimal) | Not required |
| **Overlapping subproblems** | Not exploited | Required for efficiency |
| **Backtracking** | No — choices are irrevocable | Implicit — all paths considered |
| **Correctness proof** | Hard — exchange argument or matroid theory | Systematic — optimal substructure + induction |
| **Time complexity** | Usually O(n log n) or O(n) | O(states × transitions), often O(n²), O(n³) |
| **Space complexity** | Usually O(1) or O(n) | O(states), often O(n) or O(n²) |
| **When to use** | Problem has greedy choice property | Problem has overlapping subproblems but no greedy property |
| **Risk** | May produce suboptimal result if greedy property doesn't hold | Always optimal if formulated correctly |
| **Code length** | Short and elegant | Longer, table-filling |
| **Classic examples** | MST, Huffman, Dijkstra, interval scheduling | Knapsack 0/1, LCS, edit distance, matrix chain |
| **Common pitfall** | Assuming greedy works without proof | Wrong state definition or transition |

### How to Decide: Greedy or DP?

```
  DECISION FLOWCHART:

  Does the problem have optimal substructure?
    |
    +-- NO --> Neither greedy nor DP directly applies
    |
    +-- YES --> Does making a locally optimal choice
                lead to a globally optimal solution?
                |
                +-- YES --> GREEDY (prove it with exchange argument)
                |
                +-- NO --> DP (or backtracking/branch-and-bound)

  PROOF TECHNIQUES for greedy:
  1. Exchange argument: show any optimal solution can be transformed
     into the greedy solution without loss.
  2. Matroid theory: if feasible solutions form a matroid, greedy is optimal.
  3. "Greedy stays ahead": show greedy's partial solution is always
     at least as good as any other partial solution.

  RED FLAGS that greedy might NOT work:
  - A choice affects future options in complex ways (e.g., knapsack 0/1)
  - The problem asks for the number of ways (usually DP)
  - You need to consider all subsets/permutations
  - Sorting by one criterion leaves out cases
  - Small input size (n < 30) — suggests exponential/DP, not greedy
```

---

## 18. Pattern Recognition Table

When you see these signals in an interview, think **greedy**:

| Signal / Pattern | Problem Type | Sorting Key | Classic Problems |
|------------------|-------------|-------------|-----------------|
| "Maximum number of non-overlapping intervals" | Interval scheduling | End time | Non-overlapping Intervals (435), Meeting Rooms (252/253) |
| "Minimum arrows/points to cover all intervals" | Interval covering | End time | Min Arrows (452), Points Covering Segments |
| "Merge/insert intervals" | Interval merging | Start time | Merge Intervals (56), Insert Interval (57) |
| "Can you reach the end?" (array jumps) | Reachability | N/A (single pass) | Jump Game (55) |
| "Minimum jumps to reach end" | Optimized reach | N/A (BFS levels) | Jump Game II (45) |
| "Circular tour, gas/cost" | Circular feasibility | N/A (single pass) | Gas Station (134) |
| "Assign resources to maximize count" | Matching | Both arrays sorted | Assign Cookies (455) |
| "Smallest number after removing k digits" | Monotonic stack | Stack-based | Remove K Digits (402), Create Max Number (321) |
| "Each child gets more than neighbors" | Two-pass constraint | Left then right | Candy (135) |
| "Schedule tasks with cooldown" | Frequency-based framing | Frequency | Task Scheduler (621) |
| "Reconstruct queue by height/count" | Insertion by priority | Height desc, k asc | Queue Reconstruction (406) |
| "Partition so each char in one part" | Last occurrence extension | Last occurrence | Partition Labels (763) |
| "Optimal prefix-free coding" | Merge minimums | Frequency (min-heap) | Huffman Coding |
| "Can take fractions of items" | Fractional optimization | Value/weight ratio | Fractional Knapsack |
| "Minimum swaps to group items" | Two-pointer greedy | N/A | Minimum Swaps (various) |
| "Remove duplicates, keep smallest/largest" | Stack-based filtering | Stack-based | Remove Duplicate Letters (316) |
| "Reorganize string so no adjacent same" | Frequency-based placement | Frequency (max-heap) | Reorganize String (767) |
| "Boats to save people (limit weight)" | Two-pointer after sort | Sorted weight | Boats to Save People (881) |

### Greedy by Sorting Criterion

| If you sort by... | You can usually solve... |
|--------------------|--------------------------|
| **End time** | Max non-overlapping intervals, min arrows, min rooms |
| **Start time** | Merge intervals, insert interval |
| **Frequency** | Task scheduler, Huffman, reorganize string |
| **Height/ratio** | Queue reconstruction, fractional knapsack |
| **Both arrays** | Assign cookies, boats to save people |
| **Nothing (single pass)** | Jump game, gas station, candy (two-pass) |
| **Stack (monotonic)** | Remove k digits, remove duplicate letters |

### Common Greedy Patterns (Cheat Sheet)

```
  PATTERN 1: Interval Scheduling (Earliest Finish Time)
  -------------------------------------------------------
  Sort by end time. Greedily select intervals that don't overlap
  with the last selected one.
  Problems: 435, 452, 646

  PATTERN 2: Interval Merging
  -------------------------------------------------------
  Sort by start time. Merge overlapping intervals.
  Problems: 56, 57, 986

  PATTERN 3: Reachability / BFS Levels
  -------------------------------------------------------
  Track farthest reachable. For min steps, use level boundaries.
  Problems: 55, 45, 1306

  PATTERN 4: Greedy Reset / Skip Ahead
  -------------------------------------------------------
  When a segment fails, skip the entire segment.
  Problems: 134 (Gas Station)

  PATTERN 5: Monotonic Stack
  -------------------------------------------------------
  Maintain increasing/decreasing stack. Pop when a "better"
  element arrives and budget allows.
  Problems: 402, 316, 321, 402

  PATTERN 6: Two-Pass (Left + Right Constraints)
  -------------------------------------------------------
  Satisfy constraints from both directions independently.
  Problems: 135 (Candy), 42 (Trapping Rain Water — also two-pointer)

  PATTERN 7: Frequency Framing
  -------------------------------------------------------
  The most frequent element determines the structure/frame.
  Problems: 621, 767, 358, 1054

  PATTERN 8: Greedy Insertion by Priority
  -------------------------------------------------------
  Sort by a dominant attribute, insert at position determined
  by a secondary attribute.
  Problems: 406 (Queue Reconstruction)

  PATTERN 9: Last Occurrence Extension
  -------------------------------------------------------
  Extend a window/segment boundary to the last occurrence of
  each element in the current segment.
  Problems: 763 (Partition Labels)

  PATTERN 10: Two-Pointer Matching
  -------------------------------------------------------
  Sort both arrays. Use two pointers to greedily match.
  Problems: 455, 881, 1099
```

---

## Quick Reference: Complexity Summary

| Problem | LeetCode | Time | Space | Greedy Strategy |
|---------|----------|------|-------|-----------------|
| Jump Game | 55 | O(n) | O(1) | Track max reach |
| Jump Game II | 45 | O(n) | O(1) | BFS level boundaries |
| Gas Station | 134 | O(n) | O(1) | Greedy reset on negative tank |
| Meeting Rooms II | 253 | O(n log n) | O(n) | Min-heap of end times |
| Assign Cookies | 455 | O(n log n) | O(1) | Sort both, two pointers |
| Remove K Digits | 402 | O(n) | O(n) | Monotonic increasing stack |
| Candy | 135 | O(n) | O(n) | Two-pass (left then right) |
| Non-overlapping Intervals | 435 | O(n log n) | O(1) | Sort by end, count kept |
| Task Scheduler | 621 | O(n) | O(1) | Frequency-based frame |
| Queue Reconstruction | 406 | O(n²) | O(n) | Sort by height desc, insert at k |
| Partition Labels | 763 | O(n) | O(1) | Extend to last occurrence |
| Min Arrows | 452 | O(n log n) | O(1) | Sort by end, shoot at earliest end |
| Huffman Coding | — | O(n log n) | O(n) | Min-heap, merge two least frequent |
| Fractional Knapsack | — | O(n log n) | O(n) | Sort by value/weight ratio |

---

## Final Tips for Interviews

1. **Always try greedy first** for optimization problems with a natural "best choice" — it's often O(n log n) vs O(n²) for DP.
2. **Prove correctness** with an exchange argument if you have time. If you can't prove it, consider whether a counterexample exists.
3. **Sort is your best friend** — most greedy problems start with sorting by a key criterion. The hard part is identifying the right sort key.
4. **Watch for "minimum/maximum number of X"** — these often have greedy solutions (intervals, arrows, jumps, rooms).
5. **Monotonic stack** is the signature pattern for "remove/keep to get optimal sequence" problems.
6. **Two-pass** works when constraints come from both directions (Candy, Trapping Rain Water).
7. **If greedy seems too easy, double-check** — make sure you're not missing a case where it fails. Test edge cases (empty input, single element, all same, decreasing, increasing).
8. **When greedy fails, pivot to DP** — recognize the signal (small n, "number of ways", complex interactions between choices).
9. **Circular problems** (Gas Station) often have a clever single-pass greedy with a reset.
10. **Practice the proof** — being able to explain *why* greedy works is often more impressive to interviewers than just coding the solution.

---

*This article is part of a Coding Interview Prep series. Each article covers a major algorithm paradigm with theory, full Java solutions, ASCII diagrams, and pattern recognition tables.*

---

## Interview Cheat Sheet

**Key Points to Remember:**

- Greedy = make the locally optimal choice at each step, with no backtracking. It works only when the problem has the greedy-choice property (local optima lead to a global optimum).
- Common greedy patterns: interval scheduling (sort by end time), activity selection, Huffman coding, fractional knapsack, Dijkstra's shortest path.
- Proof techniques you should know: the exchange argument (transform any optimal solution into the greedy one without loss) and "greedy stays ahead" (show the greedy solution is always at least as good as any other at every step).
- Most greedy problems start with sorting — the hard part is identifying the right sort key (by end time for activity selection, by start for meeting rooms).
- Greedy is usually O(n log n) or O(n); if your solution is O(n²), check whether DP or a different greedy choice is more appropriate.

**Common Follow-Up Questions:**

- *How do you prove a greedy algorithm is correct?* — Use the exchange argument: assume an optimal solution OPT differs from the greedy solution GREEDY, find the first point of difference, and show you can exchange an element in OPT for the greedy choice without making the solution worse. By induction, OPT can be transformed into GREEDY, proving GREEDY is also optimal.
- *When does greedy fail?* — When local optima don't lead to a global optimum. The classic example is 0/1 knapsack (greedy by value/weight ratio fails) vs fractional knapsack (greedy works because you can take fractions). If you can't prove greedy works, suspect DP.

**Gotcha:**

Assuming greedy works without proof. Many problems LOOK greedy but require DP (e.g., coin change with arbitrary denominations — greedy works for standard US coins but fails on denominations like {1, 3, 4} for making 6). Always verify the greedy-choice property or test counterexamples before committing.