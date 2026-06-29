---
title: "Metrics & Monitoring (Prometheus/Grafana)"
type: system-design
category: Scale
date: 2026-05-16
tags: [system-design, interview, monitoring, observability, prometheus, grafana]
aliases: []
---

# Metrics & Monitoring (Prometheus/Grafana)

## Summary & Interview Framing

A system that collects time-series metrics (Prometheus), visualizes them (Grafana), and alerts on SLO breaches — the foundation of observability alongside logs and traces.

**How it's asked:** "Design a monitoring system for 200 microservices. Cover metric types, cardinality management, alerting strategy, and how to avoid alert fatigue."

---

## Overview

A metrics and monitoring system is the nervous system of reliability engineering. It continuously collects, stores, and queries numerical time-series measurements from running services so that on-call engineers can detect regressions, localize outages, reason about capacity, and prove to the business that service-level commitments are being met. At scale, monitoring is not a single product but a stack:

- A collection mechanism (pull or push)
- A time-series database (TSDB) optimized for append-mostly writes and windowed aggregation
- A query language
- An alerting layer that turns raw signals into human notifications
- A visualization layer that turns queries into dashboards

The dominant open-source implementation of this stack is Prometheus for collection and storage plus Grafana for visualization, often extended with Thanos or Cortex for long-term storage and horizontal scalability. Designing this stack well is less about choosing tools and more about controlling cardinality, designing labels that stay useful as the system grows, and writing alerts that fire on real user pain rather than on noise.

## Key Requirements

### Functional Requirements

The system must:

- Collect metrics from every service and host in the fleet, exposing them through a standard endpoint that a scraper can poll on a fixed interval.
- Store samples in a time-series database that supports efficient range queries and downsampling, so that a dashboard rendering 30 days of data does not scan 30 days of raw points.
- Provide a query language expressive enough to compute rates, quantiles, and aggregations over arbitrary label dimensions.
- Evaluate alerting rules against incoming data and route firing alerts to the correct human channel — PagerDuty for page-worthy incidents, Slack for informational warnings.
- Visualize the results in dashboards that engineers can build and share without writing code.

### Non-Functional Requirements

Monitoring is meta-infrastructure: when it is down, you cannot tell whether anything else is down. This makes its own availability requirements stricter than the services it watches:

- The collection path must be resilient to individual target failures (one hung exporter must not stall the scrape loop).
- The storage layer must survive disk pressure without silent data loss.
- Dashboard queries for common windows (1h, 24h, 7d) must return in under two seconds even at hundreds of thousands of samples per second.
- The system must enforce cardinality discipline: a single mislabeled high-cardinality metric (user_id, request_id, trace_id) can blow up the series count and OOM the server, so ingestion must either reject or bucket such labels.

Ingestion throughput targets are typically in the range of 50,000 to 500,000 samples per second for a mid-size fleet, with retention of 15–30 days hot on local SSD and one year or more in cold object storage.

## Metric Types

Understanding the four Prometheus metric types is foundational because each type constrains what queries are meaningful and how the TSDB stores the data.

| Type | Behavior | Goes Up/Down | Typical Use | Key Query Function |
|------|----------|--------------|-------------|--------------------|
| **Counter** | Monotonically increasing; resets to zero on restart | Up only | Total requests, bytes sent, errors | `rate()`, `increase()` |
| **Gauge** | Arbitrary value at any moment | Up or down | Memory in use, queue depth, active connections, temperature | Direct query; `avg`, `max`, `sum` |
| **Histogram** | Buckets observations cumulatively; stores sum + count | Up only | Latency distributions, aggregatable across instances | `histogram_quantile()` |
| **Summary** | Computes quantiles client-side per instance | Up only | Per-instance quantiles (not aggregatable) | Direct quantile read |

