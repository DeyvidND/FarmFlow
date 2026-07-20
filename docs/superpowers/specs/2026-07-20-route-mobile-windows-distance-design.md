# Route mobile fixes + distance-based delivery windows — design

**Date:** 2026-07-20
**Status:** approved for planning
**Scope:** farmer-organizer route/courier feature — mobile usability, a map-rebalance
bug, farmer-editable delivery times with cascade, and distance-based time generation.

## Context

A farmer-organizer runs deliveries from their phone on the `/route` screen
(`client/src/components/route/route-client.tsx`, backed by `server` routing module).
The operator reported 9 rough issues. Code investigation collapsed them into 5 work
packages. Three scope decisions were locked with the operator:

1. **Map courier-count bug** happens when couriers are managed via the **„Куриери за
   деня" board**, not the settings dropdown.
2. **Multi-farmer** means orders from several farmers picked up at **one point** (the
   tenant farm) — group/show them in the generate modal. **No multi-origin routing.**
3. **Edit time** should be **inline on each route stop** (plus the existing „Часове"
   modal), and shifting one time cascades to all later stops.

Sequencing: WP1 + WP2 first (quick wins; WP2 unblocks testing WP4/WP5) → WP3 → WP4 →
WP5. WP4 and WP5 both touch the delivery-windows modal + `DeliveryWindowStop` type and
should share a branch.

---

## WP1 — Comprehensive mobile hardening of the route section (items 1–4) · size M

**Scope broadened per operator:** make the whole `/route` section as phone-usable as
possible — sweep **every** modal and the main layout for horizontal overflow and
unreachable controls, not only the three known-broken modals.

### Problems (confirmed + to sweep)
- **„Смени адрес" unsaveable (confirmed):** `edit-address-modal.tsx:113` — inner panel
  has **no `max-height` / `overflow-y-auto`** but holds a `h-[300px]` map (`:156`) +
  fields + Save. On a phone the wrapper is `grid place-items-center`, so overflow is
  clipped top+bottom and „Запази" (`:203`) is off-screen with no scroll. Map uses
  `gestureHandling="greedy"` (`:163`) → touch-drag pans the map, not the modal.
- **Same missing-scroll pattern (confirmed):** `location-route-card.tsx:77`,
  `waze-stepper.tsx:46`.
- **New-tab annoyance (confirmed):** nav uses `window.open(url, '_blank')` —
  `route-client.tsx:850` (single stop), `:675` (full route), `:692` (Waze), `:1052`
  (extra legs). `tel:`/`mailto:` correctly use `_self` (`:857`, `:861`).
- **Address clipped (confirmed):** `stop-list.tsx:214` uses `truncate`; icon buttons 32px.
- **To sweep (horizontal overflow / reachability):** every modal opened from the route
  page (add-orders, courier-assignment-board, courier-homes, courier-starts,
  delivery-windows, reorder-stops, route-day-suggester, settings-drawer, order-panel,
  confirm-dialog, help/explainer) **and** the main `route-client.tsx` layout — toolbars,
  the route-menu, chip rows, the extra-legs bar, stop cards — for: fixed `w-[..px]`
  without `max-w`, non-wrapping `flex` rows, `min-w`/`whitespace-nowrap` that force a
  horizontal scrollbar at 375px, and any control pushed off-screen.

### Fix
- Add `max-h-[85vh] overflow-y-auto` to the three center modals, copying the working
  sibling pattern (`route-day-suggester-modal.tsx`, `order-panel.tsx` already do this).
- edit-address: put scroll on the wrapper; shrink the map under a mobile breakpoint
  (`h-[300px]` → `max-[680px]:h-[200px]`) so Save stays visible. Keep map greedy.
- Nav buttons: open with `_self` on mobile (deep-links the Maps/Waze app), keep `_blank`
  on desktop. Reuse existing `isMobileBrowser()` (`route-client.tsx:81`).
- Address line: `line-clamp-2` instead of `truncate`; icon buttons → 40px touch target.
- Overflow sweep: for each defect found, cap width (`max-w-full`/`max-w-[..]`), allow
  wrapping (`flex-wrap`), or make the row horizontally scroll **inside its own
  container** (`overflow-x-auto`) so the page body never scrolls sideways.

### Acceptance
On a 375px viewport across the whole route section: **no horizontal page scroll**
anywhere; every modal fits, scrolls vertically, and all its actions are reachable;
„Смени адрес" Save persists; tapping „Отвори в Google Maps"/„Навигирай с Waze" opens the
app (or same tab), not a new tab; full address is readable; primary toolbars/menus are
usable one-handed. Verified in-browser at 375px with screenshots.

