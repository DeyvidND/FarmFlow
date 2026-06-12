import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
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
  email: string | null;
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
  /** true once stops were reordered from DB arrival order (greedy or Google). */
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

/** Coords of a stop, or null when it isn't geocoded. */
export const ptOf = (s: RouteStop): Pt | null =>
  s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : null;

/**
 * The fixed point the route optimizes toward / is measured to:
 *  - `home`   → back to the depot (round trip).
 *  - `custom` → the saved end address (when geocoded), else loop fallback.
 *  - `last`   → null: one-way with no fixed end. computeRoutes can't optimize an
 *    open path, so the caller loops back to the depot as the best approximation.
 */
export function endPoint(mode: RouteEndMode, origin: Pt, end: RouteEnd): Pt | null {
  if (mode === 'custom' && end.lat != null && end.lng != null) {
    return { lat: end.lat, lng: end.lng };
  }
  if (mode === 'home') return origin;
  return null;
}

/**
 * Greedy nearest-neighbour ordering by straight-line distance. Starts from
 * `start` (the depot) when given, else from the first geocoded stop. Pure, no
 * API cost — used as the no-Google fallback for distance mode and to chain any
 * stops past the optimizer's per-request cap, so the order is always
 * distance-driven and never just the order rows came back from the DB.
 * Un-geocoded stops sort last.
 */
export function greedyByDistance(start: Pt | null, stops: RouteStop[]): RouteStop[] {
  const remaining = [...stops];
  const out: RouteStop[] = [];
  let cursor: Pt | null = start;
  while (remaining.length) {
    let best = 0;
    if (cursor) {
      let bestD = Infinity;
      remaining.forEach((g, k) => {
        const p = ptOf(g);
        if (!p) return;
        const d = haversineKm(cursor as Pt, p);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      });
    } else {
      // No depot: pick the first geocoded stop so un-geocoded stops don't
      // accidentally become the first route point just by being input[0].
      const firstGeo = remaining.findIndex((s) => ptOf(s) !== null);
      if (firstGeo !== -1) best = firstGeo;
    }
    const pick = remaining.splice(best, 1)[0];
    out.push(pick);
    cursor = ptOf(pick) ?? cursor;
  }
  return out;
}

/**
 * Merge two slot-ascending lists, the (geocoded) `located` stops winning ties
 * since they have a fixed map position. Keeps an un-geocoded stop near its
 * delivery slot instead of dumping it at the very end of the route. Null slots
 * (Infinity) sort last in both lists, so they still land at the tail.
 * Sorts both inputs internally so callers don't need to pre-sort.
 */
