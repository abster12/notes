---
title: "LLM Serving at Scale (vLLM, Quantization, Batching, KV Cache)"
type: system-design
category: AI/ML
date: 2026-06-22
tags: [system-design, interview, ai-ml, llm-serving, vllm, quantization, batching, kv-cache, pagedattention, continuous-batching, gptq, awq, tensor-parallelism, staff-engineering]
aliases: ["LLM Serving at Scale", "vLLM", "LLM Inference", "KV Cache", "PagedAttention", "Continuous Batching", "LLM Quantization"]
---

# LLM Serving at Scale (vLLM, Quantization, Batching, KV Cache)

> **Staff-Engineer Focus:** "We deploy the model behind an API and it generates text" is the junior answer. "We use vLLM with continuous batching and FP16" is the mid-level answer. **The staff engineer doesn't ask which serving framework to use. They ask: "What is our token generation throughput per GPU-dollar at P99 latency? How does KV cache memory fragmentation degrade our max batch size under bursty traffic with varying sequence lengths? When we quantize to INT4, what's the perplexity delta on our specific prompt distribution — not the benchmark average? If we shard the model across 8 GPUs with tensor parallelism, what is the all-reduce bubble time per transformer layer, and is pipeline parallelism actually cheaper at our batch sizes? When a request with 32K context arrives mid-batch, does our prefix caching hit rate collapse because we evicted the system prompt's KV blocks from the previous batch? And critically — during a rolling model upgrade, how do we avoid dropping in-flight requests whose KV caches are incompatible with the new weights?"** The interview question isn't "What is KV cache?" It's: "You're serving Llama-3-70B to 10,000 concurrent users. P50 latency is 200ms but P99 is 4.5 seconds. Memory is 85% utilized but 30% of that is fragmentation — KV blocks from finished requests that aren't reusable because they're interleaved with active request blocks. Global batch size is 128 but effective batch size drops to 40 during P99 spikes because the scheduler can't pack sequences efficiently. Walk me through: (a) exactly what fragmentation means in the context of PagedAttention and why it causes effective batch size collapse, (b) how prefix-aware scheduling would change the picture if 80% of your traffic shares a 4K-token system prompt, (c) whether switching from FP16 to INT4 quantization helps or hurts the fragmentation problem — and the secondary effect on attention computation that nobody talks about, and (d) what a proper canary deployment looks like when you can't just kill pods because in-flight requests hold unrecoverable KV cache state."**

---

## Summary & Interview Framing

The infrastructure for serving LLM inference at scale — managing KV cache memory, batching concurrent requests, and quantizing weights to reduce cost.

**How it's asked:** "Design an LLM serving system for 10K concurrent users on Llama-3-70B with P99 <300ms. Cover KV cache management, continuous batching, quantization trade-offs, and rolling deployments."

---

## 1. The LLM Inference Problem

### 1.1 Autoregressive Generation Is Fundamentally Different

Unlike traditional ML serving (classification, embedding extraction) which is a single forward pass, LLM inference is **autoregressive** — generate one token, feed it back as input, generate the next. For a 500-token response from a 70B model:

```
1 forward pass per token × 500 tokens = 500 sequential forward passes
Each forward pass computes attention over ALL previous tokens
Total computation: O(n² · d) per sequence where n = sequence length, d = model dimension
```

This creates three compounding bottlenecks that don't exist in traditional model serving:

| Bottleneck | Traditional ML | LLM Inference |
|------------|---------------|---------------|
| **Compute** | One pass, fixed cost | N passes, O(n²) attention |
| **Memory** | Fixed model weights only | Weights + growing KV cache per sequence |
| **Batching** | Static, homogeneous inputs | Dynamic, variable-length, stateful |

### 1.2 The Memory Wall

A 70B parameter model in FP16:

```
Model weights: 70B × 2 bytes = 140 GB
That alone requires 2× A100-80GB or 4× A100-40GB just to load the model
```

But weights are only half the story. The **KV cache** — storing key and value tensors for every token in every active sequence — is the real memory killer:

```
KV cache per token (Llama-3-70B):
  - 80 layers × 2 (K,V) × 8 KV heads × 128 dim × 2 bytes = ~328 KB per token
  - For 128 concurrent sequences of 4096 tokens each:
    128 × 4096 × 328 KB = ~172 GB of KV cache alone
  - Total GPU memory: 140 GB (weights) + 172 GB (KV cache) = 312 GB
  - That's 4× A100-80GB — and we haven't even run a forward pass yet
```

**This is why KV cache management is the single most important optimization in LLM serving.** Everything else — batching, scheduling, quantization — exists in the shadow of this memory constraint.

---

## 2. KV Cache: The Core Mechanism

### 2.1 What Gets Cached and Why

During autoregressive generation, the causal attention mask means token `t` only attends to tokens `0..t`. When generating token `t+1`, we recompute attention for ALL previous tokens if we don't cache:

```
Without cache: O(t²) per new token
With cache: O(t) per new token — we only compute attention for the new token
```

The KV cache stores the **Key** and **Value** projections for every token that has been generated so far. When a new token arrives, we compute its Q, K, V, append K and V to the cache, then compute attention of Q against ALL cached K,V pairs.

**Critical detail:** The KV cache is per-layer and per-attention-head. For Llama-3-70B with GQA (Grouped Query Attention) — 64 query heads but only 8 KV heads — the KV cache is 8× smaller than it would be with full MHA. This architectural choice is explicitly about reducing KV cache memory.

### 2.2 The Prefill vs. Decode Distinction

This is where most mid-level engineers get fuzzy. LLM serving has TWO distinct phases:

| Phase | What Happens | Compute | Memory | Bottleneck |
|-------|-------------|---------|--------|------------|
| **Prefill** | Process the entire input prompt in one forward pass | Compute-bound (O(n²) attention over prompt) | KV cache allocated for all prompt tokens | FLOPs, not memory |
| **Decode** | Generate one token at a time autoregressively | Memory-bound (O(n) per step, but memory bandwidth limited) | KV cache grows by 1 token per step | Memory bandwidth |

**The prefill phase is compute-bound** — the GPU is doing massive parallel matrix multiplications over the full prompt. **The decode phase is memory-bound** — for each new token, we're limited by how fast we can read the KV cache from HBM into SRAM, not by compute.

This distinction is why continuous batching works: you can interleave prefill of new requests with decode of existing ones to maximize GPU utilization.

### 2.3 PagedAttention: The vLLM Innovation

Before PagedAttention (vLLM, June 2023), frameworks allocated KV cache as one contiguous block per sequence. If a sequence might generate up to 2048 tokens, you pre-allocated 2048 slots — even if it finished at 50 tokens. This is the same problem virtual memory solved for OS in the 1960s.

**PagedAttention** treats the KV cache like virtual memory pages:

```
Traditional: [============2048 slots pre-allocated============] — 90% wasted for short generations
PagedAttention: [Block0][Block1][Block2]...[BlockN] — allocated on demand in fixed-size blocks (e.g., 16 tokens)
```

| Aspect | Traditional (Contiguous) | PagedAttention |
|--------|--------------------------|----------------|
| **Allocation** | Pre-allocate max length | Allocate blocks on demand |
| **Fragmentation** | External: unused pre-allocated space | Internal: partially-filled last block (max 15 tokens wasted) |
| **Memory waste** | Up to 90% for variable-length outputs | < 4% (only last block waste) |
| **Sharing** | Impossible: each sequence owns its cache | **Block-level sharing** for prefix caching, beam search |
| **Throughput gain** | Baseline | 2-4× higher throughput via higher batch sizes |

**The key insight:** By decoupling logical sequences from physical KV cache blocks, vLLM can pack more concurrent sequences into the same GPU memory, increasing batch size and therefore throughput. A block table (analogous to a page table) maps logical token positions to physical blocks.

---

## 3. Batching Strategies

### 3.1 Static Batching (The Old Way)

Static batching pads all sequences to the same length and runs them together. If one sequence is 10 tokens and another is 500, both get padded to 500 — the short one wastes 98% of its compute and memory.

```
Static batch of 4 sequences, max length 500:
Seq1: [10 tokens + 490 PAD tokens] — 98% waste
Seq2: [500 tokens] — OK
Seq3: [50 tokens + 450 PAD tokens] — 90% waste
Seq4: [200 tokens + 300 PAD tokens] — 60% waste
Effective utilization: 38%
```

