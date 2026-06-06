/**
 * Shipping rule for the cart/checkout summary. Free delivery at/above the
 * threshold, otherwise a flat fee — all in integer stotinki (euro-cents).
 *
 * The numbers come from the farm's own config (`GET /public/:slug` → `delivery`,
 * built by the backend's `buildPublicDelivery`), so the displayed total matches
 * the server-computed charge. `DEFAULT_DELIVERY` is only the fallback when the
 * profile can't be read.
 */

/** Per-tenant delivery fees, mirrors the backend `PublicDelivery`. */
export interface StorefrontDelivery {
  freeThresholdStotinki: number;
  addressFeeStotinki: number;
  econtFeeStotinki: number;
  econtAddressFeeStotinki: number;
}

/** Platform defaults — used only when the farm's config can't be loaded. */
export const DEFAULT_DELIVERY: StorefrontDelivery = {
  freeThresholdStotinki: 4000,
  addressFeeStotinki: 490,
  econtFeeStotinki: 350,
  econtAddressFeeStotinki: 590,
};

// Back-compat constant exports (legacy call sites).
export const FREE_SHIPPING_THRESHOLD_STOTINKI = DEFAULT_DELIVERY.freeThresholdStotinki;
export const SHIPPING_FEE_ADDRESS_STOTINKI = DEFAULT_DELIVERY.addressFeeStotinki;
export const SHIPPING_FEE_ECONT_STOTINKI = DEFAULT_DELIVERY.econtFeeStotinki;
/** @deprecated address fee — kept for legacy cart call sites. */
export const SHIPPING_FEE_STOTINKI = SHIPPING_FEE_ADDRESS_STOTINKI;

/**
 * Delivery fee in stotinki for a subtotal + method (0 = free). Mirrors the
 * backend `CheckoutService` rule so the storefront total matches the charge.
 */
export function shippingFor(
  subtotalStotinki: number,
  deliveryType: 'address' | 'econt' = 'address',
  delivery: StorefrontDelivery = DEFAULT_DELIVERY,
): number {
  if (subtotalStotinki >= delivery.freeThresholdStotinki) return 0;
  return deliveryType === 'econt' ? delivery.econtFeeStotinki : delivery.addressFeeStotinki;
}

/** Stotinki still needed to reach free shipping (0 once reached). */
export function remainingForFreeShipping(
  subtotalStotinki: number,
  delivery: StorefrontDelivery = DEFAULT_DELIVERY,
): number {
  return Math.max(0, delivery.freeThresholdStotinki - subtotalStotinki);
}
