# Courier Phase 2 — Storefront option + per-farmer cart split

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a nationwide **Куриер** delivery option to the storefront that, at checkout, splits a multi-farmer cart into one single-farmer **COD** order per farmer (no platform delivery fee).

**Architecture:** Two repos. **Backend** (`FarmFlow`): a new `delivery_type='courier'`, an `orders.farmer_id` column, a server-side eligibility helper (`courierReady` = farmer `courier_enabled` AND ≥1 connected carrier), and a new `OrdersService.createCourierOrders` that reuses the existing item-validation/stock-decrement logic (extracted into a shared `prepareOrderItems`) to create N atomic single-farmer COD orders. **Storefront** (`fermerski-pazar-chaika`): the picker shows Куриер only when every product in the cart is from a `courierReady` farmer; the checkout posts `deliveryType:'courier'` and renders the split on the confirmation page.

**Tech Stack:** NestJS + Drizzle/Postgres (hand-written migrations), class-validator DTOs, Astro + vanilla TS storefront.

**Scope guardrails:**
- Phase 2 STOPS at creating the split COD orders. It does **not** auto-create carrier shipments — that is Phase 3 (distribution engine). Between Phase 2 and Phase 3, a farmer fulfils a courier order by opening dostavki ("Доставки" button) and creating the waybill manually. The plan flags this; it is expected, not a gap to close here.
- `orders.carrier` stays NULL for courier orders (the farmer picks the carrier at ship time).
- COD only. No Stripe path for courier. No platform delivery fee (order total = farmer's line-item subtotal).

**Repo paths:**
- Backend: `C:\Users\Lenovo\source\repos\FarmFlow`
- Storefront: `C:\Users\Lenovo\source\repos\fermerski-pazar-chaika`

---

## File Structure

**Backend (FarmFlow):**
- `packages/db/drizzle/0070_courier_orders.sql` (new) — enum value + `orders.farmer_id`.
- `packages/db/drizzle/meta/_journal.json` (modify) — append idx 70.
- `packages/db/src/schema.ts` (modify) — `deliveryTypeEnum` + `orders.farmerId` + index.
- `server/src/modules/orders/courier-eligibility.ts` (new) — pure `farmerCourierReady` + `farmerDeliveryNamespace`.
- `server/src/modules/orders/courier-eligibility.spec.ts` (new) — tests.
- `server/src/modules/orders/dto/create-order.dto.ts` (modify) — `'courier'` + ValidateIf rules.
- `server/src/modules/orders/orders.service.ts` (modify) — extract `prepareOrderItems`; add `createCourierOrders`; widen `deliveryType` unions.
- `server/src/modules/orders/orders.courier.spec.ts` (new) — split tests.
- `server/src/modules/orders/checkout.service.ts` (modify) — route `courier`; extend `CheckoutResult`.
- `server/src/modules/orders/checkout.service.spec.ts` (modify) — courier routing test.
- `server/src/modules/farmers/farmers.service.ts` (modify) — `courierReady` on `findPublicBySlug`.
- `packages/types/src/index.ts` (modify) — `PublicFarmer.courierReady`.
- `server/src/modules/econt/econt.controller.ts` + `server/src/modules/speedy/speedy-config.controller.ts` (modify) — bust public farmers cache on farmer carrier connect/disconnect.

**Storefront (fermerski-pazar-chaika):**
- `src/lib/types.ts` (modify) — `Farmer.courierReady`, `deliveryType` `'courier'`, checkout response `orders?`.
- `src/pages/checkout.astro` (modify) — Куриер option + лична доставка info text.
- `src/scripts/checkout-page.ts` (modify) — eligibility, courier payload, split-response handling, stash.
- `src/scripts/confirmation-page.ts` (modify) — render split.

---

## Task 1: Migration 0070 — `delivery_type='courier'` + `orders.farmer_id`

**Files:**
- Create: `packages/db/drizzle/0070_courier_orders.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/db/src/schema.ts` (orders table + deliveryTypeEnum)
- Modify: `server/src/modules/orders/orders.service.ts` (widen two `deliveryType` literal unions)

- [ ] **Step 1: Write the migration SQL**

Create `packages/db/drizzle/0070_courier_orders.sql`:

```sql
-- Phase 2: nationwide courier delivery per farmer.
-- 'courier' = a split single-farmer COD order shipped by the farmer's own carrier
-- (Econt/Speedy) from their own delivery account. farmer_id tags which farmer the
-- (split) order belongs to. NULL for legacy / local / pickup / Econt orders; set
-- only on courier-split orders. ON DELETE set null so removing a farmer never
-- blocks on the FK and keeps the order's history.
ALTER TYPE "public"."delivery_type" ADD VALUE 'courier';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "farmer_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_farmer_id_farmers_id_fk" FOREIGN KEY ("farmer_id") REFERENCES "public"."farmers"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "orders_farmer_idx" ON "orders" ("farmer_id");
```

- [ ] **Step 2: Append the journal entry**

In `packages/db/drizzle/meta/_journal.json`, append to the `entries` array (after idx 69):

```json
    {
      "idx": 70,
      "version": "7",
      "when": 1783155600000,
      "tag": "0070_courier_orders",
      "breakpoints": true
    }
```

(Add a comma after the idx-69 object's closing brace.)

- [ ] **Step 3: Update the schema — enum + column + index**

In `packages/db/src/schema.ts`:

Change the enum:
```ts
export const deliveryTypeEnum = pgEnum('delivery_type', ['pickup', 'address', 'econt', 'econt_address', 'courier']);
```

In the `orders` table definition, add the column right after `carrier` (mirror the existing `products.farmerId` FK style — `onDelete: 'set null'`):
```ts
    // Which farmer this (split) courier order belongs to. Set ONLY on
    // delivery_type='courier' orders, which are always single-farmer; NULL for
    // local/pickup/Econt orders. See migration 0070.
    farmerId: uuid('farmer_id').references(() => farmers.id, { onDelete: 'set null' }),
```
In the same table's index block `(t) => ({ ... })`, add:
```ts
    // Farmer-scoped order lookups (courier split orders).
    farmerIdx: index('orders_farmer_idx').on(t.farmerId),
```

> If TypeScript reports a circular-reference error on `farmers.id` (orders is defined before farmers), type the column with `AnyPgColumn` exactly as the existing circular FKs in this file do (search the file for `AnyPgColumn`). Otherwise leave the thunk as written.

- [ ] **Step 4: Widen the two hand-written `deliveryType` literal unions**

Adding `'courier'` to the pgEnum widens `orders.$inferSelect['deliveryType']` to include `'courier'`, which breaks two narrower hand-written unions. In `server/src/modules/orders/orders.service.ts`:

1. `PublicOrderSummary.deliveryType` (≈ line 262) → add `| 'courier'`:
```ts
  deliveryType: 'pickup' | 'address' | 'econt' | 'econt_address' | 'courier';
```
2. `shippingStotinki`'s param `order.deliveryType` (≈ line 199) → add `| 'courier'`:
```ts
    deliveryType: 'pickup' | 'address' | 'econt' | 'econt_address' | 'courier' | null;
```

- [ ] **Step 5: Build db + typecheck server**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow && pnpm --filter @fermeribg/db build && pnpm --filter @fermeribg/api exec tsc -p tsconfig.json --noEmit`
Expected: both succeed (no type errors).

- [ ] **Step 6: Commit**

```bash
git add packages/db/drizzle/0070_courier_orders.sql packages/db/drizzle/meta/_journal.json packages/db/src/schema.ts server/src/modules/orders/orders.service.ts
git commit -m "feat(courier): migration 0070 — delivery_type=courier + orders.farmer_id"
```

---

## Task 2: Courier eligibility helper (pure)

**Files:**
- Create: `server/src/modules/orders/courier-eligibility.ts`
- Test: `server/src/modules/orders/courier-eligibility.spec.ts`

A farmer's carrier credentials live at `tenants.settings.delivery.farmers[<farmerId>].{econt,speedy}` with a `configured: true` flag (set by the Phase 1 connect flow). "Courier ready" = Vasil enabled courier for the farmer AND the farmer has ≥1 connected carrier.

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/orders/courier-eligibility.spec.ts`:

```ts
import { farmerCourierReady, farmerDeliveryNamespace } from './courier-eligibility';

describe('farmerDeliveryNamespace', () => {
  it('reads the per-farmer sub-namespace from tenant settings', () => {
    const settings = { delivery: { farmers: { f1: { econt: { configured: true } } } } };
    expect(farmerDeliveryNamespace(settings, 'f1')).toEqual({ econt: { configured: true } });
  });
  it('returns undefined when absent / settings null', () => {
    expect(farmerDeliveryNamespace(null, 'f1')).toBeUndefined();
    expect(farmerDeliveryNamespace({ delivery: {} }, 'f1')).toBeUndefined();
    expect(farmerDeliveryNamespace({ delivery: { farmers: {} } }, 'f1')).toBeUndefined();
  });
});

describe('farmerCourierReady', () => {
  it('false when courier not enabled, regardless of carriers', () => {
    expect(farmerCourierReady(false, { econt: { configured: true } })).toBe(false);
  });
  it('false when enabled but no connected carrier', () => {
    expect(farmerCourierReady(true, undefined)).toBe(false);
    expect(farmerCourierReady(true, { econt: { configured: false } })).toBe(false);
    expect(farmerCourierReady(true, {})).toBe(false);
  });
  it('true when enabled and econt OR speedy connected', () => {
    expect(farmerCourierReady(true, { econt: { configured: true } })).toBe(true);
    expect(farmerCourierReady(true, { speedy: { configured: true } })).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow && pnpm --filter @fermeribg/api exec jest courier-eligibility -- --silent`
Expected: FAIL ("Cannot find module './courier-eligibility'").

- [ ] **Step 3: Write the implementation**

Create `server/src/modules/orders/courier-eligibility.ts`:

```ts
/**
 * Courier-per-farmer eligibility (Phase 2). A farmer's carrier credentials live
 * in the tenant's settings JSONB under `delivery.farmers[<farmerId>]`, mirroring
 * the tenant-level `delivery.{econt,speedy}` shape, each with a `configured` flag.
 * Pure helpers — used both by the public storefront (to show the Куриер option)
 * and by the checkout backstop (to reject a courier order for an unready farmer).
 */

/** A farmer's carrier sub-namespace inside `tenants.settings.delivery.farmers[id]`. */
export interface FarmerDeliveryNamespace {
  econt?: { configured?: boolean };
  speedy?: { configured?: boolean };
}

interface SettingsWithFarmers {
  delivery?: { farmers?: Record<string, FarmerDeliveryNamespace> };
}

/** Read a farmer's delivery sub-namespace from the tenant `settings` JSONB. */
export function farmerDeliveryNamespace(
  settings: unknown,
  farmerId: string,
): FarmerDeliveryNamespace | undefined {
  return (settings as SettingsWithFarmers | null)?.delivery?.farmers?.[farmerId];
}

/**
 * Whether a farmer can actually ship via courier: Vasil enabled it
 * (`courier_enabled`) AND the farmer has at least one carrier (Econt or Speedy)
 * connected in their sub-namespace.
 */
export function farmerCourierReady(
  courierEnabled: boolean,
  ns: FarmerDeliveryNamespace | undefined,
): boolean {
  if (!courierEnabled) return false;
  return !!(ns?.econt?.configured || ns?.speedy?.configured);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow && pnpm --filter @fermeribg/api exec jest courier-eligibility -- --silent`
Expected: PASS (8 assertions).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/courier-eligibility.ts server/src/modules/orders/courier-eligibility.spec.ts
git commit -m "feat(courier): pure courier-eligibility helper"
```

---

## Task 3: `CreateOrderDto` — courier validation

**Files:**
- Modify: `server/src/modules/orders/dto/create-order.dto.ts`

A courier order needs the recipient address, settlement, name and phone (the carrier label requires all four), and is COD only.

- [ ] **Step 1: Add `'courier'` to the deliveryType enum**

Change both the `@ApiPropertyOptional` enum list and the `@IsEnum` array and the TS type for `deliveryType`:
```ts
  @ApiPropertyOptional({ enum: ['pickup', 'address', 'econt', 'econt_address', 'courier'], default: 'address' })
  @IsOptional()
  @IsEnum(['pickup', 'address', 'econt', 'econt_address', 'courier'])
  deliveryType?: 'pickup' | 'address' | 'econt' | 'econt_address' | 'courier';
```

- [ ] **Step 2: Require address + city for courier**

Extend the existing `@ValidateIf` on `deliveryAddress` to also fire for courier:
```ts
  @ValidateIf((o) => (o.deliveryType ?? 'address') === 'address' || o.deliveryType === 'econt_address' || o.deliveryType === 'courier')
```
Extend the `@ValidateIf` on `deliveryCity` to also fire for courier:
```ts
  @ValidateIf((o) => o.deliveryType === 'econt_address' || o.deliveryType === 'courier')
```

- [ ] **Step 3: Require name + phone for courier**

`customerName` and `customerPhone` are currently `@IsOptional`. For courier they must be present (carrier label). Replace the `@IsOptional()` on each with a courier-aware ValidateIf that still allows omission for non-courier orders. For `customerName`:
```ts
  @ApiPropertyOptional()
  @ValidateIf((o) => o.deliveryType === 'courier')
  @IsString()
  @IsNotEmpty({ message: 'Името е задължително за куриерска доставка' })
  @MaxLength(120)
  customerName?: string;
```
For `customerPhone`:
```ts
  @ApiPropertyOptional()
  @ValidateIf((o) => o.deliveryType === 'courier')
  @IsString()
  @IsNotEmpty({ message: 'Телефонът е задължителен за куриерска доставка' })
  @MaxLength(40)
  customerPhone?: string;
```
> `@ValidateIf` returning false for non-courier skips ALL validators on that property, so name/phone stay optional for pickup/local/Econt — behaviour unchanged for existing methods.

- [ ] **Step 4: Typecheck**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow && pnpm --filter @fermeribg/api exec tsc -p tsconfig.json --noEmit`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/dto/create-order.dto.ts
git commit -m "feat(courier): CreateOrderDto courier validation (address/city/name/phone)"
```

---

## Task 4: Surface `courierReady` on public farmers + cache bust

**Files:**
- Modify: `packages/types/src/index.ts` (`PublicFarmer`)
- Modify: `server/src/modules/farmers/farmers.service.ts` (`findPublicBySlug`)
- Modify: `server/src/modules/econt/econt.controller.ts` + `server/src/modules/speedy/speedy-config.controller.ts` (bust public farmers cache when a FARMER connects/disconnects)

- [ ] **Step 1: Extend the `PublicFarmer` type**

In `packages/types/src/index.ts`:
```ts
export type PublicFarmer = Omit<Farmer, 'tenantId' | 'email' | 'phone'> & {
  images: string[];
  /** Phase 2: farmer offers nationwide courier (courier_enabled AND ≥1 carrier connected). */
  courierReady: boolean;
};
```

- [ ] **Step 2: Compute `courierReady` in `findPublicBySlug`**

In `server/src/modules/farmers/farmers.service.ts`, `findPublicBySlug`. The method already loads farmer `rows` (full select → `courierEnabled` present). It needs the tenant `settings` JSONB to read each farmer's carrier sub-namespace. Add a settings read (the `resolveTenant` cache may not include settings — fetch it explicitly), then set `courierReady` per farmer.

Add imports at top of file:
```ts
import { tenants } from '@fermeribg/db';
import { farmerCourierReady, farmerDeliveryNamespace } from '../orders/courier-eligibility';
```
Inside `findPublicBySlug`, after `rows` are loaded, fetch the settings once and compute readiness in the map:
```ts
    const [tRow] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenant.id))
      .limit(1);
    const settings = tRow?.settings ?? null;

    const result: PublicFarmer[] = rows.map(
      ({ tenantId: _tenantId, email: _email, phone: _phone, ...rest }) => {
        const urls = mediaByFarmer.get(rest.id) ?? [];
        const images = urls.length ? urls : rest.imageUrl ? [rest.imageUrl] : [];
        const courierReady = farmerCourierReady(
          rest.courierEnabled,
          farmerDeliveryNamespace(settings, rest.id),
        );
        return { ...rest, images, courierReady };
      },
    );
