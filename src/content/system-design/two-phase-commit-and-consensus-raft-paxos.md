---
title: "Two-Phase Commit & Consensus (Raft/Paxos)"
type: system-design
category: Advanced
date: 2026-05-22
tags: [system-design, interview, advanced, consensus, 2pc, 3pc, raft, paxos, distributed-systems, cap, linearizability]
aliases: [2PC, 3PC, Raft, Paxos, distributed consensus, atomic commit]
---

# Two-Phase Commit & Consensus (Raft/Paxos)

## Summary & Interview Framing

Algorithms for distributed agreement — 2PC coordinates atomic commits (blocking), Raft provides leader-based consensus (understandable), Paxos provides the same guarantees (proven but complex).

**How it's asked:** "Design a consensus system for a 5-node cluster that survives 2 failures. Compare 2PC, Raft, and Paxos. Handle leader election, log replication, and the blocking problem in 2PC."

---

## Overview

Distributed consensus is the problem of getting multiple independent nodes to agree on a single value—or, more powerfully, on an ordered sequence of values—despite process crashes, unreliable networks, and the absence of a global clock. It is the load-bearing wall underneath almost every reliable distributed system: replicated state machines, configuration management, leader election, distributed locks, and atomic transaction commit all reduce to some flavor of consensus. Two-Phase Commit (2PC) solves the narrowest version of this problem—atomicity of a transaction across participants—while Paxos and Raft solve the broader and more useful version: agreeing on a durable, totally-ordered log that survives failures and keeps serving. The conceptual leap worth memorizing is that 2PC optimizes for *safety under a trusted coordinator*, whereas Paxos/Raft optimize for *safety under an untrusted, failure-prone, leaderless (but eventually leaderful) ensemble*. 2PC is a *blocking* atomic-commit protocol; Raft and Paxos are *non-blocking* consensus protocols that can make progress as long as a majority of nodes are alive and reachable.

## The Core Distinction

