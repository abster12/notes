---
title: "Video & Image Storage & Streaming"
category: "Media"
day: 29
difficulty: "Hard"
tags: [system-design, interview, media, video, streaming, transcoding, cdn, adaptive-bitrate, hls, dash]
last_updated: "2026-06-19"
---

# Video & Image Storage & Streaming

Storing and serving media at scale is a fundamentally different engineering problem from serving JSON APIs or transactional records. The single most important mental shift is that **throughput and egress cost, not request latency, become the dominant constraints**. A user will tolerate a two-second video buffer; they will not tolerate a profile picture that takes 800 ms to paint. That asymmetry forces every downstream decision — how you encode, how you tier, how you cache, how you bill — to optimize for sustained bytes-per-second and price-per-gigabyte-served rather than for p99 millisecond latency on an individual request. Media systems are also availability-first and eventually-consistent by temperament: a video that buffers is a worse experience than one showing a slightly stale thumbnail, so designs lean toward serving stale-but-available content over failing fast. The sections below walk through the full lifecycle from upload through transcoding, delivery, moderation, and long-term archival, with the capacity and bandwidth math a staff engineer is expected to produce on a whiteboard.

## Summary & Interview Framing

A system that stores, transcodes, and serves video at scale using adaptive bitrate streaming (HLS/DASH), CDN edge caching, and storage tiering for cost management.

**How it's asked:** "Design a video sharing platform like YouTube handling 500 hours of uploads/min and serving 1B users. Cover transcoding, adaptive bitrate, CDN strategy, and content moderation."

---

## Object Storage Architecture (S3-Like)

The foundation of any media platform is an object store — S3, Google Cloud Storage, Azure Blob, or a self-hosted equivalent like MinIO or Ceph RADOS. An object store is not a filesystem. There are no directories, no rename, no append; there are only buckets, keys, and immutable byte blobs with metadata. Internally, a system like S3 is built on a distributed key-value layer where a coordinator maps each object key to a placement group, and data is striped across many storage nodes with erasure coding or triple replication. A flat key such as `media/videos/{video_id}/720p/segment00012.ts` carries slashes only for human readability — the store treats it as an opaque string and uses a consistent-hash partitioning scheme to decide which nodes hold the bytes. The key design choices that matter at the application level are bucket-per-tenant versus shared-bucket (shared buckets with key-prefix sharding avoid per-bucket request-rate limits, which on S3 sit around 3,500 PUTs/s and 5,500 GETs/s per prefix before you need prefix partitioning), the consistency model (S3 is now strongly consistent for PUT-overwrites but still eventually consistent for delete propagation in some implementations), and the lifecycle policy that governs when objects transition between storage classes.

Object storage is engineered for durability and bulk throughput, not for millions of concurrent low-latency reads. It is cheap, horizontally scalable, and durable to eleven nines, but it was never designed to be the thing a player hits directly on every segment request. The cardinal rule of media architecture is that the object store is the origin of truth and the last-resort cache miss — never the serving tier. A CDN must sit in front of it, and hot content must be promoted to edge or to an in-process cache long before it reaches origin.

### Multipart Upload

Large media files cannot be uploaded as a single PUT. A 2 GB video uploaded in one stream is a 2 GB failure surface: a dropped connection at 1.9 GB means restarting from zero, the client holds the entire payload in memory, and the server cannot begin any processing until the final byte arrives. Multipart upload solves all three problems by letting the client break the object into independent parts, upload them in parallel with resumable retries, and then submit a final "complete" call that concatenates the parts server-side into a single logical object.

A typical flow has the client first call `CreateMultipartUpload` to get an upload ID, then issue `UploadPart` for each chunk (commonly 5–100 MB; S3 requires a minimum part size of 5 MB except for the last part), and finally `CompleteMultipartUpload` with the ordered list of part ETags. If any part fails, only that part is retried; if the user abandons the upload, an `AbortMultipartUpload` call prevents orphaned parts from accumulating as billable storage. For user-generated content, the production pattern is almost always presigned-URL based: the API server mints short-lived presigned URLs for each part so the client uploads directly to the object store, keeping the API server out of the data path entirely. A 5 GB file split into 50 MB parts becomes 100 parallel uploads saturating the user's bandwidth, and a network hiccup costs one 50 MB retry rather than a full restart. The interview-grade insight is that multipart upload is not just a reliability feature — it is the mechanism that makes parallel upload bandwidth and resumability possible, and the part-size choice is a real tuning knob: too small and you pay per-request overhead and hit the 10,000-part cap; too large and retries become expensive and tail latency rises.

