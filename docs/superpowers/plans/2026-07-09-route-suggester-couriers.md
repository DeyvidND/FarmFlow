# Route Suggester — Per-Day Couriers + Time/Reason Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the multi-day route suggester so each day carries its own courier count (more couriers → more orders that day), and each proposed route/day shows an estimated drive time + distance plus a short reason for the grouping.

**Architecture:** Two-level split. Day level: sort geocoded orders into a bearing sweep around the depot, then give each day (date order) a contiguous arc whose order **count** is proportional to its share of total couriers — a day with more couriers gets more orders, by construction. Within a day: `sweepSplit(depot, dayOrders, couriers[d])` cuts the arc into that day's courier routes (sweepSplit balances route workload, so it is used only inside a day, never for the count-weighted day allocation). A new pure `estimateRoute` helper gives per-route km + seconds; the assembly rolls these into per-day makespan/total-km + a templated compass reason. The DTO, service, client types/api, and modal are threaded through with the new `{date, couriers}[]` shape. Couriers are advisory (not persisted); apply still reschedules per day, unchanged.

**Tech Stack:** NestJS + Drizzle + class-validator (server), Jest (server tests), Next.js + React + Tailwind + vitest (client).

## Global Constraints

- **Capacity-weighted:** a day with more couriers must carry proportionally more orders.
- **Couriers advisory:** the per-courier split is preview only — never persisted; `/route` recomputes its own split later.
- **Apply unchanged:** applying still loops `rescheduleOrders(ids, date)` once per day over non-excluded orders; courier count never touches the move/notify path.
- **Determinism:** engine + assembly must be deterministic (no `Math.random`, no `Date.now`/`new Date`).
- **Reuse, not reinvention:** clustering reuses `sweepSplit`; route metrics reuse route-split internals (`nnOrder`/`twoOpt`/`pathKm`); harvest reuses `harvestSummary`; apply reuses `rescheduleOrders`.
- **No schema change, no migration.**
- **UI copy Bulgarian**, matching existing route tone.
- **couriers is an int 1..10 per day.**

---

### Task 1: `estimateRoute` route-metrics helper

**Files:**
- Modify: `server/src/modules/routing/route-split.ts`
- Test: `server/src/modules/routing/route-split.spec.ts` (add cases; file exists)

**Interfaces:**
- Produces: `export function estimateRoute(depot: Pt, stops: Pt[], endPt?: Pt | null): { km: number; seconds: number }`
- `estimateWorkloadS(depot, stops, endPt)` keeps its existing signature/return, now delegating to `estimateRoute`.

- [ ] **Step 1: Write the failing test**

Add to `server/src/modules/routing/route-split.spec.ts` (reuse its existing imports; add `estimateRoute` to the import from `./route-split`):

```ts
describe('estimateRoute', () => {
  const depot = { lat: 42.5, lng: 27.46 };
  it('returns zero km and seconds for no stops', () => {
    expect(estimateRoute(depot, [], depot)).toEqual({ km: 0, seconds: 0 });
  });
  it('gives positive km and seconds for real stops', () => {
    const r = estimateRoute(depot, [{ lat: 42.6, lng: 27.5 }, { lat: 42.55, lng: 27.48 }], depot);
    expect(r.km).toBeGreaterThan(0);
    expect(r.seconds).toBeGreaterThan(0);
  });
  it('is monotonic — a farther stop set costs more km', () => {
    const near = estimateRoute(depot, [{ lat: 42.51, lng: 27.47 }], depot);
    const far = estimateRoute(depot, [{ lat: 43.2, lng: 27.9 }], depot);
    expect(far.km).toBeGreaterThan(near.km);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest route-split --silent`
Expected: FAIL — `estimateRoute is not a function` / not exported.

- [ ] **Step 3: Implement `estimateRoute` and delegate `estimateWorkloadS`**

In `server/src/modules/routing/route-split.ts`, find the existing `estimateWorkloadS` (it currently does: guard empty → 0; `const ordered = twoOpt(depot, nnOrder(depot, stops), endPt); return kmToS(pathKm(depot, ordered, endPt)) + stops.length * SERVICE_S;`). Replace that function with:

```ts
/**
 * Estimated route metrics for `stops` served from `depot`, returning to `endPt`
 * after the last stop (null = one-way). Greedy NN order, 2-opt improved, at
 * urban speed + fixed service time per stop. Pure. `estimateWorkloadS` is the
 * seconds half of this — kept as a thin wrapper so existing callers are unchanged.
 */
export function estimateRoute(
  depot: Pt,
  stops: Pt[],
  endPt: Pt | null = null,
): { km: number; seconds: number } {
  if (!stops.length) return { km: 0, seconds: 0 };
  const ordered = twoOpt(depot, nnOrder(depot, stops), endPt);
  const km = pathKm(depot, ordered, endPt);
  return { km, seconds: kmToS(km) + stops.length * SERVICE_S };
}

export function estimateWorkloadS(depot: Pt, stops: Pt[], endPt: Pt | null = null): number {
  return estimateRoute(depot, stops, endPt).seconds;
}
```

