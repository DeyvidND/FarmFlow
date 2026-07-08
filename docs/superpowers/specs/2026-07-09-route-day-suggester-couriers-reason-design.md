# Route day-suggester — per-day couriers + time/reason

**Date:** 2026-07-09
**Status:** Approved design — ready for implementation plan
**Branch:** main → new feature branch

## Problem

The shipped multi-day suggester (`POST /orders/suggest-days`, merged `ad25c0e`) has two gaps the operator flagged:

1. **No per-day courier count.** It implicitly assumes one courier (one route) per day. A real plan needs a **separate courier count per day** — e.g. 3 couriers Thursday, 1 Friday — and a day with more couriers should carry **proportionally more orders**.
2. **No justification.** It shows a split but never says *why* it's good or how long it takes. Each route/day needs an **estimated drive time + distance**, and a short **reason** for the grouping.

## Decisions (locked with the operator)

- **Capacity-weighted:** more couriers on a day → more orders on that day. (Not just sub-splitting a fixed share.)
- **Justification depth:** per-route drive time + km, per-day makespan time + total km, plus a **short human reason string** (region + "grouped by proximity"). **No** baseline/"saved vs X" comparison in v1.
- **Approach A** (below): a single `sweepSplit` at `K = Σ couriers`, then bin the K balanced groups into days by geography + capacity.
- **Couriers are advisory:** the per-courier split is a planning **preview**. It is **not** persisted. Applying still moves orders per **day** (via the existing `rescheduleOrders`); when the farmer later opens that day in `/route` with N couriers, the route view recomputes the split itself.
- **Apply is unchanged:** still one `rescheduleOrders(ids, date)` per day over non-excluded orders. Courier count never touches the move/notify path.
- **No schema change. No migration.**

## Approach A — one split, bin to days

