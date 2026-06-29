---
title: "Intervals — Interview Prep"
topic: "Coding Interview Prep"
category: "Data Structures & Algorithms"
tags: [intervals, sweep-line, merge-intervals, meeting-rooms, java, interview, greedy, sorting]
difficulty: "medium-to-hard"
last-reviewed: "2026-06-19"
---

# Intervals

Interval problems are about reasoning over ranges — start and end points on a line — and deciding how they overlap, merge, conflict, or leave gaps. They look deceptively simple, but the clean solutions all depend on the same opening move: **sort by start time**. Once sorted, almost every interval question reduces to a single left-to-right sweep comparing the current interval against the last one you kept.

This article covers interval fundamentals, the sweep-line technique, ten fully-worked Java solutions with complexity analysis, and a pattern-recognition table to classify any new interval problem in seconds.

---

## Summary & Interview Framing

Problems involving ranges with start/end points, almost always solved by sorting by start time and sweeping left to right.

**How it's asked:** "Merge intervals, insert interval, meeting rooms, meeting rooms II, interval list intersections — 'given a set of ranges, determine overlaps/conflicts/merges.'"

---

## 1. Interval Representation and Sorting

An interval is a pair `[start, end]` representing a half-open or closed range. LeetCode conventionally treats intervals as closed `[start, end]` inclusive on both ends. In Java they arrive as `int[][] intervals` where each row is `{start, end}`.

```
Interval:  [1, 3]
Meaning:   covers every point from 1 to 3 inclusive

Number line:
          1---2---3
          [=======]      <- the interval
   ... 0   1   2   3   4 ...
```

### 1.1 The two sort orders

Almost every solution begins by sorting. The two useful orderings are:

- **Sort by start, then end** — the default. Used for merging, detecting overlaps, greedy removal, inserting.
- **Sort by end** — used when you want the earliest-finishing interval (greedy interval scheduling: maximum non-overlapping set, activity selection).

```java
// Sort by start ascending, ties broken by end ascending
Arrays.sort(intervals, (a, b) -> a[0] != b[0]
        ? Integer.compare(a[0], b[0])
        : Integer.compare(a[1], b[1]));

// Sort by end ascending (activity selection)
Arrays.sort(intervals, (a, b) -> Integer.compare(a[1], b[1]));
```

Use `Integer.compare` instead of `a[0] - b[0]` to avoid integer overflow on large negative values.

### 1.2 The three overlap relationships

Given two sorted intervals `A = [a0, a1]` and `B = [b0, b1]` with `a0 <= b0`:

```
Case 1: OVERLAP       A: [1, 5]  B: [3, 7]   -> b0 <= a1
   1==2==3==4==5==6==7
   [========]
      [========]

Case 2: TOUCHING      A: [1, 4]  B: [4, 7]   -> b0 == a1
   1==2==3==4==5==6==7
   [======]
           [======]

Case 3: DISJOINT      A: [1, 3]  B: [5, 7]   -> b0 > a1
   1==2==3==4==5==6==7
   [===]
            [===]
```

The overlap test (closed intervals): `boolean overlaps = b0 <= a1;`
For half-open `[start, end)`: `boolean overlaps = b0 < a1;`

### 1.3 Merging two overlapping intervals

When `A` and `B` overlap, their union spans both. Since `a0 <= b0` (sorted), the merged start is always `a0`; you only extend the end:

```
A: [1, 5]   B: [3, 8]   ->   merged: [1, max(5,8)] = [1, 8]
   1==2==3==4==5==6==7==8
   [========]
      [========]
   [================]
```

---

## 2. The Sweep-Line Technique

Some interval problems are not about the intervals themselves but about **how many are active at each moment**. The sweep-line (line sweep) technique handles this:

1. Decompose every interval `[start, end]` into two **events**: a `+1` at start, a `-1` at end.
2. Sort events by time. At a tie, process `-1` (end) before `+1` (start) so that a meeting ending at time t frees a room before one starting at t grabs it.
3. Walk the events left to right, maintaining a running count. The answer is a function of that count (its maximum, whether it exceeds a threshold, etc.).

```
Intervals: [0,30], [5,10], [15,20]

Events (sorted, end before start on ties):
   time 0: +1 (count=1)
   time 5: +1 (count=2)  <- peak: 2 rooms
   time 10: -1 (count=1)
   time 15: +1 (count=2)  <- peak
   time 20: -1 (count=1)
   time 30: -1 (count=0)

Count over time:
   2 |      * *          * *
   1 |    *       *    *       *
   0 |____________________________
      0   5  10  15  20  30
```

