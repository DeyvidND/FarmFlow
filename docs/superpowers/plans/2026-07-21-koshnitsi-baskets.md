# Кошници (multi-farmer baskets) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an account owner build a fixed-price basket out of products from several farmers, sell it as one SKU on the storefront, and have the order explode into its member products so stock, prep and routing stay correct.

**Architecture:** Reuse the existing `category = 'bundle'` model (`productBundleItems`, `PUT /products/:id/bundle-items`, `bundleProducts[]` on the public catalog). Add four missing pieces: a create entry point in the panel, order explosion into child `order_items` rows carrying `bundle_parent_id`, `min`-over-members public availability, and a 2×2 member-image grid in the chaika storefront.

**Tech Stack:** NestJS + Drizzle/Postgres + Redis (server), Next.js App Router (client panel), Astro 5 SSR on Cloudflare Workers (chaika storefront). Jest for server tests, vitest (Node-only, no jsdom) for client.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-21-koshnitsi-baskets-design.md`. Read it before Task 1.
- Branch: `koshnitsi-baskets`, already created off `origin/main` @ `d65c9c4b`.
- **Migrations are hand-written.** Landed as `0112_order_item_bundle_parent`, journal `idx: 110` (Task 1 re-derived these: a concurrent branch had already taken 0111/idx109 by the time it ran). Always read the journal tail before writing a migration. A gap silently breaks the migrator.
- **Re-fetch `origin/main` immediately before pushing**, not just before merging. Another session may have taken the migration index this branch used (110); if so renumber in the filename, the header comment and the journal, inside the merge commit.
- Every server query is tenant-scoped. Never read or write across tenants.
- No `ANY()` in Drizzle — use `inArray`. `CASE…THEN` arms need explicit `::int` / `::uuid` casts.
- Baskets are **pickup / local delivery only** in v1.
- Products with variants may **not** be basket members.
- A basket carries no stock of its own; availability is `min` over members.
- Bulgarian UI copy is quoted verbatim in each task. Do not paraphrase it.
- Two repos: `C:\Users\Lenovo\source\repos\FarmFlow` (Tasks 1–7) and `C:\Users\Lenovo\source\repos\fermerski-pazar-chaika` (Tasks 8–9). Commit in each separately.
- Deploy backend first. chaika deploys separately to Cloudflare Workers, after the API is live.

## File Structure

**Created**
- `packages/db/drizzle/0111_order_item_bundle_parent.sql` — the migration.
- `server/src/modules/orders/order-bundle.util.ts` — pure basket-expansion helper.
- `server/src/modules/orders/order-bundle.util.spec.ts` — its unit tests.
- `server/src/modules/availability/bundle-availability.util.ts` — pure `min`-over-members helper.
- `server/src/modules/availability/bundle-availability.util.spec.ts` — its unit tests.
- `server/src/modules/orders/orders.bundle.spec.ts` — checkout explosion tests.

**Modified**
- `packages/db/src/schema.ts` — `orderItems.bundleParentId`.
- `packages/db/drizzle/meta/_journal.json` — one entry.
- `packages/types/src/index.ts` — `bundleParentId` on the order-item type.
- `server/src/modules/products/products.service.ts` — reject varianted basket members.
- `server/src/modules/orders/orders.service.ts` — expansion, courier block, child inserts.
- `server/src/modules/availability/availability.service.ts` — synthetic basket windows.
- `client/src/components/products/products-client.tsx` — „Създай кошница" button.
- `client/src/components/products/product-dialog.tsx` — basket mode.
- chaika `src/lib/catalog.ts`, `src/lib/icons.ts`, `src/components/ProductCard.astro`, `src/components/Gallery.astro`, `src/pages/product/[slug].astro`.

---

### Task 1: Migration, schema and type for `bundle_parent_id`

**Files:**
- Create: `packages/db/drizzle/0111_order_item_bundle_parent.sql`
- Modify: `packages/db/src/schema.ts:532-554` (the `orderItems` table)
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/types/src/index.ts` (the order-item type)

**Interfaces:**
- Consumes: nothing.
- Produces: `orderItems.bundleParentId` (Drizzle column, `uuid | null`) and `OrderItem.bundleParentId?: string | null` in `@fermeribg/types`. Tasks 4 and 7 rely on both names.

- [ ] **Step 1: Read the last journal entry so the new one matches its shape**

Run: `cat packages/db/drizzle/meta/_journal.json | tail -20`
Note the last entry's `idx`, `version`, `when` and `tag`. Confirm the last `idx` is `108` and the last tag is `0110_handover_signatures`. If it is not, stop and re-derive the next number — do not guess.

- [ ] **Step 2: Write the migration**

Create `packages/db/drizzle/0111_order_item_bundle_parent.sql`:

```sql
-- 0111 (journal idx 109) — basket order lines.
-- A „кошница" (products.category = 'bundle') explodes at checkout into one parent
-- line carrying the fixed basket price plus one zero-priced child line per member
-- product. Children point at the parent so prep, stock restore and the order view
-- can group them. CASCADE: dropping the basket line drops its children with it.
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS bundle_parent_id uuid REFERENCES order_items(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS order_items_bundle_parent_idx ON order_items (bundle_parent_id)
  WHERE bundle_parent_id IS NOT NULL;
```

`IF NOT EXISTS` on both statements, matching every recent sibling migration (`0110_manual_expenses.sql`, `0111_handover_signatures.sql`, `0082_audit_perf_indexes.sql`): a re-run or partially-applied environment must be safe.

- [ ] **Step 3: Add the journal entry**

Append to the `entries` array in `packages/db/drizzle/meta/_journal.json`, copying `version` from the previous entry and using a millisecond epoch for `when`:

```json
{
  "idx": 109,
  "version": "7",
  "when": 1784650000000,
  "tag": "0111_order_item_bundle_parent",
  "breakpoints": true
}
```

- [ ] **Step 4: Add the Drizzle column**

In `packages/db/src/schema.ts`, inside the `orderItems` column object, after `variantLabel`:

```ts
    // Basket („кошница") child line: points at the parent basket line in the same
    // order. NULL for every ordinary line. The parent carries the basket's fixed
    // price; children are priced 0 so the order total is unchanged, and exist so
    // prep lists, stock restore and per-product stats see the real products.
    bundleParentId: uuid('bundle_parent_id').references((): AnyPgColumn => orderItems.id, {
      onDelete: 'cascade',
    }),
```

The self-reference needs `AnyPgColumn`. Confirm it is imported at the top of the file:

Run: `rg -n "AnyPgColumn" packages/db/src/schema.ts | head -3`
If there is no hit, add `AnyPgColumn` to the existing `drizzle-orm/pg-core` import.

Then add the index inside the same table's index callback, beside `productIdx`. It must carry a `.where(...)` so the Drizzle definition matches the raw SQL's partial index — follow `stripePaymentIntentIdx` (`schema.ts:517-519`) and `tenantDeliveredIdx` (`schema.ts:526-528`):

```ts
    bundleParentIdx: index('order_items_bundle_parent_idx')
      .on(t.bundleParentId)
      .where(sql`${t.bundleParentId} is not null`),
```

- [ ] **Step 5: Add the shared type field**

Find the order-item type in `packages/types/src/index.ts`:

Run: `rg -n "variantLabel" packages/types/src/index.ts`

