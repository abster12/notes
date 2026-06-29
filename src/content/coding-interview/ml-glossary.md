---
title: "ML & GenAI Glossary"
category: "Coding Interview Prep"
tags: [ml, genai, glossary, reference, interview]
last_updated: "2026-06-21"
---

# ML & GenAI Glossary

A quick-reference A-Z of the terms, acronyms, and concepts that come up in ML/AI interviews. Each entry has a plain-English explanation, the formula or property you need to remember, and a short code snippet where it helps.

Keep this open in a tab during prep. When a term comes up in an interview question and you don't recognize it, look it up here first.

---

## Summary & Interview Framing

An A-Z reference of ML/AI terms covering activation functions, loss functions, optimizers, regularization, evaluation metrics, and architectures.

**How it's asked:** "Reference doc — skim before any ML interview to refresh vocabulary. Interviewers expect you to define terms like cross-entropy, Adam, dropout, BLEU, and RLHF without hesitation."

---

## A

### Adam (Adaptive Moment Estimation)

Adam is the default optimizer for training transformers and most deep learning models. It maintains two moving averages per parameter: the first moment (mean of gradients) and the second moment (uncentered variance of gradients). It then uses these to scale the learning rate per-parameter.

The update rule is `theta -= lr * m_hat / (sqrt(v_hat) + eps)`, where `m_hat` and `v_hat` are bias-corrected moments. The hyperparameters `beta1=0.9` and `beta2=0.999` are the default exponential decay rates. AdamW is the de-facto standard — it decouples weight decay from the gradient update, which fixes Adam's tendency to apply weight decay incorrectly.

```python
optimizer = torch.optim.AdamW(model.parameters(), lr=1e-4, weight_decay=0.01)
```

### Activation Function

The non-linear function applied to a layer's output before passing to the next layer. Without non-linear activations, a stack of linear layers collapses to a single linear transformation, and the network can't learn anything interesting.

The choice of activation matters: ReLU is simple and works well but "dies" when inputs become negative; GELU is smoother and what GPT/BERT use; SwiGLU is what LLaMA uses and is empirically better for large LMs.

### ALiBi (Attention with Linear Biases)

ALiBi is a positional encoding that adds a linear, distance-dependent bias to attention scores rather than adding positional embeddings to the input. It's used in models like BLOOM and enables length extrapolation — a model trained on 2K context can reasonably handle 8K+ at inference without retraining.

The bias is `-m * distance(i, j)` where `m` is a per-head slope (different heads get different slopes). It's much simpler than RoPE and faster to compute but slightly less expressive.

### Attention

The core mechanism of the transformer. Given queries (Q), keys (K), and values (V), attention computes a weighted sum of V where the weights are derived from Q-K similarity. The formula is `softmax(Q @ K^T / sqrt(d_k)) @ V`, with the scaling by `sqrt(d_k)` preventing softmax from saturating when dot products are large.

Multi-head attention runs several attention computations in parallel with different learned projections, then concatenates the results. This lets each head attend to different patterns (one head might focus on syntax, another on coreference, etc.).

### Autoencoding Models

Models trained to reconstruct their input from a corrupted version. The canonical example is BERT, which masks out 15% of tokens and trains the model to predict them. Autoencoders learn bidirectional representations — they see the full context on both sides of any token.

This contrasts with autoregressive models (GPT), which only see left context. Autoencoders are good for understanding tasks (classification, NER, embedding generation) but not generation.

### Autoregressive Generation

The standard way language models generate text: predict the next token given all previous tokens, sample/argmax, append, repeat. The probability of a sequence factors as `P(x_1, ..., x_n) = prod(P(x_i | x_<i))`.

This is why models like GPT are "left-to-right" — they can only use past context to predict the next token. Generation is sequential, not parallelizable within a sequence (though batching helps).

---

## B

### Backpropagation

The algorithm for computing gradients of the loss with respect to every parameter in a neural network. It applies the chain rule of calculus backward through the computation graph, computing each layer's gradient from the next layer's.

In PyTorch this is automatic via autograd: you call `loss.backward()` and the framework traverses the graph, accumulating gradients into each parameter's `.grad` attribute. Then `optimizer.step()` updates the parameters.

The interview classic: be able to derive the backward pass for a small network by hand (linear → sigmoid → loss).

### Batch Normalization

Normalizes activations across the batch dimension for each feature independently. Given activations with shape `(N, C, ...)`, BN computes mean and variance across N for each channel. It was the standard in CNNs (ResNet, etc.) but is rarely used in transformers because the batch dimension is variable and the statistics can be noisy with small batches.

Transformer architectures use LayerNorm instead, which normalizes across the feature dimension rather than the batch dimension. This is independent of batch size and works well with variable sequence lengths.

### Beam Search

A decoding strategy that keeps the top-k most likely partial sequences at each step, rather than greedily picking the single best next token. Beam size 5 means you track 5 candidate sequences; the final one with highest joint probability is the output.

Beam search produces more coherent text than greedy decoding for tasks like translation, but is less diverse than sampling. For open-ended creative generation, top-p or top-k sampling is usually preferred.

### BLEU (Bilingual Evaluation Understudy)

The classic metric for machine translation, measuring n-gram overlap between the candidate and reference translations. BLEU-4 (using 1-4 grams) is the standard. The score is the geometric mean of n-gram precisions times a brevity penalty to discourage too-short outputs.

BLEU has well-known weaknesses: it doesn't capture meaning, only n-gram overlap. Modern translation systems also report chrF, COMET, and human evaluation. For code generation, BLEU is mostly useless — use pass@k or execution-based metrics instead.

### BPE (Byte Pair Encoding)

The dominant tokenization algorithm for modern LMs. It starts with a vocabulary of individual characters and iteratively merges the most frequent pair of adjacent tokens until the vocabulary reaches the target size. The final vocabulary contains the most common subwords — common words become single tokens, rare words get split into pieces.

GPT-2/3/4 use BPE with a vocabulary of ~50K. LLaMA uses SentencePiece BPE. BPE is fully reversible: you can always convert tokens back to the original bytes. Modern BPE tokenizers operate on raw bytes (256 base tokens) rather than characters, which avoids the "what's a character" question for non-English text.

