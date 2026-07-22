import { sql } from 'drizzle-orm';
import { StatsService } from './stats.service';
import * as basketOverrides from '../orders/basket-revenue-overrides';

/**
 * Wiring test for finding #3 (statsForFarmer must not read €0.00 off a
 * basket order — "Farmers reconcile their payouts off these screens").
 * `../orders/basket-revenue-overrides` is mocked wholesale so this exercises
 * ONLY "does statsForFarmer actually consult the basket-aware override
 * machinery" — the arithmetic itself is covered exhaustively by
 * basket-revenue.util.spec.ts and basket-revenue-overrides.spec.ts.
 *
 * If statsForFarmer were reverted to the old
 * `orderItems.quantity * orderItems.priceStotinki` (ignoring baskets
 * entirely, so a farmer's own basket-child lines read as 0), neither mocked
 * function below would ever be called and this test fails.
 *
 * No test-DB harness exists in this repo (see stats.service.turnover.spec.ts's
 * header) — statsForFarmer itself otherwise has NO dedicated spec at all, so
 * the mock db here is a minimal, discriminator-keyed passthrough (mirroring
 * stats.service.turnover.spec.ts's `makeDb`) just robust enough that the
 * method's 8 concurrent subqueries don't crash on empty data; it is not
 * trying to newly prove the surrounding (pre-existing, unrelated) arithmetic.
 */
jest.mock('../orders/basket-revenue-overrides', () => ({
  loadBasketRevenueOverrides: jest.fn(),
  basketAwareLineRevenueSql: jest.fn(),
}));

function makeDb() {
  const pick = (proj: Record<string, unknown>): unknown[] => {
    const keys = Object.keys(proj ?? {});
    if (keys.includes('prevRevenue')) return [{ orderCount: 0, revenue: 0, prevOrderCount: 0, prevRevenue: 0 }];
    return []; // paymentP / topP / winKeys / priorKeys / seriesP / activeProducts / soldP / weekdayP
  };
  const chain = (proj: Record<string, unknown>) => {
    const b: any = {};
    for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'groupBy', 'orderBy', 'limit']) {
      b[m] = jest.fn(() => b);
    }
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(pick(proj)).then(res, rej);
    return b;
  };
  return {
    select: jest.fn((proj: Record<string, unknown>) => chain(proj)),
    selectDistinct: jest.fn((proj: Record<string, unknown>) => chain(proj)),
  };
}

describe('StatsService.statsForFarmer — basket revenue wiring', () => {
  beforeEach(() => jest.clearAllMocks());

  it('loads basket revenue overrides for the tenant before summing this farmer\'s line revenue', async () => {
    const mockedOverrides = new Map([['child-1', 1596]]);
    (basketOverrides.loadBasketRevenueOverrides as jest.Mock).mockResolvedValue(mockedOverrides);
    (basketOverrides.basketAwareLineRevenueSql as jest.Mock).mockReturnValue(sql`0`);

    const db = makeDb();
    const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
    const svc = new StatsService(db as never, cache as never);

    await svc.statsForFarmer('tenant-1', 'farmer-1', {});

    expect(basketOverrides.loadBasketRevenueOverrides).toHaveBeenCalledWith(db, 'tenant-1');
    expect(basketOverrides.basketAwareLineRevenueSql).toHaveBeenCalledWith(mockedOverrides);
  });
});
