# Admin: Farmers + Subcategories + Product linking — Design

_Date: 2026-06-01 · Source: Claude Design handoff bundle `farmflow/` (farmers.jsx, subcats.jsx, data.js)_

## Goal

Add two optional, toggle-gated catalog features to the farm admin panel and reflect
them on the public storefront:

1. **Farmers** — when a single storefront is shared by several producers, manage the
   farmers and link each product to one. Gated by a tenant-level `multiFarmer` toggle.
2. **Subcategories** — group products into named, photographed sections (e.g.
   "Сезонни плодове", "Зимнина и буркани"). Gated by a tenant-level `multiSubcat`
   toggle. Coexists with the existing free-text `category` field.

Both toggles default **off**. When off, the admin page shows an explanatory empty
state and the product form omits the corresponding link field; the storefront renders
exactly as today.

## Scope (approved)

Full-stack persistence (DB + NestJS + admin client) **and** storefront integration.
Farmer avatars + subcategory section photos upload to R2 (mirroring product images).

## Data model (`packages/db/src/schema.ts` + migration)

New tables (both tenant-scoped, like `products`):

```
farmers
  id            uuid pk
  tenantId      uuid → tenants.id
  name          text not null
  role          text                  -- "Пчелар — мед"
  bio           text
  phone         text
  since         text                  -- year, e.g. "2014" (free text, matches design)
  tint          text                  -- hex accent for avatar + product tags
  imageUrl      text                  -- R2 avatar; null → tinted initials
  position      integer not null default 0
  createdAt     timestamp default now()

subcategories
  id            uuid pk
  tenantId      uuid → tenants.id
  name          text not null
  description   text
  tint          text
  imageUrl      text                  -- R2 section banner; null → tinted gradient
  position      integer not null default 0
  createdAt     timestamp default now()
```

`products` gains:
```
  farmerId        uuid → farmers.id        ON DELETE SET NULL   (nullable)
  subcategoryId   uuid → subcategories.id  ON DELETE SET NULL   (nullable)
```

`tenants` gains:
```
  multiFarmer   boolean not null default false
  multiSubcat   boolean not null default false
```

Drizzle: register `farmers`, `subcategories` in the `schema` export; add their
`InferSelectModel`/`InferInsertModel` + `Public*` types to `packages/types/src/index.ts`.
`PublicProduct` keeps `farmerId`/`subcategoryId` (they survive the existing Omit).
`PublicTenant` keeps `multiFarmer`/`multiSubcat`. Generate one migration via
`pnpm db:generate`. Seed (`packages/db/src/seed.ts`): add the 3 demo farmers + 3 demo
subcategories from `data.js`, link the demo products, leave both toggles off.

## Server (NestJS) — mirror the `products` module

### `farmers` module
- `FarmersController` (`@Controller('farmers')`, `JwtAuthGuard`, `@CurrentTenant()`):
  `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`, `POST /:id/image`.
- `FarmersService`: tenant-scoped CRUD via Drizzle; `uploadImage` reuses
  `StorageService` with key `tenants/{tenantId}/farmers/{uuid}.{ext}` and the existing
  `PRODUCT_IMAGE_*` validators; delete cleans the R2 object. Mutations call
  `catalog.invalidate(tenantId)`.
- DTOs: `CreateFarmerDto` (name required; role/bio/phone/since/tint/imageUrl/position
  optional), `UpdateFarmerDto extends PartialType`.
