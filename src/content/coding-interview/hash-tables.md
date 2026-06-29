---
title: "Hash Tables — Interview Prep Guide"
category: "Coding Interview"
difficulty: "Medium to Hard"
tags:
  - hash-table
  - hash-map
  - hash-set
  - frequency-map
  - two-sum
  - prefix-sum
  - sliding-window
  - anagram
  - design-hashmap
  - treemap
  - memoization
  - java
  - leetcode
date: 2026-06-19
---

# Hash Tables — The Complete Interview Prep Guide

Hash tables are the most important data structure for coding interviews. Their O(1) average insert, lookup, and delete collapses O(n²) brute-force solutions into O(n) single passes. This guide covers every major pattern — frequency maps, two-sum complement lookup, grouping by computed key, prefix-sum plus hash map, sliding window with hash map, memoization, custom HashMap design, TreeMap for range queries, counting sort, and graph adjacency — with Java templates and full solutions to classic LeetCode problems.

---

## Summary & Interview Framing

A data structure providing O(1) average insert/lookup/delete by mapping keys to array indices via a hash function, resolving collisions via chaining or open addressing.

**How it's asked:** "Two sum, group anagrams, longest substring without repeating characters, top K frequent elements — any problem requiring O(1) lookup, counting, grouping, or deduplication."

---

## 1. HashMap and HashSet Basics

A HashMap stores key-value pairs with average O(1) operations. A HashSet stores unique elements — it is a HashMap where every key maps to a sentinel. The O(1) comes from hashing the key, taking it modulo the bucket count, and storing in that bucket. Java 8+ uses a balanced-tree fallback for buckets over 8 entries, giving O(log n) worst case.

```
Key → hashCode() → mod N → bucket index
Bucket 0:  [K10:V10] → [K25:V25]
Bucket 1:  [K11:V11]
Bucket 2:  [K02:V02] → [K17:V17]
Bucket 3:  (empty)
```

```java
// Template: HashMap / HashSet core operations
Map<String, Integer> map = new HashMap<>();
map.put("apple", 3);
map.getOrDefault("banana", 0);   // → 0 (absent key returns default)
map.merge("key", 1, Integer::sum); // insert-or-accumulate (frequency idiom)
map.computeIfAbsent("k", k -> new ArrayList<>()).add(x); // lazy list creation

Set<Integer> set = new HashSet<>();
set.add(1); set.contains(2); // O(1) membership check
```

`getOrDefault` and `merge` are the two idioms you will use most — `getOrDefault` for frequency maps, `merge` for insert-or-accumulate. `computeIfAbsent` is the idiom for grouping (creates a list lazily, then returns it for `.add()`).

---

## 2. Frequency Maps

Iterate over a collection, count occurrences in a HashMap, then query the map. Turns "how many times does X appear" into O(n).

```java
// Template: Frequency Map
Map<Integer, Integer> freq = new HashMap<>();
for (int n : nums) freq.merge(n, 1, Integer::sum);
```

### LeetCode 347 — Top K Frequent Elements
Return the `k` most frequent elements. Combine a frequency map with bucket sort: place each element in a bucket indexed by its frequency, then collect from the top down. O(n).

```java
// Time: O(n)  |  Space: O(n)
class Solution {
    public int[] topKFrequent(int[] nums, int k) {
        Map<Integer, Integer> freq = new HashMap<>();
        for (int n : nums) freq.merge(n, 1, Integer::sum);

        List<Integer>[] bucket = new List[nums.length + 1];
        for (int key : freq.keySet()) {
            int c = freq.get(key);
            if (bucket[c] == null) bucket[c] = new ArrayList<>();
            bucket[c].add(key);
        }

        int[] res = new int[k];
        int idx = 0;
        for (int i = bucket.length - 1; i >= 0 && idx < k; i--)
            if (bucket[i] != null)
                for (int e : bucket[i]) if (idx < k) res[idx++] = e;
        return res;
    }
}
```

