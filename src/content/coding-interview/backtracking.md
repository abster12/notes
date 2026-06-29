---
title: "Backtracking — Complete Interview Prep Guide"
date: 2026-06-19
tags: [interview, backtracking, recursion, java, algorithms]
category: Coding Interview Prep
difficulty: Medium to Hard
estimated_read_time: 35 minutes
---

# Backtracking — Complete Interview Prep Guide

Backtracking systematically enumerates candidate solutions by exploring the search space depth-first, abandoning ("backtracking from") a path as soon as it cannot lead to a valid solution. This pruning makes backtracking tractable on problems where brute-force enumeration would be exponential.

This guide covers the canonical template, every major interview pattern, full Java solutions for the eight most frequently asked problems, ASCII diagrams, a template comparison table, and a pattern-recognition table.

---

## Summary & Interview Framing

A systematic enumeration that explores a search space depth-first, abandoning paths that can't lead to valid solutions (pruning).

**How it's asked:** "Generate all permutations/combinations, solve N-Queens, word search on a grid, sudoku solver — problems asking to enumerate all valid configurations."

---

## What Is Backtracking?

At each decision point, you make a choice, recurse to explore the consequences, then undo the choice so the state is clean for the next iteration:

- **Choose** — make a decision (add an element, place a queen, mark a cell).
- **Explore** — recurse into the subproblem.
- **Unchoose** — undo the decision so the next branch starts clean.

Pruning cuts entire subtrees when a partial solution violates a constraint. Without it, backtracking degenerates into exhaustive enumeration. Time complexity is generally exponential — O(2^n), O(n!), or O(n^n) — because the search space itself is exponential.

**When to use backtracking:** find **all** solutions, enumerate combinations/permutations/subsets/partitions, fill a grid under constraints (Sudoku, N-Queens), or determine whether a valid configuration exists. For **optimal** values, use DP or greedy instead.

---

## The Universal Backtracking Template

Almost every problem fits a variation of this skeleton. Only the "choose," termination condition, and pruning differ.

```
function backtrack(state, ...extra params):
    if isComplete(state):          // base case: valid solution
        record(state); return
    for candidate in candidates(state):
        if isValid(candidate, state):   // prune
            choose(candidate, state)
            backtrack(state, ...next params)
            unchoose(candidate, state)
```

```java
void backtrack(List<Integer> state, /* params */) {
    if (/* base case */) {
        result.add(new ArrayList<>(state));  // DEEP COPY before storing
        return;
    }
    for (/* each candidate */) {
        if (/* valid */) {
            state.add(candidate);              // CHOOSE
            backtrack(state, /* next params */);
            state.remove(state.size() - 1);    // UNCHOOSE
        }
    }
}
```

### Critical Details

1. **Always deep-copy state before storing.** Storing a reference to the mutable list means subsequent modifications corrupt the result. Use `new ArrayList<>(state)`.
2. **Unchoose must exactly reverse choose.** `add` → `remove` last; mark visited → unmark; push → pop. Mismatched choose/unchoose is the most common bug.
3. **Candidate loop defines branching.** All unused elements → permutations. From a start index → combinations/subsets. Fixed choices (1-9, '(' vs ')') → enumeration.
4. **Prune inside the loop, before the recursive call.** Earlier pruning = more time saved.
5. **Start index vs used[] flag.** Start index (`for i from start`) — order doesn't matter (subsets, combinations). Used array (`if (!used[i])`) — order matters (permutations).

---

## Template Comparison Table

```
+-------------------------+-------------------+--------------------+------------------------+--------------------------------+
| Problem Family          | Choose            | Candidates         | Base Case              | Prune                          |
+-------------------------+-------------------+--------------------+------------------------+--------------------------------+
| Subsets (no dup)        | add nums[i]       | i from start..n-1  | always (every node)    | none                           |
| Subsets II (dups)       | add nums[i]       | i from start..n-1  | always (every node)    | i>start && nums[i]==nums[i-1]  |
| Permutations            | add nums[i]       | i from 0..n-1      | state.size()==n        | used[i]                        |
| Permutations II         | add nums[i]       | i from 0..n-1      | state.size()==n        | used[i] || (dup condition)     |
| Combinations (C(n,k))   | add i+1           | i from start..n    | state.size()==k        | none (start index handles it)  |
| Combination Sum (rep)   | add candidates[i] | i from start..n-1  | target==0              | candidates[i] > remaining      |
| Combination Sum II      | add candidates[i] | i from start..n-1  | target==0              | dup condition + sum overflow   |
| Combination Sum III     | add i             | i from start..9    | k==0 && target==0      | i>remaining or k<0             |
| N-Queens                | place Q at (r,c)  | c from 0..n-1      | row==n                 | col/diag conflict              |
| Sudoku                  | place digit d     | d from 1..9        | board fully filled     | d not valid in cell            |
| Word Search             | mark visited      | 4 neighbors        | index==word.length()   | out of bounds / mismatch       |
| Generate Parentheses    | add '(' or ')'    | '(' or ')'         | length==2n             | close>open or open>n           |
| Palindrome Partition    | add substring     | end from start..n  | start==n               | !isPalindrome(s,start,end)     |
| Phone Number            | add letters[c]    | chars of digit     | index==digits.length() | none                           |
| Restore IP              | add octet         | len 1..3 from pos  | 4 parts && pos==n      | invalid octet (>255, leading 0)|
| Split Descending        | add substring     | len 1..n from pos  | pos==n && parts>=2     | !descending || invalid num     |
+-------------------------+-------------------+--------------------+------------------------+--------------------------------+
```

