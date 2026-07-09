import type { ReschedulableOrder } from '../orders/orders.service';
import { estimateRoute, type Pt } from './route-split';
import { suggestDayAssignment, type DaySpec } from './route-day-suggest';
import { harvestSummary, type HarvestLine } from '../orders/harvest-summary';

export interface SuggestedDayOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  lat: number | null;
  lng: number | null;
  totalStotinki: number;
}
/** One courier's route within a day: its stops + estimated distance/drive time. */
export interface RouteEstimate {
  stops: SuggestedDayOrder[];
  km: number;
  driveMinutes: number;
}
export interface SuggestedDay {
  date: string;
  /** Requested courier count for the day (may exceed routes.length if few orders). */
  couriers: number;
  routes: RouteEstimate[];
  /** The day is done when the slowest courier is — max route driveMinutes. */
  driveMinutesMakespan: number;
  totalKm: number;
  harvest: HarvestLine[];
  reason: string;
}
export interface UnplacedOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  totalStotinki: number;
}
export interface DaySuggestionResult {
  days: SuggestedDay[];
  unplaced: UnplacedOrder[];
}

const toNum = (v: string | null): number | null => (v == null ? null : Number(v));
const round1 = (n: number) => Math.round(n * 10) / 10;

/** 8-point compass in Bulgarian, indexed by `round(bearing / (π/4))` normalised
 *  to 0..7 where 0 = изток (east, +lng) and π/2 = север (north, +lat). */
const COMPASS_BG = ['изток', 'североизток', 'север', 'северозапад', 'запад', 'югозапад', 'юг', 'югоизток'];

/** A short human reason for a day's grouping: region (compass from the depot) +
 *  the proximity rationale. Generic fallback when there is no depot or no stops. */
function dayReason(depot: Pt | null, stops: { lat: number; lng: number }[]): string {
  if (!depot || stops.length === 0) return 'Съседни клиенти заедно — по-малко километри';
  const mean = stops.reduce((a, s) => ({ lat: a.lat + s.lat, lng: a.lng + s.lng }), { lat: 0, lng: 0 });
  const c = { lat: mean.lat / stops.length, lng: mean.lng / stops.length };
  const bearing = Math.atan2(c.lat - depot.lat, c.lng - depot.lng);
  const idx = (((Math.round(bearing / (Math.PI / 4)) % 8) + 8) % 8);
  return `Съседни клиенти в един район (${COMPASS_BG[idx]}) — най-малко каране`;
}

/**
 * Pure in-memory assembly of a day suggestion: capacity-weighted geography-first
 * day assignment (via {@link suggestDayAssignment}) plus, per day, its courier
 * routes with estimated distance/drive time (via {@link estimateRoute}), the
 * makespan + total km rollup, the harvest readout, a short reason, and the
 * un-geocoded → `unplaced` mapping. No DB — unit-testable without a database.
 */
export function assembleDaySuggestion(
  pool: ReschedulableOrder[],
  itemsByOrder: Map<string, { productName: string | null; quantity: number }[]>,
  depot: Pt | null,
  days: DaySpec[],
): DaySuggestionResult {
  const { assignment, unplaced } = suggestDayAssignment(
    pool.map((o) => ({ id: o.id, lat: toNum(o.deliveryLat), lng: toNum(o.deliveryLng) })),
    days,
    depot,
  );

  const byId = new Map(pool.map((o) => [o.id, o]));
  const capByDate = new Map(days.map((d) => [d.date, Math.max(1, Math.floor(d.couriers))]));

  const toStop = (o: ReschedulableOrder): SuggestedDayOrder => ({
    id: o.id,
    orderNumber: o.orderNumber,
    customerName: o.customerName,
    lat: toNum(o.deliveryLat),
    lng: toNum(o.deliveryLng),
    totalStotinki: o.totalStotinki,
  });

  const daysOut: SuggestedDay[] = Object.entries(assignment).map(([date, routeIdLists]) => {
    const routes: RouteEstimate[] = routeIdLists.map((ids) => {
      const stops = ids.map((id) => byId.get(id)!).filter(Boolean).map(toStop);
      const pts = stops
        .filter((s) => s.lat != null && s.lng != null)
        .map((s) => ({ lat: s.lat as number, lng: s.lng as number }));
      const est = depot != null ? estimateRoute(depot, pts, depot) : { km: 0, seconds: 0 };
      return { stops, km: round1(est.km), driveMinutes: Math.round(est.seconds / 60) };
    });

    const dayItems = routeIdLists.flat().flatMap((id) => itemsByOrder.get(id) ?? []);
    const allPts = routes
      .flatMap((r) => r.stops)
      .filter((s) => s.lat != null && s.lng != null)
      .map((s) => ({ lat: s.lat as number, lng: s.lng as number }));

    return {
      date,
      couriers: capByDate.get(date) ?? routes.length,
      routes,
      driveMinutesMakespan: routes.reduce((m, r) => Math.max(m, r.driveMinutes), 0),
      totalKm: round1(routes.reduce((s, r) => s + r.km, 0)),
      harvest: harvestSummary(dayItems),
      reason: dayReason(depot, allPts),
    };
  });

  const unplacedOut: UnplacedOrder[] = unplaced.map((id) => {
    const o = byId.get(id)!;
    return {
      id: o.id,
      orderNumber: o.orderNumber,
      customerName: o.customerName,
      totalStotinki: o.totalStotinki,
    };
  });

  return { days: daysOut, unplaced: unplacedOut };
}
