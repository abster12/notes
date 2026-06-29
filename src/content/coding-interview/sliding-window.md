---
title: "Sliding Window — Coding Interview Prep"
date: 2026-06-19
tags: [coding-interview, sliding-window, java, algorithms, two-pointers]
category: Coding Interview Prep
difficulty: Medium
estimated_reading_time: 45
---

# Sliding Window — Master Guide

The sliding window is one of the most frequently tested patterns in coding interviews. It converts nested O(n^2) or O(n^3) loops over contiguous subarrays/substrings into a single O(n) pass by reusing computation from the previous window instead of recomputing from scratch. Master this pattern and a large family of "subarray / substring with constraint" problems becomes mechanical.

---

## Summary & Interview Framing

A pattern that converts nested O(n²) loops over contiguous subarrays/substrings into O(n) by maintaining running window state.

**How it's asked:** "Longest substring without repeating characters, minimum window substring, max consecutive ones III, subarrays with K different integers — 'contiguous subarray/substring with constraint.'"

---

## 1. Core Idea

A window is a contiguous range [left, right] over an array or string. As the window slides to the right, you:

1. Add the new element entering on the right.
2. Remove the element leaving on the left (if the window is fixed-size, or when shrinking a variable window).
3. Update the answer using the running state (sum, count, frequency map, deque, etc.).

The key insight: **never recompute the window's state from scratch**. Carry it forward incrementally.

### When to suspect sliding window

- "Find the longest / shortest / maximum / minimum contiguous subarray or substring such that ..."
- "Number of subarrays with sum exactly / at most K"
- "Substring containing all characters of another string"
- "Maximum in every window of size K"
- A brute force solution involves two nested loops where the inner loop scans a contiguous chunk

If the problem asks about subsequences (not contiguous) or needs a global sort, sliding window is usually NOT the right tool.

---

## 2. Two Flavors: Fixed-Size vs Variable-Size

### Fixed-Size Window

The window width K is given. Slide it left to right one index at a time. Every step removes `arr[left]` and adds `arr[right]`. Answer is the best state seen across all windows.

Typical problems:
- Maximum sum subarray of size K
- Average of each window of size K
- Permutation in String (window of size len(pattern))
- Find All Anagrams in a String (window of size len(p))
- Sliding Window Maximum / Median

### Variable-Size Window

K is unknown; you are optimizing the window's length or counting windows that satisfy a constraint. The window expands by moving `right` and contracts by moving `left` until the constraint is satisfied again. Two sub-patterns:

- **Longest valid window** — expand aggressively, shrink only when invalid, track max length.
- **Shortest valid window** — expand until valid, then shrink as much as possible while staying valid, track min length.
- **Count windows with at-most-K constraint** — use the identity `exactly(K) = atMost(K) - atMost(K-1)`.

Typical problems:
- Longest Substring Without Repeating Characters
- Minimum Window Substring
- Longest Repeating Character Replacement
- Max Consecutive Ones III
- Fruits into Baskets
- Subarrays with K Different Integers
- Longest Substring with At Most K Distinct Characters

---

## 3. ASCII Diagram: Fixed Window Slide

```
Array:  [ 2, 1, 5, 1, 3, 2 ]     K = 3

Step 0 (form first window, sum = 2+1+5 = 8):
 index:   0  1  2  3  4  5
        [ 2  1  5  1  3  2 ]
         ^^^^^^^
         left=0 right=2      maxSum = 8

Step 1 (slide right by 1):
        [ 2  1  5  1  3  2 ]
               .  ^^^^^^^
            remove 1 (idx0), add 1 (idx3)
            left=1 right=3      sum = 8 - 2 + 1 = 7   maxSum = 8

Step 2 (slide right by 1):
        [ 2  1  5  1  3  2 ]
                     ^^^^^^^
            remove 1 (idx1), add 3 (idx4)
            left=2 right=4      sum = 7 - 1 + 3 = 9   maxSum = 9

Step 3 (slide right by 1):
        [ 2  1  5  1  3  2 ]
                        ^^^^^^^
            remove 5 (idx2), add 2 (idx5)
            left=3 right=5      sum = 9 - 5 + 2 = 6   maxSum = 9

Result: maxSum = 9  (window [5,1,3])
```

The work per slide is O(1): one subtraction and one addition. Total O(n) instead of O(n*K).

---

## 4. ASCII Diagram: Variable Window Expand/Contract

Using "Longest Substring Without Repeating Characters" on `s = "abcabcbb"`:

```
s = a b c a b c b b
i:  0 1 2 3 4 5 6 7

Legend:  R = right (expand),  L = left (shrink),  [L..R] = current window

R=0:  [a]                L=0 R=0  valid, len=1
R=1:  [a b]              L=0 R=1  valid, len=2
R=2:  [a b c]            L=0 R=2  valid, len=3   best=3
R=3:  [a b c a]  DUPLICATE 'a'
        shrink: L 0->1   [b c a]   valid, len=3
R=4:  [b c a b]  DUPLICATE 'b'
        shrink: L 1->2   [c a b]   valid, len=3
R=5:  [c a b c]  DUPLICATE 'c'
        shrink: L 2->3   [a b c]   valid, len=3
R=6:  [a b c b]  DUPLICATE 'b'
        shrink: L 3->4   [c b]     valid, len=2
        shrink: L 4->5   [b]       (if needed)     -> actually [c b] fine
R=7:  [c b b]  DUPLICATE 'b'
        shrink: L 5->6   [b]       valid, len=1

Best overall = 3  ("abc" or "bca" or "cab")

Visual of expand/contract motion:

      expand ---->
  L_________________________
  |  [===window===]
  |       shrink <---- (when invalid)
  v
```

The general motion: `right` always marches forward (never decreases). `left` only moves forward when the window becomes invalid, contracting until valid again. Both pointers travel at most n steps → O(n).

---

## 5. Template Comparison Table

| Aspect | Fixed-Size Window | Variable-Size Window (longest) | Variable-Size Window (shortest) |
|---|---|---|---|
| Window size | Known K | Unknown, maximize | Unknown, minimize |
| Outer loop | right from K-1 to n-1 (after first window) | right from 0 to n-1 | right from 0 to n-1 |
| Inner action | subtract arr[right-K], add arr[right] | while invalid: remove arr[left], left++ | while valid: remove arr[left], left++ |
| Answer update | every window | when valid, max = max(max, right-left+1) | when valid, min = min(min, right-left+1) |
| Termination | right reaches end | right reaches end | right reaches end |
| Complexity | O(n) time, O(1) extra (or O(K)) | O(n) time, O(alphabet) extra | O(n) time, O(alphabet) extra |
| Key invariant | window size == K | window always valid after inner loop | window as small as possible while valid |
| Typical state | running sum / count | frequency map / set / counter | frequency map / counter |
| Examples | Max sum size K, Average K, Anagrams | Longest no-repeat, Longest Repeating Replacement, Fruits in Baskets | Min Window Substring, Min Size Subarray Sum |

---

## 6. Fixed-Size Window Problems

### 6.1 Maximum Sum Subarray of Size K

Given an array of integers and an integer K, find the maximum sum of any contiguous subarray of size K.

Brute force: check every starting index, sum K elements → O(n*K). Sliding window: O(n).

#### Java Solution

```java
public class MaxSumSubarraySizeK {
    public static int maxSum(int[] arr, int k) {
        if (arr == null || arr.length < k || k <= 0) return 0;

        // 1. Build first window of size k
        int windowSum = 0;
        for (int i = 0; i < k; i++) windowSum += arr[i];
        int maxSum = windowSum;

        // 2. Slide the window one step at a time
        for (int right = k; right < arr.length; right++) {
            windowSum += arr[right] - arr[right - k]; // add new, drop old
            maxSum = Math.max(maxSum, windowSum);
        }
        return maxSum;
    }

    public static void main(String[] args) {
        System.out.println(maxSum(new int[]{2, 1, 5, 1, 3, 2}, 3)); // 9
        System.out.println(maxSum(new int[]{2, 3, 4, 1, 5}, 2));    // 7
    }
}
```

**Complexity:** O(n) time, O(1) space.

### 6.2 Average of Each Window of Size K (conceptual)

Same skeleton, but instead of tracking `max`, push `windowSum / (double) k` into a result list at every position. Return the list of averages. Useful when the interviewer asks "given stream / array, return rolling average."

```java
public static double[] averages(int[] arr, int k) {
    double[] res = new double[arr.length - k + 1];
    int sum = 0;
    for (int i = 0; i < k; i++) sum += arr[i];
    res[0] = sum / (double) k;
    for (int i = k; i < arr.length; i++) {
        sum += arr[i] - arr[i - k];
        res[i - k + 1] = sum / (double) k;
    }
    return res;
}
```

### 6.3 Find All Anagrams in a String (conceptual)

LeetCode 438. Fixed window of size `p.length()` sliding over `s`. Maintain frequency counts of the window and compare against `p`'s frequency counts. Optimization: track a `matches` counter of how many characters have equal counts, so each slide is O(1) update with O(alphabet) check avoided. Return starting indices where the window is an anagram.

### 6.4 Permutation in String (LeetCode 567) — full solution below in section 9.

---

## 7. Variable-Size Window Problems

### 7.1 Longest Substring Without Repeating Characters (LeetCode 3)

Find the length of the longest substring with all distinct characters.