---

## Subsets (LeetCode 78)

**Problem:** Given an array of unique elements, return all possible subsets (the power set).

**Example:** `nums = [1,2,3]` → `[[],[1],[2],[1,2],[3],[1,3],[2,3],[1,2,3]]`

### Approach

Order doesn't matter, so we use a **start index**: at each level, only consider elements from `start` onward. Every node is a valid subset, so we record at the **beginning** of each call. Complexity: Time O(n·2^n), Space O(n).

### Recursion Tree (ASCII)

For `nums = [1,2,3]`:

```
                         []                         (level 0, start=0)
                      /  |  \
                   /     |     \
              [1]       [2]      [3]                 (level 1)
             /  \        |
          [1,2] [1,3]  [2,3]                         (level 2)
           |
        [1,2,3]                                        (level 3, leaf)
```

The start index ensures we never go back to earlier elements, so `[2,1]` is never generated.

### Java Solution

```java
class Solution {
    public List<List<Integer>> subsets(int[] nums) {
        List<List<Integer>> result = new ArrayList<>();
        backtrack(nums, 0, new ArrayList<>(), result);
        return result;
    }

    private void backtrack(int[] nums, int start, List<Integer> current,
                           List<List<Integer>> result) {
        result.add(new ArrayList<>(current));  // every node is a valid subset

        for (int i = start; i < nums.length; i++) {
            current.add(nums[i]);                       // CHOOSE
            backtrack(nums, i + 1, current, result);    // EXPLORE
            current.remove(current.size() - 1);         // UNCHOOSE
        }
    }
}
```

---

## Subsets II (LeetCode 90)

**Problem:** Given an array that **may contain duplicates**, return all subsets without duplicate subsets.

**Example:** `nums = [1,2,2]` → `[[],[1],[1,2],[1,2,2],[2],[2,2]]`

Sort the array, then skip duplicates at the same recursion level with `i > start && nums[i] == nums[i-1]`. The first occurrence (`i == start`) is always allowed; subsequent identical values at the same level are skipped. The condition uses `i > start` (not `i > 0`) so the first candidate at each level is always taken even if it equals the previous array element (which was chosen at a *different* level).

```java
class Solution {
    public List<List<Integer>> subsetsWithDup(int[] nums) {
        List<List<Integer>> res = new ArrayList<>();
        Arrays.sort(nums);
        backtrack(nums, 0, new ArrayList<>(), res);
        return res;
    }
    private void backtrack(int[] nums, int start, List<Integer> cur, List<List<Integer>> res) {
        res.add(new ArrayList<>(cur));
        for (int i = start; i < nums.length; i++) {
            if (i > start && nums[i] == nums[i - 1]) continue;
            cur.add(nums[i]);
            backtrack(nums, i + 1, cur, res);
            cur.remove(cur.size() - 1);
        }
    }
}
```

---

## Permutations (LeetCode 46)

**Problem:** Given an array of distinct integers, return all possible permutations.

**Example:** `nums = [1,2,3]` → `[[1,2,3],[1,3,2],[2,1,3],[2,3,1],[3,1,2],[3,2,1]]`

### Approach

Permutations care about **order**. We use a `used[]` boolean array to track placed elements. The loop iterates over **all** elements (from 0, not from a start index), skipping used ones. Base case: current permutation reaches full length. Complexity: Time O(n·n!), Space O(n).

All 6 leaves (3! = 6) are valid: `[1,2],[1,3],[2,1],[2,3],[3,1],[3,2]`.

### Java Solution

