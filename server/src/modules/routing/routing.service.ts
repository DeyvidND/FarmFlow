import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { type Database, orders, orderItems, deliverySlots, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { MapsService } from '../../common/maps/maps.service';
import { bgToday } from '../../common/time/bg-time';
import { scheduledForDay } from '../orders/order-scheduling';
import { sweepSplit, haversineKm, type Pt } from './route-split';
import { humanizeStopOrder } from './route-humanize';
import { OrdersService } from '../orders/orders.service';
import {
  assembleDaySuggestion,
  type SuggestedDayOrder,
  type SuggestedDay,
  type UnplacedOrder,
  type DaySuggestionResult,
} from './route-day-assemble';

// Re-exported so existing importers of these result shapes from this module
// keep working — the types themselves now live alongside the pure assembly
// logic in route-day-assemble.ts (see assembleDaySuggestion).
export type { SuggestedDayOrder, SuggestedDay, UnplacedOrder, DaySuggestionResult };

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
  /** Block/entrance/floor/flat detail for the driver (бл./вх.). */
  note: string | null;
  lat: number | null;
  lng: number | null;
  summary: string;
}

export type RouteEndMode = 'home' | 'last' | 'custom';

export interface RouteEnd {
  /** home = round trip to the depot, last = one-way, custom = a saved end point. */
  mode: RouteEndMode;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

export interface CourierRoute {
  stops: RouteStop[];
  totalDistanceM: number | null;
  totalDurationS: number | null;
  /** true once stops were reordered from DB arrival order (greedy or Google). */
  optimized: boolean;
  /**
   * Encoded road-geometry legs (one per ≤25-stop Routes chunk) for the visit
   * order origin→stops→end. The client decodes + draws these so the route line
   * follows streets. null when maps are disabled or no geometry was returned
   * (client then falls back to straight segments between pins).
   */
  polyline: string[] | null;
  /** This courier's own end mode: home = loop back to the depot, last = end at
   *  the last stop. Set per leg from the per-courier ends. */
  endMode: RouteEndMode;
}

export interface MultiRouteResult {
  date: string;
  origin: RouteOrigin;
  /** Where every van goes after its last delivery — shared across couriers. */
  end: RouteEnd;
  /** Effective courier count (== routes.length). */
  couriers: number;
  routes: CourierRoute[];
}

const toNum = (v: string | null): number | null => (v == null ? null : Number(v));

/** Routes API hard limit on intermediate waypoints per computeRoutes request. */
const MAX_OPTIMIZE_STOPS = 25;

/**
 * A humanized (crow-flies-tidy) visit order is kept only when its real road time
 * stays within this factor of Google's time-optimal order. Above it, the tidier
 * order hides a genuine detour the straight-line metric can't see (a river, a
 * one-way maze, a motorway whose junctions are far apart) and Google's order is
 * kept instead. 1.2 = tolerate up to +20% road time for a route that reads
 * correctly to a person; the everyday "delivered a driven-past stop last to save
 * ~30s" case is a tiny fraction of this, so it's always fixed.
 */
const MAX_HUMANIZE_TIME_FACTOR = 1.2;

/** Two stop lists visit the same stops in the same order (compared by id). */
function sameOrder(a: RouteStop[], b: RouteStop[]): boolean {
  return a.length === b.length && a.every((s, i) => s.id === b[i].id);
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
 * Effective courier count for a route request. The route-page „Куриери" dropdown
 * (?couriers=) is the ONLY control now — there is no saved default. Absent /
 * non-finite → 1; always clamped to [1,10] and floored.
 */
export function effectiveCourierCount(couriers: number | undefined): number {
  const n = Math.floor(couriers ?? 1);
  return Math.min(10, Math.max(1, Number.isFinite(n) ? n : 1));
}

/**
 * Per-courier end modes, length `n`. `endModes[i]` (from the ?ends= csv) wins;
 * a missing/undefined/invalid slot falls back to the single default mode.
 */
export function resolveCourierModes(
  defaultMode: RouteEndMode,
  endModes: readonly (RouteEndMode | undefined)[] | undefined,
  n: number,
): RouteEndMode[] {
  return Array.from({ length: n }, (_, i) => endModes?.[i] ?? defaultMode);
}

/**
 * Parse the ?ends= csv into per-courier end modes. Blank / invalid tokens map to
 * `undefined` so resolveCourierModes fills those slots with the single default
 * mode (never throws — a malformed query degrades, it doesn't 500).
 */
export function parseEndModes(ends: string | undefined): (RouteEndMode | undefined)[] | undefined {
  if (!ends) return undefined;
  return ends.split(',').map((e) => (e === 'home' || e === 'last' || e === 'custom' ? e : undefined));
}

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly maps: MapsService,
    private readonly ordersService: OrdersService,
  ) {}

