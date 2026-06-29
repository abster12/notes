---
title: "Multi-Agent Orchestration (Planning, Tool Use, Memory, Routing)"
type: system-design
category: AI/ML
date: 2026-06-24
tags: [system-design, interview, ai-ml, multi-agent, orchestration, planning, tool-use, memory, routing, llm-agents, staff-engineering]
aliases: ["Multi-Agent Orchestration", "Agent Orchestration", "Agentic Systems", "Multi-Agent Systems"]
---

# Multi-Agent Orchestration (Planning, Tool Use, Memory, Routing)

> **Staff-Engineer Focus:** "We use LangChain to chain a few LLM calls" is the junior answer. "We have an orchestrator agent that delegates to specialist agents" is the mid-level answer. **The staff engineer doesn't ask whether to use agents. They ask: "We're running a fleet of 200 agents across 12 workflows — customer support triage spawns 3 sub-agents per ticket, each making 8-15 tool calls. At 5,000 concurrent tickets, that's 150,000 agent invocations and 1.2 million tool calls in flight. The orchestrator's LLM context window is consuming 50K tokens per planning cycle because it's reasoning about all agent states — at scale, the planner IS the bottleneck. Walk me through: (a) how you'd design a two-tier orchestration architecture where a 'macro-planner' produces a high-level DAG once and 'micro-executors' handle per-step adaptation without re-invoking the planner, (b) the exact failure mode when Agent-7's tool call to the payment API hangs at 29 seconds with a 30-second timeout — does the orchestrator wait, retry, or fail-fast, and what happens to the 14 other agents that are waiting on Agent-7's output as their input, (c) the memory architecture: if each agent accumulates conversation history, tool outputs, and intermediate reasoning (say 8K tokens per agent per task), at 5,000 concurrent tasks with 200,000 completed tasks per day, you're generating 1.6 billion tokens of context per day — what stays in the vector DB, what goes into the relational DB, what gets summarized, and what do you throw away? And when a customer asks 'what did the agent do about my refund yesterday?' 36 hours later, how do you reconstruct the full agent trace including the tool call that failed silently on retry 3?"** The interview question isn't "Explain how agents work." It's: "Design a multi-agent customer support system for a bank handling 100,000 queries/day. Agents can access 40 internal APIs (account balance, transaction history, dispute filing, fraud flagging). The compliance team requires full audit trails. P99 latency for simple queries must be under 2 seconds, and no single agent failure may cascade. Sketch the architecture. What breaks first at 10× load?"**

---

## Summary & Interview Framing

A system that decomposes complex tasks across multiple AI agents, each with specialized roles, tools, and memory, coordinated by a planner.

**How it's asked:** "Design a multi-agent customer support system for a bank handling 100K queries/day with 40 internal APIs, full audit trails, and P99 <2s for simple queries."

---

## 1. The Multi-Agent Landscape

### 1.1 Why Multiple Agents?

A single LLM with tool access can handle many tasks, but real-world enterprise workflows demand decomposition for three reasons:

**Context window limits.** A banking dispute resolution requires: customer profile (2K tokens), last 90 days of transactions (15K tokens), merchant details (1K tokens), bank policy doc (8K tokens), and conversation history (3K tokens). That's 29K tokens before any reasoning. Split across specialist agents — one for customer context, one for transaction analysis, one for policy — each stays within a manageable window and can reason deeply about its domain.

**Specialization beats generalization.** An agent fine-tuned on transaction fraud patterns will catch edge cases a generalist misses. Specialist agents can have different system prompts, different tool sets, and even different base models — a Claude agent for nuanced policy interpretation alongside a GPT agent for structured data extraction.

**Fault isolation.** If a single monolithic agent hallucinates a refund amount, the entire workflow produces wrong output. In a multi-agent system, the verification agent catches the hallucination before the customer sees it. Agent failures are contained.