```java
class Solution {
    public List<List<Integer>> permute(int[] nums) {
        List<List<Integer>> result = new ArrayList<>();
        backtrack(nums, new boolean[nums.length], new ArrayList<>(), result);
        return result;
    }

    private void backtrack(int[] nums, boolean[] used, List<Integer> current,
                           List<List<Integer>> result) {
        if (current.size() == nums.length) {
            result.add(new ArrayList<>(current));
            return;
        }
        for (int i = 0; i < nums.length; i++) {
            if (used[i]) continue;
            used[i] = true;
            current.add(nums[i]);                       // CHOOSE
            backtrack(nums, used, current, result);     // EXPLORE
            current.remove(current.size() - 1);         // UNCHOOSE
            used[i] = false;
        }
    }
}
```

**Alternative:** swap elements in place at each level (O(1) extra space). The swap-back after the recursive call is the unchoose.

---

## Permutations II (LeetCode 47)

**Problem:** Given numbers that **may contain duplicates**, return all unique permutations.

**Example:** `nums = [1,1,2]` → `[[1,1,2],[1,2,1],[2,1,1]]`

Sort, then skip a duplicate if the previous identical element is **not** used: `i > 0 && nums[i] == nums[i-1] && !used[i-1]`. If `nums[i-1]` is not used, it was just backtracked at this level, so choosing `nums[i]` replays the same subtree. This ensures duplicates are always chosen in a fixed order.

```java
class Solution {
    public List<List<Integer>> permuteUnique(int[] nums) {
        List<List<Integer>> res = new ArrayList<>();
        Arrays.sort(nums);
        backtrack(nums, new boolean[nums.length], new ArrayList<>(), res);
        return res;
    }
    private void backtrack(int[] nums, boolean[] used, List<Integer> cur, List<List<Integer>> res) {
        if (cur.size() == nums.length) { res.add(new ArrayList<>(cur)); return; }
        for (int i = 0; i < nums.length; i++) {
            if (used[i]) continue;
            if (i > 0 && nums[i] == nums[i - 1] && !used[i - 1]) continue;
            used[i] = true; cur.add(nums[i]);
            backtrack(nums, used, cur, res);
            cur.remove(cur.size() - 1); used[i] = false;
        }
    }
}
```

---

## Combinations (LeetCode 77)

**Problem:** Given `n` and `k`, return all combinations of `k` numbers from 1 to `n`.

**Example:** `n = 4, k = 2` → `[[1,2],[1,3],[1,4],[2,3],[2,4],[3,4]]`

Subset problem with a fixed-size constraint. Use a start index and record when size reaches `k`. Pruning: if there are not enough remaining numbers to fill the combination, stop early.

```java
class Solution {
    public List<List<Integer>> combine(int n, int k) {
        List<List<Integer>> res = new ArrayList<>();
        backtrack(n, k, 1, new ArrayList<>(), res);
        return res;
    }
    private void backtrack(int n, int k, int start, List<Integer> cur, List<List<Integer>> res) {
        if (cur.size() == k) { res.add(new ArrayList<>(cur)); return; }
        for (int i = start; i <= n - (k - cur.size()) + 1; i++) {
            cur.add(i);
            backtrack(n, k, i + 1, cur, res);
            cur.remove(cur.size() - 1);
        }
    }
}
```

---

## Combination Sum (LeetCode 39)

**Problem:** Given **distinct** integers `candidates` and a target, return all unique combinations that sum to the target. Each number may be used **unlimited times**.

**Example:** `candidates = [2,3,6,7], target = 7` → `[[2,2,3],[7]]`

### Approach

Since elements can be reused, the recursive call passes `i` (not `i + 1`). Sort for pruning: if `candidates[i] > remaining`, `break` (all subsequent are larger). Base case: `remaining == 0`. Complexity: Time O(2^t), Space O(t).

### Java Solution

```java
class Solution {
    public List<List<Integer>> combinationSum(int[] candidates, int target) {
        List<List<Integer>> result = new ArrayList<>();
        Arrays.sort(candidates);
        backtrack(candidates, target, 0, new ArrayList<>(), result);
        return result;
    }

    private void backtrack(int[] candidates, int remaining, int start,
                           List<Integer> current, List<List<Integer>> result) {
        if (remaining == 0) {
            result.add(new ArrayList<>(current));
            return;
        }
        for (int i = start; i < candidates.length; i++) {
            if (candidates[i] > remaining) break;  // prune: sorted, so all larger too
            current.add(candidates[i]);
            backtrack(candidates, remaining - candidates[i], i, current, result); // i, not i+1
            current.remove(current.size() - 1);
        }
    }
}
```

Key points: pass `i` (not `i+1`) for unlimited reuse; `break` (not `continue`) since sorted; no duplicates because candidates are distinct and start index prevents reordering.

---

## Combination Sum II (LeetCode 40)