### LeetCode 387 — First Unique Character in a String
Find the first non-repeating character's index. Build a frequency map, then scan for the first character with count 1.

```java
class Solution {
    public int firstUniqChar(String s) {
        Map<Character, Integer> freq = new HashMap<>();
        for (char c : s.toCharArray()) freq.merge(c, 1, Integer::sum);
        for (int i = 0; i < s.length(); i++)
            if (freq.get(s.charAt(i)) == 1) return i;
        return -1;
    }
}
```

---

## 3. The Two-Sum Complement Lookup Pattern

For each element `x`, check whether `target - x` (the complement) already exists in a map of seen elements — an O(1) lookup replacing the O(n) inner scan. Generalises to any pair-satisfies-relation problem.

```java
// Template: Two-Sum Complement Lookup (one pass)
Map<Integer, Integer> seen = new HashMap<>();
for (int i = 0; i < nums.length; i++) {
    int complement = target - nums[i];
    if (seen.containsKey(complement)) return new int[]{seen.get(complement), i};
    seen.put(nums[i], i);
}
```

### LeetCode 1 — Two Sum
Return indices of two numbers summing to `target`. Store each value and its index; for each element, check if its complement was seen. Insert after checking to avoid using the same element twice.

```java
class Solution {
    public int[] twoSum(int[] nums, int target) {
        Map<Integer, Integer> map = new HashMap<>();
        for (int i = 0; i < nums.length; i++) {
            int comp = target - nums[i];
            if (map.containsKey(comp)) return new int[]{map.get(comp), i};
            map.put(nums[i], i);
        }
        throw new IllegalArgumentException("No solution");
    }
}
```

### LeetCode 454 — 4Sum II
Count tuples `(i,j,k,l)` across four arrays with `A[i]+B[j]+C[k]+D[l]==0`. Precompute all `A+B` sums into a frequency map, then for each `C+D` pair look up the negation. O(n²).

```java
class Solution {
    public int fourSumCount(int[] A, int[] B, int[] C, int[] D) {
        Map<Integer, Integer> ab = new HashMap<>();
        for (int a : A) for (int b : B) ab.merge(a + b, 1, Integer::sum);
        int count = 0;
        for (int c : C) for (int d : D) count += ab.getOrDefault(-(c + d), 0);
        return count;
    }
}
```

---

## 4. Grouping by Computed Key (Anagram Grouping)

Use a HashMap where the key is a computed signature and the value is a list of elements sharing it. For anagrams, the signature is the sorted string (O(k log k)) or a character-count tuple (O(k)).

```java
// Template: Group by computed key
Map<String, List<String>> groups = new HashMap<>();
for (String s : strs) {
    String key = computeSignature(s); // sorted chars or count tuple
    groups.computeIfAbsent(key, k -> new ArrayList<>()).add(s);
}
```

### LeetCode 49 — Group Anagrams
Group strings so anagrams are together. Sort each string's characters as the key; all anagrams produce the same sorted string.

```java
// Time: O(n·k log k)  |  Space: O(n·k)
class Solution {
    public List<List<String>> groupAnagrams(String[] strs) {
        Map<String, List<String>> map = new HashMap<>();
        for (String s : strs) {
            char[] c = s.toCharArray();
            Arrays.sort(c);
            map.computeIfAbsent(new String(c), k -> new ArrayList<>()).add(s);
        }
        return new ArrayList<>(map.values());
    }
}
```

O(n·k) variant using character-count keys:
```java
// O(n·k) — count tuple key, '#' delimiter prevents collisions
for (String s : strs) {
    int[] cnt = new int[26];
    for (char c : s.toCharArray()) cnt[c - 'a']++;
    StringBuilder key = new StringBuilder();
    for (int i : cnt) key.append(i).append('#');
    map.computeIfAbsent(key.toString(), k -> new ArrayList<>()).add(s);
}
```

