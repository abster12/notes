---
title: "Distributed Tracing"
type: system-design
category: Advanced
date: 2026-05-20
tags: [system-design, interview, advanced, observability, tracing, opentelemetry, jaeger, zipkin, sampling, service-mesh]
aliases: []
---

# Distributed Tracing

## Summary & Interview Framing

A system that follows a single request across service boundaries, recording a tree of spans that shows which service caused the delay. It propagates trace context through headers, samples traces to control cost, stores spans in a queryable backend, and reconstructs the full causal chain across process boundaries.

**How it's asked:** "Design a distributed tracing system for 200 microservices handling 1M RPS. Cover context propagation, sampling strategy, storage, and queryability."

---

## Overview

Distributed tracing tracks a single request as it propagates through dozens or hundreds of microservices, recording each hop's latency, metadata, and outcome. It is the forensic tool of observability — while metrics tell you *that* something is slow, and logs tell you *what* happened at one service, traces tell you *where in the call chain* the bottleneck lives and *why* a particular request took the path it did. In a microservice architecture where a single user action can fan out across twenty downstream services, two message queues, and three database shards, there is no other signal that reconstructs the full causal chain across process boundaries.

The "three pillars" of observability are **metrics** (aggregate numbers, cheap, always-on), **logs** (per-service strings, medium cost, searchable), and **traces** (end-to-end request journeys, expensive, sampled). Tracing is the only pillar that preserves the causal chain across service boundaries, making it indispensable for root-cause analysis of latency anomalies and cross-service failures. The fundamental tension in distributed tracing is between visibility and cost: every span you capture costs CPU, network bandwidth, and storage, yet every span you drop is a potential blind spot exactly when you need it most. At staff-level interviews, distributed tracing tests your understanding of **propagation mechanics** (how context survives process boundaries), **sampling strategies** at scale (head-based versus tail-based, probabilistic versus adaptive), and the trade-off between **tail latency visibility and infrastructure cost**.

### The Three Pillars Compared

| Dimension | Metrics | Logs | Traces |
|---|---|---|---|
| Unit of data | Aggregate numbers (counters, gauges, histograms) | Per-service string/structured records | End-to-end request journey (span DAG) |
| Cardinality | Low (fixed label sets) | High (free-text, many fields) | High (per-request trace IDs, span IDs) |
| Cost | Low — cheap to store and query | Medium — searchable but voluminous | High — most expensive per GB |
| Always-on? | Yes — always collected | Yes (typically) | No — sampled at 0.1%–1% at scale |
| Causal chain across services? | No — aggregates only | No — per-service only | **Yes — only pillar preserving cross-service causality** |
| Best for | Alerting, dashboards, SLO tracking | Debugging a single service's behavior | Root-cause of latency anomalies, cross-service failures |
| Query pattern | Time-series aggregation | Full-text / structured search | Trace-by-ID, service/operation search, waterfall view |
| Typical retention | Weeks to months (downsampled) | Days to weeks | 24–72h full; 7d errors; weeks with object-store backends |

## The Trace and Span Data Model

A **trace** represents the complete journey of a single request — or more precisely, a single causal execution tree — from its entry point through every downstream service, queue, and database call. A trace is not a single record but a directed acyclic graph (DAG) of **spans**, where each span represents one logical unit of work: an HTTP request, a database query, a message publish, a cache lookup, or even an internal function call that an engineer chose to instrument. The root span is the outermost operation, typically the API gateway or ingress controller that first received the request, and every subsequent span is a child of either the root or another span, forming a tree whose edges represent parent-child causality.

