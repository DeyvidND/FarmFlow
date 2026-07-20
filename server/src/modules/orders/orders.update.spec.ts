/**
 * Guard tests for OrdersService.updateOrder. Status no longer gates edits (an
 * order is editable regardless of status); the remaining guard blocks item
 * edits once money has been collected (paidAt / codOutcome='received').
 */
import { BadRequestException } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { OrdersService } from './orders.service';
import { subtotalStotinki, recomputeTotalStotinki } from './order-total.util';

/** Minimal db mock whose first (and only) select resolves to `[orderRow]`. */
function serviceWithOrder(orderRow: Record<string, unknown>): OrdersService {
  const chain: any = {};
  chain.from = () => chain;
  chain.leftJoin = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve([orderRow]);
  const db: any = { select: () => chain };
  // Only `db` and `maps` are touched on the guard paths.
  const maps: any = { geocode: jest.fn(), geocodeCity: jest.fn() };
  return new OrdersService(db, maps, {} as any, {} as any, {} as any, {} as any, {} as any, { invalidate: jest.fn() } as any);
}

const BASE = {
  id: 'order-1',
  tenantId: 'tenant-1',
  status: 'confirmed',
  paidAt: null,
  deliveryType: 'address',
  totalStotinki: 1000,
  slotId: null,
  slotFrom: null,
  slotTo: null,
  slotDate: null,
};