### LeetCode 128 — Longest Consecutive Sequence
Find the longest consecutive elements sequence in O(n). Put all numbers in a HashSet. A sequence can only start where `n-1` is absent; from each start, count upward. Each number is visited at most twice.

```java
class Solution {
    public int longestConsecutive(int[] nums) {
        Set<Integer> set = new HashSet<>();
        for (int n : nums) set.add(n);
        int longest = 0;
        for (int n : set) {
            if (!set.contains(n - 1)) {  // only start at sequence beginnings
                int cur = n, streak = 1;
                while (set.contains(cur + 1)) { cur++; streak++; }
                longest = Math.max(longest, streak);
            }
        }
        return longest;
    }
}
```

---

## 5. Prefix Sum Plus Hash Map — O(1) Subarray Queries

When counting or measuring subarrays whose sum equals a target, maintain a running prefix sum. For current sum `P`, any earlier prefix sum `P'` where `P - P' = target` starts a valid subarray. Store prefix sums in a map and look up `P - target`. Seed with `{0: 1}` to catch subarrays starting at index 0.

```
Array: [1, 1, 1], target=2    Prefix: 0, 1, 2, 3
At i=1: P=2, need 2-2=0, found 1 → subarray [1,1]
At i=2: P=3, need 3-2=1, found 1 → subarray [1,1]  Total=2
```

```java
// Template: count subarrays with sum K
Map<Integer, Integer> prefixCount = new HashMap<>();
prefixCount.put(0, 1);  // seed
int sum = 0, count = 0;
for (int n : nums) {
    sum += n;
    count += prefixCount.getOrDefault(sum - k, 0);
    prefixCount.merge(sum, 1, Integer::sum);
}
```

### LeetCode 560 — Subarray Sum Equals K
Count contiguous subarrays summing to `k`. At each step, valid subarrays ending here equal the count of earlier prefix sums equal to `sum - k`.

```java
class Solution {
    public int subarraySum(int[] nums, int k) {
        Map<Integer, Integer> pc = new HashMap<>();
        pc.put(0, 1);  // seed: prefix 0 before array starts
        int sum = 0, count = 0;
        for (int num : nums) {
            sum += num;
            count += pc.getOrDefault(sum - k, 0);
            pc.merge(sum, 1, Integer::sum);
        }
        return count;
    }
}
```

The seed `pc.put(0, 1)` is the detail most candidates miss — without it, subarrays starting at index 0 with sum exactly `k` are lost.

### LeetCode 525 — Contiguous Array
Find the max-length subarray with equal 0s and 1s. Treat 0 as -1; the problem becomes "longest subarray with sum 0." Store the first occurrence of each prefix sum; when a sum reappears, the subarray between has sum 0.

```java
class Solution {
    public int findMaxLength(int[] nums) {
        Map<Integer, Integer> firstIdx = new HashMap<>();
        firstIdx.put(0, -1);
        int sum = 0, max = 0;
        for (int i = 0; i < nums.length; i++) {
            sum += (nums[i] == 0) ? -1 : 1;
            if (firstIdx.containsKey(sum)) max = Math.max(max, i - firstIdx.get(sum));
            else firstIdx.put(sum, i);  // store first occurrence only
        }
        return max;
    }
}
```

Contrast with 560: there we want count (store frequencies); here we want length (store first indices). Same pattern, different aggregation.

### LeetCode 523 — Continuous Subarray Sum
Check for a subarray of size ≥ 2 with sum divisible by `k`. Store prefix sums mod k; if the same remainder appears at indices ≥ 2 apart, the subarray between is divisible by k.

```java
class Solution {
    public boolean checkSubarraySum(int[] nums, int k) {
        Map<Integer, Integer> remIdx = new HashMap<>();
        remIdx.put(0, -1);
        int sum = 0;
        for (int i = 0; i < nums.length; i++) {
            sum += nums[i];
            int rem = sum % k;
            if (rem < 0) rem += k;  // Java % can be negative
            if (remIdx.containsKey(rem)) {
                if (i - remIdx.get(rem) >= 2) return true;
            } else remIdx.put(rem, i);
        }
        return false;
    }
}
```

