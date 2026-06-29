---
title: "Bit Manipulation — Coding Interview Prep"
topic: Bit Manipulation
language: Java
tags: [coding-interview, bit-manipulation, java, algorithms, leetcode]
difficulty: Medium
last-reviewed: 2026-06-19
---

# Bit Manipulation — Coding Interview Prep

Bit manipulation is the art of using bitwise operators to perform operations at the binary level. It shows up in interviews because it tests whether you understand how numbers are stored in memory, and it unlocks extremely efficient O(1) solutions to problems that otherwise need extra space or complex arithmetic.

This article covers the full toolbox: operators, common tricks, and complete Java solutions for the classic LeetCode problems. Every solution here is explained with ASCII diagrams so you can see the bits moving.

---

## Summary & Interview Framing

Operations on individual bits using AND, OR, XOR, shifts, and masks — enabling O(1) solutions for problems that seem to need extra space.

**How it's asked:** "Single number (XOR), number of 1 bits, reverse bits, power of two, sum without +/− — problems involving binary representation or arithmetic at the bit level."

---

## 1. Why Bit Manipulation Matters

- **Speed**: Bitwise operations execute in a single CPU cycle on most architectures.
- **Space**: Many bit problems reduce O(n) extra space to O(1).
- **Insight**: XOR, shift, and mask patterns are the backbone of hash-free deduplication, subset enumeration, and DP state compression.
- **Signal**: Interviewers use bit problems to filter candidates who truly understand data representation vs. those who only know high-level abstractions.

---

## 2. Bit Operators Cheat Sheet

Java has seven bitwise operators. All operate on integers at the bit level.

### 2.1 Operator Reference

| Operator | Name | Example | Result | Description |
|----------|------|---------|--------|-------------|
| `&` | AND | `12 & 10` | `8` | 1 only if both bits are 1 |
| `\|` | OR | `12 \| 10` | `14` | 1 if either bit is 1 |
| `^` | XOR | `12 ^ 10` | `6` | 1 if bits differ |
| `~` | NOT | `~12` | `-13` | Flips every bit (unary) |
| `<<` | Left Shift | `3 << 2` | `12` | Shifts bits left, fills with 0 |
| `>>` | Right (signed) | `-8 >> 1` | `-4` | Shifts right, fills with sign bit |
| `>>>` | Right (unsigned) | `-8 >>> 1` | `2147483644` | Shifts right, fills with 0 |

### 2.2 Truth Tables

```
AND (&)        OR (|)        XOR (^)       NOT (~)
A B | Out      A B | Out      A B | Out      A | Out
----+----      ----+----      ----+----      --+----
0 0 |  0       0 0 |  0       0 0 |  0       0 |  1
0 1 |  0       0 1 |  1       0 1 |  1       1 |  0
1 0 |  0       1 0 |  1       1 0 |  1
1 1 |  1       1 1 |  1       1 1 |  0
```

### 2.3 Visual: AND, OR, XOR on 12 and 10

```
  Decimal: 12      Decimal: 10
  Binary:  1100    Binary:  1010

AND (12 & 10 = 8):
     1 1 0 0   (12)
  &  1 0 1 0   (10)
  -----------
     1 0 0 0   (8)    <- bit is 1 ONLY where both are 1

OR (12 | 10 = 14):
     1 1 0 0   (12)
  |  1 0 1 0   (10)
  -----------
     1 1 1 0   (14)   <- bit is 1 where EITHER is 1

XOR (12 ^ 10 = 6):
     1 1 0 0   (12)
  ^  1 0 1 0   (10)
  -----------
     0 1 1 0   (6)    <- bit is 1 where bits DIFFER
```

### 2.4 Visual: Left Shift and Right Shift

```
LEFT SHIFT (3 << 2 = 12):
  3 in binary (8-bit):  0000 0011
  Shift left 2:        0000 1100   -> 12
  Rule: x << n  ==  x * (2^n)

RIGHT SHIFT — signed (16 >> 2 = 4):
  16 in binary:        0001 0000
  Shift right 2:       0000 0100   -> 4
  Rule: x >> n  ==  x / (2^n)  (floor for positive)

RIGHT SHIFT — unsigned (-8 >>> 1 in 8-bit):
  -8 in binary:        1111 1000
  Shift right 1 (>>>): 0111 1100   -> 124 (8-bit), 2147483644 (32-bit)
  >>> fills with 0 regardless of sign, so negative becomes huge positive
```

### 2.5 Key XOR Properties (Memorize These)

1. `x ^ x = 0` — XORing a number with itself cancels out.
2. `x ^ 0 = x` — XORing with zero is identity.
3. `x ^ y ^ x = y` — Associative + commutative; duplicates cancel.
4. `x ^ y = y ^ x` — Commutative.
5. `x ^ (y ^ z) = (x ^ y) ^ z` — Associative.
6. `x ^ x ^ x ^ ... (even count) = 0`
7. `x ^ x ^ x ^ ... (odd count) = x`

These seven properties unlock the entire "find the unique number" family of problems.

---

## 3. Common Bit Tricks

### 3.1 Check if a Number is a Power of 2

A power of 2 has exactly one `1` bit. Subtracting 1 flips that bit and all lower bits to `1`, so `n & (n-1)` becomes 0.

```
n  = 8  ->  1000
n-1= 7  ->  0111
n & (n-1) = 0000  ->  power of 2!

n  = 6  ->  0110
n-1= 5  ->  0101
n & (n-1) = 0100  ->  NOT a power of 2
```

```java
boolean isPowerOfTwo(int n) {
    return n > 0 && (n & (n - 1)) == 0;
}
```

### 3.2 Clear the Lowest Set Bit

`n & (n - 1)` clears (sets to 0) the lowest `1` bit. This is the most-used trick in bit counting and power-of-2 checks.

```
n    = 12  ->  1100
n-1  = 11  ->  1011
n & (n-1) = 1000   -> lowest 1-bit (position 2) cleared
```

