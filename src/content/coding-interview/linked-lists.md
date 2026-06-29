---
title: "Linked Lists — Coding Interview Prep"
category: "Coding Interview Prep"
tags: [coding-interview, linked-lists, java, algorithms, two-pointers, pointers]
difficulty: "Medium"
last_updated: "2026-06-19"
---

# Linked Lists — Coding Interview Prep

Linked lists are a foundational data structure that appears in nearly every coding interview loop. They test your ability to manipulate pointers, reason about edge cases (null heads, single nodes, cycles), and recognize recurring patterns. This article covers the core patterns, templates, and classic problems you need to master.

---

## Summary & Interview Framing

A data structure of nodes with pointers, testing pointer manipulation — slow/fast pointers for cycle detection, dummy heads for insertion/deletion.

**How it's asked:** "Reverse linked list, detect cycle, merge two sorted lists, LRU cache, copy list with random pointer — problems involving pointer manipulation and O(1) space tricks."

---

## 1. Linked List Basics

A linked list is a linear collection of nodes where each node stores a value and a reference (pointer) to the next node. Unlike arrays, linked lists do not provide O(1) random access — you must traverse from the head to reach any node. This trade-off buys you O(1) insertions and deletions at known positions, making linked lists ideal when the structure changes frequently.

### Singly Linked List

Each node has one pointer (`next`) pointing to the following node. The last node's `next` is `null`.

```
HEAD -> [1|*] -> [2|*] -> [3|*] -> [4|*] -> null
```

```java
public class ListNode {
    int val;
    ListNode next;
    ListNode(int val) { this.val = val; }
}
```

Key properties:
- O(1) insert/delete at head (given the node reference, O(1) delete after a node)
- O(n) search and access by index
- O(n) space for n elements
- Cannot traverse backward

### Doubly Linked List

Each node has two pointers: `prev` (previous) and `next` (following). This allows backward traversal and O(1) deletion when you have the node reference itself (no need to find the predecessor).

```
null <- [prev|1|next] <-> [prev|2|next] <-> [prev|3|next] -> null
```

```java
public class DoublyListNode {
    int val;
    DoublyListNode prev, next;
    DoublyListNode(int val) { this.val = val; }
}
```

Key differences from singly linked:
- Extra pointer per node → higher memory overhead
- Supports backward traversal and O(1) deletion of a given node
- Used heavily in LRU caches and bidirectional structures

### Sentinel (Dummy) Nodes

A dummy head node simplifies edge-case handling (empty list, inserting at head). Instead of special-casing the head, you always operate after a dummy node and return `dummy.next` at the end.

```java
ListNode dummy = new ListNode(0);
dummy.next = head;
// ... operate freely, no null-head special case ...
return dummy.next;
```

This technique appears in merge, removal, and reordering problems throughout this article.

### When Interviewers Expect Linked Lists

Linked list problems typically arise when the problem mentions "list," "sequence," or "chain" structures that grow and shrink dynamically, or when you need a data structure with O(1) insertions/deletions at the ends (queues, deques, LRU cache). Recognize the signal: if random access is never required but pointer manipulation is natural, a linked list is likely the right choice.

---

## 2. Pattern: Reversal

**When to use:** Any problem that requires changing the direction of links — reversing a whole list, a sublist, or rearranging nodes in place. Reversal is also a building block for palindrome checks and reorder problems.

### Iterative Reversal — Pointer Walkthrough

The idea: walk the list with three pointers — `prev`, `curr`, and `nextTemp`. At each step, flip `curr.next` to point backward, then advance all three.

```
Initial:  null    [1] -> [2] -> [3] -> null
           ^      ^
          prev   curr

Step 1:   null <- [1]     [2] -> [3] -> null
                  ^       ^
                 prev    curr
           (curr.next = prev; advance prev, curr)

Step 2:   null <- [1] <- [2]     [3] -> null
                          ^       ^
                         prev    curr

Step 3:   null <- [1] <- [2] <- [3]     null
                                  ^      ^
                                 prev   curr
           (curr == null → stop; return prev)
```

```java
// Template: iterative reversal — returns new head
public ListNode reverseList(ListNode head) {
    ListNode prev = null;
    ListNode curr = head;
    while (curr != null) {
        ListNode nextTemp = curr.next; // save next
        curr.next = prev;              // flip pointer
        prev = curr;                   // advance prev
        curr = nextTemp;               // advance curr
    }
    return prev; // prev is the new head
}
```

- Time: O(n)
- Space: O(1)

