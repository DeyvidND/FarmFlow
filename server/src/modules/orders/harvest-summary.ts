/** One product's total quantity to harvest/prepare. */
export interface HarvestLine {
  productName: string;
  quantity: number;
}

/**
 * Total quantity per product across a set of order line items, largest first
 * (ties by product name). Null names fold to "—". Pure — shared by the daily
 * digest's "За приготвяне" list and the route day-suggester's per-day readout.
 */
export function harvestSummary(
  items: { productName: string | null; quantity: number }[],
): HarvestLine[] {
  const map = new Map<string, number>();
  for (const it of items) {
    const name = it.productName ?? '—';
    map.set(name, (map.get(name) ?? 0) + it.quantity);
  }
  return [...map.entries()]
    .map(([productName, quantity]) => ({ productName, quantity }))
    .sort((a, b) => b.quantity - a.quantity || a.productName.localeCompare(b.productName));
}
