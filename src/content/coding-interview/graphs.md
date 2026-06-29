---
title: "Graphs — Coding Interview Prep"
category: "Coding Interview Prep"
topic: "Graphs"
language: "Java"
date: 2026-06-19
tags: [graphs, bfs, dfs, topological-sort, union-find, dijkstra, mst, interview-prep]
difficulty: "Medium to Hard"
estimated_reading_time: "45 minutes"
---

# Graphs — The Complete Interview Prep Guide

Graphs are arguably the most versatile and frequently tested data structure in coding interviews. Once you master a handful of patterns — traversal, shortest path, connected components, topological ordering — a huge fraction of graph problems become variations on a theme. This guide covers every major graph algorithm you need, with full Java solutions for the canonical LeetCode problems, ASCII diagrams to internalize the mechanics, and a comparison table to help you pick the right tool under pressure.

---

## Summary & Interview Framing

Data structures for representing relationships (adjacency list/matrix) and algorithms for traversal (BFS, DFS), shortest path (Dijkstra), and ordering (topological sort).

**How it's asked:** "Number of islands, course schedule, word ladder, network delay time, clone graph — problems involving connected nodes, paths, or dependencies."

---

## 1. Graph Fundamentals & Representation

A graph G = (V, E) consists of a set of vertices V and a set of edges E connecting pairs of vertices. Edges may be directed or undirected, weighted or unweighted. In interviews you will usually be given the graph in one of three forms:

- An explicit edge list: `[[0,1],[1,2],[2,0]]`
- An adjacency list: `Map<Integer, List<Integer>>` or `List<List<Integer>>`
- A 2D grid that implicitly represents a graph (each cell connects to its 4/8 neighbors)
- A reference to a custom `Node` class (for problems like Clone Graph)

### Adjacency List vs Adjacency Matrix

```
  Example Graph (undirected, 5 vertices):

      0 --- 1
      |     |
      2 --- 3
            |
            4

  Edge list:        [[0,1],[0,2],[1,3],[2,3],[3,4]]
```

**Adjacency List** — each vertex stores a list of its neighbors.

```
  0 -> [1, 2]
  1 -> [0, 3]
  2 -> [0, 3]
  3 -> [1, 2, 4]
  4 -> [3]
```

**Adjacency Matrix** — a V×V matrix where `matrix[i][j] = 1` (or weight) if an edge exists from i to j.

```
        0  1  2  3  4
     0 [ 0  1  1  0  0 ]
     1 [ 1  0  0  1  0 ]
     2 [ 1  0  0  1  0 ]
     3 [ 0  1  1  0  1 ]
     4 [ 0  0  0  1  0 ]
```

| Property              | Adjacency List            | Adjacency Matrix       |
|----------------------|---------------------------|------------------------|
| Space                | O(V + E)                  | O(V²)                  |
| Check edge (u,v)     | O(degree(u))              | O(1)                   |
| Iterate neighbors    | O(degree(u))              | O(V)                   |
| Add edge             | O(1)                      | O(1)                   |
| Best for             | Sparse graphs (most real) | Dense graphs           |

**Interview rule of thumb:** almost always use an adjacency list. Real-world graphs are sparse, and interview problems give you sparse inputs. Only reach for a matrix when the input is already a matrix (grid problems) or when you need O(1) edge-existence lookups (e.g., Floyd-Warshall).

### Building an adjacency list from an edge list

```java
// n = number of vertices (labeled 0..n-1)
// edges = [[u, v], ...]
List<List<Integer>> buildAdjList(int n, int[][] edges) {
    List<List<Integer>> adj = new ArrayList<>();
    for (int i = 0; i < n; i++) adj.add(new ArrayList<>());
    for (int[] e : edges) {
        int u = e[0], v = e[1];
        adj.get(u).add(v);
        adj.get(v).add(u); // omit this line for a directed graph
    }
    return adj;
}
```

For weighted graphs, store `int[] {neighbor, weight}` or use a small helper class:

```java
List<int[]>[] adj;   // adj[u] = list of {v, weight}
```

---

## 2. Breadth-First Search (BFS)

BFS explores the graph layer by layer, visiting all nodes at distance k before any node at distance k+1. It uses a queue (FIFO) and is the foundation for **shortest path in unweighted graphs**, **level-order traversal**, and **flood-fill / connected components** on grids.

### BFS traversal order (ASCII diagram)

```
  Graph:
        1
       / \
      2   3
     / \   \
    4   5   6
         \
          7

  BFS from node 1 (queue-based, level by level):

  Level 0:  [1]                         visited: {1}
  Level 1:  [2, 3]                      visited: {1,2,3}
  Level 2:  [4, 5, 6]                   visited: {1,2,3,4,5,6}
  Level 3:  [7]                         visited: {1,2,3,4,5,6,7}

  Visit order:  1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7
```

### Canonical BFS template

```java
void bfs(Map<Integer, List<Integer>> adj, int start) {
    Queue<Integer> queue = new LinkedList<>();
    Set<Integer> visited = new HashSet<>();
    queue.offer(start);
    visited.add(start);

    while (!queue.isEmpty()) {
        int node = queue.poll();
        // process node
        for (int neighbor : adj.getOrDefault(node, List.of())) {
            if (!visited.contains(neighbor)) {
                visited.add(neighbor);
                queue.offer(neighbor);
            }
        }
    }
}
```

**Critical detail:** mark a node `visited` when you *enqueue* it, not when you *dequeue* it. Otherwise the same node can be added to the queue multiple times, turning O(V+E) into something much worse.

### Level-by-level BFS

When you need to know which level/distance each node is at (e.g., shortest path, word ladder), process the queue in level-sized batches:

```java
int distance = 0;
while (!queue.isEmpty()) {
    int size = queue.size();          // snapshot the current level
    for (int i = 0; i < size; i++) {
        int node = queue.poll();
        for (int neighbor : adj.get(node)) {
            if (!visited.contains(neighbor)) {
                visited.add(neighbor);
                queue.offer(neighbor);
            }
        }
    }
    distance++;                        // increment after each level
}
```

### Shortest path in an unweighted graph

BFS naturally finds the shortest path (fewest edges) in an unweighted graph because it reaches nodes in order of increasing distance. To reconstruct the actual path, store a `parent` map during BFS and walk backwards from the destination to the source, then reverse. This technique applies to any shortest-path algorithm (BFS, Dijkstra).

### BFS on a grid (4-directional)

For grid problems (Number of Islands, Rotting Oranges, Walls and Gates) the "neighbors" are the up/down/left/right cells:

```java
int[][] dirs = {{-1,0},{1,0},{0,-1},{0,1}};
for (int[] d : dirs) {
    int nr = r + d[0], nc = c + d[1];
    if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !visited[nr][nc]) {
        visited[nr][nc] = true;
        queue.offer(new int[]{nr, nc});
    }
}
```

---

## 3. Depth-First Search (DFS)

DFS goes as deep as possible along each branch before backtracking. It uses a stack (explicit or the call stack via recursion). DFS is the tool for **connected components**, **cycle detection**, **topological sort (post-order)**, **flood fill**, and any "explore fully before returning" problem.

