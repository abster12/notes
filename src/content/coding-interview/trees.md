---
title: "Trees — Coding Interview Prep"
category: "Data Structures & Algorithms"
tags: [trees, binary-tree, bst, traversals, interview, java]
date: 2026-06-19
difficulty: medium-to-hard
estimated_read_time: 45 minutes
---

# Trees — Complete Coding Interview Prep Guide

Trees are the backbone of countless interview questions. They test recursion, iterative thinking, pointer manipulation, and your ability to decompose problems. This guide covers everything from basic traversals to hard path-sum problems, with full Java solutions and ASCII diagrams.

---

## Summary & Interview Framing

Hierarchical data structures — binary trees, BSTs, and traversal patterns (in-order, pre-order, post-order, level-order) with recursive decomposition.

**How it's asked:** "Invert binary tree, lowest common ancestor, validate BST, level order traversal, path sum — problems involving recursive traversal and structural reasoning."

---

## 1. Binary Tree Basics

A **binary tree** is a hierarchical data structure where each node has at most two children, referred to as the **left child** and **right child**.

```
        1          <-- root
       / \
      2   3        <-- internal nodes
     / \   \
    4   5   6      <-- leaf nodes (no children)
```

### Key Terminology
- **Root**: Topmost node (no parent). **Leaf**: Node with no children.
- **Height of node**: Edges on longest path from node to a leaf. **Depth**: Edges from node to root.
- **Full binary tree**: Every node has 0 or 2 children. **Complete**: All levels filled except possibly last, filled left to right. **Perfect**: All internal nodes have 2 children, all leaves at same level. **Balanced**: Left/right subtree heights differ by at most 1 at every node.

### Node Definition (Java)

```java
public class TreeNode {
    int val;
    TreeNode left;
    TreeNode right;

    TreeNode(int val) {
        this.val = val;
    }

    TreeNode(int val, TreeNode left, TreeNode right) {
        this.val = val;
        this.left = left;
        this.right = right;
    }
}
```

### Complexity Cheat Sheet
| Operation | Time (avg) | Worst | Space |
|-----------|-----------|-------|-------|
| Traversal | O(n) | O(n) | O(h) |
| Search (BST) | O(log n) | O(n) | O(h) |
| Insert/Delete (BST) | O(log n) | O(n) | O(h) |

Where `n` = nodes, `h` = height (log n when balanced).

---

## 2. Tree Traversals

Traversals define the order in which you visit every node. Mastering these is essential because most tree problems build on them.

### 2.1 Depth-First Traversals

For any node, there are three positions to process it: **before** (preorder), **between** (inorder), **after** (postorder) its children.

```
Sample tree:
        1
       / \
      2   3
     / \
    4   5

Preorder  (root, left, right): 1, 2, 4, 5, 3
Inorder   (left, root, right): 4, 2, 5, 1, 3
Postorder (left, right, root): 4, 5, 2, 3, 1
```

### Inorder Traversal (Recursive)

```java
public List<Integer> inorderTraversal(TreeNode root) {
    List<Integer> result = new ArrayList<>();
    inorder(root, result);
    return result;
}

private void inorder(TreeNode node, List<Integer> result) {
    if (node == null) return;
    inorder(node.left, result);
    result.add(node.val);
    inorder(node.right, result);
}
```

### Inorder Traversal (Iterative — using a stack)

```java
public List<Integer> inorderTraversalIterative(TreeNode root) {
    List<Integer> result = new ArrayList<>();
    Deque<TreeNode> stack = new ArrayDeque<>();
    TreeNode curr = root;

    while (curr != null || !stack.isEmpty()) {
        // Go as far left as possible
        while (curr != null) {
            stack.push(curr);
            curr = curr.left;
        }
        // Process the node
        curr = stack.pop();
        result.add(curr.val);
        // Move to right subtree
        curr = curr.right;
    }
    return result;
}
```

### Preorder Traversal (Iterative)

```java
public List<Integer> preorderTraversal(TreeNode root) {
    List<Integer> result = new ArrayList<>();
    if (root == null) return result;
    Deque<TreeNode> stack = new ArrayDeque<>();
    stack.push(root);

    while (!stack.isEmpty()) {
        TreeNode node = stack.pop();
        result.add(node.val);
        // Push right first so left is processed first
        if (node.right != null) stack.push(node.right);
        if (node.left != null) stack.push(node.left);
    }
    return result;
}
```

### Postorder Traversal (Iterative — tricky!)

