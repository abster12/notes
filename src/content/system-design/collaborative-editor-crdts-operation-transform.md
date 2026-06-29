---
title: "Collaborative Editor (CRDTs, Operation Transform)"
type: system-design
category: Advanced
date: 2026-05-19
tags: [system-design, interview, advanced, collaboration, crdt, ot, real-time]
aliases: []
---

# Collaborative Editor (CRDTs, Operation Transform)

## Summary & Interview Framing

Systems that allow multiple users to edit the same document simultaneously using Operational Transformation (OT) or Conflict-free Replicated Data Types (CRDTs) to merge changes without conflicts. OT sequences operations through a central server that transforms concurrent edits, while CRDTs push conflict resolution into the data structure itself for peer-to-peer and offline-first convergence.

**How it's asked:** "Design a collaborative text editor like Google Docs supporting 10 concurrent editors, real-time cursor positions, and offline editing with conflict-free merge."

---

## Overview

A collaborative editor lets multiple users edit a shared document — text, drawings, spreadsheets, or structured blocks — simultaneously, with each user seeing the others' changes arrive within a few hundred milliseconds. The hard computer-science problem hiding behind this UX is **conflict resolution under concurrency**: when two people edit the same paragraph at the same time, the system must converge to one identical state on every client without popping up a merge dialog. Solving this well, at scale, while preserving sub-second latency, offline editing, and undo, is one of the genuinely difficult distributed-systems designs in mainstream software.

Two algorithm families dominate production systems. **Operational Transformation (OT)**, invented in the late 1980s and made famous by Google Docs/Wave, sequences operations through a central server and *transforms* concurrent edits against each other so they compose correctly. **Conflict-free Replicated Data Types (CRDTs)**, formalised by Shapiro et al. in 2011, push conflict resolution into the data structure itself so that any two replicas converge deterministically without a server mediating — enabling peer-to-peer and offline-first sync. Real-world deployments: Google Docs (OT, Jupiter protocol), Figma (custom CRDT over a scene graph), Notion (CRDT-ish blocks with a server authority), Microsoft Loop / Fluid Framework (CRDT), Linear (a CRDT-ish sync engine), and the open-source stacks Yjs and Automerge used by Notion-style apps, JupyterLab, and many collaborative whiteboards.

> The single most important framing for an interview: OT trades algorithmic complexity for a simple consistency model (one server sequences everything), while CRDTs trade data-structure complexity and metadata overhead for a simple distributed model (no server needed for correctness). Every other difference — offline support, interleaving artifacts, undo difficulty, metadata cost — flows from that core trade.

## Key Requirements

### Functional Requirements

- Real-time concurrent editing of text and structured objects with sub-second propagation.
- Offline editing with automatic reconciliation on reconnect.
- Presence indicators: who else is editing, their cursor positions and selection ranges.
- Version history, undo/redo (both per-user and global), comments and suggestions.
- Late-joiner support: a user opening a live document must catch up to the current state quickly.

### Non-Functional Requirements (SLAs)

- **Operation propagation latency:** under 100 ms for co-located users, under 500 ms cross-region.
- **Convergence guarantee:** all clients that have seen the same set of operations reach an identical final state — no divergence, ever.
- **Causal ordering:** an edit that depends on a prior edit (e.g. deleting a character someone else just typed) must be applied in causal order.
- **Bandwidth:** send deltas, never full-document retransmission on every keystroke.
- **Availability:** editing must work offline and against an unreachable server; sync happens later.
- **Integrity:** no lost updates even under client crashes, duplicate deliveries, and reordered packets.

## Capacity Planning

| Metric | Google Docs–scale estimate | Notes |
|--------|----------------------------|-------|
| DAU | 300M+ | |
| Concurrent editors / doc | 1–50 typical, 100+ burst | Most docs have < 5 concurrent editors; the long tail matters |
| Operations / sec / doc | 2–10 writes/sec | Typing bursts, not continuous streaming |
| Document size | 1 KB–2 MB text | Most docs < 100 KB; CRDT metadata multiplies this |
| WebSocket connections / server | ~50k–100k | Per-connection memory is the real ceiling, not sockets |
| Peak ops/sec (global) | Millions/sec | Sharded by document |
| Memory / live document | 10–500 KB state + op buffer | Scales with doc size and recent-op window |

The key insight is that the bottleneck is not raw throughput — it is **conflict-resolution latency and consistency overhead**. OT servers must sequence operations globally per document, which turns each active document into a single hot shard. CRDTs avoid the sequencer but pay per-character metadata and tombstone bloat that inflates storage and memory 5–20×. Sizing must account for the metadata multiplier, not just the user-visible text. For presence, plan separately: cursor/selection broadcasts scale as O(editors²) per document if done naively, so throttling and batching are part of the capacity model, not an afterthought.

## Real-Time Collaboration Architecture

The transport of choice is **WebSocket** — a single full-duplex TCP connection per client, upgraded from HTTP, kept alive with heartbeats. WebSockets beat HTTP long-polling and SSE here because edits flow in both directions at high frequency and you want low per-message overhead (no HTTP headers on every keystroke). Each client holds one persistent connection to a collaboration server; that server is the fan-out point for the document's subscribers. For reliability across regions, connections are often fronted by a sticky load balancer so a given client reconnects to the same server holding its in-memory document state, with a Redis/Memcached pub-sub backbone bridging servers when subscribers to one document are split across machines.