```
                MULTIPART UPLOAD FLOW (Presigned-URL Pattern)

  Client                    API Server                 Object Store (S3-like)
    |                            |                            |
    | 1. Request upload          |                            |
    |  (file size, hash)         |                            |
    |--------------------------->|                            |
    |                            |                            |
    | 2. CreateMultipartUpload   |                            |
    |                           ---------------------------> |
    |                            |  3. Upload ID returned     |
    |                            |<---------------------------|
    | 4. Presigned URLs per part |                            |
    |<---------------------------|                            |
    |                            |                            |
    | 5. UploadPart #1  -------->| (out of data path) ------> |  (parallel)
    | 5. UploadPart #2  -------->|                        ---> |  (parallel)
    | 5. UploadPart #N  -------->|                        ---> |  (parallel)
    |    (5-100 MB each,         |                            |
    |     retry failed parts     |                            |
    |     independently)         |                            |
    |                            |                            |
    | 6. CompleteMultipartUpload |                            |
    |    (ordered ETag list)     |--------------------------->|
    |                            |                            |
    |                            |  7. Parts concatenated     |
    |                            |     into single object     |
    | 8. Upload complete ack     |                            |
    |<---------------------------|<---------------------------|
```

## CDN for Media Delivery

A Content Delivery Network is the layer that makes a media product economically viable. Without it, every video view is an egress charge from your origin region and a cross-continent round trip for the viewer; with it, 90–99% of bytes are served from an edge point-of-presence within tens of milliseconds of the user, and origin egress drops by an order of magnitude. For media specifically, the CDN is configured for large, cacheable, immutable objects — exactly the profile of HLS segments and resized image variants. Cache keys are derived from the object key plus a content-version hash, so invalidation becomes a matter of shipping a new key rather than purging an old one. Cache-hit ratio is the metric that pays the bills: a 95% hit ratio means the origin sees one request for every twenty the CDN serves, while a 70% ratio means the origin sees three times as much traffic and the egress bill triples. Tuning hit ratio on media workloads involves long TTLs (segments are immutable, so TTL can be days or weeks), conservative origin shielding (a single regional shield PoP absorbs misses so the true origin sees coalesced requests), and stale-while-revalidate semantics so a expired-but-still-correct object is served instantly while a refresh happens in the background.

For video, the CDN also performs just-in-time segment packaging and, increasingly, edge transcoding for the long tail of formats. Most major CDNs support origin shield, range requests (so a player can byte-seek into a segment), and token-based signed URLs for DRM and access control. The staff-level concern is cache pollution: if you key on per-user tokens or query strings, every distinct URL becomes a separate cache entry and your hit ratio collapses. The discipline is to separate the cacheable resource identity (the segment key) from the access-control decision (a signed URL with a short expiry that the CDN validates but does not incorporate into the cache key).

```
              CDN MULTI-TIER DELIVERY ARCHITECTURE

                          Viewers (global)
                             |    |    |
                  +----------+----+----+---------+
                  |    Edge PoPs (closest to user)  |
                  |    Cache hit ratio: 90-99%       |
                  |    TTL: days-weeks (immutable)   |
                  +----------+----+----+---------+
                             | cache MISS (rare)
                             v
                  +------------------------------+
                  |   Regional Origin Shield PoP   |
                  |   Coalesces misses -> 1 fetch  |
                  |   per unique object to origin  |
                  +--------------+---------------+
                                 | shield MISS (coalesced)
                                 v
                  +------------------------------+
                  |   Object Store Origin (S3-like)|
                  |   Source of truth / last resort|
                  |   Not the serving tier!        |
                  +------------------------------+

  Hot path:  Viewer -> Edge PoP (HIT)  ............  ~95-99% of bytes
  Warm path:  Viewer -> Edge -> Shield (HIT) ......  ~1-5% of bytes
  Cold path:  Viewer -> Edge -> Shield -> Origin ..  <1% (unique misses)
```

## Video Transcoding Pipeline

