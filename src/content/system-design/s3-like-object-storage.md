---
title: "S3-like Object Storage"
type: system-design
category: Advanced
date: 2026-05-24
tags: [system-design, interview, object-storage, s3, scalability]
aliases: [Object Store, Blob Storage]
---

# S3-like Object Storage

## Summary & Interview Framing

A distributed storage system with a flat namespace (bucket/key), metadata service for key-to-location mapping, and data nodes with replication or erasure coding for durability.

**How it's asked:** "Design an S3-like object storage system for 1 exabyte of data with 99.999999999% durability. Cover metadata sharding, replication, erasure coding, and garbage collection."

---

## Overview

An object storage system stores arbitrary binary blobs — objects — inside flat, globally-named buckets addressed over a REST API. Unlike a file system, which organizes data into a hierarchy of directories and inodes, or block storage, which exposes raw fixed-size sectors to an operating system, an object store treats each blob as an opaque payload coupled with arbitrary user-defined metadata and addressed by a unique string key. There is no directory traversal, no seek, no partial overwrite; the unit of access is the whole object. At Amazon S3 scale this design serves exabytes of data and tens of millions of requests per second while advertising 99.999999999% (eleven nines) durability and 99.99% availability, numbers that are only achievable because the system decouples the read/write path from a metadata layer that can be independently scaled, replicated, and made consistent.

The architectural insight that makes object storage tractable at exabyte scale is the deliberate separation of the data plane (the bytes themselves, stored on cheap, dense disks across hundreds of thousands of nodes) from the control plane (a metadata service that maps bucket+key to a physical location, enforces access control, and tracks versions). Reads and writes never touch the metadata service after the initial placement decision except to update bookkeeping, which lets the data plane scale horizontally with the number of storage nodes while the metadata service scales by sharding on the key space. Everything else in this design — erasure coding, multipart upload, lifecycle policies, replication, garbage collection — is a consequence of that split and the scale it implies.

## Architecture: Bucket, Object, Key

A bucket is a flat, globally-unique namespace container. Bucket names are DNS-compliant (3-63 chars, lowercase, no underscores, must start and end with a letter or number) because they appear in the virtual-hosted-style URL `https://<bucket>.s3.<region>.amazonaws.com`, which means the name must be globally unique across all customers and resolvable by DNS. A bucket is created in a single region — the region is where the primary data and metadata live — though replication and cross-region access can make the data appear elsewhere. Each bucket carries configuration: a region, a versioning state, lifecycle rules, an encryption default, a logging destination, and an access policy. There is a soft limit of roughly 100 buckets per account because bucket metadata is replicated and indexed globally, and the act of creating or deleting a bucket is a rare, expensive, eventually-consistent operation.

An object is the atomic unit of storage: a blob of bytes from zero to five terabytes, plus a bundle of metadata. The metadata is split into system metadata (ETag, content-type, content-length, last-modified, version-id, storage class, encryption state, owner) which the service sets, and user metadata (arbitrary key-value pairs supplied via `x-amz-meta-*` headers) which the client controls. The ETag is normally the MD5 of the object body, which makes integrity checking cheap and lets clients verify uploads without a second round-trip; for multipart uploads the ETag becomes a composite hash of the part MD5s and is not a simple object MD5, a subtlety that trips up clients that assume ETag equality implies byte equality.

The key is the unique identifier of an object within a bucket. Despite looking like a path (`photos/2026/june/sunset.jpg`), it is a flat string — the slashes are convention, not directory boundaries. This flat namespace is critical: it lets the system hash the key to a partition without traversing a tree, and it lets a single bucket hold effectively unlimited objects (trillions) without any directory-inode scaling wall. The slash convention is preserved only so that prefix-based listing (`ListObjectsV2` with `prefix=photos/2026/`) and prefix-based lifecycle and replication rules can use lexical ordering to group related keys. The trade-off for flatness is that listing is a lexicographic scan with a delimiter, not a tree walk, which means "list this directory" is O(matching keys) rather than O(children) — a fact that shapes how clients should lay out keys for performance.

```
                     OBJECT STORAGE ARCHITECTURE
                     ============================

   Client (REST API)
      |   PUT/GET/DELETE  https://<bucket>.s3.<region>.amazonaws.com/<key>
      v
 +----------------------------------------------------------+
 |                  CONTROL PLANE                           |
 |   Metadata Service (sharded, quorum-replicated KV)       |
 |                                                           |
 |   maps (bucket, key, version-id) -> physical location     |
 |                                                           |
 |    +----------------+   +----------------+               |
 |    | Metadata Shard |   | Metadata Shard |  ...          |
 |    |  (hash shard)  |   |  (hash shard)  |               |
 |    |  B-tree/LSM    |   |  B-tree/LSM    |               |
 |    |  in-memory +   |   |  in-memory +   |               |
 |    |  WAL on disk   |   |  WAL on disk   |               |
 |    +-------+--------+   +--------+-------+               |
 |            |                     |                        |
 |            +---------+ +---------+                        |
 |                      | |                                  |
 |            resolves location + authz                       |
 +----------------------|-|----------------------------------+
                        | |
                        v v
 +----------------------------------------------------------+
 |                   DATA PLANE                             |
 |   Log-structured storage nodes (hundreds of thousands)   |
 |                                                           |
 |   hash(bucket+key) -> partition -> replication group      |
 |                                                           |
 |    +---------+   +---------+   +---------+               |
 |    | Node A  |   | Node B  |   | Node C  |  ...          |
 |    | AZ-1    |   | AZ-2    |   | AZ-3    |               |
 |    | disk    |   | disk    |   | disk    |               |
 |    +---------+   +---------+   +---------+               |
 |                                                           |
 |   Object = bytes (0 .. 5 TB) + metadata bundle            |
 |     system metadata: ETag, size, version-id, class...     |
 |     user metadata:    x-amz-meta-*  key-value pairs       |
 +----------------------------------------------------------+

   Key insight: data plane scales with node count;
                metadata plane scales by sharding the key space.
   Read/write touch metadata only for placement + bookkeeping.
```