Approach: expand `right`, track last-seen index of each character. When `s[right]` was seen at index >= `left`, jump `left` to `seen + 1` (no need to shrink one-by-one). Track max length.

#### Java Solution

```java
public class LongestSubstringNoRepeat {
    public int lengthOfLongestSubstring(String s) {
        if (s == null || s.length() == 0) return 0;
        int[] lastSeen = new int[128]; // ASCII; -1 means unseen
        for (int i = 0; i < 128; i++) lastSeen[i] = -1;

        int left = 0, maxLen = 0;
        for (int right = 0; right < s.length(); right++) {
            char c = s.charAt(right);
            if (lastSeen[c] >= left) {
                // duplicate inside current window -> jump left
                left = lastSeen[c] + 1;
            }
            lastSeen[c] = right;
            maxLen = Math.max(maxLen, right - left + 1);
        }
        return maxLen;
    }

    public static void main(String[] args) {
        LongestSubstringNoRepeat sol = new LongestSubstringNoRepeat();
        System.out.println(sol.lengthOfLongestSubstring("abcabcbb")); // 3
        System.out.println(sol.lengthOfLongestSubstring("bbbbb"));    // 1
        System.out.println(sol.lengthOfLongestSubstring("pwwkew"));   // 4
    }
}
```

**Why `lastSeen[c] >= left`?** A character may have appeared earlier in the string but outside the current window (index < left). That stale sighting is irrelevant; only repeats inside [left, right] force a contraction.

**Complexity:** O(n) time, O(1) space (alphabet of 128).

### 7.2 Minimum Window Substring (LeetCode 76)

Given strings `s` and `t`, return the minimum-length substring of `s` that contains every character of `t` (including duplicates). Empty string if none.

Approach: variable window, "shortest valid" flavor. Build a required frequency map for `t`. Expand `right` to include characters; when all required characters are matched, try to shrink `left` as much as possible while still valid, updating the best substring. Use a `formed` counter tracking how many unique characters have met their required count.

#### Java Solution

```java
import java.util.HashMap;
import java.util.Map;

public class MinimumWindowSubstring {
    public String minWindow(String s, String t) {
        if (s == null || t == null || s.length() < t.length()) return "";

        // frequency required for each char in t
        Map<Character, Integer> need = new HashMap<>();
        for (char c : t.toCharArray()) need.merge(c, 1, Integer::sum);

        Map<Character, Integer> have = new HashMap<>();
        int left = 0, formed = 0, required = need.size();
        int minLen = Integer.MAX_VALUE, minStart = 0;

        for (int right = 0; right < s.length(); right++) {
            char c = s.charAt(right);
            have.merge(c, 1, Integer::sum);

            // if this char's count now meets the requirement, increment formed
            if (need.containsKey(c) && have.get(c).intValue() == need.get(c).intValue()) {
                formed++;
            }

            // try to shrink the window while it remains valid
            while (formed == required && left <= right) {
                if (right - left + 1 < minLen) {
                    minLen = right - left + 1;
                    minStart = left;
                }
                char out = s.charAt(left);
                have.merge(out, -1, Integer::sum);
                if (need.containsKey(out) && have.get(out) < need.get(out)) {
                    formed--;  // window no longer satisfies this char
                }
                left++;
            }
        }
        return minLen == Integer.MAX_VALUE ? "" : s.substring(minStart, minStart + minLen);
    }

    public static void main(String[] args) {
        MinimumWindowSubstring sol = new MinimumWindowSubstring();
        System.out.println(sol.minWindow("ADOBECODEBANC", "ABC")); // "BANC"
        System.out.println(sol.minWindow("a", "a"));               // "a"
        System.out.println(sol.minWindow("a", "aa"));              // ""
    }
}
```

**Complexity:** O(n + m) time, O(alphabet) space.

### 7.3 Longest Repeating Character Replacement (LeetCode 424)

Given a string `s` and integer `k`, find the length of the longest substring containing the same letter after performing at most `k` character replacements.

Key insight: a window [left, right] can become all-one-letter with at most `k` changes if and only if

```
windowLength - maxCharCountInWindow <= k
```

You do not need to know WHICH letter is the majority — just the max frequency inside the window. And because `maxFreq` only ever increases (we never recompute it on shrink — see note below), the condition simplifies to "expand when valid, shrink when invalid."

#### Java Solution