### DFS traversal order (ASCII diagram)

```
  Same graph:
        1
       / \
      2   3
     / \   \
    4   5   6
         \
          7

  Recursive DFS from node 1 (explore 2's subtree fully, then 3's):

  Call stack evolution (→ = recurse, ← = return):

  dfs(1)
    → dfs(2)
        → dfs(4) ← returns
        → dfs(5)
            → dfs(7) ← returns
          ← returns
      ← returns
    → dfs(3)
        → dfs(6) ← returns
      ← returns
  ← returns

  Visit order:  1 -> 2 -> 4 -> 5 -> 7 -> 3 -> 6
  Post-order:   4, 7, 5, 2, 6, 3, 1
```

Note the difference: BFS visits breadth-first (1,2,3,4,5,6,7) while DFS dives deep (1,2,4,5,7,3,6). The post-order sequence (children before parent) is what makes DFS the basis for topological sort.

### Recursive DFS template

```java
void dfs(Map<Integer, List<Integer>> adj, int node, Set<Integer> visited) {
    visited.add(node);
    // process node (pre-order)
    for (int neighbor : adj.getOrDefault(node, List.of())) {
        if (!visited.contains(neighbor)) {
            dfs(adj, neighbor, visited);
        }
    }
    // process node (post-order) — useful for topological sort
}
```

### Iterative DFS template

When the graph is deep (or the interviewer asks you to avoid recursion), use an explicit stack:

```java
void dfsIterative(Map<Integer, List<Integer>> adj, int start) {
    Deque<Integer> stack = new ArrayDeque<>();
    Set<Integer> visited = new HashSet<>();
    stack.push(start);

    while (!stack.isEmpty()) {
        int node = stack.pop();
        if (visited.contains(node)) continue;   // guard against duplicates
        visited.add(node);
        // process node
        for (int neighbor : adj.getOrDefault(node, List.of())) {
            if (!visited.contains(neighbor)) {
                stack.push(neighbor);
            }
        }
    }
}
```

**Subtlety:** with an explicit stack a node may be pushed multiple times before it's popped, so you must re-check `visited` on pop. Alternatively, mark visited on push (like BFS) to avoid this, but then the processing order differs slightly from true recursive DFS.

### DFS on a grid (flood fill / connected components)

```java
void dfsGrid(char[][] grid, int r, int c) {
    int rows = grid.length, cols = grid[0].length;
    if (r < 0 || r >= rows || c < 0 || c >= cols || grid[r][c] != '1') return;
    grid[r][c] = '0';   // mark visited in-place (saves the visited array)
    dfsGrid(grid, r + 1, c);
    dfsGrid(grid, r - 1, c);
    dfsGrid(grid, r, c + 1);
    dfsGrid(grid, r, c - 1);
}
```

For large grids, prefer an iterative BFS/DFS or the recursive version with a raised stack size, to avoid `StackOverflowError`.

---

## 4. Topological Sort

Topological sorting applies to **Directed Acyclic Graphs (DAGs)**. It produces a linear ordering of vertices such that for every directed edge u→v, u comes before v. It is the algorithm behind task scheduling, build-system dependency resolution, and course-prerequisite problems.

A graph has a topological ordering **if and only if it is a DAG** — i.e., it has no directed cycle. Both algorithms below double as cycle detectors: if you can't produce a full ordering, a cycle exists.

### Topological sort — Kahn's algorithm (BFS, in-degree)

Kahn's algorithm repeatedly removes nodes with in-degree 0 (no remaining prerequisites).

```
  DAG:  5 → 0, 5 → 2
        4 → 0, 4 → 1
        2 → 3
        3 → 1

       5        4
       |\      /|
       | \    / |
       v  v  v  v
       0   2    1
            |
            v
            3

  In-degrees:  0:2, 1:2, 2:1, 3:1, 4:0, 5:0

  Step  Queue        Output so far      In-degrees after removal
   1   [4, 5]        []                 0:0, 1:2, 2:0, 3:1
   2   [5]           [4]                0:1, 1:1, 2:0, 3:1
   3   [0, 2]        [4, 5]             0:0, 1:1, 2:0, 3:0   (after removing 5)
   4   [2]           [4, 5, 0]          1:0, 3:0
   5   [3]           [4, 5, 0, 2]       1:0, 3:0
   6   [1]           [4, 5, 0, 2, 3]    1:0
   7   []            [4, 5, 0, 2, 3, 1] done

  One valid topo order: 4, 5, 0, 2, 3, 1
```

```java
// Kahn's: queue in-degree-0 nodes, decrement neighbors, output order
int[] topoKahn(int n, List<List<Integer>> adj) {
    int[] inDeg = new int[n];
    for (var list : adj) for (int v : list) inDeg[v]++;
    Queue<Integer> q = new LinkedList<>();
    for (int i = 0; i < n; i++) if (inDeg[i] == 0) q.offer(i);
    int[] order = new int[n]; int idx = 0;
    while (!q.isEmpty()) {
        int u = q.poll(); order[idx++] = u;
        for (int v : adj.get(u)) if (--inDeg[v] == 0) q.offer(v);
    }
    return idx == n ? order : new int[0]; // empty array = cycle
}
```

If `idx < n`, a cycle exists — no valid ordering.

### Topological sort — DFS post-order

The DFS approach appends each node to the result *after* all its descendants have been processed (post-order), then reverses the result. A node is added only once all nodes it depends on have been added.

```
  DFS post-order on the same DAG:

  dfs(4) → dfs(0) → post: [0]
           dfs(1) → post: [0,1]
         post: [0,1,4]

  dfs(5) → dfs(0) [already visited]
           dfs(2) → dfs(3) → dfs(1) [visited]
                              post: [0,1,4,3]
                      post: [0,1,4,3,2]
         post: [0,1,4,3,2,5]

  Reverse post-order = topological order: 5, 2, 3, 4, 1, 0
  (Note: multiple valid orderings exist — any one is acceptable.)
```

```java
// DFS post-order: push after all descendants processed, then reverse
int[] topoDFS(int n, List<List<Integer>> adj) {
    int[] state = new int[n]; // 0=unvisited,1=on-stack,2=done
    Deque<Integer> stack = new ArrayDeque<>();
    boolean[] cycle = {false};
    for (int i = 0; i < n; i++)
        if (state[i] == 0) dfsTopo(i, adj, state, stack, cycle);
    if (cycle[0]) return new int[0];
    int[] order = new int[n];
    for (int i = 0; i < n; i++) order[i] = stack.pop();
    return order; // already in reversed post-order = topo order
}
void dfsTopo(int u, List<List<Integer>> adj, int[] state,
             Deque<Integer> stack, boolean[] cycle) {
    state[u] = 1; // on stack
    for (int v : adj.get(u)) {
        if (state[v] == 1) { cycle[0] = true; return; } // back edge
        if (state[v] == 0) dfsTopo(v, adj, state, stack, cycle);
    }
    state[u] = 2; // done
    stack.push(u); // post-order push
}
```