### Recursive Reversal

The recursive approach reaches the tail first, then rewinds, flipping each pointer on the way back. The base case returns the last node (new head). After unwinding, `head.next` still points to the node that is now the tail, so we set `head.next.next = head` to reverse the link and `head.next = null` to terminate.

```java
public ListNode reverseListRecursive(ListNode head) {
    if (head == null || head.next == null) return head; // base case
    ListNode newHead = reverseListRecursive(head.next); // recurse to tail
    head.next.next = head; // flip the link back toward head
    head.next = null;      // sever old forward link
    return newHead;
}
```

- Time: O(n)
- Space: O(n) for the recursion stack (interviewers often prefer iterative for this reason)

### Problem 1: Reverse Linked List (LeetCode 206)

Reverse a singly linked list and return the new head. This is the canonical reversal problem — use either the iterative or recursive template above.

```java
class Solution {
    public ListNode reverseList(ListNode head) {
        ListNode prev = null;
        ListNode curr = head;
        while (curr != null) {
            ListNode nextTemp = curr.next;
            curr.next = prev;
            prev = curr;
            curr = nextTemp;
        }
        return prev;
    }
}
```

Edge cases: empty list (returns null), single node (returns itself). Both handled naturally — the loop body never runs for null/single inputs.

### Problem 2: Reverse Linked List II (LeetCode 92)

Reverse the nodes from position `left` to `right` (1-indexed), leaving the rest intact. Use a dummy head to handle `left == 1`, walk to the node before `left`, then reverse the sublist of length `right - left + 1` using a "head insertion" technique.

```java
class Solution {
    public ListNode reverseBetween(ListNode head, int left, int right) {
        ListNode dummy = new ListNode(0);
        dummy.next = head;
        ListNode prev = dummy;
        // move prev to the node immediately before position 'left'
        for (int i = 1; i < left; i++) prev = prev.next;
        ListNode curr = prev.next; // first node of the sublist to reverse
        // reverse by repeatedly moving curr.next to the front of the sublist
        for (int i = 0; i < right - left; i++) {
            ListNode nextNode = curr.next;     // node to move forward
            curr.next = nextNode.next;         // skip over nextNode
            nextNode.next = prev.next;         // insert nextNode at front
            prev.next = nextNode;
        }
        return dummy.next;
    }
}
```

The head-insertion trick: keep `prev` and `curr` fixed, and repeatedly pluck `curr.next` and insert it right after `prev`. After `right - left` iterations the sublist is reversed without a full two-pass reversal.

---

## 3. Pattern: Fast & Slow Pointers (Floyd's Tortoise and Hare)

**When to use:** Any problem about cycle detection, finding the middle, finding the k-th node from the end, or detecting meeting points. Two pointers move at different speeds (or start offsets) to extract structural information in a single pass with O(1) space.

### Floyd's Cycle Detection — Diagram

Use two pointers: a slow tortoise (moves 1 step) and a fast hare (moves 2 steps). If there is a cycle, the hare will lap the tortoise and they meet inside the cycle. If there is no cycle, the hare reaches `null`.

```
No cycle (hare escapes):
  S
  v
 [1] -> [2] -> [3] -> [4] -> null
  ^
  F

Step: F jumps 2, S jumps 1. F reaches null first → no cycle.

With cycle:
  S,F
  v
 [1] -> [2] -> [3] -> [4] -+
                ^          |
                +----------+
            (4 points back to 2)

  S moves 1, F moves 2. Inside the cycle F gains 1 step per move
  on S, so they eventually collide at some node → cycle exists.
```

Why they meet: once both are inside the cycle, the hare closes the gap by one node per step. A gap of k nodes closes in exactly k steps, so a meeting is guaranteed.

### Problem 1: Linked List Cycle (LeetCode 141)

Determine whether a linked list has a cycle. Classic Floyd application.

```java
public class Solution {
    public boolean hasCycle(ListNode head) {
        ListNode slow = head, fast = head;
        while (fast != null && fast.next != null) {
            slow = slow.next;        // tortoise: 1 step
            fast = fast.next.next;   // hare: 2 steps
            if (slow == fast) return true; // they meet → cycle
        }
        return false; // hare escaped → no cycle
    }
}
```

- Time: O(n), Space: O(1)
- The condition `fast != null && fast.next != null` is critical — `fast.next.next` would NPE otherwise.

### Problem 2: Middle of the Linked List (LeetCode 876)

Return the middle node (if two middles, return the second). The fast pointer reaches the end exactly when the slow pointer is at the middle.