---

## 6. Sliding Window with Hash Map

Maintain a window `[left, right]` that expands and contracts. When the constraint involves frequencies or membership, a hash map tracks window contents with O(1) updates as elements enter and leave.

```
  [  a  b  c  a  b  c  b  b  ]
     L           R
  Expand R → add to map → check constraint
  If violated → shrink L → remove from map
```

### LeetCode 3 — Longest Substring Without Repeating Characters
Store each character's most recent index. As `right` advances, if the current char is in the map at index ≥ `left`, it is a duplicate — jump `left` past it.

```java
class Solution {
    public int lengthOfLongestSubstring(String s) {
        Map<Character, Integer> last = new HashMap<>();
        int left = 0, max = 0;
        for (int right = 0; right < s.length(); right++) {
            char c = s.charAt(right);
            if (last.containsKey(c) && last.get(c) >= left)
                left = last.get(c) + 1;  // jump past duplicate
            last.put(c, right);
            max = Math.max(max, right - left + 1);
        }
        return max;
    }
}
```

The `last.get(c) >= left` check ignores stale entries from before the current window. Without it, you get false duplicate detections — the most common bug in this problem.

### LeetCode 76 — Minimum Window Substring
Find the minimum substring of `s` containing every character of `t`. Use two frequency maps: `need` (required) and `window` (current). A `formed` counter tracks how many unique chars have met their quota. When `formed == need.size()`, shrink from the left.

```java
// Time: O(|s|+|t|)  |  Space: O(|s|+|t|)
class Solution {
    public String minWindow(String s, String t) {
        if (s.length() < t.length()) return "";
        Map<Character, Integer> need = new HashMap<>();
        for (char c : t.toCharArray()) need.merge(c, 1, Integer::sum);
        Map<Character, Integer> win = new HashMap<>();
        int left = 0, formed = 0, required = need.size();
        int minLen = Integer.MAX_VALUE, minStart = 0;

        for (int right = 0; right < s.length(); right++) {
            char c = s.charAt(right);
            win.merge(c, 1, Integer::sum);
            if (need.containsKey(c) && win.get(c).intValue() == need.get(c).intValue())
                formed++;
            while (left <= right && formed == required) {
                if (right - left + 1 < minLen) { minLen = right - left + 1; minStart = left; }
                char d = s.charAt(left);
                win.merge(d, -1, Integer::sum);
                if (need.containsKey(d) && win.get(d) < need.get(d)) formed--;
                left++;
            }
        }
        return minLen == Integer.MAX_VALUE ? "" : s.substring(minStart, minStart + minLen);
    }
}
```

The `.intValue()` comparison avoids the Integer-cache trap (boxed `==` fails above 127). The `formed` counter tracks unique chars meeting their quota, not total chars, making validity checks O(1).

### LeetCode 438 — Find All Anagrams in a String
Find all start indices of `p`'s anagrams in `s`. Fixed-size window of `p.length()`; maintain a frequency array and compare against `p`'s counts at each position.

```java
class Solution {
    public List<Integer> findAnagrams(String s, String p) {
        List<Integer> res = new ArrayList<>();
        if (s.length() < p.length()) return res;
        int[] pc = new int[26], sc = new int[26];
        for (char c : p.toCharArray()) pc[c - 'a']++;
        int w = p.length();
        for (int i = 0; i < s.length(); i++) {
            sc[s.charAt(i) - 'a']++;
            if (i >= w) sc[s.charAt(i - w) - 'a']--;
            if (i >= w - 1 && Arrays.equals(sc, pc)) res.add(i - w + 1);
        }
        return res;
    }
}
```

---

## 7. Hash Map for Caching and Memoization

Store results of expensive function calls; return the cached result when the same inputs recur. In recursive problems with overlapping subproblems, a HashMap keyed by subproblem identity turns exponential recursion into polynomial time.

