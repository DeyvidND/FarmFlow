# Route stop „Смени адрес" modal — design

**Date:** 2026-07-07
**Branch base:** `feat/drop-farmer-courier-optin` (or a fresh branch off it)
**Area:** client — delivery route screen (`client/src/components/route/*`)

## Problem

On the delivery route screen (`Маршрут за доставка`), a farmer can only correct a
stop's address when it failed to geocode ("не е на картата"). That correction is an
inline panel with **two competing mechanisms**:

- a flat text input (`Намери`), and
- a "Постави на картата" button that closes the panel and enters a **big-map**
  placing mode (amber banner, click the shared route map to drop a pin).

There is no way to change the address of a stop that **did** geocode (e.g. the pin
landed on the wrong building). The two placing mechanisms (inline text vs big-map
click) are confusing.

## Goal

One icon on **every** stop that opens a single modal offering **two ways** to set
the delivery point:

1. **Адрес** — type/search an address (Places autocomplete).
2. **Карта** — click a point on a small map embedded in the modal.

The existing "не е на картата" (invalid-address) affordance opens the **same**
modal. Retire the old flat-text inline path and the big-map placing flow.

## Non-goals

- No server/API change. The endpoint `PATCH orders/route/stop/:id`
  (`setStopLocation`) already persists to `orders.deliveryAddress/Lat/Lng` and
  already accepts either `{ address }` (geocode) or `{ lat, lng }` (manual pin).
