import type { PublicProduct } from '@fermeribg/types';

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
 * Cart-aware ranking from a per-tenant co-occurrence map. For each product in the
 * cart, look up its ranked list of co-bought products and award each a score by its
 * rank position (earlier in the list = stronger pairing). Scores sum across all cart
 * items, so a product paired with several cart items outranks one paired with a
 * single item. A product already in the cart is never scored. Returns product ids,
 * strongest co-occurrence first.
 *
 * This restores the "bought together with THIS cart" signal while the underlying
 * map stays cart-independent and cacheable once per tenant — the per-cart work is
 * this pure in-process pass.
 */
export function rankCartCoOccurrence(map: Record<string, string[]>, cartIds: string[]): string[] {
  const cart = new Set(cartIds);
  const score = new Map<string, number>();
  for (const anchor of cartIds) {
    const others = map[anchor];
    if (!others) continue;
    const n = others.length;
    others.forEach((id, idx) => {
      if (cart.has(id)) return; // a co-cart item is never itself a pick
      score.set(id, (score.get(id) ?? 0) + (n - idx));
    });
  }
  // Stable sort (Node ≥12): ties keep first-seen order, i.e. strongest anchor first.
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
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