Sweep-line is the conceptual parent of the two-pointer / min-heap solutions for Meeting Rooms II. It generalizes to "maximum number of overlapping intervals at any point," "find all peak concurrency windows," and "when is the system idle."

---

## 3. Merge Intervals (LeetCode 56)

Given an array of intervals, merge all overlapping intervals and return the non-overlapping set covering the same ranges.

```
Input:  [[1,3],[2,6],[8,10],[15,18]]
        1==2==3==4==5==6  8==9==10  15==16==17==18
        [====]
          [======]          [===]    [====]

After merge: [[1,6],[8,10],[15,18]]
        1========6  8==10  15====18
        [=========] [===]  [======]
```

### Approach

1. Sort by start.
2. Initialize `merged` with the first interval.
3. For each subsequent interval, compare its start to the last merged interval's end.
   - If `start <= lastEnd`: overlap — extend `lastEnd = max(lastEnd, currentEnd)`.
   - Else: disjoint — append the current interval as a new entry.

### Merge flow diagram

```
sorted: [1,3] [2,6] [8,10] [15,18]

Step 1: merged = [[1,3]]

Step 2: curr=[2,6], last=[1,3]
        2 <= 3?  YES -> overlap, extend end
        last = [1, max(3,6)] = [1,6]
        merged = [[1,6]]

Step 3: curr=[8,10], last=[1,6]
        8 <= 6?  NO  -> disjoint, append
        merged = [[1,6],[8,10]]

Step 4: curr=[15,18], last=[8,10]
        15 <= 10? NO  -> disjoint, append
        merged = [[1,6],[8,10],[15,18]]
```

### Java solution

```java
class Solution {
    public int[][] merge(int[][] intervals) {
        if (intervals.length <= 1) return intervals;

        // Sort by start time
        Arrays.sort(intervals, (a, b) -> Integer.compare(a[0], b[0]));

        List<int[]> merged = new ArrayList<>();
        merged.add(intervals[0]);

        for (int i = 1; i < intervals.length; i++) {
            int[] last = merged.get(merged.size() - 1);
            int[] curr = intervals[i];

            if (curr[0] <= last[1]) {
                // Overlapping: extend the end
                last[1] = Math.max(last[1], curr[1]);
            } else {
                // Disjoint: start a new merged interval
                merged.add(curr);
            }
        }

        return merged.toArray(new int[merged.size()][]);
    }
}
```

### Complexity

- Time: O(n log n) for sorting + O(n) sweep = O(n log n).
- Space: O(n) for the output list (or O(log n) sort stack if you exclude output).

### Notes

- Sorting by start alone is sufficient; you do not need the end tiebreaker for correctness. If two intervals share a start, `max(end)` handles it.

---

## 4. Insert Interval (LeetCode 57)

You are given a set of non-overlapping intervals sorted by start, plus one new interval. Insert it, merging as needed.

```
Input:  intervals = [[1,2],[3,5],[6,7],[8,10],[12,16]], newInterval = [4,8]

        1=2  3==5  6=7  8==10     12====16
        [=]  [==]  [=]  [===]     [====]
                ^^^^^^^^^^^^^
                new [4,8] overlaps [3,5],[6,7],[8,10]

Result: [[1,2],[3,10],[12,16]]
        [=]  [======]  [====]
```

### Approach (three-phase linear scan)

Because the input is already sorted, we avoid a full re-sort. Walk left to right in three phases:

1. **Add all intervals ending before `newInterval` starts** — no overlap, copy as-is.
2. **Merge all overlapping intervals** — any interval whose `start <= newEnd`. Update `newInterval` to the union. Stop at the first disjoint interval.
3. **Add the merged `newInterval`, then the rest** — copy remaining intervals.

```
intervals: [1,2] [3,5] [6,7] [8,10] [12,16], new: [4,8]

Phase 1: [1,2] ends 2 < 4 -> add. [3,5] ends 5 >= 4 -> STOP.
Phase 2: [3,5] overlaps -> new=[3,8]. [6,7] overlaps -> new=[3,8].
         [8,10] overlaps -> new=[3,10]. [12,16] disjoint (12>10) -> STOP.
Phase 3: add [3,10], add [12,16].
Result: [[1,2],[3,10],[12,16]]
```

### Java solution

