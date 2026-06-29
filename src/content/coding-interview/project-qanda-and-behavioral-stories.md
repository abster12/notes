---
title: "Project Q&A and Behavioral Stories"
category: "Coding Interview Prep"
tags: [interview-prep, project-pitch, behavioral, stories, star, walmart, rakuten]
last_updated: "2026-06-21"
---

# Project Q&A and Behavioral Stories

This is your **interview storytelling playbook**. Every entry here is a question you'll likely face, paired with a model answer that pulls from your actual experience at Walmart, Rakuten, Podeum, and Morgan Stanley. The answers follow the STAR method (Situation, Task, Action, Result) and emphasize the **Action YOU took** specifically, not the team's.

Before each interview, re-read the relevant sections until you can deliver the stories out loud without notes. The goal is instant recall under pressure.

---

## Summary & Interview Framing

A storytelling playbook using the STAR method to prepare concise, quantified answers about your projects and experience.

**How it's asked:** "Tell me about a project you're proud of. Describe a time you handled conflict. Tell me about a failure — behavioral rounds testing leadership, ownership, and self-awareness."

---

## Part 1: Project Deep Dives

The four projects below cover your most distinctive work. For each, I give a 60-second pitch (for "tell me about a project"), a 3-minute pitch (for "walk me through your most impactful work"), and the most likely follow-up questions with answers.

---

### Project 1: Production AI Platform (RAG + Multi-Agent) at Walmart

**60-second pitch (for "tell me about your work"):**

> At Walmart, I built the production AI platform that handles RAG and multi-agent workflows at scale. The core is a hybrid retrieval system — we use Milvus for semantic search and BM25 for keyword search, then combine them with reciprocal rank fusion and a cross-encoder reranker. That gets us much better precision than either method alone. I also built a multi-agent orchestration system on top of Orkes workflow engine that lets us do human-in-the-loop code generation with deterministic pause and resume. The whole thing serves 1500+ requests per second in production.

**3-minute pitch (for "walk me through a complex system you built"):**

> When I joined Walmart, the team was using off-the-shelf RAG with a single retrieval method. The retrieval quality was a bottleneck — we were getting maybe 60% relevance on top-5 results, which was bad enough that the LLM was hallucinating on a quarter of responses. I redesigned the retrieval stack from scratch.
>
> The new system uses three stages. First, hybrid retrieval: parallel search over Milvus for semantic similarity and Elasticsearch for BM25 keyword match. Then reciprocal rank fusion to combine the two ranked lists into one. Then a cross-encoder reranker that scores the top 50 candidates jointly and picks the final top 5. This is more expensive than single-stage retrieval but the precision gain was worth it — we went from 60% to 85% top-5 relevance, and downstream hallucination dropped to single digits.
>
> For ingestion, I built a document parsing pipeline using Docling for structured documents, pdfplumber for tables, and a Vision LLM for scanned images and charts. Each parser routes to the appropriate one based on document type. The extracted text is chunked with overlapping windows and stored in Milvus with embeddings.
>
> The LLM generation side is where the multi-agent orchestration comes in. For complex queries, instead of one model call, we decompose into sub-tasks — a planner agent breaks the question down, a retriever agent fetches the right context, a critic agent checks the answer, and a synthesizer produces the final response. Each agent is a separate LLM call with specialized prompting. The whole thing is orchestrated by a state machine in Orkes that I integrated end-to-end — SDK, configuration, runtime, all of it. The state machine lets us pause execution, persist state to a database, and resume after a human review. This is critical for code generation where you don't want the agent to run unsupervised.
>
> In production, the system serves 1500+ requests per second with P95 latency around 400ms, including retrieval and LLM inference. We monitor quality continuously with an eval pipeline that runs every new prompt change against a golden dataset of expected behaviors.

**Likely follow-up questions and answers:**

**Q: Why hybrid retrieval instead of just semantic search?**

> Pure semantic search misses exact-match queries — product names, model numbers, anything that's a specific token. Pure keyword search misses conceptual queries. Hybrid gets you both. The key is the fusion strategy: reciprocal rank fusion is the simplest and works well, but you can also do learned fusion with a model that scores candidates. We tried both and RRF was within 2% of the learned approach with way less complexity.

**Q: Why Milvus over other vector DBs?**

