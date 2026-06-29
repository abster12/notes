---
title: "Fine-Tuning Infrastructure (LoRA, QLoRA, Distributed Training)"
type: system-design
category: AI/ML
date: 2026-06-23
tags: [system-design, interview, ai-ml, fine-tuning, lora, qlora, distributed-training, fsdp, ddp, peft, gradient-checkpointing, mixed-precision, staff-engineering]
aliases: ["Fine-Tuning Infrastructure", "LoRA", "QLoRA", "Distributed Training", "PEFT", "Fine-Tuning at Scale"]
---

# Fine-Tuning Infrastructure (LoRA, QLoRA, Distributed Training)

> **Staff-Engineer Focus:** "We fine-tune with LoRA on a single GPU" is the junior answer. "We use QLoRA with 4-bit quantization and FSDP" is the mid-level answer. **The staff engineer doesn't ask which PEFT method to use. They ask: "For our customer-specific LoRA adapters serving 500 tenants, each adapter is 8 MB but we have 500 of them — that's 4 GB of adapter weights. When a batch contains requests from 47 different tenants, does our inference server materialize all 47 adapters in GPU memory simultaneously, or do we fuse the adapter weights into the base model's forward pass lazily? If we pre-merge, the base model weights change and we lose adapter isolation — one tenant's fine-tune bleeds into another's. If we keep them separate, the adapter-switching overhead per forward pass adds latency per tenant switch in the batch. For distributed fine-tuning across 64 GPUs, we're using FSDP to shard the base model but LoRA adapters are tiny — do they even need sharding? If not, every GPU holds a full copy of every tenant's adapter, and our all-gather for the base model weights is a rounding error compared to the adapter duplication. And when we QLoRA fine-tune on a single A100, the NF4 quantization means the base model is frozen in 4-bit — but our downstream inference runs in FP16. Walk me through: (a) the exact precision mismatch between 4-bit training and 16-bit inference and whether the adapter weights trained in the 4-bit space generalize correctly to 16-bit forward passes, (b) how you'd design the adapter storage layer so that hot-swapping 500 LoRA adapters at inference time doesn't require 500 separate model reloads, (c) the failure mode when fine-tuning runs are distributed across spot instances and a single preemption corrupts the global FSDP state."** The interview question isn't "Explain LoRA." It's: "You have 500 customers, each needing a personalized LoRA adapter on Llama-3-70B. Fine-tuning throughput is 4 adapters per hour on 8×A100. Inference must serve all 500 tenants simultaneously with P99 latency under 300ms. Design the full pipeline: training orchestration, adapter storage, and inference serving. Where does your system break first, and what do you measure to know it's about to break?"**

---

## Summary & Interview Framing

Infrastructure for adapting pre-trained LLMs to specific tasks — LoRA trains small adapter matrices instead of all weights, QLoRA adds 4-bit quantization for single-GPU fine-tuning.

**How it's asked:** "Design a fine-tuning pipeline for 500 customer-specific LoRA adapters on Llama-3-70B. Handle distributed training, adapter storage, multi-tenant serving, and quality validation."

---

## 1. The Fine-Tuning Problem Landscape

### 1.1 Full Fine-Tuning vs. Parameter-Efficient Fine-Tuning (PEFT)

Fine-tuning is the process of adapting a pre-trained model to a specific task or domain by continuing training on new data. The naive approach — full fine-tuning — updates every parameter in the model. For a 70B model, that means:

```
Full fine-tuning of Llama-3-70B:
  - Optimizer states (AdamW): 70B × 8 bytes (fp32 master) + 70B × 4 bytes (momentum)
    + 70B × 4 bytes (variance) = 1.12 TB
  - Gradients: 70B × 2 bytes (fp16) = 140 GB
  - Model weights: 70B × 2 bytes (fp16) = 140 GB
  - Activations (checkpointed): ~200 GB for batch size 1, seq len 4096
  - Total minimum: ~1.6 TB of GPU memory for a single training step
  - That's 20× A100-80GB — not for training speed, just to avoid OOM
```

PEFT methods solve this by freezing most parameters and training only a small subset. The taxonomy matters for system design:

| Method | Trainable Params | Storage per Adapter | Training Memory | Inference Overhead |
|--------|-----------------|---------------------|-----------------|-------------------|
| **Full FT** | 100% (70B) | 140 GB | ~1.6 TB | None (model replaced) |
| **LoRA** | ~0.1-1% (7M-70M) | 8-80 MB | ~200 GB (1×A100-80GB for 70B) | +2-5% latency |
| **QLoRA** | ~0.1-1% | 8-80 MB | ~48 GB (1×A100-80GB, model in 4-bit) | +2-5% latency + dequant |
| **Prefix Tuning** | ~0.01% | <1 MB | ~160 GB | +1% latency |
| **IA³** | ~0.01% | <1 MB | ~160 GB | +1% latency |
| **Adapter Layers** | ~1-3% | 100-300 MB | ~250 GB | +3-8% latency |

### 1.2 The Multi-Tenant Adapter Problem

The staff-engineer insight: PEFT doesn't just reduce training cost — it creates a **new system architecture** where the base model is a shared platform and adapters are lightweight per-tenant customizations. This fundamentally changes infrastructure requirements:

```
                    +------------------------------------------+
                    |        Inference Gateway                 |
                    |  (routes tenant_id -> adapter_id)        |
                    +------------------+-----------------------+
                                       |
                    +------------------+-----------------------+
                    |         Adapter Cache (GPU)              |
                    |  +-----+ +-----+ +-----+       +-----+  |
                    |  |Ten1 | |Ten2 | |Ten3 | ...   |TenN |  |
                    |  | 8MB | | 8MB | | 8MB |       | 8MB |  |
                    |  +-----+ +-----+ +-----+       +-----+  |
                    |  LRU eviction when GPU memory tight      |
                    +------------------+-----------------------+
                                       |
                    +------------------+-----------------------+
                    |      Base Model (Frozen, FP16)           |
                    |      70B params / 4 GPUs (TP=4)          |
                    |      GPU 0  |  GPU 1  | GPU 2 | GPU 3   |
                    +------------------+-----------------------+
                                       |
                    +------------------+-----------------------+
                    |       Adapter Object Store (S3)          |
                    |  tenant_001/lora/adapter_config.json     |
                    |  tenant_001/lora/adapter_model.safetensors|
                    |  tenant_002/lora/...                     |
                    +------------------------------------------+
```

