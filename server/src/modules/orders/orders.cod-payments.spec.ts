import { groupCodPayments, type CodPaymentRow } from './orders.service';

const row = (over: Partial<CodPaymentRow>): CodPaymentRow => ({
  day: '2026-06-12',
  id: 'o',
  orderNumber: 1,
  customerName: 'Иван',
  totalStotinki: 1000,
  status: 'confirmed',
  deliveryType: 'address',
  createdAt: '2026-06-12T08:00:00.000Z',
  slotFrom: null,
  slotTo: null,
  ...over,
});

describe('groupCodPayments', () => {
  it('groups orders by day with per-day total + count', () => {
    const out = groupCodPayments([
      row({ id: 'a', day: '2026-06-12', totalStotinki: 1000 }),
      row({ id: 'b', day: '2026-06-12', totalStotinki: 500 }),
      row({ id: 'c', day: '2026-06-11', totalStotinki: 700 }),
    ]);
    expect(out.days).toHaveLength(2);
    const d12 = out.days.find((d) => d.day === '2026-06-12')!;
    expect(d12.count).toBe(2);
    expect(d12.totalStotinki).toBe(1500);
    expect(out.totalStotinki).toBe(2200);
    expect(out.count).toBe(3);
  });

  it('sorts days newest-first regardless of input order', () => {
    const out = groupCodPayments([
      row({ id: 'a', day: '2026-06-10' }),
      row({ id: 'b', day: '2026-06-13' }),
      row({ id: 'c', day: '2026-06-11' }),
    ]);
    expect(out.days.map((d) => d.day)).toEqual(['2026-06-13', '2026-06-11', '2026-06-10']);
  });

  it('flags delivered orders as collected, others as expected', () => {
    const out = groupCodPayments([
      row({ id: 'a', status: 'delivered' }),
      row({ id: 'b', status: 'out_for_delivery' }),
    ]);
    const orders = out.days[0].orders;
    expect(orders.find((o) => o.id === 'a')!.collected).toBe(true);
    expect(orders.find((o) => o.id === 'b')!.collected).toBe(false);
  });

  it('serialises createdAt Date to ISO and tolerates null', () => {
    const out = groupCodPayments([
      row({ id: 'a', createdAt: new Date('2026-06-12T06:30:00.000Z') }),
      row({ id: 'b', createdAt: null }),
    ]);
    const orders = out.days[0].orders;
    expect(orders.find((o) => o.id === 'a')!.createdAt).toBe('2026-06-12T06:30:00.000Z');
    expect(orders.find((o) => o.id === 'b')!.createdAt).toBeNull();
  });

  it('returns an empty summary for no rows', () => {
    expect(groupCodPayments([])).toEqual({ totalStotinki: 0, count: 0, days: [] });
  });
});
