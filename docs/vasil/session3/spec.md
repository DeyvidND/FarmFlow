# Session 3 — Продукт, Кошница, Еконт, Карта — SPEC

Operator: Vasil. Branch: `feat/vasil-products-cart`. FarmFlow monorepo only (chaika
storefront changes are DOCUMENTED, not applied). Migration lane 0100–0103 (latest on
main = 0092; journal idx continues contiguously 93→).

Apps: `server/` (@fermeribg/api, NestJS), `client/` (@fermeribg/web, farmer panel),
`admin/` (@fermeribg/admin, super-admin console), `packages/db` (@fermeribg/db, Drizzle
schema + migrations), `packages/types` (@fermeribg/types).

---

## Task #1 — Фермерска кошница / готови пакети (ready-made bundles)

**Ask:** Create a "farmer basket" product like Product-of-the-Week but the operator can
add/remove *real products* into it — a weekly basket, one product per farmer; a section for
ready-made packages/bundles.

**Reality found:** A bundle concept already half-exists: `products.category = 'bundle'` +
`products.bundleItems jsonb<string[]>` (curated *text* lines like "Малини 250 г", migr 0038
era). It is NOT linked to real product rows — so no add/remove of actual products, no
logistics/stock link.

**Design:** Keep the bundle-as-a-product grain (a bundle is a `products` row with
`category='bundle'`, its own price/slug/image). Add a real, queryable membership via a new
join table `product_bundle_items (bundle_id → product_id, quantity, position)`. The operator
manages members through a full-replace endpoint (mirrors the existing variants "full replace"
pattern). Public payload exposes resolved `bundleProducts[]` so the storefront can render the
basket contents. `bundleItems` (text lines) stays for backward-compat display.

**Backend deliverables:**
- Table `product_bundle_items` (migr 0100).
- `PUT /products/:id/bundle-items` (full replace) + `GET /products/:id/bundle-items` (admin +
  farmer-scoped, same guards as other product writes).
- `buildPublicProduct` / `findPublicBySlug` attach `bundleProducts[]` (member id/name/slug/
  image/quantity/price) for `category='bundle'` products, resolved in-memory from the loaded
  catalog (no extra per-request query).
- Farmer-panel UI (`client/`) to add/remove member products on a bundle product.

**Chaika (documented):** storefront "Готови пакети / Кошница на седмицата" section rendering
`bundleProducts`, add-whole-basket-to-cart.

---

## Task #2 — Mandatory companion ≥ X € (REVISED by Vasil — folded into bundles)