**Problem:** Given `candidates` (may contain duplicates) and a target, find all unique combinations summing to target. Each number used **at most once**.

**Example:** `candidates = [10,1,2,7,6,1,5], target = 8` → `[[1,1,6],[1,2,5],[1,7],[2,6]]`

Combines duplicate-skipping (Subsets II) with sum-targeting. Sort, use start index (pass `i + 1` since each element used once), skip duplicates with `i > start && candidates[i] == candidates[i-1]`.

```java
class Solution {
    public List<List<Integer>> combinationSum2(int[] candidates, int target) {
        List<List<Integer>> res = new ArrayList<>();
        Arrays.sort(candidates);
        backtrack(candidates, target, 0, new ArrayList<>(), res);
        return res;
    }
    private void backtrack(int[] c, int rem, int start, List<Integer> cur, List<List<Integer>> res) {
        if (rem == 0) { res.add(new ArrayList<>(cur)); return; }
        for (int i = start; i < c.length; i++) {
            if (c[i] > rem) break;
            if (i > start && c[i] == c[i - 1]) continue;
            cur.add(c[i]);
            backtrack(c, rem - c[i], i + 1, cur, res);
            cur.remove(cur.size() - 1);
        }
    }
}
```

**vs Combination Sum I:** I has distinct input + unlimited reuse (pass `i`); II has duplicate input + single use (pass `i+1`) + duplicate skip.

---

## Combination Sum III (LeetCode 216)

**Problem:** Find all valid combinations of `k` numbers from 1-9 that sum to `n`, each at most once.

**Example:** `k = 3, n = 7` → `[[1,2,4]]`

```java
class Solution {
    public List<List<Integer>> combinationSum3(int k, int n) {
        List<List<Integer>> res = new ArrayList<>();
        backtrack(k, n, 1, new ArrayList<>(), res);
        return res;
    }
    private void backtrack(int k, int rem, int start, List<Integer> cur, List<List<Integer>> res) {
        if (k == 0 && rem == 0) { res.add(new ArrayList<>(cur)); return; }
        if (k == 0 || rem <= 0) return;
        for (int i = start; i <= 9; i++) {
            if (i > rem) break;
            cur.add(i);
            backtrack(k - 1, rem - i, i + 1, cur, res);
            cur.remove(cur.size() - 1);
        }
    }
}
```

---

## N-Queens (LeetCode 51)

**Problem:** Place `n` queens on an `n x n` chessboard so no two attack each other. Return all distinct solutions.

**Example:** `n = 4` → 2 solutions.

### Approach

Place queens row by row. In each row, try every column and check if `(row, col)` is safe — no other queen shares the same column, main diagonal (`row - col`), or anti-diagonal (`row + col`). Tracking arrays:
- `cols[col]` — is column occupied?
- `diag[row - col + n - 1]` — main diagonal (add `n-1` for non-negative index).
- `antiDiag[row + col]` — anti-diagonal (already non-negative).

### N-Queens Board State (ASCII)

For `n = 4`, the progression of placing queens for one valid solution:

```
Step 1: Place Q at (0,1)        Step 2: Place Q at (1,3)

  0 1 2 3                         0 1 2 3
0 . Q . .                       0 . Q . .
1 . . . .                       1 . . . Q
2 . . . .                       2 . . . .
3 . . . .                       3 . . . .

Step 3: Place Q at (2,0)        Step 4: Place Q at (3,2) — VALID

  0 1 2 3                         0 1 2 3
0 . Q . .                       0 . Q . .
1 . . . Q                       1 . . . Q
2 Q . . .                       2 Q . . .
3 . . . .                       3 . . Q .
```

Attacked cells from queen at (0,1): all of col 1; diagonal (row-col=-1): (0,1),(1,2),(2,3); anti-diagonal (row+col=1): (0,1),(1,0). Complexity: Time O(n!), Space O(n).

### Java Solution

```java
class Solution {
    public List<List<String>> solveNQueens(int n) {
        List<List<String>> result = new ArrayList<>();
        char[][] board = new char[n][n];
        for (char[] row : board) Arrays.fill(row, '.');
        backtrack(0, n, board, new boolean[n], new boolean[2*n-1], new boolean[2*n-1], result);
        return result;
    }

    private void backtrack(int row, int n, char[][] board,
                           boolean[] cols, boolean[] diag, boolean[] antiDiag,
                           List<List<String>> result) {
        if (row == n) {
            List<String> solution = new ArrayList<>();
            for (char[] r : board) solution.add(new String(r));
            result.add(solution);
            return;
        }
        for (int col = 0; col < n; col++) {
            int d = row - col + n - 1, a = row + col;
            if (cols[col] || diag[d] || antiDiag[a]) continue;

            board[row][col] = 'Q';          // CHOOSE
            cols[col] = diag[d] = antiDiag[a] = true;
            backtrack(row + 1, n, board, cols, diag, antiDiag, result);  // EXPLORE
            board[row][col] = '.';          // UNCHOOSE
            cols[col] = diag[d] = antiDiag[a] = false;
        }
    }
}
```

