/**
 * Human-readable visit-order smoothing.
 *
 * Google's Routes optimizer (`optimizeWaypointOrder`) minimises DRIVE TIME. That
 * is mathematically right but can read as wrong to a person: it will happily
 * deliver a stop the van drives straight past LAST if doing so shaves even a few
 * seconds off the road time (a slightly faster one-way street, a lucky turn
 * phase). The human eye judges a route by crow-flies BACKTRACKING — "why did I
 * skip that house and come back for it later?" — not by seconds.
 *
 * This pass re-sorts an already-optimised order to minimise straight-line
 * (Haversine) path length instead of road time. Seeded from Google's order, a
 * 2-opt + or-opt local search only makes small local fixes: it pulls a
 * driven-past stop back into travel sequence and un-crosses the odd crossing,
 * without throwing away Google's globally-good structure. Pure + deterministic
 * (no I/O, no clock, no randomness): same input → same output.
 *
 * The caller re-measures the reordered path's real road distance/time and can
 * revert if the prettier order costs too much (a river/highway the crow-flies
 * metric can't see) — this function only proposes the readable order.
 */
import { haversineKm, type Pt } from './route-split';

/** Sum of straight-line legs along start? → ordered pts → end? (fixed ends). */
function pathLen(start: Pt | null, pts: Pt[], end: Pt | null, order: number[]): number {
  let d = 0;
  let prev: Pt | null = start;
  for (const idx of order) {
    const cur = pts[idx];
    if (prev) d += haversineKm(prev, cur);
    prev = cur;
  }
  if (prev && end) d += haversineKm(prev, end);
  return d;
}

/**
 * Reorder `stops` (already ordered by a real optimizer) to minimise crow-flies
 * backtracking, keeping the depot `start` fixed at the front and `end` fixed at
 * the back (`end` = the depot for a round trip, a custom end point, or `null`
 * for a one-way route whose last stop is free). Stops with no coordinates, or
 * fewer than two stops, are returned untouched — there's nothing to reason about
 * geographically. Returns a NEW array; never mutates the input.
 */
export function humanizeStopOrder<T>(
  start: Pt | null,
  stops: T[],
  end: Pt | null,
  ptOf: (s: T) => Pt | null,
): T[] {
  if (stops.length < 2) return stops.slice();
  const pts = stops.map(ptOf);
  // Can't place an un-geocoded stop geographically — leave the order alone.
  if (pts.some((p) => p == null)) return stops.slice();
  const P = pts as Pt[];

  const order = stops.map((_, i) => i);
  const len = (ord: number[]) => pathLen(start, P, end, ord);
  // Strictly-improving moves only; the epsilon rejects float-noise "improvements"
  // so equal-length reshuffles don't churn (and the loop always terminates).
  const EPS = 1e-9;

  let improved = true;
  let guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    const base = len(order);

    // 2-opt: reverse a sub-run to undo a crossing.
    for (let i = 0; i < order.length - 1 && !improved; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const cand = order
          .slice(0, i)
          .concat(order.slice(i, j + 1).reverse(), order.slice(j + 1));
        if (len(cand) + EPS < base) {
          order.splice(0, order.length, ...cand);
          improved = true;
          break;
        }
      }
    }
    if (improved) continue;

    // or-opt: relocate a run of 1..3 stops to a better gap — this is what pulls a
    // driven-past stop out of "last" and back into the sequence it belongs to.
    for (let L = 1; L <= 3 && !improved; L++) {
      for (let p = 0; p + L <= order.length && !improved; p++) {
        const seg = order.slice(p, p + L);
        const rest = order.slice(0, p).concat(order.slice(p + L));
        for (let q = 0; q <= rest.length; q++) {
          if (q === p) continue; // reinserting at the same spot is a no-op
          const cand = rest.slice(0, q).concat(seg, rest.slice(q));
          if (len(cand) + EPS < base) {
            order.splice(0, order.length, ...cand);
            improved = true;
            break;
          }
        }
      }
    }
  }

  return order.map((i) => stops[i]);
}