> When I started, Milvus gave us the best combination of scale, query performance, and operational maturity for our use case. We needed billion-scale vectors with sub-100ms queries. Milvus handled that. Today I'd still pick it, though Qdrant and Weaviate are credible alternatives.

**Q: How did you measure the 85% relevance number?**

> We had a labeled dataset of 1000 query-document pairs rated for relevance by the team. Top-5 precision is: of the 5 documents we return, what fraction are relevant (rated >=3 out of 5 by the labeler). We measured before and after the hybrid system. The 60% baseline was pure semantic search, the 85% is hybrid + reranking. We re-measure monthly to catch regressions.

**Q: Walk me through the multi-agent orchestration in more detail.**

> The state machine has these states: planning, retrieval, critique, synthesis, review, done. Each state is a step in the Orkes workflow. The planner emits a JSON plan with sub-tasks. Each sub-task triggers a retriever step. The retriever runs the hybrid search I described. The critic evaluates whether the retrieved context is sufficient. If not, the planner gets invoked again with the critic's feedback. If yes, the synthesizer generates the response. For code generation tasks, there's a review state where the workflow pauses and a human reviews the generated code. The state is persisted to Postgres so a human can resume the workflow hours or days later. The key insight: by making the state machine explicit, we get human-in-the-loop for free without changing the agent logic.

**Q: What's the most challenging bug you debugged in this system?**

> Early on, the reranker was getting garbage results. The output was always 0.1 confidence regardless of input. I spent two days thinking the model was broken. Then I checked the input pipeline and found that the cross-encoder was getting the query and document concatenated in the wrong order — it was `document + query` instead of `query + document`. The model was trained on the latter, so it was producing nonsense. One line change fixed it. The lesson: when something is consistently wrong, check the data, not the model.

---

### Project 2: High-Throughput Workflow APIs (1500 RPS, 200ms → 130ms P95)

**60-second pitch:**

> At Walmart I own the core workflow APIs that handle 1500 synchronous executions per second. When I took over, P95 latency was 200ms. Through a combination of query optimization, indexing, and infrastructure tuning, I got it down to 130ms — a 35% reduction that scaled us to a new order of magnitude of traffic.

**3-minute pitch:**

> The Start and Update Workflow APIs are the entry point for every workflow execution in the platform. Every time a workflow runs, it calls these APIs. The old architecture was synchronous and monolithic — each API call did the workflow engine handshake, the database write, and the cache update in a single thread, with no parallelism.
>
> The first issue was the database. The queries were doing full table scans because the index on workflow_id was wrong — it was a non-unique index on a low-cardinality column, so the planner ignored it. I added a composite index on (tenant_id, workflow_id) which is what queries actually filter on. That alone took 40% off the latency.
>
> The second issue was the workflow engine handshake. The old code did a synchronous RPC to the engine and waited for the response. I refactored to fire the RPC in parallel with the database write, then awaited both. This overlapped the ~30ms engine call with the ~50ms DB write.
>
> The third issue was connection pool saturation. Under load, the connection pool would starve and threads would block. I increased the pool size to match the async concurrency limit, and added circuit breakers around the engine call to fail fast if the engine was unhealthy.
>
> Together, these changes took P95 from 200ms to 130ms — a 35% reduction — and the system now reliably handles 1500 RPS in production.

**Likely follow-up questions:**

**Q: How did you identify the database issue as the first bottleneck?**

> I instrumented the API call with timing breakdowns — total time, time in DB query, time in engine call, time in cache update. The DB query was taking 80ms, which was way too long for what should have been a primary key lookup. Then I ran EXPLAIN on the query and saw it was doing a sequential scan on a million-row table. The index existed but wasn't being used. Composite index fixed it.

**Q: How do you avoid regressions on latency?**

> Continuous benchmarking. Every deploy runs the API through a load test that measures P50, P95, P99 under realistic traffic. If P95 increases by more than 5%, the deploy is blocked. We also have a Grafana dashboard with P95 latency broken down by component, so we can see immediately if a change regresses one of the sub-components.

**Q: Tell me about the most stressful incident in this system.**

