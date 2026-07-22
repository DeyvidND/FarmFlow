/** One member of a basket („кошница"): a product and how many go in per basket. */
export interface BundleMemberLine {
  productId: string;
  quantity: number;
}

/**
 * Turn ordered cart lines into the list that availability-window enforcement runs
 * over. A basket product carries no stock of its own — it is replaced by its member
 * products at `member.quantity × line.quantity`, so member stock is what actually
 * gates the sale.
 *
 * Quantities for the same product are merged (first-seen order preserved) so a
 * shopper who orders tomatoes loose AND a basket containing tomatoes is checked
 * once against the true demand, and gets one clear error instead of two.
 *
 * `membersByBundle` must contain an entry for every basket in `lines`; a product
 * absent from the map is treated as an ordinary product. A basket mapped to an
 * empty array contributes nothing — the caller rejects that case before calling.
 */
export function expandStockLines(
  lines: { productId: string; quantity: number }[],
  membersByBundle: Map<string, BundleMemberLine[]>,
): { productId: string; quantity: number }[] {
  const merged = new Map<string, number>();
  const add = (productId: string, quantity: number) => {
    merged.set(productId, (merged.get(productId) ?? 0) + quantity);
  };
  for (const line of lines) {
    const members = membersByBundle.get(line.productId);
    if (members) {
      for (const m of members) add(m.productId, m.quantity * line.quantity);
    } else {
      add(line.productId, line.quantity);
    }
  }
  return [...merged.entries()].map(([productId, quantity]) => ({ productId, quantity }));
}