---

## WP2 — „Генерирай часове" 500 fix (item 7) · size S

### Problem
Clicking „Генерирай часове" returns HTTP 500. The BFF passes the upstream status
through verbatim, so it is a genuine NestJS exception.

### Root cause (primary hypothesis)
Stale `@fermeribg/types` build. The uncommitted diff makes `routing.service.ts` call
`asLegIndex`/`asLegPos` (`:497`, `:549`, `:572-574`), exported from
`packages/types/src/index.ts:305-315`. `nest start --watch` watches only `server/src`,
not the prebuilt `@fermeribg/types` dist. If the API restarted before the types dist was
rebuilt, `asLegIndex is not a function` throws on **every** `getRoute`, which the
generate path calls. (The route page itself swallows a `getRoute` 5xx into an empty
route + banner — `client/src/app/(admin)/route/page.tsx:54-57` — so the screen still
loads, masking the crash until the button surfaces it.)

### Fix
1. Reproduce after `pnpm --filter @fermeribg/types build && <restart api>`. If it clears,
   root cause confirmed; document the build-order gotcha.
2. Regardless, wrap `getRoute` / `generateDeliveryWindows` in a try/catch that logs the
   full stack (structured), so any remaining data-specific crash is pinpointed instead
   of returning a bare 500. Every candidate throw in the source is already guarded
   (division, null origin, timezone, empty orders, missing leftJoin) — so if a clean
   rebuild does not fix it, the logged stack drives the next step.

### Acceptance
„Генерирай часове" returns a windows proposal (200) on a normal day; a forced failure
logs a full stack server-side rather than a silent 500.

---

## WP3 — Board courier-count map rebalance (item 5) · size M

### Problem
With the „Куриери за деня" board active (2 couriers, 5 orders split 3 + 2), reducing to
1 courier for the day does not merge stops: the rendered Google map shows **only 3
points, no refresh** — the removed courier's 2 stops are never reassigned to the survivor
and the map never recomputes to 5.

### Root cause (file:line)
`server/src/modules/routing/routing.service.ts:557-560` —
`n = assignedLegCount > 0 ? assignedLegCount : effectiveCourierCount(...)`. When the
board has rows, the effective count comes from the board and `?couriers=` is discarded.
Removing a courier in the board UI does not drop the orphaned leg's assignment rows, so
`assignedLegCount` stays 2 and the split stays 3 + 2. The settings-drawer count dropdown
is hidden while the board is active (`route-settings-drawer.tsx:192`), and the client's
`boardActive` is derived from a separately-fetched `assignments` array
(`route-client.tsx:434-449`) that can desync from the server's authoritative check.

### Fix
- When a courier is removed from the board, reassign (or delete + re-split) that leg's
  order→leg assignment rows so `assignedLegCount` reflects the new count and the server
  merges the orphaned stops onto the remaining courier(s). Confirm the exact
  board-removal path in `courier-assignment-board.tsx` +
  `server/src/modules/routing/*courier-assignment*` during planning.
- Ensure the client refetches `assignments` after a board change so `boardActive` /
  `boardLegCount` and the map recompute (`displayRoutes` memo, `route-client.tsx:605`).

### Acceptance
On a board day, removing a courier moves its stops to the remaining courier on the map
immediately; leg count and per-leg pins reflect the new split; no orphaned/faint pins.

---

## WP4 — Inline time edit + cascade (items 6, 9) · size M

### Problem
A farmer-organizer wants to change/add a delivery time directly on a stop, and have the
change ripple: +5 min on one order shifts every later order +5 min. Today editing exists
only inside the „Часове" modal (`delivery-windows-modal.tsx`), one order at a time, no
cascade (`updateDeliveryWindow`, `routing.service.ts:1440-1467` mutates a single order).

### Data model (already present)
`orders.deliveryWindowStart/End/Status` (`packages/db/src/schema.ts:492-494`), stop
order within a leg respects `courierIndex` (`:482`) + `routeSeq` (`:487`).
`getRoute` returns leg-ordered `stops[]`.

### Fix
- **Inline edit:** add an `<input type="time">` (start, optional end) on each stop card
  in `stop-list.tsx`, committing via the existing `PATCH /orders/route/window/:id`.
