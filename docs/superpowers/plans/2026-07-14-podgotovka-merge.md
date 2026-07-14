# Подготовка — merge Производство + Утре — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the `/production` (by-product) and `/tomorrow` (by-order) farmer-panel screens into one page `/prep` ("Подготовка") with a `По поръчка` ⇄ `По продукт` view toggle, where orders are the single source of truth for "готово".

**Architecture:** One backend feed `GET /orders/prep?date=&farmerId=` returns tomorrow-style per-order rows for any day. The order view renders those rows and ticks server-side fulfillment state; the product view aggregates the same rows on the frontend (progress derived from fulfilled orders — the two views can never disagree). Per-farmer scoping throughout; date-nav defaults to tomorrow.

**Tech Stack:** NestJS + Drizzle (backend, jest), Next.js App Router + React (client, vitest), Tailwind (ff-* design tokens).

## Global Constraints

- **Single source of truth = orders.** Product view is READ-ONLY; ticking happens only in the order view via `PATCH /orders/:id/fulfillment`. The old localStorage product-tick system is deleted.
- **Per-farmer scoping** everywhere (matches Утре). Single-farmer shop → auto-scoped, no picker. Multi-farmer shop → farmer picker. Product view aggregates that one farmer's items.
- **Date-nav default = tomorrow** (Europe/Sofia).
- **`scheduledForDay` requires a `leftJoin(deliverySlots)`** on every query using it — never remove that join, or Postgres throws "missing FROM-clause entry".
- **Nav item name = "Подготовка"**, not gated (use `@Roles('admin','farmer')` only, no `ActiveSubscriptionGuard`).
- **Backend-first deploy** if merging to a live env (frontend calls `/orders/prep` before old routes are gone).
- Backend tests: unit-only with chainable db mocks (no DB harness in this repo). Client tests: vitest, `*.test.ts`.

---

## File structure

**Backend (`server/src/modules/orders/`):**
- `orders.service.ts` — MODIFY: rename `tomorrowForFarmer` → `prepOrders(tenantId, farmerId, date?)`; add `prepSummary(...)` + private `pendingCountForFarmer(...)` + `PrepSummary` interface; delete `production()`, `ProductionSummary`, `ProductionItem`.
- `orders.controller.ts` — MODIFY: add `@Get('prep')`; delete `@Get('production')` and `@Get('tomorrow')`.
- `orders.tomorrow.spec.ts` → RENAME `orders.prep.spec.ts` — port + add date/composition cases.
- `orders.controller.spec.ts` — MODIFY only if it references the removed routes.

**Client (`client/src/`):**
- `lib/api-client.ts` — MODIFY: add `getPrep` + `PrepSummary`; delete `getProduction`.
- `lib/types.ts` — MODIFY: delete `ProductionSummary`, `ProductionItem`.
- `components/prep/aggregate.ts` — CREATE: pure `aggregateByProduct`.
- `components/prep/aggregate.test.ts` — CREATE: vitest.
- `components/prep/prep-client.tsx` — CREATE: merged UI (both views).
- `app/(admin)/prep/page.tsx` — CREATE: server page.
- `app/(admin)/tomorrow/page.tsx` — REPLACE body with redirect to `/prep`.
- `app/(admin)/production/page.tsx` — REPLACE body with redirect to `/prep`.
- `components/tomorrow/tomorrow-client.tsx` — DELETE.
- `components/production/prep-list.tsx` — DELETE (keep `date-nav-bar.tsx` — shared by handover + orders).
- `components/layout/sidebar.tsx` — MODIFY: swap two nav entries for one.

---

