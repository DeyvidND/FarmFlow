# Marketplace curation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the super-admin four marketplace-curation controls — mark a product "Хит", pick "Фермер на седмицата", assign farmer tiers (marketplace sorts by tier), and a genuinely-new "Ново" section.

**Architecture:** Curation is operator-only, driven from the `admin/` Next app via `/platform/*` routes (PlatformAdminGuard, through the BFF proxy). The marketplace (`farmflow-marketplace-next`) reads one tenant's `/public/{slug}/bootstrap` and renders. Tier is a new `farmers.tier` column; "Хит" reuses `products.featured`; "Фермер на седмицата" is a `tenants.settings.farmerOfWeek` pointer; "Ново" is derived from `createdAt`.

**Tech Stack:** NestJS + Drizzle (server, `packages/db`), Next 16 RSC (admin/, marketplace-next), Tailwind v4, class-validator DTOs, Jest (server), Vitest (marketplace, `*.test.ts` only).

## Global Constraints

- Migrations are HAND-WRITTEN and additive; use `ADD COLUMN IF NOT EXISTS`. New migration number: **0088** (last is 0087).
- Expand-before-deploy: add `farmers.tier` to prod DB before shipping code that reads it (matches 0086/0087).
- Public farmer projection in `findPublicBySlug` is an EXPLICIT column list (never bare `.select()`) — new columns must be added by name.
- `smallint` is NOT yet imported in `packages/db/src/schema.ts` — add it to the `drizzle-orm/pg-core` import.
- Admin app calls backend as `apiFetch('platform/...')` (BFF proxy adds Bearer). Server admin pages fetch `${API_BASE}/platform/...` with the `ff_admin_session` cookie.
- Marketplace repo has NO git remote — deploy = manual `wrangler`/opennext, no commit there. FarmFlow: push main = auto-deploy prod.
- Marketplace build MUST use `next build --webpack` (not Turbopack) for the Cloudflare adapter.
- Bulgarian UI copy throughout. Tier labels: `1 = Базов`, `2 = Бранд идентичност`, `3 = Собствен сайт`.
- "Ново" recency window: **14 days**; fallback to newest-8 when the window is empty.

---

## File structure

**FarmFlow (server + db):**
- `packages/db/src/schema.ts` — add `smallint` import + `farmers.tier` column (modify).
- `packages/db/drizzle/0088_farmer_tier.sql` — migration (create).
- `server/src/modules/farmers/farmers.service.ts` — projection + order + auto-link in `update()` (modify).
- `server/src/modules/farmers/dto/create-farmer.dto.ts` — add `tier` (modify).
- `server/src/modules/public-bootstrap/farmer-of-week.ts` — resolver (create).
- `server/src/modules/public-bootstrap/farmer-of-week.spec.ts` — test (create).
- `server/src/modules/public-bootstrap/public-bootstrap.controller.ts` — surface `farmerOfWeek` (modify).
- `server/src/modules/tenants/tenants.service.ts` — `PublicStorefront.farmerOfWeek` field (modify).
- `server/src/common/cache/public-cache.service.ts` — surface `settings.farmerOfWeek` in `resolveTenant` meta (modify).
- `server/src/modules/platform/platform.controller.ts` — 3 new routes (modify).
- `server/src/modules/platform/platform.service.ts` — 3 new methods + `farmerDetail` extension (modify).
- `server/src/modules/platform/dto/marketplace-curation.dto.ts` — DTOs (create).

**admin/:**
- `admin/src/lib/api-client.ts` — types + 3 mutations (modify).
- `admin/src/components/producer-curation.tsx` — client curation panel (create).
- `admin/src/components/producer-detail.tsx` — embed the panel (modify).

**farmflow-marketplace-next:**
- `src/lib/types.ts` — `Farmer.tier`, `Bootstrap.farmerOfWeek` (modify).
- `src/lib/catalog.ts` — `recent()`, `sortByTier()` (modify).
- `src/lib/catalog.test.ts` — test (create).
- `src/app/page.tsx` — tier sort, explicit farmer-of-week, real "Ново" (modify).
- `src/app/farmers/page.tsx` — tier sort (modify).
- `src/components/product-card.tsx` — "Хит"/"Ново" badges (modify).

---

## Task 1: `farmers.tier` column + migration

**Files:**
- Modify: `packages/db/src/schema.ts` (import line 1-18; farmers table 944-997)
- Create: `packages/db/drizzle/0088_farmer_tier.sql`

**Interfaces:**
- Produces: `farmers.tier` (drizzle `smallint`, not null, default 1) → `Farmer.tier: number` via InferSelectModel.

- [ ] **Step 1: Add `smallint` to the import**

In `packages/db/src/schema.ts`, change the import block to include `smallint`:

```ts
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
  smallint,
  boolean,
  date,
  time,
  numeric,
  index,
  uniqueIndex,
  bigserial,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
```

- [ ] **Step 2: Add the `tier` column to the farmers table**

In `packages/db/src/schema.ts`, in the `farmers` table, insert `tier` right after the `branding` jsonb block and before `position`:

```ts
    // Marketplace ranking tier (operator-assigned). 1 = базов листинг, 2 = Бранд
    // идентичност, 3 = собствен сайт. The marketplace sorts farmers by tier DESC
    // (tier 3 on top, tier 1 at the bottom), then position. Auto-bumps to >=2 when
    // branding.enabled (in farmers.service.update), operator can override.
    tier: smallint('tier').notNull().default(1),
    position: integer('position').notNull().default(0),
```

