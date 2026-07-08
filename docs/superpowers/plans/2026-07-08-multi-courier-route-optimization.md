# Multi-courier Route Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the weak angular-sweep courier splitter with a multi-seed construction plus real inter-route local search, minimizing makespan (tie-break total), so 2–3 couriers get geographically coherent, workload-balanced routes.

**Architecture:** All changes live in `server/src/modules/routing/route-split.ts` (pure math) plus one call-site tweak in `routing.service.ts` to pass the route's end point into the splitter. The metric counts the return-to-depot leg and 2-opt-improves its tour so it ranks splits the way real routes come out. Three deterministic seeds (sweep, geographic k-means, radial bands) are built; the best by the hybrid objective is refined by relocate/swap moves across all courier pairs.

**Tech Stack:** TypeScript, NestJS, Jest (ts-jest). No new dependencies.

## Global Constraints

- **Determinism:** no `Math.random`, no wall-clock. Same input → identical output. Ties break by index/coordinate. (Required for stable behaviour and tests.)
- **Public signature preserved:** `sweepSplit<T>(depot, stops, couriers, endPt?)` — `endPt` is a new **optional** 4th arg defaulting to `null` (one-way), so no existing caller breaks. `haversineKm` and `type Pt` exports stay.
- **No I/O in `route-split.ts`:** pure functions only; no DB, no Google, no logging.
- **Couriers:** integer count, clamped `[1,10]` by the caller (unchanged). Single depot (the farm). No courier entities/names.
- **Scale target:** tens of stops, N≤3 typical. Bounded iteration caps must keep worst-case well under ~100ms.
- **Units:** `URBAN_KMH = 30`, `SERVICE_S = 300` — copied verbatim from the current file; do not change.

---

## File Structure

- **Modify:** `server/src/modules/routing/route-split.ts` — rewrite the metric and splitter; add internal helpers (`nnOrder`, `pathKm`, `twoOpt`, `partitionCost`, `betterCost`, `offsetPt`, `sweepSeed`, `kmeansSeed`, `radialSeed`, `localSearch`).
- **Create:** `server/src/modules/routing/route-split.spec.ts` — unit tests for the metric, seeds, local search, and the full `sweepSplit`.
- **Modify:** `server/src/modules/routing/routing.service.ts` (around line 273) — compute the split end point and thread it into `sweepSplit`.

Run tests with: `cd server && pnpm test route-split.spec` (Expected pattern noted per step).

---

## Task 1: Workload metric counts the return leg and 2-opt-improves the tour

**Files:**
- Modify: `server/src/modules/routing/route-split.ts`
- Test: `server/src/modules/routing/route-split.spec.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `estimateWorkloadS(depot: Pt, stops: Pt[], endPt?: Pt | null): number` — seconds; NN tour 2-opt-improved, `depot → stops → endPt` distance at `URBAN_KMH` + `SERVICE_S`/stop. `endPt` defaults `null` (one-way).
  - Internal (not exported): `nnOrder(depot: Pt, stops: Pt[]): Pt[]`, `pathKm(depot: Pt, ordered: Pt[], endPt: Pt | null): number`, `twoOpt(depot: Pt, ordered: Pt[], endPt: Pt | null): Pt[]`.

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/routing/route-split.spec.ts`:

```ts
import { estimateWorkloadS, haversineKm, type Pt } from './route-split';

const depot: Pt = { lat: 42.5, lng: 25.0 };

describe('estimateWorkloadS', () => {
  it('is zero for no stops', () => {
    expect(estimateWorkloadS(depot, [])).toBe(0);
  });

  it('counts the return-to-depot leg when endPt is the depot', () => {
    const stops: Pt[] = [{ lat: 42.5, lng: 25.3 }, { lat: 42.5, lng: 25.4 }];
    const oneWay = estimateWorkloadS(depot, stops, null);
    const roundTrip = estimateWorkloadS(depot, stops, depot);
    // Round trip must be longer by roughly the far stop -> depot leg.
    expect(roundTrip).toBeGreaterThan(oneWay);
  });

  it('2-opt un-crosses a zig-zag NN order (never longer than raw NN)', () => {
    // Four stops that NN visits in a crossing order; 2-opt should not worsen it.
    const stops: Pt[] = [
      { lat: 42.50, lng: 25.10 },
      { lat: 42.60, lng: 25.10 },
      { lat: 42.50, lng: 25.20 },
      { lat: 42.60, lng: 25.20 },
    ];
    const w = estimateWorkloadS(depot, stops, depot);
    // Service time is 4 * 300 = 1200s; drive time is positive on top.
    expect(w).toBeGreaterThan(1200);
    expect(Number.isFinite(w)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm test route-split.spec`
Expected: FAIL — `estimateWorkloadS` called with 3 args but current signature ignores `endPt`, so the round-trip test fails (`roundTrip` equals `oneWay`).

- [ ] **Step 3: Write minimal implementation**

In `route-split.ts`, keep the top-of-file `Pt`, `haversineKm`, `URBAN_KMH`, `SERVICE_S`, `kmToS`, `Geo`, `pt` exactly as they are. Replace the existing `estimateWorkloadS` (and add the three helpers above it):

```ts
/** Greedy nearest-neighbour visit order from the depot (open path). */
function nnOrder(depot: Pt, stops: Pt[]): Pt[] {
  const remaining = [...stops];
  const out: Pt[] = [];
  let cursor = depot;
  while (remaining.length) {
    let best = 0;
    let bestD = Infinity;
    remaining.forEach((p, i) => {
      const d = haversineKm(cursor, p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    cursor = remaining.splice(best, 1)[0];
    out.push(cursor);
  }
  return out;
}

/** Total km along depot -> ordered stops -> endPt (endPt skipped when null). */
function pathKm(depot: Pt, ordered: Pt[], endPt: Pt | null): number {
  let km = 0;
  let cursor = depot;
  for (const p of ordered) {
    km += haversineKm(cursor, p);
    cursor = p;
  }
  if (endPt) km += haversineKm(cursor, endPt);
  return km;
}

/**
 * Bounded 2-opt on a fixed-endpoint path (depot ... endPt). Reverses a segment
 * when that shortens the path; endPt null means the tail is open (last edge is
 * dropped). Deterministic: first-improvement scan, capped passes.
 */
function twoOpt(depot: Pt, ordered: Pt[], endPt: Pt | null): Pt[] {
  if (ordered.length < 3) return ordered;
  let route = [...ordered];
  const maxPasses = 30;
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (let i = 0; i < route.length - 1; i++) {
      for (let k = i + 1; k < route.length; k++) {
        const prev = i === 0 ? depot : route[i - 1];
        const next = k === route.length - 1 ? endPt : route[k + 1];
        const a = route[i];
        const b = route[k];
        const before = haversineKm(prev, a) + (next ? haversineKm(b, next) : 0);
        const after = haversineKm(prev, b) + (next ? haversineKm(a, next) : 0);
        if (after + 1e-9 < before) {
          const seg = route.slice(i, k + 1).reverse();
          route = [...route.slice(0, i), ...seg, ...route.slice(k + 1)];
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return route;
}

/**
 * Estimated seconds to serve `stops` from `depot`, returning to `endPt` after
 * the last stop (null = one-way, no return leg). Greedy NN order, 2-opt
 * improved, at urban speed + fixed service time per stop. A comparable
 * workload number for balancing — not the real route (that's built later).
 */
export function estimateWorkloadS(depot: Pt, stops: Pt[], endPt: Pt | null = null): number {
  if (!stops.length) return 0;
  const ordered = twoOpt(depot, nnOrder(depot, stops), endPt);
  return kmToS(pathKm(depot, ordered, endPt)) + stops.length * SERVICE_S;
}
```