---

## N-Queens II (LeetCode 52)

**Problem:** Return the count of distinct N-Queens solutions. Same as N-Queens but increment a counter instead of recording boards. Uses the same three boolean arrays for conflict detection.

---

## Sudoku Solver (LeetCode 37)

**Problem:** Solve a Sudoku puzzle. Each row, column, and 3x3 sub-box must contain digits 1-9 without repetition.

The box index for cell `(row, col)` is `(row/3)*3 + (col/3)`. Boxes 0-2 cover rows 0-2, boxes 3-5 cover rows 3-5, boxes 6-8 cover rows 6-8 (each box spans 3 columns).

### Approach

Find the first empty cell, try digits 1-9, check validity (no conflict in row, column, or 3x3 box), recurse. If the recursive call succeeds, return `true` (we only need one solution). If no digit works, reset the cell and return `false`. Key difference: **return boolean** and stop early when found.

### Java Solution

```java
class Solution {
    public void solveSudoku(char[][] board) {
        backtrack(board);
    }

    private boolean backtrack(char[][] board) {
        for (int row = 0; row < 9; row++) {
            for (int col = 0; col < 9; col++) {
                if (board[row][col] != '.') continue;
                for (char d = '1'; d <= '9'; d++) {
                    if (isValid(board, row, col, d)) {
                        board[row][col] = d;            // CHOOSE
                        if (backtrack(board)) return true;  // EXPLORE
                        board[row][col] = '.';          // UNCHOOSE
                    }
                }
                return false;  // no valid digit → backtrack
            }
        }
        return true;  // no empty cell → board complete
    }

    private boolean isValid(char[][] board, int row, int col, char d) {
        int boxRow = (row / 3) * 3, boxCol = (col / 3) * 3;
        for (int i = 0; i < 9; i++) {
            if (board[row][i] == d || board[i][col] == d) return false;
            if (board[boxRow + i / 3][boxCol + i % 3] == d) return false;
        }
        return true;
    }
}
```

The unchoose is only reached when the recursive call fails. If it succeeds, we return immediately without undoing — the board holds the solution.

---

## Word Search (LeetCode 79)

**Problem:** Given an `m x n` grid and a string `word`, return `true` if the word exists. The word is constructed from sequentially adjacent cells (horizontally/vertically), same cell not used twice.

**Example:** `board = [["A","B","C","E"],["S","F","C","S"],["A","D","E","E"]], word = "ABCCED"` → `true`

### Approach

For each cell matching the first character, start a DFS. Mark visited in-place (replace with `#`), recurse into four directions, restore after. If any path matches the full word, return `true`. Complexity: Time O(m·n·4^L), Space O(L).

### Java Solution

```java
class Solution {
    public boolean exist(char[][] board, String word) {
        char[] w = word.toCharArray();
        for (int i = 0; i < board.length; i++)
            for (int j = 0; j < board[0].length; j++)
                if (board[i][j] == w[0] && backtrack(board, w, i, j, 0)) return true;
        return false;
    }

    private boolean backtrack(char[][] board, char[] word, int i, int j, int idx) {
        if (idx == word.length) return true;
        if (i < 0 || i >= board.length || j < 0 || j >= board[0].length
                || board[i][j] != word[idx]) return false;

        char temp = board[i][j];
        board[i][j] = '#';  // CHOOSE: mark visited
        boolean found = backtrack(board, word, i+1, j, idx+1)
                     || backtrack(board, word, i-1, j, idx+1)
                     || backtrack(board, word, i, j+1, idx+1)
                     || backtrack(board, word, i, j-1, idx+1);
        board[i][j] = temp;  // UNCHOOSE: restore
        return found;
    }
}
```

In-place marking saves O(m·n) space. **Optimization:** reverse the word if the last character is rarer in the board than the first, reducing the branching factor at the top of the tree.

---

## Word Search II (LeetCode 212)

**Problem:** Given a board and a list of words, find all words that exist on the board.

Running Word Search I per word is O(W·m·n·4^L) — too slow. Use a **Trie** to search all words simultaneously: insert all words, then DFS from each cell. If the current path is not a prefix of any word (Trie has no child for the character), prune. If it matches a complete word, add to results.