(Do not touch `nnOrder`, `twoOpt`, `pathKm`, `kmToS`, `SERVICE_S` — they already exist at module scope in this file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx jest route-split --silent`
Expected: PASS — the new `estimateRoute` cases and all pre-existing `estimateWorkloadS`/`sweepSplit` cases green.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/routing/route-split.ts server/src/modules/routing/route-split.spec.ts
git commit -m "feat(routing): estimateRoute km+seconds helper; estimateWorkloadS delegates"
```

---

### Task 2: Two-level capacity-weighted day assignment

**Files:**
- Modify: `server/src/modules/routing/route-day-suggest.ts`
- Test: `server/src/modules/routing/route-day-suggest.spec.ts`

**Interfaces:**
- Consumes: `sweepSplit`, `haversineKm`, `Pt` from `./route-split`.
- Produces:
  - `export interface DaySpec { date: string; couriers: number }`
  - `export interface SuggestOrder { id: string; lat: number | null; lng: number | null }` (unchanged)
  - `export interface DayAssignment { assignment: Record<string, string[][]>; unplaced: string[] }` (assignment value is now **array of courier routes**, each an array of order ids)
  - `export function suggestDayAssignment(orders: SuggestOrder[], days: DaySpec[], depot: Pt | null): DayAssignment`

- [ ] **Step 1: Write the failing test**

Replace the body of `server/src/modules/routing/route-day-suggest.spec.ts` with (keeps the same fixtures, updates to the two-level shape + capacity):

```ts
import { suggestDayAssignment, type SuggestOrder } from './route-day-suggest';

const depot = { lat: 42.65, lng: 23.32 };
const north1: SuggestOrder = { id: 'n1', lat: 42.71, lng: 23.32 };
const north2: SuggestOrder = { id: 'n2', lat: 42.72, lng: 23.33 };
const north3: SuggestOrder = { id: 'n3', lat: 42.73, lng: 23.31 };
const south1: SuggestOrder = { id: 's1', lat: 42.58, lng: 23.32 };
const south2: SuggestOrder = { id: 's2', lat: 42.57, lng: 23.33 };
const south3: SuggestOrder = { id: 's3', lat: 42.56, lng: 23.31 };

const dayIds = (routes: string[][]) => routes.flat();

describe('suggestDayAssignment (per-day couriers)', () => {
  it('gives a day with more couriers more orders (capacity-weighted)', () => {
    const orders = [north1, north2, north3, south1, south2, south3];
    const { assignment } = suggestDayAssignment(
      orders,
      [{ date: '2026-07-10', couriers: 2 }, { date: '2026-07-11', couriers: 1 }],
      depot,
    );
    const d1 = dayIds(assignment['2026-07-10']);
    const d2 = dayIds(assignment['2026-07-11']);
    expect(d1.length + d2.length).toBe(6);
    expect(d1.length).toBeGreaterThan(d2.length); // 2 couriers > 1 courier share
  });

  it('never gives a day more routes than its courier count', () => {
    const orders = [north1, north2, north3, south1, south2, south3];
    const { assignment } = suggestDayAssignment(
      orders,
      [{ date: '2026-07-10', couriers: 2 }, { date: '2026-07-11', couriers: 1 }],
      depot,
    );
    expect(assignment['2026-07-10'].length).toBeLessThanOrEqual(2);
    expect(assignment['2026-07-11'].length).toBeLessThanOrEqual(1);
  });

  it('routes un-geocoded orders to unplaced, never onto a day', () => {
    const { assignment, unplaced } = suggestDayAssignment(
      [north1, { id: 'x', lat: null, lng: null }],
      [{ date: '2026-07-10', couriers: 1 }],
      depot,
    );
    expect(unplaced).toEqual(['x']);
    expect(dayIds(assignment['2026-07-10'])).toEqual(['n1']);
  });

  it('each assignment value is an array of routes (string[][])', () => {
    const { assignment } = suggestDayAssignment(
      [north1, south1],
      [{ date: '2026-07-10', couriers: 1 }],
      depot,
    );
    expect(Array.isArray(assignment['2026-07-10'])).toBe(true);
    expect(Array.isArray(assignment['2026-07-10'][0])).toBe(true);
  });

  it('is deterministic', () => {
    const orders = [north1, south1, north2, south2];
    const days = [{ date: '2026-07-10', couriers: 1 }, { date: '2026-07-11', couriers: 1 }];
    expect(suggestDayAssignment(orders, days, depot)).toEqual(
      suggestDayAssignment(orders, days, depot),
    );
  });

  it('puts all located orders in unplaced when no days are given', () => {
    const { assignment, unplaced } = suggestDayAssignment([north1, south1], [], depot);
    expect(assignment).toEqual({});
    expect(unplaced.sort()).toEqual(['n1', 's1']);
  });

  it('empty days keys present with no routes when there are no located orders', () => {
    const { assignment, unplaced } = suggestDayAssignment(
      [{ id: 'x', lat: null, lng: null }],
      [{ date: '2026-07-10', couriers: 2 }],
      depot,
    );
    expect(assignment).toEqual({ '2026-07-10': [] });
    expect(unplaced).toEqual(['x']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest route-day-suggest --silent`
Expected: FAIL — signature/return shape mismatch (days is now objects; assignment is string[][]).

- [ ] **Step 3: Rewrite the engine (Approach A)**

Replace `server/src/modules/routing/route-day-suggest.ts` entirely with:

```ts
import { sweepSplit, haversineKm, type Pt } from './route-split';

/** One order the suggester may place, with its (possibly missing) coords. */
export interface SuggestOrder {
  id: string;
  lat: number | null;
  lng: number | null;
}

/** A chosen delivery day and how many couriers run it. */
export interface DaySpec {
  date: string;
  /** Couriers for this day (int ≥ 1). More couriers ⇒ more orders that day. */
  couriers: number;
}

/** Result: per day, a list of courier routes (each a list of order ids); plus
 *  the un-geocoded ids we could not place. */
export interface DayAssignment {
  assignment: Record<string, string[][]>;
  unplaced: string[];
}

type Located = { id: string; lat: number; lng: number };

/** Mean lat/lng of the located orders — a stand-in depot when the farm has none. */
function centroid(pts: Located[]): Pt {
  const s = pts.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), { lat: 0, lng: 0 });
  return { lat: s.lat / pts.length, lng: s.lng / pts.length };
}

const capOf = (d: DaySpec) => Math.max(1, Math.floor(d.couriers));

/**
 * Geography-first, capacity-weighted assignment. Sorts the geocoded orders into a
 * bearing sweep around the depot, then hands each day (in date order) a CONTIGUOUS
 * arc whose order COUNT is proportional to its share of the total couriers — so a
 * day with more couriers gets more orders, by construction (not as an emergent
 * side effect). Each day's arc is then cut into that day's courier routes via
 * `sweepSplit` (used only WITHIN a day, since it balances route workload, not
 * count). Un-geocoded orders go to `unplaced`. Pure & deterministic.
 */
export function suggestDayAssignment(
  orders: SuggestOrder[],
  days: DaySpec[],
  depot: Pt | null,
): DayAssignment {
  const sortedDays = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const assignment: Record<string, string[][]> = {};
  for (const d of sortedDays) assignment[d.date] = [];

  const located: Located[] = orders
    .filter((o): o is Located => o.lat != null && o.lng != null)
    .map((o) => ({ id: o.id, lat: o.lat as number, lng: o.lng as number }));
  const unplaced = orders.filter((o) => o.lat == null || o.lng == null).map((o) => o.id);

  if (sortedDays.length === 0) {
    return { assignment: {}, unplaced: orders.map((o) => o.id) };
  }
  if (located.length === 0) {
    return { assignment, unplaced };
  }

  const depotPt: Pt = depot ?? centroid(located);
  const K = sortedDays.reduce((n, d) => n + capOf(d), 0);

  // Day-level split FIRST, capacity-weighted by order COUNT. Sort all located
  // orders into a bearing sweep around the depot; then give each day (date order)
  // a contiguous arc sized to its courier share. A running cumulative-courier
  // boundary (`round((cum/K) * total)`) yields an exact partition — no gap, no
  // overlap, last day ends at `total` — and guarantees a day with more couriers
  // gets more orders. `sweepSplit` balances by workload (drive time), NOT count,
  // so it is used only WITHIN each day to cut the arc into that day's routes.
  const swept = [...located].sort(
    (a, b) =>
      Math.atan2(a.lat - depotPt.lat, a.lng - depotPt.lng) -
        Math.atan2(b.lat - depotPt.lat, b.lng - depotPt.lng) ||
      haversineKm(depotPt, a) - haversineKm(depotPt, b) ||
      a.id.localeCompare(b.id),
  );

  const total = swept.length;
  let cum = 0;
  let start = 0;
  for (const d of sortedDays) {
    cum += capOf(d);
    const end = Math.round((cum / K) * total);
    const dayOrders = swept.slice(start, end);
    start = end;
    const routes = dayOrders.length ? sweepSplit(depotPt, dayOrders, capOf(d), depotPt) : [];
    assignment[d.date] = routes.map((g) => g.map((s) => s.id));
  }

  return { assignment, unplaced };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx jest route-day-suggest --silent`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/routing/route-day-suggest.ts server/src/modules/routing/route-day-suggest.spec.ts
git commit -m "feat(routing): two-level capacity-weighted day assignment (couriers per day)"
```

---

### Task 3: Assembly — routes, time, km, reason

**Files:**
- Modify: `server/src/modules/routing/route-day-assemble.ts`
- Test: `server/src/modules/routing/route-day-assemble.spec.ts`

**Interfaces:**
- Consumes: `suggestDayAssignment` + `DaySpec` (Task 2), `estimateRoute` (Task 1), `harvestSummary`/`HarvestLine`, `haversineKm`/`Pt`, `ReschedulableOrder`.
- Produces (result types — re-exported from routing.service.ts already):
  - `RouteEstimate { stops: SuggestedDayOrder[]; km: number; driveMinutes: number }`
  - `SuggestedDay { date: string; couriers: number; routes: RouteEstimate[]; driveMinutesMakespan: number; totalKm: number; harvest: HarvestLine[]; reason: string }`
  - `SuggestedDayOrder` / `UnplacedOrder` / `DaySuggestionResult` (DaySuggestionResult unchanged in shape: `{ days: SuggestedDay[]; unplaced: UnplacedOrder[] }`)
  - `export function assembleDaySuggestion(pool: ReschedulableOrder[], itemsByOrder: Map<string, {productName: string|null; quantity: number}[]>, depot: Pt | null, days: DaySpec[]): DaySuggestionResult`

- [ ] **Step 1: Write the failing test**

Replace `server/src/modules/routing/route-day-assemble.spec.ts` with:

```ts
import { assembleDaySuggestion } from './route-day-assemble';
import type { ReschedulableOrder } from '../orders/orders.service';

const depot = { lat: 42.65, lng: 23.32 };
const mk = (
  id: string,
  lat: number | null,
  lng: number | null,
  overrides: Partial<ReschedulableOrder> = {},
): ReschedulableOrder => ({
  id,
  orderNumber: Number(id.replace(/\D/g, '')) || null,
  customerName: `C${id}`,
  customerPhone: null,
  totalStotinki: 1000,
  status: 'confirmed',
  slotDate: '2026-07-10',
  deliveryLat: lat == null ? null : String(lat),
  deliveryLng: lng == null ? null : String(lng),
  ...overrides,
});

describe('assembleDaySuggestion (couriers + time + reason)', () => {
  it('echoes the requested courier count even when there are fewer routes', () => {
    const pool = [mk('1', 42.71, 23.32)];
    const res = assembleDaySuggestion(pool, new Map(), depot, [{ date: '2026-07-10', couriers: 3 }]);
    const day = res.days.find((d) => d.date === '2026-07-10')!;
    expect(day.couriers).toBe(3);
    expect(day.routes.length).toBeLessThanOrEqual(3);
    expect(day.routes.length).toBeGreaterThanOrEqual(1);
  });

  it('populates per-route km + driveMinutes and rolls up makespan + totalKm', () => {
    const pool = [mk('1', 42.71, 23.32), mk('2', 42.72, 23.33)];
    const res = assembleDaySuggestion(pool, new Map(), depot, [{ date: '2026-07-10', couriers: 1 }]);
    const day = res.days[0];
    expect(day.routes[0].km).toBeGreaterThan(0);
    expect(day.routes[0].driveMinutes).toBeGreaterThan(0);
    expect(day.driveMinutesMakespan).toBe(Math.max(...day.routes.map((r) => r.driveMinutes)));
    expect(day.totalKm).toBeCloseTo(Math.round(day.routes.reduce((s, r) => s + r.km, 0) * 10) / 10, 5);
  });

  it('gives a non-empty reason with a compass region when a depot exists', () => {
    const pool = [mk('1', 42.85, 23.32)]; // due north of depot
    const res = assembleDaySuggestion(pool, new Map(), depot, [{ date: '2026-07-10', couriers: 1 }]);
    expect(res.days[0].reason).toContain('север');
  });

  it('falls back to zeros + generic reason when the farm has no depot', () => {
    const pool = [mk('1', 42.71, 23.32)];
    const res = assembleDaySuggestion(pool, new Map(), null, [{ date: '2026-07-10', couriers: 1 }]);
    const day = res.days[0];
    expect(day.totalKm).toBe(0);
    expect(day.driveMinutesMakespan).toBe(0);
    expect(day.reason).toBe('Съседни клиенти заедно — по-малко километри');
  });

  it('merges the day harvest across all its routes and maps un-geocoded to unplaced', () => {
    const pool = [mk('1', 42.71, 23.32), mk('2', 42.72, 23.33), mk('9', null, null)];
    const items = new Map<string, { productName: string | null; quantity: number }[]>([
      ['1', [{ productName: 'Кайсии', quantity: 2 }]],
      ['2', [{ productName: 'Кайсии', quantity: 3 }]],
    ]);
    const res = assembleDaySuggestion(pool, items, depot, [{ date: '2026-07-10', couriers: 1 }]);
    expect(res.days[0].harvest).toEqual([{ productName: 'Кайсии', quantity: 5 }]);
    expect(res.unplaced.map((o) => o.id)).toEqual(['9']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest route-day-assemble --silent`
Expected: FAIL — `couriers`/`routes`/`reason` absent; signature mismatch (days shape).

- [ ] **Step 3: Rewrite the assembly**

Replace `server/src/modules/routing/route-day-assemble.ts` with:

```ts
import type { ReschedulableOrder } from '../orders/orders.service';
import { estimateRoute, type Pt } from './route-split';
import { suggestDayAssignment, type DaySpec } from './route-day-suggest';
import { harvestSummary, type HarvestLine } from '../orders/harvest-summary';

export interface SuggestedDayOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  lat: number | null;
  lng: number | null;
  totalStotinki: number;
}
/** One courier's route within a day: its stops + estimated distance/drive time. */
export interface RouteEstimate {
  stops: SuggestedDayOrder[];
  km: number;
  driveMinutes: number;
}
export interface SuggestedDay {
  date: string;
  /** Requested courier count for the day (may exceed routes.length if few orders). */
  couriers: number;
  routes: RouteEstimate[];
  /** The day is done when the slowest courier is — max route driveMinutes. */
  driveMinutesMakespan: number;
  totalKm: number;
  harvest: HarvestLine[];
  reason: string;
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

const toNum = (v: string | null): number | null => (v == null ? null : Number(v));
const round1 = (n: number) => Math.round(n * 10) / 10;

/** 8-point compass in Bulgarian, indexed by `round(bearing / (π/4))` normalised
 *  to 0..7 where 0 = изток (east, +lng) and π/2 = север (north, +lat). */
const COMPASS_BG = ['изток', 'североизток', 'север', 'северозапад', 'запад', 'югозапад', 'юг', 'югоизток'];

/** A short human reason for a day's grouping: region (compass from the depot) +
 *  the proximity rationale. Generic fallback when there is no depot or no stops. */
function dayReason(depot: Pt | null, stops: { lat: number; lng: number }[]): string {
  if (!depot || stops.length === 0) return 'Съседни клиенти заедно — по-малко километри';
  const mean = stops.reduce((a, s) => ({ lat: a.lat + s.lat, lng: a.lng + s.lng }), { lat: 0, lng: 0 });
  const c = { lat: mean.lat / stops.length, lng: mean.lng / stops.length };
  const bearing = Math.atan2(c.lat - depot.lat, c.lng - depot.lng);
  const idx = (((Math.round(bearing / (Math.PI / 4)) % 8) + 8) % 8);
  return `Съседни клиенти в един район (${COMPASS_BG[idx]}) — най-малко каране`;
}

/**
 * Pure in-memory assembly of a day suggestion: capacity-weighted geography-first
 * day assignment (via {@link suggestDayAssignment}) plus, per day, its courier
 * routes with estimated distance/drive time (via {@link estimateRoute}), the
 * makespan + total km rollup, the harvest readout, a short reason, and the
 * un-geocoded → `unplaced` mapping. No DB — unit-testable without a database.
 */
export function assembleDaySuggestion(
  pool: ReschedulableOrder[],
  itemsByOrder: Map<string, { productName: string | null; quantity: number }[]>,
  depot: Pt | null,
  days: DaySpec[],
): DaySuggestionResult {
  const { assignment, unplaced } = suggestDayAssignment(
    pool.map((o) => ({ id: o.id, lat: toNum(o.deliveryLat), lng: toNum(o.deliveryLng) })),
    days,
    depot,
  );

  const byId = new Map(pool.map((o) => [o.id, o]));
  const capByDate = new Map(days.map((d) => [d.date, Math.max(1, Math.floor(d.couriers))]));

  const toStop = (o: ReschedulableOrder): SuggestedDayOrder => ({
    id: o.id,
    orderNumber: o.orderNumber,
    customerName: o.customerName,
    lat: toNum(o.deliveryLat),
    lng: toNum(o.deliveryLng),
    totalStotinki: o.totalStotinki,
  });

  const daysOut: SuggestedDay[] = Object.entries(assignment).map(([date, routeIdLists]) => {
    const routes: RouteEstimate[] = routeIdLists.map((ids) => {
      const stops = ids.map((id) => byId.get(id)!).filter(Boolean).map(toStop);
      const pts = stops
        .filter((s) => s.lat != null && s.lng != null)
        .map((s) => ({ lat: s.lat as number, lng: s.lng as number }));
      const est = depot != null ? estimateRoute(depot, pts, depot) : { km: 0, seconds: 0 };
      return { stops, km: round1(est.km), driveMinutes: Math.round(est.seconds / 60) };
    });

    const dayItems = routeIdLists.flat().flatMap((id) => itemsByOrder.get(id) ?? []);
    const allPts = routes
      .flatMap((r) => r.stops)
      .filter((s) => s.lat != null && s.lng != null)
      .map((s) => ({ lat: s.lat as number, lng: s.lng as number }));

    return {
      date,
      couriers: capByDate.get(date) ?? routes.length,
      routes,
      driveMinutesMakespan: routes.reduce((m, r) => Math.max(m, r.driveMinutes), 0),
      totalKm: round1(routes.reduce((s, r) => s + r.km, 0)),
      harvest: harvestSummary(dayItems),
      reason: dayReason(depot, allPts),
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx jest route-day-assemble --silent`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/routing/route-day-assemble.ts server/src/modules/routing/route-day-assemble.spec.ts
git commit -m "feat(routing): per-day courier routes with drive time, km, and reason"
```

---

### Task 4: DTO per-day couriers + service + controller + endpoint spec

**Files:**
- Modify: `server/src/modules/routing/dto/suggest-days.dto.ts`
- Modify: `server/src/modules/routing/routing.service.ts` (`suggestDays` signature: `days` shape)
- Modify: `server/src/modules/routing/routing.controller.ts` (passes `dto.days` — likely unchanged, verify)
- Test: `server/src/modules/routing/routing.suggest-controller.spec.ts`

**Interfaces:**
- Consumes: `assembleDaySuggestion(pool, itemsByOrder, depot, days: DaySpec[])` (Task 3).
- Produces: `RoutingService.suggestDays(tenantId: string, days: { date: string; couriers: number }[]): Promise<DaySuggestionResult>`.

- [ ] **Step 1: Rewrite the DTO**

Replace `server/src/modules/routing/dto/suggest-days.dto.ts` with:

```ts
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, Matches, Max, Min, ValidateNested } from 'class-validator';

export class SuggestDayDto {
  /** Delivery day (YYYY-MM-DD). */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date трябва да е YYYY-MM-DD' })
  date!: string;

  /** Couriers running this day (1..10). */
  @IsInt()
  @Min(1)
  @Max(10)
  couriers!: number;
}

export class SuggestDaysDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(14)
  @ValidateNested({ each: true })
  @Type(() => SuggestDayDto)
  days!: SuggestDayDto[];
}
```

- [ ] **Step 2: Update `RoutingService.suggestDays` signature**

In `server/src/modules/routing/routing.service.ts`, change the `suggestDays` method signature and the call to `assembleDaySuggestion`. Find:

```ts
  async suggestDays(tenantId: string, days: string[]): Promise<DaySuggestionResult> {
```
change to:
```ts
  async suggestDays(
    tenantId: string,
    days: { date: string; couriers: number }[],
  ): Promise<DaySuggestionResult> {
```
Then find the `assembleDaySuggestion(...)` call inside it and confirm the final argument passes `days` through unchanged (the pool/itemsByOrder/depot reads are untouched — `days` is now the object array the assembly expects). If the current code does `suggestDayAssignment(...)` directly here, it does not — assembly owns that; only the `assembleDaySuggestion(pool, itemsByOrder, depot, days)` call needs `days` to be the new shape, which it now is. No other change in this method.

- [ ] **Step 3: Verify the controller passes `dto.days`**

Open `server/src/modules/routing/routing.controller.ts`. The `suggestDays` route should already be `return this.routingService.suggestDays(tenantId, dto.days);`. `dto.days` is now `SuggestDayDto[]` which is structurally `{date, couriers}[]` — matches. No change needed unless it destructures differently; if so, make it pass `dto.days` as-is.

- [ ] **Step 4: Update the controller/service delegation test**

Replace `server/src/modules/routing/routing.suggest-controller.spec.ts` with:

```ts
import { RoutingController } from './routing.controller';

describe('RoutingController suggest-days', () => {
  it('delegates to the service with the tenant id and the per-day couriers dto', async () => {
    const service = { suggestDays: jest.fn().mockResolvedValue({ days: [], unplaced: [] }) };
    const c = new RoutingController(service as any);
    const days = [
      { date: '2026-07-10', couriers: 2 },
      { date: '2026-07-11', couriers: 1 },
    ];
    await c.suggestDays('t1', { days } as any);
    expect(service.suggestDays).toHaveBeenCalledWith('t1', days);
  });
});
```

- [ ] **Step 5: Run tests + type-check**

Run: `cd server && npx jest routing route-day-assemble route-day-suggest route-split --silent`
Expected: PASS (all routing suites, incl. the updated delegation test).
Run: `cd server && npx tsc --noEmit`
Expected: no errors (proves the `days` shape threads through service + assembly + engine).

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/routing/dto/suggest-days.dto.ts server/src/modules/routing/routing.service.ts server/src/modules/routing/routing.controller.ts server/src/modules/routing/routing.suggest-controller.spec.ts
git commit -m "feat(routing): suggest-days DTO + service accept per-day courier counts"
```

---

### Task 5: Client — per-day courier input + routes/time/reason rendering

**Files:**
- Modify: `client/src/lib/types.ts`
- Modify: `client/src/lib/api-client.ts`
- Modify: `client/src/components/route/route-day-suggester-modal.tsx`

**Interfaces:**
- Consumes: server response contract from Tasks 3-4 (`SuggestedDay` now has `couriers`, `routes: RouteEstimate[]`, `driveMinutesMakespan`, `totalKm`, `reason`).
- Produces: `suggestDays(days: { date: string; couriers: number }[]): Promise<DaySuggestionResult>`.

- [ ] **Step 1: Update client types**

In `client/src/lib/types.ts`, find the existing `SuggestedDay` block (added earlier: `date`, `orders`, `harvest`, `spreadKm`) and replace the `SuggestedDay` interface + add `RouteEstimate`:

```ts
export interface RouteEstimate {
  stops: SuggestedDayOrder[];
  km: number;
  driveMinutes: number;
}
export interface SuggestedDay {
  date: string;
  couriers: number;
  routes: RouteEstimate[];
  driveMinutesMakespan: number;
  totalKm: number;
  harvest: HarvestLine[];
  reason: string;
}
```
Leave `SuggestedDayOrder`, `UnplacedOrder`, `DaySuggestionResult`, `HarvestLine` as they are (remove the now-gone `orders`/`spreadKm` fields only from `SuggestedDay`).

- [ ] **Step 2: Update the api-client function**

In `client/src/lib/api-client.ts`, change `suggestDays` to take the new shape:

```ts
/** Geography-first proposal: spread pending address orders across the given days,
 *  each with its own courier count. */
export const suggestDays = (days: { date: string; couriers: number }[]) =>
  apiFetch<DaySuggestionResult>(
    'orders/suggest-days',
    { method: 'POST', ...json({ days }) },
    'Неуспешно предложение за разпределение',
  );
```

- [ ] **Step 3: Update the modal — per-day couriers input + routes rendering**

In `client/src/components/route/route-day-suggester-modal.tsx`:

(a) Change the day state to carry couriers. Replace the `days: string[]` state with a map of date → couriers. Find `const [days, setDays] = useState<string[]>([]);` and replace with:

```ts
  // date → courier count (default 1). The picker order is the sorted dates.
  const [dayCouriers, setDayCouriers] = useState<Record<string, number>>({});
  const days = Object.keys(dayCouriers).sort();
```

(b) Update `addDay`, `removeDay`, and the pre-seed effect to use the map:

```ts
  const addDay = () => {
    if (newDay && dayCouriers[newDay] == null) setDayCouriers((m) => ({ ...m, [newDay]: 1 }));
    setNewDay('');
  };
  const removeDay = (d: string) => {
    setDayCouriers((m) => {
      const next = { ...m };
      delete next[d];
      return next;
    });
    // Any orders assigned to the removed day become excluded (unchanged intent).
    setChoices((c) => {
      const next: Record<string, Choice> = {};
      for (const [id, choice] of Object.entries(c)) next[id] = choice.day === d ? { day: null } : choice;
      return next;
    });
  };
  const setCouriers = (d: string, n: number) =>
    setDayCouriers((m) => ({ ...m, [d]: Math.min(10, Math.max(1, n)) }));
```

Pre-seed effect — seed each distinct slotDate with 1 courier:

```ts
  useEffect(() => {
    listReschedulable()
      .then((rows) => {
        const seeded: Record<string, number> = {};
        for (const d of [...new Set(rows.map((r) => r.slotDate))].sort()) seeded[d] = 1;
        setDayCouriers(seeded);
      })
      .catch(() => {
        /* non-fatal — farmer can add days by hand */
      });
  }, []);
```

(c) `propose()` sends the new shape. Find the `suggestDays(days)` call and replace with:

```ts
      const res = await suggestDays(days.map((d) => ({ date: d, couriers: dayCouriers[d] ?? 1 })));
```

(d) Day-picker chip rendering — add a small couriers number input beside each chip. Find where the day chips render (the `days.map((d) => ...)` producing a chip with a remove `X`) and replace the chip body with:

```tsx
            {days.map((d) => (
              <span
                key={d}
                className="inline-flex items-center gap-1.5 rounded-lg bg-ff-green-100 px-2.5 py-1 text-[13px] font-bold text-ff-green-800"
              >
                {relDayLabel(d)}
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={dayCouriers[d] ?? 1}
                  onChange={(e) => setCouriers(d, parseInt(e.target.value, 10) || 1)}
                  title="Брой куриери за деня"
                  aria-label={`Куриери за ${relDayLabel(d)}`}
                  className="w-11 rounded-md border border-ff-green-300 bg-ff-surface px-1 py-0.5 text-center text-[12.5px] font-bold text-ff-ink outline-none"
                />
                <span className="text-[11px] font-semibold text-ff-green-700">куриери</span>
                <button onClick={() => removeDay(d)} aria-label={`Махни ${d}`}>
                  <X size={13} />
                </button>
              </span>
            ))}
```

(e) Per-day result rendering — show couriers · makespan · totalKm + reason, then one sub-block per route. Find the result day block (currently renders `day.orders` + `day.harvest` + `spreadKm`) and replace the day container's inner content with:

```tsx
                <div className="flex items-center justify-between border-b border-ff-border-2 bg-ff-surface-2 px-3 py-2">
                  <span className="text-[14px] font-extrabold capitalize text-ff-ink">
                    {relDayLabel(day.date)} · {day.couriers} куриера
                  </span>
                  <span className="text-[12px] font-semibold text-ff-muted">
                    ~{day.driveMinutesMakespan} мин · {day.totalKm} км
                  </span>
                </div>
                <p className="border-b border-ff-border-2 px-3 py-1.5 text-[12px] italic text-ff-muted">
                  {day.reason}
                </p>
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
                {day.routes.map((route, ri) => (
                  <div key={ri}>
                    <div className="flex items-center justify-between bg-ff-surface px-3 py-1.5 text-[12px] font-bold text-ff-ink-2">
                      <span>Маршрут {ri + 1} · {route.stops.length} спирки</span>
                      <span className="text-ff-muted">{route.km} км · ~{route.driveMinutes} мин</span>
                    </div>
                    {route.stops.map(orderRow)}
                  </div>
                ))}
```

(This assumes the existing `orderRow(o: SuggestedDayOrder)` render helper — keep it; the per-order `<select>` inside it still uses `days` (now the sorted date list), which continues to work.)

- [ ] **Step 4: Type-check + lint**

Run: `cd client && npx tsc --noEmit`
Expected: no errors.
Run: `cd client && npx eslint src/lib/types.ts src/lib/api-client.ts src/components/route/route-day-suggester-modal.tsx`
Expected: clean. (Confirm `orderRow`, `choices`/`Choice`, `setChoices`, `relDayLabel`, `Sprout`, `X` are all still imported/defined — they were in the shipped modal; fix any now-unused import such as a dropped `moneyFromStotinki` only if it truly becomes unused.)

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/api-client.ts client/src/components/route/route-day-suggester-modal.tsx
git commit -m "feat(route-web): per-day courier input + route time/km/reason in the suggester"
```

---

## Self-Review notes (coverage vs spec)

- **Per-day couriers in DTO** → Task 4. ✅
- **Capacity-weighted split (Approach A, K=Σcouriers, bearing arcs)** → Task 2. ✅
- **estimateRoute km+seconds, estimateWorkloadS delegates** → Task 1. ✅
- **Per-route km/driveMinutes, per-day makespan+totalKm+reason** → Task 3. ✅
- **Reason = compass region + proximity, fallback when no depot** → Task 3 (`dayReason`). ✅
- **Couriers advisory / apply unchanged** → Task 5 keeps `apply()` grouping by day; no reschedule change. ✅
- **Client per-day courier input + routes rendering** → Task 5. ✅
- **Determinism, no schema change** → engine/assembly pure; no migration in any task. ✅
- **Two-level output `Record<date, string[][]>`** → Task 2 return type, consumed in Task 3. ✅

Type consistency: `DaySpec {date,couriers}` (Task 2) is the shape used by `assembleDaySuggestion` (Task 3), `suggestDays` service (Task 4), and the client `suggestDays` arg (Task 5) — all `{date, couriers}`. `RouteEstimate`/`SuggestedDay` identical in server (Task 3) and client (Task 5). `estimateRoute` return `{km, seconds}` (Task 1) consumed in Task 3.