When interviewers probe this topic they are usually testing whether you understand that "commit" and "consensus" are different abstractions layered on top of the same fundamental impossibility result. Atomic commit answers a yes/no question—*did every participant durably prepare to commit this transaction?*—and a single NO vote forces a global abort. Consensus answers a broader question—*what value should the group decide, given that multiple proposers may propose different values?*—and guarantees that a quorum can decide even when some nodes are down or partitioned. The FLP impossibility result (Fischer, Lynch, Paterson, 1985) proves that no deterministic asynchronous protocol can guarantee both safety and liveness if even a single process may fail; practical systems escape this by leaning on timing assumptions (partial synchrony, as in Paxos/Raft's leader leases and election timeouts) and randomization. 2PC sidesteps FLP only by sacrificing liveness whenever the coordinator or any participant fails in a bad window, which is precisely its Achilles heel.

---

## Part 1: Two-Phase Commit (2PC)

### The Protocol in Detail

2PC assumes a distinguished *coordinator* (often the node that initiated the transaction) and a set of *participants* holding resource managers for the touched data. The goal is all-or-nothing atomicity: either every participant commits, or every participant aborts. The protocol proceeds in two phases with a hard synchronization barrier between them.

In the **prepare phase** (also called the voting phase), the coordinator sends a `PREPARE` (or `VOTE_REQUEST`) message to every participant. Each participant must decide, locally and durably, whether it *can* commit its piece of the transaction: it runs conflict checks, acquires any remaining locks, and writes a *prepare record* to its write-ahead log (WAL) so that a subsequent crash can be recovered. Crucially, once a participant votes YES, it has entered a *prepared* state in which it promises to be able to commit if asked and must hold all locks until it receives the final decision. If a participant cannot commit—say, a constraint would be violated, or a deadlock was detected—it votes NO and may unilaterally release its locks and abort. The coordinator collects votes; if even one vote is NO, or if any participant times out, the global decision is ABORT.

In the **commit phase** (the decision phase), the coordinator writes a *global decision record* to its own log (this is the commit point of no return), then broadcasts `COMMIT` or `ABORT` to all participants. Each participant applies the decision durably, releases its locks, and replies `ACK`. Once the coordinator has received all ACKs it can garbage-collect the transaction's metadata. The durable log entries are what make 2PC crash-recoverable: a restarting participant that finds a prepared-but-undecided record in its WAL must contact the coordinator (or a recovery coordinator) to learn the decision, and a restarting coordinator that finds a decision record must retransmit it to any participant that never ACKed.

### 2PC Phase Diagram

The diagram below shows both phases of 2PC, including the durable log writes that make the protocol crash-recoverable and the blocking window that is its fatal weakness.

```
  COORDINATOR                              PARTICIPANTS
  (writes decision log)                    (P1, P2, P3)
  ============                             ============

  ┌─────────────┐
  │  TX start    │
  └──────┬──────┘
         │
  ═══════╪═══════════════════════════════════════════════════
  PHASE 1│: PREPARE / VOTE (voting phase)
  ═══════╪═══════════════════════════════════════════════════
         │  ──── PREPARE (can you commit?) ────────────────►  P1,P2,P3
         │                                                  ┌──────┐
         │                                                  │ lock │
         │                                                  │ prep │ ← WAL write
         │                                                  │ rec  │   (durable)
         │                                                  └──────┘
         │  ◄──── YES / NO votes ─────────────────────────  P1,P2,P3
         │
  ┌──────┴──────┐
  │ ALL YES?     │─── no ──►  global decision = ABORT
  └──────┬──────┘
         │ yes
         │
  ═══════╪═══════════════════════════════════════════════════
  PHASE 2│: COMMIT / ABORT (decision phase)
  ═══════╪═══════════════════════════════════════════════════
  ┌──────┴──────┐
  │ write DECISION│ ← WAL write (commit point of no return)
  │ record to log │
  └──────┬──────┘
         │  ──── COMMIT (or ABORT) ─────────────────────►  P1,P2,P3
         │                                                  ┌──────┐
         │                                                  │apply │
         │                                                  │release│
         │                                                  │locks │ ← WAL write
         │                                                  └──────┘
         │  ◄──── ACK ────────────────────────────────────  P1,P2,P3
         │
  ┌──────┴──────┐
  │ all ACKs in? │─── yes ──►  GC transaction metadata
  └─────────────┘

  ⚠ BLOCKING WINDOW: if coordinator crashes AFTER participants
    vote YES but BEFORE broadcasting COMMIT, every prepared
    participant is locked indefinitely — cannot commit, cannot abort.
```

### The Blocking Problem

The fatal weakness of 2PC is that it is a *blocking* protocol. The blocking arises from the prepared-state promise: a participant that voted YES has staked its locks and resources on a future decision it cannot make itself. If the coordinator crashes after some participants have voted YES but before broadcasting the decision, every prepared participant is *blocked*—it cannot commit (it does not know whether everyone else voted YES) and cannot abort (it promised to honor a possible COMMIT). Those participants hold their locks indefinitely, and any other transaction touching the same data is stalled behind them. This is not a transient hiccup; it is an indefinite liveness violation that persists until the coordinator is repaired or a recovery coordinator is elected and the decision log is consulted. The duration of the block is bounded only by human-mediated recovery, not by any protocol timeout, because the protocol cannot safely distinguish "coordinator crashed" from "coordinator is slow." Even a *presumed abort* optimization (recording fewer log records on the abort path) does not solve the prepared-but-undecided window; it only makes the abort path cheaper.

### Coordinator Failure and Recovery

Coordinator failure is the canonical failure scenario and the one interviewers will press on. The standard mitigation is to make the coordinator's decision log itself replicated, so a *backup coordinator* can read the decision record and continue the protocol. But this just pushes the consensus problem one level down: how do you replicate the coordinator's log safely? You need Paxos or Raft—which is why real systems rarely use a bare 2PC coordinator; instead, the coordinator's role is itself implemented atop a consensus-replicated log (XA transaction managers integrated with a highly-available coordinator service, or, in cloud databases, a consensus group acting as the transaction manager). Another mitigation is a *coordinator recovery protocol*: a blocked participant can query other participants; if any voted NO, the decision must be ABORT; if the coordinator's replicated log says COMMIT, the decision is COMMIT. But if *all* participants are prepared and the coordinator's log is lost, no participant has enough information to decide, and the transaction stays blocked forever. This is the irreducible core of the 2PC blocking problem: **the protocol preserves safety by sacrificing liveness during coordinator failure in the prepared window.**

### When 2PC Is Actually Used

Despite its weaknesses, 2PC remains the gold standard for *atomic commit across independent resource managers* where the participants are not part of a single replicated log—classic examples are XA transactions spanning a relational database and a message broker, or sharded databases (MySQL XA, PostgreSQL two-phase commit) where each shard is an independent database. The performance cost is real: 2PC adds at least two extra forced log writes per participant (the prepare record and the commit record) plus a global round-trip, roughly tripling commit latency versus a single-node transaction. Engineers tolerate this when the alternative—losing atomicity across heterogeneous systems—is worse. Inside a single consensus-replicated system (Spanner, CockroachDB, FoundationDB), the transaction commit protocol is integrated with the consensus layer so that the "coordinator" is a Paxos/Raft group, eliminating the single-coordinator blocking failure mode while preserving 2PC's all-or-nothing semantics.

---

## Part 2: Three-Phase Commit (3PC)

### The Idea

Three-Phase Commit was proposed (Skeen, 1982) specifically to fix the blocking problem of 2PC by inserting an extra round that makes the protocol *non-blocking under fail-stop assumptions with synchronized clocks*. The key insight is that if every participant can determine, *without* contacting the coordinator, what state the protocol was in when the coordinator failed, then a blocked participant can make the safe decision locally. 3PC adds a `PRE_COMMIT` (or "prepare to commit") phase between voting and the final commit: after the coordinator learns that everyone voted YES, it sends a `PRE_COMMIT` telling participants to get ready to commit, and only after receiving ACKs does it send the final `COMMIT`. The crucial property is that the pre-commit phase is reached only after every participant has already voted YES and is prepared, so once any participant has seen `PRE_COMMIT`, the transaction *must* commit—there is no path to abort anymore.

### Why It Helps (and Why It Doesn't in Practice)

Under the assumptions of *synchronous* (bounded-delay) networks and *fail-stop* (crash, not Byzantine) failures with crash detection, 3PC is non-blocking: a participant that times out can look at its own local state. If it never voted YES, abort; if it voted YES but never saw `PRE_COMMIT`, it can safely abort because no participant could have committed yet; if it saw `PRE_COMMIT`, it can safely commit because the coordinator must have received all YES votes. The protocol achieves this by ensuring the decision is *predetermined* before it is *finalized*, giving every node enough local information to continue.

The catch—why 3PC is rarely deployed—is that those assumptions are unrealistic on real networks. Real networks are asynchronous and can *partition*: a participant may be unable to distinguish "the coordinator crashed" from "the network partitioned me from the coordinator." If the network partitions after some participants have received `PRE_COMMIT` but before others have, the partitioned groups can independently and incorrectly reach opposite decisions (one group commits, the other aborts), violating atomicity. This is a *safety* violation, far worse than 2PC's mere liveness violation. Consequently 3PC is mostly of historical and pedagogical interest: it illustrates how to attack the blocking problem but is unsafe in the asynchronous model that real systems operate in. Modern non-blocking commit is achieved instead by implementing the coordinator's decision log atop Paxos/Raft (so-called *Paxos commit*), which gets 3PC's liveness benefit while preserving safety under partitions.

---

## Part 3: Paxos

### The Consensus Problem Paxos Solves

Paxos, introduced by Leslie Lamport in 1989 (and made famous by the 1998 paper "The Part-Time Parliament"), solves *consensus*: a set of processes must agree on a single value out of a set of proposed values, satisfying three properties—*validity* (the decided value was actually proposed by someone), *agreement* (no two processes decide different values), and *termination* (every non-faulty process eventually decides, under partial synchrony). The protocol works in an asynchronous model with crash failures and a majority quorum, and it is provably safe under arbitrary message delays and reorderings. Paxos is famously hard to understand—a reputation Lamport himself leaned into with the parable framing—but the core is small once you separate the safety argument from the liveness argument.

### Roles: Proposer, Acceptor, Learner

Paxos separates concerns into three logical roles, which in practice may be collocated on the same nodes. The **proposer** initiates a round of consensus by suggesting a value; in a deployed system, proposers are the clients (or a leader acting on behalf of clients). The **acceptor** is the voting authority—acceptors act as a replicated, durable "memory" that records which proposals have been promised and accepted, and a value is chosen when a majority quorum of acceptors accept it. The **learner** is the passive observer that learns the chosen value once a majority has accepted it; learners do not participate in the decision but consume the result, and in practice the learner role is fused with the acceptor role so each node learns locally. The quorum requirement is what guarantees safety: because any two majorities overlap in at least one acceptor, no two different values can both be chosen by intersecting majorities.

### The Two Phases: Prepare/Promise and Accept/Accepted

Paxos runs in two phases per decided value. In **Phase 1 (Prepare/Promise)**, a proposer picks a unique, monotonically increasing *proposal number* `n` and sends `Prepare(n)` to a majority (or all) of acceptors. An acceptor responds with `Promise(n)` agreeing never to accept any proposal numbered less than `n` again; critically, if the acceptor has *already accepted* some value in a prior round, it includes the highest-numbered proposal it has accepted (with its value) in its promise. This "highest-accepted" piggybacking is the heart of the safety argument: it forces the proposer to adopt the value of the highest-numbered already-accepted proposal it sees, so that if a value was *almost* chosen in a prior round, the new round will carry that value forward rather than choosing a conflicting one. If the proposer hears from a majority, it has a *quorum* of promises and can proceed; otherwise it backs off and retries with a higher number.

In **Phase 2 (Accept/Accepted)**, the proposer takes the value of the highest-numbered accepted proposal reported in the promises (or its own proposed value if no acceptor reported any prior acceptance) and sends `Accept(n, value)` to a majority of acceptors. An acceptor accepts (durable-logs the proposal and replies `Accepted`) as long as it has not promised a higher number since; if it has, it rejects and the proposer retries. A value is *chosen* the moment a majority of acceptors have accepted it, and learners are notified (directly by the proposer, or by acceptors, or via a distinguished learner that relays the decision) so they can record it.

The protocol's correctness rests on two invariants. First, **only one value can be chosen**: any two quorum majorities overlap in at least one acceptor, and that overlapping acceptor's promise/accept history prevents two different values from both reaching majority acceptance. Second, **a value is chosen only if it was proposed**: the proposer's adoption rule ensures the decided value traces back to some original proposal. Termination (liveness) requires partial synchrony—if proposers keep colliding and raising their numbers forever (livelock), nothing is chosen, so practical Paxos elects a single distinguished proposer (a leader) to avoid contention, which is exactly what Multi-Paxos does.

### Paxos Prepare/Accept Round Diagram

The diagram below illustrates a complete Paxos round showing both phases, the promise piggybacking of prior-accepted values, and the quorum intersection that guarantees safety.

```
  PROPOSER              ACCEPTORS (A1, A2, A3)          LEARNERS
  ========              =====================          ========
                            ┌──────────────┐
                            │ A2 already    │
                            │ accepted val X│
                            │ in round n-2  │
                            └──────────────┘

  ═════════════════════════════════════════════════════════════
  PHASE 1: PREPARE / PROMISE
  ═════════════════════════════════════════════════════════════
  pick proposal #n
         │
         │── Prepare(n) ─────────────────────► A1, A2, A3
         │                                     │  A1: no prior
         │                                     │      accept → Promise(n)
         │                                     │  A2: Promise(n, n-2, X)
         │                                     │      (piggyback highest
         │                                     │       accepted: X)
         │                                     │  A3: Promise(n)
         │◄─────────────────────────────────── A1, A2, A3
         │
  majority of promises? ── no ──► retry with higher #
         │ yes
         │
  ┌──────┴──────────────────────┐
  │ pick value to propose:      │
  │  if any promise carried an  │
  │  accepted value, adopt the  │
  │  HIGHEST-numbered one (X)   │
  │  else use own proposed value│
  └──────┬──────────────────────┘
         │
  ═════════════════════════════════════════════════════════════
  PHASE 2: ACCEPT / ACCEPTED
  ═════════════════════════════════════════════════════════════
         │── Accept(n, X) ──────────────────► A1, A2, A3
         │                                     │  A1: Accept(n,X) → log → Accepted
         │                                     │  A2: Accept(n,X) → log → Accepted
         │                                     │  A3: Accept(n,X) → log → Accepted
         │◄────────────────────────────────── A1, A2, A3
         │
  ┌──────┴──────┐
  │ majority     │
  │ accepted?    │── yes ── VALUE CHOSEN = X
  └──────┬──────┘
         │
         │── Chosen(X) ────────────────────────────────────► Learners
         │                                                  record X
         │
  SAFETY: any two majorities overlap in ≥1 acceptor.
          The overlapping acceptor's promise history ensures
          no two different values can both be chosen.
```

### Multi-Paxos

Plain Paxos decides a *single* value, which is almost useless on its own. **Multi-Paxos** generalizes it to decide an ordered sequence of values—a replicated log—by recognizing that if the same stable leader runs consecutive instances, Phase 1 can be amortized: the leader runs Prepare once to establish its leadership and learn any previously-chosen (but un-announced) values, then drives Phase 2 repeatedly for each log entry without repeating Phase 1. The leader batches Accept messages and pipelines them, so each log slot costs roughly one round trip. Each log entry is a separate Paxos instance keyed by its position (slot number), and the leader assigns incoming client commands to consecutive slots. Multi-Paxos is what powers most real Paxos deployments (Chubby, Spanner's Paxos groups, PaxosStore), but Lamport's original papers left the engineering details—the leader election, the log reconciliation on leader change, the snapshotting and log truncation, the membership change—largely unspecified, which is why every Multi-Paxos implementation is slightly different and why Raft was welcomed as a comprehensible alternative.

### Paxos Variants Worth Knowing

*Fast Paxos* reduces latency by letting proposers send Accept directly to acceptors (skipping the leader round) at the cost of larger quorums and more complex recovery. *Cheap Paxos* runs the protocol with a small active set and a large set of cold standby acceptors to reduce the number of machines that must be fast. *EPaxos* (Egalitarian Paxos) avoids the leader bottleneck entirely, allowing any replica to command-lead in one round trip when there is no conflict, trading more complex conflict tracking for much better multi-region throughput. *Mencius* and *Atlas* extend this egalitarian line. For interview purposes, you should at least know that Multi-Paxos is the practical form, that it relies on a stable leader for performance, and that leader changes are the expensive, error-prone part.

---

## Part 4: Raft

### Design Philosophy

Raft (Ongaro and Ousterhout, 2014) was engineered explicitly for *understandability*. The authors observed that Paxos is correct but opaque, and that real systems built on Paxos (Chubby, Spanner) spend enormous engineering effort on the unspecified parts. Raft decomposes consensus into three clearly separated sub-problems—**leader election**, **log replication**, and **safety**—each with a simple, teachable mechanism. It shares Paxos's formal guarantees (safety under arbitrary failures, termination under partial synchrony, majority quorums) but is structured so that a single leader handles all client writes, the leader's log is the source of truth, and followers replicate it. This leader-strong design is what makes Raft easy to reason about and easy to implement correctly, and it is why etcd, Consul, CockroachDB, TiKV, and dozens of other systems adopted it.

### Leader Election

Raft clusters have a fixed membership of servers, each in one of three states: *follower*, *candidate*, or *leader*. Time is divided into *terms*, monotonically increasing integers that act as logical clock epochs; every term has at most one leader. A follower stays passive as long as it receives valid heartbeats (AppendEntries RPCs carrying no log entries) from a leader; if a follower's *election timeout* (randomized, typically 150–300ms) elapses without a heartbeat, it suspects the leader is dead, increments the term, transitions to candidate, votes for itself, and sends `RequestVote` RPCs to the rest of the cluster. A candidate that wins a *majority* of votes for its term becomes leader and immediately begins sending heartbeats to establish authority and suppress further elections.

The randomized election timeout is the key anti-livelock mechanism: by spreading timeouts across a window, Raft makes it overwhelmingly likely that exactly one candidate times out first, collects votes, and wins before others wake up. The voting rules enforce a critical safety property: a server grants its vote to at most one candidate per term, and it only votes for a candidate whose log is *at least as up to date* as its own (compared first by last log term, then by log length). This guarantees that any elected leader already contains all previously committed entries, so a new leader never has to backfill its log from followers—leadership and log completeness are coupled at election time.

### Split Vote

A **split vote** occurs when two or more candidates become candidates in the same term and each wins a partial set of votes such that no candidate reaches a majority. This is most likely in even-sized clusters (e.g., a 4-node cluster can deadlock 2-2) or when timeouts happen to align. Raft handles split votes simply and safely: because no candidate wins a majority, no leader is elected for that term, the candidates wait out their next randomized election timeout, and one of them times out first in the next term and (usually) wins cleanly. The system is briefly unavailable (no leader to serve writes) for one extra election timeout, but safety is never violated—no conflicting leader is ever elected. The randomized timeout makes repeat split votes exponentially unlikely. This is the canonical Raft failure mode and the answer to "what happens when two nodes both try to become leader."

### Split-Brain Scenario Diagram

The diagram below illustrates why split-brain (two leaders in the same term) cannot happen in Raft, and what instead happens in the related failure modes: a network partition and a split vote.

```
  ───────────────────────────────────────────────────────────────
  SCENARIO A: NETWORK PARTITION in a 5-node Raft cluster
  ───────────────────────────────────────────────────────────────

     [MAJORITY SIDE: 3 nodes]          [MINORITY SIDE: 2 nodes]
     N1(leader)  N2  N3                 N4  N5

     N1 stays leader (has majority      N4's election timer fires
     quorum = 3 of 5)                   → becomes candidate, term+1
                                         → sends RequestVote
     N1 keeps serving writes            → needs 3 votes, only 2
     N2, N3 ack AppendEntries            nodes available → STUCK
                                          → no leader elected
     ✅ Writes succeed                   ❌ Writes blocked (CP)
                                              │
     When partition heals ◄──────────────┘
     N4, N5 receive AppendEntries from N1
     → consistency check reconciles logs
     → uncommitted entries overwritten
     → N4, N5 rejoin as followers

  ───────────────────────────────────────────────────────────────
  SCENARIO B: SPLIT VOTE (even-sized cluster, 4 nodes)
  ───────────────────────────────────────────────────────────────

     Term T:  N1 and N3 both time out simultaneously
              N1 votes for self → sends RequestVote
              N3 votes for self → sends RequestVote

         N1 ←─── 1 vote (self)         N3 ←─── 1 vote (self)
         N2 → votes for N1             N4 → votes for N3

         Result: N1 has 2 votes, N3 has 2 votes
                 Majority = 3 of 4 → NO ONE WINS

     ⏳ All candidates wait randomized election timeout
     ⏳ One times out first in Term T+1
     ⏳ Wins majority cleanly → becomes leader

     ✅ Safety preserved: no conflicting leader ever elected
     ⚠ Brief unavailability: ~1 extra election timeout

  KEY INSIGHT: Raft PREVENTS split-brain by coupling the
  majority-vote requirement with the term-based epoch system.
  Two leaders in the SAME term is impossible because no single
  candidate can get a majority without overlapping votes.
  Two leaders in DIFFERENT terms: the higher-term leader's
  election is valid, but the lower-term leader is deposed
  the moment it contacts the majority.
```

### Log Replication

Once a leader is established, all client requests flow through it. The leader appends the client's command to its own log as a new entry, then sends `AppendEntries` RPCs to followers containing the entry along with the *prevLogIndex* and *prevLogTerm* of the entry immediately before it. A follower accepts the append only if its log contains an entry at prevLogIndex with the matching prevLogTerm; this consistency check is what guarantees that follower logs are *prefix-compatible* with the leader's log and with each other. If the check fails, the leader decrements nextIndex for that follower and retries, walking the log backward until it finds the point of agreement, after which it overwrites any conflicting follower entries and backfills the rest. In steady state this is a single fast round trip; on a lagging or recently-restarted follower it may take several decrements, but Raft can be optimized to send snapshots instead of replaying thousands of entries.

An entry is *committed* once the leader has replicated it to a majority of servers *and* all entries before it are also committed. The leader applies committed entries to its state machine and replies to the client. Followers learn of commits via the `leaderCommit` field piggybacked on subsequent AppendEntries, so commit propagation is piggybacked rather than explicitly acked. The leader's commit rule is the linchpin of Raft safety: a leader never commits an entry from a previous term by counting replicas alone; instead it only commits prior-term entries *indirectly* by committing a new entry from its own term that is replicated to a majority. This subtle rule (the "no-op on election" pattern in some implementations) closes the gap that could otherwise allow a committed entry to be overwritten.

### Raft Log Replication Flow Diagram

The diagram below shows the full lifecycle of a single client write through Raft log replication, from leader append through quorum replication, commit, and state machine application.

```
  CLIENT            LEADER (L)              FOLLOWERS (F1, F2, F3, F4)
  ======            ===========              =========================
                     ┌──────────────────────────────────────────┐
                     │  Log:  [1] [2] [3]   ← committed (idx 3) │
                     │                       next entry: idx 4  │
                     └──────────────────────────────────────────┘
  ── cmd=X ──►
                     │
               ┌─────┴─────┐
               │ append X   │ ← entry idx=4, term=T
               │ to own log │ ← fsync WAL (dominant cost)
               └─────┬─────┘
                     │
                     │── AppendEntries(idx=4, T, X,             F1, F2, F3, F4
                     │    prevLogIdx=3, prevLogTerm=T-1) ──────► (parallel)
                     │
                     │                    ┌─────────────────────────┐
                     │                    │ prevLogIdx/Term match?  │
                     │                    │  YES → append, fsync    │
                     │                    │  NO  → reject           │
                     │                    └─────────────────────────┘
                     │◄── ACK (idx=4) ──────────────────────────── F1 ✅
                     │◄── ACK (idx=4) ──────────────────────────── F2 ✅
                     │◄── ACK (idx=4) ──────────────────────────── F3 ✅
                     │                  (F4 slow / rejected → retry later)
                     │
               ┌─────┴──────────┐
               │ majority ack?  │  3 of 5 (leader+F1+F2+F3) = ✅
               │ → COMMIT idx=4 │  (all prior entries also commit)
               └─────┬──────────┘
                     │
               ┌─────┴──────────┐
               │ apply idx=4 to │ ← state machine
               │ state machine  │
               └─────┬──────────┘
                     │
  ◄── "committed" ──│
                     │
                     │── next AppendEntries(leaderCommit=4) ───► F1..F4
                     │    (commit index piggybacked on
                     │     subsequent RPCs — no explicit ack)
                     │                                              │
                     │                    ┌─────────────────────────┐
                     │                    │ F1..F4 apply idx=4      │
                     │                    │ to state machines       │
                     │                    └─────────────────────────┘

  LATENCY ≈ max(local_fsync, RTT_to_majority + remote_fsync)
  SAFETY:  entry committed ⟺ replicated to majority
           + all prior entries committed
```

### Safety Properties

Raft guarantees four safety properties that together imply the replicated state machine abstraction. *Leader Completeness*: if a log entry is committed in a given term, it is present in the logs of the leaders of all higher-numbered terms—this follows from the election voting rule (voters only elect leaders whose log is at least as up to date). *State Machine Safety*: if a server has applied a log entry at index i, no other server will ever apply a different entry at the same index. *Election Safety*: at most one leader per term. *Log Matching*: if two logs contain an entry with the same index and term, the logs are identical in all entries up to that index. These compose to give the strong guarantee clients care about: once a client is told its write committed, that write will be present in every future leader's log and will never be rolled back. The practical consequence is that Raft can serve linearizable reads from the leader (with a read-index or lease-based optimization) and offers exactly-once semantics when clients attach unique request IDs.

### Membership Changes and Snapshots

Real Raft systems must change cluster membership without shutting down and must compact logs that would otherwise grow unboundedly. *Joint consensus* handles membership reconfiguration in two phases: the leader proposes a joint configuration (old + new members), entries are committed under majority-of-old *and* majority-of-new quorums, and once committed the leader proposes the new-only configuration. Single-server additions/removals are simpler and can be done in one step because majorities of the old and new configurations always overlap. *Log compaction* via snapshots periodically captures the state machine state, discards the log up to the snapshot point, and lets the leader transfer the snapshot to lagging followers via `InstallSnapshot` rather than replaying millions of entries. These mechanisms are engineering essentials and frequent interview follow-ups—"what happens when a follower has been down for an hour and rejoins?" leads directly to snapshot transfer.

---

## Part 5: Consensus in Practice

### ZooKeeper (ZAB)

Apache ZooKeeper is a coordination service providing a hierarchical, wait-free data tree with watches, used for configuration, naming, distributed locks, and leader election by higher-level systems (Kafka, HBase, Solr). ZooKeeper does *not* run Paxos or Raft directly; it runs **ZAB (ZooKeeper Atomic Broadcast)**, a protocol designed by Flavio Junqueira and colleagues that shares Paxos's quorum-based flavor but is tailored to the primary-backup log model. ZAB has a *discovery/synchronization* phase (electing a leader and synchronizing followers' logs to match the leader's) followed by a *broadcast* phase (the leader broadcasts proposals in order, followers ack, the leader commits on majority ack). ZAB differs from Multi-Paxos in that the leader is elected on the *zxid* (a 64-bit counter of epoch and transaction counter) so the elected leader is guaranteed to have the latest committed state, eliminating the Phase-1-prepare round of Multi-Paxos on each leadership change. ZooKeeper offers *sequential consistency* (reads see a prefix of the leader's writes, but a read served by a follower may be stale) unless you call `sync()` before a read or only read from the leader. This nuance—*ZooKeeper by default is not linearizable for reads*—is a classic interview trap.

### etcd (Raft)

etcd is the canonical Raft deployment: a small (typically 3 or 5 member) strongly-consistent key-value store backing Kubernetes, Rook, and many cloud-native systems. Every write is proposed to the Raft leader, replicated to a quorum, committed, and applied to a boltdb-backed MVCC store; reads default to linearizable by routing through the leader with a ReadIndex (a quorum-confirmed lease check) but can be downgraded to serializable for higher throughput at the cost of freshness. etcd's operational characteristics—recommended cluster size of 3 or 5, maximum practical cluster size around 7, request size limits of 1.5MB, advice to keep total data under 8GB—derive directly from Raft's quorum and log-replication costs. The etcd team publishes careful guidance: 3 nodes tolerate 1 failure, 5 nodes tolerate 2, and you should never run an even number because a 2-node cluster tolerates zero failures while a 4-node cluster tolerates only one (the same as 3) at higher cost.

### Other Notable Systems

*Consul* (HashiCorp) uses Raft under the hood for its own state and layers a gossip protocol (Serf/SWIM) for membership and failure detection. *CockroachDB* and *TiKV* use Raft at the *per-range* level—each range (a contiguous key span) has its own Raft group, so a single cluster runs tens of thousands of Raft groups, with leaders balanced across nodes for throughput. *Spanner* uses Paxos per shard and layers TrueTime (atomic-clock-bounded clock uncertainty) on top for externally-consistent transactions. *FoundationDB* uses a different approach—optimistic concurrency with a sequencer/locker layer—illustrating that not every strongly-consistent system uses a Raft/Paxos core. The general pattern: a small consensus group (3–7 nodes) provides the *control plane* (metadata, leadership, configuration) while the *data plane* uses partitioning and per-partition consensus to scale horizontally.

---

## Part 6: CAP Theorem Implications

### The CAP Statement

Brewer's CAP theorem, formalized by Gilbert and Lynch (2002), states that a distributed system experiencing partitions cannot simultaneously provide *consistency* (here meaning linearizability—every read sees the latest write) and *availability* (every request to a non-failed node eventually returns). Because real networks *do* partition, the practical takeaway is that during a partition a system must choose between C and A; systems are therefore classified as CP (preserve consistency, reject or block requests on the minority side of a partition) or AP (preserve availability, accept writes on both sides and reconcile later, possibly with divergence). Raft, Paxos, ZooKeeper, and etcd are all CP: they require a majority quorum to make progress, so a partition that splits a 5-node cluster 2-3 leaves the 2-node side unable to serve writes (and, for etcd's default linearizable reads, unable to serve reads either). Dynamo, Cassandra (at default settings), and Riak are AP: they accept writes on both sides and reconcile via vector clocks or last-writer-wins, exposing the possibility of conflicting writes that must be merged.