```
(Keep the existing `mediaByFarmer`/cache set/return lines.)

- [ ] **Step 3: Bust the public farmers cache on farmer carrier connect/disconnect**

`courierReady` flips when a farmer connects or disconnects a carrier (writes tenant settings, NOT a farmer row), so the `publicCacheKeys.farmers(tenantId)` Redis entry can go stale. In the MAIN-API farmer-facing carrier endpoints, bust that key after a write **when `farmerId` is present** (a marketplace-level connect already busts nothing farmer-related; only farmer connects affect `courierReady`).

In `server/src/modules/econt/econt.controller.ts` POST credentials and DELETE credentials handlers (the `@CurrentFarmer()` ones from Phase 1b), after the service call, when the resolved `farmerId` is set, call the public-cache delete for the farmers key. Mirror in `server/src/modules/speedy/speedy-config.controller.ts`.

Concretely — inject `PublicCacheService` into each controller (it is already provided app-wide; import `PublicCacheService` from `'../../common/cache/public-cache.service'` and `publicCacheKeys` from its module, matching how `farmers.service.ts` imports them), and after a successful credential save/disconnect:
```ts
    if (farmerId) await this.publicCache.del(publicCacheKeys.farmers(tenantId));
```
> Find the exact `publicCacheKeys` import path + `del` signature by reading `server/src/modules/farmers/farmers.service.ts` (it uses both). Use the same.

- [ ] **Step 4: Build types + typecheck server**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow && pnpm --filter @fermeribg/types build && pnpm --filter @fermeribg/api exec tsc -p tsconfig.json --noEmit`
Expected: success.