```java
class Solution {
    public int[][] insert(int[][] intervals, int[] newInterval) {
        List<int[]> result = new ArrayList<>();
        int i = 0;
        int n = intervals.length;

        // Phase 1: add all intervals that end before newInterval starts
        while (i < n && intervals[i][1] < newInterval[0]) {
            result.add(intervals[i]);
            i++;
        }

        // Phase 2: merge all overlapping intervals into newInterval
        while (i < n && intervals[i][0] <= newInterval[1]) {
            newInterval[0] = Math.min(newInterval[0], intervals[i][0]);
            newInterval[1] = Math.max(newInterval[1], intervals[i][1]);
            i++;
        }
        result.add(newInterval);

        // Phase 3: add the remaining intervals
        while (i < n) {
            result.add(intervals[i]);
            i++;
        }

        return result.toArray(new int[result.size()][]);
    }
}
```

### Complexity

- Time: O(n) — single pass, input already sorted.
- Space: O(n) for output.

### Notes

- The overlap condition in phase 2 is the symmetric overlap test: `a0 <= b1 && b0 <= a1`. We already skipped everything ending before `newInterval[0]`, so checking `intervals[i][0] <= newInterval[1]` suffices.
- If the input were not sorted, you'd append `newInterval`, sort, then run Merge Intervals — O(n log n). The three-phase scan exploits the sorted invariant for O(n).

---

## 5. Meeting Rooms I (LeetCode 252)

Given meeting intervals `[start, end)`, determine whether a person could attend **all** meetings (i.e., no two overlap).

```
Input:  [[0,30],[5,10],[15,20]]

        0======30
           5=10     15=20        -> overlaps -> CANNOT attend all

Input:  [[7,10],[2,4]]

        2=4    7==10             -> no overlap -> CAN attend all
```

### Approach

1. Sort by start.
2. Check each consecutive pair: if the next meeting starts before the previous ends, return false.

This is the simplest possible overlap check — you only need adjacent comparisons because sorting guarantees that if any overlap exists, it shows up between neighbors.

```
Sorted: [0,30] [5,10] [15,20]

Check 1: [0,30] vs [5,10]   5 < 30?  YES -> overlap -> false
```

### Java solution

```java
class Solution {
    public boolean canAttendMeetings(int[][] intervals) {
        if (intervals.length <= 1) return true;

        // Sort by start time
        Arrays.sort(intervals, (a, b) -> Integer.compare(a[0], b[0]));

        for (int i = 1; i < intervals.length; i++) {
            // Half-open: overlap if next starts before prev ends
            if (intervals[i][0] < intervals[i - 1][1]) {
                return false;
            }
        }
        return true;
    }
}
```

### Complexity

- Time: O(n log n).
- Space: O(log n) for sort (or O(1) if in-place sort excluded).

### Notes

- This problem uses **half-open** intervals `[start, end)`, so `[2,4]` and `[4,6]` do NOT conflict. Use strict `<`, not `<=`.

---

## 6. Meeting Rooms II (LeetCode 253)

Given meeting intervals `[start, end)`, find the **minimum number of conference rooms** required so no two meetings share a room.

```
Input:  [[0,30],[5,10],[15,20]]

        0======30
           5=10        <- needs room 2
              15=20    <- reuses room 2 (10 frees before 15)

Peak concurrency = 2 -> answer: 2 rooms

Timeline (rooms occupied):
   Room 1: [0,30]          ##############################
   Room 2:       [5,10][15,20]   #####  #####
```

This is the canonical "maximum number of overlapping intervals at any point" problem.

### Approach A: Min-heap of end times (chronological)

1. Sort by start.
2. Maintain a min-heap of **end times** of meetings currently occupying rooms.
3. For each meeting: if the earliest-ending meeting has finished (`heap.peek() <= start`), reuse that room (poll it). Push the current meeting's end.
4. The heap size at the end is the number of rooms.

The heap always contains exactly the meetings that are "still going" when the current meeting starts. Its size is the concurrency count; its maximum size over the loop is the answer. Since we only ever need the final max and the heap never shrinks below the peak in a greedy reuse, the final heap size equals the peak.

```
Sorted: [0,30] [5,10] [15,20]

[0,30]: heap empty -> push 30.          heap={30}      size=1
[5,10]: peek=30, 30<=5? NO -> push 10.  heap={10,30}   size=2  <- peak
[15,20]: peek=10, 10<=15? YES -> poll, push 20.        heap={20,30}  size=2

Answer = 2
```

### Approach B: Sweep-line (events)

Decompose into events, sort, and track the running count. This generalizes better.

```
Events (end before start on ties):
   (0,+1) (5,+1) (10,-1) (15,+1) (20,-1) (30,-1)

   count: 1 -> 2(max) -> 1 -> 2(max) -> 1 -> 0
   Answer = max(count) = 2
```

### Java solution (min-heap)

