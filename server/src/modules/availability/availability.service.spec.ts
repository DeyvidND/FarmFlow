import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { productBundleItems } from '@fermeribg/db';
import { AvailabilityService } from './availability.service';

// ---------------------------------------------------------------------------
// DB stub helpers
// ---------------------------------------------------------------------------

// Minimal db stub for create(): models 3 successive select() calls:
//   1. product-ownership row (+ farmerId)
//   2. existing windows (overlap check)
//   3. (implicit) insert
// owned defaults to a product belonging to tenant + farmer 'f1'.
function makeDbReturning(existing: any[], owned: any[] = [{ id: 'p1', farmerId: 'f1' }]) {
  const selectResults = [owned, existing];
  return {
    select: () => {
      const result = selectResults.length > 1 ? selectResults.shift()! : selectResults[0];
      const chain: any = {
        from: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(result),
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
      };
      return chain;
    },
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([{ id: 'new' }]),
      }),
    }),
  } as any;
}

/** Db stub for update()/remove() that returns a pre-loaded window row then a
 *  product row (for the farmer ownership check) on successive select() calls,
 *  then the siblings list for the overlap check. */
function makeDbForUpdate(
  windowRow: any,
  productRow: any,
  siblings: any[] = [],
) {
  const selectResults = [
    windowRow ? [windowRow] : [],  // load current window
    productRow ? [productRow] : [], // load product for farmer check
    siblings,                       // siblings overlap check
  ];
  return {
    select: () => {
      const result = selectResults.length > 0 ? selectResults.shift()! : [];
      const chain: any = {
        from: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(result),
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
      };
      return chain;
    },
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([{ id: 'updated' }]),
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: () => Promise.resolve([{ id: 'win1' }]),
      }),
    }),
  } as any;
}

/** Db stub for remove() with farmerScope — needs: window lookup, product lookup, delete. */
function makeDbForRemove(windowRow: any, productRow: any) {
  const selectResults = [
    windowRow ? [windowRow] : [],
    productRow ? [productRow] : [],
  ];
  return {
    select: () => {
      const result = selectResults.length > 0 ? selectResults.shift()! : [];
      const chain: any = {
        from: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(result),
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
      };
      return chain;
    },
    delete: () => ({
      where: () => ({
        returning: () => Promise.resolve([{ id: 'win1' }]),
      }),
    }),
  } as any;
}

const cacheStub = { invalidate: async () => {} } as any;
const publicCacheStub = (meta: Partial<{ id: string }> = {}) => ({
  del: async () => {},
  resolveTenant: async () => ({ id: 't1', ...meta }),
  get: async () => null,
  set: async () => {},
}) as any;

// ---------------------------------------------------------------------------
// create() — overlap + IDOR + farmer-scope
// ---------------------------------------------------------------------------