## Metadata Management

The metadata service is the brain of the system. It is a distributed, sharded key-value store (in S3 this role is played by a system evolved from a DynamoDB-like layer) that maps each `(bucket, key, version-id)` tuple to a storage location: a set of disks, an erasure-coding stripe layout, and the offset and length of the object's data blocks. It also stores all object metadata: size, ETag, creation time, user metadata, storage class, encryption metadata, and a pointer to the object's data. Every GET and PUT consults the metadata service first to resolve where the bytes live and to check authorization, so the metadata service must be fast (single-digit millisecond lookups), highly available, and able to scale to trillions of entries.

The metadata store shards on a hash of the bucket+key so that load and storage are spread across thousands of metadata nodes. Because metadata records are small (hundreds of bytes) and randomly accessed, they live entirely in memory on the metadata nodes, backed by a write-ahead log on disk for durability. Each metadata entry is replicated across multiple nodes (typically three) with a quorum protocol (Raft or a Paxos variant) so that a single metadata node failure does not lose the mapping. The cardinal scaling challenge is that a single bucket may hold billions of objects, each generating a metadata row, and listing operations must paginate across shards; the service uses a tiered index — a per-shard B-tree or LSM-tree keyed by `(bucket, key)` — so that prefix scans and pagination are efficient without loading the entire keyspace.

A subtle but important property is that the metadata service is the consistency boundary. The data plane (the disks holding the bytes) is allowed to be eventually consistent with respect to overwrites and deletes, because the metadata version-id and generation number determine which physical bytes are authoritative. When a client overwrites an object, the system writes a new version of the bytes, then atomically flips the metadata pointer to the new version; until the flip, reads see the old version, and after the flip, reads deterministically see the new one. This indirection is what later allowed S3 to upgrade from eventual consistency to strong read-after-write consistency without rearchitecting the data plane — the metadata pointer flip is a single atomic operation.

## Consistency Models

For most of S3's history, the consistency story was: read-after-write for new objects (a PUT followed by a GET of a previously-nonexistent key always returned the new object), but eventual consistency for overwrites and deletes (a PUT that overwrites an existing key, or a DELETE, could be followed by a GET that returned the stale version or the deleted object, briefly). This eventual consistency arose because writes were fanned out to multiple storage nodes and the response was returned before every replica acknowledged, so a read routed to a lagging replica could see old data. The system offered "read-after-write" only for the create case because the absence of a prior version made the write unambiguous.

In late 2020 S3 moved to strong read-after-write consistency for all operations in all regions, with no application change required. The mechanism relies on the metadata service being the single source of truth for "which version is current." A write completes only once the new bytes are durably stored and the metadata pointer has been atomically updated across the quorum; a read resolves the current version from the same metadata quorum before fetching bytes. Because the version selection is serialized through the metadata service, a read cannot see a stale version — it either sees the old pointer (if the read started before the write committed) or the new pointer (if it started after), never a torn or ghost version. This came at the cost of slightly higher write latency (the write must wait for the metadata commit, not just the data quorum) and tighter coupling between the data and metadata planes, but eliminated an entire class of application bugs.

A residual consistency nuance remains for global bucket existence and for cross-region replication: creating a bucket and immediately listing buckets in a different region's control plane is eventually consistent, and cross-region replication (CRR) is asynchronous by design, so a read in the destination region may lag the source. Concurrent writers to the same key with versioning disabled still produce a last-writer-wins race resolved by timestamp; with versioning enabled, both writes succeed and produce distinct version-ids, so no data is lost but the client must reconcile. Designers should treat "strong consistency" as scoped to a single key in a single region, not as a global invariant across regions.