```java
class Solution {
    public ListNode middleNode(ListNode head) {
        ListNode slow = head, fast = head;
        while (fast != null && fast.next != null) {
            slow = slow.next;
            fast = fast.next.next;
        }
        return slow;
    }
}
```

Why it works: fast moves twice as fast as slow, so when fast has traversed the whole list, slow has traversed half. With an even count, fast lands on null and slow is on the second middle — exactly the desired behavior.

### Problem 3: Remove Nth Node From End of List (LeetCode 19)

Remove the n-th node from the end in one pass. Send a fast pointer n steps ahead, then move both until fast hits null — slow will be just before the target.

```
n = 2
dummy -> [1] -> [2] -> [3] -> [4] -> [5] -> null
         ^fast (after 2 steps: fast at [3])
Now move slow (at dummy) and fast together:
         ^slow           ^fast
               ^slow           ^fast  → fast is null, slow before [4]
Remove slow.next.
```

```java
class Solution {
    public ListNode removeNthFromEnd(ListNode head, int n) {
        ListNode dummy = new ListNode(0);
        dummy.next = head;
        ListNode fast = dummy, slow = dummy;
        for (int i = 0; i < n; i++) fast = fast.next; // fast leads by n
        while (fast.next != null) {                     // move until fast at tail
            fast = fast.next;
            slow = slow.next;
        }
        slow.next = slow.next.next; // skip the target node
        return dummy.next;
    }
}
```

The dummy head handles the edge case where the node to remove is the original head (n equals the list length). Without it, `slow` would be null and the removal would crash.

---

## 4. Pattern: Merging Sorted Lists

**When to use:** Whenever you need to combine two or more sorted sequences into one sorted sequence while preserving order. Merge problems are the linked-list analogue of the merge step in merge sort.

### Problem 1: Merge Two Sorted Lists (LeetCode 21)

Merge two sorted lists into one sorted list. Use a dummy tail and append the smaller current node at each step.

```java
class Solution {
    public ListNode mergeTwoLists(ListNode l1, ListNode l2) {
        ListNode dummy = new ListNode(0);
        ListNode tail = dummy;
        while (l1 != null && l2 != null) {
            if (l1.val <= l2.val) {
                tail.next = l1;
                l1 = l1.next;
            } else {
                tail.next = l2;
                l2 = l2.next;
            }
            tail = tail.next;
        }
        // attach whichever list remains (one of these is null)
        tail.next = (l1 != null) ? l1 : l2;
        return dummy.next;
    }
}
```

- Time: O(n + m), Space: O(1) (we reuse existing nodes, only the dummy is new)

The key insight: we relink existing nodes rather than allocating new ones. The final `tail.next = ...` line handles the leftover tail in O(1) instead of looping through the remainder.

### Problem 2: Merge K Sorted Lists (LeetCode 23)

Merge k sorted linked lists into one. Three approaches, in increasing efficiency:

1. **Sequential merge:** merge lists pairwise left to right. O(kN) where N is total nodes — simple but slow.
2. **Divide and conquer:** pair up lists and merge them in a tournament bracket. O(N log k).
3. **Min-heap (priority queue):** push each list head, repeatedly pop the min and push its next. O(N log k).

The min-heap approach is the most common interview answer:

```java
class Solution {
    public ListNode mergeKLists(ListNode[] lists) {
        if (lists == null || lists.length == 0) return null;
        PriorityQueue<ListNode> minHeap = new PriorityQueue<>(
            (a, b) -> Integer.compare(a.val, b.val));
        for (ListNode node : lists) {
            if (node != null) minHeap.offer(node);
        }
        ListNode dummy = new ListNode(0);
        ListNode tail = dummy;
        while (!minHeap.isEmpty()) {
            ListNode smallest = minHeap.poll();
            tail.next = smallest;
            tail = tail.next;
            if (smallest.next != null) minHeap.offer(smallest.next);
        }
        return dummy.next;
    }
}
```

- Time: O(N log k) — each of N nodes is pushed/pulled once, each heap op is O(log k)
- Space: O(k) for the heap

The divide-and-conquer variant avoids the heap and its log factor on k, but both have the same asymptotic complexity. Mention the heap version first; mention divide-and-conquer as an O(1) extra-space alternative.

