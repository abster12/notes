---
title: "Uber's Dispatch System"
type: system-design
category: Deep Dive
date: 2026-05-25
tags: [system-design, interview, uber, dispatch, geospatial, real-time, matching]
aliases: [Ride-Hailing Dispatch, Supply-Demand Matching]
---

# Uber's Dispatch System

## Summary & Interview Framing

A real-time marketplace matching riders to drivers using geospatial indexing (H3/quadtrees), in-memory grids on dispatch workers, and dynamic surge pricing based on supply-demand ratios.

**How it's asked:** "Design Uber's dispatch system for 500K drivers updating location every 4 seconds. Cover geospatial indexing, matching algorithm, surge pricing, and the break points at scale."

---

## Overview

Uber's dispatch system — internally called the "matching" engine — is the real-time marketplace brain that pairs riders requesting trips with the nearest suitable available drivers. It is not merely a nearest-neighbor lookup over a set of GPS points; it is a geospatial-temporal optimization problem layered on top of a two-sided marketplace, with dynamic pricing, ETA prediction, batching for pooled rides, driver incentives, and hard latency budgets measured in seconds. Every day the system processes tens of millions of ride requests across hundreds of cities, each with idiosyncratic road networks, traffic patterns, regulatory constraints, and driver densities. The fundamental constraint is that a rider waits seconds, not minutes, for a match, and a driver offered a trip responds in seconds, not minutes. Everything else — indexing scheme, matching algorithm, surge model, capacity boundaries — is downstream of that latency budget.

At its core the dispatch problem can be stated compactly: given a stream of rider requests each carrying a pickup point, destination, and service class, and a continuously updated stream of driver positions and states (online, en-route, on-trip, offline), assign each rider request to the driver that minimizes a composite cost function combining expected pickup time, acceptance probability, trip value, and marketplace fairness — all while keeping p99 matching latency under roughly two seconds and sustaining tens of thousands of matches per second at peak. The cost function is deliberately not pure distance, because the closest driver by Euclidean distance may be on the wrong side of a river, facing the wrong direction, or statistically unlikely to accept. The system therefore blends geometric proximity with route-aware ETA, historical acceptance models, and supply-demand signals into a single dispatching decision.

## Key Requirements

The functional surface is straightforward to enumerate but hard to implement well. A rider opens the app, enters a destination, and requests a ride; the system must find an optimal available driver within seconds and return an ETA. The matched driver receives an offer screen showing pickup location, destination, fare estimate, and trip distance, and may accept or decline; declines trigger re-matching without the rider ever seeing a failure in the common case. The system supports cancellations from both sides, scheduled rides booked minutes to hours in advance, pooled rides that batch multiple riders whose routes overlap, and dynamic surge pricing that adjusts the fare multiplier in real time based on local supply-demand imbalance. Beyond matching, the system must continuously track every active driver's position, update rider ETAs as traffic conditions change, re-dispatch if a driver cancels after acceptance, and handle the full trip lifecycle from request through pickup, trip, and completion including billing.

The non-functional requirements are where the engineering pain lives. Match latency must stay under two seconds at p99 because every additional second of waiting measurably increases rider cancellation rate. Throughput must absorb peak-hour load that can be ten to fifty times the daily average in a given city, with global peaks during Friday-evening rush hours, holidays, and weather events. ETA accuracy needs variance under roughly thirty seconds or riders lose trust and drivers game the system. Fairness matters operationally: if a small subset of drivers captures most trips, the rest churn, and the supply side collapses. The system must scale across six hundred-plus cities with independent demand patterns, regulatory rules, and map quality, and it must degrade gracefully during traffic spikes, GPS outages, partial map-data corruption, or the failure of an entire availability zone.

## Geospatial Indexing: Geohash, S2, and H3

The foundation of any dispatch system is a way to index two-dimensional points on the Earth's surface so that "find all drivers within roughly X meters of point P" becomes a cheap, bounded operation rather than a full scan of every driver in the city. The naive approach — store all driver positions in a relational table and query with a bounding-box WHERE clause on latitude and longitude — collapses past a few thousand drivers because a two-dimensional range scan cannot use a single B-tree index efficiently, and the Earth is a sphere, not a flat plane, so bounding boxes near the poles or the antimeridian behave badly. The solution is to encode geographic coordinates into one-dimensional strings or integer cell IDs that preserve locality, then index those. Three encodings dominate the industry: geohash, Google's S2, and Uber's own H3.

### Geohash

Geohash is the oldest and simplest. It interleaves the bits of a point's quantized latitude and longitude into a single bit string, then Base32-encodes it into a short string like "drm3btev3e". The interleaving means that points close on the ground usually share a long prefix, so you can find neighbors by doing string-prefix range scans. Geohash is trivial to implement, fits in a database column, and is good enough for many applications. Its weakness is the "edge case" problem: cells are rectangular and become arbitrarily skinny near the poles, and two points on opposite sides of a cell boundary can be physically adjacent but share no common prefix, forcing you to query all eight neighboring cells to be safe. It also suffers from precision loss at the antimeridian. Geohash is fine for coarse filtering but painful as a primary index at city scale.

### S2

