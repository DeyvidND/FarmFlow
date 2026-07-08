import { sweepSplit, haversineKm, type Pt } from './route-split';

/** One order the suggester may place, with its (possibly missing) coords. */
export interface SuggestOrder {
  id: string;
  lat: number | null;
  lng: number | null;
}

/** A chosen delivery day and how many couriers run it. */
export interface DaySpec {
  date: string;
  /** Couriers for this day (int ≥ 1). More couriers ⇒ more orders that day. */
  couriers: number;
}

/** Result: per day, a list of courier routes (each a list of order ids); plus
 *  the un-geocoded ids we could not place. */
export interface DayAssignment {
  assignment: Record<string, string[][]>;
  unplaced: string[];
}

type Located = { id: string; lat: number; lng: number };

/** Mean lat/lng of the located orders — a stand-in depot when the farm has none. */
function centroid(pts: Located[]): Pt {
  const s = pts.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), { lat: 0, lng: 0 });
  return { lat: s.lat / pts.length, lng: s.lng / pts.length };
}

const capOf = (d: DaySpec) => Math.max(1, Math.floor(d.couriers));

/**
 * Geography-first, capacity-weighted assignment. Sorts the geocoded orders into a
 * bearing sweep around the depot, then hands each day (in date order) a CONTIGUOUS
 * arc whose order COUNT is proportional to its share of the total couriers — so a
 * day with more couriers gets more orders, by construction (not as an emergent
 * side effect). Each day's arc is then cut into that day's courier routes via
 * `sweepSplit` (used only WITHIN a day, since it balances route workload, not
 * count). Un-geocoded orders go to `unplaced`. Pure & deterministic.
 */
export function suggestDayAssignment(
  orders: SuggestOrder[],
  days: DaySpec[],
  depot: Pt | null,
): DayAssignment {
  const sortedDays = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const assignment: Record<string, string[][]> = {};
  for (const d of sortedDays) assignment[d.date] = [];

  const located: Located[] = orders
    .filter((o): o is Located => o.lat != null && o.lng != null)
    .map((o) => ({ id: o.id, lat: o.lat as number, lng: o.lng as number }));
  const unplaced = orders.filter((o) => o.lat == null || o.lng == null).map((o) => o.id);

  if (sortedDays.length === 0) {
    return { assignment: {}, unplaced: orders.map((o) => o.id) };
  }
  if (located.length === 0) {
    return { assignment, unplaced };
  }

  const depotPt: Pt = depot ?? centroid(located);
  const K = sortedDays.reduce((n, d) => n + capOf(d), 0);

  // Day-level split FIRST, capacity-weighted by order COUNT. Sort all located
  // orders into a bearing sweep around the depot; then give each day (date order)
  // a contiguous arc sized to its courier share. A running cumulative-courier
  // boundary (`round((cum/K) * total)`) yields an exact partition — no gap, no
  // overlap, last day ends at `total` — and guarantees a day with more couriers
  // gets more orders. `sweepSplit` balances by workload (drive time), NOT count,
  // so it is used only WITHIN each day to cut the arc into that day's routes.
  const swept = [...located].sort(
    (a, b) =>
      Math.atan2(a.lat - depotPt.lat, a.lng - depotPt.lng) -
        Math.atan2(b.lat - depotPt.lat, b.lng - depotPt.lng) ||
      haversineKm(depotPt, a) - haversineKm(depotPt, b) ||
      a.id.localeCompare(b.id),
  );

  const total = swept.length;
  let cum = 0;
  let start = 0;
  for (const d of sortedDays) {
    cum += capOf(d);
    const end = Math.round((cum / K) * total);
    const dayOrders = swept.slice(start, end);
    start = end;
    const routes = dayOrders.length ? sweepSplit(depotPt, dayOrders, capOf(d), depotPt) : [];
    assignment[d.date] = routes.map((g) => g.map((s) => s.id));
  }

  return { assignment, unplaced };
}