```java
// Template: Memoization
Map<Integer, Integer> memo = new HashMap<>();
public int solve(int n) {
    if (isBase(n)) return baseVal(n);
    if (memo.containsKey(n)) return memo.get(n);  // cache hit
    int res = /* recursive computation */;
    memo.put(n, res);  // cache store
    return res;
}
```

### LeetCode 198 — House Robber (memoized)
At each house, skip it or rob it and skip the next. Overlapping subproblems make naive recursion O(2ⁿ); memoization gives O(n).

```java
class Solution {
    Map<Integer, Integer> memo = new HashMap<>();
    public int rob(int[] nums) { return robFrom(nums, 0); }
    private int robFrom(int[] nums, int i) {
        if (i >= nums.length) return 0;
        if (memo.containsKey(i)) return memo.get(i);
        int best = Math.max(robFrom(nums, i + 1), nums[i] + robFrom(nums, i + 2));
        memo.put(i, best);
        return best;
    }
}
```

```

---

## 8. Custom Hash Objects — Design HashMap

Design a hash map from scratch: bucket array with separate chaining (linked lists per bucket). On `put`, compute the bucket index, walk the chain to find or insert. Add resizing when the load factor exceeds a threshold.

```
Buckets:  [0]→null  [1]→(k1,v1)→(k5,v5)  [2]→(k2,v2)  [3]→null
put(k5,v5): hash(k5)%N=1 → prepend to bucket 1's chain
```

### LeetCode 706 — Design HashMap
Implement `put`, `get`, `remove` without built-in libraries. Use separate chaining with 1000 buckets.

```java
class MyHashMap {
    private static class Entry { int key, value; Entry next; Entry(int k, int v){key=k;value=v;} }
    private Entry[] buckets = new Entry[1000];

    private int hash(int key) { return key % 1000; }

    public void put(int key, int value) {
        int i = hash(key);
        for (Entry e = buckets[i]; e != null; e = e.next)
            if (e.key == key) { e.value = value; return; }
        Entry n = new Entry(key, value);
        n.next = buckets[i];
        buckets[i] = n;
    }

    public int get(int key) {
        for (Entry e = buckets[hash(key)]; e != null; e = e.next)
            if (e.key == key) return e.value;
        return -1;
    }

    public void remove(int key) {
        int i = hash(key);
        Entry prev = null, curr = buckets[i];
        while (curr != null) {
            if (curr.key == key) {
                if (prev == null) buckets[i] = curr.next;
                else prev.next = curr.next;
                return;
            }
            prev = curr; curr = curr.next;
        }
    }
}
```

For small known key ranges (e.g., `[0, 10⁶]`), a direct-address `int[]` initialised to -1 is simpler. The chaining approach is more space-efficient for sparse usage and demonstrates hash-table internals.

---

## 9. Ordered Hash Map — TreeMap for Range Queries

A `HashMap` has no iteration order. For nearest key, predecessor/successor, or range queries, use a `TreeMap` (red-black tree) with O(log n) operations and ordered methods.

```
              20
             /  \
           10    30
           /       \
          5        40

