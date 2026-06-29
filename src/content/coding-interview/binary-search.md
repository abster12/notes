---
title: "Binary Search — Complete Coding Interview Prep"
date: 2026-06-19
tags: [binary-search, interview-prep, java, algorithms, leetcode]
category: Coding Interview Prep
difficulty: medium-to-hard
estimated_read_time: 45 minutes
---

# Binary Search — Complete Coding Interview Prep

Binary search is deceptively simple — repeatedly halve a sorted search space — but edge cases, variants, and "binary search on answer" make it one of the richest interview topics. This article covers every major pattern with full Java solutions, ASCII diagrams, and pattern tables.

---

## Summary & Interview Framing

An O(log n) search on sorted data that halves the search space each step — including binary search on the answer space for optimization problems.

**How it's asked:** "Find element in sorted array, search insert position, find minimum in rotated sorted array, split array largest sum — 'find X such that condition holds' with a monotonic predicate."

---

## 1. Why Binary Search Matters

Binary search converts an O(n) linear scan into an O(log n) operation by exploiting sorted structure. Beyond the textbook "find a number," interviewers love it because it tests loop invariants and off-by-one reasoning, and the "binary search on answer" pattern appears in problems that don't look like search at all (shipping capacity, eating speed, splitting arrays). If you can write a correct binary search without infinite loops or missed elements, you are ahead of many candidates.

---

## 2. Classic Binary Search (LeetCode 704)

Given a sorted array of integers and a target, return the index of the target if it exists, otherwise return -1.

### The Core Loop

The key invariant: the answer, if it exists, is always in the inclusive range `[lo, hi]`. We pick a midpoint `mid = lo + (hi - lo) / 2` (to avoid integer overflow) and shrink the range by half each step.

### ASCII Diagram — Binary Search Convergence

```
Array:  [-1, 0, 3, 5, 9, 12]   target = 9

Step 1:  lo=0            hi=5
         [-1, 0, 3, 5, 9, 12]
          lo       mid      hi     mid=2, arr[2]=3 < 9  → go right

Step 2:        lo=3       hi=5
         [-1, 0, 3, 5, 9, 12]
                  lo  mid  hi      mid=4, arr[4]=9 == 9 → FOUND at index 4

General convergence (search space halves each step):

  [###########################]  n elements
  [##############]               n/2
  [#######]                      n/4
  [###]                          n/8
  [#]                            1   → log2(n) steps

  Each step: compare arr[mid] with target, discard half.
  Terminates when lo > hi (not found) or arr[mid] == target (found).
```

### Java Solution (704)

```java
class Solution {
    public int search(int[] nums, int target) {
        int lo = 0, hi = nums.length - 1;
        while (lo <= hi) {
            int mid = lo + (hi - lo) / 2;  // overflow-safe
            if (nums[mid] == target) {
                return mid;
            } else if (nums[mid] < target) {
                lo = mid + 1;   // discard left half (mid included)
            } else {
                hi = mid - 1;   // discard right half (mid included)
            }
        }
        return -1;
    }
}
```

**Complexity:** O(log n) time, O(1) space.

**Common pitfalls:**
- **Overflow:** `(lo + hi) / 2` can overflow. Use `lo + (hi - lo) / 2` or `(lo + hi) >>> 1`.
- **Loop condition:** `while (lo <= hi)` ensures the single-element case is checked. Using `<` skips it.
- **Boundary updates:** `lo = mid + 1` and `hi = mid - 1` (not `mid`) prevent infinite loops when mid is not the answer.

---

## 3. Leftmost and Rightmost Binary Search

Sometimes you need the first or last position of a target (e.g., LeetCode 34 — Find First and Last Position). The trick: when you find the target, don't return immediately — keep searching in the direction that might have an earlier/later occurrence.

### Leftmost (First Occurrence)

```java
public int leftmost(int[] nums, int target) {
    int lo = 0, hi = nums.length - 1, result = -1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        if (nums[mid] == target) {
            result = mid;       // record, but keep searching left
            hi = mid - 1;
        } else if (nums[mid] < target) {
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return result;
}
```

### Rightmost (Last Occurrence)

```java
public int rightmost(int[] nums, int target) {
    int lo = 0, hi = nums.length - 1, result = -1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        if (nums[mid] == target) {
            result = mid;       // record, but keep searching right
            lo = mid + 1;
        } else if (nums[mid] < target) {
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return result;
}
```

