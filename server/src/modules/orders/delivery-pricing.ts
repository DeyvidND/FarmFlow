/**
 * Delivery-fee logic driven by the tenant's `settings.delivery` config. Pure
 * functions — the checkout service is authoritative and calls these; the public
 * API reuses `buildPublicDelivery()` so the storefront displays matching numbers.
 *
 * Money is integer cents (stotinki) end-to-end. A tenant with no saved config
 * falls back to the legacy hardcoded amounts (`DELIVERY_DEFAULTS`), so behavior
 * is unchanged until a farmer edits the delivery page.
 */

export type DeliveryPricingType = 'free' | 'flat' | 'freeOver' | 'byWeight';

export interface MethodPricing {
  type?: DeliveryPricingType;
  feeStotinki?: number;
  freeOverStotinki?: number;
}

export interface MethodConfig {
  enabled?: boolean;
  label?: string;
  pricing?: MethodPricing;
}

export interface DeliveryConfig {
  methods?: {
    ownSlots?: MethodConfig;
    econtOffice?: MethodConfig;
    econtAddress?: MethodConfig;
    pickup?: MethodConfig;
  };
  pricing?: { freeThresholdStotinki?: number };
  econt?: { mode?: EcontMode; configured?: boolean };
  cod?: { enabled?: boolean };
}

/**
 * How a farm fulfils Econt orders:
 *  - `off`    — Econt not offered.
 *  - `manual` — offered at a flat fee; the farm ships each order itself (no API).
 *  - `auto`   — the live Econt API integration (price + waybill + tracking).
 */
export type EcontMode = 'off' | 'manual' | 'auto';

/** Resolve the Econt mode, migrating legacy `configured: true` (pre-mode) to `auto`. */
export function econtMode(cfg: DeliveryConfig | null | undefined): EcontMode {
  const e = cfg?.econt;
  if (e?.mode) return e.mode;
  return e?.configured ? 'auto' : 'off';
}

/**
 * Whether the farm offers наложен платеж (cash on delivery) as a payment choice.
 * Defaults to true — production runs cash-first, and an absent flag means "offer it".
 */
export function codEnabled(cfg: DeliveryConfig | null | undefined): boolean {
  return cfg?.cod?.enabled ?? true;
}

/** Legacy hardcoded amounts — the fallback when a tenant has no saved config. */
export const DELIVERY_DEFAULTS = {
  freeThresholdStotinki: 4000,
  addressFeeStotinki: 490,
  econtFeeStotinki: 350,
  econtAddressFeeStotinki: 590,
} as const;

/**
 * Base fee for a method from its pricing block. No free-over here — that is the
 * single global threshold (step 3 of the checkout calc). `freeOver`/`byWeight`
 * are treated as flat for now (per-method free-over is deferred; weight pricing
 * needs numeric product weights we don't have).
 */
export function methodBaseFee(pricing: MethodPricing | undefined, fallbackFee: number): number {
  if (!pricing || !pricing.type) return fallbackFee;
  if (pricing.type === 'free') return 0;
  return pricing.feeStotinki ?? fallbackFee;
}

/** Global free-over threshold. Default 4000; an explicit 0 disables free delivery. */
export function freeThresholdStotinki(cfg: DeliveryConfig | null | undefined): number {
  return cfg?.pricing?.freeThresholdStotinki ?? DELIVERY_DEFAULTS.freeThresholdStotinki;
}

/** Zero the fee once the basket clears the global threshold (applies to every method). */
export function applyFreeThreshold(fee: number, subtotal: number, threshold: number): number {
  return threshold > 0 && subtotal >= threshold ? 0 : fee;
}

/** Local self-delivery (`ownSlots` → deliveryType `address`) fee, threshold applied. */
export function localFeeStotinki(cfg: DeliveryConfig | null | undefined, subtotal: number): number {
  const base = methodBaseFee(cfg?.methods?.ownSlots?.pricing, DELIVERY_DEFAULTS.addressFeeStotinki);
  return applyFreeThreshold(base, subtotal, freeThresholdStotinki(cfg));
}

/** Econt fallback fee — used when the live courier quote is unavailable. */
export function econtFallbackFee(cfg: DeliveryConfig | null | undefined, door: boolean): number {
  const m = door ? cfg?.methods?.econtAddress : cfg?.methods?.econtOffice;
  const fallback = door ? DELIVERY_DEFAULTS.econtAddressFeeStotinki : DELIVERY_DEFAULTS.econtFeeStotinki;
  return methodBaseFee(m?.pricing, fallback);
}

/** Minimal read-only pricing block for the storefront (no secrets, display only). */
export interface PublicDelivery {
  freeThresholdStotinki: number;
  addressFeeStotinki: number;
  econtFeeStotinki: number;
  econtAddressFeeStotinki: number;
}

export function buildPublicDelivery(cfg: DeliveryConfig | null | undefined): PublicDelivery {
  return {
    freeThresholdStotinki: freeThresholdStotinki(cfg),
    addressFeeStotinki: methodBaseFee(cfg?.methods?.ownSlots?.pricing, DELIVERY_DEFAULTS.addressFeeStotinki),
    econtFeeStotinki: econtFallbackFee(cfg, false),
    econtAddressFeeStotinki: econtFallbackFee(cfg, true),
  };
}