```java
class Solution {
    public int minMeetingRooms(int[][] intervals) {
        if (intervals.length == 0) return 0;

        // Sort by start time
        Arrays.sort(intervals, (a, b) -> Integer.compare(a[0], b[0]));

        // Min-heap of end times (rooms currently in use)
        PriorityQueue<Integer> rooms = new PriorityQueue<>();

        for (int[] interval : intervals) {
            int start = interval[0];
            int end = interval[1];

            // If the earliest-finishing room is free, reuse it
            if (!rooms.isEmpty() && rooms.peek() <= start) {
                rooms.poll();
            }
            rooms.offer(end);
        }

        return rooms.size();
    }
}
```

### Java solution (sweep-line, chronological separation)

```java
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
                // A meeting starts before the next one ends -> need a room
                rooms++;
                s++;
                maxRooms = Math.max(maxRooms, rooms);
            } else {
                // A meeting ended -> free a room
                rooms--;
                e++;
            }
        }
        return maxRooms;
    }
}
```

The two-array approach mirrors the event sweep without explicit event objects: `starts[s] < ends[e]` means "a new meeting begins before the in-progress one ends" → increment; otherwise a meeting ended → decrement and advance the end pointer.

### Complexity (both approaches)

- Time: O(n log n) — sorting dominates.
- Space: O(n) for the heap or the two arrays.

### Notes

- The tie-breaking rule (end before start, i.e., `<=` in the heap check, `<` in the two-pointer check) is what makes a meeting ending at t free its room for one starting at t. Get this wrong and you over-count rooms.
- This maps directly onto "minimum platforms for trains," "maximum concurrent streams," and "car pooling capacity."

---

## 7. Non-overlapping Intervals (LeetCode 435)

Given intervals, find the **minimum number to remove** so the rest are non-overlapping. This is the complement of "maximum number of non-overlapping intervals you can keep" — the classic **activity selection / interval scheduling** problem.

```
Input:  [[1,2],[2,3],[3,4],[1,3]]

        1=2  2=3  3=4
        [=]  [=]  [=]
        [===]          <- [1,3] overlaps both [1,2] and [2,3]

Remove [1,3] -> 1 removal -> remaining 3 are non-overlapping.
(Or remove [1,2] and [2,3], but that's 2 removals — not minimal.)
```

### Approach (greedy by earliest end)

The greedy choice that maximizes kept intervals: **always keep the interval that ends earliest** — it leaves the most room for future intervals.

1. Sort by end time.
2. Track `end` of the last kept interval.
3. For each interval: if `start >= end`, keep it (update `end`). Otherwise, remove it (increment count).

### Why sort by end, not start?

Consider `[[1,5],[2,3],[4,6]]`: sorting by start picks `[1,5]` first (end=5), which blocks `[2,3]` and `[4,6]` — 2 removals. Sorting by end picks `[2,3]` first (end=3), then `[4,6]` (start 4 >= 3) — only 1 removal. Sorting by start can greedily pick a long interval that blocks many short ones; sorting by end always picks the one that finishes soonest, maximizing remaining capacity.

### Greedy flow

```
sorted by end: [1,2] [2,3] [1,3] [3,4]
end=-inf, removed=0
[1,2]: 1>=end? YES -> keep, end=2
[2,3]: 2>=2?   YES -> keep, end=3
[1,3]: 1>=3?   NO  -> remove, removed=1
[3,4]: 3>=3?   YES -> keep, end=4
Answer: 1 removal
```

### Java solution

```java
class Solution {
    public int eraseOverlapIntervals(int[][] intervals) {
        if (intervals.length <= 1) return 0;

        // Sort by end time (greedy: keep earliest-finishing)
        Arrays.sort(intervals, (a, b) -> Integer.compare(a[1], b[1]));

        int removed = 0;
        int end = intervals[0][1];

        for (int i = 1; i < intervals.length; i++) {
            if (intervals[i][0] >= end) {
                // No overlap: keep this interval, extend end
                end = intervals[i][1];
            } else {
                // Overlap with last kept: remove this one
                removed++;
            }
        }
        return removed;
    }
}
```

### Complexity

- Time: O(n log n).
- Space: O(log n) for sort.

### Notes

- For half-open intervals, use `>` instead of `>=` in the overlap check. LeetCode 435 uses closed intervals, so `start >= end` means non-overlapping (touching is allowed).
- The problem is equivalent to finding the **maximum independent set in an interval graph**, which is polynomial precisely because the greedy-by-end strategy is optimal.

---

## 8. Interval List Intersections (LeetCode 986)

Given two lists of **closed, disjoint, sorted** intervals, return their intersection.

