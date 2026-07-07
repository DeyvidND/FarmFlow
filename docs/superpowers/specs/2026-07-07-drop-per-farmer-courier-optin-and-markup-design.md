# Drop the per-farmer courier opt-in + the courier markup

**Date:** 2026-07-07
**Branch base:** `feat/editable-orders` (create a fresh branch off `main` for this work)
**Status:** design — awaiting review

## Goal

Simplify delivery to a single, obvious model:

1. **No per-farmer courier opt-in.** Remove the `farmers.courier_enabled` checkbox
   entirely. A farmer offers courier delivery whenever they have a carrier
   (Econt or Speedy) connected — nothing else to toggle.
2. **No courier markup.** Remove `pricing.courierMarkupStotinki`. The customer
   pays the raw courier price (товарителница). The farm no longer marks up
   shipping.

After this, the only delivery prices a farm sets are:
- the **own/local delivery** fee (`ownSlots` pricing), and
- the global **free-over-threshold** (`freeThresholdStotinki`) — above that basket
  sum, courier is free (the farm absorbs it).

The Econt/Speedy **flat fallback fee** (`econtFeeStotinki` / `econtAddressFeeStotinki`)
**stays** — it is not a markup; it is the price in Econt *manual* mode (farm ships
itself, no API) and the fallback when a live quote is unavailable.

## Current behavior

- **Eligibility gate** (`farmerCourierReady`): `courier_enabled AND (econt|speedy configured)`.
  Consumed by:
  - `farmers.service.ts:478` — sets `PublicFarmer.courierReady` for the storefront.
  - `orders.service.ts:1907` — checkout backstop that rejects a courier order for an unready farmer.
- **Per-product opt-out** (`products.courier_disabled`) is separate and **stays** —
  a product can be pickup-only even for a courier-ready farmer. Today the product
  screens additionally gate this toggle behind "does the farmer have courier enabled".
- **Markup** (`courierMarkupStotinki`, default 0): added on top of the courier fee
  the customer pays, on courier methods only, before the free-over threshold.

## Decisions (confirmed with the operator)

- **Full column removal** of `farmers.courier_enabled` (migration `0080`), not a soft hide.
- **Keep** the Econt/Speedy flat fallback fee. Remove **only** the markup.

## Target behavior

- **Eligibility gate** becomes: `(econt|speedy configured)`. Connecting a carrier is
  the single switch. Per-product `courier_disabled` opt-out is unchanged.
- **Markup** gone: courier fee = live/fallback courier price, then free-over threshold.

---

## Change 1 — remove `farmers.courier_enabled`

### DB
- `packages/db/drizzle/0080_drop_farmers_courier_enabled.sql` — **hand-written**:
  `ALTER TABLE "farmers" DROP COLUMN "courier_enabled";`
- Update `packages/db/drizzle/meta/_journal.json` + write the matching snapshot
  (follow the existing drop migrations `0046`/`0047` as the pattern).
- `packages/db/src/schema.ts:906` — drop the `courierEnabled` column definition.

### Server
- `courier-eligibility.ts` — `farmerCourierReady(ns)` drops the `courierEnabled`
  param; body becomes `!!(ns?.econt?.configured || ns?.speedy?.configured)`.
  Update the docstring.
- `farmers.service.ts:478` — call `farmerCourierReady(ns)` (drop `rest.courierEnabled`).
- `orders.service.ts:1900,1907` — drop `courierEnabled` from the farmer select and
  the `farmerCourierReady(...)` call.
- `farmers/dto/create-farmer.dto.ts:73` + `update-farmer.dto.ts` — remove the field.
- `farmers.service.ts` (create/update paths) — stop persisting `courierEnabled`.
- `farmers.controller.ts:34` — update the comment that explains why `courierEnabled`
  is surfaced.
- `platform.service.ts` — remove `courierEnabled` from `PlatformTenantDetail.farmers`,
  `GlobalFarmerRow`, `FarmerDetail` (interfaces at 203/227/262), the three farmer
  selects (570/689/836) and the three row builders (627/750/906).