```
┌──────────────────────────────────────────────────────────────────┐
│                    MULTI-AGENT ARCHITECTURE                       │
│                                                                   │
│  ┌─────────┐     ┌──────────────┐     ┌───────────────────────┐  │
│  │  User   │────▶│ Orchestrator │────▶│   Specialist Agents   │  │
│  │ Request │     │   (Planner)  │     │                       │  │
│  └─────────┘     └──────┬───────┘     │  ┌─────────────────┐  │  │
│                         │             │  │ Context Agent   │  │  │
│                   Plans & assigns     │  │ (customer data) │  │  │
│                         │             │  └────────┬────────┘  │  │
│                    ┌────┼────┐        │           │           │  │
│                    │    │    │        │  ┌────────▼────────┐  │  │
│                    ▼    ▼    ▼        │  │ Transaction     │  │  │
│                 ┌───┐┌───┐┌───┐      │  │ Agent (fraud)   │  │  │
│                 │ A ││ B ││ C │      │  └────────┬────────┘  │  │
│                 └───┘└───┘└───┘      │           │           │  │
│                   Specialist Agents   │  ┌────────▼────────┐  │  │
│                         │             │  │ Policy Agent    │  │  │
│                    ┌────┼────┐        │  │ (compliance)    │  │  │
│                    │    │    │        │  └────────┬────────┘  │  │
│                    ▼    ▼    ▼        │           │           │  │
│                 ┌─────────────────┐   │  ┌────────▼────────┐  │  │
│                 │  Synthesizer    │   │  │ Verification    │  │  │
│                 │  (aggregator)   │   │  │ Agent (safety)  │  │  │
│                 └────────┬────────┘   │  └─────────────────┘  │  │
│                          │            └───────────────────────┘  │
│                          ▼                                       │
│                    ┌──────────┐                                  │
│                    │ Response │                                  │
│                    └──────────┘                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 1.2 Agent Taxonomy

Not all agent architectures are created equal. Understanding the taxonomy is essential for system design:

| Architecture | Description | Latency | Reliability | Use Case |
|-------------|-------------|---------|-------------|----------|
| **Single Agent + Tools** | One LLM with function calling | Lowest | Single point of failure | Simple Q&A, data lookup |
| **Chain/Sequence** | Agents execute in fixed order | Low | Blocked by any failure | Document processing pipeline |
| **Router** | One agent classifies, routes to specialist | Low-Medium | Router SPOF, specialists independent | Customer support triage |
| **Orchestrator-Worker** | Central planner assigns to workers | Medium | Orchestrator SPOF | Complex multi-step workflows |
| **Peer-to-Peer / Swarm** | Agents communicate directly, no central control | High | No SPOF, hard to debug | Research, creative tasks |
| **Hierarchical** | Multi-level orchestration tree | Medium-High | Partial failure tolerance | Enterprise workflows at scale |

### 1.3 The Orchestration Spectrum

The fundamental architectural choice: **how much does the orchestrator know?**

```
CENTRALIZED ◄────────────────────────────────────────────► DECENTRALIZED

  Orchestrator               Orchestrator                 No Orchestrator
  controls everything        sets goal + reviews           agents self-organize
  ████████████████           ████████░░░░░░░░             ░░░░░░░░░░░░░░░░
  LangChain LCEL             LangGraph / CrewAI            AutoGen / Swarm
  Predefined DAGs            Dynamic DAG + adaptation      Emergent behavior
```

**Centralized (LangChain, LCEL):** The orchestrator defines a static graph of operations before execution begins. Every edge, every conditional branch, every tool is known at graph-construction time. This is fast and predictable — the DAG can be optimized, cached, and validated. But it cannot adapt to unexpected intermediate results. If the transaction agent discovers a fraud pattern that requires an additional investigation step, a static DAG has no edge for it.

**Semi-centralized (LangGraph, CrewAI):** The orchestrator produces an initial plan as a DAG, but agents can dynamically modify the graph during execution. LangGraph's `Command` primitive lets an agent update state and redirect execution to a different node. This is the sweet spot for most production systems — enough structure to be predictable, enough flexibility to handle surprises.

**Decentralized (AutoGen, Swarm):** Agents communicate peer-to-peer with no central planner. They negotiate tasks, share results, and collectively decide when work is complete. This is powerful for creative and research tasks where the solution path is genuinely unknown, but it's unpredictable — the same input can produce wildly different execution traces, which is a nightmare for compliance and auditing.

---

## 2. Planning: The Orchestrator's Core Function

### 2.1 The Planning Problem

The orchestrator receives a user request and must produce a plan: a directed acyclic graph (DAG) of agent invocations with dependencies. This is fundamentally a **reasoning → decomposition → assignment** problem.

```
User: "I was charged twice for my subscription, and I want a refund."
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR (Planner)                     │
│                                                               │
│  Step 1: DECOMPOSE the request                                │
│    - Sub-task A: Verify customer identity and account         │
│    - Sub-task B: Find duplicate charge in transaction history │
│    - Sub-task C: Check refund policy and eligibility          │
│    - Sub-task D: Process refund if eligible                   │
│    - Sub-task E: Compose customer-facing response             │
│                                                               │
│  Step 2: DETECT DEPENDENCIES                                  │
│    A ──┬──▶ B (need customer_id to query transactions)       │
│        └──▶ C (need account_tier to check policy)             │
│    B ──▶ D (need transaction_id to process refund)            │
│    C ──▶ D (need policy_result to gate refund)                │
│    D ──▶ E (need refund_id for response)                     │
│                                                               │
│  Step 3: PARALLELIZE                                          │
│    Level 0: [A]                     (1 agent)                 │
│    Level 1: [B, C]                  (2 agents, parallel)      │
│    Level 2: [D]                     (1 agent, waits for B,C)  │
│    Level 3: [E]                     (1 agent)                 │
│                                                               │
│  Step 4: ASSIGN to specialist agents                          │
│    A → AuthAgent    B → TransactionAgent                      │
│    C → PolicyAgent  D → RefundAgent    E → ResponseAgent      │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 Planning Strategies

