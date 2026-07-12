import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { and, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { type Database, orders, orderItems, products, deliverySlots, farmers, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { BG_TZ, bgToday, bgAddDays, bgDayBounds, bgDate, bgDateTz } from '../../common/time/bg-time';
import { readVendorFinance } from '../vendor-finance/vendor-finance.settings';

// ── Farmer-facing sales statistics. Everything here is derived from orders we
//    already store (no tracking infra). Companion to the operational dashboard:
//    the dashboard answers "what do I do today", this answers "how is the shop
//    doing over time". ──────────────────────────────────────────────────────

/** Below this many orders in the window the numbers are noise for a small farm —
 *  the UI hides the lists/loyalty and shows a "too early for conclusions" note. */
export const SPARSE_MIN = 8;

/** The four quick presets. A custom from→to range is also accepted (range tag
 *  'custom'); both paths resolve to a concrete [from, to] day window. */
export type StatsRange = '7d' | '30d' | '90d' | '1y';
export type StatsRangeTag = StatsRange | 'custom';
export type StatsBucket = 'day' | 'week' | 'month';

/** Preset → rolling window length in days (ending today). */
const PRESET_DAYS: Record<StatsRange, number> = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };

/** Chart bucketing per bucket. `trunc`/`fmt` are inlined into SQL, so they MUST
 *  come from this fixed map — never from request input. The bucket itself is
 *  derived server-side from the window span (see {@link pickBucket}). */
const BUCKETS: Record<StatsBucket, { trunc: 'day' | 'week' | 'month'; fmt: string }> = {
  day: { trunc: 'day', fmt: 'YYYY-MM-DD' },
  week: { trunc: 'week', fmt: 'YYYY-MM-DD' },
  month: { trunc: 'month', fmt: 'YYYY-MM' },
};

// Span thresholds (inclusive days) that pick the bucket granularity, and the
// hard cap on a custom range so bar counts and the SQL stay sane.
const DAY_MAX_SPAN = 62; //  ≤ ~2 months → daily bars
const WEEK_MAX_SPAN = 187; // ≤ ~6 months → weekly bars; beyond → monthly
export const MAX_RANGE_DAYS = 731; // 2 years

export interface StatsPoint {
  /** Bucket key: 'YYYY-MM-DD' for day/week, 'YYYY-MM' for month. */
  t: string;
  orders: number;
  revenueStotinki: number;
}

export interface TopProduct {
  name: string;
  quantity: number;
  revenueStotinki: number;
}

export interface WeekdayLoad {
  /** Postgres dow: 0=Sunday … 6=Saturday. */
  dow: number;
  orders: number;
  revenueStotinki: number;
}

export interface StatsSummary {
  range: StatsRangeTag;
  bucket: StatsBucket;
  /** Resolved window (BG calendar dates, both inclusive). */
  from: string;
  to: string;
  /** Current window. Product turnover only — delivery fees are excluded. */
  revenueStotinki: number;
  /** Delivery fees collected in the window (order total − product lines). Shown
   *  separately so the fixed self-delivery fee never inflates оборот. */
  deliveryRevenueStotinki: number;
  orderCount: number;
  avgOrderStotinki: number;
  /** Equal-length window immediately before — for the delta arrows. */
  prevRevenueStotinki: number;
  prevOrderCount: number;
  /** Distinct customers in the window (by phone→email→id), and how many of them
   *  had ordered before the window started ("returning"). */
  customerCount: number;
  returningCustomers: number;
  newCustomers: number;
  /** Money split by how the customer paid (наложен платеж vs карта). */
  codOrders: number;
  codRevenueStotinki: number;
  onlineOrders: number;
  onlineRevenueStotinki: number;
  topProducts: TopProduct[];
  /** Active products that sold least in the window (zero-sellers first) — the
   *  candidates to discount or drop. */
  slowProducts: TopProduct[];
  /** Orders + revenue per weekday (always 7 entries, dow 0..6) — which day is
   *  busiest, to plan delivery capacity. */
  weekdayLoad: WeekdayLoad[];
  /** Too few orders for the lists to mean anything — UI shows a gentle note. */
  sparse: boolean;
  points: StatsPoint[];
}

// ── Pure helpers (no DB) — unit-tested directly. ──────────────────────────────

/** ISO Monday ('YYYY-MM-DD') of the week containing `day`. */
function mondayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  return bgAddDays(day, -((dow + 6) % 7));
}

