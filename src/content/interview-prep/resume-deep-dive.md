---
title: "Resume Deep-Dive — Every Project Under the Microscope"
date: 2026-07-07
type: article
tags: [interview-prep, resume, system-design, deep-dive, hedgineer, applied-ai, walmart, podeum, rakuten]
related: [llm-research-tool-for-an-asset-manager, multi-tenant-llm-platform, market-data-etl, mock-interview-playbook]
difficulty: Staff
estimated_reading_time: 45
description: "A structured interview prep framework covering every project on the resume. For each project: what was the problem, what made it complex, how was it solved, why not a simpler solution, what would you do differently, and what numbers prove it mattered. Built from the Hedgineer rejected-candidate feedback — the exact questions that separated pass from fail."
---

# Resume Deep-Dive: Every Project Under the Microscope

This document exists because of one sentence in the rejected candidate's feedback:

> "He did not give a good reason on why alerts needed an LLM (these were deterministic queues)."

The interviewer doesn't want you to describe what you built. They want you to defend *why you built it that way* — against cheaper, simpler alternatives — and show that you understand what's happening under the hood.

For every project on your resume, be ready to answer the 7 questions below. The interviewer will only ask 2-3 of them per project, but you need to be ready for all 7 because you won't know which ones they'll pick.

## The 7 Questions

| # | Question | What the interviewer is testing |
|---|---|---|
| Q1 | **What was the problem, and why was it hard?** | Can you scope. Not "what did you do" — "why was this worth doing." |
| Q2 | **What made it complex?** | Can you identify the hard part. Complexity isn't volume — it's the tradeoff with no right answer. |
| Q3 | **How did you solve it? What was YOUR specific contribution?** | Ownership. Not the team's decision. YOUR call. |
| Q4 | **Deep technical detail — how did it actually work?** | Can you go one layer below the wrapper. Data model, protocol, serialization, failure mode. |
| Q5 | **Why not a simpler solution?** | Cost-consciousness. Can you name the cheaper alternative and defend why it wasn't enough. |
| Q6 | **What would you do differently now?** | Self-critique. Can you spot your own gaps before the interviewer does. |
| Q7 | **What numbers prove it mattered?** | Impact. Not "it was faster" — a concrete before/after number. |

---

# WALMART (May 2024 – Present) — Software Engineer 3

Your highest-signal projects for the Hedgineer role because 4 of 7 bullets are AI/agentic and one is performance at scale. This is where the interviewer will spend 70% of the deep-dive.

## Project 1: Performance Optimization — Start/Update Workflow APIs

> Resume bullet: *"Led performance optimization of core Start and Update Workflow APIs, reducing P95 latency from ~200ms to ~130ms and scaling the platform to ~1500 synchronous workflow executions per second through database query optimizations and infrastructure tuning."*

### Q1 — What was the problem?

A tenant onboarding onto our orchestration platform needed to handle very high throughput — 20 million transactions per day. Before optimization, the platform was capped at 500-600 TPS. To onboard this tenant, we needed to roughly triple the throughput capacity.

### Q2 — What made it complex?

The workflow engine was **embedded inside the application framework** — meaning the application code and the engine shared the same process, same resources, same pod. You couldn't optimize one without affecting the other. Worse, the engine code was **not touchable** (proprietary/third-party), so we couldn't just go in and fix inefficiencies. We had to reverse-engineer what was happening internally — observe behavior through metrics, logs, and query patterns — then make changes from the application side to work around the engine's limitations. This is harder than it sounds: you're optimizing a system where half the stack is a black box.

### Q3 — What was YOUR specific contribution? What decisions did YOU make?

I owned the entire optimization effort end-to-end. Four specific decisions:

1. **Index analysis on the engine's SQL database.** The engine used an internal SQL database for workflow state. I identified the hot queries by enabling query logging at the DB layer (since we couldn't touch engine code), analyzed the query plans, and added targeted indexes to the engine-managed tables. This was the single highest-impact change.

2. **Connection pool sizing per pod.** The engine opened DB connections internally, and the application opened its own. With both sharing the same pod, connection pool sizing wasn't formulaic — I had to empirically test different pool sizes per pod to find the sweet spot where neither the engine nor the application starved for connections, while avoiding over-subscription that would cause contention at the DB.

3. **Optimal database scaling.** Instead of throwing the highest CPU/memory tier at the problem (which can actually degrade performance due to lock contention and NUMA effects at high core counts), I benchmarked incrementally — starting from the current tier and scaling up one step at a time, measuring TPS at each level. Found the optimal cost/performance point rather than the maximum configuration.

4. **Instance count tuning.** With the engine embedded, horizontal scaling wasn't linear — each additional pod added engine overhead. I mapped the TPS vs. pod-count curve to find the optimal instance count for the target throughput.

### Q4 — Deep technical detail

**How we reverse-engineered the engine internals (engine was a black box):**
- Enabled SQL query logging AND engine-level logs to capture everything happening inside the engine — query patterns, internal state transitions, lock acquisition. This gave us visibility without touching engine code.
- **Two-pronged index strategy, not just "add indexes":**
  1. Added targeted indexes for the hot queries the platform was making — identified from query logs and EXPLAIN plans.
  2. **Reduced the number of queries the platform was making.** Analyzed what data was actually needed in code vs. what was being fetched "just in case" from the DB. Moved computed/derived data into application code where possible. This is often higher-impact than adding indexes — you eliminate the query entirely instead of making it faster.

**Connection pool sizing:**
- Database had 128 CPU cores. Started with 10 pods × 30 connections/pod = 300 total connections.
- Used a **custom test workflow** to benchmark throughput after every configuration change — empirical tuning, not formula-based.
- Final optimal: **12 pods × 27 connections/pod** = 324 total connections. More pods (reducing per-pod engine overhead) with slightly fewer connections each (reducing contention). Total throughput increased despite the connection count barely changing — proof that the bottleneck was per-pod engine overhead, not raw DB capacity.

**Database scaling strategy:**
- Started at 2 cores (capped at ~100 TPS)
- Scaled incrementally: tested at each tier with the custom test workflow
- Scaled all the way to 256 cores but hit diminishing returns — beyond a certain point, the engine's internal lock contention on workflow state tables meant more cores didn't translate to more throughput
- **Optimal sweet spot: 84 cores.** This was the point where cost/performance peaked. 256 cores gave marginal additional TPS at dramatically higher cost.

### Q5 — Why not simpler?

**Why not just throw bigger hardware at it?** We tried. Scaling the DB to the highest core/memory tier actually left performance on the table — beyond a certain point, the engine's internal architecture (shared locks on workflow state) meant more cores didn't translate to more throughput. We had to find the optimal tier, not the maximum tier.

**Why not just add more pods?** With the engine embedded, each new pod brought a full engine instance with its own overhead. The TPS curve wasn't linear — it flattened. We needed to find the sweet spot, not just scale horizontally indefinitely.

**Why not cache?** Workflow Start/Update APIs are mutating operations — you're creating new workflow instances or transitioning state. You can't cache a write. You have to optimize the write path.

### Q6 — What would you do differently now?

The biggest learning: **an embedded engine is a scaling ceiling.** No amount of query optimization or connection pool tuning can fully overcome the fundamental problem of co-locating the engine with the application. Every pod runs a copy of the engine consuming resources. Every optimization has to work around an untouchable black box. This realization directly led to exploring engines that could be hosted independently — which is why we eventually moved to Orkes (see Project 3), where the engine runs as a separate service and the application is a thin client. If I were starting over, I'd push for a separated engine architecture from day one for any high-throughput tenant.

