import { ProductsService } from './products.service';

/** Minimal Drizzle mock: `update().set().where()` is chainable and records calls.
 *  Reorder now persists every position in ONE `UPDATE … SET position = CASE … END`. */
function makeDb() {
  const db: any = {};
  db.update = jest.fn(() => db);
  db.set = jest.fn(() => db);
  db.where = jest.fn(() => db);
  return db;
}

describe('ProductsService.reorder', () => {
  it('persists all positions in one UPDATE and busts the catalog cache', async () => {
    const db = makeDb();
    const cache = { invalidate: jest.fn() };
    const svc = new ProductsService(db, {} as never, cache as never, {} as never, {} as never, {} as never, {} as never);

    const out = await svc.reorder('t1', {
      items: [
        { id: 'a', position: 0 },
        { id: 'b', position: 1 },
      ],
    });

    // One statement for the whole batch (was one UPDATE per row in a transaction).
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.set).toHaveBeenCalledTimes(1);
    expect(cache.invalidate).toHaveBeenCalledWith('t1');
    expect(out).toEqual({ ok: true });
  });

  it('skips the UPDATE when there are no items but still busts the cache', async () => {
    const db = makeDb();
    const cache = { invalidate: jest.fn() };
    const svc = new ProductsService(db, {} as never, cache as never, {} as never, {} as never, {} as never, {} as never);

    const out = await svc.reorder('t1', { items: [] });

    expect(db.update).not.toHaveBeenCalled();
    expect(cache.invalidate).toHaveBeenCalledWith('t1');
    expect(out).toEqual({ ok: true });
  });
});
