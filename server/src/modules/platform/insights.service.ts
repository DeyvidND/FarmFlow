import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';
import {
  type Database,
  tenants,
  orders,
  products,
  deliverySlots,
  reviews,
  articles,
  newsletterSubscribers,
} from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { BG_TZ, bgToday, bgAddDays, bgDayBounds } from '../../common/time/bg-time';

// ── Thresholds for the "needs attention" signals. Kept here (not a settings UI)
//    so they're trivial to tune in one place. ───────────────────────────────
const EMPTY_SHOP_DAYS = 7; // a farm this old with no products is stuck on onboarding
const DORMANT_DAYS = 30; // had orders, but silent this long → check in
const DROP_MIN_PREV = 3; // need a real prior week before "dropping" means anything
const DROP_RATIO = 0.5; // this week ≤ 50% of last week → flag a fall

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Both endpoints are full-table aggregates over every farm — uncacheable by index,
// so a short Redis TTL absorbs repeat super-admin loads. Analytics tolerate a
// minute of staleness; TTL-only (no write-bust) keeps it simple.
const INSIGHTS_TTL = 90;
const INSIGHTS_KEY = 'platform:insights';
const timeseriesKey = (range: string, tenantId?: string) =>
  `platform:timeseries:${range}:${tenantId ?? 'all'}`;

export type SignalKey =
  | 'empty_shop'
  | 'no_orders'
  | 'dormant'
  | 'dropping'
  | 'stripe_incomplete'
  | 'econt_incomplete';

export interface FarmSignal {
  key: SignalKey;
  /** Plain-Bulgarian reason shown to the operator. */
  label: string;
  /** Suggested next action (what to help the farm with). */
  action: string;
  /** Higher = more urgent; used to sort farms + their chips. */
  severity: number;
}

export interface FarmSignals {
  tenantId: string;
  name: string;
  slug: string;
  phone: string | null;
  email: string | null;
  signals: FarmSignal[];
  maxSeverity: number;
}

export interface AdoptionRow {
  key: string;
  label: string;
  count: number;
  total: number;
  /** 0–100, rounded. */
  pct: number;
}

export interface PlatformInsights {
  totalFarms: number;
  /** Lightweight list for the trend chart's farm-scope dropdown. */
  farms: { id: string; name: string }[];
  signals: FarmSignals[];
  adoption: AdoptionRow[];
}

export type TimeseriesRange = '7d' | '30d' | '90d' | '1y' | 'all';
export type TimeseriesBucket = 'day' | 'week' | 'month';

export interface TimeseriesPoint {
  /** Bucket key: 'YYYY-MM-DD' for day/week, 'YYYY-MM' for month. */
  t: string;
  orders: number;
  revenueStotinki: number;
}

export interface PlatformTimeseries {
  range: TimeseriesRange;
  bucket: TimeseriesBucket;
  points: TimeseriesPoint[];
}

/** Per-range bucket config. The `trunc`/format literals are inlined into SQL, so
 *  they MUST come from this fixed map — never from request input. */
const RANGE_CONFIG: Record<
  TimeseriesRange,
  { bucket: TimeseriesBucket; trunc: 'day' | 'week' | 'month'; fmt: string }
> = {
  '7d': { bucket: 'day', trunc: 'day', fmt: 'YYYY-MM-DD' },
  '30d': { bucket: 'day', trunc: 'day', fmt: 'YYYY-MM-DD' },
  '90d': { bucket: 'week', trunc: 'week', fmt: 'YYYY-MM-DD' },
  '1y': { bucket: 'month', trunc: 'month', fmt: 'YYYY-MM' },
  all: { bucket: 'month', trunc: 'month', fmt: 'YYYY-MM' },
};

// ── Pure classification core (no DB) — the fetched aggregate rows in, the
//    signals + adoption out. Extracted so it can be unit-tested directly. ──

export interface InsightsTenantRow {
  id: string;
  name: string;
  slug: string;
  phone: string | null;
  email: string | null;
  createdAt: Date | null;
  deliveryEnabled: boolean;
  multiFarmer: boolean;
  multiSubcat: boolean;
  productOfWeekEnabled: boolean;
  stripeAccountId: string | null;
  stripeChargesEnabled: boolean;
  settings: unknown;
}