- `packages/types/src/index.ts:148` — the `courier_enabled AND …` doc comment on the
  `courierReady` field; reword to "≥1 carrier connected".

### Frontend — panel (`client/`)
- `farmers/farmer-panel.tsx` — remove the checkbox (state at :61, payload at :106,
  markup at :273–281).
- `lib/types.ts:117` — remove `Farmer.courierEnabled`.
- `products/product-dialog.tsx:64` — `farmerHasCourier` currently reads
  `farmer.courierEnabled`. It gates the per-product courier toggle's helper/disabled
  state. After removal, treat every farmer as courier-capable (the per-product
  `courierDisabled` opt-out is always meaningful); drop the `farmerHasCourier` gate.
- `products/courier-settings-modal.tsx:41,100` — `farmerCourier` map + `noFarmerHasCourier`
  warning both read `f.courierEnabled`. Remove that gating; the modal's per-product
  toggles no longer depend on a farmer flag.
- `products/page.tsx:24` — remove the comment about farmers' `courierEnabled`.

### Frontend — admin (`admin/`)
- `lib/api-client.ts:70,98,211` — drop `courierEnabled` from the farmer types.
- `producers-client.tsx:45,149,152` — remove the "с куриер" count + the Вкл/Изкл badge.
- `producer-detail.tsx:99,102` — remove the "Куриер вкл/изкл" flag.
- `tenant-detail-client.tsx:423,466,469` — remove the "N с куриер" count + the badge.

### Tests
- `courier-eligibility.spec.ts` — rewrite for the 1-arg signature (ready ⇔ carrier connected).
- `orders.courier.spec.ts` — drop `courierEnabled` from the `farmerRows` fixtures;
  the "not ready" case (:308–309) now means "no configured carrier".
- `farmers.update.spec.ts` — remove the `courierEnabled` persistence test.
- `platform.service.spec.ts` — drop `courierEnabled` from fixtures/expectations.

## Change 2 — remove the courier markup

- `client/src/lib/types.ts:236` — remove `courierMarkupStotinki` from the pricing type.
- `delivery/methods-section.tsx:374–380` — remove the "Надценка върху куриерската цена"
  input (and, if it leaves an empty row, tidy the "Общи правила" layout).
- `server/.../delivery-pricing.ts` — remove `courierMarkupStotinki()` and drop the
  markup from `buildPublicDelivery` (`econtFeeStotinki`/`econtAddressFeeStotinki` no
  longer add `markup`); remove `DeliveryConfig.pricing.courierMarkupStotinki`; update docstrings.
- `checkout.service.ts:329,354` — drop `+ courierMarkupStotinki(cfg)`; remove the import (:26).
- `public-cache.service.ts:16,80,299` — remove the `courierMarkupStotinki` field from
  the public payload + its import.
- `econt-app/shipping-quote.service.ts:32,45` + `buildQuoteResult` in
  `shipping-quote.helpers.ts` — drop the `markupStotinki` param (it was added equally
  to both carriers, so cheapest-selection is unaffected); update
  `public-shipping-quote.controller` call site + its spec fixtures (`courierMarkupStotinki: 200/0`).

## Out of scope
- `tenants.deliveries_package_enabled` (super-admin "Пакет Доставки" gate) — untouched.
- Carrier-choice policy / cheapest selection logic — untouched (farmer still ships with
  whichever carrier is cheaper; that already works and needs no markup to do so).
- Per-product `courier_disabled` opt-out — stays.

## Verification
- Backend: `courier-eligibility`, `orders.courier`, `delivery-pricing`, `checkout`,
  `platform.service`, `shipping-quote` specs green; storefront `courierReady` still
  flips on carrier connect/disconnect (cache-bust path unchanged).
- Manual: farmer with a connected carrier → storefront shows "Куриер" with no
  per-farmer toggle anywhere; a courier order at checkout is priced at the raw
  courier fee (no markup), free above the threshold; local delivery fee unchanged.