- [ ] **Step 5: Run farmers service tests**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow && pnpm --filter @fermeribg/api exec jest farmers -- --silent`
Expected: PASS (fix any test that asserts the exact `PublicFarmer` shape by adding `courierReady`).

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/index.ts server/src/modules/farmers/farmers.service.ts server/src/modules/econt/econt.controller.ts server/src/modules/speedy/speedy-config.controller.ts
git commit -m "feat(courier): expose courierReady on public farmers + bust cache on farmer carrier connect"
```

---

## Task 5: Extract `prepareOrderItems` from `OrdersService.create` (refactor)

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts`

The item-validation + availability/variant-stock decrement + pricing block inside `create()`'s transaction is identical to what the courier split needs. Extract it into a private method that returns priced items **with `farmerId`**, leaving `create()`'s behaviour byte-for-byte identical (the existing order suite is the regression guard).

- [ ] **Step 1: Add the `PreparedItem` type + `prepareOrderItems` method**

Near the other private types in `orders.service.ts`, add:
```ts
/** One validated, priced order line ready to insert — plus the owning farmer
 *  (from the product), needed to split a courier cart per farmer. */
interface PreparedItem {
  productId: string;
  productName: string;
  quantity: number;
  priceStotinki: number;
  variantId: string | null;
  variantLabel: string | null;
  farmerId: string | null;
}
```
Add a private method on `OrdersService` containing the EXACT logic currently between the start of the `db.transaction` callback and the `let total = 0; const items = dto.items.map(...)` block — i.e. product load, variant load+lock, productsWithVariants check, per-item validity check, availability-window lock+decrement, variant-stock decrement — then build the priced items attaching `farmerId`:
```ts
  /**
   * Validate + reserve stock + price the cart's items inside an open transaction.
   * Shared by single-order intake ({@link create}) and the courier split
   * ({@link createCourierOrders}). Mutates locked availability windows / variant
   * rows in `tx` (the reservation); returns the priced lines with each line's
   * owning farmer. Throws Bad/Conflict exactly as the inline logic did.
   */
  private async prepareOrderItems(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    tenantId: string,
    dtoItems: CreateOrderDto['items'],
  ): Promise<PreparedItem[]> {
    // ... move the existing block here (products byId, variant lock, windows,
    // variant stock) verbatim, replacing `tenant.id` with `tenantId` and
    // `dto.items` with `dtoItems` ...
    const now = new Date();
    return dtoItems.map((it) => {
      const p = byId.get(it.productId)!;
      const variant = it.variantId ? variantById.get(it.variantId)! : null;
      const line = resolveLineUnit(p, variant, now);
      return {
        productId: p.id,
        productName: line.label,
        quantity: it.quantity,
        priceStotinki: line.unitStotinki,
        variantId: line.variantId,
        variantLabel: line.variantLabel,
        farmerId: p.farmerId ?? null,
      };
    });
  }
