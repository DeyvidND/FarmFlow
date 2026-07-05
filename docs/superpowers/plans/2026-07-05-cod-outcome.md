# COD Outcome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give наложен-платеж (COD) orders a first-class money outcome (received / refused) decoupled from fulfillment status, auto-driven from courier signals for Econt/Speedy and manual for pickup/own delivery, surfaced as badges and wired into cod-risk on refusal.

**Architecture:** New nullable `cod_outcome` enum + audit columns on `orders`. Courier status refresh (`refreshStatusForRow` in Econt + Speedy) sets the outcome from real delivered/returned signals without clobbering a manual override. A new `PATCH orders/:id/cod-outcome` endpoint handles pickup/own-delivery orders manually and re-uses cod-risk on refusal for all modes. The Плащания screen's collected/settlement badge and the order-panel gain a 4-state COD view.

**Tech Stack:** NestJS + Drizzle ORM (PostgreSQL), hand-written SQL migrations (no drizzle-kit snapshots past 0059), Next.js client (React), Jest.

## Global Constraints

- Migrations are HAND-WRITTEN: a `.sql` file in `packages/db/drizzle/` + an entry in `packages/db/drizzle/meta/_journal.json`. No `*_snapshot.json` (snapshots stopped at 0059). Next index is **0078**.
- Money outcome is ORTHOGONAL to `orders.status`. Never re-derive "collected" from `status === 'delivered'` in new code — read `codOutcome`.
- Courier sync must be idempotent + no-clobber: update the order outcome only `WHERE cod_outcome IS NULL`. A manual override is authoritative.
- Courier-side and manual-refusal cod-risk writes must be best-effort (a failure never fails the parent operation) and single-strike per source event.
- Only `paymentMethod='cod'` orders have an outcome. The manual endpoint rejects non-COD (400).
- All Bulgarian UI copy stays in Bulgarian. Follow existing file patterns.

---

### Task 1: DB migration + schema — `cod_outcome` enum, columns, backfill

**Files:**
- Modify: `packages/db/src/schema.ts` (enum near `orderStatusEnum` line 21-28; columns on `orders` table near line 384; export list near line 1014)
- Create: `packages/db/drizzle/0078_orders_cod_outcome.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`

**Interfaces:**
- Produces: `codOutcomeEnum` (pgEnum `'cod_outcome'` = `['received','refused']`); `orders.codOutcome` (`'received'|'refused'|null`), `orders.codOutcomeAt` (Date|null), `orders.codOutcomeReason` (string|null), `orders.codOutcomeSource` (string|null). Consumed by Tasks 2, 3, 4.

- [ ] **Step 1: Add the enum and columns to the schema**

In `packages/db/src/schema.ts`, after the `orderStatusEnum` block (line 28), add:

```typescript
export const codOutcomeEnum = pgEnum('cod_outcome', ['received', 'refused']);
```

Inside the `orders` table definition, immediately after the `paidAt` column (line 384), add:

```typescript
    // Наложен платеж (COD) money outcome — orthogonal to `status` (fulfillment).
    // NULL = Очаквано (pending). Set from a real courier signal (source='courier')
    // or a manual click (source='manual'); a manual value is authoritative and is
    // never overwritten by a later courier refresh. Only meaningful for
    // payment_method='cod'. See migration 0078.
    codOutcome: codOutcomeEnum('cod_outcome'),
    codOutcomeAt: timestamp('cod_outcome_at', { withTimezone: true }),
    codOutcomeReason: text('cod_outcome_reason'),
    codOutcomeSource: text('cod_outcome_source'),
```

In the enum export block (near line 1014, alongside `orderStatusEnum`), add `codOutcomeEnum,`.

- [ ] **Step 2: Write the migration SQL**

Create `packages/db/drizzle/0078_orders_cod_outcome.sql`:

```sql
DO $$ BEGIN
  CREATE TYPE "cod_outcome" AS ENUM('received', 'refused');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cod_outcome" "cod_outcome";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cod_outcome_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cod_outcome_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cod_outcome_source" text;--> statement-breakpoint
UPDATE "orders"
   SET "cod_outcome" = 'received',
       "cod_outcome_at" = COALESCE("paid_at", "created_at"),
       "cod_outcome_source" = 'manual'
 WHERE "payment_method" = 'cod' AND "status" = 'delivered' AND "cod_outcome" IS NULL;
```