```java
public class LongestRepeatingCharacterReplacement {
    public int characterReplacement(String s, int k) {
        int[] count = new int[26];
        int left = 0, maxFreq = 0, maxLen = 0;

        for (int right = 0; right < s.length(); right++) {
            char c = s.charAt(right);
            count[c - 'A']++;
            maxFreq = Math.max(maxFreq, count[c - 'A']);

            // window is invalid if changes needed > k
            while ((right - left + 1) - maxFreq > k) {
                count[s.charAt(left) - 'A']--;
                left++;
                // Note: we do NOT recompute maxFreq here. See explanation.
            }
            maxLen = Math.max(maxLen, right - left + 1);
        }
        return maxLen;
    }

    public static void main(String[] args) {
        LongestRepeatingCharacterReplacement sol = new LongestRepeatingCharacterReplacement();
        System.out.println(sol.characterReplacement("ABAB", 2));      // 4
        System.out.println(sol.characterReplacement("AABABBA", 1));  // 4
    }
}
```

**Why not recompute `maxFreq` on shrink?** `maxFreq` represents the best majority count seen so far in any window. A larger window than the current best can only exist if its `maxFreq` is at least as large as the current best's `maxFreq`. So overestimating `maxFreq` is safe — it just makes the validity test stricter, never lax. This keeps the loop O(n). A correct but slower version would recompute `maxFreq` by scanning `count` each shrink, giving O(26n) = still O(n) but with a constant. The trick above is the standard accepted optimization.

**Complexity:** O(n) time, O(1) space (26 letters).

### 7.4 Max Consecutive Ones III (LeetCode 1004)

Given a binary array, return the maximum number of consecutive 1s if you may flip at most `k` zeros to 1.

This is structurally identical to 424: "longest window where (count of zeros) <= k." Track zero count; when it exceeds `k`, shrink `left` until zeros <= k again.

#### Java Solution

```java
public class MaxConsecutiveOnesIII {
    public int longestOnes(int[] nums, int k) {
        int left = 0, zeros = 0, maxLen = 0;
        for (int right = 0; right < nums.length; right++) {
            if (nums[right] == 0) zeros++;

            while (zeros > k) {
                if (nums[left] == 0) zeros--;
                left++;
            }
            maxLen = Math.max(maxLen, right - left + 1);
        }
        return maxLen;
    }

    public static void main(String[] args) {
        MaxConsecutiveOnesIII sol = new MaxConsecutiveOnesIII();
        System.out.println(sol.longestOnes(new int[]{1,1,1,0,0,0,1,1,1,1,0}, 2)); // 6
        System.out.println(sol.longestOnes(new int[]{0,0,1,1,0,0,1,1,1,0,1,1,0,0,0,1,1,1,1}, 3)); // 10
    }
}
```

**Complexity:** O(n) time, O(1) space.

### 7.5 Fruits into Baskets (LeetCode 904)

You have two baskets, each can hold only one type of fruit. Given an array where `fruits[i]` is the type of the i-th tree, find the maximum number of fruits you can pick from a contiguous sequence of trees (i.e., longest subarray with at most 2 distinct values).

This is "longest substring with at most K distinct characters" with K = 2.

#### Java Solution

```java
import java.util.HashMap;
import java.util.Map;

public class FruitsIntoBaskets {
    public int totalFruit(int[] fruits) {
        Map<Integer, Integer> count = new HashMap<>();
        int left = 0, maxLen = 0;
        for (int right = 0; right < fruits.length; right++) {
            count.merge(fruits[right], 1, Integer::sum);

            while (count.size() > 2) {
                count.merge(fruits[left], -1, Integer::sum);
                if (count.get(fruits[left]) == 0) count.remove(fruits[left]);
                left++;
            }
            maxLen = Math.max(maxLen, right - left + 1);
        }
        return maxLen;
    }

    public static void main(String[] args) {
        FruitsIntoBaskets sol = new FruitsIntoBaskets();
        System.out.println(sol.totalFruit(new int[]{1,2,1}));         // 3
        System.out.println(sol.totalFruit(new int[]{0,1,2,2}));       // 3
        System.out.println(sol.totalFruit(new int[]{1,2,3,2,2}));     // 4
    }
}
```

**Complexity:** O(n) time, O(1) space (map holds at most 3 keys).

---

## 8. Sliding Window Maximum (LeetCode 239) — Deque

Return an array of the maximum of every contiguous subarray of size `k`.

A naive approach recomputes the max in each window → O(n*k). The optimal approach uses a **monotonic decreasing deque** storing indices, giving O(n).

### ASCII Diagram: Deque for Sliding Window Max