The iterative postorder is the hardest of the three. Trick: modify preorder to root-right-left, then reverse the result using `addFirst`.

```java
public List<Integer> postorderTraversal(TreeNode root) {
    LinkedList<Integer> result = new LinkedList<>();
    if (root == null) return result;
    Deque<TreeNode> stack = new ArrayDeque<>();
    stack.push(root);

    while (!stack.isEmpty()) {
        TreeNode node = stack.pop();
        result.addFirst(node.val);  // add to front (reverses order)
        if (node.left != null) stack.push(node.left);
        if (node.right != null) stack.push(node.right);
    }
    return result;
}
```

### 2.2 Level-Order Traversal (BFS)

Visits nodes level by level using a queue.

```
        1          Level 0: [1]
       / \
      2   3        Level 1: [2, 3]
     / \   \
    4   5   6      Level 2: [4, 5, 6]

Output: [[1], [2, 3], [4, 5, 6]]
```

### Level Order Traversal — Full Java Solution

```java
import java.util.*;

public List<List<Integer>> levelOrder(TreeNode root) {
    List<List<Integer>> result = new ArrayList<>();
    if (root == null) return result;

    Queue<TreeNode> queue = new LinkedList<>();
    queue.offer(root);

    while (!queue.isEmpty()) {
        int levelSize = queue.size();
        List<Integer> level = new ArrayList<>();

        for (int i = 0; i < levelSize; i++) {
            TreeNode node = queue.poll();
            level.add(node.val);

            if (node.left != null) queue.offer(node.left);
            if (node.right != null) queue.offer(node.right);
        }
        result.add(level);
    }
    return result;
}
```

**Key technique**: The `levelSize` snapshot lets you process exactly one level per outer-loop iteration. This pattern appears in many BFS problems (right-side view, average of levels, zigzag).

### 2.3 Morris Traversal (O(1) Space)

Morris traversal achieves O(1) space (no stack, no recursion) by temporarily modifying the tree to create threads (links from rightmost nodes of left subtrees back to the root).

```
Morris Inorder on:       Thread creation (5.right -> 1):
        1                      1
       / \                    / \
      2   3                  2   3
     / \                    / \
    4   5                  4   5
                                \
                                 -> 1 (thread)

Inorder output: 4, 2, 5, 1, 3
Process: find predecessor, thread it, go left. When thread exists, remove it, process node, go right.
```

```java
public List<Integer> morrisInorder(TreeNode root) {
    List<Integer> result = new ArrayList<>();
    TreeNode curr = root;

    while (curr != null) {
        if (curr.left == null) {
            // No left child, process current and go right
            result.add(curr.val);
            curr = curr.right;
        } else {
            // Find the inorder predecessor (rightmost in left subtree)
            TreeNode predecessor = curr.left;
            while (predecessor.right != null && predecessor.right != curr) {
                predecessor = predecessor.right;
            }
            if (predecessor.right == null) {
                // Create thread and move left
                predecessor.right = curr;
                curr = curr.left;
            } else {
                // Thread exists, remove it, process current, move right
                predecessor.right = null;
                result.add(curr.val);
                curr = curr.right;
            }
        }
    }
    return result;
}
```

**When to use Morris**: Rarely required in interviews, but knowing it shows deep understanding of in-place tree manipulation. O(n) time, O(1) space.

---

## 3. Binary Search Tree (BST) Operations

A **BST** is a binary tree where for every node:
- All values in the left subtree are **less than** the node's value.
- All values in the right subtree are **greater than** the node's value.

```
        8
       / \
      3   10
     / \    \
    1   6    14
       / \   /
      4   7 13

Inorder traversal gives sorted order: 1, 3, 4, 6, 7, 8, 10, 13, 14
```

### 3.1 Search in BST

```java
public TreeNode searchBST(TreeNode root, int target) {
    while (root != null && root.val != target) {
        root = (target < root.val) ? root.left : root.right;
    }
    return root;
}
```

### 3.2 Insert into BST

```java
public TreeNode insertIntoBST(TreeNode root, int val) {
    if (root == null) return new TreeNode(val);

    if (val < root.val) {
        root.left = insertIntoBST(root.left, val);
    } else {
        root.right = insertIntoBST(root.right, val);
    }
    return root;
}
```

### 3.3 Delete from BST

Deletion has three cases: **(1) Leaf** — just remove. **(2) One child** — replace with that child. **(3) Two children** — find inorder successor (min in right subtree), copy its value, then delete the successor.