Google's S2 geometry solves the spherical-distortion problem by projecting the Earth's surface onto the six faces of a cube, then recursively subdividing each face into a quadtree to produce a 64-bit cell ID that uniquely identifies a leaf cell at any of 31 levels of resolution. S2 cell IDs are designed so that cells at the same level have roughly equal area everywhere on the sphere, and the Hilbert-curve ordering of the underlying quadtree means nearby cells have numerically close IDs, making range scans efficient. S2 is used heavily inside Google Maps and is available as an open-source library. Its strengths are spherical correctness, a clean hierarchy of levels, and rich tooling for polygon containment and region coverings. Its weakness for dispatch specifically is that the cell shapes are quadrilaterals that vary in shape with latitude and do not tessellate cleanly into the hexagonal grids that Uber and many mapping teams prefer for urban density analysis.

### H3

Uber built H3 precisely to address the shortcomings of both geohash and S2 for ride-hailing. H3 is a discrete global grid system that partitions the Earth's surface into hexagonal cells at sixteen resolutions, from the very coarse (a cell the size of a small country) down to resolution fifteen (cells under one square meter). Hexagons are chosen because they are the most circular regular polygon that tessellates, which minimizes the quantization error between a point and its containing cell and — crucially for dispatch — gives every cell exactly six equidistant neighbors, unlike squares which have eight neighbors of two different distances. This uniform-neighbor property makes ring-based neighbor queries ("all drivers within three cells of this rider") clean and isotropic. H3 is now open source and used well beyond Uber. In practice Uber uses H3 at around resolution eight or nine (cells roughly 0.7 km across) as the primary unit of supply-demand measurement and surge computation, and finer resolutions for dispatch radius queries. The choice between the three is not academic: geohash gets you started in an afternoon, S2 gets you spherical correctness for free, and H3 gets you the cleanest urban analytics and neighbor topology at the cost of a more complex library and a fixed hexagonal hierarchy that does not subdivide into smaller hexagons exactly (children of a hex are a mix of hexes and pentagons, handled by the library).

```
H3 Hexagonal Grid — Ring Expansion for Dispatch

              ___
          ___/ 2 \___
      ___/ 2 \___/ 2 \___
     / 2  \___/ 1 \___/ 2  \
     \___/ 1 \___/ 1 \___/
     / 1  \___/ 0 \___/ 1  \
     \___/ 1 \___/ 1 \___/
     / 2  \___/ 1 \___/ 2  \
     \___/ 2 \___/ 2 \___/
         \___/ 2 \___/
             \___/

   0  = rider's pickup cell (ring 0)           1 cell
   1  = six immediate neighbors (ring 1)       6 cells
   2  = twelve second-ring neighbors (ring 2)  12 cells

   Key property: every hex has exactly 6 equidistant neighbors,
   making ring queries isotropic (uniform in all directions).
   Cell count for ring k = 6 * k (for k >= 1).
```

### Geospatial Index Comparison

| Feature | Geohash | S2 | H3 |
|---|---|---|---|
| **Cell shape** | Rectangle | Quadrilateral | Hexagon |
| **Spherical correctness** | No (flat projection) | Yes (cube projection) | Yes (icosahedral) |
| **Neighbor count** | 8 (2 different distances) | 4 (quadtree children) | 6 (uniform distance) |
| **Locality preservation** | String-prefix sharing | Hilbert-curve ordering | Ring-based topology |
| **Resolution levels** | Variable (string length) | 31 levels | 16 resolutions |
| **Cell area uniformity** | Varies by latitude | Roughly equal | Roughly equal |
| **Edge / antimeridian** | Poor (precision loss) | Good | Good |
| **Index type** | String prefix | 64-bit integer | 64-bit integer |
| **Hierarchy subdivision** | Exact (truncate prefix) | Exact (quadtree) | Approximate (hex + pentagon mix) |
| **Sharding simplicity** | Easy (prefix range) | Easy (integer range) | Easy (cell ID modulo) |
| **Polygon / region tooling** | Minimal | Rich (coverings, containment) | Moderate (rings, polygons) |
| **Primary use case** | Coarse filtering, DB index | Maps, polygon containment | Urban analytics, dispatch |
| **Best for dispatch** | v1 / fallback only | Google-ecosystem shops | Production ride-hailing |

## Nearest Driver Matching Algorithm

With an index in place, the matching algorithm itself is a constrained k-nearest-neighbor search over the driver set, filtered by eligibility and ranked by a composite cost. The canonical flow is: when a rider request arrives, the dispatch service resolves the rider's pickup H3 cell, then expands outward ring by ring — first the containing cell, then its six immediate neighbors, then the next ring — querying the driver-location store for all drivers in those cells whose state is "online and available" and whose vehicle class matches the request. Expansion stops as soon as enough candidate drivers are found or a maximum radius (typically a few kilometers) is reached. Each candidate is then scored by a cost function such as `cost = w1 * expected_pickup_eta + w2 * (1 - acceptance_probability) + w3 * trip_value_penalty + w4 * fairness_credit`, where the weights are tuned per market and time of day. The lowest-cost driver is offered the trip first; if they decline or do not respond within a short timeout (a few seconds), the next candidate is offered, and so on. This serial-offer pattern is preferred over broadcasting the request to many drivers simultaneously because it avoids the "tragedy of the commons" where every driver ignores the offer hoping someone else takes it, and it lets the system learn and adapt the acceptance model per driver.

