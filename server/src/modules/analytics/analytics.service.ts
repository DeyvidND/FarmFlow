import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, gte, lt, sql, desc } from 'drizzle-orm';
import { type Database, siteEvents, orders } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { bgToday, bgDayBounds, BG_TZ } from '../../common/time/bg-time';
import {
  resolveWindow,
  pickBucket,
  buildAxis,
  type StatsBucket,
  type StatsRangeTag,
} from '../stats/stats.service';
import {
  visitorHash,
  deviceFromUA,
  isBot,
  referrerHost,
  buildFunnel,
  conversionPct,
  buildWeekdayPattern,
  buildTopPages,
  FUNNEL_ORDER,
  ANALYTICS_SPARSE_MIN,
  type FunnelKey,
  type FunnelStep,
  type WeekdayStat,
  type TopPageStat,
} from './analytics.helpers';

// ── Storefront analytics: cookieless event ingest + the aggregated summary the
//    farmer dashboard reads. Mirrors StatsService's conventions closely (same
//    window resolution, bucketing, and 90 s public cache), but the source table
//    is `site_events` (page views etc.) rather than orders. ───────────────────

const EVENT_TYPES: FunnelKey[] = [
  'page_view',
  'product_view',
  'add_to_cart',
  'checkout_start',
  'purchase',
];

// Mirrors stats.service.ts's private BUCKETS map (kept separate deliberately —
// don't touch that file to dedupe this). Keep in sync if that map ever changes.
const BUCKET_FMT: Record<StatsBucket, { trunc: string; fmt: string }> = {
  day: { trunc: 'day', fmt: 'YYYY-MM-DD' },
  week: { trunc: 'week', fmt: 'YYYY-MM-DD' },
  month: { trunc: 'month', fmt: 'YYYY-MM' },
};

/** Cache TTL — analytics tolerate 90 s of staleness (mirrors stats). */
const ANALYTICS_TTL = 90;

export interface TrackBody {
  type: FunnelKey;
  path?: string;
  pageLabel?: string;
  referrer?: string;
  productId?: string;
  orderId?: string;
  value?: number; // stotinki
}

export interface AnalyticsSummary {
  range: StatsRangeTag;
  bucket: StatsBucket;
  /** Resolved window (BG calendar dates, both inclusive). */
  from: string;
  to: string;
  /** Distinct visitors (page_view) in the current window. */
  visitors: number;
  /** Total page_view rows (not distinct visitors) in the current window. */
  pageViews: number;
  /** Distinct page_view visitors in the equal-length prior window — for the delta arrow. */
  prevVisitors: number;
  /** Distinct purchase-event visitors in the current window (analytics-tracked, cookieless). */
  purchases: number;
  /** Total real orders placed in the window (orders table, ground truth) — can exceed
   *  `purchases` (repeat buyers, phone/manual orders, missed beacon) or fall short (bots
   *  filtered out of `purchases` still placing real orders is rare but not impossible). */
  orderCount: number;
  conversionPct: number;
  prevConversionPct: number;
  funnel: FunnelStep[];
  sources: { host: string; visitors: number; purchases: number; conversionPct: number }[];
  topPages: TopPageStat[];
  devices: { mobile: number; desktop: number };
  points: { t: string; visitors: number; pageViews: number; purchases: number }[];
  weekdayPattern: WeekdayStat[];
  /** Too few visitors for the funnel/sources to mean anything — UI shows a gentle note. */
  sparse: boolean;
}

@Injectable()
export class AnalyticsService {
  private readonly log = new Logger(AnalyticsService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly cache: PublicCacheService,
    private readonly config: ConfigService,
  ) {}

  /** Ingest one storefront event. Best-effort: any validation miss is a silent
   *  no-op (the browser beacon must never see an error). Bots and unknown tenants
   *  are dropped. The raw IP is used only to derive the daily hash — never stored.
   *  A DB failure on insert is swallowed too (logged, not thrown) — the beacon
   *  must always get its 204 regardless of backend hiccups. */
  async track(slug: string, body: TrackBody, ip: string, ua: string): Promise<void> {
    if (isBot(ua)) return;
    if (!body || !EVENT_TYPES.includes(body.type)) return;

    let tenantId: string;
    try {
      const tenant = await this.cache.resolveTenant(this.db, slug);
      tenantId = tenant.id;
    } catch {
      return; // unknown slug → drop
    }

    const day = bgToday();
    const secret = this.config.get<string>('ANALYTICS_SALT', 'ff-analytics');
    const hash = visitorHash(ip, ua, day, tenantId, secret);

    // referrer host, but drop when it's our own storefront host (self-referral)
    let host = referrerHost(body.referrer);
    if (host && host.includes(slug)) host = null;

    try {
      await this.db.insert(siteEvents).values({
        tenantId,
        visitorHash: hash,
        eventType: body.type,
        path: body.path?.slice(0, 512) ?? null,
        pageLabel: body.pageLabel?.trim().slice(0, 60) || null,
        referrerHost: host,
        productId: body.productId ?? null,
        orderId: body.orderId ?? null,
        valueStotinki: typeof body.value === 'number' ? Math.round(body.value) : null,
        device: deviceFromUA(ua),
      });
    } catch (err) {
      this.log.warn(`track() insert failed for tenant ${tenantId}: ${err}`);
    }
  }

