---
title: "Kubernetes Scheduler & Control Plane Internals"
type: system-design
category: Platform
date: 2026-06-03
difficulty: "Hard"
read_time: 30
listen_time: 36
tags: [system-design, interview, platform, kubernetes, scheduler, control-plane, k8s]
aliases: [k8s scheduler, kube-scheduler, k8s control plane]
---

# Kubernetes Scheduler & Control Plane Internals

## Summary & Interview Framing

The Kubernetes control plane (API server, etcd, scheduler, controller manager) that manages cluster state, with the scheduler placing pods on nodes via filter-and-score pipeline.

**How it's asked:** "Walk me through what happens when you run kubectl apply — from API server to etcd to scheduler to kubelet. How does the scheduler place 1000 pods per minute across 500 nodes?"

## Overview

Kubernetes is a distributed state machine whose central design idea is **declarative reconciliation**: you express the world you want in YAML, and a set of loosely coupled controllers continuously drive observed state toward that desired state. The control plane is the brain that holds this loop together — it stores state in etcd, exposes it through a RESTful watch API, schedules workloads onto machines, and runs dozens of reconciliation loops that react to drift. The scheduler is the most algorithmically interesting of these loops because it is, at its core, an online bin-packing problem with hard constraints, soft preferences, and adversarial inputs (noisy neighbors, faulty nodes, sudden bursts). Understanding the control plane and scheduler internals is a strong staff-level interview signal because it forces you to reason about distributed consensus, event-driven architectures, optimistic concurrency, and resource optimization under uncertainty — the exact blend of skills that distinguishes someone who has operated Kubernetes at scale from someone who has only `kubectl apply`'d manifests.

This document walks the full request path: how a `Pod` object enters the system, what admission and quota checks gate it, how the scheduler filters and scores nodes, how the kubelet turns a bound pod into running containers through the CRI/CNI/CSI interfaces, how the controller manager reacts to failure, and how etcd and a highly available control plane keep the whole thing consistent. We close with capacity planning heuristics and a sharp interview question with a model answer and the most common pitfall.

## The Control Plane — Component Map

The control plane is a small set of cooperating processes that can all run on one node (as in `kubeadm` or managed offerings like EKS/GKE) or be replicated for high availability. The four canonical components are the **API server** (`kube-apiserver`), the **distributed store** (`etcd`), the **scheduler** (`kube-scheduler`), and the **controller manager** (`kube-controller-manager`). In modern installations the cloud-controller-manager is split out so that cloud-specific logic (node lifecycle, routes, services, volumes) runs out-of-process, and in-cluster add-ons such as `kube-proxy`, CoreDNS, and a CNI daemonset live on worker nodes rather than the control plane. The critical architectural property is that the API server is the **only** component that talks to etcd directly; every other component is a client of the API server over a watch-based protocol, which means etcd stays small, simple, and hot, while business logic is pushed to the edges where it can scale horizontally.

### Control Plane Component Architecture

```
        ┌───────────────────────────────────────────────────────┐
        │                    Control Plane                       │
        │                                                        │
        │   ┌─────────┐    ┌──────────────┐    ┌─────────────┐   │
        │   │  etcd   │◄──►│  API Server  │───►│ AuthN/AuthZ │   │
        │   │ (Raft)  │    │ REST + Watch │    │  + Webhooks │   │
        │   └─────────┘    └──────┬───────┘    └─────────────┘   │
        │                       │  ▲                             │
        │           ┌───────────┘  │                             │
        │           ▼              │                             │
        │  ┌────────────┐   ┌──────┴────────┐   ┌────────────┐  │
        │  │ Scheduler  │   │  Controller   │   │   kube-    │  │
        │  │ (bind pod) │   │   Manager     │   │  proxy     │  │
        │  └────────────┘   │  (reconcile)  │   └────────────┘  │
        │                   └───────────────┘                    │
        └──────────────────────┬────────────────────────────────┘
                               │ watch + reconcile
                               ▼
                    ┌───────────────────────┐
                    │   Kubelet (per node)  │──► CRI ──► container runtime
                    │                       │──► CNI ──► pod networking
                    │                       │──► CSI ──► volume mounts
                    └───────────────────────┘
```

| Component        | Role                                                  | Failure Mode                                                        |
|------------------|-------------------------------------------------------|---------------------------------------------------------------------|
| API Server       | Front door; validates, persists, serves watches       | Cluster becomes read/write-dead; caches stale but serve reads       |
| etcd             | Strongly-consistent KV store; the source of truth     | Single-node outage tolerated; quorum loss = write unavailability    |
| Scheduler        | Assigns unscheduled Pods to Nodes via Bind            | New pods stay Pending; running workloads unaffected                 |
| Controller Mgr   | Reconciles replicas, nodes, endpoints, etc.           | Drift goes unrepaired (no autoscale, no rescheduling of evicted)    |
| Kubelet          | Per-node agent; drives pod lifecycle via CRI/CNI/CSI  | Node goes NotReady; pods evicted after grace period                 |
| kube-proxy       | Programs iptables/IPVS for Service VIP routing        | New endpoints not programmed; existing flows continue               |

## etcd as the Source of Truth

Everything in Kubernetes — Pods, Services, Deployments, Secrets, ConfigMaps, nodes, leases — is a serialized object stored in etcd under a versioned key like `/registry/pods/default/my-app`. etcd is a distributed key-value store built on the **Raft consensus algorithm**, which gives linearizable reads and writes as long as a majority of members (the quorum) is reachable. For a 3-member cluster the quorum is 2, so one node can fail without losing write availability; for 5 members the quorum is 3, tolerating two failures. This is why control-plane HA topologies almost always use 3 or 5 etcd members — an even number buys you nothing and makes split-brain more likely. Every write goes through the Raft leader, is replicated to a quorum, and only then is committed; reads can be served locally but are serialized through the leader (or via a read-index) to guarantee linearizability, which is why a saturated etcd leader becomes the cluster's throughput bottleneck.

