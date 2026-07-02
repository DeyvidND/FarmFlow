/**
 * Delivery-fee logic driven by the tenant's `settings.delivery` config. Pure
 * functions — the checkout service is authoritative and calls these; the public
 * API reuses `buildPublicDelivery()` so the storefront displays matching numbers.
 *
 * Money is integer cents (stotinki) end-to-end. A tenant with no saved config
 * falls back to the legacy hardcoded amounts (`DELIVERY_DEFAULTS`), so behavior
 * is unchanged until a farmer edits the delivery page.
 */

export type DeliveryPricingType = 'free' | 'flat';

export interface MethodPricing {
  type?: DeliveryPricingType;
  feeStotinki?: number;
}

export interface MethodConfig {
  enabled?: boolean;
  label?: string;
  pricing?: MethodPricing;
  /** pickup only — free-text location + hours (unchanged, still the fallback). */
  address?: string;
  hours?: string;
  /** pickup only — optional fixed recurring schedule (0=Sun..6=Sat). When set,
   *  together with pickupFrom/pickupTo, this takes priority over `hours` for
   *  the customer-facing schedule text. */
  pickupWeekday?: number;
  pickupFrom?: string; // HH:MM
  pickupTo?: string; // HH:MM
}

export interface DeliveryConfig {
  methods?: {
    ownSlots?: MethodConfig;
    econtOffice?: MethodConfig;
    econtAddress?: MethodConfig;
    pickup?: MethodConfig;
  };
  pricing?: { freeThresholdStotinki?: number; courierMarkupStotinki?: number };
  econt?: { mode?: EcontMode; configured?: boolean };
  speedy?: { configured?: boolean };
  cod?: { enabled?: boolean };
  card?: { enabled?: boolean };
  /** How a door order picks its carrier when the farm runs both (see CarrierPolicy). */
  carrierPolicy?: CarrierPolicy;
}

/**
 * Which carrier fulfils a до-адрес (door) order when the farm runs BOTH Econt and
 * Speedy. Only consulted while `comparisonActive` — a single-carrier farm always
 * uses its one live carrier regardless.
 *  - `customer` — the storefront shows a picker; the customer's choice wins
 *                 (the default, and what the smart-comparison UI drives).
 *  - `cheapest` — the server prices both at checkout and ships the cheaper one.
 *  - `econt`    — always Econt, ignore the customer's pick.
 *  - `speedy`   — always Speedy, ignore the customer's pick.
 */
export type CarrierPolicy = 'customer' | 'cheapest' | 'econt' | 'speedy';

