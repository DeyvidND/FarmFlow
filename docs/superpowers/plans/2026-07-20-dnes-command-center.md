# „Днес" Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/dashboard` home with „Днес" — a delivery-day operations cockpit that shows today's order pipeline, prep progress, route status, handover-protocol status, and COD cash-to-collect on one screen, fed by a single cheap aggregate endpoint.

**Architecture:** New `GET /dashboard/today` endpoint on the existing `dashboard` module runs ~8 tenant-scoped grouped queries in one `Promise.all` and returns a `TodaySummary`. The frontend rewrites `dashboard/page.tsx` (server-fetch) → a new `today-client.tsx` that renders reusable tiles (deep-links) plus two inline actions (bulk-confirm, mark-delivered). Route and protocol headline numbers are derived from cheap status/type counts — never by calling the expensive `getRoute` / `listForDay`.

**Tech Stack:** NestJS + drizzle-orm 0.45 + Postgres (server); Next.js App Router + Tailwind `ff-*` tokens (client); jest both sides.

## Global Constraints

- **Delivery-day semantics:** every order query uses `scheduledForDay(day)` from `server/src/modules/orders/order-scheduling.ts` and MUST `leftJoin(deliverySlots, eq(deliverySlots.id, orders.slotId))`, or Postgres throws "missing FROM-clause entry". (Documented landmine.)
- **Europe/Sofia** day resolution via `bgToday()` / `bgDayBounds()` in `server/src/common/time/bg-time.ts`.
- **Money is integer stotinki** — never floats; render client-side via `moneyFromStotinki()` (`client/src/lib/utils.ts`).
- **Multi-tenant:** every query filtered by `eq(orders.tenantId, tenantId)` (or the table's `tenantId`). Never cross-tenant.
- **Drizzle gotchas:** no `ANY()` → use `inArray()`; `CASE…THEN`/aggregates that must be int → cast `::int`; a raw `SQL` object is circular → in tests render via `new PgDialect().sqlToQuery(expr)` and assert `.params`, never `toEqual` it.
- **Client type mirror:** `client` (`@fermeribg/web`) does NOT import `@fermeribg/types`; shared types are hand-mirrored in `client/src/lib/types.ts`. New shared shapes go in BOTH the server source and the client mirror.
- **Order status enum:** `pending | confirmed | preparing | out_for_delivery | delivered | cancelled`. `payment_method: online | cod`. `cod_outcome: received | refused` (nullable). `delivery_type: pickup | address | econt | econt_address | courier`.
- **TDD:** write the failing test first, watch it fail, minimal code to pass, commit per task. Full suite green before each commit (`pnpm --filter @fermeribg/api test`; `pnpm --filter @fermeribg/web test`).
- **Frontend testing convention (IMPORTANT — repo reality):** the `client` app runs **vitest in node env**, `include: ['src/**/*.test.ts']`, with **no jsdom and no @testing-library anywhere in the monorepo** (deliberate — its config says "Pure logic only"). Do **NOT** add jsdom / `@testing-library/*` / `.spec.tsx` render tests. Instead: extract each component's real logic (predicates, label/sub-line builders, optimistic-state transforms) into **pure functions** and unit-test those in `*.test.ts` (vitest, node). Rendering and interactions are verified in the browser during F5 (and the existing playwright e2e). React components themselves carry no unit test — only their extracted pure logic does.
- **Commits:** end message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Multi-byte (Cyrillic) commit messages via `git commit -F <file>` (a `-m` string with „…" quotes is mangled by the shell).

## File Structure

**Backend (`server/src/modules/dashboard/`):**
- `dashboard.service.ts` (modify) — add `TodaySummary`/`TodayPipeline` interfaces + `todaySummary(tenantId, date?)`.
- `dashboard.controller.ts` (modify) — add `GET /dashboard/today`.
- `dashboard.today.spec.ts` (create) — unit tests for `todaySummary` (kept separate from the existing `dashboard.service.spec.ts` to stay focused).

**Frontend (`client/src/`):**
- `lib/types.ts` (modify) — mirror `TodaySummary`/`TodayPipeline`.
- `lib/api-client.ts` (modify) — `getTodaySummary(date)`; `confirmPending(date)` if absent.
- `components/today/summary-tiles.tsx` (create) — presentational `PrepTile`, `RouteTile`, `ProtocolsTile`, `CodTile` (StatTile-based, each a deep-link).
- `components/today/pipeline-strip.tsx` (create) — status-count strip + inline „Потвърди всички".
- `components/today/today-client.tsx` (create) — orchestrator: date nav, tiles, feed, inline actions.
- `components/today/*.spec.tsx` (create) — component tests.
- `app/(admin)/dashboard/page.tsx` (rewrite) — server-fetch `/dashboard/today` + feed → `TodayClient`.
- `components/layout/sidebar.tsx` (modify) — `HOME` label „Табло" → „Днес".

---

## Task B1: `TodaySummary` type + endpoint skeleton

**Files:**
- Modify: `server/src/modules/dashboard/dashboard.service.ts`
- Modify: `server/src/modules/dashboard/dashboard.controller.ts`
- Test: `server/src/modules/dashboard/dashboard.today.spec.ts` (create)

**Interfaces:**
- Produces: `TodayPipeline`, `TodaySummary` interfaces; `DashboardService.todaySummary(tenantId: string, date?: string): Promise<TodaySummary>`; `GET /dashboard/today?date=`.

- [ ] **Step 1: Write the failing test** — create `dashboard.today.spec.ts` with a mock db whose every query resolves empty, asserting a zeroed shape:

```ts
import { DashboardService } from './dashboard.service';

/** todaySummary runs ~8 independent reads under one Promise.all; route each by its
 *  projection's distinctive key (no inter-query ordering assumption). */
function makeDb(r: Partial<{
  pipeline: unknown[]; cod: unknown[]; fulfilled: unknown[]; signed: unknown[];
  farmerLegs: unknown[]; customerLegs: unknown[]; couriers: unknown[]; slots: unknown[];
}> = {}) {
  const pick = (proj: Record<string, unknown>): unknown[] => {
    const k = Object.keys(proj ?? {});
    if (k.includes('status')) return r.pipeline ?? [];
    if (k.includes('toCollectStotinki')) return r.cod ?? [];
    if (k.includes('orderId')) return r.fulfilled ?? [];
    if (k.includes('signed')) return r.signed ?? [];
    if (k.includes('farmerId')) return r.farmerLegs ?? [];
    if (k.includes('customerLegs')) return r.customerLegs ?? [];
    if (k.includes('legIndex')) return r.couriers ?? [];
    if (k.includes('timeFrom')) return r.slots ?? [];
    return [];
  };
  const chain = (proj: Record<string, unknown>) => {
    const b: any = {};
    for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'groupBy', 'orderBy', 'having']) b[m] = jest.fn(() => b);
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(pick(proj)).then(res, rej);
    return b;
  };
  return { select: jest.fn((proj: Record<string, unknown>) => chain(proj)) };
}
const svc = (db: unknown) => new DashboardService(db as never);

describe('DashboardService.todaySummary', () => {
  it('returns a fully-zeroed cockpit when nothing is scheduled', async () => {
    const out = await svc(makeDb()).todaySummary('t1', '2026-07-20');
    expect(out).toEqual({
      date: '2026-07-20',
      pipeline: { new: 0, confirmed: 0, preparing: 0, outForDelivery: 0, delivered: 0, cancelled: 0, total: 0 },
      prep: { ordersToPrep: 0, fulfilled: 0 },
      route: { stops: 0, delivered: 0, pending: 0, couriers: 0 },
      protocols: { total: 0, signed: 0, pending: 0 },
      cod: { toCollectStotinki: 0, toCollectCount: 0, collectedStotinki: 0, collectedCount: 0 },
      revenueStotinki: 0,
      slots: [],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- dashboard.today`
Expected: FAIL — `todaySummary is not a function`.

- [ ] **Step 3: Add the interfaces + a skeleton method** to `dashboard.service.ts`. Add imports at the top (extend the existing import line):

```ts
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  type Database, orders, orderItems, products, deliverySlots, tenants,
  orderFulfillments, handoverProtocols, routeCourierAssignments,
} from '@fermeribg/db';
import { scheduledForDay } from '../orders/order-scheduling';
```

Add the types after `DashboardSummary`:

```ts
export interface TodayPipeline {
  new: number; confirmed: number; preparing: number;
  outForDelivery: number; delivered: number; cancelled: number;
  total: number; // active = all except cancelled
}

export interface TodaySummary {
  date: string;
  pipeline: TodayPipeline;
  prep: { ordersToPrep: number; fulfilled: number };
  route: { stops: number; delivered: number; pending: number; couriers: number };
  protocols: { total: number; signed: number; pending: number };
  cod: { toCollectStotinki: number; toCollectCount: number; collectedStotinki: number; collectedCount: number };
  revenueStotinki: number;
  slots: DashboardSlot[];
}
```

Add the skeleton method in the class (queries filled in later tasks):

```ts
/** Delivery-day operations cockpit — one round of cheap grouped counts. */
async todaySummary(tenantId: string, date?: string): Promise<TodaySummary> {
  const day = date ?? bgToday();
  const sched = scheduledForDay(day); // MUST pair with leftJoin(deliverySlots)
  void tenantId; void sched;
  return {
    date: day,
    pipeline: { new: 0, confirmed: 0, preparing: 0, outForDelivery: 0, delivered: 0, cancelled: 0, total: 0 },
    prep: { ordersToPrep: 0, fulfilled: 0 },
    route: { stops: 0, delivered: 0, pending: 0, couriers: 0 },
    protocols: { total: 0, signed: 0, pending: 0 },
    cod: { toCollectStotinki: 0, toCollectCount: 0, collectedStotinki: 0, collectedCount: 0 },
    revenueStotinki: 0,
    slots: [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- dashboard.today`
Expected: PASS.

- [ ] **Step 5: Add the controller route** in `dashboard.controller.ts` (after `summary`):

```ts
@Get('today')
@ApiQuery({ name: 'date', required: false })
today(@CurrentTenant() tenantId: string, @Query('date') date?: string) {
  return this.dashboardService.todaySummary(tenantId, date);
}
```

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/dashboard/dashboard.service.ts server/src/modules/dashboard/dashboard.controller.ts server/src/modules/dashboard/dashboard.today.spec.ts
git commit -F <msgfile>   # feat(dashboard): TodaySummary type + GET /dashboard/today skeleton
```

---

## Task B2: Pipeline, revenue & route counts

One `GROUP BY status` query over orders scheduled today yields the pipeline buckets, non-cancelled revenue, and the route stop/delivered split (via an `address`-filtered count per status). `prep.ordersToPrep` derives from the confirmed+preparing buckets (HANDOVER_STATUSES). Couriers come from a distinct-leg count.

**Files:**
- Modify: `server/src/modules/dashboard/dashboard.service.ts`
- Test: `server/src/modules/dashboard/dashboard.today.spec.ts`

**Interfaces:**
- Consumes: skeleton from B1.
- Produces: populated `pipeline`, `revenueStotinki`, `route.{stops,delivered,pending,couriers}`, `prep.ordersToPrep`.

- [ ] **Step 1: Write the failing test** — add to `dashboard.today.spec.ts`:

```ts
it('buckets pipeline by status, sums non-cancelled revenue, splits route from address orders', async () => {
  const db = makeDb({
    pipeline: [
      { status: 'pending',          count: 3, totalStotinki: 3000, addr: 2 },
      { status: 'confirmed',        count: 4, totalStotinki: 8000, addr: 3 },
      { status: 'preparing',        count: 1, totalStotinki: 2000, addr: 1 },
      { status: 'out_for_delivery', count: 2, totalStotinki: 5000, addr: 2 },
      { status: 'delivered',        count: 5, totalStotinki: 9000, addr: 4 },
      { status: 'cancelled',        count: 1, totalStotinki: 1000, addr: 1 },
    ],
    couriers: [{ legIndex: 0 }, { legIndex: 1 }],
  });
  const out = await svc(db).todaySummary('t1', '2026-07-20');
  expect(out.pipeline).toEqual({ new: 3, confirmed: 4, preparing: 1, outForDelivery: 2, delivered: 5, cancelled: 1, total: 15 });
  expect(out.revenueStotinki).toBe(27000); // 3000+8000+2000+5000+9000 (cancelled excluded)
  expect(out.prep.ordersToPrep).toBe(5);   // confirmed 4 + preparing 1
  // route stops = address orders in active statuses (2+3+1+2+4=12); delivered addr = 4
  expect(out.route).toEqual({ stops: 12, delivered: 4, pending: 8, couriers: 2 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- dashboard.today`
Expected: FAIL — pipeline/revenue/route still zero.

- [ ] **Step 3: Implement the pipeline + couriers queries.** Replace the skeleton body's constant returns for these fields. Add these query builders before the `return`:

```ts
const pipelineP = this.db
  .select({
    status: orders.status,
    count: sql<number>`count(*)::int`,
    totalStotinki: sql<number>`coalesce(sum(${orders.totalStotinki}), 0)::int`,
    addr: sql<number>`count(*) filter (where ${orders.deliveryType} = 'address')::int`,
  })
  .from(orders)
  .leftJoin(deliverySlots, eq(deliverySlots.id, orders.slotId))
  .where(and(eq(orders.tenantId, tenantId), sched))
  .groupBy(orders.status);

const couriersP = this.db
  .select({ legIndex: routeCourierAssignments.legIndex })
  .from(routeCourierAssignments)
  .where(and(eq(routeCourierAssignments.tenantId, tenantId), eq(routeCourierAssignments.date, day)))
  .groupBy(routeCourierAssignments.legIndex);
```

Await them (extend the `Promise.all` as more tasks add queries; for now):

```ts
const [pipelineRows, courierRows] = await Promise.all([pipelineP, couriersP]);

const by = (s: string) => pipelineRows.find((r) => r.status === s);
const cnt = (s: string) => by(s)?.count ?? 0;
const addr = (s: string) => by(s)?.addr ?? 0;
const ACTIVE = ['pending', 'confirmed', 'preparing', 'out_for_delivery', 'delivered'] as const;

const pipeline: TodayPipeline = {
  new: cnt('pending'), confirmed: cnt('confirmed'), preparing: cnt('preparing'),
  outForDelivery: cnt('out_for_delivery'), delivered: cnt('delivered'), cancelled: cnt('cancelled'),
  total: ACTIVE.reduce((a, s) => a + cnt(s), 0),
};
const revenueStotinki = pipelineRows
  .filter((r) => r.status !== 'cancelled')
  .reduce((a, r) => a + r.totalStotinki, 0);
const routeStops = ACTIVE.reduce((a, s) => a + addr(s), 0);
const routeDelivered = addr('delivered');
```

Wire into the return object: `pipeline`, `revenueStotinki`, `prep: { ordersToPrep: pipeline.confirmed + pipeline.preparing, fulfilled: 0 }`, `route: { stops: routeStops, delivered: routeDelivered, pending: routeStops - routeDelivered, couriers: courierRows.length }`. Keep `cod`, `protocols`, `slots`, `prep.fulfilled` zeroed for now.

- [ ] **Step 4: Run test to verify it passes** (both B1 and B2 tests).

Run: `pnpm --filter @fermeribg/api test -- dashboard.today`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/dashboard/dashboard.service.ts server/src/modules/dashboard/dashboard.today.spec.ts
git commit -F <msgfile>   # feat(dashboard): today pipeline, revenue & route counts
```

---

## Task B3: COD cash-to-collect + prep fulfillment

Two new queries: a COD split (to-collect vs collected) over today's COD orders, and a fulfillment roll-up (orders whose every farmer-leg is `fulfilled`).

**Files:**
- Modify: `server/src/modules/dashboard/dashboard.service.ts`
- Test: `server/src/modules/dashboard/dashboard.today.spec.ts`

**Interfaces:**
- Consumes: B2's `Promise.all` list.
- Produces: populated `cod.*` and `prep.fulfilled`.

- [ ] **Step 1: Write the failing test** — add:

```ts
it('splits COD into to-collect vs collected and counts fully-fulfilled orders', async () => {
  const db = makeDb({
    pipeline: [{ status: 'confirmed', count: 2, totalStotinki: 4000, addr: 2 }],
    cod: [{ toCollectStotinki: 4000, toCollectCount: 2, collectedStotinki: 1500, collectedCount: 1 }],
    fulfilled: [{ orderId: 'o1' }, { orderId: 'o2' }], // 2 orders fully prepared
  });
  const out = await svc(db).todaySummary('t1', '2026-07-20');
  expect(out.cod).toEqual({ toCollectStotinki: 4000, toCollectCount: 2, collectedStotinki: 1500, collectedCount: 1 });
  expect(out.prep.fulfilled).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- dashboard.today`
Expected: FAIL — cod zero, fulfilled 0.

- [ ] **Step 3: Implement.** Add query builders:

```ts
const CASH = sql`${orders.status} in ('confirmed','preparing','out_for_delivery','delivered')`;
const codP = this.db
  .select({
    toCollectStotinki: sql<number>`coalesce(sum(${orders.totalStotinki}) filter (where ${orders.codOutcome} is null and ${CASH}), 0)::int`,
    toCollectCount:    sql<number>`count(*) filter (where ${orders.codOutcome} is null and ${CASH})::int`,
    collectedStotinki: sql<number>`coalesce(sum(${orders.totalStotinki}) filter (where ${orders.codOutcome} = 'received'), 0)::int`,
    collectedCount:    sql<number>`count(*) filter (where ${orders.codOutcome} = 'received')::int`,
  })
  .from(orders)
  .leftJoin(deliverySlots, eq(deliverySlots.id, orders.slotId))
  .where(and(eq(orders.tenantId, tenantId), eq(orders.paymentMethod, 'cod'), sched));

// An order is "prepared" when every farmer-leg fulfillment row is 'fulfilled'.
const fulfilledP = this.db
  .select({ orderId: orderFulfillments.orderId })
  .from(orderFulfillments)
  .innerJoin(orders, eq(orders.id, orderFulfillments.orderId))
  .leftJoin(deliverySlots, eq(deliverySlots.id, orders.slotId))
  .where(and(eq(orderFulfillments.tenantId, tenantId), inArray(orders.status, ['confirmed', 'preparing']), sched))
  .groupBy(orderFulfillments.orderId)
  .having(sql`bool_and(${orderFulfillments.state} = 'fulfilled')`);
```

Extend the `Promise.all` to include `codP` and `fulfilledP`; destructure `[cod]` (single row) and `fulfilledRows`. Wire: `cod: cod ?? { toCollectStotinki:0, toCollectCount:0, collectedStotinki:0, collectedCount:0 }`, and `prep.fulfilled: fulfilledRows.length`.

- [ ] **Step 4: Run test to verify it passes** (all B tests so far).

Run: `pnpm --filter @fermeribg/api test -- dashboard.today`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/dashboard/dashboard.service.ts server/src/modules/dashboard/dashboard.today.spec.ts
git commit -F <msgfile>   # feat(dashboard): today COD split + prep fulfillment count
```

---

## Task B4: Protocol counts

Three cheap queries: persisted signed protocols for the day, distinct farmer-legs (farmer × slot among handover-ready line items), and customer-legs (address handover-ready orders). `total = farmerLegs + customerLegs`; `pending = max(0, total − signed)`.

**Files:**
- Modify: `server/src/modules/dashboard/dashboard.service.ts`
- Test: `server/src/modules/dashboard/dashboard.today.spec.ts`

**Interfaces:**
- Consumes: B3's `Promise.all` list.
- Produces: populated `protocols.{total,signed,pending}`.

- [ ] **Step 1: Write the failing test** — add:

```ts
it('counts protocols: farmer-legs + customer-legs expected, persisted signed, clamped pending', async () => {
  const db = makeDb({
    pipeline: [{ status: 'confirmed', count: 3, totalStotinki: 6000, addr: 2 }],
    signed: [{ signed: 1 }],
    farmerLegs: [{ farmerId: 'f1', slotId: 's1' }, { farmerId: 'f2', slotId: 's1' }], // 2 farmer legs
    customerLegs: [{ customerLegs: 2 }], // 2 address deliveries
  });
  const out = await svc(db).todaySummary('t1', '2026-07-20');
  expect(out.protocols).toEqual({ total: 4, signed: 1, pending: 3 }); // 2+2 expected, 1 signed
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- dashboard.today`
Expected: FAIL — protocols zero.

- [ ] **Step 3: Implement.** Add query builders:

```ts
const signedP = this.db
  .select({ signed: sql<number>`count(*)::int` })
  .from(handoverProtocols)
  .innerJoin(deliverySlots, eq(deliverySlots.id, handoverProtocols.slotId))
  .where(and(eq(handoverProtocols.tenantId, tenantId), eq(deliverySlots.date, day), eq(handoverProtocols.status, 'signed')));

// Distinct (farmer, slot) legs among handover-ready line items scheduled today.
const farmerLegsP = this.db
  .select({ farmerId: products.farmerId, slotId: orders.slotId })
  .from(orderItems)
  .innerJoin(orders, eq(orders.id, orderItems.orderId))
  .innerJoin(products, eq(products.id, orderItems.productId))
  .leftJoin(deliverySlots, eq(deliverySlots.id, orders.slotId))
  .where(and(eq(orders.tenantId, tenantId), inArray(orders.status, ['confirmed', 'preparing']), sched))
  .groupBy(products.farmerId, orders.slotId);

const customerLegsP = this.db
  .select({ customerLegs: sql<number>`count(*)::int` })
  .from(orders)
  .leftJoin(deliverySlots, eq(deliverySlots.id, orders.slotId))
  .where(and(eq(orders.tenantId, tenantId), eq(orders.deliveryType, 'address'), inArray(orders.status, ['confirmed', 'preparing']), sched));
```

Extend `Promise.all` with `signedP, farmerLegsP, customerLegsP`; destructure `[signedRow]`, `farmerLegRows`, `[custRow]`. Wire:

```ts
const protoTotal = farmerLegRows.length + (custRow?.customerLegs ?? 0);
const protoSigned = signedRow?.signed ?? 0;
// protocols: { total: protoTotal, signed: protoSigned, pending: Math.max(0, protoTotal - protoSigned) }
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `pnpm --filter @fermeribg/api test -- dashboard.today`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/dashboard/dashboard.service.ts server/src/modules/dashboard/dashboard.today.spec.ts
git commit -F <msgfile>   # feat(dashboard): today protocol expected/signed counts
```

---

## Task B5: Slots + final assembly + tenant-scope guard test

Reuse the slots query from `summary()`; assert the whole payload assembles and that the WHERE clause is tenant-scoped and delivery-day joined (a filter-blind mock would certify nothing — model it).

**Files:**
- Modify: `server/src/modules/dashboard/dashboard.service.ts`
- Test: `server/src/modules/dashboard/dashboard.today.spec.ts`

**Interfaces:**
- Consumes: B4's `Promise.all` list.
- Produces: populated `slots`; complete `todaySummary`.

- [ ] **Step 1: Write the failing test** — add a slots test and a WHERE-modelling test. For the WHERE test, capture the args passed to `.where()` on the pipeline chain and render them:

```ts
it('maps slots for the day', async () => {
  const db = makeDb({
    slots: [
      { id: 's1', timeFrom: '09:00', timeTo: '10:00', capacity: 3, booked: 1 },
      { id: 's2', timeFrom: '10:00', timeTo: '11:00', capacity: 2, booked: 2 },
    ],
  });
  const out = await svc(db).todaySummary('t1', '2026-07-20');
  expect(out.slots).toEqual([
    { id: 's1', timeFrom: '09:00', timeTo: '10:00', capacity: 3, booked: 1 },
    { id: 's2', timeFrom: '10:00', timeTo: '11:00', capacity: 2, booked: 2 },
  ]);
});

it('scopes the pipeline query to the tenant (filter is modelled, not ignored)', async () => {
  const { PgDialect } = require('drizzle-orm/pg-core');
  let captured: any;
  const base = makeDb({});
  const realSelect = base.select;
  base.select = jest.fn((proj: any) => {
    const chain = realSelect(proj);
    if (Object.keys(proj).includes('status')) {
      const realWhere = chain.where;
      chain.where = jest.fn((cond: any) => { captured = cond; return realWhere(cond); });
    }
    return chain;
  });
  await svc(base).todaySummary('tenant-XYZ', '2026-07-20');
  const { params } = new PgDialect().sqlToQuery(captured);
  expect(params).toContain('tenant-XYZ'); // tenant scope present in the WHERE
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- dashboard.today`
Expected: FAIL — slots empty / captured undefined.

- [ ] **Step 3: Implement the slots query via a shared private helper** (avoid duplicating the builder). Extract the `summary()` slots query into a private method and reuse it from both places:

```ts
/** Active slots for `day` with a live non-cancelled booked count. */
private slotsForDay(tenantId: string, day: string) {
  return this.db
    .select({
      id: deliverySlots.id,
      timeFrom: deliverySlots.timeFrom,
      timeTo: deliverySlots.timeTo,
      capacity: deliverySlots.capacity,
      booked: sql<number>`count(${orders.id}) filter (where ${orders.status} <> 'cancelled')::int`,
    })
    .from(deliverySlots)
    .leftJoin(orders, eq(orders.slotId, deliverySlots.id))
    .where(and(eq(deliverySlots.tenantId, tenantId), sql`${deliverySlots.date} = ${day}`, eq(deliverySlots.isActive, true))!)
    .groupBy(deliverySlots.id, deliverySlots.date, deliverySlots.timeFrom, deliverySlots.timeTo, deliverySlots.capacity)
    .orderBy(deliverySlots.date, deliverySlots.timeFrom);
}
```

Refactor `summary()` to call `this.slotsForDay(tenantId, day)` in place of its inline `slotRowsP`. In `todaySummary`, add `this.slotsForDay(tenantId, day)` to the `Promise.all`, map its rows to `DashboardSlot[]` (`{ id, timeFrom, timeTo, booked, capacity }`), and wire into the return. Verify the final `Promise.all` destructures every query in a stable order and the return references the computed locals (no leftover zero constants).

- [ ] **Step 4: Run the full dashboard suite.**

Run: `pnpm --filter @fermeribg/api test -- dashboard`
Expected: PASS (both `dashboard.service.spec` and `dashboard.today.spec`).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/dashboard/dashboard.service.ts server/src/modules/dashboard/dashboard.today.spec.ts
git commit -F <msgfile>   # feat(dashboard): today slots + full assembly + tenant-scope test
```

- [ ] **Step 6: Run the whole backend suite** to catch cross-module breakage.

Run: `pnpm --filter @fermeribg/api test`
Expected: all green.

---

## Task F1: Client type mirror + `getTodaySummary` + `confirmPending`

**Files:**
- Modify: `client/src/lib/types.ts`
- Modify: `client/src/lib/api-client.ts`
- Test: `client/src/lib/api-client.spec.ts` (create if absent, else extend)

**Interfaces:**
- Produces: `TodaySummary` (client mirror); `getTodaySummary(date?: string): Promise<TodaySummary>`; `confirmPending(date: string): Promise<{ confirmed: number }>`.

- [ ] **Step 1: Add the mirrored type** to `client/src/lib/types.ts` (copy the `TodaySummary`/`TodayPipeline` shape from B1 verbatim; use `DashboardSlot`-equivalent inline `{ id; timeFrom; timeTo; booked; capacity }` matching the existing local slot type). Search the file for "mirror" to place it near the other mirrored types.

- [ ] **Step 2: Write the failing test** for `getTodaySummary` — mock `apiFetch` and assert it calls `/dashboard/today?date=2026-07-20` and returns the payload. Follow the existing api-client test style (if none exists, mock the module's `fetch`). Example assertion:

```ts
it('getTodaySummary hits /dashboard/today with the date', async () => {
  const spy = jest.spyOn(mod, 'apiFetch').mockResolvedValue({ date: '2026-07-20' } as any);
  await getTodaySummary('2026-07-20');
  expect(spy).toHaveBeenCalledWith('/dashboard/today?date=2026-07-20');
});
```

- [ ] **Step 3: Run to verify it fails.** Run: `pnpm --filter @fermeribg/web test -- api-client`. Expected: FAIL.

- [ ] **Step 4: Implement** in `api-client.ts`, mirroring existing exports like `getDashboard`:

```ts
export function getTodaySummary(date?: string): Promise<TodaySummary> {
  const q = date ? `?date=${encodeURIComponent(date)}` : '';
  return apiFetch(`/dashboard/today${q}`);
}
```

Grep the file for `confirmPending` / `confirm-pending`; if absent, add:

```ts
export function confirmPending(date: string): Promise<{ confirmed: number }> {
  return apiFetch(`/orders/confirm-pending?date=${encodeURIComponent(date)}`, { method: 'PATCH' });
}
```

- [ ] **Step 5: Run to verify it passes.** Run: `pnpm --filter @fermeribg/web test -- api-client`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/api-client.ts client/src/lib/api-client.spec.ts
git commit -F <msgfile>   # feat(web): TodaySummary mirror + getTodaySummary/confirmPending client fns
```

---

## Task F2: Presentational tiles (prep / route / protocols / COD + pipeline strip)

Pure presentational components (props in, deep-link out) so they test without a server. Reuse `StatTile` from `client/src/lib/stat-ui.tsx` and the card convention `rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm`. Money via `moneyFromStotinki`.

**Files:**
- Create: `client/src/components/today/tiles-logic.ts` — pure helpers (labels, sub-lines, predicates).
- Create: `client/src/components/today/tiles-logic.test.ts` — vitest node tests for the helpers.
- Create: `client/src/components/today/summary-tiles.tsx` — presentational tiles (no unit test; verified in F5).
- Create: `client/src/components/today/pipeline-strip.tsx` — presentational strip (no unit test; verified in F5).

**Interfaces:**
- Consumes: `TodaySummary` (F1); `moneyFromStotinki` (`lib/utils.ts`).
- Produces pure helpers: `prepSubLine(prep)`, `routeSubLine(route)`, `protocolsSubLine(protocols)`, `codSubLine(cod)`, `tileHref` map (`{prep:'/prep', route:'/route', protocols:'/protocols', cod:'/payments'}`), `showConfirmAll(pipeline): boolean`, `confirmAllLabel(pipeline): string`. Produces components: `PrepTile`, `RouteTile`, `ProtocolsTile`, `CodTile` (props: the matching `TodaySummary` sub-object); `PipelineStrip({ pipeline, onConfirmAll, confirming })`.

Per the Frontend testing convention: test the PURE LOGIC in `.test.ts`, not the rendered components.

- [ ] **Step 1: Write failing tests** in `tiles-logic.test.ts` (vitest, node env — `import { describe, it, expect } from 'vitest'`):

```ts
import { prepSubLine, codSubLine, showConfirmAll, confirmAllLabel, tileHref } from './tiles-logic';

it('prepSubLine shows fulfilled/toPrep', () => {
  expect(prepSubLine({ ordersToPrep: 10, fulfilled: 4 })).toBe('4/10 готови');
});
it('codSubLine renders cash-to-collect in leva', () => {
  expect(codSubLine({ toCollectStotinki: 12345, toCollectCount: 3, collectedStotinki: 500, collectedCount: 1 }))
    .toContain('за събиране');
});
it('showConfirmAll is true only with new orders', () => {
  expect(showConfirmAll({ new: 2, confirmed: 1, preparing: 0, outForDelivery: 0, delivered: 0, cancelled: 0, total: 3 })).toBe(true);
  expect(showConfirmAll({ new: 0, confirmed: 3, preparing: 0, outForDelivery: 0, delivered: 0, cancelled: 0, total: 3 })).toBe(false);
});
it('confirmAllLabel includes the count', () => {
  expect(confirmAllLabel({ new: 2, confirmed: 0, preparing: 0, outForDelivery: 0, delivered: 0, cancelled: 0, total: 2 })).toContain('2');
});
it('tileHref maps each tile to its screen', () => {
  expect(tileHref).toMatchObject({ prep: '/prep', route: '/route', protocols: '/protocols', cod: '/payments' });
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `pnpm --filter @fermeribg/web test -- tiles-logic`. Expected: FAIL (module absent).

- [ ] **Step 3: Implement `tiles-logic.ts`** — the pure helpers above. `codSubLine` uses `moneyFromStotinki(cod.toCollectStotinki)` + `' за събиране · ' + moneyFromStotinki(cod.collectedStotinki) + ' събрани'`; `showConfirmAll = (p) => p.new > 0`; `confirmAllLabel = (p) => \`Потвърди всички (${p.new})\``; `tileHref` the const map. Run: `pnpm --filter @fermeribg/web test -- tiles-logic` → PASS.

- [ ] **Step 4: Implement `summary-tiles.tsx`** (presentational; imports the helpers). Each tile: a `<Link href={tileHref.X}>` wrapping a card (`rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm` + `border-t-[3px] border-t-ff-green-600`) using `StatTile`/`StatCard` showing the Bulgarian label, a primary number, and the helper's `sub` line. Labels: „Подготовка", „Маршрут", „Протоколи", „Пари днес". Export all four.

- [ ] **Step 5: Implement `pipeline-strip.tsx`** (presentational). Horizontal card with five count chips (Нови/Потвърдени/За подготовка/На път/Доставени); when `showConfirmAll(pipeline)`, render a `Button` with `confirmAllLabel(pipeline)` calling `onConfirmAll`, disabled while `confirming`. Run the whole client suite (`pnpm --filter @fermeribg/web test`) → green (only the logic test is new).

- [ ] **Step 6: Commit**

```bash
git add client/src/components/today/tiles-logic.ts client/src/components/today/tiles-logic.test.ts client/src/components/today/summary-tiles.tsx client/src/components/today/pipeline-strip.tsx
git commit -F <msgfile>   # feat(web): Днес summary tiles + pipeline strip
```

---

## Task F3: `today-client.tsx` orchestrator + inline actions

Wires the tiles, date nav, and orders feed; owns state and the two inline mutations with optimistic updates + `sonner` toast + summary re-fetch (no `router.refresh()`), mirroring `dashboard-client.tsx`.

**Files:**
- Create: `client/src/components/today/today-logic.ts` — pure optimistic-state transforms.
- Create: `client/src/components/today/today-logic.test.ts` — vitest node tests.
- Create: `client/src/components/today/today-client.tsx` — orchestrator (no unit test; verified in F5).

**Interfaces:**
- Consumes: `TodaySummary` (F1); `PipelineStrip`, tiles (F2); `getTodaySummary`, `confirmPending`, `updateOrderStatus` (api-client); `OrdersFeed`, `DateNavBar`, `StoreReadinessCard`.
- Produces pure helpers: `applyConfirmAll(pipeline): TodayPipeline` (moves `new`→`confirmed`, `new`=0), `markDelivered(pipeline, fromStatus): TodayPipeline` (decrement the order's current bucket, increment `delivered`). Produces component `TodayClient({ summary, orders, date, readiness, deliveryEnabled })` default export.

Per the Frontend testing convention: test the pure transforms; the component's wiring (which api-client fn it calls) is covered by F1's api-client tests + browser verification (F5).

- [ ] **Step 1: Write failing tests** in `today-logic.test.ts`:

```ts
import { applyConfirmAll, markDelivered } from './today-logic';

const P = { new: 2, confirmed: 1, preparing: 0, outForDelivery: 0, delivered: 3, cancelled: 0, total: 6 };
it('applyConfirmAll moves new into confirmed and zeroes new', () => {
  expect(applyConfirmAll(P)).toMatchObject({ new: 0, confirmed: 3, delivered: 3, total: 6 });
});
it('markDelivered moves one order from its bucket to delivered', () => {
  expect(markDelivered(P, 'confirmed')).toMatchObject({ confirmed: 0, delivered: 4 });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `pnpm --filter @fermeribg/web test -- today-logic`. Expected: FAIL.

- [ ] **Step 3: Implement `today-logic.ts`** — the two pure transforms (immutable copies; `total` unchanged by both; `markDelivered` clamps the source bucket at 0). Run: `pnpm --filter @fermeribg/web test -- today-logic` → PASS.

- [ ] **Step 4: Implement `today-client.tsx`** (`'use client'`): state `summary`, `orders`, `confirming`; `DateNavBar` (default `date`) whose change calls `getTodaySummary(d)` + refetches the feed; render `PipelineStrip` (onConfirmAll → `setConfirming(true)`, optimistic `setSummary(s => ({...s, pipeline: applyConfirmAll(s.pipeline)}))`, `await confirmPending(date)`, then `setSummary(await getTodaySummary(date))`, `sonner` toast, rollback on throw); a responsive tile grid (`grid grid-cols-4 gap-4 max-[1024px]:grid-cols-2 max-[640px]:grid-cols-1`) of the four tiles; then `OrdersFeed` with an onDeliver handler → optimistic `markDelivered` + `await updateOrderStatus(id,'delivered')` (rollback + toast on throw). Root `<div className="animate-ff-fade-up">`. Show `StoreReadinessCard` only when `readiness` is incomplete.

- [ ] **Step 5: Run the whole client suite.** Run: `pnpm --filter @fermeribg/web test`. Expected: green (today-logic is the only new test).

- [ ] **Step 6: Commit**

```bash
git add client/src/components/today/today-logic.ts client/src/components/today/today-logic.test.ts client/src/components/today/today-client.tsx
git commit -F <msgfile>   # feat(web): Днес orchestrator with inline confirm-all + mark-delivered
```

---

## Task F4: Rewrite `dashboard/page.tsx` + rename nav

Server component fetches `/dashboard/today` + today's orders feed + readiness, renders `TodayClient`. Nav label „Табло" → „Днес".

**Files:**
- Rewrite: `client/src/app/(admin)/dashboard/page.tsx`
- Modify: `client/src/components/layout/sidebar.tsx`

**Interfaces:**
- Consumes: `TodayClient` (F3); `getTodaySummary` shape via direct server `fetch`.

- [ ] **Step 1: Rewrite `page.tsx`** — keep `dynamic = 'force-dynamic'`. Replace the `load()` body: parallel `fetch(${API_BASE}/dashboard/today?date=${date})` + `fetch(${API_BASE}/orders?date=${date}&limit=100)` (both Bearer-cookie, `cache:'no-store'`, graceful fallback to a zeroed `TodaySummary` / `[]`). Keep `loadReadiness()` (drives the first-run nudge only); drop `shouldNudgeCard` only if unused elsewhere (otherwise keep as an alert). Resolve `date` from the search param, default `todayIso()`. Render `<TodayClient summary=… orders=… date=… readiness=… deliveryEnabled=… />`. Keep the `EMPTY` fallback as a zeroed `TodaySummary`.

- [ ] **Step 2: Rename the nav item** in `sidebar.tsx` `HOME`: label `'Табло'` → `'Днес'`, `desc` → `'Днешните поръчки, подготовка, маршрут и пари — всичко за деня.'`. Href stays `/dashboard`. (Icon unchanged — YAGNI.)

- [ ] **Step 3: Typecheck + build the client.**

Run: `pnpm --filter @fermeribg/web build`
Expected: builds clean (no TS errors from the new page/props).

- [ ] **Step 4: Run the client test suite.**

Run: `pnpm --filter @fermeribg/web test`
Expected: all green (existing dashboard-client tests may reference removed props — update or remove any that assert the old placed-day KPI cards, since those cards move to /stats).

- [ ] **Step 5: Commit**

```bash
git add "client/src/app/(admin)/dashboard/page.tsx" client/src/components/layout/sidebar.tsx
git commit -F <msgfile>   # feat(web): Днес home replaces Табло; server-fetch today summary + nav label
```

---

## Task F5: Browser verification + full-suite green

**Files:** none (verification only).

- [ ] **Step 1: Full suites both sides.**

Run: `pnpm --filter @fermeribg/api test` then `pnpm --filter @fermeribg/web test`
Expected: all green.

- [ ] **Step 2: Preview + verify** — start the client dev server via `preview_start` (name from `.claude/launch.json`; create it if missing: `next dev` for `@fermeribg/web`), log in, land on `/dashboard`. Confirm: tiles render today's numbers; „Потвърди всички" appears only with new orders and confirms; each tile deep-links correctly; mobile 375px stacks (measure the DOM if screenshots time out). Check `read_console_messages` for errors.

- [ ] **Step 3: Fix any issues** found (edit source, re-verify from Step 2).

- [ ] **Step 4: Screenshot** the finished „Днес" home for the summary to the user.

---

## Self-Review notes (planner)

- **Spec coverage:** placement/home-swap → F4; delivery-day tiles (pipeline/prep/route/protocols/COD/revenue/slots) → B2–B5 + F2; one aggregate endpoint → B1–B5; Standard inline actions (confirm-all, mark-delivered) → F3; TDD + filter-modelling + PgDialect render → B5 test; nav rename, /stats unchanged → F4; error-fallback → F4. No gaps.
- **Type consistency:** `TodaySummary`/`TodayPipeline` defined in B1, mirrored in F1, consumed by F2/F3/F4 with identical field names.
- **Known simplification (documented):** `prep.fulfilled` counts orders whose every farmer-leg fulfillment row is `fulfilled`; `protocols.pending = max(0, total − signed)` is an approximation of the virtual-row universe (exact per-leg reconciliation stays on `/protocols`). Both are intentional YAGNI, cheaper than the fan-out endpoints.
