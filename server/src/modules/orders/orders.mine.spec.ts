import { toFarmerOrder, type FarmerOrderRow } from './orders.service';

const row = (over: Partial<FarmerOrderRow>): FarmerOrderRow => ({
  day: '2026-07-07',
  id: 'o1',
  orderNumber: 5,
  customerName: 'Мария',
  customerPhone: '0888111222',
  customerEmail: 'maria@example.com',
  status: 'pending',
  deliveryType: 'address',
  paymentMethod: 'cod',
  createdAt: '2026-07-07T08:00:00.000Z',
  slotFrom: null,
  slotTo: null,
  codOutcome: null,
  codOutcomeReason: null,
  shared: false,
  items: [{ productId: 'p1', productName: 'Домати', quantity: 3, priceStotinki: 250 }],
  ...over,
});

describe('toFarmerOrder', () => {
  it('sums the farmer\'s own item lines into subtotalStotinki', () => {
    const o = toFarmerOrder(
      row({
        items: [
          { productId: 'p1', productName: 'Домати', quantity: 3, priceStotinki: 250 },
          { productId: 'p2', productName: 'Краставици', quantity: 2, priceStotinki: 150 },
        ],
      }),
    );
    expect(o.subtotalStotinki).toBe(3 * 250 + 2 * 150);
    expect(o.items).toHaveLength(2);
  });

  it('passes through shared flag, status, and contact fields', () => {
    const o = toFarmerOrder(row({ shared: true, status: 'cancelled', customerPhone: '+359888999000' }));
    expect(o.shared).toBe(true);
    expect(o.status).toBe('cancelled');
    expect(o.customerPhone).toBe('+359888999000');
  });

  it('serialises createdAt Date to ISO and tolerates null', () => {
    const a = toFarmerOrder(row({ createdAt: new Date('2026-07-07T06:30:00.000Z') }));
    expect(a.createdAt).toBe('2026-07-07T06:30:00.000Z');
    const b = toFarmerOrder(row({ createdAt: null }));
    expect(b.createdAt).toBeNull();
  });

  it('passes codOutcome + reason through unchanged', () => {
    const o = toFarmerOrder(row({ codOutcome: 'refused', codOutcomeReason: 'не вдигна' }));
    expect(o.codOutcome).toBe('refused');
    expect(o.codOutcomeReason).toBe('не вдигна');
  });
});

import { and, eq } from 'drizzle-orm';
import { orders, products } from '@fermeribg/db';
import { OrdersService } from './orders.service';

/**
 * Drizzle's `and(...)`/`eq(...)` build a tree of `SQL` nodes whose
 * `queryChunks` mix raw `StringChunk`s, `PgColumn` references, and `Param`
 * wrappers around bound values. Deep-equalling that tree against a
 * hand-built expectation is fragile (it couples the test to drizzle's
 * internal node shapes), and `JSON.stringify` blows up on the circular
 * `PgColumn.table` back-reference. Instead we walk the tree and pull out
 * `{ column, value }` pairs for every `col = param` leaf we find — that's
 * exactly the information needed to prove which columns/values a `.where()`
 * call was scoped by, using the *real* DB column names (`tenant_id`,
 * `farmer_id`) that `orders`/`products` resolve to via `@fermeribg/db`.
 */
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