```

- [ ] **Step 2: Rewire `create()` to use it**

In `create()`'s transaction, replace the moved block + the `let total = 0; const items = dto.items.map(...)` with:
```ts
      const prepared = await this.prepareOrderItems(tx, tenant.id, dto.items);
      const total = prepared.reduce((s, i) => s + i.priceStotinki * i.quantity, 0);
      const items = prepared.map(({ farmerId: _f, ...line }) => line);
```
Leave the slot lock/capacity check, advisory-lock order-number, `orders` insert, and `orderItems` insert exactly as they are (they consume `items` and `total`).

- [ ] **Step 3: Run the full orders suite (regression)**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow && pnpm --filter @fermeribg/api exec jest orders -- --silent`
Expected: PASS — same count as before the refactor. If anything fails, the extraction changed behaviour; fix until green (no behaviour change is the bar).

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/orders/orders.service.ts
git commit -m "refactor(orders): extract prepareOrderItems (shared by courier split)"
```

---

## Task 6: `OrdersService.createCourierOrders` — the split

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts`
- Test: `server/src/modules/orders/orders.courier.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/orders/orders.courier.spec.ts`. Mirror the harness used by the existing `orders.service.spec.ts` (copy its DB-mock / module setup). Cover:
- A 2-farmer cart → exactly 2 orders, each `deliveryType:'courier'`, `paymentMethod:'cod'`, `farmerId` set, `slotId` null, `carrier` null; each order's `totalStotinki` equals that farmer's line subtotal (no fee); order numbers are sequential.
- A cart whose product has `farmerId: null` → `BadRequestException`.
- A cart farmer who is NOT `courierReady` → `BadRequestException`, and (assert) no orders inserted (tx rolled back).