### The Nuances Interviewers Test

CAP is widely misquoted as "pick two of three always," which is wrong: the theorem only forces a choice *during a partition*. When the network is healthy, a well-designed system can provide both C and A. Moreover, "consistency" in CAP is specifically *linearizability*, not the much weaker database notion of ACID consistency, and "availability" is the formal notion that *every* request to a *non-failed* node returns, not the practical notion of "high uptime." PACELC (Abadi, 2010) generalizes this: if there is a Partition (P), the system chooses between A and C; Else (E, no partition), it chooses between L (latency) and C. This captures the real engineering tradeoff that even without partitions, strongly-consistent systems pay a latency cost for quorum round trips. Spanner is EL+AC (waits for TrueTime during commits but is available); Dynamo is PA+EL. Knowing PACELC lets you say something sharper than "CAP" in an interview.

---

## Part 7: Linearizability vs Sequential Consistency

These two consistency models are routinely conflated but differ in a way that matters for correctness. **Linearizability** is the strongest single-object model: every operation appears to take effect atomically at some point *between its invocation and response*, and that point respects the real-time ordering of operations across clients. If client A completes a write before client B begins a read, B's read must see that write (or a later one). Linearizability gives the illusion of a single copy of the data and is what most people intuitively mean by "strong consistency"; Raft and etcd's default reads provide it, at the cost of a quorum round-trip or a leader lease.