**Revised ask:** No longer apricot-specific. A product OR a bundle can require a MANDATORY
additional item from the store, where that additional item's price must be ABOVE a configurable
EUR threshold. Generalized to: "this item requires at least one OTHER cart item priced ≥ X €" —
configurable threshold, NOT hardcoded. One system with the bundles (task #1).

**Design:** Two per-product columns (migr 0101):
- `requires_companion boolean default false` — the gate.
- `companion_min_price_stotinki integer` (nullable) — EUR-cents threshold (same unit as
  `price_stotinki`). NULL = any other product qualifies.

Rule (enforced in `OrdersService.reserveCartItems`, ALL delivery methods): if any cart line's
product has `requiresCompanion=true`, the cart must contain ≥1 line for a **different** product
whose unit price ≥ `companionMinPriceStotinki` (or any other product when NULL). Unit price is
`resolveLineUnit` (sale-aware, variant-aware). Multiple units of the SAME flagged product do NOT
satisfy it. `byId` + `variantById` already loaded — no extra query.

**Backend deliverables:** `requiresCompanion` + `companionMinPriceStotinki` DTO fields
(companion price `''→null` `@Transform`); enforcement + Bulgarian error message (names the
product + „на стойност поне X,XX €"); unit spec (`orders.companion.spec.ts`).

**Chaika (documented):** checkout pre-check blocking the order + inline message (with/without
threshold) + a nudge. See `chaika-changes.md`.

---

## Task #3 (#11) — Еконт per-product clarity + red-in-cart

**Ask:** Each product must clearly show whether it can ship via Econt/other courier. When the
customer enters an address OUTSIDE Varna & Dobrich AND selects Econt, the non-shippable
products in the cart light up RED (can't ship them).

**Reality found:** The courier-shippability flag ALREADY EXISTS as
`products.courierDisabled` (migr 0074): `true` = pickup-only, never on a waybill. Server
already enforces it (`OrdersService.reserveCartItems` rejects a carrier order containing a
`courierDisabled` product, orders.service.ts:1800) and it already flows into the public
payload. Adding a separate `econtShippable` column would duplicate this and create two flags
that must stay in sync (the farmer product dialog already toggles `courierEnabled =
!courierDisabled`).

**Design decision (flagged to Vasil):** Do NOT add a redundant column. Reuse `courierDisabled`
as the single source of truth and expose a **positive** computed alias
`courierShippable = !courierDisabled` in the public product payload for clear, unambiguous
storefront display. No migration for #11. The Varna/Dobrich local-zone decision is a
storefront concern (which delivery methods to offer for a typed city) — documented for chaika
with a shared city list; the server backstop already guarantees a courierDisabled product can
never actually ship.

**Backend deliverables:** `courierShippable: boolean` on `PublicProduct` (+ set in
`buildPublicProduct`). (No new courier granularity; "Econt or друг куриер" = general courier
shippability.)

**Chaika (documented):** per-product badge ("може по куриер" / "само вземане/местна доставка"),
Varna+Dobrich local-zone list, and the red highlight + checkout block when address is outside
the zone AND Econt is selected AND a `courierShippable=false` item is in the cart.

**Open question for Vasil:** Do you ever need Econt-specific vs Speedy-specific granularity
(a product OK for one courier but not the other)? Current model is all-couriers-or-none.

---

## Task #4 (#12) — Карта на производители (producers map)

**Ask:** Map of all producers we work with, published on the site; later used for logistics.
Reuse the existing producers list/data.

**Reality found:** Cross-tenant producers list exists: `GET /platform/farmers`
(super-admin, PlatformAdminGuard) → `PlatformService.listAllFarmers`. Farmers have only
free-text `city` (no coordinates). `MapsService` exists (Google Geocoding, 30-day Redis
cache) but `geocode()` deliberately rejects town-centroid ("coarse") results — unusable for
city-level producer pins. Admin map lib `@vis.gl/react-google-maps` exists only in `client/`,
NOT `admin/` (avoid adding npm deps to keep the worktree build green).

**Design:** Add `farmers.lat / lng / geocoded_at` (migr 0102), cached geocoded coordinates
resolved from `legal.address` / `city`. Add `MapsService.geocodeApprox()` — a forward geocode
that ACCEPTS locality-level results (for producer/logistics pins), cached 30d. New super-admin
endpoint `GET /platform/producers/map` returns producers with coordinates; rows missing coords
(and having a city/address) are geocoded on read (bounded concurrency) and persisted. New
admin page `(panel)/producers-map` renders a Google Map with a pin per producer (dynamic Maps
JS API script loader — no new npm dep — with a table fallback when the key/maps are absent),
plus a sidebar nav entry. "Publish on the site" for now = the internal super-admin console
(Vasil: "ние тепърва ще я използваме за логистиката").

**Backend deliverables:** migration; `geocodeApprox`; `PlatformService.producersMap`;
controller route; types.

**Frontend deliverables (admin/):** page + client map component + nav entry + api-client fn.

---

## Migrations (lane 0100–0103; journal idx contiguous from 92)

| file | journal idx | change |
|------|-------------|--------|
| `0100_bundle_products.sql` | 93 | create table `product_bundle_items` |
| `0101_product_requires_companion.sql` | 94 | `products.requires_companion boolean not null default false` + `products.companion_min_price_stotinki integer` (EUR-cents threshold) |
| `0102_farmer_geo.sql` | 95 | `farmers.lat/lng numeric(10,7)`, `farmers.geocoded_at timestamptz` |

No 0103 needed. NEVER leave a journal idx gap (breaks the migrator silently). Filenames use
the reserved 0100+ range; journal `idx` continues 93/94/95 from 92.

## DTO gotcha

Booleans (`requiresCompanion`, `courierDisabled`) arrive as real JSON booleans →
`@IsOptional() @IsBoolean()` is safe. The `''→undefined` `@Transform` gotcha only bites
string/enum/number fields from form posts; the new UUID/int bundle fields use
`@IsUUID()`/`@IsInt()` which reject `''` correctly — no Transform needed, but do NOT relax
them to plain `@IsOptional()`.

## Verification

- `pnpm --filter @fermeribg/db build`, `--filter @fermeribg/types build`,
  `--filter @fermeribg/api build` compile clean.
- New Jest specs pass: bundle membership service, companion-rule enforcement, geocodeApprox.
- Migrator applies cleanly (drizzle `migrate()` reads `_journal.json` + .sql — dry run against
  dev DB on :5433 if available).
- Exercise the producers-map endpoint (returns producers, geocodes missing coords).
- Admin producers-map page renders (or falls back to table without a key).
