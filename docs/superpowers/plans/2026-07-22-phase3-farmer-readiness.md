# Phase 3 — Farmer Readiness + Small Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 3 of the consolidated-handover-protocol spec (`docs/superpowers/specs/2026-07-21-consolidated-handover-protocol-design.md`, §5 and §1.8): a per-farmer legal+signature readiness check exposed via a new endpoint, a read-only "Готовност на фермерите" board on the Protocols screen, the §5.4 small list fixes (protocol number + order/row count columns), and the §1.8 fix that makes farmer-leg handover protocols actually persist `orderIds` instead of always writing `null`.

**Architecture:** Two independent backend slices (no migration — every column already exists) plus their client consumers:
1. `handover.service.ts` — `buildDraft`/`prefetchDraftContext` compute the distinct order ids behind a farmer pickup; the four write sites (`createSigned`, `createBatch`, `ensureDraftTarget`, `signPaperTarget`) persist them instead of hardcoding `null`. This also unblocks `listForCheck`'s existing `orderIds`-array scoping branch (today dead code for farmer protocols — see `handover.service.ts:1132` and `handover.check-filter.spec.ts`). `listForDay` then derives an `orderCount` per row (virtual and persisted) for the day-list column.
2. `farmers.service.ts` / `farmers.controller.ts` — a new read-only `listReadiness()` / `GET /farmers/readiness` reusing the exact kind→identifier decision `client/src/lib/legal-identity.ts`'s `buildLegalPayload` already encodes (individual → `regNo`, everyone else → `eik`), plus signature presence (never decrypted).
3. Client: a `FarmerReadinessBoard` component on `/protocols` consuming the new endpoint, reusing the two EXISTING remediation paths already in the codebase (farmer edit panel for "Попълни вместо него", `grantFarmerAccess` for "Прати покана") rather than building new ones; small table-column additions to "Всички протоколи за деня".

**Tech Stack:** NestJS + Drizzle (server, Jest), Next.js App Router client component (vitest, NODE env only — no jsdom/RTL in this repo).

## Global Constraints

- **No migration this phase.** `handover_protocols.order_ids` (uuid array), `farmers.legal` (jsonb), and `farmers.signature_png` (text) already exist on `main`/this branch — confirmed by reading `packages/db/src/schema.ts:556-588` and `:1230-1254`. Do not add one.
- **Must NOT block anything (spec §5.3).** Every check/board in this phase is read-only/advisory. No task may add a guard that prevents signing, printing, or confirming a handover.
- **Reuse, don't reinvent, the kind→identifier decision.** `client/src/lib/legal-identity.ts`'s `buildLegalPayload`: `kind === 'individual'` → `regNo` is the identifier; anything else (including unset) → `eik`. The server-side readiness check must encode the exact same decision (server and client can't share a module across the app boundary here, so it's a deliberate parallel implementation, same as `normalizeLegal` already parallels it) — never "eik OR regNo".
- **`TenantRolesGuard` default-denies to `admin`** (registered globally in `app.module.ts`); a new route needs `@Roles(...)` only if a non-admin role must reach it. The readiness endpoint stays admin-only by simply omitting `@Roles`, matching every other plain admin route in `FarmersController` (e.g. `access`).
- **Client tests are vitest, NODE env only — no jsdom/RTL anywhere in this repo.** Any task that only changes JSX/component wiring (no extractable pure logic) does not get an automated RED/GREEN cycle — it gets a manual verification checklist and a manual teeth-check instead. Any task with sortable/derivable logic (label maps, sort order, the readiness check itself) MUST have that logic pulled into a plain exported function with a real test.
- Server tests: `pnpm --filter @fermeribg/api test -- <pattern> --maxWorkers=4`. Client tests: `pnpm --filter @fermeribg/web test -- <pattern>`. Packages must already be built in this worktree (they are, per Phase 0).

---

### Task 1: `buildDraft` computes the distinct order ids behind a farmer pickup

**Files:**
- Modify: `server/src/modules/handover/handover.service.ts`
- Test: `server/src/modules/handover/handover.service.spec.ts`

**Interfaces:**
- Consumes: nothing new — reads the existing `orders`/`orderItems`/`products` join already used by `buildDraft`'s farmer-leg query and `prefetchDraftContext`'s farmer-items query.
- Produces: `buildDraft(...)`'s resolved value gains `orderIds: string[]` — for `kind: 'farmer_to_operator'`, the distinct order ids whose items contributed to that farmer+slot pickup; for `kind: 'operator_to_customer'`, always `[q.orderId!]`. Task 2 persists this onto `handover_protocols.order_ids`.

- [ ] **Step 1: Write the failing tests**

Add to the `HandoverService.buildDraft farmer_to_operator` describe block in `handover.service.spec.ts` (after the existing "aggregates one farmer's items…" test):

```ts
  it('collects the distinct order ids behind a multi-order farmer pickup (feeds order_ids persistence)', async () => {
    const db = makeDb();
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]);
    db.queue([{ id: 'f1', legal: { name: 'ЕТ Васил' } }]);
    db.queue([
      { productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300, orderNumber: 5, orderId: 'order-A' },
      { productName: 'Домати', variantLabel: null, quantity: 3, unit: 'кг', priceStotinki: 300, orderNumber: 7, orderId: 'order-B' },
      { productName: 'Краставици', variantLabel: null, quantity: 1, unit: 'бр', priceStotinki: 120, orderNumber: 5, orderId: 'order-A' },
    ]);
    const svc = await build(db);
    const draft = await svc.buildDraft('t1', { kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1' });
    expect([...draft.orderIds].sort()).toEqual(['order-A', 'order-B']); // distinct, not one per item row
  });
```

Add to the `HandoverService.buildDraft operator_to_customer` describe block (after the first test):

```ts
  it('returns the single order id for a customer-leg draft', async () => {
    const db = makeDb();
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]);
    db.queue([{ id: 'o9', customerName: 'Иван Петров', customerPhone: '0888', deliveryAddress: 'ул. Роза 1', totalStotinki: 720, orderNumber: 9 }]);
    db.queue([{ productName: 'Домати', variantLabel: null, quantity: 2, priceStotinki: 300, unit: 'кг', name: 'Домати' }]);
    const svc = await build(db);
    const draft = await svc.buildDraft('t1', { kind: 'operator_to_customer', orderId: 'o9' });
    expect(draft.orderIds).toEqual(['o9']);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @fermeribg/api test -- handover.service.spec.ts -t "distinct order ids|single order id for a customer-leg" --maxWorkers=4`