In the interface that has `variantLabel` alongside `productName` / `quantity` / `priceStotinki`, add:

```ts
  /** Set on a basket child line — the id of the parent basket line. */
  bundleParentId?: string | null;
```

- [ ] **Step 6: Build the packages and apply the migration**

Run: `pnpm --filter "./packages/*" build`
Expected: exits 0. (A fresh worktree fails 136 suites with TS2307 until this runs.)

Run: `pnpm db:migrate`
Expected: applies `0111_order_item_bundle_parent`, exits 0.

Verify the column landed:

Run: `docker compose exec -T postgres psql -U farmflow -d farmflow -c "\d order_items"`
Expected: a `bundle_parent_id | uuid` row in the output.

- [ ] **Step 7: Commit**

```bash
git add packages/db/drizzle/0111_order_item_bundle_parent.sql packages/db/drizzle/meta/_journal.json packages/db/src/schema.ts packages/types/src/index.ts
git commit -m "feat(baskets): add order_items.bundle_parent_id"
```

---

### Task 2: Pure basket-expansion helper

**Files:**
- Create: `server/src/modules/orders/order-bundle.util.ts`
- Test: `server/src/modules/orders/order-bundle.util.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `expandStockLines(lines, membersByBundle)` — Task 4 calls it to build the list the availability-window enforcement runs over.

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/orders/order-bundle.util.spec.ts`:

```ts
import { expandStockLines } from './order-bundle.util';

describe('expandStockLines', () => {
  it('passes ordinary lines through unchanged', () => {
    const out = expandStockLines([{ productId: 'p1', quantity: 2 }], new Map());
    expect(out).toEqual([{ productId: 'p1', quantity: 2 }]);
  });

  it('replaces a basket with its members, multiplied by the line quantity', () => {
    const members = new Map([
      ['b1', [
        { productId: 'p1', quantity: 2 },
        { productId: 'p2', quantity: 1 },
      ]],
    ]);
    const out = expandStockLines([{ productId: 'b1', quantity: 3 }], members);
    expect(out).toEqual([
      { productId: 'p1', quantity: 6 },
      { productId: 'p2', quantity: 3 },
    ]);
  });

  it('never charges stock to the basket product itself', () => {
    const members = new Map([['b1', [{ productId: 'p1', quantity: 1 }]]]);
    const out = expandStockLines([{ productId: 'b1', quantity: 1 }], members);
    expect(out.map((l) => l.productId)).not.toContain('b1');
  });

  it('merges a product ordered both loose and inside a basket', () => {
    const members = new Map([['b1', [{ productId: 'p1', quantity: 2 }]]]);
    const out = expandStockLines(
      [
        { productId: 'p1', quantity: 1 },
        { productId: 'b1', quantity: 2 },
      ],
      members,
    );
    expect(out).toEqual([{ productId: 'p1', quantity: 5 }]);
  });

  it('keeps first-seen order so the caller stays deterministic', () => {
    const members = new Map([['b1', [{ productId: 'p2', quantity: 1 }]]]);
    const out = expandStockLines(
      [
        { productId: 'p1', quantity: 1 },
        { productId: 'b1', quantity: 1 },
        { productId: 'p3', quantity: 1 },
      ],
      members,
    );
    expect(out.map((l) => l.productId)).toEqual(['p1', 'p2', 'p3']);
  });

  it('contributes nothing for a basket with no members', () => {
    const out = expandStockLines([{ productId: 'b1', quantity: 1 }], new Map([['b1', []]]));
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- order-bundle.util`
Expected: FAIL — `Cannot find module './order-bundle.util'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/modules/orders/order-bundle.util.ts`:

```ts
/** One member of a basket („кошница"): a product and how many go in per basket. */
export interface BundleMemberLine {
  productId: string;
  quantity: number;
}

/**
 * Turn ordered cart lines into the list that availability-window enforcement runs
 * over. A basket product carries no stock of its own — it is replaced by its member
 * products at `member.quantity × line.quantity`, so member stock is what actually
 * gates the sale.
 *
 * Quantities for the same product are merged (first-seen order preserved) so a
 * shopper who orders tomatoes loose AND a basket containing tomatoes is checked
 * once against the true demand, and gets one clear error instead of two.
 *
 * `membersByBundle` must contain an entry for every basket in `lines`; a product
 * absent from the map is treated as an ordinary product. A basket mapped to an
 * empty array contributes nothing — the caller rejects that case before calling.
 */
export function expandStockLines(
  lines: { productId: string; quantity: number }[],
  membersByBundle: Map<string, BundleMemberLine[]>,
): { productId: string; quantity: number }[] {
  const merged = new Map<string, number>();
  const add = (productId: string, quantity: number) => {
    merged.set(productId, (merged.get(productId) ?? 0) + quantity);
  };
  for (const line of lines) {
    const members = membersByBundle.get(line.productId);
    if (members) {
      for (const m of members) add(m.productId, m.quantity * line.quantity);
    } else {
      add(line.productId, line.quantity);
    }
  }
  return [...merged.entries()].map(([productId, quantity]) => ({ productId, quantity }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- order-bundle.util`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/order-bundle.util.ts server/src/modules/orders/order-bundle.util.spec.ts
git commit -m "feat(baskets): pure stock-line expansion helper"
```

---

### Task 3: Reject varianted products as basket members

A basket member line carries no `variantId`, so a varianted member would hit the existing `requiresVariantSelection` check at checkout with no way to answer it. Block it at the point of authoring.

**Files:**
- Modify: `server/src/modules/products/products.service.ts:561-613` (`setBundleItems`)
- Test: `server/src/modules/products/products.bundle.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `setBundleItems` throws `BadRequestException` with the message „Продукт с варианти не може да е част от кошница: <име>". Task 6's dialog surfaces it verbatim.

- [ ] **Step 1: Read the existing validation block so the new check matches its style**

Run: `sed -n 561,615p server/src/modules/products/products.service.ts`
Note how member rows are already loaded and validated inside the transaction, and which variable holds them.

- [ ] **Step 2: Write the failing test**

Append to `server/src/modules/products/products.bundle.spec.ts`, following the mock/transaction setup the existing tests in that file use:

```ts
  it('rejects a member product that has variants', async () => {
    await expect(
      service.setBundleItems(
        bundleId,
        [{ productId: variantedProductId, quantity: 1 }],
        tenantId,
        undefined,
      ),
    ).rejects.toThrow('Продукт с варианти не може да е част от кошница');
  });
```

Wire `variantedProductId` into the file's existing product/variant fixtures so the mocked `productVariants` select returns one live row for it. Follow the surrounding tests' fixture style; do not invent a new mocking approach.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- products.bundle`
Expected: FAIL — the call resolves instead of throwing.

- [ ] **Step 4: Write the implementation**

In `setBundleItems`, after the existing member validation and before the delete/insert, add:

```ts
      // A member line carries no variantId, so a varianted member would fail
      // `requiresVariantSelection` at checkout with no way to answer it. Reject it
      // here, where the operator can see why.
      if (memberIds.length) {
        const varianted = await tx
          .select({ productId: productVariants.productId })
          .from(productVariants)
          .where(and(inArray(productVariants.productId, memberIds), isNull(productVariants.deletedAt)));
        if (varianted.length) {
          const blockedIds = new Set(varianted.map((v) => v.productId));
          const names = memberRows
            .filter((m) => blockedIds.has(m.id))
            .map((m) => m.name)
            .join(', ');
          throw new BadRequestException(
            `Продукт с варианти не може да е част от кошница: ${names}`,
          );
        }
      }
