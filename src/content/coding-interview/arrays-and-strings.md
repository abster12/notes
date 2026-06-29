---
title: "Arrays & Strings — Interview Prep Guide"
category: "Coding Interview"
difficulty: "Medium to Hard"
tags:
  - arrays
  - strings
  - two-pointers
  - prefix-sum
  - kadane
  - sliding-window
  - dutch-flag
  - spiral-matrix
  - difference-array
  - java
  - leetcode
date: 2026-06-19
---

# Arrays & Strings — The Complete Interview Prep Guide

Arrays and strings form the bedrock of coding interviews. Nearly every technical interview at companies like Google, Meta, Amazon, and Apple begins with an array or string problem, because these data structures are simple enough to explain in a minute yet rich enough to test your ability to spot patterns, reason about edge cases, and write clean code under pressure. This guide walks through every major pattern you need to recognise on sight, gives you a reusable Java template for each, and demonstrates the pattern with full solutions to classic LeetCode problems. By the end you should be able to look at a problem statement, identify the pattern within seconds, and reach for the right template without hesitation.

The patterns covered here are: two pointers moving in opposite directions, two pointers moving in the same direction (which includes the sliding window technique), prefix sums, Kadane's algorithm for maximum subarray, the Dutch National Flag three-way partition, string manipulation primitives (palindrome, anagram, word reversal), array rotation, spiral matrix traversal, prefix and suffix arrays, and difference arrays. Each section follows the same structure — when to use the pattern, a Java template, ASCII diagrams where the visual helps, and two to three fully worked LeetCode solutions. A pattern recognition table at the end maps common problem keywords to the pattern you should reach for.

---

## Summary & Interview Framing

The most fundamental data structures — arrays (contiguous memory, O(1) access) and strings (character arrays). Covers two pointers, prefix sums, Kadane's algorithm, and Dutch National Flag.

**How it's asked:** "Two sum on a sorted array, longest substring without repeating characters, maximum subarray sum, container with most water — problems involving contiguous data with O(n) optimal solutions."

---

## 1. Two Pointers — Opposite Direction

The opposite-direction two-pointer technique places one pointer at the beginning of the array and another at the end, then moves them toward each other until they meet or cross. This works whenever the problem has a monotonic property — meaning that moving a pointer in one direction always improves or worsens the situation in a predictable way. The classic use cases are finding a pair that satisfies a condition in a sorted array, computing areas or volumes where the width shrinks as pointers converge, and checking palindromes by comparing characters from both ends. The key insight is that a sorted array gives you a decision: if the current pair is too small, move the left pointer right to increase the sum; if it is too large, move the right pointer left to decrease it. This eliminates the O(n²) brute force and replaces it with a single O(n) pass.

The template is straightforward. You initialise `left = 0` and `right = arr.length - 1`, then loop with a `while (left < right)` condition. Inside the loop you inspect the elements at both pointers, make a decision about which pointer to move, and update your answer. The loop terminates when the pointers cross, guaranteeing you have examined every relevant pair exactly once.

```java
// Template: Two Pointers — Opposite Direction
public int[] twoPointerOpposite(int[] arr, int target) {
    int left = 0, right = arr.length - 1;
    while (left < right) {
        int sum = arr[left] + arr[right];
        if (sum == target) {
            return new int[]{left, right};
        } else if (sum < target) {
            left++;   // sum too small, need a larger value
        } else {
            right--;  // sum too large, need a smaller value
        }
    }
    return new int[]{-1, -1}; // not found
}
```

The pointer movement is best visualised with a diagram. Consider a sorted array `[2, 7, 11, 15, 19, 23]` searching for a target sum of `26`:

```
Index:    0   1   2   3   4   5
Value:    2   7  11  15  19  23
          L                       R     sum = 2+23 = 25 < 26  →  move L right
              L                   R     sum = 7+23 = 30 > 26  →  move R left
              L               R         sum = 7+19 = 26 ✓ FOUND

L = left pointer (moves right →)
R = right pointer (moves left ←)
They converge until they meet or a solution is found.
```

### Problem 1 — Two Sum (LeetCode #1)

Given an array of integers and a target, return the indices of the two numbers that add up to the target. The classic version assumes the input is not sorted, so the optimal approach is a hash map for O(n) time. However, if the array is sorted (or if you sort it first and track original indices), the two-pointer technique gives a clean O(n) solution with O(1) space — no hash map needed.

```java
// LeetCode #1 — Two Sum (sorted array variant, two-pointer approach)
// If the input is unsorted, sort a copy of (value, index) pairs first.
class Solution {
    public int[] twoSum(int[] numbers, int target) {
        // numbers is sorted in non-decreasing order (LeetCode #167 variant)
        int left = 0, right = numbers.length - 1;
        while (left < right) {
            int sum = numbers[left] + numbers[right];
            if (sum == target) {
                return new int[]{left, right}; // 0-indexed
            } else if (sum < target) {
                left++;
            } else {
                right--;
            }
        }
        return new int[]{-1, -1};
    }
}
// Time: O(n)  |  Space: O(1)
```

For the unsorted original Two Sum, a hash map is preferred because sorting would destroy the original index mapping and cost O(n log n):

```java
// LeetCode #1 — Two Sum (original, unsorted, hash map approach)
class Solution {
    public int[] twoSum(int[] nums, int target) {
        Map<Integer, Integer> seen = new HashMap<>(); // value → index
        for (int i = 0; i < nums.length; i++) {
            int complement = target - nums[i];
            if (seen.containsKey(complement)) {
                return new int[]{seen.get(complement), i};
            }
            seen.put(nums[i], i);
        }
        return new int[]{-1, -1};
    }
}
// Time: O(n)  |  Space: O(n)
```

### Problem 2 — Container With Most Water (LeetCode #11)

You are given an array of non-negative integers where each integer represents the height of a vertical line drawn at that index. Find two lines that, together with the x-axis, form a container that holds the most water. The area between two lines at indices `i` and `j` is `min(height[i], height[j]) * (j - i)`. The two-pointer approach works because the width always decreases as the pointers converge — the only way to potentially find a larger area is to increase the minimum height, which means moving the pointer at the shorter line inward.

```java
// LeetCode #11 — Container With Most Water
class Solution {
    public int maxArea(int[] height) {
        int left = 0, right = height.length - 1;
        int maxArea = 0;
        while (left < right) {
            // Area = shorter height × distance between lines
            int area = Math.min(height[left], height[right]) * (right - left);
            maxArea = Math.max(maxArea, area);
            // Move the pointer at the shorter line — the taller one
            // might still pair with a better candidate on the other side.
            if (height[left] < height[right]) {
                left++;
            } else {
                right--;
            }
        }
        return maxArea;
    }
}
// Time: O(n)  |  Space: O(1)
```

### Problem 3 — Trapping Rain Water (LeetCode #42) — Two-Pointer Approach

Given an array of non-negative integers representing an elevation map, compute how much water can be trapped after raining. The two-pointer solution is elegant: you maintain `leftMax` and `rightMax` — the tallest bars seen so far from each side. At each step, you process the side with the smaller max, because the water level on that side is bounded by that smaller max. If `leftMax < rightMax`, then the water trapped at `left` depends only on `leftMax` (the right side is guaranteed to have something at least as tall), so you can safely compute and advance `left`.

```java
// LeetCode #42 — Trapping Rain Water (two-pointer approach)
class Solution {
    public int trap(int[] height) {
        if (height == null || height.length < 3) return 0;
        int left = 0, right = height.length - 1;
        int leftMax = 0, rightMax = 0;
        int water = 0;
        while (left < right) {
            if (height[left] < height[right]) {
                // Left side is lower — water at left is bounded by leftMax
                if (height[left] >= leftMax) {
                    leftMax = height[left]; // new tallest on left
                } else {
                    water += leftMax - height[left]; // trap water
                }
                left++;
            } else {
                // Right side is lower or equal — water at right bounded by rightMax
                if (height[right] >= rightMax) {
                    rightMax = height[right];
                } else {
                    water += rightMax - height[right];
                }
                right--;
            }
        }
        return water;
    }
}
// Time: O(n)  |  Space: O(1)
```

The water trapping logic can be visualised for the array `[0,1,0,2,1,0,1,3,2,1,2,1]`:

```
Elevation map (side view):
                    ■
        ■           ■■  ■
    ■   ■■   ■   ■  ■■■■■■
    ■ ■ ■■ ■ ■■ ■■■ ■■■■■■■   ← water fills gaps (░)
    0 1 0 2 1 0 1 3 2 1 2 1

Water trapped at each index:
    idx: 0  1  2  3  4  5  6  7  8  9 10 11
    h:   0  1  0  2  1  0  1  3  2  1  2  1
    H₂O: 0  0  1  0  1  2  1  0  0  1  0  0   →  total = 6
```

---

## 2. Two Pointers — Same Direction (and Sliding Window)

