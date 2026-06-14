# „Задай наличност" — time-bounded product availability windows

**Date:** 2026-06-14
**Status:** Design approved, ready for implementation plan

## Goal

A new section, **„Задай наличност"**, lets a farmer declare how much of a product
is available for a chosen time window (от–до: a day, a week, a month, several).
Works for single-farmer and multi-farmer tenants (products are already linked to
farmers via `products.farmerId`).

When a window is active, its quantity is the **single source of truth** for that
product's stock everywhere (catalog + the new section): customers order it through
the normal cart/checkout, the quantity depletes per order, and it blocks at 0.

This is the **first real stock-enforcement** mechanism in FarmFlow. The existing
simple „Наличност (бр.)" field stays exactly as it is today (the easy path).

## Key decisions (resolved)

1. **Data model:** separate 1:N table `product_availability_windows` (approach A) —
   supports several scheduled, non-overlapping windows per product.
2. **Source of truth:** an active window overrides the static stock everywhere.
   Outside any window → today's behavior, unchanged.
3. **Period:** free date range `от–до` (inclusive), day-granular, Europe/Sofia.
4. **Customer interaction:** orders from the normal cart; the window quantity is
   real orderable stock, decremented per order, blocked at 0.
5. **Products:** the same existing catalog products, with a window overlay — no
   duplicate listings.
6. **Cancellation:** cancelling an order restores `remaining` **if the same window
   is still active** (best-effort; expired windows are not restored).
7. **Storefront section title:** configurable per tenant, default **„Налично сега"**.
8. **Feature gate:** new tenant boolean, **default OFF** (opt-in), in the
   „Функции на магазина" panel.

## Existing behavior that stays (do NOT change)

The static `products.stockQuantity` (integer; `NULL` = unlimited, `0` = out) keeps
its current semantics and UI:

- Simple „Наличност (бр.)" input in the product editor
  (`client/src/components/products/product-dialog.tsx:220`). Empty = unlimited.
- Farmer-side pill via `stockMeta()` (`client/src/lib/products.ts`) and the
  low-stock notifications in `client/src/components/layout/topbar.tsx`.
- Stripped from the public product (`server/src/modules/products/products.service.ts:469`)
  and **not enforced at checkout** today.

> ⚠️ **Landmine:** `stock_quantity` defaults to `0` (= out of stock), so many
> existing products carry `0` yet sell fine because nothing enforces it. We must
> **never** start enforcing the static field globally — enforcement happens **only
> through an active window**. Outside a window, ordering is unaffected, exactly as
> today.

## Data model

New table (migration `0043`):

```
product_availability_windows
  id           uuid pk default uuid_generate_v4()
  tenant_id    uuid -> tenants(id)
  product_id   uuid -> products(id) ON DELETE CASCADE
  starts_at    date not null            -- от (inclusive)
  ends_at      date not null            -- до (inclusive)
  quantity     integer not null         -- initial qty the farmer set
  remaining    integer not null         -- decremented on order; 0 = sold out
  created_at   timestamptz default now()

  index on (product_id, starts_at, ends_at)   -- active-window lookup
  index on (tenant_id)                          -- tenant-scoped list
```

- **Active window** = `today (Europe/Sofia) BETWEEN starts_at AND ends_at`. No cron —
  "active" is a date comparison evaluated at query time. Leftover `remaining` after
  `ends_at` is simply ignored.
