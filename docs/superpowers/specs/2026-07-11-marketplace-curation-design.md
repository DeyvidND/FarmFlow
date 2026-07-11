# Marketplace curation — operator features design

Date: 2026-07-11

## Context

The public marketplace is a single tenant ("Фермерски пазари", `multiFarmer=true`) rendered by
the `farmflow-marketplace-next` app, which reads `/public/{slug}/bootstrap` from the FarmFlow API.
Its `farmers[]` are the producer rows inside that one tenant; `products[]` are their products.

Curation is an **operator (super-admin)** job, done in the separate `admin/` Next.js app
(PlatformAdminGuard, `server/src/modules/platform`). The per-tenant farm panel (`client/`) is for
farmers who want their own site (Tier-3) and is explicitly **out of scope** for marketplace curation.

Four features, all additive:

1. Operator marks products as "Хит".
2. Operator picks "Фермер на седмицата".
3. Operator assigns farmer tiers; marketplace sorts farmers by tier (tier 3 top, tier 1 bottom).
4. "Ново" section shows genuinely new items (new products **and** new farmers).

## Existing hooks (from investigation)

- `products.featured` (bool, exists) already flows to the storefront via `buildPublicProduct`; today it
  drives the "★ Популярен" tag. The auto "Хит" badge today comes from `bestSellerIds` (merchandising).
- `farmers` has **no `tier`**; tiering only lives in `branding.plan:'tier2'`. Farmers are ordered by
  `position` only, never by tier. `branding` jsonb: `{ enabled, plan?, accent?, headingFont?, gallery?, badges?, unlockedAt?, unlockedBy? }`.
- Featured-farmer today is a **bio heuristic** in `page.tsx` (no explicit pick). Precedent for a pointer:
  tenant `productOfWeek*` columns + untyped `tenants.settings` jsonb (keys: merchandising, landing, …).
- "Ново тази седмица" section exists but is **fake** — filled by `catalog.ts featured()` (starred-first),
  not by recency. `createdAt` on products and farmers already reaches the storefront.
- Public farmer projection (`farmers.service.ts findPublicBySlug`): `id, name, role, bio, phone, email,
  since, city, tint, imageUrl, coverCrop, branding, position, createdAt`, ordered `asc(position), asc(createdAt)`.
- Platform routes live in `server/src/modules/platform/platform.controller.ts` (PlatformAdminGuard).
  No product-featured / farmer-tier / farmer-of-week routes exist yet.

## Decisions

- **Хит = reuse `products.featured`.** No new column. Relabel the storefront badge from "★ Популярен"
  to "Хит". Featured already sorts first and fills the section. Keep the data-driven `bestSellerIds`
  path intact for other tenants; on the marketplace tenant `featured` is the operator signal and, when
  both apply to a card, `featured` wins the badge.
- **Tiers = 3-tier auto-linked ladder.** New `farmers.tier smallint NOT NULL DEFAULT 1`:
  `1 = базов листинг`, `2 = Бранд идентичност`, `3 = собствен сайт`. On farmer update, tier auto-bumps
  to `max(tier, 2)` when `branding.enabled` is on; the operator can still override up or down explicitly.
- **Фермер на седмицата = explicit pointer** in `tenants.settings.farmerOfWeek = { farmerId, note? }`
  (jsonb, additive, no migration). Storefront reads it first, bio heuristic as fallback.
- **"Ново" = recency window of 14 days**, products and new farmers combined, newest-first; fallback to
  newest-8 when the window is empty. Small "Ново" badge on product cards created within the window.

## Feature 1 — Product "Хит"

- **Data:** `products.featured` (existing). No migration.
- **Backend:** `PATCH /platform/products/:id` accepting `{ featured: boolean }`, PlatformAdminGuard.
  Updates the row, busts `products:${tenantId}` + bootstrap Redis keys.
- **Admin UI:** producer-detail (`admin/src/components/producer-detail.tsx`) product list → per-product
  "Хит" toggle wired to the new route.
