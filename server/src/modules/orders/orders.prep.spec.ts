import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrdersService, applyRouteOrder } from './orders.service';
import type { TomorrowOrder } from './orders.service';

/**
 * OrdersService.prepOrders / setFulfillment (Task #14). Mirrors the
 * mocking style of orders.mine.spec.ts (ordersForFarmer): a chainable select
 * stub resolving off the final `.orderBy()`/`.limit()` call.
 */
describe('OrdersService.prepOrders', () => {
  function makeSvc(rows: unknown[]) {
    const chain: any = {};
    chain.select = jest.fn(() => chain);
    chain.from = jest.fn(() => chain);
    chain.innerJoin = jest.fn(() => chain);
    chain.leftJoin = jest.fn(() => chain);
    chain.where = jest.fn(() => chain);
    chain.orderBy = jest.fn(() => Promise.resolve(rows));
    const svc = new OrdersService(
      chain as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
    );
    return { svc };
  }

  it('groups line items into one order per orderId, defaulting fulfillmentState to pending when no row exists', async () => {
    const { svc } = makeSvc([
      {
        orderId: 'o1', orderNumber: 5, customerName: 'Мария', customerPhone: '0888111222',
        customerEmail: 'maria@example.com', deliveryType: 'address', day: '2026-07-14',
        slotFrom: '10:00:00', slotTo: '12:00:00', state: null,
        productId: 'p1', productName: 'Домати', quantity: 3,
      },
      {
        orderId: 'o1', orderNumber: 5, customerName: 'Мария', customerPhone: '0888111222',
        customerEmail: 'maria@example.com', deliveryType: 'address', day: '2026-07-14',
        slotFrom: '10:00:00', slotTo: '12:00:00', state: null,
        productId: 'p2', productName: 'Краставици', quantity: 2,
      },
    ]);
    const result = await svc.prepOrders('t', 'farmer-1', '2026-07-14');
    expect(result).toHaveLength(1);
    expect(result[0].fulfillmentState).toBe('pending');
    expect(result[0].items).toHaveLength(2);
    expect(result[0].customerPhone).toBe('0888111222');
    // Scoped call stamps the CALLER's farmerId (the passthrough mock rows carry
    // no farmerId field at all — the real query wouldn't need to project it for
    // a scoped call since it's already known).
    expect(result[0].farmerId).toBe('farmer-1');
  });

  it('surfaces a non-default fulfillmentState from order_fulfillments', async () => {
    const { svc } = makeSvc([
      {
        orderId: 'o2', orderNumber: 6, customerName: 'Иван', customerPhone: null,
        customerEmail: null, deliveryType: 'pickup', day: '2026-07-20',
        slotFrom: null, slotTo: null, state: 'in_production',
        productId: 'p1', productName: 'Мед', quantity: 1,
      },
    ]);
    const result = await svc.prepOrders('t', 'farmer-1', '2026-07-20');
    expect(result[0].fulfillmentState).toBe('in_production');
  });

  it('accepts an arbitrary date and still returns an empty list with no rows', async () => {
    const { svc } = makeSvc([]);
    const result = await svc.prepOrders('t', 'farmer-1', '2026-08-01');
    expect(result).toEqual([]);
  });

  it('defaults to tomorrow when no date is passed (no throw)', async () => {
    const { svc } = makeSvc([]);
    const result = await svc.prepOrders('t', 'farmer-1');
    expect(result).toEqual([]);
  });

  // Tenant-wide («Всички», farmerId null): collapses what used to be N per-farmer
  // HTTP calls into one — rows now carry their own product's farmerId, and the
  // grouping key becomes (order, farmer) instead of plain order id.
  it('tenant-wide: a shared order across two farmers comes back as TWO slices, each with only that farmer\'s items and own fulfillment state', async () => {
    const { svc } = makeSvc([
      {
        orderId: 'o1', orderNumber: 9, customerName: 'Обединена поръчка', customerPhone: '0888000000',
        customerEmail: null, deliveryType: 'address', day: '2026-07-16',
        slotFrom: null, slotTo: null, state: 'fulfilled', farmerId: 'farmer-A',
        productId: 'pA', productName: 'Домати', variantLabel: null, quantity: 2,
      },
      {
        orderId: 'o1', orderNumber: 9, customerName: 'Обединена поръчка', customerPhone: '0888000000',
        customerEmail: null, deliveryType: 'address', day: '2026-07-16',
        slotFrom: null, slotTo: null, state: null, farmerId: 'farmer-B',
        productId: 'pB', productName: 'Мед', variantLabel: null, quantity: 1,
      },
    ]);
    const result = await svc.prepOrders('t', null, '2026-07-16');
    expect(result).toHaveLength(2);

    const a = result.find((o) => o.farmerId === 'farmer-A')!;
    const b = result.find((o) => o.farmerId === 'farmer-B')!;
    expect(a.id).toBe('o1');
    expect(b.id).toBe('o1');
    expect(a.items).toEqual([{ productId: 'pA', productName: 'Домати', variantLabel: null, quantity: 2 }]);
    expect(b.items).toEqual([{ productId: 'pB', productName: 'Мед', variantLabel: null, quantity: 1 }]);
    // Each slice's own order_fulfillments state — farmer A already marked
    // fulfilled; farmer B's own row is absent (defaults to 'pending'), even
    // though it's the SAME order.
    expect(a.fulfillmentState).toBe('fulfilled');
    expect(b.fulfillmentState).toBe('pending');
  });

  it('tenant-wide: two independent single-farmer orders stay two separate slices, not merged', async () => {
    const { svc } = makeSvc([
      {
        orderId: 'o2', orderNumber: 10, customerName: 'Х', customerPhone: null,
        customerEmail: null, deliveryType: 'pickup', day: '2026-07-16',
        slotFrom: null, slotTo: null, state: null, farmerId: 'farmer-A',
        productId: 'p1', productName: 'Ябълки', variantLabel: null, quantity: 1,
      },
      {
        orderId: 'o3', orderNumber: 11, customerName: 'Y', customerPhone: null,
        customerEmail: null, deliveryType: 'pickup', day: '2026-07-16',
        slotFrom: null, slotTo: null, state: null, farmerId: 'farmer-B',
        productId: 'p2', productName: 'Круши', variantLabel: null, quantity: 1,
      },
    ]);
    const result = await svc.prepOrders('t', null, '2026-07-16');
    expect(result.map((o) => o.id).sort()).toEqual(['o2', 'o3']);
    expect(result.map((o) => o.farmerId).sort()).toEqual(['farmer-A', 'farmer-B']);
  });
});

