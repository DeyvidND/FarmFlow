# Courier/route hardening — design

Date: 2026-07-17
Range audited: `cb9369f4..5bfd4aa8` (62 commits, ~9k lines, 114 files; shipped to prod 2026-07-15/16)
Source: adversarial multi-agent review — 13 raw findings, 10 survived 3-of-3 skeptic verification, plus 2 found by hand during design.

## Problem

Three bug classes each recurred three times in this range. Each was patched at call sites; none was made impossible. This design fixes the 10 confirmed findings **and** removes the representability of the two structural classes.

### Class A — `statuses` conflates split basis with display filter

`RoutingService.getRoute(..., statuses = ['confirmed'])` filters `orders` rows **before** `sweepSplit` runs. `sweepSplit` is a balancing partition over whatever set it is handed, so `statuses` does not merely choose which stops are *shown* — it changes **how the day is partitioned**.

The parameter's doc comment asserts the opposite, and describes the divergence as intentional:

> Own-leg ownership checks … pass `['confirmed', 'delivered']` so an order the driver just marked delivered still resolves to their own leg — the plain route screen keeps the `'confirmed'`-only default so finished stops drop off the live view.

Callers therefore disagree on the partition itself:

| Call site | `statuses` | Consequence |
|---|---|---|
| `routing.controller.ts:70` — driver live route | `['confirmed']` | **HIGH.** Delivering a stop shrinks the set and re-partitions the survivors; another courier's stops migrate onto this driver's leg with full customer PII (name, phone, email, address, note). |
| `orders.controller.ts:66` — `assertDriverOwnsOrder` | `['confirmed','delivered']` | **HIGH.** Disagrees with the screen above → driver gets 403 on stops shown on their own route. |
| `orders.controller.ts:200` — `prepForDriver` | default `['confirmed']` | **HIGH.** Same unstable basis; a courier's packing list can list another courier's orders. |
| `routing.controller.ts:182` — measure ownership | default `['confirmed']` | **MEDIUM.** An ownership check on the unstable basis; inconsistent with the other ownership check. |
| `routing.controller.ts:109` — `myTurnover` | `['confirmed','delivered']` | Correct — and its comment shows the author had already diagnosed the instability for turnover without generalising it. |

One parameter, two jobs. Every consumer picked a value for the *display* question and silently got a different *partition*.

### Class B — leg index vs array position

A day's legs may be non-contiguous (gap days): assigning drivers to Курс 1 and Курс 3 yields real legs `[0, 2]` but a dense `routes` array of length 2. `settings.routing.couriers[]` is indexed by **real leg**; the server resolves it via `couriersCfg[posToLeg[i]]` (fixed in `e1b3d9fe`). The client modals still index by **array position**.

- `courier-homes-modal.tsx:93` — builds `courierCount` rows aligned to `stored[i]`. On legs `[0,2]`, leg 2's home is unaddressable; the visible row writes `couriers[1]` (a leg nobody drives today). `endForCourier` then finds no `homeLat/homeLng` for leg 2 and returns the farm depot — the driver drives back to base while the UI reports „Домовете са запазени".
- `courier-starts-modal.tsx:76` — same defect on the start override. `RouteSettingsDrawer` proves the divergence in one screen: it *reads* the start from `routes[].startAddress` (real leg) but launches an editor keyed by position.

### Class C — rebuild-instead-of-merge on shared objects

- `courier-homes-modal.tsx:24` — `rowToPayload` reconstructs each courier entry from `CourierHomeRow`, carrying only `name`, `endMode`, `home*`. The per-courier start override (`startAddress/startLat/startLng`, added mid-range by `f362c899`) is not on that row type and is dropped. The server replaces the `couriers` array wholesale, so **saving „Домове на куриерите" silently deletes every courier's start base.**

This is the same class as `cb9369f4` ("merge order-panel status/COD-outcome updates instead of replacing"), the commit immediately preceding this range.

### Independent findings

- `handover-pdf.ts:17` — `dateBg` formats with `Date.prototype.getDate/getMonth/getFullYear`, i.e. the container's zone. No `TZ` is set in `server/Dockerfile` or any compose/deploy file, so prod Node runs UTC. A handover signed 2026-07-17 01:30 EEST prints `Днес, 16.07.2026 г.` on a legal протокол. Every other day-derivation goes through `bgDateOf`/`bgToday`.
- `courier-assignment.service.ts:77` and `courier-access.service.ts:96` — both guard a race with `(err as {code?: string}).code === '23505'`. `drizzle-orm@0.45.2` wraps pg errors in `DrizzleQueryError`, which carries no `code`; the pg code is at `err.cause.code`. Both guards for the new 0109 constraints are **dead** → 500 instead of 409.
- `route-split.ts:478` — `sweepSplit` returns one-stop-per-group when `stops.length <= n`, *before* reading `baseWorkloads`. Free stops are dealt out by array position, defeating the pin-aware balancing added by `feeefc43` exactly when pins dominate (e.g. 12 of 14 pinned to courier 0 → `baseWorkloads = [4777, 0]` ignored).
- `route-settings-drawer.tsx:56` — `endPos` is clamped only in the lazy `useState` initializer. The drawer stays mounted across a soft-nav that shrinks `couriers`, so `endPos` can exceed the last index; `cur` masks it via `?? couriers[0]` but `onSetEndAt(endPos, mode)` still fires out-of-range and the parent's `routes.map((r,i) => i === pos ? ...)` matches nothing — the toggle silently no-ops.

