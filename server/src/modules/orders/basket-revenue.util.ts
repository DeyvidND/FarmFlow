/** One basket child's weight input for revenue allocation: its OWN member
 *  product's list price (never the order_items row's own `priceStotinki`,
 *  which is 0 by design for a basket child) and the quantity that child line
 *  carries on this order. */
export interface BasketChildWeight {
  memberPriceStotinki: number;
  quantity: number;
}

/**
 * A basket sells for less than its members' list prices sum to (that's the
 * point of a basket). Valuing a child line at its member's own list price
 * would bill/credit money nobody paid. Instead, allocate the PARENT line's
 * total (`priceStotinki × quantity`) across its children, proportional to
 * each child's own weight (`memberPriceStotinki × quantity`) against the sum
 * of all siblings' weights.
 *
 * Rounding: every child but the last gets `floor(parentTotal × weight / totalWeight)`;
 * the LAST array element absorbs whatever is left over, so
 * `sum(allocateBasketRevenue(...)) === parentTotalStotinki` ALWAYS, exactly —
 * never off by a stotinka. Callers MUST pass `children` in one stable,
 * deterministic order (e.g. sorted by the order_items row id) — the same
 * order every time a given order is re-read — so it's always the same child
 * that ends up absorbing the remainder.
 *
 * If every sibling has zero weight (e.g. every member is a free/zero-price
 * product), there is nothing to split proportionally: every non-last child
 * gets 0 and the whole parent total falls to the last child. A single-child
 * basket is the degenerate case of this rule — the sole child IS the last
 * child, so it always gets the full parent total regardless of its own price.
 */
export function allocateBasketRevenue(
  parentTotalStotinki: number,
  children: BasketChildWeight[],
): number[] {
  if (children.length === 0) return [];
  const weights = children.map((c) => c.memberPriceStotinki * c.quantity);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const shares = weights.map((w) =>
    totalWeight > 0 ? Math.floor((parentTotalStotinki * w) / totalWeight) : 0,
  );
  const allocatedBeforeLast = shares.slice(0, -1).reduce((sum, s) => sum + s, 0);
  shares[shares.length - 1] = parentTotalStotinki - allocatedBeforeLast;
  return shares;
}

/** One `order_items` row, as needed to compute its basket-aware effective
 *  revenue via {@link allocateOrderRevenue}. `priceStotinki` is the row's own
 *  stored price (0 for a basket child, by design); `memberPriceStotinki` is
 *  the row's OWN product's live list price (used only to weight a child's
 *  share against its siblings — irrelevant for an ordinary line). */
export interface OrderItemForAllocation {
  id: string;
  bundleParentId: string | null;
  quantity: number;
  priceStotinki: number;
  memberPriceStotinki: number;
}

/**
 * The single source of truth for "how much money did each line of THIS order
 * actually earn" — basket-aware. Returns a Map from `order_items.id` to its
 * effective revenue (stotinki).
 *
 * An ordinary line (no `bundleParentId`, including a basket's own PARENT
 * line) keeps its stored `priceStotinki × quantity` unchanged. A basket
 * CHILD's contribution is its {@link allocateBasketRevenue} proportional
 * share of its parent's line total, weighted against ALL of that parent's
 * children (regardless of which farmer owns which sibling — the weight
 * denominator must see the whole basket) — never its own (zero) stored
 * price. Children of the same parent are allocated together, ordered
 * deterministically by `id`, so the same child always absorbs the rounding
 * remainder no matter what order the rows arrive in.
 *
 * Every caller that needs "this farmer's money on this order" (the
 * commission ledger, farmer-scoped payments/stats reads) should sum the
 * values here for the rows it cares about, rather than re-deriving revenue
 * from `priceStotinki` directly.
 */
export function allocateOrderRevenue(items: OrderItemForAllocation[]): Map<string, number> {
  const byId = new Map(items.map((it) => [it.id, it]));
  const childrenByParent = new Map<string, OrderItemForAllocation[]>();
  for (const it of items) {
    if (!it.bundleParentId) continue;
    const list = childrenByParent.get(it.bundleParentId) ?? [];
    list.push(it);
    childrenByParent.set(it.bundleParentId, list);
  }

  const revenue = new Map<string, number>();
  for (const it of items) {
    if (!it.bundleParentId) revenue.set(it.id, it.priceStotinki * it.quantity);
  }
  for (const [parentId, children] of childrenByParent) {
    const parent = byId.get(parentId);
    if (!parent) continue; // orphaned child row — shouldn't happen; skip defensively
    const ordered = [...children].sort((a, b) => a.id.localeCompare(b.id));
    const shares = allocateBasketRevenue(
      parent.priceStotinki * parent.quantity,
      ordered.map((c) => ({ memberPriceStotinki: c.memberPriceStotinki, quantity: c.quantity })),
    );
    ordered.forEach((c, i) => revenue.set(c.id, shares[i]));
  }
  return revenue;
}
