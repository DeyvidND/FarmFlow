/**
 * Multi-courier stop partitioning. Pure math, no I/O — the caller feeds
 * geocoded stops and gets courier groups back, then optimizes each group's
 * visit order separately (Google / greedy — routing.service).
 *
 * Pipeline: build three deterministic seed partitions — angular **sweep**
 * (Gillett-Miller pie slices), geographic **k-means** (keeps clusters whole),
 * and **radial** distance bands — score each by a hybrid cost (makespan of the
 * busiest courier, tie-broken on total workload) and keep the best, then refine
 * it with **inter-route local search** (relocate a stop to another courier, or
 * swap two stops between couriers) accepting only cost-lowering moves.
 *
 * Workload is estimated as drive time at urban speed + fixed service time per
 * stop. Candidate ranking during seed construction and local search uses a
 * cheap nearest-neighbour tour proxy (no 2-opt); the internal tour order is
 * only a balancing proxy — the real per-group visit order is produced later by
 * routing.service's optimizeGroup (Google or greedy). Deterministic throughout
 * (no Math.random, no wall-clock): same input → same output.
 */

export type Pt = { lat: number; lng: number };

/** Straight-line distance (km) between raw lat/lng pairs. Hot-path core: no
 * object allocation, so the O(N²) search loops can call it millions of times. */
