---
title: "RAG Pipeline (Chunking, Embeddings, Retrieval, Reranking)"
type: system-design
category: AI/ML
date: 2026-06-18
tags: [system-design, interview, ai-ml, rag, retrieval-augmented-generation, embeddings, chunking, vector-search, reranking, hnsw, hybrid-search, llm, staff-engineering]
aliases: ["RAG Pipeline", "Retrieval-Augmented Generation", "Chunking Strategies", "Reranking", "Vector Search"]
---

# RAG Pipeline (Chunking, Embeddings, Retrieval, Reranking)

> **Staff-Engineer Focus:** "We use RAG to ground LLM responses in our documents" is the mid-level answer. Understanding that RAG isn't one pipeline but a composition of independently tunable stages — and that each stage has a distinct failure mode that silently degrades quality — that's the senior answer. **The staff engineer doesn't ask "should I use RAG?" They ask: "What accuracy threshold does this use case require? What is the cost of a retrieval miss vs. a hallucination? How do you measure recall when there's no ground truth? And what happens when the underlying documents change — does the pipeline stale out, or does it self-correct?" A retrieval system that returns the wrong chunk with 99% confidence is more dangerous than one that returns nothing at all. The interview question isn't "Explain RAG." It's: "Your RAG pipeline serves a customer support chatbot with 50K product docs. Users report that answers sometimes reference outdated product specs and occasionally fabricate details not in any document. Walk me through: (a) how you'd diagnose whether the failure is in chunking, embedding, retrieval, reranking, or generation, (b) how you'd detect document staleness without manual review, (c) what metrics you'd monitor to catch retrieval degradation before users complain, and (d) why adding a reranker with higher precision can paradoxically increase hallucination rate if your chunking strategy doesn't preserve context boundaries."**

---

## Summary & Interview Framing

A pipeline that grounds LLM responses in real documents — chunking text, embedding chunks into vectors, retrieving relevant chunks via ANN search, and optionally reranking for precision.

**How it's asked:** "Design a RAG pipeline for a customer support chatbot with 50K product docs. Cover chunking strategy, embedding model selection, vector search, reranking, and hallucination detection."

---

## 1. What Is RAG and Why It Exists

### 1.1 The LLM Limitation

LLMs are trained on static corpora with a knowledge cutoff. They:
- **Hallucinate** when asked about facts not in training data
- **Can't access private/proprietary documents** (your company's internal wiki, product specs, legal contracts)
- **Don't know about events after training cutoff**
- **Struggle with precise, verifiable answers** — they're optimized for plausibility, not accuracy

Fine-tuning on domain data helps, but:
- New documents require re-fine-tuning
- Fine-tuning bakes knowledge into weights — hard to audit, update, or remove
- No way to cite sources ("where did you get that from?")

### 1.2 The RAG Solution

**Retrieval-Augmented Generation (RAG)** splits the problem into two parts:

```
┌─────────────────────────────────────────────────────────────────┐
│                         RAG PIPELINE                             │
│                                                                  │
│  ┌──────────┐   ┌───────────┐   ┌──────────┐   ┌────────────┐  │
│  │ Document │ → │ Chunking  │ → │ Embedding │ → │  Vector DB  │  │
│  │ Ingest   │   │ Strategy  │   │  Model    │   │  (Index)    │  │
│  └──────────┘   └───────────┘   └──────────┘   └─────┬──────┘  │
│                                                       │         │
│  ┌──────────┐   ┌───────────┐   ┌──────────┐   ┌─────▼──────┐  │
│  │  Answer  │ ← │    LLM    │ ← │  Prompt  │ ← │ Retrieval  │  │
│  │  (cited) │   │ Generation│   │ Assembly │   │ + Rerank   │  │
│  └──────────┘   └───────────┘   └──────────┘   └────────────┘  │
│                                                                  │
│  User Query ──────────────────────────────────────────────────► │
└─────────────────────────────────────────────────────────────────┘
```

1. **Ingest:** Documents are split into chunks, embedded into vectors, and stored in a vector database.
2. **Query:** User query is embedded, similar chunks are retrieved, optionally reranked, and injected into the LLM prompt.
3. **Generate:** LLM produces an answer grounded in the retrieved context, often with citations.

The key insight: **The LLM is no longer the source of truth — the retrieval system is.** If retrieval returns wrong chunks, the LLM will confidently produce a wrong answer. The LLM can't tell you "hey, these chunks are about a different product."

---

## 2. Chunking: The Foundation Everything Else Depends On

Chunking is the most underappreciated part of RAG. Every downstream stage — embedding quality, retrieval accuracy, reranking precision — depends on how you split documents.

### 2.1 The Chunking Trade-Off