> We had a production incident where the workflow engine started returning 5xx errors under load. The Start API started timing out, which caused callers to retry, which made the load worse — classic retry storm. I had to:
> 1. Add circuit breakers to fail fast when the engine was unhealthy
> 2. Implement a per-tenant rate limit to prevent one bad tenant from taking everyone down
> 3. Set up exponential backoff with jitter on the client side
>
> The fix was a coordinated change across three services. The incident lasted 2 hours and we learned that we needed fail-fast behavior, not retry-on-error, as the default.

---

### Project 3: Stateful Multi-Agent Orchestration (Pause/Resume for Human-in-the-Loop)

**60-second pitch:**

> At Walmart, I designed a multi-agent orchestration system where AI agents can be paused mid-execution for human review and resumed later. The state machine persists to a database, so a code review that starts today can be picked up tomorrow by a human and continue. The agents have dynamic model selection — they pick the right model for each subtask based on complexity.

**3-minute pitch:**

> Most multi-agent systems are fire-and-forget. You give a prompt, the agents work, you get an answer. But for code generation, you want a human to review the plan before any code is written, and review the code before it's shipped. This requires pause-and-resume.
>
> My design is a state machine on top of Orkes workflow engine. Each state is a step: plan, retrieve, execute, review, refine, ship. When the workflow reaches a review state, it persists all its state to a database and stops. A human reviews the output and either approves (workflow continues), rejects with feedback (workflow re-enters plan state with the feedback), or modifies the output (workflow continues with the modification).
>
> The state machine is implemented as a workflow definition in Orkes — I wrote the JSON spec, the activities for each step, and the event handlers. The state is persisted to a Postgres table that the workflow engine manages. When a human resumes, the engine reads the state and continues from where it left off.
>
> One of the most interesting parts is dynamic model selection. Each agent step can pick its own LLM based on the complexity of the subtask. Simple retrieval uses a small fast model. Complex planning uses the largest model. The selection is made by a classifier that looks at the prompt and predicts the complexity. This way, we use expensive models only when needed, and the average cost per workflow is much lower than running the largest model on every step.

**Likely follow-up questions:**

**Q: How do you ensure the pause/resume is actually deterministic?**

> Every state transition writes the new state to the database before executing the next step. If the workflow is interrupted (crash, manual pause, or scheduled hold), the next execution reads the state and continues. The state includes all inputs, intermediate results, and the current position in the state machine. There's no in-memory state that's not persisted.

**Q: How do you handle the human reviewing hours or days later?**

> The state is durable. When the human comes back, they see exactly what the agent generated and the state of the workflow. They can approve, reject, or modify. The system doesn't time out — workflows can be paused indefinitely. We do clean up workflows that have been paused for over 90 days, with a notification to the original requester first.

**Q: What if the human's feedback is ambiguous?**

> The workflow includes a "refine" state that takes the feedback and re-enters the plan state with the feedback as additional context. The agent's job is to interpret the feedback and produce a new plan. If the human's feedback is too vague, the agent asks for clarification — we added a clarification state to handle this.

---

### Project 4: 0 to 10K DAU as Founding Engineer at Podeum

**60-second pitch:**

> At Podeum I was the first engineering hire. I built the entire backend from scratch — authentication, virtual economy, in-app purchases, real-time live score feeds. We grew to 10,000 daily active users in about a year. It was the best learning experience of my career because I had to make every technical decision.

**3-minute pitch:**

> Podeum was a small gaming platform. I joined as the founding engineer when it was just the founder and a designer. My first task was to set up the entire backend. I chose Java with Spring Boot because I was most familiar with it and it had good support for the patterns I needed: dependency injection, ORM, REST APIs, async messaging.
>
> The first feature I built was authentication. I went with email/password for simplicity, JWT for session tokens, and BCrypt for password hashing. I considered OAuth from day one but decided the friction wasn't worth it for an early-stage product.
>
> The virtual economy was the most interesting challenge. Users earn in-app currency by playing, spend it on upgrades, and can purchase more with real money. I modeled the currency balance as a single row in a ledger table per user, with all transactions recorded in a separate table. The balance is computed as the sum of transactions — never directly modified. This makes the system auditable: if a user reports a balance issue, you can replay their transactions to find the discrepancy. The pattern also handles concurrency safely using optimistic locking on the ledger.
>
> In-app purchases were integrated with the Google Play and Apple App Store APIs. I built a server-side receipt validation flow that checks the receipt with the store, marks it as used, and grants the in-app currency. Without server-side validation, anyone with a fake receipt could get free currency.
>
> Real-time live scores were the hardest part. I used WebSocket for the client-server connection, with a backend that aggregated scores from a Kafka stream. Each game event went to Kafka, the score aggregator consumed from Kafka and pushed updates to connected clients via WebSocket. We used Redis pub/sub to fan out across multiple backend instances.

