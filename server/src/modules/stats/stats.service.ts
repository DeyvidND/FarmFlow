import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { type Database, orders, orderItems } from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { BG_TZ, bgToday, bgAddDays, bgDayBounds } from '../../common/time/bg-time';

// ── Farmer-facing sales statistics. Everything here is derived from orders we
//    already store (no tracking infra). Companion to the operational dashboard:
//    the dashboard answers "what do I do today", this answers "how is the shop
//    doing over time". ──────────────────────────────────────────────────────

/** Below this many orders in the window the numbers are noise for a small farm —
 *  the UI hides the lists/loyalty and shows a "too early for conclusions" note. */
export const SPARSE_MIN = 8;

export type StatsRange = '7d' | '30d' | '90d' | '1y';
export type StatsBucket = 'day' | 'week' | 'month';

/** Per-range window length + chart bucketing. `trunc`/`fmt` are inlined into SQL,
 *  so they MUST come from this fixed map — never from request input. */
const RANGES: Record<
  StatsRange,
  { bucket: StatsBucket; trunc: 'day' | 'week' | 'month'; fmt: string }
> = {
  '7d': { bucket: 'day', trunc: 'day', fmt: 'YYYY-MM-DD' },
  '30d': { bucket: 'day', trunc: 'day', fmt: 'YYYY-MM-DD' },
  '90d': { bucket: 'week', trunc: 'week', fmt: 'YYYY-MM-DD' },
  '1y': { bucket: 'month', trunc: 'month', fmt: 'YYYY-MM' },
};

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

export interface StatsSummary {
  range: StatsRange;
  bucket: StatsBucket;
  /** Current window. */
  revenueStotinki: number;
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

/** The continuous bucket axis (keys, oldest→newest) + the BG date its window
 *  starts on. Pure given `today` (a BG 'YYYY-MM-DD'). */
export function buildStatsAxis(
  range: StatsRange,
  today: string,
): { keys: string[]; sinceDay: string } {
  const cfg = RANGES[range];

  if (cfg.bucket === 'day') {
    const span = range === '7d' ? 7 : 30;
    const start = bgAddDays(today, -(span - 1));
    const keys: string[] = [];
    for (let i = 0; i < span; i++) keys.push(bgAddDays(start, i));
    return { keys, sinceDay: keys[0] };
  }

  if (cfg.bucket === 'week') {
    // 13 ISO weeks (Mondays), oldest first.
    const thisMonday = mondayOf(today);
    const keys: string[] = [];
    for (let i = 12; i >= 0; i--) keys.push(bgAddDays(thisMonday, -i * 7));
    return { keys, sinceDay: keys[0] };
  }

  // month bucket → last 12 months.
  const firstThis = `${today.slice(0, 7)}-01`;
  const keys: string[] = [];
  let cur = addMonths(firstThis, -11);
  for (let i = 0; i < 12; i++) {
    keys.push(cur.slice(0, 7)); // 'YYYY-MM'
    cur = addMonths(cur, 1);
  }
  return { keys, sinceDay: `${keys[0]}-01` };
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

@Injectable()
export class StatsService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  async stats(tenantId: string, rangeInput?: string): Promise<StatsSummary> {
    const range = (rangeInput ?? '30d') as StatsRange;
    const cfg = RANGES[range];
    if (!cfg) throw new BadRequestException('Невалиден период');

    const today = bgToday();
    const axis = buildStatsAxis(range, today);
    const since = bgDayBounds(axis.sinceDay).from;
    // Equal-length window immediately before, for the delta arrows.
    const spanMs = Date.now() - since.getTime();
    const prevSince = new Date(since.getTime() - spanMs);

    // A sale is anything not cancelled (status may be NULL on legacy rows).
    const live = sql`${orders.status} is distinct from 'cancelled'`;
    // Customer identity for loyalty: phone, else email, else account id.
    const keyExpr = sql<string>`coalesce(nullif(${orders.customerPhone}, ''), nullif(${orders.customerEmail}, ''), ${orders.customerId}::text)`;

    // ── Headline aggregate: current + previous window in one filtered scan,
    //    served by the (tenant_id, created_at, id) index. ──
    const aggP = this.db
      .select({
        orderCount: sql<number>`count(*) filter (where ${orders.createdAt} >= ${since} and ${live})::int`,
        revenue: sql<number>`coalesce(sum(${orders.totalStotinki}) filter (where ${orders.createdAt} >= ${since} and ${live}), 0)::int`,
        prevOrderCount: sql<number>`count(*) filter (where ${orders.createdAt} >= ${prevSince} and ${orders.createdAt} < ${since} and ${live})::int`,
        prevRevenue: sql<number>`coalesce(sum(${orders.totalStotinki}) filter (where ${orders.createdAt} >= ${prevSince} and ${orders.createdAt} < ${since} and ${live}), 0)::int`,
      })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), gte(orders.createdAt, prevSince)));

    // ── Payment split (current window). ──
    const paymentP = this.db
      .select({
        method: orders.paymentMethod,
        count: sql<number>`count(*)::int`,
        revenue: sql<number>`coalesce(sum(${orders.totalStotinki}), 0)::int`,
      })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), gte(orders.createdAt, since), live))
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
      .where(and(eq(orders.tenantId, tenantId), gte(orders.createdAt, since), live))
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
        and(eq(orders.tenantId, tenantId), gte(orders.createdAt, since), live, sql`${keyExpr} is not null`),
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
        orders: sql<number>`count(*) filter (where ${live})::int`,
        revenueStotinki: sql<number>`coalesce(sum(${orders.totalStotinki}) filter (where ${live}), 0)::int`,
      })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), gte(orders.createdAt, since)))
      // Bucket is the first SELECT column — reference it by position (same reason
      // as topProducts above; the BG_TZ bound param breaks GROUP BY by expression).
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const [[agg], paymentRows, topProducts, winKeys, priorKeys, seriesRows] = await Promise.all([
      aggP,
      paymentP,
      topP,
      winKeysP,
      priorKeysP,
      seriesP,
    ]);

    const ret = computeReturning(
      winKeys.map((r) => r.k),
      priorKeys.map((r) => r.k),
    );
    const cod = paymentRows.find((r) => r.method === 'cod');
    const online = paymentRows.find((r) => r.method === 'online');

    const found = new Map(seriesRows.map((r) => [r.t, r]));
    const points: StatsPoint[] = axis.keys.map((t) => {
      const r = found.get(t);
      return { t, orders: r?.orders ?? 0, revenueStotinki: r?.revenueStotinki ?? 0 };
    });

    return {
      range,
      bucket: cfg.bucket,
      revenueStotinki: agg.revenue,
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
      sparse: agg.orderCount < SPARSE_MIN,
      points,
    };
  }
}
