import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { type Database, orders, orderItems, deliverySlots, tenants } from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { MapsService } from '../../common/maps/maps.service';
import { bgToday, bgDate } from '../../common/time/bg-time';

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

export type RouteEndMode = 'home' | 'last' | 'custom';

/** slots = deliver by time window (11→12→13); distance = shortest route. */
export type RouteOrderMode = 'slots' | 'distance';

export interface RouteEnd {
  /** home = round trip to the depot, last = one-way, custom = a saved end point. */
  mode: RouteEndMode;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

export interface RouteResult {
  date: string;
  origin: RouteOrigin;
  stops: RouteStop[];
  /** Where the van goes after the last delivery. */
  end: RouteEnd;
  /** How stops were ordered (by time slot, or by shortest distance). */
  orderMode: RouteOrderMode;
  totalDistanceM: number | null;
  totalDurationS: number | null;
  /** true once stops were ordered. */
  optimized: boolean;
}

const toNum = (v: string | null): number | null => (v == null ? null : Number(v));

/** Routes API hard limit on intermediate waypoints per computeRoutes request. */
const MAX_OPTIMIZE_STOPS = 25;

type Pt = { lat: number; lng: number };

/** Slot start time (HH:MM[:SS]) → minutes since midnight; null slots sort last. */
function slotMinutes(t: string | null): number {
  if (!t) return Number.POSITIVE_INFINITY;
  const [h, m] = t.split(':');
  return Number(h) * 60 + Number(m);
}

/** Straight-line distance (km) — cheap ordering heuristic, no API cost. */
function haversineKm(a: Pt, b: Pt): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

@Injectable()
export class RoutingService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly maps: MapsService,
  ) {}

  /**
   * Delivery route for a date: confirmed address-orders as stops, starting from
   * the farm origin. When Google Maps is configured and both the farm and stops
   * are geocoded, stops are reordered into an optimized loop with total
   * distance/duration; otherwise they stay in arrival order with null totals.
   * No persistence.
   */
  async getRoute(
    tenantId: string,
    date?: string,
    endMode?: RouteEndMode,
    orderMode: RouteOrderMode = 'slots',
  ): Promise<RouteResult> {
    const day = date ?? bgToday();

    const [tenant] = await this.db
      .select({
        farmAddress: tenants.farmAddress,
        farmLat: tenants.farmLat,
        farmLng: tenants.farmLng,
        settings: tenants.settings,
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
          sql`${bgDate(orders.createdAt)} = ${day}`,
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

    // Where the van ends after the last delivery. Per-request `endMode` (?end=)
    // overrides the tenant's saved default in settings.routing.
    const routingCfg =
      ((tenant.settings as Record<string, any> | null)?.routing as Record<string, any>) ?? {};
    const mode: RouteEndMode = endMode ?? (routingCfg.endMode as RouteEndMode) ?? 'home';
    let end: RouteEnd;
    if (mode === 'home') {
      end = { mode, address: origin.address, lat: origin.lat, lng: origin.lng };
    } else if (mode === 'custom') {
      end = {
        mode,
        address: routingCfg.endAddress ?? null,
        lat: toNum(routingCfg.endLat ?? null),
        lng: toNum(routingCfg.endLng ?? null),
      };
    } else {
      end = { mode: 'last', address: null, lat: null, lng: null };
    }

    // Stops that can be routed (geocoded) vs not. Un-geocoded ones are appended
    // in arrival order so nothing is dropped.
    const located = stops.filter((s) => s.lat != null && s.lng != null);
    const unlocated = stops.filter((s) => s.lat == null || s.lng == null);
    const hasOrigin = origin.lat != null && origin.lng != null;

    let orderedLocated: RouteStop[];
    if (orderMode === 'distance' && hasOrigin && located.length) {
      // Shortest route: let Google optimize the visit order (ignores slot times).
      const cap = located.slice(0, MAX_OPTIMIZE_STOPS);
      const plan = await this.maps.route(
        { lat: origin.lat as number, lng: origin.lng as number },
        cap.map((s) => ({ lat: s.lat as number, lng: s.lng as number })),
      );
      const reordered =
        plan && plan.order.length === cap.length ? plan.order.map((idx) => cap[idx]) : cap;
      orderedLocated = [...reordered, ...located.slice(MAX_OPTIMIZE_STOPS)];
    } else {
      // Slots first (earlier delivery windows before later), greedy
      // nearest-neighbour within each slot group, continuing from the cursor.
      const bySlot = [...located].sort(
        (a, b) => slotMinutes(a.slotFrom) - slotMinutes(b.slotFrom),
      );
      orderedLocated = [];
      let cursor: Pt | null = hasOrigin
        ? { lat: origin.lat as number, lng: origin.lng as number }
        : null;
      let i = 0;
      while (i < bySlot.length) {
        const sm = slotMinutes(bySlot[i].slotFrom);
        const group: RouteStop[] = [];
        while (i < bySlot.length && slotMinutes(bySlot[i].slotFrom) === sm) group.push(bySlot[i++]);
        while (group.length) {
          let best = 0;
          if (cursor) {
            let bestD = Infinity;
            group.forEach((g, k) => {
              const d = haversineKm(cursor as Pt, { lat: g.lat as number, lng: g.lng as number });
              if (d < bestD) {
                bestD = d;
                best = k;
              }
            });
          }
          const pick = group.splice(best, 1)[0];
          orderedLocated.push(pick);
          cursor = { lat: pick.lat as number, lng: pick.lng as number };
        }
      }
    }

    const orderedStops = [...orderedLocated, ...unlocated];
    const optimized = orderedLocated.length > 0;

    // Real road distance/duration of the chosen order + end leg (no reordering).
    let totalDistanceM: number | null = null;
    let totalDurationS: number | null = null;
    if (hasOrigin && orderedLocated.length) {
      const capped = orderedLocated.slice(0, MAX_OPTIMIZE_STOPS);
      const pts: Pt[] = [
        { lat: origin.lat as number, lng: origin.lng as number },
        ...capped.map((s) => ({ lat: s.lat as number, lng: s.lng as number })),
      ];
      if (mode !== 'last' && end.lat != null && end.lng != null) {
        pts.push({ lat: end.lat, lng: end.lng });
      }
      const plan = await this.maps.routeFixed(pts);
      if (plan) {
        totalDistanceM = plan.distanceM;
        totalDurationS = plan.durationS;
      }
    }

    return {
      date: day,
      origin,
      stops: orderedStops,
      end,
      orderMode,
      totalDistanceM,
      totalDurationS,
      optimized,
    };
  }
}