```
              CONSISTENCY MODEL FLOW (strong read-after-write)
              ===============================================

   Client                Metadata Quorum           Data Nodes
     |                         |                       |
     |  1. PUT key=v2          |                       |
     |------------------------>|                       |
     |                         |  2. write new bytes   |
     |                         |---------------------->|
     |                         |                       |
     |                         |  3. ack durably stored|
     |                         |<----------------------|
     |                         |                       |
     |                         | 4. atomic pointer     |
     |                         |    flip  v1 -> v2     |
     |                         |   (quorum commit)     |
     |  5. 200 OK              |                       |
     |<------------------------|                       |
     |                         |                       |
     |                         |                       |
     |  6. GET key             |                       |
     |------------------------>|                       |
     |                         | 7. resolve current    |
     |                         |    version = v2       |
     |                         | 8. fetch bytes @v2    |
     |                         |---------------------->|
     |                         | 9. return v2 bytes    |
     |                         |<----------------------|
     | 10. v2 bytes            |                       |
     |<------------------------|                       |
     |                         |                       |

   Rule: a read sees EITHER the old pointer (if it started before
         step 4's commit) OR the new pointer (after). Never torn.
   The metadata quorum is the consistency boundary; the data plane
   can lag because version selection is serialized via metadata.
```

## Partitioning Strategy

The system must distribute trillions of objects and millions of requests per second across hundreds of thousands of storage nodes, which demands a partitioning scheme that is both balanced and stable under growth. The approach is hash-based partitioning on the key, combined with an order-preserving sub-index for prefix listing. Each object's `(bucket, key)` is hashed, and the hash space is divided into partitions; each partition is assigned to a storage node (or, more precisely, to a replication group of nodes). Because the hash distributes keys uniformly, hot buckets spread their load across many partitions automatically — provided the keys within a bucket are themselves high-cardinality.

The famous failure mode is the hot-prefix problem. If a customer uses sequential, time-ordered keys like `logs/2026-06-19-00-00-01.bin`, `logs/2026-06-19-00-00-02.bin`, all keys share a prefix and, because the hash is applied to the whole key but the partition assignment historically had order-preserving locality for listing efficiency, a burst of writes to a single prefix could all land on the same partition and saturate one storage node while the rest of the cluster sat idle. S3 addressed this by partitioning on a hash of the entire key (not the prefix) and by auto-splitting hot partitions: when a partition's request rate exceeds a threshold, the system splits it into child partitions and redistributes them across nodes, transparently to the client. The guidance to clients was historically to add a hash prefix (`<hash>/logs/...`) to spread load, though modern auto-splitting has largely retired that workaround.

Partition splits are the key elastic mechanism. A partition is a contiguous range of the hash ring owned by a replication group; as either its stored bytes or its request rate grow, the partition splits in half and each half is reassigned, with data migrated in the background via a handoff process. This lets a single bucket scale from one object to trillions without the client choosing a sharding scheme. The trade-off is that list operations now span multiple partitions and must be merged, which is why listing a huge bucket is slow and eventually-consistent at the pagination boundary. For exabyte-scale deployments the operator's job is to ensure the hash function has no clustering and that auto-splitting thresholds are tuned so that no partition becomes a bottleneck before the splitter catches up — a monitoring problem as much as an algorithmic one.

## Replication: Same-Region and Cross-Region

Replication is how the system turns cheap, failure-prone disks into eleven-nines durability. There are two distinct kinds. Same-region replication (SRR) and the underlying intra-region durability mechanism place multiple copies of an object's data within a single region but across distinct failure domains — separate racks, separate Availability Zones (AZs), separate power and network planes — so that a single AZ outage does not cause data loss. Cross-region replication (CRR) asynchronously copies objects from a source bucket to a destination bucket in a different region, serving disaster recovery, latency reduction for geographically distributed readers, and regulatory data-sovereignty requirements.

The intra-region durability mechanism is not naive full-copy replication. Modern S3 uses erasure coding (described below) rather than storing three identical copies, which delivers the same durability at roughly one-third less raw disk. Whatever the scheme, the write path acknowledges success only once a quorum of the durability copies (or erasure fragments) are durably persisted across multiple AZs, so a power loss or single-AZ failure after the PUT returns 200 cannot lose the object. Replication within the region is synchronous with respect to the write; replication across regions is asynchronous because synchronously waiting for an intercontinental round-trip on every write would impose hundreds of milliseconds of latency.

Cross-region replication is configured per-bucket with a rule specifying a destination bucket, a role with permission to read the source and write the destination, and an optional key filter. Once enabled, new objects are replicated automatically; the metadata is copied and the bytes are streamed to the destination region's storage nodes. Replication has a replication time control (RTC) SLA — typically 15 minutes for 99.99% of objects — and emits `Replication:Completed` event notifications. Existing objects are not retroactively replicated unless a batch replication job is run. The subtlety is that CRR is eventually consistent: a GET against the destination immediately after the source PUT may 404, and if the source object is overwritten before the first replication completes, the destination may see the later version only. For delete markers, replication can be configured to replicate or not, and the choice has compliance implications (a retention-locked delete in the source may need to propagate, or may be forbidden to).

## Versioning

Versioning is the mechanism that makes overwrites and deletes non-destructive. When versioning is enabled on a bucket, every PUT creates a new immutable object version with a unique, randomly-generated version-id rather than replacing the prior data. A GET without a version-id returns the "current" version (the one with the latest version-id marker); a GET with a specific version-id returns that exact version. A DELETE does not erase data — it inserts a delete marker as the new current version, so a subsequent GET returns 404, but `GET?version-id=<prior>` still returns the object. This makes accidental overwrites and deletes recoverable and is the foundation of object-lock retention and legal-hold compliance workflows.