describe('OrdersService.ordersForFarmer', () => {
  function makeSvc(orderRows: unknown[], itemRows: unknown[]) {
    let selectCall = 0;
    const capturedWhereArgs: unknown[] = [];
    const chain: any = {};
    chain.select = jest.fn(() => {
      selectCall += 1;
      return chain;
    });
    chain.from = jest.fn(() => chain);
    chain.innerJoin = jest.fn(() => chain);
    chain.leftJoin = jest.fn(() => chain);
    chain.where = jest.fn((cond: unknown) => {
      capturedWhereArgs.push(cond);
      return chain;
    });
    chain.groupBy = jest.fn(() => chain);
    chain.orderBy = jest.fn(() => chain);
    // First select() call is the page-of-orders query (chained through
    // .limit()); the second is the farmer's item rows for that page (no
    // .limit() call in that branch — resolves directly off .groupBy()/.where()).
    chain.limit = jest.fn(() => Promise.resolve(selectCall === 1 ? orderRows : itemRows));
    // Some branches await the chain itself (no trailing .limit()); make the
    // chain thenable so `await chain` resolves too.
    chain.then = (resolve: (v: unknown) => void) =>
      resolve(selectCall === 1 ? orderRows : itemRows);
    const svc = new OrdersService(
      chain as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { svc, capturedWhereArgs };
  }

  it('includes pending and cancelled orders (unlike paymentsForFarmer)', async () => {
    const { svc } = makeSvc(
      [
        {
          day: '2026-07-07',
          id: 'o1',
          orderNumber: 1,
          customerName: 'Мария',
          customerPhone: null,
          customerEmail: null,
          status: 'pending',
          deliveryType: 'address',
          paymentMethod: 'cod',
          createdAt: '2026-07-07T08:00:00.000Z',
          slotFrom: null,
          slotTo: null,
          codOutcome: null,
          codOutcomeReason: null,
          shared: false,
          __keysetTs: '2026-07-07T08:00:00.000000',
        },
      ],
      [{ orderId: 'o1', productId: 'p1', productName: 'Домати', quantity: 2, priceStotinki: 300 }],
    );
    const page = await svc.ordersForFarmer('t', 'farmer-1', {});
    expect(page.orders).toHaveLength(1);
    expect(page.orders[0].status).toBe('pending');
    expect(page.orders[0].subtotalStotinki).toBe(600);
  });

  it('marks shared: true and still totals only the farmer\'s own items', async () => {
    const { svc } = makeSvc(
      [
        {
          day: '2026-07-07',
          id: 'o2',
          orderNumber: 2,
          customerName: null,
          customerPhone: null,
          customerEmail: null,
          status: 'confirmed',
          deliveryType: 'pickup',
          paymentMethod: 'cod',
          createdAt: '2026-07-07T09:00:00.000Z',
          slotFrom: null,
          slotTo: null,
          codOutcome: null,
          codOutcomeReason: null,
          shared: true,
          __keysetTs: '2026-07-07T09:00:00.000000',
        },
      ],
      [{ orderId: 'o2', productId: 'p2', productName: 'Краставици', quantity: 1, priceStotinki: 200 }],
    );
    const page = await svc.ordersForFarmer('t', 'farmer-1', {});
    expect(page.orders[0].shared).toBe(true);
    expect(page.orders[0].subtotalStotinki).toBe(200);
  });

  it('returns an empty page with no order rows', async () => {
    const { svc } = makeSvc([], []);
    const page = await svc.ordersForFarmer('t', 'farmer-1', {});
    expect(page.orders).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('scopes the page-of-orders query by BOTH orders.tenantId and products.farmerId', async () => {
    const { svc, capturedWhereArgs } = makeSvc([], []);
    await svc.ordersForFarmer('tenant-A', 'farmer-1', {});

    // The first .where() call belongs to the page-of-orders query (the one
    // built from `conds = [eq(orders.tenantId, ...), eq(products.farmerId, ...)]`).
    const pairs = extractEqPairs(capturedWhereArgs[0]);
    expect(pairs).toEqual(
      expect.arrayContaining([
        { column: 'tenant_id', value: 'tenant-A' },
        { column: 'farmer_id', value: 'farmer-1' },
      ]),
    );

    // Sanity-check the extractor against a condition built the same way the
    // service builds it, so a change to the real column names would fail
    // this test rather than silently passing on a coincidental match.
    const expected = extractEqPairs(and(eq(orders.tenantId, 'tenant-A'), eq(products.farmerId, 'farmer-1')));
    expect(pairs).toEqual(expect.arrayContaining(expected));
  });

  it('parameterizes the farmer scope per-caller — different farmerIds produce different where-conditions', async () => {
    const { svc: svcA, capturedWhereArgs: whereArgsA } = makeSvc([], []);
    await svcA.ordersForFarmer('tenant-A', 'farmer-1', {});
    const pairsA = extractEqPairs(whereArgsA[0]);

    const { svc: svcB, capturedWhereArgs: whereArgsB } = makeSvc([], []);
    await svcB.ordersForFarmer('tenant-A', 'farmer-2', {});
    const pairsB = extractEqPairs(whereArgsB[0]);

    const farmerValueA = pairsA.find((p) => p.column === 'farmer_id')?.value;
    const farmerValueB = pairsB.find((p) => p.column === 'farmer_id')?.value;

    expect(farmerValueA).toBe('farmer-1');
    expect(farmerValueB).toBe('farmer-2');
    expect(farmerValueA).not.toBe(farmerValueB);
  });

  it('groups multiple line items belonging to the same order and sums their subtotal', async () => {
    const { svc } = makeSvc(
      [
        {
          day: '2026-07-07',
          id: 'o3',
          orderNumber: 3,
          customerName: 'Иван',
          customerPhone: null,
          customerEmail: null,
          status: 'confirmed',
          deliveryType: 'address',
          paymentMethod: 'cod',
          createdAt: '2026-07-07T10:00:00.000Z',
          slotFrom: null,
          slotTo: null,
          codOutcome: null,
          codOutcomeReason: null,
          shared: false,
          __keysetTs: '2026-07-07T10:00:00.000000',
        },
      ],
      [
        { orderId: 'o3', productId: 'p1', productName: 'Домати', quantity: 3, priceStotinki: 250 },
        { orderId: 'o3', productId: 'p2', productName: 'Краставици', quantity: 2, priceStotinki: 150 },
      ],
    );
    const page = await svc.ordersForFarmer('t', 'farmer-1', {});
    expect(page.orders).toHaveLength(1);
    expect(page.orders[0].items).toHaveLength(2);
    expect(page.orders[0].items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: 'p1', quantity: 3, priceStotinki: 250 }),
        expect.objectContaining({ productId: 'p2', quantity: 2, priceStotinki: 150 }),
      ]),
    );
    expect(page.orders[0].subtotalStotinki).toBe(3 * 250 + 2 * 150);
  });

  // Finding #2: a basket's own PARENT row always carries farmerId=null (the
  // basket product has no farmer). The `shared` sub-select flags an order as
  // having "another farmer's line" via `farmer_id is distinct from :farmerId`
  // — without excluding the parent row, EVERY basket order would flag as
  // shared no matter who its members belong to, hiding the mark-delivered/
  // cod-outcome buttons for a single-farmer basket (my-orders-client.tsx).
  // Captured directly (the projection's `shared` SQL fragment), since none of
  // the tests above can see it — they only feed canned `shared: true/false`
  // rows in from the mock, never exercising the real expression.
  it("excludes a basket's own parent row from the `shared` sub-select", async () => {
    let sharedExpr: unknown;
    const chain: any = {};
    chain.select = jest.fn((proj: Record<string, unknown>) => {
      if ('shared' in proj) sharedExpr = proj.shared;
      return chain;
    });
    chain.from = jest.fn(() => chain);
    chain.innerJoin = jest.fn(() => chain);
    chain.leftJoin = jest.fn(() => chain);
    chain.where = jest.fn(() => chain);
    chain.groupBy = jest.fn(() => chain);
    chain.orderBy = jest.fn(() => chain);
    chain.limit = jest.fn(() => Promise.resolve([]));
    chain.then = (resolve: (v: unknown) => void) => resolve([]);
    const svc = new OrdersService(
      chain as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
    );

    await svc.ordersForFarmer('t', 'farmer-1', {});

    function literalText(node: unknown): string {
      const n = node as { queryChunks?: unknown[]; value?: unknown } | null;
      if (!n || typeof n !== 'object') return '';
      if (Array.isArray(n.value) && n.value.every((v) => typeof v === 'string')) {
        return (n.value as string[]).join('');
      }
      if (Array.isArray(n.queryChunks)) return n.queryChunks.map(literalText).join('');
      return '';
    }
    const rendered = literalText(sharedExpr);
    expect(rendered).toMatch(/bundle/i);
    expect(rendered).toMatch(/is null/i);
  });
});
