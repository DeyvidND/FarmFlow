import { BadRequestException } from '@nestjs/common';
import { ProductsService } from './products.service';

/**
 * ProductsService.update — a PARTIAL update that sets a fixed sale price without
 * resending priceStotinki must still be validated against the product's existing
 * regular price. Previously the guard was skipped (priceStotinki undefined), so a
 * sale price ABOVE the regular price was accepted and charged.
 */
function makeDb(existing: { priceStotinki: number }) {
  const calls: { set?: Record<string, unknown> } = {};
  const sel: any = {};
  sel.select = jest.fn(() => sel);
  sel.from = jest.fn(() => sel);
  sel.where = jest.fn(() => sel);
  sel.limit = jest.fn(async () => [existing]);

  const upd: any = {};
  upd.set = jest.fn((s: Record<string, unknown>) => {
    calls.set = s;
    return upd;
  });
  upd.where = jest.fn(() => upd);
  upd.returning = jest.fn(async () => [{ id: 'p1', tenantId: 't1', salePriceStotinki: 400 }]);

  const db: any = {
    select: sel.select,
    from: sel.from,
    where: sel.where,
    limit: sel.limit,
    update: jest.fn(() => upd),
  };
  return { db, calls };
}

function makeSvc(existing: { priceStotinki: number }) {
  const { db, calls } = makeDb(existing);
  const cache = { invalidate: jest.fn() };
  const availability = { setProductStock: jest.fn() };
  const svc = new ProductsService(
    db,
    {} as never,
    cache as never,
    {} as never,
    {} as never,
    availability as never,
    {} as never,
  );
  return { svc, calls };
}

describe('ProductsService.update — partial fixed-sale-price validation', () => {
  it('rejects a sale price ABOVE the existing regular price (the leak)', async () => {
    const { svc } = makeSvc({ priceStotinki: 500 });
    // Existing regular price 500 (5.00 лв); PATCH sets sale 700 (7.00) and omits price.
    await expect(svc.update('p1', 't1', { salePriceStotinki: 700 } as never)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('accepts a sale price BELOW the existing regular price (valid sale-only edit)', async () => {
    const { svc, calls } = makeSvc({ priceStotinki: 500 });
    // Loads the existing price (500) so the 400 sale validates — proves the caller
    // supplies the regular price rather than skipping the guard.
    const row = await svc.update('p1', 't1', { salePriceStotinki: 400 } as never);
    expect(row).toMatchObject({ id: 'p1' });
    expect(calls.set).toMatchObject({ salePriceStotinki: 400 });
  });
});