**ReAct (Reasoning + Acting):** The most common pattern. The agent alternates between thinking (what should I do next?) and acting (calling a tool). For multi-agent systems, ReAct is typically used at the orchestrator level — the planner thinks, assigns, observes results, then thinks again.

```
ReAct loop in orchestrator:
  Thought: "I need the customer's ID first."
  Action:  invoke(AuthAgent, {query: "verify identity"})
  Observation: {customer_id: "C789", tier: "premium", authenticated: true}
  Thought: "Customer verified. Now I can parallelize transaction
            lookup and policy check."
  Action:  parallel_invoke([
             {agent: TransactionAgent, input: {customer_id: "C789"}},
             {agent: PolicyAgent, input: {customer_id: "C789", tier: "premium"}}
           ])
  Observation: [{duplicate_txn: "T456", amount: 29.99},
                {refund_eligible: true, max_refund: 30.00}]
  Thought: "Duplicate found and refund is eligible. Proceed."
  ...
```

**Plan-and-Execute:** The orchestrator generates the entire plan upfront (as a DAG), then dispatches all independent agents in parallel. No re-planning unless an agent fails. This is much faster than ReAct for well-understood workflows because it eliminates the sequential think-act loop at the orchestrator level.

**Plan-and-Adapt:** The orchestrator generates an initial DAG but agents can signal that the plan needs modification. For example, the TransactionAgent might discover that the duplicate charge was actually a legitimate renewal and signal a plan revision. This is the most robust approach but requires careful state management.

### 2.3 The Planning Bottleneck

At scale, the orchestrator's LLM call IS the bottleneck. Consider:

```
100K queries/day → ~1.16 queries/second average
But traffic is bursty: 500 queries/second at peak

Orchestrator planning latency: 1-3 seconds per query (LLM inference)
  → Cannot handle 500 qps with a single orchestrator

Solutions:
  1. Plan caching: hash (intent, customer_segment) → cached plan DAG
     - 80% of queries fall into ~20 templates
     - Cache hit: 5ms vs. 2s for LLM planning
  
  2. Tiered orchestration:
     - Tier-1: lightweight classifier (fast model, 50ms)
       routes to template-based plans for common intents
     - Tier-2: full orchestrator (slow LLM, 2s)
       handles novel or complex intents
  
  3. Macro-planner + micro-executor:
     - Macro-planner produces a high-level DAG once
     - Micro-executors handle per-step adaptation without re-invoking planner
     - Reduces orchestrator LLM calls from N per step to 1 per workflow
```

---

## 3. Tool Use: The Agent's Interface to the World

### 3.1 The Tool Integration Stack

Tools are the mechanism by which agents affect the real world. A well-designed tool integration layer is the difference between a demo and a production system.

```
┌──────────────────────────────────────────────────────────────┐
│                     TOOL INTEGRATION STACK                     │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Agent Layer: function_call / tool_use in system prompt  │ │
│  │  "You have access to: get_balance, list_transactions..." │ │
│  └────────────────────────┬────────────────────────────────┘ │
│                           │                                   │
│  ┌────────────────────────▼────────────────────────────────┐ │
│  │  Tool Registry: service discovery + schema validation    │ │
│  │  get_balance → POST /api/v2/accounts/{id}/balance        │ │
│  │  Schema: {customer_id: string} → {balance: float, ...}   │ │
│  └────────────────────────┬────────────────────────────────┘ │
│                           │                                   │
│  ┌────────────────────────▼────────────────────────────────┐ │
│  │  Execution Layer: auth, rate limiting, retry, timeout    │ │
│  │  - Inject auth headers from agent context                │ │
│  │  - Per-tool rate limit: 100 req/s for get_balance        │ │
│  │  - Retry: 3× with exponential backoff (1s, 2s, 4s)      │ │
│  │  - Timeout: 30s default, configurable per tool           │ │
│  └────────────────────────┬────────────────────────────────┘ │
│                           │                                   │
│  ┌────────────────────────▼────────────────────────────────┐ │
│  │  Audit Layer: log every tool call (input, output, time)  │ │
│  │  - Who (agent_id, workflow_id)                           │ │
│  │  - What (tool_name, parameters, result)                  │ │
│  │  - When (start_time, end_time, latency)                  │ │
│  │  - Result (success, error_code, retry_count)             │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Tool Design Principles

**Idempotency is non-negotiable.** Every tool that mutates state MUST be idempotent or the system cannot safely retry. A `process_refund(transaction_id, amount)` call that succeeds but times out on the network will be retried — if it's not idempotent, the customer gets double-refunded.

**Schema is contract.** Tool schemas (JSON Schema, OpenAPI) serve as the interface contract between the LLM and the execution layer. The LLM generates parameters; the execution layer validates before calling the real API. Never let raw LLM output hit a production API without validation.

**Side-effect awareness.** Tools should declare their side-effect profile: `read_only`, `idempotent_write`, `non_idempotent_write`. The orchestrator can use this to make smarter retry decisions — read_only tools can be retried aggressively, non_idempotent_write tools need human-in-the-loop confirmation before retry.

| Side-Effect Profile | Retry Strategy | Example |
|--------------------|----------------|---------|
| **read_only** | Aggressive retry (5×, 100ms backoff) | get_balance, search_transactions |
| **idempotent_write** | Safe retry (3×, 1s backoff) | set_flag, upsert_record |
| **non_idempotent_write** | No auto-retry without idempotency key | process_refund, send_email |
| **destructive** | Human approval required | close_account, delete_data |

### 3.3 Tool Execution Models

**Sequential tool calling.** The agent calls one tool, waits for the result, then decides the next action. This is the simplest model but adds latency — each tool call is a round trip. A 5-tool workflow incurs 5 sequential LLM + API latencies.

**Parallel tool calling.** Modern LLMs (GPT-4, Claude 3.5+) support emitting multiple tool calls in a single response. The agent identifies independent tool calls and dispatches them simultaneously. This cuts latency from O(N) to O(max_latency).

```
Sequential:                      Parallel:
  call A (200ms)                   call A ─┐
  call B (150ms)                   call B ─┼─ 200ms (max of A,B,C)
  call C (180ms)                   call C ─┘
  call D (100ms)                   call D ─┐
  call E (50ms)                    call E ─┼─ 100ms (max of D,E)
  Total: 680ms                     Total: 300ms (2 LLM rounds + max latency)