The key system design question: **Do you merge adapters into the base model or keep them separate?** This is the adapter isolation vs. throughput trade-off:

| Approach | Adapter Isolation | Throughput | Hot-Swap Speed | Memory Overhead |
|----------|------------------|------------|----------------|-----------------|
| **Pre-merge** (W' = W + BA) | No (shared model, bleed risk) | Best (no overhead) | Slow (model reload, minutes) | None (merged) |
| **Separate forward** (y = Wx + BAx) | Yes (isolated per-request) | Good (+2-5% latency) | Fast (<1ms adapter swap) | BA matrices in GPU |
| **LoRAX / Punica** (CUDA kernel fusion) | Yes (isolated) | Best (near-zero overhead) | Fast (<1ms swap) | Adapter weights in GPU |

---

## 2. LoRA: Low-Rank Adaptation

### 2.1 The Core Insight

The hypothesis behind LoRA: during fine-tuning, the **weight updates (delta_W) have low intrinsic rank**. Instead of learning delta_W directly (a d×d matrix), LoRA decomposes it into two low-rank matrices:

```
delta_W = B × A    where B in R^(d×r), A in R^(r×k), and r << min(d,k)

Forward pass: h = W_0 * x + delta_W * x = W_0 * x + B * A * x

              +-----------------------------------+
              |      Pre-trained Weight W_0       |
              |         (d_out × d_in)            |
              |           FROZEN                   |
              +---------------+-------------------+
                              |  W_0 * x
                              v
              +-------------------------------+
   Input x -->|            SUM                |--> Output h
              +---------------^---------------+
                              |  B * A * x
              +---------------+---------------+
              |     B (d_out × r)             |
              |      TRAINABLE                |
              +---------------^---------------+
                              |
              +---------------+---------------+
              |     A (r × d_in)              |
              |      TRAINABLE                |
              +---------------^---------------+
                              |
                         Input x
```

With r=16 and d=4096, the trainable parameters drop from 16.8M (full matrix) to 131K (LoRA) — a **128× reduction**. This is why LoRA fits on a single GPU for 70B models.

### 2.2 Where to Apply LoRA

LoRA is typically applied to the attention projection matrices — Q, K, V, O. The choice of which layers to target is itself a design decision:

```
Layer types in a transformer block:
+------------------------------------------------------+
|                 Transformer Block                     |
|                                                       |
|  +---------+   +---------+   +---------+              |
|  | Q_proj  |   | K_proj  |   | V_proj  |  <-- LoRA   |
|  | (LoRA)  |   | (LoRA)  |   | (LoRA)  |              |
|  +----+----+   +----+----+   +----+----+              |
|       +-------------+-------------+                    |
|                     v                                  |
|              +---------------+                        |
|              |   Attention   |                        |
|              +-------+-------+                        |
|                      v                                |
|  +-----------------------------------+                |
|  |           O_proj (LoRA)           |  <-- LoRA      |
|  +---------------+-------------------+                |
|                  v                                    |
|  +-----------------------------------+                |
|  |         Feed-Forward (MLP)        |                |
|  |  gate_proj | up_proj | down_proj  |  <-- Optional |
|  +-----------------------------------+                |
+------------------------------------------------------+

Standard: LoRA on Q, K, V, O --> ~0.1% of total params
Extended: LoRA on Q, K, V, O + MLP --> ~0.3% of total params
Full block: every linear layer --> ~0.5% of total params
```

**Staff-level nuance:** Adding LoRA to more layers improves expressivity but increases adapter size linearly. With 500 tenants, every extra 8 MB per adapter adds 4 GB to the inference cache. The system designer must find the **adapter-size-to-quality Pareto frontier** for their specific use case.

### 2.3 Rank Selection (r) — The Silent Knob

The rank `r` controls the adapter's capacity. Higher r = more expressivity = larger adapter:

```
r = 4:   adapter ~ 2 MB   --> good for simple style adaptation
r = 8:   adapter ~ 4 MB   --> typical starting point
r = 16:  adapter ~ 8 MB   --> good for domain adaptation
r = 64:  adapter ~ 32 MB  --> high-fidelity task transfer
r = 256: adapter ~ 128 MB --> approaching full fine-tuning quality
```

**The trap:** Most engineers default to r=16 because "that's what the paper used." But r is a hyperparameter that depends on task complexity. For 500 tenants with 500 different tasks, each may need a different r — and your system must support heterogeneous adapter sizes in the same serving infrastructure.

### 2.4 Alpha Scaling

LoRA introduces a scaling factor alpha/r. The update is: delta_W = (alpha/r) × BA. This is not just a learning rate — it decouples the learning dynamics from the adapter's effective magnitude:

```python
# Common pitfall: confusing alpha with learning rate
# Alpha controls how much the LoRA update contributes relative to the base model
# Learning rate controls how fast the optimizer moves

# If alpha = 16, r = 16 --> scaling = 1.0  (default, no scaling)
# If alpha = 32, r = 16 --> scaling = 2.0  (LoRA contribution amplified)
# If alpha = 8,  r = 16 --> scaling = 0.5  (LoRA contribution dampened)
```

When designing a fine-tuning platform, alpha should be exposed as a configurable parameter — different tenants may need different adaptation strengths. A tenant fine-tuning on 10 examples needs higher alpha than one with 100,000 examples.

---

## 3. QLoRA: Quantization + LoRA

### 3.1 The Memory Breakthrough

QLoRA (Quantized LoRA) enables fine-tuning a 65B model on a single 48GB GPU by quantizing the frozen base model to 4-bit. The key innovations:

```
Standard LoRA memory for Llama-2-70B:
  Base model (FP16):      140 GB
  Gradients (LoRA only):    ~0.016 GB (tiny)
  Optimizer states:         ~0.048 GB (tiny, Adam for LoRA params only)
  Total:                   ~140 GB --> requires 2x A100-80GB

QLoRA memory for Llama-2-70B:
  Base model (NF4):         ~18 GB (4-bit storage + quantization constants)
  Gradients (LoRA only):    ~0.016 GB
  Optimizer states:         ~0.048 GB
  Total:                    ~18 GB --> fits on 1x A100-40GB or 1x RTX 4090
```

This ~8× memory reduction democratizes fine-tuning — but creates new system challenges.

### 3.2 NF4 Quantization — Not Just Any 4-bit

The QLoRA paper introduced **NormalFloat4 (NF4)**, a data type optimized for normally distributed weights (which neural network weights empirically follow):

```
Standard 4-bit quantization:
  +---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+
  | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |10 |11 |12 |13 |14 |15|
  +---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+
  Uniform spacing --> wastes bits on tail values that are rarely used

NF4 quantization:
  +-+--+---+---+----+----+----+-----+-----+-----+------+------+----+
  |#|# | # | # | #  | #  | #  | #   | #   | #   | #    | #    | #  |
  +-+--+---+---+----+----+----+-----+-----+-----+------+------+----+
  Dense near zero, sparse at tails --> more precision where weights live
```

The quantiles of NF4 are chosen to match the quantiles of N(0,1). This means the 16 quantization levels are not uniformly spaced — they're denser near zero.

### 3.3 Double Quantization

QLoRA also quantizes the quantization constants themselves (second level), saving another ~0.5 GB for a 65B model:

```
Level 0: Raw weights stored as 4-bit NF4 indices
Level 1: Per-block scaling factors (e.g., one FP32 scalar per 64 weights)
         --> These scaling factors are themselves quantized to FP8
         --> Saves ~3 GB on a 65B model (from ~3.5 GB to ~0.5 GB)

        +--------------------------------------------+
        | Raw Weights (NF4, 4-bit)                   |
        | [w0 w1 w2 ... w63] x millions              |
        +-------------------+------------------------+
                            | each block of 64 has one...
                            v
        +--------------------------------------------+
        | Block-wise Scale (FP32, 32-bit)            |
        | [s0] [s1] [s2] ... [s_N]                   |
        +-------------------+------------------------+
                            | double-quantize to...
                            v
        +--------------------------------------------+
        | Quantized Scales (FP8, 8-bit)              |
        | + one FP32 global scale per 256 blocks     |
        +--------------------------------------------+
```

### 3.4 The Precision Mismatch Problem

**This is the staff-engineer question.** QLoRA trains adapters against a 4-bit base model, but the adapters are stored in FP16/BF16. During inference, the base model runs in FP16. The adapters were optimized in a quantized space where:

- Gradient computations happened against dequantized (but still approximate) base model activations
- The 4-bit forward pass introduces quantization noise that the LoRA adapter learns to compensate for
- When you move to FP16 inference, that noise disappears — but the adapter was trained to correct for it

```
Training (QLoRA):                Inference (standard):
+--------------------------+     +---------------------------+
| Base Model (NF4)         |     | Base Model (FP16)         |
|  | dequantize to BF16    |     |  |                        |
| Forward pass (BF16)      |     | Forward pass (FP16)       |
|  + quantization noise    |     |  + NO quantization noise  |
|  |                       |     |  |                        |
| LoRA adapts to           |     | LoRA applied to           |
| BASE_4bit + noise        |     | BASE_16bit (no noise)     |
+--------------------------+     +---------------------------+

The adapter learned: delta_W = target_output - noisy_4bit_output
At inference:        output = clean_16bit_output + (target - noisy_4bit_output)
                           = target + (clean_16bit - noisy_4bit)
                           = target + epsilon
```

The mismatch epsilon exists but is empirically small for most tasks. However, for tasks requiring high precision (math, code generation, structured output), this can cause measurable degradation. **The system must support quality validation that compares QLoRA-trained adapters against the same data on FP16 inference before deploying.**

---

## 4. Distributed Training Strategies

### 4.1 The Parallelism Taxonomy

When one GPU isn't enough (and for full fine-tuning of 70B+ models, it never is), you distribute across GPUs. There are four fundamental strategies, and real systems compose them:

```
                    DATA PARALLELISM              MODEL PARALLELISM
                    +------------------+       +----------------------------+
                    |   DDP            |       | Tensor Parallelism (TP)    |
                    |                  |       | Pipeline Parallel (PP)     |
                    | Each GPU         |       | FSDP (ZeRO)                |
                    | has full         |       |                            |
                    | model copy       |       | Each GPU holds a slice     |
                    +------------------+       +----------------------------+
                           |                            |
                           +-------------+--------------+
                                         v
                                +--------------------+
                                |  3D Parallelism    |
                                |  DP x TP x PP      |
                                |  (real systems)    |
                                +--------------------+
```

### 4.2 Data Parallelism (DDP)

```
+----------------------------------------------------------------+
|                        DDP (Distributed Data Parallel)          |
|                                                                 |
|   GPU 0              GPU 1              GPU 2              GPU 3|
|  +---------+        +---------+        +---------+        +---------+
|  | Batch_0 |        | Batch_1 |        | Batch_2 |        | Batch_3 |
|  | Model   |        | Model   |        | Model   |        | Model   |
|  | (full)  |        | (full)  |        | (full)  |        | (full)  |
|  +----+----+        +----+----+        +----+----+        +----+----+
|       | grad_L0          | grad_L1          | grad_L2          | grad_L3
|       +------------------+------------------+------------------+
|                          | All-Reduce                          |
|                  +-------+-----------------------------+------+
|                  |   Average gradients across all GPUs,      |
|                  |   then each updates its local copy         |
|                  +--------------------------------------------+
|                                                                 |
|   Pros: Simple, near-linear scaling for small models            |
|   Cons: Each GPU must hold full model + optimizer states        |
|   Communication: All-reduce gradients, O(model_size) per step   |
+----------------------------------------------------------------+
```

### 4.3 FSDP / ZeRO (Fully Sharded Data Parallelism)

FSDP (PyTorch's implementation of Microsoft's ZeRO) shards model parameters, gradients, and optimizer states across GPUs — while still appearing as data parallelism to the user:

```
ZeRO Stages:

Stage 1: Shard optimizer states only
  +----------+----------+----------+----------+
  |  GPU 0   |  GPU 1   |  GPU 2   |  GPU 3   |
  | Weights  | Weights  | Weights  | Weights  |
  | Grads    | Grads    | Grads    | Grads    |
  | Opt_0    | Opt_1    | Opt_2    | Opt_3    | <-- sharded
  +----------+----------+----------+----------+
  Memory saved: 4x reduction in optimizer memory

Stage 2: Shard optimizer states + gradients
  +----------+----------+----------+----------+
  |  GPU 0   |  GPU 1   |  GPU 2   |  GPU 3   |
  | Weights  | Weights  | Weights  | Weights  |
  | Grad_0   | Grad_1   | Grad_2   | Grad_3   | <-- sharded
  | Opt_0    | Opt_1    | Opt_2    | Opt_3    | <-- sharded
  +----------+----------+----------+----------+

Stage 3: Shard optimizer states + gradients + parameters
  +----------+----------+----------+----------+
  |  GPU 0   |  GPU 1   |  GPU 2   |  GPU 3   |
  | W_0      | W_1      | W_2      | W_3      | <-- sharded
  | Grad_0   | Grad_1   | Grad_2   | Grad_3   | <-- sharded
  | Opt_0    | Opt_1    | Opt_2    | Opt_3    | <-- sharded
  +----------+----------+----------+----------+
  Each GPU only owns 1/4 of the parameters at rest
  All-gather before forward, reduce-scatter after backward
```

**The FSDP-LoRA interaction:** When using FSDP with LoRA, the base model is sharded but LoRA parameters are tiny — typically each GPU holds a FULL copy of all LoRA adapters. This means:

```
FSDP + LoRA (training 500 tenant adapters on 64 GPUs):
  +-----------------------------------------------------------+
  | Base model (70B): sharded across 64 GPUs -- ~2.2 GB/GPU  |
  | LoRA adapters (500 x 8 MB): FULL COPY on EVERY GPU       |
  |   = 4 GB of adapter weights x 64 GPUs = 256 GB wasted    |
  +-----------------------------------------------------------+
```

**The staff-engineer insight:** For multi-tenant adapter training, FSDP can be counterproductive. If you're training 500 different adapters independently, you should shard the **adapters** across GPUs (adapter parallelism), not the base model. Each GPU trains 8 adapters, all sharing the same base model — that's 500/8 ~ 63 GPUs × 1 copy of base model = 2.2 GB/GPU, vs. 64 GPUs each with the full adapter set = 256 GB wasted.

### 4.4 Tensor Parallelism and Pipeline Parallelism

```
Tensor Parallelism (TP): Split individual layers across GPUs
+-------------------------------------------------------+
|  Layer: Y = WX                                         |
|                                                        |
|  GPU 0              GPU 1              GPU 2           |
|  W[:, 0:d/3]        W[:, d/3:2d/3]    W[:, 2d/3:d]   |
|  X[0:d/3]           X[d/3:2d/3]       X[2d/3:d]      |
|       |                  |                  |          |
|       +------------------+------------------+          |
|                    All-Reduce                          |
|                          |                             |
|                    Y (full output)                     |
|                                                        |
|  Communication: Two all-reduces per transformer block  |
|  Best for: Models too big for single GPU (70B+)        |
|  Limitation: High communication, only within a node    |
+-------------------------------------------------------+

Pipeline Parallelism (PP): Split model layers across GPUs
+----------------------------------------------------------+
|  GPU 0: Layers 0-19     (first 20 transformer blocks)    |
|    | micro-batch0 -> micro-batch1 -> micro-batch2         |
|    v                                                     |
|  GPU 1: Layers 20-39                                      |
|    | micro-batch0 -> micro-batch1 -> micro-batch2         |
|    v                                                     |
|  GPU 2: Layers 40-59                                      |
|    | micro-batch0 -> micro-batch1 -> micro-batch2         |
|    v                                                     |
|  GPU 3: Layers 60-79   (last 20 transformer blocks)      |
|                                                           |
|  Pipeline bubble: GPUs idle at start/end of schedule     |
|  Communication: Only activations between stages           |
|  Best for: Very deep models, low inter-node bandwidth     |
+----------------------------------------------------------+
```

### 4.5 3D Parallelism in Practice

Real training systems compose all three:

```
+------------------------------------------------------------------+
|                   3D Parallelism for Llama-3-70B                  |
|                                                                   |
|  64 GPUs (8 nodes x 8 GPUs)                                      |
|                                                                   |
|  DP = 4  (4 data-parallel replicas, each processing 1/4 batches) |
|  TP = 4  (each layer split across 4 GPUs within a node)          |
|  PP = 4  (80 layers split: 20 per pipeline stage)                |
|                                                                   |
|  Check: 4 x 4 x 4 = 64                                           |
|                                                                   |
|  +------------------ Node 0 -------------------+                  |
|  |  +-----+ +-----+ +-----+ +-----+           |                  |
|  |  |GPU0 | |GPU1 | |GPU2 | |GPU3 |           | <-- PP Stage 0  |
|  |  |L0-19| |L0-19| |L0-19| |L0-19|           |     TP across 4 |
|  |  +--+--+ +--+--+ +--+--+ +--+--+           |                  |
|  |     +------+------+------+                  |                  |
|  |  +-----+ +-----+ +-----+ +-----+           |                  |
|  |  |GPU4 | |GPU5 | |GPU6 | |GPU7 |           | <-- PP Stage 1  |
|  |  |L20- | |L20- | |L20- | |L20- |           |     TP across 4 |
|  |  | 39  | | 39  | | 39  | | 39  |           |                  |
|  |  +-----+ +-----+ +-----+ +-----+           |                  |
|  +--------------------------------------------+                  |
|                                                                   |
|  Nodes 1-3: identical copies (DP=4), different micro-batches     |
|  Inter-node: All-reduce gradients (DP), send activations (PP)    |
|  Intra-node: All-reduce within TP group (NVLink, 900 GB/s)       |
+------------------------------------------------------------------+
```

---

## 5. Training Infrastructure Design

### 5.1 The Full Pipeline Architecture

```
+----------------------------------------------------------------------+
|                    Fine-Tuning Platform Architecture                  |
|                                                                       |
|  +----------+    +--------------+    +--------------------------+     |
|  | Training |    |   Training   |    |     GPU Cluster          |     |
|  | Job API  |--->|  Orchestrator|--->|  +--------------------+  |     |
|  | (REST)   |    |  (Scheduler) |    |  |  Training Pods     |  |     |
|  +----------+    +-------+------+    |  |  (K8s Jobs)        |  |     |
|                          |           |  |  +----+ +----+     |  |     |
|  +----------+    +-------+------+    |  |  |GPU0| |GPU1|     |  |     |
|  | Dataset  |    |  Experiment  |    |  |  +----+ +----+     |  |     |
|  | Registry |<---|  Tracker     |    |  |  +----+ +----+     |  |     |
|  | (S3/DB)  |    |  (W&B/MLflow)|    |  |  |GPU2| |GPU3|     |  |     |
|  +----------+    +-------+------+    |  |  +----+ +----+     |  |     |
|                          |           |  +--------------------+  |     |
|  +----------+    +-------+------+    +--------------------------+     |
|  | Template |    |   Checkpoint |              |                      |
|  | Library  |    |    Store     |              | Adapter weights      |
|  | (Git)    |    |   (S3/GCS)   |              v                      |
|  +----------+    +--------------+    +--------------------------+     |
|                                      |   Model Registry         |     |
|  +----------+                        |  +--------------------+   |     |
|  |Quality   |<------------------------| tenant_001/lora/    |   |     |
|  |Eval      |                        |  adapter_config.json |   |     |
|  |Pipeline  |                        |  adapter_model.safe- |   |     |
|  +----------+                        |  tensors             |   |     |
|                                      |  eval_results.json   |   |     |
|                                      |  +--------------------+   |     |
|                                      +--------------------------+     |
+----------------------------------------------------------------------+
```

### 5.2 Checkpointing and Fault Tolerance

Distributed training on spot/preemptible instances requires robust checkpointing:

```
Checkpointing Strategies:

+------------------------------------------------------------+
| Synchronous (blocking):                                     |
|   All GPUs pause --> each writes its shard --> resume       |
|   Pros: Consistent snapshot                                  |
|   Cons: Training stalls during I/O (seconds to minutes)     |
+------------------------------------------------------------+
| Asynchronous (non-blocking):                                |
|   GPU writes its shard while others continue training       |
|   Pros: No training pause                                   |
|   Cons: Checkpoint may be inconsistent (some GPUs ahead)    |
+------------------------------------------------------------+
| Incremental (only changed params):                          |
|   Full checkpoint: 140 GB every time (impractical)          |
|   LoRA-only ckpt: 8 MB --> checkpoint every 10 steps        |
|   This is a hidden advantage of PEFT                        |
+------------------------------------------------------------+
```

**The spot-preemption failure mode:** When FSDP state is sharded across 64 GPUs and one GPU gets preempted, the global training state is corrupt. Recovery requires:

1. Detect preemption (node-level heartbeat, not just process-level)
2. Load the last consistent checkpoint across ALL GPUs
3. Re-establish the FSDP communication groups
4. Resume from the last saved optimizer state

Without step (3), the remaining GPUs will hang waiting for all-reduce from the dead GPU. **Elastic training** (resizing the GPU count mid-training) is the staff-level solution but adds significant complexity to the data loader, learning rate schedule, and FSDP state management.

### 5.3 Memory Optimizations Beyond Quantization

| Technique | Memory Saved | Compute Overhead | Implementation Complexity |
|-----------|-------------|------------------|--------------------------|
| **Gradient Checkpointing** | 30-50% (activations) | +20-30% (recompute forward) | One-line: `model.gradient_checkpointing_enable()` |
| **Mixed Precision (FP16/BF16)** | 50% (weights + activations) | -10-30% (faster on Tensor Cores) | `torch.cuda.amp` |
| **Gradient Accumulation** | Enables larger effective batch | None (trades time for memory) | Loop: accumulate N steps, then step |
| **CPU Offloading** | Offloads optimizer states to CPU | +50-200% (PCIe transfer) | `device_map="auto"` with offload |
| **Flash Attention** | O(n) instead of O(n²) memory | +5-10% wall time | Drop-in: `flash_attn` package |
| **Activation Offloading** | Moves intermediate activations to CPU | +100-300% | Custom hooks, rarely worth it |

**The staff-engineer's memory budget:** Before launching any training run, compute the exact memory breakdown:

```
Memory Budget for QLoRA Fine-Tuning of Llama-3-70B on 1xA100-80GB:

Base model (NF4):            ~17.6 GB
LoRA parameters (FP16):       ~0.016 GB
LoRA gradients (FP16):        ~0.016 GB
Optimizer states (FP32):      ~0.048 GB
Activations (w/ grad ckpt):   ~8.0 GB  (batch=4, seq=2048)
CUDA context + overhead:       ~2.0 GB
-----------------------------------------
Total:                        ~27.7 GB
Available:                     80.0 GB
Headroom:                     ~52.3 GB  --> can increase batch x6 or seq x3
```

---

## 6. Inference Serving for Multi-Tenant LoRA

### 6.1 Adapter Hot-Swapping

This is the crux of the staff-level system design. You cannot reload the model for every tenant switch, and you can't keep all 500 adapters in GPU memory simultaneously:

```
+------------------------------------------------------------------+
|              LoRA Adapter Serving Architecture                    |
|                                                                   |
|  Request: tenant=42, prompt="Explain quantum..."                  |
|       |                                                           |
|       v                                                           |
|  +-----------------+                                              |
|  |  Adapter Cache   |  (GPU memory, LRU eviction)                 |
|  |  +---++---++---+|                                              |
|  |  |T5 ||T12||T89||  <-- Currently loaded (e.g., 32 adapters)   |
|  |  +---++---++---+|                                              |
|  |  +-----------+  |                                              |
|  |  | T42 (HIT!)|  |  <-- Adapter already on GPU                 |
|  |  +-----------+  |                                              |
|  +--------+--------+                                              |
|           | T42 found in cache                                    |
|           v                                                       |
|  +----------------------------------------------------+          |
|  |           LoRA-Enabled Forward Pass                 |          |
|  |                                                     |          |
|  |  y = W_0*x + B_42*A_42*x                           |          |
|  |       ^         ^                                   |          |
|  |   Base Model   Adapter                              |          |
|  |   (shared,     (tenant-specific,                    |          |
|  |    frozen,      hot-swapped per request)            |          |
|  |    sharded)                                          |          |
|  +----------------------------------------------------+          |
|                                                                   |
|  Cache Miss Path:                                                 |
|  +---------------------------------------------------------+     |
|  | T42 NOT in GPU cache                                     |     |
|  |   --> Check RAM cache (system memory, larger, slower)   |     |
|  |     --> HIT: DMA transfer to GPU (~2ms for 8 MB)        |     |
|  |     --> MISS: Read from S3 (~50ms), load to GPU (~52ms) |     |
|  |   --> Evict LRU adapter from GPU cache if full           |     |
|  |   --> Install T42 adapter into model's LoRA hooks        |     |
|  +---------------------------------------------------------+     |
+------------------------------------------------------------------+
```

### 6.2 S-LoRA / Punica — Serving Thousands of LoRA Adapters

Recent research (S-LoRA, Punica) introduced **unified paging** — treating KV cache blocks and LoRA adapter weights as pages in a unified memory pool. The key insight: LoRA adapters are small (8 MB) and KV cache blocks are small (typically 16 tokens × hidden_dim). Both can be managed by the same memory allocator:

```
Unified Memory Pool (GPU):
+------------------------------------------------------------+
| +------+ +------+ +------+ +------+ +------+ +------+     |
| |KV pg | |KV pg | |LoRA  | |KV pg | |LoRA  | |KV pg | ... |
| |Seq_1 | |Seq_2 | |T5    | |Seq_3 | |T12   | |Seq_1 |     |
| +------+ +------+ +------+ +------+ +------+ +------+     |
|                                                             |
| Total: 80 GB                                                |
| Base model: 65 GB (FP16)                                    |
| Remaining: 15 GB for KV cache + LoRA adapters               |
| Max adapters in GPU: 15 GB / 8 MB ~ 1,875 adapters          |
|                                                             |
| In practice: KV cache takes ~10 GB --> 5 GB for adapters    |
|             --> 625 adapters can coexist in GPU             |
+------------------------------------------------------------+
```

### 6.3 Batching Across Tenants

When a batch contains requests from different tenants with different LoRA adapters:

```
Batch of 4 requests: tenants [5, 5, 12, 89]

Naive approach:
  y1 = W_0*x1 + B_5*A_5*x1     (tenant 5)
  y2 = W_0*x2 + B_5*A_5*x2     (tenant 5)
  y3 = W_0*x3 + B_12*A_12*x3   (tenant 12)
  y4 = W_0*x4 + B_89*A_89*x4   (tenant 89)

  W_0*x part: batched as one big matmul [OK]
  BAx part: three different matmuls x 1-2 rows each
            --> kernel launch overhead kills throughput

Optimized (Punica/S-LoRA approach):
  Group by adapter: [tenants 5,5] + [tenant 12] + [tenant 89]
  Batch1: y1,2 = W_0*x1,2 + B_5*A_5*x1,2
  Batch2: y3    = W_0*x3 + B_12*A_12*x3
  Batch3: y4    = W_0*x4 + B_89*A_89*x4

  Each LoRA forward gets a batch with multiple rows --> efficient matmul [OK]
  Still only one W_0*x batched matmul (base model shared) [OK]
```

---

## 7. Quality Assurance and Evaluation

### 7.1 The Eval Pipeline

Fine-tuning without rigorous evaluation is cargo-cult engineering. A staff-level platform requires:

```
+---------------------------------------------------------------+
|                    Evaluation Pipeline                         |
|                                                                |
|  Fine-tuned Adapter --> +------------------+                  |
|                          |  Automated Evals  |                 |
|                          |  +--------------+ |                 |
|                          |  | Perplexity   | | <-- Fast, cheap|
|                          |  | on holdout   | |                 |
|                          |  +------+-------+ |                 |
|                          |         v          |                 |
|                          |  +--------------+ |                 |
|                          |  | Task-specific| | <-- Accuracy,   |
|                          |  | benchmarks   | |     F1, BLEU,   |
|                          |  | (MMLU, GSM8K)| |     ROUGE, etc. |
|                          |  +------+-------+ |                 |
|                          |         v          |                 |
|                          |  +--------------+ |                 |
|                          |  | Human Eval   | | <-- Slow, costly|
|                          |  | (sampling)   | |     definitive  |
|                          |  +------+-------+ |                 |
|                          +---------+---------+                 |
|                                    v                            |
|                          +------------------+                  |
|                          |  Quality Gate    |                  |
|                          |  +--------------+|                  |
|                          |  |Perplexity    || <-- Must improve |
|                          |  | drop >= 5%?  ||     over base    |
|                          |  +--------------+|                  |
|                          |  |Benchmarks    || <-- Must not     |
|                          |  | regress?     ||     get worse    |
|                          |  +--------------+|                  |
|                          |  |Safety checks || <-- No toxic     |
|                          |  | pass?        ||     degeneration |
|                          |  +------+-------+|                  |
|                          +---------+---------+                  |
|                                    v                            |
|                    +--------------------------+                 |
|                    |  Deploy / Rollback       |                 |
|                    |  (canary -> 10% -> 100%) |                 |
|                    +--------------------------+                 |
+---------------------------------------------------------------+
```

### 7.2 Catastrophic Forgetting Detection

Fine-tuning can cause the model to "forget" its original capabilities. The eval pipeline must include:

```
Regression Test Suite:
+------------------------------------------------------------+
| Baseline metrics on base model (pre-fine-tune):              |
|   MMLU: 68.2% | GSM8K: 54.1% | HellaSwag: 81.3%            |
|                                                              |
| After fine-tuning:                                            |
|   MMLU: 67.9% | GSM8K: 53.8% | HellaSwag: 80.9%            |
|   --> All within +/-1% --> NO catastrophic forgetting        |
|                                                              |
| Red flag scenario:                                           |
|   MMLU: 62.1% | GSM8K: 48.3% | HellaSwag: 76.2%            |
|   --> Significant drops --> adapter overfit to narrow task   |
|   --> Action: Reduce learning rate, add KL-divergence loss  |
|             to penalize deviation from base model outputs    |
+------------------------------------------------------------+
```

---

## 8. System Design: Complete Fine-Tuning Platform

### 8.1 Requirements

Design a fine-tuning platform supporting 500 tenants, each with custom LoRA adapters on Llama-3-70B:

| Requirement | Constraint |
|-------------|-----------|
| Training throughput | 4 adapters/hour on 8×A100-80GB |
| Training cost target | <$2 per adapter |
| Inference P99 latency | <300ms with adapter hot-swap |
| Max concurrent inference tenants | 500 |
| Adapter storage | 500 × 8 MB = 4 GB |
| Training data per tenant | 100-10,000 examples |
| GPU cluster for training | 64×A100-80GB (8 nodes × 8 GPUs) |
| GPU cluster for inference | 4×A100-80GB (TP=4) |
| Checkpointing frequency | Every 50 steps (LoRA only, 8 MB) |

### 8.2 Capacity Planning

```
Training Capacity:
+-------------------------------------------------------------+
| Active tenants: 500                                          |
| Adapters per training run: 4 (parallel on 8 GPUs)           |
| Time per adapter: ~15 minutes (QLoRA, 1000 examples)        |
| Adapters per hour: 4                                         |
| Time to train all 500: 500/4 = 125 hours ~ 5.2 days         |
|                                                              |
| With 8x nodes (64 GPUs), run 8 independent training jobs:   |
| Adapters per hour: 32                                        |
| Time to train all 500: 500/32 = ~16 hours                   |
| Cost: 64 GPUs x $3.50/hr x 16 hrs = ~$3,584 total           |
| Per-adapter cost: $3,584/500 = ~$7.17                        |
|                                                              |
| Using spot instances (70% discount):                         |
| Per-adapter cost: ~$2.15                                     |
| But: need fault tolerance for preemptions                    |
+-------------------------------------------------------------+

Inference Capacity:
+-------------------------------------------------------------+
| Base model: 140 GB FP16 --> 2xA100-80GB minimum             |
| With TP=4: 4xA100-80GB for throughput headroom              |
| KV cache budget: 40 GB (50% of non-model memory)            |
| Adapter cache: 10 GB --> 1,250 adapters max in GPU          |
|                                                              |
| Per-request latency budget:                                  |
|   Token generation: ~20ms/token (typical for 70B on A100)   |
|   Adapter swap (GPU cache hit): <1ms                        |
|   Adapter swap (RAM cache hit): ~2ms (DMA transfer)         |
|   Adapter swap (S3 miss): ~50ms + 2ms GPU load              |
|   P99 target: 300ms --> max ~12 tokens at 20ms/token        |
|                                                              |
| Throughput: ~256 concurrent requests at 20ms/token           |
| Requests/second: 256/20ms ~ 12,800 req/s (query processing) |
| Generated tokens/second: ~640 tokens/s (generation)          |
+-------------------------------------------------------------+
```

### 8.3 Failure Modes

| Failure Mode | Symptom | Detection | Mitigation |
|-------------|---------|-----------|------------|
| **QLoRA precision drift** | Adapter quality degrades on FP16 inference | Automated eval before deploy | Compare QLoRA vs FP16 eval; flag if delta > 2% |
| **Adapter cache thrashing** | P99 latency spikes under mixed-tenant load | Monitor cache miss rate | Increase GPU adapter cache; pre-warm top-N tenants |
| **Spot preemption cascade** | Single GPU loss --> entire FSDP group hangs | Node heartbeat, NCCL timeout | Elastic training; checkpoint every 10 steps for LoRA |
| **Catastrophic forgetting** | Base model capabilities degrade | Regression test suite | KL-divergence regularization; early stopping |
| **Adapter storage fragmentation** | S3 LIST operations slow with 500+ adapters | S3 request latency monitoring | Partition by tenant prefix; use prefix-based listing |
| **GPU OOM from KV + adapter memory** | Inference pod crashes under high concurrency | GPU memory utilization alerts | Unified paging; evict idle adapters before KV blocks |

---

## <U+26A1> Sharp Question

**Question:** You've built a platform serving 500 LoRA fine-tuned Llama-3-70B adapters. A new customer, Tenant 501, uploads a dataset of 50,000 examples — far larger than any existing tenant. You fine-tune with QLoRA (r=16, alpha=32) on 1×A100. The adapter passes your automated eval with perplexity drop of 8% on their holdout and no benchmark regression. You deploy to production. Two days later, Tenant 12 (your largest existing customer) reports their outputs have degraded — the model is producing verbose, overly-formal responses that don't match their fine-tuned style. Tenant 12's adapter hasn't been touched in 3 weeks. What happened, and how do you fix it?

**Model Answer:**

The most likely cause is **adapter mixing at inference time due to a cache consistency bug or model weight corruption from a botched hot-swap**. Here's the forensic walkthrough:

**(a) The hot-swap race condition.** When Tenant 501's adapter was loaded into the inference server, the adapter loading code (or the LoRA hook installation) may have failed to fully isolate the forward pass. Specifically, if the adapter cache uses a shared mutable reference to the LoRA matrices and the hot-swap didn't acquire the proper lock, Tenant 12's request could have been processed with Tenant 501's adapter matrices partially loaded — a "torn write" where some attention heads used Tenant 12's LoRA weights and others used Tenant 501's. This produces garbled outputs that inherit stylistic properties from both adapters. The fix: adapter swapping must be atomic — either all LoRA matrices for a request belong to one tenant or none. Implement this with a read-copy-update (RCU) pattern: each request captures a pointer to the adapter set at dispatch time, and new adapter loads create a new set while in-flight requests complete with the old one.

**(b) The KV cache contamination hypothesis** (less likely but must be ruled out). If the inference server uses a shared KV cache pool and doesn't properly segregate blocks by tenant, a defragmentation pass might have moved KV blocks from Tenant 501's long-context requests into memory regions adjacent to Tenant 12's blocks. Some inference engines use prefix caching where KV blocks are shared across requests with identical prefixes. If Tenant 501's fine-tune altered the model's token probability distribution such that it generates tokens that happen to share prefixes with Tenant 12's common prompts, the prefix cache could return Tenant 501's KV blocks to Tenant 12's requests. The fix: tag KV cache blocks with the adapter ID they were computed under, and invalidate (or never share) blocks computed under a different adapter.

**(c) The shared base model contamination** (most subtle). If you're using a pre-merge strategy (W' = W + BA) and the merge was applied to a shared model object rather than a per-request copy, Tenant 501's adapter merge could have permanently altered the base model weights visible to all tenants. This is catastrophic because every subsequent tenant gets a corrupted model. The fix: never merge adapters into the shared base model. Always run separate forward pass (y = W_0*x + BAx) with per-request adapter selection. If merging is required for throughput, merge into a per-request copy and discard after.