```java
class Solution {
    class TrieNode { TrieNode[] children = new TrieNode[26]; String word = null; }
    public List<String> findWords(char[][] board, String[] words) {
        TrieNode root = new TrieNode();
        for (String w : words) { TrieNode node = root;
            for (char c : w.toCharArray()) { int i = c - 'a';
                if (node.children[i] == null) node.children[i] = new TrieNode();
                node = node.children[i]; } node.word = w; }
        List<String> result = new ArrayList<>();
        for (int i = 0; i < board.length; i++)
            for (int j = 0; j < board[0].length; j++) dfs(board, i, j, root, result);
        return result;
    }
    private void dfs(char[][] b, int i, int j, TrieNode node, List<String> res) {
        char c = b[i][j];
        if (c == '#' || node.children[c - 'a'] == null) return;
        node = node.children[c - 'a'];
        if (node.word != null) { res.add(node.word); node.word = null; }
        b[i][j] = '#';
        int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
        for (int[] d : dirs) { int ni = i+d[0], nj = j+d[1];
            if (ni >= 0 && ni < b.length && nj >= 0 && nj < b[0].length) dfs(b, ni, nj, node, res); }
        b[i][j] = c;
    }
}
```

`node.children[c - 'a'] == null` prunes any path that cannot lead to a valid word, dramatically reducing the search space.

---

## Generate Parentheses (LeetCode 22)

**Problem:** Given `n` pairs of parentheses, generate all combinations of well-formed parentheses.

**Example:** `n = 3` → `["((()))","(()())","(())()","()(())","()()()"]`

### Approach

