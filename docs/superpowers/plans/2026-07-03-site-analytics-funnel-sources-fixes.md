# Site Analytics — Real Funnel, Honest Sources & Query Optimization

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The DB-query layer is only mock-tested in unit specs — **every query change MUST be verified with a live E2E pass** (seed events via the `/public/:slug/track` beacon, then read `/analytics`), per the hard-won lesson in `project_farmflow_site_analytics_visualizations` that Drizzle query bugs slip past mocked tests.

**Context:** The `/site-analytics` panel shipped 2026-07-03 (FarmFlow `de725ac` → `e4cc190`, chaika → `716472e`). Live review surfaced three correctness problems plus one known perf inefficiency. All fixes are **query/logic + client-beacon only — no schema change, no migration.**

**Repos:**
- `FarmFlow` — backend query layer (`server/src/modules/analytics/`), panel UI (`client/src/components/analytics/`).
- `fermerski-pazar-chaika` — the storefront beacon (`src/lib/track.ts`).

---

## Problems & root causes (confirmed by code reading + live panel)

1. **The funnel isn't a funnel (shows "150% от предната стъпка").**
   `buildFunnel()` + the `funnelP` query count **distinct visitors per event type independently**. `add_to_cart` fires from `fermerski-pazar-chaika/src/lib/cart.ts:46` — invoked by the add button on the **shop listing (ProductCard)**, not only the product detail page — while `product_view` fires only on `product/[slug].astro`. So a visitor can `add_to_cart` without ever firing `product_view`, making step 3 (3 visitors) exceed step 2 (2 visitors) → an impossible 150% keep-rate. Independent per-step counts can never be a truthful funnel.

2. **The storefront's own domain shows up as the top traffic source.**
   `analytics.service.ts` self-referral filter is `if (host && host.includes(slug)) host = null;` with `slug = 'fermeski-pazar-chayka'`. The live domain is `farmmarket.bg`, which does not contain the slug, so internal page-to-page navigation (referrer = `https://farmmarket.bg/...`) is stored as `referrer_host = 'farmmarket.bg'` and dominates "Откъде идват".

3. **Sources don't reconcile with the headline ("15 vs 10", sources sum to 17 > 10 visitors).**
   The `sourcesP` query counts distinct visitors **per referrer host**. One visitor with two referrers across the window is counted under both hosts, so the sources list sums to more than the total distinct-visitor headline. Sources don't partition visitors, which reads as "the numbers are wrong".

4. **`purchaserHashes` round-trip (perf).**
   `compute()` awaits a `selectDistinct(visitorHash)` query **before** the `Promise.all`, ships every purchaser hash back to Node, then re-sends them as an `inArray(...)` IN-list into the sources + weekday queries. Two sequential DB phases + an N×64-char payload crossing the wire twice. Fine at farm-stall scale (the 90s cache absorbs it), wasteful once a tenant has many purchasers.

## Decisions locked (2026-07-03)

- **Funnel = "deepest stage reached."** Each visitor is bucketed at the deepest step they hit; a visitor who added to cart also counts toward "viewed product." Counts are monotonically non-increasing by construction → a true funnel. Correctly absorbs add-from-listing.
- **Sources = first-touch, one source per visitor.** Each visitor attributed to the referrer host of their earliest page_view in the window (external preferred over null). Sources then partition visitors and sum ≤ total. Self-referrals excluded.
- **Historical polluted rows: let them age out** via the existing 180-day retention prune. No data migration.

---

## Task 1 — Client: drop same-origin (self-referral) referrers at the source

- [ ] In `fermerski-pazar-chaika/src/lib/track.ts`, compute the referrer so a **same-host** `document.referrer` is treated as internal navigation and sent as empty. Domain-agnostic (works for `farmmarket.bg`, any custom domain, any future storefront) — do **not** hardcode a domain or reuse the tenant slug.
  ```ts
  function externalReferrer(explicit?: string): string {
    const ref = explicit ?? document.referrer ?? '';
    try {
      if (ref && new URL(ref).host === location.host) return ''; // internal nav → not a source
    } catch { /* unparseable → treat as no referrer */ }
    return ref;
  }
  ```
  Use it where the body currently sets `referrer: data.referrer ?? document.referrer ?? ''`.
