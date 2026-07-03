# Site Analytics Visualizations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a trend chart (visitors/pageViews vs. purchases), a funnel weakest-step highlight, a best-day-of-week pattern, and per-source conversion rates to the existing `/site-analytics` panel screen.

**Architecture:** Extend `AnalyticsService.compute()` with a purchased-visitor-hash set (session-level attribution) used to compute conversion per traffic source and per weekday, plus a `purchases` count on the existing trend series. Two new pure helpers (`conversionPct`, `buildWeekdayPattern`) handle the math/reindexing so they're unit-testable without a database. The panel gets one new component (a dual-scale trend chart) and three edits to the existing screen.

**Tech Stack:** NestJS, Drizzle ORM (raw `sql` for aggregation), Postgres, Next.js/React, hand-rolled inline SVG charts (no charting library, matching the existing `TrendChart` precedent).

**Spec:** `docs/superpowers/specs/2026-07-03-site-analytics-visualizations-design.md`

**Builds on (already shipped):** `docs/superpowers/plans/2026-07-03-site-analytics.md` (FarmFlow `de725ac`, chaika `911d187`).

---

## File Structure

- Modify: `server/src/modules/analytics/analytics.helpers.ts` — add `conversionPct()`, `WeekdayStat`, `WeekdayRow`, `buildWeekdayPattern()`.
- Modify: `server/src/modules/analytics/analytics.helpers.spec.ts` — tests for the two new functions.
- Modify: `server/src/modules/analytics/analytics.service.ts` — purchased-hash query, extend `sourcesP`/`seriesP`, add `weekdayP`, update `AnalyticsSummary`.
- Modify: `client/src/lib/stat-ui.tsx` — move the `Seg` segmented-pill component here (currently duplicated conceptually — `stats-client.tsx` has its own local copy; the new trend chart needs an identical metric toggle, so extract now rather than write a third copy).
- Modify: `client/src/components/stats/stats-client.tsx` — import `Seg` from `stat-ui` instead of defining it locally.
- Modify: `client/src/components/stats/trend-chart.tsx` — export `labelFor` (currently module-private) so the new analytics trend chart can reuse it instead of duplicating the BG month/date-label logic.
- Modify: `client/src/lib/types.ts` — mirror the server's `AnalyticsSummary`/`AnalyticsPoint` changes, add `WeekdayStat`.
- Create: `client/src/components/analytics/analytics-trend-chart.tsx` — the new dual-scale (line + bars) chart.
- Modify: `client/src/components/analytics/analytics-client.tsx` — wire the trend chart, funnel highlight, best-day section, source conversion tag.

---

## Task 1: Pure helpers — `conversionPct` + `buildWeekdayPattern`

**Files:**
- Modify: `server/src/modules/analytics/analytics.helpers.ts`
- Modify: `server/src/modules/analytics/analytics.helpers.spec.ts`

- [ ] **Step 1: Write the failing tests**

Append to `server/src/modules/analytics/analytics.helpers.spec.ts` (inside the existing top-level `describe('analytics.helpers', ...)` block, as sibling `describe`s to `buildFunnel`):

```ts
  describe('conversionPct', () => {
    it('computes a rounded percentage', () => {
      expect(conversionPct(1, 3)).toBe(33.3);
    });
    it('returns 0 for zero visitors (no divide-by-zero)', () => {
      expect(conversionPct(0, 0)).toBe(0);
    });
    it('returns 100 when everyone converted', () => {
      expect(conversionPct(5, 5)).toBe(100);
    });
  });

  describe('buildWeekdayPattern', () => {
    it('reindexes to a Monday-first 7-entry array and fills missing days with zero', () => {
      const rows = [
        { pgDow: 5, visitors: 20, purchasers: 4 }, // Friday
        { pgDow: 0, visitors: 10, purchasers: 1 }, // Sunday
      ];
      const pattern = buildWeekdayPattern(rows);
      expect(pattern).toHaveLength(7);
      expect(pattern.map((p) => p.label)).toEqual(['Пон', 'Вто', 'Сря', 'Чет', 'Пет', 'Съб', 'Нед']);
      expect(pattern[4]).toEqual({ label: 'Пет', visitors: 20, purchasers: 4, conversionPct: 20 });
      expect(pattern[6]).toEqual({ label: 'Нед', visitors: 10, purchasers: 1, conversionPct: 10 });
      expect(pattern[0]).toEqual({ label: 'Пон', visitors: 0, purchasers: 0, conversionPct: 0 });
    });
    it('handles an empty input (no rows at all)', () => {
      const pattern = buildWeekdayPattern([]);
      expect(pattern).toHaveLength(7);
      expect(pattern.every((p) => p.visitors === 0 && p.conversionPct === 0)).toBe(true);
    });
  });
```

And update the top import line of that file to also pull in the new names:

```ts
import { visitorHash, deviceFromUA, isBot, referrerHost, buildFunnel, conversionPct, buildWeekdayPattern } from './analytics.helpers';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx jest analytics.helpers --silent`
Expected: FAIL — `conversionPct is not a function` / `buildWeekdayPattern is not a function`.

- [ ] **Step 3: Write the helpers**

Append to `server/src/modules/analytics/analytics.helpers.ts` (after the existing `buildFunnel`/`ANALYTICS_SPARSE_MIN` code, end of file):

```ts
/** Purchase conversion rate, rounded to one decimal. 0 when there are no
 *  visitors to convert (avoids NaN/Infinity from a divide-by-zero). */
export function conversionPct(purchasers: number, visitors: number): number {
  return visitors > 0 ? Math.round((purchasers / visitors) * 1000) / 10 : 0;
}

export interface WeekdayStat {
  label: string;
  visitors: number;
  purchasers: number;
  conversionPct: number;
}

/** One grouped row from the weekday aggregation query, before reindexing.
 *  `pgDow` is Postgres's `extract(dow ...)` value: 0=Sunday..6=Saturday. */
export interface WeekdayRow {
  pgDow: number;
  visitors: number;
  purchasers: number;
}

/** BG short weekday labels, Monday-first (matches the `DOW_SHORT` convention
 *  already used in stats-client.tsx). */
const DOW_LABELS = ['Пон', 'Вто', 'Сря', 'Чет', 'Пет', 'Съб', 'Нед'];

/** Postgres's extract(dow) is 0=Sunday..6=Saturday. This is the Monday-first
 *  reindex order: output position i pulls from raw dow value PG_DOW_ORDER[i]. */
const PG_DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Reindexes raw Postgres dow-grouped rows into a fixed 7-entry Monday-first
 *  array, filling any day with no matching row as zero. Array position is the
 *  day (same fixed-order convention as `buildFunnel`) — no numeric day field
 *  is exposed to callers. */
export function buildWeekdayPattern(rows: WeekdayRow[]): WeekdayStat[] {
  const byDow = new Map(rows.map((r) => [r.pgDow, r]));
  return PG_DOW_ORDER.map((pgDow, i) => {
    const r = byDow.get(pgDow);
    const visitors = r?.visitors ?? 0;
    const purchasers = r?.purchasers ?? 0;
    return { label: DOW_LABELS[i], visitors, purchasers, conversionPct: conversionPct(purchasers, visitors) };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx jest analytics.helpers --silent`