### 3.2 Continuous (In-Flight) Batching

Continuous batching, popularized by TGI and vLLM, treats the batch as a dynamic set. Requests enter and leave the batch independently:

```
Time ──────────────────────────────────────────────►
Batch: [R1▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮]
          [R2▮▮▮▮▮▮▮▮▮▮▮▮] → finished, evicted
             [R3 enters → ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮]
                [R4▮▮▮▮▮▮▮▮] → finished, evicted
                   [R5 enters → ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮]
```

At each step, the scheduler picks which sequences participate in the next forward pass. This is NOT trivial — you can't just throw all active sequences into every batch because of the memory-bandwidth bottleneck in decode.

**The scheduling decision at each step:** How many sequences to batch? Too few → GPU underutilized. Too many → each sequence gets less memory bandwidth, per-token latency increases for everyone. This is the **batch size vs. latency trade-off** that makes LLM serving fundamentally different from stateless API serving.

### 3.3 Iteration-Level Scheduling

vLLM schedules at the granularity of individual forward passes (iterations), not requests. At each iteration:

1. **Select a batch:** Pick N sequences whose combined KV cache fits in available blocks
2. **Run one forward pass** for all N sequences
3. **Append new KV block** for each sequence that generated a token
4. **Check for completions** — evict finished sequences, free their blocks
5. **Admit new requests** if space available (run prefill for them)

This is why vLLM achieves 2-4× higher throughput than static batching — the batch is always full of work, and no GPU cycles are wasted on padding.

---

## 4. Quantization: Trading Precision for Throughput

### 4.1 The Precision Spectrum

| Precision | Bits/Weight | 70B Model Size | Perplexity Impact | Use Case |
|-----------|-------------|----------------|-------------------|----------|
| FP32 | 32 | 280 GB | 0 (reference) | Training |
| FP16/BF16 | 16 | 140 GB | ~0 | Standard serving |
| INT8 | 8 | 70 GB | +0.1–0.5 | High-quality serving |
| INT4 (GPTQ) | 4 | 35 GB | +0.5–2.0 | Throughput-optimized |
| INT4 (AWQ) | 4 | 35 GB | +0.3–1.5 | Better than GPTQ for most models |
| FP4 (NF4) | 4 | 35 GB | +0.5–2.0 | QLoRA training |
| INT3 | 3 | 26 GB | +3.0–8.0 | Extreme compression |
| INT2 | 2 | 17.5 GB | +15–50 | Usually unusable |

### 4.2 GPTQ vs. AWQ: The Calibration Difference

Both are post-training quantization (PTQ) methods that compress to INT4, but they differ fundamentally in what they optimize:

**GPTQ (Frantar et al., 2023):**
- Quantizes weights layer by layer, minimizing the L2 error between quantized and original layer outputs
- Uses a Hessian-based approach: weights that matter more get higher precision implicitly through the optimization
- Requires a calibration dataset (~128 samples)
- **Problem:** Treats all activations as equally important — the "salience" of each weight is determined by average activation magnitude, not per-channel importance

**AWQ (Lin et al., 2024):**
- Identifies that ~1% of "salient" weight channels carry most of the information
- Instead of keeping those channels at higher precision, it scales them UP before quantization and scales activations DOWN accordingly
- This is mathematically equivalent but avoids mixed-precision hardware complexity
- **Result:** Better perplexity than GPTQ at the same bit width, especially for smaller models

**The interview trap:** Saying "AWQ is better than GPTQ" without explaining WHY. The interviewer wants to hear: "AWQ identifies that only ~1% of channels are salient and scales them to preserve information, rather than trying to minimize per-layer L2 error which treats all channels equally. This exploits the observation that LLM weight distributions have heavy-tailed channel importance, and protecting the tail is what matters for generation quality."

### 4.3 Quantization's Hidden Cost: Attention Degradation

**This is the thing nobody talks about in interviews but every staff engineer should know:**

When you quantize weights to INT4, you save 4× on the weight memory. But the KV cache — which is computed FROM those weights during the forward pass — is typically kept in FP16. Why? Because KV cache values are dynamic (they change per sequence, per token) and quantizing them on-the-fly would add latency.

