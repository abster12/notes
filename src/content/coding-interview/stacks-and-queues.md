---
title: "Stacks & Queues — Coding Interview Prep"
category: "Coding Interview Prep"
tags: [coding-interview, stacks, queues, java, algorithms, monotonic-stack, bfs, dfs]
difficulty: "Medium"
last_updated: "2026-06-19"
---

# Stacks & Queues — Coding Interview Prep

A comprehensive guide to stack and queue patterns for coding interviews. Each section covers when to use the pattern, a reusable Java template, and 2-3 classic problems with full solutions.

---

## Summary & Interview Framing

LIFO and FIFO data structures — stacks for DFS/parentheses/monotonic patterns, queues for BFS/scheduling, deques for sliding window max.

**How it's asked:** "Valid parentheses, daily temperatures, largest rectangle in histogram, sliding window maximum, implement queue using stacks — problems involving LIFO/FIFO processing order."

---

## 1. Why Stacks & Queues Matter

Stacks (LIFO) and queues (FIFO) are the backbone of many interview patterns. They appear in:
- Parsing and expression evaluation (parentheses, calculators, RPN)
- Range queries over arrays (next greater/smaller element, stock span)
- Sliding window extremum queries (deque)
- Simulation problems (asteroid collision, valid stack sequences)
- Design problems (min stack, queue from stacks)

The key insight: whenever a problem asks for "next/previous greater/smaller" or involves nested/ordered structure, reach for a stack. Whenever you need a sliding extremum, reach for a deque.

### Stack Fundamentals

A stack supports push, pop, peek, and isEmpty — all in O(1). In Java, `Deque<Integer>` (implemented by `ArrayDeque`) is preferred over the legacy `Stack` class, which is synchronized and slow.

```
   push(3)   push(7)   push(1)    pop() -> 1
   ┌───┐     ┌───┐     ┌───┐      ┌───┐
   │ 3 │     │ 7 │     │ 1 │ top  │ 7 │ top
   │   │     │ 3 │     │ 3 │      │ 3 │
   └───┘     └───┘     └───┘      └───┘
   bottom    bottom    bottom     bottom
```

### Queue Fundamentals

A queue supports offer, poll, peek — all O(1). Use `ArrayDeque` or `LinkedList` as a `Deque`.

---

## 2. Monotonic Stack — The Workhorse Pattern

### When to Use

Use a monotonic stack when the problem asks for:
- Next greater / next smaller element
- Previous greater / previous smaller element
- Largest rectangle in histogram
- Stock span / daily temperatures
- Any query where you need, for each element, the nearest element to its left or right that satisfies an inequality

The stack maintains elements in monotonic (increasing or decreasing) order. When a new element violates the order, we pop until order is restored, and each pop reveals a relationship between the popped element and the new element.

### Two Flavors

- **Monotonically decreasing stack** (top is smallest): used for "next greater element." We pop while `stack.top() < current`, and for each popped element, `current` is its next greater.
- **Monotonically increasing stack** (top is largest): used for "next smaller element." We pop while `stack.top() > current`.

### ASCII Diagram: Monotonic Stack (Next Greater Element)

Input: [2, 1, 2, 4, 3]  — finding next greater for each element.

```
Element 2: stack empty        -> push 2     Stack: [2]
Element 1: 1 <= 2 (top)       -> push 1     Stack: [2, 1]
Element 2: 1 < 2 -> pop 1     -> result[1]=2
           2 <= 2 (top)       -> push 2     Stack: [2, 2]
Element 4: 2 < 4 -> pop 2     -> result[2]=4
           2 < 4 -> pop 2     -> result[0]=4
           stack empty        -> push 4     Stack: [4]
Element 3: 3 <= 4 (top)       -> push 3     Stack: [4, 3]

Remaining in stack have no next greater -> result = -1
Final result: [4, 2, 4, -1, -1]
```

The invariant: the stack always holds indices whose "next greater" has not yet been found, in decreasing order of their values.

### Java Template (Next Greater Element)

```java
public int[] nextGreaterElements(int[] nums) {
    int n = nums.length;
    int[] result = new int[n];
    Arrays.fill(result, -1);
    Deque<Integer> stack = new ArrayDeque<>(); // stores indices

    for (int i = 0; i < n; i++) {
        while (!stack.isEmpty() && nums[stack.peek()] < nums[i]) {
            result[stack.pop()] = nums[i];
        }
        stack.push(i);
    }
    // remaining indices have no next greater -> already -1
    return result;
}
```

Time: O(n) — each element pushed and popped at most once. Space: O(n).

### Classic Problem 1: Daily Temperatures (LeetCode 739)

Given temperatures array, for each day return the number of days until a warmer temperature. If none, return 0.

This is a "next greater element" problem where we store the distance (index difference) instead of the value.