**Likely follow-up questions:**

**Q: How did you handle scaling as you grew from 0 to 10K users?**

> I over-engineered for the first 6 months and under-engineered for the last 6 months. Specifically: I started with a single monolith and kept it that way longer than most engineers would recommend. We had hot spots (the score feed), and I addressed them with caching and async processing rather than splitting the service. The lesson: premature microservices are worse than a slightly-fat monolith.

**Q: How did you make technical decisions when you were the only engineer?**

> I documented them. Every major technical decision got a one-page ADR (architecture decision record) explaining the context, options, and why I chose what I chose. The founder reviewed them. This was invaluable six months later when we hired the second engineer and they had to understand the system — the ADRs were the documentation.

**Q: What's something you'd do differently if you did it again?**

> I would invest in observability from day one. We were flying blind for the first few months — when something broke, I'd have to SSH into the box and tail logs to figure out what happened. The first time I added proper metrics, I realized a third of our CPU was being spent on a logging bug. If I'd had metrics from day one, I would have caught that earlier.

---

## Part 2: Behavioral Stories

For each common behavioral question, I give a model answer. The structure is STAR: Situation (1 sentence), Task (1 sentence), Action (the bulk — what YOU did specifically), Result (1 sentence, quantified when possible).

**Important rule:** The "Action" section must be about YOU, not "the team." If the answer is "we did X," the interviewer is going to follow up with "what did YOU specifically do?"

---

### Story 1: A time you had a major disagreement with your manager or teammate

**Question:** "Tell me about a time you disagreed with your manager on a technical decision."

**Answer:**

> When I was at Walmart, my manager wanted to build the new AI platform on top of an existing orchestration framework, but I had a different opinion.
>
> **(Situation)** The team had been using an older workflow engine for two years, and it was showing its limits — it couldn't handle the dynamic model selection and human-in-the-loop patterns we needed.
>
> **(Task)** I had to either convince my manager to adopt a new approach or build something the team could live with.
>
> **(Action)** I didn't argue in a meeting. Instead, I built a working prototype in two weeks using Orkes (the new framework) that demonstrated the human-in-the-loop pattern end-to-end. I documented the technical trade-offs in a one-pager. Then I scheduled a one-on-one with my manager, walked her through the prototype, and asked for her feedback. She saw it working and was convinced.
>
> **(Result)** We adopted the new framework, and the prototype I built became the foundation of the production system. The pattern is now used by multiple teams in the org.

**Why this works:** The candidate took initiative (built a prototype), used evidence rather than argument, and respected the manager's authority (asked for feedback rather than demanding change). The action was clearly theirs, not "we argued in a meeting."

---

### Story 2: A time you failed

**Question:** "Tell me about a time you failed and what you learned from it."

**Answer:**

> At Rakuten, I was leading the integration of a new payment gateway. I was sure the third-party sandbox was reliable and tested our integration only against the sandbox. The first week in production, half our transactions were failing.
>
> **(Situation)** I was the engineer responsible for the integration, and the launch was time-sensitive.
>
> **(Task)** I needed to debug the production failure quickly.
>
> **(Action)** I checked the sandbox logs — they showed no issues. I checked the production logs — the failures were coming from the gateway returning errors our integration didn't handle. The sandbox had been returning different error responses than production. I had assumed they were equivalent.
>
> What I did was twofold: first, I patched the integration to handle the production error responses. That took 4 hours of focused debugging. Then, I established a contract test suite that ran our integration against the sandbox AND against recorded production responses, and flagged any drift. I also instituted a process where any new gateway integration must pass a 24-hour shadow test in production before going live.
>
> **(Result)** The fix was deployed within a day. The contract test suite caught a similar drift on a different integration 6 months later. The shadow test process is now used for every new external integration at the company.

