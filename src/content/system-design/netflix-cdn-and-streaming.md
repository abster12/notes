---
title: "Netflix CDN & Streaming"
type: system-design
category: Deep Dive
date: 2026-05-27
tags: [system-design, interview, netflix, cdn, streaming, open-connect, adaptive-bitrate, video-delivery, edge-computing]
aliases: [Netflix Architecture, Video Streaming Infrastructure, Open Connect]
---

# Netflix CDN & Streaming

## Summary & Interview Framing

Netflix's proprietary CDN (Open Connect) that places owned hardware inside ISP data centers, pre-positions content, and streams adaptive bitrate video to 250M subscribers.

**How it's asked:** "Design a video streaming CDN for 250M users across 190 countries. Cover adaptive bitrate, edge caching, encoding, and the economics of owned vs rented CDN."

---

## Overview

Netflix serves roughly fifteen percent of the world's downstream internet traffic during peak evening hours, delivering billions of hours of video per month to over 247 million subscribers across more than 190 countries. The engineering challenge this represents is difficult to overstate: the system must deliver high-bitrate 4K HDR video with near-zero buffering to any device on any network, from a fiber connection in central Tokyo to a throttled 3G link in rural India, while simultaneously enforcing per-country licensing, serving personalized artwork and recommendations, A/B testing every user-facing surface, and recovering gracefully from the failure of any individual component. What makes Netflix architecturally distinctive is not any single piece of technology but the deliberate vertical integration of the entire delivery chain — from the moment a studio hands over a master file to the moment a pixel lights up on a television — and the willingness to build custom infrastructure where commercial offerings fell short.

The architecture divides cleanly into three worlds that are often discussed as a pipeline but are really a set of loosely coupled, independently evolvable systems:

- **Origin world** — lives almost entirely in AWS and encompasses content ingestion, the transcoding pipeline, the control-plane services (everything from the API gateway to billing, recommendation, and playback-control microservices), and the metadata and state stores that back them.
- **Distribution world** — Open Connect, Netflix's purpose-built content delivery network, deliberately kept outside AWS because egress and inter-ISP transit costs would make high-bitrate streaming economically ruinous at Netflix's scale.
- **Client world** — the adaptive bitrate player that ships on thousands of device models (smart TVs, game consoles, set-top boxes, mobile phones, tablets, and browsers) and is responsible for deciding which representation of a title to fetch, when to switch, and how to react to network turbulence.

Understanding Netflix means understanding how these three worlds handshake, and where the seams are deliberately left loose so that a failure in one does not cascade into the others.

## Open Connect and the OCA Model

Open Connect is the single most important architectural decision Netflix has made, and it is the answer to a brutally economic question: if you are pushing 800 gigabits per second of video into a single ISP during peak hours, paying commercial CDN and transit rates for that traffic will bankrupt you, and relying on generic edge caches that sit in a handful of regional points of presence will still force a large fraction of traffic to traverse expensive inter-city links. Netflix's solution was to design its own appliances — Open Connect Appliances, or OCAs — and to place them physically inside ISP networks, often in the same data center as the ISP's core routers, connected via free peering or settlement-free interconnects.

An OCA is a dense, custom-configured storage and streaming server:

- Typically a 1U or 2U chassis stuffed with large SATA SSDs or high-capacity HDDs
- A multicore x86 CPU
- Multiple 10G or 25G network interfaces
- Runs a customized FreeBSD image with the NGINX web server tuned for large-file delivery
- A single fully-loaded OCA can store tens of terabytes of encoded video and serve multiple tens of gigabits per second of sustained throughput

The placement model is the key insight. Rather than a handful of massive regional PoPs (the Akamai/CloudFront model), Open Connect operates thousands of OCAs distributed across hundreds of ISP facilities worldwide. Netflix classifies these into **fill** sites and **cache** sites. Fill sites are the larger, more centrally located appliances that hold a broad catalog and act as origin-tier peers; cache sites are pushed deep into individual ISP networks and hold only the content that is currently popular in that specific region. When a client resolves the DNS name for a piece of video, Netflix's traffic-control infrastructure returns the IP of an OCA that is topologically closest to the client — usually inside the client's own ISP — so the bytes never leave the ISP's network at all. This is sometimes called the "Netflix box in your ISP's basement" model, and it is the reason 4K streaming is economically viable: the marginal cost of delivering an additional stream approaches the electricity and depreciation cost of a server that is already paid for, because the traffic rides free peering links instead of transit.