### 3.3 Isolate the Lowest Set Bit

`n & (-n)` extracts only the lowest `1` bit. Used in Fenwick/BIT (Binary Indexed Trees) and in Single Number III.

```
n   = 12  ->  0000 1100
-n  = -12 ->  1111 0100  (two's complement)
n & (-n)   = 0000 0100  -> isolates bit at position 2
```

Why? In two's complement, `-n = ~n + 1`. The `+1` propagates up to the lowest `1` bit and flips everything below back, so only that one bit survives the AND.

### 3.4 Count Set Bits (Brian Kernighan's Algorithm)

Repeatedly clear the lowest set bit until zero. The number of iterations equals the number of set bits.

```
n = 13 -> 1101
Iteration 1: 1101 & 1100 = 1100  (count=1)
Iteration 2: 1100 & 1011 = 1000  (count=2)
Iteration 3: 1000 & 0111 = 0000  (count=3)
Total set bits = 3
```

```java
int countSetBits(int n) {
    int count = 0;
    while (n != 0) {
        n &= (n - 1);   // clear lowest set bit
        count++;
    }
    return count;
}
```

This runs in O(number of set bits) rather than O(32) for the naive shift approach.

### 3.5 Find the Unique Number (XOR Everything)

If every number appears twice except one, XOR-ing all of them cancels the pairs and leaves the unique value.

```
nums = [2, 3, 2, 4, 4]
XOR:  2 ^ 3 ^ 2 ^ 4 ^ 4
    = (2^2) ^ (4^4) ^ 3
    =   0   ^   0   ^ 3
    = 3   <- the unique number
```

```java
int findUnique(int[] nums) {
    int result = 0;
    for (int num : nums) result ^= num;
    return result;
}
```

### 3.6 Swap Two Variables Without a Temp

Using XOR, you can swap two integers without a third variable:

```
a = 5 (0101),  b = 3 (0011)

a = a ^ b   ->  a = 0101 ^ 0011 = 0110 (6)
b = a ^ b   ->  b = 0110 ^ 0011 = 0101 (5)   <- original a
a = a ^ b   ->  a = 0110 ^ 0101 = 0011 (3)   <- original b
```

```java
void swap(int[] arr, int i, int j) {
    if (i == j) return;          // CRITICAL: same index would zero it out
    arr[i] ^= arr[j];
    arr[j] ^= arr[i];
    arr[i] ^= arr[j];
}
```

Warning: If `i == j`, the first XOR zeroes out `arr[i]` and you lose the value. Always guard against that.

### 3.7 Set, Clear, Toggle, and Check a Specific Bit

```
Set bit k:      n |  (1 << k)
Clear bit k:    n & ~(1 << k)
Toggle bit k:   n ^ (1 << k)
Check bit k:    (n >> k) & 1

Example: n = 5 (0101), k = 1
Set bit 1:    0101 | 0010 = 0111 (7)
Clear bit 0:  0101 & 1110 = 0100 (4)
Toggle bit 2: 0101 ^ 0100 = 0001 (1)
Check bit 2:  (0101 >> 2) & 1 = 0001 & 1 = 1
```

### 3.8 Flip All Bits in a Range

To flip bits in positions `[0, k)`:
```java
int flipLowestK(int n, int k) {
    int mask = (1 << k) - 1;   // e.g., k=3 -> 0000 0111
    return n ^ mask;
}
```

---

## 4. Bit Tricks Reference Table

| Trick | Expression | Use Case |
|-------|-----------|----------|
| Clear lowest set bit | `n & (n - 1)` | Power of 2 check, bit counting |
| Isolate lowest set bit | `n & (-n)` | BIT/Fenwick tree, Single Number III |
| Get lowest set bit index | `Integer.numberOfTrailingZeros(n)` | Bit indexing |
| Set bit k | `n \| (1 << k)` | Building masks, flags |
| Clear bit k | `n & ~(1 << k)` | Resetting flags |
| Toggle bit k | `n ^ (1 << k)` | State flip |
| Check bit k | `(n >> k) & 1` | Read single bit |
| All 1s for k bits | `(1 << k) - 1` | Range masks, DP compression |
| Power of 2 check | `n > 0 && (n & (n-1)) == 0` | Validation |
| Count set bits | `Integer.bitCount(n)` | Built-in popcount |
| Remove last bit run | `n & (n + 1)` | Clear trailing 1s |
| Get power of 2 ceiling | `(n - 1) << 1` then bit tricks | Round up |
| Check odd/even | `(n & 1) == 1` | Faster than `% 2` |
| Absolute value | `(n ^ (n >> 31)) - (n >> 31)` | Branchless abs |
| Min of two ints | `b & ((a - b) >> 31) \| a & (~(a - b) >> 31)` | Branchless min |
| Count trailing zeros | `Integer.numberOfTrailingZeros(n)` | Bit indexing |
| Count leading zeros | `Integer.numberOfLeadingZeros(n)` | Bit indexing |
| Highest set bit | `Integer.highestOneBit(n)` | Ceiling power of 2 |
| Negate via XOR | `~n + 1` | Two's complement negation |
| Add 1 | `-~n` | Bit-hack increment |

---

## 5. LeetCode Problem Solutions (Full Java)

---

### 5.1 Single Number (LeetCode 136)

**Problem**: Every element appears twice except one. Find that single one. O(n) time, O(1) space.

**Intuition**: XOR all numbers. Pairs cancel (`x ^ x = 0`), leaving the unique element.

```
[4, 1, 2, 1, 2]
XOR:  4 ^ 1 ^ 2 ^ 1 ^ 2
    = 4 ^ (1^1) ^ (2^2)
    = 4 ^ 0 ^ 0
    = 4
```

```java
class Solution {
    public int singleNumber(int[] nums) {
        int result = 0;
        for (int num : nums) {
            result ^= num;
        }
        return result;
    }
}
```