**Diagnostic steps:** (1) Roll back Tenant 12 to a known-good checkpoint and verify degradation disappears — this confirms it's a serving issue, not a training issue. (2) Enable adapter-ID logging in the inference server and correlate request timestamps with adapter loads. (3) Check GPU memory for shared weight corruption by computing a checksum of the base model weights and comparing to the known-good hash.

**Common Pitfall:** Most engineers jump to "catastrophic forgetting during fine-tuning" or "Tenant 501's training corrupted something." But the timeline doesn't fit — Tenant 12 was fine for 3 weeks before Tenant 501 was deployed. The degradation appeared only after the new adapter was loaded. This is a **deployment-induced regression**, not a training problem. Always check "what changed in production?" before "what went wrong in training?"

---

## Key Takeaways

| Principle | Implication |
|-----------|------------|
| LoRA's low rank is both a feature and a constraint — r=16 works for 90% of tasks but fails silently on the 10% that need high-fidelity weight updates | Monitor per-adapter training loss curves; flag adapters where loss plateaus above baseline |
| QLoRA trains against quantized weights but inference runs on full precision — the 4-bit-to-16-bit gap creates a systematic bias that must be measured per-task | Always run both QLoRA-trained and FP16-fine-tuned evals on the same holdout before deploying |
| Multi-tenant LoRA serving is an adapter isolation problem, not a throughput problem — one corrupted hot-swap affects every tenant using the shared base model | Implement RCU-style adapter switching; never mutate shared model weights |
| FSDP + LoRA wastes GPU memory on adapter duplication — for multi-tenant training, shard adapters, not the base model | Design training jobs where each GPU trains a subset of adapters against the full model |
| The most dangerous failure mode is silent degradation — a partially corrupted adapter can produce plausible-looking but systematically wrong outputs for weeks | Automated eval gating at deploy time + continuous quality monitoring in production |