A half-open template (`while (lo < hi)` with `hi = mid` / `lo = mid + 1`) avoids the separate `result` variable but is trickier. The golden rule: **if you use `hi = mid`, compute mid left-biased (`lo + (hi - lo) / 2`); if you use `lo = mid`, compute mid right-biased (`lo + (hi - lo + 1) / 2`)** to avoid infinite loops.

---

## 4. Search in Rotated Sorted Array (LeetCode 33)

A sorted array is rotated at an unknown pivot. Find a target in O(log n) time.

The key insight: in a rotated sorted array, at least one half of the array (left or right of mid) is always normally sorted. Determine which half is sorted, then decide if the target lies in that sorted half.

### ASCII Diagram — Rotated Array Pivot

```
Original sorted:  [0, 1, 2, 3, 4, 5, 6, 7]
Rotated at pivot=3: [4, 5, 6, 7, 0, 1, 2, 3]

Index:   0  1  2  3  4  5  6  7
Value:   4  5  6  7  0  1  2  3
         └──left half──┘ └─right half─┘
          (sorted)        (sorted)

The "pivot" is the index of the smallest element (index 4).
Key property: arr[pivot-1] > arr[pivot]  (7 > 0).

When we pick mid, one side is ALWAYS sorted:
  arr[lo] <= arr[mid] → left half sorted
  else                → right half sorted

Example: lo=0, hi=7, mid=3 → arr[0]=4 <= arr[3]=7 → left sorted
  If arr[lo] <= target < arr[mid] → search left, else search right.
```

### Java Solution (33)

```java
class Solution {
    public int search(int[] nums, int target) {
        int lo = 0, hi = nums.length - 1;
        while (lo <= hi) {
            int mid = lo + (hi - lo) / 2;
            if (nums[mid] == target) return mid;

            // Left half is sorted
            if (nums[lo] <= nums[mid]) {
                if (nums[lo] <= target && target < nums[mid]) {
                    hi = mid - 1;   // target in sorted left half
                } else {
                    lo = mid + 1;   // target in right half
                }
            }
            // Right half is sorted
            else {
                if (nums[mid] < target && target <= nums[hi]) {
                    lo = mid + 1;   // target in sorted right half
                } else {
                    hi = mid - 1;   // target in left half
                }
            }
        }
        return -1;
    }
}
```

**Complexity:** O(log n) time, O(1) space.

**Key details:**
- `nums[lo] <= nums[mid]` uses `<=` to handle `lo == mid` (single element range). Without `=`, you'd misclassify the left half as unsorted.
- The condition `nums[lo] <= target && target < nums[mid]` checks if target is in the sorted left half. Note the strict `<` on the right boundary since we already checked `nums[mid] == target`.

---

## 5. Find Minimum in Rotated Sorted Array (LeetCode 153)

Find the minimum element in a rotated sorted array with no duplicates, in O(log n).

The minimum is the "pivot" — the only element smaller than its left neighbor. The strategy: compare `nums[mid]` with `nums[hi]`. If `nums[mid] < nums[hi]`, the minimum is in the left half (including mid). If `nums[mid] > nums[hi]`, the minimum is in the right half (excluding mid).

### ASCII Diagram — Finding Minimum

```
Array:  [4, 5, 6, 7, 0, 1, 2, 3]   (rotated, min = 0 at index 4)

Step 1: lo=0, hi=7, mid=3 → arr[3]=7 > arr[hi]=3 → min in RIGHT → lo=4
Step 2: lo=4, hi=7, mid=5 → arr[5]=1 < arr[hi]=3 → min in LEFT (incl mid) → hi=5
Step 3: lo=4, hi=5, mid=4 → arr[4]=0 < arr[hi]=1 → min in LEFT → hi=4
Step 4: lo==hi==4 → arr[4]=0 is the minimum

  Compare mid with hi (not lo):
    arr[mid] < arr[hi]  →  min in [lo, mid]   →  hi = mid
    arr[mid] > arr[hi]  →  min in [mid+1, hi] →  lo = mid + 1
```

### Java Solution (153)

