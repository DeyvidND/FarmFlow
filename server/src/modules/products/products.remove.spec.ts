import { ProductsService } from './products.service';

/** Chainable Drizzle mock: `select…limit` resolves to `selectRows`, and
 *  `update().set(set).where()` records the `set` payload for assertion. */
function makeDb(selectRows: unknown[]) {
  const calls: { set?: Record<string, unknown> } = {};
  const sel: any = {};
  sel.select = jest.fn(() => sel);
  sel.from = jest.fn(() => sel);
  sel.where = jest.fn(() => sel);
  sel.limit = jest.fn(async () => selectRows);

  const upd: any = {};
  upd.set = jest.fn((s: Record<string, unknown>) => {
    calls.set = s;
    return upd;
  });
  upd.where = jest.fn(async () => undefined);

  const db: any = {
    select: sel.select,
    from: sel.from,
    where: sel.where,
    limit: sel.limit,
    update: jest.fn(() => upd),
  };
  return { db, calls };
}

describe('ProductsService.remove', () => {
  it('soft-deletes by stamping deleted_at (and hiding via is_active) + busts cache', async () => {
    const { db, calls } = makeDb([{ id: 'p1', tenantId: 't1' }]);
    const cache = { invalidate: jest.fn() };
    const svc = new ProductsService(db, {} as never, cache as never, {} as never, {} as never, {} as never);

    const out = await svc.remove('p1', 't1');

    expect(out).toEqual({ id: 'p1' });
    expect(db.update).toHaveBeenCalledTimes(1);
    // The deleted row must be marked deleted (not merely toggled inactive, which
    // is the user-facing "hide" state and stays visible in the admin list).
    expect(calls.set).toMatchObject({ isActive: false });
    expect(calls.set?.deletedAt).toBeInstanceOf(Date);
    expect(cache.invalidate).toHaveBeenCalledWith('t1');
  });
});