**Why this works:** The candidate owns the failure ("I had assumed"), explains what they learned, and shows they built a system to prevent the same failure from happening again. The action was clearly theirs.

---

### Story 3: Your biggest technical accomplishment

**Question:** "What's the most impactful thing you've built?"

**Answer:**

> The production AI platform at Walmart is my most impactful work. We moved from a single-stage retrieval system that was giving us 60% relevance to a hybrid retrieval with reranking that gave us 85%, which translated to a 4x reduction in user-visible hallucinations.
>
> **(Situation)** The team was using an off-the-shelf RAG solution that was failing on a quarter of user queries.
>
> **(Task)** I owned the redesign of the retrieval system.
>
> **(Action)** I researched approaches, picked hybrid retrieval with reranking, and built it end-to-end: the parsing pipeline, the indexing, the hybrid search, the reranker integration, the evaluation. I worked with the ML team to train a custom cross-encoder for our domain. I built the eval pipeline to measure quality continuously. I worked with the platform team to deploy it to production.
>
> **(Result)** Quality went from 60% to 85% top-5 relevance. Hallucination rate dropped from 25% to under 5%. The system now serves 1500+ RPS in production. Multiple teams have adopted the architecture for their own use cases.

**Why this works:** The candidate picked a specific, measurable accomplishment and told a story with clear actions and quantified results. The "I" throughout the action section makes it clear what the candidate personally did.

---

### Story 4: A time you had to learn something quickly

**Question:** "Tell me about a time you had to pick up a new technology or skill under time pressure."

**Answer:**

> When I joined Walmart, the team was using a workflow engine I'd never seen before. My first project required me to integrate it deeply.
>
> **(Situation)** I had two weeks to deliver a working integration.
>
> **(Task)** I needed to learn the workflow engine's API, the deployment model, the operational characteristics, and the failure modes.
>
> **(Action)** I started by reading the documentation end-to-end, but I knew documentation alone wouldn't cut it. I built a small prototype in the first three days that exercised the main APIs. I asked the engineer who had built the initial integration to do a code review. I read the source code of the engine itself for the parts I was using. I joined the engine's community Slack and asked specific questions.
>
> **(Result)** I delivered the integration on time, and the patterns I established are still used in the codebase. The approach I learned — read docs, build prototype, review with expert, read source, ask the community — is now my standard way to pick up any new technology.

**Why this works:** The candidate shows a specific, repeatable learning process. The action is concrete (read docs, build prototype, review, read source, ask community) and the result is the integration being delivered.

---

### Story 5: A time you helped a teammate

**Question:** "Tell me about a time you helped a junior engineer grow."

**Answer:**

> I had a mentee at Walmart who was a strong individual contributor but had never worked on a system with significant scale. They were about to start owning a service that handled 200 RPS, and they were nervous.
>
> **(Situation)** A junior engineer on my team was about to take on their first service with meaningful traffic.
>
> **(Task)** I needed to bring them up to speed and give them confidence.
>
> **(Action)** I paired with them for the first week, walking through the service's architecture, the load test setup, the on-call runbook, and the most common production issues. I had them shadow me on-call for two weeks. I introduced them to the platform team and the SRE team so they had a network. I gave them a specific small project (improving a slow query) and let them drive — I reviewed their design doc and PR but didn't rewrite it.
>
> **(Result)** Six months later, the mentee was independently owning the service. They handled a 5x traffic spike during a sale without any escalations to me. They're now a tech lead themselves.

**Why this works:** The candidate describes a specific, real mentoring relationship with concrete actions. The mentee's growth is the result, not the candidate's own accomplishment.

---

### Story 6: A time you had to make a decision with incomplete information

**Question:** "Tell me about a time you had to make a decision with limited information."

**Answer:**

