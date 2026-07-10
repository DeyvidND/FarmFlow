# Route card: order side-panel + per-order finish — design

Date: 2026-07-10
Scope: `client/` (route feature) + one api-client helper. No DB, no new backend endpoint.

## Problem

On the „Маршрут за доставка" screen the farmer/courier can only bulk-finish the
whole day (mark EVERY stop delivered at once). Two missing affordances:

1. Open the full **order detail side panel** (the existing `OrderPanel` — the
   #51 screen with Потвърди / Маркирай доставена / Откажи / Промени статус / edit)
   for the current stop, without leaving the route screen.
2. Mark orders delivered **one at a time**, stepping through the route, instead
   of only all-at-once.

## Decisions (from brainstorming)

- Two new buttons are **icon-only** (tooltip `title` + `aria-label`), added to the
  route card header button row next to Подреди реда / Google Maps / Waze /
  Завърших доставките (`route-client.tsx`, ~L729–772).
- "Current stop" reuses the existing `activeId` (the highlighted list row).
  Default = first stop, matching „първата поръчка седи на default".
- Bulk „Завърших доставките" **stays** (user chose keep both).
- Per-order finish takes **one click, no confirm dialog** („цъка → отбелязва → продължава").

## Button 1 — Отвори поръчката (order side panel)

- Icon button. On click: fetch the current stop's full order, then render the
  existing `OrderPanel` (`client/src/components/orders/order-panel.tsx`) unchanged.
- `RouteStop.id` **is** the order id (existing `finishDay` already calls
  `updateOrderStatus(s.id, …)`). `OrderPanel` needs a full `Order`; the route only
  carries `RouteStop`. Bridge:
  - Add `getOrder(id)` to `client/src/lib/api-client.ts`:
    `apiFetch<Order>(\`orders/${id}\`)`.
  - Backend `GET /orders/:id` already exists (`orders.controller.ts:118` →
    `ordersService.findOne` → `serializeOrder(withItems)`), returning the same
    `Order`/`SerializedOrder` shape the panel already consumes elsewhere. No
    backend change.
- Wiring (mirror `orders-client.tsx`):
  - `panelOrder: Order | null` state; `openingId: string | null` for the button
    spinner.
  - Click → `setOpeningId(stop.id)`; `getOrder(stop.id)` → `setPanelOrder(o)`;
    on error `toast.error`; finally clear `openingId`.
  - `OrderPanel` props: `order={panelOrder}`, `onClose` → clear + `router.refresh()`,
    `onAction(status)` → `updateOrderStatus(panelOrder.id, status)` then update
    `panelOrder` with the returned order (+ `router.refresh()`), `onSaved(updated)`
    → `setPanelOrder(updated)` + `router.refresh()`.
- The panel opens for the current stop (`activeId`); if `activeId` is null fall
  back to the first ordered stop.

## Button 2 — Завърши поръчката (per-order stepper)

- Icon button (distinct icon from the bulk `CheckCircle2`, e.g. `PackageCheck`).
- Local `finishedIds: Set<string>` — stops already marked this session (greyed,
  never re-marked). "Current" = first stop in `orderedStops` whose id is not in
  `finishedIds`.
- Click:
  - `cur = orderedStops.find(s => !finishedIds.has(s.id))`; if none → no-op.
  - `await updateOrderStatus(cur.id, 'delivered')` (optimistic; no dialog).
  - add `cur.id` to `finishedIds`; advance `activeId` to the next unfinished stop
    (so the list highlight moves — visible „продължава").
  - `toast.success(\`<клиент> завършена · остават N\`)`; on failure `toast.error`
    and do NOT add to `finishedIds` (so it can be retried).
  - When `finishedIds` covers every stop → `router.refresh()` once (reconcile with
    the server; delivered orders drop out of the route). Mirrors `finishDay`'s
    single end-of-run refresh — no per-click refresh, no flicker.
- Button disabled when there is no unfinished stop / `!orderedStops.length`.
- Optional counter in the button `title`: „Завърши текущата поръчка (остават N)".

## Non-goals

- No persistence of finish progress across reload (server status is the source of
  truth; a refresh drops delivered stops and the pointer naturally resets to the
  first still-pending stop). Consistent with `finishDay`.
- No change to bulk „Завърших доставките", the map, Waze, or reorder flows.
- No backend/DB change.

## Files touched

- `client/src/lib/api-client.ts` — add `getOrder(id)`.
- `client/src/components/route/route-client.tsx` — two icon buttons, panel state +
  `OrderPanel` render, per-order finish handler.
- Help modal copy (`route-client.tsx` help `<ul>`) — one line per new button.

## Risks / checks

- `GET /orders/:id` is tenant-scoped and admin/farmer-reachable (route screen is
  already admin/farmer). Confirmed returns full order with items → panel renders.
- Marking delivered is reversible via the panel's „Промени статус", so the
  one-click no-confirm finish is low risk.