- [ ] Leave the backend's existing slug-based filter in place as harmless defense-in-depth (it does no harm; the real fix is client-side + Task 3's attribution).
- [ ] `npx astro check` clean.

**Verify:** load the local storefront, navigate page→page, confirm the emitted beacon body has `referrer: ""` on internal navigations (inspect via `mcp__claude-in-chrome__javascript_tool` reading the outgoing body, or a temporary log). External referrers (set `document.referrer` via a real cross-site nav, or fake it in a probe) still pass through.

## Task 2 — Backend: normalize referrer host at ingest

- [ ] In `server/src/modules/analytics/analytics.helpers.ts`, extend `referrerHost()` to normalize the extracted host: strip a leading `www.`, and collapse known link-shim / mobile subdomains to their canonical host so one channel isn't fragmented into `m.facebook.com` / `l.facebook.com` / `lm.facebook.com`:
  - `*.facebook.com` (m/l/lm/web/…) → `facebook.com`
  - `*.instagram.com` → `instagram.com`
  - leading `www.` stripped generally (`www.google.com` → `google.com`)
  Keep it a small, explicit map + a `www.` strip — do not over-engineer a PSL parser.
- [ ] Unit tests in `analytics.helpers.spec.ts`: `referrerHost('https://lm.facebook.com/x') === 'facebook.com'`, `referrerHost('https://www.google.com/s') === 'google.com'`, unknown hosts pass through unchanged, empty/garbage still → null.

**Note:** normalization at ingest only affects rows written after deploy; old rows age out (locked decision). No read-time backfill.

## Task 3 — Backend: real funnel via "deepest stage reached"

- [ ] Replace the independent-per-type `funnelP` query with a per-visitor deepest-stage aggregation. Stage ranks: `page_view=0, product_view=1, add_to_cart=2, checkout_start=3, purchase=4`. One query, current + previous window fused (preserve the existing prev-window headline deltas):
  ```sql
  WITH per_visitor AS (
    SELECT visitor_hash,
      max(CASE event_type WHEN 'page_view' THEN 0 WHEN 'product_view' THEN 1
                          WHEN 'add_to_cart' THEN 2 WHEN 'checkout_start' THEN 3
                          WHEN 'purchase' THEN 4 END)
        FILTER (WHERE created_at >= :since) AS cur_deepest,
      max(CASE ... same ... END)
        FILTER (WHERE created_at <  :since) AS prev_deepest
    FROM site_events
    WHERE tenant_id = :t AND created_at >= :prevSince AND created_at < :toExcl
    GROUP BY visitor_hash
  )
  SELECT
    count(*) FILTER (WHERE cur_deepest  >= 0) AS s0_cur, ... >=4 AS s4_cur,
    count(*) FILTER (WHERE prev_deepest >= 0) AS s0_prev, ... >=4 AS s4_prev
  FROM per_visitor;
  ```
- [ ] Derive headline from this single result: `visitors = s0_cur`, `purchases = s4_cur`, `prevVisitors = s0_prev`, `prevConversionPct` from `s4_prev/s0_prev`. Funnel steps = `[s0_cur..s4_cur]` (guaranteed monotonic non-increasing).
- [ ] **Preserve `pageViews`** (total `page_view` **rows**, not distinct — "общо отваряния"). It is not derivable from `per_visitor`. Either sum the `seriesP` points' `pageViews`, or add a dedicated `count(*) FILTER (WHERE event_type='page_view' AND created_at >= since)` — pick the cheaper; document the choice.
- [ ] `buildFunnel()` in `analytics.helpers.ts`: adapt to take the ordered stage counts directly (it already just maps to labelled steps). The client's `keepPct >= 100` weakest-step guard becomes structurally unreachable but leave it as defense.
- [ ] Unit tests: feed a mixed set (a visitor with only page_view; one who added to cart but never product_view; one who purchased) and assert the funnel is monotonic and add-without-view rolls the visitor into the product_view stage.

**Verify (E2E, required):** seed via the beacon a visitor who fires `page_view` + `add_to_cart` but **no** `product_view`; confirm the panel funnel shows them in step 2 (Разгледали продукт) as well as step 3, and no step exceeds the one above it.

## Task 4 — Backend: first-touch single-source attribution + fold out `purchaserHashes`

