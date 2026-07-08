import type { ReschedulableOrder } from '../orders/orders.service';
import { haversineKm, type Pt } from './route-split';
import { suggestDayAssignment } from './route-day-suggest';
import { harvestSummary, type HarvestLine } from '../orders/harvest-summary';

export interface SuggestedDayOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  lat: number | null;
  lng: number | null;
  totalStotinki: number;
}
export interface SuggestedDay {
  date: string;
  orders: SuggestedDayOrder[];
  harvest: HarvestLine[];
  /** Sum of straight-line depot→stop km — a rough "how spread" hint, not a route length. */
  spreadKm: number;
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

/**
 * Pure in-memory assembly of a day suggestion: geography-first day assignment
 * (via {@link suggestDayAssignment}) plus the per-day orders/harvest/spreadKm
 * readout and the un-geocoded → `unplaced` mapping. Extracted out of
 * `RoutingService.suggestDays` (which does the DB reads) so this money- and
 * geo-shaped logic can be unit-tested without a database.
 */
export function assembleDaySuggestion(
  pool: ReschedulableOrder[],
  itemsByOrder: Map<string, { productName: string | null; quantity: number }[]>,
  depot: Pt | null,
  days: string[],
): DaySuggestionResult {
  const { assignment, unplaced } = suggestDayAssignment(
    pool.map((o) => ({ id: o.id, lat: toNum(o.deliveryLat), lng: toNum(o.deliveryLng) })),
    days,
    depot,
  );

  const byId = new Map(pool.map((o) => [o.id, o]));

  const daysOut: SuggestedDay[] = Object.entries(assignment).map(([date, ids]) => {
    const dayOrders = ids.map((id) => byId.get(id)!).filter(Boolean);
    const dayItems = ids.flatMap((id) => itemsByOrder.get(id) ?? []);
    const spreadKm =
      depot == null
        ? 0
        : dayOrders.reduce((sum, o) => {
            const lat = toNum(o.deliveryLat);
            const lng = toNum(o.deliveryLng);
            return lat != null && lng != null ? sum + haversineKm(depot, { lat, lng }) : sum;
          }, 0);
    return {
      date,
      orders: dayOrders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        customerName: o.customerName,
        lat: toNum(o.deliveryLat),
        lng: toNum(o.deliveryLng),
        totalStotinki: o.totalStotinki,
      })),
      harvest: harvestSummary(dayItems),
      spreadKm: Math.round(spreadKm * 10) / 10,
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
