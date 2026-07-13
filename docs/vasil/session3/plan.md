# Session 3 — Implementation Plan (Opus)

Execution waves. Wave 1 (foundation) is serial and blocks everything. Wave 2 (server, disjoint
files) runs in parallel. Wave 3 (client/admin UI) runs after the endpoints exist.

Absolute repo root: `C:/Users/Lenovo/source/repos/FarmFlow/.claude/worktrees/agent-a783c2e80f9f13324`

---

## WAVE 1 — Foundation (schema, migrations, types) — SERIAL, one agent

### Step 1.1 — Migrations (handwritten)

Create three files under `packages/db/drizzle/`:

**`0100_bundle_products.sql`**
```sql
-- Ready-made packages / „Фермерска кошница": a bundle product (products.category='bundle')
-- gets real, add/removable child product references (not just the free-text bundle_items
-- lines). Each row links a bundle to a member product with a quantity. Logistics-ready
-- (queryable membership). ON DELETE CASCADE both ways: dropping a bundle or a member removes
-- its links. Unique (bundle_id, product_id) so a member appears once per bundle.
CREATE TABLE IF NOT EXISTS "product_bundle_items" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "tenant_id" uuid REFERENCES "tenants"("id"),
  "bundle_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "quantity" integer NOT NULL DEFAULT 1,
  "position" integer NOT NULL DEFAULT 0,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "product_bundle_items_bundle_idx" ON "product_bundle_items" ("bundle_id","position","id");
CREATE UNIQUE INDEX IF NOT EXISTS "product_bundle_items_bundle_product_unique" ON "product_bundle_items" ("bundle_id","product_id");
CREATE INDEX IF NOT EXISTS "product_bundle_items_product_idx" ON "product_bundle_items" ("product_id");
```

**`0101_product_requires_companion.sql`**
```sql
-- Companion rule: a product flagged requires_companion can't be ordered alone — the cart must
-- also hold at least one OTHER distinct product („само кайсии не ми се разнасят"). Configurable
-- per product, not hardcoded. Enforced in OrdersService.reserveCartItems for every delivery
-- method, plus a storefront pre-check. Default false = today's behavior.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "requires_companion" boolean NOT NULL DEFAULT false;
```

**`0102_farmer_geo.sql`**
```sql
-- Producer map (logistics): cached geocoded coordinates per producer, resolved from
-- legal.address / city via MapsService (Google, 30-day Redis cache) and persisted so the map
-- endpoint and future route planning read them without re-geocoding. NULL = not yet resolved;
-- geocoded_at is the refresh/audit stamp.
ALTER TABLE "farmers" ADD COLUMN IF NOT EXISTS "lat" numeric(10, 7);
ALTER TABLE "farmers" ADD COLUMN IF NOT EXISTS "lng" numeric(10, 7);
ALTER TABLE "farmers" ADD COLUMN IF NOT EXISTS "geocoded_at" timestamp with time zone;
```

### Step 1.2 — Journal entries

Append to `packages/db/drizzle/meta/_journal.json` `entries` array (after idx 92). Keep idx
CONTIGUOUS (93,94,95) — a gap silently breaks the migrator. `when` increments from the last
(1783886406000):
```json
{ "idx": 93, "version": "7", "when": 1783886407000, "tag": "0100_bundle_products", "breakpoints": true },
{ "idx": 94, "version": "7", "when": 1783886408000, "tag": "0101_product_requires_companion", "breakpoints": true },
{ "idx": 95, "version": "7", "when": 1783886409000, "tag": "0102_farmer_geo", "breakpoints": true }
```
(No per-migration meta snapshot needed — this repo skips them for handwritten migrations, cf.
0081–0092.)

### Step 1.3 — schema.ts (`packages/db/src/schema.ts`)

- **products** (in the pgTable object, near `courierDisabled`/`needsReview` ~line 200): add
  ```ts
  // Companion rule: true = can't be ordered alone; the cart must also hold ≥1 other distinct
  // product. Enforced in OrdersService + a storefront pre-check. (migr 0101)
  requiresCompanion: boolean('requires_companion').notNull().default(false),
  ```