The authoritative unit per document is an **operational log**: an append-only sequence of operations (OT) or a causally-ordered set of CRDT updates. The server keeps the current document state in memory plus a sliding window of recent operations, and persists every operation to this log (typically an append-only store — a partitioned Kafka topic, a per-document append-only row set, or an object-store segment). This log is the source of truth; the in-memory state is a materialised projection that can always be rebuilt by replaying the log from the last snapshot. Late joiners are handled by sending them a recent snapshot followed by the operations after that snapshot — they never replay the entire history for a live document. Because the log is append-only and monotonic, replication and recovery are straightforward: a server restarting for a document simply loads the latest snapshot and tails the log forward.

A typical message flow: the client applies its own edit optimistically to its local view, then sends the operation to the server tagged with the revision (OT) or the version vector (CRDT) it was based on. The server validates, sequences or merges, appends to the log, updates the in-memory state, and fans the operation out to all other subscribers over their WebSockets. The originating client gets an acknowledgement (possibly with a transformed position) and corrects its local state if needed. If a client disconnects, its queued operations are reconciled on reconnect against whatever happened in the interim — trivial for CRDTs, requiring server-side transformation for OT.

### Real-Time Collaboration Architecture Diagram

```
  Client A            Client B            Client C (late-joiner)
     |                   |                      |
     | WebSocket (edit)  | WebSocket (edit)     | WebSocket (subscribe)
     v                   v                      |
  +-------------------------------------------------------+
  |          Sticky Load Balancer (per-doc affinity)      |
  +-------------------------------------------------------+
     |                |                      |
     v                v                      v
  +-----------+  +-----------+        +-----------+
  | Collab    |  | Collab    |        | Collab    |
  | Server 1  |  | Server 2  |  ...   | Server N  |
  | (doc X)   |  | (doc Y)   |        | (doc Z)   |
  +-----------+  +-----------+        +-----------+
     |                |                      |
     |  in-memory doc state + recent op window (sliding)
     |                |                      |
     +----------------+----------------------+
                      |
              +---------------+
              |  Op Log Store |  <-- source of truth
              |  (append-only:|
              |   Kafka / row |
              |   / object)   |
              +---------------+
                      ^
                      |  snapshot + tail for late-joiner
                      |
     +-------------------------------------------------+
     |   Redis / Memcached Pub-Sub Backbone           |
     |   (bridges servers when doc subscribers span    |
     |    multiple machines; fan-out across regions)   |
     +-------------------------------------------------+
                      |
                      v
   Snapshot Store (object storage, every ~1000 ops)
```

Message flow, step by step:

1. Client applies its edit **optimistically** to its local view.
2. Client sends the operation to the server, tagged with the base **revision (OT)** or **version vector (CRDT)**.
3. Server **validates**, then sequences (OT) or merges (CRDT).
4. Server **appends** the operation to the op log (source of truth).
5. Server **updates** the in-memory document state.
6. Server **fans out** the operation to all other subscribers over their WebSockets.
7. Originating client receives an **acknowledgement** (possibly with a transformed position) and corrects local state if needed.
8. If a client disconnects, its queued operations are **reconciled on reconnect** — trivial for CRDTs, requiring server-side transformation for OT.

## Data Model

### OT-Based Model (Google Docs style)

```
Document
  - id: UUID
  - revision: int            (monotonic, server-assigned, strict total order)
  - content: rich-text AST   (paragraphs, formatting spans, tables)
  - cursors: [{user_id, position, selection_end, color}]

Operation
  - type: insert | delete | format | move
  - position: int            (character offset in the base revision)
  - [content: string]        (for insert)
  - [length: int]            (for delete)
  - base_revision: int       (the revision this op was authored against)
  - user_id: UUID
```

### CRDT-Based Model

```
CRDT Item (per character or block)
  - id: {site_id, lamport_counter}   <- globally unique, orderable
  - left_id, right_id: item ids       <- insertion position (RGA)
  - value: char / block content
  - tombstone: bool                   (soft-delete for convergence)
  - origin_id: item id                (for undo linkage)

Document CRDT
  - items: ordered set<CRDT Item>     <- total order via id + tie-break
  - version_vector: map<site_id -> counter>   <- tracks seen operations
  - delete_set: set<item id>          <- tombstones
```

**Storage choice.** OT documents sit well in a relational store keyed by document id and revision — the server is the single writer, so strict consistency is natural. CRDT documents are a log of immutable operations plus a periodically compacted snapshot, which fits object storage and append-only logs better than mutable rows. Both use WebSocket for real-time sync; both keep a recent-operation buffer in memory for fast late-join replay.

## Operational Transformation (OT)

### The Transformation Function (xform)

The heart of OT is a binary function, conventionally written `T(op_a, op_b) -> op_b'`, that takes two operations concurrent against the same base state and returns a version of `op_b` adjusted to account for `op_a` having been applied first. For plain text, the transformation is mostly position arithmetic. If `op_a` is `insert('H', 0)` and `op_b` is `insert('W', 0)`, then `T(op_b, op_a)` shifts `op_b`'s position to 1 because `op_a` inserted a character before it. Deletes shift positions in the opposite direction; an insert inside a deleted range requires either splitting the delete or pushing the insert to the delete's start. The subtle case is **same-position concurrent inserts**: both target index 0, so the transform must pick a deterministic tie-break, typically by client id, to ensure both clients converge to the same order. Rich-text editors add operation types — format-range, split-paragraph, move-block — and every pair of types needs its own transformation rule, which is where OT's notorious O(n²) rule matrix comes from.

