# farmmarket.bg — Marketplace Build (design)

**Date:** 2026-07-10
**Status:** draft — awaiting owner review
**Scope:** turn the farmmarket.bg storefront (today: one FarmFlow tenant manually
imitating a multi-vendor market) into a real marketplace, plus the dormant money
ledgers (commission + vendor subscriptions) and the farmer-panel changes that
support it.

## 1. Context

- farmmarket.bg runs on chaika against ONE FarmFlow tenant ("Фермерски пазар
  Чайка", Варна/Добрич). ~15 farmers exist as `farmers` rows; buyers see a mixed
  `/shop` and per-farmer pages, but the back office is single-shop.
- Much of the multi-vendor machinery already exists and is reused, not rebuilt:
  - `farmers` table (vendor profiles + media), `tenants.multiFarmer` toggle
  - farmer **sub-account logins** (`users.farmerId`, role `farmer`, JWT carries
    `farmerId`, IDOR-safe scoping via `effectiveFarmerId`) with farmer-scoped
    products CRUD, my-orders, stats
  - `products.farmerId` attribution on every order item (via product)
  - per-farmer courier order split (`orders.farmerId`, migr 0070)
- Strategy (decided): marketplace-first; standalone branded sites are a later
  upsell for farmers already earning (land-and-expand). Operator currently
  charges vendors **€12/month, collected off-platform**; commission comes later.

**Architecture decision (approved):** the marketplace stays **one tenant**;
farmers are vendors inside it. NOT one-tenant-per-farmer: a mixed cart would
cross N slot/delivery/billing configs, and logistics (Friday market + one local
delivery operation) is genuinely shared. Tier-3 "own site" later = copying a
vendor into a fresh tenant (storefront factory already exists) — out of scope
here.

**Buyer model (approved):** guest checkout stays; accounts are optional
(post-purchase "запази данните си" + normal signup). Accounts give order
history, one-click reorder, saved address, favorite farmers.

## 2. What gets built (four workstreams)

### A. Vendor finance — DORMANT ledgers (commission + monthly subscription)

Goal: the logic exists, records everything, **charges nothing** until a
per-tenant settings flip. No UI-facing behavior changes while dormant.

Config, per tenant, in `tenants.settings.vendorFinance` (jsonb, defensive
parse; absent → everything off):

```ts
{ commissionEnabled: boolean,            // default false
  defaultCommissionRateBps: number,      // default 0 (500 = 5%)
  subscriptionEnabled: boolean,          // default false
  defaultSubscriptionFeeStotinki: number } // default 0; €12 = 1200
```

Per-farmer overrides (new nullable columns on `farmers`):
`commission_rate_bps`, `subscription_fee_stotinki` (NULL = tenant default).

**Commission ledger** — new table `commission_entries`, one row per
(order, farmer): `gross_stotinki` (item-only sum for that farmer's products —
delivery fee excluded, same rule as turnover), `rate_bps` **snapshotted at
accrual** (enabling commission later never retro-charges old orders),
`commission_stotinki = round(gross × rate / 10000)`, `status`
accrued | voided | settled (settled is final), unique `(order_id, farmer_id)`
(idempotent re-accrual — first snapshot wins).

Accrual fires on the **collected-money signal**, mirroring Плащания semantics:

| Seam | Action |
|---|---|
| `setCodOutcome` → received | accrue (revives a previously voided entry) |
| `setCodOutcome` → refused | void |
| Stripe paid webhook (order flipped to confirmed+paidAt) | accrue |
| `updateStatus` → cancelled (incl. auto-COD-refuse) | void |

All seam calls are fire-and-forget (`void this.commission?.…`); the service
swallows its own errors (logger.warn) — the ledger must never break an order
write. `CommissionService` is injected `@Optional()` into `OrdersService` and
`StripeService` so every existing test harness stays valid; modules
(`OrdersModule`, `StripeModule`, `AppModule`) wire `VendorFinanceModule`.

Items on products with `farmer_id = NULL` (the tenant's own goods) accrue no
commission. Orders already cancelled/refused never accrue (defense in the
service, not only at the seams).

**Vendor subscriptions** — new table `vendor_subscription_charges`: one row per
(farmer, period `'YYYY-MM'`, unique), `fee_stotinki`, `status`
due | paid | waived, `paid_at`, `note`. **No cron, no auto-charge**: an explicit
owner action generates a month's `due` rows (fee = farmer override ?? tenant
default; fee ≤ 0 skipped); generation 409s while `subscriptionEnabled` is off.
The operator keeps collecting money off-platform and marks rows paid/waived.

**API** (`/vendor-finance`, JwtAuthGuard + roles):
- `GET commission/summary?farmerId&from&to` — roles admin+farmer; producer is
  forced to own `farmerId` (same `effectiveFarmerId` scope as /stats); returns
  per-farmer gross/commission/settled + totals + config echo.
- `GET subscriptions?period` / `POST subscriptions/generate {period}` /
  `PATCH subscriptions/:id {status, note}` — admin only.

**Migration 0085** (hand-written, journal idx 85): 2 enums, 2 tables + indexes,
2 farmer columns. A working draft of this whole workstream (module, settings
reader, migration SQL) was written and reviewed in the 2026-07-10 session and
is parked at
`C:\Users\Lenovo\AppData\Local\Temp\claude\C--Users-Lenovo-source-repos-FarmFlow\797cd1ec-4328-44b8-be93-77c114cc33ff\scratchpad\vendor-finance-draft\`
— the implementation plan should restore/adapt it rather than rewrite (if the
temp dir is gone, the spec above is complete enough to recreate it).

### B. Buyer accounts (guest + optional)

- New `buyers` table (NOT `users`): tenant-scoped, `email` (unique per tenant),
  `password_hash`, `name`, `phone`, `default_address` jsonb, timestamps.
  Rationale: panel `users` carry panel roles/guards; a separate table + a
  distinct JWT type (`buyer`) makes it structurally impossible for a buyer
  token to reach panel endpoints (JwtAuthGuard rejects the type outright).
- New `buyer-auth` module: register, login, me, logout (JWT, same bcrypt +
  tokenVersion conventions as panel auth). Public storefront endpoints.
- `orders.buyer_id` nullable FK; checkout accepts an optional buyer token and
  stamps it. Post-purchase claim: the confirmation screen offers account
  creation prefilled with the order's email — the just-placed order attaches
  immediately (session-proven ownership). OLDER guest orders with the same
  email attach only after the buyer clicks an email-confirmation link (reuses
  the existing email infra); no link click → no historic attachment.
- Buyer endpoints: `GET /buyer/orders` (history + reorder payload),
  `GET/PUT /buyer/profile`, favorites (farmer ids jsonb) — small.
- Guest checkout remains untouched — zero added friction for the default path.

### C. Marketplace front (new repo `farmmarket-web`, Next.js)

New standalone front repo (same pattern as chaika/Templates: own repo, own
deploy, reads the same backend public API + new buyer endpoints). Replaces the
current chaika-based farmmarket.bg. Marketplace chrome per the approved design
(Claude Design project "Фермерски пазари", Lora + Manrope, honest numbers):

- search-first sticky header + city pill + cart; discovery nav (Фермери,
  Категории, Най-продавани, Ново, Седмична кошница, Как работи); shop pages
  single-business chrome (За нас/Статии/Отзиви/Контакти) demoted to footer
- farmer-first product cards (avatar chip + name links to the farmer's shop),
  farmer rail ("Фермери близо до теб"), featured farmer, category chip filter,
  new-this-week rail, weekly-box email capture, trust band
- tier-2 pages: `/ferma/[slug]` — the farmer's branded shop-in-market (cover,
  story, own products, shareable link), served from existing public catalog API
- cart groups items by farmer and checkout shows the per-farmer breakdown
  (buyer-visible honesty; backend order stays ONE order — logistics is shared)
- no fake numbers: counters come from the API (farmers count, product count)

SEO/API note: public catalog endpoints already exist (chaika consumes them);
the new front adds buyer-auth endpoints only.

#### C.1 Feature → backend → panel matrix (what feeds every storefront feature)

| Storefront feature | Backend today | To build | Panel control |
|---|---|---|---|
| Announcement bar | — | `settings.marketplace.announcement` {enabled, text} + public expose | Settings: text + on/off |
| Search (product/farmer) | public catalog | nothing (client-side; hundreds of products) | — |
| City pill (Варна ▾) | — | `settings.marketplace.cities` | Settings: city list |
| Honest counters (farmers/products/cities) | data exists | counts in public bootstrap | — (automatic) |
| Hero collage photos | site-media screen exists | nothing | existing Сайт-медия |
| Farmer rail (avatar, specialty, place, since, product count) | farmers list, role+since exist | **`farmers.place`** column + product count in payload | farmer form: new „Място" field |
| **Featured farmer (Фермер на седмицата)** | ❌ only productOfWeek exists | mirror it: `settings.marketplace.farmerOfWeek` {enabled, mode manual/auto (ISO-week like productOfWeek), farmerId, quote} + public expose | «Функции на магазина»: farmer picker + quote + mode |
| Category tiles + chip filter | categories/subcategories exist | nothing | existing Подкатегории |
| Farmer-first product cards | product→farmer attribution exists | nothing (front layout) | — |
| „Ново тази седмица" rail | products.createdAt | expose createdAt/isNew publicly | — (automatic) |
| Weekly-box email capture | newsletterSubscribers exists | `source: 'box'` tag on subscribe | existing Бюлетини |
| Cart grouped by farmer + checkout breakdown | order stays ONE | nothing backend; front grouping | — |
| Tier-2 `/ferma/[slug]` page | farmer pages exist but UUID URLs; farmerMedia galleries exist | **`farmers.slug`** column (from name, unique per tenant, backfilled) | slug field (auto, editable) on farmer form |
| „Проверен фермер" badge | — | nothing: vendors are operator-curated → static badge. A `verified` column only if self-signup ever opens | — |
| Buyer account/history/favorites | ❌ | workstream B | — (panel untouched) |
| Commission + subscriptions (dormant) | ❌ | workstream A | «Финанси на пазара», «Моят отчет», override fields |

Net-new backend beyond workstreams A+B: one small migration
(`farmers.place`, `farmers.slug` + backfill), the `settings.marketplace`
block (announcement, cities, farmerOfWeek) exposed via public bootstrap, and
public payload additions (counts, product createdAt, farmer place/slug/media).

### D. Farmer panel (client/) changes

1. **Owner screens** (role admin):
   - «Финанси на пазара» page: commission summary table (per farmer, period
     filter) + subscriptions ledger (generate month, mark paid/waived, notes).
     Clearly badged «изключено» while dormant.
   - Farmer edit form gains the two override fields (rate bps shown as %, fee
     shown in €) — visible only when the tenant has `multiFarmer`.
2. **Producer screens** (role farmer): «Моят отчет» — own gross/commission
   summary (reuses the same endpoint, IDOR-scoped). While commission is
   dormant this reads as the farmer's collected turnover — useful on day one.
3. **Farmer form** gains four fields total: „Място" (place), slug
   (auto-generated from name, editable), and the two finance overrides above.
4. **«Функции на магазина» / Settings** gains the marketplace-content block:
   featured farmer (picker + quote + manual/auto mode — mirrors Продукт на
   седмицата), announcement-bar text, city list.
5. No changes to existing orders/products/my-orders flows. Everything else on
   the storefront is fed by screens the panel already has: products
   (farmer-scoped), availability, Сайт-медия (hero photos), Подкатегории
   (category tiles), Бюлетини (weekly-box list), my-orders.

## 3. Order flow (unchanged core, one addition)

One buyer cart → ONE order (existing intake), items attributed per farmer via
`products.farmerId`. Fulfillment, slots, routing, courier split: untouched.
The only new behavior: the money seams above write dormant ledger rows, and
checkout stamps `buyer_id` when a buyer token is present.

## 4. Phases (implementation plan slices this)

1. **Vendor finance backend** (schema 0085 + module + seams + tests) — smallest,
   already drafted; ships dormant, zero user-visible change.
2. **Panel screens** for A (owner finance page, producer report, farmer form
   overrides).
3. **Marketplace content backend** (farmers.place/slug migration + backfill,
   `settings.marketplace` block, public bootstrap additions: counts, createdAt,
   farmerOfWeek/announcement/cities) + the matching panel controls (farmer form
   fields, «Функции на магазина» block).
4. **Buyer accounts backend** (buyers table + auth + order stamping + history).
5. **farmmarket-web** repo (marketplace chrome, tier-2 pages, buyer UI, cart
   grouping) + DNS cutover from the chaika instance.
6. Later / out of scope here: subscription veggie boxes, tier-3 graduation
   tooling, settlement payouts (marking settled + statements), enabling
   commission for real.

## 5. Testing

- Jest service specs (chainable-mock DB pattern from billing.service.spec):
  rate resolution (override > default > 0; disabled → 0), rounding, accrual
  idempotency, voided→accrued revival, settled immutability, cancel/refuse
  voiding, subscription generation guard + idempotency + fee resolution,
  period validation, buyer auth (hashing, token type rejection by panel guard),
  IDOR scope on commission summary (producer forced to own farmerId).
- Existing suites must stay green with NO edits (the `@Optional()` injection
  guarantees this for orders/stripe specs).
- Manual verify while dormant: place/cancel/COD-mark orders on a dev tenant →
  ledger rows appear with rate 0; no behavior change anywhere user-facing.

## 6. Risks / notes

- **Auto-deploy:** pushing to main deploys. Every phase must be shippable;
  phase 1 is safe by construction (dormant, no UI).
- Migration 0085 is additive only (no rewrites of hot tables).
- `commission_entries` money is in the same minor unit as order totals
  (`*_stotinki` columns, eurocents post-euro-switch).
- Enabling commission later is: write `settings.vendorFinance`, set farmer
  overrides, done — по желание с отделен admin UI (out of scope).