```java
class Solution {
    public int findMin(int[] nums) {
        int lo = 0, hi = nums.length - 1;
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;
            if (nums[mid] < nums[hi]) {
                hi = mid;       // min is in [lo, mid]
            } else {
                lo = mid + 1;   // min is in [mid+1, hi]
            }
        }
        return nums[lo];  // lo == hi, pointing at minimum
    }
}
```

**Complexity:** O(log n) time, O(1) space.

Comparing with `nums[hi]` (not `nums[lo]`) works in both rotated and non-rotated cases — comparing with `nums[lo]` fails when the array is fully sorted. For the version **with duplicates** (LeetCode 154), when `nums[mid] == nums[hi]` and you can't decide, decrement `hi` (`hi--`) for a worst-case O(n) solution.

---

## 6. Search a 2D Matrix (LeetCode 74)

Write an efficient algorithm to search a value in an m x n matrix where:
- Each row is sorted left to right.
- The first integer of each row is greater than the last integer of the previous row.

This means the entire matrix can be treated as a single sorted array of length `m * n`. Map a 1D index to 2D coordinates: `row = index / n`, `col = index % n`.

### ASCII Diagram — 2D Matrix as 1D Sorted Array

```
Matrix:
  [ 1,  3,  5,  7]
  [10, 11, 16, 20]
  [23, 30, 34, 60]

Treated as 1D sorted array (m=3 rows, n=4 cols):

  Index:  0  1  2  3   4  5  6  7   8   9  10  11
  Value:  1  3  5  7  10 11 16 20  23  30  34  60
          └── row 0 ──┘ └── row 1 ──┘ └── row 2 ──┘

  1D index → 2D:  row = index / n   col = index % n
  Example: index=6 → row=6/4=1, col=6%4=2 → matrix[1][2]=16

  Binary search over indices [0, m*n - 1]:
    lo=0, hi=11, mid=5 → matrix[1][1]=11
    Compare with target, shrink range as in classic binary search.
```

### Java Solution (74)

```java
class Solution {
    public boolean searchMatrix(int[][] matrix, int target) {
        int m = matrix.length, n = matrix[0].length;
        int lo = 0, hi = m * n - 1;
        while (lo <= hi) {
            int mid = lo + (hi - lo) / 2;
            int row = mid / n;
            int col = mid % n;
            int value = matrix[row][col];
            if (value == target) {
                return true;
            } else if (value < target) {
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return false;
    }
}
```

**Complexity:** O(log(m * n)) time, O(1) space.