- [ ] **Step 3: Write the migration**

Create `packages/db/drizzle/0088_farmer_tier.sql`:

```sql
-- Marketplace ranking tier for farmers (operator-assigned). Additive, nullable-safe.
ALTER TABLE farmers ADD COLUMN IF NOT EXISTS tier smallint NOT NULL DEFAULT 1;
```

- [ ] **Step 4: Type-check the db package**

Run: `cd packages/db && pnpm build` (or the repo's `tsc -p packages/db`).
Expected: PASS (no TS errors; `smallint` resolves, `farmers.tier` typed).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0088_farmer_tier.sql
git commit -m "feat(db): farmers.tier column (migration 0088)"
```

---

## Task 2: Farmer public projection + tier sort + DTO + branding→tier auto-link

**Files:**
- Modify: `server/src/modules/farmers/farmers.service.ts` (`findPublicBySlug` 450-520; `update` 187-197)
- Modify: `server/src/modules/farmers/dto/create-farmer.dto.ts`

**Interfaces:**
- Consumes: `farmers.tier` (Task 1).
- Produces: `PublicFarmer.tier: number` in the storefront payload; farmers ordered `tier DESC, position ASC, createdAt ASC`; `update()` auto-bumps tier to ≥2 when branding is enabled unless an explicit tier is supplied.

- [ ] **Step 1: Add `tier` to the public projection and reorder**

In `server/src/modules/farmers/farmers.service.ts`, inside `findPublicBySlug`, add `tier` to the select projection (right after `branding`) and change the `orderBy`:

```ts
        branding: farmers.branding,
        tier: farmers.tier,
        position: farmers.position,
        createdAt: farmers.createdAt,
      })
      .from(farmers)
      .where(eq(farmers.tenantId, tenant.id))
      .orderBy(desc(farmers.tier), asc(farmers.position), asc(farmers.createdAt));