### OT Transform Function Flow Diagram

```
                Base State S0 (revision N)
                     /            \
            op_a applied        op_b applied
                  /                \
             State S_a            State S_b
                |                    |
   transform op_b against op_a   transform op_a against op_b
   T(op_b, op_a) -> op_b'       T(op_a, op_b) -> op_a'
                |                    |
   apply op_b' to S_a            apply op_a' to S_b
                |                    |
                v                    v
            State S_ab           State S_ba
                \                    /
                 \    TP1: S_ab == S_ba    (convergence!)
                  \                  /
                   -> Converged State <-
                          (revision N+2)

  Example: op_a = insert("Hi", 0),  op_b = insert("Yo", 0)
  ----------------------------------------------------------------
  Server (or replica) applies op_a first:  doc = "Hi"
  T(op_b, op_a): op_b targets pos 0, op_a inserted 2 chars before it
                 -> shift op_b to pos 2      => insert("Yo", 2)
  Apply op_b':   doc = "HiYo"

  Other replica applies op_b first:  doc = "Yo"
  T(op_a, op_b): op_a targets pos 0, op_b inserted 2 chars before it
                 -> shift op_a to pos 2      => insert("Hi", 2)
  Apply op_a':   doc = "YoHi"   <-- DIVERGENCE without a tiebreak rule!

  Fix: deterministic tiebreak by client_id.
  If client_id(A) < client_id(B): A always sorts before B at same pos.
  Both replicas must apply the SAME tiebreak so both yield "HiYo".
  This is exactly why a central server (single total order) is needed:
  it collapses the two transformation paths into one.
```

### TP1 and TP2: The Convergence Properties

OT correctness rests on two formal properties of the transformation function.

**TP1** (Transformation Property 1) says that for any two concurrent operations `O1, O2`, applying `O1` then `T(O2, O1)` produces the same state as applying `O2` then `T(O1, O2)`. TP1 guarantees pairwise convergence: two replicas that each saw the same two ops in different orders end up identical. This is necessary but not sufficient once you have three or more concurrent operations, because the order in which you *transform* matters as much as the order in which you *apply*.

**TP2** (Transformation Property 2) is the harder, often-skipped condition: for any three concurrent operations `O1, O2, O3`, the result of `T(O3, T(O2, O1))` must equal `T(T(O3, O2), O1)`. In plain terms, the transformation function itself must be commutative under composition — you must reach the same transformed operation regardless of the path through the transformation lattice. Most published OT algorithms *do not satisfy TP2* and instead sidestep the problem by funnelling all operations through a central server that imposes a single total order, so only one transformation path is ever taken. This is the real reason Google Docs needs its server: not for storage, but to avoid the multi-way transformation diamond that TP2 would otherwise have to close. Algorithms that genuinely satisfy TP2 (e.g. TTF, adOPTed) are rare and complex; the practical industry choice is "central sequencer + TP1-only transform." Knowing this distinction — that the server exists primarily to dodge TP2 — is a sharp interview signal.

Convergence properties at a glance:

- **TP1 — pairwise convergence:** for any two concurrent ops `O1, O2`, `apply(O1) ; apply(T(O2, O1))` yields the same state as `apply(O2) ; apply(T(O1, O2))`. Ensures two replicas seeing the same two ops in different orders end up identical.
- **TP2 — transform-path convergence:** for any three concurrent ops, the result of transforming is independent of the order in which transforms are composed. `T(O3, T(O2, O1)) == T(T(O3, O2), O1)`.
- **Why TP1 is not enough:** with three or more concurrent ops, different *transformation paths* (not just application orders) can produce different transformed operations, leading to divergence unless TP2 holds.
- **Production reality:** most OT systems satisfy only TP1 and rely on a central server to collapse all possible transform paths into a single linear order, so TP2 never needs to be tested.
- **The server's real job:** the sequencer exists primarily to *avoid* the TP2 requirement, not for storage or durability — it picks one transformation path so replicas only ever transform against that one linear history.
- **Algorithms that satisfy TP2** (TTF, adOPTed) are rare and complex; the industry standard is "central sequencer + TP1-only transform."

### The Jupiter / Control Algorithm

Google's Jupiter algorithm (the basis of Google Docs) keeps the client and server synchronised through a shared notion of "the state." Both sides maintain a queue of operations that have been applied locally but not yet acknowledged by the other side. When the client sends an op, the server transforms it against any ops it has already applied since the client's base revision, applies it, and sends back the transformed result plus the new revision. The client likewise transforms incoming server ops against its own pending queue. This bidirectional transform loop keeps both sides convergent without ever requiring the client to understand the full global operation graph. The server's monotonic revision counter is the anchor: every operation names the revision it was authored against, and the server's job is to fold each op into the linear history at the right point.

### Why a Central Server

OT requires global ordering. Without a sequencer, independent replicas can take transformation cascades like `T(O1, T(O2, O3))` versus `T(T(O1, O2), O3)` that produce different results — the diamond problem — unless your transform satisfies TP2, which almost no production system does. The server collapses the branching history into a single linear sequence, so every replica is transforming against the *same* linear order and TP1 alone suffices. The cost is that OT is **CP** in CAP terms: if the server for a document is unreachable, that document cannot accept new consensus edits, which is exactly why OT's offline story is weak.

## Conflict-Free Replicated Data Types (CRDTs)

### Mathematical Basis

