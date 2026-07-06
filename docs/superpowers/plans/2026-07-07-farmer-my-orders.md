# Farmer "Моите поръчки" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a producer sub-account (`role='farmer'`) a fulfillment screen, `/my-orders`, that shows every order containing their own products across ALL statuses (including pending/cancelled, which `/payments` deliberately excludes), with per-item detail and a shared-order badge that replaces a silent 403.

**Architecture:** New keyset-paginated service method `ordersForFarmer` (sibling of the existing `paymentsForFarmer`) backing a new literal route `GET /orders/mine`. A new `MyOrdersClient` React component renders per-order cards and reuses the existing `PATCH /orders/:id/status` and `PATCH /orders/:id/cod-outcome` mutations unchanged (both already carry `@Roles('admin','farmer')` and IDOR-gate to fully-own orders).

**Tech Stack:** NestJS + Drizzle ORM (server), Next.js App Router + React (client), Jest (tests). Existing keyset pagination helpers in `server/src/common/pagination/keyset.ts` and `cursor.ts`.

## Global Constraints

- No new DB migration — every column needed (`orders.farmer_id`... actually: `order_items` → `products.farmer_id` join, exactly as `paymentsForFarmer` already does) already exists.
- No new mutation endpoints — `PATCH /orders/:id/status` and `PATCH /orders/:id/cod-outcome` are reused as-is.
- `MyOrdersQueryDto`'s `status` filter must allow all 6 real order statuses (`pending, confirmed, preparing, out_for_delivery, delivered, cancelled`) — do NOT copy `OrdersQueryDto`'s enum, which only lists 4 and is missing `preparing`/`out_for_delivery` (a pre-existing bug in that DTO, out of scope to fix here).
- Route `/orders/mine` must be declared before `@Get(':id')` in the controller (Nest matches routes in declaration order; a literal segment after a `:id` param route would be swallowed as an order id) — follow the existing precedent set by `production`, `confirm-pending`, and `payments`.
- Follow the codebase's existing per-file component style: small presentational sub-components (buttons, contact chips) stay unexported and local to the client file they're used in — this mirrors `payments-client.tsx`'s `CollectButton`/`RefuseButton`/`Contact`, which are not exported and are not meant to be imported cross-file.

---

### Task 1: Types + pure mapping function (`toFarmerOrder`)

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts` (add interfaces + pure function near `PaymentRow`/`toPaymentOrder`, i.e. after line 194)
- Test: `server/src/modules/orders/orders.mine.spec.ts` (new)

**Interfaces:**
- Produces: `FarmerOrderItem { productId: string; productName: string; quantity: number; priceStotinki: number }`, `FarmerOrderRow` (raw DB row shape, one per order+farmer with a nested items array already assembled), `FarmerOrder` (API shape), `FarmerOrdersPage { orders: FarmerOrder[]; nextCursor: string | null }`, and pure function `toFarmerOrder(row: FarmerOrderRow): FarmerOrder`.

This task defines the shapes and the pure, DB-free mapping function first (TDD), exactly mirroring how `toPaymentOrder` is tested in `orders.payments.spec.ts` without touching the database.

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/orders/orders.mine.spec.ts`:

```typescript
import { toFarmerOrder, type FarmerOrderRow } from './orders.service';

const row = (over: Partial<FarmerOrderRow>): FarmerOrderRow => ({
  day: '2026-07-07',
  id: 'o1',
  orderNumber: 5,
  customerName: 'Мария',
  customerPhone: '0888111222',
  customerEmail: 'maria@example.com',
  status: 'pending',
  deliveryType: 'address',
  paymentMethod: 'cod',
  createdAt: '2026-07-07T08:00:00.000Z',
  slotFrom: null,
  slotTo: null,
  codOutcome: null,
  codOutcomeReason: null,
  shared: false,
  items: [{ productId: 'p1', productName: 'Домати', quantity: 3, priceStotinki: 250 }],
  ...over,
});

describe('toFarmerOrder', () => {
  it('sums the farmer\'s own item lines into subtotalStotinki', () => {
    const o = toFarmerOrder(
      row({
        items: [
          { productId: 'p1', productName: 'Домати', quantity: 3, priceStotinki: 250 },
          { productId: 'p2', productName: 'Краставици', quantity: 2, priceStotinki: 150 },
        ],
      }),
    );
    expect(o.subtotalStotinki).toBe(3 * 250 + 2 * 150);
    expect(o.items).toHaveLength(2);
  });

  it('passes through shared flag, status, and contact fields', () => {
    const o = toFarmerOrder(row({ shared: true, status: 'cancelled', customerPhone: '+359888999000' }));
    expect(o.shared).toBe(true);
    expect(o.status).toBe('cancelled');
    expect(o.customerPhone).toBe('+359888999000');
  });

  it('serialises createdAt Date to ISO and tolerates null', () => {
    const a = toFarmerOrder(row({ createdAt: new Date('2026-07-07T06:30:00.000Z') }));
    expect(a.createdAt).toBe('2026-07-07T06:30:00.000Z');
    const b = toFarmerOrder(row({ createdAt: null }));
    expect(b.createdAt).toBeNull();
  });

  it('passes codOutcome + reason through unchanged', () => {
    const o = toFarmerOrder(row({ codOutcome: 'refused', codOutcomeReason: 'не вдигна' }));
    expect(o.codOutcome).toBe('refused');
    expect(o.codOutcomeReason).toBe('не вдигна');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest orders.mine.spec.ts`