```

Adjust `memberRows` to whatever the surrounding code already calls the loaded member rows (see Step 1). Confirm `productVariants`, `inArray` and `isNull` are imported in this file:

Run: `rg -n "productVariants|isNull" server/src/modules/products/products.service.ts | head -5`

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- products.bundle`
Expected: PASS, all tests in the file.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/products/products.service.ts server/src/modules/products/products.bundle.spec.ts
git commit -m "feat(baskets): reject varianted products as basket members"
```

---

### Task 4: Explode baskets at checkout

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts:66-74` (`PreparedItem`)
- Modify: `server/src/modules/orders/orders.service.ts:2340-2352` (courier backstop)
- Modify: `server/src/modules/orders/orders.service.ts:2409-2507` (`reserveCartItems` tail)
- Modify: `server/src/modules/orders/orders.service.ts:2705-2709` (the `create` insert)
- Test: `server/src/modules/orders/orders.bundle.spec.ts`

**Interfaces:**
- Consumes: `expandStockLines` from Task 2; `orderItems.bundleParentId` from Task 1.
- Produces: `PreparedItem.bundleKey` / `PreparedItem.bundleParentKey` (both `string | null | undefined`), and order rows where a basket parent line carries the price and each child carries `priceStotinki: 0` plus `bundleParentId`.

- [ ] **Step 1: Write the failing tests**

Create `server/src/modules/orders/orders.bundle.spec.ts`. Model the DB mock on `server/src/modules/orders/orders.service.spec.ts` — read it first and reuse its harness rather than inventing one. The mock must honour `WHERE` filtering; a mock that returns the same rows for every query certifies bugs instead of catching them.

Cover exactly these cases:

```ts
describe('basket checkout', () => {
  it('writes a parent line at the basket price plus zero-priced child lines', async () => {
    // basket 39.90 containing 2× tomatoes + 1× cheese
    const order = await service.create(slug, { items: [{ productId: basketId, quantity: 1 }], ...base });
    const parent = order.items.find((i) => i.productId === basketId)!;
    expect(parent.priceStotinki).toBe(3990);
    expect(parent.bundleParentId).toBeNull();
    const children = order.items.filter((i) => i.bundleParentId === parent.id);
    expect(children.map((c) => [c.productId, c.quantity, c.priceStotinki])).toEqual([
      [tomatoId, 2, 0],
      [cheeseId, 1, 0],
    ]);
  });

  it('leaves the order total equal to the basket price', async () => {
    const order = await service.create(slug, { items: [{ productId: basketId, quantity: 2 }], ...base });
    const total = order.items.reduce((s, i) => s + i.quantity * i.priceStotinki, 0);
    expect(total).toBe(7980);
  });

  it('decrements member stock, not the basket product', async () => {
    await service.create(slug, { items: [{ productId: basketId, quantity: 3 }], ...base });
    expect(remainingOf(tomatoId)).toBe(tomatoStart - 6);
    expect(remainingOf(basketId)).toBe(basketStart); // untouched
  });

  it('pools a product ordered both loose and inside a basket', async () => {
    await service.create(slug, {
      items: [{ productId: tomatoId, quantity: 1 }, { productId: basketId, quantity: 1 }],
      ...base,
    });
    expect(remainingOf(tomatoId)).toBe(tomatoStart - 3);
  });

  it('rejects the order when a member is sold out', async () => {
    setRemaining(tomatoId, 1);
    await expect(
      service.create(slug, { items: [{ productId: basketId, quantity: 1 }], ...base }),
    ).rejects.toThrow('Няма достатъчна наличност');
  });

  it('rejects a basket with no live members', async () => {
    setBundleMembers(emptyBasketId, []);
    await expect(
      service.create(slug, { items: [{ productId: emptyBasketId, quantity: 1 }], ...base }),
    ).rejects.toThrow('вече не е налична');
  });

  it('blocks courier delivery for a basket with a clear message', async () => {
    await expect(
      service.createCourierOrders(slug, { items: [{ productId: basketId, quantity: 1 }], ...courierBase }),
    ).rejects.toThrow('Кошниците се получават на място или с доставка от фермата');
  });

  it('blocks courier delivery when a member is pickup-only', async () => {
    setCourierDisabled(cheeseId, true);
    await expect(
      service.create(slug, { items: [{ productId: singleFarmerBasketId, quantity: 1 }], ...courierBase }),
    ).rejects.toThrow('не се изпращат с куриер');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @fermeribg/api test -- orders.bundle`
Expected: FAIL — no parent/child split, no `bundleParentId` on the rows.

- [ ] **Step 3: Extend `PreparedItem`**

At `orders.service.ts:66-74`, add two fields:

```ts
interface PreparedItem {
  productId: string;
  productName: string;
  quantity: number;
  priceStotinki: number;
  variantId: string | null;
  variantLabel: string | null;
  farmerId: string | null;
  /** Basket parent line: a per-order unique key its child lines reference. */
  bundleKey?: string | null;
  /** Basket child line: the parent's `bundleKey`. Resolved to a row id on insert. */
  bundleParentKey?: string | null;
}
```

- [ ] **Step 4: Load basket membership inside `reserveCartItems`**

In `reserveCartItems`, immediately before the availability block at line 2409, insert:

```ts
    // Basket („кошница") expansion. A basket product carries no stock of its own:
    // it is replaced, for every stock/courier/companion check below, by its member
    // products. One query for every basket in the cart — no per-row lookup.
    const basketIds = dtoItems
      .map((it) => byId.get(it.productId))
      .filter((p): p is NonNullable<typeof p> => !!p && p.category === 'bundle')
      .map((p) => p.id);
    const membersByBundle = new Map<string, BundleMemberLine[]>();
    // Member products, keyed by id. Same row shape as `byId`, loaded separately
    // because a member need not be in the cart itself.
    const memberById = new Map<string, NonNullable<ReturnType<typeof byId.get>>>();
    if (basketIds.length) {
      const links = await tx
        .select({
          bundleId: productBundleItems.bundleId,
          productId: productBundleItems.productId,
          quantity: productBundleItems.quantity,
        })
        .from(productBundleItems)
        .where(
          and(
            inArray(productBundleItems.bundleId, basketIds),
            eq(productBundleItems.tenantId, tenantId),
          ),
        )
        .orderBy(asc(productBundleItems.position), asc(productBundleItems.productId));
      const memberIds = [...new Set(links.map((l) => l.productId))];
      const memberRows = memberIds.length
        ? await tx
            .select()
            .from(products)
            .where(
              and(
                inArray(products.id, memberIds),
                eq(products.tenantId, tenantId),
                eq(products.isActive, true),
                isNull(products.deletedAt),
              ),
            )
        : [];
      for (const p of memberRows) memberById.set(p.id, p);
      for (const l of links) {
        // A member that went inactive or was deleted makes the whole basket
        // unsellable — we must never promise a box we can't fill.
        if (!memberById.has(l.productId)) continue;
        const list = membersByBundle.get(l.bundleId) ?? [];
        list.push({ productId: l.productId, quantity: l.quantity });
        membersByBundle.set(l.bundleId, list);
      }
      for (const id of basketIds) {
        const linkCount = links.filter((l) => l.bundleId === id).length;
        const live = membersByBundle.get(id) ?? [];
        if (!live.length || live.length !== linkCount) {
          const name = byId.get(id)?.name ?? 'Кошницата';
          throw new ConflictException(`„${name}" вече не е налична — липсва продукт от съдържанието ѝ.`);
        }
      }
    }
    const stockLines = expandStockLines(
      dtoItems.map((it) => ({ productId: it.productId, quantity: it.quantity })),
      membersByBundle,
    );
