---
title: "ML Coding - Transformer"
category: "Coding Interview Prep"
tags: [pytorch, transformer, attention, ml-coding, deep-learning, llm]
last_updated: "2026-06-21"
---

# ML Coding Interview Prep — Part 2: Transformer

This is the most important ML coding interview topic. Implementing a transformer from scratch — attention, transformer block, full LM forward pass, RoPE, KV cache — is the single highest-leverage skill you can have. Stanford's CS336 (Alisa's #1 recommendation) and most ML system design interviews will test this directly.

This doc builds on *ML Coding - PyTorch Foundations*. If you don't have tensor manipulation, autograd, and nn.Module basics down cold, do that first.

---

## Summary & Interview Framing

Implementing the transformer architecture from scratch — multi-head attention, positional encoding, layer norm, feed-forward, and causal masking.

**How it's asked:** "Implement multi-head attention from scratch in PyTorch. Explain Q/K/V, scaling, masking. Then implement a full transformer block and a language model forward pass."

---

## The Mental Model

The transformer is a stack of identical blocks. Each block does two things:
1. **Self-attention**: every token looks at every other token and updates its representation
2. **Feedforward (FFN)**: each token independently applies a 2-layer MLP to its representation

Between these, there are residual connections and normalization. The block is repeated N times (e.g., 32 times for a 7B model), and the output of the last block is projected to the vocabulary size to get next-token logits.

```
Input tokens (B, T)
       │
       ▼
┌──────────────────┐
│ Token Embedding  │   (vocab_size, d_model)
└──────────────────┘
       │
       ▼
┌──────────────────┐
│ + Positional Enc │   RoPE, sinusoidal, or learned
└──────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│   Transformer Block 1                    │
│   ┌──────────────────────────────────┐  │
│   │ x → LayerNorm → MHA → + x       │  │  ← residual
│   │   → LayerNorm → FFN  → + x       │  │  ← residual
│   └──────────────────────────────────┘  │
└──────────────────────────────────────────┘
       │  (repeated N times)
       ▼
┌──────────────────┐
│ Final LayerNorm   │
└──────────────────┘
       │
       ▼
┌──────────────────┐
│ LM Head           │   (d_model, vocab_size) — often tied with embedding
└──────────────────┘
       │
       ▼
Logits (B, T, vocab_size)
```

The two main architectural variants are pre-norm (LayerNorm before the sublayer) and post-norm (LayerNorm after the residual). Pre-norm is now standard because it trains more stably without learning rate warmup.

---

## Multi-Head Self-Attention

This is the heart of the transformer. Given queries, keys, and values derived from the same input sequence, compute a weighted sum of values where the weights come from Q-K similarity.

### The math

For each head:
```
Attention(Q, K, V) = softmax(Q @ K^T / sqrt(d_k) + mask) @ V
```

For multi-head:
```
MultiHead(Q, K, V) = Concat(head_1, ..., head_h) @ W_O
where head_i = Attention(Q @ W_Q_i, K @ W_K_i, V @ W_V_i)
```

The scaling by `sqrt(d_k)` prevents the softmax from saturating (when dot products are large, softmax becomes one-hot).

### Implementation

```python
import torch
import torch.nn as nn
import torch.nn.functional as F
import math

class MultiHeadAttention(nn.Module):
    def __init__(self, d_model, n_heads, max_seq_len=2048, dropout=0.0):
        super().__init__()
        assert d_model % n_heads == 0, "d_model must be divisible by n_heads"

        self.d_model = d_model
        self.n_heads = n_heads
        self.head_dim = d_model // n_heads

        # Combined Q, K, V projection (faster than 3 separate)
        self.qkv = nn.Linear(d_model, 3 * d_model, bias=False)
        self.out = nn.Linear(d_model, d_model, bias=False)

        self.dropout = nn.Dropout(dropout)

    def forward(self, x, mask=None, kv_cache=None):
        """
        x: (B, T, d_model)
        mask: (T, T) or (B, T, T), additive (0 or -inf)
        kv_cache: optional tuple of (K, V) from previous steps, shape (B, n_heads, T_cache, head_dim)
        """
        B, T, _ = x.shape

        # Project to Q, K, V
        qkv = self.qkv(x)  # (B, T, 3 * d_model)
        q, k, v = qkv.chunk(3, dim=-1)

        # Reshape to (B, n_heads, T, head_dim)
        q = q.view(B, T, self.n_heads, self.head_dim).transpose(1, 2)
        k = k.view(B, T, self.n_heads, self.head_dim).transpose(1, 2)
        v = v.view(B, T, self.n_heads, self.head_dim).transpose(1, 2)

        # If using KV cache, concatenate with cached K, V
        if kv_cache is not None:
            k_cache, v_cache = kv_cache
            k = torch.cat([k_cache, k], dim=2)
            v = torch.cat([v_cache, v], dim=2)

        # Scaled dot-product attention
        # Use F.scaled_dot_product_attention for FlashAttention (faster, less memory)
        if mask is not None:
            attn_output = F.scaled_dot_product_attention(
                q, k, v, attn_mask=mask, dropout_p=self.dropout.p if self.training else 0.0
            )
        else:
            attn_output = F.scaled_dot_product_attention(
                q, k, v, is_causal=True, dropout_p=self.dropout.p if self.training else 0.0
            )

        # Reshape back to (B, T, d_model)
        attn_output = attn_output.transpose(1, 2).contiguous().view(B, T, self.d_model)
        return self.out(attn_output), (k, v)  # Return output and updated KV cache
```

