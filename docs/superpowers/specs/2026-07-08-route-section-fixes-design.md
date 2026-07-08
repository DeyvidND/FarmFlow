# „Маршрути" section fixes — design

**Date:** 2026-07-08
**Status:** Design approved
**Scope:** The admin „Маршрути" (delivery-route) surface only: `client/src/components/route/*`, `client/src/app/(admin)/route/page.tsx`, `client/src/lib/{types,api-client}.ts`, `server/src/modules/routing/{routing.service,routing.controller}.ts`. No change to slots, the storefronts, the consolidation work, or the shipped sweep-split algorithm (`route-split.ts`).

Three independent fixes the operator asked for while reviewing the live route screen.

## Problem 1 — stops land on big boulevards

Some delivery pins sit on a major road (a boulevard / European route like E87). A courier can't stop in the middle of a boulevard; they need to pull into the nearest small side street. There is **no clean Google API** for "nearest minor street" — the Roads API does not classify road size, and re-geocoding an address that genuinely is on a boulevard won't move it off. Chosen approach (operator-confirmed): **detect and prompt manual correction**, not auto-relocate.

## Problem 2 — courier count is set in two places

The courier count has two controls: the „Куриери" dropdown on the route page header (per-view, via `?couriers=`) and a „Куриери по подразбиране" number field inside the „Адрес на базата" modal (persisted as `settings.routing.courierCount`, used as the server-side fallback when `?couriers=` is omitted). Two sources for one number is confusing. The operator wants **one control** — the header dropdown — and the modal field gone.

## Problem 3 — return-to-base is all-or-nothing

The „Към дома / Край при клиента" toggle is **global**: one choice applies to every courier. In reality one courier may loop back to the farm while another finishes at their last stop. The operator wants the return-home choice **per courier**.

## Objective

Fix the three without touching the split algorithm or other features. Keep everything deterministic; preserve public route-fetch back-compat (`?end=` and `?couriers=` still work).

## Design

### 1. Major-road stop flag (client-only)

- New pure helper `client/src/components/route/major-road.ts`:
  ```ts
  export function isMajorRoadAddress(address: string | null): boolean
  ```
  Returns true when the address string carries a Bulgarian major-road marker: `бул.` / `булевард`, `шосе`, `магистрала`, or a European-route token (`Е-85`, `E87`, matched case-insensitively for both Cyrillic „Е" and Latin „E"). Deterministic, no I/O. Unit-tested with vitest.
- `stop-list.tsx`: for a **geocoded** stop whose address is flagged, render an amber badge „голям път — спри на близка уличка" next to the existing „не е на картата" badge. Tapping it opens the existing `EditAddressModal` (via the same `onEditAddress(stop)` callback) so the operator drags the pin to a side street (reverse-geocoded, as today).
- `route-client.tsx`: a header count, styled like the existing „не е на картата" warning — „N спирки са на голям път — може да искаш да преместиш пина на близка уличка" — counted across every courier's leg. Informational; never blocks.
- No backend change. Over-flagging is acceptable: it is a gentle, farmer-confirmed nudge, not an automatic move.

### 2. Remove the duplicate courier default

- `location-route-card.tsx`: delete the „Куриери по подразбиране" field, its `courierCount` state, and drop `courierCount` from the `updateTenant` payload (keep `endMode` + address round-trip).
- `routing.service.ts`: default the courier count to **1** when `?couriers=` is omitted — drop the `settings.routing.courierCount` fallback (`n = clamp(couriers ?? 1)`). The header dropdown becomes the only courier control; each visit to `/route` starts at 1 courier unless the URL carries `?couriers=`.
- `RoutingConfig.courierCount` stays in the type as optional/ignored (harmless; no migration).

### 3. Per-courier return-home

**Data model:**
- `CourierRoute` gains `endMode: RouteEndMode` (`'home' | 'last'` in practice; `'custom'` remains legacy/unused for per-courier). `MultiRouteResult.end` stays as the shared depot reference.

**Backend (`routing.service.ts` + `routing.controller.ts`):**
- `getRoute(tenantId, date?, endMode?, couriers?, endModes?)` — `endMode` is the single default (as today, from `?end=` / saved / `'home'`); `endModes` is the optional per-courier array.
- Compute `n` (courier count), then `modes: RouteEndMode[]` of length `n`: `endModes[i] ?? defaultMode` for each `i`, or all `= defaultMode` when `endModes` is absent.
- **Split balancing is unchanged** — `sweepSplit` is called once with the single **default** `endPoint` (uniform end assumption). The per-courier choice only changes each group's optimize target, measured totals, and display; it does not re-shape the split. This keeps the shipped splitter untouched.
- Each group `i` is optimized + measured with its own mode: build `endForGroup = modes[i] === 'home' ? {mode:'home', …origin} : {mode:'last', null}` and pass `modes[i]` into `optimizeGroup`. Set `CourierRoute.endMode = modes[i]`.
- Controller parses `@Query('ends')` (csv → `RouteEndMode[]`, validated per element) alongside the existing `@Query('end')` single fallback.

**Frontend:**
- `page.tsx`: parse `searchParams.ends` (csv) → `EndMode[]`; pass through the server `getRoute` fetch as `&ends=`. Keep `?end=` handling for back-compat.
- `api-client.ts` `getRoute`: accept `ends?: string[]` and serialize to `&ends=csv`.
- `route-client.tsx`: derive `modes = routes.map(r => r.endMode)`. Replace the single global end toggle with a **per-courier** home/last toggle — one per courier tab when multi, and the single top toggle acting on courier 0 when there is one courier. Toggling courier `i` pushes `?date=&couriers=&ends=<modes with i flipped>`. **Changing the courier count drops `ends`** (the split reassigns everyone, so prior per-leg choices are meaningless) → all couriers fall back to the saved/default mode.
- `route-map.tsx`: `RouteLine` uses each route's own `endMode` (not the shared `end`) for its straight-segment return leg; the preferred road polyline already encodes each group's real path (computed per-group in the backend), so this only affects the no-geometry fallback.
- `waze.ts` usage in `route-client.tsx`: `buildWazeTargets` is called for the **active** courier — pass that courier's `endMode` (as a `RouteEnd`) so the „Обратно към базата" leg appears only when that courier returns home.

## Edge cases

- 1 courier → one toggle, behaves exactly as the current global toggle.
- `?ends=` shorter/longer than `couriers` → normalized (pad with default, truncate) server-side.
- Invalid `ends` token → that element falls back to the default mode (no throw).
- No geocoded stops / no origin → unchanged fallbacks (round-robin greedy); `endMode` still set per group.
- A boulevard address with no pin (un-geocoded) → shows only the existing „не е на картата" badge, not the major-road badge (the major-road badge is for **located** stops).

## Testing

- **vitest** (client): `major-road.spec.ts` — flags `бул.`/`булевард`/`шосе`/`магистрала`/`E87`/`Е-85`, does not flag `ул. …`, handles null/empty.
- **jest** (server): `routing.service` spec — per-courier `endModes` yields per-group `endMode`; a `'last'` courier's measured total omits the return leg while a `'home'` sibling includes it; `endModes` absent → all default; default courier count is 1 when `?couriers=` omitted.
- Existing `route-split.spec.ts` (19) and all routing specs stay green (splitter + public signatures preserved).

## Non-goals

- No automatic pin relocation / OSM road-class lookup (Problem 1 is detect-and-prompt only).
- No change to the sweep-split balancing to account for per-courier ends.
- No migration; `courierCount` is left in settings, simply ignored.
- `'custom'` end mode gains no per-courier UI (legacy, not offered).
