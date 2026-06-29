---
title: "Sorting — Coding Interview Prep"
date: 2026-06-19
tags: [sorting, algorithms, java, interview-prep, merge-sort, quicksort, heapsort, counting-sort, quickselect, dutch-flag]
categories: [coding-interview-prep]
difficulty: intermediate-to-advanced
summary: "Comprehensive guide to comparison and non-comparison sorting algorithms, stability, custom comparators, and 12+ sorting-based LeetCode problems with full Java solutions and ASCII diagrams."
---

# Sorting — Coding Interview Prep

Sorting is one of the most fundamental topics in coding interviews. Beyond knowing how to implement standard algorithms, interviewers test your ability to recognize when sorting unlocks a simpler solution, choose the right algorithm for constraints, and write custom comparators for non-trivial orderings. This article covers everything from algorithm fundamentals to pattern recognition.

---

## Summary & Interview Framing

Comparison sorts (quicksort, merge sort, heap sort at O(n log n)), non-comparison sorts (counting sort at O(n+k)), and custom comparators for interview problems.

**How it's asked:** "Sort an array, merge sorted arrays, sort colors (Dutch flag), top K frequent elements, custom sort by frequency — problems where sorting is the key enabler."

---

## 1. Comparison Sorts

Comparison sorts rely on comparing pairs of elements. They have a theoretical lower bound of O(n log n) for the average and worst case — you cannot do better than this with comparisons alone.

### 1.1 Merge Sort

Merge sort is a divide-and-conquer algorithm. It recursively splits the array in half, sorts each half, and then merges the two sorted halves. It guarantees O(n log n) in all cases and is stable, but requires O(n) extra space.

**Algorithm outline:**
1. Divide the array into two halves at the midpoint.
2. Recursively sort the left half and the right half.
3. Merge the two sorted halves using a two-pointer technique.

**ASCII Diagram — Merge Step:**

```
  Merging two sorted halves into one sorted array

  Left  (sorted):  [2, 5, 8]              Right (sorted):  [1, 3, 7, 9]
                    ^                                       ^
                    i                                       j

  Compare nums[i] vs nums[j] — smaller value goes to output first.

  +-------+-------+-------+-------+-------+-------+-------+
  | Step  |   i   |   j   | Compare       | Output so far          |
  +-------+-------+-------+-------+-------+-------+-------+
  |   1   |   0   |   0   | 2 vs 1 → 1   | [1]                    |
  |   2   |   0   |   1   | 2 vs 3 → 2   | [1, 2]                 |
  |   3   |   1   |   1   | 5 vs 3 → 3   | [1, 2, 3]              |
  |   4   |   1   |   2   | 5 vs 7 → 5   | [1, 2, 3, 5]           |
  |   5   |   2   |   2   | 8 vs 7 → 7   | [1, 2, 3, 5, 7]        |
  |   6   |   2   |   3   | 8 vs 9 → 8   | [1, 2, 3, 5, 7, 8]     |
  |   7   |   3   |   3   | i exhausted  | append remaining → 9   |
  +-------+-------+-------+---------------+------------------------+

  Final merged result: [1, 2, 3, 5, 7, 8, 9]
```

**Key properties:**
- Time: O(n log n) — best, average, and worst case.
- Space: O(n) for the temporary merge array.
- Stable: Yes — equal elements preserve their relative order.
- Good for linked lists (can merge in O(1) extra space) and external sorting.

### 1.2 Quick Sort

Quick sort is another divide-and-conquer algorithm. It picks a pivot, partitions the array so that elements less than or equal to the pivot are on the left and greater elements are on the right, then recursively sorts each partition. With a random pivot, the average case is O(n log n), but the worst case is O(n²) (when the pivot is always the smallest or largest element).

**ASCII Diagram — Lomuto Partition:**

```
  Array: [7, 2, 1, 6, 8, 5, 3, 4]    pivot = 4 (last element)

  i tracks the boundary of the "≤ pivot" region (starts at left - 1).
  j scans from left to right - 1.

  +-----+-----+-----+-----+-----+-----+-----+-----+
  |  7  |  2  |  1  |  6  |  8  |  5  |  3  |  4  |
  +-----+-----+-----+-----+-----+-----+-----+-----+
     j=0   j=1   j=2   j=3   j=4   j=5   j=6   pivot

  j=0: 7 > 4 → skip.                         i = -1
  j=1: 2 ≤ 4 → i=0, swap(0,1) → [2,7,1,6,8,5,3,4]
  j=2: 1 ≤ 4 → i=1, swap(1,2) → [2,1,7,6,8,5,3,4]
  j=3: 6 > 4 → skip.
  j=4: 8 > 4 → skip.
  j=5: 5 > 4 → skip.
  j=6: 3 ≤ 4 → i=2, swap(2,6) → [2,1,3,6,8,5,7,4]

  Final: swap(i+1, right) → swap(3, 7) → [2, 1, 3, | 4 |, 8, 5, 7, 6]
                                            ↑ pivot now at index 3

  Left partition:  [2, 1, 3]    (all ≤ 4)
  Right partition: [8, 5, 7, 6] (all > 4)

  Recurse on left and right partitions.
```

