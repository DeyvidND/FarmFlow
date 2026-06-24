export type QuoteCarrier = 'econt' | 'speedy';

export interface CarrierQuote {
  carrier: QuoteCarrier;
  priceStotinki: number | null;
  available: boolean;
}

export interface QuoteResult {
  quotes: CarrierQuote[];
  cheapest: QuoteCarrier | null;
}

/**
 * Normalize two carrier estimates into a sorted result. Available carriers come
 * first (cheapest price ascending); unavailable carriers (null estimate) sort
 * last. Ties keep input order (econt before speedy) for a stable response.
 */
export function buildQuoteResult(econtStotinki: number | null, speedyStotinki: number | null): QuoteResult {
  const raw: CarrierQuote[] = [
    { carrier: 'econt', priceStotinki: econtStotinki, available: econtStotinki != null },
    { carrier: 'speedy', priceStotinki: speedyStotinki, available: speedyStotinki != null },
  ];
  const quotes = [...raw].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (a.available && b.available) return a.priceStotinki! - b.priceStotinki!;
    return 0; // both unavailable, or equal price → stable (input order preserved)
  });
  const cheapest = quotes[0].available ? quotes[0].carrier : null;
  return { quotes, cheapest };
}
