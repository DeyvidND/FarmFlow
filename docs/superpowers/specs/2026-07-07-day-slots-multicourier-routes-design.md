# Day-based delivery slots + multi-courier route splitting

**Date:** 2026-07-07
**Status:** Approved by operator
**Repos affected:** FarmFlow (server, client, storefront, packages/db), fermerski-pazar-chaika, FarmFlow-Templates

## Problem

Delivery slots today carry time windows (`time_from`/`time_to`, optionally split by
`slotMinutes`). Real operation is day-based: "Thursday = up to 40 deliveries", and the
driver runs one optimized loop. Time windows fight route optimization (the `slots`
order mode forces window order over shortest path) and add checkout friction.

With more than one courier there is no support at all: the route page always builds a
single route.

## Decisions (operator-confirmed)

1. **All couriers start from the farm** (single depot = existing farm origin). End
   mode stays the existing `home`/`last`/`custom`, applied to every courier.
2. **Couriers are just a count N** (1..10) picked on the route page — no courier
   entities, no names. Default persisted in `settings.routing.courierCount`.
3. **Capacity is per weekday** in the recurrence rule: Чт=40, Сб=20.

## 1. Data model — reuse `delivery_slots` as "delivery days"

No new table. Migration **0081** (hand-written, like 0079/0080):

- `time_from`, `time_to` become **nullable**. A day-row has NULL times; legacy rows
  keep their times as display-only history.
- Capacity clamp moves from [1,20] to **[1,500]** (`clampCapacity` in
  `server/src/modules/slots/slot-rule.ts`; DB has no check constraint today — none added).
- **Merge migration** for existing data, in the same 0081 file: for every
  `(tenant_id, date)` group with `date >= CURRENT_DATE` (BG day handled in SQL the
  same way existing migrations do — plain `CURRENT_DATE` is acceptable because the
  cutover deploy happens during the day, Sofia time):
  1. Canonical row = the group's earliest `time_from` row.
  2. `UPDATE orders SET slot_id = canonical WHERE slot_id IN (rest of group)`.
  3. Canonical row: `time_from = NULL, time_to = NULL`,
     `capacity = SUM(capacity of merged rows)`, `customer_note`/`driver_note` keep the
     canonical row's values.
  4. Delete the rest of the group.
  - Past dates (`date < CURRENT_DATE`) untouched.
  - This is what "преобрази поръчките на Фермерски пазари за четвъртък" means: their
    Thursday orders survive 1:1, repointed at the merged day-row, hours gone.

`orders.slot_id` semantics unchanged (FK ON DELETE SET NULL, live-order delete guard,
`lockAndCheckSlot` capacity check — all keep working; only the same-day backstop
message and returned fields lose time specifics).

## 2. Recurrence rule (`settings.slotRule`)

New shape (same storage location):

```ts
interface SlotDay { dow: number; capacity: number }      // windows gone
interface SlotRule {
  active: boolean;
  repeat: 'weekdays' | 'interval';
  days: SlotDay[];              // weekdays mode: per-day capacity
  intervalDays: number;
  intervalCapacity: number;     // interval mode: one capacity
  anchorDate: string;
  customerNote?: string;
  driverNote?: string;
  horizonDays: number;
  skipDates: string[];
  lastMaterializedDate?: string;
}
```

Removed: `slotMinutes`, per-day `timeFrom`/`timeTo`, `intervalWindow`,
`defaultCapacity` (replaced by per-day / interval capacity).

`migrateRule` upgrades stored rules of both older shapes:

- legacy global-window rule → per-day capacity = `defaultCapacity` (or 1).
- current windowed rule → per-day capacity = **(number of sub-slots the window
  produced under `slotMinutes`) × defaultCapacity** — honest equivalence, so a farm
  selling 8×5 slots on Thursday becomes Thursday=40.

Generator (`slotRuleSlots` + `materializeRule`) emits **one row per date** with the
day's capacity and NULL times. The existing diff key `date|from|to` becomes just
`date` for generated rows. skipDates / closeDay / openDay logic unchanged.

## 3. Checkout + storefronts

`PublicSlot` keeps its field set; `startTime`/`endTime` are `null` for day-rows (old
deployed storefront bundles render blanks rather than crash during the deploy window;
all storefronts are updated in the same rollout anyway).

Pickers become **day pickers** — chaika (`src/scripts/checkout-page.ts` + checkout.astro),
FarmFlow-Templates (same files), FarmFlow/storefront (`slot-picker.tsx`,
`checkout-client.tsx`):