## Design

### 1. Separate split basis from display filter

Delete the `statuses` parameter. `getRoute` always partitions over the **stable basis** `['confirmed','delivered']`, then filters for display **after** the split:

```
rows(basis = confirmed + delivered)
  → sweepSplit / pin placement        // zone ownership — stable all day
  → filter to display set             // live: drop delivered
  → sequence(displayed stops)         // drive plan — shrinks as stops finish
```

`getRoute` gains `display?: 'live' | 'all'` (default `'live'`). This is a **product** choice about what to render — it can no longer affect the partition.

Per call site: live route `'live'`; `myTurnover` `'all'`; ownership checks `'all'`; `prepForDriver` `'all'` (the packing list is the day's whole load and should not shrink as stops finish).

Why this closes the class: ownership, turnover, prep and the live route agree **by construction**. There is no longer a parameter that can make them disagree.

Rejected — freezing the split by persisting order→leg: strictly more stable (immune to mid-day adds/cancels too), but needs a migration, an explicit Rebalance action, and a change to the operator's mental model. Deferred; see Residual risk.

### 2. Brand the indices

In `packages/types`:

```ts
export type LegIndex = number & { readonly __brand: 'LegIndex' };  // real leg / courierIndex
export type LegPos   = number & { readonly __brand: 'LegPos' };    // dense position in routes[]
```

Conversion only via `posToLeg` / `legToPos`. `settings.routing.couriers[]` is typed as indexed by `LegIndex`.

Client modals change shape: `courierCount: number` → `legs: LegIndex[]`. `route-client.tsx` passes `route.routes.map(r => r.courierIndex)`. Rows are keyed by real leg and labelled „Куриер {legIndex + 1}" so they match the „Маршрут {legIndex + 1}" tabs.

Findings 1 and 2 stop compiling rather than needing to be remembered.

### 3. Merge-safe settings writes

`rowToPayload` gains patch semantics: merge the modal's owned fields into the existing entry for that leg, preserving every field the modal does not own. The server-side `couriers` write path merges by leg index instead of replacing the array wholesale.

A modal must not be able to destroy a field it has never heard of.

### 4. Independent fixes

- `dateBg` → derive the day via the existing Europe/Sofia helper (`bgDateOf`), not local getters.
- Add `isUniqueViolation(err)` reading `err.code ?? err.cause?.code`; use at both sites.
- `sweepSplit` fast path → assign free stops to the lowest `baseWorkloads` courier rather than by position; keep the fast path, fix its choice.
- `endPos` → clamp on render (or sync via effect on `couriers.length`), so it cannot exceed the valid range.

## Testing

TDD per fix: a failing test first, proving the bug, then the fix.

- **Class A:** a 6-stop / 2-courier day; assert the partition is byte-identical before and after 3 stops are marked delivered; assert a stop on driver A's screen passes `assertDriverOwnsOrder`; assert `prepForDriver` never returns another leg's order.
- **Class B:** a gap-day board (`legs [0,2]`); assert editing „Куриер 3"'s home lands at `couriers[2]` and that leg 2's resolved end is that home, not the depot.
- **Class C:** set a start base, save the homes modal, assert `startAddress/startLat/startLng` survive.
- **Independents:** `dateBg` under `TZ=UTC` for a 01:30 EEST instant; `isUniqueViolation` against a real wrapped `DrizzleQueryError`; `sweepSplit` with `baseWorkloads=[4777,0]` and 2 free stops; drawer `endPos` after a courier-count shrink.

Existing route specs must be re-read, not just re-run: several encode the confirmed-only partition as expected output and will need updating to the stable basis. An updated expectation must be justified by this design, not by whatever the new code happens to emit.

## Risks

- **Visible behavior change.** Operators' routes will split differently: remaining stops keep their morning zone instead of reshuffling as deliveries land. Intended, but users will notice.
- **Cost model.** The partition now includes delivered stops. Zone ownership is the point; the drive plan still sequences only live stops. Balancing quality on a heavily-completed day should be sanity-checked.
- **Test churn.** See above — specs asserting the old partition are the main source of noise.
- **Residual (accepted):** adding or cancelling an order mid-day still re-partitions the remainder. Strictly better than today (where *every delivery* re-partitions), but not zero. Freezing the split is the follow-up.

## Out of scope

Route UI/UX changes; the frozen-split migration; anything outside the audited range.
