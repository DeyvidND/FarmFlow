import { SQL, Param } from 'drizzle-orm';
import { StatsService } from './stats.service';

/** Pull every embedded Param value out of a drizzle SQL tree (mirrors the
 *  routing/courier-assignment spec helpers) so a test can assert a WHERE clause
 *  actually constrained on a given value. */
function paramValues(node: unknown, out: unknown[] = []): unknown[] {
  if (node instanceof Param) out.push(node.value);
  else if (node instanceof SQL)
    for (const c of (node as unknown as { queryChunks: unknown[] }).queryChunks) paramValues(c, out);
  else if (Array.isArray(node)) for (const c of node) paramValues(c, out);
  return out;
}

/**
 * A db mock that RECORDS the WHERE argument of each concurrent query, keyed by
 * its projection — so a test can inspect the farmerRate lookup's clause rather
 * than trust a passthrough mock (which, per makeDb's own note, cannot see the
 * SQL). Used only for the tenant-scoping assertion below.
 */
function makeCapturingDb() {
  const wheres: Record<string, unknown> = {};
  const tag = (proj: Record<string, unknown>) => {
    const keys = Object.keys(proj ?? {});
    if (keys.includes('turnover')) return 'agg';
    if (keys.includes('t')) return 'series';
    if (keys.includes('settings')) return 'tenant';
    if (keys.includes('commissionRateBps')) return 'farmerRate';
    return 'other';
  };
  const canned = (t: string): unknown[] => {
    if (t === 'agg')
      return [{ turnover: 0, orderCount: 0, toDate: 0, undeliveredRevenue: 0, undeliveredCount: 0 }];
    if (t === 'tenant') return [{ settings: null }];
    return []; // series, farmerRate (no matching row for a foreign farmer)
  };
  const chain = (proj: Record<string, unknown>) => {
    const b: any = {};
    for (const m of ['from', 'innerJoin', 'leftJoin', 'groupBy', 'orderBy']) b[m] = jest.fn(() => b);
    b.where = jest.fn((w: unknown) => {
      wheres[tag(proj)] = w;
      return b;
    });
    b.limit = jest.fn(async () => canned(tag(proj)));
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(canned(tag(proj))).then(res, rej);
    return b;
  };
  return { db: { select: jest.fn((proj: Record<string, unknown>) => chain(proj)) }, wheres };
}

/**
 * StatsService.turnoverBreakdown (Task #9/#10 follow-up, MEDIUM #9/#10 coverage gap).
 *
 * No test-DB harness exists in this repo (no pg-mem/pglite/testcontainers) — every
 * query here is a hand-rolled chainable `db` mock that resolves canned rows, never
 * executes real SQL. That means these tests can only prove what the JS glue code
 * does with the numbers it's handed (basis normalization, the includeUndelivered
 * default/toggle, the commission-rate/platform-income arithmetic, and pass-through
 * of the undelivered aggregate). They deliberately do NOT — and cannot — prove that
 * the SQL `FILTER` clauses actually exclude undelivered rows at the DB level, or
 * that each `basis` value actually changes what the SQL groups by; asserting that
 * would be false confidence from a mock. Real coverage of that would need a
 * test-DB harness, which is out of scope here (bug-fixes-only mandate).
 *
 * Mock style mirrors dashboard.service.spec.ts: each `select(projection)` starts an
 * independent chain keyed off the projection's distinct column names, since the
 * four queries (agg / series / tenant / farmerRate) run concurrently under one
 * Promise.all — a shared FIFO queue would be call-order-fragile.
 */
function makeDb(r: {
  agg?: unknown[];
  series?: unknown[];
  tenant?: unknown[];
  farmerRate?: unknown[];
}) {
  const rows = {
    agg: r.agg ?? [
      { turnover: 0, orderCount: 0, toDate: 0, undeliveredRevenue: 0, undeliveredCount: 0 },
    ],
    series: r.series ?? [],
    tenant: r.tenant ?? [{ settings: null }],
    farmerRate: r.farmerRate ?? [],
  };

  const pick = (proj: Record<string, unknown>): unknown[] => {
    const keys = Object.keys(proj ?? {});
    if (keys.includes('turnover')) return rows.agg;
    if (keys.includes('t')) return rows.series;
    if (keys.includes('settings')) return rows.tenant;
    if (keys.includes('commissionRateBps')) return rows.farmerRate;
    return [];
  };

  const chain = (proj: Record<string, unknown>) => {
    const b: any = {};
    const passthrough = ['from', 'where', 'innerJoin', 'leftJoin', 'groupBy', 'orderBy'];
    for (const m of passthrough) b[m] = jest.fn(() => b);
    b.limit = jest.fn(async () => pick(proj));
    // Queries with no `.limit()` call (agg/series end in `.where()`/`.orderBy()`)
    // are awaited directly via Promise.all → resolve via `.then`.
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(pick(proj)).then(res, rej);
    return b;
  };

  return { select: jest.fn((proj: Record<string, unknown>) => chain(proj)) };
}

function makeSvc(r: Parameters<typeof makeDb>[0]) {
  const db = makeDb(r);
  const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
  const svc = new StatsService(db as never, cache as never);
  return { svc, db, cache };
}