```java
class Solution {
    public int[] dailyTemperatures(int[] temperatures) {
        int n = temperatures.length;
        int[] answer = new int[n];
        Deque<Integer> stack = new ArrayDeque<>(); // indices, monotonic decreasing by temp

        for (int i = 0; i < n; i++) {
            while (!stack.isEmpty() && temperatures[stack.peek()] < temperatures[i]) {
                int prevIndex = stack.pop();
                answer[prevIndex] = i - prevIndex;
            }
            stack.push(i);
        }
        return answer;
    }
}
```

Walkthrough for [73, 74, 75, 71, 69, 72, 76, 73]:

```
i=0 (73): stack=[0]
i=1 (74): 73<74 -> pop 0, ans[0]=1; push 1       stack=[1]
i=2 (75): 74<75 -> pop 1, ans[1]=1; push 2       stack=[2]
i=3 (71): 75>71 -> push 3                        stack=[2,3]
i=4 (69): 71>69 -> push 4                        stack=[2,3,4]
i=5 (72): 69<72 -> pop 4, ans[4]=1; 71<72 -> pop 3, ans[3]=2; push 5  stack=[2,5]
i=6 (76): 72<76 -> pop 5, ans[5]=1; 75<76 -> pop 2, ans[2]=4; push 6  stack=[6]
i=7 (73): 76>73 -> push 7                        stack=[6,7]
Answer: [1,1,4,2,1,1,0,0]
```

### Classic Problem 2: Largest Rectangle in Histogram (LeetCode 84)

Given bar heights, find the area of the largest rectangle in the histogram. This is the quintessential monotonic stack problem.

Key idea: for each bar, the largest rectangle using that bar's full height extends from the "previous smaller" index + 1 to the "next smaller" index - 1. We use an increasing stack to find both boundaries in one pass.

```java
class Solution {
    public int largestRectangleArea(int[] heights) {
        int n = heights.length;
        Deque<Integer> stack = new ArrayDeque<>(); // increasing stack of indices
        int maxArea = 0;

        for (int i = 0; i <= n; i++) {
            // sentinel: when i == n, height is 0, forcing all remaining pops
            int h = (i == n) ? 0 : heights[i];
            while (!stack.isEmpty() && heights[stack.peek()] > h) {
                int height = heights[stack.pop()];
                // width: from the element just below the popped (left boundary)
                // to i (right boundary, exclusive)
                int width = stack.isEmpty() ? i : i - stack.peek() - 1;
                maxArea = Math.max(maxArea, height * width);
            }
            stack.push(i);
        }
        return maxArea;
    }
}
```

ASCII walkthrough for heights = [2, 1, 5, 6, 2, 3]:

```
i=0 (h=2): stack empty -> push 0         Stack: [0]
i=1 (h=1): 2>1 -> pop 0, height=2, width=1, area=2; push 1  Stack: [1]
i=2 (h=5): 1<5 -> push 2                 Stack: [1,2]
i=3 (h=6): 5<6 -> push 3                 Stack: [1,2,3]
i=4 (h=2): 6>2 -> pop 3, height=6, width=1, area=6
           5>2 -> pop 2, height=5, width=2, area=10
           1<2 -> push 4                 Stack: [1,4]
i=5 (h=3): 2<3 -> push 5                 Stack: [1,4,5]
i=6 (h=0): 3>0 -> pop 5, height=3, width=1, area=3
           2>0 -> pop 4, height=2, width=4, area=8
           1>0 -> pop 1, height=1, width=6, area=6
Max area = 10
```

The rectangle of height 5 (bars at index 2 and 3) gives area 10 — the correct answer.

### Classic Problem 3: Online Stock Span (LeetCode 901)

Design a class that, for each day's price, returns the span: the maximum number of consecutive days (including today) where the price was <= today's price.

This is a "previous greater element" problem. We maintain a decreasing stack of (price, span). When a new price arrives, we pop all smaller-or-equal prices, accumulating their spans.

```java
class StockSpanner {
    Deque<int[]> stack; // [price, span]

    public StockSpanner() {
        stack = new ArrayDeque<>();
    }

    public int next(int price) {
        int span = 1;
        while (!stack.isEmpty() && stack.peek()[0] <= price) {
            span += stack.pop()[1];
        }
        stack.push(new int[]{price, span});
        return span;
    }
}
```

Why this works: when we pop a (price, span) pair, all the days it represented are also <= the current price, so we can absorb its entire span. The stack stays strictly decreasing by price.

---

## 3. Min Stack / Max Stack — Augmented Stack Design

### When to Use

When a problem requires a stack that also supports retrieving the minimum (or maximum) element in O(1). This appears in design questions and as a building block in more complex problems.

### Approach

