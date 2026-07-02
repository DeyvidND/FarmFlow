# Site Analytics („Анализ на сайта") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-party, cookieless site analytics — a new „Анализ на сайта" panel screen showing visitors, a 5-step conversion funnel, sources, top pages and devices — fed by a traffic-event collector that writes to our own Postgres.

**Architecture:** chaika (Astro/CF Workers storefront) fires lightweight beacons to a public `POST /public/:slug/track` endpoint on the NestJS API. The server computes a cookieless daily `visitor_hash` from IP+UA+salt (IP never stored) and inserts one row into a new `site_events` table. A `GET /analytics` endpoint (auth, role admin/farmer) aggregates the funnel and metrics, mirroring the existing `stats` module structure. A new panel screen renders them.

**Tech Stack:** NestJS, Drizzle ORM, Postgres, Redis (PublicCacheService), Next.js panel (React), Astro (chaika). Node `crypto` for hashing.

**Spec:** `docs/superpowers/specs/2026-07-03-site-analytics-design.md`

**Repos touched:**
- FarmFlow (this repo, branch `feat/site-analytics`) — Tasks 1–9.
- fermerski-pazar-chaika (`C:\Users\Lenovo\source\repos\fermerski-pazar-chaika`) — Tasks 10–11.

---

## File Structure

**FarmFlow (this repo):**
- Create: `packages/db/drizzle/0075_site_events.sql` — migration.
- Modify: `packages/db/src/schema.ts` — `siteEvents` table def.
- Create: `server/src/modules/analytics/analytics.helpers.ts` — pure helpers (hash, device, funnel, window reuse) — unit tested.
- Create: `server/src/modules/analytics/analytics.helpers.spec.ts`.
- Create: `server/src/modules/analytics/analytics.service.ts` — track write + query aggregation.
- Create: `server/src/modules/analytics/dto/track-event.dto.ts` — POST body validation.
- Create: `server/src/modules/analytics/analytics.controller.ts` — `POST /public/:slug/track` + `GET /analytics`.
- Create: `server/src/modules/analytics/analytics.retention.ts` — daily prune cron.
- Create: `server/src/modules/analytics/analytics.module.ts`.
- Modify: `server/src/app.module.ts` — register `AnalyticsModule`.
- Modify: `client/src/lib/types.ts` — `AnalyticsSummary` types.
- Modify: `client/src/lib/api-client.ts` — `getAnalytics()`.
- Create: `client/src/components/analytics/analytics-client.tsx` — the screen.
- Create: `client/src/app/(admin)/site-analytics/page.tsx` — route.
- Modify: `client/src/components/layout/sidebar.tsx` — nav entries (admin + farmer).

**chaika:**
- Create: `src/lib/track.ts` — `ffTrack()` beacon helper + `window.ffTrack`.
- Modify: `src/components/Layout.astro` — inject the tracker + page_view.
- Modify: `src/lib/cart.ts` — fire `add_to_cart` from `Cart.add`.
- Modify: `src/scripts/checkout-page.ts` — fire `checkout_start` on load.
- Modify: `src/scripts/confirmation-page.ts` — fire `purchase` with orderId+total.
- Modify: `src/pages/product/[slug].astro` (or its client script) — fire `product_view`.

---

## Data shapes (single source of truth — used across tasks)

Event types (string union, exactly these five):
`'page_view' | 'product_view' | 'add_to_cart' | 'checkout_start' | 'purchase'`

`AnalyticsSummary` (server returns, panel consumes):

```ts
export interface FunnelStep {
  key: 'page_view' | 'product_view' | 'add_to_cart' | 'checkout_start' | 'purchase';
  label: string;      // BG label, filled server-side
  visitors: number;   // distinct visitor_hash that fired this step in the window
}
export interface AnalyticsPoint {
  t: string;          // bucket key, same format as stats
  visitors: number;
  pageViews: number;
}
export interface AnalyticsSummary {
  range: '7d' | '30d' | '90d' | '1y' | 'custom';
  bucket: 'day' | 'week' | 'month';
  from: string;
  to: string;
  visitors: number;          // distinct visitor_hash with a page_view in window
  pageViews: number;         // total page_view rows
  prevVisitors: number;      // equal prior window
  purchases: number;         // distinct visitor_hash with a purchase
  conversionPct: number;     // purchases / visitors * 100, one decimal
  prevConversionPct: number;
  funnel: FunnelStep[];      // 5 entries, ordered as listed above
  sources: { host: string; visitors: number }[];  // top 6 referrer hosts, 'директно' bucket for null
  topPages: { path: string; views: number }[];     // top 6 paths by page_view
  devices: { mobile: number; desktop: number };     // distinct visitors per device
  points: AnalyticsPoint[];  // trend axis, gap-filled
  sparse: boolean;           // visitors < ANALYTICS_SPARSE_MIN
}
```

---

## Task 1: Migration + schema for `site_events`

**Files:**
- Create: `packages/db/drizzle/0075_site_events.sql`
- Modify: `packages/db/src/schema.ts` (add `siteEvents` after `orderItems`, ~line 428)

- [ ] **Step 1: Write the migration SQL**

Create `packages/db/drizzle/0075_site_events.sql`:

```sql
CREATE TABLE IF NOT EXISTS site_events (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid REFERENCES tenants(id),
  visitor_hash  text NOT NULL,
  event_type    text NOT NULL,
  path          text,
  referrer_host text,
  product_id    uuid,
  order_id      uuid,
  value_stotinki integer,
  device        text NOT NULL DEFAULT 'desktop',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_events_tenant_created_idx ON site_events (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS site_events_tenant_type_created_idx ON site_events (tenant_id, event_type, created_at);
```

- [ ] **Step 2: Add the Drizzle table definition**

In `packages/db/src/schema.ts`, mirror the `deliverySlots` pattern. Add after the `orderItems` table:

```ts
export const siteEvents = pgTable(
  'site_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    // Cookieless daily hash of IP+UA+salt+tenant. The raw IP is NEVER stored —
    // only this hash — and the salt rotates daily so it can't track across days.
    visitorHash: text('visitor_hash').notNull(),
    // One of: page_view | product_view | add_to_cart | checkout_start | purchase.
    eventType: text('event_type').notNull(),
    path: text('path'),
    // Referrer HOST only (no full URL / query) — privacy.
    referrerHost: text('referrer_host'),
    productId: uuid('product_id'),
    orderId: uuid('order_id'),
    valueStotinki: integer('value_stotinki'),
    device: text('device').notNull().default('desktop'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantCreatedIdx: index('site_events_tenant_created_idx').on(t.tenantId, t.createdAt),
    tenantTypeCreatedIdx: index('site_events_tenant_type_created_idx').on(
      t.tenantId,
      t.eventType,
      t.createdAt,
    ),
  }),
);
```

Ensure `bigserial` is in the drizzle-orm/pg-core import list at the top of `schema.ts` (add it if missing — `pgTable`, `uuid`, `text`, `integer`, `timestamp`, `index` are already imported).