**Sequential consistency** is weaker: operations must appear to execute in some total order that respects each *client's* program order, but that order need not respect real-time ordering across different clients. So client B could read a stale value even though A's write completed in real time before B's read started, as long as there exists a global serialization consistent with each client's local order. Sequential consistency is what ZooKeeper offers by default (a follower serving a read may lag the leader) and what a CPU memory model's "sequential consistency" (Lamport, 1979) refers to. The two-line summary: **linearizability = sequential consistency + real-time ordering across clients.** Dropping real-time ordering lets the system serve reads from stale replicas cheaply, which is why ZooKeeper's default reads are fast-but-possibly-stale and why etcd distinguishes "linearizable" from "serializable" reads as a tunable.

For completeness, *causal consistency* preserves only causally-related order (writes that are causally linked must be seen in order, but concurrent writes can be ordered differently at different replicas), and *eventual consistency* guarantees only that replicas converge *eventually* with no bound on the staleness window. The hierarchy—linearizable ⊃ sequential ⊃ causal ⊃ eventual—gives you a vocabulary for reasoning about the consistency/latency tradeoff that the PACELC framing makes explicit.

### Consistency Model Comparison

| Model | Real-Time Ordering? | Guarantees | Cost / Latency | Example Systems |
|-------|:-------------------:|------------|----------------|-----------------|
| Linearizability | ✅ Yes | Every read sees latest write or a newer one; single-copy illusion. Strongest single-object model. | High: quorum round-trip or leader lease required. | Raft (leader reads), etcd (default), Spanner (TrueTime) |
| Sequential Consistency | ❌ No | Total order respecting each client's program order, but not cross-client real-time order. Stale reads allowed. | Medium: can read from stale replicas. | ZooKeeper (default follower reads), CPU seq consistency |
| Causal Consistency | ❌ No | Causally-related writes seen in order; concurrent writes may differ across replicas. | Medium-low: track causal dependencies (vector clocks). | Dynamo-style with causal tracking, COPS |
| Eventual Consistency | ❌ No | Replicas converge eventually; no bound on staleness window. Conflicts possible during convergence. | Low: no coordination needed for reads/writes. | Dynamo, Cassandra (CL=ONE), Riak, DNS |