**Key properties:**
- Time: O(n log n) average, O(n²) worst case (mitigated by random pivot).
- Space: O(log n) for recursion stack.
- Stable: No (standard implementations are not stable).
- In-place: Yes (O(1) extra space beyond recursion stack).
- Cache-friendly due to in-place memory access patterns.

### 1.3 Heap Sort

Heap sort builds a max-heap from the array, then repeatedly extracts the maximum element and places it at the end.

**Algorithm outline:**
1. Build a max-heap from the unsorted array (heapify from the last non-leaf node down to the root).
2. Swap the root (maximum) with the last element.
3. Reduce the heap size by one and sift-down the new root.
4. Repeat until the heap has one element.

**Key properties:**
- Time: O(n log n) — best, average, and worst case.
- Space: O(1) — truly in-place.
- Stable: No.
- Not cache-friendly (scattered memory access due to tree structure).
- Good when worst-case O(n log n) is required and space is tight.

---

## 2. Non-Comparison Sorts

Non-comparison sorts exploit properties of the data (such as bounded integer ranges) to achieve linear time complexity. They are not general-purpose — they require specific input characteristics.

### 2.1 Counting Sort

Counting sort works when the input values are integers in a known, bounded range. It counts the occurrences of each value, then reconstructs the sorted output.

**ASCII Diagram — Counting Sort:**

```
  Input:  [4, 2, 2, 8, 3, 3, 1]     Value range: 0 to 8

  Step 1 — Count occurrences of each value:

  +-------+---+---+---+---+---+---+---+---+---+
  | Value | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
  +-------+---+---+---+---+---+---+---+---+---+
  | Count | 0 | 1 | 2 | 2 | 1 | 0 | 0 | 0 | 1 |
  +-------+---+---+---+---+---+---+---+---+---+

  Step 2 — Expand counts into sorted output:

  Value 0: (skip)                     → []
  Value 1: append once                → [1]
  Value 2: append twice               → [1, 2, 2]
  Value 3: append twice               → [1, 2, 2, 3, 3]
  Value 4: append once                → [1, 2, 2, 3, 3, 4]
  Value 5-7: (skip)                   → [1, 2, 2, 3, 3, 4]
  Value 8: append once                → [1, 2, 2, 3, 3, 4, 8]

  Output: [1, 2, 2, 3, 3, 4, 8]
```

**Key properties:**
- Time: O(n + k) where k is the range of input values.
- Space: O(n + k).
- Stable: Yes (when implemented with cumulative counts).
- Only works for integer keys with a bounded range. If k >> n, it becomes inefficient.

### 2.2 Radix Sort

Radix sort processes digits from least significant to most significant (LSD) using a stable sub-sort (typically counting sort) for each digit position. Time O(d × (n + k)) where d is the number of digits and k is the radix. Space O(n + k). Stable. Works for integers, strings, and fixed-length keys.

---

## 3. In-Place vs Stable Sorting

These two properties come up frequently in interviews. Understanding them is essential for choosing the right algorithm.

**In-place** means the algorithm sorts using O(1) extra space (or O(log n) for recursion). **Stable** means two elements with equal keys retain their original relative order — critical when sorting by a secondary criterion or when the key is part of a larger object.

```
  Stable:   [Alice:A, Carol:A, Eve:A, Bob:B, Dave:B]  (ties preserve original order)
  Unstable: [Eve:A, Alice:A, Carol:A, Dave:B, Bob:B]  (ties may reorder — Eve jumped ahead)
```

Quick reference: Merge sort — stable, not in-place (O(n) extra). Quick sort — not stable, in-place. Heap sort — not stable, in-place. Insertion sort — stable, in-place. Counting sort — stable, not in-place.

Java note: `Arrays.sort()` on objects uses stable TimSort. `Arrays.sort()` on primitives uses dual-pivot quicksort (NOT stable). If you need stable sorting of primitives, box them or use `Collections.sort()`.

---

## 4. Custom Comparators in Java