```java
// Divide and conquer variant — O(N log k) time, O(log k) stack space
class Solution {
    public ListNode mergeKLists(ListNode[] lists) {
        if (lists == null || lists.length == 0) return null;
        int interval = 1;
        while (interval < lists.length) {
            for (int i = 0; i + interval < lists.length; i += interval * 2) {
                lists[i] = mergeTwoLists(lists[i], lists[i + interval]);
            }
            interval *= 2;
        }
        return lists[0];
    }
    private ListNode mergeTwoLists(ListNode a, ListNode b) {
        ListNode dummy = new ListNode(0), tail = dummy;
        while (a != null && b != null) {
            if (a.val <= b.val) { tail.next = a; a = a.next; }
            else { tail.next = b; b = b.next; }
            tail = tail.next;
        }
        tail.next = (a != null) ? a : b;
        return dummy.next;
    }
}
```

---

## 5. Pattern: Cycle Start Detection

**When to use:** When a problem asks for the exact node where a cycle begins (not just whether one exists). This is the direct sequel to Floyd's detection.

### Problem: Linked List Cycle II (LeetCode 142)

After Floyd's pointers meet, reset one pointer to the head and move both at the same speed. They meet again at the cycle entry.

**Why this works (the math):** Let `L` be the distance from head to cycle entry, `C` the cycle length, and `k` the distance from the cycle entry to the meeting point. The slow pointer traveled `L + k`. The fast pointer traveled `L + k + nC` (it looped the cycle n times). Since fast moved twice as far: `2(L + k) = L + k + nC` → `L = nC − k` → `L = (n−1)C + (C − k)`. So the distance from head to entry equals the distance from the meeting point to entry (mod cycle length). Moving both at the same speed from head and meeting point makes them collide exactly at the entry.

```
Head --L--> Entry ---k--> Meeting point
            ^              |
            +----C-k-------+
            (cycle continues around)

After meeting: ptr1 = head, ptr2 = meeting point.
Both move 1 step at a time. After L steps:
  ptr1 has gone L  → at Entry
  ptr2 has gone L = (n-1)C + (C-k) → also at Entry (looped back)
They meet at Entry.
```

```java
public class Solution {
    public ListNode detectCycle(ListNode head) {
        ListNode slow = head, fast = head;
        // Phase 1: detect meeting point
        while (fast != null && fast.next != null) {
            slow = slow.next;
            fast = fast.next.next;
            if (slow == fast) {
                // Phase 2: find cycle entry
                ListNode ptr1 = head;
                ListNode ptr2 = slow;
                while (ptr1 != ptr2) {
                    ptr1 = ptr1.next;
                    ptr2 = ptr2.next;
                }
                return ptr1;
            }
        }
        return null; // no cycle
    }
}
```

- Time: O(n), Space: O(1)

---

## 6. Pattern: Palindrome Linked List

**When to use:** When you need to check whether a list reads the same forward and backward, in O(n) time and O(1) space.

### Problem: Palindrome Linked List (LeetCode 234)

The optimal approach combines three patterns you have already learned: find the middle with fast/slow, reverse the second half, then compare the two halves node by node. Optionally restore the list by re-reversing.

Steps:
1. Find the middle using fast/slow pointers.
2. Reverse the second half starting at the middle.
3. Compare the first half and the reversed second half — all values must match.
4. (Optional) restore the list by reversing the second half again.

```java
class Solution {
    public boolean isPalindrome(ListNode head) {
        if (head == null || head.next == null) return true;
        // 1. Find middle (slow ends at start of second half)
        ListNode slow = head, fast = head;
        while (fast != null && fast.next != null) {
            slow = slow.next;
            fast = fast.next.next;
        }
        // 2. Reverse second half
        ListNode secondHalf = reverse(slow);
        ListNode copySecond = secondHalf; // save for restoration
        // 3. Compare both halves
        ListNode firstHalf = head;
        boolean result = true;
        while (secondHalf != null) {
            if (firstHalf.val != secondHalf.val) { result = false; break; }
            firstHalf = firstHalf.next;
            secondHalf = secondHalf.next;
        }
        // 4. Restore list (optional, good practice)
        reverse(copySecond);
        return result;
    }
    private ListNode reverse(ListNode head) {
        ListNode prev = null, curr = head;
        while (curr != null) {
            ListNode nextTemp = curr.next;
            curr.next = prev;
            prev = curr;
            curr = nextTemp;
        }
        return prev;
    }
}
```

- Time: O(n), Space: O(1)

This problem is a great example of composing smaller patterns (middle + reverse + compare) to solve a larger problem. Mention the restoration step in interviews — interviewers like candidates who avoid mutating the input unnecessarily.