### Q7 — Numbers

| Metric | Before | After |
|---|---|---|---|
| Throughput (TPS) | 500-600 | 1500 (~3x improvement) |
| P95 latency | ~200ms | ~130ms |
| DB cores | 2 | 84 (optimal sweet spot; tested up to 256 with diminishing returns) |
| Pod count | 10 | 12 |
| Connection pool per pod | 30 | 27 |
| Total DB connections | 300 | 324 |
| DB CPU cores | 128 (available) | 128 (unchanged; bottleneck was lock contention, not CPU) |

---

## Project 2: Multi-Tenant Onboarding Architecture

> Resume bullet: *"Designed and implemented a multi-tenant onboarding architecture supporting multiple teams and multiple workflow engines per tenant within a shared cluster, defining data models, relationships, and lifecycle management."*

This is a high-signal bullet for Hedgineer because the role is multi-tenant. Expect the interviewer to probe: how did you isolate tenants? Where does data live per tenant?

### Q1 — What was the problem?

[Your answer here]

### Q2 — What made it complex?

[Your answer here]

### Q3 — What was YOUR specific contribution?

[Your answer here]

### Q4 — Deep technical detail

Push here: what was the data model? How did you represent tenant + workflow engine relationships? What was the lifecycle — tenant create → engine bind → engine upgrade → tenant delete? How did you handle multiple engine versions per tenant? Was it DB-per-tenant, schema-per-tenant, or shared tables with a tenant_id column?

[Your answer here]

### Q5 — Why not simpler?

Could you have just given each tenant their own cluster? Shared-nothing is simpler to reason about. Why was multi-tenancy within a shared cluster the right call?

[Your answer here]

### Q6 — What would you do differently now?

[Your answer here]

### Q7 — Numbers

How many tenants? How many workflow engines per tenant? What was the onboarding time before/after? Did this reduce operational toil (quantify)?

[Your answer here]

---

## Project 3: Orkes Workflow Engine Integration

> Resume bullet: *"Owned the end-to-end integration of Orkes Workflow Engine, enabling workflow-driven orchestration across backend and AI-powered systems, including SDK integration, configuration management, and runtime interoperability."*

### Q1 — What was the problem?

[Your answer here]

### Q2 — What made it complex?

[Your answer here]

### Q3 — What was YOUR specific contribution? What decisions did YOU make?

[Your answer here]

### Q4 — Deep technical detail

Push here: what does Orkes give you that a simple state machine or a Kafka consumer group doesn't? What was the SDK integration — did you wrap it? What's the execution model — polling, push, long-polling? How do you handle workflow versioning when workflows change mid-flight?

[Your answer here]

### Q5 — Why not simpler?

Why Orkes and not Temporal? Not Camunda? Not a hand-rolled state machine in Postgres? Defend the choice.

[Your answer here]

### Q6 — What would you do differently now?

[Your answer here]

### Q7 — Numbers

How many workflows run through Orkes? What's the execution volume? Did it replace something else — if so, what improvement did it drive?

[Your answer here]

---

## Project 4: Production-Grade AI Platform (RAG + Milvus)

> Resume bullet: *"Built and owned a production-grade AI platform, including RAG pipelines (Docling, pdfplumber, Vision LLMs), hybrid retrieval using Milvus (semantic + BM25 with RRF and cross-encoder re-ranking), and LLM-based response generation with evaluation and observability pipelines."*

THIS IS THE FLAGSHIP. This is the project the interviewer will want to deep-dive for the Applied AI Engineer role. Every sub-component is a potential 10-minute tangent. Be ready for all of them.

### Q1 — What was the problem?

Walmart store associates needed quick, accurate answers to operational questions about products, processes, and policies. The information existed — but it was scattered across thousands of internal documents: product spec sheets, return policies, handling guidelines, compliance docs. An associate with a customer in front of them couldn't spend 15 minutes searching through PDFs. They needed a single conversational interface: ask a question in plain English, get an answer with citations to the source documents.

### Q2 — What made it complex?

The complexity was multi-layered and domain-specific — not just "we built RAG."

**Heterogeneous document corpus.** The source documents weren't clean markdown. They were PDFs with embedded tables (product specs, pricing grids), multi-column layouts (policy docs), and images containing critical information (safety labels, handling diagrams). A naive text extractor would jumble multi-column text into gibberish and completely miss information trapped in images.

**Dual retrieval requirement.** The system had to handle both semantic queries ("how do I handle a customer complaint about a defective item") AND exact-match queries (product codes, SKU numbers, error IDs). Pure vector search misses exact string matches — a SKU like "WMT-48291-BL" has no semantic meaning. Pure keyword search misses intent — "what do I do if the item is broken" and "damaged product procedure" mean the same thing but share zero keywords.

**Citations were non-negotiable.** A store associate making a wrong decision based on hallucinated information isn't a UX bug — it's a real business risk. Every answer had to link back to the exact source document and section. The LLM couldn't be the source of truth; the documents were.

**Built solo.** I was the only person designing and building this — ingestion pipeline, retrieval, generation, evaluation, and observability. No separate ML team, no prompt engineering team. Every architectural decision was mine.

### Q3 — What was YOUR specific contribution? What decisions did YOU make?

Every major architectural decision was mine. Here are the key ones, with the reasoning behind each:

**1. Multi-fallback document ingestion pipeline (Docling → pdfplumber → Vision LLM)**

This was the most nuanced decision. No single parser handled everything well. I designed a cascading fallback pipeline with quality gates at each stage:

- **Stage 1 — Docling:** Primary parser for structured PDFs. Handles standard layouts, headings, paragraphs. Fast and reliable for clean documents.
- **Stage 2 — pdfplumber (table fallback):** If Docling's extraction confidence score dropped below threshold — typically on table-heavy pages — the system fell back to pdfplumber, which has superior table extraction. pdfplumber preserves row/column structure that Docling would flatten.
- **Stage 3 — Vision LLM (final fallback):** If both Docling and pdfplumber produced low-confidence output (complex multi-column layouts, embedded images with text, scanned documents), the page was rendered as an image and sent to a Vision LLM for extraction. This was the most expensive path but guaranteed that no document was unreadable.

The key design decision: each stage had a **quality score threshold** that triggered the next fallback. This meant simple documents took the fast path (Stage 1 only), and only genuinely hard documents escalated to the expensive Vision LLM. Without this gating, you'd burn compute running every page through a Vision model.

**2. Model selection — LLM for generation**

Started with an open-source model but settled on **GPT-5.1 Mini/Nano**. The reasoning: by the time context reaches the LLM, all the heavy lifting is done — retrieval has found the right documents, the re-ranker has picked the most relevant chunks. The LLM's job is narrow: synthesize those chunks into a coherent answer and attach citations. A smaller, faster, cheaper model is the right tool for that job. Using a frontier model would have been overkill — you'd pay 5-10x more per query for marginal quality gain on a task that's closer to summarization than reasoning.

**3. Embedding model selection**

**sentence-transformers/all-MiniLM-L6-v2** (384 dimensions). Chose this because: (a) it's battle-tested on retrieval benchmarks, (b) 384 dimensions hits the sweet spot between embedding quality and index size — higher dimensions (768, 1024) give marginally better recall at significantly higher storage and latency cost, (c) it's small enough to run locally without GPU, which mattered for the ingestion pipeline. Evaluated against larger models (MPNet, E5) but the quality difference on Walmart's internal document corpus didn't justify the 2-4x dimension increase.

