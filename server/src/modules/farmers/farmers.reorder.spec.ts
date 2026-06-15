import { FarmersService } from './farmers.service';

function makeDb() {
  const tx: any = {};
  tx.update = jest.fn(() => tx);
  tx.set = jest.fn(() => tx);
  tx.where = jest.fn(() => tx);
  const db: any = { transaction: jest.fn(async (cb: any) => cb(tx)) };
  return { db, tx };
}

describe('FarmersService.reorder', () => {
  it('persists positions and busts the catalog + public farmers caches', async () => {
    const { db, tx } = makeDb();
    const cache = { invalidate: jest.fn() };
    const publicCache = { del: jest.fn() };
    const svc = new FarmersService(db, {} as never, cache as never, publicCache as never, {} as never, {} as never);

    const out = await svc.reorder('t1', {
      items: [
        { id: 'a', position: 0 },
        { id: 'b', position: 1 },
      ],
    });

    expect(tx.update).toHaveBeenCalledTimes(2);
    expect(tx.set).toHaveBeenCalledWith({ position: 1 });
    expect(cache.invalidate).toHaveBeenCalledWith('t1');
    expect(publicCache.del).toHaveBeenCalledWith('farmers:t1');
    expect(out).toEqual({ ok: true });
  });
});