```

**Speculative tool calling.** For latency-critical paths, pre-compute likely tool calls and dispatch them before the agent decides. If the agent's decision matches the speculation, the result is already available. If not, discard and execute the correct call. This is analogous to branch prediction in CPUs.

---

## 4. Memory Architecture: What Stays, What Goes

### 4.1 The Memory Hierarchy

Agent memory is not one thing — it's a hierarchy with different storage backends, retention policies, and access patterns.

```
┌────────────────────────────────────────────────────────────────┐
│                      MEMORY HIERARCHY                           │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ WORKING MEMORY (in-context, ephemeral)                     │ │
│  │ - Current task state, intermediate results                 │ │
│  │ - Lifetime: single task execution                          │ │
│  │ - Storage: orchestrator's context window                   │ │
│  │ - Size: 2K-50K tokens per task                             │ │
│  │ - Problem: context window is expensive (O(n²) attention)   │ │
│  └───────────────────────────┬───────────────────────────────┘ │
│                              │                                  │
│  ┌───────────────────────────▼───────────────────────────────┐ │
│  │ SHORT-TERM MEMORY (session-level)                          │ │
│  │ - Multi-turn conversation within a session                 │ │
│  │ - Lifetime: user session (minutes to hours)                │ │
│  │ - Storage: Redis/in-memory, keyed by session_id            │ │
│  │ - Size: 10K-100K tokens per session                        │ │
│  │ - Eviction: TTL (configurable), LRU when memory pressure   │ │
│  └───────────────────────────┬───────────────────────────────┘ │
│                              │                                  │
│  ┌───────────────────────────▼───────────────────────────────┐ │
│  │ LONG-TERM MEMORY (cross-session)                           │ │
│  │ - User preferences, past interactions, learned facts       │ │
│  │ - Lifetime: permanent (until explicit deletion)            │ │
│  │ - Storage: Vector DB (semantic) + Relational DB (exact)    │ │
│  │ - Retrieval: hybrid (dense embeddings + keyword/BM25)      │ │
│  │ - Size: billions of tokens across all users                │ │
│  │ - Challenge: what to remember vs. what to forget           │ │
│  └───────────────────────────┬───────────────────────────────┘ │
│                              │                                  │
│  ┌───────────────────────────▼───────────────────────────────┐ │
│  │ PROCEDURAL MEMORY (skills, workflows)                      │ │
│  │ - How to do things: SOPs, tool usage patterns, rules       │ │
│  │ - Lifetime: permanent, versioned                           │ │
│  │ - Storage: Document store + Vector DB                      │ │
│  │ - "When customer says 'fraud', always escalate to Tier-2"  │ │
│  └───────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

### 4.2 The Retention Problem

At 5,000 concurrent tasks per day, each generating 8K tokens of agent trace data:

```
Daily trace volume: 5,000 tasks × 8K tokens × 4 bytes/token (avg)
                  = 160 MB/day of raw trace data

Annual trace volume: 160 MB × 365 = 58.4 GB/year

But that's just structured traces. Add:
  - Conversation logs: 3× trace volume (verbatim LLM I/O)
  - Tool outputs: 5× trace volume (API responses are verbose)
  - Vector embeddings: 2× trace volume (768-dim embeddings)
  - Audit indexes: 1× trace volume (compliance metadata)

Total: ~700 GB/year for 5,000 tasks/day. At 100K/day, that's 14 TB/year.
```

**The tiered retention strategy** is what separates a working system from an unsupportable one:

| Tier | What | Retention | Storage | Retrieval Latency |
|------|------|-----------|---------|-------------------|
| **Hot** | Current session context | Duration of session | GPU/CPU memory | <1ms |
| **Warm** | Recent traces (30 days) | 30 days | PostgreSQL + pgvector | <100ms |
| **Cold** | Aggregated summaries + embeddings | 1 year | Vector DB + S3 | <1s |
| **Frozen** | Raw logs (compliance) | 7 years | S3 Glacier | Minutes to hours |
| **Discard** | Intermediate reasoning steps | Never stored | N/A | N/A |