A **counter** is a monotonically increasing value that only ever goes up (or resets to zero on restart) — total requests served, total bytes sent, total errors. Counters are useless as raw values (the absolute number tells you nothing) but powerful when differenced over time with `rate()` or `increase()`, which yield per-second rates and handle resets correctly. A **gauge** is a value that can go up or down at any time — current memory in use, queue depth, number of active connections, temperature. Gauges are queried directly with no rate function; you can aggregate them with `avg`, `max`, `sum` across instances. A **histogram** buckets observations into cumulative buckets and also stores a sum and count, enabling server-side quantile estimation with `histogram_quantile()` and aggregation across instances (a critical capability for distributed latency measurement). A **summary** also measures distributions but computes quantiles client-side, which means you cannot meaningfully average or sum quantiles across instances — this makes summaries a poor fit for most distributed systems and a common source of incorrect dashboards.

The histogram-versus-summary choice is one of the most frequently misunderstood aspects of metric design. Histograms are almost always the right call for latencies in a distributed system because they are aggregatable: you can scrape ten instances, sum their bucket counts, and compute a global p99 with `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))`. Summaries precompute quantiles per instance and offer no way to combine them — averaging ten p99 values does not yield the global p99. The trade-off is that histograms require you to choose bucket boundaries upfront, and poorly chosen buckets produce quantile error. A common heuristic is to define buckets that bracket the SLO threshold tightly (e.g., if your latency SLO is 300ms, include a 0.3 bucket) so that the error budget burn rate is computed accurately.

## Prometheus Architecture

### Scrape Model

Prometheus uses a pull model: the server actively scrapes each target's `/metrics` endpoint on a configurable interval (default 15s). This is a deliberate departure from push-based systems like StatsD and is one of Prometheus's most debated design decisions. Pull makes target discovery explicit, allows the server to detect a down target immediately (a failed scrape produces an `up=0` sample), and avoids the push system's failure mode where a misbehaving client floods the ingestion path.

```
            +-----------------------+
            |   Service Discovery   |
            | (K8s, Consul, EC2,    |
            |  DNS, static config)  |
            +----------+------------+
                       | target list refresh
                       v
+----------------------+-----------------------+
|                Prometheus Server              |
|  +-----------------+   +-------------------+  |
|  |  Scrape Manager |-->|   TSDB (local)    |  |
|  +--------+--------+   +---------+---------+  |
|           |                      |            |
|           | scrape /metrics      | store      |
|           | (default 15s)        | samples    |
+-----------+----------------------+------------+
            |                      |
            |  +-------------------+
            |  |
            v  v
   +--------+--+--+--------+--------+
   |        |     |        |        |
+--+--+  +--+--+ |     +--+--+  +---+---+
| API |  | DB  | |     |Node |  | Push  |
|svc  |  |export| |    |export| |gateway|
|/met |  | /met | |    | /met| | (batch|
|rics |  | rics | |    | rics| |  jobs)|
+--+--+  +--+--+ |     +--+--+  +---+---+
   ^        ^    |        ^         ^
   | up=0   |    |        |         | push (ephemeral)
   | on fail|    |        |         |
   +--------+----+--------+---------+
```

The downside is that pull does not fit naturally behind NAT, in serverless platforms, or for ephemeral batch jobs; for those, Prometheus offers the Pushgateway as an intermediary, though it is explicitly not meant for long-lived state. Service discovery is pluggable: Prometheus integrates with Kubernetes, Consul, EC2, DNS, and static configs, refreshing target lists on a schedule so that autoscaled instances appear and disappear without manual reconfiguration. Each scrape has a timeout and the server records `scrape_duration_seconds` and `scrape_samples_post_metric_relabeling` per target, which are themselves the first signals of a target that is slow or producing too many series.

### TSDB Storage

The Prometheus TSDB stores samples in a custom on-disk format organized into blocks of roughly two hours, each block containing chunked, compressed time-series data plus an index over label names and values. Samples within a chunk are delta-encoded and then compressed with a combination of XOR float compression and run-length encoding, achieving roughly 1.3 bytes per sample for typical data. The index uses an inverted index on label pairs, enabling fast lookups like "all series where `job="api"` and `status="500"`."

