/**
 * Unit tests for ProductsService.setBundleItems() — the atomic circularity +
 * farmer-scope check on bundle members (bug fix: member validation used to run
 * OUTSIDE the write transaction, via a plain tenant-scoped select with no
 * farmer check — a TOCTOU gap plus a cross-farmer leak). The fix moves the
 * member select INSIDE db.transaction(), locked with `.for('update')`, and
 * checks bundle.farmerId against each member's farmerId.
 *
 * Mock style mirrors orders.companion.spec.ts: a chainable thenable proxy for
 * `db`/`tx` — every builder method returns the same proxy, and awaiting it
 * shifts the next canned result off a queue. `db.transaction(cb)` is mocked
 * separately to hand the callback a fresh tx proxy backed by its own queue.
 */
import { BadRequestException } from '@nestjs/common';
import { and, inArray, isNull } from 'drizzle-orm';
import { productVariants } from '@fermeribg/db';
import { ProductsService } from './products.service';
import type { BundleItemDto } from './dto/bundle-items.dto';

const TENANT_ID = 'tenant-1';

function bundleRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'bundle1',
    tenantId: TENANT_ID,
    category: 'bundle',
    farmerId: null,
    deletedAt: null,
    ...over,
  };
}

function memberRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'm1',
    category: 'produce',
    farmerId: null,
    ...over,
  };
}

function item(productId: string, quantity = 1): BundleItemDto {
  return { productId, quantity } as BundleItemDto;
}

/** Chainable thenable proxy: every builder method returns the same proxy, and
 *  awaiting it shifts the next canned result off `queue` — so the result
 *  order is simply the order the service awaits its selects/writes in. */
function makeChain(queue: unknown[]) {
  const proxy: any = {
    then: (resolve: (v: unknown) => void) => resolve(queue.shift()),
  };
  for (const m of ['select', 'from', 'where', 'limit', 'for', 'orderBy', 'delete', 'insert', 'values', 'innerJoin']) {
    proxy[m] = jest.fn(() => proxy);
  }
  return proxy;
}

/** Builds the `db` mock: a chain for non-tx calls (findOne, listBundleItems)
 *  plus a `.transaction()` that hands the callback a fresh tx chain. */
function makeDb(dbQueue: unknown[], txQueue: unknown[]) {
  const db = makeChain(dbQueue);
  db.transaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = makeChain(txQueue);
    return cb(tx);
  });
  return db;
}

function makeSvc(db: any, cache: { invalidate: jest.Mock } = { invalidate: jest.fn() }) {
  const svc = new ProductsService(
    db,
    {} as never, // storage
    cache as never,
    {} as never, // publicCache
    {} as never, // imageQueue
    {} as never, // availability
    {} as never, // sanityVision
  );
  return { svc, cache };
}

