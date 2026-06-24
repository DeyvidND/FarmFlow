# Cheapest-Courier Quote (Econt vs Speedy) — Design

**Date:** 2026-06-24
**Branch:** `feat/econt-standalone-service`
**Status:** Approved — ready for implementation plan

## Goal

In the standalone shipping service, let a producer enter one shipment in a courier-neutral way and instantly see what **both** Econt and Speedy would charge, with the cheaper one highlighted. The producer then continues to that carrier's existing create flow. This is the payoff of having two couriers: "we pick the cheapest for you."

## Scope

- **In:** A read-only quote endpoint that estimates Econt + Speedy in parallel for a neutral destination and returns sorted prices + the cheapest carrier.
- **Out (this round):** Auto-creating the waybill with the cheapest carrier ("smart-create") — deferred to a later round once live Speedy field names are spiked. Creation stays via the existing per-carrier create endpoints. No FarmFlow-panel / storefront / checkout changes.
- **Quote-only, advisory:** prices are a city-level estimate (exact office barely moves price); the producer makes the final pick.

## Flow

1. Producer enters: destination city/town + delivery mode (office/door) + weight + optional COD.
2. Backend resolves the destination per carrier, estimates both in parallel (short timeout, degrade independently).
3. Returns sorted quotes + the cheapest carrier.
4. UI shows e.g. „Speedy 3.90 € · Econt 4.50 € — най-евтино: Speedy"; producer clicks the winner → existing `/speedy/*` or `/shipping/*` create form (with exact office/street).

## Input / output contract

**`POST /shipping/compare`** — JWT-only (`@CurrentTenant`), `@Throttle` 30/min. **Not** activation-gated (pre-purchase; showing prices to unactivated accounts drives conversion).

Request (courier-neutral):
```ts
{
  destinationCity: string;          // free-text city/town the producer typed
  deliveryMode: 'office' | 'address';
  weightGrams?: number;             // default from each carrier's package default
  codAmountStotinki?: number;       // 0/omitted → no COD; included in the priced fee
}
```

Response (quotes sorted cheapest-first; unavailable carriers sort last):
```ts
{
  quotes: Array<{ carrier: 'econt' | 'speedy'; priceStotinki: number | null; available: boolean }>;
  cheapest: 'econt' | 'speedy' | null; // null when both unavailable
}
```

## Architecture

Three units, each with one responsibility:

1. **`SpeedyService.estimateShipping(tenantId, input)`** (new method) — `POST /calculate` (reuses `buildShipmentRequest`). Returns `number | null` (stotinki) — **never throws** (degrades like Econt's checkout estimate). 6s timeout. Cached in Redis, key `speedy:estimate:<tenantId>:<siteId>:<weightBucket>kg:<cod?1:0>`, 8h TTL (mirrors Econt's estimate cache). Speedy `/calculate` requires a `serviceId` → use `settings.delivery.speedy.defaultServiceId`, falling back to a module constant `SPEEDY_DEFAULT_SERVICE_ID`. **spike:** confirm the calculate price field name + a valid default serviceId via `/services/destination`.

2. **`EcontService.estimateShipping`** (already exists — `(tenantId, order, items) → Promise<number | null>`, 6s, cached). Reused; the quote service adapts the neutral input into its order-like shape (`deliveryType` econt/econt_address, `deliveryCity`, `econtOffice` left empty for a city-level estimate). **One additive change:** Econt's estimate currently reads weight from the tenant's `defaultPackage.weightKg`, ignoring per-shipment weight — but a fair compare requires both carriers to price the **same** weight. Add an optional `weightKgOverride?: number` parameter to `estimateShipping` (and fold it into its cache key); existing callers (checkout) pass nothing and are unaffected (backward-compatible, additive — the only touch to shipped Econt code, covered by a test). **spike:** confirm Econt office-mode calculate works at city granularity without an office code; if not, pass a representative office.

3. **`ShippingQuoteService`** (new, in `econt-app`; injects `EcontService` + `SpeedyService`) — orchestration only:
   - Resolve the destination per carrier: Econt uses `destinationCity` text directly; Speedy resolves `destinationCity` → `siteId` via the existing `SpeedyService.searchSites` (cached); if no siteId, Speedy quote is `available:false`.
   - Call both estimates in `Promise.allSettled` (parallel).
   - Normalize → `{ carrier, priceStotinki, available }`, sort cheapest-first (available before unavailable; stable order on tie), compute `cheapest`.
   - A pure helper `buildQuoteResult(econtStotinki, speedyStotinki)` holds the sort/cheapest logic (unit-tested).

4. **`ShippingQuoteController`** (new, in `econt-app`) — `@Post('shipping/compare')`, JWT guard + throttle, delegates to `ShippingQuoteService`.

5. **Config:** extend the Speedy credentials/config save so the producer sets `defaultServiceId` once (`settings.delivery.speedy.defaultServiceId`). Add an optional `defaultServiceId` field to `SpeedyCredentialsDto` (or a small config-patch endpoint); store in `SpeedyStored`.

## Address resolution (the carrier mismatch)

Econt prices by free-text city; Speedy by `siteId`. Both price mostly on **city + weight + COD** — exact office barely changes the fee, so a city-level quote is the advisory number:
- **Econt:** pass `destinationCity` straight into its estimate.
- **Speedy:** `searchSites(destinationCity)` → take the best match's `siteId` → `/calculate` with that siteId + the configured `defaultServiceId`. No match → Speedy `available:false` (UI tells the producer to refine the city).

## Error handling / timeout / degradation

- Both estimates run in parallel, 6s each. One fails/times-out → that carrier `available:false`, `priceStotinki:null`; the other still shows. Both fail → `cheapest:null`, both unavailable (UI: „цените временно недостъпни").
- Estimates never surface a 5xx to the producer — always a 200 with availability flags.
- COD fee is included in both prices (`codAmountStotinki` flows into both estimate bodies).
- A carrier with no credentials configured → `available:false` (not an error).

## Testing

- **Pure:** `buildQuoteResult` unit-tested — both available (sort by price), one available (it wins, other last), both null (`cheapest:null`), tie (stable carrier order), COD vs no-COD passthrough. Speedy estimate cache-key + body build covered via the existing helper tests.
- **Service methods:** repo convention (no db-mock).
- **Boot smoke:** `POST /shipping/compare` on a configured tenant returns the `{quotes, cheapest}` shape; with no credentials returns both `available:false`.

## Spikes (deferred to live Speedy demo)

- Speedy `/calculate` price field name + a valid default `serviceId` (resolve via `/services/destination`).
- Econt office-mode estimate at city granularity without an office code (else pass a representative office code).

## Out of scope (explicit)

Smart-create with cheapest, FarmFlow-panel/storefront/checkout changes, multi-parcel quoting, saved-quote history, cross-carrier address auto-mapping beyond city→siteId.