```
                   OPEN CONNECT ARCHITECTURE
                   ==========================

   ┌─────────────────────────────────────────────────────────┐
   │                     AWS ORIGIN                          │
   │   ┌───────────┐   ┌────────────┐   ┌───────────────┐    │
   │   │  S3 Mezz  │   │ Encode Farm│   │  Control Plane │    │
   │   │  (origin) │   │  (EC2/K8s) │   │  (Zuul/svc)    │    │
   │   └─────┬─────┘   └──────┬─────┘   └───────────────┘    │
   │         │  scheduled off-peak prefetch (managed fill)    │
   └─────────┼───────────────────────────────────────────────┘
             │
             ▼
   ┌──────────────────────────────────────────────────────────┐
   │                 FILL SITES (origin-tier)                  │
   │   Broad catalog · larger centrally-located appliances     │
   │   ┌──────┐   ┌──────┐   ┌──────┐                         │
   │   │Fill  │──▶│Fill  │──▶│Fill  │   ← BGP + internal      │
   │   │OCA 1 │   │OCA 2 │   │OCA 3 │     control protocol    │
   │   └──┬───┘   └──┬───┘   └──┬───┘     peer rebalancing     │
   └─────┼──────────┼──────────┼──────────────────────────────┘
         │ predictive demand push │
         ▼                       ▼
   ┌──────────────────────────────────────────────────────────┐
   │            CACHE SITES (deep in ISP networks)             │
   │                                                            │
   │   ┌───────────────┐    ┌───────────────┐                  │
   │   │   ISP A net   │    │   ISP B net   │                  │
   │   │  ┌─────────┐  │    │  ┌─────────┐  │                  │
   │   │  │Cache OCA│  │    │  │Cache OCA│  │                  │
   │   │  │(warm)   │  │    │  │(warm)   │  │                  │
   │   │  └────┬────┘  │    │  └────┬────┘  │                  │
   │   └───────┼───────┘    └───────┼───────┘                  │
   └──────────┼─────────────────────┼─────────────────────────┘
              │ last-mile RTT       │ last-mile RTT
              ▼                     ▼
         ┌─────────┐            ┌─────────┐
         │ Client  │            │ Client  │   bytes never leave
         │ (TV)    │            │ (Phone) │   the ISP network
         └─────────┘            └─────────┘
```

Content propagation through Open Connect is a multi-tier fill process rather than a traditional cache-miss hierarchy. New or newly-encoded titles are pushed from the AWS-based origin into a small number of **fill appliances** during off-peak hours using a managed, scheduled prefetch rather than reactive cache-on-demand. From the fill appliances, content is further distributed to the edge cache OCAs based on predictive demand models — Netflix knows, per region and per ISP, what is likely to be watched tonight because of recommendations, new-release schedules, and observed viewing patterns. The appliances peer with each other using BGP and an internal control protocol, and they continuously rebalance content so that a cache OCA that is running low on free space will evict cold titles and pull warm titles from a fill peer. This means that by the time a user presses play, the title almost certainly already resides on a server inside their ISP, and the first-byte latency is dominated by the last-mile round trip rather than any cross-network fetch. The entire fleet is monitored and managed by the Open Connect control plane, which tracks fill health, disk health, throughput, and cache hit ratio per appliance and can remotely reconfigure or replace a failing box without human intervention.

## Content Ingestion Pipeline

Content ingestion begins long before a title reaches an OCA. Studios deliver source masters — typically DPX or ProRes sequences, uncompressed or lightly compressed, often tens or hundreds of gigabytes per episode or film — to Netflix via Aspera or Signiant high-throughput transfer into S3 buckets in AWS. On arrival, the pipeline first performs **mezzanine preparation**: the source is normalized into a single high-quality mezzanine file (commonly ProRes 422 HQ or a JPEG 2000 derivative) that becomes the canonical input for all downstream encoding. This step also extracts and validates auxiliary assets — audio tracks in multiple languages, subtitle and closed-caption files, forced narrative metadata, dub-timing metadata, and the various poster and artwork images used by the recommendation and playback surfaces. Everything is checksummed and versioned, because a single master may be re-encoded dozens of times over its lifetime as codec technology, device support, and encoding ladders evolve.

Once the mezzanine is staged, an orchestration layer — historically built on a mix of Pig, Spark, and custom services running on an autoscaling fleet of EC2 instances, with many workloads now on Kubernetes — fans out the encoding jobs. The pipeline is fundamentally a directed acyclic graph of tasks: analyze the source, compute the per-title encoding ladder, run each encode in parallel, run quality checks, package the outputs, publish metadata, and trigger Open Connect fill. Each task is independently retryable and idempotent, and the orchestrator tracks the DAG state in a durable store so that a failed job can resume from the last successful node rather than re-encoding an entire film because a single segment failed QA. The pipeline is designed for thousands of concurrent titles and is itself a capacity-planning problem: Netflix must ingest and re-encode not only new releases but the entire back catalog whenever a codec upgrade or ladder change warrants it, which is why the encode farm is one of the largest sustained batch-compute workloads on AWS.

