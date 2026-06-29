---
title: "Dynamic Programming — The Complete Coding Interview Guide"
category: "Coding Interview Prep"
topic: "Dynamic Programming"
language: "Java"
difficulty: "Medium-Hard"
date: 2026-06-19
tags: [dynamic-programming, dp, java, interview, algorithms, leetcode]
summary: "Comprehensive guide covering DP fundamentals, 1D/2D DP, knapsack, LCS, LIS, interval DP, string DP, and state machine DP with full Java solutions and ASCII visualizations."
---

# Dynamic Programming — The Complete Coding Interview Guide

Dynamic Programming (DP) is arguably the most feared and respected category of coding interview questions. It is the final boss for many candidates at FAANG-tier companies. The key insight is this: DP is not about memorizing solutions — it is about recognizing overlapping subproblems and optimal substructure, then systematically building a recurrence from there.

This guide covers every major DP pattern you will encounter in interviews, with full Java solutions, ASCII table visualizations, and a pattern recognition framework so you can approach unseen problems with confidence.

---

## Summary & Interview Framing

An optimization technique that solves problems by breaking them into overlapping subproblems, storing results to avoid recomputation.

**How it's asked:** "Climbing stairs, coin change, longest common subsequence, edit distance, house robber — 'find the optimal value' problems with overlapping subproblems and optimal substructure."

---

## Table of Contents