When both pointers start at the same end and move in the same direction, you get a technique that handles problems about subarrays, partitions, and in-place removal. The slow pointer (often called `slow`) marks the boundary of the "processed" or "kept" region, while the fast pointer (called `fast`) scouts ahead to examine every element. This is the foundation of the sliding window pattern, where the two pointers define a window `[left, right]` that expands by moving `right` and contracts by moving `left`.

You reach for same-direction pointers when the problem asks you to remove or compact elements in-place, partition an array by a predicate, find a longest or shortest subarray satisfying a constraint, or compute something over a contiguous window. The sliding window specifically applies when the constraint is monotonic — expanding the window always increases (or decreases) the metric, so you can shrink from the left when the constraint is violated and expand to the right when it is satisfied.

```java
// Template: Two Pointers — Same Direction (in-place compaction)
public int removeDuplicates(int[] arr) {
    if (arr.length == 0) return 0;
    int slow = 0; // boundary of kept elements
    for (int fast = 1; fast < arr.length; fast++) {
        if (arr[fast] != arr[slow]) {
            slow++;
            arr[slow] = arr[fast]; // keep this element
        }
        // else: skip the duplicate
    }
    return slow + 1; // new length
}
```

For the sliding window variant, the template generalises to maintain a running state (sum, count, frequency map) and shrink when a condition is violated:

```java
// Template: Sliding Window (variable-size, same-direction pointers)
public int slidingWindow(int[] arr, int k) {
    int left = 0, result = 0;
    int state = 0; // e.g., running sum, or a frequency map
    for (int right = 0; right < arr.length; right++) {
        state += arr[right];          // expand: include arr[right]
        while (conditionViolated(state, k)) {
            state -= arr[left];       // contract: remove arr[left]
            left++;
        }
        result = Math.max(result, right - left + 1); // update answer
    }
    return result;
}
```

The sliding window movement looks like this for finding the longest subarray with sum at most `k = 8` in the array `[1, 3, 2, 1, 4, 5, 2, 3]`:

```
Step 1:  [1]              sum=1 ≤ 8  ✓  len=1  L=0 R=0
Step 2:  [1, 3]           sum=4 ≤ 8  ✓  len=2  L=0 R=1
Step 3:  [1, 3, 2]        sum=6 ≤ 8  ✓  len=3  L=0 R=2
Step 4:  [1, 3, 2, 1]     sum=7 ≤ 8  ✓  len=4  L=0 R=3
Step 5:  [1, 3, 2, 1, 4]  sum=9 > 8  ✗  shrink L → [3,2,1,4] sum=8 ✓ len=4
Step 6:  [3, 2, 1, 4, 5]  sum=15 > 8 ✗  shrink L → [2,1,4,5] sum=12 ✗
         → [1,4,5] sum=10 ✗ → [4,5] sum=9 ✗ → [5] sum=5 ✓ len=1
         ...and so on. The window [L..R] slides rightward.
         R advances every step; L catches up only when needed.

         L→                         (slow pointer, contracts)
         R→                         (fast pointer, always expands)
         [  L - - - - R  ]          window of valid elements
```

### Problem 1 — Remove Duplicates from Sorted Array (LeetCode #26)

Given a sorted array, remove duplicates in-place so each element appears once, and return the new length. This is the canonical same-direction two-pointer problem. The slow pointer tracks where the next unique element should go, and the fast pointer scans through the array. Whenever the fast pointer finds an element different from the one at the slow pointer's position, we copy it forward and advance slow.

```java
// LeetCode #26 — Remove Duplicates from Sorted Array
class Solution {
    public int removeDuplicates(int[] nums) {
        if (nums.length == 0) return 0;
        int slow = 0; // index of last unique element placed
        for (int fast = 1; fast < nums.length; fast++) {
            if (nums[fast] != nums[slow]) {
                slow++;
                nums[slow] = nums[fast];
            }
        }
        return slow + 1;
    }
}
// Time: O(n)  |  Space: O(1)
```

### Problem 2 — Move Zeroes (LeetCode #283)

Given an array, move all zeroes to the end while maintaining the relative order of non-zero elements, in-place. This is a partition problem solved with same-direction pointers. The slow pointer marks where the next non-zero element should be written. The fast pointer finds non-zero elements and swaps them into position.

```java
// LeetCode #283 — Move Zeroes
class Solution {
    public void moveZeroes(int[] nums) {
        int slow = 0; // next position for a non-zero element
        for (int fast = 0; fast < nums.length; fast++) {
            if (nums[fast] != 0) {
                // swap nums[slow] and nums[fast]
                int temp = nums[slow];
                nums[slow] = nums[fast];
                nums[fast] = temp;
                slow++;
            }
        }
    }
}
// Time: O(n)  |  Space: O(1)
```

### Problem 3 — Longest Substring Without Repeating Characters (LeetCode #3)

Given a string, find the length of the longest substring without repeating characters. This is a classic variable-size sliding window. The right pointer expands the window by including new characters, while a HashSet or HashMap tracks which characters are currently in the window. When a duplicate is found, the left pointer shrinks the window until the duplicate is removed.

```java
// LeetCode #3 — Longest Substring Without Repeating Characters
class Solution {
    public int lengthOfLongestSubstring(String s) {
        Set<Character> window = new HashSet<>();
        int left = 0, maxLen = 0;
        for (int right = 0; right < s.length(); right++) {
            char c = s.charAt(right);
            // Shrink window until the duplicate is removed
            while (window.contains(c)) {
                window.remove(s.charAt(left));
                left++;
            }
            window.add(c);
            maxLen = Math.max(maxLen, right - left + 1);
        }
        return maxLen;
    }
}
// Time: O(n) — each character is added and removed at most once
// Space: O(min(n, 26+26+specials)) for the character set
```

An optimised version using a HashMap that stores the last index of each character lets you jump `left` directly instead of shrinking one step at a time, turning the worst case from 2n operations into exactly n:

```java
// LeetCode #3 — Optimised with HashMap (jump left directly)
class Solution {
    public int lengthOfLongestSubstring(String s) {
        Map<Character, Integer> lastIndex = new HashMap<>();
        int left = 0, maxLen = 0;
        for (int right = 0; right < s.length(); right++) {
            char c = s.charAt(right);
            if (lastIndex.containsKey(c) && lastIndex.get(c) >= left) {
                left = lastIndex.get(c) + 1; // jump past the duplicate
            }
            lastIndex.put(c, right);
            maxLen = Math.max(maxLen, right - left + 1);
        }
        return maxLen;
    }
}
// Time: O(n)  |  Space: O(min(n, charset))
```

---

## 3. Prefix Sums

A prefix sum array transforms any range-sum query into a constant-time subtraction. You precompute `prefix[i]` as the sum of the first `i` elements (with `prefix[0] = 0` by convention), and then the sum of any subarray from index `l` to `r` inclusive is simply `prefix[r+1] - prefix[l]`. This is one of the most versatile tools in array problem solving — it appears whenever a problem asks about subarray sums, range queries, equilibrium points, or partitioning an array into segments with equal sums.

You should reach for prefix sums the moment a problem mentions "subarray sum," "range sum," "sum of elements between two indices," or asks whether a subarray with a given sum exists. The precomputation costs O(n) time and O(n) space, and each subsequent query is O(1). For problems involving subarray sums with a target, combining prefix sums with a hash map is the standard trick: instead of checking every pair of prefix indices, you store prefix sums in a map and look up `currentPrefix - target` to find how many starting positions yield the desired subarray sum.

```java
// Template: Prefix Sum Array
public int[] buildPrefixSum(int[] arr) {
    int[] prefix = new int[arr.length + 1];
    prefix[0] = 0; // sentinel: sum of zero elements
    for (int i = 0; i < arr.length; i++) {
        prefix[i + 1] = prefix[i] + arr[i];
    }
    return prefix;
}

// Query: sum of arr[l..r] inclusive = prefix[r+1] - prefix[l]
public int rangeSum(int[] prefix, int l, int r) {
    return prefix[r + 1] - prefix[l];
}
```

The prefix array for `[3, 1, 4, 1, 5, 9]` looks like:

```
Index i:    0   1   2   3   4   5
arr[i]:     3   1   4   1   5   9
prefix[0] = 0
prefix[1] = 0+3 = 3
prefix[2] = 3+1 = 4
prefix[3] = 4+4 = 8
prefix[4] = 8+1 = 9
prefix[5] = 9+5 = 14
prefix[6] = 14+9 = 23

Visualisation:
arr:    [ 3 | 1 | 4 | 1 | 5 | 9 ]
prefix: [0| 3 | 4 | 8 | 9 |14 |23 ]
          0   1   2   3   4   5   6  ← prefix indices

Sum of arr[1..4] = prefix[5] - prefix[1] = 14 - 3 = 11
  (which is 1 + 4 + 1 + 5 = 11 ✓)
```

### Problem 1 — Range Sum Query (LeetCode #303)

Given an integer array, handle multiple queries asking for the sum of elements between indices `left` and `right` inclusive. This is the textbook prefix sum use case — precompute once, answer every query in O(1).