Many sorting problems require non-standard ordering. Java provides several ways to define custom comparators:

```java
// Lambda (most common in interviews)
Arrays.sort(arr, (a, b) -> a[0] - b[0]);            // sort by first element ascending
Arrays.sort(arr, (a, b) -> Integer.compare(b[1], a[1])); // second element descending

// Multi-level comparison
Arrays.sort(intervals, (a, b) -> {
    if (a[0] != b[0]) return a[0] - b[0];   // primary: start ascending
    return a[1] - b[1];                       // secondary: end ascending
});

// Sort one field ascending, another descending
Arrays.sort(envelopes, (a, b) -> {
    if (a[0] != b[0]) return Integer.compare(a[0], b[0]);  // width asc
    return Integer.compare(b[1], a[1]);                      // height desc
});
```

**Important:** Avoid `a - b` in comparators when values can overflow. Use `Integer.compare(a, b)` instead.

---

## 5. Sorting Algorithm Comparison Table

| Algorithm | Best | Average | Worst | Space | Stable | In-Place | Notes |
|---|---|---|---|---|---|---|---|
| Bubble Sort | O(n) | O(n²) | O(n²) | O(1) | Yes | Yes | Rarely used; educational |
| Selection Sort | O(n²) | O(n²) | O(n²) | O(1) | No | Yes | Minimal swaps |
| Insertion Sort | O(n) | O(n²) | O(n²) | O(1) | Yes | Yes | Fast for small / nearly sorted |
| Merge Sort | O(n log n) | O(n log n) | O(n log n) | O(n) | Yes | No | Guaranteed O(n log n); stable |
| Quick Sort | O(n log n) | O(n log n) | O(n²) | O(log n) | No | Yes | Cache-friendly; random pivot avoids worst case |
| Heap Sort | O(n log n) | O(n log n) | O(n log n) | O(1) | No | Yes | In-place with guaranteed O(n log n) |
| Counting Sort | O(n+k) | O(n+k) | O(n+k) | O(n+k) | Yes | No | Integer keys with bounded range k |
| Radix Sort | O(d(n+k)) | O(d(n+k)) | O(d(n+k)) | O(n+k) | Yes | No | d digits, radix k; needs stable sub-sort |
| Bucket Sort | O(n+k) | O(n+k) | O(n²) | O(n+k) | Yes | No | Uniform distribution gives O(n); worst case degrades |

---

## 6. LeetCode Problems with Full Java Solutions

### 6.1 Sort an Array (LeetCode 912) — Merge Sort

**Problem:** Given an array of integers, sort it in ascending order and return the sorted array. You must not use the built-in sort function.

**Approach:** Implement merge sort — divide the array at the midpoint, recursively sort each half, then merge the two sorted halves.

```java
class Solution {
    public int[] sortArray(int[] nums) {
        mergeSort(nums, 0, nums.length - 1);
        return nums;
    }

    private void mergeSort(int[] nums, int left, int right) {
        if (left >= right) return;
        int mid = left + (right - left) / 2;
        mergeSort(nums, left, mid);
        mergeSort(nums, mid + 1, right);
        merge(nums, left, mid, right);
    }

    private void merge(int[] nums, int left, int mid, int right) {
        int[] temp = new int[right - left + 1];
        int i = left, j = mid + 1, k = 0;

        while (i <= mid && j <= right) {
            if (nums[i] <= nums[j]) {
                temp[k++] = nums[i++];
            } else {
                temp[k++] = nums[j++];
            }
        }
        while (i <= mid) {
            temp[k++] = nums[i++];
        }
        while (j <= right) {
            temp[k++] = nums[j++];
        }
        System.arraycopy(temp, 0, nums, left, temp.length);
    }
}
```

**Complexity:** Time O(n log n), Space O(n).

---

### 6.2 Sort an Array (LeetCode 912) — Quick Sort

**Approach:** Implement quicksort with a randomized pivot to avoid worst-case O(n²) on sorted or nearly-sorted inputs.

```java
import java.util.Random;

class Solution {
    private Random rand = new Random();

    public int[] sortArray(int[] nums) {
        quickSort(nums, 0, nums.length - 1);
        return nums;
    }

    private void quickSort(int[] nums, int left, int right) {
        if (left >= right) return;
        int pivotIndex = partition(nums, left, right);
        quickSort(nums, left, pivotIndex - 1);
        quickSort(nums, pivotIndex + 1, right);
    }

    private int partition(int[] nums, int left, int right) {
        // Random pivot — swap with right, then use Lomuto partition
        int randomIndex = left + rand.nextInt(right - left + 1);
        swap(nums, randomIndex, right);

        int pivot = nums[right];
        int i = left;  // boundary of elements <= pivot
        for (int j = left; j < right; j++) {
            if (nums[j] <= pivot) {
                swap(nums, i, j);
                i++;
            }
        }
        swap(nums, i, right);
        return i;
    }

    private void swap(int[] nums, int a, int b) {
        int temp = nums[a];
        nums[a] = nums[b];
        nums[b] = temp;
    }
}
```