/** Resolve the farm's carrier policy. Defaults to `customer` (absent → let the buyer pick). */
export function carrierPolicy(cfg: DeliveryConfig | null | undefined): CarrierPolicy {
  const p = cfg?.carrierPolicy;
  return p === 'cheapest' || p === 'econt' || p === 'speedy' ? p : 'customer';
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

/**
 * Whether the farm accepts card (online/Stripe) payment. Defaults to true: with a
 * connected Stripe account card is offered unless the farm explicitly turns it off
 * (a COD-only farm flips this off without having to disconnect Stripe). This only
 * gates the *offer* — a farm with no Stripe account can't take cards regardless.
 */
export function cardEnabled(cfg: DeliveryConfig | null | undefined): boolean {
  return cfg?.card?.enabled ?? true;
}

/** Legacy hardcoded amounts — the fallback when a tenant has no saved config. */
export const DELIVERY_DEFAULTS = {
  freeThresholdStotinki: 4000,
  addressFeeStotinki: 490,
  econtFeeStotinki: 350,
  econtAddressFeeStotinki: 590,
} as const;

/**
 * Base fee for a method from its pricing block. Two types only: `free` → 0,
 * `flat` → `feeStotinki`. Per-method free-over is superseded by the single global
 * threshold (step 3 of the checkout calc). Legacy/unknown stored types (`freeOver`,
 * `byWeight` from removed models) fall through to `feeStotinki ?? fallback`, so old
 * saved blobs keep charging the same flat amount.
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

/**
 * Per-farm markup (stotinki) added on top of the COURIER shipping price the
 * customer pays — the farm's margin on Econt/Speedy. Applies only to courier
 * methods (office + door), never to local self-delivery or pickup. Default 0
 * (no markup); negatives are ignored. Folded in before the free-over threshold,
 * so a marked-up courier order still ships free once the basket clears it.
 */
export function courierMarkupStotinki(cfg: DeliveryConfig | null | undefined): number {
  const m = cfg?.pricing?.courierMarkupStotinki;
  return typeof m === 'number' && m > 0 ? Math.round(m) : 0;
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
  // Courier fees carry the farm's markup so the storefront's flat estimate matches
  // what checkout charges; local self-delivery does not (markup is courier-only).
  const markup = courierMarkupStotinki(cfg);
  return {
    freeThresholdStotinki: freeThresholdStotinki(cfg),
    addressFeeStotinki: methodBaseFee(cfg?.methods?.ownSlots?.pricing, DELIVERY_DEFAULTS.addressFeeStotinki),
    econtFeeStotinki: econtFallbackFee(cfg, false) + markup,
    econtAddressFeeStotinki: econtFallbackFee(cfg, true) + markup,
  };
}

/** Which delivery methods the farm has switched on — the storefront shows only
 *  these, so a disabled method never reaches a customer. ownSlots/pickup default
 *  on; the Econt methods default off (a farm opts into the courier). */
export interface PublicMethods {
  ownSlots: boolean;
  pickup: boolean;
  econtOffice: boolean;
  econtAddress: boolean;
}

export function buildPublicMethods(cfg: DeliveryConfig | null | undefined): PublicMethods {
  const m = cfg?.methods;
  return {
    ownSlots: m?.ownSlots?.enabled ?? true,
    pickup: m?.pickup?.enabled ?? true,
    econtOffice: m?.econtOffice?.enabled ?? false,
    econtAddress: m?.econtAddress?.enabled ?? false,
  };
}

/** Read-only pickup/market info for the storefront — address, hours and an
 *  optional fixed weekday+time schedule. `label` always has a value (falls
 *  back to the generic "Вземане от място" so the storefront never shows a
 *  blank title). */
export interface PublicPickup {
  label: string;
  address: string | null;
  hours: string | null;
  /** 0=Sun..6=Sat, or null when the farm hasn't set a fixed schedule. */
  weekday: number | null;
  timeFrom: string | null;
  timeTo: string | null;
}

export function buildPublicPickup(cfg: DeliveryConfig | null | undefined): PublicPickup {
  const m = cfg?.methods?.pickup;
  return {
    label: m?.label?.trim() || 'Вземане от място',
    address: m?.address?.trim() || null,
    hours: m?.hours?.trim() || null,
    weekday: typeof m?.pickupWeekday === 'number' ? m.pickupWeekday : null,
    timeFrom: m?.pickupFrom ?? null,
    timeTo: m?.pickupTo ?? null,
  };
}

const OWN_SLOTS_WD = ['неделя', 'понеделник', 'вторник', 'сряда', 'четвъртък', 'петък', 'събота'];

/** Read-only own-slots (local self-delivery) schedule for the storefront — a
 *  human-readable Bulgarian summary of the farm's recurring `SlotRule`, so
 *  checkout never shows a stale hardcoded day/time. `null` schedule means
 *  "don't show a day/time line" (rule inactive, or weekdays mode with no days
 *  picked yet). */
export interface PublicOwnSlots {
  active: boolean;
  schedule: string | null;
}

/** Minimal shape of the tenant's `settings.slotRule` this needs — kept local
 *  (rather than importing the slots module's `SlotRule`) to avoid a cross-module
 *  type dependency for three fields. */
interface OwnSlotsRule {
  active: boolean;
  repeat: 'weekdays' | 'interval';
  days: { dow: number; timeFrom: string; timeTo: string }[];
  intervalDays: number;
  intervalWindow: { timeFrom: string; timeTo: string };
}

export function buildPublicOwnSlots(rule: OwnSlotsRule | null | undefined): PublicOwnSlots {
  if (!rule?.active) return { active: false, schedule: null };
  if (rule.repeat === 'interval') {
    const { timeFrom, timeTo } = rule.intervalWindow;
    return { active: true, schedule: `на всеки ${rule.intervalDays} дни · ${timeFrom}–${timeTo}` };
  }
  if (!rule.days?.length) return { active: true, schedule: null };
  // Group weekdays sharing an identical window into one phrase; days with a
  // different window get their own phrase, joined with "; ".
  const groups = new Map<string, number[]>();
  for (const d of rule.days) {
    const key = `${d.timeFrom}-${d.timeTo}`;
    const dows = groups.get(key);
    if (dows) dows.push(d.dow);
    else groups.set(key, [d.dow]);
  }
  const phrases = [...groups.entries()].map(([key, dows]) => {
    const [timeFrom, timeTo] = key.split('-');
    const names = [...dows].sort((a, b) => a - b).map((d) => OWN_SLOTS_WD[d]);
    const list =
      names.length > 1 ? `${names.slice(0, -1).join(', ')} и ${names[names.length - 1]}` : names[0];
    return `всеки ${list} · ${timeFrom}–${timeTo}`;
  });
  return { active: true, schedule: phrases.join('; ') };
}

/** Whether Speedy live pricing/fulfillment is configured for this farm. */
export function speedyEnabled(cfg: DeliveryConfig | null | undefined): boolean {
  return !!cfg?.speedy?.configured;
}

/** Cross-carrier comparison is offered only when BOTH carriers are live. */
export function comparisonActive(cfg: DeliveryConfig | null | undefined): boolean {
  return econtMode(cfg) === 'auto' && speedyEnabled(cfg);
}

/** Door (до адрес) courier delivery is allowed when Econt door is on OR Speedy is configured. */
export function courierDoorEnabled(cfg: DeliveryConfig | null | undefined): boolean {
  return (cfg?.methods?.econtAddress?.enabled ?? false) || speedyEnabled(cfg);
}