```
          CONTENT INGESTION & TRANSCODING PIPELINE
          ========================================

  Studio                  AWS Origin
  ┌───────┐  Aspera/     ┌──────────────────────────────────────┐
  │ DPX / │  Signiant    │            S3 Bucket                 │
  │ProRes │─────────────▶│            (ingest)                  │
  │ master│               └────────────────┬─────────────────────┘
  └───────┘                                │
                                           ▼
                          ┌─────────────────────────────┐
                          │   MEZZANINE PREPARATION      │
                          │ • normalize → ProRes 422 HQ  │
                          │ • extract audio/subtitle/art │
                          │ • checksum + version         │
                          └────────────────┬─────────────┘
                                           │
                                           ▼
                          ┌─────────────────────────────┐
                          │     ORCHESTRATION (DAG)      │
                          │  Pig / Spark / K8s on EC2    │
                          └────────────────┬─────────────┘
                                           │
                  ┌────────────┬───────────┼───────────┬────────────┐
                  ▼            ▼           ▼           ▼            ▼
             ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐
             │analyze │  │compute │  │ encode │  │  QA /  │  │package │
             │ source │  │ ladder │  │(parallel│ │ quality│  │ + seg  │
             │        │  │(per-title)│ rungs) │  │ checks │  │(2-10s) │
             └────────┘  └────────┘  └────────┘  └────────┘  └────┬───┘
                  retryable + idempotent · resume from last node   │
                                                                    ▼
                                                       ┌───────────────────┐
                                                       │  publish metadata │
                                                       │  + trigger OC fill│
                                                       └─────────┬─────────┘
                                                                 ▼
                                                          Open Connect
                                                          fill origin
```

## Transcoding and the Encoding Ladder

Early in its streaming history Netflix used a fixed encoding ladder: every title was encoded at the same set of bitrates and resolutions regardless of content complexity. This is wasteful. An animated film with large flat regions compresses dramatically better than a gritty, high-motion live-action title, so encoding both at the same bitrate either wastes bandwidth on the cartoon or starves the action film of quality. Netflix's breakthrough was **per-title encoding optimization**, in which an analysis pass measures the rate-distortion curve of each individual title — essentially, how many bits are required to achieve a target visual quality at each resolution — and then selects a custom ladder of resolution-bitrate pairs tailored to that title. A complex action film might get a 1080p rung at 5 Mbps while a simple cartoon gets the same quality at 1.5 Mbps, and both might get additional rungs at 720p, 480p, and 240p scaled to their own complexity. This single change yielded roughly 20% bandwidth savings across the catalog for equivalent perceived quality, which at Netflix's scale translates to an enormous reduction in OCA storage, fill traffic, and peak ISP throughput.

The ladder concept has since been generalized further. Netflix now performs **per-shot** or **per-scene** encoding in which the encoding parameters can vary within a single title, and they have introduced **dynamic optimizer** techniques that treat encoding as a constrained optimization over chunks. The output formats target multiple codec families:

- **H.264/AVC** — broadest device compatibility
- **H.265/HEVC** — newer devices and 4K HDR
- **VP9** — web and Android
- **AV1** — newer clients where superior compression efficiency justifies the higher encode cost

Each title is also encoded with multiple audio formats — AAC, Dolby Digital Plus, and Dolby Atmos when applicable — and packaged with subtitle tracks in dozens of languages. The packaging step segments the encoded outputs into the small, duration-bounded chunks (typically 2 to 10 seconds) that adaptive streaming requires, and writes them into the Open Connect fill origin. A single high-value title may therefore produce hundreds of distinct asset files across codec, resolution, audio, and subtitle combinations, all of which must be consistently named, versioned, and referenceable by the playback control plane.

## Adaptive Bitrate Streaming (ABR)

