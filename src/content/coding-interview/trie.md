---
title: "Trie — Complete Coding Interview Prep"
date: 2026-06-19
tags: [coding-interview, trie, data-structures, java, leetcode]
category: Coding Interview Prep
difficulty: Medium to Hard
estimated_study_time: 3-4 hours
leetcode_problems: [208, 211, 212, 648, 642, 1032, 720, 336, 425]
---

# Trie — Complete Coding Interview Prep

## Summary & Interview Framing

A prefix tree where each node represents a character, enabling O(L) prefix search, autocomplete, and dictionary lookups.

**How it's asked:** "Implement Trie, word search II on a grid, design autocomplete system, longest common prefix, replace words — problems involving prefix matching or word search."

---

## 1. Introduction

A **Trie** (pronounced "try", from re**trie**val) is a tree-based data structure specialized for storing and retrieving strings. Each node represents a single character, and a path from the root to any node represents a prefix shared by all strings that pass through that path. Tries shine when you need prefix-based operations — autocomplete, dictionary lookups, spell checkers, IP routing tables, and bioinformatics sequence matching.

Unlike a hashmap which gives O(1) average lookup for an exact key, a trie gives O(L) lookup where L is the length of the key — but it also gives you prefix queries, ordered iteration, and worst-case guarantees that hashmaps cannot provide (no collisions, no resizing).

### Why Learn Tries for Interviews?

Tries are a recurring theme in coding interviews because they combine tree traversal, recursion, backtracking, and string processing into a single problem domain. Companies like Google, Amazon, Meta, and Microsoft frequently ask trie problems. The key signal that a problem needs a trie:

- You need to find all words with a given **prefix**
- You need to match words against a **stream** of characters
- You need to search a **board/grid** for multiple words simultaneously
- You need **autocomplete** or **typeahead** functionality
- You need to replace words based on **shortest prefix** matches

---

## 2. Trie Fundamentals

### 2.1 Core Operations

A trie supports three fundamental operations:

1. **insert(word)** — Add a word to the trie. Walk down from the root, creating nodes for each character that doesn't exist. Mark the final node as a word-ending node.

2. **search(word)** — Check if a complete word exists in the trie. Walk from the root following each character. If you reach the end and the final node is marked as a word-ending, the word exists.

3. **startsWith(prefix)** — Check if any word in the trie begins with the given prefix. Same as search but you don't need the final node to be a word-ending node — just reaching the end of the prefix is sufficient.

All three operations run in **O(L)** time where L is the length of the word/prefix, and O(L) space for insert (in the worst case, creating L new nodes).

### 2.2 Trie Structure Visualization

Here is a trie containing the words: "cat", "car", "card", "cap", "dog":

```
                    ROOT
                   / |  \
                  c  d   (other branches...)
                 /    \
                a      o
               / \      \
              r   p      g*
             / \  *
            d*  t*
           /
          *
   
    * = word-ending marker (isEnd = true)
```

Let's break this down more explicitly:

```
root
  |
  c
  |
  a
 / \
r   p (END)  → "cap"
|
t (END)  → "cat"
|
d (END)  → "card"
  (also note: "car" ends at the 'r' node)

So the 'r' node has isEnd=true (for "car"),
and it has children 't' (→ "cat") and 'd' (→ "card").

  d
  |
  o
  |
  g (END)  → "dog"
```

### 2.3 Search Path Example

Searching for "card" in the trie above:

```
root → 'c' exists? YES → go to node[c]
node[c] → 'a' exists? YES → go to node[a]
node[a] → 'r' exists? YES → go to node[r]
node[r] → 'd' exists? YES → go to node[d]
node[d] → isEnd == true? YES → "card" found! ✓

Searching for "care":
root → 'c' → 'a' → 'r' → 'e' exists? NO → "care" NOT found ✗

Searching for prefix "ca":
root → 'c' → 'a' → reached end of prefix → startsWith("ca") = true ✓
(even though "ca" itself is not a word, it's a valid prefix of cat/car/card/cap)
```

---

## 3. Trie Node Structure in Java

The most common trie node implementation uses an array of 26 slots (for lowercase English letters a-z). This gives O(1) child access and is the standard interview implementation.

### 3.1 Array-Based TrieNode (Most Common)

```java
class TrieNode {
    TrieNode[] children = new TrieNode[26];
    boolean isEnd = false;
    
    public boolean containsKey(char c) {
        return children[c - 'a'] != null;
    }
    
    public TrieNode get(char c) {
        return children[c - 'a'];
    }
    
    public void put(char c, TrieNode node) {
        children[c - 'a'] = node;
    }
}
```

**Pros**: O(1) child lookup, simple code, no hash overhead.
**Cons**: Always uses 26 pointers per node even if most are null. For a trie with N nodes storing words over an alphabet of size A, worst-case space is O(N × A).

### 3.2 HashMap-Based TrieNode (Flexible Alphabet)

```java
class TrieNode {
    Map<Character, TrieNode> children = new HashMap<>();
    boolean isEnd = false;
}
```

**Pros**: Handles any character set (Unicode, mixed case, digits). Space-efficient for sparse nodes.
**Cons**: Hash overhead per child, slightly slower constant factors.

### 3.3 Choosing Between the Two

| Factor              | Array[26]              | HashMap                  |
|---------------------|------------------------|--------------------------|
| Alphabet            | a-z only               | Any characters           |
| Child lookup        | O(1), very fast        | O(1) avg, hash overhead  |
| Space per node      | 26 pointers always     | Only stores existing children |
| Best for            | LeetCode (lowercase)   | Production, Unicode      |
| Serialization       | Easy (fixed layout)    | Harder                   |

For interviews, **default to the array-based approach** unless the problem involves characters beyond a-z.

---

## 4. Comparison: Trie vs HashMap

| Aspect                    | Trie                                    | HashMap                              |
|---------------------------|-----------------------------------------|--------------------------------------|
| Exact key lookup          | O(L) where L = key length               | O(1) average, O(N) worst             |
| Prefix search             | O(L) to find prefix node, then traverse | O(N × L) — must check every key      |
| Worst-case guarantee      | Yes — O(L) always                       | No — hash collisions degrade         |
| Memory (sparse keys)      | Higher overhead per node                | More compact (just key-value pairs)  |
| Memory (shared prefixes)  | Excellent — shared nodes save space     | No sharing — each key stored fully   |
| Ordered traversal         | Natural lexicographic order             | No ordering (HashMap) / sorted (TreeMap) |
| Insert                    | O(L)                                    | O(1) average                         |
| Delete                    | O(L)                                    | O(1) average                         |
| Autocomplete              | Native support — traverse from prefix   | Not supported efficiently            |
| Resizing cost             | None (grows incrementally)              | Occasional rehash O(N)               |
| Collision handling        | None (structure is collision-free)      | Requires chaining or probing         |
| Best use case             | Prefix queries, autocomplete, dictionaries | Exact key-value lookups            |

