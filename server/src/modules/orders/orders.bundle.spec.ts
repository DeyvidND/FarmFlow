/**
 * Integration tests for basket („кошница") checkout — Task 4: OrdersService.create()
 * / createCourierOrders() must explode a `category:'bundle'` product into one
 * priced parent order_items row plus zero-priced child rows (one per member,
 * `bundleParentId` pointing at the parent), and must enforce/decrement stock
 * against the MEMBER products, never the basket's own (nonexistent) stock.
 *
 * Mock style is modelled on orders.service.spec.ts's `makeTxSelect` (a per-call
 * positional queue over `tx.select()`, each terminal method — `.where()`,
 * `.where().orderBy()`, `.where().for().orderBy()` — resolving to that call's
 * canned rows) plus orders.courier.spec.ts's technique of spying on the private
 * `reserveCartItems` for tests that only care about a caller-side guard.
 *
 * Genuineness of the stock assertions: the availability-window rows are shared
 * MUTABLE objects (`winsByProduct` in the service references the very same
 * objects the mock's SELECT returns, then mutates `.remaining` in place — this
 * mirrors production, where `activeWindows` rows are mutated before the
 * set-based UPDATE). `remainingOf()` reads that same object, so it reports the
 * REAL effect of whichever product ids the enforcement loop actually iterated
 * over. The basket product is ALSO given its own window (`basketStart`) even
 * though a real basket never carries stock — this is what makes "untouched"
 * assertion non-vacuous: if the code regressed to iterating raw cart lines
 * instead of the expanded member lines, the loop would key off the basket's id,
 * find that (fixture-only) window, and decrement IT instead of the members' —
 * flipping both the "members decremented" and "basket untouched" assertions.
 * (Verified by hand: reverting the `stockLines` swap in reserveCartItems's
 * enforcement loop back to `dtoItems` turns this file's decrement/pooling tests
 * red, as required.)
 */
import { OrdersService } from './orders.service';

const TENANT_ID = 'tenant-1';

const basketId = 'basket-1';
const tomatoId = 'tomato-1';
const cheeseId = 'cheese-1';
const emptyBasketId = 'basket-empty';
const singleFarmerBasketId = 'basket-single-farmer';

const tomatoStart = 20;
const cheeseStart = 20;
const basketStart = 7; // a spurious window on the basket's OWN id — must stay untouched

function productRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'p',
    tenantId: TENANT_ID,
    name: 'Продукт',
    category: 'produce',
    isActive: true,
    courierDisabled: false,
    requiresCompanion: false,
    companionMinPriceStotinki: null,
    priceStotinki: 100,
    weight: null,
    salePercent: null,
    saleEndsAt: null,
    salePriceStotinki: null,
    farmerId: null,
    ...over,
  };
}

const TENANT = {
  id: TENANT_ID,
  farmLat: null,
  farmLng: null,
  subscriptionStatus: 'active',
  settings: {
    delivery: {
      econt: { mode: 'auto' },
      speedy: { configured: true },
      methods: {
        econtAddress: { enabled: true },
        pickup: { enabled: true },
        econtOffice: { enabled: false },
        ownSlots: { enabled: true },
      },
    },
  },
  deliveryEnabled: true,
  deliveriesPackageEnabled: true,
};

const base = {
  deliveryType: 'pickup' as const,
  paymentMethod: 'cod' as const,
  customerName: 'Иван',
  customerPhone: '0888000000',
};

const courierBase = {
  deliveryType: 'econt_address' as const,
  paymentMethod: 'cod' as const,
  customerName: 'Иван',
  customerPhone: '0888000000',
  deliveryAddress: 'ул. Тест 1',
  deliveryCity: 'София',
  carrier: 'econt' as const,
};

/** A chainable terminal: awaitable directly, and also supports the
 *  `.orderBy()` / `.for().orderBy()` / `.for().limit()` / `.limit()` shapes
 *  used by the different selects inside reserveCartItems(). */
function chainOf(result: unknown[]) {
  const c: any = {};
  c.from = jest.fn(() => c);
  const term: any = Promise.resolve(result);
  term.orderBy = jest.fn(() => Promise.resolve(result));
  term.limit = jest.fn(() => Promise.resolve(result));
  term.for = jest.fn(() => {
    const c2: any = {};
    c2.orderBy = jest.fn(() => Promise.resolve(result));
    c2.limit = jest.fn(() => Promise.resolve(result));
    return c2;
  });
  c.where = jest.fn(() => term);
  c.limit = jest.fn(() => Promise.resolve(result));
  return c;
}

