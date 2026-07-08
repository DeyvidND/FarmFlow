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

  it('rejects a spoofed purchase event on the public beacon — purchases are server-only (recordPurchase)', async () => {
    const insert = jest.fn();
    const svc = makeService(insert);
    await svc.track(
      'ferma',
      { type: 'purchase' as any, orderId: 'o1', value: 999999 },
      '1.1.1.1',
      'Mozilla/5.0 (iPhone)',
    );
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('AnalyticsService.recordPurchase', () => {
  /** insert().values().onConflictDoNothing() — the dedup itself is a Postgres-side
   *  partial unique index (site_events_purchase_order_uniq); a unit test can only
   *  assert the query shape that makes that index do its job, not the DB behavior. */
  function makeService(onConflictDoNothing: jest.Mock) {
    const values = jest.fn().mockReturnValue({ onConflictDoNothing });
    const db = { insert: jest.fn().mockReturnValue({ values }) } as any;
    const cache = { resolveTenant: jest.fn() } as any;
    const config = { get: (k: string, d?: string) => d } as any;
    return { svc: new AnalyticsService(db, cache, config), values };
  }

  it('inserts a purchase row with an ON CONFLICT DO NOTHING guard on (tenant, order)', async () => {
    const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
    const { svc, values } = makeService(onConflictDoNothing);
    await svc.recordPurchase({ tenantId: 't1', orderId: 'o1', visitorHash: 'h1', valueStotinki: 2500 });
    expect(values).toHaveBeenCalledTimes(1);
    const row = values.mock.calls[0][0];
    expect(row).toEqual({
      tenantId: 't1',
      visitorHash: 'h1',
      eventType: 'purchase',
      orderId: 'o1',
      valueStotinki: 2500,
    });
    expect(row).not.toHaveProperty('device');
    // Conflict target must match the partial unique index's columns; a caller
    // that races (Stripe's twin webhooks) relies on Postgres — not this JS layer
    // — to silently drop the second insert.
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
    const conflictConfig = onConflictDoNothing.mock.calls[0][0];
    expect(conflictConfig.target).toHaveLength(2);
  });

  it('swallows an insert failure instead of throwing', async () => {
    const onConflictDoNothing = jest.fn().mockRejectedValue(new Error('db down'));
    const { svc } = makeService(onConflictDoNothing);
    await expect(
      svc.recordPurchase({ tenantId: 't1', orderId: 'o1', visitorHash: 'h1', valueStotinki: 2500 }),
    ).resolves.toBeUndefined();
  });
});
