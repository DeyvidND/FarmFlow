# „Днес" — Operator Command Center

**Date:** 2026-07-20
**Status:** Design approved, ready for implementation planning
**Scope:** One implementation plan (backend aggregate endpoint + frontend home rebuild)

## Problem

The FarmFlow operator panel scatters the day's operational pipeline across five
separate screens — Поръчки, Подготовка, Маршрут, Протоколи, Плащания. An operator
running a farm's day has no single place that answers "what is happening today and
what still needs doing." The current post-login home, `/dashboard` ("Табло"), is a
*business overview* (placed-day revenue, order-count delta, a first-run readiness
checklist). It shows vanity numbers, not the day's work, and most of those numbers
already live on `/stats`.

## Goal

Replace the home screen with **„Днес"** — a delivery-day operational cockpit that
puts today's whole pipeline on one screen: order flow, prep progress, route status,
handover-protocol status, and cash to collect. Glance at the state; jump to the full
screen to act; take the few highest-value actions inline.

## Non-goals (YAGNI)

- Inline protocol signing, prep-fulfillment toggling, or route reordering/reassignment
  (that duplicates the dedicated screens — the "Rich" tier we rejected).
- A per-producer „Днес" for farmer sub-accounts. The home stays owner/operator-facing;
  farmers keep their existing reduced nav.
- A new "business review" page. That role already belongs to `/stats` (Статистика).

## Key decisions

1. **„Днес" replaces `/dashboard` as the home.** The nav `HOME` item keeps its href
   (`/dashboard`) so every existing link and post-login redirect keeps working; only
   its label ("Табло" → "Днес") and icon change. Biz-review stays at `/stats`; no new
   page is created for the demoted content.
