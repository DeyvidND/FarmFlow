# Catalog reordering + Product of the Week — Design

**Date:** 2026-06-09
**Branch:** `feat/cod-payment-method` (current working branch)
**Status:** Approved design, ready for implementation plan

## Goal

Let a farmer control two things from the admin panel:

1. **Ordering** of products, farmers, and subcategories (categories) as they appear on the storefront — via drag-and-drop *and* up/down arrows.
2. An optional **"Продукт на седмицата" (Product of the Week, POTW)** highlight — manually picked per product, with an auto-rotate fallback for farmers who don't want to maintain it.

Both must reflect on **both** storefronts: the in-repo Next.js storefront (`storefront/`) and the separate Chaika Astro storefront (`fermerski-pazar-chaika/`, a sibling repo on disk).

## Current state (verified against code)

- **Products** (`packages/db/src/schema.ts`): no `position` column. `ProductsService.findAll` (admin), `listOptions`, and `findPublicBySlug` (public) all sort by `createdAt`. Public catalog is Redis-cached under `catalog:{tenantId}` (TTL 300s), busted on every write.
- **Farmers / subcategories**: already have a `position integer not null default 0` column plus a `(tenant_id, position, created_at)` index, and their services already sort by `asc(position), asc(createdAt)` in **both** admin and public paths. **However, no endpoint or UI exists to change those positions** — only gallery-media reorder exists (`reorderMedia`, using `ReorderMediaDto` = `{ items: [{ id, position }] }`).
- **Tenant feature flags** are boolean columns on `tenants` (e.g. `articles_enabled`, `reviews_enabled`). `tenants.settings` jsonb also exists for richer config.
- **Public bootstrap** (`public-bootstrap.controller.ts`) returns `{ storefront, products, farmers, subcategories }` by calling each service's `findPublicBySlug` in parallel.
- Both storefronts consume the public API / bootstrap bundle.

## Design

### A. Data model — one migration (`0038`)

**Products** — add `position integer not null default 0`.
- Backfill existing rows so current order is preserved: assign `position` by row-number over `createdAt` per tenant (e.g. `UPDATE ... SET position = rn - 1 FROM (SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS rn ...)`).
- Add index `products_tenant_position_idx` on `(tenant_id, position, created_at, id)`.

**Farmers / subcategories** — no schema change (column + index already exist).

**Tenants** — POTW columns (mirror the `articles_enabled` boolean-column pattern):
- `product_of_week_enabled boolean not null default false` — the optional gate.
- `product_of_week_mode text not null default 'manual'` — values `'manual' | 'auto'`.
- `product_of_week_id uuid` references `products(id)`, nullable — the manually picked product (a single column = naturally at most one).
- `product_of_week_note text`, nullable — optional blurb shown with the featured product.

Migration also regenerates the Drizzle snapshot + `_journal.json` per repo convention.

### B. Reorder model — single `position` field serves both global and per-category

A product's `position` is its **global** storefront order. The per-category storefront view sorts by the **same** field, simply filtered to that category. One field covers both requested behaviours; no second column.

- **Global reorder**: admin sends the full ordered id list; backend assigns positions `0..N-1`.
- **Per-category reorder**: admin filters to one category and reorders within it. The client reassigns only **those products' existing position slots** in the new visual order (take the set of `position` values currently held by the category's products, sort them, hand them out in the new order). Result: the category's internal order changes while the global ordering of all other products stays stable. No second column, no cross-category interference.

Backend stays dumb and generic: it receives `{ items: [{ id, position }] }` and persists exactly those, tenant-scoped, in a transaction. The client is responsible for computing sensible position values (full sequence for global, slot-preserving for per-category).

### C. Reorder API

Generalize the existing `ReorderMediaDto` into a shared `ReorderDto` (`{ items: ReorderItem[] }`, `ReorderItem = { id: string; position: number }`) under `common/dto/`, keeping `ReorderMediaDto` as an alias or re-export so media reorder is untouched.

New endpoints (all behind `JwtAuthGuard`, tenant-scoped):
- `PATCH /products/reorder` → `ProductsService.reorder(tenantId, dto)` — validate every id belongs to the tenant, UPDATE positions in one transaction, bust `catalog:{tenantId}`.
- `PATCH /farmers/reorder` → `FarmersService.reorder(...)` — same, bust the farmers public cache key.
- `PATCH /subcategories/reorder` → `SubcategoriesService.reorder(...)` — same, bust the subcategories public cache key.

Route ordering: declare `reorder` literal routes before any `:id` routes in each controller (existing convention in this codebase).

Ordering changes in `ProductsService`: `findAll`, `listOptions`, and `findPublicBySlug` switch from `orderBy(createdAt)` to `orderBy(asc(position), asc(createdAt), asc(id))`. Note `findAll` is keyset-paginated on `(createdAt, id)` — the keyset key moves to `(position, id)` so pagination stays index-served against the new index. (Farmers/subcats services already order by position — unchanged.)

### D. Reorder UI (admin `client/`)