The cost of versioning is storage: every overwrite and every delete consumes space for the prior versions until they are explicitly purged or aged out by lifecycle rules. This is why lifecycle rules with `NoncurrentVersionExpiration` are essential for versioned buckets that see churn, or storage costs grow unbounded. The metadata service stores one row per version, so a key with one million versions has one million metadata rows and listing versions (`ListObjectVersions`) must paginate across all of them, which is expensive. The system also offers MFA-delete, requiring a multi-factor token to delete a version or change the bucket's versioning state, as a defense against credential compromise. A key design point: versioning, once enabled, cannot be fully "disabled" — it can be suspended (new writes stop generating new version-ids and overwrite the current version), but old versions persist and must be lifecycle-expired.

## Multipart Upload

Objects up to 5 TB cannot be reasonably uploaded in a single HTTP request: a network hiccup at 4 TB means restarting the whole upload, and a single TCP stream cannot saturate available bandwidth. Multipart upload solves this by letting the client break a large object into parts (1 to 10,000 parts, each 5 MB to 5 GB except the last), upload each part independently and in parallel, and then commit them with a single `CompleteMultipartUpload` call that concatenates the parts in order into the final object. Each part is uploaded to a `/uploads/<upload-id>/partNumber` path and can be retried independently; failed parts can be re-uploaded without affecting the others.

The upload-id is a metadata-service-generated token that tracks the in-progress multipart session; the service records each completed part's ETag and size as it arrives. On `CompleteMultipartUpload`, the service validates that all part numbers are present and contiguous, concatenates the part data (either logically by linking extent metadata, or physically by stitching on disk), computes the final object ETag (a composite of the part MD5s), and atomically creates the object version — only at this point does the object become visible to plain GET. Because parts are stored separately before completion, an abandoned multipart upload leaves orphaned parts consuming storage and billing; this is why lifecycle rules include `AbortIncompleteMultipartUpload` to garbage-collect uploads not completed within N days. Multipart is not just for huge objects — for any object over roughly 100 MB, the resilience and parallelism benefits justify it, and most SDKs auto-use multipart transparently above a threshold.

```
                MULTIPART UPLOAD FLOW
                ====================

   Client                     Object Storage
     |                              |
     | 1. CreateMultipartUpload     |
     |----------------------------->|
     |    returns upload-id (token) |
     |<-----------------------------|
     |                              |
     | 2. UploadPart #1 (parallel)  |
     |----------------------------->|  store /uploads/<id>/1
     |    ETag p1                   |
     |<-----------------------------|      \
     |                              |       |
     | 3. UploadPart #2 (parallel)  |       |  independent
     |----------------------------->|  store /uploads/<id>/2     retry;
     |    ETag p2                   |       |  no restart-all
     |<-----------------------------|      /   on failure
     |                              |       |
     | ... 1..10,000 parts ...      |       |
     |  (5 MB .. 5 GB each,         |       |
     |   last part may be smaller)  |       |
     |                              |       |
     | 4. CompleteMultipartUpload   |
     |    (list of part# + ETags)   |
     |----------------------------->|
     |    validate all parts present|
     |    + contiguous             |
     |    concatenate in order      |
     |    (link extents / stitch)   |
     |    compute composite ETag    |
     |    atomically create version |
     |    -> object now visible     |
     |    to plain GET              |
     |<-----------------------------|
     |                              |
     | (abandoned? lifecycle rule   |
     |  AbortIncompleteMultipart-   |
     |  Upload GCs parts after N d) |
```

## Lifecycle Policies

Lifecycle policies are declarative rules that transition objects between storage classes or delete them based on age, prefix, tags, or version status, automating cost and retention management at exabyte scale where manual intervention is impossible. A rule is a JSON document with a filter (prefix and/or tags) and a list of transitions and expirations: `transition` moves an object to a cheaper storage class after N days (e.g., Standard to Standard-IA after 30 days, to Glacier after 90, to Glacier Deep Archive after 180), and `expiration` deletes it after M days. For versioned buckets, separate actions target current versus noncurrent versions: `NoncurrentVersionTransition` and `NoncurrentVersionExpiration`, plus `AbortIncompleteMultipartUpload`.

The lifecycle engine runs as a continuous background scanner over the metadata index, evaluating rules and emitting transition/delete jobs to workers. Because the object count is in the trillions, the engine is designed for throughput, not latency: transitions may lag the rule's nominal schedule by hours or days, and S3 only bills for the storage class the object is actually in, not the one the rule "should" have moved it to. A critical pitfall is that lifecycle transitions to archive tiers (Glacier) change the access model: retrieving a Glacier object requires a restore job that takes minutes to hours and incurs a retrieval fee, so a rule that aggressively archives can break applications that assume synchronous GET. Lifecycle rules are also the primary tool for controlling cost in versioned buckets — without `NoncurrentVersionExpiration`, every overwrite permanently doubles storage.

## Storage Tiers