- **At most one active window per product** at any moment — overlapping ranges for
  the same product are rejected on create/update. Multiple **non-overlapping** future
  windows are allowed (the „няколко").
- `ден` = `starts_at == ends_at`; `седмица`/`месец`/`няколко` = wider ranges. One
  mechanism covers all.
- Tz: use Europe/Sofia day boundaries for "today" (consistent with the keyset tz
  hardening already in `server/src/common/pagination/keyset.ts`).

## Effective-stock resolver

A pure helper + one query resolves a product's current stock:

- Find the active window for the product (`today` within range). If present →
  effective stock = `window.remaining`; status derives from `remaining`
  (`0` = sold out).
- No active window → static behavior as today (no public stock, no block).

This resolver feeds: the public catalog product shape, the „Налично сега" section,
and checkout enforcement — one definition, no drift.

## Server — new Nest module `availability`

`server/src/modules/availability/` — controller + service + DTOs, tenant-scoped,
behind the existing JWT + `TenantRolesGuard`.

Endpoints (farmer-facing):

- `GET  /availability-windows?productId=&farmerId=` — list current + upcoming.
- `POST /availability-windows` — `{ productId, startsAt, endsAt, quantity }`.
- `PATCH /availability-windows/:id` — `{ startsAt?, endsAt?, quantity? }`.
  Changing `quantity` shifts `remaining` by the delta, floored at the amount already
  sold (`quantity - remaining`).
- `DELETE /availability-windows/:id`.

Pure, unit-testable helpers (own file, no DB):

- `activeWindow(windows, today)` — pick the active one (or null).
- `overlaps(a, b)` — reject overlapping ranges per product.
- `applyQuantityDelta(window, newQuantity)` — recompute `remaining`.

Validation: `endsAt >= startsAt`, `quantity > 0`, no overlap with the product's
other windows, product belongs to the tenant.

## Checkout enforcement

In the order-create transaction (`server/src/modules/orders/orders.service.ts`,
mirroring the slot row-lock pattern at lines 706–722):

For each ordered item, inside the tx:

1. `SELECT` the active window for `product_id` `.for('update')` (row lock so
   concurrent intakes serialize).
2. If an active window exists:
   - `remaining < qty` → `ConflictException('Няма достатъчна наличност')`.
   - else `UPDATE ... SET remaining = remaining - qty`.
3. No active window → today's behavior (no stock check).

## Cancellation / restore

When an order is cancelled, for each item: if the window it decremented is **still
active**, add the quantity back to `remaining` (capped at `quantity`). Expired
windows are left alone. Identify the window by re-resolving the active window for the
product at cancel time (v1 simple); if it differs from the one charged, skip restore.

## Admin screen „Задай наличност" (client/)

- New nav item under the **„Каталог"** group in `client/src/components/layout/sidebar.tsx`
  (sync the name across sidebar · topbar `PAGE_TITLES` · panel H1 · `/help` ·
  `help-content.ts`, per the nav-naming gotcha).
- Screen: product list → each product's current/upcoming windows; add a window
  (product picker, `от–до` date range, quantity), edit, delete; shows `remaining`
  live.
- Multi-farmer tenants: group/filter by farmer (each farmer's own products, via
  `farmerId`). Single-farmer: flat list.
- Gated by the new feature toggle (hide the nav link when off, like
  `articlesEnabled`).

## Storefront section + public API

- New public read: products with an active window now, grouped by farmer, each with
  `remaining` and sold-out state. Either a new endpoint or an addition to
  `server/src/modules/public-bootstrap/`.
- The public catalog product also exposes the window `remaining` while active (the
  window is the truth in the catalog too) and blocks at 0.
- Storefront rendering of the „Налично сега" section (configurable title) + add-to-cart
  + „остават N" / изчерпан.
  - **Open:** the live storefront is the external Astro repo
    `fermerski-pazar-chaika`; the in-repo `storefront/` (Next) is the older one.
    Confirm which target(s) get the section during planning. Server + admin land in
    this repo regardless.

## Feature toggle + projection

- New tenant column `availability_section_enabled boolean NOT NULL DEFAULT false`
  (migration `0043`), mirroring `articlesEnabled` / `reviewsEnabled` in
  `packages/db/src/schema.ts:55`.
- Surface in the „Функции на магазина" panel
  (`client/src/components/panels/features-panel.tsx`) and the tenant update DTO
  (`server/src/modules/tenants/dto/update-tenant.dto.ts`).
- Project to the storefront via the same path the other section flags use
  (TenantMeta / settings projection), so chaika can gate the section.
- Configurable section title stored alongside (e.g. `settings.availability.title`,
  default „Налично сега").

## Caching

`remaining` is volatile (changes on every order), but the public bootstrap is
Redis-cached for a long TTL (`server/src/common/cache/public-cache.service.ts`).
To avoid showing stale counts:

- Bust the relevant public cache keys on **order create** and on **window CRUD**, OR
- Serve the availability data via a short-TTL / uncached read separate from the
  long-cached bootstrap.

Decision deferred to planning; the constraint (don't long-cache `remaining`) is
fixed.

## Migration `0043`

1. `CREATE TABLE product_availability_windows` + the two indexes.
2. `ALTER TABLE tenants ADD COLUMN availability_section_enabled boolean NOT NULL
   DEFAULT false`.

Go-forward only; no backfill.

## Testing

- Pure helpers: `activeWindow`, `overlaps` (reject), `applyQuantityDelta`.
- Service CRUD: create/list/patch/delete, tenant scoping, overlap rejection.
- Checkout: decrement on order, `409` on insufficient `remaining`, concurrency
  (two intakes racing one window — mirror the slot capacity test).
- Resolver in the public catalog: active window → remaining shown + blocks at 0;
  no window → unchanged.
- Cancellation restores `remaining` only while the window is active.

## Edge cases / landmines

- Static `stock_quantity` default `0` — never start enforcing it; windows only.
- Tz: Europe/Sofia day boundaries for "active today".
- Overlapping windows per product → rejected (≤1 active).
- Sold-out active window (`remaining == 0`) → out of stock in the catalog too.
- No cron: expiry is implicit via date comparison.

## Out of scope (YAGNI)

- Recurring/auto-repeating windows (farmer creates each window explicitly).
- Waitlists / backorders / notify-when-available.
- Per-window pricing (price stays the product's price).
- Reservations/holds before checkout.
