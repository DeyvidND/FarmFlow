# Product Variants + Promotional Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one product carry several priced+stocked variants (вид/грамаж) and a time-boxed percentage promotion applied proportionally to all prices, with all pricing computed server-side.

**Architecture:** New `product_variants` table (flat list, per-variant stock). Two additive promo columns on `products` (`sale_percent`, `sale_ends_at`). Two additive snapshot columns on `order_items` (`variant_id`, `variant_label`). A pure pricing util computes the active sale price; the products service applies it in `toPublicProduct` and the orders service applies it (and decrements variant stock) inside the existing intake transaction. A daily BullMQ repeatable nulls out expired promos for admin tidiness.

**Tech Stack:** NestJS + Drizzle (Postgres) + BullMQ on the server; Next.js (React, no unit-test runner) on the client. Money is integer **stotinki**. Server tests: Jest (`cd server && npm test`).

**Spec:** `docs/superpowers/specs/2026-06-26-product-variants-and-promo-design.md`

**Scope note:** The chaika storefront is a **separate repo** — its changes (variant picker, "от X" card label, struck+sale display, cart variantId) are documented in the final section as a follow-up and are NOT tasks in this plan. The server API changes here are additive and backward-compatible so chaika keeps working until updated.

---

## File Structure

**Created:**
- `packages/db/drizzle/0062_product_variants_and_promo.sql` — migration
- `server/src/modules/products/promo.util.ts` — pure promo pricing math
- `server/src/modules/products/promo.util.spec.ts` — its tests
- `server/src/modules/products/dto/variant.dto.ts` — `VariantDto`
- `server/src/modules/products/products.promo-variants.spec.ts` — service variant/promo tests
- `server/src/modules/products/products.processor.ts` — daily expire-promos repeatable
- `server/src/modules/products/products.processor.spec.ts` — its test

**Modified:**
- `packages/db/src/schema.ts` — `productVariants` table; `products` +promo cols; `orderItems` +variant cols
- `packages/types/src/index.ts` — `ProductVariant`/`NewProductVariant` types; extend `PublicProduct`; add `PublicProductVariant`
- `server/src/modules/products/dto/create-product.dto.ts` — `salePercent`, `saleEndsAt`, `variants`
- `server/src/modules/products/products.service.ts` — variant upsert + price sync + promo in public shape + `listVariants` + `expirePromotions`
- `server/src/modules/products/products.controller.ts` — `GET /products/:id/variants`
- `server/src/modules/products/products.module.ts` — register `PRODUCTS_QUEUE` + processor (gated by `RUN_WORKERS`)
- `server/src/common/queue/queue.constants.ts` — `PRODUCTS_QUEUE`
- `server/src/modules/orders/dto/create-order-item.dto.ts` — optional `variantId`
- `server/src/modules/orders/orders.service.ts` — variant load/lock/decrement + snapshot + promo price
- `client/src/lib/types.ts` — `Product` promo fields; `ProductVariant` type
- `client/src/lib/api-client.ts` — `listProductVariants`; extend `ProductWrite`
- `client/src/components/products/product-dialog.tsx` — Variants + Promotion sections

---

## Task 1: DB schema + migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0062_product_variants_and_promo.sql`
- Modify: `packages/types/src/index.ts`

- [ ] **Step 1: Add the `productVariants` table to schema.ts**

Insert immediately AFTER the `products` table definition (after its closing `);`, around line 219):

```typescript
// Per-product priced variants (вид/грамаж): e.g. "Кристализиран 500 г" / "Течен 1 кг".
// A product either sells at its own priceStotinki (no variants) OR via these rows
// (variants present). Each variant carries its own stock (NULL = unlimited, 0 = out).
// position orders them in the picker; deletedAt soft-deletes (order_items keep a label
// snapshot, so a removed variant's history survives). When variants exist the service
// syncs products.priceStotinki to the cheapest variant for sort + "от X" display.
export const productVariants = pgTable(
  'product_variants',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    priceStotinki: integer('price_stotinki').notNull(),
    // NULL = unlimited stock; 0 = out of stock.
    stockQuantity: integer('stock_quantity'),
    position: integer('position').notNull().default(0),
    deletedAt: timestamp('deleted_at'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    // Ordered fetch of a product's live variants.
    productPositionIdx: index('product_variants_product_position_idx').on(
      t.productId,
      t.position,
      t.id,
    ),
  }),
);
```

- [ ] **Step 2: Add promo columns to the `products` table**

In the `products` table object, add these two fields right after the existing `compareAtPriceStotinki` line:

```typescript
    // Promotion: a percentage discount (1..99) applied proportionally to the base
    // price AND every variant. saleEndsAt NULL = until the farmer removes it; a
    // timestamp = auto-expires (pricing logic ignores it once past; a daily cron
    // nulls both columns for admin tidiness). Both NULL = no promo.
    salePercent: integer('sale_percent'),
    saleEndsAt: timestamp('sale_ends_at'),
```

- [ ] **Step 3: Add variant snapshot columns to the `orderItems` table**

In the `orderItems` table object, add after the `priceStotinki` line:

```typescript
    // Variant snapshot (NULL for products sold without variants). variantLabel is
    // captured at purchase time like productName, so order history survives a later
    // variant rename/removal. priceStotinki already stores the unit price paid.
    variantId: uuid('variant_id').references(() => productVariants.id),
    variantLabel: text('variant_label'),
```

- [ ] **Step 4: Add the type exports to packages/types/src/index.ts**

Add `productVariants` to the existing `import type { ... } from '@fermeribg/db'` block. Then add after the `Product`/`NewProduct` exports:

```typescript
export type ProductVariant = InferSelectModel<typeof productVariants>;
export type NewProductVariant = InferInsertModel<typeof productVariants>;
```

- [ ] **Step 5: Write the migration SQL**

Create `packages/db/drizzle/0062_product_variants_and_promo.sql`:

```sql
-- Product variants (вид/грамаж) + promotional pricing.
-- product_variants: flat per-product priced+stocked options (one product, many prices).
-- products.sale_percent/sale_ends_at: % promo applied proportionally to base + variants.
-- order_items.variant_id/variant_label: per-line variant snapshot (label survives renames).
-- All additive + nullable → backward-compatible; the storefront keeps working until updated.
CREATE TABLE IF NOT EXISTS "product_variants" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "product_id" uuid NOT NULL,
  "label" text NOT NULL,
  "price_stotinki" integer NOT NULL,
  "stock_quantity" integer,
  "position" integer DEFAULT 0 NOT NULL,
  "deleted_at" timestamp,
  "created_at" timestamp DEFAULT now()
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_variants_product_position_idx"
  ON "product_variants" ("product_id","position","id");--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "sale_percent" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "sale_ends_at" timestamp;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "variant_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "variant_label" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_product_variants_id_fk"
    FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
```

- [ ] **Step 5b: Register the migration in the drizzle journal**