```

Ensure `desc` is imported from `drizzle-orm` in this file (the file already imports `asc`, `and`, `eq`; add `desc` to that import if missing).

- [ ] **Step 2: Add `tier` to CreateFarmerDto**

In `server/src/modules/farmers/dto/create-farmer.dto.ts`, add after the `position` field (reuse the already-imported `IsInt`, `Min`, `Max`):

```ts
  /** Marketplace ranking tier: 1 = Базов, 2 = Бранд идентичност, 3 = Собствен сайт.
   *  Operator-set. When omitted, the service keeps the current tier (auto-bumped
   *  to >=2 if branding is enabled). */
  @ApiPropertyOptional({ minimum: 1, maximum: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  tier?: number;
```

(`UpdateFarmerDto extends PartialType(CreateFarmerDto)` picks this up automatically.)

- [ ] **Step 3: Write the failing unit test for the auto-link rule**

Create `server/src/modules/farmers/tier-autolink.spec.ts`:

```ts
import { effectiveTier } from './tier-autolink';

describe('effectiveTier', () => {
  it('keeps current tier when branding off and no explicit tier', () => {
    expect(effectiveTier({ currentTier: 1, brandingEnabled: false })).toBe(1);
  });
  it('bumps to 2 when branding enabled and no explicit tier', () => {
    expect(effectiveTier({ currentTier: 1, brandingEnabled: true })).toBe(2);
  });
  it('never downgrades below current when branding enabled', () => {
    expect(effectiveTier({ currentTier: 3, brandingEnabled: true })).toBe(3);
  });
  it('respects an explicit tier verbatim, even below the branding floor', () => {
    expect(effectiveTier({ currentTier: 2, brandingEnabled: true, explicitTier: 1 })).toBe(1);
  });
  it('respects an explicit upgrade', () => {
    expect(effectiveTier({ currentTier: 1, brandingEnabled: false, explicitTier: 3 })).toBe(3);
  });
});
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `cd server && npx jest tier-autolink -t effectiveTier`
Expected: FAIL — cannot find module `./tier-autolink`.

- [ ] **Step 5: Implement the pure helper**

Create `server/src/modules/farmers/tier-autolink.ts`:

```ts
/**
 * Marketplace tier resolution. An explicit operator tier always wins (including a
 * deliberate downgrade). Otherwise, branding.enabled acts as a floor of 2 — a
 * branded farmer never sits in the base tier — but tier is never lowered.
 */
export function effectiveTier(args: {
  currentTier: number;
  brandingEnabled: boolean;
  explicitTier?: number;
}): number {
  if (args.explicitTier !== undefined) return args.explicitTier;
  const floor = args.brandingEnabled ? 2 : 1;
  return Math.max(args.currentTier, floor);
}
```

- [ ] **Step 6: Run the test to confirm it passes**

Run: `cd server && npx jest tier-autolink -t effectiveTier`
Expected: PASS (5 assertions).

- [ ] **Step 7: Apply the auto-link in `update()`**

In `server/src/modules/farmers/farmers.service.ts`, replace the `update` method body (187-197) with a read-then-write that applies `effectiveTier`:

```ts
  async update(id: string, tenantId: string, dto: UpdateFarmerDto): Promise<Farmer> {
    const [existing] = await this.db
      .select({ tier: farmers.tier, branding: farmers.branding })
      .from(farmers)
      .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)))
      .limit(1);
    if (!existing) throw new NotFoundException('Фермерът не е намерен');

    const brandingEnabled =
      (dto.branding !== undefined ? dto.branding : existing.branding)?.enabled ?? false;
    const tier = effectiveTier({
      currentTier: existing.tier,
      brandingEnabled,
      explicitTier: dto.tier,
    });

    const [row] = await this.db
      .update(farmers)
      .set({ ...dto, tier })
      .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)))
      .returning();
    if (!row) throw new NotFoundException('Фермерът не е намерен');
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.farmers(tenantId));
    return row;
  }
```

Add the import at the top of the file: `import { effectiveTier } from './tier-autolink';`

- [ ] **Step 8: Type-check the server**

Run: `cd server && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/modules/farmers
git commit -m "feat(farmers): expose tier + sort by tier + branding→tier auto-link"
```

---

## Task 3: Farmer-of-week resolver + surface on storefront + bootstrap output

**Files:**
- Create: `server/src/modules/public-bootstrap/farmer-of-week.ts`
- Create: `server/src/modules/public-bootstrap/farmer-of-week.spec.ts`
- Modify: `server/src/modules/public-bootstrap/public-bootstrap.controller.ts`
- Modify: `server/src/modules/tenants/tenants.service.ts` (`PublicStorefront` interface)
- Modify: `server/src/common/cache/public-cache.service.ts` (`resolveTenant` meta)

**Interfaces:**
- Consumes: `farmers` list from `FarmersService.findPublicBySlug` (has `id`), `storefront.farmerOfWeek` config.
- Produces: bootstrap JSON gains top-level `farmerOfWeek: { id: string; note: string | null } | null`.

- [ ] **Step 1: Write the failing resolver test**

Create `server/src/modules/public-bootstrap/farmer-of-week.spec.ts`:

```ts
import { resolveFarmerOfWeek } from './farmer-of-week';

describe('resolveFarmerOfWeek', () => {
  const farmers = [{ id: 'a' }, { id: 'b' }];
  it('returns null when config is missing', () => {
    expect(resolveFarmerOfWeek(null, farmers)).toBeNull();
    expect(resolveFarmerOfWeek({}, farmers)).toBeNull();
  });
  it('returns null when the pointed farmer is not in the public list', () => {
    expect(resolveFarmerOfWeek({ farmerId: 'zzz' }, farmers)).toBeNull();
  });
  it('resolves a valid pointer with its note', () => {
    expect(resolveFarmerOfWeek({ farmerId: 'b', note: 'Пчелар' }, farmers)).toEqual({
      id: 'b',
      note: 'Пчелар',
    });
  });
  it('defaults note to null', () => {
    expect(resolveFarmerOfWeek({ farmerId: 'a' }, farmers)).toEqual({ id: 'a', note: null });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd server && npx jest farmer-of-week`
Expected: FAIL — cannot find module `./farmer-of-week`.

- [ ] **Step 3: Implement the resolver**

Create `server/src/modules/public-bootstrap/farmer-of-week.ts`:

```ts
/** The resolved «Фермер на седмицата»: a farmer id plus an optional operator note. */
export interface FarmerOfWeek {
  id: string;
  note: string | null;
}

/** The tenant-settings pointer that drives the highlight (settings.farmerOfWeek). */
export interface FarmerOfWeekConfig {
  farmerId?: string | null;
  note?: string | null;
}

/**
 * Resolve the featured farmer from the settings pointer against the public farmer
 * list. Returns null when unset or when the pointer targets a farmer that isn't in
 * the storefront's public list (deleted, or the tenant isn't multiFarmer).
 */
export function resolveFarmerOfWeek(
  cfg: FarmerOfWeekConfig | null | undefined,
  farmers: { id: string }[],
): FarmerOfWeek | null {
  const id = cfg?.farmerId;
  if (!id || !farmers.some((f) => f.id === id)) return null;
  return { id, note: cfg?.note ?? null };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd server && npx jest farmer-of-week`
Expected: PASS (4 tests).

- [ ] **Step 5: Surface `settings.farmerOfWeek` on the storefront profile**

In `server/src/common/cache/public-cache.service.ts`, open `resolveTenant` (the method that builds the cached tenant meta). Locate where an existing `settings.*`-derived field is projected onto the meta object — the `merchandising` field (from `settings.merchandising`) is the anchor. Beside it, add a `farmerOfWeek` passthrough of the raw settings pointer:

```ts
      // «Фермер на седмицата» pointer (settings.farmerOfWeek). Raw pointer; the
      // bootstrap endpoint validates it against the public farmer list.
      farmerOfWeek:
        (settings?.farmerOfWeek as { farmerId?: string | null; note?: string | null } | undefined) ?? null,
```

(Use the same `settings` local the merchandising line reads. If merchandising is computed by a helper rather than inline, add the field in the same returned meta object literal.)

- [ ] **Step 6: Add `farmerOfWeek` to the `PublicStorefront` interface**

In `server/src/modules/tenants/tenants.service.ts`, add to the `PublicStorefront` interface (near `productOfWeekPlacement`):

```ts
  // «Фермер на седмицата» pointer (settings.farmerOfWeek). Null when unset. The
  // bootstrap endpoint validates the id against the public farmer list.
  farmerOfWeek: { farmerId?: string | null; note?: string | null } | null;
```

- [ ] **Step 7: Emit `farmerOfWeek` in the bootstrap response**

In `server/src/modules/public-bootstrap/public-bootstrap.controller.ts`:
1. Add the import: `import { resolveFarmerOfWeek } from './farmer-of-week';`
2. After the `productOfWeek` resolve line, add:

```ts
    const farmerOfWeek = resolveFarmerOfWeek(storefront.farmerOfWeek, farmers);
```

3. Add `farmerOfWeek` to the `JSON.stringify({ ... })` object literal (beside `productOfWeek`):

```ts
    const json = JSON.stringify({
      storefront,
      products,
      farmers,
      subcategories,
      productOfWeek,
      farmerOfWeek,
      homeReviews,
      availability,
      bestSellerIds,
    });
```

- [ ] **Step 8: Type-check the server**

Run: `cd server && npx tsc --noEmit`
Expected: PASS. If `resolveTenant`'s meta object is strongly typed and rejects the new key, add `farmerOfWeek` to that meta type too (same file, the type the resolver returns).

- [ ] **Step 9: Commit**

```bash
git add server/src/modules/public-bootstrap server/src/modules/tenants/tenants.service.ts server/src/common/cache/public-cache.service.ts
git commit -m "feat(bootstrap): resolve + emit farmerOfWeek pointer"
```

---

## Task 4: Platform curation DTOs + routes + service

**Files:**
- Create: `server/src/modules/platform/dto/marketplace-curation.dto.ts`
- Modify: `server/src/modules/platform/platform.controller.ts`
- Modify: `server/src/modules/platform/platform.service.ts`

**Interfaces:**
- Consumes: `products`, `farmers`, `tenants` tables; `publicCacheKeys`, `this.publicCache` (already used in `updateTenant`).
- Produces:
  - `PATCH /platform/products/:id/featured` `{ featured: boolean }` → `{ id, featured }`
  - `PATCH /platform/farmers/:id/tier` `{ tier: number }` → `{ id, tier }`
  - `PATCH /platform/farmers/:id/farmer-of-week` `{ enabled: boolean }` → `{ id, farmerOfWeek: string | null }`
  - `farmerDetail(id)` gains `tier: number`, `isFarmerOfWeek: boolean`, `products: { id; name; imageUrl; featured }[]`

- [ ] **Step 1: Create the DTOs**

Create `server/src/modules/platform/dto/marketplace-curation.dto.ts`:

```ts
import { IsBoolean, IsInt, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SetProductFeaturedDto {
  @ApiProperty()
  @IsBoolean()
  featured: boolean;
}

export class SetFarmerTierDto {
  @ApiProperty({ minimum: 1, maximum: 3 })
  @IsInt()
  @Min(1)
  @Max(3)
  tier: number;
}

export class SetFarmerOfWeekDto {
  @ApiProperty({ description: 'true → make this farmer the tenant’s фермер на седмицата; false → clear it' })
  @IsBoolean()
  enabled: boolean;
}
```

- [ ] **Step 2: Add the three routes to the controller**

In `server/src/modules/platform/platform.controller.ts`:
1. Import the DTOs at top: `import { SetProductFeaturedDto, SetFarmerTierDto, SetFarmerOfWeekDto } from './dto/marketplace-curation.dto';`
2. Add three routes inside the class (near the other `@Patch` tenant routes):

```ts
  /** Mark/unmark a product as „Хит" (reuses products.featured). */
  @Patch('products/:id/featured')
  setProductFeatured(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetProductFeaturedDto) {
    return this.platform.setProductFeatured(id, dto.featured);
  }

  /** Assign a farmer's marketplace tier (1..3). */
  @Patch('farmers/:id/tier')
  setFarmerTier(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetFarmerTierDto) {
    return this.platform.setFarmerTier(id, dto.tier);
  }

  /** Make (or clear) this farmer as their tenant's «Фермер на седмицата». */
  @Patch('farmers/:id/farmer-of-week')
  setFarmerOfWeek(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetFarmerOfWeekDto) {
    return this.platform.setFarmerOfWeek(id, dto.enabled);
  }
```

- [ ] **Step 3: Add the service methods**

In `server/src/modules/platform/platform.service.ts`, add these methods (near `updateTenant`). They resolve the tenant slug for cache-busting and bust both the resource cache and the bootstrap bundle. Ensure `products`, `farmers`, `tenants`, `publicCacheKeys`, `sql` are imported (they already are for existing methods; add any missing):

```ts
  /** Look up a farmer's tenant id + slug (for cache busting). */
  private async farmerTenant(id: string): Promise<{ tenantId: string; slug: string }> {
    const [row] = await this.db
      .select({ tenantId: farmers.tenantId, slug: tenants.slug })
      .from(farmers)
      .innerJoin(tenants, eq(farmers.tenantId, tenants.id))
      .where(eq(farmers.id, id))
      .limit(1);
    if (!row?.tenantId || !row.slug) throw new NotFoundException('Фермерът не е намерен');
    return { tenantId: row.tenantId, slug: row.slug };
  }

  async setProductFeatured(id: string, featured: boolean): Promise<{ id: string; featured: boolean }> {
    const [row] = await this.db
      .update(products)
      .set({ featured })
      .where(eq(products.id, id))
      .returning({ id: products.id, featured: products.featured, tenantId: products.tenantId });
    if (!row) throw new NotFoundException('Продуктът не е намерен');
    const [t] = await this.db
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, row.tenantId))
      .limit(1);
    await this.publicCache.del(
      publicCacheKeys.products(row.tenantId),
      ...(t?.slug ? [publicCacheKeys.bootstrap(t.slug)] : []),
    );
    return { id: row.id, featured: row.featured };
  }

  async setFarmerTier(id: string, tier: number): Promise<{ id: string; tier: number }> {
    const { tenantId, slug } = await this.farmerTenant(id);
    const [row] = await this.db
      .update(farmers)
      .set({ tier })
      .where(eq(farmers.id, id))
      .returning({ id: farmers.id, tier: farmers.tier });
    if (!row) throw new NotFoundException('Фермерът не е намерен');
    await this.publicCache.del(publicCacheKeys.farmers(tenantId), publicCacheKeys.bootstrap(slug));
    return { id: row.id, tier: row.tier };
  }

  async setFarmerOfWeek(id: string, enabled: boolean): Promise<{ id: string; farmerOfWeek: string | null }> {
    const { tenantId, slug } = await this.farmerTenant(id);
    const value = enabled ? JSON.stringify({ farmerId: id }) : 'null';
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['farmerOfWeek'], ${value}::jsonb, true)`,
      })
      .where(eq(tenants.id, tenantId));
    await this.publicCache.del(publicCacheKeys.tenant(slug), publicCacheKeys.bootstrap(slug));
    return { id, farmerOfWeek: enabled ? id : null };
  }
