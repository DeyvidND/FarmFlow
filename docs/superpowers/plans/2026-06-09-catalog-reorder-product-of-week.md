# Catalog Reordering + Product of the Week — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a farmer reorder products / farmers / categories (drag + arrows) and optionally feature a "Продукт на седмицата" (manual pick or weekly auto-rotate), reflected on both storefronts.

**Architecture:** Single `position` column per catalog entity drives storefront order (global list + per-category, slot-preserving). Three tenant-scoped `PATCH .../reorder` endpoints persist positions and bust caches. POTW is four `tenants` columns; the featured product is resolved server-side in the public-bootstrap path (manual id or ISO-week rotation) and rendered as a home highlight in both storefronts.

**Tech Stack:** NestJS + Drizzle (Postgres) backend; `@farmflow/db` / `@farmflow/types` packages; Next.js admin (`client/`) + Next storefront (`storefront/`); Astro storefront (`fermerski-pazar-chaika/`, sibling repo). Jest for backend tests.

**Spec:** `docs/superpowers/specs/2026-06-09-catalog-reorder-product-of-week-design.md`

---

## File Structure

**packages/db**
- `src/schema.ts` — products `+position` + index; tenants `+4 POTW columns`.
- `drizzle/0038_*.sql` + `meta/0038_snapshot.json` + `meta/_journal.json` — migration (generated, then backfill SQL appended).

**packages/types**
- inferred `Product` gains `position`; `Tenant` gains POTW fields; `PublicProduct` gains `position`; bootstrap response type gains `productOfWeek`.

**server**
- `src/common/dto/reorder.dto.ts` — NEW generic `ReorderDto` (move/rename from `reorder-media.dto.ts`, keep alias).
- `src/common/util/iso-week.ts` — NEW `isoWeekNumber(date)`.
- `src/modules/products/products.service.ts` + `.controller.ts` — `reorder()`, order-by-position, POTW-safe.
- `src/modules/farmers/farmers.service.ts` + `.controller.ts` — `reorder()`.
- `src/modules/subcategories/subcategories.service.ts` + `.controller.ts` — `reorder()`.
- `src/modules/tenants/dto/update-tenant.dto.ts` + `tenants.service.ts` — POTW fields + validation.
- `src/modules/public-bootstrap/public-bootstrap.controller.ts` — resolve `productOfWeek`.
- spec files alongside each service.

**client (admin)**
- `src/components/reorderable-list.tsx` — NEW reusable (drag + arrows).
- products / farmers / subcategories pages + product-card — reorder mode + POTW star.
- settings page — POTW block.
- `src/lib/api-client.ts` — reorder + POTW calls.

**storefront (Next)** — verify ordering; POTW home section; `src/lib/api.ts` types.

**fermerski-pazar-chaika (Astro)** — verify ordering; POTW home section; API types.

---

## PHASE 1 — DB + types