- [ ] **Step 3: Register the migration in the journal**

In `packages/db/drizzle/meta/_journal.json`, append to the `entries` array (after the `0077_orders_visitor_hash` entry, keeping valid JSON — add a comma after the previous `}`):

```json
    {
      "idx": 78,
      "version": "7",
      "when": 1783328406000,
      "tag": "0078_orders_cod_outcome",
      "breakpoints": true
    }
```

- [ ] **Step 4: Verify schema compiles + migration parses**

Run: `ctx-wire run bash -lc "cd packages/db && npx tsc --noEmit -p tsconfig.json"`
Expected: PASS (no type errors). If the package has no standalone tsconfig, run the repo build for the db package per its `package.json` `build` script instead.

Manually re-read the `.sql` file: confirm every `ADD COLUMN` is `IF NOT EXISTS` and the backfill filters on `payment_method='cod' AND status='delivered'`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0078_orders_cod_outcome.sql packages/db/drizzle/meta/_journal.json
git commit -m "feat(db): cod_outcome enum + columns on orders (migration 0078)"
```

---

### Task 2: cod-risk `recordManualRefusal`

**Files:**
- Modify: `server/src/modules/cod-risk/cod-risk.service.ts` (add method after `recordReturnIfApplicable`, ~line 336; imports at line 3)
- Test: `server/src/modules/cod-risk/cod-risk.service.spec.ts` (create if absent; otherwise add cases)

**Interfaces:**
- Consumes: `orders.$inferSelect` (from Task 1 the row carries `codOutcome`), `normalizePhone` (already imported), `codRisk`, `codRiskEvents`.
- Produces: `async recordManualRefusal(order: typeof orders.$inferSelect): Promise<void>` — records exactly one strike keyed on `normalizePhone(order.customerPhone)` and one `codRiskEvents` row (`type: 'returned'`, `shipmentId: null`). Idempotent per order: caller only invokes it on the NULL→refused transition, and the method no-ops when phone can't be normalized. Consumed by Task 3.

- [ ] **Step 1: Write the failing test**

In `server/src/modules/cod-risk/cod-risk.service.spec.ts` add (mirror the existing spec's DB-mock setup; if the file doesn't exist, create it following `nekorekten.client.spec.ts` style with a mocked `Database`):

```typescript
describe('recordManualRefusal', () => {
  it('records a strike keyed on the order customer phone', async () => {
    const order = { id: 'o1', tenantId: 't1', customerPhone: '0888 123 456' } as any;
    await service.recordManualRefusal(order);
    // codRisk upsert called with the normalized phone + lastEventType 'returned'
    expect(insertedCodRiskValues).toMatchObject({ phone: '359888123456', strikes: 1, lastEventType: 'returned' });
    expect(insertedEvent).toMatchObject({ phone: '359888123456', tenantId: 't1', type: 'returned', shipmentId: null });
  });

  it('no-ops when the phone cannot be normalized', async () => {
    const order = { id: 'o2', tenantId: 't1', customerPhone: '' } as any;
    await service.recordManualRefusal(order);
    expect(insertedCodRiskValues).toBeUndefined();
  });
});
```

(Adjust the normalized-phone expectation to whatever `normalizePhone('0888 123 456')` actually returns — verify by reading `cod-risk.helpers.ts`. Capture `insertedCodRiskValues` / `insertedEvent` via the DB mock's `.insert().values()` spy, same as existing cod-risk specs.)

- [ ] **Step 2: Run test to verify it fails**

Run: `ctx-wire run bash -lc "cd server && npx jest cod-risk.service --silent"`
Expected: FAIL with "recordManualRefusal is not a function".

- [ ] **Step 3: Implement the method**

In `cod-risk.service.ts`, after `recordReturnIfApplicable` (line 336), add:

```typescript
  /** Manual COD refusal (pickup / own-delivery orders, or a courier override to
   *  refused). Records a single strike keyed on the order's customer phone — the
   *  order-less parallel of {@link recordReturnIfApplicable}. The caller guarantees
   *  single invocation per order (only on the NULL→refused transition), so this does
   *  not need its own compare-and-set claim. Best-effort: the caller wraps it. */
  async recordManualRefusal(order: typeof orders.$inferSelect): Promise<void> {
    const phone = normalizePhone(order.customerPhone ?? '');
    if (!phone) return;
    await this.db
      .insert(codRisk)
      .values({ phone, strikes: 1, lastEventType: 'returned', lastEventAt: new Date() })
      .onConflictDoUpdate({
        target: codRisk.phone,
        set: {
          strikes: sql`${codRisk.strikes} + 1`,
          lastEventType: 'returned',
          lastEventAt: new Date(),
          updatedAt: new Date(),
        },
      });
    await this.db
      .insert(codRiskEvents)
      .values({ phone, tenantId: order.tenantId, shipmentId: null, type: 'returned' });
  }