```

Note on `publicCacheKeys.products` / `.bootstrap`: confirm these key builders exist in `server/src/common/cache/public-cache.service.ts` (`bootstrap` is used in `PublicBootstrapController`; `products` is the key `ProductsService.findPublicBySlug` reads). Use the exact names those files use.

- [ ] **Step 4: Extend `farmerDetail` with tier, isFarmerOfWeek, products**

In `server/src/modules/platform/platform.service.ts`, in the `farmerDetail(id)` method, add to its returned object:
1. `tier` — read `farmers.tier` in the farmer select.
2. `isFarmerOfWeek` — compare the tenant's `settings.farmerOfWeek.farmerId` to this id.
3. `products` — a small list for the хит toggles.

Add these reads (adapt to the method's existing variable names — it already loads the farmer row and its tenant):

```ts
    const productRows = await this.db
      .select({
        id: products.id,
        name: products.name,
        imageUrl: products.imageUrl,
        featured: products.featured,
      })
      .from(products)
      .where(and(eq(products.farmerId, id), isNull(products.deletedAt)))
      .orderBy(asc(products.position), asc(products.createdAt))
      .limit(200);

    const [settingsRow] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, /* the farmer's tenantId var in this method */ tenantId))
      .limit(1);
    const fow = (settingsRow?.settings as { farmerOfWeek?: { farmerId?: string } } | null)?.farmerOfWeek;
    const isFarmerOfWeek = fow?.farmerId === id;