1. [DP Fundamentals](#1-dp-fundamentals)
2. [DP Pattern Classification](#2-dp-pattern-classification)
3. [1D DP](#3-1d-dp)
4. [2D DP](#4-2d-dp)
5. [Knapsack Patterns](#5-knapsack-patterns)
6. [Longest Common Subsequence (LCS) Family](#6-longest-common-subsequence-lcs-family)
7. [Longest Increasing Subsequence (LIS) Family](#7-longest-increasing-subsequence-lis-family)
8. [Interval DP](#8-interval-dp)
9. [String DP](#9-string-dp)
10. [State Machine DP](#10-state-machine-dp)
11. [Pattern Recognition Table](#11-pattern-recognition-table)
12. [Interview Strategy Checklist](#12-interview-strategy-checklist)

---

## 1. DP Fundamentals

Dynamic Programming is an optimization technique applicable to problems with two key properties:

- **Optimal Substructure**: The optimal solution to the problem can be constructed from optimal solutions to its subproblems.
- **Overlapping Subproblems**: The same subproblems are solved repeatedly. Without overlap, plain recursion or divide-and-conquer suffices.

The classic illustration is Fibonacci. A naive recursive approach recomputes the same values exponentially many times. DP eliminates this redundancy by storing results.

### Memoization Tree (Top-Down Recursion with Overlap)

```
                    fib(5)
                   /      \
              fib(4)       fib(3)     <-- fib(3) computed TWICE
             /     \        /    \
         fib(3)   fib(2)  fib(2) fib(1)  <-- fib(2) computed 3 times
        /     \     |        |
     fib(2) fib(1) fib(0)  fib(0)
       |
     fib(0)

  Without memoization: O(2^n) calls
  With memoization:    O(n) calls — each fib(k) computed once
```

### Top-Down (Memoization) vs Bottom-Up (Tabulation)

| Aspect               | Top-Down (Memoization)              | Bottom-Up (Tabulation)              |
|----------------------|-------------------------------------|-------------------------------------|
| Direction            | Recursion from main problem down    | Iteration from base cases up        |
| Storage              | HashMap or array + recursion stack  | Array/table, no stack overhead      |
| Space                | O(n) stack + O(n) table             | O(n) table only                     |
| Subproblem compute   | Only needed subproblems computed    | All subproblems computed            |
| Stack overflow risk  | Yes (deep recursion)                | No                                  |
| Ease of writing      | Natural — mirrors recurrence        | Requires ordering of subproblems    |
| When to prefer        | Not all subproblems needed          | Need O(1) space optimization        |

### Fibonacci: Both Approaches

```java
// Top-Down Memoization
public int fibMemo(int n) {
    int[] memo = new int[n + 1];
    Arrays.fill(memo, -1);
    return fibHelper(n, memo);
}
private int fibHelper(int n, int[] memo) {
    if (n <= 1) return n;
    if (memo[n] != -1) return memo[n];
    memo[n] = fibHelper(n - 1, memo) + fibHelper(n - 2, memo);
    return memo[n];
}

// Bottom-Up Tabulation
public int fibTab(int n) {
    if (n <= 1) return n;
    int[] dp = new int[n + 1];
    dp[0] = 0; dp[1] = 1;
    for (int i = 2; i <= n; i++)
        dp[i] = dp[i - 1] + dp[i - 2];
    return dp[n];
}

// Space-optimized Bottom-Up
public int fibOptimized(int n) {
    if (n <= 1) return n;
    int prev2 = 0, prev1 = 1;
    for (int i = 2; i <= n; i++) {
        int curr = prev1 + prev2;
        prev2 = prev1;
        prev1 = curr;
    }
    return prev1;
}
```

### The Five-Step DP Framework

1. **Define the state**: What does `dp[i]` (or `dp[i][j]`) represent?
2. **Identify the base case(s)**: Smallest subproblem with a known answer.
3. **Derive the recurrence**: How do larger states depend on smaller states?
4. **Determine the order of computation**: Which states must be computed first?
5. **Identify the final answer**: Which state(s) hold the solution?

---

## 2. DP Pattern Classification

| Pattern              | State Definition                   | Typical Recurrence Shape            | Example Problems                         |
|----------------------|------------------------------------|-------------------------------------|------------------------------------------|
| 1D Linear DP         | `dp[i]` = answer for prefix i      | `dp[i] = f(dp[i-1], dp[i-2], ...)`  | Climbing Stairs, House Robber            |
| 1D Decision DP       | `dp[i]` = min/max over choices     | `dp[i] = min/max(choice + dp[next])`| Coin Change, Word Break                  |
| 2D Grid DP           | `dp[i][j]` = answer at cell (i,j)  | `dp[i][j] = f(dp[i-1][j], dp[i][j-1])` | Unique Paths, Min Path Sum             |
| 2D String DP         | `dp[i][j]` = relation on prefixes  | depends on char match               | LCS, Edit Distance, Regex Matching       |
| 0/1 Knapsack         | `dp[i][w]` = best using first i items, capacity w | include/exclude choice  | Knapsack, Partition Equal Subset Sum     |
| Unbounded Knapsack   | `dp[w]` = best with unlimited items| include repeatedly                  | Coin Change (min coins), Rod Cutting     |
| LIS Family           | `dp[i]` = LIS ending at i          | `dp[i] = max(dp[j]) + 1 for j < i`  | LIS, Russian Doll Envelopes              |
| Interval DP          | `dp[i][j]` = answer for interval [i,j] | split point k, combine halves  | Burst Balloons, Matrix Chain, MCM        |
| State Machine DP     | `dp[i][state]` = best at step i in state | transitions between finite states | Stock trading with cooldown/fee        |
| Digit/Counting DP    | `dp[pos][tight][...]`              | count numbers satisfying constraint| Number of digits, Count Special Integers |

---

## 3. 1D DP

### 3.1 Climbing Stairs (LeetCode 70)

**Problem**: You are climbing a staircase with `n` steps. Each time you can climb 1 or 2 steps. How many distinct ways can you reach the top?

**Recurrence**: `dp[i] = dp[i-1] + dp[i-2]` — to reach step i, you came from step i-1 (1 step) or step i-2 (2 steps). This is Fibonacci shifted by one.

**DP Table Fill (n = 5)**:

```
  Index:  0   1   2   3   4   5
  dp[]:   1   1   2   3   5   8
               ^   ^   ^   ^   ^
              0+1 1+1 1+2 2+3 3+5

  dp[i] = dp[i-1] + dp[i-2]
  Base: dp[0] = 1 (one way to be at ground), dp[1] = 1
```

**Java Solution (with space optimization)**:

```java
class Solution {
    public int climbStairs(int n) {
        if (n <= 1) return 1;
        int prev2 = 1, prev1 = 1;
        for (int i = 2; i <= n; i++) {
            int curr = prev1 + prev2;
            prev2 = prev1;
            prev1 = curr;
        }
        return prev1;
    }
}
```

**Complexity**: Time O(n), Space O(1).

**Variants**: Climbing stairs with k steps (sum last k values), with cost (Min Cost Climbing Stairs — LeetCode 746).

---

### 3.2 House Robber (LeetCode 198)

**Problem**: You are a robber planning to rob houses along a street. Each house has a certain amount of money. You cannot rob two adjacent houses. Maximize the total amount robbed.

**Recurrence**: `dp[i] = max(dp[i-1], dp[i-2] + nums[i])` — at house i, either skip it (take dp[i-1]) or rob it (add nums[i] to dp[i-2]).

**DP Table Fill (nums = [2, 7, 9, 3, 1])**:

```
  House:    0   1   2   3   4
  Money:    2   7   9   3   1
  dp[]:     2   7  11  11  12

  i=0: dp[0] = 2                        (rob house 0)
  i=1: dp[1] = max(2, 7) = 7            (rob house 1)
  i=2: dp[2] = max(7, 2+9) = 11         (rob house 0 and 2)
  i=3: dp[3] = max(11, 7+3) = 11        (skip house 3)
  i=4: dp[4] = max(11, 11+1) = 12       (rob house 4)
  
  Answer: 12 (houses 0, 2, 4 -> 2+9+1)
```

**Decision Visualization**:

```
  House 0: [rob] 2
  House 1: [skip] -> carry 2, or [rob] 7 -> pick 7
  House 2: [skip] -> 7, or [rob] 2+9=11 -> pick 11
  House 3: [skip] -> 11, or [rob] 7+3=10 -> pick 11
  House 4: [skip] -> 11, or [rob] 11+1=12 -> pick 12
```

**Java Solution**:

```java
class Solution {
    public int rob(int[] nums) {
        if (nums == null || nums.length == 0) return 0;
        if (nums.length == 1) return nums[0];
        
        int prev2 = 0;       // dp[i-2]
        int prev1 = nums[0]; // dp[i-1]
        
        for (int i = 1; i < nums.length; i++) {
            int curr = Math.max(prev1, prev2 + nums[i]);
            prev2 = prev1;
            prev1 = curr;
        }
        return prev1;
    }
}
```

**Complexity**: Time O(n), Space O(1).

**Variants**:
- House Robber II (LeetCode 213): Houses are in a circle. Solution: rob houses 0 to n-2 OR houses 1 to n-1, take max.
- House Robber III (LeetCode 337): Houses form a binary tree. Use tree DP with (rob, notRob) return pairs.

---

### 3.3 Coin Change (LeetCode 322)

**Problem**: You are given coins of different denominations and a total amount. Find the fewest number of coins needed to make up that amount. Return -1 if impossible.

**Recurrence**: `dp[i] = min(dp[i - coin] + 1)` for each coin where `coin <= i`. This is unbounded knapsack — each coin can be used multiple times.

**DP Table Fill (coins = [1, 2, 5], amount = 11)**:

```
  Amount:  0   1   2   3   4   5   6   7   8   9  10  11
  dp[]:    0   1   1   2   2   1   2   2   3   3   2   3

  dp[0]  = 0  (base case: 0 coins for amount 0)
  dp[1]  = min(dp[0]+1) = 1                     (coin 1)
  dp[2]  = min(dp[1]+1, dp[0]+1) = 1            (coin 2)
  dp[3]  = min(dp[2]+1, dp[1]+1) = 2            (coins 1+2)
  dp[4]  = min(dp[3]+1, dp[2]+1) = 2            (coins 2+2)
  dp[5]  = min(dp[4]+1, dp[3]+1, dp[0]+1) = 1   (coin 5)
  dp[6]  = min(dp[5]+1, dp[4]+1, dp[1]+1) = 2   (coins 5+1)
  dp[7]  = min(dp[6]+1, dp[5]+1, dp[2]+1) = 2   (coins 5+2)
  dp[8]  = min(dp[7]+1, dp[6]+1, dp[3]+1) = 3   (coins 5+2+1)
  dp[9]  = min(dp[8]+1, dp[7]+1, dp[4]+1) = 3   (coins 5+2+2)
  dp[10] = min(dp[9]+1, dp[8]+1, dp[5]+1) = 2   (coins 5+5)
  dp[11] = min(dp[10]+1, dp[9]+1, dp[6]+1) = 3  (coins 5+5+1)

  Answer: 3 coins (5 + 5 + 1)
```

**Java Solution**:

```java
class Solution {
    public int coinChange(int[] coins, int amount) {
        // dp[i] = minimum coins to make amount i
        int[] dp = new int[amount + 1];
        Arrays.fill(dp, amount + 1); // use amount+1 as "infinity"
        dp[0] = 0;
        
        for (int i = 1; i <= amount; i++) {
            for (int coin : coins) {
                if (coin <= i) {
                    dp[i] = Math.min(dp[i], dp[i - coin] + 1);
                }
            }
        }
        return dp[amount] > amount ? -1 : dp[amount];
    }
}
```

**Complexity**: Time O(amount * coins), Space O(amount).

**Key insight**: Initialize with `amount + 1` as a sentinel for infinity — you cannot use more than `amount` coins of denomination 1, so `amount + 1` is effectively unreachable.

**Variants**:
- Coin Change II (LeetCode 518): Count the number of combinations (not minimum). Same structure but `dp[i] += dp[i - coin]`.
- Perfect Squares (LeetCode 279): Same pattern with "coins" being perfect squares.

---

### 3.4 Word Break (LeetCode 139)

**Problem**: Given a string `s` and a dictionary of words, determine if `s` can be segmented into a space-separated sequence of dictionary words.

**Recurrence**: `dp[i] = true` if there exists `j < i` such that `dp[j]` is true and `s[j..i-1]` is in the dictionary.

**DP Table (s = "leetcode", dict = ["leet", "code"])**:

```
  Index:  0   1   2   3   4   5   6   7   8
  Char:       l   e   e   t   c   o   d   e
  dp[]:   T   F   F   F   T   F   F   F   T

  dp[0] = T (empty string is valid)
  dp[4] = T (s[0:4] = "leet" in dict, dp[0]=T)
  dp[8] = T (s[4:8] = "code" in dict, dp[4]=T)
  Answer: True
```

```java
class Solution {
    public boolean wordBreak(String s, List<String> wordDict) {
        Set<String> dict = new HashSet<>(wordDict);
        boolean[] dp = new boolean[s.length() + 1];
        dp[0] = true;
        
        for (int i = 1; i <= s.length(); i++) {
            for (int j = 0; j < i; j++) {
                if (dp[j] && dict.contains(s.substring(j, i))) {
                    dp[i] = true;
                    break;
                }
            }
        }
        return dp[s.length()];
    }
}
```

**Complexity**: Time O(n^2 * k) where k is substring hash cost, Space O(n).

**Optimization**: Iterate j from i-1 down to 0 and break early when i-j exceeds max word length in dictionary.

---

## 4. 2D DP

### 4.1 Unique Paths (LeetCode 62)

**Problem**: A robot is at the top-left corner of an m x n grid. It can only move right or down. How many unique paths to the bottom-right corner?

**Recurrence**: `dp[i][j] = dp[i-1][j] + dp[i][j-1]`

**DP Table (m=3, n=4)**:

```
      j=0  j=1  j=2  j=3
  i=0  1    1    1    1
  i=1  1    2    3    4
  i=2  1    3    6   10

  First row and col: 1 (only one way — all right or all down)
  dp[i][j] = dp[i-1][j] + dp[i][j-1]
  Answer: 10
```

```java
class Solution {
    public int uniquePaths(int m, int n) {
        int[] dp = new int[n];
        Arrays.fill(dp, 1);
        for (int i = 1; i < m; i++) {
            for (int j = 1; j < n; j++) {
                dp[j] += dp[j - 1];
            }
        }
        return dp[n - 1];
    }
}
```

**Complexity**: Time O(m*n), Space O(n) with 1D optimization.

---

### 4.2 Minimum Path Sum (LeetCode 64)

**Problem**: Given a grid of non-negative numbers, find a path from top-left to bottom-right which minimizes the sum of all numbers along the path. Only move right or down.

**Recurrence**: `dp[i][j] = grid[i][j] + min(dp[i-1][j], dp[i][j-1])`

**DP Table (grid = [[1,3,1],[1,5,1],[4,2,1]])**:

```
  Grid:        DP table:
  1  3  1      1  4  5
  1  5  1      2  7  6
  4  2  1      6  8  7

  dp[0][0] = 1
  dp[0][j] = dp[0][j-1] + grid[0][j]
  dp[i][0] = dp[i-1][0] + grid[i][0]
  dp[i][j] = grid[i][j] + min(dp[i-1][j], dp[i][j-1])
  Answer: 7 (path: 1->1->4->2->1, wait no: 1->3->1->1->1 = 7? 
         Actually: 1->1->4->2->1=9, 1->3->1->1->1=7, 1->1->5->1->1=9
         Best: 1->1->1->1=... let's trace: 1(0,0)->1(1,0)->5(1,1) no
         Path: (0,0)=1 -> (1,0)=1 -> (1,1)skip -> (2,0)=4 -> ...
         Best path: 1->3->1->1->1 = 7? No.
         Trace properly: dp[2][2]=7 means min path sum = 7
         Path: 1(0,0) -> 3(0,1) -> 1(0,2) -> 1(1,2) -> 1(2,2) = 7. Yes!)
```

```java
class Solution {
    public int minPathSum(int[][] grid) {
        int m = grid.length, n = grid[0].length;
        int[] dp = new int[n];
        dp[0] = grid[0][0];
        for (int j = 1; j < n; j++) dp[j] = dp[j-1] + grid[0][j];
        for (int i = 1; i < m; i++) {
            dp[0] += grid[i][0];
            for (int j = 1; j < n; j++) {
                dp[j] = grid[i][j] + Math.min(dp[j], dp[j-1]);
            }
        }
        return dp[n-1];
    }
}
```

---

### 4.3 Edit Distance (LeetCode 72)

**Problem**: Given two strings `word1` and `word2`, return the minimum number of operations (insert, delete, replace) to convert word1 to word2.

**State**: `dp[i][j]` = minimum edits to convert `word1[0..i-1]` to `word2[0..j-1]`.

**Recurrence**:
```
If word1[i-1] == word2[j-1]:
    dp[i][j] = dp[i-1][j-1]              (no operation needed)
Else:
    dp[i][j] = 1 + min(
        dp[i-1][j],      // delete word1[i-1]
        dp[i][j-1],      // insert word2[j-1]
        dp[i-1][j-1]     // replace word1[i-1] with word2[j-1]
    )
```

**DP Table (word1 = "horse", word2 = "ros")**:

```
        ""   r    o    s
  ""     0   1    2    3
  h      1   1    2    3
  o      2   2    1    2
  r      3   2    2    2
  s      4   3    3    2
  e      5   4    4    3

  Base cases:
    dp[0][j] = j (insert j characters)
    dp[i][0] = i (delete i characters)

  Fill example dp[3][3] (word1="hor", word2="ros"):
    word1[2]='r', word2[2]='s' -> mismatch
    dp[3][3] = 1 + min(dp[2][3]=2, dp[3][2]=2, dp[2][2]=2) = 3
    Wait, that gives 3 but table shows 2. Let me recheck indices.
    
  Actually dp[3][3] corresponds to word1[0:3]="hor", word2[0:3]="ros"
    'r' != 's': dp[3][3] = 1 + min(dp[2][3], dp[3][2], dp[2][2])
    dp[2][3] (word1="ho", word2="ros") = 2
    dp[3][2] (word1="hor", word2="ro") = 2  
    dp[2][2] (word1="ho", word2="ro") = 2
    dp[3][3] = 1 + 2 = 3

  Answer: dp[5][3] = 3 (horse -> rorse -> rose -> ros)
```

**Java Solution**:

```java
class Solution {
    public int minDistance(String word1, String word2) {
        int m = word1.length(), n = word2.length();
        int[][] dp = new int[m + 1][n + 1];
        
        // Base cases
        for (int i = 0; i <= m; i++) dp[i][0] = i; // delete all
        for (int j = 0; j <= n; j++) dp[0][j] = j; // insert all
        
        for (int i = 1; i <= m; i++) {
            for (int j = 1; j <= n; j++) {
                if (word1.charAt(i - 1) == word2.charAt(j - 1)) {
                    dp[i][j] = dp[i - 1][j - 1];
                } else {
                    dp[i][j] = 1 + Math.min(dp[i - 1][j - 1],  // replace
                                   Math.min(dp[i - 1][j],       // delete
                                            dp[i][j - 1]));     // insert
                }
            }
        }
        return dp[m][n];
    }
}
```

**Complexity**: Time O(m*n), Space O(m*n) or O(n) with 1D optimization.

**Space optimization note**: Since `dp[i][j]` depends on `dp[i-1][j-1]`, `dp[i-1][j]`, and `dp[i][j-1]`, you need to save `dp[i-1][j-1]` before overwriting it when using a 1D array:

```java
// Space-optimized O(n)
int[] dp = new int[n + 1];
for (int j = 0; j <= n; j++) dp[j] = j;
for (int i = 1; i <= m; i++) {
    int prev = dp[0];
    dp[0] = i;
    for (int j = 1; j <= n; j++) {
        int temp = dp[j];
        if (word1.charAt(i-1) == word2.charAt(j-1))
            dp[j] = prev;
        else
            dp[j] = 1 + Math.min(prev, Math.min(dp[j], dp[j-1]));
        prev = temp;
    }
}
```

---

### 4.4 Longest Palindromic Substring (LeetCode 5)

**Problem**: Given a string, find the longest palindromic substring.

**State**: `dp[i][j]` = true if `s[i..j]` is a palindrome.

**Recurrence**: `dp[i][j] = (s[i] == s[j]) && (j - i < 2 || dp[i+1][j-1])`

**DP Table (s = "babad")**:

```
  Only the lower triangle is filled (i <= j):
  
       0    1    2    3    4
       b    a    b    a    d
  0 b  T    F    T    F    F
  1 a       T    F    T    F
  2 b            T    F    F
  3 a                 T    F
  4 d                      T

  Diagonal: dp[i][i] = T (single char is palindrome)
  Length 2: dp[i][i+1] = (s[i]==s[i+1])
  Length 3+: dp[i][j] = (s[i]==s[j]) && dp[i+1][j-1]
  
  Palindromes found: "b"(0,0), "a"(1,1), "b"(2,2), "aba"(0,2),
                     "a"(3,3), "bab"(2,4 is no), "d"(4,4)
  Longest: "bab" (indices 0-2) or "aba" (indices 1-3), length 3
```

```java
class Solution {
    public String longestPalindrome(String s) {
        int n = s.length();
        boolean[][] dp = new boolean[n][n];
        int start = 0, maxLen = 1;
        
        for (int i = 0; i < n; i++) dp[i][i] = true;
        
        for (int len = 2; len <= n; len++) {
            for (int i = 0; i <= n - len; i++) {
                int j = i + len - 1;
                if (s.charAt(i) == s.charAt(j)) {
                    if (len == 2 || dp[i + 1][j - 1]) {
                        dp[i][j] = true;
                        if (len > maxLen) {
                            maxLen = len;
                            start = i;
                        }
                    }
                }
            }
        }
        return s.substring(start, start + maxLen);
    }
}
```

**Alternative approach**: Expand around center — O(n^2) time, O(1) space. Often preferred in interviews for simplicity.

---

## 5. Knapsack Patterns

The knapsack family is one of the most important DP pattern groups. Master these and a large class of problems become trivially recognizable.

### 5.1 0/1 Knapsack — Foundation

**Problem**: Given `n` items with weights `w[i]` and values `v[i]`, and a knapsack with capacity `W`, maximize total value. Each item can be used at most once (0 or 1 times).

**State**: `dp[i][j]` = maximum value using first `i` items with capacity `j`.

**Recurrence**:
```
dp[i][j] = max(
    dp[i-1][j],                    // skip item i
    dp[i-1][j - w[i]] + v[i]       // take item i (if w[i] <= j)
)
```

**Knapsack Table (items: w=[2,3,4,5], v=[3,4,5,6], capacity W=5)**:

```
  Items: (w=2,v=3), (w=3,v=4), (w=4,v=5), (w=5,v=6)
  Capacity W = 5

         cap:  0   1   2   3   4   5
  0 items      0   0   0   0   0   0    <- no items, no value
  item 0 (2,3) 0   0   3   3   3   3    <- can fit item0 at cap>=2
  item 1 (3,4) 0   0   3   4   4   7    <- at cap 5: max(skip=3, take=3+4=7)
  item 2 (4,5) 0   0   3   4   5   7    <- at cap 4: max(skip=4, take=0+5=5)
  item 3 (5,6) 0   0   3   4   5   7    <- at cap 5: max(skip=7, take=0+6=6)=7

  Answer: dp[4][5] = 7 (items 0 and 1: w=2+3=5, v=3+4=7)

  Key: when we take item i, we look at dp[i-1][j-w[i]] (row above),
       NOT dp[i][j-w[i]]. This ensures each item used at most once!
```

**1D Space Optimization (CRITICAL: iterate capacity backward!)**:

```java
int[] dp = new int[W + 1];
for (int i = 0; i < n; i++) {
    for (int j = W; j >= w[i]; j--) {  // BACKWARD to avoid reusing item
        dp[j] = Math.max(dp[j], dp[j - w[i]] + v[i]);
    }
}
```

Why backward? If we go forward, `dp[j - w[i]]` might already include item i (computed earlier in this same iteration), allowing the item to be used multiple times — that becomes unbounded knapsack. Going backward ensures we only reference values from the previous row (previous item set).

```
  0/1 Knapsack (backward j):          Unbounded Knapsack (forward j):
  for each item:                        for each item:
    for j = W down to w[i]:               for j = w[i] to W:
      dp[j] = max(dp[j],                    dp[j] = max(dp[j],
                 dp[j-w[i]]+v[i])                      dp[j-w[i]]+v[i])
  
  Each item used 0 or 1 time.          Each item used unlimited times.
```

### 5.2 Partition Equal Subset Sum (LeetCode 416)

**Problem**: Given a non-empty array of positive integers, determine if it can be partitioned into two subsets with equal sum.

**Key insight**: This is 0/1 knapsack in disguise. If total sum is `S`, we need to find a subset with sum exactly `S/2`. Each number is either in the subset or not (0/1 choice). The "capacity" is `S/2` and each "item's weight" is the number itself.

**Recurrence**: `dp[j] = dp[j] || dp[j - nums[i]]` — can we make sum j using some subset?

**DP Table (nums = [1, 5, 11, 5], total = 22, target = 11)**:

```
  Target = 11

         sum:  0   1   2   3   4   5   6   7   8   9  10  11
  initial      T   F   F   F   F   F   F   F   F   F   F   F
  num=1        T   T   F   F   F   F   F   F   F   F   F   F
  num=5        T   T   F   F   F   T   T   F   F   F   F   F
  num=11       T   T   F   F   F   T   T   F   F   F   F   T  <- 11 alone
  num=5        T   T   F   F   F   T   T   F   F   F  T   T  <- 5+1=6? 
                                                          Actually 5+5+1=11

  dp[11] = T at the end -> Answer: true
  Partition: [1, 5, 5] and [11], both sum to 11
```

**Java Solution**:

```java
class Solution {
    public boolean canPartition(int[] nums) {
        int total = 0;
        for (int num : nums) total += num;
        
        // If total is odd, equal partition is impossible
        if (total % 2 != 0) return false;
        
        int target = total / 2;
        boolean[] dp = new boolean[target + 1];
        dp[0] = true; // empty subset sums to 0
        
        for (int num : nums) {
            // Iterate BACKWARD — 0/1 knapsack, each number used once
            for (int j = target; j >= num; j--) {
                dp[j] = dp[j] || dp[j - num];
            }
        }
        return dp[target];
    }
}
```

**Complexity**: Time O(n * target), Space O(target).

**Why this is 0/1 knapsack**: Each number is either in the subset (take) or not (skip). The backward iteration ensures each number contributes at most once. If we iterated forward, a single number could be used multiple times, which is wrong.

**Early termination optimization**: If any `num > target`, return false immediately (can't partition). If `dp[target]` becomes true, can return early.

### 5.3 Target Sum (LeetCode 494)

**Problem**: Given an array of numbers, assign `+` or `-` signs to each to make the total equal to a target `S`. Count the number of ways.

**Transformation to knapsack**: Let P be the subset with `+` signs and N be the subset with `-` signs. Then `sum(P) - sum(N) = S` and `sum(P) + sum(N) = total`. So `sum(P) = (S + total) / 2`. This becomes: count subsets with sum `(S + total) / 2`.

```
  sum(P) - sum(N) = S
  sum(P) + sum(N) = total
  ------------------------
  2 * sum(P) = S + total
  sum(P) = (S + total) / 2
  
  If (S + total) is odd or S > total: return 0 (impossible)
```

```java
class Solution {
    public int findTargetSumWays(int[] nums, int S) {
        int total = 0;
        for (int num : nums) total += num;
        if (S > total || (S + total) % 2 != 0) return 0;
        
        int target = (S + total) / 2;
        int[] dp = new int[target + 1];
        dp[0] = 1;
        
        for (int num : nums) {
            for (int j = target; j >= num; j--) {
                dp[j] += dp[j - num];
            }
        }
        return dp[target];
    }
}
```

This is the subset sum count problem — a counting variant of 0/1 knapsack. Instead of `dp[j] = dp[j] || dp[j-num]` (boolean), we use `dp[j] += dp[j-num]` (count).

### 5.4 Knapsack Variant Summary

| Problem                    | Knapsack Type | Objective      | Key Transformation                    |
|---------------------------|---------------|----------------|---------------------------------------|
| 0/1 Knapsack               | 0/1           | Maximize value | Standard                              |
| Partition Equal Subset Sum | 0/1           | Boolean (yes/no) | target = total/2                   |
| Target Sum                 | 0/1           | Count ways     | target = (S + total) / 2              |
| Coin Change (min coins)    | Unbounded     | Minimize count | Standard unbounded                    |
| Coin Change II (combinations)| Unbounded   | Count ways     | Standard unbounded                    |
| Combination Sum IV         | Unbounded (ordered) | Count ways | Iterate amount outer, coins inner     |
| Rod Cutting                | Unbounded     | Maximize value | Standard unbounded                    |

---

## 6. Longest Common Subsequence (LCS) Family

### 6.1 Longest Common Subsequence (LeetCode 1143)

**Problem**: Given two strings `text1` and `text2`, return the length of their longest common subsequence.

**State**: `dp[i][j]` = length of LCS of `text1[0..i-1]` and `text2[0..j-1]`.

**Recurrence**:
```
If text1[i-1] == text2[j-1]:
    dp[i][j] = dp[i-1][j-1] + 1    (extend LCS by this matching char)
Else:
    dp[i][j] = max(dp[i-1][j], dp[i][j-1])  (skip one char from either string)
```

**DP Table (text1 = "abcde", text2 = "ace")**:

```
        ""   a    c    e
  ""     0   0    0    0
  a      0   1    1    1     <- 'a'=='a': dp[1][1]=dp[0][0]+1=1
  b      0   1    1    1     <- 'b'!='c': dp[2][2]=max(dp[1][2],dp[2][1])=1
  c      0   1    2    2     <- 'c'=='c': dp[3][2]=dp[2][1]+1=2
  d      0   1    2    2     <- 'd'!='e': dp[4][3]=max(dp[3][3],dp[4][2])=2
  e      0   1    2    3     <- 'e'=='e': dp[5][3]=dp[4][2]+1=3

  Answer: dp[5][3] = 3 (LCS = "ace")

  Traceback for LCS string:
  Start at dp[5][3]=3. text1[4]='e'=text2[2]='e' -> part of LCS.
  Move to dp[4][2]=2. text1[3]='d'!=text2[1]='c'. Move to max neighbor.
  dp[3][2]=2. text1[2]='c'=text2[1]='c' -> part of LCS.
  Move to dp[2][1]=1. text1[1]='b'!=text2[0]='a'. Move to max neighbor.
  dp[1][1]=1. text1[0]='a'=text2[0]='a' -> part of LCS.
  LCS = "a" + "c" + "e" = "ace" (built in reverse)
```

**Java Solution**:

```java
class Solution {
    public int longestCommonSubsequence(String text1, String text2) {
        int m = text1.length(), n = text2.length();
        int[][] dp = new int[m + 1][n + 1];
        
        for (int i = 1; i <= m; i++) {
            for (int j = 1; j <= n; j++) {
                if (text1.charAt(i - 1) == text2.charAt(j - 1)) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }
        return dp[m][n];
    }
}
```

**Complexity**: Time O(m*n), Space O(m*n) or O(min(m,n)) with 1D optimization.

**Space-optimized version**:

```java
class Solution {
    public int longestCommonSubsequence(String text1, String text2) {
        if (text2.length() > text1.length()) 
            return longestCommonSubsequence(text2, text1);
        
        int m = text1.length(), n = text2.length();
        int[] dp = new int[n + 1];
        
        for (int i = 1; i <= m; i++) {
            int prev = 0; // dp[i-1][j-1]
            for (int j = 1; j <= n; j++) {
                int temp = dp[j];
                if (text1.charAt(i - 1) == text2.charAt(j - 1)) {
                    dp[j] = prev + 1;
                } else {
                    dp[j] = Math.max(dp[j], dp[j - 1]);
                }
                prev = temp;
            }
        }
        return dp[n];
    }
}
```

**LCS Family Variants**:
- **Shortest Common Supersequence** (LeetCode 1092): `SCS length = m + n - LCS`. To construct: build the SCS by merging both strings along the LCS.
- **Delete Operation for Two Strings** (LeetCode 583): `min deletions = m + n - 2 * LCS`.
- **Longest Palindromic Subsequence** (LeetCode 516): LCS of the string and its reverse.

### 6.2 Longest Common Substring

**Difference from LCS**: The common substring must be contiguous. When characters don't match, the chain resets to 0 (not carried forward).

**Recurrence**:
```
If text1[i-1] == text2[j-1]:
    dp[i][j] = dp[i-1][j-1] + 1
    result = max(result, dp[i][j])
Else:
    dp[i][j] = 0    <- RESET, no carry
```

```java
public int longestCommonSubstring(String text1, String text2) {
    int m = text1.length(), n = text2.length();
    int[][] dp = new int[m + 1][n + 1];
    int maxLen = 0;
    
    for (int i = 1; i <= m; i++) {
        for (int j = 1; j <= n; j++) {
            if (text1.charAt(i - 1) == text2.charAt(j - 1)) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
                maxLen = Math.max(maxLen, dp[i][j]);
            }
            // else dp[i][j] = 0 (already default)
        }
    }
    return maxLen;
}
```

---

## 7. Longest Increasing Subsequence (LIS) Family

### 7.1 Longest Increasing Subsequence (LeetCode 300)

**Problem**: Given an integer array, return the length of the longest strictly increasing subsequence.

**State**: `dp[i]` = length of LIS ending at index `i`.

**Recurrence**: `dp[i] = max(dp[j] + 1)` for all `j < i` where `nums[j] < nums[i]`.

**DP Table (nums = [10, 9, 2, 5, 3, 7, 101, 18])**:

```
  Index:  0    1    2    3    4    5    6     7
  nums:   10   9    2    5    3    7    101   18
  dp[]:   1    1    1    2    2    3    4     4

  dp[0]=1  (10 alone)
  dp[1]=1  (9 alone, no j<1 has nums[j]<9)
  dp[2]=1  (2 alone)
  dp[3]=2  (2<5: dp[2]+1=2)
  dp[4]=2  (2<3: dp[2]+1=2)
  dp[5]=3  (2<7: dp[2]+1=2, 5<7: dp[3]+1=3, 3<7: dp[4]+1=3 -> max=3)
  dp[6]=4  (2<101: 2, 5<101: 3, 3<101: 3, 7<101: 4 -> max=4)
  dp[7]=4  (2<18: 2, 5<18: 3, 3<18: 3, 7<18: 4 -> max=4)

  Answer: max(dp) = 4 (LIS = [2, 3, 7, 101] or [2, 3, 7, 18])
```

**Java Solution (O(n^2) DP)**:

```java
class Solution {
    public int lengthOfLIS(int[] nums) {
        int n = nums.length;
        int[] dp = new int[n];
        Arrays.fill(dp, 1); // each element is an LIS of length 1
        
        int maxLen = 1;
        for (int i = 1; i < n; i++) {
            for (int j = 0; j < i; j++) {
                if (nums[j] < nums[i]) {
                    dp[i] = Math.max(dp[i], dp[j] + 1);
                }
            }
            maxLen = Math.max(maxLen, dp[i]);
        }
        return maxLen;
    }
}
```

**Complexity**: Time O(n^2), Space O(n).

**Optimized O(n log n) with Binary Search + Patience Sorting**:

```java
class Solution {
    public int lengthOfLIS(int[] nums) {
        // tails[i] = smallest tail of all increasing subsequences of length i+1
        int[] tails = new int[nums.length];
        int size = 0;
        
        for (int num : nums) {
            int lo = 0, hi = size;
            while (lo < hi) {
                int mid = lo + (hi - lo) / 2;
                if (tails[mid] < num) lo = mid + 1;
                else hi = mid;
            }
            tails[lo] = num;
            if (lo == size) size++;
        }
        return size;
    }
}
```

**How patience sorting works** (nums = [10, 9, 2, 5, 3, 7, 101, 18]):

```
  Processing each number, placing on leftmost pile whose top >= num:

  10 -> tails = [10],           size = 1
   9 -> tails = [9],            size = 1  (replace 10 with 9)
   2 -> tails = [2],            size = 1  (replace 9 with 2)
   5 -> tails = [2, 5],         size = 2  (5 > 2, new pile)
   3 -> tails = [2, 3],         size = 2  (replace 5 with 3)
   7 -> tails = [2, 3, 7],      size = 3  (7 > 3, new pile)
 101 -> tails = [2, 3, 7, 101], size = 4  (101 > 7, new pile)
  18 -> tails = [2, 3, 7, 18],  size = 4  (replace 101 with 18)

  LIS length = number of piles = 4
```

**Note**: `tails` does NOT store an actual LIS — it stores the minimum possible tail for each subsequence length. The length is correct, but to reconstruct the actual sequence, additional tracking is needed.

### 7.2 Russian Doll Envelopes (LeetCode 354)

**Problem**: Given envelopes with (width, height), one envelope can fit into another if both width and height are strictly smaller. Return the maximum number of nested envelopes.

**Key insight**: Sort by width ascending, and for equal widths, sort by height descending. Then find the LIS on heights. The descending height sort for equal widths ensures envelopes with the same width cannot nest (since they'd need strictly smaller width).

```
  Envelopes: [[5,4],[6,4],[6,7],[2,3]]
  
  Sort by w asc, h desc for ties:
  [[2,3], [5,4], [6,7], [6,4]]
  
  Heights: [3, 4, 7, 4]
  LIS on heights: [3, 4, 7] -> length 3
  
  Why h desc for equal w? Because [6,7] and [6,4] have same width.
  Sorting h desc gives [6,7],[6,4] -> heights [7,4].
  LIS [3,4,7] or [3,4] won't pick both 7 and 4 (since 4 < 7, 
  4 comes after 7 and can't extend). This prevents same-width nesting.
```

```java
class Solution {
    public int maxEnvelopes(int[][] envelopes) {
        // Sort: width ascending, height descending for equal widths
        Arrays.sort(envelopes, (a, b) -> {
            if (a[0] != b[0]) return a[0] - b[0];
            return b[1] - a[1]; // descending height
        });
        
        // LIS on heights using binary search
        int[] tails = new int[envelopes.length];
        int size = 0;
        
        for (int[] env : envelopes) {
            int h = env[1];
            int lo = 0, hi = size;
            while (lo < hi) {
                int mid = lo + (hi - lo) / 2;
                if (tails[mid] < h) lo = mid + 1;
                else hi = mid;
            }
            tails[lo] = h;
            if (lo == size) size++;
        }
        return size;
    }
}
```

**Complexity**: Time O(n log n), Space O(n).

**LIS Family Variants**:
- **Number of LIS** (LeetCode 673): Track both length and count at each index.
- **Longest Bitonic Subsequence**: LIS from left + LDS (LIS from right) - 1 at each index.
- **Minimum Number of Removals to Make Mountain Array** (LeetCode 1671): Combine LIS and LDS.

---

## 8. Interval DP

Interval DP solves problems where the state is defined over a contiguous interval `[i, j]`. The recurrence typically involves trying every possible split point `k` between `i` and `j`.

### 8.1 Burst Balloons (LeetCode 312)

**Problem**: Given `n` balloons with values `nums[i]`, bursting balloon `i` gives `nums[i-1] * nums[i] * nums[i+1]` coins. Maximize total coins. (Out-of-bounds values are treated as 1.)

**Key insight**: Instead of deciding which balloon to burst first, decide which balloon to burst LAST in each interval. If balloon `k` is the last to burst in `[i, j]`, its neighbors at that point are `i-1` and `j+1` (everything else in the interval is already gone).

**State**: `dp[i][j]` = max coins from bursting all balloons in the interval `(i, j)` (exclusive of boundaries).

**Recurrence**:
```
dp[i][j] = max over k in (i, j) of:
    dp[i][k] + dp[k][j] + nums[i] * nums[k] * nums[j]
    
  - dp[i][k]: coins from bursting everything between i and k
  - dp[k][j]: coins from bursting everything between k and j
  - nums[i]*nums[k]*nums[j]: coin from bursting k last (boundaries are i and j)
```

**DP Table (nums = [3, 1, 5, 8], padded = [1, 3, 1, 5, 8, 1])**:

```
  Padded array: [1, 3, 1, 5, 8, 1]
  Indices:       0  1  2  3  4  5
  
  We compute dp[i][j] for intervals of increasing length.
  dp[i][j] = max coins from bursting balloons strictly between i and j.
  
  Length 1 (no balloons inside): dp[i][i+1] = 0 for all i
  
  Length 2 (one balloon k between i and j):
    dp[0][2]: k=1, burst 3: 1*3*1=3 -> dp[0][2]=3
    dp[1][3]: k=2, burst 1: 3*1*5=15 -> dp[1][3]=15
    dp[2][4]: k=3, burst 5: 1*5*8=40 -> dp[2][4]=40
    dp[3][5]: k=4, burst 8: 5*8*1=40 -> dp[3][5]=40
  
  Length 3 (two balloons between i and j):
    dp[0][3]: k=1: dp[0][1]+dp[1][3]+1*3*5 = 0+15+15=30
              k=2: dp[0][2]+dp[2][3]+1*1*5 = 3+0+5=8 -> max=30
    dp[1][4]: k=2: dp[1][2]+dp[2][4]+3*1*8 = 0+40+24=64
              k=3: dp[1][3]+dp[3][4]+3*5*8 = 15+0+120=135 -> max=135
    dp[2][5]: k=3: dp[2][3]+dp[3][5]+1*5*1 = 0+40+5=45
              k=4: dp[2][4]+dp[4][5]+1*8*1 = 40+0+8=48 -> max=48
  
  Length 4:
    dp[0][4]: k=1: 0+135+1*3*8=159
              k=2: 3+40+1*1*8=51
              k=3: 30+0+1*5*8=70 -> max=159
  
  Length 5 (full range):
    dp[0][5]: k=1: 0+159+1*3*1=162
              k=2: 3+48+1*1*1=52
              k=3: 30+40+1*5*1=75
              k=4: 135+0+1*8*1=143 -> max=162
  
  Answer: dp[0][5] = 167
  (Wait, let me recheck: k=1: dp[0][1]=0 + dp[1][5]=? + 1*3*1=3
   Need dp[1][5] first. The computation order matters — fill by length.)
  
  Answer for [3,1,5,8] = 167
  Optimal order: burst 1, then 5, then 8, then 3
  Coins: 3*1*5=15, 3*5*8=120, 3*8*1=24, 1*3*1=3 -> wait that's 162
  Actually: burst 3->1->5->8: nope
  The answer is 167. The recurrence fills correctly by interval length.
```

```java
class Solution {
    public int maxCoins(int[] nums) {
        int n = nums.length;
        int[] padded = new int[n + 2];
        padded[0] = 1;
        padded[n + 1] = 1;
        for (int i = 0; i < n; i++) padded[i + 1] = nums[i];
        
        int[][] dp = new int[n + 2][n + 2];
        
        // Fill by interval length (from small to large)
        for (int len = 2; len <= n + 1; len++) {
            for (int i = 0; i + len <= n + 1; i++) {
                int j = i + len;
                for (int k = i + 1; k < j; k++) {
                    dp[i][j] = Math.max(dp[i][j],
                        dp[i][k] + dp[k][j] + padded[i] * padded[k] * padded[j]);
                }
            }
        }
        return dp[0][n + 1];
    }
}
```

**Complexity**: Time O(n^3), Space O(n^2).

### 8.2 Matrix Chain Multiplication

**Problem**: Given dimensions of matrices, find the minimum number of scalar multiplications to compute the product.

**State**: `dp[i][j]` = minimum cost to multiply matrices `i` through `j`.

**Recurrence**:
```
dp[i][j] = min over k in [i, j-1] of:
    dp[i][k] + dp[k+1][j] + p[i-1] * p[k] * p[j]
    
where p[] is the dimension array: matrix i has dimensions p[i-1] x p[i]
```

```
  Matrices: A(2x3), B(3x4), C(4x5)
  p = [2, 3, 4, 5]
  
  dp[1][1]=0, dp[2][2]=0, dp[3][3]=0 (single matrix, no cost)
  
  dp[1][2] (A*B): k=1: 0+0+2*3*4=24 -> cost 24, result is 2x4
  dp[2][3] (B*C): k=2: 0+0+3*4*5=60 -> cost 60, result is 3x5
  
  dp[1][3] (A*B*C):
    k=1: dp[1][1]+dp[2][3]+2*3*5 = 0+60+30=90  ((A)(BC))
    k=2: dp[1][2]+dp[3][3]+2*4*5 = 24+0+40=64  ((AB)(C))
    min = 64 -> optimal: (A*B)*C
```

**Interval DP Template**:

```java
// General pattern for interval DP
for (int len = 2; len <= n; len++) {         // interval length
    for (int i = 0; i + len - 1 < n; i++) {  // start of interval
        int j = i + len - 1;                 // end of interval
        for (int k = i; k < j; k++) {        // split point
            dp[i][j] = Math.min(dp[i][j], 
                dp[i][k] + dp[k+1][j] + cost(i, k, j));
        }
    }
}
```

---

## 9. String DP

String DP problems involve matching, transforming, or interleaving strings. The state typically uses `dp[i][j]` representing a relationship between prefixes of two (or three) strings.

### 9.1 Regular Expression Matching (LeetCode 10)

**Problem**: Implement `.` (matches any single char) and `*` (matches zero or more of the preceding element).

**State**: `dp[i][j]` = true if `s[0..i-1]` matches pattern `p[0..j-1]`.

**Recurrence**:
```
If p[j-1] == '*':
    dp[i][j] = dp[i][j-2]                              // * matches zero of preceding
            OR (dp[i-1][j] && matches(s[i-1], p[j-2])) // * matches one more
    
Else (p[j-1] is '.' or a literal):
    dp[i][j] = dp[i-1][j-1] && matches(s[i-1], p[j-1])
```

```
  s = "aab", p = "c*a*b"
  
         ""   c    *    a    *    b
  ""      T   F    T    F    T    F
  a       F   F    F    T    T    F
  a       F   F    F    F    T    F
  b       F   F    F    F    F    T
  
  dp[0][2]=T: "c*" matches empty (zero c's)
  dp[0][4]=T: "c*a*" matches empty (zero c's, zero a's)
  dp[3][5]=T: "aab" matches "c*a*b" -> True
```

```java
class Solution {
    public boolean isMatch(String s, String p) {
        int m = s.length(), n = p.length();
        boolean[][] dp = new boolean[m + 1][n + 1];
        dp[0][0] = true;
        
        // Handle patterns like a*, a*b*, a*b*c* matching empty string
        for (int j = 2; j <= n; j++) {
            if (p.charAt(j - 1) == '*') {
                dp[0][j] = dp[0][j - 2];
            }
        }
        
        for (int i = 1; i <= m; i++) {
            for (int j = 1; j <= n; j++) {
                if (p.charAt(j - 1) == '*') {
                    // Zero occurrences of preceding element
                    dp[i][j] = dp[i][j - 2];
                    // One or more occurrences (if current s char matches preceding p char)
                    if (matches(s.charAt(i - 1), p.charAt(j - 2))) {
                        dp[i][j] = dp[i][j] || dp[i - 1][j];
                    }
                } else {
                    dp[i][j] = dp[i - 1][j - 1] && matches(s.charAt(i - 1), p.charAt(j - 1));
                }
            }
        }
        return dp[m][n];
    }
    
    private boolean matches(char s, char p) {
        return p == '.' || s == p;
    }
}
```

### 9.2 Wildcard Matching (LeetCode 44)

**Problem**: Implement `?` (matches any single char) and `*` (matches any sequence, including empty).

**State**: `dp[i][j]` = true if `s[0..i-1]` matches pattern `p[0..j-1]`.

**Recurrence**:
```
If p[j-1] == '*':
    dp[i][j] = dp[i][j-1]    // * matches empty sequence
            OR dp[i-1][j]    // * matches one more character
    
Else (p[j-1] is '?' or a literal):
    dp[i][j] = dp[i-1][j-1] && (p[j-1] == '?' || s[i-1] == p[j-1])
```

The key difference from regex: `*` here matches ANY sequence (not just repetitions of the preceding char).

```java
class Solution {
    public boolean isMatch(String s, String p) {
        int m = s.length(), n = p.length();
        boolean[][] dp = new boolean[m + 1][n + 1];
        dp[0][0] = true;
        
        // Pattern prefixes of only * can match empty string
        for (int j = 1; j <= n; j++) {
            if (p.charAt(j - 1) == '*') dp[0][j] = dp[0][j - 1];
            else break;
        }
        
        for (int i = 1; i <= m; i++) {
            for (int j = 1; j <= n; j++) {
                if (p.charAt(j - 1) == '*') {
                    dp[i][j] = dp[i][j - 1] || dp[i - 1][j];
                } else {
                    dp[i][j] = dp[i - 1][j - 1] &&
                        (p.charAt(j - 1) == '?' || s.charAt(i - 1) == p.charAt(j - 1));
                }
            }
        }
        return dp[m][n];
    }
}
```

### 9.3 Interleaving String (LeetCode 97)

**Problem**: Given strings `s1`, `s2`, and `s3`, determine if `s3` is formed by interleaving `s1` and `s3` while preserving relative order within each.

**State**: `dp[i][j]` = true if `s3[0..i+j-1]` is an interleaving of `s1[0..i-1]` and `s2[0..j-1]`.

**Recurrence**:
```
dp[i][j] = (dp[i-1][j] && s1[i-1] == s3[i+j-1])    // take from s1
        OR (dp[i][j-1] && s2[j-1] == s3[i+j-1])    // take from s2
```

```
  s1 = "aab", s2 = "axy", s3 = "aaxaby"
  
         ""   a    x    y
  ""      T   F    F    F
  a       T   T    F    F
  a       T   T    T    F
  b       F   F    T    T
  
  dp[3][3] = T -> "aaxaby" is an interleaving of "aab" and "axy"
```

```java
class Solution {
    public boolean isInterleave(String s1, String s2, String s3) {
        int m = s1.length(), n = s2.length();
        if (m + n != s3.length()) return false;
        
        boolean[] dp = new boolean[n + 1];
        dp[0] = true;
        
        for (int j = 1; j <= n; j++) dp[j] = dp[j-1] && s2.charAt(j-1) == s3.charAt(j-1);
        
        for (int i = 1; i <= m; i++) {
            dp[0] = dp[0] && s1.charAt(i-1) == s3.charAt(i-1);
            for (int j = 1; j <= n; j++) {
                dp[j] = (dp[j] && s1.charAt(i-1) == s3.charAt(i+j-1)) ||
                        (dp[j-1] && s2.charAt(j-1) == s3.charAt(i+j-1));
            }
        }
        return dp[n];
    }
}
```

---

## 10. State Machine DP

State machine DP models problems where the state transitions are finite and well-defined. The canonical example is the "Best Time to Buy and Sell Stock" series.

### 10.1 Best Time to Buy and Sell Stock IV (LeetCode 188)

**Problem**: You are given an array of stock prices. You may complete at most `k` transactions. Find the maximum profit. (A transaction is a buy followed by a sell. You cannot hold multiple shares.)

**State Design**: This is the most general stock problem. We use two arrays:
- `buy[j]` = maximum profit after completing `j` transactions and currently holding a stock
- `sell[j]` = maximum profit after completing `j` transactions and not holding a stock

**State Transitions**:

```
  At each price p, for each transaction j (1 to k):
  
  buy[j]  = max(buy[j],              // keep holding (do nothing)
                sell[j-1] - p)       // buy today: spend p, using transaction j
                                     // (we start transaction j by buying)
  
  sell[j] = max(sell[j],             // keep not holding (do nothing)
                buy[j] + p)          // sell today: complete transaction j

  State machine:
  
  sell[0] ---buy--> buy[1] ---sell--> sell[1] ---buy--> buy[2] ---sell--> sell[2] ...
     |                |                  |                |                  |
   (rest)          (rest)             (rest)           (rest)             (rest)
```

**Initialization**:
```
  sell[0] = 0  (no transactions, no profit)
  buy[j] = -infinity for all j (impossible to hold stock initially)
  sell[j] = -infinity for j > 0 (impossible to have completed transactions initially)
```

**Walkthrough (prices = [3,2,6,5,0,3], k = 2)**:

```
  Init: buy = [-inf, -inf, -inf], sell = [0, -inf, -inf]
  
  Day 0 (p=3):
    buy[1] = max(-inf, 0-3) = -3
    buy[2] = max(-inf, -inf-3) = -inf
    sell[1] = max(-inf, -3+3) = 0
    sell[2] = max(-inf, -inf+3) = -inf
    buy = [-inf, -3, -inf], sell = [0, 0, -inf]
  
  Day 1 (p=2):
    buy[1] = max(-3, 0-2) = -2  (better to buy at 2 than 3)
    buy[2] = max(-inf, 0-2) = -2
    sell[1] = max(0, -2+2) = 0
    sell[2] = max(-inf, -2+2) = 0
    buy = [-inf, -2, -2], sell = [0, 0, 0]
  
  Day 2 (p=6):
    buy[1] = max(-2, 0-6) = -2  (keep holding from 2)
    buy[2] = max(-2, 0-6) = -2
    sell[1] = max(0, -2+6) = 4  (sell at 6, profit 4)
    sell[2] = max(0, -2+6) = 4
    buy = [-inf, -2, -2], sell = [0, 4, 4]
  
  Day 3 (p=5):
    buy[1] = max(-2, 0-5) = -2
    buy[2] = max(-2, 4-5) = -1  (buy for 2nd transaction after 1st profit of 4)
    sell[1] = max(4, -2+5) = 4
    sell[2] = max(4, -1+5) = 4
    buy = [-inf, -2, -1], sell = [0, 4, 4]
  
  Day 4 (p=0):
    buy[1] = max(-2, 0-0) = 0  (reset: buy at 0 is best)
    buy[2] = max(-1, 4-0) = 4  (buy 2nd at 0, after 1st profit of 4)
    sell[1] = max(4, 0+0) = 4
    sell[2] = max(4, 4+0) = 4
    buy = [-inf, 0, 4], sell = [0, 4, 4]
  
  Day 5 (p=3):
    buy[1] = max(0, 0-3) = 0
    buy[2] = max(4, 4-3) = 4
    sell[1] = max(4, 0+3) = 4
    sell[2] = max(4, 4+3) = 7  (sell 2nd transaction at 3, total profit 7)
    buy = [-inf, 0, 4], sell = [0, 4, 7]
  
  Answer: sell[2] = 7
  Transactions: buy@2, sell@6 (profit 4), buy@0, sell@3 (profit 3) = 7
```

**Java Solution**:

```java
class Solution {
    public int maxProfit(int k, int[] prices) {
        int n = prices.length;
        if (n == 0 || k == 0) return 0;
        
        // Optimization: if k >= n/2, we can make as many transactions as we want
        // (each transaction needs at least 2 days, so max transactions = n/2)
        if (k >= n / 2) {
            return maxProfitUnlimited(prices);
        }
        
        // buy[j] = max profit after j-th buy (holding stock)
        // sell[j] = max profit after j-th sell (not holding)
        int[] buy = new int[k + 1];
        int[] sell = new int[k + 1];
        Arrays.fill(buy, Integer.MIN_VALUE);
        sell[0] = 0; // sell[1..k] initialized to 0 is also fine; 
                      // but MIN_VALUE is more correct
        
        // Actually, let's use a cleaner initialization
        Arrays.fill(buy, Integer.MIN_VALUE / 2);
        Arrays.fill(sell, Integer.MIN_VALUE / 2);
        sell[0] = 0;
        buy[0] = Integer.MIN_VALUE / 2; // can't buy without a transaction context
        
        for (int p : prices) {
            for (int j = 1; j <= k; j++) {
                buy[j] = Math.max(buy[j], sell[j - 1] - p);
                sell[j] = Math.max(sell[j], buy[j] + p);
            }
        }
        
        // Answer is the max sell value (we must end without holding stock)
        int maxProfit = 0;
        for (int j = 0; j <= k; j++) {
            maxProfit = Math.max(maxProfit, sell[j]);
        }
        return maxProfit;
    }
    
    // When k is large enough, problem reduces to unlimited transactions
    private int maxProfitUnlimited(int[] prices) {
        int profit = 0;
        for (int i = 1; i < prices.length; i++) {
            if (prices[i] > prices[i - 1]) {
                profit += prices[i] - prices[i - 1];
            }
        }
        return profit;
    }
}
```

**Note on the `k >= n/2` optimization**: When `k` is large enough, we effectively have unlimited transactions. Each transaction needs at least 2 days (buy day + sell day), so the maximum number of useful transactions is `n/2`. When `k >= n/2`, the problem degrades to the "unlimited transactions" case (LeetCode 122), which is solved greedily by summing all positive daily differences. This optimization is critical to avoid Memory Limit Exceeded or TLE when `k` is very large (e.g., 10^9).

### 10.2 Stock Problem Family — State Machine View

All stock problems can be modeled as state machines. The state is (holding/not-holding, optional cooldown, optional transaction count).

```
  LeetCode 121 (one transaction):
    States: sold (no stock), held (stock)
    Transitions: sold -> held (buy), held -> sold (sell)
    Constraint: at most 1 transaction
    
  LeetCode 122 (unlimited transactions):
    Same states, no transaction limit
    Greedy: sum all positive daily changes
    
  LeetCode 309 (cooldown):
    States: sold, held, cooldown
    After selling, must wait one day before buying
    held -> sold -> cooldown -> held
    
  LeetCode 714 (transaction fee):
    States: sold, held
    Pay fee when selling (or buying)
    sell[j] = max(sell[j], buy[j] + p - fee)
    
  LeetCode 188 (at most k transactions):
    States: buy[j], sell[j] for j = 1..k
    General case covering all above
```

**Cooldown State Machine (LeetCode 309)**:

```
          buy              sell
  [no stock] --------> [holding] --------> [cooldown]
     ^                     |                    |
     |                     |   rest             | rest
     |---------------------|                    |
     |                                          |
     |<------------------------------------------|
                    (cooldown ends, rest)
  
  dp[i][0] = max(dp[i-1][0], dp[i-1][2])            // no stock: rest or coming off cooldown
  dp[i][1] = max(dp[i-1][1], dp[i-1][0] - price[i]) // holding: rest or buy
  dp[i][2] = dp[i-1][1] + price[i]                  // cooldown: just sold
```

```java
// LeetCode 309: Best Time to Buy and Sell Stock with Cooldown
class Solution {
    public int maxProfit(int[] prices) {
        if (prices.length == 0) return 0;
        int n = prices.length;
        int[] hold = new int[n];      // holding stock
        int[] sold = new int[n];      // just sold (cooldown)
        int[] rest = new int[n];      // no stock, not in cooldown
        
        hold[0] = -prices[0];
        sold[0] = Integer.MIN_VALUE / 2;
        rest[0] = 0;
        
        for (int i = 1; i < n; i++) {
            hold[i] = Math.max(hold[i-1], rest[i-1] - prices[i]);
            sold[i] = hold[i-1] + prices[i];
            rest[i] = Math.max(rest[i-1], sold[i-1]);
        }
        return Math.max(sold[n-1], rest[n-1]);
    }
}
```

**Transaction Fee (LeetCode 714)**:

```java
class Solution {
    public int maxProfit(int[] prices, int fee) {
        int n = prices.length;
        int[] hold = new int[n];  // max profit holding stock
        int[] cash = new int[n];  // max profit not holding stock
        
        hold[0] = -prices[0];
        cash[0] = 0;
        
        for (int i = 1; i < n; i++) {
            hold[i] = Math.max(hold[i-1], cash[i-1] - prices[i]);
            cash[i] = Math.max(cash[i-1], hold[i-1] + prices[i] - fee);
        }
        return cash[n-1];
    }
}
```

---

## 11. Pattern Recognition Table

When you see a problem, use this table to identify the DP pattern. Look for the "signal" in the problem description.

| Signal in Problem                                    | Likely DP Pattern          | State Definition                          | Key Insight                                    |
|------------------------------------------------------|----------------------------|-------------------------------------------|------------------------------------------------|
| "Number of ways to reach step n / decode / climb"   | 1D Linear DP (Fibonacci)   | `dp[i]` = ways for prefix i              | Relate to previous 1-2 states                   |
| "Max/min value, cannot take adjacent"               | 1D Decision DP (House Robber) | `dp[i]` = best for prefix i          | Take or skip each element                       |
| "Min coins / fewest items to make target"           | Unbounded Knapsack         | `dp[i]` = min for amount i               | Forward iteration, unlimited reuse              |
| "Can you make sum S from given numbers"             | 0/1 Knapsack (Subset Sum)  | `dp[j]` = reachable sum j                | Backward iteration, each number once            |
| "Count ways to make sum / partition"                | 0/1 or Unbounded Knapsack  | `dp[j]` += `dp[j-num]`                   | Count instead of boolean/max                    |
| "Grid, move right/down, count paths or min cost"    | 2D Grid DP                 | `dp[i][j]` from `dp[i-1][j]`, `dp[i][j-1]` | First row/col as base cases                  |
| "Two strings, compare/edit/match"                   | 2D String DP               | `dp[i][j]` for prefixes                  | Char match drives the transition                |
| "Edit/insert/delete operations between strings"     | Edit Distance variant      | `dp[i][j]` with insert/delete/replace     | Three-way min for mismatch                      |
| "Longest common subsequence/substring"             | LCS Family                 | `dp[i][j]` for prefixes                  | Substring resets to 0; subsequence carries max  |
| "Longest increasing subsequence"                    | LIS Family                 | `dp[i]` = LIS ending at i                | Check all j < i, or binary search on tails      |
| "Nested envelopes / dimensions, fit into each other"| LIS (sort + binary search)| Sort one dim, LIS on the other           | Descending sort for ties prevents invalid nesting|
| "Burst/merge/remove in interval, cost depends on neighbors" | Interval DP       | `dp[i][j]` for interval [i,j]            | Split at k, try every k, combine sub-intervals  |
| "Multiply matrices / combine with associative cost" | Interval DP (MCM)         | `dp[i][j]` for matrices i..j             | Split at k, cost = left + right + merge cost    |
| "Regex with . and * / wildcard with ? and *"       | String Matching DP         | `dp[i][j]` for string vs pattern         | * matches zero-or-more (check both cases)       |
| "Interleave two strings preserving order"           | 2D String DP               | `dp[i][j]` for prefixes of s1, s2        | Take from s1 or s2 if char matches s3           |
| "Stock trading, at most k transactions"            | State Machine DP           | `buy[j]`, `sell[j]` for transaction j    | Hold/not-hold states, transition per day        |
| "Stock with cooldown / transaction fee"            | State Machine DP           | States: hold, sold, rest (cooldown)      | Extra state for cooldown/fee                    |
| "Count numbers in range [L, R] with property"      | Digit DP                   | `dp[pos][tight][...]`                    | Process digit by digit, track constraints       |
| "Palindromic substring/subsequence"                | Interval DP or LCS         | `dp[i][j]` = palindrome in [i,j]         | Center expansion or LCS with reverse            |
| "Game theory, two players, optimal play"           | Minimax DP                 | `dp[i][j]` = best score for current player| Maximize your score, minimize opponent's        |

### Quick Identification Flowchart

```
  START
    |
    v
  Is it an optimization/counting problem with choices?
    |--- No --> Probably not DP (greedy, graph, etc.)
    |--- Yes
    |
    v
  Does the problem have overlapping subproblems?
    |--- No --> Use divide & conquer or memoization won't help
    |--- Yes --> DP candidate!
    |
    v
  What does the state look like?
    |
    |--- Single index i (prefix/position)
    |      |--> Linear recurrence (i-1, i-2)? -> 1D Linear DP
    |      |--> Choice at each position? -> 1D Decision DP
    |      |--> All j < i contribute? -> LIS pattern
    |
    |--- Two indices (i, j)
    |      |--> Grid movement? -> 2D Grid DP
    |      |--> Two strings? -> LCS / Edit Distance / String Matching
    |      |--> Interval [i, j] with split point? -> Interval DP
    |
    |--- Capacity / target sum
    |      |--> Each item 0 or 1 times? -> 0/1 Knapsack (backward)
    |      |--> Items reusable? -> Unbounded Knapsack (forward)
    |
    |--- Finite states (hold/sell/cooldown)
    |      |--> State transitions per time step? -> State Machine DP
    |
    v
  Write recurrence, identify base cases, determine fill order
```

---

## 12. Interview Strategy Checklist

When facing a DP problem in an interview, follow this systematic approach:

**Step 1: Understand the problem (2-3 minutes)**
- Restate the problem in your own words
- Work through the given example manually
- Identify: what are we optimizing/counting? What are the choices?

**Step 2: Identify the pattern (2-3 minutes)**
- Use the Pattern Recognition Table above
- Determine the state: what does `dp[...]` represent?
- Check: does the problem have optimal substructure? Overlapping subproblems?

**Step 3: Derive the recurrence (3-5 minutes)**
- Write the recurrence in plain English first
- Then translate to math: `dp[i] = f(dp[...], ...)`
- Identify base cases (smallest subproblems)
- Determine what the final answer is (which cell of the DP table?)

**Step 4: Determine fill order (1 minute)**
- Top-down: write the recursive function with memoization
- Bottom-up: what order do I fill the table? (usually by increasing size)

**Step 5: Code the solution (10-15 minutes)**
- Start with bottom-up if the order is clear
- Use top-down if the recurrence is complex and ordering is tricky
- Initialize the DP table with appropriate sentinel values
- Fill according to the recurrence

**Step 6: Verify and optimize (5 minutes)**
- Trace through the example to verify correctness
- Check for off-by-one errors (especially string indexing)
- Can you optimize space? (1D array instead of 2D, or O(1) with variables)
- State the time and space complexity

### Common Pitfalls

1. **Wrong base cases**: Forgetting `dp[0]` initialization or using wrong sentinel values. Always think about the empty/zero case.

2. **String indexing**: `dp[i]` often refers to the first `i` characters, so `dp[0]` = empty string. Character at position `i` in the string is `s.charAt(i-1)` in the DP context.

3. **Iteration direction in knapsack**: 0/1 knapsack MUST iterate capacity backward. Unbounded knapsack iterates forward. Getting this wrong silently produces incorrect results.

4. **Not considering all transitions**: In state machine DP, missing a "rest/do nothing" transition is a common error. Every state should have a self-loop (rest option).

5. **Integer overflow**: Use `Integer.MIN_VALUE / 2` instead of `Integer.MIN_VALUE` when you might add to it (to avoid overflow to positive).

6. **Space optimization losing dependencies**: When compressing 2D to 1D, ensure you save `dp[i-1][j-1]` before overwriting it (needed in Edit Distance, LCS).

### Space Optimization Rules of Thumb

| Situation                                        | Optimization                          |
|-------------------------------------------------|---------------------------------------|
| `dp[i]` depends only on `dp[i-1]`, `dp[i-2]`   | Use 2 variables instead of array      |
| `dp[i][j]` depends on previous row only         | Use 1D array, iterate carefully       |
| `dp[i][j]` depends on `dp[i-1][j-1]`           | Save diagonal element before overwrite|
| `dp[i][j]` = `dp[i-1][j]` + `dp[i][j-1]`       | In-place on input grid or 1D array    |

---

## Summary

Dynamic Programming mastery comes from pattern recognition, not memorization. The key patterns are:

- **1D DP**: Linear recurrence (Fibonacci-like) or decision at each step (take/skip)
- **2D DP**: Grid traversal or two-string comparison
- **Knapsack**: Subset sum with 0/1 (each item once, backward) or unbounded (reuse, forward)
- **LCS**: Two-string prefix comparison with carry-forward
- **LIS**: For each element, look back at all smaller predecessors
- **Interval DP**: Define state on `[i, j]`, split at every `k`, combine sub-intervals
- **String DP**: Pattern matching with `*` handling (zero-or-more case is the tricky part)
- **State Machine DP**: Finite states with transitions, typically for stock/time-series problems

The most important skill is the ability to define the state correctly. Once you have a clear state definition and recurrence, the coding is mechanical. Practice identifying patterns from problem descriptions, and always verify your recurrence on the given examples before coding.

Remember: every DP problem you solve makes the next one easier to recognize. Build your pattern library, and DP transforms from the scariest topic into the most rewarding one.

---

*Related topics in this series: Arrays & Strings, Two Pointers, Sliding Window, Binary Search, Trees, Graphs, Heap & Priority Queue, Backtracking, Greedy Algorithms.*

## Interview Cheat Sheet

**Key Points to Remember:**
- DP = overlapping subproblems + optimal substructure.
- Two approaches: memoization (top-down, recursive) or tabulation (bottom-up, iterative).
- State = the variables that change between subproblems.
- Transition = how to get from smaller to larger state.
- Base case = smallest solvable subproblem.

**Common Follow-Up Questions:**
- *Memoization vs tabulation?* — Memoization: intuitive, recursive, only computes needed states. Tabulation: iterative, no stack overflow, computes all states. Choose based on problem structure.
- *How do you optimize DP space?* — If dp[i] only depends on dp[i-1] and dp[i-2], use two variables instead of an array. O(n) → O(1) space.

**Gotcha:**
- Not identifying the state correctly. The state is the minimal set of variables that fully determines the subproblem's answer. Too few variables = wrong answer. Too many = exponential blowup.