# Delivery address: street/note split + best-effort geocoding

**Date:** 2026-06-21
**Status:** Approved design — ready for implementation plan
**Repos:** FarmFlow (backend + admin) · fermerski-pazar-chaika (storefront)

## Problem

When a customer's delivery address can't be confirmed by a Google Places pick,
the block/entrance free text (бл./вх./ет./ап.) pollutes server-side geocoding.
Google chokes on that noise and either rejects the result as too-coarse (→ no
coords, stop shows ⚠ unlocated) or snaps to the wrong point. The user asked
whether a parser should strip the "invalid" part before geocoding.

## Current pipeline (verified)

chaika checkout has **two** address fields:

- `addrInput` — street, wired to Google Places Autocomplete
  (`address-autocomplete.ts`). Gated on `PUBLIC_GOOGLE_MAPS_KEY`.
- `addrDetails` — free text "напр. бл. 12, вх. А, ет. 3, ап. 9" (Places never
  returns this).

On a successful pick the storefront captures exact `lat/lng` + structured
`city/postal`. The order then carries `deliveryLat/deliveryLng` and the backend
**skips geocoding entirely** — that path is already clean.

The pollution happens only in **no-pin fallback** paths, because
`composeAddress()` (`checkout-page.ts:85`) glues both fields into one
`deliveryAddress` string that then gets geocoded:

1. Storefront has no `PUBLIC_GOOGLE_MAPS_KEY` → plain text field, no pin → backend
   geocodes the whole merged string.
2. Customer hand-edits the address after picking → pin dropped
   (`address-autocomplete.ts:107`) → merged string geocoded.
3. Customer ignores the dropdown, types freehand → no pin → merged string.
4. Admin route re-geocode (`routing.service.ts setStopLocation`) reads
   `order.deliveryAddress` = the merged noisy string.

Backend geocode entry: `orders.service.ts` (~line 913) calls
`MapsService.geocode(dto.deliveryAddress, bias, { locality, postalCode })`.

## Decisions

- **Never block the sale.** Accept whatever the customer types; geocode
  best-effort; let the farmer fix the pin if it lands wrong. A storefront must
  not lose orders to validation friction.
- **Structural split, not a parser.** Keep the two UI fields separate all the
  way to the DB. A regex parser to strip бл./вх./ет./ап. from a merged string is
  fragile and would have to run in three places. Never merging is robust and
  needs no parser.

## Design

### 1. Data model

Add nullable column `orders.delivery_note` (text). Validated to max 120 chars in
the DTO. Drizzle-kit assigns the migration number (latest snapshot is `0050`, so
this is `~0051`).

- `deliveryAddress` → **street only** (geocodable)
- `deliveryNote` → бл./вх./ет./ап. + courier hint (display only, **never
  geocoded**)

Dedicated column (not the generic `orders.notes`) so it renders in the route
card's address block, distinct from general order notes.

### 2. chaika storefront (`src/scripts/checkout-page.ts`)

**Split the local `address` branch only.** Geocoding runs solely for local
`address` delivery (the `isLocal` gate in `orders.service.ts`); `econt_address`
is never geocoded, and the Econt waybill builder puts the whole street string in
its door label (`econt.service.ts: other: order.deliveryAddress`). So бл./вх.
pollution is exclusively a local-delivery problem, and the block/entrance MUST
stay inside `deliveryAddress` for Econt. Splitting only the local branch fixes
the bug with zero Econt risk.

- Local `address` branch:
  - `deliveryAddress = trim(addrInput.value)` (street only)
  - `deliveryNote = trim(addrDetails.value)` (бл./вх.; omit when empty)
- `econt_address` branch: **unchanged** — keeps `composeAddress()` (Econt needs
  the full string).
- Pin capture (`lat/lng/city/postal` from a pick) — **unchanged**.
- No hard block, no new required field. Submits with or without a pin exactly as
  today ("accept + clean").
- Pickup path that currently sets `notes` (e.g. "Вземане от пазара") is
  unaffected — that's order `notes`, not `deliveryNote`.

Consequence: `deliveryNote` is populated for local-delivery orders only — which
is exactly where it's needed (the farmer's route shows only `address` orders).

### 3. Backend DTO (`server/src/modules/orders/dto/create-order.dto.ts`)

- Add `deliveryNote?: string` — `@IsOptional() @MaxLength(120)`, trimmed.
- **Geocode logic needs no change.** It already geocodes `dto.deliveryAddress`
  only; because chaika now sends street-only there, the query is automatically
  clean. That is the entire win.

### 4. Persist + admin display

- `orders.service` create path → store `deliveryNote` on the order row.
- Route card / order panel → render a `deliveryNote` line under the address so
  the driver sees бл./вх. (read-only display; editable is out of scope unless
  requested).
- `setStopLocation` re-geocode → already reads `order.deliveryAddress`, now
  street-only → clean. **No change.**

### 5. Existing guardrails (kept — they already validate bad input)

The server already catches garbage and does NOT route to a wrong point:

- too-coarse geocode (town/postal/region centroid) → `null`
  (`COARSE_GEOCODE_TYPES` in `maps.service.ts`)
- result > 120 km from the farm bias → rejected (`MAX_BIAS_DISTANCE_KM`)
- unlocated stop → ⚠ in the route UI + farmer manual pin

We are not replacing these; we are feeding them a clean query.

## Non-goals (deliberately not doing)

- No regex parser; no backfill of existing rows. Old orders keep their merged
  `deliveryAddress` and a null `deliveryNote`, and render as before. Go-forward
  only.
- Farm base-address autocomplete (`location-route-card.tsx`,
  `address-autocomplete.tsx`) untouched — no бл./вх. concept for a farm origin.
- No hard checkout block; no new required city field.

## Backward compatibility

Existing orders: `deliveryAddress` may contain street+note glued together,
`deliveryNote` is null. They display and re-geocode exactly as today (no
regression, no improvement). New orders get the clean split.

## Files touched

- `packages/db/src/schema.ts` — add `deliveryNote` column
- `packages/db/drizzle/…` — generated migration (`~0051`)
- `fermerski-pazar-chaika/src/scripts/checkout-page.ts` — split payload
- `server/src/modules/orders/dto/create-order.dto.ts` — add validated field
- `server/src/modules/orders/orders.service.ts` (+ checkout.service if it maps
  the DTO) — persist `deliveryNote`
- admin route card / order-panel component(s) — render `deliveryNote`

## Testing

- DTO unit test: `deliveryNote` optional, `@MaxLength(120)` enforced, trimmed.
- Geocode regression: an order with street + a note value geocodes the street
  only (note never reaches `MapsService.geocode`).
- Backward-compat check: an existing order with a merged `deliveryAddress` and
  null `deliveryNote` still renders.
- chaika has no jest (workspace) → verify via `astro build` + a manual checkout
  smoke that the payload carries the two fields separately.

## Rollout

No new deps. Migration `~0051` must run on PROD (Dokploy). chaika auto-deploys;
FarmFlow needs a Dokploy redeploy. Safe to ship independently — the backend
accepts the new optional field whether or not chaika sends it yet.

## Risks

- A customer who ignores the two-field UI and types everything (street + бл./вх.)
  into `addrInput` still pollutes that one field. Best-effort only; the two-field
  UI guides them and the server guardrails catch a bad result. Acceptable.