describe('AvailabilityService.create one-per-product guard', () => {
  it('rejects a second stock entry when the product already has one', async () => {
    const db = makeDbReturning([
      { id: 'x', productId: 'p1', startsAt: '2000-01-01', endsAt: '9999-12-31' },
    ]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    await expect(
      svc.create('t1', { productId: 'p1', quantity: 5 }, null),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows setting stock when the product has none', async () => {
    const db = makeDbReturning([]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    const row = await svc.create('t1', { productId: 'p1', quantity: 5 }, null);
    expect(row).toEqual({ id: 'new' });
  });

  it('rejects setting stock for a product owned by another tenant (IDOR)', async () => {
    // Ownership select returns empty → product is not under this tenant.
    const db = makeDbReturning([], []);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    await expect(
      svc.create('t1', { productId: 'p1', quantity: 5 }, null),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('allows a producer to set stock on their own product', async () => {
    // owned row has farmerId matching the scope
    const db = makeDbReturning([], [{ id: 'p1', farmerId: 'farmerA' }]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    const row = await svc.create('t1', { productId: 'p1', quantity: 5 }, 'farmerA');
    expect(row).toEqual({ id: 'new' });
  });

  it('rejects a producer setting stock on another producers product (cross-farmer IDOR)', async () => {
    // owned row has farmerId 'farmerB', but scope is 'farmerA'
    const db = makeDbReturning([], [{ id: 'p1', farmerId: 'farmerB' }]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    await expect(
      svc.create('t1', { productId: 'p1', quantity: 5 }, 'farmerA'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ---------------------------------------------------------------------------
// createBulk() — «Задай за всички» (multi-product, skip-not-fatal)
// ---------------------------------------------------------------------------

/** Db stub for createBulk(): two awaited selects (owned products, existing
 *  windows) then an insert().values().returning(). `insert` throws when no row
 *  is eligible, to assert we never write in that case. */
function makeDbForBulk(owned: any[], existing: any[], created: any[], allowInsert = true) {
  const selectResults = [owned, existing];
  return {
    select: () => {
      const result = selectResults.length > 0 ? selectResults.shift()! : [];
      const chain: any = {
        from: () => chain,
        where: () => chain,
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
      };
      return chain;
    },
    insert: () => ({
      values: () => ({
        returning: () => {
          if (!allowInsert) throw new Error('insert must not run when nothing is eligible');
          return Promise.resolve(created);
        },
      }),
    }),
  } as any;
}

describe('AvailabilityService.createBulk', () => {
  it('sets stock on every eligible product', async () => {
    const db = makeDbForBulk([{ id: 'p1' }, { id: 'p2' }], [], [{ id: 'w1' }, { id: 'w2' }]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    const res = await svc.createBulk(
      't1',
      { items: [{ productId: 'p1', quantity: 5 }, { productId: 'p2', quantity: 8 }] },
      null,
    );
    expect(res.created).toHaveLength(2);
    expect(res.skipped).toEqual([]);
  });

  it('skips (not fatal) a product that already has stock', async () => {
    const db = makeDbForBulk(
      [{ id: 'p1' }, { id: 'p2' }],
      [{ id: 'x', productId: 'p1', startsAt: '2000-01-01', endsAt: '9999-12-31' }],
      [{ id: 'w2' }],
    );
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    const res = await svc.createBulk(
      't1',
      { items: [{ productId: 'p1', quantity: 5 }, { productId: 'p2', quantity: 5 }] },
      null,
    );
    expect(res.created).toHaveLength(1);
    expect(res.skipped).toEqual([{ productId: 'p1', reason: 'overlap' }]);
  });

  it('skips a product not owned by the producer (cross-farmer / cross-tenant)', async () => {
    // Scoped ownership query returns only p1 → p2 is foreign.
    const db = makeDbForBulk([{ id: 'p1' }], [], [{ id: 'w1' }]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    const res = await svc.createBulk(
      't1',
      { items: [{ productId: 'p1', quantity: 5 }, { productId: 'p2', quantity: 5 }] },
      'farmerA',
    );
    expect(res.created).toHaveLength(1);
    expect(res.skipped).toEqual([{ productId: 'p2', reason: 'not-found' }]);
  });

  it('writes nothing when no product is eligible', async () => {
    const db = makeDbForBulk([], [], [], /* allowInsert */ false);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    const res = await svc.createBulk(
      't1',
      { items: [{ productId: 'p1', quantity: 5 }] },
      'farmerA',
    );
    expect(res.created).toEqual([]);
    expect(res.skipped).toEqual([{ productId: 'p1', reason: 'not-found' }]);
  });
});

// ---------------------------------------------------------------------------
// update() — farmer-scope enforcement
// ---------------------------------------------------------------------------

describe('AvailabilityService.update farmer-scope guard', () => {
  const baseWindow = {
    id: 'win1',
    productId: 'p1',
    tenantId: 't1',
    startsAt: '2026-06-01',
    endsAt: '2026-06-30',
    quantity: 10,
    remaining: 10,
  };

  it('allows owner (farmerScope=null) to update any window', async () => {
    // owner path: no product lookup for farmer check; siblings = []
    const db = makeDbForUpdate(baseWindow, null, []);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    const row = await svc.update('win1', 't1', { quantity: 8 }, null);
    expect(row).toEqual({ id: 'updated' });
  });

  it('allows a producer to update a window on their own product', async () => {
    const db = makeDbForUpdate(baseWindow, { farmerId: 'farmerA' }, []);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    const row = await svc.update('win1', 't1', { quantity: 8 }, 'farmerA');
    expect(row).toEqual({ id: 'updated' });
  });

  it('rejects a producer updating a window belonging to another producer', async () => {
    const db = makeDbForUpdate(baseWindow, { farmerId: 'farmerB' }, []);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    await expect(
      svc.update('win1', 't1', { quantity: 8 }, 'farmerA'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws NotFoundException when window does not exist', async () => {
    const db = makeDbForUpdate(null, null, []);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    await expect(
      svc.update('missing', 't1', { quantity: 8 }, null),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// remove() — farmer-scope enforcement
// ---------------------------------------------------------------------------

describe('AvailabilityService.remove farmer-scope guard', () => {
  const baseWindow = { id: 'win1', productId: 'p1' };

  it('allows owner (farmerScope=null) to delete any window', async () => {
    // owner path skips the pre-check; just the delete
    const db = {
      select: () => { throw new Error('should not be called for owner'); },
      delete: () => ({
        where: () => ({
          returning: () => Promise.resolve([{ id: 'win1' }]),
        }),
      }),
    } as any;
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    const result = await svc.remove('win1', 't1', null);
    expect(result).toEqual({ id: 'win1' });
  });

  it('allows a producer to delete a window on their own product', async () => {
    const db = makeDbForRemove(baseWindow, { farmerId: 'farmerA' });
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    const result = await svc.remove('win1', 't1', 'farmerA');
    expect(result).toEqual({ id: 'win1' });
  });

  it('rejects a producer deleting a window belonging to another producer', async () => {
    const db = makeDbForRemove(baseWindow, { farmerId: 'farmerB' });
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    await expect(
      svc.remove('win1', 't1', 'farmerA'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws NotFoundException when window does not exist (producer path)', async () => {
    const db = makeDbForRemove(null, null);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    await expect(
      svc.remove('missing', 't1', 'farmerA'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// setProductStock() — drives the product dialog's „Наличност" field
// ---------------------------------------------------------------------------

/** Db stub for setProductStock(): one awaited select (existing windows for the
 *  product), then captures whatever write fires (insert / update / delete). None
 *  of the writes use .returning() — they're fire-and-await. */
function makeDbForStock(existing: any[]) {
  const captured: { inserted?: any; updated?: any; deleted?: boolean } = {};
  const db: any = {
    select: () => {
      const chain: any = {
        from: () => chain,
        where: () => chain,
        then: (resolve: any, reject: any) => Promise.resolve(existing).then(resolve, reject),
      };
      return chain;
    },
    insert: () => ({
      values: (v: any) => {
        captured.inserted = v;
        return Promise.resolve(undefined);
      },
    }),
    update: () => ({
      set: (s: any) => {
        captured.updated = s;
        return { where: () => Promise.resolve(undefined) };
      },
    }),
    delete: () => ({
      where: () => {
        captured.deleted = true;
        return Promise.resolve(undefined);
      },
    }),
  };
  return { db, captured };
}

const OPEN = { startsAt: '2000-01-01', endsAt: '9999-12-31' };

describe('AvailabilityService.setProductStock', () => {
  it('inserts an open-ended window when the product has no stock yet', async () => {
    const { db, captured } = makeDbForStock([]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    await svc.setProductStock('t1', 'p1', 5);
    expect(captured.inserted).toMatchObject({
      tenantId: 't1',
      productId: 'p1',
      startsAt: '2000-01-01',
      endsAt: '9999-12-31',
      quantity: 5,
      remaining: 5,
    });
  });

  it('updates quantity and preserves already-sold on an existing window', async () => {
    // 10 set, 7 remaining → 3 already sold. New quantity 5 → remaining max(0,5-3)=2.
    const { db, captured } = makeDbForStock([
      { id: 'w1', productId: 'p1', quantity: 10, remaining: 7, ...OPEN },
    ]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    await svc.setProductStock('t1', 'p1', 5);
    expect(captured.updated).toEqual({ quantity: 5, remaining: 2 });
    expect(captured.inserted).toBeUndefined();
  });

  it('floors remaining at 0 when new quantity is below what is already sold', async () => {
    const { db, captured } = makeDbForStock([
      { id: 'w1', productId: 'p1', quantity: 10, remaining: 7, ...OPEN },
    ]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    await svc.setProductStock('t1', 'p1', 0);
    expect(captured.updated).toEqual({ quantity: 0, remaining: 0 });
  });

  it('deletes the window when quantity is null (back to unlimited)', async () => {
    const { db, captured } = makeDbForStock([
      { id: 'w1', productId: 'p1', quantity: 10, remaining: 10, ...OPEN },
    ]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    await svc.setProductStock('t1', 'p1', null);
    expect(captured.deleted).toBe(true);
    expect(captured.inserted).toBeUndefined();
    expect(captured.updated).toBeUndefined();
  });

  it('is a no-op when clearing stock on a product that has none', async () => {
    const { db, captured } = makeDbForStock([]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    await svc.setProductStock('t1', 'p1', null);
    expect(captured.deleted).toBeUndefined();
    expect(captured.inserted).toBeUndefined();
    expect(captured.updated).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findPublicActiveBySlug() — always on (no section toggle)
// ---------------------------------------------------------------------------

describe('AvailabilityService.findPublicActiveBySlug', () => {
  it('always queries active windows — availability is on for every farm', async () => {
    const fakeRow = {
      productId: 'p1',
      startsAt: '2026-06-01',
      endsAt: '2026-06-30',
      quantity: 10,
      remaining: 7,
    };
    // Second select is the basket lookup (products.category='bundle'); empty means
    // this tenant has no baskets, so the service returns the ordinary rows as-is
    // via its early-return path.
    const selectResults = [[fakeRow], []];
    const db = {
      select: () => {
        const result = selectResults.shift()!;
        const chain: any = {
          from: () => chain,
          where: () => Promise.resolve(result),
        };
        return chain;
      },
    } as any;
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    const result = await svc.findPublicActiveBySlug('some-slug');
    expect(result).toHaveLength(1);
    expect(result[0].productId).toBe('p1');
  });
});

// ---------------------------------------------------------------------------
// findPublicActiveBySlug() — basket („кошница") availability (Task 5)
// ---------------------------------------------------------------------------

/** Chainable thenable jest.fn proxy, mirroring products.bundle.spec.ts's
 *  `makeChain`: every builder method returns the same proxy, and awaiting it
 *  shifts the next canned result off `queue`. Built with jest.fn() (not the
 *  plain-chain style above) specifically so these tests can assert on the real
 *  `where()` arguments — proof the tenant filter on the bundle-links query is
 *  actually applied, not merely that "some select happened" (a queue-only mock
 *  would pass even if that filter were silently dropped). */
function makeQueueChain(queue: unknown[]) {
  const proxy: any = {
    then: (resolve: (v: unknown) => void) => resolve(queue.shift()),
  };
  for (const m of ['select', 'from', 'where']) {
    proxy[m] = jest.fn(() => proxy);
  }
  return proxy;
}

describe('AvailabilityService.findPublicActiveBySlug — basket availability', () => {
  it('derives the synthetic basket window from the weakest member and drops its own rows', async () => {
    const rows = [
      { productId: 'p1', startsAt: '2000-01-01', endsAt: '9999-12-31', quantity: 10, remaining: 10 },
      { productId: 'p2', startsAt: '2000-01-01', endsAt: '9999-12-31', quantity: 5, remaining: 3 },
      // A stale real window on the basket product itself — must be dropped, not
      // added alongside the synthetic one (the storefront pools by summing, so
      // both surviving would double the advertised stock).
      { productId: 'basket1', startsAt: '2000-01-01', endsAt: '9999-12-31', quantity: 99, remaining: 99 },
    ];
    const baskets = [{ id: 'basket1' }];
    const links = [
      { bundleId: 'basket1', productId: 'p1', quantity: 1 },
      { bundleId: 'basket1', productId: 'p2', quantity: 1 },
    ];
    const liveMembers = [{ id: 'p1' }, { id: 'p2' }];
    const db = makeQueueChain([rows, baskets, links, liveMembers]);
    const svc = new AvailabilityService(db as any, cacheStub, publicCacheStub());

    const result = await svc.findPublicActiveBySlug('some-slug');

    expect(result.filter((w) => w.productId === 'basket1')).toHaveLength(1);
    const basketWindow = result.find((w) => w.productId === 'basket1')!;
    // p1 caps at 10, p2 caps at 3 — the basket can only be as full as its weakest member.
    expect(basketWindow.remaining).toBe(3);
    expect(basketWindow.quantity).toBe(3);
    expect(result.filter((w) => w.productId === 'p1' || w.productId === 'p2')).toHaveLength(2);

    // Third select() call is the bundle-links query — assert its where() actually
    // carries the tenant filter (matches the sibling basket-expansion query in
    // orders.service.ts). This is the one place the brief's sample code omitted it.
    expect((db.where as jest.Mock).mock.calls[2][0]).toEqual(
      and(inArray(productBundleItems.bundleId, ['basket1']), eq(productBundleItems.tenantId, 't1')),
    );
  });

  it('is sold out when a member has gone inactive (not live)', async () => {
    const rows = [
      { productId: 'p1', startsAt: '2000-01-01', endsAt: '9999-12-31', quantity: 10, remaining: 10 },
    ];
    const baskets = [{ id: 'basket1' }];
    const links = [{ bundleId: 'basket1', productId: 'p1', quantity: 1 }];
    const liveMembers: { id: string }[] = []; // p1 no longer live
    const db = makeQueueChain([rows, baskets, links, liveMembers]);
    const svc = new AvailabilityService(db as any, cacheStub, publicCacheStub());

    const result = await svc.findPublicActiveBySlug('some-slug');
    const basketWindow = result.find((w) => w.productId === 'basket1')!;
    expect(basketWindow.remaining).toBe(0);
  });

  it('publishes nothing when no member carries a stock window (unlimited basket)', async () => {
    const rows: unknown[] = [];
    const baskets = [{ id: 'basket1' }];
    const links = [{ bundleId: 'basket1', productId: 'p1', quantity: 1 }];
    const liveMembers = [{ id: 'p1' }];
    const db = makeQueueChain([rows, baskets, links, liveMembers]);
    const svc = new AvailabilityService(db as any, cacheStub, publicCacheStub());

    const result = await svc.findPublicActiveBySlug('some-slug');
    expect(result.find((w) => w.productId === 'basket1')).toBeUndefined();
  });
});