Storage tiers trade cost per gigabyte against retrieval latency and access frequency. Standard is the hot tier: millisecond access, no retrieval fee, highest per-GB price, suitable for frequently-accessed data. Standard-IA (Infrequent Access) is for data accessed monthly or less: same millisecond latency but a per-GB price roughly half of Standard and a retrieval fee per GB, so it only wins if access is rare. One-Zone-IA is IA stored in a single AZ (lower durability, lower price) for reproducible data. Glacier Flexible Retrieval is archival: retrieval takes minutes to twelve hours, price an order of magnitude lower. Glacier Instant Retrieval is the hybrid — millisecond access but archive pricing, for long-tail data accessed once a quarter. Glacier Deep Archive is the cheapest, with retrieval in twelve to forty-eight hours, for compliance archives rarely touched. Intelligent-Tiering is a managed class that auto-moves objects between an access and archive sub-tier based on access patterns, charging a small monitoring fee per object to remove the manual rule-tuning burden.

| Storage Tier | Latency | Retrieval Fee | Price vs Standard | Durability | Best For |
|---|---|---|---|---|---|
| Standard | milliseconds | none | 1.0x (baseline) | 11 nines, multi-AZ | frequently accessed data |
| Standard-IA | milliseconds | per-GB fee | ~0.5x | 11 nines, multi-AZ | accessed monthly or less |
| One-Zone-IA | milliseconds | per-GB fee | < Standard-IA | lower (single AZ) | reproducible / recreatable data |
| Glacier Instant Retrieval | milliseconds | per-GB fee | archive pricing | 11 nines, multi-AZ | long-tail data accessed ~once/quarter |
| Glacier Flexible Retrieval | minutes to 12 hours | per-GB fee | ~0.1x of Standard | 11 nines, multi-AZ | archival, async restore OK |
| Glacier Deep Archive | 12 to 48 hours | per-GB fee | lowest | 11 nines, multi-AZ | compliance archives rarely touched |
| Intelligent-Tiering | milliseconds (hot) / archive (cold) | none (auto-move) | varies + small monitoring fee/object | 11 nines, multi-AZ | unknown / shifting access patterns |

The economics are per-object, so tier choice is dominated by object size and access frequency. For small objects, the monitoring fee of Intelligent-Tiering or the minimum-duration billing of IA classes (30-day minimum charge on transition) can make them more expensive than Standard, because a 1 KB object transitioned to IA incurs the same 30-day IA charge as a 1 TB object but saves only bytes. The general rule: only transition objects larger than ~128 KB, and only to IA if monthly access is below a small threshold. Archive tiers are for data the application can tolerate waiting hours to read; mixing them with synchronous access paths is a classic production outage.

## Erasure Coding vs Replication

The durability math is the heart of the design. Replication stores N identical copies; if each copy has an annual failure probability p and failures are independent, the probability of losing all N copies is roughly p^N. Three copies at p=0.01 gives ~10^-6 annual loss — only six nines, far short of eleven. Erasure coding instead stores the object as k data fragments plus m parity fragments (a (k,m) code), such that any k of the (k+m) fragments suffice to reconstruct the object. With Reed-Solomon (10,6) across 16 disks in distinct failure domains, the system tolerates any 6 simultaneous fragment losses and the probability of losing more than 6 of 16 independent fragments is astronomically small — well beyond eleven nines — while storing only 1.6× the raw data versus 3× for triple replication.

The trade-offs are computational and I/O. Erasure coding requires CPU for encode/decode on every write and every degraded read, and a single object read may need to fetch fragments from multiple nodes (though for non-degraded reads it fetches only the k data fragments, often in parallel). Replication reads a single copy, so it has lower read latency and CPU overhead and simpler failure handling, but pays 3× storage. At exabyte scale the storage savings of erasure coding dominate — 1.6× vs 3× across exabytes is an enormous CapEx difference — so production object stores use erasure coding for the bulk tier and reserve full replication for the hottest small-object cache or for metadata, where latency matters more than raw bytes. A hybrid pattern is common: erasure-code the cold/bulk data, triple-replicate the index and hot working set, and let a tiering layer move objects between the two as access patterns change.

```
        ERASURE CODING vs REPLICATION
        =============================

   REPLICATION (3x)                  ERASURE CODING  Reed-Solomon (10,6)
   3 identical copies                10 data + 6 parity fragments

     [ OBJ ]  [ OBJ ]  [ OBJ ]        [d1][d2][d3][d4][d5][d6][d7][d8][d9][d10][p1][p2][p3][p4][p5][p6]
       |        |        |              \___________________ 16 fragments across 16 disks ___________/
     node1    node2    node3                                  in distinct failure domains

   storage overhead: 3.0x            storage overhead: 1.6x
   tolerate loss:    any 2 of 3      tolerate loss:    any 6 of 16
   annual loss ~ p^3 (~10^-6 at      annual loss: P(>6 of 16 fail)
     p=0.01) -> ~6 nines               -> astronomically beyond 11 nines
   read = 1 copy (fast, low CPU)     read = fetch k=10 data fragments
   write = fan out 3 copies            (parallel; degraded needs parity)
   simpler failure handling          CPU encode/decode on every write
                                      and every degraded read

   At exabyte scale 1.6x vs 3x disk = hundreds of PB and
   hundreds of millions of dollars saved -> erasure coding wins
   for bulk; replication reserved for hot small-object cache +
   metadata where latency matters more than raw bytes.
```

