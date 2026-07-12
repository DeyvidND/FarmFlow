import { NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { products } from '@fermeribg/db';
import { ProductsService } from './products.service';

/**
 * Review-queue lifecycle: `create(..., opts)` sets the pending flag on insert,
 * `approve` clears it (admin sign-off), `pendingReviewCount` drives the badge,
 * `findAll({ review: true })` scopes the admin queue view, and the public
 * catalog (`findPublicBySlug`) must never surface a pending product.
 *
 * Mock: chainable Drizzle mock mirroring products.remove.spec.ts's
 * select/update split, extended with an insert chain (products.query.spec.ts,
 * products.farmer-scope.spec.ts) and `.where()` argument capture so review
 * conditions can be asserted with `extractEqPairs` (the technique from
 * orders.mine.spec.ts — walking the real `SQL` node tree for `{ column,
 * value }` leaves instead of a fragile deep-equal against drizzle internals).
 */
function makeDb(results: unknown[][]) {
  let i = 0;
  const next = () => results[i++] ?? [];
  const captured: { insert?: Record<string, unknown>; update?: Record<string, unknown> } = {};
  const whereArgs: unknown[] = [];

  const sel: any = {};
  sel.select = jest.fn(() => sel);
  sel.from = jest.fn(() => sel);
  sel.where = jest.fn((cond: unknown) => {
    whereArgs.push(cond);
    return sel;
  });
  sel.orderBy = jest.fn(() => sel);
  sel.limit = jest.fn(async () => next());
  // `await db.select()....where()` with no trailing `.limit()` (count queries,
  // findPublicBySlug's cold-cache batch loads) — the chain is thenable.
  sel.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(next()).then(res, rej);

  const ins: any = {};
  ins.values = jest.fn((v: Record<string, unknown>) => {
    captured.insert = v;
    return ins;
  });
  ins.returning = jest.fn(async () => next());

  const upd: any = {};
  upd.set = jest.fn((s: Record<string, unknown>) => {
    captured.update = s;
    return upd;
  });
  upd.where = jest.fn((cond: unknown) => {
    whereArgs.push(cond);
    return upd;
  });
  upd.returning = jest.fn(async () => next());

  const db: any = {
    select: sel.select,
    insert: jest.fn(() => ins),
    update: jest.fn(() => upd),
  };
  return { db, captured, whereArgs };
}

const catalogCache = () => ({ invalidate: jest.fn(), get: jest.fn(), set: jest.fn() });
const svcWith = (db: unknown, cache: unknown, publicCache: unknown = {}) =>
  new ProductsService(db as never, {} as never, cache as never, publicCache as never, {} as never, {} as never);

/** Walk a drizzle `SQL` node tree and pull out `{ column, value }` for every
 *  `col = param` leaf. See orders.mine.spec.ts for the full rationale — this
 *  is a straight copy of that helper (not exported from there). */
function extractEqPairs(node: unknown): Array<{ column: string; value: unknown }> {
  const pairs: Array<{ column: string; value: unknown }> = [];
  let pendingColumn: string | null = null;

  function walk(n: any): void {
    if (n == null || typeof n !== 'object') return;
    const ctor = n.constructor?.name;
    if (ctor === 'PgColumn' || (typeof n.name === 'string' && n.table !== undefined)) {
      pendingColumn = n.name;
      return;
    }
    if (ctor === 'Param') {
      if (pendingColumn) {
        pairs.push({ column: pendingColumn, value: n.value });
        pendingColumn = null;
      }
      return;
    }
    if (Array.isArray(n.queryChunks)) {
      for (const c of n.queryChunks) walk(c);
    }
  }

  const sqlNode = (node as any)?.getSQL ? (node as any).getSQL() : node;
  walk(sqlNode);
  return pairs;
}

describe('product review queue', () => {
  it('create with opts.needsReview=true inserts needs_review=true', async () => {
    // [0] assertRefsInTenant farmer lookup (farmerScope forces farmerId onto
    // values, so this always runs when farmerScope !== null), [1] uniqueSlug
    // (free), [2] insert().returning().
    const { db, captured } = makeDb([[{ id: 'farmer-1' }], [], [{ id: 'new' }]]);
    const svc = svcWith(db, catalogCache());

    await svc.create(
      't1',
      { name: 'Мед', priceStotinki: 500, unit: 'kg' } as never,
      'farmer-1',
      { needsReview: true },
    );

    expect(captured.insert?.needsReview).toBe(true);
  });

  it('create without opts inserts needs_review=false (default)', async () => {
    // Covers producer-onboard: farmerScope set, opts omitted → LIVE immediately.
    const { db, captured } = makeDb([[{ id: 'farmer-1' }], [], [{ id: 'new' }]]);
    const svc = svcWith(db, catalogCache());

    await svc.create('t1', { name: 'Мед', priceStotinki: 500, unit: 'kg' } as never, 'farmer-1');

    expect(captured.insert?.needsReview).toBe(false);
  });

  it('approve clears the flag, invalidates catalog cache, returns the row', async () => {
    const c = catalogCache();
    const { db, captured } = makeDb([[{ id: 'p1', tenantId: 't1', needsReview: false }]]);
    const svc = svcWith(db, c);

    const row = await svc.approve('p1', 't1');

    expect(captured.update).toEqual({ needsReview: false });
    expect(c.invalidate).toHaveBeenCalledWith('t1');
    expect(row).toMatchObject({ id: 'p1', needsReview: false });
  });

  it('approve throws NotFoundException when no row matches', async () => {
    const c = catalogCache();
    const { db } = makeDb([[]]);
    const svc = svcWith(db, c);

    await expect(svc.approve('missing', 't1')).rejects.toThrow(NotFoundException);
    expect(c.invalidate).not.toHaveBeenCalled();
  });

  it('pendingReviewCount counts tenant pending non-deleted rows', async () => {
    const { db, whereArgs } = makeDb([[{ count: 3 }]]);
    const svc = svcWith(db, catalogCache());

    await expect(svc.pendingReviewCount('t1')).resolves.toEqual({ count: 3 });

    const pairs = extractEqPairs(whereArgs[0]);
    expect(pairs).toEqual(
      expect.arrayContaining([
        { column: 'tenant_id', value: 't1' },
        { column: 'needs_review', value: true },
      ]),
    );
  });

  it('findAll with review:true adds the needs_review condition to both the list and the total', async () => {
    const rows = [
      { id: 'a', createdAt: new Date('2026-01-01'), __keysetTs: '2026-01-01T00:00:00.000000' },
    ];
    const { db, whereArgs } = makeDb([rows, [{ total: 1 }]]);
    const svc = svcWith(db, catalogCache());

    const page = await svc.findAll('t1', { limit: 5, review: true } as never);

    expect(page.items).toHaveLength(1);
    // whereArgs[0] = list query, whereArgs[1] = first-page total query — both
    // must be scoped by the review filter or the queue's header count would
    // drift from the rows actually shown.
    const listPairs = extractEqPairs(whereArgs[0]);
    const totalPairs = extractEqPairs(whereArgs[1]);
    const expected = extractEqPairs(and(eq(products.tenantId, 't1'), eq(products.needsReview, true)));
    expect(listPairs).toEqual(expect.arrayContaining(expected));
    expect(totalPairs).toEqual(expect.arrayContaining(expected));
  });

  it('findPublicBySlug filters out pending products', async () => {
    const c = catalogCache();
    c.get.mockResolvedValue(null);
    const publicCache = { resolveTenant: jest.fn().mockResolvedValue({ id: 't1' }) };
    const product = {
      id: 'p1',
      slug: 'med',
      name: 'Мед',
      priceStotinki: 500,
      salePercent: null,
      saleEndsAt: null,
      salePriceStotinki: null,
      imageUrl: null,
      tenantId: 't1',
    };
    // [0] product rows, [1] media batch (none), [2] variant batch (none) — same
    // shape as products.query.spec.ts's cold-cache test.
    const { db, whereArgs } = makeDb([[product], [], []]);
    const svc = svcWith(db, c, publicCache);

    const result = await svc.findPublicBySlug('shop');

    expect(result).toHaveLength(1);
    const pairs = extractEqPairs(whereArgs[0]);
    const expected = extractEqPairs(
      and(eq(products.tenantId, 't1'), eq(products.isActive, true), eq(products.needsReview, false)),
    );
    expect(pairs).toEqual(expect.arrayContaining(expected));
  });
});

describe('review endpoint roles', () => {
  // Task 3 (controller wiring) hasn't run yet in this branch — ProductsController
  // has no `approve` / `reviewCount` methods to pin metadata on. Un-todo these
  // (and add `import { ProductsController } from './products.controller';` +
  // `Reflect.getMetadata('roles', ProductsController.prototype.approve)` /
  // `...reviewCount)` assertions, per the task-2 brief) once Task 3 lands.
  it.todo('approve is admin-only');
  it.todo('review count is admin-only');
});
