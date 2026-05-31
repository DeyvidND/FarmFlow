import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { type Database, orders, orderItems, deliverySlots, tenants } from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

export interface RouteOrigin {
  address: string | null;
  lat: number | null;
  lng: number | null;
}

export interface RouteStop {
  id: string;
  customer: string | null;
  phone: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  summary: string;
  slotFrom: string | null;
  slotTo: string | null;
}

export interface RouteResult {
  date: string;
  origin: RouteOrigin;
  stops: RouteStop[];
  totalDistanceM: number | null;
  totalDurationS: number | null;
  /** Always false: stops are returned in arrival sequence (no external optimizer). */
  optimized: boolean;
}

const toNum = (v: string | null): number | null => (v == null ? null : Number(v));

@Injectable()
export class RoutingService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  /**
   * Delivery route for a date: confirmed address-orders as stops, starting from
   * the farm origin. Stops are returned in arrival order; distance/duration are
   * not computed (no external maps dependency). No persistence.
   */
  async getRoute(tenantId: string, date?: string): Promise<RouteResult> {
    const day = date ?? new Date().toISOString().slice(0, 10);

    const [tenant] = await this.db
      .select({
        farmAddress: tenants.farmAddress,
        farmLat: tenants.farmLat,
        farmLng: tenants.farmLng,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundException('Фермата не е намерена');

    const rows = await this.db
      .select({
        id: orders.id,
        customer: orders.customerName,
        phone: orders.customerPhone,
        address: orders.deliveryAddress,
        lat: orders.deliveryLat,
        lng: orders.deliveryLng,
        slotFrom: deliverySlots.timeFrom,
        slotTo: deliverySlots.timeTo,
      })
      .from(orders)
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.status, 'confirmed'),
          eq(orders.deliveryType, 'address'),
          sql`${orders.createdAt}::date = ${day}`,
        )!,
      )
      .orderBy(orders.createdAt);

    // Batch item summaries (no N+1).
    const ids = rows.map((r) => r.id);
    const itemsByOrder = new Map<string, string[]>();
    if (ids.length) {
      const items = await this.db
        .select({
          orderId: orderItems.orderId,
          productName: orderItems.productName,
          quantity: orderItems.quantity,
        })
        .from(orderItems)
        .where(inArray(orderItems.orderId, ids));
      for (const it of items) {
        const list = itemsByOrder.get(it.orderId!) ?? [];
        list.push(`${it.productName} × ${it.quantity}`);
        itemsByOrder.set(it.orderId!, list);
      }
    }

    const stops: RouteStop[] = rows.map((r) => ({
      id: r.id,
      customer: r.customer,
      phone: r.phone,
      address: r.address,
      lat: toNum(r.lat),
      lng: toNum(r.lng),
      summary: (itemsByOrder.get(r.id) ?? []).join(', '),
      slotFrom: r.slotFrom,
      slotTo: r.slotTo,
    }));

    const origin: RouteOrigin = {
      address: tenant.farmAddress,
      lat: toNum(tenant.farmLat),
      lng: toNum(tenant.farmLng),
    };

    return { date: day, origin, stops, totalDistanceM: null, totalDurationS: null, optimized: false };
  }
}
