---
title: "Big O Complexity & Pattern Recognition"
type: reference
topic: coding-interview
language: java
tags: [big-o, complexity, patterns, data-structures, algorithms, interview-prep]
created: 2026-06-19
source: Hermes Coding Interview Prep
---

# Big O Complexity & Pattern Recognition

A comprehensive reference for analyzing algorithm complexity and recognizing coding interview patterns. Every section is built to be skimmable before an interview and deep enough to learn from the first time.

---

## Summary & Interview Framing

The mathematical notation for algorithm complexity and the skill of matching problem patterns to solution templates.

**How it's asked:** "Every interview asks 'what's the time and space complexity?' This article teaches you to answer that AND recognize which pattern (sliding window, two heaps, BFS, etc.) a problem requires."

---

## 1. Big O Notation Explained

Big O describes how an algorithm's runtime or memory grows as the input size n grows toward infinity. It is an upper bound on growth rate, expressed as a function of n, with constants and lower-order terms dropped.

Key principles:

- Drop constants. O(2n + 5) becomes O(n). A loop run twice is still linear.
- Drop lower-order terms. O(n^2 + n) becomes O(n^2). The dominant term wins as n grows.
- Big O is worst case unless stated otherwise (average case, amortized, expected).
- It measures growth, not actual wall-clock time. An O(n) algorithm with a huge constant can be slower than an O(n^2) one for small n.

Example: summing an array

```java
int sum(int[] arr) {
    int total = 0;              // O(1)
    for (int x : arr) {         // O(n) iterations
        total += x;             // O(1) per iteration
    }
    return total;               // O(1)
}
// Total: O(n)
```

Example: nested loops

```java
void printPairs(int[] arr) {
    for (int i = 0; i < arr.length; i++) {        // O(n)
        for (int j = 0; j < arr.length; j++) {    // O(n)
            System.out.println(arr[i] + "," + arr[j]);
        }
    }
}
// Total: O(n^2)
```

Example: logarithmic — halving each step

```java
int countHalves(int n) {
    int steps = 0;
    while (n > 1) {
        n = n / 2;     // halves each iteration
        steps++;
    }
    return steps;
}
// Total: O(log n)
```

Quick growth intuition (for n = 1,000,000):

- O(1): 1 operation
- O(log n): ~20 operations
- O(n): 1,000,000 operations
- O(n log n): ~20,000,000 operations
- O(n^2): 1,000,000,000,000 operations (a trillion)

The gap between O(n) and O(n^2) is the difference between instant and hours.

---

## 2. ASCII Complexity Comparison Chart

```
Operations
  ^
  |                                         O(n!)  -- astronomically large
  |                                      /
  |                                   /  O(2^n) -- exponential, unusable
  |                                /
  |                             /
  |                          /
  |                       /
  |                    /  O(n^2) -- quadratic, OK for small n only
  |                 /
  |              /
  |           /
  |        /     O(n log n) -- sort-level, generally acceptable
  |     /
  |  /           O(n) -- linear, scales fine
  | /
  |/               O(log n) -- very fast growth
  +------------------------------------> O(1) -- constant, best possible
  +----------------------------------------------------> Input size (n)

  Relative scale for n = 100:
    O(1)       =           1
    O(log n)   =          ~7
    O(n)       =         100
    O(n log n) =       ~664
    O(n^2)     =      10,000
    O(2^n)     = 1.27e+30
    O(n!)      = 9.33e+157   (more than atoms in the universe)

  Rule of thumb (operations per second ~ 10^8):
    n = 10     -> O(n!) OK, O(2^n) borderline
    n = 100    -> O(n^2) OK, O(n^3) borderline
    n = 1000   -> O(n^2) borderline, prefer O(n log n)
    n = 10^5   -> need O(n log n) or better
    n = 10^6   -> need O(n) or O(n log n)
    n = 10^9   -> need O(log n) or O(1)
```

---

## 3. Time Complexity Table — Common Operations

### Arrays (dynamic, e.g. ArrayList)

| Operation | Time |
|---|---|
| Access by index | O(1) |
| Search (unsorted) | O(n) |
| Search (sorted, binary search) | O(log n) |
| Insert at end (amortized) | O(1) |
| Insert at middle/front | O(n) |
| Delete from end | O(1) |
| Delete from middle/front | O(n) |

### Linked Lists (singly)

| Operation | Time |
|---|---|
| Access by index | O(n) |
| Search | O(n) |
| Insert at head | O(1) |
| Insert at tail (with tail pointer) | O(1) |
| Insert in middle (given node) | O(1) |
| Delete head | O(1) |
| Delete middle (given node) | O(1); without reference O(n) |

### Hash Maps (HashMap)

| Operation | Average | Worst |
|---|---|---|
| Search / get | O(1) | O(n) |
| Insert / put | O(1) | O(n) |
| Delete | O(1) | O(n) |

Worst case O(n) occurs when all keys collide into the same bucket. Java 8+ converts long collision chains to balanced trees, giving O(log n) worst case for Comparable keys.

### Binary Search Trees

| Operation | Balanced (AVL/Red-Black) | Unbalanced |
|---|---|---|
| Search | O(log n) | O(n) |
| Insert | O(log n) | O(n) |
| Delete | O(log n) | O(n) |
| Min / Max | O(log n) | O(n) |
| In-order traversal | O(n) | O(n) |

### Heaps (binary heap, PriorityQueue)

| Operation | Time |
|---|---|
| Peek (min/max) | O(1) |
| Insert (offer) | O(log n) |
| Extract min/max (poll) | O(log n) |
| Heapify (build heap from array) | O(n) |
| Find arbitrary element | O(n) |

### Sorting Algorithms

