# Site Analytics — trend chart, funnel highlight, best-day pattern, source conversion

**Status:** approved, ready for planning.
**Builds on:** `docs/superpowers/specs/2026-07-03-site-analytics-design.md` (shipped 2026-07-03, FarmFlow `de725ac` / chaika `911d187`).

## Goal

The first analytics release (visitors, funnel, sources, top pages, devices) shipped with one gap: the server already computes a `points` trend series (visitors + pageViews per bucket, gap-filled) but the panel never renders it. This round closes that gap and adds three more "what should I do about it" angles a farmer can act on:

1. **Trend chart** — is traffic going up or down, and does it turn into sales?
2. **Funnel weakest-step highlight** — where exactly are people bailing?
3. **Best-day pattern** — which day of the week actually converts?
4. **Source conversion** — which traffic channel is worth the farmer's time?

All four are additive to the existing `/site-analytics` screen — no redesign, no removed sections.

## Data model changes (server)

Three additions to `AnalyticsSummary` (`server/src/modules/analytics/analytics.service.ts`), computed in `compute()`. No schema/migration changes — all queries run against the existing `site_events` table and its two existing indexes (`tenant_created_idx`, `tenant_type_created_idx`).

### 1. `points[].purchases`

`AnalyticsPoint` gains a third field. Extend the existing `seriesP` query with one more filtered count, same pattern as `visitors`/`pageViews`:

```ts
purchases: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${siteEvents.eventType} = 'purchase')::int`,
```

No `pv` filter needed on this one (unlike visitors/pageViews) since it counts purchase-type rows directly.

### 2. Purchased-visitor-hash set (shared building block)

Both `sources[].conversionPct` and `weekdayPattern[].conversionPct` need to answer "of the visitors attributed to X, how many purchased *anywhere* in the window" — **not** "does the purchase event's own referrer/day match X". By the time a beacon fires on the confirmation page, its referrer is the checkout page and its day-of-week is whatever day checkout happened, not necessarily the day/channel that brought the visitor in. Session-level (visitor_hash) attribution is required for correctness.

One new query, run **before** the rest (breaks the existing full-parallel `Promise.all`, but the result set is small — bounded by distinct purchasers in one tenant's window):

```ts
const purchaserRows = await this.db
  .selectDistinct({ h: siteEvents.visitorHash })
  .from(siteEvents)
  .where(and(inWin, sql`${siteEvents.eventType} = 'purchase'`));
const purchasedHashes = purchaserRows.map((r) => r.h); // string[], passed into the two queries below
```

`sourcesP` and the new `weekdayP` both add a second filtered count using `= ANY(${purchasedHashes})`. If `purchasedHashes` is empty, Drizzle/pg's `= ANY('{}')` correctly matches nothing — no special-case needed.

### 3. `sources[].purchases` + `sources[].conversionPct`

Extend `sourcesP`:

```ts
purchasers: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${siteEvents.visitorHash} = ANY(${purchasedHashes}))::int`,
```

`conversionPct` computed in JS after the query returns (`purchasers / visitors * 100`, one decimal, same rounding convention as the existing top-level `conversionPct`), so the SQL stays a plain count.

### 4. `weekdayPattern`

New query, grouped by BG-local day-of-week across every week in the selected range (not just the latest week):

```ts
const localTs = sql`(${siteEvents.createdAt} at time zone 'UTC' at time zone ${BG_TZ})`;
const weekdayP = this.db
  .select({
    dow: sql<number>`extract(dow from ${localTs})::int`, // 0=Sunday..6=Saturday (Postgres native)
    visitors: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${pv})::int`,
    purchasers: sql<number>`count(distinct ${siteEvents.visitorHash}) filter (where ${pv} and ${siteEvents.visitorHash} = ANY(${purchasedHashes}))::int`,
  })
  .from(siteEvents)
  .where(inWin)
  .groupBy(sql`1`);