| Chunk Size | Pros | Cons |
|-----------|------|------|
| **Small (128-256 tokens)** | High precision; exact match for specific facts | Loses surrounding context; one chunk may not contain full answer |
| **Medium (512-1024 tokens)** | Good balance; captures paragraph-level context | May split a concept across chunk boundaries |
| **Large (2048-4096 tokens)** | Rich context; answer likely in single chunk | Dilutes embedding signal; "needle in haystack" problem; hits LLM context limits when assembling prompt |

### 2.2 Chunking Strategies

**A. Fixed-Size Chunking (Character/Token-Based)**

The simplest approach: split every N characters or tokens.

```
def chunk_by_tokens(text, chunk_size=512, overlap=50):
    tokens = tokenizer.encode(text)
    chunks = []
    for i in range(0, len(tokens), chunk_size - overlap):
        chunk = tokens[i:i + chunk_size]
        chunks.append(tokenizer.decode(chunk))
    return chunks
```

**Problem:** Splits sentences mid-thought. A chunk might contain "The revenue for Q3 was" and the next chunk contains "$4.2 million, a 15% increase." Neither chunk alone answers "What was Q3 revenue?"

**B. Semantic Chunking (Sentence/Paragraph-Based)**

Split on natural boundaries: sentences, paragraphs, sections. Use NLP to detect topic shifts.

```python
# Split on sentence boundaries, then merge until chunk_size reached
from nltk.tokenize import sent_tokenize

def semantic_chunk(text, max_chunk_size=512):
    sentences = sent_tokenize(text)
    chunks = []
    current_chunk = []
    current_size = 0
    
    for sentence in sentences:
        sentence_tokens = len(tokenizer.encode(sentence))
        if current_size + sentence_tokens > max_chunk_size and current_chunk:
            chunks.append(" ".join(current_chunk))
            current_chunk = [sentence]
            current_size = sentence_tokens
        else:
            current_chunk.append(sentence)
            current_size += sentence_tokens
    
    if current_chunk:
        chunks.append(" ".join(current_chunk))
    return chunks
```

**Problem:** Can still split related concepts if the document has long sections.

**C. Recursive Character Splitting (LangChain Default)**

Split by increasingly granular separators: `\n\n` (paragraphs) → `\n` (lines) → `.` (sentences) → ` ` (words). Falls back to character-level only when necessary.

```
Separators: ["\n\n", "\n", ". ", " ", ""]

Try "\n\n" → chunks too large? → Try "\n" → still too large? → Try ". " → ...
```

This is the most widely used strategy out of the box but still doesn't understand document structure.

**D. Document-Aware Chunking (Structure-Preserving)**

Parse the document's actual structure — Markdown headings, HTML tags, PDF sections — and chunk accordingly.

```
Markdown:
# Product Spec: Widget Pro 3000        ← Chunk boundary
## Technical Specifications             ← Chunk boundary
| Feature | Value |                    ← This table stays together
| Weight  | 2.3kg |
| Battery | 5000mAh |
## Pricing                             ← Chunk boundary
$299 retail, $249 enterprise
```

**Why this matters:** A query about "Widget Pro 3000 battery" should retrieve a chunk containing the full specifications table, not just the row with "5000mAh." Context matters.

**E. Agentic Chunking (LLM-Powered)**

Use an LLM to decide chunk boundaries: "Split this document into self-contained sections where each section fully answers a likely question." Most accurate, but slow and expensive for ingestion.

### 2.3 Overlap & Context Windows

**Overlap** (sliding window between chunks) prevents information loss at chunk boundaries:

```
Chunk 1:  [The Q3 revenue was $4.2M, a 15% increase over Q2. The growth...]
                              ← overlap = 50 tokens →
Chunk 2:             [...15% increase over Q2. The growth was driven by...]
```

**Advanced: Sentence-Boundary Window Retrieval.** Store chunks normally but at retrieval time, fetch each chunk PLUS its N preceding and following sentences. This gives you fixed-size storage with dynamic context windows.

```python
def retrieve_with_context(chunk_id, window=2):
    chunk = vector_db.get(chunk_id)
    preceding = document.get_sentences_before(chunk_id, n=window)
    following = document.get_sentences_after(chunk_id, n=window)
    return preceding + chunk + following
```

### 2.4 The "Lost in the Middle" Phenomenon

LLMs pay most attention to the beginning and end of the prompt context. Chunks placed in the middle of the assembled context are more likely to be ignored. This means:

- **Reranker ordering matters:** Top-ranked chunks go first and last, not in the middle
- **Chunk count matters:** 3-5 chunks is often better than 10 — more chunks can actually reduce accuracy
- **Strategic placement:** Put the most relevant chunk at the very end of the context, just before the question

---

## 3. Embeddings: Turning Text Into Numbers