However, there's a subtle secondary effect: quantized weights produce slightly degraded K and V projections, which means the attention scores are computed over slightly degraded representations. This compounds with sequence length:

```
FP16 attention: O(n² · d) with full precision K,V → high fidelity attention
INT4 attention: O(n² · d) with degraded K,V → attention drift at long context
```

For short sequences (< 2K tokens), this is negligible. For long context (32K+), the accumulated attention error from degraded KV representations can cause the model to "lose track" of early information — the same vectors that should attend to paragraph 1 now attend more weakly, redistributing attention mass incorrectly.

**The staff answer:** "We use INT4 for weights but keep KV cache in FP16. For long-context workloads (>16K), we should measure attention drift — how much does the attention distribution change vs. FP16 baseline at each position — not just perplexity. If drift exceeds 5% at the farthest positions, we either keep the first N layers in FP16 (where attention patterns are most sensitive), or we use INT8 for KV cache instead."

---

## 5. Prefix Caching: The 80/20 Win

### 5.1 The Observation

In production LLM applications (chatbots, coding assistants, RAG), a large fraction of requests share a common prefix:

```
System prompt (4K tokens): "You are a helpful assistant. Here are the rules..." ← SHARED
User message (variable): "What is the capital of France?" ← UNIQUE
```

If 100 concurrent requests share a 4K-token system prompt, computing and storing 100 separate KV caches for that prefix wastes 100× the memory and compute.

### 5.2 Automatic Prefix Caching (APC) in vLLM

vLLM's PagedAttention block structure enables this naturally: the KV blocks for the shared prefix are computed once and referenced by all sequences via their block tables.

```
Request 1: [Block A][Block B][Block C][Block D] — Blocks A,B = system prompt KV
Request 2: [Block A][Block B][Block E][Block F] — Shares A,B via reference counting
Request 3: [Block A][Block B][Block G]        — Shares A,B
```

**Memory savings:** If the system prompt is 4096 tokens (256 blocks of 16 tokens), and you have 128 concurrent requests, prefix caching saves: `256 blocks × 127 copies × (block_size × KV_size_per_token)` = potentially tens of GB.

**The hash-based matching:** vLLM computes a hash of each block's input tokens. When a new request arrives, it checks if its initial tokens match any existing block hashes. If yes, it reuses those blocks. This is O(1) lookup per block.

### 5.3 The Fragmentation Problem Revisited

Here's where prefix caching interacts poorly with fragmentation. When shared prefix blocks are reference-counted (used by multiple sequences), they cannot be freed until ALL sequences using them finish. If one slow request (generating 2000 tokens) references the shared prefix block while 127 other requests have finished, that block stays in memory — and may prevent new prefix blocks from being allocated contiguously.

**The staff-level insight:** The block allocator needs a **defragmentation** or **compaction** mechanism — copy live blocks to consolidate free space, analogous to garbage collection compaction. vLLM v0.6+ implements this as "block swapping" where blocks can be swapped to CPU RAM and back. This adds latency but prevents OOM under fragmentation.

---

## 6. Model Parallelism: When One GPU Isn't Enough

### 6.1 Tensor Parallelism (TP)

Split individual weight matrices across GPUs. Each GPU holds a slice of every layer:

```
Layer N attention weight matrix W_Q: [8192 × 8192]
GPU 0: W_Q[0:4096, :]  — first half of columns
GPU 1: W_Q[4096:8192, :] — second half of columns

Forward pass: each GPU computes its slice, then All-Reduce to combine
```

| Property | Tensor Parallelism |
|----------|-------------------|
| **Communication** | All-reduce after EVERY layer (80 layers = 80 all-reduces) |
| **Bandwidth requirement** | NVLink/NVSwitch (900 GB/s) — cannot work over PCIe |
| **Scaling limit** | ~8 GPUs max (all-reduce latency dominates beyond this) |
| **Latency impact** | Per-layer overhead: ~50-100μs for all-reduce on NVLink |

### 6.2 Pipeline Parallelism (PP)

Split layers across GPUs. GPU 0 handles layers 0-19, GPU 1 handles layers 20-39, etc.:

```
GPU 0: Embedding → Layer 0 → ... → Layer 19 → send to GPU 1
GPU 1: receive → Layer 20 → ... → Layer 39 → send to GPU 2
...
```

**The pipeline bubble:** Between micro-batches, GPUs sit idle waiting for data. This is the fundamental efficiency loss of PP.

```
Time ─────────────────────────────────────────►
GPU 0: [MB0▮▮▮▮▮▮][MB1▮▮▮▮▮▮][MB2▮▮▮▮▮▮][idle]
GPU 1: [idle      ][MB0▮▮▮▮▮▮][MB1▮▮▮▮▮▮][MB2▮▮▮▮▮▮]
                              ↑ bubble = idle time
```

Bubble fraction ≈ `(P-1) / M` where P = pipeline stages, M = micro-batches. More micro-batches → smaller bubble, but higher latency.

### 6.3 The TP vs. PP Decision at Staff Level

| Criterion | Tensor Parallelism | Pipeline Parallelism |
|-----------|-------------------|---------------------|
| **Intra-node (8 GPUs)** | ✅ Use TP (NVLink is fast enough) | ❌ Bubble dominates at small scale |
| **Inter-node (16+ GPUs)** | ❌ All-reduce over network kills latency | ✅ Use PP between nodes, TP within nodes |
| **Batch size** | Works with any batch size | Needs large micro-batch count to amortize bubble |
| **Latency sensitivity** | Higher latency (all-reduce per layer) | Higher latency (bubble + inter-stage comm) |
| **Throughput focus** | ✅ Use TP | ✅ Use PP (bubble amortized over large batches) |

**The hybrid approach (used in practice):** TP within a node (8 GPUs via NVLink), PP across nodes. This is what "TP=8, PP=4" means — 32 GPUs total, organized as 4 pipeline stages of 8 GPUs each with tensor parallelism.

---

## 7. The Interview Question

### ⚡ Sharp Question

> **"You're running Llama-3-70B on 4× A100-80GB GPUs using vLLM with PagedAttention, serving a chatbot with a 4K-token system prompt and highly variable user message lengths (10 to 3000 tokens). Your P50 latency is 150ms and throughput is 800 tokens/sec across all users. Then you push a model update that adds 8K tokens of RAG context to EVERY request (total prefix now 12K). Immediately, P50 latency jumps to 2.8 seconds and throughput drops to 90 tokens/sec. Your GPU memory shows 92% utilization but `nvidia-smi` shows GPU utilization at only 15%. What happened, and how do you fix it?"**

### ✅ Model Answer

**What happened (diagnosis):**

The 12K prefix pushed the system into a memory-bandwidth-bound decode regime. Here's the chain:

1. **KV cache explosion:** Adding 8K tokens to every request's prefix means every sequence now has at least 12K tokens of KV cache. At ~328 KB per token, that's ~3.9 GB of KV cache per sequence. With 4× A100-80GB (320 GB total), subtracting 35 GB for INT4 quantized weights (or 140 GB for FP16), the remaining memory can hold fewer concurrent sequences.

2. **Batch size collapse:** Where you previously fit 80 concurrent sequences, you now fit maybe 12-15. Continuous batching can't pack enough work to keep the GPU busy — that's why GPU utilization is 15%.

3. **The decode bottleneck:** Even for those 15 sequences, each forward pass in decode mode is bottlenecked on reading the 12K-token KV cache from HBM. The GPU's tensor cores are mostly idle waiting for memory. 15% utilization with 92% memory usage is the classic signature of a memory-bandwidth-bound workload.

4. **P50 latency spike:** With only 15 sequences in the batch and each decode step taking ~190ms (memory-bound), the P50 per-token latency is now 190ms instead of the previous ~2ms. A 15-token response now takes 2.8 seconds end-to-end.

**How to fix it (layered approach):**

