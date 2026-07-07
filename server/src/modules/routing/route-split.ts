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

/**
 * Estimated seconds to serve `stops` from `depot`: greedy nearest-neighbour
 * tour (depot → stops, one-way) + fixed service time per stop. Not a real
 * route — just a comparable workload number for balancing.
 */
export function estimateWorkloadS(depot: Pt, stops: Pt[]): number {
  if (!stops.length) return 0;
  const remaining = [...stops];
  let cursor = depot;
  let km = 0;
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
    km += bestD;
    cursor = remaining.splice(best, 1)[0];
  }
  return kmToS(km) + stops.length * SERVICE_S;
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
