# Waze route export (Маршрути) — design

Date: 2026-07-06
Status: approved, ready for implementation plan
Scope: **client-only** (no backend, no DB migration)

## Problem

The Маршрути screen orders a day's confirmed delivery stops (base → stop 1 → …
→ stop N → end) and exports the whole route to Google Maps via chained
`google.com/maps/dir` legs. Some farmers prefer Waze.

Waze deep links cannot express a multi-point route:

- The app-navigation URL takes **one destination only** and **always starts
  from the phone's current GPS** — there is no origin or waypoint parameter.

So "export the route to Waze" cannot be a single link. It must be a
**step-by-step navigator**: navigate current-GPS → next stop, one stop at a
time. Because the farmer is physically standing at stop *k* when they tap
"navigate to stop *k+1*", Waze's "current GPS → stop *k+1*" is effectively
"from stop *k* to stop *k+1*" — which is exactly the leg the farmer wants.

## Goal

Add a Waze export to Маршрути that walks the farmer through the ordered stops
one at a time, auto-advancing the default target after each export, while
letting them manually move the pointer if needed.

## Non-goals

- No multi-waypoint Waze link (not possible via Waze URL scheme).
- No backend changes — Waze URLs are built client-side, exactly like the
  existing Google Maps links.
- No route re-ordering logic changes; Waze consumes the already-ordered
  `stops[]` from `RouteResult`.

## UX / interaction

- A third button **„Waze"** next to the existing `Google Maps` / `Старт`
  buttons (`route-client.tsx`, stops-list header ~line 466). Disabled when
  there are no stops (mirrors the other two).
- Clicking toggles a **Waze stepper panel** shown above the map/list grid
  (similar placement to the existing `extraLegs` / `showLoc` blocks).
- Panel contents:
  - **Current target:** „Спирка N — <customer>", address + slot time when present.
  - Big primary button **„Навигирай с Waze →"**.
  - Manual pointer controls: **„← Предишна"** / **„Следваща →"**.
  - Progress line **„Спирка N от M"**.
  - Hint: „Waze тръгва от текущото ти място до тази спирка. След доставка цъкни
    за следващата."
  - **Done state** (pointer past the last target): „Всички спирки минати" +
    **„Започни отначало"** button.

## Waze URL builder (technical)

Universal link form (opens the Waze app on mobile if installed, else Waze web):

- Coords available: `https://www.waze.com/ul?ll=<lat>%2C<lng>&navigate=yes`
- No coords, address available: `https://www.waze.com/ul?q=<encoded address>&navigate=yes`
- Neither: no link — the navigate button is disabled for that target and the
  panel shows „не е на картата" with a **„Пропусни"** (skip to next) action.

Opened via `window.open(url, '_blank', 'noopener')`. Exactly one URL per click,
so — unlike the Google Maps multi-leg export — there is **no popup-blocking /
"Отсечка 2,3…" problem** to handle.

## Target order + smart auto-advance

- `targets` = `stops[]` in their given order (the array is already sorted by the
  selected order mode). Each target is `{ id?, label, customer, address, lat,
  lng, slotFrom, slotTo }`.
- When `end.mode !== 'last'` **and** the end point has coords/address, append a
  final target **„Обратно към базата"** built from `end` (origin fallback).
- Tapping „Навигирай" for index `i`:
  1. open the Waze URL for `targets[i]`,
  2. if `i` is not the last, `setIdx(i + 1)` (auto-advance the default).
- Pointer persisted in `localStorage` under key `ff:waze:<date>`. On mount /
  date change, read + clamp to `[0, targets.length]` (length = "done" sentinel).
  Each date keeps its own progress.

## Data

Uses existing `RouteResult` from `GET /orders/route?date=` — `stops`, `origin`,
`end`. `RouteStop` already carries `customer`, `address`, `lat`, `lng`,
`slotFrom`, `slotTo`, `id`. "Спирка N" label = array index + 1. No new fields.

## Files

- **New** `client/src/components/route/waze.ts`
  - `wazeUrl(point): string | null` — pure; `ll` when coords, else `q` when
    address, else `null`.
  - `buildWazeTargets(stops, end, origin): WazeTarget[]` — pure; ordered stops +
    optional final base target.
- **New** `client/src/components/route/waze-stepper.tsx`
  - Presentational panel. Props: `targets`, `idx`, `onNavigate(i)`, `onPrev`,
    `onNext`, `onReset`, `onClose`. No data fetching.
- **Edit** `client/src/components/route/route-client.tsx`
  - Add `showWaze` + `wazeIdx` state (wazeIdx synced to `localStorage`).
  - Add „Waze" toggle button in the stops-list header.
  - Render `<WazeStepper/>` when `showWaze`.
  - Add a short Waze bullet to the existing „Помощ" explainer.

## Edge cases

- **0 stops** → „Waze" button disabled.
- **Current target has no coords** → `q=address` fallback; **no address either**
  → navigate disabled, show „не е на картата" + „Пропусни".
- **Reorder / date change shrinks list** → clamp persisted `wazeIdx`.
- **Desktop** → opens Waze web; acceptable. Hint frames the feature as
  phone-oriented.
- **Stale progress across days** → key is per-date, so no bleed.

## Testing

- Unit `waze.ts`:
  - `wazeUrl` with coords → `https://www.waze.com/ul?ll=..%2C..&navigate=yes`.
  - `wazeUrl` with address only → `...?q=<encoded>&navigate=yes`.
  - `wazeUrl` with neither → `null`.
  - `buildWazeTargets` → stops in order; appends base target when
    `end.mode !== 'last'` and end resolvable; omits it otherwise.
- (Optional) component test for `waze-stepper` / route-client: auto-advance on
  navigate and `localStorage` persistence.

## Rollout

Pure client feature, no env/migration. Ships with the next client build.