The hierarchy is strict: **linearizable ⊃ sequential ⊃ causal ⊃ eventual** — each weaker model permits everything the stronger one permits, plus additional interleavings.

---

## Part 8: Quorum Systems

A *quorum system* is a collection of subsets (quorums) of a universe of nodes such that every two quorums intersect; any two quorums share at least one node, and that intersection is the basis for safety. The simplest and most common is the **majority quorum**: with N nodes, every quorum has strictly more than N/2 members, so any two majorities of an N-set overlap in at least one node (for odd N this is `(N+1)/2`; for even N it is `N/2 + 1`, which is why even-sized clusters are wasteful—an extra node buys you nothing in failure tolerance versus odd N−1). Paxos, Raft, ZAB, and most strongly-consistent systems use majority quorums because they offer the best tradeoff of failure tolerance and operation cost: a cluster of size 2F+1 tolerates F failures and requires F+1 nodes to make progress.

Quorum systems are more general than majorities, and the general theory lets you reason about read/write quorums separately. In a system with N replicas, if every write goes to a write quorum of size W and every read to a read quorum of size R, then reads see the latest write as long as **W + R > N**. Dynamo-style systems let you tune W and R to dial the consistency/latency/availability tradeoff per workload. *Weighted quorums* and *crumbling walls* are exotic variants for heterogeneous clusters where some nodes are more reliable than others.