| Algorithm      | Best       | Average    | Worst      | Space    | Stable |
| -------------- | ---------- | ---------- | ---------- | -------- | ------ |
| Merge sort     | O(n log n) | O(n log n) | O(n log n) | O(n)     | Yes    |
| Quick sort     | O(n log n) | O(n log n) | O(n^2)     | O(log n) | No     |
| Heap sort      | O(n log n) | O(n log n) | O(n log n) | O(1)     | No     |
| Insertion sort | O(n)       | O(n^2)     | O(n^2)     | O(1)     | Yes    |
| Counting sort  | O(n + k)   | O(n + k)   | O(n + k)   | O(k)     | Yes    |
| Radix sort     | O(nk)      | O(nk)      | O(nk)      | O(n + k) | Yes    |

Java's Arrays.sort() uses dual-pivot quicksort for primitives (O(n log n) average, O(n^2) worst) and Timsort for objects (O(n log n) worst, stable). Collections.sort() uses Timsort.

---

## 4. Space Complexity Basics

Space complexity measures extra memory an algorithm uses beyond the input, as a function of n.

Common sources of space usage:

- Recursion call stack: each recursive call adds a frame. Depth d costs O(d).
- Auxiliary data structures: a HashMap of size n costs O(n).
- Output that scales with input is sometimes counted, sometimes not — clarify with your interviewer.

Examples:

```java
// O(1) space — only a few variables
int sum(int[] arr) {
    int total = 0;
    for (int x : arr) total += x;
    return total;
}

// O(n) space — a new array
int[] doubled(int[] arr) {
    int[] out = new int[arr.length];
    for (int i = 0; i < arr.length; i++) out[i] = arr[i] * 2;
    return out;
}

// O(n) space — recursion depth
int factorial(int n) {
    if (n <= 1) return 1;
    return n * factorial(n - 1);   // call stack depth n
}

// O(log n) space — balanced recursion depth
int binarySearch(int[] a, int lo, int hi, int target) {
    if (lo > hi) return -1;
    int mid = (lo + hi) / 2;
    if (a[mid] == target) return mid;
    if (a[mid] < target) return binarySearch(a, mid + 1, hi, target);
    return binarySearch(a, lo, mid - 1, target);
}
```

In-place algorithms use O(1) extra space. Examples: two-pointer array reversal, heapsort, in-place quicksort (O(log n) stack).

---

## 5. Amortized Analysis

Amortized analysis averages the cost of a sequence of operations, smoothing out expensive rare operations across many cheap ones.

### ArrayList add — O(1) amortized

When the backing array is full, ArrayList allocates a new array (typically 1.5x or 2x) and copies elements. That single resize is O(n), but it happens so rarely that the average cost per insert is O(1).

Informal proof: to trigger a resize after inserting n elements, the array must have been at capacity. The total work over n inserts = n (the inserts) + 1 + 2 + 4 + ... + n/2 + n (the resizes) < 3n. So total is O(n), giving O(1) amortized per insert.

```java
// ArrayList: add is O(1) amortized even though occasional resize is O(n)
List<Integer> list = new ArrayList<>();
for (int i = 0; i < n; i++) list.add(i);   // total O(n), each add O(1) amortized
```

### StringBuilder append — O(1) amortized

String concatenation with + creates a new String and copies both operands every time, making repeated concat O(n^2). StringBuilder uses an internal char buffer that resizes geometrically, so each append is O(1) amortized and n appends are O(n) total.

```java
// Bad: O(n^2) — new String + copy each time
String s = "";
for (int i = 0; i < n; i++) s += "x";

// Good: O(n) — amortized O(1) per append
StringBuilder sb = new StringBuilder();
for (int i = 0; i < n; i++) sb.append("x");
String result = sb.toString();
```

Three methods of amortized analysis:

1. Aggregate method: total cost of n operations divided by n. (Used above.)
2. Accounting method: charge each operation a bit more than its true cost, bank the surplus to pay for expensive operations.
3. Potential method: define a potential function over the data structure; amortized cost = actual cost + change in potential.

---

## 6. Recurrence Relations and the Master Theorem

Divide-and-conquer algorithms produce recurrences of the form:

    T(n) = a * T(n / b) + f(n)

where:
- a >= 1 is the number of subproblems
- b > 1 is the factor the input shrinks by
- f(n) is the cost of dividing and combining

The Master Theorem classifies T(n) by comparing f(n) with n^(log_b a):

Let d = log_b(a).

Case 1: if f(n) = O(n^(d - epsilon)) for some epsilon > 0, then T(n) = Theta(n^d).
Case 2: if f(n) = Theta(n^d), then T(n) = Theta(n^d * log n).
Case 2 generalized: if f(n) = Theta(n^d * log^k n), then T(n) = Theta(n^d * log^(k+1) n).
Case 3: if f(n) = Omega(n^(d + epsilon)) and the regularity condition a*f(n/b) <= c*f(n) holds, then T(n) = Theta(f(n)).

Worked examples:

- Binary search: T(n) = T(n/2) + O(1). a=1, b=2, d=log_2(1)=0. f(n)=1=Theta(n^0). Case 2: T(n)=Theta(log n).
- Merge sort: T(n) = 2T(n/2) + O(n). a=2, b=2, d=log_2(2)=1. f(n)=n=Theta(n^1). Case 2: T(n)=Theta(n log n).
- Strassen matrix multiply: T(n) = 7T(n/2) + O(n^2). a=7, b=2, d=log_2(7)≈2.81. f(n)=n^2=O(n^(2.81-eps)). Case 1: T(n)=Theta(n^2.81).
- Karatsuba: T(n) = 3T(n/2) + O(n). a=3, b=2, d=log_2(3)≈1.58. f(n)=n=O(n^(1.58-eps)). Case 1: T(n)=Theta(n^1.58).

When the recurrence doesn't fit the standard form (uneven splits, subtractive terms), use the recursion tree method or the Akra-Bazzi theorem.

