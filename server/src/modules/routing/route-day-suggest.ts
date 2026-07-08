import { sweepSplit, haversineKm, type Pt } from './route-split';

/** One order the suggester may place, with its (possibly missing) coords. */
export interface SuggestOrder {
  id: string;
  lat: number | null;
  lng: number | null;
}

/** Result: order ids per day, plus the un-geocoded ids we could not place. */
export interface DayAssignment {
  /** Keyed by every chosen day (empty array when a day gets no orders). */
  assignment: Record<string, string[]>;
  /** Ids of orders with no coordinates — never auto-placed. */
  unplaced: string[];
}

type Located = { id: string; lat: number; lng: number };

/** Mean lat/lng of the located orders — a stand-in depot when the farm has none. */
function centroid(pts: Located[]): Pt {
  const s = pts.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), { lat: 0, lng: 0 });
  return { lat: s.lat / pts.length, lng: s.lng / pts.length };
}

/** Mean lat/lng of a group of located orders. */
function groupCentroid(group: Located[]): Pt {
  return centroid(group);
}

/**
 * Geography-first assignment of `orders` onto `days`. Reuses `sweepSplit` to
 * partition the geocoded orders into `days.length` balanced geographic groups,
 * then maps groups onto days by a deterministic rule (nearest-to-depot group to
 * the earliest date). Un-geocoded orders go to `unplaced`. Pure & deterministic.
 */
export function suggestDayAssignment(
  orders: SuggestOrder[],
  days: string[],
  depot: Pt | null,
): DayAssignment {
  const sortedDays = [...days].sort(); // ISO dates sort chronologically
  const assignment: Record<string, string[]> = {};
  for (const d of sortedDays) assignment[d] = [];

  const located: Located[] = orders
    .filter((o): o is Located => o.lat != null && o.lng != null)
    .map((o) => ({ id: o.id, lat: o.lat as number, lng: o.lng as number }));
  const unplaced = orders.filter((o) => o.lat == null || o.lng == null).map((o) => o.id);

  if (sortedDays.length === 0 || located.length === 0) {
    return { assignment, unplaced };
  }

  const depotPt: Pt = depot ?? centroid(located);

  // Balanced geographic groups (one per day). endPt = depot → round-trip workload.
  const groups = sweepSplit(depotPt, located, sortedDays.length, depotPt);

  // Deterministic group → day: nearest-to-depot group first, then larger group
  // first, then by the group's lowest order id (final stable tiebreak).
  const ranked = groups
    .filter((g) => g.length > 0)
    .map((g) => ({
      g,
      dist: haversineKm(depotPt, groupCentroid(g)),
      size: g.length,
      minId: g.reduce((m, s) => (s.id < m ? s.id : m), g[0].id),
    }))
    .sort((a, b) => a.dist - b.dist || b.size - a.size || a.minId.localeCompare(b.minId));

  ranked.forEach((r, i) => {
    const day = sortedDays[Math.min(i, sortedDays.length - 1)];
    assignment[day].push(...r.g.map((s) => s.id));
  });

  return { assignment, unplaced };
}
