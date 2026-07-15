/**
 * Pure helper for the route page's pin-caused-imbalance hint.
 *
 * Audit follow-up: manual per-order courier pins (drag an order onto a
 * courier) completely bypass the geographic balancing algorithm — a courier
 * with a lot of pinned work can still end up receiving an even share of the
 * remaining free (auto-assigned) stops on top, producing a lopsided day (a
 * real case showed one courier at ~5h and another at ~1h). The server-side
 * fix (route-split.ts's baseWorkloads) compensates for this going forward,
 * but pins are an intentional override — a farmer can still create a genuine
 * imbalance on purpose. This helper decides when it's worth telling them why
 * a lopsided split isn't just "the algorithm being bad at geography".
 */

/** The subset of a route stop this helper needs: whether it's pinned. */
export interface ImbalanceStop {
  /** Operator's manual courier pin — non-null means this stop is pinned. */
  courierIndex: number | null;
}

/** The subset of a courier's route this helper needs. */
export interface ImbalanceRoute {
  stops: ImbalanceStop[];
  totalDurationS: number | null;
}

/** Busiest-vs-least-busy ratio (among couriers with free stops) that counts
 *  as a meaningful imbalance worth explaining. */
const IMBALANCE_RATIO = 1.8;
/** Below this many total stops (summed across the compared couriers) any
 *  ratio is just noise — not worth an inline hint on a tiny day. */
const MIN_TOTAL_STOPS = 6;
/** Rough per-stop time (seconds) used only when a courier has no measured
 *  totalDurationS yet (e.g. maps disabled) — a stop-count proxy. */
const FALLBACK_PER_STOP_S = 600;

/** A courier's workload estimate: measured drive+service time when known,
 *  else a stop-count proxy. */
function workload(r: ImbalanceRoute): number {
  return r.totalDurationS ?? r.stops.length * FALLBACK_PER_STOP_S;
}

/**
 * True when today's split is meaningfully imbalanced AND at least one stop is
 * pinned — the two conditions under which the „ръчно зададени куриери" hint
 * should show. Comparison is restricted to couriers who received at least one
 * FREE (unpinned) stop: a courier with only pinned stops legitimately may
 * have very few of them, and that's not an imbalance the free-stop splitter
 * could have done anything about.
 */
export function hasPinCausedImbalance(routes: ImbalanceRoute[]): boolean {
  const anyPinned = routes.some((r) => r.stops.some((s) => s.courierIndex != null));
  if (!anyPinned) return false;

  const withFree = routes.filter((r) => r.stops.some((s) => s.courierIndex == null));
  if (withFree.length < 2) return false;

  const totalStops = withFree.reduce((sum, r) => sum + r.stops.length, 0);
  if (totalStops < MIN_TOTAL_STOPS) return false;

  const workloads = withFree.map(workload);
  const max = Math.max(...workloads);
  const min = Math.min(...workloads);
  if (min <= 0) return max > 0;
  return max >= min * IMBALANCE_RATIO;
}