describe('updateOrder guards', () => {
  it('allows editing an order regardless of status (delivered/cancelled/preparing/out_for_delivery)', async () => {
    for (const status of ['delivered', 'cancelled', 'preparing', 'out_for_delivery']) {
      const svc = serviceWithOrder({ ...BASE, status });
      jest.spyOn(svc, 'findOne').mockResolvedValue({} as any);
      (svc as any).db.transaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          // the FOR UPDATE order-row lock the fix takes first — un-collected here
          select: () => ({ from: () => ({ where: () => ({ for: () => ({ limit: () => Promise.resolve([{ paidAt: null, codOutcome: null }]) }) }) }) }),
          update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
        }),
      );
      (svc as any).cache = { del: jest.fn().mockResolvedValue(undefined) };
      await expect(svc.updateOrder('order-1', 'tenant-1', { customerName: 'Х' })).resolves.not.toThrow();
    }
  });
  it('rejects item edits on a card-paid order', async () => {
    const svc = serviceWithOrder({ ...BASE, paidAt: new Date() });
    await expect(
      svc.updateOrder('order-1', 'tenant-1', { items: [{ productId: '11111111-1111-1111-1111-111111111111', quantity: 1 }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  // COD money is collected at codOutcome='received' (never sets paidAt) — that is
  // the signal the commission ledger accrues its gross snapshot on. Editing items
  // afterwards would recompute the total but leave the accrual stale (accrue is
  // onConflictDoNothing), so item edits must be blocked once the cash is in.
  it('rejects item edits on a COD order already marked received', async () => {
    const svc = serviceWithOrder({ ...BASE, paidAt: null, codOutcome: 'received' });
    await expect(
      svc.updateOrder('order-1', 'tenant-1', { items: [{ productId: '11111111-1111-1111-1111-111111111111', quantity: 1 }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

/**
 * Regression coverage for a changed (non-empty) address whose geocode lookup
 * misses (no match, or Maps disabled). The OLD lat/lng/city must not survive
 * under the NEW address text — they must be written as explicit `null`, never
 * left `undefined` (which the `!== undefined` write-guard would skip).
 */
describe('updateOrder geocode-miss clears stale coordinates/city', () => {
  /** Builds a service whose `findOne` is stubbed out (already covered elsewhere)
   *  so the test can focus on the `set` object written by the update inside the
   *  transaction. `setCapture` collects every `tx.update(orders).set(...)` call. */
  function serviceForGeocodeMiss(
    orderRow: Record<string, unknown>,
    setCapture: Record<string, unknown>[],
    maps: { geocode: jest.Mock; geocodeCity: jest.Mock },
  ): OrdersService {
    const orderChain: any = {};
    orderChain.from = () => orderChain;
    orderChain.leftJoin = () => orderChain;
    orderChain.where = () => orderChain;
    orderChain.limit = () => Promise.resolve([orderRow]);

    const tenantChain: any = {};
    tenantChain.from = () => tenantChain;
    tenantChain.where = () => tenantChain;
    tenantChain.limit = () => Promise.resolve([{ farmLat: null, farmLng: null }]);

    let selectCall = 0;
    const db: any = {
      select: jest.fn(() => (selectCall++ === 0 ? orderChain : tenantChain)),
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx: any = {
          // the FOR UPDATE order-row lock the fix takes first — un-collected here
          select: () => ({ from: () => ({ where: () => ({ for: () => ({ limit: () => Promise.resolve([{ paidAt: null, codOutcome: null }]) }) }) }) }),
          update: jest.fn(() => {
            const c: any = {};
            c.set = jest.fn((v: Record<string, unknown>) => {
              setCapture.push(v);
              return c;
            });
            c.where = jest.fn(() => Promise.resolve([]));
            return c;
          }),
        };
        return fn(tx);
      }),
    };
    const cache: any = { del: jest.fn().mockResolvedValue(undefined) };
    const svc = new OrdersService(db, maps as any, {} as any, {} as any, cache, {} as any, {} as any, { invalidate: jest.fn() } as any);
    jest.spyOn(svc, 'findOne').mockResolvedValue({} as any);
    return svc;
  }

  it('nulls out stale lat/lng when the new address fails to geocode (deliveryType: address)', async () => {
    const setCapture: Record<string, unknown>[] = [];
    const maps = { geocode: jest.fn().mockResolvedValue(null), geocodeCity: jest.fn() };
    const svc = serviceForGeocodeMiss(
      { ...BASE, deliveryType: 'address', deliveryAddress: 'ул. Стара 1', deliveryLat: '42.0', deliveryLng: '23.0' },
      setCapture,
      maps,
    );
    await svc.updateOrder('order-1', 'tenant-1', { deliveryAddress: 'несъществуващ адрес 999' });
    expect(maps.geocode).toHaveBeenCalled();
    expect(setCapture).toHaveLength(1);
    expect(setCapture[0].deliveryLat).toBeNull();
    expect(setCapture[0].deliveryLng).toBeNull();
  });

  it('nulls out stale city when the new address fails to resolve a city (deliveryType: econt_address)', async () => {
    const setCapture: Record<string, unknown>[] = [];
    const maps = { geocode: jest.fn(), geocodeCity: jest.fn().mockResolvedValue(null) };
    const svc = serviceForGeocodeMiss(
      { ...BASE, deliveryType: 'econt_address', deliveryAddress: 'ул. Стара 1', deliveryCity: 'София' },
      setCapture,
      maps,
    );
    await svc.updateOrder('order-1', 'tenant-1', { deliveryAddress: 'несъществуващ адрес 999' });
    expect(maps.geocodeCity).toHaveBeenCalled();
    expect(setCapture).toHaveLength(1);
    expect(setCapture[0].deliveryCity).toBeNull();
  });
});

/**
 * End-to-end wiring test for the item-replacement block in `updateOrder`. The
 * heavy lifting inside `restoreAvailabilityWindows` / `restoreVariantStock` /
 * `reserveCartItems` is already covered elsewhere (unit test above, and the
 * intake-path tests in orders.service.spec.ts); what has ZERO coverage without
 * this test is the WIRING — that old stock is restored before the new items
 * are reserved, that `reserveCartItems` gets a literal `null` slotId, that
 * `order_items` are swapped, and that `set.totalStotinki` ends up as
 * `recomputeTotalStotinki(...)` rather than something else. So the three
 * private helpers are spied (not re-implemented) and we assert call order,
 * call arguments, and the final `set` object — a coarser but far less brittle
 * check than simulating their internals through a mocked tx.
 */
describe('updateOrder item replacement wiring', () => {
  it('restores OLD stock before reserving NEW items, passes slotId=null, swaps order_items, and recomputes the fee-preserving total', async () => {
    const oldItems = [{ productId: 'p1', variantId: null, quantity: 2, priceStotinki: 500 }]; // old subtotal: 1000
    const newDtoItems = [{ productId: 'p1', quantity: 3 }];
    const preparedNewItems = [
      { productId: 'p1', productName: 'Product A', quantity: 3, priceStotinki: 500, variantId: null, variantLabel: null, farmerId: 'f1' },
    ]; // new subtotal: 1500

    const orderRow = { ...BASE, status: 'confirmed', paidAt: null, totalStotinki: 1300 }; // shipping folded in: 300

    const orderChain: any = {};
    orderChain.from = () => orderChain;
    orderChain.leftJoin = () => orderChain;
    orderChain.where = () => orderChain;
    orderChain.limit = () => Promise.resolve([orderRow]);

    const calls: string[] = [];
    const setCapture: Record<string, unknown>[] = [];
    let insertedRows: unknown[] | undefined;

    let txSel = 0;
    const db: any = {
      select: jest.fn(() => orderChain),
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx: any = {
          // call 0 is the FOR UPDATE order-row lock the fix takes first; later calls
          // are the oldItems / products reads as before.
          select: () =>
            txSel++ === 0
              ? { from: () => ({ where: () => ({ for: () => ({ limit: () => Promise.resolve([orderRow]) }) }) }) }
              : { from: () => ({ where: () => Promise.resolve(oldItems) }) },
          delete: () => ({
            where: () => {
              calls.push('delete');
              return Promise.resolve();
            },
          }),
          insert: () => ({
            values: (rows: unknown[]) => {
              calls.push('insert');
              insertedRows = rows;
              return Promise.resolve();
            },
          }),
          update: () => ({
            set: (v: Record<string, unknown>) => ({
              where: () => {
                setCapture.push(v);
                return Promise.resolve();
              },
            }),
          }),
        };
        return fn(tx);
      }),
    };
    const maps: any = { geocode: jest.fn(), geocodeCity: jest.fn() };
    const cache: any = { del: jest.fn().mockResolvedValue(undefined) };
    const svc = new OrdersService(db, maps, {} as any, {} as any, cache, {} as any, {} as any, { invalidate: jest.fn() } as any);
    jest.spyOn(svc, 'findOne').mockResolvedValue({} as any);

    const restoreWindowsSpy = jest
      .spyOn(svc as any, 'restoreAvailabilityWindows')
      .mockImplementation(async () => {
        calls.push('restoreAvailabilityWindows');
      });
    const restoreVariantSpy = jest
      .spyOn(svc as any, 'restoreVariantStock')
      .mockImplementation(async () => {
        calls.push('restoreVariantStock');
      });
    const reserveCartSpy = jest.spyOn(svc as any, 'reserveCartItems').mockImplementation(async () => {
      calls.push('reserveCartItems');
      return { items: preparedNewItems, slotFrom: null, slotTo: null, slotDate: null };
    });

    await svc.updateOrder('order-1', 'tenant-1', { items: newDtoItems as any });

    // Old stock restored BEFORE the new items are reserved.
    expect(calls.indexOf('restoreAvailabilityWindows')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('restoreVariantStock')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('reserveCartItems')).toBeGreaterThan(calls.indexOf('restoreAvailabilityWindows'));
    expect(calls.indexOf('reserveCartItems')).toBeGreaterThan(calls.indexOf('restoreVariantStock'));

    // Restore helpers ran against the OLD items, never the new dto items.
    expect(restoreWindowsSpy).toHaveBeenCalledWith(expect.anything(), 'tenant-1', oldItems);
    expect(restoreVariantSpy).toHaveBeenCalledWith(expect.anything(), oldItems);

    // reserveCartItems got the new dto items and a literal `null` slotId (4th arg) —
    // slot handling is done separately above, so item edits must never re-lock a slot.
    expect(reserveCartSpy).toHaveBeenCalledWith(expect.anything(), 'tenant-1', newDtoItems, null, false);

    // order_items were swapped: old rows deleted, new (farmerId-stripped) rows inserted.
    expect(calls).toContain('delete');
    expect(calls).toContain('insert');
    expect(insertedRows).toEqual([
      { productId: 'p1', productName: 'Product A', quantity: 3, priceStotinki: 500, variantId: null, variantLabel: null, orderId: 'order-1' },
    ]);

    // Total recomputed via the real (already-unit-tested) fee-preserving formula —
    // computed here from the actual function, not a hand-copied number.
    const expectedTotal = recomputeTotalStotinki(1300, subtotalStotinki(oldItems), subtotalStotinki(preparedNewItems));
    expect(expectedTotal).toBe(1800); // sanity: shipping 300 recovered + new subtotal 1500
    expect(setCapture).toHaveLength(1);
    expect(setCapture[0].totalStotinki).toBe(expectedTotal);
  });
});

/**
 * Regression coverage for the grandfather clause: an order line whose product
 * has since gone inactive/deleted must not block editing OTHER lines in the
 * same order, as long as that line's own product/variant/quantity is untouched.
 */
describe('updateOrder item replacement — grandfathers an unchanged inactive-product line', () => {
  it('carries the untouched inactive-product line forward verbatim and only re-validates/reserves the changed line', async () => {
    const oldItems = [
      { id: 'oi-1', orderId: 'order-1', productId: 'p1', productName: 'Малини 1кг', variantId: null, variantLabel: null, quantity: 1, priceStotinki: 500 },
      { id: 'oi-2', orderId: 'order-1', productId: 'p2', productName: 'Краставици 3-клас 1кг', variantId: null, variantLabel: null, quantity: 1, priceStotinki: 300 },
    ];
    const dtoItems = [
      { productId: 'p1', quantity: 1 }, // unchanged — p1 is now inactive
      { productId: 'p2', quantity: 2 }, // changed 1 -> 2
    ];
    const preparedNew = [
      { productId: 'p2', productName: 'Краставици 3-клас 1кг', quantity: 2, priceStotinki: 300, variantId: null, variantLabel: null, farmerId: 'f1' },
    ];
    const orderRow = { ...BASE, status: 'confirmed', paidAt: null, totalStotinki: 1100 }; // subtotal 800 + fee 300

    const orderChain: any = {};
    orderChain.from = () => orderChain;
    orderChain.leftJoin = () => orderChain;
    orderChain.where = () => orderChain;
    orderChain.limit = () => Promise.resolve([orderRow]);

    let txSelectCall = 0;
    const setCapture: Record<string, unknown>[] = [];
    let insertedRows: unknown[] | undefined;
    let deleteCalled = false;

    const db: any = {
      select: jest.fn(() => orderChain),
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx: any = {
          select: jest.fn(() => {
            const call = txSelectCall++;
            if (call === 0) {
              // the FOR UPDATE order-row lock the fix takes first
              return { from: () => ({ where: () => ({ for: () => ({ limit: () => Promise.resolve([orderRow]) }) }) }) };
            }
            return {
              from: () => ({
                where: () =>
                  Promise.resolve(
                    call === 1
                      ? oldItems
                      : [
                          { id: 'p1', isActive: false },
                          { id: 'p2', isActive: true },
                        ],
                  ),
              }),
            };
          }),
          delete: () => ({
            where: () => {
              deleteCalled = true;
              return Promise.resolve();
            },
          }),
          insert: () => ({
            values: (rows: unknown[]) => {
              insertedRows = rows;
              return Promise.resolve();
            },
          }),
          update: () => ({
            set: (v: Record<string, unknown>) => ({
              where: () => {
                setCapture.push(v);
                return Promise.resolve();
              },
            }),
          }),
        };
        return fn(tx);
      }),
    };
    const maps: any = { geocode: jest.fn(), geocodeCity: jest.fn() };
    const cache: any = { del: jest.fn().mockResolvedValue(undefined) };
    const svc = new OrdersService(db, maps, {} as any, {} as any, cache, {} as any, {} as any, { invalidate: jest.fn() } as any);
    jest.spyOn(svc, 'findOne').mockResolvedValue({} as any);

    const restoreWindowsSpy = jest.spyOn(svc as any, 'restoreAvailabilityWindows').mockImplementation(async () => {});
    const restoreVariantSpy = jest.spyOn(svc as any, 'restoreVariantStock').mockImplementation(async () => {});
    const reserveCartSpy = jest.spyOn(svc as any, 'reserveCartItems').mockImplementation(async () => ({
      items: preparedNew,
      slotFrom: null,
      slotTo: null,
      slotDate: null,
    }));

    await svc.updateOrder('order-1', 'tenant-1', { items: dtoItems as any });

    // Only the CHANGED line (p2) is re-validated/re-reserved — the unchanged
    // inactive-product line (p1) never reaches reserveCartItems, so it can't
    // trip the "Невалиден или неактивен продукт" guard.
    expect(reserveCartSpy).toHaveBeenCalledWith(expect.anything(), 'tenant-1', [{ productId: 'p2', quantity: 2 }], null, false);

    // Only the CHANGED line's old stock/window is released — the grandfathered
    // line's original reservation is left untouched.
    expect(restoreWindowsSpy).toHaveBeenCalledWith(expect.anything(), 'tenant-1', [oldItems[1]]);
    expect(restoreVariantSpy).toHaveBeenCalledWith(expect.anything(), [oldItems[1]]);

    // Re-insert carries the grandfathered line's original snapshot verbatim
    // (id/orderId stripped, price/name/variant unchanged) alongside the freshly
    // prepared new line.
    expect(insertedRows).toEqual([
      { productId: 'p1', productName: 'Малини 1кг', variantId: null, variantLabel: null, quantity: 1, priceStotinki: 500, orderId: 'order-1' },
      { productId: 'p2', productName: 'Краставици 3-клас 1кг', quantity: 2, priceStotinki: 300, variantId: null, variantLabel: null, orderId: 'order-1' },
    ]);
    expect(deleteCalled).toBe(true);

    const expectedTotal = recomputeTotalStotinki(
      orderRow.totalStotinki,
      subtotalStotinki(oldItems),
      subtotalStotinki([oldItems[0]]) + subtotalStotinki(preparedNew),
    );
    expect(setCapture[0].totalStotinki).toBe(expectedTotal);
  });
});

describe('restoreVariantStock (via a captured tx)', () => {
  it('adds quantities back in ONE set-based UPDATE (CASE), skipping unlimited (null) stock', async () => {
    const captured: Array<{ set: SQL; where: SQL }> = [];
    const rows = [
      { id: 'v1', stockQuantity: 2 },
      { id: 'v2', stockQuantity: null },
    ];
    const tx: any = {
      select: () => ({
        from: () => ({ where: () => ({ for: () => ({ orderBy: () => Promise.resolve(rows) }) }) }),
      }),
      update: () => ({
        set: (vals: { stockQuantity: SQL }) => ({
          where: (w: SQL) => {
            captured.push({ set: vals.stockQuantity, where: w });
            return Promise.resolve();
          },
        }),
      }),
    };
    const svc: any = new OrdersService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await svc.restoreVariantStock(tx, [
      { variantId: 'v1', quantity: 3 },
      { variantId: 'v2', quantity: 1 },
    ]);
    // ONE UPDATE, not two — a CASE over the finite-stock variants only.
    expect(captured).toHaveLength(1);
    const dialect = new PgDialect();
    const set = dialect.sqlToQuery(captured[0].set);
    const where = dialect.sqlToQuery(captured[0].where);
    expect(set.sql.toLowerCase()).toContain('case');
    // v1 finite → 2 + 3 = 5 written; v2 (null) skipped entirely (not in the CASE or the WHERE).
    expect(set.params).toEqual(expect.arrayContaining(['v1', 5]));
    expect(set.params).not.toContain('v2');
    expect(where.params).toEqual(['v1']); // inArray over only the finite variant
  });
});
