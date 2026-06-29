---
title: "Interview Process & Strategy Guide"
category: "Career"
tags: [interview-prep, strategy, negotiation, behavioral, ml-coding, pytorch, job-search]
last_updated: "2026-06-21"
source: "Synthesized from Alisa Liu's job search post (OpenAI) + personal experience"
---

# Interview Process & Strategy Guide

This is the **strategic and process layer** that sits on top of your technical prep. The Coding Interview Prep and System Design folders cover *what* to know. This doc covers *how* the process actually works, what to expect, and how to navigate the parts that aren't about solving LeetCode.

Sources: Alisa Liu's viral post on landing a Research Scientist role at OpenAI (after a 6-year PhD at UW) — 11 companies, 57 interviews, 46 recruiter calls — plus general industry patterns. Her post is at alisawuffles.github.io/blog/job-search. Her experience is PhD-research-leaning, but ~80% applies to any senior IC role.

---

## Summary & Interview Framing

The full interview loop structure (recruiter → phone screen → onsite) and strategies for communication, problem-solving approach, and behavioral rounds.

**How it's asked:** "Meta-question: how to prepare for and navigate the interview process itself — communication, clarifying questions, thinking aloud, and STAR method for behavioral rounds."

---

## The Interview Process — What to Expect

### Realistic Numbers (for senior IC roles)

| Metric | Typical range |
|--------|--------------|
| Total applications sent | 50-200 |
| Recruiter calls received | 15-40 |
| Companies that move to onsites | 6-15 |
| Companies that ghost you | 2-5 (yes, this is normal) |
| Final offers | 1-4 |
| Total interview rounds per company | 3-7 |
| Total interviews across the search | 30-70 |
| Time from first application to first offer | 1.5-4 months |
| Time from first offer to signed offer | 2-6 weeks (negotiation + competing processes) |

Alisa's experience at the upper end (11 companies, 57 interviews, 46 recruiter calls) — that's a heavy but not unusual search for a research role. For a staff/senior backend role at a typical company, expect 5-10 companies and 20-40 interviews.

### The Process Flow Per Company

```
Application → Recruiter screen → Hiring manager chat → Onsite (3-5 rounds) → Decision
                                                                       ↓
                                                            (if good) → Offer → Negotiate → Sign
```

Most candidates underestimate how much variance exists across companies in:
- **Speed**: some move in 2 weeks, others take 2 months per stage
- **Process structure**: some have strict pipelines, others are ad hoc
- **Decision ownership**: some are committee-based, others are single-hire-manager
- **Flexibility on deadline**: most will let you delay 2-4 weeks, "exploding offers" (1-week deadlines) are rare but real

---

## Six Interview Types — What They Actually Test

From the most to least common, here's what you'll face. Note the first two are what your existing prep covers. The rest are gaps.

### 1. General Coding (LeetCode) — Most Common
**What it tests:** Data structures, algorithms, clean code, edge case handling
**What your prep covers:** Excellent — 18 articles in Coding Interview Prep cover all the patterns

**Alisa's key insight:** "It's good to build strong foundations here because the concepts often show up in ML coding interviews, too." LeetCode skills transfer directly.

### 2. ML/Systems Coding (PyTorch / numpy) — Very Common for AI Roles
**What it tests:** Implement an architecture, a decoding strategy, a loss function, a small training loop, an inference path from scratch

**What your prep is missing:** We have system design for AI/LLM but no PyTorch implementation practice. This is the biggest gap.