- [ ] **Step 3: Build the db package to verify the schema compiles**

Run: `cd packages/db && npm run build`
Expected: exits 0, no TS errors.

- [ ] **Step 4: Commit**

```bash
git add packages/db/drizzle/0075_site_events.sql packages/db/src/schema.ts
git commit -m "feat(analytics): site_events table + migration 0075"
```

---

## Task 2: Pure analytics helpers + tests

Pure functions with no DB, unit-tested directly (mirrors `stats` pure helpers). Reuse the stats window/bucket helpers by importing them.

**Files:**
- Create: `server/src/modules/analytics/analytics.helpers.ts`
- Test: `server/src/modules/analytics/analytics.helpers.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/analytics/analytics.helpers.spec.ts`:

```ts
import { visitorHash, deviceFromUA, isBot, referrerHost, buildFunnel } from './analytics.helpers';

describe('analytics.helpers', () => {
  describe('visitorHash', () => {
    it('is stable for the same inputs', () => {
      const a = visitorHash('1.2.3.4', 'UA', '2026-07-03', 't1', 'secret');
      const b = visitorHash('1.2.3.4', 'UA', '2026-07-03', 't1', 'secret');
      expect(a).toBe(b);
      expect(a).toHaveLength(64); // sha256 hex
    });
    it('differs across days (salt rotation)', () => {
      const a = visitorHash('1.2.3.4', 'UA', '2026-07-03', 't1', 'secret');
      const b = visitorHash('1.2.3.4', 'UA', '2026-07-04', 't1', 'secret');
      expect(a).not.toBe(b);
    });
    it('differs across tenants', () => {
      const a = visitorHash('1.2.3.4', 'UA', '2026-07-03', 't1', 'secret');
      const b = visitorHash('1.2.3.4', 'UA', '2026-07-03', 't2', 'secret');
      expect(a).not.toBe(b);
    });
  });

  describe('deviceFromUA', () => {
    it('detects mobile', () => {
      expect(deviceFromUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('mobile');
      expect(deviceFromUA('Mozilla/5.0 (Linux; Android 13)')).toBe('mobile');
    });
    it('defaults to desktop', () => {
      expect(deviceFromUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('desktop');
      expect(deviceFromUA('')).toBe('desktop');
    });
  });

  describe('isBot', () => {
    it('flags known crawlers', () => {
      expect(isBot('Googlebot/2.1')).toBe(true);
      expect(isBot('Mozilla/5.0 (compatible; bingbot/2.0)')).toBe(true);
      expect(isBot('HeadlessChrome/120')).toBe(true);
    });
    it('passes real browsers', () => {
      expect(isBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe(false);
    });
    it('treats empty UA as a bot', () => {
      expect(isBot('')).toBe(true);
    });
  });

  describe('referrerHost', () => {
    it('extracts the host', () => {
      expect(referrerHost('https://www.google.com/search?q=x')).toBe('www.google.com');
    });
    it('returns null for empty / garbage / same-site handled by caller', () => {
      expect(referrerHost('')).toBeNull();
      expect(referrerHost('not a url')).toBeNull();
    });
  });

  describe('buildFunnel', () => {
    it('orders the 5 steps and fills counts from the map', () => {
      const steps = buildFunnel({ page_view: 100, product_view: 60, add_to_cart: 25, checkout_start: 12, purchase: 7 });
      expect(steps.map((s) => s.key)).toEqual([
        'page_view', 'product_view', 'add_to_cart', 'checkout_start', 'purchase',
      ]);
      expect(steps[0].visitors).toBe(100);
      expect(steps[4].visitors).toBe(7);
      expect(steps[0].label).toBe('Влезли в сайта');
    });
    it('defaults missing steps to 0', () => {
      const steps = buildFunnel({ page_view: 10 });
      expect(steps[3].visitors).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx jest analytics.helpers --silent`
Expected: FAIL — `Cannot find module './analytics.helpers'`.

- [ ] **Step 3: Write the helpers**

Create `server/src/modules/analytics/analytics.helpers.ts`:

```ts
import { createHash } from 'crypto';

/** Cookieless visitor identity. sha256(ip + ua + daySalt + tenant + secret).
 *  The raw IP is only passed in transiently to compute this — callers never
 *  persist it. `day` (BG 'YYYY-MM-DD') rotates the value daily so the same
 *  person is a different hash tomorrow (no cross-day tracking). */
export function visitorHash(
  ip: string,
  ua: string,
  day: string,
  tenantId: string,
  secret: string,
): string {
  return createHash('sha256').update(`${ip}|${ua}|${day}|${tenantId}|${secret}`).digest('hex');
}

const MOBILE_RE = /Mobi|Android|iPhone|iPad|iPod|Windows Phone|BlackBerry/i;

/** Coarse device class from the User-Agent. Empty/unknown → 'desktop'. */
export function deviceFromUA(ua: string): 'mobile' | 'desktop' {
  return MOBILE_RE.test(ua) ? 'mobile' : 'desktop';
}

// Known crawlers + headless signatures. Not exhaustive — a best-effort filter so
// bot traffic doesn't pollute the funnel. Missing/empty UA is treated as a bot.
const BOT_RE =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora|pinterest|headless|phantom|lighthouse|gtmetrix|pingdom|uptime|curl|wget|python-requests|axios|node-fetch/i;

/** True when the UA looks like a bot/crawler/monitor, or is empty. */
export function isBot(ua: string): boolean {
  if (!ua || !ua.trim()) return true;
  return BOT_RE.test(ua);
}

/** Host of a referrer URL, or null if empty/unparseable. Same-site filtering is
 *  the caller's job (it knows the storefront host). */
export function referrerHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).host || null;
  } catch {
    return null;
  }
}

export type FunnelKey =
  | 'page_view'
  | 'product_view'
  | 'add_to_cart'
  | 'checkout_start'
  | 'purchase';

export interface FunnelStep {
  key: FunnelKey;
  label: string;
  visitors: number;
}

/** The 5 funnel steps in order, with BG labels. Counts come from a
 *  {eventType → distinctVisitors} map; missing steps default to 0. */
const FUNNEL_ORDER: { key: FunnelKey; label: string }[] = [
  { key: 'page_view', label: 'Влезли в сайта' },
  { key: 'product_view', label: 'Разгледали продукт' },
  { key: 'add_to_cart', label: 'Добавили в кошница' },
  { key: 'checkout_start', label: 'Започнали поръчка' },
  { key: 'purchase', label: 'Купили' },
];

export function buildFunnel(counts: Partial<Record<FunnelKey, number>>): FunnelStep[] {
  return FUNNEL_ORDER.map(({ key, label }) => ({ key, label, visitors: counts[key] ?? 0 }));
}

/** Below this many visitors in the window the funnel/sources are noise. */
export const ANALYTICS_SPARSE_MIN = 30;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx jest analytics.helpers --silent`
Expected: PASS, all cases green.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/analytics/analytics.helpers.ts server/src/modules/analytics/analytics.helpers.spec.ts
git commit -m "feat(analytics): pure helpers (visitor hash, device, bot filter, funnel)"
```

---

## Task 3: AnalyticsService — track write + query aggregation

Reuses the stats window helpers (`resolveWindow`, `pickBucket`, `buildAxis`, `daySpanInclusive`) from `../stats/stats.service` and `bg-time`.

**Files:**
- Create: `server/src/modules/analytics/analytics.service.ts`
- Test: `server/src/modules/analytics/analytics.service.spec.ts`

- [ ] **Step 1: Write the failing test (track write path)**

Create `server/src/modules/analytics/analytics.service.spec.ts`. This unit-tests the pure decision points of `track()` via a mocked db + cache + config; the aggregation SQL is covered by the controller/integration seed later.

```ts
import { AnalyticsService } from './analytics.service';