**4. Milvus as the vector database**

Evaluated Pinecone, Weaviate, pgvector, and Milvus. Chose Milvus for four reasons:

- **Self-hosted deployment.** Walmart internal documents cannot leave the network. Pinecone was SaaS-only, Weaviate had cloud-first pricing. Milvus is purpose-built for self-hosted production deployments with proper replication, failover, and retention policies.
- **Hybrid search is native.** Milvus 2.4+ supports BM25 + vector search in a single query — no need for a separate search engine (Elasticsearch) just for keyword retrieval. This simplified the architecture significantly.
- **Index flexibility.** HNSW for high-recall workloads, IVF_FLAT for memory-constrained deployments, DiskANN for very large collections. I could tune the index to the workload rather than being locked into one index type.
- **Production maturity at no per-query cost.** pgvector had the basics but lacked replication, failover, and retention at the time. Pinecone and Weaviate charged per-query. Milvus on our own infra meant the cost was flat infrastructure, not variable per-associate-query.

**5. Hybrid retrieval with RRF + cross-encoder re-ranking**

- **BM25:** Used **BM25Okapi** — the canonical BM25 variant with default parameters (k1=1.5, b=0.75). The implementation was the `rank_bm25` Python library.
- **Why hybrid:** Semantic search (embeddings) catches paraphrases and intent. BM25 catches exact string matches — product codes, SKU numbers, error IDs. Neither alone covers both. The rejected candidate learned this the hard way; I designed for it from the start.
- **RRF (Reciprocal Rank Fusion), k=60:** RRF merges the BM25 ranking and vector ranking into a single list. The formula: `score(d) = Σ 1/(k + rank_i(d))` where rank_i(d) is the document's position in ranking list i. k=60 is the canonical value from the original paper — it means rank position matters but isn't dominant. A lower k (e.g., k=1) means only the #1 spot in each list matters — too aggressive. A higher k (e.g., k=1000) means all positions are nearly equal — too flat. k=60 was empirically validated as the sweet spot.
- **Cross-encoder:** **ms-marco-MiniLM-L6-v2** — same model family as the embedding model (consistent architecture, simplifies dependency management). The pipeline: 20 candidates from RRF → cross-encoder re-ranks them → top 6 returned → **final top-3 passed to the LLM** with their source citations. This 20→6→3 funnel keeps the LLM context window focused on the most relevant chunks while maintaining a buffer (6) in case the top few have inconsistent information.

**6. Evaluation and observability**

Built the eval pipeline myself. Three metrics:

- **Recall@K:** Are we finding the right documents? Measures whether relevant docs appear in the top K retrieval results.
- **Precision@K:** Are the retrieved documents actually relevant? Measures signal-to-noise ratio in what we send to the LLM.
- **Faithfulness:** Does the LLM's answer stay grounded in the retrieved context, or does it hallucinate? Measured by comparing generated claims against source chunks.

The eval dataset was [To fill: hand-labeled queries? synthetic? how many?]. Observability pipeline captured: latency per stage (ingestion → retrieval → re-rank → generation), token count per query, and cost per query.

### Q4 — Deep technical detail

**Document ingestion — chunking strategy (adaptive by document type):**

The chunking strategy wasn't one-size-fits-all. Different document types needed different approaches, and the fallback pipeline naturally created three chunking paths:

| Parser | Chunking Strategy | Rationale |
|---|---|---|
| **Docling** (structured PDFs) | Semantic chunking, up to 1000 tokens per chunk | Prose documents (policies, guides) have natural boundaries — paragraphs, sections, headings. Semantic chunking respects these rather than splitting mid-paragraph. 1000 tokens is large enough to capture a complete thought but small enough to keep retrieval precise. |
| **pdfplumber** (table-heavy docs) | **Each table row is a chunk** | Tables don't have semantic boundaries — they have rows. Splitting a table mid-row would create unanswerable fragments. Row-level chunking means each chunk is a self-contained fact: "Product X, SKU Y, price Z, handling instruction W." |
| **Vision LLM** (complex layouts) | 800 tokens per chunk with **100 token overlap** | Vision-extracted text loses document structure (no headings, no paragraph markers). Overlapping chunks prevent context from being lost at chunk boundaries — the same sentence might appear at the end of chunk N and the start of chunk N+1, so retrieval doesn't miss it regardless of where the boundary falls. |

[To fill: what was the total number of chunks after ingestion? What was the average chunk count per document?]

**Vector DB — Milvus index configuration:**

[To fill: what index type — HNSW, IVF_FLAT, IVF_PQ? What parameters — M, efConstruction, efSearch? How many vectors total? What's the index size on disk? What's the retrieval p95 latency?]

**Response generation — prompt structure and citation handling:**

[To fill: what does the prompt look like? How do you inject the top-3 chunks? How does the LLM output citations — inline markers like [1], footnotes, or something else? How does the user see which document each claim came from?]

**Observability — what's captured per query:**

[To fill: latency broken down by stage? Token counts? Cost?]

### Q5 — Why not simpler?

**1. Why RAG instead of fine-tuning?**

Fine-tuning embeds knowledge in model weights. Every time a document changes — a policy update, a new product spec, a revised compliance doc — you'd need a new fine-tuning run. That's expensive in compute, slow to deploy, and risks catastrophic forgetting: the model gets confused about which version of the policy is current. Worse, fine-tuning makes auditing impossible — you can't trace an answer to a specific document version because the knowledge is baked into billions of weights. With RAG, the knowledge stays in the index. Update a document → re-index it → answers reflect the change immediately. The LLM is never the source of truth; the documents are. For a corpus that changes regularly and requires citations, RAG is the only defensible choice.

**2. Why hybrid retrieval instead of semantic-only?**

Embeddings capture meaning but miss exact string matches. A product name like "Samsung 65-inch QLED 4K TV" has near-zero semantic overlap with its SKU "SAM-QN65Q80C-2024" — an embedding model sees them as unrelated tokens. But BM25 catches the token overlap. Store associates search by product names, model numbers, error codes, SKUs. Pure semantic search would silently miss these. Pure keyword search would miss paraphrases ("busted screen" vs "display damage"). Hybrid covers both. The rejected candidate's system failed on deterministic alerts because they used an LLM where a rule would work. This is the inverse: BM25 is the deterministic safety net where embeddings alone would fail.

**3. Why cross-encoder re-ranking instead of passing RRF results straight to the LLM?**

Bi-encoders (like the embedding model) encode the question and each document independently, then compare via cosine similarity. They're fast but shallow — the question and document never "see" each other during encoding. A cross-encoder processes the question-document pair together through full cross-attention, so it understands: "is this document actually relevant TO this specific question?" The distinction matters. The RRF top-10 might include a document about TV return policies when the user asked about TV setup instructions — both are "about TVs" (high semantic similarity), but the cross-encoder catches that "return policy" is not "setup guide" for this specific query. Yes, it adds latency — but retrieval quality is the foundation. Sending irrelevant chunks to the LLM wastes tokens and produces wrong answers. The 20→6→3 funnel means only 3 chunks reach the LLM; getting those 3 right is worth the re-ranking cost.

**4. Why Milvus instead of pgvector?**

