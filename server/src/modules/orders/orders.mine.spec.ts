import { toFarmerOrder, type FarmerOrderRow } from './orders.service';

const row = (over: Partial<FarmerOrderRow>): FarmerOrderRow => ({
  day: '2026-07-07',
  id: 'o1',
  orderNumber: 5,
  customerName: 'Мария',
  customerPhone: '0888111222',
  customerEmail: 'maria@example.com',
  status: 'pending',
  deliveryType: 'address',
  paymentMethod: 'cod',
  createdAt: '2026-07-07T08:00:00.000Z',
  slotFrom: null,
  slotTo: null,
  codOutcome: null,
  codOutcomeReason: null,
  shared: false,
  items: [{ productId: 'p1', productName: 'Домати', quantity: 3, priceStotinki: 250 }],
  ...over,
});

describe('toFarmerOrder', () => {
  it('sums the farmer\'s own item lines into subtotalStotinki', () => {
    const o = toFarmerOrder(
      row({
        items: [
          { productId: 'p1', productName: 'Домати', quantity: 3, priceStotinki: 250 },
          { productId: 'p2', productName: 'Краставици', quantity: 2, priceStotinki: 150 },
        ],
      }),
    );
    expect(o.subtotalStotinki).toBe(3 * 250 + 2 * 150);
    expect(o.items).toHaveLength(2);
  });

  it('passes through shared flag, status, and contact fields', () => {
    const o = toFarmerOrder(row({ shared: true, status: 'cancelled', customerPhone: '+359888999000' }));
    expect(o.shared).toBe(true);
    expect(o.status).toBe('cancelled');
    expect(o.customerPhone).toBe('+359888999000');
  });

  it('serialises createdAt Date to ISO and tolerates null', () => {
    const a = toFarmerOrder(row({ createdAt: new Date('2026-07-07T06:30:00.000Z') }));
    expect(a.createdAt).toBe('2026-07-07T06:30:00.000Z');
    const b = toFarmerOrder(row({ createdAt: null }));
    expect(b.createdAt).toBeNull();
  });

  it('passes codOutcome + reason through unchanged', () => {
    const o = toFarmerOrder(row({ codOutcome: 'refused', codOutcomeReason: 'не вдигна' }));
    expect(o.codOutcome).toBe('refused');
    expect(o.codOutcomeReason).toBe('не вдигна');
  });
});