> When I was founding engineer at Podeum, we had a security incident at 2am — a user reported their account had been accessed from a different country. I was the only engineer.
>
> **(Situation)** A user reported suspicious activity on their account.
>
> **(Task)** I needed to decide what to do within minutes — investigate, lock accounts, notify users, escalate to the founder.
>
> **(Action)** I made the decision to immediately lock the affected account and add IP-based anomaly detection to flag any other accounts that might be compromised. I didn't have full information about the scope of the breach, so I went with the conservative assumption that it could be widespread. I notified the founder and the affected user. The next morning, we did a full investigation.
>
> **(Result)** The investigation showed only one account was compromised (the user's password was in a public breach database — not our fault). But the conservative decision was the right one — better to over-react than under-react when you don't know. After this, we built proper monitoring and incident response procedures, so future incidents would have a clearer playbook.

**Why this works:** The candidate made a clear, defensible decision under pressure. They explained the reasoning (conservative assumption given limited information) and showed the result.

---

### Story 7: A time you pushed back on something

**Question:** "Tell me about a time you pushed back on a decision you disagreed with."

**Answer:**

> At Rakuten, leadership wanted to add a new feature to the payment batch processing that would have required us to break idempotency guarantees.
>
> **(Situation)** A product team proposed a new retry behavior that would have allowed duplicate payments in failure cases.
>
> **(Task)** I needed to either accept the change or push back with a strong alternative.
>
> **(Action)** I wrote a one-pager explaining the technical risk (duplicate payments could violate financial regulations and trigger chargebacks) and proposed an alternative: a more aggressive retry strategy that preserved idempotency by using a transaction key. I presented this to the product lead, the engineering lead, and the compliance team. The compliance team immediately agreed with me. The product team accepted the alternative once they understood the constraint.
>
> **(Result)** The change was implemented with the safe alternative. We never had a duplicate payment incident. The pattern of "explain the risk, propose an alternative, get sign-off from the right stakeholders" became my standard for pushing back.

**Why this works:** The candidate didn't just say no — they proposed a viable alternative. They identified the right stakeholders (compliance) and built a coalition. The action was theirs.

---

### Story 8: Why are you leaving (or want to leave)?

**Question:** "Why are you looking for a new role?"

**Answer (for someone currently employed):**

> I'm looking for a role where I can have more impact at scale and work on harder technical problems. I've been at [current company] for [X years] and I've grown as much as I can there — I've led [X], built [Y], and the next set of challenges would be at a larger scale or in a different domain.
>
> Specifically, I'm excited about [company name] because [genuine specific reason — their tech, their problem, their team]. I've been following [their work, their papers, their product] and the problems you're solving are the ones I want to spend my next few years on.

**Important:** Always be positive about your current employer. Never badmouth. Frame it as growth, not escape.

**Answer (if currently unemployed or between roles):**

> I left [previous company] because [brief, positive reason — reorganization, end of contract, the role wasn't the right fit]. Since then I've been [studying, building, exploring]. I'm now ready to commit to a new role and [company name] is the one I want to commit to because [specific reason].

---

### Story 9: Why this company?

**Question:** "Why do you want to work here?"

**Answer template:**

> Three specific reasons. First, [genuine technical reason — your tech, your approach, your recent work]. Second, [genuine business reason — the problem you're solving, the market you're in]. Third, [genuine people/culture reason — someone I know here, the way the team operates, the mission].
>
> Specifically, I've been following [their work] — [give a specific example: a paper they published, a feature they shipped, a talk someone gave]. That resonates with me because [your reason].

**Important:** This answer must be specific to the company. "You have a great culture" is generic and forgettable. "I read your paper on X and your approach to Y is exactly what I want to work on" is specific and memorable.

---

### Story 10: A time you disagreed with a peer

**Question:** "Tell me about a time you had a conflict with a coworker and how you resolved it."

**Answer:**

> At Walmart, a peer engineer and I disagreed on the architecture for a new service. I wanted to use a service-mesh-based approach for inter-service communication; he wanted direct HTTP calls.
>
> **(Situation)** Two senior engineers had different architectural preferences for a new service.
>
> **(Task)** I needed to either convince him or reach a resolution we could both live with.
>
> **(Action)** I scheduled a 30-minute whiteboard session with him to walk through both approaches. I came prepared with specific scenarios (high load, partial failure, deploys). We went through each and realized that the right answer depended on the latency requirements of the specific service. For services with strict latency budgets, the mesh overhead was too much. For services with looser requirements, the mesh was worth it.
>
> We ended up with a hybrid: direct HTTP for the latency-critical path, mesh for everything else. We wrote up the decision in an ADR that the team could reference.
>
> **(Result)** The hybrid approach shipped, and it's been working well. The peer and I have a good working relationship because we resolved the disagreement with evidence rather than opinion.

**Why this works:** The candidate showed intellectual honesty (they didn't "win" the argument — they found a better answer). The action involved preparation, structured discussion, and a written artifact. The result was a good technical outcome and a preserved relationship.

---

## Part 3: Pitch Cheat Sheet

For each of your 4 major projects, have these variants ready:

| Project | 60s pitch | 3min pitch | 10min deep dive |
|---|---|---|---|
| AI Platform (RAG + Multi-Agent) | 3 sentences covering hybrid retrieval + multi-agent + 1500 RPS | 5 paragraphs covering problem → approach → architecture → challenges → results | Walk through the actual code, retrieval pipeline, eval methodology |
| Workflow APIs (1500 RPS) | 3 sentences covering what the APIs do + the perf improvement | 4 paragraphs covering the problem → diagnosis → fix → monitoring | Walk through the EXPLAIN output, the parallelization, the connection pool tuning |
| Multi-Agent Pause/Resume | 3 sentences covering the use case + state machine + dynamic model selection | 4 paragraphs covering why pause/resume → Orkes integration → state persistence → dynamic model selection | Walk through the state machine, the database schema for state, the model selection classifier |
| Podeum 0 to 10K | 3 sentences covering founding engineer + what was built + the growth | 4 paragraphs covering early decisions → virtual economy → real-time scores → scaling | Walk through the ledger pattern, the Kafka score feed, the receipt validation flow |

**Practice rule:** Say each pitch out loud, ideally to another person, until you can deliver it in 60s / 3min / 10min without notes.

---

## Part 4: Rapid-Fire Self-Test

Before any interview, practice answering these in 60 seconds each, out loud:

1. Tell me about yourself. (Your background, current role, why you're interviewing.)
2. Tell me about your most impactful project.
3. Tell me about a time you failed.
4. Tell me about a time you had a conflict with a coworker.
5. Why are you looking for a new role?
6. Why do you want to work here?
7. What's your biggest strength?
8. What's your biggest weakness?
9. Where do you see yourself in 5 years?
10. What questions do you have for me?

If you can't answer each in under 90 seconds, write out a draft and practice until you can.

---

## Part 5: Closing Arguments

Always have 2-3 questions for the interviewer. They signal that you're serious and curious. Good questions:

- "What's the biggest technical challenge the team is facing right now?"
- "How is success measured for this role in the first 6 months?"
- "What does the team do when an on-call incident happens?"
- "What's something the team has tried that didn't work?"
- "How do you see the team evolving in the next year?"
- "What would I be working on in the first month?"

Avoid: "What's the work-life balance?" (too early), "How much PTO do I get?" (too transactional), "Can you tell me about the culture?" (too generic).

---

## Summary

You now have:
1. **4 deep project pitches** with 60s, 3min, and 10min variants, plus likely follow-up questions
2. **10 behavioral stories** using STAR method, all from your real experience
3. **Pitch cheat sheet** for quick reference before each interview
4. **Rapid-fire self-test** for practice
5. **Closing-argument questions** to ask the interviewer

Combined with your existing 19 articles covering technical content, you have a complete interview prep package. The next step is practice — say these pitches out loud, ideally to another person, until they're natural.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- STAR method: Situation, Task, Action (what YOU did), Result (quantified). Prepare 5-7 stories covering leadership, conflict, failure, ambiguity, and technical depth.
- Each story should be 2-3 minutes spoken. Always emphasize YOUR specific contribution, not the team's.
- Quantify results (e.g., "reduced latency by 40%" not "improved performance").
- Have 60s, 3min, and 10min variants of each project pitch ready.
- Always have 2-3 thoughtful questions for the interviewer at the end.

**Common Follow-Up Questions:**
- "What if I don't have a story for a specific question?" — Adapt a story you do have. Most behavioral questions test the same core competencies (ownership, collaboration, resilience). One story can answer multiple questions.
- "How do I handle the 'tell me about a failure' question?" — Choose a real failure where you learned something. Show self-awareness, not blame-shifting. The result section should include what you'd do differently.

**Gotcha:** Telling a team story instead of a personal story. "We built X" is weak. "I designed the API, wrote the Kafka consumer, and led code reviews" is strong. Interviewers want to know what YOU did, not what your team accomplished.
