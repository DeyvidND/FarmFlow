import {
  PlatformInsightsService,
  computeInsights,
  type InsightsInput,
  type InsightsTenantRow,
  mondayOf,
  addMonths,
} from './insights.service';

const NOW = Date.parse('2026-06-12T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000);

/** Tenant row with sensible defaults; override only what a case cares about. */
function farm(over: Partial<InsightsTenantRow> & { id: string; name: string }): InsightsTenantRow {
  return {
    slug: over.id,
    phone: null,
    email: null,
    createdAt: daysAgo(100),
    deliveryEnabled: false,
    multiFarmer: false,
    multiSubcat: false,
    productOfWeekEnabled: false,
    stripeAccountId: null,
    stripeChargesEnabled: false,
    settings: null,
    ...over,
  };
}

/** Build an InsightsInput from per-tenant scalars (keeps the cases terse). */
function input(
  tenants: InsightsTenantRow[],
  agg: Record<
    string,
    Partial<{
      total: number;
      last7: number;
      prev7: number;
      lastOrderAt: Date | null;
      activeProducts: number;
      slots: number;
      publishedReviews: number;
      publishedArticles: number;
      activeSubs: number;
    }>
  >,
): InsightsInput {
  const rows = (k: string) => agg[k] ?? {};
  return {
    tenants,
    orders: tenants.map((t) => ({
      tenantId: t.id,
      total: rows(t.id).total ?? 0,
      last7: rows(t.id).last7 ?? 0,
      prev7: rows(t.id).prev7 ?? 0,
      lastOrderAt: rows(t.id).lastOrderAt ?? null,
    })),
    products: tenants.map((t) => ({ tenantId: t.id, active: rows(t.id).activeProducts ?? 0 })),
    slots: tenants.map((t) => ({ tenantId: t.id, count: rows(t.id).slots ?? 0 })),
    reviews: tenants.map((t) => ({ tenantId: t.id, published: rows(t.id).publishedReviews ?? 0 })),
    articles: tenants.map((t) => ({ tenantId: t.id, published: rows(t.id).publishedArticles ?? 0 })),
    subs: tenants.map((t) => ({ tenantId: t.id, active: rows(t.id).activeSubs ?? 0 })),
  };
}

describe('computeInsights — signals', () => {
  it('flags an aged farm with no products as empty_shop (and not no_orders)', () => {
    const t = [farm({ id: 'a', name: 'Празна', createdAt: daysAgo(30) })];
    const out = computeInsights(input(t, {}), NOW);
    const keys = out.signals[0].signals.map((s) => s.key);
    expect(keys).toEqual(['empty_shop']);
  });

  it('does not flag a brand-new empty farm (still within onboarding window)', () => {
    const t = [farm({ id: 'a', name: 'Нова', createdAt: daysAgo(2) })];
    const out = computeInsights(input(t, {}), NOW);
    expect(out.signals).toHaveLength(0);
  });

  it('flags products-but-no-orders as no_orders', () => {
    const t = [farm({ id: 'b', name: 'Без поръчки', createdAt: daysAgo(10) })];
    const out = computeInsights(input(t, { b: { activeProducts: 3, total: 0 } }), NOW);
    expect(out.signals[0].signals.map((s) => s.key)).toEqual(['no_orders']);
  });

  it('flags a farm silent >30d as dormant', () => {
    const t = [farm({ id: 'c', name: 'Заглъхнала' })];
    const out = computeInsights(
      input(t, { c: { activeProducts: 5, total: 10, lastOrderAt: daysAgo(40) } }),
      NOW,
    );
    expect(out.signals[0].signals.map((s) => s.key)).toContain('dormant');
  });

  it('flags a >50% week-over-week fall as dropping (not dormant)', () => {
    const t = [farm({ id: 'd', name: 'Спад' })];
    const out = computeInsights(
      input(t, { d: { activeProducts: 3, total: 20, lastOrderAt: daysAgo(1), prev7: 8, last7: 2 } }),
      NOW,
    );
    const keys = out.signals[0].signals.map((s) => s.key);
    expect(keys).toContain('dropping');
    expect(keys).not.toContain('dormant');
  });

  it('does not flag dropping when the prior week was too thin', () => {
    const t = [farm({ id: 'd', name: 'Малко' })];
    const out = computeInsights(
      input(t, { d: { activeProducts: 3, total: 4, lastOrderAt: daysAgo(1), prev7: 2, last7: 0 } }),
      NOW,
    );
    expect(out.signals).toHaveLength(0);
  });

  it('stacks stripe_incomplete + econt_incomplete and sorts by severity', () => {
    const t = [
      farm({
        id: 'f',
        name: 'Незавършена',
        createdAt: daysAgo(20),
        stripeAccountId: 'acct_1',
        stripeChargesEnabled: false,
        settings: { delivery: { econt: { username: 'x', configured: false } } },
      }),
    ];
    const out = computeInsights(
      input(t, { f: { activeProducts: 2, total: 3, lastOrderAt: daysAgo(2) } }),
      NOW,
    );
    expect(out.signals[0].signals.map((s) => s.key)).toEqual(['stripe_incomplete', 'econt_incomplete']);
    expect(out.signals[0].maxSeverity).toBe(65);
  });

  it('treats a fully-configured econt as not-incomplete', () => {
    const t = [
      farm({
        id: 'g',
        name: 'Готова',
        settings: { delivery: { econt: { username: 'x', passwordEnc: 'y', configured: true } } },
      }),
    ];
    const out = computeInsights(
      input(t, { g: { activeProducts: 2, total: 9, lastOrderAt: daysAgo(1), prev7: 4, last7: 5 } }),
      NOW,
    );
    expect(out.signals).toHaveLength(0);
  });

  it('sorts farms by max severity, healthy farms excluded', () => {
    const t = [
      farm({ id: 'healthy', name: 'Здрава' }),
      farm({ id: 'empty', name: 'Празна', createdAt: daysAgo(30) }),
      farm({ id: 'noorders', name: 'Без поръчки', createdAt: daysAgo(10) }),
    ];
    const out = computeInsights(
      input(t, {
        healthy: { activeProducts: 4, total: 50, lastOrderAt: daysAgo(0), prev7: 5, last7: 6 },
        noorders: { activeProducts: 3, total: 0 },
      }),
      NOW,
    );
    expect(out.signals.map((s) => s.tenantId)).toEqual(['empty', 'noorders']);
  });
});

describe('computeInsights — adoption', () => {
  it('counts real use per feature and sorts least-used first', () => {
    const t = [
      farm({ id: '1', name: 'A', deliveryEnabled: true, stripeChargesEnabled: true }),
      farm({ id: '2', name: 'B', deliveryEnabled: true, multiFarmer: true }),
      farm({ id: '3', name: 'C' }),
      farm({ id: '4', name: 'D' }),
    ];
    const out = computeInsights(
      input(t, {
        '1': { activeProducts: 2, total: 5, lastOrderAt: daysAgo(1), slots: 3, publishedReviews: 2 },
        '2': { activeProducts: 2, total: 5, lastOrderAt: daysAgo(1) },
        '3': { activeProducts: 2, total: 5, lastOrderAt: daysAgo(1) },
        '4': { activeProducts: 2, total: 5, lastOrderAt: daysAgo(1) },
      }),
      NOW,
    );
    const byKey = Object.fromEntries(out.adoption.map((a) => [a.key, a]));
    expect(out.totalFarms).toBe(4);
    expect(byKey.delivery.count).toBe(2);
    expect(byKey.delivery.pct).toBe(50);
    expect(byKey.stripe.count).toBe(1);
    expect(byKey.slots.count).toBe(1);
    expect(byKey.reviews.count).toBe(1);
    expect(byKey.multiFarmer.count).toBe(1);
    expect(byKey.econt.count).toBe(0);
    // least-used first
    const pcts = out.adoption.map((a) => a.pct);
    expect([...pcts]).toEqual([...pcts].sort((x, y) => x - y));
  });

  it('handles zero farms without dividing by zero', () => {
    const out = computeInsights({ tenants: [], orders: [], products: [], slots: [], reviews: [], articles: [], subs: [] }, NOW);
    expect(out.totalFarms).toBe(0);
    expect(out.adoption.every((a) => a.pct === 0)).toBe(true);
  });
});

describe('PlatformInsightsService — Redis caching', () => {
  // A db that explodes if touched — proves the cache hit short-circuits Postgres.
  const explodingDb = new Proxy(
    {},
    {
      get() {
        throw new Error('Postgres must not be queried on a cache hit');
      },
    },
  ) as never;

  const svc = (cache: unknown) => new PlatformInsightsService(explodingDb, cache as never);

  it('insights() serves the cached snapshot without querying Postgres', async () => {
    const snapshot = { totalFarms: 3, farms: [], signals: [], adoption: [] };
    const cache = { get: jest.fn().mockResolvedValue(snapshot), set: jest.fn() };
    const out = await svc(cache).insights();
    expect(out).toBe(snapshot);
    expect(cache.get).toHaveBeenCalledWith('platform:insights');
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('timeseries() serves a cache hit, keyed by range + scope', async () => {
    const cached = { range: '7d', bucket: 'day', points: [] };
    const cache = { get: jest.fn().mockResolvedValue(cached), set: jest.fn() };
    const s = svc(cache);

    await s.timeseries('7d');
    expect(cache.get).toHaveBeenCalledWith('platform:timeseries:7d:all');

    const uuid = '11111111-1111-1111-1111-111111111111';
    await s.timeseries('30d', uuid);
    expect(cache.get).toHaveBeenCalledWith(`platform:timeseries:30d:${uuid}`);
  });

  it('timeseries() drops a non-uuid scope to the all-farms key', async () => {
    const cache = { get: jest.fn().mockResolvedValue({ range: '7d', bucket: 'day', points: [] }), set: jest.fn() };
    await svc(cache).timeseries('7d', 'not-a-uuid');
    expect(cache.get).toHaveBeenCalledWith('platform:timeseries:7d:all');
  });

  it('timeseries() rejects an invalid range before any cache or db work', async () => {
    const cache = { get: jest.fn(), set: jest.fn() };
    await expect(svc(cache).timeseries('bogus')).rejects.toThrow();
    expect(cache.get).not.toHaveBeenCalled();
  });
});

describe('date axis helpers', () => {
  it('mondayOf returns the ISO Monday of the week', () => {
    expect(mondayOf('2026-06-12')).toBe('2026-06-08'); // Fri → Mon
    expect(mondayOf('2026-06-08')).toBe('2026-06-08'); // Mon → Mon
    expect(mondayOf('2026-06-14')).toBe('2026-06-08'); // Sun → Mon
  });

  it('addMonths rolls year boundaries', () => {
    expect(addMonths('2026-01-01', -1)).toBe('2025-12-01');
    expect(addMonths('2026-11-01', 3)).toBe('2027-02-01');
    expect(addMonths('2026-06-01', 0)).toBe('2026-06-01');
  });
});
