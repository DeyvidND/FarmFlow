import type { TomorrowOrder } from '@/lib/api-client';

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
