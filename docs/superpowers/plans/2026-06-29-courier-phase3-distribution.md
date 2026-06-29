# Courier Phase 3 — Order distribution engine (auto-draft + per-farmer shipments)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a courier order is created, auto-create one **draft shipment** in the owning farmer's delivery account (idempotent), tag shipments with `farmer_id`, and scope the dostavki shipment list + COD reconciliation per-farmer so each farmer sees and ships only their own courier parcels — picking the carrier (Speedy/Econt) at ship time.

**Architecture:** A courier order (`delivery_type='courier'`, `farmer_id` set, `carrier=null`, COD) gets a companion `shipments` row at creation: `status='draft'`, `carrier=null`, `farmer_id` copied from the order, `cod_amount_stotinki` = order total. The draft surfaces in the farmer's dostavki "днешни доставки" queue (now filtered by `shipments.farmer_id` instead of returning `[]`). The farmer reviews, picks a carrier, presses "Създай товарителница" → the existing farmer-scoped `createLabel` finalizes the draft into a real waybill (draft→created) using that farmer's own carrier credentials. No platform auto-create (the farmer ships manually). The `shipments.orderId` UNIQUE index keeps it to exactly one draft/waybill per order.

**Tech Stack:** NestJS + Drizzle/Postgres (hand-written migrations), the dostavki backend (`EcontAppModule` standalone controllers) + delivery-web (Next.js). Carrier services `EcontService`/`SpeedyService` already thread an optional `farmerId`.

