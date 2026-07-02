import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, gte, lt, sql, desc } from 'drizzle-orm';
import { type Database, siteEvents } from '@fermeribg/db';
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
  ANALYTICS_SPARSE_MIN,
  type FunnelKey,
  type FunnelStep,
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
  /** Distinct purchase-event visitors in the current window. */
  purchases: number;
  conversionPct: number;
  prevConversionPct: number;
  funnel: FunnelStep[];
  sources: { host: string; visitors: number }[];
  topPages: { path: string; views: number }[];
  devices: { mobile: number; desktop: number };
  points: { t: string; visitors: number; pageViews: number }[];
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

    // ── Funnel + headline: distinct visitors per event type, current + previous
    //    window in one scan (mirrors stats.service.ts's aggP current+previous fusion). ──
    const funnelP = this.db
      .select({
        type: siteEvents.eventType,
        visitors: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${siteEvents.createdAt} >= ${since})::int`,
        prevVisitors: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${siteEvents.createdAt} < ${since})::int`,
        rows: sql<number>`count(*) filter (where ${siteEvents.createdAt} >= ${since})::int`,
      })
      .from(siteEvents)
      .where(
        and(eq(siteEvents.tenantId, tenantId), gte(siteEvents.createdAt, prevSince), lt(siteEvents.createdAt, toExcl)),
      )
      .groupBy(siteEvents.eventType);

    const sourcesP = this.db
      .select({
        host: sql<string>`coalesce(${siteEvents.referrerHost}, 'директно')`,
        visitors: sql<number>`count(distinct ${siteEvents.visitorHash})::int`,
      })
      .from(siteEvents)
      .where(and(inWin, pv))
      .groupBy(sql`1`)
      .orderBy(desc(sql`2`))
      .limit(6);

    const topPagesP = this.db
      .select({
        path: sql<string>`coalesce(${siteEvents.path}, '/')`,
        views: sql<number>`count(*)::int`,
      })
      .from(siteEvents)
      .where(and(inWin, pv))
      .groupBy(sql`1`)
      .orderBy(desc(sql`2`))
      .limit(6);

    const devicesP = this.db
      .select({
        device: siteEvents.device,
        visitors: sql<number>`count(distinct ${siteEvents.visitorHash})::int`,
      })
      .from(siteEvents)
      .where(and(inWin, pv))
      .groupBy(siteEvents.device);

    const localTs = sql`(${siteEvents.createdAt} at time zone 'UTC' at time zone ${BG_TZ})`;
    const bucketExpr = sql<string>`to_char(date_trunc(${sql.raw(`'${cfg.trunc}'`)}, ${localTs}), ${sql.raw(`'${cfg.fmt}'`)})`;
    const seriesP = this.db
      .select({
        t: bucketExpr,
        visitors: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${pv})::int`,
        pageViews: sql<number>`count(*) filter (where ${pv})::int`,
      })
      .from(siteEvents)
      .where(inWin)
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const [funnelRows, sources, topPages, deviceRows, seriesRows] = await Promise.all([
      funnelP,
      sourcesP,
      topPagesP,
      devicesP,
      seriesP,
    ]);

    const counts: Partial<Record<FunnelKey, number>> = {};
    const prevCounts: Partial<Record<FunnelKey, number>> = {};
    let pageViewRows = 0;
    for (const r of funnelRows) {
      counts[r.type as FunnelKey] = r.visitors;
      prevCounts[r.type as FunnelKey] = r.prevVisitors;
      if (r.type === 'page_view') pageViewRows = r.rows;
    }
    const funnel = buildFunnel(counts);

    const visitors = counts.page_view ?? 0;
    const prevVisitors = prevCounts.page_view ?? 0;
    const purchasesCur = counts.purchase ?? 0;
    const purchasesPrev = prevCounts.purchase ?? 0;
    const conversionPct = visitors > 0 ? Math.round((purchasesCur / visitors) * 1000) / 10 : 0;
    const prevConversionPct = prevVisitors > 0 ? Math.round((purchasesPrev / prevVisitors) * 1000) / 10 : 0;

    const devices = {
      mobile: deviceRows.find((d) => d.device === 'mobile')?.visitors ?? 0,
      desktop: deviceRows.find((d) => d.device === 'desktop')?.visitors ?? 0,
    };

    const found = new Map(seriesRows.map((r) => [r.t, r]));
    const points = axisKeys.map((t) => {
      const r = found.get(t);
      return { t, visitors: r?.visitors ?? 0, pageViews: r?.pageViews ?? 0 };
    });

    return {
      range,
      bucket,
      from,
      to,
      visitors,
      pageViews: pageViewRows,
      prevVisitors,
      purchases: purchasesCur,
      conversionPct,
      prevConversionPct,
      funnel,
      sources,
      topPages,
      devices,
      points,
      sparse: visitors < ANALYTICS_SPARSE_MIN,
    };
  }
}
