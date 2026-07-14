import type { TomorrowOrder, FulfillmentState } from '@/lib/api-client';

export interface PrepProductRow {
  productName: string;
  totalQty: number;
  pickedQty: number;
  orderCount: number;
}

/** Aggregate the order feed into per-product rows. Progress ("picked") is derived
 *  purely from each order's fulfillmentState, so it can never disagree with the
 *  order view — orders are the single source of truth. */
export function aggregateByProduct(orders: TomorrowOrder[]): PrepProductRow[] {
  const map = new Map<string, PrepProductRow & { orderIds: Set<string> }>();
  for (const o of orders) {
    const picked = o.fulfillmentState === 'fulfilled';
    for (const it of o.items) {
      let row = map.get(it.productName);
      if (!row) {
        row = { productName: it.productName, totalQty: 0, pickedQty: 0, orderCount: 0, orderIds: new Set() };
        map.set(it.productName, row);
      }
      row.totalQty += it.quantity;
      if (picked) row.pickedQty += it.quantity;
      row.orderIds.add(o.id);
    }
  }
  return [...map.values()]
    .map(({ orderIds, ...r }) => ({ ...r, orderCount: orderIds.size }))
    .sort((a, b) => b.totalQty - a.totalQty || a.productName.localeCompare(b.productName, 'bg'));
}

const STATE_RANK: Record<FulfillmentState, number> = { pending: 0, in_production: 1, fulfilled: 2 };

/** Merge per-farmer slices of the same order (arriving from separate farmer feeds in
 *  the all-farmers "Всички" view) into whole orders. Items are concatenated; the
 *  order's state is the LEAST-done across its slices — an order counts as 'fulfilled'
 *  only when every farmer's slice is. Read-only display helper (no ticking happens in
 *  the "Всички" order view); product progress is aggregated from the raw slices, not
 *  from this merge, so per-farmer picked stays accurate. */
export function mergeOrderSlices(slices: TomorrowOrder[]): TomorrowOrder[] {
  const byId = new Map<string, TomorrowOrder>();
  for (const s of slices) {
    const existing = byId.get(s.id);
    if (!existing) {
      byId.set(s.id, { ...s, items: [...s.items] });
    } else {
      existing.items.push(...s.items);
      if (STATE_RANK[s.fulfillmentState] < STATE_RANK[existing.fulfillmentState]) {
        existing.fulfillmentState = s.fulfillmentState;
      }
    }
  }
  return [...byId.values()];
}
