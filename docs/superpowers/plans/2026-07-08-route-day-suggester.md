# Multi-day Route Suggester Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a geography-first suggester that splits the pending address-delivery orders across N farmer-chosen days, shows each day's harvest summary, and applies the split via the existing reschedule mechanism.

**Architecture:** A new pure engine wraps the existing `sweepSplit` partitioner to assign geocoded orders to days. A new `POST /orders/suggest-days` endpoint loads the reschedulable pool (with coords), runs the engine, and returns per-day orders + harvest totals + a spread hint. A new client modal in the Маршрути (route) page lets the farmer pick days, review/tweak the proposal, and apply it by calling the existing `rescheduleOrders` once per day.

**Tech Stack:** NestJS + Drizzle (server), Jest (server tests), Next.js + React + Tailwind (client), `class-validator` DTOs.

## Global Constraints

- **Placement:** client UI lives in the Маршрути (route) page (`client/src/components/route/`).
- **Objective:** geography-first only. Harvest/products are **display only** — never a move signal.
- **Candidate pool:** `deliveryType='address'`, status ∈ {`pending`,`confirmed`}, slot date ≥ today (the existing `reschedulable()` set).
- **Days:** farmer-editable; may include any calendar date (not only published slot days).
- **Un-geocoded orders:** never auto-placed — returned in a separate `unplaced` bucket.
- **Apply:** reuse `POST /orders/reschedule` (`{ orderIds, toDate }`) — one call per day. No new move/notify code.
- **No schema change. No migration.**
- **Determinism:** the engine must be deterministic (no `Math.random`, no wall-clock) — same input → same output.
- **UI copy:** Bulgarian, matching existing tone (e.g. "Предложи разпределение по дни", "за ръчно нареждане").

---

### Task 1: Pure day-assignment engine

**Files:**
- Create: `server/src/modules/routing/route-day-suggest.ts`
- Test: `server/src/modules/routing/route-day-suggest.spec.ts`

**Interfaces:**
- Consumes: `sweepSplit`, `haversineKm`, `type Pt` from `./route-split`.
- Produces:
  - `interface SuggestOrder { id: string; lat: number | null; lng: number | null; }`
  - `interface DayAssignment { assignment: Record<string, string[]>; unplaced: string[]; }`
  - `function suggestDayAssignment(orders: SuggestOrder[], days: string[], depot: Pt | null): DayAssignment`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/modules/routing/route-day-suggest.spec.ts
import { suggestDayAssignment, type SuggestOrder } from './route-day-suggest';

const depot = { lat: 42.65, lng: 23.32 };

// Two clear clusters: two "north" points and two "south" points.
const north1: SuggestOrder = { id: 'n1', lat: 42.71, lng: 23.32 };
const north2: SuggestOrder = { id: 'n2', lat: 42.72, lng: 23.33 };
const south1: SuggestOrder = { id: 's1', lat: 42.58, lng: 23.32 };
const south2: SuggestOrder = { id: 's2', lat: 42.57, lng: 23.33 };

/** The day (its id list) that contains `id`. */
function dayOf(assignment: Record<string, string[]>, id: string): string[] | undefined {
  return Object.values(assignment).find((ids) => ids.includes(id));
}