### Task 1: products `position` column + index, tenants POTW columns

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0038_*.sql`, `packages/db/drizzle/meta/0038_snapshot.json`
- Modify: `packages/db/drizzle/meta/_journal.json`

- [ ] **Step 1: Edit `schema.ts` — products table.** In the `products` pgTable column block add (mirror farmers): `position: integer('position').notNull().default(0),`. In its index callback add:
```ts
tenantPositionIdx: index('products_tenant_position_idx').on(
  t.tenantId,
  t.position,
  t.createdAt,
  t.id,
),
```

- [ ] **Step 2: Edit `schema.ts` — tenants table.** After `reviewsEnabled` add:
```ts
// Optional "Продукт на седмицата" storefront highlight. enabled = the gate;
// mode 'manual' uses productOfWeekId (a single featured product), mode 'auto'
// resolves a weekly ISO-week rotation server-side (no cron). note = optional blurb.
productOfWeekEnabled: boolean('product_of_week_enabled').notNull().default(false),
productOfWeekMode: text('product_of_week_mode').notNull().default('manual'),
productOfWeekId: uuid('product_of_week_id').references(() => products.id),
productOfWeekNote: text('product_of_week_note'),
```
(Place the FK after `products` is declared — `tenants` is declared before `products` in this file, so reference via the thunk `() => products.id` which is lazy and fine.)

- [ ] **Step 3: Generate migration.** Run: `ctx-wire run pnpm --filter @farmflow/db generate`. Expected: new `0038_*.sql` + `meta/0038_snapshot.json` + journal entry. Confirm SQL contains `ALTER TABLE "products" ADD COLUMN "position"`, the new index, and four `ALTER TABLE "tenants" ADD COLUMN "product_of_week_*"`.

- [ ] **Step 4: Append position backfill to the generated SQL.** Add at the end of `0038_*.sql` (after a `--> statement-breakpoint`):
```sql
--> statement-breakpoint
UPDATE "products" p SET "position" = s.rn - 1
FROM (
  SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS rn
  FROM "products"
) s
WHERE p.id = s.id;
```

- [ ] **Step 5: Apply migration.** Run: `ctx-wire run pnpm --filter @farmflow/db migrate`. Expected: success, no errors. Verify: `docker exec <pg> psql -t -A -c "SELECT column_name FROM information_schema.columns WHERE table_name='tenants' AND column_name LIKE 'product_of_week%';"` returns 4 rows; `... WHERE table_name='products' AND column_name='position';` returns 1.

- [ ] **Step 6: Build types/db dist.** Run: `ctx-wire run pnpm -r build`. Expected: clean. `Product` now has `position`, `Tenant` has the 4 POTW fields (inferred).

- [ ] **Step 7: Commit.**
```bash
git add packages/db/src/schema.ts packages/db/drizzle/0038_* packages/db/drizzle/meta/0038_snapshot.json packages/db/drizzle/meta/_journal.json
git commit -m "feat(db): products.position + tenant product-of-week columns (0038)"
```

---

## PHASE 2 — Reorder backend

### Task 2: Generic `ReorderDto`

**Files:**
- Create: `server/src/common/dto/reorder.dto.ts`
- Modify: `server/src/common/dto/reorder-media.dto.ts` (re-export alias)

- [ ] **Step 1: Create `reorder.dto.ts`** with `ReorderItemDto` (`id: @IsUUID`, `position: @IsInt @Min(0)`) and `ReorderDto` (`items: ReorderItemDto[]`, `@IsArray @ValidateNested({each:true}) @Type(() => ReorderItemDto)`). Copy the exact class-validator decorators from the current `reorder-media.dto.ts`.

- [ ] **Step 2: Make `reorder-media.dto.ts` re-export** so media controllers are untouched:
```ts
export { ReorderItemDto as ReorderMediaItemDto, ReorderDto as ReorderMediaDto } from './reorder.dto';
```

- [ ] **Step 3: Build.** Run: `ctx-wire run pnpm --filter @farmflow/api build`. Expected: clean (media reorder endpoints still compile against the alias).

- [ ] **Step 4: Commit.** `git commit -am "refactor(api): generic ReorderDto, ReorderMediaDto alias"`

### Task 3: `ProductsService.reorder` + order-by-position (TDD)

**Files:**
- Modify: `server/src/modules/products/products.service.ts`
- Modify: `server/src/modules/products/products.controller.ts`
- Test: `server/src/modules/products/products.service.spec.ts` (or a new `products.reorder.spec.ts` if no existing spec)

- [ ] **Step 1: Write failing test** — reorder persists positions, is tenant-scoped, busts cache. Mock `db` (transaction + update chain), `cache.invalidate`. Assert: cross-tenant id not updated (where includes `tenantId`); `cache.invalidate(tenantId)` called. Pattern: mirror existing service-spec mocking in this repo (check `econt.service.spec.ts` / `stripe.service.spec.ts` for the mock style).

- [ ] **Step 2: Run, verify FAIL** (`reorder` undefined). Run: `ctx-wire run pnpm --filter @farmflow/api test -- products`

- [ ] **Step 3: Implement `reorder`** in `products.service.ts`:
```ts
/** Persist a new catalog order. Each item's position is set tenant-scoped in one
 *  transaction; the public catalog cache is busted. Used for both global and
 *  per-category reordering (the client computes the position values). */