Expected: FAIL — `draft.orderIds` is `undefined` (property doesn't exist yet).

- [ ] **Step 3: Implement**

In `handover.service.ts`, extend the `FarmerLegItemRow` type (around line 42):

```ts
type FarmerLegItemRow = {
  productName: string | null;
  variantLabel: string | null;
  quantity: number;
  unit: string | null;
  priceStotinki: number;
  orderNumber: number | null;
  orderId: string | null;
};
```

Add `orderId: orders.id,` to the farmer-leg select inside `buildDraft`'s non-`ctx` branch (the `rows = await this.db.select({ ... orderNumber: orders.orderNumber })` block, farmer leg only — leave the `operator_to_customer` / `buildCustomerLegDraft` select untouched, it doesn't need it).

Add `orderId: orders.id,` to the same-shaped select inside `prefetchDraftContext`'s farmer-items query, and add `orderId: r.orderId,` to the object pushed into `farmerItemsByKey`.

Right after the existing `orderNumbers` computation in `buildDraft` (farmer-leg branch):

```ts
    const orderNumbers = [...new Set(rows.map((r) => r.orderNumber).filter((n): n is number => n != null))].sort(
      (a, b) => a - b,
    );
    // Distinct orders behind this farmer's pickup. Persisted onto
    // handover_protocols.order_ids by every write site (Task 2) — today that
    // column is hardcoded null for farmer legs, which leaves listForCheck's
    // orderIds-array courier-scope filter dead for this kind (spec §1.8).
    const orderIds = [...new Set(rows.map((r) => r.orderId).filter((id): id is string => !!id))];
```

Add `orderIds,` to the object `buildDraft` returns (farmer-leg branch), and add `orderIds: string[];` to that method's `Promise<{ ... }>` return-type annotation, right after `orderNumbers: number[];`.

In `buildCustomerLegDraft`, add `orderIds: string[];` to its own `Promise<{ ... }>` return-type annotation, and add `orderIds: [q.orderId!],` to its returned object (right after the existing `orderNumbers` line — `q.orderId` is guaranteed non-null by the `BadRequestException` guard at the top of the function).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @fermeribg/api test -- handover.service.spec.ts --maxWorkers=4`
Expected: PASS — including every pre-existing test in the file (they don't assert `orderIds`, so the new field is invisible to them).

- [ ] **Step 5: TEETH-CHECK**

Temporarily replace the new line with `const orderIds: string[] = [];` (break it), rerun the multi-order test from Step 1 — expect FAIL (`[]` ≠ `['order-A','order-B']`). Restore the real line, rerun — expect PASS again.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/handover/handover.service.ts server/src/modules/handover/handover.service.spec.ts
git commit -m "feat(handover): buildDraft returns the distinct order ids behind a target"
```

---

### Task 2: Persist `orderIds` on every write site (fixes the always-`null` §1.8 bug)

**Files:**
- Modify: `server/src/modules/handover/handover.service.ts`
- Test: `server/src/modules/handover/handover.service.spec.ts`

**Interfaces:**
- Consumes: `draft.orderIds` from Task 1.
- Produces: `handover_protocols.order_ids` is populated for `farmer_to_operator` rows created via `createSigned`, `createBatch`, `ensureDraftTarget`, and `signPaperTarget` — previously always `null` for that kind. This is what makes `listForCheck`'s existing `(r.orderIds ?? []).some((id) => onlyOrderIds.has(id))` branch (`handover.service.ts:1142`) reachable for real data — no change needed there, it already does the right thing once the column is populated.

- [ ] **Step 1: Write the failing tests**

In `handover.service.spec.ts`'s `HandoverService.createSigned` describe block, add:

```ts
  it('persists the distinct order ids for a multi-order farmer pickup (was always null — spec §1.8)', async () => {
    const db = makeDb();
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]);
    db.queue([{ id: 'f1', legal: { name: 'ЕТ Васил' } }]);
    db.queue([
      { productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300, orderNumber: 5, orderId: 'order-A' },
      { productName: 'Краставици', variantLabel: null, quantity: 1, unit: 'бр', priceStotinki: 120, orderNumber: 7, orderId: 'order-B' },
    ]);
    db.queue([]); // outer dup-check (fast-path): none found
    db.queue([]); // in-tx dup re-check under the lock: none found
    db.queue([{ max: 40 }]);
    db.queue([{ id: 'p1', protocolNumber: 41 }]);
    const svc = await build(db);
    await svc.createSigned('t1', {
      kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1',
      items: [{ productName: 'Домати', quantity: 2, priceStotinki: 300 }],
      fromSignaturePng: 'data:image/png;base64,AAA', toSignaturePng: 'data:image/png;base64,BBB',
    } as any);
    const inserted = db.calls.values[0] as any;
    expect([...(inserted.orderIds ?? [])].sort()).toEqual(['order-A', 'order-B']); // OLD: always null
  });
```

In the `HandoverService.createBatch` describe block, add:

```ts
  it('persists order ids on a batch-created farmer protocol (not null — spec §1.8)', async () => {
    const db = makeDb();
    db.queue([{ farmerId: 'f1', slotId: 's1' }]);          // distinct farmer pickups for the slot
    db.queue([]);                                          // no customer orders
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]);         // prefetch: tenant legal
    db.queue([{ id: 'f1', legal: { name: 'ЕТ Васил' }, name: 'Васил' }]); // prefetch: farmers by id
    db.queue([
      { farmerId: 'f1', slotId: 's1', productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300, orderNumber: null, orderId: 'order-A' },
    ]); // prefetch: farmer items
    db.queue([]);            // loop: farmer target existing? none
    db.queue([]);            // in-tx dup re-check under the lock: none
    db.queue([{ max: 5 }]);
    db.queue([{ id: 'p-new' }]);

    const svc = await build(db);
    await svc.createBatch('t1', { slotId: 's1' } as any);
    const inserted = db.calls.values[0] as any;
    expect(inserted.orderIds).toEqual(['order-A']);
  });
```

In the `HandoverService.ensureDraftTarget` describe block, add:

```ts
  it('persists order ids for a farmer target materialized on open (spec §1.8)', async () => {
    const db = makeDb();
    db.queue([]);                                  // existing? none
    db.queue([{ legal: null, name: 'Оп' }]);
    db.queue([{ id: 'f1', legal: null, name: 'Васил' }]);
    db.queue([{ productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300, orderId: 'order-A' }]);
    db.queue([]);                                   // in-tx dup re-check under the lock: none
    db.queue([{ max: 3 }]);
    db.queue([{ id: 'p1' }]);
    const svc = await build(db);
    await svc.ensureDraftTarget('t1', { kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1' });
    const inserted = db.calls.values[0] as any;
    expect(inserted.orderIds).toEqual(['order-A']);
  });
```