- [ ] Rewrite `sourcesP` to attribute each visitor to exactly one host — their earliest external referrer in the window (external preferred over null), counted once. Conversion via a server-side join to the purchase-hash set (no app round-trip, no IN-list):
  ```sql
  WITH vs AS (
    SELECT DISTINCT ON (visitor_hash) visitor_hash, referrer_host
    FROM site_events
    WHERE tenant_id=:t AND created_at>=:since AND created_at<:toExcl AND event_type='page_view'
    ORDER BY visitor_hash, (referrer_host IS NULL) ASC, created_at ASC  -- external first, then earliest
  ),
  buyers AS (
    SELECT DISTINCT visitor_hash FROM site_events
    WHERE tenant_id=:t AND created_at>=:since AND created_at<:toExcl AND event_type='purchase'
  )
  SELECT coalesce(vs.referrer_host,'директно') AS host,
         count(*)::int AS visitors,
         count(*) FILTER (WHERE b.visitor_hash IS NOT NULL)::int AS purchasers
  FROM vs LEFT JOIN buyers b USING (visitor_hash)
  GROUP BY 1 ORDER BY 2 DESC LIMIT 6;
  ```
  (`DISTINCT ON` is Postgres-specific — use a raw `sql` fragment; **do not** use `ANY(array)` binding, per the `inArray` lesson.)
- [ ] Rewrite `weekdayP`'s `purchasers` to use the same `buyers` join / an `EXISTS` correlated subquery instead of the `isPurchaser = inArray(...)` app-list.
- [ ] **Delete** the standalone `purchaserRows` query + `purchasedHashes` + `isPurchaser` `inArray`. After this, all read queries run inside `Promise.all` with **no preceding sequential query** — this is the perf fix (point 4) folded into the same refactor.
- [ ] Confirm the `sources` return shape is unchanged (`{ host, visitors, purchases, conversionPct }`) so the client needs no change.

**Verify (E2E, required):** seed one visitor arriving via `google.com` then later with a `farmmarket.bg` (internal) referrer → they must appear once under `google.com`, never under the site's own domain; and the sources' `visitors` must sum to ≤ the headline visitors.

## Task 5 — Reconcile & document the visitor count ("15 vs 10")

- [ ] After Tasks 1–4, verify on the live panel that: `headline visitors == funnel step 1 == Σ(sources.visitors)` (sources now partition visitors, so they sum exactly, modulo the top-6 `LIMIT`). If the top-6 limit truncates, that's expected — note it.
- [ ] Confirm the count is the intended **cookieless distinct daily visitor** (`sha256(ip+ua+day+tenant+salt)`): repeat loads from the same browser same-day collapse to 1; different device/IP/day = new. If the operator's "15" was raw visits and the panel's "10" is distinct dailies, that's correct behaviour — capture the explanation in the memory note, don't "fix" the dedup.
- [ ] Sanity-check for an off-by-one or a stray non-`page_view` type inflating/deflating the headline now that funnel step 1 is the single source of truth for `visitors`.

## Task 6 — Full verification & ship

- [ ] `npx jest src/modules/analytics` — all green (rebuild `@fermeribg/db` first only if the schema/types changed; they don't here).
- [ ] `npx tsc --noEmit -p .` clean in both `server` and `client`.
- [ ] `npx astro check` clean in `fermerski-pazar-chaika`.
- [ ] Live E2E in the preview (`api-dev` + `web-dev` + `chaika`): seed a realistic mixed event set, confirm funnel monotonic, sources partition & exclude self-referral, headline reconciles.
- [ ] Commit per-repo (backend fixes in `FarmFlow`, beacon fix in `fermerski-pazar-chaika`), push `main` on both. **No migration to coordinate** — pure logic change.
- [ ] Update memory (`project_farmflow_analytics_toppages_pagelabel` sibling or a new note): funnel is now deepest-stage; sources first-touch single-attribution; self-referral filtered client-side by same-host; `purchaserHashes` round-trip removed.

---

## Out of scope / explicitly deferred
- Historical self-referral / un-normalized referrer rows: **age out via retention** (locked). No backfill.
- Session-window definition (multi-day sessions, 30-min inactivity, etc.) — cookieless daily hash stays as-is.
- Wiring the beacon into FarmFlow-Templates factory sites — separate effort; this plan keeps the backend storefront-agnostic so that lands cleanly later.
