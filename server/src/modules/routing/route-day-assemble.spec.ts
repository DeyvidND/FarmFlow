import { assembleDaySuggestion } from './route-day-assemble';
import type { ReschedulableOrder } from '../orders/orders.service';

const depot = { lat: 42.65, lng: 23.32 };

/** Minimal ReschedulableOrder fixture with sane defaults. */
function order(overrides: Partial<ReschedulableOrder> & { id: string }): ReschedulableOrder {
  return {
    orderNumber: null,
    customerName: null,
    customerPhone: null,
    totalStotinki: 0,
    status: 'confirmed',
    slotDate: '2026-07-10',
    deliveryLat: null,
    deliveryLng: null,
    ...overrides,
  };
}

describe('assembleDaySuggestion', () => {
  it('returns each requested day empty and no unplaced when the pool is empty', () => {
    const result = assembleDaySuggestion([], new Map(), depot, ['2026-07-10', '2026-07-11']);

    expect(result.unplaced).toEqual([]);
    expect(result.days.map((d) => d.date).sort()).toEqual(['2026-07-10', '2026-07-11']);
    for (const day of result.days) {
      expect(day.orders).toEqual([]);
      expect(day.harvest).toEqual([]);
      expect(day.spreadKm).toBe(0);
    }
  });

  it('has spreadKm === 0 for every day when there is no depot, even with geocoded orders', () => {
    const pool: ReschedulableOrder[] = [
      order({ id: 'o1', deliveryLat: '42.71', deliveryLng: '23.32', totalStotinki: 1000 }),
      order({ id: 'o2', deliveryLat: '42.58', deliveryLng: '23.32', totalStotinki: 2000 }),
    ];
    const result = assembleDaySuggestion(pool, new Map(), null, ['2026-07-10', '2026-07-11']);

    expect(result.unplaced).toEqual([]);
    for (const day of result.days) {
      expect(day.spreadKm).toBe(0);
    }
  });

  it('routes an un-geocoded order to unplaced with the right fields, never onto a day', () => {
    const pool: ReschedulableOrder[] = [
      order({ id: 'geo', deliveryLat: '42.71', deliveryLng: '23.32', totalStotinki: 500 }),
      order({
        id: 'nogeo',
        orderNumber: 42,
        customerName: 'Иван Иванов',
        totalStotinki: 1234,
        deliveryLat: null,
        deliveryLng: null,
      }),
    ];
    const result = assembleDaySuggestion(pool, new Map(), depot, ['2026-07-10']);

    expect(result.unplaced).toEqual([
      { id: 'nogeo', orderNumber: 42, customerName: 'Иван Иванов', totalStotinki: 1234 },
    ]);
    const allDayOrderIds = result.days.flatMap((d) => d.orders.map((o) => o.id));
    expect(allDayOrderIds).not.toContain('nogeo');
    expect(allDayOrderIds).toContain('geo');
  });

  it('merges harvest lines for the same product across two orders landing on the same day', () => {
    // A single requested day forces both geocoded orders onto it.
    const pool: ReschedulableOrder[] = [
      order({ id: 'o1', deliveryLat: '42.71', deliveryLng: '23.32', totalStotinki: 1000 }),
      order({ id: 'o2', deliveryLat: '42.58', deliveryLng: '23.32', totalStotinki: 2000 }),
    ];
    const itemsByOrder = new Map<string, { productName: string | null; quantity: number }[]>([
      ['o1', [{ productName: 'Домати', quantity: 3 }]],
      ['o2', [{ productName: 'Домати', quantity: 5 }]],
    ]);
    const result = assembleDaySuggestion(pool, itemsByOrder, depot, ['2026-07-10']);

    expect(result.days).toHaveLength(1);
    const [day] = result.days;
    expect(day.orders.map((o) => o.id).sort()).toEqual(['o1', 'o2']);
    expect(day.harvest).toEqual([{ productName: 'Домати', quantity: 8 }]);
  });
});