2. **Delivery-day semantics throughout.** Every tile answers "what ships / collects
   *today*", keyed on `scheduledForDay(day)` = `coalesce(deliverySlots.date,
   bgDate(orders.created_at))`. This is the opposite of the old dashboard, whose counts
   were placed-day (`created_at`). Every query touching `scheduledForDay` MUST
   `leftJoin(deliverySlots)` or Postgres throws (documented landmine).
3. **One purpose-built aggregate endpoint**, `GET /dashboard/today`, returns the whole
   cockpit payload in a single round trip of cheap tenant-scoped `GROUP BY` queries run
   in parallel. Route and protocol headline numbers are **derived from cheap status/type
   counts, never** by calling the expensive `getRoute` (route optimization + Google
   Routes calls) or `listForDay` (5–6-query fan-out). This follows the session's N+1
   discipline: summarize, don't fan out.
4. **Standard actionability.** Summary tiles + deep-links + two inline actions:
   bulk-confirm today's pending orders, and mark an order delivered from the feed.

## Architecture

### Backend — `GET /dashboard/today?date=`

New controller route on the existing `dashboard` module (cohesive: it is the home's
data source), backed by `DashboardService.todaySummary(tenantId, date?)`. Guards match
the existing summary route (`JwtAuthGuard`, `@CurrentTenant`). `date` defaults to
`bgToday()` (Europe/Sofia).

Return type **`TodaySummary`**:

```ts
interface TodaySummary {
  date: string;                       // resolved BG calendar day (YYYY-MM-DD)
  pipeline: {
    new: number;                      // status='pending' (awaiting confirm)
    confirmed: number;
    preparing: number;
    outForDelivery: number;           // status='out_for_delivery'
    delivered: number;
    cancelled: number;
    total: number;                    // active orders today = new+confirmed+preparing+outForDelivery+delivered (excludes cancelled)
  };
  prep: {
    ordersToPrep: number;             // handover-ready today (confirmed+preparing)
    fulfilled: number;                // orders whose prep is marked fulfilled
  };
  route: {
    stops: number;                    // address-delivery orders in route-basis statuses
    delivered: number;
    pending: number;                  // stops - delivered
    couriers: number;                 // distinct assigned courier legs for the day
  };
  protocols: {
    total: number;                    // expected farmer-legs + customer-legs today
    signed: number;                   // persisted handover rows, status='signed'
    pending: number;                  // total - signed
  };
  cod: {
    toCollectStotinki: number;        // COD, counted statuses, not yet collected, not refused
    toCollectCount: number;
    collectedStotinki: number;        // COD marked received today
    collectedCount: number;
  };
  revenueStotinki: number;            // today's delivery-day turnover (non-cancelled order totals)
  slots: Array<{ id: string; timeFrom: string; timeTo: string; booked: number; capacity: number }>;
}
```

**Query plan (~6–8 cheap queries, one `Promise.all`, all tenant-scoped, all
`leftJoin(deliverySlots)` where they use `scheduledForDay`):**

- **Pipeline + revenue + route split**: a `GROUP BY status` (and, for the route split,
  a filter on `deliveryType='address'`) count over orders scheduled for the day. This
  single grouped shape yields the pipeline counts, the non-cancelled revenue sum, and
  the route stop/delivered numbers. Status enum: `pending | confirmed | preparing |
  out_for_delivery | delivered | cancelled`.
- **COD to-collect + collected**: grouped over orders scheduled for the day with
  `paymentMethod='cod'`, split on collected/`codOutcome`. Counted statuses =
  `confirmed | preparing | out_for_delivery | delivered`; exclude `codOutcome='refused'`
  from to-collect; `collected` = COD marked received. **This query is new — nothing
  per-day existed** (the old payments totals are lifetime, not date-scoped).
- **Prep fulfilled**: count of the day's handover-ready orders whose fulfillment state
  is `fulfilled` (from the fulfillments table), against `ordersToPrep`.
- **Protocols**: `signed` = count of persisted `handover` rows for the day with
  `status='signed'`. `total` = expected farmer-legs (distinct `farmerId`+`slotId` among
  handover-ready orders) + customer-legs (address orders, handover-ready). `pending` =
  `total - signed`. All cheap distinct/counts — **not** the full `listForDay` assembly.
- **Couriers**: distinct assigned courier legs for the day (from the courier-assignment
  board), or 0 when unassigned.
- **Slots**: reuse the existing dashboard slots query (slots for the day + booked).

Where a query needs raw drizzle `sql``` (e.g. a conditional `SUM(CASE …)`), remember
the repo gotchas: `CASE…THEN` needs an explicit `::int`; use `inArray`, never `ANY()`.

### Frontend — `client/src/app/(admin)/dashboard/`

Follows the dominant repo pattern: **server component fetches, one `'use client'`
component renders and mutates.**

- **`dashboard/page.tsx`** (rewrite): async server component, `dynamic =
  'force-dynamic'`. Parallel `fetch` of `${API_BASE}/dashboard/today?date=` and
  `${API_BASE}/orders?date=&limit=100` (today's feed), plus the existing readiness load
  (kept only to drive the first-run nudge). Bearer-cookie + `cache: 'no-store'` + a
  local `getJson<T>(path, fallback)` that never throws. Passes `summary`, `orders`,
  `readiness`, `deliveryEnabled` to the client component.
- **`components/today/today-client.tsx`** (new): the orchestrator. Holds local state,
  renders the day header + `DateNavBar`, the tiles, and the orders feed. Inline actions
  via existing `api-client` functions — `confirmPending(date)` for bulk-confirm and
  `updateOrderStatus(id, 'delivered')` from the feed — with optimistic state and
  `sonner` toast (matching the current dashboard-client), refreshing stats via a
  `getTodaySummary(date)` call rather than `router.refresh()`.
- **Tiles** (new, small, under `components/today/`): pipeline strip, prep tile, route
  tile, protocols tile, COD tile. Reuse `StatTile` (`lib/stat-ui.tsx`) / `StatCard`
  (`components/dashboard/stat-card.tsx`) and the card convention `rounded-xl border
  border-ff-border bg-ff-surface p-5 shadow-ff-sm`. Each tile is a `<Link>` deep-link to
  its full screen (`/prep`, `/route`, `/protocols`, `/payments`). Money always rendered
  via `moneyFromStotinki()`.
- **Reused as-is**: `OrdersFeed` (`components/dashboard/orders-feed.tsx`) for the feed,
  `DateNavBar` (`components/production/date-nav-bar.tsx`), `StatusBadge`, `Button`,
  `StoreReadinessCard` (as the first-run nudge only).
- **`lib/api-client.ts`**: add `getTodaySummary(date)` → `apiFetch('/dashboard/today?…')`
  returning `TodaySummary`; add `confirmPending(date)` if not already present.
- **Nav** (`components/layout/sidebar.tsx`): `HOME` label "Табло" → "Днес", icon
  "Днес"-appropriate (e.g. `CalendarCheck`). `/stats` "Статистика" unchanged as the
  biz-review home.

## Data flow

1. Operator lands on `/` → redirected to `/dashboard` (unchanged redirect).
2. Server component resolves the day (default today), fires the aggregate fetch +
   orders-feed fetch + readiness in parallel, renders `today-client` with props (no
   loading flash).
3. Client renders tiles from `summary`; each links out. Date nav re-fetches
   `getTodaySummary(date)` + the feed for the chosen day.
4. Inline "Потвърди всички" → `confirmPending(date)` → optimistic pipeline update +
   re-fetch summary. Inline mark-delivered → `updateOrderStatus(id,'delivered')` →
   optimistic feed + pipeline update.

## Error handling

- Server fetches never throw: each falls back to an empty/zeroed `TodaySummary` and an
  empty feed, so a backend hiccup renders an empty-but-valid cockpit, never a 500 page
  (matches the existing dashboard's `getJson` discipline).
- Inline mutations surface the API's Bulgarian error via `sonner` toast and roll back
  the optimistic state on failure.
- The aggregate endpoint is defensive per-query: a single failing sub-query should not
  blank the whole payload where avoidable (each sub-result defaults to zero).

## Testing (TDD — write the failing test first)

**Backend (`server`, jest):**
- `todaySummary` unit tests with a mocked db. **Model the WHERE clause** (tenant scope
  + delivery-day `leftJoin(deliverySlots)`) — a mock that ignores the filter certifies
  nothing (session lesson: "model filter+timezone or it's theatre").
- COD to-collect excludes `codOutcome='refused'` and only counts the counted statuses;
  collected is separate.
- Pipeline status mapping is exact (each enum value lands in the right bucket).
- Any raw drizzle `SQL` is rendered via `new PgDialect().sqlToQuery(expr)` and asserted
  on `params` — never `toEqual`'d (raw `SQL` is circular → jest JSON crash).

**Frontend (`client`, jest):**
- Each tile renders its numbers and links to the correct href.
- "Потвърди всички" calls `confirmPending(date)` and optimistically clears "Нови".
- Mark-delivered from the feed calls `updateOrderStatus(id,'delivered')` and moves the
  order to delivered in both feed and pipeline.
- Empty/zeroed summary renders a valid empty cockpit.

**Full suite green** (`pnpm --filter @fermeribg/api test` + client test) before commit.

## Rollout

- Backend-first is safe here: the new endpoint is additive; the frontend degrades to a
  zeroed cockpit if the endpoint is missing. Deploy backend then frontend (matches the
  repo's re-seed/back-compat guidance).
- Push to `main` auto-deploys (Hetzner), now gated on green tests. Docs-only changes
  don't trigger deploys.