```
Delete 3 (two children): Replace with inorder successor 4, then remove original 4.

        5                5
       / \              / \
      3   6    -->     4   6
     / \   \          /     \
    2   4   7        2       7
```

```java
public TreeNode deleteNode(TreeNode root, int key) {
    if (root == null) return null;

    if (key < root.val) {
        root.left = deleteNode(root.left, key);
    } else if (key > root.val) {
        root.right = deleteNode(root.right, key);
    } else {
        // Found the node to delete
        if (root.left == null) return root.right;
        if (root.right == null) return root.left;

        // Two children: find inorder successor (min in right subtree)
        TreeNode successor = findMin(root.right);
        root.val = successor.val;
        root.right = deleteNode(root.right, successor.val);
    }
    return root;
}

private TreeNode findMin(TreeNode node) {
    while (node.left != null) {
        node = node.left;
    }
    return node;
}
```

### 3.4 Validate BST — Full Java Solution

A common mistake is only checking `left.val < node.val < right.val`. This is insufficient — you must ensure ALL nodes in the left subtree are less than the root.

```
        5          Locally: 4<5<6 OK. But 3 is in 5's right subtree and 3<5. NOT a valid BST!
       / \
      4   6
         / \
        3   7
```

**Correct approach** — pass down min/max bounds:

```java
public boolean isValidBST(TreeNode root) {
    return validate(root, Long.MIN_VALUE, Long.MAX_VALUE);
}

private boolean validate(TreeNode node, long min, long max) {
    if (node == null) return true;

    // Current node must be within the allowed range
    if (node.val <= min || node.val >= max) return false;

    // Left subtree: all values must be < node.val (update max)
    // Right subtree: all values must be > node.val (update min)
    return validate(node.left, min, node.val)
        && validate(node.right, node.val, max);
}
```

**Time**: O(n), **Space**: O(h) for the bounds approach. (An inorder-traversal-then-check-if-sorted approach also works but uses O(n) space.)

---

## 4. Balanced Trees

### 4.1 Height-Balanced Binary Tree

A binary tree is height-balanced if, for every node, the depth of its left and right subtrees differ by at most 1.

```
Balanced:          Not balanced:
      1                  1
     / \                / \
    2   3              2   3
   /                  /
  4                  4
                     /
                    5
```

```java
public boolean isBalanced(TreeNode root) {
    return checkHeight(root) != -1;
}

// Returns height if balanced, -1 if unbalanced
private int checkHeight(TreeNode node) {
    if (node == null) return 0;

    int leftHeight = checkHeight(node.left);
    if (leftHeight == -1) return -1;

    int rightHeight = checkHeight(node.right);
    if (rightHeight == -1) return -1;

    if (Math.abs(leftHeight - rightHeight) > 1) return -1;

    return Math.max(leftHeight, rightHeight) + 1;
}
```

**Optimization note**: Using -1 as a sentinel for "unbalanced" enables early short-circuit, giving O(n) time instead of O(n log n) from a naive approach that recomputes heights.

### 4.2 AVL Tree (Concept)

An **AVL tree** is a self-balancing BST where the balance factor (left height minus right height) of every node is in {-1, 0, 1}. When insertion/deletion violates this, rotations restore balance:

- **Left Rotation**: right subtree too heavy.
- **Right Rotation**: left subtree too heavy.
- **Left-Right / Right-Left**: double rotations for zig-zag cases.

```
Left Rotation:         Right Rotation:
    3                      5
     \                    /
      4    -->           4      -->
       \                /
        5              3
```

Interviews rarely require implementing a full AVL tree, but understanding rotations and self-balancing is important for system design discussions (database indexes, file systems).

---

## 5. Maximum Depth of Binary Tree — Full Java Solution

The maximum depth is the number of nodes along the longest path from the root to the farthest leaf.

```
        3
       / \
      9  20
        /  \
       15   7

Max depth = 3 (path: 3 -> 20 -> 7)
```

### Recursive (DFS) Approach

```java
public int maxDepth(TreeNode root) {
    if (root == null) return 0;
    return 1 + Math.max(maxDepth(root.left), maxDepth(root.right));
}
```

### Iterative (BFS) Approach

```java
public int maxDepthBFS(TreeNode root) {
    if (root == null) return 0;
    Queue<TreeNode> queue = new LinkedList<>();
    queue.offer(root);
    int depth = 0;

    while (!queue.isEmpty()) {
        int levelSize = queue.size();
        for (int i = 0; i < levelSize; i++) {
            TreeNode node = queue.poll();
            if (node.left != null) queue.offer(node.left);
            if (node.right != null) queue.offer(node.right);
        }
        depth++;
    }
    return depth;
}
```