```

Confirm `codRiskEvents.shipmentId` is nullable in `schema.ts`; if it is `.notNull()`, drop the field from the insert (the column then defaults) — read the schema to decide.

- [ ] **Step 4: Run tests to verify they pass**

Run: `ctx-wire run bash -lc "cd server && npx jest cod-risk.service --silent"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/cod-risk/cod-risk.service.ts server/src/modules/cod-risk/cod-risk.service.spec.ts
git commit -m "feat(cod-risk): recordManualRefusal keyed on order phone"
```

---

### Task 3: Manual endpoint + serialization — `setCodOutcome`, DTO, controller, PaymentOrder

**Files:**
- Create: `server/src/modules/orders/dto/update-cod-outcome.dto.ts`
- Modify: `server/src/modules/orders/orders.service.ts` (`toPaymentOrder` ~196-220 + `PaymentRow`/`PaymentOrder` types ~112-186; payments select ~499-516 and the farmer payments select ~591; new `setCodOutcome` method after `updateStatusForFarmer` ~858)
- Modify: `server/src/modules/orders/orders.controller.ts` (new `PATCH :id/cod-outcome` route)
- Modify: `server/src/modules/orders/orders.module.ts` (ensure `CodRiskService` is injectable into `OrdersService` — import `CodRiskModule` if not already)
- Test: `server/src/modules/orders/orders.payments.spec.ts` (extend for `codOutcome`)

**Interfaces:**
- Consumes: `codRisk.recordManualRefusal` (Task 2); `orders.codOutcome*` (Task 1).
- Produces: `UpdateCodOutcomeDto { outcome: 'received'|'refused'; reason?: string }`; `OrdersService.setCodOutcome(id, tenantId, dto)` and `setCodOutcomeForFarmer(id, tenantId, farmerId, dto)` returning the updated `OrderRow`; `PaymentOrder.codOutcome`/`codOutcomeReason` fields. Consumed by Tasks 5-8.

- [ ] **Step 1: Write the DTO**

Create `server/src/modules/orders/dto/update-cod-outcome.dto.ts`:

```typescript
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateCodOutcomeDto {
  @ApiProperty({ enum: ['received', 'refused'] })
  @IsEnum(['received', 'refused'])
  outcome: 'received' | 'refused';

  @ApiPropertyOptional({ description: 'Причина при отказ (свободен текст)' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
```

- [ ] **Step 2: Write the failing test for `toPaymentOrder` carrying `codOutcome`**

In `orders.payments.spec.ts`, extend the `row(...)` helper's base with `codOutcome: null, codOutcomeReason: null` and add:

```typescript
it('passes codOutcome + reason through', () => {
  const o = toPaymentOrder(row({ paymentMethod: 'cod', codOutcome: 'refused', codOutcomeReason: 'не вдигна' }));
  expect(o.codOutcome).toBe('refused');
  expect(o.codOutcomeReason).toBe('не вдигна');
});

it('derives collected from codOutcome for COD (not status)', () => {
  expect(toPaymentOrder(row({ paymentMethod: 'cod', status: 'delivered', codOutcome: null })).collected).toBe(false);
  expect(toPaymentOrder(row({ paymentMethod: 'cod', status: 'confirmed', codOutcome: 'received' })).collected).toBe(true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `ctx-wire run bash -lc "cd server && npx jest orders.payments --silent"`
Expected: FAIL (`codOutcome` undefined; `collected` still keyed off `status`).

- [ ] **Step 4: Extend the payment types + `toPaymentOrder`**

In `orders.service.ts`, add to the `PaymentOrder` interface (after `collected`, ~line 123) and to `PaymentRow` (~line 175-186):

```typescript
  codOutcome: 'received' | 'refused' | null;
  codOutcomeReason: string | null;
```

Rewrite `toPaymentOrder`'s `collected` derivation (line 214) to key COD off the outcome:

```typescript
    collected: r.paymentMethod === 'cod' ? r.codOutcome === 'received' : paid,
    codOutcome: r.codOutcome,
    codOutcomeReason: r.codOutcomeReason,
```

Add `codOutcome: orders.codOutcome,` and `codOutcomeReason: orders.codOutcomeReason,` to BOTH payments selects (the tenant select ~line 508 and the farmer-scoped select ~line 591 — grep `deliveryType: orders.deliveryType` to find both).

- [ ] **Step 5: Write the `setCodOutcome` service methods**

In `orders.service.ts`, after `updateStatusForFarmer` (line 858), add. Inject `CodRiskService` via the constructor (add `private readonly codRisk: CodRiskService`) and import it:

```typescript
  /** Set a COD order's money outcome (received / refused). Manual path used by
   *  pickup + own-delivery orders and by a courier-order override. Strike on
   *  the NULL→refused transition only (idempotent re-marks add no strike). */
  async setCodOutcome(
    id: string,
    tenantId: string,
    dto: UpdateCodOutcomeDto,
  ): Promise<OrderRow> {
    const [prev] = await this.db
      .select({ paymentMethod: orders.paymentMethod, codOutcome: orders.codOutcome })
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)))
      .limit(1);
    if (!prev) throw new NotFoundException('Поръчката не е намерена');
    if (prev.paymentMethod !== 'cod') {
      throw new BadRequestException('Само поръчки с наложен платеж имат статус на плащане.');
    }
    const [row] = await this.db
      .update(orders)
      .set({
        codOutcome: dto.outcome,
        codOutcomeAt: new Date(),
        codOutcomeReason: dto.outcome === 'refused' ? (dto.reason ?? null) : null,
        codOutcomeSource: 'manual',
      })
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)))
      .returning();
    if (!row) throw new NotFoundException('Поръчката не е намерена');
    // Strike only on the first transition into refused (best-effort — a cod-risk
    // failure must not fail the outcome write).
    if (dto.outcome === 'refused' && prev.codOutcome !== 'refused') {
      try {
        await this.codRisk.recordManualRefusal(row);
      } catch {
        /* best-effort: leave the outcome recorded even if the strike fails */
      }
    }
    await this.bustPayments(tenantId);
    return row;
  }

  /** Producer-scoped variant: a sub-account may set the outcome only on an order
   *  that is entirely their own (same IDOR gate as updateStatusForFarmer). */
  async setCodOutcomeForFarmer(
    id: string,
    tenantId: string,
    farmerId: string,
    dto: UpdateCodOutcomeDto,
  ): Promise<OrderRow> {
    const lineItems = await this.db
      .select({ farmerId: products.farmerId })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)));
    if (lineItems.length === 0) throw new ForbiddenException('Нямате достъп до тази поръчка.');
    if (lineItems.some((li) => li.farmerId !== farmerId)) {
      throw new ForbiddenException('Споделена поръчка — само собственикът може да отбележи плащането.');
    }
    return this.setCodOutcome(id, tenantId, dto);
  }
```

Add the import at the top: `import { UpdateCodOutcomeDto } from './dto/update-cod-outcome.dto';` and ensure `BadRequestException` is in the `@nestjs/common` import. Ensure `CodRiskService` is imported and `CodRiskModule` is in `orders.module.ts` `imports` (grep the module; if cod-risk isn't wired, add `imports: [..., CodRiskModule]`).

- [ ] **Step 6: Add the controller route**

In `orders.controller.ts`, import the DTO and add after `updateStatus` (line 99), inside `OrdersController`:

```typescript
  // Set the наложен-платеж money outcome (received / refused). Owner edits any
  // order; a producer is forced to its own farmerId (same IDOR scope as status).
  @Patch(':id/cod-outcome')
  @Roles('admin', 'farmer')
  setCodOutcome(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: TenantRequestUser,
    @Body() dto: UpdateCodOutcomeDto,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return scope
      ? this.ordersService.setCodOutcomeForFarmer(id, user.tenantId, scope, dto)
      : this.ordersService.setCodOutcome(id, user.tenantId, dto);
  }
```

Add `import { UpdateCodOutcomeDto } from './dto/update-cod-outcome.dto';`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `ctx-wire run bash -lc "cd server && npx jest orders --silent"`
Expected: PASS. Then typecheck: `ctx-wire run bash -lc "cd server && npx tsc --noEmit"` → PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/orders/
git commit -m "feat(orders): manual cod-outcome endpoint + PaymentOrder.codOutcome"
```

---

### Task 4: Courier auto-sync in `refreshStatusForRow` (Econt + Speedy)

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts` (`refreshStatusForRow` ~1254-1284)
- Modify: `server/src/modules/speedy/speedy.service.ts` (`refreshStatusForRow` ~744-773)
- Test: `server/src/modules/econt/econt.service.spec.ts`, `server/src/modules/speedy/speedy.helpers.spec.ts` (or a new focused spec)

**Interfaces:**
- Consumes: `orders.codOutcome*` (Task 1); `isReturnedStatus` (from `cod-risk.helpers`); the updated `shipments` row.
- Produces: a private helper on each service, `syncOrderCodOutcome(shipment)`, called best-effort after `recordReturnIfApplicable`. No new public surface.

- [ ] **Step 1: Write the failing test (Econt)**

Add to `econt.service.spec.ts` a unit around the sync helper. Mock the DB `update(orders).set(...).where(...)` and assert the `WHERE cod_outcome IS NULL` guard is present and the correct outcome is written:

```typescript
describe('syncOrderCodOutcome (econt)', () => {
  it('sets received when COD collected', async () => {
    const shipment = { orderId: 'o1', tenantId: 't1', codAmountStotinki: 1000, codCollectedAt: new Date(), status: 'доставена' } as any;
    await (service as any).syncOrderCodOutcome(shipment);
    expect(lastOrdersUpdateSet).toMatchObject({ codOutcome: 'received', codOutcomeSource: 'courier' });
  });
  it('sets refused on a returned status', async () => {
    const shipment = { orderId: 'o1', tenantId: 't1', codAmountStotinki: 1000, codCollectedAt: null, status: 'върната пратка' } as any;
    await (service as any).syncOrderCodOutcome(shipment);
    expect(lastOrdersUpdateSet).toMatchObject({ codOutcome: 'refused', codOutcomeSource: 'courier' });
  });
  it('does nothing for a non-COD shipment', async () => {
    await (service as any).syncOrderCodOutcome({ orderId: 'o1', tenantId: 't1', codAmountStotinki: null } as any);
    expect(lastOrdersUpdateSet).toBeUndefined();
  });
});
```

(Capture `lastOrdersUpdateSet` via the DB mock's `.update().set()` spy. Follow the mock shape already used in `econt.service.spec.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `ctx-wire run bash -lc "cd server && npx jest econt.service --silent"`
Expected: FAIL with "syncOrderCodOutcome is not a function".

- [ ] **Step 3: Implement the Econt helper + call it**

In `econt.service.ts`, add the import `import { isReturnedStatus } from '../cod-risk/cod-risk.helpers';` (verify the export path) and a private method:

```typescript
  /** Sync the order's COD money outcome from a courier signal. No-clobber: only
   *  writes when the order has no outcome yet (a manual override wins). Econt: a
   *  populated codCollectedAt means the cash was collected → received; a
   *  returned/refused status → refused. Best-effort (caller wraps). */
  private async syncOrderCodOutcome(shipment: typeof shipments.$inferSelect): Promise<void> {
    if (!shipment.orderId || shipment.codAmountStotinki == null) return;
    let outcome: 'received' | 'refused' | null = null;
    if (isReturnedStatus(shipment.status)) outcome = 'refused';
    else if (shipment.codCollectedAt != null) outcome = 'received';
    if (!outcome) return;
    await this.db
      .update(orders)
      .set({ codOutcome: outcome, codOutcomeAt: new Date(), codOutcomeSource: 'courier' })
      .where(and(eq(orders.id, shipment.orderId), sql`${orders.codOutcome} is null`));
  }
```

Wrap the call next to the existing cod-risk block (after line 1283, inside `refreshStatusForRow`):

```typescript
    try {
      await this.syncOrderCodOutcome(updated);
    } catch (err) {
      this.logger.warn(`[econt] cod-outcome sync failed for ${updated.id}: ${err instanceof Error ? err.message : err}`);
    }
```

Ensure `orders` and `sql` are imported in `econt.service.ts` (add to the `@fermeribg/db` / `drizzle-orm` imports if missing).

- [ ] **Step 4: Implement the Speedy helper + `codCollectedAt` on delivered**

In `speedy.service.ts` `refreshStatusForRow`: when the parsed `status === 'delivered'` on a COD parcel, also set `codCollectedAt`. Change the update `.set({...})` (line 746) to conditionally include it:

```typescript
    const [updated] = await this.db
      .update(shipments)
      .set({
        status,
        trackingJson: parcel ?? row.trackingJson,
        codCollectedAt:
          status === 'delivered' && row.codAmountStotinki != null && row.codCollectedAt == null
            ? new Date()
            : row.codCollectedAt,
        updatedAt: new Date(),
      })
      .where(eq(shipments.id, row.id))
      .returning();
```

Add the same private `syncOrderCodOutcome` method (identical body — Speedy's canonical `status='delivered'` sets `codCollectedAt` above, so the received branch keying off `codCollectedAt` works for both carriers), and call it best-effort after the `recordReturnIfApplicable` block (after line 756):

```typescript
    try {
      await this.syncOrderCodOutcome(updated);
    } catch (err) {
      this.logger.warn(`[speedy] cod-outcome sync failed for ${updated.id}: ${err instanceof Error ? err.message : err}`);
    }
```

Ensure `orders`, `and`, `sql` are imported in `speedy.service.ts`.

- [ ] **Step 5: Write + run the Speedy test**

Add to `speedy.helpers.spec.ts` (or a new `speedy.service.spec.ts`) the same three-case `syncOrderCodOutcome` block as Step 1, plus one asserting a delivered COD parcel sets `codCollectedAt`.

Run: `ctx-wire run bash -lc "cd server && npx jest 'econt.service|speedy' --silent"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/econt/ server/src/modules/speedy/
git commit -m "feat(carriers): sync order cod-outcome from courier delivered/returned signals"
```

---

### Task 5: Client API + types — `codOutcome` fields, `setCodOutcome`

**Files:**
- Modify: `client/src/lib/api-client.ts` (`PaymentOrder` interface ~613-633; `updateOrderStatus` ~544; add `setCodOutcome`)
- Modify: `client/src/lib/types.ts` (`Order` interface ~686-699)

**Interfaces:**
- Produces: `PaymentOrder.codOutcome: 'received'|'refused'|null` + `codOutcomeReason: string|null`; `Order.codOutcome`/`codOutcomeReason`/`codOutcomeAt`; `setCodOutcome(id, outcome, reason?)` API fn. Consumed by Tasks 6-8.

- [ ] **Step 1: Extend the client types**

In `api-client.ts` `PaymentOrder` (after `collected`, line 626):

```typescript
  /** COD money outcome: 'received' | 'refused' | null (=Очаквано). */
  codOutcome: 'received' | 'refused' | null;
  codOutcomeReason: string | null;
```

In `types.ts` `Order` (after the `status`/`deliveryType` fields, ~line 699):

```typescript
  codOutcome: 'received' | 'refused' | null;
  codOutcomeReason: string | null;
  codOutcomeAt: string | null;
```

- [ ] **Step 2: Add the API call**

In `api-client.ts`, after `updateOrderStatus` (line 545):

```typescript
export const setCodOutcome = (id: string, outcome: 'received' | 'refused', reason?: string) =>
  apiFetch<Order>(
    `orders/${id}/cod-outcome`,
    { method: 'PATCH', ...json({ outcome, ...(reason ? { reason } : {}) }) },
    'Неуспешна промяна на статуса на плащане',
  );
```

- [ ] **Step 3: Verify the client typechecks**

Run: `ctx-wire run bash -lc "cd client && npx tsc --noEmit"`
Expected: PASS (or only pre-existing unrelated errors — none referencing `codOutcome`).

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/api-client.ts client/src/lib/types.ts
git commit -m "feat(client): codOutcome fields + setCodOutcome api call"
```

---

### Task 6: Плащания screen — 4-state badge + refused action + endpoint swap

**Files:**
- Modify: `client/src/components/payments/payments-client.tsx` (`codSettlementBadge` ~104-109; `onCollect` ~253-266; `CollectButton` ~536-560; badge render ~476-520)

**Interfaces:**
- Consumes: `PaymentOrder.codOutcome` (Task 5), `setCodOutcome` (Task 5), `CodReconRow` (existing).

- [ ] **Step 1: Make `codSettlementBadge` 4-state**

Replace `codSettlementBadge` (lines 104-109) — it now takes the order too, so refusal (which has no recon row) shows:

```typescript
/** COD lifecycle: Отказана (red) → Очаквано → Събрано → Преведено. Econt/Speedy
 *  drive collected/settled via the reconciliation row; refused + non-courier
 *  received come from the order's codOutcome. */
function codSettlementBadge(
  recon: CodReconRow | undefined,
  o: PaymentOrder,
): { label: string; cls: string } {
  if (o.codOutcome === 'refused') return { label: 'Отказана', cls: 'bg-red-100 text-red-800' };
  if (recon?.settledAt) return { label: 'Преведено', cls: 'bg-ff-green-100 text-ff-green-800' };
  if (recon?.collectedAt || o.codOutcome === 'received') return { label: 'Събрано', cls: 'bg-amber-100 text-amber-800' };
  return { label: 'Очаквано', cls: 'bg-ff-surface-2 text-ff-muted' };
}
```

Update both call sites (lines 477 and 519) to pass the order: `codSettlementBadge(codRecon[o.id], o)`.

- [ ] **Step 2: Swap `onCollect` to the new endpoint + add refuse**

Change `onCollect` (line 256) from `updateOrderStatus(id, 'delivered')` to `setCodOutcome(id, 'received')`, and update the optimistic patch to set `codOutcome: 'received'` (keep `collected: true`):

```typescript
  const onCollect = useCallback(async (id: string) => {
    setCollectingId(id);
    try {
      await setCodOutcome(id, 'received');
      setAllOrders((prev) =>
        prev.map((o) => (o.id === id ? { ...o, codOutcome: 'received', collected: true } : o)),
      );
      toast.success('Отбелязано като получено.');
    } catch {
      toast.error('Грешка при отбелязването.');
    } finally {
      setCollectingId(null);
    }
  }, []);
```

Add a sibling `onRefuse(id)` that calls `setCodOutcome(id, 'refused')` and patches `codOutcome: 'refused', collected: false`, toast `'Отбелязано като отказана.'`. Import `setCodOutcome` (replace the `updateOrderStatus` import if it's now unused elsewhere in the file — grep first).

- [ ] **Step 3: Add the refuse control next to CollectButton**

In the row render where `CollectButton` appears (near line 536-560), render an "Отказана" button/link for COD orders whose `codOutcome` is `null` (still Очаквано), calling `onRefuse(o.id)`. Keep the existing "Получих парите" button for the `received` action. Hide both once `codOutcome` is set (badge shows the state).

- [ ] **Step 4: Verify in the running app**

Ensure the client dev server is up (preview_start if a config exists; otherwise run the client per its README). Reload the Плащания screen. Use preview_snapshot to confirm a COD order shows «Очаквано» with «Получих парите» + «Отказана», and after clicking «Отказана» the badge flips to «Отказана» (red). Check preview_console_logs for errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/payments/payments-client.tsx
git commit -m "feat(payments): 4-state COD badge + refuse action via cod-outcome"
```

---

### Task 7: Order panel — «Плащане (наложен платеж)» section

**Files:**
- Modify: `client/src/components/orders/order-panel.tsx`

**Interfaces:**
- Consumes: `Order.codOutcome`/`deliveryType`/`paymentMethod` (Task 5), `setCodOutcome` (Task 5).

- [ ] **Step 1: Add the payment section**

In `order-panel.tsx`, add a section rendered only when the order's `paymentMethod === 'cod'`:

- Compute `isCourier = order.deliveryType === 'econt' || order.deliveryType === 'econt_address' || order.deliveryType === 'courier'`.
- Show the current outcome badge (Очаквано / Получено / Отказана) using the same colors as Task 6.
- **Non-courier** (`pickup`, `address`): two buttons — «Получих парите» (`setCodOutcome(id,'received')`) and «Отказана» (opens a small optional reason `<input>` then `setCodOutcome(id,'refused', reason)`).
- **Courier**: read-only badge + a small «Коригирай» link that reveals the same two actions (courier signal can be wrong; manual override wins).
- After a successful call, update local order state (`codOutcome`, `codOutcomeReason`) and toast, matching the panel's existing mutation pattern (grep how the panel currently calls `updateOrderStatus` and reuse that state-update + toast shape).

- [ ] **Step 2: Verify in the running app**

Reload an order's detail panel for a COD pickup order. preview_snapshot: confirm the «Плащане» section with «Получих парите» / «Отказана». Click «Отказана», enter a reason, confirm the badge flips and no console error (preview_console_logs).

- [ ] **Step 3: Commit**

```bash
git add client/src/components/orders/order-panel.tsx
git commit -m "feat(orders): COD payment section with received/refused in order panel"
```

---

### Task 8: Orders list — «Отказана» badge

**Files:**
- Modify: `client/src/components/orders/orders-client.tsx`

**Interfaces:**
- Consumes: `Order.codOutcome` (Task 5).

- [ ] **Step 1: Render the refused badge**

In the orders-list row render, for COD orders with `codOutcome === 'refused'`, show a small red «Отказана» badge (reuse the existing badge/pill component in that file — grep for how status pills are rendered and mirror the markup + a red color class). Do not add badges for received/pending here (the Плащания screen owns the full lifecycle); the list only flags refusals so they're visible at a glance.

- [ ] **Step 2: Verify in the running app**

Reload the Поръчки list. preview_snapshot: a refused COD order shows the red «Отказана» badge; others are unchanged. preview_console_logs: no errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/orders/orders-client.tsx
git commit -m "feat(orders): show Отказана badge on refused COD orders in list"
```

---

## Self-Review Notes

- **Spec coverage:** data model (T1), backfill (T1), transition matrix auto (T4) + manual (T3), cod-risk on refusal all modes (T2 manual + existing courier T4), Speedy reconciliation parity (T4 codCollectedAt), 4-state payments badge (T6), order-panel section (T7), orders-list badge (T8), API/types (T5), tests (T1-T4,T6,T7,T8). All spec sections mapped.
- **No-clobber invariant:** courier sync (T4) writes only `WHERE cod_outcome IS NULL`; manual (T3) always wins. Consistent across both carriers.
- **Type consistency:** `codOutcome: 'received'|'refused'|null` and `codOutcomeSource: 'courier'|'manual'` used verbatim in schema (T1), service (T3), carriers (T4), client (T5-T8). `setCodOutcome` signature identical in api-client (T5) and all callers (T6-T7).
- **Verify before done:** each client task ends with a preview check; server tasks end with jest + tsc. Confirm the full server suite green before finishing: `ctx-wire run bash -lc "cd server && npx jest --silent"`.