- **Cascade — backend shift endpoint (recommended):**
  `POST /orders/route/windows/shift { fromStopId, deltaMin }` — resolves the stop's leg
  and position from `getRoute`, then adds `deltaMin` to `deliveryWindowStart/End` of that
  stop and every later stop in the **same leg**, atomically, tenant-scoped. Clamp to
  `MAX_WINDOW_END_MIN`. Re-arm status like `updateDeliveryWindow` (sent/approved→approved
  else draft). The inline editor and the modal both call it.
- *Alternative rejected:* client computes each later stop's new time and PATCHes them
  one by one — non-atomic, N requests, races with concurrent edits.

### Acceptance
Editing one stop's time on the route screen shifts all following stops in that leg by the
same delta in one request; the modal shows the shifted times; other legs untouched;
persisted and reflected after reload.

---

## WP5 — Distance-based generation + modal (item 8) · size L

### Problem
Generated times should be based on real travel distance/duration between consecutive
stops, starting from the courier's **current position**, and the post-generate modal
should show, per order, the distance/time from the previous stop so the organizer can
nudge each time (via WP4). Must handle a route whose orders come from more than one
farmer (single pickup — group them in the modal).

### Current behavior (file:line)
`generateDeliveryWindows` (`routing.service.ts:1355-1417`) is distance-*influenced* but
crude: it apportions the courier's measured total road duration across stops by
**cumulative haversine ratio** (`:1386-1389`), and starts from the **farm** origin
(`route.origin`, `:1346-1349`), not the courier's live position. The modal
(`delivery-windows-modal.tsx:376-424`) shows customer/email/time only — no distance.
Routing has a single origin; there is no per-farmer pickup.

### Reusable primitives
- `measureExplicitOrder(...)` (`routing.service.ts:732-823`) already accepts a courier
  `start: Pt` (current position) and measures real legs.
- `pathTotal(pts)` (`:1046-1067`) / `MapsService.routeFixed` — real per-leg
  `distanceM`/`durationS` over a fixed sequence.
- Existing route-start resolution on the client (`ff:route-start` localStorage +
  driver GPS on mount) supplies the current position.

### Fix
- Replace the haversine-ratio apportionment with **accumulated real per-leg durations**
  from `pathTotal`/`routeFixed`, the first leg seeded from the courier's current
  position (mirror `measureExplicitOrder`'s `start`). Keep the `FALLBACK_LEG_MIN` path
  when Maps is unavailable.
- Add `distanceFromPrevM` / `durationFromPrevS` to `DeliveryWindowStop` (server type
  `routing.service.ts:207-214` **and** the client mirror `client/src/lib/types.ts:822`,
  per the mirror convention in `packages/CLAUDE.md`). Populate from the real legs.
- Add an optional `startLat`/`startLng` to the generate DTO
  (`dto/delivery-window.dto.ts`) + controller (`:231`) + api-client (`:784`) + modal
  (`:100`); pass the courier's current position.
- Modal rows: show distance + time from previous stop; **group rows by farmer** (single
  pickup — display only), so a multi-farmer day is legible. The organizer edits each
  time inline (WP4 cascade).

### Acceptance
Generating on a normal day produces times built from real leg durations starting at the
courier's current position; each modal row shows distance/time from the previous stop;
a day with orders from >1 farmer groups rows per farmer; editing a time cascades (WP4).

---

## Cross-cutting / testing
- Backend: mirror existing specs — `routing.delivery-windows.spec.ts` (windows),
  `routing.service.spec.ts` / `routing.adversarial.spec.ts` (split). New: cascade shift
  (leg-scoped, clamp, status re-arm), distance-seeded generation (mock Maps legs),
  board courier-removal rebalance.
- Frontend: client tests are vitest **Node-only, no jsdom/RTL** — cover pure logic
  (cascade delta math, per-farmer grouping, `_self`/`_blank` selection) as `.test.ts`;
  verify mobile modal scroll + nav-target behavior in the browser.
- Run the FULL suite, not isolated files. Build `packages/*` first in a fresh worktree.
- Docs-only files don't deploy; code push to `main` auto-deploys (migrator first). No
  migration needed — all fields already exist.

## Open items to confirm during planning
- Exact board courier-removal code path and whether it deletes vs remaps assignment rows
  (WP3).
- Whether the inline stop editor needs both start+end or start-only with a fixed window
  length (WP4).
- Where the courier "current position" is freshest at generate time (localStorage vs
  live GPS) (WP5).
