/**
 * How many of a basket („кошница") can still be sold, from its members' stock.
 *
 * A basket carries no stock of its own — the panel hides the field — so the only
 * honest number is the weakest member: `min` over `floor(remaining / per-basket
 * quantity)`. A member with no availability window is unlimited and doesn't
 * constrain the result; when no member has one, the basket is unlimited too
 * (`null`, so the caller emits no window at all).
 *
 * A member that is no longer live (inactive, deleted, awaiting review) makes the
 * basket sold out: we must never promise a box we can't fill.
 */
export function basketRemaining(
  members: { productId: string; quantity: number }[],
  remainingByProduct: Map<string, number>,
  liveProductIds: Set<string>,
): number | null {
  if (!members.length) return 0;
  let cap: number | null = null;
  for (const m of members) {
    if (!liveProductIds.has(m.productId)) return 0;
    const remaining = remainingByProduct.get(m.productId);
    if (remaining == null) continue; // unlimited member
    const memberCap = Math.floor(remaining / Math.max(1, m.quantity));
    cap = cap == null ? memberCap : Math.min(cap, memberCap);
  }
  return cap;
}