describe('suggestDayAssignment', () => {
  it('keeps geographic clusters together across 2 days', () => {
    const orders = [north1, south1, north2, south2];
    const { assignment, unplaced } = suggestDayAssignment(orders, ['2026-07-10', '2026-07-11'], depot);

    expect(unplaced).toEqual([]);
    // Every chosen day is a key.
    expect(Object.keys(assignment).sort()).toEqual(['2026-07-10', '2026-07-11']);
    // The two north orders land on the same day; likewise the two south orders.
    expect(dayOf(assignment, 'n1')).toEqual(dayOf(assignment, 'n2'));
    expect(dayOf(assignment, 's1')).toEqual(dayOf(assignment, 's2'));
    // North and south are on different days.
    expect(dayOf(assignment, 'n1')).not.toEqual(dayOf(assignment, 's1'));
  });

  it('routes un-geocoded orders to unplaced, never onto a day', () => {
    const orders: SuggestOrder[] = [north1, { id: 'x', lat: null, lng: null }];
    const { assignment, unplaced } = suggestDayAssignment(orders, ['2026-07-10'], depot);
    expect(unplaced).toEqual(['x']);
    expect(Object.values(assignment).flat()).toEqual(['n1']);
  });

  it('puts all located orders on the single day when N=1', () => {
    const orders = [north1, south1, north2];
    const { assignment } = suggestDayAssignment(orders, ['2026-07-10'], depot);
    expect(assignment['2026-07-10'].sort()).toEqual(['n1', 'n2', 's1']);
  });

  it('is deterministic', () => {
    const orders = [north1, south1, north2, south2];
    const a = suggestDayAssignment(orders, ['2026-07-10', '2026-07-11'], depot);
    const b = suggestDayAssignment(orders, ['2026-07-10', '2026-07-11'], depot);
    expect(a).toEqual(b);
  });

  it('falls back to the stop centroid when no depot is given', () => {
    const orders = [north1, north2, south1, south2];
    const { assignment, unplaced } = suggestDayAssignment(orders, ['2026-07-10', '2026-07-11'], null);
    expect(unplaced).toEqual([]);
    expect(Object.values(assignment).flat().sort()).toEqual(['n1', 'n2', 's1', 's2']);
  });

  it('returns empty day lists when there are no located orders', () => {
    const orders: SuggestOrder[] = [{ id: 'x', lat: null, lng: null }];
    const { assignment, unplaced } = suggestDayAssignment(orders, ['2026-07-10'], depot);
    expect(assignment).toEqual({ '2026-07-10': [] });
    expect(unplaced).toEqual(['x']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest route-day-suggest --silent`
Expected: FAIL — `Cannot find module './route-day-suggest'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/modules/routing/route-day-suggest.ts
import { sweepSplit, haversineKm, type Pt } from './route-split';

/** One order the suggester may place, with its (possibly missing) coords. */
export interface SuggestOrder {
  id: string;
  lat: number | null;
  lng: number | null;
}

/** Result: order ids per day, plus the un-geocoded ids we could not place. */
export interface DayAssignment {
  /** Keyed by every chosen day (empty array when a day gets no orders). */
  assignment: Record<string, string[]>;
  /** Ids of orders with no coordinates — never auto-placed. */
  unplaced: string[];
}

type Located = { id: string; lat: number; lng: number };

/** Mean lat/lng of the located orders — a stand-in depot when the farm has none. */
function centroid(pts: Located[]): Pt {
  const s = pts.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), { lat: 0, lng: 0 });
  return { lat: s.lat / pts.length, lng: s.lng / pts.length };
}

/** Mean lat/lng of a group of located orders. */
function groupCentroid(group: Located[]): Pt {
  return centroid(group);
}

/**
 * Geography-first assignment of `orders` onto `days`. Reuses `sweepSplit` to
 * partition the geocoded orders into `days.length` balanced geographic groups,
 * then maps groups onto days by a deterministic rule (nearest-to-depot group to
 * the earliest date). Un-geocoded orders go to `unplaced`. Pure & deterministic.
 */
export function suggestDayAssignment(
  orders: SuggestOrder[],
  days: string[],
  depot: Pt | null,
): DayAssignment {
  const sortedDays = [...days].sort(); // ISO dates sort chronologically
  const assignment: Record<string, string[]> = {};
  for (const d of sortedDays) assignment[d] = [];

  const located: Located[] = orders
    .filter((o): o is Located => o.lat != null && o.lng != null)
    .map((o) => ({ id: o.id, lat: o.lat as number, lng: o.lng as number }));
  const unplaced = orders.filter((o) => o.lat == null || o.lng == null).map((o) => o.id);

  if (sortedDays.length === 0 || located.length === 0) {
    return { assignment, unplaced };
  }

  const depotPt: Pt = depot ?? centroid(located);

  // Balanced geographic groups (one per day). endPt = depot → round-trip workload.
  const groups = sweepSplit(depotPt, located, sortedDays.length, depotPt);

  // Deterministic group → day: nearest-to-depot group first, then larger group
  // first, then by the group's lowest order id (final stable tiebreak).
  const ranked = groups
    .filter((g) => g.length > 0)
    .map((g) => ({
      g,
      dist: haversineKm(depotPt, groupCentroid(g)),
      size: g.length,
      minId: g.reduce((m, s) => (s.id < m ? s.id : m), g[0].id),
    }))
    .sort((a, b) => a.dist - b.dist || b.size - a.size || a.minId.localeCompare(b.minId));

  ranked.forEach((r, i) => {
    const day = sortedDays[Math.min(i, sortedDays.length - 1)];
    assignment[day].push(...r.g.map((s) => s.id));
  });

  return { assignment, unplaced };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest route-day-suggest --silent`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/routing/route-day-suggest.ts server/src/modules/routing/route-day-suggest.spec.ts
git commit -m "feat(routing): pure geography-first day-assignment engine"
```

---

### Task 2: Shared harvest-summary helper (extract from digest)

**Files:**
- Create: `server/src/modules/orders/harvest-summary.ts`
- Test: `server/src/modules/orders/harvest-summary.spec.ts`
- Modify: `server/src/modules/digest/digest.service.ts` (replace the inline `prepMap` block with the helper)

**Interfaces:**
- Produces:
  - `interface HarvestLine { productName: string; quantity: number; }`
  - `function harvestSummary(items: { productName: string | null; quantity: number }[]): HarvestLine[]`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/modules/orders/harvest-summary.spec.ts
import { harvestSummary } from './harvest-summary';

describe('harvestSummary', () => {
  it('sums quantity per product name, largest first', () => {
    const out = harvestSummary([
      { productName: 'Кайсии 1кг', quantity: 3 },
      { productName: 'Ягоди 0.5кг', quantity: 2 },
      { productName: 'Кайсии 1кг', quantity: 4 },
    ]);
    expect(out).toEqual([
      { productName: 'Кайсии 1кг', quantity: 7 },
      { productName: 'Ягоди 0.5кг', quantity: 2 },
    ]);
  });

  it('folds a null product name to a dash bucket', () => {
    expect(harvestSummary([{ productName: null, quantity: 5 }])).toEqual([
      { productName: '—', quantity: 5 },
    ]);
  });

  it('returns an empty array for no items', () => {
    expect(harvestSummary([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest harvest-summary --silent`
Expected: FAIL — `Cannot find module './harvest-summary'`.

- [ ] **Step 3: Write the helper**

```ts
// server/src/modules/orders/harvest-summary.ts

/** One product's total quantity to harvest/prepare. */
export interface HarvestLine {
  productName: string;
  quantity: number;
}

/**
 * Total quantity per product across a set of order line items, largest first
 * (ties by product name). Null names fold to "—". Pure — shared by the daily
 * digest's "За приготвяне" list and the route day-suggester's per-day readout.
 */
export function harvestSummary(
  items: { productName: string | null; quantity: number }[],
): HarvestLine[] {
  const map = new Map<string, number>();
  for (const it of items) {
    const name = it.productName ?? '—';
    map.set(name, (map.get(name) ?? 0) + it.quantity);
  }
  return [...map.entries()]
    .map(([productName, quantity]) => ({ productName, quantity }))
    .sort((a, b) => b.quantity - a.quantity || a.productName.localeCompare(b.productName));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest harvest-summary --silent`
Expected: PASS (3 tests).

- [ ] **Step 5: Refactor digest to use the helper**

In `server/src/modules/digest/digest.service.ts`:

Add the import near the other module imports (after the `scheduledForDay` import at line 7):

```ts
import { harvestSummary } from '../orders/harvest-summary';
```

Replace the inline prep block (currently lines 509-517):

```ts
    // Prep summary: total qty per product across the day.
    const prepMap = new Map<string, number>();
    for (const r of rows) {
      const name = r.productName ?? '—';
      prepMap.set(name, (prepMap.get(name) ?? 0) + r.quantity);
    }
    const prep: FarmerItem[] = [...prepMap.entries()]
      .map(([productName, quantity]) => ({ productName, quantity }))
      .sort((a, b) => b.quantity - a.quantity);
```

with:

```ts
    // Prep summary: total qty per product across the day (shared helper).
    const prep: FarmerItem[] = harvestSummary(rows);
```

(`FarmerItem` is `{ productName: string; quantity: number }` — structurally identical to `HarvestLine`, so the assignment type-checks. `rows` elements carry `productName` + `quantity`, matching the helper's parameter.)

- [ ] **Step 6: Run digest + harvest tests**

Run: `cd server && npx jest digest harvest-summary --silent`
Expected: PASS (existing digest tests still green; harvest tests green).

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/orders/harvest-summary.ts server/src/modules/orders/harvest-summary.spec.ts server/src/modules/digest/digest.service.ts
git commit -m "refactor(orders): extract shared harvestSummary helper from digest"
```

---

### Task 3: Backend endpoint `POST /orders/suggest-days`

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts` (extend `reschedulable()` select + `ReschedulableOrder` interface with coords)
- Create: `server/src/modules/routing/dto/suggest-days.dto.ts`
- Modify: `server/src/modules/routing/routing.service.ts` (add `suggestDays()` + result types)
- Modify: `server/src/modules/routing/routing.controller.ts` (add the route)
- Test: `server/src/modules/routing/routing.suggest-controller.spec.ts`

**Interfaces:**
- Consumes: `suggestDayAssignment` (Task 1), `harvestSummary` (Task 2), `OrdersService.reschedulable` (extended below), `haversineKm`/`type Pt` from `./route-split`.
- Produces (result types in `routing.service.ts`):
  - `interface SuggestedDayOrder { id: string; orderNumber: number | null; customerName: string | null; lat: number | null; lng: number | null; totalStotinki: number; }`
  - `interface SuggestedDay { date: string; orders: SuggestedDayOrder[]; harvest: HarvestLine[]; spreadKm: number; }`
  - `interface UnplacedOrder { id: string; orderNumber: number | null; customerName: string | null; totalStotinki: number; }`
  - `interface DaySuggestionResult { days: SuggestedDay[]; unplaced: UnplacedOrder[]; }`
  - `RoutingService.suggestDays(tenantId: string, days: string[]): Promise<DaySuggestionResult>`

- [ ] **Step 1: Extend `reschedulable()` to return coords**

In `server/src/modules/orders/orders.service.ts`, extend the `ReschedulableOrder` interface (around line 78) — add two fields:

```ts
  /** Delivery coordinates (null when the address was never geocoded). */
  deliveryLat: string | null;
  deliveryLng: string | null;
```

And in the `reschedulable()` select (around line 1117-1125), add after `slotDate`:

```ts
        deliveryLat: orders.deliveryLat,
        deliveryLng: orders.deliveryLng,
```

- [ ] **Step 2: Write the DTO**

```ts
// server/src/modules/routing/dto/suggest-days.dto.ts
import { ArrayMaxSize, ArrayMinSize, IsArray, Matches } from 'class-validator';

export class SuggestDaysDto {
  /** The days (YYYY-MM-DD) to spread the pending address orders across. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(14)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { each: true, message: 'всяка дата трябва да е YYYY-MM-DD' })
  days!: string[];
}
```

- [ ] **Step 3: Add `suggestDays()` to the routing service**

In `server/src/modules/routing/routing.service.ts`:

Add imports (extend the existing `./route-split` import and add the two helpers + OrdersService):

```ts
import { sweepSplit, haversineKm, type Pt } from './route-split';
import { suggestDayAssignment } from './route-day-suggest';
import { harvestSummary, type HarvestLine } from '../orders/harvest-summary';
import { OrdersService } from '../orders/orders.service';
```

Inject `OrdersService` in the constructor (add the parameter alongside the existing `db`/`maps` deps):

```ts
    private readonly ordersService: OrdersService,
```

Add the result types near the top-level interfaces:

```ts
export interface SuggestedDayOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  lat: number | null;
  lng: number | null;
  totalStotinki: number;
}
export interface SuggestedDay {
  date: string;
  orders: SuggestedDayOrder[];
  harvest: HarvestLine[];
  /** Sum of straight-line depot→stop km — a rough "how spread" hint, not a route length. */
  spreadKm: number;
}
export interface UnplacedOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  totalStotinki: number;
}
export interface DaySuggestionResult {
  days: SuggestedDay[];
  unplaced: UnplacedOrder[];
}
```

Add the method to the `RoutingService` class:

```ts
  /**
   * Geography-first proposal: spread the tenant's pending address orders (the
   * reschedulable pool) across `days`. Returns per-day orders + a harvest total
   * + a spread hint, plus the un-geocoded orders the farmer must place by hand.
   * Applying the proposal is the client's job (it calls the existing reschedule
   * endpoint once per day) — this method never mutates.
   */
  async suggestDays(tenantId: string, days: string[]): Promise<DaySuggestionResult> {
    const pool = await this.ordersService.reschedulable(tenantId);

    // Depot = farm coords (null when the farm was never geocoded).
    const [tenant] = await this.db
      .select({ farmLat: tenants.farmLat, farmLng: tenants.farmLng })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const depot: Pt | null =
      tenant?.farmLat != null && tenant?.farmLng != null
        ? { lat: Number(tenant.farmLat), lng: Number(tenant.farmLng) }
        : null;

    const { assignment, unplaced } = suggestDayAssignment(
      pool.map((o) => ({ id: o.id, lat: toNum(o.deliveryLat), lng: toNum(o.deliveryLng) })),
      days,
      depot,
    );

    const byId = new Map(pool.map((o) => [o.id, o]));

    // Per-order line items for the harvest readout (no N+1 — one query).
    const poolIds = pool.map((o) => o.id);
    const itemsByOrder = new Map<string, { productName: string | null; quantity: number }[]>();
    if (poolIds.length) {
      const items = await this.db
        .select({
          orderId: orderItems.orderId,
          productName: orderItems.productName,
          quantity: orderItems.quantity,
        })
        .from(orderItems)
        .where(inArray(orderItems.orderId, poolIds));
      for (const it of items) {
        const list = itemsByOrder.get(it.orderId!) ?? [];
        list.push({ productName: it.productName, quantity: it.quantity });
        itemsByOrder.set(it.orderId!, list);
      }
    }

    const daysOut: SuggestedDay[] = Object.entries(assignment).map(([date, ids]) => {
      const dayOrders = ids.map((id) => byId.get(id)!).filter(Boolean);
      const dayItems = ids.flatMap((id) => itemsByOrder.get(id) ?? []);
      const spreadKm =
        depot == null
          ? 0
          : dayOrders.reduce((sum, o) => {
              const lat = toNum(o.deliveryLat);
              const lng = toNum(o.deliveryLng);
              return lat != null && lng != null ? sum + haversineKm(depot, { lat, lng }) : sum;
            }, 0);
      return {
        date,
        orders: dayOrders.map((o) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          customerName: o.customerName,
          lat: toNum(o.deliveryLat),
          lng: toNum(o.deliveryLng),
          totalStotinki: o.totalStotinki,
        })),
        harvest: harvestSummary(dayItems),
        spreadKm: Math.round(spreadKm * 10) / 10,
      };
    });

    const unplacedOut: UnplacedOrder[] = unplaced.map((id) => {
      const o = byId.get(id)!;
      return {
        id: o.id,
        orderNumber: o.orderNumber,
        customerName: o.customerName,
        totalStotinki: o.totalStotinki,
      };
    });

    return { days: daysOut, unplaced: unplacedOut };
  }
```

**Note on the module wiring:** `RoutingService` now depends on `OrdersService`. Confirm `RoutingModule` imports `OrdersModule` (or that `OrdersService` is exported and available). Check `server/src/modules/routing/routing.module.ts`: if `OrdersModule` is not already imported, add it to the module's `imports` array, and ensure `OrdersModule` has `exports: [OrdersService]`. (If a circular import arises because `OrdersModule` imports `RoutingModule`, use `forwardRef(() => OrdersModule)` in RoutingModule and `@Inject(forwardRef(() => OrdersService))` on the constructor param.)

- [ ] **Step 4: Add the controller route**

In `server/src/modules/routing/routing.controller.ts`:

Add imports:

```ts
import { Post } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SuggestDaysDto } from './dto/suggest-days.dto';
```

Add the route inside the controller class:

```ts
  // Geography-first proposal to spread pending address orders across the given
  // days. Read-only (no mutation) — the client applies it via /orders/reschedule.
  @Post('suggest-days')
  @UseGuards(ActiveSubscriptionGuard, RolesGuard)
  @Roles('admin')
  suggestDays(@CurrentTenant() tenantId: string, @Body() dto: SuggestDaysDto) {
    return this.routingService.suggestDays(tenantId, dto.days);
  }
```

(Match the exact `@Roles`/`RolesGuard` import paths used elsewhere in the module — verify against `orders.controller.ts`'s `@Roles('admin')` usage, which imports from `../../common/decorators/roles.decorator`. If `RolesGuard` is applied globally rather than per-route in this codebase, drop `RolesGuard` from `@UseGuards` and keep only `@Roles('admin')`, mirroring `OrdersController.reschedulable`.)

- [ ] **Step 5: Write the controller/service delegation test**

```ts
// server/src/modules/routing/routing.suggest-controller.spec.ts
import { RoutingController } from './routing.controller';

describe('RoutingController suggest-days', () => {
  it('delegates to the service with the tenant id and the dto days', async () => {
    const service = { suggestDays: jest.fn().mockResolvedValue({ days: [], unplaced: [] }) };
    const c = new RoutingController(service as any);
    await c.suggestDays('t1', { days: ['2026-07-10', '2026-07-11'] } as any);
    expect(service.suggestDays).toHaveBeenCalledWith('t1', ['2026-07-10', '2026-07-11']);
  });
});
```

- [ ] **Step 6: Run the server suite for the touched areas**

Run: `cd server && npx jest routing orders/harvest-summary route-day-suggest digest --silent`
Expected: PASS. Then a type-check: `cd server && npx tsc --noEmit` → no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/orders/orders.service.ts server/src/modules/routing/dto/suggest-days.dto.ts server/src/modules/routing/routing.service.ts server/src/modules/routing/routing.controller.ts server/src/modules/routing/routing.suggest-controller.spec.ts
git commit -m "feat(routing): POST /orders/suggest-days geography-first proposal endpoint"
```

---

### Task 4: Client — API client, types, and the suggester modal

**Files:**
- Modify: `client/src/lib/types.ts` (add suggestion result types)
- Modify: `client/src/lib/api-client.ts` (add `suggestDays`)
- Create: `client/src/components/route/route-day-suggester-modal.tsx`

**Interfaces:**
- Consumes: `rescheduleOrders` (existing), `listReschedulable` (existing, now returns coords — unused here), `relDayLabel`, `moneyFromStotinki` from `@/lib/utils`.
- Produces:
  - types `SuggestedDayOrder`, `SuggestedDay`, `UnplacedOrder`, `DaySuggestionResult`, `HarvestLine` in `types.ts`
  - `suggestDays(days: string[]): Promise<DaySuggestionResult>` in `api-client.ts`
  - `RescheduleSuggesterModal` React component (default-exported name `RouteDaySuggesterModal`)

- [ ] **Step 1: Add types**

In `client/src/lib/types.ts`, add:

```ts
export interface HarvestLine {
  productName: string;
  quantity: number;
}
export interface SuggestedDayOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  lat: number | null;
  lng: number | null;
  totalStotinki: number;
}
export interface SuggestedDay {
  date: string;
  orders: SuggestedDayOrder[];
  harvest: HarvestLine[];
  spreadKm: number;
}
export interface UnplacedOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  totalStotinki: number;
}
export interface DaySuggestionResult {
  days: SuggestedDay[];
  unplaced: UnplacedOrder[];
}
```

- [ ] **Step 2: Add the API function**

In `client/src/lib/api-client.ts`, add near `getRoute` (after line 609), and add `DaySuggestionResult` to the existing type import from `@/lib/types`:

```ts
/** Geography-first proposal to spread pending address orders across `days` (YYYY-MM-DD). */
export const suggestDays = (days: string[]) =>
  apiFetch<DaySuggestionResult>(
    'orders/suggest-days',
    { method: 'POST', ...json({ days }) },
    'Неуспешно предложение за разпределение',
  );
```

- [ ] **Step 3: Build the modal component**

```tsx
// client/src/components/route/route-day-suggester-modal.tsx
'use client';

import { useMemo, useState } from 'react';
import { X, Wand2, MapPin, Sprout } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { relDayLabel, moneyFromStotinki } from '@/lib/utils';
import { ApiError, suggestDays, rescheduleOrders } from '@/lib/api-client';
import type { DaySuggestionResult, SuggestedDayOrder } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const todayStr = () => new Date().toLocaleDateString('en-CA');
const orderNo = (o: { orderNumber: number | null; id: string }) =>
  o.orderNumber != null ? `#${o.orderNumber}` : `#${o.id.slice(0, 8)}`;

/** Per-order target-day override the farmer can change before applying. */
type Choice = { day: string | null }; // null = excluded from the move

export function RouteDaySuggesterModal({
  onClose,
  onApplied,
}: {
  onClose: () => void;
  /** Called after a successful apply so the route page can reload. */
  onApplied: () => void;
}) {
  const [days, setDays] = useState<string[]>([]);
  const [newDay, setNewDay] = useState('');
  const [result, setResult] = useState<DaySuggestionResult | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const addDay = () => {
    if (newDay && !days.includes(newDay)) setDays([...days, newDay].sort());
    setNewDay('');
  };
  const removeDay = (d: string) => setDays(days.filter((x) => x !== d));

  async function propose() {
    if (!days.length) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await suggestDays(days);
      setResult(res);
      // Seed each order's choice with the day the engine proposed.
      const seeded: Record<string, Choice> = {};
      for (const day of res.days) for (const o of day.orders) seeded[o.id] = { day: day.date };
      setChoices(seeded);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }

  // Group by the farmer's (possibly edited) choice, ready to apply.
  const groupedForApply = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [orderId, c] of Object.entries(choices)) {
      if (!c.day) continue; // excluded
      const list = map.get(c.day) ?? [];
      list.push(orderId);
      map.set(c.day, list);
    }
    return map;
  }, [choices]);

  const movesCount = useMemo(
    () => [...groupedForApply.values()].reduce((n, ids) => n + ids.length, 0),
    [groupedForApply],
  );

  async function apply() {
    if (!movesCount) return;
    setBusy(true);
    try {
      let moved = 0;
      for (const [date, ids] of groupedForApply) {
        if (!ids.length) continue;
        const res = await rescheduleOrders(ids, date);
        moved += res.moved;
      }
      toast.success(`Разпределени ${moved} поръчки по ${groupedForApply.size} дни`);
      onApplied();
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const orderRow = (o: SuggestedDayOrder) => (
    <div key={o.id} className="flex items-center gap-2 border-b border-ff-border-2 px-3 py-2 last:border-0">
      <span className="flex-1 truncate text-[13.5px] font-semibold text-ff-ink">
        {orderNo(o)} · {o.customerName ?? '—'}
        {o.lat == null && <MapPin size={13} className="ml-1 inline text-ff-amber-600" />}
      </span>
      <span className="ff-fig text-[13px] font-bold text-ff-ink-2">
        {moneyFromStotinki(o.totalStotinki)}
      </span>
      <select
        value={choices[o.id]?.day ?? ''}
        onChange={(e) =>
          setChoices((c) => ({ ...c, [o.id]: { day: e.target.value || null } }))
        }
        className="rounded-md border border-ff-border bg-ff-surface-2 px-1.5 py-1 text-[12.5px] font-bold outline-none"
      >
        {days.map((d) => (
          <option key={d} value={d}>
            {relDayLabel(d)}
          </option>
        ))}
        <option value="">Изключи</option>
      </select>
    </div>
  );

  return (
    <div className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ff-border px-5 py-4">
          <h2 className="flex items-center gap-2 text-[16px] font-extrabold text-ff-ink">
            <Wand2 size={18} /> Предложи разпределение по дни
          </h2>
          <button onClick={onClose} className="text-ff-muted hover:text-ff-ink" aria-label="Затвори">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Day picker */}
          <label className="mb-1.5 block text-[13px] font-bold text-ff-ink-2">За кои дни</label>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {days.map((d) => (
              <span key={d} className="inline-flex items-center gap-1.5 rounded-lg bg-ff-green-100 px-2.5 py-1 text-[13px] font-bold text-ff-green-800">
                {relDayLabel(d)}
                <button onClick={() => removeDay(d)} aria-label={`Махни ${d}`}>
                  <X size={13} />
                </button>
              </span>
            ))}
            <input
              type="date"
              min={todayStr()}
              value={newDay}
              onChange={(e) => setNewDay(e.target.value)}
              className="h-9 rounded-lg border border-ff-border bg-ff-surface px-2 text-[13px] outline-none focus:border-ff-green-500"
            />
            <Button variant="ghost" size="sm" onClick={addDay} disabled={!newDay}>
              Добави ден
            </Button>
          </div>
          <Button variant="primary" size="sm" onClick={propose} disabled={!days.length || loading}>
            {loading ? 'Смятам…' : 'Предложи'}
          </Button>

          {/* Proposal */}
          {result && (
            <div className="mt-4 space-y-3">
              {result.days.map((day) => (
                <div key={day.date} className="rounded-xl border border-ff-border-2">
                  <div className="flex items-center justify-between border-b border-ff-border-2 bg-ff-surface-2 px-3 py-2">
                    <span className="text-[14px] font-extrabold capitalize text-ff-ink">
                      {relDayLabel(day.date)} · {day.orders.length} поръчки
                    </span>
                    <span className="text-[12px] font-semibold text-ff-muted">~{day.spreadKm} км</span>
                  </div>
                  {day.harvest.length > 0 && (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-ff-border-2 px-3 py-2 text-[12.5px] text-ff-ink-2">
                      <span className="inline-flex items-center gap-1 font-bold text-ff-green-700">
                        <Sprout size={13} /> За бране:
                      </span>
                      {day.harvest.map((h) => (
                        <span key={h.productName}>
                          {h.productName} <strong>× {h.quantity}</strong>
                        </span>
                      ))}
                    </div>
                  )}
                  {day.orders.map(orderRow)}
                </div>
              ))}

              {result.unplaced.length > 0 && (
                <div className="rounded-xl border border-ff-amber-300 bg-ff-amber-50">
                  <div className="border-b border-ff-amber-200 px-3 py-2 text-[13.5px] font-bold text-ff-amber-700">
                    За ръчно нареждане (без карта) · {result.unplaced.length}
                  </div>
                  {result.unplaced.map((o) => (
                    <div key={o.id} className="flex items-center gap-2 border-b border-ff-amber-100 px-3 py-2 text-[13px] font-semibold text-ff-ink last:border-0">
                      <span className="flex-1 truncate">
                        {orderNo(o)} · {o.customerName ?? '—'}
                      </span>
                      <span className="ff-fig text-ff-ink-2">{moneyFromStotinki(o.totalStotinki)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-ff-border px-5 py-4">
          <p className="text-[12px] text-ff-muted">
            Клиентите с имейл получават известие, че денят е сменен.
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Отказ
            </Button>
            <Button variant="primary" size="sm" onClick={apply} disabled={!result || !movesCount || busy}>
              Приложи {movesCount || ''}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Type-check the client**

Run: `cd client && npx tsc --noEmit`
Expected: no errors. (Confirm `moneyFromStotinki` and `relDayLabel` exist in `@/lib/utils` — they are already used by `reschedule-orders-modal.tsx`. Confirm `Button` accepts `variant`/`size` as used elsewhere. Confirm `ApiError`/`json` are exported from `api-client.ts` — `json` is used by existing POST helpers.)

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/api-client.ts client/src/components/route/route-day-suggester-modal.tsx
git commit -m "feat(route-web): day-suggester modal + suggest-days api client"
```

---

### Task 5: Client — wire the suggester into the Маршрути toolbar

**Files:**
- Modify: `client/src/components/route/route-client.tsx`

**Interfaces:**
- Consumes: `RouteDaySuggesterModal` (Task 4), the existing `router` + `route.date`/`route.couriers` refresh pattern.

- [ ] **Step 1: Import the modal and add state**

In `client/src/components/route/route-client.tsx`, add the import near the other route-component imports (after line 27):

```ts
import { RouteDaySuggesterModal } from './route-day-suggester-modal';
import { Wand2 } from 'lucide-react';
```

(If `lucide-react` icons are all imported in the single block at the top (lines 5-16), add `Wand2` to that block instead of a second import statement.)

Add state near the other `useState` hooks in the component body:

```ts
  const [suggesterOpen, setSuggesterOpen] = useState(false);
```

- [ ] **Step 2: Add the toolbar button**

In the toolbar row (the `flex flex-wrap items-center gap-2` container starting at line 395), add a button after the couriers `<label>` block (after line 434, before the date `<label>`):

```tsx
          <Button variant="ghost" size="sm" onClick={() => setSuggesterOpen(true)}>
            <Wand2 size={15} /> Предложи по дни
          </Button>
```

(Confirm `Button` is imported in `route-client.tsx`; if not, add `import { Button } from '@/components/ui/button';`. If the file uses raw `<button>` elements instead, mirror the existing toolbar button styling with a `<button className="...">` using the same classes as the sibling help button.)

- [ ] **Step 3: Render the modal**

Near the bottom of the component's returned JSX (alongside other modals such as `EditAddressModal`/`ConfirmDialog`), add:

```tsx
      {suggesterOpen && (
        <RouteDaySuggesterModal
          onClose={() => setSuggesterOpen(false)}
          onApplied={() => {
            setSuggesterOpen(false);
            // Reload the route for the currently viewed day after the move.
            router.push(`/route?date=${route.date}&couriers=${route.couriers}`);
            router.refresh();
          }}
        />
      )}
```

(Use whichever refresh mechanism the file already uses after a mutation — grep the file for `router.refresh` / `router.push` usage and match it. The reschedule modal uses an `onDone` callback that reloads; mirror that pattern.)

- [ ] **Step 4: Verify in the browser**

Start the client dev server (preview_start) and open `/route`. Confirm:
- "Предложи по дни" button shows in the toolbar.
- Clicking opens the modal; adding two future dates + "Предложи" renders per-day blocks with a harvest line and order rows.
- Changing an order's day dropdown moves it between apply-groups; "Изключи" drops it.
- "Приложи" calls reschedule and the route reloads.

Take a screenshot for the user.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/route/route-client.tsx
git commit -m "feat(route-web): add day-suggester button to the route toolbar"
```

---

## Self-Review notes (coverage vs spec)

- **Extend `reschedulable()` coords** → Task 3 Step 1. ✅
- **Pure engine (reuse `sweepSplit`)** → Task 1. ✅
- **`POST /routing|orders/suggest-days` endpoint** → Task 3 (mounted on the `orders`-prefixed RoutingController, path `orders/suggest-days`, admin-scoped, tenant-isolated). ✅
- **Harvest summary shared helper (extract from digest)** → Task 2. ✅
- **Un-geocoded → manual bucket** → engine `unplaced` (Task 1) + amber bucket in modal (Task 4). ✅
- **Days pre-seed + free add** → modal day picker (Task 4). *Note:* v1 starts with an EMPTY day picker the farmer fills (no auto pre-seed from slot dates) to keep Task 4 self-contained; pre-seeding upcoming delivery days is a trivial follow-up (map distinct `listReschedulable()` slotDates into the initial `days` state) — flagged, not silently dropped.
- **Apply = per-day reschedule reuse** → modal `apply()` loops `rescheduleOrders` (Task 4). ✅
- **Display-only harvest** → engine ignores products; harvest only rendered. ✅
- **Placement in Маршрути** → Task 5. ✅
- **Deterministic engine** → Task 1 test. ✅

**Deviation from spec worth the user's eye:** the day picker in v1 is **not** pre-seeded with the farm's upcoming delivery days (starts empty). This trims Task 4's scope; pre-seeding is a small, isolated follow-up. If the user wants pre-seed in v1, add a step to Task 4 that calls `listReschedulable()` on mount and seeds `days` with its distinct `slotDate`s ≥ today.
