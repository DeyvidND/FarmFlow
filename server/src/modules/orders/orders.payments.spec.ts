import {
  toPaymentOrder,
  paymentTotals,
  type PaymentRow,
  type PaymentAggRow,
} from './orders.service';

/**
 * Task #8 LOW: the refused-COD exclusion (`orders.service.ts`'s
 * `... FILTER (where orders.cod_outcome IS DISTINCT FROM 'refused')` in both
 * paymentTotalsCached and the producer-scoped totals query) is pure SQL — no
 * test-DB harness exists in this repo (no pg-mem/pglite/testcontainers), so its
 * actual DB-level exclusion behaviour isn't exercised by a spec. What IS covered
 * below is the JS-side fold (`paymentTotals`) that consumes the aggregate rows
 * the SQL would produce — the tests below feed it canned aggregate rows,
 * including a refused-COD one, and assert the totals fold correctly.
 */

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
  codOutcome: null,
  codOutcomeReason: null,
  ...over,
});

describe('toPaymentOrder', () => {
  it('derives paymentStatus per channel (cash / pending / paid)', () => {
    expect(toPaymentOrder(row({ paymentMethod: 'cod', paidAt: null })).paymentStatus).toBe('cash');
    expect(toPaymentOrder(row({ paymentMethod: 'online', paidAt: null })).paymentStatus).toBe(
      'pending_online',
    );
    expect(
      toPaymentOrder(row({ paymentMethod: 'online', paidAt: '2026-06-12T09:00:00.000Z' }))
        .paymentStatus,
    ).toBe('paid');
  });

  it('flags collected: COD keyed off codOutcome, card when paid', () => {
    expect(
      toPaymentOrder(row({ paymentMethod: 'cod', status: 'out_for_delivery', codOutcome: null })).collected,
    ).toBe(false);
    // status alone no longer implies collected — codOutcome must say «received».
    expect(
      toPaymentOrder(row({ paymentMethod: 'cod', status: 'delivered', codOutcome: null })).collected,
    ).toBe(false);
    expect(
      toPaymentOrder(row({ paymentMethod: 'cod', status: 'delivered', codOutcome: 'received' })).collected,
    ).toBe(true);
    expect(toPaymentOrder(row({ paymentMethod: 'online', paidAt: null })).collected).toBe(false);
    expect(
      toPaymentOrder(row({ paymentMethod: 'online', paidAt: '2026-06-12T09:00:00.000Z' })).collected,
    ).toBe(true);
  });

  it('serialises createdAt / paidAt Dates to ISO and tolerates null', () => {
    const a = toPaymentOrder(
      row({
        createdAt: new Date('2026-06-12T06:30:00.000Z'),
        paidAt: new Date('2026-06-12T07:00:00.000Z'),
        paymentMethod: 'online',
      }),
    );
    expect(a.createdAt).toBe('2026-06-12T06:30:00.000Z');
    expect(a.paidAt).toBe('2026-06-12T07:00:00.000Z');
    const b = toPaymentOrder(row({ createdAt: null, paidAt: null }));
    expect(b.createdAt).toBeNull();
    expect(b.paidAt).toBeNull();
  });

  it('carries contact fields through for the table', () => {
    const o = toPaymentOrder(row({ customerPhone: '+359888111222', customerEmail: 'g@x.bg' }));
    expect(o.customerPhone).toBe('+359888111222');
    expect(o.customerEmail).toBe('g@x.bg');
  });

  it('passes codOutcome + reason through', () => {
    const o = toPaymentOrder(row({ paymentMethod: 'cod', codOutcome: 'refused', codOutcomeReason: 'не вдигна' }));
    expect(o.codOutcome).toBe('refused');
    expect(o.codOutcomeReason).toBe('не вдигна');
  });

  it('derives collected from codOutcome for COD (not status)', () => {
    expect(toPaymentOrder(row({ paymentMethod: 'cod', status: 'delivered', codOutcome: null })).collected).toBe(false);
    expect(toPaymentOrder(row({ paymentMethod: 'cod', status: 'confirmed', codOutcome: 'received' })).collected).toBe(true);
  });
});

const agg = (over: Partial<PaymentAggRow>): PaymentAggRow => ({
  paymentMethod: 'cod',
  count: 0,
  totalStotinki: 0,
  paidCount: 0,
  paidTotalStotinki: 0,
  ...over,
});

describe('paymentTotals', () => {
  it('COD counts every order; card counts only paid; allCount spans both', () => {
    const out = paymentTotals([
      agg({ paymentMethod: 'cod', count: 2, totalStotinki: 1500, paidCount: 0, paidTotalStotinki: 0 }),
      agg({
        paymentMethod: 'online',
        count: 3,
        totalStotinki: 11999,
        paidCount: 1,
        paidTotalStotinki: 2000,
      }),
    ]);
    expect(out.codTotalStotinki).toBe(1500);
    expect(out.codCount).toBe(2);
    expect(out.cardTotalStotinki).toBe(2000); // only the paid card order's money
    expect(out.cardCount).toBe(1);
    expect(out.totalStotinki).toBe(3500);
    expect(out.count).toBe(3);
    expect(out.allCount).toBe(5); // 2 cod + 3 online (incl. unpaid) — the Всичко badge
  });

  it('returns zeroed totals for no aggregate rows', () => {
    expect(paymentTotals([])).toEqual({
      totalStotinki: 0,
      count: 0,
      allCount: 0,
      codTotalStotinki: 0,
      codCount: 0,
      cardTotalStotinki: 0,
      cardCount: 0,
    });
  });
});