```
  Time -->
  
  Block N-1          Block N (compacted)        Head Block (in-memory)
  [2h, read-only]    [2h, read-only]            [active append window]
  +--------------+   +--------------+           +-------------------+
  | Index        |   | Index        |           | Head (RAM)        |
  | (inverted    |   | (inverted    |           |  + chunks (RAM)   |
  |  label idx)  |   |  label idx)  |           +---------+---------+
  +--------------+   +--------------+                     |
  | Chunks       |   | Chunks       |   on checkpoint     v
  | [series A]   |   | [series A]   |   ----- cut ------->| new block
  | [series B]   |   | [series B]   |                     | persisted
  | [series C]   |   | [series C]   |                     v
  | delta+XOR    |   | delta+XOR    |           +-------------------+
  | ~1.3 B/sample|   | ~1.3 B/sample|           | Block N+1         |
  +--------------+   +--------------+           | (written to disk) |
         |                  |                   +-------------------+
         v                  v
   +-----------+      +-----------+
   | merged by |<---- | Compactor |
   | Compactor |      | (older    |
   | (larger   |      |  blocks)  |
   |  blocks)  |      +-----------+
   +-----------+
         |
         v
   +-----------------+
   | Remote Write -> |  to Thanos / Cortex / object store
   | (long-term)     |   (S3 / GCS / Azure)
   +-----------------+
```

Blocks older than the retention window are compacted and merged, and the head block (the active, in-memory append window) is the most resource-intensive portion. Local retention is typically 15–30 days because a single Prometheus server is a vertical-scale component that is not designed for multi-year storage or horizontal sharding. For longer retention or federation across regions, the ecosystem extends Prometheus with remote write to a long-term store.

### PromQL

PromQL is a functional query language where every expression evaluates to a time-series matrix, vector, or scalar. The core building blocks are:

- **Instant vectors** — `http_requests_total` returns the latest value per series.
- **Range vectors** — `http_requests_total[5m]` returns all samples in the last five minutes.
- **Transform functions** — `rate()` for per-second increase of counters, `histogram_quantile()` for quantile estimation, `topk()` and `quantile_over_time()` for windowed analytics.

Aggregation operators (`sum`, `avg`, `max`, `min`, `count`, `stddev`) can be grouped by arbitrary label sets with `by` and `without` clauses, which is how you slice latency by endpoint or error rate by service. PromQL is evaluated at a specific timestamp for instant queries (dashboards, alerts) or over a range for range queries (graph rendering). The language's sharp edges include:

- The difference between `rate` and `irate` — `irate` uses only the last two samples and is more responsive but noisier.
- `histogram_quantile` must wrap an aggregated `sum by (le)` and not be applied per-instance.
- Range vector selectors do not look back across scrape gaps, which can produce `NaN` during brief outages.

## Cardinality Management

Cardinality — the number of distinct label-value combinations, which equals the number of distinct time series — is the single most important and most dangerous property of a Prometheus deployment. Every distinct series is a separate row in the TSDB index and a separate set of chunks on disk; the cost of a metric is not its name but the product of its label cardinalities. A metric with `path`, `method`, and `status` labels where path has 200 values, method has 5, and status has 50 has 50,000 series from those dimensions alone — and if someone adds a `user_id` label with 10 million values, that single metric becomes 500 billion series and the server is dead within minutes. This is not a theoretical failure mode; it is the most common cause of Prometheus outages in production.

The defenses are layered:

- **Never put unbounded identifiers into metric labels** — user_id, session_id, request_id, trace_id, email, IP address belong in logs and traces, not metrics.
- **Use metric relabeling at scrape time** to drop or hash high-cardinality labels before they enter the TSDB; a common pattern is to hash user IDs into a fixed set of buckets if any per-user signal is truly needed.
- **Monitor the series count itself** — `prometheus_tsdb_head_series` and `scrape_samples_post_metric_relabeling` are the early-warning gauges, and a sudden spike in head series is almost always a new high-cardinality label shipped in a deploy.
- **Set hard limits per scrape config** — `label_limit`, `label_name_length_limit`, and `label_value_length_limit` to hard-reject pathological targets.
- **Collapse route parameters in your HTTP library** — turn `/users/12345/orders/67890` into `/users/:id/orders/:id` so that route cardinality stays bounded to the number of routes, not the number of resources ever accessed.

## Label Design

Good label design is what makes a metric queryable across the dimensions engineers actually care about, and bad label design is what makes dashboards unusable or the TSDB explode. The canonical guidance is to label every metric with the minimal set of dimensions needed to identify the source and the failure mode: typically `job` (which service), `instance` (which process), and then the relevant business dimensions such as `method`, `path`, `status`, or `le` (for histograms). A label should be low-cardinality, stable, and meaningful for aggregation.

- Avoid putting the thing you would group by into the metric name — don't emit `http_requests_total_get` and `http_requests_total_post`; emit one `http_requests_total` with a `method` label, because metric names cannot be aggregated over.
- Avoid labels that vary per request or per user.
- Avoid labels that duplicate information already present — `job` and `instance` are added automatically by Prometheus based on the scrape target, so you should not also emit them yourself.

A subtler rule: do not use a label to distinguish things that you will never query across. If you have two independent processes that you will never want to sum together, they can be separate metrics or separate jobs; forcing them under one metric with a label just inflates series count for no analytical benefit. Conversely, if you frequently want to aggregate across something (all instances of a service, all status codes of an endpoint), that thing must be a label, not a separate metric. The test is: will I ever write a query that groups by or filters on this dimension? If yes, it is a label. If no, it is noise.

## Service-Level Objectives (SLO / SLI / SLA)

Service-level thinking is the framework that turns raw metrics into reliability decisions:

- **SLI** (service-level indicator) — a measurable signal of service quality, e.g., the fraction of requests that returned in under 300ms, or the fraction of responses with status < 500.
- **SLO** (service-level objective) — a target for that SLI over a window, e.g., 99.9% of requests under 300ms over 30 days.
- **SLA** (service-level agreement) — the business contract with consequences, typically looser than the SLO, with refunds or credits if breached, so that the team has a safety margin between the SLO they operate to and the SLA they promised.

The error budget is the key SLO concept: if your SLO is 99.9% availability over 30 days, your error budget is 0.1% of 30 days, or about 43 minutes of allowed downtime. The budget is a resource to be spent, not a target to hover at — you can use it to ship risky changes, take deliberate downtime for migrations, or justify not paging for a slow canary. The discipline is to burn budget deliberately and to alert on burn rate, not on raw thresholds. A multi-window multi-burn-rate alerting strategy (the Google SRE pattern) fires a page when the burn rate is high over both a short window (e.g., 1h) and a long window (e.g., 5m), which catches sustained incidents without paging on transient spikes. This is far more humane than threshold alerts and directly ties notifications to user-visible impact.

```
  Error budget burn rate over time
  (SLO = 99.9% over 30d => budget = 0.1% = ~43 min downtime)

  burn     |   Normal ops stays under 1x budget burn
  rate     |
           |
  14.4x ---|----- page threshold (fast burn, 1h window)
           |        \
           |         \  incident: sustained high burn
   6x  ----|----------\----------------------------------  page threshold
           |           \                                 (5m window x 1h window)
           |            \____                           both must exceed
   1x  ----|-----------------___----------------------  normal budget burn
           |                     \____
           |                          \________________
   0x  ----+-----+-----+-----+-----+-----+-----+-----+--> time
           0     6h    12h   18h   24h   30h   36h   42h

  Multi-window multi-burn-rate (Google SRE pattern):
  - Page  : 14.4x burn over 1h  AND  6x burn over 5m
  - Ticket: 6x    burn over 6h  AND  3x burn over 30m
  - Fast burn drains the 30d budget in ~2h  -> page
  - Slow burn drains the 30d budget in ~5d  -> ticket
```