describe('OrdersService.setFulfillment', () => {
  function makeSvc(ownsRow: unknown[] | undefined) {
    const selectChain: any = {};
    selectChain.select = jest.fn(() => selectChain);
    selectChain.from = jest.fn(() => selectChain);
    selectChain.innerJoin = jest.fn(() => selectChain);
    selectChain.where = jest.fn(() => selectChain);
    selectChain.limit = jest.fn(() => Promise.resolve(ownsRow ?? []));

    const onConflictSpy = jest.fn().mockResolvedValue(undefined);
    const valuesSpy = jest.fn(() => ({ onConflictDoUpdate: onConflictSpy }));
    const insertChain: any = {};
    insertChain.insert = jest.fn(() => insertChain);
    insertChain.values = valuesSpy;

    const db: any = {};
    db.select = jest.fn(() => selectChain);
    db.insert = jest.fn(() => insertChain);

    const svc = new OrdersService(
      db as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
    );
    return { svc, valuesSpy, onConflictSpy };
  }

  it('upserts the fulfilment row when the farmer owns at least one item on the order', async () => {
    const { svc, valuesSpy, onConflictSpy } = makeSvc([{ id: 'item-1', status: 'confirmed' }]);
    const result = await svc.setFulfillment('o1', 't1', 'farmer-1', 'fulfilled');
    expect(result).toEqual({ orderId: 'o1', farmerId: 'farmer-1', state: 'fulfilled' });
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', orderId: 'o1', farmerId: 'farmer-1', state: 'fulfilled' }),
    );
    expect(onConflictSpy).toHaveBeenCalledWith(
      expect.objectContaining({ set: expect.objectContaining({ state: 'fulfilled' }) }),
    );
  });

  it('throws ForbiddenException when the farmer has NO items on the order (IDOR guard)', async () => {
    const { svc, valuesSpy } = makeSvc([]);
    await expect(svc.setFulfillment('o1', 't1', 'farmer-9', 'fulfilled')).rejects.toThrow(
      ForbiddenException,
    );
    expect(valuesSpy).not.toHaveBeenCalled();
  });

  it('throws BadRequestException self-marking fulfilment on a non-active order (e.g. cancelled)', async () => {
    const { svc, valuesSpy } = makeSvc([{ id: 'item-1', status: 'cancelled' }]);
    await expect(svc.setFulfillment('o1', 't1', 'farmer-1', 'fulfilled')).rejects.toThrow(
      BadRequestException,
    );
    expect(valuesSpy).not.toHaveBeenCalled();
  });
});

