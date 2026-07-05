import { AnalyticsService } from './analytics.service';

function makeService(insertSpy: jest.Mock) {
  const db = { insert: () => ({ values: insertSpy }) } as any;
  const cache = { resolveTenant: jest.fn().mockResolvedValue({ id: 't1', slug: 'ferma' }) } as any;
  const config = { get: (k: string, d?: string) => (k === 'ANALYTICS_SALT' ? 'secret' : d) } as any;
  return new AnalyticsService(db, cache, config);
}

describe('AnalyticsService.track', () => {
  it('drops bot user-agents without inserting', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const svc = makeService(insert);
    await svc.track('ferma', { type: 'page_view', path: '/' }, '1.2.3.4', 'Googlebot/2.1');
    expect(insert).not.toHaveBeenCalled();
  });

  it('inserts a row with a hash and never the raw ip', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const svc = makeService(insert);
    await svc.track(
      'ferma',
      { type: 'page_view', path: '/', referrer: 'https://google.com/x' },
      '9.9.9.9',
      'Mozilla/5.0 (iPhone)',
    );
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0];
    expect(row.tenantId).toBe('t1');
    expect(row.eventType).toBe('page_view');
    expect(row.device).toBe('mobile');
    expect(row.referrerHost).toBe('google.com');
    expect(row.visitorHash).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain('9.9.9.9');
  });

  it('drops an unknown tenant', async () => {
    const insert = jest.fn();
    const db = { insert: () => ({ values: insert }) } as any;
    const cache = { resolveTenant: jest.fn().mockRejectedValue(new Error('not found')) } as any;
    const config = { get: () => 'secret' } as any;
    const svc = new AnalyticsService(db, cache, config);
    await svc.track('nope', { type: 'page_view', path: '/' }, '1.1.1.1', 'Mozilla/5.0 (iPhone)');
    expect(insert).not.toHaveBeenCalled();
  });

  it('ignores an invalid event type', async () => {
    const insert = jest.fn();
    const svc = makeService(insert);
    await svc.track('ferma', { type: 'nonsense' as any, path: '/' }, '1.1.1.1', 'Mozilla/5.0 (iPhone)');
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('AnalyticsService.recordPurchase', () => {
  /** `select().from().where().limit()` returns `guardResult` (the existing-row
   *  guard); `insert().values()` is the spy under test. */
  function makeService(guardResult: unknown[], insertSpy: jest.Mock) {
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(guardResult) }) }) }),
      insert: () => ({ values: insertSpy }),
    } as any;
    const cache = { resolveTenant: jest.fn() } as any;
    const config = { get: (k: string, d?: string) => d } as any;
    return new AnalyticsService(db, cache, config);
  }

  it('inserts a purchase row when no prior purchase event exists for the order', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const svc = makeService([], insert);
    await svc.recordPurchase({ tenantId: 't1', orderId: 'o1', visitorHash: 'h1', valueStotinki: 2500 });
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0];
    expect(row).toEqual({
      tenantId: 't1',
      visitorHash: 'h1',
      eventType: 'purchase',
      orderId: 'o1',
      valueStotinki: 2500,
    });
    expect(row).not.toHaveProperty('device');
  });

  it('skips the insert when a purchase row already exists for this order', async () => {
    const insert = jest.fn();
    const svc = makeService([{ id: 1 }], insert);
    await svc.recordPurchase({ tenantId: 't1', orderId: 'o1', visitorHash: 'h1', valueStotinki: 2500 });
    expect(insert).not.toHaveBeenCalled();
  });

  it('swallows an insert failure instead of throwing', async () => {
    const insert = jest.fn().mockRejectedValue(new Error('db down'));
    const svc = makeService([], insert);
    await expect(
      svc.recordPurchase({ tenantId: 't1', orderId: 'o1', visitorHash: 'h1', valueStotinki: 2500 }),
    ).resolves.toBeUndefined();
  });
});