The API server is etcd's only client, and it presents a clean abstraction over the raw store: it converts between the structured typed objects of the Kubernetes API and the protobuf/JSON blobs etcd holds, it enforces resource versioning for optimistic concurrency, and it serves a **watch** mechanism that lets controllers subscribe to a stream of changes rather than poll. The resource version is an etcd revision (a globally monotonic integer); when two clients race to update the same object, the second write fails with a `409 Conflict` and must re-read, rebase, and retry — this is the optimistic concurrency control that lets hundreds of controllers edit overlapping objects safely. Because etcd holds the entire world in memory and on disk, operational discipline matters: defragmentation after compaction, periodic backups (the `etcdctl snapshot save` path), keeping the database under ~2-4 GB, and avoiding large value blobs (base64-encoded images in ConfigMaps are a classic anti-pattern) all protect the cluster's most precious component.

## The API Server — Front Door and Watch Hub

The API server is the single entry point for every external actor: `kubectl`, controllers, the scheduler, the kubelet, dashboards, CI systems, and admission webhooks all speak to it over mTLS-gated HTTPS. A request flows through a layered pipeline: TLS termination and client certificate validation, **authentication** (one or more authenticator — client certs, bearer tokens, OIDC, service-account tokens), **authorization** (RBAC or ABAC checks against the authenticated user and groups), **admission control** (mutating and validating webhooks plus built-in plugins), and finally persistence to etcd with a freshly minted resource version. The response is then returned, and any component watching the relevant resource receives an event on its watch stream. This layered design is what lets Kubernetes be extensible without forking the core: you add an admission webhook to enforce policy, a CRD-plus-controller to add new resources, or an aggregated API server for custom verbs, and the API server remains the choke point that authenticates and authorizes them all.

### API Request Pipeline

```
   External client (kubectl / controller / kubelet / webhook)
              │
              ▼
   ┌──────────────────┐
   │ TLS termination  │  mutual TLS, client cert validation
   └────────┬─────────┘
            ▼
   ┌──────────────────┐
   │ Authentication   │  client cert / bearer token / OIDC / SA token
   └────────┬─────────┘
            ▼
   ┌──────────────────┐
   │ Authorization    │  RBAC / ABAC (user + groups vs verbs on resources)
   └────────┬─────────┘
            ▼
   ┌──────────────────┐
   │ Mutating         │  inject sidecars, set defaults, add labels
   │ admission        │  (may rewrite the object — runs FIRST)
   └────────┬─────────┘
            ▼
   ┌──────────────────┐
   │ Validating       │  accept or reject only (runs on mutated object)
   │ admission        │  built-in plugins + dynamic ValidatingWebhooks
   └────────┬─────────┘
            ▼
   ┌──────────────────┐
   │ Persist to etcd  │  minted resource version; optimistic concurrency
   └────────┬─────────┘
            ▼
   Response returned + watch events fanned out to subscribers
```

The watch protocol deserves special attention because it is the connective tissue of the entire system. A watch is a long-lived chunked HTTP/2 stream that delivers a sequence of `ADDED`, `MODIFIED`, and `DELETED` events for objects matching a selector, starting from a given resource version. If the client falls behind and the server's event history has been compacted, the watch returns a `410 Gone` and the client must relist from the current state and re-establish the watch — this is the classic "watch bookmark" pattern that prevents controllers from missing events during reconnects. The API server maintains an in-memory watch cache per resource per namespace (the "cacher") that serves most watches without touching etcd, which is why etcd can stay small even when thousands of controllers are watching millions of objects; the trade-off is that the cacher must be carefully synchronized with etcd's revision number to avoid serving stale data, and bugs here manifest as phantom resyncs or missed reconciliations.

## Admission Controllers and Policy

Admission controllers run **after** authorization but **before** persistence, giving the cluster a final veto or mutation on every create/update/delete. They come in two phases:

- **Mutating admission** (runs first) — can rewrite the object: inject a sidecar, set defaults, add a namespace label.
- **Validating admission** (runs second) — can only accept or reject, runs on the now-mutated object.

The order matters because a mutating webhook that injects an Istio sidecar must run before the validating webhook that requires all pods to have that sidecar. Built-in admission plugins handle concerns like `NamespaceLifecycle` (reject creates in a namespace being deleted), `ServiceAccount` (auto-mount a service account token), `NodeRestriction` (limit what a kubelet can self-report about its node), `LimitRanger` (enforce default and min/max resource limits per namespace), and `ResourceQuota` (enforce aggregate consumption ceilings). Modern clusters almost always add **dynamic admission webhooks** — out-of-process services registered via `MutatingWebhookConfiguration` and `ValidatingWebhookConfiguration` objects — to implement organization-specific policy: OPA/Gatekeeper for declarative Rego policies, Kyverno for Kubernetes-native YAML policies, or custom services for image provenance checks, label enforcement, and network policy defaults.

Two operational hazards deserve emphasis:

- **Webhooks are on the synchronous critical path of every API write.** A slow or unavailable webhook can stall the entire cluster. Mitigation: configure `failurePolicy: Fail` for security-critical checks but `failurePolicy: Ignore` with careful monitoring for non-critical ones, and tune `timeoutSeconds` aggressively (1-3 seconds).
- **Mutating webhooks without `reinvocationPolicy: IfNeeded` can be invoked multiple times** during a single create when multiple mutating webhooks are chained — the cause of many "why did my sidecar get injected twice" mysteries.

Understanding this pipeline is essential for designing CRDs and operators that play nicely with the rest of the ecosystem.

## Resource Quotas and LimitRanges

Resource quotas are an admission-time enforcement mechanism that bounds aggregate resource consumption within a namespace, preventing a single team or tenant from starving the cluster. A `ResourceQuota` object can cap the total number of objects of a given kind (Pods, Services, ConfigMaps), the total requests and limits of `cpu`, `memory`, and `ephemeral-storage` across all pods, and the total size of PersistentVolumeClaims by storage class. The `ResourceQuota` admission plugin runs on every create and update, atomically incrementing a per-namespace usage counter stored in the quota object itself; because this is done within the same API transaction the accounting is consistent, but it also means quota checks are a serialization point and can become a bottleneck in namespaces with extremely high pod churn (think a CI namespace running thousands of jobs per hour). A `LimitRange` complements quotas by setting default request/limit values and per-container min/max bounds, so that a pod without explicit resources still gets a defensible allocation and cannot silently request zero CPU and starve its neighbors.

The interplay between requests, limits, and quotas is a frequent source of confusion. **Requests** are what the scheduler uses for bin-packing and what the kubelet reserves via cgroups; they are the "guaranteed" floor. **Limits** are the ceiling enforced by the cgroup CPU throttling and OOM killer — a container may burst above its request up to its limit if spare capacity exists, but it cannot exceed the limit. Quotas count both requests and limits, so a namespace whose quota is 10 CPU of requests can be filled by ten pods requesting 1 CPU each, regardless of how high their limits are set.