---

## 7. Pattern: Intersection of Two Linked Lists

**When to use:** When two lists share a common tail and you must find the merge point in O(n) time and O(1) space.

### Problem: Intersection of Two Linked Lists (LeetCode 160)

Given two heads that may converge into a shared suffix, return the intersection node. The trick: align the effective lengths. Traverse both lists with two pointers; when either reaches the end, redirect it to the other list's head. After at most one redirection each, both pointers are effectively the same distance from the intersection (or both reach null simultaneously if there is no intersection).

```
List A: a1 -> a2 -> c1 -> c2 -> c3
List B: b1 -> b2 -> b3 -> c1 -> c2 -> c3
                         ^ intersection

ptrA walks A then B; ptrB walks B then A.
Both travel |A| + |B| - |shared| steps before reaching c1 together.
```

```java
public class Solution {
    public ListNode getIntersectionNode(ListNode headA, ListNode headB) {
        if (headA == null || headB == null) return null;
        ListNode a = headA, b = headB;
        // When a reaches end of A, redirect to headB; same for b → headA.
        // They meet at intersection, or both become null (no intersection).
        while (a != b) {
            a = (a == null) ? headB : a.next;
            b = (b == null) ? headA : b.next;
        }
        return a;
    }
}
```

- Time: O(m + n), Space: O(1)

Why they meet: each pointer traverses exactly `len(A) + len(B)` steps before the loop ends — either at the intersection (if one exists) or both at null. The length difference is neutralized because each pointer walks the "long" portion via the other list's head.

---

## 8. Pattern: Copy with Random Pointers

**When to use:** Deep-copying a linked list where each node has a `random` pointer that may point to any node (or null). The challenge is resolving the random pointers in the copy without a second pass that requires a node-to-node map.

### Problem: Copy List with Random Pointer (LeetCode 138)

Each node has `next` and `random`. The O(1) space approach interleaves copy nodes between originals so that `original.next` is the copy, making random-pointer resolution trivial.

Steps:
1. **Interleave:** insert a copy of each node right after it. `A -> A' -> B -> B' -> C -> C'`.
2. **Set randoms:** for each original, `original.next.random = original.random.next` (if `original.random` is not null), because the copy of the random target sits right after it.
3. **Detach:** separate the interleaved list back into the original and the copy.

```
Original:  A -> B -> C
After interleave:  A -> A' -> B -> B' -> C -> C'
Set randoms: if A.random = C, then A'.random = C' (which is C.next)
Detach: A -> B -> C  and  A' -> B' -> C'
```

```java
class Node {
    int val;
    Node next, random;
    Node(int val) { this.val = val; }
}

class Solution {
    public Node copyRandomList(Node head) {
        if (head == null) return null;
        // Step 1: interleave copies
        Node curr = head;
        while (curr != null) {
            Node copy = new Node(curr.val);
            copy.next = curr.next;
            curr.next = copy;
            curr = copy.next;
        }
        // Step 2: assign random pointers
        curr = head;
        while (curr != null) {
            if (curr.random != null) {
                curr.next.random = curr.random.next; // copy's random = copy of original's random
            }
            curr = curr.next.next; // skip over the copy
        }
        // Step 3: detach the copy list
        Node dummy = new Node(0);
        Node copyTail = dummy;
        curr = head;
        while (curr != null) {
            Node copy = curr.next;
            curr.next = copy.next;       // restore original's next
            copyTail.next = copy;        // append copy to result
            copyTail = copy;
            curr = curr.next;
        }
        return dummy.next;
    }
}
```

- Time: O(n), Space: O(1) extra (excluding the output)

The HashMap alternative (`Map<Node,Node>` mapping originals to copies) is simpler to explain and also acceptable: do two passes — first pass create all copies and populate the map, second pass wire `next` and `random` using the map. It uses O(n) space but is easier to write under pressure.

---

## 9. Pattern: Add Two Numbers

**When to use:** When a number is stored digit-by-digit in a linked list (least significant digit first) and you must perform arithmetic. The same pattern generalizes to any digit-wise or place-value computation on lists.

### Problem: Add Two Numbers (LeetCode 2)

Two non-empty lists represent non-negative integers with the least significant digit at the head. Return their sum as a list. Simulate grade-school addition with a carry.

```
  (2 -> 4 -> 3)      = 342
+ (5 -> 6 -> 4)      = 465
= (7 -> 0 -> 8)      = 807

Step: 2+5=7, carry 0; 4+6=10, write 0 carry 1; 3+4+1=8, carry 0.
```

