/**
 * Multi-courier stop partitioning. Pure math, no I/O — the caller feeds
 * geocoded stops and gets courier groups back, then optimizes each group's
 * visit order separately (Google / greedy — routing.service).
 *
 * Method: "sweep" — stops sorted by polar angle around the depot form a
 * circle; couriers get contiguous arcs. Arcs are cut to balance estimated
 * workload (drive time at urban speed + fixed service time per stop), then a
 * bounded local-improvement pass shifts border stops between neighbouring
 * arcs while the worst courier's workload keeps dropping. Deterministic.
 */

export type Pt = { lat: number; lng: number };

/** Straight-line distance (km). */
export function haversineKm(a: Pt, b: Pt): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
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

/** Max estimated workload across groups — the number balancing minimizes. */
function maxWorkload(depot: Pt, groups: Geo[][]): number {
  return Math.max(0, ...groups.map((g) => estimateWorkloadS(depot, g.map(pt))));
}

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

/**
 * Cut an angle-sorted circle of stops into `couriers` contiguous arcs,
 * balancing estimated workload. Tries every rotation of the cut start (up to
 * 24 evenly-spaced candidates) and keeps the best; then shifts border stops
 * between neighbouring arcs while the max workload drops (≤2 passes).
 */
export function sweepSplit<T extends Geo>(depot: Pt, stops: T[], couriers: number): T[][] {
  const n = Math.max(1, Math.floor(couriers));
  if (stops.length === 0) return [];
  if (n === 1 || stops.length <= n) {
    return n === 1 ? [stops.slice()] : stops.map((s) => [s]);
  }

  const sorted = [...stops].sort((a, b) => {
    const aa = Math.atan2((a.lat as number) - depot.lat, (a.lng as number) - depot.lng);
    const ab = Math.atan2((b.lat as number) - depot.lat, (b.lng as number) - depot.lng);
    return aa - ab || (a.lat as number) - (b.lat as number) || (a.lng as number) - (b.lng as number);
  });

  // Greedy arc fill for one rotation: walk the circle, close an arc once its
  // workload reaches the remaining average.
  const fill = (offset: number): T[][] => {
    const seq = [...sorted.slice(offset), ...sorted.slice(0, offset)];
    const total = estimateWorkloadS(depot, seq.map(pt));
    const groups: T[][] = [];
    let current: T[] = [];
    let used = 0;
    for (const s of seq) {
      const left = n - groups.length - 1; // arcs still to open after the current one
      current.push(s);
      const w = estimateWorkloadS(depot, current.map(pt));
      const target = (total - used) / (left + 1);
      // Close the arc when it met its share, but never leave more arcs than stops.
      const remainingStops = seq.length - seq.indexOf(s) - 1;
      if (left > 0 && w >= target && remainingStops >= left) {
        groups.push(current);
        used += w;
        current = [];
      }
    }
    if (current.length) groups.push(current);
    return groups;
  };

  const rotations = Math.min(sorted.length, 24);
  let best: T[][] | null = null;
  let bestScore = Infinity;
  for (let r = 0; r < rotations; r++) {
    const offset = Math.floor((r * sorted.length) / rotations);
    const g = fill(offset);
    const score = maxWorkload(depot, g);
    if (score < bestScore) {
      bestScore = score;
      best = g;
    }
  }
  let groups = best!;

  // Border improvement: move an edge stop to the neighbouring arc when that
  // lowers the max workload. Two passes keep it bounded and deterministic.
  for (let pass = 0; pass < 2; pass++) {
    let improved = false;
    for (let i = 0; i < groups.length - 1; i++) {
      const a = groups[i];
      const b = groups[i + 1];
      // last of a → front of b
      if (a.length > 1) {
        const cand = [...groups];
        cand[i] = a.slice(0, -1);
        cand[i + 1] = [a[a.length - 1], ...b];
        if (maxWorkload(depot, cand) < maxWorkload(depot, groups)) {
          groups = cand;
          improved = true;
          continue;
        }
      }
      // front of b → end of a
      if (b.length > 1) {
        const cand = [...groups];
        cand[i] = [...a, b[0]];
        cand[i + 1] = b.slice(1);
        if (maxWorkload(depot, cand) < maxWorkload(depot, groups)) {
          groups = cand;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return groups;
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