```
Input:  A = [[0,2],[5,10],[13,23],[24,25]]
        B = [[1,5],[8,12],[15,24],[25,26]]

        A: [0=2]    [5====10] [13========23] [24]
        B:  [1==5]     [8=12]    [15======24]  [25]
Output: [[1,2],[5,5],[8,10],[15,23],[24,24],[25,25]]
```

### Approach (two pointers)

Both lists are sorted and internally disjoint. Walk both with two pointers `i` and `j`:

1. Compute the intersection: `lo = max(a0, b0)`, `hi = min(a1, b1)`. If `lo <= hi`, record it.
2. Advance the pointer of whichever interval **ends first** — it cannot intersect anything further in the other list.

```
Step: A[i]=[0,2], B[j]=[1,5] -> lo=1,hi=2 -> [1,2]; A ends first -> i++
Step: A[i]=[5,10], B[j]=[1,5] -> lo=5,hi=5 -> [5,5]; B ends first -> j++
Step: A[i]=[5,10], B[j]=[8,12] -> lo=8,hi=10 -> [8,10]; A ends first -> i++
...continue until either list is exhausted.
```

### Java solution

```java
class Solution {
    public int[][] intervalIntersection(int[][] firstList, int[][] secondList) {
        List<int[]> result = new ArrayList<>();
        int i = 0, j = 0;

        while (i < firstList.length && j < secondList.length) {
            int[] a = firstList[i];
            int[] b = secondList[j];

            // Intersection of a and b
            int lo = Math.max(a[0], b[0]);
            int hi = Math.min(a[1], b[1]);

            if (lo <= hi) {
                result.add(new int[]{lo, hi});
            }

            // Advance the one that ends first
            if (a[1] < b[1]) {
                i++;
            } else {
                j++;
            }
        }

        return result.toArray(new int[result.size()][]);
    }
}
```

### Complexity

- Time: O(m + n) — each pointer advances at most its list length.
- Space: O(m + n) for output in the worst case.

### Notes

- The advance rule (`a[1] < b[1] ? i++ : j++`) is the key: the interval that ends earlier cannot intersect anything further in the other list, so it is done.
- This is essentially the merge step of merge-sort, adapted to compute `max(start)` / `min(end)`.

---

## 9. Employee Free Time (LeetCode 759)

Given multiple employees' schedules (each a list of disjoint busy intervals, all sorted), find the **common free time** — intervals where every employee is free. Return only free time strictly between the overall earliest and latest busy points.

```
Input:  [[[1,2],[5,6]], [[1,3]], [[4,10]]]  (3 employees)

Flattened & sorted: [1,2] [1,3] [4,10] [5,6]
Merged busy:        [1,3] [4,10]
Free gaps:          [3,4]  (between merged intervals)

Output: [[3,4]]
```

### Approach

1. **Flatten** all employees' intervals into one list.
2. **Merge** them (Merge Intervals pattern) to get the union of all busy time.
3. The **gaps between consecutive merged intervals** are the common free time — a time is commonly free iff no employee is busy there.

```
Flattened: [1,2] [5,6] [1,3] [4,10]
Sorted:    [1,2] [1,3] [4,10] [5,6]
Merged:    [1,3] [4,10]

Gaps:
  between [1,3] and [4,10] -> [3,4]  (free!)
  before [1,3]  -> excluded (before earliest)
  after  [4,10] -> excluded (after latest)

Output: [[3,4]]
```

### Java solution

```java
/*
// Definition for Interval.
class Interval {
    public int start;
    public int end;
    public Interval() {}
    public Interval(int _start, int _end) {
        start = _start;
        end = _end;
    }
}
*/
class Solution {
    public List<Interval> employeeFreeTime(List<List<Interval>> schedule) {
        List<Interval> all = new ArrayList<>();
        for (List<Interval> emp : schedule) {
            all.addAll(emp);
        }

        // Sort by start
        all.sort((a, b) -> Integer.compare(a.start, b.start));

        // Merge
        List<Interval> merged = new ArrayList<>();
        for (Interval iv : all) {
            if (merged.isEmpty() || iv.start > merged.get(merged.size() - 1).end) {
                merged.add(iv);
            } else {
                merged.get(merged.size() - 1).end =
                    Math.max(merged.get(merged.size() - 1).end, iv.end);
            }
        }

        // Gaps between merged intervals are free time
        List<Interval> free = new ArrayList<>();
        for (int i = 1; i < merged.size(); i++) {
            int gapStart = merged.get(i - 1).end;
            int gapEnd = merged.get(i).start;
            if (gapStart < gapEnd) {
                free.add(new Interval(gapStart, gapEnd));
            }
        }
        return free;
    }
}
```