**What to discard:** Intermediate ReAct loop steps that didn't lead to the final answer, tool call retries that succeeded on later attempts, planning iterations that were superseded. Keep the final plan DAG, the tool calls that contributed to the result, and the final response. Discard the rest.

### 4.3 Vector DB vs. Relational DB

Both are necessary, for different query patterns:

```
QUERY: "What did the agent do about my refund yesterday?"
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│  STEP 1: Relational DB (exact lookup)                         │
│  SELECT * FROM agent_traces                                   │
│  WHERE customer_id = 'C789'                                   │
│    AND workflow_type = 'refund'                               │
│    AND created_at > NOW() - INTERVAL '48 hours'               │
│  → Returns: structured trace with tool_call_ids               │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│  STEP 2: Relational DB (join tool outputs)                    │
│  SELECT tool_name, input_params, output, status, retry_count   │
│  FROM tool_executions                                         │
│  WHERE trace_id = 'T-12345'                                   │
│  ORDER BY sequence_num                                        │
│  → Returns: ordered list of every tool call in the trace      │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│  STEP 3: Vector DB (semantic search — only if needed)         │
│  query_embedding = embed("customer complaint about duplicate  │
│                           charge resolution process")         │
│  results = vector_db.search(query_embedding, top_k=5)         │
│  → Returns: semantically similar past traces for pattern      │
│             matching (fraud patterns, resolution patterns)    │
└──────────────────────────────────────────────────────────────┘
```

**Relational DB** is the system of record for exact retrieval: "show me everything agent X did at timestamp Y for customer Z." **Vector DB** is for fuzzy retrieval: "find past cases similar to this one" or "what's the standard resolution for this type of dispute."

---

## 5. Routing: Getting Work to the Right Agent

### 5.1 The Routing Problem

Given a user request and a pool of specialist agents, which agent(s) should handle it? This is a classification problem with real consequences — route to the wrong agent and the user gets a bad answer, or worse, a security violation (routing a transaction query to an agent that also has refund permissions).

```
                     ┌─────────────────────┐
                     │    User Request      │
                     └──────────┬──────────┘
                                │
                     ┌──────────▼──────────┐
                     │  Intent Classifier   │
                     │  (fast model, 50ms)  │
                     └──────────┬──────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                     │
    ┌─────▼─────┐         ┌─────▼─────┐         ┌─────▼─────┐
    │  Intent:  │         │  Intent:  │         │  Intent:  │
    │  balance  │         │  dispute  │         │  fraud    │
    │  inquiry  │         │           │         │  report   │
    └─────┬─────┘         └─────┬─────┘         └─────┬─────┘
          │                     │                     │
    ┌─────▼─────┐         ┌─────▼─────┐         ┌─────▼─────┐
    │  Balance   │         │  Dispute  │         │  Fraud    │
    │  Agent     │         │  Agent    │         │  Agent    │
    │  Pool      │         │  Pool      │         │  Pool     │
    └───────────┘         └───────────┘         └───────────┘
```

### 5.2 Routing Strategies

**LLM-based classification.** The simplest approach: ask an LLM to classify the intent and route accordingly. Pro: flexible, handles novel intents. Con: 200-500ms latency, variable quality. Good for low-volume or high-variance routing.

**Embedding-based semantic routing.** Pre-compute embeddings of canonical intents, then find the nearest neighbor for each incoming request. Pro: fast (<10ms), deterministic. Con: can't handle genuinely novel requests, cold-start for new intents.

**Keyword + regex triage.** For high-throughput systems, a fast pre-filter using keyword matching and regex patterns catches 60-80% of straightforward cases before hitting the LLM router. The LLM only sees the ambiguous tail.

| Strategy | Latency | Accuracy | Handles Novelty | Cost |
|----------|---------|----------|-----------------|------|
| **LLM classification** | 200-500ms | 95-98% | Yes | $0.001/query |
| **Embedding similarity** | 5-10ms | 90-95% | No | $0.0001/query |
| **Keyword + regex** | <1ms | 80-90% | No | Free |
| **Hybrid (keyword → embedding → LLM)** | 1-500ms | 98%+ | Yes | ~$0.0003/query (avg) |

### 5.3 Agent Pooling and Load Balancing

Specialist agents are not stateless — they carry context, tool credentials, and rate-limit state. Load balancing across a pool of identical agents requires careful design:

```
┌──────────────────────────────────────────────────────────────┐
│                    AGENT POOL MANAGER                         │
│                                                               │
│  Agent Pool: DisputeAgent × 10 instances                      │
│                                                               │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐       ┌─────────┐     │
│  │Agent D1 │ │Agent D2 │ │Agent D3 │  ...  │Agent D10│     │
│  │ idle    │ │ busy    │ │ idle    │       │ warming │     │
│  └─────────┘ └─────────┘ └─────────┘       └─────────┘     │
│                                                               │
│  Routing policy: Least Connection (not Round Robin!)          │
│  - Round Robin ignores per-agent latency variance             │
│  - Least Connection routes to the agent with fewest active    │
│    tasks, naturally handling slow agents                      │
│                                                               │
│  Sticky sessions: Optional. If an agent accumulates context   │
│  about a user, route subsequent queries for that user to the  │
│  same agent instance. But this creates hotspots and reduces   │
│  fault tolerance — if the sticky agent goes down, context     │
│  must be reconstructed from cold storage.                     │
│                                                               │
│  Health checking: Each agent instance heartbeats with:        │
│  {agent_id, status, active_tasks, avg_latency_ms,             │
│   error_rate_last_5min, memory_usage_pct}                     │
│  Agents with error_rate > 5% are drained and restarted.       │
└──────────────────────────────────────────────────────────────┘
```

---

## 6. The Orchestrator as a State Machine

### 6.1 Workflow State Management

Every multi-agent workflow is a state machine. The orchestrator's job is to manage transitions between states correctly, even when agents fail or time out.

```
                    ┌──────────┐
                    │  IDLE    │
                    └────┬─────┘
                         │ request received
                    ┌────▼─────┐
                    │ PLANNING │ ◄──────── Retry (max 3×)
                    └────┬─────┘
                         │ plan generated
                    ┌────▼─────┐
               ┌───▶│EXECUTING │
               │    └────┬─────┘
               │         │
          ┌────┼────┬────┼────┬────┐
          │    │    │    │    │    │
      ┌───▼──┐┌──▼──┐┌──▼──┐┌──▼──┐┌──▼──┐
      │Agent ││Agent││Agent││Agent││Agent│
      │  A   ││  B  ││  C  ││  D  ││  E  │
      └──┬───┘└──┬──┘└──┬──┘└──┬──┘└──┬──┘
         │       │      │      │      │
         └───────┴──────┴──────┴──────┘
                      │
            ┌─────────┼─────────┐
            │         │         │
       ┌────▼────┐┌───▼───┐┌───▼────┐
       │ALL_DONE ││PARTIAL││  ALL    │
       │(success)││_FAIL  ││  FAIL   │
       └────┬────┘└───┬───┘└───┬────┘
            │         │         │
       ┌────▼────┐┌───▼────┐┌──▼──────┐
       │SYNTHESIS││COMPENS.││ESCALATE │
       │(compose ││(undo   ││(to human│
       │ result) ││partial)││ agent)  │
       └────┬────┘└───┬────┘└──┬──────┘
            │         │         │
            └─────────┼─────────┘
                      │
                 ┌────▼─────┐
                 │  DONE    │
                 └──────────┘

COMPENSATION on PARTIAL_FAIL:
  - RefundAgent ran but PolicyAgent failed
  → Must reverse the refund (compensating transaction)
  - If reverse fails: escalate to human, log incident
```

### 6.2 Timeout and Cascading Failure

The subtle failure mode most teams miss: **transitive timeout amplification.**

Agent B depends on Agent A's output. If A has a 30-second timeout and B has a 30-second timeout, what happens?

```
Scenario: Agent A's tool call hangs at 29 seconds

  T=0s:    Orchestrator dispatches Agent A
  T=29s:   Agent A's API call hangs (will timeout at T=30s)
  T=30s:   Agent A times out. Orchestrator must decide:
           - Retry Agent A? (+30s, total now 60s)
           - Fail Agent A and propagate failure to dependents?
  
  If retry:
  T=60s:   Agent B hasn't even started. User has been waiting 60s.
  T=90s:   If Agent B also retries, total = 120s. User has left.

  If fail-fast:
  T=30s:   Orchestrator marks Agent A as failed.
           Agent B receives null input → partial result or escalation.
  T=31s:   Orchestrator returns partial response: "We found your account
           but couldn't verify recent transactions. A specialist will
           review and respond within 1 hour."
  Total: 31s. Acceptable.
```

**The staff engineer's rule:** never let agent-level timeouts sum to more than the SLA. If the end-to-end SLA is 5 seconds, and you have a 4-level agent DAG, each level gets at most 1.25 seconds. Use per-level deadlines, not per-agent timeouts, and fail-fast when a deadline is exceeded.

### 6.3 Deadlock Detection

Multi-agent DAGs with complex dependencies can deadlock. Consider this scenario:

```
Agent A → Agent B (B waits for A)
Agent C → Agent D (D waits for C)
Agent B → Agent D (D waits for B)  ← CYCLE!

If A and C complete but B is slow:
  - D is waiting for B
  - B is waiting for nothing (just slow)
  - No deadlock, just latency

If B → D and D → B (mutual dependency, a cycle):
  - Both wait forever
  - Cycle detection: topological sort the DAG at plan time.
    Reject any plan with a cycle before execution begins.
```

---

## 7. Observability and Debugging

### 7.1 The Trace Problem