ceilingKey(15)→20  floorKey(15)→10
higherKey(20)→30   lowerKey(20)→10
subMap(10,30)→keys in [10,30)
```

```java
TreeMap<Integer, String> tm = new TreeMap<>();
tm.ceilingKey(15); // smallest key ≥ 15
tm.floorKey(15);   // largest key ≤ 15
tm.higherKey(20);  // smallest key > 20
tm.lowerKey(20);   // largest key < 20
tm.subMap(10, 30); // entries with keys in [10, 30)
```

### LeetCode 220 — Contains Duplicate III
Check for indices `i,j` with `|i-j| ≤ indexDiff` and `|nums[i]-nums[j]| ≤ valueDiff`. Sliding window + TreeSet: for each element, check if a window value falls within `[num - valueDiff, num + valueDiff]` using `ceiling`.

```java
class Solution {
    public boolean containsNearbyAlmostDuplicate(int[] nums, int indexDiff, int valueDiff) {
        TreeSet<Long> win = new TreeSet<>();
        for (int i = 0; i < nums.length; i++) {
            if (i > indexDiff) win.remove((long) nums[i - indexDiff - 1]);
            long num = nums[i];
            Long ceil = win.ceiling(num - valueDiff);
            if (ceil != null && ceil <= num + valueDiff) return true;
            win.add(num);
        }
        return false;
    }
}
// Long casts prevent overflow when valueDiff is Integer.MAX_VALUE.
```

### LeetCode 846 — Hand of Straights
Arrange cards into groups of `groupSize` consecutive cards. TreeMap of counts: repeatedly take the smallest key, check for the next `groupSize-1` consecutive values.

```java
class Solution {
    public boolean isNStraightHand(int[] hand, int groupSize) {
        if (hand.length % groupSize != 0) return false;
        TreeMap<Integer, Integer> cnt = new TreeMap<>();
        for (int c : hand) cnt.merge(c, 1, Integer::sum);
        while (!cnt.isEmpty()) {
            int first = cnt.firstKey();
            for (int c = first; c < first + groupSize; c++) {
                if (!cnt.containsKey(c)) return false;
                cnt.merge(c, -1, Integer::sum);
                if (cnt.get(c) == 0) cnt.remove(c);
            }
        }
        return true;
    }
}
```

---

## 10. Counting Sort with a Hash Map

Counting sort uses an array indexed by value to count occurrences. A hash map replaces the array for sparse or non-integer values, trading O(range) space for O(distinct values).

```java
// Template: Counting Sort with TreeMap
Map<Integer, Integer> cnt = new TreeMap<>();
for (int n : nums) cnt.merge(n, 1, Integer::sum);
int[] res = new int[nums.length]; int idx = 0;
for (Map.Entry<Integer, Integer> e : cnt.entrySet())
    for (int i = 0; i < e.getValue(); i++) res[idx++] = e.getKey();
```

### LeetCode 274 — H-Index
Find the largest `h` with at least `h` papers having ≥ `h` citations. Counting sort with a cap at `n` (no h-index can exceed `n`): `count[n]` accumulates all papers with ≥ `n` citations.

```java
class Solution {
    public int hIndex(int[] citations) {
        int n = citations.length;
        int[] cnt = new int[n + 1];
        for (int c : citations) { if (c >= n) cnt[n]++; else cnt[c]++; }
        int total = 0;
        for (int h = n; h >= 0; h--) { total += cnt[h]; if (total >= h) return h; }
        return 0;
    }
}
```

```

---

## 11. Hash Map for Graph Adjacency

A `HashMap<Node, List<Neighbour>>` is the most flexible adjacency representation — handles sparse graphs, non-integer labels, and dynamic nodes. `computeIfAbsent` creates lists lazily; `getOrDefault` handles nodes with no outgoing edges.

```java
// Template: Graph adjacency with a HashMap
Map<Integer, List<Integer>> adj = new HashMap<>();
for (int[] e : edges) {
    adj.computeIfAbsent(e[0], k -> new ArrayList<>()).add(e[1]);
    adj.computeIfAbsent(e[1], k -> new ArrayList<>()).add(e[0]); // undirected
}
```

### LeetCode 133 — Clone Graph
Deep-copy a connected undirected graph. The HashMap serves as both visited set and clone cache (original → clone). DFS: create clone, mark visited before recursing (cycle safety), then clone all neighbours.

```java
class Solution {
    static class Node {
        int val; List<Node> neighbors;
        Node() { val = 0; neighbors = new ArrayList<>(); }
        Node(int v) { val = v; neighbors = new ArrayList<>(); }
    }
    private Map<Node, Node> visited = new HashMap<>();
    public Node cloneGraph(Node node) {
        if (node == null) return null;
        if (visited.containsKey(node)) return visited.get(node);
        Node clone = new Node(node.val);
        visited.put(node, clone);  // mark before recursing — breaks cycles
        for (Node nb : node.neighbors) clone.neighbors.add(cloneGraph(nb));
        return clone;
    }
}
```