- **Time**: O(n)
- **Space**: O(1)

---

### 5.2 Single Number II (LeetCode 137)

**Problem**: Every element appears three times except one (appears once). Find it. O(n) time, O(1) space.

**Intuition**: Track bit counts modulo 3. For each of the 32 bit positions, count how many numbers have that bit set. If a bit appears 3k+1 times, it belongs to the answer.

We use two variables `ones` and `twos`:
- `ones` holds bits that have appeared once (mod 3)
- `twos` holds bits that have appeared twice (mod 3)
- When a bit appears three times, it resets to 0 in both.

```
For each bit position, state transitions mod 3:
  seen 0 times -> twos=0, ones=0
  seen 1 time  -> twos=0, ones=1
  seen 2 times -> twos=1, ones=0
  seen 3 times -> twos=0, ones=0  (reset)

Transition logic:
  ones = (ones ^ num) & ~twos
  twos = (twos ^ num) & ~ones
```

```java
class Solution {
    public int singleNumber(int[] nums) {
        int ones = 0, twos = 0;
        for (int num : nums) {
            ones = (ones ^ num) & ~twos;
            twos = (twos ^ num) & ~ones;
        }
        return ones;
    }
}
```

**Generalized version** (every element appears k times except one appears once):

```java
class Solution {
    public int singleNumber(int[] nums) {
        // For "appears 3 times", use 2 counter bits
        int ones = 0, twos = 0;
        int commonMask = ~(ones & twos); // for k=3, reset when both are 1
        for (int num : nums) {
            ones = (ones ^ num) & ~(twos & ~ones);
            twos = (twos ^ num) & ~(ones & ~twos);
        }
        return ones;
    }
}
```

**Alternative: bit-counting approach** (more intuitive, O(32n)):

```java
class Solution {
    public int singleNumber(int[] nums) {
        int result = 0;
        for (int i = 0; i < 32; i++) {
            int sum = 0;
            for (int num : nums) {
                sum += (num >> i) & 1;   // count i-th bit across all nums
            }
            sum %= 3;                    // bits of triple elements cancel
            if (sum == 1) {
                result |= (1 << i);      // set this bit in result
            }
        }
        return result;
    }
}
```

- **Time**: O(n)
- **Space**: O(1)

---

### 5.3 Single Number III (LeetCode 260)

**Problem**: Exactly two elements appear once, all others appear twice. Find both. O(n) time, O(1) space.

**Intuition**:
1. XOR everything -> gives `xor = a ^ b` (the two unique numbers XORed).
2. Since `a != b`, `xor` has at least one set bit. Find any set bit (use `xor & (-xor)` to isolate the lowest).
3. This bit differs between `a` and `b`, so partition all numbers into two groups based on that bit. XOR each group separately to recover `a` and `b`.

```
nums = [1, 2, 1, 3, 2, 5]
xorAll = 1^2^1^3^2^5 = 3 ^ 5 = 6 (0110)
lowest set bit of 6 = 6 & -6 = 0010 (bit 1)
Group by bit 1:
  bit 1 is 0: 1(0001), 1(0001), 5(0101) -> XOR = 5
  bit 1 is 1: 2(0010), 3(0011), 2(0010) -> XOR = 3
Answer: [3, 5]
```

```java
class Solution {
    public int[] singleNumber(int[] nums) {
        // Step 1: XOR all numbers -> a ^ b
        int xor = 0;
        for (int num : nums) {
            xor ^= num;
        }

        // Step 2: isolate lowest set bit (distinguishes a from b)
        int diff = xor & (-xor);

        // Step 3: partition and XOR separately
        int a = 0, b = 0;
        for (int num : nums) {
            if ((num & diff) == 0) {
                a ^= num;
            } else {
                b ^= num;
            }
        }
        return new int[]{a, b};
    }
}
```

- **Time**: O(n)
- **Space**: O(1)

---

### 5.4 Number of 1 Bits (LeetCode 191)

**Problem**: Count the number of `1` bits in an unsigned integer (popcount / Hamming weight).

**Approach 1 — Brian Kernighan's algorithm** (recommended):

```
n = 11 (1011)
Iter 1: 1011 & 1010 = 1010  -> count=1
Iter 2: 1010 & 1001 = 1000  -> count=2
Iter 3: 1000 & 0111 = 0000  -> count=3
Answer: 3
```

```java
public class Solution {
    // you need to treat n as an unsigned value
    public int hammingWeight(int n) {
        int count = 0;
        while (n != 0) {
            n &= (n - 1);   // clear the lowest set bit
            count++;
        }
        return count;
    }
}
```

**Approach 2 — bit-shifting** (treat as unsigned via `>>>`):

```java
public class Solution {
    public int hammingWeight(int n) {
        int count = 0;
        for (int i = 0; i < 32; i++) {
            count += (n >>> i) & 1;   // unsigned shift, check each bit
        }
        return count;
    }
}
```

**Approach 3 — built-in** (know it exists, but show you understand the mechanics):

```java
public class Solution {
    public int hammingWeight(int n) {
        return Integer.bitCount(n);
    }
}
```

- **Time**: O(number of set bits) for Kernighan, O(32) for shifting
- **Space**: O(1)

---

### 5.5 Reverse Bits (LeetCode 190)

**Problem**: Reverse the 32 bits of an unsigned integer.

**Intuition**: Process bits from LSB to MSB of `n`, building the result by shifting left and OR-ing each bit in.

```
n = 43261596 (00000010100101000001111010011100)
Reverse all 32 bits:
  00111001011110000010100101000000 = 964176192

Bit-by-bit:
  result = 0
  for each of 32 bits:
    result = (result << 1) | (n & 1)   // push in next bit of n
    n >>>= 1                            // advance to next bit of n
```

