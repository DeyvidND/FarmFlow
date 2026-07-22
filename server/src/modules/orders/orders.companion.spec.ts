/**
 * Unit test for the companion-product rule inside OrdersService.reserveCartItems().
 * A product flagged `requiresCompanion` cannot be ordered alone. When
 * `companionMinPriceStotinki` is set, the OTHER products in the cart must TOTAL at
 * least the threshold (sum of unit × qty over every different-product line — a
 * basket of cheaper goods qualifies, not just one expensive item). When no
 * threshold is set, any one other distinct product suffices.
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

  it('passes when several cheaper OTHER products TOTAL the threshold (loss-leader basket)', async () => {
    // The point of the sum rule: cheap „кайсии" (min 10.00) can leave once the
    // rest of the basket totals >= 10.00, even if no single item reaches it.
    const svc = makeSvc();
    const apricot = productRow({
      id: 'apricot',
      name: 'Кайсии',
      requiresCompanion: true,
      companionMinPriceStotinki: 1000, // 10.00 €
      priceStotinki: 150,
    });
    const tomato = productRow({ id: 'tomato', name: 'Домати', priceStotinki: 400 });
    const parsley = productRow({ id: 'parsley', name: 'Магданоз', priceStotinki: 300 });
    const tx = makeTx([[apricot, tomato, parsley], [], []]);
    // 400×1 + 300×2 = 1000 >= 1000 → satisfied (no single item reaches the threshold).
    const items = [
      { productId: 'apricot', quantity: 1 },
      { productId: 'tomato', quantity: 1 },
      { productId: 'parsley', quantity: 2 },
    ];

    const res = await (svc as any).reserveCartItems(tx, TENANT_ID, items, null);
    expect(res.items).toHaveLength(3);
  });

  it('rejects when the OTHER products total below the threshold', async () => {
    const svc = makeSvc();
    const apricot = productRow({
      id: 'apricot',
      name: 'Кайсии',
      requiresCompanion: true,
      companionMinPriceStotinki: 1000,
      priceStotinki: 150,
    });
    const tomato = productRow({ id: 'tomato', name: 'Домати', priceStotinki: 400 });
    const tx = makeTx([[apricot, tomato], []]);
    // 400×2 = 800 < 1000 → rejected, and the message names the total wording.
    const items = [
      { productId: 'apricot', quantity: 1 },
      { productId: 'tomato', quantity: 2 },
    ];

    await expect(
      (svc as any).reserveCartItems(tx, TENANT_ID, items, null),
    ).rejects.toThrow(/обща стойност поне 10,00/);
  });

  // Finding #6: a requiresCompanion product hidden INSIDE a basket (never its
  // own dtoItems cart line) was previously invisible to this whole check —
  // `companionRequirers` only ever scanned literal dtoItems. These two tests
  // exercise the basket path: `stockLines`/`memberById` (already computed for
  // the courier pickup-only backstop) now feed the same rule.
  it('rejects a basket whose ONLY member requires a companion (loss-leader hidden in a single-member basket)', async () => {
    const svc = makeSvc();
    const apricot = productRow({ id: 'apricot', name: 'Кайсии', requiresCompanion: true, category: 'produce' });
    const basket = productRow({ id: 'basket-1', name: 'Кошница', category: 'bundle', priceStotinki: 300 });
    const tx = makeTx([
      [basket], // products (cart)
      [], // productsWithVariants
      [{ bundleId: 'basket-1', productId: 'apricot', quantity: 1 }], // productBundleItems links
      [apricot], // member products
    ]);
    const items = [{ productId: 'basket-1', quantity: 1 }];

    await expect(
      (svc as any).reserveCartItems(tx, TENANT_ID, items, null),
    ).rejects.toThrow(/самостоятелно/);
  });

  it('passes a basket pairing a requiresCompanion member with a normal sibling member', async () => {
    const svc = makeSvc();
    const apricot = productRow({ id: 'apricot', name: 'Кайсии', requiresCompanion: true, category: 'produce' });
    const cheese = productRow({ id: 'cheese', name: 'Сирене', category: 'produce', priceStotinki: 600 });
    const basket = productRow({ id: 'basket-1', name: 'Кошница', category: 'bundle', priceStotinki: 900 });
    const tx = makeTx([
      [basket], // products (cart)
      [], // productsWithVariants
      [
        { bundleId: 'basket-1', productId: 'apricot', quantity: 1 },
        { bundleId: 'basket-1', productId: 'cheese', quantity: 1 },
      ], // productBundleItems links
      [apricot, cheese], // member products
      [], // productAvailabilityWindows
    ]);
    const items = [{ productId: 'basket-1', quantity: 1 }];

    const res = await (svc as any).reserveCartItems(tx, TENANT_ID, items, null);
    // The basket parent line plus its two exploded child lines (see order-bundle.util.ts).
    expect(res.items).toHaveLength(3);
  });

  it('rejects a basket whose sole other member fails a price threshold (sum of siblings, not the basket price)', async () => {
    const svc = makeSvc();
    const apricot = productRow({
      id: 'apricot', name: 'Кайсии', requiresCompanion: true,
      companionMinPriceStotinki: 1000, category: 'produce', priceStotinki: 150,
    });
    const parsley = productRow({ id: 'parsley', name: 'Магданоз', category: 'produce', priceStotinki: 300 });
    const basket = productRow({ id: 'basket-1', name: 'Кошница', category: 'bundle', priceStotinki: 400 });
    const tx = makeTx([
      [basket],
      [],
      [
        { bundleId: 'basket-1', productId: 'apricot', quantity: 1 },
        { bundleId: 'basket-1', productId: 'parsley', quantity: 1 },
      ],
      [apricot, parsley],
    ]);
    const items = [{ productId: 'basket-1', quantity: 1 }];

    // 300×1 = 300 < 1000 → rejected, same threshold wording as the top-level case.
    await expect(
      (svc as any).reserveCartItems(tx, TENANT_ID, items, null),
    ).rejects.toThrow(/обща стойност поне 10,00/);
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