**Time**: O(n), **Space**: O(h) for recursive, O(w) for BFS (where w = max width).

---

## 6. Lowest Common Ancestor (LCA)

The LCA of two nodes p and q is the lowest node in the tree that has both p and q as descendants (a node can be a descendant of itself).

```
        3
       / \
      5   1
     / \ / \
    6  2 0  8
      / \
     7   4

LCA(5,1)=3  LCA(5,4)=5  LCA(6,4)=5  LCA(7,8)=3
```

### 6.1 LCA in a Binary Tree — Full Java Solution

```java
public TreeNode lowestCommonAncestor(TreeNode root, TreeNode p, TreeNode q) {
    // Base case: if root is null or matches p or q
    if (root == null || root == p || root == q) {
        return root;
    }

    // Search in left and right subtrees
    TreeNode left = lowestCommonAncestor(root.left, p, q);
    TreeNode right = lowestCommonAncestor(root.right, p, q);

    // If both sides returned non-null, root is the LCA
    if (left != null && right != null) {
        return root;
    }

    // Otherwise, return the non-null result (propagate up)
    return (left != null) ? left : right;
}
```

**How it works**: If the current node is p or q, return it. Recurse left and right. If both return non-null, the current node is where p and q diverge — this is the LCA. If only one side returns non-null, that result contains the LCA.

**Time**: O(n), **Space**: O(h)

### 6.2 LCA in a BST

In a BST, we can leverage the ordering property for a more efficient solution.

```java
public TreeNode lowestCommonAncestorBST(TreeNode root, TreeNode p, TreeNode q) {
    while (root != null) {
        if (p.val < root.val && q.val < root.val) {
            // Both p and q are in the left subtree
            root = root.left;
        } else if (p.val > root.val && q.val > root.val) {
            // Both p and q are in the right subtree
            root = root.right;
        } else {
            // p and q diverge here, or one equals root
            return root;
        }
    }
    return null;
}
```

**Time**: O(log n) average, O(n) worst case. **Space**: O(1) iterative.

---

## 7. Serialize and Deserialize Binary Tree — Full Java Solution

Serialization converts a tree to a string; deserialization rebuilds the tree from that string. This is a classic interview problem that tests your understanding of tree structure and traversal.

```
Tree:      1            Serialization (preorder with null markers):
          / \           "1,2,#,#,3,4,#,#,5,#,#"
         2   3
            / \
           4   5
```

The key insight: encode `null` children so the structure can be uniquely reconstructed. We use preorder (root, left, right).

```java
import java.util.*;

public class Codec {

    // Encodes a tree to a single string.
    public String serialize(TreeNode root) {
        StringBuilder sb = new StringBuilder();
        serializeHelper(root, sb);
        return sb.toString();
    }

    private void serializeHelper(TreeNode node, StringBuilder sb) {
        if (node == null) {
            sb.append("#,");
            return;
        }
        sb.append(node.val).append(",");
        serializeHelper(node.left, sb);
        serializeHelper(node.right, sb);
    }

    // Decodes your encoded data to tree.
    public TreeNode deserialize(String data) {
        String[] tokens = data.split(",");
        Queue<String> queue = new LinkedList<>(Arrays.asList(tokens));
        return deserializeHelper(queue);
    }

    private TreeNode deserializeHelper(Queue<String> queue) {
        String token = queue.poll();
        if (token.equals("#")) return null;

        TreeNode node = new TreeNode(Integer.parseInt(token));
        node.left = deserializeHelper(queue);
        node.right = deserializeHelper(queue);
        return node;
    }
}
```

**Why this works**: Preorder visits the root first, so the first non-null token is always the root, followed by the left subtree, then the right subtree. The queue lets us consume tokens in order during recursive deserialization without tracking a global index.

**Time**: O(n) for both. **Space**: O(n) for the string/queue, O(h) recursion stack.

---

## 8. Path Problems

### 8.1 Binary Tree Maximum Path Sum — Full Java Solution

A **path** in a binary tree is a sequence of nodes where each pair of adjacent nodes has an edge connecting them. A node can appear at most once. The path does not need to pass through the root.