```java
public class Solution {
    public int reverseBits(int n) {
        int result = 0;
        for (int i = 0; i < 32; i++) {
            result = (result << 1) | (n & 1);  // make room, then add LSB of n
            n >>>= 1;                          // unsigned shift to next bit
        }
        return result;
    }
}
```

**Byte-by-byte approach** (uses a swap helper, more elegant):

```java
public class Solution {
    public int reverseBits(int n) {
        int result = 0;
        for (int i = 0; i < 16; i++) {
            result |= ((n >> i) & 1) << (31 - i);
            result |= ((n >> (31 - i)) & 1) << i;
        }
        return result;
    }
}
```

**Follow-up**: If called many times, optimize with a precomputed byte-reversal lookup table (cache the reverse of all 256 byte values, then combine 4 reversed bytes).

- **Time**: O(1) (always 32 iterations)
- **Space**: O(1)

---

### 5.6 Missing Number (LeetCode 268)

**Problem**: Array of n distinct numbers from `[0, n]` with one missing. Find it. O(n) time, O(1) space.

**Intuition (XOR)**: XOR all indices `0..n` and all array elements. The missing number is the one that doesn't cancel out.

```
n = 3, nums = [3, 0, 1]
Full set:     0, 1, 2, 3
Array values: 3, 0, 1, (no 2)
XOR all indices AND values: 0^1^2^3 ^ 3^0^1 = 2
```

```java
class Solution {
    public int missingNumber(int[] nums) {
        int n = nums.length;
        int xor = 0;
        for (int i = 0; i < n; i++) {
            xor ^= i;          // XOR all indices 0..n-1
            xor ^= nums[i];    // XOR all array values
        }
        xor ^= n;              // XOR n (the last index, not covered by loop)
        return xor;
    }
}
```

**Intuition (Math)**: Sum of `0..n` minus sum of array = missing number.

```java
class Solution {
    public int missingNumber(int[] nums) {
        int n = nums.length;
        int expectedSum = n * (n + 1) / 2;
        int actualSum = 0;
        for (int num : nums) actualSum += num;
        return expectedSum - actualSum;
    }
}
```

- **Time**: O(n)
- **Space**: O(1)

Note: The XOR approach avoids integer overflow that the math approach could theoretically hit for huge `n` (though `n*(n+1)/2` fits in an `int` for n up to ~65535, and `long` handles the rest).

---

### 5.7 Sum of Two Integers (LeetCode 371)

**Problem**: Add two integers without using `+` or `-`. Return `a + b`.

**Intuition**: Use bitwise operations to simulate addition:
- **XOR** (`a ^ b`) gives the sum without carry.
- **AND + left shift** (`(a & b) << 1`) gives the carry bits.
- Repeat until there is no carry.

```
Example: a = 5 (0101), b = 3 (0011)

Iteration 1:
  sum    = 0101 ^ 0011 = 0110 (6)    <- no carry
  carry  = (0101 & 0011) << 1 = 0010 (2)

Iteration 2: a=6, b=2
  sum    = 0110 ^ 0010 = 0100 (4)
  carry  = (0110 & 0010) << 1 = 0100 (4)

Iteration 3: a=4, b=4
  sum    = 0100 ^ 0100 = 0000 (0)
  carry  = (0100 & 0100) << 1 = 1000 (8)

Iteration 4: a=0, b=8
  sum    = 0000 ^ 1000 = 1000 (8)
  carry  = 0

  -> 5 + 3 = 8  ✓
```

**Handling negative numbers**: In Java, integers are 32-bit two's complement. The carry can propagate indefinitely for negative inputs, so we mask to 32 bits and handle sign conversion.

```java
class Solution {
    public int getSum(int a, int b) {
        while (b != 0) {
            int carry = (a & b) << 1;   // carry bits, shifted left
            a = a ^ b;                   // sum without carry
            b = carry;                   // carry becomes new b
        }
        return a;
    }
}
```

For languages/compilers that treat overflow differently, mask to 32 bits:

```java
class Solution {
    public int getSum(int a, int b) {
        while (b != 0) {
            int carry = (a & b) << 1;
            a = a ^ b;
            b = carry;
        }
        return a;
    }
}
```

The clean version above works in Java because `int` is already 32-bit two's complement and overflow wraps naturally. The loop terminates because the carry eventually shifts out to 0.

- **Time**: O(1) — at most 32 iterations
- **Space**: O(1)

