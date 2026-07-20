import {
  Injectable,
  Inject,
  forwardRef,
  Logger,
  NotFoundException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { type Database, orders, orderItems, deliverySlots, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { MapsService } from '../../common/maps/maps.service';
import { bgToday } from '../../common/time/bg-time';
import { scheduledForDay } from '../orders/order-scheduling';
import { sweepSplit, haversineKm, estimateWorkloadS, type Pt } from './route-split';
import { humanizeStopOrder } from './route-humanize';
import { OrdersService } from '../orders/orders.service';
import { OrderConfirmationService } from '../order-email/order-confirmation.service';
import { CourierAssignmentService } from './courier-assignment.service';
import { positionCase } from '../../common/db/reorder.util';
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
  /** Order money (tasks #4/#6), all in stotinki: goods subtotal (Σ item
   *  price×qty), the delivery fee (grand total − subtotal, clamped ≥ 0), and the
   *  grand total WITH delivery. */
  itemsSubtotalStotinki: number;
  deliveryFeeStotinki: number;
  totalStotinki: number;
  /** Operator's manual courier pin (task #6): 0-based courier index, or null for
   *  auto (geographic sweep-split). */
  courierIndex: number | null;
  /** Delivery time window (task #13): 'HH:MM' wall-clock (Europe/Sofia) and its
   *  review status (draft → approved → sent). Null until a window is generated. */
  deliveryWindowStart: string | null;
  deliveryWindowEnd: string | null;
  deliveryWindowStatus: string | null;
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
  /** Where THIS courier's leg ends (task #7 „У дома"): the resolved home/custom
   *  end coordinates, or null coords for a one-way (`last`) leg. Lets the client
   *  label the finish and deep-link to it. */
  endAddress: string | null;
  endLat: number | null;
  endLng: number | null;
  /** Where THIS courier's leg STARTS: the resolved per-courier start override,
   *  or the farm origin when unset. Lets the client draw the leg + deep-link
   *  navigation from the right place. */
  startAddress: string | null;
  startLat: number | null;
  startLng: number | null;
  /** 0-based index of this courier (== position in `routes`). */
  courierIndex: number;
  /** Operator-set courier name (settings.routing.couriers[i].name), else null. */
  name: string | null;
  /** This courier's day money (task #6), summed from its stops, in stotinki:
   *  goods subtotal, delivery fees, and the grand total WITH delivery. */
  itemsSubtotalStotinki: number;
  deliveryFeeStotinki: number;
  totalStotinki: number;
}

/**
 * Per-courier saved config (task #5 + #7), stored index-aligned in
 * settings.routing.couriers[]. A courier with a configured home ends their leg
 * at that home („У дома"); endMode overrides the day-wide default for this
 * courier. All fields optional — an unconfigured courier falls back to the
 * day-wide end.
 */
export interface CourierConfig {
  name?: string | null;
  endMode?: RouteEndMode;
  homeAddress?: string | null;
  homeLat?: number | string | null;
  homeLng?: number | string | null;
  /** Per-courier START override. When set, this courier's leg BEGINS here
   *  instead of the shared farm origin (independent of the end/home). Unset →
   *  the courier starts from the farm base, unchanged. */
  startAddress?: string | null;
  startLat?: number | string | null;
  startLng?: number | string | null;
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

/**
 * A courier's resolved START point: their saved per-courier start override when
 * both coords are set, else the shared farm origin (unchanged behaviour). Pure +
 * shared by getRoute and measureExplicitOrder so the leg begins from the same
 * place in both the drawn route and a re-measured manual order.
 */
function courierStartOf(
  cfg: CourierConfig | undefined,
  origin: RouteOrigin,
): { address: string | null; lat: number | null; lng: number | null } {
  const lat = toNum((cfg?.startLat ?? null) as string | null);
  const lng = toNum((cfg?.startLng ?? null) as string | null);
  return lat != null && lng != null
    ? { address: cfg?.startAddress ?? null, lat, lng }
    : { address: origin.address, lat: origin.lat, lng: origin.lng };
}

/** Sum one money field over a group of stops (task #6 per-courier totals). */
const sumMoney = (
  stops: RouteStop[],
  key: 'itemsSubtotalStotinki' | 'deliveryFeeStotinki' | 'totalStotinki',
): number => stops.reduce((acc, s) => acc + (s[key] ?? 0), 0);

/** Normalise a Postgres `time` value ('HH:MM:SS') to the 'HH:MM' the UI/email
 *  use. Passes through null and already-short values. */
const hhmm = (v: string | null | undefined): string | null =>
  v == null ? null : v.length >= 5 ? v.slice(0, 5) : v;

/** Routes API hard limit on intermediate waypoints per computeRoutes request. */
const MAX_OPTIMIZE_STOPS = 25;

// ── Delivery time-window generation (task #13) ──────────────────────────────
/** When the courier starts the round, if settings.routing.dayStartHour is unset. */
const DEFAULT_DAY_START_HOUR = 9;
/** Window granularity in minutes (settings.routing.slotSizeMin), default 1h. */
const DEFAULT_SLOT_MIN = 60;
/** Handling time per stop (unload, hand over, collect COD) in minutes. */
const DEFAULT_SERVICE_MIN = 10;
/** Drive-time guess per leg when Maps gave no duration (offline / no origin). */
const FALLBACK_LEG_MIN = 12;
/** Latest window end we'll emit (23:00) — keeps a long day from wrapping past midnight. */
const MAX_WINDOW_END_MIN = 23 * 60;
/** 'HH:MM' 24h wall-clock, validated on window edits. */
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Minutes-since-midnight → 'HH:MM'. Clamped to [0, 1439]. */
const minToHHMM = (min: number): string => {
  const m = Math.max(0, Math.min(1439, Math.round(min)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** One order's generated/edited delivery window in the proposal payload. */
export interface DeliveryWindowStop {
  id: string;
  customer: string | null;
  email: string | null;
  windowStart: string;
  windowEnd: string;
  hasEmail: boolean;
}
export interface DeliveryWindowProposal {
  date: string;
  slotMin: number;
  couriers: {
    courierIndex: number;
    name: string | null;
    stops: DeliveryWindowStop[];
  }[];
  /** Orders that got a window but have no customer email (can't be notified). */
  withoutEmail: number;
}

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
 * The stop set the day's partition is computed from — ALWAYS this, never a
 * caller's choice.
 *
 * `sweepSplit` balances whatever set it is handed, so the row filter feeding it
 * decides which courier owns which stop. Splitting 'confirmed'-only re-partitions
 * the survivors every time a stop is marked delivered, handing another courier's
 * stops — and their customer's name, phone, email and address — to whoever asks
 * next. Keying off confirmed + delivered pins ownership for the whole day: the
 * set only grows as orders are confirmed, never shrinks as they're completed.
 *
 * What a caller may choose is what to DISPLAY (see RouteDisplay), applied after
 * the partition is fixed.
 */
export const ROUTE_BASIS_STATUSES = ['confirmed', 'delivered'] as const;

/** Which stops to render. Never affects the partition. */
export type RouteDisplay = 'live' | 'all';

/**
 * Effective courier count for a route request. Caller resolves the source (the
 * ?couriers= dropdown, else the tenant's saved default) and passes the result
 * here. Absent / non-finite → 1; always clamped to [1,10] and floored.
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
    // forwardRef: OrdersModule now imports RoutingModule back (OrdersController
    // needs RoutingService for the driver own-leg check), making this a genuine
    // provider-level circular dependency, not just a module-level one.
    @Inject(forwardRef(() => OrdersService)) private readonly ordersService: OrdersService,
    private readonly orderEmail: OrderConfirmationService,
    private readonly courierAssignments: CourierAssignmentService,
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
    // What to SHOW — never what to split on. 'live' hides stops already
    // delivered (the route screen: finished stops drop off the map); 'all' keeps
    // them (ownership checks, «Моят оборот», the courier's packing list).
    // The partition is identical either way; see ROUTE_BASIS_STATUSES.
    display: RouteDisplay = 'live',
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
        total: orders.totalStotinki,
        status: orders.status,
        courierIndex: orders.courierIndex,
        routeSeq: orders.routeSeq,
        windowStart: orders.deliveryWindowStart,
        windowEnd: orders.deliveryWindowEnd,
        windowStatus: orders.deliveryWindowStatus,
      })
      .from(orders)
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          inArray(orders.status, ROUTE_BASIS_STATUSES),
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

    // Persisted manual stop order (route_seq), by order id. Kept OUT of the
    // RouteStop interface (that would ripple into every test factory in this
    // module) — used only internally, below, to honour a saved manual reorder
    // instead of always re-optimizing.
    const routeSeqById = new Map<string, number | null>(rows.map((r) => [r.id, r.routeSeq ?? null]));

    // Order status, by id. Kept out of RouteStop for the same reason routeSeq is
    // (it would ripple into every test factory in this module) — used only below,
    // to drop finished stops from the LIVE view *after* the partition is fixed.
    const statusById = new Map<string, string | null>(rows.map((r) => [r.id, r.status]));

    // Batch item summaries + goods subtotal per order (no N+1).
    const ids = rows.map((r) => r.id);
    const itemsByOrder = new Map<string, string[]>();
    const subtotalByOrder = new Map<string, number>();
    if (ids.length) {
      const items = await this.db
        .select({
          orderId: orderItems.orderId,
          productName: orderItems.productName,
          variantLabel: orderItems.variantLabel,
          quantity: orderItems.quantity,
          priceStotinki: orderItems.priceStotinki,
        })
        .from(orderItems)
        .where(inArray(orderItems.orderId, ids));
      for (const it of items) {
        const list = itemsByOrder.get(it.orderId!) ?? [];
        // Variant/weight (e.g. "500г") must be visible on the stop card, not
        // just the full order panel — a courier delivering the wrong weight
        // variant is a real, reported failure mode.
        const label = it.variantLabel ? `${it.productName} (${it.variantLabel})` : it.productName;
        list.push(`${label} × ${it.quantity}`);
        itemsByOrder.set(it.orderId!, list);
        subtotalByOrder.set(
          it.orderId!,
          (subtotalByOrder.get(it.orderId!) ?? 0) + it.priceStotinki * it.quantity,
        );
      }
    }

    const stops: RouteStop[] = rows.map((r) => {
      const total = r.total ?? 0;
      const subtotal = subtotalByOrder.get(r.id) ?? 0;
      return {
        id: r.id,
        customer: r.customer,
        phone: r.phone,
        email: r.email,
        address: r.address,
        note: r.note,
        lat: toNum(r.lat),
        lng: toNum(r.lng),
        summary: (itemsByOrder.get(r.id) ?? []).join(', '),
        itemsSubtotalStotinki: subtotal,
        // Delivery fee isn't stored separately — it's folded into the grand total
        // at checkout. Recover it as total − goods subtotal (clamp ≥ 0 so a legacy
        // row with a rounding quirk never shows a negative fee).
        deliveryFeeStotinki: Math.max(0, total - subtotal),
        totalStotinki: total,
        courierIndex: r.courierIndex ?? null,
        deliveryWindowStart: hhmm(r.windowStart),
        deliveryWindowEnd: hhmm(r.windowEnd),
        deliveryWindowStatus: r.windowStatus ?? null,
      };
    });

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

    // Task A3 — per-day assignment board (Task A2) precedence: if the operator
    // has assigned ANY courier to this date via the board, the route splits
    // into exactly as many legs as there are DISTINCT assigned legIndex values
    // — overriding BOTH the ?couriers= dropdown and the tenant's saved
    // courierCount default. Zero assignments for the day → unchanged current
    // behavior (dropdown/settings → effectiveCourierCount below).
    const assignments = await this.courierAssignments.getAssignmentsForDay(tenantId, day);
    // Sorted DISTINCT legIndex values, e.g. [0, 2] if the board has leg 1
    // unassigned today — the board lets each roster row pick any leg
    // independently, so non-contiguous sets are a normal, expected shape,
    // not an edge case.
    const assignedLegs = [...new Set(assignments.map((a) => a.legIndex))].sort((a, b) => a - b);
    const assignedLegCount = assignedLegs.length;

    // Effective courier count: the route-page „Куриери" dropdown (?couriers=) wins
    // per request; when omitted, fall back to the tenant's saved default
    // (settings.routing.courierCount), else 1. Both are clamped to [1,10].
    const n =
      assignedLegCount > 0
        ? assignedLegCount
        : effectiveCourierCount(couriers ?? (routingCfg.courierCount as number | undefined));

    // `groups`/`sweepSplit` work over a DENSE 0..n-1 array position ("pos").
    // With no board (legacy dropdown), pos === legIndex === courierIndex,
    // always contiguous from 0. With a board that has gaps (e.g. legs
    // [0, 2]), pos and legIndex diverge — pos 0 is leg 0, pos 1 is leg 2.
    // `posToLeg[pos]` recovers the real leg for a route's `courierIndex`
    // output; `legToPos` is the inverse, for placing a pin (which stores the
    // real leg) into the correctly-positioned array slot. Not maintaining
    // this mapping was a real bug: a driver assigned a non-contiguous leg
    // (e.g. leg 2 when only legs [0, 2] are assigned) would never match any
    // route's array-position-derived courierIndex and see zero stops.
    const posToLeg = assignedLegCount > 0 ? assignedLegs : Array.from({ length: n }, (_, i) => i);
    const legToPos = new Map(posToLeg.map((leg, pos) => [leg, pos]));

    // Operator-pinned stops (task #6): an order the operator manually moved onto a
    // specific courier keeps that courier regardless of geography. Pins that don't
    // resolve to a currently-active leg (courier count later lowered, or the
    // board no longer assigns that leg) are treated as auto. The rest are split
    // geographically as before, then the pins are dropped into their courier.
    const inRange = (ci: number | null): ci is number => ci != null && legToPos.has(ci);
    const pinned = located.filter((s) => inRange(s.courierIndex));
    const free = located.filter((s) => !inRange(s.courierIndex));

    // Partition among couriers (sweep needs a depot; without one, round-robin
    // over a greedy chain so groups still make geographic sense).
    let groups: RouteStop[][];
    if (originPt && free.length) {
      // Feed the split the point every courier returns to after its last stop,
      // so workload balancing counts the return leg (round trip vs one-way).
      const splitEnd = endPoint(mode, originPt, end);
      // Pin-aware balancing (audit follow-up): a courier who already has
      // pinned stops shouldn't ALSO get an even share of the free stops on
      // top — that's exactly the mechanism that produced a real 4.56:1
      // imbalance (14/20 stops pinned to one courier, the splitter still
      // handed out the remaining 6 as if every courier started from zero).
      // Estimate each POSITION's already-committed workload from its pinned
      // stops (same estimate the splitter itself uses for balancing) and feed
      // it in as sweepSplit's baseWorkloads — position-indexed the same way
      // posToLeg/legToPos already are, so it lines up with pinned's placement
      // below.
      const baseWorkloads = posToLeg.map((_, pos) => {
        const pinnedHere = pinned.filter((s) => legToPos.get(s.courierIndex as number) === pos);
        if (!pinnedHere.length) return 0;
        const pts = pinnedHere.map((s) => ptOf(s) as Pt);
        return estimateWorkloadS(originPt, pts, splitEnd);
      });
      groups = sweepSplit(originPt, free, n, splitEnd, baseWorkloads);
    } else if (free.length) {
      const chain = greedyByDistance(null, free);
      groups = Array.from({ length: Math.min(n, chain.length) }, () => []);
      chain.forEach((s, i) => groups[i % groups.length].push(s));
    } else {
      groups = [];
    }
    // Materialise enough courier slots (up to n) to receive the pins, then place
    // each pinned stop on its courier. Pinning is what makes „move to courier 2"
    // stick across reloads and lets an explicitly-chosen 2-courier day show both.
    if (pinned.length) {
      while (groups.length < n) groups.push([]);
      for (const s of pinned) groups[legToPos.get(s.courierIndex as number)!].push(s);
    }
    if (!groups.length) groups = [[]];

    // Ownership is now fixed for the day: every stop in the basis sits on its
    // courier's leg, pins included. Only NOW may finished stops be dropped —
    // doing it before the split would shrink the set and re-partition the rest.
    // Everything below (reorder, re-optimize, measure) therefore plans the drive
    // over what's actually left, while the legs themselves no longer move.
    if (display === 'live') {
      groups = groups.map((group) => group.filter((s) => statusById.get(s.id) !== 'delivered'));
    }

    // Honour a persisted manual reorder (route_seq, set via PATCH
    // /orders/route/order/sequence): a group with at least one sequenced stop
    // is sorted by that sequence (unseq'd stops trail, stable sort so their
    // relative order is otherwise unchanged) and skips re-optimization
    // entirely below — the operator's drag order sticks instead of being
    // silently overwritten by the next Google/greedy re-optimize.
    const preserveOrderFlags = groups.map((group) => group.some((s) => routeSeqById.get(s.id) != null));
    groups = groups.map((group, i) =>
      preserveOrderFlags[i]
        ? [...group].sort(
            (a, b) => (routeSeqById.get(a.id) ?? Infinity) - (routeSeqById.get(b.id) ?? Infinity),
          )
        : group,
    );

    // Groups are independent (pure inputs, key-isolated MapsService cache writes),
    // so optimize them concurrently — each courier's Google Routes call(s) no longer
    // wait on the previous courier's. Serial cost was ~2 round-trips × courier count.
    // Per-courier end modes, indexed by resulting group. The split above balanced
    // with the single default `mode`; here each leg is optimized + measured with
    // ITS own end (home = return to base, last = end at last stop).
    // Per-courier end: the request's ?ends= csv wins (positional — the client
    // builds it from the routes array it was shown, so position round-trips),
    // else this courier's saved config, else the day-wide default.
    //
    // settings.routing.couriers[] is indexed by the REAL courier/leg number:
    // the homes modal edits „Куриер N" at couriers[N-1], and
    // measureExplicitOrder looks up couriersCfg[courierIndex] with the real
    // leg. So saved config must be resolved via posToLeg[i], NOT the dense
    // array position i — on a non-contiguous board day (legs [0, 2]) the
    // position-indexed lookup handed the leg-2 route courier 2's saved name
    // AND ended its actually-driven route at that wrong courier's home.
    const couriersCfg = (routingCfg.couriers as CourierConfig[] | undefined) ?? [];
    const modes = groups.map(
      (_, i) => endModes?.[i] ?? (couriersCfg[posToLeg[i]]?.endMode as RouteEndMode) ?? mode,
    );
    const routes: CourierRoute[] = await Promise.all(
      groups.map((group, i) =>
        this.optimizeGroup(
          // Per-courier START (independent of the end): this courier's saved
          // start override, else the shared farm origin. The geographic split
          // above still balances around the farm — only each leg's routing +
          // deep-link start moves to the courier's own base.
          courierStartOf(couriersCfg[posToLeg[i]], origin),
          group,
          modes[i],
          this.endForCourier(modes[i], origin, end, couriersCfg[posToLeg[i]]),
          // The real (possibly non-contiguous) leg, not the dense array
          // position — this is what a driver's resolveMyLeg comparison and
          // order pins match against.
          posToLeg[i],
          (couriersCfg[posToLeg[i]]?.name as string | null) ?? null,
          preserveOrderFlags[i],
        ),
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
      const target = routes[idx];
      routes[idx] = {
        ...target,
        stops: [...target.stops, ...unlocated],
        // Keep the courier's money totals honest once the unplaceable stops land here.
        itemsSubtotalStotinki:
          target.itemsSubtotalStotinki + sumMoney(unlocated, 'itemsSubtotalStotinki'),
        deliveryFeeStotinki: target.deliveryFeeStotinki + sumMoney(unlocated, 'deliveryFeeStotinki'),
        totalStotinki: target.totalStotinki + sumMoney(unlocated, 'totalStotinki'),
      };
    }

    return { date: day, origin, end, couriers: routes.length, routes };
  }

  /**
   * Task #5 — road geometry + totals for an EXPLICIT, operator-chosen stop order.
   * Unlike getRoute this does NOT reorder: it measures depot → stops (in exactly
   * the given order) → the courier's end, and returns the encoded polyline so the
   * map draws real streets instead of straight pin-to-pin lines after a manual
   * reorder or a courier move. Coordinates are loaded server-side (tenant-scoped)
   * from the given order ids — the client only sends the order, never coords.
   *
   * `start`, when given, anchors the measured line at the courier's live GPS
   * position (or last finished drop) instead of the depot — the courier isn't
   * at the farm anymore once en route, so measuring from there mis-draws the
   * line. Only the path's first point changes; the end/return-leg resolution
   * (which still needs the depot for `home`/saved-end fallback) is untouched.
   */
  async measureExplicitOrder(
    tenantId: string,
    date: string | undefined,
    stopIds: string[],
    courierIndex?: number,
    endModeOverride?: RouteEndMode,
    start?: Pt,
  ): Promise<{
    polyline: string[] | null;
    totalDistanceM: number | null;
    totalDurationS: number | null;
  }> {
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

    const origin: RouteOrigin = {
      address: tenant.farmAddress,
      lat: toNum(tenant.farmLat),
      lng: toNum(tenant.farmLng),
    };
    const originPt: Pt | null =
      origin.lat != null && origin.lng != null
        ? { lat: origin.lat as number, lng: origin.lng as number }
        : null;
    if (!originPt || stopIds.length === 0) {
      return { polyline: null, totalDistanceM: null, totalDurationS: null };
    }

    const routingCfg =
      ((tenant.settings as Record<string, any> | null)?.routing as Record<string, any>) ?? {};
    const couriersCfg = (routingCfg.couriers as CourierConfig[] | undefined) ?? [];
    const cfg = courierIndex != null ? couriersCfg[courierIndex] : undefined;
    const mode: RouteEndMode =
      endModeOverride ?? (cfg?.endMode as RouteEndMode) ?? (routingCfg.endMode as RouteEndMode) ?? 'home';
    const sharedEnd: RouteEnd =
      mode === 'custom'
        ? {
            mode,
            address: routingCfg.endAddress ?? null,
            lat: toNum(routingCfg.endLat ?? null),
            lng: toNum(routingCfg.endLng ?? null),
          }
        : { mode, address: origin.address, lat: origin.lat, lng: origin.lng };
    const end = this.endForCourier(mode, origin, sharedEnd, cfg);

    // This leg's depot start = the courier's per-courier start override, else the
    // farm origin. `start` (live GPS / last drop, when en route) still wins over it.
    const legStart = courierStartOf(cfg, origin);
    const legStartPt: Pt =
      legStart.lat != null && legStart.lng != null
        ? { lat: legStart.lat, lng: legStart.lng }
        : originPt;

    // Load coords for the requested ids (tenant-scoped), then re-order them to the
    // caller's sequence. Ids without coords are dropped (can't be routed).
    const rows = await this.db
      .select({ id: orders.id, lat: orders.deliveryLat, lng: orders.deliveryLng })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), inArray(orders.id, stopIds))!);
    const byId = new Map(rows.map((r) => [r.id, { lat: toNum(r.lat), lng: toNum(r.lng) }]));
    const pts: Pt[] = [start ?? legStartPt];
    for (const id of stopIds) {
      const c = byId.get(id);
      if (c && c.lat != null && c.lng != null) pts.push({ lat: c.lat, lng: c.lng });
    }
    // Dest from the resolved end coords (home already baked to farm/home by
    // endForCourier) — not endPoint(…, originPt, …), which would loop a
    // per-courier start back to itself.
    const dest =
      mode !== 'last' && end.lat != null && end.lng != null
        ? { lat: end.lat, lng: end.lng }
        : null;
    if (dest) pts.push(dest);
    if (pts.length < 2) return { polyline: null, totalDistanceM: null, totalDurationS: null };

    const total = await this.pathTotal(pts);
    if (!total) return { polyline: null, totalDistanceM: null, totalDurationS: null };
    return {
      polyline: total.polylines.length ? total.polylines : null,
      totalDistanceM: total.distanceM,
      totalDurationS: total.durationS,
    };
  }

  /**
   * The RouteEnd a single courier leg targets, from its own mode + saved config.
   *  - `last` → one-way (null coords).
   *  - otherwise, if this courier has a configured home („У дома", task #7) →
   *    end there (as a custom end at the home coords), regardless of home/custom.
   *  - else legacy: `home` loops back to the depot, `custom` reuses the shared
   *    tenant-wide saved end.
   */
  private endForCourier(
    mode: RouteEndMode,
    origin: RouteOrigin,
    shared: RouteEnd,
    cfg?: CourierConfig,
  ): RouteEnd {
    if (mode === 'last') {
      return { mode: 'last', address: null, lat: null, lng: null };
    }
    const homeLat = toNum((cfg?.homeLat ?? null) as string | null);
    const homeLng = toNum((cfg?.homeLng ?? null) as string | null);
    if (homeLat != null && homeLng != null) {
      return { mode: 'custom', address: cfg?.homeAddress ?? null, lat: homeLat, lng: homeLng };
    }
    if (mode === 'home') {
      return { mode: 'home', address: origin.address, lat: origin.lat, lng: origin.lng };
    }
    return shared; // custom, no per-courier home → tenant-wide saved end
  }

  /**
   * Optimize ONE courier's stop group: Google visit order (≤25) + greedy tail,
   * then measured road totals + polyline via pathTotal. Extracted verbatim from
   * the old single-route distance mode.
   */
  private async optimizeGroup(
    start: { address: string | null; lat: number | null; lng: number | null },
    group: RouteStop[],
    mode: RouteEndMode,
    end: RouteEnd,
    courierIndex = 0,
    name: string | null = null,
    preserveOrder = false,
  ): Promise<CourierRoute> {
    // This leg's start point — the per-courier override or the farm origin,
    // already resolved by the caller. null lat/lng = no origin at all (greedy
    // fallback order). Kept named `originPt` so the body below is unchanged.
    const originPt: Pt | null =
      start.lat != null && start.lng != null ? { lat: start.lat, lng: start.lng } : null;
    const startFields = {
      startAddress: start.address,
      startLat: start.lat,
      startLng: start.lng,
    };
    // Per-courier day money (task #6) — order-independent, so summed once here.
    const money = {
      itemsSubtotalStotinki: sumMoney(group, 'itemsSubtotalStotinki'),
      deliveryFeeStotinki: sumMoney(group, 'deliveryFeeStotinki'),
      totalStotinki: sumMoney(group, 'totalStotinki'),
    };
    if (!group.length) {
      return {
        stops: [],
        totalDistanceM: null,
        totalDurationS: null,
        optimized: false,
        polyline: null,
        endMode: mode,
        endAddress: end.address,
        endLat: end.lat,
        endLng: end.lng,
        ...startFields,
        courierIndex,
        name,
        ...money,
      };
    }

    let orderedGroup: RouteStop[];
    // Totals we already computed while deciding the order (Google's own numbers,
    // or a re-measure of the humanized order) — lets the totals block below skip
    // a redundant Routes call. `polylines` is the road geometry for this exact
    // order. Set only when it fully describes the chosen origin→…→dest path;
    // otherwise it stays null and the totals block measures the path itself.
    let precomputedTotal: { distanceM: number; durationS: number; polylines: string[] } | null = null;
    if (preserveOrder) {
      // A persisted manual order (route_seq) wins outright — the caller already
      // sorted `group` into the operator's chosen sequence. Skip Google/greedy
      // re-optimization entirely; the totals block below still measures this
      // exact order's real road distance/duration + polyline.
      orderedGroup = group;
    } else if (originPt) {
      // Let Google optimize the visit order, targeting the REAL end point so a
      // one-way / custom-end route isn't optimized as a round trip.
      const cap = group.slice(0, MAX_OPTIMIZE_STOPS);
      const rest = group.slice(MAX_OPTIMIZE_STOPS);
      // Destination from the resolved end coords, NOT endPoint(mode, originPt,…):
      // with a per-courier start ≠ farm, „home" must still return to the farm/
      // configured home (already baked into `end` by endForCourier), not loop
      // back to this courier's start. Equivalent to the old endPoint result when
      // start == farm origin.
      const dest =
        mode !== 'last' && end.lat != null && end.lng != null
          ? { lat: end.lat, lng: end.lng }
          : null;
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
      endAddress: end.address,
      endLat: end.lat,
      endLng: end.lng,
      ...startFields,
      courierIndex,
      name,
      ...money,
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

  /**
   * Task #6 — pin an order to a specific courier (0-based), or clear the pin
   * (null → auto geographic split). Out-of-range indices are still stored but
   * ignored by getRoute (fall back to auto), so lowering the courier count never
   * breaks a stored assignment. Tenant-scoped (foreign order = not found).
   */
  async setOrderCourier(
    tenantId: string,
    orderId: string,
    courierIndex: number | null,
  ): Promise<{ id: string; courierIndex: number | null }> {
    if (
      courierIndex != null &&
      (!Number.isInteger(courierIndex) || courierIndex < 0 || courierIndex > 9)
    ) {
      throw new BadRequestException('Невалиден куриер');
    }
    const res = await this.db
      .update(orders)
      .set({ courierIndex })
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
      .returning({ id: orders.id });
    if (!res.length) throw new NotFoundException('Поръчката не е намерена');
    return { id: orderId, courierIndex };
  }

  /**
   * Persist the operator's manual stop order for one courier leg (route_seq,
   * migration 0095), so getRoute honours it instead of always re-optimizing.
   * Position in `stopIds` becomes that order's route_seq, and the order is
   * (re)pinned to `courierIndex` so the pin and the sequence always agree.
   * Per-row updates — a delivery day is a handful of orders. Tenant-scoped
   * (a foreign id is silently skipped by the WHERE, same as a no-op).
   *
   * An empty `stopIds` is a "clear": nulls route_seq for every order currently
   * pinned to this courier (mirrors setOrderCourier's un-scoped-by-date pin
   * lookup above — the pin itself carries no date), so the leg falls back to
   * the auto/optimized order again.
   */
  async setOrderSequence(
    tenantId: string,
    courierIndex: number,
    stopIds: string[],
  ): Promise<{ courierIndex: number; count: number }> {
    if (!stopIds.length) {
      await this.db
        .update(orders)
        .set({ routeSeq: null })
        .where(and(eq(orders.tenantId, tenantId), eq(orders.courierIndex, courierIndex)));
      return { courierIndex, count: 0 };
    }
    // One UPDATE … SET route_seq = CASE id … END instead of a statement per row
    // (a foreign id is dropped by the tenant-scoped WHERE, same as the old no-op).
    const seqItems = stopIds.map((id, i) => ({ id, position: i }));
    await this.db
      .update(orders)
      .set({ courierIndex, routeSeq: positionCase(orders.id, orders.routeSeq, seqItems) })
      .where(and(inArray(orders.id, stopIds), eq(orders.tenantId, tenantId)));
    return { courierIndex, count: stopIds.length };
  }

  /**
   * Reset the day back to full auto-distribution: clear every manual courier
   * pin AND manual stop order (route_seq) on the day's own-courier address
   * orders, so the next getRoute re-runs the geographic sweep-split from
   * scratch. Exists because setOrderSequence pins the WHOLE leg it saves (pin
   * and sequence must agree), so a single drag-reorder permanently opts that
   * leg's orders out of auto-balancing — with no bulk undo, a lopsided day
   * (e.g. 17 pinned vs 7 auto stops) could only be fixed by un-pinning orders
   * one at a time. Includes 'pending' (not just getRoute's 'confirmed') so a
   * pin left on a not-yet-confirmed order doesn't resurface on confirmation.
   */
  async resetDayOverrides(
    tenantId: string,
    date?: string,
  ): Promise<{ cleared: number; date: string }> {
    const day = date ?? bgToday();
    // scheduledForDay references deliverySlots.date, but an UPDATE can't
    // leftJoin (and UPDATE … FROM would inner-join, dropping slotless orders).
    // Same subselect-that-joins pattern as approveDeliveryWindows.
    const eligible = this.db
      .select({ id: orders.id })
      .from(orders)
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          inArray(orders.status, ['pending', 'confirmed']),
          eq(orders.deliveryType, 'address'),
          scheduledForDay(day),
          or(isNotNull(orders.courierIndex), isNotNull(orders.routeSeq)),
        ),
      );
    const res = await this.db
      .update(orders)
      .set({ courierIndex: null, routeSeq: null })
      .where(and(eq(orders.tenantId, tenantId), inArray(orders.id, eligible)))
      .returning({ id: orders.id });
    return { cleared: res.length, date: day };
  }

  // ── Delivery time windows (task #13) ──────────────────────────────────────

  /** This tenant's `settings.routing` blob (or {}), for window params. */
  private async routingSettings(tenantId: string): Promise<Record<string, any>> {
    const [t] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!t) throw new NotFoundException('Фермата не е намерена');
    return ((t.settings as Record<string, any> | null)?.routing as Record<string, any>) ?? {};
  }

  /**
   * Task #13 — generate a delivery time window per order for `date` from the
   * optimized per-courier routes, save each as a `draft`, and return the
   * proposal for the operator to review/edit. A stop's window is derived from
   * the day-start hour + its accumulated drive time along its courier's route +
   * per-stop handling time, snapped to the slot grid (default 1h). Uses exactly
   * the same getRoute the operator is viewing, so windows honour the current
   * courier split and any manual courier pins (task #6).
   */
  async generateDeliveryWindows(
    tenantId: string,
    date?: string,
    couriers?: number,
    endModes?: (RouteEndMode | undefined)[],
    startHour?: number,
  ): Promise<DeliveryWindowProposal> {
    const route = await this.getRoute(tenantId, date, undefined, couriers, endModes);
    const cfg = await this.routingSettings(tenantId);
    // The operator is asked the start hour each time in the modal; an explicit
    // `startHour` (0–23) wins over the saved settings.routing.dayStartHour,
    // which itself falls back to the 9:00 default. `?? undefined` keeps a valid
    // 0 (midnight) from being mistaken for "unset" by Number.isFinite.
    const requestedStart = Number.isFinite(Number(startHour)) ? Number(startHour) : null;
    const dayStartMin =
      (requestedStart != null
        ? requestedStart
        : Number.isFinite(Number(cfg.dayStartHour))
          ? Number(cfg.dayStartHour)
          : DEFAULT_DAY_START_HOUR) * 60;
    const slotMin =
      Number.isFinite(Number(cfg.slotSizeMin)) && Number(cfg.slotSizeMin) > 0
        ? Number(cfg.slotSizeMin)
        : DEFAULT_SLOT_MIN;
    const serviceMin =
      Number.isFinite(Number(cfg.serviceMin)) && Number(cfg.serviceMin) >= 0
        ? Number(cfg.serviceMin)
        : DEFAULT_SERVICE_MIN;

    const originPt: Pt | null =
      route.origin.lat != null && route.origin.lng != null
        ? { lat: route.origin.lat, lng: route.origin.lng }
        : null;

    const proposalCouriers: DeliveryWindowProposal['couriers'] = [];
    const updates: { id: string; start: string; end: string }[] = [];
    let withoutEmail = 0;

    for (const r of route.routes) {
      // Cumulative crow-flies distance origin→…→stop_i, a cheap proxy that splits
      // the leg's measured drive time across its stops (no extra Maps calls).
      const cumDist: number[] = [];
      let prev = originPt;
      let cum = 0;
      let lastLocated: Pt | null = null;
      for (const s of r.stops) {
        if (prev && s.lat != null && s.lng != null) {
          cum += haversineKm(prev, { lat: s.lat, lng: s.lng });
        }
        cumDist.push(cum);
        if (s.lat != null && s.lng != null) {
          prev = { lat: s.lat, lng: s.lng };
          lastLocated = prev;
        }
      }
      // `driveMin` below (measured total duration) includes the return-to-
      // depot/home leg whenever this courier's route has one (endMode !==
      // 'last'). `cum` above only covers origin→…→last-stop, so a route WITH
      // a return leg needs it added to the denominator too — otherwise every
      // stop's time-share ratio is computed against a too-small total, and
      // later stops (whose numerator already reflects the full, longer trip)
      // get an inflated share, pushing their windows systematically late.
      let totalDist = cum;
      if (r.endMode !== 'last' && lastLocated && r.endLat != null && r.endLng != null) {
        totalDist += haversineKm(lastLocated, { lat: r.endLat, lng: r.endLng });
      }
      const driveMin = r.totalDurationS != null ? r.totalDurationS / 60 : null;

      const stops: DeliveryWindowStop[] = r.stops.map((s, i) => {
        const driveToStop =
          driveMin != null && totalDist > 0
            ? (cumDist[i] / totalDist) * driveMin
            : (i + 1) * FALLBACK_LEG_MIN;
        const arrival = dayStartMin + driveToStop + i * serviceMin;
        let startMin = Math.floor(arrival / slotMin) * slotMin;
        let endMin = startMin + slotMin;
        if (endMin > MAX_WINDOW_END_MIN) {
          endMin = MAX_WINDOW_END_MIN;
          startMin = Math.max(0, endMin - slotMin);
        }
        const windowStart = minToHHMM(startMin);
        const windowEnd = minToHHMM(endMin);
        const hasEmail = !!s.email?.trim();
        if (!hasEmail) withoutEmail += 1;
        // Don't clobber an already-SENT window when the recomputed time is
        // identical — regenerating (e.g. after a late add/cancel elsewhere in
        // the day) must not reset a customer-notified stop back to 'draft'
        // (risking a duplicate notification on the next approve+notify pass)
        // unless the time actually changed.
        const unchangedSent =
          s.deliveryWindowStatus === 'sent' &&
          s.deliveryWindowStart === windowStart &&
          s.deliveryWindowEnd === windowEnd;
        if (!unchangedSent) {
          updates.push({ id: s.id, start: windowStart, end: windowEnd });
        }
        return { id: s.id, customer: s.customer, email: s.email, windowStart, windowEnd, hasEmail };
      });

      proposalCouriers.push({ courierIndex: r.courierIndex, name: r.name, stops });
    }

    // Persist as drafts (tenant-scoped) in ONE set-based UPDATE — a CASE per column
    // over the changed ids — instead of a per-order UPDATE round-trip in a loop. The
    // CASE has an arm for every id in `updates` and the WHERE is `id IN (updates)`, so
    // no matched row falls through to a NULL window.
    if (updates.length > 0) {
      const ids = updates.map((u) => u.id);
      const startCase = sql.join(
        updates.map((u) => sql`when ${orders.id} = ${u.id}::uuid then ${u.start}`),
        sql` `,
      );
      const endCase = sql.join(
        updates.map((u) => sql`when ${orders.id} = ${u.id}::uuid then ${u.end}`),
        sql` `,
      );
      await this.db
        .update(orders)
        .set({
          deliveryWindowStart: sql`case ${startCase} end`,
          deliveryWindowEnd: sql`case ${endCase} end`,
          deliveryWindowStatus: 'draft',
        })
        .where(and(inArray(orders.id, ids), eq(orders.tenantId, tenantId)));
    }

    return { date: route.date, slotMin, couriers: proposalCouriers, withoutEmail };
  }

  /**
   * Task #13 — operator lightly edits one order's window. Validates HH:MM and
   * re-arms an already-sent window (sent→approved) so a corrected time can be
   * re-notified. Tenant-scoped (foreign order = not found).
   */
  async updateDeliveryWindow(
    tenantId: string,
    orderId: string,
    input: { start: string; end: string },
  ): Promise<{ id: string; windowStart: string; windowEnd: string; status: string }> {
    const start = (input.start ?? '').slice(0, 5);
    const end = (input.end ?? '').slice(0, 5);
    if (!HHMM_RE.test(start) || !HHMM_RE.test(end)) {
      throw new BadRequestException('Часът трябва да е във формат ЧЧ:ММ');
    }
    if (end <= start) {
      throw new BadRequestException('Краят на интервала трябва да е след началото');
    }
    const [existing] = await this.db
      .select({ status: orders.deliveryWindowStatus })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
      .limit(1);
    if (!existing) throw new NotFoundException('Поръчката не е намерена');
    // Keep an approved window approved; re-arm a sent one; otherwise draft.
    const status =
      existing.status === 'approved' || existing.status === 'sent' ? 'approved' : 'draft';
    await this.db
      .update(orders)
      .set({ deliveryWindowStart: start, deliveryWindowEnd: end, deliveryWindowStatus: status })
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)));
    return { id: orderId, windowStart: start, windowEnd: end, status };
  }

  /**
   * Task #13 — approve every draft window for the day so it's ready to notify.
   * Only touches confirmed address-orders scheduled that day that have a window
   * and aren't already approved/sent.
   */
  async approveDeliveryWindows(
    tenantId: string,
    date?: string,
  ): Promise<{ approved: number; date: string }> {
    const day = date ?? bgToday();
    // scheduledForDay references deliverySlots.date, but an UPDATE can't leftJoin
    // (and UPDATE ... FROM would inner-join, dropping slotless orders). Compute the
    // eligible ids in a self-contained subselect that DOES join per scheduledForDay's
    // contract, then update by id — else Postgres throws "missing FROM-clause entry
    // for table delivery_slots". The slotless (createdAt) fallback branch is kept.
    const eligible = this.db
      .select({ id: orders.id })
      .from(orders)
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.status, 'confirmed'),
          eq(orders.deliveryType, 'address'),
          scheduledForDay(day),
          isNotNull(orders.deliveryWindowStart),
          or(isNull(orders.deliveryWindowStatus), eq(orders.deliveryWindowStatus, 'draft')),
        ),
      );
    const res = await this.db
      .update(orders)
      .set({ deliveryWindowStatus: 'approved' })
      .where(and(eq(orders.tenantId, tenantId), inArray(orders.id, eligible)))
      .returning({ id: orders.id });
    return { approved: res.length, date: day };
  }

  /**
   * Task #13 — email each customer their APPROVED delivery window, then mark the
   * order `sent` + stamp notifiedAt. Orders without an email are skipped (and
   * counted). Channel-extensible: a future ViberService slots in beside the email.
   */
  async notifyDeliveryWindows(
    tenantId: string,
    date?: string,
  ): Promise<{ sent: number; skipped: number; failed: number; total: number; date: string }> {
    const day = date ?? bgToday();
    const rows = await this.db
      .select({
        id: orders.id,
        email: orders.customerEmail,
        windowStart: orders.deliveryWindowStart,
        windowEnd: orders.deliveryWindowEnd,
      })
      .from(orders)
      // scheduledForDay references deliverySlots.date — join per its contract,
      // else Postgres throws "missing FROM-clause entry for table delivery_slots".
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.status, 'confirmed'),
          eq(orders.deliveryType, 'address'),
          scheduledForDay(day),
          eq(orders.deliveryWindowStatus, 'approved'),
          isNotNull(orders.deliveryWindowStart),
          // Only rows not already claimed by a prior/concurrent run — a claimed
          // row (notifiedAt set) whose email went out must never be re-picked.
          isNull(orders.deliveryWindowNotifiedAt),
        ),
      );

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    for (const r of rows) {
      if (!r.email?.trim()) {
        skipped += 1;
        continue;
      }
      // Claim the row BEFORE sending: an atomic compare-and-set on
      // (status='approved' AND notifiedAt IS NULL). This is the idempotency
      // guard — a concurrent run or a re-run of the same day loses the race and
      // skips, so no customer is ever emailed their window twice. If we don't win
      // the claim, someone else already owns this row.
      const [claimed] = await this.db
        .update(orders)
        .set({ deliveryWindowNotifiedAt: new Date() })
        .where(
          and(
            eq(orders.id, r.id),
            eq(orders.tenantId, tenantId),
            eq(orders.deliveryWindowStatus, 'approved'),
            isNull(orders.deliveryWindowNotifiedAt),
          ),
        )
        .returning({ id: orders.id });
      if (!claimed) {
        skipped += 1;
        continue;
      }
      try {
        await this.orderEmail.sendDeliveryWindow(
          r.id,
          hhmm(r.windowStart) ?? '',
          hhmm(r.windowEnd) ?? '',
          day,
        );
        await this.db
          .update(orders)
          .set({ deliveryWindowStatus: 'sent' })
          .where(and(eq(orders.id, r.id), eq(orders.tenantId, tenantId)));
        sent += 1;
      } catch (err) {
        this.logger.warn(`notifyDeliveryWindows: failed to notify order ${r.id}: ${err}`);
        // The email didn't go out — release the claim (notifiedAt → null) so the
        // row is 'approved' + unclaimed again and a later run retries it. No dup
        // (send failed), no permanent miss (row is retryable).
        await this.db
          .update(orders)
          .set({ deliveryWindowNotifiedAt: null })
          .where(and(eq(orders.id, r.id), eq(orders.tenantId, tenantId)));
        failed += 1;
        continue;
      }
    }
    return { sent, skipped, failed, total: rows.length, date: day };
  }
}