```

Reindexed in JS to a fixed 7-entry Monday-first array (mirroring the existing `DOW_SHORT` constant convention in `stats-client.tsx`), missing days filled with zeros. Postgres's `extract(dow ...)` is 0=Sunday..6=Saturday — the reindex step maps that into a Monday-first array (`[Mon, Tue, Wed, Thu, Fri, Sat, Sun]`, i.e. raw dow values `[1,2,3,4,5,6,0]` in order). The array position *is* the day (same convention as the existing fixed-order `funnel` array) — no numeric day field needed on the client side:

```ts
export interface WeekdayStat {
  label: string;      // BG short label, filled server-side ('Пон'..'Нед'), array is always Monday-first
  visitors: number;
  purchasers: number;
  conversionPct: number;
}
```

### Updated `AnalyticsSummary` shape

```ts
export interface AnalyticsPoint {
  t: string;
  visitors: number;
  pageViews: number;
  purchases: number; // NEW
}
export interface AnalyticsSummary {
  // ...unchanged fields...
  sources: { host: string; visitors: number; purchases: number; conversionPct: number }[]; // +purchases, +conversionPct
  weekdayPattern: WeekdayStat[]; // NEW, always 7 entries
  // ...
}
```

Mirror the same shape in `client/src/lib/types.ts` (hand-kept in sync, as today — no shared package).

### Sparse handling

`weekdayPattern` and the new `sources[].conversionPct` follow the existing `sparse` flag (`visitors < ANALYTICS_SPARSE_MIN`, currently 30) — the panel already shows a "малко посещения" note when sparse; the new sections render but the UI treats their numbers as equally soft in that state. No new threshold.

## Panel changes (`client/src/components/analytics/analytics-client.tsx`)

### 1. Trend chart (new component, new file `client/src/components/analytics/analytics-trend-chart.tsx`)

Placed directly after the stat-tile grid, before the funnel section. New component (not a `TrendChart` prop extension — the dual-scale line+bar rendering is different enough from the single-line toggle `TrendChart` does today that forking is cleaner than branching one component two ways):

- Reuses `TrendChart`'s axis-label (`labelFor`), resize-observer, and hover-tooltip patterns (copy the shape, not the file — same reasoning the original `stat-ui.tsx` dedup used: only extract shared pieces once actual duplication across *this* pair of files is proven, not preemptively).
- Left scale: green area+line for the toggled metric (visitors ↔ pageViews — same toggle UX as `stats-client.tsx`'s existing metric switcher).
- Right scale (independent max, not shared with the line): short dark bars along the baseline for `purchases` per bucket.
- Hover tooltip shows bucket label + both values (line metric + purchase count) for that bucket.
- Empty/all-zero purchases in the window → bars simply don't render (no special-case UI), consistent with how the rest of the screen handles zero data.

### 2. Funnel weakest-step highlight (edit `Funnel` in `analytics-client.tsx`)

Pure client-side calc, no backend change: for steps 2–5, find the one with the lowest `keepPct` (skip step 1, which has no "previous step" to compare against). Badge that row — small amber pill next to the step, e.g. "най-голям отток тук" — and give its progress bar an amber fill instead of green. If all steps are 0 (no data past step 1), skip the highlight entirely (nothing to call out).

### 3. Best-day section (new, placed after the devices section)

7 vertical bars (Пон→Нед), height = `visitors`, x-axis labels = `label`. The single highest-`conversionPct` day (among days with `visitors > 0`) gets an accent color + a one-line callout above the chart: "Най-силен ден: Петък — 18% конверсия" (day name + its conversionPct). If every day has 0 visitors (fresh site), render the empty-state copy already used elsewhere ("Още няма данни...").

### 4. Source conversion tag (edit the existing sources `ShareBar` list)

Append a small conversion tag to each source row's `meta`, e.g. `"12 посетители · 25%"` — reuses `ShareBar`'s existing `meta?: string` prop from the `stat-ui.tsx` dedup (already optional, already supports a custom display string), no new component needed. Sort order stays visitors-desc (unchanged) — conversion tag is informational, not a re-rank, so a farmer scanning by traffic volume doesn't get the list reshuffled.

## Testing

**Server (`analytics.service.spec.ts`, extend existing mock-db test file):**
- `points[].purchases` populated from mocked query rows.
- Source conversion: a source with 3 page_view visitors, 1 of which is in the purchased-hash set → `purchasers: 1, conversionPct: 33.3`.
- Weekday grouping: mocked rows for a couple of `dow` values → confirms the fixed 7-entry Monday-first reindex fills missing days with zero and doesn't drop/duplicate any day.
- `purchasedHashes` empty (no purchases in window) → sources/weekday `conversionPct` all `0`, no query error.

**Panel:** `npx tsc --noEmit` + `npm run build` (matches the existing project convention — `analytics-client.tsx` has no unit tests today, verified via typecheck + manual browser check, same as `stats-client.tsx`). Manual verification: confirm the trend chart renders with real seeded data, confirm the funnel highlight picks the correct weakest step, confirm best-day bars and source conversion tags match a manual `/analytics` API cross-check.

## Out of scope (deferred, not part of this round)

- Re-sorting sources by conversion instead of volume (explicitly rejected during design — keep the existing scan order).
- Per-product conversion breakdown (funnel already tracks `product_view`/`add_to_cart` in aggregate, not per-SKU — a future round if requested).
- Exporting/downloading the analytics data (CSV etc.) — not requested.