**Note on LeetCode 240:** If rows and columns are independently sorted (but row-start > prev-row-end doesn't hold), you cannot flatten to 1D. Start from the **top-right corner** and eliminate one row or column per step: if `matrix[r][c] > target`, move left; if `< target`, move down. This is O(m + n).

---

## 7. Binary Search on Answer

This is the pattern that catches candidates off guard. Many optimization problems have a monotonic property that lets you binary search over the answer space rather than the input array.

### The Pattern

1. Identify a monotonic predicate `can(x)` — as `x` increases, `can(x)` goes from false to true and never goes back.
2. Binary search over the range of possible answers `[lo, hi]`, evaluating `can(mid)` at each step.
3. The smallest (or largest) `x` for which `can(x)` is true is your answer.

### ASCII Diagram — Binary Search on Answer Search Space

```
Predicate can(x): "Can we achieve the goal with value x?"
  Monotonically increasing: once true, stays true.

  can(x):  F  F  F  F  F  F  T  T  T  T  T
  x:       1  2  3  4  5  6  7  8  9 10 11
                              ↑
                    answer = 7 (smallest x where can(x) = T)

  lo=1, hi=11 (search space of ANSWERS, not array indices)
  mid=6 → can(6)=F → lo=7    mid=9 → can(9)=T → hi=9
  mid=8 → can(8)=T → hi=8    mid=7 → can(7)=T → hi=7
  lo==hi==7 → answer

  For "largest x where can(x)=F", flip the logic (decreasing predicate).
```

### Koko Eating Bananas (LeetCode 875)

Koko has `n` piles of bananas. She eats at speed `k` (piles per hour). Each hour she picks a pile and eats up to `k` bananas from it (if the pile has fewer than `k`, she eats all and does not move to another pile that hour). Find the minimum integer `k` such that she can eat all bananas within `h` hours.

**Predicate:** `canEat(k)` — can Koko finish all piles in `h` hours at speed `k`? As `k` increases, total hours decreases monotonically. Binary search for the smallest `k` where `canEat(k)` is true.

- `lo = 1` (minimum possible speed)
- `hi = max(piles)` (at max pile size, each pile takes exactly 1 hour)

### Java Solution (875)

```java
class Solution {
    public int minEatingSpeed(int[] piles, int h) {
        int lo = 1;
        int hi = 0;
        for (int pile : piles) {
            hi = Math.max(hi, pile);
        }

        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;
            if (canFinish(piles, mid, h)) {
                hi = mid;       // mid works, try smaller
            } else {
                lo = mid + 1;   // mid too slow, need faster
            }
        }
        return lo;
    }

    private boolean canFinish(int[] piles, int k, int h) {
        long hours = 0;  // use long to avoid overflow
        for (int pile : piles) {
            hours += (pile + k - 1) / k;  // ceiling division: ceil(pile / k)
        }
        return hours <= h;
    }
}
```

**Complexity:** O(n * log(max(piles))) time, O(1) space. Ceiling division `(pile + k - 1) / k` avoids floating point. Use `long` for hours to prevent overflow.

---

### Capacity To Ship Packages Within D Days (LeetCode 1011)

A conveyor belt has packages that must be shipped in order within `days` days. The `i`-th package has weight `weights[i]`. Find the minimum capacity of the ship so that all packages can be shipped within `days` days. Each day, you load the ship with packages in order (cannot reorder) and the total weight cannot exceed capacity.

**Predicate:** `canShip(capacity)` — can we ship all packages in `days` days with the given capacity? As capacity increases, days needed decreases monotonically. Binary search for the smallest capacity where `canShip(capacity)` is true.

- `lo = max(weights)` (must carry the heaviest single package)
- `hi = sum(weights)` (ship everything in one day)

### ASCII Diagram — Capacity Search Space

```
Weights: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], days = 5

Search space for capacity:
  lo = 10 (max single weight)   hi = 55 (sum of all weights)

canShip(capacity):  F  F  F  ...  T  T  T  T
                   10 11 12     14 15    55
                                  ↑
                        answer = smallest capacity where canShip = T

Binary search:
  lo=10, hi=55, mid=32 → canShip=T → hi=32
  lo=10, hi=32, mid=21 → canShip=T → hi=21
  lo=10, hi=21, mid=15 → canShip=T → hi=15
  lo=10, hi=15, mid=12 → canShip=F → lo=13
  lo=13, hi=15, mid=14 → canShip=T → hi=14
  lo==hi → answer = 15 (actual value depends on exact weights)
```

### Java Solution (1011)

```java
class Solution {
    public int shipWithinDays(int[] weights, int days) {
        int lo = 0, hi = 0;
        for (int w : weights) {
            lo = Math.max(lo, w);
            hi += w;
        }

        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;
            if (canShip(weights, mid, days)) {
                hi = mid;       // mid works, try smaller capacity
            } else {
                lo = mid + 1;   // mid too small, need more capacity
            }
        }
        return lo;
    }

    private boolean canShip(int[] weights, int capacity, int days) {
        int daysNeeded = 1;
        int currentLoad = 0;
        for (int w : weights) {
            if (currentLoad + w > capacity) {
                daysNeeded++;
                currentLoad = 0;
            }
            currentLoad += w;
        }
        return daysNeeded <= days;
    }
}
```

**Complexity:** O(n * log(sum - max)) time, O(1) space.

---

### Split Array Largest Sum (LeetCode 410)

Given an array of non-negative integers and an integer `m`, split the array into `m` non-empty contiguous subarrays. Minimize the largest sum among the `m` subarrays.

This is structurally identical to Capacity To Ship Packages — the "capacity" here is the "largest subarray sum," and "days" maps to "number of subarrays m."

**Predicate:** `canSplit(maxSum)` — can we split the array into at most `m` subarrays where each subarray sum is at most `maxSum`? As `maxSum` increases, the number of subarrays needed decreases. Binary search for the smallest `maxSum` where `canSplit(maxSum)` is true.

- `lo = max(nums)` (a single element could be its own subarray)
- `hi = sum(nums)` (one subarray containing everything)

The code is structurally identical to Capacity To Ship Packages (1011) above — replace `capacity` with `maxSum`, `days` with `m`, and the `canShip` function counts subarrays instead of days. The `canSplit` helper counts how many contiguous subarrays are needed so that each subarray sum is at most `maxSum`, then returns `count <= m`.

**Complexity:** O(n * log(sum - max)) time, O(1) space.

### Summary of Binary Search on Answer

| Problem | lo (min answer) | hi (max answer) | Predicate (monotonic) |
|---|---|---|---|
| Koko Eating Bananas | 1 | max(piles) | hours(piles, k) <= h |
| Ship Within Days | max(weights) | sum(weights) | daysNeeded(weights, cap) <= days |
| Split Array Largest Sum | max(nums) | sum(nums) | subarraysNeeded(nums, maxSum) <= m |

The common thread: find a feasible threshold via a monotonic predicate, binary search the threshold.

---

## 8. Find Peak Element (LeetCode 162)

A peak element is an element that is strictly greater than its neighbors. Given an array, find any peak index. You may imagine `nums[-1] = nums[n] = -infinity`. The array may contain multiple peaks — return any of them.

The key insight for O(log n): if `nums[mid] < nums[mid + 1]`, there must be a peak to the right (because the array rises to the right, and eventually must fall since `nums[n] = -inf`). Conversely, if `nums[mid] > nums[mid + 1]`, there must be a peak to the left (including mid).

```
Array: [1, 2, 3, 1]   (peak at index 2, value 3)

  nums[mid] < nums[mid+1]: peak exists in right half → lo = mid + 1
  nums[mid] > nums[mid+1]: peak exists at mid or left  → hi = mid
  The "slope" tells us which direction a peak must exist.
```

```java
class Solution {
    public int findPeakElement(int[] nums) {
        int lo = 0, hi = nums.length - 1;
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;
            if (nums[mid] < nums[mid + 1]) {
                lo = mid + 1;   // peak is to the right
            } else {
                hi = mid;       // peak is at mid or to the left
            }
        }
        return lo;
    }
}
```

**Complexity:** O(log n) time, O(1) space. LeetCode 162 guarantees no adjacent duplicates. A variant with duplicates may degrade to O(n) worst case.

---

## 9. Median of Two Sorted Arrays (LeetCode 4)

Given two sorted arrays `nums1` and `nums2` of sizes `m` and `n`, return the median of the two sorted arrays in O(log(min(m, n))) time.

This is the hardest binary search problem on this list. The approach: binary search on the **partition position** in the smaller array.

### The Idea

Binary search on the **partition position** in the smaller array. We partition both arrays into left and right halves where: (1) the left half contains exactly `(m + n + 1) / 2` elements (extra goes left when total is odd), and (2) every left element is <= every right element. If we choose partition index `i` in `nums1` (meaning `nums1[0..i-1]` goes left), then `nums2`'s partition is forced: `j = (m + n + 1) / 2 - i`. We binary search `i` to find the valid partition.

### ASCII Diagram — Partition Approach

```
nums1:  [1, 3, 8, 9, 15]          m = 5
nums2:  [7, 11, 18, 19, 21, 25]   n = 6
Total = 11, left half needs (11+1)/2 = 6 elements.

Binary search partition i in the shorter array (after swap):

Try i=3: nums1[0..2]=[1,3,8]  nums2[0..2]=[7,11,18] → 6 elements ✓
  maxLeft1=8, minRight1=9, maxLeft2=18, minRight2=19
  18 <= 9? ✗ → i too small, increase

Try i=4: nums1[0..3]=[1,3,8,9]  nums2[0..1]=[7,11]  → 6 elements ✓
  maxLeft1=9, minRight1=15, maxLeft2=11, minRight2=18
  9<=18 ✓  11<=15 ✓  → VALID PARTITION

  Left max = max(9, 11) = 11   Right min = min(15, 18) = 15
  Total odd → median = 11

  nums1:  [1,  3,  8,  9 | 15]       i=4 on left
  nums2:  [7, 11 | 18, 19, 21, 25]   j=2 on left
               ↑ combined left=6, right=5
```

### Java Solution (4)

```java
class Solution {
    public double findMedianSortedArrays(int[] nums1, int[] nums2) {
        // Ensure nums1 is the shorter array for O(log(min(m,n)))
        if (nums1.length > nums2.length) {
            return findMedianSortedArrays(nums2, nums1);
        }

        int m = nums1.length, n = nums2.length;
        int lo = 0, hi = m;  // partition range in nums1: [0, m]
        int halfTotal = (m + n + 1) / 2;  // left half size

        while (lo <= hi) {
            int i = lo + (hi - lo) / 2;   // partition in nums1: i elements on left
            int j = halfTotal - i;        // partition in nums2: j elements on left

            // Edge cases: use -inf/+inf when partition is at boundary
            int maxLeft1  = (i == 0) ? Integer.MIN_VALUE : nums1[i - 1];
            int minRight1 = (i == m) ? Integer.MAX_VALUE : nums1[i];

            int maxLeft2  = (j == 0) ? Integer.MIN_VALUE : nums2[j - 1];
            int minRight2 = (j == n) ? Integer.MAX_VALUE : nums2[j];

            if (maxLeft1 <= minRight2 && maxLeft2 <= minRight1) {
                // Valid partition found
                if ((m + n) % 2 == 1) {
                    return Math.max(maxLeft1, maxLeft2);
                } else {
                    return (Math.max(maxLeft1, maxLeft2)
                          + Math.min(minRight1, minRight2)) / 2.0;
                }
            } else if (maxLeft1 > minRight2) {
                // i is too large, decrease it
                hi = i - 1;
            } else {
                // maxLeft2 > minRight1, i is too small, increase it
                lo = i + 1;
            }
        }
        throw new IllegalArgumentException("Input arrays are not sorted.");
    }
}
```

**Complexity:** O(log(min(m, n))) time, O(1) space.

**Key details:**
- Always binary search the **shorter** array to guarantee O(log(min(m, n))).
- `i` ranges from `0` to `m` inclusive — `0` means nums1 contributes nothing to left; `m` means all of nums1 is left.
- `j = halfTotal - i` is forced by the left-half size constraint.
- Boundary sentinels (`MIN_VALUE`, `MAX_VALUE`) handle empty partitions so comparisons still work.
- Odd total: median = max(left halves). Even total: median = average of max(left halves) and min(right halves).

---

## 10. Square Root Using Binary Search (LeetCode 69)

Given a non-negative integer `x`, compute and return the square root of `x` rounded down to the nearest integer.

The square root of `x` is in the range `[0, x]`. We binary search for the largest integer `mid` such that `mid * mid <= x`.

### ASCII Diagram — Sqrt Search Space

```
x = 8, answer = 2 (2*2=4 <= 8 but 3*3=9 > 8)

  mid=4 → 16>8 → hi=3    mid=1 → 1<=8 → lo=2
  mid=2 → 4<=8 → lo=3    mid=3 → 9>8 → hi=2
  lo>hi → answer = hi = 2

  Predicate: mid*mid <= x (true for small, false for large)
  Find LARGEST mid where predicate is true.
```

```java
class Solution {
    public int mySqrt(int x) {
        if (x < 2) return x;  // sqrt(0)=0, sqrt(1)=1
        int lo = 1, hi = x / 2;  // sqrt(x) <= x/2 for x >= 2
        int result = 0;
        while (lo <= hi) {
            int mid = lo + (hi - lo) / 2;
            // Use division to avoid overflow: mid <= x / mid
            if (mid <= x / mid) {
                result = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return result;
    }
}
```

**Complexity:** O(log x) time, O(1) space.

**Overflow note:** `mid * mid` can overflow `int` for large `mid`. Using `mid <= x / mid` (integer division) avoids this. Alternatively, cast to `long`: `(long) mid * mid <= x`.

---

## 11. Binary Search on Functions

Several problems are phrased as "find the first position where a condition is true" over a range. These map directly to binary search.

### Search Insert Position (LeetCode 35)

Given a sorted array and a target, return the index where the target should be inserted to maintain sorted order. This is equivalent to finding the leftmost position where `nums[i] >= target`.

```java
class Solution {
    public int searchInsert(int[] nums, int target) {
        int lo = 0, hi = nums.length;  // note: hi = length, not length-1
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;
            if (nums[mid] < target) {
                lo = mid + 1;
            } else {
                hi = mid;  // nums[mid] >= target, candidate position
            }
        }
        return lo;
    }
}
```

**Complexity:** O(log n) time, O(1) space.

This is the leftmost binary search in disguise — finding the first element `>= target`. The range is `[0, n]` because the insert position could be after the last element.

---

### First Bad Version (LeetCode 278)

You have `n` versions `[1, 2, ..., n]` and an API `isBadVersion(version)`. Once a version is bad, all subsequent versions are bad. Find the first bad version.

This is a classic "find the first true" binary search. The predicate `isBadVersion(x)` is monotonically true once it becomes true.

```
Versions:  1  2  3  4  5
isBad:     F  F  F  T  T
                     ↑ first bad = 4

  lo=1, hi=5, mid=3 → F → lo=4    lo=4, hi=5, mid=4 → T → hi=4
  lo==hi==4 → first bad version = 4
```

```java
public class Solution extends VersionControl {
    public int firstBadVersion(int n) {
        int lo = 1, hi = n;
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;
            if (isBadVersion(mid)) {
                hi = mid;       // mid is bad, first bad is at mid or earlier
            } else {
                lo = mid + 1;   // mid is good, first bad is after mid
            }
        }
        return lo;
    }
}
```

**Complexity:** O(log n) time, O(1) space. `lo + (hi - lo) / 2` is critical here since `n` can be up to 2^31 - 1, making `lo + hi` overflow.

---

## 12. Comparison Table — Binary Search Variants

| Variant | Loop Condition | lo Update | hi Update | Return | Use Case |
|---|---|---|---|---|---|
| Classic (find exact) | `lo <= hi` | `mid + 1` | `mid - 1` | `mid` or `-1` | Exact match in sorted array |
| Leftmost (first >=) | `lo < hi` | `mid + 1` | `mid` | `lo` | First occurrence, insert position |
| Rightmost (last <=) | `lo < hi` | `mid` | `mid - 1` | `lo` (with right-biased mid) | Last occurrence |
| Leftmost (with result var) | `lo <= hi` | `mid + 1` | `mid - 1` | `result` | First occurrence of exact target |
| Rotated search | `lo <= hi` | `mid + 1` | `mid - 1` | `mid` or `-1` | Search in rotated array |
| Find min rotated | `lo < hi` | `mid + 1` | `mid` | `nums[lo]` | Minimum in rotated array |
| 2D matrix | `lo <= hi` | `mid + 1` | `mid - 1` | `true/false` | Search sorted 2D matrix |
| Binary search on answer | `lo < hi` | `mid + 1` | `mid` | `lo` | Min feasible value (capacity, speed) |
| Peak element | `lo < hi` | `mid + 1` | `mid` | `lo` | Any peak in array |
| First bad version | `lo < hi` | `mid + 1` | `mid` | `lo` | First true in monotonic predicate |
| Sqrt (floor) | `lo <= hi` | `mid + 1` | `mid - 1` | `result` | Integer square root |
| Median of two arrays | `lo <= hi` | `i + 1` | `i - 1` | computed | Median via partition search |

### Template Selection Guide

- `lo <= hi` with `mid + 1` / `mid - 1`: when you check exact mid and can discard it.
- `lo < hi` with `mid + 1` / `mid` (left-biased mid): searching for a leftmost boundary.
- `lo < hi` with `mid` / `mid - 1` (right-biased mid: `lo + (hi - lo + 1) / 2`): searching for rightmost boundary.
- When in doubt, use the `result` variable approach — most robust, least prone to infinite loops.

---

## 13. Pattern Recognition Table

When you see these signals in a problem, consider the corresponding binary search pattern:

| Signal in Problem | Pattern | Example Problems |
|---|---|---|
| "sorted array" + "find target" | Classic binary search | 704, 35, 34 |
| "sorted array" + "rotated" | Rotated array search | 33, 81, 153, 154 |
| "sorted" + "2D matrix" + "row start > prev row end" | Flatten to 1D, classic BS | 74 |
| "sorted" + "2D matrix" + "rows & cols sorted" | Staircase from top-right | 240 |
| "minimize max" or "maximize min" | Binary search on answer | 410, 1011, 875 |
| "find minimum k such that..." | Binary search on answer | 875, 1011, 410 |
| "monotonic predicate" (once true, stays true) | Find first true | 278, 35 |
| "greater than neighbors" + "any peak" | Peak element BS | 162, 852 |
| "two sorted arrays" + "O(log)" | Partition binary search | 4 |
| "integer square root" | BS on `[0, x/2]` | 69, 367 |
| "sorted" + "duplicates" + "first/last" | Leftmost/rightmost BS | 34 |
| "find smallest divisor" + "threshold" | Binary search on answer | 1283 |
| "split array" + "k subarrays" + "minimize max sum" | Binary search on answer | 410, 4 |
| "capacity" or "speed" or "threshold" | Binary search on answer | 875, 1011, 1283 |

---

## 14. Tips for Interview Success

1. **Always use `lo + (hi - lo) / 2`** for midpoint — prevents overflow and shows edge-case awareness.
2. **Articulate your invariant.** Before coding, state: "At every step, the answer is in `[lo, hi]`."
3. **Match loop condition to your strategy.** Use `lo <= hi` when you discard mid and check it directly. Use `lo < hi` when mid might be the answer and stays in range.
4. **Match mid bias to your update.** `hi = mid` → left-biased mid. `lo = mid` → right-biased mid (`lo + (hi - lo + 1) / 2`). Mismatching causes infinite loops.
5. **For "binary search on answer," write the `can(x)` predicate first.** Then set `lo` (smallest possible answer) and `hi` (largest possible answer) correctly.
6. **Test edge cases mentally:** empty array, single element, target at boundaries, target not present, no rotation (fully sorted).
7. **Watch for overflow in predicates.** Use `long` for sum accumulation; use division instead of multiplication for sqrt.
8. **Recognize "binary search on answer" even without "sorted" in the problem.** Minimizing a maximum with a monotonic feasibility check is the telltale sign.

---

## 15. Complexity Summary

| Problem | Time | Space | Pattern |
|---|---|---|---|
| Binary Search (704) | O(log n) | O(1) | Classic BS |
| Search Insert (35) | O(log n) | O(1) | Leftmost BS |
| Find First/Last (34) | O(log n) | O(1) | Leftmost + Rightmost |
| Rotated Search (33) | O(log n) | O(1) | Rotated BS |
| Find Min Rotated (153) | O(log n) | O(1) | Rotated min BS |
| Find Min Rotated II (154) | O(n) worst | O(1) | Rotated min + duplicates |
| 2D Matrix (74) | O(log(mn)) | O(1) | Flatten + Classic BS |
| 2D Matrix II (240) | O(m + n) | O(1) | Staircase |
| Koko Eating (875) | O(n log max) | O(1) | BS on answer |
| Ship Packages (1011) | O(n log(sum-max)) | O(1) | BS on answer |
| Split Array (410) | O(n log(sum-max)) | O(1) | BS on answer |
| Peak Element (162) | O(log n) | O(1) | Peak BS |
| Median Two Arrays (4) | O(log(min(m,n))) | O(1) | Partition BS |
| Sqrt (69) | O(log x) | O(1) | BS on answer range |
| First Bad Version (278) | O(log n) | O(1) | First true BS |

---

## 16. Final Notes

Binary search mastery comes in three levels:

1. **Classic:** Write a correct binary search on a sorted array — loop condition, midpoint, and bounds right every time.
2. **Structural variants:** Handle rotated arrays, 2D matrices, and peak finding. These modify comparison logic while keeping the halving structure.
3. **Binary search on answer:** Search over a range of possible answers rather than array indices. This is the most interview-relevant advanced pattern — recognize the "minimize max" or "maximize min" signal.

The partition-based median of two sorted arrays sits at the highest difficulty tier. Understanding the approach — even if you can't derive it from scratch — demonstrates deep mastery of binary search's generality. Master these patterns and you'll handle any binary search question in interviews.

## Interview Cheat Sheet

**Key Points to Remember:**
- Standard binary search: O(log n), requires sorted input.
- Template: while (left <= right), mid = left + (right-left)/2.
- Three variants: exact match, find first occurrence (continue left), find last occurrence (continue right).
- Binary search on answer: search the value space, not an array — "find minimum X such that condition(X) holds."

**Common Follow-Up Questions:**
- **How do you avoid integer overflow in mid calculation?** — Use mid = left + (right - left) / 2, NOT mid = (left + right) / 2.
- **What's binary search on answer?** — When the problem asks "find the minimum/maximum value satisfying a condition," binary search the value range. Example: "minimum capacity to ship packages in D days" — binary search capacity from max(weights) to sum(weights).

**Gotcha:**
- Using while (left < right) vs while (left <= right). The choice depends on whether you're looking for an exact match (use <=) or a boundary/insertion point (use <). Getting this wrong leads to infinite loops or missed elements.