In the `HandoverService.signPaperTarget` describe block, add:

```ts
  it('persists order ids for a paper-signed farmer target (spec §1.8)', async () => {
    const db = makeDb();
    db.queue([]);                                  // existing? none
    db.queue([{ legal: null, name: 'Оп' }]);
    db.queue([{ id: 'f1', legal: null, name: 'Васил' }]);
    db.queue([{ productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300, orderId: 'order-A' }]);
    db.queue([]);                                   // in-tx dup re-check under the lock: none
    db.queue([{ max: 7 }]);
    db.queue([{ id: 'p-new' }]);
    const svc = await build(db);
    await svc.signPaperTarget('t1', { kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1' });
    const inserted = db.calls.values[0] as any;
    expect(inserted.orderIds).toEqual(['order-A']);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @fermeribg/api test -- handover.service.spec.ts -t "spec §1.8" --maxWorkers=4`
Expected: FAIL on all four — each currently inserts `orderIds: null` for a farmer-leg target.

- [ ] **Step 3: Implement**

In `handover.service.ts`, replace each of the four occurrences of the null-producing expression with `draft.orderIds.length ? draft.orderIds : null` (the `draft` variable is already in scope at all four sites):

`createSigned` (`orderIds: dto.orderId ? [dto.orderId] : null,`):
```ts
          orderIds: draft.orderIds.length ? draft.orderIds : null,
```

`createBatch` (`orderIds: target.kind === 'operator_to_customer' ? [target.orderId] : null,`):
```ts
            orderIds: draft.orderIds.length ? draft.orderIds : null,
```

`ensureDraftTarget` and `signPaperTarget` (both currently `orderIds: dto.orderId ? [dto.orderId] : null,`):
```ts
          orderIds: draft.orderIds.length ? draft.orderIds : null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @fermeribg/api test -- handover.service.spec.ts --maxWorkers=4`
Expected: PASS — full file, including every pre-existing `createSigned`/`createBatch`/`ensureDraftTarget`/`signPaperTarget` test (none of them assert `orderIds`, so the new value doesn't affect them).

- [ ] **Step 5: TEETH-CHECK**

Temporarily revert the `createSigned` line back to `orderIds: dto.orderId ? [dto.orderId] : null,`, rerun that test from Step 1 — expect FAIL (`inserted.orderIds` is `null`). Restore the fix, rerun — expect PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/handover/handover.service.ts server/src/modules/handover/handover.service.spec.ts
git commit -m "fix(handover): persist orderIds for farmer protocols instead of always null"
```

---

### Task 3: `listForDay` computes an `orderCount` per row

**Files:**
- Modify: `server/src/modules/handover/handover.service.ts`
- Test: `server/src/modules/handover/handover.service.spec.ts`

**Interfaces:**
- Consumes: Task 2's persisted `orderIds` (for persisted rows); the existing `orders`⋈`orderItems`⋈`products` join in `listForDay`'s farmer-pickup query (for virtual rows).
- Produces: `DayProtocolRow.orderCount: number` — for `farmer_to_operator`, the number of distinct orders behind that pickup (virtual or persisted); for `operator_to_customer`, always `1`. Feeds Task 9's "Поръчки" column.

- [ ] **Step 1: Write the failing tests**

In the `HandoverService.listForDay` describe block, add:

```ts
  it('computes orderCount for a virtual (not-yet-persisted) farmer pickup spanning multiple orders', async () => {
    const db = makeDb();
    db.queue([
      { farmerId: 'f1', slotId: 's1', orderId: 'order-A' },
      { farmerId: 'f1', slotId: 's1', orderId: 'order-B' },
    ]); // farmer pickups for the slot (now carrying orderId)
    db.queue([]);                          // no customer orders
    db.queue([]);                          // persisted rows: none
    db.queue([{ legal: null, name: 'Оп' }]);
    db.queue([{ id: 'f1', legal: null, name: 'Васил' }]);

    const svc = await build(db);
    const rows = await svc.listForDay('t1', { slotId: 's1' });
    const farmer = rows.find((r) => r.farmerId === 'f1')!;
    expect(farmer.orderCount).toBe(2);
  });

  it('reads orderCount from the persisted orderIds column for an already-signed farmer protocol', async () => {
    const db = makeDb();
    db.queue([{ farmerId: 'f1', slotId: 's1', orderId: 'order-A' }]);
    db.queue([]);
    db.queue([{
      id: 'p1', kind: 'farmer_to_operator', farmerId: 'f1', orderId: null, slotId: 's1',
      status: 'signed', protocolNumber: 9, orderIds: ['order-A', 'order-B'],
      fromSnapshot: { name: 'Васил' }, toSnapshot: { name: 'Оп' },
    }]); // persisted rows
    db.queue([{ legal: null, name: 'Оп' }]);
    db.queue([{ id: 'f1', legal: null, name: 'Васил' }]);

    const svc = await build(db);
    const rows = await svc.listForDay('t1', { slotId: 's1' });
    const farmer = rows.find((r) => r.farmerId === 'f1')!;
    expect(farmer.id).toBe('p1');
    expect(farmer.orderCount).toBe(2);
  });
```

Extend the existing "merges live-computed targets…" test in the same describe block: after `const customer = rows.find((r) => r.orderId === 'o1')!;`, add:

```ts
    expect(customer.orderCount).toBe(1); // a customer-leg target is always exactly one order
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @fermeribg/api test -- handover.service.spec.ts -t "orderCount|merges live-computed" --maxWorkers=4`
Expected: FAIL — `orderCount` doesn't exist on `DayProtocolRow` yet; TS compile will also fail on the new assertions until the interface is extended.

- [ ] **Step 3: Implement**

Add `orderCount: number;` to the `DayProtocolRow` interface (around line 104-117).

Change `virtualRow`'s `opts` parameter to require `orderCount: number`, and set it on the returned object:

```ts
function virtualRow(
  kind: 'farmer_to_operator' | 'operator_to_customer',
  slotId: string | undefined,
  opts: {
    farmerId?: string;
    orderId?: string;
    from: LegalIdentity | CustomerParty;
    to: LegalIdentity | CustomerParty;
    orderCount: number;
  },
): DayProtocolRow {
  return {
    id: null,
    kind,
    farmerId: opts.farmerId ?? null,
    orderId: opts.orderId ?? null,
    slotId: slotId ?? null,
    protocolNumber: null,
    status: 'draft',
    signMode: 'pending',
    totalStotinki: 0,
    createdAt: null,
    orderCount: opts.orderCount,
    fromSnapshot: opts.from,
    toSnapshot: opts.to,
  };
}
```

In `listForDay`, add `orderId: orders.id` to the `farmerRows` select and widen its inline type to include `orderId: string`:

```ts
    const farmerRows: { farmerId: string | null; slotId: string | null; orderId: string }[] = await this.db
      .select({ farmerId: products.farmerId, slotId: orders.slotId, orderId: orders.id })
      .from(orderItems)
      .innerJoin(products, eq(products.id, orderItems.productId))
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          inArray(orders.slotId, slotIds),
          inArray(orders.status, [...HANDOVER_STATUSES]),
        ),
      );