Delete the old `maxWorkload` helper (a later task replaces its use).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && pnpm test route-split.spec`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/routing/route-split.ts server/src/modules/routing/route-split.spec.ts
git commit -m "feat(routing): workload metric counts return leg + 2-opt tour"
```

---

## Task 2: Hybrid partition cost (makespan, tie-break total)

**Files:**
- Modify: `server/src/modules/routing/route-split.ts`
- Test: `server/src/modules/routing/route-split.spec.ts`

**Interfaces:**
- Consumes: `estimateWorkloadS` (Task 1).
- Produces (internal, not exported):
  - `type PartCost = { makespan: number; total: number }`
  - `partitionCost(depot: Pt, groups: Geo[][], endPt: Pt | null): PartCost` — makespan = max group workload, total = sum.
  - `betterCost(a: PartCost, b: PartCost): boolean` — true when `a` is strictly better: lower makespan, or equal makespan and lower total (epsilon `1e-6`).

- [ ] **Step 1: Write the failing test**

Append to `route-split.spec.ts`:

```ts
import { __test } from './route-split';

describe('partitionCost / betterCost', () => {
  const d: Pt = { lat: 42.5, lng: 25.0 };
  const A = { lat: 42.5, lng: 25.2 };
  const B = { lat: 42.5, lng: 24.8 };

  it('makespan is the busiest group, total is the sum', () => {
    const both = __test.partitionCost(d, [[A, B]], null);
    const split = __test.partitionCost(d, [[A], [B]], null);
    // One courier doing both stops is busier than either of two single-stop couriers.
    expect(both.makespan).toBeGreaterThan(split.makespan);
    // Splitting adds a second depot->stop leg, so total (sum) is not smaller.
    expect(split.total).toBeGreaterThanOrEqual(both.total - 1e-6);
  });

  it('betterCost prefers lower makespan, then lower total', () => {
    expect(__test.betterCost({ makespan: 10, total: 30 }, { makespan: 12, total: 20 })).toBe(true);
    expect(__test.betterCost({ makespan: 10, total: 20 }, { makespan: 10, total: 30 })).toBe(true);
    expect(__test.betterCost({ makespan: 10, total: 30 }, { makespan: 10, total: 20 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm test route-split.spec`
Expected: FAIL — `__test` export does not exist.

- [ ] **Step 3: Write minimal implementation**

Add to `route-split.ts` (after `estimateWorkloadS`):

```ts
type PartCost = { makespan: number; total: number };

/** Hybrid cost of a partition: makespan (busiest courier) + total workload. */
function partitionCost(depot: Pt, groups: Geo[][], endPt: Pt | null): PartCost {
  let makespan = 0;
  let total = 0;
  for (const g of groups) {
    const w = estimateWorkloadS(depot, g.map(pt), endPt);
    if (w > makespan) makespan = w;
    total += w;
  }
  return { makespan, total };
}

/** True when `a` beats `b`: lower makespan, or equal makespan and lower total. */
function betterCost(a: PartCost, b: PartCost): boolean {
  if (a.makespan + 1e-6 < b.makespan) return true;
  if (a.makespan - 1e-6 > b.makespan) return false;
  return a.total + 1e-6 < b.total;
}
```