At each step, add `'('` if we haven't used all `n`, or add `')'` if there are unmatched `'('` (`close < open`). This **guarantees validity by construction**. Complexity: Time O(4^n/√n) (Catalan number), Space O(n).

### Java Solution

```java
class Solution {
    public List<String> generateParenthesis(int n) {
        List<String> result = new ArrayList<>();
        backtrack(new StringBuilder(), 0, 0, n, result);
        return result;
    }

    private void backtrack(StringBuilder current, int open, int close, int n,
                           List<String> result) {
        if (current.length() == 2 * n) {
            result.add(current.toString());
            return;
        }
        if (open < n) {
            current.append('(');
            backtrack(current, open + 1, close, n, result);
            current.deleteCharAt(current.length() - 1);
        }
        if (close < open) {
            current.append(')');
            backtrack(current, open, close + 1, n, result);
            current.deleteCharAt(current.length() - 1);
        }
    }
}
```

The constraints `open < n` and `close < open` ensure: (1) no more than `n` opening parens, (2) never close an unopened paren, (3) every complete string has exactly `n` of each in valid order. Invalid branches never form — the most elegant form of backtracking.

---

## Palindrome Partitioning (LeetCode 131)

**Problem:** Given a string `s`, partition it so every substring is a palindrome. Return all possible partitions.

**Example:** `s = "aab"` → `[["a","a","b"],["aa","b"]]`

### Approach

At each position, try all end positions for the next substring. If `s[start:end+1]` is a palindrome, add it and recurse from `end + 1`. Base case: `start == s.length()`. Complexity: Time O(n·2^n), Space O(n).

### Java Solution

```java
class Solution {
    public List<List<String>> partition(String s) {
        List<List<String>> result = new ArrayList<>();
        backtrack(s, 0, new ArrayList<>(), result);
        return result;
    }

    private void backtrack(String s, int start, List<String> current,
                           List<List<String>> result) {
        if (start == s.length()) {
            result.add(new ArrayList<>(current));
            return;
        }
        for (int end = start; end < s.length(); end++) {
            if (isPalindrome(s, start, end)) {
                current.add(s.substring(start, end + 1));    // CHOOSE
                backtrack(s, end + 1, current, result);      // EXPLORE
                current.remove(current.size() - 1);          // UNCHOOSE
            }
        }
    }

    private boolean isPalindrome(String s, int left, int right) {
        while (left < right)
            if (s.charAt(left++) != s.charAt(right--)) return false;
        return true;
    }
}
```

For long strings, precompute a DP table: `isPal[i][j] = (s[i]==s[j]) && (j-i <= 2 || isPal[i+1][j-1])`.

---

## Letter Combinations of a Phone Number (LeetCode 17)

**Problem:** Given digits 2-9, return all possible letter combinations (phone keypad mapping).

**Example:** `digits = "23"` → `["ad","ae","af","bd","be","bf","cd","ce","cf"]`

Mapping: `2:abc 3:def 4:ghi 5:jkl 6:mno 7:pqrs 8:tuv 9:wxyz`

At each digit position, iterate over all letters that digit maps to. Append, recurse to next digit, remove. Base case: current string reaches the length of the input digits. For `"23"`, the tree branches into `a/b/c` at level 1, then each branches into `d/e/f` at level 2, producing 9 leaves.

```java
class Solution {
    private String[] map = {"", "", "abc", "def", "ghi", "jkl", "mno", "pqrs", "tuv", "wxyz"};
    public List<String> letterCombinations(String digits) {
        List<String> res = new ArrayList<>();
        if (digits == null || digits.isEmpty()) return res;
        backtrack(digits, 0, new StringBuilder(), res);
        return res;
    }
    private void backtrack(String digits, int idx, StringBuilder cur, List<String> res) {
        if (idx == digits.length()) { res.add(cur.toString()); return; }
        for (char c : map[digits.charAt(idx) - '0'].toCharArray()) {
            cur.append(c);
            backtrack(digits, idx + 1, cur, res);
            cur.deleteCharAt(cur.length() - 1);
        }
    }
}
```

---

## Restore IP Addresses (LeetCode 93)

**Problem:** Given a string of digits, return all valid IP addresses formed by inserting dots. A valid IP has exactly four octets, each 0-255, no leading zeros (except "0" itself).

**Example:** `s = "25525511135"` → `["255.255.11.135","255.255.111.35"]`

Place 3 dots to create 4 segments. Try 1, 2, or 3 characters per octet. Validate (no leading zero unless "0", value ≤ 255). Record when 4 valid octets consume the entire string. Prune when remaining characters can't fill remaining octets.

```java
class Solution {
    public List<String> restoreIpAddresses(String s) {
        List<String> res = new ArrayList<>();
        backtrack(s, 0, new ArrayList<>(), res);
        return res;
    }
    private void backtrack(String s, int start, List<String> parts, List<String> res) {
        if (parts.size() == 4) {
            if (start == s.length()) res.add(String.join(".", parts));
            return;
        }
        int rem = 4 - parts.size();
        if (s.length() - start < rem || s.length() - start > rem * 3) return;
        for (int len = 1; len <= 3; len++) {
            if (start + len > s.length()) break;
            String seg = s.substring(start, start + len);
            if (seg.length() > 1 && seg.charAt(0) == '0') continue;
            if (Integer.parseInt(seg) > 255) continue;
            parts.add(seg);
            backtrack(s, start + len, parts, res);
            parts.remove(parts.size() - 1);
        }
    }
}
```

---

## Split String Into Descending Values (LeetCode 1849)

**Problem:** Given a string `s` of digits, split it into two or more non-empty substrings such that the values are in **strictly decreasing** order. Return `true` if such a split exists.

Backtracking with a "previous value" parameter. Try all split lengths; current segment's value must be **strictly less than** the previous. Key pruning: if `current >= prev` (and prev is set), `break` — longer segments are larger. Use `long` for large values.

```java
class Solution {
    public boolean splitString(String s) { return backtrack(s, 0, -1L, 0); }
    private boolean backtrack(String s, int start, long prev, int count) {
        if (start == s.length()) return count >= 2;
        long cur = 0;
        for (int i = start; i < s.length(); i++) {
            cur = cur * 10 + (s.charAt(i) - '0');
            if (prev != -1 && cur >= prev) break;
            if (backtrack(s, i + 1, cur, count + 1)) return true;
        }
        return false;
    }
}
```

For `s = "4321"`, valid splits include `4>3>2>1`, `43>21`, and `432>1`.

---

## Pattern Recognition Table

```
+---------------------------+--------------------+------------------+-------------------+---------------------------+
| Pattern                   | Signal Words       | Key Technique    | State Tracking    | Common LeetCode Problems  |
+---------------------------+--------------------+------------------+-------------------+---------------------------+
| Subset Enumeration        | "all subsets",     | Start index,     | current list +    | 78 Subsets,               |
|                           | "power set",       | record every     | start position    | 90 Subsets II,            |
|                           | "all combinations" | node             |                   | 784 Letter Case Perm      |
+---------------------------+--------------------+------------------+-------------------+---------------------------+
| Permutation               | "all arrangements",| used[] array,    | current list +    | 46 Permutations,          |
|                           | "all orderings",   | iterate all      | used[] boolean    | 47 Permutations II,       |
|                           | "rearrange"        | elements         | array             | 1079 Letter Tile          |
+---------------------------+--------------------+------------------+-------------------+---------------------------+
| k-Combination             | "choose k",        | Start index +    | current list +    | 77 Combinations,          |
|                           | "pick k from n"    | size constraint  | start + size      | 216 Combination Sum III   |
+---------------------------+--------------------+------------------+-------------------+---------------------------+
| Sum Targeting             | "sum to target",   | Track remaining, | current list +    | 39 Combination Sum,       |
|                           | "add up to"        | prune on overflow| remaining sum +   | 40 Combination Sum II,    |
|                           |                    |                  | start index       | 216 Combo Sum III         |
+---------------------------+--------------------+------------------+-------------------+---------------------------+
| Grid Placement            | "place on board",  | Row-by-row,      | board + conflict  | 51 N-Queens,              |
| (Constraint Satisfaction) | "fill grid",       | check conflicts  | arrays (cols,     | 37 Sudoku Solver,         |
|                           | "non-attacking"    | per placement    | diags)            | 52 N-Queens II            |
+---------------------------+--------------------+------------------+-------------------+---------------------------+
| Grid Search (DFS)         | "find word in      | DFS from each    | board with in-    | 79 Word Search,           |
|                           | grid", "path in    | cell, mark       | place visited     | 212 Word Search II,       |
|                           | matrix"            | visited          | marking           | 980 Unique Paths III      |
+---------------------------+--------------------+------------------+-------------------+---------------------------+
| String Partitioning       | "split string",    | Try all cut      | current list of   | 131 Palindrome Part,      |
|                           | "partition into",  | points, validate | segments +        | 93 Restore IP,            |
|                           | "segment"          | each segment     | start position    | 1849 Split Descending     |
+---------------------------+--------------------+------------------+-------------------+---------------------------+
| Parentheses/Brackets      | "valid parens",    | Track open/close | open count +      | 22 Generate Parens,       |
|                           | "well-formed",     | counts, add '('  | close count       | 301 Remove Invalid Parens |
|                           | "balanced"         | or ')' with      |                   |                           |
|                           |                    | constraints      |                   |                           |
+---------------------------+--------------------+------------------+-------------------+---------------------------+
| Multi-Choice Position     | "all combinations  | Map each         | current string +  | 17 Letter Combos,         |
|                           | of choices",       | position to a    | position index    | 967 Numbers Same Consec   |
|                           | "phone keypad"     | set of choices,  |                   |                           |
|                           |                    | iterate choices  |                   |                           |
+---------------------------+--------------------+------------------+-------------------+---------------------------+
```

### How to Identify the Pattern

1. **Match signal words.** "All subsets" → subset enumeration. "All orderings" → permutation. "Sum to target" → sum targeting. "Place on board" → grid placement. "Split string" → string partitioning.
2. **Determine the candidate loop.** All input elements (permutation), from a start index (subset/combination), fixed choices (parentheses, phone), or split points (string partitioning).
3. **Determine the base case.** Size reached, target met, board filled, or string consumed.
4. **Determine the pruning.** Duplicates, conflicts, sum overflow (break when sorted), invalid segments.
5. **Handle duplicates.** Sort first, then:
   - **Subset-style**: `i > start && nums[i] == nums[i-1]` — skip at same recursion level.
   - **Permutation-style**: `i > 0 && nums[i] == nums[i-1] && !used[i-1]` — skip if previous duplicate not used.

### Quick Checklist

- [ ] What is the state? What are the candidates? What is the base case?
- [ ] What is the prune condition? Are there duplicates to skip?
- [ ] Are you deep-copying the state before storing it?
- [ ] Does unchoose exactly reverse choose?
- [ ] Can you sort the input to enable pruning or duplicate skipping?

---

## Common Bugs

1. **Forgetting to deep-copy the state** before storing — stored result references the mutable state, corrupted by subsequent recursion.
2. **Mismatched choose/unchoose** — unchoose doesn't exactly reverse choose, corrupting state for the next iteration.
3. **Wrong duplicate-skipping condition** — using `i > 0` instead of `i > start`, or `used[i-1]` instead of `!used[i-1]`, leading to missing or duplicate solutions.

Master these, and backtracking will become one of your most reliable interview tools.

## Interview Cheat Sheet

**Key Points to Remember:**
- Template: choose → explore → unchoose (backtrack). Pruning is what makes backtracking tractable — prune branches that can't lead to a valid solution.
- Common patterns: permutations (swap or pick), combinations (pick/not-pick with start index), subsets (pick/not-pick), N-Queens (row-by-row with validity check).
- Always pass a mutable state (list, array) and undo changes after recursion.

**Common Follow-Up Questions:**
- "How do you decide what to backtrack on?" — The choice point is the variable you're deciding at each step: which character to place next, which number to try, which position to fill.
- "How do you optimize backtracking?" — Prune early (check validity before recursing, not after). Use memoization if subproblems overlap (then it becomes DP).

**Gotcha:**
- Forgetting to undo the choice after the recursive call. The "unchoose" step is what makes it backtracking vs brute force. If you add to the list but don't remove after recursion, you get wrong results (all solutions share the same list).