Two common techniques:
1. **Auxiliary stack**: maintain a parallel stack that tracks the min/max at each level. Push the current min/max alongside every push; pop both together.
2. **Value encoding**: store the difference between the value and the current min in the main stack, recovering the min during pop. Saves space but is error-prone.

### Java Template (Auxiliary Stack)

```java
class MinStack {
    private Deque<Integer> stack;
    private Deque<Integer> minStack;

    public MinStack() {
        stack = new ArrayDeque<>();
        minStack = new ArrayDeque<>();
    }

    public void push(int val) {
        stack.push(val);
        if (minStack.isEmpty() || val <= minStack.peek()) {
            minStack.push(val);
        }
    }

    public void pop() {
        int val = stack.pop();
        if (val == minStack.peek()) {
            minStack.pop();
        }
    }

    public int top() {
        return stack.peek();
    }

    public int getMin() {
        return minStack.peek();
    }
}
```

Note: the `<=` in push is critical to handle duplicate minimums correctly.

### Classic Problem 1: Min Stack (LeetCode 155)

The template above is the full solution. Push, pop, top, and getMin all run in O(1).

ASCII showing the two stacks in sync:

```
Operation      main stack      min stack
push(5)        [5]             [5]
push(3)        [5, 3]          [5, 3]
push(7)        [5, 3, 7]       [5, 3]      <- 7 not pushed to min stack
push(3)        [5, 3, 7, 3]    [5, 3, 3]   <- duplicate min, pushed
pop() -> 3     [5, 3, 7]       [5, 3]
pop() -> 7     [5, 3]          [5, 3]
getMin() -> 3
pop() -> 3     [5]             [5]
getMin() -> 5
```

### Classic Problem 2: Max Stack (LeetCode 716)

Same idea but tracking the maximum. A harder variant asks for `popMax()` which removes the maximum element (not necessarily the top). This requires a doubly-linked list plus a sorted map, or a second stack.

Simpler version (push, pop, top, peekMax):

```java
class MaxStack {
    private Deque<Integer> stack;
    private Deque<Integer> maxStack;

    public MaxStack() {
        stack = new ArrayDeque<>();
        maxStack = new ArrayDeque<>();
    }

    public void push(int x) {
        stack.push(x);
        if (maxStack.isEmpty() || x >= maxStack.peek()) {
            maxStack.push(x);
        }
    }

    public int pop() {
        int x = stack.pop();
        if (x == maxStack.peek()) maxStack.pop();
        return x;
    }

    public int top() { return stack.peek(); }

    public int peekMax() { return maxStack.peek(); }
}
```

For `popMax()`: find the max, pop elements above it into a buffer, remove the max, then push the buffer back.

---

## 4. Balanced Parentheses

### When to Use

Whenever a problem involves matching, nesting, or validating paired delimiters: `()`, `[]`, `{}`, `<>`, or even custom open/close tokens.

### Approach

- Push opening brackets onto the stack.
- On a closing bracket, check that the stack top is the matching opening bracket; if not, invalid.
- At the end, the stack must be empty.

### Classic Problem 1: Valid Parentheses (LeetCode 20)

```java
class Solution {
    public boolean isValid(String s) {
        Deque<Character> stack = new ArrayDeque<>();
        for (char c : s.toCharArray()) {
            if (c == '(') stack.push(')');
            else if (c == '[') stack.push(']');
            else if (c == '{') stack.push('}');
            else { // closing bracket
                if (stack.isEmpty() || stack.pop() != c) return false;
            }
        }
        return stack.isEmpty();
    }
}
```

Trick: instead of storing the opening bracket, store the expected closing bracket. This makes the comparison trivial.

ASCII for input "{[()]}":

```
Char  '{' -> push '}'  Stack: [}]
Char  '[' -> push ']'  Stack: [}, ]]
Char  '(' -> push ')'  Stack: [}, ], )]
Char  ')' -> pop ')'   matches!  Stack: [}, ]]
Char  ']' -> pop ']'   matches!  Stack: [}]
Char  '}' -> pop '}'   matches!  Stack: []
Valid!
```

### Classic Problem 2: Minimum Add to Make Parentheses Valid (LeetCode 945)

Count unmatched open and close parentheses without a full stack:

```java
class Solution {
    public int minAddToMakeValid(String s) {
        int open = 0, additions = 0;
        for (char c : s.toCharArray()) {
            if (c == '(') open++;
            else {
                if (open > 0) open--;
                else additions++; // need an opening paren
            }
        }
        return additions + open; // open = unmatched, need closing parens
    }
}
```

### Classic Problem 3: Valid Parenthesis String (LeetCode 678)

String with '(', ')', '*' where '*' can be '(', ')', or empty. Use a range [lo, hi] of possible open-count:

```java
class Solution {
    public boolean checkValidString(String s) {
        int lo = 0, hi = 0;
        for (char c : s.toCharArray()) {
            if (c == '(') { lo++; hi++; }
            else if (c == ')') { lo = Math.max(0, lo - 1); hi--; }
            else { lo = Math.max(0, lo - 1); hi++; } // '*'
            if (hi < 0) return false;
        }
        return lo == 0;
    }
}
```

---

## 5. Evaluate Reverse Polish Notation

### When to Use

Postfix expression evaluation. Also applies to building/evaluating expression trees.

### Approach

Scan tokens left to right. Push operands. On an operator, pop the required number of operands, apply the operator, push the result.

### Classic Problem: Evaluate RPN (LeetCode 150)

```java
class Solution {
    public int evalRPN(String[] tokens) {
        Deque<Integer> stack = new ArrayDeque<>();
        for (String t : tokens) {
            switch (t) {
                case "+": stack.push(stack.pop() + stack.pop()); break;
                case "-": {
                    int b = stack.pop(), a = stack.pop();
                    stack.push(a - b); break;
                }
                case "*": stack.push(stack.pop() * stack.pop()); break;
                case "/": {
                    int b = stack.pop(), a = stack.pop();
                    stack.push(a / b); break;
                }
                default: stack.push(Integer.parseInt(t));
            }
        }
        return stack.pop();
    }
}
```

Critical: for non-commutative operators (- and /), pop order matters. The first pop is the right operand, the second pop is the left operand.

ASCII for ["2", "1", "+", "3", "*"]:

```
"2"  -> push 2          Stack: [2]
"1"  -> push 1          Stack: [2, 1]
"+"  -> pop 1, pop 2, push 3   Stack: [3]
"3"  -> push 3          Stack: [3, 3]
"*"  -> pop 3, pop 3, push 9   Stack: [9]
Result: 9   (which is (2+1)*3)
```

---

## 6. Basic Calculator — Infix Expression Evaluation

### When to Use

When evaluating expressions with parentheses, operator precedence, and possibly unary minus. This is a harder variant of RPN where you must handle precedence on the fly.

### Approach

Maintain two stacks: one for values, one for operators. Process the string character by character:
- Digit: accumulate the full number, push to value stack.
- '(': push to operator stack.
- ')': evaluate until '('.
- Operator: while the operator stack top has >= precedence, evaluate it first, then push.

For unary minus, track the sign context (after '(' or at start).

### Classic Problem 1: Basic Calculator II (LeetCode 227)

Handles +, -, *, / with precedence (no parentheses):

```java
class Solution {
    public int calculate(String s) {
        Deque<Integer> stack = new ArrayDeque<>();
        int num = 0;
        char op = '+';
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isDigit(c)) {
                num = num * 10 + (c - '0');
            }
            if (c == '+' || c == '-' || c == '*' || c == '/' || i == s.length() - 1) {
                switch (op) {
                    case '+': stack.push(num); break;
                    case '-': stack.push(-num); break;
                    case '*': stack.push(stack.pop() * num); break;
                    case '/': stack.push(stack.pop() / num); break;
                }
                op = c;
                num = 0;
            }
        }
        int result = 0;
        while (!stack.isEmpty()) result += stack.pop();
        return result;
    }
}
```

Insight: for * and /, we immediately compute (higher precedence). For + and -, we defer by pushing signed values, then sum at the end.

### Classic Problem 2: Basic Calculator (LeetCode 224)

Handles +, -, and parentheses with unary minus:

```java
class Solution {
    public int calculate(String s) {
        Deque<Integer> stack = new ArrayDeque<>();
        int result = 0, num = 0, sign = 1;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isDigit(c)) {
                num = num * 10 + (c - '0');
            } else if (c == '+') {
                result += sign * num;
                num = 0; sign = 1;
            } else if (c == '-') {
                result += sign * num;
                num = 0; sign = -1;
            } else if (c == '(') {
                stack.push(result);
                stack.push(sign);
                result = 0; sign = 1;
            } else if (c == ')') {
                result += sign * num;
                num = 0;
                result *= stack.pop(); // sign before '('
                result += stack.pop(); // result before '('
            }
        }
        result += sign * num;
        return result;
    }
}
```

The stack stores the accumulated result and sign before entering a parenthesis group, restoring them on ')'.

---

## 7. Sliding Window Maximum — Monotonic Deque

### When to Use

When you need the maximum (or minimum) in every sliding window of size k over an array. A deque stores candidate indices in decreasing order of value, so the front always holds the current window's max.

### Approach

Maintain a deque of indices such that their corresponding values are monotonically decreasing. For each new element:
1. Remove indices from the front that are outside the window (index <= i - k).
2. Remove indices from the back whose values are <= current (they can never be the max while current is in the window).
3. Push the current index to the back.
4. The front of the deque is the max for the current window.

