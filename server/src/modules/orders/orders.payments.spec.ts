import { buildPaymentsSummary, type PaymentRow } from './orders.service';

const row = (over: Partial<PaymentRow>): PaymentRow => ({
  day: '2026-06-12',
  id: 'o',
  orderNumber: 1,
  customerName: 'Иван',
  customerPhone: '0888123456',
  customerEmail: 'ivan@example.com',
  totalStotinki: 1000,
  status: 'confirmed',
  deliveryType: 'address',
  paymentMethod: 'cod',
  createdAt: '2026-06-12T08:00:00.000Z',
  paidAt: null,
  slotFrom: null,
  slotTo: null,
  ...over,
});

describe('buildPaymentsSummary', () => {
  it('sorts newest day first, then newest created within a day', () => {
    const out = buildPaymentsSummary([
      row({ id: 'a', day: '2026-06-10', createdAt: '2026-06-10T08:00:00.000Z' }),
      row({ id: 'b', day: '2026-06-13', createdAt: '2026-06-13T06:00:00.000Z' }),
      row({ id: 'c', day: '2026-06-13', createdAt: '2026-06-13T09:00:00.000Z' }),
    ]);
    expect(out.orders.map((o) => o.id)).toEqual(['c', 'b', 'a']);
  });

  it('derives paymentStatus per channel (cash / pending / paid)', () => {
    const out = buildPaymentsSummary([
      row({ id: 'cod', paymentMethod: 'cod', paidAt: null }),
      row({ id: 'unpaid', paymentMethod: 'online', paidAt: null }),
      row({ id: 'paid', paymentMethod: 'online', paidAt: '2026-06-12T09:00:00.000Z' }),
    ]);
    const by = Object.fromEntries(out.orders.map((o) => [o.id, o.paymentStatus]));
    expect(by.cod).toBe('cash');
    expect(by.unpaid).toBe('pending_online');
    expect(by.paid).toBe('paid');
  });

  it('flags collected: COD when delivered, card when paid', () => {
    const out = buildPaymentsSummary([
      row({ id: 'cod-due', paymentMethod: 'cod', status: 'out_for_delivery' }),
      row({ id: 'cod-done', paymentMethod: 'cod', status: 'delivered' }),
      row({ id: 'card-due', paymentMethod: 'online', paidAt: null }),
      row({ id: 'card-paid', paymentMethod: 'online', paidAt: '2026-06-12T09:00:00.000Z' }),
    ]);
    const by = Object.fromEntries(out.orders.map((o) => [o.id, o.collected]));
    expect(by['cod-due']).toBe(false);
    expect(by['cod-done']).toBe(true);
    expect(by['card-due']).toBe(false);
    expect(by['card-paid']).toBe(true);
  });

  it('totals: COD counts every order, card counts only paid ones', () => {
    const out = buildPaymentsSummary([
      row({ id: 'a', paymentMethod: 'cod', totalStotinki: 1000 }),
      row({ id: 'b', paymentMethod: 'cod', totalStotinki: 500 }),
      row({ id: 'c', paymentMethod: 'online', totalStotinki: 2000, paidAt: '2026-06-12T09:00:00.000Z' }),
      row({ id: 'd', paymentMethod: 'online', totalStotinki: 9999, paidAt: null }), // unpaid → excluded
    ]);
    expect(out.codTotalStotinki).toBe(1500);
    expect(out.codCount).toBe(2);
    expect(out.cardTotalStotinki).toBe(2000);
    expect(out.cardCount).toBe(1);
    expect(out.totalStotinki).toBe(3500);
    expect(out.count).toBe(3);
  });

  it('serialises createdAt / paidAt Dates to ISO and tolerates null', () => {
    const out = buildPaymentsSummary([
      row({
        id: 'a',
        createdAt: new Date('2026-06-12T06:30:00.000Z'),
        paidAt: new Date('2026-06-12T07:00:00.000Z'),
        paymentMethod: 'online',
      }),
      row({ id: 'b', createdAt: null, paidAt: null }),
    ]);
    const a = out.orders.find((o) => o.id === 'a')!;
    const b = out.orders.find((o) => o.id === 'b')!;
    expect(a.createdAt).toBe('2026-06-12T06:30:00.000Z');
    expect(a.paidAt).toBe('2026-06-12T07:00:00.000Z');
    expect(b.createdAt).toBeNull();
    expect(b.paidAt).toBeNull();
  });

  it('returns an empty summary for no rows', () => {
    expect(buildPaymentsSummary([])).toEqual({
      totalStotinki: 0,
      count: 0,
      codTotalStotinki: 0,
      codCount: 0,
      cardTotalStotinki: 0,
      cardCount: 0,
      orders: [],
    });
  });
});
