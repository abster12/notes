---
title: "Chaos Engineering (Failure Injection, Game Days)"
type: system-design
category: Platform
date: 2026-06-06
tags: [system-design, interview, platform, chaos-engineering, resilience, sre, failure-injection]
aliases: ["Chaos Engineering", "Failure Injection", "Game Days", "Chaos Mesh", "LitmusChaos"]
---

# Chaos Engineering (Failure Injection, Game Days)

> **Staff-Engineer Focus:** Chaos Engineering is not "break things randomly and see what happens." It's a disciplined, hypothesis-driven approach to proactively discovering systemic weaknesses before they become outages. At the staff level, you're designing the safety mechanisms — blast radius controls, automated halting, and observability integration — that make chaos experiments *safe to run in production*. The interview question isn't "what is Chaos Engineering" — it's "how would you introduce chaos practices to a team that's never done them, without causing an incident?"

---

## Summary & Interview Framing

The practice of deliberately injecting failures into production to discover weaknesses before users do, using controlled experiments with bounded blast radius. It uses hypothesis-driven experiments, automated halting, and blast radius controls to safely test resilience in production environments.

**How it's asked:** "How would you introduce chaos engineering to a team running 200 microservices? Design the safety controls, experiment framework, and escalation policy."

---

## 1. What Problem Does Chaos Engineering Solve?

Traditional testing catches *known unknowns* — unit tests verify known logic, integration tests verify known interfaces. But distributed systems fail in ways no one predicted:

- A misconfigured firewall rule drops 3% of packets between two services — retries amplify it to a cascade
- A DNS TTL expiry lines up exactly with a deployment, causing half the fleet to resolve stale IPs
- A GC pause on one Kafka broker causes a consumer group rebalance that overwhelms ZooKeeper

**These are unknown unknowns.** Chaos Engineering is the practice of experimenting on a system to build confidence in its ability to withstand turbulent conditions in production. It turns assumptions ("our circuit breaker will handle this") into verified knowledge.

### The Core Premise

```
You don't know your system is resilient.
You only believe it is.
Chaos Engineering proves which beliefs are correct.
```

---

## 2. The Five Principles of Chaos Engineering

| # | Principle | Meaning |
|---|-----------|---------|
| 1 | **Define "steady state"** | What does "healthy" look like? Measurable output: error rate, latency p99, throughput, business metrics. |
| 2 | **Hypothesize steady state will continue** | "If we kill one Cassandra node, p99 latency will stay under 200ms" — this is a falsifiable prediction, not a guess. |
| 3 | **Introduce real-world events** | Kill nodes, inject latency, exhaust disk, corrupt packets. Do things that actually happen in production. |
| 4 | **Disprove the hypothesis** | The goal is to FIND a deviation from steady state. If nothing breaks, you didn't learn anything — try harder. |
| 5 | **Minimize blast radius** | Start small. One pod. One AZ. One percentage of traffic. Never experiment on "everything" at once. |

**The critical shift:** Chaos Engineering is NOT a testing framework. It's a **scientific method applied to distributed systems.** You form a hypothesis, design an experiment, measure the result, and refine your model.

---

## 3. The Chaos Engineering Maturity Model

Teams don't start at "injecting production failures." They progress through maturity stages:

| Stage | Name | What Happens | Risk Level |
|-------|------|-------------|------------|
| 1 | **None** | No chaos experiments | Blind to systemic risk |
| 2 | **Ad-hoc** | One engineer manually kills a pod in staging to see what happens. No process. | Low value, no repeatability |
| 3 | **Pre-Production** | Automated experiments run in staging. Scheduled weekly. Results documented. Post-mortems for findings. | Safe but limited — staging ≠ production |
| 4 | **Production (controlled)** | Experiments run in production with tight blast radius (1% traffic, one AZ, auto-halt if SLOs breach). Game Days involve the full team. | Real findings, requires observability maturity |
| 5 | **Continuous** | Experiments run as part of CI/CD. Every deploy triggers a chaos suite. Failures block promotion. | Maximum confidence, requires full automation |

**Interview nuance:** Most companies are at Stage 3. When they ask "have you done Chaos Engineering?", they're asking if you can take them to Stage 4. The answer should show you understand the *progression* — not just the tools.

---

## 4. Failure Injection Categories

Chaos experiments fall into four categories. A mature program covers all of them:

### 4.1 Infrastructure-Level Failures

| Failure Mode | Injection Method | Real-World Trigger |
|-------------|-----------------|-------------------|
| Node death | Terminate EC2 instance / kill kubelet | Hardware failure, spot interruption |
| Network partition | iptables DROP rules | Misconfigured security group, switch failure |
| Network latency | `tc` (traffic control) — add 100ms+ delay | Cross-region degradation, noisy neighbor |
| Packet loss / corruption | `tc` — 3-10% packet loss | Faulty NIC, saturated link |
| Disk failure / fill | `dd` fill disk, inject I/O errors | Log rotation failure, runaway process |
| DNS failure | Poison /etc/hosts, hijack DNS responses | DNS provider outage |
| Clock skew | `adjtimex` / `timedatectl` drift | NTP failure, leap second bugs |
| CPU / Memory pressure | Stress-ng, cgroup limits | Memory leak, noisy co-tenant |

### 4.2 Application-Level Failures

| Failure Mode | Injection Method | Real-World Trigger |
|-------------|-----------------|-------------------|
| Downstream timeout | Proxy that delays responses beyond configured timeout | Cascading latency |
| Exception injection | Middleware that throws on N% of requests | Unhandled edge case, null pointer |
| Connection pool exhaustion | Hold connections open, don't release | Memory leak in pool implementation |
| TLS certificate expiry | Short-lived test cert | Expired certs (happens quarterly at scale) |
| Response corruption | Headers truncated, JSON malformed | Proxy bug, encoding error |

### 4.3 Data-Layer Failures

| Failure Mode | Injection Method | Real-World Trigger |
|-------------|-----------------|-------------------|
| Primary DB failover | Trigger manual/automated failover | AZ outage |
| Read replica lag | Inject replication delay | Heavy write load, network partition |
| Cache eviction storm | Flush Redis / invalidate keys | Deployment, TTL cliff |
| Thick index / dead tuples | Rapid INSERT + DELETE in PostgreSQL | Autovacuum lag |
| Kafka partition reassignment | Trigger consumer group rebalance | New consumer joining, broker restart |

### 4.4 Human-Process Failures

This is the most overlooked category — and the one that separates staff engineers from seniors:

| Failure Mode | Simulation | Why It Matters |
|-------------|-----------|----------------|
| Misconfiguration | Someone applies `replicas: 1` instead of `replicas: 3` | Configuration is the #1 cause of outages (not bugs) |
| Fat-finger deployment | Deploy to wrong environment, wrong version | No amount of testing prevents operator error |
| Runbook ambiguity | Give a runbook step that's deliberately vague | If your runbook requires judgement under stress, it will fail |
| Alert fatigue | Inject a failure DURING an active incident | Most incidents happen when the on-call is already context-switched |

---

## 5. Tooling Landscape

### 5.1 Chaos Mesh (CNCF Incubating — Kubernetes-Native)

```yaml
# Example: NetworkChaos — inject 100ms latency to payment-service
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: payment-latency-experiment
spec:
  action: delay
  mode: fixed-percent
  value: "10"           # 10% of pods
  selector:
    namespaces:
      - production
    labelSelectors:
      app: payment-service
  delay:
    latency: "100ms"
    jitter: "20ms"
  duration: "5m"
  scheduler:
    cron: "@every 1h"   # recurring experiment
```

**Strengths:** Deep Kubernetes integration, CRD-based (GitOps compatible), rich failure types (PodChaos, NetworkChaos, StressChaos, DNSChaos, IOChaos, TimeChaos, HTTPChaos, AWSChaos, GCPChaos). Dashboard for visualizing experiments.

### 5.2 LitmusChaos (CNCF Incubating — Cloud-Native)

```
Litmus approach:
  ChaosHub (marketplace of experiments)
    ↓
  ChaosWorkflow (Argo-based orchestration)
    ↓
  ChaosExperiment (CR — what to break)
    ↓
  ChaosEngine (CR — where to break it)
    ↓
  ChaosResult (CR — what happened)
```

**Strengths:** GitOps-native, "ChaosHub" with 60+ pre-built experiments, integration with Harness/Argo for progressive delivery gating. Best for teams already invested in the CNCF ecosystem.

### 5.3 Gremlin (SaaS — Multi-Platform)