### 3.1 What an Embedding Model Does

An embedding model converts text into a fixed-length vector (e.g., 768, 1024, or 1536 dimensions). The key property: **semantically similar texts have vectors that are close together in vector space.**

```
"cat"         → [0.12, -0.45, 0.78, ...]
"kitten"      → [0.11, -0.43, 0.79, ...]  ← close to "cat"
"automobile"  → [-0.89, 0.23, -0.12, ...] ← far from "cat"
```

### 3.2 Embedding Model Selection

| Model | Dimensions | Max Tokens | Notes |
|-------|-----------|------------|-------|
| **OpenAI text-embedding-3-small** | 512/1536 | 8191 | Cost-effective; good general-purpose |
| **OpenAI text-embedding-3-large** | 256/1024/3072 | 8191 | Best quality; Matryoshka — can truncate dims without full recomputation |
| **Cohere Embed v3** | 1024 | 512 | Strong on multilingual; supports input_type parameter for query vs. doc |
| **BGE-M3 (BAAI)** | 1024 | 8192 | Open-source; supports dense + sparse (hybrid) in one model |
| **E5 Mistral** | 4096 | 32768 | Very long context window; good for large chunks |
| **Jina AI v3** | 1024 | 8192 | Task-specific (retrieval, clustering, classification) |

**Staff-Engineer Considerations:**
- **Matryoshka embeddings** (OpenAI, some open models): you can truncate the vector and keep semantic meaning. A 1536-dim vector truncated to 256-dim still works at ~95% quality. This lets you trade recall for storage/memory. Truncate at index time, not query time, so you only store what you need.
- **Task-specific prefixes:** BGE and E5 models expect prefixes: `"Represent this sentence for searching relevant passages: {query}"` for queries and `"{passage}"` for documents. Forgetting the prefix silently degrades quality by 5-10%.
- **Fine-tuning embeddings:** If your domain has specialized vocabulary (legal, medical, engineering), fine-tune an embedding model on your domain's query-document pairs. A 1% recall improvement at retrieval cascades into much larger gains after reranking and generation.
- **Re-embedding cost:** When you upgrade embedding models, you must re-embed your entire corpus. For 100M chunks at $0.02/1M tokens, that's a significant cost. Design your pipeline so the vector DB stores the raw text alongside the embedding — you'll need it.

### 3.3 Dense vs. Sparse Embeddings

**Dense embeddings** (the ones above): every dimension is a non-zero float. Captures semantic similarity. "car" and "automobile" are close even with zero word overlap.

**Sparse embeddings** (BM25, SPLADE): most dimensions are zero. Captures keyword/token-level matching. "cat" matches "cat" exactly.

| | Dense | Sparse |
|---|-------|--------|
| **Strength** | Semantic similarity, paraphrasing | Exact keyword matching, rare terms |
| **Weakness** | Misses exact codes (`ERR_TIMEOUT_429`), product SKUs | Misses "automobile" when searching "car" |
| **Storage** | 768-4096 floats per vector | Sparse vector (few non-zero entries) |
| **Best for** | Natural language questions | Error codes, IDs, legal citations |

**The insight: You need both.** A user searching "how to fix ERR_BATTERY_DRAIN_005" needs the exact error code. A user searching "phone dies too fast" needs semantic matching for the same document.

---

## 4. Retrieval: Finding the Right Needles

### 4.1 Vector Search Basics

The vector database stores embeddings and finds the k-nearest neighbors (k-NN) to a query embedding using a distance metric:

- **Cosine similarity:** measures angle between vectors. Most common for text embeddings.
- **Euclidean distance:** measures straight-line distance. Sensitive to vector magnitude.
- **Dot product:** measures projection. Equivalent to cosine when vectors are normalized.

### 4.2 ANN Indexes: Speed at Scale

Exact k-NN is O(N × D) — too slow for millions of vectors. Approximate Nearest Neighbor (ANN) indexes trade a small accuracy loss for massive speed gains:

**HNSW (Hierarchical Navigable Small World) — most common:**
```
Layer 2:  ●────●        ← Long-range jumps (few nodes)
          │    │
Layer 1:  ●─●──●─●      ← Medium-range
          │╲ │ ╱│ ╲│
Layer 0:  ●●●●●●●●●●    ← All nodes, local connections
```

- Search starts at the top layer, greedily moves to nearest neighbor
- Each layer down increases granularity
- O(log N) search time
- **Trade-off:** Higher `M` (connections per node) = better recall but more memory and slower build time

**IVF (Inverted File Index):**
- Cluster vectors into N centroids (like k-means)
- At query time, search only the nearest centroid(s)
- Pro: fast index build; Con: lower recall if query falls between clusters

### 4.3 Hybrid Search: Dense + Sparse