**Subtraction without `-`**: `a - b = getSum(a, getSum(~b, 1))` (negate `b` via two's complement, then add).

---

### 5.8 Divide Two Integers (LeetCode 29)

**Problem**: Divide two integers without using multiplication, division, or mod. Truncate toward zero. Clamp to `Integer.MAX_VALUE` on overflow.

**Intuition**: Use bit shifts to subtract large multiples of the divisor at once. This is "long division in base 2".

Instead of subtracting the divisor one at a time (too slow for `2^31 / 1`), double the divisor each iteration:

```
dividend = 43, divisor = 3

  3 fits in 43 how many times using powers of 2?
  3 << 0 = 3   (1x)   -> fits,  43 - 3  = 40,  quotient += 1
  3 << 1 = 6   (2x)   -> fits,  40 - 6  = 34,  quotient += 2
  3 << 2 = 12  (4x)   -> fits,  34 - 12 = 22,  quotient += 4
  3 << 3 = 24  (8x)   -> fits,  22 - 24 < 0,   stop this round, quotient += 8? 
    Actually we find the largest shift: 3 << 3 = 24 <= 43
    quotient += 8, remainder = 43 - 24 = 19
  Repeat with 19:
    3 << 2 = 12 <= 19, quotient += 4, remainder = 7
  Repeat with 7:
    3 << 1 = 6 <= 7, quotient += 2, remainder = 1
  Remainder 1 < 3, done.
  Total quotient = 8 + 4 + 2 = 14.  43 / 3 = 14 ✓
```

```java
class Solution {
    public int divide(int dividend, int divisor) {
        // Overflow: only case is Integer.MIN_VALUE / -1
        if (dividend == Integer.MIN_VALUE && divisor == -1) {
            return Integer.MAX_VALUE;
        }

        // Determine sign
        boolean negative = (dividend < 0) ^ (divisor < 0);

        // Work with longs to avoid overflow when converting MIN_VALUE to positive
        long dvd = Math.abs((long) dividend);
        long dvs = Math.abs((long) divisor);
        long quotient = 0;

        while (dvd >= dvs) {
            long temp = dvs;
            long multiple = 1;
            // Double temp until it exceeds the remaining dividend
            while (dvd >= (temp << 1)) {
                temp <<= 1;
                multiple <<= 1;
            }
            dvd -= temp;        // subtract the largest chunk
            quotient += multiple;
        }

        return negative ? (int) -quotient : (int) quotient;
    }
}
```

**Trace visualization**:

```
dividend=43, divisor=3  (both positive)

Outer loop iterations:
  dvd=43: temp=3,m=1 -> temp=6,m=2 -> temp=12,m=4 -> temp=24,m=8 -> (48>43, stop)
           dvd=43-24=19, quotient=8
  dvd=19: temp=3,m=1 -> temp=6,m=2 -> temp=12,m=4 -> (24>19, stop)
           dvd=19-12=7, quotient=8+4=12
  dvd=7:  temp=3,m=1 -> temp=6,m=2 -> (12>7, stop)
           dvd=7-6=1, quotient=12+2=14
  dvd=1:  1 < 3, exit outer loop

  quotient = 14  ✓
```

- **Time**: O((log dividend)^2) — each outer iteration reduces dividend significantly, inner finds max shift
- **Space**: O(1)

**Edge cases**:
- `Integer.MIN_VALUE / -1` overflows to `Integer.MAX_VALUE + 1`, so we clamp.
- Using `long` avoids the problem that `Math.abs(Integer.MIN_VALUE)` is still negative in 32-bit.

---

### 5.9 Subsets via Bitmask (LeetCode 78)

**Problem**: Return all possible subsets (the power set) of a distinct integer array. No duplicates.

**Intuition**: For an array of `n` elements, there are `2^n` subsets. Each subset corresponds to a bitmask from `0` to `2^n - 1`, where bit `j` being `1` means "include element `j`".

```
nums = [1, 2, 3]   n = 3   -> 2^3 = 8 subsets

Bitmask -> Subset
  000 -> []
  001 -> [1]
  010 -> [2]
  011 -> [1, 2]
  100 -> [3]
  101 -> [1, 3]
  110 -> [2, 3]
  111 -> [1, 2, 3]
```

```java
class Solution {
    public List<List<Integer>> subsets(int[] nums) {
        List<List<Integer>> result = new ArrayList<>();
        int n = nums.length;
        int total = 1 << n;   // 2^n subsets

        for (int mask = 0; mask < total; mask++) {
            List<Integer> subset = new ArrayList<>();
            for (int j = 0; j < n; j++) {
                if ((mask & (1 << j)) != 0) {   // check if bit j is set
                    subset.add(nums[j]);
                }
            }
            result.add(subset);
        }
        return result;
    }
}
```

**How the bitmask check works**:

```
mask = 5 (101), checking element at index j=2:
  1 << 2 = 100
  mask & (1 << 2) = 101 & 100 = 100 != 0  -> include nums[2]

checking element at index j=1:
  1 << 1 = 010
  mask & (1 << 1) = 101 & 010 = 000 == 0   -> exclude nums[1]

checking element at index j=0:
  1 << 0 = 001
  mask & (1 << 0) = 101 & 001 = 001 != 0   -> include nums[0]
  Subset = [nums[0], nums[2]] = [1, 3]
```

- **Time**: O(n * 2^n) — generate 2^n subsets, each up to n elements
- **Space**: O(n * 2^n) for the output

---

## 6. Additional Classic Bit Problems

---

### 6.1 Power of Two (LeetCode 231)

```java
class Solution {
    public boolean isPowerOfTwo(int n) {
        return n > 0 && (n & (n - 1)) == 0;
    }
}
```

The check `n & (n-1) == 0` confirms exactly one set bit. The `n > 0` guard excludes `0` (which would pass the bit test) and negative numbers.

---

### 6.2 Power of Four (LeetCode 342)

A power of 4 is a power of 2 AND its single set bit is at an even position (0, 2, 4, ...).

```
Power of 4 bits:
  4^0 = 1  -> 0000 0001  (bit 0, even)
  4^1 = 4  -> 0000 0100  (bit 2, even)
  4^2 = 16 -> 0001 0000  (bit 4, even)

Mask for even bits (0,2,4,...,30):
  0101 0101 0101 0101 0101 0101 0101 0101 = 0x55555555
```

```java
class Solution {
    public boolean isPowerOfFour(int num) {
        // Must be power of 2 AND set bit in even position
        return num > 0
            && (num & (num - 1)) == 0        // power of 2
            && (num & 0x55555555) != 0;       // set bit is at even position
    }
}
```

**Alternative** (using modulo):

```java
class Solution {
    public boolean isPowerOfFour(int num) {
        return num > 0
            && (num & (num - 1)) == 0
            && num % 3 == 1;   // 4^k mod 3 == 1, while 2^(2k+1) mod 3 == 2
    }
}
```

---

### 6.3 Find the Difference (LeetCode 389)

**Problem**: String `t` is generated by shuffling string `s` and adding one extra character. Find that character.

**Intuition**: XOR all characters from both strings. The paired ones cancel, leaving the extra character.

```
s = "abcd",  t = "abcde"
XOR: a ^ b ^ c ^ d ^ a ^ b ^ c ^ d ^ e
   = (a^a) ^ (b^b) ^ (c^c) ^ (d^d) ^ e
   = 0 ^ 0 ^ 0 ^ 0 ^ e
   = e   (ASCII 101)
```

```java
class Solution {
    public char findTheDifference(String s, String t) {
        char result = 0;
        for (char c : s.toCharArray()) result ^= c;
        for (char c : t.toCharArray()) result ^= c;
        return result;
    }
}
```

- **Time**: O(n)
- **Space**: O(1)

---

### 6.4 Binary Watch (LeetCode 401)

**Problem**: A binary watch has 4 LEDs for hours (0-11) and 6 LEDs for minutes (0-59). Given `num` (number of LEDs on), return all possible times.

**Intuition**: Iterate all 12 * 60 = 720 possible times. For each, count set bits in the hour and minute; if they sum to `num`, it's valid.

```
8:30 = hour=8 (1000), minute=30 (011110)
  Hour bits:    1 (only bit 3)
  Minute bits:  4 (bits 1,2,3,4)
  Total LEDs on = 5

  4 LEDs for hours:  0-11  -> at most 3 bits needed (1011 = 11)
  6 LEDs for minutes: 0-59 -> at most 5 bits needed (111011 = 59... wait 59 = 111011, 5 bits)
  Max bits = 3 (hour) + 5 (minute) = 8, but we have 4+6=10 LED positions
```

```java
class Solution {
    public List<String> readBinaryWatch(int num) {
        List<String> result = new ArrayList<>();
        for (int h = 0; h < 12; h++) {
            for (int m = 0; m < 60; m++) {
                if (Integer.bitCount(h) + Integer.bitCount(m) == num) {
                    result.add(String.format("%d:%02d", h, m));
                }
            }
        }
        return result;
    }
}
```

- **Time**: O(720) = O(1)
- **Space**: O(1) output excluded

---

### 6.5 Gray Code (LeetCode 89)

**Problem**: Generate an n-bit Gray code sequence — a sequence of `2^n` integers where consecutive values differ by exactly one bit.

**Intuition**: The standard formula: `gray(i) = i ^ (i >> 1)`.

```
n = 2:
  i=0: 00 ^ 00 = 00 (0)
  i=1: 01 ^ 00 = 01 (1)
  i=2: 10 ^ 01 = 11 (3)
  i=3: 11 ^ 01 = 10 (2)
  Sequence: [0, 1, 3, 2]

Visualizing the one-bit transitions:
  00 -> 01  (bit 0 flips)
  01 -> 11  (bit 1 flips)
  11 -> 10  (bit 0 flips)
```

```java
class Solution {
    public List<Integer> grayCode(int n) {
        List<Integer> result = new ArrayList<>();
        int total = 1 << n;
        for (int i = 0; i < total; i++) {
            result.add(i ^ (i >> 1));   // gray code formula
        }
        return result;
    }
}
```

**Why it works**: `i ^ (i >> 1)` ensures that consecutive values differ in exactly one bit because the XOR of `i` and `i+1` in Gray space changes only where the carry chain of `i -> i+1` stopped, which is a single bit.

- **Time**: O(2^n)
- **Space**: O(1) excluding output

---

### 6.6 Bit Manipulation for DP State Compression

When a DP problem has a small set of items (typically n <= 20), you can represent the "which items are chosen" state as a bitmask integer instead of a boolean array or set. This is called **bitmask DP** or **DP with bitmask state compression**.

**Why use bitmasks?**
- A state is a single `int` instead of an array — hashable, comparable, cacheable.
- Subset enumeration, transitions, and set operations become O(1) bitwise ops.
- Turns exponential memory into manageable constants (2^20 = ~1M states).

**Classic example — Traveling Salesman Problem (TSP)**:

```
dp[mask][u] = minimum cost to visit all cities in 'mask', ending at city 'u'
  mask: bitmask of visited cities (bit i = 1 if city i visited)
  u:    current city

Transition:
  for each unvisited city v:
    dp[mask | (1 << v)][v] = min(dp[mask][u] + dist[u][v])

Base:   dp[1 << 0][0] = 0   (start at city 0, only it visited)
Answer: min over u of dp[(1 << n) - 1][u] + dist[u][0]  (return to start)
```

**Visualizing mask transitions** (n=4, cities 0,1,2,3):

```
mask = 0101 means cities 0 and 2 visited
  From city 2, go to city 1:
    new mask = 0101 | 0010 = 0111 (cities 0,1,2 visited)

Full state space:
  0000 (none)        1000 (city 3)
  0001 (city 0)      1001 (0, 3)
  0010 (city 1)      1010 (1, 3)
  0011 (0, 1)        1011 (0, 1, 3)
  0100 (city 2)      1100 (2, 3)
  0101 (0, 2)        1101 (0, 2, 3)
  0110 (1, 2)        1110 (1, 2, 3)
  0111 (0, 1, 2)     1111 (all)
```

**Java skeleton for TSP bitmask DP**:

```java
int tsp(int[][] dist) {
    int n = dist.length;
    int[][] dp = new int[1 << n][n];
    for (int[] row : dp) Arrays.fill(row, Integer.MAX_VALUE);
    dp[1][0] = 0;  // start at city 0

    for (int mask = 1; mask < (1 << n); mask += 2) {  // city 0 always included
        for (int u = 0; u < n; u++) {
            if ((mask & (1 << u)) == 0 || dp[mask][u] == Integer.MAX_VALUE) continue;
            for (int v = 0; v < n; v++) {
                if ((mask & (1 << v)) != 0) continue;  // already visited
                int nextMask = mask | (1 << v);
                dp[nextMask][v] = Math.min(dp[nextMask][v], dp[mask][u] + dist[u][v]);
            }
        }
    }

    int result = Integer.MAX_VALUE;
    int fullMask = (1 << n) - 1;
    for (int u = 1; u < n; u++) {
        if (dp[fullMask][u] != Integer.MAX_VALUE) {
            result = Math.min(result, dp[fullMask][u] + dist[u][0]);
        }
    }
    return result;
}
```

**Common bitmask DP operations**:

| Operation | Code | Meaning |
|-----------|------|---------|
| Add item i to set | `mask \| (1 << i)` | Set bit i to 1 |
| Remove item i | `mask & ~(1 << i)` | Clear bit i |
| Check item i in set | `(mask >> i) & 1` | Read bit i |
| Toggle item i | `mask ^ (1 << i)` | Flip bit i |
| Size of set | `Integer.bitCount(mask)` | Count set bits |
| Iterate all subsets | `for (sub = mask; sub > 0; sub = (sub - 1) & mask)` | Enumerate subsets of mask |
| Empty set | `0` | No items |
| Full set | `(1 << n) - 1` | All n items |

**Subset enumeration trick** (very important for DP):

```java
// Iterate over all non-empty subsets of 'mask' in decreasing order
for (int sub = mask; sub > 0; sub = (sub - 1) & mask) {
    // process subset 'sub'
}
// Include empty subset if needed:
// (handle sub == 0 separately after the loop)
```

The magic: `(sub - 1) & mask` finds the next smaller subset of `mask` in O(1). This is the standard way to enumerate subsets without generating all 2^n combinations.

**Other classic bitmask DP problems**:
- **Partition to K Equal Sum Subsets** (LeetCode 698) — use mask to track which elements are used.
- **Matchsticks to Square** (LeetCode 473) — same idea.
- **Minimum XOR Sum of Two Arrays** (LeetCode 1872) — assign elements via mask.
- **Find the Shortest Superstring** (LeetCode 943) — mask tracks which strings used.
- **Cherry Pickup / grid problems with limited passes** — mask for columns visited.

**Rule of thumb**: If n <= 20 and the state is "which subset of items", bitmask DP is likely the intended approach. Complexity is O(2^n * n) which is feasible for n up to ~20.

---

## 7. Advanced Techniques Reference

### 7.1 Swapping Bits at Positions i and j

```java
int swapBits(int n, int i, int j) {
    // If bits differ, toggle both
    if (((n >> i) & 1) != ((n >> j) & 1)) {
        n ^= (1 << i) | (1 << j);
    }
    return n;
}
```

### 7.2 Reversing All Bits in a Byte (Lookup Table)

```java
// Precompute reversals for all 256 byte values
private static int[] reverseTable = new int[256];
static {
    for (int i = 0; i < 256; i++) {
        reverseTable[i] = (i & 1) << 7 | (i & 2) << 5 | (i & 4) << 3
                        | (i & 8) << 1 | (i & 16) >>> 1 | (i & 32) >>> 3
                        | (i & 64) >>> 5 | (i & 128) >>> 7;
    }
}
```

### 7.3 Popcount with Parallel Bit Counting

```
Step 1:  Count bits in each 2-bit group     n = n - ((n >> 1) & 0x55555555)
Step 2:  Sum into 4-bit groups              n = (n & 0x33333333) + ((n >> 2) & 0x33333333)
Step 3:  Sum into 8-bit groups              n = (n + (n >> 4)) & 0x0F0F0F0F
Step 4:  Multiply to get total in top byte  n = (n * 0x01010101) >> 24
```

This is the SWAR (SIMD Within A Register) popcount — O(1) with no loops. `Integer.bitCount()` in Java uses this internally.

---

## 8. Interview Strategy for Bit Problems

### 8.1 When to Reach for Bit Manipulation

- The problem mentions **"without extra space"** and involves arrays with pairing/duplication patterns.
- You see constraints like **"appear twice except one appears once"** — think XOR.
- The problem involves **powers of 2** — think `n & (n-1)`.
- You need to **enumerate all subsets** — think bitmask from `0` to `2^n - 1`.
- The problem says **"without using +, -, *, /"** — think bitwise arithmetic.
- **n is small (<= 20)** and there's a "which items are selected" state — think bitmask DP.
- You're dealing with **flags, permissions, or states** that are naturally binary.

### 8.2 Common Pitfalls

1. **Forgetting operator precedence**: `(n & 1) == 1` is correct; `n & 1 == 1` parses as `n & (1 == 1)` = `n & 1` which is wrong for comparison. Always parenthesize bitwise ops.

2. **Sign extension on right shift**: Use `>>>` for unsigned (logical) shift, `>>` for signed (arithmetic) shift. Mixing them up corrupts results for negative numbers.

3. **Overflow in intermediate calculations**: `Math.abs(Integer.MIN_VALUE)` returns `Integer.MIN_VALUE` (still negative!). Use `long` or special-case it.

4. **The `i == j` swap bug**: XOR swap zeroes out a variable when indices are equal. Always guard.

5. **Assuming 8-bit or 16-bit**: Java ints are always 32-bit. Don't write code assuming a specific word size unless the problem says so.

6. **Forgetting the zero case**: `n & (n-1) == 0` is true for `n = 0` AND powers of 2. Always check `n > 0`.

7. **Not handling negative numbers in bit counting**: `~0` is `-1` with 32 set bits; make sure your loop uses `!= 0` rather than `> 0` if counting all 32 bits.

### 8.3 Quick Mental Checks

- Is the result always non-negative? If dealing with unsigned semantics, mask with `& 0xFFFFFFFFL` to get the unsigned value in a `long`.
- Does shifting left by 31 overflow? `1 << 31` is `Integer.MIN_VALUE` (negative!), not a large positive number.
- When XOR-ing characters, do you need to handle Unicode? `char` XOR works fine for ASCII; for full Unicode you'd need to operate on `int` code points.

---

## 9. Pattern Recognition Table

This table maps problem characteristics to the bit manipulation technique to use.

| Signal in the Problem | Technique | Example Problems |
|----------------------|-----------|-----------------|
| "Every element appears twice except one" | XOR all elements | Single Number (136) |
| "Every element appears k times except one" | Modulo-k bit counting or k-counter state machine | Single Number II (137) |
| "Two unique elements, rest appear twice" | XOR all, partition by a differing bit | Single Number III (260) |
| "Count set bits" | `n & (n-1)` loop (Kernighan) or `Integer.bitCount` | Number of 1 Bits (191), Counting Bits (338) |
| "Reverse all bits" | Bit-by-bit extraction with `>>>` | Reverse Bits (190) |
| "Missing number in [0, n]" | XOR indices with values, or sum formula | Missing Number (268) |
| "Is n a power of 2?" | `n > 0 && (n & (n-1)) == 0` | Power of Two (231) |
| "Is n a power of 4?" | Power of 2 + even bit position mask `0x55555555` | Power of Four (342) |
| "Add without + or -" | XOR for sum, AND-shift for carry, loop | Sum of Two Integers (371) |
| "Divide without / or *" | Repeated doubling with bit shifts | Divide Two Integers (29) |
| "Generate all subsets" | Iterate `0` to `2^n - 1`, use bits as inclusion flags | Subsets (78), Subsets II (90) |
| "Find the one extra/changed character" | XOR all characters | Find the Difference (389) |
| "Binary representation of something" | Bit counting per candidate | Binary Watch (401) |
| "Sequence differs by one bit each step" | `gray(i) = i ^ (i >> 1)` | Gray Code (89) |
| "n <= 20, track which items selected" | Bitmask DP, mask as state | TSP, Partition to K Equal Sum (698) |
| "Enumerate subsets of a set" | `for (sub = mask; sub > 0; sub = (sub-1) & mask)` | Sum Over Subsets, SOS DP |
| "Range XOR or prefix bits" | Prefix XOR array | XOR queries, Decode XORed Array (1720) |
| "Toggle flags / permissions" | `mask ^ (1 << k)` | Flag systems, Sudoku bit validation |
| "Find highest set bit" | `Integer.highestOneBit(n)` or `31 - numberOfLeadingZeros` | Bitwise ORs of Subarrays |
| "Lowest set bit position" | `n & (-n)` then `numberOfTrailingZeros` | Fenwick Tree, Single Number III |
| "All numbers in range have property based on bits" | Iterate by bit position (0-31) | Binary Prefix Divisible By 5 (1018) |
| "String with bit-reversed order" | Reverse bits of index | Repeated XOR problems |
| "Check if bits form valid encoding" | Bit validation per position | UTF-8 Validation (393) |
| "Maximum XOR of two numbers" | Trie of binary representations + greedy bit matching | Maximum XOR of Two Numbers (421) |
| "AND/OR/XOR over a range [L, R]" | Find common prefix bits, shift trick | Bitwise AND of Numbers Range (201) |
| "Insert one bit pattern into another" | Clear then OR with shifted mask | Insertion (Cracking the Coding Interview) |

---

## 10. Quick Reference: Bitwise Idioms in Java

```java
// Power of 2 check
boolean isPow2 = n > 0 && (n & (n - 1)) == 0;

// Popcount
int bits = Integer.bitCount(n);

// Highest power of 2 <= n
int floor = Integer.highestOneBit(n);

// Lowest set bit value
int low = n & (-n);

// Lowest set bit index
int idx = Integer.numberOfTrailingZeros(n);

// Set bit k
n |= (1 << k);

// Clear bit k
n &= ~(1 << k);

// Toggle bit k
n ^= (1 << k);

// Test bit k
boolean set = ((n >> k) & 1) == 1;

// Mask for lowest k bits
int mask = (1 << k) - 1;

// Unsigned right shift (logical)
int urShift = n >>> k;

// Check if opposite signs
boolean oppSigns = (a ^ b) < 0;

// Absolute value (branchless)
int abs = (n ^ (n >> 31)) - (n >> 31);

// Minimum of two ints (branchless)
int min = b + ((a - b) & ((a - b) >> 31));

// Check if power of 4
boolean isPow4 = n > 0 && (n & (n - 1)) == 0 && (n & 0x55555555) != 0;

// Round up to next power of 2
int nextPow2 = Integer.highestOneBit(n - 1) << 1;  // for n > 1
```

---

## 11. Summary

Bit manipulation is a compact but powerful toolkit. The recurring themes are:

1. **XOR cancels duplicates** — the foundation for all "find the unique number" problems.
2. **`n & (n-1)` clears the lowest set bit** — powers of 2, bit counting, and state transitions.
3. **`n & (-n)` isolates the lowest set bit** — partitioning and tree-based algorithms.
4. **Bitmasks represent subsets** — when n is small, an integer's bits ARE a set.
5. **XOR + AND-shift simulate arithmetic** — addition without `+`, division without `/`.
6. **Bitmask DP compresses state** — turn "which items" into a single hashable integer.

Master these patterns and you'll recognize bit manipulation problems instantly, often seeing the O(1) space solution before you finish reading the problem statement. Practice with the eight full solutions above (136, 137, 191, 268, 371, 78, 190, 29) until the bitwise idioms become second nature.

## Interview Cheat Sheet

**Key Points to Remember:**
- XOR properties: a^a=0, a^0=a, a^b^a=b.
- Common tricks: check odd (n&1), swap without temp (a^=b, b^=a, a^=b), find unique element (XOR all).
- Bit masking: (n >> k) & 1 gets k-th bit, n | (1<<k) sets k-th bit, n & ~(1<<k) clears k-th bit.
- Power of 2: n > 0 && (n & (n-1)) == 0.

**Common Follow-Up Questions:**
- **How do you count set bits?** — Brian Kernighan's algorithm: while (n != 0) { n &= (n-1); count++; }. Each iteration removes the lowest set bit. O(number of set bits).
- **How do you reverse bits?** — Swap bits pairwise: swap bits 0 and 31, 1 and 30, etc. Or use a lookup table for 8-bit chunks.

**Gotcha:**
- Sign extension in right shift. In Java, >> is arithmetic (fills with sign bit), >>> is logical (fills with 0). Using >> on a negative number gives wrong results for bit extraction — use >>> instead.