A reusable `<ReorderableList>` component supporting **both** interaction styles:
- HTML5 drag-and-drop (`draggable`, dragover/drop handlers) for desktop — reuse the pattern already used by the gallery-media reorder if present, otherwise native HTML5 drag (no new dependency).
- Up/down arrow buttons per row as a fallback / mobile-friendly path.

Used on three pages:
- **Продукти** — a "Подреди" (reorder) mode; a category-filter dropdown lets the farmer reorder globally (no filter) or within one category. On save, the client computes positions (full sequence vs slot-preserving) and `PATCH /products/reorder`.
- **Фермери** — reorder farmer cards → `PATCH /farmers/reorder`.
- **Subcategories (категории)** — reorder category cards → `PATCH /subcategories/reorder`.

Optimistic update + `sonner` toast + rollback on error (existing admin pattern).

### E. Product of the Week

Gated by `product_of_week_enabled` (off by default — the "optional" requirement).

- **Manual mode (primary):** a star / "Продукт на седмицата" toggle button on each product card in the Продукти page sets `product_of_week_id` (toggling another product replaces it). The optional `note` and the `mode` switch live in a "Продукт на седмицата" block in **Settings**.
- **Auto mode (lazy fallback):** no manual pick. The server resolves the featured product weekly by ISO-week rotation over the tenant's active products: `index = isoWeekNumber % activeProducts.length`. Deterministic, **no cron job**, changes on its own each week. `note` is ignored (or reused) in auto mode.

**Resolution** happens server-side in the public-bootstrap path, which adds a `productOfWeek: { id: string; note: string | null } | null` field to the bundle:
- flag off → `null`.
- manual → `{ id: product_of_week_id, note }` if the product is still active, else `null`.
- auto → compute the ISO-week index against the active product list, return that product's id (+ tenant note if reused).

The storefront already holds the full products array from the bundle, so it looks the product up by id — no extra query/endpoint. Manual changes to the tenant row bust the existing tenant-profile cache; auto mode's week boundary is well within acceptable staleness for the 300s catalog cache.

`UpdateTenantDto` gains `productOfWeekEnabled`, `productOfWeekMode`, `productOfWeekId`, `productOfWeekNote`; `TenantsService` validates `productOfWeekId` belongs to the tenant (mirror `assertRefsInTenant`). The product star-toggle in the admin can reuse `PATCH /tenants/me` or a thin dedicated endpoint — design uses `PATCH /tenants/me` for consistency.

### F. Storefront rendering (both repos)

- **Reorder** flows automatically once the API orders by `position` — the work is to **verify** neither storefront re-sorts the products/farmers/categories client-side (by name, price, etc.); if it does, drop that sort so API order is honoured.
- **POTW**: add a "Продукт на седмицата" highlight section on the home page of **both** storefronts, rendered only when `productOfWeek` is non-null. Build it in the Next storefront (`storefront/`) and the Chaika Astro storefront (`fermerski-pazar-chaika/`), each in its own theme/components.

### G. Types

- `@farmflow/types`: `Product` gains `position`; `Tenant` gains the four POTW fields; the public tenant/bootstrap type gains `productOfWeek`. Rebuild the types dist after editing (consumed via `dist`).
- `storefront/src/lib/api.ts` and the Chaika API client gain matching fields.

### H. Caching

- `catalog:{tenantId}` busted by `products.reorder` (and existing writes).
- Farmers / subcategories public cache keys busted by their `reorder`.
- Tenant-profile / bootstrap cache busted on `PATCH /tenants/me` (existing behaviour) — covers POTW manual changes and the enable flag.

## Testing

- `ProductsService.reorder`: tenant-scoped (cross-tenant ids rejected), positions persisted, `catalog:{tenantId}` busted.
- `FarmersService.reorder` / `SubcategoriesService.reorder`: same.
- Public ordering: products returned in `position` order; per-category slot-preserving reorder keeps global order stable.
- POTW resolution: disabled → null; manual with active product → that product; manual with inactive/cleared → null; auto → correct ISO-week rotation pick.
- Keyset pagination still works after the order key changes to `(position, id)`.

## Out of scope / non-goals

- No scheduled POTW (start/end dates) — only manual single-pick + auto-rotate.
- No reordering of gallery media (already exists) or of orders/slots.
- No drag-reorder across categories that *moves* a product between categories (category assignment stays a separate edit).

## Affected areas (orientation, not an exhaustive file list)

- `packages/db`: `schema.ts`, migration `0038` + snapshot + journal.
- `server`: products, farmers, subcategories services + controllers; `common/dto` reorder DTO; tenants DTO + service + public profile; public-bootstrap controller; a small ISO-week util.
- `@farmflow/types`: Product, Tenant, bootstrap/public types.
- `client` (admin): `ReorderableList` component; Продукти / Фермери / Subcategories pages; Settings POTW block; api-client calls.
- `storefront/` (Next): verify ordering; POTW home section; api types.
- `fermerski-pazar-chaika/` (Astro, sibling repo): verify ordering; POTW home section; api types.