```java
// LeetCode #303 — Range Sum Query Immutable
class NumArray {
    private int[] prefix;

    public NumArray(int[] nums) {
        prefix = new int[nums.length + 1];
        for (int i = 0; i < nums.length; i++) {
            prefix[i + 1] = prefix[i] + nums[i];
        }
    }

    public int sumRange(int left, int right) {
        return prefix[right + 1] - prefix[left];
    }
}
// Constructor: O(n)  |  Query: O(1)  |  Space: O(n)
```

### Problem 2 — Subarray Sum Equals K (LeetCode #560)

Given an array of integers and an integer `k`, find the total number of continuous subarrays whose sum equals `k`. The brute force checks all O(n²) subarrays. The prefix sum with hash map approach reduces this to O(n): you iterate through the array maintaining a running sum, and at each step you check how many previous prefix sums equal `runningSum - k`. Each such prefix sum corresponds to a subarray ending at the current position with sum exactly `k`. You use a hash map to count occurrences of each prefix sum seen so far, initialised with `{0: 1}` to handle subarrays starting from index 0.

```java
// LeetCode #560 — Subarray Sum Equals K
class Solution {
    public int subarraySum(int[] nums, int k) {
        Map<Integer, Integer> count = new HashMap<>();
        count.put(0, 1); // empty prefix has sum 0, seen once
        int runningSum = 0;
        int result = 0;
        for (int num : nums) {
            runningSum += num;
            // If (runningSum - k) was seen before, those positions
            // are valid start indices for a subarray summing to k.
            result += count.getOrDefault(runningSum - k, 0);
            count.merge(runningSum, 1, Integer::sum);
        }
        return result;
    }
}
// Time: O(n)  |  Space: O(n)
```

### Problem 3 — Find Pivot Index (LeetCode #724)

Given an array, find the pivot index where the sum of all elements to the left equals the sum of all elements to the right. Using a prefix sum, the left sum at index `i` is `prefix[i]` and the right sum is `prefix[n] - prefix[i+1]`. You check every index in one pass.

```java
// LeetCode #724 — Find Pivot Index
class Solution {
    public int pivotIndex(int[] nums) {
        int totalSum = 0;
        for (int num : nums) totalSum += num;
        int leftSum = 0;
        for (int i = 0; i < nums.length; i++) {
            // rightSum = totalSum - leftSum - nums[i]
            if (leftSum == totalSum - leftSum - nums[i]) {
                return i;
            }
            leftSum += nums[i];
        }
        return -1;
    }
}
// Time: O(n)  |  Space: O(1) — only running sums needed, no extra array
```

---

## 4. Kadane's Algorithm (Maximum Subarray)

Kadane's algorithm solves the maximum subarray problem: given an array of integers (which may contain negatives), find the contiguous subarray with the largest sum. The idea is to maintain a running sum that resets to zero whenever it becomes negative — because a negative prefix can never help a subsequent subarray; starting fresh is always better. At each element, you decide whether to extend the current subarray or start a new one. The decision is simply `currentMax = max(num, currentMax + num)`, and you track the global maximum throughout.

You reach for Kadane's whenever a problem asks about "maximum subarray sum," "maximum subarray product" (with a modified version), "best time to buy and sell stock" (which is a variant — maximise the difference), or any problem where you need the optimal contiguous segment. The algorithm runs in O(n) time and O(1) space, making it optimal. A common extension is to also track the starting and ending indices of the optimal subarray, which you do by noting when `currentMax` resets.

```java
// Template: Kadane's Algorithm
public int maxSubArray(int[] nums) {
    int currentMax = nums[0]; // best subarray ending at current position
    int globalMax = nums[0];  // best subarray seen overall
    for (int i = 1; i < nums.length; i++) {
        // Either extend the previous subarray or start fresh at nums[i]
        currentMax = Math.max(nums[i], currentMax + nums[i]);
        globalMax = Math.max(globalMax, currentMax);
    }
    return globalMax;
}
// Time: O(n)  |  Space: O(1)
```

The decision process for `[-2, 1, -3, 4, -1, 2, 1, -5, 4]` (answer: `[4, -1, 2, 1]`, sum = 6):

```
Index:  0    1    2    3    4    5    6    7    8
num:   -2    1   -3    4   -1    2    1   -5    4
cur:   -2    1   -2    4    3    5    6    1    5    (max(num, cur+num))
glob:  -2    1    1    4    4    5    6    6    6

         reset          extend chain: 4 → 3 → 5 → 6 → ...
         (cur=-2       [4,-1,2,1] = max subarray, sum = 6
          is worse     the -5 breaks the chain (6-5=1 < 6)
          than 1)      but global max is already captured at index 6

Kadane traces the running sum, resetting whenever the running sum
drops below the current element alone:
  cur = max(num, cur + num)
```

### Problem 1 — Maximum Subarray (LeetCode #53)

This is the canonical Kadane's problem. The solution above is the complete answer. Here it is again as a clean LeetCode submission with the index-tracking variant:

```java
// LeetCode #53 — Maximum Subarray (with index tracking)
class Solution {
    public int maxSubArray(int[] nums) {
        int currentMax = nums[0], globalMax = nums[0];
        int start = 0, end = 0, tempStart = 0;
        for (int i = 1; i < nums.length; i++) {
            if (nums[i] > currentMax + nums[i]) {
                currentMax = nums[i];
                tempStart = i; // start a new subarray here
            } else {
                currentMax += nums[i];
            }
            if (currentMax > globalMax) {
                globalMax = currentMax;
                start = tempStart;
                end = i;
            }
        }
        // The maximum subarray is nums[start..end] with sum = globalMax
        return globalMax;
    }
}
// Time: O(n)  |  Space: O(1)
```

### Problem 2 — Maximum Product Subarray (LeetCode #152)

The product variant is trickier because multiplying two negatives gives a positive. You must track both the maximum and minimum product ending at the current position, because a negative number can flip the minimum into a new maximum. At each step, the new maximum is the largest of `num`, `maxProd * num`, and `minProd * num`, and similarly for the new minimum.

```java
// LeetCode #152 — Maximum Product Subarray
class Solution {
    public int maxProduct(int[] nums) {
        if (nums.length == 0) return 0;
        int maxProd = nums[0], minProd = nums[0], result = nums[0];
        for (int i = 1; i < nums.length; i++) {
            int num = nums[i];
            // When num is negative, max and min swap roles
            int candidates = maxProd * num;
            int candidates2 = minProd * num;
            maxProd = Math.max(num, Math.max(candidates, candidates2));
            minProd = Math.min(num, Math.min(candidates, candidates2));
            result = Math.max(result, maxProd);
        }
        return result;
    }
}
// Time: O(n)  |  Space: O(1)
```

### Problem 3 — Best Time to Buy and Sell Stock (LeetCode #121)

You are given an array of daily stock prices and must maximise profit by choosing one day to buy and a later day to sell. This is Kadane's in disguise — the "subarray" is the sequence of daily price changes, and the maximum subarray sum of those changes equals the maximum profit. Alternatively, you can track the minimum price seen so far and compute the profit if you sold today.

```java
// LeetCode #121 — Best Time to Buy and Sell Stock
class Solution {
    public int maxProfit(int[] prices) {
        int minPrice = Integer.MAX_VALUE;
        int maxProfit = 0;
        for (int price : prices) {
            minPrice = Math.min(minPrice, price);
            maxProfit = Math.max(maxProfit, price - minPrice);
        }
        return maxProfit;
    }
}
// Time: O(n)  |  Space: O(1)
// This is Kadane's applied to the "running min" instead of "running sum."
```

---

## 5. Dutch National Flag (3-Way Partition)

The Dutch National Flag problem, introduced by Edsger Dijkstra, partitions an array containing three distinct values (traditionally 0, 1, and 2 — representing red, white, and blue) so that all 0s come first, then all 1s, then all 2s, in a single pass with O(1) extra space. The technique uses three pointers: `low` marks the boundary where the next 0 should go, `mid` is the current scanning pointer, and `high` marks the boundary where the next 2 should go. As `mid` scans forward, it sends 0s to the `low` region and 2s to the `high` region, leaving 1s in the middle.

