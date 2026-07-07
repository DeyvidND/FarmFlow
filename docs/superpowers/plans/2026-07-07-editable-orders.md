# Fully Editable Order Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the farmer edit an order (contact, delivery values, slot, notes, line items) in place from the existing OrderPanel via a single "Редактирай" toggle + one `PATCH /orders/:id`.

**Architecture:** New owner-only `PATCH /orders/:id` endpoint → `OrdersService.updateOrder`, which sets scalar fields (geocoding a changed address), reassigns the slot with a capacity check, and — for unpaid/COD orders — replaces the line items (restoring old stock, re-reserving new stock via the existing `reserveCartItems`, and recomputing the total while preserving the folded-in delivery fee). Frontend flips `OrderDetailBody` into a form; Запази sends one PATCH and swaps the returned order back in.

**Tech Stack:** NestJS + Drizzle (Postgres) backend; Next.js (React, TypeScript, Tailwind) client; Jest for backend unit/integration specs; `sonner` toasts; `lucide-react` icons.

## Global Constraints

- All money is integer stotinki (EUR cents); never floats. `total = itemsSubtotal + shipping`, and shipping is **folded into `totalStotinki`**, never stored separately — preserve it as `shipping = prevTotal − prevSubtotal`.
- Editing is allowed only for orders with status `pending` or `confirmed`. `delivered`/`cancelled` reject.
- Card-paid orders (`paidAt ≠ null`) reject **item/total** edits; other fields still edit.
- Delivery **method** (`deliveryType`) is NOT switchable in this feature — edit values within the current type only.
- Full edit endpoint is **owner-only** (`@Roles('admin')`), unlike the farmer-scoped `/status` and `/cod-outcome`.
- UI copy is Bulgarian, matching the existing panel (e.g. `Редактирай`, `Запази`, `Откажи`, `Слотът е запълнен`).
- No DB migration — every target column already exists on `orders` / `order_items`.
- Follow existing patterns: `apiFetch` + `json()` in `api-client.ts`; class-validator DTOs; Drizzle row locks acquired in id-order (deadlock-free) inside one transaction.

---

## File Structure

- `server/src/modules/orders/dto/update-order.dto.ts` — **new** `UpdateOrderDto`.
- `server/src/modules/orders/order-total.util.ts` — **new** pure `recomputeTotalStotinki` + `subtotalStotinki` helpers (unit-testable, no DB).
- `server/src/modules/orders/order-total.util.spec.ts` — **new** unit tests for the helpers.
- `server/src/modules/orders/orders.service.ts` — add `updateOrder`, `updateOrderForItems` internals, extract `restoreAvailabilityWindows` (shared with the cancel branch) + `restoreVariantStock`.
- `server/src/modules/orders/orders.controller.ts` — add `PATCH :id`.
- `server/src/modules/orders/orders.update.spec.ts` — **new** guard + slot-conflict tests (mock DB, early-return style).
- `server/src/modules/orders/dto/update-order.dto.spec.ts` — **new** DTO validation tests.
- `client/src/lib/types.ts` — add `UpdateOrderInput`.
- `client/src/lib/api-client.ts` — add `updateOrder`.
- `client/src/components/orders/order-panel.tsx` — edit-mode toggle + form (contact, delivery, slot, notes, items).
- `client/src/components/orders/order-edit-fields.tsx` — **new** the edit-form field groups (keeps `order-panel.tsx` focused).
- `client/src/components/orders/orders-client.tsx` — pass an `onSaved` callback into `OrderPanel`.

---

## Task 1: Pure total helpers + UpdateOrderDto

**Files:**
- Create: `server/src/modules/orders/order-total.util.ts`
- Create: `server/src/modules/orders/order-total.util.spec.ts`
- Create: `server/src/modules/orders/dto/update-order.dto.ts`
- Create: `server/src/modules/orders/dto/update-order.dto.spec.ts`

**Interfaces:**
- Produces: `subtotalStotinki(items: { quantity: number; priceStotinki: number }[]): number`
- Produces: `recomputeTotalStotinki(prevTotal: number, prevSubtotal: number, newSubtotal: number): number`
- Produces: `class UpdateOrderDto` — all optional: `customerName?`, `customerPhone?`, `customerEmail?`, `deliveryAddress?`, `deliveryNote?`, `econtOffice?`, `slotId?: string | null`, `notes?`, `items?: CreateOrderItemDto[]`.

- [ ] **Step 1: Write the failing test for the total helpers**

Create `server/src/modules/orders/order-total.util.spec.ts`:

```ts
import { subtotalStotinki, recomputeTotalStotinki } from './order-total.util';

describe('subtotalStotinki', () => {
  it('sums quantity × unit price', () => {
    expect(
      subtotalStotinki([
        { quantity: 2, priceStotinki: 500 },
        { quantity: 1, priceStotinki: 350 },
      ]),
    ).toBe(1350);
  });
  it('empty cart → 0', () => {
    expect(subtotalStotinki([])).toBe(0);
  });
});

describe('recomputeTotalStotinki', () => {
  it('preserves the folded-in delivery fee', () => {
    // prev: subtotal 1000 + fee 300 = 1300; new subtotal 1200 → 1200 + 300
    expect(recomputeTotalStotinki(1300, 1000, 1200)).toBe(1500);
  });
  it('no fee (subtotal == total) carries nothing extra', () => {
    expect(recomputeTotalStotinki(1000, 1000, 400)).toBe(400);
  });
  it('never treats a negative gap as a fee (clamps to 0)', () => {
    // Legacy/odd row where total < subtotal — do not add a negative fee.
    expect(recomputeTotalStotinki(900, 1000, 500)).toBe(500);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx jest order-total.util --silent`
Expected: FAIL — `Cannot find module './order-total.util'`.

- [ ] **Step 3: Implement the helpers**

Create `server/src/modules/orders/order-total.util.ts`:

```ts
/** Sum of quantity × unit price over order lines (the items subtotal, stotinki). */
export function subtotalStotinki(
  items: { quantity: number; priceStotinki: number }[],
): number {
  return items.reduce((s, i) => s + i.quantity * i.priceStotinki, 0);
}

/**
 * Recompute an order total after its items changed, preserving the delivery fee.
 * The fee is never stored on its own — it was folded into `totalStotinki` at
 * checkout (`total = subtotal + shipping`). So we recover it as `prevTotal −
 * prevSubtotal` (clamped ≥ 0 for odd legacy rows) and re-add it to the new
 * subtotal. We do NOT re-quote the carrier — the original shipping stands.
 */
export function recomputeTotalStotinki(
  prevTotal: number,
  prevSubtotal: number,
  newSubtotal: number,
): number {
  const shipping = Math.max(0, prevTotal - prevSubtotal);
  return newSubtotal + shipping;
}
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `cd server && npx jest order-total.util --silent`
Expected: PASS (5 assertions).

- [ ] **Step 5: Write the failing DTO test**

Create `server/src/modules/orders/dto/update-order.dto.spec.ts`:

```ts
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateOrderDto } from './update-order.dto';