A CRDT is a data structure whose merge operation forms a **join-semilattice**: every state is an element of a partially ordered set, and merging two states takes their least upper bound. Because the merge is commutative, associative, and idempotent, the order and duplication of message delivery does not matter — any two replicas that have received the same set of updates will compute the same least upper bound and end up identical. This property is called **Strong Eventual Consistency (SEC)**: eventual convergence without coordination, and without ever having to run a conflict resolver. The price is that the data structure must be carefully designed so that *every* concurrent update has a deterministic resolution baked in — there is no server to adjudicate.

Convergence properties of CRDT merge (Strong Eventual Consistency):

- **Commutative:** merge(A, B) == merge(B, A) — delivery order of updates does not affect the result.
- **Associative:** merge(A, merge(B, C)) == merge(merge(A, B), C) — grouping of updates does not affect the result.
- **Idempotent:** merge(A, A) == A — duplicate/delayed retransmits have no effect.
- **Deterministic resolution:** every concurrent update has a deterministic resolution baked into the data structure (e.g. higher Lamport timestamp wins, or id ordering for sequence inserts).
- **Strong Eventual Consistency:** any two replicas that have received the same set of updates converge to the identical state without coordination and without running a conflict resolver.
- **Causality preserved:** version vectors track causality so dependent operations (delete the character someone just inserted) apply in causal order, never producing a state where an effect precedes its cause.

### LWW Registers and Maps

The simplest CRDT is a **Last-Writer-Wins register**: a value paired with a timestamp (usually a Lamport clock, not wall time, to avoid skew), where merge picks the value with the larger timestamp. LWW maps compose registers per-key and are the backbone of many "settings" or "presence" CRDTs. They are simple and cheap, but they silently drop concurrent writes — if two users set the same key at once, one update is lost by design. That is acceptable for ephemeral state (cursor color, presence status) but wrong for content where you never want to lose an edit, which is why text CRDTs use richer structures.

### RGA (Replicated Growable Array)

The **Replicated Growable Array** is the workhorse text-sequence CRDT. Each inserted element carries a unique id and a reference to the element it was inserted *after* (its left neighbour). To insert between two existing elements, you record "insert after this id"; concurrent inserts after the same anchor are ordered by comparing their ids (typically Lamport counter then site id). Deletions are **tombstones** — the element is marked deleted but stays in the structure so that a late-arriving insert that references it as an anchor still lands in the right place. This is why CRDTs cannot simply erase deleted characters: a delete must remain addressable for any concurrent or delayed insert that points at it. RGA gives you a list you can grow from any replica in any order and always converge, at the cost of permanent tombstone metadata until garbage collection reclaims it under safe conditions.

### CRDT RGA Tombstone Structure Diagram

```
  RGA linked list (each node: id={site,counter}, value, tombstone flag, left_id)

  HEAD (origin)
   |
   v
  +----------+    +----------+    +-----------+    +----------+    +----------+
  | id:A:1   |--->| id:A:2   |--->| id:B:1    |--->| id:A:3   |--->| id:B:2   |
  | val:'H'  |    | val:'e'  |    | val:'l'   |    | val:'l'  |    | val:'o'  |
  | tomb:F   |    | tomb:F   |    | tomb:TRUE |    | tomb:F   |    | tomb:TRUE|
  | left:HEAD|    | left:A:1 |    | left:HEAD |    | left:B:1 |    | left:A:3 |
  +----------+    +----------+    +-----------+    +----------+    +----------+
                                          ^               ^               |
                                          |               |               |
                                   (deleted, but          |          rendered output:
                                    addressable)          |          "Hello" with 'l'(B:1)
                                                          |          and 'o'(B:2) hidden
                                   late insert after B:1 -+          (tombstones retained)

  Why tombstones cannot be removed eagerly:
    - A disconnected replica may later send an insert with left_id = B:1.
    - If B:1 were physically erased, that insert would have no anchor
      and could not be placed correctly -> divergence.
    - Safe GC requires proof that ALL replicas have seen the deletion
      (via a version vector of "all sites seen up to here").

  Concurrent inserts after the SAME anchor (e.g. HEAD):
    Site A inserts X (id A:5), Site B inserts Y (id B:4), both after HEAD.
    Tie-break: compare ids -> (counter, then site_id).
    Both replicas compute the same relative order deterministically.
    -> No server needed; convergence by construction.
```

### Yjs and Automerge