### LeetCode 207 — Course Schedule
Check if all courses can be finished (no cycle in prerequisites). Build adjacency map + in-degree array, run Kahn's algorithm (BFS topological sort). If all courses are processed, no cycle.

```java
class Solution {
    public boolean canFinish(int n, int[][] prereqs) {
        Map<Integer, List<Integer>> adj = new HashMap<>();
        int[] indeg = new int[n];
        for (int[] p : prereqs) {
            adj.computeIfAbsent(p[1], k -> new ArrayList<>()).add(p[0]);
            indeg[p[0]]++;
        }
        Queue<Integer> q = new LinkedList<>();
        for (int i = 0; i < n; i++) if (indeg[i] == 0) q.offer(i);
        int done = 0;
        while (!q.isEmpty()) {
            int c = q.poll(); done++;
            for (int next : adj.getOrDefault(c, new ArrayList<>()))
                if (--indeg[next] == 0) q.offer(next);
        }
        return done == n;
    }
}
```

---

## Pattern Recognition Table

```
┌──────────────────────────────────────────────┬─────────────────────────────────────────────┬───────────────┐
│ Problem Keyword / Phrase                     │ Pattern to Use                              │ Complexity    │
├──────────────────────────────────────────────┼─────────────────────────────────────────────┼───────────────┤
│ "two sum" / "pair sums to target" (unsorted) │ HashMap complement lookup                   │ O(n)          │
│ "4Sum II" / "count tuples across arrays"     │ HashMap on half + complement on other half  │ O(n²)         │
│ "count occurrences" / "frequency"            │ Frequency Map (HashMap)                     │ O(n)          │
│ "top k frequent"                             │ Frequency Map + Bucket Sort or Min-Heap     │ O(n) / O(n log k)│
│ "first unique character"                     │ Frequency Map + second pass                 │ O(n)          │
│ "group anagrams"                             │ HashMap with sorted/count key               │ O(n·k log k)  │
│ "group by shared property"                   │ HashMap with computed signature key         │ O(n·k)        │
│ "longest consecutive sequence"               │ HashSet + sequence-start detection          │ O(n)          │
│ "subarray sum equals K"                      │ Prefix Sum + HashMap (count of prefix sums) │ O(n)          │
│ "contiguous array / equal 0s and 1s"         │ Prefix Sum (+1/-1) + HashMap (first index)  │ O(n)          │
│ "continuous subarray sum (multiple of k)"    │ Prefix Sum mod k + HashMap (first index)    │ O(n)          │
│ "longest substring without repeating"        │ Sliding Window + HashMap (char → last index)│ O(n)          │
│ "minimum window substring"                   │ Sliding Window + two frequency maps         │ O(|s|+|t|)    │
│ "find all anagrams in string"                │ Fixed sliding window + frequency array/map  │ O(|s|)        │
│ "contains nearby almost duplicate"           │ Sliding Window + TreeSet (floor/ceiling)    │ O(n log k)    │
│ "memoization" / "overlapping subproblems"    │ HashMap cache keyed by subproblem identity  │ varies        │
│ "design HashMap" / "implement hash table"    │ Bucket array + separate chaining            │ O(1) avg      │
│ "hand of straights / consecutive groups"     │ TreeMap (sorted counts, firstKey)           │ O(n log n)    │
│ "nearest value / predecessor / successor"    │ TreeMap (floor/ceiling/higher/lower)        │ O(log n)      │
│ "range query on keys"                        │ TreeMap (subMap/headMap/tailMap)            │ O(log n + k)  │
│ "h-index / sort by count"                    │ Counting Sort (array or HashMap)            │ O(n)          │
│ "clone graph / copy graph"                   │ HashMap (original → clone, visited + cache)│ O(V + E)      │
│ "course schedule / topological sort"         │ HashMap adjacency + in-degree BFS (Kahn's)  │ O(V + E)      │
│ "build graph from edges"                     │ HashMap adjacency (computeIfAbsent)         │ O(E)          │
│ "find duplicate / missing number"            │ HashSet membership or frequency map         │ O(n)          │
│ "intersection / union of arrays"             │ HashSet membership                          │ O(n + m)      │
└──────────────────────────────────────────────┴─────────────────────────────────────────────┴───────────────┘
```

