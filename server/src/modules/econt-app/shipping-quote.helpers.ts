import type { CarrierPolicy } from '../orders/delivery-pricing';

export type QuoteCarrier = 'econt' | 'speedy';

export interface CarrierQuote {
  carrier: QuoteCarrier;
  priceStotinki: number | null;
  available: boolean;
}

export interface QuoteResult {
  quotes: CarrierQuote[];
  /** The price-cheapest available carrier (null when neither is available). */
  cheapest: QuoteCarrier | null;
  /** The farm's carrier policy — the storefront uses it to decide picker behaviour. */
  policy: CarrierPolicy;
  /**
   * The carrier the storefront should pre-select / lock to, after the policy is
   * applied: a forced carrier (`econt`/`speedy`) if available, else the cheapest.
   * `null` when nothing is available. Under `customer` policy this is the cheapest
   * (a sensible default) but the storefront still lets the buyer change it.
   */
  selected: QuoteCarrier | null;
}

/**
 * Normalize two carrier estimates into a sorted result. Available carriers come
 * first (cheapest price ascending); unavailable carriers (null estimate) sort
 * last. Ties keep input order (econt before speedy) for a stable response. The
 * `policy` decides `selected`: a forced carrier wins (when available), otherwise
 * the cheapest does.
 */
export function buildQuoteResult(
  econtStotinki: number | null,
  speedyStotinki: number | null,
  policy: CarrierPolicy = 'customer',
  markupStotinki = 0,
): QuoteResult {
  // The farm's courier markup is added to each available price so the picker shows
  // exactly what checkout will charge. Uniform across carriers → ordering unchanged.
  const withMarkup = (p: number | null) => (p == null ? null : p + markupStotinki);
  const econt = withMarkup(econtStotinki);
  const speedy = withMarkup(speedyStotinki);
  const raw: CarrierQuote[] = [
    { carrier: 'econt', priceStotinki: econt, available: econt != null },
    { carrier: 'speedy', priceStotinki: speedy, available: speedy != null },
  ];
  const quotes = [...raw].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (a.available && b.available) return a.priceStotinki! - b.priceStotinki!;
    return 0; // both unavailable, or equal price → stable (input order preserved)
  });
  const cheapest = quotes[0].available ? quotes[0].carrier : null;
  const isAvailable = (c: QuoteCarrier) => raw.find((q) => q.carrier === c)?.available ?? false;
  const forced = (policy === 'econt' || policy === 'speedy') && isAvailable(policy) ? policy : null;
  return { quotes, cheapest, policy, selected: forced ?? cheapest };
}