Key points to remember:
- `F.scaled_dot_product_attention` is the modern way to do attention — it uses FlashAttention when available
- The KV cache is returned so the caller can pass it back on the next forward pass
- The combined QKV projection is faster than three separate ones (one larger GEMM vs three smaller)
- The output projection `W_O` mixes information across heads

### Causal mask

For autoregressive generation, each token can only attend to previous tokens. The mask is a triangular matrix where position `i` can attend to positions `0, 1, ..., i`.

```
Position 0: [1, 0, 0, 0, 0]  (attend only to self)
Position 1: [1, 1, 0, 0, 0]  (attend to 0 and 1)
Position 2: [1, 1, 1, 0, 0]
...
```

The simplest way to create it in PyTorch:

```python
# Upper-triangular mask with -inf above the diagonal
mask = torch.triu(torch.ones(T, T) * float('-inf'), diagonal=1)
# Or use the boolean form for F.scaled_dot_product_attention
mask = torch.triu(torch.ones(T, T, dtype=torch.bool), diagonal=1)
```

The interview question: "Why do we need a causal mask?" For training, it allows us to predict every next token in parallel — token at position `i` predicts token `i+1` using only positions `0..i`. Without the mask, the model would see future tokens and trivially copy them, making training useless.

---

## RoPE (Rotary Position Embedding)

Most modern LLMs (LLaMA, Mistral, Qwen) use RoPE instead of sinusoidal or learned positional encodings. RoPE is more elegant and supports length extrapolation.

The idea: rotate the query and key vectors by position-dependent angles. The angle depends on the position and the dimension index, using a series of frequencies.

```
For position p and dim index 2i (even), 2i+1 (odd):
θ_i = p / base^(2i / d)
[q_2i, q_2i+1] → [q_2i cos(θ_i) - q_2i+1 sin(θ_i), q_2i sin(θ_i) + q_2i+1 cos(θ_i)]
```

The key property: after rotation, the dot product `q_i · k_j` depends only on the relative position `i - j`, not the absolute positions. This is exactly what attention needs.

### Implementation

```python
class RotaryPositionalEmbedding(nn.Module):
    def __init__(self, head_dim, max_seq_len=2048, base=10000):
        super().__init__()
        # Compute the frequency for each dim index
        inv_freq = 1.0 / (base ** (torch.arange(0, head_dim, 2).float() / head_dim))
        self.register_buffer('inv_freq', inv_freq)
        self._build_cache(max_seq_len)

    def _build_cache(self, max_seq_len):
        t = torch.arange(max_seq_len)
        # Outer product: (max_seq_len, head_dim/2)
        freqs = torch.outer(t, self.inv_freq)
        # Duplicate for cos and sin: (max_seq_len, head_dim)
        emb = torch.cat((freqs, freqs), dim=-1)
        self.register_buffer('cos_cached', emb.cos())
        self.register_buffer('sin_cached', emb.sin())

    def forward(self, x, seq_len):
        # x: (B, n_heads, T, head_dim)
        return (
            self.cos_cached[:seq_len].to(x.dtype),
            self.sin_cached[:seq_len].to(x.dtype)
        )

def apply_rope(x, cos, sin):
    """
    x: (B, n_heads, T, head_dim)
    cos, sin: (T, head_dim)
    """
    # Rotate every pair (x[..., 2i], x[..., 2i+1]) by the corresponding angle
    x_pair = x.float().reshape(*x.shape[:-1], -1, 2)
    x1, x2 = x_pair[..., 0], x_pair[..., 1]
    cos = cos.unsqueeze(0).unsqueeze(0)  # (1, 1, T, head_dim/2)
    sin = sin.unsqueeze(0).unsqueeze(0)

    rot1 = x1 * cos - x2 * sin
    rot2 = x1 * sin + x2 * cos
    return torch.stack((rot1, rot2), dim=-1).flatten(-2).to(x.dtype)
```

