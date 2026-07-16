import type { TomorrowOrder, FulfillmentState } from '@/lib/api-client';

export interface PrepProductRow {
  productName: string;
  variantLabel: string | null;
  totalQty: number;
  pickedQty: number;
  orderCount: number;
}

/** Aggregate the order feed into per-product rows. Rows are keyed by product +
 *  variant so different-sized packs of the same product (e.g. 500г vs 1кг) never
 *  collapse into one "бройки" count that hides what was actually ordered.
 *  Progress ("picked") is derived purely from each order's fulfillmentState, so
 *  it can never disagree with the order view — orders are the single source of
 *  truth. */
export function aggregateByProduct(orders: TomorrowOrder[]): PrepProductRow[] {
  const map = new Map<string, PrepProductRow & { orderIds: Set<string> }>();
  for (const o of orders) {
    const picked = o.fulfillmentState === 'fulfilled';
    for (const it of o.items) {
      const variantLabel = it.variantLabel ?? null;
      const key = `${it.productName}::${variantLabel ?? ''}`;
      let row = map.get(key);
      if (!row) {
        row = { productName: it.productName, variantLabel, totalQty: 0, pickedQty: 0, orderCount: 0, orderIds: new Set() };
        map.set(key, row);
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

export interface PrepCourierGroup {
  /** Delivery leg (0-based courier index), or null for orders not on any route
   *  (pickup / carrier company). */
  courierIndex: number | null;
  courierName: string | null;
  rows: PrepProductRow[];
  totalQty: number;
  pickedQty: number;
  orderCount: number;
}

/** Split the order feed into per-courier (delivery leg) groups, each with its
 *  own product aggregation — so a farmer with several couriers can pack each
 *  van separately instead of only seeing one combined harvest total. Groups are
 *  ordered by leg (courierIndex asc); orders on no route (courierIndex null —
 *  pickup / carrier company) trail as a final group. `courierName` is taken from
 *  the first order in the leg that carries one. Under the all-farmers «Всички»
 *  view each order arrives as per-farmer slices; a slice keeps the whole order's
 *  courierIndex, so grouping stays correct and quantities never double-count
 *  (each slice holds different products). */
export function aggregateByCourier(orders: TomorrowOrder[]): PrepCourierGroup[] {
  const byLeg = new Map<number | null, TomorrowOrder[]>();
  for (const o of orders) {
    const k = o.courierIndex;
    if (!byLeg.has(k)) byLeg.set(k, []);
    byLeg.get(k)!.push(o);
  }
  const keys = [...byLeg.keys()].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  return keys.map((k) => {
    const items = byLeg.get(k)!;
    const rows = aggregateByProduct(items);
    const totalQty = rows.reduce((s, r) => s + r.totalQty, 0);
    const pickedQty = rows.reduce((s, r) => s + r.pickedQty, 0);
    const orderCount = new Set(items.map((o) => o.id)).size;
    return {
      courierIndex: k,
      courierName: items.find((o) => o.courierName)?.courierName ?? null,
      rows,
      totalQty,
      pickedQty,
      orderCount,
    };
  });
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