```

Right after `farmerTargets` is built (the `new Map(...).values()` dedup block), add a second map tracking the distinct order ids per farmer+slot:

```ts
    // Distinct orders behind each farmer+slot pickup, for the day-list order-count
    // column (Task 9) — built from the same raw join, before the farmerTargets dedup.
    const orderIdsByFarmerSlot = new Map<string, Set<string>>();
    for (const r of farmerRows) {
      if (!r.farmerId || !r.slotId || !r.orderId) continue;
      const key = `f:${r.farmerId}:${r.slotId}`;
      const set = orderIdsByFarmerSlot.get(key) ?? new Set<string>();
      set.add(r.orderId);
      orderIdsByFarmerSlot.set(key, set);
    }
```

Right after `persistedByKey` is built (before the `tenantRow`/`farmerById` block), add a small helper that stamps `orderCount` onto a raw persisted row (the actual DB row DOES carry `orderIds` at runtime — `list()`'s bare `.select()`/`getTableColumns()` never drops columns — even though the plain `DayProtocolRow` interface doesn't declare it):

```ts
    type PersistedProtocolRow = DayProtocolRow & { orderIds?: string[] | null };
    const withOrderCount = (r: PersistedProtocolRow): DayProtocolRow => ({
      ...r,
      orderCount: r.orderIds?.length ?? (r.kind === 'operator_to_customer' ? 1 : 0),
    });
```

Change the `persisted` cast to the new intersection type:

```ts
    const persisted = (await this.list(tenantId, { slotId: q.slotId, date: q.date })) as PersistedProtocolRow[];
```

Wrap all three places a persisted row is pushed with `withOrderCount(...)`:

```ts
      const hit = persistedByKey.get(key);
      if (hit) {
        out.push(withOrderCount(hit));
        consumed.add(key);
        continue;
      }
```
(both in the farmer-targets loop and the customer-orders loop), and:

```ts
    for (const [key, r] of persistedByKey) {
      if (!consumed.has(key)) out.push(withOrderCount(r));
    }
```

Pass `orderCount` into both `virtualRow(...)` call sites:

```ts
      out.push(
        virtualRow('farmer_to_operator', t.slotId, {
          farmerId: t.farmerId,
          from: resolveParty(f?.legal, f?.name, 'фермер'),
          to: operatorParty,
          orderCount: orderIdsByFarmerSlot.get(key)?.size ?? 0,
        }),
      );
```

```ts
      out.push(
        virtualRow('operator_to_customer', o.slotId ?? undefined, {
          orderId: o.id,
          from: operatorParty,
          to: { name: o.customerName ?? '—' },
          orderCount: 1,
        }),
      );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @fermeribg/api test -- handover.service.spec.ts --maxWorkers=4`
Expected: PASS — full file.

- [ ] **Step 5: TEETH-CHECK**

Temporarily hardcode `orderCount: 0` in the farmer `virtualRow(...)` call (break it), rerun the "spanning multiple orders" test — expect FAIL (`0` ≠ `2`). Restore, rerun — expect PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/handover/handover.service.ts server/src/modules/handover/handover.service.spec.ts
git commit -m "feat(handover): compute a per-row order count for the day protocol list"
```

---

### Task 4: `FarmersService.listReadiness` + `GET /farmers/readiness`

**Files:**
- Modify: `server/src/modules/farmers/farmers.service.ts`
- Modify: `server/src/modules/farmers/farmers.controller.ts`
- Test: `server/src/modules/farmers/farmers.readiness.spec.ts` (new)

**Interfaces:**
- Consumes: `farmers.legal` (jsonb: `kind`/`name`/`eik`/`vatNumber`/`address`/`regNo`/`confirmedAt`), `farmers.signaturePng` (presence only — never decrypted).
- Produces:
  ```ts
  export type FarmerReadinessMissing = 'kind' | 'name' | 'identifier' | 'address' | 'signature';
  export interface FarmerReadinessRow {
    farmerId: string;
    name: string;
    email: string | null;
    ready: boolean;
    missing: FarmerReadinessMissing[];
  }
  ```
  `FarmersService.listReadiness(tenantId: string): Promise<FarmerReadinessRow[]>`, exposed as `GET /farmers/readiness` (admin-only by default-deny, no `@Roles`).

- [ ] **Step 1: Write the failing tests**

Create `server/src/modules/farmers/farmers.readiness.spec.ts`:

```ts
import { FarmersService } from './farmers.service';

const TENANT = 'tenant-1';

/** Thenable chainable Drizzle mock (mirrors farmers.signature.spec.ts's second
 *  describe / farmers.public-fields.spec.ts): builder methods return `this`;
 *  awaiting the chain resolves the next queued row set. */
function makeDb() {
  const queue: unknown[] = [];
  const db: any = { queue: (v: unknown) => queue.push(v) };
  const chain = () => db;
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) db[m] = jest.fn(chain);
  db.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
    const v = queue.shift();
    if (v instanceof Error) reject(v);
    else resolve(v);
  };
  return db;
}

function make(db: ReturnType<typeof makeDb>) {
  return new FarmersService(db as any, {} as any, {} as any, {} as any, {} as any, {} as any, { enabled: false } as any);
}

describe('FarmersService.listReadiness', () => {
  it('is NOT ready for an individual who filled ЕИК instead of Рег.№ (wrong identifier for the kind)', async () => {
    const db = makeDb();
    db.queue([{
      id: 'f1', name: 'Иван', email: null,
      legal: { kind: 'individual', name: 'Иван Петров', address: 'гр. Варна', eik: '203912345' }, // no regNo
      signaturePng: 'cipher',
    }]);
    const svc = make(db);
    const [row] = await svc.listReadiness(TENANT);
    expect(row.ready).toBe(false);
    expect(row.missing).toContain('identifier');
  });

  it('is NOT ready for a company who filled Рег.№ instead of ЕИК (wrong identifier for the kind)', async () => {
    const db = makeDb();
    db.queue([{
      id: 'f1', name: 'ЕООД', email: null,
      legal: { kind: 'company', name: 'ЕООД „Петров"', address: 'гр. Варна', regNo: '123456789' }, // no eik
      signaturePng: 'cipher',
    }]);
    const svc = make(db);
    const [row] = await svc.listReadiness(TENANT);
    expect(row.ready).toBe(false);
    expect(row.missing).toContain('identifier');
  });

  it('is NOT ready when legal data is complete but no signature is on file', async () => {
    const db = makeDb();
    db.queue([{
      id: 'f1', name: 'ЕООД', email: null,
      legal: { kind: 'company', name: 'ЕООД „Петров"', address: 'гр. Варна', eik: '203912345' },
      signaturePng: null,
    }]);
    const svc = make(db);
    const [row] = await svc.listReadiness(TENANT);
    expect(row.ready).toBe(false);
    expect(row.missing).toEqual(['signature']);
  });

  it('is ready only when BOTH the kind-correct legal identity AND a signature are present', async () => {
    const db = makeDb();
    db.queue([{
      id: 'f1', name: 'ЕООД', email: 'f@x.bg',
      legal: { kind: 'company', name: 'ЕООД „Петров"', address: 'гр. Варна', eik: '203912345' },
      signaturePng: 'cipher',
    }]);
    const svc = make(db);
    const [row] = await svc.listReadiness(TENANT);
    expect(row.ready).toBe(true);
    expect(row.missing).toEqual([]);
  });

  it('never decrypts or exposes the signature blob — only its presence is checked', async () => {
    const db = makeDb();
    db.queue([{
      id: 'f1', name: 'ЕООД', email: null,
      legal: { kind: 'company', name: 'ЕООД „Петров"', address: 'гр. Варна', eik: '203912345' },
      signaturePng: 'super-secret-ciphertext',
    }]);
    const svc = make(db);
    const [row] = await svc.listReadiness(TENANT);
    expect(row).not.toHaveProperty('signaturePng');
    expect(JSON.stringify(row)).not.toContain('super-secret-ciphertext');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @fermeribg/api test -- farmers.readiness.spec.ts --maxWorkers=4`
Expected: FAIL — `svc.listReadiness` doesn't exist yet.

- [ ] **Step 3: Implement**

In `farmers.service.ts`, add near the top (module scope, after the imports):

```ts
/** Codes for what's missing from a farmer's protocol-readiness (§5.1 of the
 *  consolidated-handover-protocol spec), in the same priority order surfaced to
 *  the "Готовност на фермерите" board. */
export type FarmerReadinessMissing = 'kind' | 'name' | 'identifier' | 'address' | 'signature';

export interface FarmerReadinessRow {
  farmerId: string;
  name: string;
  email: string | null;
  ready: boolean;
  missing: FarmerReadinessMissing[];
}
```

Add a new method right after `listAccess` (before `grantAccess`):

```ts
  /**
   * Per-farmer protocol-readiness for the "Готовност на фермерите" board (spec
   * §5.1/§5.2) — legal identity complete for the CHOSEN kind, AND a signature on
   * file. Read-only / advisory: nothing here blocks a handover (§5.3).
   *
   * The identifier check mirrors client/src/lib/legal-identity.ts's
   * buildLegalPayload EXACTLY: individual → regNo, everyone else (incl. unset
   * kind) → eik. Checking "either identifier" would let a wrongly-filled one
   * pass — an individual who typed their ЕИК instead of Рег.№ is not ready,
   * even though a field is technically filled in.
   *
   * Never decrypts the signature — only NOT NULL is checked, and the ciphertext
   * is never included in the response (same posture as findAll/findOne's
   * stripSignature, just via a narrower SELECT instead of an omit).
   */
  async listReadiness(tenantId: string): Promise<FarmerReadinessRow[]> {
    const rows = await this.db
      .select({
        id: farmers.id,
        name: farmers.name,
        email: farmers.email,
        legal: farmers.legal,
        signaturePng: farmers.signaturePng,
      })
      .from(farmers)
      .where(eq(farmers.tenantId, tenantId))
      .orderBy(asc(farmers.position), asc(farmers.createdAt));

    return rows.map((r) => {
      const legal = r.legal;
      const missing: FarmerReadinessMissing[] = [];
      if (!legal?.kind) missing.push('kind');
      if (!legal?.name?.trim()) missing.push('name');
      const isIndividual = legal?.kind === 'individual';
      const identifierOk = isIndividual ? !!legal?.regNo?.trim() : !!legal?.eik?.trim();
      if (!identifierOk) missing.push('identifier');
      if (!legal?.address?.trim()) missing.push('address');
      if (!r.signaturePng) missing.push('signature');
      return { farmerId: r.id, name: r.name, email: r.email, ready: missing.length === 0, missing };
    });
  }
```

In `farmers.controller.ts`, add right after the `listAccess` route (before the "Producer self-service" comment block):

```ts
  // Literal route — must precede `:id` so "readiness" isn't captured as a farmer id.
  @Get('readiness')
  listReadiness(@CurrentTenant() tenantId: string) {
    return this.farmersService.listReadiness(tenantId);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @fermeribg/api test -- farmers.readiness.spec.ts --maxWorkers=4`
Expected: PASS — all 5 tests.

- [ ] **Step 5: TEETH-CHECK**

Temporarily change `identifierOk` to ignore `kind` (`const identifierOk = !!legal?.eik?.trim() || !!legal?.regNo?.trim();`), rerun the "individual filled ЕИК instead of Рег.№" test — expect FAIL (now reports `ready`, reproducing the exact bug spec §5.1 calls out). Restore the kind-aware check, rerun — expect PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/farmers/farmers.service.ts server/src/modules/farmers/farmers.controller.ts server/src/modules/farmers/farmers.readiness.spec.ts
git commit -m "feat(farmers): add a read-only per-farmer protocol-readiness check"
```

---

### Task 5: Client types + API wiring for readiness and order count

**Files:**
- Modify: `client/src/lib/types.ts`
- Modify: `client/src/lib/api-client.ts`

**Interfaces:**
- Consumes: `GET /farmers/readiness` (Task 4), the extended `DayProtocolRow` shape (Task 3).
- Produces:
  ```ts
  export type FarmerReadinessMissing = 'kind' | 'name' | 'identifier' | 'address' | 'signature';
  export interface FarmerReadiness {
    farmerId: string;
    name: string;
    email: string | null;
    ready: boolean;
    missing: FarmerReadinessMissing[];
  }
  ```
  `getFarmerReadiness(): Promise<FarmerReadiness[]>` in `api-client.ts`. `DayProtocolRow.orderCount: number` added.

This task has no dedicated automated test — it's a pure type/wiring addition consumed (and exercised) by Task 6's tests and Task 7/9's components. Its correctness is verified structurally: the plan's later steps will fail to compile/import if these are wrong.

- [ ] **Step 1: Add the type**

In `client/src/lib/types.ts`, right after the `FarmerAccess` interface:

```ts
export type FarmerReadinessMissing = 'kind' | 'name' | 'identifier' | 'address' | 'signature';