Raw uploads are unplayable at scale. A user's 4K phone recording is a multi-gigabyte blob in a container format with a codec and bitrate the player may not support, at a resolution that will stutter on mobile data. The transcoding pipeline's job is to turn that one source into a family of adaptive-bitrate renditions that a player can switch between in real time. The canonical pipeline is: ingest the source into object storage, partition it, transcode into multiple resolution-bitrate ladders, package each rendition into streaming segments, generate a manifest, publish to the CDN origin, and only then mark the video as ready.

```
          VIDEO TRANSCODING PIPELINE (Upload -> Publish)

  +-----------+    +-------------+    +------------------+
  | Raw Upload|--->| Object Store|--->| Source Partition |
  | (client)  |    | (source)    |    | (GOP chunking)   |
  +-----------+    +-------------+    +--------+---------+
                                                |
                       +------------------------+------------------------+
                       |                        |                        |
                  +----v----+              +----v----+              +----v----+
                  | 240p    |              | 720p    |    ...       | 1440p/  |
                  | 0.4Mbps |              | 3 Mbps  |              | 4K      |
                  +----+----+              +----+----+              +----+----+
                       |                        |                        |
                  +----v----+              +----v----+              +----v----+
                  | Package |              | Package |              | Package |
                  | (.ts)   |              | (.ts)   |              | (.ts)   |
                  +----+----+              +----+----+              +----+----+
                       |                        |                        |
                       +-----------+------------+----------+-------------+
                                   |                       |
                              +----v----+              +---v--------+
                              | Manifest|              | Thumbnails |
                              | (.m3u8) |              | + Sprites  |
                              +----+----+              +---+--------+
                                   |                       |
                              +----v----+                   |
                              | Publish |                   |
                              | to CDN  |<------------------+
                              | origin  |
                              +----+----+
                                   |
                              +----v----+
                              |  Mark   |
                              | READY   |
                              +---------+
```

A typical ABR ladder for general content is summarized below. Each rung is a deliberate trade between quality and the lowest device class you want to serve well; the bottom rung is what keeps the video playing on a congested subway. An audio-only rendition is included for background and low-bandwidth playback.

| Rendition | Resolution | Video Bitrate | Codec | Target Device |
|-----------|-----------|---------------|-------|---------------|
| Bottom rung | 240p | 0.4 Mbps | H.264 baseline | Congested mobile / 2G |
| Low | 360p | 0.8 Mbps | H.264 | Mobile data |
| Medium | 480p | 1.4 Mbps | H.264 | Low-end phones / slow WiFi |
| High | 720p | 3 Mbps | H.264 | Phones / tablets |
| Premium | 1080p | 5–6 Mbps | H.264 / HEVC | Desktop / smart TV |
| Ultra | 1440p | 8–12 Mbps | HEVC / AV1 | High-end displays |
| Ultra HD | 4K (2160p) | 12–16 Mbps | HEVC / AV1 | Premium / large screens |
| Audio only | — | 64–128 kbps | AAC | Background / low bandwidth |

### HLS and DASH Packaging

The two dominant adaptive streaming protocols are HTTP Live Streaming (HLS) and Dynamic Adaptive Streaming over HTTP (DASH). Both work the same way at a high level: the source is chopped into short segments (typically 2–10 seconds), each rendition gets its own set of segments, and a manifest file lists the available renditions and their segment URLs so the player can switch between them on the fly. HLS uses `.m3u8` playlists and `.ts` (MPEG-2 Transport Stream) or fMP4 segments; DASH uses `.mpd` manifests and `.m4s` fragments. HLS has broader device support, especially on iOS and Safari, and is the safe default for consumer-facing products. DASH offers finer-grained control, better DRM integration with Widevine/PlayReady, and lower-latency live variants. In practice many platforms encode once and package to both, or pick HLS and accept the ecosystem lock-in. The manifest is the player's map: a master playlist enumerates the renditions with their bandwidth attributes, and each rendition has a media playlist enumerating its segments. The player measures throughput over a rolling window of recent segment downloads, predicts the highest rendition it can sustain without rebuffering, and requests the next 2–3 segments ahead to maintain a buffer. The choice of segment length is a genuine trade: shorter segments (2s) reduce live latency and make the player more responsive to bandwidth changes but increase manifest overhead and request count; longer segments (6–10s) reduce overhead and encoding efficiency loss but make adaptation sluggish and live latency worse. For VOD, 4–6 seconds is common; for low-latency live, 2 seconds with CMAF chunked transfer is the modern norm.

### Adaptive Bitrate Logic