Expected: FAIL — `toFarmerOrder` / `FarmerOrderRow` not exported from `./orders.service`.

- [ ] **Step 3: Write minimal implementation**

In `server/src/modules/orders/orders.service.ts`, immediately after the existing `toPaymentOrder` function (after line 194, i.e. right after the `toIso` helper block), add:

```typescript
/** One of the farmer's own product lines on an order. */
export interface FarmerOrderItem {
  productId: string;
  productName: string;
  quantity: number;
  priceStotinki: number;
}

/** Raw shape assembled for one order on the «Моите поръчки» screen, before
 *  mapping to the API shape. `items` holds only THIS farmer's own lines —
 *  a co-producer's lines never appear here, only the `shared` flag notes
 *  that the order also has them. */
export interface FarmerOrderRow {
  day: string;
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  status: string;
  deliveryType: string;
  paymentMethod: PaymentChannel;
  createdAt: Date | string | null;
  slotFrom: string | null;
  slotTo: string | null;
  codOutcome: 'received' | 'refused' | null;
  codOutcomeReason: string | null;
  /** True when the order also contains another producer's items — mutation
   *  actions are disabled client-side (and would 403 server-side via the
   *  same ownership gate as updateStatusForFarmer). */
  shared: boolean;
  items: FarmerOrderItem[];
}

/** One order on the «Моите поръчки» screen — every status, unlike Плащания. */
export interface FarmerOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  status: string;
  deliveryType: string;
  paymentMethod: PaymentChannel;
  day: string;
  createdAt: string | null;
  slotFrom: string | null;
  slotTo: string | null;
  codOutcome: 'received' | 'refused' | null;
  codOutcomeReason: string | null;
  shared: boolean;
  /** This farmer's own subtotal on the order (their items only). */
  subtotalStotinki: number;
  items: FarmerOrderItem[];
}

export interface FarmerOrdersPage {
  orders: FarmerOrder[];
  nextCursor: string | null;
}

/** Map one assembled row to the API shape. Pure (no DB) so it's unit-testable,
 *  mirroring {@link toPaymentOrder}. */
export function toFarmerOrder(r: FarmerOrderRow): FarmerOrder {
  return {
    id: r.id,
    orderNumber: r.orderNumber,
    customerName: r.customerName,
    customerPhone: r.customerPhone,
    customerEmail: r.customerEmail,
    status: r.status,
    deliveryType: r.deliveryType,
    paymentMethod: r.paymentMethod,
    day: r.day,
    createdAt: toIso(r.createdAt),
    slotFrom: r.slotFrom,
    slotTo: r.slotTo,
    codOutcome: r.codOutcome,
    codOutcomeReason: r.codOutcomeReason,
    shared: r.shared,
    subtotalStotinki: r.items.reduce((sum, it) => sum + it.quantity * it.priceStotinki, 0),
    items: r.items,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest orders.mine.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/orders.service.ts server/src/modules/orders/orders.mine.spec.ts
git commit -m "feat(orders): add FarmerOrder types + pure toFarmerOrder mapper"
```

---

### Task 2: `MyOrdersQueryDto`

**Files:**
- Create: `server/src/modules/orders/dto/my-orders-query.dto.ts`
- Test: `server/src/modules/orders/dto/my-orders-query.dto.spec.ts`

**Interfaces:**
- Consumes: `PaginationQueryDto` (from `server/src/common/pagination/pagination-query.dto.ts`) — provides `cursor?: string`, `limit?: number`.
- Produces: `MyOrdersQueryDto` with fields `status?`, `q?`, `farmerId?`, plus inherited `cursor?`, `limit?`.

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/orders/dto/my-orders-query.dto.spec.ts`:

```typescript
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MyOrdersQueryDto } from './my-orders-query.dto';

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(MyOrdersQueryDto, input);
  return validate(dto);
}

