# Route stop edit-address modal — merge Адрес/Карта into one view

**Date:** 2026-07-07
**Area:** client — `client/src/components/route/edit-address-modal.tsx`; server — `server/src/common/maps/maps.service.ts`, `server/src/modules/routing/*`

## Problem

The „Смени адрес" modal (shipped earlier today, see
[2026-07-07-route-edit-address-modal-design.md](2026-07-07-route-edit-address-modal-design.md))
has two separate tabs — Адрес (autocomplete text) and Карта (click-to-pin) — that
don't talk to each other. Picking an address doesn't show where it landed on a
map; dropping a pin doesn't tell you what address that point resolves to. The
farmer has to guess which tab to use and can't cross-check one against the other.

## Goal

Merge the two tabs into **one view**: the address field and the map are both
visible at once, and they stay in sync — a picked suggestion moves the pin, and
a map click/drag fills in the address.

## Non-goals

- No change to the trigger points (edit icon, amber „не е на картата" chip) or
  to `setStopLocation`'s save contract beyond the payload shape described below.
- No change to the big shared route map (`route-map.tsx`) — it stays display-only,
  untouched by this change.
- No live forward-geocoding as the farmer types free-hand text (no debounced
  geocode-as-you-type). Only a Places suggestion pick moves the pin from the
  address side.

## Sync rules (the core of this design)

**Map → address (reverse geocode):**
A map click or a marker drag immediately moves the pin (visual feedback is
instant). After a 500ms debounce, the client calls a new reverse-geocode
endpoint with the pin's coordinates and — if Google resolves an address —
overwrites the address field with the result. If nothing resolves (open sea,
outside Bulgaria, transient API error), the address field is left untouched and
no error is shown; this is a soft convenience, not a required step. The pin
already reflects the click regardless of whether the reverse lookup succeeds.

**Address → map (suggestion pick only):**
Picking a suggestion from `AddressAutocomplete` moves the pin to that
suggestion's exact coordinates. Free-hand typing (no pick) only updates the
text — it does **not** move the pin. Per `AddressAutocomplete`'s existing
behavior, typing invalidates a pin that came from a **previous suggestion
pick** (`onPick(null)` fires on every keystroke) — this is intentional and
unchanged: it stops an edited address from being saved alongside a
now-mismatched pin.

A pin that came from a **map click/drag**, however, must **not** be cleared by
subsequent free-hand typing in the address field. Reasoning: after a map click,
the reverse-geocode result is written into the address field programmatically
(`setAddr(...)`, not through the input's `onChange`), so it never triggers the
autocomplete's invalidation path in the first place. If the farmer then
hand-edits that text (e.g. adds a floor/apartment note), the pin the map click
already placed should survive — the farmer explicitly confirmed that point by
clicking it. Only a **new** suggestion pick or a **new** map interaction
replaces it.

Net effect: whichever action happened **last** — a suggestion pick or a map
click/drag — wins and determines the current pin. Free-hand text edits never
move or clear the pin.

## UI change

Remove the tab switcher entirely. Single vertical layout inside the same modal
chrome (unchanged header, close button, overlay):

1. Header: „Смени адрес — {customer}" (unchanged).
2. One-line explainer under the header:
   *„Избери от подсказките или кликни/провлачи пина на картата — адресът и
   точката се обновяват заедно."*
3. `AddressAutocomplete` field (unchanged component/props).
4. The embedded pick-map (unchanged 300px map, farm ★ marker, draggable green
   stop pin) directly below the address field — always rendered when a
   `mapsKey` is available. Without a key: the existing fallback note
   ("Картата не е налична тук…") renders in the map's place; the address field
   above it still works exactly as before (server geocodes on save).
5. One Save button (replacing the two separate `saveAddress`/`saveMap`
   buttons).

## Removed

- The `TABS` array and the tab-switcher `<div>`.
- `EditTab` type and `initialEditTab()` from `edit-address.ts` — meaningless
  once there's only one view. (`stopIsLocated` also becomes unused by this
  file; it was only ever consumed by `initialEditTab`. Delete both from
  `edit-address.ts` and its test.)
- The two separate `saveAddress`/`saveMap` functions, replaced by one `save()`.

## New save payload logic

Replace `addressPayload` (from `edit-address.ts`) with a merged version that
allows a pin without any address text (the old `saveMap` behavior — the server
already supports omitting `address` and keeping the order's existing address):

```ts
function mergedPayload(
  addr: string,
  pin: { lat: number; lng: number } | null,
): { address?: string; lat?: number; lng?: number } {
  const address = addr.trim();
  if (pin) return address ? { address, lat: pin.lat, lng: pin.lng } : { lat: pin.lat, lng: pin.lng };
  return { address };
}
```

Save button is disabled when `saving`, or when there's no pin **and** no
non-empty address text (nothing to save). When there's no pin, an empty
address blocks save with the existing „Въведи адрес" toast; when there's a
pin, an empty address is allowed (mirrors the old Карта-tab behavior).

## New server piece: reverse geocoding

**`MapsService.reverseGeocode(lat, lng): Promise<string | null>`**
(`server/src/common/maps/maps.service.ts`) — mirrors the existing `geocode()`
method: same `GEOCODE_URL`, but with `latlng=<lat>,<lng>` instead of
`address=<query>`, `language=bg&key=<apiKey>`. Returns the first result's
`formatted_address` (stripped of the trailing "България"/"Bulgaria" suffix,
matching the client's existing `AddressAutocomplete` formatting behavior).
Returns `null` when disabled (`!this.enabled`), on `ZERO_RESULTS`, or on any
error — same graceful-degradation contract as every other method on this
class. Cached with the same `cachedGet`/`cachedSet` helpers, keyed by rounded
coordinates (`lat.toFixed(5)`, `lng.toFixed(5)` — ~1m precision, plenty for a
delivery pin) with the existing `GEOCODE_CACHE_TTL` (30 days) — a physical
point's address is as stable as an address's coordinates.

**New endpoint:** `GET orders/route/reverse-geocode?lat=<num>&lng=<num>` on the
existing `RoutingController` (`server/src/modules/routing/routing.controller.ts`).
Same guards as the sibling route endpoints (`JwtAuthGuard`,
`ActiveSubscriptionGuard`) — no tenant-scoped data involved (pure Google
passthrough), the guard is there to keep the endpoint from being an open proxy
for arbitrary reverse-geocode calls. Validates `lat`/`lng` are parseable
numbers (400 otherwise). Returns `{ address: string | null }`.

**New client call:** `reverseGeocode(lat: number, lng: number): Promise<{ address: string | null }>`
in `client/src/lib/api-client.ts`, alongside `setStopLocation`, using the same
`apiFetch` helper (`GET` with query params).

## Data flow

```
map click/drag
  └─> setPin(coords) [instant, marker moves]
  └─> debounce 500ms
        └─> reverseGeocode(lat, lng) → { address }
              └─> if address: setAddr(address)  [does NOT go through
                  AddressAutocomplete's onChange, so no onPick(null) fires]

AddressAutocomplete onPick(coords | null)
  └─> coords non-null (a real suggestion pick) → setPin(coords)
  └─> coords null (typing) → no-op on pin (pin only changes on an actual pick
      or a map interaction — see Sync rules above)

Save
  └─> mergedPayload(addr, pin) → setStopLocation(stop.id, payload)
        └─> onSaved() → onClose()
```

## Testing / verification

- `edit-address.ts` / `edit-address.test.ts`: remove `EditTab`/`initialEditTab`
  tests, keep/adapt `mergedPayload`'s tests (replacing `addressPayload`'s) to
  cover: address+pin, address-only (no pin), pin-only (empty address, pin
  present).
- Server: extend `maps.service.spec.ts` with `reverseGeocode` cases mirroring
  the existing `geocode()` test shape (stub mode → null, successful reverse
  lookup → address string, `ZERO_RESULTS` → null, cache hit avoids a second
  HTTP call).
- Client component (modal itself): no vitest coverage, by this project's
  established convention (`vitest.config.ts` collects only `src/**/*.test.ts`).
  Verified by typecheck + manual preview drive of `/route`: click map → address
  fills in; pick a suggestion → pin moves; type free-hand after a map click →
  pin survives; save with pin-only (no address) succeeds.

## Risk / notes

- The reverse-geocode endpoint adds one more authenticated, rate-limited-by-guard
  Google Maps call surface. Debouncing on the client (500ms) plus the existing
  server-side cache keeps this cheap — a farmer nudging a pin around a few
  times before settling triggers at most one billed call per settled position
  per 30-day cache window.
- `formatted_address` stripping (trailing "България"/"Bulgaria") duplicates a
  regex already inlined in `address-autocomplete.tsx:133`. Not worth extracting
  a shared helper for one duplicated one-liner across two files — flagged here
  so it isn't mistaken for an oversight.
