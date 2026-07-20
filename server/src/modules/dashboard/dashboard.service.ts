import { Injectable, Inject } from '@nestjs/common';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  type Database, orders, orderItems, products, deliverySlots, tenants,
  orderFulfillments, handoverProtocols, routeCourierAssignments,
} from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { bgToday, bgDayBounds, bgAddDays } from '../../common/time/bg-time';
import { scheduledForDay } from '../orders/order-scheduling';

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

export interface TodayPipeline {
  new: number; confirmed: number; preparing: number;
  outForDelivery: number; delivered: number; cancelled: number;
  total: number; // active = all except cancelled
}

export interface TodaySummary {
  date: string;
  pipeline: TodayPipeline;
  prep: { ordersToPrep: number; fulfilled: number };
  route: { stops: number; delivered: number; pending: number; couriers: number };
  protocols: { total: number; signed: number; pending: number };
  cod: { toCollectStotinki: number; toCollectCount: number; collectedStotinki: number; collectedCount: number };
  revenueStotinki: number;
  slots: DashboardSlot[];
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

    const [[agg], [prod], [{ yesterday }], [tenant], slotRows] = await Promise.all([
      aggP,
      productRevP,
      yesterdayP,
      tenantP,
      this.slotsForDay(tenantId, day),
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

  /** Active slots for `day` with a live non-cancelled booked count. */
  private slotsForDay(tenantId: string, day: string) {
    return this.db
      .select({
        id: deliverySlots.id,
        timeFrom: deliverySlots.timeFrom,
        timeTo: deliverySlots.timeTo,
        capacity: deliverySlots.capacity,
        booked: sql<number>`count(${orders.id}) filter (where ${orders.status} <> 'cancelled')::int`,
      })
      .from(deliverySlots)
      .leftJoin(orders, eq(orders.slotId, deliverySlots.id))
      .where(and(eq(deliverySlots.tenantId, tenantId), sql`${deliverySlots.date} = ${day}`, eq(deliverySlots.isActive, true))!)
      .groupBy(deliverySlots.id, deliverySlots.date, deliverySlots.timeFrom, deliverySlots.timeTo, deliverySlots.capacity)
      .orderBy(deliverySlots.date, deliverySlots.timeFrom);
  }

  /** Delivery-day operations cockpit — one round of cheap grouped counts. */
  async todaySummary(tenantId: string, date?: string): Promise<TodaySummary> {
    const day = date ?? bgToday();
    const sched = scheduledForDay(day); // MUST pair with leftJoin(deliverySlots)

    const pipelineP = this.db
      .select({
        status: orders.status,
        count: sql<number>`count(*)::int`,
        totalStotinki: sql<number>`coalesce(sum(${orders.totalStotinki}), 0)::int`,
        addr: sql<number>`count(*) filter (where ${orders.deliveryType} = 'address')::int`,
      })
      .from(orders)
      .leftJoin(deliverySlots, eq(deliverySlots.id, orders.slotId))
      .where(and(eq(orders.tenantId, tenantId), sched))
      .groupBy(orders.status);

    const couriersP = this.db
      .select({ legIndex: routeCourierAssignments.legIndex })
      .from(routeCourierAssignments)
      .where(and(eq(routeCourierAssignments.tenantId, tenantId), eq(routeCourierAssignments.date, day)))
      .groupBy(routeCourierAssignments.legIndex);

    const CASH = sql`${orders.status} in ('confirmed','preparing','out_for_delivery','delivered')`;
    const codP = this.db
      .select({
        toCollectStotinki: sql<number>`coalesce(sum(${orders.totalStotinki}) filter (where ${orders.codOutcome} is null and ${CASH}), 0)::int`,
        toCollectCount:    sql<number>`count(*) filter (where ${orders.codOutcome} is null and ${CASH})::int`,
        collectedStotinki: sql<number>`coalesce(sum(${orders.totalStotinki}) filter (where ${orders.codOutcome} = 'received'), 0)::int`,
        collectedCount:    sql<number>`count(*) filter (where ${orders.codOutcome} = 'received')::int`,
      })
      .from(orders)
      .leftJoin(deliverySlots, eq(deliverySlots.id, orders.slotId))
      .where(and(eq(orders.tenantId, tenantId), eq(orders.paymentMethod, 'cod'), sched));

    // An order is "prepared" when every farmer-leg fulfillment row is 'fulfilled'.
    const fulfilledP = this.db
      .select({ orderId: orderFulfillments.orderId })
      .from(orderFulfillments)
      .innerJoin(orders, eq(orders.id, orderFulfillments.orderId))
      .leftJoin(deliverySlots, eq(deliverySlots.id, orders.slotId))
      .where(and(eq(orderFulfillments.tenantId, tenantId), inArray(orders.status, ['confirmed', 'preparing']), sched))
      .groupBy(orderFulfillments.orderId)
      .having(sql`bool_and(${orderFulfillments.state} = 'fulfilled')`);

    const signedP = this.db
      .select({ signed: sql<number>`count(*)::int` })
      .from(handoverProtocols)
      .innerJoin(deliverySlots, eq(deliverySlots.id, handoverProtocols.slotId))
      .where(and(eq(handoverProtocols.tenantId, tenantId), eq(deliverySlots.date, day), eq(handoverProtocols.status, 'signed')));

    // Distinct (farmer, slot) legs among handover-ready line items scheduled today.
    const farmerLegsP = this.db
      .select({ farmerId: products.farmerId, slotId: orders.slotId })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .leftJoin(deliverySlots, eq(deliverySlots.id, orders.slotId))
      .where(and(eq(orders.tenantId, tenantId), inArray(orders.status, ['confirmed', 'preparing']), sched))
      .groupBy(products.farmerId, orders.slotId);

    const customerLegsP = this.db
      .select({ customerLegs: sql<number>`count(*)::int` })
      .from(orders)
      .leftJoin(deliverySlots, eq(deliverySlots.id, orders.slotId))
      .where(and(eq(orders.tenantId, tenantId), eq(orders.deliveryType, 'address'), inArray(orders.status, ['confirmed', 'preparing']), sched));

    const [pipelineRows, courierRows, [cod], fulfilledRows, [signedRow], farmerLegRows, [custRow], slotRows] = await Promise.all([
      pipelineP, couriersP, codP, fulfilledP, signedP, farmerLegsP, customerLegsP, this.slotsForDay(tenantId, day),
    ]);

    const protoTotal = farmerLegRows.length + (custRow?.customerLegs ?? 0);
    const protoSigned = signedRow?.signed ?? 0;

    const by = (s: string) => pipelineRows.find((r) => r.status === s);
    const cnt = (s: string) => by(s)?.count ?? 0;
    const addr = (s: string) => by(s)?.addr ?? 0;
    const ACTIVE = ['pending', 'confirmed', 'preparing', 'out_for_delivery', 'delivered'] as const;

    const pipeline: TodayPipeline = {
      new: cnt('pending'), confirmed: cnt('confirmed'), preparing: cnt('preparing'),
      outForDelivery: cnt('out_for_delivery'), delivered: cnt('delivered'), cancelled: cnt('cancelled'),
      total: ACTIVE.reduce((a, s) => a + cnt(s), 0),
    };
    const revenueStotinki = pipelineRows
      .filter((r) => r.status !== 'cancelled')
      .reduce((a, r) => a + r.totalStotinki, 0);
    const routeStops = ACTIVE.reduce((a, s) => a + addr(s), 0);
    const routeDelivered = addr('delivered');
    const slots: DashboardSlot[] = slotRows.map((s) => ({
      id: s.id, timeFrom: s.timeFrom, timeTo: s.timeTo, booked: s.booked, capacity: s.capacity,
    }));

    return {
      date: day,
      pipeline,
      prep: { ordersToPrep: pipeline.confirmed + pipeline.preparing, fulfilled: fulfilledRows.length },
      route: { stops: routeStops, delivered: routeDelivered, pending: routeStops - routeDelivered, couriers: courierRows.length },
      protocols: { total: protoTotal, signed: protoSigned, pending: Math.max(0, protoTotal - protoSigned) },
      cod: cod ?? { toCollectStotinki: 0, toCollectCount: 0, collectedStotinki: 0, collectedCount: 0 },
      revenueStotinki,
      slots,
    };
  }
}
