/**
 * Unit test for the pickup-only (courierDisabled) backstop inside
 * OrdersService.reserveCartItems(). A product flagged `courierDisabled` must be
 * rejected when the cart is shipped by carrier (Econt/Speedy office/door, or the
 * per-farmer courier split) but still allowed for local self-delivery / pickup
 * (no waybill). We drive reserveCartItems() directly with a chainable tx mock
 * whose terminal awaits pop a shared result queue in call order.
 */
import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';

const TENANT_ID = 'tenant-1';

/** A products row as returned by the load+lock select. */
function productRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'p1',
    name: 'Прясно мляко',
    weight: '1 л',
    isActive: true,
    courierDisabled: false,
    priceStotinki: 500,
    salePercent: null,
    saleEndsAt: null,
    salePriceStotinki: null,
    ...over,
  };
}

/**
 * Chainable tx mock: every builder method returns the same thenable proxy, and
 * awaiting it shifts the next canned result off `queue`. So the result order is
 * simply the order the service awaits its selects in.
 */
function makeTx(queue: unknown[]) {
  const proxy: any = {
    then: (resolve: (v: unknown) => void) => resolve(queue.shift()),
  };
  for (const m of ['select', 'from', 'where', 'for', 'orderBy', 'limit', 'update', 'set']) {
    proxy[m] = jest.fn(() => proxy);
  }
  return proxy;
}

function makeSvc() {
  return new OrdersService(
    {} as never, // db (unused — reserveCartItems works on tx)
    { geocode: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

const ITEMS = [{ productId: 'p1', quantity: 1 }];

describe('OrdersService.reserveCartItems() — pickup-only backstop', () => {
  it('rejects a courierDisabled product on carrier delivery', async () => {
    const svc = makeSvc();
    // queue: products select, then productsWithVariants select (the block fires
    // right after, before any window query).
    const tx = makeTx([[productRow({ courierDisabled: true })], []]);

    await expect(
      (svc as any).reserveCartItems(tx, TENANT_ID, ITEMS, null, /* carrierDelivery */ true),
    ).rejects.toThrow(BadRequestException);
  });

  it('names the blocked product in the error', async () => {
    const svc = makeSvc();
    const tx = makeTx([[productRow({ name: 'Малини', courierDisabled: true })], []]);

    await expect(
      (svc as any).reserveCartItems(tx, TENANT_ID, ITEMS, null, true),
    ).rejects.toThrow(/Малини/);
  });

  it('allows the same courierDisabled product on local / pickup delivery', async () => {
    const svc = makeSvc();
    // Full pass-through path: products, productsWithVariants, then the active
    // windows select (no windows → []).
    const tx = makeTx([[productRow({ courierDisabled: true })], [], []]);

    const res = await (svc as any).reserveCartItems(
      tx,
      TENANT_ID,
      ITEMS,
      null,
      /* carrierDelivery */ false,
    );
    expect(res.items).toHaveLength(1);
    expect(res.items[0].productId).toBe('p1');
  });

  it('does not block a normal product on carrier delivery', async () => {
    const svc = makeSvc();
    const tx = makeTx([[productRow({ courierDisabled: false })], [], []]);

    const res = await (svc as any).reserveCartItems(tx, TENANT_ID, ITEMS, null, true);
    expect(res.items).toHaveLength(1);
  });
});