```python
# Simple BPE training
def get_pairs(word):
    return set((word[i], word[i+1]) for i in range(len(word)-1))

vocab = list("abc")  # initial chars
# Iterate: find most frequent pair, merge it, repeat
```

---

## C

### Chain-of-Thought (CoT)

A prompting technique where you ask the model to show its reasoning step-by-step before giving the final answer. This dramatically improves performance on math, logic, and multi-step reasoning tasks, even without any model training. The model "thinks out loud."

Variants include zero-shot CoT ("Let's think step by step") and few-shot CoT (provide examples of reasoning in the prompt). Tree-of-thoughts extends this to exploring multiple reasoning paths and selecting the best.

### Chinchilla Scaling Laws

The "compute-optimal" scaling law for LMs, from DeepMind's 2022 paper. It says that for a given compute budget, you should train on ~20 tokens per parameter. A 7B model should be trained on ~140B tokens, a 70B model on ~1.4T tokens.

This contradicted prior practice (GPT-3 175B trained on only 300B tokens — undertrained by Chinchilla's reckoning). Most modern models follow Chinchilla, though the most recent frontier models (GPT-4, Claude 3) are believed to be trained with significantly more tokens per parameter because inference cost matters and the optimal is shifting.

### Contrastive Learning

A training paradigm where the model learns by pulling similar examples together in embedding space and pushing dissimilar examples apart. The canonical loss is InfoNCE, used in CLIP, SimCLR, sentence-transformers, and retrieval-augmented systems.

For retrieval, you encode the query and the document into the same space, then compute cosine similarity. Training pairs are typically (query, positive_doc, negative_docs) and the loss encourages query · positive > query · negative by a margin.

### Cross-Entropy Loss

The standard loss for classification and language modeling. For a probability distribution `p` (true) and predicted `q`, cross-entropy is `H(p, q) = -sum(p * log(q))`. In language modeling, `p` is a one-hot vector for the true next token, so the loss simplifies to `-log(q[true_token])`.

In practice, you usually use the numerically stable version: combine the softmax and the negative log-likelihood into one operation (`F.cross_entropy` in PyTorch accepts raw logits, not probabilities).

```python
loss = F.cross_entropy(logits, targets)  # logits: (B, V), targets: (B,)
# Internally: log_softmax then NLL
```

---

## D

### Data Parallelism (DP / DDP)

The simplest form of multi-GPU training: replicate the model on every GPU, split each batch across GPUs, compute forward+backward independently, then average gradients across GPUs (via all-reduce). PyTorch's `DistributedDataParallel` does this with near-linear scaling for models that fit in single-GPU memory.

DDP is the default and works well for models up to ~10B parameters on current hardware. Beyond that, you need model parallelism (split the model across GPUs).

### Decoder-Only Architecture

The architecture used by GPT, LLaMA, Claude, and essentially all modern LLMs. It's a stack of identical transformer decoder blocks, each with self-attention + FFN. The "decoder-only" name comes from the original transformer (which had encoder + decoder), but in practice these models are trained as pure language models with causal masking.

The advantage over encoder-decoder: it's simpler, scales better, and the same architecture handles both understanding and generation.

### Diffusion Models

A generative modeling paradigm that learns to reverse a noising process. During training, you add Gaussian noise to data in many steps until it's pure noise, then train a model to predict the noise (or the clean image) at each step. At inference, you start from noise and iteratively denoise.

Stable Diffusion, DALL-E, and most modern image/video generators are diffusion models. They produce higher quality than GANs but require multiple sampling steps (though distillation techniques now allow 1-4 step generation).

### DPO (Direct Preference Optimization)

A simpler alternative to RLHF that directly optimizes the model to prefer chosen responses over rejected ones, without training a separate reward model. The DPO loss is a logistic regression on the log-ratio of policy probabilities for chosen vs rejected responses.

DPO is what most recent open-source models (LLaMA 3, Mistral) use for alignment instead of PPO-based RLHF. It's simpler to implement, more stable to train, and often produces comparable results.

### Dropout

A regularization technique that randomly zeroes out a fraction of activations during training. The dropout rate (e.g., 0.1) is the probability each activation is zeroed. At inference, dropout is disabled and weights are scaled by `(1 - dropout_rate)` to maintain expected activation magnitudes.

Modern transformer LLMs use very low dropout (0.0-0.1) because they're already heavily regularized by the data scale. Dropout is more important in smaller models or fine-tuning scenarios.

---

## E

### Embedding

A learned dense vector representation of a discrete entity (token, word, document, user, item). The embedding layer in a neural network is a lookup table of size `vocab_size × hidden_dim`. Token IDs are converted to embeddings by indexing this table.

The quality of embeddings is what makes modern NLP work. Pre-trained embeddings (word2vec, GloVe) gave way to contextual embeddings from BERT, which gave way to the input embeddings of LLMs, which serve as universal semantic representations.

```python
# PyTorch embedding layer
self.embed = nn.Embedding(vocab_size, hidden_dim)
token_ids = torch.tensor([0, 1, 2, 3])
vectors = self.embed(token_ids)  # (4, hidden_dim)
```

### Emergent Abilities

Capabilities that appear suddenly in LLMs at certain scale thresholds but are absent in smaller models. Examples: multi-step arithmetic, code generation, chain-of-thought reasoning. Whether these are truly "emergent" or just statistical artifacts of the evaluation metric is a hot debate (the "mirage" paper argues they're more predictable than they appear).

The most likely interpretation: there's a threshold of capability where the model becomes "good enough" to attempt a task, and small improvements past that threshold produce large jumps in success rate. Below the threshold, the model gets 0%; above it, it gets 80%.

### EOS Token (End of Sequence)

A special token (`<eos>`, `<|endoftext|>`, `</s>`, etc.) that signals the model should stop generating. During training, the model learns that this token terminates sequences. During generation, sampling stops when the model produces this token.

The choice of EOS token matters for instruction-following: instruct models use a chat-specific token (like `<|im_end|>` for Qwen) that's distinct from the pre-training EOS. Mismatched EOS tokens are a common source of generation issues — the model just keeps talking.

### Epoch

One complete pass through the entire training dataset. If you have 1M examples and a batch size of 100, one epoch is 10,000 optimizer steps. Training typically runs for multiple epochs (1-10) over the same data, though modern LM training usually runs for only 1 epoch because the datasets are so large.

### Expert Parallelism (EP)

A form of model parallelism for Mixture-of-Experts (MoE) models. Each expert (an FFN) lives on a subset of devices, and tokens are routed to the appropriate device before the expert FFN runs. This lets you scale the parameter count without scaling the compute, because each token only activates a few experts.

Used in Mixtral, GPT-4 (rumored), and other MoE models. The routing logic (which token goes to which expert) is learned, often with auxiliary load-balancing losses to prevent all tokens from going to one expert.

---

## F

### Fine-Tuning

Continuing training of a pre-trained model on a smaller, task-specific dataset. There are several flavors:

- **Full fine-tuning**: update all parameters. Most flexible, most expensive in compute and storage.
- **LoRA (Low-Rank Adaptation)**: freeze the base model, train low-rank decompositions of the weight updates. Cuts trainable parameters by 100-1000x.
- **QLoRA**: LoRA + 4-bit quantization of the base model. Trains 70B models on a single GPU.
- **Prefix tuning / Prompt tuning**: prepend learned continuous embeddings to the input. Even fewer parameters.

### FlashAttention

An IO-aware exact attention algorithm that computes standard attention in a memory-efficient way by tiling the computation to fit in fast SRAM and avoiding materialization of the full `N×N` attention matrix. It achieves 2-4x speedup and 5-20x memory reduction over naive attention.

FlashAttention-2 and FlashAttention-3 are the modern versions. They're integrated into PyTorch (`torch.nn.functional.scaled_dot_product_attention` with the right backend flag) and used by virtually all serious LM training pipelines.

### Few-Shot Learning

Giving a model a small number of examples in the prompt to demonstrate the task, rather than fine-tuning. GPT-3 popularized this with its "in-context learning" capability — the model can pick up new tasks from just a handful of demonstrations in the prompt.

In production, few-shot prompting is used for structured tasks (extraction, classification) where examples significantly improve consistency over zero-shot. The cost is prompt length — each example eats context tokens.

### FP16 / BF16 / FP8

Reduced-precision floating point formats used to speed up training and reduce memory. FP16 (half precision) has more range than you'd think but limited exponent — can overflow with gradient explosion. BF16 (bfloat16) is the modern default for LM training: same exponent range as FP32, 8 bits of mantissa instead of 16, fits in 2 bytes.

FP8 is the newest, used in H100 GPUs. Two variants: E4M3 (more precision, less range) and E5M2 (more range, less precision). Mixed-precision training (FP32 master weights, BF16 forward/backward) is the standard recipe.

---

## G

### GELU (Gaussian Error Linear Unit)

The activation function used in GPT and BERT. Unlike ReLU which is a hard zero for negative inputs, GELU smoothly weights inputs by their value, with negative small-magnitude inputs being partially active. The exact formula involves the Gaussian CDF; the approximation `0.5x(1 + tanh(sqrt(2/pi) * (x + 0.044715x^3)))` is used in practice.

GELU empirically outperforms ReLU for transformer LMs, and is one of the small architectural details that distinguishes modern LLMs from older ReLU-based models.

### GQA (Grouped Query Attention)

A variant of multi-head attention where multiple query heads share the same key and value head. Standard MHA has separate K, V projections per head. MQA (Multi-Query Attention) has one K, V head shared across all queries. GQA is the middle ground: e.g., 8 query heads sharing 2 K/V groups.

GQA dramatically reduces the KV cache size during inference (by 4-8x for 8x grouping) with minimal quality loss. Used in LLaMA 2 70B, Mistral, and most modern efficient inference stacks. The quality-vs-speed tradeoff is so favorable that GQA is essentially the default now.

### Gradient Checkpointing

A memory-saving technique that trades compute for memory. Instead of storing all intermediate activations for the backward pass, you recompute them on the fly during backward. This reduces activation memory by ~sqrt(N) where N is the number of layers, at the cost of ~30% slower training.

Essential for fitting large models in GPU memory. PyTorch supports it via `torch.utils.checkpoint.checkpoint`. You wrap a block of layers in a checkpoint, and only the block's input and output are stored; the rest is recomputed.

### GRPO (Group Relative Policy Optimization)

A reinforcement learning algorithm used in recent reasoning models (DeepSeek-R1, etc.) that eliminates the critic/value model of PPO. Instead, it samples multiple responses per prompt, scores them with a reward model, and uses the relative ranking within the group as the advantage estimate.

GRPO is much simpler than PPO (no separate value network to train) and has been shown to produce strong reasoning improvements. It's the algorithm behind the recent reasoning-focused models.

---

## H

### Hidden Dimension

The size of the internal representations in a neural network. For a transformer, this is `d_model` (e.g., 4096 for LLaMA 7B, 8192 for 70B). The hidden dimension is the primary determinant of model capacity and memory usage — doubling it roughly quadruples parameter count and memory.

The FFN hidden dimension is typically 4x the model dimension (so 16384 for 7B, 32768 for 70B), with newer architectures using gated variants (SwiGLU) that use 2/3 of that to keep parameter count constant.

### HumanEval

The most widely cited benchmark for code generation. 164 hand-written Python problems, each with a function signature, docstring, and hidden test cases. The model writes the function body, and pass@k (probability of passing all tests in k attempts) is the metric.

HumanEval has known issues: contamination (models may have seen the problems during training), narrow difficulty range, and Python-specific. Newer benchmarks (MBPP+, LiveCodeBench, SWE-bench) address some of these but HumanEval is still the standard reference.

### Hugging Face

The de facto standard library for transformer models in Python. Provides pretrained weights for thousands of models, tokenizers, training utilities (Trainer, Accelerate), and the datasets library. Most open-source model releases come with HF-compatible weights.

The `transformers` library exposes models via a uniform API: `AutoModelForCausalLM.from_pretrained()`, `model.generate()`, etc. Production code often uses vLLM or TGI for serving (faster than HF's generation), but HF is the standard for training and fine-tuning.

---

## I

### Inference

Using a trained model to generate predictions. For LLMs, this is dominated by autoregressive generation: each forward pass produces one token, so generating 1000 tokens requires 1000 sequential forward passes (with caching to avoid redundant computation).

Key inference optimizations: KV caching (reuse attention key/value tensors across tokens), speculative decoding (use a small draft model to propose tokens that a large model verifies in parallel), quantization (run with 4 or 8-bit weights for memory and speed), batching (process multiple requests together), paged attention (manage KV cache memory like virtual memory).

### Instruction Tuning

Fine-tuning a pre-trained LM on (instruction, response) pairs so the model learns to follow instructions. The base model is trained on raw text and completes sentences; after instruction tuning, it follows user requests.

Datasets: FLAN, Natural Instructions, Alpaca, Dolly, ShareGPT, OpenAssistant. Modern open models (LLaMA 2 Chat, Mistral Instruct, Qwen Chat) all go through instruction tuning as a final stage.

### Instruction-Following Evaluation

Evaluating how well a model follows user instructions. MT-Bench (multi-turn conversations judged by an LLM), AlpacaEval (win rate vs reference), Chatbot Arena (Elo ratings from human votes), and HumanEval (code) are the standard benchmarks.

The most predictive of real user satisfaction is Chatbot Arena's Elo rating — it's based on thousands of head-to-head human votes. The leaderboard is at lmarena.ai.

---

## J

### JFT (Google's internal dataset)

The "JFT" dataset is Google's internal training dataset for image models, with hundreds of millions of labeled images. It was used to train the original ViT and other Google vision models. Not publicly available.

For text, the equivalent is Google's "C4" (Colossal Clean Crawled Corpus) and various internal datasets. The size and quality of pre-training data is a major competitive moat for frontier labs.

### JSON Mode / Structured Output

Forcing the model to output valid JSON or a specific schema. This is critical for production systems that need to parse model outputs reliably. Most modern APIs (OpenAI, Anthropic, etc.) support structured output modes where the model's output is constrained to a provided JSON schema.

Without structured output, you have to use regex parsing, retry on parse failures, or other brittle techniques. Structured output guarantees the model emits valid JSON conforming to your schema.

---

## K

### Kernel

In the attention context, the matrix `Q @ K^T / sqrt(d_k)` before softmax. The "kernel trick" in classical ML is unrelated — that's about SVMs.

The kernel matrix has shape `(seq_len, seq_len)`. For long sequences this is the bottleneck of attention memory. FlashAttention, sparse attention, and linear attention are all techniques to avoid materializing the full kernel matrix.

### KV Cache

The cached key and value tensors from previous tokens during autoregressive generation. Since the keys and values for token `i` don't depend on future tokens, we can store them and reuse for all subsequent generation steps.

Without KV cache, generating `n` tokens requires O(n²) total compute. With KV cache, it's O(n) per step (constant) and O(n) total. The cache size is `2 * n_layers * n_heads * seq_len * head_dim`, which for a 70B model with 8K context can exceed 10GB per request.

### Knowledge Distillation

Training a smaller "student" model to mimic a larger "teacher" model. The student is trained on the teacher's soft probabilities (the full distribution over the vocabulary, not just the argmax) plus the original hard targets. This often produces better students than training the small model from scratch on the same data.

Distillation is used to make deployment cheaper: distill GPT-4 into a 7B model, distill a reasoning model into a fast model, etc. The "logit distillation" loss is typically `KL(teacher_probs || student_probs) * T^2` where T is a temperature parameter.

---

## L

### LLaMA

Meta's open-weight LLM family (LLaMA 1/2/3/3.1/3.2). LLaMA 1 (Feb 2023) was a research-only release; LLaMA 2 (Jul 2023) was commercially usable; LLaMA 3 (Apr 2024) added multimodal and tool use; LLaMA 3.1 (Jul 2024) reached 405B parameters matching GPT-4 quality.

Architectural innovations in LLaMA: RMSNorm instead of LayerNorm, SwiGLU activation, RoPE positional encoding, GQA for the larger models. LLaMA 3 also introduced a 128K-token vocabulary tokenizer for better multilingual coverage.

### Label Smoothing

A regularization technique for classification: instead of using one-hot targets `[0, 1, 0]`, use soft targets `[0.01, 0.98, 0.01]`. The model is encouraged to be slightly less confident, which improves generalization and calibration.

Used in many vision and LM models. Effect: small but consistent improvement on most tasks. Not always worth the implementation complexity for small models.

### Layer Normalization (LayerNorm)

Normalizes activations across the feature dimension for each token independently. Given activations of shape `(B, T, D)`, LayerNorm computes mean and variance across D for each (B, T) position, then scales and shifts with learned parameters.

LayerNorm is the standard in transformers because it's independent of batch size and works with variable sequence lengths. Variants: RMSNorm (no mean-centering, just scale by RMS), which is what LLaMA uses and is slightly faster.

### Learning Rate Schedule

How the learning rate changes during training. The standard recipe for transformer LMs is a linear warmup from 0 to peak LR over the first 1-5% of steps, then a cosine decay back to ~10% of peak over the remaining steps. Some recent papers use constant LR or trapezoidal schedules (constant then cool down).

For fine-tuning, smaller learning rates (1e-5 to 1e-4) with shorter or no warmup are typical.

### LoRA (Low-Rank Adaptation)

A parameter-efficient fine-tuning method. Instead of updating the full weight matrix `W` (size `d × d`), you learn a low-rank decomposition `W + B @ A` where `B` is `d × r` and `A` is `r × d` with rank `r << d`. Only `B` and `A` are trained; `W` is frozen.

LoRA reduces trainable parameters by 100-1000x (e.g., from 7B to 3-70M for a 7B model) with minimal quality loss. Multiple LoRA adapters can be trained for different tasks and swapped in/out efficiently.

```python
from peft import LoraConfig, get_peft_model
config = LoraConfig(r=16, lora_alpha=32, target_modules=["q_proj", "v_proj"])
model = get_peft_model(base_model, config)
```

---

## M

### Mamba

A state-space model (SSM) architecture that's an alternative to transformers for sequence modeling. Unlike attention, Mamba has linear (not quadratic) complexity in sequence length and recurrent inference (constant memory per step).

Mamba-2 is the latest version. It claims to match transformer quality on language modeling while being much faster for long sequences. The architecture uses selective state spaces — input-dependent dynamics that allow the model to selectively remember or forget.

### Masked Language Modeling (MLM)

The training objective of BERT and similar models. ~15% of input tokens are randomly masked, and the model must predict the original tokens from the surrounding context. This trains bidirectional representations.

BERT was trained with MLM, then RoBERTa improved it (more data, longer training, dynamic masking). T5 uses a span-corruption variant where contiguous spans are replaced with sentinels.

### MHA / MQA / GQA

Three variants of multi-head attention distinguished by how many KV heads they use:

- **MHA (Multi-Head Attention)**: H query heads, H key heads, H value heads. Standard transformer.
- **MQA (Multi-Query Attention)**: H query heads, 1 key head, 1 value head. Used in PaLM. Faster inference, small quality loss.
- **GQA (Grouped Query Attention)**: H query heads, G key/value heads (1 < G < H). The middle ground. Used in LLaMA 2 70B, Mistral.

GQA is the practical sweet spot: nearly the inference speed of MQA with quality close to MHA. It's now the default in most new architectures.

### Mixture of Experts (MoE)

A model architecture where each "expert" is a separate FFN, and a learned router directs each token to a subset of experts. This lets the model have many more parameters (each expert) without proportionally increasing compute (each token only activates a few experts).

Mixtral 8x7B, for example, has 8 experts of 7B size each, but only activates 2 per token — so the effective compute is similar to a 14B dense model while having ~47B total parameters. Quality is closer to the larger parameter count, while speed is closer to the smaller.

### Mixture of Tokens

A training technique where you train on multiple "views" of the same text: original, paraphrased, translated to other languages. Helps the model learn language-agnostic representations.

Used in some multilingual models to improve transfer between languages.

### Mixture-of-Depths (MoD)

A technique where the model dynamically decides how many layers to apply to each token. Easy tokens might skip most layers; hard tokens get full depth. Reduces average compute while preserving quality on hard examples.

---

## N

### N-Gram

A contiguous sequence of N tokens. Used in classical NLP for language modeling and feature engineering. N-gram language models compute `P(token | previous N-1 tokens)` and are the historical baseline before neural LMs.

Modern LLMs can be seen as extremely high-order n-gram models with neural smoothing. BLEU and ROUGE metrics are also n-gram based.

### Next-Token Prediction

The training objective of every modern LM. Given a sequence of tokens, predict the next one. The loss is cross-entropy between the predicted distribution and the actual next token.

Simple, scalable, and produces models with remarkable capabilities. The "bitter lesson" in action: just scaling up next-token prediction with enough data and compute produces models that can do math, code, reasoning, and more.

### NF4 (4-bit NormalFloat)

The 4-bit quantization format used in QLoRA. It's not a uniform 4-bit representation; the quantization levels are spaced according to a normal distribution, which matches the typical distribution of neural network weights.

QLoRA combines NF4 quantization of the base model with LoRA adapters in higher precision. The result: fine-tune a 65B model on a single 48GB GPU.

---

## O

### Overfitting

The model memorizes the training data instead of learning generalizable patterns. Detected by training loss going down while validation loss goes up. Mitigated by more data, regularization (dropout, weight decay), early stopping, or smaller models.

Modern LMs are often trained for only 1 epoch over huge datasets, which largely avoids overfitting. The risk re-emerges during fine-tuning on small datasets, which is why LoRA and other parameter-efficient methods are popular.

---

## P

### Padding

Adding special tokens (usually 0 or a dedicated `<pad>` token) to make sequences in a batch the same length. Padding is necessary for batching but should be masked out in attention — otherwise the model attends to pad tokens and produces nonsense.

Modern libraries use "flash attention with padding mask" or "variable-length attention" that ignores padding tokens efficiently. The padding side (left vs right) matters for generation: pad on the left so the actual content aligns with the start position.

### Perplexity (PPL)

The standard metric for language model quality. PPL is `exp(loss)` where loss is the average cross-entropy per token. Lower is better. A model with PPL 10 is confused about which of 10 tokens comes next on average.

PPL is good for comparing models on the same data. It's less useful for cross-domain comparison (a model can have PPL 5 on Wikipedia and PPL 50 on code). It's also not a measure of factuality or usefulness — just next-token predictability.

### Pipeline Parallelism (PP)

A form of model parallelism where consecutive layers of the model live on different devices. Layer 0-7 on GPU 0, 8-15 on GPU 1, etc. Data flows through the pipeline. Bubbles (idle GPU time during the warmup/teardown) are the main inefficiency.

Pipeline parallelism is necessary for models too large to fit on a single device. Often combined with tensor parallelism (split individual layers across GPUs) and data parallelism (replicate the whole pipeline). GPipe and PipeDream are the original systems.

### Positional Encoding

A mechanism to give the model information about token position, since self-attention is permutation-invariant without it. Three main families:

- **Absolute (sinusoidal, learned)**: add a position-dependent vector to the input embedding. Used in original Transformer and BERT.
- **Relative (RoPE, ALiBi)**: encode position into the attention computation itself. Used in modern LLMs.
- **No positional encoding (NoPE)**: surprisingly, attention without any positional info can learn some positional patterns. But it underperforms on long sequences.

### PPO (Proximal Policy Optimization)

The RL algorithm that made RLHF work. It optimizes the policy (the LM) to maximize a reward signal (from the reward model) while staying close to the reference policy (the SFT model) to prevent the model from going off the rails.

PPO is notoriously tricky to train: it's sensitive to hyperparameters, needs a separate value model, and the reward model is also being learned simultaneously. This is why simpler alternatives like DPO and GRPO have largely replaced PPO for alignment.

### Prefix Tuning

A parameter-efficient fine-tuning method where you prepend learned continuous embeddings to the input at every layer. The model is frozen; only the prefix embeddings are trained. Even fewer parameters than LoRA, but typically lower quality for the same compute.

### Prompt Engineering

Crafting inputs to LLMs to get better outputs. Key techniques: be specific, give examples (few-shot), use chain-of-thought, structure with delimiters, specify format, ask the model to think step by step, use system messages to set behavior, use personas.

For production systems, prompt engineering is often augmented with structured output, tool use, and RAG. Modern models are robust to poorly-worded prompts but precise prompts still produce more consistent results.

---

## Q

### QLoRA

Quantized LoRA. A fine-tuning technique that combines 4-bit NF4 quantization of the base model with LoRA adapters. The base model uses ~4x less memory than FP16, making it possible to fine-tune 65B models on a single GPU.

The "Q" is for the 4-bit base; the "LoRA" is the standard LoRA on top. Training is slightly slower than pure LoRA, but the memory savings are massive.

### Quantization

Reducing the precision of model weights (and sometimes activations) to save memory and speed up inference. Common formats: FP16 (2 bytes), INT8 (1 byte), INT4 (0.5 bytes). The accuracy loss from FP16 to INT8 is usually <1%; INT4 is more aggressive with measurable quality loss that you can compensate for with calibration data.

Quantization methods: post-training quantization (PTQ) is fast but loses more accuracy; quantization-aware training (QAT) trains with quantization in the loop and recovers most of the loss.

---

## R

### RAG (Retrieval-Augmented Generation)

The pattern of retrieving relevant documents from a knowledge base and including them in the LLM's context to answer queries. This grounds the model in external knowledge, reduces hallucination, and enables updating knowledge without retraining.

Standard RAG pipeline: embed query → retrieve top-k from vector DB → rerank → stuff into prompt → generate. Variations: HyDE (generate hypothetical answer, embed that), multi-hop retrieval, recursive retrieval, agentic RAG where the LLM decides what to retrieve.

### ReLU (Rectified Linear Unit)

`f(x) = max(0, x)`. The simplest and most historically common activation. Computationally cheap, no saturation for positive inputs, but "dying ReLU" problem (neurons that always output 0 if they get pushed into negative territory) can happen with bad initialization.

GELU, SwiGLU, and other smooth activations have largely replaced ReLU in modern LLMs but ReLU is still used in some vision models and older transformer architectures.

### Reranking

The second stage of a typical retrieval pipeline. The retriever returns top-k candidates (say 100), and a more expensive but accurate model (often a cross-encoder that scores query-document pairs jointly) reranks them to top-n (say 5) for the final prompt.

Reranking dramatically improves precision at minimal cost. The cross-encoder is too slow for first-stage retrieval (you can't run it on millions of docs) but fine for reranking 100 candidates.

### Reward Model

In RLHF, a model trained to predict which of two responses a human would prefer. Given a prompt and two responses (chosen, rejected), the reward model learns to assign a higher scalar to the chosen one. This scalar is the reward signal used to train the policy LM with PPO.

Reward models are notoriously noisy — they overfit to length, formatting, and other spurious features. This is one reason DPO (which doesn't need a reward model) has become popular.

### RMSNorm (Root Mean Square Normalization)

A simpler variant of LayerNorm. Instead of subtracting the mean and dividing by the standard deviation, RMSNorm just divides by the RMS of the activations (no mean-centering), then applies a learned scale. This is what LLaMA uses.

RMSNorm is slightly faster than LayerNorm and works just as well in practice. The lack of mean-centering doesn't hurt because the subsequent linear layer can learn any shift.

### RoPE (Rotary Position Embedding)

The most common positional encoding in modern LLMs. Instead of adding position-dependent vectors to the input, RoPE rotates the query and key vectors by position-dependent angles before the attention dot product. This naturally encodes relative position — the attention score between positions `i` and `j` depends only on their relative distance.

RoPE enables length extrapolation: a model trained on 4K context can be extended to 32K+ at inference by adjusting the rotation frequencies. Used in LLaMA, Mistral, and most modern LLMs.

```python
# Simplified RoPE
def apply_rope(x, freqs):
    # x: (B, n_heads, seq_len, head_dim)
    # freqs: (seq_len, head_dim/2)
    x_rot = torch.stack([x[..., ::2], x[..., 1::2]], dim=-1)
    x_rot = x_rot.permute(0, 1, 2, 4, 3)
    cos = freqs.cos().unsqueeze(0).unsqueeze(0)
    sin = freqs.sin().unsqueeze(0).unsqueeze(0)
    x_out = x_rot * cos + torch.stack([-x_rot[..., 1], x_rot[..., 0]], dim=-1) * sin
    return x_out.flatten(-2)
```

---

## S

### Sampling Strategies

Methods for choosing the next token from the model's probability distribution. The main options:

- **Greedy**: always pick the highest-probability token. Deterministic, often repetitive.
- **Temperature**: scale logits by 1/T before softmax. T=1 is unchanged, T<1 sharpens (more deterministic), T>1 flattens (more random).
- **Top-k**: sample from only the k most likely tokens. Cuts off the long tail.
- **Top-p (nucleus)**: sample from the smallest set of tokens whose probabilities sum to p. Adaptive to the distribution shape.
- **Min-p**: sample from tokens with probability >= min_p * max_probability.

Top-p with temperature is the default for most chat models. Greedy is used for translation and structured outputs.

### Self-Attention

The attention mechanism where Q, K, V all come from the same sequence. Each token attends to all previous tokens (causal) or all tokens (bidirectional). This is the core of the transformer.

Self-attention is O(n²) in sequence length. For long sequences, alternatives like linear attention, sparse attention, or state-space models (Mamba) are used.

### Self-Supervised Learning

Learning from unlabeled data by creating labels from the data itself. The dominant paradigm for foundation model pre-training: predict the next word (LM), predict masked words (BERT), contrastive pairs (CLIP), etc.

The key insight: the structure of unlabeled data (next word follows previous words, patches of an image are related, audio frames are continuous) provides enough signal to learn rich representations without human annotation.

### SentencePiece

A language-independent subword tokenizer. Unlike BPE which operates on pre-split words, SentencePiece treats the input as a raw byte stream (after adding a whitespace marker) and learns subwords directly. This makes it work well for languages without explicit word boundaries (Chinese, Japanese, Thai).

LLaMA, Mistral, and many other models use SentencePiece BPE. The alternative is tiktoken (used by OpenAI), which is also BPE but optimized for speed.

### Sequence Packing

A training efficiency technique where multiple short sequences are concatenated into one long sequence (up to the max length), with attention masks preventing cross-attention between different sequences. This avoids wasting compute on padding tokens.

Used in most efficient LM training pipelines. Without packing, training on a dataset of mixed-length sequences wastes 30-70% of compute on padding.

### SLM (Small Language Model)

A small LM (typically <10B parameters) suitable for on-device or edge deployment. Examples: Phi-3 mini (3.8B), Gemma 2 2B, Llama 3.2 1B/3B, Qwen 2.5 3B.

Small models have improved dramatically — modern 3-7B models match GPT-3.5 quality from 2022. For many practical tasks (summarization, classification, simple Q&A), a well-tuned 7B model is sufficient and much cheaper to run.

### Sparsity

A general term for "most of the weights/activations are zero." In MoE, only some experts are active per token (sparse activation). In sparse attention, each token attends to only a subset of other tokens. In sparse models, most weights are zero (e.g., via magnitude pruning).

Sparsity is a way to scale model size without scaling compute. The challenge is that sparsity is hard to use efficiently on standard hardware (GPUs are optimized for dense ops).

### Speculative Decoding

An inference technique that uses a small "draft" model to generate K candidate tokens quickly, then has the large "target" model verify them all in one forward pass. The accepted tokens are kept, and the process repeats.

Speculative decoding gives 2-3x speedup with zero quality loss (the output distribution is provably identical to greedy/sampling from the target model). The catch: the draft model needs to be a good predictor of the target, and the verification step isn't free.

### Stochastic Gradient Descent (SGD)

The simplest optimizer: `theta -= lr * grad`. The foundation of all other optimizers. For neural networks, SGD is rarely used as-is because it converges slowly and gets stuck in saddle points. Adam/AdamW are preferred for transformers; SGD with momentum is still used for some vision models.

### Supervised Fine-Tuning (SFT)

The first stage of aligning a pre-trained LM: train on (prompt, response) pairs where the response is a high-quality demonstration. This teaches the model the format and style of instruction-following, but doesn't optimize for human preferences directly.

The "SFT model" is then used as the starting point for RLHF/DPO. SFT alone produces a usable chat model, just not as aligned as one that goes through preference optimization.

### SwiGLU (Swish-Gated Linear Unit)

A gated activation function used in LLaMA. The output is `Swish(W_1 @ x) * (W_2 @ x)` followed by a down-projection. The gating (multiplication of two linear projections) gives the network more capacity to selectively pass information.

SwiGLU is the de-facto standard in modern transformer LLMs (LLaMA, Mistral, Qwen). It's one of those small architectural details that consistently improves quality without much cost.

---

## T

### Temperature

A scaling factor applied to logits before softmax that controls the "sharpness" of the distribution. `probs = softmax(logits / T)`. T=1 is the model's natural distribution; T<1 sharpens (more deterministic); T>1 flattens (more random); T→0 is greedy; T→∞ is uniform.

For chat, T=0.7-1.0 is typical. For code generation, T=0.2-0.4 is common (more deterministic). For creative writing, T=1.0-1.5 is used.

### Tensor Parallelism (TP)

A form of model parallelism where individual weight matrices are split across multiple GPUs. For a linear layer with weight `W` of shape `(D, D)`, you can split `W` column-wise across N GPUs, each computing a slice of the output, then concatenate. The reverse for the backward pass.

TP is what makes models like 175B GPT-3 trainable: split each layer across 8 GPUs. The communication is all-reduce on the activations, which is fast on NVLink.

### Token

The atomic unit of text for an LM. A token is roughly 4 characters of English text on average (so 100 tokens ≈ 75 words). Tokens can be words, subwords, characters, or bytes, depending on the tokenizer.

The number of tokens determines cost (API pricing is per million tokens) and context length. GPT-4 supports 128K tokens; Claude 3 supports 200K; Gemini 1.5 supports 1M-2M.

### Tokenizer

The function that converts text to a sequence of token IDs (and back). The choice of tokenizer affects model quality, sequence length efficiency, and multilingual capability. Modern LMs use BPE or SentencePiece with vocabularies of 32K-100K tokens.

A mismatch between tokenizers (e.g., training with one, inferring with another) produces gibberish. Always use the same tokenizer the model was trained with.

### Top-p (Nucleus) Sampling

Sample from the smallest set of tokens whose probabilities sum to p. For p=0.9, find the 90% mass and sample from just those tokens. This adapts to the distribution: when one token has 90% probability, you only consider that one; when probabilities are spread, you consider many.

Top-p is the default for most chat APIs. Often combined with temperature: T=0.7, top_p=0.9 is the OpenAI default.

### Transformer

The dominant neural network architecture for NLP, introduced in "Attention is All You Need" (2017). It consists of stacked self-attention and feedforward layers, with residual connections and layer normalization. Decoder-only transformers (GPT, LLaMA) are the standard for LLMs.

The key insight: attention lets every token directly attend to every other token, replacing the sequential bottleneck of RNNs. The cost is O(n²) in sequence length, which has been the main driver of research into efficient attention variants.

### Tree of Thoughts (ToT)

A reasoning framework where the model explores multiple reasoning paths in parallel, evaluates each, and backtracks. More powerful than chain-of-thought (single linear chain) but more expensive in tokens and time. Useful for puzzles, planning, and tasks with multiple solution paths.

---

## U

### Unsupervised Learning

Learning patterns from unlabeled data. The dominant paradigm for foundation model pre-training: predict the next word, predict masked words, etc. — all from raw text without human labels.

Contrast with supervised learning (labeled examples) and reinforcement learning (reward signal).

---

## V

### VLLM (Vectorized Large Language Model)

A high-throughput LLM serving system. Key innovation: PagedAttention, which manages the KV cache like virtual memory (paged, non-contiguous allocation) to reduce fragmentation and enable better batching. Achieves 10-20x higher throughput than naive serving.

VLLM is the standard for serving open-source LLMs. Alternatives: TGI (HuggingFace), SGLang, TensorRT-LLM (NVIDIA-optimized).

### Vector Database

A database optimized for similarity search over high-dimensional vectors. Used in RAG, recommendation systems, and any application that needs to find "most similar" items. Examples: Pinecone, Weaviate, Milvus, Qdrant, Chroma.

The core data structure is usually HNSW (Hierarchical Navigable Small World), a graph-based approximate nearest neighbor index. For exact search, IVF (Inverted File Index) with PQ (Product Quantization) compression is common.

### Vision Transformer (ViT)

A transformer applied to images by splitting the image into patches (typically 16×16) and treating each patch as a token. ViT matches or beats CNNs on image classification when pre-trained on enough data (>100M images).

Multimodal LLMs (GPT-4V, LLaVA, etc.) use a ViT as the vision encoder, projecting patch embeddings into the LM's token space via a learned projection.

---

## W

### Warmup

A training technique where the learning rate starts at 0 and linearly increases to the peak over the first N steps. Warmup prevents early training instability when the model is far from converged and the gradients can be large.

For transformer LMs, warmup over 1-5% of total steps is standard. After warmup, the LR follows the main schedule (cosine decay is most common).

### Weights & Biases (W&B)

The most popular experiment tracking tool. Logs metrics, hyperparameters, system stats, and artifacts during training. UI for comparing runs, viewing learning curves, and sharing dashboards.

Used by most serious ML research teams. The alternatives: MLflow, TensorBoard, Neptune.

### WordPiece

A subword tokenization algorithm used by BERT. Similar to BPE but uses likelihood-based merging (merge the pair that most increases the language model likelihood) rather than frequency-based merging. In practice, the difference between BPE and WordPiece is small.

### Word2Vec

The 2013 paper that launched the modern word embedding era. Two architectures: CBOW (predict center word from context) and Skip-gram (predict context from center word). Trained with a hierarchical softmax or negative sampling for efficiency.

Word2Vec produced the famous "king - man + woman = queen" property, showing that semantic relationships are encoded as linear operations in the embedding space. Now obsolete (BERT/GPT embeddings are much better) but historically important.

---

## Z

### Zero-Shot Learning

Asking the model to perform a task without any examples. GPT-3 showed that large LMs can do zero-shot task transfer just from natural language descriptions of the task. Zero-shot is the weakest of the prompting strategies but the most general.

Modern LLMs (GPT-4, Claude 3) are remarkably capable at zero-shot, handling tasks they were never explicitly trained on. For high-stakes applications, few-shot or fine-tuning still helps.

---

## Quick Reference Tables

### Architecture Comparison

| Architecture | Complexity | Long context | Quality | Used in |
|---|---|---|---|---|
| Transformer (MHA) | O(n²) | Poor | Best at scale | GPT-3, original BERT |
| Transformer (GQA) | O(n²) | Better (smaller cache) | ~MHA | LLaMA 2 70B, Mistral |
| Mamba (SSM) | O(n) | Excellent | Competitive | Mamba-2 |
| Linear attention | O(n) | Good | Lower | Performer, Linear Transformer |
| Sparse attention | O(n√n) | Decent | Good | Longformer, BigBird |

### Optimizer Comparison

| Optimizer | Memory | Best for |
|---|---|---|
| SGD | Lowest | Vision with momentum |
| Adam | 2x params | General DL |
| AdamW | 2x params | Transformers, LMs |
| Lion | 1x params | Memory-constrained fine-tuning |
| Adafactor | Sub-linear | Very large models |

### Sampling Strategy Cheat Sheet

| Use case | Strategy | Temperature |
|---|---|---|
| Code | Top-p p=0.95 or greedy | 0.2-0.4 |
| Chat | Top-p p=0.9 | 0.7-1.0 |
| Creative writing | Top-p p=0.95 | 1.0-1.4 |
| Math/reasoning | Greedy or low-temp | 0.0-0.3 |
| Translation | Beam search or greedy | 0.0 |
| Summarization | Top-p p=0.9 | 0.5-0.7 |
| Classification | Greedy | 0.0 |

### Common Acronyms

| Acronym | Meaning |
|---|---|
| MHA / MQA / GQA | Multi-Head / Multi-Query / Grouped Query Attention |
| KV cache | Key-Value cache (inference optimization) |
| RoPE | Rotary Position Embedding |
| ALiBi | Attention with Linear Biases |
| FFN | Feed-Forward Network |
| MLP | Multi-Layer Perceptron |
| LM | Language Model |
| LLM | Large Language Model |
| MMLU | Massive Multitask Language Understanding |
| RLHF | Reinforcement Learning from Human Feedback |
| DPO | Direct Preference Optimization |
| PPO | Proximal Policy Optimization |
| GRPO | Group Relative Policy Optimization |
| SFT | Supervised Fine-Tuning |
| DP / DDP | Data Parallel / Distributed Data Parallel |
| TP / PP / EP | Tensor / Pipeline / Expert Parallelism |
| FSDP | Fully Sharded Data Parallel |
| BPE | Byte Pair Encoding |
| LR | Learning Rate |
| SLO | Service Level Objective |
| KV | Key-Value |

---

## Interview Cheat Sheet

**Key Points to Remember:**
- A comprehensive A-Z reference for ML/AI interview terms.
- Covers: activation functions (ReLU, GELU, sigmoid), loss functions (cross-entropy, MSE, contrastive), optimizers (SGD, Adam, AdamW), regularization (dropout, L1/L2, label smoothing), evaluation (precision, recall, F1, BLEU, ROUGE), architectures (CNN, RNN, Transformer, Diffusion), training techniques (transfer learning, fine-tuning, LoRA, RLHF).

**Common Follow-Up Questions:**
- "What's the difference between Adam and AdamW?" — AdamW decouples weight decay from the gradient update, giving better generalization. Adam applies L2 regularization via the gradient, which interacts poorly with adaptive learning rates.
- "What is RLHF?" — Reinforcement Learning from Human Feedback: train a reward model on human preferences, then optimize the LLM with PPO to maximize reward. Used by ChatGPT.

**Gotcha:** Not knowing the difference between fine-tuning approaches. Full fine-tuning updates all weights (expensive). LoRA trains small adapters (cheap). Prefix tuning prepends learned vectors to the input. Each has different memory and quality trade-offs.