```

Add the imports at the top of the file: `productBundleItems` and `products` from `@fermeribg/db` (check whether they are already imported before adding), `expandStockLines` and `type BundleMemberLine` from `./order-bundle.util`.

- [ ] **Step 5: Run the stock enforcement over the expanded list**

At lines 2412 and 2442, swap `dtoItems` for `stockLines`:

```ts
    const orderedProductIds = stockLines.map((l) => l.productId);
```

```ts
    for (const l of stockLines) {
      const wins = winsByProduct.get(l.productId) ?? [];
      const decision = decideDecrementPooled(wins, l.quantity);
      if (!decision.ok) {
        const p = byId.get(l.productId) ?? memberById.get(l.productId);
        throw new ConflictException(`Няма достатъчна наличност: ${p?.name ?? 'продукт'}`);
      }
      if (decision.newRemaining) {
        wins.forEach((w, i) => {
          w.remaining = decision.newRemaining![i];
        });
      }
    }
```

Leave the variant block below it iterating `dtoItems` — basket members can't have variants (Task 3), so only the shopper's own variant choices apply.

- [ ] **Step 6: Extend the courier backstop to members**

Replace the `if (carrierDelivery)` block at lines 2340-2352 with:

```ts
    if (carrierDelivery) {
      const blocked = stockLines
        .map((l) => byId.get(l.productId) ?? memberById.get(l.productId))
        .filter((p): p is NonNullable<typeof p> => !!p && p.courierDisabled);
      if (blocked.length) {
        const names = [...new Set(blocked.map((p) => p.name))].join(', ');
        throw new BadRequestException(
          `Тези продукти не се изпращат с куриер (само вземане от място/местна доставка): ${names}`,
        );
      }
    }
```

This block currently sits **above** the basket loading added in Step 4. Move the whole `if (carrierDelivery)` block down so it runs after `stockLines` exists, keeping it before the slot block.

- [ ] **Step 7: Emit parent and child prepared items**

Replace the `items` mapping at lines 2492-2505 with:

```ts
    const now = new Date();
    const items: PreparedItem[] = [];
    dtoItems.forEach((it, idx) => {
      const p = byId.get(it.productId)!;
      const variant = it.variantId ? variantById.get(it.variantId)! : null;
      const line = resolveLineUnit(p, variant, now);
      const members = membersByBundle.get(it.productId);
      // A per-order unique key so children can find their parent row after insert
      // (the parent has no id until then). Index-based: the same basket can legitimately
      // appear on two cart lines.
      const bundleKey = members ? `b${idx}` : null;
      items.push({
        productId: p.id,
        productName: line.label,
        quantity: it.quantity,
        priceStotinki: line.unitStotinki,
        variantId: line.variantId,
        variantLabel: line.variantLabel,
        farmerId: p.farmerId ?? null,
        bundleKey,
        bundleParentKey: null,
      });
      if (!members) return;
      // Children are priced 0 — the money lives on the parent, so the order total
      // is exactly the basket price. They exist so prep, stock restore and
      // per-product stats see the real products.
      for (const m of members) {
        const mp = memberById.get(m.productId)!;
        items.push({
          productId: mp.id,
          productName: mp.name,
          quantity: m.quantity * it.quantity,
          priceStotinki: 0,
          variantId: null,
          variantLabel: null,
          farmerId: mp.farmerId ?? null,
          bundleKey: null,
          bundleParentKey: bundleKey,
        });
      }
    });
```

- [ ] **Step 8: Insert parents first, then children**

Replace the insert at lines 2705-2709 with:

```ts
      // Two passes: children need their parent's row id, which only exists after
      // the parent is inserted. Ordinary lines ride along in the first pass.
      const parentLines = items.filter((i) => !i.bundleParentKey);
      const childLines = items.filter((i) => !!i.bundleParentKey);
      const strip = ({ farmerId: _f, bundleKey: _k, bundleParentKey: _p, ...line }: PreparedItem) => line;
      const insertedParents = await tx
        .insert(orderItems)
        .values(parentLines.map((l) => ({ ...strip(l), orderId: order.id })))
        .returning();
      const idByKey = new Map<string, string>();
      parentLines.forEach((l, i) => {
        if (l.bundleKey) idByKey.set(l.bundleKey, insertedParents[i].id);
      });
      const insertedChildren = childLines.length
        ? await tx
            .insert(orderItems)
            .values(
              childLines.map((l) => ({
                ...strip(l),
                orderId: order.id,
                bundleParentId: idByKey.get(l.bundleParentKey!)!,
              })),
            )
            .returning()
        : [];
      const inserted = [...insertedParents, ...insertedChildren];
```

- [ ] **Step 9: Give courier checkout an honest message**

In `createCourierOrders`, replace the check at lines 2783-2785:

```ts
      // A basket spans farms and carries no farmerId, so the per-farmer split has
      // nothing to key on — and one parcel can't leave three yards. Say so plainly
      // instead of failing with the generic "needs a farmer" message.
      if (prepared.some((i) => i.bundleKey)) {
        throw new BadRequestException(
          'Кошниците се получават на място или с доставка от фермата, не с куриер.',
        );
      }
      // Every remaining courier line must resolve to a farmer (the split key).
      if (prepared.some((i) => i.farmerId == null)) {
        throw new BadRequestException('Куриерска доставка изисква продукти с фермер.');
      }
```

- [ ] **Step 9b: Refuse to edit an order that contains a basket**

The order-edit path at `orders.service.ts:1547-1579` deletes every `order_items` row and
re-inserts the kept ones verbatim, dropping only `id` and `orderId`. A child line's
`bundleParentId` would survive that round trip pointing at a row that no longer exists —
a hard foreign-key violation, not a silent dangle. The edit path also has no notion of
re-linking a basket's children, and `dto.items` (what the operator edits) never contains
them.

Editing a basket order is out of scope for v1. Guard it instead, immediately before the
`await tx.delete(orderItems)` at line 1578:

```ts
        // A basket („кошница") order line owns child rows that this path cannot rebuild:
        // it deletes every row and re-inserts the kept ones verbatim, so a child's
        // bundleParentId would point at a deleted parent. Refuse the edit rather than
        // corrupt the order.
        if (oldItems.some((o) => o.bundleParentId)) {
          throw new BadRequestException(
            'Поръчка с кошница не може да се редактира. Откажете я и направете нова.',
          );
        }
```

Add the covering test to `orders.bundle.spec.ts`:

```ts
  it('refuses to edit an order containing a basket', async () => {
    const order = await service.create(slug, { items: [{ productId: basketId, quantity: 1 }], ...base });
    await expect(
      service.update(order.id, tenantId, { items: [{ productId: tomatoId, quantity: 1 }] }),
    ).rejects.toThrow('Поръчка с кошница не може да се редактира');
  });