**Kahn vs DFS for topological sort:**

- Kahn's is often more intuitive for scheduling and naturally detects cycles (leftover nodes with in-degree > 0).
- DFS post-order is more compact and reuses the same visited/onStack machinery used for cycle detection and general DFS problems.
- Both run in O(V + E) time and O(V) extra space.

---

## 5. Cycle Detection

### Directed graph cycle detection

A directed graph has a cycle iff a DFS encounters a **back edge** — an edge to a node currently on the recursion stack. Use the three-color or two-array method:

```java
boolean hasCycleDir(int n, List<List<Integer>> adj) {
    int[] state = new int[n]; // 0=unvisited,1=visiting(on stack),2=done
    for (int i = 0; i < n; i++)
        if (state[i] == 0 && dfsCycleDir(i, adj, state)) return true;
    return false;
}
boolean dfsCycleDir(int u, List<List<Integer>> adj, int[] state) {
    state[u] = 1; // on stack
    for (int v : adj.get(u)) {
        if (state[v] == 1) return true;    // back edge → cycle
        if (state[v] == 0 && dfsCycleDir(v, adj, state)) return true;
    }
    state[u] = 2; // done
    return false;
}
```

This is exactly what powers **Course Schedule I** (below). Kahn's algorithm also detects cycles: if fewer than n nodes are output, a cycle exists.

### Undirected graph cycle detection

For undirected graphs, a cycle exists if during DFS you reach an already-visited node that is **not the parent** you just came from. You must pass the parent along to avoid false positives from the trivial back-and-forth edge.

```java
boolean hasCycleUndir(int n, List<List<Integer>> adj) {
    boolean[] vis = new boolean[n];
    for (int i = 0; i < n; i++)
        if (!vis[i] && dfsCycleUndir(i, -1, adj, vis)) return true;
    return false;
}
boolean dfsCycleUndir(int u, int parent, List<List<Integer>> adj, boolean[] vis) {
    vis[u] = true;
    for (int v : adj.get(u)) {
        if (!vis[v]) { if (dfsCycleUndir(v, u, adj, vis)) return true; }
        else if (v != parent) return true; // visited & not parent → cycle
    }
    return false;
}
```

Union-Find is an alternative for undirected cycle detection: for each edge, if `find(u) == find(v)`, the edge connects two already-connected components → cycle. This is the basis of Kruskal's MST algorithm (below).

---

## 6. Union-Find / Disjoint Set Union (DSU)

Union-Find maintains a collection of disjoint sets and supports two operations:

- **find(x):** return the representative (root) of the set containing x.
- **union(x, y):** merge the sets containing x and y.

With two optimizations — **path compression** and **union by rank** — both operations run in nearly O(1) amortized (formally O(α(n)), where α is the inverse Ackermann function, < 5 for all practical n).

### Path compression (ASCII diagram)

Path compression flattens the tree during `find`, making every node on the path point directly to the root.

```
  Before find(7):                After find(7) with path compression:

      0                             0
      |                           / | \  \
      1                          1  3  5  7   ← all now point to root
      |                         /
      2                        2
      |
      3
      |
      5
      |
      7

  find(7) walks 7→5→3→1→0, then re-points 7,5,3,1 directly to 0.
  Future find(7) is O(1).
```

### Union by rank

Union by rank attaches the shorter tree under the root of the taller tree, keeping depth logarithmic (and constant with path compression).

```
  union(4, 7):

  Set A (rank 2):     Set B (rank 1):       Result (attach shorter under taller):
      0                   4                       0
     / \                  |                     / | \
    1   3                 7                    1  3  4
                                                  |
                                                  7
  rank[0] = 2 >= rank[4] = 1, so parent[4] = 0, rank stays 2.
```

### Complete Union-Find implementation

```java
class UnionFind {
    int[] parent, rank; int count; // count = number of components
    UnionFind(int n) { parent = new int[n]; rank = new int[n]; count = n;
        for (int i = 0; i < n; i++) parent[i] = i; }
    int find(int x) { if (parent[x] != x) parent[x] = find(parent[x]); return parent[x]; }
    boolean union(int x, int y) {
        int rx = find(x), ry = find(y);
        if (rx == ry) return false;        // already same set
        if (rank[rx] < rank[ry]) parent[rx] = ry;
        else if (rank[rx] > rank[ry]) parent[ry] = rx;
        else { parent[ry] = rx; rank[rx]++; }
        count--; return true;
    }
    boolean connected(int x, int y) { return find(x) == find(y); }
}
```

**Key interview patterns that use Union-Find:**

- **Accounts Merge** — group accounts that share emails
- **Number of Connected Components** — union edges, count components
- **Redundant Connection** — the first edge whose endpoints are already connected
- **Kruskal's MST** — sort edges by weight, union if in different sets
- **Number of Islands II** (dynamic) — union new land cells with existing neighbors

---

## 7. Shortest Path Algorithms

### Dijkstra's Algorithm (non-negative weights)

Dijkstra finds the shortest path from a single source to all other vertices in a graph with **non-negative edge weights**. It uses a min-heap (priority queue) keyed by distance, greedily extracting the closest unvisited node.

```
  Weighted graph (source = 0):

      0 --(4)-- 1 --(1)-- 3
      |          \
     (1)         (2)
      |            \
      2 --(5)------- 4

  Dijkstra execution (extracting min each step):

  Step  Min-heap (dist,node)      Dist array [0,1,2,3,4]
   1   [(0,0)]                    [0,∞,∞,∞,∞]
        pop 0, relax: 1→4, 2→1
   2   [(1,2),(4,1)]              [0,∞,1,∞,∞]
        pop 2, relax: 4→1+5=6
   3   [(4,1),(6,4)]              [0,4,1,∞,6]
        pop 1, relax: 3→4+1=5, 4→min(6,4+2)=6
   4   [(5,3),(6,4)]              [0,4,1,5,6]
        pop 3, no new relax
   5   [(6,4)]                    [0,4,1,5,6]
        pop 4, done

  Final distances from 0: {0:0, 1:4, 2:1, 3:5, 4:6}
  Shortest path to 4: 0→2→4 (cost 6)
```

```java
// adj[u] = list of {v, weight}. Lazy deletion via stale-entry skip.
int[] dijkstra(int n, List<int[]>[] adj, int src) {
    int[] dist = new int[n]; Arrays.fill(dist, Integer.MAX_VALUE); dist[src] = 0;
    PriorityQueue<int[]> pq = new PriorityQueue<>((a,b) -> a[0]-b[0]);
    pq.offer(new int[]{0, src});
    while (!pq.isEmpty()) {
        int[] cur = pq.poll(); int d = cur[0], u = cur[1];
        if (d > dist[u]) continue;          // stale entry, skip
        if (adj[u] == null) continue;
        for (int[] e : adj[u]) { int v = e[0], w = e[1];
            if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; pq.offer(new int[]{dist[v], v}); }
        }
    }
    return dist;
}
```

**The `if (d > dist[u]) continue` line** implements lazy deletion — without it the algorithm still works but processes outdated heap entries. **Complexity:** O((V + E) log V). Dijkstra fails on negative edges because it assumes a popped node's distance is final.