**Key insight**: A trie is to a hashmap what a B-tree is to a sorted array. When you need ordered/prefix operations, the hashmap can't compete. When you only need exact lookups, the hashmap is simpler and faster.

---

## 5. LeetCode 208 — Implement Trie (Prefix Tree)

**Problem**: Implement a trie with `insert`, `search`, and `startsWith` methods.

**Difficulty**: Easy

### Solution

```java
class Trie {

    private TrieNode root;

    private static class TrieNode {
        TrieNode[] children = new TrieNode[26];
        boolean isEnd = false;
    }

    public Trie() {
        root = new TrieNode();
    }

    // Insert a word into the trie. O(L) time, O(L) space.
    public void insert(String word) {
        TrieNode node = root;
        for (char c : word.toCharArray()) {
            int idx = c - 'a';
            if (node.children[idx] == null) {
                node.children[idx] = new TrieNode();
            }
            node = node.children[idx];
        }
        node.isEnd = true;
    }

    // Returns true if the word is in the trie. O(L) time.
    public boolean search(String word) {
        TrieNode node = searchNode(word);
        return node != null && node.isEnd;
    }

    // Returns true if there is any word in the trie that starts with prefix. O(L) time.
    public boolean startsWith(String prefix) {
        return searchNode(prefix) != null;
    }

    // Helper: traverse the trie following the characters of the input.
    // Returns the final node if the path exists, null otherwise.
    private TrieNode searchNode(String s) {
        TrieNode node = root;
        for (char c : s.toCharArray()) {
            int idx = c - 'a';
            if (node.children[idx] == null) {
                return null;
            }
            node = node.children[idx];
        }
        return node;
    }
}
```

### Complexity

| Operation    | Time  | Space      |
|--------------|-------|------------|
| insert       | O(L)  | O(L) amortized |
| search       | O(L)  | O(1)       |
| startsWith   | O(L)  | O(1)       |

### Walkthrough: insert("apple")

```
Before: root (empty)

Insert 'a': root.children['a'] is null → create node[a]
Insert 'p': node[a].children['p'] is null → create node[p]
Insert 'p': node[p].children['p'] is null → create node[p2]
Insert 'l': node[p2].children['l'] is null → create node[l]
Insert 'e': node[l].children['e'] is null → create node[e]
Mark node[e].isEnd = true

root → a → p → p → l → e(END)

Now search("apple"): follows the same path, reaches e, isEnd=true → true
Now search("app"):   follows path a→p→p, reaches p2, isEnd=false → false
Now startsWith("app"): follows path a→p→p, reaches p2 (exists) → true
```

---

## 6. LeetCode 211 — Design Add and Search Words Data Structure

**Problem**: Design a data structure that supports adding words and searching. Search can contain '.' which matches any letter.

**Difficulty**: Medium

### Key Insight

The '.' wildcard means at each '.' node, we must try **all 26 children**. This transforms the search into a recursive/DFS backtracking problem. The trie gives us the structure; the recursion handles the wildcards.

### Solution

```java
class WordDictionary {

    private TrieNode root;

    private static class TrieNode {
        TrieNode[] children = new TrieNode[26];
        boolean isEnd = false;
    }

    public WordDictionary() {
        root = new TrieNode();
    }

    public void addWord(String word) {
        TrieNode node = root;
        for (char c : word.toCharArray()) {
            int idx = c - 'a';
            if (node.children[idx] == null) {
                node.children[idx] = new TrieNode();
            }
            node = node.children[idx];
        }
        node.isEnd = true;
    }

    public boolean search(String word) {
        return searchInNode(word, 0, root);
    }

    // Recursive search with wildcard support.
    // Returns true if word[index..] can be matched starting from node.
    private boolean searchInNode(String word, int index, TrieNode node) {
        // Base case: processed all characters, check if it's a complete word
        if (index == word.length()) {
            return node.isEnd;
        }

        char c = word.charAt(index);

        if (c == '.') {
            // Wildcard: try all 26 children
            for (int i = 0; i < 26; i++) {
                if (node.children[i] != null
                        && searchInNode(word, index + 1, node.children[i])) {
                    return true;
                }
            }
            return false;
        } else {
            // Regular character: must match exactly
            int idx = c - 'a';
            if (node.children[idx] == null) {
                return false;
            }
            return searchInNode(word, index + 1, node.children[idx]);
        }
    }
}
```

### Complexity

| Operation     | Time                          | Space  |
|---------------|-------------------------------|--------|
| addWord       | O(L)                          | O(L)   |
| search (no .) | O(L)                          | O(L) stack |
| search (all .)| O(26^L) worst case            | O(L) stack |

In practice, the trie prunes the search space dramatically because most branches don't exist.

### Diagram: Searching "c.t" in a trie with "cat", "car", "cot"

```
Trie contains: cat, car, cot

root
  |
  c
  |
  a        o
 / \        |
r   t      t
|   *      *
(d=card)

Search "c.t":
  index=0: 'c' → go to node[c]
  index=1: '.' → try all children of c: 'a' and 'o'
    Branch 'a':
      index=2: 't' → node[a] has child 't'? YES → isEnd? YES → return true ✓
    (Branch 'o' would also work: 't' exists → "cot" found)

Result: true (both "cat" and "cot" match "c.t")
```

---

## 7. LeetCode 212 — Word Search II

**Problem**: Given an m×n board of characters and a list of words, find all words that appear on the board. Words can be constructed from adjacent cells (horizontally/vertically), and each cell can be used at most once per word.

**Difficulty**: Hard

### Why Trie + Backtracking?

A naive approach would search for each word independently using DFS on the board — O(W × M × N × 4^L) where W is number of words. This is too slow.

By inserting all words into a trie first, we perform a **single DFS** from each board cell, simultaneously checking against all words. When a trie branch dies (no matching child), we prune immediately. This shares prefix work across words.

### Algorithm

1. Build a trie from all words.
2. For each cell on the board, start a DFS/backtracking.
3. At each step, check if the current character leads to a valid trie node.
4. If the current trie node marks a word ending, add the word to results.
5. Mark the current cell as visited (to avoid reuse), recurse to 4 neighbors, then unmark (backtrack).
6. **Optimization**: Remove leaf nodes after use to prevent duplicate searches. Also skip cells if the first character doesn't exist in the trie root.

### Board Traversal Diagram

