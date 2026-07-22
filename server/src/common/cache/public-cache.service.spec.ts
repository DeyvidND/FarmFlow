import { PublicCacheService } from './public-cache.service';

/** Minimal Redis stub — returns null (cache miss) so resolveTenant always hits DB. */
function makeRedis() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };
}

/** Build a DB stub whose .select().from().where().limit() returns the given rows. */
function makeDb(rows: unknown[]) {
  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(rows),
  } as never;
}

const BASE_ROW = {
  id: 'tid-1',
  name: 'Ferma Test',
  slug: 'ferma-test',
  phone: null,
  email: null,
  deliveryEnabled: false,
  multiFarmer: false,
  multiSubcat: false,
  articlesEnabled: false,
  reviewsEnabled: false,
  productOfWeekEnabled: false,
  productOfWeekMode: 'off',
  productOfWeekId: null,
  productOfWeekNote: null,
  productOfWeekPlacement: 'section',
  stripeAccountId: null,
  settings: null,
};

describe('PublicCacheService.resolveTenant — negative sentinel caching', () => {
  it('stores a sentinel and throws 404 when the slug is not in the DB', async () => {
    const redis = makeRedis();
    const svc = new PublicCacheService(redis as never);
    await expect(svc.resolveTenant(makeDb([]), 'no-such-farm')).rejects.toMatchObject({
      status: 404,
    });
    // Sentinel must have been written with a short TTL.
    const [key, value, , ttl] = redis.set.mock.calls[0];
    expect(key).toBe('tenant:no-such-farm');
    expect(value).toBe('__404__');
    expect(Number(ttl)).toBeLessThanOrEqual(60);
  });

  it('throws 404 immediately from cache on a sentinel hit (no DB query)', async () => {
    const redis = {
      get: jest.fn().mockResolvedValue('__404__'),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };
    const db = makeDb([BASE_ROW]) as any; // would resolve if queried
    const svc = new PublicCacheService(redis as never);
    await expect(svc.resolveTenant(db, 'ghost-farm')).rejects.toMatchObject({ status: 404 });
    // DB must NOT have been touched.
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns a real tenant when the cache holds a JSON object (not a sentinel)', async () => {
    const meta = { id: 'tid-x', name: 'Real Farm', slug: 'real-farm' };
    const redis = {
      get: jest.fn().mockResolvedValue(JSON.stringify(meta)),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };
    const db = makeDb([]) as any; // empty — would 404 if queried
    const svc = new PublicCacheService(redis as never);
    const result = await svc.resolveTenant(db, 'real-farm');
    expect(result).toEqual(meta);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('PublicCacheService.delByPrefix', () => {
  it('deletes all matching keys across a single SCAN page', async () => {
    const redis = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn().mockResolvedValue(2),
      scan: jest.fn().mockResolvedValue(['0', ['econt:estimate:t1:a', 'econt:estimate:t1:b']]),
    };
    const svc = new PublicCacheService(redis as never);
    await svc.delByPrefix('econt:estimate:t1:');
    expect(redis.scan).toHaveBeenCalledTimes(1);
    expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', 'econt:estimate:t1:*', 'COUNT', 200);
    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith('econt:estimate:t1:a', 'econt:estimate:t1:b');
  });

  it('follows a non-zero cursor across multiple SCAN pages and deletes each page', async () => {
    const redis = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      scan: jest
        .fn()
        .mockResolvedValueOnce(['17', ['speedy:estimate:t1:a']])
        .mockResolvedValueOnce(['0', ['speedy:estimate:t1:b']]),
    };
    const svc = new PublicCacheService(redis as never);
    await svc.delByPrefix('speedy:estimate:t1:');
    expect(redis.scan).toHaveBeenCalledTimes(2);
    expect(redis.scan).toHaveBeenNthCalledWith(1, '0', 'MATCH', 'speedy:estimate:t1:*', 'COUNT', 200);
    expect(redis.scan).toHaveBeenNthCalledWith(2, '17', 'MATCH', 'speedy:estimate:t1:*', 'COUNT', 200);
    expect(redis.del).toHaveBeenCalledTimes(2);
    expect(redis.del).toHaveBeenNthCalledWith(1, 'speedy:estimate:t1:a');
    expect(redis.del).toHaveBeenNthCalledWith(2, 'speedy:estimate:t1:b');
  });

  it('terminates on cursor "0" and skips del when a page has no keys', async () => {
    const redis = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      scan: jest.fn().mockResolvedValue(['0', []]),
    };
    const svc = new PublicCacheService(redis as never);
    await svc.delByPrefix('econt:estimate:empty:');
    expect(redis.scan).toHaveBeenCalledTimes(1);
    expect(redis.del).not.toHaveBeenCalled();
  });
});

describe('PublicCacheService.resolveTenant — copy/faq projection', () => {
  it('derives cleaned copy + faq from settings', async () => {
    const row = {
      ...BASE_ROW,
      settings: {
        copy: { 'home.hero.title': ' Hi ', 'bad key!': 'x' },
        faq: [{ q: 'Q', a: 'A' }, { q: '', a: '' }],
      },
    };
    const svc = new PublicCacheService(makeRedis() as never);
    const meta = await svc.resolveTenant(makeDb([row]), 'ferma-test');

    // Pattern-valid keys kept; trimmed; keys with spaces/special chars dropped.
    expect(meta.copy).toEqual({ 'home.hero.title': 'Hi' });
    // Empty row dropped.
    expect(meta.faq).toEqual([{ q: 'Q', a: 'A' }]);
  });

  it('returns empty copy + faq when settings is null', async () => {
    const svc = new PublicCacheService(makeRedis() as never);
    const meta = await svc.resolveTenant(makeDb([{ ...BASE_ROW, settings: null }]), 'ferma-test');
    expect(meta.copy).toEqual({});
    expect(meta.faq).toEqual([]);
  });
});