export interface InsightsInput {
  tenants: InsightsTenantRow[];
  orders: { tenantId: string | null; total: number; lastOrderAt: Date | null; last7: number; prev7: number }[];
  products: { tenantId: string | null; active: number }[];
  slots: { tenantId: string | null; count: number }[];
  reviews: { tenantId: string | null; published: number }[];
  articles: { tenantId: string | null; published: number }[];
  subs: { tenantId: string | null; active: number }[];
}

export function computeInsights(input: InsightsInput, nowMs: number): PlatformInsights {
  const byTenant = <T extends { tenantId: string | null }>(rows: T[]) => {
    const m = new Map<string, T>();
    for (const r of rows) if (r.tenantId) m.set(r.tenantId, r);
    return m;
  };
  const oMap = byTenant(input.orders);
  const pMap = byTenant(input.products);
  const slMap = byTenant(input.slots);
  const rMap = byTenant(input.reviews);
  const aMap = byTenant(input.articles);
  const sMap = byTenant(input.subs);

  const daysSince = (d: Date | null) => (d ? (nowMs - new Date(d).getTime()) / 86_400_000 : Infinity);

  const signals: FarmSignals[] = [];
  let cDelivery = 0,
    cEcont = 0,
    cStripe = 0,
    cSlots = 0,
    cNewsletter = 0,
    cReviews = 0,
    cArticles = 0,
    cMultiFarmer = 0,
    cMultiSubcat = 0,
    cPotw = 0;

  for (const t of input.tenants) {
    const o = oMap.get(t.id);
    const activeProducts = pMap.get(t.id)?.active ?? 0;
    const totalOrders = o?.total ?? 0;
    const last7 = o?.last7 ?? 0;
    const prev7 = o?.prev7 ?? 0;
    const lastOrderAt = o?.lastOrderAt ?? null;
    const slots = slMap.get(t.id)?.count ?? 0;
    const publishedReviews = rMap.get(t.id)?.published ?? 0;
    const publishedArticles = aMap.get(t.id)?.published ?? 0;
    const activeSubs = sMap.get(t.id)?.active ?? 0;

    const settings = (t.settings as Record<string, any> | null) ?? {};
    const econt = settings?.delivery?.econt as Record<string, any> | undefined;
    const econtConfigured = econt?.configured === true;
    const econtStarted = !!econt && !econtConfigured && (!!econt.username || !!econt.passwordEnc);

    // ── Adoption: count "really used", not merely toggled. ──
    if (t.deliveryEnabled) cDelivery++;
    if (econtConfigured) cEcont++;
    if (t.stripeChargesEnabled) cStripe++;
    if (slots > 0) cSlots++;
    if (activeSubs > 0) cNewsletter++;
    if (publishedReviews > 0) cReviews++;
    if (publishedArticles > 0) cArticles++;
    if (t.multiFarmer) cMultiFarmer++;
    if (t.multiSubcat) cMultiSubcat++;
    if (t.productOfWeekEnabled) cPotw++;

    // ── Signals: who needs attention + why. ──
    const farmSignals: FarmSignal[] = [];
    const ageDays = daysSince(t.createdAt);

    if (activeProducts === 0 && ageDays > EMPTY_SHOP_DAYS) {
      farmSignals.push({
        key: 'empty_shop',
        label: 'Регистрирана, но няма активни продукти',
        action: 'Помогни да качи продукти',
        severity: 90,
      });
    } else if (activeProducts > 0 && totalOrders === 0) {
      // Only meaningful once there IS a catalog to order from.
      farmSignals.push({
        key: 'no_orders',
        label: 'Има продукти, но нито една поръчка',
        action: 'Сподели линка / помогни с маркетинг',
        severity: 70,
      });
    }

    if (t.stripeAccountId && !t.stripeChargesEnabled) {
      farmSignals.push({
        key: 'stripe_incomplete',
        label: 'Stripe е започнат, но картовите плащания не работят',
        action: 'Довърши настройката на картовите плащания',
        severity: 65,
      });
    }

    if (econtStarted) {
      farmSignals.push({
        key: 'econt_incomplete',
        label: 'Econt е започнат, но не е завършен',
        action: 'Довърши Econt доставката',
        severity: 55,
      });
    }

    if (totalOrders > 0 && daysSince(lastOrderAt) > DORMANT_DAYS) {
      farmSignals.push({
        key: 'dormant',
        label: `Няма поръчки от над ${DORMANT_DAYS} дни`,
        action: 'Обади се и виж какво става',
        severity: 60,
      });
    } else if (prev7 >= DROP_MIN_PREV && last7 <= prev7 * DROP_RATIO) {
      // Don't double-flag a dormant farm as "dropping".
      farmSignals.push({
        key: 'dropping',
        label: 'Поръчките падат рязко тази седмица',
        action: 'Провери защо намаляват',
        severity: 50,
      });
    }

    if (farmSignals.length > 0) {
      farmSignals.sort((a, b) => b.severity - a.severity);
      signals.push({
        tenantId: t.id,
        name: t.name,
        slug: t.slug,
        phone: t.phone,
        email: t.email,
        signals: farmSignals,
        maxSeverity: farmSignals[0].severity,
      });
    }
  }

  signals.sort((a, b) => b.maxSeverity - a.maxSeverity || a.name.localeCompare(b.name, 'bg'));

  const total = input.tenants.length;
  const pct = (c: number) => (total === 0 ? 0 : Math.round((c / total) * 100));
  const adoption: AdoptionRow[] = [
    { key: 'delivery', label: 'Доставка', count: cDelivery },
    { key: 'econt', label: 'Econt', count: cEcont },
    { key: 'stripe', label: 'Картови плащания', count: cStripe },
    { key: 'slots', label: 'Часове за доставка', count: cSlots },
    { key: 'newsletter', label: 'Бюлетин', count: cNewsletter },
    { key: 'reviews', label: 'Отзиви', count: cReviews },
    { key: 'articles', label: 'Новини', count: cArticles },
    { key: 'multiFarmer', label: 'Множество фермери', count: cMultiFarmer },
    { key: 'multiSubcat', label: 'Подкатегории', count: cMultiSubcat },
    { key: 'potw', label: 'Продукт на седмицата', count: cPotw },
  ]
    .map((r) => ({ ...r, total, pct: pct(r.count) }))
    // Least-used first — the gaps the operator can act on.
    .sort((a, b) => a.pct - b.pct || a.count - b.count);

  return {
    totalFarms: total,
    farms: input.tenants.map((t) => ({ id: t.id, name: t.name })),
    signals,
    adoption,
  };
}