**Complexity:** Time O(n log n) average, O(n²) worst case (rare with random pivot). Space O(log n) for recursion.

---

### 6.3 Sort Colors (LeetCode 75) — Dutch National Flag

**Problem:** Given an array with values 0 (red), 1 (white), and 2 (blue), sort them in-place so that all 0s come first, then 1s, then 2s. Do not use the built-in sort function.

**Approach:** Use the Dutch National Flag algorithm with three pointers. `low` tracks the boundary of 0s, `mid` is the current element, and `high` tracks the boundary of 2s.

```
  Dutch National Flag — three-way partition

  [0, 0, 0, < unexplored >, 2, 2, 2]
   ^       ^                 ^
   low     mid               high

  nums[mid] == 0 → swap(low, mid), low++, mid++
  nums[mid] == 1 → mid++
  nums[mid] == 2 → swap(mid, high), high--  (don't move mid yet)
```

```java
class Solution {
    public void sortColors(int[] nums) {
        int low = 0, mid = 0, high = nums.length - 1;

        while (mid <= high) {
            if (nums[mid] == 0) {
                swap(nums, low, mid);
                low++;
                mid++;
            } else if (nums[mid] == 1) {
                mid++;
            } else { // nums[mid] == 2
                swap(nums, mid, high);
                high--;
                // Do not increment mid — the swapped element needs checking
            }
        }
    }

    private void swap(int[] nums, int a, int b) {
        int temp = nums[a];
        nums[a] = nums[b];
        nums[b] = temp;
    }
}
```

**Complexity:** Time O(n), Space O(1). One pass, in-place.

**Why not just count and overwrite?** Counting sort (two-pass: count 0s, 1s, 2s, then overwrite) also works in O(n) time and O(1) space, but the Dutch flag approach is a true one-pass solution and demonstrates the three-way partitioning technique used in quicksort variants.

---

### 6.4 Top K Frequent Elements (LeetCode 347) — Bucket Sort

**Problem:** Given an integer array and an integer k, return the k most frequent elements. You may return the answer in any order.

**Approach:** Count frequencies with a hash map, then use bucket sort where the bucket index is the frequency. Iterate from the highest frequency bucket downward, collecting elements until we have k.

```
  Input: [1,1,1,2,2,3], k = 2

  Frequency map: {1: 3, 2: 2, 3: 1}

  Buckets (index = frequency):
  +---+-------+-------+-------+-------+
  | 0 |   1   |   2   |   3   | 4..n  |
  +---+-------+-------+-------+-------+
  |   | [3]   | [2]   | [1]   |       |
  +---+-------+-------+-------+-------+

  Collect from right: bucket[3] → [1], bucket[2] → [2]
  Result: [1, 2]
```

```java
class Solution {
    public int[] topKFrequent(int[] nums, int k) {
        // Step 1: count frequencies
        Map<Integer, Integer> count = new HashMap<>();
        for (int num : nums) {
            count.put(num, count.getOrDefault(num, 0) + 1);
        }

        // Step 2: bucket sort by frequency (index = frequency)
        List<Integer>[] buckets = new List[nums.length + 1];
        for (int key : count.keySet()) {
            int freq = count.get(key);
            if (buckets[freq] == null) {
                buckets[freq] = new ArrayList<>();
            }
            buckets[freq].add(key);
        }

        // Step 3: collect top k from highest frequency bucket down
        int[] result = new int[k];
        int idx = 0;
        for (int freq = buckets.length - 1; freq >= 0 && idx < k; freq--) {
            if (buckets[freq] != null) {
                for (int key : buckets[freq]) {
                    if (idx < k) {
                        result[idx++] = key;
                    }
                }
            }
        }
        return result;
    }
}
```

**Complexity:** Time O(n), Space O(n). Bucket sort is O(n) here because the maximum frequency is n.

**Alternative approaches:** A min-heap of size k gives O(n log k) time. Quickselect gives O(n) average. Bucket sort is simplest and fastest when frequencies are bounded by n.

---

### 6.5 Kth Largest Element in an Array (LeetCode 215) — Quickselect