**Strengths:** Works across Kubernetes, VMs, bare metal. "Scenarios" — pre-built multi-step experiments. "Status Checks" — automatic pre-experiment health validation and auto-halt. Best for organizations that span Kubernetes + legacy infra.

### 5.4 AWS Fault Injection Simulator (FIS — Managed)

**Strengths:** Deep AWS integration (RDS failover, AZ evacuation, EBS volume degradation, EC2 termination with spot interruption simulation). IAM-controlled blast radius. Best for AWS-only shops that want zero infrastructure to manage.

### 5.5 Netflix's Internal Tooling (Historical Reference)

Netflix open-sourced the original Chaos Monkey, but their internal platform evolved far beyond it:

- **Chaos Monkey:** Randomly terminates instances (the original)
- **Chaos Kong:** Simulates entire region loss
- **Failure Injection Testing (FIT):** Request-level fault injection
- **Mantis:** Streaming observability platform that validates steady state during chaos experiments

**The lesson:** Chaos Monkey is the Hello World of Chaos Engineering. If that's the only tool you mention, the interviewer knows you've never done this at scale.

### Tool Selection Decision Matrix

| Scenario | Recommended Tool |
|----------|-----------------|
| Kubernetes-only, need broad failure types | Chaos Mesh |
| Kubernetes-only, want pre-built experiments + GitOps | LitmusChaos |
| AWS-only, want zero infrastructure | AWS FIS |
| Multi-platform (K8s + VMs + bare metal) | Gremlin |
| Custom failure injection in application code | In-house library (e.g., middleware that throws on N% of requests) |

---

## 6. Game Days — Structured Chaos at Scale

A **Game Day** is a scheduled, cross-team exercise where a real (or simulated) incident is injected into the system and the team responds as if it's real. It's the **capstone** of a Chaos Engineering program.

### The Game Day Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│  PHASE               │  ACTIVITY                                 │
├──────────────────────┼───────────────────────────────────────────┤
│  1. DESIGN           │  Select scenario, define steady-state     │
│                      │  metrics, set blast radius, write         │
│                      │  rollback procedure. Get sign-off.        │
│                      │                                           │
│  2. COMMUNICATE      │  Notify all teams: "Game Day: Friday      │
│                      │  10-12 PST. Scenario: AZ failure in       │
│                      │  us-east-1. On-call responds normally."   │
│                      │                                           │
│  3. INJECT           │  At T-0, execute the failure. Don't       │
│                      │  announce what was injected — let the      │
│                      │  team's observability catch it.           │
│                      │                                           │
│  4. OBSERVE          │  Does the team detect the issue? How      │
│                      │  long (TTD — Time to Detect)? Do they     │
│                      │  follow the runbook?                      │
│                      │                                           │
│  5. HALT (if needed) │  If SLOs breach beyond blast radius,      │
│                      │  or TTR > threshold — STOP. Immediately.   │
│                      │                                           │
│  6. DEBRIEF          │  Same day. What worked? What was broken   │
│                      │  that we didn't inject? What runbook      │
│                      │  steps were wrong?                        │
│                      │                                           │
│  7. ACTION ITEMS     │  Concrete tickets. No "investigate" —     │
│                      │  specific: "Add p99 latency alert for     │
│                      │  payment-service with 5-minute window."   │
└─────────────────────────────────────────────────────────────────┘
```

### Classic Game Day Scenarios

| Scenario | What You Inject | What You're Testing |
|----------|----------------|---------------------|
| **AZ Failure** | Block all traffic to us-east-1a | Multi-AZ failover, load balancer health checks, DNS TTL |
| **DB Primary Crash** | Kill RDS writer instance | Failover time, connection retry logic, stale connection cleanup |
| **Cascading Latency** | Add 2s latency to a downstream dependency | Circuit breaker opens? Retries amplify? Timeout budgets hold? |
| **Secrets Rotation** | Rotate DB credentials mid-traffic | Connection pool handles rotation? No dropped requests? |
| **Runaway Deployment** | Deploy version with 500ms extra latency | Canary analysis catches it? Automatic rollback fires? |
| **DNS Poisoning** | Return wrong IPs for internal service | Service discovery recovers? Health checks catch bad endpoints? |
| **"On-Call is Drunk"** | Page the on-call at 2am for a simulated outage | Runbooks work under fatigue? Escalation path clear? |

---

## 7. Safety Mechanisms — Running Chaos in Production

This is where staff engineers earn their title. Running chaos in production without safety is malpractice.

### 7.1 Blast Radius Controls

```
Level 0: 1 pod, 1% traffic shadowed
Level 1: 1 pod, 1% live traffic
Level 2: 10% of pods, 1 AZ
Level 3: Full AZ
Level 4: Multi-AZ (rare, always with Game Day oversight)
```

**Rule:** Never advance to Level N+1 until Level N has run clean for 2+ cycles.

### 7.2 Automatic Halting (The "Big Red Button")

Every chaos experiment MUST have a halt condition that triggers automatically:

```yaml
# Chaos Mesh example — halt if SLO breaches
spec:
  scheduler:
    cron: "@every 1h"
  duration: "5m"
  # --- Halt conditions ---
  conditionalScope:
    - name: "halt-on-slo-breach"
      expr: |
        error_rate > 0.01 OR p99_latency > 500ms OR
        cpu_usage > 90%
      action: "recover"  # immediately rollback experiment