### Complexity

- Time: O(C log C) where C is total number of intervals across all employees.
- Space: O(C) for the flattened and merged lists.

### Notes

- The problem uses a custom `Interval` class (not `int[]`) on LeetCode — adjust to the platform's signature.
- Free time outside the global busy range is excluded by construction — the gap loop only runs between merged intervals.
- A priority-heap variant avoids the full sort: merge k sorted lists with a min-heap, merging as you pop. Same complexity class, but lower constant if one employee has huge data.
- This is the dual of Meeting Rooms II: instead of peak concurrency, you want peak **idle** time (gaps where concurrency is 0).

---

## 10. Partition Labels (LeetCode 763)

A string `S` of lowercase letters. Partition it into as many pieces as possible so each letter appears in at most one piece. Return the sizes.

```
Input:  "ababcbacadefegdehijhklij"

  a b a b c b a c a d e f e g d e h i j h k l i j
  |---------------| |-----------| |-------------|
        part 1          part 2        part 3
  sizes: 9              7              8

Output: [9,7,8]
```

### Approach (interval fusion)

Treat each letter's first-to-last occurrence as an interval. Partition boundaries are the points where all intervals that started have closed.

1. Record `last[char]` — the last index of each character.
2. Scan left to right, maintaining `end` = the furthest last-occurrence among characters seen so far.
3. When the scan index reaches `end`, all characters in the current segment are complete — cut here.

```
"ababcbaca | defegde | hijhklij"
  'a' last=8, 'b' last=5, 'c' last=7 -> end=8, cut at i=8 (size 9)
  'd' last=14, 'e' last=15, 'f' last=9, 'g' last=13 -> end=15, cut at i=15 (size 7)
  'h' last=19, 'i' last=22, 'j' last=23, 'k' last=20, 'l' last=21 -> end=23, cut (size 8)
```

### Java solution

```java
class Solution {
    public List<Integer> partitionLabels(String s) {
        int[] last = new int[26];
        for (int i = 0; i < s.length(); i++) {
            last[s.charAt(i) - 'a'] = i;
        }

        List<Integer> result = new ArrayList<>();
        int start = 0;
        int end = 0;

        for (int i = 0; i < s.length(); i++) {
            end = Math.max(end, last[s.charAt(i) - 'a']);
            if (i == end) {
                result.add(i - start + 1);
                start = i + 1;
            }
        }
        return result;
    }
}
```

### Complexity

- Time: O(n) — two passes.
- Space: O(1) — the `last` array is fixed size 26.

### Notes

- This is an interval problem in disguise: each character defines an interval `[first, last]`, and the algorithm greedily merges overlapping intervals, emitting a partition whenever the merged interval closes.
- The "extend end to max last-occurrence" trick appears in "jump game" and "video stitching."

---

## 11. Data Stream as Disjoint Intervals (LeetCode 352 — Summary Ranges)

Design a structure that supports `addNum(val)` and `getIntervals()` returning the current numbers as a list of disjoint sorted ranges.

```
addNum(1) -> [[1,1]]      addNum(7) -> [[1,1],[3,3],[7,7]]
addNum(3) -> [[1,1],[3,3]]  addNum(2) -> [[1,3],[7,7]]  (2 bridges 1 and 3)
addNum(6) -> [[1,3],[6,7]]  (6 extends into 7's range)
getIntervals() -> [[1,3],[6,7]]
```

### Approach

Maintain a sorted set of disjoint intervals keyed by start (a `TreeMap<Integer, int[]>` mapping `start -> [start, end]` gives O(log n) floor/ceiling lookups). On each insertion:

1. Find where `val` belongs via `lowerKey`/`higherKey`. Skip if already covered.
2. If `val` bridges left and right (`left.end == val-1` and `right.start == val+1`): merge both into one.
3. Else if `val` extends left (`left.end == val-1`): extend it.
4. Else if `val` extends right (`right.start == val+1`): shift its start left.
5. Else: insert a new singleton `[val, val]`.

### Java solution