async function errsFor(payload: unknown): Promise<string[]> {
  const dto = plainToInstance(UpdateOrderDto, payload);
  const errors = await validate(dto as object, { whitelist: true });
  return errors.map((e) => e.property);
}

describe('UpdateOrderDto', () => {
  it('accepts an empty patch (all fields optional)', async () => {
    expect(await errsFor({})).toEqual([]);
  });
  it('accepts a contact-only patch', async () => {
    expect(await errsFor({ customerName: 'Иван', customerPhone: '0888000000' })).toEqual([]);
  });
  it('accepts slotId: null (clear the slot)', async () => {
    expect(await errsFor({ slotId: null })).toEqual([]);
  });
  it('rejects a non-uuid slotId', async () => {
    expect(await errsFor({ slotId: 'not-a-uuid' })).toContain('slotId');
  });
  it('rejects an item with quantity < 1', async () => {
    expect(await errsFor({ items: [{ productId: '11111111-1111-1111-1111-111111111111', quantity: 0 }] })).toContain('items');
  });
  it('rejects an empty items array', async () => {
    expect(await errsFor({ items: [] })).toContain('items');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd server && npx jest update-order.dto --silent`
Expected: FAIL — `Cannot find module './update-order.dto'`.

- [ ] **Step 7: Implement the DTO**

Create `server/src/modules/orders/dto/update-order.dto.ts`:

```ts
import {
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CreateOrderItemDto } from './create-order-item.dto';

/**
 * Owner-side full order edit (PATCH /orders/:id). Every field is optional — a
 * partial patch. `items`, when present, is a FULL replacement of the order's
 * lines (min 1). `slotId: null` clears the slot; a uuid reassigns it. Delivery
 * *method* is intentionally NOT editable here.
 */
export class UpdateOrderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  customerPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  customerEmail?: string | null;

  @ApiPropertyOptional({ description: 'Street address (local / Econt-door / courier).' })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  deliveryAddress?: string;

  @ApiPropertyOptional({ description: 'Block/entrance/floor/flat detail (бл./вх.).' })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  deliveryNote?: string | null;

  @ApiPropertyOptional({ description: 'Econt office display string (econt type).' })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  econtOffice?: string;

  @ApiPropertyOptional({ description: 'Reassign (uuid) or clear (null) the delivery slot.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  slotId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @ApiPropertyOptional({ type: [CreateOrderItemDto], description: 'Full replacement of the order lines (min 1).' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  items?: CreateOrderItemDto[];
}
```

- [ ] **Step 8: Run the DTO test to verify it passes**

Run: `cd server && npx jest update-order.dto --silent`
Expected: PASS (6 assertions).

- [ ] **Step 9: Commit**

```bash
git add server/src/modules/orders/order-total.util.ts server/src/modules/orders/order-total.util.spec.ts server/src/modules/orders/dto/update-order.dto.ts server/src/modules/orders/dto/update-order.dto.spec.ts
git commit -m "feat(orders): UpdateOrderDto + fee-preserving total helpers"
```

---

## Task 2: `updateOrder` service — scalar fields, guards, slot reassign (no items) + endpoint

Delivers a working edit for everything except line items: contact, address (+geocode), note, econtOffice, notes, and slot reassignment — plus the `PATCH :id` route and the client `updateOrder` call.

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts` (add `updateOrder`)
- Modify: `server/src/modules/orders/orders.controller.ts` (add `PATCH :id`)
- Modify: `client/src/lib/api-client.ts` (add `updateOrder`)
- Modify: `client/src/lib/types.ts` (add `UpdateOrderInput`)
- Create: `server/src/modules/orders/orders.update.spec.ts`

**Interfaces:**
- Consumes: `UpdateOrderDto` (Task 1); existing `serializeOrder`, `orderWithSlot`, `attachItems`, `SerializedOrder`, `Tx`, `MapsService.geocode`, `MapsService.geocodeCity`.
- Produces: `OrdersService.updateOrder(id: string, tenantId: string, dto: UpdateOrderDto): Promise<SerializedOrder>`
- Produces: client `updateOrder(id: string, body: UpdateOrderInput): Promise<Order>` and type `UpdateOrderInput`.

- [ ] **Step 1: Write the failing guard tests**

Create `server/src/modules/orders/orders.update.spec.ts`:

```ts
/**
 * Guard tests for OrdersService.updateOrder — these all short-circuit BEFORE the
 * transaction, so the DB mock only needs to answer the initial order load.
 */
import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';

/** Minimal db mock whose first (and only) select resolves to `[orderRow]`. */
function serviceWithOrder(orderRow: Record<string, unknown>): OrdersService {
  const chain: any = {};
  chain.from = () => chain;
  chain.leftJoin = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve([orderRow]);
  const db: any = { select: () => chain };
  // Only `db` and `maps` are touched on the guard paths.
  const maps: any = { geocode: jest.fn(), geocodeCity: jest.fn() };
  return new OrdersService(db, maps, {} as any, {} as any, {} as any, {} as any, {} as any);
}

const BASE = {
  id: 'order-1',
  tenantId: 'tenant-1',
  status: 'confirmed',
  paidAt: null,
  deliveryType: 'address',
  totalStotinki: 1000,
  slotId: null,
  slotFrom: null,
  slotTo: null,
  slotDate: null,
};

describe('updateOrder guards', () => {
  it('rejects editing a delivered order', async () => {
    const svc = serviceWithOrder({ ...BASE, status: 'delivered' });
    await expect(svc.updateOrder('order-1', 'tenant-1', { customerName: 'Х' })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects editing a cancelled order', async () => {
    const svc = serviceWithOrder({ ...BASE, status: 'cancelled' });
    await expect(svc.updateOrder('order-1', 'tenant-1', { customerName: 'Х' })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects item edits on a card-paid order', async () => {
    const svc = serviceWithOrder({ ...BASE, paidAt: new Date() });
    await expect(
      svc.updateOrder('order-1', 'tenant-1', { items: [{ productId: '11111111-1111-1111-1111-111111111111', quantity: 1 }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx jest orders.update --silent`
Expected: FAIL — `svc.updateOrder is not a function`.

- [ ] **Step 3: Add `updateOrder` (scalar + slot; items guarded but not yet implemented)**

In `server/src/modules/orders/orders.service.ts`, add the import for the DTO near the other DTO imports (after `UpdateCodOutcomeDto` import at line ~32):

```ts
import { UpdateOrderDto } from './dto/update-order.dto';
```

**Note:** `slotIsFull(booked: number, capacity: number): boolean` from `../slots/slot-rule` is ALREADY imported in this file (concurrent slot-capacity work landed it) — do not re-import it, just use it. The slot's `capacity` column already exists on `deliverySlots` (`slot.capacity`).

and add the method right after `findOne` (after line 950):

```ts
  /**
   * Owner-side full order edit. Sets whatever scalar fields the patch carries
   * (re-geocoding a changed address), reassigns the slot with a one-per-slot
   * capacity check, and (Task 3) replaces the line items. Rejects on closed
   * orders and on item edits of a card-paid order. Returns the serialized order.
   */
  async updateOrder(id: string, tenantId: string, dto: UpdateOrderDto): Promise<SerializedOrder> {
    const [current] = await this.db
      .select(orderWithSlot)
      .from(orders)
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)))
      .limit(1);
    if (!current) throw new NotFoundException('Поръчката не е намерена');

    // Guard: closed orders are read-only history.
    if (current.status === 'delivered' || current.status === 'cancelled') {
      throw new BadRequestException('Доставените и отказаните поръчки не могат да се редактират.');
    }
    // Guard: a card-paid order's money is fixed — no item/total changes.
    if (dto.items && current.paidAt) {
      throw new BadRequestException('Платена поръчка — артикулите не могат да се променят.');
    }

    // Geocode a changed address OUTSIDE the transaction (no network under a lock).
    // Local delivery needs coords for the route; Econt-door/courier need a city.
    const geocodes = current.deliveryType === 'address';
    const needsCity = current.deliveryType === 'econt_address' || current.deliveryType === 'courier';
    const addressChanged =
      dto.deliveryAddress !== undefined && dto.deliveryAddress !== current.deliveryAddress;
    let newLat: string | null | undefined;
    let newLng: string | null | undefined;
    let newCity: string | null | undefined;
    if (addressChanged && dto.deliveryAddress && (geocodes || needsCity)) {
      const [tenant] = await this.db
        .select({ farmLat: tenants.farmLat, farmLng: tenants.farmLng })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      const fLat = tenant?.farmLat == null ? null : Number(tenant.farmLat);
      const fLng = tenant?.farmLng == null ? null : Number(tenant.farmLng);
      const bias = fLat != null && fLng != null ? { lat: fLat, lng: fLng } : undefined;
      if (geocodes) {
        const geo = await this.maps.geocode(dto.deliveryAddress, bias);
        if (geo) {
          newLat = String(geo.lat);
          newLng = String(geo.lng);
        }
      } else {
        newCity = (await this.maps.geocodeCity(dto.deliveryAddress, bias)) ?? undefined;
      }
    }

    await this.db.transaction(async (tx) => {
      // Slot reassign — only when slotId is present in the patch and differs.
      if (dto.slotId !== undefined && dto.slotId !== current.slotId) {
        if (dto.slotId !== null) {
          const [slot] = await tx
            .select()
            .from(deliverySlots)
            .where(and(eq(deliverySlots.id, dto.slotId), eq(deliverySlots.tenantId, tenantId)))
            .for('update')
            .limit(1);
          if (!slot) throw new BadRequestException('Слотът не е намерен');
          if (slot.date === bgToday()) throw new BadRequestException('Слотът вече не е достъпен за днес');
          const [{ count }] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(orders)
            .where(and(eq(orders.slotId, dto.slotId), ne(orders.status, 'cancelled'), ne(orders.id, id)));
          if (slotIsFull(count, slot.capacity)) throw new ConflictException('Слотът е запълнен');
        }
      }

      // Scalar fields: only those present in the patch.
      const set: Partial<typeof orders.$inferInsert> = {};
      if (dto.customerName !== undefined) set.customerName = dto.customerName;
      if (dto.customerPhone !== undefined) set.customerPhone = dto.customerPhone;
      if (dto.customerEmail !== undefined) set.customerEmail = dto.customerEmail;
      if (dto.deliveryAddress !== undefined) set.deliveryAddress = dto.deliveryAddress;
      if (dto.deliveryNote !== undefined) set.deliveryNote = dto.deliveryNote;
      if (dto.econtOffice !== undefined) set.econtOffice = dto.econtOffice;
      if (dto.notes !== undefined) set.notes = dto.notes;
      if (dto.slotId !== undefined && dto.slotId !== current.slotId) set.slotId = dto.slotId;
      if (newLat !== undefined) set.deliveryLat = newLat;
      if (newLng !== undefined) set.deliveryLng = newLng;
      if (newCity !== undefined) set.deliveryCity = newCity;

      // Items replacement is implemented in Task 3.

      if (Object.keys(set).length > 0) {
        await tx.update(orders).set(set).where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)));
      }
    });

    await this.bustPayments(tenantId);
    return this.findOne(id, tenantId);
  }
```

- [ ] **Step 4: Run the guard tests to verify they pass**

Run: `cd server && npx jest orders.update --silent`
Expected: PASS (3 assertions).

- [ ] **Step 5: Add the controller route**

In `server/src/modules/orders/orders.controller.ts`, add the DTO import near the others:

```ts
import { UpdateOrderDto } from './dto/update-order.dto';
```

and add this handler inside `OrdersController` after `setCodOutcome` (after line 134):

```ts
  // Owner-only full order edit (contact / delivery values / slot / notes / items).
  // Unlike /status and /cod-outcome this is NOT opened to producer sub-accounts.
  @Patch(':id')
  @Roles('admin')
  updateOrder(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: UpdateOrderDto,
  ) {
    return this.ordersService.updateOrder(id, tenantId, dto);
  }
```

- [ ] **Step 6: Verify the server compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Add the client type + api call**

In `client/src/lib/types.ts`, add after the `Order` interface (after line 714):

```ts
/** Payload for PATCH /orders/:id — every field optional. `items` replaces all
 *  lines; `slotId: null` clears the slot. */
export interface UpdateOrderInput {
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string | null;
  deliveryAddress?: string;
  deliveryNote?: string | null;
  econtOffice?: string;
  slotId?: string | null;
  notes?: string | null;
  items?: { productId: string; quantity: number; variantId?: string }[];
}
```

In `client/src/lib/api-client.ts`, add after `updateOrderStatus` (after line 545). Make sure `UpdateOrderInput` is included in the type import from `@/lib/types`:

```ts
export const updateOrder = (id: string, body: UpdateOrderInput) =>
  apiFetch<Order>(`orders/${id}`, { method: 'PATCH', ...json(body) }, 'Неуспешно записване на поръчката');
```

- [ ] **Step 8: Verify the client compiles**

Run: `cd client && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add server/src/modules/orders/orders.service.ts server/src/modules/orders/orders.controller.ts server/src/modules/orders/orders.update.spec.ts client/src/lib/api-client.ts client/src/lib/types.ts
git commit -m "feat(orders): PATCH /orders/:id edits contact/address/slot/notes"
```

---

## Task 3: Item replacement — extract restore helpers, re-reserve, recompute total

Adds the line-item half of `updateOrder`: restore the old items' reserved stock (availability windows + variant stock), re-reserve the new items via the existing `reserveCartItems` locking path (passing `slotId=null` so its slot block is skipped — slot is handled separately in Task 2), swap `order_items`, and recompute `totalStotinki` preserving the delivery fee.

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts`
- Modify: `server/src/modules/orders/orders.update.spec.ts` (add a restore-helper unit test)

**Interfaces:**
- Consumes: existing `reserveCartItems(tx, tenantId, dtoItems, slotId, carrierDelivery)`, `restoreRemaining`, `decideDecrement`, `subtotalStotinki` + `recomputeTotalStotinki` (Task 1), `orderItems`, `productAvailabilityWindows`, `productVariants`.
- Produces: `private restoreAvailabilityWindows(tx: Tx, tenantId: string, items: { productId: string | null; quantity: number }[]): Promise<void>` — the window-restore logic extracted verbatim from the cancel branch.
- Produces: `private restoreVariantStock(tx: Tx, items: { variantId: string | null; quantity: number }[]): Promise<void>`.

- [ ] **Step 1: Extract `restoreAvailabilityWindows` and reuse it in the cancel branch**

In `orders.service.ts`, add this private method (e.g. just above `reserveCartItems`, near line 1272). Copy the exact window-restore body currently inline in `updateStatus`'s cancel branch (lines ~1004-1038):

```ts
  /**
   * Return each item's reserved stock to its active availability window
   * (best-effort — only while the window is still active; expired windows left
   * as-is). Extracted from the cancel branch so the order-edit path can reuse it.
   * Caller must run this inside an open transaction.
   */
  private async restoreAvailabilityWindows(
    tx: Tx,
    tenantId: string,
    items: { productId: string | null; quantity: number }[],
  ): Promise<void> {
    const today = bgToday();
    const restoreProductIds = items.map((it) => it.productId).filter((p): p is string => !!p);
    if (!restoreProductIds.length) return;
    const activeWindows = await tx
      .select()
      .from(productAvailabilityWindows)
      .where(
        and(
          inArray(productAvailabilityWindows.productId, restoreProductIds),
          eq(productAvailabilityWindows.tenantId, tenantId),
          lte(productAvailabilityWindows.startsAt, today),
          gte(productAvailabilityWindows.endsAt, today),
        ),
      )
      .for('update')
      .orderBy(asc(productAvailabilityWindows.productId));
    const winByProduct = new Map(activeWindows.map((w) => [w.productId, w]));
    for (const it of items) {
      if (!it.productId) continue;
      const win = winByProduct.get(it.productId);
      if (win) win.remaining = restoreRemaining(win, it.quantity);
    }
    for (const w of activeWindows) {
      await tx
        .update(productAvailabilityWindows)
        .set({ remaining: w.remaining })
        .where(eq(productAvailabilityWindows.id, w.id));
    }
  }
```

Then in `updateStatus`'s cancel `tx` block, replace the inline window-restore (the `const today = bgToday();` line down through the closing `for (const w of activeWindows) { ... }` loop, i.e. lines ~1004-1038) with a call:

```ts
        const items = await tx
          .select()
          .from(orderItems)
          .where(eq(orderItems.orderId, id));
        await this.restoreAvailabilityWindows(tx, tenantId, items);
```

- [ ] **Step 2: Run the existing status/cancel tests to prove the refactor is behavior-preserving**

Run: `cd server && npx jest orders.status --silent && cd server && npx jest orders.service --silent`
Expected: PASS (cancel-path stock restore unchanged). If a cancel test exercised the inline body, it still passes because the extracted method is identical.

- [ ] **Step 3: Add `restoreVariantStock` and a unit test for the shared restore**

Add the variant-restore helper below `restoreAvailabilityWindows`:

```ts
  /**
   * Add each variant line's quantity back to its variant stock counter (NULL =
   * unlimited, skipped). Rows locked in id order (deadlock-free). Used by the
   * order-edit path — variant stock is decremented by reserveCartItems, so an
   * edit that drops/reduces a variant line must return that stock.
   */
  private async restoreVariantStock(
    tx: Tx,
    items: { variantId: string | null; quantity: number }[],
  ): Promise<void> {
    const variantIds = items.map((it) => it.variantId).filter((v): v is string => !!v);
    if (!variantIds.length) return;
    const rows = await tx
      .select()
      .from(productVariants)
      .where(inArray(productVariants.id, variantIds))
      .for('update')
      .orderBy(asc(productVariants.id));
    const byId = new Map(rows.map((v) => [v.id, v]));
    const add = new Map<string, number>();
    for (const it of items) {
      if (it.variantId) add.set(it.variantId, (add.get(it.variantId) ?? 0) + it.quantity);
    }
    for (const v of rows) {
      if (v.stockQuantity == null) continue; // unlimited
      const restored = v.stockQuantity + (add.get(v.id) ?? 0);
      await tx.update(productVariants).set({ stockQuantity: restored }).where(eq(productVariants.id, v.id));
    }
  }
```

Append to `server/src/modules/orders/orders.update.spec.ts`:

```ts
describe('restoreVariantStock (via a captured tx)', () => {
  it('adds quantities back per variant, skips unlimited (null) stock', async () => {
    const updates: Array<{ id: string; stockQuantity: number }> = [];
    const rows = [
      { id: 'v1', stockQuantity: 2 },
      { id: 'v2', stockQuantity: null },
    ];
    const tx: any = {
      select: () => ({
        from: () => ({ where: () => ({ for: () => ({ orderBy: () => Promise.resolve(rows) }) }) }),
      }),
      update: () => ({
        set: (vals: { stockQuantity: number }) => ({
          where: (_: unknown) => {
            updates.push({ id: 'captured', stockQuantity: vals.stockQuantity });
            return Promise.resolve();
          },
        }),
      }),
    };
    const svc: any = new OrdersService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await svc.restoreVariantStock(tx, [
      { variantId: 'v1', quantity: 3 },
      { variantId: 'v2', quantity: 1 },
    ]);
    // Only v1 (finite stock) is written: 2 + 3 = 5. v2 (null) is skipped.
    expect(updates).toEqual([{ id: 'captured', stockQuantity: 5 }]);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd server && npx jest orders.update --silent`
Expected: FAIL — `svc.restoreVariantStock is not a function` (only if Step 3 helper not yet saved) OR PASS once the helper is in. If you added the helper in Step 3 already, this test should PASS; if you are strictly TDD-ing, write the test before the helper body.

- [ ] **Step 5: Implement the item-replacement block inside `updateOrder`**

In `updateOrder`, replace the `// Items replacement is implemented in Task 3.` comment (inside the transaction, before the scalar `set` flush) with:

```ts
      // Items replacement — restore old stock, re-reserve new, swap rows, recompute
      // total (preserving the folded-in delivery fee). Slot is handled above, so we
      // pass slotId=null to reserveCartItems (its slot block is skipped for null).
      if (dto.items) {
        const oldItems = await tx.select().from(orderItems).where(eq(orderItems.orderId, id));
        await this.restoreAvailabilityWindows(tx, tenantId, oldItems);
        await this.restoreVariantStock(tx, oldItems);

        const carrierDelivery =
          current.deliveryType === 'econt' ||
          current.deliveryType === 'econt_address' ||
          current.deliveryType === 'courier';
        const { items: prepared } = await this.reserveCartItems(tx, tenantId, dto.items, null, carrierDelivery);
        const lines = prepared.map(({ farmerId: _f, ...line }) => line);

        await tx.delete(orderItems).where(eq(orderItems.orderId, id));
        await tx.insert(orderItems).values(lines.map((l) => ({ ...l, orderId: id })));

        const prevSubtotal = subtotalStotinki(oldItems);
        const newSubtotal = subtotalStotinki(prepared);
        set.totalStotinki = recomputeTotalStotinki(current.totalStotinki, prevSubtotal, newSubtotal);
      }
```

Add the helper import near the top of `orders.service.ts` (after the `order-scheduling` import at line ~39):

```ts
import { subtotalStotinki, recomputeTotalStotinki } from './order-total.util';
```

- [ ] **Step 6: Verify the server compiles and all order tests pass**

Run: `cd server && npx tsc --noEmit && npx jest orders --silent`
Expected: no type errors; all `orders*` specs PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/orders/orders.service.ts server/src/modules/orders/orders.update.spec.ts
git commit -m "feat(orders): edit line items with stock restore + fee-preserving total"
```

---

## Task 4: Frontend — edit-mode toggle + contact/notes editing

Adds the "Редактирай" toggle, the Запази/Откажи footer, the save round-trip, and the first (simplest) editable fields: customer name/phone/email and notes. Verified live in the preview.

**Files:**
- Modify: `client/src/components/orders/order-panel.tsx`
- Create: `client/src/components/orders/order-edit-fields.tsx`
- Modify: `client/src/components/orders/orders-client.tsx`

**Interfaces:**
- Consumes: `updateOrder`, `UpdateOrderInput` (Task 2); existing `Order`, `OrderStatus`.
- Produces: `OrderPanel` gains an `onSaved: (updated: Order) => void` prop; `orders-client.tsx` passes it.
- Produces: `ContactNotesFields` component in `order-edit-fields.tsx` — `{ draft, setDraft }` where `draft` is the editable subset.

- [ ] **Step 1: Add an `onSaved` prop + edit state to OrderPanel**

In `order-panel.tsx`, extend the `OrderPanel` props and imports:

```ts
import { useState } from 'react';
import { X, Phone, Mail, MapPin, Package, CalendarClock, Check, Truck, CreditCard, ExternalLink, Pencil } from 'lucide-react';
import { ApiError, requestDeliveryHandoff, setCodOutcome, updateOrder } from '@/lib/api-client';
import type { Order, UpdateOrderInput } from '@/lib/types';
import { OrderEditForm } from './order-edit-fields';
```

Change the component signature to accept `onSaved`:

```ts
export function OrderPanel({
  order,
  busy,
  onClose,
  onAction,
  onSaved,
}: {
  order: Order;
  busy?: boolean;
  onClose: () => void;
  onAction: (status: OrderStatus) => void;
  onSaved: (updated: Order) => void;
}) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const editable = order.status === 'pending' || order.status === 'confirmed';
```

- [ ] **Step 2: Add the Редактирай header button + swap the body/footer in edit mode**

In the header block, add the pencil button next to the close button (only when `editable && !editing`):

```tsx
          <div className="flex items-center gap-2">
            {editable && !editing && (
              <button
                onClick={() => setEditing(true)}
                aria-label="Редактирай"
                className="grid h-10 w-10 place-items-center rounded-[11px] border border-ff-border bg-ff-surface-2 text-ff-ink-2"
              >
                <Pencil size={18} />
              </button>
            )}
            <button onClick={onClose} aria-label="Затвори" className="grid h-10 w-10 place-items-center rounded-[11px] border border-ff-border bg-ff-surface-2 text-ff-ink-2">
              <X size={20} />
            </button>
          </div>
```

Replace `<OrderDetailBody key={order.id} order={order} />` with a conditional, and pass a save handler:

```tsx
        {editing ? (
          <OrderEditForm
            key={order.id}
            order={order}
            saving={saving}
            onCancel={() => setEditing(false)}
            onSave={async (patch: UpdateOrderInput) => {
              setSaving(true);
              try {
                const updated = await updateOrder(order.id, patch);
                onSaved(updated);
                setEditing(false);
                toast.success('Запазено');
              } catch (e) {
                toast.error(e instanceof ApiError ? e.message : 'Възникна грешка');
              } finally {
                setSaving(false);
              }
            }}
          />
        ) : (
          <OrderDetailBody key={order.id} order={order} />
        )}
```

Wrap the existing footer action cluster (the `<div className="flex flex-col gap-2.5 border-t ...">` block) so it renders only when `!editing`:

```tsx
        {!editing && (
          <div className="flex flex-col gap-2.5 border-t border-ff-border-2 px-6 py-5">
            {/* …existing status buttons + status select unchanged… */}
          </div>
        )}
```

(The Запази/Откажи footer lives inside `OrderEditForm` so the form owns its own submit.)

- [ ] **Step 3: Create the edit form shell with contact + notes fields**

Create `client/src/components/orders/order-edit-fields.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Order, UpdateOrderInput } from '@/lib/types';

/** Local editable draft of an order. Delivery method is fixed; only its values
 *  (address/note/office) + contact + notes are here. Items/slot added in later
 *  tasks. */
interface Draft {
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  notes: string;
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-ff-muted">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-sm border border-ff-border bg-ff-surface-2 px-2.5 py-2 text-sm font-semibold text-ff-ink outline-none transition-colors focus:border-ff-green-500"
      />
    </label>
  );
}

export function OrderEditForm({
  order,
  saving,
  onCancel,
  onSave,
}: {
  order: Order;
  saving: boolean;
  onCancel: () => void;
  onSave: (patch: UpdateOrderInput) => void;
}) {
  const [draft, setDraft] = useState<Draft>({
    customerName: order.customerName ?? '',
    customerPhone: order.customerPhone ?? '',
    customerEmail: order.customerEmail ?? '',
    notes: order.notes ?? '',
  });

  const phoneValid = draft.customerPhone.trim().length > 0;

  function submit() {
    if (!phoneValid) return;
    onSave({
      customerName: draft.customerName.trim(),
      customerPhone: draft.customerPhone.trim(),
      customerEmail: draft.customerEmail.trim() || null,
      notes: draft.notes.trim() || null,
    });
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mb-2.5 text-[13px] font-bold text-ff-muted">КЛИЕНТ</div>
        <div className="mb-5 flex flex-col gap-3">
          <Field label="Име" value={draft.customerName} onChange={(v) => setDraft((d) => ({ ...d, customerName: v }))} />
          <Field label="Телефон" value={draft.customerPhone} onChange={(v) => setDraft((d) => ({ ...d, customerPhone: v }))} />
          {!phoneValid && <span className="text-xs font-semibold text-red-600">Телефонът е задължителен</span>}
          <Field label="Имейл" type="email" value={draft.customerEmail} onChange={(v) => setDraft((d) => ({ ...d, customerEmail: v }))} />
        </div>

        <div className="mb-2.5 text-[13px] font-bold text-ff-muted">БЕЛЕЖКА</div>
        <textarea
          value={draft.notes}
          onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
          rows={3}
          className="w-full rounded-sm border border-ff-border bg-ff-surface-2 px-2.5 py-2 text-sm text-ff-ink outline-none transition-colors focus:border-ff-green-500"
        />
      </div>

      <div className="flex gap-2.5 border-t border-ff-border-2 px-6 py-5">
        <Button variant="primary" disabled={saving || !phoneValid} onClick={submit} className="flex-1 rounded-sm">
          Запази
        </Button>
        <Button variant="soft" disabled={saving} onClick={onCancel} className="flex-1 rounded-sm">
          Откажи
        </Button>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Wire `onSaved` in orders-client.tsx**

In `orders-client.tsx`, update the OrderPanel render (line ~336) to replace the local row on save:

```tsx
        <OrderPanel
          order={active}
          busy={busy}
          onClose={() => setActiveId(null)}
          onAction={(s) => onAction(active, s)}
          onSaved={(updated) => {
            setOrders((p) => p.map((x) => (x.id === updated.id ? updated : x)));
          }}
        />
```

- [ ] **Step 5: Verify the client compiles**

Run: `cd client && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Verify live in the preview**

Start the client dev server via `preview_start` (create `.claude/launch.json` if missing, per the dashboard app's dev command). Then:
- Open an order, click Редактирай (`preview_click` on `[aria-label="Редактирай"]`).
- `preview_snapshot` → confirm the Име/Телефон/Имейл/Бележка form + Запази/Откажи render.
- Change the phone (`preview_fill`), click Запази, `preview_snapshot` → confirm the panel returns to read-only with the new phone, and `preview_console_logs` shows no errors.
- `preview_screenshot` for the record.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/orders/order-panel.tsx client/src/components/orders/order-edit-fields.tsx client/src/components/orders/orders-client.tsx
git commit -m "feat(orders): editable contact + notes in the order panel"
```

---

## Task 5: Frontend — delivery values + slot editing

Adds, to `OrderEditForm`, the delivery-value inputs (per current type) and a slot picker built from the farm's real upcoming free slots.

**Files:**
- Modify: `client/src/components/orders/order-edit-fields.tsx`

**Interfaces:**
- Consumes: `listSlots(from, to)` → `Slot[]` (`{ id, date, timeFrom, timeTo, booked, ... }`); existing `hhmm`, `relDayLabel` from `@/lib/utils`.
- Produces: extends the `Draft` and the emitted `UpdateOrderInput` with `deliveryAddress`/`deliveryNote`/`econtOffice`/`slotId`.

- [ ] **Step 1: Load upcoming free slots on mount**

At the top of `OrderEditForm`, add slot loading (only relevant for local-delivery `address` orders — the only type that consumes a slot):

```tsx
import { useEffect } from 'react';
import { listSlots } from '@/lib/api-client';
import { hhmm, relDayLabel } from '@/lib/utils';
import type { Slot } from '@/lib/types';
```

```tsx
  const usesSlot = order.deliveryType === 'address';
  const [slots, setSlots] = useState<Slot[]>([]);
  useEffect(() => {
    if (!usesSlot) return;
    const today = new Date();
    const to = new Date();
    to.setDate(today.getDate() + 14);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    listSlots(iso(today), iso(to))
      .then((all) =>
        // Free slots only (booked === 0), never today, plus keep the order's own
        // current slot so it stays selectable even if now full by itself.
        setSlots(all.filter((s) => s.date !== iso(today) && (s.booked === 0 || s.id === order.slotId))),
      )
      .catch(() => setSlots([]));
  }, [usesSlot, order.slotId]);
```

- [ ] **Step 2: Extend the Draft with delivery + slot fields**

Extend the `Draft` interface and its initial state:

```ts
interface Draft {
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  notes: string;
  deliveryAddress: string;
  deliveryNote: string;
  econtOffice: string;
  slotId: string | null;
}
```

```ts
  const [draft, setDraft] = useState<Draft>({
    customerName: order.customerName ?? '',
    customerPhone: order.customerPhone ?? '',
    customerEmail: order.customerEmail ?? '',
    notes: order.notes ?? '',
    deliveryAddress: order.deliveryAddress ?? '',
    deliveryNote: order.deliveryNote ?? '',
    econtOffice: order.econtOffice ?? '',
    slotId: order.slotId ?? null,
  });
```

Note: the client `Order` interface (`client/src/lib/types.ts` ~line 686) does NOT declare `slotId`, so **add** `slotId: string | null;` to it (next to `slotDate`/`slotFrom`/`slotTo`). The API already sends it — `serializeOrder` returns every order column via `orderWithSlot` → `getTableColumns(orders)`).

- [ ] **Step 3: Render the delivery + slot section**

Add, between the КЛИЕНТ block and the БЕЛЕЖКА block:

```tsx
        <div className="mb-2.5 text-[13px] font-bold text-ff-muted">ДОСТАВКА</div>
        <div className="mb-5 flex flex-col gap-3">
          {(order.deliveryType === 'address' ||
            order.deliveryType === 'econt_address' ||
            order.deliveryType === 'courier') && (
            <>
              <Field label="Адрес" value={draft.deliveryAddress} onChange={(v) => setDraft((d) => ({ ...d, deliveryAddress: v }))} />
              <Field label="Бл./вх./ет./ап." value={draft.deliveryNote} onChange={(v) => setDraft((d) => ({ ...d, deliveryNote: v }))} />
            </>
          )}
          {order.deliveryType === 'econt' && (
            <Field label="Еконт офис" value={draft.econtOffice} onChange={(v) => setDraft((d) => ({ ...d, econtOffice: v }))} />
          )}
          {order.deliveryType === 'pickup' && (
            <div className="text-sm font-semibold text-ff-ink-2">Вземане от място</div>
          )}
          {usesSlot && (
            <label className="block">
              <span className="text-xs font-semibold text-ff-muted">Ден и час</span>
              <select
                value={draft.slotId ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, slotId: e.target.value || null }))}
                className="mt-1 w-full rounded-sm border border-ff-border bg-ff-surface-2 px-2.5 py-2 text-sm font-semibold text-ff-ink outline-none focus:border-ff-green-500"
              >
                <option value="">Без час</option>
                {slots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {relDayLabel(s.date)} · {hhmm(s.timeFrom)} – {hhmm(s.timeTo)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
```

- [ ] **Step 4: Include the new fields in the saved patch**

Update `submit()`:

```ts
  function submit() {
    if (!phoneValid) return;
    const patch: UpdateOrderInput = {
      customerName: draft.customerName.trim(),
      customerPhone: draft.customerPhone.trim(),
      customerEmail: draft.customerEmail.trim() || null,
      notes: draft.notes.trim() || null,
    };
    if (order.deliveryType === 'address' || order.deliveryType === 'econt_address' || order.deliveryType === 'courier') {
      patch.deliveryAddress = draft.deliveryAddress.trim();
      patch.deliveryNote = draft.deliveryNote.trim() || null;
    }
    if (order.deliveryType === 'econt') patch.econtOffice = draft.econtOffice.trim();
    if (usesSlot) patch.slotId = draft.slotId;
    onSave(patch);
  }
```

- [ ] **Step 5: Verify the client compiles**

Run: `cd client && npx tsc --noEmit`
Expected: no errors (if `Order.slotId` was missing, adding it in Step 2 resolves it).

- [ ] **Step 6: Verify live in the preview**

- Open a local-delivery order, Редактирай → confirm Адрес / Бл. / Ден и час (`<select>`) render; `preview_snapshot`.
- Change the slot to another free option, Запази, `preview_snapshot` → the panel's "Ден и час за доставка" row reflects the new window.
- Open an Econt-office order, Редактирай → confirm the "Еконт офис" field shows instead of address/slot.
- `preview_console_logs` clean; `preview_screenshot`.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/orders/order-edit-fields.tsx client/src/lib/types.ts
git commit -m "feat(orders): edit delivery address/office + reassign slot"
```

---

## Task 6: Frontend — line-item editing (qty, remove, add product) with paid-lock

Adds the editable ПРОДУКТИ block: quantity steppers, remove, an "Добави продукт" picker, a live subtotal/total, and the card-paid read-only lock.

**Files:**
- Modify: `client/src/components/orders/order-edit-fields.tsx`

**Interfaces:**
- Consumes: `listProducts()` → `Paginated<Product>` (`Product` has `id`, `name`, `priceStotinki`, `weight`); `listProductVariants(productId)` → `ProductVariant[]`; `moneyFromStotinki` from `@/lib/utils`.
- Produces: `items` in the emitted `UpdateOrderInput`.

- [ ] **Step 1: Add an editable items draft (skip entirely for paid orders)**

Add imports and item state:

```tsx
import { Plus, Minus, Trash2 } from 'lucide-react';
import { listProducts, listProductVariants } from '@/lib/api-client';
import { moneyFromStotinki } from '@/lib/utils';
import type { Product, ProductVariant } from '@/lib/types';
```

```tsx
  // Card-paid orders lock item/total edits (money already captured).
  const itemsLocked = order.paymentStatus === 'paid';

  interface DraftItem {
    productId: string;
    variantId?: string;
    productName: string; // display snapshot for the row
    quantity: number;
    priceStotinki: number; // preview only; server re-prices on save
  }
  const [items, setItems] = useState<DraftItem[]>(
    order.items.map((it) => ({
      productId: it.productId,
      variantId: it.variantId ?? undefined,
      productName: it.productName,
      quantity: it.quantity,
      priceStotinki: it.priceStotinki,
    })),
  );
```

Note: `OrderItem` (`client/src/lib/types.ts` ~line 481) has `productId: string | null`, `productName`, `quantity`, `priceStotinki` — but NOT `variantId`. **Add** `variantId: string | null;` to `OrderItem` (the API sends it — `attachItems` returns the full `ItemRow`). Because `productId` is nullable, guard when seeding the draft: skip any legacy line with a null `productId` — `order.items.filter((it) => it.productId != null).map(...)` — so `DraftItem.productId` stays a non-null `string` (the DTO requires a uuid).

- [ ] **Step 2: Render the items block with steppers + remove + subtotal/total**

Add before the БЕЛЕЖКА block:

```tsx
        <div className="mb-2.5 flex items-center justify-between">
          <span className="text-[13px] font-bold text-ff-muted">ПРОДУКТИ</span>
          {itemsLocked && <span className="text-xs font-semibold text-ff-muted">Платена поръчка — заключено</span>}
        </div>
        <div className="mb-4 overflow-hidden rounded-xl border border-ff-border-2">
          {items.map((it, i) => (
            <div key={`${it.productId}-${it.variantId ?? ''}-${i}`} className={`flex items-center justify-between gap-2 px-3.5 py-2.5 ${i < items.length - 1 ? 'border-b border-ff-border-2' : ''}`}>
              <span className="flex-1 text-sm font-semibold">{it.productName}</span>
              {itemsLocked ? (
                <span className="text-[13.5px] font-bold text-ff-muted">× {it.quantity}</span>
              ) : (
                <div className="flex items-center gap-1.5">
                  <button aria-label="Намали" onClick={() => setItems((p) => p.map((x, j) => (j === i ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x)))} className="grid h-7 w-7 place-items-center rounded-sm border border-ff-border bg-ff-surface-2">
                    <Minus size={14} />
                  </button>
                  <span className="w-7 text-center text-sm font-bold">{it.quantity}</span>
                  <button aria-label="Увеличи" onClick={() => setItems((p) => p.map((x, j) => (j === i ? { ...x, quantity: x.quantity + 1 } : x)))} className="grid h-7 w-7 place-items-center rounded-sm border border-ff-border bg-ff-surface-2">
                    <Plus size={14} />
                  </button>
                  <button aria-label="Премахни" onClick={() => setItems((p) => p.filter((_, j) => j !== i))} className="grid h-7 w-7 place-items-center rounded-sm border border-ff-border bg-ff-surface-2 text-red-600">
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        {!itemsLocked && <AddProductRow onAdd={(item) => setItems((p) => [...p, item])} />}
        <div className="mb-5 mt-3 flex items-center justify-between px-1">
          <span className="text-[15px] font-bold">Общо (без доставка)</span>
          <span className="ff-fig text-lg font-extrabold">{moneyFromStotinki(items.reduce((s, x) => s + x.quantity * x.priceStotinki, 0))}</span>
        </div>
```

- [ ] **Step 3: Implement the AddProductRow picker**

Add this component at the bottom of `order-edit-fields.tsx`:

```tsx
/** Compact "add a product" control: search the catalog, pick a product (+ variant
 *  when it has them), append it as a new order line. Prices are for preview only;
 *  the server re-prices on save. */
function AddProductRow({
  onAdd,
}: {
  onAdd: (item: { productId: string; variantId?: string; productName: string; quantity: number; priceStotinki: number }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Product | null>(null);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [variantId, setVariantId] = useState<string>('');

  useEffect(() => {
    if (open && products.length === 0) listProducts().then((r) => setProducts(r.items)).catch(() => setProducts([]));
  }, [open, products.length]);

  async function choose(p: Product) {
    setPicked(p);
    const vs = await listProductVariants(p.id).catch(() => []);
    setVariants(vs);
    setVariantId('');
  }

  function confirm() {
    if (!picked) return;
    if (variants.length > 0 && !variantId) return; // must pick a variant
    const v = variants.find((x) => x.id === variantId) ?? null;
    onAdd({
      productId: picked.id,
      variantId: v?.id,
      productName: [picked.name, v?.label ?? picked.weight].filter(Boolean).join(' '),
      quantity: 1,
      priceStotinki: v?.priceStotinki ?? picked.priceStotinki,
    });
    setOpen(false);
    setPicked(null);
    setVariants([]);
    setQ('');
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="flex w-full items-center justify-center gap-1.5 rounded-sm border border-dashed border-ff-border py-2 text-[13px] font-bold text-ff-green-700">
        <Plus size={15} /> Добави продукт
      </button>
    );
  }

  const filtered = q ? products.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())) : products;

  return (
    <div className="rounded-sm border border-ff-border bg-ff-surface-2 p-3">
      {!picked ? (
        <>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Търси продукт…" className="mb-2 w-full rounded-sm border border-ff-border bg-ff-surface px-2.5 py-1.5 text-sm outline-none focus:border-ff-green-500" />
          <div className="max-h-44 overflow-y-auto">
            {filtered.map((p) => (
              <button key={p.id} onClick={() => void choose(p)} className="flex w-full items-center justify-between px-2 py-1.5 text-left text-sm hover:bg-ff-surface">
                <span>{p.name}</span>
                <span className="text-ff-muted">{moneyFromStotinki(p.priceStotinki)}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="mb-2 text-sm font-bold">{picked.name}</div>
          {variants.length > 0 && (
            <select value={variantId} onChange={(e) => setVariantId(e.target.value)} className="mb-2 w-full rounded-sm border border-ff-border bg-ff-surface px-2.5 py-1.5 text-sm outline-none focus:border-ff-green-500">
              <option value="">Избери вариант…</option>
              {variants.map((v) => (
                <option key={v.id} value={v.id}>{v.label} · {moneyFromStotinki(v.priceStotinki)}</option>
              ))}
            </select>
          )}
          <div className="flex gap-2">
            <Button variant="primary" onClick={confirm} disabled={variants.length > 0 && !variantId} className="flex-1 rounded-sm py-1.5 text-[13px]">Добави</Button>
            <Button variant="soft" onClick={() => setPicked(null)} className="rounded-sm py-1.5 text-[13px]">Назад</Button>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Include items in the saved patch (only when unlocked + changed)**

In `submit()`, before `onSave(patch)`:

```ts
    if (!itemsLocked) {
      patch.items = items.map((it) => ({ productId: it.productId, quantity: it.quantity, ...(it.variantId ? { variantId: it.variantId } : {}) }));
    }
```

Guard the submit button so an empty cart can't be saved — extend the disabled check and `phoneValid`:

```ts
  const cartValid = itemsLocked || items.length > 0;
```

and in the Запази button `disabled={saving || !phoneValid || !cartValid}`.

- [ ] **Step 5: Verify the client compiles**

Run: `cd client && npx tsc --noEmit`
Expected: no errors (add missing `OrderItem` fields per Step 1 note if flagged).

- [ ] **Step 6: Verify live in the preview**

- Open an unpaid/COD order, Редактирай → the ПРОДУКТИ rows show −/＋/trash; bump a qty, `preview_snapshot` → the "Общо (без доставка)" updates.
- Click Добави продукт, search, pick a product (+ variant if prompted), Добави → new row appears.
- Запази → `preview_snapshot` confirms the read-only panel shows the new item list and the list-row total changed; `preview_console_logs` clean.
- Open a **card-paid** order (`paymentStatus: 'paid'`), Редактирай → ПРОДУКТИ shows "Платена поръчка — заключено", no steppers, no Добави продукт. Contact/address still editable.
- `preview_screenshot` of both.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/orders/order-edit-fields.tsx client/src/lib/types.ts
git commit -m "feat(orders): edit line items (qty/add/remove) with paid-order lock"
```

---

## Self-Review

**1. Spec coverage**

- Contact edit → Task 2 (backend) + Task 4 (UI). ✅
- Address edit + re-geocode → Task 2 (`updateOrder` geocode block). ✅
- Econt office edit → Task 2 (scalar set) + Task 5 (UI). ✅
- Slot reassign + capacity/today guard, exclude-self → Task 2 (slot block, `ne(orders.id, id)`). ✅
- Notes edit → Task 2 + Task 4. ✅
- Items replace, stock restore (windows + variant) + re-reserve + fee-preserving total → Tasks 1 & 3. ✅
- Skip slot re-check on item edit → Task 3 passes `slotId=null` to `reserveCartItems` (its `if (slotId)` block is skipped), matching the spec's intent without a signature change. ✅
- Guards: closed status reject, card-paid item reject → Task 2. ✅
- Single "Редактирай" toggle, Запази/Откажи, one PATCH → Task 4. ✅
- Owner-only endpoint → Task 2 controller `@Roles('admin')`. ✅
- Delivery-method switch out of scope → enforced by UI (fields keyed on `order.deliveryType`, no type selector) and backend (no `deliveryType` in DTO). ✅
- Testing: pure helpers + DTO + guards unit-tested; deep tx behavior driven live in preview (repo has only mock-DB specs, no real e2e harness — documented tradeoff). ✅

**2. Placeholder scan** — no TBD/TODO; every code step carries full code. The only "confirm the type exposes X" notes (Order.slotId, OrderItem fields) include the exact fallback (add the field), not a vague deferral.

**3. Type consistency** — `updateOrder(id, tenantId, dto)` signature identical across service/controller/spec. `UpdateOrderInput` (client) mirrors `UpdateOrderDto` (server). `recomputeTotalStotinki(prevTotal, prevSubtotal, newSubtotal)` and `subtotalStotinki(items)` names match between Task 1 (def), Task 1 tests, and Task 3 (use). `restoreAvailabilityWindows` / `restoreVariantStock` names consistent between Task 3 def, cancel-branch reuse, and item block. `onSaved` prop consistent between Task 4 OrderPanel and orders-client.

One correction applied vs the spec: the spec proposed a `slotCheck?: { skip?: boolean }` param on `reserveCartItems`; the plan instead passes `slotId=null` (which already skips the slot block), avoiding a signature change to a function shared with checkout — simpler and lower-risk. Behavior is identical.