Key quorum rules and facts:

- **Majority quorum**: any quorum must contain strictly more than N/2 members. Any two majorities overlap in at least one node — this intersection is the basis for safety.
- **Cluster size vs. fault tolerance**: a cluster of size `2F+1` tolerates `F` failures and requires `F+1` nodes to make progress.
  - 3 nodes → tolerates 1 failure, quorum = 2
  - 5 nodes → tolerates 2 failures, quorum = 3
  - 7 nodes → tolerates 3 failures, quorum = 4
- **Even-sized clusters are wasteful**: a 4-node cluster tolerates only 1 failure (same as 3 nodes) at higher cost; a 2-node cluster tolerates 0 failures. Always prefer odd sizes.
- **Read/write quorum rule**: reads see the latest write as long as **W + R > N** (W = write quorum size, R = read quorum size, N = total replicas).
  - `W = R = (N+1)/2` → majority system (strong consistency, balanced cost)
  - `W = N, R = 1` → write-all/read-one (maximum consistency, but one slow/failed node blocks writes)
  - `W = 1, R = N` (with last-writer-wins) → AP system (writes never block, but reads must touch every node to find the latest)
- **Quorum size determines both fault tolerance AND latency**: more replicas contacted = more round trips = higher latency but more availability.
- **Byzantine quorums**: BFT protocols require quorums of `2F+1` out of `3F+1` nodes to tolerate `F` Byzantine (arbitrary/malicious) faults — roughly 3x the nodes and 2x the round trips of crash-fault consensus.