```java
class Solution {
    public ListNode addTwoNumbers(ListNode l1, ListNode l2) {
        ListNode dummy = new ListNode(0);
        ListNode tail = dummy;
        int carry = 0;
        while (l1 != null || l2 != null || carry != 0) {
            int sum = carry;
            if (l1 != null) { sum += l1.val; l1 = l1.next; }
            if (l2 != null) { sum += l2.val; l2 = l2.next; }
            carry = sum / 10;
            tail.next = new ListNode(sum % 10);
            tail = tail.next;
        }
        return dummy.next;
    }
}
```

- Time: O(max(m, n)), Space: O(max(m, n)) for the result

The loop condition `|| carry != 0` is the crucial detail — it handles the case where a final carry must create an extra most-significant node (e.g., 99 + 1 = 100). Without it, you would drop the leading 1.

**Variant — Add Two Numbers II (LeetCode 445):** digits are stored most-significant first. Reverse both inputs, add with the template above, then reverse the result. Or use stacks to avoid mutating the inputs.

---

## 10. Pattern: LRU Cache (Preview)

**When to use:** When you need O(1) get and put with eviction of the least-recently-used item when capacity is exceeded. The canonical structure is a doubly linked list (for O(1) eviction and move-to-front) plus a hash map (for O(1) node lookup).

The doubly linked list maintains recency order: most recently used at the head, least recently used at the tail. The hash map maps keys to list nodes so you can find and unlink any node in O(1).

```
HashMap: key -> Node
List:  MRU [k3] <-> [k1] <-> [k7] LRU
                ^                 ^
              head             tail (evict from tail)

get(k1): find node via map, move it to head, return value.
put(k1): if exists, update + move to head; else add at head,
         evict tail if over capacity.
```

```java
class LRUCache {
    class Node {
        int key, val;
        Node prev, next;
        Node(int k, int v) { key = k; val = v; }
    }
    private final int capacity;
    private final Map<Integer, Node> map = new HashMap<>();
    private final Node head = new Node(0, 0); // dummy MRU
    private final Node tail = new Node(0, 0); // dummy LRU

    public LRUCache(int capacity) {
        this.capacity = capacity;
        head.next = tail;
        tail.prev = head;
    }
    public int get(int key) {
        if (!map.containsKey(key)) return -1;
        Node node = map.get(key);
        remove(node);       // unlink from current position
        addToFront(node);   // move to MRU position
        return node.val;
    }
    public void put(int key, int value) {
        if (map.containsKey(key)) {
            Node node = map.get(key);
            node.val = value;
            remove(node);
            addToFront(node);
            return;
        }
        if (map.size() == capacity) {
            Node lru = tail.prev; // least recently used
            remove(lru);
            map.remove(lru.key);
        }
        Node node = new Node(key, value);
        addToFront(node);
        map.put(key, node);
    }
    private void remove(Node node) {
        node.prev.next = node.next;
        node.next.prev = node.prev;
    }
    private void addToFront(Node node) {
        node.next = head.next;
        node.prev = head;
        head.next.prev = node;
        head.next = node;
    }
}
```

- Time: O(1) for both get and put
- Space: O(capacity)

Dummy head and tail nodes eliminate null checks in `remove` and `addToFront` — this is the same sentinel technique from the basics section, applied to a doubly linked list. The LRU cache is a full design problem; this preview shows how the list patterns you have learned compose into a real-world data structure.

---

## 11. Pattern: Rotate List

**When to use:** When you need to rotate a list by k positions. The efficient approach avoids rotating one node at a time (which would be O(kn)) by closing the list into a ring, finding the new tail, and cutting there.

### Problem: Rotate List (LeetCode 61)

Rotate the list to the right by k places. Key observations: rotating by the list length is a no-op, so first reduce k modulo the length. Then the new head is at position `len - k`, and the new tail is one before it.

```
List: 1 -> 2 -> 3 -> 4 -> 5,  k = 2,  len = 5
Reduce k: k = 2 % 5 = 2
New tail index = len - k = 3 (node 3)
New head = new tail.next = node 4

Steps: close into ring (tail.next = head), then cut after node 3.
Result: 4 -> 5 -> 1 -> 2 -> 3
```