```java
class SummaryRanges {
    // start -> [start, end]
    private TreeMap<Integer, int[]> intervals;

    public SummaryRanges() {
        intervals = new TreeMap<>();
    }

    public void addNum(int val) {
        // Already covered?
        if (intervals.containsKey(val)) return;

        Integer lower = intervals.lowerKey(val);   // largest start < val
        Integer higher = intervals.higherKey(val);  // smallest start > val

        // Bridges two intervals?
        if (lower != null && higher != null
                && intervals.get(lower)[1] + 1 == val
                && higher == val + 1) {
            // Merge: extend lower's end to higher's end, remove higher
            intervals.get(lower)[1] = intervals.get(higher)[1];
            intervals.remove(higher);
        }
        // Extends the lower interval?
        else if (lower != null && intervals.get(lower)[1] + 1 == val) {
            intervals.get(lower)[1] = val;
        }
        // Extends the higher interval?
        else if (higher != null && higher == val + 1) {
            int[] r = intervals.remove(higher);
            r[0] = val;
            intervals.put(val, r);
        }
        // Standalone new interval
        else {
            intervals.put(val, new int[]{val, val});
        }
    }

    public int[][] getIntervals() {
        return intervals.values().toArray(new int[intervals.size()][]);
    }
}
```

### Complexity

- `addNum`: O(log n) for TreeMap lookups.
- `getIntervals`: O(k) where k is the number of disjoint ranges.

### Notes

- The "bridge" case is the only one that reduces the interval count by one; the "extend" cases keep the count; the "new" case increases it.
- This is the dynamic/incremental cousin of Merge Intervals — instead of a batch sort+merge, you maintain the invariant on every insert.

---

## 12. The Telescope Problem

A common interval variant (sometimes called "points covering intervals" or "minimum points to cover all intervals"): given a set of intervals, find the **minimum number of points** such that every interval contains at least one point.

```
Intervals: [1,3], [2,5], [3,6], [4,7]

  [1==3]
     [2====5]
        [3====6]
           [4===7]
  Point at 3 covers [1,3],[2,5],[3,6]; [4,7] uncovered.
  Point at 4 (or 5) covers [4,7].
  Answer: 2 points (e.g., at 3 and at 5).

Greedy: sort by end. Place a point at the end of the first interval.
Skip all intervals containing that point. Repeat.
```

### Approach (greedy by earliest end)

1. Sort by end.
2. Place a point at the first interval's end.
3. Skip all intervals whose `start <= point` (covered). When you hit one with `start > point`, place a new point at its end, repeat.

This is the same greedy skeleton as Non-overlapping Intervals, but instead of removing the overlapping interval, you place a covering point.

### Java solution

```java
class Solution {
    public int findMinArrowShots(int[][] points) {
        if (points.length == 0) return 0;

        // Sort by end (greedy: shoot at the earliest end)
        Arrays.sort(points, (a, b) -> Integer.compare(a[1], b[1]));

        int arrows = 1;
        int arrowPos = points[0][1];

        for (int i = 1; i < points.length; i++) {
            // If this balloon starts after the last arrow, need a new arrow
            if (points[i][0] > arrowPos) {
                arrows++;
                arrowPos = points[i][1];
            }
            // else: this interval contains arrowPos -> already covered
        }
        return arrows;
    }
}
```

This is exactly LeetCode 452 "Minimum Number of Arrows to Burst Balloons," the standard framing of the telescope/covering-points problem.

### Complexity

- Time: O(n log n).
- Space: O(log n) for sort.

### Notes

- The greedy is optimal by the standard exchange argument: any solution can be transformed into one that places its first point at the earliest end without increasing the count.
- The structure is identical to activity selection: "earliest end" is the universal greedy anchor for interval problems where you minimize the number of selected anchors.

---

## 13. Comparison Table: Interval Patterns

| Problem | Sort Key | Core Operation | Data Structure | Time | Key Insight |
|---|---|---|---|---|---|
| Merge Intervals (56) | start | Extend end on overlap | List | O(n log n) | Sort by start, merge greedily |
| Insert Interval (57) | (pre-sorted) | Three-phase scan | List | O(n) | Exploit sorted input; merge in place |
| Meeting Rooms I (252) | start | Adjacent overlap check | Array | O(n log n) | Sorted => only neighbors can overlap |
| Meeting Rooms II (253) | start | Track running concurrency | Min-heap / 2 arrays | O(n log n) | Max overlapping = min rooms; heap of end times |
| Non-overlapping (435) | end | Greedy keep earliest-ending | Array | O(n log n) | Activity selection: sort by END not start |
| Interval Intersections (986) | (pre-sorted) | Two-pointer max/min | Two pointers | O(m+n) | lo=max(start), hi=min(end); advance earlier-ending |
| Employee Free Time (759) | start | Merge all, find gaps | List / Heap | O(C log C) | Gaps in merged union = common free time |
| Partition Labels (763) | (implicit) | Extend end to max last | Array[26] | O(n) | Char interval = [first,last]; cut when merged closes |
| Summary Ranges (352) | (TreeMap) | Insert + bridge/extend | TreeMap | O(log n) per op | Maintain disjoint invariant on each insert |
| Telescope / Arrows (452) | end | Place point at earliest end | Array | O(n log n) | Covering points = dual of activity selection |