### Resource Requests vs Limits

| Aspect | Requests | Limits |
|---|---|---|
| Used by scheduler for bin-packing | Yes | No |
| Kubelet cgroup behavior | Reserved floor (guaranteed) | Ceiling (CPU throttle + OOM kill) |
| Bursting allowed | — | Up to limit if spare capacity exists |
| Enforced by | cgroup reservation | cgroup CPU throttling + OOM killer |
| Counted by `ResourceQuota` | Yes | Yes |
| QoS class implication | requests==limits → Guaranteed; requests<limits → Burstable; none set → BestEffort | — |
| Classic pitfall | Set too low → neighbor starvation | Set very high "just in case" → exhausts quota on limits alone, can't schedule new pods |

The classic failure mode is a team setting limits very high "just in case," exhausting the quota on limits alone, and then being unable to schedule new pods even though actual usage is low — the fix is to set limits conservatively or to rely on HorizontalPodAutoscalers that scale request-bearing replicas rather than inflating single-container limits.

## The Scheduler — Placement as an Online Optimization Problem

The scheduler is a controller that watches for Pods with an empty `nodeName` (i.e., unscheduled) and assigns each one to a Node by writing a `Binding` object (or, equivalently, patching the pod's `nodeName`). Conceptually it solves an online bin-packing problem: pods arrive over time, nodes have finite multidimensional capacity (CPU, memory, GPU, ephemeral storage, extended resources), and the assignment must respect hard constraints while optimizing for soft objectives like availability, affinity, and fragmentation. The scheduler runs the same two-phase pipeline for every pod: **filtering** (also called the "predicate" phase in the older vocabulary) prunes the node set to those that can legally host the pod, and **scoring** (the "priority" phase) ranks the survivors so the best-scoring node wins. In modern Kubernetes (1.x with the scheduling framework) these phases are decomposed into a pipeline of plugin extension points, allowing operators to inject custom logic at every stage without forking the binary.

The **scheduling framework** (introduced in 1.19 and stable since 1.27) is the plugin architecture that replaced the hard-coded predicate/priority lists. A pod's journey through the scheduler touches, in order:

- `QueueSort` — orders the pending queue, default by priority and creation timestamp.
- `PreFilter` and `Filter` — the equivalent of predicates: `NodeResourcesFit`, `PodTopologySpread`, `NodeAffinity`, `TaintToleration`, `VolumeBinding`, `NodePorts`, `PodAntiAffinity`.
- `PostFilter` — runs only if no node passed filtering; this is where preemption lives.
- `PreScore` and `Score` — the priorities: `NodeResourcesFit`'s `LeastAllocated`/`MostAllocated` variants, `PodTopologySpread`, `InterPodAffinity`, `NodeAffinity`, `ImageLocality`, `RequestedToCapacityRatio`.
- `NormalizeScore` — rescales each scorer's output to a 0-100 range.
- `Reserve` and `Permit` — reserve resources and optionally delay binding for gang or cosine scheduling.
- `PreBind` and `Bind` — attach volumes and write the binding.
- `PostBind` — cleanup and metrics.

Each plugin implements a Go interface and is registered at startup via a profile; multiple profiles can coexist, which is how a cluster can run the default scheduler and a custom scheduler simultaneously selecting from the same node pool.

### Pod Scheduling Pipeline (Filter → Score → Bind)

```
   Pending Pod (nodeName="")
        │
        ▼
   ┌────────────────────┐
   │ QueueSort          │  order pending queue by priority + creation ts
   └─────────┬──────────┘
             ▼
   ┌────────────────────┐
   │ PreFilter          │  compute pod's total resource needs; precompute
   └─────────┬──────────┘
             ▼
   ╔════════════════════╗   NodeResourcesFit, NodeAffinity,
   ║ FILTER (predicates)║   TaintToleration, PodAntiAffinity,
   ║ — hard constraints ║   VolumeBinding, NodePorts,
   ╚════════╤═══════════╝   NodeUnschedulable...
            │ survivors (nodes that pass ALL filters)
            ▼
   ┌────────────────────┐
   │ PostFilter         │  runs ONLY if 0 nodes survived → preemption
   └─────────┬──────────┘
             ▼
   ╔════════════════════╗   LeastAllocated / MostAllocated,
   ║ SCORE (priorities) ║   PodTopologySpread, InterPodAffinity,
   ║ — soft preferences  ║   ImageLocality, NodeAffinity, TaintToleration
   ╚════════╤═══════════╝   (each returns 0-100 per node)
            ▼
   ┌────────────────────┐
   │ NormalizeScore     │  rescale to 0-100; weighted sum across plugins
   └─────────┬──────────┘   highest total wins (ties broken deterministically)
             ▼
   ┌────────────────────┐
   │ Reserve + Permit   │  reserve resources on chosen node;
   │                    │  Permit can hold for gang/cosine scheduling
   └─────────┬──────────┘
             ▼
   ┌────────────────────┐
   │ PreBind + Bind     │  attach volumes (CSI); write Binding / patch nodeName
   └─────────┬──────────┘
             ▼
   ┌────────────────────┐
   │ PostBind           │  cleanup + metrics
   └─────────┬──────────┘
             ▼
   Pod is Bound → kubelet picks it up via watch and starts containers
```

### Filtering — Hard Constraints

Filtering eliminates nodes that cannot legally host the pod. The checks are conjunctive — a node must pass all of them — and they encode the non-negotiable requirements:

- `NodeResourcesFit` — verifies the node has at least the pod's total CPU/memory/device requests available (after accounting for already-scheduled pods).
- `NodeAffinity` — honors `requiredDuringSchedulingIgnoredDuringExecution` rules that pin pods to nodes with specific labels.
- `TaintToleration` — removes nodes whose taints the pod does not tolerate (a `NoSchedule` taint on a GPU node keeps non-GPU pods off).
- `PodAntiAffinity` (required rules) — prevents co-locating pods that must be separated.
- `VolumeBinding` — checks that any `WaitForFirstConsumer` PVC can be satisfied by a volume accessible from the node (defers topology-aware volume provisioning until a node is chosen, avoiding the "volume pinned to wrong zone" trap).
- `NodePorts` — checks HostPort availability.
- `NodeUnschedulable` — skips cordoned nodes.

The filter phase is cheap relative to scoring because it can short-circuit on the first failure and because most nodes fail for the obvious resource reason, but in clusters with thousands of nodes and complex affinity rules even filtering becomes a meaningful fraction of scheduling latency, which is why the scheduler maintains in-memory node snapshots and indexes affinities rather than re-evaluating every node from scratch.

### Scoring — Soft Preferences

Scoring ranks the surviving nodes by how well they satisfy soft objectives. Each `Score` plugin returns a 0-100 integer per node, the scores are weighted (the default profile defines weights like `NodeResourcesFit` weight 1, `PodTopologySpread` weight 2, `InterPodAffinity` weight 2) and summed, and the highest-scoring node wins, with ties broken deterministically. The most important scorers are:

- `NodeResourcesFit` (`LeastAllocated` mode) — favor nodes with the most remaining capacity, which spreads load and leaves headroom. The default and usually the right choice for general-purpose clusters.
- `NodeResourcesFit` (`MostAllocated` mode) — favor the fullest nodes, which packs tightly and is better for cost-optimized clusters where you want to empty nodes so they can be scaled down.
- `RequestedToCapacityRatio` — a continuous shape function that lets you tune between spread and pack.
- `PodTopologySpread` — maximize even spread across topology domains like zones or racks for fault tolerance.
- `InterPodAffinity` / `PodAntiAffinity` — prefer or avoid co-location with pods matching a label selector (pin a cache pod next to its workers, or spread replicas).
- `NodeAffinity` (preferred mode) — soft preference for nodes matching labels.
- `TaintToleration` — lower score for nodes the pod only weakly tolerates.
- `ImageLocality` — prefer nodes that already have the pod's images pulled, reducing cold-start latency.
- `NodeLabel` / `ServiceAffinity` — legacy scorers for topology-aware service traffic.

The art of scheduler tuning is choosing the right weights for your objectives: a latency-sensitive service wants high `PodTopologySpread` weight, a batch ML workload wants high `MostAllocated` weight to bin-pack GPUs tightly, and a cost-conscious platform team may switch the whole profile to favor packing so the cluster autoscaler can remove empty nodes.

## Scheduling Algorithms and Strategies

The choice of scoring strategy encodes a deeper choice about what the cluster is optimizing for. **Bin-packing** (the `MostAllocated` scorer and `RequestedToCapacityRatio` with a convex shape) treats nodes as bins to be filled to capacity before opening new ones; this minimizes the number of active nodes, which is ideal for cost-driven clusters because it lets the cluster autoscaler scale down idle nodes and reduces the number of nodes you pay for at any moment. The risk is fragmentation and reduced failure isolation: a tightly packed node has no headroom for rescheduling when a neighbor fails, and bin-packing tends to create a few near-full nodes and a few near-empty nodes rather than a smooth distribution. **Spreading** (the `LeastAllocated` scorer and `PodTopologySpread`) does the opposite, favoring the least-loaded nodes so that load is evenly distributed; this maximizes headroom and resilience (a node failure affects fewer pods, and surviving pods have somewhere to go) at the cost of running more nodes with lower average utilization. Most production clusters use a hybrid: `LeastAllocated` as the base for general workloads to keep the cluster resilient, combined with `PodTopologySpread` across zones for anything with multiple replicas, and then a separate scheduler profile or node pool with `MostAllocated` for batch jobs that should pack.

### Scheduling Algorithm Comparison

| Strategy | Scorer(s) | Objective | Pros | Cons | Best For |
|---|---|---|---|---|---|
| Bin-packing | `MostAllocated`, `RequestedToCapacityRatio` (convex) | Fill nodes to capacity before opening new ones | Minimizes active nodes; cost-efficient; enables autoscaler scale-down | Fragmentation; reduced failure isolation; no headroom for rescheduling | Cost-driven clusters; batch/ML workloads |
| Spreading | `LeastAllocated`, `PodTopologySpread` | Distribute load evenly across nodes/domains | Maximizes headroom & resilience; node failure affects fewer pods | More nodes with lower average utilization | General-purpose services; latency-sensitive workloads |
| Hybrid | `LeastAllocated` base + `PodTopologySpread` + `MostAllocated` for batch | Balance resilience and cost | Resilience for services, density for batch | Requires multiple profiles or node pools | Most production clusters |

**Affinity and anti-affinity** let you express topology preferences declaratively. `podAffinity` attracts a pod to nodes running pods matching a selector (place this cache next to those workers to reduce cross-node traffic); `podAntiAffinity` repels them (spread these replicas across different nodes or zones so a single failure doesn't take them all down). The `required` variants are hard filters, the `preferred` variants are scorers with a weight. The newer **PodTopologySpread** plugin is a more ergonomic and scalable replacement for anti-affinity across topology domains: you specify `maxSkew` (the maximum allowed difference in pod count between any two domains), a `topologyKey` (e.g., `topology.kubernetes.io/zone`), and `whenUnsatisfiable` (`DoNotSchedule` for hard or `ScheduleAnyway` for soft), and the scheduler ensures even spread without the O(pods × pods) cost of pairwise anti-affinity, which becomes prohibitive for large replica sets. A common pattern for a stateless service with five replicas across three zones is `PodTopologySpread` with `maxSkew: 1` and `whenUnsatisfiable: DoNotSchedule`, which guarantees no zone has more than one replica more than any other — a cheap, powerful availability primitive.

**Taints and tolerations** are the inverse mechanism: a taint on a node repels pods unless they carry a matching toleration. This is how dedicated node pools work (taint all GPU nodes with `nvidia.com/gpu=true:NoSchedule` and only GPU pods that tolerate it get scheduled there), how special hardware is protected, and how the cluster handles node problems — the node controller applies `node.kubernetes.io/not-ready` and `node.kubernetes.io/unreachable` taints with configurable `TolerationSeconds` so that pods are evicted from a failed node only after a grace period rather than immediately, giving the node time to recover. **Node affinity and the `nodeSelector`** are the attraction-side equivalent: constrain a pod to nodes matching labels, used for topology pinning, OS/arch selection (`kubernetes.io/os: linux`), and instance-type specialization.

## Custom Schedulers and Scheduling Profiles

For cases the default plugins can't express — gang scheduling (all-or-nothing placement for distributed training jobs), topology-aware volume scheduling, cosine scheduling for Spark, or capacity-aware scheduling that consults an external capacity service — Kubernetes offers several extension paths:

- **Scheduling framework with a compiled-in plugin** (lightest) — write a Go plugin implementing one or more extension points, register it in a custom scheduler profile, and run a `kube-scheduler` binary that uses that profile. Full access to the scheduler's node snapshot and is fast, but requires maintaining a fork or a custom container image.
- **Custom scheduler entirely** — a separate controller that watches unscheduled pods and binds them itself, identified by setting `spec.schedulerName` on the pod so the default scheduler ignores it. This is how projects like Volcano (gang scheduling for batch), Kube-scheduler-simulator (research), and various in-house capacity schedulers work; the trade-off is that you lose the battle-tested default plugins and must reimplement filtering, scoring, and preemption yourself unless you carefully reuse the framework library.
- **Multiple scheduling profiles in a single scheduler binary** (since 1.18) — the scheduler can run several profiles, each with its own plugin set, and pods select a profile via `schedulerName`. This lets one scheduler instance serve both a "default" profile (spread, for services) and a "batch" profile (pack, for Spark) without running two processes or duplicating the queue and cache.
- **Scheduler extender** (HTTP webhook, deprecated) — still exists for truly external scheduling (e.g., a meta-scheduler that consults a capacity API before delegating to the in-tree scheduler), but is deprecated in favor of the framework's `Filter`/`Score`/`Bind` extension points and the `PreBind`/`Permit` plugins that can gate binding on external approval.

The `Permit` plugin in particular enables gang scheduling: it can hold a pod in the "permitted" state until all members of the gang are approved, then release them all to bind atomically, with a timeout that releases the reservations to avoid indefinite holds.

## Preemption, Priorities, and Eviction

When a high-priority pod cannot be scheduled because lower-priority pods are occupying all viable nodes, the scheduler's `PostFilter` phase runs **preemption**: it identifies victims — one or more lower-priority pods whose removal would free enough resources — and initiates their graceful deletion, then schedules the preemptor once the victims have terminated and their resources are reclaimed. Priority is a 32-bit integer (the `PriorityClass` resource defines named classes like `system-cluster-critical` at 2 billion and `system-node-critical` at 2 billion plus); the preemptor must have strictly higher priority than its victims, and the scheduler prefers to preempt fewer victims, victims that don't disrupt a PodDisruptionBudget, and victims whose deletion is cheapest. Preemption interacts delicately with the kubelet's graceful eviction and with PDBs: a pod protected by a PDB with `minAvailable` will not be preempted if doing so would violate the budget, forcing the scheduler to look elsewhere or fail the preemptor outright. This is a deliberate tension between individual pod rights and aggregate availability, and getting it right is a common interview deep-dive.

The node-side counterpart is **eviction** and **node-pressure** handling. The kubelet watches for resource pressure (memory, disk, PID) and proactively evicts pods to keep the node healthy, choosing victims by priority (lowest first) and then by usage relative to requests (the pod exceeding its requests the most goes first, since it is the least "guaranteed"). The distinction between **preemption** (scheduler-initiated, to make room for a higher-priority pod) and **eviction** (kubelet-initiated, to protect node stability) is a useful mental model, as is the distinction between a **graceful deletion** (the API server deletes the pod, the kubelet finishes finalizers and stops containers) and a **forced** eviction (the kubelet kills the pod and reports it as `Failed` with reason `Evicted`). The pod's `terminationGracePeriodSeconds` bounds how long the kubelet waits for the container's SIGTERM handler before sending SIGKILL.

## The Kubelet and Pod Lifecycle

The kubelet is the per-node agent that translates a bound Pod object into running containers and keeps them that way. Its main loop syncs each pod on the node: it queries the API server (or its local cache) for the pod spec, ensures the pod's volumes are attached and mounted (via CSI), ensures the pod's network namespace and IP are configured (via CNI), and then calls the **CRI** (Container Runtime Interface) to create and start the containers in the right order, respecting `initContainers` that must complete before the next starts. It then runs a small reconciliation loop per container using **liveness**, **readiness**, and **startup** probes:

- **Liveness probe** — a failing liveness probe triggers a container restart.
- **Readiness probe** — a failing readiness probe removes the pod's IP from Service endpoints (so it stops receiving traffic) without restarting it.
- **Startup probe** — gates liveness checks until the application has booted, essential for slow-starting JVM or legacy apps that would otherwise be killed by an impatient liveness probe.

The kubelet reports node status (capacity, allocatable, conditions, addresses) and pod status back to the API server on a heartbeat, using a node lease (`coordination.k8s.io/v1 Lease`) in modern versions to reduce the update load on etcd — the full node status is posted every 40-50 seconds, while the lease is renewed every 10 seconds and is the lightweight signal the node controller uses to detect liveness.

### Kubelet Pod Lifecycle (SyncPod)

```
   Bound Pod arrives via watch (nodeName set)
        │
        ▼
   ┌──────────────────────┐
   │ SyncPod (main loop)  │  query API server / local cache for pod spec
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐
   │ Volume setup (CSI)   │  attach + mount PersistentVolumes
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐
   │ Network setup (CNI)  │  pod sandbox: netns, veth pair, pod IP, routes
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐
   │ CRI: RunPodSandbox   │  create sandbox (shared netns + cgroup hierarchy)
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐
   │ initContainers       │  run sequentially; each must exit 0
   │ (sequential)         │  before the next starts
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐
   │ Containers (CRI)     │  CreateContainer → StartContainer
   │ (concurrent)         │  share pod sandbox (localhost networking)
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐
   │ Probe reconciliation │  liveness   → restart container on failure
   │ (per container loop) │  readiness  → add/remove IP from Service endpoints
   │                      │  startup    → gate liveness until app booted
   └──────────┬───────────┘
              ▼
   Pod status + node status reported to API server
   (node lease renewed every 10s; full status every 40-50s)
```

### Pod Lifecycle State Machine

The pod lifecycle is a state machine: `Pending` (accepted by the API server, not yet scheduled or volumes not ready), `Running` (at least one container running), `Succeeded` (all containers exited 0 and won't restart), `Failed` (a container exited non-zero and the restart policy is `Never`, or the pod was evicted). Containers within a pod go through `Waiting` → `Running` → `Terminated` states, each with a reason and exit code surfaced in `containerStatuses`. The restart policy (`Always`, `OnFailure`, `Never`) controls the kubelet's retry behavior with an exponential backoff capped at 5 minutes, and the `backOff` is reset once the container runs successfully for 10 minutes. Understanding this state machine matters because many "my pod is stuck" incidents are actually a container in `CrashLoopBackOff` (a `Waiting` state with reason `CrashLoopBackOff`), which is the kubelet faithfully applying the backoff to a container that keeps dying — the fix is almost always in the application or its config, not in Kubernetes.

```
   Pod states:          Container states:

   ┌─────────┐          ┌─────────┐
   │ Pending │          │ Waiting │  (reason: PullingImage, CrashLoopBackOff...)
   └────┬────┘          └────┬────┘
        │ scheduled          │ started
        ▼                    ▼
   ┌─────────┐          ┌─────────┐
   │ Running │          │ Running │  (restartPolicy: Always/OnFailure/Never)
   └────┬────┘          └────┬────┘
        │ exit 0             │ exited
        ▼                    ▼
   ┌──────────┐        ┌─────────────┐
   │Succeeded │        │ Terminated  │  (exit code + reason surfaced)
   └──────────┘        └─────────────┘
        │ exit≠0 + Never / evicted
        ▼
   ┌────────┐
   │ Failed │  (or Evicted by kubelet)
   └────────┘
```

## CRI, CNI, and CSI — The Pluggable Node Interfaces

The kubelet does not run containers, configure networking, or attach storage itself; it speaks three gRPC/HTTP interfaces to pluggable components, which is what allows Kubernetes to be runtime-, network-, and storage-agnostic. The **Container Runtime Interface (CRI)** is a gRPC API between the kubelet and the container runtime (containerd, CRI-O, historically dockershim); the kubelet calls `RunPodSandbox`, `CreateContainer`, `StartContainer`, `StopContainer`, and `RemovePodSandbox`, and the runtime handles image pulls, cgroup creation, and the actual process execution. The sandbox is the pod-level isolation unit (a network namespace and cgroup hierarchy shared by all containers in the pod), which is why containers in a pod share `localhost` networking and can share volumes via `emptyDir`. The **Container Network Interface (CNI)** is a simpler plugin protocol invoked by the kubelet (or a CNI daemonset) at pod creation: the kubelet calls a CNI plugin binary with `ADD`/`DEL`/`CHECK` commands and a JSON network configuration, and the plugin assigns the pod an IP, configures a veth pair, and programs any required routes or network policy rules. Calico, Cilium, Flannel, and AWS VPC CNI are common implementations, each with different encapsulation (VXLAN, IPIP, native routing, eBPF) and feature sets; the choice of CNI determines pod IP reachability, network policy enforcement, and performance characteristics, and is one of the most consequential cluster-level decisions.

The **Container Storage Interface (CSI)** is the storage equivalent, exposing volume lifecycle operations — `CreateVolume`, `DeleteVolume`, `ControllerPublishVolume` (attach to a node), `NodePublishVolume` (mount into the pod), `NodeUnpublishVolume`, `ControllerUnpublishVolume` — through sidecar controllers that translate CSI calls into Kubernetes API actions. A CSI driver for, say, EBS, GCE PD, or Portworx runs a controller plugin (handling cloud API calls and volume attach/detach) and a node plugin (running on every node, handling mount/unmount via the kubelet's CSI client). The crucial scheduling interaction is the **`WaitForFirstConsumer` volume binding mode**: with this mode (the default for most CSI storage classes), the scheduler defers PVC binding until a pod is scheduled, so the volume is created in the same zone as the chosen node — without this, an eager binding could provision a volume in zone A and then fail to schedule the pod because its node ended up in zone B, a classic cross-zone volume trap. The scheduler's `VolumeBinding` filter and `VolumeRestriction` plugin encode this logic, and getting it right is essential for multi-zone clusters.

## The Controller Manager and Reconciliation Loops

The controller manager hosts the dozens of built-in controllers that implement Kubernetes' declarative semantics:

- **ReplicaSet / Deployment** controller — ensures the desired number of pod replicas are running, creating or deleting pods as needed.
- **Node** controller — monitors node heartbeats and taints or evicts pods from unresponsive nodes.
- **EndpointSlice** controller — populates endpoint objects from pod readiness so `kube-proxy` can program Service routing.
- **ServiceAccount / Token** controllers — provision credentials.
- **PersistentVolume / PersistentVolumeClaim** controllers — bind and reclaim storage.
- **Garbage Collection** controller — deletes dependents when an owner is removed (cascading deletion via ownerReferences).
- **Namespace / ResourceQuota** controllers — manage lifecycle and accounting.

Each controller is the same shape: watch a resource (and its dependents), compare desired to observed, and issue corrective API calls (create, update, delete) until they converge — the "level-triggered" rather than "edge-triggered" design that makes Kubernetes robust to missed events because the next sync re-derives the correct state.

This reconciliation pattern is also the basis for **custom controllers and operators**: a CRD defines a new resource, and a controller (often built with `controller-runtime` or Kubebuilder) watches it and drives some external system toward the desired state — a database operator creates clusters, performs backups, and orchestrates upgrades; a certificate operator issues and rotates certs. The key correctness properties are **idempotency** (issuing the same corrective action twice must be safe), **reconciliation on drift** (the controller should not assume its last action succeeded; it must re-read state each loop), and **graceful handling of transient API errors** (use exponential backoff and re-queue rather than crashing). Because controllers watch the API server and act on changes, a poorly written controller that issues too many updates per sync can saturate the API server — the cardinal sin is a controller that fights itself or another controller, creating a flapping update storm that drives up etcd write QPS and can destabilize the whole cluster. The `--kubeconfig` and leader-election lease patterns ensure only one instance of each controller is active in an HA deployment.

## High Availability Control Plane

A highly available control plane means no single component failure takes the cluster down. The standard topology for self-managed clusters is **stacked etcd**: three (or five) control-plane nodes, each running the API server, scheduler, controller manager, and an etcd member co-located. The API server is **stateless** (its state is etcd and an in-memory cache), so you simply put a load balancer in front of multiple API servers and clients fail over automatically; the scheduler and controller manager are **active-passive** — all replicas run, but each uses a leader-election lease (`coordination.k8s.io/v1 Lease`) so only one is actively making decisions, and the others wait to take over if the leader stops renewing the lease (default 15-second renewal, 10-second lease). This avoids the "two schedulers bind the same pod to different nodes" split-brain that would occur if both were active without coordination. The alternative topology is **external etcd**, where the etcd cluster runs on separate dedicated hosts; this isolates etcd's resource needs (it is the most sensitive component) from the API servers and is preferred for very large clusters or when etcd is shared across multiple Kubernetes clusters.

### HA Control Plane Topology (Stacked etcd, 3 nodes)

```
                       ┌──────────────────────────┐
                       │     Load Balancer         │
                       │   (API entry point)       │
                       └────────────┬─────────────┘
            ┌───────────────────────┼───────────────────────┐
            │                       │                       │
            ▼                       ▼                       ▼
   ┌────────────────┐      ┌────────────────┐      ┌────────────────┐
   │  CP Node 1     │      │  CP Node 2     │      │  CP Node 3     │
   │                │      │                │      │                │
   │ kube-apiserver │      │ kube-apiserver │      │ kube-apiserver │
   │  (stateless)   │      │  (stateless)   │      │  (stateless)   │
   │                │      │                │      │                │
   │ kube-scheduler │      │ kube-scheduler │      │ kube-scheduler │
   │  (LEADER)      │      │  (standby)     │      │  (standby)     │
   │                │      │                │      │                │
   │ ctrl-manager   │      │ ctrl-manager   │      │ ctrl-manager   │
   │  (LEADER)      │      │  (standby)     │      │  (standby)     │
   │                │      │                │      │                │
   │  etcd member   │◄────►│  etcd member   │◄────►│  etcd member   │
   │    (Raft)      │      │    (Raft)      │      │    (Raft)      │
   └────────────────┘      └────────────────┘      └────────────────┘
            │                       │                       │
            └───────────────────────┴───────────────────────┘
                     Raft quorum = 2 of 3  (tolerates 1 failure)
                                │
            watch + reconcile   │  (decentralized data plane)
                                ▼
   ┌───────────────────────────────────────────────────────────┐
   │  Worker Nodes (kubelet + kube-proxy per node)             │
   │  survive control-plane outage — keep serving traffic      │
   └───────────────────────────────────────────────────────────┘
```

### HA Comparison: Stacked vs External etcd

| Topology | etcd placement | Pros | Cons | Best For |
|---|---|---|---|---|
| Stacked etcd | Co-located on each control-plane node | Simpler to deploy; fewer hosts; lower latency between API server and etcd | A control-plane node failure loses an etcd member too (coupled blast radius) | Most self-managed clusters; small-to-medium |
| External etcd | Dedicated hosts, separate from API servers | Isolates etcd resource needs; etcd can be shared across clusters; independent scaling | More hosts to operate; extra network hop; more complex setup | Very large clusters; shared etcd across multiple clusters |

The operational hazards in an HA control plane revolve around **quorum** and **split-brain**. With three etcd members you tolerate one failure; if two fail, the cluster becomes read-only (no writes) but existing pods keep running because the kubelet and kube-proxy are decentralized and don't need the API server to keep serving traffic — this is the most important resilience property of Kubernetes, that the data plane survives control-plane outages. With five members you tolerate two failures, which is safer but costs more. An even number of members is strictly worse than the odd number just below it (4 tolerates only 1 failure, same as 3, but adds latency), so always choose 3 or 5. Network partitions between control-plane nodes can cause a split where the minority side cannot reach quorum and stops accepting writes while the majority side continues; client requests that land on the minority side hang until the partition heals or they time out and retry against the load balancer, which is why short client timeouts and retry-on-error are essential. For managed Kubernetes (EKS, GKE, AKS) the provider handles etcd HA and API server scaling, but the same principles apply and you still need to understand them to reason about control-plane incidents.

## Capacity Planning

Capacity planning for Kubernetes is fundamentally about translating application demand (requests and replicas) into node count and node size, while leaving headroom for scheduling jitter, node failures, and upgrades. The core arithmetic starts with the per-namespace and per-workload request totals: sum the CPU and memory requests of all pods, divide by a node's **allocatable** capacity (total minus system-reserved and kube-reserved), and add a safety margin. The allocatable concept is critical — a node with 8 vCPU and 32 GB might advertise only ~7 vCPU and 28 GB allocatable after reserving resources for the OS, kubelet, and eviction thresholds, and only the allocatable number is available for scheduling. A useful rule of thumb is to plan for **at least 20-30% spare capacity** in each dimension so that a single node failure or a rolling upgrade (which cordons and drains one node at a time) doesn't trigger a cascading unschedulable state, and to keep the largest single pod's request well under a single node's allocatable so that a hot pod can always be rescheduled.

Beyond raw CPU and memory, capacity planning must account for several additional dimensions:

- **Specialized resources** — GPUs, TPUs, local NVMe, hugepages. These are often the binding constraint and should be planned separately.
- **Storage** — PVC size and IOPS per storage class, and the fact that `WaitForFirstConsumer` volumes are pinned to a zone, so a multi-zone cluster needs per-zone storage headroom.
- **IP address space** — the CNI's pod CIDR must have enough addresses for the maximum pod count, and some CNIs like AWS VPC CNI consume a VPC secondary IP per pod, coupling pod density to subnet size.
- **Control-plane throughput** — etcd write QPS, API server request rate, and the number of objects (keep etcd under ~2-4 GB and the object count under a few hundred thousand).
- **Service mesh / network policy overhead** — sidecars add CPU and memory per pod, and eBPF CNIs add per-node cost.

The **Cluster Autoscaler** and **Karpenter** are the dynamic counterparts: the Cluster Autoscaler watches for unschedulable pods and adds nodes from a configured node group, then removes empty nodes; Karpenter is a more flexible alternative that provisions from a diverse pool of instance types based on pending pod requirements, consolidating underutilized nodes and reacting in seconds rather than minutes. For batch and ML workloads, the combination of Karpenter (for fast, diverse provisioning) with bin-packing scoring (to keep nodes dense and consolidated) is the modern best practice; for services, LeastAllocated spreading plus topology spread plus the Cluster Autoscaler remains the workhorse.

A final planning consideration is the **blast radius** of a node: a node running 60 pods is a bigger failure unit than a node running 10, so spreading-sensitive workloads often prefer more, smaller nodes while bin-packing batch workloads prefer fewer, larger nodes (which also reduces per-node overhead and improves the request-to-allocatable ratio). Many mature platforms run **multiple node pools** with different shapes and taints — a small-pool for low-latency services, a dense-pool for batch, a GPU-pool for ML — and use node affinity and tolerations to route workloads to the right pool, getting the benefits of each strategy without compromising the other.

## Interview Question — Model Answer and Pitfall

**Question:** A service with three replicas, deployed across a three-zone cluster, is repeatedly seeing one zone take 100% of the traffic right after a rolling update, even though you've set `topologySpreadConstraints` with `maxSkew: 1` and `whenUnsatisfiable: DoNotSchedule`. Walk me through what could be wrong and how you'd diagnose it.

**Model Answer:** The symptom — one zone hoarding traffic after a rollout — points to a mismatch between the pod spread the scheduler enforced and the load distribution the Service endpoints actually serve. First, confirm the pods are in fact spread: `kubectl get pods -o wide` should show one pod per zone. If they are, the problem is not scheduling but **endpoint readiness**: the new pods in two zones may be passing their startup probe but failing their **readiness probe** (or taking longer to become ready than the old pods they replaced), so `kube-proxy` has removed their IPs from the Service's endpoint slices and all traffic funnels to the one zone whose pod became ready first. The fix is to ensure the readiness probe accurately reflects serving capacity, to set a `minReadySeconds` and a rolling update `maxUnavailable` that doesn't drop too many pods at once, and to consider a `PodDisruptionBudget` so the rolling update can't voluntarily reduce the ready count below a floor. If the pods are *not* spread (e.g., two in zone A, one in zone B), the constraint may be unsatisfiable because zone C has no viable node — perhaps it was cordoned, out of the pod's node affinity, or lacked the requested resources — and the `DoNotSchedule` policy caused the scheduler to either fail the pod or, with `ScheduleAnyway`, place it suboptimally. Diagnose with `kubectl describe pod` and `kubectl get events`, check node conditions and taints per zone, and verify that the `topologySpreadConstraints` `labelSelector` matches the pod's own labels (a mismatched selector makes the constraint a no-op). A deeper cause is that `PodTopologySpread` only considers *this* service's pods, so if you have two services both spreading across three zones they can stack onto the same nodes and defeat node-level anti-affinity — combine topology spread with `podAntiAffinity` on a shared label for true cross-service spreading.

**Common Pitfall:** Reaching for `podAntiAffinity` with `requiredDuringSchedulingIgnoredDuringExecution` and a `topologyKey` of `kubernetes.io/hostname` to "spread replicas across nodes," then scaling the service past the node count and watching pods go `Pending` because the hard anti-affinity has nowhere legal to place them. The `IgnoredDuringExecution` half of the rule name is the trap: the constraint is enforced at scheduling time only, so it doesn't actively rebalance, but it *does* block new pods when the topology is full. `PodTopologySpread` with `maxSkew` and `ScheduleAnyway` is almost always the better primitive — it spreads when it can, degrades gracefully when it can't, and scales linearly rather than quadratically with replica count. The broader lesson: prefer soft, score-based spreading over hard, filter-based anti-affinity unless you have an absolute correctness reason (like a quorum-based stateful workload that must not co-locate a majority on one node).

## Key Takeaways

- The Kubernetes control plane is a small set of stateless or leader-elected processes coordinating through an etcd-backed watch API, which gives it the resilience property that the data plane survives control-plane failure.
- The scheduler is an online bin-packing optimizer implemented as a pluggable framework of filter and score plugins, and the right configuration depends on whether you optimize for resilience (spread), cost (pack), or specialized placement (affinity, taints, topology spread).
- Admission controllers, quotas, and LimitRanges are the policy layer that gates writes before persistence.
- The kubelet drives pod lifecycle through the CRI/CNI/CSI interfaces, and the controller manager reconciles desired to observed state through dozens of level-triggered loops.
- HA is achieved by replicating stateless components behind a load balancer and protecting the etcd quorum, and capacity planning is a multidimensional exercise in matching requests to allocatable node capacity while leaving headroom for failure and upgrade.

Mastery of these internals is what lets you debug a `Pending` pod, design a scheduler profile for a new workload class, size a cluster for a launch, or answer a staff-level architecture question with confidence rather than guesswork.

## Interview Cheat Sheet

**Key Points to Remember:**
- Kubernetes is declarative reconciliation: controllers watch desired vs observed state and drive convergence — the design is level-triggered, so missed events are self-healing on the next sync.
- The API server is the only component that talks to etcd directly; everything else (scheduler, controllers, kubelet) is a client over a watch-based protocol, which keeps etcd small and pushes business logic to horizontally-scalable edges.
- The scheduler runs a two-phase pipeline — Filter (hard constraints) then Score (soft preferences) — implemented as a pluggable framework; the scoring strategy encodes whether you optimize for resilience (spread) or cost (pack).
- The data plane survives control-plane failure: the kubelet and kube-proxy are decentralized and keep serving traffic even if etcd loses quorum, so a control-plane outage degrades to read-only, not a full outage.
- Always use 3 or 5 etcd members (odd numbers); an even number buys nothing and increases split-brain risk — 4 members tolerate the same 1 failure as 3 but add latency.

**Common Follow-Up Questions:**
- **What's the difference between requests and limits?** Requests are the scheduler's bin-packing floor and the kubelet's cgroup reservation; limits are the ceiling enforced by CPU throttling and OOM kill. Quotas count both, so inflated limits exhaust quota without improving actual capacity.
- **How do you spread replicas across zones safely?** Use `PodTopologySpread` with `maxSkew: 1` rather than hard `podAntiAffinity` — it spreads when it can, degrades gracefully when it can't, and scales linearly instead of quadratically with replica count.
- **What happens when the scheduler can't place a pod?** The `PostFilter` phase runs preemption: it identifies lower-priority victims whose removal would free enough resources, evicts them gracefully, and schedules the preemptor — but PDBs can block eviction, forcing the scheduler to look elsewhere or fail.

**Gotcha:**
- `PodTopologySpread` only considers *this service's* pods, so two services each spreading across three zones can stack onto the same nodes and defeat node-level isolation — combine topology spread with `podAntiAffinity` on a shared label for true cross-service spreading.