```
Nearest Driver Matching Flow

  ┌─────────────────────┐
  │   Rider Request      │
  │  (pickup, dest,      │
  │   service class)     │
  └──────────┬──────────┘
             │
             ▼
  ┌─────────────────────┐
  │  Resolve H3 pickup   │
  │  cell from lat/lon   │
  └──────────┬──────────┘
             │
             ▼
  ┌─────────────────────┐
  │  Ring-by-ring        │◄──── max radius
  │  expansion           │      (few km)
  │  (ring 0 → 1 → 2…)   │
  └──────────┬──────────┘
             │
             ▼
  ┌─────────────────────┐
  │  Query cell sets     │
  │  for available       │
  │  drivers (scatter-   │
  │  gather to shards)   │
  └──────────┬──────────┘
             │
             ▼
  ┌─────────────────────┐
  │  Filter candidates:  │
  │  • vehicle class     │
  │  • state = available │
  │  • position freshness│
  └──────────┬──────────┘
             │
             ▼
  ┌─────────────────────┐
  │  Score by cost fn:   │
  │  w1*ETA + w2*(1-P)   │
  │  + w3*value + w4*fair│
  └──────────┬──────────┘
             │
             ▼
  ┌─────────────────────┐     decline /
  │  Serial offer        │──── no resp ─────┐
  │  (lowest cost first) │    (few sec)      │
  └──────────┬──────────┘                  │
             │ accept                        │
             ▼                              │
  ┌─────────────────────┐                  │
  │  MATCH!             │            next
  │  Trip created       │◄── candidate ────┘
  │  Driver → "offered" │
  └─────────────────────┘
```

The data structure backing the cell query matters at scale. For the hot path, Uber maintains an in-memory grid — effectively a hash map from H3 cell ID to a set or sorted container of driver IDs currently in that cell — replicated across many dispatch worker nodes, with each node owning a shard of cells (city-partitioned). Driver position updates stream in continuously and update the in-memory grid; when a driver crosses a cell boundary they are removed from one set and inserted into another. A quadtree is an alternative that some systems use instead of a fixed grid: it subdivides dynamically so dense downtown areas get fine-grained leaf nodes and sparse rural areas get coarse ones, all within one tree. The tradeoff is that quadtrees require rebalancing under churn and are harder to shard cleanly across machines, whereas a fixed H3 grid shards trivially by cell ID modulo the number of partitions. Uber landed on the fixed hex grid with in-memory sets per cell, backed by Redis-like stores for persistence and cross-node fan-out for queries that span shards. The matching worker that receives a request may need to query cells owned by other workers; this is done via a scatter-gather RPC where the requesting node fans out to the relevant cell owners, each returns its local candidate set, and the requesting node merges, scores, and offers serially.

## Supply-Demand Balancing

Matching solves the instantaneous problem of "which driver gets this request," but the marketplace is healthy only if supply and demand are roughly in balance across space and time. Imbalance manifests in two directions: too few drivers relative to riders produces long ETAs, cancellations, and rider churn; too many drivers relative to riders produces idle time, low earnings, and driver churn. The dispatch system therefore runs a continuous supply-demand balancing layer that measures, per H3 cell and per time bucket, the ratio of requesting riders to available drivers, and uses that ratio both to set surge pricing (pulling demand down and supply up when riders exceed drivers) and to position incentives for drivers to relocate toward under-supplied cells before requests actually arrive.

The measurement is straightforward in concept but noisy in practice. For each cell and each one-minute window the system counts unique rider requests (demand) and time-integral of available drivers (supply, normalized by availability duration). The raw ratio is smoothed with an exponential moving average to avoid thrashing on transient spikes — a single bus depositing thirty tourists should not trigger a permanent surge. The smoothed ratio feeds a pricing function that maps ratio buckets to surge multipliers: a ratio near one yields no surge, a ratio of two might yield a 1.5x multiplier, and extreme ratios cap out at a regulatory or product-defined ceiling (often 2.0x to 2.5x in most markets). The multiplier is published per cell and propagates to the fare calculation shown to riders before they request and to drivers as an earnings signal.

Positioning supply proactively is the harder half of balancing. Uber and similar systems compute a "heat map" of projected demand per cell for the next several minutes using historical patterns blended with live signals (concerts, weather, transit disruptions), then send push notifications or in-app prompts to idle drivers in oversupplied cells suggesting they drive toward nearby undersupplied cells, sometimes with a small monetary incentive. The dispatch matching algorithm itself can also be biased to favor drivers who are positioned in currently oversupplied areas for the next trip, on the theory that sending them a trip now moves them out of an area where they would otherwise idle. None of this is perfectly optimal — it is a feedback control loop with significant lag, since drivers take minutes to relocate — but it materially improves the balance compared to purely reactive matching.

## Surge Pricing

Surge pricing is the most visible output of the supply-demand layer and the most product-sensitive. The goal is twofold: allocate the scarce supply to the riders who value the trip most (revealed by willingness to pay the multiplier), and incentivize more supply to come online or relocate into the surge zone. The multiplier for a given cell is computed from the smoothed supply-demand ratio and a marketplace-health score, then geographically smoothed so neighboring cells do not have jarringly different multipliers (which would cause rider confusion and gaming). Temporal smoothing prevents the multiplier from oscillating minute to minute, which would erode trust; Uber moved years ago from a continuous multiplier to discrete "surge levels" in some markets partly to make the number feel stable and legible.