Each span carries a rich set of metadata. The **trace ID** is a globally unique 128-bit identifier (typically a random hex string) that links all spans belonging to the same request; it is generated at the entry point and propagated unchanged to every downstream service. The **span ID** is a 64-bit unique identifier for the individual span. The **parent span ID** references the span that caused this span to be created, and this parent-child linkage is what reconstructs the call tree when spans are assembled in the tracing backend. Beyond identifiers, each span records an **operation name** (e.g., `POST /payment/charge`), **start time** and **duration** in nanosecond resolution, a **status code** (OK or ERROR), a set of **attributes or tags** (key-value pairs like `http.status_code=200`, `db.system=postgres`, `peer.service=inventory`), **span events** (timestamped log entries within the span's lifetime), and **span links** (references to spans in other traces, used for fan-out and batch processing scenarios). The **resource** attribute block attaches static context about the process that emitted the span: service name, host name, Kubernetes pod ID, container image, cloud region, and so on.

### Trace / Span Tree Structure

```
                         ┌──────────────────────────────────────────┐
                         │  SPAN A: "GET /api/order"                │
                         │  service: api-gateway   (ROOT span)      │
                         │  trace_id:   4bf92f…e4736  (128-bit)     │
                         │  span_id:    00f067aa0ba902b7 (64-bit)   │
                         │  parent:     (none — root)               │
                         │  duration:   t=0ms ────────────── t=500ms│
                         └─────────────────┬────────────────────────┘
                                           │
                            ┌──────────────┴──────────────┐
                            │                             │
              ┌─────────────▼──────────────┐  ┌───────────▼────────────────┐
              │ SPAN B: "POST              │  │ SPAN C: "POST              │
              │  /inventory/reserve"       │  │  /payment/charge"          │
              │  service: inventory        │  │  service: payment          │
              │  span_id:  a1b2…0001       │  │  span_id:  a1b2…0003       │
              │  parent:   00f067…02b7     │  │  parent:   00f067…02b7     │
              │  t=10ms ──────── t=200ms   │  │  t=210ms ──────── t=480ms  │
              │  tags: {item_id, quantity} │  │  status: ERROR             │
              └─────────────┬──────────────┘  │  tags: {error.type:        │
                            │                 │         "card_declined"}   │
              ┌─────────────▼──────────────┐  └────────────────────────────┘
              │ SPAN D: "SELECT …          │
              │  FROM stock"   (database)  │
              │  span_id:  a1b2…0002       │
              │  parent:   a1b2…0001       │
              │  t=50ms ────── t=190ms     │
              │  tags: {db.system: postgres│
              │         db.statement: …}   │
              └────────────────────────────┘

  ── Trace ID is SHARED by every span in the tree (never changes).
  ── Span IDs chain together via parent_span_id to reconstruct the tree.
  ── Edges = parent→child causality.  The root has no parent.
```

A critical distinction is between **span kind** — `CLIENT`, `SERVER`, `PRODUCER`, `CONSUMER`, `INTERNAL` — which tells the backend how to interpret the span's role in the trace graph. A `CLIENT` span represents the caller's perspective of an outbound request, while the corresponding `SERVER` span represents the callee's perspective. Together they form a single logical hop with two spans, allowing each side to measure its own contribution to latency (network time vs. processing time). `PRODUCER` and `CONSUMER` spans serve the same purpose for asynchronous messaging, where there is no synchronous response to close the loop.

## Context Propagation

Context propagation is the hardest part of distributed tracing, and it is the number one cause of broken traces in production. The core idea is simple: every cross-process call must carry a small set of identifiers — the trace ID, the current span ID, and sampling flags — so that the receiving service can create a child span linked to the correct parent. Without this, each service generates its own independent trace, and what should be a single end-to-end trace becomes N disconnected fragments. The mechanism is the injection of trace context into request headers (for HTTP/gRPC), message metadata (for queues), or RPC metadata (for thrift/gRPC), and the extraction of that context on the receiving side. Every instrumentation library must handle both injection and extraction; missing either one breaks the chain.

### Context Propagation Across Services

```
  ┌─────────────┐   traceparent: 00-{traceID}-{spanA}-01   ┌─────────────┐   traceparent: 00-{traceID}-{spanB}-01   ┌─────────────┐
  │  Service A  │  ──────────────────────────────────────► │  Service B  │  ──────────────────────────────────────► │  Service C  │
  │  (gateway)  │                                           │ (inventory) │                                           │  (payment)  │
  │             │  B extracts header:                       │             │  C extracts header:                       │             │
  │  span_id: A │   parent = A                              │  span_id: B │   parent = B                              │  span_id: C │
  │  parent: ∅  │   creates span B as child of A            │  parent: A  │   creates span C as child of B            │  parent: B  │
  │             │   injects NEW traceparent (spanB parent)  │             │   injects NEW traceparent (spanC parent)  │             │
  └─────────────┘                                           └─────────────┘                                           └─────────────┘

  ── Trace ID NEVER changes for the lifetime of the request.
  ── Each receiver becomes the parent for the next hop; only span IDs chain.
  ── Missing injection OR extraction at any boundary fragments the trace.
```

### W3C Trace Context

The W3C Trace Context specification (RFC-level standard adopted in 2020) defines two HTTP headers: `traceparent` and `tracestate`. The `traceparent` header carries the core trace identity in a fixed, parseable format: `00-{trace-id}-{parent-id}-{trace-flags}`, where `00` is the version, the trace ID is a 32-character lowercase hex string (128 bits), the parent ID is a 16-character hex string (64 bits) representing the current span's ID, and the trace flags is a 2-character hex field whose least significant bit is the sampled flag. For example, `traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01` indicates version 0, a trace ID of `4bf92f…`, a parent span ID of `00f067…`, and the sampled flag set to 1. The `tracestate` header is an optional companion that allows vendors to propagate additional, vendor-specific opaque state as a list of key-value pairs (e.g., `tracestate: congo=t61rcWkgMzE,rojo=00f067aa0ba902b7`). This extensibility mechanism lets tracing vendors carry custom routing or sampling hints without breaking the standard `traceparent` format, and multiple vendors can coexist on the same trace.

When service B receives an HTTP request from service A, it extracts the `traceparent` header, parses the trace ID and parent span ID, creates a new span with a freshly generated span ID (setting its parent to the extracted span ID), and when it makes outbound calls to service C, it injects a new `traceparent` with the same trace ID but its own span ID as the parent. The trace ID never changes for the lifetime of the request; only the span IDs chain together. The W3C standard replaced the earlier proliferation of vendor-specific header formats and is now the default in OpenTelemetry, meaning new instrumentation "just works" across W3C-compliant services without configuration.

### B3 Propagation

Before W3C standardization, Zipkin's **B3** propagation format was the de facto industry standard, and it remains widely deployed — particularly in Spring Cloud Sleuth, legacy Java ecosystems, and service meshes like Istio's older versions. B3 uses multiple separate headers: `X-B3-TraceId` (64 or 128 hex), `X-B3-SpanId` (64 hex), `X-B3-ParentSpanId` (64 hex, optional), `X-B3-Sampled` (either `1`/`0` or `true`/`false`), and `X-B3-Flags` (for debug-mode tracing, where `1` means "trace this request at all costs"). The multi-header approach is more verbose but also more readable and easier to debug manually. The critical operational concern is **mixed propagation environments**: if some services use B3 and others use W3C, context can be silently lost at the boundary. OpenTelemetry's propagator API supports both formats simultaneously (via the `composite` propagator), and during migration it is common to inject both B3 and W3C headers while extracting from whichever is present. A stable production strategy is to standardize on W3C at the edge (load balancer, API gateway) and use composite propagation internally until all services are migrated.

### Propagation Across Async Boundaries

For message queues (Kafka, RabbitMQ, SQS, Pub/Sub), trace context is injected into message headers or metadata rather than HTTP headers. Kafka supports record headers, SQS supports message attributes, and RabbitMQ supports AMQP headers. The pattern is identical: the producer injects context before publishing, the consumer extracts it upon receipt. The subtlety is that the consumer typically creates a new span with `SpanKind.CONSUMER` that is linked to (rather than a direct child of) the producer's `SpanKind.PRODUCER` span, because the asynchronous boundary means there may be a temporal gap, retries, or multiple consumers. For batch processing where a single consumer processes messages from many producers, **span links** are used instead of parent-child relationships, allowing one consumer span to reference multiple producer spans across different traces. The `traceparent` format can also be carried over W3C's `baggage` mechanism, which propagates application-level key-value pairs (like `user.tier=premium` or `region=us-east`) alongside trace context — useful for carrying business context that every downstream service should see.

> **Common Pitfall:** Context propagation breaks are the number one failure mode in distributed tracing. Every new service integration, every message queue hop, every serverless function invocation, every load balancer that strips unknown headers, every third-party SDK that doesn't participate in context propagation — if context isn't carried through, the trace fragments. Mitigation: deploy canary detectors that flag traces with depth mismatch (expected 5 spans, observed 3), and use OpenTelemetry's auto-instrumentation agents which automatically propagate context for common libraries (HTTP clients, gRPC, Kafka, database drivers) without code changes.

## Instrumentation with OpenTelemetry

OpenTelemetry (OTel) is a CNCF project — the second most active after Kubernetes — that provides vendor-neutral APIs, SDKs, and a collector for all three observability signals (traces, metrics, logs). Before OTel's emergence around 2019, every tracing vendor (Jaeger/Uber, Zipkin/Twitter, Datadog, Lightstep, Dynatrace) shipped its own proprietary SDK. Migrating between vendors meant rewriting instrumentation across hundreds of services. OTel solves this by providing a single, standard API that applications code against, with pluggable exporters that send data to any backend. The application never imports vendor-specific code; it imports the OTel API, and the OTel SDK (configured at deployment time) handles the actual export.

OTel has three architectural layers:

- **API layer** — interfaces for creating spans, setting attributes, recording events, and propagating context. This is what application code calls, and it has zero dependencies on any specific backend.
- **SDK layer** — implements the API with configurable processors, samplers, and exporters; it is language-specific (Java, Go, Python, Node.js, .NET, Rust, etc.) and is where you configure sampling rates, batching, and export destinations.
- **Collector** — a standalone binary, deployed separately from application processes, that receives telemetry from SDKs, processes it (batching, filtering, tail-sampling, attribute enrichment, redaction of sensitive data), and exports it to one or more backends.

This three-tier separation means you can change backends without touching application code, and you can do heavy processing (like tail-based sampling) in the collector rather than in every service process.

A powerful feature of OTel is **auto-instrumentation**: language-specific agents (the Java agent, the Python `opentelemetry-instrumentation` packages, the Node.js auto-loader) automatically instrument common libraries — HTTP servers/clients, gRPC, database drivers (PostgreSQL, MySQL, Redis), message queue clients (Kafka, RabbitMQ), web frameworks (Spring, Express, Flask, Django) — without requiring any code changes. This means a Java service can get full distributed tracing by simply attaching the OTel agent with `-javaagent:opentelemetry-javaagent.jar` and setting export configuration via environment variables.

### Instrumentation Steps (Manual)

For manual instrumentation of business logic, the workflow is:

- Obtain a tracer from the OTel API (e.g., `otel.Tracer("order-service")`).
- Start a span from the current context, passing a name and optional attributes — this returns a new context carrying the active span.
- Set attributes on the span for business-relevant data (IDs, values, decisions).
- `defer span.End()` (or equivalent) so the span is closed when the function returns — forgetting this leaks spans and corrupts timing.
- Record errors and set the span status to `Error` when operations fail, so the backend surfaces them.
- **Thread the context object through every downstream call** (the `context.Context` in Go, the equivalent in other languages) so implicit propagation works — goroutines, async tasks, or libraries that ignore context will break the chain.

```go
// Manual span creation in Go
func handleOrder(ctx context.Context, orderID string) error {
    tracer := otel.Tracer("order-service")
    ctx, span := tracer.Start(ctx, "handleOrder",
        trace.WithAttributes(
            attribute.String("order.id", orderID),
            attribute.Int64("order.value", 4200),
        ),
    )
    defer span.End()

    if err := reserveInventory(ctx, orderID); err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return err
    }
    return chargePayment(ctx, orderID)
}
```

The key pattern is passing the `context.Context` (in Go) or equivalent context object (in other languages) through every function call. The tracer stores the current active span in the context, so when `reserveInventory` makes an HTTP call to the inventory service, the OTel HTTP client instrumentation automatically extracts the parent span from the context and injects the traceparent header. This implicit propagation through context objects is why manual context threading is critical: if a function creates a goroutine, spawns an async task, or calls a library that doesn't accept a context parameter, the trace chain breaks.

> **Interview Signal:** Mentioning OpenTelemetry (not vendor-specific SDKs) signals awareness of modern observability standards and vendor-neutrality. Mentioning auto-instrumentation versus manual instrumentation, and knowing that the Collector can do tail-sampling, are staff-level differentiators.

## Sampling Strategies

Sampling is the fundamental scale-management mechanism in distributed tracing. At Google, Uber, and Meta scale, tracing every request is computationally and economically impossible. With 10 million requests per second and an average of 10 spans per request, that is 100 million spans per second — over 8.6 trillion spans per day. At roughly 500 bytes per span, that is 4.3 petabytes per day of raw span data, before indexing, replication, or query acceleration. Sampling reduces this volume by orders of magnitude while attempting to preserve representative visibility into system behavior. The art of sampling is choosing which traces to keep and which to drop, and the choice has profound implications for what you can and cannot observe.

### Head-Based Sampling

Head-based sampling makes the sampling decision at the **entry point** of the request — the load balancer, API gateway, or first service — before any downstream calls are made. The decision is typically a simple probabilistic coin flip: sample this request with probability *p* (e.g., 0.1% or 1%), and if sampled, set the `sampled` flag in the trace context so that every downstream service knows to record and export its spans. The critical property is that the decision is made once and propagated: all services in the call chain either all record their spans (producing a complete trace) or all drop them (producing nothing). This is called **multi-span head sampling** or **probabilistic head sampling**, and it is the industry default for high-throughput systems.

The advantage of head-based sampling is simplicity and consistency. The decision is O(1), requires no buffering, and produces complete traces — never fragments. The overhead is minimal: one random number generation per request at the edge. The disadvantage is that it is **uniformly blind to trace characteristics**: a fast, successful request and a slow, failing request have exactly the same probability of being sampled. At 0.1% sampling, a P99.9 latency event (1 in 1,000 requests) has only about a 10% chance of being captured. For a system processing 1 million RPS, that is 1,000 slow requests per second — and head sampling will miss approximately 900 of them. This is the **sampling visibility gap**: head sampling is biased toward normal requests, which are the least interesting ones.

A dangerous anti-pattern is **single-span head sampling**, where each service independently decides whether to sample (rather than honoring a propagated decision). Service A samples its span; service B independently decides not to. The result is trace fragmentation — incomplete call trees where child spans are missing, making the trace useless for root-cause analysis. This should never be used in production; the sampled flag must always be propagated and honored.

### Tail-Based Sampling

Tail-based sampling defers the sampling decision until the **entire trace is complete** (or a timeout has elapsed). The collector buffers all spans for a given trace ID — waiting for the request to finish across all services — and then applies sampling policies based on the trace's actual characteristics: total latency, error status, number of spans, specific service involvement, or custom attributes. For example, a policy might be: "always keep traces with errors, always keep traces slower than 500ms, and probabilistically sample 0.1% of the rest." This deterministic capture of interesting traces is the key advantage: every error and every latency outlier is preserved, regardless of how rare they are.

The cost of tail-based sampling is buffering and complexity. The collector must hold all spans for a trace in memory until the trace completes or a timeout fires (typically 10–30 seconds). At high throughput, this buffer is enormous: 10 million spans per second with a 10-second buffer means 100 million spans resident in collector memory — tens of gigabytes of RAM. The solution is to distribute tail-sampling across a collector fleet using **consistent hashing by trace ID**, ensuring that all spans for a given trace land on the same collector instance. This requires a load-balancing layer (an OTel Collector in "router" mode) that hashes the trace ID from incoming span data and forwards to the appropriate tail-sampling collector. If a collector crashes, all in-flight traces it was buffering are lost — a trade-off between memory cost and fault tolerance. Some implementations spill to disk or use a distributed cache (Redis) for the buffer, but this adds latency to the sampling decision.

Tail-based sampling is not a binary choice but a policy engine. Real-world policies combine multiple rules with AND/OR logic: "keep if (duration > P99 OR status = ERROR) AND service in [checkout, payment]", or "keep 100% of traces involving the auth service, 1% of others." The OpenTelemetry Collector ships with a tail-sampling processor supporting policies like `always_sample`, `latency`, `status_code`, `numeric_attribute`, `string_attribute`, `rate_limiting`, and `and`/`composite` combinators. The art is tuning these policies to maximize signal (interesting traces kept) while minimizing noise (boring traces dropped) within a target storage budget.

### Adaptive and Probabilistic Sampling

**Probabilistic sampling** is the simplest strategy: sample each trace with a fixed probability *p*. It is easy to reason about and implement but, as discussed, uniformly samples across all trace characteristics. **Adaptive sampling** dynamically adjusts the sampling rate based on observed conditions. One approach is **per-service adaptive sampling**: the collector monitors the incoming span rate per service and adjusts each service's sampling probability to hit a target span throughput. A service receiving 1 million requests per second might be sampled at 0.01%, while a low-traffic service receiving 100 requests per second might be sampled at 100% — both contributing roughly the same number of spans to the backend. This ensures that rare, low-traffic services (often the most poorly understood) get full visibility while high-traffic services don't overwhelm the pipeline.

Another adaptive approach is **latency-aware sampling**: the sampling rate is increased for services or endpoints that are currently exhibiting high latency or elevated error rates, and decreased for healthy ones. This requires the sampling layer to have feedback from metrics or from the trace data itself, creating a control loop. The danger is oscillation: if sampling increases, you see more traces, which might reveal more problems, which increases sampling further. Production implementations use dampening (slow adjustment) and hysteresis (don't change direction too quickly). Some organizations use **stratified sampling**: different sampling rates for different strata of requests (e.g., 100% for premium-tier users, 10% for free-tier, 100% for checkout, 0.1% for health checks), which is more expressive than a single global rate.

### Head-Based vs Tail-Based Sampling

```
  HEAD-BASED  (decision at entry — before any downstream call):

   ┌─────────┐  coin flip p=0.1%   ┌─────────┐            ┌─────────┐
   │  Edge   │──sampled flag──────►│  Svc B  │───────────►│  Svc C  │
   │  Svc A  │  set in traceparent │ records │            │ records │
   └─────────┘                     └─────────┘            └─────────┘
        │                              │                       │
        └──────── decision propagated (all-or-nothing) ─────────┘
        ⇒ either a COMPLETE trace is exported, or NOTHING is exported.
        ⇒ O(1), no buffering, but blind to latency/errors.

  TAIL-BASED  (decision AFTER the entire trace completes):

   ┌─────────┐         ┌─────────┐         ┌─────────┐    ┌─────────────────────────┐
   │  Svc A  │────────►│  Svc B  │────────►│  Svc C  │───►│  Collector BUFFERS all  │
   │ emits   │         │ emits   │         │ emits   │    │  spans by traceID       │
   │ spans   │         │ spans   │         │ spans   │    │  (10–30s window)        │
   └─────────┘         └─────────┘         └─────────┘    └────────────┬────────────┘
                                                                     │ trace complete
                                                                     ▼
                                                       ┌───────────────────────────┐
                                                       │ Policy engine:            │
                                                       │  duration > 500ms?  KEEP  │
                                                       │  status = ERROR?    KEEP  │
                                                       │  else 0.1%?         KEEP  │
                                                       └─────────────┬─────────────┘
                                              KEEP ◄─────────────────┴────────────────► DROP
        ⇒ deterministically captures every error & outlier regardless of rarity.
        ⇒ requires buffering + consistent-hash routing; collector crash loses in-flight traces.
```

### Sampling Strategy Comparison

| Strategy | Decision point | Cost / overhead | Trace completeness | Captures rare outliers? | Best for |
|---|---|---|---|---|---|
| **Head-based (multi-span)** | Entry point (edge) | O(1), minimal — one coin flip | Complete (all-or-nothing) | No — uniformly blind to characteristics | High-throughput baseline; broad coverage |
| **Single-span head** (anti-pattern) | Each service independently | Low | **Fragmented** — broken trees | No | Never use in production |
| **Tail-based** | After full trace completes | High — buffering (GBs RAM), router tier | Complete (decided post-hoc) | **Yes** — deterministic capture of errors/latency | Critical paths; P99.9+ outlier diagnosis |
| **Probabilistic** | Fixed probability *p* | Low | Complete (if head-propagated) | No | Simple reasoning, predictable volume |
| **Adaptive (per-service)** | Dynamic, per-service | Medium — feedback control loop | Complete | Partial — balances volume across services | Mixed-traffic fleets; low-traffic visibility |
| **Latency-aware adaptive** | Dynamic, by observed latency/error | Medium-high — control loop + metrics feedback | Complete | Yes — increases rate when unhealthy | Incident response, regression detection |
| **Stratified** | Per-stratum rules (tier/endpoint) | Low-medium | Complete | Partial — per-stratum targeting | Business-tier-aware visibility |

> **Key Choice:** Head-based sampling at 0.1%–1% is the industry default for high-throughput systems because it is simple, cheap, and produces complete traces. Tail-based sampling is reserved for critical paths where you must deterministically catch every P99.9+ outlier and every error. In practice, many organizations run both: head-based sampling as the baseline (cheap, broad coverage) plus tail-based sampling in a collector tier for critical services (deterministic capture of interesting traces). Adaptive sampling adds a dynamic layer on top to manage volume as traffic patterns shift.

## Span Collection and Storage

### The Collection Pipeline

The standard collection architecture is a three-tier pipeline: application processes emit spans to a local collector tier, the collector tier processes and batches spans, and the backend stores and indexes them for querying. In a Kubernetes environment, the local collector is typically deployed as a **DaemonSet** (one collector pod per node), receiving spans from all application pods on that node via gRPC or HTTP. This minimizes network hops — spans go to the local node's collector rather than across the cluster — and provides a failure boundary: if the backend is down, the local collector buffers spans in memory or on disk, preventing backpressure from reaching application processes. An alternative deployment is a **gateway deployment** (a pool of collectors accessible via a cluster-level service), which simplifies configuration (all apps point to one address) but adds a network hop. Some organizations use a hybrid: DaemonSet collectors on each node feed a smaller pool of gateway collectors that do tail-sampling and export to the backend.

### OpenTelemetry Collection Pipeline

```
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │  NODE  (Kubernetes)                                                          │
  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                          │
  │  │  App Svc 1  │  │  App Svc 2  │  │  App Svc 3  │   OTel SDK + auto-instr  │
  │  │  (Java agent│  │  (Go agent) │  │  (Python)   │   emits spans via OTLP   │
  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                          │
  └─────────┼────────────────┼────────────────┼─────────────────────────────────┘
            │   local hop    │                │   (same node — minimal network)
            ▼                ▼                ▼
  ┌─────────────────────────────────────────────────────┐
  │  OTel Collector — DaemonSet (one per node)           │
  │  ┌────────────┐    ┌───────────────┐    ┌─────────┐  │
  │  │  RECEIVERS │───►│  PROCESSORS   │───►│ EXPORTERS│ │
  │  │  OTLP,     │    │  batch,       │    │ OTLP,    │ │
  │  │  Jaeger,   │    │  filter,      │    │ Jaeger,  │ │
  │  │  Zipkin    │    │  redact,      │    │ Tempo,   │ │
  │  │            │    │  route,       │    │ Datadog, │ │
  │  │            │    │  tail-sample  │    │ Kafka,   │ │
  │  └────────────┘    └───────────────┘    └────┬────┘  │
  └──────────────────────────────────────────────┼───────┘
                                                  │  (cluster hop)
                                                  ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Gateway Collector pool (optional — tail-sampling tier)  │
  │  consistent-hash by traceID → buffer → policy → export   │
  └──────────────────────────┬───────────────────────────────┘
                             │
                             ▼
  ┌───────────────────────────────────────────────────────────┐
  │  STORAGE BACKEND                                          │
  │  Jaeger (Cassandra/ES)  •  Tempo (S3/GCS object store)    │
  │  Datadog  •  Splunk  •  Honeycomb                         │
  │  indexed by (service, op, ts) + trace_id; queryable       │
  └───────────────────────────────────────────────────────────┘

  ── ~10K–50K spans/sec per collector instance; scale horizontally.
  ── If backend is down, local collector buffers (memory/disk) → no app backpressure.
  ── DaemonSet = fewest hops; Gateway = simpler config; Hybrid = both.
```

The OpenTelemetry Collector is the de facto standard for this middle tier. It is a single binary with a pluggable pipeline architecture: **receivers** accept telemetry (OTLP, Jaeger, Zipkin, Prometheus, Syslog), **processors** transform it (batching, tail-sampling, attribute filtering, redaction, routing by service name), and **exporters** send it to backends (Jaeger, Tempo, Datadog, Splunk, S3, Kafka). The collector can run multiple pipelines in parallel, routing traces to different backends based on service name or environment. A single collector instance handles approximately 10,000–50,000 spans per second; at higher throughput, you scale horizontally with a load-balancing layer in front.

### Storage Backends

The storage backend is where traces become queryable and where cost explodes. There are two dominant architectural patterns.

**Jaeger's Cassandra/Elasticsearch model:** Jaeger stores spans in Cassandra (or Elasticsearch) with two data paths: an index by `(service, operation, timestamp)` for trace discovery queries (e.g., "find traces in the payment service with operation `POST /charge` in the last hour"), and a storage path by `trace_id` for full trace retrieval. The index enables fast search by service and operation name, which are low-cardinality dimensions. The problem is high-cardinality tag search: querying `user_id=12345` requires scanning all spans in the time window because building secondary indexes on high-cardinality tags is prohibitively expensive in Cassandra. Elasticsearch handles tag search better but at much higher infrastructure cost. This model works well at moderate scale (millions of traces per day) but becomes cost-prohibitive at petabyte scale due to Cassandra's storage overhead and operational complexity.

**Grafana Tempo's object-store model:** Tempo takes a fundamentally different approach — it stores traces as flat, compressed blocks in S3 or GCS, similar to how Prometheus stores metrics and how Loki stores logs. Traces are indexed only by trace ID (using a bloom filter per block), and search by service name or tags is handled via the `tempo-query` component or by integrating with external metadata. The trade-off is that you cannot search for traces by arbitrary tags efficiently; you must know the trace ID, or use Tempo's newer "TraceQL" query language which scans blocks with predicate pushdown. The massive advantage is cost: object storage is 10–100x cheaper than Cassandra or Elasticsearch at petabyte scale, and the operational burden is near-zero (S3 manages durability, replication, and lifecycle). This is the modern playbook — treat traces like logs in cold storage, indexed by ID, searchable via block scans, and retainable for weeks or months rather than hours.

**Retention:** Traces are the most expensive observability signal per gigabyte. Typical retention is 24–72 hours for full traces at high sampling rates, extended to 7 days for error-only traces. Some organizations tier retention: 24 hours at 1% sampling, 7 days at 0.01% sampling, 30 days for error traces only. Tempo's object-store model enables longer retention (weeks to months) because storage is cheap, but query latency for old traces increases as you scan more blocks. Lifecycle policies (S3 transitions to Glacier) can push retention to months or years for compliance, though retrieval becomes minutes-to-hours rather than seconds.

## Distributed Trace Visualization

Trace visualization transforms the flat list of spans into an actionable diagnostic view. The primary visualization is the **waterfall chart** (also called a Gantt chart or flame graph for traces), where each span is a horizontal bar positioned by start time and width proportional to duration, nested by parent-child relationship. The waterfall immediately reveals the critical path — the longest chain of sequential spans from root to leaf — which is the sequence of operations that directly determines the request's total latency. Parallel calls (fan-out) appear as overlapping bars, and the gap between a parent span's start and a child span's start reveals the parent's self-time (time spent in its own logic before calling downstream).

A well-designed trace view shows three levels of detail. At the **trace level**, the user sees the total latency, status, service count, span count, and the critical path highlighted. At the **span level**, clicking a span reveals its attributes, events, and resource information — the HTTP status code, the SQL query text, the cache hit/miss, the error message. At the **aggregate level**, tracing backends offer service dependency graphs (which services call which), latency histograms per service/operation, and comparison views (overlay this trace against the p50 baseline trace for the same operation). Jaeger, Tempo (via Grafana), Datadog, and Honeycomb all offer these views with slightly different UX trade-offs: Jaeger is open-source and functional, Tempo integrates natively with Grafana dashboards, Datadog provides tight metric-trace-log correlation, and Honeycomb focuses on high-cardinality aggregation queries over traces.

The most powerful visualization feature for staff-level diagnosis is **trace comparison**: selecting two traces for the same operation — one slow, one fast — and diffing their waterfalls side by side. This immediately reveals whether the slowness is due to an extra downstream call, a single slow span, or a different code path. Some backends support **statistical trace analysis**: aggregating thousands of traces for an operation and showing the distribution of span counts, per-service latency contributions, and common sub-paths, turning individual traces into a statistical view of the operation's behavior space.

## Correlation with Metrics and Logs

Distributed tracing is most powerful when correlated with the other two observability pillars. The correlation mechanism is the **exemplar**: a metric data point (e.g., a histogram bucket for `http_request_duration_seconds`) that carries a reference to a specific trace ID. When a Prometheus histogram records a request at the P99 latency bucket, it can attach the trace ID of that specific request as an exemplar. In Grafana, clicking a spike in a latency dashboard jumps directly to the trace that caused it, bridging the aggregate (metric) and the individual (trace) without manual log searching. Exemplars require the application to propagate the trace ID into the metric recording call, which OTel facilitates through its shared context API.

Log correlation works through **trace ID injection**: the logging framework is configured to include the current trace ID and span ID in every log line (typically as structured fields, not just string concatenation). When an engineer finds a trace showing a slow payment span, they can query the logging system (Elasticsearch, Loki, Splunk) for all log lines with that trace ID and see the detailed application logs from every service in the trace — the SQL query that was slow, the exception stack trace, the cache miss warning. This turns the trace from "I know the payment service was slow" into "I know the payment service was slow because the database query took 300ms due to a missing index, and here is the exact query." The integration is typically configured once at the logging framework level (e.g., Logback's MDC in Java, structlog's processor in Python) and then automatically applies to all log lines in all services. OTel's log SDK formalizes this by making logs a first-class signal with built-in trace context correlation.

The reverse direction — from logs to traces — is equally important. When an on-call engineer sees an error log, the trace ID in the log line lets them jump to the full trace and see the upstream context: what request triggered this, what other services were involved, whether the error is correlated with slowness elsewhere in the call chain. This bidirectional jump between signals is what makes the "three pillars" more than the sum of its parts.

## Performance Overhead

Tracing overhead is the perennial concern, and it must be measured and managed. The overhead comes from four sources:

- **Span creation** — allocating span objects, generating span IDs, recording start timestamps.
- **Attribute recording** — setting key-value pairs on spans, which involves map allocation.
- **Context propagation** — injecting and extracting headers on every cross-process call.
- **Span export** — serializing spans and sending them over the network to the collector (batched and asynchronous, but can cause backpressure if the collector is slow or unavailable).

The first three are per-request and pay-as-you-go; the fourth is batched and asynchronous but can cause backpressure if the collector is slow or unavailable.

In practice, OTel auto-instrumentation adds approximately **1–5% CPU overhead** at typical sampling rates (1%), with the variance depending on the language runtime (JIT-compiled Java and Go have lower overhead than interpreted Python), the number of spans per request (more instrumentation = more overhead), and the number of attributes per span. Memory overhead is dominated by the span queue: spans are created synchronously but exported asynchronously, so there is a batch buffer (typically 512–2048 spans) in each process. Network overhead is minimal at 1% sampling — a few kilobytes per second per service — but scales linearly with sampling rate. At 100% sampling (which should never be done in production for high-traffic services), overhead can reach 10–20% CPU, degrading application performance measurably.

The mitigation strategies are:

- Keep sampling rates low (0.1%–1% for head-based).
- Use tail-based sampling in the collector to reduce export volume.
- Batch exports (default 5-second batches or 512-span batches, whichever comes first).
- Configure the SDK to **drop spans silently** if the export queue is full rather than blocking application threads (the `BatchSpanProcessor` with `max_queue_size` and `blocking=false` in OTel).

The cardinal rule is that tracing must never degrade application performance: if the collector or backend is down, the SDK should drop spans rather than cause backpressure. This is the "observability must not cause outages" principle.

## Tracing in a Service Mesh

A service mesh (Istio, Linkerd, Consul Connect) provides a unique opportunity for distributed tracing because the sidecar proxy (Envoy, Linkerd2-proxy) sits in the data path of every cross-service call. The proxy can automatically inject and extract trace context — B3 or W3C headers — without the application being aware of it. This means that even services with zero tracing instrumentation get span coverage at the proxy level: the mesh generates `CLIENT` spans on the sending side and `SERVER` spans on the receiving side, capturing the network hop latency without any application code changes. This is called **infrastructure-level tracing** and it provides a baseline of trace coverage across the entire mesh with zero application effort.

The limitation is that proxy-level spans only capture the network hop (the time between the sender's proxy and the receiver's proxy), not the application's internal processing breakdown. A trace showing five proxy spans tells you that the request hit five services and how long each hop took, but not *why* a particular service was slow (was it a slow database query? a lock contention? a GC pause?). For that, you need application-level instrumentation — OTel SDK in the service creating child spans for database calls, cache lookups, and internal logic. The best practice is to use both: the service mesh for automatic, zero-effort baseline tracing, and OTel SDK for deep, application-aware tracing on critical services. The two layers merge in the tracing backend because the mesh-generated spans and the OTel-generated spans share the same trace ID (the mesh propagates context that the OTel SDK picks up).

Istio's tracing integration requires configuration: you specify the sampling rate (e.g., `1%`), the tracer provider (e.g., Zipkin or OTel), and the collector address. Envoy's tracing configuration supports both B3 and W3C propagation, and in newer Istio versions, W3C is the default. Linkerd similarly supports OTel-compatible tracing through its proxy. A subtle operational point: the mesh's sampling rate and the application SDK's sampling rate are independent; if the mesh samples at 1% and the application samples at 100%, the effective trace rate is 1% (the mesh decision is authoritative because it runs at the edge), but the application creates full-span-depth traces for the 1% that the mesh lets through. Misconfiguring this — e.g., mesh samples at 100% for debugging and forgets to revert — can cause a massive spike in span volume that overwhelms the collector and backend.

## Tail-Based Sampling for Latency Optimization

Tail-based sampling is not just a sampling strategy but a latency optimization tool. The core insight is that in distributed systems, **tail latency (P99, P99.9) is caused by rare, complex conditions** — GC pauses, network jitter, cold cache misses, queue contention, cascading retries — that are invisible to head-based sampling. By buffering complete traces and selectively keeping the slow ones, tail-based sampling ensures that the traces you need for diagnosing tail latency are always available.

The implementation challenge is the buffer. Consider a system with 10 million spans per second and a 10-second trace completion window. The tail-sampling collector must buffer up to 100 million spans, grouping them by trace ID and waiting for each trace to complete before applying the sampling policy. At 500 bytes per span, that is 50 GB of buffer — far too much for a single collector. The solution is **consistent hashing partitioning**: a front-end layer of collectors (the "router" tier) hashes the trace ID from each incoming span and forwards it to one of N tail-sampling collectors. Each tail-sampling collector handles 1/N of traces, reducing the per-collector buffer to manageable size (e.g., 50 collectors × 1 GB each). When a trace completes (the root span arrives with an end timestamp, or a timeout fires), the collector evaluates the sampling policies: if the trace's total duration exceeds the latency threshold, keep it; if any span has an error status, keep it; otherwise, probabilistically sample at a low rate. Kept traces are exported to the backend; dropped traces are discarded from the buffer.

The **latency threshold** for tail-sampling policies should be set relative to the service's SLO, not as an absolute number. For a service with a P99 SLO of 200ms, a threshold of 200ms captures all SLO violations. For a more nuanced approach, you can use **percentile-based thresholds**: the collector periodically computes the P99 latency for each service/operation and sets the threshold at 2× P99, ensuring that traces in the long tail (but not the baseline) are captured. This adapts as the system's performance profile changes. Some organizations implement **comparative tail-sampling**: they keep a trace if it is significantly slower than the recent moving average for the same operation, even if it doesn't cross an absolute threshold — useful for catching relative regressions in fast services where 50ms might be an outlier.

A production-grade tail-sampling configuration might combine multiple policies: always keep 100% of error traces, always keep traces above the latency threshold, keep 10% of traces for any service with elevated error rate (detected via a side-channel metric feed), and keep 0.01% of everything else. The OpenTelemetry Collector's `tail_sampling` processor supports these combinations through its `composite` policy, which applies multiple sub-policies and takes the union of kept traces. The total kept volume is then capped by a `rate_limiting` policy to prevent storage overrun during incidents (when error rates spike and every trace would otherwise be kept).

## Production Tracing at Scale

Running distributed tracing in production at scale requires addressing several operational challenges beyond the core architecture.

**Trace completeness** is the first concern. Incomplete traces — where some spans are missing because a service dropped them, a collector crashed, or context propagation broke — are worse than no traces because they give false confidence. The mitigation is a **trace quality monitor**: a background job that samples traces, checks expected span count against actual span count per service, and alerts when the completeness ratio drops below a threshold (e.g., 95%). This catches propagation breaks early, before they affect debugging. Another approach is **synthetic tracing**: periodically send test requests through the full call chain and verify that the resulting trace has all expected spans.

**Collector reliability** is the second concern. If collectors are down, spans accumulate in application SDK buffers and eventually get dropped. The SDK should be configured with bounded queues and `drop_on_overflow` semantics so that tracing never causes application backpressure. Collectors should be deployed with redundancy (multiple instances behind a load balancer) and health-checked. For tail-sampling collectors, the loss of a collector means the loss of all in-flight traces on that collector — acceptable for tracing (which is best-effort) but should be monitored. Some organizations run collectors in a "spill to disk" mode where the buffer is persisted to local SSD, allowing recovery after a collector restart.

**Multi-tenancy and isolation** is critical in large organizations with shared tracing infrastructure. Different teams should not be able to see each other's traces (e.g., payment traces should not be visible to the marketing team), and different environments (prod, staging, dev) should be isolated. OTel Collector supports tenant-based routing (the `tenant` header in OTLP), and backends like Jaeger and Tempo support multi-tenancy with per-tenant retention and quota. At truly massive scale (multiple business units, thousands of services), the tracing infrastructure itself is federated: each business unit runs its own collector tier and backend, with cross-tenant trace links for requests that cross boundaries.

**Cost management** is the perpetual concern. Tracing costs scale with span volume, which scales with RPS × spans-per-request × sampling-rate. The levers are: reduce sampling rate (cheapest, most impactful), reduce spans per request (remove unnecessary instrumentation from high-traffic, low-value operations), reduce retention (accept shorter trace history), and move to cheaper storage (Tempo's object-store model vs. Cassandra). A practical cost model: at 1M RPS, 10 spans/request, 1% sampling, 500 bytes/span, 48-hour retention, the stored volume is approximately 1.7 TB — manageable. At 100% sampling, it's 170 TB — not manageable without significant investment. The ratio between 1% and 100% sampling is 100×, which is why sampling rate is the primary cost lever.

## Capacity Planning

Capacity planning for tracing infrastructure requires modeling span throughput, storage volume, and query load.

**Span throughput model:** `spans/sec = RPS × spans_per_request × sampling_rate`. For a system with 10M RPS, an average of 10 spans per request, and 0.1% head-based sampling, the span throughput is 10,000 spans/sec. This is easily handled by a single OTel Collector instance (capacity ~50K spans/sec). For tail-based sampling at the same rate, you need a router tier (to hash by trace ID) plus tail-sampling collectors with enough aggregate buffer capacity: `buffer_per_collector = (spans_per_sec / num_collectors) × completion_window`. With 10K spans/sec, a 10-second window, and 10 collectors, each collector buffers 10,000 spans — trivially small. But if you increase sampling to 10% (to get better visibility), throughput becomes 100K spans/sec, and each of 10 collectors buffers 100,000 spans (50 MB) — still manageable. At 100% sampling (1M spans/sec), each of 100 collectors buffers 100,000 spans — and the aggregate buffer is 50 GB, requiring careful memory provisioning.

**Storage volume model:** `storage = spans_per_sec × bytes_per_span × retention_seconds × replication_factor`. At 10K spans/sec, 500 bytes/span, 48 hours retention, and 3× replication (Cassandra): 10,000 × 500 × 172,800 × 3 = ~2.6 TB. The same workload with Tempo's object-store model (1× replication, S3 cross-region durability): 10,000 × 500 × 172,800 × 1 = ~864 GB, at S3 costs of roughly $20/month — two orders of magnitude cheaper. This cost differential is why the industry is moving from Cassandra-based backends to object-store-based backends.

**Query load model:** Trace queries fall into two categories: trace-by-ID (O(1) lookup, sub-second) and trace-search (scan by service/operation/tags, seconds to minutes). The backend must handle both without interfering with span ingestion. In Jaeger/Cassandra, trace-by-ID hits the trace_id partition (fast), while search queries hit the service+operation index (moderate) or do full scans for tag queries (slow, can timeout). In Tempo, trace-by-ID hits the bloom filter (fast), while search requires TraceQL block scans (slow but bounded by block count). Capacity planning for query load means provisioning enough query nodes to handle concurrent searches without saturating CPU or I/O, and setting aggressive query timeouts to prevent slow searches from accumulating.

**Growth planning:** Tracing volume grows with the business — new services, new endpoints, new features all add spans. A rule of thumb is to plan for 2× year-over-year growth in span volume and to provision collector and storage capacity at 3× current peak to allow for growth and for emergency sampling-rate increases (e.g., during an incident, you may temporarily increase sampling from 0.1% to 10% to capture more traces, which is a 100× volume spike). The collector tier should be auto-scaled (HPA in Kubernetes, based on CPU and memory), and storage should use lifecycle policies (Tempo/S3) or TTL (Cassandra) to automatically expire old data.

## Common Interview Questions & Answers

### Q: How do you trace a request through an async message queue?

**Answer:** The producer injects trace context into the message metadata (Kafka record headers, SQS message attributes, RabbitMQ AMQP headers) before publishing. The consumer extracts the context upon receipt and creates a follow-up span with `SpanKind.CONSUMER` that is linked to the producer's `SpanKind.PRODUCER` span. The consumer's span shares the same trace ID but starts a new subtree, because the asynchronous boundary means there may be a temporal gap, retries, or multiple consumers processing the same message. For fire-and-forget patterns with no synchronous response, you use `PRODUCER`/`CONSUMER` span kinds instead of `CLIENT`/`SERVER`, and the consumer span links to (not parents) the producer span, since there is no synchronous call chain. For batch consumers processing messages from many producers, span links reference multiple producer spans across different traces.

**Common Pitfall:** Forgetting to inject context on the producer side or extract it on the consumer side results in the trace breaking at the queue boundary — the consumer starts a new, disconnected trace. This is especially common with third-party queue libraries that don't support OTel auto-instrumentation, requiring manual context injection/extraction code.

### Q: You're seeing P99 latency spikes in your checkout API but your traces show nothing unusual. What's wrong and how do you fix it?

**Model Answer:** This is the classic **sampling visibility gap**. If you're using head-based sampling at 0.1%–1%, you are sampling uniformly across all requests, which means rare P99 outliers (1 in 100 or 1 in 1,000) have a very low probability of being captured. The traces you see are biased toward normal, fast requests — exactly the ones that don't reveal the problem. The fix is to deploy tail-based sampling in your OTel Collector with a latency threshold policy: buffer all spans for the checkout trace, and deterministically keep any trace whose total duration exceeds the P99 threshold (or 2× the recent moving average). This ensures every slow trace is captured regardless of its rarity. You can complement this with metrics exemplars: configure your Prometheus histogram for checkout latency to carry trace ID exemplars, so when you see a P99 spike in the metrics dashboard, you can click through to the exact trace that caused it. Additionally, check for trace fragmentation — if some spans are missing due to propagation breaks, the trace may look fast (missing the slow span) when the actual request was slow.

**Common Pitfall:** Jumping to "increase the sampling rate to 100%" as the first response. This will capture the slow traces but will also overwhelm your collector and storage with a 100–1000× volume increase, potentially causing an outage in the tracing infrastructure itself. The correct answer is tail-based sampling, which selectively keeps interesting traces at a fraction of the cost.

### Q: What breaks when you use single-span head sampling instead of multi-span?

**Answer:** Each service independently decides whether to sample. Service A samples its span (keeps it). Service B independently decides not to sample its span (drops it). You end up with fragment traces — incomplete call trees where child spans are missing. The trace view shows gaps, and you cannot attribute latency because you're missing the spans that contain the timing data. This is called **trace fragmentation** and it renders traces useless for root-cause analysis. Multi-span head sampling fixes this by making the decision once at the root and propagating the `sampled` flag so all services in the call chain honor the same decision.

---

## Related
- [[Metrics & Monitoring (Prometheus-Grafana)]]
- [[topic-queue]]
- [[Weakness Vault/Day-20-Distributed-Tracing]]

---

## Interview Cheat Sheet

**Key Points to Remember:**
- A trace is a tree of spans — each span represents a unit of work with a start time, duration, and context
- Three pillars of observability: metrics (aggregated, cheap), logs (detailed, expensive), traces (request-scoped, connecting)
- OpenTelemetry is the industry standard — instrument once, export to Jaeger, Zipkin, Datadog, or any backend
- Sampling is essential at scale — head sampling (trace ID ratio) vs tail sampling (sample based on response characteristics)
- Context propagation via W3C Trace Context headers — `traceparent` and `tracestate`

**Common Follow-Up Questions:**
- "How do you trace across async message queues?" — Inject trace context into message headers, extract on the consumer side. Kafka headers, SQS message attributes, or RabbitMQ properties.
- "Head vs tail sampling — which do you choose?" — Head sampling is simple but drops interesting traces you can't see. Tail sampling keeps errors and slow requests but requires buffering spans until the trace completes.

**Gotcha:**
- Adding tracing to every RPC adds overhead. At 10K RPS with 10 spans per request, that's 100K spans/sec. If you're not sampling, your tracing backend becomes a bottleneck — and the ironic failure mode is that tracing itself causes the latency you're trying to debug.