---

## Part 9: Failure Scenarios

Consensus protocols are only interesting when things break; interviewers will probe specific failure modes. The taxonomy worth rehearsing:

**Leader crash mid-replication.** A Raft leader crashes after replicating an entry to some followers but before it is committed. Those followers hold an uncommitted entry; the new leader elected after the crash may or may not have that entry. If the new leader's log does not contain it, the entry is discarded (it was never committed, so discarding it violates nothing); if the new leader's log does contain it, the entry will eventually be committed once a new entry from the new leader's term is replicated. The no-op-on-election pattern forces a quick commit decision. Client requests that were in flight get a timeout and must be retried with the same request ID for exactly-once semantics.

**Network partition, minority side.** A 5-node Raft cluster partitions 3-2. The 3-node majority side elects (or keeps) a leader and continues serving writes; the 2-node minority side cannot reach a majority, so it cannot elect a leader and cannot commit. If the minority side had a leader before the partition, that (now-deposed) leader may still accept writes from clients that can reach it, but it cannot commit them and will return errors or hold them; the safety guarantee is that the majority side will reject those writes' potential commits. When the partition heals, the minority side's log is reconciled to the majority's by the AppendEntries consistency check, and any uncommitted entries are overwritten. This is the textbook CP behavior.

**Network partition, then heal, with divergent client writes.** In an AP system (Dynamo, Cassandra at CL=ONE), both sides accept writes; on heal, conflicting versions must be resolved by application logic (vector clocks reveal the conflict) or by last-writer-wins (which can silently lose data when clocks are skewed). In a CP system this cannot happen—writes are blocked on the minority side, so there is nothing to reconcile.

**Slow disk / fsync stalls.** A node whose disk fsync calls take seconds will stall log writes; in Raft this manifests as the leader being unable to commit (because the slow node never acks) and followers timing out, potentially causing repeated leader churn. Mitigations: separate the WAL onto its own fast disk (NVMe), batch and group-commit, monitor fsync latency as a first-class metric, and treat persistent fsync stalls as a node-level failure that the operator should remove from the cluster.

**Quorum loss.** In a 3-node cluster, losing 2 nodes (only 1 alive) means no quorum, so the system becomes read-only (or fully unavailable for writes). This is why production deployments prefer 5-node clusters for important consensus groups: 5 tolerates 2 failures, giving you time to repair one failure before a second takes you down. Planned maintenance (replacing a node) should always be done on a cluster with at least 2 nodes of headroom.

**Byzantine failures.** Raft and Paxos assume crash-stop (or crash-recovery) failures, not Byzantine (arbitrary, malicious) failures. If nodes can lie, forge messages, or collude, you need a Byzantine-fault-tolerant consensus protocol such as PBFT, Tendermint, or HotStuff, which typically require quorums of 2F+1 out of 3F+1 nodes to tolerate F Byzantine faults. The cost is roughly 3x the nodes and 2x the round trips of crash-fault consensus, which is why BFT is reserved for adversarial settings (blockchains, cross-organization trust) and not used for in-datacenter coordination.

---

## Part 10: Capacity Planning

Strongly-consistent consensus groups do not scale out by adding nodes—in fact, adding nodes *hurts* latency and throughput because every write must round-trip to a quorum, and larger quorums mean more nodes to wait on. The right mental model is: keep the consensus group *small and fixed* (3 or 5 nodes, geographically placed for the latency you can tolerate), and scale *horizontally by partitioning* so that each partition (shard, range, tablet) has its own independent consensus group with its own leader. CockroachDB and TiKV run tens of thousands of Raft groups across a cluster of hundreds of nodes, balancing leaders so no single node is leader for too many hot ranges.

The practical numbers to internalize: a 3-node etcd cluster in one datacenter can sustain tens of thousands of writes per second with single-digit-millisecond latencies, but cross-region latency dominates everything—a 5-node cluster with nodes in three regions pays the round-trip to the majority region on every write, so write latency is bounded below by inter-region RTT (50–150ms). If you need multi-region writes, you either accept that latency, use leader-placement heuristics to keep the leader near the writers, or move to an AP or leaderless model (Dynamo, Cassandra) for the hot path and accept weaker consistency. Request size matters too: etcd caps values at 1.5MB and recommends keeping total store size under 8GB because Raft snapshots and replay costs scale with state size. A consensus group is the wrong place to store your application data; it is the right place to store the *metadata* that lets the rest of the system scale.

Latency budgeting for a single Raft write: leader appends to local WAL and fsyncs (one disk sync, the dominant cost on NVMe, ~0.1–1ms), leader sends AppendEntries to followers in parallel, followers fsync and ack (parallel round trip, bounded by the slowest follower plus network RTT), leader commits on majority ack, applies to state machine, replies to client. So write latency ≈ max(local fsync, network RTT to majority + remote fsync). With a local majority this is one fsync plus one local RTT; with a remote majority it is one fsync plus one WAN RTT. Election-time unavailability is bounded by the election timeout plus one round trip (a few hundred ms), but if elections thrash—because of network flapping or overloaded disks—the cluster can be write-unavailable for seconds, which is why tuning election timeouts to be safely above expected RTT variance is critical.

---

## Sharp Interview Question

**Question:** You run a 5-node Raft cluster. The leader receives a client write, replicates the entry to two followers (so three nodes total have it—a majority), commits it, and replies "committed" to the client. Immediately after, before the leader sends the next heartbeat, it crashes. Two of the three nodes that had the entry are in a network partition with the leader's corpse and cannot reach the other two nodes; the other two nodes can form a majority-of-three with one of the entry-holders. Explain whether the committed entry can ever be lost, and why Raft's election rule is what makes this safe.