async reorder(tenantId: string, dto: ReorderDto): Promise<{ ok: true }> {
  await this.db.transaction(async (tx) => {
    for (const it of dto.items) {
      await tx
        .update(products)
        .set({ position: it.position })
        .where(and(eq(products.id, it.id), eq(products.tenantId, tenantId)));
    }
  });
  await this.cache.invalidate(tenantId);
  return { ok: true };
}
```
Add `import { ReorderDto } from '../../common/dto/reorder.dto';`.

- [ ] **Step 4: Switch ordering to position** in the three list queries:
  - `findAll`: keyset key changes. Replace `keysetAfter(products.createdAt, products.id, cur, 'asc')` → `keysetAfter(products.position, products.id, cur, 'asc')` and `.orderBy(asc(products.position), asc(products.id))`; update `buildPage` key extractor to `{ position: r.position!, id: r.id }`. (Check `keysetAfter`/`decodeCursor` accept an integer key — `position` is int; if the cursor encoder is value-agnostic this is fine.)
  - `listOptions`: `.orderBy(asc(products.position), asc(products.createdAt))`.
  - `findPublicBySlug`: `.orderBy(asc(products.position), asc(products.createdAt), asc(products.id))`.

- [ ] **Step 5: Add controller route** in `products.controller.ts` — a LITERAL route before `:id` (place next to `assign`):
```ts
// Literal route — must precede `:id`.
@Patch('reorder')
reorder(@CurrentTenant() tenantId: string, @Body() dto: ReorderDto) {
  return this.productsService.reorder(tenantId, dto);
}
```
Add `import { ReorderDto } from '../../common/dto/reorder.dto';`.

- [ ] **Step 6: Run tests, verify PASS.** Run: `ctx-wire run pnpm --filter @farmflow/api test -- products`

- [ ] **Step 7: Commit.** `git commit -am "feat(api): product reorder + order by position"`

### Task 4: `FarmersService.reorder` (TDD)

**Files:**
- Modify: `server/src/modules/farmers/farmers.service.ts`, `farmers.controller.ts`
- Test: farmers service spec

- [ ] **Step 1: Failing test** — reorder sets positions tenant-scoped + busts `cache.invalidate` and `publicCache.del(publicCacheKeys.farmers(tenantId))`.

- [ ] **Step 2: Verify FAIL.** Run: `ctx-wire run pnpm --filter @farmflow/api test -- farmers`

- [ ] **Step 3: Implement** (mirror media reorder's transaction + invalidation, on the `farmers` table):
```ts
async reorder(tenantId: string, dto: ReorderDto): Promise<{ ok: true }> {
  await this.db.transaction(async (tx) => {
    for (const it of dto.items) {
      await tx.update(farmers).set({ position: it.position })
        .where(and(eq(farmers.id, it.id), eq(farmers.tenantId, tenantId)));
    }
  });
  await this.cache.invalidate(tenantId);
  await this.publicCache.del(publicCacheKeys.farmers(tenantId));
  return { ok: true };
}
```
Use the file's existing `ReorderMediaDto` import or add the `ReorderDto` import.

- [ ] **Step 4: Controller route** before `:id`:
```ts
@Patch('reorder')
reorder(@CurrentTenant() tenantId: string, @Body() dto: ReorderDto) {
  return this.farmersService.reorder(tenantId, dto);
}
```

- [ ] **Step 5: Verify PASS.** Run: `ctx-wire run pnpm --filter @farmflow/api test -- farmers`
- [ ] **Step 6: Commit.** `git commit -am "feat(api): farmer reorder"`

### Task 5: `SubcategoriesService.reorder` (TDD)

**Files:** `server/src/modules/subcategories/subcategories.service.ts`, `.controller.ts`, spec.

- [ ] **Step 1: Failing test** — positions set tenant-scoped + busts `cache.invalidate` + `publicCache.del(publicCacheKeys.subcategories(tenantId))`.
- [ ] **Step 2: Verify FAIL.** Run: `ctx-wire run pnpm --filter @farmflow/api test -- subcategories`
- [ ] **Step 3: Implement** same shape as Task 4 on the `subcategories` table, busting `publicCacheKeys.subcategories(tenantId)`.
- [ ] **Step 4: Controller route** `@Patch('reorder')` before `:id`.
- [ ] **Step 5: Verify PASS.** Run: `ctx-wire run pnpm --filter @farmflow/api test -- subcategories`
- [ ] **Step 6: Commit.** `git commit -am "feat(api): subcategory reorder"`

---

## PHASE 3 — Product of the Week backend

### Task 6: ISO-week util (TDD)

**Files:** Create `server/src/common/util/iso-week.ts` + `iso-week.spec.ts`.

- [ ] **Step 1: Failing test:**
```ts
import { isoWeekNumber } from './iso-week';
it('returns ISO week numbers', () => {
  expect(isoWeekNumber(new Date('2026-01-01'))).toBe(1);
  expect(isoWeekNumber(new Date('2026-06-09'))).toBe(24);
  expect(isoWeekNumber(new Date('2026-12-31'))).toBe(53);
});
```
(Verify the expected values with a reference before locking them in; adjust to true ISO-8601 week numbers for those dates.)

- [ ] **Step 2: Verify FAIL.** Run: `ctx-wire run pnpm --filter @farmflow/api test -- iso-week`
- [ ] **Step 3: Implement** standard ISO-8601 week:
```ts
/** ISO-8601 week number (1..53) for a date, in UTC. */
export function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
```
- [ ] **Step 4: Verify PASS.** Run: `ctx-wire run pnpm --filter @farmflow/api test -- iso-week`
- [ ] **Step 5: Commit.** `git commit -am "feat(api): isoWeekNumber util"`

### Task 7: Tenant POTW fields (DTO + validation)

**Files:** `server/src/modules/tenants/dto/update-tenant.dto.ts`, `tenants.service.ts`.

- [ ] **Step 1: Add DTO fields** (after `reviewsEnabled`):
```ts
@ApiPropertyOptional({ example: false, description: 'Show the Product-of-the-Week highlight' })
@IsOptional() @IsBoolean()
productOfWeekEnabled?: boolean;