```
Board:
  a   b   c   e
  s   f   c   s
  a   d   e   e

Words to find: ["abcced", "see", "abcb"]

Trie from words:
root
  ├─ a → b → c → c → e → d(END)
  └─ s → e → e(END)

Starting DFS from cell (0,0) = 'a':
  
  (0,0)'a' → (0,1)'b' → (0,2)'c' → (1,2)'c' → (2,2)'e' → (2,1)'d'
     ↓         ↓          ↓          ↓          ↓          ↓
   root      a           b          c          c          e → d(END) = "abcced" ✓
   
  Path on board:
  [a]→[b]→[c]→ 
              ↓
             [c]
              ↓
             [e]→[d]

Starting DFS from cell (2,3) = 'e'... no trie child 'e' at root → skip
  
Starting DFS from cell (1,3) = 's':
  (1,3)'s' → (2,3)'e' → (2,2)'e'
     ↓
   root → s → e → e(END) = "see" ✓
```

### Solution

```java
class Solution {

    // TrieNode with word stored at end nodes for easy retrieval
    private static class TrieNode {
        TrieNode[] children = new TrieNode[26];
        String word = null; // Store the complete word at the end node
    }

    private TrieNode buildTrie(String[] words) {
        TrieNode root = new TrieNode();
        for (String word : words) {
            TrieNode node = root;
            for (char c : word.toCharArray()) {
                int idx = c - 'a';
                if (node.children[idx] == null) {
                    node.children[idx] = new TrieNode();
                }
                node = node.children[idx];
            }
            node.word = word; // Mark end with the actual word
        }
        return root;
    }

    public List<String> findWords(char[][] board, String[] words) {
        List<String> result = new ArrayList<>();
        TrieNode root = buildTrie(words);

        int rows = board.length;
        int cols = board[0].length;

        for (int r = 0; r < rows; r++) {
            for (int c = 0; c < cols; c++) {
                // Optimization: only start if this char exists in trie root
                if (root.children[board[r][c] - 'a'] != null) {
                    dfs(board, r, c, root, result);
                }
            }
        }

        return result;
    }

    private void dfs(char[][] board, int r, int c, TrieNode node, List<String> result) {
        char ch = board[r][c];
        int idx = ch - 'a';

        // No matching child in trie → prune
        if (idx < 0 || idx >= 26 || node.children[idx] == null) {
            return;
        }

        node = node.children[idx];

        // Found a complete word
        if (node.word != null) {
            result.add(node.word);
            node.word = null; // De-duplicate: prevent adding the same word again
        }

        // Mark cell as visited
        board[r][c] = '#';

        // Explore 4 directions: up, down, left, right
        int[] dr = {-1, 1, 0, 0};
        int[] dc = {0, 0, -1, 1};
        for (int d = 0; d < 4; d++) {
            int nr = r + dr[d];
            int nc = c + dc[d];
            if (nr >= 0 && nr < board.length
                    && nc >= 0 && nc < board[0].length
                    && board[nr][nc] != '#') {
                dfs(board, nr, nc, node, result);
            }
        }

        // Backtrack: restore the cell
        board[r][c] = ch;

        // Pruning optimization: remove leaf nodes to speed up future traversals
        // If this node has no children and is not a word ending, remove it
        // (node.word was already set to null if it was a word, so check children only)
        boolean hasChild = false;
        for (int i = 0; i < 26; i++) {
            if (node.children[i] != null) {
                hasChild = true;
                break;
            }
        }
        if (!hasChild && node.word == null) {
            // This is safe to remove from parent — but since we hold parent
            // reference implicitly via recursion, we set it to null here
            // In practice this optimization requires passing parent reference;
            // a simpler version skips this step.
        }
    }
}
```

### Complexity

| Metric       | Complexity                                      |
|--------------|-------------------------------------------------|
| Time         | O(M × N × 4^L) where L = max word length, but trie pruning makes it much faster in practice |
| Space        | O(K) for the trie where K = total characters in all words, plus O(L) recursion stack |

### Key Optimizations

1. **Store the word at the end node** instead of using `isEnd` boolean + a separate `StringBuilder`. This avoids string concatenation during DFS.
2. **Set `node.word = null`** after finding a word to prevent duplicates and avoid re-traversal.
3. **Skip cells** whose character doesn't exist as a child of the root — significant speedup when words share common starting letters.
4. **Remove visited-character marking** by temporarily modifying the board (`board[r][c] = '#'`) instead of using a separate visited array — saves memory.

---

## 8. LeetCode 648 — Replace Words

**Problem**: Given a dictionary of roots and a sentence, replace each word in the sentence with the shortest root that is a prefix of that word. If no root is a prefix, keep the word as-is.

**Difficulty**: Medium

### Why Trie?

We need to find the **shortest prefix** of each word that matches a root. A trie naturally supports prefix matching — we walk down the trie for each word and the first time we hit an `isEnd` node, that's the shortest matching root.

### Solution

```java
class Solution {

    private static class TrieNode {
        TrieNode[] children = new TrieNode[26];
        boolean isEnd = false;
    }

    private TrieNode root;

    public String replaceWords(List<String> dictionary, String sentence) {
        // Build trie from all roots
        root = new TrieNode();
        for (String root : dictionary) {
            insert(root);
        }

        String[] words = sentence.split(" ");
        StringBuilder result = new StringBuilder();

        for (int i = 0; i < words.length; i++) {
            if (i > 0) result.append(" ");
            result.replaceWord(words[i]);
        }

        return result.toString();
    }

    private void insert(String word) {
        TrieNode node = root;
        for (char c : word.toCharArray()) {
            int idx = c - 'a';
            if (node.children[idx] == null) {
                node.children[idx] = new TrieNode();
            }
            node = node.children[idx];
        }
        node.isEnd = true;
    }

    // Find the shortest root that is a prefix of the word.
    // Return the root if found, otherwise return the original word.
    private String findShortestRoot(String word) {
        TrieNode node = root;
        StringBuilder sb = new StringBuilder();
        for (char c : word.toCharArray()) {
            int idx = c - 'a';
            if (node.children[idx] == null) {
                // No matching root — return original word
                return word;
            }
            sb.append(c);
            node = node.children[idx];
            if (node.isEnd) {
                // Found the shortest matching root
                return sb.toString();
            }
        }
        // Reached end of word without finding a root ending
        return word;
    }
}

// Helper class for clean chaining (embedded in Solution in practice)
class SolutionExtended extends Solution {
    private StringBuilder result;

    public String replaceWords(List<String> dictionary, String sentence) {
        // (same trie building as parent)
        return super.replaceWords(dictionary, sentence);
    }
}
```

**Note**: In practice, integrate `findShortestRoot` directly into the main method to avoid the helper class overhead. Here's the streamlined version:

