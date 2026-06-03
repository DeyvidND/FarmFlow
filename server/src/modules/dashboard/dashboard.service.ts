import { Injectable, Inject } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { type Database, orders, deliverySlots, tenants } from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { bgToday, bgDate } from '../../common/time/bg-time';

export interface DashboardSlot {
  id: string;
  timeFrom: string;
  timeTo: string;
  maxOrders: number;
  booked: number;
}

export interface DashboardSummary {
  date: string;
  orderCount: number;
  /** Today's order count minus yesterday's. */
  orderDelta: number;
  revenueStotinki: number;
  pendingCount: number;
  /** First active slot today still under capacity, or null. */
  nextSlot: DashboardSlot | null;
  slots: DashboardSlot[];
  /** false → show the storefront "subscription inactive" banner; history limited to 7 days. */
  subscriptionActive: boolean;
}

@Injectable()
export class DashboardService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  /** Today's summary: counts, revenue (non-cancelled), pending, next slot + capacity bars. */
  async summary(tenantId: string, date?: string): Promise<DashboardSummary> {
    const day = date ?? bgToday();

    const [agg] = await this.db
      .select({
        orderCount: sql<number>`count(*)::int`,
        revenueStotinki: sql<number>`coalesce(sum(${orders.totalStotinki}) filter (where ${orders.status} <> 'cancelled'), 0)::int`,
        pendingCount: sql<number>`count(*) filter (where ${orders.status} = 'pending')::int`,
      })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), sql`${bgDate(orders.createdAt)} = ${day}`));

    const [{ yesterday }] = await this.db
      .select({ yesterday: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), sql`${bgDate(orders.createdAt)} = ${day}::date - 1`));

    const [tenant] = await this.db
      .select({ status: tenants.subscriptionStatus })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const slotRows = await this.db
      .select({
        id: deliverySlots.id,
        timeFrom: deliverySlots.timeFrom,
        timeTo: deliverySlots.timeTo,
        maxOrders: deliverySlots.maxOrders,
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
      .groupBy(
        deliverySlots.id,
        deliverySlots.timeFrom,
        deliverySlots.timeTo,
        deliverySlots.maxOrders,
      )
      .orderBy(deliverySlots.timeFrom);

    const slots: DashboardSlot[] = slotRows.map((s) => ({
      id: s.id,
      timeFrom: s.timeFrom,
      timeTo: s.timeTo,
      maxOrders: s.maxOrders,
      booked: s.booked,
    }));

    return {
      date: day,
      orderCount: agg.orderCount,
      orderDelta: agg.orderCount - yesterday,
      revenueStotinki: agg.revenueStotinki,
      pendingCount: agg.pendingCount,
      nextSlot: slots.find((s) => s.booked < s.maxOrders) ?? null,
      slots,
      subscriptionActive: tenant?.status !== 'inactive',
    };
  }
}