You use this pattern whenever a problem involves sorting or partitioning an array with exactly three categories — it could be colours, pivot values in quicksort (to handle duplicates efficiently), or any tri-state classification. The algorithm makes a single pass: when `mid` sees a 0, it swaps with `low` and both advance; when it sees a 1, it just advances; when it sees a 2, it swaps with `high` and only `high` retreats (because the swapped-in element at `mid` hasn't been examined yet).

```java
// Template: Dutch National Flag (3-way partition)
public void sortColors(int[] arr) {
    int low = 0, mid = 0, high = arr.length - 1;
    while (mid <= high) {
        if (arr[mid] == 0) {
            swap(arr, low, mid);
            low++;
            mid++;
        } else if (arr[mid] == 1) {
            mid++; // 1s stay in the middle, no swap needed
        } else { // arr[mid] == 2
            swap(arr, mid, high);
            high--;
            // Do NOT increment mid — the swapped element is unexamined
        }
    }
}

private void swap(int[] arr, int i, int j) {
    int temp = arr[i];
    arr[i] = arr[j];
    arr[j] = temp;
}
```

The three-region partitioning for input `[2, 0, 1, 0, 2, 1, 0]`:

```
Initial:  [ 2  0  1  0  2  1  0 ]
            L  M                 H
            (L=low boundary for 0s)
            (M=scanner)
            (H=high boundary for 2s)

Goal layout after sorting:
  [ 0  0  0 | 1  1 | 2  2 ]
   ←  0s  → ← 1s →← 2s →
    low       mid    high

Step-by-step (L=low, M=mid, H=high):
  [2  0  1  0  2  1  0]   arr[M]=2 → swap M,H → [0 0 1 0 2 1|2] H--
   L  M              H                           L M          H
  [0  0  1  0  2  1 |2]   arr[M]=0 → swap L,M → [0 0 1 0 2 1|2] L++ M++
   L  M           H                               L M        H
  [0  0  1  0  2  1 |2]   arr[M]=0 → swap L,M → [0 0 1 0 2 1|2] L++ M++
      L  M        H                                 L M      H
  [0  0  1  0  2  1 |2]   arr[M]=1 → M++           [0 0 1 0 2 1|2]
         L  M     H                                    L M    H
  ... M scans until M > H, array is sorted: [0 0 0 1 1 2 2]
```

### Problem 1 — Sort Colors (LeetCode #75)

This is the direct Dutch National Flag problem. The array contains only 0s, 1s, and 2s, and you must sort it in-place in one pass. The template above is the complete solution.

```java
// LeetCode #75 — Sort Colors
class Solution {
    public void sortColors(int[] nums) {
        int low = 0, mid = 0, high = nums.length - 1;
        while (mid <= high) {
            if (nums[mid] == 0) {
                swap(nums, low++, mid++);
            } else if (nums[mid] == 1) {
                mid++;
            } else {
                swap(nums, mid, high--);
            }
        }
    }

    private void swap(int[] nums, int i, int j) {
        int tmp = nums[i];
        nums[i] = nums[j];
        nums[j] = tmp;
    }
}
// Time: O(n)  |  Space: O(1)
```

### Problem 2 — 3Sum (LeetCode #15) — Using Sort + Two Pointers

While not the Dutch National Flag directly, 3Sum uses sorting plus the opposite-direction two-pointer technique and is a natural companion to the colour-sorting pattern. You sort the array, fix one element, and then use two pointers on the remaining suffix to find pairs that complete the triplet. Sorting first enables the two-pointer decision logic and also makes skipping duplicates straightforward.

```java
// LeetCode #15 — 3Sum
class Solution {
    public List<List<Integer>> threeSum(int[] nums) {
        List<List<Integer>> result = new ArrayList<>();
        Arrays.sort(nums);
        for (int i = 0; i < nums.length - 2; i++) {
            // Skip duplicate fixed elements
            if (i > 0 && nums[i] == nums[i - 1]) continue;
            // Early termination: if smallest possible triplet > 0
            if (nums[i] + nums[i + 1] + nums[i + 2] > 0) break;
            // Early skip: if largest possible triplet with nums[i] < 0
            if (nums[i] + nums[nums.length - 2] + nums[nums.length - 1] < 0) continue;

            int left = i + 1, right = nums.length - 1;
            while (left < right) {
                int sum = nums[i] + nums[left] + nums[right];
                if (sum == 0) {
                    result.add(Arrays.asList(nums[i], nums[left], nums[right]));
                    // Skip duplicate left and right values
                    while (left < right && nums[left] == nums[left + 1]) left++;
                    while (left < right && nums[right] == nums[right - 1]) right--;
                    left++;
                    right--;
                } else if (sum < 0) {
                    left++;
                } else {
                    right--;
                }
            }
        }
        return result;
    }
}
// Time: O(n²)  |  Space: O(1) excluding output
```

### Problem 3 — Sort Array By Parity / Move Zeroes Variant

A related partition problem: move all even numbers to the front and odd numbers to the back, maintaining relative order is not required. This is a two-way partition (simpler than Dutch Flag) but follows the same spirit — a read pointer and a write pointer.

```java
// LeetCode #905 — Sort Array By Parity
class Solution {
    public int[] sortArrayByParity(int[] nums) {
        int write = 0; // next position for an even number
        for (int read = 0; read < nums.length; read++) {
            if (nums[read] % 2 == 0) {
                int tmp = nums[write];
                nums[write] = nums[read];
                nums[read] = tmp;
                write++;
            }
        }
        return nums;
    }
}
// Time: O(n)  |  Space: O(1)
```

---

## 6. String Manipulation — Palindrome, Anagram, Reverse Words

String problems are array problems with characters, but they come with a set of recurring sub-patterns worth memorising. Palindrome checking uses opposite-direction pointers comparing characters from both ends (skipping non-alphanumeric characters when the input is a sentence). Anagram detection leverages character frequency counting — two strings are anagrams if they contain the same characters in the same counts, which you verify with a single integer array of size 26 (for lowercase letters) or 128 (for ASCII). Word reversal typically involves reversing the entire string and then reversing each individual word, or collecting words into a list and rebuilding the string in reverse order.

The palindrome check is the simplest: two pointers, one at each end, comparing inward. For "valid palindrome" problems that ignore case and non-alphanumeric characters, you advance each pointer past characters that do not count before comparing.

```java
// Template: Valid Palindrome (ignoring non-alphanumeric, case-insensitive)
public boolean isPalindrome(String s) {
    int left = 0, right = s.length() - 1;
    while (left < right) {
        while (left < right && !Character.isLetterOrDigit(s.charAt(left))) left++;
        while (left < right && !Character.isLetterOrDigit(s.charAt(right))) right--;
        if (Character.toLowerCase(s.charAt(left)) != Character.toLowerCase(s.charAt(right))) {
            return false;
        }
        left++;
        right--;
    }
    return true;
}
```

For anagrams, the frequency-count approach is O(n) time and O(1) space (the count array is fixed-size):

```java
// Template: Valid Anagram (frequency counting)
public boolean isAnagram(String s, String t) {
    if (s.length() != t.length()) return false;
    int[] count = new int[26];
    for (char c : s.toCharArray()) count[c - 'a']++;
    for (char c : t.toCharArray()) count[c - 'a']--;
    for (int freq : count) if (freq != 0) return false;
    return true;
}
```

For reversing words in a string, the two-pass reverse technique (reverse everything, then reverse each word) works in-place on a mutable character array and avoids needing extra space for a word list:

```java
// Template: Reverse Words in a String (in-place on char array)
public void reverseWords(char[] s) {
    // Step 1: reverse the entire array
    reverse(s, 0, s.length - 1);
    // Step 2: reverse each individual word
    int start = 0;
    for (int i = 0; i <= s.length; i++) {
        if (i == s.length || s[i] == ' ') {
            reverse(s, start, i - 1);
            start = i + 1;
        }
    }
}

private void reverse(char[] s, int lo, int hi) {
    while (lo < hi) {
        char tmp = s[lo];
        s[lo] = s[hi];
        s[hi] = tmp;
        lo++; hi--;
    }
}
```

### Problem 1 — Valid Palindrome (LeetCode #125)

Given a string, determine if it is a palindrome considering only alphanumeric characters and ignoring case. The template above is the solution. The key is advancing both pointers past any character that is not a letter or digit before comparing.

```java
// LeetCode #125 — Valid Palindrome
class Solution {
    public boolean isPalindrome(String s) {
        int left = 0, right = s.length() - 1;
        while (left < right) {
            while (left < right && !Character.isLetterOrDigit(s.charAt(left))) left++;
            while (left < right && !Character.isLetterOrDigit(s.charAt(right))) right--;
            if (Character.toLowerCase(s.charAt(left))
                    != Character.toLowerCase(s.charAt(right))) {
                return false;
            }
            left++;
            right--;
        }
        return true;
    }
}
// Time: O(n)  |  Space: O(1)
```

### Problem 2 — Valid Anagram (LeetCode #242)

Given two strings `s` and `t`, return true if `t` is an anagram of `s`. The frequency count approach handles this in a single pass over each string. A variant for LeetCode #49 (Group Anagrams) uses a sorted version of each string as a hash key, grouping all anagrams together.

```java
// LeetCode #242 — Valid Anagram
class Solution {
    public boolean isAnagram(String s, String t) {
        if (s.length() != t.length()) return false;
        int[] count = new int[26];
        for (int i = 0; i < s.length(); i++) {
            count[s.charAt(i) - 'a']++;
            count[t.charAt(i) - 'a']--;
        }
        for (int c : count) {
            if (c != 0) return false;
        }
        return true;
    }
}
// Time: O(n)  |  Space: O(1) — the count array is fixed at 26
```

### Problem 3 — Reverse Words in a String (LeetCode #151)

Given an input string, reverse the string word by word. For example, "the sky is blue" becomes "blue is sky the". Multiple spaces should be reduced to single spaces, and leading/trailing spaces removed. The cleanest Java approach splits on whitespace and rebuilds in reverse, but the in-place reverse technique is what interviewers often want to see.

```java
// LeetCode #151 — Reverse Words in a String
class Solution {
    public String reverseWords(String s) {
        // Trim and split on one-or-more whitespace
        String[] words = s.trim().split("\\s+");
        // Reverse the word order using two pointers on the array
        int left = 0, right = words.length - 1;
        while (left < right) {
            String tmp = words[left];
            words[left] = words[right];
            words[right] = tmp;
            left++;
            right--;
        }
        return String.join(" ", words);
    }
}
// Time: O(n)  |  Space: O(n) for the words array

// Alternative: in-place on a char array (no split, O(1) extra space)
class SolutionInPlace {
    public String reverseWords(String s) {
        char[] chars = s.toCharArray();
        // 1. Reverse the whole string
        reverse(chars, 0, chars.length - 1);
        // 2. Reverse each word
        int start = 0;
        for (int i = 0; i <= chars.length; i++) {
            if (i == chars.length || chars[i] == ' ') {
                if (i > start) reverse(chars, start, i - 1);
                start = i + 1;
            }
        }
        // 3. Clean up spaces (collapse multiple, trim ends)
        return cleanSpaces(chars);
    }

    private void reverse(char[] a, int lo, int hi) {
        while (lo < hi) {
            char t = a[lo]; a[lo] = a[hi]; a[hi] = t;
            lo++; hi--;
        }
    }

    private String cleanSpaces(char[] a) {
        int n = a.length, write = 0, read = 0;
        while (read < n && a[read] == ' ') read++; // leading
        while (read < n) {
            while (read < n && a[read] != ' ') a[write++] = a[read++];
            while (read < n && a[read] == ' ') read++; // between/ trailing
            if (read < n) a[write++] = ' ';
        }
        return new String(a, 0, write);
    }
}
```

### Problem 4 — Longest Palindromic Substring (LeetCode #5)

Given a string, find the longest palindromic substring. The expand-around-centre approach is the most intuitive and runs in O(n²) time with O(1) space. For each index (and each gap between indices, for even-length palindromes), you expand outward as long as characters match. Manacher's algorithm can do O(n), but it is rarely expected in interviews.

```java
// LeetCode #5 — Longest Palindromic Substring
class Solution {
    public String longestPalindrome(String s) {
        if (s == null || s.length() < 1) return "";
        int start = 0, maxLen = 1;
        for (int i = 0; i < s.length(); i++) {
            // Odd-length palindromes (single char centre)
            int len1 = expandAroundCenter(s, i, i);
            // Even-length palindromes (two char centre)
            int len2 = expandAroundCenter(s, i, i + 1);
            int len = Math.max(len1, len2);
            if (len > maxLen) {
                maxLen = len;
                start = i - (len - 1) / 2; // compute start index
            }
        }
        return s.substring(start, start + maxLen);
    }

    private int expandAroundCenter(String s, int left, int right) {
        while (left >= 0 && right < s.length()
                && s.charAt(left) == s.charAt(right)) {
            left--;
            right++;
        }
        // Length = (right - 1) - (left + 1) + 1 = right - left - 1
        return right - left - 1;
    }
}
// Time: O(n²)  |  Space: O(1)
```

---

## 7. Array Rotation

Array rotation shifts every element to the left or right by `k` positions, with elements that fall off the end wrapping around to the other side. The elegant O(1) space solution uses three reversals: reverse the entire array, then reverse the first `k` elements, then reverse the remaining `n - k` elements. For a right rotation by `k`, the first `k` elements after the full reverse correspond to what was at the end; reversing them back restores their order, and reversing the rest does the same for the other portion. You must normalise `k` modulo `n` because rotating by `n` is a no-op.

Rotation problems appear in two flavours: the "rotate the array" problem where you physically move elements, and the "search in rotated sorted array" problem where the rotation is a property of the input that you must account for during binary search. The physical rotation uses the reversal trick; the search problem uses a modified binary search that checks which half is sorted to decide where the target lies.

```java
// Template: Rotate Array by k (right rotation, in-place via 3 reversals)
public void rotate(int[] nums, int k) {
    int n = nums.length;
    k = k % n; // normalise: k could be >= n
    if (k == 0) return;
    reverse(nums, 0, n - 1);       // Step 1: reverse entire array
    reverse(nums, 0, k - 1);       // Step 2: reverse first k elements
    reverse(nums, k, n - 1);       // Step 3: reverse remaining n-k elements
}

private void reverse(int[] nums, int lo, int hi) {
    while (lo < hi) {
        int tmp = nums[lo];
        nums[lo] = nums[hi];
        nums[hi] = tmp;
        lo++; hi--;
    }
}
```

The three-reversal technique for right-rotating `[1, 2, 3, 4, 5, 6, 7]` by `k = 3`:

```
Original:        [ 1  2  3  4  5  6  7 ]   (rotate right by 3)

Step 1 — Reverse all:
                 [ 7  6  5  4  3  2  1 ]

Step 2 — Reverse first k=3:
                 [ 5  6  7 | 4  3  2  1 ]
                   ←k=3→

Step 3 — Reverse remaining n-k=4:
                 [ 5  6  7  1  2  3  4 ]
                             ←n-k=4→

Result:          [ 5  6  7  1  2  3  4 ]   ✓ (elements shifted right by 3)
```

### Problem 1 — Rotate Array (LeetCode #189)

Rotate an array to the right by `k` steps in-place with O(1) extra space. The three-reversal technique is the standard solution. An alternative O(n) space approach copies elements into a new array at their computed final positions, but the reversal method is what interviewers look for.

```java
// LeetCode #189 — Rotate Array
class Solution {
    public void rotate(int[] nums, int k) {
        int n = nums.length;
        k %= n;
        reverse(nums, 0, n - 1);
        reverse(nums, 0, k - 1);
        reverse(nums, k, n - 1);
    }

    private void reverse(int[] nums, int lo, int hi) {
        while (lo < hi) {
            int tmp = nums[lo];
            nums[lo] = nums[hi];
            nums[hi] = tmp;
            lo++; hi--;
        }
    }
}
// Time: O(n)  |  Space: O(1)
```

### Problem 2 — Search in Rotated Sorted Array (LeetCode #33)

A sorted array has been rotated at an unknown pivot. Given a target, search for it in O(log n) time. The modified binary search checks which half of the array is sorted (the half without the rotation pivot) and uses that to decide whether the target lies in the sorted half or the other half. The key insight is that in a rotated sorted array, at least one half (left or right of `mid`) is always properly sorted.

```java
// LeetCode #33 — Search in Rotated Sorted Array
class Solution {
    public int search(int[] nums, int target) {
        int left = 0, right = nums.length - 1;
        while (left <= right) {
            int mid = left + (right - left) / 2;
            if (nums[mid] == target) return mid;

            // Determine which half is sorted
            if (nums[left] <= nums[mid]) {
                // Left half is sorted
                if (target >= nums[left] && target < nums[mid]) {
                    right = mid - 1; // target in left half
                } else {
                    left = mid + 1;  // target in right half
                }
            } else {
                // Right half is sorted
                if (target > nums[mid] && target <= nums[right]) {
                    left = mid + 1;  // target in right half
                } else {
                    right = mid - 1; // target in left half
                }
            }
        }
        return -1;
    }
}
// Time: O(log n)  |  Space: O(1)
```

### Problem 3 — Rotate String (LeetCode #796)

Given two strings `s` and `goal`, determine if `goal` is a rotation of `s`. The elegant one-liner checks whether `goal` is a substring of `s + s` — because concatenating `s` with itself contains every possible rotation as a contiguous substring. For example, `s = "abcde"`, `s + s = "abcdeabcde"`, and the rotation `"cdeab"` appears starting at index 2.

```java
// LeetCode #796 — Rotate String
class Solution {
    public boolean rotateString(String s, String goal) {
        return s.length() == goal.length()
            && (s + s).contains(goal);
    }
}
// Time: O(n) with KMP, O(n²) with naive contains  |  Space: O(n) for concatenation
```

---

## 8. Spiral Matrix

Spiral matrix problems ask you to traverse or fill a 2D matrix in a spiral order — starting from the top-left, going right across the top row, down the right column, left across the bottom row, and up the left column, then moving inward and repeating. The technique uses four boundary variables: `top`, `bottom`, `left`, and `right`. After traversing each edge, you shrink the corresponding boundary inward. The tricky part is handling the edge cases when only one row or one column remains in the innermost layer — you must check whether the boundary has been crossed before traversing the bottom row (leftward) or left column (upward), to avoid double-counting.

You use this pattern whenever a problem mentions "spiral order," "matrix in spiral form," or asks you to generate a matrix filled in spiral order (Spiral Matrix II). The time complexity is O(m × n) since every element is visited exactly once, and space is O(1) beyond the output.

```java
// Template: Spiral Matrix Traversal
public List<Integer> spiralOrder(int[][] matrix) {
    List<Integer> result = new ArrayList<>();
    if (matrix == null || matrix.length == 0) return result;
    int top = 0, bottom = matrix.length - 1;
    int left = 0, right = matrix[0].length - 1;
    while (top <= bottom && left <= right) {
        // Traverse right across the top row
        for (int col = left; col <= right; col++)
            result.add(matrix[top][col]);
        top++;
        // Traverse down the right column
        for (int row = top; row <= bottom; row++)
            result.add(matrix[row][right]);
        right--;
        // Traverse left across the bottom row (if any rows remain)
        if (top <= bottom) {
            for (int col = right; col >= left; col--)
                result.add(matrix[bottom][col]);
            bottom--;
        }
        // Traverse up the left column (if any columns remain)
        if (left <= right) {
            for (int row = bottom; row >= top; row--)
                result.add(matrix[row][left]);
            left++;
        }
    }
    return result;
}
```

The spiral traversal path for a 3×3 matrix:

```
Matrix:          Spiral order: 1 → 2 → 3 → 6 → 9 → 8 → 7 → 4 → 5

  [ 1  2  3 ]     Layer 1 (outer):
  [ 4  5  6 ]       → right:  1, 2, 3   (top row,    left→right)
  [ 7  8  9 ]       ↓ down:   6, 9      (right col,  top→bottom)
                    ← left:   8, 7      (bottom row, right→left)
                    ↑ up:     4         (left col,   bottom→top)
  Boundaries:     Layer 2 (inner):
  top=0,bot=2       → right:  5         (single cell, left→right)
  left=0,right=2

  After Layer 1: top=1, bottom=1, left=1, right=1
  After Layer 2: top=2, bottom=0 → loop ends

  Path traced:
  ┌─────→─────→─────┐
  │                 ↓
  ↑    ┌─────→─────┐ ↓
  │    │          │ ↓
  └────┘←─────←───┘↓
       ←─────←─────┘
```

### Problem 1 — Spiral Matrix (LeetCode #54)

Given an `m × n` matrix, return all elements in spiral order. The template above is the solution. The boundary checks (`if (top <= bottom)` and `if (left <= right)`) are critical — without them, a single remaining row or column would be traversed twice.

```java
// LeetCode #54 — Spiral Matrix
class Solution {
    public List<Integer> spiralOrder(int[][] matrix) {
        List<Integer> result = new ArrayList<>();
        if (matrix == null || matrix.length == 0) return result;
        int top = 0, bottom = matrix.length - 1;
        int left = 0, right = matrix[0].length - 1;
        while (top <= bottom && left <= right) {
            for (int c = left; c <= right; c++) result.add(matrix[top][c]);
            top++;
            for (int r = top; r <= bottom; r++) result.add(matrix[r][right]);
            right--;
            if (top <= bottom) {
                for (int c = right; c >= left; c--) result.add(matrix[bottom][c]);
                bottom--;
            }
            if (left <= right) {
                for (int r = bottom; r >= top; r--) result.add(matrix[r][left]);
                left++;
            }
        }
        return result;
    }
}
// Time: O(m × n)  |  Space: O(1) excluding output
```

### Problem 2 — Spiral Matrix II (LeetCode #59)

Given a positive integer `n`, generate an `n × n` matrix filled with elements from 1 to n² in spiral order. This is the reverse of Spiral Matrix — instead of reading, you write. The boundary logic is identical; you just write a counter instead of reading a value.

```java
// LeetCode #59 — Spiral Matrix II
class Solution {
    public int[][] generateMatrix(int n) {
        int[][] matrix = new int[n][n];
        int top = 0, bottom = n - 1, left = 0, right = n - 1;
        int num = 1;
        while (top <= bottom && left <= right) {
            for (int c = left; c <= right; c++) matrix[top][c] = num++;
            top++;
            for (int r = top; r <= bottom; r++) matrix[r][right] = num++;
            right--;
            if (top <= bottom) {
                for (int c = right; c >= left; c--) matrix[bottom][c] = num++;
                bottom--;
            }
            if (left <= right) {
                for (int r = bottom; r >= top; r--) matrix[r][left] = num++;
                left++;
            }
        }
        return matrix;
    }
}
// Time: O(n²)  |  Space: O(n²) for the output matrix
```

### Problem 3 — Rotate Image (LeetCode #48)

Rotate an `n × n` matrix 90 degrees clockwise in-place. This is related to spiral thinking but uses a two-step approach: transpose the matrix (swap `matrix[i][j]` with `matrix[j][i]` for `i < j`), then reverse each row. The transpose swaps rows and columns, and the row reversal reorders the elements to achieve the 90-degree rotation.

```java
// LeetCode #48 — Rotate Image
class Solution {
    public void rotate(int[][] matrix) {
        int n = matrix.length;
        // Step 1: Transpose (swap across the main diagonal)
        for (int i = 0; i < n; i++) {
            for (int j = i; j < n; j++) {
                int tmp = matrix[i][j];
                matrix[i][j] = matrix[j][i];
                matrix[j][i] = tmp;
            }
        }
        // Step 2: Reverse each row
        for (int i = 0; i < n; i++) {
            int lo = 0, hi = n - 1;
            while (lo < hi) {
                int tmp = matrix[i][lo];
                matrix[i][lo] = matrix[i][hi];
                matrix[i][hi] = tmp;
                lo++; hi--;
            }
        }
    }
}
// Time: O(n²)  |  Space: O(1)
//
// Visual:  Transpose then reverse rows = 90° clockwise
//   1 2 3      1 4 7      7 4 1
//   4 5 6  →   2 5 8  →   8 5 2
//   7 8 9      3 6 9      9 6 3
//   original    transposed  rotated 90° CW
```

---

## 9. Prefix and Suffix Arrays

The prefix/suffix technique precomputes two auxiliary arrays: one storing cumulative information from the left (prefix) and one from the right (suffix). The product of these arrays (or their combination) at each index gives the answer without needing division. This pattern is essential when a problem asks for a result at each index that depends on all other elements — for example, the product of all elements except the current one, or the amount of water trapped at each position.

The classic example is "Product of Array Except Self," where for each index you need the product of everything to its left multiplied by the product of everything to its right. The naive approach uses division (total product divided by each element), but that fails when zeroes are present and is often explicitly forbidden. The prefix/suffix approach computes a left product array and a right product array in two passes, then multiplies them element-wise. An optimised version uses the output array itself as the prefix array and a running suffix variable, achieving O(1) extra space.

```java
// Template: Prefix/Suffix Product (O(1) extra space beyond output)
public int[] productExceptSelf(int[] nums) {
    int n = nums.length;
    int[] result = new int[n];
    // Prefix pass: result[i] = product of all elements to the left of i
    result[0] = 1;
    for (int i = 1; i < n; i++) {
        result[i] = result[i - 1] * nums[i - 1];
    }
    // Suffix pass: multiply by running product of all elements to the right
    int suffix = 1;
    for (int i = n - 1; i >= 0; i--) {
        result[i] *= suffix;
        suffix *= nums[i];
    }
    return result;
}
```

The prefix/suffix computation for `nums = [2, 3, 4, 5]`:

```
Index:       0    1    2    3
nums:        2    3    4    5

Prefix (left products):
  prefix[0] = 1           (nothing to the left)
  prefix[1] = 1 × 2 = 2
  prefix[2] = 2 × 3 = 6
  prefix[3] = 6 × 4 = 24
  →  [1,  2,  6, 24]

Suffix (right products, computed as running variable):
  suffix[3] = 1           (nothing to the right)
  suffix[2] = 1 × 5 = 5
  suffix[1] = 5 × 4 = 20
  suffix[0] = 20 × 3 = 60
  →  [60, 20, 5, 1]

Result = prefix[i] × suffix[i]:
  [1×60, 2×20, 6×5, 24×1] = [60, 40, 30, 24]
  (product of all except self at each index ✓)
```

### Problem 1 — Product of Array Except Self (LeetCode #238)

Given an array `nums`, return an array where each element at index `i` is the product of all elements in `nums` except `nums[i]`, without using division and in O(n) time. The prefix/suffix approach is the intended solution.

```java
// LeetCode #238 — Product of Array Except Self
class Solution {
    public int[] productExceptSelf(int[] nums) {
        int n = nums.length;
        int[] answer = new int[n];
        // Prefix products: answer[i] = product of nums[0..i-1]
        answer[0] = 1;
        for (int i = 1; i < n; i++) {
            answer[i] = answer[i - 1] * nums[i - 1];
        }
        // Suffix products: multiply by product of nums[i+1..n-1]
        int suffix = 1;
        for (int i = n - 1; i >= 0; i--) {
            answer[i] *= suffix;
            suffix *= nums[i];
        }
        return answer;
    }
}
// Time: O(n)  |  Space: O(1) extra (output array doesn't count)
```

### Problem 2 — Trapping Rain Water (LeetCode #42) — Prefix/Suffix Approach

The prefix/suffix approach to Trapping Rain Water is more intuitive than the two-pointer approach, though it uses O(n) space. For each index, the water trapped is `min(leftMax[i], rightMax[i]) - height[i]`, where `leftMax[i]` is the tallest bar to the left of index `i` (including itself) and `rightMax[i]` is the tallest bar to the right. You precompute both arrays in two passes, then compute the total in a third pass.

```java
// LeetCode #42 — Trapping Rain Water (prefix/suffix max approach)
class Solution {
    public int trap(int[] height) {
        if (height == null || height.length < 3) return 0;
        int n = height.length;
        // leftMax[i] = tallest bar from 0 to i (inclusive)
        int[] leftMax = new int[n];
        leftMax[0] = height[0];
        for (int i = 1; i < n; i++) {
            leftMax[i] = Math.max(leftMax[i - 1], height[i]);
        }
        // rightMax[i] = tallest bar from i to n-1 (inclusive)
        int[] rightMax = new int[n];
        rightMax[n - 1] = height[n - 1];
        for (int i = n - 2; i >= 0; i--) {
            rightMax[i] = Math.max(rightMax[i + 1], height[i]);
        }
        // Water at index i = min(leftMax, rightMax) - height
        int water = 0;
        for (int i = 0; i < n; i++) {
            water += Math.min(leftMax[i], rightMax[i]) - height[i];
        }
        return water;
    }
}
// Time: O(n)  |  Space: O(n)
//
// Visual for [0,1,0,2,1,0,1,3,2,1,2,1]:
//   leftMax:  [0,1,1,2,2,2,2,3,3,3,3,3]
//   rightMax: [3,3,3,3,3,3,3,3,2,2,2,1]
//   min:      [0,1,1,2,2,2,2,3,2,2,2,1]
//   height:   [0,1,0,2,1,0,1,3,2,1,2,1]
//   water:    [0,0,1,0,1,2,1,0,0,1,0,0] → total = 6
```

### Problem 3 — Left and Right Sum Differences (LeetCode #2574)

Given a 0-indexed array, return an array where each element is the absolute difference between the sum of elements to the left and the sum of elements to the right of index `i`. This is a simpler prefix/suffix application that reinforces the pattern.

```java
// LeetCode #2574 — Left and Right Sum Differences
class Solution {
    public int[] leftRightDifference(int[] nums) {
        int n = nums.length;
        int[] leftSum = new int[n];
        int[] rightSum = new int[n];
        // Prefix sum from the left
        for (int i = 1; i < n; i++) {
            leftSum[i] = leftSum[i - 1] + nums[i - 1];
        }
        // Suffix sum from the right
        for (int i = n - 2; i >= 0; i--) {
            rightSum[i] = rightSum[i + 1] + nums[i + 1];
        }
        int[] answer = new int[n];
        for (int i = 0; i < n; i++) {
            answer[i] = Math.abs(leftSum[i] - rightSum[i]);
        }
        return answer;
    }
}
// Time: O(n)  |  Space: O(n)
```

---

## 10. Difference Arrays

The difference array technique is the inverse of the prefix sum — it is designed for range update problems where you need to add a constant value to every element in a range `[l, r]` efficiently, and then reconstruct the final array. Instead of updating every element in the range (which would be O(n) per update), you record the update as two single-cell changes: `diff[l] += val` and `diff[r+1] -= val`. After all updates, you compute the prefix sum of the difference array to recover the actual values.

This pattern shines when you have many range updates and want to batch them. Each update is O(1), and the final reconstruction is a single O(n) prefix sum pass. Without the difference array, `k` range updates on an array of size `n` would cost O(k × n); with it, the cost is O(k + n). The technique is a staple in problems involving interval scheduling, flight bookings, or any scenario where ranges receive additive adjustments.

```java
// Template: Difference Array for range updates
public int[] rangeAdd(int n, int[][] updates) {
    int[] diff = new int[n + 1]; // extra cell for r+1 boundary
    for (int[] update : updates) {
        int l = update[0], r = update[1], val = update[2];
        diff[l] += val;       // start adding val from index l
        diff[r + 1] -= val;   // stop adding val after index r
    }
    // Reconstruct the array via prefix sum
    int[] result = new int[n];
    int running = 0;
    for (int i = 0; i < n; i++) {
        running += diff[i];
        result[i] = running;
    }
    return result;
}
```

The difference array mechanics for applying `[[1, 3, 2], [2, 4, 3], [0, 2, -1]]` to an array of size 5:

```
n = 5, updates: add 2 to [1,3], add 3 to [2,4], add -1 to [0,2]

Step 1 — Record updates in diff[]:
  Initial diff:   [ 0  0  0  0  0  0 ]   (size n+1 = 6)
  After [1,3,2]:  [ 0  2  0  0 -2  0 ]   (diff[1]+=2, diff[4]-=2)
  After [2,4,3]:  [ 0  2  3  0 -2 -3 ]   (diff[2]+=3, diff[5]-=3)
  After [0,2,-1]: [-1  2  3  0 -2 -3 ]   (diff[0]+=-1, diff[3]-=-1 → +1)
  Wait: diff[3] -= (-1) → diff[3] += 1
  Corrected:      [-1  2  3  1 -2 -3 ]

Step 2 — Prefix sum to reconstruct:
  running = 0
  i=0: running = 0 + (-1) = -1  → result[0] = -1
  i=1: running = -1 + 2   =  1  → result[1] =  1
  i=2: running = 1 + 3    =  4  → result[2] =  4
  i=3: running = 4 + 1    =  5  → result[3] =  5
  i=4: running = 5 + (-2) =  3  → result[4] =  3

Result: [-1, 1, 4, 5, 3]
  (index 0: only -1 applies)
  (index 1: -1+2 = 1)
  (index 2: -1+2+3 = 4)
  (index 3: 2+3 = 5)
  (index 4: 3 = 3)
```

### Problem 1 — Range Addition (LeetCode #370)

You are given an array of length `n` initialised to zeros and a list of updates where each update adds a value to a range of indices. Return the modified array after all updates. This is the textbook difference array problem.

```java
// LeetCode #370 — Range Addition
class Solution {
    public int[] getModifiedArray(int length, int[][] updates) {
        int[] diff = new int[length + 1]; // extra cell for r+1
        for (int[] u : updates) {
            int start = u[0], end = u[1], inc = u[2];
            diff[start] += inc;
            diff[end + 1] -= inc;
        }
        int[] result = new int[length];
        int running = 0;
        for (int i = 0; i < length; i++) {
            running += diff[i];
            result[i] = running;
        }
        return result;
    }
}
// Time: O(n + k) where k = number of updates  |  Space: O(n)
```

### Problem 2 — Corporate Flight Bookings (LeetCode #1109)

There are `n` flights labelled 1 to n. You are given a list of bookings where each booking `[first, last, seats]` reserves `seats` on all flights from `first` to `last` inclusive. Return an array of total seats booked for each flight. This is a difference array problem with 1-indexed input that you convert to 0-indexed.

```java
// LeetCode #1109 — Corporate Flight Bookings
class Solution {
    public int[] corpFlightBookings(int[][] bookings, int n) {
        int[] diff = new int[n + 1]; // 1-indexed, extra cell for boundary
        for (int[] booking : bookings) {
            int first = booking[0], last = booking[1], seats = booking[2];
            diff[first] += seats;       // 1-indexed: add at first
            diff[last + 1] -= seats;    // subtract after last
        }
        int[] answer = new int[n];
        int running = 0;
        for (int i = 1; i <= n; i++) {
            running += diff[i];
            answer[i - 1] = running;    // convert back to 0-indexed output
        }
        return answer;
    }
}
// Time: O(n + k)  |  Space: O(n)
```

### Problem 3 — Car Pooling (LeetCode #1094)

A car drives east picking up and dropping off passengers. Given `trips` where each trip is `[numPassengers, fromLocation, toLocation]`, determine if the car can complete all trips without exceeding its `capacity`. This is a difference array problem: for each trip, passengers are added at `from` and removed at `to`. After building the difference array and computing the prefix sum, if any point exceeds capacity, return false.

```java
// LeetCode #1094 — Car Pooling
class Solution {
    public boolean carPooling(int[][] trips, int capacity) {
        // Find the maximum location to size the diff array
        int maxLocation = 0;
        for (int[] trip : trips) {
            maxLocation = Math.max(maxLocation, trip[2]);
        }
        int[] diff = new int[maxLocation + 1];
        for (int[] trip : trips) {
            int passengers = trip[0], from = trip[1], to = trip[2];
            diff[from] += passengers;  // passengers board at 'from'
            diff[to] -= passengers;    // passengers leave at 'to'
        }
        int running = 0;
        for (int i = 0; i <= maxLocation; i++) {
            running += diff[i];
            if (running > capacity) {
                return false; // over capacity at some point
            }
        }
        return true;
    }
}
// Time: O(n + L) where L = max location  |  Space: O(L)
```

---

## Pattern Recognition Table

The table below maps common keywords and phrases in problem statements to the pattern you should immediately consider. When you read a problem, scan for these keywords — they are strong signals that a particular technique applies. Note that some problems combine multiple patterns (for example, "3Sum" uses sorting plus two pointers, and "Trapping Rain Water" can be solved with either two pointers or prefix/suffix arrays), so use the table as a starting point and be ready to adapt.

```
┌─────────────────────────────────────────┬──────────────────────────────────────────┬───────────────┐
│ Problem Keyword / Phrase                │ Pattern to Use                           │ Complexity    │
├─────────────────────────────────────────┼──────────────────────────────────────────┼───────────────┤
│ "pair that sums to target" (sorted)     │ Two Pointers — Opposite Direction        │ O(n)          │
│ "two sum" (unsorted)                    │ Hash Map                                 │ O(n)          │
│ "container / area / water between lines"│ Two Pointers — Opposite Direction        │ O(n)          │
│ "trapping rain water"                   │ Two Pointers OR Prefix/Suffix Max        │ O(n)          │
│ "is palindrome"                         │ Two Pointers — Opposite Direction        │ O(n)          │
│ "longest palindromic substring"         │ Expand Around Centre                     │ O(n²)         │
│ "remove duplicates in-place"            │ Two Pointers — Same Direction            │ O(n)          │
│ "move zeroes to end"                    │ Two Pointers — Same Direction            │ O(n)          │
│ "partition / segregate"                 │ Two Pointers — Same Direction            │ O(n)          │
│ "sort three colours / 0,1,2"            │ Dutch National Flag (3-way partition)    │ O(n)          │
│ "3Sum / 4Sum"                           │ Sort + Two Pointers (Opposite)           │ O(n²)/O(n³)   │
│ "longest/shortest subarray with..."     │ Sliding Window (same-direction pointers) │ O(n)          │
│ "longest substring without repeat"      │ Sliding Window + HashSet/HashMap         │ O(n)          │
│ "subarray sum equals K"                 │ Prefix Sum + HashMap                     │ O(n)          │
│ "range sum query"                       │ Prefix Sum Array                         │ O(1) per query│
│ "maximum subarray sum"                  │ Kadane's Algorithm                       │ O(n)          │
│ "maximum subarray product"              │ Kadane's Variant (track min & max)       │ O(n)          │
│ "best time to buy and sell stock"       │ Kadane's Variant (running min)           │ O(n)          │
│ "product of all except self"            │ Prefix + Suffix Arrays                   │ O(n)          │
│ "rotate array by k"                     │ Three Reversals                          │ O(n)          │
│ "search in rotated sorted array"        │ Modified Binary Search                   │ O(log n)      │
│ "rotate string"                         │ Concatenation + Substring Check          │ O(n)          │
│ "spiral order / spiral matrix"          │ Four-Boundary Spiral Traversal           │ O(m×n)        │
│ "rotate image 90 degrees"               │ Transpose + Reverse Rows                 │ O(n²)         │
│ "is anagram"                            │ Character Frequency Count                │ O(n)          │
│ "group anagrams"                        │ Sort String as Key + HashMap              │ O(n·k log k)  │
│ "reverse words in string"               │ Reverse All + Reverse Each Word          │ O(n)          │
│ "range addition / add to range"         │ Difference Array                         │ O(n + k)      │
│ "flight bookings / intervals overlap"   │ Difference Array                         │ O(n + k)      │
│ "car pooling / capacity check"          │ Difference Array + Prefix Sum Check      │ O(n + L)      │
│ "equilibrium / pivot index"             │ Prefix Sum                               │ O(n)          │
│ "merge two sorted arrays"               │ Two Pointers — Same Direction            │ O(n + m)      │
│ "interval problems"                     │ Sort + Greedy / Sweep Line               │ O(n log n)    │
│ "kth largest / smallest"                │ Heap (Priority Queue) or QuickSelect     │ O(n)/O(n log k)│
│ "find duplicate / missing number"       │ XOR, Floyd's Cycle, or Frequency Array   │ O(n)          │
│ "subarray with given sum (non-neg)"     │ Sliding Window                           │ O(n)          │
│ "continuous subarray sum (multiple of k)"│ Prefix Sum + HashMap (modular)          │ O(n)          │
└─────────────────────────────────────────┴──────────────────────────────────────────┴───────────────┘
```

---

## Quick Reference — When to Reach for Each Pattern

- **Two Pointers (Opposite):** The array is sorted or has a monotonic property, and you need to find a pair, compute an area, or check a palindrome. Two pointers start at opposite ends and converge.
- **Two Pointers (Same Direction):** You need in-place compaction (remove duplicates, move zeroes), partitioning, or a sliding window. The slow pointer marks the result boundary; the fast pointer scans.
- **Sliding Window:** The problem asks for the longest or shortest subarray/substring satisfying a constraint, and the constraint is monotonic (expanding makes it "worse" or "better" predictably). Use same-direction pointers with a running state.
- **Prefix Sum:** You need range sum queries, subarray sums, or an equilibrium/pivot index. Precompute cumulative sums for O(1) queries.
- **Prefix Sum + HashMap:** You need to count subarrays with a given sum or a sum satisfying a modular condition. Store prefix sums in a map and look up complements.
- **Kadane's Algorithm:** You need the maximum (or minimum) sum of a contiguous subarray. Track the running sum, resetting when it turns negative.
- **Dutch National Flag:** You need to sort or partition an array with exactly three distinct values in one pass with O(1) space. Three pointers create three regions.
- **String — Palindrome:** Compare characters from both ends inward, skipping non-alphanumeric characters for sentence inputs. For longest palindrome, expand around each centre.
- **String — Anagram:** Compare character frequency counts. Two strings are anagrams if and only if their frequency arrays are identical.
- **String — Reverse Words:** Reverse the entire string, then reverse each word. Or split on whitespace and rebuild in reverse order.
- **Rotation (Three Reversals):** You need to rotate an array in-place. Reverse all, reverse first k, reverse remaining. Normalise k modulo n.
- **Rotation (Binary Search):** The array is sorted but rotated; you need to search it. Determine which half is sorted at each step to direct the search.
- **Spiral Matrix:** You need to traverse or fill a 2D matrix in spiral order. Four boundary variables (top, bottom, left, right) shrink inward after each edge.
- **Prefix/Suffix Arrays:** You need a per-index result that depends on all other elements (product except self, water trapped, left/right sum differences). Precompute from both ends.
- **Difference Array:** You have many range updates (add a value to a range) and need the final array. Record each update as two O(1) changes, then prefix-sum to reconstruct.

Mastering these patterns is less about memorising code and more about building the reflex to recognise which pattern a problem calls for. When you see "sorted array" and "pair," think two pointers. When you see "subarray sum," think prefix sum. When you see "maximum subarray," think Kadane. When you see "three values to sort," think Dutch flag. When you see "spiral," think four boundaries. When you see "range update," think difference array. Practice each pattern until the recognition is automatic — that is the difference between solving a problem in five minutes and struggling for thirty.

The LeetCode problems referenced throughout this guide are: #1 Two Sum, #3 Longest Substring Without Repeating Characters, #5 Longest Palindromic Substring, #11 Container With Most Water, #15 3Sum, #26 Remove Duplicates from Sorted Array, #283 Move Zeroes, #33 Search in Rotated Sorted Array, #42 Trapping Rain Water, #48 Rotate Image, #53 Maximum Subarray, #54 Spiral Matrix, #75 Sort Colors, #121 Best Time to Buy and Sell Stock, #125 Valid Palindrome, #151 Reverse Words in a String, #152 Maximum Product Subarray, #189 Rotate Array, #238 Product of Array Except Self, #242 Valid Anagram, #303 Range Sum Query Immutable, #370 Range Addition, #560 Subarray Sum Equals K, #724 Find Pivot Index, #796 Rotate String, #905 Sort Array By Parity, #1094 Car Pooling, #1109 Corporate Flight Bookings, #2574 Left and Right Sum Differences. Work through them in the order presented — each builds on the previous pattern, and by the end you will have covered every major array and string technique that interviews test.

## Interview Cheat Sheet

**Key Points to Remember:**
- Two pointers (opposite direction): sorted array two-sum, palindrome check.
- Two pointers (same direction): sliding window, remove duplicates.
- Prefix sum: precompute cumulative sums for O(1) range sum queries.
- Kadane's: track current max and global max, reset current to 0 if negative.
- Dutch National Flag: three-way partition with three pointers (low, mid, high).

**Common Follow-Up Questions:**
- **When to use two pointers vs hash map for two-sum?** — Sorted array → two pointers (O(n), O(1) space). Unsorted → hash map (O(n), O(n) space).
- **How do prefix sums handle updates?** — For static arrays, prefix sum is O(1) query. For dynamic updates, use a Fenwick tree (BIT) or segment tree instead.

**Gotcha:**
- Off-by-one errors in prefix sums. sum(i, j) = prefix[j+1] - prefix[i], NOT prefix[j] - prefix[i]. The +1 accounts for the prefix array being 1-indexed (prefix[0] = 0).
