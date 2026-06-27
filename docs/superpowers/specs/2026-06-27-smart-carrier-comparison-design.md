# Smart Carrier Comparison at Checkout

**Date:** 2026-06-27
**Status:** Design approved, pending spec review

## Summary

At checkout, when a customer chooses door-to-address delivery, show a live
price comparison between Econt and Speedy, flag the cheaper one, and let the
customer pick. Prices are COD-aware so the "най-евтин" badge is honest. This
turns the two existing single-carrier flows into a transparent
choose-your-courier experience.

## Goal & non-goals

**Goal:** Let the customer see Econt vs Speedy price for their address and pick,
with the cheaper option pre-selected and clearly marked.

**Non-goals:**
- No delivery-time (срок) display — both carriers are ~1–2 days nationwide;
  identical ETA is noise.
- No office-pickup comparison — Econt and Speedy offices are different physical
  locations, so office pickup is inherently a carrier-first choice and stays
  as-is.
- No live per-address ETA API calls.

## Scope & activation

- **Door-to-address delivery only.** Office pickup, local own-delivery, and
  market pickup are unchanged.
- Comparison **activates only when the farm has BOTH** carriers live:
  - Econt `settings.delivery.econt.mode === 'auto'`
  - Speedy configured with live pricing (`settings.delivery.speedy.configured`)
- If only one carrier is live → current single-carrier flow, untouched.
- Comparison is **price-only and COD-aware**.

## Customer flow

1. Customer selects "Доставка до адрес" and enters city + address.
2. Customer picks payment method (карта / наложен платеж).
3. Storefront calls the compare endpoint with destination + weight + COD info.
4. UI renders two selectable rows, cheaper pre-selected:
   ```
   ◉ Спиди      4.20 лв   [Най-евтин]
   ○ Еконт      4.90 лв
   ```
   When COD is selected, a footnote reads:
   "Цената включва такса наложен платеж."
5. If the order subtotal is at/above the free-shipping threshold → both carriers
   are free → show "Безплатна доставка", hide the comparison and the badge.
6. The customer may override and pick the pricier carrier — their choice is
   respected.

## Backend design

### Compare endpoint

- **Extend `CompareShipmentDto`** (`server/src/modules/econt-app/shipping-quote.controller.ts` / DTO):
  add `cod?: { enabled: boolean; amountStotinki: number }`.
- **Weight derivation:** sum cart item weights when available, fall back to the
  tenant `defaultPackage.weightKg`, then to 1000g. Reuse the existing 0.5kg
  bucketing and Redis cache (`econt:estimate:*`, `speedy:estimate:*`, 8h TTL).
- **`ShippingQuoteService.compare`** passes the COD surcharge into both
  `estimateShipping` calls so the returned prices are COD-true. Each carrier
  degrades independently: if one carrier's estimate fails/returns null, still
  return the other's price (and suppress the badge — see edge cases).

### Data model

The current `deliveryType` enum (`pickup` | `address` | `econt` |
`econt_address`) conflates carrier and mode and has **no Speedy door value**.

**Decision (approved):** add an `orders.carrier` column.

- `orders.carrier`: nullable text, `'econt' | 'speedy'`.
- `deliveryType` stays the *mode*; `econt_address` is treated as the generic
  "до адрес" (door) mode regardless of carrier.
- The customer's pick writes `orders.carrier`.
- `shippingStotinki()` and label creation read `orders.carrier` to route to the
  correct carrier.
- New migration (~0066). **Hand-write the migration** — drizzle generate is
  broken in this repo (snapshots stop at 0059).

### Order creation

- **Extend `CreateOrderDto`**: add `carrier?: 'econt' | 'speedy'`, validated
  against the two carriers that were actually quoted.
- **`shippingStotinki()`** (`server/src/modules/orders/checkout.service.ts`):
  when comparison is active, trust the *carrier* the customer chose but
  **re-quote server-side** — never trust the client-sent price. Fold the
  authoritative server price into the order total.

## Edge cases

- **One carrier returns a price, the other fails** → show the single available
  price, no comparison UI, no "най-евтин" badge.
- **Both estimates fail** → fall back to the configured flat fee
  (`econtFallbackFee`), i.e. current behavior.
- **Server re-quote differs from the price shown to the customer** (cache drift /
  stale estimate) → the server price is authoritative; use it. This also
  prevents client-side price tampering.
- **Order ≥ free threshold** → short-circuit to free; skip both estimate calls.

## Testing

**Unit:**
- compare with COD and without COD (surcharge changes which is cheapest)
- one-carrier-down path (single price, no badge)
- free-threshold short-circuit (no estimate calls)
- weight derivation (cart weights → defaultPackage → 1000g fallback)

**Integration:**
- checkout creates an order with the chosen `carrier` persisted
- order total folds the re-quoted server price (not the client price)
- label creation routes to the chosen carrier
- single-carrier farm: comparison inactive, legacy flow intact

## Affected files (orientation, not exhaustive)

- `server/src/modules/econt-app/shipping-quote.controller.ts` — DTO + endpoint
- `server/src/modules/econt-app/shipping-quote.service.ts` — COD-aware compare
- `server/src/modules/econt/econt.service.ts` — `estimateShipping` COD param
- `server/src/modules/speedy/speedy.service.ts` — `estimateShipping` COD param
- `server/src/modules/orders/checkout.service.ts` — `shippingStotinki()` re-quote
- `server/src/modules/orders/dto/create-order.dto.ts` — `carrier` field
- `packages/db/src/schema.ts` — `orders.carrier` column
- `packages/db/migrations/0066_*.sql` — hand-written migration
- storefront checkout (chaika + `client`) — comparison UI + quote fetch