```java
class Solution {
    public ListNode rotateRight(ListNode head, int k) {
        if (head == null || head.next == null || k == 0) return head;
        // 1. Compute length and find the current tail
        int len = 1;
        ListNode tail = head;
        while (tail.next != null) { tail = tail.next; len++; }
        // 2. Reduce k and close the ring
        k %= len;
        if (k == 0) return head; // no rotation needed
        tail.next = head; // ring
        // 3. Walk to the new tail (len - k steps from head)
        ListNode newTail = head;
        for (int i = 1; i < len - k; i++) newTail = newTail.next;
        // 4. Cut the ring
        ListNode newHead = newTail.next;
        newTail.next = null;
        return newHead;
    }
}
```

- Time: O(n), Space: O(1)

The `k %= len` step is essential — without it, a huge k (e.g., 2,000,000 on a 5-node list) would cause 400,000 unnecessary full rotations.

---

## 12. Pattern: Swap Nodes in Pairs

**When to use:** When you need to swap adjacent pairs of nodes (not values — actual node swaps). This is a warm-up for k-group reversal and exercises careful pointer rewiring.

### Problem: Swap Nodes in Pairs (LeetCode 24)

Swap every two adjacent nodes and return the new head. Use a dummy head and a `prev` pointer that sits before each pair; for each pair, rewire so the second node points to the first and `prev` points to the second.

```
dummy -> [1] -> [2] -> [3] -> [4] -> null
  ^prev   a      b

After swap:
dummy -> [2] -> [1] -> [3] -> [4] -> null
  ^prev   b      a
Move prev to a (now the tail of the swapped pair), repeat.
```

```java
class Solution {
    public ListNode swapPairs(ListNode head) {
        ListNode dummy = new ListNode(0);
        dummy.next = head;
        ListNode prev = dummy;
        while (prev.next != null && prev.next.next != null) {
            ListNode a = prev.next;        // first of pair
            ListNode b = a.next;           // second of pair
            // Rewire: prev -> b -> a -> (b's original next)
            a.next = b.next;
            b.next = a;
            prev.next = b;
            // Advance prev to the end of the swapped pair
            prev = a;
        }
        return dummy.next;
    }
}
```

- Time: O(n), Space: O(1)

The three rewiring lines must be done in the right order: set `a.next = b.next` before `b.next = a`, or you lose the rest of the list. Drawing the pointer diagram before coding prevents this class of bug.

---

## 13. Pattern: Reorder List

**When to use:** When you need to interleave nodes from the front and back of a list (e.g., L0 → L1 → … → Ln becomes L0 → Ln → L1 → Ln−1 → …). This is a composite problem that combines three patterns you already know: find the middle, reverse the second half, then merge alternately.

### Problem: Reorder List (LeetCode 143)

Steps:
1. Find the middle with fast/slow pointers.
2. Reverse the second half.
3. Merge the first half and the reversed second half by alternating nodes.

```
Input:  1 -> 2 -> 3 -> 4 -> 5
After find middle (split at 3):
  First:  1 -> 2 -> 3
  Second: 4 -> 5
After reverse second:
  First:  1 -> 2 -> 3
  Second: 5 -> 4
Merge alternating:
  1 -> 5 -> 2 -> 4 -> 3
```

```java
class Solution {
    public void reorderList(ListNode head) {
        if (head == null || head.next == null) return;
        // 1. Find middle
        ListNode slow = head, fast = head;
        while (fast != null && fast.next != null) {
            slow = slow.next;
            fast = fast.next.next;
        }
        // 2. Reverse second half (slow is the start of the second half)
        ListNode second = reverse(slow);
        ListNode first = head;
        // 3. Merge alternately
        while (second.next != null) { // stop when second half exhausted
            ListNode tmp1 = first.next;
            ListNode tmp2 = second.next;
            first.next = second;      // insert second node after first
            second.next = tmp1;       // chain back to first's original next
            first = tmp1;
            second = tmp2;
        }
    }
    private ListNode reverse(ListNode head) {
        ListNode prev = null, curr = head;
        while (curr != null) {
            ListNode nextTemp = curr.next;
            curr.next = prev;
            prev = curr;
            curr = nextTemp;
        }
        return prev;
    }
}
```

- Time: O(n), Space: O(1)

The loop condition `second.next != null` (rather than `second != null`) is deliberate: when the list has an odd length, the middle node belongs to the first half, and the second half is one node shorter. Stopping when `second.next` is null avoids appending the middle node twice. This is exactly the kind of off-by-one detail interviewers probe, so be ready to explain why the condition is what it is.

---

## Pattern Recognition Table

Use this table to map a problem statement to the right pattern fast.

