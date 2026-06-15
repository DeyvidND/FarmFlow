import { SubcategoriesService } from './subcategories.service';

function makeDb() {
  const tx: any = {};
  tx.update = jest.fn(() => tx);
  tx.set = jest.fn(() => tx);
  tx.where = jest.fn(() => tx);
  const db: any = { transaction: jest.fn(async (cb: any) => cb(tx)) };
  return { db, tx };
}

describe('SubcategoriesService.reorder', () => {
  it('persists positions and busts the catalog + public subcategories caches', async () => {
    const { db, tx } = makeDb();
    const cache = { invalidate: jest.fn() };
    const publicCache = { del: jest.fn() };
    const svc = new SubcategoriesService(db, {} as never, cache as never, publicCache as never, {} as never);

    const out = await svc.reorder('t1', {
      items: [
        { id: 'a', position: 0 },
        { id: 'b', position: 1 },
      ],
    });

    expect(tx.update).toHaveBeenCalledTimes(2);
    expect(cache.invalidate).toHaveBeenCalledWith('t1');
    expect(publicCache.del).toHaveBeenCalledWith('subcats:t1');
    expect(out).toEqual({ ok: true });
  });
});