Combine dense (semantic) and sparse (keyword) retrieval for best results:

```
Score(chunk, query) = α × dense_score + (1-α) × sparse_score
```

Two implementation approaches:

**A. Reciprocal Rank Fusion (RRF):** Rank chunks separately by dense and sparse scores, then merge:
```
RRF_score(chunk) = 1/(k + rank_dense) + 1/(k + rank_sparse)
```
`k` (typically 60) controls the penalty for rank differences. RRF doesn't require normalized scores — it only cares about ranking position. This is the simpler approach and works surprisingly well.

**B. Linear Combination:** Normalize both scores to [0,1] and take weighted average. Requires score calibration — some models output scores in [0.7, 1.0] while others span [0.01, 0.99]. Without calibration, the wider-ranging model dominates.

**Hybrid Search Architecture:**
```
       ┌──────────┐       ┌──────────┐
       │  Dense   │       │  Sparse  │
       │ Embedding │       │  (BM25)  │
       └────┬─────┘       └────┬─────┘
            │                  │
    ┌───────▼───────┐  ┌──────▼──────┐
    │  Vector DB    │  │  Inverted   │
    │  (Qdrant/     │  │  Index      │
    │   Pinecone/   │  │  (Lucene/   │
    │   Weaviate)   │  │  Elastic)   │
    └───────┬───────┘  └──────┬──────┘
            │                  │
            └────┬─────────────┘
                 │
         ┌───────▼───────┐
         │  Fusion       │
         │  (RRF or      │
         │   Linear)     │
         └───────┬───────┘
                 │
         ┌───────▼───────┐
         │  Top-K merged │
         │  candidates   │
         └───────────────┘
```

### 4.4 Multi-Stage Retrieval

The most performant systems use a funnel approach:

```
Query → [Fast, High-Recall Retrieval] → [Slower, High-Precision Reranking] → LLM
              (k=100 candidates)              (k=5-10 final chunks)
```

- **Stage 1:** Cheap retrieval (BM25 or coarse ANN) gets broad coverage → 50-200 candidates
- **Stage 2:** Reranker (cross-encoder) scores each (query, chunk) pair → select top 5-10
- **Stage 3 (optional):** LLM-based compression or selection

**Why multi-stage?** Vector search optimizes for recall at scale. Reranking optimizes for precision with expensive pairwise computation. You can't afford to run a cross-encoder on 1M chunks per query — but you can afford it on 100.

### 4.5 Query Transformations

The user's raw query is often suboptimal for retrieval. Transform it:

| Technique | What It Does | When to Use |
|-----------|-------------|-------------|
| **Query Rewriting** | LLM rephrases query for better retrieval: "how do I fix the thing" → "troubleshooting steps for device error" | User queries are conversational |
| **HyDE** (Hypothetical Document Embeddings) | LLM generates a hypothetical answer, embed THAT instead of the query | Query and documents are in different domains/registers |
| **Multi-Query** | Generate 3-5 variations of the query, retrieve for all, union results | Ambiguous queries; improves recall |
| **Step-Back Prompting** | "What is the broader concept?" → retrieve general info first, then specific | Complex, multi-hop questions |
| **Query Decomposition** | "Compare X and Y on metric Z" → retrieve for X, retrieve for Y, compare | Multi-entity comparisons |

**The staff-engineer litmus test:** If you're using the user's raw query as the embedding input without any transformation, you're leaving 10-30% recall on the table.

---

## 5. Reranking: Precision on Top of Recall

### 5.1 Why Reranking Is Necessary

Vector similarity is a weak proxy for relevance. A chunk embedding might be close to the query embedding but not actually contain the answer. Reranking replaces the embedding-based similarity score with a **cross-encoder** that processes (query, chunk) pairs directly.

**Bi-encoder (embedding model):**
```
score = cosine(embed(query), embed(chunk))
```
- Query and chunk are encoded independently
- Fast: embed chunk once, store; embed query once, compare
- Shallow: "closeness in vector space" ≠ "answers the question"

**Cross-encoder (reranker):**
```
score = model(query, chunk)  # Processes the pair jointly
```
- Query and chunk are processed TOGETHER through full attention
- Slow: O(N) forward passes for N candidates
- Deep: full cross-attention captures whether chunk actually answers the query

### 5.2 Reranker Models

| Model | Notes |
|-------|-------|
| **Cohere Rerank v3** | API-based; strong general-purpose; supports multilingual |
| **BGE-Reranker-v2** | Open-source; cross-encoder; good for technical domains |
| **Jina Reranker v2** | Open-source; multilingual; supports long context (8K tokens) |
| **MixedBread Reranker** | Lightweight; good for low-latency requirements |
| **MS Marco Cross-Encoders** | Classic; fine-tuned on Bing search data |