describe('StatsService.turnoverBreakdown', () => {
  describe('basis normalization', () => {
    it('accepts "delivery"', async () => {
      const { svc } = makeSvc({});
      const result = await svc.turnoverBreakdown('t1', { basis: 'delivery' });
      expect(result.basis).toBe('delivery');
    });

    it('accepts "delivered"', async () => {
      const { svc } = makeSvc({});
      const result = await svc.turnoverBreakdown('t1', { basis: 'delivered' });
      expect(result.basis).toBe('delivered');
    });

    it('falls back to "placed" for an invalid basis', async () => {
      const { svc } = makeSvc({});
      const result = await svc.turnoverBreakdown('t1', { basis: 'bogus' });
      expect(result.basis).toBe('placed');
    });

    it('defaults to "placed" when omitted', async () => {
      const { svc } = makeSvc({});
      const result = await svc.turnoverBreakdown('t1', {});
      expect(result.basis).toBe('placed');
    });
  });

  describe('includeUndelivered default + toggle', () => {
    it('defaults to false when omitted', async () => {
      const { svc } = makeSvc({});
      const result = await svc.turnoverBreakdown('t1', {});
      expect(result.includeUndelivered).toBe(false);
    });

    it('reflects an explicit true', async () => {
      const { svc } = makeSvc({});
      const result = await svc.turnoverBreakdown('t1', { includeUndelivered: true });
      expect(result.includeUndelivered).toBe(true);
    });

    it('reflects an explicit false', async () => {
      const { svc } = makeSvc({});
      const result = await svc.turnoverBreakdown('t1', { includeUndelivered: false });
      expect(result.includeUndelivered).toBe(false);
    });
  });

  describe('platform income math', () => {
    it('platformIncomeStotinki === round(turnover * rateBps / 10000) when commission is enabled', async () => {
      const { svc } = makeSvc({
        agg: [{ turnover: 10_000, orderCount: 4, toDate: 25_000, undeliveredRevenue: 0, undeliveredCount: 0 }],
        tenant: [{ settings: { vendorFinance: { commissionEnabled: true, defaultCommissionRateBps: 750 } } }],
      });
      const result = await svc.turnoverBreakdown('t1', {});
      expect(result.commissionRateBps).toBe(750);
      expect(result.platformIncomeStotinki).toBe(Math.round((10_000 * 750) / 10_000)); // 750
      expect(result.platformIncomeToDateStotinki).toBe(Math.round((25_000 * 750) / 10_000)); // 1875
    });

    it('commission disabled → rate and both platform-income figures are 0', async () => {
      const { svc } = makeSvc({
        agg: [{ turnover: 10_000, orderCount: 4, toDate: 25_000, undeliveredRevenue: 0, undeliveredCount: 0 }],
        tenant: [{ settings: { vendorFinance: { commissionEnabled: false, defaultCommissionRateBps: 750 } } }],
      });
      const result = await svc.turnoverBreakdown('t1', {});
      expect(result.commissionEnabled).toBe(false);
      expect(result.commissionRateBps).toBe(0);
      expect(result.platformIncomeStotinki).toBe(0);
      expect(result.platformIncomeToDateStotinki).toBe(0);
    });

    it('a farmer-specific commissionRateBps override beats the tenant default', async () => {
      const { svc } = makeSvc({
        agg: [{ turnover: 20_000, orderCount: 2, toDate: 20_000, undeliveredRevenue: 0, undeliveredCount: 0 }],
        tenant: [{ settings: { vendorFinance: { commissionEnabled: true, defaultCommissionRateBps: 500 } } }],
        farmerRate: [{ commissionRateBps: 900 }],
      });
      const result = await svc.turnoverBreakdown('t1', { farmerId: 'farmer-1' });
      expect(result.commissionRateBps).toBe(900);
      expect(result.platformIncomeStotinki).toBe(Math.round((20_000 * 900) / 10_000)); // 1800
    });

    it('falls back to the tenant default when the farmer has no override (null)', async () => {
      const { svc } = makeSvc({
        agg: [{ turnover: 20_000, orderCount: 2, toDate: 20_000, undeliveredRevenue: 0, undeliveredCount: 0 }],
        tenant: [{ settings: { vendorFinance: { commissionEnabled: true, defaultCommissionRateBps: 500 } } }],
        farmerRate: [{ commissionRateBps: null }],
      });
      const result = await svc.turnoverBreakdown('t1', { farmerId: 'farmer-1' });
      expect(result.commissionRateBps).toBe(500);
    });
  });

  describe('undelivered slice pass-through', () => {
    it('undeliveredRevenueStotinki / undeliveredOrderCount pass through the canned aggregate unchanged', async () => {
      const { svc } = makeSvc({
        agg: [{ turnover: 5_000, orderCount: 3, toDate: 5_000, undeliveredRevenue: 4_200, undeliveredCount: 3 }],
      });
      const result = await svc.turnoverBreakdown('t1', {});
      expect(result.undeliveredRevenueStotinki).toBe(4_200);
      expect(result.undeliveredOrderCount).toBe(3);
    });
  });

  describe('tenant scoping of the per-farmer commission-rate lookup', () => {
    it('constrains the farmers lookup by tenant, so a foreign farmerId can not leak another tenant\'s rate', async () => {
      // Cross-tenant leak: the money aggregates are tenant-scoped (0 rows for a
      // foreign farmer), but the farmerRate lookup was `where(eq(farmers.id, id))`
      // with no tenant filter — so tenant A passing tenant B's farmer UUID got
      // back B's private negotiated commissionRateBps in the response.
      const { db, wheres } = makeCapturingDb();
      const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
      const svc = new StatsService(db as never, cache as never);

      await svc.turnoverBreakdown('tenant-A', { farmerId: 'farmer-of-tenant-B' });

      // The farmerRate query must carry BOTH ids, so a foreign farmer id matches
      // no row under this tenant.
      const params = paramValues(wheres.farmerRate);
      expect(params).toContain('farmer-of-tenant-B');
      expect(params).toContain('tenant-A');
    });
  });
});