Four reasons, building on what was said above in Q3:

- **Independence.** The assistant needed its own infrastructure. Embedding the vector store in the operational Postgres instance would couple RAG query load to transactional system performance. A spike in associate queries shouldn't slow down order processing.
- **Extensibility.** A standalone vector DB can be scaled, tuned, and upgraded independently. If we later added more document types or higher-dimension embeddings, we'd resize Milvus without touching the operational DB.
- **Vector-native operations.** Milvus has index types (HNSW, IVF) purpose-built for ANN search at high dimensions. pgvector's ANN support was relatively new and less battle-tested at the time.
- **Postgres wasn't in the picture for this.** There was no existing Postgres instance to piggyback on. Adding pgvector would have meant standing up a new Postgres instance anyway — at which point a purpose-built vector DB is the simpler choice, not the more complex one.

**5. Why an LLM at all instead of keyword search + templates?**

Three reasons:

- **Scale of the corpus.** Thousands of documents across dozens of domains — products, policies, compliance, handling, safety. A template-based system would need a template for every combination, which doesn't scale.
- **Synthesis across documents.** A real associate query like "how do I handle a return for a defective Samsung TV purchased online" spans returns policy, defective-item policy, online-purchase policy, and the Samsung product spec. A keyword search returns fragments. An LLM synthesizes them into one answer.
- **Conversational disambiguation.** The LLM lets the user refine their query. "The screen is cracked" → "Was it cracked on arrival or after purchase?" → this changes which policy applies. A keyword search can't have a dialogue. The conversation IS the interface — not a nice-to-have, but the core UX.

That said, the LLM is the thinnest layer in the stack. It doesn't generate facts — it rearranges retrieved facts. It doesn't know product codes — it cites them from the retrieved chunks. Every claim it makes is tethered to a source document. The rejected candidate's mistake was using an LLM where deterministic logic would work. This system uses the LLM only where it's actually needed: synthesis and conversation. Everything upstream — retrieval, ranking, citation tracking — is deterministic.

### Q6 — What would you do differently now?

Three things:

**1. Build evaluation alongside the product, not after.**

I built the eval pipeline later in the project lifecycle. This was the single biggest mistake. Without eval from day one, I had no objective measure of whether a change improved or degraded the system. Every index parameter change, every chunking tweak, every prompt adjustment — I was relying on spot-checking and intuition. If I rebuilt it, the eval dataset and metrics pipeline would ship BEFORE the first user query. Every change would be measured. Every PR would show the delta in recall, precision, and faithfulness. This is the lesson: for any LLM-powered system, eval isn't a QA step — it's the foundation. You can't improve what you can't measure.

**2. Add HyDE and LLM-based query reframing for better retrieval.**

User queries are often short and underspecified ("how do I return a TV"). Document chunks are long and detailed. There's a representation gap. Two techniques I'd add:

- **HyDE (Hypothetical Document Embeddings):** Before retrieval, ask the LLM to generate a hypothetical ideal document that would answer the query. Embed THAT generated text instead of the raw query. The generated text looks more like a real document chunk, so it retrieves better matches.
- **Query reframing:** Ask the LLM to expand the user's query with relevant context — synonyms, related terms, clarifications. "How do I return a TV" becomes "What is the return policy for televisions, including conditions for opened boxes, restocking fees, and return window duration." The expanded query retrieves better because it has more tokens to match against.

Both add a small LLM call before retrieval, but the retrieval quality improvement is worth the latency — same principle as the cross-encoder re-ranker.

**3. Async ingestion from the start.**

The first version had synchronous ingestion — users uploaded documents and waited for processing to complete before they could query them. For large documents with Vision LLM fallbacks, this could take minutes. I later made ingestion async: upload → acknowledge immediately → process in background → notify when ready. This unblocked users and made the system feel faster. Should have been async from day one.

### Q7 — Numbers

| Metric | Value |
|---|---|
| Queries per day | ~1000 |
| End-to-end response time | 3-4 seconds (with citations) |
| Retrieval latency (p95) | [To fill] |
| Documents in corpus | [To fill] |
| Total chunks after ingestion | [To fill] |
| Token usage per query (avg) | [To fill] |
| Cost per query (avg) | [To fill] |
| Recall@K | 1.0 |
| Context Precision@K | 0.9 |
| Relevance | 0.8 |
| Faithfulness | 0.66 |

---

## Project 5: Multi-Agent Orchestration

> Resume bullet: *"Designed and implemented a stateful multi-agent orchestration system with task decomposition, parallel execution, dynamic model selection, and persisted workflow state for deterministic pause/resume, enabling human-in-the-loop code generation and review cycles."*

### Q1 — What was the problem?

Walmart teams needed to deliver features end-to-end faster, and LLMs were the obvious accelerator — but the naive approach of throwing every task at a frontier model was burning tokens at an unsustainable rate. The challenge: build a coding agent system that could take a feature from spec to production-ready code with tests and review, while keeping token costs under control by routing each sub-task to the right-sized model.

### Q2 — What made it complex?

Three layers of complexity, each compounding the next:

**Model routing isn't free.** You can save tokens by routing simple tasks to cheap models — but the routing decision ITSELF costs tokens. The orchestrator has to analyze the task, classify its complexity, and route it. If the routing call burns 500 tokens but saves 2000, it's worth it. If the classification is wrong and you route a complex task to a weak model, you get bad output AND you have to re-run it on a bigger model — burning tokens twice. Getting the routing right was the linchpin.

**Pipeline dependencies create a fragile chain.** Spec → task breakdown → code generation → tests → review. Each step's output is the next step's input. If code generation fails at task 7 of 12, and you restart from scratch, you've burned all the tokens from tasks 1-6 for nothing. At frontier model prices, that's real money. The system had to checkpoint state at every step so failures were cheap to recover from.

**Review is the quality gate, and quality gates can't be cheap.** The review agent has to compare generated code against the original spec, check test coverage, and flag issues. This is the hardest step in the pipeline — it requires understanding both the spec's intent AND the code's implementation. Routing this to a weak model would defeat the purpose. The review agent HAD to be a strong model, which means it's the most expensive call in the pipeline. The cost savings from routing earlier steps to cheap models had to pay for the expensive review step.

### Q3 — What was YOUR specific contribution? What decisions did YOU make?

I designed and built the entire system. Four key architectural decisions:

**1. Pipeline architecture — spec → tasks → code → tests → review**

The feature delivery pipeline had five stages:

```
Feature request → [Spec Agent] → Spec doc
Spec doc → [Orchestrator Agent] → Task breakdown + complexity classification
Tasks → [Code Agent] → Generated code (routed by task complexity)
Code → [Test Agent] → Test suite
Code + Tests + Spec → [Review Agent] → Review against spec
```

Each stage produces structured output that feeds the next stage. The orchestrator is the central decision point — it receives the spec, breaks it into tasks, classifies each task's complexity, and routes it.

**2. Three-tier model routing by task complexity**

I defined three complexity tiers with explicit routing rules:

| Tier | Task Type | Model |
|---|---|---|
| **Tier 1 — Lowest** | Boilerplate, config files, imports, package setup | Cheapest model |
| **Tier 2 — Medium** | Function implementations, business logic, data transformations | Mid-tier model |
| **Tier 3 — Highest (quality gate)** | Review against spec, correctness verification | Best/frontier model |