@ApiPropertyOptional({ enum: ['manual', 'auto'], description: 'manual = pick a product; auto = weekly rotation' })
@IsOptional() @IsIn(['manual', 'auto'])
productOfWeekMode?: 'manual' | 'auto';

@ApiPropertyOptional({ description: 'Featured product id (manual mode); null to clear' })
@IsOptional() @ValidateIf((o) => o.productOfWeekId !== null) @IsUUID()
productOfWeekId?: string | null;

@ApiPropertyOptional({ description: 'Optional blurb shown with the featured product' })
@IsOptional() @IsString()
productOfWeekNote?: string | null;
```
Add `IsIn, IsUUID, ValidateIf` to the class-validator import.

- [ ] **Step 2: Validate the id is tenant-owned** in `tenants.service.ts updateMe`, before the UPDATE. After destructuring, if `dto.productOfWeekId` is a non-null string, assert it belongs to the tenant:
```ts
if (dto.productOfWeekId) {
  const [p] = await this.db.select({ id: products.id }).from(products)
    .where(and(eq(products.id, dto.productOfWeekId), eq(products.tenantId, tenantId))).limit(1);
  if (!p) throw new BadRequestException('Продуктът не е намерен');
}
```
Add `products` to the `@farmflow/db` import and `BadRequestException` if missing. The four fields flow into `set` via the existing `...flat` spread automatically (they are columns). Cache-busting already covers the tenant profile.

- [ ] **Step 3: Build.** Run: `ctx-wire run pnpm --filter @farmflow/api build`. Expected: clean.
- [ ] **Step 4: Commit.** `git commit -am "feat(api): tenant product-of-week settings + validation"`

### Task 8: Resolve `productOfWeek` in bootstrap (TDD)

**Files:** Create `server/src/modules/public-bootstrap/product-of-week.ts` (pure resolver) + spec; modify `public-bootstrap.controller.ts`.

- [ ] **Step 1: Failing test** for a pure `resolveProductOfWeek(tenant, products, now)` function:
```ts
// disabled -> null
expect(resolveProductOfWeek({ productOfWeekEnabled: false }, products, now)).toBeNull();
// manual, active id -> { id, note }
expect(resolveProductOfWeek({ productOfWeekEnabled: true, productOfWeekMode: 'manual',
  productOfWeekId: 'p2', productOfWeekNote: 'hi' }, products, now)).toEqual({ id: 'p2', note: 'hi' });
