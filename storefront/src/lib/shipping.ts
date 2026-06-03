/**
 * Shipping rule for the cart/checkout summary. Free delivery at/above the
 * threshold, otherwise a flat fee — all in integer stotinki.
 *
 * FLAG (S9): a public `GET /public/:slug` profile could expose per-farm
 * shipping settings; until then these are platform constants matching the
 * template (free ≥ 40,00 €, else 4,90 €).
 */
export const FREE_SHIPPING_THRESHOLD_STOTINKI = 4000;
export const SHIPPING_FEE_ADDRESS_STOTINKI = 490;
export const SHIPPING_FEE_ECONT_STOTINKI = 350;
/** @deprecated address fee — kept for the S4 cart call site. */
export const SHIPPING_FEE_STOTINKI = SHIPPING_FEE_ADDRESS_STOTINKI;

/**
 * Delivery fee in stotinki for a subtotal + method (0 = free). Mirrors the
 * backend `CheckoutService` rule so the storefront total matches the charge.
 */
export function shippingFor(
  subtotalStotinki: number,
  deliveryType: 'address' | 'econt' = 'address',
): number {
  if (subtotalStotinki >= FREE_SHIPPING_THRESHOLD_STOTINKI) return 0;
  return deliveryType === 'econt'
    ? SHIPPING_FEE_ECONT_STOTINKI
    : SHIPPING_FEE_ADDRESS_STOTINKI;
}

/** Stotinki still needed to reach free shipping (0 once reached). */
export function remainingForFreeShipping(subtotalStotinki: number): number {
  return Math.max(0, FREE_SHIPPING_THRESHOLD_STOTINKI - subtotalStotinki);
}