```

Then include `tier: farmerRow.tier, isFarmerOfWeek, products: productRows,` in the returned object. Ensure `isNull`, `and`, `asc` are imported from `drizzle-orm` in this file.

- [ ] **Step 5: Type-check the server**

Run: `cd server && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Smoke-test a route (build + boot check)**

Run: `cd server && npx tsc --noEmit && echo OK`
Expected: `OK`. (Full e2e happens after the DB column exists in the target env.)

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/platform
git commit -m "feat(platform): curation routes — product хит, farmer tier, фермер на седмицата"
```

---

## Task 5: Admin api-client — types + mutations

**Files:**
- Modify: `admin/src/lib/api-client.ts`

**Interfaces:**
- Consumes: the three platform routes (Task 4).
- Produces: `setProductFeatured(id, featured)`, `setFarmerTier(id, tier)`, `setFarmerOfWeek(id, enabled)`; `FarmerDetail` gains `tier`, `isFarmerOfWeek`, `products`; `GlobalFarmer` gains `tier`.

- [ ] **Step 1: Extend the types**

In `admin/src/lib/api-client.ts`, add `tier: number;` to the `GlobalFarmer` interface, and to `FarmerDetail` add:

```ts
  tier: number;
  isFarmerOfWeek: boolean;
  products: { id: string; name: string; imageUrl: string | null; featured: boolean }[];
```

- [ ] **Step 2: Add the three mutations**

In `admin/src/lib/api-client.ts`, add (mirroring `setTenantStatus`):

```ts
export const setProductFeatured = (id: string, featured: boolean) =>
  apiFetch<{ id: string; featured: boolean }>(
    `platform/products/${id}/featured`,
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ featured }) },
    'Неуспешна промяна на „Хит"',
  );

export const setFarmerTier = (id: string, tier: number) =>
  apiFetch<{ id: string; tier: number }>(
    `platform/farmers/${id}/tier`,
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tier }) },
    'Неуспешна промяна на тиър',
  );

export const setFarmerOfWeek = (id: string, enabled: boolean) =>
  apiFetch<{ id: string; farmerOfWeek: string | null }>(
    `platform/farmers/${id}/farmer-of-week`,
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) },
    'Неуспешна промяна на „Фермер на седмицата"',
  );
```

- [ ] **Step 3: Type-check the admin app**

Run: `cd admin && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add admin/src/lib/api-client.ts
git commit -m "feat(admin): api-client curation types + mutations"
```

---

## Task 6: Admin curation panel on the producer page

**Files:**
- Create: `admin/src/components/producer-curation.tsx`
- Modify: `admin/src/components/producer-detail.tsx`

**Interfaces:**
- Consumes: `FarmerDetail` (`tier`, `isFarmerOfWeek`, `products`), the three mutations (Task 5).
- Produces: operator UI — tier select, «Фермер на седмицата» toggle, per-product „Хит" toggles.

- [ ] **Step 1: Build the client panel**

Create `admin/src/components/producer-curation.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Star, Crown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { setProductFeatured, setFarmerTier, setFarmerOfWeek, type FarmerDetail } from '@/lib/api-client';