---

## 7. Common Complexity Classes with Java Examples

### O(1) — Constant

```java
// Hash map lookup
Map<String, Integer> map = new HashMap<>();
map.put("a", 1);
int val = map.get("a");          // O(1) average

// Array index access
int first = arr[0];              // O(1)
```

### O(log n) — Logarithmic

```java
// Binary search
int binarySearch(int[] a, int target) {
    int lo = 0, hi = a.length - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        if (a[mid] == target) return mid;
        else if (a[mid] < target) lo = mid + 1;
        else hi = mid - 1;
    }
    return -1;
}
```

### O(n) — Linear

```java
// Single pass
int max(int[] arr) {
    int m = arr[0];
    for (int x : arr) if (x > m) m = x;
    return m;
}
```

### O(n log n) — Linearithmic

```java
// Merge sort
void mergeSort(int[] a, int lo, int hi) {
    if (lo >= hi) return;
    int mid = (lo + hi) / 2;
    mergeSort(a, lo, mid);
    mergeSort(a, mid + 1, hi);
    merge(a, lo, mid, hi);
}

void merge(int[] a, int lo, int mid, int hi) {
    int[] tmp = new int[hi - lo + 1];
    int i = lo, j = mid + 1, k = 0;
    while (i <= mid && j <= hi)
        tmp[k++] = a[i] <= a[j] ? a[i++] : a[j++];
    while (i <= mid) tmp[k++] = a[i++];
    while (j <= hi) tmp[k++] = a[j++];
    System.arraycopy(tmp, 0, a, lo, tmp.length);
}
```

### O(n^2) — Quadratic

```java
// Bubble sort
void bubbleSort(int[] a) {
    for (int i = 0; i < a.length; i++)
        for (int j = 0; j < a.length - i - 1; j++)
            if (a[j] > a[j + 1]) {
                int t = a[j]; a[j] = a[j + 1]; a[j + 1] = t;
            }
}
```

### O(2^n) — Exponential

```java
// Naive recursive Fibonacci
int fib(int n) {
    if (n <= 1) return n;
    return fib(n - 1) + fib(n - 2);   // two branches per call
}
```

### O(n!) — Factorial

```java
// Generate all permutations
void permutations(int[] a, int start) {
    if (start == a.length) { /* process a */ return; }
    for (int i = start; i < a.length; i++) {
        swap(a, start, i);
        permutations(a, start + 1);
        swap(a, start, i);
    }
}
```

---

## 8. When to Use Which Data Structure — Decision Table

| Need | Best choice | Why |
|---|---|---|
| Fast random access by index | Array / ArrayList | O(1) index access |
| Frequent insert/delete at front | LinkedList / ArrayDeque | O(1) head ops vs O(n) for ArrayList |
| Key-value lookup | HashMap | O(1) average get/put |
| Ordered key-value, range queries | TreeMap | O(log n) ops, sorted iteration |
| Unique elements, fast membership | HashSet | O(1) average contains |
| Unique sorted elements | TreeSet | O(log n), sorted iteration |
| Min/max access repeatedly | PriorityQueue (heap) | O(1) peek, O(log n) insert/remove |
| LRU cache | LinkedHashMap (access-order) | O(1) get/put with eviction |
| Stack (LIFO) | ArrayDeque | O(1) push/pop, faster than Stack |
| Queue (FIFO) | ArrayDeque | O(1) offer/poll |
| Double-ended queue | ArrayDeque | O(1) both ends |
| Two-way traversal | LinkedList (doubly) | O(1) prev/next with node refs |
| Prefix string matching | Trie | O(L) search/insert, L = key length |
| Disjoint sets / union-find | UnionFind (DSU) | ~O(1) amortized union/find |
| Range sum / point update | Fenwick tree (BIT) | O(log n) both |
| Range updates / queries | Segment tree | O(log n) both |
| Graph adjacency | HashMap/List of Lists | O(V+E) space, flexible |

Choosing by operation priority:

- Fast lookup wins → HashMap/HashSet.
- Order matters → TreeMap/TreeSet or sort an array.
- Frequent middle insert/delete → LinkedList (but only if you already hold the node).
- Priority ordering → PriorityQueue.
- Immutable snapshots → persistent structures or copy arrays.

---

## 9. Interview Pattern Recognition Guide

The core idea: most interview problems map to a small set of patterns. Recognizing the pattern from the problem statement is half the battle. Train yourself to ask, "What pattern does the problem structure signal?"

Signal-to-pattern heuristics:

- Sorted array + search → binary search.
- Sorted/rotated array + find target → modified binary search.
- Two sorted arrays + merge → two pointers.
- Contiguous subarray + condition → sliding window.
- Linked list + cycle / middle / kth-from-end → fast & slow pointers.
- Intervals + overlap → merge intervals.
- Array of 1..n + find missing/duplicate → cyclic sort.
- Shortest path in unweighted graph → BFS.
- All paths / connectivity → DFS.
- Task scheduling with deps → topological sort.
- K largest/smallest / frequent → heap (top K).
- Repeated subproblems / optimal substructure → DP.
- All combinations / permutations / subsets → backtracking.
- Greedy choice locally optimal → greedy.
- Range sum queries → prefix sums.
- Next greater/smaller element → monotonic stack.
- In-place reorder + two ends → two pointers.

A systematic recognition process:

1. Read the problem; identify the input type (array, list, tree, graph, string).
2. Identify the output type (count, index, boolean, path, sequence).
3. Identify constraints (sorted? unique? range 1..n? contiguous? k value?).
4. Match constraints to a pattern using the master table below.
5. If two patterns fit, estimate complexity and pick the cheaper one.

---

## 10. The 15 Most Important Patterns — Templates in Java

### 10.1 Two Pointers

