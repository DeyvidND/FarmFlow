import { and, eq, gte, isNull, lt, or } from 'drizzle-orm';
import { orders, deliverySlots } from '@fermeribg/db';
import { bgDayBounds } from '../../common/time/bg-time';

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