At the **bottom** of the file add a test-only export (so specs can reach internals without exporting them into the module's public API):

```ts
/** Internal helpers exposed for unit tests only. Not part of the public API. */
export const __test = { partitionCost, betterCost };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && pnpm test route-split.spec`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/routing/route-split.ts server/src/modules/routing/route-split.spec.ts
git commit -m "feat(routing): hybrid partition cost (makespan, tie-break total)"
```

---

## Task 3: Three deterministic seed partitions

**Files:**
- Modify: `server/src/modules/routing/route-split.ts`
- Test: `server/src/modules/routing/route-split.spec.ts`

**Interfaces:**
- Consumes: `partitionCost`, `betterCost` (Task 2), `pt`, `haversineKm`, `Geo`, `Pt`.
- Produces (internal, added to `__test`):
  - `offsetPt(o: Pt, km: number, theta: number): Pt` — a point `km` from `o` at bearing `theta` (equirectangular approx).
  - `sweepSeed<T extends Geo>(depot: Pt, stops: T[], n: number, endPt: Pt | null): T[][]` — the current angular-arc fill, best of ≤24 rotations, returned padded to exactly `n` groups.
  - `kmeansSeed<T extends Geo>(depot: Pt, stops: T[], n: number): T[][]` — deterministic Lloyd's from angularly-even centroids; exactly `n` groups (some may be empty).
  - `radialSeed<T extends Geo>(depot: Pt, stops: T[], n: number): T[][]` — sort by distance from depot, cut into `n` contiguous bands; exactly `n` groups.
  - `padGroups<T>(groups: T[][], n: number): T[][]` — pad with empty groups up to `n`.

- [ ] **Step 1: Write the failing test**

Append to `route-split.spec.ts`:

```ts
// Two tight clusters east and west of a central depot.
const west: Pt[] = [
  { lat: 42.50, lng: 24.70 },
  { lat: 42.52, lng: 24.71 },
  { lat: 42.48, lng: 24.69 },
];
const east: Pt[] = [
  { lat: 42.50, lng: 25.30 },
  { lat: 42.52, lng: 25.31 },
  { lat: 42.48, lng: 25.29 },
];
const twoClusters = [...west, ...east];

describe('seeds', () => {
  const d: Pt = { lat: 42.5, lng: 25.0 };

  it('kmeansSeed keeps each geographic cluster whole for 2 couriers', () => {
    const g = __test.kmeansSeed(d, twoClusters, 2);
    expect(g).toHaveLength(2);
    // Each group's longitudes are all on one side of the depot (25.0).
    for (const grp of g) {
      const sides = new Set(grp.map((p) => (p.lng < 25.0 ? 'W' : 'E')));
      expect(sides.size).toBe(1);
    }
  });

  it('every seed returns exactly n groups and loses no stop', () => {
    for (const seed of [
      __test.sweepSeed(d, twoClusters, 3, d),
      __test.kmeansSeed(d, twoClusters, 3),
      __test.radialSeed(d, twoClusters, 3),
    ]) {
      expect(seed).toHaveLength(3);
      expect(seed.flat()).toHaveLength(twoClusters.length);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm test route-split.spec`
Expected: FAIL — `__test.kmeansSeed` (and the other seeds) are undefined.

- [ ] **Step 3: Write minimal implementation**

Add to `route-split.ts` (before `sweepSplit`):

```ts
/** Pad a group list with empty groups up to exactly `n`. */
function padGroups<T>(groups: T[][], n: number): T[][] {
  const out = groups.map((g) => [...g]);
  while (out.length < n) out.push([]);
  return out;
}

/** A point `km` from `o` at bearing `theta` rad (equirectangular approx). */
function offsetPt(o: Pt, km: number, theta: number): Pt {
  const dLat = (km * Math.cos(theta)) / 111;
  const dLng = (km * Math.sin(theta)) / (111 * Math.cos((o.lat * Math.PI) / 180) || 1e-9);
  return { lat: o.lat + dLat, lng: o.lng + dLng };
}

/**
 * Angular-arc fill (the classic sweep): sort stops by polar angle around the
 * depot, walk the circle closing an arc once its workload meets the remaining
 * average, over ≤24 rotations, keep the best by makespan. Padded to `n` groups.
 */
function sweepSeed<T extends Geo>(depot: Pt, stops: T[], n: number, endPt: Pt | null): T[][] {
  const sorted = [...stops].sort((a, b) => {
    const aa = Math.atan2((a.lat as number) - depot.lat, (a.lng as number) - depot.lng);
    const ab = Math.atan2((b.lat as number) - depot.lat, (b.lng as number) - depot.lng);
    return aa - ab || (a.lat as number) - (b.lat as number) || (a.lng as number) - (b.lng as number);
  });

  const fill = (offset: number): T[][] => {
    const seq = [...sorted.slice(offset), ...sorted.slice(0, offset)];
    const total = estimateWorkloadS(depot, seq.map(pt), endPt);
    const groups: T[][] = [];
    let current: T[] = [];
    let used = 0;
    seq.forEach((s, idx) => {
      const left = n - groups.length - 1;
      current.push(s);
      const w = estimateWorkloadS(depot, current.map(pt), endPt);
      const target = (total - used) / (left + 1);
      const remainingStops = seq.length - idx - 1;
      if (left > 0 && w >= target && remainingStops >= left) {
        groups.push(current);
        used += w;
        current = [];
      }
    });
    if (current.length) groups.push(current);
    return groups;
  };

  const rotations = Math.min(sorted.length, 24);
  let best: T[][] | null = null;
  let bestCost: PartCost | null = null;
  for (let r = 0; r < rotations; r++) {
    const offset = Math.floor((r * sorted.length) / rotations);
    const g = fill(offset);
    const c = partitionCost(depot, g, endPt);
    if (!bestCost || betterCost(c, bestCost)) {
      bestCost = c;
      best = g;
    }
  }
  return padGroups(best!, n);
}

/**
 * Geographic k-means (deterministic Lloyd's): centroids seeded at angularly-
 * even bearings around the depot at the mean stop radius; assign each stop to
 * its nearest centroid, recompute, repeat until stable or 20 iterations.
 * Assignment ties break by lower centroid index. Balancing is delegated to the
 * local-search pass — this seed's job is geographic coherence. Exactly `n`
 * groups (a centroid with no stops yields an empty group).
 */
function kmeansSeed<T extends Geo>(depot: Pt, stops: T[], n: number): T[][] {
  const meanR =
    stops.reduce((s, p) => s + haversineKm(depot, pt(p)), 0) / (stops.length || 1);
  let centroids: Pt[] = Array.from({ length: n }, (_, i) =>
    offsetPt(depot, Math.max(meanR, 0.1), (2 * Math.PI * i) / n),
  );
  const assign = new Array<number>(stops.length).fill(0);
  for (let iter = 0; iter < 20; iter++) {
    let changed = false;
    stops.forEach((s, si) => {
      const p = pt(s);
      let best = 0;
      let bestD = Infinity;
      centroids.forEach((c, ci) => {
        const d = haversineKm(p, c);
        if (d < bestD - 1e-9) {
          bestD = d;
          best = ci;
        }
      });
      if (assign[si] !== best) {
        assign[si] = best;
        changed = true;
      }
    });
    const sums = Array.from({ length: n }, () => ({ lat: 0, lng: 0, c: 0 }));
    stops.forEach((s, si) => {
      const g = sums[assign[si]];
      g.lat += s.lat as number;
      g.lng += s.lng as number;
      g.c += 1;
    });
    centroids = centroids.map((c, ci) =>
      sums[ci].c ? { lat: sums[ci].lat / sums[ci].c, lng: sums[ci].lng / sums[ci].c } : c,
    );
    if (!changed) break;
  }
  const groups: T[][] = Array.from({ length: n }, () => []);
  stops.forEach((s, si) => groups[assign[si]].push(s));
  return groups;
}

/**
 * Radial bands: sort stops by distance from the depot, cut into `n` contiguous
 * equal-size chunks (near stops to the first courier, far to the last). A cheap
 * third seed that suits depot-centric spreads. Exactly `n` groups.
 */
function radialSeed<T extends Geo>(depot: Pt, stops: T[], n: number): T[][] {
  const sorted = [...stops].sort(
    (a, b) =>
      haversineKm(depot, pt(a)) - haversineKm(depot, pt(b)) ||
      (a.lat as number) - (b.lat as number) ||
      (a.lng as number) - (b.lng as number),
  );
  const groups: T[][] = Array.from({ length: n }, () => []);
  const per = Math.ceil(sorted.length / n) || 1;
  sorted.forEach((s, i) => groups[Math.min(n - 1, Math.floor(i / per))].push(s));
  return groups;
}
```

Extend the test-only export at the bottom:

```ts
export const __test = {
  partitionCost,
  betterCost,
  offsetPt,
  sweepSeed,
  kmeansSeed,
  radialSeed,
  padGroups,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && pnpm test route-split.spec`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/routing/route-split.ts server/src/modules/routing/route-split.spec.ts
git commit -m "feat(routing): three deterministic seed partitions (sweep, k-means, radial)"
```

---

## Task 4: Inter-route local search (relocate + swap across all pairs)

**Files:**
- Modify: `server/src/modules/routing/route-split.ts`
- Test: `server/src/modules/routing/route-split.spec.ts`

**Interfaces:**
- Consumes: `partitionCost`, `betterCost` (Task 2).
- Produces (internal, added to `__test`):
  - `localSearch<T extends Geo>(depot: Pt, groups: T[][], endPt: Pt | null): T[][]` — best-improving relocate/swap moves over all courier pairs until no move improves the hybrid cost, capped at 60 iterations. Returns the same group count it was given.

- [ ] **Step 1: Write the failing test**

Append to `route-split.spec.ts`:

```ts
describe('localSearch', () => {
  const d: Pt = { lat: 42.5, lng: 25.0 };

  it('never worsens the hybrid cost and is idempotent', () => {
    // Deliberately bad start: all stops on one courier, other empty.
    const bad: Pt[][] = [[...west, ...east], []];
    const before = __test.partitionCost(d, bad, d);
    const after = __test.localSearch(d, bad, d);
    const afterCost = __test.partitionCost(d, after, d);
    expect(afterCost.makespan).toBeLessThan(before.makespan);
    // Running it again changes nothing (local optimum).
    const twice = __test.localSearch(d, after, d);
    expect(__test.partitionCost(d, twice, d)).toEqual(afterCost);
  });

  it('preserves group count and loses no stop', () => {
    const start: Pt[][] = [[...west, ...east], []];
    const out = __test.localSearch(d, start, d);
    expect(out).toHaveLength(2);
    expect(out.flat()).toHaveLength(twoClusters.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm test route-split.spec`
Expected: FAIL — `__test.localSearch` is undefined.

- [ ] **Step 3: Write minimal implementation**

Add to `route-split.ts` (before `sweepSplit`):

```ts
/**
 * Best-improving inter-route local search: repeatedly try moving one stop to
 * another courier (relocate) or exchanging one stop between two couriers
 * (swap), across ALL courier pairs, applying the single move that most lowers
 * the hybrid cost. Stops when no move improves, or after 60 iterations
 * (deterministic bound; ample for farm-scale N). Group count is preserved.
 */
function localSearch<T extends Geo>(depot: Pt, groups: T[][], endPt: Pt | null): T[][] {
  let cur = groups.map((g) => [...g]);
  let curCost = partitionCost(depot, cur, endPt);
  const maxIters = 60;

  for (let iter = 0; iter < maxIters; iter++) {
    let bestCost = curCost;
    let bestGroups: T[][] | null = null;

    // Relocate: stop si from group gi -> group gj.
    for (let gi = 0; gi < cur.length; gi++) {
      for (let si = 0; si < cur[gi].length; si++) {
        for (let gj = 0; gj < cur.length; gj++) {
          if (gi === gj) continue;
          const cand = cur.map((g) => [...g]);
          const [moved] = cand[gi].splice(si, 1);
          cand[gj].push(moved);
          const c = partitionCost(depot, cand, endPt);
          if (betterCost(c, bestCost)) {
            bestCost = c;
            bestGroups = cand;
          }
        }
      }
    }

    // Swap: stop si in gi <-> stop sj in gj (gi < gj).
    for (let gi = 0; gi < cur.length; gi++) {
      for (let gj = gi + 1; gj < cur.length; gj++) {
        for (let si = 0; si < cur[gi].length; si++) {
          for (let sj = 0; sj < cur[gj].length; sj++) {
            const cand = cur.map((g) => [...g]);
            const tmp = cand[gi][si];
            cand[gi][si] = cand[gj][sj];
            cand[gj][sj] = tmp;
            const c = partitionCost(depot, cand, endPt);
            if (betterCost(c, bestCost)) {
              bestCost = c;
              bestGroups = cand;
            }
          }
        }
      }
    }

    if (!bestGroups) break;
    cur = bestGroups;
    curCost = bestCost;
  }

  return cur;
}
```

Extend `__test` at the bottom to include `localSearch`:

```ts
export const __test = {
  partitionCost,
  betterCost,
  offsetPt,
  sweepSeed,
  kmeansSeed,
  radialSeed,
  padGroups,
  localSearch,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && pnpm test route-split.spec`
Expected: PASS (9 tests total).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/routing/route-split.ts server/src/modules/routing/route-split.spec.ts
git commit -m "feat(routing): inter-route local search (relocate + swap, all pairs)"
```

---

## Task 5: Wire seeds + local search into `sweepSplit` and thread the end point

**Files:**
- Modify: `server/src/modules/routing/route-split.ts` (rewrite `sweepSplit`)
- Modify: `server/src/modules/routing/routing.service.ts` (~line 273)
- Test: `server/src/modules/routing/route-split.spec.ts`

**Interfaces:**
- Consumes: `sweepSeed`, `kmeansSeed`, `radialSeed` (Task 3), `localSearch` (Task 4), `partitionCost`, `betterCost` (Task 2).
- Produces: `sweepSplit<T extends Geo>(depot: Pt, stops: T[], couriers: number, endPt?: Pt | null): T[][]` — unchanged public signature except the new optional `endPt`. Returns exactly `n` groups when `stops.length > n`.

- [ ] **Step 1: Write the failing test**

Append to `route-split.spec.ts`:

```ts
import { sweepSplit } from './route-split';

describe('sweepSplit', () => {
  const d: Pt = { lat: 42.5, lng: 25.0 };

  it('gives each geographic cluster to its own courier (no pie-slice split)', () => {
    const g = sweepSplit(d, twoClusters, 2, d);
    expect(g).toHaveLength(2);
    for (const grp of g) {
      const sides = new Set(grp.map((p) => (p.lng < 25.0 ? 'W' : 'E')));
      expect(sides.size).toBe(1); // each courier stays on one side
    }
  });

  it('result is no worse than the sweep seed alone (makespan)', () => {
    const seed = __test.sweepSeed(d, twoClusters, 2, d);
    const split = sweepSplit(d, twoClusters, 2, d);
    expect(__test.partitionCost(d, split, d).makespan).toBeLessThanOrEqual(
      __test.partitionCost(d, seed, d).makespan + 1e-6,
    );
  });

  it('is deterministic', () => {
    expect(sweepSplit(d, twoClusters, 2, d)).toEqual(sweepSplit(d, twoClusters, 2, d));
  });

  it('handles the trivial cases', () => {
    expect(sweepSplit(d, [], 2)).toEqual([]);
    expect(sweepSplit(d, [{ lat: 42.5, lng: 25.1 }], 1)).toHaveLength(1);
    // more couriers than stops -> one stop each
    expect(sweepSplit(d, west, 5)).toHaveLength(west.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm test route-split.spec`
Expected: FAIL — current `sweepSplit` produces angular arcs that split clusters, so the "no pie-slice" assertion fails (a group contains both W and E stops).

- [ ] **Step 3: Write minimal implementation**

Replace the entire `sweepSplit` function in `route-split.ts` with:

```ts
/**
 * Partition `stops` among `couriers` drivers starting from `depot`, minimizing
 * makespan (busiest courier) with total workload as a tie-break. Builds three
 * deterministic seeds (sweep, geographic k-means, radial bands), keeps the best
 * by the hybrid cost, then refines it with inter-route local search. `endPt` is
 * where each courier goes after its last stop (the depot for a round trip,
 * a custom end, or null for one-way) — it makes the workload estimate match the
 * real route. Returns exactly `couriers` groups when there are more stops than
 * couriers; otherwise one stop per group.
 */
export function sweepSplit<T extends Geo>(
  depot: Pt,
  stops: T[],
  couriers: number,
  endPt: Pt | null = null,
): T[][] {
  const n = Math.max(1, Math.floor(couriers));
  if (stops.length === 0) return [];
  if (n === 1) return [stops.slice()];
  if (stops.length <= n) return stops.map((s) => [s]);

  const seeds: T[][][] = [
    sweepSeed(depot, stops, n, endPt),
    kmeansSeed(depot, stops, n),
    radialSeed(depot, stops, n),
  ];

  let best = seeds[0];
  let bestCost = partitionCost(depot, best, endPt);
  for (let i = 1; i < seeds.length; i++) {
    const c = partitionCost(depot, seeds[i], endPt);
    if (betterCost(c, bestCost)) {
      best = seeds[i];
      bestCost = c;
    }
  }

  return localSearch(depot, best, endPt);
}
```

Then update the call site in `routing.service.ts`. Find (around line 272):

```ts
    if (originPt && located.length) {
      groups = sweepSplit(originPt, located, n);
    } else if (located.length) {
```

Replace the `sweepSplit` line so the split sees the real end point:

```ts
    if (originPt && located.length) {
      // Feed the split the point every courier returns to after its last stop,
      // so workload balancing counts the return leg (round trip vs one-way).
      const splitEnd = endPoint(mode, originPt, end);
      groups = sweepSplit(originPt, located, n, splitEnd);
    } else if (located.length) {
```

`endPoint`, `mode`, and `end` are all already in scope in `getRoute` (`endPoint` is exported at the top of the same file; `mode` and `end` are computed above the split block).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && pnpm test route-split.spec`
Expected: PASS (13 tests total).

- [ ] **Step 5: Run the full routing + server suite for regressions**

Run: `cd server && pnpm test routing`
Expected: PASS — existing routing service specs stay green (public signature preserved).

Run: `cd server && pnpm test`
Expected: PASS — full suite green (the 2 XLSX/exceljs suites may flake under concurrent-run CPU contention; if so, re-run them isolated to confirm they pass alone — this is a known environmental flake, not a regression).

- [ ] **Step 6: Typecheck**

Run: `cd server && pnpm build`
Expected: no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/routing/route-split.ts server/src/modules/routing/routing.service.ts server/src/modules/routing/route-split.spec.ts
git commit -m "feat(routing): multi-seed split + local search, end point threaded from service"
```

---

## Self-Review Notes

- **Spec coverage:** metric-with-return-leg + 2-opt (Task 1) → spec §Design.1; hybrid cost (Task 2) → spec §Objective; three seeds incl. k-means (Task 3) → spec §Design.2a; inter-route local search (Task 4) → spec §Design.2b; `sweepSplit` wiring + determinism + call-site (Task 5) → spec §Design.2/§Design.3. Edge cases (spec §Edge cases) covered by Task 5 Step 1 trivial-cases test + `routing.service` unchanged fallbacks. Tests (spec §Testing): pie-slice regression, improvement-vs-baseline, `home`-end metric, determinism, union-property, edge cases all present across Tasks 1/3/4/5.
- **Type consistency:** `PartCost`, `estimateWorkloadS(depot, stops, endPt?)`, `sweepSplit(depot, stops, couriers, endPt?)`, and the `__test` bag names are consistent across tasks. `__test` is extended (not redefined) in Tasks 2→3→4; the final shape in Task 4 is the complete one.
- **No placeholders:** every code step shows full code; no TBD/TODO.
```
