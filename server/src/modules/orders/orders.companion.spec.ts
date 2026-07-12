/**
 * Unit test for the companion-product rule inside OrdersService.reserveCartItems().
 * A product flagged `requiresCompanion` cannot be ordered alone — the cart must
 * also hold at least one OTHER distinct product (and, when `companionMinPriceStotinki`
 * is set, that other product's resolved unit price must meet the threshold).
 *
 * The check runs right after the pickup-only (courierDisabled) backstop and
 * before the slot/availability-window block. It uses only `byId` (the products
 * select) + `variantById` (empty here — none of these carts pick a variant) +
 * the exported `resolveLineUnit` — no extra query. So the tx-mock queue for the
 * relevant path is: [products select rows], [productsWithVariants select rows],
 * [activeWindows rows] — the third only consumed when the check passes.
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
    requiresCompanion: false,
    companionMinPriceStotinki: null,
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
    {} as never,
  );
}

describe('OrdersService.reserveCartItems() — companion enforcement', () => {
  it('rejects an apricots-only cart (requiresCompanion, no threshold)', async () => {
    const svc = makeSvc();
    const apricot = productRow({ id: 'apricot', name: 'Кайсии', requiresCompanion: true });
    const tx = makeTx([[apricot], []]);
    const items = [{ productId: 'apricot', quantity: 1 }];

    await expect(
      (svc as any).reserveCartItems(tx, TENANT_ID, items, null),
    ).rejects.toThrow(BadRequestException);
    // Re-run for the message assertion (the tx/queue above was already consumed).
    const tx2 = makeTx([[apricot], []]);
    await expect((svc as any).reserveCartItems(tx2, TENANT_ID, items, null)).rejects.toThrow(
      /самостоятелно/,
    );
  });

  it('rejects when the companion is below the price threshold', async () => {
    const svc = makeSvc();
    const apricot = productRow({
      id: 'apricot',
      name: 'Кайсии',
      requiresCompanion: true,
      companionMinPriceStotinki: 1000, // 10.00 €
    });
    const cheap = productRow({ id: 'cheap', name: 'Магданоз', priceStotinki: 500 });
    const tx = makeTx([[apricot, cheap], []]);
    const items = [
      { productId: 'apricot', quantity: 1 },
      { productId: 'cheap', quantity: 1 },
    ];

    await expect(
      (svc as any).reserveCartItems(tx, TENANT_ID, items, null),
    ).rejects.toThrow(BadRequestException);
    const tx2 = makeTx([[apricot, cheap], []]);
    await expect((svc as any).reserveCartItems(tx2, TENANT_ID, items, null)).rejects.toThrow(
      /10,00/,
    );
  });

  it('passes when a companion meets the price threshold', async () => {
    const svc = makeSvc();
    const apricot = productRow({
      id: 'apricot',
      name: 'Кайсии',
      requiresCompanion: true,
      companionMinPriceStotinki: 1000,
    });
    const expensive = productRow({ id: 'p2', name: 'Мед', priceStotinki: 1500 });
    const tx = makeTx([[apricot, expensive], [], []]);
    const items = [
      { productId: 'apricot', quantity: 1 },
      { productId: 'p2', quantity: 1 },
    ];

    const res = await (svc as any).reserveCartItems(tx, TENANT_ID, items, null);
    expect(res.items).toHaveLength(2);
  });

  it('passes with any companion when no threshold is set', async () => {
    const svc = makeSvc();
    const apricot = productRow({
      id: 'apricot',
      name: 'Кайсии',
      requiresCompanion: true,
      companionMinPriceStotinki: null,
    });
    const other = productRow({ id: 'other', name: 'Домати', priceStotinki: 100 });
    const tx = makeTx([[apricot, other], [], []]);
    const items = [
      { productId: 'apricot', quantity: 1 },
      { productId: 'other', quantity: 1 },
    ];

    const res = await (svc as any).reserveCartItems(tx, TENANT_ID, items, null);
    expect(res.items).toHaveLength(2);
  });

  it('passes when two distinct requiresCompanion products satisfy each other', async () => {
    const svc = makeSvc();
    const a = productRow({
      id: 'a',
      name: 'Кайсии',
      requiresCompanion: true,
      companionMinPriceStotinki: 500,
      priceStotinki: 1000,
    });
    const b = productRow({
      id: 'b',
      name: 'Праскови',
      requiresCompanion: true,
      companionMinPriceStotinki: 800,
      priceStotinki: 900,
    });
    const tx = makeTx([[a, b], [], []]);
    const items = [
      { productId: 'a', quantity: 1 },
      { productId: 'b', quantity: 1 },
    ];

    const res = await (svc as any).reserveCartItems(tx, TENANT_ID, items, null);
    expect(res.items).toHaveLength(2);
  });

  it('rejects two units of the SAME requiresCompanion product (companion must be a different product)', async () => {
    const svc = makeSvc();
    const apricot = productRow({ id: 'apricot', name: 'Кайсии', requiresCompanion: true });
    const tx = makeTx([[apricot], []]);
    const items = [{ productId: 'apricot', quantity: 2 }];

    await expect(
      (svc as any).reserveCartItems(tx, TENANT_ID, items, null),
    ).rejects.toThrow(BadRequestException);
  });
});