**Resolved decisions:**
- **Draft = a real `shipments` row** with `status='draft'`, created at courier-order creation (in the same transaction — it's a pure DB write, no carrier call). Idempotent via `shipments_order_unique`.
- **Weight source**: the farmer's `settings.delivery.farmers[<id>].{econt|speedy}.defaultPackage.weightKg`, fallback **1 kg** (no numeric per-product weight exists; `products.weight` is display text). Resolved at finalize (label build), not stored on the draft.
- **Carrier**: NOT chosen at creation. `orders.carrier` + `shipments.carrier` stay null until the farmer picks at ship time. No `autoCreateForOrder` for courier (it already self-gates out).
- **Scoping**: `shipments.farmer_id` (new) is the per-farmer filter for `listShipments` + `codReconciliation`. The admin (no farmerId) list is unchanged (Econt/Speedy office orders); the farmer list becomes their courier drafts/waybills.

**Repo paths:**
- Backend + dostavki: `C:\Users\Lenovo\source\repos\FarmFlow` (server pkg = `@fermeribg/api`)
- delivery-web (dostavki UI): `C:\Users\Lenovo\source\repos\FarmFlow\delivery-web`

---

## File Structure

- `packages/db/drizzle/0071_shipments_farmer_id.sql` (new) — `shipments.farmer_id` + index.
- `packages/db/drizzle/meta/_journal.json` (modify) — append idx 71.
- `packages/db/src/schema.ts` (modify) — `shipments.farmerId` + `(tenant_id, farmer_id)` index.
- `server/src/modules/orders/orders.service.ts` (modify) — create a draft shipment per courier order inside `createCourierOrders`.
- `server/src/modules/orders/orders.courier.spec.ts` (modify) — assert one draft/order with farmerId + COD + status='draft'.
- `server/src/modules/econt/econt.service.ts` (modify) — `listShipments`/`codReconciliation` farmer-scoped (incl. courier drafts); `createLabel` sets `farmer_id` + handles `delivery_type='courier'` (address mode).
- `server/src/modules/speedy/speedy.service.ts` (modify) — mirror.
- `server/src/modules/econt/econt.service.spec.ts` + `server/src/modules/speedy/speedy.service.spec.ts` (modify) — scoping tests.
- `delivery-web/src/app/(dostavki)/shipments/*` (modify) — show courier drafts + "Създай товарителница" (carrier pick → finalize). (Explore the actual file tree during implementation.)

---

## Task 1: Migration 0071 — `shipments.farmer_id`

**Files:**
- Create: `packages/db/drizzle/0071_shipments_farmer_id.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/db/src/schema.ts`

- [ ] **Step 1: Migration SQL.** Create `packages/db/drizzle/0071_shipments_farmer_id.sql`:
```sql
-- Phase 3: per-farmer courier shipments. Which farmer owns/ships this parcel —
-- copied from orders.farmer_id when the draft is created. NULL for legacy /
-- marketplace (tenant-level) Econt/Speedy shipments. Lets the dostavki list +
-- COD reconciliation scope to a single farmer (previously returned []).
ALTER TABLE "shipments" ADD COLUMN "farmer_id" uuid;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_farmer_id_farmers_id_fk" FOREIGN KEY ("farmer_id") REFERENCES "public"."farmers"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "shipments_tenant_farmer_idx" ON "shipments" ("tenant_id","farmer_id");
```

- [ ] **Step 2: Journal entry.** Append to `packages/db/drizzle/meta/_journal.json` after idx 70:
```json
    {
      "idx": 71,
      "version": "7",
      "when": 1783242000000,
      "tag": "0071_shipments_farmer_id",
      "breakpoints": true
    }
```

- [ ] **Step 3: Schema.** In `packages/db/src/schema.ts`, `shipments` table, add the column (near `orderId`):
```ts
    // Phase 3 (migration 0071): which farmer owns/ships this courier parcel.
    // Copied from orders.farmer_id when the draft is created. NULL for tenant-level
    // (marketplace) Econt/Speedy shipments.
    farmerId: uuid('farmer_id').references(() => farmers.id, { onDelete: 'set null' }),
```
In the `shipments` index block, add:
```ts
    tenantFarmerIdx: index('shipments_tenant_farmer_idx').on(t.tenantId, t.farmerId),
```

- [ ] **Step 4: Build + typecheck.** `pnpm --filter @fermeribg/db build && pnpm --filter @fermeribg/api exec tsc -p tsconfig.json --noEmit` → both EXIT 0.

- [ ] **Step 5: Commit.**
```bash
git add packages/db/drizzle/0071_shipments_farmer_id.sql packages/db/drizzle/meta/_journal.json packages/db/src/schema.ts
git commit -m "feat(courier): migration 0071 — shipments.farmer_id"
```

---

## Task 2: Draft shipment per courier order

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts` (`createCourierOrders`)
- Modify: `server/src/modules/orders/orders.courier.spec.ts`

Inside `createCourierOrders`, after inserting each per-farmer order + its items (in the same transaction), insert a draft shipment. `shipments` is already imported in this file (used by `updateStatusForFarmer`/production? — if not, add it to the `@fermeribg/db` import).

- [ ] **Step 1: Write the failing test.** In `orders.courier.spec.ts`, extend the "2-farmer cart → 2 orders" test (or add one) to assert the fake `tx.insert` is also called on `shipments` with, per order: `orderId` = the new order id, `tenantId`, `farmerId` = that farmer, `status:'draft'`, `carrier:null`, `codAmountStotinki` = the order total, `deliveryMode:'address'`. Use the existing tx-insert capture (it already records `insert(...).values(...)` calls — branch on the table). Run `pnpm --filter @fermeribg/api exec jest orders.courier -- --silent` → FAIL.

- [ ] **Step 2: Implement.** In `createCourierOrders`, right after `const inserted = await tx.insert(orderItems)...returning();` for each farmer group, add the draft insert:
```ts
        // Phase 3: distribution — drop a DRAFT shipment into the farmer's queue.
        // No carrier call (status='draft', carrier=null); the farmer picks the
        // carrier + finalizes in dostavki. Idempotent via shipments_order_unique.
        await tx
          .insert(shipments)
          .values({
            tenantId: tenant.id,
            orderId: order.id,
            farmerId: fid,
            carrier: null,
            status: 'draft',
            codAmountStotinki: total,
            deliveryMode: 'address',
          })
          .onConflictDoNothing({ target: shipments.orderId });
```
> `shipments.carrier` is `notNull().default('econt')` — passing `carrier: null` will fail. Either (a) drop the line and let it default to `'econt'` then null it at finalize, OR (b) make the column nullable in 0071. **Choose (a)**: omit `carrier` from the draft values (it defaults to `'econt'` as a placeholder) and document that `status='draft'` — not `carrier` — marks an unshipped parcel. Update the Step-1 test to expect no explicit carrier (default) rather than `null`.

- [ ] **Step 3: Run the test** → PASS. Then `pnpm --filter @fermeribg/api exec jest orders -- --silent --runInBand` → all green.

- [ ] **Step 4: Commit.**
```bash
git add server/src/modules/orders/orders.service.ts server/src/modules/orders/orders.courier.spec.ts
git commit -m "feat(courier): auto-create draft shipment per courier order (Phase 3 distribution)"
```

---

## Task 3: Per-farmer shipment list + COD reconciliation

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts` (`listShipments`, `codReconciliation`)
- Modify: `server/src/modules/speedy/speedy.service.ts` (mirror)
- Modify: their `.spec.ts`

Replace the `if (farmerId) return []` early-returns with real per-farmer queries scoped on `shipments.farmerId`.

- [ ] **Step 1: `listShipments(tenantId, farmerId?)`.** Keep the existing tenant-wide admin path for `farmerId == null`. When `farmerId` is set, return the farmer's courier drafts/waybills: query `orders` WHERE `tenantId=? AND deliveryType='courier' AND farmerId=? AND status != 'cancelled'`, `leftJoin shipments ON shipments.orderId = orders.id`, selecting the same `AdminShipment` shape the admin path returns (so the dostavki UI is uniform). Order by `orders.createdAt desc`. (Drafts have `shipments.status='draft'` and null waybill numbers; finalized ones have `status='created'`.)
```ts
  async listShipments(tenantId: string, farmerId?: string): Promise<AdminShipment[]> {
    if (farmerId) {
      const rows = await this.db
        .select({ /* same columns as the admin order-shipment select */ })
        .from(orders)
        .leftJoin(shipments, eq(shipments.orderId, orders.id))
        .where(and(
          eq(orders.tenantId, tenantId),
          eq(orders.deliveryType, 'courier'),
          eq(orders.farmerId, farmerId),
          ne(orders.status, 'cancelled'),
        ))
        .orderBy(desc(orders.createdAt));
      return rows.map(mapOrderShipmentRow); // reuse the existing mapper
    }
    // ... existing tenant-wide admin path unchanged ...
  }
```
> Mirror in `speedy.service.ts`. Both services return the SAME courier rows for a farmer (courier orders are carrier-agnostic until shipped) — to avoid the dostavki UI showing each courier draft twice (once per carrier tab), have the **Speedy** `listShipments` return `[]` for `farmerId` and let **Econt**'s be the single source of the farmer's courier queue. Document this: the farmer's courier list is carrier-neutral; the carrier is chosen per-parcel at finalize, so it lives under one list, not split by carrier tab.

- [ ] **Step 2: `codReconciliation(tenantId, farmerId?)`.** When `farmerId` set, filter `shipments` by `eq(shipments.farmerId, farmerId)` (instead of returning `[]`), keeping the existing `isNotNull(codAmountStotinki)` + orderId filter. Mirror in Speedy (or return `[]` there too, matching Step 1's single-source decision).

- [ ] **Step 3: Tests.** In `econt.service.spec.ts`: (a) `listShipments(t, farmerId)` returns the farmer's courier orders (mock the order+leftJoin shipment rows) instead of `[]`; (b) `codReconciliation(t, farmerId)` filters by `shipments.farmerId`. Mirror the "speedy returns [] for farmer courier" decision in `speedy.service.spec.ts`. Run both suites → PASS.

- [ ] **Step 4: Update the Phase-1 comments** on `econt-standalone.controller.ts` + `speedy-standalone.controller.ts` (the `// Phase 1: farmer sees none until shipment.farmerId lands (Phase 3)` notes) to reflect that Phase 3 has landed.

- [ ] **Step 5: Commit.**
```bash
git add server/src/modules/econt/econt.service.ts server/src/modules/speedy/speedy.service.ts server/src/modules/econt/econt.service.spec.ts server/src/modules/speedy/speedy.service.spec.ts server/src/modules/econt-app/econt-standalone.controller.ts server/src/modules/speedy/speedy-standalone.controller.ts
git commit -m "feat(courier): farmer-scoped shipment list + COD reconciliation (Phase 3)"
```

---

## Task 4: Finalize a courier draft into a waybill (farmer-scoped)

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts` (`createLabel`, `buildLabel`)
- Modify: `server/src/modules/speedy/speedy.service.ts` (mirror)
- Modify: their `.spec.ts`

When the farmer picks a carrier on a draft and creates the label, the existing farmer-scoped `createLabel(tenantId, orderId, farmerId)` must: (a) accept a `delivery_type='courier'` order (currently `buildLabel`/`orderForShipment` may assume `econt`/`econt_address`), (b) ship to the order's `deliveryAddress` + `deliveryCity` in **address mode**, (c) use the farmer's `defaultPackage.weightKg ?? 1`, (d) set `shipments.farmerId` + `orders.carrier` to the chosen carrier, and (e) flip the draft `status` `draft → created` via the existing `onConflictDoUpdate`.

- [ ] **Step 1: `buildLabel` handles courier.** Inspect `buildLabel` (econt.service.ts ~line 600-680) + `orderForShipment`. Ensure a `delivery_type='courier'` order routes to **address** delivery (not office): receiver = `order.customerName`/`customerPhone`, city = `order.deliveryCity`, address = `order.deliveryAddress`, COD = order total, weight = `defaultPackage.weightKg ?? 1`. If `buildLabel` branches on `deliveryType === 'econt_address'`, add `|| deliveryType === 'courier'` to the address branch.

- [ ] **Step 2: `createLabel` sets `farmerId` + carrier.** In the `insert(shipments).values({...}).onConflictDoUpdate(...)`, add `farmerId` to BOTH the insert values and the update `set` (so finalizing a draft preserves/sets it), and set `carrier` to the carrier the farmer chose (the method already runs in the carrier-specific service, so Econt's sets `'econt'`, Speedy's `'speedy'`). Also persist `orders.carrier` = chosen carrier (so the order reflects who shipped it) — a small `update(orders).set({carrier}).where(eq(orders.id, orderId))`.

- [ ] **Step 3: Tests.** In `econt.service.spec.ts`: `createLabel(t, courierOrderId, farmerId)` builds an **address** label from the courier order, calls the (mocked) carrier, and upserts the shipment with `farmerId` set + `status:'created'`. Mirror in Speedy. Run → PASS.

- [ ] **Step 4: Full server suite.** `pnpm --filter @fermeribg/api test -- --silent --runInBand` → all green.

- [ ] **Step 5: Commit.**
```bash
git add server/src/modules/econt/econt.service.ts server/src/modules/speedy/speedy.service.ts server/src/modules/econt/econt.service.spec.ts server/src/modules/speedy/speedy.service.spec.ts
git commit -m "feat(courier): finalize courier draft → waybill (farmer carrier, address mode, farmer_id)"
```

---

## Task 5: dostavki UI — courier drafts in the farmer's queue

**Files:**
- Modify: `delivery-web/src/app/(dostavki)/shipments/*` (explore the real tree first)

The farmer, after SSO into dostavki (Phase 1), should see their courier drafts in "днешни доставки" with a **Създай товарителница** action (pick carrier Speedy/Econt → finalize). The list endpoint already returns drafts (Task 3); this task is the UI.

- [ ] **Step 1: Explore.** Read `delivery-web/src/app` to find the shipments list page + the existing "create label" action (the admin already finalizes Econt/Speedy order shipments here). Identify how a row renders a draft (`status === 'draft'`, no waybill number) vs a created waybill.

- [ ] **Step 2: Render drafts.** For `status === 'draft'` rows, show the customer + COD + a carrier picker (Econt / Speedy) + a **Създай товарителница** button. Reuse the existing label-create call, passing the chosen carrier (so it hits the right service's `createLabel`). On success the row flips to a created waybill (number + label PDF link), reusing the existing rendering.

- [ ] **Step 3: Verify.** `cd delivery-web && pnpm exec tsc --noEmit` → clean. If a dev server + preview is available, drive the flow (a farmer's draft → pick carrier → create label → waybill appears). Otherwise typecheck + a screenshot of the drafts list.

- [ ] **Step 4: Commit.**
```bash
git add delivery-web/src/app
git commit -m "feat(courier): dostavki — farmer courier drafts + create-waybill action (Phase 3)"
```

---

## Task 6: Final verification

- [ ] **Step 1: Backend.** `pnpm --filter @fermeribg/db build && pnpm --filter @fermeribg/types build && pnpm --filter @fermeribg/api exec tsc -p tsconfig.json --noEmit && pnpm --filter @fermeribg/api test -- --silent --runInBand` → all green.
- [ ] **Step 2: delivery-web.** `cd delivery-web && pnpm exec tsc --noEmit` → clean.
- [ ] **Step 3: Reason through E2E.** Courier order created → draft shipment (farmerId, COD, status='draft') in same tx → farmer SSO into dostavki → sees draft in their queue (Task 3 scoping) → picks carrier → Създай товарителница → farmer-scoped `createLabel` (their creds, address mode, weight default) → waybill + label PDF, draft→created, `orders.carrier` set → COD reconciliation now lists it per-farmer. Idempotent (one shipment/order via unique index). Cancelled courier orders' drafts are filtered out of the list.
- [ ] **Step 4: Final review subagent**, then finishing-a-development-branch.

---

## Self-review notes (author)

- **Spec coverage:** auto-draft per courier order (Task 2) ✓; `shipment.farmerId` (Task 1) ✓; `listShipments`/`codReconciliation` per-farmer instead of `[]` (Task 3) ✓; farmer picks carrier at ship time + finalize (Task 4) ✓; dostavki queue surfacing (Task 5) ✓. Weight open-question resolved (farmer `defaultPackage.weightKg ?? 1`).
- **Idempotency:** `shipments_order_unique` + `onConflictDoNothing` (draft) / `onConflictDoUpdate` (finalize) → exactly one shipment per order across both create paths.
- **No platform auto-create:** courier already self-gates out of `autoCreateForOrder`; the farmer initiates the waybill. Keep that gate.
- **Carrier neutrality:** a courier draft isn't carrier-bound; the farmer's dostavki list is single-sourced (Econt service) to avoid double-listing per carrier tab. Carrier is set only at finalize.
- **Back-compat:** `shipments.farmer_id` is nullable; all existing tenant-level Econt/Speedy shipments keep `farmer_id=null` and the admin (no-farmerId) paths are untouched.
- **Type consistency:** `shipments.carrier` is `notNull default 'econt'` — the draft omits `carrier` (defaults to placeholder); `status='draft'` is the unshipped marker, not `carrier`.