In production, most teams do not hand-roll RGA — they use **Yjs** or **Automerge**, the two dominant open-source CRDT libraries. Yjs is optimised for performance and is the engine behind many collaborative editors (Tiptap, JupyterLab collaboration, Evernote's real-time mode). It uses a custom binary encoding and a clever "skip-list" CRDT for text that keeps operations compact and GC-efficient; it ships with providers for WebSockets, WebRTC (peer-to-peer), and IndexedDB (offline), so the same document can sync over a server or directly between browsers. Automerge is the academic-leaning Rust/JS implementation from the original CRDT research lineage; it emphasises a clean JSON-like document model, branching history (think "git for app state"), and explicit change objects. Both expose higher-level types — text, maps, arrays, counters — on top of sequence and register CRDTs. The practical takeaway: picking a CRDT library is largely about its encoding efficiency, GC story, and provider ecosystem, not about the underlying math, which is settled.

### Position Identifiers and Fractional Indexing

A recurring CRDT design question is how to represent "position between two elements" without renumbering. Two approaches dominate. **Linked-list anchors** (RGA, Yjs): each element points at its predecessor, so position is implicit in the linked structure and insertions never touch existing ids. **Fractional indexing** (used by some list CRDTs and by ordering UIs like Notion/Figma): a position is a rational number between two existing positions, e.g. inserting between 0.1 and 0.2 yields 0.15. Fractional indexing is intuitive but has a subtle trap — repeated insertions at the same gap cause the identifier to grow unboundedly (0.15, 0.175, 0.1875…), eventually hitting precision limits and requiring a global renumber. Most production text CRDTs therefore prefer anchored ids; fractional indexing is fine for block-level ordering where insertions are rare relative to the number of blocks.

## OT vs CRDT Comparison

| Dimension | OT | CRDT |
|-----------|-----|------|
| Server role | Central server required as sequencer | Peer-to-peer possible; server optional |
| Consistency | Strong (CP) within a doc | Strong Eventual Consistency (SEC) |
| Convergence mechanism | Transform concurrent ops against a linear order | Deterministic merge in a join-semilattice |
| Offline support | Weak — needs server to transform queued ops | Natural — merge on reconnect via version vectors |
| Algorithmic complexity | Transform rules grow O(n²) with op types | Data structure is complex; one-time design cost |
| Metadata overhead | Minimal (revision numbers) | Significant (~50–200 bytes/char, plus tombstones) |
| Interleaving artefacts | Clean — server linearises ops | Concurrent inserts at same point can interleave ("HeWlolorld") |
| Undo | Well-understood (inverse + transform) | Hard — CRDTs are monotonic, undo needs extra machinery |
| Late-join cost | Replay from snapshot + ops | Replay from snapshot + missing ops via version vector |
| CAP classification | CP — unavailable without server | AP — available offline, converges eventually |
| Adding new op types | Expensive — must define T against every existing type | Cheap — "insert/delete an element with an id" is generic |
| P2P support | No (needs sequencer) | Yes (WebRTC/browser-to-browser) |
| Proven at scale | Google Docs, Etherpad | Figma, Notion, Linear, Yjs/Automerge ecosystem |

The honest summary: **OT wins on metadata efficiency and clean interleaving but loses on offline and on the cost of adding new operation types; CRDTs win on offline/P2P and extensibility but lose on metadata bloat and interleaving ergonomics.** Most modern greenfield collaborative products lean CRDT (often Yjs) because offline-first and extensibility matter more than per-character metadata, and because the library ecosystem removes the implementation risk. Google Docs sticks with OT because rewriting a billion-user converged system is not worth it and OT's metadata leanness compounds at their scale.

### OT vs CRDT: Core Trade-Off Summary

| Trade axis | OT choice | CRDT choice |
|------------|-----------|-------------|
| Where complexity lives | In the algorithm (transform rules) | In the data structure (merge semantics) |
| What is simple | The consistency model (one server sequences) | The distributed model (no server needed for correctness) |
| What you pay in | O(n²) transform rule matrix + server availability | Per-char metadata + tombstone bloat + interleaving |
| When it shines | Real-time, online, single-region, rich text | Offline-first, P2P, multi-region, extensibility |

## Conflict Resolution Strategies

In OT there are no "conflicts" to resolve at the data level — the server's linear sequencing *is* the resolution. Two users edit the same spot; the server picks an order, transforms both ops, and both clients converge. The only conflict-like situation is a same-position tie, resolved by a deterministic client-id tiebreak. The cost of this simplicity is that the resolution is whatever the server order produces, which may not be what either user intended, but it is always consistent.

In CRDTs, conflict resolution is **baked into the merge function and is deterministic by construction**. For an LWW register, the higher timestamp wins. For a sequence CRDT, concurrent inserts at the same anchor are ordered by id. There is never a branch that requires a human decision; there is only the question of whether the deterministic result is *ergonomic*. The famous failure mode is **interleaving**: two users typing "Hello" and "World" at the same cursor can produce "HeWlolrld" because each character is a separate concurrent insert ordered independently. This is correct under SEC but user-hostile. Mitigations include grouping a burst of keystrokes from one user into a single atomic insert (so the word stays contiguous), applying light server-side reordering heuristics, or using a hybrid where a server authority collapses near-concurrent same-position edits. Some products (Notion) run a thin OT pass on top of a CRDT to clean up interleaving while keeping the offline benefits.

A third strategy is **server authority with client CRDTs** — the server is the only one allowed to "commit" a version, and clients send proposed operations that the server serialises. This is effectively OT-shaped control flow over CRDT-shaped data, and it is increasingly common because it combines CRDT's clean data model with OT's clean concurrency model. The trade is that you lose pure P2P sync; the server becomes a required participant for live editing even if offline edits still merge via the CRDT on reconnect.

## Undo and Redo

Undo is where OT and CRDT diverge sharply, and a common interview probe. **OT undo** is well-understood: to undo an operation `O`, you compute its inverse `O⁻¹` (delete ↔ insert, format ↔ unformat) and apply it — but the inverse must first be **transformed against every operation applied since `O`**, so that it targets the right position in the current document. This is called *selective undo* (undo one specific op, possibly out of order) versus *linear undo* (undo the most recent op on your own stack). The transform-against-subsequent-ops step is what makes undo work in a live multi-user document: if someone else typed after your deleted word, your "undo delete" must insert at the transformed position, not the stale one. Redo is just undo-of-undo with the same transform discipline.

**CRDT undo** is genuinely hard because CRDTs are monotonic — the merge semilattice only moves "up," there is no native notion of reverting. The common patterns are:

- **Compensating operations:** keep a per-user undo stack of operation ids; to undo, emit a *new* operation that reverses the effect — an undo-delete re-inserts with a *new* id, an undo-insert tombstones the original. Convergence is preserved because the reversing op is just another CRDT update, but the bookkeeping is client-side and fiddly.
- **Branching history (Automerge):** model undo as rewinding to a prior change object and treating that as a new branch, git-style. Clean conceptually but expensive to render.
- **UndoManager (Yjs):** an `UndoManager` tracks which users/scopes you want to undo and emits compensating operations automatically.

The key principle in all cases: **undo in a CRDT is a forward operation, not a rollback** — you never delete history, you emit a new operation that counteracts a prior one. This preserves convergence but means undo does not shrink the operation log.

## Cursor Tracking

Cursors and selections must track the right location even as the document shifts underneath them. With OT, a cursor is an integer position that gets **transformed alongside operations**: when an insert arrives at position 5 and your cursor sits at position 10, the client bumps your cursor to 11 before rendering. Every incoming operation runs through the same transform function used for content, applied to all live cursors. With CRDTs, a cursor is better modelled as an **anchor on a CRDT item id** rather than an integer offset — "my cursor sits after item `id(A,7)`." This relative anchor survives insertions and deletions around it automatically: if someone inserts before that item, the cursor stays glued to the item; if the item is deleted, the cursor falls back to the nearest live predecessor. Anchoring to ids is more robust than integer positions because it never needs recomputation on remote edits, only when the anchored item itself is removed.

Operationally, cursor updates are high-frequency and must be **throttled aggressively**. A naïve broadcast of every cursor move at 30 fps for 50 editors is 1500 messages/sec per document. Real systems throttle to changes only, batch into 50–100 ms windows, and use client-side interpolation/dead-reckoning to smooth remote cursors between updates. Cursor traffic is often sent over a separate, cheaper channel than content edits so it can be dropped or coalesced without affecting edit integrity.

## Presence

Presence — "who is online, where is their cursor, what are they selecting" — is lower-stakes than content but higher-frequency. It is typically modelled as its own LWW-CRDT or a Redis pub/sub channel with a TTL heartbeat: each client publishes a heartbeat every few seconds; a missing heartbeat for 10–15 seconds marks the user as away and triggers a tombstone broadcast. Presence state (cursor, selection, color, name) is merged with LWW semantics keyed by user id, so the latest heartbeat wins and stale entries expire. Because presence is ephemeral, it is usually *not* persisted to the operational log — it would bloat the log with noise — and is instead kept in a separate in-memory/Redis store. The design rule: never let presence updates participate in the same durability and replay path as content edits, or your snapshots and logs will be dominated by cursor jitter.

## Offline Editing and Sync

Offline editing is the starkest OT/CRDT difference. **CRDTs are offline-native.** A disconnected client simply keeps appending local operations to its own log, tagged with its version vector. On reconnect, the client and server exchange "here is what I have seen" (version vectors) and each sends the operations the other is missing. Because merge is commutative and idempotent, no matter how long the offline gap or how many concurrent offline editors there were, the merge converges to one state without any server adjudication. This is why Linear and Notion can offer "edit on the plane, sync when you land" without conflicts.

**OT offline is harder.** The client queues operations tagged with the base revision it last knew. On reconnect, the server must transform each queued op against every operation applied since that base revision — potentially a long cascade if the client was offline for hours while others kept editing. The longer the offline gap, the more transformation work and the higher the chance the transformed op lands somewhere semantically odd (you deleted a paragraph that has since been rewritten). Most OT systems limit offline editing to short windows or to a single offline user, and fall back to a full document re-sync or manual merge for long divergences. This is the structural reason Google Docs is poor at long offline sessions while CRDT-based editors handle them gracefully.

A practical hybrid: store the document as a CRDT for offline resilience and merge, but run a server authority for live sessions to linearise and clean up interleaving. The CRDT guarantees you can always reconcile; the server authority guarantees the live experience is tidy.

### Offline Sync and Merge Flow Diagram

```
  === CRDT Offline Sync (offline-native) ===

  Client A (offline)                Server / Client B (online)
  +-----------------------+         +-----------------------+
  | local op log          |         | server op log         |
  | vv: {A:5, B:3}        |         | vv: {A:4, B:7, C:2}   |
  | ops A:4, A:5 queued   |         | (kept editing while   |
  | while disconnected    |         |  A was offline)       |
  +-----------------------+         +-----------------------+
          |                                 |
          |  1. reconnect                   |
          |  2. send my version vector      |
          |     {A:5, B:3}                  |
          +-------------------------------->|
          |                                 |
          |  3. server compares VVs:        |
          |     server has A up to 4,       |
          |     needs A:5 (and A:4)         |
          |     A needs B:4..7, C:1..2      |
          |                                 |
          |  4. server sends missing ops    |
          |     B:4, B:5, B:6, B:7, C:1, C:2|
          |<--------------------------------+
          |                                 |
          |  5. A sends its missing ops     |
          |     A:4, A:5                     |
          +-------------------------------->|
          |                                 |
          v                                 v
  +-----------------------+         +-----------------------+
  | merge incoming ops    |         | merge A's ops         |
  | (commutative,         |         | (commutative,         |
  |  associative,         |         |  associative,         |
  |  idempotent)          |         |  idempotent)          |
  | -> converged state    |         | -> converged state    |
  +-----------------------+         +-----------------------+
          \                           /
           \   both identical state   /
            \   no server adjudication/
             >-- SEC guaranteed --<


  === OT Offline Sync (harder, server-mediated) ===

  Client A (offline)                Server (online, kept sequencing)
  +-----------------------+         +-----------------------+
  | queued ops with       |         | revision now N+200    |
  | base_revision = N     |         | (200 ops applied      |
  | op1, op2, op3         |         |  while A offline)     |
  +-----------------------+         +-----------------------+
          |                                 |
          |  1. reconnect                   |
          |  2. send queued ops + base_rev N|
          +-------------------------------->|
          |                                 |
          |  3. server transforms EACH op   |
          |     against ops N+1 .. N+200    |
          |     (long cascade!)             |
          |     op1' = T(op1, N+1..N+200)   |
          |     op2' = T(op2, N+1..N+200+op1')|
          |     op3' = T(op3, ... + op1' + op2')|
          |                                 |
          |  4. server applies transformed   |
          |     ops, sends acks back         |
          |<--------------------------------+|
          |                                 |
          |  risk: transformed op may land  |
          |  in a semantically odd spot     |
          |  (deleted a rewritten paragraph)|
          v                                 v
  +-----------------------+         +-----------------------+
  | corrected local state |         | server linear history |
  | (server-transformed)  |         | (single total order)  |
  +-----------------------+         +-----------------------+

  Key difference: CRDT merge needs NO transformation cascade;
  OT requires N-length transform cascade per offline op.
```

## History Trimming and Garbage Collection

Both models accumulate history that eventually must be trimmed, but the safety conditions differ.

**OT trimming** is straightforward because history is a linear log. The server periodically snapshots the full document state (every N operations, or every few minutes) and can discard operations older than the snapshot. A late-joining client behind the snapshot simply receives the snapshot plus the operations after it; it never needs the discarded ops. Version history for user-facing undo is kept separately and can be pruned to a retention window. The only subtlety is keeping enough ops in the buffer to serve any currently-connected client whose base revision is old — you cannot trim ops that a live client might still reference.

**CRDT garbage collection** is harder because tombstones must survive as long as any replica might still reference them. You cannot delete a tombstoned character if some disconnected replica could later send an insert anchored to it. Safe GC requires knowing that *all* replicas have seen the deletion — typically tracked via a version vector of "all sites have seen up to here," which in turn requires either a known peer set or a quorum/lease mechanism. Yjs implements GC for deleted items once it can prove no peer needs them; Automerge handles bloat via **compaction** — materialise the current state into a fresh document with a new history starting point, discarding the old operation graph. Compaction is simpler and safer than incremental tombstone GC but produces a history break (you lose the ability to undo across the compaction boundary unless you archive the old graph). For long-lived documents (a Notion page edited daily for years), periodic compaction is essential or the CRDT metadata grows without bound.

A common pitfall is forgetting that **snapshots and GC interact with undo.** If you trim OT ops or compact a CRDT past the user's undo stack, you break undo. Production systems either keep the user-facing undo stack independent of the trimmed server history (storing the ops needed for undo client-side) or accept that undo only reaches back to the last snapshot.

## Scaling and Bottlenecks

### OT: Single Document Hotspot

A document with 10 editors funnels every operation through one server process — the document is the shard key, not the user. Google Docs solves this by pinning a document to a single server (not a server per editor) and sharding the *document space* across a fleet. The per-document throughput ceiling is one server's transform-and-broadcast loop, typically low thousands of ops/sec, which is plenty for human typing but matters for programmatic edits or huge documents. Failover requires migrating the in-memory document state and log ownership to another server, coordinated via a lease/leader-election layer.

### CRDT: Metadata Bloat

A 100 KB text document becomes 500 KB–2 MB once each character carries an id, anchor, tombstone flag, and lamport timestamp. Mitigations:

- **Block-level CRDTs** that treat a paragraph or block as the unit instead of a character (Notion, Figma).
- **Garbage collection** of tombstones once safe.
- **Compaction** to reset the history.
- **Binary encodings** (Yjs's updates are far smaller than naive JSON).
- **Hybrid CRDT-for-offline + OT-for-online** that periodically collapses to a server snapshot, bounding live metadata.

### Presence Fan-Out

Cursor and selection broadcasting is O(editors²) per document if every editor broadcasts to every other. The fix is a fan-out server that collects, batches, and relays with throttling, plus client-side interpolation. Treat presence as a separate, lossy channel from content.

## Consistency and Replication

- **OT:** Strictly consistent within one document. Revision numbers form a server-assigned total order. Clients apply their own op optimistically, then correct on acknowledgement if the server transformed it. The document is effectively single-writer (the server) from the consistency model's perspective.
- **CRDT:** Strong Eventual Consistency — all replicas that have seen the same operation set are identical. No conflicts to adjudicate because the merge is a deterministic join in a semilattice. Causality is tracked via version vectors so dependent operations (delete the character someone just inserted) apply in the right order.
- **Conflict resolution:** OT uses server authority and a deterministic tiebreak for same-position edits. CRDT uses deterministic tie-breaking by globally unique ids — there is never a conflict to resolve, only a question of whether the deterministic result is ergonomic.

## Caching Strategy

| Cache | Strategy | Purpose |
|-------|----------|---------|
| Document state | In-memory per server | Avoid rebuilding the document from the op log on every read/edit |
| Recent operations | In-memory sliding window (last 5 min or N ops) | Fast replay for late-joining clients |
| Version snapshots | Object storage, every 1000 ops or few minutes | Cold-load without replaying entire history |
| Presence | Redis pub/sub, 10s TTL | Real-time cursor/collaborator visibility without persisting noise |
| Client reconnect buffer | Client-side IndexedDB | Replay local edits after reconnect; CRDT stores full local op log |

The snapshot cadence is a tuning knob: too frequent and you spend bandwidth/storage on snapshots; too rare and late-joiners replay long op streams. The right number is "snapshot when the op-replay cost for a fresh join exceeds the snapshot transfer cost," typically a few thousand ops or a few minutes.

## Weaknesses and Improvements

- **OT complexity explosion:** adding a new operation type (split a table row, move a block) means defining `T` against every existing type — the O(n²) rule matrix. This is why OT-based rich editors evolve slowly. CRDTs avoid this by making "the op" just "insert/delete an element with an id," regardless of what the element is.
- **CRDT interleaving:** two users typing at the same cursor can produce "HeWlolorld." Mitigations: batch a user's keystroke burst into one atomic insert, server-side reordering, or a hybrid OT pass on top of the CRDT.
- **CRDT metadata cost:** the per-character id and tombstone overhead is the structural tax for serverless convergence. Block-level CRDTs and compaction are the main levers.
- **Undo asymmetry:** OT undo is clean (inverse + transform); CRDT undo requires compensating operations and careful per-user stack management, and history trimming can break it.
- **Rich text formatting:** OT models formatting as range operations that must themselves be transformed against inserts/deletes that move the range. CRDTs model formatting as "mark" CRDTs — a set of marks anchored to character id ranges — which compose cleanly but make overlapping bold/italic from different users another deterministic-merge case.
- **Long-lived documents:** without compaction, a CRDT document edited for years grows unbounded; without snapshotting, an OT log does the same. Both need explicit lifecycle management.

---

## Interview Question

**Question:** Two users start with the empty document. User A types "Hi" and user B types "Yo" at the same time, both at position 0, over a flaky connection. Walk through exactly what an OT system and a CRDT system each do, and explain why OT requires a central server for this case while a CRDT does not.

**Model answer.** In OT, both clients send `insert("Hi", 0)` and `insert("Yo", 0)` against the same base revision. Without coordination, client A would apply "Hi" then "Yo" producing "HiYo", while client B applies "Yo" then "Hi" producing "YoHi" — divergence. The central server's job is to impose one order: it receives A's op first, applies it (revision -> "Hi"), then *transforms* B's op against A's. The transform function sees both inserts target position 0 and applies the deterministic tiebreak (say, A's client id sorts first), so B's "Yo" is shifted to position 2, yielding "HiYo" — and the server broadcasts that order to both clients so both converge. The server exists to collapse the two possible transformation paths into one; without it, you'd need the transform function to satisfy TP2 so that `T(O_B, O_A)` and `T(O_A, O_B)` lead to the same final state regardless of path, which is far harder and rarely done in practice.

In a CRDT, "Hi" and "Yo" are sequences of character inserts, each with a unique id `(site, counter)` and an anchor ("after the document start"). When the two replicas sync, the merge function orders concurrent inserts after the same anchor by comparing ids: all of A's characters have A's site id, all of B's have B's, so the merge deterministically places A's run before B's (or vice versa) on *both* replicas with no server involved. Because the merge is a join-semilattice operation — commutative, associative, idempotent — the delivery order and any duplicate retransmits do not matter; both replicas compute the same least upper bound. The CRDT pays for this with per-character ids and the risk of interleaving (if the characters were interleaved by id rather than grouped, you could get "HYio"), but it needs no sequencer for correctness.

**Common pitfall.** Answering "the server resolves the conflict" for OT without naming the *transform function* and the *tiebreak* — the server does not pick a winner, it linearises and transforms. For CRDT, the pitfall is saying "last write wins" — that is an LWW register, not a sequence CRDT; sequence CRDTs order by id, not timestamp, so neither write is "lost." A deeper pitfall is claiming CRDTs "never have conflicts" — true at the data level, but the deterministic merge can still produce user-hostile interleaving, which is a UX conflict even if it is not a consistency conflict.

---

## Related
- [[topic-queue]]
- [[Weakness Vault/Day-19-Collaborative-Editor]]

---

## Interview Cheat Sheet

**Key Points to Remember:**
- OT (Operational Transformation): transform incoming operations against concurrent ones. Requires central server for ordering. Used by Google Docs.
- CRDTs: data structures that merge without conflicts by design. Decentralized. Used by Figma, Notion, Yjs.
- OT is simpler to understand but harder to implement correctly; CRDTs are harder to understand but composable
- The core challenge is preserving intent — two users typing at the same position shouldn't delete each other's text
- Latency matters: high-latency edits cause "jumping" — debouncing and optimistic UI are essential

**Common Follow-Up Questions:**
- "How does Google Docs handle real-time collaboration?" — OT with a central server serializing all operations. Operational log is the source of truth.
- "When would you choose CRDTs over OT?" — When you need offline editing, peer-to-peer collaboration, or no central server. CRDTs merge automatically on reconnect.
- "How do you handle cursor positions during concurrent edits?" — Map cursor positions through the transformation function (OT) or use a position-based CRDT counter.

**Gotcha:**
- OT correctness depends on transformation properties TP1 and TP2 — most custom implementations get these wrong. Use a proven library (ShareDB, Yjs, Automerge) rather than implementing from scratch.