- **farmers** (near `position`/`createdAt` ~line 1052): add
  ```ts
  // Producer-map coordinates (logistics), geocoded from legal.address/city and cached.
  // NULL = unresolved. (migr 0102)
  lat: numeric('lat', { precision: 10, scale: 7 }),
  lng: numeric('lng', { precision: 10, scale: 7 }),
  geocodedAt: timestamp('geocoded_at', { withTimezone: true }),
  ```
  (`numeric` and `timestamp` are already imported — tenants use them.)
- **new table** after `productVariants` (or near products): 
  ```ts
  // Real product membership for bundle products (products.category='bundle'). See 0100.
  export const productBundleItems = pgTable('product_bundle_items', {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    bundleId: uuid('bundle_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull().default(1),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow(),
  }, (t) => ({
    bundleIdx: index('product_bundle_items_bundle_idx').on(t.bundleId, t.position, t.id),
    bundleProductUnique: uniqueIndex('product_bundle_items_bundle_product_unique').on(t.bundleId, t.productId),
    productIdx: index('product_bundle_items_product_idx').on(t.productId),
  }));
  ```

### Step 1.4 — types (`packages/types/src/index.ts`)

- `export type ProductBundleItem = InferSelectModel<typeof productBundleItems>;`
  `export type NewProductBundleItem = InferInsertModel<typeof productBundleItems>;`
  (import `productBundleItems` from the schema barrel used by the other types.)
- Public bundle member shape + extend `PublicProduct`:
  ```ts
  export type PublicBundleItem = {
    productId: string;
    name: string;
    slug: string | null;
    image: string | null;
    quantity: number;
    priceStotinki: number;
  };
  ```
  In `PublicProduct` add:
  ```ts
  // True when the product can go on a courier waybill (Econt/Speedy) = !courierDisabled.
  // Positive alias for clear storefront display. (task #11)
  courierShippable: boolean;
  // Resolved member products for category='bundle' products; absent/empty otherwise. (task #1)
  bundleProducts?: PublicBundleItem[];
  ```
  (`requiresCompanion` flows automatically via `Omit<Product,...>` — Product now has it.)

### Step 1.5 — VERIFY WAVE 1
`pnpm --filter @fermeribg/db build && pnpm --filter @fermeribg/types build` compile clean.
(If pnpm store issues arise in the worktree, `pnpm -w --filter … build`. Report but do not
push.)

---

## WAVE 2 — Server (parallel; disjoint files) — depends on Wave 1

### Group B — Products domain + bundles

Files: `server/src/modules/products/dto/*`, `products.service.ts`, `products.controller.ts`,
`products.module.ts`, new spec.

1. **DTO** `create-product.dto.ts` + (`update` extends it via PartialType): add
   ```ts
   @ApiPropertyOptional({ description: 'Requires ≥1 other product in the cart (не се доставя самостоятелно)' })
   @IsOptional()
   @IsBoolean()
   requiresCompanion?: boolean;
   ```
2. **Bundle DTO** new file `dto/bundle-items.dto.ts`:
   ```ts
   export class BundleItemDto {
     @IsUUID() productId: string;
     @IsOptional() @IsInt() @Min(1) @Max(999) quantity?: number; // default 1
   }
   export class SetBundleItemsDto {
     @IsArray() @ValidateNested({ each: true }) @ArrayMaxSize(50) @Type(() => BundleItemDto)
     items: BundleItemDto[];
   }
   ```