A single user request can spawn 5 agents making 20 tool calls across 8 services. When the user says "the agent gave me wrong information," how do you find where it went wrong?

```
┌──────────────────────────────────────────────────────────────┐
│                    DISTRIBUTED AGENT TRACE                    │
│                                                               │
│  trace_id: abc-123    workflow: refund_dispute                │
│  customer_id: C789    start_time: 2026-06-24T10:15:30Z        │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ ORCHESTRATOR │ 10:15:30.100 │ PLANNING_START            │ │
│  │              │ 10:15:31.850 │ PLAN_GENERATED (1.75s)    │ │
│  │              │ 10:15:31.900 │ DISPATCH AuthAgent        │ │
│  └──────────────┼──────────────────────────────────────────┘ │
│                 │                                              │
│  ┌──────────────▼──────────────────────────────────────────┐ │
│  │ AuthAgent    │ 10:15:31.950 │ START                      │ │
│  │              │ 10:15:32.100 │ TOOL: get_customer(c789)  │ │
│  │              │ 10:15:32.450 │ TOOL_RESULT: {name:"..."} │ │
│  │              │ 10:15:33.200 │ DONE (1.25s)              │ │
│  └──────────────┼──────────────────────────────────────────┘ │
│                 │                                              │
│  ┌──────────────▼──────────────────────────────────────────┐ │
│  │ ORCHESTRATOR │ 10:15:33.250 │ RECEIVED AuthAgent result │ │
│  │              │ 10:15:33.300 │ DISPATCH TxnAgent,        │ │
│  │              │              │          PolicyAgent       │ │
│  └──────┬───────┴──────────────┴───────────────────────────┘ │
│         │                    │                                 │
│  ┌──────▼──────┐    ┌────────▼───────┐                       │
│  │ TxnAgent    │    │ PolicyAgent    │  (parallel)           │
│  │ 10:15:33.35 │    │ 10:15:33.35    │                       │
│  │ TOOL: get_  │    │ TOOL: check_   │                       │
│  │ transactions│    │ refund_policy  │                       │
│  │ ...         │    │ ...            │                       │
│  └─────────────┘    └────────────────┘                       │
└──────────────────────────────────────────────────────────────┘
```

### 7.2 Key Metrics

| Metric | What it measures | Alert threshold |
|--------|-----------------|-----------------|
| **planning_latency_p99** | Time to generate execution plan | > 3s |
| **agent_execution_latency_p99** | Per-agent execution time | > 5s (per agent) |
| **end_to_end_latency_p99** | User request to final response | > SLA (e.g., 10s) |
| **tool_call_error_rate** | Failed tool calls / total calls | > 2% |
| **agent_retry_rate** | Agent retries / total invocations | > 5% |
| **deadletter_queue_depth** | Tasks that exhausted all retries | > 100 |
| **orchestrator_context_utilization** | Tokens used / context window | > 80% |
| **plan_cache_hit_rate** | Cached plans / total plans | < 70% (cache too cold) |

---

## 8. Sharp Question

> **"You're designing a multi-agent system for a bank's fraud detection pipeline. Three specialist agents — Transaction Analyzer, User Behavior Model, and External Risk API — must all agree before flagging a transaction as fraudulent. If any agent disagrees, the transaction passes. The Transaction Analyzer completes in 200ms, the User Behavior Model takes 800ms, and the External Risk API is unreliable: 95th percentile latency is 3 seconds but it occasionally hangs for 30 seconds. The SLA for the entire pipeline is 1 second. How do you meet the SLA without compromising fraud detection accuracy?"**

### Model Answer

The core insight is that the three agents aren't equally important — the External Risk API is the slowest and least reliable, so it must be handled asynchronously.

**Architecture: Async with post-hoc correction.**

The pipeline executes synchronously with a 1-second deadline:
- Transaction Analyzer (200ms) and User Behavior Model (800ms) run in parallel → 800ms wall time
- External Risk API is NOT called during the synchronous path

Instead, the External Risk API call is fired asynchronously at the same time, but its result is not waited for. The synchronous path returns a decision based on the two fast agents alone: if either disagrees, the transaction passes immediately. If both agree it's fraud, the transaction is flagged BUT held in a pending state (not yet blocked).

The External Risk API result arrives asynchronously (typically 1-3 seconds later, worst case 30 seconds). If the API also agrees it's fraud, the pending flag becomes a confirmed block. If the API disagrees, the flag is removed. If the API times out after 30 seconds, the pending flag auto-expires after a configurable window (e.g., 60 seconds) — the transaction passes.

**Why this works:** In practice, the two fast agents alone catch 90%+ of fraud. The External Risk API catches an additional 5-8% that the fast agents miss. By deferring the API check to post-transaction, you lose at most 5-8% of fraud catches within the 1-second window — and recover them within seconds when the API result arrives. The net fraud detection rate is nearly identical to the synchronous approach, but P99 latency drops from 3+ seconds to 800ms.