  /**
   * Delivery routes for a date, split across `couriers` drivers: confirmed
   * address-orders as stops, starting from the farm origin. Stops are
   * partitioned geographically (sweep-split around the depot, workload
   * balanced) and each courier's group is independently ordered — Google's
   * visit optimizer when Maps is configured and the group is geocoded,
   * otherwise a nearest-neighbour greedy fallback. No persistence.
   */
  async getRoute(
    tenantId: string,
    date?: string,
    endMode?: RouteEndMode,
    couriers?: number,
    endModes?: (RouteEndMode | undefined)[],
  ): Promise<MultiRouteResult> {
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
        note: orders.deliveryNote,
        lat: orders.deliveryLat,
        lng: orders.deliveryLng,
      })
      .from(orders)
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.status, 'confirmed'),
          eq(orders.deliveryType, 'address'),
          // The route is "stops to DELIVER on this date" — key off the chosen
          // delivery slot's date, not when the order was placed. Shared with the
          // digest/prep queries: a slotted order matches its slot.date; a slotless
          // order falls back to its creation day via the sargable bgDayBounds range
          // (so the slotless branch stays index-served — no bgDate() cast on the
          // column, which the old COALESCE form did and which defeated the index).
          scheduledForDay(day),
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
      note: r.note,
      lat: toNum(r.lat),
      lng: toNum(r.lng),
      summary: (itemsByOrder.get(r.id) ?? []).join(', '),
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
    // to a route after splitting — they can't be placed geographically.
    const located = stops.filter((s) => s.lat != null && s.lng != null);
    const unlocated = stops.filter((s) => s.lat == null || s.lng == null);
    const hasOrigin = origin.lat != null && origin.lng != null;
    const originPt: Pt | null = hasOrigin
      ? { lat: origin.lat as number, lng: origin.lng as number }
      : null;

    // Effective courier count: the route-page dropdown (?couriers=) is the only
    // control; default 1 when omitted (no saved courier default any more).
    const n = effectiveCourierCount(couriers);

    // Partition among couriers (sweep needs a depot; without one, round-robin
    // over a greedy chain so groups still make geographic sense).
    let groups: RouteStop[][];
    if (originPt && located.length) {
      // Feed the split the point every courier returns to after its last stop,
      // so workload balancing counts the return leg (round trip vs one-way).
      const splitEnd = endPoint(mode, originPt, end);
      groups = sweepSplit(originPt, located, n, splitEnd);
    } else if (located.length) {
      const chain = greedyByDistance(null, located);
      groups = Array.from({ length: Math.min(n, chain.length) }, () => []);
      chain.forEach((s, i) => groups[i % groups.length].push(s));
    } else {
      groups = [];
    }
    if (!groups.length) groups = [[]];

    // Groups are independent (pure inputs, key-isolated MapsService cache writes),
    // so optimize them concurrently — each courier's Google Routes call(s) no longer
    // wait on the previous courier's. Serial cost was ~2 round-trips × courier count.
    // Per-courier end modes, indexed by resulting group. The split above balanced
    // with the single default `mode`; here each leg is optimized + measured with
    // ITS own end (home = return to base, last = end at last stop).
    const modes = resolveCourierModes(mode, endModes, groups.length);
    const routes: CourierRoute[] = await Promise.all(
      groups.map((group, i) =>
        this.optimizeGroup(originPt, group, modes[i], this.endForMode(modes[i], origin, end)),
      ),
    );

    // Un-geocoded stops: tail of the least-loaded route (they can't be placed).
    if (unlocated.length) {
      let idx = 0;
      let best = Infinity;
      routes.forEach((r, i) => {
        const w = r.totalDurationS ?? r.stops.length * 600;
        if (w < best) {
          best = w;
          idx = i;
        }
      });
      routes[idx] = { ...routes[idx], stops: [...routes[idx].stops, ...unlocated] };
    }

    return { date: day, origin, end, couriers: routes.length, routes };
  }

  /** The RouteEnd a single courier leg targets, from its own mode. `home` loops
   *  to the depot; `last` is one-way (null coords); `custom` reuses the shared
   *  saved end (legacy — no per-courier custom UI). */
  private endForMode(mode: RouteEndMode, origin: RouteOrigin, shared: RouteEnd): RouteEnd {
    if (mode === 'home') {
      return { mode: 'home', address: origin.address, lat: origin.lat, lng: origin.lng };
    }
    if (mode === 'last') {
      return { mode: 'last', address: null, lat: null, lng: null };
    }
    return shared; // custom
  }

  /**
   * Optimize ONE courier's stop group: Google visit order (≤25) + greedy tail,
   * then measured road totals + polyline via pathTotal. Extracted verbatim from
   * the old single-route distance mode.
   */
  private async optimizeGroup(
    originPt: Pt | null,
    group: RouteStop[],
    mode: RouteEndMode,
    end: RouteEnd,
  ): Promise<CourierRoute> {
    if (!group.length) {
      return { stops: [], totalDistanceM: null, totalDurationS: null, optimized: false, polyline: null, endMode: mode };
    }

    let orderedGroup: RouteStop[];
    // Totals we already computed while deciding the order (Google's own numbers,
    // or a re-measure of the humanized order) — lets the totals block below skip
    // a redundant Routes call. `polylines` is the road geometry for this exact
    // order. Set only when it fully describes the chosen origin→…→dest path;
    // otherwise it stays null and the totals block measures the path itself.
    let precomputedTotal: { distanceM: number; durationS: number; polylines: string[] } | null = null;
    if (originPt) {
      // Let Google optimize the visit order, targeting the REAL end point so a
      // one-way / custom-end route isn't optimized as a round trip.
      const cap = group.slice(0, MAX_OPTIMIZE_STOPS);
      const rest = group.slice(MAX_OPTIMIZE_STOPS);
      const dest = endPoint(mode, originPt, end);
      const plan = await this.maps.route(
        originPt,
        cap.map((s) => ({ lat: s.lat as number, lng: s.lng as number })),
        dest ?? undefined,
      );
      if (plan && plan.order.length === cap.length) {
        const googleHead = plan.order.map((idx) => cap[idx]);
        // Google minimizes ROAD TIME, which reads as wrong to a person when it
        // delivers a driven-past stop last to save a few seconds. Re-sort its
        // order to minimize crow-flies backtracking so such stops go in passing.
        const humanHead = humanizeStopOrder(originPt, googleHead, dest, ptOf);
        const reordered = !sameOrder(humanHead, googleHead);
        // Google's own numbers describe the un-humanized (googleHead) path.
        const planTotal = {
          distanceM: plan.distanceM,
          durationS: plan.durationS,
          polylines: plan.polyline ? [plan.polyline] : [],
        };

        let head = humanHead;
        if (rest.length) {
          // Stops beyond Google's per-request cap: greedily chain them from the
          // last optimized stop instead of leaving them in DB order. The totals
          // block re-measures the whole (humanized head + tail) path.
          this.logger.warn(
            `Route has ${group.length} located stops; only the first ${MAX_OPTIMIZE_STOPS} ` +
              `are Google-optimized, the rest are ordered by nearest-neighbour heuristic.`,
          );
        } else if (dest === null) {
          // One-way (`last` mode, or a custom end with no coords): Google
          // optimized a round trip back to the depot, so its totals are for a
          // DIFFERENT path than the one-way we actually drive — let the totals
          // block measure origin→…→last-stop with no return leg.
        } else if (!reordered) {
          // Order unchanged: Google's totals + geometry describe this path — reuse.
          precomputedTotal = planTotal;
        } else {
          // Humanized order differs: re-measure its real road cost (the one extra
          // billed Routes call, only when we actually reorder), then keep it only
          // if it isn't dramatically slower than Google's optimum — otherwise the
          // tidier order hides a real detour and we revert to Google's order.
          const pts: Pt[] = [originPt, ...humanHead.map((s) => ptOf(s) as Pt), dest];
          const measured = await this.pathTotal(pts);
          if (measured && measured.durationS <= plan.durationS * MAX_HUMANIZE_TIME_FACTOR) {
            precomputedTotal = measured;
          } else {
            head = googleHead;
            precomputedTotal = planTotal;
          }
        }

        const tail = greedyByDistance(ptOf(head[head.length - 1]) ?? originPt, rest);
        orderedGroup = [...head, ...tail];
      } else {
        // Google disabled or the call failed: fall back to a greedy
        // nearest-neighbour order over ALL stops in the group. Keeps "shortest
        // path" meaningful (not DB order) so `optimized` stays honest.
        orderedGroup = greedyByDistance(originPt, group);
      }
    } else {
      // No farm origin set — greedy-order from the first stop.
      orderedGroup = greedyByDistance(null, group);
    }

    // Real road distance/duration of the chosen order + end leg (no reordering).
    // Measured over EVERY stop (chunked below), so totals don't under-report
    // when the group has more than MAX_OPTIMIZE_STOPS stops.
    let totalDistanceM: number | null = null;
    let totalDurationS: number | null = null;
    let routePolyline: string[] | null = null;
    if (precomputedTotal) {
      totalDistanceM = precomputedTotal.distanceM;
      totalDurationS = precomputedTotal.durationS;
      routePolyline = precomputedTotal.polylines.length ? precomputedTotal.polylines : null;
    } else if (originPt) {
      const pts: Pt[] = [originPt];
      for (const s of orderedGroup) {
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
        routePolyline = total.polylines.length ? total.polylines : null;
      }
    }

    return {
      stops: orderedGroup,
      totalDistanceM,
      totalDurationS,
      optimized: orderedGroup.length > 0,
      polyline: routePolyline,
      endMode: mode,
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
  private async pathTotal(
    pts: Pt[],
  ): Promise<{ distanceM: number; durationS: number; polylines: string[] } | null> {
    if (pts.length < 2) return null;
    const nodesPerLeg = MAX_OPTIMIZE_STOPS + 2; // origin + ≤25 intermediates + dest
    let distanceM = 0;
    let durationS = 0;
    const polylines: string[] = [];
    let i = 0;
    while (i < pts.length - 1) {
      const seg = pts.slice(i, i + nodesPerLeg);
      const plan = await this.maps.routeFixed(seg);
      if (!plan) return null;
      distanceM += plan.distanceM;
      durationS += plan.durationS;
      // Road geometry for this leg; concatenated client-side to draw the full
      // street-following line. Consecutive legs share a node (seam) — harmless.
      if (plan.polyline) polylines.push(plan.polyline);
      i += seg.length - 1;
    }
    return { distanceM, durationS, polylines };
  }

  /**
   * Fix a stop that never got a map pin. Two ways in:
   *  - `lat`+`lng`  → a manual pin the farmer dropped on the map; saved as-is.
   *  - `address`    → re-geocoded (biased to the farm) and the result is saved.
   * Either way the order's delivery coords (+ address) are updated so the stop
   * shows on the map and joins distance optimization on the next load.
   * Tenant-scoped: an order from another farm is "not found" (no IDOR).
   */
  async setStopLocation(
    tenantId: string,
    orderId: string,
    input: { address?: string; lat?: number; lng?: number },
  ): Promise<{ lat: number; lng: number; address: string | null }> {
    const [order] = await this.db
      .select({
        id: orders.id,
        address: orders.deliveryAddress,
        city: orders.deliveryCity,
        deliveryType: orders.deliveryType,
      })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
      .limit(1);
    if (!order) throw new NotFoundException('Поръчката не е намерена');
    if (order.deliveryType !== 'address') {
      throw new BadRequestException('Тази поръчка не е с доставка до адрес');
    }

    let lat = input.lat ?? null;
    let lng = input.lng ?? null;
    const typed = input.address?.trim();
    let address: string | null = typed || order.address;

    // No manual pin → geocode the (corrected) address. Bias to the farm so an
    // ambiguous street resolves near the farm, mirroring order creation.
    if (lat == null || lng == null) {
      const query = typed || order.address;
      if (!query) throw new BadRequestException('Няма адрес за търсене');

      const [tenant] = await this.db
        .select({ farmLat: tenants.farmLat, farmLng: tenants.farmLng })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      const fLat = toNum(tenant?.farmLat ?? null);
      const fLng = toNum(tenant?.farmLng ?? null);
      const bias = fLat != null && fLng != null ? { lat: fLat, lng: fLng } : undefined;

      const geo = await this.maps.geocode(query, bias, { locality: order.city ?? undefined });
      if (!geo) {
        throw new UnprocessableEntityException(
          'Адресът не е намерен. Опитай по-точен адрес или постави точка на картата.',
        );
      }
      lat = geo.lat;
      lng = geo.lng;
      address = query;
    }

    await this.db
      .update(orders)
      .set({ deliveryLat: String(lat), deliveryLng: String(lng), deliveryAddress: address })
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)));

    return { lat, lng, address };
  }

  /**
   * Reverse geocode a map point to a human address — used by the route stop
   * editor when the farmer drops/drags a pin, so the address field can show
   * what's actually there. Wraps {@link MapsService.reverseGeocode}'s
   * null-on-no-match contract in a plain object so the controller has a fixed
   * response shape regardless of whether a match was found.
   */
  async reverseGeocode(lat: number, lng: number): Promise<{ address: string | null }> {
    const address = await this.maps.reverseGeocode(lat, lng);
    return { address };
  }

  /**
   * Geography-first proposal: spread the tenant's pending address orders (the
   * reschedulable pool) across `days`. Returns per-day orders + a harvest total
   * + a spread hint, plus the un-geocoded orders the farmer must place by hand.
   * Applying the proposal is the client's job (it calls the existing reschedule
   * endpoint once per day) — this method never mutates.
   */
  async suggestDays(
    tenantId: string,
    days: { date: string; couriers: number }[],
  ): Promise<DaySuggestionResult> {
    const pool = await this.ordersService.reschedulable(tenantId);

    // Depot = farm coords (null when the farm was never geocoded).
    const [tenant] = await this.db
      .select({ farmLat: tenants.farmLat, farmLng: tenants.farmLng })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const depot: Pt | null =
      tenant?.farmLat != null && tenant?.farmLng != null
        ? { lat: Number(tenant.farmLat), lng: Number(tenant.farmLng) }
        : null;

    // Per-order line items for the harvest readout (no N+1 — one query).
    const poolIds = pool.map((o) => o.id);
    const itemsByOrder = new Map<string, { productName: string | null; quantity: number }[]>();
    if (poolIds.length) {
      const items = await this.db
        .select({
          orderId: orderItems.orderId,
          productName: orderItems.productName,
          quantity: orderItems.quantity,
        })
        .from(orderItems)
        .where(inArray(orderItems.orderId, poolIds));
      for (const it of items) {
        const list = itemsByOrder.get(it.orderId!) ?? [];
        list.push({ productName: it.productName, quantity: it.quantity });
        itemsByOrder.set(it.orderId!, list);
      }
    }

    return assembleDaySuggestion(pool, itemsByOrder, depot, days);
  }
}