function havLL(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Straight-line distance (km). */
export function haversineKm(a: Pt, b: Pt): number {
  return havLL(a.lat, a.lng, b.lat, b.lng);
}

const URBAN_KMH = 30; // pessimistic city driving speed for the estimate
const SERVICE_S = 300; // handover time per stop (park, ring, deliver)

const kmToS = (km: number) => (km / URBAN_KMH) * 3600;

type Geo = { lat: number | null; lng: number | null };
const pt = (s: Geo): Pt => ({ lat: s.lat as number, lng: s.lng as number });

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
 * Estimated route metrics for `stops` served from `depot`, returning to `endPt`
 * after the last stop (null = one-way). Greedy NN order, 2-opt improved, at
 * urban speed + fixed service time per stop. Pure. `estimateWorkloadS` is the
 * seconds half of this — kept as a thin wrapper so existing callers are unchanged.
 */
export function estimateRoute(
  depot: Pt,
  stops: Pt[],
  endPt: Pt | null = null,
): { km: number; seconds: number } {
  if (!stops.length) return { km: 0, seconds: 0 };
  const ordered = twoOpt(depot, nnOrder(depot, stops), endPt);
  const km = pathKm(depot, ordered, endPt);
  return { km, seconds: kmToS(km) + stops.length * SERVICE_S };
}

/**
 * Estimated seconds to serve `stops` from `depot`, returning to `endPt` after
 * the last stop (null = one-way, no return leg). Greedy NN order, 2-opt
 * improved, at urban speed + fixed service time per stop. A comparable
 * workload number for balancing — not the real route (that's built later).
 *
 * NOTE: the 2-opt pass makes this O(stops²) per pass × up to 30 passes. That is
 * fine for a one-off final measurement, but far too expensive to call inside
 * the O(N²)-candidate search loops. Those paths use `workloadNnS` instead —
 * see the module doc. This function is kept as a general-purpose 2-opt-improved
 * estimate (and its direct unit tests depend on that behaviour).
 */
export function estimateWorkloadS(depot: Pt, stops: Pt[], endPt: Pt | null = null): number {
  return estimateRoute(depot, stops, endPt).seconds;
}

/**
 * Cheap workload proxy: greedy NN order only, NO 2-opt. Used for candidate
 * ranking in seed construction and local search, where the same estimate is
 * computed O(N²) times per iteration and the 2-opt pass would dominate runtime
 * (measured: seconds vs milliseconds at N≈60, 10 couriers). The route order
 * here is never used as the real visit order — routing.service reorders each
 * group afterward — so a monotone workload proxy is all that's needed for
 * balancing. Deterministic (NN ties break by lowest index, same as `nnOrder`).
 *
 * Implemented over reused module-level scratch buffers so the hot search loops
 * allocate nothing per candidate — the whole splitter is single-threaded and
 * synchronous, so buffer reuse is safe (no reentrancy). The `workload*` family
 * fills the scratch from a "virtual" group (a group with one stop removed /
 * added / replaced) so a candidate relocate/swap is scored without ever
 * materialising the moved group.
 */
let scLat = new Float64Array(64);
let scLng = new Float64Array(64);
let scVis = new Uint8Array(64);
function ensureScratch(n: number): void {
  if (scLat.length < n) {
    const cap = Math.max(n, scLat.length * 2);
    scLat = new Float64Array(cap);
    scLng = new Float64Array(cap);
    scVis = new Uint8Array(cap);
  }
}

/** NN-tour workload over the `m` coords already loaded into scLat/scLng[0..m). */
function nnWorkloadScratch(depot: Pt, m: number, endPt: Pt | null): number {
  if (m === 0) return 0;
  for (let i = 0; i < m; i++) scVis[i] = 0;
  let curLat = depot.lat;
  let curLng = depot.lng;
  let km = 0;
  for (let step = 0; step < m; step++) {
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < m; j++) {
      if (scVis[j]) continue;
      const d = havLL(curLat, curLng, scLat[j], scLng[j]);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    scVis[best] = 1;
    km += bestD;
    curLat = scLat[best];
    curLng = scLng[best];
  }
  if (endPt) km += havLL(curLat, curLng, endPt.lat, endPt.lng);
  return kmToS(km) + m * SERVICE_S;
}

/** Workload of a group as-is. */
function workloadNnS(depot: Pt, g: Geo[], endPt: Pt | null): number {
  const len = g.length;
  ensureScratch(len);
  for (let i = 0; i < len; i++) {
    scLat[i] = g[i].lat as number;
    scLng[i] = g[i].lng as number;
  }
  return nnWorkloadScratch(depot, len, endPt);
}

/** Workload of `g` with the stop at index `skip` removed (order preserved). */
function workloadMinus(depot: Pt, g: Geo[], skip: number, endPt: Pt | null): number {
  const len = g.length;
  ensureScratch(len);
  let m = 0;
  for (let i = 0; i < len; i++) {
    if (i === skip) continue;
    scLat[m] = g[i].lat as number;
    scLng[m] = g[i].lng as number;
    m++;
  }
  return nnWorkloadScratch(depot, m, endPt);
}

/** Workload of `g` with `extra` appended (mirrors `[...g, extra]`). */
function workloadPlus(depot: Pt, g: Geo[], extra: Geo, endPt: Pt | null): number {
  const len = g.length;
  ensureScratch(len + 1);
  for (let i = 0; i < len; i++) {
    scLat[i] = g[i].lat as number;
    scLng[i] = g[i].lng as number;
  }
  scLat[len] = extra.lat as number;
  scLng[len] = extra.lng as number;
  return nnWorkloadScratch(depot, len + 1, endPt);
}

/** Workload of `g` with the stop at `idx` replaced by `repl` (order preserved). */
function workloadReplace(depot: Pt, g: Geo[], idx: number, repl: Geo, endPt: Pt | null): number {
  const len = g.length;
  ensureScratch(len);
  for (let i = 0; i < len; i++) {
    const s = i === idx ? repl : g[i];
    scLat[i] = s.lat as number;
    scLng[i] = s.lng as number;
  }
  return nnWorkloadScratch(depot, len, endPt);
}

type PartCost = { makespan: number; total: number };

/** Hybrid cost of a partition: makespan (busiest courier) + total workload. */
function partitionCost(depot: Pt, groups: Geo[][], endPt: Pt | null): PartCost {
  return costFromWorkloads(groups.map((g) => workloadNnS(depot, g, endPt)));
}

/** Hybrid cost derived from a per-group workload array (makespan + total). */
function costFromWorkloads(workloads: number[]): PartCost {
  let makespan = 0;
  let total = 0;
  for (const w of workloads) {
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

/**
 * Best-improving inter-route local search: repeatedly try moving one stop to
 * another courier (relocate) or exchanging one stop between two couriers
 * (swap), across ALL courier pairs, applying the single move that most lowers
 * the hybrid cost. Stops when no move improves, or after 60 iterations
 * (deterministic bound; ample for farm-scale N). Group count is preserved.
 */
function localSearch<T extends Geo>(depot: Pt, groups: T[][], endPt: Pt | null): T[][] {
  const cur = groups.map((g) => [...g]);
  // Cache each group's workload (indexed the same as `cur`). A relocate/swap
  // move only touches 1–2 groups, so scoring a candidate recomputes the
  // workload for just those two groups and reads the rest from this cache —
  // instead of re-running the workload estimate on every group every time.
  const work = cur.map((g) => workloadNnS(depot, g, endPt));
  let curCost = costFromWorkloads(work);
  const maxIters = 60;

  // Cost of the partition with groups gi/gj's workloads replaced by wi/wj.
  // O(groups), reading the cache for every untouched group.
  const costWith = (gi: number, wi: number, gj: number, wj: number): PartCost => {
    let makespan = 0;
    let total = 0;
    for (let i = 0; i < work.length; i++) {
      const w = i === gi ? wi : i === gj ? wj : work[i];
      if (w > makespan) makespan = w;
      total += w;
    }
    return { makespan, total };
  };

  for (let iter = 0; iter < maxIters; iter++) {
    let bestCost = curCost;
    // Move descriptor of the best improving move found this iteration, plus the
    // two new workloads it produces. Materialising the moved groups is deferred
    // until the move is chosen — candidates are scored over "virtual" groups.
    let bMove: 'rel' | 'swap' | null = null;
    let bGi = -1;
    let bGj = -1;
    let bSi = -1;
    let bSj = -1;
    let bWi = 0;
    let bWj = 0;

    // Relocate: stop si from group gi -> group gj (touches gi and gj only).
    for (let gi = 0; gi < cur.length; gi++) {
      for (let si = 0; si < cur[gi].length; si++) {
        // Source workload depends only on (gi, si) — compute once per stop,
        // not once per destination courier.
        const wi = workloadMinus(depot, cur[gi], si, endPt);
        const moved = cur[gi][si];
        for (let gj = 0; gj < cur.length; gj++) {
          if (gi === gj) continue;
          const wj = workloadPlus(depot, cur[gj], moved, endPt);
          const c = costWith(gi, wi, gj, wj);
          if (betterCost(c, bestCost)) {
            bestCost = c;
            bMove = 'rel';
            bGi = gi;
            bGj = gj;
            bSi = si;
            bWi = wi;
            bWj = wj;
          }
        }
      }
    }

    // Swap: stop si in gi <-> stop sj in gj (gi < gj; touches gi and gj only).
    for (let gi = 0; gi < cur.length; gi++) {
      for (let gj = gi + 1; gj < cur.length; gj++) {
        for (let si = 0; si < cur[gi].length; si++) {
          for (let sj = 0; sj < cur[gj].length; sj++) {
            const wi = workloadReplace(depot, cur[gi], si, cur[gj][sj], endPt);
            const wj = workloadReplace(depot, cur[gj], sj, cur[gi][si], endPt);
            const c = costWith(gi, wi, gj, wj);
            if (betterCost(c, bestCost)) {
              bestCost = c;
              bMove = 'swap';
              bGi = gi;
              bGj = gj;
              bSi = si;
              bSj = sj;
              bWi = wi;
              bWj = wj;
            }
          }
        }
      }
    }

    if (!bMove) break;

    // Apply the winning move: rebuild only the two touched groups.
    if (bMove === 'rel') {
      const moved = cur[bGi][bSi];
      cur[bGi] = cur[bGi].filter((_, k) => k !== bSi);
      cur[bGj] = [...cur[bGj], moved];
    } else {
      const a = cur[bGi][bSi];
      const b = cur[bGj][bSj];
      const gA = [...cur[bGi]];
      const gB = [...cur[bGj]];
      gA[bSi] = b;
      gB[bSj] = a;
      cur[bGi] = gA;
      cur[bGj] = gB;
    }
    work[bGi] = bWi;
    work[bGj] = bWj;
    curCost = bestCost;
  }

  return cur;
}

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
  // Defensive: no stops means no `best` fill below, and padGroups(best!, n)
  // would deref null. sweepSplit already guards this, but guard here too so the
  // seed is safe if ever called directly.
  if (stops.length === 0) return padGroups([], n);

  const sorted = [...stops].sort((a, b) => {
    const aa = Math.atan2((a.lat as number) - depot.lat, (a.lng as number) - depot.lng);
    const ab = Math.atan2((b.lat as number) - depot.lat, (b.lng as number) - depot.lng);
    return aa - ab || (a.lat as number) - (b.lat as number) || (a.lng as number) - (b.lng as number);
  });

  const fill = (offset: number): T[][] => {
    const seq = [...sorted.slice(offset), ...sorted.slice(0, offset)];
    const total = workloadNnS(depot, seq, endPt);
    const groups: T[][] = [];
    let current: T[] = [];
    let used = 0;
    seq.forEach((s, idx) => {
      const left = n - groups.length - 1;
      current.push(s);
      const w = workloadNnS(depot, current, endPt);
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

/** Internal helpers exposed for unit tests only. Not part of the public API. */
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