function makeService(insertSpy: jest.Mock) {
  const db = { insert: () => ({ values: insertSpy }) } as any;
  const cache = { resolveTenant: jest.fn().mockResolvedValue({ id: 't1', slug: 'ferma' }) } as any;
  const config = { get: (k: string, d?: string) => (k === 'ANALYTICS_SALT' ? 'secret' : d) } as any;
  return new AnalyticsService(db, cache, config);
}

describe('AnalyticsService.track', () => {
  it('drops bot user-agents without inserting', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const svc = makeService(insert);
    await svc.track('ferma', { type: 'page_view', path: '/' }, '1.2.3.4', 'Googlebot/2.1');
    expect(insert).not.toHaveBeenCalled();
  });

  it('inserts a row with a hash and never the raw ip', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const svc = makeService(insert);
    await svc.track(
      'ferma',
      { type: 'page_view', path: '/', referrer: 'https://google.com/x' },
      '9.9.9.9',
      'Mozilla/5.0 (iPhone)',
    );
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0];
    expect(row.tenantId).toBe('t1');
    expect(row.eventType).toBe('page_view');
    expect(row.device).toBe('mobile');
    expect(row.referrerHost).toBe('google.com');
    expect(row.visitorHash).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain('9.9.9.9');
  });

  it('drops an unknown tenant', async () => {
    const insert = jest.fn();
    const db = { insert: () => ({ values: insert }) } as any;
    const cache = { resolveTenant: jest.fn().mockRejectedValue(new Error('not found')) } as any;
    const config = { get: () => 'secret' } as any;
    const svc = new AnalyticsService(db, cache, config);
    await svc.track('nope', { type: 'page_view', path: '/' }, '1.1.1.1', 'Mozilla/5.0 (iPhone)');
    expect(insert).not.toHaveBeenCalled();
  });

  it('ignores an invalid event type', async () => {
    const insert = jest.fn();
    const svc = makeService(insert);
    await svc.track('ferma', { type: 'nonsense' as any, path: '/' }, '1.1.1.1', 'Mozilla/5.0 (iPhone)');
    expect(insert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx jest analytics.service --silent`
Expected: FAIL — `Cannot find module './analytics.service'`.

- [ ] **Step 3: Write the service**

Create `server/src/modules/analytics/analytics.service.ts`:

```ts
import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, gte, lt, sql, desc } from 'drizzle-orm';
import { type Database, siteEvents } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { bgToday, bgAddDays, bgDayBounds, BG_TZ } from '../../common/time/bg-time';
import {
  resolveWindow,
  pickBucket,
  buildAxis,
  type StatsBucket,
} from '../stats/stats.service';
import {
  visitorHash,
  deviceFromUA,
  isBot,
  referrerHost,
  buildFunnel,
  ANALYTICS_SPARSE_MIN,
  type FunnelKey,
} from './analytics.helpers';

const EVENT_TYPES: FunnelKey[] = [
  'page_view',
  'product_view',
  'add_to_cart',
  'checkout_start',
  'purchase',
];

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

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly cache: PublicCacheService,
    private readonly config: ConfigService,
  ) {}

  /** Ingest one storefront event. Best-effort: any validation miss is a silent
   *  no-op (the browser beacon must never see an error). Bots and unknown tenants
   *  are dropped. The raw IP is used only to derive the daily hash — never stored. */
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
  }

  /** Aggregate the analytics summary for a tenant + window. Cached 90 s. */
  async summary(
    tenantId: string,
    opts: { range?: string; from?: string; to?: string } = {},
  ) {
    const today = bgToday();
    const { from, to, range } = resolveWindow(opts, today);
    const cacheKey = `analytics:${tenantId}:${from}:${to}`;
    const cached = await this.cache.get<Awaited<ReturnType<AnalyticsService['compute']>>>(cacheKey);
    if (cached) return cached;
    const result = await this.compute(tenantId, from, to, range);
    await this.cache.set(cacheKey, result, ANALYTICS_TTL);
    return result;
  }

  private async compute(tenantId: string, from: string, to: string, range: string) {
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

    // ── Distinct visitors per event type (the funnel) ──
    const funnelP = this.db
      .select({
        type: siteEvents.eventType,
        visitors: sql<number>`count(distinct ${siteEvents.visitorHash})::int`,
      })
      .from(siteEvents)
      .where(inWin)
      .groupBy(siteEvents.eventType);

    // ── Page views total + distinct visitors (current + prev window) ──
    const pv = sql`${siteEvents.eventType} = 'page_view'`;
    const headP = this.db
      .select({
        pageViews: sql<number>`count(*) filter (where ${pv} and ${siteEvents.createdAt} >= ${since})::int`,
        visitors: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${pv} and ${siteEvents.createdAt} >= ${since})::int`,
        prevVisitors: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${pv} and ${siteEvents.createdAt} < ${since})::int`,
      })
      .from(siteEvents)
      .where(
        and(
          eq(siteEvents.tenantId, tenantId),
          gte(siteEvents.createdAt, prevSince),
          lt(siteEvents.createdAt, toExcl),
        ),
      );

    // ── Purchases: distinct visitors, current + prev (for conversion delta) ──
    const purch = sql`${siteEvents.eventType} = 'purchase'`;
    const purchaseP = this.db
      .select({
        cur: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${purch} and ${siteEvents.createdAt} >= ${since})::int`,
        prev: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${purch} and ${siteEvents.createdAt} < ${since})::int`,
      })
      .from(siteEvents)
      .where(
        and(
          eq(siteEvents.tenantId, tenantId),
          gte(siteEvents.createdAt, prevSince),
          lt(siteEvents.createdAt, toExcl),
        ),
      );

    // ── Sources: distinct visitors per referrer host (null → 'директно') ──
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

    // ── Top pages by page_view count ──
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

    // ── Devices: distinct visitors per device class (page_view) ──
    const devicesP = this.db
      .select({
        device: siteEvents.device,
        visitors: sql<number>`count(distinct ${siteEvents.visitorHash})::int`,
      })
      .from(siteEvents)
      .where(and(inWin, pv))
      .groupBy(siteEvents.device);

    // ── Trend: visitors + page views per Sofia-local bucket ──
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

    const [funnelRows, [head], [purchase], sources, topPages, deviceRows, seriesRows] =
      await Promise.all([funnelP, headP, purchaseP, sourcesP, topPagesP, devicesP, seriesP]);

    const counts: Partial<Record<FunnelKey, number>> = {};
    for (const r of funnelRows) counts[r.type as FunnelKey] = r.visitors;
    const funnel = buildFunnel(counts);

    const visitors = head?.visitors ?? 0;
    const conversionPct = visitors > 0 ? Math.round((purchase.cur / visitors) * 1000) / 10 : 0;
    const prevVisitors = head?.prevVisitors ?? 0;
    const prevConversionPct =
      prevVisitors > 0 ? Math.round((purchase.prev / prevVisitors) * 1000) / 10 : 0;

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
      pageViews: head?.pageViews ?? 0,
      prevVisitors,
      purchases: purchase.cur,
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
```

Note: `resolveWindow`, `pickBucket`, `buildAxis`, `StatsBucket` must be exported from `stats.service.ts`. They already are (`export function resolveWindow`, `export function pickBucket`, `export function buildAxis`, `export type StatsBucket`) — verified in the current file. No change needed there.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx jest analytics.service --silent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/analytics/analytics.service.ts server/src/modules/analytics/analytics.service.spec.ts
git commit -m "feat(analytics): AnalyticsService — track ingest + summary aggregation"
```