### Surge Pricing Factors

| Factor | Input Signal | Effect on Surge Multiplier |
|---|---|---|
| **Supply-demand ratio** | requesting riders / available drivers per cell | Higher ratio → higher multiplier |
| **EMA smoothing** | exponential moving average of raw ratio | Dampens transient spikes (e.g., bus of tourists) |
| **Marketplace health score** | acceptance rates, fulfillment rate | Lower health → higher multiplier |
| **Geographic smoothing** | neighboring cell multipliers | Prevents jarring cross-cell price cliffs |
| **Temporal smoothing** | recent multiplier history | Prevents minute-to-minute oscillation |
| **Regulatory cap** | city / region regulations | Hard ceiling (typically 2.0x–2.5x) |
| **Hysteresis** | separate start vs stop thresholds | Prevents rapid on/off toggling (whack-a-mole) |
| **Route barriers** | rivers, highways between cell and demand | Reduces effective supply response → multiplier may not help |

The mechanics of applying surge are deceptively subtle. The multiplier must be shown to the rider before they request, so it must be computed and cached per cell with low latency, and the fare estimate shown pre-request must use the same multiplier that will be applied post-request, or riders feel bait-and-switched. The multiplier is applied to the base fare components — time and distance — but not to fixed fees or minimum fares in most markets, and regulatory caps in some cities force a hard ceiling. Drivers see the surge as part of their earnings projection and are more likely to accept trips and to drive into surge zones. The system must also handle surge decay: as drivers relocate into a surge cell and the ratio improves, the multiplier must come down, but not so fast that drivers who just relocated feel cheated. This is a control problem with human behavior in the loop, and tuning it is as much art as engineering.

A frequent failure mode is surge "whack-a-mole": a surge appears in a cell, drivers flood in, the cell becomes oversupplied, surge drops to zero, drivers leave, demand spikes again, surge returns. The smoothing and EMA parameters are tuned to dampen this, and some systems add hysteresis (a higher threshold to start surge, a lower threshold to stop it) to prevent rapid toggling. Another failure mode is geographic mismatch: surge in a cell whose drivers cannot physically reach the demand (across a river with no bridge nearby) produces no supply response, so the pricing layer must be route-aware or at least aware of barriers, not purely cell-ratio-driven.

## Driver Location Tracking

Every online driver emits a GPS update every few seconds — Uber targets roughly one update every four seconds during active trips and less frequently when idle — and these updates flow through a location ingestion pipeline into the in-memory cell grid that matching queries. The volume is substantial: with several million drivers online globally and updates every few seconds, the ingestion path sees tens of thousands of updates per second at peak, each update carrying a driver ID, latitude, longitude, heading, speed, accuracy estimate, and timestamp. The pipeline must be lossy-tolerant: a dropped update is fine because the next one will arrive shortly, but a stale position is dangerous because it causes bad matches. The ingestion service therefore tags each position with a freshness timestamp and the matching layer ignores or down-weights positions older than a threshold.

The storage backing the live grid is a combination of an in-memory data structure on the dispatch workers (for sub-millisecond query) and a durable, replicated store (often Redis Cluster or a custom geospatial store) that holds the authoritative current position per driver for cross-shard queries and recovery. Driver positions are sharded by H3 cell so that a query for a region touches a small number of shards. When a driver crosses a cell boundary the old cell removes them and the new cell adds them; this churn is high in dense cities but is a cheap hash-set operation. Quadtree-based tracking is an alternative some systems use: the tree subdivides where drivers are dense, so a downtown block with hundreds of drivers gets a deep leaf node while a rural area with one driver gets a shallow one. The advantage is adaptive resolution; the disadvantage is that rebalancing the tree under churn and sharding it across machines is more complex than sharding a fixed grid. Uber's choice of a fixed H3 grid with per-cell sets is a deliberate tradeoff favoring operational simplicity and clean sharding over adaptive resolution.

A critical detail is that raw GPS is not what gets stored for matching. Raw GPS from a phone in an urban canyon can be off by tens of meters, which would cause the system to think a driver is on the wrong street and compute an ETA through a building. Positions are therefore map-matched before being used for matching (see below), snapping the GPS point to the most likely road segment, and the matching layer uses the map-matched position and the road network graph for ETA rather than the raw point.

## Dispatch Optimization

The serial-offer matching described above is the baseline, but it is locally greedy and not globally optimal. If three riders request within the same second in adjacent cells and the system matches them one at a time, the first match might grab a driver that would have been better assigned to the second rider, leaving the second rider with a worse match. Dispatch optimization addresses this by batching requests over a short window — typically a few seconds — and solving a small assignment problem over the batch. With N riders and M candidate drivers, the problem is to find the assignment minimizing total cost, which is a bipartite matching problem solvable with the Hungarian algorithm in O(N^2 * M) or, for larger batches, a min-cost max-flow formulation. The batch window is short because the latency budget is tight; a one-to-two-second batch adds that much latency but can materially improve total pickup ETA across the batch, especially in dense areas.