SLIs should be few and should measure what users actually experience: availability (successful responses / total responses), latency (fraction under a threshold that matters to users), and where relevant, freshness, correctness, or throughput. The hardest design decision is choosing the latency threshold — it should reflect the user's experience, not the p99 of your current performance, and it should be tight enough that the error budget is meaningful. A common mistake is setting the SLO to whatever the service happens to do today, which makes the budget meaningless; the SLO should be a product decision about what good looks like.

## Alerting Rules and Alert Fatigue

Alerting is where monitoring meets human systems, and alert fatigue is the dominant failure mode. Every alert that fires without representing real user impact trains the team to ignore the channel, which means the real incident is missed. The cardinal rules:

- Alert on **symptoms** (user-visible problems), not on **causes** (high CPU, disk near full) — causes are many and most don't matter.
- Alert on **SLO burn rate** rather than static thresholds, because burn rate is calibrated to user impact.
- **Route by severity** so that page-worthy alerts go to PagerDuty and informational ones go to a Slack channel that no one is expected to read in real time.

```
   Prometheus                  Alertmanager                 Humans
  +-----------+   fires       +---------------+   routes    +-----------+
  | Alert     |-------------->| Dedup +       |-----------> | PagerDuty |
  | rules     |  (for clause) | Grouping      |  (severity= | (page)    |
  | eval      |               |               |   page)     +-----------+
  +-----------+               | Inhibition    |
                              | (suppress     |   routes    +-----------+
   metric    + labels         |  child when   |-----------> | Slack     |
   condition  (severity,      |  parent       |  (severity= | (info)    |
   persists   team, service)  |  firing)      |   info)     +-----------+
                              |               |
                              | Silencing     |             +-----------+
                              | (maintenance) |-----------> | Email     |
                              +---------------+  (other)    | (backup)  |
                                                                +-----------+
```

Alert rule design in Prometheus uses a `FOR` clause to require a condition to persist for a duration before firing, which filters transient spikes. Labels on the alert (severity, team, service) drive routing in Alertmanager, and annotations carry the runbook link, the dashboard link, and a human-readable summary. Alertmanager handles deduplication, grouping, inhibition (suppress a disk-full alert when the host-down alert for the same machine is already firing), and silencing for planned maintenance. The single most effective fatigue reduction is the post-incident alert audit: after every incident, review every alert that fired and every alert that should have but didn't, then prune or rewrite. A healthy alerting system fires rarely and almost never fires falsely.

## Grafana Dashboards

Grafana is the visualization layer that sits in front of Prometheus (and any other data source) and renders dashboards from PromQL queries. Good dashboards are designed for a specific user and a specific question:

- An **on-call dashboard** answers "what is broken and where."
- A **service dashboard** answers "how is this service doing against its SLOs."
- A **capacity dashboard** answers "when do we run out of headroom."

Mixing these audiences produces dashboards that are useless to all of them. The practical guidelines:

- Put the most important panels at the top (single-stat panels for the headline SLI and the error budget burn rate).
- Use consistent time ranges across panels so they correlate.
- Prefer stacked graphs for component breakdowns and line graphs for trends.
- Use heatmap panels (supported natively for Prometheus histograms) for latency distributions rather than plotting p50/p90/p99 as three lines, which hides the shape of the distribution.