Use when: sorted array, pair/triplet sum, palindrome, in-place removal, comparing two sequences.

```java
// Two Sum on a sorted array
int[] twoSumSorted(int[] nums, int target) {
    int left = 0, right = nums.length - 1;
    while (left < right) {
        int sum = nums[left] + nums[right];
        if (sum == target) return new int[]{left, right};
        else if (sum < target) left++;
        else right--;
    }
    return new int[]{-1, -1};
}

// Remove duplicates in place
int removeDuplicates(int[] nums) {
    int w = 0;
    for (int r = 0; r < nums.length; r++)
        if (r == 0 || nums[r] != nums[r - 1]) nums[w++] = nums[r];
    return w;
}
```

Complexity: O(n) time, O(1) space.

### 10.2 Sliding Window

Use when: contiguous subarray/substring, max/min sum or length with a constraint, fixed or variable window.

```java
// Variable window: longest substring with at most K distinct chars
int longestSubstrKDistinct(String s, int k) {
    Map<Character, Integer> freq = new HashMap<>();
    int left = 0, maxLen = 0;
    for (int right = 0; right < s.length(); right++) {
        char c = s.charAt(right);
        freq.merge(c, 1, Integer::sum);
        while (freq.size() > k) {                 // shrink until valid
            char d = s.charAt(left++);
            if (freq.merge(d, -1, Integer::sum) == 0) freq.remove(d);
        }
        maxLen = Math.max(maxLen, right - left + 1);
    }
    return maxLen;
}

// Fixed window: max sum of subarray of size k
int maxSumWindow(int[] nums, int k) {
    int sum = 0;
    for (int i = 0; i < k; i++) sum += nums[i];
    int max = sum;
    for (int i = k; i < nums.length; i++) {
        sum += nums[i] - nums[i - k];
        max = Math.max(max, sum);
    }
    return max;
}
```

Complexity: O(n) time, O(window state) space.

### 10.3 Fast & Slow Pointers

Use when: linked list cycle, middle node, kth from end, palindrome linked list.

```java
// Detect cycle
boolean hasCycle(ListNode head) {
    ListNode slow = head, fast = head;
    while (fast != null && fast.next != null) {
        slow = slow.next;
        fast = fast.next.next;
        if (slow == fast) return true;
    }
    return false;
}

// Find middle
ListNode middle(ListNode head) {
    ListNode slow = head, fast = head;
    while (fast != null && fast.next != null) {
        slow = slow.next;
        fast = fast.next.next;
    }
    return slow;
}
```

Complexity: O(n) time, O(1) space.

### 10.4 Merge Intervals

Use when: intervals, overlapping ranges, meeting rooms, insert interval.

```java
int[][] merge(int[][] intervals) {
    Arrays.sort(intervals, (a, b) -> a[0] - b[0]);
    List<int[]> merged = new ArrayList<>();
    for (int[] iv : intervals) {
        if (merged.isEmpty() || merged.get(merged.size() - 1)[1] < iv[0])
            merged.add(iv);
        else
            merged.get(merged.size() - 1)[1] =
                Math.max(merged.get(merged.size() - 1)[1], iv[1]);
    }
    return merged.toArray(new int[0][]);
}
```

Complexity: O(n log n) time (sort), O(n) space.

### 10.5 Cyclic Sort

Use when: array of 1..n (or 0..n-1), find missing/duplicate, in-place O(n).

```java
// Find all missing numbers in 1..n array
List<Integer> findMissing(int[] nums) {
    int i = 0;
    while (i < nums.length) {
        int correct = nums[i] - 1;
        if (nums[i] != nums[correct]) {
            int t = nums[i]; nums[i] = nums[correct]; nums[correct] = t;
        } else i++;
    }
    List<Integer> missing = new ArrayList<>();
    for (int j = 0; j < nums.length; j++)
        if (nums[j] != j + 1) missing.add(j + 1);
    return missing;
}
```

Complexity: O(n) time, O(1) space.

### 10.6 BFS

Use when: shortest path in unweighted graph, level-order traversal, nearest distance, min steps.

```java
// Shortest path in unweighted graph (BFS)
int bfsShortestPath(Map<Integer, List<Integer>> graph, int start, int target) {
    Queue<Integer> q = new LinkedList<>();
    Set<Integer> visited = new HashSet<>();
    q.offer(start);
    visited.add(start);
    int dist = 0;
    while (!q.isEmpty()) {
        int size = q.size();
        for (int i = 0; i < size; i++) {
            int node = q.poll();
            if (node == target) return dist;
            for (int nb : graph.getOrDefault(node, List.of()))
                if (visited.add(nb)) q.offer(nb);
        }
        dist++;
    }
    return -1;
}
```

Complexity: O(V + E) time, O(V) space.

### 10.7 DFS

Use when: all paths, connected components, island counting, tree traversal, backtracking base.

```java
// Count islands (grid DFS)
int numIslands(char[][] grid) {
    int count = 0;
    for (int r = 0; r < grid.length; r++)
        for (int c = 0; c < grid[0].length; c++)
            if (grid[r][c] == '1') {
                dfs(grid, r, c);
                count++;
            }
    return count;
}

void dfs(char[][] g, int r, int c) {
    if (r < 0 || c < 0 || r >= g.length || c >= g[0].length || g[r][c] != '1') return;
    g[r][c] = '0';
    dfs(g, r + 1, c); dfs(g, r - 1, c); dfs(g, r, c + 1); dfs(g, r, c - 1);
}
```

Complexity: O(V + E) time, O(V) recursion space.

### 10.8 Topological Sort

Use when: task scheduling with dependencies, build order, course prerequisites, DAG ordering.

