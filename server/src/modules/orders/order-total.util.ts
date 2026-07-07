/** Sum of quantity × unit price over order lines (the items subtotal, stotinki). */
export function subtotalStotinki(
  items: { quantity: number; priceStotinki: number }[],
): number {
  return items.reduce((s, i) => s + i.quantity * i.priceStotinki, 0);
}

/**
 * Recompute an order total after its items changed, preserving the delivery fee.
 * The fee is never stored on its own — it was folded into `totalStotinki` at
 * checkout (`total = subtotal + shipping`). So we recover it as `prevTotal −
 * prevSubtotal` (clamped ≥ 0 for odd legacy rows) and re-add it to the new
 * subtotal. We do NOT re-quote the carrier — the original shipping stands.
 */
export function recomputeTotalStotinki(
  prevTotal: number,
  prevSubtotal: number,
  newSubtotal: number,
): number {
  const shipping = Math.max(0, prevTotal - prevSubtotal);
  return newSubtotal + shipping;
}