---

## Interview Cheat Sheet

**Key Points to Remember:**
- LoRA freezes the base model and trains small low-rank matrices (A×B) added to weights — ~1% of parameters, 99% smaller
- QLoRA = LoRA on a 4-bit quantized base model — fine-tune a 70B model on a single 48GB GPU
- Full fine-tuning updates all weights — best quality but needs multi-GPU (FSDP/DeepSpeed) and is expensive
- Distributed training: Data Parallel (same model, different data), Tensor Parallel (split layers), Pipeline Parallel (split stages)
- Adapter serving: keep base model fixed, swap adapters per tenant. Multi-LoRA serving for multi-tenant use cases

**Common Follow-Up Questions:**
- "When would you use full fine-tuning vs LoRA?" — Full fine-tuning for fundamental capability changes (new language, new domain). LoRA for style/tone/task-specific tuning where base capabilities are sufficient.
- "How do you serve 500 LoRA adapters without 500 model copies?" — Load the base model once, keep adapters in CPU memory, swap into GPU on demand. vLLM supports this with multi-LoRA serving.

**Gotcha:**
- QLoRA trains on 4-bit quantized weights but inference typically runs in FP16. The adapter weights learned in 4-bit space may not transfer perfectly to 16-bit inference. Always validate inference quality after QLoRA training — the training loss may look great while inference quality degrades.