Dashboard-as-code (Grafana's JSON model, managed through tools like grafonnet or Terraform) is essential at scale because hand-built dashboards drift, get orphaned, and resist review. Templating variables let one dashboard cover all services by parameterizing the `job` and `instance` selectors. The single most common dashboard mistake is creating a dashboard with 40 panels that takes 30 seconds to load and answers no question — every panel should justify its place by answering a specific question that someone would actually ask.

## Distributed Tracing Integration

Metrics tell you that something is wrong and roughly where; traces tell you why and how. Distributed tracing (Jaeger, Zipkin, Tempo, Datadog APM) instruments each request with a trace ID and spans across service boundaries, so that a slow request can be decomposed into the time spent in each hop. The integration with metrics is by correlation, not duplication: metrics keep the cardinality low and drive alerts, while traces are sampled (typically 1–10% in steady state, with adaptive sampling to capture all errors and slow requests) and are queried only when an alert fires or a user reports a problem.

The bridge between the two is the exemplar: a Prometheus histogram can carry an exemplar on a bucket, which is the trace ID of a request that fell into that bucket. Grafana can then render a link from a latency heatmap panel directly to the trace in Jaeger or Tempo, so that an engineer looking at a spike in p99 latency can click through to an actual slow trace without leaving the dashboard. This closes the observability loop: the metric fires the alert, the alert links to the dashboard, the dashboard links to the exemplar, and the exemplar links to the trace that explains the root cause. Exemplar support requires Prometheus 2.16+ and instrumentation that attaches the trace ID to the histogram observation, which is now standard in OpenTelemetry SDKs.

## Log Aggregation Correlation

Logs are the third pillar of observability and the most verbose. Where metrics are pre-aggregated and cheap to store, and traces are sampled and structured, logs are high-volume, semi-structured, and often the only place where the per-request context (the user_id, the error message, the stack trace) lives. The correlation pattern is the same as with traces: do not put high-cardinality fields in metrics, but do include a request ID or trace ID in every log line so that an engineer who has isolated a failing request via metrics or traces can pivot to the exact logs for that request.

Structured logging (JSON with consistent field names) is what makes this pivot work at scale, because it lets the log aggregator (Loki, Elasticsearch, Splunk) index the trace_id field and return all lines for a request in milliseconds. Loki is the natural pairing with the Prometheus/Grafana stack because it uses the same label model (labels are low-cardinality, the log content is not indexed but is queried with LogQL) and because Grafana can render log panels next to metric panels with a shared time range and label selector, so that the same dashboard shows the latency spike and the error messages that accompanied it. The cardinality rule applies to Loki too: never put user_id or request_id in Loki labels, only in the log line, or the index explodes exactly as a Prometheus TSDB would.

## RED and USE Methods

The RED and USE methods are checklists that ensure you instrument the right signals without thinking from scratch each time.

| Method | Stands For | Scope | Signals | Questions Answered |
|--------|-----------|-------|---------|-----------------------|
| **RED** | Rate, Errors, Duration | Request-driven services | Request rate (counter by route/status), error rate (failure subset), duration (histogram by route) | Is it handling traffic? Is it failing? Is it slow? |
| **USE** | Utilization, Saturation, Errors | Resource-oriented components | Utilization (fraction of capacity in use), saturation (queue length / wait time — leading contention indicator), errors (device errors, dropped packets, OOM kills) | Is the resource overloaded? Is it queuing? Is it erroring? |
| **Golden Signals** | Latency, Traffic, Errors, Saturation | User-facing services (Google SRE) | RED + saturation combined | Minimum viable observability for any user-facing service |

**RED** (Rate, Errors, Duration) is the method for request-driven services: for every service, emit the request rate (a counter of requests, sliced by route and status), the error rate (the subset of that counter where status indicates failure), and the duration (a histogram of latency, sliced by route). These three signals answer "is the service handling traffic, is it failing, and is it slow" — which covers the vast majority of service-level incidents. **USE** (Utilization, Saturation, Errors) is the method for resource-oriented components: for every resource (CPU, memory, disk, network, connection pool), emit the utilization (the fraction of capacity in use), the saturation (the queue length or wait time, which is the leading indicator of contention), and the errors (device errors, dropped packets, OOM kills). USE is the right frame for infrastructure; RED is the right frame for applications.

The two methods compose: a service dashboard typically has a RED section at the top (the user-facing view) and a USE section below it (the resource view that explains the RED signals when they degrade). Google's **four golden signals** (latency, traffic, errors, saturation) are essentially RED plus saturation, and they are the minimum set that any user-facing service should expose. The discipline is to instrument all four for every service, not just the ones that have had incidents, because the service you haven't instrumented is the one whose first incident will be un-debuggable.

## Capacity Planning for Monitoring Itself

Monitoring infrastructure is itself a system with capacity limits, and one of the most embarrassing outages is losing monitoring during the incident you needed it for. A single Prometheus server has practical limits:

- Roughly 1–2 million active series per server for comfortable operation (more is possible but scrape and query latency degrade).
- Memory footprint of roughly 2–4 KB per active series in the head.
- Disk proportional to series count times retention.

The planning inputs are: number of targets, series per target (measured, not guessed — use `scrape_samples_post_metric_relabeling`), retention window, and query load. A fleet of 1,000 targets averaging 2,000 series each is 2 million series, which is at the edge of one server and calls for sharding.

Sharding strategies include:

- Running multiple Prometheus servers each scraping a subset of targets (by job, by namespace, or by a consistent hash of instance).
- Using Thanos or Cortex to federate the shards into a single queryable view.
- Using recording rules to precompute heavy queries so that dashboards hit pre-aggregated data rather than scanning raw series on every load.

Recording rules are the single most effective capacity lever: a dashboard that computes `histogram_quantile(0.99, sum(rate(...)) by (le))` over 1,000 instances on every refresh is expensive; a recording rule that evaluates that expression every minute and stores the result as a new series makes the dashboard a cheap read of one series. Record everything that powers a frequently-loaded dashboard or a frequently-evaluated alert.

Beyond Prometheus itself, plan for:

- The remote write buffer (Prometheus batches remote writes and will drop samples if the downstream is slow).
- Object store throughput and cost (Thanos/Cortex write compacted blocks to S3/GCS, and query fan-out across many blocks is expensive).
- The Grafana query load (every open dashboard polls on an interval, and a dashboard shared by 50 engineers is 50x the query load — use caching or reduce the refresh interval for shared dashboards).

Treat monitoring capacity with the same rigor as product capacity: set budgets, track growth, and alert on monitoring-system health (the Prometheus self-metrics like `prometheus_tsdb_head_series`, `prometheus_tsdb_head_samples_appended_total`, and `prometheus_remote_storage_dropped_samples_total` are the SLOs for the monitoring system).

## Long-Term Storage: Thanos and Cortex

Prometheus's local TSDB is intentionally short-retention and single-instance, which is correct for the hot path but leaves two gaps: long-term retention for trend analysis and capacity planning, and horizontal scalability for fleets too large for one server. Thanos and Cortex (now part of the Mimir project) are the two main answers, both built on the same building blocks (Prometheus, remote write, object storage) but with different architectures.

**Thanos** extends each Prometheus server with a sidecar that uploads compacted blocks to object storage (S3/GCS/Azure) and exposes a StoreAPI that a Thanos Query component can fan out across. Thanos Querier aggregates results from multiple Prometheus servers, sidecars, and Store nodes, presenting a single PromQL interface over the whole fleet and full retention history. Thanos Compactor downsamples blocks for long windows (5m and 1h resolutions) so that a year-long query doesn't scan raw samples. Thanos Receiver allows push-based ingestion for cases where pull isn't feasible. Thanos's model is federated and preserves the per-Prometheus deployment, which suits organizations that run many independent Prometheus instances and want a unified query layer without re-architecting.

**Cortex / Mimir** takes a different approach: Prometheus remote-writes samples directly to a horizontally scalable, multi-tenant ingestion and storage cluster, which shards series across ingesters and stores chunks in object storage. Queries go to the Cortex query frontend, which fans out across the shards. This is a more centralized architecture that trades the simplicity of local Prometheus for true horizontal scale and multi-tenancy, and it is the better fit for very large fleets or SaaS-style monitoring platforms where many teams share one system. Both systems support long-term retention, multi-cluster federation, and the same PromQL, so the choice is operational (federated sidecars vs. centralized ingest) rather than functional.

The common operational concerns across both are:

- **Object-store cost** — long retention of high-resolution data is expensive; downsample aggressively for anything beyond 30 days.
- **Query fan-out latency** — a query spanning a year of data across many blocks is inherently slow; use recording rules and downsampling.
- **Consistency model** — both are eventually consistent for very recent data because remote write is async; don't alert on Cortex/Thanos with the same freshness expectation as local Prometheus.

A common architecture is local Prometheus for hot alerting (seconds of freshness, 15-day retention) plus Thanos or Cortex for long-term dashboards and capacity analysis (minutes of freshness, year-plus retention), which gives each layer the properties it needs.

## Sharp Interview Question

**Question:** You deploy a new version of your API and your Prometheus server OOMs within 10 minutes. The new version added a single label to an existing histogram. How do you diagnose this, and what was almost certainly the label?

**Model Answer:** The first signal is `prometheus_tsdb_head_series` spiking at the moment of deploy, visible in the server's own metrics (if Grafana is still up) or in the Prometheus logs which print "series mismatch" or high-append-rate warnings. The second signal is that `scrape_samples_post_metric_relabeling` for the API job jumped by orders of magnitude after the deploy, which pinpoints the offending target and tells you the new series are coming from that scrape. The third step is to query the Prometheus API directly (`/api/v1/series?match[]=http_request_duration_seconds_bucket&start=...`) and look at the label sets — the label whose value set exploded is the culprit. Almost certainly the new label is an unbounded identifier: `user_id`, `request_id`, `trace_id`, `session_id`, or `path` with unparameterized route values. The fix is to remove the label from the instrumentation (high-cardinality identifiers belong in logs and traces, not metrics), or if some per-thing signal is genuinely needed, to hash the value into a fixed bucket count via metric relabeling. The deeper lesson is that series count is the product of all label cardinalities, so adding one high-cardinality label to an existing metric multiplies its cost by that cardinality — which is why a single bad label can take down a server that was otherwise comfortable.

**Common Pitfall:** Reaching for `avg()` to aggregate a summary's precomputed quantiles across instances. A summary computes `quantile(0.99, ...)` per process, and there is no mathematically correct way to combine ten per-instance p99 values into a global p99 — averaging them systematically underestimates the true tail. The fix is to use a histogram with well-chosen buckets and to compute the global quantile server-side with `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))`. The `sum by (le)` is mandatory: you must aggregate the bucket counts across instances before applying `histogram_quantile`, or you get per-instance quantiles wrapped in a meaningless aggregation. This single mistake produces dashboards that report a "p99" that is actually closer to p95, which hides the tail latency that real users experience.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Four metric types: counter (monotonic), gauge (up/down), histogram (bucketed distribution), summary (precomputed quantiles)
- Prometheus is pull-based: it scrapes metrics endpoints on a schedule. Push-based alternatives: StatsD, InfluxDB
- Grafana visualizes Prometheus data with dashboards and alerts
- USE method (Utilization, Saturation, Errors) for resources; RED method (Rate, Errors, Duration) for services
- Alert on symptoms (user-visible problems), not causes (internal details). "Error rate > 1%" not "CPU > 80%"

**Common Follow-Up Questions:**
- "How do you choose between histogram and summary?" — Histogram for aggregatable distributions (compute p99 across instances). Summary for pre-computed quantiles that can't be aggregated correctly.
- "What's the cardinality trap?" — Label combinations explode: 100 endpoints × 10 status codes × 5 methods = 5,000 series. High cardinality causes memory blowup in Prometheus.

**Gotcha:**
- Never use `avg()` to aggregate per-instance p99 values. Averaging ten p99s does not give you the global p99 — it systematically underestimates the tail. Use histograms with `histogram_quantile()` and aggregate bucket counts before computing the quantile.
