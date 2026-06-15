import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
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
const publicCacheStub = (meta: Partial<{ id: string; availabilitySectionEnabled: boolean }> = {}) => ({
  del: async () => {},
  resolveTenant: async () => ({ id: 't1', availabilitySectionEnabled: true, ...meta }),
  get: async () => null,
  set: async () => {},
}) as any;

// ---------------------------------------------------------------------------
// create() — overlap + IDOR + farmer-scope
// ---------------------------------------------------------------------------

describe('AvailabilityService.create overlap guard', () => {
  it('rejects a window overlapping an existing one for the same product', async () => {
    const db = makeDbReturning([
      { id: 'x', productId: 'p1', startsAt: '2026-06-10', endsAt: '2026-06-20' },
    ]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    await expect(
      svc.create('t1', { productId: 'p1', startsAt: '2026-06-15', endsAt: '2026-06-25', quantity: 5 }, null),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows a non-overlapping window', async () => {
    const db = makeDbReturning([
      { id: 'x', productId: 'p1', startsAt: '2026-06-10', endsAt: '2026-06-20' },
    ]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    const row = await svc.create('t1', { productId: 'p1', startsAt: '2026-06-21', endsAt: '2026-06-25', quantity: 5 }, null);
    expect(row).toEqual({ id: 'new' });
  });

  it('rejects creating a window for a product owned by another tenant (IDOR)', async () => {
    // Ownership select returns empty → product is not under this tenant.
    const db = makeDbReturning([], []);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    await expect(
      svc.create('t1', { productId: 'p1', startsAt: '2026-06-15', endsAt: '2026-06-25', quantity: 5 }, null),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('allows a producer to create a window on their own product', async () => {
    // owned row has farmerId matching the scope
    const db = makeDbReturning([], [{ id: 'p1', farmerId: 'farmerA' }]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    const row = await svc.create(
      't1',
      { productId: 'p1', startsAt: '2026-06-21', endsAt: '2026-06-25', quantity: 5 },
      'farmerA',
    );
    expect(row).toEqual({ id: 'new' });
  });

  it('rejects a producer creating a window on another producers product (cross-farmer IDOR)', async () => {
    // owned row has farmerId 'farmerB', but scope is 'farmerA'
    const db = makeDbReturning([], [{ id: 'p1', farmerId: 'farmerB' }]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    await expect(
      svc.create(
        't1',
        { productId: 'p1', startsAt: '2026-06-21', endsAt: '2026-06-25', quantity: 5 },
        'farmerA',
      ),
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
  const dates = { startsAt: '2026-07-01', endsAt: '2026-07-10', quantity: 5 };

  it('creates a window on every eligible product', async () => {
    const db = makeDbForBulk([{ id: 'p1' }, { id: 'p2' }], [], [{ id: 'w1' }, { id: 'w2' }]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    const res = await svc.createBulk('t1', { productIds: ['p1', 'p2'], ...dates }, null);
    expect(res.created).toHaveLength(2);
    expect(res.skipped).toEqual([]);
  });

  it('skips (not fatal) a product that already has an overlapping window', async () => {
    const db = makeDbForBulk(
      [{ id: 'p1' }, { id: 'p2' }],
      [{ id: 'x', productId: 'p1', startsAt: '2026-07-05', endsAt: '2026-07-15' }],
      [{ id: 'w2' }],
    );
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    const res = await svc.createBulk('t1', { productIds: ['p1', 'p2'], ...dates }, null);
    expect(res.created).toHaveLength(1);
    expect(res.skipped).toEqual([{ productId: 'p1', reason: 'overlap' }]);
  });

  it('skips a product not owned by the producer (cross-farmer / cross-tenant)', async () => {
    // Scoped ownership query returns only p1 → p2 is foreign.
    const db = makeDbForBulk([{ id: 'p1' }], [], [{ id: 'w1' }]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    const res = await svc.createBulk('t1', { productIds: ['p1', 'p2'], ...dates }, 'farmerA');
    expect(res.created).toHaveLength(1);
    expect(res.skipped).toEqual([{ productId: 'p2', reason: 'not-found' }]);
  });

  it('writes nothing when no product is eligible', async () => {
    const db = makeDbForBulk([], [], [], /* allowInsert */ false);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    const res = await svc.createBulk('t1', { productIds: ['p1'], ...dates }, 'farmerA');
    expect(res.created).toEqual([]);
    expect(res.skipped).toEqual([{ productId: 'p1', reason: 'not-found' }]);
  });

  it('rejects an inverted date range before touching the DB', async () => {
    const db = makeDbForBulk([], [], [], false);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub());
    await expect(
      svc.createBulk('t1', { productIds: ['p1'], startsAt: '2026-07-10', endsAt: '2026-07-01', quantity: 5 }, null),
    ).rejects.toBeInstanceOf(BadRequestException);
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
// findPublicActiveBySlug() — toggle gate
// ---------------------------------------------------------------------------

describe('AvailabilityService.findPublicActiveBySlug toggle gate', () => {
  it('returns [] immediately when availabilitySectionEnabled is false', async () => {
    const db = {
      select: () => { throw new Error('should not query DB when toggle is off'); },
    } as any;
    const svc = new AvailabilityService(
      db,
      cacheStub,
      publicCacheStub({ availabilitySectionEnabled: false }),
    );
    const result = await svc.findPublicActiveBySlug('some-slug');
    expect(result).toEqual([]);
  });

  it('queries the DB and returns rows when availabilitySectionEnabled is true', async () => {
    const fakeRow = {
      productId: 'p1',
      startsAt: '2026-06-01',
      endsAt: '2026-06-30',
      quantity: 10,
      remaining: 7,
    };
    const db = {
      select: () => {
        const chain: any = {
          from: () => chain,
          where: () => Promise.resolve([fakeRow]),
        };
        return chain;
      },
    } as any;
    const svc = new AvailabilityService(
      db,
      cacheStub,
      publicCacheStub({ availabilitySectionEnabled: true }),
    );
    const result = await svc.findPublicActiveBySlug('some-slug');
    expect(result).toHaveLength(1);
    expect(result[0].productId).toBe('p1');
  });
});