```java
class Solution {

    private static class TrieNode {
        TrieNode[] children = new TrieNode[26];
        boolean isEnd = false;
    }

    public String replaceWords(List<String> dictionary, String sentence) {
        TrieNode root = new TrieNode();

        // Build trie
        for (String d : dictionary) {
            TrieNode node = root;
            for (char c : d.toCharArray()) {
                int i = c - 'a';
                if (node.children[i] == null) {
                    node.children[i] = new TrieNode();
                }
                node = node.children[i];
            }
            node.isEnd = true;
        }

        String[] words = sentence.split(" ");
        StringBuilder sb = new StringBuilder();

        for (int i = 0; i < words.length; i++) {
            if (i > 0) sb.append(" ");

            String word = words[i];
            TrieNode node = root;
            StringBuilder prefix = new StringBuilder();
            boolean found = false;

            for (char c : word.toCharArray()) {
                int idx = c - 'a';
                if (node.children[idx] == null) break;
                prefix.append(c);
                node = node.children[idx];
                if (node.isEnd) {
                    found = true;
                    break;
                }
            }

            sb.append(found ? prefix.toString() : word);
        }

        return sb.toString();
    }
}
```

### Complexity

| Metric | Complexity                              |
|--------|-----------------------------------------|
| Time   | O(D + S) where D = total chars in dictionary, S = total chars in sentence |
| Space  | O(D) for the trie                       |

### Diagram

```
Dictionary: ["cat", "bat", "rat"]
Trie:
root → c → a → t(END)
     → b → a → t(END)
     → r → a → t(END)

Sentence: "the cattle was rattled by the battery"

Processing each word:
  "the"     → walk: t→h→e... no match at 'h' → keep "the"
  "cattle"  → walk: c→a→t → isEnd at 't'! → replace with "cat"
  "was"     → walk: w→... no match → keep "was"
  "rattled" → walk: r→a→t → isEnd at 't'! → replace with "rat"
  "by"      → walk: b→... 'y' not child → keep "by"
  "the"     → keep "the"
  "battery" → walk: b→a→t → isEnd at 't'! → replace with "bat"

Result: "the cat was rat by the bat"
```

---

## 9. LeetCode 1032 — Stream of Characters

**Problem**: Design a data structure that accepts a stream of characters and can check if the **last K characters** (for any K) form a word in a given dictionary. Queries come one character at a time.

**Difficulty**: Hard

### Key Insight: Aho-Corasick Concept

The naive approach — storing all words in a set and checking every suffix of the stream — is O(N × L) per query where L is the max word length.

The trie-based approach: **insert all words into a trie in reverse order**. When a character arrives, we maintain a list of recent characters and walk up the trie from the most recent character. If we reach an `isEnd` node at any point, a word was found.

This is related to the **Aho-Corasick** algorithm, which extends a trie with failure links (like KMP failure function) to efficiently match multiple patterns in a text in a single pass. For this problem, the reversed-trie approach is simpler and sufficient.

### Solution

```java
class StreamChecker {

    private static class TrieNode {
        TrieNode[] children = new TrieNode[26];
        boolean isEnd = false;
    }

    private TrieNode root;
    private StringBuilder stream; // Stores the stream of characters received

    public StreamChecker(String[] words) {
        root = new TrieNode();
        stream = new StringBuilder();

        // Insert each word in REVERSE order into the trie.
        // Why reverse? Because we need to check if the last K characters
        // form a word — so we match from the end backwards.
        for (String word : words) {
            TrieNode node = root;
            for (int i = word.length() - 1; i >= 0; i--) {
                int idx = word.charAt(i) - 'a';
                if (node.children[idx] == null) {
                    node.children[idx] = new TrieNode();
                }
                node = node.children[idx];
            }
            node.isEnd = true;
        }
    }

    public boolean query(char c) {
        stream.append(c);

        // Walk the trie from root, matching characters in reverse order
        // (most recent first).
        TrieNode node = root;
        for (int i = stream.length() - 1; i >= 0; i--) {
            int idx = stream.charAt(i) - 'a';
            if (node.children[idx] == null) {
                // No path matches — no word ending here
                return false;
            }
            node = node.children[idx];
            if (node.isEnd) {
                // Found a word that ends at the current stream position
                return true;
            }
        }

        return false;
    }
}
```

### Aho-Corasick Overview (For Deeper Understanding)

The Aho-Corasick algorithm builds on a trie by adding **failure links** — pointers from each node to the longest proper suffix of the current path that is also a prefix of some pattern. This allows the automaton to process text in O(N) time regardless of pattern count.

```
Trie with failure links (Aho-Corasick):
Patterns: "he", "she", "his", "hers"

       root
      / |  \
     h  s   
    / \  \   
   e*  i  h
   |   |   |
   r   s*  e*
   |
   s*

Failure links (not shown in ASCII but conceptually):
  node "e" (under h) → links to root (no suffix of "he" is a prefix of another pattern)
  node "h" (under s) → links to node "h" (under root)
  node "e" (under s→h→e) → links to node "e" (under h, root→h→e) 
    because suffix "he" of "she" is a prefix of "he"

When processing text character by character:
  - Follow trie edges when possible
  - Follow failure links when no edge exists (like KMP)
  - At each node, check all suffix matches via output links
```

### Complexity

| Operation       | Time                          | Space              |
|-----------------|-------------------------------|--------------------|
| Constructor     | O(K) where K = total chars in all words | O(K)        |
| query (per char)| O(L) where L = max word length | O(L) per query (stream buffer) |

### Diagram: Stream "abcba" with dictionary ["bc", "bca", "cba"]

```
Words reversed: "cb", "acb", "abc"
Trie (reversed words):
root → c → b(END)
     → a → c → b(END)
     → a → b → c(END)

Stream processing:
  query('a'): stream="a" → walk: a... no child 'a' at root? 
    Wait — "a" reversed is "a". We inserted "cb","acb","abc".
    root has children: c, a, a → let me re-draw.

Actually, reversed insertions:
  "bc"  → reversed "cb"  → root→c→b(END)
  "bca" → reversed "acb" → root→a→c→b(END)
  "cba" → reversed "abc" → root→a→b→c(END)

query('a'): stream="a", walk from end: 'a' → root.children['a'] exists → go
            node[a].isEnd? No → no more chars → false
query('b'): stream="ab", walk: 'b'→root.children['b']? No → false  
  (Wait, root only has 'c' and 'a'. Let me re-check.)
  
  Re-reading: root→c→b and root→a→c→b and root→a→b→c
  So root has children: c, a (two branches share 'a'? No, a is one node)

query('b'): stream="ab"
  walk from end: 'b' → root.children['b']? NULL → false

query('c'): stream="abc"
  walk from end: 'c' → root.children['c'] exists → node[c]
  next: 'b' → node[c].children['b'] exists → node[b]
  node[b].isEnd? YES → true! ("bc" found as suffix)
```