The orchestrator agent classifies each task into a tier based on the spec context. This isn't keyword-matching — the orchestrator reads the task description and decides: "is this a boilerplate task, a function implementation, or does it require reasoning?" The classification itself is an LLM call, but it's a small one — the token savings from routing Tier 1 tasks to cheap models more than pays for the classification cost.

**3. State persistence with file-based checkpointing for deterministic pause/resume**

The biggest cost risk was mid-pipeline failure. If a 12-task pipeline fails at task 7, and you restart from scratch, you've wasted tokens on tasks 1-6. I persisted workflow state to local files at every stage boundary — after spec generation, after task breakdown, after each code generation task, after tests. The state file contains the serialized output of every completed stage.

On resume, the system reads the state file, identifies the last completed stage, and picks up from the next uncompleted task. This means:
- A failure at task 7 costs you ONLY the tokens from task 7 (plus the restart overhead)
- A human reviewer who takes 4 hours to respond doesn't block other workflows — the state file sits on disk and resumes when the review comes in
- Multiple workflows can run concurrently — each gets its own state file

The tradeoff: file-based state means the system is single-machine, not distributed. For the scale we were operating at, this was the right call — adding a database for workflow state would have been over-engineering. The file IS the database.

**4. Review agent as the quality gate**

The review agent is the only stage that ALWAYS uses the frontier model. It receives: the original spec, the generated code, and the test results. It produces: a pass/fail decision with specific line references for any issues. If it fails, the workflow resumes from the failed code generation task — not from scratch. The review agent's quality determines the entire pipeline's output quality, so this is the one place where cost optimization is explicitly NOT the goal.

### Q4 — Deep technical detail

**Model routing — which models for which tier?**

Used Anthropic's model family, which has a natural complexity gradient:

| Tier | Model | Why |
|---|---|---|
| Tier 1 — Lowest | **Claude Haiku** | Fastest, cheapest. For boilerplate and config where correctness is trivial — the output is either right or obviously wrong. |
| Tier 2 — Medium | **Claude Sonnet** | Balanced cost/capability. For function implementations and business logic where correctness matters but the task is well-scoped. |
| Tier 3 — Quality gate | **Claude Opus** | Most capable. For review against spec — this is the one place where cost is NOT the priority. |

**Classification strategy — task description only, not full spec**

A critical design decision: the orchestrator classifies task complexity by reading only the **task description**, NOT the full spec. Why? Re-reading the full spec for every single task classification would burn tokens proportional to (spec size × number of tasks). For a 2000-token spec with 12 tasks, that's 24,000 tokens just on classification — more than the code generation itself for Tier 1 tasks.

The task description is written by the orchestrator during the breakdown phase. Since the orchestrator already read the full spec to create the tasks, the task descriptions are self-contained — they carry enough context for complexity classification without re-reading the spec.

**State file — JSON DAG with dependencies and parallel execution**

The state file is a JSON representation of the task DAG:

```
{
  "workflow_id": "feature-xyz-001",
  "status": "in_progress",
  "stages": {
    "spec": {"status": "completed", "output": "...", "model": "sonnet"},
    "task_breakdown": {"status": "completed", "tasks": [...]},
    "code_gen": {
      "task_1": {"status": "completed", "tier": 1, "model": "haiku", "output": "...", "dependencies": []},
      "task_2": {"status": "completed", "tier": 1, "model": "haiku", "output": "...", "dependencies": []},
      "task_3": {"status": "completed", "tier": 2, "model": "sonnet", "output": "...", "dependencies": ["task_1"]},
      "task_4": {"status": "failed", "tier": 2, "model": "sonnet", "output": null, "dependencies": ["task_2", "task_3"]},
      ...
    },
    "tests": {"status": "pending"},
    "review": {"status": "pending"}
  }
}
```

Key design properties:
- **Dependencies are explicit.** Each task lists which tasks must complete before it can start. Tasks with no dependencies (task_1, task_2 above) execute in parallel.
- **Model outputs are checkpointed.** Every completed task stores its model output in the state file. On resume, you don't re-run completed tasks — you read the output from the state file.
- **Resume from last failure.** The agent scans the DAG, finds all completed tasks (read from checkpoint), identifies the first uncompleted task with all dependencies satisfied, and resumes from there.

**Handling misrouted tasks — reviewer detects, orchestrator re-routes, code agent regenerates**

This was the most nuanced failure mode. Here's the flow:

1. Orchestrator classifies a task as Tier 1 (Haiku). The task actually requires Tier 2 reasoning, but the description looked simple.
2. Haiku generates code. It compiles but doesn't handle an edge case from the spec.
3. Review agent (Opus) compares code against spec, catches the gap, and outputs: `{"status": "fail", "task": "task_7", "reason": "Missing edge case: null handling for input parameter X. This task requires Tier 2.", "action": "reassign_to_tier_2"}`
4. Orchestrator receives the review verdict, re-classifies task_7 as Tier 2, and routes it to Sonnet.
5. Sonnet regenerates task_7 with full spec context.
6. Review agent re-evaluates.

**Why the reviewer doesn't fix the code directly:**

Having the review agent (Opus) write the fix is tempting — it's the most capable model. But it creates three problems:

- **Code style inconsistency.** The reviewer writes in its own style, which may differ from the code agent's output on all other tasks. The codebase becomes a patchwork.
- **No learning for the orchestrator.** If the reviewer fixes silently, the orchestrator never learns that it misrouted. The same misrouting will happen on the next workflow.
- **Audit trail breaks.** The code for task_7 was generated by the reviewer, not the code agent. If there's a bug later, you can't trace which agent wrote what.

The right pattern: **reviewer detects → orchestrator re-routes → code agent regenerates.** The reviewer is a quality gate, not a contributor. The code agent is always the source of generated code. This keeps the system's roles clean and the audit trail intact.

A refinement worth considering (not implemented, but noted for future): on the SECOND failure of the same task at Tier 2, auto-escalate to Tier 3. Don't loop indefinitely. Two failures at a tier means the task is harder than the orchestrator estimated — escalate rather than retry.

### Q5 — Why not simpler?

**1. Why multiple agents instead of one agent doing everything?**

When this system was built, the cost differential between model tiers was significant. Running every task — including boilerplate — through Opus would have been wasteful. The three-tier routing saved ~60% in token costs compared to a single-agent approach where Opus handled everything. The multi-agent architecture was a cost-optimization decision, not a complexity fetish.

That said, this answer has an expiration date. As models improved, we observed that a better model could complete the same task in fewer tokens — sometimes fewer total tokens than a weaker model struggling through the same problem. The cost equation flipped. We've since transitioned to a single coding agent with a configurable advisor tool, where the user sets guardrails and the agent executes end-to-end. Task/phases breakdown is still recommended — not for model routing, but because context windows are finite and quality degrades on large codebases. The multi-agent system was the right architecture for its moment; the single agent is the right architecture now.

**2. Why stateful (checkpointing) instead of stateless (re-run on failure)?**

A full pipeline run with 12 tasks across three model tiers wasn't cheap. If the pipeline failed at task 10 because of a flaky model output, re-running tasks 1-9 would burn tokens with zero new value — those tasks already produced correct, review-passed output. File-based checkpointing meant a failure cost you only the tokens from the failed task onward. The state file overhead was near-zero (a few KB of JSON on disk) and the savings were real.

**3. Why human-in-the-loop instead of fully autonomous merge?**

Four reasons, each stronger than "models make mistakes":