1. `located` = geocoded pool orders. `K = Σ days[].couriers`.
2. `groups = sweepSplit(depot, located, K, depot)` — K balanced (equal-workload) geographic groups. Each group ≈ one courier's route. (`sweepSplit` already does sweep + k-means + radial seeds + makespan local search, deterministic; reused, not reimplemented.)
3. Sort the K groups by **bearing** around the depot (`atan2` of each group's centroid), tie-break by distance then a stable key.
4. Walk the sorted groups and fill days **in date order**, each day taking `couriers[d]` groups before advancing. Each day thus gets a **contiguous bearing arc** (a coherent region), and a day with more couriers grabs more consecutive groups → more orders (capacity weighting falls out for free, because the groups are equal-workload).
5. Fewer groups than `K` (few orders): later courier slots simply get no group (idle courier). Un-geocoded orders → `unplaced`, never placed.

Deterministic throughout (no `Math.random`, no wall-clock).

## Architecture

### DTO (breaking, but endpoint not yet deployed and only our client calls it)

`server/src/modules/routing/dto/suggest-days.dto.ts`:

```
class SuggestDayDto { date: string /* YYYY-MM-DD */; couriers: number /* int 1..10 */ }
class SuggestDaysDto { days: SuggestDayDto[] /* ArrayMinSize 1, ArrayMaxSize 14 */ }
```

Validate each element (`@ValidateNested({each:true})` + `@Type(() => SuggestDayDto)`, `@IsInt`/`@Min(1)`/`@Max(10)` on `couriers`, `@Matches(YYYY-MM-DD)` on `date`).

### Pure engine (`route-day-suggest.ts`)

`suggestDayAssignment(orders, days, depot)` signature changes:
- `days: { date: string; couriers: number }[]`
- returns `{ assignment: Record<string, string[][]>, unplaced: string[] }` — **two levels**: `assignment[date]` is an array of **courier routes**, each an array of order ids. A day with no groups → `[]`.
- Implements Approach A. Keeps the existing centroid-fallback-when-no-depot behavior.

### Route metrics helper (`route-split.ts`, new export)

```
estimateRoute(depot: Pt, stops: Pt[], endPt: Pt | null): { km: number; seconds: number }
```
Reuses the existing internal `nnOrder` + `twoOpt` + `pathKm` (one 2-opt pass, not two). `seconds` = `kmToS(km) + stops.length * SERVICE_S` (identical basis to `estimateWorkloadS`, which can delegate to this to stay DRY). Pure, unit-tested.

### Assembly (`route-day-assemble.ts`)

New response types:
```
RouteEstimate { stops: SuggestedDayOrder[]; km: number; driveMinutes: number }
SuggestedDay {
  date: string;
  couriers: number;
  routes: RouteEstimate[];
  driveMinutesMakespan: number;   // max route driveMinutes (day is done when the slowest courier is)
  totalKm: number;                // sum of route km
  harvest: HarvestLine[];         // per-day, unchanged
  reason: string;                 // short BG string, region + proximity
}
DaySuggestionResult { days: SuggestedDay[]; unplaced: UnplacedOrder[] }
```
- Per route: `estimateRoute(depot, routeStops, depot)` (round-trip `home` default, matching the route view) → `km`, `driveMinutes = round(seconds/60)`. When `depot == null`, km/minutes are `0` (ungeocoded farm — advisory hint only).
- `driveMinutesMakespan = max(routes.driveMinutes)`, `totalKm = round(Σ km)`.
- `couriers` echoes the requested count for the day (may exceed `routes.length` when there were too few orders).
- `reason`: derive the day's mean bearing from the depot → 8-point compass label in Bulgarian (север / североизток / изток / …); string = `Съседни клиенти в един район (${compass}) — най-малко каране`. When `depot == null` or the day is empty, fall back to `Съседни клиенти заедно — по-малко километри`.
- `harvest` and `unplaced`: unchanged from the current assembly.

### Client

- **types.ts:** mirror the new server response (`RouteEstimate`, extended `SuggestedDay`, unchanged `UnplacedOrder`/`DaySuggestionResult`). `suggestDays` arg becomes `{ date; couriers }[]`.
- **api-client.ts:** `suggestDays(days: { date: string; couriers: number }[])`.
- **route-day-suggester-modal.tsx:**
  - Day picker: each day chip gains a small **couriers** number input (default 1, 1–10).
  - `propose()` sends `days` as `{date, couriers}[]`.
  - Result per day: header `relDayLabel(date) · N куриера · ~{makespan} · {totalKm} км` + the **reason** line; then one sub-block per **route** (`Маршрут i · {km} км · ~{driveMinutes} мин · {stops.length} спирки`) listing that route's orders. Harvest line as today. Un-geocoded bucket unchanged.
  - Per-order retarget (`<select>` of days) + exclude, and `apply()` (loop `rescheduleOrders` per day over non-excluded): **unchanged** — grouping is by chosen day, couriers do not affect it.

## Data flow

```
modal → suggestDays([{date, couriers}, …])
  → POST /orders/suggest-days (DTO validates per-day couriers)
    → reschedulable(tenantId) pool + coords, depot, orderItems (one query)
    → assembleDaySuggestion(pool, itemsByOrder, depot, days)
        → suggestDayAssignment: sweepSplit(K=Σcouriers) → bin arcs to days   [pure]
        → per route: estimateRoute → km + minutes                            [pure]
        → per day: makespan, totalKm, harvest, reason                        [pure]
  → modal renders days→routes; farmer tweaks; apply → rescheduleOrders per day (unchanged)
```

## Error handling / edge cases

- **couriers < 1 or > 10 / non-int:** DTO rejects (400).
- **Zero geocoded orders:** every requested day present with `routes: []`, `driveMinutesMakespan: 0`, `totalKm: 0`; un-geocoded listed in `unplaced`.
- **Fewer located orders than Σcouriers:** `sweepSplit` yields one stop per group (fewer than K groups); extra courier slots on later days simply get no route. No crash.
- **No depot (farm ungeocoded):** clustering uses the located-orders centroid (existing fallback); km/minutes render `0`; reason uses the generic fallback string.
- **One day, one courier:** trivially the whole located pool as a single route (equivalent to today's behavior).

## Testing

- **`estimateRoute` (route-split.spec):** km & seconds ≥ 0 and monotonic (more/farther stops ⇒ larger), empty stops ⇒ `{km:0, seconds:0}`; `estimateWorkloadS` still passes after delegating.
- **Engine (`route-day-suggest.spec`):** capacity weighting (day with more couriers gets more orders); each day's routes count ≤ its couriers; contiguous-arc coherence (two clearly separated clusters + 2 single-courier days ⇒ each cluster on its own day); un-geocoded → `unplaced`; determinism; two-level output shape.
- **Assembly (`route-day-assemble.spec`):** per-route km/driveMinutes populated; makespan = max; totalKm = Σ; `couriers` echoed; reason non-empty; no-depot ⇒ zeros + fallback reason; harvest/unplaced still correct.
- **Endpoint spec:** delegates `{date,couriers}[]` to the service with the tenant id.

## Reused / touched files

- `server/src/modules/routing/route-split.ts` — add `estimateRoute`; `estimateWorkloadS` delegates.
- `server/src/modules/routing/route-day-suggest.ts` — two-level, capacity-weighted split (Approach A).
- `server/src/modules/routing/route-day-assemble.ts` — routes + time/km + reason; new result types.
- `server/src/modules/routing/dto/suggest-days.dto.ts` — per-day couriers.
- `server/src/modules/routing/routing.service.ts` — pass through the new `days` shape; result types re-export unchanged.
- `client/src/lib/types.ts`, `client/src/lib/api-client.ts`, `client/src/components/route/route-day-suggester-modal.tsx` — per-day couriers input + routes/time/reason rendering.

## Non-goals (v1)

- Persisting the courier split into `/route` (couriers stay advisory).
- ML/optimal reasoning — the reason is a templated proximity/region string.
- Baseline "saved vs single-courier / vs one day" comparison.
- Any change to the apply/reschedule/notify path.