Expected: PASS, all cases green (existing `buildFunnel` tests still pass too).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/analytics/analytics.helpers.ts server/src/modules/analytics/analytics.helpers.spec.ts
git commit -m "feat(analytics): conversionPct + buildWeekdayPattern pure helpers"
```

---

## Task 2: Extract `Seg` into `stat-ui.tsx`

The new trend chart needs a metric toggle identical to the one `stats-client.tsx` already has locally (`Seg`, a generic segmented-pill selector). Writing a third copy would repeat the exact duplication the earlier `stat-ui.tsx` extraction (commit `de725ac`) already fixed once — extract now instead.

**Files:**
- Modify: `client/src/lib/stat-ui.tsx`
- Modify: `client/src/components/stats/stats-client.tsx`

- [ ] **Step 1: Move `Seg` into `stat-ui.tsx`**

Add to `client/src/lib/stat-ui.tsx`, after the existing `ShareBar` function (end of file):

```ts
/** Segmented pill selector (range / metric toggles). */
export function Seg<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { key: T; label: string }[];
}) {
  return (
    <div className="inline-flex flex-wrap rounded-xl border border-ff-border bg-ff-surface p-0.5 shadow-ff-sm">
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={cn(
            'rounded-lg px-3 py-1.5 text-[13px] font-bold transition-colors',
            value === o.key ? 'bg-ff-green-700 text-[#EAF1E4]' : 'text-ff-ink-2 hover:bg-ff-surface-2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Remove the local copy from `stats-client.tsx` and import it**

In `client/src/components/stats/stats-client.tsx`, delete the local `Seg` function definition (the block starting `/** Segmented pill selector (range / metric). */` through its closing `}`, currently right before `SparseTag`).

Find the existing `stat-ui` import line (added in the `de725ac` dedup):

```ts
import { RANGES, errMsg, pctDelta, StatTile, ShareBar } from '@/lib/stat-ui';
```

Change it to:

```ts
import { RANGES, errMsg, pctDelta, StatTile, ShareBar, Seg } from '@/lib/stat-ui';
```

- [ ] **Step 3: Typecheck**

Run: `cd client && npx tsc --noEmit`
Expected: no new errors (confirms `stats-client.tsx`'s existing `Seg` usage still resolves correctly against the imported version).

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/stat-ui.tsx client/src/components/stats/stats-client.tsx
git commit -m "refactor(analytics): extract Seg into stat-ui.tsx (needed by the new trend chart too)"
```

---

## Task 3: `AnalyticsService` — purchases-per-bucket, source conversion, weekday pattern

**Files:**
- Modify: `server/src/modules/analytics/analytics.service.ts`

- [ ] **Step 1: Import the new helpers**

At the top of `server/src/modules/analytics/analytics.service.ts`, change:

```ts
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
```

to:

```ts
import {
  visitorHash,
  deviceFromUA,
  isBot,
  referrerHost,
  buildFunnel,
  conversionPct,
  buildWeekdayPattern,
  ANALYTICS_SPARSE_MIN,
  type FunnelKey,
  type FunnelStep,
  type WeekdayStat,
} from './analytics.helpers';
```

- [ ] **Step 2: Update the `AnalyticsSummary` interface**

Replace the `sources`/`points` lines and add `weekdayPattern`. Current:

```ts
  sources: { host: string; visitors: number }[];
  topPages: { path: string; views: number }[];
  devices: { mobile: number; desktop: number };
  points: { t: string; visitors: number; pageViews: number }[];
  /** Too few visitors for the funnel/sources to mean anything — UI shows a gentle note. */
  sparse: boolean;
}
```

New:

```ts
  sources: { host: string; visitors: number; purchases: number; conversionPct: number }[];
  topPages: { path: string; views: number }[];
  devices: { mobile: number; desktop: number };
  points: { t: string; visitors: number; pageViews: number; purchases: number }[];
  weekdayPattern: WeekdayStat[];
  /** Too few visitors for the funnel/sources to mean anything — UI shows a gentle note. */
  sparse: boolean;
}
```

- [ ] **Step 3: Hoist `localTs` earlier and add the purchased-hash query**

In the `private async compute(...)` method, find:

```ts
    const pv = sql`${siteEvents.eventType} = 'page_view'`;
```

Right after that line, add the purchased-visitor-hash set (awaited up front — `sourcesP` and the new `weekdayP` both need it, so it can't run inside the later `Promise.all`) and hoist the `localTs` BG-local-timestamp expression up here too (it's currently defined later, right before `seriesP`, but `weekdayP` needs it as well):

```ts
    const pv = sql`${siteEvents.eventType} = 'page_view'`;
    const localTs = sql`(${siteEvents.createdAt} at time zone 'UTC' at time zone ${BG_TZ})`;

    // Visitor-hashes that purchased anywhere in the window — the correctness
    // anchor for source/weekday conversion. A purchase event's OWN referrer/day
    // is the checkout page's, not the original channel/day that brought the
    // visitor in, so "did this visitor_hash purchase at all" (not "does this
    // purchase row's own referrer match") is the only correct attribution.
    const purchaserRows = await this.db
      .selectDistinct({ h: siteEvents.visitorHash })
      .from(siteEvents)
      .where(and(inWin, sql`${siteEvents.eventType} = 'purchase'`));
    const purchasedHashes = purchaserRows.map((r) => r.h);
```

Then find the now-duplicate `const localTs = sql...` line further down (originally right before `bucketExpr`/`seriesP`) and delete that second definition — keep only the hoisted one above.

- [ ] **Step 4: Add `purchasers` to `sourcesP`**

Find:

```ts
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
```

Replace with:

```ts
    const sourcesP = this.db
      .select({
        host: sql<string>`coalesce(${siteEvents.referrerHost}, 'директно')`,
        visitors: sql<number>`count(distinct ${siteEvents.visitorHash})::int`,
        purchasers: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${siteEvents.visitorHash} = ANY(${purchasedHashes}))::int`,
      })
      .from(siteEvents)
      .where(and(inWin, pv))
      .groupBy(sql`1`)
      .orderBy(desc(sql`2`))
      .limit(6);
```

- [ ] **Step 5: Add the `weekdayP` query**

Right after the `devicesP` query definition (before the `bucketExpr`/`seriesP` block), add:

```ts
    const weekdayP = this.db
      .select({
        pgDow: sql<number>`extract(dow from ${localTs})::int`,
        visitors: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${pv})::int`,
        purchasers: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${pv} and ${siteEvents.visitorHash} = ANY(${purchasedHashes}))::int`,
      })
      .from(siteEvents)
      .where(inWin)
      .groupBy(sql`1`);
```

- [ ] **Step 6: Add `purchases` to `seriesP`**

Find:

```ts
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
```

Replace with:

```ts
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
```

- [ ] **Step 7: Add `weekdayP` to the `Promise.all` and build the final fields**

Find:

```ts
    const [funnelRows, sources, topPages, deviceRows, seriesRows] = await Promise.all([
      funnelP,
      sourcesP,
      topPagesP,
      devicesP,
      seriesP,
    ]);
```

Replace with:

```ts
    const [funnelRows, sources, topPages, deviceRows, seriesRows, weekdayRows] = await Promise.all([
      funnelP,
      sourcesP,
      topPagesP,
      devicesP,
      seriesP,
      weekdayP,
    ]);
```

Find:

```ts
    const found = new Map(seriesRows.map((r) => [r.t, r]));
    const points = axisKeys.map((t) => {
      const r = found.get(t);
      return { t, visitors: r?.visitors ?? 0, pageViews: r?.pageViews ?? 0 };
    });
```

Replace with:

```ts
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
```

- [ ] **Step 8: Update the `return` statement**

Find:

```ts
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
```

Note the naming collision: the outer scope's local `conversionPct` (top-level headline conversion %, a `number`) now shadows the imported `conversionPct` function used above in Step 7. That's fine — Step 7's usage runs *before* this `return` block reassigns the identifier in this object-literal shorthand, but to avoid confusion for future readers, rename the object key explicitly. Replace with:

```ts
    return {
      range,
      bucket,
      from,
      to,
      visitors,
      pageViews: pageViewRows,
      prevVisitors,
      purchases: purchasesCur,
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
```

This also replaces the two inline percentage calculations with the shared helper. Since `conversionPct` (the object key) is now assigned via `conversionPct(purchasesCur, visitors)` (the imported function), find and **delete** the now-redundant manual calculation lines earlier in `compute()`:

```ts
    const conversionPct = visitors > 0 ? Math.round((purchasesCur / visitors) * 1000) / 10 : 0;
    const prevConversionPct = prevVisitors > 0 ? Math.round((purchasesPrev / prevVisitors) * 1000) / 10 : 0;
```

(These two lines previously shadowed the import with local `const`s of the same name as the interface fields — removing them eliminates that shadowing entirely, which is why the object-literal `conversionPct: conversionPct(...)` call above works cleanly.)

- [ ] **Step 9: Run the existing tests + build**

Run: `cd server && npx jest analytics --silent && npm run build`
Expected: all `analytics.*.spec.ts` suites PASS (existing `track()`/controller/retention/helpers specs unaffected); build exits 0.

- [ ] **Step 10: Commit**

```bash
git add server/src/modules/analytics/analytics.service.ts
git commit -m "feat(analytics): purchases-per-bucket, source conversion, weekday pattern"
```

---

## Task 4: Client types — mirror the server shape

**Files:**
- Modify: `client/src/lib/types.ts`

- [ ] **Step 1: Update `AnalyticsPoint`, `AnalyticsSummary`, add `WeekdayStat`**

Find (around line 623):

```ts
export interface AnalyticsPoint {
  t: string;
  visitors: number;
  pageViews: number;
}

export interface AnalyticsSummary {
  range: StatsRangeTag;
  bucket: StatsBucket;
  /** Resolved window (BG dates, both inclusive). */
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
  /** Too few visitors for the breakdowns to mean anything yet. */
  sparse: boolean;
}
```

Replace with:

```ts
export interface AnalyticsPoint {
  t: string;
  visitors: number;
  pageViews: number;
  purchases: number;
}

export interface WeekdayStat {
  label: string;
  visitors: number;
  purchasers: number;
  conversionPct: number;
}

export interface AnalyticsSummary {
  range: StatsRangeTag;
  bucket: StatsBucket;
  /** Resolved window (BG dates, both inclusive). */
  from: string;
  to: string;
  visitors: number;
  pageViews: number;
  prevVisitors: number;
  purchases: number;
  conversionPct: number;
  prevConversionPct: number;
  funnel: FunnelStep[];
  sources: { host: string; visitors: number; purchases: number; conversionPct: number }[];
  topPages: { path: string; views: number }[];
  devices: { mobile: number; desktop: number };
  points: AnalyticsPoint[];
  weekdayPattern: WeekdayStat[];
  /** Too few visitors for the breakdowns to mean anything yet. */
  sparse: boolean;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd client && npx tsc --noEmit`
Expected: this WILL show new errors — `analytics-client.tsx` doesn't yet consume `weekdayPattern`/`sources[].conversionPct`/`points[].purchases`, but TypeScript won't complain about *unused* fields on an object type (structural typing means extra fields are fine wherever `AnalyticsSummary` is only read from, not constructed). Confirm the only errors (if any) are pre-existing/unrelated; if genuinely clean, proceed.

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/types.ts
git commit -m "feat(analytics): mirror purchases/conversion/weekday fields in panel types"
```

---

## Task 5: `AnalyticsTrendChart` component

**Files:**
- Modify: `client/src/components/stats/trend-chart.tsx` (export `labelFor`)
- Create: `client/src/components/analytics/analytics-trend-chart.tsx`

- [ ] **Step 1: Export `labelFor` from the existing trend chart**

In `client/src/components/stats/trend-chart.tsx`, find:

```ts
function labelFor(t: string, bucket: StatsBucket): string {
```

Change to:

```ts
export function labelFor(t: string, bucket: StatsBucket): string {
```

- [ ] **Step 2: Write the new component**

Create `client/src/components/analytics/analytics-trend-chart.tsx`:

```tsx
'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { labelFor } from '@/components/stats/trend-chart';
import type { AnalyticsPoint, StatsBucket } from '@/lib/types';

const H = 240;
const PAD = { t: 14, r: 10, b: 40, l: 10 }; // extra bottom padding for the purchase bars
const BAR_H = 22; // fixed strip height for the purchase bars, below the line chart

/** Dual-scale trend: the toggled metric (visitors/pageViews) as a green
 *  area+line on its own scale, purchases as small dark bars along the
 *  baseline on an INDEPENDENT scale — so a handful of purchases doesn't
 *  visually vanish next to a much larger visitor count on a shared axis. */
export function AnalyticsTrendChart({
  points,
  bucket,
  metric,
}: {
  points: AnalyticsPoint[];
  bucket: StatsBucket;
  metric: 'visitors' | 'pageViews';
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(760);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw) setW(Math.round(cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const vals = useMemo(() => points.map((p) => p[metric]), [points, metric]);
  const purchaseVals = useMemo(() => points.map((p) => p.purchases), [points]);

  const innerW = Math.max(1, w - PAD.l - PAD.r);
  const lineH = H - PAD.t - PAD.b;
  const n = points.length;
  const maxV = Math.max(1, ...vals);
  const maxP = Math.max(1, ...purchaseVals);
  const stepX = n > 1 ? innerW / (n - 1) : 0;
  const x = (i: number) => PAD.l + (n > 1 ? i * stepX : innerW / 2);
  const y = (v: number) => PAD.t + (1 - v / maxV) * lineH;
  const baseY = PAD.t + lineH;
  const barY = baseY + 10;
  const barWidth = n > 1 ? Math.max(2, Math.min(18, stepX * 0.5)) : 18;

  const linePath = useMemo(() => {
    if (n === 0) return '';
    return vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vals, w, n, maxV]);

  const areaPath = useMemo(() => {
    if (n === 0) return '';
    return `M${x(0).toFixed(1)},${baseY} ${vals
      .map((v, i) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .join(' ')} L${x(n - 1).toFixed(1)},${baseY} Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vals, w, n, maxV]);

  const tickEvery = Math.max(1, Math.ceil(n / 6));

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * w;
    const i = n > 1 ? Math.round((px - PAD.l) / stepX) : 0;
    setHover(Math.max(0, Math.min(n - 1, i)));
  }

  const hv = hover != null ? vals[hover] : null;
  const hp = hover != null ? purchaseVals[hover] : null;
  const svgH = H + BAR_H + 14;

  return (
    <div ref={wrapRef} className="relative w-full select-none">
      <svg
        viewBox={`0 0 ${w} ${svgH}`}
        width="100%"
        height={svgH}
        className="block touch-none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="ff-analytics-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--ff-green-500)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--ff-green-500)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {[0, 0.5, 1].map((f) => {
          const gy = PAD.t + f * lineH;
          return (
            <line key={f} x1={PAD.l} x2={w - PAD.r} y1={gy} y2={gy} stroke="var(--ff-border-2)" strokeWidth={1} />
          );
        })}
        <text x={PAD.l + 2} y={PAD.t - 3} fontSize="11" fontWeight={700} fill="var(--ff-muted-2)">
          {maxV}
        </text>

        {areaPath && <path d={areaPath} fill="url(#ff-analytics-fill)" />}
        {linePath && (
          <path
            d={linePath}
            fill="none"
            stroke="var(--ff-green-600)"
            strokeWidth={2.25}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {/* purchase bars, independent scale */}
        {points.map((p, i) => {
          const h = maxP > 0 ? Math.max(p.purchases > 0 ? 2 : 0, (p.purchases / maxP) * BAR_H) : 0;
          return (
            <rect
              key={p.t}
              x={x(i) - barWidth / 2}
              y={barY + (BAR_H - h)}
              width={barWidth}
              height={h}
              rx={1.5}
              fill="var(--ff-ink-2)"
              opacity={0.75}
            />
          );
        })}

        {/* x-axis labels */}
        {points.map((p, i) =>
          i % tickEvery === 0 || i === n - 1 ? (
            <text
              key={p.t}
              x={x(i)}
              y={barY + BAR_H + 13}
              fontSize="10.5"
              fontWeight={600}
              textAnchor="middle"
              fill="var(--ff-muted)"
            >
              {labelFor(p.t, bucket)}
            </text>
          ) : null,
        )}

        {/* hover guide + dot */}
        {hover != null && hv != null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.t}
              y2={barY + BAR_H}
              stroke="var(--ff-green-600)"
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.55}
            />
            <circle cx={x(hover)} cy={y(hv)} r={4.5} fill="var(--ff-green-700)" stroke="#fff" strokeWidth={2} />
          </>
        )}
      </svg>

      {/* tooltip */}
      {hover != null && hv != null && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-center shadow-ff-md"
          style={{ left: `${(x(hover) / w) * 100}%`, top: 6 }}
        >
          <div className="text-[11px] font-semibold text-ff-muted">{labelFor(points[hover].t, bucket)}</div>
          <div className="ff-fig text-[14px] font-extrabold text-ff-ink">
            {hv} {metric === 'visitors' ? 'посетители' : 'прегледи'}
          </div>
          <div className="ff-fig text-[12px] font-bold text-ff-ink-2">{hp} покупки</div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd client && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/stats/trend-chart.tsx client/src/components/analytics/analytics-trend-chart.tsx
git commit -m "feat(analytics): AnalyticsTrendChart — dual-scale visitors/pageViews + purchases"
```

---

## Task 6: Wire the trend chart into `AnalyticsClient`

**Files:**
- Modify: `client/src/components/analytics/analytics-client.tsx`

- [ ] **Step 1: Add imports and metric state**

Change the lucide-react import block:

```ts
import {
  Users, Eye, MousePointerClick, Target, Smartphone, Monitor,
  Globe, FileText,
} from 'lucide-react';
```

to:

```ts
import {
  Users, Eye, MousePointerClick, Target, Smartphone, Monitor,
  Globe, FileText, TrendingUp, CalendarDays,
} from 'lucide-react';
```

Change:

```ts
import { RANGES, errMsg, pctDelta, StatTile, ShareBar } from '@/lib/stat-ui';
```

to:

```ts
import { RANGES, errMsg, pctDelta, StatTile, ShareBar, Seg } from '@/lib/stat-ui';
import { AnalyticsTrendChart } from './analytics-trend-chart';
```

In the `AnalyticsClient` function body, right after the existing `hydrated` state line:

```ts
  const [hydrated, setHydrated] = useState(false);
```

add:

```ts
  const [metric, setMetric] = useState<'visitors' | 'pageViews'>('visitors');
```

- [ ] **Step 2: Add the trend section**

In the JSX, right after the closing `</div>` of the stat-tile grid (the `grid grid-cols-4 ...` block containing the four `StatTile`s) and before the `<section>` that wraps `Фуния към поръчка`, insert:

```tsx
          <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <TrendingUp size={17} className="text-ff-green-700" />
                <h2 className="text-[16.5px] font-extrabold">Тренд</h2>
              </div>
              <Seg
                value={metric}
                onChange={setMetric}
                options={[
                  { key: 'visitors', label: 'Посетители' },
                  { key: 'pageViews', label: 'Прегледи' },
                ]}
              />
            </div>
            {data.points.length > 0 ? (
              <AnalyticsTrendChart points={data.points} bucket={data.bucket} metric={metric} />
            ) : (
              <div className="grid h-[240px] place-items-center text-sm text-ff-muted">
                Няма данни за периода.
              </div>
            )}
          </section>
```

- [ ] **Step 3: Typecheck + build**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: no errors, `/site-analytics` route compiles.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/analytics/analytics-client.tsx
git commit -m "feat(analytics): wire the trend chart into the panel screen"
```

---

## Task 7: Funnel weakest-step highlight

**Files:**
- Modify: `client/src/components/analytics/analytics-client.tsx`

- [ ] **Step 1: Compute and render the highlight**

Replace the entire `Funnel` function:

```tsx
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
```

with:

```tsx
function Funnel({ steps }: { steps: AnalyticsSummary['funnel'] }) {
  const top = steps[0]?.visitors ?? 0;

  // Weakest step: lowest keep-rate vs. the step right before it. Step 0 has no
  // prior step to compare against, so it's never eligible.
  let weakestIdx = -1;
  let weakestKeepPct = Infinity;
  steps.forEach((s, i) => {
    if (i === 0) return;
    const prevVisitors = steps[i - 1].visitors;
    if (prevVisitors <= 0) return; // nothing to compare against
    const keepPct = (s.visitors / prevVisitors) * 100;
    if (keepPct < weakestKeepPct) {
      weakestKeepPct = keepPct;
      weakestIdx = i;
    }
  });

  return (
    <div className="flex flex-col gap-3">
      {steps.map((s, i) => {
        const pctOfTop = top > 0 ? Math.max(2, Math.round((s.visitors / top) * 100)) : 0;
        const prev = i > 0 ? steps[i - 1].visitors : null;
        const keepPct = prev && prev > 0 ? Math.round((s.visitors / prev) * 100) : null;
        const isWeakest = i === weakestIdx;
        return (
          <div key={s.key}>
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[13.5px] font-bold text-ff-ink-2">
                {i + 1}. {s.label}
                {isWeakest && (
                  <span className="rounded-full bg-ff-amber-softer px-1.5 py-0.5 text-[10.5px] font-bold text-ff-amber-600">
                    най-голям отток тук
                  </span>
                )}
              </span>
              <span className="ff-fig text-[13px] text-ff-muted">
                {s.visitors}
                {keepPct !== null && <span className="ml-2 text-ff-muted-2">({keepPct}% от предната стъпка)</span>}
              </span>
            </div>
            <div className="h-[14px] overflow-hidden rounded-full bg-ff-border-2">
              <div
                className={cn(
                  'h-full rounded-full transition-[width]',
                  isWeakest ? 'bg-ff-amber' : 'bg-ff-green-600',
                )}
                style={{ width: `${pctOfTop}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

(`cn` is already imported at the top of this file — no new import needed. `bg-ff-amber-softer`/`text-ff-amber-600`/`bg-ff-amber` are existing tokens already used for badges elsewhere, e.g. `client/src/components/dashboard/dashboard-client.tsx:191-194`.)

- [ ] **Step 2: Typecheck**

Run: `cd client && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/analytics/analytics-client.tsx
git commit -m "feat(analytics): highlight the funnel's weakest step"
```

---

## Task 8: Best-day-of-week section

**Files:**
- Modify: `client/src/components/analytics/analytics-client.tsx`

- [ ] **Step 1: Add the `WeekdayBars` component**

Add this new function right after the `Funnel` function (before `export function AnalyticsClient`):

```tsx
function WeekdayBars({ pattern }: { pattern: AnalyticsSummary['weekdayPattern'] }) {
  const max = Math.max(1, ...pattern.map((d) => d.visitors));
  const hasData = pattern.some((d) => d.visitors > 0);
  const best = hasData
    ? pattern.reduce((a, b) => (b.visitors > 0 && b.conversionPct > a.conversionPct ? b : a), pattern[0])
    : null;
  const hasBestConversion = !!best && best.conversionPct > 0;

  if (!hasData) {
    return <p className="text-[13px] text-ff-muted">Още няма данни за периода.</p>;
  }

  return (
    <div>
      {hasBestConversion && (
        <p className="mb-3 text-[13px] font-semibold text-ff-ink-2">
          Най-силен ден: <span className="text-ff-green-700">{best!.label}</span> — {best!.conversionPct}% конверсия
        </p>
      )}
      <div className="flex items-end gap-2" style={{ height: 120 }}>
        {pattern.map((d) => {
          const h = Math.max(4, Math.round((d.visitors / max) * 100));
          const isBest = hasBestConversion && d === best;
          return (
            <div key={d.label} className="flex flex-1 flex-col items-center gap-1.5">
              <div className="flex h-[92px] w-full items-end">
                <div
                  className={cn('w-full rounded-t-md transition-[height]', isBest ? 'bg-ff-green-600' : 'bg-ff-border-2')}
                  style={{ height: `${h}%` }}
                />
              </div>
              <span className="text-[11px] font-bold text-ff-muted">{d.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into the screen**

In the JSX, right after the closing `</section>` of the devices section (the last section in the component, containing `Устройства`), add:

```tsx
          <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
            <div className="mb-1 flex items-center gap-2">
              <CalendarDays size={17} className="text-ff-green-700" />
              <h2 className="text-[16.5px] font-extrabold">Дни от седмицата</h2>
            </div>
            <p className="mb-4 text-[13px] leading-[1.45] text-ff-muted">
              Кой ден носи най-много посещения и поръчки.
            </p>
            <WeekdayBars pattern={data.weekdayPattern} />
          </section>
```

(`CalendarDays` was already added to the lucide-react import in Task 6, Step 1.)

- [ ] **Step 3: Typecheck + build**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/analytics/analytics-client.tsx
git commit -m "feat(analytics): best-day-of-week pattern section"
```

---

## Task 9: Source conversion tag

**Files:**
- Modify: `client/src/components/analytics/analytics-client.tsx`

- [ ] **Step 1: Add the conversion tag to the sources `ShareBar` list**

Find:

```tsx
                  {data.sources.map((s) => <ShareBar key={s.host} label={s.host} value={s.visitors} max={srcMax} />)}
```

Replace with:

```tsx
                  {data.sources.map((s) => (
                    <ShareBar
                      key={s.host}
                      label={s.host}
                      meta={`${s.visitors} · ${s.conversionPct}%`}
                      value={s.visitors}
                      max={srcMax}
                    />
                  ))}
```

- [ ] **Step 2: Typecheck + build**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/analytics/analytics-client.tsx
git commit -m "feat(analytics): show conversion rate per traffic source"
```

---

## Task 10: End-to-end verification

**Files:** none (verification only — commit only if a fix was needed).

- [ ] **Step 1: Run the full analytics test suite**

Run: `cd server && npx jest analytics --silent`
Expected: all suites PASS (helpers, service track-path, controller, retention).

- [ ] **Step 2: Migrate + run the API and panel locally**

Per dev docs (DB on port 5433): ensure `packages/db` migrations are applied (`cd packages/db && npm run migrate` — this feature adds no new migration, so this should be a no-op if already up to date), then start the server (`cd server && npm run start:dev`) and the panel (`cd client && npm run dev`).

- [ ] **Step 3: Seed a purchase across a couple of different weekdays/sources and confirm the new fields**

Using a seeded tenant slug (e.g. `ferma-petrovi`), post a page_view + purchase pair, then check `/analytics`:

```bash
curl -s -X POST http://localhost:3001/public/ferma-petrovi/track \
  -H 'content-type: application/json' -H 'user-agent: Mozilla/5.0 (iPhone)' \
  -H 'Referer: https://www.google.com/' \
  -d '{"type":"page_view","path":"/","referrer":"https://www.google.com/"}'
curl -s -X POST http://localhost:3001/public/ferma-petrovi/track \
  -H 'content-type: application/json' -H 'user-agent: Mozilla/5.0 (iPhone)' \
  -d '{"type":"purchase","orderId":"11111111-1111-1111-1111-111111111111","value":1000}'

TOKEN=$(curl -s -X POST http://localhost:3001/auth/login -H 'content-type: application/json' \
  -d '{"email":"ivan@ferma-petrovi.bg","password":"ferma1234"}' | node -e \
  "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).accessToken))")
curl -s "http://localhost:3001/analytics?range=90d" -H "Authorization: Bearer $TOKEN" | node -e \
  "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log('points[].purchases sum:',j.points.reduce((a,p)=>a+p.purchases,0));console.log('sources:',JSON.stringify(j.sources));console.log('weekdayPattern:',JSON.stringify(j.weekdayPattern))})"
```

Expected: `points[].purchases` sums to at least 1; the `google.com` source row shows `purchases >= 1` and a non-zero `conversionPct` (since the same visitor_hash both viewed and purchased); `weekdayPattern` has 7 entries, today's weekday shows `visitors >= 1`.

Note: the `/analytics` response is cached 90s per `(tenantId, from, to)` — if numbers look stale after posting new events, query a different `range` (e.g. switch from `90d` to `1y`) to bypass the cache key rather than waiting.

- [ ] **Step 4: Visual check in the browser**

Open `/site-analytics` in the panel (logged in as the seeded owner). Confirm: the trend section renders a green line with dark purchase bars underneath and the visitors/pageViews toggle switches the line; the funnel shows an amber "най-голям отток тук" badge on exactly one step (or none, if there's too little data for any step-to-step comparison); the new "Дни от седмицата" section renders 7 bars with today's day showing some height; each source row now shows a `visitors · pct%` tag.

- [ ] **Step 5: Commit (only if a fix was required)**

If any fix was needed during verification, commit it with a `fix(analytics):` message. Otherwise this task produces no commit.

---

## Self-Review notes (done during planning)

- **Spec coverage:** trend chart (Section B.1) → Tasks 5–6. Funnel highlight (B.2) → Task 7. Best-day (B.3) → Task 8. Source conversion (B.4) → Task 9. Data model (Section A: `points[].purchases`, purchased-hash attribution, `sources[].conversionPct`, `weekdayPattern`) → Tasks 1 + 3. Sparse handling note from the spec: no new threshold was needed — the new sections read the same `sparse` flag the UI already branches on elsewhere, no server-side change required for that part.
- **Type consistency:** `WeekdayStat`/`WeekdayRow` identical shape in `analytics.helpers.ts` (server) and `WeekdayStat` in `client/src/lib/types.ts` (label/visitors/purchasers/conversionPct in both — server's `WeekdayRow` with `pgDow` is an internal pre-reindex shape, never sent to the client). `AnalyticsTrendChart`'s `metric` prop (`'visitors' | 'pageViews'`) matches the `Seg` options' `key` values used to drive it in Task 6. `conversionPct` (the exported helper function) vs. the `conversionPct` object field on `AnalyticsSummary`/each source/`WeekdayStat` — same name, different things (function vs. computed number); Task 3 Step 8 calls this shadowing risk out explicitly and removes the pre-existing local `const conversionPct = ...` that would have collided with the newly-imported function.
- **Known verification points:** the `= ANY(${purchasedHashes})` Drizzle/Postgres array-parameter binding (Task 3) is exercised for real against the seeded dev DB in Task 10's curl check — if the array binding needs a different Drizzle incantation (e.g. `sql.raw` for the array literal) than what's written, that's the point where it would surface, with an exact expected-output check to catch it.