### 5.3 Reranking Strategies

**A. Basic: Re-rank top-K from vector search**
```
candidates = vector_search(query, k=100)   # or 200
reranked = cross_encoder.rerank(query, candidates)[:10]  # top 10
```

**B. Diversity-Aware Reranking (MMR)**
Problem: top-10 vector search results might all be from the same document section, giving the LLM redundant context. MMR (Maximal Marginal Relevance) penalizes chunks similar to already-selected ones:

```
MMR(chunk) = λ × relevance(chunk, query) - (1-λ) × max_sim(chunk, already_selected)
```

This ensures the final set covers diverse aspects of the query.

**C. Recursive Reranking**
For very large candidate sets, chunk the candidates into batches, rerank within each batch, then rerank the winners:
```
Batch 1 (top-100): rerank → top 20
Batch 2 (101-200): rerank → top 20
Final: rerank(40 winners) → top 10
```

### 5.4 The Reranker-Hallucination Paradox

Here's a counterintuitive failure mode: **A highly precise reranker can increase hallucination.**

Scenario: Your chunking strategy creates chunks that don't preserve context boundaries. A product spec has:

```
Chunk A (Specs): "The Widget Pro has a 5000mAh battery."
Chunk B (Warning): "...do not expose to temperatures above 60°C. The Widget Lite has..."
```

User asks: "What's the battery capacity of Widget Pro?"

If the reranker scores Chunk A very high and Chunk B very low, the LLM only sees Chunk A and generates the correct answer. Good.

But if the user asks: "Is Widget Pro waterproof?" and NO chunk explicitly says "waterproof" but Chunk C says "IP68 rated," the reranker might suppress Chunk C because "IP68" ≠ "waterproof" in cross-attention. The LLM sees no relevant chunk and hallucinates: "The Widget Pro is not waterproof."

**The fix:** Reranking precision is only as good as chunking recall. If your chunks don't preserve the relationship between "IP68" and "waterproof," no reranker can recover. Design chunking and retrieval as a joint system, not independent stages.

---

## 6. Metrics That Actually Matter

### 6.1 Retrieval Metrics

| Metric | What It Measures | Formula | When to Use |
|--------|-----------------|---------|-------------|
| **Recall@K** | Are relevant docs in the top K? | |{relevant} ∩ {retrieved@K}| / |{relevant}| | Optimizing retrieval breadth |
| **Precision@K** | Are the top K results relevant? | |{relevant} ∩ {retrieved@K}| / K | User-facing: first page quality |
| **MRR** (Mean Reciprocal Rank) | Where is the first relevant result? | 1/rank_of_first_relevant | Single-answer questions |
| **NDCG** (Normalized Discounted Cumulative Gain) | Are relevant results ranked high (with graded relevance)? | Weighted by position | Multi-relevance grading (highly/partially/not relevant) |

### 6.2 Generation Metrics

| Metric | What It Measures | Limitation |
|--------|-----------------|------------|
| **Faithfulness** | Is the answer supported by retrieved chunks? | Requires LLM-as-judge or human eval |
| **Answer Relevance** | Does the answer address the question? | Doesn't catch off-topic but factual answers |
| **Context Relevancy** | How much of the retrieved context was actually used? | Wasted context = wasted LLM tokens, worse answers |

### 6.3 The Ground Truth Problem

**The hardest problem in RAG evaluation:** You typically don't have labeled (query, relevant_chunks) pairs for your proprietary corpus. Solutions:

1. **Synthetic data generation:** LLM generates (question, answer) pairs from your documents. Use the source document chunks as "ground truth" relevant chunks. Imperfect but scalable.
2. **User feedback signals:** clicks, copy-paste, thumbs up/down, dwell time. Noisy but real.
3. **LLM-as-judge:** GPT-4 evaluates whether the answer is supported by the retrieved chunks. Expensive, but the best scalable option.
4. **Golden set:** Hand-label 200-500 queries. Not scalable but essential as a North Star.

**Staff-Engineer Rule:** Never deploy a RAG pipeline without a fixed evaluation set. If you can't measure whether a change improved or degraded quality, you're flying blind. The eval set pays for itself the first time it catches a regression.

---

## 7. Production Architecture Patterns

### 7.1 The Ingestion Pipeline

```
┌─────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ Sources │ →  │  Parse   │ →  │  Chunk   │ →  │  Embed   │ →  │  Index   │
│ (S3,    │    │ (PDF,    │    │ (strategy│    │ (model)  │    │ (vector  │
│  GCS,   │    │  HTML,   │    │  engine) │    │          │    │  DB)     │
│  DB,    │    │  MD, txt)│    │          │    │          │    │          │
│  API)   │    └──────────┘    └──────────┘    └──────────┘    └──────────┘
└─────────┘                                                          │
     ▲                                                               │
     │                                                     ┌─────────▼─────────┐
     │                                                     │  Metadata Store   │
     └─────────────────────────────────────────────────────┤  (doc_id, version,│
           Change Detection (webhooks, polling, CDC)       │   timestamp,      │
                                                           │   chunk_map)      │
                                                           └───────────────────┘
```