---

## 10. LeetCode 642 — Design Search Autocomplete System

**Problem**: Design a search autocomplete system for a search engine. Given a list of sentences and their frequencies, implement an input method that returns the top 3 historical hot sentences that match the current input prefix.

**Difficulty**: Hard

### Key Insight

This is the quintessential trie problem. We build a trie where each node stores the **top 3 sentences** that pass through that node (by frequency, then lexicographic order). As the user types each character, we traverse the trie and immediately return the cached top 3.

### Solution

```java
import java.util.*;

class AutocompleteSystem {

    // Trie node that stores the top 3 hot sentences at each prefix node
    private static class TrieNode {
        Map<Character, TrieNode> children = new HashMap<>();
        // Store up to 3 hottest sentences at this node (the prefix)
        List<Sentence> top3 = new ArrayList<>();
    }

    // Sentence with frequency, comparable for sorting
    private static class Sentence implements Comparable<Sentence> {
        String text;
        int freq;

        Sentence(String text, int freq) {
            this.text = text;
            this.freq = freq;
        }

        @Override
        public int compareTo(Sentence other) {
            // Higher frequency first; ties broken by lexicographic order
            if (this.freq != other.freq) {
                return other.freq - this.freq; // descending frequency
            }
            return this.text.compareTo(other.text); // ascending lexicographic
        }
    }

    private TrieNode root;
    private TrieNode currentNode;     // Current position in trie as user types
    private StringBuilder currentInput;

    public AutocompleteSystem(String[] sentences, int[] times) {
        root = new TrieNode();
        currentNode = root;
        currentInput = new StringBuilder();

        for (int i = 0; i < sentences.length; i++) {
            insert(sentences[i], times[i]);
        }
    }

    // Insert a sentence into the trie and update top3 at each node along the path
    private void insert(String sentence, int freq) {
        TrieNode node = root;
        for (char c : sentence.toCharArray()) {
            if (!node.children.containsKey(c)) {
                node.children.put(c, new TrieNode());
            }
            node = node.children.get(c);

            // Update top3 for this prefix node
            updateTop3(node, sentence, freq);
        }
    }

    // Add/update a sentence in a node's top3 list
    private void updateTop3(TrieNode node, String sentence, int freq) {
        // Check if sentence already in top3 (update its frequency)
        boolean found = false;
        for (Sentence s : node.top3) {
            if (s.text.equals(sentence)) {
                s.freq += freq; // This handles re-insertion during recording
                found = true;
                break;
            }
        }

        if (!found) {
            node.top3.add(new Sentence(sentence, freq));
        }

        // Re-sort and keep only top 3
        Collections.sort(node.top3);
        if (node.top3.size() > 3) {
            node.top3 = node.top3.subList(0, 3);
        }
    }

    // Process one character of input and return matching sentences
    public List<String> input(char c) {
        if (c == '#') {
            // End of input — record the current sentence
            String sentence = currentInput.toString();
            insert(sentence, 1);
            // Reset for next search
            currentInput = new StringBuilder();
            currentNode = root;
            return new ArrayList<>();
        }

        currentInput.append(c);

        // If current trie node has a child for c, move to it
        if (currentNode != null && currentNode.children.containsKey(c)) {
            currentNode = currentNode.children.get(c);
            List<String> result = new ArrayList<>();
            for (Sentence s : currentNode.top3) {
                result.add(s.text);
            }
            return result;
        } else {
            // No sentences match this prefix — return empty for this and future chars
            currentNode = null;
            return new ArrayList<>();
        }
    }
}
```

### Complexity

| Operation         | Time                                      | Space              |
|-------------------|-------------------------------------------|--------------------|
| Constructor       | O(N × L × log3) where N = sentences, L = avg length | O(N × L)   |
| input (per char)  | O(log3) ≈ O(1) for traversal + O(3) for result | O(1)        |
| input ('#' record)| O(L × log3) for re-insert                 | O(L) added to trie |

### Diagram

```
Sentences: ["i love you":5, "i love leetcode":3, "ironman":2, "i am cool":1]

Trie structure with top3 at each node:

root
  └─ 'i'
     top3: ["i love you", "i love leetcode", "ironman"]
     ├─ ' '
     │  top3: ["i love you", "i love leetcode", "i am cool"]
     │  ├─ 'l' → 'o' → 'v' → 'e' → ...
     │  └─ 'a' → 'm' → ...
     ├─ 'r' → 'o' → 'n' → ...
     └─ ...

User types 'i':     → node['i'].top3 = ["i love you", "i love leetcode", "ironman"]
User types ' ':     → node['i'][' '].top3 = ["i love you", "i love leetcode", "i am cool"]
User types 'l':     → node['i'][' ']['l'].top3 = ["i love you", "i love leetcode"]
User types 'o':     → node['i'][' ']['l']['o'].top3 = ["i love you", "i love leetcode"]
...
User types '#':     → record sentence "i love you..." with freq+1, reset
```

### Alternative Approach: Trie + DFS

Instead of caching top3 at each node, you can traverse the trie to the prefix node and then **DFS** to collect all sentences below that node, sort by frequency, and return top 3. This uses less memory but is O(N) per query instead of O(1). The cached approach above is the **production-grade** solution used by real search engines (with more sophisticated ranking).

---

## 11. Word Squares (LeetCode 425)

**Problem**: Given a set of words (all same length), return all word squares. A word square is a sequence of K words where the K×K grid reads the same horizontally and vertically.

**Difficulty**: Hard

### Concept

```
Word square example:
  b a l l
  a r e a
  l e a d
  l a d y

  Row 1: "ball"    Col 1: "ball"  ✓
  Row 2: "area"    Col 2: "area"  ✓
  Row 3: "lead"    Col 3: "lead"  ✓
  Row 4: "lady"    Col 4: "lady"  ✓
```

### Why Trie?

When building a word square row by row, after placing the first R words, the next word must start with a **specific prefix** — the prefix formed by reading the R-th column so far. For example, after placing "ball" and "area", the third word must start with "le" (the first two characters of column 3). A trie lets us efficiently find all words with a given prefix.

### Algorithm (Conceptual)

1. Build a trie from all words.
2. Use backtracking: place a word in the first row, then the second, etc.
3. At step K, compute the required prefix from column K of the current square.
4. Use the trie to find all words with that prefix — these are candidates for row K.
5. Recurse with each candidate.
6. When K words are placed, add the square to results.