**What you need to know cold:**
- Implement a transformer block (attention + FFN + residual + LayerNorm) from scratch in PyTorch
- Implement multi-head self-attention with proper masking (causal mask, padding mask)
- Implement a basic training loop: forward pass, loss, backward, optimizer step, gradient clipping
- Write a generation loop with sampling (greedy, top-k, top-p, temperature)
- Implement RoPE, GQA, or KV cache from scratch when asked
- Implement cross-entropy loss with optional label smoothing
- Implement BPE tokenizer from scratch (this came up specifically in Alisa's work — and you built a tokenizer system at Walmart)
- Implement AdamW optimizer from scratch
- Implement batch norm / layer norm / RMS norm

**The "from scratch" test pattern:** Interviewer says "write a transformer decoder layer in PyTorch — no nn.TransformerEncoder or pre-built attention." You build it from linear layers, softmax, and torch.matmul. Memorize this.

### 3. System Design / Architecture Discussion — Common
**What it tests:** Can you design a system end-to-end? Can you defend trade-offs?

**What your prep covers:** 30+ articles in System Design cover this thoroughly. You're well-positioned here.

**Alisa's note:** For research roles, this looks different — it's "design an experiment to answer this research question" not "design Twitter." For engineering roles at AI companies, the system design interview is often "design a system that uses LLMs at scale" or "design a RAG pipeline for X." You already have RAG, multi-agent, and LLM serving articles — you're strong here.

### 4. Technical Discussion (No Coding) — Common
**What it tests:** Breadth of knowledge, depth in your domain, ability to reason about systems without running code

**Examples of rapid-fire questions she got:**
- "What are some different ways of encoding positional information?"
- "What is 5D parallelism?"
- "What is the difference between PPO and GRPO?"
- "How would you debug a model that's not converging?"

**What your prep is missing:** No dedicated doc for ML/AI breadth questions. You have depth articles (RAG, Vector DB, LLM Serving, Fine-Tuning) but no "give me 50 rapid-fire questions and answers" drill doc.

**Topics to know cold for AI/ML breadth:**
- Architectures: Transformer, Mamba/SSM, MoE, Diffusion
- Training: pre-training, fine-tuning, RLHF, DPO, GRPO, PPO
- Scaling laws: Chinchilla, compute-optimal, emergent abilities
- Inference: KV cache, speculative decoding, batching, quantization
- Retrieval: dense vs sparse, hybrid, reranking, chunking strategies
- Evaluation: BLEU, ROUGE, perplexity, MMLU, HumanEval, MT-Bench
- Distributed: data/model/pipeline/tensor/expert parallelism, ZeRO, FSDP
- Data: tokenization, BPE, SentencePiece, data curation, deduplication
- Safety: RLHF for safety, constitutional AI, red-teaming

### 5. Research / Project Discussion — Common for Research Roles
**What it tests:** Can you explain your past work clearly? Do you have insight, not just execution?

**Alisa's key tactic:** "Tailor my research pitch depending on the role; interviewers are tired, so hitting the right keywords makes it easier for them to believe that your profile is relevant."

**Prep framework (apply to your work at Walmart):**
- Have a 60-second, 3-minute, and 10-minute version of each major project
- For each, know: (1) the problem, (2) why it was hard, (3) what you specifically built/contributed, (4) what you'd do differently now
- The 4 big ones for you:
  1. **Workflow APIs (P95 200→130ms, 1500 RPS)** — scalability story
  2. **RAG platform with Milvus hybrid retrieval** — AI infrastructure story
  3. **Multi-agent orchestration with stateful pause/resume** — system design + AI story
  4. **End-to-end Orkes integration** — ownership story

### 6. Behavioral — Always Present
**What it tests:** Will you be a good colleague? Can you handle conflict? Do you have self-awareness?

**Alisa's painful lesson:** "I failed my first behavioral interview because I went into it thinking I'm obviously well-behaved, and came up blank on excruciatingly simple questions. Trust me, it is uniquely painful to try to reconstruct hazy memories at the same time as delivering them in an interview, only for the interviewer to say at the end, 'You didn't answer the question.'"

**This is the single biggest gap in your prep — there's no behavioral article.**

The classic questions to prepare for (write 2-3 stories for each):

| Question | What they're probing |
|----------|---------------------|
| Tell me about a time you disagreed with your manager | Conflict navigation, maturity |
| Tell me about a time you failed | Self-awareness, growth |
| Tell me about your biggest technical accomplishment | Depth, ownership |
| Tell me about a time you had to learn something quickly | Adaptability |
| Tell me about a time you helped a teammate | Collaboration, generosity |
| Tell me about a time you had to make a decision with incomplete info | Judgment, risk tolerance |
| Why are you leaving? | Self-awareness, communication |
| Why this company/role? | Genuine interest, research quality |
| What's the hardest technical problem you've solved? | Depth, humility |
| Tell me about a time you had to push back on something | Conviction, diplomacy |

**Use the STAR method:** Situation (1 sentence), Task (1 sentence), Action (most of the time — what YOU did), Result (1 sentence, ideally quantified). **The "Action" part must be about YOU specifically**, not "the team."

### 7. Math Interview — Less Common
**What it tests:** Quantitative reasoning, foundational understanding

**What to refresh:**
- Probability: Bayes' theorem, expectation/variance, common distributions
- Linear algebra: matrix multiplication, eigenvalues, SVD
- Calculus: chain rule, gradient descent intuition
- Statistics: confidence intervals, hypothesis testing

**Alisa's advice:** "Brush up on probability, linear algebra, and calculus."

### 8. Job Talk (Research Roles Only)
**What it tests:** Can you give a clear, engaging talk about your work to a mixed audience?

For research roles. 30-45 min talk + Q&A. Usually focused on 1-2 papers, not your whole thesis.

---

## Timing Your Search — Tactical Advice

### Practice First, Then Real

Use 2-3 companies for practice, then time the rest so offers come close together. But three caveats from Alisa:

1. **Stamina is finite** — don't burn out by the time you reach the companies you care about most
2. **External factors matter more than prep** — headcount, which teams are hiring, recruiter pressure. Talk to friends to learn this
3. **Deadlines are flexible** — recruiters expect you're juggling other processes. But watch for "exploding offers" (1-week deadlines) — ask upfront how much time candidates are typically given

### Get the First Interview

Two ways to get interviews:
1. **Apply directly** (cold applications, referrals) — works for some companies, but is the slowest path
2. **Have someone vouch for you** — internal referrals get 4-10x higher response rates

Alisa: "To get that first interview, sometimes you need to have someone inside the company vouching for you. You can set yourself up for success early on by being social at conferences, collaborating widely, and attending networking events."

**For you specifically:** Your ex-coworkers at Walmart, Rakuten, Morgan Stanley, and Podeum are a goldmine. A warm intro from any of them to their current company can fast-track you past the recruiter screen. Make a list of 30-50 such people before you start applying.

### Connecting After Years

Alisa: "A big part of the job search is reconnecting with people who you may not have talked to in years — this is okay, expected, and turns out to be a wonderful side effect of the process."

**Don't be shy.** A message like "Hey, I'm exploring my next move and would love to chat about what you're working on at [Company]" is normal and welcome. The worst that happens is silence.

---

## Preparation — The Honest Truth

### It's a Full-Time Job

Alisa: "The job search is a full-time job." Most candidates underestimate this by 2-3x. Realistic prep budget:

| Role level | Total prep time | Daily time commitment |
|-----------|-----------------|---------------------|
| Junior (1-3 yrs) | 4-6 weeks | 2-3 hours/day |
| Senior (4-7 yrs) | 6-10 weeks | 3-4 hours/day |
| Staff+ (8+ yrs) | 4-6 weeks (but more targeted) | 2-3 hours/day |

You fall in the senior/staff bracket. Plan for 6-8 weeks of consistent prep.

### The Best Use of Prep Time (Priority Order)

1. **ML coding fluency** — implement a transformer, attention, training loop, generation loop from scratch until you can do it in 25 minutes with no references. This is the highest-leverage thing you can do.

2. **System design depth** — you have 30+ articles, but practice by doing mock designs out loud (60-min timed). You know the content; you need to practice articulating it under pressure.

3. **Behavioral stories** — write 10-15 STAR stories from your career. The writing itself takes 30-60 min per story, but the recall in interview is instant.

4. **Rapid-fire ML breadth** — read 2-3 papers a week outside your immediate area. Be ready to answer "what is X" for any major concept in the last 3 years of ML/LLM research.

5. **Coding patterns** — your 18-article prep covers these, but make sure you can code any pattern in 15 minutes from blank. Practice a few per day.

### Day-of-Interview Rules

Alisa: "Nothing beats getting enough sleep the night before the interview. I made the mistake of doing my first technical interview on 2 hours of sleep after cramming all the intricacies of LLM inference into my brain — none of the last-minute knowledge came up, and I ended up spending 10 minutes on an off-by-one error because my gears were barely turning."

**Rules:**
1. Sleep 7+ hours the night before. Period. No exceptions.
2. Stop studying 1-2 hours before. Do something physical (walk, food, music).
3. After the interview, **write down every question they asked** while it's fresh. This is gold for future prep.
4. **Practice coding with AI assistance completely off** to mimic interview settings. "You will underestimate your reliance otherwise."

---

## Negotiation — The Part Nobody Tells You About

Alisa: "I was shocked to learn that the work is not nearly done after you receive your offers."

This is true even for non-PhD candidates. Most engineers negotiate poorly because they think they're "supposed to" just accept the first offer.

### Key Principles

1. **The first offer is not the final offer.** "Recruiters often explicitly invited me to play the game by saying things like, 'I don't expect you to take our first offer.'" Initial offers have 10-30% room built in by design.

2. **The leverage is in competing offers.** Even one competing offer transforms the conversation from "do you want this job?" to "how do we make this work?"

3. **Negotiate, don't decide, in early calls.** "Before every recruiter call, I wrote down what I was willing and not willing to share, along with quotes I could recite verbatim."

4. **The "energy for a few weeks" line is real.** Alisa: "Putting in energy here for a few weeks can, literally, be equivalent to years of work at the initial offer."

### What to Negotiate (in order of impact)

1. **Base salary** — easiest to negotiate, lowest impact
2. **Sign-on bonus** — easier than base, often negotiable as a one-time payment
3. **Equity/RSUs** — usually has more room than base, but volatile
4. **Level/title** — affects every future offer; ask for this first if you're underleveled
5. **Start date** — easy to negotiate, can buy yourself 4-12 weeks of paid time off
6. **Relocation package** — if applicable, often flexible
7. **Remote/hybrid policy** — increasingly negotiable
8. **Team assignment** — can matter more than money for day-to-day happiness

### Scripts That Work

- "I'm really excited about this role, and I have a competing offer at $X. Is there any flexibility on the base or sign-on to close the gap?"
- "Based on my market research and competing offers, I was expecting a base closer to $X. Can you help me get there?"
- "I love the team and the work. The only thing holding me back is the overall package. What flexibility do you have on sign-on or equity?"
- "I'd like to take a few days to think it over and discuss with my family. Can we push the decision deadline to [date 7-10 days out]?"

### What NOT to Do

- Don't lie about competing offers. Recruiters compare notes.
- Don't accept the first number out of fear. Silence is fine — they expect you to think.
- Don't negotiate more than 2-3 rounds. After that you're just being annoying.
- Don't take back a yes. Once you accept, stop.
- Don't badmouth the other company. Always frame as "excited about you, but the overall package is the issue."

---

## Resources — What to Use

From Alisa's appendix + my additions for your profile:

### Coding Patterns
- **LeetCode 75 / NeetCode Blind 75** — the canonical 75-question list. You're past this; do it for warmup
- **Your Coding Interview Prep folder** — 19 articles covering every pattern. Your secret weapon

### ML Coding
- **Stanford CS336: Language Modeling from Scratch** — Alisa's #1 recommendation. Implement a transformer, do the homework
- **The Illustrated GPT-2** — visual walkthrough of the architecture
- **Self-Attention & Transformers** (blog) — cleanest explanation of attention
- **Backpropagation** (blog) — when asked to derive backward pass from scratch

### ML Breadth
- **How to Scale Your Model** (the JD on training infra) — distributed training overview
- **Introduction to Policy Gradient for LMs**
- **Lightweight Guide to GRPO and RL principles**
- **arXiv: "Attention is All You Need"** — know this paper inside-out
- **arXiv: "Scaling Laws for Neural Language Models"** (Kaplan) and Chinchilla paper
- **arXiv: "LLaMA" / "LLaMA 2" / "Mistral 7B"** — modern architecture details

### System Design
- **Your System Design folder** — 30+ articles. Strongest asset
- **"Designing Data-Intensive Applications"** by Martin Kleppmann — bible of distributed systems
- **Alex Xu's "System Design Interview" Vol 1 & 2** — for the basics you might be rusty on

### Behavioral
- **"Cracking the PM Interview"** and **"Cracking the Coding Interview"** have good behavioral sections despite the names
- Write your stories in a doc. Re-read them weekly. Practice telling them to a friend.

---

## Gaps in Your Current Prep (and How to Fill Them)

After comparing Alisa's post with what's in your vault, here's what stands out:

| Gap | Why it matters | Suggested action |
|-----|---------------|------------------|
| **ML coding (PyTorch)** | Biggest missing category — implement architectures from scratch | Create a new doc: "ML Coding Interview Prep" with PyTorch implementations of transformer, attention, training loop, generation, RoPE, KV cache, BPE tokenizer |
| **Behavioral interview** | Alisa failed her first one for not preparing — don't repeat her mistake | Create a "Behavioral Stories" doc with STAR stories from your career |
| **ML breadth (rapid-fire)** | "What is 5D parallelism?" type questions | Create a "ML Knowledge Q&A" doc with 50+ rapid-fire questions and answers |
| **Research/project pitch** | Need 60s/3min/10min versions of your 4 main projects | Create a "Project Pitches" doc with all variants |
| **Negotiation playbook** | Critical, not covered in your prep | Already covered in this doc; could be expanded into a standalone "Negotiation Guide" if useful |
| **Practice partner/mock interviews** | Knowing != performing under pressure | Schedule 3-5 mock interviews with friends or paid services (Pramp, IGotAnOffer, etc.) |
| **Network mapping** | Warm intros are the highest-leverage activity | Create a doc listing 30-50 ex-colleagues with their current companies and your last contact date |

---

## Two New Articles to Create (Recommended)

Based on this analysis, I'd suggest adding:

1. **"ML Coding Interview Prep (PyTorch)"** — Implement these from scratch until you can do it cold:
   - Multi-head self-attention (with causal mask)
   - Transformer decoder block
   - Cross-entropy loss
   - BPE tokenizer
   - AdamW optimizer
   - Training loop (forward, loss, backward, step, clip)
   - Generation loop (greedy + top-p sampling)
   - RoPE positional encoding
   - KV cache
   - RMSNorm

2. **"Behavioral Stories Bank"** — 10-15 STAR stories from your career, each mapped to common behavioral questions. Write them now, not when you're interviewing.

Want me to create either or both? They would close the biggest gaps identified.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Typical loop: recruiter screen → phone/online assessment → onsite (3-5 rounds: coding, system design, behavioral).
- Communicate your thinking throughout — interviewers evaluate process, not just result.
- Ask clarifying questions before coding. If stuck, explain what you're considering.
- Always state time/space complexity.

**Common Follow-Up Questions:**
- "What if you don't know the answer?" — Say "I haven't seen this exact problem, but here's how I'd approach it." Then start with a brute force and optimize. Interviewers prefer a candidate who reasons through a novel problem over one who recites a memorized solution.
- "How do you handle behavioral questions?" — STAR method: Situation, Task, Action (what YOU did), Result (quantified). Prepare 5-7 stories covering different competencies.

**Gotcha:** Going silent while thinking. Interviewers can't evaluate your reasoning if you don't verbalize it. Talk through your approach, even if you're not sure it's right.
