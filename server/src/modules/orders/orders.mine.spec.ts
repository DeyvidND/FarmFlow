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

import { OrdersService } from './orders.service';

describe('OrdersService.ordersForFarmer', () => {
  function makeSvc(orderRows: unknown[], itemRows: unknown[]) {
    let selectCall = 0;
    const chain: any = {};
    chain.select = jest.fn(() => {
      selectCall += 1;
      return chain;
    });
    chain.from = jest.fn(() => chain);
    chain.innerJoin = jest.fn(() => chain);
    chain.leftJoin = jest.fn(() => chain);
    chain.where = jest.fn(() => chain);
    chain.groupBy = jest.fn(() => chain);
    chain.orderBy = jest.fn(() => chain);
    // First select() call is the page-of-orders query (chained through
    // .limit()); the second is the farmer's item rows for that page (no
    // .limit() call in that branch — resolves directly off .groupBy()/.where()).
    chain.limit = jest.fn(() => Promise.resolve(selectCall === 1 ? orderRows : itemRows));
    // Some branches await the chain itself (no trailing .limit()); make the
    // chain thenable so `await chain` resolves too.
    chain.then = (resolve: (v: unknown) => void) =>
      resolve(selectCall === 1 ? orderRows : itemRows);
    return new OrdersService(
      chain as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  it('includes pending and cancelled orders (unlike paymentsForFarmer)', async () => {
    const svc = makeSvc(
      [
        {
          day: '2026-07-07',
          id: 'o1',
          orderNumber: 1,
          customerName: 'Мария',
          customerPhone: null,
          customerEmail: null,
          status: 'pending',
          deliveryType: 'address',
          paymentMethod: 'cod',
          createdAt: '2026-07-07T08:00:00.000Z',
          slotFrom: null,
          slotTo: null,
          codOutcome: null,
          codOutcomeReason: null,
          shared: false,
          __keysetTs: '2026-07-07T08:00:00.000000',
        },
      ],
      [{ orderId: 'o1', productId: 'p1', productName: 'Домати', quantity: 2, priceStotinki: 300 }],
    );
    const page = await svc.ordersForFarmer('t', 'farmer-1', {});
    expect(page.orders).toHaveLength(1);
    expect(page.orders[0].status).toBe('pending');
    expect(page.orders[0].subtotalStotinki).toBe(600);
  });

  it('marks shared: true and still totals only the farmer\'s own items', async () => {
    const svc = makeSvc(
      [
        {
          day: '2026-07-07',
          id: 'o2',
          orderNumber: 2,
          customerName: null,
          customerPhone: null,
          customerEmail: null,
          status: 'confirmed',
          deliveryType: 'pickup',
          paymentMethod: 'cod',
          createdAt: '2026-07-07T09:00:00.000Z',
          slotFrom: null,
          slotTo: null,
          codOutcome: null,
          codOutcomeReason: null,
          shared: true,
          __keysetTs: '2026-07-07T09:00:00.000000',
        },
      ],
      [{ orderId: 'o2', productId: 'p2', productName: 'Краставици', quantity: 1, priceStotinki: 200 }],
    );
    const page = await svc.ordersForFarmer('t', 'farmer-1', {});
    expect(page.orders[0].shared).toBe(true);
    expect(page.orders[0].subtotalStotinki).toBe(200);
  });

  it('returns an empty page with no order rows', async () => {
    const svc = makeSvc([], []);
    const page = await svc.ordersForFarmer('t', 'farmer-1', {});
    expect(page.orders).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