```
Array:  [ 1, 3, -1, -3, 5, 3, 6, 7 ]   k = 3

Deque holds INDICES, values decreasing from front to back.
Front of deque = index of max in current window.

Step: right=0  add 0(1)        deque: [0]            window: [1]            (forming)
Step: right=1  add 1(3)
        pop back while smaller: pop 0 (1<3)
        deque: [1]              window: [1,3]        (forming)
Step: right=2  add 2(-1)
        -1 < 3, keep it
        deque: [1,2]            window: [1,3,-1]     -> max = arr[1] = 3   OUTPUT 3
Step: right=3  add 3(-3)
        deque: [1,2,3]          window: [3,-1,-3]    -> max = arr[1] = 3   OUTPUT 3
        (no front expired: 1 >= 3-3+1=1)
Step: right=4  add 4(5)
        pop 3(-3), pop 2(-1), pop 1(3): all smaller than 5
        deque: [4]              window: [-1,-3,5]    -> max = arr[4] = 5   OUTPUT 5
Step: right=5  add 5(3)         deque: [4,5]         window: [-3,5,3]      -> 5     OUTPUT 5
Step: right=6  add 6(6)
        pop 5(3), pop 4(5)
        deque: [6]              window: [5,3,6]      -> 6                  OUTPUT 6
Step: right=7  add 7(7)
        pop 6(6)
        deque: [7]              window: [3,6,7]      -> 7                  OUTPUT 7

Result: [3, 3, 5, 5, 6, 7]
```

Two rules keep the deque correct:

1. **Maintain decreasing order:** before pushing index `i`, pop from the back all indices whose values are <= `arr[i]` (they can never be the max in any future window that includes `i`).
2. **Evict expired front:** if `deque.peekFirst() <= right - k`, the front index is outside the current window — pop it from the front.

#### Java Solution

```java
import java.util.ArrayDeque;
import java.util.Deque;

public class SlidingWindowMaximum {
    public int[] maxSlidingWindow(int[] nums, int k) {
        if (nums == null || k <= 0) return new int[0];
        int n = nums.length;
        int[] result = new int[n - k + 1];
        Deque<Integer> dq = new ArrayDeque<>(); // stores indices, values decreasing

        for (int right = 0; right < n; right++) {
            // 1. Remove indices that are out of the current window (from front)
            while (!dq.isEmpty() && dq.peekFirst() <= right - k) {
                dq.pollFirst();
            }
            // 2. Maintain decreasing order: remove from back all smaller values
            while (!dq.isEmpty() && nums[dq.peekLast()] <= nums[right]) {
                dq.pollLast();
            }
            // 3. Add current index
            dq.offerLast(right);

            // 4. Once the first window is formed, record max (front of deque)
            if (right >= k - 1) {
                result[right - k + 1] = nums[dq.peekFirst()];
            }
        }
        return result;
    }

    public static void main(String[] args) {
        SlidingWindowMaximum sol = new SlidingWindowMaximum();
        int[] r = sol.maxSlidingWindow(new int[]{1,3,-1,-3,5,3,6,7}, 3);
        for (int x : r) System.out.print(x + " "); // 3 3 5 5 6 7
    }
}
```

**Complexity:** O(n) time — each index is pushed and popped at most once. O(k) space for the deque.

---

## 9. Permutation in String (LeetCode 567)

Given strings `s1` and `s2`, return true if `s2` contains a permutation of `s1` as a substring.

Fixed window of size `s1.length()` over `s2`. Maintain frequency counts and a `matches` counter of how many characters currently have equal counts in the window and in `s1`. When `matches == 26`-ish (or equal to the number of distinct chars in s1), return true.

#### Java Solution

```java
public class PermutationInString {
    public boolean checkInclusion(String s1, String s2) {
        if (s1.length() > s2.length()) return false;

        int[] need = new int[26];
        int[] have = new int[26];
        for (char c : s1.toCharArray()) need[c - 'a']++;

        int k = s1.length();
        // initialize first window
        for (int i = 0; i < k; i++) have[s2.charAt(i) - 'a']++;

        if (matches(need, have)) return true;

        // slide
        for (int right = k; right < s2.length(); right++) {
            have[s2.charAt(right) - 'a']++;            // add new char
            have[s2.charAt(right - k) - 'a']--;        // drop old char
            if (matches(need, have)) return true;
        }
        return false;
    }

    private boolean matches(int[] a, int[] b) {
        for (int i = 0; i < 26; i++) if (a[i] != b[i]) return false;
        return true;
    }

    // Optimized version using a running 'matches' counter -> O(n) with no 26-scan
    public boolean checkInclusionOpt(String s1, String s2) {
        if (s1.length() > s2.length()) return false;
        int[] count = new int[26];
        for (char c : s1.toCharArray()) count[c - 'a']++;

        int k = s1.length(), matched = 0;
        // how many chars have nonzero requirement
        int required = 0;
        for (int c : count) if (c > 0) required++;

        for (int i = 0; i < s2.length(); i++) {
            int idx = s2.charAt(i) - 'a';
            count[idx]--;
            if (count[idx] == 0) matched++;
            else if (count[idx] == -1) matched--; // was zero, now negative

            if (i >= k) {
                int out = s2.charAt(i - k) - 'a';
                count[out]++;
                if (count[out] == 0) matched++;
                else if (count[out] == 1) matched--;
            }
            if (matched == required) return true;
        }
        return false;
    }

    public static void main(String[] args) {
        PermutationInString sol = new PermutationInString();
        System.out.println(sol.checkInclusion("ab", "eidbaooo")); // true
        System.out.println(sol.checkInclusion("ab", "eidboaoo")); // false
    }
}
```