| Signal in the problem | Pattern | Key technique | Example problems |
|---|---|---|---|
| "Reverse" / "flip direction" | Reversal | Three pointers prev/curr/next; or recursion | Reverse Linked List, Reverse Linked List II |
| "Cycle" / "loop" / "does it terminate" | Floyd's fast & slow | Two pointers, speeds 1 and 2 | Linked List Cycle |
| "Where does the cycle start" | Cycle start | Floyd's meet + reset one pointer to head | Linked List Cycle II |
| "Middle" / "second half" | Fast & slow middle | Fast moves 2, slow moves 1 | Middle of the Linked List |
| "N-th from the end" / "remove last N" | Lead pointer by N | Fast leads by N, then move together | Remove Nth Node From End |
| "Merge two sorted" | Merge with dummy | Compare heads, append smaller | Merge Two Sorted Lists |
| "Merge k sorted" | Heap or divide & conquer | Min-heap of heads; or pairwise merge | Merge K Sorted Lists |
| "Palindrome" | Middle + reverse + compare | Find middle, reverse half, compare | Palindrome Linked List |
| "Intersection" / "common node" | Two-pointer redirect | Each pointer walks A then B | Intersection of Two Linked Lists |
| "Deep copy" / "random pointers" | Interleave copies | Insert copies between originals | Copy List with Random Pointer |
| "Digit-wise addition" / "add numbers" | Carry simulation | Grade-school addition with carry | Add Two Numbers, Add Two Numbers II |
| "O(1) get/put + eviction" | LRU cache | HashMap + doubly linked list | LRU Cache |
| "Rotate by k" | Close ring and cut | Tail.next = head, cut at len - k | Rotate List |
| "Swap adjacent pairs" | Pairwise pointer rewire | Dummy + prev before each pair | Swap Nodes in Pairs |
| "Interleave front and back" | Reorder | Middle + reverse half + alternate merge | Reorder List |
| "Reverse in groups of k" | k-group reversal | Count k, reverse block, recurse | Reverse Nodes in k-Group |
| "Sort a linked list" | Merge sort on lists | Split at middle, recursively sort, merge | Sort List |
| "Partition around value" | Two dummy lists | Build < and >= sublists, concatenate | Partition List |

### General Tips

- **Always start with a dummy head** when the result head might change (merge, remove, reorder, swap). It eliminates the null-head special case and you return `dummy.next` at the end.
- **Draw the pointer diagram before coding.** Most linked-list bugs come from misordered rewiring. Sketching the before/after state for one or two iterations catches these immediately.
- **Be precise with loop conditions.** Whether you check `fast != null && fast.next != null` vs `fast.next != null && fast != null` changes which node `slow` lands on for even-length lists — know which one your problem needs.
- **Prefer iterative over recursive** when the list can be long, to avoid stack overflow. Use recursion only when it materially simplifies the logic (e.g., the recursive reversal base case).
- **Reduce k modulo the length** in any rotation/grouping problem to avoid massive redundant work.
- **Restore mutated inputs** when the problem does not require mutation (e.g., re-reversing in palindrome check). It signals good engineering hygiene.
- **Sentinel nodes are your friend** in doubly linked structures too — the LRU cache's dummy head and tail show how they make `remove` and `addToFront` branch-free.

### Common Edge Cases to Test

- Empty list (head is null)
- Single node
- Two nodes (pair/swap boundary)
- Even vs odd length (affects middle and reorder)
- k larger than list length (rotation, k-group)
- No cycle vs cycle at head vs cycle at tail
- Two lists with no intersection
- Carry that produces a new most-significant digit (Add Two Numbers)
- `left == 1` in sublist reversal (handled by the dummy)

## Interview Cheat Sheet

**Key Points to Remember:**
- Slow/fast pointers: detect cycle (fast meets slow), find middle (fast reaches end), find Kth from end (fast gets K head start).
- Dummy head: simplifies insertion/deletion at head — no special case for first node.
- Reversal: three pointers (prev, curr, next), iterate and flip.
- Merge: compare heads, pick smaller, advance. Always draw the pointer diagram before coding.

**Common Follow-Up Questions:**
- **How do you detect where the cycle starts?** — After slow/fast meet, reset slow to head, move both one step at a time — they meet at the cycle start.
- **How do you reverse a sublist?** — Find the node before the sublist, reverse K nodes starting from there, reconnect.

**Gotcha:**
- Losing the head pointer during reversal. Always save the original head before starting, or use a dummy node. After reversal, the new head is the last node of the original list — if you don't track it, you lose the list.