### Bellman-Ford Algorithm (handles negative weights)

Bellman-Ford relaxes every edge V-1 times. It handles negative weights and can also **detect negative cycles** (if a V-th relaxation still improves a distance, a negative cycle exists).

```java
// Relax all edges n-1 times; check once more for negative cycle
int[] bellmanFord(int n, int[][] edges, int src) {
    int[] dist = new int[n]; Arrays.fill(dist, Integer.MAX_VALUE); dist[src] = 0;
    for (int i = 0; i < n - 1; i++)
        for (int[] e : edges) {
            int u = e[0], v = e[1], w = e[2];
            if (dist[u] != Integer.MAX_VALUE && dist[u] + w < dist[v])
                dist[v] = dist[u] + w;
        }
    for (int[] e : edges) { // V-th pass: if still improving → negative cycle
        int u = e[0], v = e[1], w = e[2];
        if (dist[u] != Integer.MAX_VALUE && dist[u] + w < dist[v]) return null;
    }
    return dist;
}
```

**Complexity:** O(V · E). Slower than Dijkstra but more general. Use it when the problem mentions negative weights or negative-cycle detection.

| Algorithm       | Handles negative weights | Detects negative cycles | Time          |
|----------------|--------------------------|-------------------------|---------------|
| Dijkstra        | No                       | No                      | O((V+E) log V)|
| Bellman-Ford    | Yes                      | Yes                     | O(V·E)        |
| Floyd-Warshall  | Yes                      | Yes (diagonal)          | O(V³)         |

