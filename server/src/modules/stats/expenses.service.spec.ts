import { NotFoundException } from '@nestjs/common';
import { SQL, Param } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ExpensesService } from './expenses.service';

/** Изважда всяка вградена Param стойност от drizzle SQL дърво — така тестът
 *  вижда дали WHERE наистина е стеснил по tenant, вместо да вярва на мока. */
function paramValues(node: unknown, out: unknown[] = []): unknown[] {
  if (node instanceof Param) out.push(node.value);
  else if (node instanceof SQL)
    for (const c of (node as unknown as { queryChunks: unknown[] }).queryChunks) paramValues(c, out);
  else if (Array.isArray(node)) for (const c of node) paramValues(c, out);
  return out;
}

function makeDb(returning: unknown[] = [{ id: 'exp-1' }]) {
  const captured: { where?: unknown; values?: unknown; set?: unknown } = {};
  const chain: any = {};
  for (const m of ['from', 'orderBy', 'limit']) chain[m] = jest.fn(() => chain);
  chain.where = jest.fn((w: unknown) => {
    captured.where = w;
    return chain;
  });
  chain.returning = jest.fn(async () => returning);
  chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(returning).then(res, rej);

  const db = {
    select: jest.fn(() => chain),
    insert: jest.fn(() => ({
      values: jest.fn((v: unknown) => {
        captured.values = v;
        return chain;
      }),
    })),
    update: jest.fn(() => ({
      set: jest.fn((s: unknown) => {
        captured.set = s;
        return chain;
      }),
    })),
    delete: jest.fn(() => chain),
  };
  return { db, captured, chain };
}

describe('ExpensesService', () => {
  it('create записва tenantId и автора', async () => {
    const { db, captured } = makeDb();
    const svc = new ExpensesService(db as any);
    await svc.create('tenant-1', 'user-9', {
      date: '2026-07-20',
      amountStotinki: 5000,
      category: 'fuel',
    });
    expect(captured.values).toMatchObject({
      tenantId: 'tenant-1',
      createdById: 'user-9',
      amountStotinki: 5000,
      category: 'fuel',
      courierAccountId: null,
    });
  });

  it('update стеснява по tenant И по id — не само по id', async () => {
    const { db, captured } = makeDb();
    const svc = new ExpensesService(db as any);
    await svc.update('tenant-1', 'exp-1', { amountStotinki: 700 });
    const params = paramValues(captured.where);
    expect(params).toContain('tenant-1');
    expect(params).toContain('exp-1');
  });

  it('update на чужд разход дава 404, не мълчалив успех', async () => {
    const { db } = makeDb([]);
    const svc = new ExpensesService(db as any);
    await expect(svc.update('tenant-1', 'exp-foreign', { amountStotinki: 700 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('remove стеснява по tenant И по id', async () => {
    const { db, captured } = makeDb();
    const svc = new ExpensesService(db as any);
    await svc.remove('tenant-1', 'exp-1');
    const params = paramValues(captured.where);
    expect(params).toContain('tenant-1');
    expect(params).toContain('exp-1');
  });

  it('remove на несъществуващ разход дава 404', async () => {
    const { db } = makeDb([]);
    const svc = new ExpensesService(db as any);
    await expect(svc.remove('tenant-1', 'exp-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('list стеснява по tenant и по двата края на периода', async () => {
    const { db, captured } = makeDb([]);
    const svc = new ExpensesService(db as any);
    await svc.list('tenant-1', '2026-07-01', '2026-07-31');
    const params = paramValues(captured.where);
    expect(params).toContain('tenant-1');
    expect(params).toContain('2026-07-01');
    expect(params).toContain('2026-07-31');
  });

  it('setCommissionBps пише през jsonbDeepMerge (запазва другите настройки)', async () => {
    const { db, captured } = makeDb();
    const svc = new ExpensesService(db as any);
    await svc.setCommissionBps('tenant-1', 1500);
    const { params } = new PgDialect().sqlToQuery((captured.set as { settings: unknown }).settings as any);
    // Пътят е вграден като параметри от jsonbDeepMerge: 'stats' → 'infoCommissionBps'.
    expect(params).toEqual(expect.arrayContaining(['stats', 'infoCommissionBps', '1500']));
  });
});