The player's ABR algorithm is where perceived quality is won or lost. A naive throughput-based controller measures the last few segment download rates, picks the highest rendition whose bitrate fits within 70–80% of measured throughput (leaving headroom for variance), and maintains a 10–30 second buffer. This works but is brittle on cellular networks where throughput swings wildly. More sophisticated controllers (BBA, BOLA, and the model-based MPC schemes used by Netflix and YouTube) combine throughput estimates with current buffer level and recent rebuffer history, aggressively downswitching when the buffer drains below a panic threshold and cautiously upswitching only when the buffer is healthy and throughput is stable. The staff engineer's point: ABR lives in the client, which means you ship bugs you cannot hotfix without an app update, so the rendition ladder and segment length must be chosen to be forgiving of imperfect client logic.

```
          HLS ADAPTIVE BITRATE FLOW (Player-Side)

  Player                          CDN Edge
    |
    | 1. Fetch master playlist (master.m3u8)
    |----------------------------------------->|
    |<-----------------------------------------|
    |    renditions: [240p 0.4M, 720p 3M, 1080p 5M, ...]
    |
    | 2. Measure throughput over rolling window
    |    (last 2-3 segment downloads)
    |
    | 3. Predict max sustainable rendition
    |    (bitrate <= 70-80% of measured throughput)
    |
    | 4. Request next 2-3 segments ahead  (720p / seg_0042.ts)
    |----------------------------------------->|
    |<-----------------------------------------|  segment bytes
    |
    | 5. Buffer grows (target: 10-30s)
    |
    | 6. Conditions change (bandwidth drops)  ---+
    |                                            |
    | 7. DOWN-SWITCH (panic if buffer < threshold)
    |    Request lower rendition (240p / seg_0043.ts)
    |----------------------------------------->|
    |<-----------------------------------------|
    |
    | 8. Buffer recovers, throughput stable
    |    -> CAUTIOUS UP-SWITCH (720p -> 1080p)
    |
    | Key: aggressive downswitch, cautious upswitch
```

## Thumbnail Generation

Every video needs a poster image for the scrubber, the feed, and the embed preview. The naive approach — extracting a frame at the zero-second mark — frequently produces a black or fade-in frame and a useless thumbnail. The production approach is to extract several candidate frames (commonly at 1s, 25%, 50%, 75%, and 90% of duration), score them for brightness, contrast, and face presence, and select the most visually informative one, optionally letting the uploader choose. The workhorse tool is ffmpeg: `ffmpeg -i input.mp4 -ss 00:00:01 -frames:v 1 -q:v 2 poster.jpg` extracts a single high-quality JPEG. For scrubbing previews, a sprite sheet — a single image containing a grid of frames sampled at one or two per second across the whole video — lets the player show a thumbnail on hover with a single image load rather than hundreds of per-second requests. A 10-minute video at one frame per second produces 600 frames; laid into a 30x20 grid at 160x90 each, that is a single 4800x1800 sprite the player crops client-side. Sprites are generated as part of the transcoding job and stored alongside the renditions, and because they are immutable they cache forever on the CDN.

## Image Processing (Resize, Crop, Format)

Images are simpler than video but have their own depth. The pattern is to store the original once and generate variants on upload, never on read: resizing on every request burns CPU on the hot serving path and makes response time unpredictable. A standard avatar or photo upload produces a thumbnail (e.g. 100x100, cropped), a small (400px wide), a medium (800px), and the original, each written to a versioned key such as `media/{content_hash}/{variant}/{filename}`. Modern format choice is WebP or AVIF with a JPEG fallback: WebP is 25–35% smaller than JPEG at equivalent quality and is now universally supported, while AVIF pushes that to 40–50% smaller at the cost of slower encoding. EXIF metadata is always stripped on upload — it leaks geolocation and device fingerprints and adds needless bytes. The two hard problems are crop semantics (a smart face-aware crop beats a naive center crop for portraits) and the format-encoding CPU budget, which is why variant generation is offloaded to async workers and the serving path only ever reads pre-rendered bytes. A subtle but important operational detail is to generate variants with a deterministic pipeline (same input always produces the same output bytes) so that variant keys are content-addressable and cacheable indefinitely — any change to the resize or encoding parameters ships under a new variant key, never by overwriting.

## Storage Tiering (Hot, Warm, Cold)

