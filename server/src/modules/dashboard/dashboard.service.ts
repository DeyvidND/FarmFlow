import { Injectable, Inject } from '@nestjs/common';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { type Database, orders, orderItems, deliverySlots, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { bgToday, bgDayBounds, bgAddDays } from '../../common/time/bg-time';

export interface DashboardSlot {
  id: string;
  timeFrom: string | null;
  timeTo: string | null;
  /** Live count of non-cancelled orders. Free while booked < capacity. */
  booked: number;
  capacity: number;
}

export interface DashboardSummary {
  date: string;
  orderCount: number;
  /** Today's order count minus yesterday's. */
  orderDelta: number;
  /** Product turnover for the day (non-cancelled) — delivery fees excluded. */
  revenueStotinki: number;
  /** Delivery fees collected today (order total − product lines), shown apart. */
  deliveryRevenueStotinki: number;
  pendingCount: number;
  /** First free (un-booked) active slot today, or null. */
  nextSlot: DashboardSlot | null;
  slots: DashboardSlot[];
  /** false → show the storefront "subscription inactive" banner; history limited to 7 days. */
  subscriptionActive: boolean;
}

@Injectable()
export class DashboardService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  /** Today's summary: counts, revenue (non-cancelled), pending, next free slot + slot list. */
  async summary(tenantId: string, date?: string): Promise<DashboardSummary> {
    const day = date ?? bgToday();
    // Index-served day windows (vs the non-sargable `::date` cast that scanned the
    // tenant's whole order history). today.from == prev.to by construction.
    const today = bgDayBounds(day);
    const prev = bgDayBounds(bgAddDays(day, -1));

    // The four reads are independent — run them concurrently (one hot per-load path).
    const aggP = this.db
      .select({
        orderCount: sql<number>`count(*)::int`,
        // Order total (incl. delivery) — split into turnover vs delivery below.
        totalStotinki: sql<number>`coalesce(sum(${orders.totalStotinki}) filter (where ${orders.status} <> 'cancelled'), 0)::int`,
        pendingCount: sql<number>`count(*) filter (where ${orders.status} = 'pending')::int`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          gte(orders.createdAt, today.from),
          lt(orders.createdAt, today.to),
        ),
      );

    // Product turnover for the day: line-item money only (no delivery fee). No
    // products join, so line items of since-deleted products still count.
    const productRevP = this.db
      .select({
        revenueStotinki: sql<number>`coalesce(sum(${orderItems.quantity} * ${orderItems.priceStotinki}) filter (where ${orders.status} <> 'cancelled'), 0)::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          gte(orders.createdAt, today.from),
          lt(orders.createdAt, today.to),
        ),
      );

    const yesterdayP = this.db
      .select({ yesterday: sql<number>`count(*)::int` })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          gte(orders.createdAt, prev.from),
          lt(orders.createdAt, prev.to),
        ),
      );

    const tenantP = this.db
      .select({ status: tenants.subscriptionStatus })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const slotRowsP = this.db
      .select({
        id: deliverySlots.id,
        timeFrom: deliverySlots.timeFrom,
        timeTo: deliverySlots.timeTo,
        capacity: deliverySlots.capacity,
        booked: sql<number>`count(${orders.id}) filter (where ${orders.status} <> 'cancelled')::int`,
      })
      .from(deliverySlots)
      .leftJoin(orders, eq(orders.slotId, deliverySlots.id))
      .where(
        and(
          eq(deliverySlots.tenantId, tenantId),
          sql`${deliverySlots.date} = ${day}`,
          eq(deliverySlots.isActive, true),
        )!,
      )
      .groupBy(deliverySlots.id, deliverySlots.date, deliverySlots.timeFrom, deliverySlots.timeTo, deliverySlots.capacity)
      .orderBy(deliverySlots.date, deliverySlots.timeFrom);

    const [[agg], [prod], [{ yesterday }], [tenant], slotRows] = await Promise.all([
      aggP,
      productRevP,
      yesterdayP,
      tenantP,
      slotRowsP,
    ]);

    const slots: DashboardSlot[] = slotRows.map((s) => ({
      id: s.id,
      timeFrom: s.timeFrom,
      timeTo: s.timeTo,
      booked: s.booked,
      capacity: s.capacity,
    }));

    return {
      date: day,
      orderCount: agg.orderCount,
      orderDelta: agg.orderCount - yesterday,
      revenueStotinki: prod.revenueStotinki,
      deliveryRevenueStotinki: Math.max(0, agg.totalStotinki - prod.revenueStotinki),
      pendingCount: agg.pendingCount,
      nextSlot: slots.find((s) => s.booked < s.capacity) ?? null,
      slots,
      subscriptionActive: tenant?.status !== 'inactive',
    };
  }
}