describe('ProductsService.setBundleItems() — atomic circularity + farmer scoping', () => {
  it('rejects a bundle referencing itself', async () => {
    const bundle = bundleRow();
    const db = makeDb([[bundle]], []);
    const { svc } = makeSvc(db);

    await expect(
      svc.setBundleItems('bundle1', TENANT_ID, [item('bundle1')]),
    ).rejects.toThrow(BadRequestException);
    const db2 = makeDb([[bundle]], []);
    const { svc: svc2 } = makeSvc(db2);
    await expect(svc2.setBundleItems('bundle1', TENANT_ID, [item('bundle1')])).rejects.toThrow(
      /себе си/,
    );
  });

  it('rejects a nested-bundle member inside the locked re-check', async () => {
    const bundle = bundleRow();
    const nestedMember = memberRow({ id: 'm1', category: 'bundle' });
    const db = makeDb([[bundle]], [[nestedMember]]);
    const { svc } = makeSvc(db);

    await expect(
      svc.setBundleItems('bundle1', TENANT_ID, [item('m1')]),
    ).rejects.toThrow(BadRequestException);
    const db2 = makeDb([[bundle]], [[nestedMember]]);
    const { svc: svc2 } = makeSvc(db2);
    await expect(svc2.setBundleItems('bundle1', TENANT_ID, [item('m1')])).rejects.toThrow(
      /друг пакет/,
    );
  });

  it('rejects a member belonging to a different farmer', async () => {
    const bundle = bundleRow({ farmerId: 'farmer-A' });
    const member = memberRow({ id: 'm1', farmerId: 'farmer-B' });
    const db = makeDb([[bundle]], [[member]]);
    const { svc } = makeSvc(db);

    await expect(
      svc.setBundleItems('bundle1', TENANT_ID, [item('m1')], 'farmer-A'),
    ).rejects.toThrow(BadRequestException);
    const db2 = makeDb([[bundle]], [[member]]);
    const { svc: svc2 } = makeSvc(db2);
    await expect(
      svc2.setBundleItems('bundle1', TENANT_ID, [item('m1')], 'farmer-A'),
    ).rejects.toThrow(/друг производител/);
  });

  it('happy path: same-farmer non-bundle members replace the bundle set', async () => {
    const bundle = bundleRow({ farmerId: 'farmer-A' });
    const member = memberRow({ id: 'm1', farmerId: 'farmer-A' });
    const listRows = [
      {
        productId: 'm1',
        quantity: 2,
        position: 0,
        name: 'Домати',
        slug: 'domati',
        imageUrl: null,
        priceStotinki: 100,
        isActive: true,
        courierDisabled: false,
      },
    ];
    // setBundleItems' own findOne(), then listBundleItems()'s findOne() (re-checks
    // existence/scope), then the actual bundle-items join select.
    const dbQueue = [[bundle], [bundle], listRows];
    // tx queue: locked member select, then the no-variants check (empty = none
    // varianted), then the delete, then the insert.
    const txQueue = [[member], [], undefined, undefined];
    const db = makeDb(dbQueue, txQueue);
    const { svc, cache } = makeSvc(db);

    const res = await svc.setBundleItems('bundle1', TENANT_ID, [item('m1', 2)], 'farmer-A');

    expect(res).toHaveLength(1);
    expect(res[0].productId).toBe('m1');
    expect(cache.invalidate).toHaveBeenCalledWith(TENANT_ID);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('runs the member re-check inside the write transaction under a row lock', async () => {
    const bundle = bundleRow();
    const member = memberRow({ id: 'm1' });
    // setBundleItems' own findOne(), then listBundleItems()'s findOne(), then the
    // actual bundle-items join select.
    const dbQueue = [[bundle], [bundle], []];
    // tx queue: locked member select, then the no-variants check (empty = none
    // varianted), then the delete, then the insert.
    const txQueue = [[member], [], undefined, undefined];
    const db = makeChain(dbQueue) as any;
    let capturedTx: any;
    db.transaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      capturedTx = makeChain(txQueue);
      return cb(capturedTx);
    });
    const { svc } = makeSvc(db);

    await svc.setBundleItems('bundle1', TENANT_ID, [item('m1')]);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(capturedTx.select).toHaveBeenCalled();
    expect(capturedTx.for).toHaveBeenCalledWith('update');
  });

  it('rejects a member product that has variants', async () => {
    const bundle = bundleRow({ farmerId: 'farmer-A' });
    const member = memberRow({ id: 'm1', name: 'Мед натурален', farmerId: 'farmer-A' });
    // The member itself passes the category/farmer checks; the productVariants
    // select (run against the locked member set) returns one live variant row
    // for this product id, which must block the whole replace.
    const variantRow = { productId: 'm1' };
    const dbQueue = [[bundle]];
    const txQueue = [[member], [variantRow]];
    const db = makeChain(dbQueue) as any;
    let capturedTx: any;
    db.transaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      capturedTx = makeChain(txQueue);
      return cb(capturedTx);
    });
    const { svc } = makeSvc(db);

    await expect(
      svc.setBundleItems('bundle1', TENANT_ID, [item('m1')], 'farmer-A'),
    ).rejects.toThrow('Продукт с варианти не може да е част от кошница: Мед натурален');

    // The FIFO queue above hands back a non-empty variant row regardless of
    // what the service actually queried for — a mock that ignores its WHERE
    // args would still make the assertion above pass even if the service
    // dropped the `isNull(productVariants.deletedAt)` filter (i.e. started
    // treating soft-deleted variants as live, wrongly blocking a member).
    // Assert on the captured WHERE call itself to close that gap: it must be
    // the memberIds-scoped, not-deleted filter, not merely "second call".
    expect(capturedTx.where.mock.calls[1][0]).toEqual(
      and(inArray(productVariants.productId, ['m1']), isNull(productVariants.deletedAt)),
    );
  });

  it('rejects only the varianted member out of a mixed set (name-filter branch)', async () => {
    const bundle = bundleRow({ farmerId: 'farmer-A' });
    const variantedMember = memberRow({ id: 'm1', name: 'Мед натурален', farmerId: 'farmer-A' });
    const plainMember = memberRow({ id: 'm2', name: 'Домати', farmerId: 'farmer-A' });
    // Both members pass the category/farmer checks; the productVariants select
    // returns a live variant row for m1 only, so the reported name list must
    // include m1's name and exclude m2's — exercises
    // `members.filter(m => blockedIds.has(m.id))` with a mixed set, not just
    // a single member.
    const variantRow = { productId: 'm1' };
    const dbQueue = [[bundle]];
    const txQueue = [[variantedMember, plainMember], [variantRow]];
    const db = makeDb(dbQueue, txQueue);
    const { svc } = makeSvc(db);

    await expect(
      svc.setBundleItems('bundle1', TENANT_ID, [item('m1'), item('m2')], 'farmer-A'),
    ).rejects.toThrow(/^Продукт с варианти не може да е част от кошница: Мед натурален$/);
  });
});