describe('MyOrdersQueryDto', () => {
  it('accepts every real order status', async () => {
    for (const status of ['pending', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled']) {
      const errors = await validateDto({ status });
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects an unknown status', async () => {
    const errors = await validateDto({ status: 'bogus' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts an optional farmerId as a UUID', async () => {
    const errors = await validateDto({ farmerId: '9c6c6b0e-0000-4000-8000-000000000000' });
    expect(errors).toHaveLength(0);
  });

  it('rejects a non-UUID farmerId', async () => {
    const errors = await validateDto({ farmerId: 'not-a-uuid' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('allows omitting every field', async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest my-orders-query.dto.spec.ts`
Expected: FAIL — cannot find module `./my-orders-query.dto`.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/modules/orders/dto/my-orders-query.dto.ts`:

```typescript
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';

/** Query params for GET /orders/mine — keyset page + status filter + search.
 *  Unlike PaymentsQueryDto's implicit «counted statuses only» scope, this
 *  screen shows every status, so it needs the full enum (not the 4-value
 *  enum on OrdersQueryDto, which is missing 'preparing'/'out_for_delivery'). */
export class MyOrdersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['pending', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'])
  status?: 'pending' | 'confirmed' | 'preparing' | 'out_for_delivery' | 'delivered' | 'cancelled';

  /** Free-text search over customer name / phone / email / order number. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** Owner-only: scope the list to one producer. Ignored for a producer token
   *  (a producer is always forced to its own farmerId server-side). */
  @IsOptional()
  @IsUUID()
  farmerId?: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest my-orders-query.dto.spec.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/dto/my-orders-query.dto.ts server/src/modules/orders/dto/my-orders-query.dto.spec.ts
git commit -m "feat(orders): add MyOrdersQueryDto with the full 6-status enum"
```

---

### Task 3: `ordersForFarmer` service method

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts` (add method after `paymentsForFarmer`, i.e. after its closing brace around line 671)
- Test: `server/src/modules/orders/orders.mine.spec.ts` (extend from Task 1)

**Interfaces:**
- Consumes: `toFarmerOrder` (Task 1), `FarmerOrdersPage`/`FarmerOrderRow` (Task 1), `clampLimit`/`decodeCursor`/`buildKeysetPage`/`cursorTs`/`KEYSET_TS` (existing pagination helpers, already imported in this file), `this.paymentSearchCond` (existing private method), `bgDate` (existing import).
- Produces: `OrdersService.ordersForFarmer(tenantId: string, farmerId: string, opts: { status?: 'pending' | 'confirmed' | 'preparing' | 'out_for_delivery' | 'delivered' | 'cancelled'; q?: string; cursor?: string; limit?: number }): Promise<FarmerOrdersPage>`. The `status` union must match `orders.status`'s pgEnum literal type exactly (same 6 values as `MyOrdersQueryDto` from Task 2) — a plain `string` type here would fail `eq(orders.status, opts.status)` against the enum-typed column.

This method has two query phases per page: (1) fetch the page of matching order ids + order-level fields via a `GROUP BY orders.id`, `EXISTS`-based `shared` flag, and keyset cursor — same shape as `paymentsForFarmer` but WITHOUT the `inArray(orders.status, PAYMENT_COUNTED_STATUSES)` filter; (2) fetch this farmer's own item rows for exactly those page order ids, group them in JS by order id, and attach to each row before mapping through `toFarmerOrder`.

- [ ] **Step 1: Write the failing test**

Append to `server/src/modules/orders/orders.mine.spec.ts` (same file as Task 1, new `describe` block — this exercises the full DB-querying method with a mock `db`, following the `chain` mock pattern in `orders.status-scope.spec.ts`):

```typescript
import { OrdersService } from './orders.service';

describe('OrdersService.ordersForFarmer', () => {
  function makeSvc(orderRows: unknown[], itemRows: unknown[]) {
    let selectCall = 0;
    const chain: any = {};
    chain.select = jest.fn(() => {
      selectCall += 1;
      return chain;
    });
    chain.from = jest.fn(() => chain);
    chain.innerJoin = jest.fn(() => chain);
    chain.leftJoin = jest.fn(() => chain);
    chain.where = jest.fn(() => chain);
    chain.groupBy = jest.fn(() => chain);
    chain.orderBy = jest.fn(() => chain);
    // First select() call is the page-of-orders query (chained through
    // .limit()); the second is the farmer's item rows for that page (no
    // .limit() call in that branch — resolves directly off .groupBy()/.where()).
    chain.limit = jest.fn(() => Promise.resolve(selectCall === 1 ? orderRows : itemRows));
    // Some branches await the chain itself (no trailing .limit()); make the
    // chain thenable so `await chain` resolves too.
    chain.then = (resolve: (v: unknown) => void) =>
      resolve(selectCall === 1 ? orderRows : itemRows);
    return new OrdersService(
      chain as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  it('includes pending and cancelled orders (unlike paymentsForFarmer)', async () => {
    const svc = makeSvc(
      [
        {
          day: '2026-07-07',
          id: 'o1',
          orderNumber: 1,
          customerName: 'Мария',
          customerPhone: null,
          customerEmail: null,
          status: 'pending',
          deliveryType: 'address',
          paymentMethod: 'cod',
          createdAt: '2026-07-07T08:00:00.000Z',
          slotFrom: null,
          slotTo: null,
          codOutcome: null,
          codOutcomeReason: null,
          shared: false,
          __keysetTs: '2026-07-07T08:00:00.000000',
        },
      ],
      [{ orderId: 'o1', productId: 'p1', productName: 'Домати', quantity: 2, priceStotinki: 300 }],
    );
    const page = await svc.ordersForFarmer('t', 'farmer-1', {});
    expect(page.orders).toHaveLength(1);
    expect(page.orders[0].status).toBe('pending');
    expect(page.orders[0].subtotalStotinki).toBe(600);
  });

  it('marks shared: true and still totals only the farmer\'s own items', async () => {
    const svc = makeSvc(
      [
        {
          day: '2026-07-07',
          id: 'o2',
          orderNumber: 2,
          customerName: null,
          customerPhone: null,
          customerEmail: null,
          status: 'confirmed',
          deliveryType: 'pickup',
          paymentMethod: 'cod',
          createdAt: '2026-07-07T09:00:00.000Z',
          slotFrom: null,
          slotTo: null,
          codOutcome: null,
          codOutcomeReason: null,
          shared: true,
          __keysetTs: '2026-07-07T09:00:00.000000',
        },
      ],
      [{ orderId: 'o2', productId: 'p2', productName: 'Краставици', quantity: 1, priceStotinki: 200 }],
    );
    const page = await svc.ordersForFarmer('t', 'farmer-1', {});
    expect(page.orders[0].shared).toBe(true);
    expect(page.orders[0].subtotalStotinki).toBe(200);
  });

  it('returns an empty page with no order rows', async () => {
    const svc = makeSvc([], []);
    const page = await svc.ordersForFarmer('t', 'farmer-1', {});
    expect(page.orders).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest orders.mine.spec.ts`
Expected: FAIL — `svc.ordersForFarmer is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `server/src/modules/orders/orders.service.ts`, add this method immediately after the closing brace of `paymentsForFarmer` (after line 671, before the `/** Tenant-wide payment totals... */` comment on `paymentTotalsCached`):

```typescript
  /**
   * Every order containing at least one of this farmer's own products, across
   * ALL statuses (pending/cancelled included) — the «Моите поръчки» screen's
   * data source. Unlike {@link paymentsForFarmer} this is a fulfillment view,
   * not a money view: it carries per-item detail (not just a subtotal) and a
   * `shared` flag for orders that also have another producer's items, so the
   * client can explain why the mark-delivered/cod-outcome actions are hidden
   * instead of the caller hitting a silent 403 from updateStatusForFarmer.
   */
  async ordersForFarmer(
    tenantId: string,
    farmerId: string,
    opts: {
      status?: 'pending' | 'confirmed' | 'preparing' | 'out_for_delivery' | 'delivered' | 'cancelled';
      q?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<FarmerOrdersPage> {
    const q = (opts.q ?? '').trim();
    const lim = clampLimit(opts.limit);
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;

    const conds = [eq(orders.tenantId, tenantId), eq(products.farmerId, farmerId)];
    if (opts.status) conds.push(eq(orders.status, opts.status));
    if (q) conds.push(this.paymentSearchCond(q));
    if (cur) {
      conds.push(
        sql`(${orders.createdAt}, ${orders.id}) < (${cur.createdAt}::timestamp, ${cur.id}::uuid)`,
      );
    }

    // True when the order also has a line item belonging to a DIFFERENT farmer.
    const shared = sql<boolean>`exists (
      select 1 from ${orderItems} oi2
      inner join ${products} p2 on p2.id = oi2.product_id
      where oi2.order_id = ${orders.id} and p2.farmer_id is distinct from ${farmerId}
    )`;

    const day = sql<string>`coalesce(${deliverySlots.date}, ${bgDate(orders.createdAt)})`;
    const rows = await this.db
      .select({
        day,
        id: orders.id,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        customerPhone: orders.customerPhone,
        customerEmail: orders.customerEmail,
        status: orders.status,
        deliveryType: orders.deliveryType,
        paymentMethod: orders.paymentMethod,
        createdAt: orders.createdAt,
        slotFrom: deliverySlots.timeFrom,
        slotTo: deliverySlots.timeTo,
        codOutcome: orders.codOutcome,
        codOutcomeReason: orders.codOutcomeReason,
        shared,
        [KEYSET_TS]: cursorTs(orders.createdAt),
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(and(...conds)!)
      .groupBy(
        orders.id,
        orders.orderNumber,
        orders.customerName,
        orders.customerPhone,
        orders.customerEmail,
        orders.status,
        orders.deliveryType,
        orders.paymentMethod,
        orders.createdAt,
        orders.codOutcome,
        orders.codOutcomeReason,
        deliverySlots.date,
        deliverySlots.timeFrom,
        deliverySlots.timeTo,
      )
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(lim + 1);

    const { items: pageRows, nextCursor } = buildKeysetPage(
      rows as Array<Omit<FarmerOrderRow, 'items'> & { [KEYSET_TS]: string }>,
      lim,
    );
    if (pageRows.length === 0) return { orders: [], nextCursor };

    const orderIds = pageRows.map((r) => r.id);
    const itemRows = await this.db
      .select({
        orderId: orderItems.orderId,
        productId: orderItems.productId,
        productName: products.name,
        quantity: orderItems.quantity,
        priceStotinki: orderItems.priceStotinki,
      })
      .from(orderItems)
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(inArray(orderItems.orderId, orderIds), eq(products.farmerId, farmerId)));

    const itemsByOrder = new Map<string, FarmerOrderItem[]>();
    for (const it of itemRows as Array<{
      orderId: string;
      productId: string;
      productName: string;
      quantity: number;
      priceStotinki: number;
    }>) {
      const list = itemsByOrder.get(it.orderId) ?? [];
      list.push({
        productId: it.productId,
        productName: it.productName,
        quantity: it.quantity,
        priceStotinki: it.priceStotinki,
      });
      itemsByOrder.set(it.orderId, list);
    }

    const fullRows: FarmerOrderRow[] = pageRows.map((r) => ({
      ...r,
      items: itemsByOrder.get(r.id) ?? [],
    }));

    return { orders: fullRows.map(toFarmerOrder), nextCursor };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest orders.mine.spec.ts`
Expected: PASS (7 tests total — 4 from Task 1 + 3 new)

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/orders.service.ts server/src/modules/orders/orders.mine.spec.ts
git commit -m "feat(orders): add ordersForFarmer — all-status fulfillment query"
```

---

### Task 4: `GET /orders/mine` route

**Files:**
- Modify: `server/src/modules/orders/orders.controller.ts`
- Test: `server/src/modules/orders/orders.controller.spec.ts` (extend)

**Interfaces:**
- Consumes: `MyOrdersQueryDto` (Task 2), `OrdersService.ordersForFarmer` (Task 3), `effectiveFarmerId` (existing, `server/src/common/scope/farmer-scope.util.ts`), `BadRequestException` (from `@nestjs/common`, not yet imported in this controller file — needs adding).
- Produces: route `GET /orders/mine`.

- [ ] **Step 1: Write the failing test**

Append to `server/src/modules/orders/orders.controller.spec.ts` (new `describe` block, same file/pattern as the existing `payments` block at the top):

```typescript
import { BadRequestException } from '@nestjs/common';

// GET /orders/mine mirrors /payments's owner-vs-producer split, but an owner
// has no tenant-wide "mine" (that's just /orders) — so admin without
// ?farmerId is a 400, not a silent fallback.
describe('OrdersController mine routing', () => {
  const svc = {
    ordersForFarmer: jest.fn().mockResolvedValue('scoped'),
  };
  const ctrl = new OrdersController(svc as any);
  const tenant = (over: Record<string, unknown>) =>
    ({ type: 'tenant', userId: 'u', tenantId: 't', ...over }) as any;

  beforeEach(() => jest.clearAllMocks());

  it('a producer is forced to their own farmerId, ignoring ?farmerId', async () => {
    await ctrl.mine(tenant({ role: 'farmer', farmerId: 'farmer-1' }), {
      farmerId: 'farmer-9',
    } as any);
    expect(svc.ordersForFarmer).toHaveBeenCalledWith('t', 'farmer-1', {
      farmerId: 'farmer-9',
    });
  });

  it('an owner with ?farmerId gets that producer\'s view', async () => {
    await ctrl.mine(tenant({ role: 'admin' }), { farmerId: 'farmer-3' } as any);
    expect(svc.ordersForFarmer).toHaveBeenCalledWith('t', 'farmer-3', expect.any(Object));
  });

  it('an owner without ?farmerId gets a 400 (no tenant-wide "mine")', () => {
    expect(() => ctrl.mine(tenant({ role: 'admin' }), {} as any)).toThrow(BadRequestException);
    expect(svc.ordersForFarmer).not.toHaveBeenCalled();
  });

  it('rejects a malformed farmer token (role=farmer, no farmerId) with 403', () => {
    expect(() => ctrl.mine(tenant({ role: 'farmer' }), {} as any)).toThrow();
    expect(svc.ordersForFarmer).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest orders.controller.spec.ts`
Expected: FAIL — `ctrl.mine is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `server/src/modules/orders/orders.controller.ts`:

1. Add `BadRequestException` to the `@nestjs/common` import at the top:

```typescript
import {
  Controller, Get, Post, Patch,
  Param, Body, Query, UseGuards,
  ParseUUIDPipe, BadRequestException,
} from '@nestjs/common';
```

2. Add the `MyOrdersQueryDto` import next to the other DTO imports:

```typescript
import { MyOrdersQueryDto } from './dto/my-orders-query.dto';
```

3. Add the route right after the `payments()` method (after its closing brace, before `@Get(':id')`) — it must stay a literal route ahead of `:id`:

```typescript
  // Literal route — must precede `:id` so it isn't captured as an order id.
  // Every status (incl. pending/cancelled) containing this farmer's own
  // products — the «Моите поръчки» fulfillment screen. A producer is always
  // forced to its own farmerId; an owner MUST pass ?farmerId (there is no
  // tenant-wide "mine" — that's what plain /orders already is).
  @Get('mine')
  @Roles('admin', 'farmer')
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'farmerId', required: false, description: 'Owner-only: scope to one producer' })
  mine(@CurrentUser() user: TenantRequestUser, @Query() query: MyOrdersQueryDto) {
    const scope = effectiveFarmerId(user.role, user.farmerId, query.farmerId);
    if (!scope) throw new BadRequestException('farmerId required for admin');
    return this.ordersService.ordersForFarmer(user.tenantId, scope, query);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest orders.controller.spec.ts`
Expected: PASS (all `orders.controller.spec.ts` tests, including the 4 new ones)

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/orders.controller.ts server/src/modules/orders/orders.controller.spec.ts
git commit -m "feat(orders): add GET /orders/mine route for farmer fulfillment view"
```

---

### Task 5: Full server test suite + build check

**Files:** none (verification only)

- [ ] **Step 1: Run the full server test suite**

Run: `cd server && npx jest`
Expected: All suites PASS, including `orders.mine.spec.ts`, `orders.controller.spec.ts`, `orders.payments.spec.ts`, `orders.status-scope.spec.ts` (no regressions from the new route/method).

- [ ] **Step 2: Run the server TypeScript build**

Run: `cd server && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit (only if any fixes were needed)**

If Steps 1–2 required fixes, stage and commit them with a message describing the fix. If both passed clean, skip this step — nothing to commit.

---

### Task 6: Client API types + `getMyOrders` fetch helper

**Files:**
- Modify: `client/src/lib/api-client.ts` (add after the existing `getPayments` block, i.e. after line 683)

**Interfaces:**
- Consumes: `apiFetch<T>` (existing helper already used by `getPayments`, same file).
- Produces: `FarmerOrderItem`, `FarmerOrder`, `FarmerOrdersPage` interfaces, and `getMyOrders(opts)` function.

This task has no dedicated unit test — it is a thin, typed fetch wrapper with the exact same shape as `getPayments` (which itself has no dedicated test). It is exercised indirectly by Task 7's component.

- [ ] **Step 1: Add the types + fetch helper**

In `client/src/lib/api-client.ts`, immediately after the `getPayments` function (after line 683, before the Stripe onboarding section), add:

```typescript
// ---- Моите поръчки (farmer fulfillment view) — every status, per-item detail ----
export interface FarmerOrderItem {
  productId: string;
  productName: string;
  quantity: number;
  priceStotinki: number;
}

export interface FarmerOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  status: string;
  deliveryType: string;
  paymentMethod: PaymentChannel;
  day: string;
  createdAt: string | null;
  slotFrom: string | null;
  slotTo: string | null;
  codOutcome: 'received' | 'refused' | null;
  codOutcomeReason: string | null;
  /** True when the order also has another producer's items — actions are
   *  hidden; only the shop owner can mark a shared order delivered. */
  shared: boolean;
  subtotalStotinki: number;
  items: FarmerOrderItem[];
}

export interface FarmerOrdersPage {
  orders: FarmerOrder[];
  nextCursor: string | null;
}

export const getMyOrders = (opts?: {
  status?: string;
  q?: string;
  cursor?: string;
  limit?: number;
  /** Owner-only preview of one producer's view. */
  farmerId?: string;
}) => {
  const p = new URLSearchParams();
  if (opts?.status) p.set('status', opts.status);
  if (opts?.q) p.set('q', opts.q);
  if (opts?.cursor) p.set('cursor', opts.cursor);
  if (opts?.limit) p.set('limit', String(opts.limit));
  if (opts?.farmerId) p.set('farmerId', opts.farmerId);
  const query = p.toString();
  return apiFetch<FarmerOrdersPage>(`orders/mine${query ? `?${query}` : ''}`);
};
```

- [ ] **Step 2: Run the client TypeScript build**

Run: `cd client && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/api-client.ts
git commit -m "feat(client): add FarmerOrder types + getMyOrders fetch helper"
```

---

### Task 7: `/my-orders` page + `MyOrdersClient` component

**Files:**
- Create: `client/src/app/(admin)/my-orders/page.tsx`
- Create: `client/src/components/my-orders/my-orders-client.tsx`

**Interfaces:**
- Consumes: `getMyOrders`, `updateOrderStatus`, `setCodOutcome`, `ApiError`, `FarmerOrdersPage`, `FarmerOrder` (all from `@/lib/api-client`); `moneyFromStotinki`, `BG_MONTHS`, `bgWeekdayShort`, `todayIso`, `shiftIsoDate`, `hhmm`, `cn` (from `@/lib/utils`, same imports `payments-client.tsx` already uses).
- Produces: page component at route `/my-orders`; `MyOrdersClient({ initial }: { initial: FarmerOrdersPage })`.

- [ ] **Step 1: Create the server page**

Create `client/src/app/(admin)/my-orders/page.tsx`:

```tsx
import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { MyOrdersClient } from '@/components/my-orders/my-orders-client';
import type { FarmerOrdersPage } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

const EMPTY_PAGE: FarmerOrdersPage = { orders: [], nextCursor: null };

async function getMyOrdersSsr(): Promise<FarmerOrdersPage> {
  const token = [REDACTED]
  if (!token) return EMPTY_PAGE;
  const res = await fetch(`${API_BASE}/orders/mine?limit=20`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  }).catch(() => null);
  if (!res || !res.ok) return EMPTY_PAGE;
  return res.json();
}

export default async function MyOrdersPage() {
  const initial = await getMyOrdersSsr();
  return (
    <div className="max-w-[980px]">
      <MyOrdersClient initial={initial} />
    </div>
  );
}
```

- [ ] **Step 2: Create the client component**

Create `client/src/components/my-orders/my-orders-client.tsx`:

```tsx
'use client';

import { useCallback, useState } from 'react';
import { Check, X, Loader2, Phone, Mail, Users } from 'lucide-react';
import { toast } from 'sonner';
import {
  cn,
  moneyFromStotinki,
  BG_MONTHS,
  bgWeekdayShort,
  todayIso,
  shiftIsoDate,
  hhmm,
} from '@/lib/utils';
import {
  ApiError,
  getMyOrders,
  updateOrderStatus,
  setCodOutcome,
  type FarmerOrdersPage,
  type FarmerOrder,
} from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

const STATUS_LABEL: Record<string, string> = {
  pending: 'Чакаща',
  confirmed: 'Потвърдена',
  preparing: 'Приготвя се',
  out_for_delivery: 'На път',
  delivered: 'Доставена',
  cancelled: 'Отказана',
};

const STATUS_CLS: Record<string, string> = {
  pending: 'bg-ff-amber-softer text-ff-amber-600',
  confirmed: 'bg-ff-surface-2 text-ff-muted',
  preparing: 'bg-ff-surface-2 text-ff-muted',
  out_for_delivery: 'bg-ff-surface-2 text-ff-muted',
  delivered: 'bg-ff-green-100 text-ff-green-800',
  cancelled: 'bg-red-100 text-red-800',
};

const STATUS_TABS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'Всички' },
  { key: 'pending', label: 'Чакащи' },
  { key: 'confirmed', label: 'Потвърдени' },
  { key: 'preparing', label: 'Приготвят се' },
  { key: 'out_for_delivery', label: 'На път' },
  { key: 'delivered', label: 'Доставени' },
  { key: 'cancelled', label: 'Отказани' },
];

function dayLabel(iso: string): string {
  const today = todayIso();
  if (iso === today) return 'Днес';
  if (iso === shiftIsoDate(today, -1)) return 'Вчера';
  if (iso === shiftIsoDate(today, 1)) return 'Утре';
  const [, m, d] = iso.split('-');
  return `${bgWeekdayShort(iso)}, ${Number(d)} ${BG_MONTHS[Number(m) - 1]}`;
}

function Contact({ o }: { o: FarmerOrder }) {
  if (!o.customerPhone && !o.customerEmail) {
    return <span className="text-[12.5px] text-ff-muted-2">—</span>;
  }
  return (
    <div className="flex flex-col gap-0.5 text-[12.5px] text-ff-muted">
      {o.customerPhone && (
        <a href={`tel:${o.customerPhone}`} className="inline-flex items-center gap-1 hover:text-ff-green-700">
          <Phone size={12} /> {o.customerPhone}
        </a>
      )}
      {o.customerEmail && (
        <a href={`mailto:${o.customerEmail}`} className="inline-flex items-center gap-1 hover:text-ff-green-700">
          <Mail size={12} /> {o.customerEmail}
        </a>
      )}
    </div>
  );
}

function DeliveredButton({
  id,
  busyId,
  onMark,
}: {
  id: string;
  busyId: string | null;
  onMark: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onMark(id)}
      disabled={busyId === id}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-ff-green-100 bg-ff-green-50 px-2.5 py-1 text-[11px] font-extrabold text-ff-green-700 hover:bg-ff-green-100 disabled:opacity-60"
    >
      {busyId === id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
      Маркирай доставена
    </button>
  );
}

function CollectButton({
  id,
  busyId,
  onCollect,
}: {
  id: string;
  busyId: string | null;
  onCollect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onCollect(id)}
      disabled={busyId === id}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-ff-green-100 bg-ff-green-50 px-2.5 py-1 text-[11px] font-extrabold text-ff-green-700 hover:bg-ff-green-100 disabled:opacity-60"
    >
      {busyId === id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
      Получих парите
    </button>
  );
}

function RefuseButton({
  id,
  busyId,
  onRefuse,
}: {
  id: string;
  busyId: string | null;
  onRefuse: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onRefuse(id)}
      disabled={busyId === id}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-red-100 bg-red-50 px-2.5 py-1 text-[11px] font-extrabold text-red-700 hover:bg-red-100 disabled:opacity-60"
    >
      {busyId === id ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
      Отказана
    </button>
  );
}

export function MyOrdersClient({ initial }: { initial: FarmerOrdersPage }) {
  const [orders, setOrders] = useState<FarmerOrder[]>(initial.orders);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [status, setStatus] = useState<string>('all');
  const [q, setQ] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async (nextStatus: string, nextQ: string) => {
    try {
      const page = await getMyOrders({
        status: nextStatus === 'all' ? undefined : nextStatus,
        q: nextQ || undefined,
        limit: 20,
      });
      setOrders(page.orders);
      setCursor(page.nextCursor);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, []);

  async function onTab(next: string) {
    setStatus(next);
    await reload(next, q);
  }

  async function onSearch(next: string) {
    setQ(next);
    await reload(status, next);
  }

  async function onLoadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await getMyOrders({
        status: status === 'all' ? undefined : status,
        q: q || undefined,
        cursor,
        limit: 20,
      });
      setOrders((prev) => [...prev, ...page.orders]);
      setCursor(page.nextCursor);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoadingMore(false);
    }
  }

  const onMarkDelivered = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      await updateOrderStatus(id, 'delivered');
      setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status: 'delivered' } : o)));
      toast.success('Отбелязана като доставена.');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  const onCollect = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      await setCodOutcome(id, 'received');
      setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, codOutcome: 'received' } : o)));
      toast.success('Отбелязано като получено.');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  const onRefuse = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      await setCodOutcome(id, 'refused');
      setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, codOutcome: 'refused' } : o)));
      toast.success('Отбелязано като отказана.');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  return (
    <div>
      <h1 className="mb-1 text-[22px] font-extrabold text-ff-green-900">Моите поръчки</h1>
      <p className="mb-4 text-[13px] text-ff-muted">Какво трябва да приготвиш — по поръчка и статус.</p>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => void onTab(t.key)}
            className={cn(
              'rounded-full border px-3 py-1 text-[12.5px] font-bold',
              status === t.key
                ? 'border-ff-green-700 bg-ff-green-700 text-white'
                : 'border-ff-border bg-white text-ff-muted hover:bg-ff-surface-2',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <input
        type="search"
        value={q}
        onChange={(e) => void onSearch(e.target.value)}
        placeholder="Търси по име, телефон, имейл или № поръчка"
        className="mb-4 w-full rounded-[10px] border border-ff-border px-3 py-2 text-[13px]"
      />

      {orders.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-ff-muted-2">Няма поръчки в тази категория.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {orders.map((o) => (
            <li key={o.id} className="rounded-[12px] border border-ff-border bg-white p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-extrabold text-ff-green-900">
                    №{o.orderNumber ?? '—'}
                  </span>
                  <span className="text-[12.5px] text-ff-muted">{dayLabel(o.day)}</span>
                  <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', STATUS_CLS[o.status])}>
                    {STATUS_LABEL[o.status] ?? o.status}
                  </span>
                </div>
                <span className="text-[13px] font-extrabold text-ff-green-900">
                  {moneyFromStotinki(o.subtotalStotinki)}
                </span>
              </div>

              <Contact o={o} />

              <ul className="my-2 flex flex-col gap-0.5 text-[12.5px] text-ff-muted">
                {o.items.map((it) => (
                  <li key={it.productId}>
                    {it.productName} × {it.quantity}
                  </li>
                ))}
              </ul>

              {o.shared && (
                <div className="mb-2 flex items-center gap-1.5 rounded-[8px] bg-ff-amber-softer px-2.5 py-1.5 text-[12px] font-semibold text-ff-amber-600">
                  <Users size={13} />
                  Споделена поръчка — само собственикът може да я маркира.
                </div>
              )}

              {!o.shared && (
                <div className="flex flex-wrap gap-1.5">
                  {o.status !== 'delivered' && o.status !== 'cancelled' && (
                    <DeliveredButton id={o.id} busyId={busyId} onMark={onMarkDelivered} />
                  )}
                  {o.paymentMethod === 'cod' && o.codOutcome === null && (
                    <>
                      <CollectButton id={o.id} busyId={busyId} onCollect={onCollect} />
                      <RefuseButton id={o.id} busyId={busyId} onRefuse={onRefuse} />
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {cursor && (
        <button
          type="button"
          onClick={() => void onLoadMore()}
          disabled={loadingMore}
          className="mt-4 w-full rounded-[10px] border border-ff-border py-2 text-[13px] font-bold text-ff-muted hover:bg-ff-surface-2 disabled:opacity-60"
        >
          {loadingMore ? 'Зарежда…' : 'Зареди още'}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Run the client TypeScript build**

Run: `cd client && npx tsc --noEmit`
Expected: No type errors. If `moneyFromStotinki`, `BG_MONTHS`, `bgWeekdayShort`, `todayIso`, `shiftIsoDate`, `hhmm`, or `cn` report as missing from `@/lib/utils`, open that file and match the exact export names used by `payments-client.tsx`'s import (line 22–30 of that file) — they must already exist since that file imports them successfully today.

- [ ] **Step 4: Commit**

```bash
git add "client/src/app/(admin)/my-orders/page.tsx" client/src/components/my-orders/my-orders-client.tsx
git commit -m "feat(client): add /my-orders fulfillment screen for farmers"
```

---

### Task 8: Navigation — sidebar entry + route guard

**Files:**
- Modify: `client/src/components/layout/sidebar.tsx`
- Modify: `client/src/components/layout/farmer-route-guard.tsx`

**Interfaces:** none new — wiring only.

- [ ] **Step 1: Add the nav entry**

In `client/src/components/layout/sidebar.tsx`, find the `FARMER_NAV` array (the block containing `{ href: '/stats', ... }` through `{ href: '/farmer-delivery', ... }`). Insert a new entry after `/products` and before `/payments`:

```typescript
export const FARMER_NAV: NavItem[] = [
  { href: '/stats', label: 'Статистика', Icon: BarChart3, desc: 'Твоят личен оборот, поръчки и тренд.' },
  { href: '/site-analytics', label: 'Анализ на сайта', Icon: LineChart, desc: 'Посетители на сайта, фуния към поръчка и източници.' },
  { href: '/products', label: 'Продукти', Icon: Package, desc: 'Твоите продукти — добавяй, променяй цени, снимки и наличност.' },
  { href: '/my-orders', label: 'Моите поръчки', Icon: ClipboardList, desc: 'Какво трябва да приготвиш — по поръчка и статус.' },
  { href: '/payments', label: 'Плащания', Icon: CreditCard, desc: 'Плащанията за твоите продукти.' },
  { href: '/availability', label: 'Задай наличност', Icon: CalendarClock, desc: 'Колко имаш налично от всеки продукт — намалява при поръчка.' },
  { href: '/farmer-delivery', label: 'Доставки', Icon: Truck, desc: 'Свържи Speedy/Econt и пращай куриерски поръчки.' },
];
```

(`ClipboardList` is already imported at the top of this file from `lucide-react` — no new import needed.)

- [ ] **Step 2: Allow the route in the farmer route guard**

In `client/src/components/layout/farmer-route-guard.tsx`, add `/my-orders` to `FARMER_ALLOWED`:

```typescript
const FARMER_ALLOWED = ['/stats', '/payments', '/availability', '/products', '/my-orders', '/farmer-delivery', '/settings', '/help'];
```

- [ ] **Step 3: Run the client TypeScript build**

Run: `cd client && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/layout/sidebar.tsx client/src/components/layout/farmer-route-guard.tsx
git commit -m "feat(client): wire /my-orders into farmer nav + route guard"
```

---

### Task 9: Manual verification in the dev preview

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server(s) and log in as a farmer sub-account**

Use an existing farmer sub-account login (from prior farmer-subaccount-logins work) or create one via the owner's "Дай достъп" flow on the Фермери screen. Log into the panel as that farmer.

- [ ] **Step 2: Open `/my-orders` and verify against real data**

- Sidebar shows "Моите поръчки" between "Продукти" and "Плащания".
- The screen loads without a console error and shows orders across multiple statuses if the tenant has them (pending/confirmed/delivered/cancelled).
- Each card shows only this farmer's own product lines and the correct subtotal (not the full order total).
- If a shared order exists (an order with another farmer's item too), it shows the "Споделена поръчка" notice instead of action buttons.
- Status tab filter and search box both refetch correctly.
- Clicking "Маркирай доставена" on a non-shared, non-delivered order succeeds and the card updates.
- For a COD order with no outcome yet, "Получих парите" / "Отказана" both work and update the card.
- "Зареди още" works if there are more than 20 matching orders.

- [ ] **Step 3: Verify owner isolation still holds**

Log in as the tenant owner (`role='admin'`) and confirm `/my-orders` is NOT in the owner's sidebar (owner nav is unaffected — only `FARMER_NAV` changed) and that hitting `GET /orders/mine` without `?farmerId` returns 400 (e.g. via browser devtools network tab or a manual `curl`/Postman call with the owner's token).

- [ ] **Step 4: No commit for this task** — it is verification only. If any issue is found, return to the relevant earlier task, fix, and re-commit there.