- **Storefront:** `product-card.tsx` — the left tag renders "Хит" when `p.featured` (was "★ Популярен").
  Ordering unchanged (`catalog.ts featured()` already puts starred first).

## Feature 2 — Фермер на седмицата

- **Data:** `tenants.settings.farmerOfWeek = { farmerId: string, note?: string }`. Additive jsonb, no migration.
- **Backend:** `PATCH /platform/tenants/:id/farmer-of-week` `{ farmerId, note? }` (or `null` to clear),
  PlatformAdminGuard, merges into `settings`. `/bootstrap` output adds `farmerOfWeek: { id, note } | null`
  (validated: the farmerId must belong to the tenant, else emit null).
- **Admin UI:** producers page (`admin/src/components/producers-client.tsx`) → "Фермер на седмицата"
  picker: a select of the tenant's producers + optional note, saved via the new route.
- **Storefront:** `page.tsx` featured-farmer resolves the explicit `farmerOfWeek.id` first; falls back to
  the current bio heuristic when unset or invalid. `note` overrides the quoted bio when present.

## Feature 3 — Farmer tiers

- **Data:** migration `farmers.tier smallint NOT NULL DEFAULT 1`
  (`ADD COLUMN IF NOT EXISTS`, additive). Drizzle schema: `tier: smallint('tier').notNull().default(1)`.
- **Backend:**
  - `findPublicBySlug` + bootstrap farmer projection add `tier`; ordering becomes
    `desc(farmers.tier), asc(farmers.position), asc(farmers.createdAt)`.
  - Platform farmer update route accepts `tier` (extend the existing farmer PATCH in the platform module,
    or add `PATCH /platform/farmers/:id`). On any farmer update, apply auto-link:
    `tier = max(incomingTier ?? currentTier, branding.enabled ? 2 : 1)` unless the operator explicitly
    set a tier in the same request (explicit value wins, including a deliberate downgrade).
  - `@fermeribg/types`: `Farmer`/`PublicFarmer` inherit `tier` via InferSelectModel.
- **Admin UI:** producers list/detail → tier selector (1/2/3 with the ladder labels).
- **Storefront:** `types.ts Farmer` gains `tier: number`. Farmers sorted `tier desc → position asc`
  wherever listed (homepage FARMERS rail, `farmers/page.tsx`). Higher tiers get a subtle accent
  (e.g. tier-3 ring / tier badge); tier 1 renders as today.

## Feature 4 — "Ново" section

- **Data:** `createdAt` on products and farmers (both already exposed). No backend change.
- **Storefront:**
  - New helper in `catalog.ts`: `recent(items, days=14, min=8)` → items with `createdAt` within `days`,
    newest-first; if fewer than `min` match, top up with newest overall.
  - "Ново тази седмица" section renders recent **products**; when a producer's `createdAt` is within the
    window, surface a "Нов фермер" chip/card in the same section (or a small "нови фермери" row).
  - `product-card.tsx`: show a small "Ново" badge when the product's `createdAt` is within the window.

## Blast radius

- 1 migration: `farmers.tier` (additive, `IF NOT EXISTS`).
- 3 platform routes: product-featured, farmer-tier (or extended farmer PATCH), farmer-of-week.
- `admin/`: producer-detail product toggle, producers-page farmer-of-week picker + tier selector.
- `farmflow-marketplace-next`: farmer sort by tier, badge relabel + "Ново" badge, real "Ново" section,
  explicit farmer-of-week resolution, `tier` on the Farmer type.
- Backend projection/order + bootstrap `farmerOfWeek` + `tier` passthrough.

Expand-before-deploy: add `farmers.tier` to prod DB (`ADD COLUMN IF NOT EXISTS`) before shipping code
that reads it, matching the 0086/0087 pattern. Push to main auto-deploys FarmFlow; marketplace is a
manual wrangler deploy.

## Out of scope

- No changes to the `client/` farm panel (Tier-3 own-site config).
- No billing/enforcement of tiers (tier is presentational ranking, like branding is dormant-paid today).
- No auto best-seller changes; `bestSellerIds` path stays as-is.
