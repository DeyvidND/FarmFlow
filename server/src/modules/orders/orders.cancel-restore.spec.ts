/**
 * Regression coverage for `updateStatus`'s cancel branch: cancelling an order
 * must return BOTH kinds of reserved stock — availability-window `remaining`
 * AND variant `stockQuantity` — not just the former. Missing the variant
 * restore was a real inventory leak (stock decremented on reserve, never
 * given back on cancel). Mirrors the wiring-test style in orders.update.spec.ts:
 * the private restore helpers are spied, not re-implemented, so this checks
 * that `updateStatus` calls them with the right args, not their internals.
 */
import { OrdersService } from './orders.service';

function makeSvc(opts: {
  prevStatus: string;
  claimedRows: Array<{ id: string }>;
  items: Array<{ variantId: string | null; quantity: number }>;
}) {
  const prevChain: any = {};
  prevChain.from = () => prevChain;
  prevChain.where = () => prevChain;
  prevChain.limit = () => Promise.resolve([{ status: opts.prevStatus }]);

  const rowUpdateChain: any = {};
  rowUpdateChain.set = () => rowUpdateChain;
  rowUpdateChain.where = () => rowUpdateChain;
  rowUpdateChain.returning = () => Promise.resolve([{ id: 'order-1', status: 'cancelled' }]);

  const cacheDel = jest.fn().mockResolvedValue(undefined);
  const catalogInvalidate = jest.fn().mockResolvedValue(undefined);

  const db: any = {
    select: jest.fn(() => prevChain),
    update: jest.fn(() => rowUpdateChain),
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx: any = {
        update: jest.fn(() => ({
          set: jest.fn(() => ({
            where: jest.fn(() => ({
              returning: jest.fn(() => Promise.resolve(opts.claimedRows)),
            })),
          })),
        })),
        select: jest.fn(() => ({
          from: jest.fn(() => ({
            where: jest.fn(() => Promise.resolve(opts.items)),
          })),
        })),
      };
      return fn(tx);
    }),
  };

  const cache: any = { del: cacheDel };
  const catalogCache: any = { invalidate: catalogInvalidate };
  const svc = new OrdersService(
    db,
    {} as any,
    {} as any,
    {} as any,
    cache,
    {} as any,
    {} as any,
    catalogCache,
  );

  const restoreWindowsSpy = jest.spyOn(svc as any, 'restoreAvailabilityWindows').mockResolvedValue(undefined);
  const restoreVariantSpy = jest
    .spyOn(svc as any, 'restoreVariantStock')
    .mockImplementation(async (...args: unknown[]) => {
      const items = args[1] as Array<{ variantId: string | null }>;
      return items.some((it) => !!it.variantId);
    });

  return { svc, restoreWindowsSpy, restoreVariantSpy, catalogInvalidate, cacheDel };
}

describe('OrdersService.updateStatus cancel branch — stock restore parity', () => {
  it('restores both availability-window and variant stock, then busts the catalog cache', async () => {
    const items = [
      { variantId: 'v1', quantity: 2 },
      { variantId: null, quantity: 1 },
    ];
    const { svc, restoreWindowsSpy, restoreVariantSpy, catalogInvalidate } = makeSvc({
      prevStatus: 'confirmed',
      claimedRows: [{ id: 'order-1' }],
      items,
    });

    await svc.updateStatus('order-1', 'tenant-1', { status: 'cancelled' } as any);

    expect(restoreWindowsSpy).toHaveBeenCalledWith(expect.anything(), 'tenant-1', items);
    expect(restoreVariantSpy).toHaveBeenCalledWith(expect.anything(), items);
    expect(catalogInvalidate).toHaveBeenCalledWith('tenant-1');
  });

  it('skips the catalog-cache bust when no variant line was touched', async () => {
    const items = [{ variantId: null, quantity: 1 }];
    const { svc, restoreVariantSpy, catalogInvalidate } = makeSvc({
      prevStatus: 'confirmed',
      claimedRows: [{ id: 'order-1' }],
      items,
    });

    await svc.updateStatus('order-1', 'tenant-1', { status: 'cancelled' } as any);

    expect(restoreVariantSpy).toHaveBeenCalled();
    expect(catalogInvalidate).not.toHaveBeenCalled();
  });

  it('skips both restores when a concurrent cancel already claimed the transition', async () => {
    const items = [{ variantId: 'v1', quantity: 2 }];
    const { svc, restoreWindowsSpy, restoreVariantSpy, catalogInvalidate } = makeSvc({
      prevStatus: 'confirmed',
      claimedRows: [], // racing cancel already flipped status — zero rows matched
      items,
    });

    await svc.updateStatus('order-1', 'tenant-1', { status: 'cancelled' } as any);

    expect(restoreWindowsSpy).not.toHaveBeenCalled();
    expect(restoreVariantSpy).not.toHaveBeenCalled();
    expect(catalogInvalidate).not.toHaveBeenCalled();
  });

  it('does not restore stock when the order is already cancelled (no-op re-cancel)', async () => {
    const { svc, restoreWindowsSpy, restoreVariantSpy, catalogInvalidate } = makeSvc({
      prevStatus: 'cancelled',
      claimedRows: [{ id: 'order-1' }],
      items: [{ variantId: 'v1', quantity: 2 }],
    });

    await svc.updateStatus('order-1', 'tenant-1', { status: 'cancelled' } as any);

    expect(restoreWindowsSpy).not.toHaveBeenCalled();
    expect(restoreVariantSpy).not.toHaveBeenCalled();
    expect(catalogInvalidate).not.toHaveBeenCalled();
  });
});

describe('restoreVariantStock — real implementation restores an actual DB row', () => {
  /** Full-loop check (not spied): decrement via reserveCartItems's own math is
   *  already covered elsewhere; this asserts restoreVariantStock's own write —
   *  the piece that was never reached from the cancel branch before this fix. */
  it('adds the reserved quantity back to stockQuantity for a finite-stock variant', async () => {
    const rows = [{ id: 'v1', stockQuantity: 5 }];
    const updates: Array<{ stockQuantity: number }> = [];
    const tx: any = {
      select: () => ({
        from: () => ({ where: () => ({ for: () => ({ orderBy: () => Promise.resolve(rows) }) }) }),
      }),
      update: () => ({
        set: (vals: { stockQuantity: number }) => ({
          where: () => {
            updates.push(vals);
            return Promise.resolve();
          },
        }),
      }),
    };
    const svc: any = new OrdersService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const touched = await svc.restoreVariantStock(tx, [{ variantId: 'v1', quantity: 3 }]);
    expect(updates).toEqual([{ stockQuantity: 8 }]);
    expect(touched).toBe(true);
  });
});