```java
// Conceptual solution (pattern, not full implementation)
class Solution {
    private static class TrieNode {
        TrieNode[] children = new TrieNode[26];
        List<String> wordsWithPrefix = new ArrayList<>(); // All words passing through
    }

    private TrieNode buildTrie(String[] words) {
        TrieNode root = new TrieNode();
        for (String word : words) {
            TrieNode node = root;
            for (char c : word.toCharArray()) {
                node.wordsWithPrefix.add(word);
                int i = c - 'a';
                if (node.children[i] == null) node.children[i] = new TrieNode();
                node = node.children[i];
            }
            node.wordsWithPrefix.add(word);
        }
        return root;
    }

    private List<String> getWordsWithPrefix(TrieNode root, String prefix) {
        TrieNode node = root;
        for (char c : prefix.toCharArray()) {
            int i = c - 'a';
            if (node.children[i] == null) return new ArrayList<>();
            node = node.children[i];
        }
        return node.wordsWithPrefix;
    }

    public List<List<String>> wordSquares(String[] words) {
        TrieNode root = buildTrie(words);
        List<List<String>> result = new ArrayList<>();
        for (String word : words) {
            List<String> square = new ArrayList<>();
            square.add(word);
            backtrack(square, words[0].length(), root, result);
        }
        return result;
    }

    private void backtrack(List<String> square, int len, TrieNode root, List<List<String>> result) {
        if (square.size() == len) {
            result.add(new ArrayList<>(square));
            return;
        }
        // Build prefix from the current column
        int col = square.size();
        StringBuilder prefix = new StringBuilder();
        for (String w : square) {
            prefix.append(w.charAt(col));
        }
        // Get all words with this prefix
        for (String candidate : getWordsWithPrefix(root, prefix.toString())) {
            square.add(candidate);
            backtrack(square, len, root, result);
            square.remove(square.size() - 1);
        }
    }
}
```

### Diagram

```
Building a word square step by step:

Step 1: Place "ball" in row 1
  [b a l l]
  
Step 2: Row 2 must start with column 1's char[1] = 'a'
  Prefix = "a" → candidates: "area"
  [b a l l]
  [a r e a]
  
Step 3: Row 3 must start with column 1's char[2]+'2' = "le"
  Prefix = "le" → candidates: "lead", "lens", ...
  [b a l l]
  [a r e a]
  [l e a d]
  
Step 4: Row 4 must start with column 1's char[3]+'3' = "la"
  Prefix = "la" → candidates: "lady", "land", ...
  [b a l l]
  [a r e a]
  [l e a d]
  [l a d y]
  
  ✓ Complete word square!
```

---

## 12. Longest Word in Dictionary (LeetCode 720)

**Problem**: Given a list of strings, find the longest word that can be built one character at a time by other words in the list. Return the lexicographically smallest if ties.

**Difficulty**: Easy

### Why Trie?

We need to check if every prefix of a word exists in the dictionary. A trie makes this trivially efficient — when traversing from root to a word's end, every node along the path should have `isEnd = true`.

### Algorithm

1. Build a trie from all words.
2. DFS through the trie, only following nodes where `isEnd = true` (every prefix must be a valid word).
3. Track the longest word found; break ties lexicographically (explore children in alphabetical order).

```java
class Solution {
    private static class TrieNode {
        TrieNode[] children = new TrieNode[26];
        String word = null; // Store word at end node
    }

    private TrieNode buildTrie(String[] words) {
        TrieNode root = new TrieNode();
        for (String w : words) {
            TrieNode node = root;
            for (char c : w.toCharArray()) {
                int i = c - 'a';
                if (node.children[i] == null) node.children[i] = new TrieNode();
                node = node.children[i];
            }
            node.word = w;
        }
        return root;
    }

    public String longestWord(String[] words) {
        TrieNode root = buildTrie(words);
        String[] result = {""};
        dfs(root, result);
        return result[0];
    }

    private void dfs(TrieNode node, String[] result) {
        // Only follow paths where every prefix is a word
        for (int i = 0; i < 26; i++) {
            if (node.children[i] != null && node.children[i].word != null) {
                // This child represents a valid word (prefix check)
                if (node.children[i].word.length() > result[0].length()) {
                    result[0] = node.children[i].word;
                }
                dfs(node.children[i], result);
            }
        }
    }
}
```

### Diagram

```
Words: ["w","wo","wor","worl","world","a","ap","app","appl","apple"]

Trie (simplified, showing only isEnd=true paths):
root → w(END) → o(END) → r(END) → l(END) → d(END) = "world"
     → a(END) → p(END) → p(END) → l(END) → e(END) = "apple"

DFS from root:
  'w' path: w→wo→wor→worl→world (all isEnd=true) → length 5
  'a' path: a→ap→app→appl→apple (all isEnd=true) → length 5

Tie at length 5: "apple" vs "world"
Lexicographically smaller: "apple" < "world" → "apple"
But DFS explores 'a' before 'w', so "apple" is found first.
Since we only update when strictly longer, first found wins for ties.
Adjust comparison to >= for lexicographic tie-breaking if needed.
```

---

## 13. Palindrome Pairs (LeetCode 336)

**Problem**: Given a list of unique words, find all pairs (i, j) such that words[i] + words[j] is a palindrome.

**Difficulty**: Hard

### Why Trie?

A trie helps efficiently find words whose **reverse** has a specific prefix relationship with another word. The key insight:

- If `word1 + word2` is a palindrome, then either:
  - `word1` is longer than `word2` and `word1`'s extra suffix is itself a palindrome, with `word2` being the reverse of `word1`'s prefix
  - `word2` is longer than `word1` and `word2`'s extra prefix is itself a palindrome, with `word1` being the reverse of `word2`'s suffix

A trie built on **reversed** words lets us check these conditions efficiently.

### Algorithm (Conceptual)

1. Build a trie from all words **reversed**.
2. For each word, search the trie:
   - If the word fully matches a reversed word and that reversed word's node has `isEnd`, check if the remaining suffix of the word is a palindrome.
   - If the trie ends before the word ends, check if the remaining characters of the word form a palindrome.
3. Collect all valid pairs.