@Injectable()
export class PlatformInsightsService {
  /**
   * In-process single-flight guards: when the Redis TTL expires and several
   * concurrent requests reach the cache-miss branch simultaneously, only one
   * recompute runs; all others await the same shared Promise. Keys mirror the
   * Redis cache keys so they are naturally namespaced (insights vs timeseries).
   * The entry is deleted from the map once the promise settles so subsequent
   * requests after the TTL expires get a fresh compute. This avoids the Redis-
   * lock edge cases (lock holder crash, clock skew) while keeping the code
   * simple — the audience is at most a handful of super-admin tabs.
   */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly cache: PublicCacheService,
  ) {}

  /**
   * One snapshot powering the super-admin "Анализ" screen:
   *  - `signals`  → farms that need attention (who to call + why), derived only
   *                 from data we already store (no event tracking).
   *  - `adoption` → platform-wide "real use" of each feature (least-used first).
   *  - `farms`    → id+name list for the trend chart's scope dropdown.
   */
  async insights(): Promise<PlatformInsights> {
    const cached = await this.cache.get<PlatformInsights>(INSIGHTS_KEY);
    if (cached) return cached;

    // Single-flight: coalesce concurrent cache-miss recomputes into one.
    const inflight = this.inflight.get(INSIGHTS_KEY) as Promise<PlatformInsights> | undefined;
    if (inflight) return inflight;

    const compute = this.computeInsights().finally(() => this.inflight.delete(INSIGHTS_KEY));
    this.inflight.set(INSIGHTS_KEY, compute);
    return compute;
  }

  private async computeInsights(): Promise<PlatformInsights> {

    // Independent aggregates — run concurrently, stitch in JS (mirrors tenantDetail).
    const tenantsP = this.db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        phone: tenants.phone,
        email: tenants.email,
        createdAt: tenants.createdAt,
        deliveryEnabled: tenants.deliveryEnabled,
        multiFarmer: tenants.multiFarmer,
        multiSubcat: tenants.multiSubcat,
        productOfWeekEnabled: tenants.productOfWeekEnabled,
        stripeAccountId: tenants.stripeAccountId,
        stripeChargesEnabled: tenants.stripeChargesEnabled,
        settings: tenants.settings,
      })
      .from(tenants)
      .orderBy(tenants.name);

    const ordersP = this.db
      .select({
        tenantId: orders.tenantId,
        total: sql<number>`count(*)::int`,
        lastOrderAt: sql<Date | null>`max(${orders.createdAt})`,
        last7: sql<number>`count(*) filter (where ${orders.createdAt} >= now() - interval '7 days')::int`,
        prev7: sql<number>`count(*) filter (where ${orders.createdAt} >= now() - interval '14 days' and ${orders.createdAt} < now() - interval '7 days')::int`,
      })
      .from(orders)
      .groupBy(orders.tenantId);

    const productsP = this.db
      .select({
        tenantId: products.tenantId,
        active: sql<number>`count(*) filter (where ${products.isActive})::int`,
      })
      .from(products)
      .groupBy(products.tenantId);

    const slotsP = this.db
      .select({
        tenantId: deliverySlots.tenantId,
        count: sql<number>`count(*)::int`,
      })
      .from(deliverySlots)
      .groupBy(deliverySlots.tenantId);

    const reviewsP = this.db
      .select({
        tenantId: reviews.tenantId,
        published: sql<number>`count(*) filter (where ${reviews.status} = 'published')::int`,
      })
      .from(reviews)
      .groupBy(reviews.tenantId);

    const articlesP = this.db
      .select({
        tenantId: articles.tenantId,
        published: sql<number>`count(*) filter (where ${articles.status} = 'published')::int`,
      })
      .from(articles)
      .groupBy(articles.tenantId);

    const subsP = this.db
      .select({
        tenantId: newsletterSubscribers.tenantId,
        active: sql<number>`count(*) filter (where ${newsletterSubscribers.unsubscribedAt} is null)::int`,
      })
      .from(newsletterSubscribers)
      .groupBy(newsletterSubscribers.tenantId);

    const [tRows, oRows, pRows, slRows, rRows, aRows, sRows] = await Promise.all([
      tenantsP,
      ordersP,
      productsP,
      slotsP,
      reviewsP,
      articlesP,
      subsP,
    ]);

    const result = computeInsights(
      {
        tenants: tRows,
        orders: oRows,
        products: pRows,
        slots: slRows,
        reviews: rRows,
        articles: aRows,
        subs: sRows,
      },
      Date.now(),
    );
    await this.cache.set(INSIGHTS_KEY, result, INSIGHTS_TTL);
    return result;
  }

  /**
   * Orders + revenue over time, bucketed in Europe/Sofia local time so buckets
   * line up with the wall clock (consistent with bg-time.ts). Gaps are filled in
   * JS so the line is continuous. Both metrics are returned per point — the UI
   * toggles Поръчки/Приход without a refetch.
   */
  async timeseries(rangeInput: string, tenantIdInput?: string): Promise<PlatformTimeseries> {
    const range = rangeInput as TimeseriesRange;
    const cfg = RANGE_CONFIG[range];
    if (!cfg) throw new BadRequestException('Невалиден период');

    // `tenantId` lands in a uuid column — drop anything that isn't one (→ all farms).
    const tenantId = tenantIdInput && UUID_RE.test(tenantIdInput) ? tenantIdInput : undefined;

    // Cache keyed by the normalized (range, tenantId) — the only inputs that change
    // the result. A scope/range switch in the UI is a fresh key; same view repeats hit Redis.
    const cacheKey = timeseriesKey(range, tenantId);
    const cached = await this.cache.get<PlatformTimeseries>(cacheKey);
    if (cached) return cached;

    // Single-flight: coalesce concurrent cache-miss recomputes into one.
    const inflight = this.inflight.get(cacheKey) as Promise<PlatformTimeseries> | undefined;
    if (inflight) return inflight;

    const compute = this.computeTimeseries(range, cfg, tenantId, cacheKey).finally(() =>
      this.inflight.delete(cacheKey),
    );
    this.inflight.set(cacheKey, compute);
    return compute;
  }

  private async computeTimeseries(
    range: TimeseriesRange,
    cfg: { bucket: TimeseriesBucket; trunc: 'day' | 'week' | 'month'; fmt: string },
    tenantId: string | undefined,
    cacheKey: string,
  ): Promise<PlatformTimeseries> {
    // Bucket key produced in SQL — must match the JS axis keys below exactly.
    const localTs = sql`(${orders.createdAt} at time zone 'UTC' at time zone ${BG_TZ})`;
    const bucketExpr = sql<string>`to_char(date_trunc(${sql.raw(`'${cfg.trunc}'`)}, ${localTs}), ${sql.raw(`'${cfg.fmt}'`)})`;

    const axis = await this.buildAxis(range, cfg.bucket, tenantId);

    const where =
      axis.since !== null
        ? tenantId
          ? and(gte(orders.createdAt, axis.since), eq(orders.tenantId, tenantId))
          : gte(orders.createdAt, axis.since)
        : tenantId
          ? eq(orders.tenantId, tenantId)
          : undefined;

    const rows = await this.db
      .select({
        t: bucketExpr,
        orders: sql<number>`count(*)::int`,
        revenueStotinki: sql<number>`coalesce(sum(${orders.totalStotinki}) filter (where ${orders.status} is distinct from 'cancelled'), 0)::int`,
      })
      .from(orders)
      .where(where)
      // Group/order by the SELECT's first output column (the bucket). Referencing
      // it by position avoids re-emitting `bucketExpr` — whose embedded BG_TZ bound
      // param would get a fresh placeholder ($1 vs $3) each time, making Postgres
      // treat the GROUP BY expression as different from the SELECT and reject it.
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const found = new Map(rows.map((r) => [r.t, r]));
    const points: TimeseriesPoint[] = axis.keys.map((t) => {
      const r = found.get(t);
      return { t, orders: r?.orders ?? 0, revenueStotinki: r?.revenueStotinki ?? 0 };
    });

    const result: PlatformTimeseries = { range, bucket: cfg.bucket, points };
    await this.cache.set(cacheKey, result, INSIGHTS_TTL);
    return result;
  }

  /** The continuous bucket axis (keys) + the UTC lower bound to filter on. For
   *  'all', the axis starts at the earliest order's month (or just this month if
   *  there are none). */
  private async buildAxis(
    range: TimeseriesRange,
    bucket: TimeseriesBucket,
    tenantId?: string,
  ): Promise<{ keys: string[]; since: Date | null }> {
    const today = bgToday(); // 'YYYY-MM-DD' in Sofia local time

    if (bucket === 'day') {
      const span = range === '7d' ? 6 : 29;
      const startDay = bgAddDays(today, -span);
      const keys: string[] = [];
      for (let i = 0; i <= span; i++) keys.push(bgAddDays(startDay, i));
      return { keys, since: bgDayBounds(startDay).from };
    }

    if (bucket === 'week') {
      // 13 ISO weeks (Mondays), oldest first.
      const thisMonday = mondayOf(today);
      const keys: string[] = [];
      for (let i = 12; i >= 0; i--) keys.push(bgAddDays(thisMonday, -i * 7));
      return { keys, since: bgDayBounds(keys[0]).from };
    }

    // month bucket → '1y' (12 months) or 'all' (from earliest order).
    let startMonth: string; // 'YYYY-MM-01'
    if (range === 'all') {
      const [row] = await this.db
        .select({ min: sql<Date | null>`min(${orders.createdAt})` })
        .from(orders)
        .where(tenantId ? eq(orders.tenantId, tenantId) : undefined);
      startMonth = row?.min ? firstOfMonth(toSofiaDay(row.min)) : firstOfMonth(today);
    } else {
      startMonth = addMonths(firstOfMonth(today), -11);
    }
    const keys: string[] = [];
    let cur = startMonth;
    const end = firstOfMonth(today);
    // Cap to avoid pathological ranges if a very old order exists.
    for (let i = 0; i < 600 && cur <= end; i++) {
      keys.push(cur.slice(0, 7)); // 'YYYY-MM'
      cur = addMonths(cur, 1);
    }
    return { keys, since: bgDayBounds(startMonth).from };
  }
}

// ── Pure date helpers (Sofia-local date strings, tz-safe arithmetic). ──

/** ISO Monday ('YYYY-MM-DD') of the week containing `day`. */
export function mondayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  const offset = (dow + 6) % 7; // days since Monday
  return bgAddDays(day, -offset);
}

/** First-of-month 'YYYY-MM-01' for the month containing `day`. */
function firstOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** Add `n` months to a 'YYYY-MM-01' string, returning 'YYYY-MM-01'. */
export function addMonths(firstOfMonthStr: string, n: number): string {
  const [y, m] = firstOfMonthStr.split('-').map(Number);
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

/** A UTC instant → its Sofia-local 'YYYY-MM-DD'. */
function toSofiaDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BG_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(d));
}
