# Super-admin „Анализ" — farm-health insights for the platform operator

Date: 2026-06-12
Branch: feat/cod-payment-method
Status: approved, implementing

## Problem

The platform operator (super-admin) helps farmer-customers over Viber/phone. They
need an at-a-glance view that answers three questions, so they know **who to call
and what to help with** — not vanity metrics:

1. Which farm is stuck / needs attention right now?
2. Which features are barely used across all farms (so I know what to teach/improve)?
3. How is each farm trending (orders/revenue up or down)?

A reviews-style system is explicitly out of scope (farmers contact the operator
directly). No new event/click tracking — everything is **derived from data we
already store** (orders, products, settings flags, Stripe/Econt status, slots,
reviews, articles, subscribers). Zero new infra, low bloat.

## Where it lives

New page in the separate super-admin Next app (`admin/`), route `/insights`,
nav label **„Анализ"**. Server component fetches the snapshot; a `'use client'`
component renders three stacked blocks. Matches existing `admin/` patterns
(server page → `initial` prop → client component, `ff-*` design tokens,
lucide icons, BFF proxy for client-side refetch).

## Block 1 — Ферми за внимание (signal list)

Per-farm health signals, each row: име · телефон (Viber-ready) · причина (BG) ·
предложено действие. Sorted by severity (highest first). A farm appears once,
with all its signals as chips. Only farms with ≥1 signal are listed. Thresholds
are fixed constants in one file (no settings UI — YAGNI).

Signals (all derived):

| key | условие | severity | действие (BG) |
|---|---|---|---|
| `empty_shop` | created > 7д ago AND 0 активни продукта | 90 | „Помогни да качи продукти" |
| `no_orders` | активни продукти > 0 AND 0 поръчки изобщо | 70 | „Сподели линка / маркетинг" |
| `dormant` | имал поръчки, последна > 30д | 60 | „Обади се, виж какво става" |
| `dropping` | поръчки(пред. 7д) ≥ 3 AND поръчки(посл. 7д) ≤ 50% от тях | 50 | „Поръчките падат — провери" |
| `stripe_incomplete` | stripeAccountId има, charges НЕ е enabled | 65 | „Довърши картовите плащания" |
| `econt_incomplete` | settings.delivery.econt е започнат, configured ≠ true | 55 | „Довърши Econt доставка" |

Thresholds: `EMPTY_SHOP_DAYS=7`, `DORMANT_DAYS=30`, `DROP_MIN_PREV=3`,
`DROP_RATIO=0.5`. Window math uses rolling `now() - interval`.

## Block 2 — Използване на функции (adoption)

Platform-wide. Denominator = all tenants (N). For each feature, count of tenants
where it is **really used**, not merely toggled. Horizontal bars, least-used at
top (so the gap is obvious). Each: label · count · N · %.

| feature | „реално ползване" |
|---|---|
| Доставка | `deliveryEnabled = true` |
| Econt | `settings.delivery.econt.configured = true` |
| Карти (Stripe) | `stripeChargesEnabled = true` |
| Слотове | ≥1 ред в `delivery_slots` |
| Бюлетин | ≥1 активен subscriber (`unsubscribed_at` null) |
| Отзиви | ≥1 публикуван review |
| Новини | ≥1 публикувана статия |
| Мулти-фермер | `multiFarmer = true` |
| Подкатегории | `multiSubcat = true` |
| Продукт на седмицата | `productOfWeekEnabled = true` |

## Block 3 — Тренд (stock-style chart, centerpiece)

Hand-rolled SVG area+line chart (no chart-lib dep — the `admin/` app is
deliberately lean; matches `ff-*` styling). Controls like a stock app:

- **Range:** `7д · 30д · 3м · 1г · Всичко`
- **Metric toggle:** `Поръчки · Приход` (client-side; both metrics returned per
  point so the toggle is instant, no refetch)
- **Scope:** `Всички ферми` (total) or pick one farm from a dropdown
- **Hover tooltip:** exact value + bucket label

Bucket granularity by range: 7д/30д → дневно, 3м → седмично, 1г/Всичко → месечно.
Bucketing + gap-fill done in SQL via `generate_series` in **Europe/Sofia** local
time (`created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Sofia'`), so buckets
align with the wall clock (consistent with `bg-time.ts`). Revenue excludes
cancelled orders; returned in stotinki, formatted client-side with `eur()`.

## Backend (NestJS, `platform` module, `PlatformAdminGuard`)

Two read-only endpoints, all over existing tables:

- `GET /platform/insights` → `{ farms: [{id,name}], signals: FarmSignals[],
  adoption: AdoptionRow[], totalFarms }`. `farms` powers the chart's scope
  dropdown; `signals` is block 1; `adoption` is block 2.
- `GET /platform/insights/timeseries?range=7d|30d|90d|1y|all&tenantId?` →
  `{ range, bucket: 'day'|'week'|'month', points: [{ t, orders, revenueStotinki }] }`.

`range`/`tenantId` validated against a fixed whitelist (the date_trunc unit/step
must be an inlined constant — never user free-text).

Implementation mirrors `tenantDetail`: a few independent grouped aggregates run
with `Promise.all`, stitched in JS into signals + adoption. Dataset is small
(tens of farms) — clarity over micro-optimization, but windows stay sargable.

## Frontend (`admin/`)

- `admin/src/app/(panel)/insights/page.tsx` — server component, fetches
  `/platform/insights`, renders `<InsightsClient initial=… />`.
- `admin/src/components/insights-client.tsx` — three blocks; fetches timeseries
  via BFF on mount + on range/scope change.
- `admin/src/components/trend-chart.tsx` — hand-rolled responsive SVG chart
  (area path, line, x labels, pointer-driven tooltip, range/metric/scope
  controls).
- `admin/src/lib/api-client.ts` — add types + `getInsights()`,
  `getInsightsTimeseries(range, tenantId?)`. BFF proxy is generic; no route change.
- `admin/src/components/panel-chrome.tsx` — add „Анализ" nav link (lucide
  `LineChart`/`Activity`), placed right after „Фермери".

## Out of scope (to keep it lean)

Event/click tracking · configurable-threshold UI · reviews-style support system ·
CSV export · alerting/notifications · audit-log mining.

## Verification

- Backend: jest for the insights service (signal classification + adoption counts
  on a seeded fixture; timeseries bucket shape). Run sequentially per the
  jest+build FS-flake gotcha on this machine.
- Frontend: `tsc` + `next build` for `admin/`; live smoke (login → /insights →
  toggle range/metric/scope, hover tooltip, verify a known-stuck farm surfaces).
