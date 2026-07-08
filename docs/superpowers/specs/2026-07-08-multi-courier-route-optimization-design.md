# Multi-courier route optimization — stronger split

**Date:** 2026-07-08
**Status:** Design approved
**Scope:** `server/src/modules/routing/route-split.ts` and its workload metric only. `routing.service.ts` keeps calling `sweepSplit` with the same public signature; the storefront, admin client, and Google-optimize step are untouched.

## Problem

The current multi-courier splitter (`route-split.ts`) partitions delivery stops by **polar angle** around the farm depot into N contiguous arcs ("pie slices"), balanced by an estimated workload, then runs a weak 2-pass border-shift local search. For the realistic case (2–3 couriers, tens of stops) this loses optimality in three ways:

1. **Pie-slice cuts split geographic clusters.** When customers form distinct clusters (e.g. two villages east/west of a central depot), an angular cut can slice each cluster in half instead of giving one cluster to each courier. Sweep (Gillett-Miller) is good for uniform circular spread, poor for clustered demand.
2. **The balancing metric doesn't match the real route.** `estimateWorkloadS` is a **one-way** greedy nearest-neighbour tour — it ignores the return-to-depot leg. But `home` end mode is a round trip, so a radially far arc really costs roughly double, and the balancer can't see it. Balancing on the wrong proxy yields unbalanced real finish times.
3. **The local search is too weak.** It moves only a single edge stop, only between adjacent arcs, for at most 2 passes. It cannot swap two stops between couriers, move an interior stop, or relocate a whole cluster — so it settles in a local minimum immediately.

Because the split runs *before* the per-group Google visit optimizer, and Google cannot move a stop from one courier to another, split quality caps the whole result.

## Objective

**Hybrid:** minimize **makespan** (the workload of the busiest courier — couriers drive in parallel, so this is the real "when are we all done" time), tie-break on **total** workload across couriers (don't waste kilometres when finish time is equal). Confirmed with the operator.

## Design

Three changes, all inside `route-split.ts`. Deterministic throughout (no `Math.random`, no wall-clock) so results are stable for snapshots/tests and reproducible across loads.

### 1. Workload metric — match the real route

`estimateWorkloadS(depot, stops, endPt)` gains an `endPt: Pt | null` argument:

- `endPt` = the point each courier returns to after its last stop, per end mode:
  - `home` → the depot (round trip)
  - `custom` → the saved end point
  - `last` → `null` (one-way, no return leg — current behaviour)
- The tour is a greedy nearest-neighbour order **improved by a bounded 2-opt pass**, then measured as: depot → stops (in tour order) → `endPt` (when non-null), converted to seconds at `URBAN_KMH`, plus `SERVICE_S` per stop.
- 2-opt makes the metric rank candidate splits the way the real Google/greedy routes will come out, rather than by a raw NN lower bound.

This is a comparable workload number, not a real route — the real per-group order is still produced later by `optimizeGroup` in `routing.service.ts` (Google when available, greedy otherwise).

### 2. Splitter — multi-seed construction + real inter-route local search

`sweepSplit<T>(depot, stops, couriers, endPt?)` keeps its generic signature (adds an optional `endPt` threaded from the caller; defaults to `null` = one-way, preserving current behaviour if a caller omits it). It now:

**a. Builds several seed partitions and keeps the best by the hybrid objective:**
   - **sweep** — the current angular-arc fill (kept as one seed).
   - **balanced k-means** — deterministic Lloyd's iteration seeded from N angularly-even centroids around the depot; assigns each stop to its nearest centroid, then rebalances oversized clusters. Produces geographic clusters, not pie slices → fixes problem 1.
   - **radial balance** — split by distance-from-depot bands as a cheap third seed for depot-centric spreads.

**b. Runs inter-route local search** over the best seed:
   - **relocate** — move one stop from any courier to any other courier when it lowers the hybrid objective.
   - **swap** — exchange one stop between any two couriers when it lowers the objective.
   - Both consider **all courier pairs**, not just adjacent arcs. Iterate best-improving moves until no move improves, capped at a fixed iteration budget (deterministic; ample for farm-scale N).

**c. Objective helper** `partitionCost(depot, groups, endPt)` returns `{ makespan, total }`; comparison is makespan first, then total (the hybrid). Used by both seed selection and local search.

### 3. Determinism

- No randomness: k-means centroids seed from angularly-even directions at a fixed radius; ties in assignment/moves break by stop index. Fixed traversal order for seeds, pairs, and moves.
- Same input → identical output.

## Edge cases

- `stops.length <= couriers` → each stop its own route (unchanged).
- `couriers === 1` → single group, no split (unchanged).
- Empty groups can result from relocate → kept as-is. `routing.service` expects `routes.length === couriers`; an empty route (zero stops) is valid and already handled downstream.
- Un-geocoded stops never enter the split — `routing.service` still appends them to the lightest route's tail (unchanged).
- No depot (`originPt === null`) → `sweepSplit` isn't called; `routing.service`'s existing round-robin-over-greedy-chain fallback stays.
- All stops co-located (zero distance) → balance falls back to service-time only; stable.
- `couriers > stops.length` → one stop per group, exactly `stops.length` groups, **no trailing empty routes** (`sweepSplit` returns `stops.map((s) => [s])` when `stops.length <= n`).

## Testing

New `server/src/modules/routing/route-split.spec.ts`:

- **Regression for the pie-slice bug:** two clusters east/west of a central depot, 2 couriers → each cluster assigned whole to one courier (not sliced). This is the headline fix.
- **Improvement vs. baseline:** a clustered input yields a lower makespan than the pure-sweep seed alone (assert the multi-seed + local-search result ≤ sweep-only).
- **Metric with `home` end:** a far cluster's workload rises when the return leg is counted vs. one-way.
- **Determinism:** same input twice → identical partition.
- **Property:** union of all groups equals the input, no stop lost or duplicated (by id).
- **Edge cases:** single stop, zero stops, `N === 1`, `N > stops`.

Existing routing service specs must stay green (public signature preserved).

## Non-goals

- No change to the day-based slots, the storefront pickers, or the Google per-group optimize step.
- No exact VRP solver — a bounded deterministic metaheuristic is right for farm-scale N.
- No new courier entities/names — couriers remain a count N (1–10), single depot.