```java
// Kahn's algorithm (BFS indegree)
int[] topologicalSort(int n, int[][] edges) {
    List<List<Integer>> adj = new ArrayList<>();
    int[] indegree = new int[n];
    for (int i = 0; i < n; i++) adj.add(new ArrayList<>());
    for (int[] e : edges) { adj.get(e[0]).add(e[1]); indegree[e[1]]++; }
    Queue<Integer> q = new LinkedList<>();
    for (int i = 0; i < n; i++) if (indegree[i] == 0) q.offer(i);
    int[] order = new int[n];
    int idx = 0;
    while (!q.isEmpty()) {
        int node = q.poll();
        order[idx++] = node;
        for (int nb : adj.get(node))
            if (--indegree[nb] == 0) q.offer(nb);
    }
    return idx == n ? order : new int[0];   // empty => cycle
}
```

Complexity: O(V + E) time, O(V + E) space.

### 10.9 Binary Search

Use when: sorted/rotated/searchable space, find min/max satisfying a monotonic condition, search on answer.

```java
// Find first index where condition is true (lower-bound style)
int lowerBound(int[] a, int target) {
    int lo = 0, hi = a.length;          // note: hi = length, not length-1
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (a[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// Binary search on answer: min capacity with monotonic feasibility
int minCapacity(int[] weights, int days) {
    int lo = max(weights), hi = sum(weights);
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (canShip(weights, days, mid)) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}
boolean canShip(int[] w, int days, int cap) {
    int d = 1, load = 0;
    for (int x : w) {
        if (load + x > cap) { d++; load = 0; }
        load += x;
    }
    return d <= days;
}
```

Complexity: O(log n) time, O(1) space.

### 10.10 Top K Elements

Use when: K largest/smallest, K most frequent, K closest, running median.

```java
// K most frequent elements
int[] topKFrequent(int[] nums, int k) {
    Map<Integer, Integer> freq = new HashMap<>();
    for (int x : nums) freq.merge(x, 1, Integer::sum);
    PriorityQueue<Integer> minHeap = new PriorityQueue<>(
        Comparator.comparingInt(freq::get));
    for (int key : freq.keySet()) {
        minHeap.offer(key);
        if (minHeap.size() > k) minHeap.poll();
    }
    int[] res = new int[k];
    for (int i = 0; i < k; i++) res[i] = minHeap.poll();
    return res;
}
```

Complexity: O(n log k) time, O(n) space. Use a min-heap for "top K largest" and a max-heap for "bottom K smallest" — keep heap size k so the expensive element is the one evicted.

### 10.11 Overlapping Subproblems DP

Use when: count ways, min/max path, knapsack, optimal substructure + repeated subproblems.

```java
// 0/1 Knapsack — top-down with memo
int knapSack(int[] wt, int[] val, int capacity) {
    int n = wt.length;
    Integer[][] memo = new Integer[n][capacity + 1];
    return ks(wt, val, n - 1, capacity, memo);
}
int ks(int[] wt, int[] val, int i, int cap, Integer[][] memo) {
    if (i < 0 || cap == 0) return 0;
    if (memo[i][cap] != null) return memo[i][cap];
    int take = cap >= wt[i] ? val[i] + ks(wt, val, i - 1, cap - wt[i], memo) : 0;
    int skip = ks(wt, val, i - 1, cap, memo);
    return memo[i][cap] = Math.max(take, skip);
}

// 1D DP: climbing stairs
int climbStairs(int n) {
    if (n <= 2) return n;
    int a = 1, b = 2;
    for (int i = 3; i <= n; i++) { int c = a + b; a = b; b = c; }
    return b;
}
```

Complexity: states * transition. Knapsack: O(n * capacity). Identify states (dimensions), write the recurrence, then memoize (top-down) or fill a table (bottom-up).

### 10.12 Subsets / Backtracking

Use when: all combinations, permutations, subsets, partition problems, any "generate all" problem.

```java
// All subsets
List<List<Integer>> subsets(int[] nums) {
    List<List<Integer>> result = new ArrayList<>();
    backtrack(nums, 0, new ArrayList<>(), result);
    return result;
}
void backtrack(int[] nums, int start, List<Integer> cur, List<List<Integer>> res) {
    res.add(new ArrayList<>(cur));          // snapshot
    for (int i = start; i < nums.length; i++) {
        cur.add(nums[i]);
        backtrack(nums, i + 1, cur, res);
        cur.remove(cur.size() - 1);         // undo
    }
}

// Permutations
List<List<Integer>> permute(int[] nums) {
    List<List<Integer>> res = new ArrayList<>();
    perm(nums, 0, res);
    return res;
}
void perm(int[] nums, int start, List<List<Integer>> res) {
    if (start == nums.length) {
        List<Integer> p = new ArrayList<>();
        for (int x : nums) p.add(x);
        res.add(p);
        return;
    }
    for (int i = start; i < nums.length; i++) {
        swap(nums, start, i);
        perm(nums, start + 1, res);
        swap(nums, start, i);
    }
}
```

Complexity: subsets O(2^n * n), permutations O(n! * n). Always "choose / explore / undo".

### 10.13 Greedy

Use when: a locally optimal choice leads to a globally optimal solution; activity selection, interval scheduling, jump game, gas station.

```java
// Jump game — greedy, always take the farthest reachable
boolean canJump(int[] nums) {
    int farthest = 0;
    for (int i = 0; i < nums.length; i++) {
        if (i > farthest) return false;     // unreachable
        farthest = Math.max(farthest, i + nums[i]);
    }
    return farthest >= nums.length - 1;
}

// Activity selection — pick earliest-ending compatible interval
int maxActivities(int[][] intervals) {
    Arrays.sort(intervals, (a, b) -> a[1] - b[1]);
    int count = 0, lastEnd = Integer.MIN_VALUE;
    for (int[] iv : intervals)
        if (iv[0] >= lastEnd) { count++; lastEnd = iv[1]; }
    return count;
}
```

