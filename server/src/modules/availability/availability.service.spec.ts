import { ConflictException, NotFoundException } from '@nestjs/common';
import { AvailabilityService } from './availability.service';

// Minimal db stub: models the calls create() makes, in order.
// create() now calls:
//   1. db.select().from(...).where(...).limit(1) -> product-ownership row
//   2. db.select().from(...).where(...)          -> existing windows (overlap)
//   3. db.insert().values().returning()          -> inserted row
// The stub answers successive `select()` calls from a queue so it faithfully
// models the new product-then-windows call order. `owned` defaults to a single
// row (product belongs to the tenant); pass `[]` for the cross-tenant case.
function makeDbReturning(existing: any[], owned: any[] = [{ id: 'p1' }]) {
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

const cacheStub = { invalidate: async () => {} } as any;
const publicCacheStub = {
  del: async () => {},
  resolveTenant: async () => ({ id: 't1' }),
  get: async () => null,
  set: async () => {},
} as any;

describe('AvailabilityService.create overlap guard', () => {
  it('rejects a window overlapping an existing one for the same product', async () => {
    const db = makeDbReturning([
      { id: 'x', productId: 'p1', startsAt: '2026-06-10', endsAt: '2026-06-20' },
    ]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub);
    await expect(
      svc.create('t1', { productId: 'p1', startsAt: '2026-06-15', endsAt: '2026-06-25', quantity: 5 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows a non-overlapping window', async () => {
    const db = makeDbReturning([
      { id: 'x', productId: 'p1', startsAt: '2026-06-10', endsAt: '2026-06-20' },
    ]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub);
    const row = await svc.create('t1', { productId: 'p1', startsAt: '2026-06-21', endsAt: '2026-06-25', quantity: 5 });
    expect(row).toEqual({ id: 'new' });
  });

  it('rejects creating a window for a product owned by another tenant (IDOR)', async () => {
    // Ownership select returns empty → product is not under this tenant.
    const db = makeDbReturning([], []);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub);
    await expect(
      svc.create('t1', { productId: 'p1', startsAt: '2026-06-15', endsAt: '2026-06-25', quantity: 5 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