```

The halt condition should be checked BEFORE the experiment starts ("are we healthy?") and CONTINUOUSLY during execution. If the experiment itself triggers the halt, it's immediately rolled back — the system is worse off than you thought.

### 7.3 Graduated Rollout of Experiments

```
Week 1-2:  Staging only, 1 pod, 0% live traffic (shadow)
Week 3-4:  Staging, 10% of pods, 1% live traffic
Week 5-6:  Production, 1 canary pod, 0.1% traffic
Week 7-8:  Production, 10% of pods, 1% traffic
Week 9+:   Production, full AZ, 100% traffic in that AZ (Game Day only)
```

### 7.4 Observability Integration

You cannot do Chaos Engineering without production-grade observability:

| Signal | What You're Watching |
|--------|---------------------|
| **SLO Breach** | Error rate > error budget burn rate |
| **p99 Latency** | Degradation beyond baseline |
| **Throughput** | Drop in successful requests/sec |
| **Resource Saturation** | CPU, memory, disk, connections approaching limit |
| **Business Metrics** | Orders/minute, signups/minute — the real measure of user impact |
| **Chaos-Specific Metrics** | TTD (Time to Detect), TTR (Time to Recover), MTBF impact |

**Critical:** If your observability can't tell you DURING the experiment whether the system is healthy, you have no business running chaos in production. Observability maturity must precede chaos maturity.

---

## 8. Integrating Chaos into CI/CD

The highest maturity level: chaos as a deployment gate.

```
PR Merge → Build → Deploy to Staging → Chaos Suite (Staging) → PASS?
                                                        ↓ YES
                                              Deploy Canary (Prod)
                                                        ↓
                                              Chaos Suite (Canary, Prod)
                                                        ↓
                                              PASS? → Promote to Full Prod
                                              FAIL?  → Automatic Rollback
```

**Chaos suite examples as CI/CD gates:**

```yaml
# Hypothetical pipeline config
chaos_gates:
  staging:
    - name: "kill-one-pod"
      type: PodChaos
      duration: 2m
      steady_state: "error_rate < 0.01 AND p99_latency < 300ms"
    - name: "network-latency-50ms"
      type: NetworkChaos
      duration: 3m
      steady_state: "error_rate < 0.01 AND p99_latency < 500ms"

  canary:
    - name: "kill-one-az-cassandra-node"
      type: PodChaos
      selector: "app=cassandra"
      duration: 5m
      steady_state: "availability > 99.9%"
      blast_radius: "one AZ, 0.1% production traffic"