```java
class Solution {
    private static class TrieNode {
        TrieNode[] children = new TrieNode[26];
        int index = -1; // Index of the word ending here (-1 if not a word end)
        List<Integer> palindromePrefixIndices = new ArrayList<>();
        // Stores indices of words where the remaining suffix is a palindrome
    }

    private TrieNode root;

    public List<List<Integer>> palindromePairs(String[] words) {
        root = new TrieNode();
        List<List<Integer>> result = new ArrayList<>();

        // Build trie with reversed words
        for (int i = 0; i < words.length; i++) {
            insertReversed(words[i], i);
        }

        // Search for palindrome pairs
        for (int i = 0; i < words.length; i++) {
            search(words[i], i, result);
        }

        return result;
    }

    private void insertReversed(String word, int index) {
        TrieNode node = root;
        for (int i = word.length() - 1; i >= 0; i--) {
            int c = word.charAt(i) - 'a';
            if (node.children[c] == null) {
                node.children[c] = new TrieNode();
            }
            // If remaining prefix (from 0 to i) is a palindrome, store this index
            if (isPalindrome(word, 0, i)) {
                node.palindromePrefixIndices.add(index);
            }
            node = node.children[c];
        }
        node.index = index;
        node.palindromePrefixIndices.add(index); // Empty suffix is palindrome
    }

    private void search(String word, int index, List<List<Integer>> result) {
        TrieNode node = root;
        for (int i = 0; i < word.length(); i++) {
            int c = word.charAt(i) - 'a';
            // Case 1: word is longer, trie path ends, remaining suffix must be palindrome
            if (node.index >= 0 && node.index != index && isPalindrome(word, i, word.length() - 1)) {
                result.add(Arrays.asList(index, node.index));
            }
            if (node.children[c] == null) return;
            node = node.children[c];
        }
        // Case 2: word fully consumed, remaining words in trie with palindrome prefix
        for (int j : node.palindromePrefixIndices) {
            if (j != index) {
                result.add(Arrays.asList(index, j));
            }
        }
    }

    private boolean isPalindrome(String s, int left, int right) {
        while (left < right) {
            if (s.charAt(left++) != s.charAt(right--)) return false;
        }
        return true;
    }
}
```

### Diagram

```
Words: ["abcd","dcba","lls","s","sssll"]

Reversed words in trie:
  "abcd" → reversed "dcba"
  "dcba" → reversed "abcd"
  "lls"  → reversed "sll"
  "s"    → reversed "s"
  "sssll"→ reversed "llsss"

root
  ├─ d → c → b → a (END, index=0)  ← reversed "abcd"
  ├─ a → b → c → d (END, index=1)  ← reversed "dcba"
  ├─ s → l → l (END, index=2)      ← reversed "lls"
  │     └─ s → s (END, index=4)    ← reversed "sssll"
  └─ s (END, index=3)              ← reversed "s"

Searching "abcd":
  Walk: a→b→c→d → node[END, index=1]
  word fully consumed, node.index=1 ("dcba")
  "abcd" + "dcba" = "abcddcba" → palindrome? YES ✓
  Pair: (0, 1)

Searching "lls":
  Walk: l→l→s → node[END, index=2] is at the 's' under l→l
  word fully consumed. Check palindromePrefixIndices.
  "lls" + "s" = "llss" → palindrome? YES ✓
  Pair: (2, 3)
  
Searching "s":
  Walk: s → node[END, index=3]
  word consumed, check palindromePrefixIndices at node[s]:
    includes index=2 ("lls") because "sll" reversed is "lls"
    and "lls" has palindrome prefix check...
  "s" + "lls" = "slls" → palindrome? YES ✓
  Pair: (3, 2)
```

---

## 14. Suffix Trie Concept

A **suffix trie** is a trie that contains **all suffixes** of a given string. It's different from a standard trie (which stores complete words). A suffix trie for a string S of length N has O(N²) nodes in the worst case but enables powerful string operations.

### Building a Suffix Trie

For a string "banana", insert every suffix:

```
Suffixes of "banana":
  banana
  anana
  nana
  ana
  na
  a

Suffix trie:
root
  ├─ b → a → n → a → n → a$
  ├─ a → n → a → n → a$
  │     └─ n → a$
  │           └─ a$
  └─ n → a → n → a$
        └─ a$

$ = end-of-string marker
```

### Applications of Suffix Tries

| Application                  | How Suffix Trie Helps                                   |
|------------------------------|---------------------------------------------------------|
| Pattern matching             | Check if pattern P exists in text T: O(P) time          |
| Longest repeated substring   | Find deepest internal node with ≥2 children             |
| Longest common substring     | Generalized suffix trie of two strings                  |
| Palindrome detection         | Combine with reversed string suffix trie                |
| Count occurrences of pattern | Count leaf nodes under pattern's end node               |

### Suffix Trie vs Suffix Tree vs Suffix Array

| Structure       | Nodes        | Build Time   | Space       |
|-----------------|--------------|--------------|-------------|
| Suffix Trie     | O(N²)        | O(N²)        | O(N²)       |
| Suffix Tree     | O(N)         | O(N) (Ukkonen) | O(N)      |
| Suffix Array    | N entries    | O(N log N)   | O(N)        |

For interviews, understanding the suffix trie **concept** is sufficient. The suffix tree and suffix array are advanced topics typically only asked at very senior levels.

### Note on Suffix Arrays

A suffix array is a more space-efficient alternative — it's simply an array of starting indices of all suffixes, sorted lexicographically. Binary search on a suffix array gives O(P log N) pattern matching. Most production systems use suffix arrays or suffix automata rather than suffix tries due to the quadratic space.

---

## 15. Pattern Recognition Table

Use this table to quickly identify when a problem calls for a trie:

| Signal in the Problem                                  | Trie Pattern to Use                          | Example Problems                    |
|--------------------------------------------------------|----------------------------------------------|-------------------------------------|
| Find all words with a given prefix                     | Standard trie + traverse from prefix node     | 208, Autocomplete                   |
| Replace word with shortest matching prefix             | Trie walk, return at first isEnd             | 648 (Replace Words)                 |
| Wildcard matching ('.' matches any char)               | Trie + recursive DFS at wildcards            | 211 (Add and Search Word)          |
| Search multiple words on a board/grid simultaneously   | Trie + backtracking DFS on board             | 212 (Word Search II)               |
| Check if any word ends at current stream position      | Reversed trie + walk backwards               | 1032 (Stream of Characters)        |
| Autocomplete with frequency ranking                    | Trie with cached top-K at each node          | 642 (Autocomplete System)          |
| Word must be built one char at a time from other words | Trie DFS, only follow isEnd paths            | 720 (Longest Word in Dictionary)   |
| Concatenated strings form palindromes                  | Reversed trie + palindrome checks            | 336 (Palindrome Pairs)             |
| K words where row i = column i                         | Trie for prefix lookup + backtracking        | 425 (Word Squares)                 |
| Find all occurrences of multiple patterns in text      | Aho-Corasick (trie + failure links)          | Multi-pattern matching             |
| Shortest encoding of strings with shared suffixes      | Reversed trie, prune shared suffixes         | 820 (Short Encoding of Words)      |
| Need to remove words by prefix                         | Trie with word count at each node            | 1804 (Implement Trie II)           |
| Search in 2D matrix with word dictionary               | Trie + DFS from each cell                    | 212 variant                        |
| Top K frequent words with prefix                       | Trie + min-heap or sorted list at nodes      | 642, 692 variant                    |
| Need lexicographic ordering of stored strings          | Trie (natural ordering via DFS)              | 720, 386                           |