const TIERS: { value: number; label: string }[] = [
  { value: 1, label: 'Базов' },
  { value: 2, label: 'Бранд идентичност' },
  { value: 3, label: 'Собствен сайт' },
];

export function ProducerCuration({ farmer: f }: { farmer: FarmerDetail }) {
  const [tier, setTier] = useState(f.tier);
  const [fow, setFow] = useState(f.isFarmerOfWeek);
  const [feat, setFeat] = useState<Record<string, boolean>>(
    Object.fromEntries(f.products.map((p) => [p.id, p.featured])),
  );
  const [busy, setBusy] = useState<string | null>(null);

  const onTier = async (v: number) => {
    const prev = tier;
    setTier(v);
    setBusy('tier');
    try {
      await setFarmerTier(f.id, v);
    } catch {
      setTier(prev);
    } finally {
      setBusy(null);
    }
  };

  const onFow = async () => {
    const next = !fow;
    setFow(next);
    setBusy('fow');
    try {
      await setFarmerOfWeek(f.id, next);
    } catch {
      setFow(!next);
    } finally {
      setBusy(null);
    }
  };

  const onFeat = async (id: string) => {
    const next = !feat[id];
    setFeat((s) => ({ ...s, [id]: next }));
    setBusy(id);
    try {
      await setProductFeatured(id, next);
    } catch {
      setFeat((s) => ({ ...s, [id]: !next }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
      <h2 className="text-[15px] font-extrabold">Маркетплейс</h2>

      {/* tier + фермер на седмицата */}
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-bold text-ff-muted">Тиър</span>
          <div className="inline-flex rounded-lg border border-ff-border bg-ff-surface-2 p-0.5">
            {TIERS.map((t) => (
              <button
                key={t.value}
                type="button"
                disabled={busy === 'tier'}
                onClick={() => onTier(t.value)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-[12.5px] font-bold transition-colors disabled:opacity-60',
                  tier === t.value ? 'bg-ff-green-700 text-white' : 'text-ff-ink-2 hover:bg-ff-surface',
                )}
              >
                {t.value} · {t.label}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          disabled={busy === 'fow'}
          onClick={onFow}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] font-bold transition-colors disabled:opacity-60',
            fow
              ? 'border-ff-green-500 bg-ff-green-50 text-ff-green-700'
              : 'border-ff-border bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2',
          )}
        >
          <Crown size={15} /> {fow ? 'Фермер на седмицата ✓' : 'Направи фермер на седмицата'}
        </button>
      </div>

      {/* хит products */}
      <div className="mt-5">
        <div className="mb-2 text-[13px] font-bold text-ff-muted">Продукти · маркирай „Хит"</div>
        {f.products.length === 0 ? (
          <p className="text-[13px] text-ff-muted-2">Няма продукти.</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
            {f.products.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={busy === p.id}
                onClick={() => onFeat(p.id)}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-[13px] font-semibold transition-colors disabled:opacity-60',
                  feat[p.id]
                    ? 'border-ff-amber-400 bg-ff-amber-soft text-ff-amber-600'
                    : 'border-ff-border bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2',
                )}
              >
                <Star size={14} className={feat[p.id] ? 'fill-current' : ''} />
                <span className="truncate">{p.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

If `ff-amber-400` isn't a defined token, use `ff-amber-500` (check the admin Tailwind theme; other components use `ff-amber-600`/`ff-amber-soft`).

- [ ] **Step 2: Embed the panel in producer-detail**

In `admin/src/components/producer-detail.tsx`:
1. Add the import: `import { ProducerCuration } from './producer-curation';`
2. Render it right after the header block (before the „stat cards" grid):

```tsx
      <ProducerCuration farmer={f} />

      {/* stat cards */}
```

- [ ] **Step 3: Type-check the admin app**

Run: `cd admin && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Build the admin app**

Run: `cd admin && npx next build --webpack` (or the repo's admin build script)
Expected: build succeeds; `/producers/[id]` compiles.

- [ ] **Step 5: Commit**

```bash
git add admin/src/components/producer-curation.tsx admin/src/components/producer-detail.tsx
git commit -m "feat(admin): producer curation panel — tier, фермер на седмицата, хит"
```

---

## Task 7: Marketplace types + tier sort + real "Ново" + badges

**Files:**
- Modify: `farmflow-marketplace-next/src/lib/types.ts`
- Modify: `farmflow-marketplace-next/src/lib/catalog.ts`
- Create: `farmflow-marketplace-next/src/lib/catalog.test.ts`
- Modify: `farmflow-marketplace-next/src/app/page.tsx`
- Modify: `farmflow-marketplace-next/src/app/farmers/page.tsx`
- Modify: `farmflow-marketplace-next/src/components/product-card.tsx`

**Interfaces:**
- Consumes: bootstrap `farmers[].tier`, top-level `farmerOfWeek`, `createdAt`.
- Produces: farmers sorted by tier; explicit farmer-of-week; a genuinely-recent "Ново" section; "Хит"/"Ново" product badges.

- [ ] **Step 1: Extend the types**

In `src/lib/types.ts`:
1. Add `tier: number;` to the `Farmer` interface (after `position`).
2. Add to `Bootstrap`:

```ts
  farmerOfWeek?: { id: string; note: string | null } | null;
```

Also add `farmerOfWeek: data.farmerOfWeek ?? null,` to the `getCatalog()` return object and the `EMPTY` constant in `src/lib/api.ts`.

- [ ] **Step 2: Write failing tests for the catalog helpers**

Create `src/lib/catalog.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { recent, sortByTier } from './catalog';

const P = (id: string, createdAt: string | null, isActive = true) =>
  ({ id, createdAt, isActive }) as any;

describe('recent', () => {
  const now = new Date('2026-07-11T00:00:00Z');
  it('keeps only items inside the window, newest first', () => {
    const items = [
      P('old', '2026-06-01T00:00:00Z'),
      P('fresh', '2026-07-10T00:00:00Z'),
      P('mid', '2026-07-05T00:00:00Z'),
    ];
    expect(recent(items, 14, 1, now).map((p) => p.id)).toEqual(['fresh', 'mid']);
  });
  it('tops up to `min` with newest overall when the window is empty', () => {
    const items = [P('a', '2026-01-01T00:00:00Z'), P('b', '2026-02-01T00:00:00Z')];
    expect(recent(items, 14, 2, now).map((p) => p.id)).toEqual(['b', 'a']);
  });
  it('drops inactive items', () => {
    const items = [P('x', '2026-07-10T00:00:00Z', false), P('y', '2026-07-10T00:00:00Z')];
    expect(recent(items, 14, 8, now).map((p) => p.id)).toEqual(['y']);
  });
});

describe('sortByTier', () => {
  it('sorts tier desc, stable within a tier', () => {
    const fs = [
      { id: 'a', tier: 1, position: 0 },
      { id: 'b', tier: 3, position: 5 },
      { id: 'c', tier: 2, position: 1 },
    ] as any;
    expect(sortByTier(fs).map((f) => f.id)).toEqual(['b', 'c', 'a']);
  });
  it('breaks tier ties by position asc', () => {
    const fs = [
      { id: 'a', tier: 2, position: 3 },
      { id: 'b', tier: 2, position: 1 },
    ] as any;
    expect(sortByTier(fs).map((f) => f.id)).toEqual(['b', 'a']);
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `cd ../farmflow-marketplace-next && npx vitest run src/lib/catalog.test.ts`
Expected: FAIL — `recent`/`sortByTier` are not exported.

- [ ] **Step 4: Implement the helpers**

In `src/lib/catalog.ts`, add (and keep the existing `featured()` for backward-compat; the "Ново" section will switch to `recent`):

```ts
import type { Farmer } from './types';

/** Items created within `days`, newest-first; topped up to `min` with the newest
 *  overall when the window is sparse. `now` is injectable for tests. */
export function recent<T extends { createdAt: string | null; isActive?: boolean | null }>(
  items: T[],
  days = 14,
  min = 8,
  now: Date = new Date(),
): T[] {
  const active = items.filter((p) => p.isActive !== false);
  const byNew = [...active].sort(
    (a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
  );
  const cutoff = now.getTime() - days * 86_400_000;
  const inWindow = byNew.filter((p) => new Date(p.createdAt ?? 0).getTime() >= cutoff);
  if (inWindow.length >= min) return inWindow;
  // Top up with the newest items that aren't already in the window, preserving order.
  const seen = new Set(inWindow.map((p) => (p as { id?: string }).id));
  return [...inWindow, ...byNew.filter((p) => !seen.has((p as { id?: string }).id))].slice(
    0,
    Math.max(min, inWindow.length),
  );
}

/** Farmers ranked for the marketplace: tier DESC (3 on top, 1 at the bottom),
 *  then position ASC. Stable. */
export function sortByTier<T extends Pick<Farmer, 'tier' | 'position'>>(farmers: T[]): T[] {
  return [...farmers].sort((a, b) => b.tier - a.tier || a.position - b.position);
}

/** True when the item was created within `days` (for the „Ново" card badge). */
export function isRecent(createdAt: string | null, days = 14, now: Date = new Date()): boolean {
  if (!createdAt) return false;
  return new Date(createdAt).getTime() >= now.getTime() - days * 86_400_000;
}
```

- [ ] **Step 5: Run to confirm pass**

Run: `npx vitest run src/lib/catalog.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Sort farmers by tier + explicit farmer-of-week in page.tsx**

In `src/app/page.tsx`:
1. Import: `import { categoriesFrom, featured, recent, sortByTier, isRecent } from "@/lib/catalog";` (merge with the existing catalog import).
2. Right after `const { storefront: sf, products, farmers, ... } = boot;`, sort farmers once:

```ts
  const rankedFarmers = sortByTier(farmers);
```

Then use `rankedFarmers` in the FARMERS rail (`rankedFarmers.slice(0, 12)`) instead of `farmers.slice(0, 12)`.

3. Replace the `newProducts` line:

```ts
  const newProducts = recent(products, 14, 8);
```

4. Replace the `featFarmer` resolution block with an explicit-pointer-first version:

```ts
  const fowFarmer = boot.farmerOfWeek ? farmerById.get(boot.farmerOfWeek.id) ?? null : null;
  const potw = boot.productOfWeek ? products.find((p) => p.id === boot.productOfWeek!.id) ?? null : null;
  const potwFarmer = potw?.farmerId ? farmerById.get(potw.farmerId) ?? null : null;
  const featFarmer: Farmer | null = showFarmers
    ? fowFarmer ?? (potwFarmer?.bio ? potwFarmer : rankedFarmers.find((f) => f.bio?.trim()) ?? null)
    : null;
  const fowNote = boot.farmerOfWeek?.note ?? null;
```

5. In the FEATURED FARMER section, when `fowNote` is set, prefer it over the bio in the quote line:

```tsx
                {(fowNote || featFarmer.bio) && (
                  <p className="mt-4 font-heading text-lg italic leading-relaxed text-foreground/85">„{fowNote || featFarmer.bio}“</p>
                )}
```

- [ ] **Step 7: Surface new farmers in the "Ново" section**

In `src/app/page.tsx`, compute recently-added farmers and render them as chips above the product rail inside the „Ново тази седмица" section:

```ts
  const newFarmers = showFarmers ? recent(farmers as never[], 14, 0) : [];
```

(Pass `min = 0` so it returns ONLY genuinely-new farmers, no top-up.) In the section JSX, above the product scroller, add:

```tsx
              {newFarmers.length > 0 && (
                <div className="mb-4 flex flex-wrap gap-2">
                  {newFarmers.map((f) => (
                    <Link
                      key={f.id}
                      href={`/farmer/${slugs.get(f.id)}`}
                      className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-3 py-1.5 text-[13px] font-bold text-primary"
                    >
                      Нов фермер · {f.name}
                    </Link>
                  ))}
                </div>
              )}
```

- [ ] **Step 8: Sort farmers/page.tsx by tier**

In `src/app/farmers/page.tsx`, import `sortByTier` and iterate the sorted list:

```tsx
import { sortByTier } from "@/lib/catalog";
// ...
          {sortByTier(boot.farmers).map((f) => {
```

- [ ] **Step 9: Product-card "Хит" + "Ново" badges**

In `src/components/product-card.tsx`:
1. Import: `import { coverCropStyle, shapeAspect } from "@/lib/cover";` already present — add `import { isRecent } from "@/lib/cover";`? No — add `import { isRecent } from "@/lib/catalog";`.
2. Change the `tag` line so operator-featured reads "Хит":

```ts
  const isNew = isRecent(p.createdAt ?? null);
  const tag = p.featured ? "Хит" : pd.compareStotinki != null ? "Промо" : null;
```

3. Add a "Ново" badge (top-right, only when not already a best-seller "Хит"), beside the existing `bestSeller` badge:

```tsx
        {!bestSeller && isNew && (
          <span className="absolute right-2.5 top-2.5 z-10 rounded-full bg-primary px-2.5 py-1 text-[11px] font-extrabold text-primary-foreground">
            Ново
          </span>
        )}
```

(The left `tag` now shows "Хит" for `featured`; the right side shows the auto best-seller "Хит" or the "Ново" recency badge.)

- [ ] **Step 10: Type-check + build the marketplace**

Run: `npx tsc --noEmit && npx next build --webpack`
Expected: PASS.

- [ ] **Step 11: Commit (FarmFlow docs only — marketplace repo has no remote)**

The marketplace repo is deploy-only (no git). Commit the plan progress in FarmFlow if tracking there; otherwise proceed to deploy in the execution phase.

---

## Task 8: Wire-up verification (post-migration, live)

**Files:** none (verification only).

- [ ] **Step 1: Expand the prod DB before deploy**

Apply `0088` to prod (idempotent):

```sql
ALTER TABLE farmers ADD COLUMN IF NOT EXISTS tier smallint NOT NULL DEFAULT 1;
```

- [ ] **Step 2: Deploy backend + admin (push main)**

```bash
git push origin main
```

Expected: Hetzner auto-deploys server + admin; `/platform/*` curation routes live.

- [ ] **Step 3: Deploy the marketplace**

Run the marketplace deploy (manual `wrangler`/opennext build) from `farmflow-marketplace-next`.

- [ ] **Step 4: Operator smoke test**

In the admin app → Производители → open Васил: set tier 2, toggle „Фермер на седмицата", mark a product „Хит". Then load the marketplace: Васил sorts above tier-1 farmers, is the featured farmer, his product shows the „Хит" badge, and a recently-added product shows „Ново".

---

## Self-review

- **Spec coverage:** (1) Хит → Tasks 4/5/6 (route+admin toggle) + 7 (badge/sort). (2) Фермер на седмицата → Task 3 (resolve/emit) + 4/5/6 (pick) + 7 (render). (3) Tiers → Tasks 1/2 (column+sort+auto-link) + 4/5/6 (assign) + 7 (marketplace sort). (4) Ново → Task 7 (`recent`, section, badge). All covered.
- **Placeholder scan:** the only "read the file first" anchors are the `resolveTenant` merchandising line (Task 3 Step 5) and `farmerDetail`'s tenantId var (Task 4 Step 4) — both name a concrete anchor and provide the exact code to add; not blank placeholders.
- **Type consistency:** `effectiveTier` (Task 2) matches its test; `resolveFarmerOfWeek`/`FarmerOfWeek` (Task 3) reused verbatim in the controller; admin `FarmerDetail.products` shape matches the platform `farmerDetail` product select; marketplace `Bootstrap.farmerOfWeek {id,note}` matches the server emit; `sortByTier`/`recent` signatures match their call sites.