```

**The staff-level decision:** Not every service needs chaos gates. Start with Tier 1 services (payment, auth, core data path). A chaos gate that takes 15 minutes for a 300-microservice deploy adds 75 hours of pipeline time. Gate selectively.

---

## 9. Common Pitfalls

1. **"We'll run Chaos Monkey in production next sprint."** No — Chaos Monkey is the END of a maturity journey, not the beginning. Start with pre-production, single-pod, automated halt. The PR value of "we randomly killed a pod and nothing broke" is zero if you can't measure steady state.

2. **No steady-state definition.** Running `kill -9` on a random process and saying "look, it restarted" is not Chaos Engineering. It's vandalism. You must define measurable health before, during, and after.

3. **Blast radius too large, too soon.** First production experiment should affect 0.1% of traffic on a single canary pod. Not "let's see what happens if us-east-1 disappears." That's not a Game Day — that's a self-inflicted outage.

4. **No halt condition.** Chaos tool runs, SLOs breach, tool keeps running. By the time a human notices, the incident is 10 minutes old. Automatic halting is non-negotiable.

5. **Chaos Engineering as a checkbox.** "We ran 50 experiments this quarter" — but none of them tested a scenario that actually scared anyone. Volume of experiments ≠ quality of confidence. The right metric: "how many previously-unknown failure modes did we discover and fix?"

6. **Ignoring the findings.** Chaos experiment reveals that killing a Cassandra node causes 30s of elevated latency. Team says "we'll investigate." Ticket sits in backlog for 6 months. The experiment wasted everyone's time. Every finding must have a concrete action item or a documented acceptance of risk.

7. **Game Days without cross-team participation.** Only the SRE team shows up. When the failure is injected, the payment team has no idea what's happening and starts their own investigation. Game Days must include the teams that own the affected services.

8. **Testing only infrastructure failures.** 80% of outages are caused by configuration changes and deployments — not node failures. If your chaos program only kills pods, you're testing the 20% case.

---

## 10. Sharp Question + Model Answer

### The Question

> **"Your CTO read the Chaos Engineering chapter in the SRE book and wants your team to run Chaos Monkey in production next week. You're the staff engineer on the platform team. What do you do?"**

### Model Answer

**Don't refuse — redirect to a safe starting point that delivers value in 2 weeks.**

"First, I'd acknowledge that the intent is right — we should be proactively testing resilience. But I'd propose a graduated approach that gives us a win within 2 weeks while building the safety infrastructure:

**Week 1 — Observability Baseline:**
- Define steady state for our Tier 1 services: what does 'healthy' look like in numbers? (error rate < 0.01%, p99 latency < 200ms)
- Verify our dashboards can detect a failure within 60 seconds
- If they can't, Chaos Monkey will break things we can't see — that's just vandalism

**Week 2 — Pre-Production Experiment:**
- Deploy Chaos Mesh to staging
- Run ONE experiment: kill 1 pod of our payment service
- Measure TTD (Time to Detect) and TTR (Time to Recover)
- Present findings: 'Our auto-recovery took 45 seconds. Our paging took 3 minutes. Our SLO was unchanged. Here's the dashboard screenshot.'

**Week 3 — First Production Canary:**
- Same experiment, but on a single canary pod serving 0.1% of production traffic
- Halt condition: if error rate exceeds 0.01% for 30 seconds, auto-rollback
- Game Day: schedule a 1-hour window. Invite payment team, SRE team, observability team. Run the experiment. Debrief same day.

By Week 3, the CTO has a production Chaos Engineering win, the team has built confidence, and we've discovered real gaps. That's infinitely better than running Chaos Monkey on Friday at 5pm and hoping Elasticsearch survives."

### Common Pitfall

❌ **Pitfall:** "We should just run it in staging first — that's the safe way."

**Why it's wrong:** This sounds responsible, but misses the point. Staging doesn't have production traffic patterns, production data volumes, production configuration, or production alerting. You'll build false confidence. The right answer acknowledges that **production IS the target** but advocates for a controlled path to get there — not an indefinite stay in staging. The interviewer wants to hear that you understand the *progression*, not that you're avoiding production.

✅ **The fix:** "Staging is a necessary stepping stone for tooling validation and team readiness, but our goal is production within 3 weeks, using canary pods and automatic halt conditions as our safety net."

---

## 11. Interview Curveball Questions

> **"What's the difference between Chaos Engineering and fault injection testing?"**

**Answer:** Fault injection testing is a specific technique — you know the fault you're injecting and you're verifying a known behavior ("if I kill this pod, Kubernetes reschedules it within 30s"). Chaos Engineering is the broader practice — you hypothesize about system behavior under turbulent conditions, and you may not know exactly what will happen. Fault injection is a tool IN the Chaos Engineering toolbox. Every chaos experiment uses fault injection, but not every fault injection test is a chaos experiment (because it may lack the hypothesis-driven, steady-state-measured scientific method).

> **"Your chaos experiment caused a real production incident. The VP of Engineering wants to shut down the program. What's your response?"**

**Answer:** (1) Take full accountability — the experiment's blast radius or halt condition wasn't conservative enough. That's a process failure, not a concept failure. (2) Present the incident timeline: the experiment revealed a previously-unknown failure mode that WOULD have caused an outage eventually (during a real AZ failure, for example). The experiment turned a future P0 outage into a contained, reversible incident. (3) Propose concrete safety improvements before the next experiment: smaller blast radius, lower traffic %, faster automatic halt threshold. (4) Ask: "Would you rather discover this failure mode during a scheduled experiment with the team watching, or at 3am on a Saturday?"

> **"How is Chaos Engineering different from just having good integration tests?"**

**Answer:** Integration tests verify expected behavior under known conditions. Chaos Engineering explores UNEXPECTED behavior under UNKNOWN conditions. An integration test says "when service A calls service B, the response is valid JSON." A chaos experiment says "what happens when service B responds with valid JSON but takes 5 seconds instead of 50ms — does service A's thread pool exhaust? Does the circuit breaker open? Does the retry storm cascade to service C?" Integration tests and chaos experiments are complementary: tests verify correctness, chaos verifies resilience.

> **"When should you NOT do Chaos Engineering?"**

**Answer:** (1) When you can't measure steady state — without observability, you can't know if you broke anything. (2) When you have no automated recovery — if a human has to wake up and fix every failure, chaos experiments just create toil. (3) When your MTTR (Mean Time to Recovery) is measured in hours — chaos experiments with multi-hour recovery windows are irresponsible. (4) When the system is already unstable — don't inject chaos into a burning building. (5) For systems with irreversible side effects (firing missiles, dispensing medication, transferring money without idempotency) — chaos in these domains requires extraordinary safeguards beyond standard practices.

---

## 12. Key Metrics for a Chaos Program

| Metric | Definition | Target |
|--------|-----------|--------|
| **TTD** | Time to Detect — how long from injection to alert fire | < 60s |
| **TTR** | Time to Recover — how long from alert to steady state restored | < 5min (automated) |
| **Experiments/Week** | Volume of experiments across services | Growing, not fixed |
| **Findings/Action Ratio** | % of experiment findings that become concrete action items | > 80% |
| **False Confidence Rate** | Experiments that passed but would have failed in a real scenario | Trending to 0 |
| **Blast Radius Incidents** | Experiments that breached their blast radius | 0 (halt condition should prevent this) |

---

## Key Takeaway

**Chaos Engineering is the scientific method applied to distributed systems resilience.** It's not about randomly breaking things — it's about forming hypotheses about system behavior, designing controlled experiments with measurable steady-state criteria, and using the results to harden the system before real failures expose the same weaknesses. The staff-level skill is designing the *safety scaffolding* — blast radius controls, automatic halt conditions, graduated rollout, and observability integration — that makes chaos experiments net-positive for reliability instead of net-negative. A team that runs chaos experiments without safety mechanisms isn't doing Chaos Engineering; they're doing vandalism with a PR-friendly name.

---

## Related
- [[topic-queue]]
- [[Metrics & Monitoring (Prometheus-Grafana)]]
- [[Kubernetes Scheduler & Control Plane Internals]]
- [[Service Mesh (Istio-Linkerd)]]
- [[Circuit Breakers & Bulkheads]]
- [[Weakness Vault/Day-34-Chaos-Engineering]]

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Chaos engineering is hypothesis-driven, not random — you start with "what should stay stable if X fails" and test it
- Blast radius must be bounded — start in staging, limit to one service, auto-halt on SLO breach
- Game days are organizational rehearsals — they surface both technical and human/process gaps
- Failure injection types: kill process, kill node, network latency/loss, CPU starvation, disk fill, dependency outage
- Observability is the prerequisite — you can't run chaos without dashboards, alerts, and SLOs already in place

**Common Follow-Up Questions:**
- "How do you get buy-in for chaos in production?" — Start with staging, show the incidents it would have prevented, automate halting, and begin with low-risk experiments during business hours.
- "What's the difference between chaos engineering and load testing?" — Load testing checks if the system handles expected traffic; chaos engineering checks if the system survives unexpected failures.

**Gotcha:**
- Running chaos experiments without automated halting is not chaos engineering — it's just breaking things. The safety controls (blast radius limits, auto-halt, rollback) ARE the chaos engineering discipline.