```

Match `service.update`'s real signature — read it before writing the test rather than
copying this call shape blindly.

- [ ] **Step 10: Run the new tests**

Run: `pnpm --filter @fermeribg/api test -- orders.bundle`
Expected: PASS, 8 tests.

- [ ] **Step 11: Run the whole orders suite for regressions**

Run: `pnpm --filter @fermeribg/api test -- orders`
Expected: PASS. An isolated test can pass while the suite fails — run the suite, not just the new file.

- [ ] **Step 12: Commit**

```bash
git add server/src/modules/orders/orders.service.ts server/src/modules/orders/orders.bundle.spec.ts
git commit -m "feat(baskets): explode baskets into member order lines at checkout"
```

---

### Task 5: `min`-over-members public availability

**Files:**
- Create: `server/src/modules/availability/bundle-availability.util.ts`
- Test: `server/src/modules/availability/bundle-availability.util.spec.ts`
- Modify: `server/src/modules/availability/availability.service.ts:412-437` (`findPublicActiveBySlug`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `basketRemaining(members, remainingByProduct, liveProductIds): number | null` — `null` means unlimited (no synthetic window emitted).

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/availability/bundle-availability.util.spec.ts`:

```ts
import { basketRemaining } from './bundle-availability.util';

const live = new Set(['p1', 'p2']);

describe('basketRemaining', () => {
  it('is the smallest member cap', () => {
    const rem = new Map([['p1', 10], ['p2', 3]]);
    expect(basketRemaining([{ productId: 'p1', quantity: 1 }, { productId: 'p2', quantity: 1 }], rem, live)).toBe(3);
  });

  it('divides by how many of that member go in one basket', () => {
    const rem = new Map([['p1', 7]]);
    expect(basketRemaining([{ productId: 'p1', quantity: 2 }], rem, new Set(['p1']))).toBe(3);
  });

  it('treats a member with no window as unlimited', () => {
    const rem = new Map([['p2', 4]]);
    expect(basketRemaining([{ productId: 'p1', quantity: 1 }, { productId: 'p2', quantity: 1 }], rem, live)).toBe(4);
  });

  it('is unlimited when no member has a window', () => {
    expect(basketRemaining([{ productId: 'p1', quantity: 1 }], new Map(), new Set(['p1']))).toBeNull();
  });

  it('is sold out when a member is not live', () => {
    const rem = new Map([['p1', 10], ['p9', 10]]);
    expect(basketRemaining([{ productId: 'p9', quantity: 1 }], rem, live)).toBe(0);
  });

  it('is sold out with no members at all', () => {
    expect(basketRemaining([], new Map(), live)).toBe(0);
  });

  it('is sold out when a member has zero remaining', () => {
    const rem = new Map([['p1', 0]]);
    expect(basketRemaining([{ productId: 'p1', quantity: 1 }], rem, new Set(['p1']))).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- bundle-availability`
Expected: FAIL — `Cannot find module './bundle-availability.util'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/modules/availability/bundle-availability.util.ts`:

```ts
/**
 * How many of a basket („кошница") can still be sold, from its members' stock.
 *
 * A basket carries no stock of its own — the panel hides the field — so the only
 * honest number is the weakest member: `min` over `floor(remaining / per-basket
 * quantity)`. A member with no availability window is unlimited and doesn't
 * constrain the result; when no member has one, the basket is unlimited too
 * (`null`, so the caller emits no window at all).
 *
 * A member that is no longer live (inactive, deleted, awaiting review) makes the
 * basket sold out: we must never promise a box we can't fill.
 */
export function basketRemaining(
  members: { productId: string; quantity: number }[],
  remainingByProduct: Map<string, number>,
  liveProductIds: Set<string>,
): number | null {
  if (!members.length) return 0;
  let cap: number | null = null;
  for (const m of members) {
    if (!liveProductIds.has(m.productId)) return 0;
    const remaining = remainingByProduct.get(m.productId);
    if (remaining == null) continue; // unlimited member
    const memberCap = Math.floor(remaining / Math.max(1, m.quantity));
    cap = cap == null ? memberCap : Math.min(cap, memberCap);
  }
  return cap;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- bundle-availability`
Expected: PASS, 7 tests.

- [ ] **Step 5: Emit synthetic basket windows from the public endpoint**

In `availability.service.ts`, replace the `return rows.map(...)` tail of `findPublicActiveBySlug` (lines 430-436) with:

```ts
    const ordinary = rows.map((w) => ({
      productId: w.productId!,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      quantity: w.quantity,
      remaining: w.remaining,
    }));

    // Baskets („кошници") have no stock of their own — publish one synthetic window
    // per basket, computed from its members, and drop any real rows for the basket
    // product so the storefront (which pools a product's windows) can't double-count.
    const baskets = await this.db
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.tenantId, tenant.id),
          eq(products.category, 'bundle'),
          eq(products.isActive, true),
          eq(products.needsReview, false),
          isNull(products.deletedAt),
        ),
      );
    if (!baskets.length) return ordinary;
    const basketIds = baskets.map((b) => b.id);

    const links = await this.db
      .select({
        bundleId: productBundleItems.bundleId,
        productId: productBundleItems.productId,
        quantity: productBundleItems.quantity,
      })
      .from(productBundleItems)
      .where(inArray(productBundleItems.bundleId, basketIds));

    const memberIds = [...new Set(links.map((l) => l.productId))];
    const liveMembers = memberIds.length
      ? await this.db
          .select({ id: products.id })
          .from(products)
          .where(
            and(
              inArray(products.id, memberIds),
              eq(products.tenantId, tenant.id),
              eq(products.isActive, true),
              eq(products.needsReview, false),
              isNull(products.deletedAt),
            ),
          )
      : [];
    const liveIds = new Set(liveMembers.map((m) => m.id));

    // Pool each member's windows the same way checkout does.
    const remainingByProduct = new Map<string, number>();
    for (const w of ordinary) {
      if (w.remaining == null) continue;
      remainingByProduct.set(w.productId, (remainingByProduct.get(w.productId) ?? 0) + w.remaining);
    }

    const membersByBasket = new Map<string, { productId: string; quantity: number }[]>();
    for (const l of links) {
      const list = membersByBasket.get(l.bundleId) ?? [];
      list.push({ productId: l.productId, quantity: l.quantity });
      membersByBasket.set(l.bundleId, list);
    }

    const basketIdSet = new Set(basketIds);
    const synthetic: PublicAvailabilityWindow[] = [];
    for (const id of basketIds) {
      const remaining = basketRemaining(membersByBasket.get(id) ?? [], remainingByProduct, liveIds);
      if (remaining == null) continue; // unlimited — publish nothing
      synthetic.push({
        productId: id,
        startsAt: OPEN_START,
        endsAt: OPEN_END,
        quantity: remaining,
        remaining,
      });
    }
    return [...ordinary.filter((w) => !basketIdSet.has(w.productId)), ...synthetic];
```

Add the imports this needs: `products` and `productBundleItems` from `@fermeribg/db`, `inArray` and `isNull` from `drizzle-orm`, and `basketRemaining` from `./bundle-availability.util`. `OPEN_START` / `OPEN_END` are already defined in this file at lines 24-25.