/** Positional queue over tx.select() calls — each call gets the next canned
 *  result array in `seq`, in the exact order reserveCartItems()/create() issue
 *  their selects. Extra calls beyond the seq return []. */
function makeTxSelectSeq(seq: unknown[][]) {
  let idx = 0;
  return jest.fn(() => {
    const result = seq[idx] ?? [];
    idx++;
    return chainOf(result);
  });
}

/** tx.insert(): call 0 = orders, call 1 = orderItems parent pass, call 2 (if
 *  any) = orderItems child pass. Echoes each row back with a generated `id`,
 *  defaulting `bundleParentId` to null so a plain (non-child) row round-trips
 *  the same way a real nullable column would. */
function makeTxInsert(capture: { orders: any[]; itemCalls: any[][] }) {
  let call = 0;
  return jest.fn(() => {
    const idx = call++;
    const c: any = {};
    c.values = jest.fn((v: any) => {
      if (idx === 0) capture.orders.push(v);
      else capture.itemCalls.push(v);
      return c;
    });
    c.returning = jest.fn(() => {
      if (idx === 0) {
        return Promise.resolve([{ id: 'order-1', tenantId: TENANT_ID, orderNumber: 1, totalStotinki: 0 }]);
      }
      const rows = capture.itemCalls[capture.itemCalls.length - 1] as any[];
      // `...row` comes LAST so an explicitly supplied id wins — the service now
      // generates parent-row ids itself rather than reading them back, and
      // RETURNING echoes the row that was actually inserted. Synthesizing an id
      // here would overwrite the real one and hide a mislinked child.
      return Promise.resolve(rows.map((row, i) => ({ bundleParentId: null, id: `item-${idx}-${i}`, ...row })));
    });
    return c;
  });
}

/** Builds the tx handed to db.transaction()'s callback. `selectSeq` must match,
 *  in order, exactly the selects reserveCartItems()/create() will issue for the
 *  scenario under test (see file header). */
function makeTx(selectSeq: unknown[][], insertCapture: { orders: any[]; itemCalls: any[][] }) {
  return {
    select: makeTxSelectSeq(selectSeq),
    insert: makeTxInsert(insertCapture),
    update: jest.fn(() => ({ set: jest.fn(() => ({ where: jest.fn(() => Promise.resolve([])) })) })),
    execute: jest.fn(() => Promise.resolve([])),
  };
}

function makeDb(tx: unknown) {
  return {
    // create() is always called with preloadedTenant in these tests, so this
    // outer select should never fire; throwing surfaces a wrong assumption
    // immediately instead of silently returning garbage.
    select: jest.fn(() => {
      throw new Error('unexpected outer db.select() — expected preloadedTenant to skip it');
    }),
    transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  };
}