- **Delete = hard delete** (unlike products' soft delete) — a farmer/subcat is an
  organizational entity, not a sellable item; FK `SET NULL` unlinks its products.

### `subcategories` module
Same shape: `@Controller('subcategories')`, CRUD + `POST /:id/image`
(`tenants/{tenantId}/subcategories/{uuid}.{ext}`). DTOs `CreateSubcategoryDto`
(name required), `UpdateSubcategoryDto`.

### products
- `CreateProductDto`: add optional `farmerId?` `@IsUUID` and `subcategoryId?` `@IsUUID`
  (both `@IsOptional`; allow null to unlink). `UpdateProductDto` inherits.
- Service unchanged (spreads dto).

### tenants
- `UpdateTenantDto`: add optional `multiFarmer?` / `multiSubcat?` `@IsBoolean`.
- `getMe` already returns them (full row minus stripe/settings).

### public endpoints (storefront, no auth, Redis-cached like catalog)
- `GET /public/:slug/subcategories` → `PublicSubcategory[]`, **`[]` when the tenant's
  `multiSubcat` is off** (service guards on the flag). Ordered by `position`.
- `GET /public/:slug/farmers` → `PublicFarmer[]`, **`[]` when `multiFarmer` is off**.
- Returning `[]` when the toggle is off lets the storefront treat "empty" as "feature
  off" without a separate flags fetch.

Register `FarmersModule`, `SubcategoriesModule` in `app.module.ts` (import
`CatalogCacheModule` + `StorageModule` like `ProductsModule`).

## Admin client (`client/`)

Reuses existing primitives: `Button`, `ToggleSwitch`, sonner `toast`, the
`force-dynamic` SSR page → client-component pattern, and the `bff` proxy.

- **Sidebar nav** (`components/layout/sidebar.tsx`): add `Фермери` (Users icon,
  `/farmers`) and `Подкатегории` (Tags icon, `/subcategories`) after Продукти, matching
  the design's NAV order. Topbar title map (if any) updated.
- **`/farmers`** (`app/(admin)/farmers/page.tsx` SSR → `FarmersClient`):
  - Toggle banner (`multiFarmer`): PATCH `tenants/me`; toast.
  - Off → centered empty-state card ("Един производител").
  - On → header (count + "Добави фермер") + responsive card grid. Each card: avatar
    (initials on tint, or imageUrl), name, role, "от {since} г. · {phone}", bio, a
    "Свързани продукти" footer listing linked product chips (computed from the products
    list) + a "Управлявай продукти" link to `/products`, and an edit button.
  - `FarmerPanel` slide-out (port of design): preview, name/role/bio/phone/since
    inputs, tint swatches, photo upload (`uploadFarmerImage`), save → POST/PATCH.
- **`/subcategories`** (`app/(admin)/subcategories/page.tsx` → `SubcategoriesClient`):
  mirror of farmers. Card uses a `SectionPhoto` banner (imageUrl or tinted gradient),
  name, description, linked-product chips. `SubcategoryPanel` slide-out: section photo
  upload, title, description, tint.
- **Product create/edit** (`create-product-dialog.tsx` + edit path in
  `products-client.tsx`):
  - Fetch farmers + subcategories + tenant flags for the page (pass from SSR).
  - Show a **farmer `<select>`** only when `multiFarmer`; a **subcategory `<select>`**
    only when `multiSubcat`. Wire `farmerId`/`subcategoryId` into create/update calls.
  - **Note:** the current edit flow on `ProductCard` only edits price/stock inline. To
    edit a product's farmer/subcategory link we add those selects to the create dialog
    and to the inline editor (or extend the dialog to double as an edit dialog). The
    plan picks the smaller change: extend the create dialog to an edit-capable
    "ProductDialog" used for both, since linking needs the full form.
- **api-client.ts**: add `listFarmers/createFarmer/updateFarmer/deleteFarmer/uploadFarmerImage`,
  the subcategory equivalents, and extend `setTenant`/add `updateTenant({multiFarmer,
  multiSubcat})`. **types.ts**: add `Farmer`, `Subcategory`; extend `Product` with
  `farmerId`/`subcategoryId`; add tenant flags type.

## Storefront (`storefront/`)

- **lib/api.ts**: `PublicFarmer` + `PublicSubcategory` types; `getFarmers(slug)` and
  `getSubcategories(slug)` (revalidate 300). `PublicProduct` already carries the ids.
- **/products page**: fetch products + subcategories (+ farmers). If subcategories
  non-empty → render **grouped sections** (each: `SectionPhoto`/image banner + title +
  description, then that subcat's product grid); products with no `subcategoryId` fall
  into a trailing "Други" section. Else → existing `CatalogClient` (flat + category
  chips), unchanged.
- **product card / product page**: when farmers non-empty, look up the product's
  `farmerId` and show a small "Произведено от {name}" line (avatar dot + name). No-op
  when the list is empty (toggle off).
- Storefront reads the toggle implicitly: empty endpoint response = feature off.

## Testing / verification

- `pnpm --filter @farmflow/db generate` produces exactly one migration; `db:migrate`
  applies cleanly; `db:seed` runs.
- Server: `pnpm --filter @farmflow/server build` (or lint) passes; manual curl of the
  new admin + public routes (auth + slug).
- Admin: `next build` for `@farmflow/web`; preview the two pages with the toggle on/off,
  create/edit a farmer + subcategory, link a product, confirm chips update.
- Storefront: `next build`; preview /products with subcategories on (sections) and off
  (flat), and a product card showing farmer attribution when multiFarmer on.

## Out of scope / decisions

- Existing product `category` free-text stays; `subcategory` is the separate rich entity.
- Toggles live on the tenant row, default off.
- Farmer/subcat **hard delete** (FK SET NULL unlinks products) vs product soft delete.
- No reordering UI for `position` in v1 (column laid down; order = createdAt/position).
- No per-farmer storefront filter page in v1 (attribution only).