```
Dispatch Optimization Pipeline

  Time →
  ◄──────── batch window (1–2 sec) ────────►

  R1   R2   R3   R4  ...   Rn      rider requests arriving
  │    │    │    │          │
  ▼    ▼    ▼    ▼          ▼
  ┌──────────────────────────────────┐
  │      Request Batch Buffer         │
  └───────────────┬──────────────────┘
                  │
                  ▼
  ┌──────────────────────────────────┐
  │  Collect candidate drivers        │
  │  (H3 ring query per rider)        │
  └───────────────┬──────────────────┘
                  │
                  ▼
  ┌──────────────────────────────────┐
  │  Build cost matrix                │
  │  rows = N riders                  │
  │  cols = M drivers                 │
  │  cell[i][j] = composite cost      │
  └───────────────┬──────────────────┘
                  │
                  ▼
  ┌──────────────────────────────────┐
  │  Bipartite Assignment             │
  │  Hungarian algorithm  O(N² × M)   │
  │  or min-cost max-flow             │
  └───────────────┬──────────────────┘
                  │
                  ▼
  ┌──────────────────────────────────┐
  │  Globally optimal assignments     │
  │  (rider i ↔ driver j)             │
  └───────────────┬──────────────────┘
                  │
                  ▼
  ┌──────────────────────────────────┐
  │  Serial offers in                 │
  │  assignment order                 │
  └──────────────────────────────────┘
```

Optimization also extends to pooled rides, where the assignment problem becomes a vehicle routing problem: a single driver may pick up multiple riders whose pick-up and drop-off points can be interleaved along a route, and the objective is to minimize total detour across all riders while keeping each rider's total trip time within an acceptable multiple of their direct trip. This is NP-hard in the general case, so production systems use greedy insertion heuristics: for each new rider request, try inserting the pickup and dropoff into every position of every active pool trip's existing sequence, compute the added detour, and accept the insertion with the least added cost if it stays within per-rider detour bounds. The heuristic is not optimal but runs in milliseconds and produces good empirical results.

A third optimization axis is pre-positioning and fleet-level dispatch for large partners (e.g., a fleet of airport shuttles or corporate accounts), where the system can plan driver movements minutes ahead based on forecast demand rather than waiting for requests. This crosses into operations-research territory and is typically handled by a separate planning service that writes suggested movements back into the driver app. The real-time dispatch path remains reactive; the planning path is proactive and slower.

## ETA Estimation

ETA is the single number that most affects rider and driver experience, and it is surprisingly hard to compute accurately. The naive approach — straight-line distance divided by an average speed — is wrong by a factor of two or more in cities with rivers, one-way grids, or traffic. Production ETA is computed on the road network graph: the map-matched pickup point and the driver's current map-matched position are both nodes (or snapped to edges) on a directed graph where edges carry a travel time that is a function of road class, current traffic, and time of day. A shortest-path algorithm — typically a contraction-hierarchy or A* variant precomputed for the region — returns the fastest route and its total travel time, which is the ETA. The graph is large (a major city has millions of edges) so it is preprocessed offline into a hierarchy that enables millisecond queries, and edge travel times are updated continuously from live traffic feeds and historical patterns.

ETA is not a single number; it is a distribution. The system reports a point estimate (the median expected arrival) but internally models the variance, because a driver might arrive in four minutes median but with a tail to ten minutes if a drawbridge opens. Rider-facing ETAs are rounded and slightly pessimistic so that early arrivals feel like a pleasant surprise rather than late arrivals feeling like a failure. ETA is recomputed periodically throughout the trip — for the pickup leg as the driver approaches, and for the trip leg as traffic evolves — and pushed to both rider and driver apps via the real-time update channel. A persistent ETA error, where the reported ETA is systematically too optimistic, is one of the most damaging bugs a dispatch team can ship, because it directly drives cancellations and bad ratings; ETA accuracy is monitored as a first-class SLO with alerting on bias and variance by city and time of day.

Machine-learned ETA models increasingly augment or replace pure graph-based ETA. A model trained on historical actual arrival times given route, time, weather, and driver features can correct systematic biases in the graph-based estimate — for example, learning that a particular neighborhood has slow driveway exits that the graph does not capture. The hybrid pattern is to use the graph ETA as a strong prior and a learned residual model to correct it, which keeps the model interpretable and robust to novel situations (the graph still works in a new city with no training data) while improving accuracy where data is plentiful.

## Trip Lifecycle

A trip passes through a well-defined state machine, and the dispatch system owns or observes every transition. The lifecycle begins when a rider taps "request": the request enters the dispatch queue, the matching algorithm runs, and a driver is selected and sent an offer. The driver's state transitions from "available" to "offered" and they have a few seconds to accept or decline. On acceptance the trip enters the "accepted" or "en route" state: the driver is now committed to this rider, their position is no longer in the available pool, and the rider sees the driver's identity, vehicle, and live ETA. As the driver approaches the pickup, ETAs are refreshed continuously and both parties see each other on the map. When the driver arrives at the pickup location the trip enters "arrived"; the rider is notified, and a wait timer starts counting toward a no-show threshold. Once the rider boards and the driver starts the trip, the state becomes "on trip": the destination is fixed (in most markets; riders can add stops), the fare is accruing, and the navigation is now turn-by-turn to the destination via the routing engine. On arrival at the destination the driver ends the trip, the fare is finalized from the recorded time and distance (surge multiplier applied), payment is processed, and receipts and ratings are exchanged. The driver's state returns to "available" and they re-enter the matching pool, typically after a short cooldown to allow them to finish the trip paperwork.