Reuse the existing spec's mocking patterns for `db.transaction`, `prepareOrderItems` inputs, farmer lookups, and tenant settings. (Read `orders.service.spec.ts` first and copy its scaffolding.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow && pnpm --filter @fermeribg/api exec jest orders.courier -- --silent`
Expected: FAIL (`createCourierOrders` is not a function).

- [ ] **Step 3: Implement `createCourierOrders`**

Add to `OrdersService`. The returned shape carries enough for the storefront's confirmation breakdown.
```ts
  /** One per-farmer COD courier order produced by a split. */
  // (place near the other exported interfaces if reused; otherwise inline)

  /**
   * Courier checkout: split a (possibly multi-farmer) cart into ONE single-farmer
   * COD order per farmer. All-or-nothing in a single transaction — if any farmer
   * is not courier-ready, or any item lacks a farmer, nothing is created (stock
   * reservations roll back). No platform delivery fee: each order's total is that
   * farmer's line subtotal. carrier stays NULL (the farmer picks it at ship time).
   */
  async createCourierOrders(
    slug: string,
    dto: CreateOrderDto,
  ): Promise<(OrderWithItems & { farmerName: string | null })[]> {
    const [tenant] = await this.db
      .select({
        id: tenants.id,
        subscriptionStatus: tenants.subscriptionStatus,
        settings: tenants.settings,
      })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    if (!tenant) throw new NotFoundException('Фермата не е намерена');
    if (tenant.subscriptionStatus === 'inactive') {
      throw new ForbiddenException('Магазинът временно не приема поръчки.');
    }
    // Courier is COD only; the platform never takes courier money by card.
    const cfg = (tenant.settings as { delivery?: DeliveryConfig } | null)?.delivery ?? null;
    if (!codEnabled(cfg)) {
      throw new BadRequestException('Плащането с наложен платеж не е налично.');
    }

    return this.db.transaction(async (tx) => {
      const prepared = await this.prepareOrderItems(tx, tenant.id, dto.items);

      // Every courier line must resolve to a farmer (the split key).
      if (prepared.some((i) => i.farmerId == null)) {
        throw new BadRequestException('Куриерска доставка изисква продукти с фермер.');
      }

      // Group lines by farmer (insertion order preserved → stable order numbering).
      const groups = new Map<string, PreparedItem[]>();
      for (const it of prepared) {
        const fid = it.farmerId!;
        (groups.get(fid) ?? groups.set(fid, []).get(fid)!).push(it);
      }
      const farmerIds = [...groups.keys()];

      // Backstop: every farmer in the cart must be courier-ready (enabled + carrier
      // connected). The storefront already gates on this; re-check server-side so a
      // crafted request can't create an unshippable courier order.
      const farmerRows = await tx
        .select({ id: farmers.id, name: farmers.name, courierEnabled: farmers.courierEnabled })
        .from(farmers)
        .where(and(eq(farmers.tenantId, tenant.id), inArray(farmers.id, farmerIds)));
      const farmerById = new Map(farmerRows.map((f) => [f.id, f]));
      for (const fid of farmerIds) {
        const f = farmerById.get(fid);
        const ready =
          !!f && farmerCourierReady(f.courierEnabled, farmerDeliveryNamespace(tenant.settings, fid));
        if (!ready) {
          throw new BadRequestException('Един от фермерите не предлага куриерска доставка.');
        }
      }

      // Sequential per-tenant order numbers (advisory lock as in create()).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenant.id}, 0))`);
      const [{ nextNumber }] = await tx
        .select({ nextNumber: sql<number>`coalesce(max(${orders.orderNumber}), 0) + 1` })
        .from(orders)
        .where(eq(orders.tenantId, tenant.id));

      const out: (OrderWithItems & { farmerName: string | null })[] = [];
      let n = nextNumber;
      for (const fid of farmerIds) {
        const lines = groups.get(fid)!;
        const total = lines.reduce((s, i) => s + i.priceStotinki * i.quantity, 0);
        const [order] = await tx
          .insert(orders)
          .values({
            tenantId: tenant.id,
            farmerId: fid,
            orderNumber: n++,
            customerName: dto.customerName,
            customerPhone: dto.customerPhone,
            customerEmail: dto.customerEmail,
            slotId: null,
            status: 'pending',
            totalStotinki: total, // no platform delivery fee for courier
            deliveryType: 'courier',
            carrier: null, // farmer picks the carrier at ship time
            deliveryAddress: dto.deliveryAddress ?? null,
            deliveryCity: dto.deliveryCity ?? null,
            deliveryNote: null,
            deliveryLat: null,
            deliveryLng: null,
            econtOffice: null,
            paymentMethod: 'cod',
            notes: dto.notes ?? null,
          })
          .returning();
        const inserted = await tx
          .insert(orderItems)
          .values(lines.map(({ farmerId: _f, ...line }) => ({ ...line, orderId: order.id })))
          .returning();
        out.push({
          ...order,
          slotFrom: null,
          slotTo: null,
          slotDate: null,
          items: inserted,
          farmerName: farmerById.get(fid)?.name ?? null,
        });
      }
      return out;
    });
  }