**Problem:** Given an integer array and an integer k, return the kth largest element in the array (not the kth distinct element).

**Approach:** Use the quickselect algorithm — a variation of quicksort that only recurses into the partition that contains the target index. The kth largest element is at index (n - k) in a 0-indexed sorted array.

```java
import java.util.Random;

class Solution {
    private Random rand = new Random();

    public int findKthLargest(int[] nums, int k) {
        int target = nums.length - k;  // kth largest = (n-k)th smallest
        return quickSelect(nums, 0, nums.length - 1, target);
    }

    private int quickSelect(int[] nums, int left, int right, int target) {
        int pivotIndex = partition(nums, left, right);

        if (pivotIndex == target) {
            return nums[pivotIndex];
        } else if (pivotIndex < target) {
            return quickSelect(nums, pivotIndex + 1, right, target);
        } else {
            return quickSelect(nums, left, pivotIndex - 1, target);
        }
    }

    private int partition(int[] nums, int left, int right) {
        int randomIndex = left + rand.nextInt(right - left + 1);
        swap(nums, randomIndex, right);

        int pivot = nums[right];
        int i = left;
        for (int j = left; j < right; j++) {
            if (nums[j] <= pivot) {
                swap(nums, i, j);
                i++;
            }
        }
        swap(nums, i, right);
        return i;
    }

    private void swap(int[] nums, int a, int b) {
        int temp = nums[a];
        nums[a] = nums[b];
        nums[b] = temp;
    }
}
```

**Complexity:** Time O(n) average, O(n²) worst case (rare with random pivot). Space O(1) with iterative implementation or O(log n) with recursion.

**Why not just sort?** Sorting is O(n log n). Quickselect is O(n) average because it only recurses into one partition, not both. For a single kth element query, quickselect is optimal.

---

### 6.6 Merge Sorted Array (LeetCode 88)

**Problem:** You are given two sorted integer arrays nums1 and nums2, where nums1 has enough trailing space (m + n slots) to hold nums2. Merge them in-place into nums1 as one sorted array.

**Approach:** Use three pointers starting from the ends. Fill nums1 from the back, always placing the larger of the two remaining elements. This avoids overwriting elements in nums1 that haven't been compared yet.

```
  nums1: [1, 2, 3, 0, 0, 0]   m = 3
  nums2: [2, 5, 6]             n = 3

  Pointers: i = 2 (end of nums1 data), j = 2 (end of nums2), k = 5 (end of merged)

  Step 1: 3 vs 6 → 6 is larger → nums1[5] = 6, j--, k--
  Step 2: 3 vs 5 → 5 is larger → nums1[4] = 5, j--, k--
  Step 3: 3 vs 2 → 3 is larger → nums1[3] = 3, i--, k--
  Step 4: 2 vs 2 → tie       → nums1[2] = 2, j--, k--
  Step 5: j = -1, stop. nums1 data [1, 2] already in place.

  Result: [1, 2, 2, 3, 5, 6]
```

```java
class Solution {
    public void merge(int[] nums1, int m, int[] nums2, int n) {
        int i = m - 1;       // last valid element in nums1
        int j = n - 1;       // last element in nums2
        int k = m + n - 1;   // last position in merged array

        while (i >= 0 && j >= 0) {
            if (nums1[i] > nums2[j]) {
                nums1[k--] = nums1[i--];
            } else {
                nums1[k--] = nums2[j--];
            }
        }

        // If nums2 still has elements, copy them over.
        // If nums1 still has elements, they're already in the correct position.
        while (j >= 0) {
            nums1[k--] = nums2[j--];
        }
    }
}
```

**Complexity:** Time O(m + n), Space O(1). Filling from the back is the key insight — it avoids needing a temporary array.

---

### 6.7 Custom Sort String (LeetCode 791)

**Problem:** You are given a string order representing the desired custom order and a string s. Permute the characters of s so that they match the order in order. Characters not in order appear at the end in any order.

**Approach:** Count the frequency of each character in s. Then iterate through order, appending each character as many times as it appears in s. Finally, append all remaining characters that were not in order.

```java
class Solution {
    public String customSortString(String order, String s) {
        // Count occurrences of each character in s
        int[] count = new int[26];
        for (char c : s.toCharArray()) {
            count[c - 'a']++;
        }

        StringBuilder sb = new StringBuilder();

        // Append characters in the order specified by 'order'
        for (char c : order.toCharArray()) {
            while (count[c - 'a'] > 0) {
                sb.append(c);
                count[c - 'a']--;
            }
        }

        // Append remaining characters not in 'order'
        for (int i = 0; i < 26; i++) {
            while (count[i] > 0) {
                sb.append((char) ('a' + i));
                count[i]--;
            }
        }

        return sb.toString();
    }
}
```