- No change to how the route is computed/ordered.
- No change to the base-address setup (`LocationRouteCard` / „Локация" button).

## Existing behaviour (reference)

- `stop-list.tsx` — per-stop row. Icon cluster top-right: `Navigation` (Google
  Maps), `Phone`, `Mail`. Un-geocoded stops render an inline `FixLocation` panel
  (`Намери / постави на картата`) → text input **or** big-map placing.
- `route-client.tsx` — owns `placingId` + `onPlaceOnMap`; renders the amber
  "click the map" banner over `RouteMap`; passes `placing`/`onMapClick` to the map.
- `route-map.tsx` — when `placing`, a map click calls `onMapClick(lat, lng)`.
- `AddressAutocomplete` — Places API (New) REST field, own `placesKey`.
  `onChange(text)` / `onPick({lat,lng}|null)`. Degrades to a plain text field with
  no key.
- Server `setStopLocation(tenantId, orderId, { address?, lat?, lng? })`:
  requires `deliveryType === 'address'`; `lat`+`lng` present → manual pin, keep
  address = typed || existing; else geocode `address` (biased to farm). Rejects a
  non-address order and an un-findable address.

## New component: `edit-address-modal.tsx`

`client/src/components/route/edit-address-modal.tsx`

```
EditAddressModal({
  stop,        // RouteStop — id, address, lat, lng, customer
  origin,      // RouteResult['origin'] — farm coords, for map centering + ★ marker
  mapsKey,     // Maps JS key (embedded pick-map)
  placesKey,   // Places key (autocomplete)
  onClose,     // () => void
  onSaved,     // () => void  — parent re-fetches the route
})
```

Two **tabs**: `Адрес` | `Карта`. Default tab = `Карта` when the stop already has a
pin (you're nudging an existing point), else `Адрес` (you need to find it first).

### Tab „Адрес"

- `AddressAutocomplete` prefilled with `stop.address`.
- Local state: `addr: string`, `pin: {lat,lng} | null` (from a suggestion pick;
  cleared on manual typing by the component's `onPick(null)`).
- Save (`Запази`):
  - empty `addr` → toast „Въведи адрес", abort.
  - `setStopLocation(stop.id, { address: addr.trim(), ...(pin ?? {}) })`.
  - On the `UnprocessableEntity` "адресът не е намерен" error → toast the message,
    suggest the „Карта" tab. Keep modal open.
  - Success → toast, `onSaved()`, `onClose()`.

### Tab „Карта"

- Small Google map (`@vis.gl/react-google-maps` — `APIProvider`+`Map`+
  `AdvancedMarker`), height ~300px, `mapId="DEMO_MAP_ID"`, `gestureHandling="greedy"`.
- Center/zoom: existing stop pin if located, else farm origin, else BG centroid.
- Markers: draggable stop pin (green) + a non-interactive farm ★ for reference.
- Local state `pin: {lat,lng} | null` initialised from `stop.lat/lng`.
- Map click **or** marker drag → update `pin`.
- Without a `mapsKey` (local dev) → render a short "картата не е налична, ползвай
  таб Адрес" note instead of the demo map.
- Save (`Запази точката`):
  - no `pin` → toast „Кликни на картата", abort.
  - `setStopLocation(stop.id, { lat: pin.lat, lng: pin.lng })`.
  - Success → toast, `onSaved()`, `onClose()`.

Modal chrome mirrors `LocationRouteCard` (fixed overlay `z-[90]`, `animate-ff-pop`
card, `X` close, `role="dialog"`). Reuse `Button` for the primary action.

## Changes to `stop-list.tsx`

- Add an **edit** icon button (`MapPinned`, title `Смени адрес`) to every stop's
  icon cluster → calls `onEditAddress(stop)`.
- The amber „не е на картата" element becomes a `<button>` → also `onEditAddress(stop)`
  (keep the icon + wording, add „— натисни, за да поправиш").
- **Remove** `FixLocation` component and its usage.
- **Remove** props `placingId`, `onStartPlace`, `onCancelPlace`.
- **Add** prop `onEditAddress: (stop: RouteStop) => void`.

## Changes to `route-client.tsx`

- New state `editStop: RouteStop | null`.
- Render `<EditAddressModal>` when `editStop` set, wired to `setEditStop(null)` /
  `router.refresh()` + `setEditStop(null)`.
- Pass `onEditAddress={setEditStop}` to `StopList`.
- **Remove** `placingId`, `placingStop`, `onPlaceOnMap`, the amber "click the map"
  banner over the map, and the `placing`/`onMapClick` props on `RouteMap`.
- Keep the top „X адреса не са намерени" guard banner; tweak copy to point at the
  edit icon.

## Changes to `route-map.tsx`

- **Remove** `placing` and `onMapClick` props + the `onClick` placing handler and
  `draggableCursor`. The map is display-only again; the modal owns pin-picking.

## Help copy

Update the „⚠ не е на картата" bullet in the help modal (`route-client.tsx`) to:
"натисни иконата за адрес (или жълтия етикет) при спирката → въведи адрес или
цъкни точното място на картата."

## Data flow

```
stop edit icon / amber chip
  └─> route-client: setEditStop(stop)
        └─> EditAddressModal
              ├─ tab Адрес: AddressAutocomplete → setStopLocation({address,...pin})
              └─ tab Карта: pick-map → setStopLocation({lat,lng})
                    └─> onSaved() → router.refresh() → new geocoded route
```

## Testing / verification

- Server unchanged → existing `routing.set-location.spec.ts` still covers the API.
- Client verification via the preview server (drive the flow):
  1. Open a stop's edit icon → modal opens on the right default tab.
  2. Адрес tab: change text, pick a suggestion, save → pin moves, list refreshes.
  3. Карта tab: click the map / drag the pin, save → pin moves.
  4. „не е на картата" chip on an un-geocoded stop opens the same modal.
  5. No `mapsKey` locally → Карта tab shows the fallback note, Адрес tab still works.
- `astro check` is N/A (Next client). Run the client typecheck/build.

## Risk / notes

- Two `APIProvider` instances on the page (main route map + modal pick-map) share
  the same key; `@vis.gl/react-google-maps` dedupes the Maps JS loader by key, so
  this is safe.
- All stops in the route are `deliveryType === 'address'` (the route lists only
  address deliveries), so the server's non-address guard won't fire from here.
```