```
> Ensure `farmers` is imported (it already is, used by `production`) and `farmerCourierReady` / `farmerDeliveryNamespace` are imported from `./courier-eligibility`.

- [ ] **Step 4: Run the courier test**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow && pnpm --filter @fermeribg/api exec jest orders.courier -- --silent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/orders.service.ts server/src/modules/orders/orders.courier.spec.ts
git commit -m "feat(courier): OrdersService.createCourierOrders — split cart into single-farmer COD orders"
```

---

## Task 7: `CheckoutService` routes courier + extends result

**Files:**
- Modify: `server/src/modules/orders/checkout.service.ts`
- Test: `server/src/modules/orders/checkout.service.spec.ts`

- [ ] **Step 1: Extend `CheckoutResult`**

```ts
/** One leg of a courier split — shown on the storefront confirmation page. */
export interface CourierOrderLeg {
  orderId: string;
  orderNumber: number | null;
  farmerId: string | null;
  farmerName: string | null;
  totalStotinki: number;
}

export interface CheckoutResult {
  orderId: string;
  /** Stripe-hosted Checkout URL, or `null` for the cash path (go to confirmation). */
  checkoutUrl: string | null;
  /** Present only for delivery_type='courier' — the N single-farmer COD orders. */
  orders?: CourierOrderLeg[];
}
```

- [ ] **Step 2: Route courier at the top of `create()`**

At the very start of `CheckoutService.create`, before the tenant pre-flight read, branch on courier (it never touches Stripe / shipping fold):
```ts
    if (dto.deliveryType === 'courier') {
      const placed = await this.ordersService.createCourierOrders(slug, dto);
      // COD → final now; send the "received" mail per leg (best-effort, detached).
      for (const o of placed) void this.orderConfirmation.sendReceived(o.id);
      return {
        orderId: placed[0]?.id,
        checkoutUrl: null,
        orders: placed.map((o) => ({
          orderId: o.id,
          orderNumber: o.orderNumber,
          farmerId: o.farmerId,
          farmerName: o.farmerName,
          totalStotinki: o.totalStotinki,
        })),
      };
    }
```

- [ ] **Step 3: Test courier routing**

In `checkout.service.spec.ts`, add a test: with `dto.deliveryType:'courier'`, `CheckoutService.create` calls `ordersService.createCourierOrders` (mock it to return two legs) and returns `{ orderId: leg0.id, checkoutUrl: null, orders: [2 legs] }`, never opening a Stripe session. Reuse the spec's existing mock setup.