- [ ] **Step 6: Run the availability suite**

Run: `pnpm --filter @fermeribg/api test -- availability`
Expected: PASS.

- [ ] **Step 7: Run the full server suite**

Run: `pnpm --filter @fermeribg/api test`
Expected: PASS. Report any failure with its actual output rather than working around it.

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/availability/
git commit -m "feat(baskets): derive public basket availability from members"
```

---

### Task 6: „Създай кошница" in the panel

**Files:**
- Modify: `client/src/components/products/products-client.tsx:325-378` (toolbar)
- Modify: `client/src/components/products/product-dialog.tsx` (basket mode)

**Interfaces:**
- Consumes: the `setBundleItems` error copy from Task 3.
- Produces: `ProductDialog` accepts a new prop `basketMode?: boolean`. Task 7 does not depend on it.

- [ ] **Step 1: Read how the create dialog is currently opened**

Run: `rg -n "createOpen|setCreateOpen|ProductDialog" client/src/components/products/products-client.tsx`
Note the state variable, where `<ProductDialog>` is rendered for create, and what `onSubmit` does with `ProductWrite`.

- [ ] **Step 2: Add the toolbar button**

In `products-client.tsx`, after the „Добави от снимка" button block (lines 367-371), add:

```tsx
          {!reorderMode && !isFarmer && (
            <Button variant="outline" onClick={() => setBasketOpen(true)} className="rounded-sm">
              <ShoppingBasket size={18} /> Създай кошница
            </Button>
          )}
```

Add `const [basketOpen, setBasketOpen] = useState(false);` beside the other dialog state, and add `ShoppingBasket` to the `lucide-react` import at the top of the file.

`isFarmer` already exists in this component and is used by the „Подреди" and „Провери продукти" buttons — a producer sub-account must not build baskets out of other farmers' products.

- [ ] **Step 3: Render the dialog in basket mode**

Beside the existing create `<ProductDialog>`, add:

```tsx
      <ProductDialog
        open={basketOpen}
        basketMode
        farmers={farmers}
        subcats={subcats}
        multiFarmer={multiFarmer}
        multiSubcat={multiSubcat}
        onClose={() => setBasketOpen(false)}
        onSubmit={onCreate}
      />
```

Use whatever the existing create dialog passes for `onSubmit` (see Step 1) — the basket dialog creates a product through the same path.

- [ ] **Step 4: Accept the prop and force the basket shape**

In `product-dialog.tsx`, add `basketMode` to the props type and destructuring:

```ts
  /** Create a „кошница" instead of a plain product: forces category='bundle', no
   *  farmer link, no own stock, and the contents editor is live from the start. */
  basketMode?: boolean;
```

Change the gate at line 86 from:

```ts
  const isBundle = isEdit && product?.category === 'bundle';
```

to:

```ts
  const isBundle = basketMode || product?.category === 'bundle';
```

In the submit payload (lines 312-328), add — before the `...(isEdit ? ... )` spread:

```ts
          // A basket is a product with category='bundle' and no farmer of its own:
          // `setBundleItems` only allows cross-farmer members when farmerId is null.
          ...(basketMode ? { category: 'bundle', farmerId: null } : {}),
```

The dialog currently never sends `category` at all, which is why no panel path could produce a basket.

- [ ] **Step 5: Explain what a basket is, at the top of the dialog**

Render this immediately below the dialog title, only when `basketMode` is true:

```tsx
        {basketMode && (
          <div className="rounded-lg border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[12.5px] leading-relaxed text-ff-ink-2">
            <b className="text-ff-ink">Кошница</b> — няколко продукта от различни фермери,
            продавани заедно на една цена. Клиентът вижда една снимка от четири парчета и плаща
            общата цена. Ти получаваш поръчка с разписаните продукти вътре, готова за подготовка.
            <br />
            Кошницата се получава на място или с доставка от фермата — не се изпраща с куриер.
          </div>
        )}
```

- [ ] **Step 6: Hide stock and courier controls in basket mode**

A basket's availability is derived from its members (Task 5) and it never ships by courier, so both controls would lie. Wrap the stock input and the courier toggle so they render only when `!basketMode`. Find them:

Run: `rg -n "courierEnabled|Наличност|stock" client/src/components/products/product-dialog.tsx | head -20`

In basket mode also force `stock: null` and `courierDisabled: true` in the submit payload, so the saved product matches what the dialog showed:

```ts
          ...(basketMode ? { category: 'bundle', farmerId: null, stock: null, courierDisabled: true } : {}),
```

(replaces the spread added in Step 4).

- [ ] **Step 7: Show the saving next to the price**

Below the price input, when `basketMode` and there is at least one member, render:

```tsx
        {basketMode && bundleItems.length > 0 && (() => {
          const sum = bundleItems.reduce((s, b) => s + b.priceStotinki * b.quantity, 0);
          const own = euroInputToStotinki(variants[0]?.price ?? '') ?? 0;
          const diff = sum - own;
          return (
            <p className={`text-[12.5px] ${diff < 0 ? 'text-ff-red' : 'text-ff-muted'}`}>
              Стойност поотделно {moneyFromStotinki(sum)}
              {own > 0 && diff > 0 && ` · спестявате ${moneyFromStotinki(diff)} (${Math.round((diff / sum) * 100)}%)`}
              {own > 0 && diff < 0 && ' · кошницата излиза по-скъпо от продуктите поотделно'}
            </p>
          );
        })()}
```

`moneyFromStotinki` is already imported at the top of the file.

- [ ] **Step 8: Make the contents editor work before the product is saved**

The editor at lines 709-796 renders „Запазете пакета, за да добавите продукти." when `!product`, and `persistBundleItems` returns early for the same reason — a basket has no id until it is created.

Keep that behaviour, but change the copy so it tells the operator what to do next:

```tsx
                <p className="text-[12.5px] text-ff-muted">
                  Запишете кошницата с име и цена, после добавете продуктите в нея.
                </p>
```

Also relax the member picker so it lists every farmer's products with the owner shown. Change the `<option>` label inside the picker (lines ~763-770) to:

```tsx
                            <option key={o.id} value={o.id}>
                              {o.name}
                              {o.weight ? ` (${o.weight})` : ''}
                              {o.farmerName ? ` — ${o.farmerName}` : ''}
                            </option>