Not all bytes are equally valuable, and storing everything on the fastest tier is ruinously expensive. The production pattern is lifecycle-driven tiering: newly uploaded and recently accessed content lives on hot storage (NVMe-backed object storage or CDN edge cache) for fast first-byte; content that has not been touched in a week or two transitions to warm storage (standard HDD-backed object storage, still milliseconds to first byte but cheaper per GB); and content untouched for 30–90 days transitions to cold or archive tiers (S3 Glacier, GCS Archive, Azure Archive) where retrieval takes minutes to hours and the per-GB-month price is a fraction of standard. The transition rules are encoded as object-storage lifecycle policies: "move prefix `media/videos/` objects to Glacier after 60 days of no access, delete after 365 days unless tagged `keep`." The economic lever is access frequency prediction. Popular and recently uploaded content is hot and must stay hot; the long tail of rarely-watched videos is cold and should pay cold-tier prices. A viral event re-promotes cold content back to hot — this is a restore request that costs both money and latency, so the design must allow rapid promotion (expedited retrievals, or simply re-transcoding from the source if the renditions were deleted). The staff engineer's framing: tiering is a bet on the access distribution, and for UGC video that distribution is power-law — a tiny fraction of videos generates the vast majority of views, so aggressively cold-tiering the tail is where the savings are. The failure mode is mis-tiering something that goes viral and paying expedited-retrieval premiums at the worst possible moment, which is why promotion-on-demand and keeping the source rendition available for fast re-transcode are the safety nets.

| Tier | Backing | Retrieval Latency | Cost / GB-mo | Typical Age | Use Case |
|------|---------|-------------------|--------------|-------------|----------|
| Hot | NVMe / CDN edge cache | < 50 ms | High | 0–7 days | New + recently accessed |
| Warm | HDD-backed object storage | ms–tens of ms | Medium | 7–30 days | Standard, untouched |
| Cold / Archive | Glacier / Archive | minutes–hours | Very low | 30–90+ days | Long tail, rarely watched |
| Source (retained) | Standard | ms | Medium | Until re-transcode safety net expires | Fast re-promotion on viral |

## Deduplication

User-generated content has enormous duplication: the same meme re-uploaded thousands of times, the same profile photo re-avatared across services, the same source video re-encoded. Deduplication is built on content-addressable storage — compute a cryptographic hash of the file bytes and use the hash as (part of) the storage key, so two clients uploading identical bytes resolve to the same object and the second upload is a no-op. In practice you compute a SHA-256 of the content (or a fast BLAKE3 if throughput matters), use the first 16 hex characters as the storage key prefix, and issue a HEAD request before uploading: if the key exists, skip the bytes entirely and just record a reference in the metadata database. This works perfectly for exact duplicates but does nothing for near-duplicates (the same video re-encoded at a different bitrate hashes differently), so for video the bigger savings come from storing a single source and deriving all renditions on demand rather than storing pre-rendered ladders forever. The gotcha is that content-addressable dedup is incompatible with per-user encryption or per-tenant keys — if every user encrypts with their own key, identical plaintexts produce different ciphertexts and dedup breaks, which is why most platforms dedup only within unencrypted platform-owned storage and accept the trade.

## Content Moderation

Any platform accepting user uploads must screen for illegal and policy-violating content before it reaches other users, and for media this is a pipeline problem layered on top of the transcoding pipeline. The standard flow runs every upload through, in parallel: an automated virus/malware scan (ClamAV or a commercial equivalent), an image-classification model for nudity, violence, and banned symbols, a video-frame sampling pass that runs the same classifiers on sampled frames, a text-extraction pass (OCR) for overlaid text and a speech-to-text pass for audio, and a perceptual-hash match (PhotoDNA for known illegal imagery) against databases of previously-identified violating content. The automated pass produces a risk score; high-confidence violations are blocked before publish, medium-confidence items are queued for human review, and low-risk items are published with a post-hoc review queue. The operational reality is that no classifier is perfect, the false-positive cost is a legitimate user blocked and the false-negative cost is policy or legal liability, so the system must be designed for human-in-the-loop review with a review queue, appeal flow, and audit log. For video, moderation must run on the source before renditions are published to avoid the cost of transcoding content that will be taken down, which means moderation is on the critical path of publish latency — a real tension between safety and speed that is resolved by publishing thumbnails and low-res previews early while the full moderation pass completes.

## Capacity Estimation: 500M Users Uploading Video