- [ ] **Step 4: Run checkout tests**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow && pnpm --filter @fermeribg/api exec jest checkout.service -- --silent`
Expected: PASS.

- [ ] **Step 5: Full server suite + typecheck**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow && pnpm --filter @fermeribg/api exec tsc -p tsconfig.json --noEmit && pnpm --filter @fermeribg/api test -- --silent`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/orders/checkout.service.ts server/src/modules/orders/checkout.service.spec.ts
git commit -m "feat(courier): CheckoutService routes delivery_type=courier to the split (COD, no fee)"
```

---

## Task 8: Storefront types (chaika)

**Files:**
- Modify: `fermerski-pazar-chaika/src/lib/types.ts`

- [ ] **Step 1: Add `courierReady` to the storefront `Farmer` type**

Find the `Farmer` interface (the public farmer shape) and add:
```ts
  /** Phase 2: farmer offers nationwide courier delivery (enabled + carrier connected). */
  courierReady?: boolean;
```

- [ ] **Step 2: Add `'courier'` to the checkout delivery-type union + response**

In the checkout input type (`CreateOrderInput` or equivalent), add `'courier'` to the `deliveryType` union. In the checkout response type (currently `{ orderId, checkoutUrl }`), add:
```ts
  orders?: {
    orderId: string;
    orderNumber: number | null;
    farmerId: string | null;
    farmerName: string | null;
    totalStotinki: number;
  }[];
```

- [ ] **Step 3: Typecheck chaika**

Run: `cd C:\Users\Lenovo\source\repos\fermerski-pazar-chaika && npm run build` (or the repo's typecheck script — check `package.json`).
Expected: success.

- [ ] **Step 4: Commit (in the chaika repo)**

```bash
cd C:\Users\Lenovo\source\repos\fermerski-pazar-chaika
git add src/lib/types.ts
git commit -m "feat(courier): storefront types — courierReady + courier delivery type"
```

---

## Task 9: Storefront — Куриер option + лична доставка info text

**Files:**
- Modify: `fermerski-pazar-chaika/src/pages/checkout.astro`

The delivery picker is at lines ≈78–106 (pickup / address / econt / econt_address). Add a courier option and an info line on the local-delivery option. The option's **visibility** is decided client-side in Task 10 (it depends on cart contents), so render it hidden by default and let the script reveal it.

- [ ] **Step 1: Add the Куриер option markup**

After the existing delivery-option blocks, add (match the surrounding option markup/classes exactly — read the file first):
```html
<label class="delivery-option" data-method="courier" data-courier hidden>
  <input type="radio" name="delivery" value="courier" />
  <span class="delivery-option__title">Куриер · до цялата страна</span>
  <span class="delivery-option__meta">Всеки фермер праща своите продукти · плащаш при доставка (наложен платеж)</span>
</label>
```

- [ ] **Step 2: Add the лична доставка info text**

On the local-delivery option (`data-method="address"`), add a small note clarifying its coverage area:
```html
<span class="delivery-option__meta">само за Варна, Добрич и околностите — или вземане на място от пазара</span>
```
(Place it consistent with how the other options render their `__meta` line.)

- [ ] **Step 3: Build chaika**

Run: `cd C:\Users\Lenovo\source\repos\fermerski-pazar-chaika && npm run build`
Expected: success (the hidden option renders; no behaviour yet).

- [ ] **Step 4: Commit**

```bash
git add src/pages/checkout.astro
git commit -m "feat(courier): storefront — Куриер delivery option + local-delivery coverage note"
```

---

## Task 10: Storefront — eligibility, payload, split response

**Files:**
- Modify: `fermerski-pazar-chaika/src/scripts/checkout-page.ts`

- [ ] **Step 1: Compute courier eligibility and reveal the option**

On checkout init, load the catalog + farmers (via the existing `getBootstrap()` — already cached), map each cart line's `productId → product.farmerId → farmer.courierReady`. Courier is eligible when the cart is non-empty AND **every** distinct farmer in the cart is `courierReady`. Reveal/hide the `[data-courier]` option accordingly:
```ts
import { getBootstrap } from '../lib/api'; // adjust to actual export

async function computeCourierEligible(): Promise<boolean> {
  const cart = Cart.get();
  if (!cart.length) return false;
  const { products, farmers } = await getBootstrap();
  const farmerById = new Map(farmers.map((f) => [f.id, f]));
  const productById = new Map(products.map((p) => [p.id, p]));
  const cartFarmerIds = new Set<string>();
  for (const line of cart) {
    const fid = productById.get(line.id)?.farmerId;
    if (!fid) return false;            // unknown/unattributed product → not eligible
    cartFarmerIds.add(fid);
  }
  return [...cartFarmerIds].every((fid) => farmerById.get(fid)?.courierReady === true);
}