/** Add `n` months to a 'YYYY-MM-01' string, returning 'YYYY-MM-01'. */
function addMonths(firstOfMonth: string, n: number): string {
  const [y, m] = firstOfMonth.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

/** First day of the month containing `day` ('YYYY-MM-01'). */
function firstOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** True if `s` is a real 'YYYY-MM-DD' calendar date. */
export function isValidDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Inclusive number of calendar days in [from, to] (both 'YYYY-MM-DD'). */
export function daySpanInclusive(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}

/** Resolve the request into a concrete, validated [from, to] BG-day window.
 *  Custom from/to wins over a preset; both end no later than `today`. Throws
 *  BadRequest on a malformed, inverted, or too-wide custom range. Pure. */
export function resolveWindow(
  opts: { range?: string; from?: string; to?: string },
  today: string,
): { from: string; to: string; range: StatsRangeTag } {
  const { from, to } = opts;
  if (from != null || to != null) {
    if (!from || !to || !isValidDay(from) || !isValidDay(to)) {
      throw new BadRequestException('Невалиден период');
    }
    const end = to > today ? today : to; // clamp a future end to today
    if (from > end) throw new BadRequestException('Невалиден период');
    if (daySpanInclusive(from, end) > MAX_RANGE_DAYS) {
      throw new BadRequestException('Прекалено дълъг период (максимум 2 години)');
    }
    return { from, to: end, range: 'custom' };
  }
  const range = (opts.range ?? '30d') as StatsRange;
  const span = PRESET_DAYS[range];
  if (!span) throw new BadRequestException('Невалиден период');
  return { from: bgAddDays(today, -(span - 1)), to: today, range };
}

/** Bucket granularity for a window, by inclusive span. Derived server-side so
 *  the SQL `trunc`/`fmt` never come from request input. */
export function pickBucket(from: string, to: string): StatsBucket {
  const span = daySpanInclusive(from, to);
  if (span <= DAY_MAX_SPAN) return 'day';
  if (span <= WEEK_MAX_SPAN) return 'week';
  return 'month';
}

/** Continuous bucket axis covering [from, to], oldest→newest. Keys are
 *  'YYYY-MM-DD' for day/week (week = its Monday) and 'YYYY-MM' for month.
 *  Edge buckets may be partial — that's fine; the series query is clamped to
 *  the exact window so only in-range orders are counted into them. Pure. */
export function buildAxis(bucket: StatsBucket, from: string, to: string): string[] {
  const keys: string[] = [];
  if (bucket === 'day') {
    for (let d = from; d <= to; d = bgAddDays(d, 1)) keys.push(d);
    return keys;
  }
  if (bucket === 'week') {
    const end = mondayOf(to);
    for (let d = mondayOf(from); d <= end; d = bgAddDays(d, 7)) keys.push(d);
    return keys;
  }
  const end = firstOfMonth(to);
  for (let d = firstOfMonth(from); d <= end; d = addMonths(d, 1)) keys.push(d.slice(0, 7));
  return keys;
}

/** Loyalty split from the two distinct-key sets. `winKeys` are this window's
 *  customers; a customer is "returning" if their key is also in `priorKeys`
 *  (they had ordered before the window). Both arrays are already de-duplicated. */
export function computeReturning(
  winKeys: string[],
  priorKeys: string[],
): { customerCount: number; returningCustomers: number; newCustomers: number } {
  const prior = new Set(priorKeys);
  let returning = 0;
  for (const k of winKeys) if (prior.has(k)) returning++;
  return {
    customerCount: winKeys.length,
    returningCustomers: returning,
    newCustomers: winKeys.length - returning,
  };
}

/** Ensure all 7 weekdays (0=Sun..6=Sat) are present, ascending, zero-filled. */
export function fillWeekday(rows: WeekdayLoad[]): WeekdayLoad[] {
  const m = new Map(rows.map((r) => [r.dow, r]));
  return Array.from({ length: 7 }, (_, dow) => m.get(dow) ?? { dow, orders: 0, revenueStotinki: 0 });
}

/** Least-sold active products in the window — qty asc, then revenue asc, then
 *  name. Zero-sellers surface first: the ones to discount or drop. */
export function pickSlowProducts(active: TopProduct[], limit: number): TopProduct[] {
  return [...active]
    .sort(
      (a, b) =>
        a.quantity - b.quantity ||
        a.revenueStotinki - b.revenueStotinki ||
        a.name.localeCompare(b.name, 'bg'),
    )
    .slice(0, limit);
}

/** TTL for farmer stats cache (mirrors insights at 90 s). Analytics tolerate
 *  this much staleness; the key expires naturally — no write-bust needed. */
const STATS_TTL = 90;

// ── Task #9/#10: turnover history with an EXPLICIT, switchable basis + to-date /
//    platform-income / undelivered-split. A separate endpoint from {@link
//    StatsService.stats} (which stays basis-implicit = order-placed day, unchanged
//    — no regression for existing callers) so today's "Статистика" screen keeps
//    working exactly as before while a new "Оборот" section reads this one. ──────

/** Which calendar day an order counts on. 'placed' = today's implicit behaviour
 *  (created_at). 'delivery' = the scheduled slot day (fallback: created_at's BG
 *  day for slotless orders — same rule as production/payments/digests). 'delivered'
 *  = the day it was ACTUALLY marked delivered (orders.delivered_at); an order that
 *  hasn't been delivered yet has no day under this basis and drops out entirely. */
export type TurnoverBasis = 'placed' | 'delivery' | 'delivered';

export interface TurnoverPoint {
  t: string;
  revenueStotinki: number;
  orderCount: number;
}

export interface TurnoverBreakdown {
  basis: TurnoverBasis;
  range: StatsRangeTag;
  bucket: StatsBucket;
  from: string;
  to: string;
  /** Whether not-yet-delivered orders are folded into the money figures below
   *  (default true). Either way {@link undeliveredRevenueStotinki} /
   *  {@link undeliveredOrderCount} report the window's undelivered slice so the
   *  UI can show it even while it's excluded from the headline numbers. */
  includeUndelivered: boolean;
  /** This window's turnover (line-item money only — delivery fee excluded, same
   *  invariant as {@link StatsService.stats}), on the chosen basis. */
  turnoverStotinki: number;
  orderCount: number;
  /** Cumulative turnover from the start of history through the end of the window
   *  (`to`), same basis + includeUndelivered scope as the window figure. */
  turnoverToDateStotinki: number;
  /** Whether the (dormant-by-default) commission ledger is actually turned on for
   *  this tenant. `platformIncome*` below are honestly 0 while it is off — never a
   *  hypothetical "what it would earn". */
  commissionEnabled: boolean;
  /** The bps rate actually applied (farmer override if farmerId-scoped, else the
   *  tenant default) — 0 whenever `commissionEnabled` is false. */
  commissionRateBps: number;
  platformIncomeStotinki: number;
  platformIncomeToDateStotinki: number;
  /** This window's turnover/count coming from orders NOT YET delivered — always
   *  computed regardless of includeUndelivered (it IS the toggle's preview). On
   *  the 'delivered' basis this is always 0 (undelivered orders have no day, so
   *  they can never enter the window on that basis in the first place). */
  undeliveredRevenueStotinki: number;
  undeliveredOrderCount: number;
  points: TurnoverPoint[];
}

/** Cache TTL for the turnover breakdown — mirrors STATS_TTL. */
const TURNOVER_TTL = 90;

@Injectable()
export class StatsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly cache: PublicCacheService,
  ) {}

  async stats(
    tenantId: string,
    opts: { range?: string; from?: string; to?: string } = {},
  ): Promise<StatsSummary> {
    const today = bgToday();
    const { from, to, range } = resolveWindow(opts, today);

    // Cache key: (tenantId, from, to) — `from`/`to` are the resolved BG-day
    // strings, so preset aliases ('30d') map to the same key as the explicit
    // date pair for the same window. Keyed per-tenant (never cross-tenant).
    const cacheKey = `stats:${tenantId}:${from}:${to}`;
    const cachedStats = await this.cache.get<StatsSummary>(cacheKey);
    if (cachedStats) return cachedStats;
    const bucket = pickBucket(from, to);
    const cfg = BUCKETS[bucket];
    const axisKeys = buildAxis(bucket, from, to);

    // Exact window bounds [since, toExcl) — clamped to the picked from/to so
    // edge buckets only count in-range orders. Served by (tenant_id, created_at, id).
    const since = bgDayBounds(from).from;
    const toExcl = bgDayBounds(to).to;
    // Equal-length window immediately before, for the delta arrows.
    const spanMs = toExcl.getTime() - since.getTime();
    const prevSince = new Date(since.getTime() - spanMs);

    // A sale is anything not cancelled (status may be NULL on legacy rows).
    const live = sql`${orders.status} is distinct from 'cancelled'`;
    // Customer identity for loyalty: phone, else email, else account id.
    const keyExpr = sql<string>`coalesce(nullif(${orders.customerPhone}, ''), nullif(${orders.customerEmail}, ''), ${orders.customerId}::text)`;
    // Product turnover (оборот) = line money only — never the order total, which
    // also carries the delivery fee. Delivery is surfaced separately below.
    const lineRev = sql`${orderItems.quantity} * ${orderItems.priceStotinki}`;
    const inCur = sql`${orders.createdAt} >= ${since} and ${orders.createdAt} < ${toExcl} and ${live}`;
    const inPrev = sql`${orders.createdAt} >= ${prevSince} and ${orders.createdAt} < ${since} and ${live}`;

    // ── Headline aggregate: order counts + order TOTAL (incl. delivery), current
    //    + previous window in one scan served by (tenant_id, created_at, id). The
    //    total feeds the delivery split — product turnover comes from itemsAgg. ──
    const aggP = this.db
      .select({
        orderCount: sql<number>`count(*) filter (where ${inCur})::int`,
        total: sql<number>`coalesce(sum(${orders.totalStotinki}) filter (where ${inCur}), 0)::int`,
        prevOrderCount: sql<number>`count(*) filter (where ${inPrev})::int`,
      })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), gte(orders.createdAt, prevSince), lt(orders.createdAt, toExcl)));

    // ── Product turnover: line-item money for the same two windows (no products
    //    join, so line items of deleted products still count toward turnover). ──
    const itemsAggP = this.db
      .select({
        revenue: sql<number>`coalesce(sum(${lineRev}) filter (where ${inCur}), 0)::int`,
        prevRevenue: sql<number>`coalesce(sum(${lineRev}) filter (where ${inPrev}), 0)::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(eq(orders.tenantId, tenantId), gte(orders.createdAt, prevSince), lt(orders.createdAt, toExcl)));

    // ── Payment split (current window): product money by parent order method, so
    //    наложен платеж + карта sum back to оборот (delivery excluded). ──
    const paymentP = this.db
      .select({
        method: orders.paymentMethod,
        count: sql<number>`count(distinct ${orders.id})::int`,
        revenue: sql<number>`coalesce(sum(${lineRev}), 0)::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(eq(orders.tenantId, tenantId), gte(orders.createdAt, since), lt(orders.createdAt, toExcl), live))
      .groupBy(orders.paymentMethod);

    // ── Top products by sales revenue (line = quantity × unit price). ──
    const topP = this.db
      .select({
        name: sql<string>`coalesce(${orderItems.productName}, 'Без име')`,
        quantity: sql<number>`sum(${orderItems.quantity})::int`,
        revenueStotinki: sql<number>`sum(${orderItems.quantity} * ${orderItems.priceStotinki})::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(eq(orders.tenantId, tenantId), gte(orders.createdAt, since), lt(orders.createdAt, toExcl), live))
      // GROUP/ORDER BY output position (the name expr / revenue) — avoids
      // re-emitting the expressions and the param-placeholder drift it causes.
      .groupBy(sql`1`)
      .orderBy(sql`3 desc`)
      .limit(5);

    // ── Loyalty: distinct customer keys in the window vs before it. ──
    const winKeysP = this.db
      .selectDistinct({ k: keyExpr })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          gte(orders.createdAt, since),
          lt(orders.createdAt, toExcl),
          live,
          sql`${keyExpr} is not null`,
        ),
      );
    const priorKeysP = this.db
      .selectDistinct({ k: keyExpr })
      .from(orders)
      .where(
        and(eq(orders.tenantId, tenantId), lt(orders.createdAt, since), live, sql`${keyExpr} is not null`),
      );

    // ── Trend: orders + revenue per bucket, in Europe/Sofia local time so the
    //    buckets line up with the wall clock. Gaps filled in JS for a continuous
    //    line. Both metrics returned per point so the UI toggles without refetch. ──
    const localTs = sql`(${orders.createdAt} at time zone 'UTC' at time zone ${BG_TZ})`;
    const bucketExpr = sql<string>`to_char(date_trunc(${sql.raw(`'${cfg.trunc}'`)}, ${localTs}), ${sql.raw(`'${cfg.fmt}'`)})`;
    const seriesP = this.db
      .select({
        t: bucketExpr,
        orders: sql<number>`count(distinct ${orders.id}) filter (where ${live})::int`,
        revenueStotinki: sql<number>`coalesce(sum(${lineRev}) filter (where ${live}), 0)::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(eq(orders.tenantId, tenantId), gte(orders.createdAt, since), lt(orders.createdAt, toExcl)))
      // Bucket is the first SELECT column — reference it by position (same reason
      // as topProducts above; the BG_TZ bound param breaks GROUP BY by expression).
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    // ── Slow products: active catalog rows + how much each sold this window
    //    (joined in JS so zero-sellers are kept). ──
    const activeProductsP = this.db
      .select({ id: products.id, name: products.name, weight: products.weight })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.isActive, true)));

    const soldP = this.db
      .select({
        productId: orderItems.productId,
        qty: sql<number>`sum(${orderItems.quantity})::int`,
        revenue: sql<number>`sum(${orderItems.quantity} * ${orderItems.priceStotinki})::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          gte(orders.createdAt, since),
          lt(orders.createdAt, toExcl),
          live,
          sql`${orderItems.productId} is not null`,
        ),
      )
      .groupBy(orderItems.productId);

    // ── Weekday load: orders/revenue per BG-local weekday (capacity planning). ──
    const dowExpr = sql<number>`extract(dow from (${orders.createdAt} at time zone 'UTC' at time zone ${BG_TZ}))::int`;
    const weekdayP = this.db
      .select({
        dow: dowExpr,
        orders: sql<number>`count(distinct ${orders.id}) filter (where ${live})::int`,
        revenueStotinki: sql<number>`coalesce(sum(${lineRev}) filter (where ${live}), 0)::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(eq(orders.tenantId, tenantId), gte(orders.createdAt, since), lt(orders.createdAt, toExcl)))
      // dow carries the BG_TZ bound param — group/order by position (see above).
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const [[agg], [items], paymentRows, topProducts, winKeys, priorKeys, seriesRows, activeProducts, sold, weekdayRows] =
      await Promise.all([
        aggP,
        itemsAggP,
        paymentP,
        topP,
        winKeysP,
        priorKeysP,
        seriesP,
        activeProductsP,
        soldP,
        weekdayP,
      ]);

    const ret = computeReturning(
      winKeys.map((r) => r.k),
      priorKeys.map((r) => r.k),
    );
    const cod = paymentRows.find((r) => r.method === 'cod');
    const online = paymentRows.find((r) => r.method === 'online');

    const soldMap = new Map(sold.map((s) => [s.productId, s]));
    const slowProducts = pickSlowProducts(
      activeProducts.map((p) => {
        const s = soldMap.get(p.id);
        return {
          name: [p.name, p.weight].filter(Boolean).join(' '),
          quantity: s?.qty ?? 0,
          revenueStotinki: s?.revenue ?? 0,
        };
      }),
      5,
    );
    const weekdayLoad = fillWeekday(weekdayRows);

    const found = new Map(seriesRows.map((r) => [r.t, r]));
    const points: StatsPoint[] = axisKeys.map((t) => {
      const r = found.get(t);
      return { t, orders: r?.orders ?? 0, revenueStotinki: r?.revenueStotinki ?? 0 };
    });

    const result: StatsSummary = {
      range,
      bucket,
      from,
      to,
      revenueStotinki: items.revenue,
      // Delivery = order total − product lines (never below 0 on odd legacy rows).
      deliveryRevenueStotinki: Math.max(0, agg.total - items.revenue),
      orderCount: agg.orderCount,
      avgOrderStotinki: agg.orderCount ? Math.round(items.revenue / agg.orderCount) : 0,
      prevRevenueStotinki: items.prevRevenue,
      prevOrderCount: agg.prevOrderCount,
      customerCount: ret.customerCount,
      returningCustomers: ret.returningCustomers,
      newCustomers: ret.newCustomers,
      codOrders: cod?.count ?? 0,
      codRevenueStotinki: cod?.revenue ?? 0,
      onlineOrders: online?.count ?? 0,
      onlineRevenueStotinki: online?.revenue ?? 0,
      topProducts,
      slowProducts,
      weekdayLoad,
      sparse: agg.orderCount < SPARSE_MIN,
      points,
    };
    await this.cache.set(cacheKey, result, STATS_TTL);
    return result;
  }

  /** Per-producer turnover for a multi-farmer shop. Same shape as {@link stats}, but
   *  money/orders come from order_items joined to products filtered by farmer_id (a
   *  shared order counts for every producer in it; delivery is nobody's turnover).
   *  Uses the product's current farmer_id (no snapshot) — see the spec's v1 limit. */
  async statsForFarmer(
    tenantId: string,
    farmerId: string,
    opts: { range?: string; from?: string; to?: string } = {},
  ): Promise<StatsSummary> {
    const today = bgToday();
    const { from, to, range } = resolveWindow(opts, today);

    // Farmer-scoped cache key — includes farmerId so a producer sub-account
    // and the shop owner (who may pass a different farmerId) never share an entry.
    const cacheKey = `stats:${tenantId}:farmer:${farmerId}:${from}:${to}`;
    const cachedStats = await this.cache.get<StatsSummary>(cacheKey);
    if (cachedStats) return cachedStats;

    const bucket = pickBucket(from, to);
    const cfg = BUCKETS[bucket];
    const axisKeys = buildAxis(bucket, from, to);

    const since = bgDayBounds(from).from;
    const toExcl = bgDayBounds(to).to;
    const spanMs = toExcl.getTime() - since.getTime();
    const prevSince = new Date(since.getTime() - spanMs);

    const live = sql`${orders.status} is distinct from 'cancelled'`;
    const lineRev = sql`${orderItems.quantity} * ${orderItems.priceStotinki}`;
    const keyExpr = sql<string>`coalesce(nullif(${orders.customerPhone}, ''), nullif(${orders.customerEmail}, ''), ${orders.customerId}::text)`;
    // Reusable base: this producer's line items, in/around the window.
    const mine = and(eq(orders.tenantId, tenantId), eq(products.farmerId, farmerId));

    const inCur = sql`${orders.createdAt} >= ${since} and ${orders.createdAt} < ${toExcl} and ${live}`;
    const inPrev = sql`${orders.createdAt} >= ${prevSince} and ${orders.createdAt} < ${since} and ${live}`;

    // ── Headline: current + previous window, line-item money + distinct orders.
    //    The outer WHERE spans both windows in ONE scan; `live` lives in each
    //    per-window FILTER (not the WHERE) so cancelled orders drop from the totals
    //    while the scan still covers [prevSince, toExcl). (Mirrors stats().) ──
    const aggP = this.db
      .select({
        orderCount: sql<number>`count(distinct ${orders.id}) filter (where ${inCur})::int`,
        revenue: sql<number>`coalesce(sum(${lineRev}) filter (where ${inCur}), 0)::int`,
        prevOrderCount: sql<number>`count(distinct ${orders.id}) filter (where ${inPrev})::int`,
        prevRevenue: sql<number>`coalesce(sum(${lineRev}) filter (where ${inPrev}), 0)::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(mine, gte(orders.createdAt, prevSince), lt(orders.createdAt, toExcl)));

    // ── Payment split (current window): line-item money by parent order method. ──
    const paymentP = this.db
      .select({
        method: orders.paymentMethod,
        count: sql<number>`count(distinct ${orders.id})::int`,
        revenue: sql<number>`coalesce(sum(${lineRev}), 0)::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(mine, gte(orders.createdAt, since), lt(orders.createdAt, toExcl), live))
      .groupBy(orders.paymentMethod);

    // ── Top products (this producer's). ──
    const topP = this.db
      .select({
        name: sql<string>`coalesce(${orderItems.productName}, 'Без име')`,
        quantity: sql<number>`sum(${orderItems.quantity})::int`,
        revenueStotinki: sql<number>`sum(${lineRev})::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(mine, gte(orders.createdAt, since), lt(orders.createdAt, toExcl), live))
      .groupBy(sql`1`)
      .orderBy(sql`3 desc`)
      .limit(5);

    // ── Loyalty: distinct customers among this producer's orders, window vs before. ──
    const winKeysP = this.db
      .selectDistinct({ k: keyExpr })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(mine, gte(orders.createdAt, since), lt(orders.createdAt, toExcl), live, sql`${keyExpr} is not null`));
    const priorKeysP = this.db
      .selectDistinct({ k: keyExpr })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(mine, lt(orders.createdAt, since), live, sql`${keyExpr} is not null`));

    // ── Trend: line-item money + distinct orders per Sofia-local bucket. ──
    const localTs = sql`(${orders.createdAt} at time zone 'UTC' at time zone ${BG_TZ})`;
    const bucketExpr = sql<string>`to_char(date_trunc(${sql.raw(`'${cfg.trunc}'`)}, ${localTs}), ${sql.raw(`'${cfg.fmt}'`)})`;
    const seriesP = this.db
      .select({
        t: bucketExpr,
        orders: sql<number>`count(distinct ${orders.id}) filter (where ${live})::int`,
        revenueStotinki: sql<number>`coalesce(sum(${lineRev}) filter (where ${live}), 0)::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(mine, gte(orders.createdAt, since), lt(orders.createdAt, toExcl)))
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    // ── Slow products: this producer's active catalog + how much each sold. ──
    const activeProductsP = this.db
      .select({ id: products.id, name: products.name, weight: products.weight })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.farmerId, farmerId), eq(products.isActive, true)));
    const soldP = this.db
      .select({
        productId: orderItems.productId,
        qty: sql<number>`sum(${orderItems.quantity})::int`,
        revenue: sql<number>`sum(${lineRev})::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(mine, gte(orders.createdAt, since), lt(orders.createdAt, toExcl), live, sql`${orderItems.productId} is not null`))
      .groupBy(orderItems.productId);

    // ── Weekday load: line-item money + distinct orders per Sofia weekday. ──
    const dowExpr = sql<number>`extract(dow from (${orders.createdAt} at time zone 'UTC' at time zone ${BG_TZ}))::int`;
    const weekdayP = this.db
      .select({
        dow: dowExpr,
        orders: sql<number>`count(distinct ${orders.id}) filter (where ${live})::int`,
        revenueStotinki: sql<number>`coalesce(sum(${lineRev}) filter (where ${live}), 0)::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(mine, gte(orders.createdAt, since), lt(orders.createdAt, toExcl)))
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const [[agg], paymentRows, topProducts, winKeys, priorKeys, seriesRows, activeProducts, sold, weekdayRows] =
      await Promise.all([aggP, paymentP, topP, winKeysP, priorKeysP, seriesP, activeProductsP, soldP, weekdayP]);

    const ret = computeReturning(winKeys.map((r) => r.k), priorKeys.map((r) => r.k));
    const cod = paymentRows.find((r) => r.method === 'cod');
    const online = paymentRows.find((r) => r.method === 'online');

    const soldMap = new Map(sold.map((s) => [s.productId, s]));
    const slowProducts = pickSlowProducts(
      activeProducts.map((p) => {
        const s = soldMap.get(p.id);
        return {
          name: [p.name, p.weight].filter(Boolean).join(' '),
          quantity: s?.qty ?? 0,
          revenueStotinki: s?.revenue ?? 0,
        };
      }),
      5,
    );
    const weekdayLoad = fillWeekday(weekdayRows);

    const found = new Map(seriesRows.map((r) => [r.t, r]));
    const points: StatsPoint[] = axisKeys.map((t) => {
      const r = found.get(t);
      return { t, orders: r?.orders ?? 0, revenueStotinki: r?.revenueStotinki ?? 0 };
    });

    const farmerResult: StatsSummary = {
      range, bucket, from, to,
      revenueStotinki: agg.revenue,
      // A producer's turnover is already line-item only; delivery is never theirs.
      deliveryRevenueStotinki: 0,
      orderCount: agg.orderCount,
      avgOrderStotinki: agg.orderCount ? Math.round(agg.revenue / agg.orderCount) : 0,
      prevRevenueStotinki: agg.prevRevenue,
      prevOrderCount: agg.prevOrderCount,
      customerCount: ret.customerCount,
      returningCustomers: ret.returningCustomers,
      newCustomers: ret.newCustomers,
      codOrders: cod?.count ?? 0,
      codRevenueStotinki: cod?.revenue ?? 0,
      onlineOrders: online?.count ?? 0,
      onlineRevenueStotinki: online?.revenue ?? 0,
      topProducts,
      slowProducts,
      weekdayLoad,
      sparse: agg.orderCount < SPARSE_MIN,
      points,
    };
    await this.cache.set(cacheKey, farmerResult, STATS_TTL);
    return farmerResult;
  }

  /**
   * Task #9/#10: turnover reported against an explicit, switchable `basis`
   * (placed / delivery / delivered — see {@link TurnoverBasis}), plus lifetime
   * to-date sums, platform income (honestly 0 while the commission ledger is
   * dormant), and the undelivered slice + toggle. `farmerId` scopes to one
   * producer's line-item money (mirrors {@link statsForFarmer}'s attribution:
   * a shared order counts for every producer in it; delivery is nobody's
   * turnover). Unlike {@link stats}/{@link statsForFarmer} this is ONE method
   * for both scopes (optional farmerId) rather than two near-duplicates — the
   * basis-day expression and the includeUndelivered toggle apply identically
   * either way, so branching a single query keeps the FILTER-clause logic in
   * one place instead of two drifting copies.
   */
  async turnoverBreakdown(
    tenantId: string,
    opts: {
      range?: string;
      from?: string;
      to?: string;
      basis?: string;
      includeUndelivered?: boolean;
      farmerId?: string;
    } = {},
  ): Promise<TurnoverBreakdown> {
    const today = bgToday();
    const { from, to, range } = resolveWindow(opts, today);
    const basis: TurnoverBasis =
      opts.basis === 'delivery' || opts.basis === 'delivered' ? opts.basis : 'placed';
    const includeUndelivered = opts.includeUndelivered === true;
    const bucket = pickBucket(from, to);
    const cfg = BUCKETS[bucket];
    const axisKeys = buildAxis(bucket, from, to);

    const cacheKey = `turnover:${tenantId}:${opts.farmerId ?? 'all'}:${basis}:${includeUndelivered}:${from}:${to}`;
    const cached = await this.cache.get<TurnoverBreakdown>(cacheKey);
    if (cached) return cached;

    // A sale is anything not cancelled — same convention as stats()/statsForFarmer().
    const live = sql`${orders.status} is distinct from 'cancelled'`;
    // "Delivered" for the undelivered split/toggle is the fulfilment `status`, NOT
    // the chosen basis — even reporting turnover on the 'placed' basis, we still
    // need to know which of those placed orders have or haven't been delivered yet.
    const notDelivered = sql`${orders.status} is distinct from 'delivered'`;
    const lineRev = sql`${orderItems.quantity} * ${orderItems.priceStotinki}`;

    // Basis-day: the calendar day this order counts on. A 'delivered'-basis row
    // with no delivered_at yet (not delivered) produces SQL NULL here, so it
    // naturally never matches a `basisDay between/<= ...` predicate below —
    // correct: an undelivered order has no "delivered day" until it gets one.
    const basisDay: SQL =
      basis === 'placed'
        ? bgDate(orders.createdAt)
        : basis === 'delivery'
          ? sql`coalesce(${deliverySlots.date}, ${bgDate(orders.createdAt)})`
          : bgDateTz(orders.deliveredAt);

    const farmerScope = opts.farmerId ? eq(products.farmerId, opts.farmerId) : undefined;

    const windowRange = and(sql`${basisDay} >= ${from}::date`, sql`${basisDay} <= ${to}::date`)!;
    const toDateRange = sql`${basisDay} <= ${to}::date`;
    // When the toggle excludes undelivered orders, both the window and to-date
    // sums additionally require status='delivered'.
    const deliveredOnly = includeUndelivered ? undefined : sql`${orders.status} = 'delivered'`;

    const aggP = this.db
      .select({
        turnover: sql<number>`coalesce(sum(${lineRev}) filter (where ${and(windowRange, deliveredOnly)}), 0)::int`,
        orderCount: sql<number>`count(distinct ${orders.id}) filter (where ${and(windowRange, deliveredOnly)})::int`,
        toDate: sql<number>`coalesce(sum(${lineRev}) filter (where ${and(toDateRange, deliveredOnly)}), 0)::int`,
        undeliveredRevenue: sql<number>`coalesce(sum(${lineRev}) filter (where ${and(windowRange, notDelivered)}), 0)::int`,
        undeliveredCount: sql<number>`count(distinct ${orders.id}) filter (where ${and(windowRange, notDelivered)})::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .leftJoin(products, eq(products.id, orderItems.productId))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          live,
          farmerScope,
          // Bound the scan to "up to and including the window end" — the to-date
          // sum needs no lower bound (true lifetime cumulative), but nothing
          // beyond `to` is ever needed by any of the five aggregates above.
          toDateRange,
        ),
      );

    // ── Trend: one point per bucket, scoped to the window + includeUndelivered. ──
    const localBucketExpr = sql<string>`to_char(date_trunc(${sql.raw(`'${cfg.trunc}'`)}, ${basisDay}), ${sql.raw(`'${cfg.fmt}'`)})`;
    const seriesP = this.db
      .select({
        t: localBucketExpr,
        revenueStotinki: sql<number>`coalesce(sum(${lineRev}) filter (where ${deliveredOnly ?? sql`true`}), 0)::int`,
        orderCount: sql<number>`count(distinct ${orders.id}) filter (where ${deliveredOnly ?? sql`true`})::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .leftJoin(products, eq(products.id, orderItems.productId))
      .where(and(eq(orders.tenantId, tenantId), live, farmerScope, windowRange))
      // Bucket carries a bound param (cfg.trunc/fmt raw + the basisDay sub-expression)
      // — group/order by output position, matching the rest of this file's pattern.
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    // ── Platform income: dormant-aware commission rate. Farmer override (when
    //    farmerId-scoped) beats the tenant default; the whole thing reads 0 while
    //    commissionEnabled is false — never a hypothetical "what it would earn". ──
    const tenantP = this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const farmerRateP = opts.farmerId
      ? this.db
          .select({ commissionRateBps: farmers.commissionRateBps })
          .from(farmers)
          .where(eq(farmers.id, opts.farmerId))
          .limit(1)
      : Promise.resolve([] as { commissionRateBps: number | null }[]);

    const [[agg], seriesRows, [tenantRow], [farmerRow]] = await Promise.all([
      aggP,
      seriesP,
      tenantP,
      farmerRateP,
    ]);

    const vf = readVendorFinance(tenantRow?.settings);
    const overrideBps = farmerRow?.commissionRateBps;
    const rateBps = overrideBps != null ? overrideBps : vf.defaultCommissionRateBps;
    const commissionRateBps = vf.commissionEnabled ? rateBps : 0;
    const platformIncomeStotinki = Math.round((agg.turnover * commissionRateBps) / 10_000);
    const platformIncomeToDateStotinki = Math.round((agg.toDate * commissionRateBps) / 10_000);

    const found = new Map(seriesRows.map((r) => [r.t, r]));
    const points: TurnoverPoint[] = axisKeys.map((t) => {
      const r = found.get(t);
      return { t, revenueStotinki: r?.revenueStotinki ?? 0, orderCount: r?.orderCount ?? 0 };
    });

    const result: TurnoverBreakdown = {
      basis,
      range,
      bucket,
      from,
      to,
      includeUndelivered,
      turnoverStotinki: agg.turnover,
      orderCount: agg.orderCount,
      turnoverToDateStotinki: agg.toDate,
      commissionEnabled: vf.commissionEnabled,
      commissionRateBps,
      platformIncomeStotinki,
      platformIncomeToDateStotinki,
      undeliveredRevenueStotinki: agg.undeliveredRevenue,
      undeliveredOrderCount: agg.undeliveredCount,
      points,
    };
    await this.cache.set(cacheKey, result, TURNOVER_TTL);
    return result;
  }
}