**Trade-off acknowledged:** There's a small window (1-60 seconds) where a fraudulent transaction is in "pending" state rather than confirmed blocked. For a bank, this is acceptable for low-value transactions (<$500) but not for high-value wires (>$10,000). The system can tier: low-value transactions use async, high-value transactions wait for the full pipeline (with a higher SLA).

### Common Pitfall

**Waiting for all agents synchronously with a global timeout.** Many candidates say: "Set a 1-second timeout on the whole pipeline." The problem: if the External Risk API takes 2.9 seconds (within its normal P95), the 1-second timeout kills a perfectly good result. You're trading accuracy for latency unnecessarily. Worse, if the timeout fires mid-API-call, you might leave the external system in an inconsistent state (the API processed the check but the orchestrator discarded the result). The correct approach is to decouple the slow dependency, not to kill it.

---

## 9. Common Pitfalls Summary

| Pitfall | Why it happens | How to avoid |
|---------|---------------|--------------|
| **Cascading timeouts** | Agents wait for each other with independent timeouts | Use end-to-end deadline, propagate downward |
| **Orchestrator context overflow** | Planner tries to hold all agent states in context | Macro-plan + micro-executor; planner only sees summaries |
| **Non-idempotent tool retries** | Retry logic assumes all tools are safe to retry | Declare side-effect profiles; gate retries on idempotency |
| **Unbounded memory growth** | Storing every intermediate step forever | Tiered retention: hot/warm/cold/frozen/discard |
| **Silent agent failures** | Agent fails but orchestrator doesn't detect it | Heartbeat + health check per agent; dead letter queue |
| **Plan explosion** | LLM generates overly granular plans | Constrain plan depth (max 5 levels); template-based plans |
| **Routing to wrong agent** | Intent classifier misclassifies edge case | Hybrid routing (keyword → embedding → LLM) with confidence threshold |
| **Stale cached plans** | Plan cache doesn't invalidate on policy changes | Version plans; hash includes policy_version; TTL on cache entries |
| **Tool credential sprawl** | Each agent gets full API access | Principle of least privilege: each agent gets only the tools it needs |
| **No human escalation path** | System tries to handle everything autonomously | Every workflow has an escalation threshold; dead letter queue → human review |

---

## 10. Self-Check Questions

*For self-study review — test yourself on these before moving to the next topic.*

1. **Explain the tiered orchestration pattern.** Why does a single orchestrator become the bottleneck at scale, and how does macro-planner + micro-executor solve it?

2. **What is the adapter isolation vs. throughput trade-off, and how does it apply to agent routing?** (Hint: think about sticky sessions vs. stateless agent pools.)

3. **Design the memory architecture for a multi-agent system handling 10M tasks/month.** What storage backends do you use for working, short-term, long-term, and procedural memory? What's your retention policy for each?

4. **An agent's tool call to a payment API hangs at 29 seconds with a 30-second timeout. Five other agents are waiting for this agent's output. What does your orchestrator do?**

5. **What's the difference between an agent pool and a load-balanced service pool?** Why does Round Robin routing fail for agent pools?

6. **Your plan cache hit rate drops from 85% to 40% overnight. What do you investigate?**

---

## 11. Key Takeaways

- **Orchestration is state management.** The orchestrator's primary job is not "planning" — it's managing the state machine of a distributed workflow with partial failures, timeouts, and dependencies.

- **Context windows are the scarcest resource.** Every token in the orchestrator's context window that's spent reasoning about agent state is a token not spent reasoning about the user's problem. Compress, summarize, delegate.

- **Decouple slow dependencies.** Never make the fast path wait for the slow path. Use async dispatch with post-hoc correction for anything that doesn't fit in your latency budget.

- **Memory is a retention problem, not a storage problem.** The question isn't "can we store it?" — it's "should we store it, and for how long?" Design your retention tiers before your storage backends.

- **Audit trails are a product requirement, not an afterthought.** In regulated industries (finance, healthcare), the ability to reconstruct exactly what every agent did and why is non-negotiable. Design audit logging into the tool execution layer from day one.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Multi-agent = decompose complex tasks across specialized agents, each with a role, tools, and memory
- Patterns: planner-executor, router (pick the right agent), tool-use (agents call external APIs), memory (shared or per-agent)
- The orchestrator/planner is often the bottleneck — its LLM context grows with every agent state update
- Two-tier architecture: macro-planner (produces a DAG once) + micro-executors (handle per-step adaptation)
- Audit trails are non-negotiable for regulated industries — log every tool call, input, output, and decision

**Common Follow-Up Questions:**
- "How do you prevent cascading agent failures?" — Circuit breaker per agent, timeout on tool calls, fallback to a simpler agent or human escalation.
- "How do you handle agent memory at scale?" — Short-term in context window, mid-term in a vector DB (semantic search), long-term summarized and stored in a relational DB.

**Gotcha:**
- The planner's context window is the scaling bottleneck. At 200 concurrent tasks each with 3 sub-agents, the planner is reasoning about 600 agent states — that's 600K+ tokens of context. The fix is to make planning a one-time operation and push adaptation down to executors, not re-invoke the planner on every step.
