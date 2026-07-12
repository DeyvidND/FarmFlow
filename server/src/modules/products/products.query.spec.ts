import { BadRequestException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { encodeCursor } from '../../common/pagination/cursor';

/**
 * Read paths and the bulk-assign write that the other product specs don't touch:
 *   findAll          — keyset list, soft-delete filter, total only on the first page
 *   listOptions      — lean cross-page list
 *   assignProducts   — bulk farmer/subcategory link + the cross-tenant ref guard
 *   findPublicBySlug — Redis cache hit vs. cold-cache build
 *
 * Mock: a single chainable query-builder. `.limit()` resolves to the next queued
 * result set; awaiting the builder directly (a count/list query with no `.limit()`)
 * resolves to the next set too (the builder is thenable). Writes go through a
 * separate update/insert builder whose `.returning()` also pulls the next set, so
 * the caller controls the affected-row count.
 */
function makeDb(results: unknown[][]) {
  let i = 0;
  const next = () => results[i++] ?? [];
  const captured: { update?: Record<string, unknown>; insert?: Record<string, unknown> } = {};

  const qb: any = {};
  qb.select = jest.fn(() => qb);
  qb.from = jest.fn(() => qb);
  qb.where = jest.fn(() => qb);
  qb.orderBy = jest.fn(() => qb);
  qb.limit = jest.fn(async () => next());
  // `await db.select().from().where()` (count / batch loads, no `.limit()`).
  qb.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(next()).then(res, rej);

  const upd: any = {};
  upd.set = jest.fn((s: Record<string, unknown>) => {
    captured.update = s;
    return upd;
  });
  upd.where = jest.fn(() => upd);
  upd.returning = jest.fn(async () => next());

  qb.insert = jest.fn(() => qb);
  qb.values = jest.fn((v: Record<string, unknown>) => {
    captured.insert = v;
    return qb;
  });
  qb.returning = jest.fn(async () => next());
  qb.update = jest.fn(() => upd);

  return { db: qb, captured, updateMock: qb.update };
}

const catalogCache = () => ({ invalidate: jest.fn(), get: jest.fn(), set: jest.fn() });
const svcWith = (db: unknown, cache: unknown, publicCache: unknown = {}) =>
  new ProductsService(db as never, {} as never, cache as never, publicCache as never, {} as never, {} as never, {} as never);

describe('ProductsService.findAll', () => {
  it('returns the first page with a total and a nextCursor when full', async () => {
    // limit=2 → service fetches 3; the 3rd row signals "more" and is dropped.
    // __keysetTs is the micro-precision cursor column the query now projects.
    const rows = [
      { id: 'a', createdAt: new Date('2026-01-01'), __keysetTs: '2026-01-01T00:00:00.000000' },
      { id: 'b', createdAt: new Date('2026-01-02'), __keysetTs: '2026-01-02T00:00:00.000000' },
      { id: 'c', createdAt: new Date('2026-01-03'), __keysetTs: '2026-01-03T00:00:00.000000' },
    ];
    const { db } = makeDb([rows, [{ total: 9 }]]);
    const svc = svcWith(db, catalogCache());

    const page = await svc.findAll('t1', { limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.items.map((p) => p.id)).toEqual(['a', 'b']);
    expect(page.total).toBe(9);
    expect(page.nextCursor).toBeTruthy();
  });

  it('omits the total on a subsequent page (cursor present → no count query)', async () => {
    const cursor = encodeCursor({ createdAt: '2026-01-01T00:00:00.000000', id: 'a' });
    const { db } = makeDb([
      [{ id: 'b', createdAt: new Date('2026-01-02'), __keysetTs: '2026-01-02T00:00:00.000000' }],
    ]);
    const svc = svcWith(db, catalogCache());

    const page = await svc.findAll('t1', { limit: 2, cursor });

    expect(page.items.map((p) => p.id)).toEqual(['b']);
    expect(page.total).toBeUndefined();
    // Only the list query ran; no second (count) select.
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});

describe('ProductsService.listOptions', () => {
  it('returns the lean rows the query yields', async () => {
    const opts = [{ id: 'a', name: 'Мед', farmerId: 'f1' }];
    const { db } = makeDb([opts]);
    const svc = svcWith(db, catalogCache());

    await expect(svc.listOptions('t1')).resolves.toEqual(opts);
  });
});

describe('ProductsService.assignProducts', () => {
  it('no-ops (no DB write) when productIds is empty', async () => {
    const c = catalogCache();
    const { db } = makeDb([]);
    const svc = svcWith(db, c);

    await expect(svc.assignProducts('t1', { productIds: [] })).resolves.toEqual({ updated: 0 });
    expect(db.update).not.toHaveBeenCalled();
    expect(c.invalidate).not.toHaveBeenCalled();
  });

  it('rejects a farmer from another tenant (cross-tenant ref guard)', async () => {
    // assertRefsInTenant farmer lookup returns empty → invalid.
    const { db } = makeDb([[]]);
    const svc = svcWith(db, catalogCache());

    await expect(
      svc.assignProducts('t1', { productIds: ['p1'], farmerId: 'foreign' }),
    ).rejects.toThrow(BadRequestException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('links the products and busts the cache, returning the updated count', async () => {
    const c = catalogCache();
    // [0] farmer ref lookup (valid), [1] update().returning() → 2 rows.
    const { db, captured } = makeDb([[{ id: 'f1' }], [{ id: 'p1' }, { id: 'p2' }]]);
    const svc = svcWith(db, c);

    const res = await svc.assignProducts('t1', { productIds: ['p1', 'p2'], farmerId: 'f1' });

    expect(res).toEqual({ updated: 2 });
    expect(captured.update).toEqual({ farmerId: 'f1' });
    expect(c.invalidate).toHaveBeenCalledWith('t1');
  });
});

describe('ProductsService.findPublicBySlug', () => {
  it('returns the cached catalog without hitting Postgres', async () => {
    const cached = [{ id: 'p1' }];
    const c = catalogCache();
    c.get.mockResolvedValue(cached);
    const publicCache = { resolveTenant: jest.fn().mockResolvedValue({ id: 't1' }) };
    const { db } = makeDb([]);
    const svc = svcWith(db, c, publicCache);

    await expect(svc.findPublicBySlug('shop')).resolves.toBe(cached);
    expect(db.select).not.toHaveBeenCalled();
    expect(c.set).not.toHaveBeenCalled();
  });

  it('builds from Postgres on a cold cache and writes it back', async () => {
    const c = catalogCache();
    c.get.mockResolvedValue(null);
    const publicCache = { resolveTenant: jest.fn().mockResolvedValue({ id: 't1' }) };
    const product = {
      id: 'p1',
      slug: 'med',
      name: 'Мед',
      priceStotinki: 500,
      salePercent: null,
      saleEndsAt: null,
      salePriceStotinki: null,
      imageUrl: null,
      tenantId: 't1',
    };
    // [0] product rows, [1] media batch (none), [2] variant batch (none).
    const { db } = makeDb([[product], [], []]);
    const svc = svcWith(db, c, publicCache);

    const result = await svc.findPublicBySlug('shop');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'p1', slug: 'med', images: [] });
    expect(c.set).toHaveBeenCalledWith('t1', result, 300);
  });
});