function makeSvc(db: unknown) {
  return new OrdersService(
    db as never,
    { geocode: jest.fn(), geocodeCity: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { invalidate: jest.fn() } as never,
  );
}

/** One basket's link rows (product_bundle_items), in position order. */
function links(bundleId: string, members: { productId: string; quantity: number }[]) {
  return members.map((m) => ({ bundleId, productId: m.productId, quantity: m.quantity }));
}

/** Builds the exact tx.select() sequence reserveCartItems()/create() issue for
 *  a cart of `cartProducts`, given `bundleLinks` (flat link rows across every
 *  basket in the cart) and `memberProducts` (the live member product rows).
 *  `windows` is the canned availability-windows response (shared MUTABLE
 *  objects the caller can inspect after the call). */
function buildSelectSeq(opts: {
  cartProducts: any[];
  bundleLinks: any[];
  memberProducts: any[];
  windows: any[];
  reachesNextNumber: boolean;
}) {
  const seq: unknown[][] = [opts.cartProducts, []]; // products(cart), productVariants(existence)
  const cartHasBasket = opts.cartProducts.some((p) => p.category === 'bundle');
  if (cartHasBasket) {
    seq.push(opts.bundleLinks); // productBundleItems(links)
    if (opts.bundleLinks.length) seq.push(opts.memberProducts); // products(members)
  }
  seq.push(opts.windows); // productAvailabilityWindows
  if (opts.reachesNextNumber) seq.push([{ nextNumber: 1 }]); // orders(nextNumber)
  return seq;
}

/** A mutable availability-window row. */
function windowRow(productId: string, remaining: number) {
  return { id: `win-${productId}`, productId, remaining };
}

describe('basket checkout', () => {
  it('writes a parent line at the basket price plus zero-priced child lines', async () => {
    const tomatoWin = windowRow(tomatoId, tomatoStart);
    const cheeseWin = windowRow(cheeseId, cheeseStart);
    const basketWin = windowRow(basketId, basketStart);
    const cartProducts = [productRow({ id: basketId, name: 'Кошница', category: 'bundle', priceStotinki: 3990 })];
    const bundleLinks = links(basketId, [
      { productId: tomatoId, quantity: 2 },
      { productId: cheeseId, quantity: 1 },
    ]);
    const memberProducts = [
      productRow({ id: tomatoId, name: 'Домати' }),
      productRow({ id: cheeseId, name: 'Сирене' }),
    ];
    const seq = buildSelectSeq({
      cartProducts,
      bundleLinks,
      memberProducts,
      windows: [tomatoWin, cheeseWin, basketWin],
      reachesNextNumber: true,
    });
    const insertCapture = { orders: [] as any[], itemCalls: [] as any[][] };
    const tx = makeTx(seq, insertCapture);
    const svc = makeSvc(makeDb(tx));

    const order = await svc.create(
      'test-farm',
      { ...base, items: [{ productId: basketId, quantity: 1 }] } as never,
      TENANT as never,
    );

    const parent = (order.items as any[]).find((i) => i.productId === basketId)!;
    expect(parent.priceStotinki).toBe(3990);
    expect(parent.bundleParentId).toBeNull();
    const children = (order.items as any[]).filter((i) => i.bundleParentId === parent.id);
    expect(children.map((c) => [c.productId, c.quantity, c.priceStotinki])).toEqual([
      [tomatoId, 2, 0],
      [cheeseId, 1, 0],
    ]);
  });

  it('leaves the order total equal to the basket price', async () => {
    const tomatoWin = windowRow(tomatoId, tomatoStart);
    const cheeseWin = windowRow(cheeseId, cheeseStart);
    const cartProducts = [productRow({ id: basketId, name: 'Кошница', category: 'bundle', priceStotinki: 3990 })];
    const bundleLinks = links(basketId, [
      { productId: tomatoId, quantity: 2 },
      { productId: cheeseId, quantity: 1 },
    ]);
    const memberProducts = [productRow({ id: tomatoId, name: 'Домати' }), productRow({ id: cheeseId, name: 'Сирене' })];
    const seq = buildSelectSeq({
      cartProducts,
      bundleLinks,
      memberProducts,
      windows: [tomatoWin, cheeseWin],
      reachesNextNumber: true,
    });
    const insertCapture = { orders: [] as any[], itemCalls: [] as any[][] };
    const tx = makeTx(seq, insertCapture);
    const svc = makeSvc(makeDb(tx));

    const order = await svc.create(
      'test-farm',
      { ...base, items: [{ productId: basketId, quantity: 2 }] } as never,
      TENANT as never,
    );

    const total = (order.items as any[]).reduce((s, i) => s + i.quantity * i.priceStotinki, 0);
    expect(total).toBe(7980); // 2 × 3990
  });

  it('decrements member stock, not the basket product', async () => {
    const tomatoWin = windowRow(tomatoId, tomatoStart);
    const cheeseWin = windowRow(cheeseId, cheeseStart);
    const basketWin = windowRow(basketId, basketStart);
    const cartProducts = [productRow({ id: basketId, name: 'Кошница', category: 'bundle', priceStotinki: 3990 })];
    const bundleLinks = links(basketId, [
      { productId: tomatoId, quantity: 2 },
      { productId: cheeseId, quantity: 1 },
    ]);
    const memberProducts = [productRow({ id: tomatoId, name: 'Домати' }), productRow({ id: cheeseId, name: 'Сирене' })];
    const seq = buildSelectSeq({
      cartProducts,
      bundleLinks,
      memberProducts,
      windows: [tomatoWin, cheeseWin, basketWin],
      reachesNextNumber: true,
    });
    const insertCapture = { orders: [] as any[], itemCalls: [] as any[][] };
    const tx = makeTx(seq, insertCapture);
    const svc = makeSvc(makeDb(tx));

    await svc.create(
      'test-farm',
      { ...base, items: [{ productId: basketId, quantity: 3 }] } as never,
      TENANT as never,
    );

    expect(tomatoWin.remaining).toBe(tomatoStart - 6); // 2 per basket × 3
    expect(basketWin.remaining).toBe(basketStart); // untouched — the basket carries no stock of its own
  });

  it('pools a product ordered both loose and inside a basket', async () => {
    const tomatoWin = windowRow(tomatoId, tomatoStart);
    const cheeseWin = windowRow(cheeseId, cheeseStart);
    const cartProducts = [
      productRow({ id: tomatoId, name: 'Домати' }),
      productRow({ id: basketId, name: 'Кошница', category: 'bundle', priceStotinki: 3990 }),
    ];
    const bundleLinks = links(basketId, [
      { productId: tomatoId, quantity: 2 },
      { productId: cheeseId, quantity: 1 },
    ]);
    const memberProducts = [productRow({ id: tomatoId, name: 'Домати' }), productRow({ id: cheeseId, name: 'Сирене' })];
    const seq = buildSelectSeq({
      cartProducts,
      bundleLinks,
      memberProducts,
      windows: [tomatoWin, cheeseWin],
      reachesNextNumber: true,
    });
    const insertCapture = { orders: [] as any[], itemCalls: [] as any[][] };
    const tx = makeTx(seq, insertCapture);
    const svc = makeSvc(makeDb(tx));

    await svc.create(
      'test-farm',
      {
        ...base,
        items: [
          { productId: tomatoId, quantity: 1 },
          { productId: basketId, quantity: 1 },
        ],
      } as never,
      TENANT as never,
    );

    expect(tomatoWin.remaining).toBe(tomatoStart - 3); // 1 loose + 2 from the basket, pooled into ONE check
  });

  it('rejects the order when a member is sold out', async () => {
    const tomatoWin = windowRow(tomatoId, 1); // only 1 left; the basket needs 2
    const cheeseWin = windowRow(cheeseId, cheeseStart);
    const cartProducts = [productRow({ id: basketId, name: 'Кошница', category: 'bundle', priceStotinki: 3990 })];
    const bundleLinks = links(basketId, [
      { productId: tomatoId, quantity: 2 },
      { productId: cheeseId, quantity: 1 },
    ]);
    const memberProducts = [productRow({ id: tomatoId, name: 'Домати' }), productRow({ id: cheeseId, name: 'Сирене' })];
    const seq = buildSelectSeq({
      cartProducts,
      bundleLinks,
      memberProducts,
      windows: [tomatoWin, cheeseWin],
      reachesNextNumber: false, // throws before ever reaching nextNumber
    });
    const insertCapture = { orders: [] as any[], itemCalls: [] as any[][] };
    const tx = makeTx(seq, insertCapture);
    const svc = makeSvc(makeDb(tx));

    await expect(
      svc.create(
        'test-farm',
        { ...base, items: [{ productId: basketId, quantity: 1 }] } as never,
        TENANT as never,
      ),
    ).rejects.toThrow('Няма достатъчна наличност');
  });

  it('rejects a basket with no live members', async () => {
    const cartProducts = [productRow({ id: emptyBasketId, name: 'Празна кошница', category: 'bundle', priceStotinki: 1000 })];
    const seq = buildSelectSeq({
      cartProducts,
      bundleLinks: [], // no product_bundle_items rows at all for this basket
      memberProducts: [],
      windows: [],
      reachesNextNumber: false,
    });
    const insertCapture = { orders: [] as any[], itemCalls: [] as any[][] };
    const tx = makeTx(seq, insertCapture);
    const svc = makeSvc(makeDb(tx));

    await expect(
      svc.create(
        'test-farm',
        { ...base, items: [{ productId: emptyBasketId, quantity: 1 }] } as never,
        TENANT as never,
      ),
    ).rejects.toThrow('вече не е налична');
  });

  it('blocks courier delivery for a basket with a clear message', async () => {
    // The bundleKey guard in createCourierOrders operates purely on reserveCartItems'
    // OUTPUT (a parent PreparedItem carries a bundleKey) — spy it directly, per
    // orders.courier.spec.ts's established technique, rather than re-mocking the
    // whole basket-expansion machinery already exercised by the tests above.
    const tx = { select: jest.fn(), insert: jest.fn(), update: jest.fn(), execute: jest.fn() };
    const db = {
      select: jest.fn(() => {
        const c: any = {};
        c.from = jest.fn(() => c);
        c.where = jest.fn(() => c);
        c.limit = jest.fn(() => Promise.resolve([TENANT]));
        return c;
      }),
      transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    };
    const svc = makeSvc(db);
    jest.spyOn(svc as any, 'reserveCartItems').mockResolvedValue({
      items: [
        {
          productId: basketId,
          productName: 'Кошница',
          quantity: 1,
          priceStotinki: 3990,
          variantId: null,
          variantLabel: null,
          farmerId: null,
          bundleKey: 'b0',
          bundleParentKey: null,
        },
      ],
      slotFrom: null,
      slotTo: null,
      slotDate: null,
      variantStockTouched: false,
    });

    await expect(
      svc.createCourierOrders('test-farm', { items: [{ productId: basketId, quantity: 1 }], ...courierBase } as never),
    ).rejects.toThrow('Кошниците се получават на място или с доставка от фермата');
  });

  it('blocks courier delivery when a member is pickup-only', async () => {
    const tomatoWin = windowRow(tomatoId, tomatoStart);
    const cartProducts = [
      productRow({ id: singleFarmerBasketId, name: 'Кошница сирене', category: 'bundle', priceStotinki: 1500 }),
    ];
    const bundleLinks = links(singleFarmerBasketId, [{ productId: cheeseId, quantity: 1 }]);
    const memberProducts = [productRow({ id: cheeseId, name: 'Сирене', courierDisabled: true })];
    const seq = buildSelectSeq({
      cartProducts,
      bundleLinks,
      memberProducts,
      windows: [tomatoWin], // never reached — the courier check throws first
      reachesNextNumber: false,
    });
    const insertCapture = { orders: [] as any[], itemCalls: [] as any[][] };
    const tx = makeTx(seq, insertCapture);
    const svc = makeSvc(makeDb(tx));

    await expect(
      svc.create(
        'test-farm',
        { ...courierBase, items: [{ productId: singleFarmerBasketId, quantity: 1 }] } as never,
        TENANT as never,
      ),
    ).rejects.toThrow('не се изпращат с куриер');
  });

  it('refuses to edit an order containing a basket', async () => {
    // Standalone unit test of the updateOrder guard (Step 9b) — reuses the real
    // shape of an already-created basket order (parent + child row with
    // bundleParentId set), fed straight in as `oldItems`, rather than routing
    // through a fresh service.create() call: the guard only reads `oldItems`, so
    // this exercises exactly the same condition with a far smaller harness.
    const oldItems = [
      { id: 'item-1', orderId: 'order-1', productId: basketId, productName: 'Кошница', quantity: 1, priceStotinki: 3990, variantId: null, variantLabel: null, bundleParentId: null },
      { id: 'item-2', orderId: 'order-1', productId: tomatoId, productName: 'Домати', quantity: 2, priceStotinki: 0, variantId: null, variantLabel: null, bundleParentId: 'item-1' },
    ];
    const orderRow = {
      id: 'order-1',
      tenantId: TENANT_ID,
      status: 'confirmed',
      paidAt: null,
      codOutcome: null,
      deliveryType: 'pickup',
      totalStotinki: 3990,
      slotId: null,
      slotFrom: null,
      slotTo: null,
      slotDate: null,
    };
    const orderChain: any = {};
    orderChain.from = () => orderChain;
    orderChain.leftJoin = () => orderChain;
    orderChain.where = () => orderChain;
    orderChain.limit = () => Promise.resolve([orderRow]);

    let txSelectCall = 0;
    const db: any = {
      select: jest.fn(() => orderChain),
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx: any = {
          select: jest.fn(() => {
            const call = txSelectCall++;
            if (call === 0) {
              // the FOR UPDATE order-row lock taken first
              return { from: () => ({ where: () => ({ for: () => ({ limit: () => Promise.resolve([{ paidAt: null, codOutcome: null }]) }) }) }) };
            }
            // call 1: oldItems
            return { from: () => ({ where: () => Promise.resolve(oldItems) }) };
          }),
        };
        return fn(tx);
      }),
    };
    const svc = makeSvc(db);
    jest.spyOn(svc, 'findOne').mockResolvedValue({} as any);

    await expect(
      svc.updateOrder('order-1', TENANT_ID, { items: [{ productId: tomatoId, quantity: 1 }] } as never),
    ).rejects.toThrow('Поръчка с кошница не може да се редактира');
  });
});