/** A row in the "Готовност на фермерите" board (GET /farmers/readiness). Read-only
 *  / advisory — never blocks a handover (spec §5.3). */
export interface FarmerReadiness {
  farmerId: string;
  name: string;
  email: string | null;
  ready: boolean;
  missing: FarmerReadinessMissing[];
}
```

In the `DayProtocolRow` interface ONLY (not `ProtocolRow` — that's the plain `GET /handover` list shape and is out of scope here; only the day-view `listForDay`/`GET /handover/day` shape gains `orderCount`), add `orderCount: number;` right after `protocolNumber: number | null;`:

```ts
export interface DayProtocolRow {
  id: string | null;
  kind: string;
  farmerId: string | null;
  orderId: string | null;
  slotId: string | null;
  protocolNumber: number | null;
  orderCount: number;
  status: string;
  signMode: string;
  totalStotinki: number;
  createdAt: string | null;
  fromSnapshot: LegalIdentity;
  toSnapshot: LegalIdentity;
}
```

- [ ] **Step 2: Add the API call**

In `client/src/lib/api-client.ts`, in the `// ---- Farmers ----` section, right after `listFarmers`:

```ts
export const getFarmerReadiness = () => apiFetch<FarmerReadiness[]>('farmers/readiness');
```

Add `FarmerReadiness` into the existing alphabetized `import type { ... } from './types';` block at the top of the file (the same block that already imports `Farmer`, `FarmerAccess`, `FarmerLegal`, `DayProtocolRow`, etc.) — insert it right after `FarmerLegal` (alphabetical order: `FarmerAccess` < `FarmerLegal` < `FarmerReadiness`).

- [ ] **Step 3: Verify it compiles**

Run: `pnpm --filter @fermeribg/web test -- --run` (or `pnpm --filter @fermeribg/web build` if a quick full build is preferred) — this is a type-only change; a green run with no new failures is the acceptance bar for this task.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/api-client.ts
git commit -m "feat(client): add types + API call for farmer readiness and order count"
```

---

### Task 6: Client pure logic — sort order + missing-reason labels

**Files:**
- Create: `client/src/lib/farmer-readiness.ts`
- Test: `client/src/lib/farmer-readiness.test.ts`

**Interfaces:**
- Consumes: `FarmerReadiness`, `FarmerReadinessMissing` from `./types` (Task 5).
- Produces:
  ```ts
  export const READINESS_MISSING_LABEL: Record<FarmerReadinessMissing, string>;
  export function sortReadiness(rows: FarmerReadiness[]): FarmerReadiness[];
  ```
  Consumed by Task 7's `FarmerReadinessBoard`.

- [ ] **Step 1: Write the failing tests**

Create `client/src/lib/farmer-readiness.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sortReadiness, READINESS_MISSING_LABEL } from './farmer-readiness';
import type { FarmerReadiness, FarmerReadinessMissing } from './types';

const row = (over: Partial<FarmerReadiness> = {}): FarmerReadiness => ({
  farmerId: 'f1',
  name: 'Фермер',
  email: null,
  ready: true,
  missing: [],
  ...over,
});

describe('sortReadiness', () => {
  it('puts incomplete farmers first, even when that breaks alphabetical order', () => {
    const rows = [
      row({ farmerId: 'a', name: 'Ана', ready: true, missing: [] }),
      row({ farmerId: 'b', name: 'Борис', ready: false, missing: ['signature'] }),
    ];
    const sorted = sortReadiness(rows);
    expect(sorted.map((r) => r.farmerId)).toEqual(['b', 'a']); // not-ready Борис before ready Ана
  });

  it('sorts alphabetically (bg) among farmers with the same readiness', () => {
    const rows = [
      row({ farmerId: 'z', name: 'Явор', ready: false, missing: ['address'] }),
      row({ farmerId: 'a', name: 'Ана', ready: false, missing: ['signature'] }),
    ];
    const sorted = sortReadiness(rows);
    expect(sorted.map((r) => r.farmerId)).toEqual(['a', 'z']);
  });

  it('does not mutate the input array', () => {
    const rows = [row({ farmerId: 'a', ready: true }), row({ farmerId: 'b', ready: false })];
    const copy = [...rows];
    sortReadiness(rows);
    expect(rows).toEqual(copy);
  });
});