The numbers a staff candidate is expected to produce, with assumptions stated explicitly. Assume 500 million monthly active users, of whom 5% upload a video in a given month, so 25 million new videos per month. Assume an average raw upload size of 300 MB (a mix of short clips and longer recordings).

**Ingest:**
- Raw source ingest: 25M videos × 300 MB = 7.5 PB / month
- Daily ingest: ~250 TB / day
- After 15% dedup elimination: ~6.4 PB effective new content / month

**Durable storage (rendition ladder):**
- A 300 MB source produces ~400 MB across all renditions + a few MB of thumbnails/manifests
- Call it ~500 MB of durable output per video
- New rendition storage: 25M × 500 MB = 12.5 PB / month
- Annual growth: ~150 PB / year (before tiering/retention)

**Steady-state active storage:**
- 90-day hot retention + 365-day warm retention + older content to archive
- Steady-state active storage: tens of PB + long archive tail

**Ingest bandwidth (edge):**
- 250 TB/day over 86,400 s ≈ 24 Gbps sustained upload throughput
- Evening peak factor 3–5x average → provision 100+ Gbps ingest capacity globally
- Distributed across CDN ingest PoPs

**Transcoding compute:**
- 5-rung ladder encoding: ~1–2 min GPU time or 5–10 min CPU time per video
- At 25M videos/month: ~400,000–800,000 GPU-hours / month
- Or ~2–4 million CPU-hours / month
- Fleet: hundreds of GPU transcoders or thousands of CPU workers running continuously

## Bandwidth Planning