**Key design decisions:**

- **Incremental updates:** When Document X changes, do you re-embed all chunks or only the changed ones? If your chunking is fixed-size, insertion of one sentence shifts ALL subsequent chunk boundaries — you re-embed everything. Document-aware chunking localizes changes.
- **Staleness detection:** Store document hash/timestamp with chunks. At query time, check if source doc has been updated. If yes, either (a) flag the answer as potentially stale, or (b) trigger re-ingestion synchronously (slow but correct).
- **Metadata filtering:** Store metadata (document_id, date, author, category, language) alongside vectors. Many queries need filtering before vector search: "search only documents from 2024," "only English docs." Hybrid filtering (pre-filter + vector search) avoids scanning irrelevant vectors.

### 7.2 The Query Pipeline

```
User Query
    │
    ▼
┌───────────────┐
│  Guardrails    │ ← Detect: PII in query? Harmful content? Out-of-domain?
└───────┬───────┘
        │
        ▼
┌───────────────┐
│  Query         │ ← Rewrite, HyDE, multi-query decomposition
│  Transformation│
└───────┬───────┘
        │
        ▼
┌───────────────┐
│  Retrieval     │ ← Hybrid search (dense + sparse), metadata filters
│  (Recall)      │    Retrieve 50-200 candidates
└───────┬───────┘
        │
        ▼
┌───────────────┐
│  Reranking     │ ← Cross-encoder scores (query, chunk) pairs
│  (Precision)   │    Select top 5-10
└───────┬───────┘
        │
        ▼
┌───────────────┐
│  Context       │ ← Assemble prompt: system message + chunks + query
│  Assembly      │    Apply "Lost in the Middle" ordering
└───────┬───────┘
        │
        ▼
┌───────────────┐
│  LLM           │ ← Generate answer with citations
│  Generation    │    Structured output: answer + [source_ids]
└───────┬───────┘
        │
        ▼
┌───────────────┐
│  Post-Process  │ ← Verify citations? Check faithfulness? Filter?
└───────┬───────┘
        │
        ▼
    Response
```

### 7.3 Caching Strategy

RAG queries can be expensive: embedding + vector search + reranking + LLM generation. Caching at multiple levels:

| Level | What to Cache | Key | TTL |
|-------|--------------|-----|-----|
| **Query → Answer** | Full response | Normalized query | Short (documents change) |
| **Query → Chunks** | Retrieved + reranked chunks | Normalized query | Short |
| **Embedding** | Query embedding | Normalized query | Medium (embedding model is stable) |
| **Chunk → Embedding** | Document chunk embedding | chunk_hash | Long (until document changes) |

**Cache invalidation:** When a document is updated, invalidate all cache entries for queries that retrieved chunks from that document. This requires tracking which documents contributed to each cached query's results — a non-trivial metadata problem.

---

## 8. Failure Modes and Diagnosis

### 8.1 When Retrieval Returns Wrong Chunks

**Symptoms:** Answers are plausible but factually wrong. Citations point to irrelevant documents.

**Diagnosis:**
1. Log (query, retrieved_chunks, final_answer) tuples
2. Check: Are the top-K chunks actually relevant? If not → retrieval failure
3. If chunks are relevant but answers wrong → generation failure

**Root causes:**
| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| No relevant chunks in top-20 | Embedding model doesn't capture domain semantics | Fine-tune embeddings or add sparse/hybrid retrieval |
| Relevant chunk at rank 35 | Vector search recall issue | Increase k for retrieval, add query transformation |
| Irrelevant chunks scored high | Outdated chunks with high keyword overlap | Add metadata freshness filtering |
| Right document, wrong chunk | Chunking splits answer across boundaries | Increase chunk size or add context windows |

### 8.2 When the LLM Ignores Retrieved Context

**Symptoms:** Answers are generic, don't reference retrieved chunks, fabricate details.

**Causes:**
- **Context is too long:** LLM loses track of middle chunks. Fix: reduce chunks to 3-5, place best last.
- **Contradictory chunks:** Two retrieved chunks disagree. LLM picks one or fabricates a compromise. Fix: detect conflicts, ask clarifying question, or present both views.
- **Prompt engineering failure:** The LLM isn't instructed strongly enough to ONLY use provided context. Fix: "If the answer cannot be found in the provided context, say 'I don't have enough information.' Do not use outside knowledge."