describe('READINESS_MISSING_LABEL', () => {
  it('has a non-empty Bulgarian label for every FarmerReadinessMissing code', () => {
    const codes: FarmerReadinessMissing[] = ['kind', 'name', 'identifier', 'address', 'signature'];
    for (const c of codes) expect(READINESS_MISSING_LABEL[c]?.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @fermeribg/web test -- farmer-readiness.test.ts`
Expected: FAIL — `./farmer-readiness` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `client/src/lib/farmer-readiness.ts`:

```ts
import type { FarmerReadiness, FarmerReadinessMissing } from './types';

/** Bulgarian label for each readiness gap, shown on the "Готовност на фермерите"
 *  board next to a farmer's name (spec §5.2 — "назовано какво липсва", not a
 *  percentage). */
export const READINESS_MISSING_LABEL: Record<FarmerReadinessMissing, string> = {
  kind: 'няма избран вид лице',
  name: 'няма име',
  identifier: 'няма ЕИК / Рег.№',
  address: 'няма адрес',
  signature: 'няма подпис',
};

/** Incomplete farmers first (spec §5.2 — "непълните най-отгоре"), then
 *  alphabetically by name within the same readiness state. Does not mutate
 *  its input. */
export function sortReadiness(rows: FarmerReadiness[]): FarmerReadiness[] {
  return [...rows].sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? 1 : -1;
    return a.name.localeCompare(b.name, 'bg');
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @fermeribg/web test -- farmer-readiness.test.ts`
Expected: PASS — all 4 tests.

- [ ] **Step 5: TEETH-CHECK**

Temporarily invert the comparator (`return a.ready ? -1 : 1;`), rerun the first test — expect FAIL (order reversed). Restore, rerun — expect PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/farmer-readiness.ts client/src/lib/farmer-readiness.test.ts
git commit -m "feat(client): add pure sort/label helpers for the readiness board"
```

---

### Task 7: `FarmerReadinessBoard` component, mounted on `/protocols`

**Files:**
- Create: `client/src/components/handover/farmer-readiness-board.tsx`
- Modify: `client/src/components/handover/protocols-client.tsx`

**Interfaces:**
- Consumes: `getFarmerReadiness()` (Task 5), `sortReadiness`/`READINESS_MISSING_LABEL` (Task 6), `grantFarmerAccess` (existing, `client/src/lib/api-client.ts`).
- Produces: `<FarmerReadinessBoard />` — no props, self-fetching, rendered once on the Protocols screen.

No automated test for this step (repo constraint: vitest is NODE-env only, no jsdom/RTL — component rendering/click behavior can't be unit-tested here). Verified manually per Step 4 below. All derivable logic it needs (`sortReadiness`, `READINESS_MISSING_LABEL`) is already covered by Task 6's real tests — this task is thin JSX + two existing API calls.

- [ ] **Step 1: Create the component**

Create `client/src/components/handover/farmer-readiness-board.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError, getFarmerReadiness, grantFarmerAccess } from '@/lib/api-client';
import { sortReadiness, READINESS_MISSING_LABEL } from '@/lib/farmer-readiness';
import type { FarmerReadiness } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

/**
 * «Готовност на фермерите» (spec §5.2) — read-only board on the Protocols screen:
 * per farmer, whether their legal identity + signature are complete enough to
 * print a filled-in handover protocol. NEVER blocks anything (§5.3) — this is
 * pure information, with a shortcut to the two paths that already exist
 * elsewhere: editing the farmer directly, or re-sending their self-service
 * invite (same `grantFarmerAccess` the Фермери screen already uses).
 */
export function FarmerReadinessBoard() {
  const [rows, setRows] = useState<FarmerReadiness[] | null>(null);
  const [invitingId, setInvitingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getFarmerReadiness()
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e) => toast.error(errMsg(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  if (rows === null) return null; // loading — the rest of the Protocols screen isn't gated on this
  const incomplete = sortReadiness(rows).filter((r) => !r.ready);
  if (incomplete.length === 0) return null; // nothing to flag — don't take up space when everyone's ready

  async function invite(row: FarmerReadiness) {
    if (!row.email) return;
    setInvitingId(row.farmerId);
    try {
      await grantFarmerAccess(row.farmerId, row.email);
      toast.success(`Поканата е изпратена на ${row.name}`);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setInvitingId(null);
    }
  }

  return (
    <div className="mb-5 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
      <div className="flex items-center gap-2 border-b border-ff-border-2 px-5 py-3.5">
        <AlertCircle size={18} className="text-ff-amber-600" />
        <h2 className="text-[15px] font-extrabold">Готовност на фермерите</h2>
        <span className="text-[12.5px] text-ff-muted">
          {incomplete.length} без пълни данни — протоколите им излизат с празни полета
        </span>
      </div>
      <div className="flex flex-col">
        {incomplete.map((row) => (
          <div
            key={row.farmerId}
            className="flex flex-wrap items-center justify-between gap-2.5 border-b border-ff-border-2 px-5 py-3 last:border-0"
          >
            <div>
              <div className="text-[14px] font-bold">{row.name}</div>
              <div className="text-[12.5px] text-ff-muted">
                {row.missing.map((m) => READINESS_MISSING_LABEL[m]).join(' · ')}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                href={`/farmers?edit=${row.farmerId}`}
                className="inline-flex items-center rounded-lg border border-ff-border bg-ff-surface-2 px-3 py-1.5 text-[12.5px] font-bold text-ff-ink-2"
              >
                Попълни вместо него
              </a>
              <Button
                variant="ghost"
                size="sm"
                disabled={!row.email || invitingId === row.farmerId}
                title={row.email ? undefined : 'Добави имейл на фермера, за да изпратиш покана'}
                onClick={() => void invite(row)}
              >
                <Send size={14} /> Прати покана
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount it on the Protocols screen**

In `protocols-client.tsx`, add the import alongside the others:

```ts
import { FarmerReadinessBoard } from './farmer-readiness-board';
```

Render it right after the toolbar `<div>` (before the "farmer pickups" block comment), as its own self-contained block to minimize overlap with any other in-flight change to this file:

```tsx
      {/* farmer protocol readiness — advisory only, spec §5.2/§5.3 */}
      <FarmerReadinessBoard />

      {/* farmer pickups */}
```

- [ ] **Step 3: Verify it compiles**

Run: `pnpm --filter @fermeribg/web test -- --run` (or `pnpm --filter @fermeribg/web build`) — expect no new failures/type errors.

- [ ] **Step 4: Manual verification (substitutes for an automated test — see Global Constraints)**

Start the client dev server and the API against a tenant with at least one farmer missing legal data and one missing a signature. Open `/protocols`:
- Confirm the board appears above "Прибиране от фермери" listing exactly the incomplete farmers, each with its actual missing-field labels.
- Confirm a fully-complete farmer does NOT appear in the list.
- Click "Прати покана" for a farmer with an email on file — confirm a success toast and that `POST /farmers/:id/access` fires (Network tab) with that farmer's own email.
- Confirm "Прати покана" is disabled (with the hint tooltip) for a farmer with no email on file.
- Confirm nothing on this screen becomes blocked/disabled elsewhere — printing, signing, and «Отбележи всички подписани» all still work regardless of readiness state (spec §5.3).

**TEETH-CHECK (manual, since there's no automated harness for this JSX):** temporarily change the `if (incomplete.length === 0) return null;` line to `if (rows.length === 0) return null;` (so the board wrongly renders even when everyone is ready) — reload `/protocols` with an all-ready tenant fixture and confirm the board now WRONGLY appears (proves the guard is live, not coincidental). Restore the original line and confirm it disappears again.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/handover/farmer-readiness-board.tsx client/src/components/handover/protocols-client.tsx
git commit -m "feat(handover): show a farmer protocol-readiness board on /protocols"
```

---

### Task 8: Deep-link `/farmers?edit=<id>` to open a specific farmer's edit panel

**Files:**
- Modify: `client/src/components/farmers/farmers-client.tsx`

**Interfaces:**
- Consumes: the `edit` search param; the existing `openEdit(f: Partial<Farmer>, invite = false)` closure already in `FarmersClient`.
- Produces: navigating to `/farmers?edit=<farmerId>` (as `FarmerReadinessBoard`'s "Попълни вместо него" link does) opens that farmer's edit panel automatically, landing on the general edit form (not the invite section — that's the existing `?invite`-style `focusInvite` flow, unaffected).

No automated test (JSX/effect wiring only — see Global Constraints). Manual verification + manual teeth-check substitute.

- [ ] **Step 1: Implement**

In `client/src/components/farmers/farmers-client.tsx`, add the import:

```ts
import { useSearchParams } from 'next/navigation';
```

Inside `FarmersClient`, right after the `openEdit` function is defined, add:

```ts
  // Deep-link from elsewhere in the panel (e.g. the Protocols screen's readiness
  // board's "Попълни вместо него") — opens that farmer's edit panel on load.
  // Runs once the farmer list is available; a stale/unknown id is a no-op (the
  // farmer may have been deleted since the link was generated).
  const searchParams = useSearchParams();
  useEffect(() => {
    const editId = searchParams.get('edit');
    if (!editId) return;
    const target = farmers.find((f) => f.id === editId);
    if (target) openEdit(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
```

Add `useEffect` to the existing `import { useMemo, useRef, useState } from 'react';` line (making it `useEffect, useMemo, useRef, useState`).

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @fermeribg/web test -- --run` (or `pnpm --filter @fermeribg/web build`) — expect no new failures/type errors. `useSearchParams` requires the route to render dynamically; `client/src/app/(admin)/farmers/page.tsx` already sets `export const dynamic = 'force-dynamic'`, so no further change is needed there.

- [ ] **Step 3: Manual verification + manual TEETH-CHECK**

Open `/farmers?edit=<a real farmer id from this tenant>` — confirm that farmer's edit panel opens automatically on load, landing on the general form (not scrolled to the invite section). Open `/farmers?edit=does-not-exist` — confirm nothing opens and the page behaves as a normal `/farmers` visit (no error).

TEETH-CHECK: temporarily change the comparison to `f.id === editId + 'x'` (guaranteed never to match) — reload `/farmers?edit=<real id>` and confirm the panel no longer opens (proves the effect is what's opening it, not something else). Restore the comparison and confirm it opens again.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/farmers/farmers-client.tsx
git commit -m "feat(farmers): support ?edit=<id> to deep-link into a farmer's edit panel"
```

---

### Task 9: §5.4 list fixes — protocol number + order count columns

**Files:**
- Modify: `client/src/components/handover/protocols-client.tsx`

**Interfaces:**
- Consumes: `row.protocolNumber` (already present) and `row.orderCount` (Task 3/5) on `DayProtocolRow`.
- Produces: the "Всички протоколи за деня" table (both desktop `<table>` and the mobile card list) gains a protocol-number and an order/row-count display — today it shows only `[Вид, Страна, Статус, Действия]` (spec §5.4).

No automated test (JSX-only table/column change — see Global Constraints). Manual verification substitutes.

- [ ] **Step 1: Implement**

In the desktop `<table>` for "Всички протоколи за деня", change the header array and add two `<td>`s. The header row currently is:

```tsx
              {['Вид', 'Страна', 'Статус'].map((h) => (
```

Change to:

```tsx
              {['№', 'Вид', 'Страна', 'Поръчки', 'Статус'].map((h) => (
```

In the corresponding `<tbody>` row (the one mapping `rows.map((row) => ...)` for this table — NOT the farmer-only table above it), add a `№` cell before the "Вид" cell and a "Поръчки" cell after "Страна":

```tsx
                <td className="px-5 py-3.5 align-top text-[13.5px] font-semibold text-ff-ink-2">
                  {row.protocolNumber ?? '—'}
                </td>
                <td className="px-5 py-3.5 align-top text-[13.5px] font-semibold text-ff-ink-2">
                  {KIND_LABEL[row.kind] ?? row.kind}
                </td>
                <td className="px-5 py-3.5 align-top text-[14px] font-bold">{partyName(row)}</td>
                <td className="px-5 py-3.5 align-top text-[13.5px] text-ff-ink-2">{row.orderCount}</td>
                <td className="px-5 py-3.5 align-top">
                  <StatusPill status={row.status} />
                </td>
```

In the mobile card list for the same table, add the protocol number + order count as a small line under the kind label:

```tsx
                <div>
                  <div className="text-[14.5px] font-extrabold">{partyName(row)}</div>
                  <div className="text-[12px] text-ff-muted">
                    {KIND_LABEL[row.kind] ?? row.kind} · № {row.protocolNumber ?? '—'} · {row.orderCount} поръчки
                  </div>
                </div>
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @fermeribg/web test -- --run` (or `pnpm --filter @fermeribg/web build`) — expect no new failures/type errors.

- [ ] **Step 3: Manual verification**

Open `/protocols` for a date with both a multi-order farmer pickup and a customer delivery. Confirm the "Всички протоколи за деня" table (desktop) shows a `№` column (a number for persisted rows, `—` for virtual/draft rows) and a "Поръчки" column (`2`+ for a multi-order farmer pickup, `1` for every customer delivery). Confirm the mobile card view (narrow viewport) shows the same two pieces of information inline. Confirm the farmer-only table above it ("Прибиране от фермери") is untouched — this fix is scoped to the "Всички протоколи за деня" table only, per spec §5.4's literal description of that table's columns.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/handover/protocols-client.tsx
git commit -m "feat(handover): show protocol number + order count in the day protocol list"
```

---

## Self-Review Notes

- **Spec coverage:** §5.1 (the check) → Task 4. §5.2 (the screen) → Task 7 (+ Task 8 for the "Попълни вместо него" deep link, Task 6 for its sort/label logic). §5.3 (must not block) → enforced as a Global Constraint; no task adds a guard. §5.4 (small list fixes) → Task 9 (+ Task 3 supplies `orderCount`). §1.8 (`orderIds` fix) → Tasks 1–2 (+ Task 3 reuses the same persisted column for `orderCount`, tying the two together).
- **No migration:** confirmed by reading `packages/db/src/schema.ts` directly — `handover_protocols.order_ids`, `farmers.legal`, `farmers.signature_png` all already exist on this branch.
- **Overlap with Phase 1:** Phase 1 (consolidated protocol) very likely also touches `client/src/app/(admin)/protocols/page.tsx` / `protocols-client.tsx` (new screen/section for the consolidated document) and possibly `handover.service.ts` (shared draft-context reuse). This plan touches `protocols-client.tsx` in Tasks 7 and 9 (both small, additive, clearly-commented blocks — a new import + a self-contained JSX block, and two `<td>`/header edits in one existing table) and `handover.service.ts` in Tasks 1–3 (new fields/computations, no changes to existing method signatures used by the controller). It does NOT touch `handover.controller.ts` at all — no route signatures change. Sequencing/merge order between this phase and Phase 1 on `protocols-client.tsx` and `handover.service.ts` is the one open question for the orchestrator (see below).