---

## 14. Common Pitfalls

- **Wrong sort key.** Sorting by start when the greedy needs earliest-end (Non-overlapping Intervals, Arrows) is the single most common bug. Know which problem wants which.
- **Tie-breaking at equal times.** For sweep-line / Meeting Rooms II, an end event must be processed before a start event at the same timestamp, or you over-count rooms. The `<=` in the heap check and `<` in the two-array check encode this.
- **Closed vs half-open.** LeetCode 56, 57, 435, 986, 759 use closed intervals (`[start,end]`); 252, 253 use half-open (`[start,end)`). The overlap test differs by one character: `<=` vs `<`.
- **Overflow in comparators.** `a[0] - b[0]` can overflow for large negative values. Always use `Integer.compare(a[0], b[0])`.
- **Forgetting the empty / single-interval base case.** Several solutions are trivially correct on size 0/1, but only if you guard explicitly.

---

## 15. Pattern Recognition Table

When you see an interval problem, classify it by what it asks for:

| If the problem asks... | Pattern | Sort by | Algorithm skeleton |
|---|---|---|---|
| Merge overlapping ranges into minimal set | Merge | start | Sort, sweep, extend end on overlap |
| Insert one interval into a sorted set | Insert | (given sorted) | Three-phase: before / merge / after |
| Can a person attend all meetings? | Overlap check | start | Sort, check adjacent pairs |
| Min rooms / min platforms / max concurrency | Sweep-line | start | Min-heap of end times OR two-array event sweep |
| Min removals to make non-overlapping | Activity selection | end | Greedy keep earliest-ending, count the rest |
| Max non-overlapping set you can keep | Activity selection | end | Same as above; answer = n - removals |
| Intersection of two sorted interval lists | Two-pointer | (given sorted) | lo=max(start), hi=min(end), advance earlier end |
| Common free time across people | Merge + gap | start | Merge all busy, emit gaps between merged |
| Min points to cover all intervals | Covering | end | Greedy: place point at earliest end, skip covered |
| Partition so each group is self-contained | Fusion | (implicit) | Extend end to max last-occurrence, cut when closed |
| Dynamic add + report disjoint ranges | Incremental merge | (TreeMap) | Floor/ceiling lookup, bridge or extend or insert |
| Max concurrent at any instant (general) | Sweep-line | event time | +1 at start, -1 at end, track running max |

### Decision shortcut

1. Does it ask for a **merged/union** result? → Merge pattern, sort by start.
2. Does it ask for **minimum resources / maximum overlap**? → Sweep-line or min-heap of ends, sort by start.
3. Does it ask for **minimum removals / maximum kept / minimum covering points**? → Activity selection, sort by end.
4. Does it ask for an **intersection** of two lists? → Two-pointer, no sort needed.
5. Does it ask for **gaps/free time**? → Merge first, then walk gaps.
6. Is the input **dynamic/streaming**? → TreeMap (or balanced BST) for incremental maintenance.

If none of these fit cleanly, default to **sort by start, then sweep left to right** — that single move solves or bootstraps the vast majority of interval problems.

---

## Interview Cheat Sheet

**Key Points to Remember:**

- Sort by start time — the universal first step for almost every interval problem. If you skip this, nothing else works.
- Merge: if current.start <= last.end, merge by updating last.end = max(last.end, current.end). Otherwise append as a new interval.
- Meeting rooms (min concurrency): use a min-heap of end times — push each new meeting's end, and poll the heap if the earliest-ending room is freed before the next meeting starts.
- Insert interval: find the position, then merge with all overlapping intervals in a single left-to-right pass (three-phase: before / merge / after).
- Sweep line: decompose each interval into events (start = +1, end = -1), sort by time (end before start on ties), and track the running count for peak concurrency.

**Common Follow-Up Questions:**

- *How do you find the maximum number of overlapping intervals?* — Sweep line: sort all start and end points together, increment a counter at each start, decrement at each end, and track the maximum value the counter reaches.
- *What if intervals are dynamic (frequent insertions)?* — Use an interval tree or a sorted data structure like a TreeMap (Java) for O(log n) insertions and merges, instead of re-sorting on every update.

**Gotcha:**

Assuming intervals are sorted. ALWAYS sort by start time first — many candidates skip this step and get wrong results. Also watch for edge cases: identical intervals [1,3] vs [1,3], and containment cases where one interval fully contains another [1,4] vs [2,3] — the merge must use max(end), not just the current interval's end.