## Garbage Collection

Garbage collection reclaims space from deleted objects, overwritten versions, and aborted multipart uploads, all of which leave orphaned data blocks on disk that are no longer referenced by the metadata index. The system is built on a log-structured storage layer (each disk appends writes sequentially and never overwrites in place), so deletes and overwrites do not physically erase old data — they only update the metadata pointer, leaving the old blocks as garbage. This is deliberate: append-only writes are fast and avoid read-modify-write cycles, and the metadata indirection makes versioning and atomic updates cheap. The cost is that a separate GC process must periodically reclaim the space.

The GC design is a mark-sweep over the storage nodes coordinated with the metadata service. A storage node tracks which blocks it holds and a generation/version for each; the GC compares this local list against the metadata service's authoritative mapping and deletes blocks that no metadata entry references, after a safety delay (typically 24 hours or more) to avoid reclaiming data from writes whose metadata commit is still propagating. This safety delay is why deleted objects may still consume storage briefly and why billing for deleted data can lag. For multipart uploads, an abandoned session's parts are GC'd either by an explicit abort, by a lifecycle `AbortIncompleteMultipartUpload` rule, or by a background scanner that aborts uploads older than a threshold. The hard part of GC at scale is doing it without impacting foreground I/O: it runs at low priority, is throttled by the scheduler, and is designed to be self-steadying — if free space is plentiful it idles, if it drops below a watermark it accelerates. A misconfigured or stalled GC leads to silent capacity growth and is one of the most common causes of "why is our storage bill not going down despite deletes."

## Access Control: IAM, Bucket Policies, ACLs

Access control is layered, with three mechanisms that compose rather than conflict. IAM (Identity and Access Management) policies are attached to users or roles and grant permissions on AWS resources in a unified policy language; they are the primary mechanism for an account's own principals. Bucket policies are resource-based policies attached directly to a bucket and can grant cross-account access, anonymous public access, or conditional access (e.g., only over TLS, only from a VPC endpoint, only with a specific object tag). ACLs are a legacy, per-object or per-bucket grant mechanism (canned grants like `public-read`, `authenticated-read`) with coarse permissions; they are discouraged for new designs and, with S3's recent default Block Public Access, are effectively disabled unless explicitly opted in.

| Mechanism | Attached To | Scope | Primary Use | Cross-Account? | Status |
|---|---|---|---|---|---|
| IAM policy | user / role (principal) | identity-based | an account's own principals | no (own account) | primary, recommended |
| Bucket policy | bucket (resource) | resource-based | cross-account, public, conditional access (TLS/VPC/tag) | yes | primary, recommended |
| ACL | bucket / object | legacy, coarse grants | canned grants (`public-read`, `authenticated-read`) | yes (legacy) | discouraged; disabled by Block Public Access default |

The evaluation model is a single unified authorization decision: for a given request, the service collects the IAM identity policy, the bucket policy, any applicable ACL, and any organization-level service control policies, and evaluates whether the combined effect is an explicit Allow with no explicit Deny. Deny wins, which makes bucket policies a powerful tool for enforcing guardrails (e.g., "deny any PUT that is not SSE-KMS encrypted"). A subtle but critical rule is that the bucket owner account must authorize access even for cross-account bucket-policy grants — the trusting account's IAM role must also have permission to access the object, resulting in a "both sides must allow" intersection for cross-account access. This trips up teams who grant a bucket policy to another account and forget that the other account's role also needs the s3:GetObject permission. Object ownership can differ from bucket ownership when cross-account writes occur; the recommended fix is the bucket-owner-enforced setting, which makes the bucket owner own all objects regardless of writer, eliminating the ACL-based ownership dance entirely.

## Presigned URLs

Presigned URLs are the mechanism for granting time-limited, signature-scoped access to a private object without distributing long-lived credentials. The bucket owner (or a principal with permission) signs a URL with their secret access key over the HTTP method, the bucket, the key, the expiry time, and any overrides (response-content-type, etc.); the resulting URL can be handed to a client (a browser, a mobile app, a third party) who can then perform exactly that operation until the expiry, with no credentials of their own. The signature is an HMAC over the canonical request, so the server re-derives it on receipt and allows the operation if it matches and the timestamp has not expired.

Presigned URLs are the standard pattern for direct-to-S3 browser uploads and downloads: instead of proxying bytes through an application server (which wastes bandwidth and adds latency), the app server signs a PUT URL, the browser uploads directly to S3, and the app is notified via an event or a callback. The design constraints are: the URL embeds the access key ID and signature, so it must be treated as a bearer token (use HTTPS, short expiries, log and rotate); the signature covers the method and key, so a PUT-presigned URL cannot be used to GET; and for multipart uploads, presigning applies per-part (each part URL is signed separately), which the SDKs handle transparently. A common pitfall is presigning a URL with a role's temporary credentials whose session expires before the URL's stated expiry — the URL stops working at the credential's session expiry, not the URL's expiry, a mismatch that produces confusing 403s.

## Capacity Planning for Exabyte Scale