```
Trip Lifecycle State Machine

  ┌───────────────┐
  │   Request      │
  │   Created      │
  └───────┬───────┘
          │ matching algorithm runs
          ▼
  ┌───────────────┐     decline / timeout
  │   Offered     │────────────────────────────┐
  └───────┬───────┘                            │
          │ accept (few sec)                    ▼
          ▼                               re-match:
  ┌───────────────┐                        offer to
  │  Accepted /   │                        next
  │  En Route     │                       candidate
  └───────┬───────┘
          │ driver approaches pickup
          ▼
  ┌───────────────┐     rider no-show
  │   Arrived     │──── (timer exceeds) ──► cancel +
  └───────┬───────┘                        fee logic
          │ rider boards, driver starts trip
          ▼
  ┌───────────────┐
  │   On Trip     │
  └───────┬───────┘
          │ driver ends trip at destination
          ▼
  ┌───────────────┐
  │   Completed   │
  └───────┬───────┘
          │ fare finalized + payment + ratings
          ▼
  Driver → "Available" (re-enters matching pool)

  Cancellation paths (at any pre-trip state):
  ┌─────────────────────┐
  │ Rider cancel         │──► re-match rider (no fee in
  │                      │    common case)
  │ Driver cancel        │──► re-match rider, driver
  │  (after acceptance)  │    may get cancellation fee
  └─────────────────────┘
```

Each transition is an event written to an append-only trip event log, which is the source of truth for billing, analytics, and dispute resolution. The state machine is explicit and idempotent because duplicate events arrive under network retries: a "trip started" event processed twice must not double-charge. The dispatch worker that owns a trip is the coordinator for its transitions, but ownership can transfer between workers during failover, so the trip state is persisted to a durable store (a trip database) at each transition and the in-memory state is reconstructable from the log. Cancellations can occur at several points — rider cancels before assignment, rider or driver cancels after acceptance but before pickup, no-show after driver arrives — each with different fee and re-disposition logic. A cancellation after acceptance triggers re-matching of the rider (if they did not cancel) and returns the driver to the pool, possibly with a cancellation fee credited to the driver to compensate for the dead trip to the pickup.

## Real-Time Updates

Both rider and driver apps need a continuously updated view: the rider wants to watch the driver approach on the map and see ETA tick down, and the driver wants to see the rider's pickup location and navigate to it. This is not polling; it is a persistent low-latency push channel. The architecture is a fleet of connection-handling servers (websocket or a custom mobile push protocol) that maintain long-lived connections to hundreds of thousands of concurrent mobile clients, sharded by client ID. Driver position updates flow from the driver's phone to the location ingestion pipeline, which updates the in-memory grid and also publishes the updated position onto a pub-sub bus; the connection server that owns the rider's connection subscribes to position updates for the driver assigned to that rider and pushes each update down the rider's open connection. The same channel carries ETA recomputations, trip state transitions, and messages between rider and driver.

The scale of the connection tier is significant: at peak, hundreds of thousands of concurrent websocket connections per city, each idle most of the time but bursting on every position update. Connection servers are stateful and partitioned, so a rider whose connection lands on server A and whose driver's updates arrive at server B requires a cross-server fan-in: the driver's position events are published to a topic keyed by trip ID, and every connection server with a client subscribed to that trip receives the event and forwards it. This is typically built on a pub-sub system like Kafka or a lighter in-memory broker for the hot path, with the connection servers acting as fan-out leaves. Failover is handled by client reconnect with session resumption: if a connection server dies, clients reconnect to a new one, re-subscribe to their active trip's topic, and resume; a few seconds of missed updates is acceptable because the next position update refreshes the full state.

## Map Matching: GPS to Road

Raw GPS is insufficient for dispatch because consumer-grade GPS in urban environments has median error of five to ten meters and tail error of tens of meters, especially among tall buildings, in tunnels, and under elevated tracks. A driver reported at a GPS point ten meters off their actual road, if taken literally, would be matched to a driver on the wrong block, with an ETA computed through buildings. Map matching is the process of taking a stream of noisy GPS observations and inferring the most likely actual road segment the vehicle is on, producing a corrected position snapped to the road network graph. This is a hidden Markov model problem: the hidden state is the true road segment, the observations are the GPS points, and the transition probabilities between segments are given by the road graph connectivity and plausible vehicle speeds. The Viterbi algorithm over the sequence of recent GPS points yields the most likely path of road segments, and the current position is snapped to the most likely current segment.

Production map matching runs on the device, on the server, or split between both. On-device matching has the advantage of low latency and offline operation but is constrained by phone CPU and the size of the local map cache; server-side matching has the full map and compute but adds round-trip latency. Uber and most ride-hailing systems do a hybrid: the driver app does a fast local snap for immediate display and navigation, and sends the raw GPS plus a local snap hint to the server, which runs the authoritative matcher with the full graph and historical traffic and returns the corrected position. The matched position is what feeds the location grid for matching and the ETA engine; the raw GPS is retained for forensics and model training. Map matching quality directly determines ETA quality and matching quality, so it is monitored as a first-class signal: a sudden increase in "off-road" positions in a city usually indicates a map-data regression (a new road not yet in the graph) or a GPS firmware bug on a popular phone model, and the dispatch team treats it as a high-priority incident.