export function mergeBySlot(located: RouteStop[], unlocated: RouteStop[]): RouteStop[] {
  const loc = [...located].sort((a, b) => slotMinutes(a.slotFrom) - slotMinutes(b.slotFrom));
  const unloc = [...unlocated].sort((a, b) => slotMinutes(a.slotFrom) - slotMinutes(b.slotFrom));
  const out: RouteStop[] = [];
  let i = 0;
  let j = 0;
  while (i < loc.length && j < unloc.length) {
    if (slotMinutes(unloc[j].slotFrom) < slotMinutes(loc[i].slotFrom)) {
      out.push(unloc[j++]);
    } else {
      out.push(loc[i++]);
    }
  }
  while (i < loc.length) out.push(loc[i++]);
  while (j < unloc.length) out.push(unloc[j++]);
  return out;
}

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

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
        email: orders.customerEmail,
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
          // The route is "stops to DELIVER on this date" — key off the chosen
          // delivery slot's date, not when the order was placed. Orders with no
          // slot fall back to creation date so they still surface somewhere.
          // Both branches must share a type or Postgres rejects the COALESCE
          // ("text and date cannot be matched"). slot.date is `date` and bgDate()
          // yields `::date`, so compare as dates (the bound `day` text is cast).
          sql`coalesce(${deliverySlots.date}, ${bgDate(orders.createdAt)}) = ${day}`,
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
      email: r.email,
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
    const originPt: Pt | null = hasOrigin
      ? { lat: origin.lat as number, lng: origin.lng as number }
      : null;

    let orderedLocated: RouteStop[];
    if (orderMode === 'distance' && originPt && located.length) {
      // Shortest route: let Google optimize the visit order (ignores slot times),
      // targeting the REAL end point so a one-way / custom-end route isn't
      // optimized as a round trip.
      const cap = located.slice(0, MAX_OPTIMIZE_STOPS);
      const rest = located.slice(MAX_OPTIMIZE_STOPS);
      const dest = endPoint(mode, originPt, end);
      const plan = await this.maps.route(
        originPt,
        cap.map((s) => ({ lat: s.lat as number, lng: s.lng as number })),
        dest ?? undefined,
      );
      if (plan && plan.order.length === cap.length) {
        const head = plan.order.map((idx) => cap[idx]);
        // Stops beyond Google's per-request cap: greedily chain them from the
        // last optimized stop instead of leaving them in DB order.
        if (rest.length) {
          this.logger.warn(
            `Route has ${located.length} located stops; only the first ${MAX_OPTIMIZE_STOPS} ` +
              `are Google-optimized, the rest are ordered by nearest-neighbour heuristic.`,
          );
        }
        const tail = greedyByDistance(ptOf(head[head.length - 1]) ?? originPt, rest);
        orderedLocated = [...head, ...tail];
      } else {
        // Google disabled or the call failed: fall back to a greedy
        // nearest-neighbour order over ALL located stops. Keeps "shortest path"
        // meaningful (not DB order) so `optimized` stays honest.
        orderedLocated = greedyByDistance(originPt, located);
      }
    } else if (orderMode === 'distance' && located.length) {
      // distance mode but no farm origin set — greedy-order from the first stop.
      orderedLocated = greedyByDistance(null, located);
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

    // Slots mode: weave un-geocoded stops back to their slot position so an
    // early-window delivery with no pin isn't pushed to the end of the route.
    // Distance mode ignores slot times, so just append them (they can't be
    // distance-ordered without coords).
    const orderedStops =
      orderMode === 'slots'
        ? mergeBySlot(
            orderedLocated,
            [...unlocated].sort((a, b) => slotMinutes(a.slotFrom) - slotMinutes(b.slotFrom)),
          )
        : [...orderedLocated, ...unlocated];
    const optimized = orderedLocated.length > 0;

    // Real road distance/duration of the chosen order + end leg (no reordering).
    // Measured over EVERY located stop (chunked below), so totals don't
    // under-report when there are more than MAX_OPTIMIZE_STOPS stops.
    let totalDistanceM: number | null = null;
    let totalDurationS: number | null = null;
    if (originPt && orderedLocated.length) {
      const pts: Pt[] = [originPt];
      for (const s of orderedLocated) {
        const p = ptOf(s);
        if (p) pts.push(p);
      }
      if (mode !== 'last' && end.lat != null && end.lng != null) {
        pts.push({ lat: end.lat, lng: end.lng });
      }
      const total = await this.pathTotal(pts);
      if (total) {
        totalDistanceM = total.distanceM;
        totalDurationS = total.durationS;
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

  /**
   * Total road distance/duration along a FIXED point sequence, split into
   * ≤MAX_OPTIMIZE_STOPS-intermediate legs and summed. A short route (≤ the cap)
   * is a single Routes call — identical to the old behaviour; longer routes are
   * measured end-to-end instead of being truncated. Each leg's last node is the
   * next leg's origin. Returns null if any leg can't be computed (maps disabled
   * or an API error), so the UI shows "no estimate" rather than a partial total.
   */
  private async pathTotal(pts: Pt[]): Promise<{ distanceM: number; durationS: number } | null> {
    if (pts.length < 2) return null;
    const nodesPerLeg = MAX_OPTIMIZE_STOPS + 2; // origin + ≤25 intermediates + dest
    let distanceM = 0;
    let durationS = 0;
    let i = 0;
    while (i < pts.length - 1) {
      const seg = pts.slice(i, i + nodesPerLeg);
      const plan = await this.maps.routeFixed(seg);
      if (!plan) return null;
      distanceM += plan.distanceM;
      durationS += plan.durationS;
      i += seg.length - 1;
    }
    return { distanceM, durationS };
  }
}