| Fix | Mechanism | Expected Gain | Trade-off |
|-----|-----------|---------------|-----------|
| **Prefix caching** | Share 12K prefix KV blocks across all requests | Frees ~3.6 GB per additional concurrent sequence | None — this is purely upside for shared-prefix workloads |
| **INT4 KV cache quantization** | Quantize KV cache to INT4 (not just weights) | 4× KV cache reduction, ~4× more sequences in batch | Perplexity +0.3–1.0; test on your prompt distribution |
| **Add GPUs (scale out)** | 8× A100 instead of 4 | Double the KV cache capacity | Cost; requires TP=8 configuration |
| **Chunked prefill** | Split the 12K prefill into chunks interleaved with decode | Smooths latency; prevents prefill from starving decode | Slightly higher per-token latency for prefill |
| **Reduce RAG context** | Retrieve top-2K instead of top-8K chunks | Proportional KV cache reduction | May reduce answer quality; test retrieval recall |

**The most impactful single fix:** Enable automatic prefix caching (APC) in vLLM. If ALL requests share the same 12K system+RAG prefix, the KV cache for that prefix is stored ONCE and shared across all sequences. This immediately recovers the batch size you lost.

### ❗ Common Pitfall

**"Let's just add more GPUs"** — without understanding WHY the existing GPUs are underutilized. Throwing hardware at a memory-bandwidth problem without fixing the memory efficiency first is how you burn cloud budget without improving user experience. The real answer is: diagnose the bottleneck (memory bandwidth → investigate KV cache utilization and fragmentation → enable prefix caching → only then consider scaling horizontally). Staff engineers fix the bottleneck, not the symptom.

---

## 8. Self-Check Questions (Cron-Job Format)

Since this session is self-paced, test yourself:

1. **Can you explain why KV cache is the memory bottleneck rather than model weights?** (Hint: weights are fixed; KV cache grows linearly with both sequence length AND batch size.)

2. **What's the difference between internal and external fragmentation in PagedAttention, and which one dominates?** (Internal = partially-filled last block, max 15 tokens per sequence — negligible. External would be free blocks scattered among allocated blocks — this is what block swapping addresses.)

3. **Why does continuous batching improve throughput by 2-4× over static batching?** (Static batches waste compute on padding; continuous batching keeps the batch full of real work and interleaves prefill and decode.)

4. **When would you choose pipeline parallelism over tensor parallelism?** (Inter-node setups where network bandwidth can't support all-reduce per layer; or when batch sizes are large enough to amortize the pipeline bubble.)

5. **What does prefix caching save that naive KV cache sharing doesn't?** (It saves the COMPUTE of the prefill phase for shared prefixes, not just the memory. Without prefix caching, each request independently computes the KV projections for the shared prefix.)

6. **If P99 latency is 10× P50, what are three possible causes specific to LLM serving?** (a) Prefill of a long request stalling all decode in the batch, b) KV cache fragmentation causing scheduler to reduce batch size, c) Garbage collection / block compaction triggering mid-request.)

---

## Related
- [[topic-queue]]
- [[Vector Database Internals (HNSW, IVF, Sharding)]] — Previous Day 46
- [[RAG Pipeline (Chunking, Embeddings, Retrieval, Reranking)]] — Day 45, closely related
- [[Fine-Tuning Infrastructure (LoRA, QLoRA, Distributed Training)]] — Next up, Day 48
- [[Weakness Vault/Day-47-LLM-Serving-at-Scale]]

---

## Interview Cheat Sheet

**Key Points to Remember:**
- KV cache is the dominant memory consumer — not model weights. A 7B model at FP16 needs 14GB for weights but 30GB+ for KV cache at 32K context
- vLLM's PagedAttention manages KV cache like virtual memory — reduces fragmentation and increases effective batch size
- Continuous batching: dynamically add/remove requests from a batch, unlike static batching which waits for the whole batch
- Quantization (INT8/INT4) reduces memory and speeds inference with ~1-3% quality loss
- Throughput vs latency trade-off: larger batches = higher throughput but higher per-request latency

**Common Follow-Up Questions:**
- "How do you serve multiple LoRA adapters efficiently?" — Keep base model fixed, load adapters dynamically. vLLM supports multi-LoRA serving with adapter swapping.
- "What's the cost of tensor parallelism?" — All-reduce communication after each transformer layer adds latency. Use NVLink/InfiniBand to minimize; otherwise pipeline parallelism may be better.

**Gotcha:**
- Prefix caching (sharing KV cache for common system prompts) can dramatically improve throughput, but if the system prompt changes mid-batch, the cache is invalidated and throughput drops. Design for prompt stability.