### 8.3 When Reranking Amplifies Errors

**Scenario:** Chunking produces poor-quality chunks (split mid-thought, missing context). Vector search returns mediocre candidates. Reranker scores them — and confidently ranks the "least bad" one highest. The LLM generates from a flawed chunk.

**The fix:** Measure chunk quality independently (completeness, coherence, standalone readability) and use it as a reranking feature, not just relevance. A perfectly relevant but incomplete chunk is worse than a slightly less relevant but self-contained chunk.

---

## 9. Scaling the Pipeline

### 9.1 Ingestion Scale

| Scale | Challenge | Solution |
|-------|-----------|----------|
| **1M docs** | Embedding throughput | Batch embedding with rate limits; async workers |
| **10M docs** | Vector DB storage | Quantization (PQ, SQ), dimension reduction (Matryoshka) |
| **100M docs** | Index build time | Distributed index build (IVF partitions across shards) |
| **1B docs** | Cost | Sparse-first retrieval → only embed top sparse results |

### 9.2 Query Scale

| Scale | Challenge | Solution |
|-------|-----------|----------|
| **10 QPS** | Single instance fine | Standard setup |
| **100 QPS** | Embedding API rate limits | Pooled embedding cache; local embedding model for common queries |
| **1000 QPS** | Vector DB throughput | Read replicas; approximate search with lower precision for non-critical queries |
| **10K QPS** | Cost of reranker × 10K queries | Cached retrieval results; skip reranker for cached/simple queries |

### 9.3 Cost Breakdown

For a typical enterprise RAG pipeline at 100 QPS:

| Component | Cost Driver | ~% of Total |
|-----------|------------|-------------|
| **LLM Generation** | Output tokens | 50-60% |
| **Embedding (ingestion)** | Initial corpus size | 15-20% (amortized) |
| **Embedding (query)** | Per-query embedding | 5-10% |
| **Reranking** | Per-query cross-encoder | 10-15% |
| **Vector DB** | Storage + compute | 10-15% |

**Staff-Engineer Insight:** The LLM generation dominates cost, but the retrieval/reranking pipeline determines whether those expensive tokens produce correct or incorrect answers. Penny-pinching on retrieval quality to save 10% of pipeline cost can waste 50% of your LLM budget on hallucinated responses. Optimize the full system, not individual components.

---

## 10. Interview Question + Model Answer

> **Question:** "Design a RAG pipeline for a legal research platform with 2 million case law documents. Lawyers need to find relevant precedents and get cited summaries. The documents are long (50-100 pages each), highly domain-specific, and answers MUST be verifiable. Walk me through your architecture and highlight the three riskiest design decisions."

### Model Answer

**Architecture Overview:**

1. **Ingestion:** Document-aware chunking by section headers (Facts, Issue, Holding, Reasoning, Dissent). Each section becomes one chunk — this preserves legal argument structure. Store both chunks and parent document metadata (court, date, jurisdiction, citations).

2. **Embedding:** Fine-tune a legal-domain embedding model (fine-tune BGE-base on case law query-passage pairs). Use task-specific prefixes. Generate both dense and sparse (SPLADE) embeddings for hybrid retrieval.

3. **Storage:** Qdrant with metadata filtering by jurisdiction, date range, and court level. Hybrid search with RRF fusion.

4. **Query Pipeline:** Query decomposition — "Has California adopted the 'reasonable expectation of privacy' test for digital devices in the workplace?" → decompose into sub-questions, retrieve for each, merge. Cross-encoder reranker with legal-domain fine-tuning. 5 chunks max to avoid overwhelming context.

5. **Generation:** Structured output with mandatory citations. Post-generation verification: LLM checks each claim against the cited chunk. If mismatch, flag for human review.

**The Three Riskiest Decisions:**

1. **Chunking by section headers.** Risk: Some judicial opinions have non-standard formatting or merge Reasoning and Holding into one narrative section. If the parser misses boundaries, a chunk might contain mixed content from different cases. Mitigation: Fallback to recursive character splitting for documents where section parsing confidence is low. Log all fallbacks and manually review a sample weekly.

2. **Fine-tuning the embedding model.** Risk: If the fine-tuning data has bias (over-represents certain courts or time periods), retrieval will be biased. A query about "digital privacy" might only return recent cases even if landmark older cases are more relevant. Mitigation: Stratified evaluation set covering all courts, decades, and legal domains. Monitor recall by jurisdiction monthly.

3. **Limiting to 5 chunks.** Risk: Complex legal questions genuinely require synthesizing 10+ precedents. With only 5 chunks, the LLM may miss a critical precedent. Mitigation: For queries flagged as complex (by a classifier), increase to 10 chunks. Also implement a "show more" follow-up that retrieves additional chunks on demand. Track the rate at which users request expansions — rising rates signal the limit is too aggressive.