- **Code is liability, not just output.** Generated code goes to production. If it breaks at 3am, a human gets paged. The human who reviewed and approved the code is the human who understands it and can debug it. Without review, you have production code that no human has ever read — that's not automation, that's abandonment.

- **The review IS the knowledge transfer.** When an engineer reviews agent-generated code, they learn what was built, where it lives, and why decisions were made. Six months later, when a bug surfaces, there's a human who knows where to look. An auto-merged codebase is a codebase nobody understands.

- **Not all correctness is spec-verifiable.** The review agent checks "does this match the spec?" It doesn't know that the auth module is being refactored next sprint, or that the team convention is to use repository pattern for data access, or that Sarah already built a utility function that does half of this. Human reviewers catch context that isn't in any spec.

- **Accountability is a feature.** If the agent generates buggy code and auto-merges it, who owns the incident? The engineer who kicked off the workflow? The person who configured the agent? The agent itself? Human-in-the-loop means the approving engineer explicitly signs off — accountability is clear, and so is the audit trail. The guardrails catch deterministic errors; the human catches judgment errors.

### Q6 — What would you do differently now?

The biggest learning: **model quality changes architectural decisions.** The multi-agent system was built on the assumption that model tiers had a meaningful quality gap that justified routing complexity. As models improved, that gap narrowed — a single strong model could handle the entire pipeline end-to-end in fewer total tokens than the multi-agent system spent on orchestration + classification + generation + review. We validated this empirically and transitioned.

If I were building this today, I'd start with the single-agent approach: one coding agent with an advisor tool that the user configures with guardrails and conventions. Task breakdown into phases still matters — not for model routing, but because context windows are finite and you can't feed an entire codebase into one prompt. The architecture simplifies from "orchestrator + router + multiple specialized agents" to "one agent + structured phases + human review at the gate."

The principle: **let model capability do the heavy lifting, and keep your architecture as simple as the model allows.** The multi-agent system was necessary when models were weaker. Now that they're stronger, the simpler architecture wins. I'd rather explain to an interviewer why I simplified my own system than defend complexity I no longer believe in.

### Q7 — Numbers

- Concurrent workflows per day?
- Average agents per workflow?
- Pause/resume frequency?
- Human review acceptance rate?
- Time saved per workflow vs. manual process?
- Token cost per workflow?
- Failure/loop rate if measured?

[Your answer here]

---

## Project 6: AI-Powered Developer Tooling

> Resume bullet: *"Built internal AI-powered developer tooling and introduced spec-driven development workflows using LLMs, improving engineering velocity and consistency across feature development."*

### Q1 — What was the problem?

[Your answer here]

### Q2 — What made it complex?

[Your answer here]

### Q3 — What was YOUR specific contribution?

[Your answer here]

### Q4 — Deep technical detail

Push here: what tools specifically (you named Claude Code, Cursor, Windsurf in past discussions)? What does "spec-driven development" mean in practice — did you write a spec, feed it to the LLM, and get generated code? What was the workflow? What was the quality gate before merging LLM-generated code?

[Your answer here]

### Q5 — Why not simpler?

Why not just give everyone Copilot and call it done? What did your spec-driven workflow add that raw autocomplete doesn't?

[Your answer here]

### Q6 — What would you do differently now?

[Your answer here]

### Q7 — Numbers

How many engineers adopted? PR cycle time impact? Code review pass rate? Bug rate before/after?

[Your answer here]

---

# RAKUTEN (May 2023 – May 2024) — Software Engineer 2

## Project 7: Payment Batch Processing

> Resume bullet: *"Designed high-volume payment batch processing systems and APIs, enabling seamless third-party integrations across multiple Rakuten brands."*

### Q1 — What was the problem?

[Your answer here]

### Q2 — What made it complex?

[Your answer here]

### Q3 — What was YOUR specific contribution?

[Your answer here]

### Q4 — Deep technical detail

Push here: what made it "high-volume"? What was the batch processing pattern — chunked processing, parallel workers, idempotency keys? How did you handle partial failures in a batch? How did you handle reconciliation? What payment providers did you integrate?

[Your answer here]

### Q5 — Why not simpler?

Why batch processing instead of real-time per-transaction? Why not use an off-the-shelf payment orchestrator?

[Your answer here]

### Q6 — What would you do differently now?

[Your answer here]

### Q7 — Numbers

Throughput? Batch size? Failure rate? Reconciliation time before/after?

[Your answer here]

---

## Project 8: Mock Server Framework

> Resume bullet: *"Built a Java-based mock server framework to simulate external payment providers, improving integration test coverage and reliability."*

### Q1 — What was the problem?

[Your answer here]

### Q2 — What made it complex?

[Your answer here]

### Q3 — What was YOUR specific contribution?

[Your answer here]

### Q4 — Deep technical detail

Push here: what made this a framework vs. a script? How did you model payment provider behavior — state machines, recorded responses, programmatic? How did you handle edge cases (timeouts, partial responses, malformed payloads)? How did you keep mocks in sync with real provider APIs?

[Your answer here]

### Q5 — Why not simpler?

Why not use WireMock or a SaaS mock service? Why build your own framework?

[Your answer here]

### Q6 — What would you do differently now?

[Your answer here]

### Q7 — Numbers

Test coverage before/after? Number of providers mocked? Tests run per build?

[Your answer here]

---

# PODEUM (July 2022 – May 2023) — Founding Engineer

This is your highest-ownership project. You were one of two backend engineers building everything from scratch — every architectural decision was made by you or debated with one other person.

The codebase (Podeum/games, since open-sourced) reveals a multi-game sports gaming platform: Dropwizard + Guice + MongoDB, three Maven modules (runtime → api → database), custom adapter pattern, four game systems in one monolith. This wasn't a simple CRUD app — it was a real platform.

## Project 9: Built and Scaled Backend from Scratch

> Resume bullet: *"Built and scaled backend services from scratch using Java, supporting growth from 0 to ~10,000 daily active users."*

### Q1 — What was the problem?

Podeum was a sports fan engagement platform — live match tracking, fantasy leagues, quizzes. There was no backend. No API. No database. No deployment. I built it from scratch alongside one other backend engineer, while the frontend was being built in parallel in Flutter. The backend had to support four game systems — cricket match tracking with live events, fantasy league with role-based team selection, team/player management, and timed multiplayer quizzes — all sharing the same infrastructure and scaling to thousands of concurrent users during live matches.

### Q2 — What made it complex?

**Four game systems, one monolith, two engineers.** Each system had its own data model, its own business rules, its own failure modes:

- **Cricket Match Engine** — matches with toss decisions, innings tracking, win type/margin calculation, real-time MatchEvents keyed by playing team, and PlayerStats with a `fantasyScore` computation that fed directly into the fantasy system
- **Fantasy League** — per-community fantasy leagues with time-windowed FantasyMatches, user-created FantasyTeams with role-based player selection (captain/vice-captain multipliers), and scoring derived from real match statistics
- **Team & Player Management** — leagues containing teams, teams containing players with skills/roles/status, upsert-based sync patterns to handle frequent roster changes
- **Live Quiz** — pod-based quizzes with timed start, question pools, multiplayer participation tracking

These weren't independent microservices — they shared the same MongoDB instance, the same connection pool, the same deployment. A fantasy scoring query couldn't slow down live match event ingestion. A quiz with 1000 concurrent players couldn't starve the match API of connections.