3. **products.service.ts**:
   - `buildPublicProduct(...)`: add `courierShippable: !p.courierDisabled` to the returned
     object (both the base object and after `...rest`; it's a computed field). Type now requires
     it.
   - `setBundleItems(bundleId, tenantId, items, farmerScope)`: assert bundle belongs to tenant
     (+ farmerScope if producer) and `category==='bundle'` (else BadRequest „Само пакет може да
     съдържа продукти"); assert every `productId` is in-tenant, active, not the bundle itself,
     not itself a bundle; full-replace membership (delete rows not in `items`, upsert the rest
     with position = index) — mirror `syncVariants`. Invalidate cache. Return the new list.
   - `listBundleItems(bundleId, tenantId, farmerScope)`: join `product_bundle_items` → products,
     return member summaries ordered by position.
   - `findPublicBySlug(...)`: after building the public products array, for any product with
     `category==='bundle'`, load its `product_bundle_items` (one query filtered by the tenant's
     bundle ids) and attach `bundleProducts[]` mapped from the ALREADY-built public products
     (in-memory lookup by id → name/slug/images[0]/priceStotinki + quantity). Do not add an
     N+1. If a member product is inactive/absent from the public list, skip it.
4. **products.controller.ts**: 
   ```
   GET  /products/:id/bundle-items  → listBundleItems  (same guards/scoping as GET /products/:id)
   PUT  /products/:id/bundle-items  → setBundleItems   (same guards/scoping as PATCH /products/:id; farmerScope from CurrentFarmer)
   ```
   Follow the existing scoping (admin vs producer sub-account) used by `update`/`findOne`.
5. **Spec** `products.bundle-items.spec.ts`: full-replace add/remove, rejects non-bundle target,
   rejects cross-tenant/self member, public payload carries `courierShippable` + `bundleProducts`.

### Group C — Companion rule enforcement

Files: `server/src/modules/orders/orders.service.ts`, new spec.

In `reserveCartItems`, AFTER the loop that validates products (~line 1795) and OUTSIDE the
`if (carrierDelivery)` courier block (applies to all delivery methods), add:
```ts
// Companion rule: a product flagged `requiresCompanion` can't be ordered alone — the cart
// must also hold ≥1 other distinct product („само кайсии не ми се разнасят"). Runs for every
// delivery method (pickup/local/courier). byId already holds the full product rows.
const distinctIds = new Set(dtoItems.map((it) => it.productId));
const lonely = dtoItems
  .map((it) => byId.get(it.productId))
  .filter((p): p is NonNullable<typeof p> => !!p && p.requiresCompanion);
if (lonely.length && distinctIds.size < 2) {
  const names = [...new Set(lonely.map((p) => p.name))].join(', ');
  throw new BadRequestException(
    `Тези продукти не се доставят самостоятелно — добавете поне още един продукт по избор: ${names}`,
  );
}
```
Spec `orders.companion.spec.ts` (mirror `orders.pickup-only.spec.ts`): apricots-only →
BadRequest; apricots + another product → passes the check; two distinct requires-companion
products → passes (each is the other's companion).

### Group D — Producers map backend

Files: `server/src/common/maps/maps.service.ts` (+ spec), `platform.service.ts`,
`platform.controller.ts`, platform types.

1. **maps.service.ts** `geocodeApprox(address, bias?)`: forward geocode that ACCEPTS
   locality-level results (unlike `geocode`, which drops coarse matches). Model on
   `reverseGeocode`: hit `GEOCODE_URL?address=…&region=bg&language=bg&key=…`, take
   `results[0].geometry.location`, cache `LatLng` for `GEOCODE_CACHE_TTL`, key
   `maps:geocodeapprox:<sha1>`. Return null when `!enabled`/no match/error. (Reuse
   `this.fetchJson`, `this.cachedGet/Set`, `this.enabled`, `this.apiKey`.)
2. **platform.service.ts** `producersMap()`:
   - Select cross-tenant farmers: id, name, city, legal, lat, lng, geocodedAt, tint, imageUrl,
     tier, tenantName, tenantSlug (+ product count like listAllFarmers, optional).
   - For rows with null lat/lng AND a usable location string (`legal.address` || `city`),
     geocode via `MapsService.geocodeApprox` with bounded concurrency (~5) and persist
     `lat/lng/geocoded_at` (skip when maps disabled / geocode returns null — leave null).
   - Return `{ producers: ProducerMapPoint[] }` where a point has
     `{ id, name, tenantName, tenantSlug, city, tier, lat, lng, imageUrl, productCount }`;
     include producers with null coords too (the page lists them as „без локация").
   - Inject `MapsService` (it is `@Global`).
3. **platform.controller.ts**: `@Get('producers/map')` (PlatformAdminGuard, like the other
   platform routes) → `this.platform.producersMap()`. Optional `@Query('refresh')` to force
   re-geocode (skip if it complicates — geocode-on-read is enough).
4. **types**: `ProducerMapPoint` in the platform DTO/types file used by the controller responses.
5. **Spec** `platform.producers-map.spec.ts`: producers returned; a producer missing coords with
   a city gets geocoded + persisted (mock MapsService); maps-disabled path leaves coords null and
   does not throw.

### Step 2.V — VERIFY WAVE 2
`pnpm --filter @fermeribg/api build` clean; run the three new specs
(`pnpm --filter @fermeribg/api test -- products.bundle-items orders.companion platform.producers-map`).

---

## WAVE 3 — Client/admin UI (parallel; disjoint apps) — depends on Wave 2 endpoints

### Group E — Farmer panel (`client/`)

1. **product-dialog.tsx** (`client/src/components/products/product-dialog.tsx`):
   - Add a "Изисква втори продукт" toggle bound to `requiresCompanion` (mirror the existing
     `courierEnabled` toggle wiring; send `requiresCompanion` in the product write payload).
     Helper text: „Не се доставя самостоятелно — клиентът трябва да добави поне още един продукт."
   - Courier clarity (task #11): the dialog already has the `courierEnabled` toggle; add a small
     status line making shippability explicit: when courier disabled → „🚫 Само вземане/местна
     доставка (не се праща по куриер)"; else → „📦 Може по Еконт/куриер".
   - `ProductWrite` type + `api-client.ts` write payload include `requiresCompanion`.
2. **Bundle management** (task #1): for a product with `category==='bundle'`, add a member
   editor (a section in the dialog or a dedicated „Съдържание на пакета" panel) — a product
   picker (reuse the existing product options list / `listOptions`) to add members, remove
   buttons, quantity, using `GET/PUT /products/:id/bundle-items`. Add `api-client.ts` funcs
   `getBundleItems(id)` / `setBundleItems(id, items)`.
   - If wiring a full picker into the dialog is heavy, ship a minimal but functional
     add-by-select + list-with-remove; note any deferral in the report.

### Group F — Super-admin producers map page (`admin/`)

1. **api-client.ts** (`admin/src/lib/api-client.ts`): `getProducersMap()` →
   `apiFetch('platform/producers/map')` (SSR variant fetches `${API_BASE}/platform/producers/map`
   with the session cookie, mirroring `producers/page.tsx`).
2. **Page** `admin/src/app/(panel)/producers-map/page.tsx`: SSR fetch (like `producers/page.tsx`)
   → client component `producers-map-client.tsx`.
3. **`producers-map-client.tsx`**: render a Google Map with a marker per producer.
   - NO new npm dependency. Load the Maps JS API via a dynamic `<script>` loader
     (`https://maps.googleapis.com/maps/api/js?key=${NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}&language=bg&region=BG`),
     create the map + markers imperatively in a `useEffect`. Center on Bulgaria
     (~42.7,25.5, zoom 7). Marker click → info window with name/tenant/city/tier.
   - Graceful fallback: if `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` is missing OR a producer has null
     coords, render a table (name / tenant / city / tier) so the page always works. Show a
     „N производителя без локация" note.
4. **Nav** `admin/src/components/panel-sidebar.tsx`: add to the group containing `/producers`
   an entry `{ href: '/producers-map', label: 'Карта на производители', Icon: MapPin }`
   (import `MapPin` from `lucide-react`).

### Step 3.V — VERIFY WAVE 3
`pnpm --filter @fermeribg/web build` and `pnpm --filter @fermeribg/admin build` compile clean
(Next build / typecheck). Note: builds may need workspace deps built first.

---

## WAVE 4 — Docs (orchestrator writes)
`docs/vasil/session3/chaika-changes.md`: precise storefront diffs for #1 (bundle section),
#2 (companion checkout block), #11 (per-product badge + Varna/Dobrich zone + red highlight),
consuming the new public fields (`courierShippable`, `bundleProducts`, `requiresCompanion`).

## Edge cases / risks
- Journal idx MUST stay contiguous (93/94/95). Double-check no gap after 92.
- `buildPublicProduct` now returns a required `courierShippable` — update the type first (Wave 1)
  so `@fermeribg/api` compiles.
- Bundle members are products in the same tenant; guard against a bundle referencing itself or
  another bundle (infinite/rendering loops).
- Companion check must NOT count multiple units of the SAME product as a companion (use distinct
  product ids).
- `geocodeApprox` must never throw into the request path (graceful null, like the other maps
  methods) — a maps outage must not break the producers-map endpoint.
- Do not add npm deps to `admin/` (keep the worktree build green) — use the script loader.