**Complexity:** Time O(order + s), Space O(1) (the count array is fixed size 26).

**Why counting sort instead of a comparator?** A custom comparator would be O(s log s), but counting sort is O(s) since the alphabet is small and fixed. The order string acts as the "sorted key" for the counting sort.

---

### 6.8 Reorder Data in Log Files (LeetCode 937)

**Problem:** You have an array of logs. Each log is a space-delimited string where the first word is an identifier and the rest is the log content. Letter-logs have all alphabetical content; digit-logs have all numeric content. Reorder so that:
1. Letter-logs come before digit-logs.
2. Letter-logs are sorted lexicographically by content, then by identifier if contents are identical.
3. Digit-logs remain in their original order.

**Approach:** Use a custom comparator with `Arrays.sort()`. Java's `Arrays.sort(Object[])` is stable (TimSort), so returning 0 for two digit-logs preserves their original relative order.

```java
class Solution {
    public String[] reorderLogFiles(String[] logs) {
        Arrays.sort(logs, (log1, log2) -> {
            // Split into identifier and content (limit 2 to keep content intact)
            String[] split1 = log1.split(" ", 2);
            String[] split2 = log2.split(" ", 2);

            boolean isDigit1 = Character.isDigit(split1[1].charAt(0));
            boolean isDigit2 = Character.isDigit(split2[1].charAt(0));

            // Case 1: both letter-logs → sort by content, then by identifier
            if (!isDigit1 && !isDigit2) {
                int cmp = split1[1].compareTo(split2[1]);
                if (cmp != 0) return cmp;
                return split1[0].compareTo(split2[0]);
            }

            // Case 2: one is letter, one is digit → letter first
            if (!isDigit1 && isDigit2) return -1;  // log1 is letter → comes first
            if (isDigit1 && !isDigit2) return 1;   // log2 is letter → comes first

            // Case 3: both digit-logs → preserve original order (stable sort)
            return 0;
        });

        return logs;
    }
}
```

**Complexity:** Time O(N · L log N) where N is the number of logs and L is the average log length (each comparison involves string comparison of length L). Space O(log N) for TimSort's stack.

**Key insight:** The stable sort property is critical here. We rely on `Arrays.sort(Object[])` being stable so that digit-logs returning 0 maintain their input order. If the sort were unstable, digit-logs could be arbitrarily rearranged.

---

## 7. Additional Sorting Patterns

### 7.1 Wiggle Sort (LeetCode 280 & 324)

**Wiggle Sort I (280):** Rearrange an array so that nums[0] <= nums[1] >= nums[2] <= nums[3] >= ...

**Approach:** For even indices, ensure nums[i] <= nums[i+1]. For odd indices, ensure nums[i] >= nums[i+1]. Swap if the condition is violated. This works in O(n) with a single pass.

```java
class Solution {
    public void wiggleSort(int[] nums) {
        for (int i = 0; i < nums.length - 1; i++) {
            if ((i % 2 == 0) == (nums[i] > nums[i + 1])) {
                swap(nums, i, i + 1);
            }
        }
    }

    private void swap(int[] nums, int a, int b) {
        int temp = nums[a];
        nums[a] = nums[b];
        nums[b] = temp;
    }
}
```

**Complexity:** Time O(n), Space O(1).

The condition `(i % 2 == 0) == (nums[i] > nums[i + 1])` captures both cases: for even indices we want nums[i] <= nums[i+1] (swap if greater), for odd indices we want nums[i] >= nums[i+1] (swap if smaller).

**Wiggle Sort II (324):** nums[0] < nums[1] > nums[2] < nums[3] > ... (strict inequalities, no duplicates adjacent). This requires sorting, then interleaving small and large halves. A virtual indexing trick (using the Dutch flag partition) can make it O(n) time.

### 7.2 Meeting Rooms (LeetCode 252)

**Problem:** Given an array of meeting time intervals, determine if a person could attend all meetings.

**Approach:** Sort intervals by start time. If any meeting starts before the previous meeting ends, there is a conflict.

```java
class Solution {
    public boolean canAttendMeetings(int[][] intervals) {
        Arrays.sort(intervals, (a, b) -> Integer.compare(a[0], b[0]));
        for (int i = 1; i < intervals.length; i++) {
            if (intervals[i][0] < intervals[i - 1][1]) {
                return false;  // overlap detected
            }
        }
        return true;
    }
}
```

