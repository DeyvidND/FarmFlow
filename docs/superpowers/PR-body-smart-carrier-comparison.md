## Summary

At checkout the customer sees a live **Econt-vs-Speedy** door-delivery price comparison (COD-aware), picks the cheaper carrier, the choice persists to `orders.carrier`, and they are charged the **re-quoted server price** (the client price is never trusted). Speedy also gains **full order fulfillment parity** (waybill, label, auto-create, tracking) so Speedy orders ship like Econt orders.

Money stays integer stotinki end-to-end; carriers bill EUR (×100), no BGN conversion.

### What changed (server)
- **DB:** `orders.carrier` column — migration **0066** (hand-written; journal updated).
- **COD-aware estimates:** both `EcontService.estimateShipping` and `SpeedyService.estimateShipping` fold COD into the carrier payload **and** the Redis cache key (new `:codN` dimension) so COD/non-COD prices never cross-contaminate.
- **Cross-carrier compare:** `CompareShipmentDto.codAmountStotinki` threaded through `ShippingQuoteService.compare` to both carriers.
- **Order intake:** `CreateOrderDto.carrier`; `orders.service` persists the chosen carrier, gates door delivery via new `courierDoorEnabled`/`speedyEnabled`/`comparisonActive` helpers, and validates the carrier is live.
- **Checkout pricing:** `CheckoutService` re-quotes the chosen carrier server-side (Speedy door path + COD), logs Speedy quote failures, falls back to the flat fee.
- **Public compare route:** `POST /public/:slug/shipping/compare` — anonymous, throttled, **gated on `comparisonActive`** (returns empty quotes for single-carrier farms). `TenantMeta` now exposes `speedyConfigured` + `comparisonActive`.
- **Speedy fulfillment parity:** `buildOrderShipmentInput` mapper, `SpeedyService.createLabelForOrder` (+ `POST /speedy/orders/:orderId/label`), Speedy `autoCreateForOrder`, and a `CarrierFulfillmentService` dispatcher that routes auto-create to the chosen carrier (3 call sites swapped: Stripe webhook + 2 order-confirm paths).
- **Admin/farmer panel:** the shipments list now surfaces `carrier` + the correct tracking number for Speedy rows; print/create/void/refresh (single **and** bulk) route to the right carrier's endpoints.

### Dark for single-carrier farms
`comparisonActive` is false unless a farm has **both** Econt `auto` **and** Speedy configured, so existing farms see **zero** behavior change. Non-COD estimates default `cod=0` (identical to prior behavior aside from a `:cod0` cache-key suffix).

### Tests
Full server suite **923/923** (was 887 baseline → +36 new tests). Server + `client` type-checks clean. Every task TDD'd (red→green) with per-task spec + code-quality review.

### Not in this PR (deferred by decision)
- **Customer-facing checkout picker UI** (plan Task 8 storefront part): the in-repo customer checkout (`storefront/`) offers Econt **office** in auto mode, with no door (`econt_address`) option to attach the picker to — surfacing it is a product/UX decision. Deferred to the storefront service work. The **server** public compare route + gating flags shipped here.

---

## Deploy notes
- **Migration 0066** (`orders.carrier`) must run before/with the redeploy.
- **Redeploy:** API server, the `client` admin/farmer panel, and the admin panel.
- **chaika** (separate repo, the live customer storefront): replicate the carrier-comparison checkout picker — fetch `POST /public/:slug/shipping/compare`, render the two-carrier rows (pre-select cheapest, badge "Най-евтин", COD footnote), send `carrier` on order create. Falls back to the single-carrier flat fee when the route returns empty quotes.
- Feature is **dark** until a farm runs both Econt `auto` + Speedy.
- Optional follow-up: add a per-tenant **Speedy `label.autoCreate`** toggle in delivery settings (parity with Econt auto-create on paid orders); otherwise farms create Speedy labels manually from the panel.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