- Option label: „четвъртък, 10 юли" (+ „остават N места" when `remaining != null`).
- `customerNote` display unchanged. Same-day cutoff unchanged (server already hides
  today). Confirmation pages: show date only when times are null.

Panel „Доставка" (`client/src/components/slots/*`):

- `RecurrenceCard`: weekday checkboxes each get a capacity input; time inputs and
  slot-length select removed. Interval mode: one capacity input.
- `AddSlotDialog` (one-off day): date + capacity + notes; no times.
- Slot list / `slot-pill`: shows date + booked/capacity (e.g. „12/40"), no hours.
- Orders panel + edit: slot pickers list days, not time windows; orders whose slot
  has NULL times render date only (legacy orders keep showing their stored times).

## 4. Routing — multi-courier (the core)

### API

`GET /routing/route?date=&end=&couriers=N` (N clamped 1..10; default =
`settings.routing.courierCount` ?? 1). Response:

```ts
interface MultiRouteResult {
  date: string;
  origin: RouteOrigin;
  end: RouteEnd;                 // shared by all couriers
  couriers: number;              // effective N used
  routes: CourierRoute[];        // length N (possibly fewer when stops < N)
}
interface CourierRoute {
  stops: RouteStop[];            // slotFrom/slotTo REMOVED from RouteStop
  totalDistanceM: number | null;
  totalDurationS: number | null;
  optimized: boolean;
  polyline: string[] | null;
}
```

`orderMode` (`slots`|`distance`) is **deleted** — always shortest path. Saving the
chosen N: `PATCH`/existing settings endpoint writes `settings.routing.courierCount`.

### Splitting algorithm (pure, unit-tested, in routing.service.ts style)

1. **Sweep partition:** sort geocoded stops by polar angle around the farm origin;
   cut the circle into N contiguous sectors.
2. **Balance by estimated workload**, not stop count: workload(sector) = haversine
   nearest-neighbour tour length from depot at ~30 km/h urban speed + 5 min service
   time per stop. Choose cut points minimizing max sector workload (stops stay
   angle-contiguous; O(stops × N) DP or greedy cut sliding — implementation detail
   for the plan, but must stay deterministic).
3. **Boundary improvement:** try moving each sector-edge stop to the adjacent sector;
   keep the move if max workload drops. Bounded iterations (e.g. 2 passes).
4. Per sector, run the **existing single-route pipeline**: Google Routes optimize
   (≤25 waypoints) + `greedyByDistance` tail + `pathTotal` totals/polylines, end
   point per shared end mode. N couriers = N independent Maps calls.
5. **Un-geocoded stops:** appended to the route with the smallest estimated
   workload, at the end of its stop list (they can't be positioned).
6. Edge cases: no farm origin → greedy split by round-robin after
   `greedyByDistance(null, …)` ordering, no Google; stops < N → fewer routes;
   N=1 → today's behaviour exactly.

### Route page UI (`client/src/components/route/*`)

- Courier count selector (1..10) next to the existing end-mode control; persists
  default via settings.
- Map: one colored polyline + numbered markers per courier (distinct palette),
  legend „Маршрут 1/2/…" with per-route km/min totals.
- Stop list: sectioned per courier; Waze stepper works per courier route.
- Slots|distance toggle removed.

## 5. Other surfaces showing slot times

Digest emails, dashboard summary, confirmation pages, order emails: wherever
`slotFrom`/`slotTo` were rendered → render date (+ „цял ден" nothing extra) when
times are NULL. Legacy orders with stored times keep rendering them. The
`scheduledForDay` day-keying logic is untouched (already date-based).

## 6. Explicitly out of scope

- Econt/Speedy courier orders, pickup flow, carrier comparison.
- Capacity locking mechanics (`lockAndCheckSlot` transaction pattern stays).
- Per-courier end addresses, courier identities/notifications.
- delivery-web / dostavki app (separate super-admin package — no slot times there).

## 7. Testing

- Unit: sweep partition + balancing + boundary improvement (fixture coords around a
  depot; assert contiguity, determinism, max-workload monotonicity), `migrateRule`
  both legacy shapes, generator one-row-per-day, `clampCapacity` new bounds.
- Adapt existing `slots.service.spec`, `slot-rule.spec`, `routing.helpers.spec`,
  `routing.adversarial.spec` to the new shapes; `orders.service` slot tests to NULL
  times.
- Migration 0081 dry-run against a seeded multi-slot day verifying: orders repointed,
  capacity summed, past dates untouched.
- E2E happy path: rule Чт=40 → materialize → public picker shows day → checkout books
  → route page splits 2 couriers.
