# Configurable delivery pricing — design

**Date:** 2026-06-05
**Status:** Approved (brainstorm), pending implementation plan

## Problem

A rich per-tenant delivery config already exists in `settings.delivery` (jsonb) and
the admin delivery page (`methods-section.tsx`, `pricing-section.tsx`) fully edits it:
per-method pricing (`free` / `flat` / `freeOver` with `feeStotinki` / `freeOverStotinki`),
a global `freeThresholdStotinki`, weight tiers and zones. **But nothing reads it at
checkout.** The server (`server/src/modules/orders/checkout.service.ts`) prices delivery
from hardcoded constants:

```
FREE_SHIPPING_THRESHOLD_STOTINKI = 4000
SHIPPING_ADDRESS_STOTINKI        = 490
SHIPPING_ECONT_STOTINKI          = 350
SHIPPING_ECONT_ADDRESS_STOTINKI  = 590
```

and the Astro storefront (`fermerski-pazar-chaika/src/scripts/checkout-page.ts`) mirrors
its own hardcoded values (`FREE_OVER = 40`, `SHIP_ADDRESS = 4.9`, `SHIP_ECONT = 3.5`,
`SHIP_ECONT_ADDRESS = 5.9`). So a farmer who sets "free over 30 €" or "local delivery is
free" in the admin sees no effect — customers are still charged the hardcoded amounts.

**Goal:** wire the existing config to the checkout charge and the storefront display.
No new admin UI.

## Decisions (from brainstorm)

1. **One global free-over threshold.** A single `freeThresholdStotinki` applies to *all*
   methods: when `subtotal >= threshold`, that method's fee becomes 0. Per-method pricing
   sets the base fee. Pickup is always free. (The per-method `freeOver` amount is not used
   as a second threshold — see Deferred.)
2. **Econt = live price.** Econt office/door keep using the live Econt `calculate` API for
   the fee; the method's configured fee is only the fallback when Econt is unreachable. The
   global free-over-X still applies to Econt (farm absorbs the courier cost on big orders).
3. **Server is the single source of truth.** The server computes the authoritative charge
   at checkout (already true). The public API exposes a small read-only `delivery` pricing
   block so the storefront *displays* matching numbers; the storefront never computes the
   authoritative charge.
4. **Backward compatible, with one intended change.** A tenant with no `settings.delivery`
   keeps today's amounts: the fallback defaults are global `freeThresholdStotinki = 4000`
   (preserves "free over 40 €"), local `address` fee 490, Econt fallback 350 / door 590,
   pickup 0. The one intended behavior change: because the threshold is now **global**, an
   unconfigured tenant's Econt orders also become free over 40 € (today Econt is always
   priced). This was explicitly accepted in the brainstorm (farm absorbs the courier cost on
   big baskets). A farmer who wants Econt always-priced sets the global threshold higher or
   to 0.

## Config → checkout mapping

| config method key | order `deliveryType` | fee source |
|---|---|---|
| `ownSlots`     | `address`       | method pricing (free / flat / freeOver) |
| `econtOffice`  | `econt`         | live Econt; method fee = fallback |
| `econtAddress` | `econt_address` | live Econt; method fee = fallback |
| `pickup`       | `pickup`        | always 0 |

## Server changes

`checkout.service.ts` — `shippingStotinki(order, subtotal)`:

1. Load the tenant's `settings.delivery` (the `create()` tenant `select` already runs; add
   `settings` to it, or read it where shipping is computed). Apply safe fallbacks — read
   `settings.delivery.methods.{key}.pricing` and `settings.delivery.pricing.freeThresholdStotinki`,
   defaulting to the current constants when absent.
2. Compute the per-method base fee:
   - `pickup` → 0
   - `address` (`ownSlots`): `free` → 0 · `flat` → `feeStotinki` · `freeOver` → `subtotal >= freeOverStotinki ? 0 : feeStotinki` (default when no config: `flat 490`)
   - `econt` / `econt_address`: live Econt `estimateShipping` (unchanged); if it returns
     null, use the method's configured `feeStotinki` (fallback to current 350 / 590).
3. Apply the global threshold last to every method (including Econt): default
   `freeThresholdStotinki = 4000`; if it is `> 0` and `subtotal >= freeThresholdStotinki`
   → return 0.
4. A small pure helper `methodFee(pricing, subtotal, fallback)` keeps the branch readable
   and unit-testable.

Introduce a tiny server-side defaults object (the four constants) so missing config maps to
today's values — no dependency on the client `DEFAULT_DELIVERY`.

## Public API changes

Extend the storefront meta exposed by `/public/:slug/bootstrap` (and the tenant meta used by
the storefront) with a read-only `delivery` block, derived from `settings.delivery`, secrets
already stripped:

```ts
delivery: {
  freeThresholdStotinki: number | null,   // null = no free-over rule
  methods: {
    pickup?:       { enabled: boolean, label: string },                 // fee always 0
    address?:      { enabled: boolean, label: string, feeStotinki: number, freeOverStotinki: number | null },
    econt?:        { enabled: boolean, label: string, feeStotinki: number, live: true },   // "от {fee}"
    econtAddress?: { enabled: boolean, label: string, feeStotinki: number, live: true },
  }
}
```

`enabled` mirrors `settings.delivery.methods.{key}.enabled`. Fees are the configured/fallback
amounts. This block is cached + invalidated with the rest of the tenant cache (delivery save
already busts the tenant cache).

## Storefront changes (`fermerski-pazar-chaika`)

- `checkout-page.ts`: drop the `FREE_OVER` / `SHIP_*` constants; read fees + threshold from the
  bootstrap `delivery` block. The `shipping(sub)` function uses the same rules (method fee, then
  free over threshold) — for display only; the server remains authoritative.
- `checkout.astro`: render the method radios from the `delivery` block — show only `enabled`
  methods, use configured labels, and show each method's fee + the "безплатна над {threshold}"
  copy from config instead of the hardcoded strings.
- Other static copy that repeats fee numbers (`faq.astro`, `orders.astro`) is left as marketing
  copy (not config-driven) unless trivially derivable — out of scope.

## Deferred (YAGNI)

- **`byWeight` / `zones` pricing models.** Real weight pricing needs numeric product weights;
  today weights are free-text ("1 кг", "500 г"). At checkout, a method whose `pricing.type` is
  `byWeight`/`zones` is treated as its `flat` `feeStotinki` (or 0 if unset). The admin UI keeps
  these models for later.
- **Per-method `freeOver` as a second threshold.** Superseded by the single global threshold.
  The field stays in storage/UI but does not gate checkout.

## Testing

- Unit: `methodFee(pricing, subtotal, fallback)` for free / flat / freeOver / missing; and the
  global-threshold override (subtotal at/below/above threshold) per method.
- Unit: `address` pricing honors config (e.g. `free` → 0, `flat 600` → 600, `freeOver 3000/500`).
- Regression: a tenant with no `settings.delivery` produces (pickup 0; local 490, free over
  40; econt live/350, free over 40; econt_address live/590, free over 40). Note Econt is now
  free over 40 — the intended consequence of the global threshold (decision 4).
- Manual (browser): set local delivery to free in admin → storefront + checkout charge 0; set
  free threshold to 30 € → order of 31 € ships free on all methods; pickup always 0.

## Files

**Server:** `checkout.service.ts` (+ spec), public bootstrap/tenant-meta serializer (add
`delivery` block), the public storefront type. **Storefront:** `scripts/checkout-page.ts`,
`pages/checkout.astro`, `src/lib/types.ts`. No DB migration, no admin UI changes.