  /** Record a server-side confirmed-sale purchase event. Idempotent per orderId:
   *  skips insert if a purchase row already exists for this order (guards against
   *  double-emit — Stripe's twin webhooks, courier split, or a backfill re-run).
   *  Best-effort: any failure is logged, never thrown (must not break checkout /
   *  the webhook). device omitted → defaults to 'desktop' (unused on purchase rows:
   *  all device/weekday/series aggregations filter on page_view). */
  async recordPurchase(input: {
    tenantId: string;
    orderId: string;
    visitorHash: string;
    valueStotinki: number | null;
  }): Promise<void> {
    try {
      // Partial unique index site_events_purchase_order_uniq (tenant_id, order_id)
      // WHERE event_type='purchase' makes this atomic — Stripe's twin webhooks (or
      // a courier split / backfill re-run) racing here both hit the same conflict
      // target and only one row survives, instead of the old check-then-insert
      // (which could both observe "no row" and double-insert) that also had no
      // index on order_id and scanned every purchase row the tenant ever recorded.
      await this.db
        .insert(siteEvents)
        .values({
          tenantId: input.tenantId,
          visitorHash: input.visitorHash,
          eventType: 'purchase',
          orderId: input.orderId,
          valueStotinki: input.valueStotinki,
        })
        .onConflictDoNothing({
          target: [siteEvents.tenantId, siteEvents.orderId],
          // Conflict inference against a PARTIAL unique index must repeat its WHERE
          // predicate, or Postgres can't match the index and errors "there is no
          // unique or exclusion constraint matching the ON CONFLICT specification".
          where: sql`${siteEvents.eventType} = 'purchase'`,
        });
    } catch (err) {
      this.log.warn(`recordPurchase failed for order ${input.orderId}: ${err}`);
    }
  }

  /** Aggregate the analytics summary for a tenant + window. Cached 90 s. */
  async summary(
    tenantId: string,
    opts: { range?: string; from?: string; to?: string } = {},
  ): Promise<AnalyticsSummary> {
    const today = bgToday();
    const { from, to, range } = resolveWindow(opts, today);
    // Cache key: (tenantId, from, to), prefixed 'analytics:' — distinct from
    // stats.service.ts's 'stats:' prefix, so the two families never collide
    // even with identical suffixes.
    const cacheKey = `analytics:${tenantId}:${from}:${to}`;
    const cached = await this.cache.get<AnalyticsSummary>(cacheKey);
    if (cached) return cached;
    const result = await this.compute(tenantId, from, to, range);
    await this.cache.set(cacheKey, result, ANALYTICS_TTL);
    return result;
  }

