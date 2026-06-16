import type { PublicProduct } from '@farmflow/types';

export interface AssembleInput {
  /** The public catalog (active products), in display order (position). */
  catalog: PublicProduct[];
  /** Product ids that are sold out (active availability window remaining = 0). */
  soldOutIds: Set<string>;
  /** Product ids already in the cart — never recommend these. */
  cartIds: Set<string>;
  /** Bought-together ids, highest co-occurrence first. */
  coOccurringIds: string[];
  /** Best-seller ids, highest sales first (first fallback). */
  bestSellerIds: string[];
  /** How many picks to return. */
  limit: number;
}

/**
 * Pure assembly of the cart's „Често купувано заедно" picks. Merges the
 * bought-together ranking with two fallbacks — best-sellers, then featured/newest —
 * into a deduped, capped list. A pick is *eligible* only when it is in the
 * catalog, not already in the cart, and not sold out. The fallbacks keep the
 * block populated on a quiet shop while never resurfacing an ineligible product.
 */
export function assembleCartPicks(input: AssembleInput): PublicProduct[] {
  const { catalog, soldOutIds, cartIds, coOccurringIds, bestSellerIds, limit } = input;
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const eligible = (id: string): boolean => byId.has(id) && !cartIds.has(id) && !soldOutIds.has(id);

  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | null | undefined): void => {
    if (id && ordered.length < limit && eligible(id) && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  };

  // 1) co-occurrence, 2) best-sellers, 3) featured-first then catalog order.
  for (const id of coOccurringIds) push(id);
  if (ordered.length < limit) for (const id of bestSellerIds) push(id);
  if (ordered.length < limit) {
    const featuredFirst = [...catalog].sort(
      (a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)),
    );
    for (const p of featuredFirst) push(p.id);
  }

  return ordered.map((id) => byId.get(id)!);
}
