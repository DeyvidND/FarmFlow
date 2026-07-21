import { OrdersService } from './orders.service';
import * as basketOverrides from './basket-revenue-overrides';

/**
 * Wiring test for finding #3 (paymentsForFarmer must not read €0.00 off a
 * basket order): `./basket-revenue-overrides` is mocked wholesale so this
 * exercises ONLY "does paymentsForFarmer actually consult the basket-aware
 * override machinery", not the arithmetic itself (that's covered exhaustively
 * by basket-revenue.util.spec.ts and basket-revenue-overrides.spec.ts). If
 * paymentsForFarmer were reverted to the old
 * `sum(orderItems.quantity * orderItems.priceStotinki)` — ignoring baskets
 * entirely — `loadBasketRevenueOverrides`/`basketAwareLineRevenueSql` would
 * never be called and this test fails.
 */
jest.mock('./basket-revenue-overrides', () => ({
  loadBasketRevenueOverrides: jest.fn(),
  basketAwareLineRevenueSql: jest.fn(),
}));

const CHAIN_METHODS = [
  'select', 'from', 'where', 'innerJoin', 'leftJoin', 'limit', 'orderBy', 'groupBy',
] as const;

/** Same thenable chainable Drizzle mock style as commission.service.spec.ts:
 *  every builder method returns the same `step`, and awaiting the chain
 *  resolves the next queued row array (FIFO). */
function makeDb() {
  const queue: unknown[] = [];
  const step: any = {};
  for (const m of CHAIN_METHODS) step[m] = jest.fn(() => step);
  step.then = (resolve: (v: unknown) => void) => resolve(queue.shift());
  const db: any = { queue: (v: unknown) => queue.push(v) };
  for (const m of CHAIN_METHODS) db[m] = jest.fn(() => step);
  return db;
}

function makeSvc(db: unknown) {
  return new OrdersService(
    db as never,
    { geocode: jest.fn(), geocodeCity: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { invalidate: jest.fn() } as never,
  );
}

describe('OrdersService.paymentsForFarmer — basket revenue wiring', () => {
  beforeEach(() => jest.clearAllMocks());

  it('loads basket revenue overrides for the tenant before building the sum expression', async () => {
    const mockedOverrides = new Map([['child-1', 1596]]);
    (basketOverrides.loadBasketRevenueOverrides as jest.Mock).mockResolvedValue(mockedOverrides);
    (basketOverrides.basketAwareLineRevenueSql as jest.Mock).mockReturnValue({} as never);

    const db = makeDb();
    db.queue([]); // the paginated list query
    db.queue([]); // the totals aggRows query (cur is undefined → first page runs it)

    const svc = makeSvc(db);
    await svc.paymentsForFarmer('tenant-1', 'farmer-1', {});

    expect(basketOverrides.loadBasketRevenueOverrides).toHaveBeenCalledWith(db, 'tenant-1');
    // Both the per-order list sum AND the totals aggregate must be built from
    // the SAME overrides map — a basket's proportional share must agree
    // between what a producer sees per-order and in their running totals.
    expect(basketOverrides.basketAwareLineRevenueSql).toHaveBeenCalledWith(mockedOverrides);
    const calls = (basketOverrides.basketAwareLineRevenueSql as jest.Mock).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const call of calls) expect(call[0]).toBe(mockedOverrides);
  });
});
