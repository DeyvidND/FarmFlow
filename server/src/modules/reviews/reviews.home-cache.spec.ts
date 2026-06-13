import { ReviewsService } from './reviews.service';
import { publicCacheKeys } from '../../common/cache/public-cache.service';

/** Stub PublicCacheService — only the methods findHomeReviews/setStatus touch. */
function makeCache(over: Record<string, unknown> = {}) {
  return {
    resolveTenant: jest.fn(),
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
}

// A db that throws if any property is read — proves a path never reaches Postgres.
const explodingDb = new Proxy(
  {},
  {
    get() {
      throw new Error('Postgres must not be queried');
    },
  },
) as never;

describe('ReviewsService.findHomeReviews — caching', () => {
  it('returns [] without a cache or db read when the block is off', async () => {
    const cache = makeCache({
      resolveTenant: jest
        .fn()
        .mockResolvedValue({ id: 't1', landing: { reviews: { show: false, ids: [] } } }),
    });
    const svc = new ReviewsService(explodingDb, cache as never);
    expect(await svc.findHomeReviews('ferma')).toEqual([]);
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('serves the cached home block without querying Postgres', async () => {
    const cached = [
      { id: 'r1', authorName: 'A', authorLocation: null, rating: 5, body: 'hi', createdAt: null },
    ];
    const cache = makeCache({
      resolveTenant: jest
        .fn()
        .mockResolvedValue({ id: 't1', landing: { reviews: { show: true, ids: ['r1'] } } }),
      get: jest.fn().mockResolvedValue(cached),
    });
    const svc = new ReviewsService(explodingDb, cache as never);
    const out = await svc.findHomeReviews('ferma');
    expect(out).toBe(cached);
    expect(cache.get).toHaveBeenCalledWith(publicCacheKeys.homeReviews('t1'));
    expect(cache.set).not.toHaveBeenCalled();
  });
});

describe('ReviewsService.setStatus — invalidation', () => {
  it('busts both the reviews summary and the home-reviews cache', async () => {
    const row = { id: 'r1', tenantId: 't1', status: 'published' };
    const db = {
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [row] }) }) }),
    } as never;
    const cache = makeCache();
    const svc = new ReviewsService(db, cache as never);

    await svc.setStatus('r1', 't1', { status: 'published' } as never);

    expect(cache.del).toHaveBeenCalledWith(
      publicCacheKeys.reviews('t1'),
      publicCacheKeys.homeReviews('t1'),
    );
  });
});