// manual, id missing from active list -> null
// auto -> products[isoWeek % products.length].id, note null
```
`products` = array of `PublicProduct` (have `id`); `now` injected for determinism.

- [ ] **Step 2: Verify FAIL.** Run: `ctx-wire run pnpm --filter @farmflow/api test -- product-of-week`
- [ ] **Step 3: Implement** `resolveProductOfWeek`:
```ts
import { isoWeekNumber } from '../../common/util/iso-week';
export interface ProductOfWeek { id: string; note: string | null; }
export function resolveProductOfWeek(
  t: { productOfWeekEnabled?: boolean | null; productOfWeekMode?: string | null;
       productOfWeekId?: string | null; productOfWeekNote?: string | null; },
  products: { id: string }[],
  now: Date,
): ProductOfWeek | null {
  if (!t.productOfWeekEnabled || products.length === 0) return null;
  if (t.productOfWeekMode === 'auto') {
    const idx = isoWeekNumber(now) % products.length;
    return { id: products[idx].id, note: t.productOfWeekNote ?? null };
  }
  if (t.productOfWeekId && products.some((p) => p.id === t.productOfWeekId)) {
    return { id: t.productOfWeekId, note: t.productOfWeekNote ?? null };
  }
  return null;
}
```

- [ ] **Step 4: Wire into the controller.** After the `Promise.all`, compute and include it. The featured fields must be present on `storefront` (PublicTenant) — they are, since `toPublicTenant` spreads all columns. Use a fresh `new Date()`:
```ts
const productOfWeek = resolveProductOfWeek(storefront as any, products, new Date());
return { storefront, products, farmers, subcategories, productOfWeek };
```

- [ ] **Step 5: Verify PASS + build.** Run: `ctx-wire run pnpm --filter @farmflow/api test -- product-of-week` then `ctx-wire run pnpm --filter @farmflow/api build`.
- [ ] **Step 6: Commit.** `git commit -am "feat(api): resolve product-of-week in storefront bootstrap"`

### Task 9: Public product type carries `position`

**Files:** wherever `toPublicProduct` + `PublicProduct` live (`@farmflow/types` + `products.service.ts` mapper).

- [ ] **Step 1:** Add `position` to `PublicProduct` type and include `position: p.position` in `toPublicProduct`. (Storefronts need it to sort per-category sections consistently.)
- [ ] **Step 2: Build.** Run: `ctx-wire run pnpm -r build`. Expected: clean.
- [ ] **Step 3: Commit.** `git commit -am "feat(types): PublicProduct.position"`

---

## PHASE 4 — Admin UI (`client/`)

> Read each target file before editing (match its existing patterns: SSR fetch, `apiFetch`/api-client, `sonner` toasts, optimistic + rollback). These tasks specify behavior + integration points.

### Task 10: `ReorderableList` reusable component

**Files:** Create `client/src/components/reorderable-list.tsx`.

- [ ] **Step 1:** Build a generic client component:
  - Props: `items: T[]`, `getId(item): string`, `renderItem(item): ReactNode`, `onReorder(orderedIds: string[]): void | Promise<void>`.
  - Internal `order` state (array of ids). Render each row with: a drag handle (`draggable`, `onDragStart/onDragOver/onDrop` reordering the array) **and** up/down arrow buttons (swap with neighbor; disabled at ends).
  - On any change call `onReorder(newOrder)`.
  - No external dnd dependency — native HTML5 drag. Keyboard-accessible arrow buttons.
- [ ] **Step 2: Typecheck.** Run: `ctx-wire run pnpm --filter @farmflow/web build` (or the client's typecheck script). Expected: clean.
- [ ] **Step 3: Commit.** `git commit -am "feat(admin): ReorderableList component (drag + arrows)"`

### Task 11: api-client reorder + POTW calls

**Files:** `client/src/lib/api-client.ts`.

- [ ] **Step 1:** Add typed helpers: `reorderProducts(items)`, `reorderFarmers(items)`, `reorderSubcategories(items)` → `PATCH /products|farmers|subcategories/reorder` with `{ items: [{id, position}] }`. POTW writes reuse the existing tenant-update helper (`PATCH /tenants/me`) with the new fields.
- [ ] **Step 2: Typecheck + commit.** `git commit -am "feat(admin): api-client reorder + POTW helpers"`

### Task 12: Products page — reorder mode + per-category + POTW star

**Files:** `client/src/app/(admin)/products/*`, `client/src/components/product-card.tsx` (admin one), and the products client component.

- [ ] **Step 1: Reorder mode.** Add a "Подреди" toggle. When on, render the product list via `<ReorderableList>`. Add a category filter dropdown:
  - No filter → reorder all; on save send full sequence `position = index` for every product.
  - Filtered to a category → reorder only that category's products; compute **slot-preserving** positions: take the current `position` values of the filtered products, sort ascending, reassign them in the new visual order. Send only those items.
  - Persist via `reorderProducts(items)`; optimistic + `sonner`; rollback on error.
- [ ] **Step 2: POTW star.** On each product card add a star / "Продукт на седмицата" toggle. Clicking sets `productOfWeekId` via `PATCH /tenants/me` (and ensures `productOfWeekEnabled` stays as-is). The active product shows a filled star; others outline. Read the current featured id from the tenant profile (SSR it alongside products, or fetch `/tenants/me`).
- [ ] **Step 3: Verify** via preview (Phase 7). Typecheck clean.
- [ ] **Step 4: Commit.** `git commit -am "feat(admin): product reorder (global + per-category) + POTW star"`

### Task 13: Farmers + Subcategories reorder

**Files:** `client/src/app/(admin)/farmers/*`, `client/src/app/(admin)/subcategories/*`.

- [ ] **Step 1:** Wrap each list in `<ReorderableList>` behind a "Подреди" toggle; on save send full-sequence positions via `reorderFarmers` / `reorderSubcategories`; optimistic + toast + rollback.
- [ ] **Step 2: Typecheck + commit.** `git commit -am "feat(admin): farmer & subcategory reorder"`

### Task 14: Settings — POTW block

**Files:** the admin Settings page (find under `client/src/app/(admin)/settings*` or the settings component).

- [ ] **Step 1:** Add a "Продукт на седмицата" card: an enable switch (`productOfWeekEnabled`), a mode radio (`'manual'` / `'auto'`), and when manual a note textarea (`productOfWeekNote`) + a read-only hint that the product is chosen via the star on the Продукти page (or a product dropdown — optional). Save via `PATCH /tenants/me`. Follow the existing settings-card pattern (e.g. the articles/reviews toggles).
- [ ] **Step 2: Typecheck + commit.** `git commit -am "feat(admin): product-of-week settings card"`

---

## PHASE 5 — Next storefront (`storefront/`)

### Task 15: Honor API order + render POTW

**Files:** `storefront/src/lib/api.ts`, home page + catalog/farmers/category components, a new POTW section component.

- [ ] **Step 1: Types.** Add `position` to the product type and `productOfWeek: { id: string; note: string | null } | null` to the bootstrap type in `api.ts`.
- [ ] **Step 2: Verify ordering.** Grep the storefront for client-side sorts of products/farmers/categories (`.sort(`). Where present and keyed by name/price, remove so API order (position) is honored. Per-category sections must keep API order within each group.
- [ ] **Step 3: POTW section.** On the home page, when `productOfWeek` is non-null, render a "Продукт на седмицата" highlight (find the product in the bootstrap products array by id; show image, name, price, note, link to product). Place near the top of home, styled to the theme. Render nothing when null.
- [ ] **Step 4: Verify** via preview (Phase 7). Build clean.
- [ ] **Step 5: Commit.** `git commit -am "feat(storefront): honor catalog order + product-of-week section"`

---

## PHASE 6 — Chaika storefront (`fermerski-pazar-chaika/`, sibling repo)

### Task 16: Honor API order + render POTW (Astro)

**Files:** Chaika API client/types, home `.astro` page, a POTW component.

- [ ] **Step 1: Types.** Add `position` + `productOfWeek` to the Chaika API types.
- [ ] **Step 2: Verify ordering.** Ensure the Astro catalog/farmers/category rendering preserves API order (drop any name/price sort).
- [ ] **Step 3: POTW.** Add a "Продукт на седмицата" section on the Chaika home, gated by `productOfWeek != null`, themed to ферма/Пазар. (Chaika is adaptive to tenant toggles already — follow that pattern.)
- [ ] **Step 4: Build** the Astro site. Expected: clean.
- [ ] **Step 5: Commit** in the Chaika repo. `git commit -am "feat: honor catalog order + product-of-week section"`

---

## PHASE 7 — Full verification

### Task 17: End-to-end verify

- [ ] **Step 1: Backend.** Run full suite: `ctx-wire run pnpm --filter @farmflow/api test`. Expected: all green (existing count + new reorder/POTW/iso-week specs).
- [ ] **Step 2: Build all.** `ctx-wire run pnpm -r build` + client + storefront builds clean.
- [ ] **Step 3: Live API checks** (api running, demo tenant): reorder products → `GET /public/:slug/products` reflects new order; reorder a single category → global order of other products unchanged; set POTW manual → `GET /public/:slug/bootstrap` `productOfWeek.id` matches; switch to auto → id rotates to the ISO-week pick; disable → `productOfWeek` null.
- [ ] **Step 4: Storefront preview** (Next): reorder visible; POTW section shows/hides; per-category order correct. Capture a screenshot as proof.
- [ ] **Step 5: Chaika** build/preview: order + POTW section render.
- [ ] **Step 6: Final commit / summary.** Ensure all phases committed. Update memory per workflow prefs.

---

## Self-Review notes

- **Spec coverage:** reorder products/farmers/cats (Tasks 3-5,10-13) ✓; both reorder UX (Task 10) ✓; global + per-category single-position model (Tasks 3,12) ✓; POTW gate+manual+auto (Tasks 6-8,12,14) ✓; both storefronts (Tasks 15-16) ✓; caching (Tasks 3-5,7) ✓; tests (Tasks 3-8,17) ✓.
- **Open verification during execution:** confirm `keysetAfter`/cursor encoder is value-type-agnostic for the int `position` key (Task 3 Step 4) — if it assumes a Date, keep `findAll` admin ordering on `createdAt` and only reorder the public/listOptions paths + load-all for the admin reorder view. Confirm true ISO week numbers for the Task 6 test dates before locking. Confirm admin Settings page path and product-card file in Phase 4.
