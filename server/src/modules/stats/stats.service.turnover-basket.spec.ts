import { sql } from 'drizzle-orm';
import { StatsService } from './stats.service';
import * as basketOverrides from '../orders/basket-revenue-overrides';

/**
 * Wiring test for finding #3's other half: StatsService.turnoverBreakdown.
 *
 * `../orders/basket-revenue-overrides` is mocked wholesale — the arithmetic is
 * covered by basket-revenue.util.spec.ts / basket-revenue-overrides.spec.ts.
 * This proves two things a revert could break independently:
 *
 *  1. Farmer-scoped (`opts.farmerId` set): must consult the basket-aware
 *     override, or a producer's own basket-child lines read as 0 turnover
 *     (the original bug).
 *  2. WHOLE-TENANT (no farmerId): must NOT apply the override. Unlike the
 *     farmer-scoped query — which excludes a basket's parent row via
 *     `products.farmer_id = farmerId`, so only the (corrected) children
 *     remain — the whole-tenant sum includes the parent row too. Naively
 *     applying the same override there would ADD the children's corrected
 *     shares on top of the parent's own (already-correct) price, silently
 *     double-counting every basket sale in the owner's turnover dashboard.
 *     This case is a NEW hazard the fix itself could introduce if the
 *     `opts.farmerId` guard were ever dropped, so it's asserted explicitly.
 */
jest.mock('../orders/basket-revenue-overrides', () => ({
  loadBasketRevenueOverrides: jest.fn(),
  basketAwareLineRevenueSql: jest.fn(),
}));

function makeDb() {
  const pick = (proj: Record<string, unknown>): unknown[] => {
    const keys = Object.keys(proj ?? {});
    if (keys.includes('turnover')) {
      return [{ turnover: 0, orderCount: 0, toDate: 0, undeliveredRevenue: 0, undeliveredCount: 0 }];
    }
    if (keys.includes('settings')) return [{ settings: null }];
    return []; // series, farmerRate
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
  return { select: jest.fn((proj: Record<string, unknown>) => chain(proj)) };
}

function makeSvc() {
  const db = makeDb();
  const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
  return { svc: new StatsService(db as never, cache as never), db };
}

describe('StatsService.turnoverBreakdown — basket revenue wiring', () => {
  beforeEach(() => jest.clearAllMocks());

  it('farmer-scoped: loads and applies the basket-aware override', async () => {
    const mockedOverrides = new Map([['child-1', 1596]]);
    (basketOverrides.loadBasketRevenueOverrides as jest.Mock).mockResolvedValue(mockedOverrides);
    (basketOverrides.basketAwareLineRevenueSql as jest.Mock).mockReturnValue(sql`0`);
    const { svc, db } = makeSvc();

    await svc.turnoverBreakdown('tenant-1', { farmerId: 'farmer-1' });

    expect(basketOverrides.loadBasketRevenueOverrides).toHaveBeenCalledWith(db, 'tenant-1');
    expect(basketOverrides.basketAwareLineRevenueSql).toHaveBeenCalledWith(mockedOverrides);
  });

  it('whole-tenant (no farmerId): does NOT apply the override — would double-count a basket otherwise', async () => {
    const { svc } = makeSvc();

    await svc.turnoverBreakdown('tenant-1', {});

    expect(basketOverrides.loadBasketRevenueOverrides).not.toHaveBeenCalled();
    expect(basketOverrides.basketAwareLineRevenueSql).not.toHaveBeenCalled();
  });
});