Capacity planning for an exabyte-scale object store is a multi-dimensional problem spanning storage density, request rate, metadata footprint, and bandwidth. At exabyte scale the dominant cost is raw disk, so the storage efficiency of the redundancy scheme is the first-order lever: erasure coding at 1.6× versus triple replication at 3× is a near-2× difference in disk CapEx, which across an exabyte is hundreds of petabytes of disks and hundreds of millions of dollars. The planning exercise sizes the fleet as `usable_bytes × redundancy_factor / disk_capacity × (1 + failure_headroom)`, where failure_headroom accounts for disks under reconstruction and for the need to keep free space above the GC watermark so reclamation can keep up with deletes.

Key capacity numbers and sizing levers:

- Storage fleet sizing: `usable_bytes × redundancy_factor / disk_capacity × (1 + failure_headroom)`
- Redundancy factor: 1.6× (erasure coding) vs 3× (triple replication) — near-2× disk CapEx swing
- Exabyte impact: 1.6× vs 3× across 1 EB = hundreds of PB of disks = hundreds of millions of dollars
- Request plane: `cluster_rps = nodes × per_node_rps`; partitions auto-split to keep any partition below per-node limit
- Per-node bound: CPU (erasure coding) / network (large transfers) / IOPS (small objects)
- Small-object workload (median 64 KB): IOPS-bound — a few PB of small objects can need more nodes than tens of PB of large objects
- Metadata footprint: `objects × metadata_row_size`; ~500 bytes/row
- At 1 trillion objects × ~500 bytes = ~500 TB of index, replicated 3×, in memory across thousands of metadata shards
- Disk failure rate: ~1-3% annual, steady background process at fleet scale
- Million-disk fleet: dozens of failures per day
- Capacity reserve: must sustain peak rebuild rate + peak write rate + replication, with margin

The request plane is sized separately. Each storage node handles a bounded request rate (bounded by CPU for erasure coding, by network for large transfers, by IOPS for small objects). The cluster request capacity is `nodes × per_node_rps`, and partitions auto-split to keep any single partition below its per-node limit. For small-object workloads (median 64 KB), the system is IOPS-bound and the fleet must be sized on request rate, not bytes — a few petabytes of small objects can require more nodes than tens of petabytes of large objects. The metadata footprint is `objects × metadata_row_size`; at a trillion objects with ~500 bytes each, the metadata store must hold ~500 TB of index, replicated three ways, in memory across thousands of metadata shards, and list operations must scan it efficiently. Bandwidth planning must account for the amplification of erasure coding (each write fans out to k+m nodes) and for replication and lifecycle transition traffic competing with foreground requests on shared interconnects.

The operational discipline that makes this work is continuous rebalancing and failure-driven capacity headroom. Disks fail at a roughly constant annual rate (1-3% typical), so at fleet scale failures are a steady background process, not rare events — a million-disk fleet sees dozens of failures per day. The system must reconverge (rebuild failed fragments onto healthy nodes) faster than the failure rate, or the rebuild backlog grows and a correlated failure (a bad batch of disks, a power event) can exceed the erasure code's tolerance. The capacity model therefore reserves enough spare disks and bandwidth to sustain the peak rebuild rate plus the peak write rate plus replication, with margin. Underprovisioning any of these — disk for durability, nodes for IOPS, metadata shards for key count, bandwidth for rebuild — surfaces as either data loss risk or latency collapse, both of which violate the SLAs that justify the system's existence.

## Sharp Interview Question

> **"You run an object store with erasure coding (10,6) across 16 nodes in distinct racks. A buggy lifecycle job deletes 30% of your objects in a single bucket. Walk me through what happens to durability, availability, and cost in the next hour, and what could go wrong."**

### Model Answer

The first thing to establish is that deletes in an object store are metadata operations, not data erasures. The lifecycle job updates the metadata index to remove the deleted objects' mappings and inserts delete markers (if versioned) or simply drops the rows (if not). The actual 16-fragment erasure-coded data blocks remain on disk as garbage until GC reclaims them. This has three immediate consequences.

**Durability is unchanged for the surviving objects.** Erasure coding (10,6) tolerates any 6 of 16 fragment failures independently per object; deleting unrelated objects does not change the fragment distribution of the survivors, so their annual loss probability is unchanged. A common incorrect instinct is that "fewer objects means more redundant capacity," but redundancy is per-object, not per-pool.

**Availability is unchanged for reads, but GC load spikes.** GETs of surviving objects hit the same metadata and data path as before. The deletion itself generated a burst of metadata writes (one per deleted object) and now the GC must scan and reclaim the orphaned blocks. With 30% of a large bucket deleted, the GC backlog is significant and reclamation will run for hours to days at its throttled rate. During this window, free space on affected nodes drops, and if the GC cannot keep up with continued writes plus the backlog, free space can cross the watermark and trigger emergency GC, which competes with foreground I/O and can degrade read latency.