### Task 1: Backend — generalize the order feed to any date (`prepOrders`)

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts` (`tomorrowForFarmer` ~lines 971-1046)
- Rename+modify: `server/src/modules/orders/orders.tomorrow.spec.ts` → `orders.prep.spec.ts`

**Interfaces:**
- Produces: `prepOrders(tenantId: string, farmerId: string, date?: string): Promise<TomorrowOrder[]>` — the existing tomorrow query with the day parameterized (default = tomorrow). `TomorrowOrder` / `TomorrowOrderItem` / `FulfillmentState` are unchanged.

- [ ] **Step 1: Rename the spec file and update it to call `prepOrders` with a date**

Rename `orders.tomorrow.spec.ts` → `orders.prep.spec.ts`. Change the `describe` title and the three `tomorrowForFarmer` calls to `prepOrders` with an explicit date, and add one case proving an arbitrary date is accepted. Replace the top `describe('OrdersService.tomorrowForFarmer', ...)` block (keep the `setFulfillment` block below it untouched):

```ts
describe('OrdersService.prepOrders', () => {
  function makeSvc(rows: unknown[]) {
    const chain: any = {};
    chain.select = jest.fn(() => chain);
    chain.from = jest.fn(() => chain);
    chain.innerJoin = jest.fn(() => chain);
    chain.leftJoin = jest.fn(() => chain);
    chain.where = jest.fn(() => chain);
    chain.orderBy = jest.fn(() => Promise.resolve(rows));
    const svc = new OrdersService(
      chain as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
    );
    return { svc };
  }

  it('groups line items into one order per orderId, defaulting fulfillmentState to pending when no row exists', async () => {
    const { svc } = makeSvc([
      {
        orderId: 'o1', orderNumber: 5, customerName: 'Мария', customerPhone: '0888111222',
        customerEmail: 'maria@example.com', deliveryType: 'address', day: '2026-07-14',
        slotFrom: '10:00:00', slotTo: '12:00:00', state: null,
        productId: 'p1', productName: 'Домати', quantity: 3,
      },
      {
        orderId: 'o1', orderNumber: 5, customerName: 'Мария', customerPhone: '0888111222',
        customerEmail: 'maria@example.com', deliveryType: 'address', day: '2026-07-14',
        slotFrom: '10:00:00', slotTo: '12:00:00', state: null,
        productId: 'p2', productName: 'Краставици', quantity: 2,
      },
    ]);
    const result = await svc.prepOrders('t', 'farmer-1', '2026-07-14');
    expect(result).toHaveLength(1);
    expect(result[0].fulfillmentState).toBe('pending');
    expect(result[0].items).toHaveLength(2);
    expect(result[0].customerPhone).toBe('0888111222');
  });

  it('surfaces a non-default fulfillmentState from order_fulfillments', async () => {
    const { svc } = makeSvc([
      {
        orderId: 'o2', orderNumber: 6, customerName: 'Иван', customerPhone: null,
        customerEmail: null, deliveryType: 'pickup', day: '2026-07-20',
        slotFrom: null, slotTo: null, state: 'in_production',
        productId: 'p1', productName: 'Мед', quantity: 1,
      },
    ]);
    const result = await svc.prepOrders('t', 'farmer-1', '2026-07-20');
    expect(result[0].fulfillmentState).toBe('in_production');
  });

  it('accepts an arbitrary date and still returns an empty list with no rows', async () => {
    const { svc } = makeSvc([]);
    const result = await svc.prepOrders('t', 'farmer-1', '2026-08-01');
    expect(result).toEqual([]);
  });

  it('defaults to tomorrow when no date is passed (no throw)', async () => {
    const { svc } = makeSvc([]);
    const result = await svc.prepOrders('t', 'farmer-1');
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the spec to verify it fails**

Run: `pnpm --filter @fermeribg/api test orders.prep`
Expected: FAIL — `svc.prepOrders is not a function` (method still named `tomorrowForFarmer`).

- [ ] **Step 3: Rename the method and parameterize the date**

In `orders.service.ts`, change the method signature and the day it filters on. Rename `tomorrowForFarmer` → `prepOrders` and replace the hard-coded tomorrow with a `date` param (keep the `deliverySlots` leftJoin — it powers `scheduledForDay`):

```ts
  async prepOrders(tenantId: string, farmerId: string, date?: string): Promise<TomorrowOrder[]> {
    const targetDay = date ?? bgAddDays(bgToday(), 1);
    const day = sql<string>`coalesce(${deliverySlots.date}, ${bgDate(orders.createdAt)})`;
    const rows = await this.db
      .select({
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        customerPhone: orders.customerPhone,
        customerEmail: orders.customerEmail,
        deliveryType: orders.deliveryType,
        day,
        slotFrom: deliverySlots.timeFrom,
        slotTo: deliverySlots.timeTo,
        state: orderFulfillments.state,
        productId: orderItems.productId,
        productName: products.name,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .leftJoin(
        orderFulfillments,
        and(eq(orderFulfillments.orderId, orders.id), eq(orderFulfillments.farmerId, farmerId)),
      )
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.status, 'confirmed'),
          eq(products.farmerId, farmerId),
          scheduledForDay(targetDay),
        )!,
      )
      .orderBy(orders.createdAt);
```

Leave the row-folding loop below (`const byOrder = new Map...` through `return [...byOrder.values()];`) exactly as-is. Also update the method's doc-comment header to describe "one day's confirmed orders" instead of "tomorrow's".

- [ ] **Step 4: Run the spec to verify it passes**

Run: `pnpm --filter @fermeribg/api test orders.prep`
Expected: PASS (the `prepOrders` block; the `setFulfillment` block still passes unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/orders.service.ts server/src/modules/orders/orders.prep.spec.ts
git rm server/src/modules/orders/orders.tomorrow.spec.ts 2>/dev/null || true
git commit -m "refactor(orders): generalize tomorrowForFarmer to prepOrders(date)"
```

---

### Task 2: Backend — compose `prepSummary` (orders + pending count)

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts`
- Modify: `server/src/modules/orders/orders.prep.spec.ts`

**Interfaces:**
- Consumes: `prepOrders(tenantId, farmerId, date?)` from Task 1.
- Produces:
  ```ts
  interface PrepSummary {
    date: string;              // yyyy-mm-dd actually queried
    confirmedOrders: number;   // = orders.length
    pendingOrders: number;     // pending orders on the day containing this farmer's items
    orders: TomorrowOrder[];
  }
  ```
  `prepSummary(tenantId: string, farmerId: string, date?: string): Promise<PrepSummary>`

- [ ] **Step 1: Write the failing composition test**

Append to `orders.prep.spec.ts`:

```ts
describe('OrdersService.prepSummary', () => {
  function makeSvc() {
    const svc = new OrdersService(
      {} as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
    );
    return { svc };
  }

  it('composes orders + counts, defaulting confirmedOrders to orders.length', async () => {
    const { svc } = makeSvc();
    const orders = [
      { id: 'o1', orderNumber: 1, customerName: null, customerPhone: null, customerEmail: null,
        deliveryType: 'pickup', day: '2026-07-15', slotFrom: null, slotTo: null,
        fulfillmentState: 'pending' as const, items: [] },
      { id: 'o2', orderNumber: 2, customerName: null, customerPhone: null, customerEmail: null,
        deliveryType: 'pickup', day: '2026-07-15', slotFrom: null, slotTo: null,
        fulfillmentState: 'fulfilled' as const, items: [] },
    ];
    jest.spyOn(svc, 'prepOrders').mockResolvedValue(orders);
    jest.spyOn(svc as never, 'pendingCountForFarmer' as never).mockResolvedValue(3 as never);

    const summary = await svc.prepSummary('t', 'farmer-1', '2026-07-15');
    expect(summary.date).toBe('2026-07-15');
    expect(summary.confirmedOrders).toBe(2);
    expect(summary.pendingOrders).toBe(3);
    expect(summary.orders).toBe(orders);
  });

  it('falls back to tomorrow for the date when none is passed', async () => {
    const { svc } = makeSvc();
    jest.spyOn(svc, 'prepOrders').mockResolvedValue([]);
    jest.spyOn(svc as never, 'pendingCountForFarmer' as never).mockResolvedValue(0 as never);
    const summary = await svc.prepSummary('t', 'farmer-1');
    expect(summary.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(summary.confirmedOrders).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @fermeribg/api test orders.prep`
Expected: FAIL — `svc.prepSummary is not a function`.

- [ ] **Step 3: Add the `PrepSummary` interface, `prepSummary`, and `pendingCountForFarmer`**

Add the interface near `TomorrowOrder` (after its definition, ~line 338):

```ts
/** The «Подготовка» feed for one farmer on one day: per-order rows (the source of
 *  truth for "готово") plus the day's counts. The product view is derived from
 *  `orders` on the frontend. */
export interface PrepSummary {
  date: string;
  confirmedOrders: number;
  pendingOrders: number;
  orders: TomorrowOrder[];
}
```

Add these two methods next to `prepOrders` in the service (place `prepSummary` directly above `prepOrders`, and `pendingCountForFarmer` directly below it):

```ts
  /** «Подготовка» feed for one farmer on one day. Orders are the source of truth
   *  for prep progress; the product view aggregates them client-side. `date`
   *  defaults to tomorrow (the main prep horizon). */
  async prepSummary(tenantId: string, farmerId: string, date?: string): Promise<PrepSummary> {
    const day = date ?? bgAddDays(bgToday(), 1);
    const [orders, pendingOrders] = await Promise.all([
      this.prepOrders(tenantId, farmerId, day),
      this.pendingCountForFarmer(tenantId, farmerId, day),
    ]);
    return { date: day, confirmedOrders: orders.length, pendingOrders, orders };
  }

  /** Pending (unconfirmed) orders on `day` that contain this farmer's items — they
   *  aren't in the prep feed yet, so the UI nudges the farmer to confirm them.
   *  Needs the deliverySlots leftJoin for scheduledForDay. */
  private async pendingCountForFarmer(
    tenantId: string,
    farmerId: string,
    day: string,
  ): Promise<number> {
    const [{ pending }] = await this.db
      .select({ pending: sql<number>`count(distinct ${orders.id})::int` })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.status, 'pending'),
          eq(products.farmerId, farmerId),
          scheduledForDay(day),
        )!,
      );
    return pending ?? 0;
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @fermeribg/api test orders.prep`
Expected: PASS (both new `prepSummary` cases; `prepOrders` + `setFulfillment` blocks still green).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/orders.service.ts server/src/modules/orders/orders.prep.spec.ts
git commit -m "feat(orders): add prepSummary (orders + farmer-scoped pending count)"
```

---

### Task 3: Backend — expose `GET /orders/prep`, retire `/production` + `/tomorrow`

**Files:**
- Modify: `server/src/modules/orders/orders.controller.ts` (production route ~58-63, tomorrow route ~109-116)
- Modify: `server/src/modules/orders/orders.service.ts` (delete `production()` ~1784-1851, `ProductionSummary`/`ProductionItem` ~401-417)
- Check/modify: `server/src/modules/orders/orders.controller.spec.ts`

**Interfaces:**
- Consumes: `prepSummary(tenantId, farmerId, date?)` from Task 2.
- Produces: `GET /orders/prep?date=&farmerId=` → `PrepSummary`.

- [ ] **Step 1: Add the `prep` route; delete the `production` and `tomorrow` routes**

In `orders.controller.ts`, delete the whole `@Get('production')` block and the whole `@Get('tomorrow')` block. Add this literal route (place it where `tomorrow` was, before the `:id` routes):

```ts
  // Literal route — declared before `:id`. «Подготовка» feed: one farmer's confirmed
  // orders for a day (default tomorrow) with fulfillment state + contact, plus the
  // day's pending count. Same scope rule as /mine — a producer is forced to its own
  // farmerId; an owner MUST pass ?farmerId. Not gated (every farmer preps).
  @Get('prep')
  @Roles('admin', 'farmer')
  @ApiQuery({ name: 'date', required: false })
  @ApiQuery({ name: 'farmerId', required: false, description: 'Owner-only: scope to one producer' })
  prep(
    @CurrentUser() user: TenantRequestUser,
    @Query('date') date?: string,
    @Query('farmerId') farmerId?: string,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, farmerId);
    if (!scope) throw new BadRequestException('farmerId required for admin');
    return this.ordersService.prepSummary(user.tenantId, scope, date);
  }
```

- [ ] **Step 2: Delete the dead service code**

In `orders.service.ts`, delete the `production()` method (the whole `async production(...)` through its closing `}`) and the now-unused `ProductionSummary` and `ProductionItem` interfaces.

- [ ] **Step 3: Fix any now-unused imports and the controller spec**

Run: `rg -n "production|tomorrow|ProductionSummary|ProductionItem|ActiveSubscriptionGuard|CurrentTenant" server/src/modules/orders/orders.controller.ts server/src/modules/orders/orders.controller.spec.ts`

- If `orders.controller.spec.ts` references the removed `production`/`tomorrow` handlers, delete or retarget those cases to `prep` (assert `prepSummary` is called with `(tenantId, scope, date)`).
- If `ActiveSubscriptionGuard` or `CurrentTenant` is now unused in the controller, remove the import.

- [ ] **Step 4: Build + test the orders module**

Run: `pnpm --filter @fermeribg/api build`
Expected: no TS errors (no dangling references to `production`/`tomorrowForFarmer`/`ProductionSummary`).

Run: `pnpm --filter @fermeribg/api test orders`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/orders.controller.ts server/src/modules/orders/orders.service.ts server/src/modules/orders/orders.controller.spec.ts
git commit -m "feat(orders): GET /orders/prep; retire /production + /tomorrow endpoints"
```

---

### Task 4: Client — `getPrep` + `PrepSummary`; remove `getProduction`

**Files:**
- Modify: `client/src/lib/api-client.ts` (`getProduction` ~685, `TomorrowOrder`/`getTomorrow` ~958-986)
- Modify: `client/src/lib/types.ts` (`ProductionItem`/`ProductionSummary` ~839-854)

**Interfaces:**
- Produces (client):
  ```ts
  interface PrepSummary { date: string; confirmedOrders: number; pendingOrders: number; orders: TomorrowOrder[]; }
  const getPrep: (date?: string, farmerId?: string) => Promise<PrepSummary>;
  ```

- [ ] **Step 1: Add `PrepSummary` + `getPrep` to api-client**

In `client/src/lib/api-client.ts`, directly after the `getTomorrow`/`setFulfillment` block (~line 986), add:

```ts
export interface PrepSummary {
  date: string;
  confirmedOrders: number;
  pendingOrders: number;
  orders: TomorrowOrder[];
}

export const getPrep = (date?: string, farmerId?: string) => {
  const qs = new URLSearchParams();
  if (date) qs.set('date', date);
  if (farmerId) qs.set('farmerId', farmerId);
  const q = qs.toString();
  return apiFetch<PrepSummary>(`orders/prep${q ? `?${q}` : ''}`);
};
```

- [ ] **Step 2: Remove the dead production client code**

- Delete `getProduction` (and its `ProductionSummary` import usage) from `api-client.ts` (~685-686). Remove `ProductionSummary` from that file's import from `./types` if present.
- Delete `ProductionItem` and `ProductionSummary` from `client/src/lib/types.ts` (~839-854).

- [ ] **Step 3: Verify nothing else imports the removed symbols**

Run: `rg -n "getProduction|ProductionSummary|ProductionItem" client/src`
Expected: only matches are in files this plan deletes next (`prep-list.tsx`, `production/page.tsx`). If anything else matches, stop and reassess.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/api-client.ts client/src/lib/types.ts
git commit -m "feat(web): add getPrep/PrepSummary; drop getProduction"
```

---

### Task 5: Client — `aggregateByProduct` pure helper (TDD)

**Files:**
- Create: `client/src/components/prep/aggregate.ts`
- Create: `client/src/components/prep/aggregate.test.ts`

**Interfaces:**
- Consumes: `TomorrowOrder` from `@/lib/api-client`.
- Produces:
  ```ts
  interface PrepProductRow { productName: string; totalQty: number; pickedQty: number; orderCount: number; }
  function aggregateByProduct(orders: TomorrowOrder[]): PrepProductRow[];
  ```

- [ ] **Step 1: Write the failing test**

Create `client/src/components/prep/aggregate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { aggregateByProduct } from './aggregate';
import type { TomorrowOrder } from '@/lib/api-client';

const mkOrder = (id: string, state: TomorrowOrder['fulfillmentState'], items: [string, number][]): TomorrowOrder => ({
  id, orderNumber: null, customerName: null, customerPhone: null, customerEmail: null,
  deliveryType: 'pickup', day: '2026-07-15', slotFrom: null, slotTo: null,
  fulfillmentState: state,
  items: items.map(([productName, quantity], i) => ({ productId: `${id}-${i}`, productName, quantity })),
});

describe('aggregateByProduct', () => {
  it('returns [] for no orders', () => {
    expect(aggregateByProduct([])).toEqual([]);
  });

  it('sums quantity per product and counts distinct orders', () => {
    const rows = aggregateByProduct([
      mkOrder('o1', 'pending', [['Домати', 3], ['Мед', 1]]),
      mkOrder('o2', 'pending', [['Домати', 2]]),
    ]);
    const tomatoes = rows.find((r) => r.productName === 'Домати')!;
    expect(tomatoes.totalQty).toBe(5);
    expect(tomatoes.orderCount).toBe(2);
    expect(tomatoes.pickedQty).toBe(0);
  });

  it('counts a product as picked only when its order is fulfilled', () => {
    const rows = aggregateByProduct([
      mkOrder('o1', 'fulfilled', [['Домати', 3]]),
      mkOrder('o2', 'pending', [['Домати', 2]]),
    ]);
    const tomatoes = rows.find((r) => r.productName === 'Домати')!;
    expect(tomatoes.totalQty).toBe(5);
    expect(tomatoes.pickedQty).toBe(3);
  });

  it('sorts by total quantity descending', () => {
    const rows = aggregateByProduct([mkOrder('o1', 'pending', [['Мед', 1], ['Домати', 9]])]);
    expect(rows.map((r) => r.productName)).toEqual(['Домати', 'Мед']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @fermeribg/web test aggregate`
Expected: FAIL — cannot resolve `./aggregate`.

- [ ] **Step 3: Implement the helper**

Create `client/src/components/prep/aggregate.ts`:

```ts
import type { TomorrowOrder } from '@/lib/api-client';

export interface PrepProductRow {
  productName: string;
  totalQty: number;
  pickedQty: number;
  orderCount: number;
}

/** Aggregate the order feed into per-product rows. Progress ("picked") is derived
 *  purely from each order's fulfillmentState, so it can never disagree with the
 *  order view — orders are the single source of truth. */
export function aggregateByProduct(orders: TomorrowOrder[]): PrepProductRow[] {
  const map = new Map<string, PrepProductRow & { orderIds: Set<string> }>();
  for (const o of orders) {
    const picked = o.fulfillmentState === 'fulfilled';
    for (const it of o.items) {
      let row = map.get(it.productName);
      if (!row) {
        row = { productName: it.productName, totalQty: 0, pickedQty: 0, orderCount: 0, orderIds: new Set() };
        map.set(it.productName, row);
      }
      row.totalQty += it.quantity;
      if (picked) row.pickedQty += it.quantity;
      row.orderIds.add(o.id);
    }
  }
  return [...map.values()]
    .map(({ orderIds, ...r }) => ({ ...r, orderCount: orderIds.size }))
    .sort((a, b) => b.totalQty - a.totalQty || a.productName.localeCompare(b.productName, 'bg'));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @fermeribg/web test aggregate`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/prep/aggregate.ts client/src/components/prep/aggregate.test.ts
git commit -m "feat(web): aggregateByProduct helper for prep product view"
```

---

### Task 6: Client — `PrepClient` merged component (both views)

**Files:**
- Create: `client/src/components/prep/prep-client.tsx`

**Interfaces:**
- Consumes: `getPrep`, `setFulfillment`, `PrepSummary`, `TomorrowOrder`, `FulfillmentState` from `@/lib/api-client`; `aggregateByProduct` from `./aggregate`; `DateNavBar` from `@/components/production/date-nav-bar`; `relDayLabel`, `shiftIsoDate`, `todayIso`, `cn`, `hhmm` from `@/lib/utils`.
- Produces: `export function PrepClient(props): JSX.Element`.

- [ ] **Step 1: Verify the util imports exist**

Run: `rg -n "export (function|const) (relDayLabel|shiftIsoDate|todayIso|hhmm)\b" client/src/lib/utils.ts`
Expected: all four present. (`relDayLabel` is already used by `handover/protocols-client.tsx`; `shiftIsoDate`/`todayIso` by `date-nav-bar.tsx`; `hhmm` by `tomorrow-client.tsx`.) If `relDayLabel` is missing, use `bgDateLabel(new Date(\`${date}T00:00:00\`)).replace(' г.','')` as the label instead.

- [ ] **Step 2: Create the component**

Create `client/src/components/prep/prep-client.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Phone, Mail, Check, Loader2, AlertTriangle, PackageCheck, ShoppingBasket, Clock,
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { cn, hhmm, relDayLabel, shiftIsoDate, todayIso } from '@/lib/utils';
import {
  ApiError, getPrep, setFulfillment,
  type PrepSummary, type TomorrowOrder, type FulfillmentState,
} from '@/lib/api-client';
import { DateNavBar } from '@/components/production/date-nav-bar';
import { aggregateByProduct } from './aggregate';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const plural = (n: number) => (n === 1 ? 'бройка' : 'бройки');

const STATE_LABEL: Record<FulfillmentState, string> = {
  pending: 'Чака', in_production: 'В процес', fulfilled: 'Готово',
};
const STATE_CLS: Record<FulfillmentState, string> = {
  pending: 'bg-ff-amber-softer text-ff-amber-600',
  in_production: 'bg-ff-surface-2 text-ff-muted',
  fulfilled: 'bg-ff-green-100 text-ff-green-800',
};
const DELIVERY_LABEL: Record<string, string> = {
  pickup: 'На място', address: 'Доставка', econt: 'Еконт офис',
  econt_address: 'Еконт до адрес', courier: 'Куриер',
};

function deliveryMeta(o: TomorrowOrder): string {
  const dt = DELIVERY_LABEL[o.deliveryType] ?? o.deliveryType;
  if (o.slotFrom) {
    const win = o.slotTo ? `${hhmm(o.slotFrom)}–${hhmm(o.slotTo)}` : hhmm(o.slotFrom);
    return `${dt} · ${win}`;
  }
  return dt;
}

function Contact({ o }: { o: TomorrowOrder }) {
  if (!o.customerPhone && !o.customerEmail) return <span className="text-[12.5px] text-ff-muted-2">—</span>;
  return (
    <div className="flex flex-col gap-0.5 text-[12.5px]">
      {o.customerPhone && (
        <a href={`tel:${o.customerPhone}`} className="inline-flex items-center gap-1.5 font-semibold text-ff-ink-2 hover:text-ff-green-700">
          <Phone size={12.5} className="shrink-0 text-ff-muted" />{o.customerPhone}
        </a>
      )}
      {o.customerEmail && (
        <a href={`mailto:${o.customerEmail}`} className="inline-flex items-center gap-1.5 text-ff-muted hover:text-ff-green-700">
          <Mail size={12.5} className="shrink-0" />{o.customerEmail}
        </a>
      )}
    </div>
  );
}

/**
 * «Подготовка» — merged Производство + Утре. One day, two axes:
 *  - По поръчка: per-order cards, customer contact, self-tracked prep state
 *    (server-side) — the ONLY place "готово" is set.
 *  - По продукт: read-only harvest totals aggregated from the same orders;
 *    progress is derived from fulfilled orders (never disagrees).
 */
export function PrepClient({
  initial,
  initialDate,
  role,
  farmers = [],
  multiFarmer = false,
  defaultFarmerId = '',
}: {
  initial: PrepSummary;
  initialDate: string;
  role?: 'admin' | 'farmer';
  farmers?: { id: string; name: string }[];
  multiFarmer?: boolean;
  defaultFarmerId?: string;
}) {
  const showPicker = role === 'admin' && multiFarmer && farmers.length > 1;
  const [farmerId, setFarmerId] = useState(defaultFarmerId);
  const [date, setDate] = useState(initialDate || shiftIsoDate(todayIso(), 1));
  const [orders, setOrders] = useState<TomorrowOrder[]>(initial.orders);
  const [pendingOrders, setPendingOrders] = useState(initial.pendingOrders);
  const [view, setView] = useState<'orders' | 'products'>('orders');
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const firstRun = useRef(true);

  // Refetch whenever the day or the selected farmer changes (skip the SSR-provided
  // first render). Mirrors TomorrowClient's client refetch.
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    if (role === 'admin' && !farmerId) return;
    let live = true;
    setLoading(true);
    getPrep(date, role === 'admin' ? farmerId : undefined)
      .then((s) => { if (live) { setOrders(s.orders); setPendingOrders(s.pendingOrders); } })
      .catch((e) => { if (live) toast.error(errMsg(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [date, farmerId, role]);

  const onMark = useCallback(
    async (id: string, state: FulfillmentState) => {
      setBusyId(id);
      try {
        await setFulfillment(id, state, role === 'admin' ? farmerId : undefined);
        setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, fulfillmentState: state } : o)));
        toast.success(state === 'fulfilled' ? 'Отбелязано като готово.' : 'Отбелязано като в процес.');
      } catch (e) {
        toast.error(errMsg(e));
      } finally {
        setBusyId(null);
      }
    },
    [farmerId, role],
  );

  const productRows = aggregateByProduct(orders);
  const totalQty = productRows.reduce((s, r) => s + r.totalQty, 0);
  const pickedQty = productRows.reduce((s, r) => s + r.pickedQty, 0);
  const allDone = totalQty > 0 && pickedQty === totalQty;
  const gaps = orders.filter((o) => o.fulfillmentState !== 'fulfilled');

  return (
    <div className="animate-ff-fade-up">
      {/* header */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Подготовка</h1>
          <p className="text-[13.5px] text-ff-muted">Какво да приготвиш за деня — по поръчка или по продукт.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {showPicker && (
            <label className="inline-flex items-center gap-2 text-[13px] font-bold text-ff-ink-2">
              Фермер:
              <select
                value={farmerId}
                onChange={(e) => setFarmerId(e.target.value)}
                className="h-10 rounded-xl border border-ff-border bg-ff-surface px-2.5 text-[13px] font-semibold text-ff-ink-2 shadow-ff-sm outline-none focus:border-ff-green-500"
              >
                {farmers.map((f) => (<option key={f.id} value={f.id}>{f.name}</option>))}
              </select>
            </label>
          )}
          <DateNavBar date={date} dateLabel={relDayLabel(date)} onSelect={setDate} />
        </div>
      </div>

      {/* pending-confirm nudge */}
      {pendingOrders > 0 && (
        <Link
          href="/orders"
          className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-3.5 py-2.5 transition hover:brightness-[0.98]"
        >
          <AlertTriangle size={16} className="shrink-0 text-ff-amber-600" />
          <span className="text-[12.5px] font-bold text-ff-amber-600">
            {pendingOrders === 1
              ? '1 поръчка чака потвърждение — не е в списъка. Потвърди я.'
              : `${pendingOrders} поръчки чакат потвърждение — не са в списъка. Потвърди ги.`}
          </span>
          <span className="ml-auto whitespace-nowrap text-[12.5px] font-extrabold text-ff-amber-600 underline">Към поръчките →</span>
        </Link>
      )}

      {/* view toggle + progress */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-xl border border-ff-border bg-ff-surface p-1 shadow-ff-sm" role="tablist">
          {([['orders', 'По поръчка'], ['products', 'По продукт']] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              onClick={() => setView(key)}
              className={cn(
                'rounded-lg px-3.5 py-1.5 text-[13px] font-extrabold transition-colors',
                view === key ? 'bg-ff-green-600 text-white' : 'text-ff-ink-2 hover:bg-ff-surface-2',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <span className={cn('text-[13px] font-bold', allDone ? 'text-ff-green-700' : 'text-ff-muted')}>
          {pickedQty}/{totalQty} {plural(totalQty)} готови
        </span>
      </div>

      {loading && (
        <p className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] text-ff-muted">
          <Loader2 size={14} className="animate-spin" /> Зареждане…
        </p>
      )}

      {orders.length === 0 ? (
        <div className="rounded-xl border border-ff-border bg-ff-surface px-5 py-12 text-center text-[13.5px] text-ff-muted shadow-ff-sm">
          <PackageCheck size={28} className="mx-auto mb-2 text-ff-muted-2" />
          Няма потвърдени поръчки за този ден.
        </div>
      ) : view === 'orders' ? (
        <OrdersView orders={orders} gaps={gaps} busyId={busyId} onMark={onMark} />
      ) : (
        <ProductsView rows={productRows} pickedQty={pickedQty} totalQty={totalQty} allDone={allDone} />
      )}
    </div>
  );
}

function OrdersView({
  orders, gaps, busyId, onMark,
}: {
  orders: TomorrowOrder[];
  gaps: TomorrowOrder[];
  busyId: string | null;
  onMark: (id: string, state: FulfillmentState) => void;
}) {
  return (
    <>
      {gaps.length > 0 && (
        <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-4 py-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-ff-amber-600" />
          <div className="text-[13px] leading-[1.5] text-ff-ink-2">
            <b className="text-ff-amber-600">{gaps.length}</b>{' '}
            {gaps.length === 1 ? 'поръчка още чака' : 'поръчки още чакат'} — ако не смогнеш, обади се на клиента
            (номерата са до всяка поръчка).
          </div>
        </div>
      )}
      <ul className="flex flex-col gap-3">
        {orders.map((o) => (
          <li key={o.id} className="rounded-[12px] border border-ff-border bg-ff-surface p-4 shadow-ff-sm">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-extrabold text-ff-ink">№{o.orderNumber ?? '—'}</span>
                <span className="text-[12.5px] text-ff-muted">{deliveryMeta(o)}</span>
              </div>
              <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', STATE_CLS[o.fulfillmentState])}>
                {STATE_LABEL[o.fulfillmentState]}
              </span>
            </div>
            <div className="mb-2 text-[13.5px] font-bold text-ff-ink-2">{o.customerName ?? '—'}</div>
            <Contact o={o} />
            <ul className="my-2.5 flex flex-col gap-0.5 text-[12.5px] text-ff-muted">
              {o.items.map((it) => (<li key={it.productId}>{it.productName} × {it.quantity}</li>))}
            </ul>
            {o.fulfillmentState !== 'fulfilled' && (
              <div className="flex flex-wrap gap-1.5">
                {o.fulfillmentState === 'pending' && (
                  <button
                    type="button"
                    onClick={() => onMark(o.id, 'in_production')}
                    disabled={busyId === o.id}
                    className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-ff-border bg-ff-surface-2 px-2.5 py-1 text-[11px] font-extrabold text-ff-ink-2 hover:bg-ff-border-2 disabled:opacity-60"
                  >
                    {busyId === o.id ? <Loader2 size={12} className="animate-spin" /> : null}
                    Започвам
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onMark(o.id, 'fulfilled')}
                  disabled={busyId === o.id}
                  className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-ff-green-100 bg-ff-green-50 px-2.5 py-1 text-[11px] font-extrabold text-ff-green-700 hover:bg-ff-green-100 disabled:opacity-60"
                >
                  {busyId === o.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  Готово
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function ProductsView({
  rows, pickedQty, totalQty, allDone,
}: {
  rows: ReturnType<typeof aggregateByProduct>;
  pickedQty: number;
  totalQty: number;
  allDone: boolean;
}) {
  return (
    <div className="grid grid-cols-[1fr_300px] items-start gap-4 max-[900px]:grid-cols-1">
      <div className="overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        <div className="flex items-center justify-between border-b border-ff-border-2 px-[22px] pb-[15px] pt-[18px]">
          <h2 className="text-[17px] font-extrabold">За приготвяне</h2>
          <span className={cn('text-[13px] font-bold', allDone ? 'text-ff-green-700' : 'text-ff-muted')}>
            {pickedQty}/{totalQty} набрани
          </span>
        </div>
        {rows.map((r, i) => {
          const isDone = r.totalQty > 0 && r.pickedQty === r.totalQty;
          return (
            <div
              key={r.productName}
              className={cn(
                'grid w-full grid-cols-[1fr_auto] items-center gap-[18px] px-[22px] py-5 text-left',
                i < rows.length - 1 && 'border-b border-ff-border-2',
              )}
            >
              <div className="min-w-0">
                <div className={cn('text-[18px] font-extrabold tracking-[-0.01em]', isDone ? 'text-ff-muted' : 'text-ff-ink')}>
                  {r.productName}
                </div>
                <div className="mt-0.5 text-[13px] text-ff-muted">
                  от {r.orderCount} {r.orderCount === 1 ? 'поръчка' : 'поръчки'}
                  {r.pickedQty > 0 && !isDone && <span className="text-ff-green-700"> · {r.pickedQty} набрани</span>}
                  {isDone && <span className="text-ff-green-700"> · готово</span>}
                </div>
              </div>
              <div className="flex shrink-0 items-baseline gap-1.5">
                <span className={cn('ff-fig text-[34px] font-extrabold leading-none tracking-[-0.03em]', isDone ? 'text-ff-muted-2' : 'text-ff-green-700')}>
                  {r.totalQty}
                </span>
                <span className="text-[15px] font-bold text-ff-muted">бр</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="sticky top-0 flex flex-col gap-4 max-[900px]:static">
        <div className="rounded-xl border border-ff-border border-t-[3px] border-t-ff-green-600 bg-ff-surface p-5 shadow-ff-sm">
          <div className="mb-3 text-[13.5px] font-bold text-ff-muted">Напредък</div>
          <div className="flex items-baseline gap-2">
            <span className="ff-fig text-[40px] font-extrabold tracking-[-0.03em] text-ff-ink">{pickedQty}</span>
            <span className="text-[18px] font-bold text-ff-muted-2">/ {totalQty}</span>
          </div>
          <div className="mt-3.5 h-[9px] overflow-hidden rounded-full bg-ff-border-2">
            <div
              className={cn('h-full rounded-full transition-[width] duration-300', allDone ? 'bg-ff-green-600' : 'bg-ff-green-500')}
              style={{ width: `${totalQty ? (pickedQty / totalQty) * 100 : 0}%` }}
            />
          </div>
          <div className={cn('mt-3 text-[13px] font-semibold leading-[1.4]', allDone ? 'text-ff-green-700' : 'text-ff-muted')}>
            {allDone ? 'Всичко е приготвено — готов за доставка! 🌿' : `Остават ${totalQty - pickedQty} от ${totalQty} ${plural(totalQty)}.`}
          </div>
        </div>
        <div className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
          <div className="flex items-start gap-[11px]">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-ff-amber-softer text-ff-amber-600">
              <Clock size={19} />
            </span>
            <div>
              <div className="text-[14px] font-extrabold">Преди бране</div>
              <div className="mt-0.5 text-[13px] leading-[1.5] text-ff-ink-2">
                Отмятай поръчките в „По поръчка" — тук виждаш общо колко да набереш от всеки продукт.
              </div>
            </div>
          </div>
        </div>
        {rows.length === 0 && (
          <div className="rounded-xl border border-ff-border bg-ff-surface p-5 text-center text-ff-muted shadow-ff-sm">
            <ShoppingBasket size={24} className="mx-auto mb-2 text-ff-muted-2" />
            <div className="text-[13.5px]">Няма продукти за приготвяне.</div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck the component**

Run: `pnpm --filter @fermeribg/web build`
Expected: compiles (the `/prep` page in Task 7 will consume it; a standalone build here still typechecks the file). If `relDayLabel` was missing per Step 1, swap in the `bgDateLabel(...)` fallback.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/prep/prep-client.tsx
git commit -m "feat(web): PrepClient — merged По поръчка / По продукт views"
```

---

### Task 7: Client — `/prep` page, redirects, sidebar, delete old screens

**Files:**
- Create: `client/src/app/(admin)/prep/page.tsx`
- Modify: `client/src/app/(admin)/tomorrow/page.tsx` (→ redirect)
- Modify: `client/src/app/(admin)/production/page.tsx` (→ redirect)
- Delete: `client/src/components/tomorrow/tomorrow-client.tsx`, `client/src/components/production/prep-list.tsx`
- Modify: `client/src/components/layout/sidebar.tsx`

**Interfaces:**
- Consumes: `PrepClient` (Task 6), `PrepSummary` (Task 4).

- [ ] **Step 1: Create the server page**

Create `client/src/app/(admin)/prep/page.tsx`:

```tsx
import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { PrepClient } from '@/components/prep/prep-client';
import type { PrepSummary } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

async function getJson<T>(path: string, fallback: T): Promise<T> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return fallback;
  const res = await fetch(`${API_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  }).catch(() => null);
  if (!res || !res.ok) return fallback;
  return res.json();
}

// «Подготовка» — merged Производство + Утре. One farmer, one day (default tomorrow),
// two axes. Scope rule mirrors /tomorrow: single-farmer shop auto-scopes; multi-farmer
// owner defaults to the first producer and can switch client-side.
export default async function PrepPage(props: { searchParams: Promise<{ date?: string }> }) {
  const searchParams = await props.searchParams;
  const date = searchParams.date;

  const [account, profile] = await Promise.all([
    getJson<{ role?: string }>('auth/me', {}),
    getJson<{ multiFarmer?: boolean }>('tenants/me', {}),
  ]);
  const role = account.role === 'farmer' ? 'farmer' : 'admin';
  const multiFarmer = profile.multiFarmer === true;

  const farmers = role === 'admin' ? await getJson<{ id: string; name: string }[]>('farmers', []) : [];
  const defaultFarmerId = role === 'admin' ? (farmers[0]?.id ?? '') : '';

  const empty: PrepSummary = { date: date ?? '', confirmedOrders: 0, pendingOrders: 0, orders: [] };
  const canFetch = role === 'farmer' || defaultFarmerId !== '';
  const qs = new URLSearchParams();
  if (date) qs.set('date', date);
  if (defaultFarmerId) qs.set('farmerId', defaultFarmerId);
  const q = qs.toString();
  const initial = canFetch
    ? await getJson<PrepSummary>(`orders/prep${q ? `?${q}` : ''}`, empty)
    : empty;

  return (
    <div className="max-w-[1100px]">
      <PrepClient
        initial={initial}
        initialDate={initial.date}
        role={role}
        farmers={farmers}
        multiFarmer={multiFarmer}
        defaultFarmerId={defaultFarmerId}
      />
    </div>
  );
}
```

- [ ] **Step 2: Replace the two old pages with redirects**

Overwrite `client/src/app/(admin)/tomorrow/page.tsx`:

```tsx
import { redirect } from 'next/navigation';

// Merged into «Подготовка» (/prep). Keep the route as a redirect for bookmarks.
export default function TomorrowRedirect() {
  redirect('/prep');
}
```

Overwrite `client/src/app/(admin)/production/page.tsx`:

```tsx
import { redirect } from 'next/navigation';

// Merged into «Подготовка» (/prep). Preserve any ?date deep link.
export default async function ProductionRedirect(props: { searchParams: Promise<{ date?: string }> }) {
  const { date } = await props.searchParams;
  redirect(date ? `/prep?date=${date}` : '/prep');
}
```

- [ ] **Step 3: Delete the ported-away components**

```bash
git rm client/src/components/tomorrow/tomorrow-client.tsx client/src/components/production/prep-list.tsx
```

(Keep `client/src/components/production/date-nav-bar.tsx` — it is shared by `handover/protocols-client.tsx` and `orders/orders-client.tsx`.)

- [ ] **Step 4: Swap the sidebar entries**

In `client/src/components/layout/sidebar.tsx`, in `NAV_GROUPS` → "Продажби" `items`, replace the two lines:

```ts
      { href: '/production', label: 'Производство', Icon: ShoppingBasket, gated: true, desc: 'Дневен списък какво да приготвиш за доставките.' },
      { href: '/tomorrow', label: 'Утре', Icon: CalendarCheck, desc: 'Поръчките за утре и кого да потърсиш, ако изостанеш.' },
```

with one line (placed right after the `/orders` item):

```ts
      { href: '/prep', label: 'Подготовка', Icon: CalendarCheck, desc: 'Какво да приготвиш за деня — по поръчка или по продукт.' },
```

In `FARMER_NAV`, replace the `/tomorrow` line:

```ts
  { href: '/tomorrow', label: 'Утре', Icon: CalendarCheck, desc: 'Поръчките за утре — отбелязвай ги, докато ги приготвяш.' },
```

with:

```ts
  { href: '/prep', label: 'Подготовка', Icon: CalendarCheck, desc: 'Какво да приготвиш за деня — по поръчка или по продукт.' },
```

- [ ] **Step 5: Drop the now-unused `ShoppingBasket` import if lint flags it**

Run: `rg -n "ShoppingBasket" client/src/components/layout/sidebar.tsx`
If the only remaining match is the `import { ... ShoppingBasket ... }` line, remove `ShoppingBasket` from that import.

- [ ] **Step 6: Build the client**

Run: `pnpm --filter @fermeribg/web build`
Expected: compiles, no dangling imports of `TomorrowClient` / `PrepList` / `getProduction`.

- [ ] **Step 7: Commit**

```bash
git add client/src/app/\(admin\)/prep/page.tsx client/src/app/\(admin\)/tomorrow/page.tsx client/src/app/\(admin\)/production/page.tsx client/src/components/layout/sidebar.tsx
git commit -m "feat(web): /prep page (Подготовка); redirect /tomorrow + /production; sidebar swap"
```

---

### Task 8: Manual verification in the preview

**Files:** none (verification only).

- [ ] **Step 1: Start the client dev server**

Use the preview tooling (`preview_start` with the web app's launch config, or `pnpm --filter @fermeribg/web dev`). Log in as an operator.

- [ ] **Step 2: Walk the acceptance checklist**

- Sidebar shows one **Подготовка** entry; **Производство** and **Утре** are gone.
- `/prep` opens on **утре** (date-nav label reads "Утре"), default view **По поръчка**.
- Tick an order **Готово** → toast; switch to **По продукт** → that order's products show набрани and the progress bar moves (no refetch, same state).
- Date-nav to **днес** and to another day → the feed refetches for that day.
- Multi-farmer shop: the farmer picker switches the feed; single-farmer shop: no picker.
- If there are pending orders on the day, the "потвърди ги" nudge shows and links to `/orders`.
- Visit `/tomorrow` → redirects to `/prep`; visit `/production?date=2026-07-20` → redirects to `/prep?date=2026-07-20`.
- Check 375px width (this panel is used on phones): header, toggle, and both views are usable.

- [ ] **Step 3: Confirm no console/network errors**

Use `read_console_messages` + `read_network_requests` — `GET /orders/prep` returns 200 with `{ date, confirmedOrders, pendingOrders, orders }`; `PATCH /orders/:id/fulfillment` returns 200 on tick.

---

## Self-review (completed during authoring)

- **Spec coverage:** merge concept (Tasks 6-7), orders-as-truth + derived product progress (Task 5 helper + Task 6 ProductsView using `pickedQty`), read-only product view (no ticking in ProductsView), date-nav default tomorrow (Task 6 `useState` fallback + backend default in Tasks 1-2), name "Подготовка" (Tasks 6-7), per-farmer scoping (Tasks 1-3 + picker in Task 6), backend `GET /orders/prep` + drop `/production`+`/tomorrow` (Tasks 1-3), redirects + sidebar (Task 7), tests (Tasks 1,2,5), manual verify (Task 8). No gaps.
- **Placeholder scan:** no TBD/TODO; every code step shows full code.
- **Type consistency:** `prepOrders`/`prepSummary`/`PrepSummary`/`getPrep`/`aggregateByProduct`/`PrepProductRow` are named identically across producer and consumer tasks. `PrepSummary` shape `{ date, confirmedOrders, pendingOrders, orders }` matches between backend (Task 2) and client (Task 4) and the page/component (Tasks 6-7).