### ASCII Diagram: Sliding Window Maximum

Array = [1, 3, -1, -3, 5, 3, 6, 7], k = 3

```
i=0 (1):   deque=[0(1)]                    window not full
i=1 (3):   1<=3 -> pop back 0; push 1       deque=[1(3)]
i=2 (-1):  -1<=3 ok; push 2                 deque=[1(3),2(-1)]  max=nums[1]=3  -> output 3
i=3 (-3):  1 in range? idx1>0 yes
           -3<=-1 pop back 2; -3<=3 push    deque=[1(3),3(-3)]  max=nums[1]=3  -> output 3
i=4 (5):   1 out of range (1 <= 4-3=1) -> pop front
           -3<=5 pop 3; 3<=5 pop 1; push 4  deque=[4(5)]        max=nums[4]=5  -> output 5
i=5 (3):   3<=5 ok; push 5                  deque=[4(5),5(3)]   max=nums[4]=5  -> output 5
i=6 (6):   3<=6 pop 5; 5<=6 pop 4; push 6   deque=[6(6)]        max=nums[6]=6  -> output 6
i=7 (7):   6<=7 pop 6; push 7               deque=[7(7)]        max=nums[7]=7  -> output 7

Output: [3, 3, 5, 5, 6, 7]
```

The deque front is always the index of the maximum in the current window. Elements behind it are "waiting in line" — they'll become the max once the larger elements leave the window.

### Java Template

```java
public int[] maxSlidingWindow(int[] nums, int k) {
    int n = nums.length;
    int[] result = new int[n - k + 1];
    Deque<Integer> deque = new ArrayDeque<>(); // indices, values decreasing

    for (int i = 0; i < n; i++) {
        // 1. Remove indices outside the window
        while (!deque.isEmpty() && deque.peekFirst() <= i - k) {
            deque.pollFirst();
        }
        // 2. Remove smaller elements from the back (they're useless now)
        while (!deque.isEmpty() && nums[deque.peekLast()] <= nums[i]) {
            deque.pollLast();
        }
        // 3. Add current index
        deque.offerLast(i);
        // 4. Record max once first window is complete
        if (i >= k - 1) {
            result[i - k + 1] = nums[deque.peekFirst()];
        }
    }
    return result;
}
```

Time: O(n) — each element added and removed from the deque at most once. Space: O(k).

### Classic Problem: Sliding Window Maximum (LeetCode 239)

The template above is the full solution.

### Variant: Sliding Window Minimum

Change `<=` to `>=` in step 2 to maintain an increasing deque (front holds the min).

### Variant: Sliding Window Median (LeetCode 480)

For median, a deque alone is not enough. Use two heaps (or a TreeSet/balanced BST) to track the window. This is harder and often solved with two `TreeMap`-based multisets or a sorted container.

---

## 8. Queue Using Stacks

### When to Use

A classic design problem testing understanding of amortized analysis. Implement a FIFO queue using only LIFO stack operations.

### Approach

Use two stacks: an `input` stack for push and an `output` stack for pop/peek. When pop/peek is called and `output` is empty, transfer all elements from `input` to `output` (which reverses their order, making the oldest element the new top).

### Amortized O(1)

Each element is moved from input to output exactly once. Over n operations, the total transfer cost is O(n), so amortized cost per operation is O(1).

### Classic Problem: Implement Queue Using Stacks (LeetCode 232)

```java
class MyQueue {
    private Deque<Integer> input;
    private Deque<Integer> output;

    public MyQueue() {
        input = new ArrayDeque<>();
        output = new ArrayDeque<>();
    }

    public void push(int x) {
        input.push(x);
    }

    public int pop() {
        peek();
        return output.pop();
    }

    public int peek() {
        if (output.isEmpty()) {
            while (!input.isEmpty()) {
                output.push(input.pop());
            }
        }
        return output.peek();
    }

    public boolean empty() {
        return input.isEmpty() && output.isEmpty();
    }
}
```

ASCII showing the transfer:

```
push(1), push(2), push(3):

  input stack        output stack
  [3] (top)
  [2]
  [1]
  ----               ---- (empty)

After peek() triggers transfer:

  input stack        output stack
  ----               [1] (top) <- now FIFO order
                     [2]
                     [3]

pop() -> 1 (oldest element, now on top of output)
pop() -> 2
pop() -> 3
```

### Inverse: Stack Using Queues (LeetCode 225)

Push: add to queue, then rotate all prior elements behind it (poll and re-offer n-1 times). This makes the new element the front.

