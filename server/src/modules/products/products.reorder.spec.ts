import { ProductsService } from './products.service';

/** Minimal transaction-aware Drizzle mock: `transaction(cb)` runs `cb(tx)` where
 *  `tx.update().set().where()` is chainable and records calls. */
function makeDb() {
  const tx: any = {};
  tx.update = jest.fn(() => tx);
  tx.set = jest.fn(() => tx);
  tx.where = jest.fn(() => tx);
  const db: any = { transaction: jest.fn(async (cb: any) => cb(tx)) };
  return { db, tx };
}

describe('ProductsService.reorder', () => {
  it('persists each position in one transaction and busts the catalog cache', async () => {
    const { db, tx } = makeDb();
    const cache = { invalidate: jest.fn() };
    const svc = new ProductsService(db, {} as never, cache as never, {} as never, {} as never, {} as never);

    const out = await svc.reorder('t1', {
      items: [
        { id: 'a', position: 0 },
        { id: 'b', position: 1 },
      ],
    });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledTimes(2);
    expect(tx.set).toHaveBeenCalledWith({ position: 0 });
    expect(tx.set).toHaveBeenCalledWith({ position: 1 });
    expect(cache.invalidate).toHaveBeenCalledWith('t1');
    expect(out).toEqual({ ok: true });
  });
});
