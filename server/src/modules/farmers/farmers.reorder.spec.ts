import { FarmersService } from './farmers.service';

/** Reorder now persists every position in ONE `UPDATE … SET position = CASE … END`. */
function makeDb() {
  const db: any = {};
  db.update = jest.fn(() => db);
  db.set = jest.fn(() => db);
  db.where = jest.fn(() => db);
  return db;
}

describe('FarmersService.reorder', () => {
  it('persists positions in one UPDATE and busts the catalog + public farmers caches', async () => {
    const db = makeDb();
    const cache = { invalidate: jest.fn() };
    const publicCache = { del: jest.fn() };
    const svc = new FarmersService(db, {} as never, cache as never, publicCache as never, {} as never, {} as never, {} as never);

    const out = await svc.reorder('t1', {
      items: [
        { id: 'a', position: 0 },
        { id: 'b', position: 1 },
      ],
    });

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.set).toHaveBeenCalledTimes(1);
    expect(cache.invalidate).toHaveBeenCalledWith('t1');
    expect(publicCache.del).toHaveBeenCalledWith('farmers:t1');
    expect(out).toEqual({ ok: true });
  });
});