**Cost behavior is the trap.** Billing typically reflects the storage class an object is actually in, so deleted objects stop billing once the metadata row is gone — but the physical disk space is not reclaimed until GC runs, so the cluster's *used* capacity does not drop for hours or days. If the team had been provisioning new nodes based on a capacity metric that measures physical disk usage rather than billable usage, they might over-provision because the freed space has not yet materialized. Conversely, if they expect the delete to immediately relieve a capacity crunch and keep writing, they can hit a free-space wall before GC catches up. The right monitoring is to track both billable bytes (metadata-derived) and reclaimable garbage bytes (GC backlog), separately.

**What could go wrong:** (1) If the bucket was versioning-disabled and the deletes are irreversible, the only recovery is from backups or replication — so CRR or versioning should have been on. (2) If GC is misconfigured or stalled, capacity silently grows and a subsequent correlated failure could exceed free space for reconstruction. (3) If the lifecycle rule also had an aggressive `AbortIncompleteMultipartUpload` and there were in-flight uploads, those abort and the client sees failures. (4) The metadata delete burst can saturate the metadata shard for that bucket's key range, causing latency for concurrent reads of surviving keys in the same partition — the hot-partition problem, triggered by a delete storm rather than a write storm.

### Common Pitfall

> ❌ "Deleting 30% of objects reduces redundancy because there's less data to spread across the cluster."

This conflates pool-level replication (where copies can be co-located and total copy count matters) with per-object erasure coding (where each object's 16 fragments are independently placed and the survivor count of *that object's* fragments is all that matters). Deleting unrelated objects cannot reduce a survivor's fragment count. The real risks after a mass delete are GC backlog, capacity-vs-billing divergence, and metadata-shard load from the delete storm — none of which are durability regressions for the survivors. A candidate who jumps to "durability drops" has not internalized that erasure coding is per-object and that deletes are metadata-only.

## Key Takeaways

1. The defining architectural choice is the separation of a flat, hash-partitioned metadata service (the control plane) from a log-structured, erasure-coded data plane, which lets each scale independently to trillions of objects and exabytes of bytes.
2. Buckets are flat DNS-named namespaces, keys are opaque strings whose slashes are convention not hierarchy, and the flat namespace is what enables unlimited objects per bucket and hash-based partitioning.
3. Strong read-after-write consistency is achieved by serializing version selection through the metadata service's atomic pointer flip, not by synchronizing every data replica — the metadata quorum is the consistency boundary.
4. Hash partitioning with automatic splitting solves the hot-prefix problem, but sequential keys can still cause temporary hotspots; clients should rely on auto-splitting and only add hash prefixes for extreme write bursts.
5. Eleven-nines durability comes from erasure coding (e.g., Reed-Solomon 10,6) across distinct failure domains, delivering astronomically low loss probability at 1.6× storage overhead versus 3× for replication.
6. Same-region replication/durability is synchronous and cross-AZ; cross-region replication is asynchronous with a 15-minute SLA and is eventually consistent at the destination.
7. Versioning makes overwrites and deletes non-destructive but requires lifecycle `NoncurrentVersionExpiration` to bound storage growth, and once enabled it can only be suspended, not truly disabled.
8. Multipart upload breaks large objects into independently-retryable parallel parts and is the only way to reach 5 TB; abandoned parts must be lifecycle-aborted or they leak storage.
9. Storage tiers trade per-GB price for retrieval latency and access frequency; the per-object economics mean small objects should generally stay in Standard, and archive tiers break synchronous access paths.
10. Garbage collection is mark-sweep over a log-structured disk layer, runs throttled in the background, and is the reason physical capacity lags billable capacity after deletes — a stalled GC is a silent cost and capacity risk.
11. Access control composes IAM identity policies, resource-based bucket policies, and legacy ACLs under a deny-wins, both-sides-must-allow-for-cross-account evaluation; bucket-owner-enforced eliminates the ownership trap.
12. Presigned URLs enable credential-free direct-to-S3 uploads but are bearer tokens whose real expiry is the lesser of the URL expiry and the signing credential's session expiry.
13. Exabyte capacity planning sizes four independent dimensions — disk for durability, nodes for IOPS, metadata shards for key count, and bandwidth for rebuild+replication — and underprovisioning any violates the SLA.
14. The first diagnostic when debugging "things are slow after a mass delete" is to check GC backlog and metadata-shard load, not durability — deletes are metadata-only and per-object redundancy is unaffected.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Object storage = flat namespace (bucket/key), no hierarchy, no POSIX semantics
- Metadata service stores key→location mapping; data nodes store the actual bytes
- Replication factor 3 is standard; erasure coding (e.g., 10+4) saves 50% storage with same durability
- Consistency: S3 provides strong read-after-write for new objects, eventual for overwrite/delete
- Versioning enables atomic updates and recovery from accidental deletes

**Common Follow-Up Questions:**
- "How do you handle hot keys (one object accessed millions of times)?" — CDN caching in front of S3. For private content, signed URLs with short TTL.
- "What's the difference between erasure coding and replication?" — Replication: 3x storage, simple, fast reads (any replica). Erasure coding: 1.5x storage, complex, reads need multiple fragments.

**Gotcha:**
- Deletes are metadata operations, not data operations. When you delete an object, the metadata service removes the key mapping immediately, but the actual data blocks are garbage-collected later. This means deletes are fast but storage reclamation is delayed — and a mass delete can cause a GC backlog that affects write performance.