```

Check whether `ProductOption` already carries a farmer name:

Run: `rg -n "interface ProductOption" -A 10 client/src/lib/types.ts`
If it does not, drop the `farmerName` clause rather than adding a backend field — the picker still works without it.

- [ ] **Step 9: Surface the member-rejection error**

`bundleErr` is already rendered by the editor. Confirm it displays the server message verbatim (so „Продукт с варианти не може да е част от кошница: …" reaches the operator):

Run: `rg -n "bundleErr" client/src/components/products/product-dialog.tsx`
Expected: a render site that prints `{bundleErr}` unmodified. If it prints a generic string instead, change it to print `bundleErr`.

- [ ] **Step 10: Typecheck and lint**

Run: `pnpm --filter @fermeribg/web build`
Expected: exits 0.

Run: `pnpm lint`
Expected: exits 0.

- [ ] **Step 11: Verify in the running panel**

Start the panel via `preview_start` (never `pnpm dev` through Bash). Then:
1. Open `/products`, confirm „Създай кошница" is in the toolbar.
2. Click it — confirm the explanation block, no stock field, no courier toggle.
3. Save a basket with a name and price — confirm it appears in the list.
4. Reopen it, add two products from different farmers, confirm the saving line reads „Стойност поотделно … · спестявате …".
5. Check the layout at 375px width.

Take a screenshot of step 4 as proof.

- [ ] **Step 12: Commit**

```bash
git add client/src/components/products/products-client.tsx client/src/components/products/product-dialog.tsx
git commit -m "feat(baskets): Създай кошница entry point and basket mode in the product dialog"
```

---

### Task 7: Show basket contents in the panel's order view

**Files:**
- Modify: the order-items list component (located in Step 1)

**Interfaces:**
- Consumes: `OrderItem.bundleParentId` from Task 1.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Find where order items are listed**

Run: `rg -ln "variantLabel" client/src/components/orders/`
Open the component that renders one row per order item. If more than one file matches, change every one that renders a customer-visible or operator-visible item list.

- [ ] **Step 2: Group children under their parent**

Before the render, reorder the items so each basket's children follow it:

```ts
  // Basket („кошница") lines: the parent carries the price, its children are the
  // products inside it. Keep children directly under their parent, in order.
  const parents = items.filter((i) => !i.bundleParentId);
  const childrenByParent = new Map<string, typeof items>();
  for (const i of items) {
    if (!i.bundleParentId) continue;
    const list = childrenByParent.get(i.bundleParentId) ?? [];
    list.push(i);
    childrenByParent.set(i.bundleParentId, list);
  }
  const ordered = parents.flatMap((p) => [p, ...(childrenByParent.get(p.id) ?? [])]);
```

Render `ordered` instead of `items`.

- [ ] **Step 3: Indent children and hide their price**

On the row element, when `item.bundleParentId` is set, add the indent class and render „в кошницата" instead of a price:

```tsx
        <li className={item.bundleParentId ? 'pl-5 text-ff-muted' : undefined}>
          <span>{item.productName} × {item.quantity}</span>
          {item.bundleParentId ? (
            <span className="text-[12px]">в кошницата</span>
          ) : (
            <span>{moneyFromStotinki(item.priceStotinki * item.quantity)}</span>
          )}
        </li>
```

Adapt the markup to the component's existing structure — do not replace its layout, only add the branch.

- [ ] **Step 4: Confirm the total is unaffected**

Find the total calculation in the same component:

Run: `rg -n "priceStotinki \*" client/src/components/orders/ | head`
Children are priced 0, so any `sum(quantity × price)` is already correct. If the component instead counts *lines* (e.g. „3 продукта"), change that count to `parents.length` so a basket reads as one item.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @fermeribg/web build`
Expected: exits 0.

- [ ] **Step 6: Verify in the running panel**

Place a test basket order through the local storefront or the API, then open the order in the panel. Confirm the basket row shows the price and its members are indented beneath it with no price. Screenshot it.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/orders/
git commit -m "feat(baskets): show basket contents under the basket line in orders"
```

---

### Task 8: Storefront naming — „Кошници"

**Repo:** `C:\Users\Lenovo\source\repos\fermerski-pazar-chaika`

**Files:**
- Modify: `src/lib/catalog.ts:19-20`, `51-62`
- Modify: `src/lib/icons.ts:4-36`, `41-49`
- Modify: `src/components/ProductCard.astro:76`

**Interfaces:**
- Consumes: nothing.
- Produces: the category label „Кошници" and icon name `basket`, both used by Task 9's card.

- [ ] **Step 1: Rename the label and description**

In `src/lib/catalog.ts`, change line 19:

```ts
const BUNDLE_LABEL = 'Кошници';
```

and the description branch at lines 51-54:

```ts
    desc:
      id === 'bundle'
        ? 'Готови кошници с продукти от няколко фермери, на обща цена.'
        : 'Свежи продукти от местните фермери.',
```

- [ ] **Step 2: Add the basket icon**

In `src/lib/icons.ts`, add a `basket` entry to the `ICONS` object, matching the shape and stroke conventions of the entries already there (read `produce` first and copy its wrapper attributes):

```ts
  basket: '<path d="M4 9h16l-1.6 9.2a2 2 0 0 1-2 1.8H7.6a2 2 0 0 1-2-1.8L4 9Z"/><path d="m8 9 2.5-5M16 9l-2.5-5"/><path d="M9.5 13v3M14.5 13v3"/>',
```

Then add the match arm to `iconForCategory`, **above** the `плод|зелен` arm so „Кошници" can't be swallowed by a broader pattern:

```ts
  if (/кошниц|пакет|basket/.test(n)) return 'basket';
```

`iconForCategory` is called with the *label*, so it receives „Кошници".

- [ ] **Step 3: Rename the card pill**

In `src/components/ProductCard.astro` line 76, change the pill text from `🧺 Пакет` to:

```astro
    {isBundle && <span class="tag" style="position:absolute;top:12px;left:12px;z-index:2;transform:translateY(28px);background:#4a7c3a">🧺 Кошница</span>}
```

- [ ] **Step 4: Build**

Run: `cd C:\Users\Lenovo\source\repos\fermerski-pazar-chaika && pnpm build`
Expected: exits 0.

- [ ] **Step 5: Verify in the browser**

Start chaika via `preview_start` (dev port 3003). Open `/shop`, confirm the category chip reads „Кошници" with the basket icon and the card pill reads „🧺 Кошница".

- [ ] **Step 6: Commit (in the chaika repo)**

```bash
cd C:\Users\Lenovo\source\repos\fermerski-pazar-chaika
git add src/lib/catalog.ts src/lib/icons.ts src/components/ProductCard.astro
git commit -m "feat(baskets): rename the bundle category to Кошници"
```

---

### Task 9: 2×2 member-image grid

**Repo:** `C:\Users\Lenovo\source\repos\fermerski-pazar-chaika`

**Files:**
- Modify: `src/components/ProductCard.astro:83-90` (the image branch)
- Modify: `src/components/Gallery.astro:17-46`
- Modify: `src/pages/product/[slug].astro:109`

**Interfaces:**
- Consumes: `p.bundleProducts[].image` — already present on every product in the cached public catalog, so no API change and no new fetch.
- Produces: `Gallery` gains a `tiles?: string[]` prop.

- [ ] **Step 1: Compute the tiles on the card**

In `src/components/ProductCard.astro`, in the frontmatter beside the existing `isBundle` line (52), add:

```ts
// A basket with no cover photo of its own is drawn as a grid of its members'
// photos — up to four, in the order the operator arranged them. An uploaded
// cover always wins.
const tiles = (p.bundleProducts ?? []).map((b) => b.image).filter((s): s is string => !!s).slice(0, 4);
const showTiles = isBundle && !p.imageUrl && tiles.length >= 2;
```

- [ ] **Step 2: Render the grid**

Replace the image branch at lines 83-90 with a three-way choice:

```astro
    {showTiles ? (
      <span class="tile-grid" style={`position:absolute;inset:0;display:grid;gap:2px;grid-template-columns:1fr 1fr;grid-template-rows:${tiles.length > 2 ? '1fr 1fr' : '1fr'}`}>
        {tiles.map((src, i) => (
          <img src={cfImage(src, 360)} srcset={cfSrcset(src, [180, 360])}
               sizes="(max-width:700px) 25vw, 160px" alt="" loading="lazy" decoding="async"
               style={`width:100%;height:100%;object-fit:cover;${tiles.length === 3 && i === 0 ? 'grid-row:span 2' : ''}`} />
        ))}
      </span>
    ) : p.imageUrl ? (
      <img src={cfImage(p.imageUrl, 720)} srcset={cfSrcset(p.imageUrl, [360, 720])}
           sizes="(max-width:700px) 50vw, 320px" alt={p.name} loading="lazy" decoding="async"
           style={`position:absolute;inset:0;width:100%;height:100%;object-fit:cover;${coverCropStyle(p.coverCrop)}`} />
    ) : (
      <span class="ph__label">{p.name}</span>
    )}