  private async compute(
    tenantId: string,
    from: string,
    to: string,
    range: StatsRangeTag,
  ): Promise<AnalyticsSummary> {
    const bucket = pickBucket(from, to);
    const cfg = BUCKET_FMT[bucket];
    const axisKeys = buildAxis(bucket, from, to);

    const since = bgDayBounds(from).from;
    const toExcl = bgDayBounds(to).to;
    const spanMs = toExcl.getTime() - since.getTime();
    const prevSince = new Date(since.getTime() - spanMs);

    const inWin = and(
      eq(siteEvents.tenantId, tenantId),
      gte(siteEvents.createdAt, since),
      lt(siteEvents.createdAt, toExcl),
    );

    const pv = sql`${siteEvents.eventType} = 'page_view'`;
    const localTs = sql`(${siteEvents.createdAt} at time zone 'UTC' at time zone ${BG_TZ})`;

    // Buyers subquery instead of an app-collected hash list + inArray(): the
    // old approach ran a query BEFORE Promise.all, shipped every purchaser
    // hash back to Node, then re-sent them as an IN-list — a sequential
    // round-trip plus an N-hash payload crossing the wire twice. A join keeps
    // it entirely server-side and lets this run inside the same Promise.all
    // as everything else.
    const buyers = this.db
      .selectDistinct({ visitorHash: siteEvents.visitorHash })
      .from(siteEvents)
      .where(and(inWin, sql`${siteEvents.eventType} = 'purchase'`))
      .as('buyers');

    // ── Funnel: "deepest stage reached" per visitor, not independent per-event-
    //    type counts. add_to_cart fires from the shop listing too (not only the
    //    product page), so a visitor can add-to-cart without ever firing
    //    product_view — independent counts let a later step show MORE visitors
    //    than an earlier one ("150% от предната стъпка", a real bug hit live).
    //    Deepest-stage counts are monotonically non-increasing by construction:
    //    step i's count is "visitors whose deepest event ranked >= i", so step
    //    i+1 can never exceed step i. ──
    // The THEN branches are bound params with no type context, so Postgres
    // resolves the whole CASE as `text` — an explicit ::int cast is required
    // or the later `cur_deepest >= 0` comparisons fail with "operator does not
    // exist: text >= integer" (caught live against real Postgres).
    const stageWhens = FUNNEL_ORDER.map((s, i) => sql`when ${siteEvents.eventType} = ${s.key} then ${i}`);
    const stageRank = sql`(case ${sql.join(stageWhens, sql` `)} end)::int`;

    const perVisitor = this.db
      .select({
        visitorHash: siteEvents.visitorHash,
        curDeepest: sql<number>`max(${stageRank}) filter (where ${siteEvents.createdAt} >= ${since})`.as('cur_deepest'),
        prevDeepest: sql<number>`max(${stageRank}) filter (where ${siteEvents.createdAt} < ${since})`.as('prev_deepest'),
        curPageViewRows: sql<number>`count(*) filter (where ${pv} and ${siteEvents.createdAt} >= ${since})`.as(
          'cur_pv_rows',
        ),
      })
      .from(siteEvents)
      .where(
        and(eq(siteEvents.tenantId, tenantId), gte(siteEvents.createdAt, prevSince), lt(siteEvents.createdAt, toExcl)),
      )
      .groupBy(siteEvents.visitorHash)
      .as('per_visitor');

    const stageCountExprs = FUNNEL_ORDER.map(
      (_, i) => sql<number>`count(*) filter (where ${perVisitor.curDeepest} >= ${i})::int`,
    );
    const funnelP = this.db
      .select({
        stages: sql<number[]>`array[${sql.join(stageCountExprs, sql`, `)}]::int[]`,
        prevVisitors: sql<number>`count(*) filter (where ${perVisitor.prevDeepest} >= 0)::int`,
        prevPurchasers: sql<number>`count(*) filter (where ${perVisitor.prevDeepest} >= ${FUNNEL_ORDER.length - 1})::int`,
        pageViewRows: sql<number>`coalesce(sum(${perVisitor.curPageViewRows}), 0)::int`,
      })
      .from(perVisitor);

    // First-touch, one source per visitor: the earliest page_view's referrer
    // host, external preferred over null/direct. Sources previously counted
    // distinct visitors PER HOST independently, so one visitor with two
    // referrers in the window was counted under both — the sources list could
    // sum to more than the headline visitor count. This makes sources
    // partition visitors instead.
    const firstTouch = this.db
      .select({
        visitorHash: siteEvents.visitorHash,
        host: sql<string | null>`(array_agg(${siteEvents.referrerHost} order by (${siteEvents.referrerHost} is null) asc, ${siteEvents.createdAt} asc))[1]`.as(
          'host',
        ),
      })
      .from(siteEvents)
      .where(and(inWin, pv))
      .groupBy(siteEvents.visitorHash)
      .as('first_touch');

    const sourcesP = this.db
      .select({
        host: sql<string>`coalesce(${firstTouch.host}, 'директно')`,
        visitors: sql<number>`count(*)::int`,
        purchasers: sql<number>`count(${buyers.visitorHash})::int`,
      })
      .from(firstTouch)
      .leftJoin(buyers, eq(firstTouch.visitorHash, buyers.visitorHash))
      .groupBy(sql`1`)
      .orderBy(desc(sql`2`))
      .limit(6);

    // Raw exact-path counts, generously capped — the real top-6-known-routes
    // aggregation (collapsing dynamic segments, dropping non-route paths)
    // happens in JS via buildTopPages() below, so this just needs to comfortably
    // cover a small storefront's path cardinality in one window.
    const topPagesRawP = this.db
      .select({
        path: sql<string>`coalesce(${siteEvents.path}, '/')`,
        pageLabel: siteEvents.pageLabel,
        views: sql<number>`count(*)::int`,
      })
      .from(siteEvents)
      .where(and(inWin, pv))
      .groupBy(sql`1`, sql`2`)
      .orderBy(desc(sql`3`))
      .limit(500);

    const devicesP = this.db
      .select({
        device: siteEvents.device,
        visitors: sql<number>`count(distinct ${siteEvents.visitorHash})::int`,
      })
      .from(siteEvents)
      .where(and(inWin, pv))
      .groupBy(siteEvents.device);

    const weekdayP = this.db
      .select({
        pgDow: sql<number>`extract(dow from ${localTs})::int`,
        visitors: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${pv})::int`,
        purchasers: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${pv} and ${buyers.visitorHash} is not null)::int`,
      })
      .from(siteEvents)
      .leftJoin(buyers, eq(siteEvents.visitorHash, buyers.visitorHash))
      .where(inWin)
      .groupBy(sql`1`);

