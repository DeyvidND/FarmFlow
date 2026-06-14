import { ConflictException } from '@nestjs/common';
import { AvailabilityService } from './availability.service';

// Minimal db stub: only the calls create() makes, in order.
// create() calls:
//   1. db.select().from(...).where(...) -> existing windows
//   2. db.insert().values().returning() -> inserted row
function makeDbReturning(existing: any[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(existing),
      }),
    }),
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
});