**Model Answer:** The entry can never be lost, and the reason is leader-completeness, which flows from the election voting rule. The entry was committed, which by Raft's commit rule means it was replicated to a majority (three of five) and all prior entries were committed. Any new leader must be elected by a majority of votes, and a server only votes for a candidate whose log is at least as up to date as its own (compared by last-log-term then by log length). The two nodes that did *not* receive the entry have logs that are shorter or lower-term at that index, so they cannot be elected over any of the three entry-holders without the entry-holders' votes—and any entry-holder that votes does so only for a candidate whose log contains the committed entry. Therefore the next leader is guaranteed to have the committed entry in its log, will preserve it, and will eventually re-replicate it to the lagging nodes. The client's "committed" reply was truthful and durable. The subtle point that often gets missed is Raft's *prior-term commit rule*: a leader commits entries from its own term by counting replicas, but it only commits prior-term entries *indirectly* by committing a later entry from its own term. If our crashed leader had committed the entry purely by counting replicas from a prior term, there would be an edge case; the rule that the leader must have a current-term entry replicated to a majority before declaring prior entries committed is exactly what closes that hole.

**Common Pitfall:** Candidates frequently answer "the entry could be lost because the other two nodes can form a majority without it"—this is wrong because it conflates *any* three nodes with *any* majority, ignoring that the election vote is gated on log completeness. The deeper pitfall is assuming majority replication alone guarantees durability; it does only because the *election rule* couples majority-vote with log-up-to-dateness. If you implemented Raft's log replication faithfully but allowed votes without the log check (a common bug in naive implementations), you would reintroduce exactly the bug the question is probing: a leader without the committed entry could be elected and overwrite it, silently losing a client-acknowledged write. The lesson: in Raft, safety lives in the election rule, not the replication rule.

---

## Protocol Comparison: 2PC vs 3PC vs Paxos vs Raft

| Property | 2PC | 3PC | Paxos / Multi-Paxos | Raft |
|----------|-----|-----|---------------------|------|
| **Problem solved** | Atomic commit across participants | Atomic commit (non-blocking) | Consensus on a value / log | Consensus on a log |
| **Blocking?** | Yes — coordinator failure in prepared window | No (under sync + fail-stop) | No | No |
| **Quorum requirement** | All participants must vote | Majority | Majority | Majority |
| **Failure tolerance** | 0 (any failure can block) | F of 2F+1 (unsafe under partition) | F of 2F+1 | F of 2F+1 |
| **Safety under partition** | ✅ Safe (blocks) | ❌ Unsafe (can violate atomicity) | ✅ Safe (blocks minority) | ✅ Safe (blocks minority) |
| **Network model** | Synchronous assumption | Synchronous (bounded delay) | Asynchronous (partial synchrony) | Asynchronous (partial synchrony) |
| **Leader model** | Coordinator (single, not elected) | Coordinator (single, not elected) | Stable leader (Multi-Paxos) | Elected leader (term-based) |
| **Phases per decision** | 2 (prepare, commit) | 3 (vote, pre-commit, commit) | 2 (prepare/promise, accept/accepted); 1 with stable leader | 1 round trip (AppendEntries) |
| **Crash recovery** | Replay WAL, contact recovery coordinator | Local state determines decision | Re-run prepare on leader change | Log consistency check + backfill |
| **Latency overhead** | ~3x single-node commit | Higher than 2PC (extra round) | ~1 RTT per entry (stable leader) | ~1 RTT per entry (stable leader) |
| **Understandability** | Simple | Moderate | Notoriously difficult | Designed for understandability |
| **Real-world systems** | XA, MySQL/PostgreSQL XA, sharded DBs | Mostly academic | Chubby, Spanner, PaxosStore | etcd, Consul, CockroachDB, TiKV |

### Extended Quick Reference (with ZAB and BFT)

| Protocol | Problem Solved | Blocking? | Quorum | Failure Tolerance | Real Systems |
|----------|---------------|-----------|--------|-------------------|--------------|
| 2PC | Atomic commit across participants | Yes (coordinator failure in prepared window) | All participants must vote | 0 (any failure can block) | XA, MySQL/PostgreSQL XA, sharded DBs |
| 3PC | Atomic commit, non-blocking | No (under sync + fail-stop) | Majority | F of 2F+1 (unsafe under partition) | Mostly academic |
| Paxos / Multi-Paxos | Consensus on a value / log | No | Majority | F of 2F+1 | Chubby, Spanner, PaxosStore |
| Raft | Consensus on a log | No | Majority | F of 2F+1 | etcd, Consul, CockroachDB, TiKV |
| ZAB | Atomic broadcast (log) | No | Majority | F of 2F+1 | ZooKeeper |
| PBFT / HotStuff | Byzantine consensus | No | 2F+1 of 3F+1 | F Byzantine of 3F+1 | Blockchains, Tendermint |

---

## Further Reading

- Lamport, "The Part-Time Parliament" (1998) and "Paxos Made Simple" (2001).
- Ongaro & Ousterhout, "In Search of an Understandable Consensus Algorithm" (USENIX ATC 2014)—the Raft paper.
- Junqueira, Reed, Serafini, "Zab: High-performance broadcast for primary-backup systems" (DSN 2011).
- Gilbert & Lynch, "Brewer's Conjecture and the Feasibility of Consistent, Available, Partition-Tolerant Web Services" (2002)—the CAP formalization.
- Abadi, "Consistency Tradeoffs in Modern Distributed Database System Design" (2010)—PACELC.
- Fischer, Lynch, Paterson, "Impossibility of Distributed Consensus with One Faulty Process" (1985)—FLP.
- van Renesse & Altinbuken, "Paxos Made Moderately Complex" (2015)—the clearest engineering treatment of Multi-Paxos.
- Howard et al., "RAFT Refloated: Do We Have a Consensus?" (2014)—a critical re-examination of Raft's edge cases.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- 2PC: coordinator asks all nodes to prepare, then commit or abort. Blocking — if coordinator dies, nodes are stuck
- Raft: leader-based, majority quorum, heartbeats. Understandable and widely adopted (etcd, Consul, CockroachDB)
- Paxos: proven correct but notoriously hard to understand. Used in Chubby, ZooKeeper (via ZAB)
- Quorum = floor(N/2) + 1. With 5 nodes, tolerate 2 failures. With 3 nodes, tolerate 1.
- Log replication: leader appends, replicates to followers, commits when majority ack

**Common Follow-Up Questions:**
- "What's the 2PC coordinator failure problem?" — If the coordinator crashes after prepare but before commit/abort, participants hold locks and can't proceed (blocking). 3PC solves this but adds message overhead.
- "Raft vs Paxos — why did Raft win?" — Raft was designed for understandability (same guarantees as Paxos but clearer separation of concerns). Paxos is correct but practitioners find it hard to implement correctly.

**Gotcha:**
- 2PC is NOT a consensus algorithm — it's a atomic commit protocol. The difference: 2PC can block if the coordinator fails, while consensus algorithms (Raft, Paxos) guarantee progress as long as a majority of nodes are alive. Don't conflate the two in an interview.