Adaptive bitrate streaming is the client-side mechanism that makes delivery robust to network variability, and the Netflix player is one of the most heavily engineered ABR implementations in existence. The core idea is that video is delivered as a sequence of short segments, each available at multiple quality rungs, and the player continuously decides which rung to fetch next based on current observed throughput, the size of its playback buffer, and predicted future network conditions. The two dominant packaging formats are HLS (HTTP Live Streaming, Apple's segment-and-playlist standard) and DASH (Dynamic Adaptive Streaming over HTTP, the MPEG standard), both of which work by giving the player a manifest that lists every available representation — each combination of resolution, bitrate, codec, and audio track — along with the URLs of the individual segment files. The player then issues plain HTTP range requests for segments, and because every segment is an independent, cacheable file, the CDN can serve them with no special streaming protocol — just NGINX serving bytes off local disk.

```
         ADAPTIVE BITRATE STREAMING FLOW
         ===============================

   Client Player                          Network / CDN
   ┌───────────────────┐
   │   startup: cold    │
   │   pick conservative│
   │   rung, < 2s TTFF  │
   └─────────┬─────────┘
             │  1. fetch manifest (HLS playlist / DASH MPD)
             ▼
   ┌───────────────────┐         ┌──────────────────────┐
   │  parse manifest:  │◀────────│  OCA (NGINX, disk)   │
   │  list of rungs    │         │  segment files       │
   │  (res×br×codec×aud)│        └──────────────────────┘
   └─────────┬─────────┘
             │
             ▼
   ┌───────────────────────────────────────────────────┐
   │              ABR DECISION LOOP                     │
   │                                                    │
   │  ┌──────────────┐   ┌──────────────┐   ┌────────┐ │
   │  │ throughput   │   │ buffer-based │   │  rate  │ │
   │  │ estimate     │──▶│ control      │──▶│governor│ │
   │  │ (EWMA +      │   │(conservative │   │(smooth │ │
   │  │  outlier     │   │ when buffer  │   │switches│ │
   │  │  rejection)  │   │ shrinks)     │   │)       │ │
   │  └──────────────┘   └──────────────┘   └───┬────┘ │
   │                                           │      │
   │           selected rung ◀─────────────────┘      │
   └───────────────────────┬───────────────────────────┘
                           │  2. HTTP range request for next segment
                           ▼
                  ┌──────────────────────┐
                  │   OCA serves segment  │
                  │   (cacheable file)    │
                  └──────────┬───────────┘
                             │  3. bytes stream into playback buffer
                             ▼
                  ┌──────────────────────┐
                  │  buffer fills → play  │─── loop back to ABR decision
                  │  A/V sync, trick-play │    as buffer/throughput change
                  └──────────────────────┘
```

The interesting engineering is in the **ABR algorithm** itself. A naive throughput-based switcher measures the recent download rate and picks the highest rung that fits, but this is fragile: a single slow segment causes a downward switch, the buffer drains, and the user sees quality oscillation or rebuffering. Netflix's player uses a more sophisticated approach that combines a throughput estimate (typically an exponentially weighted moving average over recent segment fetch times, with outlier rejection) with a **buffer-based control** layer that becomes more conservative as the buffer shrinks and more aggressive as it grows, so that a healthy buffer allows the player to ride out a brief throughput dip without switching down. There is also a **rate governor** that smooths switches to avoid visible quality popping, and device-specific tuning because a low-end smart TV has very different decode headroom than a modern phone. The player must additionally handle audio-video synchronization, seamless track switching when a user changes language mid-playback, seeking, and trick-play (fast-forward and rewind) which is often served from a separate set of lower-resolution thumbnail or I-frame-only assets. Startup optimization is its own subproblem: the player aims for under two seconds to first frame, which it achieves by starting at a conservative rung, fetching the first segments with high priority, and only ramping up once the buffer is established — a classic cold-start tradeoff between quality and time-to-first-frame.

| ABR Approach | Throughput Signal | Buffer Awareness | Switch Behavior | Failure Mode |
|---|---|---|---|---|
| Naive throughput-based | Recent download rate (raw) | None | Reacts to every segment; picks highest fitting rung | Quality oscillation, rebuffer on a single slow segment |
| Netflix combined (EWMA + buffer) | EWMA over fetch times, outlier-rejected | Yes — conservative when buffer shrinks, aggressive when it grows | Rides out brief dips; switches only when buffer trend warrants | Tuning complexity; device-specific decode headroom must be modeled |
| Pure buffer-based | Ignored or secondary | Primary driver — switch up only when buffer exceeds threshold | Very stable once buffer is built | Slow cold-start; suboptimal rung if buffer never grows |
| Rate-governor layer (add-on) | N/A (smoothing on top of above) | N/A | Enforces min-dwell time per rung, caps switch frequency | Can lag real throughput changes; needs tuning per device class |

## The Zuul Gateway and Microservice Edge

In front of the hundreds of backend microservices that constitute Netflix's control plane sits **Zuul**, the edge gateway service that terminates client connections, performs authentication and device characterization, routes requests to the appropriate backend, and applies a layer of cross-cutting resiliency logic. Zuul was originally built as a servlet-based filter pipeline and has since been rewritten (Zuul 2) on Netty with an asynchronous, non-blocking I/O model so that a small number of gateway instances can sustain hundreds of thousands of concurrent connections without thread-per-connection overhead. Every request from every device — whether it is a TV fetching its home screen, a phone requesting playback metadata, or a backend health check — flows through Zuul, which means the gateway is both a critical single chokepoint and a natural place to enforce system-wide policy.

```
          ZUUL GATEWAY ARCHITECTURE
          =========================

   Client (TV / Phone / Browser / Console)
        │
        │  HTTPS (async, non-blocking I/O · Netty · Zuul 2)
        ▼
   ┌─────────────────────────────────────────────────────────┐
   │                      ZUUL EDGE                          │
   │                                                         │
   │   ┌──────────────────────────────────────────────────┐  │
   │   │            FILTER CHAIN (in order)               │  │
   │   │  1. Auth / device characterization               │  │
   │   │  2. Geo + device routing                         │  │
   │   │  3. A/B test assignment (hash → cell)            │  │
   │   │  4. Rate limiting                                │  │
   │   │  5. Circuit breaking + retry (Hystrix/successor) │  │
   │   │  6. Telemetry emit (latency / err / throughput)  │  │
   │   └──────────────────────────────────────────────────┘  │
   │                         │                               │
   │   queries Eureka for    │  healthy backend instances    │
   │   ◀─────────────────────┼──────────────────────▶        │
   └─────────────────────────┼───────────────────────────────┘
                             │  load-balanced across instances
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                 ▼
      ┌─────────┐       ┌─────────┐       ┌─────────┐
      │ Rec svc │       │Playback │       │ Billing │   ...hundreds of
      │ (stateless)│    │ctrl svc │       │   svc   │    microservices
      └────┬────┘       └────┬────┘       └────┬────┘
           │                 │                 │
           ▼                 ▼                 ▼
        EVcache / Cassandra (durable, multi-region)
```

Zuul's filter chain is where Netflix implements request authentication, device and geo routing, A/B test assignment, rate limiting, and the circuit-breaking and retry logic that prevents backend failures from cascading to the client. The gateway integrates tightly with the **Eureka** service discovery registry so that it never hardcodes backend addresses: it queries Eureka for the current healthy instances of a target service and load-balances across them, which means that instances can be deployed, scaled, and terminated continuously without any gateway reconfiguration. When a backend instance starts failing, Zuul's integration with **Hystrix** (and its successor concurrency primitives) opens a circuit breaker for that instance, stops sending it traffic, and either returns a fallback response or retries against a healthy peer — the classic bulkhead pattern that isolates a single failing dependency from taking down the whole edge. Because Zuul sees every request, it is also a primary telemetry surface: latency, error rate, and throughput metrics flow into the observability stack and drive both real-time alerting and the capacity-planning models.

## EVcache and the Caching Layer

**EVcache** is Netflix's custom distributed in-memory caching layer, built on top of Memcached but with a set of Netflix-specific enhancements that make it suitable as a primary read-scaling mechanism across the entire control plane. The name comes from the Ephemeral Volatile cache concept, and the system is designed around a few key assumptions: cache hits must be sub-millisecond, the cache is a throughput accelerator rather than a source of truth, and the working set is large enough that a single node cannot hold it but small enough that a sharded fleet can. EVcache introduces a **replication** layer on top of plain Memcached: when a write arrives, it is asynchronously replicated to one or more secondary cache nodes, often in a different availability zone, so that the loss of a single node does not cause a thundering herd of cache misses against the backing datastore. This is a deliberate tradeoff — trading memory for availability — that makes sense at Netflix's read volume, where a cache-warmup storm after a node failure could saturate the backing databases.

Clients route to EVcache through a consistent-hashing sharding scheme so that a given key maps to a stable primary, and the client libraries handle failover, replication, and the serialization format. EVcache is used pervasively: the home screen's row data, the playback metadata for a title, the user's preference and bookmark state, the A/B test assignment for a given user-device pair, and the device-capability profile used to decide which encoding rungs to offer are all cached in EVcache with appropriate TTLs. The design rule is that every read path that can tolerate slightly stale data and that is hit at high QPS should be cached, and the backing store (typically Cassandra) is provisioned to survive the cache-miss load of a partial fleet failure but not the full cold-start load of a total cache loss. This is why EVcache replication across AZs matters so much: a single AZ evacuation that took out a cache tier without replication would shift the entire read load onto Cassandra and likely cause a cascading slowdown.

## Cassandra as the Stateful Backbone

Netflix was one of the earliest and largest production adopters of **Apache Cassandra**, and Cassandra underpins a large fraction of Netflix's durable, highly available state — viewing history, bookmark and resume positions, user preferences, A/B test enrollment and outcome data, device telemetry, and a substantial portion of the metadata that drives the recommendation and playback systems. The choice of Cassandra is driven by its architecture: a masterless, partition-tolerant, eventually-consistent ring of nodes that can span multiple regions and survive the loss of any individual node or even an entire Availability Zone without going down. For Netflix, which runs a globally distributed service across three AWS regions, the ability to write locally in each region and have Cassandra asynchronously replicate those writes to the other regions — while still serving reads locally — is the core enabler of a globally available control plane that does not depend on a single primary database.

Netflix operates Cassandra at a scale and tuning depth that few other companies reach. The key design decisions are around **replication factor** (typically three per region for a total of nine across three regions, giving tolerance for the loss of two nodes per region), **consistency level** (LOCAL_QUORUM for most reads and writes, which acknowledges a write once a quorum of replicas in the local region has it, balancing latency and durability), and **compaction strategy** (LeveledCompactionStrategy for read-heavy workloads like viewing history, SizeTiered for write-heavy ones). Netflix has built an extensive internal toolset — including the **Cassandra-as-a-Service** platform sometimes called Evcache-adjacent infrastructure — that automates node replacement, ring rebalancing, repair, and backup, because operating hundreds of Cassandra clusters by hand is infeasible. The most subtle engineering challenge is **tunable consistency**: the system must know, per use case, whether a read can tolerate stale data (use LOCAL_ONE for speed) or must see the latest write (use LOCAL_QUORUM), and getting this wrong either sacrifices availability or correctness. Viewing history is eventually consistent — it is acceptable for a resume position to be a few seconds stale — whereas billing and entitlement state demands stronger guarantees and may be routed through a different store or a quorum-read path.

## Personalization and Recommendation

The recommendation system is, from a user's perspective, the entire product: the home screen is not a static catalog but a dynamically assembled set of rows, each tailored to the individual user, and the artwork on each title is itself personalized. Architecturally this is a two-stage problem. The first stage is **candidate generation**, in which a large corpus of titles is filtered down to a manageable set of candidates for a given user using collaborative filtering, content-based similarity, and increasingly deep-learning models trained on the interaction graph of hundreds of millions of users. The second stage is **ranking and presentation**, in which the candidates are ordered into rows, each row is given a theme (genre, "because you watched," "trending," etc.), and the specific artwork variant for each title is selected to maximize the probability that this particular user will click. The artwork personalization alone is a substantial system: Netflix pre-renders multiple frame crops per title, and a contextual bandit algorithm selects which crop to show each user based on their inferred preferences, with the reward signal being whether they actually pressed play.

From an infrastructure standpoint the recommendation pipeline runs largely offline and nearline. Batch model training happens on Spark and parameter-server clusters over the full interaction history in Cassandra and S3, producing model artifacts that are pushed to online serving services. The online serving path, hit every time a user opens the app, must assemble the home screen in a few hundred milliseconds, which means the heavy candidate-generation work is precomputed and cached in EVcache, and the serving layer does the final ranking, row assembly, and artwork selection against cached intermediate results. The system is also tightly coupled to the A/B testing infrastructure, because every algorithmic change — a new ranking model, a new artwork selection policy, a new row layout — is rolled out as an experiment first, and the recommendation models themselves are continuously retrained on the outcome data flowing back from those experiments. This creates a feedback loop: the recommendation system drives what users watch, what they watch becomes training data for the recommendation system, and the A/B platform is the mechanism that ensures changes are validated against live behavior before they ship to everyone.

## A/B Testing Infrastructure

Netflix runs one of the largest and most rigorous consumer-facing A/B testing operations in the industry, and the testing infrastructure is not an afterthought bolted onto the product but a first-class platform that gates essentially every user-facing change. The core mechanism is **assignment**: when a request arrives at Zuul, the gateway computes a deterministic assignment of the user (or user-device pair) into one or more active experiments, using a hashing scheme that ensures the same user lands in the same cell across requests and devices. The assignment is stored in Cassandra and cached in EVcache so that subsequent requests do not recompute it, and it is propagated down the request context so that every downstream microservice knows which experiment variant to serve. This means a single user can be enrolled in dozens of concurrent experiments — a UI layout test, a recommendation algorithm test, an encoding-ladder test, a startup-optimization test — and the platform must track all of them, guard against interaction effects, and ensure that the assignment is consistent across the heterogenous fleet of devices.

The harder half of A/B testing is not assignment but **analysis and decision-making**. Netflix has invested heavily in a statistics platform that computes, for each experiment, the causal effect of the treatment on a set of guardrail and primary metrics — startup time, rebuffer ratio, hours streamed, retention, churn — using techniques like variance reduction (CUPED) to increase the statistical power of a given sample size and sequential testing to allow early stopping without inflating false positives. The platform must also handle the subtleties of a streaming product: a user's experience is not a single pageview but a long-running session, so metrics like "rebuffer ratio" are computed over the full session and must be attributed back to the experiment the user was in at the time, which requires careful handling of users who switch cells or whose assignment changes mid-experiment. The entire pipeline — assignment, exposure logging, metric computation, significance testing, and decision dashboards — is automated so that an experiment owner can launch a test, monitor it, and read a statistically valid result without manual analysis, which is the only way to scale to hundreds of concurrent experiments.

## Chaos Engineering and Failure Injection

Netflix is the company that coined and productized **chaos engineering**, and the practice grew directly out of their migration to AWS in the early 2010s, when they discovered that relying on the cloud's implicit reliability was insufficient and that they needed to actively probe their system's failure modes in production. The original and most famous tool is **Chaos Monkey**, which randomly terminates production instances during business hours on the assumption that any instance that is not expendable represents a single point of failure that must be eliminated. The cultural impact of Chaos Monkey was as important as the technical one: it forced every service team to build their service as if any instance could die at any moment, which meant automated health checks, graceful instance replacement via the autoscaler, statelessness of compute nodes, and durable state in Cassandra or EVcache rather than local disk. A service that could not survive Chaos Monkey was a service that could not survive a real AWS failure, and the tool made that visible before the real failure did.

Chaos Monkey evolved into the **Simian Army**, a collection of failure-injection tools that attack different layers of the system.

| Tool | Failure Injected | Scope | What It Validates |
|---|---|---|---|
| Chaos Monkey | Random instance termination | Single instance | Instance-level expendability, autoscaler replacement, statelessness |
| Chaos Gorilla | Entire Availability Zone outage | One AZ | Cross-AZ rebalancing, EVcache/Cassandra replication, AZ-transparent failover |
| Chaos Kong | Entire AWS region loss | One region | Multi-region active-active failover, traffic shifting at edge, regional runbook |
| Latency Monkey | Injected network delay between services | Service-to-service link | Timeout tuning, circuit-breaker behavior under slow downstream |
| Conformity Monkey | Flags non-conforming instances | Configuration audit | Best-practice conformance, config drift detection |
| Chaos Engineering Platform | Structured scheduled experiments with explicit hypotheses + auto-rollback | Any layer, calibrated | Resilience assumptions quantified; feeds autoscaling/capacity/failover models |

The modern incarnation of this is the **Chaos Engineering Platform**, which runs structured, scheduled failure experiments with explicit hypotheses — "if we lose 30% of the EVcache fleet in us-east-1, the home screen p99 latency will stay under 500ms" — and automatically verifies the outcome, rolling back the injection if the system degrades beyond a safety threshold. The discipline has matured from random termination into a principled method for validating resilience assumptions, and it is tightly integrated with the capacity and failure-handling models: every chaos experiment is a data point that calibrates how the system will behave during a real incident, which feeds back into autoscaling policies, capacity headroom targets, and failover playbooks.

## Capacity Planning at 200M+ Subscriber Scale

Capacity planning at Netflix's scale is not a once-a-year forecasting exercise but a continuous, model-driven discipline that must account for both steady organic growth and the spikes that come from new market launches, viral titles, and live events. The fundamental unit of demand is concurrent streams: during peak evening hours in a given region, a large fraction of the subscriber base is watching simultaneously, and the bitrate distribution of those streams — weighted toward 4K and 1080p in developed markets and toward lower rungs in bandwidth-constrained ones — determines the aggregate downstream throughput that Open Connect must sustain. Netflix models this per-ISP and per-region, because an OCA inside Comcast's network in the US northeast has a completely different demand profile than one inside a small European ISP, and the fill strategy and storage allocation on each appliance must match its local demand curve.

Key capacity numbers at Netflix's 200M+ subscriber scale:

- ~247 million subscribers across 190+ countries
- ~15% of global downstream internet traffic during peak evening hours
- Billions of hours of video delivered per month
- Peak egress has at times exceeded 800 Gbps into a single ISP
- Peak planning targets: 95th–99th percentile of observed peak evening traffic, plus headroom margin
- Each OCA: tens of terabytes of storage, multiple tens of Gbps sustained throughput
- Thousands of OCAs across hundreds of ISP facilities worldwide
- Encode farm: one of the largest sustained batch-compute workloads on AWS
- Time-to-first-frame target: under 2 seconds
- Home screen assembly: a few hundred milliseconds at online serving path

On the control-plane side, capacity planning is driven by the autoscaling behavior of the microservice fleet. Each service has an autoscaling policy tied to a load metric — QPS, CPU, concurrent connections — and the capacity team's job is to ensure that the autoscaler's maximum bound is set high enough to absorb projected peaks with margin, that the scaling latency is fast enough that a traffic ramp does not outrun the provisioning, and that the backing datastores (Cassandra, EVcache, the relational stores) are pre-provisioned because they cannot scale as quickly as stateless compute. The multi-region architecture provides additional headroom: Netflix runs active-active across regions, so a failure or spike in one region can spill over to the others via traffic shifting at the Zuul and routing layer. The hardest planning cases are **live events** — a heavily promoted live stream can produce a demand spike that is both far larger than normal and far more concentrated in time, because millions of users start watching within the same few-minute window rather than spreading across the evening. Live capacity is planned by pre-positioning extra fill capacity, warming caches, and over-provisioning the ingestion and origin path, with the understanding that a live event cannot rely on the gradual fill-and-cache-warm model that on-demand content benefits from.

## Failure Handling and Resilience Patterns

Failure handling at Netflix is built on the explicit assumption that everything fails and that the system's job is to degrade gracefully rather than to never fail. The foundational patterns are **circuit breaking**, **bulkheads**, **timeouts with retries**, and **fallbacks**, all of which are codified in the Hystrix library and its successors and enforced at the Zuul edge and within each service's client layer. Circuit breaking prevents a slow downstream from consuming all the threads of its callers: after a threshold of failures, the circuit opens, subsequent calls fail fast, and the caller either returns a fallback or serves a cached/stale response while the downstream recovers. Bulkheads isolate dependencies by giving each downstream its own thread or connection pool so that a saturation in one cannot starve the others. Timeouts are set aggressively and pervasively, because a hung call that is not timed out is worse than a fast failure — it consumes resources and propagates latency. The combination of these patterns is what allows a Netflix service to survive the failure of a dependency without the failure cascading into a user-visible outage.

At a higher level, the **multi-region active-active** architecture is the ultimate failure-handling mechanism. Netflix runs its full stack in three AWS regions and can shift traffic between them via DNS and the edge routing layer; a regional AWS outage does not take Netflix down, it reduces capacity and shifts load to the other regions. This is exercised regularly by Chaos Kong and by the failover runbooks, so that when a real regional event occurs the team is executing a rehearsed procedure rather than improvising. Within a region, the Cassandra and EVcache replication across AZs, the autoscaler's ability to replace lost instances, and the stateless design of compute nodes mean that an AZ failure is largely transparent. The final layer is the client itself: the player is designed to handle origin and control-plane failures by caching metadata, retrying against alternate OCAs, and degrading to a lower bitrate or a cached representation rather than failing the stream. The philosophy, repeated throughout the architecture, is that a user watching a movie should not notice that a third of the backend just disappeared — the system should absorb the failure behind latency, reduced quality, or a slightly stale recommendation, but the stream should keep playing.

## Interview Question and Model Answer

**Question:** Netflix places its own OCAs inside ISP networks rather than using a traditional multi-PoP CDN like Akamai or CloudFront. Walk through the economic and technical tradeoffs of this decision, and explain under what conditions the traditional CDN model would actually be preferable.

**Model Answer:** The OCA model is justified when two conditions hold: the traffic volume per ISP is high enough that transit and commercial-CDN egress costs dominate, and the content catalog is small enough relative to storage that a meaningful fraction of it can be pre-positioned on edge appliances. Netflix satisfies both: it pushes hundreds of gigabits per second into large ISPs, for which transit billing would be enormous, and its working set — the titles actually being watched in a given region on a given evening — is small enough to fit on a dense OCA, so cache hit rates are extremely high and reactive cache misses are rare. By colocating inside the ISP on settlement-free peering, Netflix converts a per-bit transit cost into a fixed depreciation cost on owned hardware, which is a massive win at their volume. The tradeoffs are real, however: Netflix bears the capital and operational cost of designing, shipping, and maintaining thousands of physical appliances worldwide, it must negotiate physical placement and peering with each ISP individually, and it has to build the entire fill, monitoring, and remote-management plane itself rather than buying it from a CDN provider. A traditional multi-PoP CDN is preferable when the traffic volume is too low to amortize the hardware and negotiation overhead, when the content working set is too large or too unpredictable to pre-position (so reactive caching at regional PoPs is actually more efficient), or when global geographic coverage matters more than depth within any single ISP — a startup streaming service or a long-tail video platform would be foolish to build its own Open Connect analog and should rent CDN capacity instead. The OCA model is a scale-driven architecture: it only wins once you are large enough that the fixed costs are dwarfed by the per-bit savings, which is why Netflix is one of the very few companies for which it makes sense.

**Common Pitfall:** Candidates often answer this question by asserting that Open Connect is faster because "the server is closer to the user," which is only partly true and misses the actual point. The last-mile latency advantage is real but modest; the dominant reason is economic — the elimination of transit and CDN-egress costs and the conversion of variable per-bit billing into fixed owned-hardware depreciation. A candidate who frames it purely as a latency optimization will be corrected, because a well-run traditional CDN can achieve comparable last-mile latency via edge PoPs. The real differentiator is that Netflix's model makes high-bitrate streaming economically sustainable at hundreds of gigabits per second per ISP, which a transit-billed CDN simply cannot. Confusing the latency story with the economic story is the single most common mistake on this question.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Netflix's Open Connect is a proprietary CDN — Netflix owns the hardware inside ISP data centers, not renting edge capacity
- The dominant advantage is economic (eliminating transit/egress costs), not just latency (last-mile proximity)
- Adaptive bitrate streaming (ABR): client requests different quality renditions based on available bandwidth
- Video is pre-transcoded at multiple bitrates/resolutions during ingestion, not on-the-fly
- Encoding ladder: 240p → 1080p → 4K, with per-title optimization (action movies get more bandwidth than talking heads)

**Common Follow-Up Questions:**
- "Why doesn't everyone build their own CDN like Netflix?" — It only makes sense for high-bitrate, static content at massive scale. Netflix's traffic is predictable and cacheable. Dynamic/low-volume content still needs traditional CDNs.
- "How do you handle a viral spike on a new video?" — Pre-warm edge caches by pushing popular content proactively. For unexpected spikes, origin shield absorbs the cache-miss traffic.

**Gotcha:**
- Netflix's CDN model works because video is immutable and high-bitrate — you cache once and serve millions of times. This model does NOT work for dynamic content (APIs, personalized feeds) where every response is unique. Don't propose an Open Connect-style architecture for a social media feed.