## Capacity Planning for Millions of Concurrent Trips

Sizing the dispatch system for millions of concurrent trips is an exercise in identifying the hot-path components and provisioning each for peak with headroom. The hot path has three high-volume components: location ingestion (every driver, every few seconds), matching queries (every rider request, plus retries and re-dispatch), and the real-time update fan-out (every driver position update to every watching rider). At a global scale of tens of millions of daily rides, several million online drivers, and peak concurrency of several hundred thousand active trips:

**Location Ingestion Path:**
- ~50,000 driver position updates per second at global peak
- Each update carries: driver ID, lat, lon, heading, speed, accuracy estimate, timestamp
- Sharded by driver ID for horizontal scalability
- Updates every ~4 seconds during active trips, less frequent when idle
- Lossy-tolerant: dropped update acceptable, stale position is not

**Matching Query Path:**
- Several thousand requests per second at peak (most match on first offer)
- Offer rate is a small multiple of request rate due to declines/retries
- Sharded by H3 cell — hot cells in dense downtown areas are the bottleneck
- p99 matching latency must stay under ~2 seconds
- Tens of thousands of matches per second at global peak

**Real-Time Update Fan-Out:**
- Hundreds of thousands of position events per second pushed to watching riders
- Hundreds of thousands of concurrent websocket connections per city
- Each connection: tens of kilobytes of buffer and state
- Connection servers are stateful, sharded by client ID
- Tens of thousands of connection servers globally

**Provisioning Headroom:**
- Stateless tiers (matching workers, ETA engine, connection servers): 2–3x peak observed load with autoscaling
- Stateful tiers (live grid, trip database): careful manual capacity planning
- Per-region / per-city provisioning, not purely global (single city rush hour can spike 10–50x daily average)
- Large cities or regions often isolated onto dedicated clusters to prevent cross-city interference

Each component is horizontally scalable and sharded by a natural key: ingestion by driver ID, matching by H3 cell, connection servers by client ID. The cell-sharded matching grid is the trickiest because a single hot cell — a downtown block at rush hour with hundreds of drivers — can become a bottleneck on the shard owning that cell. Mitigations include finer cell resolution in dense areas (more, smaller cells means more shards share the load) and dynamic re-sharding that splits overloaded cells across multiple workers. The connection tier is memory-bound: each websocket connection consumes tens of kilobytes of buffer and state, so a server with tens of gigabytes can hold on the order of a million connections, and the fleet scales to tens of thousands of servers globally. The matching workers are CPU-bound on scoring and graph queries, and the ETA engine is CPU-bound on shortest-path computation, so both are provisioned by cores and scaled by request rate. Storage is secondary on the hot path — the live grid is in-memory — but the trip database and event log grow continuously and are scaled by daily trip volume with retention policies.

Capacity planning must account for geographic skew: a single city's rush hour can spike local load ten to fifty times the daily average while the rest of the world is quiet, so provisioning is per-region and per-city, not purely global. Multi-tenancy across cities on shared infrastructure is possible but risky because a bug or traffic spike in one city can starve others; many systems isolate large cities or regions onto dedicated clusters. Headroom is typically provisioned at two to three times peak observed load to absorb incidents, weather events, and growth, with autoscaling for the stateless tiers (matching workers, ETA engine, connection servers) and careful manual capacity planning for the stateful tiers (the live grid, the trip database). The cost of under-provisioning is visible — surge without supply, failed matches, rider churn — while the cost of over-provisioning is invisible but real, so the team monitors utilization and cost-per-trip as joint SLOs.

## Failure Handling

A dispatch system that cannot degrade gracefully will, under any real incident, fail in a way that cascades into a marketplace collapse: riders cannot get cars, drivers idle without earnings, and both sides leave the platform. Failure handling is therefore designed in depth at every layer. At the ingestion layer, a lost position update is fine — the next one arrives in seconds — so the ingestion pipeline is allowed to drop updates under load and the matching layer uses freshness timestamps to ignore stale positions rather than trusting them. At the matching layer, if the primary cell-grid shard is unavailable, the worker falls back to a secondary replica or to a coarser-grained index (larger cells, fewer shards) that is more likely to be available; a degraded match is better than no match. If no driver is found within the radius, the rider is told "no cars available" with a retry suggestion rather than hanging indefinitely. At the ETA layer, if the routing engine is slow or unavailable, the system falls back to a cached or straight-line ETA clearly marked as approximate, so the rider still gets a number rather than a spinner.

The connection tier handles failure by client-side reconnect with exponential backoff and session resumption, so the death of a connection server is largely invisible to users beyond a brief gap. The trip state machine is persisted at every transition to a durable store, so if a dispatch worker dies mid-trip the trip is picked up by another worker from the last persisted state; the event log is the source of truth and is append-only, so reconstruction is deterministic. Cross-zone failover is practiced regularly: each region runs in multiple availability zones with the stateless tiers active-active and the stateful tiers in primary-replica with automated promotion on failure. A full-region failure is the worst case and is handled by serving the affected region from a neighbor region with reduced capacity, or by shedding load (disabling pooling, raising surge caps, showing longer ETAs) to keep the core matching path alive.