The first version is O(26*n); the optimized version is O(n) using a running matches counter. Both are accepted; learn the optimized one for follow-ups about large alphabets.

**Complexity:** O(n) time, O(1) space (alphabet of 26).

---

## 10. Sliding Window Median (Two Heaps) — Conceptual

LeetCode 480. Return the median of every window of size `k` in an array.

Use two heaps like the running-median data structure:

- `lo` — a max-heap holding the smaller half of the window.
- `hi` — a min-heap holding the larger half.
- Balance so `lo.size()` is equal to or one more than `hi.size()`.
- Median: if k is odd, top of `lo`; if k is even, average of both tops.

The hard part is **removal**: when the window slides, the outgoing element must be removed from whichever heap holds it. Java's `PriorityQueue` does not support O(1) removal; use `HashMap<value, count>` of "lazy deletions" and rebalance when the tops are stale. Alternatively use `TreeMap`-based multisets for cleaner removal at O(log n).

Pseudocode shape:

```
for right in 0..n-1:
    add nums[right] to lo or hi, rebalance
    if right >= k-1:
        record median
        remove nums[right-k+1] (lazy), rebalance
```

**Complexity:** O(n log k) time, O(k) space.

This is an advanced variant; interviewers usually accept a correct description of the lazy-deletion strategy over a fully bug-free implementation.

---

## 11. Frequency Count in Window — Technique

Many sliding window problems reduce to maintaining a frequency map of the current window and a derived counter:

- `count[c]` — occurrences of `c` in the current window.
- `matches` — number of characters whose window count equals their required count (Permutation in String, Find All Anagrams, Minimum Window Substring).
- `distinct` — number of keys with positive count (Fruits into Baskets, At Most K Distinct).
- `maxFreq` — largest single-character count in the window (Longest Repeating Character Replacement).

The pattern for updating these counters:

```
When ADDING char c on the right:
    oldCount = count[c]
    count[c] = oldCount + 1
    update derived counters (matches / distinct / maxFreq) based on oldCount -> newCount

When REMOVING char c on the left:
    oldCount = count[c]
    count[c] = oldCount - 1
    update derived counters based on oldCount -> newCount
    if count[c] == 0: remove key (for distinct tracking)
```

Keeping the derived counter incremental (instead of rescanning the map) is what makes these solutions O(n) rather than O(n * alphabet).

---

## 12. Window With Constraint: "At Most K" Pattern

A huge family of problems is phrased as "at most K":

- Longest substring with at most K distinct characters
- Longest substring with at most K replacements
- Subarrays with at most K different integers
- Number of substrings with at most K distinct vowels

### Longest-window-at-most-K template (longest valid)

```
left = 0, best = 0
state = (count map, derived counter)
for right in 0..n-1:
    add arr[right] to state
    while state violates the "at most K" constraint:
        remove arr[left] from state
        left++
    best = max(best, right - left + 1)
return best
```

### Counting exactly K via at-most-K identity

When asked to count subarrays with **exactly** K distinct (LeetCode 992 "Subarrays with K Different Integers", LeetCode 1248 "Count Number of Nice Subarrays"), use:

```
exactly(K) = atMost(K) - atMost(K - 1)
```

where `atMost(K)` returns the number of subarrays with at most K distinct elements.

```
int atMost(int[] nums, int k) {
    if (k < 0) return 0;
    Map<Integer,Integer> count = new HashMap<>();
    int left = 0, total = 0;
    for (int right = 0; right < nums.length; right++) {
        count.merge(nums[right], 1, Integer::sum);
        while (count.size() > k) {
            count.merge(nums[left], -1, Integer::sum);
            if (count.get(nums[left]) == 0) count.remove(nums[left]);
            left++;
        }
        // every subarray ending at 'right' with start in [left..right] is valid
        total += right - left + 1;
    }
    return total;
}
// answer = atMost(K) - atMost(K-1)
```

Why `right - left + 1`? For each `right`, there are exactly `right - left + 1` valid subarrays ending at `right` (starting at any index from `left` to `right`). Summing these over all `right` gives the total count of valid subarrays. This is a powerful counting trick worth memorizing.

---

## 13. At-Most-K Changes Variant (Longest Repeating Family)

Problems 424 (Longest Repeating Character Replacement) and 1004 (Max Consecutive Ones III) are the same template expressed differently:

- 424: at most K changes where a "change" converts any letter to the majority letter. Constraint: `windowLen - maxFreq <= K`.
- 1004: at most K changes where a "change" flips a 0 to 1. Constraint: `zerosInWindow <= K`.
- Generalized "longest subarray where (some bad-count) <= K": track the bad-count, shrink when it exceeds K.

Both use the "longest valid window" template — expand always, shrink only when invalid, track max.

---

## 14. Common Mistakes and Pitfalls

- **Recomputing window state from scratch each step.** This destroys the O(n) win. Always update incrementally (one add, one remove).
- **Forgetting to evict expired front of the deque** in Sliding Window Maximum, producing stale maxima from outside the window.
- **Using `<=` vs `<` when popping the deque back.** For maximum, pop back values `<= new` to keep strictly decreasing; using `<` leaves duplicates and may keep a tied max that expires — usually still correct but waste space. Be deliberate.
- **Shrinking in the wrong direction for "shortest valid" vs "longest valid."** For shortest, you shrink WHILE valid (to minimize); for longest, you shrink WHILE invalid (to restore validity).
- **Off-by-one on window formation.** In fixed windows, only record answers once `right >= k - 1`. In variable windows, `right - left + 1` is the window length.
- **Using `==` on boxed `Integer` counts.** With `HashMap.merge`, values become `Integer`; comparing with `==` works only for cached small values. Use `.intValue()` or `.equals` (see the Minimum Window Substring code).
- **Not handling `k > n` or empty input.** Always guard early.
- **Confusing subarray (contiguous) with subsequence.** Sliding window needs contiguity.
- **Forgetting the `exactly(K) = atMost(K) - atMost(K-1)` identity** when a problem asks for "exactly K" — direct counting of exactly-K is much harder than the difference trick.

---

## 15. Complexity Cheat Sheet

| Problem | Time | Space | Window Type |
|---|---|---|---|
| Max Sum Subarray Size K | O(n) | O(1) | Fixed |
| Average of K | O(n) | O(n-k+1) output | Fixed |
| Permutation in String (567) | O(n) | O(1) (26) | Fixed |
| Find All Anagrams (438) | O(n) | O(1) (26) | Fixed |
| Sliding Window Maximum (239) | O(n) | O(k) deque | Fixed + deque |
| Sliding Window Median (480) | O(n log k) | O(k) heaps | Fixed + heaps |
| Longest Substring No Repeat (3) | O(n) | O(1) (128) | Variable (longest) |
| Min Window Substring (76) | O(n+m) | O(alphabet) | Variable (shortest) |
| Longest Repeating Replacement (424) | O(n) | O(1) (26) | Variable (longest) |
| Max Consecutive Ones III (1004) | O(n) | O(1) | Variable (longest) |
| Fruits into Baskets (904) | O(n) | O(1) | Variable (longest) |
| Longest Substring At Most K Distinct (340) | O(n) | O(k) | Variable (longest) |
| Subarrays with K Different Integers (992) | O(n) | O(k) | Variable (count via atMost) |

---

## 16. Pattern Recognition Table

Use this table to identify the sliding-window variant from problem phrasing.

| Clue in the problem statement | Likely pattern | Template | Example problems |
|---|---|---|---|
| "subarray of size K" / "window of size K" | Fixed-size window | sum/track state over fixed K, slide by 1 | Max Sum Size K, Average K, Sliding Window Max, Sliding Window Median |
| "permutation / anagram of a string as substring" | Fixed window + frequency match | window size = pattern length, compare freq maps or matches counter | Permutation in String (567), Find All Anagrams (438) |
| "maximum/minimum in every window of size K" | Fixed window + monotonic deque | deque of indices, decreasing for max / increasing for min | Sliding Window Maximum (239), Sliding Window Minimum |
| "median of every window of size K" | Fixed window + two heaps | lo max-heap + hi min-heap, lazy deletion | Sliding Window Median (480) |
| "longest substring with all unique / no repeating" | Variable, longest valid | expand right, jump left to lastSeen+1 on duplicate | Longest Substring Without Repeating (3) |
| "shortest substring containing all of T" | Variable, shortest valid | expand until valid, shrink while valid | Minimum Window Substring (76) |
| "longest substring after at most K changes/replacements" | Variable, longest, constraint = windowLen - maxFreq <= K | expand always, shrink when constraint breaks, track maxFreq | Longest Repeating Character Replacement (424), Max Consecutive Ones III (1004) |
| "longest subarray with at most K distinct" | Variable, longest, constraint = distinct <= K | freq map, shrink while distinct > K | Fruits into Baskets (904), Longest Substring At Most K Distinct (340) |
| "number of subarrays with exactly K distinct/sum" | Variable + atMost identity | exactly(K) = atMost(K) - atMost(K-1), count += right-left+1 | Subarrays with K Different Integers (992), Count Nice Subarrays (1248), Subarray Sum Equals K (prefix sum variant) |
| "longest subarray with sum <= K" | Variable, longest, constraint = sum <= K | running sum, shrink while sum > K | Max Size Subarray Sum <= k (325 inverse), Shortest Subarray Sum >= K (862, needs deque) |
| "shortest subarray with sum >= K" | Variable + deque (handles negatives) | prefix sums + monotonic deque | Shortest Subarray with Sum at Least K (862) |
| "max consecutive ones after flipping K zeros" | Variable, longest, constraint = zeros <= K | track zero count, shrink while zeros > K | Max Consecutive Ones III (1004) |
| "longest repeating character(s) after K ops" | Variable, longest, constraint = windowLen - maxFreq <= K | track maxFreq via count array | Longest Repeating Character Replacement (424) |
| "maximize/minimize X over all valid subarrays" | Variable, decide longest vs shortest by goal | longest: shrink while invalid; shortest: shrink while valid | generic |
| "substrings satisfying a monotone property" | Variable window or two-pointer | if property is monotone in window expansion, sliding window applies | varies |