**Complexity:** Time O(n log n) for sorting, Space O(1).

**Variation — Meeting Rooms II (253):** Find the minimum number of conference rooms required. Sort start and end times separately, then use a two-pointer sweep to track concurrent meetings.

### 7.3 Russian Doll Envelopes (LeetCode 354)

**Problem:** Given envelopes represented as (width, height), a Russian doll envelope can fit inside another if both width and height are strictly smaller. Find the maximum number of envelopes that can be nested.

**Approach:** Sort by width ascending. For ties in width, sort by height descending (so envelopes with the same width cannot nest within each other). Then find the longest increasing subsequence (LIS) on the heights.

```
  Envelopes: [[5,4],[6,4],[6,7],[2,3]]

  Sort by width asc, height desc:
  [[2,3], [5,4], [6,7], [6,4]]
   ^width=2  ^width=5  ^width=6,h=7  ^width=6,h=4

  Heights: [3, 4, 7, 4]
  LIS on heights: [3, 4, 7] → length 3

  Answer: 3  (envelopes [2,3] → [5,4] → [6,7])
```

The height-descending trick for equal widths ensures that when we compute LIS on heights, two envelopes with the same width are not both selected (since their heights are in descending order, they cannot form an increasing subsequence).

```java
class Solution {
    public int maxEnvelopes(int[][] envelopes) {
        // Sort by width ascending; for equal widths, height descending
        Arrays.sort(envelopes, (a, b) -> {
            if (a[0] != b[0]) return Integer.compare(a[0], b[0]);
            return Integer.compare(b[1], a[1]);  // descending height
        });

        // Extract heights and find LIS using binary search
        int[] dp = new int[envelopes.length];
        int len = 0;
        for (int[] env : envelopes) {
            int h = env[1];
            int idx = Arrays.binarySearch(dp, 0, len, h);
            if (idx < 0) idx = -(idx + 1);
            dp[idx] = h;
            if (idx == len) len++;
        }
        return len;
    }
}
```

**Complexity:** Time O(n log n) for sorting + O(n log n) for LIS with binary search. Space O(n).

### 7.4 Array Partition (LeetCode 561)

**Problem:** Given 2n integers, group them into n pairs (a, b) such that the sum of min(a, b) for all pairs is maximized. Return the maximum sum.

**Approach:** Sort the array and pair adjacent elements. The intuition is that to maximize the sum of minimums, you want to pair close values together so that the "wasted" larger value in each pair is as small as possible. After sorting, pairing (nums[0], nums[1]), (nums[2], nums[3]), ... and summing nums[0] + nums[2] + nums[4] + ... gives the maximum.

```
  Input: [6, 2, 6, 5, 1, 2]

  Sorted: [1, 2, 2, 5, 6, 6]
  Pairs:   (1,2) (2,5) (6,6)
  Mins:     1     2     6    → sum = 9

  Why not pair (1,6), (2,6), (2,5)?
  Mins:      1      2     2    → sum = 5  (worse — large gaps waste value)
```

```java
class Solution {
    public int arrayPairSum(int[] nums) {
        Arrays.sort(nums);
        int sum = 0;
        for (int i = 0; i < nums.length; i += 2) {
            sum += nums[i];
        }
        return sum;
    }
}
```

**Complexity:** Time O(n log n), Space O(1).

**Why this works:** In the sorted array, each pair contributes the smaller (even-indexed) element. Any alternative pairing would pair a larger element with a smaller one, "wasting" the larger element. The greedy sorted pairing is provably optimal.

---

## 8. Partial Sorting and Selection

Several problems only need a portion of the data sorted. Full sorting is often unnecessary:

| Technique | Time | When to use |
|---|---|---|
| Full sort, take first k | O(n log n) | Simple, k close to n |
| Min-heap of size k | O(n log k) | Streaming data, k << n |
| Quickselect | O(n) average | Single kth element |
| Bucket sort | O(n) | Frequencies or bounded values |

**Heap approach for Top K Frequent (alternative):** Use a min-heap of size k keyed by frequency. For each element, insert into the heap; if the heap exceeds size k, evict the minimum. Time O(n log k), Space O(n).

---

## 9. Pattern Recognition Table

