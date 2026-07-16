import { and, eq, gte, isNull, lt, lte, or } from 'drizzle-orm';
import { orders, deliverySlots } from '@fermeribg/db';
import { bgAddDays, bgDayBounds } from '../../common/time/bg-time';

/**
 * Drizzle WHERE condition selecting orders "scheduled for" the BG calendar day
 * `day` (YYYY-MM-DD). A slotted (self-delivery) order belongs to the day of its
 * delivery SLOT — not the day it was placed — so a morning prep list / digest
 * lists the deliveries actually due that day regardless of when the customer
 * ordered (an order placed Monday for a Friday slot counts on Friday). Slotless
 * orders (market pickup, or an address order with no slot picked) have no
 * scheduled delivery date, so they fall back to their creation day.
 *
 * The query MUST leftJoin(deliverySlots, orders.slotId = deliverySlots.id) so
 * `deliverySlots.date` is available (and NULL for slotless orders).
 */
export function scheduledForDay(day: string) {
  const { from, to } = bgDayBounds(day); // index-served window for the slotless fallback
  return or(
    eq(deliverySlots.date, day),
    and(isNull(orders.slotId), gte(orders.createdAt, from), lt(orders.createdAt, to)),
  )!;
}

/**
 * Range variant of {@link scheduledForDay}. Selects orders "scheduled for" any
 * BG calendar day in [from, to] (inclusive). A slotted order counts on its slot
 * date; a slotless order falls back to its creation day. Same leftJoin
 * requirement as scheduledForDay.
 */
export function scheduledForRange(from: string, to: string) {
  const lo = bgDayBounds(from).from; // start of `from` day
  const hi = bgDayBounds(to).to; // end (exclusive) of `to` day
  return or(
    and(gte(deliverySlots.date, from), lte(deliverySlots.date, to)),
    and(isNull(orders.slotId), gte(orders.createdAt, lo), lt(orders.createdAt, hi)),
  )!;
}

/**
 * Pure day-picker behind «Подготовка»'s smart default: return `anchor` when it
 * has orders, else the NEAREST day within ±`span` that does, checking each
 * distance outward and preferring the FUTURE side on a tie (prep looks forward).
 * `hasOrders` is the set of BG days (YYYY-MM-DD) that have orders. No day in
 * range has any → `anchor` (caller shows the empty state). Extracted pure so the
 * nearest/tie-break rule is unit-tested without a DB.
 */
export function pickNearestDay(anchor: string, hasOrders: ReadonlySet<string>, span: number): string {
  if (hasOrders.has(anchor)) return anchor;
  for (let d = 1; d <= span; d++) {
    const up = bgAddDays(anchor, d);
    if (hasOrders.has(up)) return up;
    const down = bgAddDays(anchor, -d);
    if (hasOrders.has(down)) return down;
  }
  return anchor;
}