```

Three tiles put the first image down the left half and the other two stacked on the right; two tiles fill one row. The overlays (promo tag, 🧺 pill, „Хит", photo count, stock badge) are siblings inside the same `.ph` box and keep working untouched.

- [ ] **Step 3: Add the `tiles` prop to `Gallery`**

In `src/components/Gallery.astro`, extend the props and add a tiles branch ahead of the existing ones:

```ts
interface Props {
  images: string[];
  alt: string;
  /** Placeholder label shown when there are no images. */
  label?: string;
  /** Basket mode: draw a grid of member photos instead of one main image. */
  tiles?: string[];
}
const { images, alt, label, tiles } = Astro.props;
const grid = (tiles ?? []).slice(0, 4);
const showTiles = grid.length >= 2;
const has = images.length > 0;
const multi = images.length > 1;
```

Then make the template start with:

```astro
{showTiles ? (
  <div class="ph ph--rounded" style="aspect-ratio:1;display:grid;gap:3px;grid-template-columns:1fr 1fr;grid-template-rows:{grid.length > 2 ? '1fr 1fr' : '1fr'}">
    {grid.map((src, i) => (
      <img src={cfImage(src, 600)} srcset={cfSrcset(src, [300, 600])}
           sizes="(max-width:900px) 50vw, 260px" alt="" fetchpriority={i === 0 ? 'high' : undefined}
           decoding="async"
           style={`width:100%;height:100%;object-fit:cover;${grid.length === 3 && i === 0 ? 'grid-row:span 2' : ''}`} />
    ))}
  </div>
) : has ? (
```

and close it with the existing `has ? (...) : (...)` bodies unchanged, so the file ends `) : ( <div class="ph ph--rounded" …placeholder… /> )}`.

Note the `.ph` class sets `position:relative`; the inline `display:grid` overrides only the layout, so the rounded corners and aspect ratio still apply. Do not use `position:absolute` on the tiles here — the grid itself is the box.

- [ ] **Step 4: Pass tiles from the product page**

In `src/pages/product/[slug].astro`, replace line 109:

```astro
    <Gallery
      images={productImages}
      tiles={product.imageUrl ? undefined : (product.bundleProducts ?? []).map((b) => b.image).filter(Boolean)}
      alt={product.name}
      label={`${product.name} · 1:1`}
    />
```

- [ ] **Step 5: Build**

Run: `cd C:\Users\Lenovo\source\repos\fermerski-pazar-chaika && pnpm build`
Expected: exits 0.

- [ ] **Step 6: Verify in the browser**

With chaika running on port 3003 and a basket created in the panel (Task 6) holding four products from different farmers:
1. `/shop` — the basket card shows a 2×2 grid, pill and price still legible.
2. Remove one member so three remain — the card shows the 1-left / 2-right layout.
3. Open the basket's product page — the 1:1 box is a grid, „Какво има вътре" lists the members below.
4. Upload a cover photo for the basket — both the card and the page show that photo instead.
5. Check `/shop` at 375px; confirm the tiles stay square-ish and nothing overflows the card.

Screenshot steps 1 and 3.

- [ ] **Step 7: Commit (in the chaika repo)**

```bash
cd C:\Users\Lenovo\source\repos\fermerski-pazar-chaika
git add src/components/ProductCard.astro src/components/Gallery.astro src/pages/product/[slug].astro
git commit -m "feat(baskets): draw baskets as a 2x2 grid of member photos"
```

---

### Task 10: End-to-end check and merge

**Files:** none changed unless a defect is found.

- [ ] **Step 1: Run the full FarmFlow suite**

Run: `pnpm --filter @fermeribg/api test`
Expected: PASS.

Run: `pnpm --filter @fermeribg/web test`
Expected: PASS.

Run: `pnpm lint && pnpm build`
Expected: both exit 0.

- [ ] **Step 2: Walk the whole flow locally**

1. Panel → „Създай кошница" → name, price 39.90, save.
2. Add three products from different farmers.
3. chaika `/shop` → the basket appears under „Кошници" with a tile grid.
4. Buy it with pickup → the order lands in the panel with the basket line at 39.90 and its members indented under it.
5. Panel → Наличности: the members' remaining dropped by their basket quantities; the basket itself has no stock row.
6. Set one member's stock to 0 → the basket reads „изчерпан" on `/shop` (allow up to 15s for the bootstrap cache).
7. Try courier checkout with the basket in the cart → the error reads „Кошниците се получават на място или с доставка от фермата, не с куриер."
8. Cancel the order in the panel → member stock is restored.

- [ ] **Step 3: Re-fetch main immediately before pushing**

```bash
git fetch origin
git log --oneline origin/main -1
```

If `origin/main` moved, check whether another session took journal `idx: 110`. If it did, renumber this branch's migration in all three places — the filename, the header comment, and the journal entry — inside the merge commit. Leaving a gap silently breaks the migrator.

- [ ] **Step 4: Merge and push**

Merge to `main` and push. The push auto-deploys to Hetzner and runs the migrator before the app images.

- [ ] **Step 5: Deploy chaika after the API is live**

Confirm the API is serving the new shape, then deploy chaika separately (Cloudflare Workers). Backend first — a storefront asking for a shape the API doesn't serve yet renders a broken catalog.

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| Cross-farmer membership, `farmerId = null` | 6 (forced in the payload); no server change needed |
| Explode into member lines | 4 |
| Fixed manual price, saving shown | 6 |
| Auto 2×2 images, uploaded cover wins | 9 |
| Grid on card **and** detail page | 9 |
| Sold out = `min` over members | 5 |
| Reuse `category='bundle'`, relabel „Кошници" | 8 |
| Owner/admin only | 6 (`!isFarmer`) |
| Pickup / local delivery only | 4 (steps 6 and 9) |
| Varianted members rejected | 3 |
| Migration `0112`, journal `idx 110` | 1 |
| Deploy backend first | 10 |

**Known gap carried forward:** basket revenue sits on the basket product (`farmerId = null`), so per-farmer attribution does not split it. Vendor finance is dormant (rate 0), so nothing is misreported today. Recorded in the spec's *Known limitation* section; no task.

**Type consistency:** `bundleParentId` (Tasks 1, 4, 7), `bundleKey` / `bundleParentKey` (Task 4 only, stripped before insert), `expandStockLines` (Tasks 2, 4), `BundleMemberLine` (Tasks 2, 4), `basketRemaining` (Task 5), `tiles` (Task 9). All names match across their tasks.