---

## Quick Reference — When to Reach for Each Pattern

- **Frequency Map:** "How many times does X appear" or "are there duplicates." Build `HashMap<Element, Integer>`, query.
- **Two-Sum Complement:** "Find a pair satisfying a relation" in an unsorted collection. Store seen elements, look up complement. O(n²) → O(n).
- **Grouping by Computed Key:** "Group elements sharing a property." Compute a signature, use as HashMap key, collect with `computeIfAbsent`.
- **Prefix Sum + HashMap:** "Count/length of subarrays with given sum or modular condition." Track prefix sums in a map, look up `current - target`. Seed with `{0: 1}` or `{0: -1}`.
- **Sliding Window + HashMap:** "Longest/shortest substring with frequency constraint." Expand right, shrink left when violated, track window in a map.
- **Memoization:** Recursive overlapping subproblems. Cache results in a HashMap keyed by subproblem identity.
- **Design HashMap:** Implement from scratch. Bucket array + separate chaining + resizing. Mask hash codes to avoid negative indices.
- **TreeMap:** Nearest key, predecessor/successor, range queries. `ceilingKey`, `floorKey`, `subMap`. O(log n) per op.
- **Counting Sort with HashMap:** Sort/count by value with large range or non-integer values. TreeMap or HashMap + sorted keys.
- **Graph Adjacency:** Build graph from edges. `HashMap<Node, List<Neighbour>>` with `computeIfAbsent`. Doubles as visited set or clone cache.

Three bugs cause most hash-table solution failures: (1) forgetting the seed entry — missing subarrays starting at index 0 in prefix-sum problems; (2) forgetting to remove elements from the map when the sliding window's left pointer advances — causing false duplicate detections; (3) using `==` to compare boxed `Integer` values above 127 — Java caches only -128 to 127, so use `.equals()` or `.intValue()`. Drill these until automatic.

LeetCode problems referenced: #1 Two Sum, #3 Longest Substring Without Repeating Characters, #49 Group Anagrams, #76 Minimum Window Substring, #128 Longest Consecutive Sequence, #133 Clone Graph, #198 House Robber, #207 Course Schedule, #220 Contains Duplicate III, #274 H-Index, #347 Top K Frequent Elements, #387 First Unique Character, #438 Find All Anagrams, #454 4Sum II, #523 Continuous Subarray Sum, #525 Contiguous Array, #560 Subarray Sum Equals K, #706 Design HashMap, #846 Hand of Straights. Work through them in order — each builds on the previous pattern.

## Interview Cheat Sheet

**Key Points to Remember:**
- O(1) average insert/lookup/delete. Use for: counting, grouping, deduplication, complement lookup (two-sum).
- Java: HashMap (unordered), TreeMap (sorted, O(log n)), LinkedHashMap (insertion order).
- Load factor: when entries/buckets > 0.75, resize (double buckets, rehash).
- Collision: chaining (linked list per bucket) or open addressing (probe for next slot).

**Common Follow-Up Questions:**
- "HashMap vs TreeMap — when to use which?" — HashMap for O(1) lookups. TreeMap when you need ordered keys, range queries, or ceiling/floor operations.
- "What happens during rehashing?" — All entries are redistributed to new buckets. This is O(n) but amortized O(1) per operation. Concurrent rehashing can cause issues (Java 8+ uses treeified buckets for long chains).

**Gotcha:**
- Using a hash map when the key space is small and known. If keys are integers 0-N, use a plain array — it's faster (no hashing) and uses less memory (no Entry objects).