**Minimal review surface.** With only one other backend engineer, there was no senior architect, no platform team, no dedicated DB admin. Every schema decision, every index choice, every API contract — we made it, we owned it, one of us got paged if it broke at 2am during an IPL match.

### Q3 — What was YOUR specific contribution? What decisions did YOU make?

Everything. But specifically:

**1. Chose Dropwizard over Spring Boot.** Spring Boot was the industry default, but Dropwizard was lighter, faster to bootstrap, and came with built-in metrics, health checks, and configuration management. For a two-person team that needed to move fast and operate the system with minimal overhead, Dropwizard's "batteries included but minimal" philosophy was the right call. The Guice integration (via Hubspot's dropwizard-guice) gave us DI without Spring's complexity.

**2. Designed a custom MongoDB adapter layer instead of using an ORM.** MongoDB doesn't have a standard Java ORM like Hibernate. I built an adapter pattern with:
- An `Adapter` interface defining every data operation (70+ methods across all entities)
- A `MongoDBAdapter` implementation with repository classes per collection
- A custom `@Collection` annotation to map Java entities to MongoDB collection names
- A `@Transactional` interceptor for atomic multi-document writes
- DTO/Entity separation with hand-written mapper classes

This was more work upfront than using a library like Morphia, but it meant we had full control over every query, every index, every write concern. No black-box ORM behavior — critical when you're one of two people who can debug production issues.

**3. Made the architecture decision to keep it a monolith.** Four game systems could have been four microservices. But with two engineers, four services means four deployments, four monitoring setups, four failure domains, and inter-service latency on every fantasy scoring lookup. A well-structured monolith (separate packages per domain, shared database module, clean adapter boundaries) gave us the isolation benefits without the operational overhead. The code was structured so it COULD be split later — the adapter interface was the seam.

**4. Built the fantasy scoring pipeline.** The `PlayerStat` entity has a `fantasyScore` field derived from match statistics. When a MatchEvent was ingested, the system updated the relevant PlayerStats, recalculated fantasy points based on the event type and the player's role, and propagated the score to all FantasyTeams that had selected that player — with captain/vice-captain multipliers applied. This was the most complex business logic in the system: real-time, multi-entity, write-heavy, and accuracy-critical (users tracked their fantasy scores live during matches).

### Q4 — Deep technical detail

Push here: what was the stack (Java + what framework)? What was the deployment model — VPS, cloud, something else? What was the DB schema at launch vs. at 10K DAU? What broke when you scaled? What was the hardest scaling bottleneck you hit and how did you fix it?

[Your answer here]

### Q5 — Why not simpler?

You were a founding engineer with no users yet. Why Java + a real framework instead of a quick Firebase backend or a Node.js prototype? Why invest in architecture when the app had 0 users?

[Your answer here]

### Q6 — What would you do differently now?

[Your answer here]

### Q7 — Numbers

From 0 to 10K DAU — over what timeframe? What was the growth curve? What was the infrastructure cost at 0 users vs. 10K? What was the availability target and did you hit it?

[Your answer here]

---

## Project 10: Core Platform Systems

> Resume bullet: *"Designed and implemented core platform systems including authentication, virtual economy, in-app purchases, and real-time live score feeds."*

### Q1 — What was the problem for EACH system?

Auth, economy, IAP, live scores — four separate problems. Be ready to talk about each.

[Your answer here]

### Q2 — What made it complex?

[Your answer here]

### Q3 — What was YOUR specific contribution?

[Your answer here]

### Q4 — Deep technical detail

**Authentication:** What auth scheme? JWT, session-based, OAuth? How did you handle token refresh? Did you roll your own or use a library?

**Virtual economy:** How did you model currency? Double-entry bookkeeping? What consistency guarantees? How did you prevent double-spend or negative balances?

**In-app purchases:** Which platform (App Store, Google Play)? How did you verify receipts server-side? How did you handle restore purchases? What happened when the verification endpoint was down?

**Real-time live score feeds:** What was the data source? How did you ingest it? Firestore? What was the latency from game event to user seeing the update? How did you handle thousands of concurrent viewers on a single match?

[Your answer here]

### Q5 — Why not simpler?

For each system — what was the simpler approach and why wasn't it enough?

[Your answer here]

### Q6 — What would you do differently now?

[Your answer here]

### Q7 — Numbers

DAU using each system? Transaction volume for IAP/economy? Concurrent viewers for live scores? Latency numbers?

[Your answer here]

---

# MORGAN STANLEY (Oct 2020 – Jun 2022) — Software Developer

## Project 11: Big Data + CI/CD

> Resume bullet: *"Developed and maintained Big Data applications and set up CI/CD pipelines with Jenkins and Sonar, improving code quality and deployment workflows."*

This is your earliest role. The interviewer is less likely to deep-dive here, but you should still have crisp answers. Especially for "what did YOU do vs. what was team process."

### Q1 — What was the problem?

[Your answer here]

### Q2 — What made it complex?

[Your answer here]

### Q3 — What was YOUR specific contribution?

[Your answer here]

### Q4 — Deep technical detail

What Big Data stack — Hadoop, Spark, something else? What was the data pipeline doing? What was the data volume? What did the CI/CD pipeline improve specifically — build time, deploy frequency, test coverage?

[Your answer here]

### Q5 — Why not simpler?

[Your answer here]

### Q6 — What would you do differently now?

[Your answer here]

### Q7 — Numbers

Data volume? Build time before/after? Deployment frequency before/after?

[Your answer here]

---

# ANSWER FRAMEWORKS

Below are suggested answer frameworks for each project. They are STARTING POINTS — not the final answer. Use them to jog your memory, then write your actual answers in the sections above. The interviewer will hear your voice, not mine.

## Walmart Project 1: Performance Optimization

**Q1 (Problem):** The Start and Update Workflow APIs were the critical path for every workflow execution in the platform. At P95 200ms, under peak load of 1500 RPS, the tail latency was causing timeouts and cascading failures in downstream services. The DB was the bottleneck — multiple N+1 queries per API call.

**Q2 (Complexity):** The queries were not trivially fixable — they spanned multiple joins across workflow definitions, execution state, and task history tables. Adding an index might speed up one query pattern but slow down writes. The platform was multi-tenant, so any schema change affected all tenants simultaneously.

**Q3 (Your contribution):** You owned the investigation end-to-end. You identified the slow queries via query plan analysis, proposed the index changes and query refactors, benchmarked the improvements in a staging environment with production-like data volumes, and rolled out the changes.

**Q4 (Detail to prep):** Know the schema. Know which queries were slow. Know what the EXPLAIN output looked like before and after. Know what indexes you added (composite? covering? partial?). Know if you introduced any caching layer.

**Q5 (Why not simpler):** Caching alone wouldn't work because the Start/Update APIs mutate state — you can't cache a write. Bigger instances would have been a temporary fix at 2-3x the cost without addressing the underlying query inefficiency. The query optimization was the right first step before scaling hardware.

