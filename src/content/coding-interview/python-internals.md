---
title: "Python Internals & Interview Prep"
category: "Coding Interview Prep"
language: "Python"
difficulty: "Intermediate to Advanced"
tags: [python, internals, interview, memory-model, gil, collections, generators, decorators]
last_updated: "2026-06-19"
---

# Python Internals & Interview Prep

## Summary & Interview Framing

Deep Python knowledge — how dict works (hash table), the GIL, `is` vs `==`, memory model, and language-specific gotchas.

**How it's asked:** "How does a Python dict work internally? What is the GIL? Why is `is` different from `==`? — questions testing language depth, not just usage."

---

## Overview

This document covers Python-specific internals, idioms, and details that matter for coding interviews and systems discussions. If you're primarily a Java engineer who also writes Python (or needs to switch languages for an interview), this is your cheat sheet for the things that differ from Java — and the things interviewers love to probe.

---

## Python Memory Model

### Everything Is an Object

In Python, everything — integers, functions, classes, `None`, `True` — is an object with a type, a reference count, and a value. There are no primitives. The number `5` is a full object with a `__class__`, `__add__`, `__repr__`, and an identity (`id()`).

```
┌──────────────────────────────────────────┐
│  Python Object Header (CPython)          │
├──────────────────────────────────────────┤
│  ob_refcnt   → reference count (8 bytes) │
│  ob_type     → pointer to type object    │
│  ob_size     → variable-length items     │
│  [object-specific data follows]          │
└──────────────────────────────────────────┘
```

This has implications:

- **Small integers are cached**: CPython pre-creates integer objects for -5 to 256. So `a = 100; b = 100; a is b` returns `True`, but `a = 300; b = 300; a is b` returns `False` (they're separate objects). This is a common interview trick.
- **Strings are interned**: Short strings and compile-time constants may share the same object. `a = "hello"; b = "hello"; a is b` is usually `True` due to string interning, but dynamically constructed strings may not be.
- `id()` returns the memory address (in CPython). Use `is` to compare identity, `==` to compare value.

```python
a = 1000
b = 1000
print(a is b)      # False — different objects (outside cached range)
print(a == b)      # True  — same value

# But in the same line, CPython optimizes:
c = 1000; d = 1000
print(c is d)      # True — compile-time constant folding
```

### Reference Counting & Garbage Collection

Python uses **reference counting** as its primary memory management, supplemented by a **cyclic garbage collector** for detecting reference cycles.

- Every object has a `ob_refcnt` field. When it drops to zero, the object is immediately deallocated.
- Reference cycles (e.g., `a.b = b; b.a = a`) can't be caught by refcounting alone. The cyclic GC periodically scans for these.
- `sys.getrefcount(obj)` shows the reference count (note: it's always +1 because the function argument itself is a reference).

```python
import sys, gc

# Reference cycle
class Node:
    def __init__(self):
        self.ref = None

a = Node()
b = Node()
a.ref = b      # a → b
b.ref = a      # b → a (cycle!)

del a
del b
# Neither was freed because refcount of each is still 1 (they reference each other)
# The cyclic GC will eventually collect them
gc.collect()   # Force collection
```

| Mechanism | What it catches | What it misses |
|-----------|----------------|----------------|
| Reference counting | Non-cyclic objects (immediate) | Reference cycles |
| Cyclic GC (generation 0/1/2) | Reference cycles | Non-Python objects (C extensions) |
| `__del__` | Finalization hook | Order of `__del__` calls in cycles is undefined |

### Mutable vs Immutable

This is one of the most common Python interview topics.

| Type | Mutable? | Example |
|------|----------|---------|
| int, float, bool, complex | Immutable | `x = 5; x += 1` creates a new int |
| str | Immutable | `s = "hi"; s += "!"` creates a new string |
| tuple | Immutable | `t = (1, 2); t[0] = 3` → TypeError |
| frozenset | Immutable | `fs = frozenset([1,2])` |
| list | Mutable | `l = [1]; l.append(2)` modifies in place |
| dict | Mutable | `d = {}; d['k'] = 'v'` |
| set | Mutable | `s = set(); s.add(1)` |
| bytearray | Mutable | `ba = bytearray(b'hi'); ba[0] = 72` |

**The trap with mutable default arguments** — this is the #1 Python interview question:

```python
# BUG: mutable default argument
def add_item(item, lst=[]):
    lst.append(item)
    return lst

print(add_item(1))  # [1]
print(add_item(2))  # [1, 2] — NOT [2]! The default list is shared across calls

# FIX: use None as sentinel
def add_item(item, lst=None):
    if lst is None:
        lst = []
    lst.append(item)
    return lst
```

This happens because default argument values are evaluated **once** at function definition time, not each time the function is called. The same list object persists across all calls that use the default.

**Immutable doesn't mean its contents are immutable** — a tuple containing a list:

```python
t = ([1, 2], [3, 4])
t[0].append(3)     # Works! The tuple still points to the same list object
t[0] = [99]        # TypeError — can't reassign tuple element
```

---

## How Python Data Structures Work Internally

### Lists — Dynamic Arrays

Python lists are dynamic arrays of **pointers** to PyObject, not arrays of the values themselves. This means:

- A list of 5 integers stores 5 pointers (8 bytes each on 64-bit) + the int objects themselves
- Appending is amortized O(1) — the list over-allocates. When it runs out of space, it grows by ~12.5% (new_size = old_size + (old_size >> 3) + 6)
- Random access by index is O(1)
- Insert at front is O(n) — all pointers must shift

```
list = [42, "hello", 3.14]

Memory layout:
┌──────────┬──────────┬──────────┐
│ ptr ───► │ ptr ───► │ ptr ───► │  (pointer array, over-allocated)
└──────────┴──────────┴──────────┘
     │          │          │
     ▼          ▼          ▼
  [int 42]  [str "hello"] [float 3.14]  (separate heap objects)
```

**Growth pattern**: `[], [4], [8], [16], [25], [35], [46], [58]...` — not doubling, but adding a percentage. This means list append is amortized O(1) but with more reallocations than a doubling strategy.

### Dictionaries — Hash Tables with Open Addressing

Since Python 3.6, dictionaries are **ordered** (insertion order preserved) and use a compact hash table implementation. Before 3.6, dicts were unordered and used more memory.

**How it works internally:**

1. Python uses **open addressing** (not chaining) for collision resolution
2. The dict maintains two arrays:
   - A **sparse array** of indices (hash → slot mapping)
   - A **dense array** of entries (key, value pairs in insertion order)

```
┌─────────────────────────────┐
│  Indices Array (sparse)      │  ← hash mod size → slot
│  [_, 0, _, _, 1, _, 2, _]   │  ← points into entries array
└─────────────────────────────┘
           │         │    │
           ▼         ▼    ▼
┌─────────────────────────────┐
│  Entries Array (dense)       │
│  0: (hash_a, key_a, val_a)  │
│  1: (hash_b, key_b, val_b)  │  ← insertion order preserved
│  2: (hash_c, key_c, val_c)  │
└─────────────────────────────┘
```

**Key details for interviews:**

- Dict lookup is average O(1), worst case O(n) (with many hash collisions)
- Dict keys must be **hashable** — they need `__hash__()` and `__eq__()`. Mutable types (list, dict, set) are unhashable. Tuples are hashable if all their elements are hashable.
- A frozenset can be a dict key; a set cannot.
- Dict resizing happens when it's ~2/3 full. It roughly doubles.
- Python 3.7+ guarantees insertion order as a language feature (3.6 was an implementation detail of CPython).

```python
# Hashability check
hash([1, 2])       # TypeError: unhashable type: 'list'
hash((1, 2))       # Works — tuples of hashables are hashable
hash((1, [2, 3]))  # TypeError — tuple contains unhashable list
```

### Sets — Dicts Without Values

Sets are implemented exactly like dicts but without the value entries. Same hash table, same O(1) average lookup, same open addressing. This is why:

- `x in my_set` is O(1) average
- `x in my_list` is O(n) — linear scan
- Sets don't preserve insertion order (well, they do in CPython 3.7+ but it's not guaranteed)

### Tuples — Fixed-Size Pointer Arrays

Tuples are immutable arrays of pointers. Unlike lists, they don't over-allocate — they're exactly the right size. This makes them slightly more memory-efficient than lists for fixed collections.

**Tuple caching**: CPython caches empty tuples and some small tuples. `()` always returns the same object. Tuples of small integers may also be cached.

```python
a = (1, 2)
b = (1, 2)
a is b    # May be True (cached) or False — implementation detail
```

### Strings — Immutable Arrays of Unicode

Python 3 strings are sequences of Unicode code points. Internally, CPython uses one of three representations depending on the content:

| Representation | When used | Memory per char |
|----------------|-----------|-----------------|
| 1-byte (Latin-1) | All chars ≤ U+00FF | 1 byte |
| 2-byte (UCS-2) | All chars ≤ U+FFFF | 2 bytes |
| 4-byte (UCS-4) | Any char > U+FFFF | 4 bytes |

This is why `len("a") == 1` but `len("🎉") == 1` (it's a single code point), while `len("👨‍👩‍👧")` might be more than 1 (it's composed of multiple code points joined by ZWJ).

**String immutability implications:**
- `s += "x"` creates a new string every time. In a loop, this is O(n²).
- Use `"".join(parts)` instead of repeated concatenation.
- CPython sometimes optimizes `s += "x"` in-place when the refcount is 1, but don't rely on it.

```python
# BAD — O(n²)
s = ""
for word in words:
    s += word + " "

# GOOD — O(n)
s = " ".join(words)
```

---

## The GIL (Global Interpreter Lock)

The GIL is a mutex that allows only one thread to execute Python bytecode at a time. It's the single most important thing to understand about Python concurrency.

**Why it exists:** CPython's memory management (reference counting) is not thread-safe. Rather than using fine-grained locks on every object, Python uses a single global lock. The GIL is released periodically (every 100 bytecode instructions by default, or on I/O operations) to allow other threads to run.

**What this means:**

| Scenario                  | GIL impact                       | Solution                                                    |
| ------------------------- | -------------------------------- | ----------------------------------------------------------- |
| CPU-bound threading       | No speedup (serialized)          | Use `multiprocessing` or C extensions                       |
| I/O-bound threading       | Works fine (GIL released on I/O) | `threading` or `asyncio`                                    |
| C extension (NumPy, etc.) | Can release GIL manually         | Use libraries that release GIL                              |
| Multi-core utilization    | Impossible with threads          | `multiprocessing`, `concurrent.futures.ProcessPoolExecutor` |

```python
import threading
import time

# CPU-bound work — threading gives NO speedup due to GIL
def count_down(n):
    while n > 0:
        n -= 1

# This will take ~2x as long as single-threaded, not 1x
t1 = threading.Thread(target=count_down, args=(10**8,))
t2 = threading.Thread(target=count_down, args=(10**8,))
t1.start(); t2.start()
t1.join(); t2.join()

# Use multiprocessing instead for CPU-bound work
from multiprocessing import Process
p1 = Process(target=count_down, args=(10**8,))
p2 = Process(target=count_down, args=(10**8,))
p1.start(); p2.start()
p1.join(); p2.join()
# This will actually be ~2x faster (true parallelism)
```

**The `GIL` is per-interpreter, not per-process.** Each Python process has its own GIL. This is why multiprocessing works — each process has its own interpreter and GIL.

---

## Collections Module — Interview Power Tools

The `collections` module is your best friend in Python interviews. Know these cold:

### defaultdict

```python
from collections import defaultdict

# Group words by first letter
words = ["apple", "banana", "avocado", "blueberry", "cherry"]
groups = defaultdict(list)
for w in words:
    groups[w[0]].append(w)
# {'a': ['apple', 'avocado'], 'b': ['banana', 'blueberry'], 'c': ['cherry']}

# Counter pattern without defaultdict
count = {}
for w in words:
    count[w[0]] = count.get(w[0], 0) + 1  # More verbose

# With defaultdict
count = defaultdict(int)
for w in words:
    count[w[0]] += 1  # Cleaner
```

### Counter

```python
from collections import Counter

# Frequency counting
c = Counter("abracadabra")
# Counter({'a': 5, 'b': 2, 'r': 2, 'c': 1, 'd': 1})

c.most_common(2)  # [('a', 5), ('b', 2)]
c['z']            # 0 (missing keys return 0, not KeyError)

# Set operations on counters
c1 = Counter(a=3, b=1)
c2 = Counter(a=1, b=2)
c1 + c2  # Counter({'a': 4, 'b': 3}) — addition
c1 - c2  # Counter({'a': 2}) — subtraction (min 0, drops negatives)
c1 & c2  # Counter({'a': 1, 'b': 1}) — intersection (min)
c1 | c2  # Counter({'a': 3, 'b': 2}) — union (max)
```

### deque

```python
from collections import deque

# O(1) append/pop from both ends
d = deque([1, 2, 3])
d.appendleft(0)    # deque([0, 1, 2, 3])
d.append(4)        # deque([0, 1, 2, 3, 4])
d.popleft()        # 0, deque([1, 2, 3, 4])
d.pop()            # 4, deque([1, 2, 3])

# Sliding window
d = deque(maxlen=3)
for i in range(5):
    d.append(i)    # After 0,1,2,3,4: deque([2, 3, 4], maxlen=3)

# BFS queue — use deque, NOT list
queue = deque([start])
while queue:
    node = queue.popleft()  # O(1) — list.pop(0) is O(n)!
    for neighbor in graph[node]:
        queue.append(neighbor)
```

### OrderedDict (Less Relevant Now)

Since Python 3.7, regular `dict` preserves insertion order. `OrderedDict` is now mainly useful for:
- `move_to_end(key)` and `popitem(last=False)` — useful for LRU cache implementation
- Explicit ordering on older Python versions

```python
from collections import OrderedDict

class LRUCache:
    def __init__(self, capacity):
        self.cache = OrderedDict()
        self.capacity = capacity

    def get(self, key):
        if key not in self.cache:
            return -1
        self.cache.move_to_end(key)  # Mark as recently used
        return self.cache[key]

    def put(self, key, value):
        if key in self.cache:
            self.cache.move_to_end(key)
        self.cache[key] = value
        if len(self.cache) > self.capacity:
            self.cache.popitem(last=False)  # Remove LRU item
```

### namedtuple

```python
from collections import namedtuple

Point = namedtuple('Point', ['x', 'y'])
p = Point(3, 4)
p.x          # 3
p.y          # 4
p[0]         # 3 (also indexable)
x, y = p     # Unpacking works

# Lighter than a class, more readable than a tuple
# Useful for returning multiple values with names
```

### heapq — Min-Heap

```python
import heapq

# Python's heapq is a min-heap. For max-heap, negate values.
nums = [3, 1, 4, 1, 5, 9, 2, 6]
heapq.heapify(nums)  # O(n) in-place heapify
heapq.heappop(nums)  # 1 (smallest)
heapq.heappush(nums, 0)  # Add element

# K largest elements
heapq.nlargest(3, nums)  # [9, 6, 5]
# K smallest elements
heapq.nsmallest(3, nums)  # [0, 1, 1]

# Max-heap pattern (negate values)
max_heap = []
heapq.heappush(max_heap, -5)
heapq.heappush(max_heap, -3)
largest = -heapq.heappop(max_heap)  # 5

# Merge K sorted lists
heapq.merge([1,3,5], [2,4,6], [0,7,8])  # Iterator: 0,1,2,3,4,5,6,7,8
```

### bisect — Binary Search

```python
import bisect

# bisect maintains a sorted list with O(log n) insert
sorted_list = [1, 3, 5, 7, 9]
bisect.insort(sorted_list, 4)  # [1, 3, 4, 5, 7, 9]
bisect.bisect_left(sorted_list, 5)  # 3 (leftmost position for 5)
bisect.bisect_right(sorted_list, 5)  # 4 (rightmost position for 5)

# Binary search template using bisect
def binary_search(arr, target):
    idx = bisect.bisect_left(arr, target)
    if idx < len(arr) and arr[idx] == target:
        return idx
    return -1
```

---

## Iterators, Generators, and Comprehensions

### The Iterator Protocol

Python's for loop works via the iterator protocol — `__iter__()` returns an iterator, `__next__()` returns the next element or raises `StopIteration`.

```
┌──────────┐     __iter__()     ┌──────────┐     __next__()     ┌──────────────┐
│ Iterable │  ──────────────►  │ Iterator │  ──────────────►  │  next value  │
│ (list,   │                   │ (has     │                   │  or          │
│  dict,   │                   │  state)  │                   │  StopIter-   │
│  str...) │                   │          │                   │  ation       │
└──────────┘                   └──────────┘                   └──────────────┘
```

```python
# Custom iterator
class Range:
    def __init__(self, start, end):
        self.current = start
        self.end = end

    def __iter__(self):
        return self

    def __next__(self):
        if self.current >= self.end:
            raise StopIteration
        val = self.current
        self.current += 1
        return val

for i in Range(0, 3):
    print(i)  # 0, 1, 2
```

### Generators — Lazy Evaluation

Generators are iterators that yield values one at a time, suspending and resuming execution. They're memory-efficient because they don't compute all values upfront.

```python
# Generator function (uses yield)
def fibonacci():
    a, b = 0, 1
    while True:
        yield a
        a, b = b, a + b

fib = fibonacci()
next(fib)  # 0
next(fib)  # 1
next(fib)  # 1
next(fib)  # 2
# Infinite sequence — no memory issue because it's lazy

# Generator expression (like list comprehension but lazy)
squares = (x**2 for x in range(10))  # Generator — O(1) memory
squares_list = [x**2 for x in range(10)]  # List — O(n) memory

# Use generators for streaming/large data
def read_large_file(path):
    with open(path) as f:
        for line in f:
            yield line.strip()  # One line at a time, not all in memory
```

**Key differences:**

| Feature | List comprehension | Generator expression |
|---------|-------------------|---------------------|
| Syntax | `[x for x in ...]` | `(x for x in ...)` |
| Memory | O(n) — all in memory | O(1) — one at a time |
| Reusable | Yes — iterate multiple times | No — single use |
| Indexing | Yes — `lst[0]` | No |
| `len()` | Yes | No |

### Comprehensions

```python
# List comprehension
squares = [x**2 for x in range(10)]
evens = [x for x in range(20) if x % 2 == 0]
pairs = [(x, y) for x in range(3) for y in range(3) if x != y]

# Dict comprehension
word_len = {w: len(w) for w in ["hello", "world", "python"]}
# {'hello': 5, 'world': 5, 'python': 6}

# Set comprehension
unique_lens = {len(w) for w in ["hello", "world", "python"]}
# {5, 6}

# Nested comprehension (read inside-out)
matrix = [[i * 3 + j for j in range(3)] for i in range(3)]
# [[0,1,2], [3,4,5], [6,7,8]]

# Flattening
flat = [x for row in matrix for x in row]
# [0,1,2,3,4,5,6,7,8]
```

---

## Decorators

Decorators are functions that wrap other functions to add behavior. They're syntactic sugar for higher-order functions.

```python
# Basic decorator
def timer(func):
    import time
    def wrapper(*args, **kwargs):
        start = time.time()
        result = func(*args, **kwargs)
        print(f"{func.__name__} took {time.time() - start:.4f}s")
        return result
    return wrapper

@timer
def slow_function():
    import time
    time.sleep(1)

# @timer is equivalent to: slow_function = timer(slow_function)
```

### Decorator with Arguments

```python
def repeat(n):
    def decorator(func):
        def wrapper(*args, **kwargs):
            for _ in range(n):
                result = func(*args, **kwargs)
            return result
        return wrapper
    return decorator

@repeat(3)  # Call the function 3 times
def greet(name):
    print(f"Hello, {name}")
```

### Class Decorator

```python
def singleton(cls):
    instances = {}
    def get_instance(*args, **kwargs):
        if cls not in instances:
            instances[cls] = cls(*args, **kwargs)
        return instances[cls]
    return get_instance

@singleton
class Database:
    def __init__(self):
        print("Connecting to DB...")
```

### functools.wraps — Preserve Metadata

```python
from functools import wraps

def my_decorator(func):
    @wraps(func)  # Preserves __name__, __doc__, etc.
    def wrapper(*args, **kwargs):
        return func(*args, **kwargs)
    return wrapper

# Without @wraps, wrapper.__name__ would be "wrapper"
# With @wraps, wrapper.__name__ is the original function's name
```

---

## Context Managers

Context managers handle setup and teardown (resource management) using the `with` statement.

```python
# Using built-in context managers
with open("file.txt") as f:
    data = f.read()
# File is automatically closed, even if an exception occurs

# Custom context manager (class-based)
class Timer:
    def __enter__(self):
        import time
        self.start = time.time()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        import time
        print(f"Elapsed: {time.time() - self.start:.4f}s")
        return False  # Don't suppress exceptions

with Timer():
    sum(range(10**6))

# Custom context manager (decorator-based, simpler)
from contextlib import contextmanager

@contextmanager
def open_file(path):
    f = open(path)
    try:
        yield f
    finally:
        f.close()

with open_file("file.txt") as f:
    data = f.read()
```

---

## *args, **kwargs, and Function Arguments

```python
def func(positional, /, default=10, *args, keyword_only, **kwargs):
    """
    Argument passing order:
    1. positional-only (before /)
    2. regular positional
    3. default values
    4. *args (variadic positional)
    5. keyword-only (after *args)
    6. **kwargs (variadic keyword)
    """
    pass

# Unpacking
def add(a, b, c):
    return a + b + c

nums = [1, 2, 3]
add(*nums)       # Unpack list as positional args → add(1, 2, 3)

config = {'a': 1, 'b': 2, 'c': 3}
add(**config)    # Unpack dict as keyword args → add(a=1, b=2, c=3)

# Extended unpacking (Python 3)
first, *rest = [1, 2, 3, 4, 5]    # first=1, rest=[2,3,4,5]
*init, last = [1, 2, 3, 4, 5]    # init=[1,2,3,4], last=5
first, *mid, last = [1, 2, 3, 4] # first=1, mid=[2,3], last=4
```

---

## Classes and OOP in Python

### Class Internals

```python
class Animal:
    # Class variable — shared across all instances
    species_count = 0

    def __init__(self, name):
        # Instance variable — unique per instance
        self.name = name
        Animal.species_count += 1

    # Instance method — takes self
    def speak(self):
        raise NotImplementedError

    # Class method — takes cls
    @classmethod
    def get_count(cls):
        return cls.species_count

    # Static method — takes neither self nor cls
    @staticmethod
    def is_valid_name(name):
        return len(name) > 0

    # __repr__ — official string representation
    def __repr__(self):
        return f"Animal(name={self.name!r})"

    # __str__ — user-friendly string (falls back to __repr__)
    def __str__(self):
        return f"Animal: {self.name}"
```

### __new__ vs __init__

`__new__` creates the instance. `__init__` initializes it. You almost never need `__new__` except for:
- Immutable types (str, int, tuple) — you can't modify them in `__init__`
- Singleton pattern
- Metaclass customization

```python
class Singleton:
    _instance = None

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

a = Singleton()
b = Singleton()
a is b  # True
```

### Method Resolution Order (MRO)

Python uses C3 linearization for multiple inheritance. Check with `ClassName.__mro__` or `ClassName.mro()`.

```python
class A:
    def hello(self): print("A")

class B(A):
    def hello(self): print("B")

class C(A):
    def hello(self): print("C")

class D(B, C):
    pass

D().hello()  # "B" — left-first depth-first
print(D.__mro__)
# (D, B, C, A, object)
```

### Dunder Methods Cheat Sheet

| Method                 | Purpose                 | Example use                |
| ---------------------- | ----------------------- | -------------------------- |
| `__init__`             | Initialize instance     | `obj = Class(args)`        |
| `__repr__`             | Official representation | `repr(obj)`, debugging     |
| `__str__`              | String representation   | `str(obj)`, `print(obj)`   |
| `__eq__`               | Equality                | `obj == other`             |
| `__hash__`             | Hashing                 | `hash(obj)`, dict/set keys |
| `__lt__`, `__gt__`     | Comparison              | `sorted([obj1, obj2])`     |
| `__len__`              | Length                  | `len(obj)`                 |
| `__getitem__`          | Index access            | `obj[key]`                 |
| `__setitem__`          | Index assignment        | `obj[key] = val`           |
| `__contains__`         | Membership              | `x in obj`                 |
| `__iter__`             | Iteration               | `for x in obj`             |
| `__next__`             | Next element            | `next(obj)`                |
| `__call__`             | Callable                | `obj(args)`                |
| `__enter__`/`__exit__` | Context manager         | `with obj as x:`           |
| `__add__`              | Addition                | `obj + other`              |

---

## Common Python Interview Questions

### Q1: What's the difference between `is` and `==`?

`is` compares identity (same object in memory). `==` compares value (calls `__eq__`). Use `is` for `None`, `True`, `False` comparisons. Use `==` for value comparisons.

```python
a = [1, 2, 3]
b = [1, 2, 3]
a == b   # True — same values
a is b   # False — different objects

a = None
a is None  # True — always use `is` for None, never `== None`
```

### Q2: What's the difference between `deepcopy` and `copy`?

`copy.copy()` creates a shallow copy — new container, same element references. `copy.deepcopy()` recursively copies all elements.

```python
import copy

original = [[1, 2], [3, 4]]

shallow = copy.copy(original)
shallow[0][0] = 99
print(original)  # [[99, 2], [3, 4]] — inner list is shared!

deep = copy.deepcopy(original)
deep[0][0] = 0
print(original)  # [[99, 2], [3, 4]] — fully independent
```

### Q3: Explain `*args` and `**kwargs`

`*args` collects extra positional arguments as a tuple. `**kwargs` collects extra keyword arguments as a dict. They allow flexible function signatures.

### Q4: What are decorators and how do they work?

A decorator is a function that takes another function and extends its behavior without modifying it. `@decorator` above a function definition is sugar for `func = decorator(func)`. Decorators can take arguments using nested functions.

### Q5: How does Python's garbage collection work?

Primary mechanism is reference counting — each object has a refcount, and when it reaches zero, the object is immediately freed. This misses reference cycles, so a supplemental cyclic garbage collector scans generations (0, 1, 2) periodically to detect and collect cycles.

### Q6: What's the GIL and why does it matter?

The Global Interpreter Lock ensures only one thread executes Python bytecode at a time. It exists because CPython's reference counting isn't thread-safe. It means threading doesn't speed up CPU-bound work (use multiprocessing instead), but works fine for I/O-bound work.

### Q7: What's the difference between a list and a tuple?

Lists are mutable, tuples are immutable. Lists have append/extend/remove methods. Tuples are smaller in memory (no over-allocation) and can be used as dict keys (if contents are hashable). Tuples are slightly faster to create and access.

### Q8: How do `@staticmethod` and `@classmethod` differ?

`@staticmethod` doesn't receive self or cls — it's just a function that happens to be in a class namespace. `@classmethod` receives the class as the first argument, allowing it to be used as alternative constructors.

```python
class Pizza:
    def __init__(self, radius):
        self.radius = radius

    @classmethod
    def large(cls):
        return cls(16)  # Alternative constructor

    @staticmethod
    def area(radius):
        return 3.14159 * radius ** 2
```

---

## Python-Specific LeetCode Tricks

### 1. One-liners for Common Patterns

```python
# Transpose a matrix
transposed = list(zip(*matrix))

# Flatten a 2D list
flat = [x for row in matrix for x in row]

# Reverse a string
reversed_str = s[::-1]

# Every other element
every_other = arr[::2]

# Check all/any elements
all_positive = all(x > 0 for x in arr)
any_even = any(x % 2 == 0 for x in arr)

# Sum with condition
total = sum(x for x in arr if x > 0)

# Frequency dict in one line
from collections import Counter
freq = Counter(arr)

# Sort by custom key
sorted_people = sorted(people, key=lambda p: (-p.height, p.weight))

# Group by key
from itertools import groupby
for key, group in groupby(sorted(arr, key=key_func), key=key_func):
    print(key, list(group))
```

### 2. Slicing — The Full Syntax

```python
# arr[start:stop:step]  (stop is exclusive, start/step optional)

arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

arr[2:5]     # [2, 3, 4]      — indices 2, 3, 4
arr[:5]      # [0, 1, 2, 3, 4] — start to 4
arr[5:]      # [5, 6, 7, 8, 9] — 5 to end
arr[::2]     # [0, 2, 4, 6, 8] — every other
arr[1::2]    # [1, 3, 5, 7, 9] — odd indices
arr[::-1]   # [9, 8, 7, 6, 5, 4, 3, 2, 1, 0] — reversed
arr[-3:]    # [7, 8, 9]        — last 3
arr[:-3]    # [0, 1, 2, 3, 4, 5, 6] — all but last 3
arr[:: -2]  # [9, 7, 5, 3, 1] — every other, reversed
```

### 3. Useful Standard Library for Interviews

| Module | What it gives you | Interview use |
|--------|-------------------|---------------|
| `collections.Counter` | Frequency counting | Anagrams, top K frequent |
| `collections.defaultdict` | Auto-init dict | Graph adjacency, grouping |
| `collections.deque` | O(1) queue | BFS, sliding window |
| `collections.OrderedDict` | LRU-friendly dict | LRU cache |
| `heapq` | Min-heap | K-th largest, merge K sorted |
| `bisect` | Binary search on sorted list | Insert sorted, find position |
| `itertools` | Permutations, combinations, product | Backtracking shortcuts |
| `functools.lru_cache` | Auto-memoization | DP without explicit cache |
| `math` | gcd, isqrt, log, inf | Math problems |
| `enum` | Enumerations | State machines |

```python
# itertools power moves
from itertools import permutations, combinations, product, chain

list(permutations([1, 2, 3]))      # All orderings
list(combinations([1, 2, 3], 2))   # All pairs
list(product([0, 1], repeat=3))    # All binary triples
list(chain([1, 2], [3, 4], [5]))   # Flatten iterables: [1,2,3,4,5]

# lru_cache for instant memoization
from functools import lru_cache

@lru_cache(maxsize=None)
def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)
# One decorator = O(n) instead of O(2^n). No manual cache dict needed.
```

### 4. Sorting with Complex Keys

```python
# Sort by multiple criteria with mixed directions
people = [("Alice", 30), ("Bob", 25), ("Charlie", 30), ("Alice", 25)]

# Sort by name ascending, then age descending
sorted(people, key=lambda p: (p[0], -p[1]))
# [('Alice', 30), ('Alice', 25), ('Bob', 25), ('Charlie', 30)]

# Sort by age ascending, then name descending
sorted(people, key=lambda p: (-p[1], p[0]), reverse=True)
# Careful with reverse — it flips everything

# Better: use tuple with negation for numbers
sorted(people, key=lambda p: (p[1], [-ord(c) for c in p[0]]))
# This gets complex — for strings, use a wrapper class or cmp_to_key

from functools import cmp_to_key
sorted(people, key=cmp_to_key(lambda a, b: -1 if a[0] != b[0] and a[0] < b[0] else 1))
```

---

## Python vs Java — Quick Reference for Interviews

| Concept | Java | Python |
|---------|------|--------|
| Integer caching | `Integer.valueOf(127) == Integer.valueOf(127)` → true (range -128 to 127) | `a = 100; b = 100; a is b` → true (range -5 to 256) |
| String immutability | `String` immutable, `StringBuilder` for mutation | `str` immutable, `"".join()` for building |
| Hash map | `HashMap<K,V>` | `dict` |
| Set | `HashSet<E>` | `set` |
| Priority queue | `PriorityQueue<E>` (min-heap) | `heapq` (min-heap, functions not class) |
| Deque | `ArrayDeque<E>` | `collections.deque` |
| Arrays | `int[] arr = new int[n]` | `arr = [0] * n` |
| 2D array | `int[][] grid = new int[r][c]` | `grid = [[0] * c for _ in range(r)]` |
| Sorting | `Arrays.sort(arr)` / `Collections.sort(list)` | `sorted(arr)` / `arr.sort()` |
| Generic type erasure | Yes | No generics (duck typing) |
| Switch statement | `switch/case` | `match/case` (Python 3.10+) |
| Main method | `public static void main(String[] args)` | `if __name__ == "__main__":` |
| Null | `null` | `None` |
| Boolean | `true`/`false` | `True`/`False` |
| Ternary | `cond ? a : b` | `a if cond else b` |
| Integer division | `7 / 2 == 3` (int) | `7 // 2 == 3` (int), `7 / 2 == 3.5` (float) |
| Bitwise ops | `&`, `\|`, `^`, `~`, `<<`, `>>` | Same operators |
| Infinity | `Double.POSITIVE_INFINITY` | `float('inf')`, `float('-inf')` |
| Max integer | `Integer.MAX_VALUE` (2^31 - 1) | `float('inf')` or `math.inf` (no max int) |
| Length | `arr.length`, `str.length()`, `list.size()` | `len(arr)`, `len(str)`, `len(list)` |

---

## Common Pitfalls in Python Interviews

### 1. Integer Division Gotcha

```python
# In Python 3, / always returns float
7 / 2    # 3.5 (float)
7 // 2   # 3 (int) — floor division
-7 // 2  # -4 (floor division rounds DOWN, not toward zero!)

# For truncation toward zero (like Java/C):
import math
math.trunc(-7 / 2)  # -3
int(-7 / 2)          # -3
```

### 2. Default Mutable Arguments

Already covered above — but it's worth repeating. This is the single most common Python interview trap:

```python
# BAD
def f(items=[]):
    items.append(1)
    return items  # Accumulates across calls!

# GOOD
def f(items=None):
    if items is None:
        items = []
    items.append(1)
    return items
```

### 3. Late Binding in Closures

```python
# BUG — all lambdas capture the same variable
funcs = [lambda: i for i in range(3)]
[f() for f in funcs]  # [2, 2, 2] — not [0, 1, 2]!

# FIX — use default argument to capture current value
funcs = [lambda i=i: i for i in range(3)]
[f() for f in funcs]  # [0, 1, 2]
```

### 4. `is` vs `==` with Numbers

```python
a = 256
b = 256
a is b   # True — cached integers

a = 257
b = 257
a is b   # False — outside cache range, different objects

# ALWAYS use == for value comparison
# ALWAYS use `is` only for None, True, False
```

### 5. Shallow Copy Gotchas

```python
# List multiplication creates shallow copies
grid = [[0] * 3] * 3  # DANGER: all rows are the SAME list object
grid[0][0] = 1
print(grid)  # [[1, 0, 0], [1, 0, 0], [1, 0, 0]] — all rows changed!

# FIX: use comprehension
grid = [[0] * 3 for _ in range(3)]  # Each row is independent
grid[0][0] = 1
print(grid)  # [[1, 0, 0], [0, 0, 0], [0, 0, 0]]
```

### 6. `sorted()` vs `.sort()`

```python
# sorted() returns a NEW sorted list — doesn't modify original
new = sorted(original)

# .sort() sorts IN PLACE — modifies original, returns None
original.sort()  # original is now sorted, return value is None

# Common bug: assigning .sort() result
arr = [3, 1, 2]
arr = arr.sort()  # BUG: arr is now None!
arr.sort()        # CORRECT: arr is sorted in place
```

### 7. Float Comparison

```python
0.1 + 0.2 == 0.3  # False! Floating point precision
# Use math.isclose or epsilon comparison
import math
math.isclose(0.1 + 0.2, 0.3)  # True
```

---

## Interview Strategy for Python

### When to Use Python vs Java

| Situation | Better choice | Why |
|-----------|--------------|-----|
| Quick coding round (30 min) | Python | Less boilerplate, faster to write |
| System design / OOP | Either | Java has stronger typing for class design |
| String/array problems | Python | Slicing, comprehensions, Counter |
| Tree/graph traversal | Python | Less boilerplate for recursion |
| DP with memoization | Python | `@lru_cache` is a one-liner |
| Bit manipulation | Either | Same operators, similar verbosity |
| Object-oriented design | Java | Cleaner interfaces, generics, access modifiers |
| Concurrent programming | Java | Real threads (Python has GIL) |

### Python Coding Interview Checklist

Before submitting your solution, check:

- [ ] No mutable default arguments (`def f(x=[])`)
- [ ] Using `is None` instead of `== None`
- [ ] Using `deque` for BFS (not `list.pop(0)`)
- [ ] Using `"".join()` instead of string concatenation in loops
- [ ] Using `collections.Counter` for frequency counting
- [ ] Using `heapq` for priority queue operations
- [ ] Using `//` for integer division (not `/`)
- [ ] List comprehension for creating 2D arrays (not `[[0]*n]*n`)
- [ ] `sorted()` vs `.sort()` used correctly
- [ ] Edge cases: empty input, single element, negative numbers
- [ ] Using `float('inf')` instead of `sys.maxsize` for infinity

### Time Complexity of Python Operations

| Operation | Time | Notes |
|-----------|------|-------|
| `list.append(x)` | O(1) amortized | May trigger reallocation |
| `list.pop()` | O(1) | From end |
| `list.pop(0)` | O(n) | Must shift all elements |
| `list.insert(0, x)` | O(n) | Must shift all elements |
| `x in list` | O(n) | Linear scan |
| `list.sort()` | O(n log n) | Timsort |
| `dict[k] = v` | O(1) avg | Hash table |
| `k in dict` | O(1) avg | Hash table |
| `set.add(x)` | O(1) avg | Hash table |
| `x in set` | O(1) avg | Hash table |
| `deque.appendleft(x)` | O(1) | Doubly linked list |
| `deque.popleft()` | O(1) | Doubly linked list |
| `heapq.heappush(h, x)` | O(log n) | |
| `heapq.heappop(h)` | O(log n) | |
| `sorted(arr)` | O(n log n) | Returns new list |
| `str[i]` | O(1) | |
| `len(x)` | O(1) | All built-in types |

---

## Key Takeaways

1. **Everything is an object** — no primitives, which means overhead but also flexibility. Small ints and short strings are cached.
2. **Reference counting + cyclic GC** — immediate cleanup for non-cyclic, periodic for cycles. Understand why `del` doesn't always free memory.
3. **The GIL** — threading doesn't speed up CPU-bound work. Use multiprocessing or C extensions that release the GIL.
4. **Mutable default arguments** — the #1 Python interview trap. Always use `None` as sentinel.
5. **`is` vs `==`** — identity vs equality. Use `is` only for `None`, `True`, `False`.
6. **Dictionaries are ordered** (3.7+) and use compact hash tables with open addressing.
7. **Lists are arrays of pointers** — amortized O(1) append, O(n) insert at front.
8. **Generators are lazy** — use them for streaming/large data to save memory.
9. **`collections` module** — Counter, defaultdict, deque, OrderedDict are your interview power tools.
10. **`@lru_cache`** — one-decorator memoization for DP problems. Know it, love it.
11. **List multiplication is shallow** — `[[0]*n]*n` creates n references to the same row. Use comprehension instead.
12. **`//` is floor division** — it rounds DOWN, not toward zero. `-7 // 2 == -4`, not `-3`.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- dict = hash table with open addressing (Python 3.6+). list = dynamic array (amortized O(1) append). tuple = immutable list.
- GIL = Global Interpreter Lock, prevents multiple threads from executing Python bytecode simultaneously.
- `is` checks identity (same object), `==` checks equality (same value). `//` is floor division (rounds down, not toward zero).
- Mutable default arguments are the #1 Python interview trap — always use `None` as sentinel.
- `collections` module (Counter, defaultdict, deque, OrderedDict) and `@lru_cache` are your interview power tools.

**Common Follow-Up Questions:**
- "How does Python's dict maintain insertion order?" — Python 3.7+ guarantees insertion order. Internally, it uses a sparse table of indices + a dense array of entries. The dense array preserves insertion order.
- "How do you bypass the GIL?" — Use multiprocessing (separate processes, separate GILs), C extensions that release the GIL, or async I/O (I/O-bound work doesn't need the GIL).

**Gotcha:** Using `is` to compare strings/numbers. Due to interning, `is` may work for small strings/numbers but fail for larger ones. Always use `==` for value comparison. `is` is only for checking `is None` or `is True/False`.