describe('OrdersService.prepSummary', () => {
  function makeSvc() {
    const svc = new OrdersService(
      {} as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
    );
    return { svc };
  }

  it('composes orders + counts, defaulting confirmedOrders to orders.length', async () => {
    const { svc } = makeSvc();
    const orders = [
      { id: 'o1', farmerId: 'farmer-1', orderNumber: 1, customerName: null, customerPhone: null, customerEmail: null,
        deliveryType: 'pickup', day: '2026-07-15', slotFrom: null, slotTo: null,
        fulfillmentState: 'pending' as const, items: [],
        routeSeq: null, courierIndex: null, courierName: null },
      { id: 'o2', farmerId: 'farmer-1', orderNumber: 2, customerName: null, customerPhone: null, customerEmail: null,
        deliveryType: 'pickup', day: '2026-07-15', slotFrom: null, slotTo: null,
        fulfillmentState: 'fulfilled' as const, items: [],
        routeSeq: null, courierIndex: null, courierName: null },
    ];
    jest.spyOn(svc, 'prepOrders').mockResolvedValue(orders);
    jest.spyOn(svc as never, 'pendingCountForFarmer' as never).mockResolvedValue(3 as never);

    const summary = await svc.prepSummary('t', 'farmer-1', '2026-07-15');
    expect(summary.date).toBe('2026-07-15');
    expect(summary.confirmedOrders).toBe(2);
    expect(summary.pendingOrders).toBe(3);
    expect(summary.orders).toBe(orders);
  });

  it('falls back to tomorrow for the date when none is passed', async () => {
    const { svc } = makeSvc();
    jest.spyOn(svc, 'prepOrders').mockResolvedValue([]);
    jest.spyOn(svc as never, 'pendingCountForFarmer' as never).mockResolvedValue(0 as never);
    const summary = await svc.prepSummary('t', 'farmer-1');
    expect(summary.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(summary.confirmedOrders).toBe(0);
  });
});

/**
 * OrdersService.prepForCourierLeg — a courier's packing list for their own
 * route leg. Unlike prepOrders (one farmer's own lines only, farmerId-scoped
 * WHERE), the caller already resolved the exact order ids on the driver's
 * leg (route-leg membership can't be a cheap WHERE — see the method's own
 * doc comment), so this is scoped by `inArray(orders.id, orderIds)` alone and
 * groups EVERY item regardless of which farmer grew it.
 */
describe('OrdersService.prepForCourierLeg', () => {
  function makeSvc(rows: unknown[]) {
    const chain: any = {};
    chain.select = jest.fn(() => chain);
    chain.from = jest.fn(() => chain);
    chain.innerJoin = jest.fn(() => chain);
    chain.leftJoin = jest.fn(() => chain);
    chain.where = jest.fn(() => chain);
    chain.orderBy = jest.fn(() => Promise.resolve(rows));
    const svc = new OrdersService(
      chain as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
    );
    return { svc, chain };
  }

  it('an empty orderIds list short-circuits to an empty summary — no query at all', async () => {
    const { svc, chain } = makeSvc([]);
    const result = await svc.prepForCourierLeg('t', [], '2026-07-16');
    expect(result).toEqual({ date: '2026-07-16', confirmedOrders: 0, pendingOrders: 0, orders: [] });
    expect(chain.select).not.toHaveBeenCalled();
  });

  it('groups every item onto its order regardless of farmer, always defaulting fulfillmentState to pending', async () => {
    const { svc } = makeSvc([
      {
        orderId: 'o1', orderNumber: 5, customerName: 'Мария', customerPhone: '0888111222',
        customerEmail: null, deliveryType: 'address', slotFrom: '10:00:00', slotTo: '12:00:00',
        productId: 'p1', productName: 'Домати (фермер А)', variantLabel: null, quantity: 3,
      },
      {
        orderId: 'o1', orderNumber: 5, customerName: 'Мария', customerPhone: '0888111222',
        customerEmail: null, deliveryType: 'address', slotFrom: '10:00:00', slotTo: '12:00:00',
        productId: 'p2', productName: 'Мед (фермер Б)', variantLabel: '1 кг', quantity: 1,
      },
    ]);
    const result = await svc.prepForCourierLeg('t', ['o1'], '2026-07-16');
    expect(result.date).toBe('2026-07-16');
    expect(result.confirmedOrders).toBe(1);
    expect(result.pendingOrders).toBe(0);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].fulfillmentState).toBe('pending');
    expect(result.orders[0].items).toEqual([
      { productId: 'p1', productName: 'Домати (фермер А)', variantLabel: null, quantity: 3 },
      { productId: 'p2', productName: 'Мед (фермер Б)', variantLabel: '1 кг', quantity: 1 },
    ]);
  });

  it('one summary row per order id, in query order', async () => {
    const { svc } = makeSvc([
      { orderId: 'o1', orderNumber: 1, customerName: null, customerPhone: null, customerEmail: null,
        deliveryType: 'address', slotFrom: null, slotTo: null,
        productId: 'p1', productName: 'Ябълки', variantLabel: null, quantity: 2 },
      { orderId: 'o2', orderNumber: 2, customerName: null, customerPhone: null, customerEmail: null,
        deliveryType: 'address', slotFrom: null, slotTo: null,
        productId: 'p2', productName: 'Круши', variantLabel: null, quantity: 4 },
    ]);
    const result = await svc.prepForCourierLeg('t', ['o1', 'o2'], '2026-07-16');
    expect(result.orders.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(result.confirmedOrders).toBe(2);
  });

  // Finding #7: a basket's own parent row has no products join / no basket
  // filter before this fix — the query returned BOTH the parent AND its
  // exploded children, which inflates aggregate.ts's totalQty (double-counts
  // the basket's contents) and offers the basket ITSELF as a pickable line —
  // a picker can't pick a basket, only its contents. Captured rather than
  // trusted, since the passthrough mock above returns whatever rows it's
  // told regardless of the real query's filtering.
  it('excludes a basket\'s own parent row from the packing-list WHERE clause', async () => {
    const { svc, chain } = makeSvc([]);
    await svc.prepForCourierLeg('t', ['o1'], '2026-07-16');

    function literalText(node: unknown): string {
      const n = node as { queryChunks?: unknown[]; value?: unknown } | null;
      if (!n || typeof n !== 'object') return '';
      if (Array.isArray(n.value) && n.value.every((v) => typeof v === 'string')) {
        return (n.value as string[]).join('');
      }
      if (Array.isArray(n.queryChunks)) return n.queryChunks.map(literalText).join('');
      return '';
    }
    const whereArg = (chain.where as jest.Mock).mock.calls[0][0];
    const rendered = literalText(whereArg);
    expect(rendered).toMatch(/bundle/i);
    expect(rendered).toMatch(/is null/i);
    // The exclusion needs products joined (category lives there) — the mock
    // chain must actually have been asked for one.
    expect((chain.innerJoin as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('applyRouteOrder', () => {
  const mk = (id: string, over: Partial<TomorrowOrder> = {}): TomorrowOrder => ({
    id,
    farmerId: null,
    orderNumber: null,
    customerName: null,
    customerPhone: null,
    customerEmail: null,
    deliveryType: 'address',
    day: '2026-07-16',
    slotFrom: null,
    slotTo: null,
    fulfillmentState: 'pending',
    items: [],
    routeSeq: null,
    courierIndex: null,
    courierName: null,
    ...over,
  });
  const route = {
    routes: [
      { courierIndex: 0, name: 'Иван', stops: [{ id: 'a' }, { id: 'b' }] },
      { courierIndex: 1, name: 'Васил', stops: [{ id: 'c' }] },
    ],
  };

  it('sorts to route order (leg then visit position) and stamps each order', () => {
    // Deliberately scrambled input.
    const out = applyRouteOrder([mk('c'), mk('a'), mk('b')], route);
    expect(out.map((o) => o.id)).toEqual(['a', 'b', 'c']);
    expect(out[0]).toMatchObject({ id: 'a', courierIndex: 0, routeSeq: 1, courierName: 'Иван' });
    expect(out[1]).toMatchObject({ id: 'b', courierIndex: 0, routeSeq: 2, courierName: 'Иван' });
    expect(out[2]).toMatchObject({ id: 'c', courierIndex: 1, routeSeq: 1, courierName: 'Васил' });
  });

  it('puts off-route orders (no matching stop) last, keeping their given order, with null route fields', () => {
    const out = applyRouteOrder([mk('pickup-2'), mk('c'), mk('pickup-1')], route);
    expect(out.map((o) => o.id)).toEqual(['c', 'pickup-2', 'pickup-1']);
    const c = out.find((o) => o.id === 'c')!;
    expect(c.routeSeq).toBe(1);
    const p = out.find((o) => o.id === 'pickup-1')!;
    expect(p).toMatchObject({ routeSeq: null, courierIndex: null, courierName: null });
  });

  it('is a no-op-ish passthrough when the route has no stops (everything off-route, order preserved)', () => {
    const out = applyRouteOrder([mk('x'), mk('y')], { routes: [] });
    expect(out.map((o) => o.id)).toEqual(['x', 'y']);
    expect(out.every((o) => o.routeSeq === null)).toBe(true);
  });
});