**Q6 (What I'd change):** Possibly: "I'd add more aggressive connection pooling earlier" or "I'd instrument the query layer with finer-grained metrics so we'd catch the degradation sooner."

---

## Walmart Project 4: AI Platform (FLAGSHIP)

**Q1 (Problem):** Walmart had a large corpus of internal documentation, runbooks, and operational data across multiple teams. Engineers and support staff spent significant time searching across fragmented sources to answer operational questions. The goal was a single NL interface that could synthesize answers from all sources.

**Q2 (Complexity):** The document formats were heterogeneous (PDFs with tables, Word docs, Confluence pages, code repos). Simple keyword search couldn't handle multi-hop queries ("what's the escalation process for X, and who owns it?"). The corpus was being updated continuously, so the index needed to stay fresh. The answers needed citations — users had to verify where information came from.

**Q3 (Your contribution):** You designed the RAG pipeline architecture. You evaluated embedding models and chose the one that worked best on the internal document mix. You chose hybrid retrieval (semantic + BM25) after observing that pure semantic search missed exact keyword matches (like error codes, ticket IDs). You integrated the cross-encoder re-ranker to improve precision. You built the evaluation pipeline.

**Q4 (Detail to prep):**
- Embedding model: which one, what dimension, why
- Chunking: strategy, size, overlap
- Milvus index: type, parameters, vector count
- BM25: implementation, weighting formula
- RRF k value
- Cross-encoder model, re-rank count, latency impact
- LLM: model, prompt structure, context window management
- Evaluation: metrics, framework

**Q5 (Why not simpler — THE CRITICAL QUESTION):**

*"Why RAG instead of fine-tuning?"* → Fine-tuning would bake the knowledge into the model weights, making updates expensive (re-train on every doc change). RAG keeps knowledge external and updateable by re-indexing. For a frequently-changing corpus, RAG is the right pattern.

*"Why hybrid retrieval instead of semantic-only?"* → Semantic search misses exact matches. An error code like "ERR-5421" has no semantic meaning — it's a string. BM25 catches these. Conversely, BM25 misses paraphrases ("how to restart the service" vs. "service restart procedure"). Hybrid covers both.

*"Why Milvus instead of pgvector?"* → Milvus is purpose-built for vector search with better index types (HNSW, IVF), better recall at high dimensions, and better performance at scale. pgvector is fine for <1M vectors; beyond that, a dedicated vector DB is the right call.

*"Why an LLM at all instead of just returning search results?"* → The user doesn't want 10 document links. They want an answer synthesized from multiple sources with contradictions resolved. Search results are a starting point; an LLM turns them into an answer. BUT — acknowledge the tradeoff: the LLM can hallucinate. That's why you have citations, a critic agent / evaluation pipeline, and the principle: "the LLM is never the source of numerics."

**Q6 (What I'd change):** Possibly: "I'd add query classification upfront — a lightweight classifier to route simple lookup queries to a faster path and only invoke the full RAG pipeline for complex synthesis queries" or "I'd invest more in the evaluation dataset earlier — we built the pipeline before we had a good eval set, which made it hard to measure improvement."

---

## Walmart Project 5: Multi-Agent Orchestration

**Q1 (Problem):** Complex developer workflows (code generation, review, testing, deployment) required multiple steps with human approval gates. A single LLM call couldn't handle this — you needed task-specific agents (code generator, reviewer, tester), coordination between them, and the ability to pause for human input.

**Q2 (Complexity):** The orchestration had to be stateful (agents might wait hours for human review). Parallel execution had to be safe (two agents modifying the same code would conflict). The system had to be cost-aware (not burn tokens on loops). Model selection mattered — simple tasks could use a cheaper model, complex tasks needed a stronger one.

**Q3 (Your contribution):** You designed the orchestrator topology. You chose the state persistence strategy. You built the dynamic model router. You designed the human-in-the-loop interface. (Adjust based on what you actually did.)

**Q4 (Detail to prep):**
- Orchestrator: custom or LangGraph? Supervisor topology or something else?
- State schema: what fields are persisted?
- Pause/resume: how is state serialized/deserialized?
- Model routing: rules-based or learned? What models?
- Human-in-the-loop: where in the pipeline? What UI?
- Failure handling: timeout, retry, escalation

**Q5 (Why not simpler):**

*"Why multiple agents instead of one agent with tools?"* → A single agent with tools would work for simple chains (1→2→3). But when you have parallel independent tasks (code gen + test gen running simultaneously), and conditional branching (if review fails → regenerate), you need an orchestrator that can manage a DAG, not a linear chain.

*"Why stateful instead of stateless?"* → Stateless means re-running the entire workflow if something fails at step 7. With LLM costs and human review latency (hours), re-running is wasteful. Stateful checkpointing means you resume from the failure point.

*"Why dynamic model selection?"* → Running every task through GPT-4-class models would be 5-10x more expensive with marginal quality gain for simple tasks (formatting, linting, simple transformations). Routing simple tasks to cheaper models keeps cost under control.

**Q6 (What I'd change):** Possibly: "I'd add an eval harness specific to the orchestrator — right now we evaluate individual agent outputs but not the orchestration quality. I'd measure: did the orchestrator decompose correctly? Did it choose the right model? Did it parallelize when it could have?"

---

## Podeum Project 9-10: Backend from Scratch + Core Systems

**Q1 (Problem):** Podeum was a sports fan engagement app. It needed a backend that could handle real-time live score updates for thousands of concurrent users during matches, a virtual economy for in-app engagement, and authentication. There was no existing backend — everything had to be built from scratch by one person.

**Q2 (Complexity):** Real-time live scores are hard — you're ingesting from an external data provider, processing events, and pushing updates to thousands of connected clients with sub-second latency. The virtual economy required consistency guarantees (no double-spend, no negative balances) — effectively a ledger. You were the only backend engineer, so there was no one to review your designs or catch your mistakes.

**Q3 (Your contribution):** Everything. You chose the tech stack, designed the data model, built the APIs, handled deployment, monitored production. Every architectural decision was yours.

**Q4 (Detail to prep):**
- Stack: Java + what framework? Spring Boot? What DB?
- Live scores: data source → ingestion → processing → push to clients. What made it real-time? Firebase? WebSockets? SSE?
- Virtual economy: how did you model currency? What consistency guarantees? How did you handle concurrent transactions?
- IAP: receipt verification flow. What happened when Apple/Google verification was down?
- Auth: scheme, token management, security

**Q5 (Why not simpler):** You chose a real backend stack (Java + framework + DB) instead of Firebase/BaaS. Why? Defend this — it's a strong signal. Firebase would have been faster to prototype, but it wouldn't have given you the control needed for the virtual economy (complex transactions, consistency) or the live score feed (custom processing logic). You traded speed-to-prototype for long-term architectural control.

**Q6 (What I'd change):** Possibly: "I'd start with a simpler deployment model — I over-invested in infra before we had users. At 0 DAU, a single VPS would have been fine. I'd also add more monitoring earlier — we caught scaling issues through user reports, not dashboards."

---

# INTERVIEW-DAY CHECKLIST

Morning of the round, spend 20 minutes on this document. Read:

1. **The 7 questions framework** (2 min) — the interviewer will ask some flavor of these
2. **Your Walmart AI Platform answers** (10 min) — this is the flagship, re-read your Q4, Q5, Q6 answers
3. **Your Podeum answers** (5 min) — your highest-ownership story, re-read Q3 and Q5
4. **The three things that killed the last candidate** (3 min):
   - Couldn't defend "why LLM" → your Q5 answers save you
   - Didn't understand internals → your Q4 answers save you
   - Could only talk about one project → you have 11 projects prepared

---

*This document is a living artifact. After every mock interview or real round, update the answers that felt weak. The answers you write today are not the answers you'll give in 3 months — tighten them as your understanding deepens.*