    const bucketExpr = sql<string>`to_char(date_trunc(${sql.raw(`'${cfg.trunc}'`)}, ${localTs}), ${sql.raw(`'${cfg.fmt}'`)})`;
    const seriesP = this.db
      .select({
        t: bucketExpr,
        visitors: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${pv})::int`,
        pageViews: sql<number>`count(*) filter (where ${pv})::int`,
        purchases: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${siteEvents.eventType} = 'purchase')::int`,
      })
      .from(siteEvents)
      .where(inWin)
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    // Headline "Посетители" = distinct page_view visitors (current + the equal
    // prior window for the delta) — the SAME definition the trend/sources/devices/
    // weekday queries use, so every card reconciles with the chart. The funnel's
    // stage-0 count stays on the deepest-stage model (funnelP) which keeps it
    // monotonic; the two agree for real traffic and diverge only by untracked
    // purchase-only visitors (e.g. backfilled historical orders with no page_view).
    const visitorsP = this.db
      .select({
        cur: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${pv} and ${siteEvents.createdAt} >= ${since})::int`,
        prev: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${pv} and ${siteEvents.createdAt} < ${since})::int`,
      })
      .from(siteEvents)
      .where(
        and(eq(siteEvents.tenantId, tenantId), gte(siteEvents.createdAt, prevSince), lt(siteEvents.createdAt, toExcl)),
      );

    const ordersP = this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), gte(orders.createdAt, since), lt(orders.createdAt, toExcl)));

    const [funnelRows, sources, topPagesRaw, deviceRows, seriesRows, weekdayRows, visitorRows, orderRows] =
      await Promise.all([funnelP, sourcesP, topPagesRawP, devicesP, seriesP, weekdayP, visitorsP, ordersP]);
    const topPages = buildTopPages(topPagesRaw);

    // funnelP is a whole-table aggregate over `per_visitor` (no GROUP BY) — one row.
    const funnelRow = funnelRows[0] ?? {
      stages: FUNNEL_ORDER.map(() => 0),
      prevVisitors: 0,
      prevPurchasers: 0,
      pageViewRows: 0,
    };
    const funnel = buildFunnel(funnelRow.stages);

    // Headline visitors = page_view-distinct (visitorsP), NOT the funnel's
    // deepest-stage stage-0 — so "Посетители" reconciles with the trend/sources.
    const visitorRow = visitorRows[0] ?? { cur: 0, prev: 0 };
    const visitors = visitorRow.cur;
    const prevVisitors = visitorRow.prev;
    const purchasesCur = funnelRow.stages[FUNNEL_ORDER.length - 1] ?? 0;
    const purchasesPrev = funnelRow.prevPurchasers;
    const pageViewRows = funnelRow.pageViewRows;

    const devices = {
      mobile: deviceRows.find((d) => d.device === 'mobile')?.visitors ?? 0,
      desktop: deviceRows.find((d) => d.device === 'desktop')?.visitors ?? 0,
    };

    const found = new Map(seriesRows.map((r) => [r.t, r]));
    const points = axisKeys.map((t) => {
      const r = found.get(t);
      return { t, visitors: r?.visitors ?? 0, pageViews: r?.pageViews ?? 0, purchases: r?.purchases ?? 0 };
    });

    const sourcesWithConversion = sources.map((s) => ({
      host: s.host,
      visitors: s.visitors,
      purchases: s.purchasers,
      conversionPct: conversionPct(s.purchasers, s.visitors),
    }));

    const weekdayPattern = buildWeekdayPattern(weekdayRows);

    return {
      range,
      bucket,
      from,
      to,
      visitors,
      pageViews: pageViewRows,
      prevVisitors,
      purchases: purchasesCur,
      orderCount: orderRows[0]?.count ?? 0,
      conversionPct: conversionPct(purchasesCur, visitors),
      prevConversionPct: conversionPct(purchasesPrev, prevVisitors),
      funnel,
      sources: sourcesWithConversion,
      topPages,
      devices,
      points,
      weekdayPattern,
      sparse: visitors < ANALYTICS_SPARSE_MIN,
    };
  }
}
