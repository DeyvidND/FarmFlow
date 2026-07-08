# Multi-day route suggester ("Предложи разпределение по дни")

**Date:** 2026-07-08
**Status:** Approved design — ready for implementation plan
**Branch:** main → new feature branch

## Problem

A farmer running **own/personal delivery** accumulates address-delivery orders spread over
several days. Deciding **which orders to deliver on which day** is currently manual guesswork.
The farmer has two levers that matter and lots of data we already hold:

- **Geography** — every address order is geocoded (`orders.deliveryLat/deliveryLng`), and the
  farm has a depot (`tenants.farmLat/farmLng`). Grouping nearby customers onto the same day
  makes each day's drive tight.
- **Harvest** — each order's line items say what must be picked. The farmer wants to *see*
  what a day's harvest looks like before committing.

We want a **suggestion engine**: the farmer picks how many days (and which), and the system
proposes a geography-first split of the pending address orders across those days, showing each
day's route size and its harvest summary. The farmer reviews, tweaks, and applies — reusing the
existing reschedule mechanism to move orders and notify customers.

## Key insight (why geography-first, harvest = info only)

Batching harvest across days (pick a product once for 3 days) **fights freshness** — you do not
pick Monday produce for a Thursday delivery. In practice the farmer re-picks fresh each delivery
day anyway, so harvest is a poor *clustering* driver. Geography is the strong, non-conflicting
lever: cluster customers by area, one tight route per day, and each day picks its own orders
fresh. Harvest is therefore shown as a **per-day readout** (the original "списък за бране" idea),
not used to move orders.

## Scope / decisions (locked with the user)

- **Placement:** lives in the **Маршрути** (Routes) section — it already owns geography, the
  depot, multi-courier routes, and the TSP optimizer.
- **Objective:** **geography-first.** Cluster by location; harvest/product load is *not* an
  optimization signal in v1 (display only).
- **Candidate pool:** the existing `reschedulable()` set — `deliveryType='address'`, status ∈
  {`pending`,`confirmed`}, slot date ≥ today. Extend the query to also return
  `deliveryLat/deliveryLng`.
- **Days:** day-picker **pre-seeded** with the farm's upcoming delivery days, but **fully
  editable** — the farmer may add or remove ANY calendar date at his discretion (e.g. drive
  Friday even though Friday is not a published storefront slot day).
- **Harvest:** **display only** — each proposed day shows the per-product quantity total. No
  harvest-load balancing in v1.
- **Un-geocoded orders:** never auto-placed. They go to a separate "за ръчно нареждане" bucket
  the farmer assigns by hand.
- **Apply = preview-first:** the proposal is shown and editable; nothing moves until the farmer
  clicks "Приложи". Apply reuses `POST /orders/reschedule` (moves slots + notifies customers,
  "обади се ако неудобно"). No new move logic.
- **Migration:** none. No schema change.

## Non-goals (explicitly out of v1)

- Drive-time-accurate optimization across days (v1 uses crow-fly / Haversine only).
- Multi-courier splitting *within* a day (v1 = one route per day; the existing route view still
  splits a day into couriers afterwards).
- Harvest-load balancing across days (display only).
- Any SMS channel (email-only, inherited from the reschedule mechanism).

## Architecture

### Backend

1. **Extend `reschedulable()`** (`orders.service.ts`) to also select `deliveryLat`,
   `deliveryLng`. (The `ReschedulableOrder` interface gains the two nullable coords.) The
   existing "Премести на друг ден" modal ignores the new fields — additive, non-breaking.

2. **New pure module `routing/route-day-suggest.ts`** — no DB, no Maps calls, unit-testable.
   - Input: `{ orders: {id, lat, lng}[], days: string[], depot?: {lat,lng} }`.
   - Algorithm: **reuse the existing `sweepSplit(depot, stops, k, endPt)` partitioner**
     (`route-split.ts`) with `k = days.length`. It already does balanced geographic clustering
     (sweep + geographic k-means + radial seeds, makespan-balanced local search, deterministic,
     Haversine-only) — no new clustering code. The new module only maps the returned groups onto
     the chosen days.
   - Cluster → day assignment: **deterministic** — sort clusters by centroid distance from the
     depot ascending (nearest area first), tie-break by cluster size descending, then map onto
     the selected `days` in date order. (Each day is tight regardless of which date it lands on;
     a fixed rule just guarantees reproducible output for tests.)
   - Output: `{ assignment: { [date]: string[] /* orderId */ }, unplaced: string[] }`. Orders
     with null lat/lng go straight to `unplaced`.

