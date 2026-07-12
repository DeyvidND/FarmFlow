import { NotFoundException } from '@nestjs/common';
import { ProductsService } from './products.service';

/**
 * Producer (role='farmer') scoping for the catalog. A producer sub-account may
 * only see and mutate products that belong to their own farm — the service is
 * the real boundary (the controller just derives the scope from the token).
 *
 * Mock: each `select…limit(1)` consumes the next queued `selects` row-set;
 * insert/update payloads are captured for assertion. `update().where()` is both
 * awaitable (remove path) and chainable to `.returning()` (update path).
 */
function makeDb(selects: unknown[][]) {
  let i = 0;
  const captured: { insert?: Record<string, unknown>; update?: Record<string, unknown> } = {};

  const sel: any = {};
  sel.select = jest.fn(() => sel);
  sel.from = jest.fn(() => sel);
  sel.where = jest.fn(() => sel);
  sel.orderBy = jest.fn(() => sel);
  sel.limit = jest.fn(async () => selects[i++] ?? []);

  const ins: any = {};
  ins.values = jest.fn((v: Record<string, unknown>) => {
    captured.insert = v;
    return ins;
  });
  ins.returning = jest.fn(async () => [{ id: 'new', ...captured.insert }]);

  const upd: any = {};
  upd.set = jest.fn((s: Record<string, unknown>) => {
    captured.update = s;
    return upd;
  });
  upd.where = jest.fn(() => upd);
  upd.returning = jest.fn(async () => [{ id: 'p1', ...captured.update }]);
  // `await db.update().set().where()` (remove path, no .returning()) resolves here.
  upd.then = (resolve: (v: unknown) => unknown) => resolve([{ id: 'p1' }]);

  const db: any = {
    select: sel.select,
    from: sel.from,
    where: sel.where,
    orderBy: sel.orderBy,
    limit: sel.limit,
    insert: jest.fn(() => ins),
    update: jest.fn(() => upd),
  };
  return { db, captured };
}

const cache = () => ({ invalidate: jest.fn() });
const svcWith = (db: unknown, c: unknown) =>
  new ProductsService(db as never, {} as never, c as never, {} as never, {} as never, {} as never, {} as never);

const FARMER = 'farmer-1';
const OTHER = 'farmer-2';

describe('ProductsService — producer scope', () => {
  it('findOne returns the product when it belongs to the producer', async () => {
    const { db } = makeDb([[{ id: 'p1', tenantId: 't1', farmerId: FARMER }]]);
    const svc = svcWith(db, cache());
    await expect(svc.findOne('p1', 't1', FARMER)).resolves.toMatchObject({ id: 'p1' });
  });

  it("findOne hides another producer's product as not-found (no IDOR / no existence leak)", async () => {
    const { db } = makeDb([[{ id: 'p1', tenantId: 't1', farmerId: OTHER }]]);
    const svc = svcWith(db, cache());
    await expect(svc.findOne('p1', 't1', FARMER)).rejects.toThrow(NotFoundException);
  });

  it('create forces the product onto the producer, ignoring a spoofed farmerId in the DTO', async () => {
    // selects: [0] assertRefsInTenant farmer lookup (valid), [1] uniqueSlug (free).
    const { db, captured } = makeDb([[{ id: FARMER }], []]);
    const svc = svcWith(db, cache());

    await svc.create('t1', { name: 'Мед', priceStotinki: 500, farmerId: OTHER } as never, FARMER);

    expect(captured.insert?.farmerId).toBe(FARMER);
    expect(captured.insert?.tenantId).toBe('t1');
  });

  it("update rejects editing another producer's product", async () => {
    const { db } = makeDb([[{ id: 'p1', tenantId: 't1', farmerId: OTHER }]]);
    const svc = svcWith(db, cache());
    await expect(
      svc.update('p1', 't1', { name: 'hack' } as never, FARMER),
    ).rejects.toThrow(NotFoundException);
  });

  it('update strips a farmerId reassignment so a producer cannot move ownership', async () => {
    const { db, captured } = makeDb([[{ id: 'p1', tenantId: 't1', farmerId: FARMER }]]);
    const svc = svcWith(db, cache());

    await svc.update('p1', 't1', { name: 'Мед 2', farmerId: OTHER } as never, FARMER);

    expect(captured.update?.name).toBe('Мед 2');
    expect(captured.update?.farmerId).toBeUndefined();
  });

  it("remove rejects deleting another producer's product", async () => {
    const { db } = makeDb([[{ id: 'p1', tenantId: 't1', farmerId: OTHER }]]);
    const svc = svcWith(db, cache());
    await expect(svc.remove('p1', 't1', FARMER)).rejects.toThrow(NotFoundException);
  });

  it('remove soft-deletes the producer’s own product', async () => {
    const c = cache();
    const { db, captured } = makeDb([[{ id: 'p1', tenantId: 't1', farmerId: FARMER }]]);
    const svc = svcWith(db, c);

    await expect(svc.remove('p1', 't1', FARMER)).resolves.toEqual({ id: 'p1' });
    expect(captured.update).toMatchObject({ isActive: false });
    expect(captured.update?.deletedAt).toBeInstanceOf(Date);
    expect(c.invalidate).toHaveBeenCalledWith('t1');
  });
});