---

## Task 4: DTO, controller, module, registration

**Files:**
- Create: `server/src/modules/analytics/dto/track-event.dto.ts`
- Create: `server/src/modules/analytics/analytics.controller.ts`
- Create: `server/src/modules/analytics/analytics.module.ts`
- Modify: `server/src/app.module.ts`
- Test: `server/src/modules/analytics/analytics.controller.spec.ts`

- [ ] **Step 1: Write the DTO**

Create `server/src/modules/analytics/dto/track-event.dto.ts`:

```ts
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

const TYPES = ['page_view', 'product_view', 'add_to_cart', 'checkout_start', 'purchase'] as const;

export class TrackEventDto {
  @IsIn(TYPES)
  type!: (typeof TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(512)
  path?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  referrer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  productId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  orderId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  value?: number;
}
```

- [ ] **Step 2: Write the controller**

Create `server/src/modules/analytics/analytics.controller.ts`:

```ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AnalyticsService } from './analytics.service';
import { TrackEventDto } from './dto/track-event.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { effectiveFarmerId } from '../../common/scope/farmer-scope.util';
import type { TenantRequestUser } from '@fermeribg/types';

/** Public storefront beacon. High-volume, cheap: 120 events/min/IP. Always 204 —
 *  the browser beacon ignores the body; a bad/bot/unknown event is a silent no-op. */
@ApiTags('public')
@Controller('public/:slug/track')
export class TrackController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post()
  @HttpCode(204)
  async track(
    @Param('slug') slug: string,
    @Body() dto: TrackEventDto,
    @Ip() ip: string,
    @Headers('user-agent') ua: string,
  ): Promise<void> {
    await this.analytics.track(slug, dto, ip ?? '', ua ?? '');
  }
}

/** Panel read side. Same auth/role/scope shape as StatsController. */
@ApiTags('analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Roles('admin', 'farmer')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  @ApiQuery({ name: 'range', required: false, enum: ['7d', '30d', '90d', '1y'] })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  summary(
    @CurrentUser() user: TenantRequestUser,
    @Query('range') range?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    // v1: analytics are per-tenant only (storefront traffic isn't attributed to a
    // single producer). A farmer sub-account still sees their shop's traffic.
    void effectiveFarmerId; // reserved for a future per-farmer split
    return this.analytics.summary(user.tenantId, { range, from, to });
  }
}
```

Note: the farmer-scope import is kept minimal; per spec, v1 analytics are per-tenant (traffic can't be split by producer). Both roles see the tenant's traffic. If lint flags the unused `effectiveFarmerId`, drop that import and the `void` line.

- [ ] **Step 3: Write the module**

Create `server/src/modules/analytics/analytics.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController, TrackController } from './analytics.controller';
import { PublicCacheModule } from '../../common/cache/public-cache.module';

@Module({
  imports: [PublicCacheModule],
  controllers: [TrackController, AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
```

Verify the cache module's real path/name: run `ls server/src/common/cache/` and confirm `public-cache.module.ts` exports `PublicCacheModule` (it's registered in app.module as `PublicCacheModule`). If `PublicCacheService` is exported by a differently-named module, import that instead. If `PublicCacheModule` is `@Global()`, the `imports` line can be omitted.

- [ ] **Step 4: Register in app.module**

In `server/src/app.module.ts`, add `AnalyticsModule` to the imports array (next to `StatsModule`, ~line 117) and its import at the top:

```ts
import { AnalyticsModule } from './modules/analytics/analytics.module';
```

and in the module list:

```ts
    StatsModule,
    AnalyticsModule,
```

- [ ] **Step 5: Write the controller test**

Create `server/src/modules/analytics/analytics.controller.spec.ts`:

```ts
import { TrackController, AnalyticsController } from './analytics.controller';

describe('analytics controllers', () => {
  it('track passes slug/body/ip/ua through to the service', async () => {
    const svc = { track: jest.fn().mockResolvedValue(undefined) } as any;
    const c = new TrackController(svc);
    await c.track('ferma', { type: 'page_view', path: '/' } as any, '1.2.3.4', 'UA');
    expect(svc.track).toHaveBeenCalledWith('ferma', { type: 'page_view', path: '/' }, '1.2.3.4', 'UA');
  });

  it('summary scopes to the caller tenant', () => {
    const svc = { summary: jest.fn().mockReturnValue('x') } as any;
    const c = new AnalyticsController(svc);
    c.summary({ tenantId: 't1', role: 'farmer' } as any, '30d', undefined, undefined);
    expect(svc.summary).toHaveBeenCalledWith('t1', { range: '30d', from: undefined, to: undefined });
  });
});
```

- [ ] **Step 6: Run tests + build**

Run: `cd server && npx jest analytics --silent && npm run build`
Expected: analytics specs PASS; build exits 0.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/analytics/dto server/src/modules/analytics/analytics.controller.ts server/src/modules/analytics/analytics.controller.spec.ts server/src/modules/analytics/analytics.module.ts server/src/app.module.ts
git commit -m "feat(analytics): DTO + public /track + /analytics endpoints, register module"
```

---

## Task 5: Retention cron (prune > 180 days)

Follows the digest/cron pattern in the codebase (`@nestjs/schedule` `@Cron`). Verify the pattern first: run `grep -rn "@Cron" server/src/modules | head` — reuse the same import + `ScheduleModule` wiring the digest module uses.

**Files:**
- Create: `server/src/modules/analytics/analytics.retention.ts`
- Modify: `server/src/modules/analytics/analytics.module.ts` (register the provider)
- Test: `server/src/modules/analytics/analytics.retention.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/analytics/analytics.retention.spec.ts`:

```ts
import { AnalyticsRetention } from './analytics.retention';