### Quick decision flow

1. Is the input a contiguous subarray/substring problem? If no, sliding window probably does not apply.
2. Is the window size fixed (K given) or variable (optimize length / count)?
3. If fixed — do you need the max/min (deque), median (heaps), or a sum/count (running state)?
4. If variable — are you maximizing length (shrink while invalid) or minimizing length (shrink while valid) or counting (use atMost identity)?
5. What state must you maintain incrementally? (sum, frequency map, deque, maxFreq, distinct count, matches counter)
6. What is the validity condition, and can you check it in O(1) from the state?

If you can answer all six, the code writes itself.

---

## 17. Practice Progression

Recommended order to build mastery:

1. Max Sum Subarray Size K (fixed, warm-up)
2. Average of K (fixed, list output)
3. Longest Substring Without Repeating Characters (3) — first variable window
4. Max Consecutive Ones III (1004) — at-most-K changes
5. Fruits into Baskets (904) — at-most-K distinct
6. Longest Repeating Character Replacement (424) — maxFreq trick
7. Permutation in String (567) — fixed window + frequency match
8. Find All Anagrams in a String (438) — fixed window + matches counter
9. Minimum Window Substring (76) — shortest valid, hardest variable window
10. Sliding Window Maximum (239) — monotonic deque
11. Sliding Window Median (480) — two heaps with lazy deletion
12. Subarrays with K Different Integers (992) — atMost identity for exact counting
13. Shortest Subarray with Sum at Least K (862) — deque + prefix sums (negatives)

After this progression you will have seen every major sliding-window technique interviewed today.

---

## 19. Final Tips for Interviews

- **State the brute force first** (nested loops), then say "we can do better by reusing the previous window's computation," then derive the sliding window. Interviewers love seeing the optimization emerge.
- **Name the window flavor explicitly:** "This is a fixed-size window" or "This is a variable window maximizing length under a constraint." It signals pattern mastery.
- **Walk through one slide by hand** with a tiny example before coding — catches off-by-one errors in window formation and deque eviction.
- **Discuss the validity check's cost.** If it requires scanning a map, mention the matches-counter optimization.
- **For deque problems, draw the deque** at two or three steps (as in the ASCII diagram above). The interviewer can follow your reasoning.
- **Mention complexity explicitly** at the end: time, space, and why each index is processed O(1) times amortized.
- **Edge cases to volunteer:** empty input, k > n, k = 1, k = n, all identical elements, no valid answer (return empty / 0 / -1 per problem).

Sliding window rewards pattern recognition. Once the templates above are muscle memory, the only job in an interview is to (a) classify the problem into one of the templates, (b) identify the state and validity condition, and (c) implement the template cleanly. Practice the progression in section 18 and you will handle any sliding-window question confidently.

## Interview Cheat Sheet

**Key Points to Remember:**
- Fixed-size window: add right, remove left, update answer — O(1) per slide.
- Variable-size window: expand right, shrink left while invalid — two sub-patterns (longest/shortest).
- Count subarrays with exact K = atMost(K) - atMost(K-1).
- Never recompute window state from scratch — carry it incrementally (sum, count, frequency map, deque).

**Common Follow-Up Questions:**
- "How do you know if a problem is sliding window?" — Keywords: "contiguous subarray/substring," "longest/shortest with constraint," "at most K." If the problem asks about subsequences (not contiguous), it's NOT sliding window.
- "Fixed or variable window?" — If K is given, fixed. If you're optimizing window size, variable.

**Gotcha:**
- Confusing subarrays (contiguous → sliding window) with subsequences (non-contiguous → DP or greedy). Read the problem statement carefully — "subarray" = contiguous, "subsequence" = not necessarily contiguous.