const courierOption = document.querySelector<HTMLElement>('[data-courier]');
const courierEligible = await computeCourierEligible();
if (courierOption) courierOption.hidden = !courierEligible;
```
> Use the repo's actual cart accessor and bootstrap helper names — read `src/lib/cart.ts` and `src/lib/api.ts` first. If a `getBootstrap` isn't already used on the checkout page, prefer it over separate `getProducts()`+`getFarmers()` calls (one cached round trip).

- [ ] **Step 2: Force COD + required fields when courier is selected**

When `method === 'courier'`: hide/disable the card payment choice (courier is COD only) and require the address + city + name + phone fields (the same fields the door-delivery method requires). Reuse the existing field-show/hide logic for `econt_address` (courier needs the same address+city, no slot, no Econt office, no carrier picker).

- [ ] **Step 3: Build the courier payload**

In the payload builder, add a `courier` branch:
```ts
if (method === 'courier') {
  Object.assign(payload, {
    deliveryType: 'courier',
    paymentMethod: 'cod',
    deliveryAddress: addressValue,   // full street + block/entrance, like econt_address
    deliveryCity: cityValue,         // structured city (required)
  });
  // no slotId, no econtOffice, no carrier — the farmer picks the carrier later
}
```

- [ ] **Step 4: Handle the split response**

After the POST to `/checkout`, when the response has `orders` (courier split), stash a breakdown and go to confirmation. Extend the existing `ff_last_order` stash:
```ts
if (data.orders && data.orders.length) {
  sessionStorage.setItem('ff_last_order', JSON.stringify({
    orderId: data.orderId,
    split: data.orders.map((o) => ({
      orderNumber: o.orderNumber,
      farmerName: o.farmerName,
      total: o.totalStotinki,
    })),
    method: 'courier',
  }));
  Cart.set([]);
  window.location.href = `/confirmation?order=${data.orderId}`;
  return;
}
```
(Keep the existing single-order stash/redirect for non-courier methods.)

- [ ] **Step 5: Build chaika**

Run: `cd C:\Users\Lenovo\source\repos\fermerski-pazar-chaika && npm run build`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add src/scripts/checkout-page.ts
git commit -m "feat(courier): storefront — eligibility gate, COD courier payload, split response handling"
```

---

## Task 11: Storefront — confirmation page renders the split

**Files:**
- Modify: `fermerski-pazar-chaika/src/scripts/confirmation-page.ts`

- [ ] **Step 1: Render the per-farmer breakdown**

The confirmation script reads `ff_last_order` from sessionStorage. When `method === 'courier'` and `split` is present, render the breakdown instead of the single-order recap:
```ts
if (recap.method === 'courier' && Array.isArray(recap.split)) {
  // Heading + one line per farmer order.
  const lines = recap.split
    .map((s) => `Поръчка #${s.orderNumber ?? ''} · ${s.farmerName ?? 'фермер'} — ${money(s.total)} (наложен платеж)`)
    .join('<br/>');
  // inject `lines` into the recap container; show the note:
  // "Поръчката е разделена на N пратки — всяка с наложен платеж при доставка."
}
```
Keep the conversion-tracking block working: fire one `purchase` event per split order (or one aggregate) — match the repo's existing GA4/Meta call shape; sum `recap.split[].total` for the aggregate value if firing once.

- [ ] **Step 2: Build chaika**

Run: `cd C:\Users\Lenovo\source\repos\fermerski-pazar-chaika && npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add src/scripts/confirmation-page.ts
git commit -m "feat(courier): storefront — confirmation page renders per-farmer split"
```

---

## Task 12: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Backend — full suite + typecheck**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow && pnpm --filter @fermeribg/db build && pnpm --filter @fermeribg/types build && pnpm --filter @fermeribg/api exec tsc -p tsconfig.json --noEmit && pnpm --filter @fermeribg/api test -- --silent`
Expected: db + types build; tsc clean; full Jest suite green (≥1014 + new courier/eligibility tests).

- [ ] **Step 2: Storefront — typecheck/build**

Run: `cd C:\Users\Lenovo\source\repos\fermerski-pazar-chaika && npm run build`
Expected: success.

- [ ] **Step 3: Reason through the E2E (no live deploy here)**

Confirm by reading the code path end-to-end:
1. Multi-farmer cart, all farmers `courierReady` → Куриер option visible.
2. Pick Куриер → payment forced COD, address+city+name+phone required.
3. POST `/checkout` `deliveryType:'courier'` → `createCourierOrders` → N orders, each single-farmer, `deliveryType:'courier'`, `paymentMethod:'cod'`, `farmerId` set, `carrier`/`slotId` null, total = farmer subtotal (no fee), sequential numbers, atomic.
4. Response `orders[]` → confirmation lists N orders.
5. Backstop: not-ready farmer or unattributed product → 400, nothing created.
6. Non-courier methods unchanged (regression suite green).

- [ ] **Step 4: Dispatch the final code-review subagent** (per subagent-driven-development), then proceed to finishing-a-development-branch.

---

## Self-review notes (author)

- **Spec coverage:** courier option + eligibility (Task 9/10) ✓; cart split into single-farmer COD orders, no fee (Task 6) ✓; `orders.farmer_id` + `delivery_type='courier'` (Task 1) ✓; storefront eligibility = `courier_enabled` AND carrier connected (Task 2/4) ✓. Phase 3 distribution explicitly out of scope.
- **Two-repo coupling:** backend ships the API contract first (Tasks 1–7); storefront consumes it (Tasks 8–11). The new response field `orders?` is additive — deploying the backend before the storefront is safe (old storefront ignores it; courier option only appears once chaika ships).
- **Regression guard:** Task 5 is a pure extraction; the existing orders suite must stay green at the same count. Courier never touches the Stripe/shipping-fold path.
- **Type consistency:** `delivery_type` enum widening (Task 1) forces the two hand-written unions to widen (same task); `PublicFarmer.courierReady` added in types + producer + consumer (Task 4/8).