Complexity: O(n) or O(n log n) with sort, O(1) space. Greedy works only when the choice property and optimal substructure both hold — prove it or test against brute force.

### 10.14 Prefix Sums

Use when: repeated range sum queries, subarray sum equals K, equilibrium index, 2D region sums.

```java
// Range sum [l, r] via prefix sum
int[] buildPrefix(int[] nums) {
    int[] p = new int[nums.length + 1];
    for (int i = 0; i < nums.length; i++) p[i + 1] = p[i] + nums[i];
    return p;
}
int rangeSum(int[] p, int l, int r) { return p[r + 1] - p[l]; }

// Count subarrays summing to K
int subarraySum(int[] nums, int k) {
    Map<Integer, Integer> prefixCount = new HashMap<>();
    prefixCount.put(0, 1);
    int sum = 0, count = 0;
    for (int x : nums) {
        sum += x;
        count += prefixCount.getOrDefault(sum - k, 0);
        prefixCount.merge(sum, 1, Integer::sum);
    }
    return count;
}
```

Complexity: O(n) build, O(1) query; O(n) space.

### 10.15 Monotonic Stack

Use when: next greater/smaller element, largest rectangle in histogram, daily temperatures, stock span.

```java
// Next greater element (to the right)
int[] nextGreater(int[] nums) {
    int[] res = new int[nums.length];
    Arrays.fill(res, -1);
    Deque<Integer> stack = new ArrayDeque<>();   // indices, decreasing values
    for (int i = 0; i < nums.length; i++) {
        while (!stack.isEmpty() && nums[stack.peek()] < nums[i])
            res[stack.pop()] = nums[i];
        stack.push(i);
    }
    return res;
}

// Largest rectangle in histogram
int largestRectangle(int[] heights) {
    Deque<Integer> stack = new ArrayDeque<>();
    int max = 0;
    for (int i = 0; i <= heights.length; i++) {
        int h = i == heights.length ? 0 : heights[i];
        while (!stack.isEmpty() && heights[stack.peek()] > h) {
            int height = heights[stack.pop()];
            int width = stack.isEmpty() ? i : i - stack.peek() - 1;
            max = Math.max(max, height * width);
        }
        stack.push(i);
    }
    return max;
}
```

Complexity: O(n) time (each element pushed/popped once), O(n) space.

---

## 11. Interview Strategy Framework

A repeatable six-step process for any coding problem. Practice it aloud until it's automatic.

### Step 1 — Clarify (2-3 min)

Ask before coding. Never assume.

- What is the exact input type and shape? (array of ints? string? tree?)
- Are there duplicates? negatives? empty input? null?
- What is the output? index? count? boolean? the value itself?
- Is the input sorted? bounded? within a known range?
- Can I mutate the input? use extra space? what are the constraints on n?
- Are there edge cases the interviewer wants handled?

Restate the problem in your own words to confirm understanding.

### Step 2 — Examples (1-2 min)

Construct examples yourself, covering:

- A normal case.
- An edge case (empty, single element, all same, already sorted, max size).
- A case that exposes a tricky part (duplicates, negatives, wraparound).

Write the expected output for each. These become your test cases later.

### Step 3 — Brute Force (2-3 min)

State the obvious solution even if it's O(n^2) or O(2^n). This:

- Proves you understand the problem.
- Gives a correctness baseline to optimize from.
- Often reveals the structure that the optimal solution exploits.

Describe it, give its complexity, then say "I can do better."

### Step 4 — Optimize (3-5 min)

Look for:

- Redundant work in the brute force (recomputing sums → prefix sums; recomputing subproblems → memoization).
- A data structure that removes the bottleneck (HashMap for O(1) lookup, heap for min/max, monotonic stack for next-greater).
- A pattern match (see Section 9).
- A different traversal order (sorting first, then two pointers).
- Reducing a dimension (1D DP from 2D when only the previous row matters).

State the new approach and its complexity before coding. Trade-offs: time vs space, simplicity vs optimality.

### Step 5 — Code (10-15 min)

- Name variables clearly. Avoid single letters except loop indices.
- Modularize: extract a helper for repeated logic.
- Handle edge cases at the top (early returns).
- Talk as you write — narrate the non-obvious parts.
- Keep the happy path correct first; add guards after.

### Step 6 — Test (3-5 min)

Never say "done" without tracing.

- Run through your examples from Step 2 by hand.
- Check boundary indices: off-by-one at 0, length-1, mid.
- Check empty and single-element inputs.
- Check the loop termination and the return value.
- If you find a bug, fix it and re-trace.

Mental checklist: Did I handle null? empty array? one element? duplicates? negative numbers? integer overflow? off-by-one?

Time budget for a 45-minute interview: clarify 3, examples 2, brute 3, optimize 5, code 20, test 7, discuss 5.

---

## 12. Master Pattern Recognition Table

50+ problem keywords mapped to the pattern(s) most likely to solve them. When multiple patterns fit, the first listed is usually the primary.

