# Site Analytics — „Анализ на сайта" (traffic + funnel)

Date: 2026-07-03
Status: approved design → implementation plan next

## Problem

Farmers have a sales screen („Статистика", `stats.service.ts` / `stats-client.tsx`) built
entirely from `orders` — its own comment states *"no tracking infra"*. There is **zero
traffic data**: no visitors, no page views, no funnel, no conversion. Farmers can see
*what sold* but never *how many people came, where they came from, and where they dropped
off before buying*.

This feature adds first-party, privacy-safe site analytics: a new **„Анализ на сайта"**
screen driven by traffic events collected from the storefront, plus the collection
endpoint and storage.

## Goals

- A genuinely different screen from „Статистика" — traffic + funnel, not sales.
- Own infrastructure only: events land in **our** Postgres, no external service, no
  monthly fee, negligible footprint on the current Hetzner VM.
- Privacy-safe / EU-safe: **cookieless** (Plausible model) → no cookie banner.
- Farmer sees their own traffic; super-admin sees all (same role pattern as Статистика).

## Non-goals (v1)

- Templates / client-site storefronts. Only **chaika** is instrumented in v1.
- Cross-day / cross-device visitor identity. Daily-rotating salt by design.
- Real-time dashboards. 90s-cached, like Статистика.
- A/B testing, heatmaps, session replay.

## The six insights (the screen)

All distinct from Статистика (which is sales-only):

1. **Посетители** — unique visitors + total page views over the window, trend line.
   Unique = real people (distinct daily visitor hash), not raw hits.
2. **Фуния (core)** — 5 steps, each with people-count + drop-off %:
   `Влезли → Разгледали продукт → Добавили в кошница → Започнали checkout → Купили`.
   Each step shows absolute count, % of previous step, and leak. Plus overall
   conversion (buyers / visitors).
3. **Източници** — referrer hosts (Google, Facebook, direct, other). Host only, never
   the full URL.
4. **Топ страници** — most-viewed paths.
5. **Устройства** — mobile vs desktop, derived from User-Agent server-side (free).
6. **Conversion rate** — headline %, visitors → buyers, with delta vs the equal prior
   window.

Range selector + sparse-data note reuse the Статистика conventions (7d/30d/90d/1y +
custom, „малко данни" tag).

## Privacy model — cookieless unique visitors

Plausible-style, no cookies, no consent banner:

- Server computes `visitor_hash = sha256(ip + user_agent + daily_salt + tenant_id)`.
- The IP is used **only transiently** to compute the hash — it is **never stored**.
  Only the hash is persisted.
- Unique visitor = distinct `visitor_hash`. Funnel step reach = distinct `visitor_hash`
  that fired that event type in the window.
- `daily_salt` rotates every calendar day (BG time) → the same person gets a different
  hash tomorrow, so no cross-day tracking is possible. Salt kept in memory/config;
  derived from date so it needs no storage.

## Data — new table `site_events` (new migration)

| column           | type          | notes                                             |
|------------------|---------------|---------------------------------------------------|
| id               | bigserial PK  |                                                   |
| tenant_id        | uuid          | FK-style, indexed                                 |
| visitor_hash     | text          | daily hash, computed server-side                  |
| event_type       | text          | page_view \| product_view \| add_to_cart \| checkout_start \| purchase |
| path             | text          | request path only                                 |
| referrer_host    | text null     | host only (no full URL, no query)                 |
| product_id       | uuid null     | on product_view / add_to_cart                     |
| order_id         | uuid null     | on purchase (lets us reconcile with real orders)  |
| value_stotinki   | int null      | on purchase                                       |
| device           | text          | mobile \| desktop (from UA)                        |
| created_at       | timestamptz   | default now()                                     |

Indexes: `(tenant_id, created_at)`, `(tenant_id, event_type, created_at)`.
Retention: a cron prunes rows older than 180 days. Volume ceiling ~1 GB/year — noise on
the CX23 (2 vCPU / 4 GB / ~80 GB).

## Flow

```
chaika (Astro on CF Workers)         FarmFlow API (this repo)      Panel (this repo)
  window.ffTrack(type, data)   →   POST /track  (public)      →   site_events (Postgres)
  - page load    → page_view       compute visitor_hash            ↑
  - product page → product_view    drop bots by UA                 analytics.service reads
  - „в кошница"  → add_to_cart     no tenant → drop                AnalyticsClient renders
  - checkout load→ checkout_start  fire-and-forget → 204
  - confirmation → purchase(orderId, value)
```

## Components

### FarmFlow (this repo)

- **Migration** creating `site_events` + indexes.
- **`AnalyticsModule`**:
  - `POST /track` — **public**, no auth. Throttled + bot-filtered. Reads client IP + UA
    to compute the hash and device, validates `tenantId` exists, writes one row,
    returns `204` fast (fire-and-forget; a write failure never surfaces to the browser).
  - `GET /analytics` — auth, role `admin`/`farmer` (mirrors Статистика). Supports the
    same window params (range / from / to) and, for admins, an optional `farmerId`
    scope.
- **`analytics.service.ts`** — pure helpers (funnel assembly, drop-off %, buckets,
  device split) unit-tested in isolation, separated from the DB queries, following the
  `stats.service.ts` structure. 90s cache via `PublicCacheService`.
- **`AnalyticsClient`** panel screen + a new menu entry. Farmer sees own tenant;
  super-admin sees all (and can scope by farmer). Reuses the range pills / tiles /
  share-bar visual vocabulary from `stats-client.tsx`.

### chaika (separate local repo `fermerski-pazar-chaika`, CF Workers)

- A first-party tracker exposing `window.ffTrack(type, data)`.
  - ⚠️ Astro hoist bug (memory): never wrap a hoisted `<script>` in `{cond && ...}`.
- Wire calls from existing handlers: page load, product page, add-to-cart, checkout
  page load, order-confirmation page.
- `purchase` fires on the confirmation page with `orderId` + order value.

## Key gotchas (baked in from memory)

- **Browser-reachable endpoint + CORS.** `/track` is a browser `fetch` from chaika to
  the API. A prior live bug had a CF-IP-only firewall dropping browser fetches
  (`PUBLIC_BASE` branches on `typeof window`). `/track` must sit on the public
  browser-reachable base and CORS must allow the chaika origin.
- **Tenant resolution.** chaika already knows its tenant from `/bootstrap`; it sends
  `tenantId` in the `/track` payload. Server validates it exists; unknown → drop.
- **Fire-and-forget.** Tracking must never block or error the storefront; the beacon is
  best-effort (`navigator.sendBeacon` where possible).
- **Bot filter.** UA regex (googlebot, bingbot, crawlers, headless) → drop; missing
  tenant → drop.

## Testing

- Pure helpers (funnel drop-off, device split, window resolution) unit-tested directly,
  like the stats pure helpers.
- `/track` accepts a valid event, computes a stable same-day hash, rejects unknown
  tenant and known bots.
- `/analytics` scopes correctly by role/farmer and matches the funnel math on seeded
  events.

## Rollout

1. FarmFlow: migration + module + endpoints + screen (this repo).
2. chaika: tracker script + call sites (local repo, deploy = CF Workers Builds on push).
3. Verify real events flow; confirm CORS/firewall path works from a real browser.
4. Templates instrumentation — later, out of v1 scope.