### Quick Decision Flowchart

```
Does the problem involve prefix matching?
├── No → Consider hashmap, set, or other structures
└── Yes
    ├── Is it a simple insert/search/startsWith?
    │   └── Standard trie (208)
    ├── Are there wildcards?
    │   └── Trie + recursive search (211)
    ├── Is it on a board/grid?
    │   └── Trie + DFS backtracking (212)
    ├── Is it a character stream?
    │   └── Reversed trie (1032)
    ├── Does it need ranking/top-K?
    │   └── Trie + cached results at nodes (642)
    ├── Replace with shortest prefix?
    │   └── Trie walk, return at first isEnd (648)
    └── Multiple patterns in text?
        └── Aho-Corasick (failure links)
```

---

## 16. Common Pitfalls and Tips

### Pitfalls

1. **Forgetting `isEnd` check in search**: `search` must verify the final node has `isEnd = true`. Just reaching the end of the word string doesn't mean a word ends there — it might be a prefix of a longer word. `startsWith` does NOT need this check.

2. **Not resetting for each query in autocomplete**: The `currentNode` must reset to root when '#' is received, not just when a new search starts.

3. **Infinite loops in Word Search II**: Forgetting to mark cells as visited before recursing, or forgetting to unmark (backtrack) after recursing.

4. **Duplicate results in Word Search II**: If the same word can be formed via multiple paths, you'll get duplicates. Setting `node.word = null` after finding prevents this.

5. **Off-by-one in Stream of Characters**: The reversed trie must be walked from the **most recent** character backwards, not from the beginning.

6. **Not handling empty strings**: Some problems have empty strings in input. Handle them explicitly — an empty string is a valid prefix of everything.

### Tips

1. **Always start with the array-based TrieNode** for lowercase a-z problems. Switch to HashMap only if the character set is larger.

2. **Store the word at the end node** (instead of just `isEnd`) when you need to retrieve the actual word — this avoids passing a `StringBuilder` around during DFS.

3. **Prune the trie during DFS** in Word Search II by removing nodes that have no children and aren't word endings. This can dramatically speed up the search.

4. **For autocomplete, cache top-K at each node** instead of doing a full DFS traversal every query. This is the key to O(1) per-character query time.

5. **Reversed tries are powerful** for suffix-based queries (Stream of Characters, Palindrome Pairs). Many problems become much simpler when you reverse the strings before building the trie.

6. **Trie + backtracking is a powerful combo** — the trie prunes invalid paths early, and backtracking explores valid paths. This pattern appears in Word Search II, Word Squares, and Word Break II variants.

---

## 17. Time & Space Complexity Summary

| Problem                          | Time Complexity                          | Space Complexity      |
|----------------------------------|------------------------------------------|-----------------------|
| Implement Trie (208)             | O(L) per operation                       | O(N × L) total        |
| Add and Search Word (211)        | O(L) insert, O(26^L) search worst        | O(N × L)              |
| Word Search II (212)             | O(M × N × 4^L) worst, pruned in practice | O(K + L) where K = trie size |
| Replace Words (648)              | O(D + S)                                 | O(D)                  |
| Stream of Characters (1032)      | O(L) per query                           | O(K) trie + O(L) buffer |
| Autocomplete System (642)        | O(1) per input char, O(L) on '#'         | O(N × L)              |
| Longest Word in Dictionary (720) | O(N × L)                                 | O(N × L)              |
| Palindrome Pairs (336)           | O(N × L²)                                | O(N × L)              |
| Word Squares (425)               | O(N × L × branching^L)                   | O(N × L)              |

Where:
- N = number of words
- L = average/max word length
- M × N = board dimensions
- K = total characters across all words
- D = total characters in dictionary
- S = total characters in sentence

---

## 18. Study Path

1. **Start here**: Implement Trie (208) — master the basic structure and three operations.
2. **Next**: Add and Search Word (211) — learn trie + recursion for wildcards.
3. **Then**: Replace Words (648) — understand prefix-based replacement.
4. **Challenge 1**: Word Search II (212) — master trie + backtracking on a grid.
5. **Challenge 2**: Stream of Characters (1032) — learn reversed tries and Aho-Corasick concepts.
6. **Challenge 3**: Design Search Autocomplete System (642) — build a production-grade trie with caching.
7. **Advanced**: Word Squares (425), Palindrome Pairs (336) — complex trie applications.
8. **Bonus**: Longest Word in Dictionary (720) — quick win to reinforce trie traversal.

---

## Summary

Tries are a specialized data structure that excel at prefix-based string operations. The core operations (insert, search, startsWith) are all O(L) where L is the word length. The power of tries lies in their ability to:

- Share prefix storage across words (space efficiency for common prefixes)
- Answer prefix queries in O(L) time (impossible with hashmaps)
- Support ordered traversal naturally (lexicographic order)
- Combine with backtracking/DFS for complex search problems (Word Search II, Word Squares)
- Handle streaming input efficiently (Stream of Characters, Autocomplete)

The six LeetCode problems covered here (208, 211, 212, 648, 642, 1032) represent the core trie patterns you'll encounter in interviews. Master these, and you'll be able to handle any trie-based problem by recognizing which pattern applies and adapting the implementation accordingly.

Remember: **when you see prefix matching, autocomplete, or multi-word search on a grid, think trie**. The trie gives you the structure; the algorithm (backtracking, recursion, caching) gives you the solution.

## Interview Cheat Sheet

**Key Points to Remember:**
- Trie = prefix tree; each node has children (26 for lowercase English).
- Insert/search/startsWith all O(L) where L = word length. Space: O(N*L) where N = number of words.
- Use `isEndOfWord` flag to distinguish prefix from complete word.
- For word search on grid (LeetCode 212), insert all words into trie, then DFS the grid.

**Common Follow-Up Questions:**
- *How do you optimize trie memory?* — Use HashMap instead of fixed array for children (saves space for sparse nodes). Compressed trie (radix tree) merges single-child chains.
- *What's the difference between trie and hash set?* — Hash set: O(L) exact match, no prefix query. Trie: O(L) exact match AND O(L) prefix query.

**Gotcha:**
- Confusing `startsWith` (is this a valid prefix?) with `search` (is this a complete word?). The `isEndOfWord` flag distinguishes them — a prefix "app" exists in trie for "apple" but `search("app")` returns false unless "app" was explicitly inserted.