A particularly insidious failure mode is a thundering herd on recovery: if a zone fails and drivers reconnect en masse when it returns, the ingestion and matching paths can be overwhelmed by a synchronized burst of position updates and re-registrations. Mitigations include jittered reconnect backoff on the client, rate-limiting on the ingestion ingress, and warming up caches and grid state progressively rather than accepting full load immediately. Another subtle failure is a map-data regression: a bad map update that removes a major road from the graph causes ETAs to spike and matching to misfire across a whole city, and the only fix is a rollback of the map data, so map updates are versioned, canary-deployed by region, and quickly reversible. GPS firmware bugs on a popular phone model can cause a sudden flood of bad positions that look like a map-matching failure; the map-matching layer must be robust to absurd inputs (a GPS point in the ocean should be rejected, not snapped to the nearest coastline road) and alert on anomaly rates. Cultural readiness matters as much as the mechanisms: the team runs game days that intentionally fail zones, inject latency, and corrupt map data, because a failure-handling design that has never been exercised under load is an untested hypothesis.

## Sharp Interview Question

**Question:** You are designing the dispatch matching path. A rider request arrives and you need to find the nearest available driver. You have a Redis geospatial index (GEOSEARCH) over all driver positions and a Postgres table of drivers with latitude and longitude columns. The city has fifty thousand drivers online. Walk me through how you serve this query in under two seconds at p99, and where does this design break first as the city grows to five hundred thousand drivers?

**Model Answer:** Start by rejecting the Postgres bounding-box approach for the hot path: a two-dimensional range scan on latitude and longitude cannot use a single B-tree index, so even with separate indexes the planner does an index intersection that is slow at fifty thousand rows and dies at five hundred thousand. Postgres with PostGIS and a GiST index on a geometry column would work and is a reasonable v1, but for sub-hundred-millisecond p99 at scale the hot path should be in-memory. Redis GEOSEARCH uses geohash under the hood and serves a radius query over fifty thousand points in under a millisecond, so it is a fine v1 and a fine fallback. The real design, though, is a sharded in-memory H3 grid: each cell maps to a set of driver IDs, cells are sharded across dispatch workers by cell ID, and a query does a scatter-gather to the shards owning the rider's cell and its neighbor rings. This keeps the hot path in process memory with no Redis round-trip, scales horizontally by adding shards as driver density grows, and lets you tune resolution per city.

Where it breaks first at five hundred thousand drivers is not the query — the scatter-gather is still fast — but the cell hot-spot: a downtown cell with thousands of drivers makes the set on that cell's shard large and the fan-out from that shard to every query touching it a CPU bottleneck. The fix is finer resolution in dense areas (split the hot cell into seven child hexes, spreading the drivers across more shards) or dynamic re-sharding of overloaded cells. The second break point is ingestion: five hundred thousand drivers updating every four seconds is 125k updates per second, and the cross-cell move churn in a dense downtown is high, so the ingestion path must be sharded by driver ID and the cell-set updates must be lock-free or finely locked to avoid contention. The third break point, often missed, is the real-time fan-out: if a significant fraction of those drivers are on trips with watching riders, the connection-tier fan-out of position updates can saturate the connection servers before the matching path does, and the connection tier is stateful and harder to scale than the stateless matching workers. A strong answer names all three break points and the mitigation for each, rather than stopping at "add more Redis shards."

**Common Pitfall:** Reaching for a spatial database (PostGIS, Redis GEO) as the primary hot-path index and discovering at scale that the network round-trip and the single-shard hot-spot dominate latency. The geospatial index is necessary but not sufficient; the production pattern is an in-memory, sharded-by-cell grid on the dispatch workers themselves, with the database as a durable fallback and recovery source, not the query path. Candidates who propose only "use Redis GEOSEARCH" have a working v1 and a broken v2, and the follow-up question about the five-hundred-thousand-driver break point is where that becomes visible. A related pitfall is matching on raw GPS rather than map-matched positions: the nearest driver by raw GPS may be on the wrong side of a barrier, producing a match that looks good in the data and is terrible on the ground.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Core problem: match riders to nearby drivers in real-time, considering location, ETA, and supply-demand balance
- Geospatial index: geohash, quadtree, or H3 for spatial partitioning. In-memory grid on dispatch workers, not DB
- Surge pricing: dynamically adjust multipliers based on real-time supply-demand ratio per zone
- Map-matching: snap raw GPS to road network before matching — nearest by GPS ≠ nearest by road
- Dispatch is a real-time optimization problem, not a database query — avoid PostGIS/Redis GEO on the hot path

**Common Follow-Up Questions:**
- "How do you handle 500K drivers updating location every 4 seconds?" — WebSocket connections, location updates go to in-memory grid (sharded by geocell), periodically checkpointed to database.
- "How do you prevent the thundering herd when a surge area opens?" — Gradual price adjustment, driver notification batching, and jittered dispatch to avoid all drivers racing to one zone.

**Gotcha:**
- Using a spatial database (PostGIS, Redis GEO) as the primary hot-path index works at small scale but fails at the 500K driver break point — the network round-trip and single-shard hot-spot dominate latency. The production pattern is an in-memory, sharded-by-cell grid on the dispatch workers, with the database as a durable fallback, not the query path.
