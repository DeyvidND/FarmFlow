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

/** Internal helpers exposed for unit tests only. Not part of the public API. */
export const __test = { partitionCost, betterCost };