The boot migrator (`migrate()` from drizzle-orm) only applies migrations listed in `packages/db/drizzle/meta/_journal.json` — a hand-written `.sql` not in the `entries` array is silently skipped. Hand-written migrations need a journal entry but NO snapshot file. Append as the last element of `entries` (after the `0061_nekorekten_durable_cache` entry; add the comma after 0061's closing brace):

```json
    {
      "idx": 62,
      "version": "7",
      "when": 1782466800000,
      "tag": "0062_product_variants_and_promo",
      "breakpoints": true
    }
```

- [ ] **Step 6: Build the db + types packages to verify they compile**

Run: `cd packages/db && pnpm build && cd ../types && pnpm build`
Expected: both compile with no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0062_product_variants_and_promo.sql packages/db/drizzle/meta/_journal.json packages/types/src/index.ts
git commit -m "feat(db): product_variants table + promo + order-item variant snapshot (migration 0062)"
```

---

## Task 2: Pure promo pricing util (TDD)

**Files:**
- Create: `server/src/modules/products/promo.util.ts`
- Test: `server/src/modules/products/promo.util.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/products/promo.util.spec.ts`:

```typescript
import { isPromoActive, salePriceStotinki, effectivePriceStotinki } from './promo.util';

const NOW = new Date('2026-06-26T10:00:00Z');

describe('isPromoActive', () => {
  it('false when no percent', () => {
    expect(isPromoActive(null, null, NOW)).toBe(false);
    expect(isPromoActive(null, new Date('2030-01-01'), NOW)).toBe(false);
  });
  it('true when percent set and no end date', () => {
    expect(isPromoActive(20, null, NOW)).toBe(true);
  });
  it('true when end date is in the future', () => {
    expect(isPromoActive(20, new Date('2026-07-31T00:00:00Z'), NOW)).toBe(true);
  });
  it('false when end date has passed', () => {
    expect(isPromoActive(20, new Date('2026-06-25T00:00:00Z'), NOW)).toBe(false);
  });
});

describe('salePriceStotinki', () => {
  it('rounds price * (1 - pct/100)', () => {
    expect(salePriceStotinki(650, 20)).toBe(520); // 650 * 0.8
    expect(salePriceStotinki(1250, 20)).toBe(1000);
    expect(salePriceStotinki(999, 33)).toBe(669); // 999*0.67=669.33 → 669
  });
});

describe('effectivePriceStotinki', () => {
  it('returns discounted price when promo active', () => {
    expect(effectivePriceStotinki(650, 20, null, NOW)).toBe(520);
  });
  it('returns the regular price when promo inactive/expired', () => {
    expect(effectivePriceStotinki(650, null, null, NOW)).toBe(650);
    expect(effectivePriceStotinki(650, 20, new Date('2026-06-25'), NOW)).toBe(650);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx jest promo.util.spec -c ./package.json`
Expected: FAIL — `Cannot find module './promo.util'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/modules/products/promo.util.ts`:

```typescript
/** Pure promotional-pricing math. No DB, no ambient clock — callers pass `now`
 *  so the same logic drives both the public catalog and order intake, and tests
 *  are deterministic. Money is integer stotinki. */

/** A promo is live when a percentage is set AND it has no end date or the end
 *  date is still in the future. */
export function isPromoActive(
  salePercent: number | null,
  saleEndsAt: Date | null,
  now: Date,
): boolean {
  if (salePercent == null) return false;
  if (saleEndsAt == null) return true;
  return saleEndsAt.getTime() > now.getTime();
}

/** Discounted price = round(price * (1 - pct/100)). Assumes an active promo. */
export function salePriceStotinki(priceStotinki: number, salePercent: number): number {
  return Math.round((priceStotinki * (100 - salePercent)) / 100);
}

/** The price actually charged: the discounted price when the promo is active,
 *  otherwise the regular price. */
export function effectivePriceStotinki(
  priceStotinki: number,
  salePercent: number | null,
  saleEndsAt: Date | null,
  now: Date,
): number {
  return isPromoActive(salePercent, saleEndsAt, now) && salePercent != null
    ? salePriceStotinki(priceStotinki, salePercent)
    : priceStotinki;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx jest promo.util.spec -c ./package.json`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/products/promo.util.ts server/src/modules/products/promo.util.spec.ts
git commit -m "feat(products): pure promo pricing util (isPromoActive/salePrice/effectivePrice)"
```

---

## Task 3: Variant DTO + product DTO promo/variant fields

**Files:**
- Create: `server/src/modules/products/dto/variant.dto.ts`
- Modify: `server/src/modules/products/dto/create-product.dto.ts`

- [ ] **Step 1: Create the VariantDto**

Create `server/src/modules/products/dto/variant.dto.ts`:

```typescript
import { IsString, IsInt, IsOptional, Min, Max, MaxLength, ValidateIf, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VariantDto {
  // Present when editing an existing variant; absent for a newly added row.
  @ApiPropertyOptional({ description: 'Existing variant id (omit to create)' })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ example: 'Кристализиран 500 г' })
  @IsString()
  @MaxLength(120)
  label: string;

  @ApiProperty({ description: 'Variant price in stotinki', example: 650 })
  @IsInt()
  @Min(0)
  priceStotinki: number;

  @ApiPropertyOptional({ description: 'NULL = unlimited stock', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  stockQuantity?: number | null;
}
```

- [ ] **Step 2: Add promo + variants fields to CreateProductDto**

In `server/src/modules/products/dto/create-product.dto.ts`, add `IsDateString`, `ArrayMaxSize` to the `class-validator` import, add `import { VariantDto } from './variant.dto';`, and add these fields to the class (after `subcategoryId`):

```typescript
  @ApiPropertyOptional({ description: 'Promotion: discount percent 1..99 (null clears)', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(99)
  salePercent?: number | null;

  @ApiPropertyOptional({ description: 'Promotion end date ISO; null = no end (manual removal)', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  saleEndsAt?: string | null;

  // Full replace: the variants the product should have after the write. The
  // service upserts these (by id when present) and soft-deletes any omitted rows.
  // Empty array / absent = no variants (product sells at its own priceStotinki).
  @ApiPropertyOptional({ type: [VariantDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @ArrayMaxSize(50)
  @Type(() => VariantDto)
  variants?: VariantDto[];
```

(`UpdateProductDto` is `PartialType(CreateProductDto)`, so it inherits these automatically — no change needed.)

- [ ] **Step 3: Build the server to verify DTOs compile**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/products/dto/variant.dto.ts server/src/modules/products/dto/create-product.dto.ts
git commit -m "feat(products): VariantDto + salePercent/saleEndsAt/variants on product DTO"
```

---

## Task 4: Service — variant upsert + cheapest-price sync (TDD)

**Files:**
- Modify: `server/src/modules/products/products.service.ts`
- Test: `server/src/modules/products/products.promo-variants.spec.ts`

- [ ] **Step 1: Write the failing test for the variant-sync helper**

Create `server/src/modules/products/products.promo-variants.spec.ts`:

```typescript
import { cheapestVariantPrice, planVariantWrites } from './products.service';

describe('cheapestVariantPrice', () => {
  it('returns null for no variants', () => {
    expect(cheapestVariantPrice([])).toBeNull();
  });
  it('returns the minimum priceStotinki', () => {
    expect(cheapestVariantPrice([{ priceStotinki: 1250 }, { priceStotinki: 650 }])).toBe(650);
  });
});

describe('planVariantWrites', () => {
  it('splits incoming variants into inserts (no id) and updates (with id), and finds deletions', () => {
    const incoming = [
      { label: 'Нов 1кг', priceStotinki: 1200 },
      { id: 'v1', label: 'Стар 500г', priceStotinki: 650, stockQuantity: 5 },
    ];
    const existingIds = ['v1', 'v2'];
    const plan = planVariantWrites(incoming, existingIds);
    expect(plan.inserts).toEqual([{ label: 'Нов 1кг', priceStotinki: 1200, position: 0 }]);
    expect(plan.updates).toEqual([
      { id: 'v1', label: 'Стар 500г', priceStotinki: 650, stockQuantity: 5, position: 1 },
    ]);
    expect(plan.deleteIds).toEqual(['v2']); // existing but not in incoming
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx jest products.promo-variants.spec -c ./package.json`
Expected: FAIL — `cheapestVariantPrice is not exported` / module has no such export.

- [ ] **Step 3: Add the two pure exported helpers to products.service.ts**

At the top level of `server/src/modules/products/products.service.ts` (outside the class, near `toPublicProduct`), add:

```typescript
/** Cheapest variant price (for products.priceStotinki sync + "от X"), or null. */
export function cheapestVariantPrice(variants: { priceStotinki: number }[]): number | null {
  if (!variants.length) return null;
  return variants.reduce((min, v) => (v.priceStotinki < min ? v.priceStotinki : min), variants[0].priceStotinki);
}

export interface VariantInput {
  id?: string;
  label: string;
  priceStotinki: number;
  stockQuantity?: number | null;
}

/** Diff incoming variants against the product's existing variant ids. `position`
 *  is the array index (the order the farmer arranged them). Rows with an id →
 *  updates; without → inserts; existing ids absent from the incoming list →
 *  soft-delete. */
export function planVariantWrites(incoming: VariantInput[], existingIds: string[]) {
  const inserts: { label: string; priceStotinki: number; stockQuantity?: number | null; position: number }[] = [];
  const updates: { id: string; label: string; priceStotinki: number; stockQuantity?: number | null; position: number }[] = [];
  const keptIds = new Set<string>();
  incoming.forEach((v, position) => {
    if (v.id) {
      keptIds.add(v.id);
      updates.push({ id: v.id, label: v.label, priceStotinki: v.priceStotinki, ...(v.stockQuantity !== undefined ? { stockQuantity: v.stockQuantity } : {}), position });
    } else {
      inserts.push({ label: v.label, priceStotinki: v.priceStotinki, ...(v.stockQuantity !== undefined ? { stockQuantity: v.stockQuantity } : {}), position });
    }
  });
  const deleteIds = existingIds.filter((id) => !keptIds.has(id));
  return { inserts, updates, deleteIds };
}
```

> Note: the test expects `stockQuantity` present only when supplied. For the `v1` case it IS supplied (5); for the insert it is not, so it's omitted. The spread guards match that.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx jest products.promo-variants.spec -c ./package.json`
Expected: PASS.

- [ ] **Step 5: Wire variant persistence into create() and update()**

In `products.service.ts`, add `productVariants` to the `@fermeribg/db` import, and `isNull` to the `drizzle-orm` import. Add a private method to `ProductsService`:

```typescript
  /** Persist the product's variants (full replace) and sync the cheapest price.
   *  Runs after the products row is written. No-op when `variants` is undefined
   *  (caller didn't touch them). */
  private async syncVariants(
    tenantId: string,
    productId: string,
    variants: VariantInput[] | undefined,
  ): Promise<void> {
    if (variants === undefined) return;
    const existing = await this.db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt)));
    const { inserts, updates, deleteIds } = planVariantWrites(variants, existing.map((r) => r.id));
    for (const ins of inserts) {
      await this.db.insert(productVariants).values({ ...ins, productId });
    }
    for (const upd of updates) {
      const { id, ...set } = upd;
      await this.db
        .update(productVariants)
        .set(set)
        .where(and(eq(productVariants.id, id), eq(productVariants.productId, productId)));
    }
    if (deleteIds.length) {
      await this.db
        .update(productVariants)
        .set({ deletedAt: new Date() })
        .where(and(eq(productVariants.productId, productId), inArray(productVariants.id, deleteIds)));
    }
    // Keep products.priceStotinki = cheapest variant (for sort + "от X"); leave it
    // untouched when the product has no variants.
    const cheapest = cheapestVariantPrice(variants);
    if (cheapest != null) {
      await this.db
        .update(products)
        .set({ priceStotinki: cheapest })
        .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)));
    }
  }
```

In `create()`, destructure `variants` out of the dto alongside `stock`, and call `syncVariants` after the row insert (before `cache.invalidate`):

```typescript
    const { stock, variants, ...productDto } = dto;
    // ... existing insert ...
    if (typeof stock === 'number') {
      await this.availability.setProductStock(tenantId, row.id, stock);
    }
    await this.syncVariants(tenantId, row.id, variants);
    await this.cache.invalidate(tenantId);
    return row;
```

In `update()`, destructure `variants` out alongside `stock`, and call `syncVariants` after the row update (before `cache.invalidate`):

```typescript
    const { stock, variants, ...rest } = dto;
    // ... existing update ...
    if (stock !== undefined) {
      await this.availability.setProductStock(tenantId, id, stock);
    }
    await this.syncVariants(tenantId, id, variants);
    await this.cache.invalidate(tenantId);
    return row;
```

(`salePercent`/`saleEndsAt` are real products columns — they flow through the existing `...productDto` / `...rest` spread into the row write automatically. `saleEndsAt` arrives as an ISO string; Drizzle's `timestamp` column accepts a `Date`. Convert in the spread: see Step 6.)

- [ ] **Step 6: Coerce saleEndsAt string → Date before the row write**

In both `create()` and `update()`, after destructuring, normalize the date so Drizzle stores a timestamp. Add right before the insert/update `.values`/`.set`:

```typescript
    // saleEndsAt comes from JSON as an ISO string (or null); the timestamp column
    // wants a Date. undefined = untouched.
    if (typeof (productDto as { saleEndsAt?: unknown }).saleEndsAt === 'string') {
      (productDto as { saleEndsAt?: Date }).saleEndsAt = new Date((productDto as { saleEndsAt: string }).saleEndsAt);
    }
```

(Use `rest` instead of `productDto` inside `update()`.)

- [ ] **Step 7: Run the full products test suite**

Run: `cd server && npx jest products -c ./package.json`
Expected: PASS — existing `products.stock.spec` / `products.farmer-scope.spec` still green, new spec green.

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/products/products.service.ts server/src/modules/products/products.promo-variants.spec.ts
git commit -m "feat(products): persist variants (upsert+soft-delete) + sync cheapest price + promo date coerce"
```

---

## Task 5: Public shape — promo + variants (TDD)

**Files:**
- Modify: `packages/types/src/index.ts`
- Modify: `server/src/modules/products/products.service.ts`
- Test: `server/src/modules/products/products.promo-variants.spec.ts` (append)

- [ ] **Step 1: Extend the public types**

In `packages/types/src/index.ts`, replace the `PublicProduct` type with:

```typescript
/** A variant as exposed to the storefront. Raw stock count is NOT leaked (mirrors
 *  product stockQuantity being stripped) — only `soldOut` + the prices. */
export type PublicProductVariant = {
  id: string;
  label: string;
  priceStotinki: number;
  /** Discounted price when a promo is active; absent otherwise. */
  salePriceStotinki?: number;
  soldOut: boolean;
};

/**
 * Public storefront shape: tenant_id + private fields stripped. `salePriceStotinki`
 * is the server-computed discounted headline price (present only while a promo is
 * active). `variants` is empty for products sold without variants.
 */
export type PublicProduct = Omit<
  Product,
  'tenantId' | 'stockQuantity' | 'stripeProductId' | 'stripePriceId' | 'deletedAt'
> & {
  images: string[];
  salePriceStotinki?: number;
  variants: PublicProductVariant[];
};
```

- [ ] **Step 2: Write the failing test for the public mapper**

Append to `server/src/modules/products/products.promo-variants.spec.ts`:

```typescript
import { buildPublicProduct } from './products.service';

const baseProduct = {
  id: 'p1', tenantId: 't1', name: 'Мед', slug: 'med', description: null,
  priceStotinki: 650, unit: 'бр', weight: null, category: null, tint: null,
  stockQuantity: 0, isActive: true, imageUrl: null, coverCrop: null,
  farmerId: null, subcategoryId: null, stripeProductId: null, stripePriceId: null,
  bundleItems: null, compareAtPriceStotinki: null, featured: false, position: 0,
  deletedAt: null, createdAt: new Date(), salePercent: null, saleEndsAt: null,
} as any;
const NOW2 = new Date('2026-06-26T10:00:00Z');

describe('buildPublicProduct', () => {
  it('strips private fields and defaults variants to []', () => {
    const pub = buildPublicProduct(baseProduct, [], [], NOW2);
    expect(pub).not.toHaveProperty('tenantId');
    expect(pub).not.toHaveProperty('stockQuantity');
    expect(pub.variants).toEqual([]);
    expect(pub.salePriceStotinki).toBeUndefined();
  });

  it('adds discounted prices to base + each variant when promo active', () => {
    const variants = [
      { id: 'v1', label: '500г', priceStotinki: 650, stockQuantity: 3 },
      { id: 'v2', label: '1кг', priceStotinki: 1250, stockQuantity: 0 },
    ] as any;
    const pub = buildPublicProduct({ ...baseProduct, salePercent: 20 }, [], variants, NOW2);
    expect(pub.salePriceStotinki).toBe(520);
    expect(pub.variants[0]).toEqual({ id: 'v1', label: '500г', priceStotinki: 650, salePriceStotinki: 520, soldOut: false });
    expect(pub.variants[1]).toEqual({ id: 'v2', label: '1кг', priceStotinki: 1250, salePriceStotinki: 1000, soldOut: true });
  });

  it('omits sale prices when promo expired', () => {
    const pub = buildPublicProduct({ ...baseProduct, salePercent: 20, saleEndsAt: new Date('2026-06-01') }, [], [], NOW2);
    expect(pub.salePriceStotinki).toBeUndefined();
  });
});
```

- [ ] **Step 2b: Run it to verify failure**

Run: `cd server && npx jest products.promo-variants.spec -c ./package.json`
Expected: FAIL — `buildPublicProduct is not exported`.

- [ ] **Step 3: Replace toPublicProduct with buildPublicProduct**

In `products.service.ts`, replace the existing `toPublicProduct` function with:

```typescript
import { isPromoActive, salePriceStotinki } from './promo.util';
import type { ProductVariant, PublicProduct, PublicProductVariant } from '@fermeribg/types';

/** Map a product row (+ its media + live variants) to the public storefront shape,
 *  applying the active promo to the base price and every variant. */
export function buildPublicProduct(
  p: Product,
  mediaUrls: string[],
  variants: ProductVariant[],
  now: Date,
): PublicProduct {
  const { tenantId, stockQuantity, stripeProductId, stripePriceId, ...rest } = p;
  const images = mediaUrls.length ? mediaUrls : p.imageUrl ? [p.imageUrl] : [];
  const promo = isPromoActive(p.salePercent, p.saleEndsAt, now) && p.salePercent != null;
  const pub: PublicProduct = {
    ...rest,
    images,
    variants: variants.map((v): PublicProductVariant => ({
      id: v.id,
      label: v.label,
      priceStotinki: v.priceStotinki,
      ...(promo ? { salePriceStotinki: salePriceStotinki(v.priceStotinki, p.salePercent!) } : {}),
      soldOut: v.stockQuantity === 0,
    })),
  };
  if (promo) pub.salePriceStotinki = salePriceStotinki(p.priceStotinki, p.salePercent!);
  return pub;
}
```

- [ ] **Step 4: Load variants in findPublicBySlug and pass them through**

In `findPublicBySlug`, after building `mediaByProduct`, add a variants batch load and use the new mapper. Add a private helper mirroring `mediaUrlsByProduct`:

```typescript
  /** Live (non-deleted) variants for a set of products, grouped by productId,
   *  ordered by position. */
  private async variantsByProduct(productIds: string[]): Promise<Map<string, ProductVariant[]>> {
    const map = new Map<string, ProductVariant[]>();
    if (!productIds.length) return map;
    const rows = await this.db
      .select()
      .from(productVariants)
      .where(and(inArray(productVariants.productId, productIds), isNull(productVariants.deletedAt)))
      .orderBy(asc(productVariants.position), asc(productVariants.id));
    for (const r of rows) {
      const list = map.get(r.productId) ?? [];
      list.push(r);
      map.set(r.productId, list);
    }
    return map;
  }
```

Then in `findPublicBySlug` replace the `result` line:

```typescript
    const mediaByProduct = await this.mediaUrlsByProduct(rows.map((r) => r.id));
    const varsByProduct = await this.variantsByProduct(rows.map((r) => r.id));
    const now = new Date();
    const result = rows.map((p) =>
      buildPublicProduct(p, mediaByProduct.get(p.id) ?? [], varsByProduct.get(p.id) ?? [], now),
    );
```

> `findPublicProductBySlug` calls `findPublicBySlug` and filters, so it inherits variants/promo with no change.

- [ ] **Step 5: Run the products suite + typecheck**

Run: `cd server && npx jest products -c ./package.json && npx tsc --noEmit`
Expected: PASS + no type errors. (Rebuild types first if the import fails: `cd packages/types && pnpm build`.)

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/index.ts server/src/modules/products/products.service.ts server/src/modules/products/products.promo-variants.spec.ts
git commit -m "feat(products): public shape exposes variants + server-computed sale prices"
```

---

## Task 6: GET /products/:id/variants (admin edit prefill)

**Files:**
- Modify: `server/src/modules/products/products.service.ts`
- Modify: `server/src/modules/products/products.controller.ts`

- [ ] **Step 1: Add listVariants to the service**

In `ProductsService`, add (it reuses `findOne` for the tenant + farmer-scope ownership check):

```typescript
  /** A product's live variants for the admin edit form (ordered). Enforces tenant
   *  + farmer scope via findOne. */
  async listVariants(id: string, tenantId: string, farmerScope: string | null = null): Promise<ProductVariant[]> {
    await this.findOne(id, tenantId, farmerScope);
    return this.db
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.productId, id), isNull(productVariants.deletedAt)))
      .orderBy(asc(productVariants.position), asc(productVariants.id));
  }
```

- [ ] **Step 2: Add the controller route**

In `products.controller.ts` `ProductsController`, add (place it with the other `:id/...` routes, e.g. next to `:id/media`):

```typescript
  @Get(':id/variants')
  @Roles('admin', 'farmer')
  listVariants(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.productsService.listVariants(id, tenantId, scope);
  }
```

- [ ] **Step 3: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/products/products.service.ts server/src/modules/products/products.controller.ts
git commit -m "feat(products): GET /products/:id/variants for edit prefill"
```

---

## Task 7: Orders — variant capture, stock decrement, promo price (TDD)

**Files:**
- Modify: `server/src/modules/orders/dto/create-order-item.dto.ts`
- Modify: `server/src/modules/orders/orders.service.ts`
- Test: `server/src/modules/orders/order-variant-pricing.spec.ts` (create)

- [ ] **Step 1: Add variantId to the order-item DTO**

In `create-order-item.dto.ts`, add `IsOptional, IsUUID` to imports and this field:

```typescript
  @ApiPropertyOptional({ description: 'Chosen variant (required when the product has variants)' })
  @IsOptional()
  @IsUUID()
  variantId?: string;
```

(Add `ApiPropertyOptional` to the `@nestjs/swagger` import.)

- [ ] **Step 2: Write the failing test for the pure line-pricing helper**

Create `server/src/modules/orders/order-variant-pricing.spec.ts`:

```typescript
import { resolveLineUnit } from './orders.service';

const NOW = new Date('2026-06-26T10:00:00Z');
const product = { priceStotinki: 1000, name: 'Мед', weight: '1кг', salePercent: null, saleEndsAt: null } as any;

describe('resolveLineUnit', () => {
  it('uses product price + name when no variant', () => {
    expect(resolveLineUnit(product, null, NOW)).toEqual({
      unitStotinki: 1000,
      label: 'Мед 1кг',
      variantId: null,
      variantLabel: null,
    });
  });

  it('uses the variant price + label when a variant is given', () => {
    const variant = { id: 'v1', label: 'Кристализиран 500г', priceStotinki: 650, stockQuantity: 5 } as any;
    expect(resolveLineUnit(product, variant, NOW)).toEqual({
      unitStotinki: 650,
      label: 'Кристализиран 500г',
      variantId: 'v1',
      variantLabel: 'Кристализиран 500г',
    });
  });

  it('applies an active promo to the variant price', () => {
    const variant = { id: 'v1', label: '500г', priceStotinki: 650, stockQuantity: 5 } as any;
    const res = resolveLineUnit({ ...product, salePercent: 20 }, variant, NOW);
    expect(res.unitStotinki).toBe(520);
  });
});
```

- [ ] **Step 3: Run it to verify failure**

Run: `cd server && npx jest order-variant-pricing.spec -c ./package.json`
Expected: FAIL — `resolveLineUnit is not exported`.

- [ ] **Step 4: Add the pure helper to orders.service.ts**

At the top level of `orders.service.ts` (outside the class), add:

```typescript
import { effectivePriceStotinki } from '../products/promo.util';
import type { Product, ProductVariant } from '@fermeribg/types';

/** Resolve one order line's unit price + display label, applying the product's
 *  active promo. When a variant is chosen the variant price/label win; otherwise
 *  the product's price and "name + weight" snapshot are used. Pure (now passed in). */
export function resolveLineUnit(
  product: Pick<Product, 'priceStotinki' | 'name' | 'weight' | 'salePercent' | 'saleEndsAt'>,
  variant: Pick<ProductVariant, 'id' | 'label' | 'priceStotinki'> | null,
  now: Date,
): { unitStotinki: number; label: string; variantId: string | null; variantLabel: string | null } {
  const base = variant ? variant.priceStotinki : product.priceStotinki;
  const unitStotinki = effectivePriceStotinki(base, product.salePercent, product.saleEndsAt, now);
  return variant
    ? { unitStotinki, label: variant.label, variantId: variant.id, variantLabel: variant.label }
    : {
        unitStotinki,
        label: [product.name, product.weight].filter(Boolean).join(' '),
        variantId: null,
        variantLabel: null,
      };
}
```

- [ ] **Step 5: Run it to verify pass**

Run: `cd server && npx jest order-variant-pricing.spec -c ./package.json`
Expected: PASS.

- [ ] **Step 6: Wire variants into the intake transaction**

In `orders.service.ts` `create()`, inside the `this.db.transaction(async (tx) => {` block:

(a) After building `byId` (the product map), load + lock the chosen variants:

```typescript
    // Variants the order references; lock them (ordered by id → deadlock-free) so
    // concurrent intakes serialize on per-variant stock, mirroring the slot/window
    // guards above.
    const variantIds = dto.items.map((i) => i.variantId).filter((v): v is string => !!v);
    const variantRows = variantIds.length
      ? await tx
          .select()
          .from(productVariants)
          .where(and(inArray(productVariants.id, variantIds), isNull(productVariants.deletedAt)))
          .for('update')
          .orderBy(asc(productVariants.id))
      : [];
    const variantById = new Map(variantRows.map((v) => [v.id, v]));
```

(b) Determine which ordered products have live variants (independent existence check — NOT derived from the chosen `variantRows`, since a line that omits its variantId wouldn't appear there), then replace the product-validity loop so it requires a selection for varianted products AND validates that a supplied variant belongs to the product:

```typescript
    const orderedIds = dto.items.map((i) => i.productId);
    const productsWithVariants = new Set(
      (
        await tx
          .select({ pid: productVariants.productId })
          .from(productVariants)
          .where(and(inArray(productVariants.productId, orderedIds), isNull(productVariants.deletedAt)))
      ).map((r) => r.pid),
    );
    for (const it of dto.items) {
      const p = byId.get(it.productId);
      if (!p || !p.isActive) throw new BadRequestException('Невалиден или неактивен продукт');
      if (productsWithVariants.has(it.productId) && !it.variantId) {
        throw new BadRequestException('Изберете вариант');
      }
      if (it.variantId) {
        const v = variantById.get(it.variantId);
        if (!v || v.productId !== it.productId) throw new BadRequestException('Невалиден вариант');
      }
    }
```

(c) After the availability-window decrement block, add a variant stock decrement that mirrors it (uses the same pure `decideDecrement` — `stockQuantity == null` means unlimited):

```typescript
    // Per-variant stock. null stockQuantity = unlimited (no check). Mutate the
    // locked row in memory so repeated lines for the same variant chain decrements.
    for (const it of dto.items) {
      if (!it.variantId) continue;
      const v = variantById.get(it.variantId)!;
      const active = v.stockQuantity == null ? null : { remaining: v.stockQuantity };
      const decision = decideDecrement(active, it.quantity);
      if (!decision.ok) throw new ConflictException(`Няма достатъчна наличност: ${v.label}`);
      if (v.stockQuantity != null && decision.newRemaining != null) v.stockQuantity = decision.newRemaining;
    }
    for (const v of variantRows) {
      if (v.stockQuantity != null) {
        await tx.update(productVariants).set({ stockQuantity: v.stockQuantity }).where(eq(productVariants.id, v.id));
      }
    }
```

(d) Replace the `total` / `items` mapping block with one that uses `resolveLineUnit`:

```typescript
    // Promo expiry is coarse (date-level), so a plain wall-clock Date is correct.
    const now = new Date();
    let total = 0;
    const items = dto.items.map((it) => {
      const p = byId.get(it.productId)!;
      const variant = it.variantId ? variantById.get(it.variantId)! : null;
      const line = resolveLineUnit(p, variant, now);
      total += line.unitStotinki * it.quantity;
      return {
        productId: p.id,
        productName: line.label,
        quantity: it.quantity,
        priceStotinki: line.unitStotinki,
        variantId: line.variantId,
        variantLabel: line.variantLabel,
      };
    });
```

(e) Ensure `productVariants` is imported from `@fermeribg/db` and `isNull` from `drizzle-orm` at the top of the file.

- [ ] **Step 7: Run the orders suite**

Run: `cd server && npx jest orders -c ./package.json && npx jest order-variant-pricing -c ./package.json`
Expected: PASS — existing order tests still green, new pricing test green.

- [ ] **Step 8: Full server typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add server/src/modules/orders/dto/create-order-item.dto.ts server/src/modules/orders/orders.service.ts server/src/modules/orders/order-variant-pricing.spec.ts
git commit -m "feat(orders): capture variant + decrement variant stock + apply promo to line price"
```

---

## Task 8: Daily expire-promotions cron (TDD)

**Files:**
- Modify: `server/src/common/queue/queue.constants.ts`
- Modify: `server/src/modules/products/products.service.ts`
- Create: `server/src/modules/products/products.processor.ts`
- Modify: `server/src/modules/products/products.module.ts`
- Test: `server/src/modules/products/products.processor.spec.ts`

- [ ] **Step 1: Add the queue constant**

In `server/src/common/queue/queue.constants.ts`, add:

```typescript
export const PRODUCTS_QUEUE = 'products';
```

- [ ] **Step 2: Add expirePromotions to the service**

In `ProductsService`, add (`lt` from `drizzle-orm`):

```typescript
  /** Null out promos whose end date has passed so they disappear from the admin
   *  UI. Pricing already ignores them (date check), so this is tidiness only.
   *  Returns the number of products cleared. */
  async expirePromotions(now: Date = new Date()): Promise<number> {
    const rows = await this.db
      .update(products)
      .set({ salePercent: null, saleEndsAt: null })
      .where(and(isNotNull(products.saleEndsAt), lt(products.saleEndsAt, now)))
      .returning({ id: products.id });
    return rows.length;
  }
```

(Add `isNotNull`, `lt` to the `drizzle-orm` import.)

- [ ] **Step 3: Write the failing processor test**

Create `server/src/modules/products/products.processor.spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { getQueueToken } from '@nestjs/bullmq';
import { ProductsProcessor } from './products.processor';
import { ProductsService } from './products.service';
import { PRODUCTS_QUEUE } from '../../common/queue/queue.constants';

const makeQueue = () => ({ add: jest.fn().mockResolvedValue(undefined) });

async function build(svc: any, queue: any): Promise<ProductsProcessor> {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      ProductsProcessor,
      { provide: ProductsService, useValue: svc },
      { provide: getQueueToken(PRODUCTS_QUEUE), useValue: queue },
    ],
  }).compile();
  return mod.get(ProductsProcessor);
}

describe('ProductsProcessor', () => {
  it('process() expires promotions', async () => {
    const svc = { expirePromotions: jest.fn().mockResolvedValue(2) };
    const proc = await build(svc, makeQueue());
    await proc.process({ name: 'expire-promotions' } as Job);
    expect(svc.expirePromotions).toHaveBeenCalled();
  });

  it('onModuleInit registers the 01:00 Europe/Sofia repeatable', async () => {
    const queue = makeQueue();
    const proc = await build({ expirePromotions: jest.fn() }, queue);
    await proc.onModuleInit();
    expect(queue.add).toHaveBeenCalledWith(
      'expire-promotions',
      {},
      expect.objectContaining({ repeat: { pattern: '0 1 * * *', tz: 'Europe/Sofia' } }),
    );
  });
});
```

- [ ] **Step 4: Run it to verify failure**

Run: `cd server && npx jest products.processor.spec -c ./package.json`
Expected: FAIL — `Cannot find module './products.processor'`.

- [ ] **Step 5: Create the processor**

Create `server/src/modules/products/products.processor.ts`:

```typescript
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { ProductsService } from './products.service';
import { PRODUCTS_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

@Processor(PRODUCTS_QUEUE)
export class ProductsProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(ProductsProcessor.name);

  constructor(
    private readonly products: ProductsService,
    @InjectQueue(PRODUCTS_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await registerRepeatable(this.queue, 'expire-promotions', '0 1 * * *');
  }

  async process(_job: Job): Promise<void> {
    try {
      const n = await this.products.expirePromotions();
      if (n) this.logger.log(`[products] expired ${n} promotion(s)`);
    } catch (err) {
      this.logger.error(`[products] expire-promotions failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
}
```

- [ ] **Step 6: Register the queue + processor in products.module.ts**

In `server/src/modules/products/products.module.ts`, add the imports and wiring (mirror billing.module.ts):

```typescript
import { BullModule } from '@nestjs/bullmq';
import { PRODUCTS_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';
import { ProductsProcessor } from './products.processor';
```

Add to the module's `imports` array:

```typescript
    BullModule.registerQueue({
      name: PRODUCTS_QUEUE,
      defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: 200 },
    }),
```

Add to the `providers` array (alongside the existing providers):

```typescript
    ...(RUN_WORKERS ? [ProductsProcessor] : []),
```

- [ ] **Step 7: Run the processor test + typecheck**

Run: `cd server && npx jest products.processor.spec -c ./package.json && npx tsc --noEmit`
Expected: PASS + no type errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/common/queue/queue.constants.ts server/src/modules/products/products.service.ts server/src/modules/products/products.processor.ts server/src/modules/products/products.processor.spec.ts server/src/modules/products/products.module.ts
git commit -m "feat(products): daily cron nulls expired promotions (admin tidiness)"
```

---

## Task 9: Client types + api-client

**Files:**
- Modify: `client/src/lib/types.ts`
- Modify: `client/src/lib/api-client.ts`

- [ ] **Step 1: Add promo fields + variant type to client types**

In `client/src/lib/types.ts`, add to the `Product` interface (after `position`):

```typescript
  /** Promotion: discount percent (1..99) or null. */
  salePercent: number | null;
  /** Promotion end date (ISO) or null = no end. */
  saleEndsAt: string | null;
```

Add a new exported interface:

```typescript
/** A product variant (вид/грамаж) as edited in the panel. */
export interface ProductVariant {
  id: string;
  label: string;
  priceStotinki: number;
  /** null = unlimited stock. */
  stockQuantity: number | null;
  position: number;
}
```

- [ ] **Step 2: Add the variants fetch + extend ProductWrite**

In `client/src/lib/api-client.ts`, update `ProductWrite` and add the fetch. Import `ProductVariant` from `@/lib/types`:

```typescript
/** A variant the dialog sends on save (id present = update existing, absent = create). */
export type VariantWrite = { id?: string; label: string; priceStotinki: number; stockQuantity?: number | null };

export type ProductWrite = Partial<Product> & {
  stock?: number | null;
  salePercent?: number | null;
  saleEndsAt?: string | null;
  variants?: VariantWrite[];
};

export const listProductVariants = (productId: string) =>
  apiFetch<ProductVariant[]>(`products/${productId}/variants`, {}, 'Неуспешно зареждане на варианти');
```

- [ ] **Step 3: Typecheck the client**

Run: `cd client && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/api-client.ts
git commit -m "feat(web): product promo fields + ProductVariant type + listProductVariants"
```

---

## Task 10: Product dialog — Variants section

**Files:**
- Modify: `client/src/components/products/product-dialog.tsx`

> No client unit-test runner exists — verify via `tsc`, `lint`, `build`, and the preview workflow.

- [ ] **Step 1: Add variant state + load-on-edit**

In `product-dialog.tsx`, import the helpers and add state. Add to imports:

```typescript
import { Collapsible } from '@/components/delivery/ui';
import { Plus, Trash2 } from 'lucide-react';
import { listProductVariants, type VariantWrite } from '@/lib/api-client';
```

(Trash2 is already imported — keep one import. Add `Plus`.)

Add state near the other `useState` calls. A variant row in the form keeps prices as comma-strings (like the main price field):

```typescript
  type VRow = { id?: string; label: string; price: string; stock: string };
  const [hasVariants, setHasVariants] = useState(false);
  const [variants, setVariants] = useState<VRow[]>([]);
```

Add an effect to load variants in edit mode (mirrors the stock-prefill effect):

```typescript
  useEffect(() => {
    if (!isEdit || !product) return;
    let alive = true;
    listProductVariants(product.id)
      .then((rows) => {
        if (!alive) return;
        if (rows.length) {
          setHasVariants(true);
          setVariants(
            rows.map((v) => ({
              id: v.id,
              label: v.label,
              price: (v.priceStotinki / 100).toFixed(2).replace('.', ','),
              stock: v.stockQuantity == null ? '' : String(v.stockQuantity),
            })),
          );
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isEdit, product]);
```

- [ ] **Step 2: Render the Variants section**

Add this just before the closing `{err && ...}` block in the form (i.e. at the bottom, after the farmer/subcat selects):

```tsx
          <Collapsible
            title="Варианти (вид/грамаж)"
            hint="Един продукт с няколко цени — напр. мед: кристализиран/течен, или мляко в 3 разфасовки. Една снимка, отделна цена и наличност за всеки."
            defaultOpen={hasVariants}
          >
            <label className="flex items-center gap-2 text-[13px] font-semibold text-ff-ink">
              <input type="checkbox" checked={hasVariants} onChange={(e) => setHasVariants(e.target.checked)} />
              Този продукт има варианти
            </label>
            {hasVariants && (
              <div className="mt-3 flex flex-col gap-2">
                {variants.map((v, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      value={v.label}
                      onChange={(e) => setVariants((p) => p.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))}
                      placeholder="Кристализиран 500 г"
                      className={`${field} flex-[2]`}
                    />
                    <input
                      value={v.price}
                      onChange={(e) => setVariants((p) => p.map((r, j) => (j === i ? { ...r, price: e.target.value } : r)))}
                      inputMode="decimal"
                      placeholder="6,50 €"
                      className={`${field} flex-1`}
                    />
                    <input
                      value={v.stock}
                      onChange={(e) => setVariants((p) => p.map((r, j) => (j === i ? { ...r, stock: e.target.value.replace(/[^0-9]/g, '') } : r)))}
                      inputMode="numeric"
                      placeholder="бр"
                      className={`${field} w-16`}
                    />
                    <button
                      type="button"
                      onClick={() => setVariants((p) => p.filter((_, j) => j !== i))}
                      aria-label="Премахни вариант"
                      className="grid w-9 shrink-0 place-items-center rounded-sm text-ff-red hover:bg-ff-surface-2"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setVariants((p) => [...p, { label: '', price: '', stock: '' }])}
                  className="inline-flex items-center gap-1.5 self-start text-[12.5px] font-semibold text-ff-green-700 hover:underline"
                >
                  <Plus size={14} /> Добави вариант
                </button>
                <span className="text-[11.5px] text-ff-muted">Наличност празна = неограничено. Цената на продукта става най-евтиния вариант.</span>
              </div>
            )}
          </Collapsible>
```

- [ ] **Step 3: Hide the single price + stock fields when variants are on**

Wrap the existing "Цена (€)" label, the "Наличност" label, and the "Задай наличност на много продукти" link in `{!hasVariants && ( ... )}` so they disappear when variants drive price/stock.

- [ ] **Step 4: Verify (typecheck + lint)**

Run: `cd client && npx tsc --noEmit && npm run lint`
Expected: no errors. (Submit wiring comes in Task 12 — `variants` state is unused-but-declared until then; if lint flags it, proceed to Task 12 in the same session before the lint gate.)

- [ ] **Step 5: Commit**

```bash
git add client/src/components/products/product-dialog.tsx
git commit -m "feat(web): variants section in product dialog (add/remove rows, hide single price)"
```

---

## Task 11: Product dialog — Promotion section + live preview

**Files:**
- Modify: `client/src/components/products/product-dialog.tsx`

- [ ] **Step 1: Add promo state + edit prefill**

Add state:

```typescript
  const [salePercent, setSalePercent] = useState(product?.salePercent ? String(product.salePercent) : '');
  // saleEndsAt is an ISO datetime; the <input type="date"> wants YYYY-MM-DD.
  const [saleEndsAt, setSaleEndsAt] = useState(product?.saleEndsAt ? product.saleEndsAt.slice(0, 10) : '');
```

- [ ] **Step 2: Render the Promotion section with a live preview**

Add another `<Collapsible>` right after the Variants one:

```tsx
          <Collapsible
            title="Промоция"
            hint="Намали цената с процент за определен срок. След срока промоцията пада автоматично. Без срок — маха се ръчно."
            defaultOpen={!!product?.salePercent}
          >
            <div className="grid grid-cols-2 gap-3">
              <label className={labelCls}>
                Отстъпка (%)
                <input
                  value={salePercent}
                  onChange={(e) => setSalePercent(e.target.value.replace(/[^0-9]/g, '').slice(0, 2))}
                  inputMode="numeric"
                  placeholder="напр. 20"
                  className={field}
                />
              </label>
              <label className={labelCls}>
                Край (по избор)
                <input type="date" value={saleEndsAt} onChange={(e) => setSaleEndsAt(e.target.value)} className={field} />
              </label>
            </div>
            {(() => {
              const pct = parseInt(salePercent, 10);
              const base = Math.round((parseFloat(price.replace(',', '.')) || 0) * 100);
              if (!pct || pct < 1 || pct > 99 || base <= 0) return null;
              const sale = Math.round((base * (100 - pct)) / 100);
              return (
                <p className="mt-2 text-[12.5px] text-ff-muted">
                  Преглед: <span className="line-through">{moneyFromStotinki(base)}</span>{' '}
                  <span className="font-bold text-ff-green-700">{moneyFromStotinki(sale)}</span>
                  {hasVariants ? ' · важи за всеки вариант' : ''}
                </p>
              );
            })()}
          </Collapsible>
```

Add `import { moneyFromStotinki } from '@/lib/utils';` to the imports.

- [ ] **Step 3: Verify (typecheck + lint)**

Run: `cd client && npx tsc --noEmit && npm run lint`
Expected: no errors (state still unused until Task 12 submit wiring — continue to Task 12).

- [ ] **Step 4: Commit**

```bash
git add client/src/components/products/product-dialog.tsx
git commit -m "feat(web): promotion section in product dialog with live price preview"
```

---

## Task 12: Product dialog — submit wiring

**Files:**
- Modify: `client/src/components/products/product-dialog.tsx`

- [ ] **Step 1: Build the variants + promo payload in submit()**

In the `submit` function, before the `await onSubmit(...)` call, add payload assembly:

```typescript
    // Variants → write payload (parse comma prices to stotinki; empty stock = unlimited).
    let variantPayload: VariantWrite[] | undefined;
    if (hasVariants) {
      const cleaned = variants.filter((v) => v.label.trim());
      if (!cleaned.length) {
        setErr('Добави поне един вариант или изключи вариантите');
        return;
      }
      variantPayload = cleaned.map((v) => ({
        ...(v.id ? { id: v.id } : {}),
        label: v.label.trim(),
        priceStotinki: Math.round((parseFloat(v.price.replace(',', '.')) || 0) * 100),
        stockQuantity: v.stock.trim() === '' ? null : parseInt(v.stock, 10),
      }));
      if (variantPayload.some((v) => v.priceStotinki <= 0)) {
        setErr('Всеки вариант трябва да има валидна цена');
        return;
      }
    } else {
      variantPayload = []; // explicit empty = remove any existing variants
    }
    const pct = salePercent.trim() === '' ? null : parseInt(salePercent, 10);
    const promoEnd = saleEndsAt.trim() === '' ? null : new Date(saleEndsAt).toISOString();
```

- [ ] **Step 2: Add the new fields to the onSubmit payload object**

In the object passed to `onSubmit`, add:

```typescript
          salePercent: pct,
          saleEndsAt: promoEnd,
          variants: variantPayload,
```

When `hasVariants` is true the single price field is hidden; guard the existing `priceStotinki <= 0` check so it only blocks for non-variant products:

```typescript
    if (!hasVariants && priceStotinki <= 0) {
      setErr('Въведи валидна цена');
      return;
    }
```

(When variants are on, send `priceStotinki` as the cheapest variant so the create call — which requires it — is satisfied; the server re-syncs it anyway:)

```typescript
    const effectivePrice = hasVariants && variantPayload && variantPayload.length
      ? Math.min(...variantPayload.map((v) => v.priceStotinki))
      : priceStotinki;
```

Use `priceStotinki: effectivePrice` in the payload.

- [ ] **Step 3: Verify the whole client builds**

Run: `cd client && npx tsc --noEmit && npm run lint && npm run build`
Expected: build succeeds, no type/lint errors.

- [ ] **Step 4: Manual preview check**

Start the app (preview workflow), open a product, toggle Варианти → add two rows with prices/stock → toggle Промоция → enter 20% → confirm the live preview shows struck + discounted. Save, reopen → confirm variants + promo reload. Confirm a product without variants still saves normally.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/products/product-dialog.tsx
git commit -m "feat(web): submit variants + promotion from product dialog"
```

---

## Task 13: Full verification pass

- [ ] **Step 1: Server tests + typecheck**

Run: `cd server && npm test && npx tsc --noEmit`
Expected: all suites green, no type errors.

- [ ] **Step 2: Client + packages build**

Run: `cd packages/db && pnpm build && cd ../types && pnpm build && cd ../../client && npx tsc --noEmit && npm run build`
Expected: all succeed.

- [ ] **Step 3: Commit any incidental fixes, then finish the branch**

Use the superpowers:finishing-a-development-branch skill to decide merge/PR.

---

## chaika storefront (separate repo — FOLLOW-UP, not in this plan)

After the API ships, update the chaika storefront repo:

1. **Types:** mirror the new `PublicProduct` fields (`salePriceStotinki`, `variants: {id,label,priceStotinki,salePriceStotinki?,soldOut}[]`).
2. **Product card:** when `variants.length`, show `от {min variant price}` (using the variant's `salePriceStotinki` when present); when `salePriceStotinki` is set (no variants), show the struck regular price + sale price.
3. **Product detail:** render a variant picker (buttons/segmented). Selecting a variant sets the displayed price (prefer `salePriceStotinki`), disables `soldOut` variants. Default to the first in-stock variant.
4. **Cart / add-to-cart:** each line carries `variantId` + label; the add-to-cart POST to `/public/:slug/orders` sends `variantId` per item.
5. **No price math in the browser** — render server-provided `priceStotinki` / `salePriceStotinki` only.
6. **Backward-compat:** products with no variants and no promo render exactly as today.

Verify against the live API (a varianted + promo'd product) before deploy.
```