Egress is where the money goes. The same 25 million uploaded videos are viewed far more than they are uploaded; assume an average of 100 views per video over its lifetime (heavily long-tailed — most videos get few views, a few get millions). At 500 MB of rendition data consumed per view on average (a viewer does not watch every rendition, but across all viewers and rewatching, assume roughly one full-equivalent stream's worth of bytes per view), that is 2.5 PB of egress per month in the view-weighted steady state, and realistically much more for a successful platform. Sustained, that is roughly 9.6 Gbps average egress, but the peak factor for video is severe — evening prime time in each region can run 4–8x average — so the network and CDN must be sized for 40–80 Gbps of global peak egress, and a single viral event can spike a single video to tens of Gbps on its own. This is exactly why the CDN is non-negotiable: serving 80 Gbps from a single origin region is both a latency disaster and an egress-bill disaster, while serving it from edge PoPs keeps the origin egress to the cache-miss fraction (single-digit percent) and moves the cost into CDN bandwidth, which is cheaper and closer to the user. Bandwidth planning also has a unit-economics dimension: if you pay the CDN $0.02/GB served and the average view streams 30 MB, the per-view bandwidth cost is a fraction of a cent — but at a billion views a month it is real money, and the lever is aggressive caching, lower-bitrate ladders for mobile, and codec upgrades (H.265 or AV1 cut bytes per view 30–50% at equivalent quality, directly reducing the egress line item).

## Interview Question

**Question:** "You run a video platform with 500M users. A single 4K video goes viral and within ten minutes accounts for 40% of global traffic, concentrated in one region. Walk me through every layer — from the player's ABR decision to your CDN edge to your origin object storage to your transcoding capacity — and tell me where this breaks first and what you do about it."

**Model Answer:** The first thing that breaks is not the origin — it is the CDN edge cache for that specific video's segments in the affected region, because even a 95% hit ratio leaves 5% of a 40% global-traffic spike hitting the origin, which can be tens of Gbps of miss traffic. The mitigation sequence: first, the CDN's origin shield coalesces those misses so the true object-store origin sees only a handful of unique segment requests, not millions — this is the single most important architectural decision and it must already be in place, not added during the incident. Second, the player's ABR controller downshifts users to lower renditions as edge bandwidth saturates, which naturally reduces per-view bytes and is the self-healing property of ABR — but only if the lowest renditions were pre-generated, which is why the 240p/360p rungs exist. Third, I proactively pre-warm the edge caches for the viral video's segments across nearby regions by issuing prefetch requests from the CDN's origin shield, converting the next wave of demand into cache hits before it arrives. Fourth, I watch the transcoding pipeline only if the viral video is freshly uploaded and its renditions are still being generated — a video going viral mid-transcode is a real failure mode, so the pipeline must prioritize completing the lower renditions first so that something playable exists for every ABR rung before the higher rungs finish. The layer that breaks first if I have not done the shield-and-prefetch work is the origin object store, which will rate-limit or throttle and cascade into rebuffering for every cache miss; the layer that breaks first even with good shielding is the regional edge egress capacity, which is why multi-CDN and regional capacity headroom are the structural answers. The staff answer also names the unit-economics: a viral event at this scale can add tens of thousands of dollars of egress per hour, so the same prefetch-and-cache logic that protects availability also protects the margin.

## Common Pitfalls

**Transcoding on read.** Running ffmpeg on every request, or even on first request with caching, collapses under load because transcoding is seconds-to-minutes of CPU per video and is fundamentally incompatible with a serving path that must return in tens of milliseconds. Always transcode on upload or on a background job, and serve only pre-rendered bytes. The exception — on-demand transcoding for the long tail of rarely-requested formats — is acceptable only if it is aggressively cached and bounded by a queue, never on the synchronous request path.

**Serving from object storage directly.** Object storage was not designed for millions of concurrent low-latency reads; it rate-limits per prefix, has higher latency than edge, and its egress is the most expensive bandwidth you can buy. A CDN in front is not an optimization, it is a requirement, and the origin should be shielded so the object store never sees the raw fanout of a cache miss storm.

**No upload size limits or part-size tuning.** A single 20 GB upload with no multipart will saturate a transcode worker for an hour and block the pipeline; a multipart upload with 1 MB parts will hit the 10,000-part cap on a 10 GB file and pay per-request overhead. Enforce a maximum upload size at the API layer, choose a part size that balances parallelism against retry cost (50–100 MB is a sane default for video), and abort abandoned multipart uploads aggressively so orphaned parts do not accumulate as billable storage.

**Keying CDN cache on per-user tokens.** Signing every media URL with a per-user token and letting that token become part of the cache key turns a single segment into millions of cache entries and destroys hit ratio. The signed URL must authorize access without entering the cache key — the CDN validates the signature and serves the cacheable underlying object, keeping the key stable across users.

**Ignoring codec and format evolution.** H.264 is the safe baseline, but H.265/HEVC cuts bytes 40% at equivalent quality (with licensing cost) and AV1 is royalty-free with even better compression but heavy encode cost. Sticking with H.264 forever means paying 30–40% more in egress and storage than necessary at scale, while jumping to AV1 without accounting for encode CPU can starve the transcode pipeline. The right move is a codec ladder — H.264 for broad compatibility, HEVC/AV1 for premium and high-traffic content where the egress savings justify the encode cost — and revisiting it annually as codec support and hardware acceleration shift.

| Codec | Royalty | Compression vs H.264 | Encode Cost | Best Use |
|-------|---------|---------------------|-------------|----------|
| H.264 (AVC) | Yes (low) | Baseline (1.0x) | Low | Broad compatibility default |
| H.265 (HEVC) | Yes (high) | ~40% smaller | Medium | Premium + high-traffic |
| AV1 | Royalty-free | ~30–50% smaller | High (heavy) | Premium, AV1-hw accelerated |

**Treating content moderation as an afterthought.** Running moderation only after publish means illegal content is briefly available and you eat both the legal risk and the wasted transcode cost for content that gets removed. Moderation must gate publish and run on the source before renditions are generated, with human review for the ambiguous middle and an audit trail for every decision.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Media storage is throughput and egress cost-driven, not latency-driven — different optimization target from APIs
- Adaptive bitrate streaming (HLS/DASH): client selects quality based on bandwidth; segments are pre-encoded
- Encoding ladder: multiple renditions per video (240p to 4K); per-title optimization allocates more bits to complex content
- Storage tiering: hot content on SSD/CDN edge, warm on HDD, cold archive on glacier-class storage
- Content moderation must gate publish, not run post-publish — avoid serving illegal content and wasting transcode cost

**Common Follow-Up Questions:**
- "How do you handle thumbnails for millions of videos?" — Generate at upload time, store as small JPEGs in object storage, cache aggressively in CDN. Lazy-generate for edge cases.
- "What's the egress cost problem?" — Serving video is bandwidth-intensive. A 10MB video served 1M times = 10TB egress. CDN reduces origin egress but edge bandwidth still costs. This is why Netflix built their own CDN.

**Gotcha:**
- Treating content moderation as an afterthought. Running moderation only after publish means illegal content is briefly available and you eat both the legal risk and the wasted transcode cost for content that gets removed. Moderation must gate publish and run on the source before renditions are generated.