describe('AnalyticsRetention', () => {
  it('deletes rows older than the cutoff', async () => {
    const del = jest.fn().mockResolvedValue(undefined);
    const db = { delete: () => ({ where: del }) } as any;
    const svc = new AnalyticsRetention(db);
    await svc.prune();
    expect(del).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx jest analytics.retention --silent`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the retention provider**

Create `server/src/modules/analytics/analytics.retention.ts`:

```ts
import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { lt, sql } from 'drizzle-orm';
import { type Database, siteEvents } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

/** Raw events are only needed for the rolling analytics windows; keep 180 days
 *  and prune nightly so the table stays small (≈1 GB/yr ceiling, then bounded). */
const RETENTION_DAYS = 180;

@Injectable()
export class AnalyticsRetention {
  private readonly log = new Logger(AnalyticsRetention.name);
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async prune(): Promise<void> {
    const cutoff = sql`now() - interval '${sql.raw(String(RETENTION_DAYS))} days'`;
    await this.db.delete(siteEvents).where(lt(siteEvents.createdAt, cutoff as any));
    this.log.log(`Pruned site_events older than ${RETENTION_DAYS} days`);
  }
}
```

If `@nestjs/schedule` / `ScheduleModule` isn't already imported app-wide, confirm via the grep in the task header and match the digest module's registration (it uses `@Cron`, so `ScheduleModule.forRoot()` is already in the app). Only the provider needs adding.

- [ ] **Step 4: Register the provider**

In `analytics.module.ts` add to `providers`:

```ts
  providers: [AnalyticsService, AnalyticsRetention],
```

and the import:

```ts
import { AnalyticsRetention } from './analytics.retention';
```

- [ ] **Step 5: Run test + build**

Run: `cd server && npx jest analytics.retention --silent && npm run build`
Expected: PASS; build exits 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/analytics/analytics.retention.ts server/src/modules/analytics/analytics.retention.spec.ts server/src/modules/analytics/analytics.module.ts
git commit -m "feat(analytics): nightly retention prune of site_events > 180d"
```

---

## Task 6: Panel types + api-client

**Files:**
- Modify: `client/src/lib/types.ts` (append the analytics types)
- Modify: `client/src/lib/api-client.ts` (add `getAnalytics`)

- [ ] **Step 1: Add the types**

Append to `client/src/lib/types.ts`:

```ts
export type FunnelKey =
  | 'page_view'
  | 'product_view'
  | 'add_to_cart'
  | 'checkout_start'
  | 'purchase';

export interface FunnelStep {
  key: FunnelKey;
  label: string;
  visitors: number;
}
export interface AnalyticsPoint {
  t: string;
  visitors: number;
  pageViews: number;
}
export interface AnalyticsSummary {
  range: StatsRange | 'custom';
  bucket: 'day' | 'week' | 'month';
  from: string;
  to: string;
  visitors: number;
  pageViews: number;
  prevVisitors: number;
  purchases: number;
  conversionPct: number;
  prevConversionPct: number;
  funnel: FunnelStep[];
  sources: { host: string; visitors: number }[];
  topPages: { path: string; views: number }[];
  devices: { mobile: number; desktop: number };
  points: AnalyticsPoint[];
  sparse: boolean;
}
```

(`StatsRange` already exists in this file — confirm with `grep -n "StatsRange" client/src/lib/types.ts`; if the name differs, reuse the existing range union.)

- [ ] **Step 2: Add the api-client call**

Find the `getStats` implementation: `grep -n "getStats" client/src/lib/api-client.ts`. Add a sibling `getAnalytics` matching its exact fetch/query-building style. Reference implementation (adapt to the file's existing helper — it likely wraps a shared `apiFetch`):

```ts
export function getAnalytics(
  opts: { range: StatsRange } | { from: string; to: string },
): Promise<AnalyticsSummary> {
  const qs = new URLSearchParams(
    'range' in opts ? { range: opts.range } : { from: opts.from, to: opts.to },
  ).toString();
  return apiFetch<AnalyticsSummary>(`/analytics?${qs}`);
}
```

Import `AnalyticsSummary` (and `StatsRange` if not already) at the top. Match whatever the existing `getStats` uses for the fetch wrapper and auth — do not invent a new fetch path.

- [ ] **Step 3: Typecheck**

Run: `cd client && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/api-client.ts
git commit -m "feat(analytics): panel types + getAnalytics client"
```

---

## Task 7: Panel screen — AnalyticsClient

Reuse the visual vocabulary from `stats-client.tsx` (range pills, `StatTile`, `ShareBar`, `pctDelta`, `moneyFromStotinki`, sparse tag, `TrendChart`). The funnel is the new hero element.

**Files:**
- Create: `client/src/components/analytics/analytics-client.tsx`

- [ ] **Step 1: Write the component**

Create `client/src/components/analytics/analytics-client.tsx`. Keep it self-contained; copy the small `Seg`/`pctDelta`/`StatTile`/`ShareBar` helpers from `stats-client.tsx` (or import if they are exported — check with `grep -n "export function StatTile\|export function ShareBar" client/src/components/stats/stats-client.tsx`; they are currently NOT exported, so copy them in).

```tsx
'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Users, Eye, MousePointerClick, Target, Smartphone, Monitor,
  TrendingUp, TrendingDown, Minus, Info, Globe, FileText, type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ApiError, getAnalytics } from '@/lib/api-client';
import type { AnalyticsSummary, StatsRange } from '@/lib/types';

const RANGES: { key: StatsRange; label: string }[] = [
  { key: '7d', label: '7 дни' },
  { key: '30d', label: '30 дни' },
  { key: '90d', label: '3 месеца' },
  { key: '1y', label: '1 година' },
];

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

type Delta = { dir: 'up' | 'down' | 'flat'; text: string };
function pctDelta(cur: number, prev: number): Delta {
  if (prev <= 0) return cur > 0 ? { dir: 'up', text: 'ново спрямо преди' } : { dir: 'flat', text: 'няма промяна' };
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return { dir: 'flat', text: 'колкото преди' };
  return { dir: pct > 0 ? 'up' : 'down', text: `${pct > 0 ? '+' : ''}${pct}% спрямо преди` };
}
const DELTA_STYLE = {
  up: { Icon: TrendingUp, cls: 'text-ff-green-700' },
  down: { Icon: TrendingDown, cls: 'text-ff-amber-600' },
  flat: { Icon: Minus, cls: 'text-ff-muted' },
} as const;

function StatTile({ Icon, label, value, delta, sub, index = 0 }: {
  Icon: LucideIcon; label: string; value: string | number; delta?: Delta; sub?: string; index?: number;
}) {
  const d = delta ? DELTA_STYLE[delta.dir] : null;
  return (
    <div className="animate-ff-fade-up rounded-xl border border-ff-border border-t-[3px] border-t-ff-green-600 bg-ff-surface p-[18px] shadow-ff-sm"
      style={{ animationDelay: `${index * 0.04}s` }}>
      <div className="grid h-[42px] w-[42px] place-items-center rounded-[11px] bg-ff-green-50 text-ff-green-700">
        <Icon size={22} />
      </div>
      <div className="ff-fig mt-3.5 text-[32px] font-extrabold tracking-[-0.02em] text-ff-ink">{value}</div>
      <div className="mt-0.5 text-[13.5px] font-bold text-ff-ink-2">{label}</div>
      {delta && d ? (
        <div className={cn('mt-[3px] flex items-center gap-1 text-[12.5px] font-semibold', d.cls)}>
          <d.Icon size={14} /> {delta.text}
        </div>
      ) : (
        <div className="mt-[3px] text-[12.5px] text-ff-muted">{sub}</div>
      )}
    </div>
  );
}

/** The funnel: each step a full-width bar scaled to the FIRST step, with the
 *  step's visitor count + the drop-off vs the previous step. */
function Funnel({ steps }: { steps: AnalyticsSummary['funnel'] }) {
  const top = steps[0]?.visitors ?? 0;
  return (
    <div className="flex flex-col gap-3">
      {steps.map((s, i) => {
        const pctOfTop = top > 0 ? Math.max(2, Math.round((s.visitors / top) * 100)) : 0;
        const prev = i > 0 ? steps[i - 1].visitors : null;
        const keepPct = prev && prev > 0 ? Math.round((s.visitors / prev) * 100) : null;
        return (
          <div key={s.key}>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="text-[13.5px] font-bold text-ff-ink-2">{i + 1}. {s.label}</span>
              <span className="ff-fig text-[13px] text-ff-muted">
                {s.visitors}
                {keepPct !== null && <span className="ml-2 text-ff-muted-2">({keepPct}% от предната стъпка)</span>}
              </span>
            </div>
            <div className="h-[14px] overflow-hidden rounded-full bg-ff-border-2">
              <div className="h-full rounded-full bg-ff-green-600 transition-[width]" style={{ width: `${pctOfTop}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ShareRow({ label, value, max, Icon }: { label: string; value: number; max: number; Icon?: LucideIcon }) {
  const pct = max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-3">
      {Icon && <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-ff-surface-2 text-ff-ink-2"><Icon size={16} /></span>}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="truncate text-[13.5px] font-semibold text-ff-ink-2">{label}</span>
          <span className="ff-fig shrink-0 text-[12.5px] text-ff-muted">{value}</span>
        </div>
        <div className="h-[7px] overflow-hidden rounded-full bg-ff-border-2">
          <div className="h-full rounded-full bg-ff-green-500" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}

export function AnalyticsClient({ initial, role = 'admin' }: { initial: AnalyticsSummary | null; role?: string }) {
  const initPreset: StatsRange = initial && initial.range !== 'custom' ? (initial.range as StatsRange) : '30d';
  const [range, setRange] = useState<StatsRange>(initPreset);
  const [data, setData] = useState<AnalyticsSummary | null>(initial);
  const [loading, setLoading] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!hydrated) {
      setHydrated(true);
      if (initial && initial.range === range) return;
    }
    let live = true;
    setLoading(true);
    getAnalytics({ range })
      .then((s) => { if (live) setData(s); })
      .catch((e) => { if (live) toast.error(errMsg(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const srcMax = data ? Math.max(1, ...data.sources.map((s) => s.visitors)) : 1;
  const pageMax = data ? Math.max(1, ...data.topPages.map((p) => p.views)) : 1;
  const devTotal = data ? data.devices.mobile + data.devices.desktop : 0;

  return (
    <div className="animate-ff-fade-up flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2.5">
          <div className="text-[15px] font-extrabold text-ff-ink">
            {role === 'farmer' ? 'Анализ на моя сайт' : 'Анализ на сайта'}
          </div>
          <div className="inline-flex flex-wrap rounded-xl border border-ff-border bg-ff-surface p-0.5 shadow-ff-sm">
            {RANGES.map((o) => (
              <button key={o.key} onClick={() => setRange(o.key)}
                className={cn('rounded-lg px-3 py-1.5 text-[13px] font-bold transition-colors',
                  range === o.key ? 'bg-ff-green-700 text-[#EAF1E4]' : 'text-ff-ink-2 hover:bg-ff-surface-2')}>
                {o.label}
              </button>
            ))}
          </div>
          {data?.sparse && (
            <span className="text-[12.5px] text-ff-muted-2">· малко посещения — числата са ориентир, пробвай по-дълъг период</span>
          )}
        </div>
      </div>

      {!data ? (
        <div className="rounded-xl border border-ff-border bg-ff-surface px-5 py-12 text-center text-sm text-ff-muted shadow-ff-sm">
          Още няма данни за посещения. Появяват се, щом сайтът получи трафик.
        </div>
      ) : (
        <div className={cn('flex flex-col gap-5 transition-opacity', loading && 'opacity-50')}>
          <div className="grid grid-cols-4 gap-4 max-[1024px]:grid-cols-2 max-[640px]:grid-cols-1">
            <StatTile Icon={Users} label="Посетители" value={data.visitors} delta={pctDelta(data.visitors, data.prevVisitors)} index={0} />
            <StatTile Icon={Eye} label="Прегледи на страници" value={data.pageViews} sub="общо отваряния" index={1} />
            <StatTile Icon={MousePointerClick} label="Купили" value={data.purchases} sub="различни купувачи" index={2} />
            <StatTile Icon={Target} label="Конверсия" value={`${data.conversionPct}%`}
              delta={pctDelta(data.conversionPct, data.prevConversionPct)} index={3} />
          </div>

          <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
            <div className="mb-1 flex items-center gap-2">
              <Target size={17} className="text-ff-green-700" />
              <h2 className="text-[16.5px] font-extrabold">Фуния към поръчка</h2>
            </div>
            <p className="mb-4 text-[13px] leading-[1.45] text-ff-muted">
              Колко души минават всяка стъпка — и къде най-много се отказват.
            </p>
            <Funnel steps={data.funnel} />
          </section>

          <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
            <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
              <div className="mb-1 flex items-center gap-2"><Globe size={17} className="text-ff-green-700" /><h2 className="text-[16.5px] font-extrabold">Откъде идват</h2></div>
              <p className="mb-4 text-[13px] leading-[1.45] text-ff-muted">Кои сайтове и търсачки водят хора при теб.</p>
              {data.sources.length === 0 ? <p className="text-[13px] text-ff-muted">Няма данни.</p> : (
                <div className="flex flex-col gap-3.5">
                  {data.sources.map((s) => <ShareRow key={s.host} label={s.host} value={s.visitors} max={srcMax} />)}
                </div>
              )}
            </section>
            <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
              <div className="mb-1 flex items-center gap-2"><FileText size={17} className="text-ff-green-700" /><h2 className="text-[16.5px] font-extrabold">Топ страници</h2></div>
              <p className="mb-4 text-[13px] leading-[1.45] text-ff-muted">Кои страници се гледат най-много.</p>
              {data.topPages.length === 0 ? <p className="text-[13px] text-ff-muted">Няма данни.</p> : (
                <div className="flex flex-col gap-3.5">
                  {data.topPages.map((p) => <ShareRow key={p.path} label={p.path} value={p.views} max={pageMax} />)}
                </div>
              )}
            </section>
          </div>

          <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
            <div className="mb-1 flex items-center gap-2"><Smartphone size={17} className="text-ff-green-700" /><h2 className="text-[16.5px] font-extrabold">Устройства</h2></div>
            <p className="mb-4 text-[13px] leading-[1.45] text-ff-muted">Телефон или компютър — с какво пазаруват.</p>
            <div className="flex flex-col gap-3.5">
              <ShareRow Icon={Smartphone} label="Телефон" value={data.devices.mobile} max={Math.max(1, devTotal)} />
              <ShareRow Icon={Monitor} label="Компютър" value={data.devices.desktop} max={Math.max(1, devTotal)} />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
```

Verify the icon names exist in the installed lucide-react (`MousePointerClick`, `Target`, `Globe`, `FileText`, `Smartphone`, `Monitor`, `Eye`, `Users`) — all are standard lucide icons. If any is missing in the pinned version, swap for a present one.

- [ ] **Step 2: Typecheck**

Run: `cd client && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/analytics/analytics-client.tsx
git commit -m "feat(analytics): AnalyticsClient panel screen (funnel, sources, pages, devices)"
```

---

## Task 8: Panel route + sidebar entries

**Files:**
- Create: `client/src/app/(admin)/site-analytics/page.tsx`
- Modify: `client/src/components/layout/sidebar.tsx`

- [ ] **Step 1: Write the page (server component, mirrors stats/page.tsx)**

Create `client/src/app/(admin)/site-analytics/page.tsx`:

```tsx
import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { AnalyticsClient } from '@/components/analytics/analytics-client';
import type { AnalyticsSummary } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function authed<T>(path: string, token: string): Promise<T | null> {
  const res = await fetch(`${API_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  }).catch(() => null);
  if (!res || !res.ok) return null;
  return res.json();
}

export default async function SiteAnalyticsPage() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return <AnalyticsClient initial={null} role="admin" />;

  const [initial, account] = await Promise.all([
    authed<AnalyticsSummary>('analytics?range=30d', token),
    authed<{ role?: string }>('auth/me', token),
  ]);
  return <AnalyticsClient initial={initial} role={account?.role ?? 'admin'} />;
}
```

- [ ] **Step 2: Add sidebar entries (admin group + farmer list)**

In `client/src/components/layout/sidebar.tsx`:

Add the icon to the existing `lucide-react` import (e.g. `LineChart`):

```ts
// add LineChart to the existing lucide-react import line
```

Add to the admin nav group, right after the `/stats` item (~line 79):

```ts
      { href: '/site-analytics', label: 'Анализ на сайта', Icon: LineChart, desc: 'Посетители, фуния към поръчка, източници и устройства.' },
```

Add to the farmer nav list, right after the farmer `/stats` item (~line 120):

```ts
  { href: '/site-analytics', label: 'Анализ на сайта', Icon: LineChart, desc: 'Посетители на сайта, фуния към поръчка и източници.' },
```

- [ ] **Step 3: Typecheck + build the panel**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: builds; `/site-analytics` route compiled.

- [ ] **Step 4: Commit**

```bash
git add client/src/app/(admin)/site-analytics/page.tsx client/src/components/layout/sidebar.tsx
git commit -m "feat(analytics): /site-analytics route + sidebar entries (admin + farmer)"
```

---

## Task 9: Verify the API end-to-end locally

- [ ] **Step 1: Apply the migration + run the API**

Run (per project dev docs — DB on port 5433):
`cd packages/db && npm run migrate` then start the server (`cd server && npm run start:dev`).
Expected: boots clean; `runMigrations()` applies 0075.

- [ ] **Step 2: Post a few events + read the summary**

```bash
# send events (unauthenticated public beacon) — use a real tenant slug from the seed
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/public/<slug>/track \
  -H 'content-type: application/json' -H 'user-agent: Mozilla/5.0 (iPhone)' \
  -d '{"type":"page_view","path":"/"}'   # expect 204
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/public/<slug>/track \
  -H 'content-type: application/json' -H 'user-agent: Googlebot' \
  -d '{"type":"page_view","path":"/"}'   # expect 204 but NO row (bot)
# read (needs a farmer/admin JWT — grab from a panel login cookie)
curl -s http://localhost:3000/analytics?range=30d -H "Authorization: Bearer <token>" | jq .
```

Expected: summary JSON with `visitors: 1`, funnel `page_view.visitors: 1`, bot row absent.

- [ ] **Step 3: Commit (no code — a checkpoint only if fixes were needed)**

If any fix was required, commit it with a `fix(analytics):` message. Otherwise proceed.

---

## Task 10: chaika — tracker lib + page_view

**Repo:** `C:\Users\Lenovo\source\repos\fermerski-pazar-chaika` (separate git repo — branch it: `git checkout -b feat/site-analytics`).

**Files:**
- Create: `src/lib/track.ts`
- Modify: `src/components/Layout.astro`

- [ ] **Step 1: Write the tracker lib**

Create `src/lib/track.ts`:

```ts
// First-party, cookieless analytics beacon → FarmFlow /public/:slug/track.
// Best-effort: never throws, never blocks. Uses sendBeacon when available so it
// survives page unload. Browser must hit the CF-tunneled host (see config.ts
// BROWSER_BASE note) — origin-api's firewall blocks real visitor IPs.
import { TENANT_SLUG } from './config';

const RAW_BASE = (import.meta.env.PUBLIC_API_BASE ?? 'http://localhost:3000').replace(/\/+$/, '');
const BROWSER_BASE = (import.meta.env.DEV ? RAW_BASE : 'https://api.fermeribg.com').replace(/\/+$/, '');
const TRACK_URL = `${BROWSER_BASE}/public/${TENANT_SLUG}/track`;

export type TrackType =
  | 'page_view' | 'product_view' | 'add_to_cart' | 'checkout_start' | 'purchase';

export interface TrackData {
  path?: string;
  referrer?: string;
  productId?: string;
  orderId?: string;
  value?: number; // stotinki
}

export function ffTrack(type: TrackType, data: TrackData = {}): void {
  try {
    const body = JSON.stringify({
      type,
      path: data.path ?? location.pathname,
      referrer: data.referrer ?? document.referrer ?? '',
      productId: data.productId,
      orderId: data.orderId,
      value: data.value,
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(TRACK_URL, new Blob([body], { type: 'application/json' }));
    } else {
      fetch(TRACK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  } catch {
    /* analytics must never break the storefront */
  }
}

// Expose for inline call sites (confirmation/checkout scripts) + fire the page view.
declare global {
  interface Window { ffTrack?: typeof ffTrack }
}
if (typeof window !== 'undefined') {
  window.ffTrack = ffTrack;
}
```

- [ ] **Step 2: Inject + fire page_view in Layout**

In `src/components/Layout.astro`, add a module script near the bottom of `<body>` (NOT wrapped in any `{cond && ...}` — see the hoist-bug note already in that file around line 142). A plain `<script>` is statically hoisted by Astro, which is what we want:

```astro
<script>
  import { ffTrack } from '../lib/track';
  ffTrack('page_view');
</script>
```

Place it alongside the existing `<script>` block after `<slot />` / `<ConsentBanner />`.

- [ ] **Step 3: Build chaika to verify it compiles**

Run: `cd C:/Users/Lenovo/source/repos/fermerski-pazar-chaika && npm run build`
Expected: Astro build succeeds; `track` chunk bundled.

- [ ] **Step 4: Commit (chaika repo)**

```bash
cd C:/Users/Lenovo/source/repos/fermerski-pazar-chaika
git add src/lib/track.ts src/components/Layout.astro
git commit -m "feat(analytics): first-party tracker + page_view beacon"
```

---

## Task 11: chaika — product_view, add_to_cart, checkout_start, purchase

**Files:**
- Modify: `src/lib/cart.ts` (fire `add_to_cart` inside `Cart.add`)
- Modify: `src/scripts/checkout-page.ts` (fire `checkout_start` on load)
- Modify: `src/scripts/confirmation-page.ts` (fire `purchase` with orderId + total)
- Modify: the product page script/`src/pages/product/[slug].astro` (fire `product_view`)

- [ ] **Step 1: add_to_cart in cart.ts**

In `src/lib/cart.ts`, at the end of the `add(item, qty)` method (after `this.set(items);`), add:

```ts
    // analytics: fire-and-forget; guarded so a missing tracker is harmless
    try { window.ffTrack?.('add_to_cart', { productId: item.id, value: Math.round(item.price * qty * 100) }); } catch {}
```

`window.ffTrack` is typed via the global in `track.ts`; cart.ts already runs only in the browser. If TS complains about `window.ffTrack`, add `import type {} from './track';` at the top of cart.ts to pull in the global augmentation, or reference `(window as any).ffTrack`.

- [ ] **Step 2: checkout_start in checkout-page.ts**

At the top of `src/scripts/checkout-page.ts` (module runs on checkout page load), add after imports:

```ts
try { window.ffTrack?.('checkout_start'); } catch {}
```

- [ ] **Step 3: purchase in confirmation-page.ts**

In `src/scripts/confirmation-page.ts`, after `recap` is parsed from `sessionStorage` (the `ff_last_order` stash, ~line 34) and confirmed non-null, add a purchase beacon. The stash has `orderId` and a `total` (in leva for normal orders; courier path sums `split[].total`). Fire once:

```ts
try {
  if (recap) {
    const total =
      recap.method === 'courier' && Array.isArray(recap.split)
        ? recap.split.reduce((a, s) => a + s.total, 0)
        : (recap.total ?? 0);
    window.ffTrack?.('purchase', { orderId: recap.orderId, value: Math.round(total * 100) });
  }
} catch {}
```

Place it after the `recap` parse block, before/after the recap render — order doesn't matter as long as `recap` is defined.

- [ ] **Step 4: product_view on the product page**

Find how the product page runs client JS: `grep -rn "product" src/pages/product/*.astro | grep -i "script\|slug"`. Add a small inline module script to `src/pages/product/[slug].astro` (plain `<script>`, hoisted), passing the product id if available in the page scope, else omit:

```astro
<script>
  import { ffTrack } from '../../lib/track';
  ffTrack('product_view');
</script>
```

If the product id is readily available as a data attribute on the page root, read it and pass `{ productId }`; otherwise `product_view` without id still counts the funnel step (the funnel counts distinct visitors per step, not per product).

- [ ] **Step 5: Build chaika**

Run: `cd C:/Users/Lenovo/source/repos/fermerski-pazar-chaika && npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit (chaika repo)**

```bash
cd C:/Users/Lenovo/source/repos/fermerski-pazar-chaika
git add src/lib/cart.ts src/scripts/checkout-page.ts src/scripts/confirmation-page.ts src/pages/product/
git commit -m "feat(analytics): fire product_view / add_to_cart / checkout_start / purchase"
```

---

## Task 12: End-to-end verification (both repos)

- [ ] **Step 1: Run chaika dev against local API**

Point chaika's `PUBLIC_API_BASE` at `http://localhost:3000` (local dev — `BROWSER_BASE` reuses it in DEV) and `PUBLIC_TENANT_SLUG` at a seeded slug. Run chaika dev (`npm run dev`) and the API.

- [ ] **Step 2: Walk the funnel in a browser**

Open the storefront, view a product, add to cart, open checkout, complete a (cash) order to the confirmation page. Then in the panel open **Анализ на сайта**.
Expected: visitors ≥ 1; funnel shows page_view ≥ product_view ≥ add_to_cart ≥ checkout_start ≥ purchase; conversion > 0; a source row; the product/checkout paths under „Топ страници".

- [ ] **Step 3: Confirm CORS/firewall on the real deploy path**

Note in the PR: production browser beacons must reach `https://api.fermeribg.com/public/:slug/track` (the CF-tunneled host, not origin-api) and CORS must allow the chaika origin. Verify `CORS_ORIGIN` on the API includes the storefront origin; if `/track` needs no credentials, a permissive `*` on this route is acceptable since it carries no auth. Confirm a real browser `POST` returns 204 with no CORS error before closing the task.

- [ ] **Step 4: Set `ANALYTICS_SALT` in prod**

Add a strong random `ANALYTICS_SALT` env on the API (Dokploy). Without it the code falls back to a constant default (still functional, just a known salt).

---

## Self-Review notes (done during planning)

- **Spec coverage:** all six insights (visitors, funnel, sources, top pages, devices, conversion) → Tasks 3+7. Cookieless hash → Task 2/3. `site_events` table → Task 1. Public `/track` + `/analytics` → Task 4. Retention → Task 5. chaika instrumentation (chaika-only) → Tasks 10–11. Farmer+super-admin access → Tasks 4 (role) + 8 (both nav lists). CORS/firewall gotcha → Task 12 step 3. `ANALYTICS_SALT` → Task 12 step 4.
- **Type consistency:** `FunnelKey`/`FunnelStep`/`AnalyticsSummary` identical across server (`analytics.helpers.ts`) and panel (`types.ts`); `track()` signature `(slug, body, ip, ua)` matches controller + tests; `ffTrack(type, data)` signature matches all chaika call sites.
- **Known verification points (flagged inline, not placeholders):** exact `PublicCacheModule` name/path (Task 4 step 3), `@Cron`/`ScheduleModule` presence (Task 5), `getStats` fetch-wrapper shape to copy (Task 6 step 2), lucide icon availability (Task 7), product-id availability on the product page (Task 11 step 4). Each has a concrete fallback.
```