### ❗ Common Pitfall

**"We'll just use cosine similarity on the user's query — it works fine out of the box."**

This is the #1 mistake in RAG systems. Raw cosine similarity on off-the-shelf embeddings produces superficially plausible results that fail under scrutiny. For a legal platform:

- "assault" and "battery" are legally distinct but semantically similar → dense embeddings conflate them
- Case citation "347 U.S. 483" has zero semantic overlap with "Brown v. Board of Education" → dense embeddings miss this
- A query about "attractive nuisance doctrine" might retrieve general negligence cases → no keyword overlap signal

Without hybrid search (dense + sparse) and domain-specific tuning, retrieval precision for legal text drops below 60%. Given the cost of a wrong legal citation (malpractice), you cannot deploy without these safeguards.

---

## 11. Key Takeaways

1. **RAG quality flows upstream.** The best LLM prompt in the world can't compensate for bad chunking. If your chunks don't preserve semantic completeness, every downstream stage inherits the degradation.

2. **Chunking is a design problem, not a constant.** Fixed-size 512-token chunks with 50-token overlap is the "hello world" of RAG. Production systems need document-aware chunking that respects the document's intrinsic structure. A legal document and a product manual need different chunking strategies.

3. **Hybrid search is table stakes.** Dense embeddings for semantic similarity + sparse (BM25/SPLADE) for exact matching. Either alone is insufficient. The fusion mechanism (RRF is simplest and works) is a detail — the decision to combine both signals is the architecture.

4. **Reranking is a precision multiplier, not a recall fix.** A reranker can only select among the candidates retrieval provides. If retrieval misses the right chunk entirely (recall failure), reranking is powerless. Measure recall@K BEFORE measuring reranker precision.

5. **Query transformation is free recall.** Rewriting the user's conversational query into a retrieval-optimized form, generating HyDE embeddings, or decomposing multi-hop questions can recover 10-30% of missed documents with no pipeline changes. This is the highest-ROI optimization in most RAG systems.

6. **Evaluation is the hardest part.** You don't have ground truth for your proprietary corpus. Build a synthetic eval set with LLM-generated questions, maintain a golden set of 200-500 hand-labeled queries, and NEVER deploy a change without running both. If your eval set doesn't catch a regression, improve the eval set — it's your only safety net.

7. **The chunking-reranker coupling is a silent killer.** A high-precision reranker selecting the "best" chunk from a set of poorly-chunked candidates produces confident-looking but incomplete context. The LLM then hallucinates to fill gaps. The fix is NOT to lower reranker precision — it's to fix chunking so each chunk is self-contained enough to support an answer on its own.

8. **Staff-level reframe:** Don't ask "What's the best chunking strategy?" Ask: "**What does a 'correct answer' mean for this use case? What information does a chunk need to contain to fully support that answer? And how do we verify, at scale and over time, that our retrieval pipeline is returning those chunks?**" The chunking strategy, embedding model, and retrieval approach all follow from the answer to those questions.

---

## Related
- [[topic-queue]]
- [[Vector Database Internals (HNSW, IVF, Sharding)]]
- [[LLM Serving at Scale (vLLM, Quantization, Batching, KV cache)]]
- [[Fine-Tuning Infrastructure (LoRA, QLoRA, Distributed Training)]]
- [[Multi-Agent Orchestration (Planning, Tool Use, Memory, Routing)]]
- [[Search Engine (Elasticsearch)]]

---

## Interview Cheat Sheet

**Key Points to Remember:**
- RAG = retrieve relevant documents from a knowledge base, then feed them as context to an LLM to ground its response
- Pipeline stages: chunk documents → embed chunks → store in vector DB → retrieve top-k → (optional) rerank → generate with LLM
- Chunking strategy has outsized impact: too small = lost context, too large = diluted relevance. 256-512 tokens is a common range
- Hybrid search (keyword + vector) outperforms either alone — vector search captures semantics, keyword search catches exact matches
- Reranking with a cross-encoder improves precision but adds 50-100ms latency — use it as a second stage on top-k candidates

**Common Follow-Up Questions:**
- "How do you evaluate RAG quality?" — Use RAGAS or similar: measure faithfulness (answer grounded in retrieved docs), answer relevance, and context precision/recall.
- "What happens when documents change?" — Re-embed and re-index the changed documents. For real-time updates, use an incremental indexing pipeline. Detect staleness via document hash comparison.

**Gotcha:**
- Adding more retrieved documents does NOT always improve quality. Past 5-10 chunks, the LLM suffers from "lost in the middle" — it pays more attention to the beginning and end of the context window, ignoring documents in the middle. Fewer, more relevant chunks often outperform many chunks.