(Floyd-Warshall computes all-pairs shortest paths; it's rarely asked but good to know it exists for dense all-pairs problems.)

---

## 8. Minimum Spanning Tree (MST)

An MST of a connected, undirected, weighted graph is a subset of edges that connects all vertices with minimum total weight and no cycles. It has exactly V-1 edges. Two classic algorithms:

### Kruskal's Algorithm

Sort all edges by weight. Greedily add each edge if its endpoints are in different Union-Find sets (i.e., it doesn't create a cycle). This is Union-Find's canonical application.

```
  Weighted graph:         Edges sorted by weight:
      A --7-- B            (D,E)=2, (E,F)=2, (A,D)=3,
      |\3    /|            (B,E)=4, (B,C)=5, (A,B)=7,
      |  \  / |            (C,F)=6, (A,C)=8
      5   E-2-F
      |  /  \ |
      |/4    \|
      D--2----C?  (D-E=2, E-F=2, A-D=3, B-E=4, ...)

  Kruskal picks: (D,E)=2 ✓, (E,F)=2 ✓, (A,D)=3 ✓,
                 (B,E)=4 ✓  [now 4 edges for 5 nodes = done]
  MST total weight = 2+2+3+4 = 11
```

```java
// Sort edges by weight, greedily union if different sets
int kruskalMST(int n, int[][] edges) {
    Arrays.sort(edges, (a, b) -> a[2] - b[2]);
    UnionFind uf = new UnionFind(n);
    int totalWeight = 0, edgesUsed = 0;
    for (int[] e : edges) {
        if (uf.union(e[0], e[1])) {           // different sets → add edge
            totalWeight += e[2];
            if (++edgesUsed == n - 1) break;   // MST complete
        }
    }
    return totalWeight;
}
```

**Complexity:** O(E log E) dominated by the sort.

### Prim's Algorithm

Prim's grows the MST from a single starting node, always adding the cheapest edge that connects a visited node to an unvisited one. It uses a min-heap like Dijkstra.

```java
// Grow MST from node 0, always add cheapest edge to unvisited node
int primMST(int n, List<int[]>[] adj) {
    PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[0] - b[0]);
    boolean[] visited = new boolean[n];
    pq.offer(new int[]{0, 0});   // {weight, node}
    int totalWeight = 0, edgesUsed = 0;
    while (!pq.isEmpty() && edgesUsed < n) {
        int[] cur = pq.poll();
        int w = cur[0], u = cur[1];
        if (visited[u]) continue;
        visited[u] = true;
        totalWeight += w;
        if (u != 0) edgesUsed++;
        for (int[] edge : adj[u]) {
            if (!visited[edge[0]]) pq.offer(new int[]{edge[1], edge[0]});
        }
    }
    return totalWeight;
}
```

**Complexity:** O(E log V) with a binary heap.

**Kruskal vs Prim:**

- Kruskal is edge-centric and shines on **sparse** graphs; it also works well when edges are already sorted.
- Prim is vertex-centric and shines on **dense** graphs; it's a natural extension of Dijkstra.
- Both produce the same total MST weight (MSTs are not unique, but the minimum total weight is).

---

## 9. Problem: Number of Islands

**LeetCode 200** | Difficulty: Medium

Given an `m × n` 2D binary grid where '1' is land and '0' is water, count the number of islands. An island is a group of '1's connected 4-directionally (horizontal/vertical), surrounded by water.

### Approach

This is the canonical **connected components** problem on an implicit grid graph. Each land cell is a node; it connects to its up/down/left/right land neighbors. Count the number of connected components by running DFS/BFS from every unvisited land cell.

```
  Grid:                Island count = 3

  1  1  0  0  0        Component 1: (0,0),(0,1),(1,0),(1,1),(2,0),(2,1)
  1  1  0  0  0        Component 2: (0,4),(1,4),(2,4)
  1  1  0  0  0        Component 3: (3,2),(4,2),(4,3),(4,4)
  0  0  0  1  1
  0  0  1  1  0

  Each DFS/BFS flood-fills one island, sinking it to '0'.
```

### Java Solution (DFS, in-place marking)

```java
class Solution {
    public int numIslands(char[][] grid) {
        if (grid == null || grid.length == 0) return 0;
        int rows = grid.length, cols = grid[0].length;
        int count = 0;

        for (int r = 0; r < rows; r++) {
            for (int c = 0; c < cols; c++) {
                if (grid[r][c] == '1') {
                    count++;            // found a new island
                    dfs(grid, r, c);     // flood-fill to sink it
                }
            }
        }
        return count;
    }

    private void dfs(char[][] grid, int r, int c) {
        int rows = grid.length, cols = grid[0].length;
        // Bounds + land check
        if (r < 0 || r >= rows || c < 0 || c >= cols || grid[r][c] != '1') {
            return;
        }
        grid[r][c] = '0';   // mark as visited by sinking the land
        // Explore 4 directions
        dfs(grid, r + 1, c);
        dfs(grid, r - 1, c);
        dfs(grid, r, c + 1);
        dfs(grid, r, c - 1);
    }
}
```

**Complexity:** O(m × n) time — each cell is visited once. O(m × n) space in the worst case for the recursion stack (a spiral-shaped island can have m×n depth). For very large grids, use BFS or an iterative DFS to avoid stack overflow.

**BFS variant:** Replace the recursive `dfs` with a `Queue<int[]>` and process 4-directional neighbors iteratively. This avoids stack overflow on very large grids. The logic is identical: when you find '1', increment count and flood-fill using BFS instead of DFS.

---

## 10. Problem: Course Schedule I & II

**LeetCode 207 (I) & 210 (II)** | Difficulty: Medium

**Course Schedule I:** You have `numCourses` courses labeled 0 to n-1 and a list of prerequisite pairs `[a, b]` meaning you must take b before a. Return true if you can finish all courses (i.e., the dependency graph has no cycle).

**Course Schedule II:** Return a valid ordering of courses to take. If impossible, return an empty array.

### Approach

This is a **directed graph cycle detection + topological sort** problem. Each course is a node; each prerequisite `[a, b]` is a directed edge b→a. Course Schedule I asks "is the graph a DAG?" and Course Schedule II asks "give me a topological ordering."

```
  Example: numCourses = 4, prerequisites = [[1,0],[2,0],[3,1],[3,2]]

  Graph (edge = "must take first → can take later"):
      0 → 1
      |   |
      → 2 → 3

  In-degrees: 0:0, 1:1, 2:1, 3:2
  Kahn's: start with 0 (in-degree 0), then 1 or 2, then 3.
  Valid order: [0, 1, 2, 3] or [0, 2, 1, 3]
```

### Course Schedule I — Solution (Kahn's / BFS in-degree)

```java
class Solution {
    public boolean canFinish(int numCourses, int[][] prerequisites) {
        // Build adjacency list and in-degree array
        List<List<Integer>> adj = new ArrayList<>();
        int[] inDegree = new int[numCourses];
        for (int i = 0; i < numCourses; i++) adj.add(new ArrayList<>());

        for (int[] pre : prerequisites) {
            int course = pre[0], prereq = pre[1];
            adj.get(prereq).add(course);   // prereq → course
            inDegree[course]++;
        }

        // Start with all courses that have no prerequisites
        Queue<Integer> q = new LinkedList<>();
        for (int i = 0; i < numCourses; i++) {
            if (inDegree[i] == 0) q.offer(i);
        }

        int completed = 0;
        while (!q.isEmpty()) {
            int course = q.poll();
            completed++;
            for (int next : adj.get(course)) {
                if (--inDegree[next] == 0) {
                    q.offer(next);
                }
            }
        }
        // If we completed all courses, no cycle → true
        return completed == numCourses;
    }
}
```

**DFS alternative:** You can also detect cycles using a 3-color DFS (0=unvisited, 1=visiting/on-stack, 2=done). A "back edge" to a node currently on the stack (state 1) indicates a cycle. Kahn's algorithm is generally more intuitive for this problem.

### Course Schedule II — Solution (Kahn's with ordering)

```java
class Solution {
    public int[] findOrder(int numCourses, int[][] prerequisites) {
        List<List<Integer>> adj = new ArrayList<>();
        int[] inDegree = new int[numCourses];
        for (int i = 0; i < numCourses; i++) adj.add(new ArrayList<>());

        for (int[] pre : prerequisites) {
            adj.get(pre[1]).add(pre[0]);
            inDegree[pre[0]]++;
        }

        Queue<Integer> q = new LinkedList<>();
        for (int i = 0; i < numCourses; i++) {
            if (inDegree[i] == 0) q.offer(i);
        }

        int[] order = new int[numCourses];
        int idx = 0;
        while (!q.isEmpty()) {
            int course = q.poll();
            order[idx++] = course;
            for (int next : adj.get(course)) {
                if (--inDegree[next] == 0) {
                    q.offer(next);
                }
            }
        }
        // If we couldn't order all courses, a cycle exists
        return idx == numCourses ? order : new int[0];
    }
}
```

**Complexity:** O(V + E) for both I and II. Space O(V + E) for the adjacency list.

---

## 11. Problem: Clone Graph

**LeetCode 133** | Difficulty: Medium

Given a reference to a node in a connected undirected graph, return a deep copy (clone) of the entire graph. Each node has a `val` and a `List<Node> neighbors`.

### Approach

The key challenge is avoiding infinite loops (the graph has cycles) and ensuring the same clone is reused for shared neighbors. Use a HashMap from original node → cloned node as both the visited set and the clone registry. DFS or BFS both work.

```
  Original graph:          Cloned graph (new nodes, same structure):

      1 --- 2                  1' --- 2'
      |     |        →         |      |
      4 --- 3                  4' --- 3'

  map: {1→1', 2→2', 3→3', 4→4'}
  Each clone's neighbors list is built from the clones of the original's neighbors.
```

### Node class (given)

```java
class Node {
    public int val;
    public List<Node> neighbors;
    public Node() {
        val = 0;
        neighbors = new ArrayList<Node>();
    }
    public Node(int _val) {
        val = _val;
        neighbors = new ArrayList<Node>();
    }
    public Node(int _val, ArrayList<Node> _neighbors) {
        val = _val;
        neighbors = _neighbors;
    }
}
```

### Java Solution (DFS)

```java
class Solution {
    public Node cloneGraph(Node node) {
        if (node == null) return null;
        Map<Node, Node> map = new HashMap<>();  // original → clone
        return dfs(node, map);
    }

    private Node dfs(Node node, Map<Node, Node> map) {
        if (map.containsKey(node)) {
            return map.get(node);   // already cloned, return existing clone
        }
        // Create the clone and register it BEFORE recursing (cycle safety)
        Node clone = new Node(node.val);
        map.put(node, clone);

        for (Node neighbor : node.neighbors) {
            clone.neighbors.add(dfs(neighbor, map));
        }
        return clone;
    }
}
```

**BFS alternative:** The same clone logic works with a `Queue<Node>` — enqueue the original, create its clone on first visit, and build `clone.neighbors` by looking up each neighbor's clone in the map. Both approaches are O(V + E).

**Critical detail in the DFS version:** you must put the clone in the map *before* recursing into neighbors. If you do it after, a cycle will cause infinite recursion because the node won't be found in the map when the cycle loops back.

**Complexity:** O(V + E) time and O(V) space for both DFS and BFS.

---

## 12. Problem: Word Ladder

**LeetCode 127** | Difficulty: Hard

Given two words `beginWord` and `endWord` and a dictionary `wordList`, find the length of the shortest transformation sequence from beginWord to endWord, where:

- Each transformed word must exist in the wordList
- Only one letter can change at a time
- Each word in the sequence has length L (all words same length)

### Approach

This is a **shortest path in an unweighted graph** → BFS. The graph is implicit: nodes are words, and edges connect words that differ by exactly one letter. The challenge is efficiently finding neighbors. Two strategies:

1. **For each word, compare against all others** — O(N² · L) to build edges. Too slow for large N.
2. **Generic wildcard patterns** — for each word, generate patterns like `h*t`, `*ot`, `ho*`. Words sharing a pattern are neighbors. O(N · L²) preprocessing. This is the preferred approach.

```
  wordList = ["hot","dot","dog","lot","log","cog"]
  beginWord = "hit", endWord = "cog"

  Pattern adjacency:
    *ot → [hot, dot, lot]
    h*t → [hot, hit]
    ho* → [hot]
    d*t → [dot]
    do* → [dot, dog]
    l*t → [lot]
    lo* → [lot, log]
    *og → [dog, log, cog]
    d*g → [dog]
    l*g → [log]
    c*g → [cog]
    co* → [cog]

  BFS from "hit":
    Level 1: hit
    Level 2: hot         (hit→hot, differs by 1)
    Level 3: dot, lot    (hot→dot, hot→lot)
    Level 4: dog, log    (dot→dog, lot→log)
    Level 5: cog         (dog→cog, log→cog)  ← found!

  Shortest transformation length = 5
  Sequence: hit → hot → dot → dog → cog
```

### Java Solution (BFS with wildcard patterns)

```java
class Solution {
    public int ladderLength(String beginWord, String endWord, List<String> wordList) {
        // Build wildcard pattern → list of words map
        Map<String, List<String>> patternMap = new HashMap<>();
        int L = beginWord.length();

        for (String word : wordList) {
            for (int i = 0; i < L; i++) {
                String pattern = word.substring(0, i) + "*" + word.substring(i + 1);
                patternMap.computeIfAbsent(pattern, k -> new ArrayList<>()).add(word);
            }
        }

        // BFS
        Queue<String> queue = new LinkedList<>();
        Set<String> visited = new HashSet<>();
        queue.offer(beginWord);
        visited.add(beginWord);
        int level = 1;

        while (!queue.isEmpty()) {
            int size = queue.size();
            level++;
            for (int k = 0; k < size; k++) {
                String word = queue.poll();
                // Generate all wildcard patterns for this word
                for (int i = 0; i < L; i++) {
                    String pattern = word.substring(0, i) + "*" + word.substring(i + 1);
                    List<String> neighbors = patternMap.get(pattern);
                    if (neighbors == null) continue;
                    for (String neighbor : neighbors) {
                        if (neighbor.equals(endWord)) {
                            return level;   // found endWord at this level
                        }
                        if (!visited.contains(neighbor)) {
                            visited.add(neighbor);
                            queue.offer(neighbor);
                        }
                    }
                }
            }
        }
        return 0;   // no transformation sequence found
    }
}
```

**Bidirectional BFS optimization:** For a significant speedup, run BFS from both `beginWord` and `endWord` simultaneously, always expanding the smaller frontier. This cuts the search space from O(b^d) to O(b^(d/2)). Start with two sets, and on each iteration expand the smaller one, generating all one-letter variants of each word. When a word appears in both sets, you've found the meeting point.

**Complexity:** Standard BFS is O(N · L²) for pattern building + O(N · L) for BFS traversal. Bidirectional BFS is faster in practice. N = dictionary size, L = word length.

---

## 13. Problem: Network Delay Time

**LeetCode 743** | Difficulty: Medium

You are given a list of directed, weighted edges `times[i] = (u, v, w)` where w is the signal travel time from node u to node v. Send a signal from node k. Return the time for all n nodes to receive the signal. If any node is unreachable, return -1.

### Approach

This is a **single-source shortest path** problem with non-negative weights → **Dijkstra's algorithm**. The answer is the maximum of the shortest distances from k to all other nodes (the signal must reach the farthest node).

```
  times = [[2,1,1],[2,3,1],[3,4,1]], n = 4, k = 2

  Graph:
      2 --(1)--> 1
      |
     (1)
      v
      3 --(1)--> 4

  Dijkstra from node 2:
    dist[2] = 0
    pop 2 → relax 1 (dist 1), 3 (dist 1)
    pop 1 → no outgoing edges
    pop 3 → relax 4 (dist 1+1=2)
    pop 4 → done

  Distances: {1:1, 2:0, 3:1, 4:2}
  Max = 2 → answer = 2
```

### Java Solution (Dijkstra with PriorityQueue)

```java
class Solution {
    public int networkDelayTime(int[][] times, int n, int k) {
        // Build adjacency list: adj[u] = list of {v, weight}
        Map<Integer, List<int[]>> adj = new HashMap<>();
        for (int[] t : times) {
            adj.computeIfAbsent(t[0], x -> new ArrayList<>())
               .add(new int[]{t[1], t[2]});
        }

        // Distance array (1-indexed)
        int[] dist = new int[n + 1];
        Arrays.fill(dist, Integer.MAX_VALUE);
        dist[k] = 0;

        // Min-heap: {distance, node}
        PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[0] - b[0]);
        pq.offer(new int[]{0, k});

        while (!pq.isEmpty()) {
            int[] cur = pq.poll();
            int d = cur[0], u = cur[1];

            if (d > dist[u]) continue;   // stale entry, skip

            if (!adj.containsKey(u)) continue;

            for (int[] edge : adj.get(u)) {
                int v = edge[0], w = edge[1];
                if (dist[u] + w < dist[v]) {
                    dist[v] = dist[u] + w;
                    pq.offer(new int[]{dist[v], v});
                }
            }
        }

        // Find the maximum distance among all reachable nodes
        int maxDist = 0;
        for (int i = 1; i <= n; i++) {
            if (dist[i] == Integer.MAX_VALUE) return -1;  // unreachable node
            maxDist = Math.max(maxDist, dist[i]);
        }
        return maxDist;
    }
}
```

**Bellman-Ford alternative:** If negative weights were possible, Bellman-Ford would work by relaxing all edges n-1 times (O(V·E)). Since this problem has non-negative weights, Dijkstra is preferred.

**Complexity:** Dijkstra O(E log V), Bellman-Ford O(V · E). Dijkstra is preferred here since weights are non-negative.

---

## 14. Problem: Pacific Atlantic Water Flow

**LeetCode 417** | Difficulty: Medium

Given an `m × n` matrix of non-negative heights representing a continent, water can flow from a cell to its 4-directional neighbors if the neighbor's height is ≤ the current cell's height. Water can flow into the Pacific Ocean from the top and left edges, and into the Atlantic from the bottom and right edges. Return a list of grid coordinates where water can flow to both oceans.

### Approach

Instead of running BFS/DFS from every cell to see if it reaches both oceans (O((m×n)²)), **reverse the flow**: start from the ocean borders and do DFS/BFS inward, marking all cells that can reach each ocean. The answer is the intersection of cells reachable from both oceans.

```
  Heights matrix:           Pacific reachable (P):    Atlantic reachable (A):

  P  P  P  P   P             T  T  T  T  T             .  .  .  .  T
  P  1  2  2   3  A   →      T  1  2  2  T             .  .  .  T  T
  P  3  2  3   4  A   →      T  T  T  T  T             .  .  T  T  T
  P  2  4  5   3  A          T  .  T  T  T             .  .  T  T  T
  P  P  P  P   A  A          T  T  T  T  T             .  .  .  T  T
  (P = Pacific border,        Cells where BOTH P and A are T → answer
   A = Atlantic border)

  Answer: cells that can reach both = intersection of P-reachable and A-reachable sets.
```

### Java Solution (DFS from borders)

```java
class Solution {
    int rows, cols;
    int[][] heights;
    int[][] dirs = {{-1,0},{1,0},{0,-1},{0,1}};

    public List<List<Integer>> pacificAtlantic(int[][] heights) {
        this.heights = heights;
        rows = heights.length;
        cols = heights[0].length;

        boolean[][] pacificReachable  = new boolean[rows][cols];
        boolean[][] atlanticReachable = new boolean[rows][cols];

        // DFS from Pacific borders (top row + left column)
        for (int c = 0; c < cols; c++) dfs(0, c, pacificReachable);
        for (int r = 0; r < rows; r++) dfs(r, 0, pacificReachable);

        // DFS from Atlantic borders (bottom row + right column)
        for (int c = 0; c < cols; c++) dfs(rows - 1, c, atlanticReachable);
        for (int r = 0; r < rows; r++) dfs(r, cols - 1, atlanticReachable);

        // Find cells reachable from both oceans
        List<List<Integer>> result = new ArrayList<>();
        for (int r = 0; r < rows; r++) {
            for (int c = 0; c < cols; c++) {
                if (pacificReachable[r][c] && atlanticReachable[r][c]) {
                    result.add(List.of(r, c));
                }
            }
        }
        return result;
    }

    private void dfs(int r, int c, boolean[][] reachable) {
        reachable[r][c] = true;
        for (int[] d : dirs) {
            int nr = r + d[0], nc = c + d[1];
            // Flow inward: neighbor must be >= current (reverse of natural flow)
            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols
                    && !reachable[nr][nc]
                    && heights[nr][nc] >= heights[r][c]) {
                dfs(nr, nc, reachable);
            }
        }
    }
}
```

**Key insight:** the condition is `heights[nr][nc] >= heights[r][c]` (neighbor height ≥ current) because we're flowing *backwards* from the ocean. In the forward direction water flows from high to low; in reverse, we can only reach a cell if it's at least as high as where we came from.

**Complexity:** O(m × n) — each cell is visited at most twice (once per ocean). Space O(m × n) for the two boolean matrices and recursion stack.

---

## 15. Problem: Accounts Merge

**LeetCode 721** | Difficulty: Medium

Given a list of accounts where each account has a name and a list of emails, merge accounts that share any common email. Two accounts sharing even one email belong to the same person.

### Approach

This is a **connected components** problem, and **Union-Find** is the natural tool. Each unique email is a node. If two emails appear in the same account, they're connected (union them). After processing all accounts, emails in the same Union-Find component belong to the same merged account.

```
  Input accounts:
    ["John", "johnsmith@mail.com", "john00@mail.com"]
    ["John", "johnnybravo@mail.com"]
    ["John", "johnsmith@mail.com", "john_newyork@mail.com"]
    ["Mary", "mary@mail.com"]

  Union-Find edges (emails in the same account are connected):
    union("johnsmith", "john00")
    union("johnsmith", "john_newyork")
    (johnnybravo is alone — its own component)
    (mary is alone — its own component)

  Components after all unions:
    Component 1: johnsmith, john00, john_newyork  → "John"
    Component 2: johnnybravo                       → "John"
    Component 3: mary                              → "Mary"

  Output (sorted emails within each component):
    ["John", "john00@mail.com", "john_newyork@mail.com", "johnsmith@mail.com"]
    ["John", "johnnybravo@mail.com"]
    ["Mary", "mary@mail.com"]
```

### Union-Find flow (ASCII diagram)

```
  After processing account ["John", "e1", "e2", "e3"]:

  Initial:    e1   e2   e3      (each email is its own root)

  union(e1, e2):                 union(e1, e3):
      e1                          e1
      |                           / \
      e2                         e2  e3

  After path compression, find(e2) = find(e3) = e1.
  Component root = e1. Group {e1, e2, e3} together.
```

### Java Solution (Union-Find)

```java
class Solution {
    public List<List<String>> accountsMerge(List<List<String>> accounts) {
        // Map each email to a unique integer ID for Union-Find
        Map<String, Integer> emailToId = new HashMap<>();
        Map<String, String> emailToName = new HashMap<>();
        int id = 0;

        // Assign IDs and record name for each email
        for (List<String> account : accounts) {
            String name = account.get(0);
            for (int i = 1; i < account.size(); i++) {
                String email = account.get(i);
                if (!emailToId.containsKey(email)) {
                    emailToId.put(email, id++);
                    emailToName.put(email, name);
                }
            }
        }

        // Union all emails within each account (connect to the first email)
        UnionFind uf = new UnionFind(id);
        for (List<String> account : accounts) {
            String firstEmail = account.get(1);
            int firstId = emailToId.get(firstEmail);
            for (int i = 2; i < account.size(); i++) {
                uf.union(firstId, emailToId.get(account.get(i)));
            }
        }

        // Group emails by their root component
        Map<Integer, List<String>> rootToEmails = new HashMap<>();
        for (String email : emailToId.keySet()) {
            int root = uf.find(emailToId.get(email));
            rootToEmails.computeIfAbsent(root, k -> new ArrayList<>()).add(email);
        }

        // Build the result: [name, sorted emails...]
        List<List<String>> result = new ArrayList<>();
        for (List<String> emails : rootToEmails.values()) {
            Collections.sort(emails);
            String name = emailToName.get(emails.get(0));
            List<String> merged = new ArrayList<>();
            merged.add(name);
            merged.addAll(emails);
            result.add(merged);
        }
        return result;
    }

    // --- Union-Find with path compression and union by rank ---
    class UnionFind {
        int[] parent, rank;

        UnionFind(int n) {
            parent = new int[n];
            rank = new int[n];
            for (int i = 0; i < n; i++) parent[i] = i;
        }

        int find(int x) {
            if (parent[x] != x) parent[x] = find(parent[x]);
            return parent[x];
        }

        void union(int x, int y) {
            int rx = find(x), ry = find(y);
            if (rx == ry) return;
            if (rank[rx] < rank[ry]) parent[rx] = ry;
            else if (rank[rx] > rank[ry]) parent[ry] = rx;
            else { parent[ry] = rx; rank[rx]++; }
        }
    }
}
```

**Complexity:** O(N · α(N) + N log N) where N is the total number of emails. The α term is from Union-Find (nearly O(1) per operation), and the log N term is from sorting emails within each component. Space O(N) for the maps and Union-Find arrays.

### Alternative: DFS approach

You can also model emails as an undirected graph and run DFS to find connected components:

```java
// Build adjacency: for each account, connect first email to all others
// Then DFS from each unvisited email to find its component
```

Union-Find is generally cleaner and faster for this problem.

---

## 16. Quick-Reference: Problem → Pattern Mapping

| Problem                      | Pattern                              | Key Insight                                    |
|------------------------------|--------------------------------------|------------------------------------------------|
| Number of Islands            | DFS/BFS connected components         | Flood-fill each unvisited land cell            |
| Course Schedule I/II         | Topo sort + cycle detection          | Kahn's: if not all nodes output, cycle exists  |
| Clone Graph                  | DFS/BFS with visited map             | Register clone in map before recursing         |
| Word Ladder                  | BFS shortest path (unweighted)       | Wildcard patterns for efficient neighbors      |
| Network Delay Time           | Dijkstra's shortest path             | Answer = max of all shortest distances         |
| Accounts Merge               | Union-Find connected components      | Union emails in same account; group by root    |
| Pacific Atlantic Water Flow  | DFS/BFS from borders (reverse flow)  | Start from oceans inward; intersect reachable  |
| Rotting Oranges              | Multi-source BFS                     | All rotten oranges start at level 0            |
| Redundant Connection         | Union-Find                           | First edge whose endpoints already connected   |
| Alien Dictionary             | Topological sort                     | Build graph from pair-wise char diffs          |
| Graph Valid Tree             | Union-Find / BFS                     | n-1 edges + connected = tree                   |
| Evaluate Division            | BFS/DFS weighted                     | Build graph; find path; multiply weights       |

---

## 17. Algorithm Comparison Table

| Algorithm               | Type              | Time             | Space        | When to Use                                                    |
|------------------------|-------------------|------------------|--------------|----------------------------------------------------------------|
| BFS                    | Traversal         | O(V + E)         | O(V)         | Shortest path (unweighted), level order, flood fill            |
| DFS (recursive)        | Traversal         | O(V + E)         | O(V) stack   | Connected components, cycle detection, topo sort, backtracking |
| DFS (iterative)        | Traversal         | O(V + E)         | O(V)         | Same as recursive but avoids stack overflow                    |
| Kahn's Topo Sort       | Ordering          | O(V + E)         | O(V)         | Task scheduling, cycle detection (directed)                    |
| DFS Topo Sort          | Ordering          | O(V + E)         | O(V)         | Topo sort with post-order reversal                             |
| Cycle Detect (directed)| Detection         | O(V + E)         | O(V)         | 3-color DFS or Kahn's leftover check                           |
| Cycle Detect (undir.)  | Detection         | O(V + E)         | O(V)         | DFS with parent check or Union-Find                            |
| Union-Find (DSU)       | Connectivity      | O(α(N)) per op   | O(N)         | Dynamic connectivity, MST (Kruskal), accounts merge            |
| Dijkstra               | Shortest path     | O((V+E) log V)   | O(V)         | Single-source, non-negative weights                            |
| Bellman-Ford           | Shortest path     | O(V · E)         | O(V)         | Single-source, negative weights allowed, negative cycle detect |
| Floyd-Warshall         | All-pairs SP      | O(V³)            | O(V²)        | All-pairs shortest path, small dense graphs                    |
| Kruskal's MST          | Spanning tree     | O(E log E)       | O(V)         | Sparse graphs, edges already sorted                            |
| Prim's MST             | Spanning tree     | O(E log V)       | O(V)         | Dense graphs, adjacency list/matrix                            |
| A* Search              | Shortest path     | O(E log V)*      | O(V)         | Single-source with heuristic (pathfinding on grids)            |

(*A* complexity depends on heuristic quality; with a perfect heuristic it's O(E).)

---

## 18. Interview Strategy & Tips

**Step 1 — Identify the graph:** directed or undirected? weighted or unweighted? input format (adjacency list, edge list, grid, node refs)? cycles possible?

**Step 2 — Choose the algorithm:**
- Shortest path, unweighted → BFS
- Shortest path, non-negative weights → Dijkstra
- Shortest path, negative weights → Bellman-Ford
- All-pairs shortest path → Floyd-Warshall
- Topological ordering / scheduling → Kahn's or DFS post-order
- Cycle detection (directed) → DFS 3-color or Kahn's
- Cycle detection (undirected) → DFS with parent or Union-Find
- Connected components / merge groups → Union-Find or DFS/BFS
- Minimum spanning tree → Kruskal (sparse) or Prim (dense)

**Step 3 — Common pitfalls:**
1. Mark visited on enqueue (BFS) / entry (DFS), not on processing.
2. Undirected cycle detection: ignore the trivial back-edge to parent.
3. Large grids: use iterative BFS/DFS to avoid stack overflow.
4. Always check for unreachable nodes (dist may stay at infinity).
5. Watch integer overflow in distance accumulation — use `long` or guard `MAX_VALUE`.
6. 1-indexed vs 0-indexed: some problems (Network Delay Time) use 1-indexed nodes.
7. DFS topological sort: reverse the post-order sequence.

**Optimization patterns to mention in interviews:**
- Bidirectional BFS when both endpoints are known (Word Ladder).
- Multi-source BFS: start from all sources simultaneously (Rotting Oranges).
- Reverse the flow: track reachability from boundaries (Pacific Atlantic).
- State augmentation: include extra state in visited set for constraint problems.

---

## 19. Quick Reference

**Union-Find appears in many problems that don't obviously look like graph problems:** Accounts Merge (union emails), Redundant Connection (first edge with same root = cycle), Graph Valid Tree (n-1 edges + 1 component), Number of Islands II (union new land with neighbors), Kruskal's MST (union edges by weight), Satisfiability of Equations (union equalities, check contradictions).

```
  Template: (1) Map entities to IDs → (2) Initialize UF →
            (3) uf.union(a,b) for all edges → (4) Query by uf.find(x) or uf.count
```

**Complexity cheat sheet:** BFS/DFS/topo-sort/cycle-detection = O(V+E); Union-Find per op = O(α(N)) ≈ O(1); Dijkstra = O((V+E) log V); Bellman-Ford = O(V·E); Floyd-Warshall = O(V³); Kruskal = O(E log E); Prim = O(E log V).

---

## 20. Summary

Graph problems follow a small number of well-understood patterns: **BFS** (shortest path unweighted, level order, flood fill), **DFS** (connected components, cycle detection, topo sort, backtracking), **Topological Sort** (Kahn's or DFS post-order, doubles as cycle detection), **Union-Find** (dynamic connectivity, MST, group merging), **Dijkstra** (non-negative weighted shortest path), **Bellman-Ford** (negative weights), and **MST** (Kruskal/Prim). The 7 problems in this guide — Number of Islands, Course Schedule I & II, Clone Graph, Word Ladder, Network Delay Time, Pacific Atlantic Water Flow, and Accounts Merge — cover the full spectrum. Practice pattern recognition until mapping unfamiliar problems to these canonical forms becomes second nature. **Always draw the graph before coding** — visualization reveals the algorithm and catches edge cases.

## Interview Cheat Sheet

**Key Points to Remember:**
- BFS = shortest path in unweighted graph (queue).
- DFS = explore deeply, cycle detection, topological sort (stack or recursion).
- Union-Find = connected components, cycle detection in undirected graph.
- Dijkstra = shortest path with non-negative weights (priority queue).
- Topological sort = ordering with dependencies (Kahn's algorithm or DFS).

**Common Follow-Up Questions:**
- *BFS vs DFS — when to use which?* — BFS for shortest path/level-order. DFS for connectivity/cycle/topological.
- *How do you detect a cycle in a directed graph?* — DFS with three colors (white=unvisited, gray=in-progress, black=done). If you reach a gray node, there's a cycle.

**Gotcha:**
- Forgetting to mark nodes as visited before pushing to the queue/stack, not after popping. This causes duplicate processing and infinite loops.