Then in attention:

```python
class AttentionWithRoPE(nn.Module):
    def __init__(self, d_model, n_heads, max_seq_len=2048):
        super().__init__()
        self.rope = RotaryPositionalEmbedding(d_model // n_heads, max_seq_len)
        # ... rest of attention setup

    def forward(self, x, mask=None):
        B, T, _ = x.shape
        q, k, v = self.qkv(x).chunk(3, dim=-1)
        q = q.view(B, T, self.n_heads, self.head_dim).transpose(1, 2)
        k = k.view(B, T, self.n_heads, self.head_dim).transpose(1, 2)
        v = v.view(B, T, self.n_heads, self.head_dim).transpose(1, 2)

        # Apply RoPE to Q and K
        cos, sin = self.rope(q, T)
        q = apply_rope(q, cos, sin)
        k = apply_rope(k, cos, sin)

        # ... standard attention
```

The interview question: "Why RoPE instead of sinusoidal?" Three reasons:
1. RoPE encodes relative position directly (the dot product depends on `i - j`, not `i` and `j` separately)
2. RoPE supports length extrapolation — a model trained on 4K can be extended to 32K+
3. RoPE is parameter-free (no learned embeddings), making it clean and general

---

## Transformer Block (Pre-Norm)

The standard transformer block in modern LLMs uses pre-norm: LayerNorm before each sublayer, then the sublayer, then a residual connection.

```python
class TransformerBlock(nn.Module):
    def __init__(self, d_model, n_heads, ffn_dim, dropout=0.0):
        super().__init__()
        self.ln1 = nn.LayerNorm(d_model)
        self.attn = MultiHeadAttention(d_model, n_heads, dropout=dropout)
        self.ln2 = nn.LayerNorm(d_model)
        self.ffn = FeedForward(d_model, ffn_dim, dropout)

    def forward(self, x, mask=None, kv_cache=None):
        # Pre-norm attention with residual
        new_kv = None
        attn_out, new_kv = self.attn(self.ln1(x), mask=mask, kv_cache=kv_cache)
        x = x + attn_out

        # Pre-norm FFN with residual
        x = x + self.ffn(self.ln2(x))
        return x, new_kv
```