3. **New endpoint `POST /routing/suggest-days`** — body `{ days: string[] }`.
   - Admin-scoped, tenant-isolated (mirrors `reschedulable`).
   - Loads the reschedulable pool (with coords), runs `route-day-suggest`, and for each proposed
     day computes the **harvest summary** (per-product qty total) from the orders' line items.
   - Response shape:
     ```
     {
       days: [{ date, orders: [{id, orderNumber, customerName, lat, lng, totalStotinki}],
                harvest: [{ productName, quantity }], spreadKm }],
       unplaced: [{ id, orderNumber, customerName, totalStotinki }]
     }
     ```
   - `spreadKm` = sum of straight-line depot→stop distances for the day — a cheap "how big/spread
     is this day" hint, not a real route length. No Maps calls.

4. **Harvest summary helper** — extract the per-product-total logic that already exists inline in
   `digest.service.ts` (`prepMap`, sum `quantity` by `productName`) into a shared pure helper so
   both the digest and the suggester use one implementation.

5. **Apply** — reuse the existing `POST /orders/reschedule` (`{ orderIds, toDate }`). The client
   calls it once per proposed day (or a thin batch wrapper loops server-side). No new move
   endpoint, no new notification code.

### Frontend (Маршрути section)

- **Trigger:** button "Предложи разпределение по дни".
- **Day-picker:** pre-filled chips = upcoming delivery days; farmer can add any date (free date
  input) or remove chips. "Предложи" calls `suggest-days`.
- **Proposal view:** one block per day →
  - order count + `crowFlyMeters` hint,
  - **harvest summary** (продукт × количество) as info,
  - client list (name / amount), optionally pinned on the existing map.
- **Un-geocoded bucket:** "за ръчно нареждане" — farmer drags/assigns these to a day manually.
- **Tweak:** move an order between day blocks, or exclude it (stays on its current day).
- **Apply:** "Приложи" → confirm dialog (X orders moving, customers notified) → per-day
  `rescheduleOrders` calls → toast summary → refresh.

## Data flow

```
Маршрути → "Предложи" (days[])
  → POST /routing/suggest-days
      → reschedulable() + coords
      → route-day-suggest (Haversine k-means, balance)   [pure, no Maps/DB]
      → per-day harvest summary (shared helper)
  → proposal rendered, farmer tweaks
  → "Приложи" → POST /orders/reschedule per day          [existing: move slot + notify]
```

## Error handling / edge cases

- **Zero geocoded orders** → "няма какво да разпределя" empty state; still list un-geocoded for
  manual handling.
- **All orders in one town** → clusters are close; the balance pass splits by count. Acceptable.
- **1 day selected** → trivial: all placed orders go to that day (equivalent to a plain route).
- **Un-geocoded orders** → never auto-moved; manual bucket only.
- **Order edited/cancelled between suggest and apply** → apply reuses `rescheduleOrders`, whose
  existing guards (status ∈ {pending,confirmed}) reject stale orders; surface a partial-apply
  toast.

## Testing

- **Unit `route-day-suggest`:** balanced split across N days; un-geocoded → `unplaced`; N=1 edge;
  determinism (same input → same output); depot-relative assignment.
- **Unit harvest helper:** sum quantity by product name; empty input.
- **Endpoint spec `suggest-days`:** delegates with tenant id; tenant isolation (mirrors the
  existing reschedule controller spec).
- No new tests for apply — it reuses the already-tested `rescheduleOrders` path.

## Reused / touched files

- `server/src/modules/orders/orders.service.ts` — extend `reschedulable()` + `ReschedulableOrder`.
- `server/src/modules/orders/orders.controller.ts` — (no change; reuse reschedule route).
- `server/src/modules/routing/route-day-suggest.ts` — **new** pure engine.
- `server/src/modules/routing/routing.controller.ts` + `routing.service.ts` — **new**
  `suggest-days` endpoint + assembly.
- `server/src/modules/digest/*` — extract harvest-summary helper (shared).
- `client/src/components/...routing...` — **new** suggester panel + day-picker + proposal view.