```
        -10
        / \
       9  20
         /  \
        15   7

Maximum path sum = 15 + 20 + 7 = 42
(Path: 15 -> 20 -> 7, does NOT go through root)
```

This is one of the hardest tree problems. At each node, compute two things:
1. **Path sum with this node as peak** (can include both children): `leftGain + node.val + rightGain`
2. **Single-path gain extending upward** (can only pick one child): `node.val + max(leftGain, rightGain)`

```java
public class MaxPathSum {
    private int maxSum = Integer.MIN_VALUE;

    public int maxPathSum(TreeNode root) {
        maxSum = Integer.MIN_VALUE;  // reset for reuse
        gainFromSubtree(root);
        return maxSum;
    }

    // Returns the max gain from this subtree extending upward (single path)
    private int gainFromSubtree(TreeNode node) {
        if (node == null) return 0;

        // Max gain from left and right (ignore negative gains)
        int leftGain = Math.max(gainFromSubtree(node.left), 0);
        int rightGain = Math.max(gainFromSubtree(node.right), 0);

        // Path sum with this node as the peak (can use both children)
        int pathThroughNode = node.val + leftGain + rightGain;
        maxSum = Math.max(maxSum, pathThroughNode);

        // Return single-path gain (can only use one child to extend upward)
        return node.val + Math.max(leftGain, rightGain);
    }
}
```

