import { PublicOrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

// The public order recap (GET /public/:slug/orders/:id) is reachable by anyone
// holding the order UUID and previously had no per-route throttle. Assert the
// @Throttle metadata is present (version-agnostic: match any throttler
// metadata key rather than a library-internal constant), mirroring
// farmers.throttle.spec.ts's convention.
const throttleKeys = (fn: object) =>
  Reflect.getMetadataKeys(fn).filter((k) => String(k).toLowerCase().includes('throttler'));

describe('PublicOrdersController — recap throttle', () => {
  it('throttles GET :id (getPublicSummary)', () => {
    expect(throttleKeys(PublicOrdersController.prototype.getPublicSummary).length).toBeGreaterThan(0);
  });
});

/** Minimal chainable select mock: two sequential `select()` calls inside
 *  findPublicOrderSummary — the order+tenant+slot join (terminates at
 *  `.limit()`) and the order items lookup (terminates at `.where()`). */
function makeDb(orderRow: unknown, itemRows: unknown[]) {
  let call = 0;
  const select = jest.fn(() => {
    const isFirst = call === 0;
    call++;
    const c: any = {};
    c.from = jest.fn(() => c);
    c.innerJoin = jest.fn(() => c);
    c.leftJoin = jest.fn(() => c);
    const whereResult = isFirst ? [] : itemRows; // overridden by .limit() on the first call
    c.where = jest.fn(() => (isFirst ? c : Promise.resolve(whereResult)));
    c.limit = jest.fn(() => Promise.resolve(orderRow ? [orderRow] : []));
    return c;
  });
  return { select } as never;
}

describe('OrdersService.findPublicOrderSummary — PII minimization', () => {
  it('never includes customerName in the recap (buyer already knows their own name)', async () => {
    const orderRow = {
      id: 'order-1',
      orderNumber: 1,
      status: 'pending',
      paidAt: null,
      totalStotinki: 1500,
      customerName: 'Иван Иванов',
      customerPhone: '0888000000',
      customerEmail: 'ivan@example.com',
      deliveryType: 'address',
      econtOffice: null,
      slotDate: null,
      slotFrom: null,
      slotTo: null,
      createdAt: new Date('2026-07-08T10:00:00Z'),
    };
    const svc = new OrdersService(
      makeDb(orderRow, []),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const summary = await svc.findPublicOrderSummary('ferma', 'order-1');

    expect(summary).not.toHaveProperty('customerName');
    expect(JSON.stringify(summary)).not.toContain('Иван');
    expect(summary.id).toBe('order-1');
  });
});