The interview question: "Pre-norm vs post-norm?" Post-norm (original Transformer paper) is the more theoretically motivated design but is hard to train without careful learning rate warmup — gradients can explode or vanish. Pre-norm has a "clean" residual stream (the output of the residual is the input plus a sublayer's contribution, with no normalization in between), which makes training more stable. Almost all modern LLMs use pre-norm.

### FeedForward (FFN) Block

The FFN is a 2-layer MLP applied independently to each token. It's where most of the model's parameters live (about 2/3 of total).

```python
class FeedForward(nn.Module):
    def __init__(self, d_model, ffn_dim, dropout=0.0):
        super().__init__()
        self.fc1 = nn.Linear(d_model, ffn_dim, bias=False)
        self.fc2 = nn.Linear(ffn_dim, d_model, bias=False)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x):
        return self.dropout(self.fc2(F.gelu(self.fc1(x))))
```

The standard FFN has 4x the hidden dimension (ffn_dim = 4 * d_model). GELU is the classic activation, but SwiGLU is now preferred for LLaMA-style models.

### SwiGLU (LLaMA-style FFN)

SwiGLU is a gated activation: `out = (Swish(W_1 @ x) * W_2 @ x) @ W_3`. The gating gives the network more flexibility to selectively pass information.

```python
class SwiGLU(nn.Module):
    def __init__(self, d_model, ffn_dim, dropout=0.0):
        super().__init__()
        # Two up-projections + one down-projection
        self.w1 = nn.Linear(d_model, ffn_dim, bias=False)  # Gate
        self.w2 = nn.Linear(d_model, ffn_dim, bias=False)  # Up
        self.w3 = nn.Linear(ffn_dim, d_model, bias=False)  # Down
        self.dropout = nn.Dropout(dropout)

    def forward(self, x):
        return self.dropout(self.w3(F.silu(self.w1(x)) * self.w2(x)))
```

To keep parameter count constant, `ffn_dim` is usually `8/3 * d_model` instead of `4 * d_model` (so the total params = `d * (8/3)d * 2 + (8/3)d * d = 8/3 d^2` for the three matrices, similar to standard FFN's `2 * d * 4d = 8d^2`).

---

## Full Transformer LM

Putting it all together — a complete (but minimal) language model.

```python
class TransformerLM(nn.Module):
    def __init__(
        self,
        vocab_size,
        d_model=512,
        n_heads=8,
        n_layers=6,
        ffn_dim=2048,
        max_seq_len=1024,
        dropout=0.1,
    ):
        super().__init__()
        self.vocab_size = vocab_size
        self.d_model = d_model
        self.max_seq_len = max_seq_len

        # Token + position embeddings
        self.tok_emb = nn.Embedding(vocab_size, d_model)
        self.rope = RotaryPositionalEmbedding(d_model // n_heads, max_seq_len)
        self.dropout = nn.Dropout(dropout)

        # Transformer blocks
        self.blocks = nn.ModuleList([
            TransformerBlock(d_model, n_heads, ffn_dim, dropout)
            for _ in range(n_layers)
        ])

        # Output
        self.ln_f = nn.LayerNorm(d_model)
        self.lm_head = nn.Linear(d_model, vocab_size, bias=False)

        # Weight tying: share embedding and output weights
        self.lm_head.weight = self.tok_emb.weight

    def forward(self, idx, targets=None, kv_cache=None):
        """
        idx: (B, T) token indices
        targets: (B, T) target token indices for loss
        kv_cache: optional list of (K, V) tuples, one per layer
        """
        B, T = idx.shape

        # Token embeddings
        x = self.tok_emb(idx)  # (B, T, d_model)
        x = self.dropout(x)

        # Apply RoPE
        cos, sin = self.rope(x, T)

        # Apply transformer blocks
        new_kv_cache = []
        for i, block in enumerate(self.blocks):
            layer_cache = kv_cache[i] if kv_cache is not None else None
            x, new_kv = block(x, kv_cache=layer_cache)
            new_kv_cache.append(new_kv)

        # Final norm + projection
        x = self.ln_f(x)
        logits = self.lm_head(x)  # (B, T, vocab_size)

        # Loss
        loss = None
        if targets is not None:
            loss = F.cross_entropy(
                logits.view(-1, self.vocab_size),
                targets.view(-1)
            )
        return logits, loss, new_kv_cache
```

The interview question: "What is weight tying and why do it?" Weight tying sets the output projection's weight equal to the input embedding's weight. This reduces the parameter count by `vocab_size * d_model` and empirically improves language modeling quality (the model learns a single consistent representation for each token used in both contexts). It assumes the embedding matrix and the output projection play symmetric roles — input tokens become vectors, output vectors are interpreted as token probabilities.

---

## Generation Loop

Once you have a trained model, you need a generation function. The most common approach is autoregressive sampling.

```python
@torch.no_grad()
def generate(model, idx, max_new_tokens, temperature=1.0, top_k=None, top_p=None):
    """
    idx: (B, T) initial context tokens
    Returns: (B, T + max_new_tokens) generated tokens
    """
    model.eval()
    kv_cache = None  # Will be populated on first forward pass

    for _ in range(max_new_tokens):
        # If we have a cache, only feed the last token
        if kv_cache is None:
            idx_cond = idx
        else:
            idx_cond = idx[:, -1:]

        # Forward pass
        logits, _, kv_cache = model(idx_cond, kv_cache=kv_cache)
        logits = logits[:, -1, :] / temperature  # Last position, with temperature

        # Top-k filtering
        if top_k is not None:
            v, _ = torch.topk(logits, min(top_k, logits.size(-1)))
            logits[logits < v[:, [-1]]] = float('-inf')

        # Top-p (nucleus) filtering
        if top_p is not None:
            sorted_logits, sorted_indices = torch.sort(logits, descending=True)
            cumulative_probs = torch.cumsum(F.softmax(sorted_logits, dim=-1), dim=-1)
            sorted_indices_to_remove = cumulative_probs > top_p
            sorted_indices_to_remove[..., 1:] = sorted_indices_to_remove[..., :-1].clone()
            sorted_indices_to_remove[..., 0] = 0
            indices_to_remove = sorted_indices_to_remove.scatter(
                1, sorted_indices, sorted_indices_to_remove
            )
            logits[indices_to_remove] = float('-inf')

        # Sample
        probs = F.softmax(logits, dim=-1)
        idx_next = torch.multinomial(probs, num_samples=1)

        # Append
        idx = torch.cat((idx, idx_next), dim=1)

    return idx
```

The interview hot points:
- **Temperature**: `T < 1` sharpens the distribution (more deterministic), `T > 1` flattens it (more random). `T → 0` is greedy.
- **Top-k**: restrict to the k most likely tokens. Hard cutoff.
- **Top-p (nucleus)**: restrict to the smallest set of tokens whose cumulative probability exceeds p. Adaptive.
- **KV cache**: only feed the last token after the first forward pass. This makes generation O(n) per step instead of O(n²).
- **Repetition penalty**: subtract a constant from previously generated tokens' logits. Prevents loops.

---

## KV Cache (The Big Inference Optimization)

Without KV cache, generating `n` tokens requires recomputing attention for all previous tokens at each step — total work is O(n²). With KV cache, you store the K and V tensors from previous steps and only compute attention for the new token — total work is O(n).

The cache size for one sequence is `2 * n_layers * n_heads * seq_len * head_dim * bytes_per_element`. For a 7B model with 32 layers, 32 heads, head_dim 128, FP16, and 4K context: `2 * 32 * 32 * 4096 * 128 * 2 = 2.1 GB` per request. For multiple concurrent requests, this dominates GPU memory.

The interview classic: "Walk me through the memory math for KV cache."

```python
# KV cache size calculation for LLaMA 7B
n_layers = 32
n_heads = 32
head_dim = 128
seq_len = 4096
bytes_per = 2  # FP16

# 2 for K and V
cache_size = 2 * n_layers * n_heads * seq_len * head_dim * bytes_per
# = 2 * 32 * 32 * 4096 * 128 * 2
# = 2,147,483,648 bytes = 2 GB per request
```

Common KV cache optimizations:
- **GQA**: share K, V heads across multiple query heads. Reduces cache by 4-8x.
- **Multi-Query Attention**: single K, V head for all queries. Maximum savings.
- **PagedAttention (vLLM)**: manage KV cache like virtual memory to reduce fragmentation.
- **Quantization**: 4-bit or 8-bit KV cache. Halves or quarters memory.
- **Sliding window attention**: only cache the last N tokens. Cache size is bounded.

---

## Common Interview Questions and Answers

### Q1: "Implement multi-head self-attention from scratch."

The answer is the `MultiHeadAttention` class above. Key points to mention:
- Q, K, V projections (typically combined into one for efficiency)
- Reshape to `(B, n_heads, T, head_dim)`
- Scaled dot product: `QK^T / sqrt(d_k)`
- Causal mask (additive, with -inf above diagonal)
- Softmax + multiply by V
- Concat heads and project
- (Modern) use `F.scaled_dot_product_attention` for FlashAttention

### Q2: "Implement RoPE."

Show the rotation formula and the cache precomputation. The key insight: rotation is applied to pairs of dimensions, and the angle depends on the position and the dimension index using a frequency schedule.

### Q3: "What's the difference between MHA, MQA, and GQA?"

- **MHA**: H separate K, V heads. Most expressive, biggest cache.
- **MQA**: 1 shared K, V head. Smallest cache, small quality loss.
- **GQA**: G shared K, V heads (1 < G < H). Sweet spot, used in LLaMA 2 70B, Mistral.

Mention that GQA is the practical default now because it gives MQA-like inference speed with MHA-like quality.

### Q4: "Implement a complete transformer training loop from scratch."

Show the full loop: data loading, model, optimizer, scheduler, forward, loss, backward, clip, step, zero_grad. Include evaluation in eval mode with `torch.no_grad()`. Mention gradient checkpointing for memory.

### Q5: "How does the KV cache work, and what's its memory cost?"

Show the cache structure and the memory calculation. The trick is recognizing that the cache size scales linearly with sequence length, batch size, and model size. Mention optimizations: GQA, PagedAttention, quantization.

### Q6: "Implement top-p (nucleus) sampling."

Show the algorithm: sort by probability, compute cumulative sum, find the cutoff where cumsum > p, mask out the rest, sample from the remaining.

### Q7: "What's the difference between pre-norm and post-norm? Which is used today?"

Pre-norm (LayerNorm before sublayer) is standard. Post-norm (original paper) needs careful warmup. Pre-norm is more stable and easier to train.

### Q8: "Implement weight tying."

`self.lm_head.weight = self.tok_emb.weight` — both refer to the same Parameter. Saves `vocab_size * d_model` parameters, often improves quality.

### Q9: "Walk me through the attention computation step by step."

Input: `(B, T, d_model)`. Project to Q, K, V (all `(B, T, d_model)`). Reshape to `(B, n_heads, T, head_dim)`. Compute `QK^T / sqrt(d_k)` → `(B, n_heads, T, T)`. Add mask. Softmax. Multiply by V → `(B, n_heads, T, head_dim)`. Concat and project → `(B, T, d_model)`.

### Q10: "How do you make a transformer faster at inference?"

KV cache (10-100x), speculative decoding (2-3x), quantization (2-4x), batching (proportional to batch size), FlashAttention (2-4x), continuous batching, paged attention. Combine these for the best results.

---

## Debugging Checklist

When the model doesn't learn, check in order:

1. **Shapes**: print shape of every intermediate tensor. Most bugs are shape mismatches.
2. **Mask**: are you masking padding tokens? Is the causal mask correct?
3. **Learning rate**: too high → loss explodes. Too low → loss doesn't move.
4. **Gradient flow**: print `param.grad.norm()` occasionally. Should be nonzero.
5. **Loss curves**: does train loss go down? If only val loss goes up, you're overfitting.
6. **Tokenization**: are special tokens handled correctly? Is the EOS token consistent?
7. **Data**: are labels correct? Is the dataset shuffled?
8. **Numerical**: any NaN or Inf in loss? Add gradient clipping.

The interview debugging question: "My loss is NaN, what do you do?" The standard answer: gradient clip, reduce LR, check for log(0) in the loss, check for data issues (e.g., empty sequences), check for overflow in attention (use FlashAttention).

---

## The "Implementation From Scratch" Checklist

Before an ML coding interview, make sure you can implement each of these in 10-15 minutes from blank:

- [ ] Tensor operations: matmul, einsum, broadcasting
- [ ] nn.Module subclass with `__init__` and `forward`
- [ ] Training loop with zero_grad, forward, backward, clip, step
- [ ] Custom loss function
- [ ] Cross-entropy from scratch (just softmax + NLL)
- [ ] Layer norm / RMS norm
- [ ] Multi-head self-attention (the big one)
- [ ] Causal mask
- [ ] RoPE positional encoding
- [ ] Transformer block (pre-norm)
- [ ] SwiGLU FFN
- [ ] Full transformer LM forward pass
- [ ] Weight tying
- [ ] KV cache
- [ ] Top-p sampling
- [ ] Generation loop with cache
- [ ] Adam optimizer from scratch (bonus)
- [ ] BPE tokenizer (bonus, for tokenization-heavy roles)

The first time you do these, expect to spend 1-2 hours on each. After a few days of practice, you should be able to do attention in 25 minutes and a full transformer in an hour.

For interview day, the highest-leverage practice is implementing a transformer block, the full LM, and the generation loop from scratch. Most interviewers will let you pick which component to implement, and these cover the entire stack.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Transformer = attention + feed-forward + layer norm + residual connections.
- Self-attention: Q, K, V = linear projections of input; attention = softmax(QK^T/sqrt(d_k))V.
- Multi-head: split into multiple heads, attend separately, concatenate.
- Positional encoding: sinusoidal or learned, adds position info to embeddings.
- Causal mask: prevent attending to future tokens (for autoregressive generation).

**Common Follow-Up Questions:**
- "Why divide by sqrt(d_k) in attention?" — Scales dot products to prevent softmax saturation. Without scaling, large d_k makes dot products large, pushing softmax to one-hot (vanishing gradients).
- "How does KV cache work?" — Cache K and V from previous tokens. For each new token, only compute Q, attend against cached K and V. O(1) per token instead of O(n).

**Gotcha:** Forgetting the causal mask in autoregressive models. Without it, the model attends to future tokens during training, which is impossible at inference time. The mask sets future attention scores to -inf before softmax.