| Problem keyword / phrase | Pattern |
|---|---|
| sorted array, find target | Binary Search |
| rotated sorted array | Binary Search (modified) |
| find first/last position | Binary Search (lower/upper bound) |
| min/max satisfying condition | Binary Search on Answer |
| search in sorted matrix | Binary Search / Staircase |
| two sum, pair sum | Two Pointers (sorted) or HashMap |
| three sum, triplet sum | Two Pointers + sort |
| quadruple sum | Two Pointers nested |
| palindrome string / list | Two Pointers from ends |
| remove duplicates in place | Two Pointers (read/write) |
| contiguous subarray, max/min sum | Sliding Window / Kadane |
| longest substring with constraint | Sliding Window (variable) |
| fixed-size subarray max | Sliding Window (fixed) |
| longest substring without repeats | Sliding Window + Set |
| minimum window substring | Sliding Window + HashMap |
| linked list cycle | Fast & Slow Pointers |
| middle of linked list | Fast & Slow Pointers |
| kth from end | Two Pointers (offset) |
| palindrome linked list | Fast & Slow + Reverse |
| merge intervals | Merge Intervals |
| meeting rooms | Merge Intervals |
| insert interval | Merge Intervals |
| non-overlapping intervals | Merge Intervals / Greedy |
| array of 1..n, missing number | Cyclic Sort |
| find duplicate in 1..n | Cyclic Sort / Floyd |
| find all duplicates | Cyclic Sort |
| shortest path unweighted | BFS |
| min steps / moves on grid | BFS |
| level order traversal | BFS |
| word ladder | BFS |
| nearest distance / cell | Multi-source BFS |
| number of islands | DFS / BFS |
| all paths / count paths | DFS |
| connected components | DFS / Union-Find |
| flood fill | DFS |
| course schedule / prerequisites | Topological Sort |
| task scheduling with deps | Topological Sort |
| build order | Topological Sort |
| alien dictionary | Topological Sort |
| kth largest / smallest | Heap (Quickselect alt) |
| k most frequent | Heap + HashMap |
| k closest points | Heap |
| running median | Two Heaps |
| merge k sorted lists | Heap |
| count ways / number of ways | DP |
| min/max path sum | DP |
| longest common subsequence | DP (2D) |
| edit distance | DP (2D) |
| knapsack | DP |
| coin change | DP |
| house robber | DP (1D) |
| longest increasing subsequence | DP / Patience sort |
| decode ways | DP |
| generate all subsets | Backtracking |
| generate permutations | Backtracking |
| generate combinations | Backtracking |
| partition into k equal sums | Backtracking |
| solve sudoku / N-queens | Backtracking |
| word search in grid | Backtracking (DFS) |
| jump game | Greedy |
| gas station | Greedy |
| assign tasks / intervals | Greedy |
| fractional knapsack | Greedy |
| range sum query | Prefix Sums |
| subarray sum equals K | Prefix Sums + HashMap |
| 2D region sum | 2D Prefix Sums |
| equilibrium index | Prefix Sums |
| next greater element | Monotonic Stack |
| next smaller element | Monotonic Stack |
| daily temperatures | Monotonic Stack |
| largest rectangle in histogram | Monotonic Stack |
| stock span | Monotonic Stack |
| trapping rain water | Monotonic Stack / Two Pointers |
| sliding window maximum | Monotonic Deque |
| anagram grouping | HashMap (frequency key) |
| longest word in dictionary | Trie / Sort |
| word search / autocomplete | Trie |
| union of sets / connectivity | Union-Find |
| redundant connection | Union-Find |
| number of provinces | Union-Find / DFS |
| design LRU cache | LinkedHashMap / HashMap + DLL |
| median of data stream | Two Heaps |

---

## 13. Data Structure Cheat Sheet

| Structure | Access | Search | Insert | Delete | Space | Notes |
|---|---|---|---|---|---|---|
| Array | O(1) | O(n) | O(n) | O(n) | O(n) | fixed size, cache-friendly |
| ArrayList | O(1) | O(n) | O(1) amortized end | O(n) | O(n) | dynamic, resizes geometrically |
| LinkedList | O(n) | O(n) | O(1) head | O(1) head/tail | O(n) | more memory per node |
| HashMap | O(1) avg | O(1) avg | O(1) avg | O(1) avg | O(n) | unordered, null keys vary |
| TreeMap | O(log n) | O(log n) | O(log n) | O(log n) | O(n) | sorted keys, red-black tree |
| HashSet | O(1) avg | O(1) avg | O(1) avg | O(1) avg | O(n) | unique elements |
| TreeSet | O(log n) | O(log n) | O(log n) | O(log n) | O(n) | sorted unique elements |
| PriorityQueue | O(n) | O(n) | O(log n) | O(log n) poll | O(n) | min/max peek O(1) |
| Stack (ArrayDeque) | O(n) | O(n) | O(1) push | O(1) pop | O(n) | LIFO |
| Queue (ArrayDeque) | O(n) | O(n) | O(1) offer | O(1) poll | O(n) | FIFO |
| Binary Heap | O(1) peek | O(n) | O(log n) | O(log n) | O(n) | complete binary tree |
| BST (balanced) | O(log n) | O(log n) | O(log n) | O(log n) | O(n) | AVL / red-black |
| BST (unbalanced) | O(n) | O(n) | O(n) | O(n) | O(n) | degrades to linked list |
| Trie | O(L) | O(L) | O(L) | O(L) | O(AL) | L=key len, A=alphabet |
| Graph (adj list) | O(V) | O(V+E) | O(1) | O(E) | O(V+E) | sparse-friendly |
| Graph (adj matrix) | O(1) edge | O(V^2) | O(1) | O(1) | O(V^2) | dense graphs |
| Union-Find | ~O(1) find | ~O(1) union | n/a | n/a | O(n) | path compression + union by rank |
| Segment Tree | O(log n) | O(log n) | O(log n) | O(log n) | O(n) | range queries |
| Fenwick Tree (BIT) | O(log n) | O(log n) | O(log n) | O(log n) | O(n) | prefix queries |

---

## 14. Complexity Class Ordering and Intuition

From fastest to slowest growth:

    O(1) < O(log log n) < O(log n) < O(sqrt n) < O(n) < O(n log n) < O(n^2)
    < O(n^3) < O(2^n) < O(n!) < O(n^n)

Intuition for each:

- O(1): constant, independent of n. Hash lookup, array index.
- O(log n): halving or doubling per step. Binary search, balanced tree ops.
- O(n): one pass over the input. Linear scan, BFS/DFS visit each node.
- O(n log n): a linear pass plus a logarithmic structure. Sorting, divide-and-conquer merge.
- O(n^2): nested passes over n. All pairs, naive matrix, simple DP tables.
- O(2^n): subsets or branching recursion. Naive subset sum, naive Fibonacci.
- O(n!): permutations. Brute-force TSP, generate all orderings.

Most interviews expect you to beat O(n^2) for n up to 10^5, which means the answer usually lives in the O(n), O(n log n), or O(log n) band — exactly the band the patterns above target.

---

## 15. Common Pitfalls and Reminders

- Off-by-one: always decide whether your bounds are inclusive or exclusive and stay consistent. Binary search is the most common offender.
- Integer overflow: sum of many ints or mid = (lo + hi) / 2 can overflow. Use lo + (hi - lo) / 2 and long for sums.
- Mutating input you still iterate: removing from an ArrayList while looping forward skips elements. Iterate backward or use an iterator.
- Hash assumptions: HashMap get/put is O(1) average but O(n) worst. If an interviewer asks for guaranteed bounds, use TreeMap.
- Confusing amortized with worst: ArrayList.add is O(1) amortized but O(n) on resize. State which you mean.
- Forgetting recursion space: a "O(1) extra space" claim is wrong if recursion goes n deep. That's O(n) stack space.
- Premature optimization: get a correct solution first, then optimize. A correct O(n^2) beats a broken O(n).
- Pattern forcing: not every problem with "subarray" is a sliding window. Read the constraint (fixed size? condition? min/max?) before committing.
- Not testing edge cases: empty input, single element, all duplicates, already sorted, reversed — these catch most bugs.
- Silent integer division: 5 / 2 in Java is 2. Use doubles or cast when you need fractional results.

---

## 16. Quick Complexity Estimation Heuristics

Count the loops and structure:

- One loop over n → O(n).
- Two nested loops over n → O(n^2).
- A loop that halves n each step → O(log n).
- A loop over n doing a log n operation (sort inside) → O(n log n).
- Recursion that branches b ways to depth d → O(b^d) leaves.
- Recursion T(n) = 2T(n/2) + O(n) → O(n log n) (merge sort).
- Sorting then linear pass → O(n log n) total.
- Building a heap → O(n); each extract → O(log n).

When in doubt, count how many times the basic operation runs as a function of n and drop constants and lower-order terms.

---

## 17. Space-Time Tradeoff Cheat Sheet

| Tradeoff | Example |
|---|---|
| Hash table: O(n) space buys O(1) lookup | Two Sum with HashMap |
| Prefix sum: O(n) space buys O(1) range sum | Range sum queries |
| Memoization: O(states) space removes recomputation | DP top-down |
| Sorting: O(n log n) time enables O(n) two-pointer | Two Sum sorted |
| Auxiliary array: O(n) space enables stable merge | Merge sort |
| Bit manipulation: O(1) space replaces a set | Find single number |

Always ask: can I spend space to save time, or vice versa? The interviewer often wants to hear you name the tradeoff explicitly.

---

## 18. Putting It All Together — A Pattern-First Solve Example

Problem: Given an array of integers and a target k, find the number of contiguous subarrays whose product is less than k.

Walk-through using the framework:

1. Clarify: positive integers only? "yes". Empty array? return 0. k can be 0 or 1.
2. Examples: [10, 5, 2, 6], k = 100 → 8. Edge: k = 0 → 0 (product always >= 1).
3. Brute force: check every subarray, multiply. O(n^2) time, O(1) space.
4. Optimize: contiguous + condition → sliding window. Expand right; while product >= k, shrink left; every index in [left, right] ending at right is a valid subarray, so add (right - left + 1).
5. Code:

```java
int numSubarrayProductLessThanK(int[] nums, int k) {
    if (k <= 1) return 0;
    int count = 0, prod = 1, left = 0;
    for (int right = 0; right < nums.length; right++) {
        prod *= nums[right];
        while (prod >= k) prod /= nums[left++];
        count += right - left + 1;
    }
    return count;
}
```

6. Test: trace [10,5,2,6], k=100 → windows add 1+2+2+3 = 8. Edge k=0,1 → 0. Single element.

Pattern recognized: contiguous + condition → sliding window. Complexity O(n) time, O(1) space.

---

This reference condenses the complexity analysis and pattern recognition that underpin most coding interviews. Internalize the complexity table, drill the 15 templates until you can write them from memory, and practice the six-step framework on every problem. The patterns repeat; recognition speed is what separates passes from offers.

---

## Interview Cheat Sheet

**Key Points to Remember:**

- Big O is an upper bound on growth rate — ignore constants and lower-order terms (O(2n+5) → O(n)).
- O(n log n) is the theoretical lower bound for comparison-based sorting; you cannot do better with comparisons alone.
- Know the common complexity patterns by heart: O(1) hash lookup, O(log n) binary search, O(n) linear scan, O(n log n) sorting, O(n²) nested loops.
- Space complexity counts auxiliary (extra) space, not the input itself — always clarify whether output space is counted.
- Amortized analysis smooths out rare expensive operations — dynamic array append is O(1) amortized despite occasional O(n) resize.

**Common Follow-Up Questions:**

- *What's the difference between O and Θ?* — Big O is an upper bound (worst-case growth). Θ (theta) is a tight bound, meaning the function grows at exactly that rate (both upper and lower). Big Ω is the lower bound.
- *How do you analyze recursive complexity?* — Use the Master Theorem: T(n) = aT(n/b) + f(n). Compare f(n) with n^(log_b a) to determine which case applies and derive the closed-form complexity.

**Gotcha:**

Ignoring space complexity. Interviewers ask for BOTH time and space — always state both explicitly, even if the answer is O(1). Candidates who only mention time complexity signal incomplete analysis.