```java
class MyStack {
    private Deque<Integer> queue;

    public MyStack() { queue = new ArrayDeque<>(); }

    public void push(int x) {
        queue.offer(x);
        for (int i = 0; i < queue.size() - 1; i++) {
            queue.offer(queue.poll());
        }
    }
    public int pop() { return queue.poll(); }
    public int top() { return queue.peek(); }
    public boolean empty() { return queue.isEmpty(); }
}
```

---

## 9. Valid Stack Sequences

### When to Use

When checking whether a target permutation could be the output of a stack given a specific input order. This models real-world scenarios like train shunting, function call validation, and push/pop sequence verification.

### Approach

Simulate the push sequence. Maintain a stack. For each value in `pushed`, push it, then pop as many as match the next expected value in `popped`. If at the end the stack is empty, the sequence is valid.

### Classic Problem: Validate Stack Sequences (LeetCode 946)

```java
class Solution {
    public boolean validateStackSequences(int[] pushed, int[] popped) {
        Deque<Integer> stack = new ArrayDeque<>();
        int popIndex = 0;
        for (int x : pushed) {
            stack.push(x);
            while (!stack.isEmpty() && stack.peek() == popped[popIndex]) {
                stack.pop();
                popIndex++;
            }
        }
        return stack.isEmpty();
    }
}
```

ASCII for pushed = [1,2,3,4,5], popped = [4,5,3,2,1]:

```
push 1: stack=[1],    top=1 != 4
push 2: stack=[1,2],  top=2 != 4
push 3: stack=[1,2,3], top=3 != 4
push 4: stack=[1,2,3,4], top=4 == 4 -> pop, popIdx=1
        stack=[1,2,3], top=3 != 5
push 5: stack=[1,2,3,5], top=5 == 5 -> pop, popIdx=2
        top=3 == 3 -> pop, popIdx=3
        top=2 == 2 -> pop, popIdx=4
        top=1 == 1 -> pop, popIdx=5
        stack empty -> true
```

Time: O(n), Space: O(n).

---

## 10. Asteroid Collision

### When to Use

When simulating interactions between elements moving in opposite directions, where collisions destroy smaller elements. The stack tracks surviving elements; a new right-moving asteroid may collide with left-moving ones on the stack.

### Approach

