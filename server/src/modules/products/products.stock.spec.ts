import { ProductsService } from './products.service';

/** Db stub for create(): uniqueSlug select (free → []), then
 *  insert().values(v).returning(). Captures the inserted values so we can assert
 *  the virtual `stock` field is stripped before the products row is written. */
function makeDbForCreate() {
  const captured: { inserted?: Record<string, unknown> } = {};
  const sel: any = {
    from: () => sel,
    where: () => sel,
    limit: async () => [], // slug is free
  };
  const db: any = {
    select: () => sel,
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        captured.inserted = v;
        return { returning: async () => [{ id: 'new', tenantId: 't1', ...v }] };
      },
    }),
  };
  return { db, captured };
}

/** Db stub for update(): update().set(s).where().returning() → the updated row.
 *  Captures the set payload to assert `stock` is stripped from the products write. */
function makeDbForUpdate() {
  const captured: { set?: Record<string, unknown> } = {};
  const db: any = {
    update: () => ({
      set: (s: Record<string, unknown>) => {
        captured.set = s;
        return { where: () => ({ returning: async () => [{ id: 'p1', tenantId: 't1' }] }) };
      },
    }),
  };
  return { db, captured };
}

const cache = () => ({ invalidate: jest.fn() });
const availability = () => ({ setProductStock: jest.fn(async () => undefined) });

function svcWith(db: any, cacheStub: any, avail: any) {
  // ctor: (db, storage, cache, publicCache, imageQueue, availability, sanityVision)
  return new ProductsService(db, {} as never, cacheStub as never, {} as never, {} as never, avail as never, {} as never);
}

describe('ProductsService.create — stock → availability window', () => {
  it('upserts the window when stock is a number, using the new product id', async () => {
    const { db, captured } = makeDbForCreate();
    const cacheStub = cache();
    const avail = availability();
    const svc = svcWith(db, cacheStub, avail);

    await svc.create('t1', { name: 'Ягоди', priceStotinki: 650, unit: 'кг', stock: 20 } as never);

    expect(avail.setProductStock).toHaveBeenCalledWith('t1', 'new', 20);
    // The virtual field must NOT reach the products row.
    expect(captured.inserted).not.toHaveProperty('stock');
  });

  it('does not touch availability when stock is null on create', async () => {
    const { db } = makeDbForCreate();
    const avail = availability();
    const svc = svcWith(db, cache(), avail);

    await svc.create('t1', { name: 'Ягоди', priceStotinki: 650, unit: 'кг', stock: null } as never);

    expect(avail.setProductStock).not.toHaveBeenCalled();
  });

  it('does not touch availability when stock is absent on create', async () => {
    const { db } = makeDbForCreate();
    const avail = availability();
    const svc = svcWith(db, cache(), avail);

    await svc.create('t1', { name: 'Ягоди', priceStotinki: 650, unit: 'кг' } as never);

    expect(avail.setProductStock).not.toHaveBeenCalled();
  });
});

describe('ProductsService.update — stock → availability window', () => {
  it('sets the window when stock is a number', async () => {
    const { db, captured } = makeDbForUpdate();
    const avail = availability();
    const svc = svcWith(db, cache(), avail);

    await svc.update('p1', 't1', { name: 'Ягоди', stock: 7 } as never);

    expect(avail.setProductStock).toHaveBeenCalledWith('t1', 'p1', 7);
    expect(captured.set).not.toHaveProperty('stock');
  });

  it('clears the window when stock is explicitly null', async () => {
    const { db } = makeDbForUpdate();
    const avail = availability();
    const svc = svcWith(db, cache(), avail);

    await svc.update('p1', 't1', { name: 'Ягоди', stock: null } as never);

    expect(avail.setProductStock).toHaveBeenCalledWith('t1', 'p1', null);
  });

  it('leaves stock untouched when stock is absent (e.g. a hide/show toggle)', async () => {
    const { db } = makeDbForUpdate();
    const avail = availability();
    const svc = svcWith(db, cache(), avail);

    await svc.update('p1', 't1', { isActive: false } as never);

    expect(avail.setProductStock).not.toHaveBeenCalled();
  });
});