| Pattern | Signal / Hint | Key Insight | Example Problems |
|---|---|---|---|
| Merge sorted arrays | Two already-sorted inputs | Two-pointer merge; fill from back if in-place | Merge Sorted Array (88), Merge K Sorted Lists (23) |
| Dutch National Flag | Exactly 3 distinct values to separate | Three-way partition with low/mid/high pointers | Sort Colors (75), Wiggle Sort II (324) |
| Quickselect | Need kth element, not full sort | Partition and recurse only into the side containing the target | Kth Largest Element (215), Top K Frequent (347) |
| Bucket sort by frequency | Elements ranked by count/frequency | Bucket index = frequency, iterate from top | Top K Frequent (347), Sort Chars by Freq (451) |
| Custom comparator | Non-standard or multi-key ordering | Define comparator; use stable sort if order matters | Reorder Log Files (937), Meeting Rooms (252) |
| Counting sort for small alphabet | Custom order over limited character set | Count occurrences, output in desired order | Custom Sort String (791) |
| Sort + greedy | Sorting enables a simple greedy pass | Sort by one key, then make local optimal choices | Meeting Rooms (252), Array Partition (561), Assign Cookies (455) |
| 2D sort + LIS | Two-dimensional nesting / fitting | Sort one dim ascending, other descending, then LIS | Russian Doll Envelopes (354), Longest Increasing Subsequence (300) |
| Partial sort / top k | Only k elements needed | Heap of size k, quickselect, or bucket sort | Kth Largest (215), Top K Frequent (347), K Closest Points (973) |
| Sort by interval start | Overlapping intervals | Sort by start, check consecutive for overlaps | Meeting Rooms (252/253), Merge Intervals (56), Insert Interval (57) |
| Wiggle / alternating order | Adjacent elements satisfy inequality | One-pass swap or sort + interleave | Wiggle Sort (280/324) |
| Pair adjacent after sort | Pair elements to optimize sum | Sort and pair neighbors to minimize waste | Array Partition (561), Boats to Save People (881) |

---

## 10. Common Interview Tips

1. **Always ask about constraints.** If the value range is small (e.g., 0 to 100), counting sort may be optimal. If the array is nearly sorted, insertion sort is O(n).

2. **Clarify stability requirements.** If the problem involves secondary ordering or preserving original positions for ties, choose a stable sort. Note: `Arrays.sort(primitive[])` is NOT stable; `Arrays.sort(Object[])` and `Collections.sort()` are stable (TimSort).

3. **Randomize the pivot in quicksort.** Without randomization, quicksort degrades to O(n²) on sorted inputs — a common test case.

4. **Use the right tool for top-k.** If k is small and n is large, a heap of size k (O(n log k)) beats full sort (O(n log n)). Quickselect gives O(n) for a single kth element.

5. **Filling from the back.** When merging into a buffer with extra space at the end (like LeetCode 88), always fill from the back to avoid overwriting unprocessed elements.

6. **Sort is often a setup move.** Many problems become trivial after sorting — especially interval, pairing, and greedy problems. Always ask: "Does sorting make this easier?"

7. **Watch for integer overflow in comparators.** `a[0] - b[0]` can overflow for values near Integer.MIN_VALUE or MAX_VALUE. Use `Integer.compare(a, b)` instead.

---

## Summary

Master the seven full Java solutions in this article — they cover the majority of sorting patterns in interviews. Key takeaways: implement merge sort and quicksort from memory (with randomized pivot), recognize when sorting unlocks greedy or two-pointer solutions, choose between full sort / partial sort / non-comparison sort based on constraints, and always use `Integer.compare()` in comparators to avoid overflow. The pattern recognition table is your cheat sheet for identifying which approach to use on new problems.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Comparison sorts: O(n log n) is the theoretical lower bound. Quick sort: O(n log n) average, O(n²) worst, in-place, not stable. Merge sort: O(n log n) guaranteed, O(n) space, stable. Heap sort: O(n log n), in-place, not stable.
- Counting sort: O(n+k), stable, only for small integer key ranges.
- Java's Arrays.sort: TimSort for objects (stable), dual-pivot quicksort for primitives (not stable).
- Use `Integer.compare(a, b)` instead of `a - b` in comparators to avoid overflow.
- Sort is often a setup move — many problems become trivial after sorting (intervals, greedy, two-pointer).

**Common Follow-Up Questions:**
- "When is merge sort better than quicksort?" — When stability matters (equal elements must retain original order) or when worst-case O(n²) is unacceptable (real-time systems).
- "How does TimSort work?" — Detects already-sorted runs in the input, merges them efficiently. O(n) on already-sorted data, O(n log n) worst case. Used in Java and Python.

**Gotcha:** Forgetting that Java's Arrays.sort() for primitives is NOT stable. If you need stable sort for primitives, use Arrays.sort() with boxed types (Integer instead of int) or Collections.sort().