- Positive asteroid (moving right): push onto stack (could collide later).
- Negative asteroid (moving left): collide with positive asteroids on top of the stack.
  - If top is smaller, it explodes (pop); continue checking.
  - If equal, both explode (pop, don't push).
  - If top is larger, the new asteroid explodes (don't push).
  - If stack is empty or top is negative, the new asteroid survives (push).

### Classic Problem: Asteroid Collision (LeetCode 735)

```java
class Solution {
    public int[] asteroidCollision(int[] asteroids) {
        Deque<Integer> stack = new ArrayDeque<>();
        for (int a : asteroids) {
            if (a > 0) {
                stack.push(a);
            } else {
                // a < 0: collide with positives on top
                while (!stack.isEmpty() && stack.peek() > 0 && stack.peek() < -a) {
                    stack.pop();
                }
                if (stack.isEmpty() || stack.peek() < 0) {
                    stack.push(a);
                } else if (stack.peek() == -a) {
                    stack.pop(); // both explode
                }
                // else: top > -a, new asteroid explodes, do nothing
            }
        }
        int[] result = new int[stack.size()];
        for (int i = result.length - 1; i >= 0; i--) {
            result[i] = stack.pop();
        }
        return result;
    }
}
```

ASCII for asteroids = [5, 10, -5]:

```
  5  ->  10  -> -5  ->
 [5]   [5,10]      10 > 5? yes, 10 > 5, 5 explodes
                    10 vs 5: top(10) > 5 -> -5 explodes
                    Stack: [5, 10]  (wait, let me redo)

Actually: 5 > 5? No: stack.peek()=10, |a|=5, 10 > 5 so -5 explodes.
Result: [5, 10]
```

Corrected walkthrough for [5, 10, -5]:

```
a=5:   push 5              Stack: [5]
a=10:  push 10             Stack: [5, 10]
a=-5:  top=10 > 0 and 10 > 5 -> -5 explodes (don't push)
       Stack: [5, 10]
Result: [5, 10]
```

For [8, -8]: both explode -> []. For [10, 2, -5]: 2 explodes, then -5 vs 10: 10 > 5, -5 explodes -> [10].

Time: O(n), Space: O(n).

---

## 11. Nested Parsing & Stack-Based String Problems

### When to Use

When a string has nested structure — repeated groups, nested tags, or recursive patterns — and you need to track depth or expand/decode levels.

### Classic Problem: Decode String (LeetCode 394)

Input like "3[a2[c]]" -> "accaccacc". Use two stacks: one for repeat counts, one for the string built so far.

```java
class Solution {
    public String decodeString(String s) {
        Deque<Integer> countStack = new ArrayDeque<>();
        Deque<StringBuilder> strStack = new ArrayDeque<>();
        StringBuilder current = new StringBuilder();
        int k = 0;

        for (char c : s.toCharArray()) {
            if (Character.isDigit(c)) {
                k = k * 10 + (c - '0');
            } else if (c == '[') {
                countStack.push(k);
                strStack.push(current);
                current = new StringBuilder();
                k = 0;
            } else if (c == ']') {
                int repeat = countStack.pop();
                StringBuilder decoded = strStack.pop();
                for (int i = 0; i < repeat; i++) {
                    decoded.append(current);
                }
                current = decoded;
            } else {
                current.append(c);
            }
        }
        return current.toString();
    }
}
```

On '[': save the current string and repeat count, start fresh for the nested group. On ']': repeat the nested string and append to the parent.

---

## 12. Expression Parsing with Precedence (Advanced)

### Classic Problem: Basic Calculator III (LeetCode 772)

Combines +, -, *, /, parentheses, and unary minus. This unifies the patterns from sections 5 and 6.

```java
class Solution {
    int i = 0;
    public int calculate(String s) {
        Deque<Integer> stack = new ArrayDeque<>();
        int num = 0;
        char op = '+';
        while (i < s.length()) {
            char c = s.charAt(i++);
            if (Character.isDigit(c)) {
                num = num * 10 + (c - '0');
            } else if (c == '(') {
                num = calculate(s); // recurse on sub-expression
            } else if (c == ')') {
                break;
            } else if (c != ' ') {
                applyOp(stack, op, num);
                op = c;
                num = 0;
            }
        }
        applyOp(stack, op, num);
        int result = 0;
        while (!stack.isEmpty()) result += stack.pop();
        return result;
    }

    private void applyOp(Deque<Integer> stack, char op, int num) {
        switch (op) {
            case '+': stack.push(num); break;
            case '-': stack.push(-num); break;
            case '*': stack.push(stack.pop() * num); break;
            case '/': stack.push(stack.pop() / num); break;
        }
    }
}
```

The recursion on '(' naturally handles nested parentheses, and the deferred-evaluation pattern handles precedence.

---

## Pattern Reference Table

| Pattern | When to Use | Key Data Structure | Time | Classic Problems |
|---|---|---|---|---|
| Monotonic Stack (Decreasing) | Next greater element, stock span, daily temperatures | Deque (decreasing by value) | O(n) | LC 739, 901, 496, 503 |
| Monotonic Stack (Increasing) | Next smaller element, largest rectangle in histogram | Deque (increasing by value) | O(n) | LC 84, 42, 85 |
| Min/Max Stack | O(1) min/max retrieval on a stack | Main stack + auxiliary stack | O(1) per op | LC 155, 716 |
| Balanced Parentheses | Matching/nesting validation | Stack of expected closers | O(n) | LC 20, 945, 678, 2116 |
| RPN Evaluation | Postfix expression evaluation | Operand stack | O(n) | LC 150, 1444 |
| Infix Calculator | Expression with precedence and parens | Value stack + operator stack | O(n) | LC 224, 227, 772 |
| Monotonic Deque (Sliding Max) | Max/min in sliding window | Deque of indices (decreasing) | O(n) | LC 239, 862 |
| Queue from Stacks | Amortized O(1) queue from stacks | Two stacks (input + output) | Amortized O(1) | LC 232, 225 |
| Valid Stack Sequences | Validate push/pop permutation | Simulation stack | O(n) | LC 946, 1003 |
| Asteroid Collision | Opposite-direction collision simulation | Stack of survivors | O(n) | LC 735 |
| Nested String Decoding | Recursive string expansion | Count stack + string stack | O(n) | LC 394, 856 |
| Two-Stack Expression | Full arithmetic with precedence | Two stacks + recursion | O(n) | LC 224, 772, 1087 |

---

## Quick-Reference: Monotonic Stack Variants

| Goal | Stack Order | Comparison | What You Store |
|---|---|---|---|
| Next greater | Decreasing | pop while top < current | Indices |
| Next smaller | Increasing | pop while top > current | Indices |
| Previous greater | Decreasing | check before push | Indices |
| Previous smaller | Increasing | check before push | Indices |
| Largest rectangle | Increasing | pop while top > current (sentinel 0 at end) | Indices |
| Stock span | Decreasing | pop while top <= current | (price, span) pairs |

---

## Quick-Reference: Common Mistakes

- **Duplicate handling in min stack**: use `<=` not `<` when deciding whether to push to the min stack, or duplicate minimums will break.
- **RPN operand order**: for `-` and `/`, the first pop is the right operand. Always do `a - b` where `b = pop()` first, `a = pop()` second.
- **Sliding window deque index check**: compare `deque.peekFirst() <= i - k` (use `<=` not `<`) to remove out-of-window indices.
- **Histogram sentinel**: append a 0 (or use `i == n` as a virtual 0-height bar) to force popping all remaining bars at the end.
- **Asteroid equal size**: when `|a| == top`, both explode — don't forget to pop AND skip pushing.
- **ArrayDeque vs Stack**: prefer `Deque<Integer> stack = new ArrayDeque<>()` over `Stack<Integer>`. The legacy `Stack` is synchronized and slower.
- **Empty stack checks**: always guard `peek()`/`pop()` with `isEmpty()` to avoid exceptions.

---

## Interview Strategy Checklist

1. **Identify the pattern**: Does the problem ask for "next/previous greater/smaller"? -> Monotonic stack. Sliding extremum? -> Monotonic deque. Matching/nesting? -> Parentheses stack. Expression evaluation? -> Calculator pattern.
2. **Choose stack order**: For "next greater", use a decreasing stack. For "next smaller", increasing. Store indices (not values) when you need position info.
3. **Handle boundaries**: Use sentinels (virtual elements at start/end) to simplify edge cases, especially in histogram problems.
4. **Verify with a small example**: Trace through 5-6 elements to confirm the stack invariant holds.
5. **Check for circular or wrapped arrays**: For "next greater element II" (circular array), iterate `2n` times and use `i % n`.
6. **Consider space**: Most stack solutions use O(n) space. Can you reduce to O(1) with running variables (e.g., parentheses counting)?

---

## Extended Problem Set by Pattern

### Monotonic Stack
- LeetCode 496: Next Greater Element I
- LeetCode 503: Next Greater Element II (circular)
- LeetCode 739: Daily Temperatures
- LeetCode 901: Online Stock Span
- LeetCode 84: Largest Rectangle in Histogram
- LeetCode 85: Maximal Rectangle (histogram per row)
- LeetCode 42: Trapping Rain Water (two-pointer or stack)
- LeetCode 402: Remove K Digits (increasing stack)
- LeetCode 316: Remove Duplicate Letters (stack + last-occurrence)
- LeetCode 1081: Smallest Subsequence of Distinct Characters

### Parentheses / Matching
- LeetCode 20: Valid Parentheses
- LeetCode 22: Generate Parentheses (backtracking)
- LeetCode 32: Longest Valid Parentheses
- LeetCode 945: Minimum Add to Make Parentheses Valid
- LeetCode 678: Valid Parenthesis String
- LeetCode 2116: Check if a Parentheses String Can Be Valid

### Calculator / Expression
- LeetCode 150: Evaluate Reverse Polish Notation
- LeetCode 224: Basic Calculator
- LeetCode 227: Basic Calculator II
- LeetCode 772: Basic Calculator III
- LeetCode 394: Decode String

### Design
- LeetCode 155: Min Stack
- LeetCode 716: Max Stack
- LeetCode 232: Implement Queue Using Stacks
- LeetCode 225: Implement Stack Using Queues
- LeetCode 1381: Design a Stack With Increment Operation

### Simulation / Deque
- LeetCode 239: Sliding Window Maximum
- LeetCode 862: Shortest Subarray with Sum at Least K (deque + prefix sum)
- LeetCode 946: Validate Stack Sequences
- LeetCode 735: Asteroid Collision
- LeetCode 1047: Remove All Adjacent Duplicates In String

---

This covers the core stack and queue patterns you'll encounter in interviews. The monotonic stack and monotonic deque are the highest-leverage patterns — master those first, as they appear in the most "surprising" contexts and are often the difference between an O(n^2) brute force and an O(n) optimal solution.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Stack (LIFO): push/pop/peek all O(1). Use for: balanced parentheses, eval expressions, DFS, monotonic stack (next greater element).
- Queue (FIFO): enqueue/dequeue O(1). Use for: BFS, level-order traversal, scheduling.
- Monotonic stack: maintain stack in increasing/decreasing order — used for next greater/smaller element, largest rectangle in histogram.
- Deque: double-ended queue, O(1) at both ends — used for sliding window maximum.
- Prefer `Deque<Integer> stack = new ArrayDeque<>()` over the legacy synchronized `Stack` class.

**Common Follow-Up Questions:**
- "How do you implement a stack using queues?" — Two queues: push to q1, pop by transferring all but last element to q2, pop the last. O(n) pop, O(1) push (or vice versa with one-queue approach).
- "What's a monotonic stack?" — A stack where elements are maintained in sorted order. When pushing, pop all elements that violate the order. Used for O(n) "next greater element" problems.

**Gotcha:** Using a stack when a queue is needed (or vice versa). BFS uses a QUEUE (FIFO — explore level by level). DFS uses a STACK (LIFO — explore deeply first). Mixing them up changes the traversal order and gives wrong results.