**Critical details**: Negative gains are clamped to 0 (we'd rather not include a negative-sum subtree). The global `maxSum` tracks the best "peak" path found anywhere. The return value is always a single-path gain (for the parent to use).

**Time**: O(n), **Space**: O(h)

### 8.2 Path Sum (Root-to-Leaf Target)

Determine if there exists a root-to-leaf path summing to the target. Subtract from target as you go down; check at leaf.

```java
public boolean hasPathSum(TreeNode root, int targetSum) {
    if (root == null) return false;
    if (root.left == null && root.right == null) {
        return targetSum == root.val;
    }
    return hasPathSum(root.left, targetSum - root.val)
        || hasPathSum(root.right, targetSum - root.val);
}
```

### 8.3 Binary Tree Paths (All Root-to-Leaf Paths)

Return all root-to-leaf paths as strings (e.g., `["1->2->5", "1->3"]`).

```java
public List<String> binaryTreePaths(TreeNode root) {
    List<String> paths = new ArrayList<>();
    if (root != null) findPaths(root, String.valueOf(root.val), paths);
    return paths;
}

private void findPaths(TreeNode node, String path, List<String> paths) {
    if (node.left == null && node.right == null) {
        paths.add(path);
        return;
    }
    if (node.left != null) findPaths(node.left, path + "->" + node.left.val, paths);
    if (node.right != null) findPaths(node.right, path + "->" + node.right.val, paths);
}
```

---

## 9. Diameter of Binary Tree — Full Java Solution

The **diameter** is the length of the longest path between any two nodes. This path may or may not pass through the root. The length is measured by the number of edges.

```
        1
       / \
      2   3
     / \
    4   5
   /
  6

Diameter = 4 (path: 6 -> 4 -> 2 -> 1 -> 3, or equivalently 3 -> 1 -> 2 -> 4 -> 6)
```

The diameter at any node is `leftHeight + rightHeight` (in edges). We compute this at every node and track the global maximum.

```java
public class DiameterOfBinaryTree {
    private int diameter = 0;

    public int diameterOfBinaryTree(TreeNode root) {
        diameter = 0;  // reset for reuse
        height(root);
        return diameter;
    }

    // Returns height in edges (null = -1, single node = 0)
    private int height(TreeNode node) {
        if (node == null) return -1;

        int leftHeight = height(node.left);
        int rightHeight = height(node.right);

        // Diameter through this node = left height + right height + 2
        // (+2 for the two edges connecting children to this node)
        diameter = Math.max(diameter, leftHeight + rightHeight + 2);

        return 1 + Math.max(leftHeight, rightHeight);
    }
}
```

**Note on height convention**: Using -1 for null makes edge-counting clean. For a single node: height = 0, diameter through it = (-1) + (-1) + 2 = 0 (correct — a single node has diameter 0). Alternatively, use height in nodes (null = 0) and diameter = leftHeight + rightHeight — both work if consistent.

**Time**: O(n), **Space**: O(h)

---

## 10. Construct Binary Tree from Preorder and Inorder Traversal — Full Java Solution

Given preorder and inorder traversal arrays, reconstruct the unique binary tree.

```
Preorder: [3, 9, 20, 15, 7]  (first = root)
Inorder:  [9, 3, 15, 20, 7]  (left of root = left subtree)

Root = 3, found at inorder[1]. Left subtree inorder: [9]. Right: [15,20,7].
Preorder for left: [9]. Preorder for right: [20,15,7]. Recurse.

Result:     3
           / \
          9  20
            /  \
           15   7
```

### Key Insight
**Preorder** gives the root first. **Inorder** gives the boundary between left and right subtrees. Use a HashMap for O(1) root-index lookup in inorder.

```java
import java.util.*;

public TreeNode buildTree(int[] preorder, int[] inorder) {
    // Map value -> index in inorder for O(1) lookup
    Map<Integer, Integer> inorderMap = new HashMap<>();
    for (int i = 0; i < inorder.length; i++) {
        inorderMap.put(inorder[i], i);
    }

    // Use an array to track the current index in preorder (mutable reference)
    int[] preorderIndex = {0};

    return buildSubtree(preorder, inorderMap, preorderIndex, 0, inorder.length - 1);
}

private TreeNode buildSubtree(int[] preorder, Map<Integer, Integer> inorderMap,
                              int[] preorderIndex, int left, int right) {
    // No elements to construct
    if (left > right) return null;

    // Pick the next element from preorder as root
    int rootVal = preorder[preorderIndex[0]];
    preorderIndex[0]++;

    TreeNode root = new TreeNode(rootVal);

    // Find where root splits inorder into left and right
    int rootIndexInInorder = inorderMap.get(rootVal);

    // Build left and right subtrees (order matters: left first!)
    root.left = buildSubtree(preorder, inorderMap, preorderIndex,
                             left, rootIndexInInorder - 1);
    root.right = buildSubtree(preorder, inorderMap, preorderIndex,
                              rootIndexInInorder + 1, right);

    return root;
}
```

**Critical detail**: The `preorderIndex` must advance and build the **left subtree before the right subtree** — after consuming the root, the next elements in preorder belong to the left subtree. The `int[]` wrapper gives a mutable reference across recursive calls (Java passes primitives by value).

**Time**: O(n), **Space**: O(n) for the map + O(h) recursion stack.

### Variants
- **Postorder + Inorder**: Root is the last element of postorder. Process right subtree before left.
- **Preorder + Postorder**: Only unique if the tree is **full** (every node has 0 or 2 children).

---

## 11. Flip Equivalent Binary Trees

Two binary trees are **flip equivalent** if you can make them identical by flipping (swapping left and right children) at any number of nodes.

```
Tree A:          Tree B:          (Flip root of A: swap 2,3; flip node 5 in B: swap 7,8)
    1              1              These are flip equivalent.
   / \            / \
  2   3          3   2
 /   / \            / \
4   5   6          4   5
   / \                / \
  7   8              8   7
```

### Recursive Solution

```java
public boolean flipEquiv(TreeNode root1, TreeNode root2) {
    if (root1 == null && root2 == null) return true;
    if (root1 == null || root2 == null) return false;
    if (root1.val != root2.val) return false;

    // Check both orientations: no flip OR flip
    boolean noFlip = flipEquiv(root1.left, root2.left)
                  && flipEquiv(root1.right, root2.right);
    boolean withFlip = flipEquiv(root1.left, root2.right)
                    && flipEquiv(root1.right, root2.left);

    return noFlip || withFlip;
}
```

**Intuition**: At each node, try both orientations — keep children as-is, or swap them. If either works recursively, the trees are flip equivalent.

**Time**: O(min(n1, n2)) — we stop as soon as a mismatch is found. **Space**: O(h).

---

## 12. Merge Two Binary Trees

Given two binary trees, merge them by summing overlapping nodes. If one tree has a node where the other doesn't, use the existing node.

```
Tree 1:     Tree 2:      Merged:
    1          2            3
   / \        / \          / \
  3   2      1   3        4   5
 /            \   \      / \   \
5              4   7    5   4   7
```

```java
public TreeNode mergeTrees(TreeNode t1, TreeNode t2) {
    if (t1 == null) return t2;
    if (t2 == null) return t1;

    // Both exist: sum values
    t1.val += t2.val;

    // Recursively merge left and right subtrees
    t1.left = mergeTrees(t1.left, t2.left);
    t1.right = mergeTrees(t1.right, t2.right);

    return t1;
}
```

**Note**: This modifies t1 in place. To avoid mutation, create a new node instead.

**Time**: O(min(n1, n2)), **Space**: O(min(h1, h2)).

---

## 13. Populating Next Right Pointers

Given a **perfect** binary tree, connect each node's `next` pointer to the node on its right at the same level. The rightmost node's `next` points to null.

```
Before:           After (next pointers ->):
     1               1 -> null
    / \             / \
   2   3           2 -> 3 -> null
  / \ / \         / \ / \
 4 5 6 7         4->5->6->7 -> null
```

### Using BFS (O(n) space) — straightforward approach

```java
public Node connect(Node root) {
    if (root == null) return root;
    Queue<Node> queue = new LinkedList<>();
    queue.offer(root);
    while (!queue.isEmpty()) {
        int size = queue.size();
        Node prev = null;
        for (int i = 0; i < size; i++) {
            Node curr = queue.poll();
            if (prev != null) prev.next = curr;
            prev = curr;
            if (curr.left != null) queue.offer(curr.left);
            if (curr.right != null) queue.offer(curr.right);
        }
    }
    return root;
}
```

### Using Previously Established Next Pointers (O(1) space)

The elegant follow-up: can you do it with O(1) extra space? Yes — use the `next` pointers already set at the current level to traverse the next level.

```java
public Node connectO1(Node root) {
    if (root == null) return root;

    Node levelStart = root;
    while (levelStart.left != null) {  // still have a next level
        Node curr = levelStart;
        while (curr != null) {
            // Connect left child to right child
            curr.left.next = curr.right;

            // Connect right child to next node's left child
            if (curr.next != null) {
                curr.right.next = curr.next.left;
            }
            curr = curr.next;  // move to next node at this level
        }
        levelStart = levelStart.left;  // move down a level
    }
    return root;
}
```

**How it works**: At each node, set `left.next = right` (they share a parent), then `right.next = nextNode.left` (using the `next` already set at the current level). Move across the level using `curr.next`, then drop down.

**Node definition:**
```java
class Node {
    int val;
    Node left;
    Node right;
    Node next;
    Node(int val) { this.val = val; }
}
```

**Time**: O(n), **Space**: O(1) for the second approach.

---

## 14. Summary of Key Patterns

### Pattern Recognition Table

| Problem Type | Pattern | Key Technique | Example Problems |
|---|---|---|---|
| **DFS Traversal** | Recursion with pre/in/post-order | Process node relative to children | Inorder, Preorder, Postorder, all path problems |
| **BFS / Level Order** | Queue-based, process by levels | Track level size before inner loop | Level Order, Right Side View, Average of Levels, ZigZag |
| **Tree + Valid Range** | Pass min/max bounds down | Validate node within (min, max), recurse with tighter bounds | Validate BST, Range Sum BST |
| **Subtree Properties** | Post-order: compute from children | Return value from children + combine at node | Max Depth, Diameter, Balanced Tree, Max Path Sum |
| **LCA** | Post-order, propagate result up | Return node if found p/q; if both sides found, current is LCA | LCA Binary Tree, LCA BST, Kth Ancestor |
| **Path Sum** | DFS with running sum | Subtract from target as you go down, check at leaf | Path Sum, Path Sum II, Path Sum III, Binary Tree Paths |
| **Serialization** | Encode with null markers | Preorder with `#` for nulls, split on deserialize | Serialize/Deserialize, Construct from traversals |
| **Construction** | Split inorder at root, recurse | Use preorder/postorder for root, inorder for boundaries | Construct from Pre+In, Post+In, Pre+Post |
| **Two-Tree Comparison** | Simultaneous recursion on both | Compare values, recurse on both children (with/without swap) | Same Tree, Symmetric Tree, Flip Equivalent, Merge Trees |
| **BST Property** | Leverage ordering | Go left if target < node, right if target > node | Search BST, Insert BST, Delete BST, LCA BST, Kth Smallest |
| **O(1) Space Traversal** | Morris traversal with threading | Temporarily link predecessor's right to root | Morris Inorder, Morris Preorder |
| **Next Pointer / Level Linking** | Use already-established nexts | Traverse level N to set up level N+1 | Populating Next Right Pointers |
| **Modified Tree In-Place** | Mutate tree during traversal | Change pointers/values as you traverse | Flatten to Linked List, Recover BST, Morris Traversal |
| **Path from Any Node** | Compute gain, track global max | At each node: path-through-node vs. single-path-up | Max Path Sum, Longest Univalue Path |
| **Subtree Counting** | Recurse + check each subtree | For each node, check if subtree matches target | Subtree of Another Tree, Count Univalue Subtrees |

### Quick Reference: Which Traversal to Use

| If you need to... | Use this traversal |
|---|---|
| Process node before children | Preorder |
| Get sorted BST values | Inorder |
| Need subtree results before parent | Postorder |
| Process level by level | Level-order (BFS) |
| O(1) space | Morris |
| Reconstruct tree from traversals | Preorder (root first) or Postorder (root last) |

### Common Complexity Summary

| Problem | Time | Space |
|---|---|---|
| All traversals | O(n) | O(h) recursive, O(w) BFS |
| Max Depth | O(n) | O(h) |
| Validate BST | O(n) | O(h) |
| LCA (binary tree) | O(n) | O(h) |
| LCA (BST) | O(log n) | O(1) iterative |
| Serialize/Deserialize | O(n) | O(n) |
| Max Path Sum | O(n) | O(h) |
| Diameter | O(n) | O(h) |
| Level Order | O(n) | O(w) |
| Construct from Pre+In | O(n) | O(n) |
| Flip Equivalent | O(n) | O(h) |
| Merge Trees | O(n) | O(h) |
| Next Right Pointers | O(n) | O(1) optimal |
| Morris Traversal | O(n) | O(1) |

Where `n` = number of nodes, `h` = height (log n balanced, n worst case), `w` = max width.

---

## 15. Interview Tips for Tree Problems

1. **Always handle the null case first.** Most tree bugs come from missing null checks.
2. **Decide early: DFS or BFS?** Levels → BFS. Paths or subtree properties → DFS.
3. **Think about return value vs. global tracking.** Many problems (Max Path Sum, Diameter) need a global max updated during recursion, while the return value serves the parent's needs.
4. **Post-order is the workhorse.** If you need info from both children before processing a node, use post-order. This covers: depth, diameter, balance, path sum, LCA.
5. **For BST problems, use the ordering property.** It almost always gives a cleaner, more efficient solution.
6. **Practice iterative traversals.** Interviewers love asking for iterative inorder and postorder to test your stack skills.
7. **For construction problems, draw the arrays.** Trace through preorder/inorder, mark the root, split into subarrays. Visual tracing prevents off-by-one errors.
8. **Know your space complexity.** Recursive DFS: O(h). BFS: O(w). Morris: O(1). Be ready to discuss trade-offs.

---

## 16. Practice Problem Progression

Recommended order for systematic practice:

1. **Maximum Depth** (easy) — basic recursion
2. **Traversals: Inorder/Preorder/Postorder** (easy) — iterative + recursive
3. **Same Tree / Symmetric Tree** (easy) — two-tree comparison
4. **Level Order Traversal** (medium) — BFS foundation
5. **Validate BST** (medium) — range bounds
6. **Path Sum** (easy) — root-to-leaf DFS
7. **Diameter / Balanced Tree** (easy-medium) — post-order with global max/short-circuit
8. **LCA of Binary Tree / BST** (medium) — post-order propagation vs BST property
9. **Construct from Pre+In** (medium) — recursion with array splitting
10. **Serialize/Deserialize** (hard) — encoding + reconstruction
11. **Maximum Path Sum** (hard) — the crown jewel of path problems
12. **Populating Next Right Pointers** (medium) — O(1) space trick
13. **Flip Equivalent / Merge Trees** (medium/easy) — simultaneous traversal
14. **Morris Traversal** (medium) — threading for O(1) space
15. **Path Sum III** (hard) — prefix sum on tree paths

Master these and you'll be well-prepared for any tree question in a coding interview.

## Interview Cheat Sheet

**Key Points to Remember:**
- Four traversal patterns: in-order, pre-order, post-order, level-order/BFS.
- Recursive decomposition: solve for children, combine at parent.
- BST: in-order traversal gives sorted output.
- LCA: recursive — if current node is p or q, return it; recurse left and right; if both return non-null, current is LCA.
- Path sum: DFS with running sum, check at leaf.

**Common Follow-Up Questions:**
- *Iterative vs recursive traversal?* — Use stack for DFS, queue for BFS. Iterative avoids stack overflow on deep trees.
- *How do you serialize a tree?* — Pre-order with null markers. `1,2,#,#,3,4,#,#,#` represents root=1, left=2 (leaf), right=3 with left=4 (leaf).

**Gotcha:**
- Forgetting to handle the null/empty tree case. Many tree problems have `root == null` as the base case — missing it causes NPE.
