import { describe, it, expect } from 'vitest';
import { aggregateByProduct } from './aggregate';
import type { TomorrowOrder } from '@/lib/api-client';

const mkOrder = (id: string, state: TomorrowOrder['fulfillmentState'], items: [string, number][]): TomorrowOrder => ({
  id, orderNumber: null, customerName: null, customerPhone: null, customerEmail: null,
  deliveryType: 'pickup', day: '2026-07-15', slotFrom: null, slotTo: null,
  fulfillmentState: state,
  items: items.map(([productName, quantity], i) => ({ productId: `${id}-${i}`, productName, quantity })),
});

describe('aggregateByProduct', () => {
  it('returns [] for no orders', () => {
    expect(aggregateByProduct([])).toEqual([]);
  });

  it('sums quantity per product and counts distinct orders', () => {
    const rows = aggregateByProduct([
      mkOrder('o1', 'pending', [['Домати', 3], ['Мед', 1]]),
      mkOrder('o2', 'pending', [['Домати', 2]]),
    ]);
    const tomatoes = rows.find((r) => r.productName === 'Домати')!;
    expect(tomatoes.totalQty).toBe(5);
    expect(tomatoes.orderCount).toBe(2);
    expect(tomatoes.pickedQty).toBe(0);
  });

  it('counts a product as picked only when its order is fulfilled', () => {
    const rows = aggregateByProduct([
      mkOrder('o1', 'fulfilled', [['Домати', 3]]),
      mkOrder('o2', 'pending', [['Домати', 2]]),
    ]);
    const tomatoes = rows.find((r) => r.productName === 'Домати')!;
    expect(tomatoes.totalQty).toBe(5);
    expect(tomatoes.pickedQty).toBe(3);
  });

  it('sorts by total quantity descending', () => {
    const rows = aggregateByProduct([mkOrder('o1', 'pending', [['Мед', 1], ['Домати', 9]])]);
    expect(rows.map((r) => r.productName)).toEqual(['Домати', 'Мед']);
  });
});
